// ──────────────────────────────────────────────────────────────────────
// Reference matching (research/23 §1), the pure part: a reference song's
// engine analysis → its sound (loudness, tone relative to the mids, width,
// a one-line summary), the target a run aims at (the reference's tone and
// width, its loudness clamped to a safe range, the prompt on top) and the
// closeness metric (mean absolute band difference). The reference is only
// measured: nothing here ever touches its audio.
// ──────────────────────────────────────────────────────────────────────

import type { Analysis } from '../engine/protocol';
import type { AutoMixIntent, AutoMixMeasure, AutoMixPreset, ReferenceSound } from './types';
import { presetById } from './presets';
import { toneOf, toneTarget } from './plan';
import type { Bands } from './roles';

export type Tone = AutoMixMeasure['tone'];

/** The loudness a reference may set (LUFS). Louder references are matched at -6, quieter ones at -20 (and say so). */
export const REF_LUFS_RANGE = { min: -20, max: -6 } as const;
/** The true-peak ceiling with a reference, unless the user sets one (streaming-safe). */
export const REF_TRUE_PEAK = -1;
/** The widths a reference may ask for (0..1 side energy / total). */
export const REF_WIDTH_RANGE = { min: 0.02, max: 0.45 } as const;
/** The bands the closeness metric compares (the mids are 0 in both by definition). */
export const MATCH_BANDS = ['sub', 'low', 'lowMid', 'highMid', 'high'] as const;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** "−9.2" with a real minus sign. */
export function fmtDb(v: number): string {
  const r = r1(v);
  return r < 0 ? `−${Math.abs(r).toFixed(1)}` : r.toFixed(1);
}

/** A song name from a path ("C:/Music/My Song.mp3" → "My Song"). */
export function songNameFromPath(p: string): string {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  return (
    base
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 64) || 'Song'
  );
}

// ── Describing a sound ───────────────────────────────────────────────

/** "bright" / "dark" (and "heavy low end" / "light low end"), against the Balanced card's curve; [] = balanced. */
export function toneWords(tone: Tone): string[] {
  const n = presetById('balanced')?.tone ?? { sub: 4, low: 6.5, lowMid: -1, mid: 0, highMid: -5, high: -8 };
  const top = ((tone.highMid - n.highMid) + (tone.high - n.high)) / 2;
  const lows = ((tone.sub - n.sub) + (tone.low - n.low)) / 2;
  const out: string[] = [];
  if (top >= 2.5) out.push('bright');
  else if (top <= -2.5) out.push('dark');
  if (lows >= 3) out.push('heavy low end');
  else if (lows <= -4) out.push('light low end');
  return out;
}

export function widthWord(width: number): string {
  if (!isNum(width)) return 'width unknown';
  if (width < 0.04) return 'mono';
  if (width < 0.1) return 'narrow';
  if (width > 0.25) return 'wide';
  return 'normal width';
}

/** "−9.2 LUFS · bright · wide". */
export function referenceSummary(s: Pick<ReferenceSound, 'lufs' | 'tone' | 'width'>): string {
  const words = toneWords(s.tone);
  return [`${fmtDb(s.lufs)} LUFS`, words.length ? words.join(', ') : 'balanced tone', widthWord(s.width)].join(' · ');
}

/** The reference's sound from the engine's analysis of the file, or a human reason it can't be used. */
export function referenceSoundOf(a: Analysis | null | undefined, meta: { path: string; name?: string; cached?: boolean }): ReferenceSound | string {
  if (!a || typeof a !== 'object') return 'the analysis came back empty';
  if (!isNum(a.lufsIntegrated) || a.lufsIntegrated < -60) return 'it is silent (or too quiet to measure)';
  if (!a.bands || !isNum(a.bands.mid)) return 'the analysis has no spectrum (update or rebuild Krypt Studio\'s engine)';
  const tone = toneOf(a.bands);
  const width = isNum(a.stereoWidth) ? clamp(a.stereoWidth, 0, 1) : 0.15;
  const s: ReferenceSound = {
    path: meta.path,
    name: meta.name ?? songNameFromPath(meta.path),
    lufs: r1(a.lufsIntegrated),
    truePeak: isNum(a.truePeakDb) ? r1(a.truePeakDb) : 0,
    tone,
    width: r2(width),
    correlation: isNum(a.stereoCorrelation) ? r2(a.stereoCorrelation) : 1,
    crestDb: isNum(a.crestDb) ? r1(a.crestDb) : null,
    durationSec: isNum(a.durationSec) ? r1(a.durationSec) : 0,
    summary: '',
    cached: !!meta.cached,
  };
  s.summary = referenceSummary(s);
  return s;
}

// ── Closeness ─────────────────────────────────────────────────────────

/** Mean absolute band difference (dB) over the five bands around the mids; lower = closer. */
export function toneDistance(a: Tone, b: Tone): number {
  let sum = 0;
  for (const k of MATCH_BANDS) sum += Math.abs((isNum(a[k]) ? a[k] : 0) - (isNum(b[k]) ? b[k] : 0));
  return r1(sum / MATCH_BANDS.length);
}

/** Before → after distance to the reference, and how much closer it got (+ = closer). */
export function closeness(before: Tone, after: Tone, ref: Tone): { before: number; after: number; gained: number } {
  const b = toneDistance(before, ref);
  const a = toneDistance(after, ref);
  return { before: b, after: a, gained: r1(b - a) };
}

