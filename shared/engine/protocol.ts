// ──────────────────────────────────────────────────────────────────────
// Electron main ⇄ krypt-studio-engine.exe protocol (v1).
// Human-readable spec: docs/ENGINE_PROTOCOL.md. The Rust side mirrors these
// shapes with serde (camelCase). Keep the two in lock-step: bump
// PROTOCOL_VERSION on any breaking change.
//
// CONTROL channel: the engine's stdin/stdout, newline-delimited JSON.
//   request  {"id":1,"cmd":"hello","protocol":1}
//   response {"id":1,"ok":true,"data":{...}}  |  {"id":1,"ok":false,"message":"..."}
//   event    {"event":"log","level":"info","message":"..."}        (no id)
// stderr is free-form diagnostics (logged by main, never parsed).
//
// TELEMETRY channel: a WebSocket on 127.0.0.1:<port>/?token=<token> served
// by the engine. The RENDERER connects directly (bypasses main) and receives
// JSON TelemetryFrame text messages at ~60 Hz.
// ──────────────────────────────────────────────────────────────────────

import type { Project } from '../schema/project';
import type { PluginDescriptor } from '../plugins/types';

export const PROTOCOL_VERSION = 1;

// ── Requests (main → engine) ──────────────────────────────────────────

/**
 * Wave 12.2 adds the clip launcher (research/16 §2.1): 'scene' (Scene), 'launchClip' (LaunchClip) and the
 * 'session' singleton (value { quantize, sceneOrder, clipIds }; the engine drops launch clips not in clipIds).
 */
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
  /** Entity id; omitted for singletons ('transport', 'mixer'). */
  id?: string;
  /** Full entity value (Channel, Pattern, Clip, ...). For 'mixer': { masterId }. */
  value: unknown;
}

export interface EntityDelete {
  kind: EntityKind;
  id: string;
}

export type RenderScope = { kind: 'song' } | { kind: 'pattern'; patternId?: string } | { kind: 'range'; startTick: number; endTick: number };

/** MP3 export bitrates (kbit/s, constant bitrate). */
export const MP3_KBPS = [128, 192, 256, 320] as const;
export type Mp3Kbps = (typeof MP3_KBPS)[number];

