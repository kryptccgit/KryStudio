// Closeness to the studied reference (research/15 §3.5, owned by review-mix):
// how near the song is to the reference the user gave, as 0-100 overall and
// per dimension, each with what was measured, what the reference has and
// the tool call that closes the gap. review_song adds the biggest gaps to
// its issue list; match_mix (matchMix.ts) shares the part-level maths.
//
// Dimensions (weights renormalised over the ones that could be measured):
//   tempo 0.20       exact = 100; ×2 / ×0.5 readings of the reference count
//   key 0.10         same 100, relative major/minor 80, a fifth away 40, else 20
//   groove 0.20      per-role cosine of 16th-step hit histograms (+ swing)
//   harmony 0.15     chord per bar vs the reference chords, per section
//   arrangement 0.15 per-bar energy correlation, section boundaries (±1 bar), length
//   sounds 0.10      fingerprint similarity per part (when available)
//   mix 0.10         bands vs mid, width, LUFS, per-part balance (stems)
//
// Pure: no I/O. Times: project bars are 1-based from the start of the
// reviewed range; the reference is read on its beat grid at the tempo
// reading (×1, ×2, ×0.5) nearest the project tempo, so a 71.5 bpm detection
// lines up with a 143 bpm project bar for bar.

import type { Channel, Project } from '@shared/schema/project';
import type { Analysis } from '@shared/engine/protocol';
import type { AudioAnalysis, ChordQuality, DrumRole } from '@shared/analyzer/protocol';
import type { PlannedSection, ReferenceBrief } from '@shared/reference/types';
import { chordName, sectionPlan } from '@shared/reference/brief';
import { cosine, FEEL_ROLES, feelLine, gridSteps16, hitsPerBar } from '@shared/reference/drums';
import { beatToSec, chordsToBeats, drumGrid } from '@shared/library/grid';
import { keyShift, keyShortName, toKeyRef } from '@shared/music/keymatch';
import { roleFromName } from '@shared/sounds/select';
import { ticksPerBar, ticksToSeconds } from '@shared/schema/time';
import { isDrumChannel } from './overview';
import { correlation, songNotes } from './hearing';

export type ClosenessDimId = 'tempo' | 'key' | 'groove' | 'harmony' | 'arrangement' | 'sounds' | 'mix';

export const CLOSENESS_WEIGHTS: Record<ClosenessDimId, number> = { tempo: 0.2, key: 0.1, groove: 0.2, harmony: 0.15, arrangement: 0.15, sounds: 0.1, mix: 0.1 };
const DIM_ORDER: ClosenessDimId[] = ['tempo', 'key', 'groove', 'harmony', 'arrangement', 'sounds', 'mix'];

export interface ClosenessDim {
  id: ClosenessDimId;
  /** 0..100, null = not measured (see note). */
  score: number | null;
  /** What the song has, in words ("175 bpm"). */
  measured: string;
  /** What the reference has. */
  reference: string;
  /** The tool call(s) that close the gap; null when nothing to do. */
  fix: string | null;
  /** Why it wasn't measured, or a caveat. */
  note?: string;
  /** Numbers behind the score (per role, per section, per part …). */
  detail?: Record<string, unknown>;
}

export interface Closeness {
  /** 0..100 over the measured dimensions (weighted), null when none could be measured. */
  overall: number | null;
  dims: ClosenessDim[];
  /** The fixes worth most closeness points first (weight × gap). */
  topFixes: Array<{ dim: ClosenessDimId; gain: number; fix: string }>;
}

/** The four stem groups of a separated song (HT-Demucs) and what our parts map to. */
export type PartGroup = 'drums' | 'bass' | 'other' | 'vocals';
export const PART_GROUPS: readonly PartGroup[] = ['drums', 'bass', 'other', 'vocals'];
/** Level per group (dB: RMS or LUFS, the same measure on both sides). */
export type GroupLevels = Partial<Record<PartGroup, number>>;

export interface ClosenessInput {
  project: Project;
  /** Song ticks [start, end) under review. */
  range: { start: number; end: number };
  /** The project's sections (review_song's markers or inferred), song ticks. */
  sections: ReadonlyArray<{ name: string; start: number; end: number }>;
  /** The project key ("Am"), given or estimated from the notes; null without pitched notes. */
  projectKey: string | null;
  /** The render's analysis (null: the render failed or has none). */
  render: Analysis | null;
  reference: { brief: ReferenceBrief; analysis: AudioAnalysis };
  /** Per-part loudness of our render (stems) and of the reference stems; null when either is missing. */
  balance?: { project: GroupLevels; reference: GroupLevels } | null;
  /** Why the balance is missing (shown as a note). */
  balanceNote?: string;
  /** Per-part sound similarity (fingerprints, 0..1), when available. */
  sounds?: Array<{ part: string; similarity: number; fix?: string }> | null;
  soundsNote?: string;
}

const j = (v: unknown): string => JSON.stringify(v);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const sgn = (n: number): string => `${n > 0 ? '+' : ''}${r1(n)}`;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

// ── The reading of the reference at the project tempo ───────────────────

/** ×0.5, ×1 or ×2: the reading of the reference tempo nearest the project tempo (1 without a tempo). */
export function readingFactor(projectBpm: number, detectedBpm: number | null): 1 | 0.5 | 2 {
  if (!isNum(detectedBpm) || detectedBpm <= 0 || !(projectBpm > 0)) return 1;
  const fs = [1, 0.5, 2] as const;
  return fs.reduce((best, f) => (Math.abs(Math.log2(projectBpm / (detectedBpm * f))) < Math.abs(Math.log2(projectBpm / (detectedBpm * best))) ? f : best), 1 as 1 | 0.5 | 2);
}

/** Seconds of the reference at a 0-based bar position of the reading (`factor`). */
function refSecAtBar(a: AudioAnalysis, bar: number, bpb: number, factor: number, detected: number): number {
  const beat = (bar * bpb) / factor;
  return beatToSec(a, beat) ?? (beat * 60) / detected;
}

