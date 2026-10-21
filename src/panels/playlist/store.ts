import { create } from 'zustand';
import type { SnapId } from '../../editors/snap';
import type { EditTool } from '../../editors/tools';

export const PL_TOOLS: EditTool[] = ['draw', 'paint', 'delete', 'select', 'slice', 'mute'];

export interface PlaylistView {
  tool: EditTool;
  snap: SnapId;
  laneScale: number;
  pickerOpen: boolean;
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
