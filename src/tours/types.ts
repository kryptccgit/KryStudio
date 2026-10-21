import type { GuideAnchorId } from '../guides/anchors';
import type { SingletonKind } from '../workspace/panels';

export type TourId = 'first-beat' | 'windows' | 'song' | 'ai' | 'master';

export type AiChoice = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'api-key';

export interface TourRow {
  id: string;
  name: string;
  steps: number;
}

export interface TourMaster {
  open: boolean;
  songPicked: boolean;
  phase: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  ab: 'before' | 'after';
  verdict: 'open' | 'kept' | 'undone';
}

export interface TourSnapshot {
  homeOpen: boolean;
  homeScreen: string;
  open: string[];
  visible: string[];
  playing: boolean;
  mode: 'pattern' | 'song';
  bpm: number;
  projectId: string;
  tabCount: number;
  kick: TourRow | null;
  clap: TourRow | null;
  patternClips: number;
  dirty: boolean;
  savedPath: string | null;
  exportOpen: boolean;
  master: TourMaster;
  agentTab: 'chat' | 'activity' | 'connect';
  mcpClientIds: string[];
  mcpClientNames: string[];
  installedClients: string[];
  hasApiKey: boolean;
  chatSent: number;
  keys: string[];
  assisted: boolean;
}

export interface TourCtx {
  choice?: AiChoice;
}

export type TourAction =
  | { kind: 'command'; id: string }
  | { kind: 'open'; panel: SingletonKind }
  | { kind: 'close'; panel: SingletonKind }
  | { kind: 'leaveHome' }
  | { kind: 'resetLayout' }
  | { kind: 'agentTab'; tab: 'chat' | 'connect' }
  | { kind: 'steps'; row: 'kick' | 'clap'; steps: number[] }
  | { kind: 'tempo' }
  | { kind: 'mode'; mode: 'pattern' | 'song' }
  | { kind: 'clips'; count: number }
  | { kind: 'installClient' }
  | { kind: 'external'; url: string }
  | { kind: 'showHome'; screen?: 'home' | 'audio' }
  | { kind: 'masterSong' };

export interface TourAnchor {
  guide?: GuideAnchorId;
  selector?: (s: TourSnapshot, c: TourCtx) => string | null;
  panel?: SingletonKind;
  chrome?: boolean;
}

export interface TourRecovery {
  message: string;
  label: string;
  action: TourAction;
}

export interface TourChoice {
  id: AiChoice;
  label: string;
  detail: string;
}

type Text = string | ((c: TourCtx) => string);

export interface TourStep {
  id: string;
  anchor?: TourAnchor;
  title: Text;
  text: Text;
  do: 'click' | 'key' | 'type' | 'read' | 'choose' | 'wait';
  keys?: string;
  command?: string;
  done?: (s: TourSnapshot, base: TourSnapshot, c: TourCtx) => boolean;
  progress?: (s: TourSnapshot, base: TourSnapshot, c: TourCtx) => string | null;
  act?: TourAction | ((c: TourCtx) => TourAction);
  actLabel?: string;
  onEnter?: TourAction;
  recover?: TourRecovery | ((s: TourSnapshot, c: TourCtx) => TourRecovery | null);
  when?: (c: TourCtx) => boolean;
  links?: Array<{ label: string; url: string }>;
  notes?: Text[];
  choices?: TourChoice[];
  next?: TourId[];
  place?: 'center' | 'corner';
  keepEsc?: boolean;
}

export interface Tour {
  id: TourId;
  title: string;
  blurb: string;
  minutes: number;
  steps: TourStep[];
}
