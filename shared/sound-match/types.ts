import type { InstrumentRole, SampleKind } from '../sounds/types';

export interface SoundFingerprint {
  lengthSec: number;
  centroidHz: number;
  rolloffHz: number;
  flatness: number;
  harmonicity: number;
  f0Hz: number | null;
  attackMs: number;
  decayMs: number;
  sustain: number;
  bands: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  crestDb: number;
  width: number;
  peakDb: number;
  rmsDb: number;
}

export type FingerprintSource =
  | { kind: 'preset'; id: string; role: InstrumentRole; note: number }
  | { kind: 'sample'; path: string; sampleKind: SampleKind };

export interface FingerprintEntry {
  source: FingerprintSource;
  fp: SoundFingerprint;
}

export interface FingerprintIndex {
  version: 1;
  generator: string;
  entries: FingerprintEntry[];
}

export type MatchTarget =
  | { kind: 'drum'; role: 'kick' | 'snare' | 'clap' | 'hat' | 'openhat' | 'perc' }
  | { kind: 'instrument'; role: InstrumentRole };

export interface SoundMatch {
  source: FingerprintSource;
  similarity: number;
  why: string[];
  tweaks: Record<string, number>;
}
