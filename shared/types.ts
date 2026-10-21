// ──────────────────────────────────────────────────────────────────────
// The window.krypt.* contract between the renderer and Electron main
// (kryptguidelines §4.3/§4.4). preload.ts implements it with ipcRenderer;
// electron/ipc.ts registers every channel. Wrappers return ActionResult and
// never throw across IPC. Every subscription returns an unsubscribe fn.
// ──────────────────────────────────────────────────────────────────────

import type { SingOutcome, SingRequest, SpeakOutcome, SpeakRequest, VoiceInfo, VoiceProgress, VoiceState } from './voice/types';
import type {
  AlbumExportOutcome,
  AlbumExportRequest,
  AlbumOutcome,
  AlbumRequest,
  AutoMixIntent,
  AutoMixOutcome,
  AutoMixPreset,
  AutoMixProgress,
  AutoMixRequest,
  MasterFileRequest,
  ReferenceSound,
} from './automix/types';
import type { MashupCheck, MashupOutcome, MashupProgress, MashupRequest } from './mashup/types';
import type { Patch } from 'immer';
import type { Project } from './schema/project';
import type { Actor, ExecResult, HistorySummary } from './doc/DocHost';
import type { Analysis, DeviceInfo, DeviceStatus, Peaks, RenderResult, RenderScope, SampleInfo } from './engine/protocol';
import type { InputStatus, MidiInputInfo, Mp3Kbps } from './engine/protocol';
import type { MidiOutputInfo } from './engine/protocol';
import type { ControllerSettings } from './live/controllers';
import type { PluginDescriptor } from './plugins/types';
import type { ModelDef } from './analyzer/models';
import type { AnalyzerDevice, AudioAnalysis, StemName, TranscribeMode } from './analyzer/protocol';
import type { Collection, LibraryFocus, LibraryState, LibraryTrack, OriginalityReport, StyleProfile, TrackDetail, TrackQuery } from './library/types';
import type { TuneStyle } from './music/keymatch';
import type { CoverRef } from './schema/project';
import type { ProjectTemplate } from './templates';
import type { WarpMode } from './schema/warp';
import type { ChainRole, FactorySample, InstrumentRole, Preset, PresetSummary, SampleKind } from './sounds/types';
import type { GenreId } from './sounds/genres';
import type { PackSample, PacksState } from './packs/types';
import type { ScriptCatalog, ScriptCheck, ScriptPlan, ScriptRunRequest, ScriptApplyOutcome } from './scripts/types';

export interface ActionResult<T = unknown> {
  ok: boolean;
  message?: string;
  data?: T;
}

export type Unsubscribe = () => void;

/** Sounds (presets + factory samples) as the renderer sees them. */
export interface SoundsState {
  /** Factory + user presets, summaries only (get() returns the full preset). */
  presets: PresetSummary[];
  factoryCount: number;
  userCount: number;
  /** Folder holding the user's presets (userData/presets). */
  userDir: string;
}

/**
 * "More like this" (window.krypt.sounds.similar, research/13 §12.1): the sound to find neighbours of. A sample is a
 * 'factory:…' / 'pack:<id>/…' path or an absolute audio file inside a Browser folder; a preset is an instrument
 * preset id.
 */
export type SimilarSource = { kind: 'sample'; path: string } | { kind: 'preset'; id: string };

export interface SimilarQuery {
  /** 'same' (default): the same kind of sound and close relatives (a kick finds kicks). 'any': every kind, by timbre. */
  scope?: 'same' | 'any';
  /** Samples, presets or both (default). */
  want?: 'samples' | 'presets' | 'all';
  /** Best N (default 40, max 100). */
  limit?: number;
}

/** One neighbour, best first. Samples preview / drag / load like Browser rows; presets like preset rows. */
export type SimilarItem = (
  | { type: 'sample'; path: string; kind: SampleKind; origin: 'factory' | 'pack'; rootNote?: number; bars?: number }
  | { type: 'preset'; id: string; role: InstrumentRole; plugin: string; origin: 'factory' | 'user' }
) & {
  name: string;
  /** 0..100 */
  percent: number;
  /** One short line, e.g. "darker, shorter tail". */
  why: string;
  /** The same kind as the source (scope 'any' mixes kinds). */
  sameKind: boolean;
};

export interface SimilarResult {
  source: {
    name: string;
    /** Sample kind or preset role (null = couldn't tell). */
    kind: string | null;
    /** The kind was guessed from the sound's nearest neighbours (a user file with no telling name). */
    inferred: boolean;
  };
  scope: 'same' | 'any';
  items: SimilarItem[];
  /** Installed pack samples of the searched kinds still to be measured: ask again (same query) to include them. */
  pending: number;
  /** Pack samples measured during this call. */
  measured: number;
  /** Plain notes (a pack sample that couldn't be measured …). */
  notes: string[];
}

/** Metadata for saving a user preset. */
/** Wave 7b: the samples sound packs add to the library (window.krypt.packs.samples). */
export interface PackSamplesInfo {
  /** Every catalog pack that adds samples, installed or not, with its counts by kind (for the pack cards and the Browser). */
  packs: Array<{ id: string; name: string; installed: boolean; count: number; byKind: Partial<Record<SampleKind, number>> }>;
  /** The samples of INSTALLED packs ('pack:<id>/…' paths): preview / drag them like factory samples. */
  samples: PackSample[];
}

export interface SavePresetMeta {
  name: string;
  tags?: string[];
  genres?: GenreId[];
  description?: string;
}

// ── Document ──────────────────────────────────────────────────────────

export interface DocPatchMessage {
  version: number;
  kind: 'exec' | 'undo' | 'redo' | 'revert';
  actor: Actor;
  label: string;
  patches: Patch[];
}

export interface DocResetMessage {
  version: number;
  project: Project;
}

export interface ExecOpts {
  /** Fold into an open group (from doc.beginGroup). */
  groupId?: string;
  /** Merge consecutive edits with the same key (e.g. `knob:<paramRef>`). */
  coalesceKey?: string;
  label?: string;
}

// ── Project files ─────────────────────────────────────────────────────

export interface ProjectStatus {
  path: string | null;
  name: string;
  dirty: boolean;
  lastSavedAt: number | null;
  /** True if this session was restored from a crash journal. */
  recovered: boolean;
}

// ── Project tabs (research/19-project-tabs.md) ────────────────────────

/** One open project in the title-bar tab strip. Only the active tab is in the DocHost / engine. */
export interface ProjectTab {
  id: string;
  /** Project name (the file name for saved projects, else "Untitled", "Untitled 2", …). */
  title: string;
  path: string | null;
  /** Unsaved changes relative to its file (or never saved). */
  dirty: boolean;
  /** Something long-running belongs to this tab ("Building the mashup…", "Recording"): switching away is refused while set. */
  busy?: string;
}

