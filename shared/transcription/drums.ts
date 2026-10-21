import type { DrumHit, DrumRole } from '../analyzer/protocol';
import type { GridNote, TranscribedPart } from './types';
import { quantize, type TranscriptionGrid } from './grid';

export const DRUM_PARTS: ReadonlyArray<{ role: DrumRole; name: string }> = [
  { role: 'kick', name: 'Kick' },
  { role: 'snare', name: 'Snare' },
  { role: 'hat', name: 'Hat' },
  { role: 'openhat', name: 'Open Hat' },
  { role: 'perc', name: 'Perc' },
];

export const FLAM_SEC = 0.02;
export const DRUM_CELL = 120;
export const DRUM_KEY = 60;
const MIN_HITS = 4;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface DrumPartsResult {
  parts: TranscribedPart[];
  merged: number;
  capped: number;
  pickup: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function normaliseVelocities(vels: number[]): number[] {
  const s = vels.filter(isNum).slice().sort((a, b) => a - b);
  const p90 = quantile(s, 0.9);
  const k = p90 > 0.01 ? 0.9 / p90 : 1;
  return vels.map((v) => r2(Math.max(0.15, Math.min(1, (isNum(v) ? v : 0.8) * k))));
}

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
  grid: number;
  feel: number;
  source: 'stem' | 'mix';
}

export function drumParts(hits: readonly DrumHit[], g: TranscriptionGrid, opts: DrumOptions): DrumPartsResult {
  let merged = 0;
  let capped = 0;
  let pickup = 0;
  const parts: TranscribedPart[] = [];
  for (const { role, name } of DRUM_PARTS) {
    const list = hits.filter((h) => h && h.role === role && isNum(h.timeSec)).sort((a, b) => a.timeSec - b.timeSec);
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
    const vels = normaliseVelocities(clusters.map((c) => c.vel));
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
