import type { MashupAnchor, MashupCheck, MashupPlanSummary, MashupRequest, MashupSongReading, MashupStem, MashupStyle, StemPick } from './types';
import type { WarpMode } from '../schema/warp';
import type { TransitionKind } from '../playbooks/types';
import { fmtSemitones, keyLongName, keyShift, keyShortName, relativeMajorPc, toKeyRef, transposeKey, type KeyRef } from '../music/keymatch';
import { KEY_WEAK } from '../vocals/plan';
import { snapBpm } from '../analyzer/tempo';
import { estimateKey } from '../kpn/symbolic';

const NO_VOCAL = 0.1;

export type Side = 'a' | 'b';
export type Factor = 1 | 0.5 | 2;

export interface SongGrid {
  beats: number[];
  downbeats: number[];
  beatsPerBar: number;
}

export interface SongInput {
  name: string;
  path?: string;
  durationSec: number;
  bpm: number | null;
  bpmAlternatives: number[];
  key: string | null;
  keyConfidence: number;
  vocalPresence: number;
  vocalSource: 'stems' | 'name' | 'unknown';
  kind: 'song' | 'acapella' | 'instrumental';
  stems: MashupStem[];
  canSeparate: boolean;
  grid: SongGrid | null;
  sections: Array<{ startSec: number; endSec: number; label: string; lufs: number; vocal?: number | null }>;
  problem?: string;
  harmony?: { vocal?: StemHarmony | null; bed?: StemHarmony | null };
  lufs?: number | null;
}

export interface StemHarmony {
  profile: number[];
  key: string | null;
  keyConfidence: number;
}

export interface PlannedClip {
  startBar: number;
  bars: number;
  songBar: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface PlannedTrack {
  song: Side;
  part: MashupStem | 'mix';
  role: 'vocal' | 'drums' | 'bass' | 'other' | 'mix';
  name: string;
  warp: WarpMode;
  semitones: number;
  formant: boolean;
  gainDb: number;
  clips: PlannedClip[];
}

export interface PlannedSection {
  name: string;
  startBar: number;
  bars: number;
  energy: number;
  uses: string;
}

export interface SongDecision {
  factor: Factor;
  srcBpm: number | null;
  speed: number;
  semitones: number;
  needStems: MashupStem[];
}

export interface BuildPlan {
  style: MashupStyle;
  vocalFrom: Side | null;
  bpm: number;
  key: string | null;
  bars: number;
  songs: Record<Side, SongDecision>;
  tracks: PlannedTrack[];
  sections: PlannedSection[];
  transitions: Array<{ bar: number; kind: TransitionKind; prevBars: number }>;
  tune: 'off' | 'natural' | 'pop' | 'hard';
  tuneKey: string | null;
  notes: string[];
}

export interface MashupPlanResult {
  check: MashupCheck;
  build: BuildPlan;
}

export const CLEAN_STRETCH = [0.85, 1.18] as const;
export const VOCAL_SHIFT_COMFORT = 3;
export const MAX_BARS = 512;
export const MIX_LUFS = -14;
export const VOCAL_LIFT_DB = 1;
export const HARMONY_GOOD = 0.6;
export const DEFAULT_MAX_BARS = 128;
const FACTORS: Factor[] = [1, 0.5, 2];
const STEMS: MashupStem[] = ['vocals', 'drums', 'bass', 'other'];
const BED_STEMS: MashupStem[] = ['drums', 'bass', 'other'];

const r2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number): number => clamp(x, 0, 1);
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
const short = (s: string, n = 28): string => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);
const letter = (s: Side): string => s.toUpperCase();

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Track {
  beats: number[];
  d: number;
  period: number;
}

function trackOf(grid: SongGrid | null, bpm: number | null): Track {
  const beats = (grid?.beats ?? []).filter((t) => Number.isFinite(t) && t >= 0).sort((x, y) => x - y);
  if (beats.length >= 2) {
    const period = median(beats.slice(1).map((t, i) => t - beats[i])) || 0.5;
    const db = grid?.downbeats?.find((t) => Number.isFinite(t) && t >= 0);
    let d = 0;
    if (db !== undefined) {
      let best = Infinity;
      beats.forEach((t, i) => {
        if (Math.abs(t - db) < best) {
          best = Math.abs(t - db);
          d = i;
        }
      });
    }
    return { beats, d, period };
  }
  return { beats: [], d: 0, period: 60 / (bpm && bpm > 0 ? bpm : 120) };
}

function secOfIndex(t: Track, f: number): number {
  const n = t.beats.length;
  if (!n) return f * t.period;
  if (f <= 0) return t.beats[0] + f * t.period;
  if (f >= n - 1) return t.beats[n - 1] + (f - (n - 1)) * t.period;
  const i = Math.floor(f);
  return t.beats[i] + (f - i) * (t.beats[i + 1] - t.beats[i]);
}

function indexOfSec(t: Track, sec: number): number {
  const n = t.beats.length;
  if (!n) return sec / t.period;
  if (sec <= t.beats[0]) return (sec - t.beats[0]) / t.period;
  if (sec >= t.beats[n - 1]) return n - 1 + (sec - t.beats[n - 1]) / t.period;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t.beats[m] <= sec) lo = m;
    else hi = m;
  }
  return lo + (sec - t.beats[lo]) / (t.beats[hi] - t.beats[lo]);
}

export function songBarToSec(grid: SongGrid | null, bpm: number | null, factor: Factor, bar: number): number {
  const t = trackOf(grid, bpm);
  return secOfIndex(t, t.d + (4 * bar) / factor);
}

export function secToSongBar(grid: SongGrid | null, bpm: number | null, factor: Factor, sec: number): number {
  const t = trackOf(grid, bpm);
  return ((indexOfSec(t, sec) - t.d) * factor) / 4;
}

export function songBars(s: SongInput, factor: Factor): number {
  return Math.max(0, Math.floor(secToSongBar(s.grid, s.bpm, factor, s.durationSec) + 1e-6));
}

export interface SongSection {
  name: string;
  label: string;
  startBar: number;
  bars: number;
  energy: number;
  vocal: boolean;
}

const snap4 = (bar: number): number => Math.round(bar / 4) * 4;

export function songSections(s: SongInput, factor: Factor): SongSection[] {
  const total = songBars(s, factor);
  if (total < 1) return [];
  const raw = [...s.sections].filter((x) => Number.isFinite(x.startSec) && Number.isFinite(x.endSec) && x.endSec > x.startSec).sort((x, y) => x.startSec - y.startSec);
  type Raw = { start: number; label: string; lufs: number; vocal: number | null };
  const cuts: Raw[] = [];
  for (const x of raw) {
    let start = snap4(secToSongBar(s.grid, s.bpm, factor, x.startSec));
    if (!cuts.length) start = 0;
    start = clamp(start, 0, total);
    if (start >= total) continue;
    const prev = cuts[cuts.length - 1];
    if (prev && start <= prev.start) {
      if (x.lufs > prev.lufs) Object.assign(prev, { label: x.label, lufs: x.lufs, vocal: x.vocal ?? prev.vocal });
      continue;
    }
    cuts.push({ start, label: x.label || '?', lufs: Number.isFinite(x.lufs) ? x.lufs : -20, vocal: x.vocal ?? null });
  }
  if (!cuts.length) cuts.push({ start: 0, label: 'A', lufs: -14, vocal: null });
  const lufs = cuts.map((c) => c.lufs);
  const lo = Math.min(...lufs);
  const hi = Math.max(...lufs);
  const flat = hi - lo < 1.5;
  const secs: SongSection[] = cuts.map((c, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].start : total;
    const energy = flat ? 0.8 : r2(0.15 + 0.85 * ((c.lufs - lo) / (hi - lo)));
    return { name: '', label: c.label, startBar: c.start, bars: end - c.start, energy, vocal: false };
  });
  const measured = cuts.some((c) => c.vocal !== null);
  secs.forEach((x, i) => {
    const v = cuts[i].vocal;
    if (s.kind === 'acapella') x.vocal = true;
    else if (s.kind === 'instrumental') x.vocal = false;
    else if (measured) x.vocal = v !== null && v >= 0.5;
    else if (s.vocalPresence >= 0.3) x.vocal = !((i === 0 || i === secs.length - 1) && secs.length > 2 && x.energy < 0.5);
    else x.vocal = false;
  });
  const names = nameSections(secs);
  secs.forEach((x, i) => (x.name = names[i]));
  return secs;
}

