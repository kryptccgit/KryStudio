// ──────────────────────────────────────────────────────────────────────
// Browser-only mock of window.krypt for UI development WITHOUT Electron or
// the engine: `npx vite` → open http://localhost:5190 in a normal browser.
// The document side is REAL (the actual DocHost + commands + catalog run
// in-page), so editors behave exactly like in the app. Engine/file/MCP calls
// are stubs that resolve with { ok:false, message:'mock' } or empty data.
// The analyzer (Model Manager, tempo & key, stems, audio → pattern) is a
// full fake with progress (mockAnalyzer.ts); the mock project starts with
// one audio clip ("Night Drive") so its clip menu can be tried. The
// reference library (collections, queue, profiles, focus, originality) is
// a full fake too (mockLibrary.ts), and so are the vocal tools (Auto-tune
// vocal, Match key & tempo: mockVocals.ts).
// main.tsx installs this only when window.krypt is missing.
// ──────────────────────────────────────────────────────────────────────

import { DocHost, USER, actorKey, type Actor, type DocChange } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { ClientConfigSnippet, KryptApi, McpStatus, PluginManagerState, Settings } from '@shared/types';
import type { PluginDescriptor } from '@shared/plugins/types';
import { sanitizeKeymapOverrides } from '@shared/keymap';
import { createMockAnalyzer, ensureAudioClipStretchParams } from './mockAnalyzer';
import { createMockLibrary } from './mockLibrary';
import { createMockVocals } from './mockVocals';
import { createMockSounds } from './mockSounds';
import { createMockPacks } from './mockPacks';
import { sliceTimes } from '@shared/commands/racks';
import { DRUM_RACK_BASE_NOTE } from '@shared/schema/rack';
import { SLICER_PLUGIN } from '@shared/schema/slicer';
import { createMockScripts } from './mockScripts';
import { createMockMashup } from './mockMashup';
import { createMockAutomix } from './mockAutomix';
import { createMockVoice } from './mockVoice';

const notReady = { ok: false as const, message: 'Not available in browser mock' };

/** A Windows path from parts (no backslash escaping to get wrong). */
const win = (...parts: string[]): string => parts.join('\\');

