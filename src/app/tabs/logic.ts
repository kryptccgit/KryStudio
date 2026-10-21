import type { ProjectTab, TabsState } from '@shared/types';

export const TAB_MIN_W = 96;
export const TAB_MAX_W = 200;

export function tabLayout(count: number, available: number, min = TAB_MIN_W, max = TAB_MAX_W): { width: number; scroll: boolean } {
  if (count <= 0) return { width: max, scroll: false };
  const room = Math.max(0, Math.floor(available));
  const fit = Math.floor(room / count);
  const width = Math.max(min, Math.min(max, fit));
  return { width, scroll: count * min > room };
}

export function dropIndex(mids: readonly number[], x: number, from: number): number {
  let i = 0;
  for (let k = 0; k < mids.length; k++) {
    if (k === from) continue;
    if (mids[k] < x) i++;
  }
  return i;
}

export function moveTab<T extends { id: string }>(tabs: readonly T[], id: string, toIndex: number): T[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return tabs.slice();
  const out = tabs.slice();
  const [t] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, toIndex)), 0, t);
  return out;
}

export function stepTabId(s: Pick<TabsState, 'tabs' | 'activeId'>, dir: 1 | -1): string | null {
  const n = s.tabs.length;
  if (n < 2) return null;
  const i = Math.max(0, s.tabs.findIndex((t) => t.id === s.activeId));
  return s.tabs[(i + dir + n) % n].id;
}

export function tabForDigit(tabs: readonly Pick<ProjectTab, 'id'>[], digit: number): string | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || !tabs.length) return null;
  if (digit === 9) return tabs[tabs.length - 1].id;
  return tabs[digit - 1]?.id ?? null;
}

export function othersOf(tabs: readonly Pick<ProjectTab, 'id'>[], keepId: string): string[] {
  return tabs.filter((t) => t.id !== keepId).map((t) => t.id);
}

export function trackClosedTimes(prev: ReadonlyMap<string, number> | null, closedIds: readonly string[], now: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const id of closedIds) next.set(id, prev ? prev.get(id) ?? now : 0);
  return next;
}

export function newestClosedAt(times: ReadonlyMap<string, number>): number | null {
  let best: number | null = null;
  for (const t of times.values()) if (best === null || t > best) best = t;
  return best;
}

export function tabHint(t: ProjectTab, active: boolean, closeKey?: string): string {
  const parts = [t.title];
  if (t.path) parts.push(t.path);
  else parts.push('not saved yet');
  if (t.dirty) parts.push('unsaved changes');
  if (t.busy) parts.push(t.busy);
  const tail = active
    ? `Middle-click${closeKey ? ` or ${closeKey}` : ''} closes, drag to reorder, right-click for more`
    : 'Click to switch, middle-click closes, drag to reorder, right-click for more';
  return `${parts.join(' · ')}. ${tail}`;
}
