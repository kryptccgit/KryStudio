import { z } from 'zod';
import type { MainDeps } from '../types';
import type { ParamSpec, PluginDescriptor } from '@shared/plugins/types';
import { clampToSpec, formatParam } from '@shared/plugins/types';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { parseNoteName, noteName } from '@shared/music/theory';
import { defineTool, fail, type RunCtx, type ToolCaller } from './types';
import { findSample, sampleUsers } from './sampleRef';
import { agentSamplePath, dbToGain, findChannel, findInsert, findPluginRef, findSlot, fmtDb, fmtPan, plural, parseParamValue, pluginName, safeName } from './util';
import { chooseInstrument } from './instruments';
import { rackInnerRef } from './rackRefs';
import type { InstrumentPreset } from '@shared/sounds/types';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zValue = z.union([z.number(), z.string().max(32), z.boolean()]);

function closest(desc: PluginDescriptor, key: string): string {
  const k = key.toLowerCase();
  const hits = desc.params.filter((s) => s.id.toLowerCase().includes(k) || k.includes(s.id.toLowerCase()) || s.name.toLowerCase().includes(k)).map((s) => s.id);
  return hits.length ? hits.slice(0, 6).join(', ') : desc.params.slice(0, 10).map((s) => s.id).join(', ') + (desc.params.length > 10 ? ', …' : '');
}

function resolveParams(desc: PluginDescriptor, input: Record<string, number | string | boolean>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = desc.params.find((s) => s.id === k) ?? desc.params.find((s) => s.id.toLowerCase() === k.toLowerCase() || s.name.toLowerCase() === k.toLowerCase());
    if (!spec) fail(`${desc.name} has no parameter "${safeName(k, 30)}". Close matches: ${closest(desc, k)}. (describe_plugin lists them all)`);
    out[spec.id] = parseParamValue(spec, v);
  }
  return out;
}

async function addSample(deps: MainDeps, ctx: RunCtx, input: string, caller?: Pick<ToolCaller, 'via'>): Promise<{ sampleId: string; name: string; docPath: string }> {
  const { docPath, abs } = agentSamplePath(deps, input, caller);
  let info: { frames?: number; sampleRate?: number; channels?: number } = {};
  if (abs) {
    const r = await deps.engine.sampleInfo(abs);
    if (r.ok && r.data) info = { frames: r.data.frames, sampleRate: r.data.sampleRate, channels: r.data.channels };
  }
  const r = ctx.exec<{ id: string }>('samples.add', { path: docPath, ...info });
  const s = deps.doc.project.samples[r.id];
  return { sampleId: r.id, name: s?.name ?? docPath, docPath };
}

