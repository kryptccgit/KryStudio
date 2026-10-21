// ──────────────────────────────────────────────────────────────────────
// Krypt Script v1 (Wave 12.2b, research/17 §1 "scripts"): small JavaScript
// NOTE devices a user or an AI writes. A script is plain text: a comment
// header (name, kind, params) and one function
//
//   function run({ notes, params, key, scale, bpm, timeSig, lengthTicks, seed, rand, … }) { return notes }
//
// It runs ONLY in main, inside a QuickJS (WASM) sandbox
// (electron/scripts/sandbox.ts), never in the renderer. Everything here is
// pure data + types shared by the sandbox, the commands, the UI and MCP.
// ──────────────────────────────────────────────────────────────────────

/** generator = writes notes into bars of a pattern; transform = maps the selected (or all) notes to new notes. */
export type ScriptKind = 'generator' | 'transform';
export const SCRIPT_KINDS: readonly ScriptKind[] = ['generator', 'transform'];

export type ScriptParam =
  | { id: string; type: 'number'; label: string; default: number; min: number; max: number; step: number }
  | { id: string; type: 'choice'; label: string; default: string; options: string[] }
  | { id: string; type: 'toggle'; label: string; default: boolean };

export interface ScriptHeader {
  name: string;
  kind: ScriptKind;
  description: string;
  params: ScriptParam[];
}

/** A problem in a script, with its 1-based line when known (0 = the whole script). */
export interface ScriptIssue {
  line: number;
  message: string;
}

export type ScriptParamValues = Record<string, number | string | boolean>;

/** A script stored in the project (project.scripts), so a song keeps its devices. */
export interface ProjectScript {
  id: string;
  name: string;
  code: string;
}

/** Where a script comes from: the app (factory:…), the user's library (user:…) or this project (scr_…). */
export type ScriptSource = 'factory' | 'user' | 'project';

export interface ScriptInfo {
  id: string;
  source: ScriptSource;
  name: string;
  code: string;
  /** Null when the header has errors (issues says why). */
  header: ScriptHeader | null;
  issues: ScriptIssue[];
}

export interface ScriptCatalog {
  factory: ScriptInfo[];
  user: ScriptInfo[];
  project: ScriptInfo[];
  /** The user library folder (userData/scripts). */
  libraryDir: string;
}

/** One note as a script sees it and returns it (pattern ticks, PPQ 960; vel 0..1). */
export interface ScriptNote {
  tick: number;
  dur: number;
  key: number;
  vel: number;
  pan?: number;
  release?: number;
  fine?: number;
  slide?: boolean;
  mute?: boolean;
  color?: number;
}

/** What the UI / an agent asks main to run. */
export interface ScriptRunRequest {
  /** A stored script (factory:…, user:… or a project scr_… id), or code not saved yet (the code view). */
  script: { id: string } | { code: string };
  patternId: string;
  channelId: string;
  /** The selection: a transform maps these notes; a generator replaces them (mode replace). */
  ids?: string[];
  /** Bars (1-based); omitted = the selection's bars, else the whole pattern. */
  range?: { fromBar: number; bars: number };
  /** Generators only: replace the channel's notes in the bars (default) or merge. */
  mode?: 'replace' | 'merge';
  params?: Record<string, unknown>;
  seed: number;
  /** Key to stay in; omitted = the pattern's key, else the project's, else A minor. */
  key?: { root: number; scale: string };
}

/** What a run would write (the preview), or did write. */
export interface ScriptPlan {
  name: string;
  kind: ScriptKind;
  seed: number;
  notes: ScriptNote[];
  /** Existing note ids the notes replace. */
  remove: string[];
  range: { fromBar: number; bars: number; start: number; end: number };
  keyName: string;
  /** Notes dropped because they started outside the bars (generators). */
  dropped: number;
  /** Notes left out because an identical note (same start and key) was already there or returned twice. */
  skipped: number;
  /** New pattern length when the notes run past a fixed-length pattern. */
  extendTo: number | null;
  /** console.log / log() lines from the script (capped). */
  logs: string[];
  ms: number;
}

export interface ScriptApplyOutcome {
  ids: string[];
  count: number;
  removed: number;
  seed: number;
  name: string;
  range: { fromBar: number; bars: number };
  keyName: string;
}

export interface ScriptCheck {
  ok: boolean;
  header: ScriptHeader | null;
  issues: ScriptIssue[];
}

// ── Limits ────────────────────────────────────────────────────────────

export const SCRIPT_LIMITS = {
  /** Characters of code. */
  codeChars: 64_000,
  /** Notes a script may return (more = an error, not a silent cut). */
  notes: 4096,
  /** Notes passed in. */
  inputNotes: 4096,
  params: 16,
  choiceOptions: 24,
  nameChars: 64,
  descriptionChars: 300,
  /** Scripts stored in one project. */
  perProject: 64,
  /** CPU time per run (QuickJS interrupt handler). */
  timeMs: 200,
  /** QuickJS heap. */
  memoryBytes: 32 * 1024 * 1024,
  /** QuickJS stack. */
  stackBytes: 256 * 1024,
  /** JSON coming back out of the sandbox. */
  outputChars: 2_000_000,
  logLines: 50,
  logChars: 300,
} as const;

/** Ids: factory:<slug>, user:<slug>, scr_<id> (project). */
export const SCRIPT_ID_PREFIX = 'scr';

export function scriptSourceOf(id: string): ScriptSource | null {
  if (id.startsWith('factory:')) return 'factory';
  if (id.startsWith('user:')) return 'user';
  if (id.startsWith(`${SCRIPT_ID_PREFIX}_`)) return 'project';
  return null;
}

/** "Line 4: …" lines for an agent or the code view. */
export function formatIssues(issues: ScriptIssue[], max = 8): string {
  const shown = issues.slice(0, max).map((i) => (i.line > 0 ? `Line ${i.line}: ${i.message}` : i.message));
  return `${shown.join('\n')}${issues.length > max ? `\n(+${issues.length - max} more)` : ''}`;
}
