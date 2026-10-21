// ──────────────────────────────────────────────────────────────────────
// "Sing my notes" planning (research/21), pure:
//   melodyFromNotes   a pattern lane's notes → one monophonic line
//                     (highest note wins, overlaps trimmed)
//   mapSyllables      syllables ↔ notes: one syllable per note, "_" holds,
//                     extra notes extend the last syllable (melisma), extra
//                     syllables squeeze onto the last note
//   wordSpans / fitSpans / equalSpans
//                     where each syllable sits in the spoken audio
//   buildSegments     → SingArgs.segments at the project tempo (+ octave)
// The analyzer does the audio; Electron main (electron/voice) glues it.
// ──────────────────────────────────────────────────────────────────────

import type { SingArgs } from '../analyzer/protocol';
import { ticksToSeconds } from '../schema/time';
import type { LyricSyllable } from './syllables';

export interface MelodyNote {
  /** Start within the pattern (ticks). */
  tick: number;
  dur: number;
  key: number;
}

/** Notes shorter than this after trimming are dropped (a 1/64 at PPQ 960). */
export const MIN_NOTE_TICKS = 60;

/**
 * One singable line from a lane's notes: muted notes are skipped; a chord keeps its highest note; a note that
 * starts under a held note cuts the held one when it is higher, and is cut (or dropped) when it is lower.
 * `range` = [start, end) ticks of the pattern: notes starting inside it, clipped at its end.
 */
export function melodyFromNotes(notes: Array<{ tick: number; dur: number; key: number; mute?: boolean }>, range?: { start: number; end: number }): MelodyNote[] {
  const lo = range?.start ?? -Infinity;
  const hi = range?.end ?? Infinity;
  const src = notes
    .filter((n) => !n.mute && Number.isFinite(n.tick) && n.dur > 0 && n.tick >= lo && n.tick < hi)
    .map((n) => ({ tick: Math.round(n.tick), dur: Math.round(Math.min(n.dur, hi - n.tick)), key: Math.round(n.key) }))
    .sort((a, b) => a.tick - b.tick || b.key - a.key);
  // Chords: the highest note at each start.
  const starts: MelodyNote[] = [];
  for (const n of src) if (!starts.length || starts[starts.length - 1].tick !== n.tick) starts.push(n);
  const out: MelodyNote[] = [];
  for (const n0 of starts) {
    let n = { ...n0 };
    const prev = out[out.length - 1];
    if (prev && prev.tick + prev.dur > n.tick) {
      if (n.key >= prev.key) prev.dur = n.tick - prev.tick;
      else {
        // A lower note under a held higher one: it sounds only after the higher one ends.
        const end = n.tick + n.dur;
        const from = prev.tick + prev.dur;
        if (end - from < MIN_NOTE_TICKS) continue;
        n = { tick: from, dur: end - from, key: n.key };
      }
      if (prev.dur < MIN_NOTE_TICKS) out.pop();
    }
    if (n.dur >= 1) out.push(n);
  }
  return out;
}

/** A group of syllables sung over a group of consecutive notes. */
export interface SingGroup {
  /** Indices into the syllable list (more than one = squeezed onto one note). */
  syllables: number[];
  /** Indices into the melody (more than one = the syllable is held across them). */
  notes: number[];
}

