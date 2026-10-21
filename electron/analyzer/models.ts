import path from 'node:path';
import { MODEL_CATALOG, type ModelDef } from '@shared/analyzer/models';
import type { ActionResult, ModelState } from '@shared/types';
import { writeFileAtomic } from '../system/files';
import {
  copyInto,
  dirExists,
  downloadFile,
  DownloadCancelled,
  listDir,
  makeDir,
  readJson,
  removeDir,
  renameDir,
  sha256File,
  statFile,
} from '../system/download';

export interface ModelManagerOptions {
  catalog?: readonly ModelDef[];
  bundledDirs: string[];
  userModelsDir: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  onChange?(): void;
  pickFolder?(title: string): Promise<string | null>;
  fetchImpl?: typeof fetch;
  bundledMissingMessage?: string;
}

interface VerifiedEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface Transient {
  status: 'downloading' | 'verifying' | 'failed';
  progress?: { received: number; total: number };
  message?: string;
  abort?: AbortController;
}

const CACHE_FILE = 'verified.json';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
const keyOf = (p: string): string => path.resolve(p).toLowerCase();

export function shortModelName(def: ModelDef): string {
  return def.name.replace(/\s*\([^)]*\)\s*$/, '') || def.name;
}

export class ModelManager {
  private readonly catalog: readonly ModelDef[];
  private verified = new Map<string, VerifiedEntry>();
  private installedDir = new Map<string, string>();
  private transient = new Map<string, Transient>();
  private refreshing: Promise<void> | null = null;
  private cacheDirty = false;

  constructor(private readonly opts: ModelManagerOptions) {
    this.catalog = opts.catalog ?? MODEL_CATALOG;
  }

  get modelsDir(): string {
    return this.opts.userModelsDir;
  }

  defs(): readonly ModelDef[] {
    return this.catalog;
  }

  def(id: string): ModelDef | undefined {
    return this.catalog.find((m) => m.id === id);
  }

  defaultFor(task: ModelDef['task']): ModelDef | undefined {
    return this.catalog.find((m) => m.task === task && m.default) ?? this.catalog.find((m) => m.task === task);
  }

  private notInstallable(def: ModelDef): { importable: boolean; message: string } | null {
    if (def.files.length === 0 || def.files.some((f) => !/^[0-9a-f]{64}$/i.test(f.sha256))) {
      return { importable: false, message: `${def.name} isn't available in this version yet: its files aren't published with verified checksums.` };
    }
    if (def.files.some((f) => !f.url)) {
      return {
        importable: true,
        message: def.bundled
          ? this.opts.bundledMissingMessage ?? `${def.name} ships with Krypt Studio, but its files are missing or damaged. Reinstall Krypt Studio, or use Install from folder.`
          : 'No download published yet — use Install from folder.',
      };
    }
    return null;
  }

  state(id: string): ModelState | null {
    const def = this.def(id);
    return def ? this.stateOf(def) : null;
  }

  states(): ModelState[] {
    return this.catalog.map((d) => this.stateOf(d));
  }

  private stateOf(def: ModelDef): ModelState {
    const t = this.transient.get(def.id);
    if (t && (t.status === 'downloading' || t.status === 'verifying')) {
      const s: ModelState = { def, status: t.status };
      if (t.progress) s.progress = { ...t.progress };
      return s;
    }
    const dir = this.installedDir.get(def.id);
    if (dir) return { def, status: 'installed', dir };
    if (t?.status === 'failed') return { def, status: 'failed', message: t.message };
    const why = this.notInstallable(def);
    if (why) return { def, status: 'unavailable', message: why.message };
    return { def, status: 'available' };
  }

  dirFor(id: string): string | null {
    return this.installedDir.get(id) ?? null;
  }

  private changed(): void {
    try {
      this.opts.onChange?.();
    } catch {
    }
  }

  private candidates(def: ModelDef): string[] {
    const out: string[] = [];
    if (def.bundled) for (const d of this.opts.bundledDirs) out.push(path.join(d, def.id));
    out.push(path.join(this.opts.userModelsDir, def.id));
    return out;
  }

