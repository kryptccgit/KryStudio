// ──────────────────────────────────────────────────────────────────────
// Auto Mashup: two songs → one mashup project (research/18-auto-mashup.md).
//
// Contract between the builder (electron/mashup, shared/mashup/plan.ts,
// MCP auto_mashup) and the UI (Home ▸ Audio Tools, Tools menu, playlist
// clip menu). `check` analyses both songs and proposes a plan without
// editing anything; `build` runs the whole pipeline as ONE undo step.
// ──────────────────────────────────────────────────────────────────────

/** A song: an audio file on this PC, or an audio clip / audio-clip channel already in the project. */
export type MashupSource = { path: string } | { clipId: string };

/**
 * vocalOverBeat: the vocal of one song on the instrumental (drums + bass + other) of the other — the classic
 * mashup. stemBlend: any stem from either song (`stems`). backAndForth: the two full songs trade sections
 * (A's chorus, then B's drop, …) on one tempo / key grid, joined with transitions.
 */
export type MashupStyle = 'vocalOverBeat' | 'stemBlend' | 'backAndForth';

export type MashupStem = 'vocals' | 'drums' | 'bass' | 'other';

/** Which song each stem comes from (stemBlend); null = leave that stem out. */
export type StemPick = Record<MashupStem, 'a' | 'b' | null>;

/**
 * Where the shared key / tempo come from: 'beat' = the instrumental stays untouched (the vocal moves);
 * 'vocal' = the vocal stays untouched; 'middle' = both move, each about half way (smallest worst-case shift).
 */
export type MashupAnchor = 'beat' | 'vocal' | 'middle';

export interface MashupRequest {
  a: MashupSource;
  b: MashupSource;
  style: MashupStyle;
  /** vocalOverBeat: which song gives the vocal; 'auto' = the better fit (vocal presence + key / tempo cost). */
  vocalFrom?: 'a' | 'b' | 'auto';
  /** stemBlend only. */
  stems?: StemPick;
  anchor?: MashupAnchor;
  /** Override the shared tempo / key (else from `anchor`). Key like "F#m". */
  bpm?: number;
  key?: string;
  /** Tempo reading per song: 1 = detected (default), 0.5 / 2 = half / double time. */
  factorA?: 1 | 0.5 | 2;
  factorB?: 1 | 0.5 | 2;
  /** Krypt Tune on the vocal: 'off' or a style (default 'natural'). */
  tune?: 'off' | 'natural' | 'pop' | 'hard';
  /** Target length in bars (default: the instrumental's arranged length, capped at 128). */
  bars?: number;
  /** true (default) = a new project; false = add to the open project (on new tracks). */
  newProject?: boolean;
  /** Transitions at section boundaries (default true). */
  transitions?: boolean;
}

export interface MashupSongReading {
  name: string;
  /**
   * The file the song was read from (set for path sources, including one picked in the `{ path: '' }` dialog):
   * pass it back as `{ path }` to build, so the dialog doesn't open again. Absent for a project clip.
   */
  path?: string;
  durationSec: number;
  bpm: number | null;
  /** Half / double-time readings worth offering. */
  bpmAlternatives: number[];
  key: string | null;
  keyConfidence: number;
  /** 0..1: how much of the song has a lead vocal (vocal-stem activity, else a mix estimate). */
  vocalPresence: number;
  /** Section boundaries in bars of the song's own grid (startBar 1-based: bar 1 = its first downbeat), with a name and an energy 0..1. */
  sections: Array<{ name: string; startBar: number; bars: number; energy: number; vocal: boolean }>;
  /** Stems available (separated now or earlier) — empty without a stem model. */
  stems: MashupStem[];
}

export interface MashupCheck {
  a: MashupSongReading;
  b: MashupSongReading;
  /** 0..100: how well these two fit (tempo stretch, key distance, structure, vocal presence). */
  score: number;
  /** One line per factor, plain words ("Keys: A minor and C major share their notes: no pitch change"). */
  reasons: string[];
  /** The plan `build` would run with these options. */
  plan: MashupPlanSummary;
  /** Concrete better options ("Use B at half time: stretch ×1.02 instead of ×0.51"). */
  suggestions: string[];
  /** Blocking problems (no stem model for a style that needs stems, unreadable file, …). */
  problems: string[];
}

export interface MashupPlanSummary {
  style: MashupStyle;
  vocalFrom: 'a' | 'b' | null;
  bpm: number;
  key: string | null;
  /** Per song: tempo stretch (output ÷ input duration) and pitch shift in semitones. */
  shiftA: { stretch: number; semitones: number };
  shiftB: { stretch: number; semitones: number };
  /** The arrangement: sections in order on the mashup grid (startBar 1-based: bar 1 = the start of the mashup). */
  sections: Array<{ name: string; startBar: number; bars: number; uses: string }>;
  bars: number;
}

export type MashupStage = 'reading' | 'separating' | 'analyzing' | 'planning' | 'building' | 'mixing';

export interface MashupProgress {
  stage: MashupStage;
  /** 0..1 within the whole job, or -1 when unknown. */
  fraction: number;
  message: string;
}

export interface MashupOutcome {
  name: string;
  plan: MashupPlanSummary;
  score: number;
  /** Honest limits ("A's vocal is pitched +4 st: listen for artefacts"). */
  notes: string[];
  tracks: number;
  /** Always present: mashups of others' songs are for practice and personal use. */
  rightsNote: string;
}

export const MASHUP_RIGHTS_NOTE =
  "Mashups of songs you don't own are for practice, DJ sets you have the rights for, and personal listening, not for release.";
