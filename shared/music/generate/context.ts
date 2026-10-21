// What every generator gets (the key, the bar range, the chords already in
// the pattern) and gives back (notes with absolute pattern ticks), plus the
// chord timeline the arp, bass and melody generators follow.

import {
  GenerateError,
  applyVoicing,
  resolveProgression,
  voiceClose,
  type ChordEvent,
  type Extensions,
  type GenKey,
} from './harmony';
import type { Rng } from './random';

export interface GenContext {
  key: GenKey;
  /** Range in pattern ticks [start, end). */
  start: number;
  end: number;
  barTicks: number;
  beatTicks: number;
  seed: number;
  /** Chords already in the pattern (absolute ticks), read before anything is replaced. */
  patternChords: ChordEvent[];
  /** Pitch for one-note rhythms when the options give none (the channel's root key). */
  defaultNote: number;
}

export interface GenNote {
  tick: number;
  dur: number;
  key: number;
  vel: number;
  slide?: boolean;
}

export interface GenOutput {
  notes: GenNote[];
  /** Chord names followed or written, in order. */
  chords?: string[];
  /** Where the harmony came from. */
  chordSource?: 'pattern' | 'progression' | 'none';
  /** One line for the summary ("progression Pop anthem", "E(5,16) rotation 2"). */
  detail: string;
}

export const vel3 = (v: number): number => Math.round(Math.min(1, Math.max(0.02, v)) * 1000) / 1000;

export interface Timeline {
  events: ChordEvent[];
  source: 'pattern' | 'progression' | 'none';
  label: string;
}

/**
 * The harmony to follow: the pattern's own chords ("pattern", or "auto"
 * when there are any in range), else a progression laid out from the range
 * start, `barsPerChord` bars per chord, voiced close around `octave`.
 */
export function chordTimeline(
  o: { chords: 'auto' | 'pattern' | 'progression' | 'none'; progression: string; extensions?: Extensions | 'auto'; barsPerChord: number; octave?: number },
  ctx: GenContext,
  rng: Rng,
): Timeline {
  if (o.chords === 'none') return { events: [], source: 'none', label: 'no chords' };
  const inRange = ctx.patternChords.filter((e) => e.tick < ctx.end && e.end > ctx.start);
  if (o.chords === 'pattern' && !inRange.length) {
    throw new GenerateError('No chords to follow in this bar range: write some chords (3 or more notes together on any channel) first, or follow a progression');
  }
  if (o.chords !== 'progression' && inRange.length) {
    const events = ctx.patternChords.map((e, i, all) => (i === all.length - 1 ? { ...e, end: Math.max(e.end, ctx.end) } : e));
    return { events, source: 'pattern', label: 'the chords in the pattern' };
  }
  const prog = resolveProgression(o.progression, ctx.key, o.extensions ?? 'auto', rng);
  const slot = Math.max(1, Math.round(o.barsPerChord * ctx.barTicks));
  const center = ((o.octave ?? 4) + 1) * 12 + 4;
  const events: ChordEvent[] = [];
  let prev: number[] | null = null;
  for (let t = ctx.start, i = 0; t < ctx.end; t += slot, i++) {
    const c = prog.chords[i % prog.chords.length];
    const keys = applyVoicing(voiceClose(c, center, 'auto', prev), c, 'close');
    prev = keys;
    events.push({ tick: t, end: Math.min(ctx.end, t + slot), keys, root: c.root, tones: c.tones, name: c.name });
  }
  return { events, source: 'progression', label: `progression ${prog.label}` };
}

/** Distinct chord names in order of appearance (repeats of the loop collapsed). */
export function chordNames(events: ChordEvent[], start: number, end: number): string[] {
  const out: string[] = [];
  for (const e of events) if (e.tick < end && e.end > start) out.push(e.name);
  // collapse a repeating loop: "Am F C G Am F C G" → "Am F C G"
  for (let len = 1; len <= out.length / 2; len++) {
    if (out.length % len === 0 && out.every((n, i) => n === out[i % len])) return out.slice(0, len);
  }
  return out;
}