export interface RenderRequest {
  /** Absolute output path (.wav, or .mp3 for format 'mp3'). */
  path: string;
  scope: RenderScope;
  /**
   * 'mp3': CBR MPEG-1 Layer III through Windows' own MP3 encoder (Media
   * Foundation; no codec ships with Krypt). The file holds only MPEG frames:
   * no ID3 tag and no Xing/Info frame, so a tag can simply be prepended.
   */
  format: 'wav16' | 'wav24' | 'wav32f' | 'mp3';
  /** format 'mp3' only (ignored for WAV): bitrate, default 320. Other values are refused. */
  mp3Kbps?: Mp3Kbps;
  sampleRate?: number; // default = device rate or 48000
  /** Extra seconds rendered after the end for reverb/delay tails. */
  tailSec?: number;
  /** Compute and return an Analysis of the rendered audio. */
  analyze?: boolean;
  /**
   * Render every mixer insert to its own file (path becomes a directory). Wave 8a (research/15 §4): implemented as
   * one offline pass that taps each insert's post-fader output (after its effects and volume/pan, before it is
   * summed into its target), plus the master mix as "Master". Files are named "<NN> <insert name>.<ext>" in insert
   * order; with `analyze`, each file gets its own Analysis in RenderResult.stemResults.
   */
  stems?: boolean;
  /** With `stems`: only these insert ids (default: every insert that carries audio in the rendered range). The Master file is always written. */
  stemInserts?: string[];
  /** Loop count for pattern scope. */
  loops?: number;
  /** Scale the result so its sample peak hits -0.1 dBFS (silence untouched). */
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
  // ── Live input / recording (docs/ENGINE_PROTOCOL.md §7) ──
  | { cmd: 'listMidiInputs' }
  | { cmd: 'setMidiInputs'; autoEnable: boolean; enabled: Record<string, boolean> }
  | { cmd: 'setMidiTarget'; channelId: string | null }
  | { cmd: 'listInputDevices' }
  /** meter: keep the input open for its level meter only (the Recording Studio's mic test; not monitored, not recorded). */
  | { cmd: 'setAudioInput'; deviceId?: string | null; channels?: number[]; monitor?: boolean; meter?: boolean }
  | { cmd: 'setRecord'; armed: boolean; midi: boolean; audio: boolean; countInBars: number; dir?: string; name?: string }
  | { cmd: 'recordStatus' }
  /** Debug engine builds only: inject raw MIDI bytes as if a device sent them. */
  | { cmd: 'debugMidiIn'; bytes: number[]; device?: string }
  /** Gamepads / keyboard pads (shared/live/controllers.ts): whole note / CC messages from a "Krypt: …" virtual input. */
  | { cmd: 'virtualMidiIn'; device: string; bytes: number[] }
  // ── Third-party VST3/CLAP plugins (krypt-studio-pluginhost.exe; docs/ENGINE_PROTOCOL.md) ──
  // `key` is the engine entity: a channel id (instrument) or "insertId/slotId" (effect).
  | { cmd: 'plugins.configure'; hostExe?: string; ownerHwnd?: string }
  | { cmd: 'plugins.register'; plugins: PluginDescriptor[] }
  | { cmd: 'plugins.editor'; key: string; open: boolean; title?: string; ownerHwnd?: string }
  | { cmd: 'plugins.state'; key: string }
  | { cmd: 'plugins.states'; keys?: string[] }
  | { cmd: 'plugins.reload' }
  | { cmd: 'plugins.status' }
  // ── Clip launcher (Session view; docs/ENGINE_PROTOCOL.md §10, research/16 §2.1) ──
  /**
   * Launch a launch clip at its quantize boundary (immediately when the transport is stopped: the transport
   * starts in song mode from the current position). `release` = the key / mouse button went up (gate and
   * repeat clips stop / stop repeating; ignored for other launch modes).
   */
  | { cmd: 'launch'; clipId: string; release?: boolean }
  /** Launch every clip of a scene row (tracks without a clip in that row stop). Scene tempo: main sets it as a doc edit. */
  | { cmd: 'launchScene'; sceneId: string }
  /** Stop one track's launch clip (quantized), or every track's (trackId null). */
  | { cmd: 'launchStop'; trackId: string | null }
  /** Every track returns to its arrangement clips (immediately). */
  | { cmd: 'backToArrangement' }
  /**
   * Record launches into the arrangement: while on and the transport plays, the engine logs what each track's
   * launcher played; on transport stop or when switched off it sends one `launchRecorded` event.
   */
  | { cmd: 'setLaunchRecord'; on: boolean }
  /**
   * MIDI grid controllers: note-ons from `device` (null = any enabled input) whose note is in `notes` launch
   * instead of playing the MIDI target; note-offs send `release`. Replaces the previous map; empty = off.
   */
  | { cmd: 'setLaunchGrid'; device: string | null; channel: number | null; notes: Record<string, LaunchGridAction>; cc?: boolean }
  // ── MIDI out, clock out, sync in (docs/ENGINE_PROTOCOL.md §14) ──
  /** Rescan and list MIDI output ports. */
  | { cmd: 'listMidiOutputs' }
  /** Open exactly these output ids (closing the rest, after their `atClose` messages). Returns MidiOutputInfo[]. */
  | { cmd: 'setMidiOutputs'; enabled: string[] }
  /** Send MIDI clock (24 PPQ, Start / Stop / Continue / SPP) to these open outputs; `offsetMs` shifts it (−100..100, + = later). */
  | { cmd: 'setMidiClock'; ports: string[]; offsetMs?: number }
  /** Send raw messages to an open output now (grid LEDs, SysEx); `atClose` is sent right before the port closes. */
  | { cmd: 'midiSend'; port: string; messages: number[][]; atClose?: number[][] | null }
  /** Follow the clock of this MIDI input (Start / Stop / Continue / SPP drive the transport); null = internal clock. */
  | { cmd: 'setMidiSync'; device: string | null };

/** A MIDI output port (§14). */
export interface MidiOutputInfo {
  /** Stable key: the port name ("Synth #2" for a second identical device). */
  id: string;
  name: string;
  enabled: boolean;
  open: boolean;
  /** Why an enabled port isn't open (e.g. another app holds it on Windows 10). */
  error?: string;
}

/** `setMidiClock` reply. */
export interface MidiClockReply {
  ports: string[];
  /** The clock ports that are open right now. */
  open: string[];
  offsetMs: number;
}

/** Launcher state for grid LEDs (`launcherState`, sent on change): TelemetryFrame.launcher without progress. */
export type LauncherLedState = Omit<LauncherTelemetry, 'progress'>;

/** `TelemetryFrame.sync`: following an external MIDI clock (§14). */
export interface SyncTelemetry {
  /** External tempo (smoothed, 0.01 bpm), null until two pulses arrived. */
  bpm: number | null;
  /** Between the master's Start / Continue and Stop: the transport plays at the external tempo. */
  running: boolean;
  /** The tempo estimate has settled. */
  locked: boolean;
}

/** What a grid-controller note does (keys of `setLaunchGrid.notes` are MIDI note numbers as strings). */
export type LaunchGridAction = { clipId: string } | { sceneId: string } | { stopTrackId: string | null };

/** One stretch of launcher playback on a track, in song ticks (`launchRecorded`). */
export interface LaunchRecordEntry {
  trackId: string;
  clipId: string;
  startTick: number;
  endTick: number;
  /** Ticks into the clip's source at startTick (loop position). */
  offset: number;
}

// ── Response payloads ─────────────────────────────────────────────────

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
  /** Interleaved [min0, max0, min1, max1, ...] per bucket, mono-summed, -1..1. */
  data: number[];
}

