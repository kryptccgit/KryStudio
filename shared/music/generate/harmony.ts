import { CHORD_QUALITIES, NOTE_NAMES_FLAT, NOTE_NAMES_SHARP, SCALES } from '../theory';
import type { Rng } from './random';

export interface GenKey {
  root: number;
  scale: string;
}

export class GenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerateError';
  }
}

export const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

export function scaleSteps(scale: string): number[] {
  const s = SCALES[scale];
  if (!s) throw new GenerateError(`Unknown scale "${scale}" (use one of: ${Object.keys(SCALES).join(', ')})`);
  return s;
}

export function isMinorKey(key: GenKey): boolean {
  const s = scaleSteps(key.scale);
  return s.includes(3) && !s.includes(4);
}

export function chordScale(key: GenKey): number[] {
  const s = scaleSteps(key.scale);
  if (s.length === 7) return s;
  return isMinorKey(key) ? SCALES.minor : SCALES.major;
}

export function keyName(key: GenKey): string {
  const names = useFlats(key) ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const label: Record<string, string> = { major: 'major', minor: 'minor', harmonicMinor: 'harmonic minor', melodicMinor: 'melodic minor', majorPentatonic: 'major pentatonic', minorPentatonic: 'minor pentatonic' };
  return `${names[mod12(key.root)]} ${label[key.scale] ?? key.scale}`;
}

export function inKey(midi: number, key: GenKey): boolean {
  return scaleSteps(key.scale).includes(mod12(midi - key.root));
}

export function degreeToMidi(deg: number, key: GenKey, steps = scaleSteps(key.scale)): number {
  const n = steps.length;
  const o = Math.floor(deg / n);
  return key.root + o * 12 + steps[((deg % n) + n) % n];
}

export function midiToDegree(midi: number, key: GenKey, steps = scaleSteps(key.scale)): number {
  let best = 0;
  let bestDist = Infinity;
  const oct = Math.floor((midi - key.root) / 12);
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (let i = 0; i < steps.length; i++) {
      const k = key.root + o * 12 + steps[i];
      const dist = Math.abs(k - midi);
      if (dist < bestDist || (dist === bestDist && k < midi)) {
        bestDist = dist;
        best = o * steps.length + i;
      }
    }
  }
  return best;
}

export interface Chord {
  root: number;
  tones: number[];
  name: string;
}

export type Extensions = 'triads' | 'sevenths' | 'ninths';

const SIZE: Record<Extensions, number> = { triads: 3, sevenths: 4, ninths: 5 };

