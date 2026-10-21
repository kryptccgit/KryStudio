import type { AutomationPoint } from './project';

export function shapeCurve(t: number, tension: number): number {
  if (tension === 0) return t;
  return Math.pow(t, Math.pow(2, -3 * tension));
}

export function sortPoints(points: Record<string, AutomationPoint> | AutomationPoint[]): AutomationPoint[] {
  const arr = Array.isArray(points) ? [...points] : Object.values(points);
  return arr.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}

export function evalAutomation(sorted: AutomationPoint[], tick: number): number {
  if (sorted.length === 0) return 0;
  if (tick <= sorted[0].tick) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (tick >= last.tick) return last.value;
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
