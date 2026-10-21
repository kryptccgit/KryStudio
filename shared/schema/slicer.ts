import { z } from 'zod';
import type { Id } from './project';

export const SLICER_PLUGIN = 'krypt.slicer';
export const MAX_SLICER_SLICES = 128;
export const SLICER_BASE_KEY = 60;
export const SLICE_ID_PREFIX = 'sl';
export const MIN_SLICE_GAP_SEC = 0.005;

export interface Slice {
  id: Id;
  sec: number;
  pitch?: number;
  reverse?: boolean;
  gain?: number;
}

export const zSlice = z.object({
  id: z.string().min(1).max(40),
  sec: z.number().min(0).finite(),
  pitch: z.number().min(-24).max(24).optional(),
  reverse: z.boolean().optional(),
  gain: z.number().min(0).max(2).optional(),
});

export const zSlices = z.array(zSlice).max(MAX_SLICER_SLICES);

export function isValidSlices(slices: readonly Slice[]): boolean {
  const ids = new Set<string>();
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    if (!(Number.isFinite(s.sec) && s.sec >= 0) || ids.has(s.id)) return false;
    if (i > 0 && !(s.sec > slices[i - 1].sec)) return false;
    ids.add(s.id);
  }
  return true;
}

export function sliceKey(index: number, baseKey = SLICER_BASE_KEY): number {
  return baseKey + index;
}
