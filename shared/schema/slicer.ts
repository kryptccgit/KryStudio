// ──────────────────────────────────────────────────────────────────────
// The loop slicer (research/13-roadmap.md §8.5): slice markers of a
// 'krypt.slicer' channel.
//
// Lives on the channel's generator (`Generator.slices`), next to its sample.
// Optional and additive to schema 1: no `slices` (or an empty list) = the
// whole sample is slice 1. The engine mirrors this in
// engine/crates/engine/src/model_ext.rs (SliceMarker) and hands the map to
// the instrument (dsp instruments/slicer.rs) off the audio thread.
//
// Semantics:
//  - Slice N (sorted by `sec`, 1-based) plays on key `baseKey` + N - 1
//    (the instrument's First key param, default 60) at its recorded pitch,
//    from its `sec` to the next slice's `sec` (or to the sample's end).
//  - `pitch` (semitones) / `reverse` / `gain` (linear) are per-slice
//    extras; absent = 0 / false / 1.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { Id } from './project';

export const SLICER_PLUGIN = 'krypt.slicer';
/** Most slices one slicer holds (dsp slicer::MAX_SLICES). */
export const MAX_SLICER_SLICES = 128;
/** The instrument's First key default: slice 1 plays on C4 (MIDI 60). */
export const SLICER_BASE_KEY = 60;
/** Id prefix for slice markers ("sl3"). */
export const SLICE_ID_PREFIX = 'sl';
/** Two slices closer than this (seconds) are one slice. */
export const MIN_SLICE_GAP_SEC = 0.005;

export interface Slice {
  id: Id;
  /** Start in the source file, seconds (>= 0, < file length). Strictly increasing across the list. */
  sec: number;
  /** Semitones on top of the channel pitch, -24..24. Absent = 0. */
  pitch?: number;
  /** Play this slice backwards. Absent = false. */
  reverse?: boolean;
  /** Linear gain 0..2. Absent = 1. */
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

/** Slices sorted with strictly increasing `sec` and unique ids (what every command keeps). */
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

/** The key slice `index` (0-based) plays on, for a First key of `baseKey`. */
export function sliceKey(index: number, baseKey = SLICER_BASE_KEY): number {
  return baseKey + index;
}
