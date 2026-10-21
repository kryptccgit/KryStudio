// Auto Mashup: the dialog's form, the latest check and the one build job
// (main runs one at a time), shared by the dialog, Home, the Tools menu and
// the playlist clip menu. Closing the dialog keeps the form and a running
// build: opening Auto Mashup again shows them.

import { create } from 'zustand';
import type { MashupCheck, MashupOutcome, MashupProgress, MashupRequest } from '@shared/mashup/types';
import { DEFAULT_FORM, DEFAULT_STEMS, formReducer, type FormAction, type JobPhase, type MashupForm, type Song } from './logic';

export interface CheckState {
  status: 'idle' | 'checking' | 'ready' | 'failed';
  /** requestKey of the request the result (or the running check) belongs to. */
  key: string | null;
  result: MashupCheck | null;
  error: string | null;
}

export interface MashupState {
  form: MashupForm;
  check: CheckState;
  phase: JobPhase;
  /** The request the build runs with. */
  request: MashupRequest | null;
  progress: MashupProgress | null;
  outcome: MashupOutcome | null;
  error: string | null;
  /** The dialog is on screen (a finished build toasts only when it isn't). */
  visible: boolean;
  /** The reference-library picker is open for this slot. */
  picking: Song | null;
}

export const IDLE_CHECK: CheckState = { status: 'idle', key: null, result: null, error: null };

const initial = (): MashupState => ({
  form: { ...DEFAULT_FORM, stems: { ...DEFAULT_STEMS } },
  check: { ...IDLE_CHECK },
  phase: 'idle',
  request: null,
  progress: null,
  outcome: null,
  error: null,
  visible: false,
  picking: null,
});

export const useMashup = create<MashupState>(initial);

export function getMashup(): MashupState {
  return useMashup.getState();
}

export function isBuilding(s: MashupState = getMashup()): boolean {
  return s.phase === 'running' || s.phase === 'cancelling';
}

export function updateForm(act: FormAction): MashupForm {
  const form = formReducer(getMashup().form, act);
  useMashup.setState({ form });
  return form;
}

/** Back to the form after a finished / failed / cancelled build (the songs and options stay). */
export function backToForm(): void {
  useMashup.setState({ phase: 'idle', progress: null, outcome: null, error: null });
}

/** Clear everything but the dialog's visibility. */
export function resetMashup(): void {
  useMashup.setState({ ...initial(), visible: getMashup().visible });
}
