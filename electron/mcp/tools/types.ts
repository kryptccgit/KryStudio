import type { z } from 'zod';
import type { Actor, ExecResult } from '@shared/doc/DocHost';
import type { MainDeps } from '../types';

export type AgentActor = Extract<Actor, { kind: 'agent' }>;

export interface EditSession {
  group: { id: string; label: string; started: number; calls: number; touched?: string[] } | null;
}

export interface ToolCaller {
  actor: AgentActor;
  session: EditSession;
  via: 'mcp' | 'http' | 'panel' | 'test';
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  message: string;
  changed: string[];
  data?: T;
  text?: string;
  warnings?: string[];
}

export type ToolKind = 'read' | 'write' | 'destructive' | 'transport' | 'history';

export interface RunCtx {
  groupId: string;
  exec<T = unknown>(cmd: string, args: unknown): T;
  execBatch(steps: Array<{ cmd: string; args: unknown }>): unknown[];
  tryExec<T = unknown>(cmd: string, args: unknown): ExecResult<T>;
  progress?(fraction: number, message: string): void;
  signal?: AbortSignal;
}

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
  paths?: (args: z.infer<S>) => ToolPathArg[];
  readsWhenUnchanged?: boolean;
  summarize?: (args: z.infer<S>, deps: MainDeps) => string;
  run: (deps: MainDeps, caller: ToolCaller, args: z.infer<S>, ctx: RunCtx) => ToolResult | Promise<ToolResult>;
}

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
