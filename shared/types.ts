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

export interface SoundsState {
  presets: PresetSummary[];
  factoryCount: number;
  userCount: number;
  userDir: string;
}

export type SimilarSource = { kind: 'sample'; path: string } | { kind: 'preset'; id: string };

export interface SimilarQuery {
  scope?: 'same' | 'any';
  want?: 'samples' | 'presets' | 'all';
  limit?: number;
}

export type SimilarItem = (
  | { type: 'sample'; path: string; kind: SampleKind; origin: 'factory' | 'pack'; rootNote?: number; bars?: number }
  | { type: 'preset'; id: string; role: InstrumentRole; plugin: string; origin: 'factory' | 'user' }
) & {
  name: string;
  percent: number;
  why: string;
  sameKind: boolean;
};

export interface SimilarResult {
  source: {
    name: string;
    kind: string | null;
    inferred: boolean;
  };
  scope: 'same' | 'any';
  items: SimilarItem[];
  pending: number;
  measured: number;
  notes: string[];
}

export interface PackSamplesInfo {
  packs: Array<{ id: string; name: string; installed: boolean; count: number; byKind: Partial<Record<SampleKind, number>> }>;
  samples: PackSample[];
}

export interface SavePresetMeta {
  name: string;
  tags?: string[];
  genres?: GenreId[];
  description?: string;
}

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
  groupId?: string;
  coalesceKey?: string;
  label?: string;
}

export interface ProjectStatus {
  path: string | null;
  name: string;
  dirty: boolean;
  lastSavedAt: number | null;
  recovered: boolean;
}

export interface ProjectTab {
  id: string;
  title: string;
  path: string | null;
  dirty: boolean;
  busy?: string;
}

export interface TabsState {
  tabs: ProjectTab[];
  activeId: string;
  closed: Array<{ id: string; title: string; path: string | null }>;
}

export interface EngineStatus {
  state: 'starting' | 'running' | 'restarting' | 'stopped' | 'failed';
  message?: string;
  device: DeviceStatus | null;
  engineVersion: string | null;
  restarts: number;
}

export type ExportFormat = 'wav16' | 'wav24' | 'wav32f' | 'mp3';
export type { Mp3Kbps };
export const MP3_BITRATES: readonly Mp3Kbps[] = [320, 256, 192, 128];

export interface RenderOptions {
  scope: RenderScope;
  format: ExportFormat;
  mp3Kbps?: Mp3Kbps;
  tags?: boolean;
  path?: string;
  sampleRate?: number;
  tailSec?: number;
  stems?: boolean;
  loops?: number;
  normalize?: boolean;
}

export interface CoverPreview extends CoverRef {
  dataUrl: string;
  bytes: number;
}

export const COVER_STYLES = ['waves', 'grid', 'orbit', 'bars'] as const;
export type CoverStyle = (typeof COVER_STYLES)[number];

export interface CoverDrawRequest {
  id: string;
  style?: string;
  seed?: number;
}

export type CoverDrawResult = { ok: true; bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; style: string; seed: number } | { ok: false; message: string };

export interface ExportCapabilities {
  agentFolder: string;
}

export interface BrowserRoot {
  id: string;
  name: string;
  path: string;
  builtin: boolean;
}

export interface BrowserEntry {
  name: string;
  path: string;
  kind: 'dir' | 'audio' | 'project' | 'midi' | 'other';
  size?: number;
}

export interface Settings {
  audio: { deviceId: string | null; bufferFrames: number; sampleRate: number };
  ui: {
    scale: number;
    showHints: boolean;
    openToHome?: boolean;
    homeLite?: boolean;
    startWithWindows?: boolean;
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
    fileAccess?: FileAccessMode;
  };
  agent: { model: string; hasApiKey: boolean; provider?: import('./agent/providers').AgentProvider; models?: Partial<Record<import('./agent/providers').AgentProvider, string>>; keys?: Partial<Record<import('./agent/providers').AgentProvider, boolean>> };
  discordRpc: boolean;
  keymap?: Record<string, string[]>;
  midi?: MidiSettings;
  recording?: RecordingSettings;
  audioInput?: AudioInputSettings;
  library?: LibrarySettings;
  export?: ExportSettings;
  launchGrid?: LaunchGridSettings;
  midiOut?: MidiOutSettings;
  controllers?: ControllerSettings;
}

