// KPN — Krypt Pattern Notation v0.1 (research/04 §10). Shared types.
//
// KPN is the compact text notation agents use to write and read patterns.
// Drum channels are step grids (`kick: x... ..x. | x...`), pitched channels
// are note tokens (`bass {oct=1}: F#1:6 r:4 C#2:2`). Every bar line is
// checked, so counting mistakes come back as precise per-line, per-bar errors.
//
// Units: ticks are PPQ 960 (shared/schema/time.ts). KPN velocities are MIDI
// style 1..127 in the text and 0..1 floats in KpnNote (vel = midi / 127).

import type { TimeSig } from '../schema/time';

export interface KpnHeader {
  /** Pattern name from `pattern "<name>"`, or null. */
  name: string | null;
  /** `bars=` — null when the header omits it (length is then inferred). */
  bars: number | null;
  /** `grid=` — steps per bar (default: 16th notes, i.e. 16 in 4/4). */
  grid: number;
  /** `ts=` — defaults to the project time signature (or 4/4). */
  ts: TimeSig;
  /** True when `ts=` was written explicitly. */
  tsExplicit: boolean;
  /** `key=` exactly as written (e.g. "F#m"), or null. */
  key: string | null;
  /** `swing=` 0..100, or null. */
  swing: number | null;
  /** 1-based line of the header, 0 when there is no header line. */
  line: number;
  /** Unknown header options (passed through). */
  extra: Record<string, string>;
}

/** A parsed note. NoteInput-compatible (tick, key, dur, vel, slide). */
export interface KpnNote {
  tick: number;
  dur: number;
  key: number;
  /** 0..1 (MIDI velocity / 127). */
  vel: number;
  /** FL slide note: glides from the previous note instead of retriggering. */
  slide: boolean;
}

export type KpnTrackKind = 'grid' | 'melodic' | 'empty';

export interface KpnTrack {
  /** Channel name / id as written (quotes removed). */
  name: string;
  /** First line (1-based) that wrote this track. */
  line: number;
  /** Every line that wrote this track (a repeated name continues the track). */
  lines: number[];
  kind: KpnTrackKind;
  /** Steps per bar of the track's first line (`name/32` overrides the header grid). */
  grid: number;
  /** `{key=value ...}` options (merged across continuation lines). */
  opts: Record<string, string>;
  notes: KpnNote[];
  /** Grid lines in merge mode: step ranges explicitly cleared with `_`. */
  clears: Array<{ tick: number; dur: number }>;
  /** Cursor position (ticks) where the track's text ended. */
  end: number;
  /** The drum key used for bare grid hits (from {pitch=} or the default). */
  drumKey: number;
  /** True when {pitch=} was written. */
  pitchExplicit: boolean;
}

export interface KpnIssue {
  /** 1-based source line (0 = whole text). */
  line: number;
  /** Track name, when the issue belongs to a track line. */
  track?: string;
  /** 1-based bar, when known. */
  bar?: number;
  /** Full human-readable message, already prefixed with line/track/bar. */
  message: string;
}

export interface KpnParseResult {
  /** True when there are no errors. */
  ok: boolean;
  header: KpnHeader;
  tracks: KpnTrack[];
  errors: KpnIssue[];
  warnings: KpnIssue[];
  /** Ticks per bar and per header-grid step. */
  barTicks: number;
  stepTicks: number;
  /** bars × barTicks when bars is known; otherwise inferred from content (whole bars, min 1). */
  totalTicks: number;
  /** Bars actually used (header bars, or inferred). */
  bars: number;
}

export interface KpnParseOptions {
  /** Project time signature, used when the header has no `ts=` (default 4/4). */
  ts?: TimeSig;
  /** MIDI key a bare grid hit triggers when the line has no {pitch=} (default 60 = C4). */
  drumKey?: (trackName: string) => number;
  /** Error out unless the text starts with a `pattern` header. Default false. */
  requireHeader?: boolean;
  /** Hard cap on parsed notes (default 20000). */
  maxNotes?: number;
}

/** A note as the printer consumes it (Note / NoteInput compatible). */
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
  /** Prefer a step-grid line (drum / one-shot channels). Falls back to tokens when not representable. */
  drum?: boolean;
  /** MIDI key a bare `x` means for this track (default 60). */
  drumKey?: number;
}

export interface PrintOptions {
  /** Pattern name for the header. */
  name?: string | null;
  /** Pattern length in bars (default: derived from content, min 1). */
  bars?: number | null;
  /** Header grid (default 16th steps for the time signature). */
  grid?: number;
  ts?: TimeSig;
  /** Key for the header (`key=`), as text. */
  key?: string | null;
  /** Emit the `pattern` header line (default true). */
  header?: boolean;
  /** Fold identical consecutive grid bars into `( ... |)*n` (default true). */
  compress?: boolean;
  /** Pad track names so the colons line up (default true). */
  align?: boolean;
  /** Finest grid (steps per bar) the printer uses before quantizing for display (default 192). */
  maxGrid?: number;
}

export interface PrintResult {
  text: string;
  warnings: string[];
}
