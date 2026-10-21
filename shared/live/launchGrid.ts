// ──────────────────────────────────────────────────────────────────────
// MIDI grid controllers for the clip launcher (research/16 §2.1): settings
// defaults / validation and the note map main sends as `setLaunchGrid`.
// Pure: no I/O. The engine swallows mapped note-ons / note-offs from the
// device and launches instead. LED feedback (Wave 12.2b) is shared/live/gridLeds.ts.
//
// The grid shows an 8×8 window of the launcher: columns = playlist tracks
// from `trackOffset`, rows = scenes from `sceneOffset` (row 0 = the first
// visible scene, at the TOP of the device). Pads of a visible scene × track
// with a clip launch it; empty ones stop that track (like an empty slot's
// stop button). Pads outside the project's tracks / scenes stay unmapped.
//
//   launchpad (programmer mode): pads 11..88, row 1 at the bottom, so the
//     top row (first scene) is 81..88; scene buttons 89 (top) .. 19 (bottom);
//     stop all = 98 (top-row button above the scene column). The X / Mini MK3
//     / Pro MK3 send CCs from the scene column and the top row: with a device
//     chosen, the map asks the engine to take CCs with those numbers too.
//   apc-mini: pads 0..63, bottom-left 0, so the first scene is 56..63;
//     scene buttons 82 (top) .. 89; track buttons 64..71 stop their track;
//     stop all = 98 (Shift).
//   generic: pad = baseNote + row × 8 + column (row 0 = the first scene);
//     scene buttons baseNote + 64 + row; stop all = baseNote + 72. Notes
//     past 127 are left out.
// ──────────────────────────────────────────────────────────────────────

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

/** The grid settings in a Settings object (defaults filled). */
export function launchGridSettings(s: Pick<Settings, 'launchGrid'> | null | undefined): LaunchGridSettings {
  return { ...DEFAULT_LAUNCH_GRID, ...(s?.launchGrid ?? {}) };
}

/** Validate an untrusted partial (settings.json / a renderer patch) over a base. */
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
    // Grid LEDs (Wave 12.2b): absent / '' = paired by name, null = off, an output id = that output.
    ...ledOutputField(b.ledOutput, o),
  };
}

function ledOutputField(base: string | null | undefined, o: Record<string, unknown>): { ledOutput?: string | null } {
  if (!('ledOutput' in o)) return base === undefined ? {} : { ledOutput: base };
  const v = o.ledOutput;
  if (v === null) return { ledOutput: null };
  if (typeof v === 'string' && v) return { ledOutput: v.slice(0, 200) };
  return { ledOutput: '' }; // '' (or junk): back to automatic pairing, kept explicit so a later merge can't revive the old port
}

/** Where things sit on a layout. row / col 0..7 (row 0 = the top, i.e. the first visible scene). */
export interface GridLayout {
  pad(row: number, col: number): number;
  scene(row: number): number;
  /** A per-column stop button, if the layout has a row of them. */
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
  /** MIDI note number (as a string) → action. Empty = the grid is off. */
  notes: Record<string, LaunchGridAction>;
  /** Control Changes with these numbers launch too (Launchpad side buttons; only with a device chosen). */
  cc?: boolean;
}

/** The `setLaunchGrid` payload for a project + settings (disabled → an empty map). */
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
