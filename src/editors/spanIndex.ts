export class SpanIndex<T> {
  readonly items: T[];
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  readonly maxLen: number;

  constructor(items: Iterable<T>, start: (t: T) => number, len: (t: T) => number) {
    const arr = Array.from(items);
    arr.sort((a, b) => start(a) - start(b));
    this.items = arr;
    this.starts = new Float64Array(arr.length);
    this.ends = new Float64Array(arr.length);
    let maxLen = 0;
    for (let i = 0; i < arr.length; i++) {
      const s = start(arr[i]);
      const l = len(arr[i]);
      this.starts[i] = s;
      this.ends[i] = s + l;
      if (l > maxLen) maxLen = l;
    }
    this.maxLen = maxLen;
  }

  get size(): number {
    return this.items.length;
  }

  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  query(t0: number, t1: number, fn: (item: T, i: number) => boolean | void): void {
    const n = this.starts.length;
    for (let i = this.lowerBound(t0 - this.maxLen); i < n; i++) {
      const s = this.starts[i];
      if (s >= t1) break;
      if (this.ends[i] > t0 && fn(this.items[i], i) === false) return;
    }
  }

  lastEnd(): number {
    let m = 0;
    for (let i = 0; i < this.ends.length; i++) if (this.ends[i] > m) m = this.ends[i];
    return m;
  }
}

export type EdgeZone = 'body' | 'left' | 'right';

export function edgeZone(x: number, left: number, right: number, edgePx = 5): EdgeZone {
  const e = Math.min(edgePx, (right - left) / 3);
  if (x >= right - e) return 'right';
  if (x <= left + e) return 'left';
  return 'body';
}

export interface NoteShape {
  id: string;
  tick: number;
  dur: number;
  key: number;
}

export function hitNote<T extends NoteShape>(
  index: SpanIndex<T>,
  tick: number,
  key: number,
  pxPerTick: number,
  edgePx = 5,
  skip?: Set<string>,
): { note: T; zone: EdgeZone } | null {
  let inside: T | null = null;
  let nearby: T | null = null;
  const slack = 2 / pxPerTick;
  index.query(tick - slack, tick + slack, (n) => {
    if (n.key !== key || skip?.has(n.id)) return;
    if (tick >= n.tick && tick < n.tick + n.dur) inside = n;
    else if (tick >= n.tick - slack && tick < n.tick + n.dur + slack) nearby = n;
  });
  const b = (inside ?? nearby) as T | null;
  if (!b) return null;
  const zone = edgeZone(tick * pxPerTick, b.tick * pxPerTick, (b.tick + b.dur) * pxPerTick, edgePx);
  return { note: b, zone };
}

export function notesInRect<T extends NoteShape>(index: SpanIndex<T>, t0: number, t1: number, k0: number, k1: number): T[] {
  const lo = Math.min(k0, k1);
  const hi = Math.max(k0, k1);
  const out: T[] = [];
  index.query(Math.min(t0, t1), Math.max(t0, t1), (n) => {
    if (n.key >= lo && n.key <= hi) out.push(n);
  });
  return out;
}

export interface ClipShape {
  id: string;
  start: number;
  length: number;
}

export function hitClip<T extends ClipShape>(index: SpanIndex<T> | undefined, tick: number, pxPerTick: number, edgePx = 6): { clip: T; zone: EdgeZone } | null {
  if (!index) return null;
  let best: T | null = null;
  index.query(tick, tick + 1e-6, (c) => {
    best = c;
  });
  if (!best) return null;
  const b = best as T;
  return { clip: b, zone: edgeZone(tick * pxPerTick, b.start * pxPerTick, (b.start + b.length) * pxPerTick, edgePx) };
}

export function nearestPoint(points: ArrayLike<{ x: number; y: number }>, x: number, y: number, radiusPx = 6): number {
  let best = -1;
  let bestD = radiusPx * radiusPx;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - x;
    const dy = points[i].y - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
