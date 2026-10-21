// Grid snapping for every editor. Pure + unit-tested.
// Alt bypasses snap (FL feel) — callers pass `bypass`.

import { TICKS_PER_STEP, ticksPerBar, ticksPerBeat, type TimeSig } from '@shared/schema/time';

export type SnapId = 'bar' | 'beat' | '1/2' | '1/3' | 'step' | '1/6' | '1/8' | '1/16' | 'none';

export const SNAP_OPTIONS: Array<{ id: SnapId; label: string }> = [
  { id: 'bar', label: 'Bar' },
  { id: 'beat', label: 'Beat' },
  { id: '1/2', label: '1/2 beat' },
  { id: '1/3', label: '1/3 beat' },
  { id: 'step', label: 'Step' },
  { id: '1/6', label: '1/6 beat' },
  { id: '1/8', label: '1/8 beat' },
  { id: '1/16', label: '1/16 beat' },
  { id: 'none', label: 'None' },
];

const BEAT_DIV: Record<Exclude<SnapId, 'bar' | 'none'>, number> = {
  beat: 1,
  '1/2': 2,
  '1/3': 3,
  step: 4,
  '1/6': 6,
  '1/8': 8,
  '1/16': 16,
};

/** Grid size in ticks (1 = free). Respects the time signature's beat unit. */
export function snapTicks(id: SnapId, ts: TimeSig): number {
  if (id === 'none') return 1;
  if (id === 'bar') return ticksPerBar(ts);
  // A step is a 16th note in every meter, like the Channel Rack (in 6/8 a quarter of the eighth-note beat would be a 32nd).
  if (id === 'step') return Math.min(TICKS_PER_STEP, ticksPerBeat(ts));
  return Math.max(1, Math.round(ticksPerBeat(ts) / BEAT_DIV[id]));
}

export type SnapMode = 'round' | 'floor' | 'ceil';

/** Snap an absolute tick to the grid. grid <= 1 → integer ticks. */
export function snapTo(tick: number, grid: number, mode: SnapMode = 'round'): number {
  if (grid <= 1) return mode === 'floor' ? Math.floor(tick) : mode === 'ceil' ? Math.ceil(tick) : Math.round(tick);
  const q = tick / grid;
  // epsilon so 959.9999 (float noise) floors to 960 where intended
  const n = mode === 'floor' ? Math.floor(q + 1e-9) : mode === 'ceil' ? Math.ceil(q - 1e-9) : Math.round(q);
  return n * grid;
}

/**
 * Snapped delta for a MOVE: the grabbed item's start lands on the grid
 * (rounded), every other selected item shifts by the same delta.
 * The result keeps every start >= 0 given `minStart` (the earliest origin).
 */
export function snapMoveDelta(primaryStart: number, rawDelta: number, grid: number, minStart: number, bypass = false): number {
  let d = bypass || grid <= 1 ? Math.round(rawDelta) : snapTo(primaryStart + rawDelta, grid) - primaryStart;
  if (minStart + d < 0) d = -minStart;
  return d;
}

/**
 * Resize the END edge to `rawEnd`. Returns the new duration, at least
 * `minLen` (one grid cell when snapping, 1 tick when free).
 */
export function snapResizeEnd(start: number, rawEnd: number, grid: number, bypass = false): number {
  const g = bypass ? 1 : grid;
  const end = snapTo(rawEnd, g);
  return Math.max(g <= 1 ? 1 : g, end - start, 1);
}

/** Resize the START edge to `rawStart` keeping the end fixed. Returns { start, len }. */
export function snapResizeStart(end: number, rawStart: number, grid: number, bypass = false): { start: number; len: number } {
  const g = bypass ? 1 : grid;
  const minLen = g <= 1 ? 1 : g;
  let start = Math.max(0, snapTo(rawStart, g));
  if (end - start < minLen) start = end - minLen;
  start = Math.max(0, start);
  return { start, len: Math.max(1, end - start) };
}

/** Cell under the pointer (FL places new notes at the START of the clicked cell). */
export function cellStart(tick: number, grid: number, bypass = false): number {
  return Math.max(0, bypass ? Math.round(tick) : snapTo(tick, grid, 'floor'));
}
