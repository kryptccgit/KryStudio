// Persistent settings: userData/settings.json, written atomically, ALWAYS
// merged field-by-field over DEFAULT_SETTINGS on load and on update
// (kryptguidelines §5.9: old files lack new fields; never trust the JSON).
// Listeners (ipc.ts → `settings:changed`) fire after every successful update.

import { app } from 'electron';
import path from 'node:path';
import { FILE_ACCESS_MODES, type ExportSettings, type FileAccessMode, type LibrarySettings, type Settings } from '@shared/types';
import type { LibraryFocus } from '@shared/library/types';
import { sanitizeKeymapOverrides } from '@shared/keymap';
import { audioInputSettings, DEFAULT_AUDIO_INPUT, DEFAULT_MIDI_SETTINGS, DEFAULT_RECORDING, mergeLiveSettings, midiSettings, recordingSettings } from '@shared/live/recording';
import { DEFAULT_LAUNCH_GRID, launchGridSettings, mergeLaunchGrid } from '@shared/live/launchGrid';
import { DEFAULT_MIDI_OUT, mergeMidiOut } from '@shared/live/midiOut';
import { DEFAULT_CONTROLLERS, mergeControllers } from '@shared/live/controllers';
import { AGENT_PROVIDER_IDS, isAgentProvider, type AgentProvider } from '@shared/agent/providers';
import { readTextSync, writeFileAtomicSync } from './files';
import { logger } from './logger';

export const DEFAULT_SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true, openToHome: true, homeLite: false, startWithWindows: true, trayNoticeShown: false },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  // fileAccess 'anywhere': it's the user's own computer; agents on the local pipe may open any local audio file.
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: true, fileAccess: 'anywhere' },
  agent: { model: 'claude-opus-5-5', hasApiKey: false, provider: 'anthropic', models: {}, keys: {} },
  discordRpc: true,
  midi: DEFAULT_MIDI_SETTINGS,
  recording: DEFAULT_RECORDING,
  audioInput: DEFAULT_AUDIO_INPUT,
  library: { fastScan: false, focus: null },
  export: { folder: 'music' },
  launchGrid: DEFAULT_LAUNCH_GRID,
  midiOut: DEFAULT_MIDI_OUT,
  controllers: DEFAULT_CONTROLLERS,
};

export const MAX_RECENT = 12;

let cache: Settings | null = null;
const listeners = new Set<(s: Settings, prev: Settings) => void>();

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

/** The built-in chat's settings: provider, a model per provider (free text, capped), which providers have a key. */
function mergeAgent(base: Settings['agent'], input: unknown): Settings['agent'] {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = <T,>(raw: unknown, prev: Partial<Record<AgentProvider, T>> | undefined, ok: (v: unknown) => v is T): Partial<Record<AgentProvider, T>> => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: Partial<Record<AgentProvider, T>> = {};
    for (const p of AGENT_PROVIDER_IDS) {
      const v = p in r ? r[p] : prev?.[p];
      if (ok(v)) out[p] = v;
    }
    return out;
  };
  const isModel = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const provider = isAgentProvider(a.provider) ? a.provider : base.provider ?? 'anthropic';
  const keys = pick('keys' in a ? a.keys : undefined, base.keys, isBool);
  return {
    model: str(a.model, base.model) || base.model,
    // Follows the selected provider once main has recorded which providers have a key.
    hasApiKey: keys[provider] ?? bool(a.hasApiKey, base.hasApiKey),
    provider,
    models: pick('models' in a ? a.models : undefined, base.models, isModel),
    keys,
  };
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reference-library settings: fast scan + the AI's style focus (validated field by field). */
export function mergeLibrarySettings(base: LibrarySettings | undefined, input: unknown): LibrarySettings {
  const b: LibrarySettings = base ?? { fastScan: false, focus: null };
  if (input === undefined) return { fastScan: b.fastScan, focus: b.focus ? { ...b.focus } : null };
  const o = obj(input);
  let focus: LibraryFocus | null = b.focus;
  if ('focus' in o) {
    const f = o.focus === null ? null : obj(o.focus);
    focus =
      f && typeof f.collectionId === 'string' && f.collectionId
        ? { collectionId: f.collectionId, name: str(f.name, '').slice(0, 64), brief: str(f.brief, '').slice(0, 500) }
        : null;
  }
  return { fastScan: bool(o.fastScan, b.fastScan), focus };
}

const fileAccess = (v: unknown, d: FileAccessMode | undefined): FileAccessMode => (FILE_ACCESS_MODES.includes(v as FileAccessMode) ? (v as FileAccessMode) : d ?? 'anywhere');

