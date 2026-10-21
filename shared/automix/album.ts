// ──────────────────────────────────────────────────────────────────────
// Album mastering (research/23 §2), the pure part:
//
//   placeSongs           songs back to back in one project, each starting on
//                        a bar with a 2-bar gap after the previous one
//   albumLoudnessTargets "Keep the album's dynamics": the loudest song hits
//                        the target, the others keep their distance (≤ 4 LU)
//   albumToneTargets     every song moves toward the album curve plus HALF
//                        the album's average deviation from it (the record's
//                        shared character) plus a QUARTER of its own
//                        difference from the album: songs end up sounding
//                        like one record, without flattening a ballad into
//                        the club single
//   exportFileName       "<song> (mastered).wav", Windows-safe, never reused
// ──────────────────────────────────────────────────────────────────────

import { secondsToTicks, ticksPerBar, type TimeSig } from '../schema/time';
import { BANDS, type Bands } from './roles';

export const ALBUM_MIN_SONGS = 2;
export const ALBUM_MAX_SONGS = 20;
/** Bars of silence between songs (the render tail and the next song never overlap). */
export const ALBUM_GAP_BARS = 2;
/** "Keep the album's dynamics": the furthest a song stays under the album target (LU). */
export const ALBUM_DYNAMICS_CAP_LU = 4;
/** Share of the album's average deviation from the curve every song keeps (the record's own character). */
export const ALBUM_SHARE = 0.5;
/** Share of a song's own difference from the album it keeps. */
export const OWN_SHARE = 0.25;
/** Render passes per album (every song at most once per pass). */
export const ALBUM_MAX_PASSES = 3;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r1 = (x: number): number => Math.round(x * 10) / 10;

export interface SongSlot {
  startTick: number;
  /** Where its audio ends (start + length). */
  endTick: number;
  lengthTicks: number;
  /** 1-based bars it plays in, inclusive. */
  startBar: number;
  endBar: number;
  /** "5-60", the measure / render range. */
  bars: string;
}

/** The clip length playlist.addAudio gives a file of this length (the same rounding). */
export function clipTicks(seconds: number, bpm: number): number {
  return Math.max(1, Math.round(secondsToTicks(Math.max(0, seconds), bpm)));
}

/** Songs back to back: each starts on a bar, `gapBars` empty bars after the bar the previous one ends in. */
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

/**
 * The loudness each song aims at. keepDynamics: the loudest song gets `target`, every other one keeps its distance
 * to the loudest, at most `cap` LU under (an intro or a ballad stays quieter, a mix that is merely too quiet comes
 * up). Otherwise every song gets `target`. Unmeasured songs get `target`.
 */
export function albumLoudnessTargets(lufs: readonly number[], target: number, keepDynamics: boolean, cap = ALBUM_DYNAMICS_CAP_LU): number[] {
  const valid = lufs.filter((l) => isNum(l) && l > -70);
  if (!keepDynamics || !valid.length) return lufs.map(() => r1(target));
  const loudest = Math.max(...valid);
  return lufs.map((l) => (isNum(l) && l > -70 ? r1(target + Math.max(-Math.abs(cap), l - loudest)) : r1(target)));
}

const zero = (): Bands => ({ sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 });

/** The plain average of the songs' tones (relative to the mids). */
export function albumAverageTone(tones: readonly Bands[]): Bands {
  const out = zero();
  if (!tones.length) return out;
  for (const k of BANDS) out[k] = k === 'mid' ? 0 : r1(tones.reduce((s, t) => s + (isNum(t[k]) ? t[k] : 0), 0) / tones.length);
  return out;
}

/**
 * The tone each song aims at: curve + albumShare × D + ownShare × (d_i − D), where d_i is the song's deviation from
 * the curve and D the album's average deviation. albumShare keeps the record's common character (all songs a
 * little darker than the card stay a little darker together); ownShare keeps a little of each song's own colour.
 */
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

/** Max − min of the measured loudness (LU): how far apart the songs sit. */
export function loudnessSpread(lufs: readonly number[]): number {
  const v = lufs.filter((l) => isNum(l) && l > -70);
  return v.length ? r1(Math.max(...v) - Math.min(...v)) : 0;
}

/** The album tab's name: "Album: First Song + 11". */
export function albumName(names: readonly string[]): string {
  const first = (names[0] ?? 'Songs').slice(0, 40);
  return names.length > 1 ? `Album: ${first} + ${names.length - 1}` : `Album: ${first}`;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A Windows-safe file name stem. */
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

/** "<song> (mastered).<ext>", with " 2", " 3" … when the name is already taken (case-insensitive, Windows). */
export function exportFileName(name: string, ext: string, taken: ReadonlySet<string>): string {
  const stem = `${safeFileStem(name)} (mastered)`;
  const has = (n: string) => [...taken].some((t) => t.toLowerCase() === n.toLowerCase());
  let file = `${stem}.${ext}`;
  for (let n = 2; has(file); n++) file = `${stem} ${n}.${ext}`;
  return file;
}
