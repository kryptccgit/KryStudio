// ──────────────────────────────────────────────────────────────────────
// Interactive tours (research/22 §1): the data model. Pure types: no React,
// no window. A tour is a list of steps; each step points at one thing on
// screen (an anchor), says what to do in plain words and knows when it is
// done (a predicate over a TourSnapshot, a plain copy of the app state the
// runtime takes a few times a second). Actions ("Do it for me", a step's
// prep, a recovery button) are data too, so the tours stay testable; the
// runtime (./runtime.ts) performs them through the same commands the user
// would trigger.
// ──────────────────────────────────────────────────────────────────────

import type { GuideAnchorId } from '../guides/anchors';
import type { SingletonKind } from '../workspace/panels';

export type TourId = 'first-beat' | 'windows' | 'song' | 'ai' | 'master';

/** Tour 4's paths: an MCP client, or the built-in chat with an API key. */
export type AiChoice = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'api-key';

/** A row of the Channel Rack in the active pattern: how many steps are lit. */
export interface TourRow {
  id: string;
  name: string;
  steps: number;
}

/** Master a song (src/automix on a song file): its window, the run, Before / After and Keep / Undo. */
export interface TourMaster {
  /** The Master a song window is on screen. */
  open: boolean;
  /** Step ① is done: a song is chosen and read (choosing never starts the run). */
  songPicked: boolean;
  /** The Master a song run (idle while Auto Mix works on a project instead). Cancelling counts as running. */
  phase: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  ab: 'before' | 'after';
  verdict: 'open' | 'kept' | 'undone';
}

/** A plain copy of what the tours look at. Built by the runtime; faked in tests. */
export interface TourSnapshot {
  /** The Home layer covers the Studio. */
  homeOpen: boolean;
  /** Which Home screen shows ('home' = the card grid, 'audio' = Audio Tools …). */
  homeScreen: string;
  /** Open panel ids (singletons by kind). */
  open: string[];
  /** Open AND the front tab of their group. */
  visible: string[];
  playing: boolean;
  mode: 'pattern' | 'song';
  bpm: number;
  /** Changes when a new project (tab) is shown. */
  projectId: string;
  tabCount: number;
  /** The Kick row (first channel named like "kick", else the first channel) and the Clap row (clap / snare, else the second). */
  kick: TourRow | null;
  clap: TourRow | null;
  /** Pattern clips on the Playlist. */
  patternClips: number;
  dirty: boolean;
  savedPath: string | null;
  exportOpen: boolean;
  master: TourMaster;
  agentTab: 'chat' | 'activity' | 'connect';
  /** Connected MCP clients (ids and display names). */
  mcpClientIds: string[];
  mcpClientNames: string[];
  /** Clients set up with the Install button this session. */
  installedClients: string[];
  hasApiKey: boolean;
  /** Messages the user sent in the built-in chat. */
  chatSent: number;
  /** Key combos pressed since the step started ("F6", "Ctrl+S"). */
  keys: string[];
  /** "Do it for me" ran during this step. */
  assisted: boolean;
}

export interface TourCtx {
  choice?: AiChoice;
}

/** Things the runtime can do: the "Do it for me" button, a step's prep and the recovery buttons. */
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
  /** A Home screen: the card grid by default, or e.g. Audio Tools ('audio'). */
  | { kind: 'showHome'; screen?: 'home' | 'audio' }
  /** Open the Master a song window (Home ▸ Audio Tools ▸ Master a song…). */
  | { kind: 'masterSong' };

/** Where a step points. `panel` is opened by recovery when the element isn't on screen. */
export interface TourAnchor {
  /** A "Show me" anchor (data-guide). */
  guide?: GuideAnchorId;
  /** A CSS selector, possibly from the state (the Kick row's steps). Tried before `guide`. */
  selector?: (s: TourSnapshot, c: TourCtx) => string | null;
  /** The panel that holds the element. */
  panel?: SingletonKind;
  /** The element lives outside the Studio (title bar, Home): Home covering the Studio doesn't hide it. */
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
  /** No anchor = a card in the middle (or the corner) of the window. */
  anchor?: TourAnchor;
  title: Text;
  /** ≤ 2 short sentences. **bold**, `code` and [[Key]] (a key cap) work, as in the guides. */
  text: Text;
  /** What the user does: click something, press a key, type, read (Next), choose (tour 4), or wait while the app works. */
  do: 'click' | 'key' | 'type' | 'read' | 'choose' | 'wait';
  /** The key shown big for a 'key' step ("F6"); `command` shows the user's own binding when they changed it. */
  keys?: string;
  command?: string;
  /** Advances by itself when true. Read / choose steps have none. */
  done?: (s: TourSnapshot, base: TourSnapshot, c: TourCtx) => boolean;
  /** A live line under the text ("Kick: 2 of 4 boxes"). */
  progress?: (s: TourSnapshot, base: TourSnapshot, c: TourCtx) => string | null;
  /** "Do it for me". Absent = the step can't be done for you (typing in another app). */
  act?: TourAction | ((c: TourCtx) => TourAction);
  actLabel?: string;
  /** Prep when the step starts (open the panel it talks about). */
  onEnter?: TourAction;
  /** What to say and offer when the anchor isn't on screen (overrides the automatic advice). */
  recover?: TourRecovery | ((s: TourSnapshot, c: TourCtx) => TourRecovery | null);
  /** Branches: the step is part of the tour only when this is true. */
  when?: (c: TourCtx) => boolean;
  /** External links (opened in the browser). */
  links?: Array<{ label: string; url: string }>;
  /** Small honest notes under the text (costs). */
  notes?: Text[];
  choices?: TourChoice[];
  /** Tours offered on the last card. */
  next?: TourId[];
  /** Anchorless card placement: the middle (default) or the bottom-right corner (a dialog is open). */
  place?: 'center' | 'corner';
  /** Esc belongs to the app during this step (it closes Home), not to the tour. */
  keepEsc?: boolean;
}

export interface Tour {
  id: TourId;
  title: string;
  /** One line for the picker. */
  blurb: string;
  minutes: number;
  steps: TourStep[];
}
