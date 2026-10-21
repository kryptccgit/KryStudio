import type { InstrumentRole } from '../sounds/types';
import type { MatchTarget, SoundFingerprint } from './types';

export const BAND_KEYS = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'] as const;
export type BandKey = (typeof BAND_KEYS)[number];

export const FEATURE_KEYS = [
  'centroid',
  'rolloff',
  'flatness',
  'harmonicity',
  'f0',
  'attack',
  'decay',
  'sustain',
  ...BAND_KEYS,
  'crest',
  'width',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type MatchProfile = 'kick' | 'snare' | 'hat' | 'perc' | 'bass' | 'chord' | 'lead' | 'fx';

export type FeatureWeights = Partial<Record<FeatureKey, number>>;

export const PROFILES: Record<MatchProfile, FeatureWeights> = {
  kick: { sub: 3, low: 2, decay: 2, f0: 1.5, highMid: 1.5, crest: 1, centroid: 1, attack: 0.5, flatness: 0.5, lowMid: 0.5 },
  snare: { centroid: 2.5, flatness: 2, decay: 2, mid: 1.5, highMid: 1.5, low: 1, rolloff: 1, crest: 0.5, attack: 0.5, harmonicity: 0.5, high: 0.5 },
  hat: { centroid: 2.5, rolloff: 2, decay: 2.5, flatness: 1, high: 1, highMid: 1, crest: 0.5, mid: 0.5 },
  perc: { centroid: 2, decay: 2, harmonicity: 1, f0: 1, flatness: 1, mid: 1, highMid: 1, low: 0.5, attack: 0.5 },
  bass: { sub: 2, low: 2, lowMid: 1.5, harmonicity: 1.5, flatness: 1.5, sustain: 1.5, f0: 0.75, centroid: 1, decay: 1, attack: 0.5, mid: 0.5 },
  chord: { centroid: 2, attack: 2, sustain: 2, width: 1.5, decay: 1, rolloff: 1, flatness: 0.5, lowMid: 0.5, mid: 0.5, highMid: 0.5, high: 0.5 },
  lead: { centroid: 2, attack: 1.5, harmonicity: 1.5, width: 1, decay: 1, sustain: 1, flatness: 1, rolloff: 0.5, mid: 0.5, highMid: 0.5, f0: 0.5 },
  fx: { centroid: 1.5, flatness: 1.5, width: 1, sustain: 1, decay: 1, rolloff: 1, attack: 0.5 },
};

const DRUM_PROFILE: Partial<Record<InstrumentRole, MatchProfile>> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'snare',
  hat: 'hat',
  openhat: 'hat',
  ride: 'hat',
  crash: 'hat',
  perc: 'perc',
  tom: 'perc',
};

const INSTRUMENT_PROFILE: Partial<Record<InstrumentRole, MatchProfile>> = {
  bass: 'bass',
  '808': 'bass',
  sub: 'bass',
  chord: 'chord',
  stab: 'chord',
  pad: 'chord',
  keys: 'chord',
  piano: 'chord',
  strings: 'chord',
  brass: 'chord',
  lead: 'lead',
  pluck: 'lead',
  arp: 'lead',
  bell: 'lead',
  vox: 'lead',
  fx: 'fx',
  texture: 'fx',
};

export function isDrumTarget(t: MatchTarget): boolean {
  return t.kind === 'drum' || DRUM_PROFILE[t.role] !== undefined;
}