export function nameSections(secs: Array<{ label: string; energy: number; vocal: boolean }>): string[] {
  if (!secs.length) return [];
  const anyVocal = secs.some((x) => x.vocal);
  let top = 0;
  secs.forEach((x, i) => {
    if (x.energy > secs[top].energy) top = i;
  });
  const hookLabel = secs[top].label;
  const base = secs.map((x, i) => {
    const n = secs.length;
    if (i === 0 && n > 2 && x.energy < 0.6 && x.label !== hookLabel) return 'Intro';
    if (i === n - 1 && n > 2 && x.energy < 0.6 && x.label !== hookLabel) return 'Outro';
    if (x.label === hookLabel && x.energy >= secs[top].energy - 0.15) return anyVocal ? 'Chorus' : 'Drop';
    if (x.energy < 0.4) return 'Break';
    if (x.vocal) return 'Verse';
    const next = secs[i + 1];
    return next && next.label === hookLabel ? 'Build' : 'Groove';
  });
  const count = new Map<string, number>();
  for (const b of base) count.set(b, (count.get(b) ?? 0) + 1);
  const seen = new Map<string, number>();
  return base.map((b) => {
    if ((count.get(b) ?? 0) < 2) return b;
    const k = (seen.get(b) ?? 0) + 1;
    seen.set(b, k);
    return `${b} ${k}`;
  });
}

export interface TempoDecision {
  bpm: number;
  a: { factor: Factor; srcBpm: number | null; speed: number };
  b: { factor: Factor; srcBpm: number | null; speed: number };
}

const dist = (x: number, y: number): number => Math.abs(Math.log2(x / y));

function bestFactor(bpm: number, target: number, fixed: Factor | undefined): Factor {
  if (fixed) return fixed;
  let best: Factor = 1;
  for (const f of FACTORS) if (dist(bpm * f, target) < dist(bpm * best, target) - 1e-9) best = f;
  return best;
}

export function decideTempo(a: SongInput, b: SongInput, anchorSide: Side | null, opts: { bpm?: number; factorA?: Factor; factorB?: Factor } = {}): TempoDecision {
  const bA = a.bpm && a.bpm > 0 ? a.bpm : null;
  const bB = b.bpm && b.bpm > 0 ? b.bpm : null;
  const fixed: Record<Side, Factor | undefined> = { a: opts.factorA, b: opts.factorB };
  const src: Record<Side, number | null> = { a: bA, b: bB };
  let target: number;
  const fac: Record<Side, Factor> = { a: fixed.a ?? 1, b: fixed.b ?? 1 };
  if (opts.bpm && opts.bpm > 0) {
    target = opts.bpm;
    for (const s of ['a', 'b'] as Side[]) if (src[s]) fac[s] = bestFactor(src[s]!, target, fixed[s]);
  } else if (bA && bB) {
    if (anchorSide) {
      const o = other(anchorSide);
      target = src[anchorSide]! * fac[anchorSide];
      fac[o] = bestFactor(src[o]!, target, fixed[o]);
    } else {
      let best: { fa: Factor; fb: Factor; d: number } | null = null;
      for (const fb of fixed.b ? [fixed.b] : FACTORS)
        for (const fa of fixed.a ? [fixed.a] : FACTORS) {
          const d = dist(bA * fa, bB * fb);
          if (!best || d < best.d - 1e-9) best = { fa, fb, d };
        }
      fac.a = best!.fa;
      fac.b = best!.fb;
      target = Math.sqrt(bA * fac.a * bB * fac.b);
    }
  } else if (bA || bB) {
    const s: Side = bA ? 'a' : 'b';
    target = src[s]! * fac[s];
  } else target = 120;
  target = clamp(snapBpm(target), 10, 999);
  const side = (s: Side) => ({ factor: fac[s], srcBpm: src[s] ? r2(src[s]! * fac[s]) : null, speed: src[s] ? target / (src[s]! * fac[s]) : 1 });
  return { bpm: target, a: side('a'), b: side('b') };
}

function worstStretch(t: TempoDecision): number {
  return Math.max(Math.abs(Math.log2(t.a.speed || 1)), Math.abs(Math.log2(t.b.speed || 1)));
}

export function chooseTempo(req: MashupRequest, a: SongInput, b: SongInput, anchorSide: Side | null): TempoDecision & { halfway: boolean } {
  const opts = { bpm: req.bpm, factorA: req.factorA, factorB: req.factorB };
  const t = decideTempo(a, b, anchorSide, opts);
  if (req.anchor !== undefined || req.bpm || !anchorSide || !a.bpm || !b.bpm || !(audibleStretch(t.a.speed) || audibleStretch(t.b.speed))) return { ...t, halfway: false };
  const m = decideTempo(a, b, null, opts);
  return worstStretch(m) < worstStretch(t) - Math.log2(1.05) ? { ...m, halfway: true } : { ...t, halfway: false };
}

export function audibleStretch(speed: number): boolean {
  return speed < CLEAN_STRETCH[0] - 1e-9 || speed > CLEAN_STRETCH[1] + 1e-9;
}

function stretchPenalty(speed: number): number {
  const d = Math.abs(Math.log2(speed));
  const a = Math.log2(1.03);
  const b = speed >= 1 ? Math.log2(CLEAN_STRETCH[1]) : Math.log2(1 / CLEAN_STRETCH[0]);
  if (d <= a) return 0;
  if (d <= b) return (15 * (d - a)) / (b - a);
  return Math.min(40, 15 + (25 * (d - b)) / (Math.log2(1.5) - b));
}

export function fifthsDistance(x: KeyRef, y: KeyRef): number {
  const d = (((relativeMajorPc(y) - relativeMajorPc(x)) * 7) % 12 + 12) % 12;
  return Math.min(d, 12 - d);
}

export function camelot(k: KeyRef): string {
  const n = (((relativeMajorPc(k) * 7) % 12) + 7) % 12 + 1;
  return `${n}${k.minor ? 'A' : 'B'}`;
}

function clashCost(fd: number): number {
  return fd === 0 ? 0 : fd === 1 ? 8 : fd === 2 ? 22 : fd === 3 ? 32 : 40;
}

function shiftCost(s: number, vocal: boolean): number {
  const m = Math.abs(s);
  return vocal ? 2 * m + (m > VOCAL_SHIFT_COMFORT ? 6 * (m - VOCAL_SHIFT_COMFORT) : 0) : 3 * m + (m > 2 ? 6 * (m - 2) : 0);
}

export interface KeyMove {
  semitones: number;
  leftover: number;
  cost: number;
}

export function bestKeyMove(from: KeyRef, to: KeyRef, vocal: boolean): KeyMove {
  let best: KeyMove | null = null;
  for (let s = -6; s <= 6; s++) {
    const leftover = fifthsDistance(transposeKey(from, s), to);
    const cost = clashCost(leftover) + shiftCost(s, vocal);
    const better = !best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && (Math.abs(s) < Math.abs(best.semitones) || (Math.abs(s) === Math.abs(best.semitones) && s < best.semitones)));
    if (better) best = { semitones: s, leftover, cost };
  }
  return best!;
}

export interface KeyDecision {
  a: number;
  b: number;
  key: string | null;
  vocalKey: string | null;
  leftover: number;
  reason: string;
  penalty: number;
  weak: boolean;
  measured?: { fit: number; fit0: number; vocalKeyConfidence: number };
}

