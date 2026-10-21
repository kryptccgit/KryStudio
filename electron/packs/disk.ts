import fsp from 'node:fs/promises';
import path from 'node:path';

export async function freeBytes(dir: string): Promise<number | null> {
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
