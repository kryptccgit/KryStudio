// ──────────────────────────────────────────────────────────────────────
// Reference library (Wave 3B, research/08 §4): user-supplied songs
// analysed into a local database, aggregated into style profiles the AI
// composes from, plus an originality check against the references.
//
// Rules: Krypt never downloads or ships songs. The library stores DERIVED
// features (and the source path + size/mtime), never audio; deep-analysis
// stems are temporary and deleted after transcription. Everything here is
// an estimate unless it says otherwise.
//
// Times: per-track data is stored in SECONDS (from the analyzer) and in
// BEATS relative to the track's first downbeat (beat-relative data is what
// profiles and originality compare, so tracks at different tempi line up).
// ──────────────────────────────────────────────────────────────────────

import type { AudioAnalysis, ChordQuality, DrumRole } from '../analyzer/protocol';

export type { ChordQuality };

export type TrackStatus =
  /** Queued for the light pass. */
  | 'pending'
  /** Light pass done (analysis + mix drum onsets + chords). */
  | 'light'
  /** Deep pass done too (stems → per-stem transcriptions). */
  | 'deep'
  | 'failed'
  /** The source file is gone or changed since analysis (re-queued when it comes back / changes). */
  | 'missing';

export interface Collection {
  id: string;
  name: string;
  tags: string[];
  createdAt: number;
  /** Folders added to it (rescanned on demand). */
  folders: string[];
  /** Deep analysis requested for this collection (stems + transcriptions; needs a stem model). */
  deep: boolean;
  counts: { total: number; pending: number; light: number; deep: number; failed: number; missing: number };
}

export interface LibraryTrack {
  id: string;
  collectionId: string;
  path: string;
  /** File name without extension. */
  name: string;
  size: number;
  mtime: number;
  status: TrackStatus;
  error?: string;
  durationSec?: number;
  bpm?: number | null;
  bpmConfidence?: number;
  /** parseKey-compatible, e.g. "F#m". */
  key?: string | null;
  keyConfidence?: number;
  swing?: number | null;
  lufs?: number;
  width?: number;
  addedAt: number;
  analyzedAt?: number;
  tags: string[];
}

/** A drum role's hits on a 32-step bar grid, summed over a track's bars. */
export interface DrumGrid {
  steps: 32;
  /** Bars the grid was measured over (bars with a confident downbeat). */
  bars: number;
  /** Per role: bars with a hit at each step (length 32). */
  counts: Partial<Record<DrumRole, number[]>>;
  /** Per role: summed velocity at each step (mean = vel / counts). */
  vel: Partial<Record<DrumRole, number[]>>;
  /** Runs of ≥ 3 consecutive 32nd hat hits ("rolls"), total over the track. */
  rolls: number;
  /** 'mix' = onsets on the full mix (light pass), 'stem' = drum stem (deep pass). */
  source: 'mix' | 'stem';
}

/** A note in beats from the track's first downbeat (tempo-independent). */
export interface BeatNote {
  beat: number;
  dur: number;
  key: number;
  vel: number;
}

/** A chord span from the analyzer, in beats from the first downbeat. */
export interface BeatChord {
  beat: number;
  dur: number;
  /** Pitch class 0..11 (C = 0). */
  root: number;
  quality: ChordQuality;
}

/** Everything the library keeps about one analysed track (besides LibraryTrack). */
export interface TrackFeatures {
  analysis: AudioAnalysis;
  drums: DrumGrid | null;
  chords: BeatChord[];
  /** Deep pass: transcribed lines per stem ('bass', 'vocals', 'other' …) in beats. */
  lines: Partial<Record<string, BeatNote[]>>;
  /** Similarity feature vector (see shared/library/similarity.ts FEATURE_NAMES). */
  vector: number[];
}

export interface TrackDetail extends LibraryTrack {
  features: TrackFeatures | null;
}

export interface TrackQuery {
  collectionId?: string;
  /** Matches name / path / tags (case-insensitive substring). */
  text?: string;
  bpmMin?: number;
  bpmMax?: number;
  /** Exact key ("F#m") or a mode ("minor" / "major"). */
  key?: string;
  status?: TrackStatus;
  sort?: 'name' | 'bpm' | 'key' | 'added' | 'lufs' | 'duration';
  desc?: boolean;
  offset?: number;
  /** Default 200, max 1000. */
  limit?: number;
}