export function decideKey(songs: Record<Side, SongInput>, bed: Side, anchor: MashupAnchor, opts: { key?: string; moverIsVocal: boolean }): KeyDecision {
  const mover = other(bed);
  const kB = toKeyRef(songs[bed].key);
  const kM = toKeyRef(songs[mover].key);
  const name = (s: Side) => `${letter(s)}`;
  const weak = (!!kB && songs[bed].keyConfidence < KEY_WEAK) || (!!kM && songs[mover].keyConfidence < KEY_WEAK);
  const out = (sb: number, sm: number, key: KeyRef | null, vocalKey: KeyRef | null, leftover: number, reason: string, penalty: number): KeyDecision => ({
    a: bed === 'a' ? sb : sm,
    b: bed === 'b' ? sb : sm,
    key: key ? keyShortName(key) : null,
    vocalKey: vocalKey ? keyShortName(vocalKey) : null,
    leftover,
    reason,
    penalty: Math.min(30, penalty + (weak ? 5 : 0)),
    weak,
  });
  const given = opts.key?.trim() ? toKeyRef(opts.key.trim()) : null;
  if (given) {
    const exact = (k: KeyRef): KeyMove => ({ semitones: keyShift(k, given).semitones, leftover: 0, cost: 0 });
    const mb = kB ? exact(kB) : null;
    const mm = kM ? exact(kM) : null;
    const sb = mb?.semitones ?? 0;
    const sm = mm?.semitones ?? 0;
    const parts = [kB ? `${name(bed)} ${fmtSemitones(sb)}` : `${name(bed)} has no clear key (left alone)`, kM ? `${name(mover)} ${fmtSemitones(sm)}` : `${name(mover)} has no clear key (left alone)`];
    const vk = kM ? transposeKey(kM, sm) : given;
    return out(sb, sm, given, opts.moverIsVocal ? vk : kB ? transposeKey(kB, sb) : given, Math.max(mb?.leftover ?? 0, mm?.leftover ?? 0), `Key: both onto ${keyLongName(given)} as asked: ${parts.join(', ')}.`, keyPenalty(Math.max(Math.abs(sb), Math.abs(sm)), Math.max(mb?.leftover ?? 0, mm?.leftover ?? 0)));
  }
  if (opts.moverIsVocal) {
    const h = decideKeyByHarmony(songs, bed, anchor);
    if (h) return h;
  }
  if (!kB || !kM) {
    const which = !kB && !kM ? 'neither song has a clear key' : `${name(!kB ? bed : mover)} has no clear key`;
    const k = kB ?? (kM ? kM : null);
    return out(0, 0, kB ?? k, opts.moverIsVocal ? kM : kB, 0, `Key: ${which}, so nothing is pitched: listen, and pass key (e.g. "F#m") if it clashes.`, 10);
  }
  const m = bestKeyMove(kM, kB, opts.moverIsVocal);
  const S = m.semitones;
  let sm = S;
  let sb = 0;
  if (anchor === 'vocal') {
    const mb = bestKeyMove(kB, kM, !opts.moverIsVocal);
    sb = mb.semitones;
    sm = 0;
    const key = transposeKey(kB, sb);
    const rel = relation(kB, kM, mb.leftover, sb);
    return out(sb, 0, key, kM, mb.leftover, `Key: ${keyLongName(kM)} (${name(mover)}) stays; ${name(bed)} (${keyLongName(kB)}) ${rel}.`, keyPenalty(Math.abs(sb), mb.leftover));
  }
  if (anchor === 'middle' && S !== 0) {
    sm = Math.sign(S) * Math.ceil(Math.abs(S) / 2);
    sb = -(S - sm);
  }
  const key = transposeKey(kB, sb);
  const vocalKey = transposeKey(kM, sm);
  let reason: string;
  if (S === 0 && m.leftover === 0) {
    reason = kB.pc === kM.pc && kB.minor === kM.minor ? `Key: both in ${keyLongName(kB)}: no pitch change.` : `Key: ${keyLongName(kM)} and ${keyLongName(kB)} share their notes (relative ${kM.minor ? 'major' : 'minor'}): no pitch change.`;
  } else if (S === 0) {
    reason = `Key: ${keyLongName(kM)} (${camelot(kM)}) and ${keyLongName(kB)} (${camelot(kB)}) are Camelot neighbours: no pitch change, a little extra colour.`;
  } else if (anchor === 'middle') {
    reason = `Key: met half way: ${name(mover)} ${fmtSemitones(sm)} (${keyLongName(kM)} → ${keyLongName(vocalKey)}), ${name(bed)} ${fmtSemitones(sb)} (${keyLongName(kB)} → ${keyLongName(key)})${m.leftover ? ' (Camelot neighbours after the move)' : ''}.`;
  } else {
    reason = `Key: ${name(mover)} moves ${fmtSemitones(S)} (${keyLongName(kM)} → ${keyLongName(vocalKey)}) ${m.leftover ? `next to ${name(bed)}'s ${keyLongName(kB)} (Camelot neighbours)` : `onto ${name(bed)}'s ${keyLongName(kB)}${vocalKey.minor !== kB.minor ? ' (relative keys: the same notes)' : ''}`}.`;
  }
  return out(sb, sm, key, vocalKey, m.leftover, reason, keyPenalty(Math.max(Math.abs(sm), Math.abs(sb)), m.leftover));
}

function relation(from: KeyRef, to: KeyRef, leftover: number, s: number): string {
  if (s === 0) return leftover === 0 ? 'already shares its notes: no pitch change' : `is a Camelot neighbour (${camelot(from)} / ${camelot(to)}): no pitch change`;
  return `moves ${fmtSemitones(s)} to ${keyLongName(transposeKey(from, s))}${leftover ? ' (Camelot neighbours after the move)' : ''}`;
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (!n) return 0;
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

export function profileFit(vocal: number[], bed: number[], s: number): number {
  const rolled = new Array<number>(12).fill(0);
  for (let i = 0; i < 12; i++) rolled[(((i + s) % 12) + 12) % 12] = vocal[i] ?? 0;
  return pearson(rolled, bed);
}

export function goodProfile(p: number[] | null | undefined): p is number[] {
  return Array.isArray(p) && p.length === 12 && p.every((v) => Number.isFinite(v) && v >= 0) && p.some((v) => v > 0);
}

export function sumProfiles(parts: Array<number[] | null | undefined>): number[] | null {
  const ok = parts.filter(goodProfile);
  if (!ok.length) return null;
  const out = new Array<number>(12).fill(0);
  for (const p of ok) {
    const t = p.reduce((s, v) => s + v, 0);
    for (let i = 0; i < 12; i++) out[i] += p[i] / t;
  }
  const t = out.reduce((s, v) => s + v, 0);
  return out.map((v) => v / t);
}

export interface HarmonyMove {
  semitones: number;
  fit: number;
  fit0: number;
  cost: number;
}

const fitCost = (r: number): number => 40 * (1 - r);

export function bestHarmonyMove(vocal: number[], bed: number[], vocalMoves: boolean): HarmonyMove {
  let best: HarmonyMove | null = null;
  const fit0 = profileFit(vocal, bed, 0);
  for (let s = -6; s <= 6; s++) {
    const fit = profileFit(vocal, bed, s);
    const cost = fitCost(fit) + shiftCost(vocalMoves ? s : -s, vocalMoves);
    const better = !best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && (Math.abs(s) < Math.abs(best.semitones) || (Math.abs(s) === Math.abs(best.semitones) && s < best.semitones)));
    if (better) best = { semitones: s, fit, fit0, cost };
  }
  return best!;
}

function fitPenalty(fit: number): number {
  return fit >= HARMONY_GOOD ? 0 : fit >= 0.45 ? 6 : fit >= 0.3 ? 14 : 24;
}