export interface TabsState {
  tabs: ProjectTab[];
  activeId: string;
  /** Recently closed tabs, newest first (reopen with tabs.reopenClosed). */
  closed: Array<{ id: string; title: string; path: string | null }>;
}

// ── Engine ────────────────────────────────────────────────────────────

export interface EngineStatus {
  state: 'starting' | 'running' | 'restarting' | 'stopped' | 'failed';
  message?: string;
  device: DeviceStatus | null;
  engineVersion: string | null;
  restarts: number;
}

export type ExportFormat = 'wav16' | 'wav24' | 'wav32f' | 'mp3';
export type { Mp3Kbps };
/** The engine's MP3 bitrates (shared/engine/protocol.ts MP3_KBPS), best first for pickers. */
export const MP3_BITRATES: readonly Mp3Kbps[] = [320, 256, 192, 128];

export interface RenderOptions {
  scope: RenderScope;
  format: ExportFormat;
  /** MP3 bitrate (default 320). */
  mp3Kbps?: Mp3Kbps;
  /** Embed the project's song info + cover in the file (default true; WAV and MP3). */
  tags?: boolean;
  /** Absolute path; omitted = ask with a save dialog. */
  path?: string;
  sampleRate?: number;
  tailSec?: number;
  stems?: boolean;
  /** Pattern scope: how many times the pattern plays (default 1). */
  loops?: number;
  /** Peak-normalize the render to -0.1 dBFS. */
  normalize?: boolean;
}

/** What the export dialog shows of the project's cover (bytes stay in main). */
export interface CoverPreview extends CoverRef {
  /** data:image/...;base64 for an <img>. */
  dataUrl: string;
  bytes: number;
}

/** The generated cover's looks (src/app/coverArt.ts draws them; set_cover {generate, style}). */
export const COVER_STYLES = ['waves', 'grid', 'orbit', 'bars'] as const;
export type CoverStyle = (typeof COVER_STYLES)[number];

/** Main asks the window to draw a generated cover (MCP set_cover {generate}). */
export interface CoverDrawRequest {
  id: string;
  style?: string;
  seed?: number;
}

export type CoverDrawResult = { ok: true; bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; style: string; seed: number } | { ok: false; message: string };

/** Export facts the dialog shows. */
export interface ExportCapabilities {
  /** Where agent exports (export_audio) are saved. */
  agentFolder: string;
}

// ── Browser (sample/file browser panel) ───────────────────────────────

export interface BrowserRoot {
  id: string;
  name: string;
  path: string;
  builtin: boolean; // factory content / user folders
}

export interface BrowserEntry {
  name: string;
  path: string;
  kind: 'dir' | 'audio' | 'project' | 'midi' | 'other';
  size?: number;
}

// ── Settings ──────────────────────────────────────────────────────────

export interface Settings {
  audio: { deviceId: string | null; bufferFrames: number; sampleRate: number };
  ui: {
    scale: number;
    showHints: boolean;
    /** Show the Home hub at launch (skipped when launched with a file). Default true; main fills it. */
    openToHome?: boolean;
    /** Home hub "Lite mode": a still background, no animation. Default false; main fills it. */
    homeLite?: boolean;
    /** Start quietly in the tray when Windows starts (the installer turns it on). Default true; main fills it. */
    startWithWindows?: boolean;
    /** The one-time "still running in the tray" note was shown. Default false; main fills it. */
    trayNoticeShown?: boolean;
  };
  browserRoots: Array<{ id: string; name: string; path: string }>;
  recent: string[];
  autosaveSec: number;
  mcp: {
    enabled: boolean;
    httpEnabled: boolean;
    httpPort: number;
    requireConsentForDestructive: boolean;
    /**
     * Which audio files agents may open (main always fills it; absent = 'anywhere'):
     * anywhere = any local file / folder, no prompt (pipe clients and the built-in agent; the HTTP endpoint is
     * capped at 'ask'); ask = Browser folders + project files, asked about anything else; browser = Browser
     * folders + project files only. UNC, device and non-audio paths are refused in every mode.
     */
    fileAccess?: FileAccessMode;
  };
  /**
   * The built-in chat (shared/agent/providers.ts). model = the Anthropic model (kept from before providers);
   * models = the choice per provider; hasApiKey = the selected provider has a key; keys = which providers have one.
   * hasApiKey and keys are owned by main (the agent backend), never written by the renderer.
   */
  agent: { model: string; hasApiKey: boolean; provider?: import('./agent/providers').AgentProvider; models?: Partial<Record<import('./agent/providers').AgentProvider, string>>; keys?: Partial<Record<import('./agent/providers').AgentProvider, boolean>> };
  /** Unused: Discord presence is always on (kryptguidelines §8). Kept so older settings files still load. */
  discordRpc: boolean;
  /** Shortcut overrides: command id → key combos ([] = unbound). Absent command = FL default. */
  keymap?: Record<string, string[]>;
  /** MIDI inputs + controller links. Always filled by main; read via shared/live/recording.ts helpers. */
  midi?: MidiSettings;
  /** Record mode, quantize, count-in. */
  recording?: RecordingSettings;
  /** Audio input used for recording / monitoring. */
  audioInput?: AudioInputSettings;
  /** Reference library: scan speed and the AI's style focus. Always filled by main. */
  library?: LibrarySettings;
  /** Exports: where agent exports go (`music` = <Music>\Krypt Studio, `project` = next to the saved project). */
  export?: ExportSettings;
  /** Clip-launcher grid controller (Wave 12.2). Read via shared/live/launchGrid.ts launchGridSettings(); main fills it. */
  launchGrid?: LaunchGridSettings;
  /** MIDI outputs, clock out and sync in (Wave 12.2b). Read via shared/live/midiOut.ts midiOutSettings(); main fills it. */
  midiOut?: MidiOutSettings;
  /** Gamepad and keyboard-pad maps (virtual MIDI inputs). Read via shared/live/controllers.ts controllerSettings(); main fills it. */
  controllers?: ControllerSettings;
}

export type FileAccessMode = 'anywhere' | 'ask' | 'browser';
export const FILE_ACCESS_MODES: readonly FileAccessMode[] = ['anywhere', 'ask', 'browser'];

export interface ExportSettings {
  folder: 'music' | 'project';
}

export interface LibrarySettings {
  /** Skip the Beat This! model in the library's light pass: ~3× faster, rougher beats and downbeats. */
  fastScan: boolean;
  /** The collection the AI composes from (library.setFocus); null = none. */
  focus: LibraryFocus | null;
}

// ── Live input / recording ────────────────────────────────────────────

/** A controller link (FL "Remote control"): an incoming CC drives a ParamRef. */
export interface MidiMapping {
  id: string;
  /** MIDI input id; null = any device. */
  device: string | null;
  /** 0-based MIDI channel. */
  channel: number;
  cc: number;
  paramRef: string;
  /** Display name of the parameter when it was linked. */
  label?: string;
  /** Normalized range the CC's 0..127 maps onto (default 0..1; min > max inverts). */
  min?: number;
  max?: number;
}

