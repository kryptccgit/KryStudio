import { create } from 'zustand';
import type { AudioProjectOptions, AudioProjectOutcome, AudioProjectProgress } from '@shared/types';
import type { JobPhase } from './logic';

export interface AudioProjectJob {
  phase: JobPhase;
  path: string | null;
  opts: AudioProjectOptions | null;
  progress: AudioProjectProgress | null;
  outcome: AudioProjectOutcome | null;
  error: string | null;
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

const OWNERSHIP_KEY = 'krypt.audioProject.ownershipShown';
let ownershipShown = false;

export function ownershipNoteDue(): boolean {
  if (ownershipShown) return false;
  try {
    if (sessionStorage.getItem(OWNERSHIP_KEY) === '1') ownershipShown = true;
  } catch {
  }
  return !ownershipShown;
}

export function markOwnershipNoteShown(): void {
  ownershipShown = true;
  try {
    sessionStorage.setItem(OWNERSHIP_KEY, '1');
  } catch {
  }
}