const pct = (r: number): string => `${Math.round(clamp01(r) * 100)}%`;

function harmonyKey(h: StemHarmony): { key: KeyRef | null; confidence: number } {
  const k = toKeyRef(h.key);
  if (k) return { key: k, confidence: h.keyConfidence };
  const e = estimateKey(h.profile);
  return e ? { key: toKeyRef(e.key), confidence: e.confidence } : { key: null, confidence: 0 };
}

function decideKeyByHarmony(songs: Record<Side, SongInput>, bed: Side, anchor: MashupAnchor): KeyDecision | null {
  const mover = other(bed);
  const hv = songs[mover].harmony?.vocal;
  const hb = songs[bed].harmony?.bed;
  if (!hv || !hb || !goodProfile(hv.profile) || !goodProfile(hb.profile)) return null;
  const kv = harmonyKey(hv);
  const kb = harmonyKey(hb);
  const kM = kv.key ?? toKeyRef(songs[mover].key);
  const kB = kb.key ?? toKeyRef(songs[bed].key);
  const m = bestHarmonyMove(hv.profile, hb.profile, anchor !== 'vocal');
  let sm = m.semitones;
  let sb = 0;
  if (anchor === 'vocal') {
    sm = 0;
    sb = -m.semitones;
  } else if (anchor === 'middle' && m.semitones !== 0) {
    sm = Math.sign(m.semitones) * Math.ceil(Math.abs(m.semitones) / 2);
    sb = -(m.semitones - sm);
  }
  const key = kB ? transposeKey(kB, sb) : null;
  const vocalKey = kM ? transposeKey(kM, sm) : null;
  const V = letter(mover);
  const B = letter(bed);
  const kname = (k: KeyRef | null) => (k ? ` (${keyLongName(k)})` : '');
  const match = `the notes match ${pct(m.fit)}${m.semitones ? ` (unmoved: ${pct(m.fit0)})` : ''}`;
  let reason: string;
  if (m.semitones === 0) reason = `Key: measured on the stems: ${V}'s vocal${kname(kM)} fits ${B}'s instrumental${kname(kB)} as it is: ${match}.`;
  else if (anchor === 'vocal') reason = `Key: measured on the stems: ${V}'s vocal${kname(kM)} stays; ${B}'s instrumental${kname(kB)} moves ${fmtSemitones(sb)}: ${match}.`;
  else if (anchor === 'middle') reason = `Key: measured on the stems, met half way: ${V}'s vocal ${fmtSemitones(sm)}, ${B}'s instrumental ${fmtSemitones(sb)}${key ? ` (into ${keyLongName(key)})` : ''}: ${match}.`;
  else reason = `Key: measured on the stems: ${V}'s vocal${kname(kM)} moves ${fmtSemitones(sm)}${vocalKey ? ` (to ${keyLongName(vocalKey)})` : ''} to fit ${B}'s instrumental${kname(kB)}: ${match}.`;
  if (m.fit < 0.45) reason += ' Even the best shift leaves clashing notes: these two may not fit.';
  const weak = m.fit < 0.45 || kv.confidence < KEY_WEAK;
  return {
    a: bed === 'a' ? sb : sm,
    b: bed === 'b' ? sb : sm,
    key: key ? keyShortName(key) : null,
    vocalKey: vocalKey ? keyShortName(vocalKey) : null,
    leftover: m.fit >= HARMONY_GOOD ? 0 : 1,
    reason,
    penalty: Math.min(30, keyPenalty(Math.max(Math.abs(sm), Math.abs(sb)), 0) + fitPenalty(m.fit)),
    weak,
    measured: { fit: m.fit, fit0: m.fit0, vocalKeyConfidence: kv.confidence },
  };
}

function keyPenalty(maxShift: number, leftover: number): number {
  const shift = maxShift === 0 ? 0 : maxShift <= 2 ? 3 * maxShift : maxShift === 3 ? 10 : 10 + 5 * (maxShift - 3);
  return shift + (leftover === 1 ? 6 : leftover > 1 ? 15 : 0);
}

function vocalAvailable(s: SongInput): boolean {
  return s.kind === 'acapella' || s.stems.includes('vocals') || s.canSeparate;
}

function bedAvailable(s: SongInput): boolean {
  return s.kind === 'instrumental' || BED_STEMS.every((x) => s.stems.includes(x)) || s.canSeparate;
}

function directionScore(req: MashupRequest, songs: Record<Side, SongInput>, vocal: Side): number {
  const bed = other(vocal);
  const v = songs[vocal];
  const b = songs[bed];
  const anchor = req.anchor ?? 'beat';
  const t = chooseTempo(req, songs.a, songs.b, anchor === 'middle' ? null : anchor === 'beat' ? bed : vocal);
  const k = decideKey(songs, bed, anchor, { key: req.key, moverIsVocal: true });
  let s = 40 * clamp01(v.vocalPresence) + 20 * (b.kind === 'instrumental' || bedAvailable(b) ? 1 : 1 - clamp01(b.vocalPresence));
  s -= Math.max(stretchPenalty(t.a.speed), stretchPenalty(t.b.speed));
  s -= k.penalty;
  if (!vocalAvailable(v)) s -= 50;
  if (!bedAvailable(b)) s -= 30;
  return s;
}

export function chooseVocal(req: MashupRequest, songs: Record<Side, SongInput>): { side: Side; scores: Record<Side, number> } {
  const scores = { a: directionScore(req, songs, 'a'), b: directionScore(req, songs, 'b') };
  if (req.vocalFrom === 'a' || req.vocalFrom === 'b') return { side: req.vocalFrom, scores };
  return { side: scores.b > scores.a + 1e-9 ? 'b' : 'a', scores };
}

interface Mapped {
  sections: PlannedSection[];
  clips: Map<string, PlannedClip[]>;
  transitions: BuildPlan['transitions'];
}

const isHigh = (e: number, max: number): boolean => e >= Math.max(0.7, max - 0.12) || e >= max - 1e-9;

function targetBars(req: MashupRequest, natural: number): number {
  const want = req.bars && req.bars > 0 ? Math.round(req.bars) : Math.min(DEFAULT_MAX_BARS, natural);
  return clamp(Math.round(want / 4) * 4 || 4, 4, MAX_BARS);
}

function takeFrom(list: SongSection[], cursor: { i: number; off: number }, bars: number): Array<{ songBar: number; bars: number; name: string }> {
  const out: Array<{ songBar: number; bars: number; name: string }> = [];
  if (!list.length) return out;
  let left = bars;
  let guard = 0;
  while (left > 0 && guard++ < 256) {
    const s = list[cursor.i % list.length];
    const avail = s.bars - cursor.off;
    const n = Math.min(avail, left);
    out.push({ songBar: s.startBar + cursor.off, bars: n, name: s.name });
    left -= n;
    cursor.off += n;
    if (cursor.off >= s.bars) {
      cursor.i++;
      cursor.off = 0;
    }
  }
  return out;
}

function repeatSection(s: SongSection, bars: number): Array<{ songBar: number; bars: number }> {
  const out: Array<{ songBar: number; bars: number }> = [];
  for (let off = 0; off < bars; off += s.bars) out.push({ songBar: s.startBar, bars: Math.min(s.bars, bars - off) });
  return out;
}

function bedTimeline(bed: SongSection[], T: number): Array<SongSection & { kind: 'intro' | 'outro' | 'main' }> {
  const out: Array<SongSection & { kind: 'intro' | 'outro' | 'main' }> = [];
  for (const s of bed) {
    if (s.startBar >= T) break;
    const bars = Math.min(s.bars, T - s.startBar);
    if (bars < 1) continue;
    out.push({ ...s, bars, kind: 'main' });
  }
  if (!out.length) return out;
  const first = out[0];
  if (first.bars > 8 && out.length > 0) {
    out.splice(0, 1, { ...first, bars: 8, kind: 'intro' }, { ...first, startBar: first.startBar + 8, bars: first.bars - 8, kind: 'main' });
  } else if (out.length > 1) out[0] = { ...first, kind: 'intro' };
  const last = out[out.length - 1];
  if (out.length > 2 && last.kind === 'main') {
    if (last.bars > 12) out.splice(out.length - 1, 1, { ...last, bars: last.bars - 8, kind: 'main' }, { ...last, startBar: last.startBar + last.bars - 8, bars: 8, kind: 'outro' });
    else out[out.length - 1] = { ...last, kind: 'outro' };
  }
  return out;
}

