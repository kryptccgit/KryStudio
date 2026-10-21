import { create } from 'zustand';
import { getProject, useDocStore } from '../doc/store';

export type GraphLane = 'off' | 'vel' | 'pan';

interface UiState {
  selectedChannelId: string | null;
  selectedInsertId: string | null;
  graphLane: GraphLane;
  typingPiano: boolean;
  typingBaseKey: number;
  typingVelocity: number;
  selectChannel: (id: string | null) => void;
  selectInsert: (id: string | null) => void;
  setGraphLane: (lane: GraphLane) => void;
  setTypingPiano: (on: boolean) => void;
  shiftTypingOctave: (delta: number) => void;
}

export const useUi = create<UiState>((set) => ({
  selectedChannelId: null,
  selectedInsertId: null,
  graphLane: 'off',
  typingPiano: true,
  typingBaseKey: 48,
  typingVelocity: 0.78,
  selectChannel: (id) => set({ selectedChannelId: id }),
  selectInsert: (id) => set({ selectedInsertId: id }),
  setGraphLane: (graphLane) => set({ graphLane }),
  setTypingPiano: (typingPiano) => set({ typingPiano }),
  shiftTypingOctave: (delta) => set((s) => ({ typingBaseKey: Math.max(0, Math.min(108, s.typingBaseKey + delta * 12)) })),
}));

export function getUi(): UiState {
  return useUi.getState();
}

export function effectiveChannelId(): string | null {
  const p = getProject();
  if (!p) return null;
  const sel = useUi.getState().selectedChannelId;
  if (sel && p.channels[sel]) return sel;
  return p.channelOrder[0] ?? null;
}

export function installSelectionGuard(): () => void {
  return useDocStore.subscribe((s, prev) => {
    if (s.project === prev.project || !s.project) return;
    const ui = useUi.getState();
    const p = s.project;
    if (ui.selectedChannelId && !p.channels[ui.selectedChannelId]) ui.selectChannel(p.channelOrder[0] ?? null);
    if (ui.selectedInsertId && !p.mixer.inserts[ui.selectedInsertId]) ui.selectInsert(p.mixer.masterId);
  });
}
