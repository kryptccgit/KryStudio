// ──────────────────────────────────────────────────────────────────────
// Project tabs (research/19-project-tabs.md): several projects open at
// once, like browser tabs. There is still ONE DocHost (every main service
// keeps its reference); the TabManager keeps each INACTIVE tab's state:
//   project + undo/redo history (DocHost.exportState), and ProjectService's
//   per-project fields: path, dirty, lastSavedAt, recovered, cover assets
//   (ProjectService.capture → TabState).
// A switch = capture the active tab → DocHost.swap(target) (a 'reset' change
// that keeps the target's history, so the renderer replaces its replica and
// the engine reloads, exactly like opening a file) → stop the transport.
// Every switch is ONE synchronous step: files are read before it starts.
//
// Guards: a switch away from the active tab is refused (human message, the
// tab's `busy` shows why) while an agent's edit group is open or the built-in
// agent is working, a take is recording, or a long job (Audio → Project, a
// render, Auto Mashup via addGuard) runs. Main-side callers whose own job is
// making the new project (Audio → Project, agents' templates) use the
// unguarded openProjectInNewTab / newProjectTab.
//
// Session (userData/session/, atomic writes):
//   tabs.json          order, active tab, titles, paths, dirty flags
//   tab-<id>.kstudio   every tab that is dirty or was never saved (the
//                      container + its cover). Written when a tab is switched
//                      away from (before the recovery snapshot replaces the
//                      old one), on every tab change, on the autosave cadence
//                      for the active tab, and on quit.
// Restore on launch: the active tab first, the others lazily on their first
// activation; a dirty tab stays dirty; a missing file becomes a tab that says
// so. Crash recovery (recovery.ts) follows the ACTIVE tab and records its id;
// after a crash its (fresher) project goes to that tab. Undo history is not
// kept across restarts.
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import fsp from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import { actorName, type DocHost } from '@shared/doc/DocHost';
import type { Project } from '@shared/schema/project';
import type { ProjectTemplate } from '@shared/templates';
import type { ActionResult, ProjectTab, TabsState } from '@shared/types';
import { encodeContainer } from './container';
import type { LoadedProject, ProjectService, TabState, TabsHook } from './service';
import type { RecoveredSession } from './recovery';
import { ensureDir, isFile, readText, removeFile, writeFileAtomic } from '../system/files';

/** Why the active tab can't be left right now: `busy` for the tab strip, `message` for the toast. */
export interface TabGuardHit {
  busy: string;
  message: string;
}

/** A switch guard: looks at the ACTIVE tab (its title for messages). */
export type TabGuard = (ctx: { title: string }) => TabGuardHit | null;

export type TabsProject = Pick<
  ProjectService,
  | 'status'
  | 'capture'
  | 'activate'
  | 'applyLoaded'
  | 'adoptRecovered'
  | 'resetToNew'
  | 'readProjectFile'
  | 'readSessionSnapshot'
  | 'readTemplate'
  | 'pickProjectFile'
  | 'save'
  | 'setTabId'
  | 'holdRecoveryUntil'
  | 'onAutosave'
  | 'onStatus'
  | 'attachTabs'
  | 'shutdown'
  | 'assets'
>;

export interface TabManagerDeps {
  doc: DocHost;
  project: TabsProject;
  /** userData/session */
  sessionDir: string;
  appVersion: string;
  /** Stop playback (a switch stops the transport). */
  stopTransport(): void;
  /** EVENT.tabsState to every window. */
  broadcast(s: TabsState): void;
  log(level: 'info' | 'warn' | 'error', m: string): void;
  guards?: TabGuard[];
  /** Before an interactive switch (third-party plugin states into the document). */
  beforeSwitch?(): Promise<void>;
  /** Recently closed tabs kept for reopenClosed (default 10). */
  maxClosed?: number;
  /** Re-check `busy` this often (ms; 0 = never; default 1000). */
  busyPollMs?: number;
}

/** Where an inactive tab that isn't in memory yet comes from. */
type Source =
  | { kind: 'file' }
  | { kind: 'snapshot'; file: string }
  | { kind: 'recovered'; session: RecoveredSession }
  | { kind: 'new' }
  | { kind: 'missing'; message: string };

interface TabRec {
  id: string;
  path: string | null;
  /** ProjectStatus.name when last active (file name, or the song title for untitled projects). */
  name: string;
  dirty: boolean;
  /** n of "Untitled n" (a tab without a path). */
  untitled: number;
  /** In memory while inactive. */
  state: TabState | null;
  /** Not loaded yet (session restore) or failed to load. */
  pending: Source | null;
  /** DocHost version right after it was made as a blank new project; null once anything else happened. */
  untouchedAt: number | null;
  /** Its session file holds its current (inactive) state. */
  snapshotWritten: boolean;
}