export const addChannel = defineTool({
  name: 'add_channel',
  title: 'Add a channel',
  kind: 'write',
  description:
    'Add a Channel Rack channel. Omit instrument and params to get a finished sound for the role the name implies and the project genre: Kick / Snare / Hat … → a sampler with the best factory drum sample; 808, Bass, Lead, Pad, Pluck, Keys … → the best instrument preset with its effects (find_presets / load_preset choose a specific one). instrument: a plugin id or alias (synth/krypt.triosc, wave/krypt.wavetable, fm, sampler, 808/krypt.kick808, drumsynth). With params but no instrument you design on the classic name-based default (TriOsc patches, sampler, 808). sample loads a sampler with "factory:drums/snare.wav" or an allowed absolute path. Each channel gets its own mixer insert unless insert is "master" or an existing insert. clone_of duplicates an existing channel instead (instrument, sample, params, routing; with_notes copies its notes in every pattern too). Example: {"name":"Lead","instrument":"synth","params":{"cutoff":"3kHz","ampRelease":"300ms"}}',
  input: z.object({
    name: z.string().min(1).max(64),
    instrument: z.string().max(160).optional(),
    sample: z.string().max(400).optional(),
    params: z.record(z.string(), zValue).optional().describe('Instrument params by id, human units allowed ("1.2kHz", "-6dB", "40%", "Saw").'),
    insert: z.union([z.string(), z.number()]).optional().describe('"new" (default), "master", or an existing insert.'),
    volume_db: z.number().min(-60).max(1.9).optional(),
    pan: z.number().min(-1).max(1).optional(),
    clone_of: z.string().max(120).optional().describe('Duplicate this channel (name or id): same instrument, sample, params and mixer insert, under the new name.'),
    with_notes: z.boolean().default(false).describe('clone_of: also copy its notes in every pattern.'),
    change_label: zLabel,
  }),
  summarize: (a) => `"${safeName(a.name, 40)}"${a.clone_of ? ` (clone of ${safeName(a.clone_of, 20)})` : a.instrument ? ` (${safeName(a.instrument, 20)})` : ''}`,
  paths: (a) => [{ value: a.sample, kind: 'audio' }],
  async run(deps, caller, a, ctx) {
    const catalog = deps.doc.catalog;
    if (a.clone_of !== undefined) {
      if (a.instrument || a.sample || a.params || a.insert !== undefined) fail('clone_of copies the channel as it is: leave out instrument, sample, params and insert (change them afterwards with set_params / set_channel).');
      const src = findChannel(deps.doc.project, a.clone_of);
      const r = ctx.exec<{ id: string }>('channels.clone', { id: src.id, withNotes: a.with_notes });
      ctx.exec('channels.set', {
        id: r.id,
        name: safeName(a.name, 64),
        ...(a.volume_db !== undefined ? { volume: Math.min(1.25, dbToGain(a.volume_db)) } : {}),
        ...(a.pan !== undefined ? { pan: a.pan } : {}),
      });
      const p = deps.doc.project;
      const notes = a.with_notes ? Object.values(p.patterns).reduce((n, pat) => n + Object.keys(pat.notes[r.id] ?? {}).length, 0) : 0;
      const ins = p.mixer.inserts[p.channels[r.id].insertId];
      return {
        ok: true,
        message: `Added channel "${safeName(a.name)}" (${r.id}): a copy of "${safeName(src.name)}" (${pluginName(catalog, src.generator.type)})${a.with_notes ? ` with its ${plural(notes, 'note')}` : ', no notes'} → ${ins?.isMaster ? 'Master' : `insert "${safeName(ins?.name)}" (shared with the original)`}.`,
        changed: [],
        data: { id: r.id, insertId: p.channels[r.id].insertId },
      };
    }
    let type: string;
    let params: Record<string, number> | undefined;
    let label: string;
    let sample = a.sample;
    let preset: InstrumentPreset | undefined;
    if (a.instrument && (a.params || a.sample)) {
      const d = findPluginRef(catalog, a.instrument, 'instrument');
      type = d.id;
      label = d.name;
    } else if (a.sample) {
      type = 'krypt.sampler';
      label = 'Krypt Sampler';
    } else {
      const c = chooseInstrument(deps, a.name, a.instrument, false, !a.params);
      type = c.type;
      params = c.params;
      label = c.label;
      sample = c.preset ? undefined : c.sample;
      preset = c.preset;
    }
    const desc = findPluginRef(catalog, type, 'instrument');
    if (a.params) params = { ...(params ?? {}), ...resolveParams(desc, a.params) };
    let sampleId: string | undefined;
    if (sample) {
      if (!desc.usesSample) fail(`${desc.name} doesn't play samples; use instrument "sampler" with sample.`);
      sampleId = (await addSample(deps, ctx, sample, caller)).sampleId;
    }
    let insertId: string | undefined;
    if (a.insert !== undefined && a.insert !== 'new') insertId = a.insert === 'master' ? 'master' : findInsert(deps.doc.project, a.insert).id;
    const r = ctx.exec<{ id: string; insertId: string }>('channels.add', { type, name: safeName(a.name, 64), sampleId, params, insertId });
    let fxNote = '';
    if (preset) {
      ctx.exec('presets.applyToChannel', { channelId: r.id, preset, withFx: insertId === undefined });
      if (preset.fx?.length) fxNote = insertId === undefined ? ` with ${plural(preset.fx.length, 'effect')}` : ` (its ${plural(preset.fx.length, 'effect')} not loaded onto the shared insert; load_preset with_fx on an own insert adds them)`;
    }
    if (a.volume_db !== undefined || a.pan !== undefined) {
      ctx.exec('channels.set', { id: r.id, volume: a.volume_db !== undefined ? Math.min(1.25, dbToGain(a.volume_db)) : undefined, pan: a.pan });
    }
    const ins = deps.doc.project.mixer.inserts[r.insertId];
    return {
      ok: true,
      message: `Added channel "${safeName(a.name)}" (${r.id}) → ${preset ? `${label} (${preset.id}; ${pluginName(catalog, preset.plugin).replace(/^Krypt /, '')})${fxNote}` : `${label}${sampleId ? ` with ${safeName(deps.doc.project.samples[sampleId].name)}` : ''}`} → ${ins?.isMaster ? 'Master' : `insert "${safeName(ins?.name)}" (${r.insertId})`}.`,
      changed: [],
      data: { id: r.id, insertId: r.insertId },
    };
  },
});