/** A song mastered loud already (its own limiter at work): ≥ −12 LUFS with peaks within 1.5 dB of full scale. */
export function isLimitedSource(m: { lufs?: number | null; truePeak?: number | null } | null | undefined): boolean {
  return !!m && isNum(m.lufs) && isNum(m.truePeak) && m.lufs >= -12 && m.truePeak >= -1.5;
}

/** "Closer to the reference by 2.3 dB (4.1 → 1.8 dB average band difference)" / an honest "further" line. */
export function closenessLine(distanceBefore: number, distanceAfter: number, name = 'the reference', opts: { limitedSource?: boolean } = {}): string {
  const g = r1(distanceBefore - distanceAfter);
  const span = `${distanceBefore.toFixed(1)} → ${distanceAfter.toFixed(1)} dB average band difference`;
  // An already-limited song barely moves: the limiter pushes the EQ's moves back. Say so, and what works instead.
  const why = opts.limitedSource && g < 1 && distanceAfter > 3
    ? ': your song was already mastered loud, so its limiter pushes the tone changes back. For a closer match, master the mix without its master limiter (export it from your DAW with the limiter off)'
    : '';
  if (why) return `${g >= 0.1 ? `Only ${g.toFixed(1)} dB closer to ${name}` : g <= -0.1 ? `${Math.abs(g).toFixed(1)} dB further from ${name}` : `About as close to ${name} as before`} (${span})${why}`;
  if (g >= 0.1) return `Closer to ${name} by ${g.toFixed(1)} dB (${span})`;
  if (g <= -0.1) return `${Math.abs(g).toFixed(1)} dB further from ${name} (${span}): the tone EQ moves each band at most 4 dB, and the loudness change shifts the balance too`;
  return `About as close to ${name} as before (${span})`;
}

// ── The target ────────────────────────────────────────────────────────

export interface ReferenceTarget {
  /** The tone curve (relative to the mids): the reference's, with the prompt's tone words on top. */
  tone: Bands;
  lufs: number;
  truePeak: number;
  width: number;
  /** Where the loudness comes from. */
  lufsFrom: 'you' | 'prompt' | 'reference';
  notes: string[];
}

/**
 * What a run aims at with a reference: its tone (the prompt's "brighter" / "more bass" … still apply on top), its
 * integrated loudness clamped to REF_LUFS_RANGE (unless you or the prompt set a target), its width (clamped), and
 * a −1 dBTP ceiling unless you set one. The preset only brings its character (punch, warmth, glue); the crest
 * guard can still stop the loudness below the reference's (the run says so).
 */
export function referenceTarget(
  ref: Pick<ReferenceSound, 'lufs' | 'tone' | 'width' | 'name'>,
  preset: AutoMixPreset,
  intent: AutoMixIntent | null,
  opts: { targetLufs?: number | null; truePeak?: number | null } = {},
): ReferenceTarget {
  const notes: string[] = [];
  const tone = toneTarget({ ...preset, tone: { ...ref.tone, mid: 0 } }, intent);
  let lufs: number;
  let lufsFrom: ReferenceTarget['lufsFrom'];
  if (isNum(opts.targetLufs)) {
    lufs = opts.targetLufs;
    lufsFrom = 'you';
  } else if (isNum(intent?.targetLufs)) {
    lufs = intent!.targetLufs!;
    lufsFrom = 'prompt';
  } else {
    const want = ref.lufs + (isNum(intent?.louder) ? intent!.louder! : 0);
    lufs = clamp(want, REF_LUFS_RANGE.min, REF_LUFS_RANGE.max);
    lufsFrom = 'reference';
    if (want > REF_LUFS_RANGE.max) notes.push(`The reference is ${fmtDb(ref.lufs)} LUFS: matched at ${fmtDb(lufs)} LUFS, the loudest a reference sets (set the target yourself to go further).`);
    else if (want < REF_LUFS_RANGE.min) notes.push(`The reference is ${fmtDb(ref.lufs)} LUFS: matched at ${fmtDb(lufs)} LUFS, the quietest a reference sets.`);
  }
  const truePeak = isNum(opts.truePeak) ? opts.truePeak : REF_TRUE_PEAK;
  const width = r2(clamp(isNum(ref.width) ? ref.width : 0.15, REF_WIDTH_RANGE.min, REF_WIDTH_RANGE.max));
  if (isNum(ref.width) && Math.abs(width - ref.width) > 0.005) notes.push(`The reference's width (${Math.round(ref.width * 100)}%) is extreme: aiming at ${Math.round(width * 100)}%, mono-safe.`);
  return { tone, lufs: r1(lufs), truePeak: r1(truePeak), width, lufsFrom, notes };
}

/** The crest guard's honest line when it stopped short of the reference ("the reference is −6 LUFS; …"). */
export function cappedAgainstReference(refLufs: number, endedLufs: number, targetLufs: number): string | null {
  if (!isNum(refLufs) || !isNum(endedLufs) || endedLufs >= targetLufs - 0.5) return null;
  return `The reference is ${fmtDb(refLufs)} LUFS; your song starts to distort past ${fmtDb(endedLufs)} LUFS, so it stopped there.`;
}
