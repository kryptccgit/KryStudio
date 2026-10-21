// Tool registry types. A tool is a plain function over (deps, caller, args):
// the MCP server (electron/mcp/index.ts) and the built-in agent panel
// (electron/agent/index.ts) run the SAME definitions through callTool().
// Tools never mutate the project except through shared/commands via
// RunCtx.exec (DocHost.exec with the agent actor + the call's group).

import type { z } from 'zod';
import type { Actor, ExecResult } from '@shared/doc/DocHost';
import type { MainDeps } from '../types';

export type AgentActor = Extract<Actor, { kind: 'agent' }>;

/** Per-client mutable state that survives between calls (one per MCP connection / panel). */
export interface EditSession {
  /** Agent-declared edit group (begin_edit … commit_edit): every edit folds into ONE history entry. */
  group: { id: string; label: string; started: number; calls: number; /** Entity ids the group's calls changed. */ touched?: string[] } | null;
}

export interface ToolCaller {
  actor: AgentActor;
  session: EditSession;
  /** mcp = the named pipe (the shim); http = the optional local HTTP endpoint (capped at File access "ask"). */
  via: 'mcp' | 'http' | 'panel' | 'test';
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  /** One human paragraph: what was applied (or why not). */
  message: string;
  /** Entity ids the call actually changed (derived from DocHost patches, never claimed). */
  changed: string[];
  data?: T;
  /** Verbatim text appended after the message (KPN, tables). */
  text?: string;
  warnings?: string[];
}

/**
 * read        — never changes the project (readOnlyHint)
 * write       — additive / reversible edits (a no-op is reported as ok:false)
 * destructive — deletes or overwrites user material (destructiveHint)
 * transport   — playback / engine side effects, no document change
 * history     — undo / revert / edit groups (changes come from history ops)
 */
export type ToolKind = 'read' | 'write' | 'destructive' | 'transport' | 'history';

export interface RunCtx {
  /** The DocHost group this call's edits fold into. */
  groupId: string;
  /** DocHost.exec as the agent, inside the call's group. Throws ToolFailure when the command fails. */
  exec<T = unknown>(cmd: string, args: unknown): T;
  /** Atomic multi-command exec (all-or-nothing). Throws ToolFailure on failure. */
  execBatch(steps: Array<{ cmd: string; args: unknown }>): unknown[];
  /** Raw exec result without throwing (for tolerated failures). */
  tryExec<T = unknown>(cmd: string, args: unknown): ExecResult<T>;
  /** Long-running work (analyzer jobs): report progress 0..1 (-1 = indeterminate) when the client asked for it. */
  progress?(fraction: number, message: string): void;
  /** Aborted when the client cancels the request. */
  signal?: AbortSignal;
}

/** A path argument a tool reads from the user's disk (consent: electron/mcp/consent.ts). */
export interface ToolPathArg {
  value: string | undefined;
  kind: 'audio' | 'folder' | 'audio-or-folder' | 'image' | 'midi';
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  kind: ToolKind;
  /**
   * The user files this call would read. callTool checks each one BEFORE the tool runs (outside the mutation
   * queue and the history group) under the File access setting: refused outright when unsafe, put to the user
   * in "ask" mode. The tool itself still validates the path (agentSamplePath / checkImportFolder / agentImagePath).
   */
  paths?: (args: z.infer<S>) => ToolPathArg[];
  /**
   * A write tool whose answer matters even when the project already matched (study_reference re-reading a reference
   * that is already on the Playlist): no "No change" failure when nothing was modified.
   */
  readsWhenUnchanged?: boolean;
  /** Short label for the history entry / activity feed, e.g. `write_pattern "Trap A" (5 ch)`. */
  summarize?: (args: z.infer<S>, deps: MainDeps) => string;
  run: (deps: MainDeps, caller: ToolCaller, args: z.infer<S>, ctx: RunCtx) => ToolResult | Promise<ToolResult>;
}

/** Thrown inside tools for a clean ok:false result. */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

export function fail(message: string): never {
  throw new ToolFailure(message);
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function ok<T>(message: string, data?: T, extra: Partial<ToolResult<T>> = {}): ToolResult<T> {
  return { ok: true, message, changed: [], data, ...extra };
}
