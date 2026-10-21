import { Pencil, Paintbrush, Eraser, SquareDashedMousePointer, Scissors, VolumeX, type LucideIcon } from 'lucide-react';

export type EditTool = 'draw' | 'paint' | 'delete' | 'select' | 'slice' | 'mute';

export const TOOLS: Record<EditTool, { label: string; key: string; code: string; icon: LucideIcon }> = {
  draw: { label: 'Draw', key: 'P', code: 'KeyP', icon: Pencil },
  paint: { label: 'Paint', key: 'B', code: 'KeyB', icon: Paintbrush },
  delete: { label: 'Delete', key: 'D', code: 'KeyD', icon: Eraser },
  select: { label: 'Select', key: 'E', code: 'KeyE', icon: SquareDashedMousePointer },
  slice: { label: 'Slice', key: 'C', code: 'KeyC', icon: Scissors },
  mute: { label: 'Mute', key: 'T', code: 'KeyT', icon: VolumeX },
};

export function toolForKey(e: KeyboardEvent, allowed: EditTool[]): EditTool | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return null;
  for (const t of allowed) if (TOOLS[t].code === e.code) return t;
  return null;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function isMod(e: KeyboardEvent | MouseEvent): boolean {
  return e.ctrlKey || e.metaKey;
}
