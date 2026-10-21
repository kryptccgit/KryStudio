// ──────────────────────────────────────────────────────────────────────
// Song transcription (research/15-closer-to-reference.md §1): everything the
// analyzer reads from one song (tempo grid, sections, chords, and per-stem
// notes / drum hits), quantized onto the project's bar grid, ready to become
// patterns. Two consumers share it:
//
//  * audio_to_project ('exact'): the song itself as an editable project, for
//    the user's own songs, practice and remix study. Every part transcribed.
//  * build_from_reference ('style'): a NEW song in the reference's style.
//    Drum programming, chord progression, bass RHYTHM (notes from the chord
//    roots), arrangement, tempo, key and sound palette follow the reference;
//    melody, hook and lyrics are never copied (the agent writes an original
//    top line; check_originality guards it). With `mine: true` (the user's
//    own song) 'style' may keep the exact bass and melody too.
//
// Pure data; the maths lives in shared/transcription/*.ts (no I/O).
// ──────────────────────────────────────────────────────────────────────

import type { ChordQuality, DrumRole, StemName } from '../analyzer/protocol';

export type TranscriptionMode = 'exact' | 'style';

/** A note on the project grid (ticks at PPQ 960, from bar 1 of the song). */
export interface GridNote {
  tick: number;
  /** MIDI key (drums: the channel's root, usually 60). */
  key: number;
  dur: number;
  /** 0..1 */
  vel: number;
}

/** A chord on the grid. */
export interface GridChord {
  tick: number;
  dur: number;
  /** Pitch class 0..11 of the root. */
  root: number;
  quality: ChordQuality;
  /** 'Am', 'F', 'C7' … */
  name: string;
  confidence: number;
}

/** One section of the song on the bar grid. */
export interface TranscribedSection {
  /** Analyzer label: same letter = similar material. */
  label: string;
  /** Display name the project uses ("Intro", "Drop 1", "Verse 2" … from SectionKind + order). */
  name: string;
  /** 1-based first bar, bars long. */
  startBar: number;
  bars: number;
  /** 0..1 (loudest section = 1). */
  energy: number;
  lufs: number;
  /**
   * Sections whose material repeats an earlier one (same label and parts similar enough) reuse its pattern:
   * the index into `sections` of the section whose pattern this one plays, or null when it gets its own.
   */
  sameAs: number | null;
}

/** A transcribed part (one future channel). */
export interface TranscribedPart {
  /** Channel name ("Kick", "Bass", "Chords", "Lead", "Vocal" …). */
  name: string;
  /** Where it came from. */
  stem: StemName | 'mix';
  kind: 'drum' | 'bass' | 'chords' | 'lead' | 'vocal-audio';
  /** Drum parts only. */
  drumRole?: DrumRole;
  /** Notes over the whole song (ticks from bar 1); empty for 'vocal-audio'. */
  notes: GridNote[];
  /** 0..1: how much to trust it (density of confident notes, stem clarity). */
  confidence: number;
}

export interface SongTranscription {
  /** File name without extension. */
  name: string;
  durationSec: number;
  /** The tempo the grid uses (the detected tempo, or the half/double reading the caller chose). */
  bpm: number;
  beatsPerBar: number;
  /** 'Cm', 'F#' … (null: atonal). */
  key: string | null;
  /** 0..100 transport swing measured on the drums (null: straight / unknown). */
  swingPercent: number | null;
  /** Seconds in the source file where bar 1 starts (the first downbeat); audio before it is pickup. */
  firstDownbeatSec: number;
  totalBars: number;
  sections: TranscribedSection[];
  chords: GridChord[];
  parts: TranscribedPart[];
  /** Stem files on disk (cached separation), when the song was separated. */
  stems: Partial<Record<StemName, string>>;
  /** What could not be done, in plain words ("No stem model installed: drums were read from the full mix"). */
  notes: string[];
}

/** Options shared by audio_to_project and build_from_reference. */
export interface TranscriptionOptions {
  mode: TranscriptionMode;
  /** The user's own song: 'style' may keep exact bass + melody. */
  mine?: boolean;
  /** Tempo reading: 1 (detected), 0.5 or 2. Default: the reading that fits the genre (ReferenceBrief.factor). */
  factor?: 1 | 0.5 | 2;
  /** Quantize grid in ticks (default 120 = a 32nd for drums, 240 = a 16th for pitched parts); 0 = keep timing. */
  grid?: number;
  /** Keep this much of each note's micro-timing after quantizing (0..1, default 0.5 for drums, 0.3 otherwise). */
  feel?: number;
}
