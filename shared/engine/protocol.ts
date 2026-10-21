import type { Project } from '../schema/project';
import type { PluginDescriptor } from '../plugins/types';

export const PROTOCOL_VERSION = 1;

export type EntityKind =
  | 'transport'
  | 'channel'
  | 'pattern'
  | 'track'
  | 'clip'
  | 'automation'
  | 'insert'
  | 'mixer'
  | 'sample'
  | 'scene'
  | 'launchClip'
  | 'session';

export interface EntityUpsert {
  kind: EntityKind;
  id?: string;
  value: unknown;
}

export interface EntityDelete {
  kind: EntityKind;
  id: string;
}

export type RenderScope = { kind: 'song' } | { kind: 'pattern'; patternId?: string } | { kind: 'range'; startTick: number; endTick: number };

export const MP3_KBPS = [128, 192, 256, 320] as const;
export type Mp3Kbps = (typeof MP3_KBPS)[number];

export interface RenderRequest {
  path: string;
  scope: RenderScope;
  format: 'wav16' | 'wav24' | 'wav32f' | 'mp3';
  mp3Kbps?: Mp3Kbps;
  sampleRate?: number;
  tailSec?: number;
  analyze?: boolean;
  stems?: boolean;
  stemInserts?: string[];
  loops?: number;
  normalize?: boolean;
}

export type EngineRequest =
  | { cmd: 'hello'; protocol: number }
  | { cmd: 'ping' }
  | { cmd: 'listDevices' }
  | { cmd: 'openDevice'; deviceId?: string | null; bufferFrames?: number; sampleRate?: number }
  | { cmd: 'loadProject'; version: number; project: Project }
  | { cmd: 'apply'; version: number; upserts: EntityUpsert[]; deletes: EntityDelete[] }
  | { cmd: 'transport'; action: 'play' | 'stop' | 'pause' | 'toggle' }
  | { cmd: 'locate'; tick: number }
  | { cmd: 'audition'; channelId: string; key: number; vel: number; on: boolean }
  | { cmd: 'auditionOff' }
  | { cmd: 'previewFile'; path: string; gain?: number }
  | { cmd: 'stopPreview' }
  | { cmd: 'render'; job: RenderRequest }
  | { cmd: 'cancelRender' }
  | { cmd: 'analyzeFile'; path: string }
  | { cmd: 'sampleInfo'; path: string }
  | { cmd: 'peaks'; path: string; buckets: number }
  | { cmd: 'catalog' }
  | { cmd: 'shutdown' }
  | { cmd: 'listMidiInputs' }
  | { cmd: 'setMidiInputs'; autoEnable: boolean; enabled: Record<string, boolean> }
  | { cmd: 'setMidiTarget'; channelId: string | null }
  | { cmd: 'listInputDevices' }
  | { cmd: 'setAudioInput'; deviceId?: string | null; channels?: number[]; monitor?: boolean; meter?: boolean }
  | { cmd: 'setRecord'; armed: boolean; midi: boolean; audio: boolean; countInBars: number; dir?: string; name?: string }
  | { cmd: 'recordStatus' }
  | { cmd: 'debugMidiIn'; bytes: number[]; device?: string }
  | { cmd: 'virtualMidiIn'; device: string; bytes: number[] }
  | { cmd: 'plugins.configure'; hostExe?: string; ownerHwnd?: string }
  | { cmd: 'plugins.register'; plugins: PluginDescriptor[] }
  | { cmd: 'plugins.editor'; key: string; open: boolean; title?: string; ownerHwnd?: string }
  | { cmd: 'plugins.state'; key: string }
  | { cmd: 'plugins.states'; keys?: string[] }
  | { cmd: 'plugins.reload' }
  | { cmd: 'plugins.status' }
  | { cmd: 'launch'; clipId: string; release?: boolean }
  | { cmd: 'launchScene'; sceneId: string }
  | { cmd: 'launchStop'; trackId: string | null }
  | { cmd: 'backToArrangement' }
  | { cmd: 'setLaunchRecord'; on: boolean }
  | { cmd: 'setLaunchGrid'; device: string | null; channel: number | null; notes: Record<string, LaunchGridAction>; cc?: boolean }
  | { cmd: 'listMidiOutputs' }
  | { cmd: 'setMidiOutputs'; enabled: string[] }
  | { cmd: 'setMidiClock'; ports: string[]; offsetMs?: number }
  | { cmd: 'midiSend'; port: string; messages: number[][]; atClose?: number[][] | null }
  | { cmd: 'setMidiSync'; device: string | null };

export interface MidiOutputInfo {
  id: string;
  name: string;
  enabled: boolean;
  open: boolean;
  error?: string;
}

export interface MidiClockReply {
  ports: string[];
  open: string[];
  offsetMs: number;
}

export type LauncherLedState = Omit<LauncherTelemetry, 'progress'>;

export interface SyncTelemetry {
  bpm: number | null;
  running: boolean;
  locked: boolean;
}

export type LaunchGridAction = { clipId: string } | { sceneId: string } | { stopTrackId: string | null };

export interface LaunchRecordEntry {
  trackId: string;
  clipId: string;
  startTick: number;
  endTick: number;
  offset: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  backend: 'wasapi' | 'wasapi-exclusive' | 'asio';
  isDefault: boolean;
  channels: number;
  sampleRates: number[];
}

