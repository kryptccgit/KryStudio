// ──────────────────────────────────────────────────────────────────────
// "Sing my notes" preview (research/21 §sing): typed lyrics → syllables →
// the notes of the pattern's channel, drawn on the piano roll as labels
// above the notes before anything is rendered. A thin view adapter over
// the SAME pure planning code main renders with (shared/voice/syllables.ts
// + shared/voice/singplan.ts), so the preview is exactly where the
// syllables will land:
//
//   beau-ti-ful  "-" splits a word by hand      love_  "_" holds one more note
//   lo_ve        split there + hold the first   _      a lone "_" holds the previous syllable
//   extra notes hold the last syllable; extra syllables squeeze onto the last note.
// ──────────────────────────────────────────────────────────────────────

import { ticksPerBar, type TimeSig } from '@shared/schema/time';
import { parseLyrics as parseSharedLyrics, type ParsedLyrics } from '@shared/voice/syllables';
import { mapSyllables as mapShared, mappingRows, melodyFromNotes, patternBarRange, type MelodyNote } from '@shared/voice/singplan';

export type { MelodyNote, ParsedLyrics };

/** Lyrics (with the markup above) → lines of syllables. Never throws. */
export function parseLyrics(lyrics: string): ParsedLyrics {
  return parseSharedLyrics(lyrics);
}

/** "1-4" or "3" → a 1-based inclusive bar range; null = the whole pattern; 'invalid' for anything else. */
export function parseBarRange(text: string | undefined): { from: number; to: number } | null | 'invalid' {
  const r = patternBarRange(text, 1);
  if (r === null) return null;
  if ('error' in r) return 'invalid';
  return { from: r.start + 1, to: r.end };
}

/** The notes a voice sings: unmuted, in the bar range, one at a time (the highest note wins), as main plans them. */
export function melodyNotes(notes: ReadonlyArray<{ tick: number; key: number; dur: number; mute?: boolean }>, range: { from: number; to: number } | null, ts: TimeSig): MelodyNote[] {
  const bar = ticksPerBar(ts);
  return melodyFromNotes([...notes], range ? { start: (range.from - 1) * bar, end: range.to * bar } : undefined);
}

// ── Syllables → notes, as roll labels ─────────────────────────────────

export interface SyllableLabel {
  tick: number;
  key: number;
  dur: number;
  /** The syllable ('start'), '' for a held note, or the squeezed-on syllables ('extra', on the last note). */
  text: string;
  kind: 'start' | 'hold' | 'extra';
}

export interface SingMapping {
  labels: SyllableLabel[];
  syllables: number;
  notes: number;
  /** Lines worth saying under the lyrics (stray markup, extra notes / syllables, holds cut short). */
  messages: string[];
}

/** Spread the lyrics over the melody (shared/voice/singplan.ts mapSyllables) and turn the groups into labels. */
export function mapSyllables(parsed: ParsedLyrics, melody: readonly MelodyNote[]): SingMapping {
  const m = mapShared(parsed.syllables, melody.length);
  const labels: SyllableLabel[] = [];
  for (const g of m.groups) {
    const text = g.syllables.map((i) => parsed.syllables[i]?.text ?? '').join('·');
    g.notes.forEach((ni, k) => {
      const n = melody[ni];
      if (!n) return;
      if (k > 0) labels.push({ tick: n.tick, key: n.key, dur: n.dur, text: '', kind: 'hold' });
      else labels.push({ tick: n.tick, key: n.key, dur: n.dur, text, kind: g.syllables.length > 1 ? 'extra' : 'start' });
    });
  }
  return { labels, syllables: parsed.syllables.length, notes: melody.length, messages: [...parsed.notes, ...(parsed.syllables.length ? m.notes : [])] };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The line above the lyrics box: "9 syllables on 12 notes". */
export function mappingLine(m: Pick<SingMapping, 'syllables' | 'notes'>): string {
  if (!m.notes) return 'No notes here: draw a melody first';
  if (!m.syllables) return `Type the lyrics: ${plural(m.notes, 'note')} to sing`;
  return `${plural(m.syllables, 'syllable')} on ${plural(m.notes, 'note')}`;
}

/**
 * The mapping a render returned (one row per note, "_" on held notes, see singplan.mappingRows) as roll labels.
 * Durations come from the melody; a row whose note isn't in the melody any more gets a 1/16 so it still shows.
 */
export function labelsFromOutcome(mapping: ReadonlyArray<{ syllable: string; noteTick: number; key: number }>, melody: readonly MelodyNote[]): SyllableLabel[] {
  const exact = new Map(melody.map((n) => [`${n.tick}:${n.key}`, n] as const));
  const byStart = new Map(melody.map((n) => [n.tick, n] as const));
  return mapping.map((r) => {
    const n = exact.get(`${r.noteTick}:${r.key}`) ?? byStart.get(r.noteTick);
    const hold = r.syllable === '_' || r.syllable === '';
    return { tick: r.noteTick, key: r.key, dur: n?.dur ?? 240, text: hold ? '' : r.syllable, kind: hold ? 'hold' : r.syllable.includes(' ') ? 'extra' : 'start' };
  });
}

/** The same planning main uses for SingOutcome.mapping (for the browser mock and tests). */
export function plannedRows(parsed: ParsedLyrics, melody: MelodyNote[]): Array<{ syllable: string; noteTick: number; key: number }> {
  return mappingRows(mapShared(parsed.syllables, melody.length).groups, melody, parsed.syllables);
}
