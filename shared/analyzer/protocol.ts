// ──────────────────────────────────────────────────────────────────────
// Electron main ⇄ krypt-studio-analyzer.exe (on-device audio ML sidecar).
// NDJSON over stdio, one JSON object per line. Full contract:
// docs/ANALYZER_PROTOCOL.md. Mirror every change in
// engine/crates/analyzer/src/protocol.rs.
//
// Requests are jobs: each gets exactly one response line with the same id
// ({id, ok, data} or {id, ok:false, message}); long jobs stream
// {event:'progress', id, ...} lines before it. Times are SECONDS (the
// analyzer knows nothing about ticks or the project); main converts.
// ──────────────────────────────────────────────────────────────────────

import type { Analysis } from '../engine/protocol';

export type AnalyzerDevice = 'cpu' | 'directml';

export type StemName = 'drums' | 'bass' | 'vocals' | 'other' | 'guitar' | 'piano';

export type TranscribeMode = 'poly' | 'mono' | 'drums';

export type DrumRole = 'kick' | 'snare' | 'hat' | 'openhat' | 'perc';

/** 'sus' = sus4 or sus2 (root from the bass); '5' = bare fifth (power chord). Extended chords read as their closest 7th. */
export type ChordQuality = 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'dim' | 'sus' | '5';

export interface ChordSpan {
  startSec: number;
  endSec: number;
  /** Pitch class of the root, 0..11 (C = 0). */
  root: number;
  quality: ChordQuality;
  /** 0..1 */
  confidence: number;
}

// ── Requests (main → analyzer) ────────────────────────────────────────

export interface AnalyzeArgs {
  path: string;
  /** Section segmentation (self-similarity; slower on long files). Default true. */
  sections?: boolean;
  /**
   * Directory of the beat model (bundled 'beat-this-small'); absent = DSP-only beat tracking.
   * The model adds ~2 s per minute of audio (DSP-only: ~0.35 s per minute), so a bulk
   * library pass may leave it out. If the model can't load, analysis falls back to DSP
   * with a `log` warning and a note in `sources`.
   */
  beatModelDir?: string;
  /** Also return drum hits (roles) from the same decode, as `transcribe` mode 'drums' would (Wave 3B library pass). Default false. */
  drums?: boolean;
}

export interface SeparateArgs {
  path: string;
  /** Model id from shared/analyzer/models.ts (e.g. 'htdemucs'). */
  model: string;
  /** Directory holding the model's files (main verified them). */
  modelDir: string;
  /** Where to write <stem>.wav (32-bit float, source sample rate). Created if missing. */
  outDir: string;
  /** 'auto' = DirectML when available, else CPU. */
  device?: AnalyzerDevice | 'auto';
}

export interface TranscribeArgs {
  path: string;
  mode: TranscribeMode;
  /** poly: directory of the Basic Pitch model (bundled 'basic-pitch'). */
  modelDir?: string;
  /**
   * 0..1, higher = fewer notes. Defaults: poly 0.5 (Basic Pitch onset), mono 0.5 (re-attack
   * sensitivity), drums 0.3 (hit sensitivity).
   */
  onsetThreshold?: number;
  /** 0..1, higher = fewer notes. Defaults: poly 0.3 (Basic Pitch frame), mono 0.3 (voicing). Drums: unused. */
  frameThreshold?: number;
  /** Notes shorter than this are dropped. Default 60 ms (drums: n/a). */
  minNoteMs?: number;
  /** Restrict the pitch range (MIDI, inclusive). Notes outside are dropped, never octave-folded. */
  minKey?: number;
  maxKey?: number;
}

/**
 * Wave 8a (research/15): timbre features of an audio file, or of segments of it (e.g. the drum stem around each
 * kick hit, a bass note, a chord). The result type is SoundFingerprint in shared/sound-match/types.ts; one per
 * segment, plus `whole` for the whole file when no segments are given.
 */
export interface FingerprintArgs {
  path: string;
  /** Segments to measure separately (seconds). Absent → the whole file (trailing silence trimmed). */
  segments?: Array<{ startSec: number; endSec: number }>;
  /** Also estimate the fundamental (tonal sounds: bass, leads, 808s). Default true. */
  pitch?: boolean;
  /**
   * High-pass the audio at this frequency (Hz, 4th-order Butterworth) before measuring: hats / snares read from a
   * drum stem where the kick's tail rings under them (drumHighpassHz in shared/sound-match/segments.ts).
   */
  highpassHz?: number;
}

/**
 * Krypt Voice (research/21): Kokoro-82M text → speech. `phonemes` = Kokoro's phoneme string (G2P runs in the
 * analyzer when absent, English only). `voice` = a Kokoro voice id (e.g. "af_heart"). Writes a mono 24 kHz WAV.
 */
export interface TtsArgs {
  text: string;
  phonemes?: string;
  voice: string;
  /** 0.5..2, default 1. */
  speed?: number;
  /** Absolute output path (.wav). */
  out: string;
  /** The installed Kokoro model directory (Model Manager). */
  modelDir: string;
}

export interface TtsResult {
  path: string;
  durationSec: number;
  sampleRate: number;
  /** Per-word timing when the model exposes durations (else empty): seconds in the output. */
  words: Array<{ text: string; startSec: number; endSec: number }>;
  phonemes: string;
}