export type FileAccessMode = 'anywhere' | 'ask' | 'browser';
export const FILE_ACCESS_MODES: readonly FileAccessMode[] = ['anywhere', 'ask', 'browser'];

export interface ExportSettings {
  folder: 'music' | 'project';
}

export interface LibrarySettings {
  fastScan: boolean;
  focus: LibraryFocus | null;
}

export interface MidiMapping {
  id: string;
  device: string | null;
  channel: number;
  cc: number;
  paramRef: string;
  label?: string;
  min?: number;
  max?: number;
}

export interface MidiSettings {
  autoEnable: boolean;
  inputs: Record<string, boolean>;
  mappings: MidiMapping[];
}

export type RecordMode = 'midi' | 'audio' | 'both';

export interface RecordingSettings {
  mode: RecordMode;
  quantize: number;
  countInBars: 0 | 1 | 2;
}

export interface AudioInputSettings {
  deviceId: string | null;
  channels: number[];
  monitor: boolean;
}

export interface RecordState {
  armed: boolean;
  input: InputStatus | null;
  lastTake?: { id: number; ok: boolean; message: string };
}

export interface MidiLearnState {
  paramRef: string | null;
  label?: string;
}

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
  installable: boolean;
}

export interface PluginFolder {
  path: string;
  builtin: boolean;
  exists: boolean;
}

export interface PluginFileEntry {
  path: string;
  format: 'vst3' | 'clap';
  status: 'ok' | 'failed' | 'timeout' | 'blocked' | 'partial';
  message?: string;
  plugins: string[];
  scannedAt: number;
}

export interface PluginBlockEntry {
  path: string;
  reason: string;
  at: number;
}

export interface PluginInstanceInfo {
  key: string;
  pluginId: string;
  name: string;
  state: 'ok' | 'loading' | 'paused' | 'failed' | 'crashed';
  hasEditor: boolean;
}

export interface PluginManagerState {
  plugins: PluginDescriptor[];
  files: PluginFileEntry[];
  blocked: PluginBlockEntry[];
  folders: PluginFolder[];
  scanning: boolean;
  progress: { done: number; total: number; current: string | null } | null;
  lastScanAt: number | null;
  vst2Found: number;
  hostAvailable: boolean;
  hostUnsupported?: string;
  hostPid: number | null;
  instances: PluginInstanceInfo[];
}

export type PluginTarget = { channelId: string } | { insertId: string; slotId: string };

export interface ModelState {
  def: ModelDef;
  status: 'installed' | 'available' | 'downloading' | 'verifying' | 'failed' | 'unavailable';
  progress?: { received: number; total: number };
  message?: string;
  dir?: string;
}

export interface AnalyzerJobInfo {
  id: string;
  kind: 'analyze' | 'separate' | 'transcribe' | 'fingerprint' | 'tts' | 'sing' | 'syllables' | 'extract';
  label: string;
  stage: string;
  fraction: number;
  startedAt: number;
}

export interface AnalyzerState {
  available: boolean;
  running: boolean;
  pid: number | null;
  version: string | null;
  devices: AnalyzerDevice[];
  models: ModelState[];
  jobs: AnalyzerJobInfo[];
  modelsDir: string;
}

export type AudioTarget = { clipId: string } | { channelId: string } | { path: string };

export type WarpHint = 'drums' | 'mono' | 'mix';

export interface AutoWarpOptions {
  every?: 'bar' | 'beat';
  hint?: WarpHint;
  mode?: WarpMode;
}

export interface AutoWarpOutcome {
  channelId: string;
  markers: number;
  mode: WarpMode;
  hint: WarpHint;
  every: 'bar' | 'beat';
  srcBpm: number;
  beatUnit: number;
  source: string;
  warning?: string;
}

