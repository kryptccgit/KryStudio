// Seconds (analyzer) → beats from the track's first downbeat, and the
// 32-step drum grid. Pure (Wave 3B library core, research/08 §4).
//
// Beat positions follow the analysed beat grid piecewise-linearly, so a
// track that drifts in tempo still lines up bar by bar; beyond the grid's
// edges they continue at the local tempo (mean of the 4 edge intervals).

import type { AudioAnalysis, ChordSpan, DrumHit, DrumRole, TranscribedNote } from '../analyzer/protocol';
import type { BeatChord, BeatNote, DrumGrid } from './types';
import { isNum, round } from './stats';

/** Steps per bar of the drum grid (32nds in 4/4). */
export const GRID_STEPS = 32;
/** Fixed order of drum roles in grids, profiles and examples. */
export const DRUM_ROLES: readonly DrumRole[] = ['kick', 'snare', 'hat', 'openhat', 'perc'];
/** Swing below this is treated as straight (the analyzer's resolution is about ±0.05). */
const SWING_MIN = 0.1;
/** A bar counts for the drum grid when it holds at least this many hits (drum-less intros and breaks don't dilute the probabilities). */
const MIN_HITS_PER_BAR = 2;
/** Bar length tolerance (beats) for a "confident" bar between two analysed downbeats. */
const BAR_TOLERANCE = 0.3;

export type BeatMap = (sec: number) => number;

/** Both directions of an analysis' beat mapping (beats from the first downbeat). */
export interface BeatMapping {
  toBeat: BeatMap;
  toSec: (beat: number) => number;
}
type Mapping = BeatMapping;

function cleanTimes(times: readonly number[] | null | undefined): number[] {
  if (!times?.length) return [];
  const t = times.filter(isNum).sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of t) if (!out.length || x - out[out.length - 1] > 1e-3) out.push(x);
  return out;
}

function buildMapping(analysis: AudioAnalysis): Mapping | null {
  const times = cleanTimes(analysis.beats?.times);
  const downs = cleanTimes(analysis.beats?.downbeats);
  if (times.length >= 2) {
    const n = times.length;
    const k = Math.min(4, n - 1);
    const headPeriod = (times[k] - times[0]) / k;
    const tailPeriod = (times[n - 1] - times[n - 1 - k]) / k;
    const index = (sec: number): number => {
      if (sec <= times[0]) return (sec - times[0]) / headPeriod;
      if (sec >= times[n - 1]) return n - 1 + (sec - times[n - 1]) / tailPeriod;
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= sec) lo = mid;
        else hi = mid;
      }
      return lo + (sec - times[lo]) / (times[hi] - times[lo]);
    };
    const origin = downs.length ? index(downs[0]) : 0;
    const toSec = (beat: number): number => {
      const idx = beat + origin;
      if (idx <= 0) return times[0] + idx * headPeriod;
      if (idx >= n - 1) return times[n - 1] + (idx - (n - 1)) * tailPeriod;
      const i = Math.floor(idx);
      return times[i] + (idx - i) * (times[i + 1] - times[i]);
    };
    return { toBeat: (sec) => index(sec) - origin, toSec };
  }
  const bpm = analysis.tempo?.bpm;
  if (isNum(bpm) && bpm > 0) {
    // No beat grid: constant tempo from 0 s (or from the one downbeat we have).
    const origin = downs[0] ?? 0;
    return { toBeat: (sec) => ((sec - origin) * bpm) / 60, toSec: (beat) => origin + (beat * 60) / bpm };
  }
  return null;
}

const mapCache = new WeakMap<AudioAnalysis, Mapping | null>();

/** The cached two-way beat mapping of an analysis (resolve once for bulk conversions). null when the track has no tempo. */
export function beatMapping(analysis: AudioAnalysis): BeatMapping | null {
  return mapping(analysis);
}

function mapping(analysis: AudioAnalysis): Mapping | null {
  if (mapCache.has(analysis)) return mapCache.get(analysis) ?? null;
  const m = buildMapping(analysis);
  mapCache.set(analysis, m);
  return m;
}

/**
 * The seconds → beats mapping of an analysis (cached per analysis object;
 * analyses are treated as immutable). null when the track has no tempo.
 */
export function beatMapper(analysis: AudioAnalysis): BeatMap | null {
  return mapping(analysis)?.toBeat ?? null;
}

/**
 * Seconds → beats from the first downbeat, following the analysed beat grid
 * (interpolated between beats, extrapolated at the edges at the local tempo).
 * Without a beat grid: at the detected tempo from 0 s. null when the track has no tempo.
 */
