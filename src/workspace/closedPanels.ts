// ──────────────────────────────────────────────────────────────────────
// Closed-panel memory for "Ctrl+Z reopens the window I just closed"
// (research/19-project-tabs.md, panel undo). The WindowManager records
// every panel the USER closes (id, kind, plugin target, where it was);
// Ctrl+Z compares the newest close with the newest live user edit in the
// active tab's history and reopens the panel when the close is newer.
// Pure: no dockview, no window. Tested in test/tabs-ui.test.ts.
// ──────────────────────────────────────────────────────────────────────

import type { PanelKind, PluginTarget } from './panels';

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export type DockDirection = 'within' | 'left' | 'right' | 'above' | 'below';

export type ClosedPlacement =
  /** Floating over the workspace (bounds null = it was in its own OS window: reopen at the default spot). */
  | { mode: 'floating'; bounds: Bounds | null }
  /**
   * Docked: `direction` is where the panel sat relative to `neighbour` (a panel id); null = no neighbour known.
   * `size`: its width (left / right) or height (above / below); for 'within', its tab index in that group.
   */
  | { mode: 'docked'; neighbour: string | null; direction: DockDirection; size?: number };

export interface ClosedPanel {
  id: string;
  kind: PanelKind;
  target?: PluginTarget;
  placement: ClosedPlacement;
  /** Date.now() when it was closed. */
  at: number;
}

export const MAX_CLOSED_PANELS = 20;

/** Newest-last stack of closed panels; one record per panel id (closing it again replaces the old one). */
export class ClosedPanels {
  private list: ClosedPanel[] = [];

  push(rec: ClosedPanel): void {
    this.list = this.list.filter((r) => r.id !== rec.id);
    this.list.push(rec);
    if (this.list.length > MAX_CLOSED_PANELS) this.list.splice(0, this.list.length - MAX_CLOSED_PANELS);
  }

  newest(): ClosedPanel | null {
    return this.list[this.list.length - 1] ?? null;
  }

  /** Newest record `ok` accepts (older dead ones stay: an undo may bring their channel back). */
  newestWhere(ok: (r: ClosedPanel) => boolean): ClosedPanel | null {
    for (let i = this.list.length - 1; i >= 0; i--) if (ok(this.list[i])) return this.list[i];
    return null;
  }

  pop(): ClosedPanel | null {
    return this.list.pop() ?? null;
  }

  /** Forget a panel (it was opened again some other way). */
  drop(id: string): void {
    this.list = this.list.filter((r) => r.id !== id);
  }

  /** Forget every record `dead` says can't come back (e.g. a plugin window whose channel is gone). */
  prune(dead: (r: ClosedPanel) => boolean): number {
    const before = this.list.length;
    this.list = this.list.filter((r) => !dead(r));
    return before - this.list.length;
  }

  get size(): number {
    return this.list.length;
  }

  all(): readonly ClosedPanel[] {
    return this.list;
  }
}

/**
 * Ctrl+Z: reopen the panel when its close is the newest of {last panel close, last live user edit}; otherwise
 * the normal document undo. A close and an edit at the same millisecond count as the close (it's the visible one).
 */
export function decideUndo(panelClosedAt: number | null, lastUserEditAt: number | null): 'panel' | 'doc' {
  if (panelClosedAt === null) return 'doc';
  if (lastUserEditAt === null) return 'panel';
  return panelClosedAt >= lastUserEditAt ? 'panel' : 'doc';
}

/** Time of the newest user edit that Ctrl+Z would undo (not undone, actor "user"); null when there is none. */
export function newestUserEditAt(history: ReadonlyArray<{ actorKey: string; undone: boolean; time: number }>): number | null {
  let best: number | null = null;
  for (const e of history) {
    if (e.undone || e.actorKey !== 'user') continue;
    if (best === null || e.time > best) best = e.time;
  }
  return best;
}

/** Ctrl+Shift+T: reopen whichever was closed last, a panel or a project tab. */
export function pickReopen(panelClosedAt: number | null, tabClosedAt: number | null): 'panel' | 'tab' | null {
  if (panelClosedAt === null && tabClosedAt === null) return null;
  if (tabClosedAt === null) return 'panel';
  if (panelClosedAt === null) return 'tab';
  return panelClosedAt >= tabClosedAt ? 'panel' : 'tab';
}

/**
 * Where a docked panel that was alone in its group sat: the adjacent grid group sharing the longest edge with it.
 * `direction` is the panel's side of that neighbour (it was to the 'right' of the neighbour, …), `size` its width
 * (left / right) or height (above / below) so it comes back the same size. null when nothing touches it.
 */
export function dockNeighbour(self: Rect, others: ReadonlyArray<{ id: string; rect: Rect }>, tol = 8): { id: string; direction: Exclude<DockDirection, 'within'>; size: number } | null {
  const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);
  const w = self.right - self.left;
  const h = self.bottom - self.top;
  const cands: Array<{ id: string; direction: Exclude<DockDirection, 'within'>; score: number }> = [];
  for (const o of others) {
    const r = o.rect;
    const vert = overlap(self.top, self.bottom, r.top, r.bottom);
    const horiz = overlap(self.left, self.right, r.left, r.right);
    if (Math.abs(r.right - self.left) <= tol) cands.push({ id: o.id, direction: 'right', score: vert });
    if (Math.abs(self.right - r.left) <= tol) cands.push({ id: o.id, direction: 'left', score: vert });
    if (Math.abs(r.bottom - self.top) <= tol) cands.push({ id: o.id, direction: 'below', score: horiz });
    if (Math.abs(self.bottom - r.top) <= tol) cands.push({ id: o.id, direction: 'above', score: horiz });
  }
  let best: (typeof cands)[number] | null = null;
  for (const c of cands) if (c.score > tol && (!best || c.score > best.score)) best = c; // a corner touch isn't a shared edge
  if (!best) return null;
  const size = Math.round(best.direction === 'left' || best.direction === 'right' ? w : h);
  return { id: best.id, direction: best.direction, size };
}
