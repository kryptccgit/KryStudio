import { nativeImage } from 'electron';
import { COVER_MAX_SIDE } from '@shared/schema/project';
import { sniffImage, type CoverMime } from '../project/assets';

export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: CoverMime;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

function hasTransparency(img: Electron.NativeImage): boolean {
  const bmp = img.toBitmap();
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] < 255) return true;
  return false;
}

export function normalizeCoverImage(src: Uint8Array, maxSide = COVER_MAX_SIDE): NormalizedImage {
  if (src.length > MAX_SOURCE_IMAGE_BYTES) throw new ImageError(`That image is ${(src.length / 1048576).toFixed(1)} MB. Pick one under ${MAX_SOURCE_IMAGE_BYTES / 1048576} MB.`);
  const kind = sniffImage(src);
  if (!kind) throw new ImageError("That file isn't a PNG or JPEG image.");
  const img = nativeImage.createFromBuffer(Buffer.from(src.buffer, src.byteOffset, src.byteLength));
  if (img.isEmpty()) throw new ImageError(`Couldn't read that ${kind === 'image/png' ? 'PNG' : 'JPEG'} (it may be damaged or use an unusual encoding).`);
  const { width: w, height: h } = img.getSize();
  if (w < 16 || h < 16) throw new ImageError(`That image is only ${w}×${h} px; covers need at least 16 px (1400 is ideal).`);
  const side = Math.min(w, h);
  const square = side === w && side === h ? img : img.crop({ x: Math.floor((w - side) / 2), y: Math.floor((h - side) / 2), width: side, height: side });
  const out = side > maxSide ? square.resize({ width: maxSide, height: maxSide, quality: 'best' }) : square;
  const size = out.getSize();
  const png = kind === 'image/png' && hasTransparency(out);
  const bytes = new Uint8Array(png ? out.toPNG() : out.toJPEG(90));
  if (!bytes.length) throw new ImageError("Couldn't encode the cover image.");
  return { bytes, mime: png ? 'image/png' : 'image/jpeg', width: size.width, height: size.height, sourceWidth: w, sourceHeight: h };
}
