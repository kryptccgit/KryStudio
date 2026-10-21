// Key maths for matching and tuning audio (match_clip, tune_vocal, the
// clip menu): the smallest semitone move that puts one key's notes on
// another's, key names after a move, and the Krypt Tune key / scale for a
// key. Relative keys share their notes (A minor = C major), so moving an
// Am vocal onto a C instrumental needs 0 semitones, and the common
// relative major/minor confusion of key detection costs nothing here.
// Pure: no I/O.

import { parseKey, parsePitchClass } from './theory';

/** A key as pitch class + mode. */
export interface KeyRef {
  /** Tonic pitch class, 0..11 (C = 0). */
  pc: number;
  minor: boolean;
}

/** Conventional spellings: flats for F / Bb / Eb … major and D / G / C … minor, sharps otherwise. */
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

/** "Am" / "F#m" / "Eb" / "A minor" / {tonic, mode} (analyze_audio) → KeyRef. Modes other than major / minor → null. */
export function toKeyRef(k: string | { tonic: string; mode: string } | KeyRef | null | undefined): KeyRef | null {
  if (!k) return null;
  if (typeof k === 'object' && 'pc' in k) return Number.isFinite(k.pc) ? { pc: mod12(k.pc), minor: !!k.minor } : null;
  if (typeof k === 'object') {
    const pc = parsePitchClass(String(k.tonic ?? ''));
    if (pc === null) return null;
    if (k.mode !== 'major' && k.mode !== 'minor') return null;
    return { pc, minor: k.mode === 'minor' };
  }
  const parsed = parseKey(k);
  if (!parsed || (parsed.scale !== 'major' && parsed.scale !== 'minor')) return null;
  return { pc: parsed.root, minor: parsed.scale === 'minor' };
}

/** "Am", "Bb", "F#m". */
export function keyShortName(k: KeyRef): string {
  return k.minor ? `${MINOR_NAMES[mod12(k.pc)]}m` : MAJOR_NAMES[mod12(k.pc)];
}

/** "A minor", "Bb major". */
export function keyLongName(k: KeyRef): string {
  return `${(k.minor ? MINOR_NAMES : MAJOR_NAMES)[mod12(k.pc)]} ${k.minor ? 'minor' : 'major'}`;
}

/** Pitch class of the key signature's major key: Am → C (3), C → C (0). */
export function relativeMajorPc(k: KeyRef): number {
  return k.minor ? mod12(k.pc + 3) : mod12(k.pc);
}

/** The relative key (same notes, other mode): Am ↔ C. */
export function relativeKey(k: KeyRef): KeyRef {
  return k.minor ? { pc: mod12(k.pc + 3), minor: false } : { pc: mod12(k.pc + 9), minor: true };
}

export function sameKey(a: KeyRef, b: KeyRef): boolean {
  return mod12(a.pc) === mod12(b.pc) && a.minor === b.minor;
}

/** Any whole number of semitones → the same pitch-class move within −6..+6 (a tritone goes down: −6). */
export function wrapSemitones(n: number): number {
  const m = mod12(n);
  return m >= 6 ? m - 12 : m;
}

export function transposeKey(k: KeyRef, semitones: number): KeyRef {
  return { pc: mod12(k.pc + semitones), minor: k.minor };
}

export interface KeyShift {
  /** −6..+6: the smallest move that puts `from`'s notes on `to`'s. */
  semitones: number;
  /** same = already in that key; relative = the relative major/minor (same notes, 0 st); move = transposed. */
  relation: 'same' | 'relative' | 'move';
  from: KeyRef;
  to: KeyRef;
  /** `from` after the move (its own mode is kept). */
  result: KeyRef;
}

/**
 * The smallest semitone move (−6..+6) that puts the notes of key `from` on
 * the notes of key `to`. Modes are compared through their relative major
 * (the key signature), so A minor → C major is 0 and A minor → G minor is −2.
 */
export function keyShift(from: KeyRef, to: KeyRef): KeyShift {
  const semitones = wrapSemitones(relativeMajorPc(to) - relativeMajorPc(from));
  const relation: KeyShift['relation'] = semitones !== 0 ? 'move' : sameKey(from, to) ? 'same' : 'relative';
  return { semitones, relation, from, to, result: transposeKey(from, semitones) };
}

