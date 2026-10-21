// Pitched lines on the project grid: the bass (mono cleanup, octave-error
// fixes against the chord roots, register sanity; in 'style' its rhythm with
// pitches from the chords), the lead (the other stem's top line, 'exact'
// only) and the generic seconds → grid conversion with quantize + feel. Pure.

import type { TranscribedNote } from '../analyzer/protocol';
import { PPQ } from '../schema/time';
import type { GridChord, GridNote } from './types';
import { quantize, type TranscriptionGrid } from './grid';
import { chordAt, chordPcs, fifthOf } from './chords';

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const mod12 = (x: number): number => ((x % 12) + 12) % 12;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Valid transcribed notes, sorted by start. */
export function cleanNotes(notes: readonly TranscribedNote[] | null | undefined): TranscribedNote[] {
  return (notes ?? [])
    .filter((n) => n && isNum(n.startSec) && isNum(n.durSec) && n.durSec > 0 && Number.isInteger(n.key) && n.key >= 0 && n.key <= 127)
    .slice()
    .sort((a, b) => a.startSec - b.startSec || a.key - b.key);
}

/** A piece of a note shorter than this, right after the same key, is a fragment of it. */
export const FRAGMENT_SEC = 0.1;

export interface MonoCleanup {
  notes: TranscribedNote[];
  /** Notes dropped as blips. */
  blips: number;
  /** Fragments merged into the note before. */
  merged: number;
}

/**
 * A monophonic line in seconds, cleaned: blips under `minSec` dropped, overlaps cut (the later note wins), and
 * legato fragments (a piece under 100 ms of the same key within `joinSec`) merged into one note.
 */
export function monoCleanup(notes: readonly TranscribedNote[], minSec = 0.04, joinSec = 0.03): MonoCleanup {
  const src = cleanNotes(notes);
  let blips = 0;
  let merged = 0;
  const out: TranscribedNote[] = [];
  for (const n of src) {
    if (n.durSec < minSec) {
      blips++;
      continue;
    }
    const prev = out[out.length - 1];
    if (prev) {
      const prevEnd = prev.startSec + prev.durSec;
      // A fragment is short: two full-length notes of one key are a repeated note, not one note split in two.
      if (prev.key === n.key && n.startSec - prevEnd <= joinSec && Math.min(prev.durSec, n.durSec) < FRAGMENT_SEC) {
        prev.durSec = Math.max(prevEnd, n.startSec + n.durSec) - prev.startSec;
        prev.vel = Math.max(prev.vel, n.vel);
        merged++;
        continue;
      }
      if (n.startSec - prev.startSec < minSec) {
        // Two onsets on top of each other: keep the longer.
        if (n.durSec > prev.durSec) out[out.length - 1] = { ...n };
        blips++;
        continue;
      }
      if (prevEnd > n.startSec) prev.durSec = n.startSec - prev.startSec;
    }
    out.push({ ...n });
  }
  return { notes: out, blips, merged };
}

export interface GridLineOptions {
  grid: number;
  feel: number;
  /** Shortest note on the grid (ticks); default the grid (or 60 with no grid). */
  minDur?: number;
  /** Cut overlaps so the line stays monophonic. */
  mono?: boolean;
}

