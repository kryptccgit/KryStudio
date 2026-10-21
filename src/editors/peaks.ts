// Waveform peaks cache, one entry per sample path (decode once, in-flight
// dedupe). Failures are remembered briefly so a missing file doesn't spam
// the engine every repaint, then retried. No per-file normalization.

export interface PeakData {
  min: Float32Array;
  max: Float32Array;
  buckets: number;
  frames: number;
  sampleRate: number;
}

const BUCKETS = 8192;
const RETRY_MS = 15000;

type Entry = { state: 'loading' } | { state: 'ok'; data: PeakData } | { state: 'fail'; at: number; message: string };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

/** Called when any peaks request settles (painters mark themselves dirty). */
export function onPeaksReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Cached peaks for a path, or null (and start loading). */
export function getPeaks(path: string): PeakData | null {
  const e = cache.get(path);
  if (e?.state === 'ok') return e.data;
  if (e?.state === 'loading') return null;
  if (e?.state === 'fail' && performance.now() - e.at < RETRY_MS) return null;
  cache.set(path, { state: 'loading' });
  void load(path);
  return null;
}

async function load(path: string): Promise<void> {
  try {
    const r = await window.krypt.engine.peaks(path, BUCKETS);
    if (!r.ok || !r.data || !r.data.data?.length) {
      cache.set(path, { state: 'fail', at: performance.now(), message: r.message ?? 'No peaks' });
    } else {
      const p = r.data;
      const n = Math.floor(p.data.length / 2);
      const min = new Float32Array(n);
      const max = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        min[i] = p.data[i * 2];
        max[i] = p.data[i * 2 + 1];
      }
      cache.set(path, { state: 'ok', data: { min, max, buckets: n, frames: p.frames, sampleRate: p.sampleRate } });
    }
  } catch (err) {
    cache.set(path, { state: 'fail', at: performance.now(), message: (err as Error)?.message ?? String(err) });
  }
  for (const fn of listeners) fn();
}

/**
 * Min/max of the peaks covering source seconds [s0, s1). Returns null when
 * the range is outside the sample.
 */
export function peakRange(p: PeakData, s0: number, s1: number): [number, number] | null {
  const dur = p.frames / p.sampleRate;
  if (s1 <= 0 || s0 >= dur || dur <= 0) return null;
  const b0 = Math.max(0, Math.floor((s0 / dur) * p.buckets));
  const b1 = Math.min(p.buckets, Math.max(b0 + 1, Math.ceil((s1 / dur) * p.buckets)));
  let lo = 1;
  let hi = -1;
  for (let i = b0; i < b1; i++) {
    if (p.min[i] < lo) lo = p.min[i];
    if (p.max[i] > hi) hi = p.max[i];
  }
  return hi < lo ? null : [lo, hi];
}