export function installMockKrypt(): void {
  ensureAudioClipStretchParams();
  // Seed (outside history): one long audio clip to try the analyzer menus on.
  const seed = new DocHost(createDefaultProject('Mock Project'), CATALOG);
  const lane = seed.project.playlist.trackOrder[3] ?? seed.project.playlist.trackOrder[0];
  if (lane) seed.exec('playlist.addAudio', { path: 'factory:loops/night-drive.wav', name: 'Night Drive', trackId: lane, start: 0, frames: 48000 * 96, sampleRate: 48000, channels: 2 }, { actor: USER });
  const host = new DocHost(seed.project, CATALOG);
  const patchSubs = new Set<(m: any) => void>();
  const resetSubs = new Set<(m: any) => void>();
  const historySubs = new Set<() => void>();
  host.subscribe((c: DocChange) => {
    if (c.kind === 'reset') resetSubs.forEach((fn) => fn({ version: c.version, project: c.project }));
    else patchSubs.forEach((fn) => fn({ version: c.version, kind: c.kind, actor: c.actor, label: c.label, patches: c.patches }));
    historySubs.forEach((fn) => fn());
  });
  const sub = <T>(set: Set<T>, fn: T) => {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  };
  let settings: Settings = {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [],
    // Home hub: a few recent projects so the "Continue" panel and Projects screen look real.
    recent: [
      win('C:', 'Users', 'you', 'Music', 'Krypt', 'Late Night Drill.kstudio'),
      win('C:', 'Users', 'you', 'Music', 'Krypt', 'Neon Fog remix.kstudio'),
      win('D:', 'Beats', '2026', 'Ocean Tape (lofi).kstudio'),
      win('D:', 'Beats', '2026', 'Club test 128.kstudio'),
      win('C:', 'Users', 'you', 'Documents', 'Sketch 14.kstudio'),
    ],
    autosaveSec: 60,
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: true, fileAccess: 'anywhere' },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: true,
    export: { folder: 'music' },
  };
  let playing = false;

  // ── MCP (Home's AI Agents pill): one connected client; flip it from devtools ──
  // __kryptMockMcp.connect('Cursor') / .disconnect() / .setEnabled(false)
  const mcpSubs = new Set<(s: McpStatus) => void>();
  let mcpStatus: McpStatus = {
    enabled: true,
    pipeName: win('', '', '.', 'pipe', 'krypt-studio-mcp-mock'),
    http: { enabled: false, url: null },
    clients: [{ clientId: 'claude-code', name: 'Claude Code', connectedAt: Date.now() - 4 * 60_000, calls: 12 }],
    shimPath: null,
  };
  const setMcp = (next: Partial<McpStatus>): void => {
    mcpStatus = { ...mcpStatus, ...next };
    mcpSubs.forEach((fn) => fn(mcpStatus));
  };
  (window as any).__kryptMockMcp = {
    connect: (name = 'Cursor') => setMcp({ clients: [...mcpStatus.clients, { clientId: name.toLowerCase().replace(/\W+/g, '-'), name, connectedAt: Date.now(), calls: 0 }] }),
    disconnect: () => setMcp({ clients: [] }),
    setEnabled: (enabled: boolean) => setMcp({ enabled, clients: enabled ? mcpStatus.clients : [] }),
  };
  const SHIM = win('C:', 'Program Files', 'Krypt Studio', 'resources', 'resources', 'bin', 'krypt-studio-mcp.exe');
  const clientConfigs: ClientConfigSnippet[] = [
    { client: 'claude-code', description: 'Claude Code: run this once in a terminal (user scope, all projects). Then ask Claude to "use krypt-studio".', snippet: `claude mcp add --scope user krypt-studio -- "${SHIM}" --client claude-code`, installable: true },
    ...(['claude-desktop', 'cursor', 'vscode'] as const).map((client) => ({
      client,
      description: `Browser mock: the real app writes this into ${client}'s config file (with a .bak backup).`,
      snippet: JSON.stringify({ [client === 'vscode' ? 'servers' : 'mcpServers']: { 'krypt-studio': { command: SHIM, args: ['--client', client] } } }, null, 2),
      installable: true,
    })),
  ];

  // ── Plugin Manager (Sounds & Plugins pill): a few fake installed VST3 / CLAP plugins ──
  const fakePlugin = (id: string, name: string, kind: 'instrument' | 'effect', category: string, format: 'vst3' | 'clap'): PluginDescriptor => ({
    id,
    name,
    kind,
    category,
    description: 'Browser mock plugin (not real).',
    format,
    vendor: 'Example Audio',
    version: '1.0.0',
    path: win('C:', 'Program Files', 'Common Files', format.toUpperCase(), `${name}.${format}`),
    hasEditor: true,
    params: [{ id: 'gain', name: 'Gain', min: 0, max: 1, default: 0.5, unit: '', scale: 'linear' }],
  });
  const pluginState: PluginManagerState = {
    plugins: [
      fakePlugin('vst3:MOCK0000000000000000000000000001', 'Mock Poly Synth', 'instrument', 'Synth', 'vst3'),
      fakePlugin('vst3:MOCK0000000000000000000000000002', 'Mock Tape Echo', 'effect', 'Delay', 'vst3'),
      fakePlugin('clap:com.example.mock-eq', 'Mock Channel EQ', 'effect', 'EQ', 'clap'),
    ],
    files: [],
    blocked: [],
    folders: [
      { path: win('C:', 'Program Files', 'Common Files', 'VST3'), builtin: true, exists: true },
      { path: win('C:', 'Program Files', 'Common Files', 'CLAP'), builtin: true, exists: true },
    ],
    scanning: false,
    progress: null,
    lastScanAt: Date.now() - 3 * 86_400_000,
    vst2Found: 0,
    hostAvailable: true,
    hostPid: null,
    instances: [],
  };
  const analyzer = createMockAnalyzer(host);

  const api: KryptApi = {
    app: {
      version: async () => '0.1.0-mock',
      openExternal: async (u) => {
        window.open(u, '_blank');
        return { ok: true };
      },
      showItemInFolder: async () => notReady,
      pathForFile: () => '',
      window: async () => {},
      isMaximized: async () => false,
      onMaximizedChanged: () => () => {},
      onOpenFile: () => () => {},
    },
    doc: {
      snapshot: async () => ({ version: host.version, project: host.project }),
      exec: async (cmd, args, opts) => host.exec(cmd, args, { actor: USER, ...opts }) as any,
      execBatch: async (steps, opts) => host.execBatch(steps, { actor: USER, ...opts }) as any,
      beginGroup: async (label) => host.beginGroup(USER, label),
      endGroup: async (g) => host.endGroup(g),
      undo: async () => host.undo(USER),
      redo: async () => host.redo(USER),
      history: async () => host.getHistory(),
      toggleEntry: async (id) => host.toggleEntry(id, USER),
      revertActor: async (key) => {
        const [kind, clientId] = key.split(':');
        const actor: Actor = kind === 'agent' ? { kind: 'agent', clientId, name: clientId } : kind === 'system' ? { kind: 'system' } : USER;
        return actorKey(actor) === key ? host.revertActor(actor, USER) : { ok: false, message: 'bad actor', version: host.version };
      },
      onPatches: (cb) => sub(patchSubs, cb),
      onReset: (cb) => sub(resetSubs, cb),
      onHistoryChanged: (cb) => sub(historySubs, cb),
    },
    project: {
      status: async () => ({ path: null, name: host.project.meta.name, dirty: false, lastSavedAt: null, recovered: false }),
      newProject: async () => {
        host.reset(createDefaultProject());
        return { ok: true };
      },
      templates: async () => ({ ok: true, data: [] }),
      saveAsTemplate: async () => notReady,
      newFromTemplate: async () => notReady,
      renameTemplate: async () => notReady,
      deleteTemplate: async () => notReady,
      open: async () => notReady,
      save: async () => notReady,
      saveAs: async () => notReady,
      importMidi: async () => notReady,
      exportMidi: async () => notReady,
      onStatus: () => () => {},
      cover: async () => ({ ok: true, data: null }),
      chooseCover: async () => notReady,
      setCoverImage: async () => notReady,
      onCoverRequest: () => () => {},
      respondCover: () => {},
      exportCapabilities: async () => ({ agentFolder: '' }),
    },
    engine: {
      status: async () => ({ state: 'stopped', message: 'Browser mock — no audio engine', device: null, engineVersion: null, restarts: 0 }),
      onStatus: () => () => {},
      telemetryUrl: async () => null,
      transport: async (action) => {
        playing = action === 'toggle' ? !playing : action === 'play';
        return { ok: true, data: { playing } };
      },
      locate: async () => ({ ok: true }),
      audition: () => {},
      auditionOff: () => {},
      previewFile: async () => notReady,
      stopPreview: async () => ({ ok: true }),
      listDevices: async () => ({ ok: true, data: [] }),
      openDevice: async () => notReady,
      render: async () => notReady,
      onRenderProgress: () => () => {},
      sampleInfo: async () => notReady,
      peaks: async () => notReady,
      analyzeFile: async () => notReady,
      restart: async () => notReady,
    },
    browser: {
      roots: async () => [{ id: 'factory', name: 'Factory Kit', path: 'factory:', builtin: true }],
      list: async () => ({
        ok: true,
        data: ['kick', 'clap', 'snare', 'hat-closed', 'hat-open', 'rim', 'perc', 'tom', 'crash', '808'].map((n) => ({ name: `${n}.wav`, path: `factory:drums/${n}.wav`, kind: 'audio' as const })),
      }),
      addRoot: async () => notReady,
      removeRoot: async () => notReady,
    },
    dialog: { openFile: async () => null, saveFile: async () => null },
    settings: {
      get: async () => settings,
      update: async (patch) =>
        (settings = { ...settings, ...patch, ...(patch.keymap !== undefined ? { keymap: sanitizeKeymapOverrides(patch.keymap) ?? {} } : {}) }),
      onChanged: () => () => {},
    },
    mcp: {
      status: async () => mcpStatus,
      onStatus: (cb) => sub(mcpSubs, cb),
      onActivity: () => () => {},
      clientConfigs: async () => clientConfigs,
      installClientConfig: async () => notReady,
      setEnabled: async (enabled) => {
        setMcp({ enabled, clients: enabled ? mcpStatus.clients : [] });
        return { ok: true };
      },
    },
    agent: {
      setApiKey: async () => notReady,
      send: async () => notReady,
      cancel: async () => {},
      reset: async () => {},
      onEvent: () => () => {},
    },
    log: { onAppend: () => () => {} },
    midi: {
      inputs: async () => ({ ok: true, data: [] }),
      setInputEnabled: async () => notReady,
      setTarget: () => {},
      learn: async () => notReady,
      cancelLearn: () => {},
      virtualIn: () => {}, // no engine in the browser: controller MIDI goes nowhere
      removeMapping: async () => notReady,
      onInputs: () => () => {},
      onLearn: () => () => {},
      outputs: async () => ({ ok: true, data: [] }),
      setOutputEnabled: async () => notReady,
      clockSettings: async () => ({ outputs: {}, clockPorts: [], clockOffsetMs: 0, syncInput: null, syncWritesTempo: true }),
      setClockSettings: async () => notReady,
      onOutputs: () => () => {},
    },
    record: {
      status: async () => ({ armed: false, input: null }),
      setArmed: async () => notReady,
      setMeter: async () => ({ ok: false, message: 'The mic test needs the audio engine (desktop app).' }),
      listInputDevices: async () => ({ ok: true, data: [] }),
      onStatus: () => () => {},
    },
    plugins: {
      state: async () => pluginState,
      rescan: async () => notReady,
      addFolder: async () => notReady,
      removeFolder: async () => notReady,
      unblock: async () => notReady,
      openEditor: async () => notReady,
      reload: async () => notReady,
      onState: () => () => {},
    },
    analyzer,
    audioProject: {
      open: async () => ({ ok: false, message: 'Audio → project needs the desktop app (stems and transcription run on your PC).' }),
      cancel: async () => ({ ok: true }),
      onProgress: () => () => {},
    },
    vocals: createMockVocals(host, analyzer),
    warp: {
      autoWarp: async () => ({ ok: false, message: 'Auto-warp needs the audio analyzer (desktop app). Warp by hand: double-click the waveform on a beat, then drag the marker.' }),
    },
    library: createMockLibrary(host, analyzer),
    sounds: createMockSounds(),
    packs: createMockPacks(),
    voice: createMockVoice(host), // Kokoro voices, a Fish key that unlocks cloud voices, Speak / Sing with progress and a real clip (src/dev/mockVoice.ts)
    automix: createMockAutomix(host), // canned presets + keyword reader + a run with one real history entry (src/dev/mockAutomix.ts)
    tabs: {
      state: async () => ({ tabs: [{ id: 'tab_mock', title: 'Untitled', path: null, dirty: false }], activeId: 'tab_mock', closed: [] }),
      onState: () => () => {},
      newTab: async () => ({ ok: false, message: 'Project tabs need the desktop app.' }),
      open: async () => ({ ok: false, message: 'Project tabs need the desktop app.' }),
      switchTo: async () => ({ ok: true }),
      close: async () => ({ ok: false, message: 'Project tabs need the desktop app.' }),
      move: async () => ({ ok: true }),
      reopenClosed: async () => ({ ok: false, message: 'Project tabs need the desktop app.' }),
    },
    mashup: createMockMashup(), // canned check + a build that edits nothing (src/dev/mockMashup.ts)
    session: {
      launch: async () => ({ ok: false, message: 'The clip launcher needs the engine (desktop app).' }),
      launchScene: async () => ({ ok: false, message: 'The clip launcher needs the engine (desktop app).' }),
      stop: async () => ({ ok: true }),
      backToArrangement: async () => ({ ok: true }),
      setRecord: async () => ({ ok: false, message: 'The clip launcher needs the engine (desktop app).' }),
      recordState: async () => ({ on: false }),
      onRecordState: () => () => {},
      gridSettings: async () => ({ enabled: false, device: null, channel: null, layout: 'launchpad', baseNote: 36, trackOffset: 0, sceneOffset: 0 }),
      setGridSettings: async () => ({ ok: false, message: 'Grid controllers need the desktop app.' }),
    },
    racks: {
      // No analyzer in the browser: grid / manual slicing over the sample's known length (else 2 bars).
      sliceToPads: async (source, opts = {}) => {
        const mode = opts.mode ?? (opts.times?.length ? 'manual' : 'onsets');
        if (mode === 'onsets') return { ok: false, message: 'Finding the hits needs the audio analyzer (desktop app). Slice by grid instead.' };
        const p = host.project;
        const chId = 'clipId' in source ? p.playlist.clips[source.clipId]?.channelId : 'channelId' in source ? source.channelId : undefined;
        const smp = chId ? p.samples[p.channels[chId]?.generator.sampleId ?? ''] : undefined;
        if (!('path' in source) && !smp) return { ok: false, message: 'That has no sample to slice' };
        const bpm = opts.bpm ?? p.transport.bpm;
        const lengthSec = smp?.frames && smp.sampleRate ? smp.frames / smp.sampleRate : (8 * 60) / bpm;
        const times = sliceTimes({ mode, lengthSec, times: opts.times, bpm, division: opts.division, maxSlices: opts.maxSlices ?? 16 });
        const sample = smp ? { sampleId: smp.id } : { samplePath: (source as { path: string }).path };
        if (opts.to === 'slicer') {
          const own = chId && p.channels[chId]?.generator.type === SLICER_PLUGIN ? chId : undefined;
          const s = host.exec<any>('slicer.slice', { ...sample, channelId: opts.channelId ?? own, name: opts.name, slices: times, lengthSec, bpm, pattern: opts.pattern ?? true }, { actor: USER });
          if (!s.ok) return { ok: false, message: s.message ?? 'Slicing failed' };
          return { ok: true, message: `Sliced into ${s.data.slices.length} slices (browser mock: grid only)`, data: { channelId: s.data.channelId, insertId: s.data.insertId, patternId: s.data.patternId, slices: s.data.slices.length, times: s.data.slices, mode, bpm, lengthSec, hasEnd: true, to: 'slicer', baseKey: s.data.baseKey } };
        }
        const r = host.exec<any>('rack.sliceToPads', { ...(smp ? { sampleId: smp.id } : { samplePath: (source as { path: string }).path }), channelId: opts.channelId, name: opts.name, slices: times, lengthSec, bpm, pattern: opts.pattern ?? true, choke: opts.choke ?? 0 }, { actor: USER });
        if (!r.ok) return { ok: false, message: r.message ?? 'Slicing failed' };
        return { ok: true, message: `Sliced into ${r.data.slices.length} pads (browser mock: grid only)`, data: { channelId: r.data.channelId, insertId: r.data.insertId, patternId: r.data.patternId, slices: r.data.slices.length, times: r.data.slices, mode, bpm, lengthSec, hasEnd: r.data.hasEnd, to: 'pads', baseKey: DRUM_RACK_BASE_NOTE } };
      },
      onSliceProgress: () => () => {},
    },
    scripts: createMockScripts(host),
  };
  // Home's Reference Library pill: start with an AI focus set.
  void api.library.setFocus({ collectionId: 'c-dark', brief: 'dark, sparse, lots of space' });
  (window as any).krypt = api;
  (window as any).__kryptMockHost = host; // devtools: drive the doc as an "agent"
  console.info('[krypt] Browser mock installed — DocHost runs in-page, engine calls are stubs.');
}