export interface MidiSettings {
  /** Open newly plugged devices automatically (FL "auto accept"). */
  autoEnable: boolean;
  /** Per-device enable, by MidiInputInfo.id. Missing = autoEnable. */
  inputs: Record<string, boolean>;
  mappings: MidiMapping[];
}

export type RecordMode = 'midi' | 'audio' | 'both';

export interface RecordingSettings {
  mode: RecordMode;
  /** Quantize recorded note starts to this grid in ticks (0 = off; 240 = 1/16). */
  quantize: number;
  /** Metronome count-in before recording starts (0 = off). */
  countInBars: 0 | 1 | 2;
}

export interface AudioInputSettings {
  /** null = system default input. */
  deviceId: string | null;
  /** 0-based device channels: one = mono take, two = stereo. */
  channels: number[];
  /** Hear the input through the master output. */
  monitor: boolean;
}

/** Main's record state (live count-in / recording state comes from telemetry). */
export interface RecordState {
  armed: boolean;
  input: InputStatus | null;
  /** Result of the last finished take (renderer toasts it once per id). */
  lastTake?: { id: number; ok: boolean; message: string };
}

/** MIDI-learn ("Link to controller…") in progress. paramRef null = idle. */
export interface MidiLearnState {
  paramRef: string | null;
  label?: string;
}

// ── MCP / agents ──────────────────────────────────────────────────────

export interface McpClientInfo {
  clientId: string;
  name: string;
  connectedAt: number;
  calls: number;
}

export interface McpStatus {
  enabled: boolean;
  pipeName: string | null;
  http: { enabled: boolean; url: string | null };
  clients: McpClientInfo[];
  shimPath: string | null;
}

export interface AgentActivity {
  clientId: string;
  clientName: string;
  tool: string;
  summary: string;
  ok: boolean;
  time: number;
  /** Entities touched (for "agent is editing" highlights). */
  touched?: Array<{ kind: string; id: string }>;
}

export interface AgentChatEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  text?: string;
  tool?: string;
  input?: unknown;
  ok?: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface ClientConfigSnippet {
  client: string;
  description: string;
  snippet: string;
  /** Whether main can install it automatically (writes the client config file). */
  installable: boolean;
}

// ── Third-party plugins (Plugin Manager; VST3 + CLAP, no VST2) ────────

export interface PluginFolder {
  path: string;
  /** A standard VST3/CLAP folder (or CLAP_PATH) vs one the user added. */
  builtin: boolean;
  exists: boolean;
}

export interface PluginFileEntry {
  path: string;
  format: 'vst3' | 'clap';
  /** partial = only moduleinfo.json was read (the module crashed/hung while loading). */
  status: 'ok' | 'failed' | 'timeout' | 'blocked' | 'partial';
  message?: string;
  /** Plugin ids found in this file. */
  plugins: string[];
  scannedAt: number;
}

export interface PluginBlockEntry {
  path: string;
  reason: string;
  at: number;
}

export interface PluginInstanceInfo {
  /** Engine entity: channel id, or "insertId/slotId". */
  key: string;
  pluginId: string;
  name: string;
  state: 'ok' | 'loading' | 'paused' | 'failed' | 'crashed';
  hasEditor: boolean;
}

export interface PluginManagerState {
  /** Installed (scanned, not blocked) third-party plugins. */
  plugins: PluginDescriptor[];
  files: PluginFileEntry[];
  blocked: PluginBlockEntry[];
  folders: PluginFolder[];
  scanning: boolean;
  progress: { done: number; total: number; current: string | null } | null;
  lastScanAt: number | null;
  /** .dll files in the usual VST2 folders: VST2 can't be hosted (no licence). */
  vst2Found: number;
  /** krypt-studio-pluginhost.exe was found (scanning + hosting possible). */
  hostAvailable: boolean;
  /** Why plugins can't be hosted on this OS (macOS / Linux for now); absent where they can. */
  hostUnsupported?: string;
  hostPid: number | null;
  instances: PluginInstanceInfo[];
}

export type PluginTarget = { channelId: string } | { insertId: string; slotId: string };

// ── Analyzer: on-device audio ML (krypt-studio-analyzer.exe, Model Manager) ──

export interface ModelState {
  /** Static catalog entry (shared/analyzer/models.ts). */
  def: ModelDef;
  status: 'installed' | 'available' | 'downloading' | 'verifying' | 'failed' | 'unavailable';
  /** downloading: bytes so far / total. */
  progress?: { received: number; total: number };
  /** Last failure, or why it is 'unavailable' (e.g. no download published yet). */
  message?: string;
  /** Absolute model directory when installed. */
  dir?: string;
}

export interface AnalyzerJobInfo {
  /** Main-side job id (cancelJob). */
  id: string;
  kind: 'analyze' | 'separate' | 'transcribe' | 'fingerprint' | 'tts' | 'sing' | 'syllables' | 'extract';
  /** Human label, e.g. 'Separating "Loop 3" (HT-Demucs)'. */
  label: string;
  stage: string;
  /** 0..1, or -1 when indeterminate. */
  fraction: number;
  startedAt: number;
}

export interface AnalyzerState {
  /** krypt-studio-analyzer.exe was found. */
  available: boolean;
  running: boolean;
  pid: number | null;
  version: string | null;
  devices: AnalyzerDevice[];
  models: ModelState[];
  jobs: AnalyzerJobInfo[];
  modelsDir: string;
}

/** What to analyze / transcribe: a playlist audio clip, an audio-clip or sampler channel's sample, or a file. */
export type AudioTarget = { clipId: string } | { channelId: string } | { path: string };

// ── Warp (Wave 12.2, research/16 §2.2): auto-warp an audio clip channel to its beat grid ──

/** What an audio clip plays, for its warp mode: drums → beats, mono (one voice) → tones, mix → complex. */
export type WarpHint = 'drums' | 'mono' | 'mix';

export interface AutoWarpOptions {
  /** One marker per bar (default) or per beat. */
  every?: 'bar' | 'beat';
  /** Material hint; guessed from stems / names / the analysis when absent. */
  hint?: WarpHint;
  /** Force a warp mode (else from the hint). */
  mode?: WarpMode;
}

export interface AutoWarpOutcome {
  channelId: string;
  markers: number;
  mode: WarpMode;
  hint: WarpHint;
  every: 'bar' | 'beat';
  /** The source tempo the markers imply. */
  srcBpm: number;
  /** Quarter notes per tracked beat (2 = tracked in half time). */
  beatUnit: number;
  /** Where the beats came from, e.g. 'the Beat This! beat model'. */
  source: string;
  warning?: string;
}

