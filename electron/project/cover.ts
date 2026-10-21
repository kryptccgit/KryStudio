// ──────────────────────────────────────────────────────────────────────
// The project's cover image: bytes in → a normalized square image stored
// with the open project (assets.ts) → a CoverRef the CALLER puts in the doc
// with project.setCover (the user through IPC, an agent through set_cover),
// so every change is one undoable command under the right actor.
//
//   from a file      Choose image… / set_cover {path}: ≤ 20 MB PNG / JPEG
//   from bytes       the renderer's generator (Export dialog ▸ Generate)
//   generated        set_cover {generate}: main asks the main window to draw
//                    it (canvas + Chakra Petch), which needs a window
//
// Decoding / resizing is injected (electron/system/images.ts uses Electron's
// nativeImage), so this file stays testable under plain Node.
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import type { CoverRef } from '@shared/schema/project';
import type { CoverDrawResult, CoverPreview } from '@shared/types';
import type { CoverMime, StoredAsset } from './assets';

export interface NormalizedCover {
  bytes: Uint8Array;
  mime: CoverMime;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface CoverServiceDeps {
  project: {
    storeCover(bytes: Uint8Array, mime: CoverMime, width: number, height: number): CoverRef;
    coverImage(): (StoredAsset & CoverRef) | null;
  };
  /** Square, ≤ 1400 px, PNG / JPEG. Throws an Error whose message is for the user. */
  normalize(bytes: Uint8Array): NormalizedCover;
  /** File size in bytes, or null when it doesn't exist / isn't a file. */
  fileSize(p: string): number | null;
  readFile(p: string): Promise<Uint8Array>;
  /** Ask the main window to draw a cover; absent / rejects when there is no window. */
  draw?(req: { style?: string; seed?: number }): Promise<CoverDrawResult>;
  /** Biggest source image accepted. */
  maxSourceBytes: number;
}

export interface CoverOutcome {
  ref: CoverRef;
  /** One sentence: what was stored. */
  message: string;
}

export class CoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverError';
  }
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

export class CoverService {
  constructor(private readonly deps: CoverServiceDeps) {}

  /** Normalize and store image bytes; returns the reference for project.setCover. Throws CoverError. */
  fromBytes(bytes: Uint8Array, what = 'The image'): CoverOutcome {
    if (bytes.length > this.deps.maxSourceBytes) throw new CoverError(`${what} is ${mb(bytes.length)}. Pick one under ${mb(this.deps.maxSourceBytes)}.`);
    let img: NormalizedCover;
    try {
      img = this.deps.normalize(bytes);
    } catch (err) {
      throw new CoverError((err as Error)?.message ?? String(err));
    }
    let ref: CoverRef;
    try {
      ref = this.deps.project.storeCover(img.bytes, img.mime, img.width, img.height);
    } catch (err) {
      throw new CoverError(`Couldn't keep the cover image: ${(err as Error)?.message ?? err}`);
    }
    const changed = img.sourceWidth !== img.width || img.sourceHeight !== img.height;
    const how = changed
      ? img.sourceWidth !== img.sourceHeight
        ? ` (cropped from ${img.sourceWidth}×${img.sourceHeight} to a square, ${img.width}×${img.height} px)`
        : ` (scaled from ${img.sourceWidth} to ${img.width} px)`
      : ` (${img.width}×${img.height} px)`;
    return { ref, message: `${what} is the cover${how}, ${img.mime === 'image/png' ? 'PNG' : 'JPEG'}, ${Math.max(1, Math.round(img.bytes.length / 1024))} KB` };
  }

  /** A PNG / JPEG on disk (already allowed by the caller's access rules). Throws CoverError. */
  async fromFile(file: string): Promise<CoverOutcome> {
    if (!/\.(png|jpe?g)$/i.test(file)) throw new CoverError(`"${path.basename(file)}" isn't a PNG or JPEG image.`);
    const size = this.deps.fileSize(file);
    if (size === null) throw new CoverError(`Image not found: ${file}`);
    if (size > this.deps.maxSourceBytes) throw new CoverError(`"${path.basename(file)}" is ${mb(size)}. Pick an image under ${mb(this.deps.maxSourceBytes)}.`);
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.readFile(file);
    } catch (err) {
      throw new CoverError(`Couldn't read "${path.basename(file)}": ${(err as Error)?.message ?? err}`);
    }
    return this.fromBytes(bytes, `"${path.basename(file)}"`);
  }

  /** A generated cover, drawn by the main window. Throws CoverError (no window, drawing failed). */
  async generate(opts: { style?: string; seed?: number } = {}): Promise<CoverOutcome & { style: string; seed: number }> {
    if (!this.deps.draw) throw new CoverError("Krypt Studio's window isn't open, so it can't draw a cover. Pass path (a PNG / JPEG) instead, or ask the user to open Krypt Studio.");
    let r: CoverDrawResult;
    try {
      r = await this.deps.draw(opts);
    } catch (err) {
      throw new CoverError((err as Error)?.message ?? String(err));
    }
    if (!r.ok) throw new CoverError(r.message);
    const out = this.fromBytes(r.bytes, 'The generated cover');
    return { ...out, style: r.style, seed: r.seed, message: `${out.message}; style "${r.style}", seed ${r.seed}` };
  }

  /** The current cover for the Export dialog (a data: URL). */
  preview(): CoverPreview | null {
    const c = this.deps.project.coverImage();
    if (!c) return null;
    const b64 = Buffer.from(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength).toString('base64');
    return { file: c.file, mime: c.mime, width: c.width, height: c.height, bytes: c.bytes.length, dataUrl: `data:${c.mime};base64,${b64}` };
  }
}