/** +2 → "+2 st", −2 → "−2 st", 0.5 → "+0.5 st" (typographic minus for messages). */
export function fmtSemitones(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (r === 0) return '0 st';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} st`;
}

/** The Audio Clip pitch range (semitones). */
export const PITCH_RANGE = 24;

/** null when `n` is a usable explicit semitone shift, else why not. */
export function semitoneProblem(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'semitones must be a number';
  if (Math.abs(n) > PITCH_RANGE) return `semitones must be between −${PITCH_RANGE} and +${PITCH_RANGE} (the Audio Clip pitch range); ${n} is out of range`;
  return null;
}

// ── Krypt Tune (krypt.pitch) ──────────────────────────────────────────

/** Krypt Tune's Scale options, in catalog order (engine/crates/dsp/src/effects/pitch.rs SCALES). */
export const TUNE_SCALES = ['Chromatic', 'Major', 'Minor', 'Harmonic minor', 'Major pentatonic', 'Minor pentatonic', 'Dorian', 'Mixolydian', 'Blues'] as const;

/** theory.ts scale ids → Krypt Tune scale index. */
const THEORY_TO_TUNE: Record<string, number> = { chromatic: 0, major: 1, minor: 2, harmonicMinor: 3, majorPentatonic: 4, minorPentatonic: 5, dorian: 6, mixolydian: 7, blues: 8 };
/** Modes Krypt Tune has no scale for, tuned on their parent major scale (same notes): semitones from the mode's root to the major root. */
const PARENT_MAJOR: Record<string, { offset: number; name: string }> = {
  phrygian: { offset: -4, name: 'Phrygian' },
  lydian: { offset: -5, name: 'Lydian' },
  locrian: { offset: 1, name: 'Locrian' },
};

const loose = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

/** "minor pentatonic" / "Minor Pentatonic" / "minorpentatonic" → scale index, or null. */
export function tuneScaleIndex(name: string): number | null {
  const n = loose(name);
  const i = TUNE_SCALES.findIndex((s) => loose(s) === n);
  if (i >= 0) return i;
  if (n === 'naturalminor' || n === 'aeolian' || n === 'min') return 2;
  if (n === 'ionian' || n === 'maj') return 1;
  return null;
}

export interface TuneKey {
  /** Krypt Tune `root` (0..11). */
  root: number;
  /** Krypt Tune `scale` index into TUNE_SCALES. */
  scale: number;
  /** "G minor", "D Dorian", "Chromatic". */
  label: string;
  /** Set when a mode was mapped onto its parent major scale. */
  note?: string;
}

/**
 * The Krypt Tune Key + Scale for a key: a KeyRef, or text like "F#m",
 * "A minor", "D dorian", "E phrygian" (tuned on C major: same notes).
 * `scale` overrides the scale ("chromatic", "minor pentatonic", "blues" …).
 * Throws an Error with a human message when it can't.
 */
export function tuneKeyFor(key: KeyRef | string, scale?: string): TuneKey {
  let root: number;
  let idx: number;
  let note: string | undefined;
  if (typeof key === 'string') {
    const parsed = parseKey(key);
    if (!parsed) throw new Error(`"${key}" isn't a key (e.g. "F#m", "A minor", "Eb", "D dorian")`);
    root = parsed.root;
    const scaleId = String(parsed.scale);
    if (scaleId in THEORY_TO_TUNE) idx = THEORY_TO_TUNE[scaleId];
    else if (PARENT_MAJOR[scaleId]) {
      const pm = PARENT_MAJOR[scaleId];
      const majorRoot = mod12(root + pm.offset);
      note = `${MAJOR_NAMES[root]} ${pm.name} has the same notes as ${MAJOR_NAMES[majorRoot]} major, so it is tuned to that`;
      root = majorRoot;
      idx = 1;
    } else throw new Error(`Krypt Tune has no ${scaleId} scale. Scales: ${TUNE_SCALES.join(', ')}`);
  } else {
    root = mod12(key.pc);
    idx = key.minor ? 2 : 1;
  }
  if (scale !== undefined && scale.trim()) {
    const s = tuneScaleIndex(scale);
    if (s === null) throw new Error(`Krypt Tune has no "${scale}" scale. Scales: ${TUNE_SCALES.join(', ')}`);
    idx = s;
  }
  const names = idx === 2 || idx === 3 || idx === 5 ? MINOR_NAMES : MAJOR_NAMES;
  const label = idx === 0 ? 'Chromatic' : `${names[root]} ${idx === 1 ? 'major' : idx === 2 ? 'minor' : TUNE_SCALES[idx]}`;
  return { root, scale: idx, label, ...(note ? { note } : {}) };
}

/** Krypt Tune presets: how hard the correction grabs. */
export type TuneStyle = 'natural' | 'pop' | 'hard';

export const TUNE_STYLES: Record<TuneStyle, { label: string; speed: number; humanize: number; detail: string }> = {
  natural: { label: 'Natural', speed: 60, humanize: 0.4, detail: 'Gentle: fixes pitch, keeps vibrato and slides' },
  pop: { label: 'Pop', speed: 25, humanize: 0.2, detail: 'Tight and polished, still human' },
  hard: { label: 'Hard', speed: 0, humanize: 0, detail: 'Instant snap: the robotic trap effect' },
};

export const TUNE_EFFECT = 'krypt.pitch';
