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

export interface ScriptIssue {
  line: number;
  message: string;
}

export type ScriptParamValues = Record<string, number | string | boolean>;

export interface ProjectScript {
  id: string;
  name: string;
  code: string;
}

export type ScriptSource = 'factory' | 'user' | 'project';

export interface ScriptInfo {
  id: string;
  source: ScriptSource;
  name: string;
  code: string;
  header: ScriptHeader | null;
  issues: ScriptIssue[];
}

export interface ScriptCatalog {
  factory: ScriptInfo[];
  user: ScriptInfo[];
  project: ScriptInfo[];
  libraryDir: string;
}

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

export interface ScriptRunRequest {
  script: { id: string } | { code: string };
  patternId: string;
  channelId: string;
  ids?: string[];
  range?: { fromBar: number; bars: number };
  mode?: 'replace' | 'merge';
  params?: Record<string, unknown>;
  seed: number;
  key?: { root: number; scale: string };
}

export interface ScriptPlan {
  name: string;
  kind: ScriptKind;
  seed: number;
  notes: ScriptNote[];
  remove: string[];
  range: { fromBar: number; bars: number; start: number; end: number };
  keyName: string;
  dropped: number;
  skipped: number;
  extendTo: number | null;
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

export const SCRIPT_LIMITS = {
  codeChars: 64_000,
  notes: 4096,
  inputNotes: 4096,
  params: 16,
  choiceOptions: 24,
  nameChars: 64,
  descriptionChars: 300,
  perProject: 64,
  timeMs: 200,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  outputChars: 2_000_000,
  logLines: 50,
  logChars: 300,
} as const;

export const SCRIPT_ID_PREFIX = 'scr';

export function scriptSourceOf(id: string): ScriptSource | null {
  if (id.startsWith('factory:')) return 'factory';
  if (id.startsWith('user:')) return 'user';
  if (id.startsWith(`${SCRIPT_ID_PREFIX}_`)) return 'project';
  return null;
}

export function formatIssues(issues: ScriptIssue[], max = 8): string {
  const shown = issues.slice(0, max).map((i) => (i.line > 0 ? `Line ${i.line}: ${i.message}` : i.message));
  return `${shown.join('\n')}${issues.length > max ? `\n(+${issues.length - max} more)` : ''}`;
}
