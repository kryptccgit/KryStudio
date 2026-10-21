// review_song's checks (owned by craft-tools): the agent's mandatory
// self-review. Pure functions over the project, the render's analysis and
// the playbook targets, so each check is unit-testable without an engine.
// Order of the checks = impact order (mix, arrangement, sound); the result
// ranks issues by severity, then by that order. research/10-sound-and-craft.md.

import type { Channel, Clip, MixerInsert, Project } from '@shared/schema/project';
import type { PluginCatalog } from '@shared/plugins/types';
import type { Analysis } from '@shared/engine/protocol';
import type { SymbolicStats } from '@shared/kpn';
import type { Playbook, PlaybookTargets, SectionKind, TransitionKind } from '@shared/playbooks/types';
import type { FactorySample, InstrumentPreset, InstrumentRole, Preset } from '@shared/sounds/types';
import { LEGACY_FACTORY_PATHS } from '@shared/sounds/types';
import { rankPresets, rankSamples, roleFromName } from '@shared/sounds/select';
import type { GenreId } from '@shared/sounds/genres';
import { PPQ, ticksPerBar, ticksPerBeat, ticksToSeconds } from '@shared/schema/time';
import { isDrumChannel } from './overview';
import { GENERIC_TARGETS, grooveFor, KIND_ENERGY } from './craftRecipe';
import type { ReferenceComparison } from './hearing';
import { computeCloseness, type Closeness, type ClosenessDimId, type ClosenessInput } from './closeness';

export type Severity = 'high' | 'medium' | 'low';
export type Area = 'mix' | 'arrangement' | 'sound' | 'reference';

export interface ReviewIssue {
  check: string;
  area: Area;
  severity: Severity;
  /** Where (1-based bars), e.g. "33-48" or "17, 33". */
  bars?: string;
  problem: string;
  /** The concrete fix as tool call sketches. */
  fix: string;
  /** Impact order of the check (lower first among equal severity). */
  order: number;
}

export interface ReviewSection {
  name: string;
  kind: SectionKind | null;
  /** Song ticks [start, end). */
  start: number;
  end: number;
  source: 'marker' | 'inferred';
  /** Mean loudness of the section in the render (LUFS), when the analysis has an energy curve. */
  lufs?: number | null;
}

export interface ReviewInput {
  project: Project;
  catalog: PluginCatalog;
  playbook: Playbook | null;
  targets: PlaybookTargets;
  /** Song ticks [start, end) under review. */
  range: { start: number; end: number };
  /** The whole song is reviewed (length, intro and ending checks apply). */
  wholeSong: boolean;
  /** The engine's full analysis of the render (null: render failed or this engine returned none). */
  analysis: Analysis | null;
  /** Peak / correlation measured from the WAV when the engine returned no analysis. */
  measured?: { peakDb: number | null; correlation: number | null } | null;
  symbolic: SymbolicStats | null;
  /** Presets and factory samples for the fix suggestions. */
  presets: readonly Preset[];
  samples: readonly FactorySample[] | null;
  genre: GenreId | null;
  /** The app's preset pick for a role (load_preset's choice); default: rankPresets over `presets`. */
  pickPreset?: (role: InstrumentRole, words: string) => InstrumentPreset | null;
  /** The render compared with the reference song (study_reference), when the project has one. */
  reference?: { name: string; comparison: ReferenceComparison } | null;
  /**
   * The studied reference for the closeness score (research/15 §3.5): its brief + analysis, the per-part balance of a
   * stems render against the reference stems, and per-part sound similarity when fingerprints are available.
   */
  closeness?: Pick<ClosenessInput, 'reference' | 'balance' | 'balanceNote' | 'sounds' | 'soundsNote'> | null;
}

