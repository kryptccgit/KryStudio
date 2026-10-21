// Pure ruler-marker maths (Wave 12.2b), kept free of DOM / store imports so
// tests and the controller share it: what a pointer on the ruler hits, and
// the markers as drawn while one is dragged.

import type { Marker } from '@shared/schema/project';
import { sortedMarkers } from '@shared/commands/markers';
import { tickToX, type TimeView } from '../../editors/viewport';

/** The flag + name band at the top of the ruler (px). */
export const MARKER_BAND_H = 13;

export interface MarkerDrag {
  id: string;
  orig: number;
  tick: number;
  downX: number;
  moved: boolean;
}

/** The marker under (x, y) on the ruler; later (right-most) markers win where labels overlap. */
export function hitMarker(markers: readonly Marker[], tv: TimeView, x: number, y: number, labelWidth: (name: string) => number): Marker | null {
  if (y < 0 || y > MARKER_BAND_H) return null;
  let hit: Marker | null = null;
  for (const m of sortedMarkers([...markers])) {
    const mx = tickToX(tv, m.tick);
    if (x >= mx - 3 && x <= mx + 10 + labelWidth(m.name)) hit = m;
  }
  return hit;
}

/** Markers with one moved (the ruler's drag preview). */
export function markersWithDrag(markers: readonly Marker[], d: MarkerDrag | null): Marker[] {
  if (!d?.moved) return [...markers];
  return markers.map((m) => (m.id === d.id ? { ...m, tick: d.tick } : m));
}