export interface SyllableMapping {
  groups: SingGroup[];
  /** Human notes: notes left over, syllables squeezed, holds cut short. */
  notes: string[];
  /** Melody notes that got no syllable of their own (held by the one before). */
  extraNotes: number;
  /** Syllables that had no note of their own (squeezed onto the last note). */
  extraSyllables: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Spread syllables over notes in order (see the file header). */
export function mapSyllables(syllables: Array<Pick<LyricSyllable, 'text' | 'hold'>>, noteCount: number): SyllableMapping {
  const groups: SingGroup[] = [];
  const notes: string[] = [];
  let note = 0;
  let si = 0;
  let cutHold = false;
  for (; si < syllables.length && note < noteCount; si++) {
    const want = 1 + Math.max(0, Math.floor(syllables[si].hold || 0));
    const take = Math.min(want, noteCount - note);
    if (take < want) cutHold = true;
    // A hold takes the notes it asks for (explicit markup wins over the syllables after it).
    groups.push({ syllables: [si], notes: Array.from({ length: take }, (_, k) => note + k) });
    note += take;
  }
  let extraSyllables = 0;
  if (si < syllables.length && groups.length) {
    const last = groups[groups.length - 1];
    const rest = syllables.length - si;
    for (; si < syllables.length; si++) last.syllables.push(si);
    extraSyllables = rest;
    const words = last.syllables.map((i) => syllables[i].text).join(' ');
    notes.push(`${plural(rest, 'more syllable')} than notes: the last note sings "${words}" together. Add notes, or join syllables with "-" / hold fewer with "_".`);
  }
  let extraNotes = 0;
  if (note < noteCount && groups.length) {
    extraNotes = noteCount - note;
    const last = groups[groups.length - 1];
    for (; note < noteCount; note++) last.notes.push(note);
    notes.push(`${plural(extraNotes, 'more note')} than syllables: "${syllables[last.syllables[last.syllables.length - 1]].text}" is held over the last ${plural(extraNotes + 1, 'note')}.`);
  }
  if (cutHold) notes.push('A "_" hold ran past the last note and was cut short.');
  return { groups, notes, extraNotes, extraSyllables };
}

export interface Span {
  startSec: number;
  endSec: number;
}

/** `count` equal spans over [start, end). */
export function equalSpans(count: number, startSec: number, endSec: number): Span[] {
  const n = Math.max(0, Math.floor(count));
  const len = Math.max(0, endSec - startSec);
  return Array.from({ length: n }, (_, i) => ({ startSec: startSec + (len * i) / n, endSec: startSec + (len * (i + 1)) / n }));
}

const vowelWeight = (s: string): number => Math.max(1, s.replace(/[^\p{L}\p{N}]/gu, '').length);

/**
 * Syllable spans from the TTS word timings of one line: each word's span is split over its syllables by letter
 * count. null when the words don't line up with the lyric (TTS reads numbers / symbols its own way).
 */
export function wordSpans(lineSyllables: Array<Pick<LyricSyllable, 'text' | 'wordInLine'>>, lineWords: string[], timings: Array<{ text: string; startSec: number; endSec: number }>): Span[] | null {
  const words = timings.filter((w) => /[\p{L}\p{N}]/u.test(w.text ?? '') && Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec);
  if (!lineWords.length || words.length !== lineWords.length) return null;
  const out: Span[] = [];
  for (let wi = 0; wi < lineWords.length; wi++) {
    const syls = lineSyllables.filter((s) => s.wordInLine === wi);
    if (!syls.length) continue;
    const t = words[wi];
    const weights = syls.map((s) => vowelWeight(s.text));
    const total = weights.reduce((a, b) => a + b, 0);
    let at = t.startSec;
    for (const w of weights) {
      const len = ((t.endSec - t.startSec) * w) / total;
      out.push({ startSec: at, endSec: at + len });
      at += len;
    }
  }
  return out.length === lineSyllables.length ? out : null;
}

/**
 * Detected syllable nuclei → exactly `expected` spans: too many → the shortest neighbours merge; too few → the
 * longest spans split in half. Spans are sorted and never overlap. Empty input → [].
 */
export function fitSpans(detected: Span[], expected: number): Span[] {
  let spans = detected
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.startSec - b.startSec);
  const n = Math.max(0, Math.floor(expected));
  if (!spans.length || n === 0) return [];
  while (spans.length > n) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i < spans.length - 1; i++) {
      const len = spans[i + 1].endSec - spans[i].startSec;
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    spans.splice(best, 2, { startSec: spans[best].startSec, endSec: spans[best + 1].endSec });
  }
  while (spans.length < n) {
    let best = 0;
    for (let i = 1; i < spans.length; i++) if (spans[i].endSec - spans[i].startSec > spans[best].endSec - spans[best].startSec) best = i;
    const s = spans[best];
    const mid = (s.startSec + s.endSec) / 2;
    spans.splice(best, 1, { startSec: s.startSec, endSec: mid }, { startSec: mid, endSec: s.endSec });
  }
  // Each syllable runs until the next one starts (the consonants between nuclei belong to the next syllable).
  spans = spans.map((s, i) => ({ startSec: s.startSec, endSec: i + 1 < spans.length ? Math.max(s.endSec, Math.min(spans[i + 1].startSec, s.endSec + 0.25)) : s.endSec }));
  return spans;
}