/** The reference's section plan at the reading (brief.plan when it is the brief's own reading). */
function planAt(brief: ReferenceBrief, factor: number): PlannedSection[] {
  if (!brief.detectedBpm) return [];
  if (factor === brief.factor) return brief.plan;
  return sectionPlan(brief, Math.round(brief.detectedBpm * factor * 100) / 100);
}

// ── Tempo ───────────────────────────────────────────────────────────────

export function tempoScore(bpm: number, detected: number): { score: number; reading: number; offPct: number } {
  const readings = [detected, detected * 2, detected / 2];
  const reading = readings.reduce((b, r) => (Math.abs(bpm / r - 1) < Math.abs(bpm / b - 1) ? r : b));
  const offPct = Math.abs(bpm / reading - 1) * 100;
  // Exact (within 0.5 %) = 100; 3 % off (the reference lock's limit) ≈ 67; 8 % or more = 0.
  const score = Math.round(100 * clamp01(1 - Math.max(0, offPct - 0.5) / 7.5));
  return { score, reading: Math.round(reading * 10) / 10, offPct: r1(offPct) };
}

function tempoDim(bpm: number, brief: ReferenceBrief): ClosenessDim {
  const det = brief.detectedBpm;
  if (!det) return { id: 'tempo', score: null, measured: `${bpm} bpm`, reference: 'no steady tempo', fix: null, note: 'the reference has no steady pulse to compare with' };
  const t = tempoScore(bpm, det);
  const readings = [...new Set([det, r1(det * 2), r1(det / 2)].filter((x) => x >= 40 && x <= 300))].join(' / ');
  // Near a reading: snap to it exactly. Far off: the reading the plan uses (it fits the genre).
  const target = t.offPct <= 3 ? Math.round(t.reading * 10) / 10 : (brief.bpm ?? Math.round(t.reading));
  const snapped = Math.abs(target - Math.round(target)) < 0.15 ? Math.round(target) : target;
  return {
    id: 'tempo',
    score: t.score,
    measured: `${bpm} bpm`,
    reference: `${det} bpm (readings ${readings})`,
    fix: t.score < 100 ? `set_tempo ${j({ bpm: snapped })} (the reference's ${snapped} bpm reading; ${t.offPct}% off now)` : null,
    detail: { reading: t.reading, offPct: t.offPct },
  };
}

// ── Key ─────────────────────────────────────────────────────────────────

/** The chord the project's bars rest on most (ties: the one heard first): the tonic its harmony centres on, or null. */
function homeChord(chords: Array<BarChord | null>): BarChord | null {
  const n = new Map<string, { c: BarChord; k: number; first: number }>();
  chords.forEach((c, i) => {
    if (!c || c.minor === null) return;
    const key = `${c.root}${c.minor ? 'm' : ''}`;
    const e = n.get(key) ?? { c, k: 0, first: i };
    e.k++;
    n.set(key, e);
  });
  return [...n.values()].sort((a, b) => b.k - a.k || a.first - b.first)[0]?.c ?? null;
}

function keyDim(projectKey: string | null, brief: ReferenceBrief, pitched: string[], home: BarChord | null = null): ClosenessDim {
  const refName = brief.keyFromChords ?? brief.key;
  const rk = toKeyRef(refName);
  const pk = toKeyRef(projectKey);
  if (!rk) return { id: 'key', score: null, measured: projectKey ?? '?', reference: 'unclear', fix: null, note: "the reference's key is unclear" };
  if (!pk) return { id: 'key', score: null, measured: 'no pitched notes', reference: keyShortName(rk), fix: null, note: 'no pitched notes to read a key from yet' };
  const shift = keyShift(pk, rk);
  // Key estimates mix up relative keys (Am / C): when the chords centre on the reference's tonic, it is the same key.
  const centred = shift.relation === 'relative' && !!home && home.root === rk.pc && home.minor === rk.minor;
  const fifth = Math.abs(shift.semitones) === 5;
  const score = shift.relation === 'same' || centred ? 100 : shift.relation === 'relative' ? 80 : fifth ? 40 : 20;
  if (centred) return { id: 'key', score, measured: keyShortName(rk), reference: keyShortName(rk), fix: null, note: `your notes read as ${keyShortName(pk)}, but the chords centre on ${keyShortName(rk)}`, detail: { relation: 'same', semitones: 0 } };
  const chans = pitched.slice(0, 3);
  const fix =
    shift.relation === 'move'
      ? `${(chans.length ? chans : ['<each pitched channel>']).map((c) => `transform_notes ${j({ channel: c, ops: [{ op: 'transpose', semitones: shift.semitones }] })}`).join(' · ')}${pitched.length > 3 ? ` (and ${pitched.slice(3).join(', ')})` : ''} in every pattern: ${keyShortName(pk)} → ${keyShortName(shift.result)}`
      : shift.relation === 'relative'
        ? `the same notes as ${keyShortName(rk)}; centre the chords and bass on ${keyShortName(rk)}'s tonic for the same mood`
        : null;
  return { id: 'key', score, measured: keyShortName(pk), reference: keyShortName(rk), fix, detail: { relation: shift.relation, semitones: shift.semitones } };
}

// ── Groove ──────────────────────────────────────────────────────────────

const ROLE_TO_FEEL: Record<string, DrumRole | null> = { kick: 'kick', snare: 'snare', clap: 'snare', hat: 'hat', ride: 'hat', openhat: 'openhat', perc: 'perc', tom: 'perc', crash: null };
const DRUM_ROLES = new Set(Object.keys(ROLE_TO_FEEL));

