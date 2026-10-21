export interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted(weights: readonly number[]): number;
  jitter(amount: number): number;
  fork(salt: number): Rng;
}

function mix(seed: number, salt: number): number {
  let h = (seed >>> 0) ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeRng(seed: number, salt = 0): Rng {
  const base = mix(seed, salt);
  let s = base || 0x9e3779b9;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => p > 0 && next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted(weights) {
      const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
      if (!(total > 0)) return Math.floor(next() * weights.length);
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    jitter: (amount) => (next() * 2 - 1) * amount,
    fork: (salt) => makeRng(base, salt),
  };
  return rng;
}

export function variationSeed(seed: number, n: number): number {
  return n === 0 ? seed >>> 0 : mix(seed, 0x5eed + n) & 0x7fffffff;
}
