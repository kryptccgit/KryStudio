import type { TimeSig } from '../schema/time';

export interface KpnHeader {
  name: string | null;
  bars: number | null;
  grid: number;
  ts: TimeSig;
  tsExplicit: boolean;
  key: string | null;
  swing: number | null;
  line: number;
  extra: Record<string, string>;
}

export interface KpnNote {
  tick: number;
  dur: number;
  key: number;
  vel: number;
  slide: boolean;
}

export type KpnTrackKind = 'grid' | 'melodic' | 'empty';

export interface KpnTrack {
  name: string;
  line: number;
  lines: number[];
  kind: KpnTrackKind;
  grid: number;
  opts: Record<string, string>;
  notes: KpnNote[];
  clears: Array<{ tick: number; dur: number }>;
  end: number;
  drumKey: number;
  pitchExplicit: boolean;
}

export interface KpnIssue {
  line: number;
  track?: string;
  bar?: number;
  message: string;
}

export interface KpnParseResult {
  ok: boolean;
  header: KpnHeader;
  tracks: KpnTrack[];
  errors: KpnIssue[];
  warnings: KpnIssue[];
  barTicks: number;
  stepTicks: number;
  totalTicks: number;
  bars: number;
}

export interface KpnParseOptions {
  ts?: TimeSig;
  drumKey?: (trackName: string) => number;
  requireHeader?: boolean;
  maxNotes?: number;
}

export interface PrintNote {
  tick: number;
  dur: number;
  key: number;
  vel: number;
  slide?: boolean;
}

export interface PrintTrack {
  name: string;
  notes: PrintNote[];
  drum?: boolean;
  drumKey?: number;
}

export interface PrintOptions {
  name?: string | null;
  bars?: number | null;
  grid?: number;
  ts?: TimeSig;
  key?: string | null;
  header?: boolean;
  compress?: boolean;
  align?: boolean;
  maxGrid?: number;
}

export interface PrintResult {
  text: string;
  warnings: string[];
}
