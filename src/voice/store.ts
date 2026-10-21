// Krypt Voice renderer state: the voice service snapshot (voices, Kokoro, Fish key), the Speak and Sing forms
// (kept while the dialogs are closed), and the one voice job main runs at a time, with its progress and result.

import { create } from 'zustand';
import type { SingOutcome, SpeakOutcome, VoiceProgress, VoiceState } from '@shared/voice/types';
import { DEFAULT_SING, DEFAULT_SPEAK, type JobKind, type JobPhase, type SingForm, type SpeakForm } from './logic';

export interface VoiceJob {
  kind: JobKind;
  preview: boolean;
  phase: JobPhase;
  progress: VoiceProgress | null;
  outcome: SpeakOutcome | SingOutcome | null;
  error: string | null;
}

export interface VoiceStore {
  state: VoiceState | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  stateError: string | null;
  speak: SpeakForm;
  sing: SingForm;
  job: VoiceJob | null;
  /** The last finished sing's mapping (syllable → note), shown in the panel and on the roll. */
  lastMapping: SingOutcome['mapping'] | null;
  /** The rendered file playing as a preview (Stop button), or null. */
  previewing: string | null;
  /** The Krypt Voice dialog is on screen. */
  visible: boolean;
}

export const useVoice = create<VoiceStore>(() => ({
  state: null,
  status: 'idle',
  stateError: null,
  speak: { ...DEFAULT_SPEAK, placement: { ...DEFAULT_SPEAK.placement } },
  sing: { ...DEFAULT_SING },
  job: null,
  lastMapping: null,
  previewing: null,
  visible: false,
}));

export function getVoice(): VoiceStore {
  return useVoice.getState();
}

export function isBusy(s: VoiceStore = getVoice()): boolean {
  return s.job?.phase === 'running' || s.job?.phase === 'cancelling';
}

export function setSpeak(patch: Partial<SpeakForm>): void {
  useVoice.setState((s) => ({ speak: { ...s.speak, ...patch } }));
}

export function setSing(patch: Partial<SingForm>): void {
  useVoice.setState((s) => ({ sing: { ...s.sing, ...patch } }));
}

export function clearJob(): void {
  if (!isBusy()) useVoice.setState({ job: null });
}
