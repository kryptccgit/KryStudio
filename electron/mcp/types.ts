// Contract between the main-process bootstrap (electron/main.ts, ipc.ts) and
// the MCP server + built-in agent modules (electron/mcp/, electron/agent/).
// main.ts calls startMcp(deps) / createAgent(deps) once after DocHost and the
// engine client exist; ipc.ts forwards the window.krypt.mcp.* / agent.* calls.

import type { ProjectTemplate } from '@shared/templates';
import type { DocHost } from '@shared/doc/DocHost';
import type { ActionResult, AgentActivity, AgentChatEvent, ClientConfigSnippet, McpStatus, PluginTarget, ProjectStatus, Settings } from '@shared/types';
import type { EngineClient } from '../engine/types';
import type { AnalyzerService } from '../analyzer/service';
import type { LibraryService } from '../library/service';
import type { VocalsService } from '../vocals/service';
import type { VoiceService } from '../voice/service';
import type { PathConsent } from './consent';
import type { CoverService } from '../project/cover';
import type { ExportService } from '../project/export';
import type { SoundsAccess } from '../sounds/types';
import type { PacksAccess } from '../packs/service';
import type { SessionController } from '../session/controller';
import type { HardwareController } from '../midi/hardware';
import type { LiveInputController } from '../input/liveInput';

/**
 * Largest MCP message (one JSON-RPC line on the pipe, one HTTP body): import_audio carries up to 60 MB of audio
 * as base64 (about 80 MB) plus its envelope.
 */
export const MAX_MCP_MESSAGE_BYTES = 100 * 1024 * 1024;

export interface ProjectOps {
  status(): ProjectStatus;
  save(): Promise<ActionResult<{ path: string }>>;
  /** save_project for a never-saved project: a NEW <name>.kstudio in the default project folder (never overwrites). */
  saveNew?(name: string): Promise<ActionResult<{ path: string }>>;
  /** Resolve a sample path ('factory:...' or absolute) for display / analysis. */
  resolveSamplePath(p: string): string;
  /** Directory agents may write renders to (temp, inside userData). */
  renderDir(): string;
  /** User browser roots (agents may read audio files only under these + factory, or what the user allows: consent). */
  allowedRoots(): string[];
  /** A fresh default project (File ▸ New; clears history). audio_to_project into: 'new' uses it. */
  newProject?(): ActionResult;
  /** True when newProject / newFromTemplate open a NEW project tab (the open project is kept, nothing replaced). */
  opensNewTabs?(): boolean;
  /** Wave 12.2b: the user's project templates (File ▸ Save as template…) and a new project from one (new_project). */
  listTemplates?(): ProjectTemplate[];
  newFromTemplate?(ref: string): Promise<ActionResult<{ template: ProjectTemplate }>>;
}

