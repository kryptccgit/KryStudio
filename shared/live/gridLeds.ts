import type { LaunchGridSettings } from '../types';
import type { LauncherLedState, MidiOutputInfo } from '../engine/protocol';
import type { Project } from '../schema/project';
import { GRID_SIZE, gridLayout } from './launchGrid';

export type PadState = 'empty' | 'clip' | 'queued' | 'playing' | 'recording' | 'stopping';
export type SceneState = 'empty' | 'has' | 'queued' | 'playing';
export type TrackStopState = 'idle' | 'playing' | 'stopping';

export interface GridView {
  pads: Array<{ row: number; col: number; note: number; state: PadState; color: string | null }>;
  scenes: Array<{ row: number; note: number; state: SceneState; color: string | null }>;
  trackStops: Array<{ col: number; note: number; state: TrackStopState }>;
  stopAll: { note: number; active: boolean };
}

export const EMPTY_LAUNCHER_STATE: LauncherLedState = { playing: {}, queued: {}, overridden: [], recording: false };

export function gridView(p: Project, settings: LaunchGridSettings, st: LauncherLedState = EMPTY_LAUNCHER_STATE): GridView {
  const L = gridLayout(settings.layout, settings.baseNote);
  const tracks = p.playlist.trackOrder.slice(settings.trackOffset, settings.trackOffset + GRID_SIZE);
  const s = p.session;
  const scenes = (s?.sceneOrder ?? []).slice(settings.sceneOffset, settings.sceneOffset + GRID_SIZE);
  const slot = new Map<string, NonNullable<typeof s>['clips'][string]>();
  for (const c of Object.values(s?.clips ?? {})) slot.set(`${c.trackId}/${c.sceneId}`, c);
  const clipColor = (c: NonNullable<typeof s>['clips'][string]): string | null =>
    c.color ?? (c.kind === 'pattern' ? p.patterns[c.patternId ?? '']?.color : p.channels[c.channelId ?? '']?.color) ?? null;
  const padState = (trackId: string, clipId: string): PadState => {
    const playing = st.playing[trackId] === clipId;
    const q = st.queued[trackId];
    if (playing) {
      if (q === 'stop' || (q && q !== clipId)) return 'stopping';
      return st.recording ? 'recording' : 'playing';
    }
    return q === clipId ? 'queued' : 'clip';
  };
  const view: GridView = { pads: [], scenes: [], trackStops: [], stopAll: { note: L.stopAll, active: Object.keys(st.playing).length > 0 } };
  const valid = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 127;
  scenes.forEach((sceneId, row) => {
    const rowClips: Array<{ trackId: string; clipId: string }> = [];
    tracks.forEach((trackId, col) => {
      const c = slot.get(`${trackId}/${sceneId}`);
      const note = L.pad(row, col);
      if (!valid(note)) return;
      if (c) rowClips.push({ trackId, clipId: c.id });
      view.pads.push({ row, col, note, state: c ? padState(trackId, c.id) : 'empty', color: c ? clipColor(c) : null });
    });
    for (const c of Object.values(s?.clips ?? {})) if (c.sceneId === sceneId && !tracks.includes(c.trackId)) rowClips.push({ trackId: c.trackId, clipId: c.id });
    let state: SceneState = 'empty';
    if (rowClips.length) {
      if (rowClips.some((x) => st.queued[x.trackId] === x.clipId)) state = 'queued';
      else if (rowClips.every((x) => st.playing[x.trackId] === x.clipId)) state = 'playing';
      else state = 'has';
    }
    const note = L.scene(row);
    if (valid(note)) view.scenes.push({ row, note, state, color: s?.scenes[sceneId]?.color ?? null });
  });
  if (L.trackStop) {
    tracks.forEach((trackId, col) => {
      const note = L.trackStop!(col);
      const state: TrackStopState = st.queued[trackId] === 'stop' ? 'stopping' : st.playing[trackId] ? 'playing' : 'idle';
      view.trackStops.push({ col, note, state });
    });
  }
  return view;
}