/**
 * "Sing my notes": render speech onto a melody. Each segment takes [srcStartSec, srcEndSec) of `path`,
 * stretches it to `durSec` starting at `outStartSec` and pitches it so its median f0 lands on `midi`
 * (formants kept), with glides / vibrato and short crossfades. Writes `out` (mono, the source rate).
 */
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
  /** Per segment: the f0 it measured (Hz, null = unvoiced) and the shift applied (semitones). */
  segments: Array<{ f0Hz: number | null; shiftSt: number }>;
}

/** Find syllable nuclei in speech (energy / voicing peaks), for mapping lyrics onto notes. */
export interface SyllablesArgs {
  path: string;
  /** Expected count (from the lyrics): the detector aims for it. */
  expected?: number;
}

export interface SyllablesResult {
  syllables: Array<{ startSec: number; endSec: number; voiced: boolean }>;
}

/** Decode any audio file and write it as a WAV (32-bit float, own rate, mono/stereo) at `out`. */
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
  /** Cancel a running job; the job answers {ok:false, cancelled:true}. */
  | { id: number; cmd: 'cancel'; args: { target: number } }
  | { id: number; cmd: 'shutdown' };

// ── Responses / events (analyzer → main) ──────────────────────────────

export interface HelloResult {
  version: string;
  /** Inference devices that initialised ('cpu' always). */
  devices: AnalyzerDevice[];
}

export type AnalyzerResponse =
  | { id: number; ok: true; data?: unknown }
  | { id: number; ok: false; message: string; cancelled?: boolean };

export type AnalyzerEvent =
  /** fraction 0..1, or -1 when indeterminate. stage is a short human word ("decoding", "separating"). */
  | { event: 'progress'; id: number; stage: string; fraction: number }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type AnalyzerMessage = AnalyzerResponse | AnalyzerEvent;

// ── Results ───────────────────────────────────────────────────────────

/** `analyze`: what Krypt "hears" in an audio file. Estimates are listed in `estimated`. */
export interface AudioAnalysis {
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** null when no stable pulse was found (ambient, speech). */
  tempo: { bpm: number; confidence: number; /** Other plausible readings (half/double time). */ alternatives: number[] } | null;
  beats: {
    /** Beat times (s). */
    times: number[];
    /** Downbeat times (s), subset of `times`. */
    downbeats: number[];
    /** Beats per bar inferred from the downbeats (usually 4). */
    beatsPerBar: number;
  } | null;
  key: { tonic: string; mode: 'major' | 'minor'; /** 'F#m', 'Eb' — parseKey-compatible. */ name: string; confidence: number } | null;
  /**
   * 16th-note swing on the transport scale (docs/ENGINE_PROTOCOL.md): odd 16ths sit
   * `swing × half a 16th` late, so 0 = straight, ≈0.67 = triplet feel, 1 = maximum.
   * null when the off-beat 16ths carry no onsets (nothing to measure) or there is no beat.
   */
  swing: number | null;
  /** Repeated-material segmentation: same label = similar content. */
  sections: Array<{ startSec: number; endSec: number; label: string; /** Short-term loudness (LUFS) of the section. */ lufs: number }>;
  /** The engine's render analysis (loudness, peaks, bands). */
  levels: Analysis;
  stereo: { /** 0 mono .. 1 very wide (side/mid energy ratio, clamped). */ width: number; /** -1..1 L/R correlation. */ correlation: number };
  /** Short-term loudness curve for energy/arrangement reading: lufs[i] is the 3 s loudness centred on i × hopSec (hopSec 0.5). */
  energy: { hopSec: number; lufs: number[] };
  /** Detected onsets per second. */
  onsetRate: number;
  /** Chord estimates over time (template matching on beat-synchronous chroma); empty when atonal. Absent in analyses cached before Wave 3B. */
  chords?: ChordSpan[];
  /**
   * Share of the harmonic (chroma) energy per pitch class, C..B, summing to 1: what notes the file plays, for comparing
   * two files' harmony directly (Auto Mashup's key fit). Absent when silent, and in analyses cached before it existed.
   */
  pitchProfile?: number[];
  /** Only when AnalyzeArgs.drums: drum hits on the whole file (same algorithm as transcribe 'drums'). */
  drumHits?: DrumHit[];
  /** Field names whose values are estimates (heuristic or ML), e.g. ['tempo','beats','key','chords','swing','sections','drumHits']. */
  estimated: string[];
  /** Algorithms / models that produced this, e.g. ['stratum-dsp 1.0', 'beat-this small']. */
  sources: string[];
}

/** `separate`: stem WAVs written to outDir. */
export interface StemsResult {
  model: string;
  device: AnalyzerDevice;
  seconds: number;
  stems: Array<{ name: StemName; path: string; peakDb: number; rmsDb: number }>;
}

export interface TranscribedNote {
  startSec: number;
  durSec: number;
  /** MIDI key 0..127. */
  key: number;
  /** 0..1 */
  vel: number;
  /** Mean deviation from the key's pitch in cents (-50..50), when known. */
  cents?: number;
}

export interface DrumHit {
  timeSec: number;
  role: DrumRole;
  /** 0..1 */
  vel: number;
}

/** `transcribe`: notes (poly/mono) or drum hits (drums). */
export interface TranscriptionResult {
  mode: TranscribeMode;
  notes: TranscribedNote[];
  hits: DrumHit[];
  /** Algorithm/model used, e.g. 'basic-pitch', 'pyin', 'onsets'. */
  source: string;
}
