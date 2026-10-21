import type { Marker } from '@shared/schema/project';
import { sortedMarkers } from '@shared/commands/markers';
import { tickToX, type TimeView } from '../../editors/viewport';

export const MARKER_BAND_H = 13;

export interface MarkerDrag {
  id: string;
  orig: number;
  tick: number;
  downX: number;
  moved: boolean;
}

export function hitMarker(markers: readonly Marker[], tv: TimeView, x: number, y: number, labelWidth: (name: string) => number): Marker | null {
  if (y < 0 || y > MARKER_BAND_H) return null;
  let hit: Marker | null = null;
  for (const m of sortedMarkers([...markers])) {
    const mx = tickToX(tv, m.tick);
    if (x >= mx - 3 && x <= mx + 10 + labelWidth(m.name)) hit = m;
  }
  return hit;
}

export function markersWithDrag(markers: readonly Marker[], d: MarkerDrag | null): Marker[] {
  if (!d?.moved) return [...markers];
  return markers.map((m) => (m.id === d.id ? { ...m, tick: d.tick } : m));
}
