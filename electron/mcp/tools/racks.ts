import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Project } from '@shared/schema/project';
import type { ParamSpec, PluginDescriptor } from '@shared/plugins/types';
import { findPlugin } from '@shared/schema/params';
import { DRUM_RACK_BASE_NOTE, MACRO_COUNT, MACRO_PARAM_IDS, isRackPlugin, type MacroTarget, type RackDef, type RackKind } from '@shared/schema/rack';
import { RACK_PLUGIN_FOR, midiNoteName, rackKindOf } from '@shared/commands/racks';
import { parseNoteName } from '@shared/music/theory';
import { rankPresets } from '@shared/sounds/select';
import type { InstrumentPreset, PresetFx, PresetMacroMap, PresetRack, PresetRackChain } from '@shared/sounds/types';
import { defineTool, fail, type RunCtx, type ToolCaller, type ToolResult } from './types';
import { agentSamplePath, dbToGain, findChannel, findInsert, findPluginRef, findSlot, fmtDb, parseParamValue, plural, pluginName, safeName } from './util';
import { pickChain, pickDevice, type RackPick } from './rackRefs';
import { soundLibrary } from './instruments';
import { sliceToPads } from '../../racks/slice';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zValue = z.union([z.number(), z.string().max(32), z.boolean()]);
const zParamsIn = z.record(z.string(), zValue);

const short = (deps: MainDeps, id: string): string => pluginName(deps.doc.catalog, id).replace(/^Krypt /, '');

interface FoundRack {
  target: { channelId: string } | { insertId: string; slotId: string };
  rack: RackDef;
  params: Record<string, number>;
  type: string;
  label: string;
  refPrefix: string;
}

function racksIn(p: Project): FoundRack[] {
  const out: FoundRack[] = [];
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    const k = ch && rackKindOf(ch.generator.type);
    if (ch && k && k !== 'effect') out.push({ target: { channelId: id }, rack: ch.generator.rack ?? emptyLike(k), params: ch.generator.params, type: ch.generator.type, label: `"${ch.name}"`, refPrefix: `channel/${id}/gen/` });
  }
  for (const insId of p.mixer.insertOrder) {
    const ins = p.mixer.inserts[insId];
    for (const sid of ins?.slotOrder ?? []) {
      const s = ins.slots[sid];
      if (s?.type === RACK_PLUGIN_FOR.effect) out.push({ target: { insertId: insId, slotId: sid }, rack: s.rack ?? emptyLike('effect'), params: s.params, type: s.type, label: `${ins.isMaster ? 'Master' : `"${ins.name}"`} slot ${ins.slotOrder.indexOf(sid) + 1}`, refPrefix: `insert/${insId}/slot/${sid}/` });
    }
  }
  return out;
}

function emptyLike(kind: RackKind): RackDef {
  return { kind, chains: {}, chainOrder: [], macros: Array.from({ length: MACRO_COUNT }, (_, i) => ({ name: `Macro ${i + 1}`, maps: {} })), variations: {}, variationOrder: [] };
}

const FINAL_STAGE = new Set(['krypt.limiter', 'krypt.clipper']);

function findRack(deps: MainDeps, a: { channel?: string; insert?: string | number; slot?: string | number }): FoundRack {
  const p = deps.doc.project;
  const all = racksIn(p);
  if (a.channel) {
    const ch = findChannel(p, a.channel);
    const hit = all.find((r) => 'channelId' in r.target && r.target.channelId === ch.id);
    if (!hit) fail(`"${safeName(ch.name)}" plays ${short(deps, ch.generator.type)}, not a rack. Build one with build_rack {"channel":"${safeName(ch.name)}", …}.`);
    return hit;
  }
  if (a.insert !== undefined) {
    const ins = findInsert(p, a.insert);
    const slotId = a.slot !== undefined ? findSlot(ins, a.slot, deps.doc.catalog) : ins.slotOrder.find((s) => ins.slots[s].type === RACK_PLUGIN_FOR.effect);
    const hit = all.find((r) => 'slotId' in r.target && r.target.slotId === slotId);
    if (!hit) fail(`${ins.isMaster ? 'The master' : `"${safeName(ins.name)}"`} has no effect rack${a.slot !== undefined ? ' in that slot' : ''}.`);
    return hit;
  }
  if (all.length === 1) return all[0];
  if (!all.length) fail('The project has no racks yet. Build one with build_rack.');
  fail(`Which rack? Pass channel or insert (+ slot). Racks: ${all.map((r) => r.label).slice(0, 12).join(', ')}.`);
}

function macroIndex(rack: RackDef, ref: string | number): number {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const n = Number(ref);
    if (n < 1 || n > MACRO_COUNT) fail(`Macros are numbered 1..${MACRO_COUNT}`);
    return n - 1;
  }
  const k = String(ref).trim().toLowerCase();
  const i = rack.macros.findIndex((m) => m.name.toLowerCase() === k);
  if (i >= 0) return i;
  const m = /^macro\s*(\d)$/.exec(k);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= MACRO_COUNT) return Number(m[1]) - 1;
  fail(`No macro "${safeName(String(ref), 32)}". Macros: ${rack.macros.map((x, j) => `${j + 1} ${safeName(x.name, 32)}`).join(', ')}.`);
}

function macroLine(rack: RackDef, params: Record<string, number>): string {
  return rack.macros
    .map((m, i) => ({ m, i, n: Object.keys(m.maps).length }))
    .filter((x) => x.n || x.m.name !== `Macro ${x.i + 1}`)
    .map((x) => `${x.i + 1} ${safeName(x.m.name, 32)} = ${Math.round((params[MACRO_PARAM_IDS[x.i]] ?? 0) * 100)}% (${plural(x.n, 'target')})`)
    .join('; ');
}

const zDevice = z.object({
  effect: z.string().min(1).max(80).describe('Stock effect id or alias: eq, comp, reverb, delay, drive, filter, chorus, …'),
  params: zParamsIn.optional(),
  mix: z.number().min(0).max(1).optional(),
});

const zChain = z.object({
  name: z.string().max(64).optional(),
  preset: z.string().max(120).optional().describe('An instrument preset (id or exact name): its instrument, params and sample; its effects become the chain devices.'),
  instrument: z.string().max(80).optional().describe('Or a stock instrument id / alias (synth, wavetable, fm, sampler, 808, drumsynth).'),
  params: zParamsIn.optional().describe('Instrument params (human units ok: "2kHz", "-6dB").'),
  sample: z.string().max(400).optional().describe('Sampler sample: "factory:drums/snare.wav" or an allowed audio path (implies instrument sampler).'),
  note: z.union([z.string().max(5), z.number().int().min(0).max(127)]).optional().describe('Drum racks: the pad note ("C2" = 36, the first pad). Default: the next free pad.'),
  keys: z.string().max(12).optional().describe('Instrument racks: key zone "C3-B4" (inclusive). Default: every key.'),
  velocity: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional().describe('Velocity zone [lo, hi] 0..1.'),
  choke: z.number().int().min(0).max(32).optional().describe('Drum racks: pads in the same choke group > 0 cut each other (open / closed hats).'),
  volume_db: z.number().min(-60).max(6).optional(),
  pan: z.number().min(-1).max(1).optional(),
  devices: z.array(zDevice).max(10).optional(),
});

