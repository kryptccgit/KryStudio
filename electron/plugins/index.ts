// ──────────────────────────────────────────────────────────────────────
// PluginService: third-party VST3 + CLAP plugins on the main side.
//
//   userData/plugins/cache.json      scan results per file (size+mtime key)
//   userData/plugins/blocklist.json  files that crashed the scanner (kept
//                                    across "rescan all"; user-resettable)
//   userData/plugins/settings.json   user plugin folders
//   userData/plugins/scan-journal.txt  the file being scanned right now
//
// At startup the cache is registered into the shared CATALOG (so DocHost,
// the MCP tools and every renderer see installed plugins next to the stock
// ones), then an incremental background rescan runs. Before every engine
// (re)start the descriptors are sent to the engine (plugins.register), which
// hosts the plugins out of process in krypt-studio-pluginhost.exe.
// Engine `plugin` events become toasts (crash / load failure) and doc
// updates (edits made in a plugin's own window). Before a save the engine's
// live plugin states are stored on generator.state / slot.state.
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { app } from 'electron';
import { SYSTEM, USER, type DocHost } from '@shared/doc/DocHost';
import { registerExternalPlugins } from '@shared/plugins/catalog';
import type { PluginDescriptor } from '@shared/plugins/types';
import type { EngineEvent, PluginEngineEvent } from '@shared/engine/protocol';
import type { ActionResult, PluginBlockEntry, PluginFileEntry, PluginInstanceInfo, PluginManagerState, PluginTarget } from '@shared/types';
import type { EngineSupervisor } from '../engine/supervisor';
import { copyIfNewerSync, ensureDir, mtimeMs, pruneDir, readTextSync, writeFileAtomic, appendText, removeFile } from '../system/files';
import { EXE_EXT, findBinary } from '../system/paths';
import { countVst2, dirExists, findCandidates, runScanner, standardPluginFolders, vst2Folders, type PluginCandidate, type PluginFormat } from '../system/plugin-scan';

export const PLUGINHOST_EXE = `krypt-studio-pluginhost${EXE_EXT}`;
/** VST3 / CLAP hosting is Windows-only for now (the host's shared memory and editor windows are Win32). */
const HOST_UNSUPPORTED =
  process.platform === 'win32' ? undefined : 'Third-party VST3 / CLAP plugins work on Windows only for now. Every built-in instrument and effect works here.';
const SCAN_CONCURRENCY = 3;
const SCAN_TIMEOUT_MS = 30_000;
const CACHE_VERSION = 1;

interface CacheEntry {
  path: string;
  format: PluginFormat;
  size: number;
  mtime: number;
  status: PluginFileEntry['status'];
  message?: string;
  plugins: PluginDescriptor[];
  scannedAt: number;
}

export interface PluginServiceDeps {
  doc: DocHost;
  userDataDir: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', m: string): void;
  /** Main window HWND as a decimal string (owner of plugin editor windows). */
  ownerHwnd(): string | null;
  /** Fan the state out to every renderer. */
  broadcast(state: PluginManagerState): void;
  pickFolder(): Promise<string | null>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const norm = (p: string): string => path.resolve(p).toLowerCase();

/** Dev: run the host from a %TEMP% copy so cargo can rebuild the original. */
function launchable(src: string): string {
  if (app.isPackaged) return src;
  const dir = path.join(app.getPath('temp'), 'krypt-studio-pluginhost-shadow');
  const dst = path.join(dir, `krypt-studio-pluginhost-${Math.trunc(mtimeMs(src)).toString(36)}${EXE_EXT}`);
  try {
    copyIfNewerSync(src, dst);
    void pruneDir(dir, 3, /^krypt-studio-pluginhost-[0-9a-z]+(\.exe)?$/i);
    return dst;
  } catch {
    return src;
  }
}

export class PluginService {
  private readonly dir: string;
  private cache = new Map<string, CacheEntry>();
  private blocked = new Map<string, PluginBlockEntry>();
  private userFolders: string[] = [];
  private scanning: Promise<ActionResult<PluginManagerState>> | null = null;
  private progress: PluginManagerState['progress'] = null;
  private lastScanAt: number | null = null;
  private vst2Found = 0;
  private hostPid: number | null = null;
  private instances: PluginInstanceInfo[] = [];
  private folderExists = new Map<string, boolean>();
  private engine: EngineSupervisor | null = null;
  private lastBroadcast = 0;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private pendingParams = new Map<string, { key: string; paramId: string; value: number }>();
  private paramTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PluginServiceDeps) {
    this.dir = ensureDir(path.join(deps.userDataDir, 'plugins'));
    this.load();
    registerExternalPlugins(this.descriptors());
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private readJson<T>(name: string): T | null {
    const t = readTextSync(this.file(name));
    if (!t) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      this.deps.log('warn', `Plugin Manager: ${name} is corrupt; ignoring it`);
      return null;
    }
  }

