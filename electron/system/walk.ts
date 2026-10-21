import fsp from 'node:fs/promises';
import path from 'node:path';

export interface WalkedFile {
  path: string;
  size: number;
  mtime: number;
}

export interface WalkResult {
  files: WalkedFile[];
  unreadable: number;
  truncated: boolean;
}

const SKIP = /^(\.|\$|desktop\.ini$|thumbs\.db$|system volume information$)/i;

export async function walkFiles(root: string, accept: (name: string) => boolean, opts: { maxFiles?: number; signal?: AbortSignal } = {}): Promise<WalkResult> {
  const max = opts.maxFiles ?? 100_000;
  const out: WalkedFile[] = [];
  let unreadable = 0;
  const stack = [root];
  while (stack.length) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      unreadable++;
      continue;
    }
    const files: string[] = [];
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && accept(e.name)) files.push(full);
    }
    for (let i = 0; i < files.length; i += 32) {
      const stats = await Promise.all(files.slice(i, i + 32).map((f) => fsp.stat(f).then((s) => ({ f, s }), () => null)));
      for (const x of stats) {
        if (!x || !x.s.isFile()) continue;
        out.push({ path: x.f, size: x.s.size, mtime: Math.trunc(x.s.mtimeMs) });
        if (out.length >= max) return { files: out, unreadable, truncated: true };
      }
    }
  }
  return { files: out, unreadable, truncated: false };
}

export async function statSource(p: string): Promise<{ size: number; mtime: number } | null> {
  try {
    const s = await fsp.stat(p);
    return s.isFile() ? { size: s.size, mtime: Math.trunc(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
