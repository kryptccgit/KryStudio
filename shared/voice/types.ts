// ──────────────────────────────────────────────────────────────────────
// Krypt Voice (research/21-krypt-voice.md): text → speech for ad-libs,
// tags, intros and guide vocals, and "Sing my notes" (typed lyrics sung
// on a piano-roll melody: speech → syllables warped onto the notes and
// pitched to them, then Krypt Tune).
//
// Two engines:
//  - local: Kokoro-82M (Apache-2.0) in the analyzer sidecar (ONNX Runtime),
//    downloaded once from the Model Manager. Offline, free, no cloning.
//  - fish:  Fish Audio's cloud API with the USER's own key (Settings).
//    Better quality, emotion tags, cloning of the user's OWN voice only.
//    Text and voice samples leave the PC: always labelled, opt-in.
// ──────────────────────────────────────────────────────────────────────

export type VoiceEngine = 'local' | 'fish';

export interface VoiceInfo {
  /** 'local:af_heart', 'fish:<reference id>', 'mine:<id>' (the user's own cloned voice on Fish). */
  id: string;
  engine: VoiceEngine;
  name: string;
  /** "US English · female · warm". */
  description: string;
  language: string;
  /** Only the user's own clone. */
  mine?: boolean;
}

export interface VoiceState {
  local: { installed: boolean; modelId: string | null; message?: string };
  fish: { keySet: boolean; message?: string };
  voices: VoiceInfo[];
}

/** Fish Audio inline direction tags the UI offers as chips (Fish accepts many more). */
export const FISH_TAGS = ['[excited]', '[whisper]', '[shouting]', '[laughing]', '[sad]', '[angry]', '[calm]', '[sarcastic]', '[breathy]', '[hype]'] as const;

export interface SpeakRequest {
  text: string;
  voiceId: string;
  /** 0.5..2, default 1. */
  speed?: number;
  /** Where the clip goes: a bar ("9" or "9.3") on a track (name/id/number); default: the playhead on a new track. */
  at?: string;
  track?: string;
  /** Preview only: render and audition, don't add to the project. */
  preview?: boolean;
  /** Krypt Tune on the new clip's insert ('off' default). */
  tune?: 'off' | 'natural' | 'pop' | 'hard';
}

export interface SpeakOutcome {
  /** The rendered WAV (userData/voice/…), also when previewing. */
  path: string;
  durationSec: number;
  engine: VoiceEngine;
  clipId?: string;
  channelId?: string;
  notes: string[];
}

export interface SingRequest {
  /** The melody: a pattern + channel (its notes), optionally a bar range of the pattern ("1-4"). */
  patternId: string;
  channelId: string;
  bars?: string;
  /** The lyrics; syllables are spread over the notes in order ("-" joins a syllable over several notes). */
  lyrics: string;
  voiceId: string;
  /** Krypt Tune style on the sung clip (default 'hard': the tuned sound). */
  tune?: 'off' | 'natural' | 'pop' | 'hard';
  /** Vibrato depth 0..1 (default 0.2) and glide between notes in ms (default 40). */
  vibrato?: number;
  glideMs?: number;
  /** Octave shift of the melody for the voice (−2..2), e.g. −1 for a low male voice on a high lead line. */
  octave?: number;
  preview?: boolean;
}

export interface SingOutcome extends SpeakOutcome {
  /** How the lyrics landed: syllable → note (for the UI to show / the user to fix). */
  mapping: Array<{ syllable: string; noteTick: number; key: number }>;
}

export type VoiceStage = 'phonemes' | 'speaking' | 'syllables' | 'singing' | 'placing';

export interface VoiceProgress {
  stage: VoiceStage;
  fraction: number;
  message: string;
}

/** Cloning the user's own voice on Fish: a live in-app recording of them reading CONSENT_LINE plus a passage. */
export const CONSENT_LINE = 'I am recording my own voice, and I agree to have it turned into an AI voice for my own music.';