export interface StemsOutcome {
  /** New playlist tracks, one per stem, top to bottom. */
  trackIds: string[];
  /** New audio-clip channels, one per stem. */
  channelIds: string[];
  stems: StemName[];
  model: string;
  device: AnalyzerDevice;
  seconds: number;
}

export interface ToPatternOutcome {
  patternId: string;
  /** Channels that received notes (drums: one per role). */
  channelIds: string[];
  notes: number;
}

// ── Vocals & mashups (electron/vocals): import, match key / tempo, Krypt Tune ──

export interface ImportOutcome {
  clipId: string;
  channelId: string;
  sampleId: string;
  trackId: string;
  /** 1-based playlist track number. */
  track: number;
  trackName: string;
  name: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** Where the audio lives: userData/imports/<sha256>.<ext> for uploads, the file itself for path imports. */
  path: string;
  /** Uploads: identical bytes were already imported (the stored copy was reused). */
  deduped: boolean;
  bytes: number;
}

export interface MatchOutcome {
  channelId: string;
  /** The pitch now set (semitones), or null when the key was left alone. */
  semitones: number | null;
  fromKey: string | null;
  toKey: string | null;
  resultKey: string | null;
  /** The source tempo the clip syncs from, and how the detection was read. */
  sourceBpm: number | null;
  reading: 'as detected' | 'double time' | 'half time' | 'alternative' | null;
  /** The tempo it now follows, and its playback speed ratio. */
  followsBpm: number | null;
  ratio: number | null;
  projectBpm: number;
  projectTempoChanged: boolean;
  /** false = it already matched (nothing was edited). */
  changed: boolean;
}

export type { TuneStyle };

/** Wave 8a: options for window.krypt.audioProject.open / the audio_to_project tool. */
export interface AudioProjectOptions {
  /** Keep the separated stems as muted audio tracks under the patterns, for A/B and reuse (default true). */
  keepStems?: boolean;
  /** Tempo reading: 1 (detected, default), 0.5 or 2. */
  factor?: 1 | 0.5 | 2;
  /** Which parts become patterns (default all that were found). Vocals always stay audio. */
  parts?: Array<'drums' | 'bass' | 'chords' | 'lead'>;
}

export type AudioProjectStage = 'analyzing' | 'separating' | 'transcribing' | 'matching' | 'building';

export interface AudioProjectProgress {
  stage: AudioProjectStage;
  /** 0..1 within the whole job, or -1 when unknown. */
  fraction: number;
  /** One plain line ("Splitting the song into stems (HT-Demucs on the GPU)…"). */
  message: string;
}

export interface AudioProjectOutcome {
  name: string;
  bpm: number;
  key: string | null;
  bars: number;
  sections: number;
  channels: number;
  patterns: number;
  /** Which matched sound each part got ("Kick → Punchy Kick 2 (similarity 0.86)"). */
  sounds: string[];
  /** Honest limits of this conversion ("Chords read from a dense mix: expect missing notes"). */
  notes: string[];
  stemsKept: boolean;
}

export interface TuneOutcome {
  insertId: string;
  slotId: string;
  /** A new Krypt Tune was added (false = the one already there was updated). */
  created: boolean;
  /** "G minor", "Chromatic" … */
  key: string;
  root: number;
  scale: number;
  style: TuneStyle;
  /** Where the key came from. */
  keySource: 'given' | 'vocal' | 'instrumental' | 'patterns';
  confidence: number | null;
  changed: boolean;
}

// ── The full API ──────────────────────────────────────────────────────