export const LAUNCHPAD_PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  [3, 255, 255, 255],
  [5, 255, 0, 0],
  [9, 255, 84, 0],
  [13, 255, 255, 0],
  [17, 84, 255, 0],
  [21, 0, 255, 0],
  [29, 0, 255, 85],
  [33, 0, 255, 153],
  [37, 0, 169, 255],
  [41, 0, 85, 255],
  [45, 0, 0, 255],
  [49, 84, 0, 255],
  [53, 255, 0, 255],
  [57, 255, 0, 84],
];
export const LP_OFF = 0;
export const LP_DIM_WHITE = 1;
export const LP_WHITE = 3;
export const LP_RED = 5;
export const LP_DIM_RED = 7;
export const LP_GREEN = 21;

export function launchpadColor(hex: string | null | undefined): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return LP_WHITE;
  const x = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const r = parseInt(x.slice(0, 2), 16);
  const g = parseInt(x.slice(2, 4), 16);
  const b = parseInt(x.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 24 || (max - min) / max < 0.2) return LP_WHITE;
  const h = hue(r, g, b);
  let best = LP_WHITE;
  let bestD = Infinity;
  for (const [i, pr, pg, pb] of LAUNCHPAD_PALETTE) {
    if (i === LP_WHITE) continue;
    const d = Math.abs(((hue(pr, pg, pb) - h + 540) % 360) - 180);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export interface LaunchpadModel {
  id: 'lpx' | 'lpminimk3' | 'lppromk3';
  label: string;
  device: number;
  match: RegExp;
}

export const LAUNCHPAD_MODELS: readonly LaunchpadModel[] = [
  { id: 'lpx', label: 'Launchpad X', device: 0x0c, match: /\bLPX\b|launchpad\s*x\b/i },
  { id: 'lpminimk3', label: 'Launchpad Mini MK3', device: 0x0d, match: /LPMiniMK3|launchpad\s*mini\s*mk3/i },
  { id: 'lppromk3', label: 'Launchpad Pro MK3', device: 0x0e, match: /LPProMK3|launchpad\s*pro\s*mk3/i },
];

export function launchpadModel(portName: string | null | undefined): LaunchpadModel | null {
  return LAUNCHPAD_MODELS.find((m) => m.match.test(portName ?? '')) ?? null;
}

export function launchpadProgrammerMode(portName: string | null | undefined, on: boolean): number[][] {
  const m = launchpadModel(portName);
  const models = m ? [m] : LAUNCHPAD_MODELS;
  return models.map((x) => [0xf0, 0x00, 0x20, 0x29, 0x02, x.device, 0x0e, on ? 1 : 0, 0xf7]);
}

export type LedMap = Record<string, number[][]>;

function launchpadMap(v: GridView): LedMap {
  const out: LedMap = {};
  const note = (n: number, look: number[][]) => (out[`n${n}`] = look.map(([st, vel]) => [0x90 | st, n, vel]));
  const cc = (n: number, look: number[][]) => (out[`c${n}`] = look.map(([st, vel]) => [0xb0 | st, n, vel]));
  const still = (c: number) => [[0, c]];
  const flash = (from: number, to: number) => [[0, from], [1, to]];
  const pulse = (c: number) => [[2, c]];
  for (const p of v.pads) {
    const c = launchpadColor(p.color);
    const look =
      p.state === 'empty' ? still(LP_OFF)
      : p.state === 'clip' ? still(c)
      : p.state === 'queued' ? flash(c, LP_GREEN)
      : p.state === 'playing' ? pulse(LP_GREEN)
      : p.state === 'recording' ? pulse(LP_RED)
      : flash(LP_OFF, c);
    note(p.note, look);
  }
  for (const s of v.scenes) {
    const look = s.state === 'empty' ? still(LP_OFF) : s.state === 'has' ? still(s.color ? launchpadColor(s.color) : LP_DIM_WHITE) : s.state === 'queued' ? flash(LP_DIM_WHITE, LP_GREEN) : still(LP_GREEN);
    cc(s.note, look);
  }
  cc(v.stopAll.note, still(v.stopAll.active ? LP_RED : LP_DIM_RED));
  return out;
}

export const APC = { off: 0, green: 1, greenBlink: 2, red: 3, redBlink: 4, yellow: 5, yellowBlink: 6 } as const;

function apcMap(v: GridView): LedMap {
  const out: LedMap = {};
  const set = (n: number, vel: number) => (out[`n${n}`] = [[0x90, n, vel]]);
  for (const p of v.pads) {
    set(p.note, p.state === 'empty' ? APC.off : p.state === 'clip' ? APC.yellow : p.state === 'queued' ? APC.greenBlink : p.state === 'playing' ? APC.green : p.state === 'recording' ? APC.red : APC.yellowBlink);
  }
  for (const s of v.scenes) set(s.note, s.state === 'queued' ? 2 : s.state === 'playing' ? 1 : 0);
  for (const t of v.trackStops) set(t.note, t.state === 'stopping' ? 2 : t.state === 'playing' ? 1 : 0);
  return out;
}

function genericMap(v: GridView, channel: number): LedMap {
  const out: LedMap = {};
  const st = 0x90 | (channel & 15);
  const set = (n: number, lit: boolean) => (out[`n${n}`] = [[st, n, lit ? 127 : 0]]);
  for (const p of v.pads) set(p.note, p.state !== 'empty' && p.state !== 'clip');
  for (const s of v.scenes) set(s.note, s.state === 'playing' || s.state === 'queued');
  set(v.stopAll.note, v.stopAll.active);
  return out;
}

export function ledMap(settings: LaunchGridSettings, v: GridView): LedMap {
  switch (settings.layout) {
    case 'launchpad':
      return launchpadMap(v);
    case 'apc-mini':
      return apcMap(v);
    case 'generic':
      return genericMap(v, settings.channel ?? 0);
  }
}

export function ledOff(map: LedMap): LedMap {
  const out: LedMap = {};
  for (const [k, msgs] of Object.entries(map)) {
    const first = msgs[0];
    if (first) out[k] = [[first[0] & 0xf0, first[1], 0]];
  }
  return out;
}

export function ledChanges(prev: LedMap | null, next: LedMap): number[][] {
  const out: number[][] = [];
  for (const [k, msgs] of Object.entries(next)) {
    const before = prev?.[k];
    if (!before || JSON.stringify(before) !== JSON.stringify(msgs)) out.push(...msgs);
  }
  if (prev) {
    for (const [k, msgs] of Object.entries(prev)) {
      if (!(k in next) && msgs[0]) out.push([msgs[0][0] & 0xf0, msgs[0][1], 0]);
    }
  }
  return out;
}

export function portKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bmidi(?:in|out)(\d*)\b/g, 'midi$1')
    .split(/[\s_\-()]+/)
    .filter((t) => t && !['in', 'out', 'input', 'output'].includes(t))
    .join(' ');
}