/** The drum role a channel plays for the groove comparison (null: not a drum, or a crash). */
export function feelRoleOf(ch: Pick<Channel, 'name' | 'generator'> | { name: string }, drum: boolean): DrumRole | null {
  const role = roleFromName(ch.name);
  if (role && DRUM_ROLES.has(role)) return ROLE_TO_FEEL[role];
  return drum && !role ? 'perc' : null;
}

/** Per role, the fraction of drum bars with a hit on each 16th (the project's notes in [start, end)). */
export function projectDrumSteps(p: Project, start: number, end: number): { steps: Partial<Record<DrumRole, number[]>>; bars: number; names: Partial<Record<DrumRole, string>> } {
  const barTicks = ticksPerBar(p.transport.timeSig);
  const step = barTicks / 16;
  const hits = new Map<DrumRole, Set<number>>();
  const names: Partial<Record<DrumRole, string>> = {};
  const active = new Set<number>();
  const byName = new Map(p.channelOrder.map((id) => [p.channels[id].name, p.channels[id]]));
  for (const c of songNotes(p, start, end)) {
    const ch = byName.get(c.name);
    const role = feelRoleOf(ch ?? { name: c.name }, !!c.drum);
    if (!role) continue;
    names[role] ??= c.name;
    const set = hits.get(role) ?? new Set<number>();
    for (const n of c.notes) {
      const s = Math.round(n.tick / step);
      const bar = Math.floor(s / 16);
      active.add(bar);
      set.add(s);
    }
    hits.set(role, set);
  }
  const bars = active.size;
  const steps: Partial<Record<DrumRole, number[]>> = {};
  if (!bars) return { steps, bars, names };
  for (const [role, set] of hits) {
    const c = new Array<number>(16).fill(0);
    for (const s of set) c[s % 16]++;
    steps[role] = c.map((x) => r2(Math.min(1, x / bars)));
  }
  return { steps, bars, names };
}

/** The reference's drum steps at the reading `factor` (the brief's own when it is the same reading). */
export function referenceDrumSteps(brief: ReferenceBrief, a: AudioAnalysis, factor: number): { steps: Partial<Record<DrumRole, number[]>>; source: 'stem' | 'mix'; note?: string } | null {
  if (brief.drums && factor === brief.factor) return { steps: brief.drums.steps, source: brief.drums.source };
  if (a.drumHits?.length) {
    const g = drumGrid(a, a.drumHits, 'mix');
    if (g) return { steps: gridSteps16(g, factor), source: 'mix', ...(brief.drums?.source === 'stem' ? { note: 'read from the full mix at this tempo reading (the drum stem is read at the plan tempo)' } : {}) };
  }
  return brief.drums ? { steps: brief.drums.steps, source: brief.drums.source, note: `compared at the reference's ${brief.bpm ?? '?'} bpm reading` } : null;
}

/** A KPN drum line from 16th probabilities: x = most bars, o = some bars (a ghost), . = rarely. */
export function kpnStepLine(steps: number[]): string {
  const ch = steps.map((p) => (p >= 0.5 ? 'x' : p >= 0.25 ? 'o' : '.'));
  return [0, 4, 8, 12].map((i) => ch.slice(i, i + 4).join('')).join(' ');
}

const ROLE_WORD: Record<DrumRole, string> = { kick: 'Kick', snare: 'Snare', hat: 'Hat', openhat: 'Open Hat', perc: 'Perc' };

export function grooveScore(proj: Partial<Record<DrumRole, number[]>>, ref: Partial<Record<DrumRole, number[]>>): { score: number; roles: Array<{ role: DrumRole; weight: number; cosine: number }> } {
  const roles: Array<{ role: DrumRole; weight: number; cosine: number }> = [];
  for (const role of FEEL_ROLES) {
    const w = Math.max(hitsPerBar(ref[role]), hitsPerBar(proj[role]));
    if (w < 0.5) continue;
    roles.push({ role, weight: Math.min(8, w), cosine: r2(cosine(proj[role], ref[role])) });
  }
  const total = roles.reduce((s, x) => s + x.weight, 0);
  return { score: total ? Math.round((100 * roles.reduce((s, x) => s + x.weight * x.cosine, 0)) / total) : 100, roles };
}

function grooveDim(input: ClosenessInput, factor: number): ClosenessDim {
  const { project: p, range, reference } = input;
  const ref = referenceDrumSteps(reference.brief, reference.analysis, factor);
  const proj = projectDrumSteps(p, range.start, range.end);
  if (!ref || !Object.keys(ref.steps).length) return { id: 'groove', score: null, measured: `${proj.bars} drum bars`, reference: 'no drum reading', fix: null, note: 'the reference has no drum hits to compare with' };
  if (!proj.bars) {
    const lines = FEEL_ROLES.filter((r) => hitsPerBar(ref.steps[r]) >= 0.5).map((r) => `${ROLE_WORD[r]} : ${kpnStepLine(ref.steps[r]!)}`);
    return { id: 'groove', score: 0, measured: 'no drums', reference: lines.join(' | '), fix: `write the drums in each section pattern (write_pattern KPN): ${lines.join(' / ')}` };
  }
  const g = grooveScore(proj.steps, ref.steps);
  // Swing: the transport's swing vs the reference's (when measured at this reading).
  const refSwing = factor === reference.brief.factor ? reference.brief.swingPercent : null;
  const ourSwing = Math.round(p.transport.swing * 100);
  let score = g.score;
  let swingFix: string | null = null;
  if (refSwing !== null) {
    const swingScore = 100 * clamp01(1 - Math.abs(ourSwing - refSwing) / 30);
    score = Math.round(0.85 * g.score + 0.15 * swingScore);
    if (Math.abs(ourSwing - refSwing) >= 8) swingFix = `set_swing ${j({ percent: refSwing })}`;
  }
  const worst = g.roles.filter((x) => x.cosine < 0.9).sort((a, b) => b.weight * (1 - b.cosine) - a.weight * (1 - a.cosine));
  const fixes = worst.slice(0, 2).map((x) => {
    const name = proj.names[x.role] ?? ROLE_WORD[x.role];
    const want = ref.steps[x.role];
    return want && hitsPerBar(want) >= 0.5
      ? `rewrite ${name} in each section pattern to the reference grid: write_pattern ${j({ kpn: `${name} : ${kpnStepLine(want)}`, mode: 'merge' })} (ours ${proj.steps[x.role] ? feelLine(proj.steps[x.role]!) : 'none'}, the reference ${feelLine(want)})`
      : `thin ${name}: the reference barely uses it (${feelLine(want ?? new Array(16).fill(0))})`;
  });
  if (swingFix) fixes.push(swingFix);
  const shown = g.roles.map((x) => `${x.role} ${Math.round(x.cosine * 100)}%`).join(', ');
  return {
    id: 'groove',
    score,
    measured: `${shown || 'no common roles'}${refSwing !== null ? `, swing ${ourSwing}%` : ''}`,
    reference: `${ref.source === 'stem' ? 'drum stem' : 'full-mix'} hits${refSwing !== null ? `, swing ${refSwing}%` : ''}`,
    fix: fixes.length ? fixes.join(' · ') : null,
    ...(ref.note ? { note: ref.note } : {}),
    detail: {
      roles: g.roles,
      project: Object.fromEntries(Object.entries(proj.steps).map(([k, v]) => [k, feelLine(v!)])),
      reference: Object.fromEntries(Object.entries(ref.steps).map(([k, v]) => [k, feelLine(v!)])),
    },
  };
}

