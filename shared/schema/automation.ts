// Automation curve evaluation. The Rust engine implements the IDENTICAL
// formula (engine/crates/engine/src/automation.rs) — golden-tested so what
// the playlist draws is exactly what plays.
//
// Between point A (tick a, value va, tension τ) and point B (tick b, vb):
//   t = (tick - a) / (b - a)              0..1
//   shape(t, τ) = τ == 0 ? t : t ^ (2 ^ (-3τ))
//   value = va + (vb - va) * shape(t, τ)
// Before the first point: first value. After the last point: last value.

import type { AutomationPoint } from './project';

export function shapeCurve(t: number, tension: number): number {
  if (tension === 0) return t;
  return Math.pow(t, Math.pow(2, -3 * tension));
}

export function sortPoints(points: Record<string, AutomationPoint> | AutomationPoint[]): AutomationPoint[] {
  const arr = Array.isArray(points) ? [...points] : Object.values(points);
  return arr.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}

/** Normalized 0..1 value at a tick (points must be sorted). */
export function evalAutomation(sorted: AutomationPoint[], tick: number): number {
  if (sorted.length === 0) return 0;
  if (tick <= sorted[0].tick) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (tick >= last.tick) return last.value;
  // binary search for the segment
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].tick <= tick) lo = mid;
    else hi = mid;
  }
  const a = sorted[lo];
  const b = sorted[hi];
  const span = b.tick - a.tick;
  if (span <= 0) return b.value;
  const t = (tick - a.tick) / span;
  return a.value + (b.value - a.value) * shapeCurve(t, a.tension);
}
