// ──────────────────────────────────────────────────────────────────────
// Semantic commands — THE single mutation path for the project document.
// The UI (via IPC), MCP agents (via tools), MIDI controllers and scripts all
// call these same commands through DocHost.exec(). That is what makes
// "revert everything the AI just did" one click (research/04 §6.1).
//
// A command mutates an Immer draft. It must:
//   - validate its args with zod (done by DocHost before run()),
//   - throw CommandError with a human-readable message on bad references,
//   - never do I/O, never touch time/randomness except via ctx.newId.
// ──────────────────────────────────────────────────────────────────────

import type { z } from 'zod';
import type { Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';

export interface CommandContext {
  catalog: PluginCatalog;
  newId: (prefix: string) => string;
}

export interface CommandDef<A = any, R = unknown> {
  id: string;
  /** Short past-tense-ish label for the history panel, e.g. "Add 4 notes". */
  label: (args: A) => string;
  /** One-paragraph description; reused as MCP tool documentation. */
  description: string;
  args: z.ZodType<A>;
  /** false = UI-state commands (pattern select, song/pattern mode) skip undo history. */
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