// ── Harmony ─────────────────────────────────────────────────────────────

interface BarChord {
  root: number;
  /** true minor, false major, null neutral (sus, power chord). */
  minor: boolean | null;
  name: string;
}

const MINORISH = new Set<ChordQuality>(['min', 'm7', 'dim']);
const NEUTRAL = new Set<ChordQuality>(['sus', '5']);

function triad(c: BarChord): number[] {
  return [c.root, mod12(c.root + (c.minor ? 3 : 4)), mod12(c.root + 7)];
}

/** How well a project chord stands in for the reference chord (1 same, 0.6 same root, 0.5 two shared tones). */
export function chordMatch(p: BarChord | null, r: BarChord): number {
  if (!p) return 0;
  if (p.root === r.root) return r.minor === null || p.minor === r.minor ? 1 : 0.6;
  const a = new Set(triad(p));
  return triad(r).filter((x) => a.has(x)).length >= 2 ? 0.5 : 0;
}

/** The chord of a bar from pitch-class weights (major / minor triad templates); null with fewer than 2 clear pitch classes. */
export function chordFromWeights(w: number[]): BarChord | null {
  const total = w.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return null;
  if (w.filter((x) => x > 0.1 * total).length < 2) return null;
  let best: { s: number; root: number; minor: boolean } | null = null;
  for (let r = 0; r < 12; r++) {
    for (const minor of [false, true]) {
      const t = [r, (r + (minor ? 3 : 4)) % 12, (r + 7) % 12];
      const inside = 1.2 * w[t[0]] + w[t[1]] + 0.8 * w[t[2]];
      const outside = total - w[t[0]] - w[t[1]] - w[t[2]];
      const s = (inside - 0.5 * outside) / total;
      if (!best || s > best.s + 1e-9) best = { s, root: r, minor };
    }
  }
  return best ? { root: best.root, minor: best.minor, name: chordName(best.root, best.minor ? 'min' : 'maj') } : null;
}

/** The project's chord per bar (0-based from range start) from its pitched parts (the bass weighs a little more). */
export function projectBarChords(p: Project, start: number, end: number, shift = 0): Array<BarChord | null> {
  const barTicks = ticksPerBar(p.transport.timeSig);
  const n = Math.max(0, Math.ceil((end - start) / barTicks));
  const w = Array.from({ length: n }, () => new Array<number>(12).fill(0));
  const byName = new Map(p.channelOrder.map((id) => [p.channels[id].name, p.channels[id]]));
  for (const c of songNotes(p, start, end)) {
    const ch = byName.get(c.name);
    if (c.drum || feelRoleOf(ch ?? { name: c.name }, false)) continue;
    const role = roleFromName(c.name);
    if (role === 'fx' || role === 'texture') continue;
    for (const note of c.notes) {
      const a = note.tick;
      const b = note.tick + Math.max(1, note.dur);
      for (let bi = Math.floor(a / barTicks); bi < n && bi * barTicks < b; bi++) {
        const ov = Math.min(b, (bi + 1) * barTicks) - Math.max(a, bi * barTicks);
        if (ov <= 0) continue;
        w[bi][mod12(note.key + shift)] += ov * (note.key < 52 ? 1.5 : 1);
      }
    }
  }
  return w.map(chordFromWeights);
}

/** The reference's chord per bar of the reading (0-based bars from the first downbeat), null where unclear. */
export function referenceBarChords(a: AudioAnalysis, factor: number, bars: number): Array<BarChord | null> {
  const bpb = a.beats?.beatsPerBar && a.beats.beatsPerBar >= 1 ? Math.round(a.beats.beatsPerBar) : 4;
  const spans = a.chords?.length ? chordsToBeats(a, a.chords) : [];
  const out: Array<BarChord | null> = new Array(bars).fill(null);
  const cover: number[] = new Array(bars).fill(0);
  for (const c of spans) {
    const s = (c.beat * factor) / bpb;
    const e = ((c.beat + c.dur) * factor) / bpb;
    for (let bi = Math.max(0, Math.floor(s)); bi < bars && bi < e; bi++) {
      const ov = Math.min(e, bi + 1) - Math.max(s, bi);
      if (ov >= 0.25 && ov > cover[bi]) {
        cover[bi] = ov;
        out[bi] = { root: mod12(c.root), minor: NEUTRAL.has(c.quality) ? null : MINORISH.has(c.quality), name: chordName(c.root, c.quality) };
      }
    }
  }
  return out;
}