export const setChannel = defineTool({
  name: 'set_channel',
  title: 'Edit channel settings',
  kind: 'write',
  description:
    'Change a channel: name, volume_db, pan (-1 left .. 1 right), pitch (semitones), mute, solo (FL-style exclusive solo toggle), root_key (sampler root note), mono + glide_ms (808 slides), cut_group / cut_by (open/closed hat choke), color, insert (route to a mixer insert). Example: {"channel":"808","mono":true,"glide_ms":80,"volume_db":-3}',
  input: z.object({
    channel: z.string(),
    name: z.string().min(1).max(64).optional(),
    volume_db: z.number().min(-80).max(1.9).optional(),
    pan: z.number().min(-1).max(1).optional(),
    pitch: z.number().min(-24).max(24).optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional(),
    root_key: z.union([z.string().max(5), z.number().int().min(0).max(127)]).optional(),
    mono: z.boolean().optional(),
    glide_ms: z.number().min(0).max(5000).optional(),
    cut_group: z.number().int().min(0).max(64).optional(),
    cut_by: z.number().int().min(0).max(64).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    insert: z.union([z.string(), z.number()]).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => safeName(a.channel, 40),
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ch = findChannel(p, a.channel);
    let rootKey: number | undefined;
    if (a.root_key !== undefined) {
      const k = typeof a.root_key === 'number' ? a.root_key : parseNoteName(a.root_key);
      if (k === null) fail(`root_key "${safeName(String(a.root_key), 8)}" must be a note like C4 or a MIDI number`);
      rootKey = k;
    }
    const poly: Record<string, unknown> = {};
    if (a.mono !== undefined) poly.mono = a.mono;
    if (a.glide_ms !== undefined) poly.glideMs = a.glide_ms;
    if (a.cut_group !== undefined) poly.cutGroup = a.cut_group;
    if (a.cut_by !== undefined) poly.cutBy = a.cut_by;
    const args: Record<string, unknown> = {
      id: ch.id,
      name: a.name ? safeName(a.name, 64) : undefined,
      volume: a.volume_db !== undefined ? Math.min(1.25, dbToGain(a.volume_db)) : undefined,
      pan: a.pan,
      pitch: a.pitch,
      mute: a.mute,
      rootKey,
      color: a.color,
      insertId: a.insert !== undefined ? findInsert(p, a.insert).id : undefined,
      poly: Object.keys(poly).length ? poly : undefined,
    };
    ctx.exec('channels.set', args);
    if (a.solo !== undefined) {
      const others = p.channelOrder.filter((c) => c !== ch.id);
      const isSolo = !deps.doc.project.channels[ch.id].mute && others.every((c) => deps.doc.project.channels[c].mute);
      if (a.solo !== isSolo) ctx.exec('channels.solo', { id: ch.id });
    }
    const now = deps.doc.project.channels[ch.id];
    const ins = deps.doc.project.mixer.inserts[now.insertId];
    return {
      ok: true,
      message: `${safeName(now.name)} (${ch.id}): vol ${fmtDb(now.volume)}, pan ${fmtPan(now.pan)}, pitch ${now.pitch} st${now.mute ? ', muted' : ''}, root ${noteName(now.rootKey)}${now.poly.mono ? `, mono glide ${now.poly.glideMs} ms` : ''}${now.poly.cutGroup || now.poly.cutBy ? `, cut ${now.poly.cutGroup}/${now.poly.cutBy}` : ''} → ${ins?.isMaster ? 'Master' : safeName(ins?.name)}.`,
      changed: [],
    };
  },
});

export const setInstrument = defineTool({
  name: 'set_instrument',
  title: 'Replace a channel instrument',
  kind: 'write',
  description: 'Swap the instrument (generator plugin) of a channel. Its parameters reset to defaults, then `params` are applied; a sampler keeps its sample. Notes, mixer routing and volume stay. Example: {"channel":"Keys","instrument":"krypt.triosc","params":{"osc1Shape":"Square","cutoff":"2kHz"}}',
  input: z.object({ channel: z.string(), instrument: z.string().max(160), params: z.record(z.string(), zValue).optional(), change_label: zLabel }),
  summarize: (a) => `${safeName(a.channel, 30)} → ${safeName(a.instrument, 20)}`,
  run(deps, _c, a, ctx) {
    const ch = findChannel(deps.doc.project, a.channel);
    const desc = findPluginRef(deps.doc.catalog, a.instrument, 'instrument');
    const params = a.params ? resolveParams(desc, a.params) : undefined;
    ctx.exec('channels.setGenerator', { id: ch.id, type: desc.id, params });
    return { ok: true, message: `${safeName(ch.name)} now plays ${desc.name} (${desc.id})${params ? ` with ${plural(Object.keys(params).length, 'param')}` : ''}.`, changed: [] };
  },
});

interface Applied {
  ref: string;
  name: string;
  before: string;
  after: string;
}

export const setParams = defineTool({
  name: 'set_params',
  title: 'Set plugin / mixer parameters',
  kind: 'write',
  description:
    'Set many parameters in one call, in human units ("1.2kHz", "-6dB", "40%", "250ms", option labels like "Saw"). Three forms: {"channel":"Bass","params":{"cutoff":"800Hz","reso":0.3}} for an instrument; {"insert":"Master","effect":"limiter","params":{"ceiling":"-1dB"}} for an effect (also "mix"); or {"params":{"insert/ins_x/volume":0.8, "channel/ch_y/gen/cutoff":"2kHz"}} with ParamRefs. Knobs inside a rack: add "chain" (name or number) and for an effect "device", e.g. {"channel":"Keys","chain":"Piano","params":{"cutoff":"2kHz","volume":"-3dB"}}, {"insert":"Master","effect":"FX Rack","chain":1,"device":"delay","params":{"mix":"30%"}}. Returns before → after with display values (values are clamped to the parameter range).',
  input: z.object({
    channel: z.string().optional(),
    insert: z.union([z.string(), z.number()]).optional(),
    effect: z.union([z.string(), z.number()]).optional(),
    chain: z.union([z.string().max(64), z.number().int().min(1)]).optional().describe('A chain inside the rack on that channel / effect slot (name or number): params then address its knobs.'),
    device: z.union([z.string().max(64), z.number().int().min(1)]).optional().describe('With chain: an effect in that chain (name, plugin id or number); without it, params are the chain instrument\'s (plus volume / pan).'),
    params: z.record(z.string(), zValue).refine((r) => Object.keys(r).length > 0, 'params must not be empty'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel ?? String(a.insert ?? 'refs'), 30)}: ${Object.keys(a.params).slice(0, 4).join(', ')}`,
  run(deps, _c, a, ctx) {
    const catalog = deps.doc.catalog;
    const p = deps.doc.project;
    const refs: Array<{ ref: string; spec: ParamSpec; value: number }> = [];
    if (a.chain !== undefined && (a.channel !== undefined || (a.insert !== undefined && a.effect !== undefined))) {
      let host: Parameters<typeof rackInnerRef>[2];
      let where: string;
      if (a.channel !== undefined) {
        const ch = findChannel(p, a.channel);
        host = { kind: 'channel', channelId: ch.id };
        where = `"${safeName(ch.name)}"`;
      } else {
        const ins = findInsert(p, a.insert!);
        const sid = findSlot(ins, a.effect!, catalog);
        host = { kind: 'slot', insertId: ins.id, slotId: sid };
        where = `That ${ins.isMaster ? 'master' : 'insert'} effect`;
      }
      for (const [k, v] of Object.entries(a.params)) {
        const r = rackInnerRef(p, catalog, host, where, a.chain, a.device, k);
        refs.push({ ref: r.ref, spec: r.spec, value: parseParamValue(r.spec, v) });
      }
    } else if (a.chain !== undefined || a.device !== undefined) {
      fail('chain / device address a knob inside a rack: pass them with "channel" (instrument / drum rack) or "insert" + "effect" (effect rack).');
    } else if (a.channel !== undefined) {
      const ch = findChannel(p, a.channel);
      const desc = findPluginRef(catalog, ch.generator.type);
      for (const [k, v] of Object.entries(resolveParams(desc, a.params))) refs.push({ ref: `channel/${ch.id}/gen/${k}`, spec: desc.params.find((s) => s.id === k)!, value: v });
    } else if (a.insert !== undefined) {
      const ins = findInsert(p, a.insert);
      if (a.effect === undefined) {
        for (const [k, v] of Object.entries(a.params)) {
          const ref = `insert/${ins.id}/${k}`;
          const spec = paramSpecFor(p, catalog, ref);
          if (!spec) fail(`Insert parameter "${safeName(k, 20)}" doesn't exist (volume, pan, stereoSep), or pass effect to target a plugin.`);
          refs.push({ ref, spec, value: parseParamValue(spec, v) });
        }
      } else {
        const sid = findSlot(ins, a.effect, catalog);
        const desc = findPluginRef(catalog, ins.slots[sid].type);
        const { mix, ...rest } = a.params;
        if (mix !== undefined) {
          const ref = `insert/${ins.id}/slot/${sid}/mix`;
          const spec = paramSpecFor(p, catalog, ref)!;
          refs.push({ ref, spec, value: parseParamValue(spec, mix) });
        }
        for (const [k, v] of Object.entries(resolveParams(desc, rest))) refs.push({ ref: `insert/${ins.id}/slot/${sid}/${k}`, spec: desc.params.find((s) => s.id === k)!, value: v });
      }
    } else {
      for (const [ref, v] of Object.entries(a.params)) {
        const spec = paramSpecFor(p, catalog, ref);
        if (!spec) fail(`"${safeName(ref, 80)}" is not a valid ParamRef (e.g. channel/<id>/gen/cutoff, insert/<id>/volume, insert/<id>/slot/<slotId>/threshold, transport/bpm, channel/<id>/rack/<chainId>/inst/cutoff). Or pass channel / insert+effect (+ chain, device) with plain param ids.`);
        refs.push({ ref, spec, value: parseParamValue(spec, v) });
      }
    }
    const applied: Applied[] = [];
    const before = refs.map((r) => getParamValue(deps.doc.project, catalog, r.ref));
    ctx.execBatch(refs.map((r) => ({ cmd: 'params.set', args: { ref: r.ref, value: r.value } })));
    refs.forEach((r, i) => {
      const after = getParamValue(deps.doc.project, catalog, r.ref) ?? r.value;
      const clamped = clampToSpec(r.spec, r.value) !== r.value;
      applied.push({
        ref: r.ref,
        name: r.spec.id,
        before: before[i] === null ? '?' : formatParam(r.spec, before[i]!),
        after: formatParam(r.spec, after) + (clamped ? ' (clamped)' : ''),
      });
    });
    const changedCount = applied.filter((x) => x.before !== x.after.replace(' (clamped)', '')).length;
    return {
      ok: true,
      message: `Set ${plural(applied.length, 'parameter')} (${changedCount} changed): ${applied.map((x) => `${x.name} ${x.before} → ${x.after}`).join(', ')}.`,
      changed: [],
      data: { applied },
    };
  },
});

