// Small deterministic statistics helpers for the reference library
// (percentiles, weighted percentiles, seeded RNG, string hashing). Pure.

import type { Percentiles } from './types';

export function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function round(x: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Quantile q (0..1) of an ascending-sorted array, linear interpolation (type 7). */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const pos = clamp(q, 0, 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number {
  const v = values.filter(isNum).sort((a, b) => a - b);
  return quantileSorted(v, 0.5);
}

export function mean(values: readonly number[]): number {
  let s = 0;
  let n = 0;
  for (const x of values) {
    if (isNum(x)) {
      s += x;
      n++;
    }
  }
  return n ? s / n : NaN;
}

/** p10/p25/median/p75/p90 of the finite values (NaN-filled when empty). */
export function percentiles(values: readonly number[], decimals = 2): Percentiles {
  const v = values.filter(isNum).sort((a, b) => a - b);
  const q = (p: number) => round(quantileSorted(v, p), decimals);
  return { p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9) };
}

/**
 * Weighted percentiles: each item counts with its weight (e.g. 1/notes of
 * its track, so every track weighs the same). Midpoint convention, linear
 * between neighbouring values.
 */
export function weightedPercentiles(items: ReadonlyArray<{ v: number; w: number }>, decimals = 2): Percentiles {
  const xs = items.filter((x) => isNum(x.v) && isNum(x.w) && x.w > 0).sort((a, b) => a.v - b.v);
  const total = xs.reduce((s, x) => s + x.w, 0);
  const at = (q: number): number => {
    if (!xs.length) return NaN;
    if (xs.length === 1) return xs[0].v;
    const target = q * total;
    let cum = 0;
    let prevMid = -Infinity;
    let prevV = xs[0].v;
    for (const x of xs) {
      const mid = cum + x.w / 2;
      if (mid >= target) {
        if (prevMid === -Infinity) return x.v;
        const f = (target - prevMid) / (mid - prevMid);
        return prevV + (x.v - prevV) * f;
      }
      prevMid = mid;
      prevV = x.v;
      cum += x.w;
    }
    return xs[xs.length - 1].v;
  };
  const q = (p: number) => round(at(p), decimals);
  return { p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9) };
}

/** Sample a value from a percentile summary (u uniform 0..1), linear between the knots. */
export function sampleFromPercentiles(p: Percentiles, u: number): number {
  // Extrapolate the tails a little beyond p10/p90 (to p0/p100 ≈ p10 - (p25-p10)…).
  const knots: Array<[number, number]> = [
    [0, p.p10 - (p.p25 - p.p10) * 0.5],
    [0.1, p.p10],
    [0.25, p.p25],
    [0.5, p.median],
    [0.75, p.p75],
    [0.9, p.p90],
    [1, p.p90 + (p.p90 - p.p75) * 0.5],
  ];
  const x = clamp(u, 0, 1);
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i][0]) {
      const [q0, v0] = knots[i - 1];
      const [q1, v1] = knots[i];
      return v0 + ((v1 - v0) * (x - q0)) / (q1 - q0 || 1);
    }
  }
  return knots[knots.length - 1][1];
}

/** Deterministic PRNG (mulberry32): returns uniform floats in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit over a string's UTF-16 code units. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Linear resample of a curve to n points by segment means. */
export function segmentMeans(values: readonly number[], n: number): number[] {
  const out: number[] = [];
  const len = values.length;
  if (!len) return out;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * len) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
    let s = 0;
    let c = 0;
    for (let j = a; j < b && j < len; j++) {
      if (isNum(values[j])) {
        s += values[j];
        c++;
      }
    }
    out.push(c ? s / c : NaN);
  }
  return out;
}