function boundaryKind(prev: { energy: number; kind?: string }, next: { energy: number; kind?: string; high?: boolean }): TransitionKind {
  if (next.kind === 'break' || next.kind === 'outro') return 'downlifter';
  if (next.high && next.energy > prev.energy + 0.05) return 'riser';
  if (next.energy < prev.energy - 0.1) return 'downlifter';
  return 'crash';
}

function numbered(names: string[]): string[] {
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((n) => {
    if ((count.get(n) ?? 0) < 2 || n === 'Intro' || n === 'Outro') return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return `${n} ${k}`;
  });
}

function mapVocalOverBed(bed: SongSection[], voc: SongSection[], T: number, bedKeys: string[], vocalKey: string | null, names: { bed: string; vocal: string }): Mapped {
  const clips = new Map<string, PlannedClip[]>();
  for (const k of [...bedKeys, ...(vocalKey ? [vocalKey] : [])]) clips.set(k, []);
  const tl = bedTimeline(bed, T);
  const maxE = Math.max(0, ...tl.filter((s) => s.kind === 'main').map((s) => s.energy));
  const vocals = voc.filter((s) => s.vocal);
  let hook: SongSection | null = null;
  for (const s of vocals) if (!hook || s.energy > hook.energy + 1e-9) hook = s;
  const verses = vocals.filter((s) => !hook || s.label !== hook.label);
  const verseList = verses.length ? verses : hook ? [hook] : [];
  const highIdx = tl.map((s, i) => (s.kind === 'main' && isHigh(s.energy, maxE) ? i : -1)).filter((i) => i >= 0);
  let breakIdx = -1;
  if (highIdx.length >= 2) {
    for (let i = highIdx[0] + 1; i < highIdx[highIdx.length - 1]; i++) {
      if (tl[i].kind !== 'main' || highIdx.includes(i)) continue;
      if (tl[i].energy < 0.5 && (breakIdx < 0 || tl[i].energy < tl[breakIdx].energy)) breakIdx = i;
    }
  }
  const cursor = { i: 0, off: 0 };
  const rawNames: string[] = [];
  const sections: PlannedSection[] = [];
  const kinds: Array<{ energy: number; kind: string; high: boolean }> = [];
  let at = 1;
  tl.forEach((s, i) => {
    const high = highIdx.includes(i);
    const kind = s.kind === 'intro' ? 'intro' : s.kind === 'outro' ? 'outro' : i === breakIdx ? 'break' : high ? 'hook' : 'verse';
    for (const k of bedKeys) clips.get(k)!.push({ startBar: at, bars: s.bars, songBar: s.startBar });
    let uses = `${names.bed} instrumental`;
    if (vocalKey && (kind === 'hook' || kind === 'verse')) {
      const vc = clips.get(vocalKey)!;
      if (kind === 'hook' && hook) {
        let off = 0;
        for (const c of repeatSection(hook, s.bars)) {
          vc.push({ startBar: at + off, bars: c.bars, songBar: c.songBar });
          off += c.bars;
        }
        uses += ` + ${names.vocal} vocal (${hook.name})`;
      } else if (verseList.length) {
        let off = 0;
        const took = takeFrom(verseList, cursor, s.bars);
        for (const c of took) {
          vc.push({ startBar: at + off, bars: c.bars, songBar: c.songBar });
          off += c.bars;
        }
        uses += ` + ${names.vocal} vocal (${[...new Set(took.map((c) => c.name))].join(', ')})`;
      }
    }
    rawNames.push(kind === 'intro' ? 'Intro' : kind === 'outro' ? 'Outro' : kind === 'break' ? 'Break' : kind === 'hook' ? (vocalKey ? 'Chorus' : 'Drop') : vocalKey ? 'Verse' : s.name.replace(/\s+\d+$/, '') || 'Section');
    sections.push({ name: '', startBar: at, bars: s.bars, energy: s.energy, uses });
    kinds.push({ energy: s.energy, kind, high });
    at += s.bars;
  });
  const nm = numbered(rawNames);
  sections.forEach((s, i) => (s.name = nm[i]));
  const transitions: BuildPlan['transitions'] = [];
  for (let i = 1; i < sections.length; i++) transitions.push({ bar: sections[i].startBar, kind: boundaryKind(kinds[i - 1], kinds[i]), prevBars: sections[i - 1].bars });
  return { sections, clips, transitions };
}

function mapByEnergy(timeline: PlannedSection[], src: SongSection[], key: string, clips: Map<string, PlannedClip[]>, skip: Set<number> = new Set()): void {
  const list = clips.get(key) ?? [];
  clips.set(key, list);
  if (!src.length) return;
  let last = -1;
  timeline.forEach((s, i) => {
    if (skip.has(i)) return;
    let best = -1;
    src.forEach((x, j) => {
      if (best < 0) {
        best = j;
        return;
      }
      const dj = Math.abs(x.energy - s.energy) + (j === last ? 0.05 : 0);
      const db = Math.abs(src[best].energy - s.energy) + (best === last ? 0.05 : 0);
      if (dj < db - 1e-9) best = j;
    });
    last = best;
    let off = 0;
    for (const c of repeatSection(src[best], s.bars)) {
      list.push({ startBar: s.startBar + off, bars: c.bars, songBar: c.songBar });
      off += c.bars;
    }
  });
}

function mapBackAndForth(A: SongSection[], B: SongSection[], T: number, names: Record<Side, string>): Mapped {
  const clips = new Map<string, PlannedClip[]>([
    ['a:mix', []],
    ['b:mix', []],
  ]);
  const songsS: Record<Side, SongSection[]> = { a: A, b: B };
  const ranked = (list: SongSection[]): SongSection[] => {
    const mid = list.length > 2 ? list.slice(1, -1) : list;
    return [...mid].sort((x, y) => y.energy - x.energy || x.startBar - y.startBar);
  };
  const queue: Record<Side, SongSection[]> = { a: ranked(A), b: ranked(B) };
  const used: Record<Side, number> = { a: 0, b: 0 };
  const chunkBars = (s: SongSection): number => (s.bars >= 16 ? 16 : s.bars >= 8 ? 8 : Math.max(4, Math.floor(s.bars / 4) * 4));
  type Chunk = { side: Side; songBar: number; bars: number; energy: number; name: string; kind: 'intro' | 'main' | 'outro' };
  const chunks: Chunk[] = [];
  const intro = A[0] ?? B[0];
  const introSide: Side = A[0] ? 'a' : 'b';
  let total = 0;
  if (intro) {
    const bars = Math.min(8, Math.max(4, Math.floor(intro.bars / 4) * 4) || 4);
    chunks.push({ side: introSide, songBar: intro.startBar, bars, energy: intro.energy, name: 'Intro', kind: 'intro' });
    total += bars;
  }
  let side: Side = other(introSide);
  let guard = 0;
  const outroBars = 8;
  while (total < T - outroBars && guard++ < 64) {
    const q = queue[side].length ? queue[side] : songsS[side];
    if (!q.length) {
      side = other(side);
      if (!queue[side].length && !songsS[side].length) break;
      continue;
    }
    const s = q[used[side] % q.length];
    used[side]++;
    const bars = Math.min(chunkBars(s), T - outroBars - total);
    if (bars < 4) break;
    chunks.push({ side, songBar: s.startBar, bars, energy: s.energy, name: `${letter(side)} · ${s.name}`, kind: 'main' });
    total += bars;
    side = other(side);
  }
  const outroSrc = songsS[side][songsS[side].length - 1] ?? songsS[other(side)][songsS[other(side)].length - 1];
  const outroSide = songsS[side].length ? side : other(side);
  if (outroSrc && total < T) {
    const bars = Math.min(outroBars, T - total, Math.max(4, outroSrc.bars));
    const songBar = Math.max(outroSrc.startBar, outroSrc.startBar + outroSrc.bars - bars);
    chunks.push({ side: outroSide, songBar, bars, energy: outroSrc.energy, name: 'Outro', kind: 'outro' });
    total += bars;
  }
  const sections: PlannedSection[] = [];
  const transitions: BuildPlan['transitions'] = [];
  let at = 1;
  chunks.forEach((c, i) => {
    const prev = chunks[i - 1];
    const next = chunks[i + 1];
    const switchIn = !!prev && prev.side !== c.side;
    const switchOut = !!next && next.side !== c.side;
    clips.get(`${c.side}:mix`)!.push({ startBar: at, bars: c.bars, songBar: c.songBar, ...(switchIn ? { fadeIn: 1 } : {}), ...(switchOut ? { fadeOut: 1 } : {}) });
    sections.push({ name: c.name, startBar: at, bars: c.bars, energy: c.energy, uses: `${names[c.side]} (full mix, from its bar ${c.songBar + 1})` });
    if (prev) transitions.push({ bar: at, kind: boundaryKind({ energy: prev.energy }, { energy: c.energy, kind: c.kind === 'outro' ? 'outro' : undefined, high: c.energy >= 0.7 }), prevBars: prev.bars });
    at += c.bars;
  });
  return { sections, clips, transitions };
}

