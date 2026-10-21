import type { GenreId } from '../sounds/genres';
import type { ChainRole, InstrumentRole, SampleKind } from '../sounds/types';

export interface PlaybookPart {
  name: string;
  role: InstrumentRole;
  tags?: string[];
  sample?: SampleKind;
  range?: [number, number];
  writing: string;
  chain?: ChainRole;
  bus?: string;
  duckUnder?: string;
}

export interface PlaybookPattern {
  name: string;
  for: string[];
  kpn: string;
  notes?: string;
}

export type SectionKind = 'intro' | 'verse' | 'pre' | 'hook' | 'chorus' | 'build' | 'drop' | 'breakdown' | 'bridge' | 'break' | 'outro';

export type TransitionKind =
  | 'riser'
  | 'reverse-cymbal'
  | 'snare-roll'
  | 'drum-fill'
  | 'filter-sweep'
  | 'impact'
  | 'downlifter'
  | 'sub-drop'
  | 'silence'
  | 'crash'
  | 'whoosh'
  | 'tape-stop'
  | 'swell';

export interface PlaybookSection {
  kind: SectionKind;
  label: string;
  bars: number;
  energy: number;
  parts: string[];
  transitionIn?: TransitionKind[];
  notes?: string;
}

export interface PlaybookTargets {
  lufs: number;
  truePeakDb: number;
  bars: [number, number];
  bands?: Partial<Record<'sub' | 'low' | 'lowMid' | 'highMid' | 'high', [number, number]>>;
  contrastLu?: [number, number];
  minCorrelation?: number;
  maxStaticBars?: number;
  minHatVelocitySpread?: number;
}

export interface PlaybookGroove {
  template: string;
  amount: number;
  velocity: number;
  parts: string[];
}

export interface Playbook {
  id: GenreId;
  name: string;
  summary: string;
  bpm: { min: number; max: number; typical: number };
  grid?: number;
  halfTime?: boolean;
  swing: number;
  keys: { modes: string[]; common: string[]; notes?: string };
  harmony: { progressions: string[]; rhythm: string; voicing: string };
  melody: string;
  parts: PlaybookPart[];
  patterns: PlaybookPattern[];
  arrangement: PlaybookSection[];
  mix: {
    master: { tags?: string[] };
    buses?: Array<{ name: string; chain: ChainRole; tags?: string[] }>;
    sends?: Array<{ name: string; chain: ChainRole; tags?: string[]; from: Array<{ part: string; amount: number }> }>;
    levels: string;
    notes?: string;
  };
  transitions: string;
  mistakes: string[];
  targets: PlaybookTargets;
  groove?: PlaybookGroove;
}
