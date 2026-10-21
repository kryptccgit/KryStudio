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

export function isNoteChannel(p: Project, id: string): boolean {
  const ch = p.channels[id];
  return !!ch && ch.generator.type !== 'krypt.audioclip';
}

export function resolveChannel(p: Project | null, selected: string | null): string | null {
  if (!p) return null;
  if (selected && p.channels[selected]) return selected;
  return p.channelOrder.find((id) => isNoteChannel(p, id)) ?? p.channelOrder[0] ?? null;
}

export function openPanel(id: string): void {
  window.dispatchEvent(new CustomEvent('krypt:open-panel', { detail: id }));
}
