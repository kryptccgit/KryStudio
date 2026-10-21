// ──────────────────────────────────────────────────────────────────────
// ProjectService: the open project's file identity (path, dirty, recent
// files), .kstudio open/save, autosave + crash recovery, MIDI import/export,
// and the project's binary assets (the cover image: electron/project/assets.ts,
// saved inside the .kstudio zip). Implements ProjectOps (electron/mcp/types.ts)
// for the MCP server + agent.
//
// Dirty = DocHost.version !== the version last saved/loaded.
// Every method resolves to an ActionResult and never throws.
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { USER, type DocChange, type DocHost, type DocState } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { CoverRef, Project } from '@shared/schema/project';
import type { ActionResult, ProjectStatus, Settings } from '@shared/types';
import { readSmf, SmfError, writeSmf } from '@shared/midi/smf';
import { patternToSmf, planMidiImport } from '@shared/midi/convert';
import type { ProjectOps } from '../mcp/types';
import { copyFile, describeFsError, ensureDir, exists, isFile, pruneDir, readBytes, removeIfEmptySync, reserveUniquePath, writeFileAtomic } from '../system/files';
import * as dialogs from '../system/dialogs';
import { decodeContainer, encodeContainer, ProjectFileError } from './container';
import { validateProject } from './migrations';
import { isPack, missingPacksText, relinkSamples, resolveFactoryPath, resolvePackPath, withRelativePaths } from './samples';
import { RecoveryStore, type RecoveredSession } from './recovery';
import { ProjectAssets, type CoverMime, type StoredAsset } from './assets';
import { TemplateError, TemplateStore } from './templates';
import { findTemplate, type ProjectTemplate } from '@shared/templates';
import { ID_PREFIX, newId } from '@shared/schema/ids';

/**
 * One project tab's state while another tab is in the DocHost (electron/project/tabs.ts): the document +
 * history and this service's per-project fields. `dirty` is kept as a flag because versions keep counting up
 * across switches (DocHost.swap), so a saved version number would mean nothing in the other tab.
 */
export interface TabState {
  doc: DocState;
  filePath: string | null;
  dirty: boolean;
  lastSavedAt: number | null;
  recovered: boolean;
  /** Every cover image the tab stored or opened (undo of project.setCover still finds its bytes). */
  assets: StoredAsset[];
}

/** A project read from disk and checked, not yet in the DocHost (ProjectService.applyLoaded puts it in). */
export interface LoadedProject {
  project: Project;
  assets: Record<string, Uint8Array>;
  /** The file path the open project keeps (null: untitled, a demo copy, an imported .json). */
  filePath: string | null;
  dirty: boolean;
  /** Added to File ▸ Recent when applied. */
  recent: string | null;
  /** The result message's start; null = `${how} "<name>"`. */
  head: string | null;
  how: 'Opened' | 'Imported' | 'Restored';
  /** Notes for the user (relinked / missing samples, demo copy …). */
  notes: string[];
}

/** The project tabs (electron/project/tabs.ts), once attached: New / Open / New from template make or pick tabs. */
export interface TabsHook {
  /** A new tab with a fresh project, for main-side callers (Audio → Project, agents): no switch guards. */
  newProjectTab(): ActionResult;
  /** A new tab from a template, for main-side callers (agents): no switch guards. */
  newTemplateTab(ref: string): Promise<ActionResult<{ template: ProjectTemplate }>>;
  /** File ▸ Open semantics: a new tab, the untouched new tab replaced, or an already-open file's tab activated. */
  open(p: string | undefined, win?: BrowserWindow | null): Promise<ActionResult>;
}

export interface ProjectServiceDeps {
  doc: DocHost;
  appVersion: string;
  userDataDir: string;
  factoryDir: string;
  /** Downloaded sound packs ('pack:<id>/…' samples); default userData/packs. */
  packsDir?: string;
  documentsDir: string;
  getSettings(): Settings;
  addRecent(p: string): void;
  log(level: 'info' | 'warn' | 'error', m: string): void;
  /** Runs before every save (stores third-party plugin states in the document). */
  beforeSave?(): Promise<void>;
  /**
   * Folders inside the app (the shipped demos): a project opened from one opens as a template. Save asks where to
   * keep the user's copy, and dialogs never default into the app's own folders.
   */
  templateDirs?: string[];
}