export interface DeviceStatus {
  open: boolean;
  id: string | null;
  name: string | null;
  backend: string | null;
  sampleRate: number;
  bufferFrames: number;
  outputLatencyMs: number;
  message?: string;
}

export interface HelloData {
  engineVersion: string;
  protocol: number;
  telemetry: { port: number; token: string };
  device: DeviceStatus;
}

export interface SampleInfo {
  path: string;
  frames: number;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface Peaks {
  frames: number;
  sampleRate: number;
  channels: number;
  data: number[];
}

export interface Analysis {
  durationSec: number;
  peakDb: number;
  truePeakDb: number;
  lufsIntegrated: number;
  lufsShortTermMax: number;
  loudnessRange: number;
  rmsDb: number;
  crestDb: number;
  bands: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  stereoCorrelation: number;
  stereoWidth: number;
  energyCurve: number[];
  clipping: boolean;
  estimatedBpm: number | null;
  spectralCentroidHz: number;
}

export interface RenderResult {
  path: string;
  files: string[];
  durationSec: number;
  peakDb: number;
  lufsIntegrated: number;
  analysis?: Analysis;
  stemResults?: Array<{ insertId: string; name: string; path: string; analysis?: Analysis }>;
  mp3?: Mp3RenderInfo;
  gainReduction?: SlotGainReduction[];
}

export interface SlotGainReduction {
  insertId: string;
  slotId: string;
  avgDb: number;
  maxDb: number;
  active: number;
}

export interface Mp3RenderInfo {
  sampleRate: number;
  kbps: Mp3Kbps;
  samples: number;
  encoderDelay?: number;
  endPadding?: number;
  itunSmpb?: string;
}

export interface MidiInputInfo {
  id: string;
  name: string;
  enabled: boolean;
  open: boolean;
  error?: string;
}

export interface InputStatus {
  open: boolean;
  deviceId: string | null;
  name: string | null;
  sampleRate: number;
  channels: number[];
  deviceChannels: number;
  latencyMs: number;
  message?: string;
}

export interface RecordStatus {
  armed: boolean;
  state: 'idle' | 'countIn' | 'recording';
  input: InputStatus;
}

export interface RecordedNote {
  channelId: string;
  patternId: string | null;
  tick: number;
  dur: number;
  key: number;
  vel: number;
  pass?: number;
}

export interface RecordedPass {
  startTick: number;
  endTick: number;
  sec: number;
}

export interface RecordedAudio {
  path: string;
  frames: number;
  sampleRate: number;
  channels: number;
  startTick: number;
  peak: number;
}

export interface RecordedTake {
  take: number;
  final: boolean;
  mode: 'pattern' | 'song';
  patternId: string | null;
  startTick: number;
  notes: RecordedNote[];
  audioPending: boolean;
  audio?: RecordedAudio | null;
  error?: string;
  passes?: RecordedPass[];
}

export type EngineEvent =
  | { event: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { event: 'device'; status: DeviceStatus }
  | { event: 'renderProgress'; progress: number }
  | { event: 'applied'; version: number }
  | { event: 'xrun'; count: number }
  | { event: 'midiInputs'; inputs: MidiInputInfo[] }
  | { event: 'midiCc'; device: string; channel: number; cc: number; value: number }
  | ({ event: 'recorded' } & RecordedTake)
  | { event: 'inputStatus'; status: InputStatus }
  | { event: 'stretch'; pending: number; channels: string[] }
  | { event: 'launchRecorded'; entries: LaunchRecordEntry[] }
  | { event: 'midiOutputs'; outputs: MidiOutputInfo[] }
  | { event: 'midiSync'; running: boolean; bpm: number | null; lost?: boolean }
  | ({ event: 'launcherState' } & LauncherLedState)
  | PluginEngineEvent;

export type PluginEngineEvent =
  | { event: 'plugin'; kind: 'crashed'; keys: string[]; names: string[]; message: string; reloading?: boolean }
  | { event: 'plugin'; kind: 'loadFailed'; key: string; pluginId: string; message: string }
  | { event: 'plugin'; kind: 'editor'; key: string; open: boolean }
  | { event: 'plugin'; kind: 'param'; key: string; paramId: string; value: number };

export interface TelemetryFrame {
  t: 'frame';
  playing: boolean;
  tick: number;
  sec: number;
  bpm: number;
  mode: 'pattern' | 'song';
  patternId: string | null;
  clockMs: number;
  meters: Record<string, [number, number]>;
  channels: Record<string, number>;
  spectrum?: number[];
  cpu: number;
  xruns: number;
  appliedVersion: number;
  params?: Record<string, number>;
  midiIn?: number;
  rec?: 'countIn' | 'recording';
  countIn?: number;
  inputPeak?: [number, number];
  monitorPeak?: number;
  launcher?: LauncherTelemetry;
  sync?: SyncTelemetry;
  gr?: Record<string, number>;
  scopes?: Record<string, SlotScopeData>;
}

export interface TelemetryWatch {
  t: 'watch';
  slots: string[];
  reset?: string[];
}

export interface SlotScopeData {
  lufsM: number | null;
  lufsS: number | null;
  lufsI: number | null;
  truePeak: number | null;
  correlation: number | null;
  spectrum?: number[];
  scope?: number[];
}

export interface LauncherTelemetry {
  playing: Record<string, string>;
  queued: Record<string, string>;
  progress: Record<string, number>;
  overridden: string[];
  recording: boolean;
}
