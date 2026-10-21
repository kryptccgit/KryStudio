// ──────────────────────────────────────────────────────────────────────
// Session view: the pure model (research/16 §2.1). Grid layout + slot
// hit-testing, keyboard selection moves, labels, the follow-action editor's
// value mapping, live-state helpers and drag payload parsing. No React, no
// window: unit-tested in test/session-ui.test.ts.
// ──────────────────────────────────────────────────────────────────────

import type { Id, Project } from '@shared/schema/project';
import {
  FOLLOW_ACTIONS,
  LAUNCH_MODES,
  LAUNCH_QUANTS,
  type FollowAction,
  type FollowRule,
  type LaunchClip,
  type LaunchMode,
  type LaunchQuant,
} from '@shared/schema/launcher';
import type { LauncherTelemetry } from '@shared/engine/protocol';
import type { LaunchGridSettings } from '@shared/types';
import { ticksPerBar, type TimeSig } from '@shared/schema/time';

// ── Layout + hit-testing ──────────────────────────────────────────────

/** Pixel sizes of the grid (CSS px). Columns are tracks, rows are scenes. */
export const SESSION_LAYOUT = { colW: 118, rowH: 34, headerH: 40, footerH: 30, sceneW: 176 } as const;

export interface GridLayout {
  colW: number;
  rowH: number;
}

export interface Cell {
  /** Track column index (trackOrder). */
  col: number;
  /** Scene row index (sceneOrder). */
  row: number;
}

/**
 * The slot under a point, in px relative to the top-left of the first slot (below the track headers).
 * null outside the slot area (headers, scene column, beyond the last row / column).
 */
export function slotAt(x: number, y: number, cols: number, rows: number, layout: GridLayout = SESSION_LAYOUT): Cell | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  const col = Math.floor(x / layout.colW);
  const row = Math.floor(y / layout.rowH);
  if (col >= cols || row >= rows) return null;
  return { col, row };
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The slot under a client-space point in the scrolling grid. `grid` = the grid element's box (it moves with
 * scrolling), `view` = the scroller's visible client box. The sticky track headers (top), the stop-button row
 * (bottom) and the scene column (right) cover slots while scrolled, so points over them hit no slot.
 */
export function pointToCell(clientX: number, clientY: number, grid: Pick<Box, 'left' | 'top'>, view: Box, cols: number, rows: number, l = SESSION_LAYOUT): Cell | null {
  if (clientX < view.left || clientX >= view.right || clientY < view.top || clientY >= view.bottom) return null;
  // Sticky elements sit at their natural place, or pinned to the view's edge once that scrolled past it.
  const sceneLeft = Math.min(grid.left + cols * l.colW, view.right - l.sceneW);
  const headerBottom = Math.max(grid.top, view.top) + l.headerH;
  const footerTop = Math.min(grid.top + l.headerH + rows * l.rowH, view.bottom - l.footerH);
  if (clientX >= sceneLeft || clientY < headerBottom || clientY >= footerTop) return null;
  return slotAt(clientX - grid.left, clientY - grid.top - l.headerH, cols, rows, l);
}

/** The pixel box of a slot (same origin as slotAt). */
export function slotRect(cell: Cell, layout: GridLayout = SESSION_LAYOUT): { x: number; y: number; w: number; h: number } {
  return { x: cell.col * layout.colW, y: cell.row * layout.rowH, w: layout.colW, h: layout.rowH };
}

