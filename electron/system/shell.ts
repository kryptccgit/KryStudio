// Shell integration: external links and "show in folder". Only web/mail
// links may leave the app; file:, ms-*: and other protocol handlers are an
// execution vector.

import { shell } from 'electron';
import { exists } from './files';
import { isOfficialDestination, resolveClientContext } from './context';

const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

export function isExternalUrl(url: string): boolean {
  try {
    return EXTERNAL.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export async function openExternal(url: string): Promise<{ ok: boolean; message?: string }> {
  if (!isExternalUrl(url)) return { ok: false, message: `Refusing to open "${url}" (only http/https/mailto links)` };
  // [PROTECTION] §9.5 coupling: a degraded (rebranded) build has no official support links.
  if (!resolveClientContext().intact && isOfficialDestination(url)) return { ok: false, message: "That link isn't available in this build." };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Couldn't open the link: ${(err as Error).message}` };
  }
}

export function showItemInFolder(p: string): { ok: boolean; message?: string } {
  if (!p || !exists(p)) return { ok: false, message: `Not found: ${p}` };
  shell.showItemInFolder(p);
  return { ok: true };
}