/** What an agent "hears" (research/04 §6.5). All dB values are dBFS. */
export interface Analysis {
  durationSec: number;
  peakDb: number;
  truePeakDb: number;
  lufsIntegrated: number;
  lufsShortTermMax: number;
  loudnessRange: number;
  rmsDb: number;
  crestDb: number;
  /** Energy per band in dB: sub <60, low 60-250, lowMid 250-500, mid 500-2k, highMid 2k-6k, high 6k-20k. */
  bands: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
  /** -1..1 stereo correlation; 1 = mono. */
  stereoCorrelation: number;
  stereoWidth: number;
  /** Short-term loudness per second (LUFS), for an energy curve. */
  energyCurve: number[];
  clipping: boolean;
  /** Estimated tempo/key of the rendered audio (best effort, may be null). */
  estimatedBpm: number | null;
  spectralCentroidHz: number;
}

export interface RenderResult {
  path: string;
  files: string[];
  /** durationSec, peakDb, lufsIntegrated and analysis describe the float render (before any MP3 encoding). */
  durationSec: number;
  peakDb: number;
  lufsIntegrated: number;
  analysis?: Analysis;
  /** `stems` renders: one entry per file written, in insert order ("Master" last). analysis only with `analyze`. */
  stemResults?: Array<{ insertId: string; name: string; path: string; analysis?: Analysis }>;
  /** format 'mp3' only. */
  mp3?: Mp3RenderInfo;
  /** Meters (§15): gain reduction of every dynamics slot that reduced during the render. */
  gainReduction?: SlotGainReduction[];
}

/** One dynamics slot over an offline render (`RenderResult.gainReduction`, docs/ENGINE_PROTOCOL.md §15). */
export interface SlotGainReduction {
  insertId: string;
  slotId: string;
  /** Mean gain reduction over the whole render, dB. */
  avgDb: number;
  /** Largest gain reduction, dB. */
  maxDb: number;
  /** Share of the render (0..1) spent reducing by more than 1 dB. */
  active: number;
}

/** What an MP3 render wrote (docs/ENGINE_PROTOCOL.md §6, "MP3 export"). */
export interface Mp3RenderInfo {
  /** 32000 | 44100 | 48000: the render rate, or 44100 / 48000 when the render was resampled for the encoder. */
  sampleRate: number;
  kbps: Mp3Kbps;
  /** Audio samples per channel in the file, at sampleRate. */
  samples: number;
  /** Encoder priming samples before the audio (672 with Windows' encoder). */
  encoderDelay?: number;
  /** Samples after the audio up to the end of the last MPEG frame. */
  endPadding?: number;
  /**
   * iTunes gapless info, e.g. " 00000000 000002a0 00001260 0000000000017700 ...". To keep gapless
   * playback, write it as an ID3v2 COMM frame: language 'eng', description 'iTunSMPB', this text.
   */
  itunSmpb?: string;
}

// ── Live input / recording payloads (§7) ──────────────────────────────