export interface StemsOutcome {
  trackIds: string[];
  channelIds: string[];
  stems: StemName[];
  model: string;
  device: AnalyzerDevice;
  seconds: number;
}

export interface ToPatternOutcome {
  patternId: string;
  channelIds: string[];
  notes: number;
}

export interface ImportOutcome {
  clipId: string;
  channelId: string;
  sampleId: string;
  trackId: string;
  track: number;
  trackName: string;
  name: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  path: string;
  deduped: boolean;
  bytes: number;
}

export interface MatchOutcome {
  channelId: string;
  semitones: number | null;
  fromKey: string | null;
  toKey: string | null;
  resultKey: string | null;
  sourceBpm: number | null;
  reading: 'as detected' | 'double time' | 'half time' | 'alternative' | null;
  followsBpm: number | null;
  ratio: number | null;
  projectBpm: number;
  projectTempoChanged: boolean;
  changed: boolean;
}

export type { TuneStyle };

export interface AudioProjectOptions {
  keepStems?: boolean;
  factor?: 1 | 0.5 | 2;
  parts?: Array<'drums' | 'bass' | 'chords' | 'lead'>;
}

export type AudioProjectStage = 'analyzing' | 'separating' | 'transcribing' | 'matching' | 'building';

export interface AudioProjectProgress {
  stage: AudioProjectStage;
  fraction: number;
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
  sounds: string[];
  notes: string[];
  stemsKept: boolean;
}

export interface TuneOutcome {
  insertId: string;
  slotId: string;
  created: boolean;
  key: string;
  root: number;
  scale: number;
  style: TuneStyle;
  keySource: 'given' | 'vocal' | 'instrumental' | 'patterns';
  confidence: number | null;
  changed: boolean;
}

