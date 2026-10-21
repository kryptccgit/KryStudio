// "Make something like this song": what Krypt Studio reads from ONE reference
// song the user gives (study_reference), and how get_playbook / review_song
// follow it. Pure data, derived from the analyzer's AudioAnalysis (+ drum
// hits): numbers, never audio, never notes of the song's melody.
//
// Times: sections keep seconds AND beats from the first downbeat at the
// DETECTED tempo, so a plan can be laid out in bars at any reading of the
// tempo (half / double time) or, for another genre's tempo, by duration.

import type { DrumRole } from '../analyzer/protocol';
import type { SectionKind } from '../playbooks/types';
import type { GenreId } from '../sounds/genres';

/** A section the analyzer found (repeated-material segmentation). */
export interface ReferenceSection {
  /** Analyzer label: the same letter = similar material (A, B, C … by first appearance). */
  label: string;
  startSec: number;
  endSec: number;
  /** Beats from the first downbeat at the detected tempo (null without a tempo). */
  startBeat: number | null;
  endBeat: number | null;
  /** Short-term loudness of the section (LUFS). */
  lufs: number;
  /** Kicks per bar in the section (null without drum hits). */
  kickRate?: number | null;
}

/** A section of the reference laid out in bars at one tempo (sectionPlan). */
export interface PlannedSection {
  label: string;
  /** 1-based first bar. */
  startBar: number;
  bars: number;
  lufs: number;
  /** 0..1, the loudest section = 1 (about 0.1 per LU quieter). */
  energy: number;
}

/** Drum feel at the chosen tempo reading: per role, how often each 16th of a bar has a hit (0..1). */
export interface DrumFeel {
  /** 'mix' = onsets on the full song, 'stem' = the separated drum stem (deep analysis). */
  source: 'mix' | 'stem';
  /** Bars the grid was measured over. */
  bars: number;
  steps: Partial<Record<DrumRole, number[]>>;
  fourOnFloor: boolean;
  /** Where the snare / clap lands: 2 and 4, beat 3 (half-time), or neither. */
  backbeat: 'two-four' | 'three' | 'none';
  hats: '32nds' | '16ths' | '8ths' | 'sparse' | 'none';
  /** Hat rolls (runs of ≥ 3 32nds) per minute. */
  rollsPerMin: number;
}

export interface GenreGuess {
  id: GenreId;
  /** 0..1 */
  score: number;
  /** The tempo reading that fits this genre (the detected tempo, half or double). */
  bpm: number;
  /** Plain reasons ("tempo 128 in 120-130", "four-on-the-floor kick"). */
  why: string[];
}

export interface ReferenceBrief {
  /** The song's name (file name without extension). */
  name: string;
  durationSec: number;
  /** Detected tempo (null: no stable pulse). */
  detectedBpm: number | null;
  tempoConfidence: number | null;
  /** The reading used for the plan (the detected tempo, half or double: what fits the genre). */
  bpm: number | null;
  /** bpm / detectedBpm: 1, 2 or 0.5. */
  factor: number;
  /** The analyzer's key. */
  key: string | null;
  keyConfidence: number | null;
  /** Keys whose scale holds every chord of the loop when the analyzer's key doesn't (relative pairs together). */
  keyAlternatives: string[];
  /** The one of them the plan uses (the genre's preferred mode), or null when the analyzer's key fits the chords. */
  keyFromChords: string | null;
  /** The analyzer's swing, 0..1 on the detected tempo's 16ths (null: nothing to measure). */
  swing: number | null;
  /** 0..100 on the transport's swing scale; null when not measured at this reading. */
  swingPercent: number | null;
  beatsPerBar: number;
  /** Beat (from the first downbeat, detected tempo) at the end of the song. */
  endBeat: number | null;
  sections: ReferenceSection[];
  /** The plan at `bpm` (empty without a tempo or with fewer than 3 sections). */
  plan: PlannedSection[];
  totalBars: number | null;
  /** Section letters in order, consecutive repeats collapsed ("A B A C B"). */
  form: string;
  drums: DrumFeel | null;
  harmony: {
    /** The most repeated 4-chord loop as roman numerals (null when the chords are unclear). */
    loop: string[] | null;
    /** The same loop by chord name ("Am F C G"). */
    loopChords: string[] | null;
    /** Chord changes per bar (at `bpm`). */
    changesPerBar: number | null;
    chords: number;
  };
  mix: {
    lufs: number | null;
    truePeakDb: number | null;
    /** Bands relative to the mid band (dB), the same scale as playbook targets. */
    bandsVsMid: Partial<Record<'sub' | 'low' | 'lowMid' | 'highMid' | 'high', number>> | null;
    width: number | null;
    correlation: number | null;
    /** Loudest minus quietest section (LU). */
    contrastLu: number | null;
  };
  /** Best-matching genres, highest score first. */
  genres: GenreGuess[];
  /** The genre the plan was laid out for (the caller's, else the best guess). */
  genre: GenreId | null;
  genreSource: 'given' | 'guessed' | null;
  /** Section kinds of the plan for that genre (same order as plan). */
  kinds: SectionKind[];
}