  private async verifyDir(def: ModelDef, dir: string, useCache = true): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!(await dirExists(dir))) return { ok: false, message: `${dir} doesn't exist` };
    for (const f of def.files) {
      const file = path.join(dir, f.name);
      const st = await statFile(file);
      if (!st) return { ok: false, message: `${f.name} is missing` };
      if (f.bytes > 0 && st.size !== f.bytes) return { ok: false, message: `${f.name} has the wrong size (${st.size} bytes, expected ${f.bytes})` };
      const k = keyOf(file);
      const hit = this.verified.get(k);
      let sha: string;
      if (useCache && hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) sha = hit.sha256;
      else {
        sha = await sha256File(file);
        this.verified.set(k, { size: st.size, mtimeMs: st.mtimeMs, sha256: sha });
        this.cacheDirty = true;
      }
      if (sha.toLowerCase() !== f.sha256.toLowerCase()) return { ok: false, message: `${f.name} failed verification (SHA-256 mismatch)` };
    }
    return { ok: true };
  }

  private async loadCache(): Promise<void> {
    const c = await readJson<{ version: number; files: Record<string, VerifiedEntry> }>(path.join(this.opts.userModelsDir, CACHE_FILE));
    if (!c || c.version !== 1 || !c.files) return;
    for (const [k, v] of Object.entries(c.files)) {
      if (v && typeof v.sha256 === 'string' && typeof v.size === 'number' && typeof v.mtimeMs === 'number') this.verified.set(k, v);
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    try {
      await writeFileAtomic(path.join(this.opts.userModelsDir, CACHE_FILE), JSON.stringify({ version: 1, files: Object.fromEntries(this.verified) }));
    } catch (err) {
      this.opts.log('warn', `Model Manager couldn't save its verification cache: ${errText(err)}`);
    }
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const run = (async () => {
      await makeDir(this.opts.userModelsDir).catch(() => {});
      if (this.verified.size === 0) await this.loadCache();
      for (const name of await listDir(this.opts.userModelsDir)) {
        if (!/\.partial$/i.test(name)) continue;
        const id = name.replace(/\.partial$/i, '');
        if (this.transient.get(id)?.status === 'downloading' || this.transient.get(id)?.status === 'verifying') continue;
        await removeDir(path.join(this.opts.userModelsDir, name)).catch((err) => this.opts.log('warn', `Couldn't remove the unfinished download ${name}: ${errText(err)}`));
        this.opts.log('info', `Model Manager: removed an unfinished download (${name})`);
      }
      for (const def of this.catalog) {
        if (this.notInstallable(def)?.importable === false) {
          this.installedDir.delete(def.id);
          continue;
        }
        let found: string | null = null;
        const problems: string[] = [];
        for (const dir of this.candidates(def)) {
          const r = await this.verifyDir(def, dir);
          if (r.ok) {
            found = dir;
            break;
          }
          if (!/doesn't exist$/.test(r.message)) problems.push(`${dir}: ${r.message}`);
        }
        if (found) this.installedDir.set(def.id, found);
        else this.installedDir.delete(def.id);
        if (!found && problems.length) this.opts.log('warn', `Model ${def.name} is not usable: ${problems.join('; ')}`);
      }
      await this.saveCache();
    })()
      .catch((err) => this.opts.log('error', `Model Manager refresh failed: ${errText(err)}`))
      .finally(() => {
        this.refreshing = null;
        this.changed();
      });
    this.refreshing = run;
    return run;
  }

  async install(id: string): Promise<ActionResult> {
    const def = this.def(id);
    if (!def) return { ok: false, message: `Unknown model "${id}"` };
    if (this.installedDir.has(id)) return { ok: true, message: `${def.name} is already installed` };
    const busy = this.transient.get(id);
    if (busy && (busy.status === 'downloading' || busy.status === 'verifying')) return { ok: false, message: `${def.name} is already being installed` };
    const why = this.notInstallable(def);
    if (why) return { ok: false, message: why.message };

    const abort = new AbortController();
    const total = def.files.reduce((s, f) => s + Math.max(0, f.bytes), 0);
    const t: Transient = { status: 'downloading', progress: { received: 0, total }, abort };
    this.transient.set(id, t);
    this.changed();

    const staging = path.join(this.opts.userModelsDir, `${id}.partial`);
    const finalDir = path.join(this.opts.userModelsDir, id);
    const started = Date.now();
    try {
      await removeDir(staging);
      await makeDir(staging);
      let done = 0;
      for (const f of def.files) {
        const dest = path.join(staging, f.name);
        if (path.dirname(path.resolve(dest)) !== path.resolve(staging)) throw new Error(`Catalog entry for ${def.name} has an invalid file name "${f.name}"`);
        const sources = [f.url, ...(f.mirrors ?? [])].filter(Boolean);
        const failures: Array<{ host: string; err: unknown }> = [];
        let got: { bytes: number } | null = null;
        for (const url of sources) {
          try {
            const r = await downloadFile(url, dest, {
              signal: abort.signal,
              expectedBytes: f.bytes,
              fetchImpl: this.opts.fetchImpl,
              onProgress: (received, fileTotal) => {
                t.progress = { received: done + received, total: Math.max(total, done + fileTotal) };
                this.changed();
              },
            });
            if (r.sha256.toLowerCase() !== f.sha256.toLowerCase()) {
              throw new Error(`${f.name} failed verification (SHA-256 mismatch): the download is damaged or the file changed on the server. Nothing was installed.`);
            }
            if (f.bytes > 0 && r.bytes !== f.bytes) throw new Error(`${f.name} has the wrong size (${r.bytes} bytes, expected ${f.bytes}). Nothing was installed.`);
            got = r;
            break;
          } catch (err) {
            if (err instanceof DownloadCancelled || abort.signal.aborted) throw err;
            const host = (() => {
              try {
                return new URL(url).host;
              } catch {
                return url;
              }
            })();
            failures.push({ host, err });
            await removeDir(dest).catch(() => {});
            if (sources.length > 1) this.opts.log('warn', `Downloading ${f.name} from ${host} failed (${errText(err)})${failures.length < sources.length ? '; trying the next source' : ''}`);
          }
        }
        if (!got) {
          if (failures.length === 1) throw failures[0].err;
          const why = failures.map((x) => `${x.host}: ${errText(x.err).replace(/ Nothing was installed\.$/, '')}`).join('; ');
          throw new Error(`${f.name} couldn't be downloaded from any of its ${sources.length} sources (${why}). Nothing was installed.`);
        }
        done += got.bytes;
      }
      t.status = 'verifying';
      this.changed();
      const check = await this.verifyDir(def, staging, false);
      if (!check.ok) throw new Error(`${check.message}. Nothing was installed.`);
      await writeFileAtomic(path.join(staging, 'manifest.json'), JSON.stringify({ id: def.id, name: def.name, task: def.task, license: def.license, files: def.files, installedAt: new Date().toISOString(), source: 'download' }, null, 1));
      await this.commit(def, staging, finalDir);
      this.transient.delete(id);
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      this.opts.log('info', `Installed ${def.name} (${mb(done)}, ${secs} s)`);
      return { ok: true, message: `Installed ${def.name} (${mb(done)})` };
    } catch (err) {
      await removeDir(staging).catch(() => {});
      if (err instanceof DownloadCancelled || abort.signal.aborted) {
        this.transient.delete(id);
        return { ok: false, message: `${def.name} download cancelled` };
      }
      const message = errText(err);
      this.transient.set(id, { status: 'failed', message });
      this.opts.log('warn', `Installing ${def.name} failed: ${message}`);
      return { ok: false, message: `Couldn't install ${def.name}: ${message}` };
    } finally {
      this.changed();
    }
  }

  private async commit(def: ModelDef, staging: string, finalDir: string): Promise<void> {
    if (await dirExists(finalDir)) await removeDir(finalDir);
    await renameDir(staging, finalDir);
    for (const f of def.files) {
      const st = await statFile(path.join(finalDir, f.name));
      if (st) this.verified.set(keyOf(path.join(finalDir, f.name)), { size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256.toLowerCase() });
    }
    this.cacheDirty = true;
    await this.saveCache();
    this.installedDir.set(def.id, finalDir);
  }

  cancelInstall(id: string): ActionResult {
    const def = this.def(id);
    const t = this.transient.get(id);
    if (!def || !t || (t.status !== 'downloading' && t.status !== 'verifying') || !t.abort) return { ok: false, message: `${def?.name ?? id} isn't being downloaded` };
    t.abort.abort();
    return { ok: true, message: `Cancelling the ${def.name} download…` };
  }

  async importModel(id: string, folder?: string): Promise<ActionResult> {
    const def = this.def(id);
    if (!def) return { ok: false, message: `Unknown model "${id}"` };
    const why = this.notInstallable(def);
    if (why && !why.importable) return { ok: false, message: why.message };
    if (this.installedDir.has(id)) return { ok: true, message: `${def.name} is already installed` };
    const busy = this.transient.get(id);
    if (busy && (busy.status === 'downloading' || busy.status === 'verifying')) return { ok: false, message: `${def.name} is already being installed` };
    let src = folder ?? null;
    if (!src) {
      if (!this.opts.pickFolder) return { ok: false, message: 'No folder picker available' };
      src = await this.opts.pickFolder(`Folder with the ${def.name} files (${def.files.map((f) => f.name).join(', ')})`);
      if (!src) return { ok: false, message: 'No folder chosen' };
    }
    if (!(await statFile(path.join(src, def.files[0].name))) && (await dirExists(path.join(src, def.id)))) src = path.join(src, def.id);

    this.transient.set(id, { status: 'verifying' });
    this.changed();
    const staging = path.join(this.opts.userModelsDir, `${id}.partial`);
    try {
      for (const f of def.files) {
        const file = path.join(src, f.name);
        const st = await statFile(file);
        if (!st) throw new Error(`The folder has no ${f.name}. Pick the folder that contains ${def.files.map((x) => x.name).join(', ')}.`);
        const sha = await sha256File(file);
        if (sha !== f.sha256.toLowerCase()) throw new Error(`${f.name} in that folder isn't the ${def.name} file Krypt Studio expects (SHA-256 mismatch). Nothing was installed.`);
      }
      await removeDir(staging);
      await makeDir(staging);
      for (const f of def.files) await copyInto(path.join(src, f.name), path.join(staging, f.name));
      const check = await this.verifyDir(def, staging, false);
      if (!check.ok) throw new Error(`Copying failed verification: ${check.message}. Nothing was installed.`);
      await writeFileAtomic(path.join(staging, 'manifest.json'), JSON.stringify({ id: def.id, name: def.name, task: def.task, license: def.license, files: def.files, installedAt: new Date().toISOString(), source: 'folder' }, null, 1));
      await this.commit(def, staging, path.join(this.opts.userModelsDir, id));
      this.transient.delete(id);
      this.opts.log('info', `Installed ${def.name} from ${src}`);
      return { ok: true, message: `Installed ${def.name} from the folder` };
    } catch (err) {
      await removeDir(staging).catch(() => {});
      const message = errText(err);
      this.transient.set(id, { status: 'failed', message });
      return { ok: false, message };
    } finally {
      this.changed();
    }
  }

  async remove(id: string): Promise<ActionResult> {
    const def = this.def(id);
    if (!def) return { ok: false, message: `Unknown model "${id}"` };
    const dir = this.installedDir.get(id);
    const userDir = path.join(this.opts.userModelsDir, id);
    if (def.bundled && (!dir || keyOf(dir) !== keyOf(userDir))) return { ok: false, message: `${def.name} ships with Krypt Studio and can't be removed` };
    const busy = this.transient.get(id);
    if (busy && (busy.status === 'downloading' || busy.status === 'verifying')) return { ok: false, message: `${def.name} is being installed; cancel that first` };
    if (!dir && !(await dirExists(userDir))) {
      if (busy?.status === 'failed') {
        this.transient.delete(id);
        this.changed();
      }
      return { ok: false, message: `${def.name} isn't installed` };
    }
    try {
      await removeDir(userDir);
    } catch (err) {
      return { ok: false, message: `Couldn't remove ${def.name}: ${errText(err)}` };
    }
    for (const k of [...this.verified.keys()]) if (k.startsWith(keyOf(userDir) + path.sep)) this.verified.delete(k);
    this.cacheDirty = true;
    await this.saveCache();
    this.installedDir.delete(id);
    this.transient.delete(id);
    if (def.bundled) await this.refresh();
    this.changed();
    this.opts.log('info', `Removed ${def.name}`);
    return { ok: true, message: `Removed ${def.name}` };
  }
}
