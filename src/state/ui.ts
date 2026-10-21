// ──────────────────────────────────────────────────────────────────────
// Renderer-only VIEW state (never in the project document): selection,
// rack view options, typing-piano state. Shared by the Channel Rack,
// Mixer, Piano Roll and the input layer.
//
//   const sel = useUi((s) => s.selectedChannelId);
//   getUi().selectChannel(id);
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { getProject, useDocStore } from '../doc/store';

export type GraphLane = 'off' | 'vel' | 'pan';

interface UiState {
  /** The channel the Piano Roll edits and the typing keyboard plays. */
  selectedChannelId: string | null;
  /** Mixer insert shown in the FX chain panel (and the routing source). */
  selectedInsertId: string | null;
  /** Channel Rack per-step graph editor lane. */
  graphLane: GraphLane;
  /** Typing keyboard → piano (FL Ctrl+T). */
  typingPiano: boolean;
  /** MIDI note of the Z key (C). 48 = C3 in MIDI-60=C4 terms. */
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

/** The selected channel, falling back to the first channel in the rack. */
export function effectiveChannelId(): string | null {
  const p = getProject();
  if (!p) return null;
  const sel = useUi.getState().selectedChannelId;
  if (sel && p.channels[sel]) return sel;
  return p.channelOrder[0] ?? null;
}

/** Keep selections valid when the document changes (deletes, new project). */
export function installSelectionGuard(): () => void {
  return useDocStore.subscribe((s, prev) => {
    if (s.project === prev.project || !s.project) return;
    const ui = useUi.getState();
    const p = s.project;
    if (ui.selectedChannelId && !p.channels[ui.selectedChannelId]) ui.selectChannel(p.channelOrder[0] ?? null);
    if (ui.selectedInsertId && !p.mixer.inserts[ui.selectedInsertId]) ui.selectInsert(p.mixer.masterId);
  });
}
