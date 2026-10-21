// The pure cores the audio → project pipeline drives (research/15 §3.2,
// §3.3): transcribe-core (shared/transcription: the song on the project grid)
// and match-core (electron/sounds/fingerprints.ts: closest factory / pack
// sounds). The service talks to them through this narrow interface, so tests
// can drive the pipeline with fakes and either core can be missing (the
// pipeline then degrades and says so in its notes).

import type { AudioAnalysis, DrumHit, StemName, TranscribedNote } from '@shared/analyzer/protocol';
import type { SongTranscription, TranscriptionOptions } from '@shared/transcription/types';
import type { GenreId } from '@shared/sounds/genres';
import { referenceMelodyShape, transcribeSong, type MelodyShape, type TranscriptionInput } from '@shared/transcription';

export type { MelodyShape };

/** What the analyzer read from one song: the inputs of transcribe-core. Seconds in the source file. */
export interface SongSources {
  /** File name without extension. */
  name: string;
  analysis: AudioAnalysis;
  /** Drum hits: from the drum stem when separated, else the full mix's. */
  drumHits: DrumHit[];
  drumSource: 'stem' | 'mix' | 'none';
  /** Bass stem, mono, maxKey 60. */
  bass: TranscribedNote[] | null;
  /** Other stem, poly (mono when the poly model isn't installed). */
  other: TranscribedNote[] | null;
  /** Vocal stem, mono: melody shape / originality only, never written in 'style'. */
  vocals: TranscribedNote[] | null;
  /** No stems: the full mix's poly notes (bass and chords are read from it). */
  mix: TranscribedNote[] | null;
  stems: Partial<Record<StemName, string>>;
  /** The genre (names the sections, picks the tempo reading); null = transcribe-core's guess. */
  genre?: GenreId | null;
  /** Plain sentences about what could not be done. */
  notes: string[];
}

export interface TranscribeCore {
  transcribeSong(src: SongSources, opts: TranscriptionOptions): SongTranscription;
  /** The reference melody's SHAPE for 'style' (the agent writes an ORIGINAL line with it); null without a line. */
  melodyShape?(src: SongSources, opts: Pick<TranscriptionOptions, 'factor'>): MelodyShape | null;
}

/** SongSources → transcribe-core's input: without stems, the mix's notes stand in for the bass (low notes) and the other stem. */
export function transcriptionInput(src: SongSources): TranscriptionInput {
  const stemmed = Object.values(src.stems).some(Boolean);
  const mixBass = !src.bass && src.mix ? src.mix.filter((n) => n.key <= 52) : null;
  return {
    name: src.name,
    analysis: src.analysis,
    drumHits: src.drumHits,
    ...(src.drumSource !== 'none' ? { drumSource: src.drumSource } : {}),
    bass: src.bass ?? mixBass,
    other: src.other ?? src.mix,
    vocals: src.vocals,
    pitchedSource: stemmed ? 'stem' : 'mix',
    stems: src.stems,
    genre: src.genre ?? null,
  };
}

/** The shipped cores (shared/transcription). */
export const DEFAULT_CORE: TranscribeCore = {
  transcribeSong: (src, opts) => transcribeSong(transcriptionInput(src), opts),
  melodyShape: (src, opts) => referenceMelodyShape(transcriptionInput(src), opts),
};