/** A MIDI input port. The engine owns the device (Chromium MIDI stays denied). */
export interface MidiInputInfo {
  /** Stable key: the port name ("Keys #2" for a second identical device). */
  id: string;
  name: string;
  enabled: boolean;
  open: boolean;
  /** Why an enabled device isn't open (e.g. another app holds it on Windows 10). */
  error?: string;
}

export interface InputStatus {
  open: boolean;
  deviceId: string | null;
  name: string | null;
  sampleRate: number;
  /** Device channels (0-based) recorded / monitored; 1 = mono take, 2 = stereo. */
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
  /** Pattern mode: the pattern that was looping. Song mode: null. */
  patternId: string | null;
  /** Latency-compensated. Pattern-relative (pattern mode) or a song tick (song mode). Fractional. */
  tick: number;
  dur: number;
  key: number;
  /** 0..1 */
  vel: number;
  /** Loop pass the note was played in (0-based; song-mode loop recording, §13 Takes). */
  pass?: number;
}

/** One loop pass of a song-mode take recorded over a loop region (§13 Takes). */
export interface RecordedPass {
  /** Song ticks the pass covers: pass 0 from the take start, later passes from the loop start. */
  startTick: number;
  endTick: number;
  /** Heard seconds since the take started = where the pass begins in the audio take file. */
  sec: number;
}

export interface RecordedAudio {
  path: string;
  frames: number;
  sampleRate: number;
  channels: number;
  /** Tick the first frame belongs to (song position in song mode, pattern position in pattern mode). */
  startTick: number;
  /** Sample peak 0..1 (0 = silent take). */
  peak: number;
}

/**
 * One report for a take. Pattern mode reports every loop pass (final=false)
 * and once at the end; `audioPending` = the audio half follows in a later
 * event of the same take (with `audio` set and final=true).
 */
export interface RecordedTake {
  take: number;
  final: boolean;
  mode: 'pattern' | 'song';
  patternId: string | null;
  startTick: number;
  notes: RecordedNote[];
  audioPending: boolean;
  /** Present on the audio report; null when the audio half failed (see error). */
  audio?: RecordedAudio | null;
  error?: string;
  /** Song mode with a loop region, 2+ passes: the pass boundaries (§13 Takes). Absent otherwise. */
  passes?: RecordedPass[];
}

// ── Events (engine → main, on stdout) ─────────────────────────────────

