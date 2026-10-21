import { inScale, noteName, parseKey, NOTE_NAMES_FLAT, NOTE_NAMES_SHARP, type Key } from '../music/theory';
import { PPQ, ticksPerBar, type TimeSig } from '../schema/time';
import { prefersFlats } from './print';

export interface SymbolicNote {
  tick: number;
  dur: number;
  key: number;
  vel: number;
}

export interface SymbolicChannel {
  name: string;
  notes: SymbolicNote[];
  drum?: boolean;
}

export interface ChannelStats {
  name: string;
  notes: number;
  density: number;
  range: string | null;
  avgVel: number;
  outOfKey: number;
}

export interface SymbolicStats {
  bars: number;
  beats: number;
  notes: number;
  density: number;
  channels: ChannelStats[];
  key: { given: string | null; estimated: string | null; confidence: number };
  outOfKeyRatio: number | null;
  outOfKeyNotes: string[];
  chords: string[];
  lowClashes: string[];
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function estimateKey(weights: number[]): { key: string; confidence: number } | null {
  if (weights.every((w) => w === 0)) return null;
  let best = { key: 'C', confidence: -2 };
  for (let r = 0; r < 12; r++) {
    const rot = weights.map((_, i) => weights[(i + r) % 12]);
    const maj = correlate(rot, MAJOR);
    const min = correlate(rot, MINOR);
    if (maj > best.confidence) best = { key: NOTE_NAMES_SHARP[r], confidence: maj };
    if (min > best.confidence) best = { key: `${NOTE_NAMES_SHARP[r]}m`, confidence: min };
  }
  const flatMap: Record<string, string> = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'C#': 'Db', 'F#': 'F#' };
  const m = /^([A-G]#?)(m?)$/.exec(best.key);
  if (m && m[2] === '' && flatMap[m[1]] && m[1] !== 'F#') best.key = flatMap[m[1]];
  if (m && m[2] === 'm' && (m[1] === 'A#' || m[1] === 'D#')) best.key = `${flatMap[m[1]]}m`;
  return { key: best.key, confidence: Math.round(best.confidence * 100) / 100 };
}

const CHORD_TEMPLATES: Array<{ q: string; iv: number[]; penalty: number }> = [
  { q: '', iv: [0, 4, 7], penalty: 0 },
  { q: 'm', iv: [0, 3, 7], penalty: 0 },
  { q: 'dom7', iv: [0, 4, 7, 10], penalty: 0.08 },
  { q: 'maj7', iv: [0, 4, 7, 11], penalty: 0.08 },
  { q: 'm7', iv: [0, 3, 7, 10], penalty: 0.08 },
  { q: 'dim', iv: [0, 3, 6], penalty: 0.05 },
  { q: 'sus4', iv: [0, 5, 7], penalty: 0.06 },
  { q: 'sus2', iv: [0, 2, 7], penalty: 0.06 },
  { q: '5', iv: [0, 7], penalty: 0.1 },
];

function chordFor(weights: number[], bassPc: number | null, flats: boolean): string {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return '-';
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  let best = { name: '-', score: -Infinity };
  for (let r = 0; r < 12; r++) {
    for (const t of CHORD_TEMPLATES) {
      const tones = new Set(t.iv.map((i) => (r + i) % 12));
      let inW = 0;
      let outW = 0;
      for (let pc = 0; pc < 12; pc++) (tones.has(pc) ? (inW += weights[pc]) : (outW += weights[pc]));
      const covered = t.iv.filter((i) => weights[(r + i) % 12] > 0).length / t.iv.length;
      let score = (inW - 0.6 * outW) / total + 0.3 * covered - t.penalty;
      if (bassPc === r) score += 0.12;
      if (score > best.score) best = { name: `${names[r]}${t.q}`, score };
    }
  }
  return best.name;
}

export function symbolicStats(channels: SymbolicChannel[], opts: { lengthTicks: number; ts: TimeSig; key?: string | null }): SymbolicStats {
  const barTicks = ticksPerBar(opts.ts);
  const lengthTicks = Math.max(barTicks, opts.lengthTicks);
  const bars = Math.max(1, Math.ceil(lengthTicks / barTicks));
  const beats = lengthTicks / PPQ;
  const given: Key | null = opts.key ? parseKey(opts.key) : null;
  const flats = prefersFlats(opts.key ?? undefined);

  const pcWeights = new Array(12).fill(0);
  const barWeights: number[][] = Array.from({ length: bars }, () => new Array(12).fill(0));
  const barBass: Array<number | null> = new Array(bars).fill(null);
  const barLow: Array<Array<{ key: number; ch: string }>> = Array.from({ length: bars }, () => []);
  let total = 0;
  for (const ch of channels) {
    if (ch.drum) continue;
    for (const n of ch.notes) {
      pcWeights[n.key % 12] += n.dur;
      const b0 = Math.floor(n.tick / barTicks);
      const b1 = Math.min(bars - 1, Math.floor((n.tick + n.dur - 1) / barTicks));
      for (let b = Math.max(0, b0); b <= b1; b++) {
        const lo = Math.max(n.tick, b * barTicks);
        const hi = Math.min(n.tick + n.dur, (b + 1) * barTicks);
        if (hi > lo) barWeights[b][n.key % 12] += hi - lo;
        if (barBass[b] === null || n.key < (barBass[b] as number)) barBass[b] = n.key;
        if (n.key < 48) barLow[b].push({ key: n.key, ch: ch.name });
      }
    }
  }
  const est = estimateKey(pcWeights);
  const refKey = given ?? (est ? parseKey(est.key) : null);

  const outOfKeyNotes: string[] = [];
  let pitched = 0;
  let outCount = 0;
  const stats: ChannelStats[] = channels.map((ch) => {
    let out = 0;
    let lo = 127;
    let hi = 0;
    let velSum = 0;
    for (const n of ch.notes) {
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
      velSum += Math.round(n.vel * 127);
      if (!ch.drum && refKey && !inScale(n.key, refKey)) {
        out++;
        if (outOfKeyNotes.length < 10) {
          const bar = Math.floor(n.tick / barTicks) + 1;
          const step = Math.round((n.tick % barTicks) / (PPQ / 4)) + 1;
          outOfKeyNotes.push(`${ch.name} ${noteName(n.key, 'scientific', flats)} @${bar}.${step}`);
        }
      }
    }
    total += ch.notes.length;
    if (!ch.drum) {
      pitched += ch.notes.length;
      outCount += out;
    }
    return {
      name: ch.name,
      notes: ch.notes.length,
      density: Math.round((ch.notes.length / beats) * 100) / 100,
      range: ch.drum || ch.notes.length === 0 ? null : lo === hi ? noteName(lo, 'scientific', flats) : `${noteName(lo, 'scientific', flats)}–${noteName(hi, 'scientific', flats)}`,
      avgVel: ch.notes.length ? Math.round(velSum / ch.notes.length) : 0,
      outOfKey: out,
    };
  });

  const lowClashes: string[] = [];
  barLow.forEach((list, b) => {
    for (let i = 0; i < list.length && lowClashes.length < 6; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].ch === list[j].ch) continue;
        const d = Math.abs(list[i].key - list[j].key);
        if (d === 1 || d === 2) {
          lowClashes.push(`bar ${b + 1}: ${list[i].ch} ${noteName(list[i].key)} vs ${list[j].ch} ${noteName(list[j].key)} (${d === 1 ? 'minor' : 'major'} 2nd below C3)`);
          break;
        }
      }
    }
  });

  return {
    bars,
    beats: Math.round(beats * 100) / 100,
    notes: total,
    density: Math.round((total / beats) * 100) / 100,
    channels: stats,
    key: { given: opts.key ?? null, estimated: est?.key ?? null, confidence: est?.confidence ?? 0 },
    outOfKeyRatio: pitched && refKey ? Math.round((outCount / pitched) * 1000) / 1000 : null,
    outOfKeyNotes,
    chords: barWeights.map((w, b) => chordFor(w, barBass[b] === null ? null : (barBass[b] as number) % 12, flats)),
    lowClashes,
  };
}
