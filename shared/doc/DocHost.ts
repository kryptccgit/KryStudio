import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import type { Project } from '../schema/project';
import { checkIntegrity } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';
import { newId } from '../schema/ids';
import { getCommand } from '../commands/registry';
import { CommandError, type CommandContext } from '../commands/types';

enablePatches();

export type { Patch };

export type Actor =
  | { kind: 'user' }
  | { kind: 'agent'; clientId: string; name: string }
  | { kind: 'system' };

export const USER: Actor = { kind: 'user' };
export const SYSTEM: Actor = { kind: 'system' };

export function actorKey(a: Actor): string {
  return a.kind === 'agent' ? `agent:${a.clientId}` : a.kind;
}

export function actorName(a: Actor): string {
  return a.kind === 'agent' ? a.name : a.kind === 'user' ? 'You' : 'System';
}

export interface HistoryEntry {
  id: string;
  actor: Actor;
  label: string;
  groupId: string | null;
  coalesceKey?: string;
  patches: Patch[];
  inverse: Patch[];
  time: number;
  undone: boolean;
  undoneSeq: number;
}

export interface HistorySummary {
  id: string;
  actorKey: string;
  actorName: string;
  label: string;
  time: number;
  undone: boolean;
  groupId: string | null;
  changes: number;
}

export interface ExecOptions {
  actor: Actor;
  groupId?: string;
  coalesceKey?: string;
  label?: string;
}

export interface ExecResult<T = unknown> {
  ok: boolean;
  message?: string;
  data?: T;
  version: number;
}

export type ChangeKind = 'exec' | 'undo' | 'redo' | 'revert' | 'reset';

export interface DocChange {
  version: number;
  kind: ChangeKind;
  actor: Actor;
  label: string;
  patches: Patch[];
  project?: Project;
}

export interface DocState {
  project: Project;
  history: HistoryEntry[];
  undoSeq: number;
}

export interface DocHostOptions {
  maxHistory?: number;
  strict?: boolean;
  coalesceWindowMs?: number;
}

function conflictPath(path: (string | number)[]): string[] {
  const out: string[] = [];
  for (const seg of path) {
    if (typeof seg === 'number' || /^\d+$/.test(String(seg)) || seg === 'length') break;
    out.push(String(seg));
  }
  return out;
}