const zMap = z.object({
  chain: z.union([z.number().int().min(1), z.string().max(64)]).describe('Chain number (1-based) or name.'),
  device: z.union([z.number().int().min(1), z.string().max(80)]).optional().describe('Device number in that chain (1-based) or effect name; omit for the instrument (or the chain volume / pan).'),
  param: z.string().min(1).max(64).describe("Param id or name; 'mix' on a device; 'volume' / 'pan' without a device = the chain's."),
  min: z.number().min(0).max(1).optional().describe('Normalized 0..1 start of the sweep (default 0); min > max inverts.'),
  max: z.number().min(0).max(1).optional(),
});

function resolveParams(desc: PluginDescriptor, input: Record<string, number | string | boolean> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const spec = desc.params.find((s) => s.id === k) ?? desc.params.find((s) => s.id.toLowerCase() === k.toLowerCase() || s.name.toLowerCase() === k.toLowerCase());
    if (!spec) fail(`${desc.name} has no parameter "${safeName(k, 30)}" (describe_plugin lists them)`);
    out[spec.id] = parseParamValue(spec, v);
  }
  return out;
}

function findParam(desc: PluginDescriptor, k: string): ParamSpec {
  const spec = desc.params.find((s) => s.id === k) ?? desc.params.find((s) => s.id.toLowerCase() === k.toLowerCase() || s.name.toLowerCase() === k.toLowerCase());
  if (!spec) fail(`${desc.name} has no parameter "${safeName(k, 30)}" (describe_plugin lists them)`);
  return spec;
}

