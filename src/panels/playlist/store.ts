// Playlist view state (not undoable, not in the document).

import { create } from 'zustand';
import type { SnapId } from '../../editors/snap';
import type { EditTool } from '../../editors/tools';

export const PL_TOOLS: EditTool[] = ['draw', 'paint', 'delete', 'select', 'slice', 'mute'];

export interface PlaylistView {
  tool: EditTool;
  snap: SnapId;
  /** Vertical zoom applied to every track's persisted height. */
  laneScale: number;
  pickerOpen: boolean;
  /** Auto-scroll page-wise to keep the playhead in view while the song plays (FL). */
  follow: boolean;
  set: (patch: Partial<Omit<PlaylistView, 'set'>>) => void;
}

export const usePlaylistView = create<PlaylistView>((set) => ({
  tool: 'draw',
  snap: 'beat',
  laneScale: 1,
  pickerOpen: true,
  follow: true,
  set: (patch) => set(patch),
}));