export interface SegmentOptions {
  bpm: number;
  /** Pattern tick that becomes 0 s in the output (the first melody note). */
  originTick: number;
  /** Octave shift −2..2. */
  octave?: number;
}

/** Groups + where each syllable is in the source → the analyzer's `sing` segments, in melody order. */
export function buildSegments(groups: SingGroup[], melody: MelodyNote[], spans: Span[], opts: SegmentOptions): SingArgs['segments'] {
  const shift = 12 * Math.max(-2, Math.min(2, Math.round(opts.octave ?? 0)));
  const segs: SingArgs['segments'] = [];
  for (const g of groups) {
    const first = spans[g.syllables[0]];
    const last = spans[g.syllables[g.syllables.length - 1]];
    if (!first || !last || !g.notes.length) continue;
    const src0 = first.startSec;
    const src1 = Math.max(src0 + 0.01, last.endSec);
    const durs = g.notes.map((ni) => Math.max(1, melody[ni]?.dur ?? 1));
    const total = durs.reduce((a, b) => a + b, 0);
    let at = src0;
    g.notes.forEach((ni, k) => {
      const m = melody[ni];
      if (!m) return;
      const part = ((src1 - src0) * durs[k]) / total;
      segs.push({
        srcStartSec: round4(at),
        srcEndSec: round4(at + part),
        outStartSec: round4(ticksToSeconds(m.tick - opts.originTick, opts.bpm)),
        durSec: round4(ticksToSeconds(m.dur, opts.bpm)),
        midi: Math.max(0, Math.min(127, m.key + shift)),
      });
      at += part;
    });
  }
  return segs;
}

/** The syllable → note list the UI shows (one row per note; held notes show "_"). */
export function mappingRows(groups: SingGroup[], melody: MelodyNote[], syllables: Array<Pick<LyricSyllable, 'text'>>): Array<{ syllable: string; noteTick: number; key: number }> {
  const rows: Array<{ syllable: string; noteTick: number; key: number }> = [];
  for (const g of groups) {
    const text = g.syllables.map((i) => syllables[i]?.text ?? '').join(' ');
    g.notes.forEach((ni, k) => {
      const m = melody[ni];
      if (m) rows.push({ syllable: k === 0 ? text : '_', noteTick: m.tick, key: m.key });
    });
  }
  return rows;
}

/** "1-4" / "3" (1-based, inclusive bars of the pattern) → [start, end) ticks, or an error sentence. */
export function patternBarRange(bars: string | undefined, ticksPerBar: number): { start: number; end: number } | { error: string } | null {
  if (bars === undefined || !String(bars).trim()) return null;
  const m = /^\s*(\d+)\s*(?:[-–:]\s*(\d+))?\s*$/.exec(String(bars));
  if (!m) return { error: `bars "${String(bars).slice(0, 20)}" must look like "1-4" or "3" (bars of the pattern, 1-based)` };
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b < a) return { error: `bars "${String(bars).slice(0, 20)}" must be ascending and start at 1 or later` };
  return { start: (a - 1) * ticksPerBar, end: b * ticksPerBar };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
