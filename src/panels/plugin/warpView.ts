import { beatToSec, secToBeat, type WarpMarker } from '@shared/schema/warp';

export interface WarpMapping {
  beatAt(sec: number): number;
  secAt(beat: number): number;
  warped: boolean;
}

export function warpMapping(markers: WarpMarker[], tickBpm: number): WarpMapping {
  if (markers.length >= 2) {
    return { beatAt: (s) => secToBeat(markers, s)!, secAt: (b) => beatToSec(markers, b)!, warped: true };
  }
  const bps = (tickBpm > 0 ? tickBpm : 120) / 60;
  const m0 = markers[0];
  const shift = m0 ? m0.beat - m0.sec * bps : 0;
  return { beatAt: (s) => s * bps + shift, secAt: (b) => (b - shift) / bps, warped: false };
}

export interface GridLine {
  x: number;
  beat: number;
  bar: boolean;
}

export function gridLines(map: WarpMapping, durationSec: number, width: number, barQuarters: number): GridLine[] {
  if (!(durationSec > 0) || !(width > 0)) return [];
  const b0 = map.beatAt(0);
  const b1 = map.beatAt(durationSec);
  if (!Number.isFinite(b0) || !Number.isFinite(b1) || b1 <= b0) return [];
  const pxPerBeat = width / (b1 - b0);
  const bar = barQuarters > 0 ? barQuarters : 4;
  const step = pxPerBeat >= 6 ? 1 : pxPerBeat * bar >= 6 ? bar : 0;
  if (!step) return [];
  const out: GridLine[] = [];
  for (let b = Math.ceil(Math.max(0, b0) / step) * step; b <= b1 && out.length < 2000; b += step) {
    const x = (map.secAt(b) / durationSec) * width;
    if (x >= 0 && x <= width) out.push({ x, beat: b, bar: Math.abs(b / bar - Math.round(b / bar)) < 1e-9 });
  }
  return out;
}

export function clampDragSec(markers: WarpMarker[], index: number, sec: number, durationSec: number | null): number {
  const eps = 0.001;
  const lo = index > 0 ? markers[index - 1].sec + eps : 0;
  let hi = index < markers.length - 1 ? markers[index + 1].sec - eps : durationSec !== null ? durationSec - eps : Infinity;
  if (hi < lo) hi = lo;
  return Math.min(hi, Math.max(lo, sec));
}

export function snapBeat(beat: number, step = 0.25): number {
  return Math.round(beat / step) * step;
}

export function beatLabel(beat: number, barQuarters: number): string {
  const bar = barQuarters > 0 ? barQuarters : 4;
  const b = Math.round(beat * 1000) / 1000;
  const barNo = Math.floor(b / bar + 1e-9) + 1;
  const inBar = b - (barNo - 1) * bar;
  const whole = Math.floor(inBar + 1e-9);
  const frac = Math.round((inBar - whole) * 100);
  return `${barNo}.${whole + 1}${frac > 0 && frac < 100 ? `.${String(frac).padStart(2, '0')}` : ''}`;
}
