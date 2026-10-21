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
  ab: 'after' | 'before';
  abBusy: boolean;
  verdict: 'open' | 'kept' | 'undone';
  visible: boolean;
  reference: ReferenceState;
  refPlaying: boolean;
  song: SongPick;
  runSong: string | null;
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

export function backToForm(): void {
  useAutoMix.setState({ phase: 'idle', progress: null, outcome: null, error: null, ab: 'after', abBusy: false, verdict: 'open', refPlaying: false });
}

export function resetAutoMix(): void {
  const s = getAutoMix();
  useAutoMix.setState({ ...initial(), visible: s.visible, presets: s.presets, reference: s.reference, song: s.song, showReference: s.showReference, showMore: s.showMore });
}