function chordSeq(xs: Array<BarChord | null>): string {
  const names: string[] = [];
  for (const x of xs) {
    const n = x?.name ?? '-';
    if (names[names.length - 1] !== n) names.push(n);
  }
  return names.slice(0, 8).join(' ') + (names.length > 8 ? ' …' : '');
}

/** Per-section chord similarity (bars 0-based); a bar also counts at 0.75 when it matches a neighbouring reference bar (chord changes a beat early / late). */
export function harmonySimilarity(proj: Array<BarChord | null>, ref: Array<BarChord | null>, sections: Array<{ label: string; start: number; end: number }>): Array<{ label: string; start: number; end: number; bars: number; similarity: number }> {
  const out: Array<{ label: string; start: number; end: number; bars: number; similarity: number }> = [];
  for (const s of sections) {
    let sum = 0;
    let n = 0;
    for (let i = s.start; i < s.end && i < proj.length; i++) {
      const r = ref[i];
      if (!r) continue;
      const near = Math.max(ref[i - 1] ? 0.75 * chordMatch(proj[i], ref[i - 1]!) : 0, ref[i + 1] ? 0.75 * chordMatch(proj[i], ref[i + 1]!) : 0);
      sum += Math.max(chordMatch(proj[i], r), near);
      n++;
    }
    if (n) out.push({ ...s, bars: n, similarity: r2(sum / n) });
  }
  return out;
}

function harmonyDim(input: ClosenessInput, factor: number, plan: PlannedSection[], projBars: number, keyShiftSt: number | null, off: number): ClosenessDim {
  const { project: p, range, reference } = input;
  const a = reference.analysis;
  if ((a.chords?.length ?? 0) < 4) return { id: 'harmony', score: null, measured: '', reference: 'chords unclear', fix: null, note: "the reference's chords are unclear (too few chord readings)" };
  const ref = referenceBarChords(a, factor, off + projBars).slice(off);
  if (!ref.some(Boolean)) return { id: 'harmony', score: null, measured: '', reference: 'chords unclear', fix: null, note: 'no reference chords inside the bars under review' };
  const sections = plan.length
    ? plan.map((s) => ({ label: s.label, start: s.startBar - 1, end: s.startBar - 1 + s.bars })).filter((s) => s.start < projBars)
    : Array.from({ length: Math.ceil(projBars / 8) }, (_, i) => ({ label: `bars ${i * 8 + 1}-${Math.min(projBars, i * 8 + 8)}`, start: i * 8, end: Math.min(projBars, i * 8 + 8) }));
  const score = (sims: ReturnType<typeof harmonySimilarity>) => {
    const bars = sims.reduce((s, x) => s + x.bars, 0);
    return bars ? sims.reduce((s, x) => s + x.bars * x.similarity, 0) / bars : 0;
  };
  const as = projectBarChords(p, range.start, range.end);
  let sims = harmonySimilarity(as, ref, sections);
  let proj = as;
  let shifted = false;
  if (keyShiftSt) {
    const moved = projectBarChords(p, range.start, range.end, keyShiftSt);
    const alt = harmonySimilarity(moved, ref, sections);
    if (score(alt) > score(sims) + 0.05) {
      sims = alt;
      proj = moved;
      shifted = true;
    }
  }
  if (!as.some(Boolean)) {
    return { id: 'harmony', score: 0, measured: 'no chords', reference: chordSeq(ref), fix: `write a chord part following the reference's changes (${chordSeq(ref.slice(0, 8))} …): write_pattern on a Chords channel, one chord per bar` };
  }
  const total = Math.round(100 * score(sims));
  const worst = sims.filter((s) => s.similarity < 0.8).sort((x, y) => (1 - y.similarity) * y.bars - (1 - x.similarity) * x.bars || x.start - y.start)[0];
  const lbl = (s: { label: string; start: number; end: number }) => `${/^bars /.test(s.label) ? s.label : `section ${s.label} (bars ${range.start / ticksPerBar(p.transport.timeSig) + s.start + 1}-${range.start / ticksPerBar(p.transport.timeSig) + Math.min(projBars, s.end)})`}`;
  return {
    id: 'harmony',
    score: total,
    measured: chordSeq(as.slice(0, 16)),
    reference: chordSeq(ref.slice(0, 16)),
    fix: worst
      ? `${lbl(worst)}: the reference changes ${chordSeq(ref.slice(worst.start, worst.end))}, yours ${chordSeq(proj.slice(worst.start, worst.end))}${shifted ? ' (yours transposed to its key)' : ''}. Rewrite the chords there (write_pattern on the chords / keys channel, one chord per bar)`
      : null,
    ...(shifted ? { note: 'compared after transposing your chords to the reference key (the key score counts the key)' } : {}),
    detail: { sections: sims.map((s) => ({ label: s.label, startBar: s.start + 1, bars: s.bars, similarity: s.similarity })) },
  };
}

// ── Arrangement ─────────────────────────────────────────────────────────

/** Matched boundaries within ±tol bars: F1 of the two sets (1 when neither has an internal boundary). */
export function boundaryF1(ours: number[], ref: number[], tol = 1): { f1: number; missing: number[]; extra: number[] } {
  if (!ours.length && !ref.length) return { f1: 1, missing: [], extra: [] };
  const used = new Set<number>();
  const missing: number[] = [];
  let hit = 0;
  for (const r of ref) {
    const k = ours.findIndex((o, i) => !used.has(i) && Math.abs(o - r) <= tol);
    if (k >= 0) {
      used.add(k);
      hit++;
    } else missing.push(r);
  }
  const extra = ours.filter((_, i) => !used.has(i));
  const prec = ours.length ? hit / ours.length : 0;
  const rec = ref.length ? hit / ref.length : 0;
  return { f1: prec + rec > 0 ? r2((2 * prec * rec) / (prec + rec)) : 0, missing, extra };
}

