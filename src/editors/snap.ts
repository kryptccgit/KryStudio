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

export function snapTicks(id: SnapId, ts: TimeSig): number {
  if (id === 'none') return 1;
  if (id === 'bar') return ticksPerBar(ts);
  if (id === 'step') return Math.min(TICKS_PER_STEP, ticksPerBeat(ts));
  return Math.max(1, Math.round(ticksPerBeat(ts) / BEAT_DIV[id]));
}

export type SnapMode = 'round' | 'floor' | 'ceil';

export function snapTo(tick: number, grid: number, mode: SnapMode = 'round'): number {
  if (grid <= 1) return mode === 'floor' ? Math.floor(tick) : mode === 'ceil' ? Math.ceil(tick) : Math.round(tick);
  const q = tick / grid;
  const n = mode === 'floor' ? Math.floor(q + 1e-9) : mode === 'ceil' ? Math.ceil(q - 1e-9) : Math.round(q);
  return n * grid;
}

export function snapMoveDelta(primaryStart: number, rawDelta: number, grid: number, minStart: number, bypass = false): number {
  let d = bypass || grid <= 1 ? Math.round(rawDelta) : snapTo(primaryStart + rawDelta, grid) - primaryStart;
  if (minStart + d < 0) d = -minStart;
  return d;
}

export function snapResizeEnd(start: number, rawEnd: number, grid: number, bypass = false): number {
  const g = bypass ? 1 : grid;
  const end = snapTo(rawEnd, g);
  return Math.max(g <= 1 ? 1 : g, end - start, 1);
}

export function snapResizeStart(end: number, rawStart: number, grid: number, bypass = false): { start: number; len: number } {
  const g = bypass ? 1 : grid;
  const minLen = g <= 1 ? 1 : g;
  let start = Math.max(0, snapTo(rawStart, g));
  if (end - start < minLen) start = end - minLen;
  start = Math.max(0, start);
  return { start, len: Math.max(1, end - start) };
}

export function cellStart(tick: number, grid: number, bypass = false): number {
  return Math.max(0, bypass ? Math.round(tick) : snapTo(tick, grid, 'floor'));
}