function mergeExportSettings(base: ExportSettings | undefined, input: unknown): ExportSettings {
  const o = obj(input);
  const b = base ?? { folder: 'music' };
  return { folder: o.folder === 'music' || o.folder === 'project' ? o.folder : b.folder };
}

/** Merge an untrusted partial over a base, validating every field. */
export function mergeSettings(base: Settings, input: unknown): Settings {
  const o = obj(input);
  const audio = obj(o.audio);
  const ui = obj(o.ui);
  const mcp = obj(o.mcp);
  const agent = obj(o.agent);
  const roots = Array.isArray(o.browserRoots)
    ? o.browserRoots
        .map(obj)
        .filter((r) => typeof r.id === 'string' && typeof r.path === 'string' && r.path)
        .map((r) => ({ id: String(r.id), name: str(r.name, path.basename(String(r.path))), path: String(r.path) }))
    : base.browserRoots;
  const recent = Array.isArray(o.recent) ? o.recent.filter((r): r is string => typeof r === 'string' && !!r).slice(0, MAX_RECENT) : base.recent;
  return {
    audio: {
      deviceId: 'deviceId' in audio ? (typeof audio.deviceId === 'string' ? audio.deviceId : null) : base.audio.deviceId,
      bufferFrames: Math.round(num(audio.bufferFrames, base.audio.bufferFrames, 16, 8192)),
      sampleRate: Math.round(num(audio.sampleRate, base.audio.sampleRate, 8000, 384000)),
    },
    ui: {
      scale: num(ui.scale, base.ui.scale, 0.5, 2),
      showHints: bool(ui.showHints, base.ui.showHints),
      openToHome: bool(ui.openToHome, base.ui.openToHome ?? true),
      homeLite: bool(ui.homeLite, base.ui.homeLite ?? false),
      startWithWindows: bool(ui.startWithWindows, base.ui.startWithWindows ?? true),
      trayNoticeShown: bool(ui.trayNoticeShown, base.ui.trayNoticeShown ?? false),
    },
    browserRoots: roots,
    recent,
    autosaveSec: Math.round(num(o.autosaveSec, base.autosaveSec, 0, 3600)),
    mcp: {
      enabled: bool(mcp.enabled, base.mcp.enabled),
      httpEnabled: bool(mcp.httpEnabled, base.mcp.httpEnabled),
      httpPort: Math.round(num(mcp.httpPort, base.mcp.httpPort, 1024, 65535)),
      requireConsentForDestructive: bool(mcp.requireConsentForDestructive, base.mcp.requireConsentForDestructive),
      fileAccess: fileAccess(mcp.fileAccess, base.mcp.fileAccess),
    },
    agent: mergeAgent(base.agent, agent),
    discordRpc: bool(o.discordRpc, base.discordRpc),
    keymap: 'keymap' in o ? sanitizeKeymapOverrides(o.keymap) ?? {} : base.keymap ?? {},
    // Live input / recording (validated in shared/live/recording.ts).
    ...mergeLiveSettings({ midi: midiSettings(base), recording: recordingSettings(base), audioInput: audioInputSettings(base) }, o),
    library: mergeLibrarySettings(base.library, o.library),
    export: mergeExportSettings(base.export, o.export),
    launchGrid: mergeLaunchGrid(launchGridSettings(base), o.launchGrid),
    midiOut: mergeMidiOut(base.midiOut, o.midiOut),
    controllers: mergeControllers(base.controllers, o.controllers),
  };
}

export function getSettings(): Settings {
  if (cache) return cache;
  const raw = readTextSync(file());
  let parsed: unknown = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('settings.json was unreadable; using defaults');
    }
  }
  cache = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed);
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const prev = getSettings();
  const next = mergeSettings(prev, patch);
  cache = next;
  try {
    writeFileAtomicSync(file(), JSON.stringify(next, null, 2));
  } catch (err) {
    logger.error(`Couldn't save settings: ${(err as Error).message}`);
  }
  for (const fn of listeners) {
    try {
      fn(next, prev);
    } catch {
      /* ignore */
    }
  }
  return next;
}

export function onSettingsChanged(fn: (s: Settings, prev: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Push a path to the front of the recent-files list. */
export function addRecent(p: string): void {
  const s = getSettings();
  const key = p.toLowerCase();
  updateSettings({ recent: [p, ...s.recent.filter((r) => r.toLowerCase() !== key)].slice(0, MAX_RECENT) });
}
