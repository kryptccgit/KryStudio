// Cross-panel editor selection (view state, NOT in the document).
// The shell owns the source of truth (`useUi.selectedChannelId` in
// src/state/ui.ts — the Channel Rack writes it). This module mirrors it as
// `useEditorSelection` so the editors have one small, stable dependency;
// setChannel() writes through to the shell store.
// null = "first instrument channel".

import { create } from 'zustand';
import type { Project } from '@shared/schema/project';
import { useUi } from '../state/ui';

interface EditorSelection {
  channelId: string | null;
  setChannel: (id: string | null) => void;
}

export const useEditorSelection = create<EditorSelection>(() => ({
  channelId: useUi.getState().selectedChannelId,
  setChannel: (id) => useUi.getState().selectChannel(id),
}));

useUi.subscribe((s) => {
  if (s.selectedChannelId !== useEditorSelection.getState().channelId) useEditorSelection.setState({ channelId: s.selectedChannelId });
});

/** Generator types that never take notes (audio-clip channels live on the playlist). */
export function isNoteChannel(p: Project, id: string): boolean {
  const ch = p.channels[id];
  return !!ch && ch.generator.type !== 'krypt.audioclip';
}

/** The channel the piano roll edits: the selected one if it still exists, else the first note channel. */
export function resolveChannel(p: Project | null, selected: string | null): string | null {
  if (!p) return null;
  if (selected && p.channels[selected]) return selected;
  return p.channelOrder.find((id) => isNoteChannel(p, id)) ?? p.channelOrder[0] ?? null;
}

/** Ask the shell to show/focus a panel (the shell listens for this event). */
export function openPanel(id: string): void {
  window.dispatchEvent(new CustomEvent('krypt:open-panel', { detail: id }));
}