export function secToBeat(analysis: AudioAnalysis, sec: number): number | null {
  const m = mapping(analysis);
  return m && isNum(sec) ? m.toBeat(sec) : null;
}

/** The inverse of secToBeat (beats from the first downbeat → seconds), O(1). null when the track has no tempo. */
export function beatToSec(analysis: AudioAnalysis, beat: number): number | null {
  const m = mapping(analysis);
  return m && isNum(beat) ? m.toSec(beat) : null;
}

/** Beats per bar of an analysis (the analysed value, else 4). */
export function beatsPerBar(analysis: AudioAnalysis): number {
  const b = analysis.beats?.beatsPerBar;
  return isNum(b) && b >= 1 && b <= 16 ? Math.round(b) : 4;
}

/**
 * Undo a 16th-note swing on a beat position: odd 16ths sit `swing × half a
 * 16th` late (transport convention), so they map back onto the straight grid.
 */
export function unswingBeat(beat: number, swing: number | null | undefined): number {
  if (!isNum(swing) || swing < SWING_MIN) return beat;
  const s = Math.min(1, swing);
  const whole = Math.floor(beat);
  const u = (beat - whole) * 4; // 16ths into the beat, 0..4
  const pair = Math.floor(u / 2) * 2;
  const v = u - pair; // 0..2 within an 8th
  const knee = 1 + s / 2;
  const straight = v <= knee ? v / knee : 1 + (v - knee) / (2 - knee);
  return whole + (pair + straight) / 4;
}

interface Bar {
  /** Start, in beats from the first downbeat. */
  start: number;
  /** Length in beats. */
  len: number;
  ok: boolean;
}

/** Bars between the analysed downbeats (the last one runs a nominal bar if the track goes on). */
function analysedBars(analysis: AudioAnalysis, map: BeatMap): Bar[] {
  const downs = cleanTimes(analysis.beats?.downbeats);
  if (!downs.length) return [];
  const bpb = beatsPerBar(analysis);
  const starts = downs.map(map);
  const bars: Bar[] = [];
  for (let k = 0; k < starts.length; k++) {
    let len: number;
    if (k + 1 < starts.length) len = starts[k + 1] - starts[k];
    else {
      const end = isNum(analysis.durationSec) ? map(analysis.durationSec) : starts[k] + bpb;
      if (end < starts[k] + bpb * 0.9) break;
      len = bpb;
    }
    bars.push({ start: starts[k], len, ok: Math.abs(len - bpb) <= BAR_TOLERANCE });
  }
  return bars;
}

/** Which bar (index) and step (0..31) a beat position falls on, rounding to the nearest 32nd. */
function barStep(bars: Bar[], beat: number): { bar: number; step: number } | null {
  if (!bars.length) return null;
  // Last bar whose start is <= beat (or the first, for hits just before it).
  let lo = 0;
  let hi = bars.length - 1;
  if (beat < bars[0].start) lo = 0;
  else {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].start <= beat) lo = mid;
      else hi = mid - 1;
    }
  }
  const b = bars[lo];
  const g = Math.round(((beat - b.start) / b.len) * GRID_STEPS);
  if (g < 0) {
    // Just before this bar's downbeat: belongs to step 0 only if it rounds there.
    return null;
  }
  if (g >= GRID_STEPS) {
    const next = lo + 1;
    if (next < bars.length && g === GRID_STEPS) return { bar: next, step: 0 };
    return null;
  }
  return { bar: lo, step: g };
}

/**
 * Drum hits → per-role counts on a 32-step bar grid (bars from the analysed downbeats). null without a usable beat grid.
 *
 * - Bars run between consecutive analysed downbeats; a bar only counts when
 *   its length matches beatsPerBar (±0.3 beat) — so a missed or shifted
 *   downbeat skips that bar instead of smearing the grid — and when it holds
 *   at least 2 hits (drum-less intros and breakdowns don't dilute the
 *   probabilities). `bars` is the number of such bars.
 * - Positions follow the beat grid inside the bar (tempo drift safe) and are
 *   un-swung when the analysis measured swing, then rounded to the nearest 32nd.
 * - Several hits of one role on one step of one bar count once (max velocity).
 * - `rolls` counts runs of ≥ 3 consecutive 32nd hat hits.
 */