export function readingOf(s: SongInput, factor: Factor): MashupSongReading {
  const secs = songSections(s, factor);
  const bpm = s.bpm && s.bpm > 0 ? snapBpm(s.bpm) : null;
  const alts = bpm ? [...new Set([snapBpm(bpm / 2), snapBpm(bpm * 2), ...s.bpmAlternatives.map(snapBpm)])].filter((x) => x >= 30 && x <= 300 && Math.abs(x - bpm) > 0.5).sort((x, y) => x - y) : [];
  return {
    name: s.name,
    ...(s.path ? { path: s.path } : {}),
    durationSec: r2(s.durationSec),
    bpm,
    bpmAlternatives: alts,
    key: s.key,
    keyConfidence: r2(s.keyConfidence),
    vocalPresence: r2(clamp01(s.vocalPresence)),
    sections: secs.map((x) => ({ name: x.name, startBar: x.startBar + 1, bars: x.bars, energy: x.energy, vocal: x.vocal })),
    stems: STEMS.filter((x) => s.stems.includes(x)),
  };
}

const fmtSpeed = (x: number): string => `×${r2(x)}`;

function tempoReason(t: TempoDecision, songs: Record<Side, SongInput>): string {
  const part = (s: Side): string => {
    const d = t[s];
    const sg = songs[s];
    if (!sg.bpm) return `${letter(s)} has no steady tempo (it plays at its own speed and will drift)`;
    const reading = d.factor === 1 ? `${snapBpm(sg.bpm)} bpm` : `${snapBpm(sg.bpm)} bpm read as ${d.srcBpm} (${d.factor === 2 ? 'double' : 'half'} time)`;
    const sp = Math.abs(d.speed - 1) < 0.005 ? 'unchanged' : `plays ${fmtSpeed(d.speed)}${audibleStretch(d.speed) ? ' (an audible stretch)' : ''}`;
    return `${letter(s)} ${reading}, ${sp}`;
  };
  return `Tempo: ${t.bpm} bpm: ${part('a')}; ${part('b')}.`;
}

export interface PlanOptions {
  noSuggestions?: boolean;
}