interface SessionEntry {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
  untitled: number;
  snapshot: string | null;
}

interface SessionFile {
  format: 'krypt-studio-tabs';
  version: 1;
  savedAt: string;
  activeId: string;
  tabs: SessionEntry[];
}

const TABS_FILE = 'tabs.json';
const SNAPSHOT_RE = /^tab-([A-Za-z0-9_-]{1,64})\.kstudio$/;

const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const baseName = (p: string): string => path.basename(p).replace(/\.kstudio$/i, '');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let seq = 0;
const newTabId = (): string => `t${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class TabManager implements TabsHook {
  private tabs: TabRec[] = [];
  private activeId = '';
  private closed: Array<{ rec: TabRec; index: number }> = [];
  private readonly guards: TabGuard[];
  private sessionChain: Promise<unknown> = Promise.resolve();
  private lastStateKey = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** >0 while a tab's content is going in: status echoes from the project service are not about the old tab. */
  private switching = 0;
  /** activeId from tabs.json (restore). */
  private sessionActiveId: string | null = null;
  private offs: Array<() => void> = [];

  constructor(private readonly d: TabManagerDeps) {
    this.guards = [...(d.guards ?? [])];
    // Until boot()/restore() runs, the open project is one untouched new tab.
    const first = this.makeRec({ untitled: 1 });
    first.untouchedAt = d.doc.version;
    this.tabs.push(first);
    this.activeId = first.id;
    d.project.setTabId(first.id);
    d.project.attachTabs(this);
    this.offs.push(
      d.project.onStatus(() => {
        if (this.switching) return;
        this.emitState();
        this.scheduleSave();
      }),
      d.project.onAutosave(() => void this.saveSession({ active: true })),
    );
    const every = d.busyPollMs ?? 1000;
    if (every > 0) {
      this.pollTimer = setInterval(() => this.emitState(), every);
      this.pollTimer.unref?.();
    }
  }

  /** Auto Mashup and other long jobs: refuse switches while `guard` says so. */
  addGuard(guard: TabGuard): () => void {
    this.guards.push(guard);
    return () => {
      const i = this.guards.indexOf(guard);
      if (i >= 0) this.guards.splice(i, 1);
    };
  }

  // ── State ───────────────────────────────────────────────────────────

  private makeRec(o: Partial<TabRec> = {}): TabRec {
    return { id: newTabId(), path: null, name: 'Untitled', dirty: false, untitled: 0, state: null, pending: null, untouchedAt: null, snapshotWritten: false, ...o };
  }

  private active(): TabRec {
    return this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[0];
  }

  /** Copy the active tab's live fields from the project service. */
  private syncActive(): TabRec {
    const rec = this.active();
    const s = this.d.project.status();
    rec.path = s.path;
    rec.name = s.name;
    rec.dirty = s.dirty;
    if (rec.untouchedAt !== null && (rec.untouchedAt !== this.d.doc.version || s.path)) rec.untouchedAt = null;
    return rec;
  }

  private titleOf(rec: TabRec): string {
    const base = rec.path ? baseName(rec.path) : rec.name && rec.name !== 'Untitled' ? rec.name : rec.untitled > 1 ? `Untitled ${rec.untitled}` : 'Untitled';
    return rec.pending?.kind === 'missing' ? `${base} (missing)` : base;
  }

  /** The active tab's title (window title, Discord presence). */
  activeTitle(): string {
    return this.titleOf(this.syncActive());
  }

  private nextUntitled(except?: TabRec): number {
    const used = new Set(this.tabs.filter((t) => t !== except && !t.path).map((t) => t.untitled));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private guardHit(): TabGuardHit | null {
    const title = this.titleOf(this.syncActive());
    // An agent's call or begin_edit group is open on the active project.
    const g = this.d.doc.listOpenGroups().find((x) => x.actor.kind === 'agent');
    if (g) {
      const who = actorName(g.actor);
      return { busy: `${who} is editing`, message: `An agent (${who}) is editing "${title}": wait for it or stop it in the Agents panel.` };
    }
    for (const guard of this.guards) {
      try {
        const hit = guard({ title });
        if (hit) return hit;
      } catch (err) {
        this.d.log('warn', `A tab switch guard failed: ${errText(err)}`);
      }
    }
    return null;
  }

  state(): TabsState {
    const active = this.syncActive();
    const busy = this.guardHit()?.busy;
    const tabs: ProjectTab[] = this.tabs.map((t) => ({
      id: t.id,
      title: this.titleOf(t),
      path: t.path,
      dirty: t.dirty,
      ...(t === active && busy ? { busy } : {}),
    }));
    return {
      tabs,
      activeId: active.id,
      closed: this.closed.map((c) => ({ id: c.rec.id, title: this.titleOf(c.rec), path: c.rec.path })),
    };
  }

  /** One line for get_project: the open tabs, the active one marked. */
  summaryLine(): string {
    const s = this.state();
    const items = s.tabs.map((t) => `"${t.title}"${t.dirty ? ' (unsaved)' : ''}${t.id === s.activeId ? ' ← active' : ''}`);
    return `Open tabs (${s.tabs.length}): ${items.join(', ')}. Agents work on the active tab only.`;
  }

  private emitState(): void {
    if (this.stopped) return;
    let s: TabsState;
    try {
      s = this.state();
    } catch (err) {
      this.d.log('warn', `Tab state failed: ${errText(err)}`);
      return;
    }
    const key = JSON.stringify(s);
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    try {
      this.d.broadcast(s);
    } catch {
      /* no window */
    }
  }

  /** After every tab change: tell the windows, keep the session file in step. */
  private changed(): void {
    this.emitState();
    void this.saveSession();
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveSession();
    }, 500);
    this.saveTimer.unref?.();
  }

  private findByPath(p: string): TabRec | undefined {
    this.syncActive();
    const n = norm(p);
    return this.tabs.find((t) => t.path && norm(t.path) === n);
  }

  // ── The switch (synchronous) ────────────────────────────────────────

  /**
   * Keep the active tab's state in memory and write its session file; the next recovery snapshot waits for that
   * file, so its unsaved work is on disk at every moment. Stops playback.
   */
  private stashActive(): TabRec {
    const rec = this.syncActive();
    rec.state = this.d.project.capture();
    rec.untouchedAt = null;
    rec.snapshotWritten = false;
    this.d.project.holdRecoveryUntil(this.writeTabSnapshot(rec));
    try {
      this.d.stopTransport();
    } catch {
      /* the engine may be gone */
    }
    return rec;
  }

  /** Put a tab's content in the DocHost (it becomes the active tab). `loaded` = what readPending returned. */
  private bringIn(rec: TabRec, loaded: LoadedProject | null): ActionResult {
    const before = this.activeId;
    this.activeId = rec.id;
    this.d.project.setTabId(rec.id);
    let r: ActionResult = { ok: true };
    this.switching++;
    try {
      if (rec.state) {
        this.d.project.activate(rec.state);
        rec.state = null;
      } else if (rec.pending?.kind === 'recovered') {
        this.d.project.adoptRecovered(rec.pending.session);
      } else if (loaded) {
        r = this.d.project.applyLoaded(loaded);
      } else {
        r = this.d.project.resetToNew();
        if (r.ok) rec.untouchedAt = this.d.doc.version;
      }
    } catch (err) {
      r = { ok: false, message: `Couldn't open the tab: ${errText(err)}` };
    } finally {
      this.switching--;
    }
    if (r.ok) {
      rec.pending = null;
      rec.snapshotWritten = false;
      this.syncActive();
    } else {
      this.activeId = before;
      this.d.project.setTabId(before);
    }
    return r;
  }

  /** Undo a stash when bringing the target in failed (rare: the read already succeeded). */
  private rollback(prev: TabRec): void {
    if (!prev.state) return;
    this.activeId = prev.id;
    this.d.project.setTabId(prev.id);
    this.switching++;
    try {
      this.d.project.activate(prev.state);
    } finally {
      this.switching--;
    }
    prev.state = null;
  }

  /** Read an unloaded tab's content (no state change). null data = a blank new project / recovered session. */
  private async readPending(rec: TabRec): Promise<ActionResult<LoadedProject | null>> {
    const src = rec.pending;
    if (!src || src.kind === 'new' || src.kind === 'recovered') return { ok: true, data: null };
    if (src.kind === 'snapshot') {
      const r = await this.d.project.readSessionSnapshot(src.file, { path: rec.path, dirty: rec.dirty });
      if (r.ok) return r;
      if (rec.path && isFile(rec.path)) {
        this.d.log('warn', `Tab "${this.titleOf(rec)}": its unsaved changes couldn't be read (${r.message}); opening the saved file`);
        return this.d.project.readProjectFile(rec.path);
      }
      return r;
    }
    if (!rec.path) return { ok: false, message: src.kind === 'missing' ? src.message : 'This tab has nothing to open.' };
    if (!isFile(rec.path)) return { ok: false, message: `"${baseName(rec.path)}" isn't at ${rec.path} any more. Put the file back, or close this tab.` };
    return this.d.project.readProjectFile(rec.path);
  }

  // ── Operations (window.krypt.tabs) ──────────────────────────────────

  async switchTo(id: string): Promise<ActionResult> {
    const rec = this.tabs.find((t) => t.id === id);
    if (!rec) return { ok: false, message: "That tab isn't open any more" };
    if (rec.id === this.activeId) return { ok: true, message: `"${this.titleOf(rec)}" is already open` };
    const early = this.guardHit();
    if (early) return { ok: false, message: early.message };
    await this.beforeSwitch();
    let loaded: LoadedProject | null = null;
    if (rec.pending) {
      const r = await this.readPending(rec);
      if (!r.ok) {
        rec.pending = { kind: 'missing', message: r.message ?? "It couldn't be opened." };
        this.changed();
        return { ok: false, message: r.message };
      }
      loaded = r.data ?? null;
    }
    return this.switchNow(rec, loaded);
  }

  private switchNow(rec: TabRec, loaded: LoadedProject | null): ActionResult {
    if (!this.tabs.includes(rec)) return { ok: false, message: "That tab isn't open any more" };
    if (rec.id === this.activeId) return { ok: true, message: `"${this.titleOf(rec)}" is already open` };
    const hit = this.guardHit();
    if (hit) return { ok: false, message: hit.message };
    const prev = this.stashActive();
    const r = this.bringIn(rec, loaded);
    if (!r.ok) {
      this.rollback(prev);
      this.changed();
      return { ok: false, message: r.message };
    }
    this.changed();
    return { ok: true, message: loaded ? r.message : `Switched to "${this.titleOf(rec)}"` };
  }

  private async beforeSwitch(): Promise<void> {
    if (!this.d.beforeSwitch) return;
    try {
      await this.d.beforeSwitch();
    } catch (err) {
      this.d.log('warn', `Before switching tabs: ${errText(err)}`);
    }
  }

  /** A new tab (fresh project, or from a template id / name), made active. */
  async newTab(opts: { template?: string } = {}, how: { internal?: boolean } = {}): Promise<ActionResult<{ id: string; template?: ProjectTemplate }>> {
    const template = typeof opts?.template === 'string' && opts.template.trim() ? opts.template : null;
    if (!how.internal) {
      const early = this.guardHit();
      if (early) return { ok: false, message: early.message };
      await this.beforeSwitch();
    }
    if (!template) return this.newBlankTab(how);
    const t = await this.d.project.readTemplate(template);
    if (!t.ok || !t.data) return { ok: false, message: t.message };
    const r = this.openLoaded(t.data.loaded, how);
    return r.ok && r.data ? { ...r, data: { id: r.data.id, template: t.data.template } } : { ok: false, message: r.message };
  }

  /** A new tab with a fresh default project (synchronous). */
  newBlankTab(how: { internal?: boolean } = {}): ActionResult<{ id: string }> {
    if (!how.internal) {
      const hit = this.guardHit();
      if (hit) return { ok: false, message: hit.message };
    }
    const prev = this.stashActive();
    const rec = this.makeRec({ untitled: this.nextUntitled() });
    this.tabs.splice(this.tabs.indexOf(prev) + 1, 0, rec);
    const r = this.bringIn(rec, null);
    if (!r.ok) {
      this.tabs.splice(this.tabs.indexOf(rec), 1);
      this.rollback(prev);
      this.changed();
      return { ok: false, message: r.message };
    }
    this.changed();
    return { ok: true, message: 'New project', data: { id: rec.id } };
  }

  /** Put an already-read project in a NEW tab next to the active one. */
  private openLoaded(loaded: LoadedProject, how: { internal?: boolean } = {}): ActionResult<{ id: string }> {
    if (!how.internal) {
      const hit = this.guardHit();
      if (hit) return { ok: false, message: hit.message };
    }
    const prev = this.stashActive();
    const rec = this.makeRec({ path: loaded.filePath, untitled: loaded.filePath ? 0 : this.nextUntitled() });
    this.tabs.splice(this.tabs.indexOf(prev) + 1, 0, rec);
    const r = this.bringIn(rec, loaded);
    if (!r.ok) {
      this.tabs.splice(this.tabs.indexOf(rec), 1);
      this.rollback(prev);
      this.changed();
      return { ok: false, message: r.message };
    }
    this.changed();
    return { ok: true, message: r.message, data: { id: rec.id } };
  }

  /**
   * Main-side: a project built in memory (Auto Mashup) opens in a NEW tab, unsaved, history empty. No switch
   * guards: the caller's own job is what makes it. Then build on it with doc.exec as usual (it is the active tab).
   */
  openProjectInNewTab(project: Project, name?: string): ActionResult<{ id: string }> {
    const p: Project = name ? { ...project, meta: { ...project.meta, name: name.slice(0, 120) } } : project;
    return this.openLoaded({ project: p, assets: {}, filePath: null, dirty: true, recent: null, head: `Opened "${p.meta.name || 'Untitled'}" in a new tab`, how: 'Opened', notes: [] }, { internal: true });
  }

  // TabsHook (ProjectService.newProject / newFromTemplate / open route here)

  newProjectTab(): ActionResult {
    return this.newBlankTab({ internal: true });
  }

  async newTemplateTab(ref: string): Promise<ActionResult<{ template: ProjectTemplate }>> {
    const r = await this.newTab({ template: ref }, { internal: true });
    return r.ok && r.data?.template ? { ok: true, message: r.message, data: { template: r.data.template } } : { ok: false, message: r.message };
  }

  /**
   * File ▸ Open / Home / Recent: a NEW tab, unless the active tab is an untouched new project (then it is
   * replaced); an already-open file just activates its tab.
   */
  async open(p?: string, win?: BrowserWindow | null): Promise<ActionResult<{ id: string }>> {
    const early = this.guardHit();
    if (early) return { ok: false, message: early.message };
    const target = typeof p === 'string' && p ? p : await this.d.project.pickProjectFile(win);
    if (!target) return { ok: false, message: 'Open cancelled' };
    const open = this.findByPath(target);
    if (open) {
      if (open.id === this.activeId) return { ok: true, message: `"${this.titleOf(open)}" is already open`, data: { id: open.id } };
      const r = await this.switchTo(open.id);
      return r.ok ? { ok: true, message: `"${this.titleOf(open)}" is already open: switched to its tab`, data: { id: open.id } } : { ok: false, message: r.message };
    }
    await this.beforeSwitch();
    const read = await this.d.project.readProjectFile(target);
    if (!read.ok || !read.data) return { ok: false, message: read.message };
    // Re-check after the read: the same file may have opened meanwhile.
    const again = this.findByPath(target);
    if (again) return again.id === this.activeId ? { ok: true, message: `"${this.titleOf(again)}" is already open`, data: { id: again.id } } : { ...this.switchNow(again, null), data: { id: again.id } };
    const active = this.syncActive();
    if (active.untouchedAt !== null) {
      const hit = this.guardHit();
      if (hit) return { ok: false, message: hit.message };
      try {
        this.d.stopTransport();
      } catch {
        /* the engine may be gone */
      }
      this.switching++;
      let r: ActionResult;
      try {
        r = this.d.project.applyLoaded(read.data);
      } finally {
        this.switching--;
      }
      active.untouchedAt = null;
      if (r.ok && read.data.filePath) active.untitled = 0;
      this.syncActive();
      this.changed();
      return r.ok ? { ok: true, message: r.message, data: { id: active.id } } : { ok: false, message: r.message };
    }
    return this.openLoaded(read.data);
  }

  /**
   * Close a tab. Unsaved changes need a decision ({needsDecision:true} without one); 'save' saves it first (the
   * Save-as dialog for an untitled project; an inactive tab is activated to save it). The last tab leaves a
   * fresh Untitled tab. A closed tab is kept (with its state) for reopenClosed.
   */
  async close(id: string, decision?: 'save' | 'discard', win?: BrowserWindow | null): Promise<ActionResult<{ needsDecision?: boolean }>> {
    const rec = this.tabs.find((t) => t.id === id);
    if (!rec) return { ok: false, message: "That tab isn't open any more" };
    if (rec.id === this.activeId) this.syncActive();
    const title = this.titleOf(rec);
    if (rec.dirty && decision !== 'save' && decision !== 'discard') {
      return { ok: false, message: `"${title}" has unsaved changes`, data: { needsDecision: true } };
    }
    if (rec.id === this.activeId) {
      const hit = this.guardHit();
      if (hit) return { ok: false, message: hit.message };
    }
    if (rec.dirty && decision === 'save') {
      if (rec.id !== this.activeId) {
        const s = await this.switchTo(rec.id);
        if (!s.ok) return { ok: false, message: s.message };
      }
      const saved = await this.d.project.save(win);
      if (!saved.ok) return { ok: false, message: saved.message };
    }
    if (rec.id !== this.activeId) {
      this.tabs.splice(this.tabs.indexOf(rec), 1);
      this.remember(rec, this.tabs.length);
      this.changed();
      return { ok: true, message: `Closed "${title}"` };
    }
    return this.closeActive(rec, title);
  }

  private async closeActive(rec: TabRec, title: string): Promise<ActionResult<{ needsDecision?: boolean }>> {
    // The neighbour to show instead: right, else left; a fresh Untitled tab when it was the last one.
    const idx = this.tabs.indexOf(rec);
    const order = [...this.tabs.slice(idx + 1), ...this.tabs.slice(0, idx).reverse()];
    let next: TabRec | null = null;
    let loaded: LoadedProject | null = null;
    if (order.length) await this.beforeSwitch();
    for (const cand of order) {
      if (!cand.pending) {
        next = cand;
        break;
      }
      const r = await this.readPending(cand);
      if (r.ok) {
        next = cand;
        loaded = r.data ?? null;
        break;
      }
      cand.pending = { kind: 'missing', message: r.message ?? "It couldn't be opened." };
    }
    if (!this.tabs.includes(rec) || rec.id !== this.activeId) return { ok: false, message: 'The tabs changed meanwhile; try again' };
    const hit = this.guardHit();
    if (hit) return { ok: false, message: hit.message };
    // Keep the closed tab's state in memory (reopenClosed), without a session file: it was closed.
    this.syncActive();
    rec.state = this.d.project.capture();
    rec.untouchedAt = null;
    try {
      this.d.stopTransport();
    } catch {
      /* the engine may be gone */
    }
    const at = this.tabs.indexOf(rec);
    this.tabs.splice(at, 1);
    let target = next;
    if (!target) {
      target = this.makeRec({ untitled: this.nextUntitled() });
      this.tabs.splice(Math.min(at, this.tabs.length), 0, target);
    }
    const r = this.bringIn(target, loaded);
    if (!r.ok) {
      // Fall back to a fresh Untitled tab: there is always an active tab.
      this.d.log('warn', `Closing "${title}": ${r.message}`);
      if (target !== next) this.tabs.splice(this.tabs.indexOf(target), 1);
      const blank = this.makeRec({ untitled: this.nextUntitled() });
      this.tabs.splice(Math.min(at, this.tabs.length), 0, blank);
      this.bringIn(blank, null);
    }
    this.remember(rec, at);
    this.changed();
    return { ok: true, message: `Closed "${title}"` };
  }

  private remember(rec: TabRec, index: number): void {
    this.closed.unshift({ rec, index });
    const max = this.d.maxClosed ?? 10;
    if (this.closed.length > max) this.closed.length = max;
  }

  move(id: string, toIndex: number): ActionResult {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return { ok: false, message: "That tab isn't open any more" };
    const to = Math.max(0, Math.min(this.tabs.length - 1, Math.trunc(Number(toIndex) || 0)));
    if (to === from) return { ok: true, message: 'No change' };
    const [rec] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, rec);
    this.changed();
    return { ok: true, message: `Moved "${this.titleOf(rec)}"` };
  }

  /** Reopen the most recently closed tab (with its unsaved state, kept for this session) and activate it. */
  async reopenClosed(): Promise<ActionResult<{ id: string }>> {
    const item = this.closed[0];
    if (!item) return { ok: false, message: 'No closed tab to reopen' };
    const rec = item.rec;
    if (rec.path) {
      const open = this.findByPath(rec.path);
      if (open) {
        this.closed.shift();
        const r = open.id === this.activeId ? { ok: true } : await this.switchTo(open.id);
        this.changed();
        return r.ok ? { ok: true, message: `"${this.titleOf(open)}" is already open`, data: { id: open.id } } : { ok: false, message: r.message };
      }
    }
    const early = this.guardHit();
    if (early) return { ok: false, message: early.message };
    await this.beforeSwitch();
    let loaded: LoadedProject | null = null;
    if (!rec.state && rec.pending) {
      const r = await this.readPending(rec);
      if (!r.ok) return { ok: false, message: r.message };
      loaded = r.data ?? null;
    }
    if (this.closed[0] !== item) return { ok: false, message: 'The tabs changed meanwhile; try again' };
    const hit = this.guardHit();
    if (hit) return { ok: false, message: hit.message };
    this.closed.shift();
    if (!rec.path && this.tabs.some((t) => !t.path && t.untitled === rec.untitled)) rec.untitled = this.nextUntitled();
    const prev = this.stashActive();
    this.tabs.splice(Math.min(item.index, this.tabs.length), 0, rec);
    const r = this.bringIn(rec, loaded);
    if (!r.ok) {
      this.tabs.splice(this.tabs.indexOf(rec), 1);
      this.rollback(prev);
      this.changed();
      return { ok: false, message: r.message };
    }
    this.changed();
    return { ok: true, message: `Reopened "${this.titleOf(rec)}"`, data: { id: rec.id } };
  }

  // ── Session files ───────────────────────────────────────────────────

  private snapshotName(rec: TabRec): string {
    return `tab-${rec.id}.kstudio`;
  }

  /** Write an inactive tab's session file when it needs one (dirty or never saved). Never rejects. */
  private writeTabSnapshot(rec: TabRec): Promise<void> {
    const st = rec.state;
    if (!st || (!st.dirty && st.filePath)) {
      rec.snapshotWritten = !!st;
      return Promise.resolve();
    }
    let bytes: Uint8Array;
    try {
      const assets: Record<string, Uint8Array> = {};
      const cover = st.doc.project.meta.cover?.file;
      const a = cover ? st.assets.find((x) => x.file === cover) : undefined;
      if (a) assets[a.file] = a.bytes;
      bytes = encodeContainer(st.doc.project, this.d.appVersion, { tab: { id: rec.id, path: st.filePath, dirty: st.dirty } }, assets);
    } catch (err) {
      this.d.log('error', `Couldn't keep the unsaved tab "${this.titleOf(rec)}" for next time: ${errText(err)}`);
      return Promise.resolve();
    }
    const file = path.join(this.d.sessionDir, this.snapshotName(rec));
    const job = this.sessionChain.then(async () => {
      try {
        await writeFileAtomic(file, bytes);
        if (rec.state === st) rec.snapshotWritten = true;
      } catch (err) {
        this.d.log('error', `Couldn't keep the unsaved tab "${this.titleOf(rec)}" for next time: ${errText(err)}`);
      }
    });
    this.sessionChain = job;
    return job;
  }

  /**
   * Write tabs.json (+ the session files still missing; with `active`, the active tab's too when it is dirty or
   * untitled) and delete session files nothing needs. Serialized; never rejects.
   */
  saveSession(opts: { active?: boolean } = {}): Promise<ActionResult> {
    const active = this.syncActive();
    const dir = this.d.sessionDir;
    for (const t of this.tabs) if (t.state && !t.snapshotWritten) void this.writeTabSnapshot(t);
    let activeBytes: Uint8Array | null = null;
    const activeNeeds = active.dirty || !active.path;
    if (opts.active && activeNeeds) {
      try {
        const project = this.d.doc.project;
        activeBytes = encodeContainer(project, this.d.appVersion, { tab: { id: active.id, path: active.path, dirty: active.dirty } }, this.d.project.assets.entriesFor(project));
      } catch (err) {
        this.d.log('error', `Couldn't keep the open project for next time: ${errText(err)}`);
      }
    }
    const entries: SessionEntry[] = this.tabs.map((t) => {
      let snapshot: string | null = null;
      if (t === active) {
        snapshot = activeNeeds && (activeBytes || isFile(path.join(dir, this.snapshotName(t)))) ? this.snapshotName(t) : null;
      } else if (t.state) {
        snapshot = t.state.dirty || !t.state.filePath ? this.snapshotName(t) : null;
      } else if (t.pending?.kind === 'snapshot') {
        snapshot = path.basename(t.pending.file);
      }
      return { id: t.id, path: t.path, name: t.name, dirty: t.dirty, untitled: t.untitled, snapshot };
    });
    const keep = new Set(entries.map((e) => e.snapshot).filter((x): x is string => !!x));
    for (const c of this.closed) if (c.rec.pending?.kind === 'snapshot') keep.add(path.basename(c.rec.pending.file));
    const file: SessionFile = { format: 'krypt-studio-tabs', version: 1, savedAt: new Date().toISOString(), activeId: active.id, tabs: entries };
    const job = this.sessionChain.then(async (): Promise<ActionResult> => {
      try {
        ensureDir(dir);
        if (activeBytes) await writeFileAtomic(path.join(dir, this.snapshotName(active)), activeBytes);
        await writeFileAtomic(path.join(dir, TABS_FILE), JSON.stringify(file, null, 2));
      } catch (err) {
        this.d.log('error', `Couldn't save the open tabs for next time: ${errText(err)}`);
        return { ok: false, message: `Couldn't save the open tabs: ${errText(err)}` };
      }
      try {
        for (const name of await fsp.readdir(dir)) {
          if (SNAPSHOT_RE.test(name) && !keep.has(name)) await removeFile(path.join(dir, name)).catch(() => {});
        }
      } catch {
        /* cleanup is best effort */
      }
      return { ok: true, message: `Kept ${entries.length} open tab${entries.length === 1 ? '' : 's'}` };
    });
    this.sessionChain = job.catch(() => {});
    return job;
  }

  private async readSessionFile(): Promise<SessionEntry[] | null> {
    const text = await readText(path.join(this.d.sessionDir, TABS_FILE));
    if (!text) return null;
    try {
      const raw = JSON.parse(text) as Partial<SessionFile>;
      if (raw.format !== 'krypt-studio-tabs' || !Array.isArray(raw.tabs)) throw new Error('not a tabs file');
      const out: SessionEntry[] = [];
      const ids = new Set<string>();
      for (const t of raw.tabs) {
        if (!t || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.id) || ids.has(t.id)) continue;
        ids.add(t.id);
        const snapshot = typeof t.snapshot === 'string' && SNAPSHOT_RE.test(t.snapshot) ? t.snapshot : null;
        out.push({
          id: t.id,
          path: typeof t.path === 'string' && t.path ? t.path : null,
          name: typeof t.name === 'string' && t.name ? t.name.slice(0, 200) : 'Untitled',
          dirty: t.dirty === true,
          untitled: Number.isInteger(t.untitled) && t.untitled > 0 ? t.untitled : 0,
          snapshot,
        });
      }
      this.sessionActiveId = typeof raw.activeId === 'string' ? raw.activeId : null;
      return out;
    } catch (err) {
      this.d.log('warn', `The saved tab list is unreadable (${errText(err)}); starting with one tab`);
      return null;
    }
  }

  /**
   * Launch: rebuild the tabs from userData/session (ProjectService.boot's restore hook, after crash recovery was
   * read). The active tab loads now, the others on their first activation. Returns whether a project was loaded.
   */
  async restore(crashed: RecoveredSession | null): Promise<boolean> {
    const entries = (await this.readSessionFile()) ?? [];
    const recs: TabRec[] = entries.map((e) => {
      const rec = this.makeRec({ id: e.id, path: e.path, name: e.name, dirty: e.dirty, untitled: e.path ? 0 : e.untitled || 1 });
      const snap = e.snapshot ? path.join(this.d.sessionDir, e.snapshot) : null;
      if (snap && isFile(snap)) rec.pending = { kind: 'snapshot', file: snap };
      else if (e.path) {
        if (snap) this.d.log('warn', `Tab "${e.name}": its unsaved changes are missing; the saved file opens instead`);
        rec.dirty = false;
        rec.pending = isFile(e.path) ? { kind: 'file' } : { kind: 'missing', message: `"${baseName(e.path)}" isn't at ${e.path} any more. Put the file back, or close this tab.` };
      } else rec.pending = { kind: 'new' };
      return rec;
    });

    // The crashed session belongs to the tab whose id it carries (else it becomes a tab of its own).
    let recovered: TabRec | null = null;
    if (crashed && (crashed.dirty || crashed.projectPath)) {
      const match = crashed.tabId ? recs.find((r) => r.id === crashed.tabId) : undefined;
      if (crashed.dirty) {
        recovered = match ?? this.makeRec({ path: crashed.projectPath, name: crashed.project.meta.name || 'Untitled', untitled: crashed.projectPath ? 0 : 1 });
        recovered.pending = { kind: 'recovered', session: crashed };
        recovered.dirty = true;
        if (!match) recs.push(recovered);
      } else if (match && crashed.projectPath && isFile(crashed.projectPath)) {
        // Saved before the crash: the file is newer than any session file.
        match.path = crashed.projectPath;
        match.dirty = false;
        match.pending = { kind: 'file' };
        recovered = match;
      } else if (!match && !recs.length && crashed.projectPath && isFile(crashed.projectPath)) {
        recovered = this.makeRec({ path: crashed.projectPath, name: baseName(crashed.projectPath), pending: { kind: 'file' } });
        recs.push(recovered);
      }
    }
    // Untitled numbers stay unique.
    const used = new Set<number>();
    for (const r of recs) {
      if (r.path) continue;
      if (!r.untitled || used.has(r.untitled)) {
        let n = 1;
        while (used.has(n)) n++;
        r.untitled = n;
      }
      used.add(r.untitled);
    }
    if (!recs.length) return false; // nothing to restore: keep the untouched new tab made in the constructor

    const first = recovered ?? recs.find((r) => r.id === this.sessionActiveId) ?? recs[0];
    const order = [first, ...recs.filter((r) => r !== first)];
    this.tabs = recs;
    let loadedOne = false;
    for (const cand of order) {
      if (cand.pending?.kind === 'missing') continue;
      const r = await this.readPending(cand);
      if (!r.ok) {
        cand.pending = { kind: 'missing', message: r.message ?? "It couldn't be opened." };
        this.d.log('warn', `Restoring tab "${this.titleOf(cand)}": ${r.message}`);
        continue;
      }
      const b = this.bringIn(cand, r.data ?? null);
      if (b.ok) {
        loadedOne = true;
        break;
      }
      cand.pending = { kind: 'missing', message: b.message ?? "It couldn't be opened." };
    }
    if (!loadedOne) {
      const blank = this.makeRec({ untitled: this.nextUntitled() });
      this.tabs.push(blank);
      this.bringIn(blank, null);
    }
    this.d.log('info', `Restored ${this.tabs.length} tab${this.tabs.length === 1 ? '' : 's'}${recovered ? ' (with unsaved changes from a crash)' : ''}`);
    this.changed();
    return loadedOne;
  }

  /** Quit: keep every tab for next time, then end crash recovery (kept when the tabs couldn't be saved). */
  async shutdown(): Promise<ActionResult> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pollTimer = null;
    this.saveTimer = null;
    const r = await this.saveSession({ active: true });
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
    await this.d.project.shutdown(r.ok);
    return r;
  }
}
