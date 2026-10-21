// The SHAPE of a melody (vocal or lead line) as numbers, for 'style' builds:
// the agent writes an ORIGINAL top line with the same register, density,
// rhythm mix, phrase length, rests and step / leap balance, never the notes
// themselves. Pure.

import { noteName } from '../music/theory';
import { PPQ } from '../schema/time';
import type { GridNote } from './types';

export interface MelodyShape {
  /** Where the line came from. */
  source: 'vocals' | 'other' | 'notes';
  notes: number;
  /** Median MIDI key and its name ("G4"). */
  medianKey: number;
  medianName: string;
  /** 10th..90th percentile keys and the span between them (semitones). */
  low: number;
  high: number;
  rangeSemis: number;
  /** Notes per bar while the line is active (bars with at least one note). */
  notesPerBar: number;
  /** Shares of note lengths (sum 1): ≤ a 16th, ≤ an 8th, ≤ a quarter, longer. */
  rhythm: { sixteenths: number; eighths: number; quarters: number; long: number };
  /** Median phrase length in bars (phrases split at rests of a beat or more), to 0.5. */
  phraseBars: number;
  /** Share of the line's active span (first to last note) with nothing sounding. */
  restRatio: number;
  /** Shares of the intervals between consecutive notes: repeats (0), steps (1-2 semitones), leaps (3+). */
  intervals: { repeats: number; steps: number; leaps: number };
  /** Share of notes starting on a beat (vs syncopated / off-beat). */
  onBeat: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** The shape of a monophonic line on the grid (ticks from bar 1). null with fewer than 4 notes. */
export function melodyShape(line: readonly GridNote[], ticksPerBar = 4 * PPQ, source: MelodyShape['source'] = 'notes'): MelodyShape | null {
  const notes = line.filter((n) => n && Number.isFinite(n.tick) && n.dur > 0).slice().sort((a, b) => a.tick - b.tick);
  if (notes.length < 4) return null;
  const keys = notes.map((n) => n.key).sort((a, b) => a - b);
  const med = pct(keys, 0.5);
  const low = pct(keys, 0.1);
  const high = pct(keys, 0.9);
  const bars = new Set(notes.map((n) => Math.floor(n.tick / ticksPerBar)));
  const sixteenth = PPQ / 4;
  const rh = { sixteenths: 0, eighths: 0, quarters: 0, long: 0 };
  for (const n of notes) {
    if (n.dur <= sixteenth * 1.5) rh.sixteenths++;
    else if (n.dur <= sixteenth * 3) rh.eighths++;
    else if (n.dur <= PPQ * 1.5) rh.quarters++;
    else rh.long++;
  }
  // Phrases: split where the gap from one note's end to the next onset is a beat or more.
  const phrases: number[] = [];
  let pStart = notes[0].tick;
  let pEnd = notes[0].tick + notes[0].dur;
  for (let i = 1; i <= notes.length; i++) {
    const n = notes[i];
    if (!n || n.tick - pEnd >= PPQ) {
      phrases.push((pEnd - pStart) / ticksPerBar);
      if (n) {
        pStart = n.tick;
        pEnd = n.tick + n.dur;
      }
      continue;
    }
    pEnd = Math.max(pEnd, n.tick + n.dur);
  }
  // Rests: the active span minus the union of the notes.
  let covered = 0;
  let cs = notes[0].tick;
  let ce = notes[0].tick + notes[0].dur;
  for (const n of notes.slice(1)) {
    if (n.tick > ce) {
      covered += ce - cs;
      cs = n.tick;
      ce = n.tick + n.dur;
    } else ce = Math.max(ce, n.tick + n.dur);
  }
  covered += ce - cs;
  const span = Math.max(1, notes[notes.length - 1].tick + notes[notes.length - 1].dur - notes[0].tick);
  const iv = { repeats: 0, steps: 0, leaps: 0 };
  for (let i = 1; i < notes.length; i++) {
    const d = Math.abs(notes[i].key - notes[i - 1].key);
    if (d === 0) iv.repeats++;
    else if (d <= 2) iv.steps++;
    else iv.leaps++;
  }
  const ivN = Math.max(1, notes.length - 1);
  const ph = phrases.slice().sort((a, b) => a - b);
  const onBeat = notes.filter((n) => Math.abs(n.tick - Math.round(n.tick / PPQ) * PPQ) <= PPQ / 16).length / notes.length;
  return {
    source,
    notes: notes.length,
    medianKey: med,
    medianName: noteName(med),
    low,
    high,
    rangeSemis: high - low,
    notesPerBar: r2(notes.length / Math.max(1, bars.size)),
    rhythm: { sixteenths: r2(rh.sixteenths / notes.length), eighths: r2(rh.eighths / notes.length), quarters: r2(rh.quarters / notes.length), long: r2(rh.long / notes.length) },
    phraseBars: Math.max(0.5, Math.round(pct(ph, 0.5) * 2) / 2),
    restRatio: r2(Math.max(0, 1 - covered / span)),
    intervals: { repeats: r2(iv.repeats / ivN), steps: r2(iv.steps / ivN), leaps: r2(iv.leaps / ivN) },
    onBeat: r2(onBeat),
  };
}

/** One line for the agent: "Melody shape (vocals): around G4 (D4-C5, 10 semitones), 3.5 notes per bar, …". */
export function melodyShapeText(s: MelodyShape): string {
  const r = s.rhythm;
  const i = s.intervals;
  return (
    `Melody shape (${s.source === 'vocals' ? 'the vocal line' : s.source === 'other' ? 'the lead line' : 'the line'}; write an ORIGINAL melody with this shape, never its notes): ` +
    `around ${s.medianName} (${noteName(s.low)}-${noteName(s.high)}, ${s.rangeSemis} semitones), ${s.notesPerBar} notes per bar, ` +
    `rhythm ${Math.round(r.sixteenths * 100)}% 16ths / ${Math.round(r.eighths * 100)}% 8ths / ${Math.round(r.quarters * 100)}% quarters / ${Math.round(r.long * 100)}% long, ` +
    `phrases of about ${s.phraseBars} bars, ${Math.round(s.restRatio * 100)}% rests, ` +
    `${Math.round(i.steps * 100)}% steps / ${Math.round(i.leaps * 100)}% leaps / ${Math.round(i.repeats * 100)}% repeats, ${Math.round(s.onBeat * 100)}% of notes on the beat.`
  );
}