export const loadSample = defineTool({
  name: 'load_sample',
  title: 'Load a sample',
  kind: 'write',
  description:
    'Load an audio file into a sampler channel (existing `channel`, or a new sampler channel when channel is omitted). sample: "factory:drums/kick.wav" (factory kit: kick, snare, clap, hat-closed, hat-open), "pack:<pack>/…" (a sample of an installed sound pack) or an absolute path — find_samples lists the factory library, installed packs\' samples and the files in the user\'s Browser folders. Any local audio file works (when the user set File access to "Ask me", files outside those folders are asked about first and the call waits); network/UNC paths are refused. relink: point an existing pool sample (a missing / moved file; id, name, file name or old path) at `sample` instead: every channel playing it follows, nothing else changes.',
  input: z.object({
    sample: z.string().min(1).max(400),
    relink: z.string().min(1).max(400).optional().describe('An existing pool sample to repoint at `sample` (relink a missing file) instead of loading it into a channel.'),
    channel: z.string().optional().describe('Existing sampler channel to load into. Omit to create a new channel.'),
    name: z.string().max(64).optional().describe('Name for a new channel (default: the sample name).'),
    root_key: z.union([z.string().max(5), z.number().int().min(0).max(127)]).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.relink ? `relink ${safeName(a.relink.split(/[\\/:]/).pop() ?? a.relink, 30)} → ` : ''}${safeName(a.sample.split(/[\\/:]/).pop() ?? a.sample, 40)}${a.channel ? ` → ${safeName(a.channel, 30)}` : ''}`,
  paths: (a) => [{ value: a.sample, kind: 'audio' }],
  async run(deps, caller, a, ctx) {
    if (a.relink !== undefined) {
      if (a.channel || a.name || a.root_key !== undefined) fail('relink repoints a pool sample: leave out channel, name and root_key.');
      const s = findSample(deps.doc.project, a.relink);
      const { docPath, abs } = agentSamplePath(deps, a.sample, caller);
      if (s.path === docPath) fail(`No change: "${safeName(s.name)}" already points at ${safeName(docPath, 200)}.`);
      let info: { frames?: number; sampleRate?: number; channels?: number } = {};
      if (abs) {
        const r = await deps.engine.sampleInfo(abs);
        if (!r.ok || !r.data) fail(`Can't read ${safeName(abs, 200)}: ${r.message ?? 'not a playable audio file'}`);
        info = { frames: r.data.frames, sampleRate: r.data.sampleRate, channels: r.data.channels };
      }
      const old = s.path;
      ctx.exec('samples.relink', { id: s.id, path: docPath, ...info });
      const users = sampleUsers(deps.doc.project, s.id);
      return {
        ok: true,
        message: `Relinked "${safeName(s.name)}" (${s.id}) from ${safeName(old, 200)} to ${safeName(docPath, 200)}${users.length ? `; ${users.join(', ')} play${users.length === 1 ? 's' : ''} the new file` : ' (no channel plays it right now)'}.`,
        changed: [],
        data: { id: s.id, path: docPath },
      };
    }
    let rootKey: number | undefined;
    if (a.root_key !== undefined) {
      const k = typeof a.root_key === 'number' ? a.root_key : parseNoteName(a.root_key);
      if (k === null) fail('root_key must be a note like C4 or a MIDI number');
      rootKey = k;
    }
    if (a.channel) {
      const ch = findChannel(deps.doc.project, a.channel);
      const desc = deps.doc.catalog.plugins.find((x) => x.id === ch.generator.type);
      if (desc && !desc.usesSample) fail(`${safeName(ch.name)} plays ${desc.name}, which has no sample. Call set_instrument {instrument:"sampler"} first, or omit channel to create a new sampler channel.`);
      const s = await addSample(deps, ctx, a.sample, caller);
      ctx.exec('channels.setSample', { id: ch.id, sampleId: s.sampleId });
      if (rootKey !== undefined) ctx.exec('channels.set', { id: ch.id, rootKey });
      return { ok: true, message: `Loaded ${safeName(s.name)} (${safeName(s.docPath, 200)}) into ${safeName(ch.name)} (${ch.id}).`, changed: [] };
    }
    const s = await addSample(deps, ctx, a.sample, caller);
    const name = safeName(a.name ?? s.name, 64);
    const r = ctx.exec<{ id: string }>('channels.add', { type: 'krypt.sampler', name, sampleId: s.sampleId });
    if (rootKey !== undefined) ctx.exec('channels.set', { id: r.id, rootKey });
    return { ok: true, message: `Created sampler channel "${name}" (${r.id}) with ${safeName(s.docPath, 200)}.`, changed: [], data: { id: r.id } };
  },
});

export const SOUND_TOOLS = [addChannel, setChannel, setInstrument, setParams, loadSample];
