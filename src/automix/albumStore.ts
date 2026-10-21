import { create } from 'zustand';
import type { AlbumExportOutcome, AlbumOutcome, AutoMixProgress } from '@shared/automix/types';
import { NO_REFERENCE, type ReferenceState } from './logic';
import { DEFAULT_ALBUM_FORM, albumFormReducer, type AlbumExportFormat, type AlbumForm, type AlbumFormAction } from './albumLogic';

export type AlbumPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface AlbumState {
  form: AlbumForm;
  reference: ReferenceState;
  phase: AlbumPhase;
  progress: AutoMixProgress | null;
  outcome: AlbumOutcome | null;
  error: string | null;
  ab: 'after' | 'before';
  abBusy: boolean;
  verdict: 'open' | 'kept' | 'undone';
  refPlaying: boolean;
  selected: number | null;
  exportFormat: AlbumExportFormat;
  exporting: 'idle' | 'running' | 'cancelling';
  exportProgress: AutoMixProgress | null;
  exported: AlbumExportOutcome | null;
  visible: boolean;
  showReference: boolean;
  showMore: boolean;
}

const initial = (): AlbumState => ({
  form: { ...DEFAULT_ALBUM_FORM, songs: [] },
  reference: { ...NO_REFERENCE },
  phase: 'idle',
  progress: null,
  outcome: null,
  error: null,
  ab: 'after',
  abBusy: false,
  verdict: 'open',
  refPlaying: false,
  selected: null,
  exportFormat: 'wav24',
  exporting: 'idle',
  exportProgress: null,
  exported: null,
  visible: false,
  showReference: false,
  showMore: false,
});

export const useAlbum = create<AlbumState>(initial);

export function getAlbum(): AlbumState {
  return useAlbum.getState();
}

export function albumBusy(s: AlbumState = getAlbum()): boolean {
  return s.phase === 'running' || s.phase === 'cancelling' || s.exporting !== 'idle';
}

export function updateAlbumForm(act: AlbumFormAction): AlbumForm {
  const form = albumFormReducer(getAlbum().form, act);
  useAlbum.setState({ form });
  return form;
}

export function albumBackToForm(): void {
  useAlbum.setState({ phase: 'idle', progress: null, outcome: null, error: null, ab: 'after', abBusy: false, verdict: 'open', refPlaying: false, selected: null, exported: null, exportProgress: null });
}
