import { ticksPerBar, type TimeSig } from '@shared/schema/time';
import { parseLyrics as parseSharedLyrics, type ParsedLyrics } from '@shared/voice/syllables';
import { mapSyllables as mapShared, mappingRows, melodyFromNotes, patternBarRange, type MelodyNote } from '@shared/voice/singplan';

export type { MelodyNote, ParsedLyrics };

export function parseLyrics(lyrics: string): ParsedLyrics {
  return parseSharedLyrics(lyrics);
}

export function parseBarRange(text: string | undefined): { from: number; to: number } | null | 'invalid' {
  const r = patternBarRange(text, 1);
  if (r === null) return null;
  if ('error' in r) return 'invalid';
  return { from: r.start + 1, to: r.end };
}

export function melodyNotes(notes: ReadonlyArray<{ tick: number; key: number; dur: number; mute?: boolean }>, range: { from: number; to: number } | null, ts: TimeSig): MelodyNote[] {
  const bar = ticksPerBar(ts);
  return melodyFromNotes([...notes], range ? { start: (range.from - 1) * bar, end: range.to * bar } : undefined);
}

export interface SyllableLabel {
  tick: number;
  key: number;
  dur: number;
  text: string;
  kind: 'start' | 'hold' | 'extra';
}

export interface SingMapping {
  labels: SyllableLabel[];
  syllables: number;
  notes: number;
  messages: string[];
}

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

export function mappingLine(m: Pick<SingMapping, 'syllables' | 'notes'>): string {
  if (!m.notes) return 'No notes here: draw a melody first';
  if (!m.syllables) return `Type the lyrics: ${plural(m.notes, 'note')} to sing`;
  return `${plural(m.syllables, 'syllable')} on ${plural(m.notes, 'note')}`;
}

export function labelsFromOutcome(mapping: ReadonlyArray<{ syllable: string; noteTick: number; key: number }>, melody: readonly MelodyNote[]): SyllableLabel[] {
  const exact = new Map(melody.map((n) => [`${n.tick}:${n.key}`, n] as const));
  const byStart = new Map(melody.map((n) => [n.tick, n] as const));
  return mapping.map((r) => {
    const n = exact.get(`${r.noteTick}:${r.key}`) ?? byStart.get(r.noteTick);
    const hold = r.syllable === '_' || r.syllable === '';
    return { tick: r.noteTick, key: r.key, dur: n?.dur ?? 240, text: hold ? '' : r.syllable, kind: hold ? 'hold' : r.syllable.includes(' ') ? 'extra' : 'start' };
  });
}

export function plannedRows(parsed: ParsedLyrics, melody: MelodyNote[]): Array<{ syllable: string; noteTick: number; key: number }> {
  return mappingRows(mapShared(parsed.syllables, melody.length).groups, melody, parsed.syllables);
}
