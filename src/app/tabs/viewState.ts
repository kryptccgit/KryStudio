export interface TabViewProvider {
  capture(): unknown;
  restore(v: unknown): void;
}

const providers = new Map<string, TabViewProvider>();
const memory = new Map<string, Record<string, unknown>>();

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

export function forgetTabViews(keep: ReadonlySet<string>): void {
  for (const id of [...memory.keys()]) if (!keep.has(id)) memory.delete(id);
}

export function hasTabView(tabId: string): boolean {
  return memory.has(tabId);
}
