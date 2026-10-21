// ──────────────────────────────────────────────────────────────────────
// Musical time. Everything in the document is stored in integer TICKS.
// PPQ = 960 (FL defaults to 96, which is too coarse for agents writing
// swung / tuplet material — see research/01 §7).
// ──────────────────────────────────────────────────────────────────────

export const PPQ = 960;
/** The step sequencer grid: 16th notes. */
export const STEPS_PER_BEAT = 4;
export const TICKS_PER_STEP = PPQ / STEPS_PER_BEAT; // 240

export interface TimeSig {
  num: number;
  den: number;
}

export function ticksPerBeat(ts: TimeSig): number {
  return (PPQ * 4) / ts.den;
}

export function ticksPerBar(ts: TimeSig): number {
  return ticksPerBeat(ts) * ts.num;
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / PPQ) * (60 / bpm);
}

export function secondsToTicks(seconds: number, bpm: number): number {
  return (seconds * bpm * PPQ) / 60;
}

/** Snap a tick to a grid (in ticks). mode 'round' | 'floor' | 'ceil'. */
export function snapTick(tick: number, grid: number, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
  if (grid <= 1) return Math.round(tick);
  const q = tick / grid;
  const n = mode === 'floor' ? Math.floor(q) : mode === 'ceil' ? Math.ceil(q) : Math.round(q);
  return n * grid;
}

/** Bars:Beats:Ticks, 1-based bars and beats (FL style "3:2:120"). */
export function formatBBT(tick: number, ts: TimeSig): string {
  const tpb = ticksPerBeat(ts);
  const tpbar = ticksPerBar(ts);
  const t = Math.max(0, Math.floor(tick));
  const bar = Math.floor(t / tpbar) + 1;
  const beat = Math.floor((t % tpbar) / tpb) + 1;
  const rem = t % tpb;
  return `${bar}:${beat}:${String(rem).padStart(3, '0')}`;
}

/** Common snap grids for editors, in ticks. */
export const SNAP_GRIDS: Array<{ id: string; label: string; ticks: number }> = [
  { id: 'none', label: 'None', ticks: 1 },
  { id: 'bar', label: 'Bar', ticks: PPQ * 4 },
  { id: 'beat', label: 'Beat', ticks: PPQ },
  { id: '1/2', label: '1/2 beat', ticks: PPQ / 2 },
  { id: '1/3', label: '1/3 beat', ticks: PPQ / 3 },
  { id: 'step', label: 'Step (1/4 beat)', ticks: PPQ / 4 },
  { id: '1/6', label: '1/6 beat', ticks: PPQ / 6 },
  { id: '1/8', label: '1/8 beat', ticks: PPQ / 8 },
  { id: '1/16', label: '1/16 beat', ticks: PPQ / 16 },
];
