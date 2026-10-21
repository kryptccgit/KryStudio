// ──────────────────────────────────────────────────────────────────────
// Renderer-side READ REPLICA of the project document.
// Truth lives in Electron main (DocHost). We hold a copy, kept in sync by
// applying the exact Immer patches main broadcasts. Every mutation goes
// through dispatch() → window.krypt.doc.exec → DocHost → patches come back.
//
// Usage:
//   const bpm = useProject((p) => p.transport.bpm);
//   const ids = useProject((p) => p.channelOrder);          // stable ref, fine
//   const pair = useProject(useShallow((p) => [p.a, p.b])); // NEW objects → useShallow!
//   await dispatch('notes.add', {...});
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { applyPatches, enablePatches } from 'immer';
import type { Project } from '@shared/schema/project';
import type { ExecResult } from '@shared/doc/DocHost';
import type { DocPatchMessage, ExecOpts } from '@shared/types';

enablePatches();

interface DocState {
  project: Project | null;
  version: number;
  ready: boolean;
  /** Last change summary (for status bar / agent activity flashes). */
  lastChange: { label: string; actorKind: string; actorName: string; time: number } | null;
}

export const useDocStore = create<DocState>(() => ({ project: null, version: 0, ready: false, lastChange: null }));

let started = false;
let resyncing = false;

async function resync(): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    const snap = await window.krypt.doc.snapshot();
    useDocStore.setState({ project: snap.project, version: snap.version, ready: true });
  } finally {
    resyncing = false;
  }
}

function onPatches(m: DocPatchMessage): void {
  const s = useDocStore.getState();
  if (!s.project || m.version !== s.version + 1) {
    void resync();
    return;
  }
  try {
    const project = applyPatches(s.project, m.patches);
    const actorName = m.actor.kind === 'agent' ? m.actor.name : m.actor.kind === 'user' ? 'You' : 'System';
    useDocStore.setState({ project, version: m.version, lastChange: { label: m.label, actorKind: m.actor.kind, actorName, time: Date.now() } });
  } catch {
    void resync();
  }
}

/** Start syncing (idempotent). Call once at app start; returns when the first snapshot is in. */
export async function startDocSync(): Promise<void> {
  if (started) return;
  started = true;
  window.krypt.doc.onPatches(onPatches);
  window.krypt.doc.onReset((m) => useDocStore.setState({ project: m.project, version: m.version, ready: true, lastChange: null }));
  await resync();
}

/** Select from the project. Only call under a component tree gated on `ready`. */
export function useProject<T>(selector: (p: Project) => T): T {
  return useDocStore((s) => selector(s.project as Project));
}

/** Imperative read (event handlers, canvas painters). */
export function getProject(): Project {
  return useDocStore.getState().project as Project;
}

type ErrorHandler = (cmd: string, message: string) => void;
let errorHandler: ErrorHandler = (cmd, message) => console.warn(`[dispatch] ${cmd}: ${message}`);

/** The app shell installs a toast-based handler so no failure is ever silent. */
export function setDispatchErrorHandler(fn: ErrorHandler): void {
  errorHandler = fn;
}

/** Run a document command (the only way the UI mutates the project). */
export async function dispatch<T = unknown>(cmd: string, args: unknown, opts?: ExecOpts & { silent?: boolean }): Promise<ExecResult<T>> {
  let r: ExecResult<T>;
  try {
    r = await window.krypt.doc.exec<T>(cmd, args, opts);
  } catch (err) {
    r = { ok: false, message: (err as Error)?.message ?? String(err), version: useDocStore.getState().version };
  }
  if (!r.ok && !opts?.silent) errorHandler(cmd, r.message ?? 'Failed');
  return r;
}

export async function dispatchBatch(steps: Array<{ cmd: string; args: unknown }>, opts?: ExecOpts): Promise<ExecResult<unknown[]>> {
  const r = await window.krypt.doc.execBatch(steps, opts);
  if (!r.ok) errorHandler(steps.map((s) => s.cmd).join('+'), r.message ?? 'Failed');
  return r;
}

/** Wrap a multi-step gesture (drag, paint) into ONE undo step. */
export async function withGroup<T>(label: string, fn: (groupId: string) => Promise<T>): Promise<T> {
  const groupId = await window.krypt.doc.beginGroup(label);
  try {
    return await fn(groupId);
  } finally {
    await window.krypt.doc.endGroup(groupId);
  }
}