export interface KryptApi {
  app: {
    version(): Promise<string>;
    openExternal(url: string): Promise<ActionResult>;
    showItemInFolder(path: string): Promise<ActionResult>;
    /** Absolute path of a File dropped from Explorer (Electron webUtils); '' if none (e.g. browser mock). */
    pathForFile(file: File): string;
    /** 'close' hides the main window to the tray (Krypt Studio keeps running); 'quit' really quits (File ▸ Exit). */
    window(action: 'minimize' | 'maximize' | 'close' | 'quit'): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(cb: (maximized: boolean) => void): Unsubscribe;
    /** Paths dropped/opened via file association or second instance. */
    onOpenFile(cb: (path: string) => void): Unsubscribe;
  };
  doc: {
    snapshot(): Promise<{ version: number; project: Project }>;
    exec<T = unknown>(cmd: string, args: unknown, opts?: ExecOpts): Promise<ExecResult<T>>;
    execBatch(steps: Array<{ cmd: string; args: unknown }>, opts?: ExecOpts): Promise<ExecResult<unknown[]>>;
    beginGroup(label: string): Promise<string>;
    endGroup(groupId: string): Promise<void>;
    undo(): Promise<ExecResult>;
    redo(): Promise<ExecResult>;
    history(): Promise<HistorySummary[]>;
    /** Selectively undo/redo one history entry (AI History panel). */
    toggleEntry(entryId: string): Promise<ExecResult>;
    /** Undo everything an agent did ("revert all AI edits"). */
    revertActor(actorKey: string): Promise<ExecResult>;
    onPatches(cb: (m: DocPatchMessage) => void): Unsubscribe;
    onReset(cb: (m: DocResetMessage) => void): Unsubscribe;
    onHistoryChanged(cb: () => void): Unsubscribe;
  };
  /**
   * Project tabs: several beats open at once, like browser tabs. The open tab set (incl. unsaved projects and
   * their state) is saved on quit and restored on the next launch.
   */
  tabs: {
    state(): Promise<TabsState>;
    onState(cb: (s: TabsState) => void): Unsubscribe;
    /** A new tab with a fresh project (or from a template id), made active. */
    newTab(opts?: { template?: string }): Promise<ActionResult<{ id: string }>>;
    /** Open a project file in a new tab (a dialog without a path); an already-open file just activates its tab. */
    open(path?: string): Promise<ActionResult<{ id: string }>>;
    switchTo(id: string): Promise<ActionResult>;
    /**
     * Close a tab. A tab with unsaved changes needs a decision: without `decision` the result is
     * { ok:false, data:{ needsDecision:true } } and the UI asks Save / Don't save / Cancel.
     */
    close(id: string, decision?: 'save' | 'discard'): Promise<ActionResult<{ needsDecision?: boolean }>>;
    move(id: string, toIndex: number): Promise<ActionResult>;
    /** Reopen the most recently closed tab (its unsaved state is kept for a while after closing). */
    reopenClosed(): Promise<ActionResult<{ id: string }>>;
  };
  project: {
    status(): Promise<ProjectStatus>;
    newProject(): Promise<ActionResult>;
    /** Wave 12.2b user templates (userData/templates): list, save the open project as one, start from one, rename, delete. */
    templates(): Promise<ActionResult<ProjectTemplate[]>>;
    saveAsTemplate(name: string): Promise<ActionResult<ProjectTemplate>>;
    newFromTemplate(id: string): Promise<ActionResult<{ template: ProjectTemplate }>>;
    renameTemplate(id: string, name: string): Promise<ActionResult<ProjectTemplate>>;
    deleteTemplate(id: string): Promise<ActionResult>;
    open(path?: string): Promise<ActionResult>;
    save(): Promise<ActionResult<{ path: string }>>;
    saveAs(): Promise<ActionResult<{ path: string }>>;
    importMidi(path?: string): Promise<ActionResult>;
    exportMidi(patternId?: string): Promise<ActionResult<{ path: string }>>;
    onStatus(cb: (s: ProjectStatus) => void): Unsubscribe;
    /** The cover image for previews (null data = no cover). */
    cover(): Promise<ActionResult<CoverPreview | null>>;
    /** PNG / JPEG from disk (a file dialog when no path) → cropped square ≤ 1400 px → the cover. One undo step. */
    chooseCover(path?: string): Promise<ActionResult<CoverRef>>;
    /** Image bytes (the cover generator) → the cover. One undo step. */
    setCoverImage(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg', label?: string): Promise<ActionResult<CoverRef>>;
    /** Main asks this window to draw a cover (an agent's set_cover {generate}); answer with respondCover. */
    onCoverRequest(cb: (req: CoverDrawRequest) => void): Unsubscribe;
    respondCover(id: string, result: CoverDrawResult): void;
    /** Where agent exports go. */
    exportCapabilities(): Promise<ExportCapabilities>;
  };
  engine: {
    status(): Promise<EngineStatus>;
    onStatus(cb: (s: EngineStatus) => void): Unsubscribe;
    /** ws://127.0.0.1:<port>/?token=... for TelemetryFrame, or null if not running. */
    telemetryUrl(): Promise<string | null>;
    transport(action: 'play' | 'stop' | 'pause' | 'toggle'): Promise<ActionResult>;
    locate(tick: number): Promise<ActionResult>;
    /** Fire-and-forget note preview (piano roll clicks, typing keyboard). */
    audition(channelId: string, key: number, vel: number, on: boolean): void;
    auditionOff(): void;
    previewFile(path: string): Promise<ActionResult>;
    stopPreview(): Promise<ActionResult>;
    listDevices(): Promise<ActionResult<DeviceInfo[]>>;
    openDevice(opts: { deviceId?: string | null; bufferFrames?: number; sampleRate?: number }): Promise<ActionResult<DeviceStatus>>;
    render(opts: RenderOptions): Promise<ActionResult<RenderResult>>;
    onRenderProgress(cb: (progress: number) => void): Unsubscribe;
    sampleInfo(path: string): Promise<ActionResult<SampleInfo>>;
    peaks(path: string, buckets: number): Promise<ActionResult<Peaks>>;
    analyzeFile(path: string): Promise<ActionResult<Analysis>>;
    restart(): Promise<ActionResult>;
  };
  browser: {
    roots(): Promise<BrowserRoot[]>;
    list(dir: string): Promise<ActionResult<BrowserEntry[]>>;
    addRoot(): Promise<ActionResult<BrowserRoot>>;
    removeRoot(id: string): Promise<ActionResult>;
  };
  dialog: {
    openFile(opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multi?: boolean }): Promise<string[] | null>;
    saveFile(opts: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
    onChanged(cb: (s: Settings) => void): Unsubscribe;
  };
  mcp: {
    status(): Promise<McpStatus>;
    onStatus(cb: (s: McpStatus) => void): Unsubscribe;
    onActivity(cb: (a: AgentActivity) => void): Unsubscribe;
    clientConfigs(): Promise<ClientConfigSnippet[]>;
    installClientConfig(client: string): Promise<ActionResult>;
    /** Disconnect every agent and refuse new tool calls until re-enabled. */
    setEnabled(enabled: boolean): Promise<ActionResult>;
  };
  agent: {
    /** Save (or remove, null) the built-in chat's key for a provider (default: the selected one). */
    setApiKey(key: string | null, provider?: import('./agent/providers').AgentProvider): Promise<ActionResult>;
    send(message: string): Promise<ActionResult>;
    cancel(): Promise<void>;
    reset(): Promise<void>;
    onEvent(cb: (e: AgentChatEvent) => void): Unsubscribe;
  };
  log: {
    onAppend(cb: (line: { level: 'info' | 'warn' | 'error'; message: string; time: number }) => void): Unsubscribe;
  };
  /** MIDI inputs (owned by the engine) and controller links. */
  midi: {
    /** Rescan and list MIDI inputs. */
    inputs(): Promise<ActionResult<MidiInputInfo[]>>;
    /** Enable / disable a device (persisted in settings). */
    setInputEnabled(id: string, enabled: boolean): Promise<ActionResult<MidiInputInfo[]>>;
    /** The channel MIDI input plays (follows the UI selection). Fire-and-forget. */
    setTarget(channelId: string | null): void;
    /** Link the next CC that arrives to a ParamRef. Resolves with the mapping (or ok:false on cancel / timeout). */
    learn(paramRef: string, label?: string): Promise<ActionResult<MidiMapping>>;
    cancelLearn(): void;
    /** Gamepad / keyboard-pad MIDI (shared/live/controllers.ts) into the engine as the virtual input `device` ("Krypt: …"). Fire-and-forget. */
    virtualIn(device: string, bytes: number[]): void;
    removeMapping(id: string): Promise<ActionResult>;
    onInputs(cb: (inputs: MidiInputInfo[]) => void): Unsubscribe;
    onLearn(cb: (s: MidiLearnState) => void): Unsubscribe;
    /** Rescan and list MIDI outputs (Wave 12.2b). */
    outputs(): Promise<ActionResult<MidiOutputInfo[]>>;
    /** Open / close an output (persisted). Clock and grid-LED ports are opened on their own. */
    setOutputEnabled(id: string, enabled: boolean): Promise<ActionResult<MidiOutputInfo[]>>;
    /** Clock out and sync-in settings. */
    clockSettings(): Promise<MidiOutSettings>;
    setClockSettings(patch: Partial<Omit<MidiOutSettings, 'outputs'>>): Promise<ActionResult<MidiOutSettings>>;
    onOutputs(cb: (outputs: MidiOutputInfo[]) => void): Unsubscribe;
  };
  /** Transport recording (arm + play). Mode / quantize / count-in / input live in settings. */
  record: {
    status(): Promise<RecordState>;
    setArmed(armed: boolean): Promise<ActionResult<RecordState>>;
    /** Audio input devices (WASAPI). */
    listInputDevices(): Promise<ActionResult<DeviceInfo[]>>;
    /** Mic test (Home ▸ Recording Studio): keep the input open for its level meter only (telemetry inputPeak); not monitored, not recorded. */
    setMeter(on: boolean): Promise<ActionResult<InputStatus | null>>;
    onStatus(cb: (s: RecordState) => void): Unsubscribe;
  };
  /** Third-party VST3 / CLAP plugins: scanning, folders, blocklist, native editors. */
  plugins: {
    state(): Promise<PluginManagerState>;
    /** Incremental rescan (changed/new files); full = rescan everything. */
    rescan(opts?: { full?: boolean }): Promise<ActionResult<PluginManagerState>>;
    /** Pick a folder to scan (folder dialog). */
    addFolder(): Promise<ActionResult<PluginManagerState>>;
    removeFolder(path: string): Promise<ActionResult<PluginManagerState>>;
    /** Remove one file from the blocklist (rescans it), or all when path is omitted. */
    unblock(path?: string): Promise<ActionResult<PluginManagerState>>;
    /** Open (or close) the plugin's native editor window, owned by the main window. */
    openEditor(target: PluginTarget, open?: boolean): Promise<ActionResult>;
    /** Restart the plugin host and reload every third-party plugin (after a crash). */
    reload(): Promise<ActionResult>;
    onState(cb: (s: PluginManagerState) => void): Unsubscribe;
  };
  /** On-device audio ML: tempo/key/sections, stem separation, audio → pattern, Model Manager. */
  analyzer: {
    state(): Promise<AnalyzerState>;
    /** Download + verify a catalog model. Resolves when installed (or failed / cancelled). */
    installModel(id: string): Promise<ActionResult<AnalyzerState>>;
    cancelInstall(id: string): Promise<ActionResult>;
    /** Install from a folder the user picks (offline installs / no published download). Verifies every file's SHA-256. */
    importModel(id: string): Promise<ActionResult<AnalyzerState>>;
    removeModel(id: string): Promise<ActionResult<AnalyzerState>>;
    /** Tempo, beats, key, swing, sections, loudness. Cached per sample hash. */
    analyze(target: AudioTarget): Promise<ActionResult<AudioAnalysis>>;
    /** Separate a playlist audio clip into stems placed on new tracks under it (one undo step). */
    separateStems(clipId: string, opts?: { model?: string }): Promise<ActionResult<StemsOutcome>>;
    /** Transcribe audio into a new pattern (one undo step). */
    toPattern(target: AudioTarget, opts: { mode: TranscribeMode; name?: string }): Promise<ActionResult<ToPatternOutcome>>;
    cancelJob(jobId: string): Promise<ActionResult>;
    onState(cb: (s: AnalyzerState) => void): Unsubscribe;
  };
  /**
   * Warp (Wave 12.2): editing markers / mode is doc commands (`audio.*Warp*` via doc.exec). autoWarp beat-tracks the
   * channel's sample with the analyzer (progress shows as an analyzer job) and writes the markers as ONE undo step.
   */
  warp: {
    autoWarp(channelId: string, opts?: AutoWarpOptions): Promise<ActionResult<AutoWarpOutcome>>;
  };
  /**
   * Vocals & mashups: the same service the import_audio / match_clip / tune_vocal MCP tools use.
   * Each call is one undo step (actor = user).
   */
  vocals: {
    /** Krypt Tune on the clip's (or channel's) mixer insert: added first in the chain, or the existing one updated. Key detected unless given. */
    tune(target: AudioTarget, opts: { style: TuneStyle; key?: string; scale?: string }): Promise<ActionResult<TuneOutcome>>;
    /** Pitch an audio clip onto the key of the project (or of another audio clip) with the smallest move, and make it follow the tempo. */
    match(clipId: string, opts?: { to?: 'project' | { clipId: string }; key?: boolean; tempo?: boolean }): Promise<ActionResult<MatchOutcome>>;
  };
  /**
   * Wave 8a (research/15 §3): any audio file → a NEW, editable Krypt Studio project (stems separated, drums / bass /
   * chords / lead transcribed into patterns on matched sounds, vocals as audio, sections arranged with markers).
   * The same service as the audio_to_project MCP tool. Asks to save the current project first (like New).
   */
  /**
   * Krypt Voice (shared/voice/types.ts, research/21): text → speech (local Kokoro or Fish Audio cloud with the
   * user's key) and "Sing my notes" (lyrics sung on a melody). Results land as audio clips.
   */
  voice: {
    state(): Promise<VoiceState>;
    onState(cb: (s: VoiceState) => void): Unsubscribe;
    speak(req: SpeakRequest): Promise<ActionResult<SpeakOutcome>>;
    sing(req: SingRequest): Promise<ActionResult<SingOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: VoiceProgress) => void): Unsubscribe;
    /** Fish Audio key (stored with OS encryption, like the AI key); null removes it. Verified with a tiny request. */
    setFishKey(key: string | null): Promise<ActionResult>;
    /** Clone the user's own voice on Fish from an in-app recording (the WAV the recorder made) that starts with CONSENT_LINE. */
    cloneMyVoice(opts: { recordingPath: string; name: string; consent: true }): Promise<ActionResult<VoiceInfo>>;
    removeMyVoice(id: string): Promise<ActionResult>;
  };
  /**
   * Auto Mix / Auto Master (shared/automix/types.ts, research/20): a preset or a prompt → measured, real knob
   * settings, converged by re-rendering; one history entry (A/B = doc.toggleEntry(outcome.entryId)).
   */
  automix: {
    presets(): Promise<AutoMixPreset[]>;
    /** What a prompt would do, without changing anything (AI when connected, else keywords). */
    understand(prompt: string): Promise<ActionResult<AutoMixIntent>>;
    run(req: AutoMixRequest): Promise<ActionResult<AutoMixOutcome>>;
    /** Master an audio file in a new project tab (a dialog for path ''). */
    masterFile(req: MasterFileRequest): Promise<ActionResult<AutoMixOutcome>>;
    /** A reference song's loudness / tone / width (one light pass, cached per file). Changes nothing. */
    analyzeReference(path: string): Promise<ActionResult<ReferenceSound>>;
    /** Play the reference from its start, turned to `matchLufs` (loudness-matched A/B); engine.stopPreview stops it. */
    playReference(path: string, matchLufs: number | null): Promise<ActionResult<{ gainDb: number }>>;
    /** Master 2-20 songs as one album in a new project tab (research/23 §2). */
    masterAlbum(req: AlbumRequest): Promise<ActionResult<AlbumOutcome>>;
    /** Export all: one file per album song into a folder (a dialog for folder ''); the folder opens afterwards. */
    exportAlbum(req: AlbumExportRequest): Promise<ActionResult<AlbumExportOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: AutoMixProgress) => void): Unsubscribe;
  };
  /** Auto Mashup (shared/mashup/types.ts, research/18): analyse two songs, then build the mashup as one undo step. */
  mashup: {
    /** Read both songs and propose a plan; edits nothing. A `{ path: '' }` source opens a file dialog. */
    check(req: MashupRequest): Promise<ActionResult<MashupCheck>>;
    build(req: MashupRequest): Promise<ActionResult<MashupOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: MashupProgress) => void): Unsubscribe;
  };
  audioProject: {
    /** No path: a file dialog. */
    open(path?: string, opts?: AudioProjectOptions): Promise<ActionResult<AudioProjectOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: AudioProjectProgress) => void): Unsubscribe;
  };
  /**
   * Reference library: the user's own songs analysed into a local database, aggregated into
   * style profiles the AI composes from ("Focus"), plus an originality check. Records only:
   * removing never deletes the user's files.
   */
  library: {
    state(): Promise<LibraryState>;
    onState(cb: (s: LibraryState) => void): Unsubscribe;
    createCollection(name: string, tags?: string[]): Promise<ActionResult<Collection>>;
    updateCollection(id: string, patch: { name?: string; tags?: string[] }): Promise<ActionResult<Collection>>;
    /** Removes the collection's records (never the files). */
    removeCollection(id: string): Promise<ActionResult>;
    /** Add a folder (recursively, audio files only) to a collection and queue it; no path = folder dialog. */
    addFolder(collectionId: string, path?: string): Promise<ActionResult<{ added: number; skipped: number }>>;
    /** Add files (e.g. dropped from Explorer); no paths = file dialog. */
    addFiles(collectionId: string, paths?: string[]): Promise<ActionResult<{ added: number; skipped: number }>>;
    removeTracks(ids: string[]): Promise<ActionResult>;
    /** Rescan the collection's folders: new files queued, changed ones re-analysed, deleted ones marked missing. */
    rescan(collectionId: string): Promise<ActionResult<{ added: number; changed: number; missing: number }>>;
    /** Request / cancel deep analysis (stems + transcriptions) for a collection. Needs an installed stem model. */
    setDeep(collectionId: string, deep: boolean): Promise<ActionResult<{ queued: number }>>;
    /** How long deep analysis of the collection's remaining tracks would take on this machine. */
    estimateDeep(collectionId: string): Promise<ActionResult<{ tracks: number; seconds: number; device: AnalyzerDevice }>>;
    /** Pause / resume the analysis queue (persists across restarts). */
    setPaused(paused: boolean): Promise<ActionResult>;
    /** Re-queue failed tracks. */
    retryFailed(collectionId?: string): Promise<ActionResult<{ queued: number }>>;
    query(q: TrackQuery): Promise<ActionResult<{ tracks: LibraryTrack[]; total: number }>>;
    track(id: string): Promise<ActionResult<TrackDetail>>;
    profile(collectionId: string): Promise<ActionResult<StyleProfile>>;
    /** Tracks that sound most like this one (feature-vector similarity), optionally within a collection. */
    similar(trackId: string, opts?: { collectionId?: string; limit?: number }): Promise<ActionResult<Array<{ track: LibraryTrack; score: number }>>>;
    /** Compare the project's melodic lines (or one pattern's) against the deep-analysed references. */
    checkOriginality(opts?: { patternId?: string }): Promise<ActionResult<OriginalityReport>>;
    /** The style the AI composes from; null clears it. */
    setFocus(focus: { collectionId: string; brief?: string } | null): Promise<ActionResult<LibraryFocus | null>>;
    /** Put a library track on the playlist as an audio clip (new track at the playhead or bar 1). */
    addToProject(trackId: string): Promise<ActionResult<{ clipId: string; channelId: string }>>;
  };
  /**
   * Sounds: factory + user presets (instruments and effect chains) and the factory sample index. Loading a preset is
   * a doc command: dispatch 'presets.applyToChannel' / 'presets.addChannel' / 'presets.applyChain' with the full
   * preset from get(). Factory presets are also importable directly from shared/sounds/factory.
   */
  sounds: {
    state(): Promise<SoundsState>;
    onState(cb: (s: SoundsState) => void): Unsubscribe;
    get(id: string): Promise<ActionResult<Preset>>;
    /** Save a channel's current sound (instrument, params, sample; its insert chain when withFx) as a user preset. */
    saveChannel(channelId: string, meta: SavePresetMeta & { role?: InstrumentRole; withFx?: boolean }): Promise<ActionResult<PresetSummary>>;
    /** Save a mixer insert's effect chain as a user chain preset. */
    saveChain(insertId: string, meta: SavePresetMeta & { role: ChainRole }): Promise<ActionResult<PresetSummary>>;
    renameUser(id: string, name: string): Promise<ActionResult<PresetSummary>>;
    deleteUser(id: string): Promise<ActionResult>;
    /** Open the user preset folder in Explorer. */
    revealUserDir(): Promise<ActionResult>;
    /** The factory sample index (resources/factory/index.json); [] when the factory kit isn't installed. */
    factorySamples(): Promise<FactorySample[]>;
    /**
     * Folders on this PC that look like sample libraries (Documents\Samples, Music\Samples, sample-pack folders in
     * Downloads …) with their audio file counts, so the user can add them to the Browser in one click (agents then
     * find those sounds with find_samples). Read-only; capped scan.
     */
    suggestSampleFolders(): Promise<Array<{ path: string; audioFiles: number; inBrowser: boolean }>>;
    /**
     * "More like this": the library sounds closest to one sound by timbre (factory index + installed pack samples,
     * measured lazily: up to a few dozen new pack samples per call, `pending` says how many are left; call again).
     * ok:false with a plain sentence when the source can't be measured or the fingerprint index is missing.
     */
    similar(source: SimilarSource, query?: SimilarQuery): Promise<ActionResult<SimilarResult>>;
  };
  /**
   * Sound packs: optional multisampled instruments (CC0 / public domain) the USER downloads (agents never do).
   * Every file is SHA-256-verified; installs land in userData/packs/<id>/.
   */
  packs: {
    state(): Promise<PacksState>;
    onState(cb: (s: PacksState) => void): Unsubscribe;
    /** Download + verify + install. Resolves when installed, failed or cancelled. */
    install(id: string): Promise<ActionResult<PacksState>>;
    cancel(id: string): Promise<ActionResult>;
    remove(id: string): Promise<ActionResult<PacksState>>;
    /** Open the pack's folder in Explorer. */
    reveal(id: string): Promise<ActionResult>;
    /** Wave 7b: what each pack adds to the sound library (counts by kind) and the installed packs' samples. */
    samples(): Promise<PackSamplesInfo>;
  };
  /**
   * Clip launcher runtime (Wave 12.2, research/16 §2.1). Editing the grid is doc commands (`session.*` via
   * doc.exec); these drive playback. Live state arrives in TelemetryFrame.launcher.
   */
  session: {
    /** Launch a clip (quantized). `release` = key / mouse up for gate and repeat clips. */
    launch(clipId: string, release?: boolean): Promise<ActionResult>;
    /** Launch a scene row; also sets the project tempo when the scene has one (an undoable doc edit). */
    launchScene(sceneId: string): Promise<ActionResult>;
    /** Stop a track's launch clip (quantized), or all tracks (null). */
    stop(trackId: string | null): Promise<ActionResult>;
    backToArrangement(): Promise<ActionResult>;
    /** Record launches into the playlist; written as one undoable edit when the transport stops. */
    setRecord(on: boolean): Promise<ActionResult>;
    recordState(): Promise<SessionRecordState>;
    onRecordState(cb: (s: SessionRecordState) => void): Unsubscribe;
    /** Grid controller (Launchpad / APC / generic) mapping, persisted in settings. */
    gridSettings(): Promise<LaunchGridSettings>;
    setGridSettings(patch: Partial<LaunchGridSettings>): Promise<ActionResult<LaunchGridSettings>>;
  };
  /**
   * Racks (Wave 12.2, research/16 §2.3). Editing racks is doc commands (`rack.*` via doc.exec); this is the part
   * that needs main: slicing audio onto a drum rack (the analyzer finds the hits), as ONE undo step (actor user).
   */
  racks: {
    /** Slice a sample file, an audio clip or a channel's sample onto a drum rack (+ a pattern replaying it). */
    sliceToPads(source: AudioTarget, opts?: SliceToPadsOptions): Promise<ActionResult<SliceToPadsOutcome>>;
    /** Progress of a running slice (analysing → building). */
    onSliceProgress(cb: (p: SliceProgress) => void): Unsubscribe;
  };
  /**
   * Krypt Script (Wave 12.2b, shared/scripts): sandboxed JavaScript note devices. Scripts run ONLY in main (QuickJS
   * sandbox); saving one into the project is the doc command scripts.save, the library lives in userData/scripts.
   */
  scripts: {
    list(): Promise<ScriptCatalog>;
    /** Header + compile (+ trial = one run on a made-up 2-bar context): line-numbered issues. */
    check(code: string, opts?: { trial?: boolean }): Promise<ScriptCheck>;
    /** Run without writing: one plan per seed (the preview and the 4 Variations). */
    preview(req: ScriptRunRequest, seeds: number[]): Promise<Array<ActionResult<ScriptPlan>>>;
    /** Run and write the notes as ONE undo step (notes.applyScript, actor user). */
    apply(req: ScriptRunRequest): Promise<ActionResult<ScriptApplyOutcome>>;
    saveToLibrary(code: string, name?: string): Promise<ActionResult<{ id: string; name: string; path: string; created: boolean }>>;
    removeFromLibrary(id: string): Promise<ActionResult>;
    revealLibrary(): Promise<ActionResult>;
  };
}