/** Total content size of the grid (track headers + slots + footer; scene column included). */
export function gridSize(cols: number, rows: number, l = SESSION_LAYOUT): { w: number; h: number } {
  return { w: cols * l.colW + l.sceneW, h: l.headerH + rows * l.rowH + l.footerH };
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** Keyboard selection move, clamped to the grid. No cell yet → the top-left slot. */
export function moveCell(cell: Cell | null, key: ArrowKey, cols: number, rows: number): Cell | null {
  if (cols <= 0 || rows <= 0) return null;
  if (!cell) return { col: 0, row: 0 };
  let { col, row } = cell;
  if (key === 'ArrowUp') row--;
  else if (key === 'ArrowDown') row++;
  else if (key === 'ArrowLeft') col--;
  else col++;
  return { col: Math.max(0, Math.min(cols - 1, col)), row: Math.max(0, Math.min(rows - 1, row)) };
}

/** Keep a selection inside a grid that shrank (track / scene deleted). */
export function clampCell(cell: Cell | null, cols: number, rows: number): Cell | null {
  if (!cell || cols <= 0 || rows <= 0) return null;
  return { col: Math.min(cell.col, cols - 1), row: Math.min(cell.row, rows - 1) };
}

// ── Slots ─────────────────────────────────────────────────────────────

export function slotKey(trackId: Id, sceneId: Id): string {
  return `${trackId}\u0001${sceneId}`;
}

/** slotKey → clip id, for O(1) slot lookups while rendering. */
export function slotIndex(clips: Record<Id, LaunchClip> | undefined): Map<string, Id> {
  const m = new Map<string, Id>();
  if (clips) for (const c of Object.values(clips)) m.set(slotKey(c.trackId, c.sceneId), c.id);
  return m;
}

/** Tracks (columns) that hold at least one launch clip: their empty slots show a stop button. */
export function tracksWithClips(clips: Record<Id, LaunchClip> | undefined): Set<Id> {
  const s = new Set<Id>();
  if (clips) for (const c of Object.values(clips)) s.add(c.trackId);
  return s;
}

/**
 * The grid's columns. A new project has 16 empty playlist tracks, so by default the grid shows only the tracks
 * in use (launch clips or playlist clips) plus a few empty ones to drop onto (at least one, four in an empty
 * project); `showAll` shows every track. Playlist order is kept.
 */
export function visibleTracks(
  trackOrder: readonly Id[],
  launchClips: Record<Id, LaunchClip> | undefined,
  playlistTrackIds: ReadonlySet<Id>,
  showAll: boolean,
): readonly Id[] {
  if (showAll) return trackOrder;
  const used = new Set<Id>(playlistTrackIds);
  if (launchClips) for (const c of Object.values(launchClips)) used.add(c.trackId);
  let spare = Math.max(1, 4 - trackOrder.filter((id) => used.has(id)).length);
  const out = trackOrder.filter((id) => used.has(id) || (spare > 0 && spare-- > 0));
  return out.length === trackOrder.length ? trackOrder : out;
}

/** The first scene (in order) whose slot on `trackId` is empty, or null when the column is full. */
export function firstEmptyScene(trackId: Id, sceneOrder: readonly Id[], clips: Record<Id, LaunchClip> | undefined): Id | null {
  const idx = slotIndex(clips);
  for (const s of sceneOrder) if (!idx.has(slotKey(trackId, s))) return s;
  return null;
}

/** What a slot shows: the clip's own name, else its pattern / audio channel name. */
export function clipLabel(c: LaunchClip, p: Pick<Project, 'patterns' | 'channels'>): string {
  if (c.name) return c.name;
  if (c.kind === 'pattern') return (c.patternId && p.patterns[c.patternId]?.name) || 'Missing pattern';
  return (c.channelId && p.channels[c.channelId]?.name) || 'Missing audio';
}

export const FALLBACK_CLIP_COLOR = '#A855F7';

/** The clip's color, else its source's (pattern / channel). */
export function clipColor(c: LaunchClip, p: Pick<Project, 'patterns' | 'channels'>): string {
  if (c.color) return c.color;
  const src = c.kind === 'pattern' ? (c.patternId ? p.patterns[c.patternId]?.color : undefined) : c.channelId ? p.channels[c.channelId]?.color : undefined;
  return src || FALLBACK_CLIP_COLOR;
}

/** The playlist's "no color chosen" track color; headers show a faint accent instead. */
export const DEFAULT_TRACK_COLOR = '#3F3F52';

export function trackAccent(color: string): string {
  return color === DEFAULT_TRACK_COLOR ? 'rgba(168,85,247,0.35)' : color;
}

/** '#A855F7' (or '#a5f') + alpha → 'rgba(168,85,247,0.2)'; anything else comes back unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── Lengths ───────────────────────────────────────────────────────────

export function ticksToBars(ticks: number, ts: TimeSig): number {
  return ticks / ticksPerBar(ts);
}

/** Bars → ticks (whole ticks, at least 1). */
export function barsToTicks(bars: number, ts: TimeSig): number {
  return Math.max(1, Math.round(bars * ticksPerBar(ts)));
}

/** "4 bars", "1 bar", "1.5 bars", "0.25 bars". */
export function formatBars(bars: number): string {
  const r = Math.round(bars * 1000) / 1000;
  return `${r} bar${r === 1 ? '' : 's'}`;
}

export const LENGTH_PRESETS_BARS = [1, 2, 4, 8, 16, 32] as const;

// ── Labels ────────────────────────────────────────────────────────────

export const QUANT_LABELS: Record<LaunchQuant, string> = {
  none: 'None',
  '1/16': '1/16',
  '1/8': '1/8',
  '1/4': '1/4 (beat)',
  '1/2': '1/2',
  '1bar': '1 bar',
  '2bars': '2 bars',
  '4bars': '4 bars',
  '8bars': '8 bars',
};

export const QUANT_OPTIONS: Array<{ value: LaunchQuant; label: string }> = LAUNCH_QUANTS.map((q) => ({ value: q, label: QUANT_LABELS[q] }));

export const LAUNCH_MODE_LABELS: Record<LaunchMode, { label: string; hint: string }> = {
  trigger: { label: 'Trigger', hint: 'Click starts it; it keeps playing' },
  gate: { label: 'Gate', hint: 'Plays only while you hold the mouse button or key' },
  toggle: { label: 'Toggle', hint: 'Click starts it, click again stops it' },
  repeat: { label: 'Repeat', hint: 'Restarts every quantize step while held' },
};

export const LAUNCH_MODE_OPTIONS = LAUNCH_MODES.map((m) => ({ value: m, label: LAUNCH_MODE_LABELS[m].label }));

/** Gate and repeat clips need the release (mouse up / key up) sent to the engine. */
export function needsRelease(mode: LaunchMode): boolean {
  return mode === 'gate' || mode === 'repeat';
}

// ── Follow actions (the editor's value mapping) ───────────────────────

export const FOLLOW_LABELS: Record<FollowAction, string> = {
  none: 'Keep looping',
  stop: 'Stop',
  again: 'Play again',
  next: 'Next',
  previous: 'Previous',
  first: 'First',
  last: 'Last',
  any: 'Any',
  other: 'Other',
};

export const FOLLOW_OPTIONS = FOLLOW_ACTIONS.map((a) => ({ value: a, label: FOLLOW_LABELS[a] }));

export const MIN_AFTER_BARS = 0.25;
export const MAX_AFTER_BARS = 1024;
export const AFTER_BARS_PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;

/** Chance 0..1 → the editor's whole percent. */
export function chanceToPercent(chance: number): number {
  if (!Number.isFinite(chance)) return 100;
  return Math.round(Math.max(0, Math.min(1, chance)) * 100);
}

/** The editor's percent (any number, maybe typed) → chance 0..1 in 1 % steps. */
export function percentToChance(pct: number): number {
  if (!Number.isFinite(pct)) return 1;
  return Math.round(Math.max(0, Math.min(100, pct))) / 100;
}

/** A typed "after bars" value → a valid one: quarter-bar steps, 0.25..1024. */
export function normalizeAfterBars(bars: number): number {
  if (!Number.isFinite(bars)) return 1;
  const q = Math.round(bars * 4) / 4;
  return Math.max(MIN_AFTER_BARS, Math.min(MAX_AFTER_BARS, q));
}

/** A new follow rule for a clip: go to the next clip once this one has played through. */
export function defaultFollow(clipBars = 4): FollowRule {
  return { action: 'next', chance: 1, otherAction: 'none', afterBars: normalizeAfterBars(clipBars > 0 ? clipBars : 4) };
}

/** Clean an edited rule (the dialog's state) into what the command gets. */
export function sanitizeFollow(r: { action: FollowAction; chance: number; otherAction: FollowAction; afterBars: number }): FollowRule {
  const action = (FOLLOW_ACTIONS as readonly string[]).includes(r.action) ? r.action : 'none';
  const otherAction = (FOLLOW_ACTIONS as readonly string[]).includes(r.otherAction) ? r.otherAction : 'none';
  return { action, chance: percentToChance(chanceToPercent(r.chance)), otherAction, afterBars: normalizeAfterBars(r.afterBars) };
}

/** One line for the slot tooltip / menu: "Next after 4 bars", "Next 75 % · Stop 25 % after 2 bars". */
export function followSummary(r: FollowRule | undefined | null): string {
  if (!r) return 'No follow action';
  const pct = chanceToPercent(r.chance);
  const after = `after ${formatBars(normalizeAfterBars(r.afterBars))}`;
  if (pct >= 100 || r.action === r.otherAction) return r.action === 'none' ? 'Keeps looping' : `${FOLLOW_LABELS[r.action]} ${after}`;
  if (pct <= 0) return r.otherAction === 'none' ? 'Keeps looping' : `${FOLLOW_LABELS[r.otherAction]} ${after}`;
  return `${FOLLOW_LABELS[r.action]} ${pct} % · ${FOLLOW_LABELS[r.otherAction]} ${100 - pct} % ${after}`;
}

/** True when a rule does something (a slot shows the follow badge). */
export function followActive(r: FollowRule | undefined | null): boolean {
  if (!r) return false;
  const pct = chanceToPercent(r.chance);
  return (pct > 0 && r.action !== 'none') || (pct < 100 && r.otherAction !== 'none');
}

// ── Live state (TelemetryFrame.launcher) ──────────────────────────────

export type SlotStatus = 'playing' | 'queued' | 'idle';

/** A cheap fingerprint of everything but progress: the store only updates (and React re-renders) when it changes. */
export function liveSignature(l: LauncherTelemetry | null | undefined): string {
  if (!l) return '';
  const rec = (o: Record<string, string>): string =>
    Object.keys(o)
      .sort()
      .map((k) => `${k}=${o[k]}`)
      .join(',');
  return `${rec(l.playing)}|${rec(l.queued)}|${[...l.overridden].sort().join(',')}|${l.recording ? 1 : 0}`;
}

export function slotStatus(clipId: Id, trackId: Id, l: Pick<LauncherTelemetry, 'playing' | 'queued'> | null | undefined): SlotStatus {
  if (!l) return 'idle';
  if (l.queued[trackId] === clipId) return 'queued';
  if (l.playing[trackId] === clipId) return 'playing';
  return 'idle';
}

/** Loop progress 0..1 for a playing clip (clamped), or null when it isn't playing. */
export function clipProgress(clipId: Id, l: Pick<LauncherTelemetry, 'progress'> | null | undefined): number | null {
  const v = l?.progress[clipId];
  if (v === undefined || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

// ── Drag and drop ─────────────────────────────────────────────────────

/** Mirrors of the MIME types the other panels use (playlist pattern list, browser, channel rack). */
export const PATTERN_MIME = 'application/x-krypt-pattern';
export const SAMPLE_MIME = 'application/x-krypt-sample';
export const CHANNEL_MIME = 'application/x-krypt-channel';
/** A launch clip dragged between slots (data: its id). */
export const LAUNCH_CLIP_MIME = 'application/x-krypt-launchclip';

export type DragKind = 'slot' | 'pattern' | 'sample' | 'channel' | 'files';

/** What is being dragged, from DataTransfer.types (data can't be read during dragover). */
export function dragKind(types: readonly string[] | null | undefined): DragKind | null {
  if (!types) return null;
  if (types.includes(LAUNCH_CLIP_MIME)) return 'slot';
  if (types.includes(PATTERN_MIME)) return 'pattern';
  if (types.includes(SAMPLE_MIME)) return 'sample';
  if (types.includes(CHANNEL_MIME)) return 'channel';
  if (types.includes('Files')) return 'files';
  return null;
}

/**
 * Drop effect while dragging: slots move (Ctrl copies); everything else is a copy into the slot, except Channel
 * Rack rows, whose drag only allows 'move' (effectAllowed, set for reordering) and would be refused as a copy.
 */
export function dropEffectFor(kind: DragKind, ctrl: boolean): 'move' | 'copy' {
  if (kind === 'channel') return 'move';
  return kind === 'slot' && !ctrl ? 'move' : 'copy';
}

/** The browser sends a plain path; the playlist and others may send JSON {path, name}. */
export function parseSamplePayload(raw: string | null | undefined): { path: string; name?: string } | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s) as { path?: unknown; name?: unknown };
      if (j && typeof j.path === 'string' && j.path) return { path: j.path, name: typeof j.name === 'string' ? j.name : undefined };
      return null;
    } catch {
      return null;
    }
  }
  return { path: s };
}

