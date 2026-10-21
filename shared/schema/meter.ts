// ──────────────────────────────────────────────────────────────────────
// Time-signature helpers for the UI and agents (Wave 12.2b): the picker
// presets, parsing "7/8", and how a bar is grouped (6/8 and 12/8 count in
// dotted quarters). Bar maths itself stays in ./time.ts (ticksPerBar).
// ──────────────────────────────────────────────────────────────────────

import { TICKS_PER_STEP, ticksPerBar, ticksPerBeat, type TimeSig } from './time';

/** Denominators the transport accepts (transport.set). */
export const TIME_SIG_DENOMINATORS = [2, 4, 8, 16] as const;
export const TIME_SIG_MAX_NUM = 32;

export interface TimeSigPreset {
  num: number;
  den: number;
  /** What it is usually heard as, for the picker. */
  hint: string;
}

/** The picker's common meters, in the order shown. */
export const TIME_SIG_PRESETS: TimeSigPreset[] = [
  { num: 4, den: 4, hint: 'Common time: most pop, hip-hop, house' },
  { num: 3, den: 4, hint: 'Waltz' },
  { num: 6, den: 8, hint: 'Two dotted-quarter beats: ballads, jigs' },
  { num: 12, den: 8, hint: 'Four dotted-quarter beats: blues shuffle, slow soul' },
  { num: 5, den: 4, hint: 'Odd meter: five beats' },
  { num: 7, den: 8, hint: 'Odd meter: 2+2+3 eighths' },
  { num: 2, den: 4, hint: 'Marches, polka' },
];

export function formatTimeSig(ts: TimeSig): string {
  return `${ts.num}/${ts.den}`;
}

export function sameTimeSig(a: TimeSig, b: TimeSig): boolean {
  return a.num === b.num && a.den === b.den;
}

/** A valid transport time signature, or why not (null = valid). */
export function timeSigProblem(num: number, den: number): string | null {
  if (!Number.isInteger(num) || num < 1 || num > TIME_SIG_MAX_NUM) return `The top number must be a whole number from 1 to ${TIME_SIG_MAX_NUM}`;
  if (!(TIME_SIG_DENOMINATORS as readonly number[]).includes(den)) return `The bottom number must be ${TIME_SIG_DENOMINATORS.join(', ')}`;
  return null;
}

/** "7/8", " 12 / 8 " → { num, den }; null when it isn't a valid transport time signature. */
export function parseTimeSig(text: string): TimeSig | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return timeSigProblem(num, den) ? null : { num, den };
}

/** Compound meters (6/8, 9/8, 12/8, 6/16 …) are felt in groups of three of their beat unit. */
export function isCompound(ts: TimeSig): boolean {
  return ts.den >= 8 && ts.num > 3 && ts.num % 3 === 0;
}

/** The felt beat in ticks: a dotted quarter in 6/8, else the beat unit (a quarter in 4/4, an eighth in 7/8). */
export function beatGroupTicks(ts: TimeSig): number {
  return ticksPerBeat(ts) * (isCompound(ts) ? 3 : 1);
}

/** 16th-note steps in a bar (the Channel Rack row length): 16 in 4/4, 12 in 3/4 and 6/8, 14 in 7/8. */
export function stepsPerBar(ts: TimeSig): number {
  return Math.max(1, Math.round(ticksPerBar(ts) / TICKS_PER_STEP));
}

/** Steps per felt beat, for shading step rows: 4 in 4/4, 6 in 6/8, 2 in 7/8. */
export function stepsPerBeatGroup(ts: TimeSig): number {
  return Math.max(1, Math.round(beatGroupTicks(ts) / TICKS_PER_STEP));
}
