import type { Analysis } from '../engine/protocol';

export type AnalyzerDevice = 'cpu' | 'directml';

export type StemName = 'drums' | 'bass' | 'vocals' | 'other' | 'guitar' | 'piano';

export type TranscribeMode = 'poly' | 'mono' | 'drums';

export type DrumRole = 'kick' | 'snare' | 'hat' | 'openhat' | 'perc';

export type ChordQuality = 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'dim' | 'sus' | '5';

export interface ChordSpan {
  startSec: number;
  endSec: number;
  root: number;
  quality: ChordQuality;
  confidence: number;
}

export interface AnalyzeArgs {
  path: string;
  sections?: boolean;
  beatModelDir?: string;
  drums?: boolean;
}

export interface SeparateArgs {
  path: string;
  model: string;
  modelDir: string;
  outDir: string;
  device?: AnalyzerDevice | 'auto';
}

export interface TranscribeArgs {
  path: string;
  mode: TranscribeMode;
  modelDir?: string;
  onsetThreshold?: number;
  frameThreshold?: number;
  minNoteMs?: number;
  minKey?: number;
  maxKey?: number;
}

export interface FingerprintArgs {
  path: string;
  segments?: Array<{ startSec: number; endSec: number }>;
  pitch?: boolean;
  highpassHz?: number;
}

export interface TtsArgs {
  text: string;
  phonemes?: string;
  voice: string;
  speed?: number;
  out: string;
  modelDir: string;
}

export interface TtsResult {
  path: string;
  durationSec: number;
  sampleRate: number;
  words: Array<{ text: string; startSec: number; endSec: number }>;
  phonemes: string;
}

export interface SingArgs {
  path: string;
  out: string;
  segments: Array<{ srcStartSec: number; srcEndSec: number; outStartSec: number; durSec: number; midi: number }>;
  vibrato?: number;
  glideMs?: number;
}

export interface SingResult {
  path: string;
  durationSec: number;
  segments: Array<{ f0Hz: number | null; shiftSt: number }>;
}

export interface SyllablesArgs {
  path: string;
  expected?: number;
}

export interface SyllablesResult {
  syllables: Array<{ startSec: number; endSec: number; voiced: boolean }>;
}

export interface ExtractArgs {
  path: string;
  out: string;
}

export interface ExtractResult {
  path: string;
  frames: number;
  sampleRate: number;
  channels: number;
}

export type AnalyzerRequest =
  | { id: number; cmd: 'hello' }
  | { id: number; cmd: 'analyze'; args: AnalyzeArgs }
  | { id: number; cmd: 'separate'; args: SeparateArgs }
  | { id: number; cmd: 'transcribe'; args: TranscribeArgs }
  | { id: number; cmd: 'fingerprint'; args: FingerprintArgs }
  | { id: number; cmd: 'tts'; args: TtsArgs }
  | { id: number; cmd: 'sing'; args: SingArgs }
  | { id: number; cmd: 'syllables'; args: SyllablesArgs }
  | { id: number; cmd: 'extract'; args: ExtractArgs }
  | { id: number; cmd: 'cancel'; args: { target: number } }
  | { id: number; cmd: 'shutdown' };

export interface HelloResult {
  version: string;
  devices: AnalyzerDevice[];
}

export type AnalyzerResponse =
  | { id: number; ok: true; data?: unknown }
  | { id: number; ok: false; message: string; cancelled?: boolean };

export type AnalyzerEvent =
  | { event: 'progress'; id: number; stage: string; fraction: number }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type AnalyzerMessage = AnalyzerResponse | AnalyzerEvent;

export interface AudioAnalysis {
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  tempo: { bpm: number; confidence: number; alternatives: number[] } | null;
  beats: {
    times: number[];
    downbeats: number[];
    beatsPerBar: number;
  } | null;
  key: { tonic: string; mode: 'major' | 'minor'; name: string; confidence: number } | null;
  swing: number | null;
  sections: Array<{ startSec: number; endSec: number; label: string; lufs: number }>;
  levels: Analysis;
  stereo: { width: number; correlation: number };
  energy: { hopSec: number; lufs: number[] };
  onsetRate: number;
  chords?: ChordSpan[];
  pitchProfile?: number[];
  drumHits?: DrumHit[];
  estimated: string[];
  sources: string[];
}

export interface StemsResult {
  model: string;
  device: AnalyzerDevice;
  seconds: number;
  stems: Array<{ name: StemName; path: string; peakDb: number; rmsDb: number }>;
}

export interface TranscribedNote {
  startSec: number;
  durSec: number;
  key: number;
  vel: number;
  cents?: number;
}

export interface DrumHit {
  timeSec: number;
  role: DrumRole;
  vel: number;
}

export interface TranscriptionResult {
  mode: TranscribeMode;
  notes: TranscribedNote[];
  hits: DrumHit[];
  source: string;
}
