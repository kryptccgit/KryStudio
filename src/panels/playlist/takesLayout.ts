import type { Project } from '@shared/schema/project';
import { orderedTakes, takeGroupsOnTrack, type Take, type TakeGroup } from '@shared/schema/takes';
import { laneAt, type LaneLayout } from '../../editors/viewport';

export const TAKE_LANE_H = 26;

export function takeLaneH(scale: number): number {
  return Math.max(14, Math.round(TAKE_LANE_H * scale));
}

export interface TrackLaneLayout extends LaneLayout {
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

export function takeLaneCount(p: Project, trackId: string): number {
  let n = 0;
  for (const g of takeGroupsOnTrack(p, trackId)) n = Math.max(n, g.takeOrder.length);
  return n;
}

export function takeLaneAt(l: TrackLaneLayout, contentY: number, laneH: number): { track: number; lane: number } | null {
  const i = laneAt(l, contentY);
  if (i < 0 || i >= l.ids.length || !l.extra[i]) return null;
  const rel = contentY - l.tops[i] - l.heights[i];
  if (rel < 0 || rel >= l.extra[i]) return null;
  return { track: i, lane: Math.floor(rel / laneH) };
}

export function laneTakes(p: Project, trackId: string, k: number): Array<{ group: TakeGroup; take: Take }> {
  const out: Array<{ group: TakeGroup; take: Take }> = [];
  for (const g of takeGroupsOnTrack(p, trackId)) {
    const t = orderedTakes(g)[k];
    if (t) out.push({ group: g, take: t });
  }
  return out;
}

export function laneTakeAt(p: Project, trackId: string, k: number, tick: number): { group: TakeGroup; take: Take } | null {
  for (const x of laneTakes(p, trackId, k)) if (tick >= x.group.start && tick < x.group.end) return x;
  return null;
}

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

export function compPartsOf(g: TakeGroup, takeId: string): Array<{ start: number; end: number }> {
  return g.comp.filter((s) => s.takeId === takeId).map((s) => ({ start: s.start, end: s.end }));
}
