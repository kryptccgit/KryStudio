import type { z } from 'zod';
import type { Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';

export interface CommandContext {
  catalog: PluginCatalog;
  newId: (prefix: string) => string;
}

export interface CommandDef<A = any, R = unknown> {
  id: string;
  label: (args: A) => string;
  description: string;
  args: z.ZodType<A>;
  history?: boolean;
  run: (draft: Project, args: A, ctx: CommandContext) => R;
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export function defineCommand<A, R>(def: CommandDef<A, R>): CommandDef<A, R> {
  return def;
}

export function must<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null) throw new CommandError(msg);
  return v;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