const LAYOUT_HINT: Record<LaunchGridSettings['layout'], RegExp | null> = {
  launchpad: /launchpad|\blp(x|minimk3|promk3)\b/i,
  'apc-mini': /apc\s*mini/i,
  generic: null,
};

export function pairLedOutput(inputId: string | null, layout: LaunchGridSettings['layout'], outputs: readonly Pick<MidiOutputInfo, 'id' | 'name'>[]): string | null {
  const usable = outputs.filter((o) => !/wavetable|microsoft gs/i.test(o.name));
  if (inputId) {
    const exact = usable.find((o) => o.id === inputId || o.name === inputId);
    if (exact) return exact.id;
    const k = portKey(inputId);
    const same = usable.filter((o) => portKey(o.id) === k);
    if (same.length) return same[0].id;
    return null;
  }
  const hint = LAYOUT_HINT[layout];
  if (!hint) return null;
  const hits = usable.filter((o) => hint.test(o.name));
  return hits.length === 1 ? hits[0].id : null;
}

export function resolveLedOutput(settings: LaunchGridSettings, outputs: readonly Pick<MidiOutputInfo, 'id' | 'name'>[]): string | null {
  if (!settings.enabled || settings.ledOutput === null) return null;
  if (typeof settings.ledOutput === 'string' && settings.ledOutput) return settings.ledOutput;
  return pairLedOutput(settings.device, settings.layout, outputs);
}
