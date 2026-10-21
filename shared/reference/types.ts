import type { DrumRole } from '../analyzer/protocol';
import type { SectionKind } from '../playbooks/types';
import type { GenreId } from '../sounds/genres';

export interface ReferenceSection {
  label: string;
  startSec: number;
  endSec: number;
  startBeat: number | null;
  endBeat: number | null;
  lufs: number;
  kickRate?: number | null;
}

export interface PlannedSection {
  label: string;
  startBar: number;
  bars: number;
  lufs: number;
  energy: number;
}

export interface DrumFeel {
  source: 'mix' | 'stem';
  bars: number;
  steps: Partial<Record<DrumRole, number[]>>;
  fourOnFloor: boolean;
  backbeat: 'two-four' | 'three' | 'none';
  hats: '32nds' | '16ths' | '8ths' | 'sparse' | 'none';
  rollsPerMin: number;
}

export interface GenreGuess {
  id: GenreId;
  score: number;
  bpm: number;
  why: string[];
}

export interface ReferenceBrief {
  name: string;
  durationSec: number;
  detectedBpm: number | null;
  tempoConfidence: number | null;
  bpm: number | null;
  factor: number;
  key: string | null;
  keyConfidence: number | null;
  keyAlternatives: string[];
  keyFromChords: string | null;
  swing: number | null;
  swingPercent: number | null;
  beatsPerBar: number;
  endBeat: number | null;
  sections: ReferenceSection[];
  plan: PlannedSection[];
  totalBars: number | null;
  form: string;
  drums: DrumFeel | null;
  harmony: {
    loop: string[] | null;
    loopChords: string[] | null;
    changesPerBar: number | null;
    chords: number;
  };
  mix: {
    lufs: number | null;
    truePeakDb: number | null;
    bandsVsMid: Partial<Record<'sub' | 'low' | 'lowMid' | 'highMid' | 'high', number>> | null;
    width: number | null;
    correlation: number | null;
    contrastLu: number | null;
  };
  genres: GenreGuess[];
  genre: GenreId | null;
  genreSource: 'given' | 'guessed' | null;
  kinds: SectionKind[];
}
