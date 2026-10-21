import type { LaunchGridSettings, Settings } from '../types';
import type { LaunchGridAction } from '../engine/protocol';
import type { Project } from '../schema/project';

export const GRID_SIZE = 8;

export const DEFAULT_LAUNCH_GRID: LaunchGridSettings = {
  enabled: false,
  device: null,
  channel: null,
  layout: 'launchpad',
  baseNote: 36,
  trackOffset: 0,
  sceneOffset: 0,
};

export const LAUNCH_GRID_LAYOUTS: ReadonlyArray<{ id: LaunchGridSettings['layout']; label: string; hint: string }> = [
  { id: 'launchpad', label: 'Launchpad (programmer mode)', hint: 'Pads launch, the right column launches scenes, the top-right button stops all.' },
  { id: 'apc-mini', label: 'APC mini', hint: 'Pads launch, the right column launches scenes, the bottom row stops tracks, Shift stops all.' },
  { id: 'generic', label: 'Generic (base note)', hint: 'Pads from the base note, 8 per scene row; then 8 scene notes and a stop-all note.' },
];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);

export function launchGridSettings(s: Pick<Settings, 'launchGrid'> | null | undefined): LaunchGridSettings {
  return { ...DEFAULT_LAUNCH_GRID, ...(s?.launchGrid ?? {}) };
}

export function mergeLaunchGrid(base: LaunchGridSettings | undefined, input: unknown): LaunchGridSettings {
  const b = { ...DEFAULT_LAUNCH_GRID, ...(base ?? {}) };
  if (input === undefined) return b;
  const o = obj(input);
  const layout = o.layout === 'launchpad' || o.layout === 'apc-mini' || o.layout === 'generic' ? o.layout : b.layout;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : b.enabled,
    device: 'device' in o ? (typeof o.device === 'string' && o.device ? o.device.slice(0, 200) : null) : b.device,
    channel: 'channel' in o ? (o.channel === null ? null : int(o.channel, b.channel ?? 0, 0, 15)) : b.channel,
    layout,
    baseNote: int(o.baseNote, b.baseNote, 0, 127),
    trackOffset: int(o.trackOffset, b.trackOffset, 0, 4096),
    sceneOffset: int(o.sceneOffset, b.sceneOffset, 0, 4096),
    ...ledOutputField(b.ledOutput, o),
  };
}

function ledOutputField(base: string | null | undefined, o: Record<string, unknown>): { ledOutput?: string | null } {
  if (!('ledOutput' in o)) return base === undefined ? {} : { ledOutput: base };
  const v = o.ledOutput;
  if (v === null) return { ledOutput: null };
  if (typeof v === 'string' && v) return { ledOutput: v.slice(0, 200) };
  return { ledOutput: '' };
}

export interface GridLayout {
  pad(row: number, col: number): number;
  scene(row: number): number;
  trackStop?(col: number): number;
  stopAll: number;
}

export function gridLayout(layout: LaunchGridSettings['layout'], baseNote = DEFAULT_LAUNCH_GRID.baseNote): GridLayout {
  switch (layout) {
    case 'launchpad':
      return { pad: (r, c) => (8 - r) * 10 + c + 1, scene: (r) => (8 - r) * 10 + 9, stopAll: 98 };
    case 'apc-mini':
      return { pad: (r, c) => (7 - r) * 8 + c, scene: (r) => 82 + r, trackStop: (c) => 64 + c, stopAll: 98 };
    case 'generic':
      return { pad: (r, c) => baseNote + r * 8 + c, scene: (r) => baseNote + 64 + r, stopAll: baseNote + 72 };
  }
}

export interface LaunchGridMap {
  device: string | null;
  channel: number | null;
  notes: Record<string, LaunchGridAction>;
  cc?: boolean;
}

export function launchGridMap(p: Project, settings: LaunchGridSettings): LaunchGridMap {
  const out: LaunchGridMap = { device: settings.device, channel: settings.channel, notes: {} };
  if (!settings.enabled) return out;
  if (settings.layout === 'launchpad' && settings.device) out.cc = true;
  const L = gridLayout(settings.layout, settings.baseNote);
  const set = (note: number, action: LaunchGridAction): void => {
    if (Number.isInteger(note) && note >= 0 && note <= 127) out.notes[String(note)] = action;
  };
  const tracks = p.playlist.trackOrder.slice(settings.trackOffset, settings.trackOffset + GRID_SIZE);
  const s = p.session;
  const scenes = (s?.sceneOrder ?? []).slice(settings.sceneOffset, settings.sceneOffset + GRID_SIZE);
  const slot = new Map<string, string>();
  for (const c of Object.values(s?.clips ?? {})) slot.set(`${c.trackId}/${c.sceneId}`, c.id);
  scenes.forEach((sceneId, row) => {
    tracks.forEach((trackId, col) => {
      const clipId = slot.get(`${trackId}/${sceneId}`);
      set(L.pad(row, col), clipId ? { clipId } : { stopTrackId: trackId });
    });
    set(L.scene(row), { sceneId });
  });
  if (L.trackStop) tracks.forEach((trackId, col) => set(L.trackStop!(col), { stopTrackId: trackId }));
  set(L.stopAll, { stopTrackId: null });
  return out;
}
