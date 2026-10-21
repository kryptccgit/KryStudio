// ──────────────────────────────────────────────────────────────────────
// Project tab strip: the pure parts (research/19-project-tabs.md). Tab
// widths (shrink, then scroll), drag-to-reorder index math, keyboard tab
// navigation and when each closed tab went away. No React, no window:
// tested in test/tabs-ui.test.ts.
// ──────────────────────────────────────────────────────────────────────

import type { ProjectTab, TabsState } from '@shared/types';

export const TAB_MIN_W = 96;
export const TAB_MAX_W = 200;

/**
 * Width of each tab for `count` tabs in `available` px: as wide as fits, between `min` and `max`.
 * `scroll` is true when even the minimum width doesn't fit (the strip then scrolls sideways).
 */
export function tabLayout(count: number, available: number, min = TAB_MIN_W, max = TAB_MAX_W): { width: number; scroll: boolean } {
  if (count <= 0) return { width: max, scroll: false };
  const room = Math.max(0, Math.floor(available));
  const fit = Math.floor(room / count);
  const width = Math.max(min, Math.min(max, fit));
  return { width, scroll: count * min > room };
}

/**
 * Where a dragged tab lands: its index in the FINAL order (the list without it, then it inserted).
 * `mids` are the tabs' horizontal centres in their current order, `x` the pointer, `from` the dragged tab's index.
 */
export function dropIndex(mids: readonly number[], x: number, from: number): number {
  let i = 0;
  for (let k = 0; k < mids.length; k++) {
    if (k === from) continue;
    if (mids[k] < x) i++;
  }
  return i;
}

/** The order after moving `id` to `toIndex` (final index, clamped). Unknown id → unchanged copy. */
export function moveTab<T extends { id: string }>(tabs: readonly T[], id: string, toIndex: number): T[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return tabs.slice();
  const out = tabs.slice();
  const [t] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, toIndex)), 0, t);
  return out;
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the next / previous tab, wrapping around. null with fewer than two tabs. */
export function stepTabId(s: Pick<TabsState, 'tabs' | 'activeId'>, dir: 1 | -1): string | null {
  const n = s.tabs.length;
  if (n < 2) return null;
  const i = Math.max(0, s.tabs.findIndex((t) => t.id === s.activeId));
  return s.tabs[(i + dir + n) % n].id;
}

/** Ctrl+1 … Ctrl+8 go to that tab; Ctrl+9 goes to the LAST tab (the browser convention). null when there's no such tab. */
export function tabForDigit(tabs: readonly Pick<ProjectTab, 'id'>[], digit: number): string | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || !tabs.length) return null;
  if (digit === 9) return tabs[tabs.length - 1].id;
  return tabs[digit - 1]?.id ?? null;
}

/** "Close others": every tab but `keepId`, in strip order. */
export function othersOf(tabs: readonly Pick<ProjectTab, 'id'>[], keepId: string): string[] {
  return tabs.filter((t) => t.id !== keepId).map((t) => t.id);
}

/**
 * When each recently closed tab went away (renderer clock), for Ctrl+Shift+T's "newest closed thing".
 * Ids new to `closedIds` get `now`; ids no longer listed are forgotten; ids listed in the very first
 * state (closed before this window existed) count as old (0).
 */
export function trackClosedTimes(prev: ReadonlyMap<string, number> | null, closedIds: readonly string[], now: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const id of closedIds) next.set(id, prev ? prev.get(id) ?? now : 0);
  return next;
}

/** Newest close time among the listed closed tabs (null when none). */
export function newestClosedAt(times: ReadonlyMap<string, number>): number | null {
  let best: number | null = null;
  for (const t of times.values()) if (best === null || t > best) best = t;
  return best;
}

/** Tooltip / status-bar hint for a tab. */
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
