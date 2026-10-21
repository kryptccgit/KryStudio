export type GrooveClass = 'kick' | 'snare' | 'hihat' | 'other';

export const GROOVE_CLASSES: readonly GrooveClass[] = ['kick', 'snare', 'hihat', 'other'];

export interface GrooveCells {
  offset: readonly number[];
  spread: readonly number[];
  vel: readonly number[];
  prob: readonly number[];
  n: readonly number[];
}

export interface GrooveTemplate {
  id: string;
  label: string;
  styles: readonly string[];
  performances: number;
  drummers: number;
  bars: number;
  bpm: readonly [number, number, number];
  swing8: number;
  swing16: number;
  classes: Readonly<Record<GrooveClass, GrooveCells>>;
}