export type { ScriptCatalog, ScriptCheck, ScriptPlan, ScriptRunRequest, ScriptApplyOutcome } from './scripts/types';

/** How racks.sliceToPads / slice_to_pads / slice_sample cut the audio. */
export interface SliceToPadsOptions {
  /** pads (default): a drum rack, one sampler pad per slice · slicer: one Krypt Slicer channel holding the markers. */
  to?: 'pads' | 'slicer';
  /** onsets (default): the analyzer's hits · grid: every `division` beats · manual: `times`. */
  mode?: 'onsets' | 'grid' | 'manual';
  /** manual: slice start times in seconds. */
  times?: number[];
  /** grid: beats per slice (0.25 = 16ths, 1 = quarters; default 1). */
  division?: number;
  /** Most pads (default 16, max 64): onsets keeps the strongest hits. */
  maxSlices?: number;
  /** 0..1: onsets only, higher keeps softer hits (default: all hits). */
  sensitivity?: number;
  /** Put the drum rack (or the Slicer) on this channel (its instrument is replaced; a Slicer keeps its settings); absent = a new channel. */
  channelId?: string;
  name?: string;
  /** Add a pattern that replays the loop (default true). */
  pattern?: boolean;
  /** The loop's tempo (default: detected, else the project tempo). */
  bpm?: number;
  /** Choke group for every pad (1 = each slice cuts the previous one). Default 0. */
  choke?: number;
}

