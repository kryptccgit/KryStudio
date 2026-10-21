// Small music-theory toolkit shared by the piano roll (scale highlighting,
// chord stamps), KPN (note/chord parsing) and MCP tools.
// MIDI 60 = C4 here (scientific pitch). FL labels MIDI 60 "C5"; the UI can
// show either via noteName(key, 'fl').

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(key: number, style: 'scientific' | 'fl' = 'scientific', flats = false): string {
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const octave = Math.floor(key / 12) - (style === 'fl' ? 0 : 1);
  return `${names[((key % 12) + 12) % 12]}${octave}`;
}

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parse a pitch class like "F#", "Bb", "c" → 0..11, or null. */
export function parsePitchClass(s: string): number | null {
  const m = /^([A-Ga-g])([#b]{0,2})$/.exec(s.trim());
  if (!m) return null;
  let pc = PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

/** Parse "C4", "F#2", "Bb-1" (scientific) → MIDI, or null. */
export function parseNoteName(s: string): number | null {
  const m = /^([A-Ga-g][#b]{0,2})(-?\d+)$/.exec(s.trim());
  if (!m) return null;
  const pc = parsePitchClass(m[1]);
  if (pc === null) return null;
  const midi = (Number(m[2]) + 1) * 12 + pc;
  return midi >= 0 && midi <= 127 ? midi : null;
}

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export interface Key {
  root: number; // pitch class 0..11
  scale: keyof typeof SCALES | string;
}

/** Parse "F#m", "C", "Am", "D dorian", "Eb minor" → Key. */
export function parseKey(s: string): Key | null {
  const m = /^\s*([A-Ga-g][#b]?)\s*(m|min|minor|maj|major|[a-zA-Z]+)?\s*$/.exec(s);
  if (!m) return null;
  const root = parsePitchClass(m[1]);
  if (root === null) return null;
  const q = (m[2] ?? '').toLowerCase();
  const scale = q === '' || q === 'maj' || q === 'major' ? 'major' : q === 'm' || q === 'min' || q === 'minor' ? 'minor' : Object.keys(SCALES).find((s) => s.toLowerCase() === q);
  if (!scale) return null;
  return { root, scale };
}

export function inScale(key: number, k: Key): boolean {
  const steps = SCALES[k.scale] ?? SCALES.major;
  return steps.includes((((key - k.root) % 12) + 12) % 12);
}

/** Scale degree (1-based, may be fractional-free) → MIDI note, with octave. */
export function degreeToMidi(degree: number, k: Key, octave: number, accidental = 0): number {
  const steps = SCALES[k.scale] ?? SCALES.major;
  const d = degree - 1;
  const oct = Math.floor(d / steps.length);
  const idx = ((d % steps.length) + steps.length) % steps.length;
  return (octave + 1 + oct) * 12 + k.root + steps[idx] + accidental;
}

export const CHORD_QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  mmaj7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17],
  m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21],
};

/** Parse a chord symbol ("Am7", "Fmaj7", "G/B", "C#m9") at an octave → MIDI notes (bass first). */
export function parseChord(symbol: string, octave = 3): number[] | null {
  const m = /^([A-G][#b]?)([a-z0-9]*)(?:\/([A-G][#b]?))?$/.exec(symbol.trim());
  if (!m) return null;
  const root = parsePitchClass(m[1]);
  const intervals = CHORD_QUALITIES[m[2]];
  if (root === null || !intervals) return null;
  const base = (octave + 1) * 12 + root;
  let notes = intervals.map((i) => base + i);
  if (m[3]) {
    const bass = parsePitchClass(m[3]);
    if (bass === null) return null;
    let b = (octave + 1) * 12 + bass;
    while (b >= notes[0]) b -= 12;
    notes = [b, ...notes];
  }
  return notes.every((n) => n >= 0 && n <= 127) ? notes : null;
}
