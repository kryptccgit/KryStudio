// Free space on the disk that holds a folder, for the sound-pack download's up-front check (a clear "not enough
// disk space" sentence instead of a write failing half-way). Best effort: null when it can't be told.

import fsp from 'node:fs/promises';
import path from 'node:path';

export async function freeBytes(dir: string): Promise<number | null> {
  // statfs needs an existing path: walk up to the nearest one (userData/packs may not exist yet).
  let p = path.resolve(dir);
  for (let i = 0; i < 32; i++) {
    try {
      const s = await fsp.statfs(p);
      const free = Number(s.bavail) * Number(s.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch {
      const up = path.dirname(p);
      if (up === p) return null;
      p = up;
    }
  }
  return null;
}
