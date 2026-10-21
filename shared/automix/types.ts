// ──────────────────────────────────────────────────────────────────────
// Auto Mix / Auto Master (research/20-auto-mix-master.md).
//
// One button, no agent needed: pick a preset or type a prompt; Krypt
// renders the song, measures it, sets real knob values, re-measures until
// it hits the target, and reports before / after. The whole result is ONE
// history entry, so A/B is DocHost.toggleEntry and "Undo" removes it all.
// ──────────────────────────────────────────────────────────────────────

/**
 * vocals: the vocal channels only (chain, level against the beat, space for them in the beat).
 * mix: every insert (gain staging, EQ / compression per role, bus glue, bass vs kick, vocal space).
 * master: the master bus only (tone toward the target curve, glue, width / mono bass, loudness + true peak).
 * full: mix, then master.
 */
export type AutoMixMode = 'vocals' | 'mix' | 'master' | 'full';

export interface AutoMixPreset {
  id: string;
  name: string;
  /** One line for the card ("Loud and punchy for trap / drill"). */
  description: string;
  /** Integrated loudness target (LUFS) and true-peak ceiling (dBTP). */
  targetLufs: number;
  truePeak: number;
  /** Tonal target: band levels relative to the mids, dB (sub, low, lowMid, mid, highMid, high). */
  tone: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  /** 0..1 character knobs the planner turns into settings. */
  punch: number;
  warmth: number;
  brightness: number;
  width: number;
  /** Vocal level vs the beat (dB, + = louder) and how much space (reverb / delay) 0..1. */
  vocalLevel: number;
  vocalSpace: number;
  /** Genres it suits (shared/sounds/genres ids) for the auto pick. */
  genres: string[];
}

/** What a prompt asks for, as adjustments on top of a preset (all optional, small integers -2..2 unless noted). */
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
  /** Plain-language echo of what was understood ("louder, brighter vocals, less reverb"). */
  summary: string;
  /** 'ai' = understood by the connected AI; 'keywords' = the built-in parser. */
  source: 'ai' | 'keywords';
}

export interface AutoMixRequest {
  mode: AutoMixMode;
  /** A factory preset id (AUTO_MIX_PRESETS) or 'auto' (from the project's genre / the analysis). */
  preset?: string;
  /** Free text ("vocals on top, punchy, not harsh, streaming loud"). */
  prompt?: string;
  /** Overrides of the preset. */
  targetLufs?: number;
  truePeak?: number;
  /** Bar range to measure (default: the whole song, or its loudest 32 bars for long songs). */
  bars?: string;
  /** Channels / inserts treated as vocals (default: detected from names, stems and analysis). */
  vocalInserts?: string[];
  /** Use the connected AI for the prompt when one is available (default 'auto'). */
  useAi?: 'auto' | 'never';
  /** Keep existing effects the user added (default true: Krypt adds / adjusts its own slots, marked as such). */
  keepUserFx?: boolean;
  /**
   * A reference song (absolute path; research/23 §1): master / full aim at ITS tone (bands relative to the mids),
   * loudness (clamped to a safe range; the crest guard still wins) and width. It is only measured, never copied.
   */
  reference?: string;
}

export interface AutoMixMeasure {
  lufs: number;
  truePeak: number;
  lra: number;
  /** Band levels relative to the mids, dB. */
  tone: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  correlation: number;
  /** Stereo width 0 (mono) .. 1 (side energy / total), when measured. */
  width?: number | null;
  /** Vocal minus beat loudness (dB), when vocals were found. */
  vocalVsBeat: number | null;
}

export interface AutoMixChange {
  /** Where ("Vocals ▸ Krypt EQ", "Master ▸ Limiter", "Bass ▸ Volume"). */
  target: string;
  /** What, in plain words ("cut 3 dB at 300 Hz (mud)", "input +4.5 dB to reach -9 LUFS"). */
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
  /** The history entry holding every change: A/B = doc.toggleEntry(entryId); undo removes it. */
  entryId: string | null;
  /** Render passes used to converge. */
  passes: number;
  /** Honest limits ("No vocals found: vocal mode did nothing", "Loudness capped at -8 LUFS: more would distort"). */
  notes: string[];
  /** The tone curve the master aimed at (relative to the mids), when it isn't simply the preset's (a reference song). */
  targetTone?: AutoMixMeasure['tone'] | null;
  /** The reference song it was matched to, and how close it got. */
  reference?: ReferenceMatch | null;
}