export interface Percentiles {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

/**
 * A collection's style, aggregated from its tracks' features (no training).
 * Sections are null when too few tracks have the data (e.g. bass needs the
 * deep pass). `caveats` says what is estimated or thin.
 */
export interface StyleProfile {
  collectionId: string;
  name: string;
  tracks: number;
  analysed: number;
  deep: number;
  updatedAt: number;
  tempo: {
    bpm: Percentiles;
    /** 4-bpm bins. */
    histogram: Array<{ bpm: number; count: number }>;
    /** Share of tracks whose detection is ambiguous between half and double time. */
    halfTimeShare: number;
  } | null;
  swing: { median: number; share: number } | null;
  keys: { top: Array<{ key: string; count: number }>; minorShare: number } | null;
  drums: {
    /** Per role: probability (0..1) of a hit at each of 32 steps per bar, and mean velocity. */
    roles: Partial<Record<DrumRole, { prob: number[]; vel: number[] }>>;
    rollsPerBar: number;
    tracks: number;
    source: 'mix' | 'stem' | 'mixed';
  } | null;
  bass: {
    /** Note length in beats. */
    length: Percentiles;
    /** Share of notes per interval from the key root (0..11 semitones). */
    degrees: number[];
    /** Share of bass onsets within a 32nd of a kick. */
    kickAlign: number;
    /** Share of notes that slide into the next (gap < a 32nd and pitch change). */
    glide: number;
    tracks: number;
  } | null;
  harmony: {
    /** Most common chord-degree progressions ("i VI III VII"), relative to each track's key. */
    progressions: Array<{ degrees: string[]; count: number }>;
    /** Chord changes per bar. */
    changesPerBar: number;
    tracks: number;
  } | null;
  structure: {
    sectionBars: Percentiles;
    /** Most common section label sequences, e.g. ["A","B","A","B","C","B"]. */
    forms: Array<{ form: string[]; count: number }>;
    /** Median energy (LUFS) at 16 points across a track, normalised to 0..1. */
    energyShape: number[];
    lengthSec: Percentiles;
  } | null;
  mix: {
    lufs: Percentiles;
    truePeakDb: Percentiles;
    width: Percentiles;
    /** Median band level relative to the track's loudest band, dB. */
    bands: Record<'sub' | 'low' | 'lowMid' | 'mid' | 'highMid' | 'high', number>;
  } | null;
  /** Patterns sampled from the probabilities (deterministic seed), as KPN, never copied from one track. */
  examples: { drums: string | null; bass: string | null };
  caveats: string[];
}

/** A melodic line from the project, for the originality check. */
export interface ProjectLine {
  /** e.g. 'Pattern "Hook" · Bell Lead'. */
  label: string;
  patternId: string;
  channelId: string;
  /** Ticks at PPQ 960 (shared/schema/time.ts). */
  notes: Array<{ tick: number; dur: number; key: number }>;
  /** Ticks per bar of the project (for OriginalityMatch.atBar). Absent = 4/4 (3840). Set by projectLines(). */
  barTicks?: number;
}

export interface OriginalityMatch {
  line: string;
  patternId: string;
  channelId: string;
  trackId: string;
  trackName: string;
  stem: string;
  /** Consecutive matching notes (transposition-invariant pitch + rhythm). */
  notes: number;
  /** Where in the project line (bar, 1-based) and in the reference (seconds). */
  atBar: number;
  refAtSec: number;
  /** 0..1 rhythm + pitch agreement over the matched run. */
  similarity: number;
}

export interface OriginalityReport {
  checkedLines: number;
  /** Deep-analysed reference tracks compared against (only those have transcribed lines). */
  references: number;
  matches: OriginalityMatch[];
  /** Plain-language summary, incl. "this is a production aid, not legal advice". */
  summary: string;
}

/** The style the AI composes from (set by the user; agents read it). */
export interface LibraryFocus {
  collectionId: string;
  name: string;
  /** The user's own words, e.g. "dark, sparse, lots of space". */
  brief: string;
}

export interface LibraryQueueState {
  running: boolean;
  paused: boolean;
  phase: 'light' | 'deep' | null;
  done: number;
  total: number;
  /** File being analysed. */
  current: string | null;
  etaSec: number | null;
  /** Why queued work isn't moving (analyzer missing, waiting for a stem model, library unavailable). */
  message?: string;
}

export interface LibraryState {
  collections: Collection[];
  queue: LibraryQueueState;
  focus: LibraryFocus | null;
  dbPath: string;
}
