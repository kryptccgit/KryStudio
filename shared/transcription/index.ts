// Song transcription (research/15 §3.3): analysis + stems → SongTranscription on the project grid. Pure.
export * from './types';
export { transcribeSong, sectionPatterns, referenceMelodyShape, songGrid, DRUM_GRID, PITCHED_GRID, DRUM_FEEL, PITCHED_FEEL, type TranscriptionInput, type SectionPattern, type SectionPart } from './transcribe';
export { transcriptionGrid, quantize, FALLBACK_BPM, type TranscriptionGrid, type TempoFactor } from './grid';
export { drumParts, normaliseVelocities, DRUM_PARTS, DRUM_KEY, FLAM_SEC } from './drums';
export { chordTimeline, chordAt, chordName, chordPcs, CHORD_TONES, rootPosition, styleVoicings, exactVoicing } from './chords';
export { monoCleanup, skyline, fixBass, styleBass, bassClasses, BASS_LOW, BASS_HIGH } from './lines';
export { songSections, linkSameAs, snapPhrases, SAME_AS_MIN, KIND_LABEL } from './sections';
export { melodyShape, melodyShapeText, type MelodyShape } from './melody';
