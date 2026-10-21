export type MashupSource = { path: string } | { clipId: string };

export type MashupStyle = 'vocalOverBeat' | 'stemBlend' | 'backAndForth';

export type MashupStem = 'vocals' | 'drums' | 'bass' | 'other';

export type StemPick = Record<MashupStem, 'a' | 'b' | null>;

export type MashupAnchor = 'beat' | 'vocal' | 'middle';

export interface MashupRequest {
  a: MashupSource;
  b: MashupSource;
  style: MashupStyle;
  vocalFrom?: 'a' | 'b' | 'auto';
  stems?: StemPick;
  anchor?: MashupAnchor;
  bpm?: number;
  key?: string;
  factorA?: 1 | 0.5 | 2;
  factorB?: 1 | 0.5 | 2;
  tune?: 'off' | 'natural' | 'pop' | 'hard';
  bars?: number;
  newProject?: boolean;
  transitions?: boolean;
}

export interface MashupSongReading {
  name: string;
  path?: string;
  durationSec: number;
  bpm: number | null;
  bpmAlternatives: number[];
  key: string | null;
  keyConfidence: number;
  vocalPresence: number;
  sections: Array<{ name: string; startBar: number; bars: number; energy: number; vocal: boolean }>;
  stems: MashupStem[];
}

export interface MashupCheck {
  a: MashupSongReading;
  b: MashupSongReading;
  score: number;
  reasons: string[];
  plan: MashupPlanSummary;
  suggestions: string[];
  problems: string[];
}

export interface MashupPlanSummary {
  style: MashupStyle;
  vocalFrom: 'a' | 'b' | null;
  bpm: number;
  key: string | null;
  shiftA: { stretch: number; semitones: number };
  shiftB: { stretch: number; semitones: number };
  sections: Array<{ name: string; startBar: number; bars: number; uses: string }>;
  bars: number;
}

export type MashupStage = 'reading' | 'separating' | 'analyzing' | 'planning' | 'building' | 'mixing';

export interface MashupProgress {
  stage: MashupStage;
  fraction: number;
  message: string;
}

export interface MashupOutcome {
  name: string;
  plan: MashupPlanSummary;
  score: number;
  notes: string[];
  tracks: number;
  rightsNote: string;
}

export const MASHUP_RIGHTS_NOTE =
  "Mashups of songs you don't own are for practice, DJ sets you have the rights for, and personal listening, not for release.";
