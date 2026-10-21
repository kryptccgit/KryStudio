export interface TimeView {
  scrollTick: number;
  pxPerTick: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function tickToX(v: TimeView, tick: number): number {
  return (tick - v.scrollTick) * v.pxPerTick;
}

export function xToTick(v: TimeView, x: number): number {
  return v.scrollTick + x / v.pxPerTick;
}

export function viewTicks(v: TimeView, w: number): number {
  return w / v.pxPerTick;
}

/**
 * Zoom by `factor`, keeping the tick under `anchorX` fixed (cursor-anchored
 * zoom, ported from KryptEditor Timeline). Scroll never goes below 0.
 */
export function zoomAt(v: TimeView, anchorX: number, factor: number, minPx: number, maxPx: number): TimeView {
  const pxPerTick = clamp(v.pxPerTick * factor, minPx, maxPx);
  const t = xToTick(v, anchorX);
  return { pxPerTick, scrollTick: Math.max(0, t - anchorX / pxPerTick) };
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -400, 400) * 0.0025);
}

export function clampScroll(scroll: number, contentLen: number, viewLen: number): number {
  return clamp(scroll, 0, Math.max(0, contentLen - viewLen));
}

export interface KeyView {
  scrollY: number;
  rowH: number;
}

export const KEY_COUNT = 128;

export function keyToY(v: KeyView, key: number): number {
  return (127 - key) * v.rowH - v.scrollY;
}

export function yToKey(v: KeyView, y: number): number {
  return 127 - Math.floor((y + v.scrollY) / v.rowH);
}

export function visibleKeys(v: KeyView, h: number): [number, number] {
  const hi = clamp(yToKey(v, 0), 0, 127);
  const lo = clamp(yToKey(v, h - 1), 0, 127);
  return [lo, hi];
}

export function zoomRowsAt(v: KeyView, anchorY: number, factor: number, minH: number, maxH: number): KeyView {
  const rowH = clamp(v.rowH * factor, minH, maxH);
  const contentY = (anchorY + v.scrollY) / v.rowH;
  return { rowH, scrollY: Math.max(0, contentY * rowH - anchorY) };
}

export interface LaneLayout {
  ids: string[];
  tops: number[];
  heights: number[];
  total: number;
}

export function buildLanes(ids: string[], heightOf: (id: string, i: number) => number): LaneLayout {
  const tops: number[] = new Array(ids.length);
  const heights: number[] = new Array(ids.length);
  let y = 0;
  for (let i = 0; i < ids.length; i++) {
    const h = Math.max(1, heightOf(ids[i], i));
    tops[i] = y;
    heights[i] = h;
    y += h;
  }
  return { ids, tops, heights, total: y };
}

export function laneAt(l: LaneLayout, contentY: number): number {
  if (contentY < 0) return -1;
  if (contentY >= l.total) return l.ids.length;
  let lo = 0;
  let hi = l.ids.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.tops[mid] <= contentY) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function visibleLanes(l: LaneLayout, scrollY: number, h: number): [number, number] {
  if (l.ids.length === 0) return [0, -1];
  const a = clamp(laneAt(l, Math.max(0, scrollY)), 0, l.ids.length - 1);
  const b = clamp(laneAt(l, scrollY + h - 1), 0, l.ids.length - 1);
  return [a, b];
}

export function edgeScrollStep(pos: number, min: number, max: number, edge = 16, maxStep = 22): number {
  if (pos < min + edge) return -Math.min(maxStep, 3 + (min + edge - pos) / 3);
  if (pos > max - edge) return Math.min(maxStep, 3 + (pos - (max - edge)) / 3);
  return 0;
}
