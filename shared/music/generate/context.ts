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
  start: number;
  end: number;
  barTicks: number;
  beatTicks: number;
  seed: number;
  patternChords: ChordEvent[];
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
  chords?: string[];
  chordSource?: 'pattern' | 'progression' | 'none';
  detail: string;
}

export const vel3 = (v: number): number => Math.round(Math.min(1, Math.max(0.02, v)) * 1000) / 1000;

export interface Timeline {
  events: ChordEvent[];
  source: 'pattern' | 'progression' | 'none';
  label: string;
}

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

export function chordNames(events: ChordEvent[], start: number, end: number): string[] {
  const out: string[] = [];
  for (const e of events) if (e.tick < end && e.end > start) out.push(e.name);
  for (let len = 1; len <= out.length / 2; len++) {
    if (out.length % len === 0 && out.every((n, i) => n === out[i % len])) return out.slice(0, len);
  }
  return out;
}
