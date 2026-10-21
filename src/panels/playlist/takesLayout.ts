// Take lanes in the playlist (Wave 12.2b): pure layout + lookups, no DOM.
//
// A track with take groups can be expanded: its take lanes sit directly under
// its clip row (the comp row = the track itself). The lane layout keeps
// `heights[i]` = the CLIP ROW height, so every clip paint / hit-test in the
// controller is unchanged; `tops` are spaced by row + take lanes, and
// `extra[i]` is the take-lane area under row i.

import type { Project } from '@shared/schema/project';
import { orderedTakes, takeGroupsOnTrack, type Take, type TakeGroup } from '@shared/schema/takes';
import { laneAt, type LaneLayout } from '../../editors/viewport';

export const TAKE_LANE_H = 26;

export function takeLaneH(scale: number): number {
  return Math.max(14, Math.round(TAKE_LANE_H * scale));
}

export interface TrackLaneLayout extends LaneLayout {
  /** Take-lane pixels under each clip row (0 = collapsed / no takes). */
  extra: number[];
}

export function buildTrackLanes(ids: string[], heightOf: (id: string, i: number) => number, extraOf: (id: string, i: number) => number): TrackLaneLayout {
  const tops: number[] = new Array(ids.length);
  const heights: number[] = new Array(ids.length);
  const extra: number[] = new Array(ids.length);
  let y = 0;
  for (let i = 0; i < ids.length; i++) {
    const h = Math.max(1, heightOf(ids[i], i));
    const x = Math.max(0, extraOf(ids[i], i));
    tops[i] = y;
    heights[i] = h;
    extra[i] = x;
    y += h + x;
  }
  return { ids, tops, heights, extra, total: y };
}

/** How many take lanes a track shows: the most takes any of its groups has. */
export function takeLaneCount(p: Project, trackId: string): number {
  let n = 0;
  for (const g of takeGroupsOnTrack(p, trackId)) n = Math.max(n, g.takeOrder.length);
  return n;
}

/** Content y → the take lane under it (track index + lane index), or null on a clip row / outside. */
export function takeLaneAt(l: TrackLaneLayout, contentY: number, laneH: number): { track: number; lane: number } | null {
  const i = laneAt(l, contentY);
  if (i < 0 || i >= l.ids.length || !l.extra[i]) return null;
  const rel = contentY - l.tops[i] - l.heights[i];
  if (rel < 0 || rel >= l.extra[i]) return null;
  return { track: i, lane: Math.floor(rel / laneH) };
}

/** Lane k of a track: the k-th take of each of its groups. */
export function laneTakes(p: Project, trackId: string, k: number): Array<{ group: TakeGroup; take: Take }> {
  const out: Array<{ group: TakeGroup; take: Take }> = [];
  for (const g of takeGroupsOnTrack(p, trackId)) {
    const t = orderedTakes(g)[k];
    if (t) out.push({ group: g, take: t });
  }
  return out;
}

/** The take in lane k at a song tick: the group whose span holds the tick (null = nothing recorded there). */
export function laneTakeAt(p: Project, trackId: string, k: number, tick: number): { group: TakeGroup; take: Take } | null {
  for (const x of laneTakes(p, trackId, k)) if (tick >= x.group.start && tick < x.group.end) return x;
  return null;
}

/** A swipe from tick a to b, snapped outward to the grid (Alt = no snap). */
export function swipeRange(a: number, b: number, grid: number, noSnap: boolean): { start: number; end: number } {
  let start = Math.max(0, Math.min(a, b));
  let end = Math.max(a, b);
  if (!noSnap && grid > 0) {
    start = Math.floor(start / grid) * grid;
    end = Math.ceil(end / grid) * grid;
    if (end <= start) end = start + grid;
  }
  return { start: Math.round(start), end: Math.round(end) };
}

/** Parts of the lane's take that the comp uses (for highlighting). */
export function compPartsOf(g: TakeGroup, takeId: string): Array<{ start: number; end: number }> {
  return g.comp.filter((s) => s.takeId === takeId).map((s) => ({ start: s.start, end: s.end }));
}
