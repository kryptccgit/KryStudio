// ──────────────────────────────────────────────────────────────────────
// Warp markers and warp modes for audio clips, Wave 12.2
// (research/16-ableton-parity.md §2.2).
//
// Lives on the audio-clip channel's generator (`Generator.warp`, generator
// 'krypt.audioclip'), next to the Stretch params it extends. Optional and
// additive to schema 1: no `warp` = the pre-12.2 behaviour, bit-identical.
//
// Semantics (the engine renders a warped copy off the audio thread, like the
// existing stretch variants, engine `variants.rs`):
//  - A marker pins a moment of the SOURCE file (`sec`) to a musical position
//    (`beat`, quarter notes from the sample start at the project tempo).
//  - With >= 2 markers the markers define the timing and override the
//    Stretch group's `stretch` / `tempo_sync` / `src_bpm`. Between two
//    markers the audio is stretched linearly; before the first and after the
//    last marker the rate of the nearest segment continues.
//  - With 0 or 1 markers timing comes from the Stretch params as before;
//    one marker only shifts where the source's `sec` lands (beat).
//  - `pitch` / `formant` (Stretch group) still apply, except in 'repitch'.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { Id } from './project';

/**
 * complex: Signalsmith Stretch, full mixes (the pre-12.2 algorithm) · tones: Signalsmith tuned for pitched / mono
 * material (vocals, bass, leads) · beats: transient slicing; each slice plays at its original speed from its warped
 * position, so drums stay punchy · texture: granular, for pads / noise / ambience · repitch: varispeed resampling,
 * pitch follows the speed like a turntable (the Stretch group's pitch is ignored).
 */
export const WARP_MODES = ['complex', 'tones', 'beats', 'texture', 'repitch'] as const;
export type WarpMode = (typeof WARP_MODES)[number];

export interface WarpMarker {
  id: Id;
  /** Position in the source file, seconds (>= 0, < file length). */
  sec: number;
  /** Musical position in quarter notes from the sample start (>= 0). Strictly increasing with `sec`. */
  beat: number;
}

export interface WarpMap {
  mode: WarpMode;
  /** Sorted by `sec`; both `sec` and `beat` strictly increasing. At most MAX_WARP_MARKERS. */
  markers: WarpMarker[];
  /** beats: slice at 'transients' (detected onsets) or a fixed grid. Default 'transients'. */
  beatsSlice?: 'transients' | '1/16' | '1/8' | '1/4';
  /** beats: fade at each slice end, ms (0..200, default 20). */
  beatsFadeMs?: number;
  /** texture: grain size ms (10..500, default 80). */
  grainMs?: number;
  /** texture: grain position randomness 0..1 (default 0.2). */
  flux?: number;
}

export const MAX_WARP_MARKERS = 2048;

/** Markers sorted with strictly increasing sec AND beat (what the engine expects). */
export function isValidWarp(markers: WarpMarker[]): boolean {
  for (let i = 1; i < markers.length; i++) {
    if (!(markers[i].sec > markers[i - 1].sec) || !(markers[i].beat > markers[i - 1].beat)) return false;
  }
  return markers.every((m) => m.sec >= 0 && m.beat >= 0 && Number.isFinite(m.sec) && Number.isFinite(m.beat));
}

/**
 * Map a source time (seconds) to beats through the markers (piecewise linear, extrapolating with the edge
 * segments). Null when there are fewer than 2 markers (timing comes from the Stretch params then).
 */
export function secToBeat(markers: WarpMarker[], sec: number): number | null {
  if (markers.length < 2) return null;
  let i = 0;
  while (i < markers.length - 2 && sec > markers[i + 1].sec) i++;
  const a = markers[i];
  const b = markers[i + 1];
  return a.beat + ((sec - a.sec) * (b.beat - a.beat)) / (b.sec - a.sec);
}

/** Inverse of secToBeat. */
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
