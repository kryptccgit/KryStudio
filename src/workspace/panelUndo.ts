import { closedPanelTitle, wm } from './WindowManager';
import { decideUndo, newestUserEditAt } from './closedPanels';

let localEditAt: number | null = null;
let installed = false;

export function installPanelUndo(): void {
  if (installed) return;
  installed = true;
  try {
    window.krypt.doc.onPatches((m) => {
      if (m.kind === 'exec' && m.actor.kind === 'user') localEditAt = Date.now();
    });
    window.krypt.doc.onReset(() => {
      localEditAt = null;
      setTimeout(() => wm.pruneClosedPlugins(), 0);
    });
  } catch {
  }
}

async function lastUserEditAt(): Promise<number | null> {
  try {
    return newestUserEditAt(await window.krypt.doc.history());
  } catch {
    return localEditAt;
  }
}

export function lastPanelClosedAt(): number | null {
  return wm.lastClosed()?.at ?? null;
}

export async function undoPanelClose(): Promise<{ result: 'none' } | { result: 'reopened' | 'failed'; title: string }> {
  if (!wm.lastClosed()) return { result: 'none' };
  const editAt = await lastUserEditAt();
  const rec = wm.lastClosed();
  if (!rec || decideUndo(rec.at, editAt) !== 'panel') return { result: 'none' };
  const title = closedPanelTitle(rec);
  return wm.reopenLastClosed() ? { result: 'reopened', title } : { result: 'failed', title };
}

export function reopenClosedPanel(): { title: string } | null {
  const rec = wm.lastClosed();
  if (!rec) return null;
  const title = closedPanelTitle(rec);
  return wm.reopenLastClosed() ? { title } : null;
}
