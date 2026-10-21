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

export const MAX_MCP_MESSAGE_BYTES = 100 * 1024 * 1024;

export interface ProjectOps {
  status(): ProjectStatus;
  save(): Promise<ActionResult<{ path: string }>>;
  saveNew?(name: string): Promise<ActionResult<{ path: string }>>;
  resolveSamplePath(p: string): string;
  renderDir(): string;
  allowedRoots(): string[];
  newProject?(): ActionResult;
  opensNewTabs?(): boolean;
  listTemplates?(): ProjectTemplate[];
  newFromTemplate?(ref: string): Promise<ActionResult<{ template: ProjectTemplate }>>;
}

export interface MainDeps {
  doc: DocHost;
  engine: EngineClient;
  project: ProjectOps;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  broadcast(channel: string, payload: unknown): void;
  userDataDir: string;
  appExePath: string;
  shimExePath: string | null;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  plugins?: {
    openEditor(target: PluginTarget, open?: boolean): Promise<ActionResult>;
    reload(): Promise<ActionResult>;
  };
  analyzer?: Pick<AnalyzerService, 'analyze' | 'separateStems' | 'toPattern' | 'listModels' | 'drumStemHits'> &
    Partial<Pick<AnalyzerService, 'stemFiles' | 'transcribeFile' | 'fingerprint'>>;
  library?: LibraryAccess;
  vocals?: VocalsAccess;
  voice?: VoiceAccess;
  consent?: PathConsent;
  covers?: CoverAccess;
  exporter?: ExportAccess;
  sounds?: SoundsAccess;
  packs?: PacksAccess;
  tabs?: { summaryLine(): string };
  session?: SessionAccess;
  hardware?: HardwareAccess;
  recorder?: Pick<LiveInputController, 'status'>;
}

export type HardwareAccess = Pick<HardwareController, 'listInputs' | 'listOutputs' | 'setOutputEnabled' | 'clockSettings' | 'setClockSettings'>;

export type SessionAccess = Pick<SessionController, 'launch' | 'launchScene' | 'stop' | 'backToArrangement' | 'setRecord' | 'recordState'>;

export type CoverAccess = Pick<CoverService, 'fromFile' | 'generate'>;
export type ExportAccess = Pick<ExportService, 'exportNew' | 'agentFolder' | 'songTags'> & Partial<Pick<ExportService, 'exportStemsNew' | 'writeNewFile'>>;

export type VoiceAccess = Pick<VoiceService, 'state' | 'speak' | 'sing'>;

export type VocalsAccess = Pick<VocalsService, 'importUpload' | 'importFile' | 'match' | 'tune'>;

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
  setApiKey(key: string | null, provider?: import('@shared/agent/providers').AgentProvider): Promise<ActionResult>;
  send(message: string): Promise<ActionResult>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  isBusy?(): boolean;
}

export const MCP_CHANNELS = {
  status: 'mcp:status',
  activity: 'mcp:activity',
  agentEvent: 'agent:event',
} as const;

export type { AgentActivity, AgentChatEvent };
