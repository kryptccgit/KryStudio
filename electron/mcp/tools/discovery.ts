import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MainDeps } from '../types';
import type { FxSlot, Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import type { ParamSpec, PluginDescriptor } from '@shared/plugins/types';
import { formatParam } from '@shared/plugins/types';
import { ticksPerBar } from '@shared/schema/time';
import { noteName } from '@shared/music/theory';
import { defineTool, fail } from './types';
import { AUDIO_EXT, findChannel, findInsert, findPluginRef, findSlot, fmtDb, fmtPan, looksLikePath, plural, pluginName, round, safeName } from './util';
import { instrumentLabel, noteCount, projectOverview } from './overview';
import { SAMPLE_KINDS, type FactorySample, type SampleKind } from '@shared/sounds/types';
import { genreInText, resolveGenre, type GenreId } from '@shared/sounds/genres';
import { rankSamples } from '@shared/sounds/select';
import { factoryIndexOf, factoryRoot, genreContext } from './instruments';
import { likeKindText, similarForAgent, similarWarnings } from './similar';
import type { RunCtx, ToolCaller, ToolResult } from './types';

export const getProject = defineTool({
  name: 'get_project',
  title: 'Project overview',
  kind: 'read',
  description:
    'START HERE. A compact map of the open project: tempo, time signature, swing, mode, every channel (id, instrument, mixer insert, volume), patterns (length, channels used), playlist lanes and clips, markers and non-default mixer inserts. Use the ids or names it shows in other tools.',
  input: z.object({ detail: z.enum(['brief', 'full']).default('brief').describe('"full" lists every playlist clip and mixer insert.') }),
  run(deps, _c, a) {
    const o = projectOverview(deps, a.detail);
    return { ok: true, message: `Project "${o.data.name}": ${plural(o.data.channels.length, 'channel')}, ${plural(o.data.patterns.length, 'pattern')}, ${plural(o.data.playlist.clips, 'clip')}.`, changed: [], text: o.text, data: o.data };
  },
});

function nonDefaultParams(desc: PluginDescriptor | undefined, params: Record<string, number>, max = 12): string[] {
  if (!desc) return [];
  const out: string[] = [];
  for (const spec of desc.params) {
    const v = params[spec.id];
    if (v === undefined || v === spec.default) continue;
    out.push(`${spec.id}=${formatParam(spec, v)}`);
    if (out.length >= max) break;
  }
  return out;
}

export const listChannels = defineTool({
  name: 'list_channels',
  title: 'List channels',
  kind: 'read',
  description: 'Every Channel Rack channel with its id, instrument (and sample), volume dB, pan, pitch, mute, mixer insert, root key, mono/glide/cut groups, changed instrument params and note counts in the active pattern.',
  input: z.object({ channels: z.array(z.string()).max(64).optional().describe('Only these (names or ids).') }),
  run(deps, _c, a) {
    const p = deps.doc.project;
    const ids = a.channels ? a.channels.map((r) => findChannel(p, r).id) : p.channelOrder;
    const active = p.transport.activePatternId;
    const rows = ids.map((id) => {
      const ch = p.channels[id];
      const ins = p.mixer.inserts[ch.insertId];
      const desc = deps.doc.catalog.plugins.find((x) => x.id === ch.generator.type);
      return {
        id,
        name: safeName(ch.name),
        instrument: ch.generator.type,
        instrumentName: instrumentLabel(p, deps, ch),
        sample: ch.generator.sampleId ? safeName(p.samples[ch.generator.sampleId]?.path ?? '', 200) : null,
        volumeDb: fmtDb(ch.volume),
        pan: fmtPan(ch.pan),
        pitch: ch.pitch,
        mute: ch.mute,
        insert: { id: ch.insertId, name: ins?.isMaster ? 'Master' : safeName(ins?.name ?? '?') },
        rootKey: noteName(ch.rootKey),
        mono: ch.poly.mono,
        glideMs: ch.poly.glideMs,
        cutGroup: ch.poly.cutGroup,
        cutBy: ch.poly.cutBy,
        params: nonDefaultParams(desc, ch.generator.params),
        notesInActivePattern: active ? noteCount(p, active, id) : 0,
      };
    });
    const text = rows
      .map(
        (r) =>
          `${r.id}  ${r.name} — ${r.instrumentName} → ${r.insert.name} (${r.insert.id}) · vol ${r.volumeDb} · pan ${r.pan}${r.pitch ? ` · pitch ${r.pitch > 0 ? '+' : ''}${r.pitch} st` : ''}${r.mute ? ' · MUTED' : ''} · root ${r.rootKey}${r.mono ? ` · mono glide ${r.glideMs}ms` : ''}${r.cutGroup || r.cutBy ? ` · cut ${r.cutGroup}/${r.cutBy}` : ''} · ${r.notesInActivePattern} notes${r.params.length ? `\n    params: ${r.params.join(', ')}` : ''}`,
      )
      .join('\n');
    return { ok: true, message: `${plural(rows.length, 'channel')}.`, changed: [], text, data: { channels: rows } };
  },
});

export const listPatterns = defineTool({
  name: 'list_patterns',
  title: 'List patterns',
  kind: 'read',
  description: 'Every pattern: id, name, length in bars, notes per channel, how many playlist clips use it, and which one is active.',
  input: z.object({}),
  run(deps) {
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    const clipCount = new Map<string, number>();
    for (const c of Object.values(p.playlist.clips)) if (c.patternId) clipCount.set(c.patternId, (clipCount.get(c.patternId) ?? 0) + 1);
    const rows = p.patternOrder.map((id) => {
      const pat = p.patterns[id];
      return {
        id,
        name: safeName(pat.name),
        bars: round(patternLength(pat, ts) / ticksPerBar(ts), 2),
        fixedLength: pat.length !== null,
        active: p.transport.activePatternId === id,
        clips: clipCount.get(id) ?? 0,
        channels: Object.entries(pat.notes)
          .filter(([, b]) => Object.keys(b).length)
          .map(([chId, b]) => ({ id: chId, name: safeName(p.channels[chId]?.name ?? chId), notes: Object.keys(b).length })),
      };
    });
    const text = rows
      .map((r) => `${r.id}  "${r.name}"${r.active ? ' (active)' : ''} · ${r.bars} bar${r.bars === 1 ? '' : 's'} · ${r.clips} clip${r.clips === 1 ? '' : 's'} · ${r.channels.length ? r.channels.map((c) => `${c.name} ${c.notes}`).join(', ') : 'empty'}`)
      .join('\n');
    return { ok: true, message: `${plural(rows.length, 'pattern')}.`, changed: [], text, data: { patterns: rows } };
  },
});

export const listPlugins = defineTool({
  name: 'list_plugins',
  title: 'List plugins',
  kind: 'read',
  description:
    "The instruments and effects you can load: the stock ones (ids like krypt.triosc, krypt.eq) plus the user's installed third-party VST3/CLAP plugins (ids vst3:<CID> / clap:<id>; source:'installed' lists only those; VST2 is not supported). One line each. Use describe_plugin for parameters.",
  input: z.object({ kind: z.enum(['instrument', 'effect']).optional(), source: z.enum(['stock', 'installed']).optional() }),
  run(deps, _c, a) {
    const ext = (id: string): boolean => id.startsWith('vst3:') || id.startsWith('clap:');
    const list = deps.doc.catalog.plugins
      .filter((x) => !a.kind || x.kind === a.kind)
      .filter((x) => x.id !== 'krypt.audioclip')
      .filter((x) => !a.source || (a.source === 'installed') === ext(x.id));
    const text = list
      .map((x) =>
        ext(x.id)
          ? `${x.id}  ${x.name} (${x.kind}, ${(x.format ?? '').toUpperCase()}${x.vendor ? ` by ${x.vendor}` : ''}, ${x.category}${x.hasEditor ? ', has its own window' : ''}) [${x.params.length} params]`
          : `${x.id}  ${x.name} (${x.kind}, ${x.category}${x.sidechain ? ', sidechain input' : ''}) — ${x.description} [${x.params.length} params]`,
      )
      .join('\n');
    return {
      ok: true,
      message: `${plural(list.length, 'plugin')}.`,
      changed: [],
      text,
      data: {
        plugins: list.map((x) => ({
          id: x.id,
          name: x.name,
          kind: x.kind,
          category: x.category,
          description: x.description,
          params: x.params.length,
          sidechain: !!x.sidechain,
          ...(ext(x.id) ? { installed: true, format: x.format, vendor: x.vendor, hasEditor: !!x.hasEditor } : {}),
        })),
      },
    };
  },
});

function specLine(spec: ParamSpec, current: number | undefined, ref: string | null): string {
  const range = spec.options ? spec.options.map((o, i) => `${i}=${o}`).join(' ') : `${spec.min}..${spec.max}${spec.unit ? ` ${spec.unit}` : ''}${spec.scale !== 'linear' ? ` (${spec.scale})` : ''}`;
  const cur = current !== undefined ? ` = ${formatParam(spec, current)}` : '';
  return `${spec.id}  "${spec.name}"${spec.group ? ` [${spec.group}]` : ''}  ${range}${cur}  (default ${formatParam(spec, spec.default)})${ref ? `  ref ${ref}` : ''}`;
}

export const describePlugin = defineTool({
  name: 'describe_plugin',
  title: 'Describe a plugin and its parameters',
  kind: 'read',
  description:
    'Parameters of a plugin: ids, names, groups, ranges and units, defaults, option labels. Point it at a channel ({channel}) or an effect slot ({insert, effect}) to also get CURRENT values and the ParamRef strings set_params / add_automation accept. Example: {"channel":"Bass","filter":"cutoff"} or {"insert":"Master","effect":"limiter"}.',
  input: z.object({
    plugin: z.string().optional().describe('Plugin id or alias (krypt.triosc, eq, reverb, 808 …).'),
    channel: z.string().optional().describe('A channel: describe its instrument with current values.'),
    insert: z.union([z.string(), z.number()]).optional().describe('Mixer insert (name, id, index, or channel name) — with effect.'),
    effect: z.union([z.string(), z.number()]).optional().describe('Effect slot: 1-based position, slot id, or plugin name.'),
    filter: z.string().max(40).optional().describe('Only params whose id/name/group contains this.'),
  }),
  run(deps, _c, a) {
    const p = deps.doc.project;
    const catalog = deps.doc.catalog;
    let desc: PluginDescriptor;
    let values: Record<string, number> | null = null;
    let refBase: string | null = null;
    let where = '';
    let slot: FxSlot | null = null;
    if (a.channel) {
      const ch = findChannel(p, a.channel);
      desc = findPluginRef(catalog, ch.generator.type);
      values = ch.generator.params;
      refBase = `channel/${ch.id}/gen/`;
      where = ` on channel ${safeName(ch.name)} (${ch.id})`;
    } else if (a.insert !== undefined) {
      const ins = findInsert(p, a.insert);
      if (a.effect === undefined) fail(`Pass effect (1-based slot, id or plugin name). ${safeName(ins.name)} chain: ${ins.slotOrder.map((s, i) => `${i + 1}. ${pluginName(catalog, ins.slots[s].type)}`).join(', ') || 'empty'}`);
      const sid = findSlot(ins, a.effect, catalog);
      slot = ins.slots[sid];
      desc = findPluginRef(catalog, slot.type);
      values = slot.params;
      refBase = `insert/${ins.id}/slot/${sid}/`;
      where = ` in slot ${ins.slotOrder.indexOf(sid) + 1} of ${ins.isMaster ? 'Master' : safeName(ins.name)} (${sid})`;
    } else if (a.plugin) {
      desc = findPluginRef(catalog, a.plugin);
    } else fail('Pass plugin, channel, or insert + effect.');
    const f = a.filter?.toLowerCase();
    const specs = desc.params.filter((s) => !f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f) || (s.group ?? '').toLowerCase().includes(f));
    const lines = specs.map((s) => specLine(s, values ? (values[s.id] ?? s.default) : undefined, refBase ? `${refBase}${s.id}` : null));
    if (slot) lines.push(`mix  "Mix"  0..1 = ${Math.round(slot.mix * 100)}%  enabled=${slot.enabled}${slot.sidechainFrom ? `  sidechain from ${safeName(p.mixer.inserts[slot.sidechainFrom]?.name ?? slot.sidechainFrom)}` : ''}  ref ${refBase}mix`);
    const external = desc.id.startsWith('vst3:') || desc.id.startsWith('clap:');
    const head =
      `${desc.name} (${desc.id}, ${desc.kind})${where} — ${desc.description}` +
      (external
        ? `\nThird-party ${(desc.format ?? '').toUpperCase()} plugin${desc.vendor ? ` by ${desc.vendor}` : ''}: values are the plugin's own (${desc.format === 'vst3' ? 'normalized 0..1; stepped params use step numbers' : 'its native units'}). A param Krypt Studio never set shows its default; the plugin may hold another value from its own preset.`
        : '');
    return {
      ok: true,
      message: `${desc.name}: ${plural(specs.length, 'parameter')}${f ? ` matching "${safeName(f, 20)}"` : ''}.`,
      changed: [],
      text: `${head}\n${lines.join('\n')}`,
      data: {
        id: desc.id,
        params: specs.map((s) => ({ id: s.id, name: s.name, group: s.group, min: s.min, max: s.max, unit: s.unit, scale: s.scale, default: s.default, options: s.options, value: values ? (values[s.id] ?? s.default) : undefined, ref: refBase ? `${refBase}${s.id}` : undefined })),
      },
    };
  },
});