/** Seconds → grid notes: start quantized with feel, end snapped to the grid, notes before bar 1 dropped. */
export function toGridNotes(notes: readonly TranscribedNote[], g: TranscriptionGrid, o: GridLineOptions): { notes: GridNote[]; pickup: number } {
  const out: GridNote[] = [];
  let pickup = 0;
  const minDur = o.minDur ?? (o.grid > 1 ? o.grid : 60);
  for (const n of notes) {
    const s = g.toTick(n.startSec);
    const e = g.toTick(n.startSec + n.durSec);
    if (s < -(o.grid > 1 ? o.grid / 2 : 30)) {
      pickup++;
      continue;
    }
    const q = quantize(s, o.grid, o.feel);
    const endQ = o.grid > 1 ? Math.round(e / o.grid) * o.grid : Math.round(e);
    const dur = Math.max(minDur, endQ - q.cell);
    out.push({ tick: Math.max(0, q.tick), key: n.key, dur, vel: r2(Math.max(0.1, Math.min(1, isNum(n.vel) ? n.vel : 0.8))) });
  }
  out.sort((a, b) => a.tick - b.tick || a.key - b.key);
  if (o.mono) {
    // One note per grid cell (the louder / longer), and no overlaps.
    const res: GridNote[] = [];
    for (const n of out) {
      const prev = res[res.length - 1];
      if (prev && n.tick - prev.tick < Math.max(30, (o.grid > 1 ? o.grid : 60) / 2)) {
        if (n.dur * n.vel > prev.dur * prev.vel) res[res.length - 1] = n;
        continue;
      }
      if (prev && prev.tick + prev.dur > n.tick) prev.dur = Math.max(30, n.tick - prev.tick);
      res.push(n);
    }
    return { notes: res, pickup };
  }
  return { notes: out, pickup };
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export interface BassFix {
  notes: GridNote[];
  /** Notes moved by an octave. */
  octaveFixes: number;
  /** Whole-line octave shift for register sanity (semitones). */
  registerShift: number;
}

/** Bass register the line is kept in (MIDI, median). */
export const BASS_LOW = 28;
export const BASS_HIGH = 52;

/**
 * Octave errors and register: a chord-tone note an octave (or more) away from the line around it, and from both its
 * neighbours (or 20+ semitones off), moves back by octaves when that brings it within a fifth of the local median;
 * then the whole line shifts by octaves until its median sits in E1..E3.
 */
export function fixBass(line: readonly GridNote[], chords: readonly GridChord[]): BassFix {
  const notes = line.map((n) => ({ ...n }));
  let octaveFixes = 0;
  const W = 6;
  for (let i = 0; i < notes.length; i++) {
    const around = notes.slice(Math.max(0, i - W), i + W + 1).filter((_, j) => j !== Math.min(i, W));
    if (around.length < 2) continue;
    const m = median(around.map((n) => n.key));
    const n = notes[i];
    if (Math.abs(n.key - m) < 10) continue;
    // An octave jump the line answers (root → octave → fifth) is music; an error stands alone, far from both
    // neighbours (or far outside the line's register).
    const prev = i > 0 ? notes[i - 1].key : null;
    const next = i + 1 < notes.length ? notes[i + 1].key : null;
    const alone = (prev === null || Math.abs(n.key - prev) >= 10) && (next === null || Math.abs(n.key - next) >= 10);
    if (!alone && Math.abs(n.key - m) < 20) continue;
    const c = chordAt(chords, n.tick);
    // Aim at the line's low quartile: roots sit at the bottom of a bassline, octave jumps above them.
    const low = around.map((x) => x.key).sort((a, b) => a - b)[Math.floor(around.length / 4)];
    let best = n.key;
    for (const d of [-24, -12, 12, 24]) {
      const k = n.key + d;
      if (k < 0 || k > 127) continue;
      if (Math.abs(k - low) < Math.abs(best - low)) best = k;
    }
    // Only move notes that are a chord tone (or with no chord to check): a real leap to a passing tone stays.
    const tone = !c || chordPcs(c).includes(mod12(n.key));
    if (best !== n.key && Math.abs(best - m) <= 9 && tone) {
      n.key = best;
      octaveFixes++;
    }
  }
  let shift = 0;
  const med = median(notes.map((n) => n.key));
  if (isNum(med)) {
    while (med + shift > BASS_HIGH + 3 && med + shift - 12 >= BASS_LOW - 4) shift -= 12;
    while (med + shift < BASS_LOW && med + shift + 12 <= BASS_HIGH) shift += 12;
  }
  if (shift) for (const n of notes) n.key = Math.max(0, Math.min(127, n.key + shift));
  return { notes, octaveFixes, registerShift: shift };
}

export type BassClass = 'root' | 'fifth' | 'octave';

/**
 * The contour class of each bass note against the chord under it: on the root (low or an octave up), on the fifth,
 * or (any other tone) by direction: up from the previous note = fifth (octave for a big leap), else the root.
 */
export function bassClasses(line: readonly GridNote[], chords: readonly GridChord[]): BassClass[] {
  const out: BassClass[] = [];
  const lowRoot = new Map<GridChord | null, number>();
  for (const n of line) {
    const c = chordAt(chords, n.tick);
    if (c && mod12(n.key - c.root) === 0) lowRoot.set(c, Math.min(lowRoot.get(c) ?? 999, n.key));
  }
  const allLow = Math.min(...line.map((n) => n.key));
  line.forEach((n, i) => {
    const c = chordAt(chords, n.tick);
    const prev = i > 0 ? line[i - 1] : null;
    if (c) {
      const iv = mod12(n.key - c.root);
      const floor = lowRoot.get(c) ?? allLow;
      if (iv === 0) return out.push(n.key - floor >= 10 ? 'octave' : 'root');
      if (iv === fifthOf(c.quality)) return out.push('fifth');
    }
    if (prev && n.key > prev.key) return out.push(n.key - prev.key >= 10 ? 'octave' : out[i - 1] === 'fifth' ? 'octave' : 'fifth');
    return out.push('root');
  });
  return out;
}

/**
 * 'style' bass: the reference's onsets and lengths, pitches from the chords (root / fifth / octave by the contour
 * class), the root in the octave nearest the reference line's median (else `fallbackRoot`'s near E2).
 */
export function styleBass(line: readonly GridNote[], chords: readonly GridChord[], fallbackRoot: number | null): GridNote[] {
  const cls = bassClasses(line, chords);
  const med = median(line.map((n) => n.key));
  const centre = isNum(med) ? Math.max(BASS_LOW + 4, Math.min(BASS_HIGH - 6, med)) : 40;
  const rootNear = (pc: number) => {
    let r = Math.floor(centre / 12) * 12 + mod12(pc);
    if (r - centre > 6) r -= 12;
    if (centre - r > 6) r += 12;
    return r;
  };
  return line.map((n, i) => {
    const c = chordAt(chords, n.tick) ?? chords.filter((x) => x.tick <= n.tick).pop() ?? chords[0] ?? null;
    const root = c ? rootNear(c.root) : rootNear(fallbackRoot ?? 9);
    const k = cls[i] === 'fifth' ? root + (c ? fifthOf(c.quality) : 7) : cls[i] === 'octave' ? root + 12 : root;
    return { ...n, key: Math.max(0, Math.min(127, k)) };
  });
}

/**
 * The top line of polyphonic notes (skyline): at any moment the highest sounding note; a note's onset counts when
 * nothing higher is sounding then and it stays on top for at least `minSec`. Notes struck together with two or more
 * others and ending with them (a block chord's top voice) are left to the chords where possible.
 */
export function skyline(poly: readonly TranscribedNote[], minSec = 0.08): TranscribedNote[] {
  const notes = cleanNotes(poly).filter((n) => n.key >= 48);
  const out: TranscribedNote[] = [];
  const maxDur = notes.reduce((m, n) => Math.max(m, n.durSec), 0);
  let lo = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    while (lo < i && notes[lo].startSec < n.startSec - maxDur - 0.02) lo++;
    const end = n.startSec + n.durSec;
    // Block chord: ≥ 2 other notes starting within 35 ms and ending within 15% of this one's length.
    let block = 0;
    for (let j = Math.max(0, i - 8); j < Math.min(notes.length, i + 9); j++) {
      if (j === i) continue;
      const o = notes[j];
      if (Math.abs(o.startSec - n.startSec) <= 0.035 && Math.abs(o.startSec + o.durSec - end) <= 0.15 * n.durSec + 0.02) block++;
    }
    if (block >= 2) continue;
    // The time this note is the highest sounding one, from its onset on.
    let topEnd = end;
    let coveredAtOnset = false;
    for (let j = lo; j < notes.length; j++) {
      const o = notes[j];
      if (o.startSec > end) break;
      if (j === i || o.key <= n.key) continue;
      const oEnd = o.startSec + o.durSec;
      if (o.startSec <= n.startSec + 0.01 && oEnd > n.startSec + 0.01) coveredAtOnset = true;
      else if (o.startSec > n.startSec && o.startSec < topEnd) topEnd = o.startSec;
    }
    if (coveredAtOnset || topEnd - n.startSec < minSec) continue;
    out.push({ ...n, durSec: topEnd - n.startSec });
  }
  return monoCleanup(out, minSec, 0.03).notes;
}

/** Share (by duration) of a line's notes whose pitch class is a tone of the chord under them (null: no chords). */
export function chordToneShare(line: readonly GridNote[], chords: readonly GridChord[]): number | null {
  let tot = 0;
  let hit = 0;
  for (const n of line) {
    const c = chordAt(chords, n.tick);
    if (!c) continue;
    tot += n.dur;
    if (chordPcs(c).includes(mod12(n.key))) hit += n.dur;
  }
  return tot > 0 ? hit / tot : null;
}

/** Notes per bar over the part's span. */
export function density(notes: readonly GridNote[], ticksPerBar = 4 * PPQ): number {
  if (!notes.length) return 0;
  const span = notes[notes.length - 1].tick + notes[notes.length - 1].dur - notes[0].tick;
  return notes.length / Math.max(1, span / ticksPerBar);
}