export interface KryptApi {
  app: {
    version(): Promise<string>;
    openExternal(url: string): Promise<ActionResult>;
    showItemInFolder(path: string): Promise<ActionResult>;
    pathForFile(file: File): string;
    window(action: 'minimize' | 'maximize' | 'close' | 'quit'): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(cb: (maximized: boolean) => void): Unsubscribe;
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
    toggleEntry(entryId: string): Promise<ExecResult>;
    revertActor(actorKey: string): Promise<ExecResult>;
    onPatches(cb: (m: DocPatchMessage) => void): Unsubscribe;
    onReset(cb: (m: DocResetMessage) => void): Unsubscribe;
    onHistoryChanged(cb: () => void): Unsubscribe;
  };
  tabs: {
    state(): Promise<TabsState>;
    onState(cb: (s: TabsState) => void): Unsubscribe;
    newTab(opts?: { template?: string }): Promise<ActionResult<{ id: string }>>;
    open(path?: string): Promise<ActionResult<{ id: string }>>;
    switchTo(id: string): Promise<ActionResult>;
    close(id: string, decision?: 'save' | 'discard'): Promise<ActionResult<{ needsDecision?: boolean }>>;
    move(id: string, toIndex: number): Promise<ActionResult>;
    reopenClosed(): Promise<ActionResult<{ id: string }>>;
  };
  project: {
    status(): Promise<ProjectStatus>;
    newProject(): Promise<ActionResult>;
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
    cover(): Promise<ActionResult<CoverPreview | null>>;
    chooseCover(path?: string): Promise<ActionResult<CoverRef>>;
    setCoverImage(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg', label?: string): Promise<ActionResult<CoverRef>>;
    onCoverRequest(cb: (req: CoverDrawRequest) => void): Unsubscribe;
    respondCover(id: string, result: CoverDrawResult): void;
    exportCapabilities(): Promise<ExportCapabilities>;
  };
  engine: {
    status(): Promise<EngineStatus>;
    onStatus(cb: (s: EngineStatus) => void): Unsubscribe;
    telemetryUrl(): Promise<string | null>;
    transport(action: 'play' | 'stop' | 'pause' | 'toggle'): Promise<ActionResult>;
    locate(tick: number): Promise<ActionResult>;
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
    setEnabled(enabled: boolean): Promise<ActionResult>;
  };
  agent: {
    setApiKey(key: string | null, provider?: import('./agent/providers').AgentProvider): Promise<ActionResult>;
    send(message: string): Promise<ActionResult>;
    cancel(): Promise<void>;
    reset(): Promise<void>;
    onEvent(cb: (e: AgentChatEvent) => void): Unsubscribe;
  };
  log: {
    onAppend(cb: (line: { level: 'info' | 'warn' | 'error'; message: string; time: number }) => void): Unsubscribe;
  };
  midi: {
    inputs(): Promise<ActionResult<MidiInputInfo[]>>;
    setInputEnabled(id: string, enabled: boolean): Promise<ActionResult<MidiInputInfo[]>>;
    setTarget(channelId: string | null): void;
    learn(paramRef: string, label?: string): Promise<ActionResult<MidiMapping>>;
    cancelLearn(): void;
    virtualIn(device: string, bytes: number[]): void;
    removeMapping(id: string): Promise<ActionResult>;
    onInputs(cb: (inputs: MidiInputInfo[]) => void): Unsubscribe;
    onLearn(cb: (s: MidiLearnState) => void): Unsubscribe;
    outputs(): Promise<ActionResult<MidiOutputInfo[]>>;
    setOutputEnabled(id: string, enabled: boolean): Promise<ActionResult<MidiOutputInfo[]>>;
    clockSettings(): Promise<MidiOutSettings>;
    setClockSettings(patch: Partial<Omit<MidiOutSettings, 'outputs'>>): Promise<ActionResult<MidiOutSettings>>;
    onOutputs(cb: (outputs: MidiOutputInfo[]) => void): Unsubscribe;
  };
  record: {
    status(): Promise<RecordState>;
    setArmed(armed: boolean): Promise<ActionResult<RecordState>>;
    listInputDevices(): Promise<ActionResult<DeviceInfo[]>>;
    setMeter(on: boolean): Promise<ActionResult<InputStatus | null>>;
    onStatus(cb: (s: RecordState) => void): Unsubscribe;
  };
  plugins: {
    state(): Promise<PluginManagerState>;
    rescan(opts?: { full?: boolean }): Promise<ActionResult<PluginManagerState>>;
    addFolder(): Promise<ActionResult<PluginManagerState>>;
    removeFolder(path: string): Promise<ActionResult<PluginManagerState>>;
    unblock(path?: string): Promise<ActionResult<PluginManagerState>>;
    openEditor(target: PluginTarget, open?: boolean): Promise<ActionResult>;
    reload(): Promise<ActionResult>;
    onState(cb: (s: PluginManagerState) => void): Unsubscribe;
  };
  analyzer: {
    state(): Promise<AnalyzerState>;
    installModel(id: string): Promise<ActionResult<AnalyzerState>>;
    cancelInstall(id: string): Promise<ActionResult>;
    importModel(id: string): Promise<ActionResult<AnalyzerState>>;
    removeModel(id: string): Promise<ActionResult<AnalyzerState>>;
    analyze(target: AudioTarget): Promise<ActionResult<AudioAnalysis>>;
    separateStems(clipId: string, opts?: { model?: string }): Promise<ActionResult<StemsOutcome>>;
    toPattern(target: AudioTarget, opts: { mode: TranscribeMode; name?: string }): Promise<ActionResult<ToPatternOutcome>>;
    cancelJob(jobId: string): Promise<ActionResult>;
    onState(cb: (s: AnalyzerState) => void): Unsubscribe;
  };
  warp: {
    autoWarp(channelId: string, opts?: AutoWarpOptions): Promise<ActionResult<AutoWarpOutcome>>;
  };
  vocals: {
    tune(target: AudioTarget, opts: { style: TuneStyle; key?: string; scale?: string }): Promise<ActionResult<TuneOutcome>>;
    match(clipId: string, opts?: { to?: 'project' | { clipId: string }; key?: boolean; tempo?: boolean }): Promise<ActionResult<MatchOutcome>>;
  };
  voice: {
    state(): Promise<VoiceState>;
    onState(cb: (s: VoiceState) => void): Unsubscribe;
    speak(req: SpeakRequest): Promise<ActionResult<SpeakOutcome>>;
    sing(req: SingRequest): Promise<ActionResult<SingOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: VoiceProgress) => void): Unsubscribe;
    setFishKey(key: string | null): Promise<ActionResult>;
    cloneMyVoice(opts: { recordingPath: string; name: string; consent: true }): Promise<ActionResult<VoiceInfo>>;
    removeMyVoice(id: string): Promise<ActionResult>;
  };
  automix: {
    presets(): Promise<AutoMixPreset[]>;
    understand(prompt: string): Promise<ActionResult<AutoMixIntent>>;
    run(req: AutoMixRequest): Promise<ActionResult<AutoMixOutcome>>;
    masterFile(req: MasterFileRequest): Promise<ActionResult<AutoMixOutcome>>;
    analyzeReference(path: string): Promise<ActionResult<ReferenceSound>>;
    playReference(path: string, matchLufs: number | null): Promise<ActionResult<{ gainDb: number }>>;
    masterAlbum(req: AlbumRequest): Promise<ActionResult<AlbumOutcome>>;
    exportAlbum(req: AlbumExportRequest): Promise<ActionResult<AlbumExportOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: AutoMixProgress) => void): Unsubscribe;
  };
  mashup: {
    check(req: MashupRequest): Promise<ActionResult<MashupCheck>>;
    build(req: MashupRequest): Promise<ActionResult<MashupOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: MashupProgress) => void): Unsubscribe;
  };
  audioProject: {
    open(path?: string, opts?: AudioProjectOptions): Promise<ActionResult<AudioProjectOutcome>>;
    cancel(): Promise<ActionResult>;
    onProgress(cb: (p: AudioProjectProgress) => void): Unsubscribe;
  };
  library: {
    state(): Promise<LibraryState>;
    onState(cb: (s: LibraryState) => void): Unsubscribe;
    createCollection(name: string, tags?: string[]): Promise<ActionResult<Collection>>;
    updateCollection(id: string, patch: { name?: string; tags?: string[] }): Promise<ActionResult<Collection>>;
    removeCollection(id: string): Promise<ActionResult>;
    addFolder(collectionId: string, path?: string): Promise<ActionResult<{ added: number; skipped: number }>>;
    addFiles(collectionId: string, paths?: string[]): Promise<ActionResult<{ added: number; skipped: number }>>;
    removeTracks(ids: string[]): Promise<ActionResult>;
    rescan(collectionId: string): Promise<ActionResult<{ added: number; changed: number; missing: number }>>;
    setDeep(collectionId: string, deep: boolean): Promise<ActionResult<{ queued: number }>>;
    estimateDeep(collectionId: string): Promise<ActionResult<{ tracks: number; seconds: number; device: AnalyzerDevice }>>;
    setPaused(paused: boolean): Promise<ActionResult>;
    retryFailed(collectionId?: string): Promise<ActionResult<{ queued: number }>>;
    query(q: TrackQuery): Promise<ActionResult<{ tracks: LibraryTrack[]; total: number }>>;
    track(id: string): Promise<ActionResult<TrackDetail>>;
    profile(collectionId: string): Promise<ActionResult<StyleProfile>>;
    similar(trackId: string, opts?: { collectionId?: string; limit?: number }): Promise<ActionResult<Array<{ track: LibraryTrack; score: number }>>>;
    checkOriginality(opts?: { patternId?: string }): Promise<ActionResult<OriginalityReport>>;
    setFocus(focus: { collectionId: string; brief?: string } | null): Promise<ActionResult<LibraryFocus | null>>;
    addToProject(trackId: string): Promise<ActionResult<{ clipId: string; channelId: string }>>;
  };
  sounds: {
    state(): Promise<SoundsState>;
    onState(cb: (s: SoundsState) => void): Unsubscribe;
    get(id: string): Promise<ActionResult<Preset>>;
    saveChannel(channelId: string, meta: SavePresetMeta & { role?: InstrumentRole; withFx?: boolean }): Promise<ActionResult<PresetSummary>>;
    saveChain(insertId: string, meta: SavePresetMeta & { role: ChainRole }): Promise<ActionResult<PresetSummary>>;
    renameUser(id: string, name: string): Promise<ActionResult<PresetSummary>>;
    deleteUser(id: string): Promise<ActionResult>;
    revealUserDir(): Promise<ActionResult>;
    factorySamples(): Promise<FactorySample[]>;
    suggestSampleFolders(): Promise<Array<{ path: string; audioFiles: number; inBrowser: boolean }>>;
    similar(source: SimilarSource, query?: SimilarQuery): Promise<ActionResult<SimilarResult>>;
  };
  packs: {
    state(): Promise<PacksState>;
    onState(cb: (s: PacksState) => void): Unsubscribe;
    install(id: string): Promise<ActionResult<PacksState>>;
    cancel(id: string): Promise<ActionResult>;
    remove(id: string): Promise<ActionResult<PacksState>>;
    reveal(id: string): Promise<ActionResult>;
    samples(): Promise<PackSamplesInfo>;
  };
  session: {
    launch(clipId: string, release?: boolean): Promise<ActionResult>;
    launchScene(sceneId: string): Promise<ActionResult>;
    stop(trackId: string | null): Promise<ActionResult>;
    backToArrangement(): Promise<ActionResult>;
    setRecord(on: boolean): Promise<ActionResult>;
    recordState(): Promise<SessionRecordState>;
    onRecordState(cb: (s: SessionRecordState) => void): Unsubscribe;
    gridSettings(): Promise<LaunchGridSettings>;
    setGridSettings(patch: Partial<LaunchGridSettings>): Promise<ActionResult<LaunchGridSettings>>;
  };
  racks: {
    sliceToPads(source: AudioTarget, opts?: SliceToPadsOptions): Promise<ActionResult<SliceToPadsOutcome>>;
    onSliceProgress(cb: (p: SliceProgress) => void): Unsubscribe;
  };
  scripts: {
    list(): Promise<ScriptCatalog>;
    check(code: string, opts?: { trial?: boolean }): Promise<ScriptCheck>;
    preview(req: ScriptRunRequest, seeds: number[]): Promise<Array<ActionResult<ScriptPlan>>>;
    apply(req: ScriptRunRequest): Promise<ActionResult<ScriptApplyOutcome>>;
    saveToLibrary(code: string, name?: string): Promise<ActionResult<{ id: string; name: string; path: string; created: boolean }>>;
    removeFromLibrary(id: string): Promise<ActionResult>;
    revealLibrary(): Promise<ActionResult>;
  };
}