function insertRows(deps: MainDeps, p: Project, ids: string[]) {
  const catalog = deps.doc.catalog;
  return ids.map((id) => {
    const ins = p.mixer.inserts[id];
    const feeds = p.channelOrder.filter((c) => p.channels[c].insertId === id).map((c) => safeName(p.channels[c].name));
    const sends = Object.entries(p.mixer.inserts)
      .filter(([, other]) => other.routes[id] !== undefined && other.id !== id)
      .map(([, other]) => safeName(other.name));
    return {
      id,
      index: p.mixer.insertOrder.indexOf(id),
      name: ins.isMaster ? 'Master' : safeName(ins.name),
      volume: fmtDb(ins.volume),
      pan: fmtPan(ins.pan),
      stereoSep: round(ins.stereoSep, 2),
      mute: ins.mute,
      solo: ins.solo,
      channels: feeds,
      receivesFrom: sends,
      routes: Object.entries(ins.routes).map(([t, lvl]) => ({ to: t === p.mixer.masterId ? 'Master' : safeName(p.mixer.inserts[t]?.name ?? t), id: t, level: fmtDb(lvl) })),
      effects: ins.slotOrder.map((sid, i) => {
        const s = ins.slots[sid];
        const desc = catalog.plugins.find((x) => x.id === s.type);
        return {
          slot: i + 1,
          id: sid,
          plugin: s.type,
          name: pluginName(catalog, s.type),
          enabled: s.enabled,
          mix: Math.round(s.mix * 100),
          sidechainFrom: s.sidechainFrom ? safeName(p.mixer.inserts[s.sidechainFrom]?.name ?? s.sidechainFrom) : null,
          params: nonDefaultParams(desc, s.params, 10),
        };
      }),
    };
  });
}

