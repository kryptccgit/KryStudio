// Unit-aware parsing for "Type in value…" (the inverse of formatParam).
// Accepts what the display shows: "-6 dB", "1.2k", "440 Hz", "25%", "Saw",
// "250 ms", "1.5 s", "+3 st", "L30" / "R50" / "C" for pans.

import type { ParamSpec } from '@shared/plugins/types';
import { clampToSpec } from '@shared/plugins/types';

export function parseParamInput(spec: ParamSpec, raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (spec.options) {
    const idx = spec.options.findIndex((o) => o.toLowerCase() === text);
    if (idx >= 0) return idx;
    const starts = spec.options.findIndex((o) => o.toLowerCase().startsWith(text));
    if (starts >= 0) return starts;
    const n = Number(text);
    return Number.isFinite(n) ? clampToSpec(spec, n) : null;
  }

  // Pan-style input: L30 / R50 / C
  if (spec.min === -1 && spec.max === 1 && /^[lrc]/.test(text)) {
    if (text === 'c' || text === 'center' || text === 'centre') return 0;
    const m = /^([lr])\s*(\d+(?:\.\d+)?)/.exec(text);
    if (m) {
      const v = Math.min(100, Number(m[2])) / 100;
      return m[1] === 'l' ? -v : v;
    }
  }

  if (spec.scale === 'gain') {
    if (text.includes('inf')) return 0;
    const m = /^([+-]?\d*\.?\d+)/.exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    if (/x$/.test(text) || /lin/.test(text)) return clampToSpec(spec, n);
    // Display is in dB, so typed numbers are dB.
    return clampToSpec(spec, Math.pow(10, n / 20));
  }

  const m = /^([+-]?\d*\.?\d+)\s*([a-z%]*)/.exec(text);
  if (!m) return null;
  let n = Number(m[1]);
  const suffix = m[2];
  if (!Number.isFinite(n)) return null;

  switch (spec.unit) {
    case 'Hz':
      if (suffix.startsWith('k')) n *= 1000;
      break;
    case 'ms':
      if (suffix === 's' || suffix === 'sec') n *= 1000;
      break;
    case 's':
      if (suffix === 'ms') n /= 1000;
      break;
    case '%':
      // Display shows 0..100 %, storage is 0..1 (or the spec's own range).
      if (spec.max <= 1 && spec.min >= -1) n /= 100;
      break;
    default:
      if (suffix.startsWith('k')) n *= 1000;
  }
  return clampToSpec(spec, n);
}