  private load(): void {
    const c = this.readJson<{ version: number; files: Record<string, CacheEntry> }>('cache.json');
    if (c && c.version === CACHE_VERSION && c.files) for (const e of Object.values(c.files)) if (e && e.path) this.cache.set(norm(e.path), e);
    const b = this.readJson<{ entries: Record<string, PluginBlockEntry> }>('blocklist.json');
    if (b?.entries) for (const e of Object.values(b.entries)) if (e && e.path) this.blocked.set(norm(e.path), e);
    const s = this.readJson<{ folders: string[] }>('settings.json');
    if (s && Array.isArray(s.folders)) this.userFolders = s.folders.filter((f) => typeof f === 'string' && f);
    const j = readTextSync(this.file('scan-journal.txt'));
    if (j && j.trim()) {
      for (const p of j.split(/\r?\n/).filter(Boolean)) {
        this.deps.log('warn', `Plugin Manager: the last scan was interrupted while reading ${p}; it will be scanned again`);
        this.cache.delete(norm(p));
      }
      void removeFile(this.file('scan-journal.txt')).catch(() => {});
    }
    this.lastScanAt = Math.max(0, ...[...this.cache.values()].map((e) => e.scannedAt)) || null;
  }

  private async save(): Promise<void> {
    try {
      await writeFileAtomic(this.file('cache.json'), JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries([...this.cache.values()].map((e) => [e.path, e])) }));
      await writeFileAtomic(this.file('blocklist.json'), JSON.stringify({ version: 1, entries: Object.fromEntries([...this.blocked.values()].map((e) => [e.path, e])) }, null, 1));
      await writeFileAtomic(this.file('settings.json'), JSON.stringify({ folders: this.userFolders }, null, 1));
    } catch (err) {
      this.deps.log('error', `Plugin Manager couldn't save its cache: ${errText(err)}`);
    }
  }

  // ── State ───────────────────────────────────────────────────────────

  hostExe(): string | null {
    if (HOST_UNSUPPORTED) return null;
    const src = findBinary(PLUGINHOST_EXE);
    return src ? launchable(src) : null;
  }

  /** Installed descriptors: scanned, not blocked; first folder wins on duplicate ids. */
  descriptors(): PluginDescriptor[] {
    const seen = new Set<string>();
    const out: PluginDescriptor[] = [];
    for (const e of this.cache.values()) {
      if (this.blocked.has(norm(e.path)) || (e.status !== 'ok' && e.status !== 'partial')) continue;
      for (const d of e.plugins) {
        if (!d || typeof d.id !== 'string' || seen.has(d.id)) continue;
        seen.add(d.id);
        out.push(d);
      }
    }
    return out;
  }

  private folders(): Array<{ path: string; builtin: boolean; formats: PluginFormat[] }> {
    const std = standardPluginFolders().map((f) => ({ ...f, builtin: true }));
    const user = this.userFolders.map((p) => ({ path: p, builtin: false, formats: ['vst3', 'clap'] as PluginFormat[] }));
    const seen = new Set<string>();
    return [...std, ...user].filter((f) => {
      const k = norm(f.path);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  state(): PluginManagerState {
    const files: PluginFileEntry[] = [...this.cache.values()]
      .map((e) => ({
        path: e.path,
        format: e.format,
        status: this.blocked.has(norm(e.path)) ? ('blocked' as const) : e.status,
        message: this.blocked.get(norm(e.path))?.reason ?? e.message,
        plugins: e.plugins.map((p) => p.id),
        scannedAt: e.scannedAt,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      plugins: this.descriptors().sort((a, b) => a.name.localeCompare(b.name)),
      files,
      blocked: [...this.blocked.values()],
      folders: this.folders().map((f) => ({ path: f.path, builtin: f.builtin, exists: this.folderExists.get(norm(f.path)) ?? true })),
      scanning: !!this.scanning,
      progress: this.progress,
      lastScanAt: this.lastScanAt,
      vst2Found: this.vst2Found,
      hostAvailable: !HOST_UNSUPPORTED && !!findBinary(PLUGINHOST_EXE),
      ...(HOST_UNSUPPORTED ? { hostUnsupported: HOST_UNSUPPORTED } : {}),
      hostPid: this.hostPid,
      instances: this.instances,
    };
  }

  private emit(throttle = false): void {
    const send = (): void => {
      this.broadcastTimer = null;
      this.lastBroadcast = Date.now();
      try {
        this.deps.broadcast(this.state());
      } catch {
        /* a window mid-teardown */
      }
    };
    if (!throttle) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      send();
      return;
    }
    if (this.broadcastTimer) return;
    const wait = Math.max(0, 200 - (Date.now() - this.lastBroadcast));
    this.broadcastTimer = setTimeout(send, wait);
  }

  // ── Engine wiring ───────────────────────────────────────────────────

  attachEngine(engine: EngineSupervisor): void {
    this.engine = engine;
    engine.onEvent((e) => this.onEngineEvent(e));
  }

  /** Send host path, owner window and descriptors (before every loadProject). */
  /** Hand the plugin list to the engine. Returns a warning sentence when it didn't take (also logged), else null. */
  async syncEngine(): Promise<string | null> {
    const e = this.engine;
    if (!e) return null;
    const warn = (m: string): string => {
      this.deps.log('warn', m);
      return m;
    };
    try {
      const hostExe = this.hostExe();
      const owner = this.deps.ownerHwnd();
      const c = await e.request({ cmd: 'plugins.configure', ...(hostExe ? { hostExe } : {}), ...(owner ? { ownerHwnd: owner } : {}) }, 5000);
      if (!c.ok) return warn(`The engine couldn't set up the plugin host: ${c.message}`);
      const r = await e.request<{ registered: number; errors: string[] }>({ cmd: 'plugins.register', plugins: this.descriptors() }, 10_000);
      if (!r.ok) return warn(`The engine didn't accept the plugin list: ${r.message}`);
      if (r.data?.errors?.length) return warn(`The engine skipped ${r.data.errors.length} plugin(s): ${r.data.errors[0]}`);
      return null;
    } catch (err) {
      return warn(`The engine didn't get the plugin list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refreshStatus(): Promise<void> {
    const e = this.engine;
    if (!e || !e.isAlive()) {
      this.hostPid = null;
      this.instances = [];
      return;
    }
    const r = await e.request<{ hostPid: number | null; instances: PluginInstanceInfo[] }>({ cmd: 'plugins.status' }, 3000);
    if (r.ok && r.data) {
      this.hostPid = r.data.hostPid ?? null;
      this.instances = Array.isArray(r.data.instances) ? r.data.instances : [];
    }
  }

  private onEngineEvent(e: EngineEvent): void {
    if (e.event !== 'plugin') return;
    const ev = e as PluginEngineEvent;
    switch (ev.kind) {
      case 'crashed':
        // Error log lines become toasts in every window.
        this.deps.log('error', ev.message);
        void this.refreshStatus().then(() => this.emit());
        break;
      case 'loadFailed':
        this.deps.log('error', ev.message);
        void this.refreshStatus().then(() => this.emit());
        break;
      case 'editor':
        void this.refreshStatus().then(() => this.emit());
        break;
      case 'param':
        this.queueParam(ev.key, ev.paramId, ev.value);
        break;
    }
  }

  /** Edits made in a plugin's own window → the document (coalesced, ~20 Hz). */
  private queueParam(key: string, paramId: string, value: number): void {
    if (!Number.isFinite(value)) return;
    this.pendingParams.set(`${key}\u0000${paramId}`, { key, paramId, value });
    if (this.paramTimer) return;
    this.paramTimer = setTimeout(() => {
      this.paramTimer = null;
      const byKey = new Map<string, Record<string, number>>();
      for (const p of this.pendingParams.values()) {
        const m = byKey.get(p.key) ?? {};
        m[p.paramId] = p.value;
        byKey.set(p.key, m);
      }
      this.pendingParams.clear();
      const doc = this.deps.doc;
      for (const [key, params] of byKey) {
        const slash = key.indexOf('/');
        const [cmd, args] =
          slash >= 0 ? ['mixer.setSlotParams', { insertId: key.slice(0, slash), slotId: key.slice(slash + 1), params }] : ['channels.setGenParams', { id: key, params }];
        const r = doc.exec(cmd, args, { actor: USER, coalesceKey: `plugin-window:${key}`, label: 'Edit in plugin window' });
        if (!r.ok) this.deps.log('debug', `Plugin window edit not applied (${key}): ${r.message}`);
      }
    }, 50);
  }

  /** Before saving: store every live plugin's state in the document. */
  async beforeSave(): Promise<void> {
    const e = this.engine;
    if (!e || !e.isAlive()) return;
    const p = this.deps.doc.project;
    const uses =
      Object.values(p.channels).some((c) => c.generator.type.startsWith('vst3:') || c.generator.type.startsWith('clap:')) ||
      Object.values(p.mixer.inserts).some((i) => Object.values(i.slots).some((s) => s.type.startsWith('vst3:') || s.type.startsWith('clap:')));
    if (!uses) return;
    const r = await e.request<{ states: Record<string, string>; errors: string[] }>({ cmd: 'plugins.states' }, 20_000);
    if (!r.ok || !r.data) {
      this.deps.log('warn', `Couldn't read plugin states before saving: ${r.message ?? 'no reply'}; their previous state is kept`);
      return;
    }
    for (const err of r.data.errors ?? []) this.deps.log('warn', `Plugin state not saved: ${err}`);
    if (Object.keys(r.data.states).length) {
      const x = this.deps.doc.exec('plugins.setStates', { states: r.data.states }, { actor: SYSTEM });
      if (!x.ok) this.deps.log('warn', `Couldn't store plugin states: ${x.message}`);
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────

  rescan(opts: { full?: boolean; quiet?: boolean } = {}): Promise<ActionResult<PluginManagerState>> {
    if (this.scanning) return this.scanning;
    const run = this.doScan(!!opts.full, !!opts.quiet).finally(() => {
      this.scanning = null;
      this.progress = null;
      this.emit();
    });
    this.scanning = run;
    this.emit();
    return run;
  }

  private async doScan(full: boolean, quiet: boolean): Promise<ActionResult<PluginManagerState>> {
    const exe = this.hostExe();
    if (!exe) {
      const msg = HOST_UNSUPPORTED
        ? HOST_UNSUPPORTED
        : app.isPackaged
        ? `The plugin host (${PLUGINHOST_EXE}) is missing from this install. Reinstall Krypt Studio.`
        : 'The plugin host is not built yet. Run "npm run engine:build:debug".';
      return { ok: false, message: msg, data: this.state() };
    }
    const started = Date.now();
    const folders = this.folders();
    const candidates: PluginCandidate[] = [];
    for (const f of folders) {
      const ok = await dirExists(f.path);
      this.folderExists.set(norm(f.path), ok);
      if (ok) candidates.push(...(await findCandidates(f.path, f.formats)));
    }
    this.vst2Found = await countVst2(vst2Folders());
    // Dedupe (a folder can be inside another); keep the first (priority order).
    const seen = new Set<string>();
    const list = candidates.filter((c) => {
      const k = norm(c.path);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Forget files that disappeared.
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k);
    const todo = list.filter((c) => {
      const k = norm(c.path);
      if (this.blocked.has(k)) return false;
      const hit = this.cache.get(k);
      return full || !hit || hit.size !== c.size || hit.mtime !== c.mtime || hit.status === 'timeout';
    });
    let done = 0;
    this.progress = { done: 0, total: todo.length, current: null };
    this.emit();
    const queue = [...todo];
    let crashed = 0;
    let added = 0;
    const worker = async (): Promise<void> => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        this.progress = { done, total: todo.length, current: path.basename(c.path) };
        this.emit(true);
        await appendText(this.file('scan-journal.txt'), `${c.path}\n`).catch(() => {});
        const before = this.cache.get(norm(c.path))?.plugins.length ?? 0;
        const r = await runScanner(exe, c.path, SCAN_TIMEOUT_MS);
        const entry: CacheEntry = { path: c.path, format: c.format, size: c.size, mtime: c.mtime, status: 'ok', plugins: [], scannedAt: Date.now() };
        switch (r.kind) {
          case 'ok':
            entry.plugins = r.plugins;
            break;
          case 'failed':
            entry.status = r.plugins.length ? 'partial' : 'failed';
            entry.message = r.message;
            entry.plugins = r.plugins;
            break;
          case 'timeout':
            entry.status = 'timeout';
            entry.message = `${r.message}; it will be retried on the next scan`;
            entry.plugins = r.plugins;
            break;
          case 'crashed':
            // Crash → straight to the blocklist (kept across rescans; Retry in the Plugin Manager).
            entry.status = 'blocked';
            entry.message = r.message;
            entry.plugins = r.plugins;
            this.blocked.set(norm(c.path), { path: c.path, reason: r.message, at: Date.now() });
            crashed++;
            this.deps.log('warn', `Plugin Manager: ${path.basename(c.path)} crashed the scanner and was blocked (${r.message})`);
            break;
        }
        added += Math.max(0, entry.plugins.length - before);
        this.cache.set(norm(c.path), entry);
        done++;
        this.progress = { done, total: todo.length, current: null };
        this.emit(true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, todo.length)) }, worker));
    await removeFile(this.file('scan-journal.txt')).catch(() => {});
    this.lastScanAt = Date.now();
    await this.save();
    registerExternalPlugins(this.descriptors());
    const syncWarning = await this.syncEngine();
    const total = this.descriptors().length;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const msg =
      `Plugin scan finished in ${secs} s: ${total} plugin${total === 1 ? '' : 's'} installed` +
      (todo.length ? ` (${todo.length} file${todo.length === 1 ? '' : 's'} scanned${added ? `, ${added} new` : ''})` : ' (nothing changed)') +
      (crashed ? `; ${crashed} file${crashed === 1 ? '' : 's'} crashed and ${crashed === 1 ? 'was' : 'were'} blocked` : '') +
      (this.vst2Found ? `; ${this.vst2Found} VST2 file${this.vst2Found === 1 ? '' : 's'} skipped (VST2 is not supported)` : '');
    if (!quiet || crashed) this.deps.log('info', msg);
    if (syncWarning) return { ok: false, message: `${msg}. ${syncWarning}; use Settings ▸ Audio ▸ Restart engine to load them.`, data: this.state() };
    return { ok: true, message: msg, data: this.state() };
  }

  async addFolder(): Promise<ActionResult<PluginManagerState>> {
    const p = await this.deps.pickFolder();
    if (!p) return { ok: false, message: 'No folder chosen' };
    if (this.folders().some((f) => norm(f.path) === norm(p))) return { ok: false, message: `${p} is already scanned`, data: this.state() };
    this.userFolders.push(p);
    await this.save();
    const r = await this.rescan();
    return { ...r, message: `Added ${p}. ${r.message ?? ''}`.trim() };
  }

  async removeFolder(p: string): Promise<ActionResult<PluginManagerState>> {
    const before = this.userFolders.length;
    this.userFolders = this.userFolders.filter((f) => norm(f) !== norm(p));
    if (this.userFolders.length === before) return { ok: false, message: 'Only folders you added can be removed', data: this.state() };
    await this.save();
    const r = await this.rescan();
    return { ...r, message: `Removed ${p}. ${r.message ?? ''}`.trim() };
  }

  async unblock(p?: string): Promise<ActionResult<PluginManagerState>> {
    if (p) {
      if (!this.blocked.delete(norm(p))) return { ok: false, message: 'That file is not blocked', data: this.state() };
      this.cache.delete(norm(p));
    } else {
      if (this.blocked.size === 0) return { ok: true, message: 'The blocklist is already empty', data: this.state() };
      for (const k of this.blocked.keys()) this.cache.delete(k);
      this.blocked.clear();
    }
    await this.save();
    const r = await this.rescan();
    return { ...r, message: `${p ? `Unblocked ${path.basename(p)}` : 'Blocklist cleared'}. ${r.message ?? ''}`.trim() };
  }

  async openEditor(target: PluginTarget, open = true): Promise<ActionResult> {
    const e = this.engine;
    if (!e || !e.isAlive()) return { ok: false, message: "The audio engine isn't running" };
    const p = this.deps.doc.project;
    let key: string;
    let type: string;
    let title: string;
    if ('channelId' in target) {
      const ch = p.channels[target.channelId];
      if (!ch) return { ok: false, message: 'Channel not found' };
      key = ch.id;
      type = ch.generator.type;
      title = ch.name;
    } else {
      const ins = p.mixer.inserts[target.insertId];
      const slot = ins?.slots[target.slotId];
      if (!ins || !slot) return { ok: false, message: 'Effect slot not found' };
      key = `${ins.id}/${slot.id}`;
      type = slot.type;
      title = ins.isMaster ? 'Master' : ins.name;
    }
    if (!type.startsWith('vst3:') && !type.startsWith('clap:')) return { ok: false, message: 'Stock plugins use the built-in panel; only VST3/CLAP plugins have their own window' };
    const desc = this.deps.doc.catalog.plugins.find((d) => d.id === type);
    const name = desc?.name ?? type;
    const owner = this.deps.ownerHwnd();
    const r = await e.request({ cmd: 'plugins.editor', key, open, title: `${title} - ${name}`, ...(owner ? { ownerHwnd: owner } : {}) }, 30_000);
    void this.refreshStatus().then(() => this.emit());
    if (!r.ok) return { ok: false, message: r.message ?? `Couldn't open ${name}` };
    return { ok: true, message: open ? `Opened ${name}` : `Closed ${name}` };
  }

  async reload(): Promise<ActionResult> {
    const e = this.engine;
    if (!e || !e.isAlive()) return { ok: false, message: "The audio engine isn't running" };
    const r = await e.request({ cmd: 'plugins.reload' }, 15_000);
    setTimeout(() => void this.refreshStatus().then(() => this.emit()), 800);
    return r.ok ? { ok: true, message: 'Plugin host restarted; reloading plugins' } : { ok: false, message: r.message ?? "Couldn't reload plugins" };
  }

  async currentState(): Promise<PluginManagerState> {
    await this.refreshStatus();
    return this.state();
  }
}