export const getMixer = defineTool({
  name: 'get_mixer',
  title: 'Read the mixer',
  kind: 'read',
  description: 'Mixer inserts: index, id, volume dB, pan, stereo separation, mute/solo, which channels feed each insert, routing/sends, and every effect slot with its changed parameters and sidechain source. Default: the master plus every insert that is used or non-default.',
  input: z.object({
    inserts: z.array(z.union([z.string(), z.number()])).max(128).optional().describe('Only these (names, ids, indexes or channel names).'),
    detail: z.enum(['brief', 'full']).default('brief').describe('"full" = every insert, even unused ones.'),
  }),
  run(deps, _c, a) {
    const p = deps.doc.project;
    let ids: string[];
    if (a.inserts) ids = [...new Set(a.inserts.map((r) => findInsert(p, r).id))];
    else if (a.detail === 'full') ids = p.mixer.insertOrder;
    else
      ids = p.mixer.insertOrder.filter((id) => {
        const ins = p.mixer.inserts[id];
        if (ins.isMaster || ins.slotOrder.length || ins.volume !== 1 || ins.pan !== 0 || ins.mute) return true;
        return p.channelOrder.some((c) => p.channels[c].insertId === id);
      });
    const rows = insertRows(deps, p, ids);
    const text = rows
      .map((r) => {
        const head = `[${r.index}] ${r.id}  ${r.name}: ${r.volume} · pan ${r.pan}${r.stereoSep ? ` · sep ${r.stereoSep}` : ''}${r.mute ? ' · MUTED' : ''}${r.solo ? ' · SOLO' : ''}${r.channels.length ? ` · from ${r.channels.join(', ')}` : ''}${r.name !== 'Master' ? ` · → ${r.routes.map((x) => `${x.to} ${x.level}`).join(', ') || 'nowhere'}` : ''}`;
        const fx = r.effects.map((e) => `    ${e.slot}. ${e.name} (${e.id})${e.enabled ? '' : ' BYPASSED'}${e.mix !== 100 ? ` mix ${e.mix}%` : ''}${e.sidechainFrom ? ` sidechain←${e.sidechainFrom}` : ''}${e.params.length ? `: ${e.params.join(', ')}` : ''}`);
        return [head, ...fx].join('\n');
      })
      .join('\n');
    return { ok: true, message: `${plural(rows.length, 'insert')} of ${p.mixer.insertOrder.length}.`, changed: [], text, data: { inserts: rows } };
  },
});