export type { ScriptCatalog, ScriptCheck, ScriptPlan, ScriptRunRequest, ScriptApplyOutcome } from './scripts/types';

export interface SliceToPadsOptions {
  to?: 'pads' | 'slicer';
  mode?: 'onsets' | 'grid' | 'manual';
  times?: number[];
  division?: number;
  maxSlices?: number;
  sensitivity?: number;
  channelId?: string;
  name?: string;
  pattern?: boolean;
  bpm?: number;
  choke?: number;
}

export interface SliceToPadsOutcome {
  channelId: string;
  insertId: string;
  patternId?: string;
  slices: number;
  times: number[];
  mode: 'onsets' | 'grid' | 'manual';
  bpm: number;
  lengthSec: number;
  hasEnd: boolean;
  to: 'pads' | 'slicer';
  baseKey: number;
}

export interface SliceProgress {
  stage: string;
  fraction: number;
}

export interface SessionRecordState {
  on: boolean;
  lastCapture?: { id: number; ok: boolean; message: string };
}

export interface LaunchGridSettings {
  enabled: boolean;
  device: string | null;
  channel: number | null;
  layout: 'launchpad' | 'apc-mini' | 'generic';
  baseNote: number;
  trackOffset: number;
  sceneOffset: number;
  ledOutput?: string | null;
}

export interface MidiOutSettings {
  outputs: Record<string, boolean>;
  clockPorts: string[];
  clockOffsetMs: number;
  syncInput: string | null;
  syncWritesTempo: boolean;
}
