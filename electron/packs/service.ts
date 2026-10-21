import fs from 'node:fs';
import path from 'node:path';
import { PACKS } from '@shared/packs/catalog';
import { parsePackPath, type PackDef, type PackEntryState, type PackFile, type PackSample, type PacksState } from '@shared/packs/types';
import { SAMPLE_KINDS, type SampleKind } from '@shared/sounds/types';
import type { ActionResult, PackSamplesInfo } from '@shared/types';
import { describeFsError, readTextSync, writeFileAtomic } from '../system/files';
import { copyInto, dirExists, downloadFile, DownloadCancelled, listDir, makeDir, readJson, removeDir, renameDir, sha256File, statFile } from '../system/download';
import { freeBytes as diskFreeBytes } from './disk';
import { extractZipMembers } from './zip';

export interface PacksAccess {
  state(): PacksState;
  isInstalled(id: string): boolean;
  packName(id: string): string | undefined;
  samples?(): readonly PackSample[];
  sampleInfo?(): PackSamplesInfo;
}

export interface PacksServiceOptions {
  dir: string;
  catalog?: readonly PackDef[];
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  broadcast?(state: PacksState): void;
  onInstalled?(id: string): void;
  fetchImpl?: typeof fetch;
  stallMs?: number;
  freeBytes?(dir: string): Promise<number | null>;
  throttleMs?: number;
  now?(): number;
}

interface Transient {
  status: 'downloading' | 'failed';
  progress?: { bytes: number; total: number };
  error?: string;
  abort?: AbortController;
}

const STAGING_MARKER = '.krypt-partial.json';
const MANIFEST = 'pack.json';
const LICENCE_FILE = 'LICENSE.txt';
const RESERVED = new Set([MANIFEST.toLowerCase(), LICENCE_FILE.toLowerCase(), STAGING_MARKER.toLowerCase()]);
const DISK_MARGIN = 64 * 1024 * 1024;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}