function walk(dir: string, depth: number, out: string[], budget: { n: number }): void {
  if (depth < 0 || budget.n <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (--budget.n <= 0) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, out, budget);
    else if (e.isFile() && AUDIO_EXT.test(e.name)) out.push(full);
  }
}

const FIND_KINDS = [...SAMPLE_KINDS, 'fx', 'loop'] as const;
type FindKind = (typeof FIND_KINDS)[number];
export type UserSampleKind = SampleKind | 'fx' | 'loop';

const FX_KINDS: ReadonlySet<string> = new Set(['riser', 'downlifter', 'impact', 'sweep-up', 'sweep-down', 'reverse-cymbal', 'sub-drop', 'noise', 'whoosh', 'tape-stop', 'swell']);

function sampleWords(s: string): string {
  const w = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
  return ` ${w} `;
}

const KIND_RULES: Array<[RegExp, UserSampleKind]> = [
  [/ (reverse|rev) (cymbal|cym|crash) | revcym /, 'reverse-cymbal'],
  [/ (tape ?stops?|vinyl ?stops?|tapestop|record ?stops?|power ?downs?|slow ?downs?) /, 'tape-stop'],
  [/ (swells?|reverse ?reverb|rev ?verb|reverb ?swell) /, 'swell'],
  [/ sub ?drops? /, 'sub-drop'],
  [/ (down ?lifters?|downers?) /, 'downlifter'],
  [/ (risers?|uplifters?|uplift|build ?ups?|rise) /, 'riser'],
  [/ (down ?sweeps?|sweeps? ?down) /, 'sweep-down'],
  [/ (whoosh(es)?|swoosh(es)?|woosh(es)?|swish(es)?|pass ?by) /, 'whoosh'],
  [/ sweeps? /, 'sweep-up'],
  [/ (impacts?|booms?|slams?) /, 'impact'],
  [/ 808s? /, '808'],
  [/ (open ?hat|hat ?open|open ?hh|open hi ?hat|oh|ohh) /, 'openhat'],
  [/ (hat|hats|hihat|hihats|hi hat|hh|chh|closed ?hat) /, 'hat'],
  [/ (kick|kicks|bd|kik|bassdrum) /, 'kick'],
  [/ (snare|snares|snr|sd) /, 'snare'],
  [/ (clap|claps|cp) /, 'clap'],
  [/ (snap|snaps) /, 'snap'],
  [/ (rim|rims|rimshot|stick) /, 'rim'],
  [/ (shaker|shakers|shake|tamb|tambourine) /, 'shaker'],
  [/ ride /, 'ride'],
  [/ (crash|cymbal|cymbals) /, 'crash'],
  [/ (tom|toms|conga|congas|bongo|bongos) /, 'tom'],
  [/ (perc|percs|percussion|cowbell|clave|block) /, 'perc'],
  [/ (fill|fills|roll|rolls) /, 'fill'],
  [/ (white noise|pink noise|noise) /, 'noise'],
  [/ (8 ?bit|chiptune|chip ?tune|retro game|coin|power ?up) /, 'retro'],
  [/ (zaps?|lasers?|blips?|glitch(es)?|bleeps?) /, 'zap'],
  [/ (vox|vocals?|vocal ?chops?|shouts?|breaths?) /, 'vox'],
  [/ (ambience|ambiences|atmos|atmosphere|field ?recording|city|crowd|birds?) /, 'ambience'],
  [/ foley /, 'foley'],
  [/ (vinyl|crackle|texture|textures|hiss|rain|room tone) /, 'texture'],
  [/ stabs? /, 'stab-oneshot'],
  [/ (bass|reese|sub) /, 'bass-oneshot'],
  [/ (fx|sfx|effects) /, 'fx'],
];

