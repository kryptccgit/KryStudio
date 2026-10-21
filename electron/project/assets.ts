import crypto from 'node:crypto';
import { COVER_FILE_RE, coverMimeOf, type CoverRef, type Project } from '@shared/schema/project';

export type CoverMime = CoverRef['mime'];

export interface StoredAsset {
  file: string;
  mime: CoverMime;
  bytes: Uint8Array;
}

export const MAX_COVER_BYTES = 12 * 1024 * 1024;

export function coverFileName(bytes: Uint8Array, mime: CoverMime): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return `cover-${hash}.${mime === 'image/png' ? 'png' : 'jpg'}`;
}

export function sniffImage(bytes: Uint8Array): CoverMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export class ProjectAssets {
  private readonly items = new Map<string, StoredAsset>();

  constructor(private readonly onAdded?: (a: StoredAsset) => void) {}

  put(bytes: Uint8Array, mime: CoverMime): StoredAsset {
    if (sniffImage(bytes) !== mime) throw new Error(`The image data isn't ${mime === 'image/png' ? 'a PNG' : 'a JPEG'}`);
    if (bytes.length > MAX_COVER_BYTES) throw new Error(`The cover image is too big (${(bytes.length / 1048576).toFixed(1)} MB; max ${MAX_COVER_BYTES / 1048576} MB)`);
    const file = coverFileName(bytes, mime);
    const have = this.items.get(file);
    if (have) return have;
    const a: StoredAsset = { file, mime, bytes: new Uint8Array(bytes) };
    this.items.set(file, a);
    try {
      this.onAdded?.(a);
    } catch {
    }
    return a;
  }

  adopt(file: string, bytes: Uint8Array): boolean {
    const mime = coverMimeOf(file);
    if (!COVER_FILE_RE.test(file) || !mime || sniffImage(bytes) !== mime || coverFileName(bytes, mime) !== file) return false;
    if (!this.items.has(file)) this.items.set(file, { file, mime, bytes });
    return true;
  }

  get(file: string | undefined | null): StoredAsset | null {
    return file ? this.items.get(file) ?? null : null;
  }

  has(file: string): boolean {
    return this.items.has(file);
  }

  entriesFor(project: Project): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    const c = project.meta.cover;
    const a = c ? this.items.get(c.file) : undefined;
    if (a) out[a.file] = a.bytes;
    return out;
  }

  list(): StoredAsset[] {
    return [...this.items.values()];
  }

  restore(list: readonly StoredAsset[]): void {
    this.items.clear();
    for (const a of list) this.items.set(a.file, a);
  }

  clear(): void {
    this.items.clear();
  }
}
