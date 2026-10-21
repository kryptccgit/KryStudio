import type { ChordSpan, DrumHit, DrumRole, TranscribedNote } from '../analyzer/protocol';

export interface Segment {
  startSec: number;
  endSec: number;
}

const DRUM_WINDOW: Record<DrumRole, number> = { kick: 0.4, snare: 0.35, hat: 0.12, openhat: 0.5, perc: 0.25 };

const MASKED_BY: Record<DrumRole, DrumRole[]> = {
  kick: ['snare'],
  snare: ['kick'],
  hat: ['kick', 'snare', 'openhat'],
  openhat: ['kick', 'snare'],
  perc: ['kick', 'snare'],
};

const CUT_BY: Record<DrumRole, DrumRole[]> = {
  kick: ['kick', 'snare'],
  snare: ['kick', 'snare'],
  hat: ['kick', 'snare', 'hat', 'openhat'],
  openhat: ['kick', 'snare', 'openhat'],
  perc: ['kick', 'snare', 'perc'],
};

export function drumHighpassHz(role: DrumRole): number | null {
  if (role === 'hat' || role === 'openhat') return 2000;
  if (role === 'snare') return 150;
  if (role === 'perc') return 300;
  return null;
}

const TOGETHER_SEC = 0.03;
const PRE_ROLL_SEC = 0.005;

export function spread<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  if (max <= 1) return xs.length ? [xs[Math.floor(xs.length / 2)]] : [];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))]);
  return out;
}

export function drumSegments(hits: readonly DrumHit[], role: DrumRole, opts: { max?: number; durationSec?: number } = {}): Segment[] {
  const max = Math.max(1, Math.floor(opts.max ?? 40));
  const sorted = hits.filter((h) => Number.isFinite(h.timeSec) && h.timeSec >= 0).sort((a, b) => a.timeSec - b.timeSec || a.role.localeCompare(b.role));
  const mask = new Set(MASKED_BY[role]);
  const cut = new Set(CUT_BY[role]);
  const out: Array<Segment & { vel: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    if (h.role !== role) continue;
    let masked = false;
    for (let j = i - 1; j >= 0 && h.timeSec - sorted[j].timeSec <= TOGETHER_SEC; j--) if (mask.has(sorted[j].role)) masked = true;
    for (let j = i + 1; j < sorted.length && sorted[j].timeSec - h.timeSec <= TOGETHER_SEC; j++) if (mask.has(sorted[j].role)) masked = true;
    if (masked) continue;
    let end = h.timeSec + DRUM_WINDOW[role];
    for (let j = i + 1; j < sorted.length; j++) {
      const o = sorted[j];
      if (o.timeSec - h.timeSec <= TOGETHER_SEC) continue;
      if (o.timeSec >= end) break;
      if (cut.has(o.role)) {
        end = o.timeSec - PRE_ROLL_SEC;
        break;
      }
    }
    if (opts.durationSec !== undefined) end = Math.min(end, opts.durationSec);
    const start = Math.max(0, h.timeSec - PRE_ROLL_SEC);
    if (end - start < 0.05) continue;
    out.push({ startSec: round3(start), endSec: round3(end), vel: Number.isFinite(h.vel) ? h.vel : 0 });
  }
  return pickLoud(out, max);
}

export function noteSegments(notes: readonly TranscribedNote[], opts: { max?: number; minDurSec?: number; maxDurSec?: number; durationSec?: number } = {}): Segment[] {
  const max = Math.max(1, Math.floor(opts.max ?? 40));
  const minDur = opts.minDurSec ?? 0.1;
  const maxDur = opts.maxDurSec ?? 1.5;
  const out: Array<Segment & { vel: number }> = [];
  for (const n of [...notes].sort((a, b) => a.startSec - b.startSec || a.key - b.key)) {
    if (!Number.isFinite(n.startSec) || !Number.isFinite(n.durSec) || n.durSec < minDur || n.startSec < 0) continue;
    let end = n.startSec + Math.min(n.durSec, maxDur);
    if (opts.durationSec !== undefined) end = Math.min(end, opts.durationSec);
    if (end - n.startSec < minDur) continue;
    out.push({ startSec: round3(n.startSec), endSec: round3(end), vel: (Number.isFinite(n.vel) ? n.vel : 0) * Math.min(1, n.durSec) });
  }
  return pickLoud(out, max);
}

export function chordSegments(chords: readonly ChordSpan[], opts: { max?: number; minDurSec?: number; maxDurSec?: number; durationSec?: number } = {}): Segment[] {
  const max = Math.max(1, Math.floor(opts.max ?? 24));
  const minDur = opts.minDurSec ?? 0.5;
  const maxDur = opts.maxDurSec ?? 2;
  const out: Array<Segment & { vel: number }> = [];
  for (const c of [...chords].sort((a, b) => a.startSec - b.startSec)) {
    if (!Number.isFinite(c.startSec) || !Number.isFinite(c.endSec) || c.endSec - c.startSec < minDur || c.startSec < 0) continue;
    let end = c.startSec + Math.min(c.endSec - c.startSec, maxDur);
    if (opts.durationSec !== undefined) end = Math.min(end, opts.durationSec);
    if (end - c.startSec < minDur) continue;
    out.push({ startSec: round3(c.startSec), endSec: round3(end), vel: Number.isFinite(c.confidence) ? c.confidence : 0 });
  }
  return pickLoud(out, max);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function pickLoud(xs: Array<Segment & { vel: number }>, max: number): Segment[] {
  let keep = xs;
  if (xs.length > max) {
    const vels = xs.map((x) => x.vel).sort((a, b) => a - b);
    const med = vels[Math.floor(vels.length / 2)];
    const loud = xs.filter((x) => x.vel >= med);
    keep = loud.length >= Math.min(max, xs.length) ? loud : xs;
  }
  return spread(keep, max).map(({ startSec, endSec }) => ({ startSec, endSec }));
}
