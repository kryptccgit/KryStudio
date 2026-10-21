// ──────────────────────────────────────────────────────────────────────
// Per-tab view state (research/19-project-tabs.md): selection, playlist
// scroll / zoom. Each editor registers a provider; on a tab switch the
// strip captures the old tab's view and, once the new project is in the
// replica, restores the new tab's (or resets it to the start for a tab
// never seen). Renderer memory only: gone after a restart, like zoom.
// No React, no window at import time.
// ──────────────────────────────────────────────────────────────────────

export interface TabViewProvider {
  capture(): unknown;
  /** `v` is undefined for a tab with nothing remembered: reset to a safe default. Must tolerate stale ids. */
  restore(v: unknown): void;
}

const providers = new Map<string, TabViewProvider>();
const memory = new Map<string, Record<string, unknown>>();

/** Register a view provider under `key` (one per editor); returns the unregister function. */
export function registerTabView(key: string, p: TabViewProvider): () => void {
  providers.set(key, p);
  return () => {
    if (providers.get(key) === p) providers.delete(key);
  };
}

export function captureTabView(tabId: string): void {
  const snap: Record<string, unknown> = {};
  for (const [key, p] of providers) {
    try {
      snap[key] = p.capture();
    } catch {
      /* a view that can't be captured just resets */
    }
  }
  memory.set(tabId, snap);
}

export function restoreTabView(tabId: string): void {
  const snap = memory.get(tabId);
  for (const [key, p] of providers) {
    try {
      p.restore(snap?.[key]);
    } catch (err) {
      console.warn(`[tabs] couldn't restore the ${key} view`, err);
    }
  }
}

/** Drop memory of tabs that are neither open nor reopenable. */
export function forgetTabViews(keep: ReadonlySet<string>): void {
  for (const id of [...memory.keys()]) if (!keep.has(id)) memory.delete(id);
}

export function hasTabView(tabId: string): boolean {
  return memory.has(tabId);
}