export function drumGrid(analysis: AudioAnalysis, hits: DrumHit[], source: DrumGrid['source']): DrumGrid | null {
  const map = beatMapper(analysis);
  if (!map || !analysis.beats || cleanTimes(analysis.beats.times).length < 2) return null;
  const bars = analysedBars(analysis, map);
  if (!bars.some((b) => b.ok)) return null;
  const swing = analysis.swing;

  // (role → global step (bar*32+step) → max velocity)
  const cells = new Map<DrumRole, Map<number, number>>();
  const perBar = new Map<number, number>();
  for (const h of hits) {
    if (!h || !isNum(h.timeSec) || !DRUM_ROLES.includes(h.role)) continue;
    const pos = barStep(bars, unswingBeat(map(h.timeSec), swing));
    if (!pos || !bars[pos.bar].ok) continue;
    const g = pos.bar * GRID_STEPS + pos.step;
    let m = cells.get(h.role);
    if (!m) cells.set(h.role, (m = new Map()));
    const vel = isNum(h.vel) ? Math.max(0, Math.min(1, h.vel)) : 0.8;
    const prev = m.get(g);
    if (prev === undefined) perBar.set(pos.bar, (perBar.get(pos.bar) ?? 0) + 1);
    if (prev === undefined || vel > prev) m.set(g, vel);
  }
  const active = new Set<number>();
  for (const [bar, n] of perBar) if (n >= MIN_HITS_PER_BAR) active.add(bar);

  const counts: DrumGrid['counts'] = {};
  const vel: DrumGrid['vel'] = {};
  for (const role of DRUM_ROLES) {
    const m = cells.get(role);
    if (!m) continue;
    const c = new Array<number>(GRID_STEPS).fill(0);
    const v = new Array<number>(GRID_STEPS).fill(0);
    let any = false;
    for (const [g, vv] of m) {
      const bar = Math.floor(g / GRID_STEPS);
      if (!active.has(bar)) continue;
      const s = g - bar * GRID_STEPS;
      c[s]++;
      v[s] += vv;
      any = true;
    }
    if (!any) continue;
    counts[role] = c;
    vel[role] = v.map((x) => round(x, 3));
  }

  // Hat rolls: runs of ≥ 3 consecutive 32nds (may cross a bar line between active bars).
  let rolls = 0;
  const hat = cells.get('hat');
  if (hat) {
    const gs = [...hat.keys()].filter((g) => active.has(Math.floor(g / GRID_STEPS))).sort((a, b) => a - b);
    let run = 0;
    for (let i = 0; i < gs.length; i++) {
      run = i > 0 && gs[i] === gs[i - 1] + 1 ? run + 1 : 1;
      if (run === 3) rolls++;
    }
  }

  return { steps: 32, bars: active.size, counts, vel, rolls, source };
}

/** Transcribed notes (seconds) → beat notes. Notes before the first downbeat get negative beats. Empty without a tempo. */
export function notesToBeats(analysis: AudioAnalysis, notes: TranscribedNote[]): BeatNote[] {
  const map = beatMapper(analysis);
  if (!map) return [];
  const out: BeatNote[] = [];
  for (const n of notes) {
    if (!n || !isNum(n.startSec) || !isNum(n.durSec) || !isNum(n.key)) continue;
    const beat = map(n.startSec);
    const end = map(n.startSec + Math.max(0, n.durSec));
    out.push({ beat: round(beat, 4), dur: round(Math.max(0, end - beat), 4), key: n.key, vel: isNum(n.vel) ? round(n.vel, 3) : 0.8 });
  }
  return out.sort((a, b) => a.beat - b.beat || a.key - b.key);
}

/** Chord spans (seconds) → beat chords, merged when adjacent spans repeat the same chord. Empty without a tempo. */
export function chordsToBeats(analysis: AudioAnalysis, chords: ChordSpan[]): BeatChord[] {
  const map = beatMapper(analysis);
  if (!map) return [];
  const spans = chords
    .filter((c) => c && isNum(c.startSec) && isNum(c.endSec) && c.endSec > c.startSec && isNum(c.root))
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  const out: BeatChord[] = [];
  for (const c of spans) {
    const beat = map(c.startSec);
    const end = map(c.endSec);
    if (!(end > beat)) continue;
    const root = ((Math.round(c.root) % 12) + 12) % 12;
    const prev = out[out.length - 1];
    if (prev && prev.root === root && prev.quality === c.quality && beat - (prev.beat + prev.dur) <= 0.25) {
      prev.dur = round(Math.max(prev.dur, end - prev.beat), 4);
      continue;
    }
    out.push({ beat: round(beat, 4), dur: round(end - beat, 4), root, quality: c.quality });
  }
  return out;
}