export function planMashup(req: MashupRequest, a: SongInput, b: SongInput, opts: PlanOptions = {}): MashupPlanResult {
  const songs: Record<Side, SongInput> = { a, b };
  const style: MashupStyle = req.style;
  const anchor: MashupAnchor = req.anchor ?? 'beat';
  const problems: string[] = [];
  const notes: string[] = [];
  const reasons: string[] = [];
  for (const s of ['a', 'b'] as Side[]) if (songs[s].problem) problems.push(`${letter(s)} ("${short(songs[s].name, 40)}"): ${songs[s].problem}`);

  let vocalFrom: Side | null = null;
  let bed: Side = 'a';
  let roleScores: Record<Side, number> | null = null;
  let pick: StemPick | null = null;
  if (style === 'vocalOverBeat') {
    const c = chooseVocal(req, songs);
    vocalFrom = c.side;
    roleScores = c.scores;
    bed = other(vocalFrom);
  } else if (style === 'stemBlend') {
    const auto = chooseVocal({ ...req, vocalFrom: req.vocalFrom ?? 'auto' }, songs).side;
    pick = req.stems ?? { vocals: auto, drums: other(auto), bass: other(auto), other: auto };
    bed = pick.drums ?? pick.bass ?? pick.other ?? pick.vocals ?? 'a';
    vocalFrom = pick.vocals;
  } else {
    bed = 'a';
    vocalFrom = null;
  }
  const mover = other(bed);
  const anchorSide: Side | null = anchor === 'middle' ? null : anchor === 'beat' ? bed : style === 'backAndForth' ? 'b' : (vocalFrom ?? mover);

  const tempo = chooseTempo(req, a, b, anchorSide);
  reasons.push(tempoReason(tempo, songs) + (tempo.halfway ? ` Met half way: keeping ${letter(anchorSide!)}'s tempo would stretch the other song further.` : ''));
  for (const s of ['a', 'b'] as Side[]) {
    if (!songs[s].bpm && !songs[s].problem) notes.push(`${letter(s)} has no steady tempo, so it can't be locked to the grid: expect it to drift.`);
    else if (audibleStretch(tempo[s].speed)) notes.push(`${letter(s)} plays ${fmtSpeed(tempo[s].speed)} (outside ×${CLEAN_STRETCH[0]}–×${CLEAN_STRETCH[1]}): listen for stretch artefacts.`);
  }

  const moverIsVocal = style === 'backAndForth' ? false : vocalFrom === mover;
  const keyAnchor: MashupAnchor = anchor === 'vocal' && style !== 'backAndForth' && !moverIsVocal ? 'beat' : anchor;
  const key = decideKey(songs, bed, keyAnchor, { key: req.key, moverIsVocal });
  reasons.push(key.reason);
  if (key.weak) notes.push('One of the key readings is weak: listen, and pass key (e.g. "F#m") if the vocal clashes.');
  if (vocalFrom) {
    const vs = key[vocalFrom];
    if (Math.abs(vs) > VOCAL_SHIFT_COMFORT) notes.push(`${letter(vocalFrom)}'s vocal is pitched ${fmtSemitones(vs)}: listen for artefacts.`);
  }
  for (const s of ['a', 'b'] as Side[]) if (s !== vocalFrom && Math.abs(key[s]) > 2) notes.push(`${letter(s)} is pitched ${fmtSemitones(key[s])}: instruments moved that far can sound processed.`);

  const need: Record<Side, Set<MashupStem>> = { a: new Set(), b: new Set() };
  const parts: Array<{ side: Side; part: MashupStem | 'mix'; role: PlannedTrack['role'] }> = [];
  const addStems = (s: Side, list: MashupStem[]) => {
    for (const st of list) {
      need[s].add(st);
      parts.push({ side: s, part: st, role: st === 'vocals' ? 'vocal' : st });
    }
  };
  if (style === 'vocalOverBeat' && vocalFrom) {
    if (songs[vocalFrom].kind === 'acapella') parts.push({ side: vocalFrom, part: 'mix', role: 'vocal' });
    else addStems(vocalFrom, ['vocals']);
    if (songs[bed].kind === 'instrumental') parts.push({ side: bed, part: 'mix', role: 'mix' });
    else addStems(bed, [...BED_STEMS]);
  } else if (style === 'stemBlend' && pick) {
    for (const s of ['a', 'b'] as Side[]) {
      const mine = STEMS.filter((st) => pick![st] === s);
      if (!mine.length) continue;
      const sg = songs[s];
      if (sg.kind === 'acapella' && mine.length === 1 && mine[0] === 'vocals') parts.push({ side: s, part: 'mix', role: 'vocal' });
      else if (sg.kind === 'instrumental' && !mine.includes('vocals') && BED_STEMS.every((x) => mine.includes(x))) parts.push({ side: s, part: 'mix', role: 'mix' });
      else addStems(s, mine);
    }
    if (!STEMS.some((st) => pick![st])) problems.push('stemBlend needs at least one stem: pick which song each stem comes from.');
  } else {
    parts.push({ side: 'a', part: 'mix', role: 'mix' }, { side: 'b', part: 'mix', role: 'mix' });
  }
  for (const s of ['a', 'b'] as Side[]) {
    const missing = [...need[s]].filter((st) => !songs[s].stems.includes(st));
    if (missing.length && !songs[s].canSeparate && !songs[s].problem) {
      problems.push(`${letter(s)} ("${short(songs[s].name, 40)}") needs its ${missing.join(' / ')} stem${missing.length === 1 ? '' : 's'}, and no stem model is installed. Install HT-Demucs in Home ▸ Model Manager${style === 'vocalOverBeat' ? `, or use an a cappella / instrumental version of the song, or the backAndForth style (no stems needed)` : ', or use the backAndForth style (no stems needed)'}.`);
    }
  }

  if (vocalFrom && style !== 'backAndForth') {
    const v = songs[vocalFrom];
    const how = v.vocalSource === 'stems' ? 'from its vocal stem' : v.vocalSource === 'name' ? 'going by its name' : 'not measured yet: the stems will tell';
    const level = v.vocalPresence >= 0.6 ? 'a clear lead vocal' : v.vocalPresence >= 0.3 ? 'some vocal' : 'little or no vocal';
    reasons.push(`Vocal: ${letter(vocalFrom)} has ${level} (${how})${roleScores && req.vocalFrom !== 'a' && req.vocalFrom !== 'b' ? `; chosen over the other way round (fit ${Math.round(roleScores[vocalFrom])} vs ${Math.round(roleScores[other(vocalFrom)])})` : ''}.`);
    if (style === 'vocalOverBeat' && v.vocalSource !== 'unknown' && v.vocalPresence < NO_VOCAL) {
      const o = songs[other(vocalFrom)];
      const both = o.vocalSource !== 'unknown' && o.vocalPresence < NO_VOCAL;
      problems.push(
        both
          ? `Neither song has a lead vocal to put on the other's beat (their vocal stems are near silent: both are instrumentals). Try Back & forth (they trade sections), or Stem blend (e.g. the drums of one under the melody of the other).`
          : `${letter(vocalFrom)} ("${short(v.name, 40)}") has no lead vocal (its vocal stem is near silent). Take the vocal from ${letter(other(vocalFrom))} instead, or try Back & forth / Stem blend.`,
      );
    } else if (v.vocalPresence < 0.3 && v.vocalSource !== 'unknown') notes.push(`${letter(vocalFrom)} has little vocal to use: the mashup may sound mostly instrumental.`);
    const bs = songs[bed];
    if (style === 'vocalOverBeat' && bs.kind !== 'instrumental' && bs.vocalPresence >= 0.3) reasons.push(`Bed: ${letter(bed)}'s own vocal is left out (its drums, bass and other stems are used).`);
  }

  const secs: Record<Side, SongSection[]> = { a: songSections(a, tempo.a.factor), b: songSections(b, tempo.b.factor) };
  const names: Record<Side, string> = { a: short(a.name, 24) || 'A', b: short(b.name, 24) || 'B' };
  const tracks: PlannedTrack[] = [];
  let mapped: Mapped;
  let T: number;
  const keyOf = (s: Side, part: MashupStem | 'mix') => `${s}:${part}`;
  if (style === 'backAndForth') {
    T = targetBars(req, Math.max(songBars(a, tempo.a.factor), songBars(b, tempo.b.factor)));
    mapped = mapBackAndForth(secs.a, secs.b, T, names);
    reasons.push(`Structure: A and B trade ${mapped.sections.length} sections of 8 / 16 bars (best energy first) over ${mapped.sections.reduce((n, s) => n + s.bars, 0)} bars, crossfaded with a transition at every switch.`);
  } else {
    const bedSecs = secs[bed];
    const natural = songBars(songs[bed], tempo[bed].factor);
    T = Math.min(targetBars(req, natural), Math.max(4, natural));
    if (req.bars && req.bars > natural && natural > 0) notes.push(`${letter(bed)} is only ${natural} bars long, so the mashup is ${T} bars, not ${req.bars}.`);
    const bedParts = parts.filter((p) => p.side === bed && p.role !== 'vocal').map((p) => keyOf(p.side, p.part));
    const vocalPart = parts.find((p) => p.role === 'vocal' && p.side !== bed);
    const vocalKey = vocalPart ? keyOf(vocalPart.side, vocalPart.part) : null;
    mapped = mapVocalOverBed(bedSecs, vocalPart ? secs[vocalPart.side] : [], T, bedParts, vocalKey, { bed: names[bed], vocal: vocalPart ? names[vocalPart.side] : '' });
    for (const p of parts) {
      const k = keyOf(p.side, p.part);
      if (mapped.clips.has(k)) continue;
      if (p.side === bed) {
        mapped.clips.set(k, mapped.sections.map((s) => ({ startBar: s.startBar, bars: s.bars, songBar: s.startBar - 1 })));
      } else {
        mapByEnergy(mapped.sections, secs[p.side], k, mapped.clips);
        for (const s of mapped.sections) s.uses += ` + ${names[p.side]} ${p.part}`;
      }
    }
    const hook = vocalPart ? secs[vocalPart.side].filter((s) => s.vocal).sort((x, y) => y.energy - x.energy || x.startBar - y.startBar)[0] : null;
    const peak = [...bedSecs].sort((x, y) => y.energy - x.energy || x.startBar - y.startBar)[0];
    const flat = bedSecs.length > 1 && bedSecs.every((s) => Math.abs(s.energy - bedSecs[0].energy) < 0.05);
    reasons.push(
      `Structure: ${letter(bed)} has ${bedSecs.length} section${bedSecs.length === 1 ? '' : 's'} over ${natural} bars${hook && peak ? `; ${letter(vocalPart!.side)}'s ${hook.name} (${hook.bars} bars) goes over ${letter(bed)}'s ${peak.name}` : ''}${flat ? ' (its energy is flat, so the hook lands where it is loudest)' : ''}; ${mapped.sections.length} sections, ${T} bars.`,
    );
    if (vocalPart && !secs[vocalPart.side].some((s) => s.vocal)) notes.push(`No vocal sections were found in ${letter(vocalPart.side)}, so the vocal has nothing to place.`);
  }
  const bars = mapped.sections.reduce((n, s) => n + s.bars, 0);

  const order: Record<PlannedTrack['role'], number> = { vocal: 0, drums: 1, bass: 2, other: 3, mix: 4 };
  const label = (st: MashupStem | 'mix') => (st === 'mix' ? 'Full mix' : st[0].toUpperCase() + st.slice(1));
  const sortedParts = [...parts].sort((x, y) => order[x.role] - order[y.role] || (x.side < y.side ? -1 : x.side > y.side ? 1 : 0));
  for (const p of sortedParts) {
    const clips = (mapped.clips.get(keyOf(p.side, p.part)) ?? []).filter((c) => c.bars > 0);
    if (!clips.length) continue;
    const semis = p.role === 'drums' ? 0 : key[p.side];
    tracks.push({
      song: p.side,
      part: p.part,
      role: p.role,
      name: `${short(songs[p.side].name, 40)} · ${p.role === 'vocal' && p.part === 'mix' ? 'Vocal' : label(p.part)}`.slice(0, 64),
      warp: p.role === 'vocal' ? 'tones' : p.role === 'drums' ? 'beats' : 'complex',
      semitones: semis,
      formant: p.role === 'vocal',
      gainDb: levelDb(songs[p.side], p),
      clips,
    });
  }
  const vocalTrack = tracks.find((t) => t.role === 'vocal');
  const tune = vocalTrack ? (req.tune ?? 'off') : 'off';
  if (vocalTrack && tune !== 'off' && key.measured && key.measured.vocalKeyConfidence < KEY_WEAK) notes.push(`The vocal's key reading is weak (${Math.round(key.measured.vocalKeyConfidence * 100)}%): if Krypt Tune pulls notes the wrong way, turn it off.`);

  const tempoPen = Math.max(...(['a', 'b'] as Side[]).map((s) => (songs[s].bpm ? stretchPenalty(tempo[s].speed) : 20)));
  let vocalPen = 0;
  if (vocalFrom && style !== 'backAndForth') {
    const v = songs[vocalFrom];
    if (v.vocalPresence < 0.3) vocalPen += 15 * (1 - v.vocalPresence / 0.3);
    if (v.vocalSource === 'unknown') vocalPen += 3;
  }
  const bedSecs = secs[bed];
  const structPen = (bedSecs.length < 2 ? 5 : 0) + (vocalTrack && !vocalTrack.clips.length ? 10 : 0);
  const score = Math.round(clamp(100 - tempoPen - key.penalty - Math.min(20, vocalPen) - structPen, 0, 100));

  const summary: MashupPlanSummary = {
    style,
    vocalFrom: style === 'backAndForth' ? null : vocalFrom,
    bpm: tempo.bpm,
    key: key.key,
    shiftA: { stretch: r2(tempo.a.speed > 0 ? 1 / tempo.a.speed : 1), semitones: key.a },
    shiftB: { stretch: r2(tempo.b.speed > 0 ? 1 / tempo.b.speed : 1), semitones: key.b },
    sections: mapped.sections.map((s) => ({ name: s.name, startBar: s.startBar, bars: s.bars, uses: s.uses })),
    bars,
  };
  const build: BuildPlan = {
    style,
    vocalFrom: summary.vocalFrom,
    bpm: tempo.bpm,
    key: key.key,
    bars,
    songs: {
      a: { factor: tempo.a.factor, srcBpm: tempo.a.srcBpm, speed: tempo.a.speed, semitones: key.a, needStems: STEMS.filter((s) => need.a.has(s)) },
      b: { factor: tempo.b.factor, srcBpm: tempo.b.srcBpm, speed: tempo.b.speed, semitones: key.b, needStems: STEMS.filter((s) => need.b.has(s)) },
    },
    tracks,
    sections: mapped.sections,
    transitions: mapped.transitions,
    tune,
    tuneKey: vocalTrack ? key.vocalKey : null,
    notes,
  };
  const check: MashupCheck = {
    a: readingOf(a, tempo.a.factor),
    b: readingOf(b, tempo.b.factor),
    score,
    reasons,
    plan: summary,
    suggestions: opts.noSuggestions ? [] : suggestions(req, songs, { score, tempo, key, vocalFrom, style, roleScores }),
    problems,
  };
  return { check, build };
}

