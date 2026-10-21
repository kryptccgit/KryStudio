import { parseKey, parsePitchClass } from './theory';

export interface KeyRef {
  pc: number;
  minor: boolean;
}

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

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

export function keyShortName(k: KeyRef): string {
  return k.minor ? `${MINOR_NAMES[mod12(k.pc)]}m` : MAJOR_NAMES[mod12(k.pc)];
}

export function keyLongName(k: KeyRef): string {
  return `${(k.minor ? MINOR_NAMES : MAJOR_NAMES)[mod12(k.pc)]} ${k.minor ? 'minor' : 'major'}`;
}

export function relativeMajorPc(k: KeyRef): number {
  return k.minor ? mod12(k.pc + 3) : mod12(k.pc);
}

export function relativeKey(k: KeyRef): KeyRef {
  return k.minor ? { pc: mod12(k.pc + 3), minor: false } : { pc: mod12(k.pc + 9), minor: true };
}

export function sameKey(a: KeyRef, b: KeyRef): boolean {
  return mod12(a.pc) === mod12(b.pc) && a.minor === b.minor;
}

export function wrapSemitones(n: number): number {
  const m = mod12(n);
  return m >= 6 ? m - 12 : m;
}

export function transposeKey(k: KeyRef, semitones: number): KeyRef {
  return { pc: mod12(k.pc + semitones), minor: k.minor };
}

export interface KeyShift {
  semitones: number;
  relation: 'same' | 'relative' | 'move';
  from: KeyRef;
  to: KeyRef;
  result: KeyRef;
}

export function keyShift(from: KeyRef, to: KeyRef): KeyShift {
  const semitones = wrapSemitones(relativeMajorPc(to) - relativeMajorPc(from));
  const relation: KeyShift['relation'] = semitones !== 0 ? 'move' : sameKey(from, to) ? 'same' : 'relative';
  return { semitones, relation, from, to, result: transposeKey(from, semitones) };
}

export function fmtSemitones(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (r === 0) return '0 st';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} st`;
}

export const PITCH_RANGE = 24;

export function semitoneProblem(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'semitones must be a number';
  if (Math.abs(n) > PITCH_RANGE) return `semitones must be between −${PITCH_RANGE} and +${PITCH_RANGE} (the Audio Clip pitch range); ${n} is out of range`;
  return null;
}

export const TUNE_SCALES = ['Chromatic', 'Major', 'Minor', 'Harmonic minor', 'Major pentatonic', 'Minor pentatonic', 'Dorian', 'Mixolydian', 'Blues'] as const;

const THEORY_TO_TUNE: Record<string, number> = { chromatic: 0, major: 1, minor: 2, harmonicMinor: 3, majorPentatonic: 4, minorPentatonic: 5, dorian: 6, mixolydian: 7, blues: 8 };
const PARENT_MAJOR: Record<string, { offset: number; name: string }> = {
  phrygian: { offset: -4, name: 'Phrygian' },
  lydian: { offset: -5, name: 'Lydian' },
  locrian: { offset: 1, name: 'Locrian' },
};

const loose = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

export function tuneScaleIndex(name: string): number | null {
  const n = loose(name);
  const i = TUNE_SCALES.findIndex((s) => loose(s) === n);
  if (i >= 0) return i;
  if (n === 'naturalminor' || n === 'aeolian' || n === 'min') return 2;
  if (n === 'ionian' || n === 'maj') return 1;
  return null;
}

export interface TuneKey {
  root: number;
  scale: number;
  label: string;
  note?: string;
}

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

export type TuneStyle = 'natural' | 'pop' | 'hard';

export const TUNE_STYLES: Record<TuneStyle, { label: string; speed: number; humanize: number; detail: string }> = {
  natural: { label: 'Natural', speed: 60, humanize: 0.4, detail: 'Gentle: fixes pitch, keeps vibrato and slides' },
  pop: { label: 'Pop', speed: 25, humanize: 0.2, detail: 'Tight and polished, still human' },
  hard: { label: 'Hard', speed: 0, humanize: 0, detail: 'Instant snap: the robotic trap effect' },
};

export const TUNE_EFFECT = 'krypt.pitch';
