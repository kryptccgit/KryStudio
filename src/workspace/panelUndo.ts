// ──────────────────────────────────────────────────────────────────────
// "I closed the Channel Rack, pressed Ctrl+Z and it didn't come back."
// Ctrl+Z (edit.undo) first asks this module: when the newest user-closed
// panel was closed AFTER the newest live user edit of the active tab, it
// reopens that panel where it was instead of undoing the document.
// Ctrl+Shift+Z / Ctrl+Y never redo panel closes. Ordering rules live in
// ./closedPanels.ts (pure, tested).
// ──────────────────────────────────────────────────────────────────────

import { closedPanelTitle, wm } from './WindowManager';
import { decideUndo, newestUserEditAt } from './closedPanels';

/** Fallback when the history can't be read: the last user edit seen in the patch stream. */
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
      // A tab switch / open: plugin windows of channels the new project doesn't have can't come back.
      setTimeout(() => wm.pruneClosedPlugins(), 0);
    });
  } catch {
    /* no doc bridge (tests): the history read below still works */
  }
}

async function lastUserEditAt(): Promise<number | null> {
  try {
    return newestUserEditAt(await window.krypt.doc.history());
  } catch {
    return localEditAt;
  }
}

/** When was the newest panel the user closed (null = none that can come back). */
export function lastPanelClosedAt(): number | null {
  return wm.lastClosed()?.at ?? null;
}

/**
 * Ctrl+Z, step one. 'none': no panel close is newer than the last user edit (do the document undo).
 * Otherwise the panel came back ('reopened', with its title) or couldn't ('failed': the record is used up).
 */
export async function undoPanelClose(): Promise<{ result: 'none' } | { result: 'reopened' | 'failed'; title: string }> {
  if (!wm.lastClosed()) return { result: 'none' };
  const editAt = await lastUserEditAt();
  const rec = wm.lastClosed(); // re-read: something may have changed while the history was read
  if (!rec || decideUndo(rec.at, editAt) !== 'panel') return { result: 'none' };
  const title = closedPanelTitle(rec);
  return wm.reopenLastClosed() ? { result: 'reopened', title } : { result: 'failed', title };
}

/** Ctrl+Shift+T on a panel: reopen the newest closed one regardless of edits. */
export function reopenClosedPanel(): { title: string } | null {
  const rec = wm.lastClosed();
  if (!rec) return null;
  const title = closedPanelTitle(rec);
  return wm.reopenLastClosed() ? { title } : null;
}