/** A reference song's measured sound (research/23 §1). Only measured: its audio never enters the project or the output. */
export interface ReferenceSound {
  /** Absolute path of the file. */
  path: string;
  /** File name without the extension. */
  name: string;
  lufs: number;
  truePeak: number;
  /** Bands relative to the mids (mid = 0). */
  tone: AutoMixMeasure['tone'];
  /** 0 (mono) .. 1: side energy / total. */
  width: number;
  correlation: number;
  crestDb: number | null;
  durationSec: number;
  /** One line for the dialog ("−9.2 LUFS · bright · wide"). */
  summary: string;
  /** Read from the analysis cache (no new pass). */
  cached: boolean;
}

/** How a run matched its reference: the reference itself, and the tone distance before → after. */
export interface ReferenceMatch {
  path: string;
  name: string;
  lufs: number;
  tone: AutoMixMeasure['tone'];
  width: number;
  summary: string;
  /** Mean absolute band difference to the reference (dB, the five bands around the mids), before and after. */
  distanceBefore: number;
  distanceAfter: number;
}

/** Master an audio FILE (Home ▸ Audio Tools): opens it in a new tab, masters it, offers the export. */
export interface MasterFileRequest {
  /** '' = a file dialog. */
  path: string;
  preset?: string;
  prompt?: string;
  targetLufs?: number;
  truePeak?: number;
  /** A reference song to match (see AutoMixRequest.reference). */
  reference?: string;
  useAi?: 'auto' | 'never';
}

// ── Album mastering (research/23 §2) ──────────────────────────────────

/** Master 2-20 songs as one record, in a new project tab. */
export interface AlbumRequest {
  /** Absolute paths, in album order. */
  paths: string[];
  preset?: string;
  prompt?: string;
  /** A reference song for the whole album (its tone, loudness and width). */
  reference?: string;
  targetLufs?: number;
  truePeak?: number;
  /**
   * Keep the album's dynamics (default true): the loudest song hits the target and the others keep their distance
   * to it, at most 4 LU under. false: every song hits the target.
   */
  keepDynamics?: boolean;
  useAi?: 'auto' | 'never';
}

export interface AlbumSong {
  name: string;
  path: string;
  trackId: string;
  insertId: string;
  /** Where it sits in the album tab (song ticks; the end is where its audio ends). */
  startTick: number;
  endTick: number;
  /** "5-60" (1-based, inclusive): the bars it plays in. */
  bars: string;
  /** The loudness this song aimed at (the album target, or its offset under it). */
  targetLufs: number;
  before: AutoMixMeasure;
  after: AutoMixMeasure;
  /** The tone curve this song aimed at (the album curve plus a share of its own character). */
  targetTone: AutoMixMeasure['tone'];
  changes: AutoMixChange[];
  notes: string[];
}

export interface AlbumOutcome {
  /** The album tab's name ("Album: First Song + 11"). */
  name: string;
  preset: { id: string; name: string };
  intent: AutoMixIntent | null;
  reference: ReferenceMatch | null;
  targetLufs: number;
  truePeak: number;
  keepDynamics: boolean;
  /** The album's tone curve (preset or reference, with the prompt on top). */
  curve: AutoMixMeasure['tone'];
  songs: AlbumSong[];
  /** ONE history entry holds the mastering of every song (A/B = doc.toggleEntry(entryId); undo removes it all). */
  entryId: string | null;
  /** Render passes (every song is rendered at most once per pass). */
  passes: number;
  notes: string[];
}

/** Export all: one file per song of the album tab, rendered from its range. */
export interface AlbumExportRequest {
  /** Absolute folder; '' = a folder dialog. */
  folder: string;
  format: 'wav24' | 'wav16' | 'mp3';
  mp3Kbps?: number;
  songs: Array<{ name: string; startTick: number; endTick: number }>;
}

export interface AlbumExportOutcome {
  folder: string;
  /** Absolute paths written, in album order. */
  files: string[];
  failed: Array<{ name: string; message: string }>;
}