export function packFilePath(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return null;
  if (!parsePackPath(`pack:x/${rel}`)) return null;
  if (rel.split('/').some((seg) => /[\\:*?"<>|\u0000-\u001f]/.test(seg) || seg !== seg.trim() || /\.$/.test(seg))) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, ...rel.split('/'));
  return full.startsWith(base + path.sep) ? full : null;
}

export function licenceText(def: PackDef): string {
  const l = def.licence;
  const lines = [
    `${def.name}: a sound pack for Krypt Studio (pack version ${def.version})`,
    '',
    `Recordings by: ${def.author}`,
    `Source: ${def.homepage}`,
    `Licence: ${l.name} (${l.spdx})`,
    `Licence text / statement: ${l.url}`,
    '',
    `Credit: ${l.attribution}`,
  ];
  if (l.statement) lines.push('', 'Archived statement:', '', l.statement.trim());
  lines.push(
    '',
    'The .sfz mapping files in this folder were written for Krypt Studio (MIT licence) and use only the files listed below.',
    'Krypt Studio downloaded each file from the address in its catalog and checked its size and SHA-256 before installing it.',
    '',
    'Files (SHA-256, bytes, path):',
    ...def.files.flatMap((f) =>
      f.archive
        ? [`${f.sha256.toLowerCase()}  ${f.bytes}  ${f.path} (a ZIP archive; deleted after these members were extracted from it)`, ...f.archive.members.map((m) => `${m.sha256.toLowerCase()}  ${m.bytes}  ${m.path} (from "${m.from}")`)]
        : [`${f.sha256.toLowerCase()}  ${f.bytes}  ${f.path}`],
    ),
    '',
  );
  return lines.join('\r\n');
}

export class PacksService implements PacksAccess {
  private readonly catalog: readonly PackDef[];
  private readonly byId: Map<string, PackDef>;
  private installed = new Map<string, number>();
  private transient = new Map<string, Transient>();
  private broadcastTimer: NodeJS.Timeout | null = null;
  private lastBroadcast = 0;
  private readonly now: () => number;
  private sampleCache: PackSample[] | null = null;

  constructor(private readonly opts: PacksServiceOptions) {
    this.catalog = opts.catalog ?? PACKS;
    this.byId = new Map(this.catalog.map((p) => [p.id, p]));
    this.now = opts.now ?? (() => Date.now());
    this.scanInstalled();
  }

  get dir(): string {
    return this.opts.dir;
  }

  def(id: string): PackDef | undefined {
    return this.byId.get(id);
  }

  packName(id: string): string | undefined {
    return this.byId.get(id)?.name;
  }

  isInstalled(id: string): boolean {
    return this.installed.has(id);
  }

  packDir(id: string): string | null {
    return this.installed.has(id) ? path.join(this.opts.dir, id) : null;
  }

  installedVersion(id: string): number | null {
    return this.installed.get(id) ?? null;
  }

  state(): PacksState {
    return { packs: this.catalog.map((d) => this.entry(d)), dir: this.opts.dir };
  }

  private entry(def: PackDef): PackEntryState {
    const t = this.transient.get(def.id);
    const version = this.installed.get(def.id);
    const status = t?.status === 'downloading' ? 'downloading' : version !== undefined ? (version < def.version ? 'update' : 'installed') : t?.status === 'failed' ? 'failed' : 'available';
    const e: PackEntryState = {
      id: def.id,
      name: def.name,
      description: def.description,
      author: def.author,
      licence: { ...def.licence },
      bytes: def.bytes,
      ramMb: def.ramMb,
      contents: [...def.contents],
      status,
    };
    if (status === 'downloading' && t?.progress) e.progress = { ...t.progress };
    if (t?.status === 'failed' && t.error) e.error = t.error;
    return e;
  }

  private notify(throttle = false): void {
    const send = (): void => {
      this.broadcastTimer = null;
      this.lastBroadcast = this.now();
      try {
        this.opts.broadcast?.(this.state());
      } catch {
      }
    };
    if (!throttle) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      send();
      return;
    }
    if (this.broadcastTimer) return;
    const wait = Math.max(0, (this.opts.throttleMs ?? 150) - (this.now() - this.lastBroadcast));
    this.broadcastTimer = setTimeout(send, wait);
    this.broadcastTimer.unref?.();
  }

  private scanInstalled(): void {
    const next = new Map<string, number>();
    for (const def of this.catalog) {
      const raw = readTextSync(path.join(this.opts.dir, def.id, MANIFEST));
      if (!raw) continue;
      try {
        const m = JSON.parse(raw) as { id?: unknown; version?: unknown };
        if (m.id === def.id && Number.isInteger(m.version) && (m.version as number) > 0) next.set(def.id, m.version as number);
        else this.opts.log('warn', `Sound pack ${def.name}: ${MANIFEST} doesn't describe this pack; treating it as not installed.`);
      } catch {
        this.opts.log('warn', `Sound pack ${def.name}: ${MANIFEST} isn't readable JSON; treating it as not installed.`);
      }
    }
    this.installed = next;
    this.sampleCache = null;
  }

  private static sampleOk(def: PackDef, s: PackSample): boolean {
    const pp = typeof s?.path === 'string' ? parsePackPath(s.path) : null;
    return !!pp && pp.packId === def.id && (SAMPLE_KINDS as readonly string[]).includes(s.kind) && typeof s.name === 'string' && !!s.name.trim() && Number.isFinite(s.lengthSec);
  }

  samples(): readonly PackSample[] {
    if (this.sampleCache) return this.sampleCache;
    const out: PackSample[] = [];
    const seen = new Set<string>();
    for (const def of this.catalog) {
      const version = this.installed.get(def.id);
      if (version === undefined || !def.samples?.length) continue;
      const root = path.join(this.opts.dir, def.id);
      for (const s of def.samples) {
        if (!PacksService.sampleOk(def, s) || seen.has(s.path)) continue;
        if (version < def.version) {
          const file = packFilePath(root, parsePackPath(s.path)!.path);
          if (!file || !fs.existsSync(file)) continue;
        }
        seen.add(s.path);
        out.push({ ...s, tags: s.tags.map((t) => t.toLowerCase()), genres: [...s.genres] });
      }
    }
    this.sampleCache = out;
    return out;
  }

  sampleInfo(): PackSamplesInfo {
    const packs = this.catalog
      .filter((def) => def.samples?.some((s) => PacksService.sampleOk(def, s)))
      .map((def) => {
        const byKind: Partial<Record<SampleKind, number>> = {};
        let count = 0;
        for (const s of def.samples!) {
          if (!PacksService.sampleOk(def, s)) continue;
          byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
          count++;
        }
        return { id: def.id, name: def.name, installed: this.installed.has(def.id), count, byKind };
      });
    return { packs, samples: [...this.samples()] };
  }

  async refresh(): Promise<void> {
    try {
      await makeDir(this.opts.dir);
      for (const name of await listDir(this.opts.dir)) {
        const old = /^([a-z0-9][a-z0-9-]*)\.old-\d+$/.exec(name);
        if (old) {
          const live = path.join(this.opts.dir, old[1]);
          const from = path.join(this.opts.dir, name);
          if (await dirExists(live)) await removeDir(from).catch((err) => this.opts.log('warn', `Couldn't remove the old copy ${name}: ${errText(err)}`));
          else await renameDir(from, live).catch((err) => this.opts.log('warn', `Couldn't restore ${name}: ${errText(err)}`));
          continue;
        }
        const partial = /^([a-z0-9][a-z0-9-]*)\.partial$/.exec(name);
        if (partial && !this.byId.has(partial[1]) && !this.transient.has(partial[1])) {
          await removeDir(path.join(this.opts.dir, name)).catch(() => {});
          this.opts.log('info', `Sound packs: removed an unfinished download of a pack that is no longer offered (${name})`);
        }
      }
    } catch (err) {
      this.opts.log('warn', `Sound packs: start-up check failed: ${errText(err)}`);
    }
    this.scanInstalled();
    this.notify();
  }

  private invalid(def: PackDef): string | null {
    if (!def.files.length) return `${def.name} has no files in this version's catalog.`;
    const seen = new Set<string>();
    for (const f of def.files) {
      if (!f.url) return `${def.name} can't be downloaded yet: ${f.path} has no published address.`;
      if (!/^[0-9a-f]{64}$/i.test(f.sha256) || !(f.bytes > 0)) return `${def.name} can't be downloaded yet: ${f.path} isn't published with a verified checksum and size.`;
      if (!packFilePath(this.opts.dir, f.path) || RESERVED.has(f.path.toLowerCase())) return `${def.name}'s catalog entry has an invalid file path "${f.path.slice(0, 120)}".`;
      if (seen.has(f.path.toLowerCase())) return `${def.name}'s catalog lists ${f.path} twice.`;
      seen.add(f.path.toLowerCase());
      if (f.archive) {
        if (f.archive.format !== 'zip') return `${def.name} can't be installed by this version of Krypt Studio: ${f.path} is a "${String(f.archive.format).slice(0, 20)}" archive.`;
        if (!f.archive.members?.length) return `${def.name}'s catalog entry lists no files to take from ${f.path}.`;
        for (const m of f.archive.members) {
          if (typeof m.from !== 'string' || !m.from || m.from.length > 400) return `${def.name}'s catalog entry has an invalid archive member in ${f.path}.`;
          if (!/^[0-9a-f]{64}$/i.test(m.sha256) || !(m.bytes > 0)) return `${def.name} can't be downloaded yet: ${m.path} isn't published with a verified checksum and size.`;
          if (!packFilePath(this.opts.dir, m.path) || RESERVED.has(m.path.toLowerCase())) return `${def.name}'s catalog entry has an invalid file path "${String(m.path).slice(0, 120)}" (it would be written outside the pack folder).`;
          if (seen.has(m.path.toLowerCase())) return `${def.name}'s catalog lists ${m.path} twice.`;
          seen.add(m.path.toLowerCase());
        }
      }
    }
    for (const s of def.sfz) {
      if (!packFilePath(this.opts.dir, s.path) || RESERVED.has(s.path.toLowerCase()) || seen.has(s.path.toLowerCase())) return `${def.name}'s catalog entry has an invalid mapping path "${s.path.slice(0, 120)}".`;
      seen.add(s.path.toLowerCase());
    }
    return null;
  }

  async install(id: string): Promise<ActionResult<PacksState>> {
    const def = this.byId.get(String(id ?? ''));
    if (!def) return { ok: false, message: `There's no sound pack called "${String(id ?? '').slice(0, 60)}" in this version of Krypt Studio.`, data: this.state() };
    const have = this.installed.get(def.id);
    if (have !== undefined && have >= def.version) return { ok: true, message: `${def.name} is already installed.`, data: this.state() };
    if (this.transient.get(def.id)?.status === 'downloading') return { ok: false, message: `${def.name} is already downloading.`, data: this.state() };
    const why = this.invalid(def);
    if (why) {
      this.transient.set(def.id, { status: 'failed', error: why });
      this.notify();
      return { ok: false, message: why, data: this.state() };
    }

    const updating = have !== undefined;
    const abort = new AbortController();
    const total = def.files.reduce((s, f) => s + f.bytes, 0);
    const t: Transient = { status: 'downloading', progress: { bytes: 0, total }, abort };
    this.transient.set(def.id, t);
    this.notify();

    const staging = path.join(this.opts.dir, `${def.id}.partial`);
    const finalDir = path.join(this.opts.dir, def.id);
    const started = this.now();
    let fetched = 0;
    try {
      await this.prepareStaging(def, staging);
      let done = 0;
      const todo: PackFile[] = [];
      const unpackOnly: PackFile[] = [];
      for (const f of def.files) {
        const dest = packFilePath(staging, f.path)!;
        if (f.archive) {
          if (await this.membersIn(staging, f)) {
            await removeDir(dest).catch(() => {});
            done += f.bytes;
            continue;
          }
          if (updating && (await this.membersIn(finalDir, f))) {
            for (const m of f.archive.members) {
              const to = packFilePath(staging, m.path)!;
              if (!(await this.matches(to, m))) await copyInto(packFilePath(finalDir, m.path)!, to);
            }
            if (await this.membersIn(staging, f)) {
              done += f.bytes;
              continue;
            }
          }
          if (await this.matches(dest, f)) {
            unpackOnly.push(f);
            done += f.bytes;
            continue;
          }
          await removeDir(dest).catch(() => {});
          todo.push(f);
          continue;
        }
        if (await this.matches(dest, f)) {
          done += f.bytes;
          continue;
        }
        await removeDir(dest).catch(() => {});
        const old = updating ? packFilePath(finalDir, f.path) : null;
        if (old && (await this.matches(old, f))) {
          await copyInto(old, dest);
          if (await this.matches(dest, f)) {
            done += f.bytes;
            continue;
          }
          await removeDir(dest).catch(() => {});
        }
        todo.push(f);
      }
      t.progress = { bytes: done, total };
      this.notify(true);

      const extracted = (f: PackFile) => (f.archive ? f.archive.members.reduce((s, m) => s + m.bytes, 0) : 0);
      const need = todo.reduce((s, f) => s + f.bytes + extracted(f), 0) + unpackOnly.reduce((s, f) => s + extracted(f), 0);
      const free = await (this.opts.freeBytes ?? diskFreeBytes)(this.opts.dir).catch(() => null);
      if (free !== null && need > 0 && free < need + DISK_MARGIN) {
        throw new Error(`Not enough disk space: ${def.name} needs ${fmtSize(need + DISK_MARGIN)} free and the disk with ${this.opts.dir} has ${fmtSize(free)}. Free some space, then click Download again.`);
      }

      for (const f of unpackOnly) await this.unpack(def, f, staging, abort.signal);
      for (const f of todo) {
        await this.fetchFile(def, f, packFilePath(staging, f.path)!, abort.signal, (received) => {
          t.progress = { bytes: done + received, total };
          this.notify(true);
        });
        if (f.archive) await this.unpack(def, f, staging, abort.signal);
        done += f.bytes;
        fetched += f.bytes;
        t.progress = { bytes: done, total };
        this.notify(true);
      }

      try {
        for (const s of def.sfz) await writeFileAtomic(packFilePath(staging, s.path)!, s.text);
        await writeFileAtomic(path.join(staging, LICENCE_FILE), licenceText(def));
        await writeFileAtomic(path.join(staging, MANIFEST), `${JSON.stringify({ id: def.id, version: def.version, installedAt: new Date(this.now()).toISOString() }, null, 1)}\n`);
        await removeDir(path.join(staging, STAGING_MARKER));
      } catch (err) {
        throw new Error((err as NodeJS.ErrnoException)?.code ? describeFsError(err, staging) : errText(err));
      }
      if (abort.signal.aborted) throw new DownloadCancelled();
      await this.commit(staging, finalDir);
      this.installed.set(def.id, def.version);
      this.sampleCache = null;
      this.transient.delete(def.id);
      const secs = Math.max(0, Math.round((this.now() - started) / 1000));
      const what = updating ? 'Updated' : 'Installed';
      this.opts.log('info', `${what} sound pack ${def.name} v${def.version} (${fmtSize(fetched)} downloaded${fetched < total ? `, ${fmtSize(total - fetched)} reused` : ''}, ${secs} s)`);
      try {
        this.opts.onInstalled?.(def.id);
      } catch (err) {
        this.opts.log('warn', `After installing ${def.name}: ${errText(err)}`);
      }
      const sounds = this.samples().filter((x) => x.path.startsWith(`pack:${def.id}/`)).length;
      const ready = [def.sfz.length ? 'Its presets are ready in the preset browser.' : '', sounds ? `Its ${sounds} sound${sounds === 1 ? '' : 's'} are in the Browser under Sound packs.` : ''].filter(Boolean).join(' ');
      return { ok: true, message: `${what} ${def.name} (${fmtSize(total)}).${ready ? ` ${ready}` : ''}`, data: this.state() };
    } catch (err) {
      if (err instanceof DownloadCancelled || abort.signal.aborted) {
        this.transient.delete(def.id);
        this.opts.log('info', `Sound pack ${def.name}: download cancelled`);
        return { ok: false, message: `${def.name} download cancelled. Files that finished are kept, so Download continues where it stopped.`, data: this.state() };
      }
      const message = errText(err);
      this.transient.set(def.id, { status: 'failed', error: message });
      this.opts.log('warn', `Installing sound pack ${def.name} failed: ${message}`);
      return { ok: false, message: `Couldn't ${updating ? 'update' : 'install'} ${def.name}: ${message}`, data: this.state() };
    } finally {
      this.notify();
    }
  }

  private async prepareStaging(def: PackDef, staging: string): Promise<void> {
    try {
      const marker = await readJson<{ id?: string; version?: number }>(path.join(staging, STAGING_MARKER));
      if (!marker || marker.id !== def.id || marker.version !== def.version) await removeDir(staging);
      await makeDir(staging);
      await writeFileAtomic(path.join(staging, STAGING_MARKER), JSON.stringify({ id: def.id, version: def.version }));
    } catch (err) {
      throw new Error(`Couldn't prepare the download folder: ${describeFsError(err, staging)}`);
    }
  }

  private async matches(file: string, f: Pick<PackFile, 'bytes' | 'sha256'>): Promise<boolean> {
    const st = await statFile(file);
    if (!st || st.size !== f.bytes) return false;
    try {
      return (await sha256File(file)) === f.sha256.toLowerCase();
    } catch {
      return false;
    }
  }

  private async membersIn(root: string, f: PackFile): Promise<boolean> {
    for (const m of f.archive?.members ?? []) {
      const p = packFilePath(root, m.path);
      if (!p || !(await this.matches(p, m))) return false;
    }
    return !!f.archive?.members.length;
  }

  private async unpack(def: PackDef, f: PackFile, staging: string, signal: AbortSignal): Promise<void> {
    const arc = packFilePath(staging, f.path)!;
    const members = f.archive!.members.map((m) => ({ from: m.from, dest: packFilePath(staging, m.path)!, sha256: m.sha256.toLowerCase(), bytes: m.bytes }));
    try {
      await extractZipMembers(arc, members, { signal, done: (m) => this.matches(m.dest, m) });
    } catch (err) {
      if (err instanceof DownloadCancelled || signal.aborted) throw new DownloadCancelled();
      for (const m of members) await removeDir(m.dest).catch(() => {});
      await removeDir(arc).catch(() => {});
      const why = errText(err).replace(/\.$/, '');
      this.opts.log('warn', `Sound pack ${def.name}: extracting ${f.path} failed (${why})`);
      throw new Error(`${f.path} couldn't be unpacked: ${why}. Nothing was installed.`);
    }
    try {
      await removeDir(arc);
    } catch (err) {
      this.opts.log('warn', `Sound pack ${def.name}: couldn't delete the archive ${f.path} after extracting it: ${errText(err)}`);
    }
    const parent = path.dirname(arc);
    if (parent !== path.resolve(staging) && (await listDir(parent)).length === 0) await removeDir(parent).catch(() => {});
  }

  private async fetchFile(def: PackDef, f: PackFile, dest: string, signal: AbortSignal, onReceived: (n: number) => void): Promise<void> {
    const sources = [f.url, ...(f.mirrors ?? [])].filter(Boolean);
    const failures: Array<{ host: string; message: string }> = [];
    for (const url of sources) {
      try {
        const r = await downloadFile(url, dest, {
          signal,
          expectedBytes: f.bytes,
          fetchImpl: this.opts.fetchImpl,
          stallMs: this.opts.stallMs,
          onProgress: (received) => onReceived(Math.min(received, f.bytes)),
        });
        if (r.sha256 !== f.sha256.toLowerCase()) throw new Error(`${f.path} failed verification (SHA-256 mismatch): the download is damaged or the file changed on the server`);
        if (r.bytes !== f.bytes) throw new Error(`${f.path} has the wrong size (${r.bytes} bytes, expected ${f.bytes})`);
        return;
      } catch (err) {
        if (err instanceof DownloadCancelled || signal.aborted) throw new DownloadCancelled();
        await removeDir(dest).catch(() => {});
        failures.push({ host: hostOf(url), message: errText(err) });
        if (sources.length > 1) this.opts.log('warn', `Sound pack ${def.name}: ${f.path} from ${hostOf(url)} failed (${errText(err)})${failures.length < sources.length ? '; trying the next source' : ''}`);
      }
    }
    const tail = 'Nothing was installed; the files that finished are kept for the next try.';
    if (failures.length === 1) throw new Error(`${failures[0].message.replace(/\.$/, '')}. ${tail}`);
    throw new Error(`${f.path} couldn't be downloaded from any of its ${sources.length} sources (${failures.map((x) => `${x.host}: ${x.message.replace(/\.$/, '')}`).join('; ')}). ${tail}`);
  }

  private async commit(staging: string, finalDir: string): Promise<void> {
    let aside: string | null = null;
    try {
      if (await dirExists(finalDir)) {
        aside = `${finalDir}.old-${this.now()}`;
        await renameDir(finalDir, aside);
      }
      await renameDir(staging, finalDir);
    } catch (err) {
      if (aside && !(await dirExists(finalDir))) await renameDir(aside, finalDir).catch(() => {});
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new Error(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' ? `Windows kept the pack folder locked (${code}). Close anything using ${finalDir} and click Download again; the downloaded files are kept.` : describeFsError(err, finalDir));
    }
    if (aside) await removeDir(aside).catch((err) => this.opts.log('warn', `Couldn't remove the previous version (${aside}): ${errText(err)}; it is removed at the next start.`));
  }

  cancel(id: string): ActionResult {
    const def = this.byId.get(String(id ?? ''));
    const t = def ? this.transient.get(def.id) : undefined;
    if (!def || t?.status !== 'downloading' || !t.abort) return { ok: false, message: `${def?.name ?? 'That pack'} isn't downloading.` };
    t.abort.abort();
    return { ok: true, message: `Cancelling the ${def.name} download…` };
  }

  async remove(id: string): Promise<ActionResult<PacksState>> {
    const def = this.byId.get(String(id ?? ''));
    if (!def) return { ok: false, message: `There's no sound pack called "${String(id ?? '').slice(0, 60)}".`, data: this.state() };
    if (this.transient.get(def.id)?.status === 'downloading') return { ok: false, message: `${def.name} is downloading; cancel it first.`, data: this.state() };
    const finalDir = path.join(this.opts.dir, def.id);
    const staging = path.join(this.opts.dir, `${def.id}.partial`);
    const hadFinal = await dirExists(finalDir);
    const hadPartial = await dirExists(staging);
    if (!hadFinal && !hadPartial) {
      const failed = this.transient.delete(def.id);
      if (failed) this.notify();
      return { ok: false, message: `${def.name} isn't installed.`, data: this.state() };
    }
    try {
      if (hadFinal) await removeDir(finalDir);
      if (hadPartial) await removeDir(staging);
    } catch (err) {
      this.scanInstalled();
      this.notify();
      const code = (err as NodeJS.ErrnoException)?.code;
      return {
        ok: false,
        message: `Couldn't remove ${def.name}: ${code === 'EPERM' || code === 'EBUSY' ? 'a file in it is in use. Close projects that play it (or restart Krypt Studio) and try again.' : describeFsError(err, finalDir)}`,
        data: this.state(),
      };
    }
    this.installed.delete(def.id);
    this.sampleCache = null;
    this.transient.delete(def.id);
    this.notify();
    this.opts.log('info', `Removed sound pack ${def.name}`);
    return { ok: true, message: hadFinal ? `Removed ${def.name}. Channels that use it stay silent until you download it again.` : `Removed the unfinished ${def.name} download.`, data: this.state() };
  }
}