/** `file` lies inside `dir` (case-insensitive on Windows). */
export function isInside(dir: string, file: string): boolean {
  const norm = (x: string) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const rel = path.relative(norm(dir), norm(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const PROJECT_FILTERS = [{ name: 'Krypt Studio Project', extensions: ['kstudio'] }];
const OPEN_FILTERS = [{ name: 'Krypt Studio Project', extensions: ['kstudio', 'json'] }];
const MIDI_FILTERS = [{ name: 'MIDI file', extensions: ['mid', 'midi'] }];
const NOTES_PER_EXEC = 10_000;

const errMsg = (err: unknown, target: string): string =>
  err instanceof ProjectFileError || err instanceof SmfError ? err.message : describeFsError(err, target);

export class ProjectService implements ProjectOps {
  private filePath: string | null = null;
  private savedVersion: number;
  private lastSavedAt: number | null = null;
  private recovered = false;
  private listeners = new Set<(s: ProjectStatus) => void>();
  private lastStatusKey = '';
  private saveChain: Promise<unknown> = Promise.resolve();
  private autosaveTimer: NodeJS.Timeout | null = null;
  private autosaveEverySec = 0;
  private readonly recovery: RecoveryStore;
  private readonly doc: DocHost;
  private tabs: TabsHook | null = null;
  /** The active tab's id (recorded in crash-recovery snapshots so a restore knows which tab they belong to). */
  private tabId: string | null = null;
  /** Recovery snapshots wait for this (the outgoing tab's session file) before they replace the old snapshot. */
  private recoveryGate: Promise<unknown> = Promise.resolve();
  private autosaveHooks = new Set<() => void>();
  private swapping = false;
  /** The cover images this session stored or opened (the doc references one by name). */
  readonly assets: ProjectAssets;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.doc = deps.doc;
    this.savedVersion = deps.doc.version;
    this.recovery = new RecoveryStore(path.join(deps.userDataDir, 'autosave'), deps.appVersion, deps.log);
    this.assets = new ProjectAssets((a) => void this.recovery.saveAsset(a.file, a.bytes));
    this.doc.subscribe((c) => this.onDocChange(c));
  }

  /**
   * Take a project's assets in (from a file or a recovery snapshot): the cover it references is adopted, or the
   * reference is dropped when its image is missing or damaged. Mutates `project` (a freshly loaded copy). Returns
   * a note for the user when the cover was dropped.
   */
  private takeAssets(project: Project, assets: Record<string, Uint8Array>): string | null {
    this.assets.clear();
    const cover = project.meta.cover;
    if (!cover) return null;
    const bytes = assets[cover.file];
    if (bytes && this.assets.adopt(cover.file, bytes)) {
      void this.recovery.saveAsset(cover.file, bytes);
      return null;
    }
    delete project.meta.cover;
    return 'its cover image was missing or damaged, so it opened without one';
  }

  // ── Boot / shutdown ─────────────────────────────────────────────────

  /**
   * Restore a crashed session (snapshot + journal) when it had unsaved
   * changes; otherwise reopen the crashed session's file, else keep the
   * fresh default project. Then start journaling + autosave.
   */
  async boot(restore?: (crashed: RecoveredSession | null) => Promise<boolean>): Promise<void> {
    let restored = false;
    let session: RecoveredSession | null = null;
    try {
      session = this.recovery.crashedLastTime() ? await this.recovery.recover() : null;
      // The previous session's files go BEFORE this session writes anything.
      await this.recovery.discardPrevious();
    } catch (err) {
      this.deps.log('warn', `Crash recovery failed: ${(err as Error).message}`);
    }
    try {
      if (restore) {
        // Project tabs: the session restore decides which tab the crashed session belongs to.
        restored = await restore(session);
      } else if (session?.dirty) {
        this.adoptRecovered(session);
        restored = true;
      } else if (session?.projectPath && isFile(session.projectPath)) {
        restored = (await this.loadFile(session.projectPath)).ok;
      }
    } catch (err) {
      this.deps.log('warn', `Restoring the last session failed: ${(err as Error).message}`);
    }
    if (!restored) this.savedVersion = this.doc.version;
    this.recovery.begin();
    await this.snapshotNow();
    this.rescheduleAutosave();
    this.emitStatus(true);
  }

  /** Put a crashed session's unsaved project in the DocHost (marked unsaved and recovered). */
  adoptRecovered(session: RecoveredSession): void {
    const note = this.takeAssets(session.project, session.assets);
    if (note) this.deps.log('warn', `Recovered project: ${note}`);
    this.doc.reset(session.project);
    this.filePath = session.projectPath && isFile(session.projectPath) ? session.projectPath : null;
    this.savedVersion = -1; // recovered edits are unsaved
    this.lastSavedAt = null;
    this.recovered = true;
    void this.snapshotNow();
    this.emitStatus(true);
    this.deps.log('warn', `Recovered unsaved changes from the last session (${new Date(session.editedAt).toLocaleString()}).`);
  }

  // ── Project tabs (electron/project/tabs.ts) ──────────────────────────

  /** Route New / Open / New from template through the tabs. */
  attachTabs(tabs: TabsHook): void {
    this.tabs = tabs;
  }

  /** New / New from template open a NEW tab (ProjectOps: Audio → Project and Auto Mashup replace nothing). */
  opensNewTabs(): boolean {
    return this.tabs !== null;
  }

  /** The active tab's id, recorded in crash-recovery snapshots from now on. */
  setTabId(id: string | null): void {
    this.tabId = id;
  }

  /** Recovery snapshots taken from now on wait for `p` before replacing the previous snapshot (never rejects). */
  holdRecoveryUntil(p: Promise<unknown>): void {
    const prev = this.recoveryGate;
    this.recoveryGate = Promise.all([prev, p.catch(() => {})]);
  }

  /** Called on the autosave cadence while the active project is dirty (the tabs keep their session file fresh). */
  onAutosave(cb: () => void): () => void {
    this.autosaveHooks.add(cb);
    return () => this.autosaveHooks.delete(cb);
  }

  /** The active tab's state (document + history + file fields), to keep while another tab is active. */
  capture(): TabState {
    return {
      doc: this.doc.exportState(),
      filePath: this.filePath,
      dirty: this.status().dirty,
      lastSavedAt: this.lastSavedAt,
      recovered: this.recovered,
      assets: this.assets.list(),
    };
  }

  /** Make a kept tab state the active one: DocHost.swap (a reset that keeps its history) + its file fields. */
  activate(state: TabState): void {
    this.swapping = true;
    try {
      this.doc.swap(state.doc);
    } finally {
      this.swapping = false;
    }
    this.assets.restore(state.assets);
    this.filePath = state.filePath;
    this.savedVersion = state.dirty ? -1 : this.doc.version;
    this.lastSavedAt = state.lastSavedAt;
    this.recovered = state.recovered;
    void this.snapshotNow();
    this.emitStatus(true);
  }

  /**
   * Read a tab's session snapshot (userData/session/tab-<id>.kstudio) without touching the open project: its
   * project, its file path (kept when the file still exists) and its unsaved state. applyLoaded puts it in.
   */
  async readSessionSnapshot(file: string, info: { path: string | null; dirty: boolean }): Promise<ActionResult<LoadedProject>> {
    try {
      const decoded = decodeContainer(await readBytes(file));
      const project = validateProject(decoded.project, decoded.meta?.schemaVersion);
      const keepPath = info.path && isFile(info.path) && !this.isTemplate(info.path) ? info.path : null;
      const notes: string[] = [];
      if (info.path && !keepPath) notes.push(`its file isn't at ${info.path} any more, so Save asks where to keep it`);
      return { ok: true, data: { project, assets: decoded.assets, filePath: keepPath, dirty: info.dirty || (!!info.path && !keepPath), recent: null, head: null, how: 'Restored', notes } };
    } catch (err) {
      this.deps.log('warn', `Reading the tab snapshot ${file} failed: ${(err as Error).message}`);
      return { ok: false, message: `Couldn't restore the unsaved project: ${errMsg(err, file)}` };
    }
  }

  /**
   * Put a read project (readProjectFile / readSessionSnapshot / readTemplate) in the DocHost, replacing what is
   * there. Synchronous, so a tab switch happens in one step. History starts empty.
   */
  applyLoaded(l: LoadedProject): ActionResult {
    try {
      const coverNote = this.takeAssets(l.project, l.assets);
      this.doc.reset(l.project);
      this.filePath = l.filePath;
      this.savedVersion = l.dirty ? -1 : this.doc.version;
      this.lastSavedAt = null;
      this.recovered = false;
      if (l.recent) this.deps.addRecent(l.recent);
      void this.snapshotNow();
      this.emitStatus(true);
      const notes = coverNote ? [...l.notes, coverNote] : l.notes;
      const head = l.head ?? `${l.how} "${this.status().name}"`;
      return { ok: true, message: `${head}${notes.length ? ` (${notes.join('; ')})` : ''}` };
    } catch (err) {
      this.deps.log('error', `Loading a project failed: ${(err as Error)?.stack ?? err}`);
      return { ok: false, message: `Couldn't load the project: ${(err as Error)?.message ?? err}` };
    }
  }

  /** Flush the journal; on a clean exit also remove the recovery files. */
  async shutdown(clean: boolean): Promise<void> {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
    try {
      if (clean) await this.recovery.endClean();
      else await this.recovery.flush();
    } catch {
      /* best effort */
    }
  }

  /** Re-arm the autosave timer after settings.autosaveSec changed. */
  rescheduleAutosave(): void {
    const sec = this.deps.getSettings().autosaveSec;
    if (sec === this.autosaveEverySec && this.autosaveTimer) return;
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
    this.autosaveEverySec = sec;
    if (sec > 0) {
      this.autosaveTimer = setInterval(() => {
        if (!this.status().dirty) return;
        if (this.doc.version !== this.recovery.snapshotVersion) void this.snapshotNow();
        for (const fn of this.autosaveHooks) {
          try {
            fn();
          } catch {
            /* a hook never stops autosave */
          }
        }
      }, sec * 1000);
      this.autosaveTimer.unref?.();
    }
  }

  private snapshotNow(): Promise<void> {
    const project = this.doc.project;
    return this.recovery.snapshot(
      project,
      {
        docVersion: this.doc.version,
        savedVersion: this.savedVersion,
        projectPath: this.filePath,
        tabId: this.tabId,
      },
      this.assets.entriesFor(project),
      this.recoveryGate,
    );
  }

  private onDocChange(c: DocChange): void {
    if (c.kind === 'reset') {
      // Resets come from this service (new/open/recover/tab switch); they snapshot themselves.
      if (!this.swapping) this.emitStatus();
      return;
    }
    this.recovery.appendChange(c.version, c.patches);
    this.emitStatus();
  }

  // ── Status ──────────────────────────────────────────────────────────

  status(): ProjectStatus {
    const p = this.doc.project;
    return {
      path: this.filePath,
      name: this.filePath ? path.basename(this.filePath).replace(/\.kstudio$/i, '') : p.meta.name || 'Untitled',
      dirty: this.doc.version !== this.savedVersion,
      lastSavedAt: this.lastSavedAt,
      recovered: this.recovered,
    };
  }

  onStatus(cb: (s: ProjectStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitStatus(force = false): void {
    const s = this.status();
    const key = JSON.stringify(s);
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* ignore */
      }
    }
  }

  // ── New / open ──────────────────────────────────────────────────────

  /** File ▸ New: with tabs attached, a NEW tab (main-side callers: no switch guards); else replace the project. */
  newProject(): ActionResult {
    return this.tabs ? this.tabs.newProjectTab() : this.resetToNew();
  }

  /** Replace the DocHost's project with a fresh default one (the tabs call this for a new tab). */
  resetToNew(): ActionResult {
    try {
      this.doc.reset(createDefaultProject('Untitled'));
      this.assets.clear();
      this.filePath = null;
      this.savedVersion = this.doc.version;
      this.lastSavedAt = null;
      this.recovered = false;
      void this.snapshotNow();
      this.emitStatus(true);
      return { ok: true, message: 'New project' };
    } catch (err) {
      return { ok: false, message: `Couldn't create a new project: ${(err as Error).message}` };
    }
  }

  /** File ▸ Open: with tabs attached, the tab rules (tabs.ts); else replace the project. */
  async open(p?: string, win?: BrowserWindow | null): Promise<ActionResult> {
    if (this.tabs) return this.tabs.open(p, win);
    const target = p ?? (await this.pickProjectFile(win));
    if (!target) return { ok: false, message: 'Open cancelled' };
    return this.loadFile(target);
  }

  /** The Open project dialog; null when cancelled. */
  async pickProjectFile(win?: BrowserWindow | null): Promise<string | null> {
    const picked = await dialogs.openFiles({ title: 'Open project', filters: OPEN_FILTERS, defaultPath: this.defaultDir(), win });
    return picked?.[0] ?? null;
  }

  /** Whether a file opens as a copy (a shipped demo): no file path is kept, so it never matches an open tab. */
  opensAsTemplate(file: string): boolean {
    return this.isTemplate(file);
  }

  /** Load a project file into the DocHost, replacing what is there (the tabs pick which tab first). */
  openInPlace(target: string): Promise<ActionResult> {
    return this.loadFile(target);
  }

  /** Read + check a project file without touching the open project; applyLoaded puts it in. */
  async readProjectFile(target: string): Promise<ActionResult<LoadedProject>> {
    try {
      if (!isFile(target)) return { ok: false, message: `Project not found: ${target}` };
      const decoded = decodeContainer(await readBytes(target));
      const project = validateProject(decoded.project, decoded.meta?.schemaVersion);
      const isContainer = /\.kstudio$/i.test(target);
      const relink = relinkSamples(project, target, exists, { importsDir: path.join(this.deps.userDataDir, 'imports'), packsDir: this.packsDir() });
      const template = this.isTemplate(target);
      const notes: string[] = [];
      if (relink.relinked.length) notes.push(`relinked ${relink.relinked.length} sample${relink.relinked.length === 1 ? '' : 's'} from the project folder`);
      if (relink.missing.length) notes.push(`${relink.missing.length} missing sample${relink.missing.length === 1 ? '' : 's'}: ${relink.missing.slice(0, 3).join(', ')}${relink.missing.length > 3 ? '…' : ''}`);
      if (relink.missingPacks.length) notes.push(missingPacksText(relink.missingPacks));
      if (template) notes.push('a demo: saving makes your own copy in Documents');
      return {
        ok: true,
        data: { project: relink.project, assets: decoded.assets, filePath: isContainer && !template ? target : null, dirty: !isContainer, recent: isContainer ? target : null, head: null, how: isContainer ? 'Opened' : 'Imported', notes },
      };
    } catch (err) {
      this.deps.log('warn', `Open failed for ${target}: ${(err as Error).message}`);
      return { ok: false, message: `Couldn't open ${path.basename(target)}: ${errMsg(err, target)}` };
    }
  }

  private async loadFile(target: string): Promise<ActionResult> {
    const r = await this.readProjectFile(target);
    return r.ok && r.data ? this.applyLoaded(r.data) : { ok: false, message: r.message };
  }

  // ── User templates (Wave 12.2b, ./templates.ts) ──────────────────────

  private templateStore: TemplateStore | null = null;

  /** userData/templates (created on first save). */
  get templates(): TemplateStore {
    return (this.templateStore ??= new TemplateStore(path.join(this.deps.userDataDir, 'templates')));
  }

  listTemplates(): ProjectTemplate[] {
    try {
      return this.templates.list();
    } catch (err) {
      this.deps.log('warn', `Couldn't list templates: ${(err as Error).message}`);
      return [];
    }
  }

  /** File ▸ Save as template…: the open project (sounds, mixer, patterns, arrangement) under `name`; same name = replace. */
  async saveAsTemplate(name: string): Promise<ActionResult<ProjectTemplate>> {
    if (this.deps.beforeSave) {
      try {
        await this.deps.beforeSave();
      } catch (err) {
        this.deps.log('warn', `Pre-save step failed: ${(err as Error)?.message ?? err}`);
      }
    }
    const project = this.doc.project;
    try {
      const bytes = encodeContainer(project, this.deps.appVersion, { template: true }, this.assets.entriesFor(project));
      const facts = { bpm: project.transport.bpm, timeSig: `${project.transport.timeSig.num}/${project.transport.timeSig.den}`, channels: project.channelOrder.length, patterns: project.patternOrder.length };
      const { template, replaced } = await this.templates.save(name, bytes, facts);
      return { ok: true, message: `${replaced ? 'Updated' : 'Saved'} template "${template.name}"`, data: template };
    } catch (err) {
      if (err instanceof TemplateError) return { ok: false, message: err.message };
      this.deps.log('error', `Template save failed: ${(err as Error).message}`);
      return { ok: false, message: `Couldn't save the template: ${describeFsError(err, this.templates.dir)}` };
    }
  }

  /** A new, unsaved project from a template (id or name). With tabs attached: in a NEW tab (no switch guards). */
  newFromTemplate(ref: string): Promise<ActionResult<{ template: ProjectTemplate }>> {
    return this.tabs ? this.tabs.newTemplateTab(ref) : this.resetFromTemplate(ref);
  }

  /** Replace the DocHost's project with a new one from a template. Like New: no file path, not dirty, history cleared. */
  async resetFromTemplate(ref: string): Promise<ActionResult<{ template: ProjectTemplate }>> {
    const r = await this.readTemplate(ref);
    if (!r.ok || !r.data) return { ok: false, message: r.message };
    const a = this.applyLoaded(r.data.loaded);
    return a.ok ? { ...a, data: { template: r.data.template } } : { ok: false, message: a.message };
  }

  /** Read a template as a fresh, unsaved project (new id, "Untitled") without touching the open project. */
  async readTemplate(ref: string): Promise<ActionResult<{ loaded: LoadedProject; template: ProjectTemplate }>> {
    const t = findTemplate(this.listTemplates(), String(ref ?? ''));
    if (!t) return { ok: false, message: `No template "${String(ref ?? '').slice(0, 64)}"` };
    try {
      const { bytes, file } = await this.templates.read(t.id);
      const decoded = decodeContainer(bytes);
      const project = validateProject(decoded.project, decoded.meta?.schemaVersion);
      const relink = relinkSamples(project, file, exists, { importsDir: path.join(this.deps.userDataDir, 'imports'), packsDir: this.packsDir() });
      const fresh: Project = { ...relink.project, id: newId(ID_PREFIX.project), meta: { ...relink.project.meta, name: 'Untitled', createdAt: new Date().toISOString() } };
      const notes: string[] = [];
      if (relink.missing.length) notes.push(`${relink.missing.length} missing sample${relink.missing.length === 1 ? '' : 's'}: ${relink.missing.slice(0, 3).join(', ')}${relink.missing.length > 3 ? '…' : ''}`);
      if (relink.missingPacks.length) notes.push(missingPacksText(relink.missingPacks));
      return { ok: true, data: { template: t, loaded: { project: fresh, assets: decoded.assets, filePath: null, dirty: false, recent: null, head: `New project from "${t.name}"`, how: 'Opened', notes } } };
    } catch (err) {
      this.deps.log('warn', `New from template failed for ${t.id}: ${(err as Error).message}`);
      return { ok: false, message: `Couldn't open the template "${t.name}": ${err instanceof TemplateError ? err.message : errMsg(err, t.name)}` };
    }
  }

  async renameTemplate(id: string, name: string): Promise<ActionResult<ProjectTemplate>> {
    try {
      const t = await this.templates.rename(String(id), String(name ?? ''));
      return { ok: true, message: `Renamed the template to "${t.name}"`, data: t };
    } catch (err) {
      return { ok: false, message: err instanceof TemplateError ? err.message : `Couldn't rename the template: ${describeFsError(err, this.templates.dir)}` };
    }
  }

  async deleteTemplate(id: string): Promise<ActionResult> {
    try {
      const t = await this.templates.remove(String(id));
      return { ok: true, message: `Deleted the template "${t.name}"` };
    } catch (err) {
      return { ok: false, message: err instanceof TemplateError ? err.message : `Couldn't delete the template: ${describeFsError(err, this.templates.dir)}` };
    }
  }

  // ── Save ────────────────────────────────────────────────────────────

  save(win?: BrowserWindow | null): Promise<ActionResult<{ path: string }>> {
    if (!this.filePath) return this.saveAs(win);
    const target = this.filePath;
    return this.serialize(() => this.writeTo(target));
  }

  /**
   * save_project for a never-saved project (agents can't answer a Save dialog): a NEW "<name>.kstudio" in the
   * folder Save As would open (" (2)" … when taken, so no file is ever overwritten). A saved project refuses: use save.
   */
  async saveNew(name: string): Promise<ActionResult<{ path: string }>> {
    if (this.filePath && !this.isTemplate(this.filePath)) return { ok: false, message: `This project is already saved as ${path.basename(this.filePath)}` };
    let target: string;
    try {
      target = reserveUniquePath(this.defaultDir(), safeName(name.trim() || this.status().name), 'kstudio');
    } catch (err) {
      return { ok: false, message: `Couldn't save: ${describeFsError(err, this.defaultDir())}` };
    }
    const r = await this.serialize(() => this.writeTo(target));
    if (!r.ok) removeIfEmptySync(target);
    return r;
  }

  async saveAs(win?: BrowserWindow | null): Promise<ActionResult<{ path: string }>> {
    const s = this.status();
    const defaultPath = this.filePath ?? path.join(this.defaultDir(), `${safeName(s.name)}.kstudio`);
    let target = await dialogs.saveFile({ title: 'Save project as', defaultPath, filters: PROJECT_FILTERS, win });
    if (!target) return { ok: false, message: 'Save cancelled' };
    if (!/\.kstudio$/i.test(target)) target += '.kstudio';
    const t = target;
    return this.serialize(() => this.writeTo(t));
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(job, job);
    this.saveChain = run.catch(() => {});
    return run;
  }

  private async writeTo(target: string): Promise<ActionResult<{ path: string }>> {
    if (this.deps.beforeSave) {
      try {
        await this.deps.beforeSave();
      } catch (err) {
        this.deps.log('warn', `Pre-save step failed: ${(err as Error)?.message ?? err}`);
      }
    }
    const version = this.doc.version;
    const project: Project = this.doc.project;
    try {
      const assets = this.assets.entriesFor(project);
      if (project.meta.cover && !assets[project.meta.cover.file]) this.deps.log('warn', `Saving without the cover image: ${project.meta.cover.file} isn't in memory`);
      const bytes = encodeContainer(withRelativePaths(project, target), this.deps.appVersion, {}, assets);
      await this.backup(target, project.id);
      await writeFileAtomic(target, bytes);
    } catch (err) {
      this.deps.log('error', `Save failed for ${target}: ${(err as Error).message}`);
      return { ok: false, message: `Couldn't save: ${errMsg(err, target)}` };
    }
    this.filePath = target;
    this.savedVersion = version;
    this.lastSavedAt = Date.now();
    this.recovered = false;
    this.deps.addRecent(target);
    this.recovery.appendSaved(version, target);
    this.emitStatus(true);
    return { ok: true, message: `Saved "${this.status().name}"`, data: { path: target } };
  }

  /** Keep the previous file version in userData/backups/<projectId>/ (last 10). */
  private async backup(target: string, projectId: string): Promise<void> {
    if (!isFile(target)) return;
    try {
      const dir = ensureDir(path.join(this.deps.userDataDir, 'backups', projectId.replace(/[^\w-]/g, '_')));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(target, path.join(dir, `${path.basename(target, '.kstudio')}-${stamp}.kstudio`));
      await pruneDir(dir, 10, /\.kstudio$/i);
    } catch {
      /* a failed backup never blocks saving */
    }
  }

  /** Folder dialogs start in: the project's folder, else the most recent file's, else Documents — never the app's own folders. */
  defaultDir(): string {
    if (this.filePath && !this.isTemplate(this.filePath)) return path.dirname(this.filePath);
    const recent = this.deps.getSettings().recent.find((r) => !this.isTemplate(r));
    return recent ? path.dirname(recent) : this.deps.documentsDir;
  }

  private isTemplate(file: string): boolean {
    return (this.deps.templateDirs ?? []).some((d) => isInside(d, file));
  }

  // ── MIDI ────────────────────────────────────────────────────────────

  async importMidi(p?: string, win?: BrowserWindow | null): Promise<ActionResult<{ patternId: string; channelIds: string[] }>> {
    let target = p;
    if (!target) {
      const picked = await dialogs.openFiles({ title: 'Import MIDI file', filters: MIDI_FILTERS, defaultPath: this.defaultDir(), win });
      if (!picked) return { ok: false, message: 'Import cancelled' };
      target = picked[0];
    }
    let plan: ReturnType<typeof planMidiImport>;
    try {
      plan = planMidiImport(readSmf(await readBytes(target)));
    } catch (err) {
      return { ok: false, message: `Couldn't read ${path.basename(target)}: ${errMsg(err, target)}` };
    }
    if (plan.noteCount === 0) return { ok: false, message: `${path.basename(target)} has no notes to import` };

    const name = path.basename(target).replace(/\.(mid|midi|smf)$/i, '').slice(0, 64) || 'MIDI';
    const group = this.doc.beginGroup(USER, `Import MIDI "${name}"`);
    const channelIds: string[] = [];
    let patternId = '';
    let failure: string | null = null;
    try {
      const pr = this.doc.exec<{ id: string }>('patterns.add', { name, select: true }, { actor: USER, groupId: group });
      if (!pr.ok || !pr.data) throw new Error(pr.message ?? 'patterns.add failed');
      patternId = pr.data.id;
      for (const t of plan.tracks) {
        const cr = this.doc.exec<{ id: string }>('channels.add', { type: 'krypt.triosc', name: t.name }, { actor: USER, groupId: group });
        if (!cr.ok || !cr.data) throw new Error(cr.message ?? 'channels.add failed');
        channelIds.push(cr.data.id);
        for (let i = 0; i < t.notes.length; i += NOTES_PER_EXEC) {
          const nr = this.doc.exec('notes.add', { patternId, channelId: cr.data.id, notes: t.notes.slice(i, i + NOTES_PER_EXEC) }, { actor: USER, groupId: group });
          if (!nr.ok) throw new Error(nr.message ?? 'notes.add failed');
        }
      }
    } catch (err) {
      failure = (err as Error).message;
    } finally {
      this.doc.endGroup(group);
    }
    if (failure) {
      if (patternId) this.doc.undo(USER); // the whole import is one history entry
      return { ok: false, message: `MIDI import failed: ${failure}` };
    }
    const bpm = this.doc.project.transport.bpm;
    const tempoNote = plan.bpm && Math.abs(plan.bpm - bpm) > 0.01 ? ` File tempo is ${plan.bpm} BPM (project stays at ${bpm}).` : '';
    return {
      ok: true,
      message: `Imported ${plan.tracks.length} track${plan.tracks.length === 1 ? '' : 's'} (${plan.noteCount} notes) into pattern "${name}".${tempoNote}`,
      data: { patternId, channelIds },
    };
  }

  async exportMidi(patternId?: string, win?: BrowserWindow | null): Promise<ActionResult<{ path: string }>> {
    const project = this.doc.project;
    const id = patternId ?? project.transport.activePatternId ?? project.patternOrder[0];
    const pat = id ? project.patterns[id] : undefined;
    if (!id || !pat) return { ok: false, message: 'Select a pattern to export first' };
    let bytes: Uint8Array;
    try {
      const smf = patternToSmf(project, id);
      if (smf.tracks.length === 0) return { ok: false, message: `Pattern "${pat.name}" has no notes to export` };
      bytes = writeSmf(smf);
    } catch (err) {
      return { ok: false, message: `MIDI export failed: ${(err as Error).message}` };
    }
    const target = await dialogs.saveFile({
      title: 'Export pattern as MIDI',
      defaultPath: path.join(this.defaultDir(), `${safeName(pat.name)}.mid`),
      filters: MIDI_FILTERS,
      win,
    });
    if (!target) return { ok: false, message: 'Export cancelled' };
    try {
      await writeFileAtomic(target, bytes);
      return { ok: true, message: `Exported "${pat.name}" to ${path.basename(target)}`, data: { path: target } };
    } catch (err) {
      return { ok: false, message: `Couldn't write ${path.basename(target)}: ${errMsg(err, target)}` };
    }
  }

  // ── ProjectOps (MCP / agent) ────────────────────────────────────────

  /** 'factory:…' → the factory folder, 'pack:<id>/…' → userData/packs/<id>/… (never escaping either), else as is. */
  resolveSamplePath(p: string): string {
    if (isPack(p)) return resolvePackPath(p, this.packsDir());
    return resolveFactoryPath(p, this.deps.factoryDir);
  }

  packsDir(): string {
    return this.deps.packsDir ?? path.join(this.deps.userDataDir, 'packs');
  }

  renderDir(): string {
    return ensureDir(path.join(this.deps.userDataDir, 'renders'));
  }

  allowedRoots(): string[] {
    return [this.deps.factoryDir, ...this.deps.getSettings().browserRoots.map((r) => r.path)];
  }

  // ── Cover image (bytes in main, a CoverRef in the doc) ──────────────

  /** Store normalized cover bytes for this project (deduplicated) and return the reference to put in the doc. */
  storeCover(bytes: Uint8Array, mime: CoverMime, width: number, height: number): CoverRef {
    const a = this.assets.put(bytes, mime);
    return { file: a.file, mime: a.mime, width, height };
  }

  /** The current cover's bytes, or null (no cover, or its bytes are gone). */
  coverImage(): (StoredAsset & CoverRef) | null {
    const ref = this.doc.project.meta.cover;
    const a = ref ? this.assets.get(ref.file) : null;
    return ref && a ? { ...ref, bytes: a.bytes } : null;
  }
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Untitled';
}
