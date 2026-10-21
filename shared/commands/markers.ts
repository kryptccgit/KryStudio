import { z } from 'zod';
import { defineCommand, must, CommandError } from './types';
import type { Marker } from '../schema/project';

export const MARKER_NAME_MAX = 64;

export function cleanMarkerName(name: string): string | null {
  const t = name.replace(/\s+/g, ' ').trim();
  return t && t.length <= MARKER_NAME_MAX ? t : null;
}

export function sortedMarkers(markers: Record<string, Marker> | Marker[]): Marker[] {
  const list = Array.isArray(markers) ? [...markers] : Object.values(markers);
  return list.sort((a, b) => a.tick - b.tick || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function markerSection(markers: Record<string, Marker> | Marker[], id: string, songEnd: number, barTicks: number): { start: number; end: number } | null {
  const list = sortedMarkers(markers);
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  const next = list.find((x) => x.tick > m.tick);
  const end = next ? next.tick : songEnd > m.tick ? songEnd : m.tick + Math.max(1, barTicks);
  return { start: m.tick, end };
}

export const playlistRenameMarker = defineCommand({
  id: 'playlist.renameMarker',
  label: (a) => `Rename marker to "${String(a.name).trim().slice(0, 24)}"`,
  description: 'Rename a time marker (1..64 characters).',
  args: z.object({ id: z.string(), name: z.string().max(200) }),
  run(d, a) {
    const m = must(d.playlist.markers[a.id], `Marker ${a.id} not found`);
    const name = cleanMarkerName(a.name);
    if (!name) throw new CommandError(a.name.trim() ? `Marker names are at most ${MARKER_NAME_MAX} characters` : "A marker name can't be empty");
    if (name === m.name) throw new CommandError(`The marker is already called "${name}"`);
    m.name = name;
    return { name };
  },
});

export const playlistMoveMarker = defineCommand({
  id: 'playlist.moveMarker',
  label: () => 'Move marker',
  description: 'Move a time marker to another song tick.',
  args: z.object({ id: z.string(), tick: z.number().int().min(0) }),
  run(d, a) {
    const m = must(d.playlist.markers[a.id], `Marker ${a.id} not found`);
    if (m.tick === a.tick) throw new CommandError('The marker is already there');
    m.tick = a.tick;
    return {};
  },
});

export const MARKER_COMMANDS = [playlistRenameMarker, playlistMoveMarker];
