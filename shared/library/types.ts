import type { AudioAnalysis, ChordQuality, DrumRole } from '../analyzer/protocol';

export type { ChordQuality };

export type TrackStatus =
  | 'pending'
  | 'light'
  | 'deep'
  | 'failed'
  | 'missing';

export interface Collection {
  id: string;
  name: string;
  tags: string[];
  createdAt: number;
  folders: string[];
  deep: boolean;
  counts: { total: number; pending: number; light: number; deep: number; failed: number; missing: number };
}

export interface LibraryTrack {
  id: string;
  collectionId: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  status: TrackStatus;
  error?: string;
  durationSec?: number;
  bpm?: number | null;
  bpmConfidence?: number;
  key?: string | null;
  keyConfidence?: number;
  swing?: number | null;
  lufs?: number;
  width?: number;
  addedAt: number;
  analyzedAt?: number;
  tags: string[];
}

export interface DrumGrid {
  steps: 32;
  bars: number;
  counts: Partial<Record<DrumRole, number[]>>;
  vel: Partial<Record<DrumRole, number[]>>;
  rolls: number;
  source: 'mix' | 'stem';
}

export interface BeatNote {
  beat: number;
  dur: number;
  key: number;
  vel: number;
}

export interface BeatChord {
  beat: number;
  dur: number;
  root: number;
  quality: ChordQuality;
}

export interface TrackFeatures {
  analysis: AudioAnalysis;
  drums: DrumGrid | null;
  chords: BeatChord[];
  lines: Partial<Record<string, BeatNote[]>>;
  vector: number[];
}

export interface TrackDetail extends LibraryTrack {
  features: TrackFeatures | null;
}

export interface TrackQuery {
  collectionId?: string;
  text?: string;
  bpmMin?: number;
  bpmMax?: number;
  key?: string;
  status?: TrackStatus;
  sort?: 'name' | 'bpm' | 'key' | 'added' | 'lufs' | 'duration';
  desc?: boolean;
  offset?: number;
  limit?: number;
}

export interface Percentiles {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export interface StyleProfile {
  collectionId: string;
  name: string;
  tracks: number;
  analysed: number;
  deep: number;
  updatedAt: number;
  tempo: {
    bpm: Percentiles;
    histogram: Array<{ bpm: number; count: number }>;
    halfTimeShare: number;
  } | null;
  swing: { median: number; share: number } | null;
  keys: { top: Array<{ key: string; count: number }>; minorShare: number } | null;
  drums: {
    roles: Partial<Record<DrumRole, { prob: number[]; vel: number[] }>>;
    rollsPerBar: number;
    tracks: number;
    source: 'mix' | 'stem' | 'mixed';
  } | null;
  bass: {
    length: Percentiles;
    degrees: number[];
    kickAlign: number;
    glide: number;
    tracks: number;
  } | null;
  harmony: {
    progressions: Array<{ degrees: string[]; count: number }>;
    changesPerBar: number;
    tracks: number;
  } | null;
  structure: {
    sectionBars: Percentiles;
    forms: Array<{ form: string[]; count: number }>;
    energyShape: number[];
    lengthSec: Percentiles;
  } | null;
  mix: {
    lufs: Percentiles;
    truePeakDb: Percentiles;
    width: Percentiles;
    bands: Record<'sub' | 'low' | 'lowMid' | 'mid' | 'highMid' | 'high', number>;
  } | null;
  examples: { drums: string | null; bass: string | null };
  caveats: string[];
}

export interface ProjectLine {
  label: string;
  patternId: string;
  channelId: string;
  notes: Array<{ tick: number; dur: number; key: number }>;
  barTicks?: number;
}

export interface OriginalityMatch {
  line: string;
  patternId: string;
  channelId: string;
  trackId: string;
  trackName: string;
  stem: string;
  notes: number;
  atBar: number;
  refAtSec: number;
  similarity: number;
}

export interface OriginalityReport {
  checkedLines: number;
  references: number;
  matches: OriginalityMatch[];
  summary: string;
}

export interface LibraryFocus {
  collectionId: string;
  name: string;
  brief: string;
}

export interface LibraryQueueState {
  running: boolean;
  paused: boolean;
  phase: 'light' | 'deep' | null;
  done: number;
  total: number;
  current: string | null;
  etaSec: number | null;
  message?: string;
}

export interface LibraryState {
  collections: Collection[];
  queue: LibraryQueueState;
  focus: LibraryFocus | null;
  dbPath: string;
}
