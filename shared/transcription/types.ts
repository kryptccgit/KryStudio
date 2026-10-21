import type { ChordQuality, DrumRole, StemName } from '../analyzer/protocol';

export type TranscriptionMode = 'exact' | 'style';

export interface GridNote {
  tick: number;
  key: number;
  dur: number;
  vel: number;
}

export interface GridChord {
  tick: number;
  dur: number;
  root: number;
  quality: ChordQuality;
  name: string;
  confidence: number;
}

export interface TranscribedSection {
  label: string;
  name: string;
  startBar: number;
  bars: number;
  energy: number;
  lufs: number;
  sameAs: number | null;
}

export interface TranscribedPart {
  name: string;
  stem: StemName | 'mix';
  kind: 'drum' | 'bass' | 'chords' | 'lead' | 'vocal-audio';
  drumRole?: DrumRole;
  notes: GridNote[];
  confidence: number;
}

export interface SongTranscription {
  name: string;
  durationSec: number;
  bpm: number;
  beatsPerBar: number;
  key: string | null;
  swingPercent: number | null;
  firstDownbeatSec: number;
  totalBars: number;
  sections: TranscribedSection[];
  chords: GridChord[];
  parts: TranscribedPart[];
  stems: Partial<Record<StemName, string>>;
  notes: string[];
}

export interface TranscriptionOptions {
  mode: TranscriptionMode;
  mine?: boolean;
  factor?: 1 | 0.5 | 2;
  grid?: number;
  feel?: number;
}
