import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { ActionResult, BrowserEntry, BrowserRoot, Settings } from '@shared/types';
import { describeFsError, isDir, isInside, listDirectory } from './system/files';
import * as dialogs from './system/dialogs';

export interface BrowserDeps {
  factoryDir: string;
  demosDir?: string;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
}

export const FACTORY_ROOT_ID = 'factory';
export const DEMOS_ROOT_ID = 'demos';

export function browserRoots(d: BrowserDeps): BrowserRoot[] {
  const roots: BrowserRoot[] = [];
  if (isDir(d.factoryDir)) roots.push({ id: FACTORY_ROOT_ID, name: 'Factory kit', path: d.factoryDir, builtin: true });
  if (d.demosDir && isDir(d.demosDir)) roots.push({ id: DEMOS_ROOT_ID, name: 'Demo projects', path: d.demosDir, builtin: true });
  for (const r of d.getSettings().browserRoots) roots.push({ id: r.id, name: r.name, path: r.path, builtin: false });
  return roots;
}

export async function listInRoots(d: BrowserDeps, dir: string): Promise<ActionResult<BrowserEntry[]>> {
  if (typeof dir !== 'string' || !dir) return { ok: false, message: 'No folder given' };
  const roots = browserRoots(d);
  if (!roots.some((r) => isInside(r.path, dir))) return { ok: false, message: "That folder isn't in the browser. Add it with \"Add folder\" first." };
  try {
    return { ok: true, data: await listDirectory(dir) };
  } catch (err) {
    return { ok: false, message: `Couldn't list ${path.basename(dir) || dir}: ${describeFsError(err, dir)}` };
  }
}

export async function addRoot(d: BrowserDeps, win?: BrowserWindow | null): Promise<ActionResult<BrowserRoot>> {
  const dir = await dialogs.pickDirectory({ title: 'Add a folder to the browser', win });
  if (!dir) return { ok: false, message: 'Cancelled' };
  const existing = browserRoots(d).find((r) => path.resolve(r.path).toLowerCase() === path.resolve(dir).toLowerCase());
  if (existing) return { ok: true, message: `"${existing.name}" is already in the browser`, data: existing };
  const root = { id: `root_${randomUUID().slice(0, 8)}`, name: path.basename(dir) || dir, path: dir };
  d.updateSettings({ browserRoots: [...d.getSettings().browserRoots, root] });
  return { ok: true, message: `Added "${root.name}" to the browser`, data: { ...root, builtin: false } };
}

export function removeRoot(d: BrowserDeps, id: string): ActionResult {
  if (id === FACTORY_ROOT_ID) return { ok: false, message: "The factory kit can't be removed" };
  if (id === DEMOS_ROOT_ID) return { ok: false, message: "The demo projects can't be removed" };
  const roots = d.getSettings().browserRoots;
  const r = roots.find((x) => x.id === id);
  if (!r) return { ok: false, message: 'That folder is no longer in the browser' };
  d.updateSettings({ browserRoots: roots.filter((x) => x.id !== id) });
  return { ok: true, message: `Removed "${r.name}" from the browser` };
}
