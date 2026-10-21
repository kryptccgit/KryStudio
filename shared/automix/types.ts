export type AutoMixMode = 'vocals' | 'mix' | 'master' | 'full';

export interface AutoMixPreset {
  id: string;
  name: string;
  description: string;
  targetLufs: number;
  truePeak: number;
  tone: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  punch: number;
  warmth: number;
  brightness: number;
  width: number;
  vocalLevel: number;
  vocalSpace: number;
  genres: string[];
}

export interface AutoMixIntent {
  presetId?: string;
  targetLufs?: number;
  louder?: number;
  brighter?: number;
  warmer?: number;
  punchier?: number;
  wider?: number;
  bassier?: number;
  vocalsForward?: number;
  vocalSpace?: number;
  lessHarsh?: number;
  cleaner?: number;
  summary: string;
  source: 'ai' | 'keywords';
}

export interface AutoMixRequest {
  mode: AutoMixMode;
  preset?: string;
  prompt?: string;
  targetLufs?: number;
  truePeak?: number;
  bars?: string;
  vocalInserts?: string[];
  useAi?: 'auto' | 'never';
  keepUserFx?: boolean;
  reference?: string;
}

export interface AutoMixMeasure {
  lufs: number;
  truePeak: number;
  lra: number;
  tone: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  correlation: number;
  width?: number | null;
  vocalVsBeat: number | null;
}

export interface AutoMixChange {
  target: string;
  what: string;
}

export type AutoMixStage = 'measuring' | 'understanding' | 'planning' | 'applying' | 'refining' | 'exporting' | 'done';

export interface AutoMixProgress {
  stage: AutoMixStage;
  fraction: number;
  message: string;
}

export interface AutoMixOutcome {
  mode: AutoMixMode;
  preset: { id: string; name: string };
  intent: AutoMixIntent | null;
  before: AutoMixMeasure;
  after: AutoMixMeasure;
  changes: AutoMixChange[];
  entryId: string | null;
  passes: number;
  notes: string[];
  targetTone?: AutoMixMeasure['tone'] | null;
  reference?: ReferenceMatch | null;
}

export interface ReferenceSound {
  path: string;
  name: string;
  lufs: number;
  truePeak: number;
  tone: AutoMixMeasure['tone'];
  width: number;
  correlation: number;
  crestDb: number | null;
  durationSec: number;
  summary: string;
  cached: boolean;
}

export interface ReferenceMatch {
  path: string;
  name: string;
  lufs: number;
  tone: AutoMixMeasure['tone'];
  width: number;
  summary: string;
  distanceBefore: number;
  distanceAfter: number;
}

export interface MasterFileRequest {
  path: string;
  preset?: string;
  prompt?: string;
  targetLufs?: number;
  truePeak?: number;
  reference?: string;
  useAi?: 'auto' | 'never';
}

export interface AlbumRequest {
  paths: string[];
  preset?: string;
  prompt?: string;
  reference?: string;
  targetLufs?: number;
  truePeak?: number;
  keepDynamics?: boolean;
  useAi?: 'auto' | 'never';
}

export interface AlbumSong {
  name: string;
  path: string;
  trackId: string;
  insertId: string;
  startTick: number;
  endTick: number;
  bars: string;
  targetLufs: number;
  before: AutoMixMeasure;
  after: AutoMixMeasure;
  targetTone: AutoMixMeasure['tone'];
  changes: AutoMixChange[];
  notes: string[];
}

export interface AlbumOutcome {
  name: string;
  preset: { id: string; name: string };
  intent: AutoMixIntent | null;
  reference: ReferenceMatch | null;
  targetLufs: number;
  truePeak: number;
  keepDynamics: boolean;
  curve: AutoMixMeasure['tone'];
  songs: AlbumSong[];
  entryId: string | null;
  passes: number;
  notes: string[];
}

export interface AlbumExportRequest {
  folder: string;
  format: 'wav24' | 'wav16' | 'mp3';
  mp3Kbps?: number;
  songs: Array<{ name: string; startTick: number; endTick: number }>;
}

export interface AlbumExportOutcome {
  folder: string;
  files: string[];
  failed: Array<{ name: string; message: string }>;
}