function overlaps(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function touches(entry: HistoryEntry): string[][] {
  return entry.patches.map((p) => conflictPath(p.path));
}

export class DocHost {
  private doc: Project;
  private _version = 0;
  private history: HistoryEntry[] = [];
  private openGroups = new Map<string, { actor: Actor; label: string; entryId: string | null }>();
  private listeners = new Set<(c: DocChange) => void>();
  private undoSeq = 0;
  private coalesceBarrier = false;
  private readonly ctx: CommandContext;
  private readonly opts: Required<DocHostOptions>;

  constructor(project: Project, catalog: PluginCatalog, opts: DocHostOptions = {}) {
    this.doc = project;
    this.ctx = { catalog, newId };
    this.opts = { maxHistory: 500, strict: false, coalesceWindowMs: 1500, ...opts };
  }

  get project(): Project {
    return this.doc;
  }

  get version(): number {
    return this._version;
  }

  get catalog(): PluginCatalog {
    return this.ctx.catalog;
  }

  subscribe(fn: (c: DocChange) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(c: DocChange): void {
    for (const fn of this.listeners) {
      try {
        fn(c);
      } catch {
      }
    }
  }

  reset(project: Project, actor: Actor = SYSTEM): void {
    this.doc = project;
    this.history = [];
    this.openGroups.clear();
    this.coalesceBarrier = true;
    this._version++;
    this.emit({ version: this._version, kind: 'reset', actor, label: 'Load project', patches: [], project });
  }

  exportState(): DocState {
    return { project: this.doc, history: this.history.map((e) => ({ ...e })), undoSeq: this.undoSeq };
  }

  swap(state: DocState, actor: Actor = SYSTEM): void {
    this.doc = state.project;
    this.history = state.history.map((e) => ({ ...e }));
    this.undoSeq = Math.max(this.undoSeq, state.undoSeq);
    this.openGroups.clear();
    this.coalesceBarrier = true;
    this._version++;
    this.emit({ version: this._version, kind: 'reset', actor, label: 'Switch project', patches: [], project: state.project });
  }

  listOpenGroups(): Array<{ id: string; actor: Actor; label: string }> {
    return [...this.openGroups].map(([id, g]) => ({ id, actor: g.actor, label: g.label }));
  }

  exec<T = unknown>(cmdId: string, args: unknown, opts: ExecOptions): ExecResult<T> {
    return this.execBatch<T>([{ cmd: cmdId, args }], opts, true) as ExecResult<T>;
  }

  execBatch<T = unknown>(steps: Array<{ cmd: string; args: unknown }>, opts: ExecOptions, single = false): ExecResult<T | unknown[]> {
    if (steps.length === 0) return { ok: true, data: [], version: this._version };
    const parsed: Array<{ def: NonNullable<ReturnType<typeof getCommand>>; args: unknown }> = [];
    for (const s of steps) {
      const def = getCommand(s.cmd);
      if (!def) return { ok: false, message: `Unknown command "${s.cmd}"`, version: this._version };
      const r = def.args.safeParse(s.args ?? {});
      if (!r.success) {
        const issue = r.error.issues[0];
        const where = issue?.path?.length ? ` at ${issue.path.join('.')}` : '';
        return { ok: false, message: `${s.cmd}: ${issue?.message ?? 'invalid arguments'}${where}`, version: this._version };
      }
      parsed.push({ def, args: r.data });
    }

    const results: unknown[] = [];
    let next: Project;
    let patches: Patch[];
    let inverse: Patch[];
    try {
      [next, patches, inverse] = produceWithPatches(this.doc, (draft) => {
        for (const p of parsed) results.push(p.def.run(draft as Project, p.args, this.ctx));
      });
    } catch (err) {
      const message = err instanceof CommandError ? err.message : `Internal error: ${(err as Error)?.message ?? String(err)}`;
      return { ok: false, message, version: this._version };
    }

    if (this.opts.strict) {
      const errs = checkIntegrity(next);
      if (errs.length) return { ok: false, message: `Integrity check failed: ${errs[0]}`, version: this._version };
    }

    const data = (single ? results[0] : results) as T | unknown[];
    if (patches.length === 0) return { ok: true, data, version: this._version };

    this.doc = next;
    this._version++;
    const recordHistory = parsed.some((p) => p.def.history !== false);
    const label =
      opts.label ?? (parsed.length === 1 ? parsed[0].def.label(parsed[0].args) : `${parsed.length} edits`);
    if (recordHistory) this.record(opts, label, patches, inverse);
    this.emit({ version: this._version, kind: 'exec', actor: opts.actor, label, patches });
    return { ok: true, data, version: this._version };
  }

  private record(opts: ExecOptions, label: string, patches: Patch[], inverse: Patch[]): void {
    const key = actorKey(opts.actor);
    this.history = this.history.filter((e) => !(e.undone && actorKey(e.actor) === key));

    const now = Date.now();
    const barrier = this.coalesceBarrier;
    this.coalesceBarrier = false;
    const group = opts.groupId ? this.openGroups.get(opts.groupId) : undefined;
    const merge = (e: HistoryEntry): void => {
      e.patches = e.patches.concat(patches);
      e.inverse = inverse.concat(e.inverse);
      e.time = now;
    };

    if (group && actorKey(group.actor) === key) {
      const existing = group.entryId ? this.history.find((e) => e.id === group.entryId) : undefined;
      if (existing && !existing.undone) {
        merge(existing);
        return;
      }
      const entry = this.newEntry(opts.actor, group.label, patches, inverse, opts.groupId!, undefined, now);
      group.entryId = entry.id;
      return;
    }

    const last = this.history[this.history.length - 1];
    if (
      opts.coalesceKey &&
      !barrier &&
      last &&
      !last.undone &&
      last.coalesceKey === opts.coalesceKey &&
      actorKey(last.actor) === key &&
      now - last.time < this.opts.coalesceWindowMs
    ) {
      merge(last);
      return;
    }
    this.newEntry(opts.actor, label, patches, inverse, null, opts.coalesceKey, now);
  }

  private newEntry(actor: Actor, label: string, patches: Patch[], inverse: Patch[], groupId: string | null, coalesceKey: string | undefined, time: number): HistoryEntry {
    const entry: HistoryEntry = { id: newId('h'), actor, label, groupId, coalesceKey, patches, inverse, time, undone: false, undoneSeq: 0 };
    this.history.push(entry);
    if (this.history.length > this.opts.maxHistory) this.history.splice(0, this.history.length - this.opts.maxHistory);
    return entry;
  }

  beginGroup(actor: Actor, label: string): string {
    const id = newId('g');
    this.openGroups.set(id, { actor, label, entryId: null });
    return id;
  }

  endGroup(groupId: string): void {
    this.openGroups.delete(groupId);
  }

  private conflictFor(entry: HistoryEntry): HistoryEntry | null {
    const mine = touches(entry);
    const idx = this.history.indexOf(entry);
    for (let i = idx + 1; i < this.history.length; i++) {
      const later = this.history[i];
      if (later.undone) continue;
      const theirs = touches(later);
      if (mine.some((a) => theirs.some((b) => overlaps(a, b)))) return later;
    }
    return null;
  }

  private applyEntry(entry: HistoryEntry, inverse: boolean, kind: ChangeKind, actor: Actor): ExecResult {
    const conflict = this.conflictFor(entry);
    if (conflict) {
      return {
        ok: false,
        message: `Can't ${inverse ? 'undo' : 'redo'} "${entry.label}": ${actorName(conflict.actor)} changed the same thing afterwards ("${conflict.label}"). Undo that first.`,
        version: this._version,
      };
    }
    const patches = inverse ? entry.inverse : entry.patches;
    let next: Project;
    try {
      next = applyPatches(this.doc, patches);
    } catch (err) {
      return { ok: false, message: `Can't ${inverse ? 'undo' : 'redo'} "${entry.label}": ${(err as Error).message}`, version: this._version };
    }
    const before = checkIntegrity(this.doc).length;
    if (checkIntegrity(next).length > before) {
      return { ok: false, message: `Can't ${inverse ? 'undo' : 'redo'} "${entry.label}": it would leave the project inconsistent.`, version: this._version };
    }
    this.doc = next;
    this._version++;
    entry.undone = inverse;
    entry.undoneSeq = inverse ? ++this.undoSeq : 0;
    this.emit({ version: this._version, kind, actor, label: `${inverse ? 'Undo' : 'Redo'}: ${entry.label}`, patches });
    return { ok: true, message: `${inverse ? 'Undid' : 'Redid'} "${entry.label}"`, version: this._version };
  }

  undo(actor: Actor = { kind: 'user' }): ExecResult {
    const key = actorKey(actor);
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i];
      if (!e.undone && actorKey(e.actor) === key) return this.applyEntry(e, true, 'undo', actor);
    }
    return { ok: false, message: 'Nothing to undo', version: this._version };
  }

  redo(actor: Actor = { kind: 'user' }): ExecResult {
    const key = actorKey(actor);
    let best: HistoryEntry | null = null;
    for (const e of this.history) if (e.undone && actorKey(e.actor) === key && (!best || e.undoneSeq > best.undoneSeq)) best = e;
    if (!best) return { ok: false, message: 'Nothing to redo', version: this._version };
    return this.applyEntry(best, false, 'redo', actor);
  }

  toggleEntry(entryId: string, actor: Actor = { kind: 'user' }): ExecResult {
    const e = this.history.find((h) => h.id === entryId);
    if (!e) return { ok: false, message: 'That history entry no longer exists', version: this._version };
    return this.applyEntry(e, !e.undone, 'revert', actor);
  }

  revertActor(target: Actor, by: Actor = { kind: 'user' }): ExecResult {
    const key = actorKey(target);
    let reverted = 0;
    let lastFail: string | undefined;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i];
      if (e.undone || actorKey(e.actor) !== key) continue;
      const r = this.applyEntry(e, true, 'revert', by);
      if (r.ok) reverted++;
      else lastFail = r.message;
    }
    return {
      ok: lastFail === undefined,
      message: lastFail ?? `Reverted ${reverted} edit${reverted === 1 ? '' : 's'}`,
      data: { reverted },
      version: this._version,
    };
  }

  getHistory(): HistorySummary[] {
    return this.history.map((e) => ({
      id: e.id,
      actorKey: actorKey(e.actor),
      actorName: actorName(e.actor),
      label: e.label,
      time: e.time,
      undone: e.undone,
      groupId: e.groupId,
      changes: e.patches.length,
    }));
  }

  canUndo(actor: Actor = { kind: 'user' }): boolean {
    const key = actorKey(actor);
    return this.history.some((e) => !e.undone && actorKey(e.actor) === key);
  }

  canRedo(actor: Actor = { kind: 'user' }): boolean {
    const key = actorKey(actor);
    return this.history.some((e) => e.undone && actorKey(e.actor) === key);
  }
}