/** Mean of a loudness curve over [t0, t1) seconds (index = t / hop), silence floored at -60. */
function curveMean(curve: readonly number[], hop: number, t0: number, t1: number): number | null {
  const vals: number[] = [];
  for (let i = Math.max(0, Math.floor(t0 / hop)); i < Math.min(curve.length, Math.ceil(t1 / hop)); i++) vals.push(isNum(curve[i]) ? Math.max(-60, curve[i]) : -60);
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
}

function arrangementDim(input: ClosenessInput, factor: number, plan: PlannedSection[], projBars: number, refBars: number | null, off: number): ClosenessDim {
  const { project: p, range, reference, render } = input;
  const barTicks = ticksPerBar(p.transport.timeSig);
  const bpm = p.transport.bpm;
  const a = reference.analysis;
  const det = reference.brief.detectedBpm;
  const bpb = reference.brief.beatsPerBar || 4;
  // Section boundaries (bars, 1-based from the range start), the first section's start excluded.
  const ours = input.sections.map((s) => Math.round((s.start - range.start) / barTicks) + 1).filter((b) => b > 1);
  const theirs = plan.map((s) => s.startBar).filter((b) => b > 1 && b <= projBars + 1);
  const bounds = plan.length ? boundaryF1(ours, theirs) : null;
  // Energy per bar, bar for bar.
  let corr: number | null = null;
  let worstBars: { from: number; to: number; dir: 'louder' | 'quieter' } | null = null;
  const curve = render?.energyCurve ?? [];
  if (det && curve.length >= 4 && a.energy?.lufs?.length) {
    const barSec = ticksToSeconds(barTicks, bpm);
    const n = Math.min(projBars, refBars ?? projBars);
    const ps: number[] = [];
    const rs: number[] = [];
    for (let b = 0; b < n; b++) {
      const pv = curveMean(curve, 1, b * barSec, (b + 1) * barSec);
      const rv = curveMean(a.energy.lufs, a.energy.hopSec || 0.5, refSecAtBar(a, b + off, bpb, factor, det), refSecAtBar(a, b + off + 1, bpb, factor, det));
      if (pv === null || rv === null) break;
      ps.push(pv);
      rs.push(rv);
    }
    if (ps.length >= 4) {
      corr = correlation(ps, rs);
      // Where the shapes part most (each curve against its own mean), over 4-bar windows.
      const mp = ps.reduce((s, x) => s + x, 0) / ps.length;
      const mr = rs.reduce((s, x) => s + x, 0) / rs.length;
      let best = 0;
      for (let b = 0; b + 4 <= ps.length; b += 4) {
        let d = 0;
        for (let k = b; k < b + 4; k++) d += ps[k] - mp - (rs[k] - mr);
        d /= 4;
        if (Math.abs(d) > Math.abs(best) && Math.abs(d) >= 3) {
          best = d;
          worstBars = { from: b + 1, to: b + 4, dir: d > 0 ? 'quieter' : 'louder' };
        }
      }
    }
  }
  const lenRatio = refBars ? Math.min(projBars, refBars) / Math.max(projBars, refBars) : null;
  const parts: Array<[number, number]> = [];
  if (corr !== null) parts.push([0.45, Math.max(0, corr)]);
  if (bounds) parts.push([0.4, bounds.f1]);
  if (lenRatio !== null) parts.push([0.15, lenRatio]);
  if (!parts.length) return { id: 'arrangement', score: null, measured: `${projBars} bars`, reference: refBars ? `${refBars} bars` : '?', fix: null, note: 'no section plan or energy curve to compare' };
  const wsum = parts.reduce((s, x) => s + x[0], 0);
  const score = Math.round((100 * parts.reduce((s, x) => s + x[0] * x[1], 0)) / wsum);
  const first = range.start / barTicks;
  const fixes: string[] = [];
  if (bounds && bounds.f1 < 0.8) {
    const want = plan.filter((s) => s.startBar <= projBars).map((s) => `${s.label}@${s.startBar + first}`);
    fixes.push(
      `start the sections where the reference does (bars ${want.slice(0, 10).join(', ')}): ${bounds.missing.length ? `no change at bar${bounds.missing.length > 1 ? 's' : ''} ${bounds.missing.slice(0, 6).map((b) => b + first).join(', ')}` : ''}${bounds.missing.length && bounds.extra.length ? '; ' : ''}${bounds.extra.length ? `extra change${bounds.extra.length > 1 ? 's' : ''} at ${bounds.extra.slice(0, 6).map((b) => b + first).join(', ')}` : ''} (arrange / restructure_song insert_bars / remove_clips {"close_gap":true}, then add_marker)`,
    );
  }
  if (lenRatio !== null && lenRatio < 0.85 && refBars) fixes.push(`the reference runs ${refBars} bars, yours ${projBars}: ${projBars < refBars ? 'extend it (more sections like the reference plan)' : 'cut a repeated section'}`);
  if (corr !== null && corr < 0.6 && worstBars) fixes.push(`bars ${worstBars.from + first}-${worstBars.to + first} should be ${worstBars.dir} against the rest, like the reference (${worstBars.dir === 'quieter' ? 'drop the drums / bass there' : 'add the full drums, bass and a layer'})`);
  return {
    id: 'arrangement',
    score,
    measured: `${projBars} bars${corr !== null ? `, energy correlation ${corr}` : ''}${bounds ? `, boundaries ${Math.round(bounds.f1 * 100)}% within a bar` : ''}`,
    reference: `${refBars ?? '?'} bars, sections at ${plan.map((s) => s.startBar + first).slice(0, 10).join(', ') || '?'}`,
    fix: fixes.length ? fixes.join(' · ') : null,
    detail: { correlation: corr, boundaries: bounds, lengthRatio: lenRatio === null ? null : r2(lenRatio) },
  };
}