function parseKeys(s: string): [number, number] {
  const m = /^\s*([A-Ga-g][#b]?-?\d+|\d+)\s*(?:-|–|\.\.|to)\s*([A-Ga-g][#b]?-?\d+|\d+)\s*$/.exec(s);
  const k = (x: string): number | null => (/^\d+$/.test(x) ? Number(x) : parseNoteName(x));
  const lo = m ? k(m[1]) : null;
  const hi = m ? k(m[2]) : null;
  if (lo === null || hi === null || lo > 127 || hi > 127) fail(`keys "${safeName(s, 12)}" must look like "C3-B4" (C4 = 60) or "48-71"`);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function parseNote(v: string | number): number {
  if (typeof v === 'number') return v;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : parseNoteName(v);
  if (n === null || n > 127) fail(`note "${safeName(String(v), 6)}" must be a note name like "C2" (C4 = 60) or 0..127`);
  return n;
}

function findPresetFor(deps: MainDeps, ref: string): InstrumentPreset {
  const all = soundLibrary(deps).presets.filter((p): p is InstrumentPreset => p.kind === 'instrument');
  const q = ref.trim();
  const hit = all.find((p) => p.id === q) ?? all.find((p) => p.name.toLowerCase() === q.toLowerCase()) ?? (/^(factory|user):/i.test(q) ? undefined : rankPresets(all.filter((p) => !isRackPlugin(p.plugin)), { text: q, kind: 'instrument' }, 1)[0]);
  if (!hit) fail(`No instrument preset "${safeName(q, 60)}" (find_presets lists them)`);
  if (isRackPlugin(hit.plugin)) fail(`"${safeName(hit.name)}" is itself a rack; racks can't hold racks. Load it with load_preset instead.`);
  return hit;
}

interface BuiltChain {
  spec: PresetRackChain;
  label: string;
}

function buildChain(deps: MainDeps, caller: ToolCaller, kind: RackKind, c: z.infer<typeof zChain>, i: number, used: Set<number>, warnings: string[]): BuiltChain {
  const catalog = deps.doc.catalog;
  const where = `chain ${i + 1}${c.name ? ` ("${safeName(c.name, 40)}")` : ''}`;
  const out: PresetRackChain = { name: '' };
  let instName = '';
  if (kind === 'effect' && (c.preset || c.instrument || c.sample)) fail(`${where}: an effect rack's chains hold effects only (devices), no instruments.`);
  if (c.preset) {
    const pr = findPresetFor(deps, c.preset);
    out.instrument = { plugin: pr.plugin, params: { ...pr.params }, ...(pr.sample ? { sample: pr.sample } : {}) };
    if (pr.fx?.length) out.fx = pr.fx.slice(0, 10).map((f): PresetFx => ({ type: f.type, params: { ...f.params }, ...(f.mix !== undefined ? { mix: f.mix } : {}), ...(f.enabled === false ? { enabled: false } : {}) }));
    instName = pr.name;
    if (c.params) Object.assign(out.instrument.params, resolveParams(findPluginRef(catalog, pr.plugin, 'instrument'), c.params));
  } else if (c.instrument || c.sample || c.params) {
    const desc = findPluginRef(catalog, c.instrument ?? (c.sample ? 'sampler' : 'synth'), 'instrument');
    if (isRackPlugin(desc.id)) fail(`${where}: racks can't hold racks.`);
    out.instrument = { plugin: desc.id, params: resolveParams(desc, c.params) };
    instName = desc.name.replace(/^Krypt /, '');
  } else if (kind !== 'effect') {
    warnings.push(`${where} has no instrument, so it stays silent until you give it one.`);
  }
  if (c.sample) {
    if (!out.instrument) fail(`${where}: a sample needs an instrument (sampler).`);
    const desc = findPlugin(catalog, out.instrument.plugin);
    if (!desc?.usesSample) fail(`${where}: ${desc?.name ?? out.instrument.plugin} doesn't play samples; use instrument "sampler".`);
    out.instrument.sample = agentSamplePath(deps, c.sample, caller).docPath;
    if (!instName || c.instrument === undefined) instName = safeName(c.sample.split(/[\\/:]/).pop()?.replace(/\.[a-z0-9]+$/i, ''), 40);
    if (kind === 'drum' && out.instrument.plugin === 'krypt.sampler') out.instrument.params = { keyTrack: 0, oneShot: 1, ...out.instrument.params };
  }
  if (c.devices?.length) {
    out.fx = [...(out.fx ?? [])];
    for (const dv of c.devices) {
      const desc = findPluginRef(catalog, dv.effect, 'effect');
      if (isRackPlugin(desc.id)) fail(`${where}: racks can't hold racks.`);
      out.fx.push({ type: desc.id, params: resolveParams(desc, dv.params), ...(dv.mix !== undefined ? { mix: dv.mix } : {}) });
    }
    if (out.fx.length > 10) fail(`${where} has ${out.fx.length} devices (its preset's effects + yours); a chain holds at most 10.`);
  }
  if (kind === 'drum') {
    if (c.keys) fail(`${where}: keys zones are for instrument racks; a drum pad takes a note ("D2").`);
    let note = c.note !== undefined ? parseNote(c.note) : -1;
    if (note < 0) {
      note = DRUM_RACK_BASE_NOTE;
      while (used.has(note) && note < 127) note++;
    }
    if (used.has(note)) fail(`${where}: pad ${midiNoteName(note)} is used twice.`);
    used.add(note);
    out.zone = { keyLo: note, keyHi: note, velLo: c.velocity?.[0] ?? 0, velHi: c.velocity?.[1] ?? 1 };
    if (c.choke) out.choke = c.choke;
  } else if (kind === 'instrument') {
    if (c.note !== undefined) fail(`${where}: note is for drum-rack pads; use keys "C3-B4" for an instrument rack.`);
    if (c.choke) fail(`${where}: choke groups are for drum-rack pads.`);
    if (c.keys || c.velocity) {
      const [lo, hi] = c.keys ? parseKeys(c.keys) : [0, 127];
      out.zone = { keyLo: lo, keyHi: hi, velLo: Math.min(c.velocity?.[0] ?? 0, c.velocity?.[1] ?? 1), velHi: Math.max(c.velocity?.[0] ?? 0, c.velocity?.[1] ?? 1) };
    }
  } else if (c.keys || c.velocity || c.note !== undefined || c.choke) fail(`${where}: an effect rack's chains all get the whole input (no notes, zones or chokes).`);
  if (c.volume_db !== undefined) out.volume = Math.min(2, dbToGain(c.volume_db));
  if (c.pan !== undefined) out.pan = c.pan;
  out.name = (safeName(c.name, 64) || instName || (out.zone && kind === 'drum' ? `Pad ${midiNoteName(out.zone.keyLo)}` : `Chain ${i + 1}`)).slice(0, 64);
  const zone = out.zone ? (kind === 'drum' ? ` @ ${midiNoteName(out.zone.keyLo)}` : ` ${midiNoteName(out.zone.keyLo)}-${midiNoteName(out.zone.keyHi)}${out.zone.velLo > 0 || out.zone.velHi < 1 ? ` vel ${out.zone.velLo}-${out.zone.velHi}` : ''}`) : '';
  const devs = out.fx?.length ? ` → ${out.fx.map((f) => short(deps, f.type)).join(' → ')}` : '';
  return { spec: out, label: `${out.name}${zone}${out.instrument ? ` (${instName || short(deps, out.instrument.plugin)})` : ''}${devs}${out.choke ? ` choke ${out.choke}` : ''}` };
}

function mapFor(deps: MainDeps, chains: PresetRackChain[], m: z.infer<typeof zMap>, mi: number): PresetMacroMap {
  const catalog = deps.doc.catalog;
  const ci = typeof m.chain === 'number' || /^\d+$/.test(String(m.chain)) ? Number(m.chain) - 1 : chains.findIndex((c) => c.name.toLowerCase() === String(m.chain).toLowerCase());
  const chain = chains[ci];
  if (!chain) fail(`macro ${mi + 1}: no chain "${safeName(String(m.chain), 40)}" (chains: ${chains.map((c, i) => `${i + 1} ${c.name}`).join(', ')})`);
  const range = { ...(m.min !== undefined ? { min: m.min } : {}), ...(m.max !== undefined ? { max: m.max } : {}) };
  if (m.device !== undefined) {
    const fx = chain.fx ?? [];
    let di: number;
    if (typeof m.device === 'number' || /^\d+$/.test(String(m.device))) di = Number(m.device) - 1;
    else {
      const t = findPluginRef(catalog, String(m.device), 'effect').id;
      di = fx.findIndex((f) => f.type === t);
    }
    const f = fx[di];
    if (!f) fail(`macro ${mi + 1}: chain "${chain.name}" has no device ${safeName(String(m.device), 30)}`);
    const param = m.param.toLowerCase() === 'mix' ? 'mix' : findParam(findPluginRef(catalog, f.type, 'effect'), m.param).id;
    return { chain: ci, target: 'device', device: di, param, ...range };
  }
  if (/^(volume|vol|level|pan)$/i.test(m.param)) return { chain: ci, target: 'chain', param: /^pan$/i.test(m.param) ? 'pan' : 'volume', ...range };
  if (!chain.instrument) fail(`macro ${mi + 1}: chain "${chain.name}" has no instrument; name a device, or map 'volume' / 'pan'.`);
  return { chain: ci, target: 'instrument', param: findParam(findPluginRef(catalog, chain.instrument.plugin, 'instrument'), m.param).id, ...range };
}

export const buildRack = defineTool({
  name: 'build_rack',
  title: 'Build a rack',
  kind: 'write',
  description:
    'Build a rack in one call (one undo step): kind "instrument" (layered / split sounds: chains picked by key + velocity zone, all summed), "drum" (one chain per pad note from C2 = 36, choke groups for hats) or "effect" (parallel effect chains on a mixer insert). Each chain: preset (an instrument preset id / name: its sound + effects) or instrument + params, or sample (sampler pads), plus devices, keys "C3-B4" / velocity [lo,hi] / note "D2" / choke, volume_db, pan. macros (up to 8): name, value 0..1 and maps {chain (number or name), device (number / effect, omit for the instrument), param, min, max} — the macro sweeps each target between min and max (normalized). Target: channel (its instrument is replaced), insert (+ slot to replace an effect; else a new slot) for effect racks, or a new channel named name. Stock plugins only; no racks inside racks. Example: {"kind":"drum","name":"Kit","chains":[{"name":"Kick","sample":"factory:drums/kick.wav"},{"name":"Hat","sample":"factory:drums/hat-closed.wav","note":"F#2","choke":1},{"name":"Open Hat","sample":"factory:drums/hat-open.wav","note":"A#2","choke":1}],"macros":[{"name":"Hat Decay","maps":[{"chain":"Open Hat","param":"ampDecay","min":0.4,"max":0.9}]}]}',
  input: z.object({
    kind: z.enum(['instrument', 'drum', 'effect']).optional().describe('Default: effect with insert, else instrument.'),
    channel: z.string().max(80).optional().describe('Existing channel: its instrument becomes the rack (notes stay).'),
    name: z.string().min(1).max(64).optional().describe('Name of the NEW channel when no channel / insert is given.'),
    insert: z.union([z.string().max(80), z.number().int().min(0)]).optional().describe('Effect racks: the mixer insert ("master", name, index, or a channel name).'),
    slot: z.union([z.string().max(80), z.number().int().min(1)]).optional().describe('Replace this effect slot (1-based or effect name); omit to add a new slot.'),
    chains: z.array(zChain).min(1).max(64),
    macros: z
      .array(z.object({ name: z.string().max(32).optional(), value: z.number().min(0).max(1).optional(), maps: z.array(zMap).max(32).optional() }))
      .max(MACRO_COUNT)
      .optional(),
    variations: z.array(z.object({ name: z.string().min(1).max(64), values: z.array(z.number().min(0).max(1)).max(MACRO_COUNT) })).max(16).optional().describe('Named macro snapshots (values in macro order).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.kind ?? (a.insert !== undefined ? 'effect' : 'instrument')} rack, ${plural(a.chains.length, 'chain')}${a.channel ? ` → ${safeName(a.channel, 30)}` : a.name ? ` "${safeName(a.name, 30)}"` : ''}`,
  paths: (a) => a.chains.filter((c) => c.sample).map((c) => ({ value: c.sample, kind: 'audio' as const })),
  run(deps, caller, a, ctx): ToolResult {
    const kind: RackKind = a.kind ?? (a.insert !== undefined ? 'effect' : 'instrument');
    if (kind === 'effect' && a.insert === undefined) fail('An effect rack goes on a mixer insert: pass insert (and slot to replace an effect).');
    if (kind !== 'effect' && a.insert !== undefined) fail(`An ${kind} rack goes on a channel: pass channel, or name for a new one.`);
    const warnings: string[] = [];
    const used = new Set<number>();
    const built = a.chains.map((c, i) => buildChain(deps, caller, kind, c, i, used, warnings));
    const chains = built.map((b) => b.spec);
    const spec: PresetRack = { kind, chains };
    if (a.macros?.length) {
      spec.macros = a.macros.map((m, mi) => ({ ...(m.name ? { name: safeName(m.name, 32) } : {}), maps: (m.maps ?? []).map((x) => mapFor(deps, chains, x, mi)) }));
    }
    if (a.variations?.length) spec.variations = a.variations.map((v) => ({ name: safeName(v.name, 64), values: Array.from({ length: MACRO_COUNT }, (_, i) => v.values[i] ?? 0) }));
    const values = Array.from({ length: MACRO_COUNT }, (_, i) => a.macros?.[i]?.value ?? 0);
    const p0 = deps.doc.project;
    let where: string;
    let target: { channelId: string } | { insertId: string; slotId?: string };
    if (kind === 'effect') {
      const ins = findInsert(p0, a.insert!);
      target = { insertId: ins.id, ...(a.slot !== undefined ? { slotId: findSlot(ins, a.slot, deps.doc.catalog) } : {}) };
      if (a.slot === undefined && ins.slotOrder.length >= 10) fail(`${ins.isMaster ? 'The master' : `"${safeName(ins.name)}"`} already holds 10 effects; pass slot to replace one.`);
      where = ins.isMaster ? 'the master' : `insert "${safeName(ins.name)}" (${ins.id})`;
    } else if (a.channel) {
      const ch = findChannel(p0, a.channel);
      target = { channelId: ch.id };
      where = `"${safeName(ch.name)}" (${ch.id})`;
    } else {
      const name = safeName(a.name ?? (kind === 'drum' ? 'Drum Rack' : 'Rack'), 64);
      const r = ctx.exec<{ id: string }>('channels.add', { type: RACK_PLUGIN_FOR[kind], name });
      target = { channelId: r.id };
      where = `new channel "${name}" (${r.id})`;
    }
    const r = ctx.exec<{ channelId?: string; insertId?: string; slotId?: string; chainIds: string[] }>('rack.build', { ...target, spec, macros: values });
    if (kind === 'effect' && a.slot === undefined && r.insertId && r.slotId) {
      const order = deps.doc.project.mixer.inserts[r.insertId].slotOrder;
      let at = order.length - 1;
      while (at > 0 && FINAL_STAGE.has(deps.doc.project.mixer.inserts[r.insertId].slots[order[at - 1]].type)) at--;
      if (at < order.length - 1) ctx.exec('mixer.moveSlot', { insertId: r.insertId, slotId: r.slotId, toIndex: at });
    }
    const p = deps.doc.project;
    const rack = r.channelId ? p.channels[r.channelId].generator.rack! : p.mixer.inserts[r.insertId!].slots[r.slotId!].rack!;
    const params = r.channelId ? p.channels[r.channelId].generator.params : p.mixer.inserts[r.insertId!].slots[r.slotId!].params;
    const macros = macroLine(rack, params);
    const kindName = kind === 'drum' ? 'drum rack' : kind === 'effect' ? 'effect rack' : 'instrument rack';
    const how = r.channelId ? `channel/${r.channelId}/gen/macroN` : `insert/${r.insertId}/slot/${r.slotId}/macroN`;
    return {
      ok: true,
      message: `Built ${kind === 'drum' ? 'a' : 'an'} ${kindName} on ${where}${r.slotId ? ` slot ${p.mixer.inserts[r.insertId!].slotOrder.indexOf(r.slotId) + 1}` : ''} with ${plural(chains.length, 'chain')}${macros ? `; macros: ${macros}` : ''}. set_macro moves the macros (automate them with add_automation on ${how}).`,
      changed: [],
      warnings,
      text: built.map((b, i) => `${i + 1}. ${b.label}`).join('\n'),
      data: { ...r },
    };
  },
});

export const setMacro = defineTool({
  name: 'set_macro',
  title: 'Set rack macros',
  kind: 'write',
  description:
    'Move a rack\'s macros (0..1) by number or name, rename one, or use variations (named snapshots of all 8): store_variation "Drop", recall_variation "Drop", remove_variation, randomize (seeded; mapped macros by default). Rack: channel (instrument / drum rack), or insert (+ slot) for an effect rack; omit both when the project has one rack. Example: {"channel":"Keys","macro":"Brightness","value":0.8} or {"insert":"Vox","values":{"Reverb":0.6,"Delay":0.3}}',
  input: z.object({
    channel: z.string().max(80).optional(),
    insert: z.union([z.string().max(80), z.number().int().min(0)]).optional(),
    slot: z.union([z.string().max(80), z.number().int().min(1)]).optional(),
    macro: z.union([z.number().int().min(1).max(MACRO_COUNT), z.string().max(32)]).optional(),
    value: z.number().min(0).max(1).optional(),
    values: z.record(z.string(), z.number().min(0).max(1)).optional().describe('Several at once: macro name or number → 0..1.'),
    rename: z.string().max(32).optional().describe('New name for `macro`.'),
    store_variation: z.string().min(1).max(64).optional(),
    recall_variation: z.string().min(1).max(64).optional(),
    remove_variation: z.string().min(1).max(64).optional(),
    randomize: z.boolean().optional(),
    seed: z.number().int().optional().describe('randomize: the seed (same seed = same values).'),
    amount: z.number().min(0).max(1).optional().describe('randomize: 0..1 how far from the current values (default 1).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.macro !== undefined ? `macro ${safeName(String(a.macro), 20)}` : a.values ? `${Object.keys(a.values).length} macros` : a.store_variation ? `store "${safeName(a.store_variation, 30)}"` : a.recall_variation ? `recall "${safeName(a.recall_variation, 30)}"` : a.randomize ? 'randomize' : 'macros'}`,
  run(deps, _c, a, ctx): ToolResult {
    const r0 = findRack(deps, a);
    const t = r0.target;
    const done: string[] = [];
    const findVar = (ref: string): string => {
      const rack = findRack(deps, a).rack;
      const id = rack.variationOrder.find((v) => v === ref) ?? rack.variationOrder.find((v) => rack.variations[v]?.name.toLowerCase() === ref.trim().toLowerCase());
      if (!id) fail(`No variation "${safeName(ref, 40)}" on ${r0.label}. Variations: ${rack.variationOrder.map((v) => safeName(rack.variations[v].name, 30)).join(', ') || '(none)'}.`);
      return id;
    };
    if (a.recall_variation) {
      const id = findVar(a.recall_variation);
      ctx.exec('rack.recallVariation', { ...t, variationId: id });
      done.push(`recalled "${safeName(findRack(deps, a).rack.variations[id].name, 40)}"`);
    }
    const sets: Array<[number, number]> = [];
    if (a.macro !== undefined && a.value !== undefined) sets.push([macroIndex(r0.rack, a.macro), a.value]);
    for (const [k, v] of Object.entries(a.values ?? {})) sets.push([macroIndex(r0.rack, k), v]);
    for (const [i, v] of sets) {
      ctx.exec('params.set', { ref: `${r0.refPrefix}${MACRO_PARAM_IDS[i]}`, value: v });
      done.push(`${safeName(r0.rack.macros[i].name, 32)} → ${Math.round(v * 100)}%`);
    }
    if (a.rename !== undefined) {
      if (a.macro === undefined) fail('rename needs macro (which one to rename)');
      const i = macroIndex(r0.rack, a.macro);
      ctx.exec('rack.renameMacro', { ...t, macro: i + 1, name: safeName(a.rename, 32) });
      done.push(`macro ${i + 1} renamed "${safeName(a.rename, 32)}"`);
    }
    if (a.randomize) {
      const res = ctx.exec<{ values: number[] }>('rack.randomizeMacros', { ...t, seed: a.seed ?? Math.floor(Math.random() * 2 ** 31), amount: a.amount ?? 1 });
      done.push(`randomized (${res.values.map((v) => Math.round(v * 100)).join(' / ')}%)`);
    }
    if (a.store_variation) {
      ctx.exec('rack.storeVariation', { ...t, name: safeName(a.store_variation, 64) });
      done.push(`stored variation "${safeName(a.store_variation, 40)}"`);
    }
    if (a.remove_variation) {
      ctx.exec('rack.removeVariation', { ...t, variationId: findVar(a.remove_variation) });
      done.push(`removed variation "${safeName(a.remove_variation, 40)}"`);
    }
    if (a.value !== undefined && a.macro === undefined) fail('value needs macro (number or name), or use values {"Name": 0.5}');
    if (!done.length) fail('Nothing to do: pass macro + value, values, rename, store_variation, recall_variation, remove_variation or randomize.');
    const now = findRack(deps, a);
    const vars = now.rack.variationOrder.map((v) => safeName(now.rack.variations[v].name, 30));
    return {
      ok: true,
      message: `${now.label}: ${done.join('; ')}. Macros: ${macroLine(now.rack, now.params) || 'none mapped'}.${vars.length ? ` Variations: ${vars.join(', ')}.` : ''}`,
      changed: [],
    };
  },
});

export const sliceToPadsTool = defineTool({
  name: 'slice_to_pads',
  title: 'Slice a loop to drum pads',
  kind: 'write',
  description:
    'Chop a loop onto a drum rack (one undo step): one pad per slice from C2 (= 36) up, each a sampler playing its part of the sample, plus (pattern, default true) a pattern replaying the loop note by note at its tempo, ready to rearrange. Source: sample (a "factory:…" or allowed audio path), clip (an audio clip id) or channel (an audio-clip / sampler channel name). mode onsets (default; the analyzer finds the hits, keeping the strongest max_slices), grid (every division beats: 0.25 = 16ths) or manual (times in seconds). onto = an existing channel to replace with the drum rack; else a new channel (name). Example: {"sample":"C:/Samples/break.wav","max_slices":16}',
  input: z.object({
    sample: z.string().max(400).optional(),
    clip: z.string().max(80).optional(),
    channel: z.string().max(80).optional(),
    mode: z.enum(['onsets', 'grid', 'manual']).optional(),
    times: z.array(z.number().min(0)).max(64).optional(),
    division: z.number().min(1 / 16).max(16).optional(),
    max_slices: z.number().int().min(1).max(64).optional(),
    onto: z.string().max(80).optional(),
    name: z.string().min(1).max(64).optional(),
    pattern: z.boolean().optional(),
    bpm: z.number().min(10).max(999).optional().describe("The loop's tempo (default: detected)."),
    choke: z.number().int().min(0).max(32).optional().describe('Choke group for every pad (1 = each slice cuts the previous one).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.sample?.split(/[\\/:]/).pop() ?? a.clip ?? a.channel ?? '?', 40)}${a.mode ? ` (${a.mode})` : ''}`,
  paths: (a) => [{ value: a.sample, kind: 'audio' }],
  async run(deps, caller, a, ctx): Promise<ToolResult> {
    const given = [a.sample, a.clip, a.channel].filter((x) => x !== undefined).length;
    if (given !== 1) fail('Pass exactly one source: sample (a path), clip (an audio clip id) or channel (its sample).');
    const p = deps.doc.project;
    let source: { path: string } | { clipId: string } | { channelId: string };
    if (a.sample) source = { path: agentSamplePath(deps, a.sample, caller).docPath };
    else if (a.clip) {
      const c = p.playlist.clips[a.clip];
      if (!c || c.kind !== 'audio') fail(`No audio clip "${safeName(a.clip, 40)}" (get_project lists the clips)`);
      source = { clipId: c.id };
    } else source = { channelId: findChannel(p, a.channel!).id };
    const onto = a.onto ? findChannel(p, a.onto).id : undefined;
    const r = await sliceToPads(
      {
        doc: deps.doc,
        analyze: deps.analyzer ? (t, o) => deps.analyzer!.analyze(t, o) : undefined,
        sampleInfo: (abs) => deps.engine.sampleInfo(abs),
        resolveSamplePath: (x) => deps.project.resolveSamplePath(x),
      },
      source,
      { mode: a.mode, times: a.times, division: a.division, maxSlices: a.max_slices, channelId: onto, name: a.name ? safeName(a.name, 64) : undefined, pattern: a.pattern, bpm: a.bpm, choke: a.choke },
      (cmd, args) => ctx.exec(cmd, args),
      { onProgress: (stage, f) => ctx.progress?.(f, stage), signal: ctx.signal },
    );
    if (!r.ok || !r.data) fail(r.message ?? 'Slicing failed');
    const d = r.data;
    const ch = deps.doc.project.channels[d.channelId];
    const pat = d.patternId ? deps.doc.project.patterns[d.patternId] : undefined;
    return {
      ok: true,
      message: `${r.message}. Pads ${midiNoteName(DRUM_RACK_BASE_NOTE)}-${midiNoteName(DRUM_RACK_BASE_NOTE + d.slices - 1)} on "${safeName(ch?.name)}" (${d.channelId})${pat ? `; pattern "${safeName(pat.name)}" (${d.patternId}) replays the loop: rewrite it with write_pattern to rearrange the slices` : ''}.`,
      changed: [],
      data: d,
    };
  },
});

const zRef = z.union([z.number().int().min(1), z.string().min(1).max(80)]);
const zMacroRef = z.union([z.number().int().min(1).max(MACRO_COUNT), z.string().min(1).max(32)]);

const zRackOp = z.discriminatedUnion('op', [
  zChain.extend({ op: z.literal('add_chain'), index: z.number().int().min(1).optional().describe('1-based position (default: the end).') }),
  z.object({ op: z.literal('remove_chain'), chain: zRef }),
  z.object({ op: z.literal('move_chain'), chain: zRef, to: z.number().int().min(1).describe('1-based position.') }),
  z.object({
    op: z.literal('set_chain'),
    chain: zRef,
    name: z.string().min(1).max(64).optional(),
    volume_db: z.number().min(-60).max(6).optional(),
    pan: z.number().min(-1).max(1).optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional(),
    keys: z.string().max(12).optional().describe('Instrument racks: key zone "C3-B4".'),
    velocity: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
    all_keys: z.boolean().optional().describe('Instrument racks: true = play every note (clears the zone).'),
    note: z.union([z.string().max(5), z.number().int().min(0).max(127)]).optional().describe('Drum racks: move the pad to this note.'),
    choke: z.number().int().min(0).max(32).optional(),
  }),
  z.object({
    op: z.literal('set_instrument'),
    chain: zRef,
    preset: z.string().max(120).optional().describe("Swap to an instrument preset's sound (its instrument, params and sample; its effects are not added)."),
    instrument: z.string().max(80).optional().describe('Or swap to a stock instrument (synth, wavetable, fm, sampler, 808, drumsynth).'),
    params: zParamsIn.optional().describe("Params of the (new) instrument, human units ok. Alone: change the current instrument's params."),
    sample: z.string().max(400).optional().describe('Sampler sample path ("factory:…" or an allowed audio path).'),
  }),
  z.object({
    op: z.literal('set_sample'),
    chain: zRef.optional(),
    note: z.union([z.string().max(5), z.number().int().min(0).max(127)]).optional().describe('Drum racks: the pad note (a new pad is made when it has none).'),
    sample: z.string().min(1).max(400),
    name: z.string().max(64).optional(),
  }),
  z.object({ op: z.literal('add_device'), chain: zRef, effect: z.string().min(1).max(80), params: zParamsIn.optional(), mix: z.number().min(0).max(1).optional(), index: z.number().int().min(1).optional() }),
  z.object({ op: z.literal('remove_device'), chain: zRef, device: zRef }),
  z.object({ op: z.literal('move_device'), chain: zRef, device: zRef, to: z.number().int().min(1), to_chain: zRef.optional().describe('Move it into another chain of the same rack.') }),
  z.object({ op: z.literal('set_device'), chain: zRef, device: zRef, params: zParamsIn.optional(), mix: z.number().min(0).max(1).optional(), enabled: z.boolean().optional() }),
  z.object({
    op: z.literal('map_macro'),
    macro: zMacroRef,
    chain: zRef,
    device: zRef.optional().describe('Omit for the instrument, or for the chain volume / pan.'),
    param: z.string().min(1).max(64).describe("Param id or name; 'mix' on a device; 'volume' / 'pan' without a device."),
    min: z.number().min(0).max(1).optional(),
    max: z.number().min(0).max(1).optional(),
  }),
  z.object({ op: z.literal('unmap_macro'), macro: zMacroRef, chain: zRef.optional(), device: zRef.optional(), param: z.string().max(64).optional(), all: z.boolean().optional().describe('Remove every mapping of the macro.') }),
]);

type RackOp = z.infer<typeof zRackOp>;

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const devName = (deps: MainDeps, type: string): string => short(deps, type);

function zoneText(kind: RackKind, z0: { keyLo: number; keyHi: number; velLo: number; velHi: number } | undefined): string {
  if (!z0) return kind === 'instrument' ? 'every key' : '';
  const vel = z0.velLo > 0 || z0.velHi < 1 ? ` vel ${z0.velLo}-${z0.velHi}` : '';
  return kind === 'drum' && z0.keyLo === z0.keyHi ? `pad ${midiNoteName(z0.keyLo)}${vel}` : `keys ${midiNoteName(z0.keyLo)}-${midiNoteName(z0.keyHi)}${vel}`;
}

export function describeRack(deps: MainDeps, f: FoundRack): string {
  const p = deps.doc.project;
  const r = f.rack;
  const kindName = r.kind === 'drum' ? 'Drum rack' : r.kind === 'effect' ? 'Effect rack' : 'Instrument rack';
  const lines = [`${kindName} on ${f.label} · ${plural(r.chainOrder.length, 'chain')}`];
  r.chainOrder.forEach((cid, i) => {
    const c = r.chains[cid];
    if (!c) return;
    const zone = zoneText(r.kind, c.zone);
    const inst = c.instrument ? `${devName(deps, c.instrument.type)}${c.instrument.sampleId && p.samples[c.instrument.sampleId] ? ` (${safeName(p.samples[c.instrument.sampleId].name, 40)})` : ''}` : r.kind === 'effect' ? '' : 'no instrument';
    const flags = [c.mute ? 'muted' : '', c.solo ? 'solo' : '', c.choke ? `choke ${c.choke}` : ''].filter(Boolean).join(', ');
    const vol = `${fmtDb(c.volume)}${c.pan ? ` pan ${c.pan > 0 ? 'R' : 'L'}${Math.round(Math.abs(c.pan) * 100)}` : ''}`;
    lines.push(`${i + 1}. ${safeName(c.name, 40)} [${c.id}]${zone ? ` · ${zone}` : ''}${inst ? ` · ${inst}` : ''} · ${vol}${flags ? ` · ${flags}` : ''}`);
    c.deviceOrder.forEach((did, j) => {
      const dv = c.devices[did];
      if (dv) lines.push(`     ${j + 1}) ${devName(deps, dv.type)} [${did}] mix ${pct(dv.mix)}${dv.enabled ? '' : ' (bypassed)'}`);
    });
  });
  r.macros.forEach((m, i) => {
    const maps = Object.values(m.maps);
    if (!maps.length && m.name === `Macro ${i + 1}`) return;
    const where = maps.map((mp) => {
      const c = r.chains[mp.target.chainId];
      const cn = safeName(c?.name ?? '?', 30);
      const t = mp.target;
      const what = t.kind === 'chain' ? t.param : t.kind === 'device' ? `${devName(deps, c?.devices[t.deviceId]?.type ?? '?')} ${t.param}` : `${c?.instrument ? devName(deps, c.instrument.type) : 'instrument'} ${t.param}`;
      return `${cn} ${what} ${Math.round(mp.min * 100)}-${Math.round(mp.max * 100)}% [${mp.id}]`;
    });
    lines.push(`Macro ${i + 1} "${safeName(m.name, 32)}" = ${pct(f.params[MACRO_PARAM_IDS[i]] ?? 0)}${where.length ? ` → ${where.join('; ')}` : ' (no maps)'}`);
  });
  if (r.variationOrder.length) lines.push(`Variations: ${r.variationOrder.map((v) => safeName(r.variations[v]?.name, 30)).join(', ')}`);
  return lines.join('\n');
}

function parseZone(kind: RackKind, o: { keys?: string; velocity?: [number, number]; note?: string | number }, cur: { keyLo: number; keyHi: number; velLo: number; velHi: number } | undefined, where: string) {
  const velLo = o.velocity ? Math.min(o.velocity[0], o.velocity[1]) : cur?.velLo ?? 0;
  const velHi = o.velocity ? Math.max(o.velocity[0], o.velocity[1]) : cur?.velHi ?? 1;
  if (kind === 'drum') {
    if (o.keys) fail(`${where}: keys zones are for instrument racks; a drum pad takes a note ("D2").`);
    const n = o.note !== undefined ? parseNote(o.note) : cur?.keyLo ?? DRUM_RACK_BASE_NOTE;
    return { keyLo: n, keyHi: n, velLo, velHi };
  }
  if (o.note !== undefined) fail(`${where}: note is for drum-rack pads; use keys "C3-B4" for an instrument rack.`);
  const [lo, hi] = o.keys ? parseKeys(o.keys) : [cur?.keyLo ?? 0, cur?.keyHi ?? 127];
  return { keyLo: lo, keyHi: hi, velLo, velHi };
}

function macroTarget(deps: MainDeps, rack: RackDef, where: string, kind: RackKind, chain: RackPick, device: RackPick | undefined, param: string): MacroTarget {
  const catalog = deps.doc.catalog;
  const c = pickChain(rack, chain, where);
  if (device !== undefined) {
    const deviceId = pickDevice(catalog, c, device);
    return { chainId: c.id, kind: 'device', deviceId, param: param.toLowerCase() === 'mix' ? 'mix' : findParam(findPluginRef(catalog, c.devices[deviceId].type, 'effect'), param).id };
  }
  if (/^(volume|vol|level|pan)$/i.test(param)) return { chainId: c.id, kind: 'chain', param: /^pan$/i.test(param) ? 'pan' : 'volume' };
  if (kind === 'effect' || !c.instrument) fail(`Chain "${safeName(c.name, 30)}" has no instrument: name a device, or map 'volume' / 'pan'.`);
  return { chainId: c.id, kind: 'instrument', param: findParam(findPluginRef(catalog, c.instrument.type, 'instrument'), param).id };
}

function runRackOp(deps: MainDeps, caller: ToolCaller, a: { channel?: string; insert?: string | number; slot?: string | number }, o: RackOp, n: number, ctx: RunCtx, warnings: string[]): string {
  const f = findRack(deps, a);
  const t = f.target;
  const r = f.rack;
  const where = `op ${n} (${o.op})`;
  const catalog = deps.doc.catalog;
  const chainOfRef = (ref: RackPick) => pickChain(r, ref, f.label);
  switch (o.op) {
    case 'add_chain': {
      const used = new Set(r.kind === 'drum' ? r.chainOrder.map((id) => r.chains[id]?.zone).filter((z0) => z0 && z0.keyLo === z0.keyHi).map((z0) => z0!.keyLo) : []);
      const { op: _op, index, ...spec } = o;
      const b = buildChain(deps, caller, r.kind, spec, r.chainOrder.length, used, warnings);
      const s = b.spec;
      ctx.exec('rack.addChain', {
        ...t,
        name: s.name,
        ...(s.instrument ? { instrument: { type: s.instrument.plugin, params: s.instrument.params, ...(s.instrument.sample ? { samplePath: s.instrument.sample } : {}) } } : {}),
        ...(s.fx?.length ? { devices: s.fx.map((x) => ({ type: x.type, params: x.params, ...(x.mix !== undefined ? { mix: x.mix } : {}) })) } : {}),
        ...(s.zone ? { zone: s.zone } : {}),
        ...(s.choke ? { choke: s.choke } : {}),
        ...(s.volume !== undefined ? { volume: s.volume } : {}),
        ...(s.pan !== undefined ? { pan: s.pan } : {}),
        ...(index !== undefined ? { index: index - 1 } : {}),
      });
      return `added chain "${b.label}"`;
    }
    case 'remove_chain': {
      const c = chainOfRef(o.chain);
      const res = ctx.exec<{ removedMaps: number }>('rack.removeChain', { ...t, chainId: c.id });
      return `removed chain "${safeName(c.name, 40)}"${res.removedMaps ? ` (and ${plural(res.removedMaps, 'macro map')})` : ''}`;
    }
    case 'move_chain': {
      const c = chainOfRef(o.chain);
      if (r.chainOrder.indexOf(c.id) === Math.min(o.to, r.chainOrder.length) - 1) return '';
      ctx.exec('rack.moveChain', { ...t, chainId: c.id, toIndex: o.to - 1 });
      return `moved "${safeName(c.name, 40)}" to position ${Math.min(o.to, r.chainOrder.length)}`;
    }
    case 'set_chain': {
      const c = chainOfRef(o.chain);
      const args: Record<string, unknown> = { ...t, chainId: c.id };
      const what: string[] = [];
      if (o.name !== undefined) {
        args.name = safeName(o.name, 64);
        what.push(`name "${safeName(o.name, 40)}"`);
      }
      if (o.volume_db !== undefined) {
        args.volume = Math.min(2, dbToGain(o.volume_db));
        what.push(`volume ${o.volume_db} dB`);
      }
      if (o.pan !== undefined) {
        args.pan = o.pan;
        what.push(`pan ${o.pan}`);
      }
      if (o.mute !== undefined) {
        args.mute = o.mute;
        what.push(o.mute ? 'muted' : 'unmuted');
      }
      if (o.solo !== undefined) {
        args.solo = o.solo;
        what.push(o.solo ? 'solo' : 'unsolo');
      }
      if (o.all_keys) {
        if (r.kind !== 'instrument') fail(`${where}: all_keys is for instrument racks (a drum pad keeps its note).`);
        args.zone = null;
        what.push('every key');
      } else if (o.keys !== undefined || o.velocity !== undefined || o.note !== undefined) {
        if (r.kind === 'effect') fail(`${where}: an effect rack's chains all get the whole input (no zones).`);
        args.zone = parseZone(r.kind, o, c.zone, where);
        what.push(zoneText(r.kind, args.zone as never));
      }
      if (o.choke !== undefined) {
        args.choke = o.choke;
        what.push(`choke ${o.choke}`);
      }
      if (!what.length) fail(`${where}: say what to change (name, volume_db, pan, mute, solo, keys, velocity, all_keys, note, choke).`);
      ctx.exec('rack.setChain', args);
      return `"${safeName(c.name, 40)}": ${what.join(', ')}`;
    }
    case 'set_instrument': {
      if (r.kind === 'effect') fail(`${where}: an effect rack's chains hold effects only.`);
      const c = chainOfRef(o.chain);
      if (o.preset || o.instrument) {
        const b = buildChain(deps, caller, r.kind, { preset: o.preset, instrument: o.instrument, params: o.params, sample: o.sample, ...(r.kind === 'drum' && c.zone ? { note: c.zone.keyLo } : {}) }, 0, new Set(), warnings);
        const inst = b.spec.instrument!;
        if (o.preset && b.spec.fx?.length) warnings.push(`The preset's effects (${b.spec.fx.map((x) => devName(deps, x.type)).join(', ')}) were not added: add_device adds them to the chain.`);
        const res = ctx.exec<{ removedMaps: number }>('rack.setInstrument', { ...t, chainId: c.id, type: inst.plugin, params: inst.params, ...(inst.sample ? { samplePath: inst.sample } : {}) });
        return `"${safeName(c.name, 40)}" now plays ${o.preset ? `"${safeName(o.preset, 40)}"` : devName(deps, inst.plugin)}${res.removedMaps ? ` (${plural(res.removedMaps, 'macro map')} to params it lacks removed)` : ''}`;
      }
      const done: string[] = [];
      if (o.params) {
        if (!c.instrument) fail(`${where}: chain "${safeName(c.name, 30)}" has no instrument; pass instrument or preset.`);
        const desc = findPluginRef(catalog, c.instrument.type, 'instrument');
        ctx.exec('rack.setInstrumentParams', { ...t, chainId: c.id, params: resolveParams(desc, o.params) });
        done.push(`${plural(Object.keys(o.params).length, 'param')} set`);
      }
      if (o.sample) {
        ctx.exec('rack.setChainSample', { ...t, chainId: c.id, samplePath: agentSamplePath(deps, o.sample, caller).docPath });
        done.push(`sample ${safeName(o.sample.split(/[\\/:]/).pop(), 40)}`);
      }
      if (!done.length) fail(`${where}: pass preset or instrument (to swap), params, or sample.`);
      return `"${safeName(c.name, 40)}": ${done.join(', ')}`;
    }
    case 'set_sample': {
      const path = agentSamplePath(deps, o.sample, caller).docPath;
      const file = safeName(o.sample.split(/[\\/:]/).pop(), 40);
      if (o.note !== undefined) {
        if (r.kind !== 'drum') fail(`${where}: note picks a drum-rack pad; this is an ${r.kind} rack, so pass chain.`);
        const note = parseNote(o.note);
        const res = ctx.exec<{ created: boolean }>('rack.drumPad', { ...t, note, samplePath: path, ...(o.name ? { name: safeName(o.name, 64) } : {}) });
        return `pad ${midiNoteName(note)}${res.created ? ' (new)' : ''} plays ${file}`;
      }
      if (o.chain === undefined) fail(`${where}: pass chain${r.kind === 'drum' ? ' or note' : ''}.`);
      const c = chainOfRef(o.chain);
      ctx.exec('rack.setChainSample', { ...t, chainId: c.id, samplePath: path });
      if (o.name) ctx.exec('rack.setChain', { ...t, chainId: c.id, name: safeName(o.name, 64) });
      return `"${safeName(c.name, 40)}" plays ${file}`;
    }
    case 'add_device': {
      const c = chainOfRef(o.chain);
      const desc = findPluginRef(catalog, o.effect, 'effect');
      if (isRackPlugin(desc.id)) fail(`${where}: racks can't hold racks.`);
      ctx.exec('rack.addDevice', { ...t, chainId: c.id, type: desc.id, params: resolveParams(desc, o.params), ...(o.mix !== undefined ? { mix: o.mix } : {}), ...(o.index !== undefined ? { index: o.index - 1 } : {}) });
      return `added ${devName(deps, desc.id)} to "${safeName(c.name, 40)}"`;
    }
    case 'remove_device': {
      const c = chainOfRef(o.chain);
      const id = pickDevice(catalog, c, o.device);
      const res = ctx.exec<{ removedMaps: number }>('rack.removeDevice', { ...t, chainId: c.id, deviceId: id });
      return `removed ${devName(deps, c.devices[id]?.type ?? '')} from "${safeName(c.name, 40)}"${res.removedMaps ? ` (and ${plural(res.removedMaps, 'macro map')})` : ''}`;
    }
    case 'move_device': {
      const c = chainOfRef(o.chain);
      const id = pickDevice(catalog, c, o.device);
      const to = o.to_chain !== undefined ? chainOfRef(o.to_chain) : c;
      if (to === c && c.deviceOrder.indexOf(id) === Math.min(o.to, c.deviceOrder.length) - 1) return '';
      const type = c.devices[id].type;
      ctx.exec('rack.moveDevice', { ...t, chainId: c.id, deviceId: id, toIndex: o.to - 1, ...(to !== c ? { toChainId: to.id } : {}) });
      return `moved ${devName(deps, type)} to ${to !== c ? `"${safeName(to.name, 40)}" ` : ''}position ${o.to}`;
    }
    case 'set_device': {
      const c = chainOfRef(o.chain);
      const id = pickDevice(catalog, c, o.device);
      const dv = c.devices[id];
      if (!o.params && o.mix === undefined && o.enabled === undefined) fail(`${where}: pass params, mix or enabled.`);
      const params = o.params ? resolveParams(findPluginRef(catalog, dv.type, 'effect'), o.params) : undefined;
      ctx.exec('rack.setDeviceParams', { ...t, chainId: c.id, deviceId: id, ...(params ? { params } : {}), ...(o.mix !== undefined ? { mix: o.mix } : {}), ...(o.enabled !== undefined ? { enabled: o.enabled } : {}) });
      const what = [params ? plural(Object.keys(params).length, 'param') : '', o.mix !== undefined ? `mix ${pct(o.mix)}` : '', o.enabled !== undefined ? (o.enabled ? 'on' : 'bypassed') : ''].filter(Boolean);
      return `${devName(deps, dv.type)} in "${safeName(c.name, 40)}": ${what.join(', ')}`;
    }
    case 'map_macro': {
      const mi = macroIndex(r, o.macro);
      const target = macroTarget(deps, r, f.label, r.kind, o.chain, o.device, o.param);
      const res = ctx.exec<{ target: string; updated: boolean }>('rack.mapMacro', { ...t, macro: mi + 1, target, min: o.min ?? 0, max: o.max ?? 1 });
      return `macro ${mi + 1} "${safeName(r.macros[mi].name, 32)}" ${res.updated ? 'remapped' : 'mapped'} to ${res.target} (${pct(o.min ?? 0)}-${pct(o.max ?? 1)})`;
    }
    case 'unmap_macro': {
      const mi = macroIndex(r, o.macro);
      const m = r.macros[mi];
      if (o.all || o.chain === undefined) {
        if (!o.all) fail(`${where}: say which mapping (chain + device? + param), or all: true.`);
        if (!Object.keys(m.maps).length) return '';
        ctx.exec('rack.unmapMacro', { ...t, macro: mi + 1, all: true });
        return `macro ${mi + 1}: every mapping removed`;
      }
      if (!o.param) fail(`${where}: pass param (with chain, and device for an effect's param), or all: true.`);
      const target = macroTarget(deps, r, f.label, r.kind, o.chain, o.device, o.param);
      const hit = Object.values(m.maps).find((mp) => JSON.stringify(mp.target) === JSON.stringify(target));
      if (!hit) fail(`${where}: macro ${mi + 1} isn't mapped to that. edit_rack with no ops lists its mappings.`);
      ctx.exec('rack.unmapMacro', { ...t, macro: mi + 1, mapId: hit.id });
      return `macro ${mi + 1}: unmapped ${safeName(o.param, 30)}`;
    }
  }
}

export const editRack = defineTool({
  name: 'edit_rack',
  title: 'Edit a rack in place',
  kind: 'write',
  description:
    'Change an existing rack without rebuilding it (one undo step; if any op fails, nothing changes). With no ops it lists the rack: chains with ids, zones / pad notes, instruments, samples, devices, mix, and every macro mapping. Rack: channel (instrument / drum rack), or insert (+ slot) for an effect rack; omit both when the project has one rack. Chains: number (1-based), name or id; devices: number, effect name or id. ops, applied in order: add_chain {name, preset | instrument + params | sample, note | keys / velocity, choke, volume_db, pan, devices, index}; remove_chain {chain}; move_chain {chain, to}; set_chain {chain, name, volume_db, pan, mute, solo, keys, velocity, all_keys, note, choke}; set_instrument {chain, preset | instrument (swap), params, sample}; set_sample {chain | note (drum pad, made if missing), sample}; add_device {chain, effect, params, mix, index}; remove_device {chain, device}; move_device {chain, device, to, to_chain}; set_device {chain, device, params, mix, enabled}; map_macro {macro, chain, device?, param, min, max}; unmap_macro {macro, chain + device? + param | all}. set_macro moves macro values and variations; build_rack makes a new rack. Example: {"channel":"Kit","ops":[{"op":"set_sample","note":"D2","sample":"factory:drums/clap.wav"},{"op":"add_device","chain":"Snare","effect":"reverb","mix":0.2},{"op":"map_macro","macro":1,"chain":"Snare","device":"reverb","param":"mix","max":0.6}]}',
  input: z.object({
    channel: z.string().max(80).optional(),
    insert: z.union([z.string().max(80), z.number().int().min(0)]).optional(),
    slot: z.union([z.string().max(80), z.number().int().min(1)]).optional(),
    ops: z.array(zRackOp).max(64).optional(),
    change_label: zLabel,
  }),
  readsWhenUnchanged: true,
  summarize: (a) => (a.ops?.length ? `${plural(a.ops.length, 'rack edit')}${a.channel ? ` on ${safeName(a.channel, 30)}` : ''}` : `read rack${a.channel ? ` ${safeName(a.channel, 30)}` : ''}`),
  paths: (a) => (a.ops ?? []).filter((o) => 'sample' in o && typeof o.sample === 'string').map((o) => ({ value: (o as { sample: string }).sample, kind: 'audio' as const })),
  run(deps, caller, a, ctx): ToolResult {
    const first = findRack(deps, a);
    if (!a.ops?.length) return { ok: true, message: `${first.label}: ${plural(first.rack.chainOrder.length, 'chain')}. Pass ops to change it.`, changed: [], text: describeRack(deps, first) };
    const snap = (): string => {
      const f = findRack(deps, a);
      return JSON.stringify([f.rack, f.params]);
    };
    const before = snap();
    const warnings: string[] = [];
    const done = a.ops.map((o, i) => runRackOp(deps, caller, a, o, i + 1, ctx, warnings)).filter(Boolean);
    if (snap() === before) fail(`No change: the rack on ${first.label} already matched (${safeName(a.ops.map((o) => o.op).join(', '), 120)}).`);
    const now = findRack(deps, a);
    return { ok: true, message: `${now.label}: ${done.join('; ')}.`, changed: [], warnings, text: describeRack(deps, now) };
  },
});

export const RACK_TOOLS = [buildRack, setMacro, sliceToPadsTool, editRack];