function levelDb(s: SongInput, p: { part: MashupStem | 'mix'; role: PlannedTrack['role'] }): number {
  const l = s.lufs;
  if (l === null || l === undefined || !Number.isFinite(l)) return 0;
  const target = p.role === 'vocal' && p.part === 'mix' ? MIX_LUFS - 5 : MIX_LUFS;
  return r2(clamp(target - l + (p.role === 'vocal' ? VOCAL_LIFT_DB : 0), -18, 9));
}

function suggestions(req: MashupRequest, songs: Record<Side, SongInput>, cur: { score: number; tempo: TempoDecision; key: KeyDecision; vocalFrom: Side | null; style: MashupStyle; roleScores: Record<Side, number> | null }): string[] {
  const out: string[] = [];
  const replan = (patch: Partial<MashupRequest>) => planMashup({ ...req, ...patch }, songs.a, songs.b, { noSuggestions: true });
  for (const s of ['a', 'b'] as Side[]) {
    const fk = s === 'a' ? 'factorA' : 'factorB';
    if (req[fk] === undefined) continue;
    const alt = replan({ [fk]: undefined });
    const d = alt.build.songs[s];
    if (d.factor !== cur.tempo[s].factor && Math.abs(Math.log2(d.speed)) + 1e-9 < Math.abs(Math.log2(cur.tempo[s].speed))) {
      out.push(`Use ${letter(s)} ${d.factor === 1 ? 'as detected' : d.factor === 0.5 ? 'at half time' : 'at double time'}: it plays ${fmtSpeed(d.speed)} instead of ${fmtSpeed(cur.tempo[s].speed)}.`);
    }
  }
  const anchor = req.anchor ?? 'beat';
  const worst = Math.max(Math.abs(Math.log2(cur.tempo.a.speed)), Math.abs(Math.log2(cur.tempo.b.speed)));
  const vocalShift = cur.vocalFrom ? Math.abs(cur.key[cur.vocalFrom]) : 0;
  if (anchor !== 'middle' && !req.bpm && !req.key && (audibleStretch(cur.tempo.a.speed) || audibleStretch(cur.tempo.b.speed) || vocalShift > VOCAL_SHIFT_COMFORT)) {
    const alt = replan({ anchor: 'middle' });
    const w2 = Math.max(Math.abs(Math.log2(alt.build.songs.a.speed)), Math.abs(Math.log2(alt.build.songs.b.speed)));
    const parts: string[] = [];
    if (w2 + 1e-9 < worst) parts.push(`each song stretches at most ${fmtSpeed(Math.pow(2, w2))} instead of ${fmtSpeed(Math.pow(2, worst))}`);
    if (cur.vocalFrom && Math.abs(alt.build.songs[cur.vocalFrom].semitones) < vocalShift) parts.push(`the vocal moves ${fmtSemitones(alt.build.songs[cur.vocalFrom].semitones)} and the beat ${fmtSemitones(alt.build.songs[other(cur.vocalFrom)].semitones)} instead of ${fmtSemitones(cur.key[cur.vocalFrom])}`);
    if (parts.length) out.push(`Anchor "middle": ${parts.join('; ')}.`);
  }
  if (cur.style === 'vocalOverBeat' && cur.vocalFrom && (req.vocalFrom === 'a' || req.vocalFrom === 'b') && cur.roleScores) {
    const o = other(cur.vocalFrom);
    if (cur.roleScores[o] > cur.roleScores[cur.vocalFrom] + 5) {
      const alt = replan({ vocalFrom: o });
      out.push(`Take the vocal from ${letter(o)} instead: a better fit (score ${alt.check.score} vs ${cur.score}).`);
    }
  }
  if (!cur.key.key && !req.key) out.push('Set the key yourself (key: "F#m") if the vocal sounds off: the key couldn\'t be read.');
  else if (cur.key.weak && !req.key) out.push(`A key reading is weak: if it clashes, try key "${cur.key.key}" with a different semitone move, or set key yourself.`);
  if (cur.style === 'vocalOverBeat') {
    const noStems = (['a', 'b'] as Side[]).some((s) => !songs[s].canSeparate && songs[s].kind === 'song' && !songs[s].stems.length);
    if (noStems) out.push('Without a stem model, the backAndForth style still works: the two songs trade sections on one grid.');
  }
  return out.slice(0, 5);
}
