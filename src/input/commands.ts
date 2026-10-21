// ──────────────────────────────────────────────────────────────────────
// App command registry: the same ids drive the keymap, the menu bar and
// hint labels (research/06 §6.1). Document mutations inside a command still
// go through dispatch() — these are UI verbs, not doc commands.
// ──────────────────────────────────────────────────────────────────────

import { toast } from '../app/notify';

export interface AppCommand {
  id: string;
  label: string;
  run: () => unknown;
  enabled?: () => boolean;
}

const registry = new Map<string, AppCommand>();

export function registerCommands(cmds: AppCommand[]): void {
  for (const c of cmds) registry.set(c.id, c);
}

export function getAppCommand(id: string): AppCommand | undefined {
  return registry.get(id);
}

export function listAppCommands(): AppCommand[] {
  return [...registry.values()];
}

/** Run a command; failures become toasts, never silent. Returns false if unknown/disabled. */
export function runCommand(id: string): boolean {
  const c = registry.get(id);
  if (!c) {
    console.warn(`[commands] unknown command ${id}`);
    return false;
  }
  if (c.enabled && !c.enabled()) return false;
  try {
    const r = c.run();
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      (r as Promise<unknown>).catch((err) => toast.error(`${c.label} failed: ${(err as Error)?.message ?? String(err)}`));
    }
  } catch (err) {
    toast.error(`${c.label} failed: ${(err as Error)?.message ?? String(err)}`);
  }
  return true;
}
