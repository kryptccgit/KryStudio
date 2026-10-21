// Pure viewport math shared by every timeline editor (piano roll, playlist,
// event lanes). We own scrolling: canvases are viewport-sized and the scroll
// offset is view state (research/06 §1.4). No DOM in here — unit-tested.

export interface TimeView {
  /** Tick at the left edge of the content area. */
  scrollTick: number;
  /** Horizontal zoom. */
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

/** Ticks visible in a viewport `w` px wide. */
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

/** Exponential, delta-proportional wheel zoom: one notch (~100) ≈ ×1.28; trackpad pinch streams stay smooth. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -400, 400) * 0.0025);
}

/** Clamp a scroll offset to [0, content - view] (never negative). */
export function clampScroll(scroll: number, contentLen: number, viewLen: number): number {
  return clamp(scroll, 0, Math.max(0, contentLen - viewLen));
}

// ── Key rows (piano roll vertical axis: key 127 at the top) ──────────

export interface KeyView {
  /** Pixels scrolled from the top (key 127). */
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

/** Inclusive [lo, hi] key range visible in a viewport `h` px tall (clamped 0..127). */
export function visibleKeys(v: KeyView, h: number): [number, number] {
  const hi = clamp(yToKey(v, 0), 0, 127);
  const lo = clamp(yToKey(v, h - 1), 0, 127);
  return [lo, hi];
}

/** Zoom rows keeping the key under `anchorY` fixed. */
export function zoomRowsAt(v: KeyView, anchorY: number, factor: number, minH: number, maxH: number): KeyView {
  const rowH = clamp(v.rowH * factor, minH, maxH);
  const contentY = (anchorY + v.scrollY) / v.rowH; // fractional row index
  return { rowH, scrollY: Math.max(0, contentY * rowH - anchorY) };
}

// ── Lanes (playlist tracks: variable heights) ────────────────────────

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

/** Lane index at a CONTENT y (0 = top of first lane); -1 above, ids.length below. */
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

/** Inclusive [first, last] lane indexes intersecting [scrollY, scrollY + h). Empty → [0, -1]. */
export function visibleLanes(l: LaneLayout, scrollY: number, h: number): [number, number] {
  if (l.ids.length === 0) return [0, -1];
  const a = clamp(laneAt(l, Math.max(0, scrollY)), 0, l.ids.length - 1);
  const b = clamp(laneAt(l, scrollY + h - 1), 0, l.ids.length - 1);
  return [a, b];
}

// ── Drag edge auto-scroll ────────────────────────────────────────────

/**
 * Pixels to scroll this frame when the pointer is near/past an edge of
 * [min, max] (negative = toward min). 0 when well inside.
 */
export function edgeScrollStep(pos: number, min: number, max: number, edge = 16, maxStep = 22): number {
  if (pos < min + edge) return -Math.min(maxStep, 3 + (min + edge - pos) / 3);
  if (pos > max - edge) return Math.min(maxStep, 3 + (pos - (max - edge)) / 3);
  return 0;
}
