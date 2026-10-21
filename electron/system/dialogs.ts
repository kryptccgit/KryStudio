// Native dialogs: file pickers resolve to plain paths (or null on cancel),
// questions to the answer. None of them throws.

import fs from 'node:fs';
import { app, BrowserWindow, dialog, type FileFilter } from 'electron';

/**
 * End-to-end tests only (never in a packaged build): KRYPT_E2E_DIALOGS names a JSON file holding a queue of
 * answers for the file pickers (each a path list, a path, or null = cancelled). The test appends answers while
 * the app runs; each picker takes the first one. An empty / missing queue falls through to the real dialog.
 */
function e2eAnswer(): { hit: boolean; value: string[] | null } {
  const file = process.env.KRYPT_E2E_DIALOGS;
  if (!file || app.isPackaged) return { hit: false, value: null };
  try {
    const q: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(q) || !q.length) return { hit: false, value: null };
    const [head, ...rest] = q;
    fs.writeFileSync(file, JSON.stringify(rest));
    const v = typeof head === 'string' ? [head] : Array.isArray(head) ? head.filter((x): x is string => typeof x === 'string') : null;
    return { hit: true, value: v && v.length ? v : null };
  } catch {
    return { hit: false, value: null };
  }
}

function parent(win?: BrowserWindow | null): BrowserWindow | null {
  const w = win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  return w && !w.isDestroyed() ? w : null;
}

export async function openFiles(opts: {
  title?: string;
  filters?: FileFilter[];
  multi?: boolean;
  defaultPath?: string;
  win?: BrowserWindow | null;
}): Promise<string[] | null> {
  const t = e2eAnswer();
  if (t.hit) return t.value && !opts.multi ? t.value.slice(0, 1) : t.value;
  try {
    const props: Array<'openFile' | 'multiSelections'> = ['openFile'];
    if (opts.multi) props.push('multiSelections');
    const o = { title: opts.title, filters: opts.filters, defaultPath: opts.defaultPath, properties: props };
    const w = parent(opts.win);
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths;
  } catch {
    return null;
  }
}

export async function saveFile(opts: {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  win?: BrowserWindow | null;
}): Promise<string | null> {
  const t = e2eAnswer();
  if (t.hit) return t.value?.[0] ?? null;
  try {
    const o = { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties: ['showOverwriteConfirmation' as const] };
    const w = parent(opts.win);
    const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
    return r.canceled || !r.filePath ? null : r.filePath;
  } catch {
    return null;
  }
}

export async function pickDirectory(opts: { title?: string; defaultPath?: string; win?: BrowserWindow | null }): Promise<string | null> {
  const t = e2eAnswer();
  if (t.hit) return t.value?.[0] ?? null;
  try {
    const o = { title: opts.title, defaultPath: opts.defaultPath, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const w = parent(opts.win);
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  } catch {
    return null;
  }
}

/**
 * A permission question ("Claude Code wants to use song.mp3"): resolves with the index of the button pressed,
 * or null when it couldn't be shown. Parented to the main window, which comes forward WITHOUT taking focus from
 * the app the user is in (it is shown inactive if minimized or hidden) and flashes in the taskbar until the
 * question is answered. `signal` closes the box as if cancelled (cancelId).
 */
export async function askPermission(opts: {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  signal?: AbortSignal;
  win?: BrowserWindow | null;
}): Promise<number | null> {
  const w = parent(opts.win);
  try {
    if (w) {
      if (w.isMinimized() || !w.isVisible()) w.showInactive();
      w.flashFrame(true);
    }
    const o = { type: 'question' as const, title: opts.title, message: opts.message, detail: opts.detail, buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId, noLink: true, signal: opts.signal };
    const r = w ? await dialog.showMessageBox(w, o) : await dialog.showMessageBox(o);
    return r.response;
  } catch {
    return null;
  } finally {
    if (w && !w.isDestroyed()) w.flashFrame(false);
  }
}

/** Save / Don't save / Cancel prompt for unsaved changes. */
export async function confirmUnsaved(name: string, win?: BrowserWindow | null): Promise<'save' | 'discard' | 'cancel'> {
  try {
    const o = {
      type: 'warning' as const,
      title: 'Unsaved changes',
      message: `Save changes to "${name}" before closing?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const w = parent(win);
    const r = w ? await dialog.showMessageBox(w, o) : await dialog.showMessageBox(o);
    return r.response === 0 ? 'save' : r.response === 1 ? 'discard' : 'cancel';
  } catch {
    return 'cancel';
  }
}
