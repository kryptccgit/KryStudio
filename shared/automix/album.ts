import { secondsToTicks, ticksPerBar, type TimeSig } from '../schema/time';
import { BANDS, type Bands } from './roles';

export const ALBUM_MIN_SONGS = 2;
export const ALBUM_MAX_SONGS = 20;
export const ALBUM_GAP_BARS = 2;
export const ALBUM_DYNAMICS_CAP_LU = 4;
export const ALBUM_SHARE = 0.5;
export const OWN_SHARE = 0.25;
export const ALBUM_MAX_PASSES = 3;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r1 = (x: number): number => Math.round(x * 10) / 10;

export interface SongSlot {
  startTick: number;
  endTick: number;
  lengthTicks: number;
  startBar: number;
  endBar: number;
  bars: string;
}

export function clipTicks(seconds: number, bpm: number): number {
  return Math.max(1, Math.round(secondsToTicks(Math.max(0, seconds), bpm)));
}

export function placeSongs(durationsSec: readonly number[], bpm: number, ts: TimeSig, gapBars = ALBUM_GAP_BARS): SongSlot[] {
  const bar = ticksPerBar(ts);
  const out: SongSlot[] = [];
  let cursor = 0;
  for (const sec of durationsSec) {
    const len = clipTicks(isNum(sec) ? sec : 0, bpm);
    const start = cursor;
    const end = start + len;
    const startBar = Math.floor(start / bar) + 1;
    const endBar = Math.max(startBar, Math.ceil(end / bar));
    out.push({ startTick: start, endTick: end, lengthTicks: len, startBar, endBar, bars: `${startBar}-${endBar}` });
    cursor = (endBar + Math.max(0, Math.round(gapBars))) * bar;
  }
  return out;
}

export function albumLoudnessTargets(lufs: readonly number[], target: number, keepDynamics: boolean, cap = ALBUM_DYNAMICS_CAP_LU): number[] {
  const valid = lufs.filter((l) => isNum(l) && l > -70);
  if (!keepDynamics || !valid.length) return lufs.map(() => r1(target));
  const loudest = Math.max(...valid);
  return lufs.map((l) => (isNum(l) && l > -70 ? r1(target + Math.max(-Math.abs(cap), l - loudest)) : r1(target)));
}

const zero = (): Bands => ({ sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 });

export function albumAverageTone(tones: readonly Bands[]): Bands {
  const out = zero();
  if (!tones.length) return out;
  for (const k of BANDS) out[k] = k === 'mid' ? 0 : r1(tones.reduce((s, t) => s + (isNum(t[k]) ? t[k] : 0), 0) / tones.length);
  return out;
}

export function albumToneTargets(curve: Bands, tones: readonly Bands[], opts: { albumShare?: number; ownShare?: number } = {}): { targets: Bands[]; deviation: Bands } {
  const a = opts.albumShare ?? ALBUM_SHARE;
  const o = opts.ownShare ?? OWN_SHARE;
  const dev = zero();
  if (tones.length) for (const k of BANDS) dev[k] = k === 'mid' ? 0 : tones.reduce((s, t) => s + ((isNum(t[k]) ? t[k] : curve[k]) - curve[k]), 0) / tones.length;
  const targets = tones.map((t) => {
    const out = zero();
    for (const k of BANDS) {
      if (k === 'mid') continue;
      const d = (isNum(t[k]) ? t[k] : curve[k]) - curve[k];
      out[k] = r1(curve[k] + a * dev[k] + o * (d - dev[k]));
    }
    return out;
  });
  for (const k of BANDS) dev[k] = r1(dev[k]);
  return { targets, deviation: dev };
}

export function loudnessSpread(lufs: readonly number[]): number {
  const v = lufs.filter((l) => isNum(l) && l > -70);
  return v.length ? r1(Math.max(...v) - Math.min(...v)) : 0;
}

export function albumName(names: readonly string[]): string {
  const first = (names[0] ?? 'Songs').slice(0, 40);
  return names.length > 1 ? `Album: ${first} + ${names.length - 1}` : `Album: ${first}`;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeFileStem(name: string): string {
  let s = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100);
  if (!s) s = 'Song';
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

export function exportFileName(name: string, ext: string, taken: ReadonlySet<string>): string {
  const stem = `${safeFileStem(name)} (mastered)`;
  const has = (n: string) => [...taken].some((t) => t.toLowerCase() === n.toLowerCase());
  let file = `${stem}.${ext}`;
  for (let n = 2; has(file); n++) file = `${stem} ${n}.${ext}`;
  return file;
}
