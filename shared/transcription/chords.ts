// The analyzer's chord spans → a chord timeline on the project grid (snapped
// to beats, identical neighbours merged, slivers absorbed), chord names, and
// the "Chords" part: 'exact' voices each chord from the other stem's poly
// notes where they agree with it (else root position in the reference's
// register); 'style' voices the same changes fresh, close around C4 with
// smooth voice leading. Pure.

import type { ChordQuality, ChordSpan } from '../analyzer/protocol';
import { chordName } from '../reference/brief';
import { PPQ } from '../schema/time';
import type { GridChord, GridNote } from './types';
import type { TranscriptionGrid } from './grid';

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const mod12 = (x: number): number => ((x % 12) + 12) % 12;
const r2 = (x: number) => Math.round(x * 100) / 100;

export { chordName };

/** Chord tones (semitones above the root) per analyzer quality. */
export const CHORD_TONES: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  sus: [0, 5, 7],
  '5': [0, 7],
};

/** Pitch classes of a chord. */
export function chordPcs(c: Pick<GridChord, 'root' | 'quality'>): number[] {
  return (CHORD_TONES[c.quality] ?? CHORD_TONES.maj).map((i) => mod12(c.root + i));
}

/** The fifth above the root (a tritone for dim). */
export function fifthOf(q: ChordQuality): number {
  return q === 'dim' ? 6 : 7;
}

/**
 * Chord spans → grid chords: start / end through the beat grid, snapped to whole beats; spans that shrink to
 * nothing are dropped, gaps up to a beat are closed by the chord before, and identical neighbours merge.
 * Chords before bar 1 are cut at bar 1.
 */
export function chordTimeline(spans: readonly ChordSpan[], g: TranscriptionGrid): GridChord[] {
  const beat = PPQ;
  const raw = spans
    .filter((c) => c && isNum(c.startSec) && isNum(c.endSec) && c.endSec > c.startSec && isNum(c.root) && CHORD_TONES[c.quality])
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
    .map((c) => {
      const s = Math.max(0, Math.round(g.toTick(c.startSec) / beat) * beat);
      const e = Math.round(g.toTick(c.endSec) / beat) * beat;
      return { tick: s, end: e, root: mod12(Math.round(c.root)), quality: c.quality, confidence: isNum(c.confidence) ? c.confidence : 0.5, w: Math.max(0, e - s) };
    })
    .filter((c) => c.end > c.tick);
  const out: Array<(typeof raw)[number]> = [];
  for (const c of raw) {
    const prev = out[out.length - 1];
    if (prev && c.tick < prev.end) c.tick = prev.end; // overlaps after snapping
    if (c.end <= c.tick) continue;
    if (prev && c.tick - prev.end <= beat) prev.end = c.tick; // close small gaps
    if (prev && prev.end === c.tick && prev.root === c.root && prev.quality === c.quality) {
      const w = prev.w + (c.end - c.tick);
      prev.confidence = (prev.confidence * prev.w + c.confidence * (c.end - c.tick)) / Math.max(1, w);
      prev.w = w;
      prev.end = c.end;
      continue;
    }
    out.push({ ...c, w: c.end - c.tick });
  }
  return out.map((c) => ({ tick: c.tick, dur: c.end - c.tick, root: c.root, quality: c.quality, name: chordName(c.root, c.quality), confidence: r2(c.confidence) }));
}

