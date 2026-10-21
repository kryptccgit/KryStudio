// The project grid of a transcribed song: seconds in the source file → ticks
// from bar 1 (PPQ 960), beat-synchronous. Every onset goes through the
// analysed beat times (piecewise-linear between beats, shared/library/grid.ts),
// so a live recording that drifts in tempo still lands on the right 16ths.
// Bar 1 is the first analysed downbeat (or a whole bar earlier when the song
// has whole bars of material before it); the tempo reading `factor` (0.5 / 1 /
// 2) scales detected beats to project beats. Pure.

import type { AudioAnalysis, DrumHit } from '../analyzer/protocol';
import { beatMapping, beatsPerBar, unswingBeat } from '../library/grid';
import { PPQ } from '../schema/time';

export type TempoFactor = 0.5 | 1 | 2;

/** Bpm the grid assumes when the analysis found no steady pulse. */
export const FALLBACK_BPM = 120;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export interface TranscriptionGrid {
  /** The project tempo (detected × factor, rounded to a whole bpm when within 0.2). */
  bpm: number;
  /** Detected bpm (null: no steady pulse, the grid runs at FALLBACK_BPM from 0 s). */
  detectedBpm: number | null;
  factor: TempoFactor;
  /** Project beats per bar (the analysed meter; 4 by default). */
  beatsPerBar: number;
  ticksPerBar: number;
  /** Seconds in the source where bar 1 starts. */
  firstDownbeatSec: number;
  /** Bars of material before the first analysed downbeat that were kept (bar 1 moved earlier by this many bars). */
  shiftedBars: number;
  /** Beats (project) of material before bar 1 that is dropped as a pickup (0 = none). */
  pickupBeats: number;
  /** Swing (0..1) taken out of positions before quantizing (only at the detected reading; null = none). */
  swing: number | null;
  /** Source seconds → ticks from bar 1 (fractional, unquantized; negative before bar 1). */
  toTick(sec: number): number;
  /** Ticks from bar 1 → source seconds. */
  toSec(tick: number): number;
  /** Total bars of the song on this grid (partial last bar counted when ≥ ¼ bar). */
  totalBars: number;
}

export interface GridOptions {
  /**
   * Onset times (s) of the song's material (drum hits, notes), to decide about a pickup before the first downbeat
   * and, at a half-time reading, which analysed downbeats start the (twice as long) project bars.
   */
  onsets?: readonly number[];
  /** Kick times (s): at factor 0.5 the bar parity with more kicks on the downbeat wins. */
  kicks?: readonly number[];
}

/**
 * The grid for an analysis at a tempo reading.
 * - factor 1: one analysed beat = one project beat; factor 2: two; factor 0.5: half (two analysed bars per bar).
 * - Pickup: material before the first downbeat spanning at least one whole bar moves bar 1 back by whole bars (an
 *   intro the beat tracker under-counted); a shorter pickup (an anacrusis) is reported in `pickupBeats` and dropped.
 */
export function transcriptionGrid(a: AudioAnalysis, factor: TempoFactor, opts: GridOptions = {}): TranscriptionGrid {
  const bpb = beatsPerBar(a);
  const detected = a.tempo && isNum(a.tempo.bpm) && a.tempo.bpm > 0 ? a.tempo.bpm : null;
  const m = detected ? beatMapping(a) : null;
  const f: TempoFactor = detected ? factor : 1;
  // Detected beats from the first analysed downbeat (constant fallback tempo without a pulse).
  const toBeat0 = m ? m.toBeat : (sec: number) => (sec * FALLBACK_BPM) / 60;
  const toSec0 = m ? m.toSec : (beat: number) => (beat * 60) / FALLBACK_BPM;
  /** Detected beats per project bar. */
  const barBeats = bpb / f;

  // Half time: which analysed downbeats start the long bars (parity with more kicks on the bar line).
  let originBeat = 0;
  if (f === 0.5 && opts.kicks?.length) {
    const score = (offset: number) =>
      opts.kicks!.filter((t) => {
        const b = toBeat0(t) - offset;
        const r = ((b % barBeats) + barBeats) % barBeats;
        return Math.min(r, barBeats - r) < 0.15;
      }).length;
    if (score(bpb) > score(0) * 1.2) originBeat = bpb;
    // Keep bar 1 at or after the first analysed downbeat's start of material: shift back a whole long bar if possible.
    if (originBeat > 0 && toSec0(originBeat - barBeats) >= -0.05) originBeat -= barBeats;
  }

  // Pickup / under-counted intro before bar 1.
  let shiftedBars = 0;
  let pickupBeats = 0;
  const firstOnset = (opts.onsets ?? []).reduce<number | null>((lo, t) => (isNum(t) && (lo === null || t < lo) ? t : lo), null);
  if (firstOnset !== null) {
    const before = originBeat - toBeat0(firstOnset); // detected beats of material before bar 1
    if (before > 0.05) {
      const whole = Math.floor((before + 0.1) / barBeats);
      // Only move bar 1 back where the audio exists (a bar starting at least ~50 ms into the file).
      let k = whole;
      while (k > 0 && toSec0(originBeat - k * barBeats) < -0.05) k--;
      shiftedBars = k;
      originBeat -= k * barBeats;
      const rest = originBeat - toBeat0(firstOnset);
      pickupBeats = rest > 0.05 ? Math.round(rest * f * 4) / 4 : 0;
    }
  }

  const swing = f === 1 && isNum(a.swing) && a.swing >= 0.1 ? Math.min(1, a.swing) : null;
  const tpb = PPQ;
  const toTick = (sec: number): number => {
    const b = toBeat0(sec) - originBeat;
    const u = swing !== null ? unswingBeat(b, swing) : b;
    return u * f * tpb;
  };
  const toSec = (tick: number): number => toSec0(tick / (f * tpb) + originBeat);
  const raw = detected ? detected * f : FALLBACK_BPM;
  const bpm = Math.abs(raw - Math.round(raw)) <= 0.2 ? Math.round(raw) : Math.round(raw * 100) / 100;
  const ticksPerBar = bpb * PPQ;
  const endBars = toTick(a.durationSec) / ticksPerBar;
  const totalBars = Math.max(1, endBars - Math.floor(endBars) >= 0.25 ? Math.ceil(endBars) : Math.floor(endBars));
  return {
    bpm,
    detectedBpm: detected,
    factor: f,
    beatsPerBar: bpb,
    ticksPerBar,
    firstDownbeatSec: Math.round(toSec(0) * 1000) / 1000,
    shiftedBars,
    pickupBeats,
    swing,
    toTick,
    toSec,
    totalBars,
  };
}

/**
 * Quantize a tick to `grid` keeping `feel` (0..1) of the micro-offset: 0 = hard on the grid, 1 = untouched.
 * grid ≤ 1 keeps the timing (rounded to a tick).
 */
export function quantize(tick: number, grid: number, feel: number): { tick: number; cell: number } {
  if (!(grid > 1)) return { tick: Math.round(tick), cell: Math.round(tick) };
  const q = Math.round(tick / grid) * grid;
  const f = Math.max(0, Math.min(1, feel));
  return { tick: Math.round(q + f * (tick - q)), cell: q };
}

/** Kick times of a hit list (for the half-time bar parity). */
export function kickTimes(hits: readonly DrumHit[] | null | undefined): number[] {
  return (hits ?? []).filter((h) => h && h.role === 'kick' && isNum(h.timeSec)).map((h) => h.timeSec);
}