export function classifyUserSample(relPath: string): UserSampleKind | null {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const file = sampleWords((parts.pop() ?? '').replace(/\.[a-z0-9]+$/i, ''));
  if (/ (loop|loops|\d+ ?bpm|bpm \d+) /.test(file)) return 'loop';
  for (const [re, kind] of KIND_RULES) if (re.test(file)) return kind;
  for (const dir of parts.reverse()) {
    const w = sampleWords(dir);
    if (/ (loop|loops) /.test(w)) return 'loop';
    for (const [re, kind] of KIND_RULES) if (re.test(w)) return kind;
  }
  return null;
}

function barsFromName(name: string): number | undefined {
  const m = / (\d{1,2}) ?bars? /.exec(sampleWords(name.replace(/\.[a-z0-9]+$/i, '')));
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n <= 64 ? n : undefined;
}

function factoryKindOk(x: FactorySample, kind: FindKind | undefined): boolean {
  if (!kind) return true;
  if (kind === 'fx') return FX_KINDS.has(x.kind);
  if (kind === 'loop') return x.bars !== undefined && !FX_KINDS.has(x.kind);
  return x.kind === kind;
}

function userKindOk(k: UserSampleKind | null, kind: FindKind | undefined): boolean {
  if (!kind) return true;
  if (kind === 'fx') return k === 'fx' || (!!k && FX_KINDS.has(k));
  return k === kind;
}