export function nameFromPath(path: string): string {
  return (path.split(/[\\/:]/).pop() ?? 'Audio').replace(/\.[a-z0-9]+$/i, '') || 'Audio';
}

// ── Grid controllers ──────────────────────────────────────────────────

export const GRID_LAYOUT_LABELS: Record<LaunchGridSettings['layout'], { label: string; hint: string }> = {
  launchpad: { label: 'Launchpad-style (programmer mode)', hint: 'Pads 11 to 88, row 1 at the bottom; the right column launches scenes.' },
  'apc-mini': { label: 'APC mini-style', hint: 'Pads 0 to 63 from the bottom left; buttons 82 to 89 launch scenes.' },
  generic: { label: 'Generic 8×8 notes', hint: 'Base note + row × 8 + column; row 0 is the first scene.' },
};

/** "Any channel" + channels 1..16 (stored 0-based). */
export const MIDI_CHANNEL_OPTIONS: Array<{ value: number; label: string }> = [{ value: -1, label: 'Any' }, ...Array.from({ length: 16 }, (_, i) => ({ value: i, label: `Ch ${i + 1}` }))];

export function clampNote(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(127, Math.round(n))) : 36;
}

/** The 8×8 window the controller shows, as human text: "Tracks 1-8 · Scenes 1-8". */
export function gridWindowLabel(s: Pick<LaunchGridSettings, 'trackOffset' | 'sceneOffset'>): string {
  const t = Math.max(0, s.trackOffset);
  const r = Math.max(0, s.sceneOffset);
  return `Tracks ${t + 1}-${t + 8} · Scenes ${r + 1}-${r + 8}`;
}
