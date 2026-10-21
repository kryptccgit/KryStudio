// Filesystem wrappers. Everything that reads or writes disk goes through
// here (kryptguidelines §4.3: electron/system is the only OS-touching code).
// Writes are atomic: tmp file → fsync → rename over the target, retried a
// few times because antivirus / cloud-sync clients briefly lock files on
// Windows (EPERM / EBUSY on rename).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BrowserEntry } from '@shared/types';
import { AUDIO_EXTENSIONS } from '@shared/audio/formats';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Turn a Node fs error into a sentence a user can act on. */
export function describeFsError(err: unknown, target: string): string {
  const e = err as NodeJS.ErrnoException;
  switch (e?.code) {
    case 'ENOENT':
      return `File or folder not found: ${target}`;
    case 'EACCES':
    case 'EPERM':
      return `Windows blocked access to ${target}. If it's in Documents/Desktop, Controlled Folder Access may be blocking Krypt Studio. Pick another folder or allow the app.`;
    case 'EBUSY':
      return `${target} is locked by another program. Close it and try again.`;
    case 'ENOSPC':
      return `The disk is full; couldn't write ${target}.`;
    case 'EISDIR':
      return `${target} is a folder, not a file.`;
    default:
      return `${e?.message ?? String(err)}`;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await sleep(40 * (i + 1));
    }
  }
  throw lastErr;
}

/** Crash-safe write: a crash mid-write never truncates the existing file. */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Atomic write of a file too big to hold in memory: `fill` writes into a temp file next to the target, which is
 * fsynced and renamed over it. A failure leaves the target as it was.
 */
export async function writeFileAtomicWith(target: string, fill: (fh: fsp.FileHandle) => Promise<void>, beforeRename?: () => Promise<void>): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fill(fh);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // e.g. close the handle the fill read from: Windows won't replace a file that is still open.
    await beforeRename?.();
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Synchronous atomic write for tiny files that must land before exit (settings, locks). */
export function writeFileAtomicSync(target: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

export async function readBytes(p: string): Promise<Uint8Array> {
  return new Uint8Array(await fsp.readFile(p));
}

export function readTextSync(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export async function appendText(p: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.appendFile(p, text, 'utf8');
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function mtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export async function removeFile(p: string): Promise<void> {
  await fsp.rm(p, { force: true });
}

export function removeFileSync(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

/** Size of a regular file, or null (missing, a folder, unreadable). */
export function fileSize(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Delete a file only if it is empty (an export placeholder whose render failed). */
export function removeIfEmptySync(p: string): void {
  if (fileSize(p) === 0) removeFileSync(p);
}

/**
 * A file name in dir that doesn't exist yet: "Song.wav", "Song (2).wav", … The file is created empty right away
 * (flag 'wx' fails if it exists), so two exports can never pick the same name and nothing is overwritten.
 */
export function reserveUniquePath(dir: string, stem: string, ext: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i < 10_000; i++) {
    const file = path.join(dir, `${stem}${i === 1 ? '' : ` (${i})`}.${ext}`);
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Couldn't find a free file name for "${stem}" in ${dir}`);
}

export async function copyFile(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
}

/** Copy `from` → `to` if `to` is missing or older (dev shadow copies). */
export function copyIfNewerSync(from: string, to: string): void {
  if (mtimeMs(to) >= mtimeMs(from) && exists(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Delete all but the newest `keep` files in a directory (best effort). */
export async function pruneDir(dir: string, keep: number, pattern: RegExp = /./): Promise<void> {
  try {
    const names = (await fsp.readdir(dir)).filter((n) => pattern.test(n));
    const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(dir, n))).mtimeMs })));
    stats.sort((a, b) => b.t - a.t);
    for (const s of stats.slice(keep)) await fsp.rm(path.join(dir, s.n), { force: true });
  } catch {
    /* best effort */
  }
}

// ── Browser listing ───────────────────────────────────────────────────

export const AUDIO_EXT = new Set(AUDIO_EXTENSIONS);
export const MIDI_EXT = new Set(['mid', 'midi', 'smf']);
export const PROJECT_EXT = new Set(['kstudio']);

export function classify(name: string, dir: boolean): BrowserEntry['kind'] {
  if (dir) return 'dir';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (MIDI_EXT.has(ext)) return 'midi';
  if (PROJECT_EXT.has(ext)) return 'project';
  return 'other';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * List one directory for the browser panel: folders, audio, MIDI and
 * project files (dirs first, natural sort). Hidden/system entries and
 * unrelated file types are left out.
 */
export async function listDirectory(dir: string): Promise<BrowserEntry[]> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const out: BrowserEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.') || d.name.startsWith('$') || /^(desktop\.ini|thumbs\.db)$/i.test(d.name)) continue;
    const full = path.join(dir, d.name);
    let isDirectory = d.isDirectory();
    if (d.isSymbolicLink()) isDirectory = isDir(full);
    const kind = classify(d.name, isDirectory);
    if (kind === 'other') continue;
    const entry: BrowserEntry = { name: d.name, path: full, kind };
    if (!isDirectory) {
      try {
        entry.size = (await fsp.stat(full)).size;
      } catch {
        /* unreadable: still list it */
      }
    }
    out.push(entry);
  }
  out.sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : collator.compare(a.name, b.name));
  return out;
}

/** Full paths of the regular files in `dir` ending in `ext` (".js"); [] when the folder doesn't exist. */
export async function listFilesWithExt(dir: string, ext: string): Promise<string[]> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(ext) && !d.name.startsWith('.'))
    .map((d) => path.join(dir, d.name))
    .sort((a, b) => collator.compare(a, b));
}

/** Case-insensitive (Windows) "is `child` inside or equal to `root`". */
export function isInside(root: string, child: string): boolean {
  const norm = (p: string) => path.resolve(p).normalize('NFC').toLowerCase();
  const r = norm(root);
  const c = norm(child);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
