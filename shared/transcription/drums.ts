// Drum hits (drum stem, or the full mix as a fallback) → one part per drum
// role on the project grid. Double detections / flams of a role closer than
// 20 ms merge; velocities are normalised per role (accents kept); positions
// are quantized (32nds by default) with part of their feel kept, and a role
// never holds more than one hit per 32nd. Confidence = how consistently the
// role's hits fall on the same steps bar after bar. Pure.

import type { DrumHit, DrumRole } from '../analyzer/protocol';
import type { GridNote, TranscribedPart } from './types';
import { quantize, type TranscriptionGrid } from './grid';

/** Roles in channel order, with their channel names (clap reads as snare, as in the analyzer). */
export const DRUM_PARTS: ReadonlyArray<{ role: DrumRole; name: string }> = [
  { role: 'kick', name: 'Kick' },
  { role: 'snare', name: 'Snare' },
  { role: 'hat', name: 'Hat' },
  { role: 'openhat', name: 'Open Hat' },
  { role: 'perc', name: 'Perc' },
];

/** Hits of one role closer than this merge (flams, double detections). */
export const FLAM_SEC = 0.02;
/** 32nd note: the densest a drum part gets. */
export const DRUM_CELL = 120;
/** Key every drum note uses (the channel's root). */
export const DRUM_KEY = 60;
/** A role needs this many hits to become a part. */
const MIN_HITS = 4;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface DrumPartsResult {
  parts: TranscribedPart[];
  /** Hits merged as flams / double detections. */
  merged: number;
  /** Hits dropped by the 32nd density cap. */
  capped: number;
  /** Hits before bar 1 (pickup) dropped. */
  pickup: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Per role velocities scaled so the role's 90th percentile sits at 0.9 (soft ghost notes stay soft, accents stay
 * on top), floored at 0.15.
 */
export function normaliseVelocities(vels: number[]): number[] {
  const s = vels.filter(isNum).slice().sort((a, b) => a - b);
  const p90 = quantile(s, 0.9);
  const k = p90 > 0.01 ? 0.9 / p90 : 1;
  return vels.map((v) => r2(Math.max(0.15, Math.min(1, (isNum(v) ? v : 0.8) * k))));
}

/**
 * How consistently a role's notes sit on the same 16ths bar after bar (0..1): the mean, over the notes, of the share
 * of the role's active bars that have a note on that step.
 */
export function stepConsistency(notes: readonly GridNote[], ticksPerBar: number): number {
  if (!notes.length) return 0;
  const cell = ticksPerBar / 16;
  const bars = new Set<number>();
  const counts = new Map<number, number>();
  const seen = new Set<string>();
  for (const n of notes) {
    const bar = Math.floor((n.tick + cell / 2) / ticksPerBar);
    const step = Math.round((n.tick - bar * ticksPerBar) / cell) % 16;
    bars.add(bar);
    const id = `${bar}:${step}`;
    if (seen.has(id)) continue;
    seen.add(id);
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  let sum = 0;
  let n = 0;
  for (const id of seen) {
    const step = Number(id.split(':')[1]);
    sum += (counts.get(step) ?? 0) / bars.size;
    n++;
  }
  return n ? sum / n : 0;
}

export interface DrumOptions {
  /** Quantize grid (ticks); the density cap is a 32nd whatever the grid. 0 = keep timing. */
  grid: number;
  feel: number;
  source: 'stem' | 'mix';
}

/** Drum hits → one part per role present (Kick, Snare, Hat, Open Hat, Perc), notes from bar 1. */
export function drumParts(hits: readonly DrumHit[], g: TranscriptionGrid, opts: DrumOptions): DrumPartsResult {
  let merged = 0;
  let capped = 0;
  let pickup = 0;
  const parts: TranscribedPart[] = [];
  for (const { role, name } of DRUM_PARTS) {
    const list = hits.filter((h) => h && h.role === role && isNum(h.timeSec)).sort((a, b) => a.timeSec - b.timeSec);
    // 1. Flams / double detections: hits within 20 ms of the cluster's first hit merge (the loudest velocity).
    const clusters: Array<{ timeSec: number; vel: number }> = [];
    for (const h of list) {
      const vel = isNum(h.vel) ? Math.max(0, Math.min(1, h.vel)) : 0.8;
      const last = clusters[clusters.length - 1];
      if (last && h.timeSec - last.timeSec < FLAM_SEC) {
        last.vel = Math.max(last.vel, vel);
        merged++;
        continue;
      }
      clusters.push({ timeSec: h.timeSec, vel });
    }
    // 2. Velocities per role.
    const vels = normaliseVelocities(clusters.map((c) => c.vel));
    // 3. Grid + density cap (one hit per 32nd cell, the louder wins).
    const cells = new Map<number, GridNote>();
    clusters.forEach((c, i) => {
      const raw = g.toTick(c.timeSec);
      if (raw < -DRUM_CELL / 2) {
        pickup++;
        return;
      }
      const q = quantize(raw, opts.grid, opts.feel);
      const cell = Math.round((opts.grid > 1 ? q.cell : raw) / DRUM_CELL);
      const note: GridNote = { tick: Math.max(0, q.tick), key: DRUM_KEY, dur: 0, vel: vels[i] };
      const prev = cells.get(cell);
      if (prev) {
        capped++;
        if (note.vel > prev.vel) cells.set(cell, note);
        return;
      }
      cells.set(cell, note);
    });
    const notes = [...cells.values()].sort((a, b) => a.tick - b.tick);
    if (notes.length < MIN_HITS) continue;
    // A 16th long, shorter when the next hit comes sooner (never under a 64th).
    notes.forEach((n, i) => {
      const gap = i + 1 < notes.length ? notes[i + 1].tick - n.tick : 240;
      n.dur = Math.max(60, Math.min(240, gap));
    });
    const consistency = stepConsistency(notes, g.ticksPerBar);
    const confidence = r2(Math.max(0.05, Math.min(1, (0.45 + 0.55 * consistency) * (opts.source === 'stem' ? 1 : 0.75))));
    parts.push({ name, stem: opts.source === 'stem' ? 'drums' : 'mix', kind: 'drum', drumRole: role, notes, confidence });
  }
  return { parts, merged, capped, pickup };
}