export function chordName(root: number, tones: number[], flats = false): string {
  const set = [...new Set(tones)].sort((a, b) => a - b);
  const sig = set.join(',');
  const pref = ['', 'm', 'dim', 'aug', 'sus2', 'sus4', '5', '7', 'maj7', 'm7', 'm7b5', 'dim7', 'mmaj7', '6', 'm6', 'add9', 'madd9', '9', 'maj9', 'm9', '11', 'm11', '13'];
  const q = pref.find((k) => CHORD_QUALITIES[k] && CHORD_QUALITIES[k].join(',') === sig);
  const nm = (flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[mod12(root)];
  if (q !== undefined) return `${nm}${q}`;
  const tri = set.includes(3) ? (set.includes(6) && !set.includes(7) ? 'dim' : 'm') : set.includes(8) && !set.includes(7) ? 'aug' : '';
  return `${nm}${tri}${set.some((t) => t >= 12) ? '(add)' : ''}`;
}

export function diatonicChord(key: GenKey, degree: number, ext: Extensions, accidental = 0): Chord {
  const steps = chordScale(key);
  const d = ((degree % 7) + 7) % 7;
  const at = (i: number): number => steps[(d + i) % 7] + 12 * Math.floor((d + i) / 7);
  const tones = [0, 2, 4, 6, 8].slice(0, SIZE[ext]).map((i) => at(i) - at(0));
  const root = mod12(key.root + steps[d] + accidental);
  return { root, tones, name: chordName(root, tones, accidental < 0 || (accidental === 0 && useFlats(key))) };
}

function useFlats(key: GenKey): boolean {
  return (isMinorKey(key) ? [0, 2, 3, 5, 7, 10] : [1, 3, 5, 8, 10]).includes(mod12(key.root));
}

export interface ProgressionPreset {
  id: string;
  label: string;
  major: number[];
  minor: number[];
  sevenths?: boolean;
}

export const PROGRESSIONS: ProgressionPreset[] = [
  { id: 'pop', label: 'Pop anthem', major: [1, 5, 6, 4], minor: [1, 6, 3, 7] },
  { id: 'sad', label: 'Sad / emotional', major: [6, 4, 1, 5], minor: [1, 4, 6, 5] },
  { id: 'epic', label: 'Epic / cinematic', major: [6, 4, 1, 5], minor: [1, 6, 7, 5] },
  { id: 'dark', label: 'Dark trap / drill', major: [6, 6, 4, 3], minor: [1, 1, 6, 5] },
  { id: 'jazzy', label: 'Jazzy ii–V–I', major: [2, 5, 1, 6], minor: [4, 7, 3, 6], sevenths: true },
  { id: 'lofi', label: 'Lo-fi / neo-soul', major: [4, 3, 2, 1], minor: [6, 5, 4, 1], sevenths: true },
  { id: 'house', label: 'House / dance', major: [6, 5, 4, 5], minor: [1, 7, 6, 7] },
  { id: 'circle', label: 'Circle of fifths', major: [1, 4, 7, 3, 6, 2, 5, 1], minor: [1, 4, 7, 3, 6, 2, 5, 1] },
];

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

export function parseNumeral(tok: string, key: GenKey, ext: Extensions): Chord | null {
  const t = tok.trim().replace('♭', 'b').replace('♯', '#');
  const arabic = /^([b#]?)([1-7])$/.exec(t);
  if (arabic) return diatonicChord(key, Number(arabic[2]) - 1, ext, arabic[1] === 'b' ? -1 : arabic[1] === '#' ? 1 : 0);
  const m = /^([b#]?)(vii|iii|vi|iv|ii|v|i|VII|III|VI|IV|II|V|I)(°|o|dim|ø|\+|aug)?(maj7|maj9|m7|7|9|6|sus2|sus4|add9)?$/.exec(t);
  if (!m) return null;
  const upper = m[2] === m[2].toUpperCase();
  const degree = ROMAN[m[2].toLowerCase()] - 1;
  const acc = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
  const steps = chordScale(key);
  const root = mod12(key.root + steps[degree] + acc);
  const q = m[3] ?? '';
  const suf = m[4] ?? '';
  let tones: number[];
  if (q === '°' || q === 'o' || q === 'dim') tones = suf === '7' ? [0, 3, 6, 9] : [0, 3, 6];
  else if (q === 'ø') tones = [0, 3, 6, 10];
  else if (q === '+' || q === 'aug') tones = [0, 4, 8];
  else tones = upper ? [0, 4, 7] : [0, 3, 7];
  if (suf === 'sus2') tones = [0, 2, 7];
  else if (suf === 'sus4') tones = [0, 5, 7];
  else if (suf === '7' && tones.length === 3) tones = [...tones, 10];
  else if (suf === 'maj7' || suf === 'maj9') tones = [...tones, 11];
  else if (suf === 'm7') tones = [...tones, 10];
  else if (suf === '6') tones = [...tones, 9];
  if (suf === '9') tones = tones.length === 3 ? [...tones, 10, 14] : [...tones, 14];
  if (suf === 'maj9') tones = [...tones, 14];
  if (suf === 'add9') tones = [...tones, 14];
  if (!suf && ext !== 'triads' && tones.length === 3) {
    const dia = diatonicChord(key, degree, ext);
    tones = [...tones, acc === 0 ? dia.tones[3] : 10];
    if (ext === 'ninths') tones.push(acc === 0 ? dia.tones[4] : 14);
  }
  tones = [...new Set(tones)].sort((a, b) => a - b);
  return { root, tones, name: chordName(root, tones, acc < 0 || (acc === 0 && useFlats(key))) };
}

export interface ProgressionResult {
  chords: Chord[];
  id: string;
  label: string;
}

export function resolveProgression(spec: string, key: GenKey, ext: Extensions | 'auto', rng: Rng): ProgressionResult {
  const s = spec.trim() || 'auto';
  const preset = s === 'auto' ? rng.pick(PROGRESSIONS) : PROGRESSIONS.find((p) => p.id === s.toLowerCase());
  if (preset) {
    const e: Extensions = ext === 'auto' ? (preset.sevenths ? 'sevenths' : 'triads') : ext;
    const degs = isMinorKey(key) ? preset.minor : preset.major;
    return { chords: degs.map((d) => diatonicChord(key, d - 1, e)), id: preset.id, label: preset.label };
  }
  const tokens = s.split(/[\s,|–—-]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 32) throw new GenerateError('A progression needs 1 to 32 chords, e.g. "i VI III VII" or "1 5 6 4"');
  const e: Extensions = ext === 'auto' ? 'triads' : ext;
  const chords = tokens.map((t) => {
    const c = parseNumeral(t, key, e);
    if (!c) throw new GenerateError(`"${t.slice(0, 12)}" is not a chord numeral (use I–VII / i–vii with °, +, 7, maj7, sus4, b/#, or degrees 1–7; presets: ${PROGRESSIONS.map((p) => p.id).join(', ')})`);
    return c;
  });
  return { chords, id: 'custom', label: tokens.join(' ') };
}

export type Voicing = 'close' | 'open' | 'spread';
export type Inversion = 'auto' | 'root' | 'first' | 'second' | 'third';

function closeAt(chord: Chord, inv: number, floor: number): number[] {
  const pcs = chord.tones.map((t) => t % 12);
  const n = pcs.length;
  const order = pcs.slice(inv % n).concat(pcs.slice(0, inv % n));
  const out: number[] = [];
  let k = floor + mod12(chord.root + order[0] - floor);
  out.push(k);
  for (let i = 1; i < n; i++) {
    k += mod12(chord.root + order[i] - k) || 12;
    out.push(k);
  }
  return out;
}

export function voiceDistance(a: number[], b: number[]): number {
  const near = (x: number, ys: number[]): number => Math.min(...ys.map((y) => Math.abs(x - y)));
  return a.reduce((s, x) => s + near(x, b), 0) + b.reduce((s, y) => s + near(y, a), 0);
}

const INV: Record<Exclude<Inversion, 'auto'>, number> = { root: 0, first: 1, second: 2, third: 3 };

export function voiceClose(chord: Chord, center: number, inversion: Inversion, prev: number[] | null): number[] {
  const n = chord.tones.length;
  const cands: Array<{ v: number[]; inv: number }> = [];
  for (let inv = 0; inv < n; inv++) for (let f = center - 12; f <= center + 6; f++) {
    const v = closeAt(chord, inv, f);
    if (v[0] === f) cands.push({ v, inv });
  }
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  if (inversion !== 'auto') {
    const inv = INV[inversion] % n;
    return cands.filter((c) => c.inv === inv).sort((x, y) => Math.abs(mean(x.v) - center) - Math.abs(mean(y.v) - center))[0].v;
  }
  let best = cands[0];
  let bestCost = Infinity;
  for (const c of cands) {
    const drift = Math.abs(mean(c.v) - center);
    const cost = prev ? voiceDistance(c.v, prev) + 0.6 * Math.max(0, drift - 4) : drift + (c.inv ? 1.5 : 0);
    if (cost < bestCost - 1e-9) {
      best = c;
      bestCost = cost;
    }
  }
  return best.v;
}

export function applyVoicing(close: number[], chord: Chord, voicing: Voicing): number[] {
  const v = [...close].sort((a, b) => a - b);
  if (voicing === 'close' || v.length < 3) return v;
  const open = v.map((k, i) => (i % 2 === 1 ? k + 12 : k)).sort((a, b) => a - b);
  if (voicing === 'open') return open;
  let bass = open[0] - 12 + mod12(chord.root - (open[0] - 12));
  if (bass >= open[0]) bass -= 12;
  return [bass, ...open.filter((k) => mod12(k) !== chord.root || k > open[0])].sort((a, b) => a - b);
}

export interface NoteIn {
  tick: number;
  dur: number;
  key: number;
}

export interface ChordEvent {
  tick: number;
  end: number;
  keys: number[];
  root: number;
  tones: number[];
  name: string;
}

const TEMPLATES: Array<{ iv: number[]; w: number }> = [
  { iv: [0, 4, 7], w: 0 },
  { iv: [0, 3, 7], w: 0 },
  { iv: [0, 4, 7, 10], w: 0.05 },
  { iv: [0, 4, 7, 11], w: 0.05 },
  { iv: [0, 3, 7, 10], w: 0.05 },
  { iv: [0, 3, 6], w: 0.1 },
  { iv: [0, 3, 6, 10], w: 0.1 },
  { iv: [0, 4, 8], w: 0.15 },
  { iv: [0, 5, 7], w: 0.2 },
  { iv: [0, 2, 7], w: 0.25 },
  { iv: [0, 7], w: 0.3 },
];

export function identifyChord(keys: number[]): { root: number; tones: number[] } {
  const pcs = [...new Set(keys.map(mod12))];
  const bass = mod12(Math.min(...keys));
  let best = { root: bass, score: -Infinity };
  for (const r of pcs) {
    for (const t of TEMPLATES) {
      const set = new Set(t.iv.map((i) => (r + i) % 12));
      const hit = pcs.filter((p) => set.has(p)).length;
      const miss = t.iv.length - hit;
      const extra = pcs.length - hit;
      const score = hit * 2 - miss * 1.5 - extra * 0.5 - t.w + (r === bass ? 0.4 : 0);
      if (score > best.score) best = { root: r, score };
    }
  }
  const tones = [...new Set(pcs.map((p) => mod12(p - best.root)))].sort((a, b) => a - b);
  return { root: best.root, tones };
}

export function detectChords(channels: NoteIn[][], window = 20): ChordEvent[] {
  const raw: Array<{ tick: number; end: number; keys: number[] }> = [];
  for (const notes of channels) {
    const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.key - b.key);
    let group: NoteIn[] = [];
    const flush = (): void => {
      if (new Set(group.map((n) => mod12(n.key))).size >= 3) raw.push({ tick: group[0].tick, end: Math.max(...group.map((n) => n.tick + n.dur)), keys: group.map((n) => n.key) });
      group = [];
    };
    for (const n of sorted) {
      if (group.length && n.tick - group[0].tick > window) flush();
      group.push(n);
    }
    flush();
  }
  raw.sort((a, b) => a.tick - b.tick);
  const merged: Array<{ tick: number; end: number; keys: number[] }> = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.tick - last.tick <= window) {
      last.keys.push(...r.keys);
      last.end = Math.max(last.end, r.end);
    } else merged.push({ ...r, keys: [...r.keys] });
  }
  return merged.map((m, i) => {
    const keys = [...new Set(m.keys)].sort((a, b) => a - b);
    const { root, tones } = identifyChord(keys);
    const next = merged[i + 1]?.tick;
    return { tick: m.tick, end: next ?? Math.max(m.end, m.tick + 1), keys, root, tones, name: chordName(root, tones) };
  });
}

export function chordAt(events: ChordEvent[], tick: number): ChordEvent | null {
  if (!events.length) return null;
  let found = events[0];
  for (const e of events) {
    if (e.tick <= tick + 10) found = e;
    else break;
  }
  return found;
}

export function chordPcs(e: { root: number; tones: number[] }): number[] {
  return e.tones.map((t) => mod12(e.root + t));
}