export type EngineEvent =
  | { event: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { event: 'device'; status: DeviceStatus }
  | { event: 'renderProgress'; progress: number }
  | { event: 'applied'; version: number }
  | { event: 'xrun'; count: number }
  // Live input / recording (§7).
  | { event: 'midiInputs'; inputs: MidiInputInfo[] }
  /** Throttled to ≤100 Hz per (device, channel, cc); the last value always arrives. Channel 0-based. */
  | { event: 'midiCc'; device: string; channel: number; cc: number; value: number }
  | ({ event: 'recorded' } & RecordedTake)
  | { event: 'inputStatus'; status: InputStatus }
  /**
   * Audio-clip time-stretch (§4 audio clips): channels whose stretched / pitched copy
   * is still rendering (silent, or still at the previous pitch). Sent when the set
   * changes; `pending: 0` means everything is ready.
   */
  | { event: 'stretch'; pending: number; channels: string[] }
  /** Clip launcher: what was played while launch recording was on (see `setLaunchRecord`). Empty = nothing. */
  | { event: 'launchRecorded'; entries: LaunchRecordEntry[] }
  // MIDI out / clock / sync (§14).
  | { event: 'midiOutputs'; outputs: MidiOutputInfo[] }
  /** The sync input started or stopped the transport (`lost`: its clock vanished while running, playback paused). */
  | { event: 'midiSync'; running: boolean; bpm: number | null; lost?: boolean }
  | ({ event: 'launcherState' } & LauncherLedState)
  | PluginEngineEvent;

/** Third-party plugin host events (keys: channel id or "insertId/slotId"). */
export type PluginEngineEvent =
  /** The plugin host crashed / hung: these instances are silent (reloading = auto-restarted). */
  | { event: 'plugin'; kind: 'crashed'; keys: string[]; names: string[]; message: string; reloading?: boolean }
  | { event: 'plugin'; kind: 'loadFailed'; key: string; pluginId: string; message: string }
  /** The user closed the plugin's native editor window. */
  | { event: 'plugin'; kind: 'editor'; key: string; open: boolean }
  /** The user moved a control in the plugin's own editor (plain value, descriptor units). */
  | { event: 'plugin'; kind: 'param'; key: string; paramId: string; value: number };

// ── Telemetry (engine → renderer WebSocket, ~60 Hz JSON text frames) ──

export interface TelemetryFrame {
  t: 'frame';
  playing: boolean;
  /** Song or pattern position in ticks (fractional). */
  tick: number;
  /** Seconds since play start. */
  sec: number;
  bpm: number;
  mode: 'pattern' | 'song';
  /** Pattern currently looping in pattern mode. */
  patternId: string | null;
  /** Engine monotonic clock in ms when the frame was produced (for interpolation). */
  clockMs: number;
  /** Peak since last frame, linear amplitude [L, R], per mixer insert id. */
  meters: Record<string, [number, number]>;
  /** Channel activity 0..1 per channel id (for the rack's LEDs). */
  channels: Record<string, number>;
  /** Master spectrum, 64 log-spaced bins in dB (sent every 2nd frame). */
  spectrum?: number[];
  /** Audio thread load 0..1. */
  cpu: number;
  xruns: number;
  /** Last DocHost version the engine has applied. */
  appliedVersion: number;
  /**
   * Optional (additive): normalized 0..1 live values of params the engine is
   * driving (automation, MIDI), keyed by ParamRef. The UI prefers these over
   * its client-side automation estimate (src/live/automationFollow.ts).
   */
  params?: Record<string, number>;
  /** Live input (§7): MIDI messages received so far (activity LED: flash when it changes). */
  midiIn?: number;
  /** Present while counting in or recording. */
  rec?: 'countIn' | 'recording';
  /** Count-in beats left. */
  countIn?: number;
  /** Audio input peak since the last frame [L, R] (only while an input is open). */
  inputPeak?: [number, number];
  /** Input monitoring running: peak of the input that reached the output since the last frame (0 = nothing arrives). */
  monitorPeak?: number;
  /** Clip launcher state; present when the project has launch clips. */
  launcher?: LauncherTelemetry;
  /** Following an external MIDI clock (§14); present while a sync input is selected. */
  sync?: SyncTelemetry;
  /**
   * Meters (§15): gain reduction in dB (>= 0, 0.1 dB steps) per "insertId/slotId" since the last frame.
   * Only slots that reduced are present (absent = 0).
   */
  gr?: Record<string, number>;
  /** Meters (§15): the slots watched over this socket (see TelemetryWatch), keyed "insertId/slotId". */
  scopes?: Record<string, SlotScopeData>;
}

/**
 * Sent UP the telemetry WebSocket (renderer → engine, §15): the slots this window wants scopes for
 * ("insertId/slotId", at most 4 across all windows). Replaces the window's previous set; [] = none.
 */
export interface TelemetryWatch {
  t: 'watch';
  slots: string[];
  /** Watched slots whose integrated loudness and true peak start over (they also do when playback starts). */
  reset?: string[];
}

/** A watched slot's output (§15). Loudness values are null while silent. */
export interface SlotScopeData {
  /** Momentary loudness (400 ms), LUFS. */
  lufsM: number | null;
  /** Short-term loudness (3 s), LUFS. */
  lufsS: number | null;
  /** Integrated loudness (gated) since the watch started or playback last started, LUFS. */
  lufsI: number | null;
  /** Highest true peak over the same span, dBTP. */
  truePeak: number | null;
  /** Stereo correlation -1..1 over ~300 ms. */
  correlation: number | null;
  /** 96 log-spaced bins 20 Hz–20 kHz, dBFS (every 2nd frame). */
  spectrum?: number[];
  /** 256 mid-channel samples (-1..1) from a rising zero crossing, spanning 1024 samples (every 2nd frame). */
  scope?: number[];
}

export interface LauncherTelemetry {
  /** trackId → playing launch clip id. Tracks absent = playing the arrangement (or nothing). */
  playing: Record<string, string>;
  /** trackId → launch clip id waiting for its quantize boundary, or 'stop'. */
  queued: Record<string, string>;
  /** Playing clip id → loop position 0..1. */
  progress: Record<string, number>;
  /** Tracks whose arrangement is overridden by the launcher (stay silent in the arrangement until backToArrangement). */
  overridden: string[];
  recording: boolean;
}