interface FoundSample {
  path: string;
  name: string;
  source: 'factory' | 'pack' | 'user';
  kind?: UserSampleKind;
  tags?: string[];
  genres?: GenreId[];
  rootNote?: number;
  bars?: number;
  bpm?: number;
  lengthSec?: number;
}

function foundLine(s: FoundSample): string {
  const bits: string[] = [];
  if (s.kind) bits.push(s.kind);
  if (s.source !== 'user' && s.tags) bits.push(safeName(s.name, 48));
  if (s.bars !== undefined) bits.push(`${s.bars} bar${s.bars === 1 ? '' : 's'}${s.bpm ? ` @${s.bpm} bpm` : ''}`);
  if (s.rootNote !== undefined) bits.push(`root ${noteName(s.rootNote)}`);
  if (s.tags?.length) bits.push(`[${s.tags.slice(0, 5).join(', ')}]`);
  if (s.genres?.length) bits.push(`{${s.genres.slice(0, 3).join(', ')}}`);
  return `${s.path}${bits.length ? `  ${bits.join(' · ')}` : ''}`;
}

const ANY_GENRE = /^(any|none|all)$/i;

async function likeSamples(deps: MainDeps, caller: ToolCaller, a: { like: string; kind?: FindKind; limit: number; query?: string; genre?: string; bars?: number }, ctx?: RunCtx): Promise<ToolResult> {
  const r = await similarForAgent(deps, caller, ctx, a.like, { scope: a.kind ? 'any' : 'same', want: 'samples', limit: a.kind ? 100 : a.limit }, classifyUserSample);
  const items = r.items
    .filter((i): i is Extract<typeof i, { type: 'sample' }> => i.type === 'sample')
    .filter((i) => !a.kind || (a.kind === 'fx' ? FX_KINDS.has(i.kind) : a.kind === 'loop' ? i.bars !== undefined && !FX_KINDS.has(i.kind) : i.kind === a.kind))
    .slice(0, a.limit);
  const warnings = similarWarnings(r);
  if (a.query || a.genre !== undefined || a.bars !== undefined) warnings.push('query, genre and bars are ignored with like (the closest sounds come first).');
  const name = safeName(r.source.name, 60);
  if (!items.length) return { ok: true, message: `No samples${a.kind ? ` of kind ${a.kind}` : ''} sound like "${name}"${likeKindText(r)} yet.${a.kind ? '' : ' Pass kind to search another kind.'}`, changed: [], warnings, data: { like: r.source, samples: [], pending: r.pending } };
  return {
    ok: true,
    message: `${plural(items.length, 'sample')} like "${name}"${likeKindText(r)}, closest first${a.kind ? ` (kind ${a.kind})` : ''}. Load one with load_sample.`,
    changed: [],
    warnings,
    text: items.map((i) => `${i.path}  ${i.kind} · ${safeName(i.name, 48)} · ${i.percent}% · ${i.why}`).join('\n'),
    data: {
      like: { ...r.source, name },
      samples: items.map((i) => ({ path: i.path, name: safeName(i.name), source: i.origin, kind: i.kind, similarity: i.percent, why: i.why, ...(i.rootNote !== undefined ? { rootNote: i.rootNote } : {}), ...(i.bars !== undefined ? { bars: i.bars } : {}) })),
      pending: r.pending,
    },
  };
}