export function profileFor(t: MatchTarget): MatchProfile {
  return DRUM_PROFILE[t.role] ?? INSTRUMENT_PROFILE[t.role] ?? 'lead';
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function median(xs: readonly number[]): number {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function usableFingerprint(fp: SoundFingerprint | null | undefined): fp is SoundFingerprint {
  if (!fp || typeof fp !== 'object') return false;
  const nums = [fp.lengthSec, fp.centroidHz, fp.rolloffHz, fp.flatness, fp.harmonicity, fp.attackMs, fp.decayMs, fp.sustain, fp.crestDb, fp.width, fp.peakDb, fp.rmsDb];
  if (!nums.every(finite)) return false;
  if (!fp.bands || !BAND_KEYS.every((k) => finite(fp.bands[k]))) return false;
  if (fp.f0Hz !== null && !(finite(fp.f0Hz) && fp.f0Hz > 0)) return false;
  return fp.lengthSec > 0 && fp.centroidHz > 0 && fp.rmsDb > -90;
}

export function aggregateFingerprints(fps: ReadonlyArray<SoundFingerprint | null | undefined>): SoundFingerprint | null {
  const ok = fps.filter(usableFingerprint);
  if (!ok.length) return null;
  if (ok.length === 1) return { ...ok[0], bands: { ...ok[0].bands } };
  const m = (f: (x: SoundFingerprint) => number) => median(ok.map(f));
  const pitched = ok.map((x) => x.f0Hz).filter((x): x is number => finite(x) && x > 0);
  const f0 = pitched.length * 2 >= ok.length ? 2 ** median(pitched.map(Math.log2)) : null;
  return {
    lengthSec: m((x) => x.lengthSec),
    centroidHz: m((x) => x.centroidHz),
    rolloffHz: m((x) => x.rolloffHz),
    flatness: m((x) => x.flatness),
    harmonicity: m((x) => x.harmonicity),
    f0Hz: f0,
    attackMs: m((x) => x.attackMs),
    decayMs: m((x) => x.decayMs),
    sustain: m((x) => x.sustain),
    bands: Object.fromEntries(BAND_KEYS.map((k) => [k, m((x) => x.bands[k])])) as SoundFingerprint['bands'],
    crestDb: m((x) => x.crestDb),
    width: m((x) => x.width),
    peakDb: m((x) => x.peakDb),
    rmsDb: m((x) => x.rmsDb),
  };
}

const log2 = Math.log2;
const BAND_FLOOR = -60;
const band = (x: number) => Math.max(BAND_FLOOR, Math.min(0, x));

export function semitones(from: number, to: number): number {
  return 12 * log2(to / from);
}

export function featureDelta(key: FeatureKey, target: SoundFingerprint, cand: SoundFingerprint, opts: { drum?: boolean; relCentroid?: boolean } = {}): number {
  switch (key) {
    case 'centroid': {
      const abs = log2(cand.centroidHz / target.centroidHz);
      if (opts.relCentroid && target.f0Hz && cand.f0Hz) {
        const rel = log2(cand.centroidHz / cand.f0Hz / (target.centroidHz / target.f0Hz));
        return 0.5 * abs + 0.5 * rel;
      }
      return abs;
    }
    case 'rolloff':
      return log2(cand.rolloffHz / target.rolloffHz) / 1.25;
    case 'flatness':
      return (cand.flatness - target.flatness) / 0.2;
    case 'harmonicity':
      return (cand.harmonicity - target.harmonicity) / 0.25;
    case 'f0': {
      if (!target.f0Hz && !cand.f0Hz) return 0;
      if (!target.f0Hz || !cand.f0Hz) return 1;
      return semitones(target.f0Hz, cand.f0Hz) / (opts.drum ? 6 : 12);
    }
    case 'attack':
      return log2((cand.attackMs + 2) / (target.attackMs + 2)) / 1.5;
    case 'decay':
      return log2((cand.decayMs + 10) / (target.decayMs + 10));
    case 'sustain':
      return (cand.sustain - target.sustain) / 0.25;
    case 'crest':
      return (cand.crestDb - target.crestDb) / 4;
    case 'width':
      return (cand.width - target.width) / 0.25;
    default:
      return (band(cand.bands[key]) - band(target.bands[key])) / 9;
  }
}

export const DELTA_CAP = 3;

export interface Comparison {
  similarity: number;
  distance: number;
  deltas: Partial<Record<FeatureKey, number>>;
}

export function compareFingerprints(target: SoundFingerprint, cand: SoundFingerprint, weights: FeatureWeights, opts: { drum?: boolean; relCentroid?: boolean } = {}): Comparison {
  let sum = 0;
  let wsum = 0;
  const deltas: Partial<Record<FeatureKey, number>> = {};
  for (const key of FEATURE_KEYS) {
    const w = weights[key] ?? 0;
    if (!(w > 0)) continue;
    let z = featureDelta(key, target, cand, opts);
    if (!Number.isFinite(z)) z = DELTA_CAP;
    z = Math.max(-DELTA_CAP, Math.min(DELTA_CAP, z));
    deltas[key] = z;
    sum += w * z * z;
    wsum += w;
  }
  const distance = wsum > 0 ? Math.sqrt(sum / wsum) : 0;
  return { similarity: Math.exp(-(distance * distance) / 2), distance, deltas };
}