export interface ReviewResult {
  score: number;
  /** At most 10, ranked. */
  issues: ReviewIssue[];
  /** Issues found in total (the score counts all of them). */
  total: number;
  works: string[];
  sections: ReviewSection[];
  /** Checks that couldn't run, with why. */
  skipped: string[];
  metrics: {
    bars: number;
    lufs: number | null;
    truePeakDb: number | null;
    correlation: number | null;
    bandsVsMid: Record<string, number> | null;
    contrastLu: number | null;
  };
  /** How close the song is to the studied reference (only with a reference). */
  closeness?: Closeness;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { high: 14, medium: 7, low: 3 };
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const j = (v: unknown): string => JSON.stringify(v);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const sgn = (n: number): string => `${n > 0 ? '+' : ''}${r1(n)}`;

// ── What plays where ────────────────────────────────────────────────────

export interface BarInfo {
  /** Everything heard or moving in the bar (notes, audio positions, automation positions). '' = nothing. */
  sig: string;
  /** Drum hits only. */
  drumSig: string;
  /** Channels with notes in the bar. */
  channels: Set<string>;
  notes: number;
  /** Notes in the bar's last beat. */
  lastBeatNotes: number;
  audio: number;
  automation: number;
}

export interface Heard {
  bars: BarInfo[];
  barTicks: number;
  start: number;
  /** Per channel: velocities (0..127) and song ticks of the notes heard, and which patterns they come from. */
  channels: Map<string, { vels: number[]; ticks: number[]; patterns: Map<string, number> }>;
  /** Clips that sound (not muted, track not muted, solo respected). */
  clips: Clip[];
}

function audibleClip(p: Project, c: Clip, solo: string[]): boolean {
  const t = p.playlist.tracks[c.trackId];
  if (!t || c.mute || t.mute || (solo.length && !solo.includes(c.trackId))) return false;
  if (c.kind === 'audio' && (!c.channelId || !p.channels[c.channelId] || p.channels[c.channelId].mute)) return false;
  return true;
}

/** Notes, audio and automation heard per bar of [start, end) (pattern clips play their window once, like render). */
export function collectHeard(p: Project, start: number, end: number): Heard {
  const barTicks = ticksPerBar(p.transport.timeSig);
  const beat = ticksPerBeat(p.transport.timeSig);
  const n = Math.max(0, Math.ceil((end - start) / barTicks));
  const items: string[][] = Array.from({ length: n }, () => []);
  const drums: string[][] = Array.from({ length: n }, () => []);
  const bars: BarInfo[] = Array.from({ length: n }, () => ({ sig: '', drumSig: '', channels: new Set<string>(), notes: 0, lastBeatNotes: 0, audio: 0, automation: 0 }));
  const channels: Heard['channels'] = new Map();
  const solo = p.playlist.trackOrder.filter((t) => p.playlist.tracks[t]?.solo);
  const clips = Object.values(p.playlist.clips)
    .filter((c) => audibleClip(p, c, solo) && c.start < end && c.start + c.length > start)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  for (const c of clips) {
    if (c.kind === 'pattern') {
      const pat = c.patternId ? p.patterns[c.patternId] : undefined;
      if (!pat) continue;
      for (const [chId, notes] of Object.entries(pat.notes)) {
        const ch = p.channels[chId];
        if (!ch || ch.mute) continue;
        const drum = isDrumChannel(ch);
        let entry = channels.get(chId);
        for (const note of Object.values(notes)) {
          if (note.mute || note.tick < c.offset || note.tick >= c.offset + c.length) continue;
          const t = c.start + (note.tick - c.offset);
          if (t < start || t >= end) continue;
          const bi = Math.floor((t - start) / barTicks);
          const within = t - start - bi * barTicks;
          const token = `${chId}|${within}|${note.key}|${Math.round(note.vel * 16)}`;
          items[bi].push(token);
          if (drum) drums[bi].push(token);
          const b = bars[bi];
          b.notes++;
          b.channels.add(chId);
          if (within >= barTicks - beat) b.lastBeatNotes++;
          if (!entry) {
            entry = { vels: [], ticks: [], patterns: new Map() };
            channels.set(chId, entry);
          }
          entry.vels.push(Math.round(note.vel * 127));
          entry.ticks.push(t);
          entry.patterns.set(pat.id, (entry.patterns.get(pat.id) ?? 0) + 1);
        }
      }
    } else {
      const from = Math.max(0, Math.floor((Math.max(c.start, start) - start) / barTicks));
      const to = Math.min(n, Math.ceil((Math.min(c.start + c.length, end) - start) / barTicks));
      for (let bi = from; bi < to; bi++) {
        const at = Math.max(c.start, start + bi * barTicks);
        const pos = c.offset + (at - c.start);
        if (c.kind === 'audio') {
          items[bi].push(`A|${c.channelId}|${pos}`);
          bars[bi].audio++;
        } else {
          items[bi].push(`M|${c.automationId}|${pos}`);
          bars[bi].automation++;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    bars[i].sig = items[i].sort().join(';');
    bars[i].drumSig = drums[i].sort().join(';');
  }
  return { bars, barTicks, start, channels, clips };
}

// ── Sections ────────────────────────────────────────────────────────────

const KIND_WORDS: Array<[RegExp, SectionKind]> = [
  [/\bintro/i, 'intro'],
  [/\boutro|\bending\b|\bend\b/i, 'outro'],
  [/\bpre[- ]?(chorus|hook|drop)?\b/i, 'pre'],
  [/\bbuild|\bbuild-?up|\briser?\b/i, 'build'],
  [/\bdrop/i, 'drop'],
  [/\bchorus/i, 'chorus'],
  [/\bhook/i, 'hook'],
  [/\bbreakdown/i, 'breakdown'],
  [/\bbreak\b/i, 'break'],
  [/\bbridge/i, 'bridge'],
  [/\bverse/i, 'verse'],
];

/** The section kind a marker name implies ("Drop 2" → drop, "Pre-Chorus" → pre), or null. */
export function kindOf(name: string): SectionKind | null {
  for (const [re, k] of KIND_WORDS) if (re.test(name)) return k;
  return null;
}

/** Sections from the markers inside the range; without markers, from where the set of playing channels changes. */
export function sectionsOf(p: Project, range: { start: number; end: number }, heard: Heard): ReviewSection[] {
  const markers = Object.values(p.playlist.markers)
    .filter((m) => m.tick >= range.start && m.tick < range.end)
    .sort((a, b) => a.tick - b.tick);
  const out: ReviewSection[] = [];
  if (markers.length) {
    if (markers[0].tick - range.start >= heard.barTicks) out.push({ name: '(before the first marker)', kind: null, start: range.start, end: markers[0].tick, source: 'marker' });
    markers.forEach((m, i) => {
      const end = i + 1 < markers.length ? markers[i + 1].tick : range.end;
      if (end > m.tick) out.push({ name: m.name.trim() || `Section ${i + 1}`, kind: kindOf(m.name), start: m.tick, end, source: 'marker' });
    });
    return out;
  }
  const sig = (b: BarInfo) => [...b.channels].sort().join(',') + (b.audio ? '|a' : '');
  let s = 0;
  for (let i = 1; i <= heard.bars.length; i++) {
    if (i === heard.bars.length || sig(heard.bars[i]) !== sig(heard.bars[s])) {
      out.push({ name: '', kind: null, start: range.start + s * heard.barTicks, end: Math.min(range.end, range.start + i * heard.barTicks), source: 'inferred' });
      s = i;
    }
  }
  // Fold one-bar blips (a fill pattern, a pickup) into the section before them.
  const merged: ReviewSection[] = [];
  for (const x of out) {
    const last = merged[merged.length - 1];
    if (last && x.end - x.start < 2 * heard.barTicks) last.end = x.end;
    else merged.push({ ...x });
  }
  if (merged.length > 1 && merged[0].end - merged[0].start < 2 * heard.barTicks) {
    merged[1].start = merged[0].start;
    merged.shift();
  }
  merged.forEach((x, i) => (x.name = `Section ${i + 1}`));
  return merged;
}

/** Mean loudness (power average of the per-second energy curve) of song ticks [start, end). */
export function rangeLoudness(curve: readonly number[] | undefined, bpm: number, rangeStart: number, start: number, end: number): number | null {
  if (!curve?.length) return null;
  let a = ticksToSeconds(start - rangeStart, bpm);
  const b = ticksToSeconds(end - rangeStart, bpm);
  // Short-term loudness trails by ~3 s: skip the first 1.5 s of a long section.
  if (b - a >= 6) a += 1.5;
  const vals: number[] = [];
  for (let i = Math.max(0, Math.floor(a)); i < Math.min(curve.length, Math.ceil(b)); i++) {
    const v = curve[i];
    if (Number.isFinite(v) && v > -70) vals.push(v);
  }
  if (!vals.length) return null;
  return r1(10 * Math.log10(vals.reduce((s, v) => s + Math.pow(10, v / 10), 0) / vals.length));
}

// ── Helpers over the project ────────────────────────────────────────────

const fmtBar = (tick: number, barTicks: number, rangeStart = 0): number => Math.floor((tick - rangeStart) / barTicks) + 1;

function barsLabel(s: { start: number; end: number }, barTicks: number): string {
  const a = Math.floor(s.start / barTicks) + 1;
  const b = Math.ceil(s.end / barTicks);
  return a === b ? `${a}` : `${a}-${b}`;
}

function isDefaultParams(catalog: PluginCatalog, ch: Channel): boolean {
  const desc = catalog.plugins.find((x) => x.id === ch.generator.type);
  return Object.entries(ch.generator.params).every(([k, v]) => {
    const spec = desc?.params.find((s) => s.id === k);
    return spec ? Math.abs(spec.default - v) < 1e-6 : false;
  });
}

function channelByName(p: Project, name: string): Channel | null {
  const k = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = p.channelOrder.find((c) => p.channels[c].name.toLowerCase().replace(/[^a-z0-9]/g, '') === k);
  return id ? p.channels[id] : null;
}

function channelByRole(p: Project, role: string, heard: Heard): Channel | null {
  const ids = p.channelOrder.filter((c) => roleFromName(p.channels[c].name) === role);
  return p.channels[ids.find((c) => heard.channels.has(c)) ?? ids[0] ?? ''] ?? null;
}

/** The insert a channel plays through and the buses that insert routes into (one level). */
function insertPath(p: Project, ch: Channel): MixerInsert[] {
  const ins = p.mixer.inserts[ch.insertId];
  if (!ins) return [];
  const out = [ins];
  for (const to of Object.keys(ins.routes)) {
    const bus = p.mixer.inserts[to];
    if (bus && !bus.isMaster) out.push(bus);
  }
  return out;
}

function hasSidechain(p: Project, ch: Channel): boolean {
  return insertPath(p, ch).some((ins) => ins.slotOrder.some((s) => ins.slots[s]?.enabled && !!ins.slots[s].sidechainFrom));
}

function topPattern(p: Project, entry: { patterns: Map<string, number> } | undefined): string | null {
  if (!entry) return null;
  const best = [...entry.patterns.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && p.patterns[best[0]] ? p.patterns[best[0]].name : null;
}

function instrumentPresets(presets: readonly Preset[]): InstrumentPreset[] {
  return presets.filter((x): x is InstrumentPreset => x.kind === 'instrument');
}

function masterFx(p: Project, catalog: PluginCatalog) {
  const m = p.mixer.inserts[p.mixer.masterId];
  const slots = m ? m.slotOrder.map((s) => m.slots[s]).filter((s) => s?.enabled) : [];
  const limiter = slots.find((s) => s.type === 'krypt.limiter');
  const clipper = slots.find((s) => s.type === 'krypt.clipper');
  const desc = limiter ? catalog.plugins.find((x) => x.id === 'krypt.limiter') : undefined;
  // New projects set the ceiling to -1 dB (shared/schema/factory.ts); that still counts as the untouched default.
  const NEW_PROJECT: Record<string, number> = { ceiling: -1 };
  const limiterDefault = !!limiter && Object.entries(limiter.params).every(([k, v]) => {
    const spec = desc?.params.find((s) => s.id === k);
    if (k in NEW_PROJECT && Math.abs(NEW_PROJECT[k] - v) < 1e-6) return true;
    return spec ? Math.abs(spec.default - v) < 1e-6 : true;
  });
  return {
    slots,
    limiter,
    hasLimiter: !!limiter || !!clipper,
    /** Only the default limiter at its default settings: no master chain was ever loaded. */
    bare: slots.length === 0 || (slots.length === 1 && !!limiter && limiterDefault),
    inputGain: limiter ? (limiter.params.inputGain ?? desc?.params.find((s) => s.id === 'inputGain')?.default ?? 0) : 0,
  };
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

// ── The review ──────────────────────────────────────────────────────────

interface Ctx extends ReviewInput {
  heard: Heard;
  sections: ReviewSection[];
  barTicks: number;
  bpm: number;
  masterChain: string | null;
  issues: ReviewIssue[];
  works: Array<{ order: number; text: string }>;
  skipped: string[];
}

function issue(ctx: Ctx, x: ReviewIssue): void {
  ctx.issues.push(x);
}

function good(ctx: Ctx, order: number, text: string): void {
  ctx.works.push({ order, text });
}

const BAND_FIX: Record<string, { high: string; low: string; word: string }> = {
  sub: { word: 'sub (<60 Hz)', high: 'lower the 808 / sub / kick 2-3 dB (set_mixer volume_db), or high-pass the master at 30 Hz', low: 'raise the kick / 808 / sub, or pick a deeper bass preset (load_preset)' },
  low: { word: 'low (60-250 Hz)', high: 'low-cut every non-bass part at 150 Hz: add_effect {"insert":"<pad/keys/chords>","effect":"eq","params":{"b1On":"On","b1Freq":"150Hz"}}', low: 'raise the bass and kick, or give the bass more body' },
  lowMid: { word: 'low mids (250-500 Hz)', high: 'cut the mud: add_effect {"insert":"<pad/keys/chords>","effect":"eq","params":{"b3Freq":"300Hz","b3Gain":"-3dB"}}', low: 'add body: raise the chords / keys a little' },
  highMid: { word: 'high mids (2-6 kHz)', high: 'tame the harsh range: add_effect {"insert":"<lead/clap>","effect":"eq","params":{"b5Freq":"3.5kHz","b5Gain":"-2dB"}}, or lower the lead', low: 'bring the lead / clap forward, or brighten them (EQ +2 dB at 3 kHz)' },
  high: { word: 'highs (6-20 kHz)', high: 'lower the hats, or shelf the master top down: add_effect {"insert":"Master","effect":"eq","params":{"b6Gain":"-2dB"}}', low: 'add air: raise the hats, or add_effect {"insert":"Master","effect":"eq","params":{"b6Gain":"+2dB"}}' },
};

function checkLoudness(ctx: Ctx): void {
  const a = ctx.analysis;
  const t = ctx.targets;
  if (!a) {
    ctx.skipped.push('loudness and band balance (this render has no LUFS / spectrum analysis)');
    return;
  }
  const L = a.lufsIntegrated;
  if (!Number.isFinite(L) || L < -60) {
    issue(ctx, { check: 'silent', area: 'mix', severity: 'high', problem: 'The render is silent: nothing audible plays (muted tracks or channels, or no clips in range).', fix: 'get_project, unmute what should play (set_channel {"mute":false}), arrange the patterns, then review_song again', order: 1 });
    return;
  }
  const m = masterFx(ctx.project, ctx.catalog);
  const d = L - t.lufs;
  if (Math.abs(d) <= 1.5) {
    good(ctx, 10, `Loudness on target: ${r1(L)} LUFS (target ${t.lufs}).`);
    return;
  }
  if (d < 0) {
    const fix = m.limiter
      ? `set_effect ${j({ insert: 'Master', effect: 'limiter', params: { inputGain: `${Math.min(24, Math.round((m.inputGain - d) * 2) / 2)}dB`, ceiling: `${t.truePeakDb}dB` } })}${m.bare && ctx.masterChain ? ` (better: apply_chain ${j({ chain: ctx.masterChain, insert: 'master' })})` : ''}`
      : ctx.masterChain
        ? `apply_chain ${j({ chain: ctx.masterChain, insert: 'master' })}`
        : `add_effect ${j({ insert: 'Master', effect: 'limiter', params: { inputGain: `${Math.round(-d)}dB`, ceiling: `${t.truePeakDb}dB` } })}`;
    issue(ctx, { check: 'lufs', area: 'mix', severity: d < -4 ? 'high' : 'medium', problem: `Too quiet: ${r1(L)} LUFS integrated vs the ${t.lufs} LUFS target (${r1(-d)} LU under).`, fix, order: 10 });
  } else {
    issue(ctx, {
      check: 'lufs',
      area: 'mix',
      severity: d > 3 ? 'high' : 'medium',
      problem: `Too loud: ${r1(L)} LUFS integrated vs the ${t.lufs} LUFS target (${r1(d)} LU over): squashed and fatiguing.`,
      fix: m.limiter ? `set_effect ${j({ insert: 'Master', effect: 'limiter', params: { inputGain: `${Math.max(0, Math.round((m.inputGain - d) * 2) / 2)}dB` } })}` : 'lower the loudest inserts with set_mixer volume_db',
      order: 10,
    });
  }
}

function checkPeaks(ctx: Ctx): void {
  const a = ctx.analysis;
  const tp = a ? a.truePeakDb : (ctx.measured?.peakDb ?? null);
  if (tp === null || !Number.isFinite(tp)) return;
  const limit = ctx.targets.truePeakDb;
  const clipping = !!a?.clipping;
  if (tp > limit + 0.3 || clipping) {
    issue(ctx, {
      check: 'peaks',
      area: 'mix',
      severity: tp > 0 || clipping ? 'high' : 'medium',
      problem: `${clipping ? 'Clipping, and t' : 'T'}rue peak ${r1(tp)} dB${a ? 'TP' : 'FS (sample peak)'} over the ${limit} dBTP ceiling: distortion on playback and on streaming.`,
      fix: `set_effect ${j({ insert: 'Master', effect: 'limiter', params: { ceiling: `${limit}dB`, truePeak: 'On' } })}${masterFx(ctx.project, ctx.catalog).limiter ? '' : ` (no limiter yet: add_effect ${j({ insert: 'Master', effect: 'limiter', params: { ceiling: `${limit}dB` } })})`}`,
      order: 11,
    });
  } else good(ctx, 15, `Peaks safe: true peak ${r1(tp)} dBTP.`);
}

function checkBands(ctx: Ctx): void {
  const a = ctx.analysis;
  const want = ctx.targets.bands;
  if (!a || !want || !Number.isFinite(a.bands.mid) || a.lufsIntegrated < -60) return;
  const outs: Array<{ k: string; rel: number; dev: number; dir: 'high' | 'low'; range: [number, number] }> = [];
  for (const [k, range] of Object.entries(want) as Array<[keyof typeof a.bands, [number, number] | undefined]>) {
    if (!range) continue;
    const v = a.bands[k];
    if (!Number.isFinite(v)) continue;
    const rel = v - a.bands.mid;
    if (rel > range[1]) outs.push({ k, rel, dev: rel - range[1], dir: 'high', range });
    else if (rel < range[0]) outs.push({ k, rel, dev: range[0] - rel, dir: 'low', range });
  }
  if (!outs.length) {
    good(ctx, 12, 'Tonal balance inside the genre\'s ranges in every band.');
    return;
  }
  outs.sort((x, y) => y.dev - x.dev);
  const worst = outs[0].dev;
  issue(ctx, {
    check: 'bands',
    area: 'mix',
    severity: worst > 8 ? 'high' : worst > 3 ? 'medium' : 'low',
    problem: `Tonal balance off: ${outs.map((o) => `${BAND_FIX[o.k]?.word ?? o.k} ${sgn(o.rel)} dB vs the mids (target ${o.range[0]}..${o.range[1]}): too ${o.dir === 'high' ? 'much' : 'little'}`).join('; ')}.`,
    fix: outs
      .slice(0, 2)
      .map((o) => BAND_FIX[o.k]?.[o.dir] ?? 'adjust the parts in that band')
      .join(' · '),
    order: 12,
  });
}

function checkStereo(ctx: Ctx): void {
  const c = ctx.analysis ? ctx.analysis.stereoCorrelation : (ctx.measured?.correlation ?? null);
  if (c === null || !Number.isFinite(c)) return;
  const min = ctx.targets.minCorrelation ?? 0;
  if (c < Math.max(min, 0)) {
    const wide = ctx.project.mixer.insertOrder.map((id) => ctx.project.mixer.inserts[id]).filter((i) => !i.isMaster && i.stereoSep > 0.3);
    issue(ctx, {
      check: 'stereo',
      area: 'mix',
      severity: c < 0 ? 'high' : 'medium',
      problem: `Stereo correlation ${r1(c)} (want >= ${min}): ${c < 0 ? 'parts cancel in mono (phone speakers, clubs)' : 'too wide to be mono-safe'}.`,
      fix: wide.length ? `set_mixer ${j({ updates: wide.slice(0, 4).map((i) => ({ insert: i.name, stereo_sep: 0 })) })}` : 'narrow the widest parts (set_mixer stereo_sep 0, less chorus / stereo delay), keep kick, bass and lead centred',
      order: 13,
    });
  } else good(ctx, 16, `Mono-safe stereo image (correlation ${r1(c)}).`);
}

function checkMaster(ctx: Ctx): void {
  const m = masterFx(ctx.project, ctx.catalog);
  const chain = ctx.masterChain ? `apply_chain ${j({ chain: ctx.masterChain, insert: 'master' })}` : `add_effect ${j({ insert: 'Master', effect: 'eq' })} · add_effect ${j({ insert: 'Master', effect: 'comp', params: { ratio: 2, threshold: '-12dB' } })} · set_effect ${j({ insert: 'Master', effect: 'limiter', params: { ceiling: '-1dB' } })}`;
  if (!m.hasLimiter) {
    issue(ctx, { check: 'master', area: 'mix', severity: 'high', problem: 'No limiter on the master: nothing holds the peaks or sets the loudness.', fix: chain, order: 14 });
  } else if (m.bare) {
    issue(ctx, { check: 'master', area: 'mix', severity: 'medium', problem: 'The master is the bare default limiter (no master chain: no tone, glue or loudness for the genre).', fix: chain, order: 14 });
  } else good(ctx, 11, `Master chain in place (${m.slots.map((s) => ctx.catalog.plugins.find((x) => x.id === s.type)?.name.replace(/^Krypt /, '') ?? s.type).join(' → ')}).`);
}

function checkSidechain(ctx: Ctx): void {
  const pb = ctx.playbook;
  if (!pb) return;
  const missing: Array<{ target: Channel; source: Channel; role: string }> = [];
  const ok: string[] = [];
  for (const part of pb.parts) {
    if (!part.duckUnder) continue;
    const target = channelByName(ctx.project, part.name) ?? channelByRole(ctx.project, part.role, ctx.heard);
    const srcPart = pb.parts.find((x) => x.name === part.duckUnder);
    const source = channelByName(ctx.project, part.duckUnder) ?? (srcPart ? channelByRole(ctx.project, srcPart.role, ctx.heard) : null);
    if (!target || !source || target.id === source.id || !ctx.heard.channels.has(target.id) || !ctx.heard.channels.has(source.id)) continue;
    if (hasSidechain(ctx.project, target)) ok.push(target.name);
    else missing.push({ target, source, role: part.role });
  }
  if (missing.length) {
    issue(ctx, {
      check: 'sidechain',
      area: 'mix',
      severity: missing.some((x) => ['bass', '808', 'sub'].includes(x.role)) ? 'high' : 'medium',
      problem: `Not sidechained though the playbook ducks them: ${missing.map((x) => `${x.target.name} under ${x.source.name}`).join(', ')} (the low end and the kick fight).`,
      fix: missing.map((x) => `sidechain ${j({ source: x.source.name, target: x.target.name })}`).join(' · '),
      order: 15,
    });
  } else if (ok.length) good(ctx, 13, `Sidechain in place: ${ok.join(', ')} duck under the kick.`);
}

function checkSections(ctx: Ctx): void {
  if (!ctx.wholeSong) return;
  const marked = ctx.sections.filter((s) => s.source === 'marker');
  if (!marked.length) {
    const fix = ctx.sections.length ? `add_marker ${j({ markers: ctx.sections.slice(0, 12).map((s, i) => ({ at: fmtBar(s.start, ctx.barTicks), name: i === 0 ? 'Intro' : `Section ${i + 1}` })) })} (name them: Intro, Verse, Drop …)` : 'add_marker for each section';
    issue(ctx, { check: 'markers', area: 'arrangement', severity: 'low', problem: `No section markers: ${ctx.sections.length} sections inferred from where parts change.`, fix, order: 29 });
  } else good(ctx, 24, `${marked.length} marked sections: ${marked.slice(0, 8).map((s) => `${s.name} ${barsLabel(s, ctx.barTicks)}`).join(', ')}.`);
}

function checkLength(ctx: Ctx): void {
  if (!ctx.wholeSong) return;
  const bars = Math.round((ctx.range.end - ctx.range.start) / ctx.barTicks);
  const [min, max] = ctx.targets.bars;
  if (bars < min) {
    issue(ctx, {
      check: 'length',
      area: 'arrangement',
      severity: bars < min * 0.6 ? 'high' : 'medium',
      problem: `Only ${bars} bars: a sketch, not a finished song (target ${min}-${max} bars).`,
      fix: 'extend the arrangement: a second verse / hook, a break and a final drop, then an outro (create_pattern {clone_from} for variations, arrange, add_marker, add_transition at the new boundaries)',
      order: 20,
    });
  } else if (bars > max) issue(ctx, { check: 'length', area: 'arrangement', severity: 'low', problem: `${bars} bars is long for the genre (target ${min}-${max}).`, fix: 'cut a repeated section: remove_clips {"bars":"<a-b>","close_gap":true}', order: 20 });
  else good(ctx, 25, `Length ${bars} bars (target ${min}-${max}).`);
}

function checkPhrases(ctx: Ctx): void {
  // A studied reference's own section lengths are the plan (build_from_reference copies them): not a fault here.
  const refBars = (ctx.closeness?.reference.brief.plan ?? []).map((x) => x.bars);
  const odd = ctx.sections.filter((s) => {
    const bars = (s.end - s.start) / ctx.barTicks;
    if (refBars.some((rb) => Math.abs(rb - bars) <= 1)) return false;
    return bars >= 1 && Math.abs(bars / 4 - Math.round(bars / 4)) > 1e-6;
  });
  if (!odd.length) return;
  const marked = odd.some((s) => s.source === 'marker');
  issue(ctx, {
    check: 'phrases',
    area: 'arrangement',
    severity: marked ? 'medium' : 'low',
    bars: odd.map((s) => barsLabel(s, ctx.barTicks)).join(', '),
    problem: `Phrase lengths not a multiple of 4 bars: ${odd.map((s) => `${s.name || 'section'} (${r1((s.end - s.start) / ctx.barTicks)} bars)`).join(', ')}. Listeners expect 4 / 8 / 16-bar phrases.`,
    fix: 'make each section 4, 8 or 16 bars: restructure_song {"op":"insert_bars","at":<bar>,"bars":<n>} or remove_clips {"bars":"<a-b>","close_gap":true}, then move the marker',
    order: 22,
  });
}

function expectedEnergy(ctx: Ctx, s: ReviewSection): number | null {
  const pb = ctx.playbook;
  if (pb) {
    const byLabel = pb.arrangement.find((x) => x.label.toLowerCase() === s.name.toLowerCase());
    if (byLabel) return byLabel.energy;
    if (s.kind) {
      const byKind = pb.arrangement.find((x) => x.kind === s.kind);
      if (byKind) return byKind.energy;
    }
  }
  return s.kind ? KIND_ENERGY[s.kind] : null;
}

function checkEnergy(ctx: Ctx): void {
  const curve = ctx.analysis?.energyCurve;
  if (!curve?.length) {
    if (ctx.analysis) ctx.skipped.push('energy contrast (the render has no energy curve)');
    return;
  }
  for (const s of ctx.sections) s.lufs = rangeLoudness(curve, ctx.bpm, ctx.range.start, s.start, s.end);
  const measured = ctx.sections.filter((s) => s.lufs !== null && s.lufs !== undefined && s.end - s.start >= 4 * ctx.barTicks);
  if (measured.length < 2) return;
  const loud = measured.reduce((a, b) => (b.lufs! > a.lufs! ? b : a));
  const quiet = measured.reduce((a, b) => (b.lufs! < a.lufs! ? b : a));
  const contrast = r1(loud.lufs! - quiet.lufs!);
  const [min, max] = ctx.targets.contrastLu ?? GENERIC_TARGETS.contrastLu!;
  const thin = quiet.name || 'the quietest section';
  if (contrast < min) {
    issue(ctx, {
      check: 'contrast',
      area: 'arrangement',
      severity: contrast < min / 2 ? 'high' : 'medium',
      problem:
        contrast < 0.5
          ? `Flat energy: every section sits at about ${quiet.lufs} LUFS (target ${min}-${max} LU between the quietest and the loudest). Nothing builds or lands.`
          : `Flat energy: only ${contrast} LU between the loudest (${loud.name || barsLabel(loud, ctx.barTicks)}) and quietest (${quiet.name || barsLabel(quiet, ctx.barTicks)}) sections (target ${min}-${max} LU). Nothing builds or lands.`,
      fix: `thin the intro / breaks (drums and bass out: a pattern variant without them, arranged over ${barsLabel(quiet, ctx.barTicks)}) and fill the drops (an extra layer, the lead an octave up); or add_automation a volume / filter move across the build`,
      order: 23,
    });
  } else if (contrast > max) {
    issue(ctx, { check: 'contrast', area: 'arrangement', severity: 'low', problem: `Energy jumps ${contrast} LU between sections (target at most ${max}): ${thin} may sound empty.`, fix: `add a quiet layer (pad, texture) to ${thin} or lower the loudest section a little`, order: 23 });
  } else good(ctx, 20, `Clear energy contrast: ${contrast} LU between ${quiet.name || 'the quietest'} and ${loud.name || 'the loudest'} section.`);

  // The planned shape: a section the plan wants clearly bigger must measure louder.
  const known = measured.map((s) => ({ s, e: expectedEnergy(ctx, s) })).filter((x): x is { s: ReviewSection; e: number } => x.e !== null);
  let worst: { hi: ReviewSection; lo: ReviewSection; diff: number } | null = null;
  for (const a of known) {
    for (const b of known) {
      if (a.e - b.e < 0.3) continue;
      const diff = a.s.lufs! - b.s.lufs!;
      if (diff < 1 && (!worst || diff < worst.diff)) worst = { hi: a.s, lo: b.s, diff };
    }
  }
  // A flat song already has the contrast issue; the shape issue adds news only when the plan is inverted.
  if (worst && (contrast >= min || worst.diff < -1)) {
    issue(ctx, {
      check: 'shape',
      area: 'arrangement',
      severity: worst.diff < -1 ? 'high' : 'medium',
      bars: `${barsLabel(worst.hi, ctx.barTicks)} vs ${barsLabel(worst.lo, ctx.barTicks)}`,
      problem: `${worst.hi.name} (bars ${barsLabel(worst.hi, ctx.barTicks)}) is ${worst.diff < 0 ? `${r1(-worst.diff)} LU quieter than` : 'barely louder than'} ${worst.lo.name} (bars ${barsLabel(worst.lo, ctx.barTicks)}); the plan wants it clearly bigger.`,
      fix: `strip ${worst.lo.name} (fewer parts, no kick / bass) and make ${worst.hi.name} fuller (all drums, bass, a wider chord layer); then review_song`,
      order: 24,
    });
  }
}

// ── Against the reference song ──────────────────────────────────────────

const REF_GROUP_FIX: Record<string, { under: string; over: string }> = {
  'low end': { under: 'raise the kick / 808 / bass 2-3 dB (set_mixer volume_db) or load a deeper bass preset', over: 'lower the kick / 808 / bass 2-3 dB, and low-cut the non-bass parts at 150 Hz (add_effect eq b1)' },
  mids: { under: 'bring the chords / keys / lead up 2 dB, or cut less around 300 Hz-1 kHz', over: 'cut 300-800 Hz on pads and keys (add_effect eq, -3 dB), or lower the busiest mid part' },
  highs: { under: 'brighten the hats and the master top: add_effect {"insert":"Master","effect":"eq","params":{"b6Gain":"+2dB"}}, or raise the hats', over: 'tame the hats / bright synths: add_effect {"insert":"Master","effect":"eq","params":{"b6Gain":"-2dB"}}, or lower the hats' },
};

/** Tonal balance, width and energy shape against the reference (loudness is already the target). */
function checkReference(ctx: Ctx): void {
  const ref = ctx.reference;
  if (!ref) return;
  const c = ref.comparison;
  const name = `"${ref.name.slice(0, 60)}"`;
  const g = c.bands.groups;
  if (g) {
    let close = true;
    for (const [group, d] of Object.entries(g)) {
      if (Math.abs(d) < 3) continue;
      close = false;
      const fix = REF_GROUP_FIX[group];
      issue(ctx, {
        check: 'ref-balance',
        area: 'mix',
        severity: Math.abs(d) >= 6 ? 'medium' : 'low',
        problem: `Your ${group} ${d < 0 ? `sit ${r1(-d)} dB under` : `sit ${r1(d)} dB over`} the reference ${name} (each mix relative to its own overall level).`,
        fix: fix ? (d < 0 ? fix.under : fix.over) : 'adjust the parts in that range with EQ or levels',
        order: 6,
      });
    }
    if (close) good(ctx, 6, `Tonal balance within 3 dB of the reference ${name} in the lows, mids and highs.`);
  }
  const w = c.width.diff;
  if (w !== null && w <= -0.12) issue(ctx, { check: 'ref-width', area: 'mix', severity: 'low', problem: `Narrower than the reference ${name} (width ${c.width.project} vs ${c.width.reference}).`, fix: 'widen pads, chords and the lead (stereo separation, chorus, a reverb send); keep the kick and bass centred', order: 9 });
  else if (w !== null && w >= 0.15) issue(ctx, { check: 'ref-width', area: 'mix', severity: 'low', problem: `Wider than the reference ${name} (width ${c.width.project} vs ${c.width.reference}): check it in mono.`, fix: 'narrow the widest parts a little (stereo separation toward 0, less chorus on the pads)', order: 9 });
  const corr = c.energy.correlation;
  if (!c.energy.partial && corr !== null) {
    if (corr < 0.35) {
      issue(ctx, {
        check: 'ref-shape',
        area: 'arrangement',
        severity: corr < 0 ? 'high' : 'medium',
        problem: `The energy over time doesn't follow the reference ${name} (shape correlation ${corr}; 1 = the same rise and fall).`,
        fix: "lay the sections out like get_playbook's plan (it follows the reference): thin the quiet sections (fewer parts, no kick / bass), fill the peaks, then review_song",
        order: 25,
      });
    } else if (corr >= 0.6) good(ctx, 21, `The energy rises and falls like the reference ${name} (shape correlation ${corr}).`);
  }
}

// ── Closeness to the reference ──────────────────────────────────────────

/** Where each closeness gap lands in the ranking: the musical identity (tempo, key, groove, chords) before the mix. */
const CLOSENESS_ISSUE: Record<ClosenessDimId, { order: number; area: Area; word: string }> = {
  tempo: { order: 2, area: 'reference', word: 'Tempo' },
  key: { order: 4, area: 'reference', word: 'Key' },
  groove: { order: 5, area: 'reference', word: 'Drum groove' },
  harmony: { order: 7, area: 'reference', word: 'Chord progression' },
  arrangement: { order: 8, area: 'arrangement', word: 'Arrangement' },
  sounds: { order: 9, area: 'sound', word: 'Sounds' },
  mix: { order: 9.5, area: 'mix', word: 'Mix balance' },
};

/**
 * The closeness score against the studied reference, and its biggest gaps as issues (tool-call fixes). The tonal
 * balance, width, loudness and energy shape already have their own reference checks (checkReference / the
 * reference's loudness target), so the mix gap only becomes an issue for the per-part balance.
 */
function checkCloseness(ctx: Ctx): Closeness | null {
  const c = ctx.closeness;
  if (!c) return null;
  const out = computeCloseness({
    project: ctx.project,
    range: ctx.range,
    sections: ctx.sections,
    projectKey: ctx.symbolic?.key.given ?? ctx.symbolic?.key.estimated ?? null,
    render: ctx.analysis,
    ...c,
  });
  const name = `"${c.reference.brief.name.slice(0, 60)}"`;
  for (const d of out.dims) {
    if (d.score === null || !d.fix || d.score >= 90) continue;
    const meta = CLOSENESS_ISSUE[d.id];
    let problem = `${meta.word} ${d.score}/100 close to the reference ${name}: yours ${d.measured || '?'}; the reference ${d.reference || '?'}.`;
    if (d.id === 'mix') {
      const bal = (d.detail?.balance ?? null) as Record<string, number> | null;
      const off = bal ? Object.entries(bal).filter(([, x]) => Math.abs(x) >= 2) : [];
      if (!off.length) continue;
      problem = `Part balance off against the reference ${name}: ${off.map(([g, x]) => `${g} ${x > 0 ? `${r1(x)} dB too loud` : `${r1(-x)} dB too quiet`}`).join(', ')} (each part against the rest of its mix; mix closeness ${d.score}/100).`;
    }
    const heavy = d.id === 'tempo' || d.id === 'groove' || d.id === 'harmony';
    issue(ctx, {
      check: `closeness-${d.id}`,
      area: meta.area,
      severity: d.score < 50 && heavy ? 'high' : d.score < 75 ? 'medium' : 'low',
      problem,
      fix: d.fix,
      order: meta.order,
    });
  }
  if (out.overall !== null && out.overall >= 80) good(ctx, 5, `Close to the reference ${name}: ${out.overall}/100.`);
  return out;
}

/** Runs of bars where the same content repeats (period 1, 2, 4 or 8 bars) for longer than `maxBars`. */
export function staticRuns(bars: readonly BarInfo[], maxBars: number): Array<{ start: number; end: number; period: number }> {
  const spans: Array<{ start: number; end: number; period: number }> = [];
  for (const P of [1, 2, 4, 8]) {
    let a = -1;
    for (let i = P; i <= bars.length; i++) {
      const eq = i < bars.length && bars[i].sig !== '' && bars[i].sig === bars[i - P].sig;
      if (eq && a < 0) a = i;
      if (!eq && a >= 0) {
        const span = { start: a - P, end: i, period: P };
        if (span.end - span.start > maxBars) spans.push(span);
        a = -1;
      }
    }
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  const merged: typeof spans = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else merged.push({ ...s });
  }
  return merged;
}

function checkStatic(ctx: Ctx): void {
  const limit = ctx.targets.maxStaticBars ?? GENERIC_TARGETS.maxStaticBars!;
  const runs = staticRuns(ctx.heard.bars, limit);
  const first = fmtBar(ctx.range.start, ctx.barTicks);
  if (!runs.length) {
    good(ctx, 22, `No section loops unchanged for more than ${limit} bars.`);
    return;
  }
  const longest = Math.max(...runs.map((r) => r.end - r.start));
  const label = (r: { start: number; end: number }) => `${first + r.start}-${first + r.end - 1}`;
  const pats = new Set<string>();
  for (const r of runs.slice(0, 2)) {
    const t = ctx.range.start + r.start * ctx.barTicks;
    for (const c of ctx.heard.clips) if (c.kind === 'pattern' && c.patternId && c.start <= t && c.start + c.length > t) pats.add(ctx.project.patterns[c.patternId]?.name ?? '');
  }
  const pat = [...pats].filter(Boolean)[0] ?? '<pattern>';
  const r0 = runs[0];
  issue(ctx, {
    check: 'static',
    area: 'arrangement',
    severity: longest >= 2 * limit ? 'high' : 'medium',
    bars: runs.slice(0, 3).map(label).join(', '),
    problem: `Static: ${runs
      .slice(0, 3)
      .map((r) => `bars ${label(r)} repeat the same ${r.period === 1 ? 'bar' : `${r.period} bars`} for ${r.end - r.start} bars`)
      .join('; ')} (limit ${limit}). It sounds like a loop, not a song.`,
    fix: `create_pattern ${j({ name: `${pat} B`, clone_from: pat })} + write_pattern {"mode":"merge"} with a variation (hats, a fill, a counter-line), then arrange ${j({ placements: [{ pattern: `${pat} B`, bars: `${first + r0.start + Math.min(limit, r0.end - r0.start) - Math.min(limit, 8)}-${first + r0.start + Math.min(limit, r0.end - r0.start) - 1}` }], clear_first: true })}; or add_automation a filter / volume move over bars ${label(r0)}`,
    order: 21,
  });
}

const FX_WORDS = /(fx|riser|uplift|downlift|impact|sweep|crash|cymbal|reverse|\brev\b|sub ?drop|boom|whoosh|noise|fill|roll|transition|swell|hit)/i;

/** Which transition element sits in the bar before (or on the downbeat of) a boundary, or null. */
export function transitionAt(p: Project, heard: Heard, boundary: number): string | null {
  const bar = heard.barTicks;
  const step = PPQ / 4;
  const winStart = boundary - bar;
  for (const c of heard.clips) {
    const end = c.start + c.length;
    if (c.kind === 'audio') {
      const ch = c.channelId ? p.channels[c.channelId] : undefined;
      const s = ch?.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
      const words = `${ch?.name ?? ''} ${p.playlist.tracks[c.trackId]?.name ?? ''} ${s?.name ?? ''} ${s?.path ?? ''}`;
      const near = (c.start >= winStart && c.start <= boundary + step) || (end >= boundary - bar / 4 && end <= boundary + bar / 4);
      if (near && FX_WORDS.test(words)) return `FX audio "${ch?.name ?? 'audio'}"`;
    } else if (c.kind === 'automation') {
      const touches = (end > winStart && end <= boundary + bar) || (c.start >= winStart && c.start <= boundary);
      if (touches) return 'automation';
    } else if (c.kind === 'pattern') {
      const name = c.patternId ? (p.patterns[c.patternId]?.name ?? '') : '';
      if (c.start < boundary && end > winStart && /(fill|roll|build|riser|transition|crash|sweep)/i.test(name)) return `pattern "${name}"`;
    }
  }
  // A crash (or cymbal) on the downbeat.
  for (const [chId, e] of heard.channels) {
    const ch = p.channels[chId];
    const s = ch?.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
    if (!/(crash|cymbal)/i.test(`${ch?.name ?? ''} ${s?.name ?? ''}`)) continue;
    if (e.ticks.some((t) => Math.abs(t - boundary) <= step / 2)) return `crash on "${ch.name}"`;
  }
  const bi = Math.floor((boundary - heard.start) / bar) - 1;
  const before = heard.bars[bi];
  const prev = heard.bars[bi - 1];
  // A drum fill: the last bar's drums differ from the groove before it.
  if (before && prev && before.drumSig && prev.drumSig && before.drumSig !== prev.drumSig) return 'drum variation';
  // A drop-out: the last beat is empty while the bar played.
  if (before && before.notes > 0 && before.lastBeatNotes === 0 && before.audio === 0) return 'drop-out';
  return null;
}

function defaultTransition(kind: SectionKind | null, energy: number | null): TransitionKind[] {
  if (kind === 'drop' || kind === 'hook' || kind === 'chorus' || (energy !== null && energy >= 0.8)) return ['riser', 'impact'];
  if (kind === 'break' || kind === 'breakdown' || kind === 'outro' || kind === 'bridge') return ['downlifter'];
  return ['drum-fill', 'crash'];
}

function checkTransitions(ctx: Ctx): void {
  if (ctx.sections.length < 2) return;
  const missing: Array<{ s: ReviewSection; prev: ReviewSection }> = [];
  for (let i = 1; i < ctx.sections.length; i++) {
    const s = ctx.sections[i];
    if (!transitionAt(ctx.project, ctx.heard, s.start)) missing.push({ s, prev: ctx.sections[i - 1] });
  }
  if (!missing.length) {
    good(ctx, 21, 'Every section change has a transition (FX, fill, automation or crash).');
    return;
  }
  const big = missing.some((m) => {
    const e = expectedEnergy(ctx, m.s);
    return m.s.kind === 'drop' || m.s.kind === 'hook' || m.s.kind === 'chorus' || (e !== null && e >= 0.8);
  });
  const calls = new Map<string, { kind: string; at_bars: number[]; length_bars?: number }>();
  for (const m of missing) {
    const planned = ctx.playbook?.arrangement.find((x) => x.label.toLowerCase() === m.s.name.toLowerCase() || (m.s.kind && x.kind === m.s.kind))?.transitionIn;
    const kinds = planned?.length ? planned : defaultTransition(m.s.kind, expectedEnergy(ctx, m.s));
    const prevBars = Math.round((m.prev.end - m.prev.start) / ctx.barTicks);
    for (const kind of kinds.slice(0, 2)) {
      const len = kind === 'riser' || kind === 'filter-sweep' ? Math.max(1, Math.min(8, prevBars)) : kind === 'snare-roll' ? Math.max(1, Math.min(4, prevBars)) : undefined;
      const key = `${kind}|${len ?? ''}`;
      const call = calls.get(key) ?? { kind, at_bars: [], ...(len !== undefined ? { length_bars: len } : {}) };
      call.at_bars.push(fmtBar(m.s.start, ctx.barTicks));
      calls.set(key, call);
    }
  }
  issue(ctx, {
    check: 'transitions',
    area: 'arrangement',
    severity: big || missing.length * 2 >= ctx.sections.length - 1 ? 'high' : 'medium',
    bars: missing.map((m) => `${fmtBar(m.s.start, ctx.barTicks)}`).join(', '),
    problem: `No transition into ${missing.map((m) => `${m.s.name || 'a section'} (bar ${fmtBar(m.s.start, ctx.barTicks)})`).join(', ')}: no riser, fill, sweep, automation or crash in the bar before or on the downbeat, so the sections just switch.`,
    fix: [...calls.values()].map((c) => `add_transition ${j(c)}`).join(' · '),
    order: 25,
  });
}

function checkIntroEnding(ctx: Ctx): void {
  if (!ctx.wholeSong) return;
  const bars = ctx.heard.bars;
  const first = bars.findIndex((b) => b.notes > 0 || b.audio > 0);
  if (first > 0) {
    issue(ctx, {
      check: 'intro',
      area: 'arrangement',
      severity: first >= 2 ? 'medium' : 'low',
      bars: `1-${first}`,
      problem: `The song opens with ${first} silent bar${first === 1 ? '' : 's'}.`,
      fix: `remove_clips ${j({ bars: `1-${first}`, close_gap: true })} (or start the intro at bar 1)`,
      order: 26,
    });
  }
  const last = ctx.sections[ctx.sections.length - 1];
  if (!last || last.kind === 'outro') return;
  const loudest = Math.max(...ctx.sections.map((s) => (typeof s.lufs === 'number' ? s.lufs : -99)));
  const lastBar = bars[bars.length - 1];
  const maxCh = Math.max(1, ...bars.map((b) => b.channels.size));
  const abrupt = typeof last.lufs === 'number' && loudest > -99 ? last.lufs >= loudest - 2 : !!lastBar && lastBar.channels.size >= 0.75 * maxCh && lastBar.lastBeatNotes > 0;
  if (abrupt) {
    const endBar = fmtBar(ctx.range.end - 1, ctx.barTicks);
    issue(ctx, {
      check: 'ending',
      area: 'arrangement',
      severity: 'medium',
      bars: `${Math.max(1, endBar - 3)}-${endBar}`,
      problem: 'The song stops abruptly at full energy: no outro, fade or final hit.',
      fix: `add an 8-bar outro (drums and bass out, chords + pad) with add_transition ${j({ at_bars: [endBar + 1], kind: 'crash' })}; or fade the master: add_automation ${j({ insert: 'Master', param: 'volume', bars: `${Math.max(1, endBar - 3)}-${endBar}`, from: '0dB', to: '-60dB' })}`,
      order: 27,
    });
  }
}

function checkSounds(ctx: Ctx): void {
  const p = ctx.project;
  const bare: Array<{ ch: Channel; preset: InstrumentPreset | null; synth: boolean }> = [];
  const legacy: Array<{ ch: Channel; sample: FactorySample }> = [];
  for (const chId of p.channelOrder) {
    if (!ctx.heard.channels.has(chId)) continue;
    const ch = p.channels[chId];
    const type = ch.generator.type;
    if (type === 'krypt.audioclip' || /^(vst3|clap):/.test(type) || ch.generator.preset) continue;
    const sample = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
    if (sample) {
      if ((LEGACY_FACTORY_PATHS as readonly string[]).includes(sample.path) && ctx.samples) {
        const role = roleFromName(ch.name);
        const kind = role && ['kick', 'snare', 'clap', 'hat', 'openhat', 'perc', 'crash', 'ride', 'tom', '808'].includes(role) ? role : null;
        const pool = kind ? ctx.samples.filter((s) => s.kind === kind) : [];
        if (kind && pool.length >= 3) {
          const best = rankSamples(ctx.samples, { kind: kind as FactorySample['kind'], genre: ctx.genre ?? undefined }, 1)[0];
          if (best && best.path !== sample.path) legacy.push({ ch, sample: best });
        }
      }
      continue;
    }
    if (!isDefaultParams(ctx.catalog, ch)) continue;
    const role = roleFromName(ch.name) ?? (type === 'krypt.kick808' ? '808' : type === 'krypt.drumsynth' ? 'perc' : 'lead');
    const preset = ctx.pickPreset ? ctx.pickPreset(role, ch.name) : (rankPresets(instrumentPresets(ctx.presets), { role, kind: 'instrument', genre: ctx.genre ?? undefined }, 1)[0] ?? null);
    bare.push({ ch, preset, synth: type !== 'krypt.kick808' && type !== 'krypt.drumsynth' });
  }
  if (bare.length) {
    issue(ctx, {
      check: 'presets',
      area: 'sound',
      severity: bare.some((x) => x.synth) ? 'medium' : 'low',
      problem: `Still on a bare default instrument (no preset, default knobs): ${bare.map((x) => x.ch.name).join(', ')}. That is the "demo" sound.`,
      fix: bare
        .slice(0, 4)
        .map((x) => (x.preset ? `load_preset ${j({ channel: x.ch.name, preset: x.preset.id })}` : `find_presets ${j({ role: roleFromName(x.ch.name) ?? 'lead' })} then load_preset`))
        .join(' · '),
      order: 30,
    });
  } else good(ctx, 30, 'Every synth part uses a designed sound (a preset or shaped params).');
  if (legacy.length) {
    issue(ctx, {
      check: 'kit',
      area: 'sound',
      severity: 'low',
      problem: `${legacy.map((x) => x.ch.name).join(', ')} still use${legacy.length === 1 ? 's' : ''} the original 11-sample factory kit; the genre has better-fitting samples.`,
      fix: legacy
        .slice(0, 4)
        .map((x) => `load_sample ${j({ channel: x.ch.name, sample: x.sample.path })}`)
        .join(' · '),
      order: 33,
    });
  }
}

function checkVelocity(ctx: Ctx): void {
  const p = ctx.project;
  const target = ctx.targets.minHatVelocitySpread ?? GENERIC_TARGETS.minHatVelocitySpread!;
  const flat: Array<{ ch: Channel; spread: number; pattern: string | null }> = [];
  const fine: string[] = [];
  for (const [chId, e] of ctx.heard.channels) {
    const ch = p.channels[chId];
    const role = roleFromName(ch.name);
    if (!(role === 'hat' || role === 'openhat' || /shaker|ride/i.test(ch.name)) || e.vels.length < 8) continue;
    const spread = r1(std(e.vels));
    if (spread < target) flat.push({ ch, spread, pattern: topPattern(p, e) });
    else fine.push(`${ch.name} ${spread}`);
  }
  if (flat.length) {
    const op = grooveOp(ctx, 0.8) ?? { op: 'humanize', timing_ms: 0, velocity: 14 };
    issue(ctx, {
      check: 'velocity',
      area: 'sound',
      severity: 'medium',
      problem: `Machine-gun hats: ${flat.map((x) => `${x.ch.name} velocity spread ${x.spread}`).join(', ')} (want >= ${target}). Every hit at the same level sounds programmed.`,
      fix:
        flat
          .slice(0, 3)
          .map((x) => `transform_notes ${j({ ...(x.pattern ? { pattern: x.pattern } : {}), channel: x.ch.name, ops: [op] })}`)
          .join(' · ') + ' (in every pattern the hats play in; or write accents X and ghosts o in the KPN)',
      order: 31,
    });
  } else if (fine.length) good(ctx, 31, `Hats breathe: velocity spread ${fine.join(', ')}.`);
}

/** The groove op (transform_notes) for this playbook / genre, or null when no template fits. */
function grooveOp(ctx: Ctx, velocity?: number): { op: 'groove'; template: string; amount: number; velocity: number } | null {
  const g = grooveFor(ctx.playbook, ctx.genre);
  return g ? { op: 'groove', template: g.template, amount: g.amount, velocity: velocity ?? g.velocity } : null;
}

/** Robotic drums: every hit on the straight grid, no swing, where the playbook wants a groove. */
function checkGroove(ctx: Ctx): void {
  const pb = ctx.playbook;
  const g = grooveFor(pb, ctx.genre);
  if (!pb || (pb.swing < 8 && g?.source !== 'playbook')) return;
  const swingPct = Math.round(ctx.project.transport.swing * 100);
  if (pb.swing >= 8 && swingPct >= pb.swing / 2) {
    good(ctx, 32, `Groove: swing ${swingPct}% (the genre wants about ${pb.swing}%).`);
    return;
  }
  let on = 0;
  let all = 0;
  const stiff: Array<{ name: string; pattern: string | null; n: number }> = [];
  // The playbook may groove only some parts (trap: the hats; the kick and clap stay on the grid).
  const only = g?.parts?.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [chId, e] of ctx.heard.channels) {
    const ch = ctx.project.channels[chId];
    if (!isDrumChannel(ch)) continue;
    if (only && !only.includes(ch.name.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
    let chOn = 0;
    for (const t of e.ticks) {
      all++;
      if (t % (PPQ / 4) === 0) {
        on++;
        chOn++;
      }
    }
    if (chOn >= 0.95 * e.ticks.length) stiff.push({ name: ch.name, pattern: topPattern(ctx.project, e), n: e.ticks.length });
  }
  if (all < 16 || on / all < 0.95) {
    if (all >= 16) good(ctx, 32, 'Groove: the drums have human timing (not all on the grid).');
    return;
  }
  const op = grooveOp(ctx);
  const calls = stiff
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((d) => `transform_notes ${j({ ...(d.pattern ? { pattern: d.pattern } : {}), channel: d.name, ops: [op ?? { op: 'humanize', timing_ms: 6, velocity: 8 }] })}`);
  issue(ctx, {
    check: 'groove',
    area: 'sound',
    severity: 'medium',
    problem: `Robotic drums: every hit sits exactly on the grid${pb.swing >= 8 ? ` with swing ${swingPct}%, but ${pb.name} swings (about ${pb.swing}%)` : `, but ${pb.name} wants a human groove`}.`,
    fix: `${calls.join(' · ')}${op ? ` (the same op on ${g?.parts?.length ? g.parts.join(', ') : `every drum channel${g?.melodic ? ', the bass and the keys' : ''}`} in every section pattern)` : ''}${pb.swing >= 8 ? ` · or set_swing ${j({ percent: pb.swing })}` : ''}`,
    order: 32,
  });
}

function checkNotes(ctx: Ctx): void {
  const s = ctx.symbolic;
  if (!s) return;
  if (s.outOfKeyRatio !== null && s.outOfKeyRatio > 0.1) {
    const key = s.key.given ?? s.key.estimated ?? '<key>';
    issue(ctx, {
      check: 'key',
      area: 'sound',
      severity: 'medium',
      problem: `${Math.round(s.outOfKeyRatio * 100)}% of the pitched notes are outside ${key}: ${s.outOfKeyNotes.slice(0, 4).join(', ')}.`,
      fix: `shape_notes ${j({ channel: '<channel>', ops: [{ op: 'scale_snap', key }] })} on the channel that holds them (read_pattern to find it)`,
      order: 34,
    });
  }
  if (s.lowClashes.length) {
    issue(ctx, {
      check: 'clash',
      area: 'sound',
      severity: 'medium',
      problem: `Low-register clash: ${s.lowClashes.slice(0, 2).join('; ')} (mud under C3).`,
      fix: 'keep one part below C3: move the chords / pad up an octave (transform_notes {"channel":"<chords>","ops":[{"op":"transpose","semitones":12}]}), or let the bass follow the chord roots',
      order: 35,
    });
  }
}

/** Run every check; issues ranked by severity, then impact order; at most 10. */
export function reviewSong(input: ReviewInput): ReviewResult {
  const p = input.project;
  const barTicks = ticksPerBar(p.transport.timeSig);
  const heard = collectHeard(p, input.range.start, input.range.end);
  const sections = sectionsOf(p, input.range, heard);
  const masterChain = rankPresets(input.presets.filter((x) => x.kind === 'chain'), { role: 'master', kind: 'chain', genre: input.genre ?? undefined, tags: input.playbook?.mix.master.tags }, 1)[0]?.id ?? null;
  const ctx: Ctx = { ...input, heard, sections, barTicks, bpm: p.transport.bpm, masterChain, issues: [], works: [], skipped: [] };
  checkLoudness(ctx);
  checkPeaks(ctx);
  checkBands(ctx);
  checkStereo(ctx);
  checkMaster(ctx);
  checkSidechain(ctx);
  checkSections(ctx);
  checkLength(ctx);
  checkPhrases(ctx);
  checkEnergy(ctx);
  checkStatic(ctx);
  checkTransitions(ctx);
  checkIntroEnding(ctx);
  checkSounds(ctx);
  checkVelocity(ctx);
  checkGroove(ctx);
  checkNotes(ctx);
  checkReference(ctx);
  const closeness = checkCloseness(ctx);

  const ranked = [...ctx.issues].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.order - b.order);
  const score = Math.max(0, Math.min(100, 100 - ctx.issues.reduce((s, x) => s + SEVERITY_WEIGHT[x.severity], 0)));
  const works = ctx.works.sort((a, b) => a.order - b.order).map((w) => w.text);
  if (works.length < 2) {
    const playing = [...heard.channels.keys()].length;
    const bars = Math.round((input.range.end - input.range.start) / barTicks);
    if (playing) works.push(`${playing} parts play across ${bars} bars.`);
    if (sections.length > 1 && works.length < 2) works.push(`${sections.length} distinct sections.`);
  }
  const a = input.analysis;
  const bandsVsMid = a && Number.isFinite(a.bands.mid) ? Object.fromEntries(Object.entries(a.bands).filter(([k]) => k !== 'mid').map(([k, v]) => [k, r1(v - a.bands.mid)])) : null;
  const measuredSections = sections.filter((s) => typeof s.lufs === 'number');
  const contrast = measuredSections.length >= 2 ? r1(Math.max(...measuredSections.map((s) => s.lufs!)) - Math.min(...measuredSections.map((s) => s.lufs!))) : null;
  return {
    score,
    issues: ranked.slice(0, 10),
    total: ranked.length,
    works: works.slice(0, 4),
    sections,
    skipped: ctx.skipped,
    metrics: {
      bars: Math.round((input.range.end - input.range.start) / barTicks),
      lufs: a && Number.isFinite(a.lufsIntegrated) ? r1(a.lufsIntegrated) : null,
      truePeakDb: a ? r1(a.truePeakDb) : (input.measured?.peakDb ?? null),
      correlation: a ? Math.round(a.stereoCorrelation * 100) / 100 : (input.measured?.correlation ?? null),
      bandsVsMid,
      contrastLu: contrast,
    },
    ...(closeness ? { closeness } : {}),
  };
}