// ── Mix ─────────────────────────────────────────────────────────────────

const BANDS = ['sub', 'low', 'lowMid', 'highMid', 'high'] as const;

/** Each group's level relative to the power sum of the groups both sides share (dB). */
export function relativeGroups(levels: GroupLevels, only?: readonly PartGroup[]): GroupLevels {
  const keys = (only ?? PART_GROUPS).filter((g) => isNum(levels[g]) && levels[g]! > -70);
  if (!keys.length) return {};
  const total = 10 * Math.log10(keys.reduce((s, g) => s + Math.pow(10, levels[g]! / 10), 0));
  return Object.fromEntries(keys.map((g) => [g, r1(levels[g]! - total)]));
}

/** Per-group difference (ours − reference) of the relative balance over the groups both have. */
export function balanceDiff(project: GroupLevels, reference: GroupLevels): GroupLevels {
  const common = PART_GROUPS.filter((g) => isNum(project[g]) && project[g]! > -70 && isNum(reference[g]) && reference[g]! > -70);
  if (common.length < 2) return {};
  const a = relativeGroups(project, common);
  const b = relativeGroups(reference, common);
  return Object.fromEntries(common.map((g) => [g, r1(a[g]! - b[g]!)]));
}

function mixDim(input: ClosenessInput): ClosenessDim {
  const a = input.render;
  const m = input.reference.brief.mix;
  if (!a || !isNum(a.lufsIntegrated) || a.lufsIntegrated < -60) return { id: 'mix', score: null, measured: '', reference: '', fix: null, note: 'the render has no loudness / spectrum analysis' };
  const parts: Array<[number, number]> = [];
  const said: string[] = [];
  const ref: string[] = [];
  const fixes: string[] = [];
  let bandDiff: Record<string, number> | null = null;
  if (m.bandsVsMid && isNum(a.bands?.mid)) {
    const ds = BANDS.filter((k) => isNum(m.bandsVsMid![k]) && isNum(a.bands[k])).map((k) => [k, r1(a.bands[k] - a.bands.mid - m.bandsVsMid![k]!)] as const);
    if (ds.length) {
      bandDiff = Object.fromEntries(ds);
      const mad = ds.reduce((s, [, d]) => s + Math.abs(d), 0) / ds.length;
      parts.push([0.35, clamp01(1 - mad / 8)]);
      said.push(`bands ${ds.map(([k, d]) => `${k} ${sgn(d)}`).join(' ')} dB vs the reference`);
    }
  }
  const balance = input.balance ? balanceDiff(input.balance.project, input.balance.reference) : {};
  const bk = Object.keys(balance) as PartGroup[];
  if (bk.length >= 2) {
    const mad = bk.reduce((s, g) => s + Math.abs(balance[g]!), 0) / bk.length;
    parts.push([0.3, clamp01(1 - mad / 8)]);
    said.push(`balance ${bk.map((g) => `${g} ${sgn(balance[g]!)}`).join(' ')} dB`);
    const worst = bk.filter((g) => Math.abs(balance[g]!) >= 2).sort((x, y) => Math.abs(balance[y]!) - Math.abs(balance[x]!));
    if (worst.length) fixes.push(`${worst.map((g) => `${g} ${balance[g]! > 0 ? `${r1(balance[g]!)} dB too loud` : `${r1(-balance[g]!)} dB too quiet`}`).join(', ')} against the rest`);
  }
  if (isNum(m.lufs)) {
    const d = a.lufsIntegrated - m.lufs;
    parts.push([0.2, clamp01(1 - Math.abs(d) / 8)]);
    said.push(`${r1(a.lufsIntegrated)} LUFS`);
    ref.push(`${m.lufs} LUFS`);
  }
  if (isNum(m.width) && isNum(a.stereoWidth)) {
    const d = a.stereoWidth - m.width;
    parts.push([0.15, clamp01(1 - Math.abs(d) / 0.3)]);
    said.push(`width ${r2(a.stereoWidth)}`);
    ref.push(`width ${m.width}`);
  }
  if (!parts.length) return { id: 'mix', score: null, measured: '', reference: '', fix: null, note: "the reference's mix numbers are missing" };
  const wsum = parts.reduce((s, x) => s + x[0], 0);
  const score = Math.round((100 * parts.reduce((s, x) => s + x[0] * x[1], 0)) / wsum);
  return {
    id: 'mix',
    score,
    measured: said.join(', '),
    reference: ref.join(', ') || 'its stems and bands',
    fix: score < 95 ? `match_mix ${j({ rounds: 2 })}${fixes.length ? ` (${fixes.join('; ')})` : ''}` : null,
    ...(input.balanceNote && bk.length < 2 ? { note: input.balanceNote } : {}),
    detail: { bands: bandDiff, balance: bk.length ? balance : null },
  };
}

// ── Sounds ──────────────────────────────────────────────────────────────

function soundsDim(input: ClosenessInput): ClosenessDim {
  const s = input.sounds;
  if (!s?.length) return { id: 'sounds', score: null, measured: '', reference: '', fix: null, note: input.soundsNote ?? 'sound fingerprints are not available in this build (match_sounds compares the sounds part by part)' };
  const score = Math.round((100 * s.reduce((x, y) => x + clamp01(y.similarity), 0)) / s.length);
  const worst = s.slice().sort((x, y) => x.similarity - y.similarity)[0];
  return {
    id: 'sounds',
    score,
    measured: s.map((x) => `${x.part} ${Math.round(x.similarity * 100)}%`).join(', '),
    reference: 'its stems, part by part',
    fix: worst && worst.similarity < 0.8 ? (worst.fix ?? `match_sounds ${j({ apply: true })} (${worst.part} is the furthest: ${Math.round(worst.similarity * 100)}%)`) : null,
  };
}

// ── All together ────────────────────────────────────────────────────────