/** The chord sounding at a tick (null: none). Chords are sorted and non-overlapping. */
export function chordAt(chords: readonly GridChord[], tick: number): GridChord | null {
  let lo = 0;
  let hi = chords.length - 1;
  let best: GridChord | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chords[mid].tick <= tick) {
      best = chords[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best && tick < best.tick + best.dur ? best : null;
}

/** Root position in close voicing with the root at or just above `low` (a '5' chord adds the octave). */
export function rootPosition(c: Pick<GridChord, 'root' | 'quality'>, low: number): number[] {
  let r = low + mod12(c.root - low);
  if (r > 127 - 12) r -= 12;
  const iv = c.quality === '5' ? [0, 7, 12] : CHORD_TONES[c.quality];
  return iv.map((i) => r + i);
}

/** All close-position inversions of a chord whose notes stay in [lo, hi]. */
function closeVoicings(c: Pick<GridChord, 'root' | 'quality'>, lo: number, hi: number): number[][] {
  const iv = c.quality === '5' ? [0, 7, 12] : CHORD_TONES[c.quality];
  const out: number[][] = [];
  for (let base = lo - 12; base <= hi; base++) {
    if (mod12(base) !== mod12(c.root)) continue;
    const notes = iv.map((i) => base + i);
    for (let inv = 0; inv < iv.length; inv++) {
      const v = notes.map((n, j) => (j < inv ? n + 12 : n)).sort((a, b) => a - b);
      if (v[0] >= lo && v[v.length - 1] <= hi) out.push(v);
    }
  }
  return out;
}

/**
 * Fresh close voicings around C4 for a chord sequence: each chord takes the inversion (within G3..C5) that moves
 * least from the previous one (the first: centred nearest E4).
 */
export function styleVoicings(chords: readonly Pick<GridChord, 'root' | 'quality'>[]): number[][] {
  const out: number[][] = [];
  let prev: number[] | null = null;
  for (const c of chords) {
    const cands = closeVoicings(c, 55, 72);
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const cost = (v: number[]) =>
      prev ? Math.abs(mean(v) - mean(prev)) + 0.15 * Math.abs(mean(v) - 63) : Math.abs(mean(v) - 63);
    const best = cands.length ? cands.reduce((a, b) => (cost(b) < cost(a) ? b : a)) : rootPosition(c, 57);
    out.push(best);
    prev = best;
  }
  return out;
}

export interface ExactVoicing {
  keys: number[];
  /** True when the poly notes agreed with the chord (voiced from them). */
  fromNotes: boolean;
}

/**
 * The voicing of one chord from the poly notes sounding during it (seconds → ticks via `toTick`): notes between
 * C3 and C6 weighted by how long they sound inside the chord. When ≥ 2 distinct chord tones are present and chord
 * tones make up ≥ 2/3 of the weight, the voicing is the most-weighted chord-tone keys (up to 5), else root position
 * at `register`.
 */
export function exactVoicing(c: GridChord, notes: ReadonlyArray<{ tick: number; end: number; key: number }>, register: number): ExactVoicing {
  const pcs = new Set(chordPcs(c));
  const end = c.tick + c.dur;
  const w = new Map<number, number>();
  let total = 0;
  for (const n of notes) {
    if (n.key < 48 || n.key > 84) continue;
    const ov = Math.min(end, n.end) - Math.max(c.tick, n.tick);
    if (ov <= 0) continue;
    w.set(n.key, (w.get(n.key) ?? 0) + ov);
    total += ov;
  }
  if (total > 0) {
    const tones = [...w.entries()].filter(([k]) => pcs.has(mod12(k)));
    const toneW = tones.reduce((s, [, x]) => s + x, 0);
    const distinct = new Set(tones.map(([k]) => mod12(k)));
    if (distinct.size >= Math.min(2, pcs.size) && toneW / total >= 2 / 3) {
      const keys = tones
        .sort((a, b) => b[1] - a[1])
        .filter(([, x]) => x >= 0.1 * c.dur)
        .slice(0, 5)
        .map(([k]) => k)
        .sort((a, b) => a - b);
      if (new Set(keys.map(mod12)).size >= Math.min(2, pcs.size)) return { keys, fromNotes: true };
    }
  }
  return { keys: rootPosition(c, register), fromNotes: false };
}

/** Chord voicings → sustained notes (one per chord tone for the chord's length). */
export function chordNotes(chords: readonly GridChord[], voicings: readonly number[][], vel = 0.7): GridNote[] {
  const out: GridNote[] = [];
  chords.forEach((c, i) => {
    for (const key of voicings[i] ?? []) if (key >= 0 && key <= 127) out.push({ tick: c.tick, key, dur: c.dur, vel });
  });
  return out.sort((a, b) => a.tick - b.tick || a.key - b.key);
}

/** The register (lowest root) for root-position chords from poly notes: their low quartile, kept in C3..G4. */
export function chordRegister(notes: ReadonlyArray<{ key: number }>): number {
  const ks = notes.map((n) => n.key).filter((k) => k >= 48 && k <= 84).sort((a, b) => a - b);
  if (ks.length < 8) return 57;
  const q = ks[Math.floor(ks.length * 0.25)];
  return Math.max(48, Math.min(60, q));
}

export function meanConfidence(chords: readonly GridChord[]): number | null {
  const w = chords.reduce((s, c) => s + c.dur, 0);
  return w > 0 ? r2(chords.reduce((s, c) => s + c.confidence * c.dur, 0) / w) : null;
}
