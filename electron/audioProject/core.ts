import type { AudioAnalysis, DrumHit, StemName, TranscribedNote } from '@shared/analyzer/protocol';
import type { SongTranscription, TranscriptionOptions } from '@shared/transcription/types';
import type { GenreId } from '@shared/sounds/genres';
import { referenceMelodyShape, transcribeSong, type MelodyShape, type TranscriptionInput } from '@shared/transcription';

export type { MelodyShape };

export interface SongSources {
  name: string;
  analysis: AudioAnalysis;
  drumHits: DrumHit[];
  drumSource: 'stem' | 'mix' | 'none';
  bass: TranscribedNote[] | null;
  other: TranscribedNote[] | null;
  vocals: TranscribedNote[] | null;
  mix: TranscribedNote[] | null;
  stems: Partial<Record<StemName, string>>;
  genre?: GenreId | null;
  notes: string[];
}

export interface TranscribeCore {
  transcribeSong(src: SongSources, opts: TranscriptionOptions): SongTranscription;
  melodyShape?(src: SongSources, opts: Pick<TranscriptionOptions, 'factor'>): MelodyShape | null;
}

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

export const DEFAULT_CORE: TranscribeCore = {
  transcribeSong: (src, opts) => transcribeSong(transcriptionInput(src), opts),
  melodyShape: (src, opts) => referenceMelodyShape(transcriptionInput(src), opts),
};