export function computeCloseness(input: ClosenessInput): Closeness {
  const p = input.project;
  const { brief, analysis } = input.reference;
  const barTicks = ticksPerBar(p.transport.timeSig);
  const projBars = Math.max(1, Math.round((input.range.end - input.range.start) / barTicks));
  const factor = readingFactor(p.transport.bpm, brief.detectedBpm);
  // A bar-range review (bars 33-64) lines up with the same bars of the reference: the plan in range-relative bars.
  const off = Math.max(0, Math.round(input.range.start / barTicks));
  const plan = planAt(brief, factor)
    .map((s) => (s.startBar - off < 1 ? { ...s, startBar: 1, bars: s.bars - (1 - (s.startBar - off)) } : { ...s, startBar: s.startBar - off }))
    .filter((s) => s.bars > 0);
  const bpb = brief.beatsPerBar || 4;
  const refBars0 = plan.length ? plan[plan.length - 1].startBar + plan[plan.length - 1].bars - 1 : brief.detectedBpm ? Math.round((analysis.durationSec * brief.detectedBpm * factor) / 60 / bpb) - off : null;
  const refBars = refBars0 !== null && refBars0 > 0 ? refBars0 : null;
  const pitched = [...new Set(songNotes(p, input.range.start, input.range.end).filter((c) => !c.drum && !feelRoleOf({ name: c.name }, false)).map((c) => c.name))];
  const key = keyDim(input.projectKey, brief, pitched, homeChord(projectBarChords(p, input.range.start, input.range.end)));
  const dims: ClosenessDim[] = [
    tempoDim(p.transport.bpm, brief),
    key,
    grooveDim(input, factor),
    harmonyDim(input, factor, plan, projBars, key.detail && (key.detail.relation === 'move' || key.detail.relation === 'relative') ? (key.detail.semitones as number) || null : null, off),
    arrangementDim(input, factor, plan, projBars, refBars, off),
    soundsDim(input),
    mixDim(input),
  ];
  const measured = dims.filter((d) => d.score !== null);
  const wsum = measured.reduce((s, d) => s + CLOSENESS_WEIGHTS[d.id], 0);
  const overall = wsum > 0 ? Math.round(measured.reduce((s, d) => s + CLOSENESS_WEIGHTS[d.id] * d.score!, 0) / wsum) : null;
  const topFixes = measured
    .filter((d) => d.fix && d.score! < 95)
    .map((d) => ({ dim: d.id, gain: r1((CLOSENESS_WEIGHTS[d.id] * (100 - d.score!)) / (wsum || 1)), fix: d.fix! }))
    .sort((x, y) => y.gain - x.gain || DIM_ORDER.indexOf(x.dim) - DIM_ORDER.indexOf(y.dim));
  return { overall, dims, topFixes };
}

/** One line per dimension for review_song's text. */
export function closenessLines(c: Closeness): string[] {
  const out = [`CLOSENESS to the reference: ${c.overall ?? '?'}/100 (tempo, key, groove, harmony, arrangement, sounds, mix)`];
  for (const d of c.dims) {
    out.push(`  ${d.id.padEnd(11)} ${d.score === null ? '  –' : String(d.score).padStart(3)}  ${d.score === null ? `not measured: ${d.note ?? '?'}` : `yours ${d.measured || '?'} · reference ${d.reference || '?'}${d.note ? ` (${d.note})` : ''}`}`);
  }
  return out;
}

/** The parts' stem group: vocals by name, drums by role / drum channel, bass / 808 / sub, else other. */
export function partGroupOf(ch: Channel): PartGroup {
  const n = ch.name;
  if (/\b(vox|vocals?|voice|acapella|choir|rap|singer|lyrics?)\b/i.test(n)) return 'vocals';
  const role = roleFromName(n);
  if (role === 'bass' || role === '808' || role === 'sub') return 'bass';
  if (role && DRUM_ROLES.has(role)) return 'drums';
  if (role === 'vox') return 'vocals';
  if (!role && isDrumChannel(ch) && ch.generator.type !== 'krypt.audioclip') return 'drums';
  if (/\b(drums?|beat|loop|break)\b/i.test(n)) return 'drums';
  return 'other';
}

/**
 * Which group each insert of a stem render stands for: the group of the channels routed straight into it (the
 * majority; ties → other). Inserts no channel plays into (buses, send returns) and the reference's insert are left
 * out, so nothing is counted twice.
 */
export function insertGroups(p: Project, exclude: ReadonlySet<string> = new Set()): Map<string, PartGroup> {
  const votes = new Map<string, Map<PartGroup, number>>();
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    if (!ch || exclude.has(id) || ch.mute) continue;
    const ins = p.mixer.inserts[ch.insertId];
    if (!ins || ins.isMaster) continue;
    const g = partGroupOf(ch);
    const v = votes.get(ins.id) ?? new Map<PartGroup, number>();
    v.set(g, (v.get(g) ?? 0) + 1);
    votes.set(ins.id, v);
  }
  const out = new Map<string, PartGroup>();
  for (const [ins, v] of votes) {
    const best = [...v.entries()].sort((a, b) => b[1] - a[1]);
    out.set(ins, best.length > 1 && best[0][1] === best[1][1] ? 'other' : best[0][0]);
  }
  return out;
}

/** Group levels (power sum per group, dB) from per-insert levels. */
export function groupLevelsOf(levels: ReadonlyArray<{ insertId: string; db: number | null }>, groups: ReadonlyMap<string, PartGroup>): GroupLevels {
  const acc: Partial<Record<PartGroup, number>> = {};
  for (const l of levels) {
    const g = groups.get(l.insertId);
    if (!g || !isNum(l.db) || l.db < -70) continue;
    acc[g] = (acc[g] ?? 0) + Math.pow(10, l.db / 10);
  }
  return Object.fromEntries(Object.entries(acc).map(([g, pw]) => [g, r1(10 * Math.log10(pw!))])) as GroupLevels;
}

