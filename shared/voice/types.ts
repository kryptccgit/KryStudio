export type VoiceEngine = 'local' | 'fish';

export interface VoiceInfo {
  /** 'local:af_heart', 'fish:<reference id>', 'mine:<id>' (the user's own cloned voice on Fish). */
  id: string;
  engine: VoiceEngine;
  name: string;
  description: string;
  language: string;
  mine?: boolean;
}

export interface VoiceState {
  local: { installed: boolean; modelId: string | null; message?: string };
  fish: { keySet: boolean; message?: string };
  voices: VoiceInfo[];
}

export const FISH_TAGS = ['[excited]', '[whisper]', '[shouting]', '[laughing]', '[sad]', '[angry]', '[calm]', '[sarcastic]', '[breathy]', '[hype]'] as const;

export interface SpeakRequest {
  text: string;
  voiceId: string;
  speed?: number;
  at?: string;
  track?: string;
  preview?: boolean;
  tune?: 'off' | 'natural' | 'pop' | 'hard';
}

export interface SpeakOutcome {
  path: string;
  durationSec: number;
  engine: VoiceEngine;
  clipId?: string;
  channelId?: string;
  notes: string[];
}

export interface SingRequest {
  patternId: string;
  channelId: string;
  bars?: string;
  lyrics: string;
  voiceId: string;
  tune?: 'off' | 'natural' | 'pop' | 'hard';
  vibrato?: number;
  glideMs?: number;
  octave?: number;
  preview?: boolean;
}

export interface SingOutcome extends SpeakOutcome {
  mapping: Array<{ syllable: string; noteTick: number; key: number }>;
}

export type VoiceStage = 'phonemes' | 'speaking' | 'syllables' | 'singing' | 'placing';

export interface VoiceProgress {
  stage: VoiceStage;
  fraction: number;
  message: string;
}

export const CONSENT_LINE = 'I am recording my own voice, and I agree to have it turned into an AI voice for my own music.';