export const findSamples = defineTool({
  name: 'find_samples',
  title: 'Find samples',
  kind: 'read',
  description: [
    "Search the factory sample library, the installed sound packs' samples (recorded foley, ambience, impacts, retro game sounds … once the user downloaded them; list_packs) and the user's Browser folders for audio files.",
    `Filter by kind (${SAMPLE_KINDS.join(', ')}; "fx" = any transition sound: risers, downlifters, impacts, sweeps, reverse cymbals, sub drops, whooshes, tape stops, swells, noise; "loop" = loops), genre (ranking; default the project genre), bars (tempo-synced FX / loops of that length) and name words (query).`,
    'Lines show the kind, root note and bars when known. Tempo-synced factory FX are written at their bpm and END on their last bar line: as an audio clip with tempo_sync on and src_bpm = that bpm they span exactly `bars` bars, so a 4-bar riser into bar 17 starts at bar 13.',
    'Paths work with load_sample ("factory:…", "pack:<pack>/…" or absolute paths inside allowed folders). Example: {"kind":"riser","bars":4}',
    'More like this: like = a sample path (factory:… / pack:… / an audio file) or an instrument preset id → the closest factory and pack samples by timbre (similarity %, one-line difference), the same kind first (a kick finds kicks); add kind for another kind. Example: {"like":"factory:drums/kick.wav"}',
  ].join(' '),
  input: z.object({
    query: z.string().max(80).optional().describe('Name words, e.g. "snare tight", "vinyl".'),
    kind: z.enum(FIND_KINDS).optional(),
    genre: z.string().max(40).optional().describe('Genre id or alias for ranking (default: the project genre; "any" = none).'),
    bars: z.number().int().min(1).max(64).optional().describe('Only tempo-synced FX / loops of this many bars (closest lengths when none match exactly).'),
    limit: z.number().int().min(1).max(100).default(30),
    like: z.string().min(1).max(1024).optional().describe('Find more like this sound: a sample path (factory:… / pack:… / an audio file) or an instrument preset id → the closest samples by timbre.'),
  }),
  paths: (a) => (a.like && looksLikePath(a.like) ? [{ value: a.like, kind: 'audio' as const }] : []),
  run(deps, caller, a, ctx) {
    if (a.like) return likeSamples(deps, caller, { ...a, like: a.like }, ctx);
    const words = (a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const anyGenre = a.genre !== undefined && ANY_GENRE.test(a.genre.trim());
    const genre = a.genre === undefined ? genreContext(deps) : anyGenre ? null : resolveGenre(a.genre);
    const warnings: string[] = [];
    if (a.genre !== undefined && !anyGenre && !genre) warnings.push(`Unknown genre "${safeName(a.genre, 30)}"; ranked without one.`);
    const factory: FoundSample[] = [];
    const user: FoundSample[] = [];
    const index = factoryIndexOf(deps);
    const froot = factoryRoot(deps);
    if (index) {
      const single = a.kind && a.kind !== 'fx' && a.kind !== 'loop' ? (a.kind as SampleKind) : undefined;
      let ranked = rankSamples(index.samples, { text: a.query, kind: single, genre: genre ?? undefined, bars: a.bars }, 2000).filter((x) => factoryKindOk(x, a.kind));
      if (a.bars !== undefined && ranked.some((x) => x.bars === a.bars)) ranked = ranked.filter((x) => x.bars === a.bars);
      for (const x of ranked) {
        factory.push({ path: x.path, name: x.name, source: x.path.startsWith('pack:') ? 'pack' : 'factory', kind: x.kind, tags: x.tags, genres: x.genres, rootNote: x.rootNote, bars: x.bars, bpm: x.bpm, lengthSec: x.lengthSec });
      }
    }
    if (froot && !index?.samples.some((x) => x.path.startsWith('factory:'))) {
      const files: string[] = [];
      walk(froot, 4, files, { n: 4000 });
      for (const f of files) {
        const rel = path.relative(froot, f).split(path.sep).join('/');
        if (!words.every((w) => rel.toLowerCase().includes(w))) continue;
        const kind = classifyUserSample(rel);
        if (!userKindOk(kind, a.kind)) continue;
        const bars = barsFromName(path.basename(f));
        if (a.bars !== undefined && bars !== a.bars) continue;
        factory.push({ path: `factory:${rel}`, name: path.basename(f), source: 'factory', kind: kind ?? undefined, bars });
      }
    }
    const sameDir = (x: string, y: string) => path.resolve(x).toLowerCase() === path.resolve(y).toLowerCase();
    const roots = deps.project.allowedRoots().filter((r) => !froot || !sameDir(r, froot));
    for (const root of roots) {
      if (user.length >= a.limit * 4) break;
      const files: string[] = [];
      walk(root, 5, files, { n: 8000 });
      for (const f of files) {
        const rel = path.relative(root, f);
        if (!words.every((w) => rel.toLowerCase().includes(w))) continue;
        const kind = classifyUserSample(rel);
        if (!userKindOk(kind, a.kind)) continue;
        const bars = barsFromName(path.basename(f));
        if (a.bars !== undefined && bars !== a.bars) continue;
        const g = genreInText(rel);
        user.push({ path: f, name: path.basename(f), source: 'user', kind: kind ?? undefined, bars, genres: g ? [g] : undefined });
      }
    }
    if (genre) user.sort((x, y) => Number(!!y.genres?.includes(genre)) - Number(!!x.genres?.includes(genre)));
    let nf = Math.min(factory.length, user.length ? Math.ceil(a.limit * 0.6) : a.limit);
    const nu = Math.min(user.length, a.limit - nf);
    nf = Math.min(factory.length, a.limit - nu);
    const shown = [...factory.slice(0, nf), ...user.slice(0, nu)];
    const total = factory.length + user.length;
    const filters = [a.query ? `"${safeName(a.query)}"` : '', a.kind ? `kind ${a.kind}` : '', a.bars !== undefined ? `${a.bars} bars` : ''].filter(Boolean).join(', ');
    if (!shown.length) {
      const why = [
        !index && !froot ? 'The factory library is not installed.' : !index ? 'The factory kit has no sample index yet (only the basic drum kit).' : '',
        a.kind && ['foley', 'ambience', 'retro', 'vox', 'zap'].includes(a.kind) && !index?.samples.some((x) => x.path.startsWith('pack:')) ? 'More recorded sounds come with the sound packs the user can download in Home ▸ Sounds (list_packs).' : '',
        deps.project.allowedRoots().length ? '' : 'The user has no Browser folders yet.',
      ]
        .filter(Boolean)
        .join(' ');
      return { ok: true, message: `No samples match${filters ? ` ${filters}` : ''}.${why ? ` ${why}` : ''}`, changed: [], warnings, data: { samples: [] } };
    }
    const genreNote = genre && index ? ` Ranked for ${genre}.` : '';
    return {
      ok: true,
      message: `${plural(shown.length, 'sample')}${total > shown.length ? ` (of ${total})` : ''}${filters ? ` for ${filters}` : ''}.${genreNote}`,
      changed: [],
      warnings,
      text: shown.map(foundLine).join('\n'),
      data: { samples: shown.map((s) => ({ ...s, name: safeName(s.name) })) },
    };
  },
});

export const DISCOVERY_TOOLS = [getProject, listChannels, listPatterns, listPlugins, describePlugin, getMixer, findSamples];
