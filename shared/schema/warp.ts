import { z } from 'zod';
import type { Id } from './project';

export const WARP_MODES = ['complex', 'tones', 'beats', 'texture', 'repitch'] as const;
export type WarpMode = (typeof WARP_MODES)[number];

export interface WarpMarker {
  id: Id;
  sec: number;
  beat: number;
}

export interface WarpMap {
  mode: WarpMode;
  markers: WarpMarker[];
  beatsSlice?: 'transients' | '1/16' | '1/8' | '1/4';
  beatsFadeMs?: number;
  grainMs?: number;
  flux?: number;
}

export const MAX_WARP_MARKERS = 2048;

export function isValidWarp(markers: WarpMarker[]): boolean {
  for (let i = 1; i < markers.length; i++) {
    if (!(markers[i].sec > markers[i - 1].sec) || !(markers[i].beat > markers[i - 1].beat)) return false;
  }
  return markers.every((m) => m.sec >= 0 && m.beat >= 0 && Number.isFinite(m.sec) && Number.isFinite(m.beat));
}

export function secToBeat(markers: WarpMarker[], sec: number): number | null {
  if (markers.length < 2) return null;
  let i = 0;
  while (i < markers.length - 2 && sec > markers[i + 1].sec) i++;
  const a = markers[i];
  const b = markers[i + 1];
  return a.beat + ((sec - a.sec) * (b.beat - a.beat)) / (b.sec - a.sec);
}

export function beatToSec(markers: WarpMarker[], beat: number): number | null {
  if (markers.length < 2) return null;
  let i = 0;
  while (i < markers.length - 2 && beat > markers[i + 1].beat) i++;
  const a = markers[i];
  const b = markers[i + 1];
  return a.sec + ((beat - a.beat) * (b.sec - a.sec)) / (b.beat - a.beat);
}

export const zWarp = z.object({
  mode: z.enum(WARP_MODES),
  markers: z
    .array(z.object({ id: z.string().min(1), sec: z.number().min(0), beat: z.number().min(0) }))
    .max(MAX_WARP_MARKERS),
  beatsSlice: z.enum(['transients', '1/16', '1/8', '1/4']).optional(),
  beatsFadeMs: z.number().min(0).max(200).optional(),
  grainMs: z.number().min(10).max(500).optional(),
  flux: z.number().min(0).max(1).optional(),
});
