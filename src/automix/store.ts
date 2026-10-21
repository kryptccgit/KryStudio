// Auto Mix: the dialog's form, the presets, the live prompt reading, and the
// one run (main runs one at a time) with its result, A/B state and verdict.
// Shared by the dialog, the Mixer buttons, the Tools menu, Home and the
// playlist clip menu. Closing the dialog keeps the form and a running job.

import { create } from 'zustand';
import type { AutoMixIntent, AutoMixOutcome, AutoMixPreset, AutoMixProgress } from '@shared/automix/types';
import { DEFAULT_FORM, NO_REFERENCE, NO_SONG, formReducer, type AutoMixForm, type AutoMixTarget, type FormAction, type JobPhase, type ReferenceState, type SongPick } from './logic';

export interface PresetsState {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  list: AutoMixPreset[];
  error: string | null;
}

export interface UnderstandState {
  status: 'idle' | 'busy' | 'ready' | 'failed';
  /** The prompt the intent (or the running request) belongs to. */
  text: string;
  intent: AutoMixIntent | null;
  error: string | null;
}

export interface AutoMixState {
  target: AutoMixTarget;
  form: AutoMixForm;
  presets: PresetsState;
  understand: UnderstandState;
  phase: JobPhase;
  progress: AutoMixProgress | null;
  outcome: AutoMixOutcome | null;
  error: string | null;
  /** A/B: which version is applied right now ('after' = the Auto Mix step is on). */
  ab: 'after' | 'before';
  abBusy: boolean;
  /** What the user decided about the result. */
  verdict: 'open' | 'kept' | 'undone';
  /** The dialog is on screen (a finished run toasts with a Show button only when it isn't). */
  visible: boolean;
  /** The reference song (master / full, Master a song): picked, being read, read, or failed. */
  reference: ReferenceState;
  /** The result's A/B is playing the reference (loudness-matched) instead of the song. */
  refPlaying: boolean;
  /** Master a song, step ①: the song chosen (picking never runs anything). */
  song: SongPick;
  /** The song name of the run on screen (the progress and the result say it). */
  runSong: string | null;
  /** Master a song: step ③ (the reference) and "More options" are folded away until opened (a guide's Show me opens them). */
  showReference: boolean;
  showMore: boolean;
}

export const IDLE_UNDERSTAND: UnderstandState = { status: 'idle', text: '', intent: null, error: null };

const initial = (): AutoMixState => ({
  target: 'project',
  form: { ...DEFAULT_FORM },
  presets: { status: 'idle', list: [], error: null },
  understand: { ...IDLE_UNDERSTAND },
  phase: 'idle',
  progress: null,
  outcome: null,
  error: null,
  ab: 'after',
  abBusy: false,
  verdict: 'open',
  visible: false,
  reference: { ...NO_REFERENCE },
  refPlaying: false,
  song: { ...NO_SONG },
  runSong: null,
  showReference: false,
  showMore: false,
});

export const useAutoMix = create<AutoMixState>(initial);

export function getAutoMix(): AutoMixState {
  return useAutoMix.getState();
}

export function isRunning(s: AutoMixState = getAutoMix()): boolean {
  return s.phase === 'running' || s.phase === 'cancelling';
}

export function updateForm(act: FormAction): AutoMixForm {
  const form = formReducer(getAutoMix().form, act);
  useAutoMix.setState({ form });
  return form;
}

/** Back to the form after a finished / failed / cancelled run (the options stay). */
export function backToForm(): void {
  useAutoMix.setState({ phase: 'idle', progress: null, outcome: null, error: null, ab: 'after', abBusy: false, verdict: 'open', refPlaying: false });
}

export function resetAutoMix(): void {
  const s = getAutoMix();
  useAutoMix.setState({ ...initial(), visible: s.visible, presets: s.presets, reference: s.reference, song: s.song, showReference: s.showReference, showMore: s.showMore });
}