export interface MainDeps {
  doc: DocHost;
  engine: EngineClient;
  project: ProjectOps;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  /** Send to every renderer window: webContents.send(channel, payload). */
  broadcast(channel: string, payload: unknown): void;
  userDataDir: string;
  /** Absolute path of the packaged/dev app executable (for the shim to relaunch). */
  appExePath: string;
  /** Absolute path of krypt-studio-mcp.exe (dev: engine/target/..., packaged: resources/bin). */
  shimExePath: string | null;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Third-party VST3/CLAP plugins (electron/plugins): native windows + host reload. */
  plugins?: {
    openEditor(target: PluginTarget, open?: boolean): Promise<ActionResult>;
    reload(): Promise<ActionResult>;
  };
  /** On-device audio ML (electron/analyzer). Agents use installed models only; they never download. */
  analyzer?: Pick<AnalyzerService, 'analyze' | 'separateStems' | 'toPattern' | 'listModels' | 'drumStemHits'> &
    /** Wave 8a (audio_to_project / build_from_reference): stems, stem transcription and sound fingerprints, no project change. */
    Partial<Pick<AnalyzerService, 'stemFiles' | 'transcribeFile' | 'fingerprint'>>;
  /**
   * Reference library (electron/library). Agents read it, queue light-pass imports and may switch on deep analysis
   * only when a stem model is already installed; they never download.
   */
  library?: LibraryAccess;
  /** Vocals & mashups (electron/vocals): import audio, match key / tempo, Krypt Tune. */
  vocals?: VocalsAccess;
  /** Krypt Voice (electron/voice): speech and sung lyrics as audio clips. Agents never set the Fish key or clone voices. */
  voice?: VoiceAccess;
  /**
   * File access outside the Browser folders (electron/mcp/consent.ts): asks the user (in the client through MCP
   * elicitation, else a Krypt Studio dialog) and remembers "Allow this file" for the app session. Absent = such
   * paths are refused.
   */
  consent?: PathConsent;
  /** The project's cover image (electron/project/cover.ts): from a file or drawn by the main window. */
  covers?: CoverAccess;
  /** Exports with song info + cover embedded (electron/project/export.ts). Agents never choose the path. */
  exporter?: ExportAccess;
  /** Presets (factory + user) and the factory sample index (electron/sounds). */
  sounds?: SoundsAccess;
  /** Sound packs (electron/packs): read-only status for list_packs and preset gating. Only the user downloads packs. */
  packs?: PacksAccess;
  /** Project tabs (electron/project/tabs.ts): get_project lists them. Agents work on the active tab only. */
  tabs?: { summaryLine(): string };
  /** Clip launcher runtime (electron/session): launch / stop / launch recording. */
  session?: SessionAccess;
  /** MIDI ports, clock out and sync in (electron/midi/hardware.ts): midi_setup. */
  hardware?: HardwareAccess;
  /** Live input (electron/input/liveInput.ts): setup_recording reads whether recording is armed. Read-only for agents. */
  recorder?: Pick<LiveInputController, 'status'>;
}

/** What agents use of the MIDI hardware runtime. */
export type HardwareAccess = Pick<HardwareController, 'listInputs' | 'listOutputs' | 'setOutputEnabled' | 'clockSettings' | 'setClockSettings'>;

/** What agents use of the clip launcher runtime. */
export type SessionAccess = Pick<SessionController, 'launch' | 'launchScene' | 'stop' | 'backToArrangement' | 'setRecord' | 'recordState'>;

export type CoverAccess = Pick<CoverService, 'fromFile' | 'generate'>;
export type ExportAccess = Pick<ExportService, 'exportNew' | 'agentFolder' | 'songTags'> & Partial<Pick<ExportService, 'exportStemsNew' | 'writeNewFile'>>;

/** What agents use of Krypt Voice (no key, no cloning, no removal). */
export type VoiceAccess = Pick<VoiceService, 'state' | 'speak' | 'sing'>;

/** What agents use of the vocals service (the clip menu uses the same methods through IPC). */
export type VocalsAccess = Pick<VocalsService, 'importUpload' | 'importFile' | 'match' | 'tune'>;

/** What agents (MCP tools, the built-in agent) may use of the reference library. */
export type LibraryAccess = Pick<
  LibraryService,
  | 'state'
  | 'collections'
  | 'findCollection'
  | 'createCollection'
  | 'addFolder'
  | 'addFiles'
  | 'setDeep'
  | 'estimateDeep'
  | 'query'
  | 'track'
  | 'similar'
  | 'profileText'
  | 'checkOriginality'
  | 'originalityForFocus'
  | 'focus'
  | 'focusContext'
>;

export interface McpController {
  status(): McpStatus;
  clientConfigs(): ClientConfigSnippet[];
  installClientConfig(client: string): Promise<ActionResult>;
  setEnabled(enabled: boolean): Promise<ActionResult>;
  stop(): Promise<void>;
}

export interface AgentController {
  /** Save (or remove, null) the key for a provider (default: the selected one). */
  setApiKey(key: string | null, provider?: import('@shared/agent/providers').AgentProvider): Promise<ActionResult>;
  send(message: string): Promise<ActionResult>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  /** A request is running (the project tabs refuse a switch meanwhile). */
  isBusy?(): boolean;
}

/** Broadcast channel names (renderer subscribes through preload). */
export const MCP_CHANNELS = {
  status: 'mcp:status',
  activity: 'mcp:activity',
  agentEvent: 'agent:event',
} as const;

export type { AgentActivity, AgentChatEvent };
