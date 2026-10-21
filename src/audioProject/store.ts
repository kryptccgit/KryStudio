// Audio → Project: the one conversion job (main runs one at a time), shared
// by the dialog, the File menu and Home. Closing the dialog doesn't stop it:
// opening Audio → Project again shows its progress.

import { create } from 'zustand';
import type { AudioProjectOptions, AudioProjectOutcome, AudioProjectProgress } from '@shared/types';
import type { JobPhase } from './logic';

export interface AudioProjectJob {
  phase: JobPhase;
  /** The dropped / chosen file; null while main's file dialog is open. */
  path: string | null;
  opts: AudioProjectOptions | null;
  progress: AudioProjectProgress | null;
  outcome: AudioProjectOutcome | null;
  error: string | null;
  /** The progress dialog is on screen (finished jobs toast only when it isn't). */
  visible: boolean;
}

const IDLE: AudioProjectJob = { phase: 'idle', path: null, opts: null, progress: null, outcome: null, error: null, visible: false };

export const useAudioProject = create<AudioProjectJob>(() => ({ ...IDLE }));

export function getJob(): AudioProjectJob {
  return useAudioProject.getState();
}

export function isBusy(j: AudioProjectJob = getJob()): boolean {
  return j.phase === 'running' || j.phase === 'cancelling';
}

export function resetJob(): void {
  useAudioProject.setState({ ...IDLE, visible: getJob().visible });
}

// ── The ownership note: once per session ──────────────────────────────

const OWNERSHIP_KEY = 'krypt.audioProject.ownershipShown';
let ownershipShown = false;

/** True the first time in this session (the page's lifetime, surviving hot reloads). */
export function ownershipNoteDue(): boolean {
  if (ownershipShown) return false;
  try {
    if (sessionStorage.getItem(OWNERSHIP_KEY) === '1') ownershipShown = true;
  } catch {
    /* no storage: the module flag alone decides */
  }
  return !ownershipShown;
}

export function markOwnershipNoteShown(): void {
  ownershipShown = true;
  try {
    sessionStorage.setItem(OWNERSHIP_KEY, '1');
  } catch {
    /* no storage: the module flag alone decides */
  }
}
