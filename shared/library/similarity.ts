import type { AudioAnalysis } from '../analyzer/protocol';
import { parseKey } from '../music/theory';
import type { DrumGrid } from './types';
import { DRUM_ROLES, GRID_STEPS } from './grid';
import { isNum, round } from './stats';

interface Dim {
  name: string;
  scale: number;
  weight: number;
}

export const FEATURE_DIMS: readonly Dim[] = [
  { name: 'tempo.fold.sin', scale: 0.5, weight: 1 },
  { name: 'tempo.fold.cos', scale: 0.5, weight: 1 },
  { name: 'tempo.log2', scale: 0.3, weight: 0.5 },
  { name: 'key.fifths.sin', scale: 0.8, weight: 0.5 },
  { name: 'key.fifths.cos', scale: 0.8, weight: 0.5 },
  { name: 'key.minor', scale: 1, weight: 0.5 },
  { name: 'swing', scale: 0.15, weight: 0.5 },
  { name: 'lufs', scale: 3, weight: 1 },
  { name: 'crest.db', scale: 3, weight: 0.75 },
  { name: 'lra', scale: 3, weight: 0.5 },
  { name: 'width', scale: 0.15, weight: 0.75 },
  { name: 'correlation', scale: 0.25, weight: 0.5 },
  { name: 'band.sub', scale: 4, weight: 0.5 },
  { name: 'band.low', scale: 4, weight: 0.5 },
  { name: 'band.lowMid', scale: 4, weight: 0.5 },
  { name: 'band.mid', scale: 4, weight: 0.5 },
  { name: 'band.highMid', scale: 4, weight: 0.5 },
  { name: 'band.high', scale: 4, weight: 0.5 },
  { name: 'centroid.log2', scale: 0.5, weight: 0.75 },
  { name: 'onset.rate', scale: 1.5, weight: 1 },
  { name: 'energy.std', scale: 2, weight: 0.5 },
  { name: 'drums.kick', scale: 1.5, weight: 0.75 },
  { name: 'drums.snare', scale: 1, weight: 0.75 },
  { name: 'drums.hat', scale: 4, weight: 0.75 },
  { name: 'drums.openhat', scale: 1, weight: 0.5 },
  { name: 'drums.perc', scale: 1.5, weight: 0.5 },
  { name: 'drums.rolls', scale: 0.3, weight: 0.5 },
  { name: 'drums.halftime', scale: 0.5, weight: 0.5 },
];

export const FEATURE_NAMES: readonly string[] = FEATURE_DIMS.map((d) => d.name);
export const VECTOR_VERSION = 1;

const TOTAL_WEIGHT = FEATURE_DIMS.reduce((s, d) => s + d.weight, 0);
const BANDS = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'] as const;

function num(x: number | null | undefined): number {
  return isNum(x) ? x : NaN;
}

function std(values: readonly number[]): number {
  const v = values.filter((x) => isNum(x) && x > -70);
  if (v.length < 4) return NaN;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / v.length);
}

export function featureVector(analysis: AudioAnalysis, drums: DrumGrid | null): number[] {
  const out: number[] = [];
  const push = (x: number) => out.push(isNum(x) ? round(x, 4) : NaN);

  const bpm = analysis.tempo?.bpm;
  if (isNum(bpm) && bpm > 0) {
    const phase = Math.log2(bpm / 70) - Math.floor(Math.log2(bpm / 70));
    push(Math.sin(2 * Math.PI * phase));
    push(Math.cos(2 * Math.PI * phase));
    push(Math.log2(bpm));
  } else {
    push(NaN);
    push(NaN);
    push(NaN);
  }

  const key = analysis.key ? parseKey(analysis.key.name) ?? parseKey(`${analysis.key.tonic}${analysis.key.mode === 'minor' ? 'm' : ''}`) : null;
  if (key) {
    const minor = analysis.key?.mode === 'minor' || key.scale === 'minor';
    const relMajor = (key.root + (minor ? 3 : 0)) % 12;
    const fifths = (relMajor * 7) % 12;
    push(Math.sin((2 * Math.PI * fifths) / 12));
    push(Math.cos((2 * Math.PI * fifths) / 12));
    push(minor ? 1 : 0);
  } else {
    push(NaN);
    push(NaN);
    push(NaN);
  }

  push(num(analysis.swing));
  const lv = analysis.levels;
  push(lv && isNum(lv.lufsIntegrated) && lv.lufsIntegrated > -70 ? lv.lufsIntegrated : NaN);
  push(num(lv?.crestDb));
  push(num(lv?.loudnessRange));
  push(num(analysis.stereo?.width ?? lv?.stereoWidth));
  push(num(analysis.stereo?.correlation ?? lv?.stereoCorrelation));
  const bands = lv?.bands;
  const bandVals = BANDS.map((b) => num(bands?.[b]));
  const bandMean = bandVals.every(isNum) ? bandVals.reduce((s, x) => s + x, 0) / bandVals.length : NaN;
  for (const v of bandVals) push(v - bandMean);
  push(lv && isNum(lv.spectralCentroidHz) && lv.spectralCentroidHz > 0 ? Math.log2(lv.spectralCentroidHz) : NaN);
  push(num(analysis.onsetRate));
  push(std(analysis.energy?.lufs ?? []));

  const usable = drums && drums.bars >= 2 ? drums : null;
  for (const role of DRUM_ROLES) {
    if (!usable) push(NaN);
    else {
      const c = usable.counts[role];
      push(c ? c.reduce((s, x) => s + x, 0) / usable.bars : 0);
    }
  }
  push(usable ? usable.rolls / usable.bars : NaN);
  const sn = usable?.counts.snare;
  if (sn && sn.length === GRID_STEPS) {
    const three = sn[16];
    const twoFour = (sn[8] + sn[24]) / 2;
    push(three + twoFour > 0 ? three / (three + twoFour) : NaN);
  } else push(NaN);

  return out;
}

export function similarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length, FEATURE_DIMS.length);
  let num2 = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!isNum(x) || !isNum(y)) continue;
    const d = FEATURE_DIMS[i];
    const z = (x - y) / d.scale;
    num2 += d.weight * z * z;
    wsum += d.weight;
  }
  if (wsum <= 0) return 0;
  const sim = 1 / (1 + num2 / wsum);
  const coverage = Math.min(1, wsum / (0.5 * TOTAL_WEIGHT));
  return round(sim * coverage, 4);
}

export function nearest(target: number[], items: Array<{ id: string; vector: number[] }>, k: number): Array<{ id: string; score: number }> {
  if (!(k > 0)) return [];
  const scored: Array<{ id: string; score: number }> = [];
  for (const it of items) {
    if (!it || !Array.isArray(it.vector)) continue;
    const s = similarity(target, it.vector);
    if (isNum(s)) scored.push({ id: it.id, score: s });
  }
  scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return scored.slice(0, Math.floor(k));
}