export interface SliceToPadsOutcome {
  channelId: string;
  insertId: string;
  patternId?: string;
  slices: number;
  /** Slice start times (s). */
  times: number[];
  mode: 'onsets' | 'grid' | 'manual';
  bpm: number;
  lengthSec: number;
  /** False until the engine's Sampler has its `end` param (each pad then plays to the end of the sample). Always true for the Slicer. */
  hasEnd: boolean;
  /** Where the slices went. */
  to: 'pads' | 'slicer';
  /** The key slice 1 plays on (C2 = 36 for pads, the Slicer's First key). */
  baseKey: number;
}

export interface SliceProgress {
  stage: string;
  /** 0..1, -1 = indeterminate, 1 = done. */
  fraction: number;
}

/** Launch recording state (main). `lastCapture`: the last recording written into the playlist (the renderer toasts it once per id). */
export interface SessionRecordState {
  on: boolean;
  lastCapture?: { id: number; ok: boolean; message: string };
}

/** A MIDI grid controller for the clip launcher (research/16 §2.1). */
export interface LaunchGridSettings {
  enabled: boolean;
  /** MIDI input id (MidiInputInfo.id); null = any enabled input. */
  device: string | null;
  /** 0-based MIDI channel; null = any. */
  channel: number | null;
  /**
   * launchpad: programmer-mode notes 11..88 (row 1 at the bottom), scene buttons 19..89 · apc-mini: notes 0..63
   * (bottom-left 0), scene buttons 82..89 · generic: `baseNote` + row × 8 + column, row 0 = the first scene.
   */
  layout: 'launchpad' | 'apc-mini' | 'generic';
  baseNote: number;
  /** First track column / scene row the 8×8 grid shows (scrolling the grid). */
  trackOffset: number;
  sceneOffset: number;
  /**
   * Wave 12.2b, grid LEDs: the MIDI output that gets them. Absent or '' = the output paired with `device` by name
   * (shared/live/gridLeds.ts pairLedOutput); null = no LEDs; a MidiOutputInfo.id = that output.
   */
  ledOutput?: string | null;
}

/** MIDI outputs, clock out and sync in (docs/ENGINE_PROTOCOL.md §14). */
export interface MidiOutSettings {
  /** Output ids the user enabled (opened). Clock ports and the grid-LED port are opened as well. */
  outputs: Record<string, boolean>;
  /** Outputs that get MIDI clock (24 PPQ + Start / Stop / Continue / Song Position). Empty = clock out off. */
  clockPorts: string[];
  /** Clock offset in ms (−100..100): positive sends later, negative earlier (for a receiver that runs late / early). */
  clockOffsetMs: number;
  /** MIDI input id whose clock the transport follows; null = internal clock. */
  syncInput: string | null;
  /** When the external clock stops, write its tempo into the project (one undo step). */
  syncWritesTempo: boolean;
}
