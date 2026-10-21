import path from 'node:path';
import fsp from 'node:fs/promises';
import { applyPatches, type Patch } from 'immer';
import { checkIntegrity, COVER_FILE_RE, type Project } from '@shared/schema/project';
import { appendText, exists, mtimeMs, readBytes, readText, removeFile, removeFileSync, writeFileAtomic, writeFileAtomicSync } from '../system/files';
import { decodeContainer, encodeContainer } from './container';
import { validateProject } from './migrations';

export interface RecoveryInfo {
  docVersion: number;
  savedVersion: number;
  projectPath: string | null;
  tabId?: string | null;
  gen: number;
  savedAt: number;
}

type JournalLine =
  | { v: number; p: Patch[] }
  | { v: number; saved: true; path: string | null };

export interface RecoveredSession {
  project: Project;
  assets: Record<string, Uint8Array>;
  projectPath: string | null;
  tabId: string | null;
  dirty: boolean;
  editedAt: number;
}

export class RecoveryStore {
  private gen = 0;
  private buffer: Array<{ gen: number; line: string }> = [];
  private flushing: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private snapshotChain: Promise<void> = Promise.resolve();
  snapshotVersion = -1;

  constructor(
    private readonly dir: string,
    private readonly appVersion: string,
    private readonly log: (level: 'info' | 'warn' | 'error', m: string) => void,
  ) {}

  private get lockFile(): string {
    return path.join(this.dir, 'session.lock');
  }
  private get snapshotFile(): string {
    return path.join(this.dir, 'current.kstudio');
  }
  private journalFile(gen: number): string {
    return path.join(this.dir, `journal-${gen}.ndjson`);
  }
  private get assetDir(): string {
    return path.join(this.dir, 'assets');
  }

  saveAsset(name: string, bytes: Uint8Array): Promise<void> {
    if (!COVER_FILE_RE.test(name)) return Promise.resolve();
    const file = path.join(this.assetDir, name);
    if (exists(file)) return Promise.resolve();
    return writeFileAtomic(file, bytes).catch((err) => this.log('warn', `Crash recovery couldn't keep the cover image: ${(err as Error).message}`));
  }

  crashedLastTime(): boolean {
    return exists(this.lockFile);
  }

  begin(): void {
    try {
      writeFileAtomicSync(this.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } catch (err) {
      this.log('warn', `Crash recovery is disabled: couldn't write ${this.lockFile} (${(err as Error).message})`);
    }
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.flushTimer.unref?.();
  }

  appendChange(version: number, patches: Patch[]): void {
    this.push({ v: version, p: patches });
  }

  appendSaved(version: number, projectPath: string | null): void {
    this.push({ v: version, saved: true, path: projectPath });
  }

  private push(line: JournalLine): void {
    try {
      this.buffer.push({ gen: this.gen, line: JSON.stringify(line) + '\n' });
    } catch {
    }
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.flushing;
    const batch = this.buffer;
    this.buffer = [];
    this.flushing = this.flushing.then(async () => {
      const byGen = new Map<number, string>();
      for (const b of batch) byGen.set(b.gen, (byGen.get(b.gen) ?? '') + b.line);
      for (const [gen, text] of byGen) {
        try {
          await appendText(this.journalFile(gen), text);
        } catch (err) {
          this.log('warn', `Crash journal write failed: ${(err as Error).message}`);
        }
      }
    });
    return this.flushing;
  }

  snapshot(project: Project, info: Omit<RecoveryInfo, 'gen' | 'savedAt'>, assets: Record<string, Uint8Array> = {}, after?: Promise<unknown>): Promise<void> {
    const gen = ++this.gen;
    this.snapshotVersion = info.docVersion;
    let bytes: Uint8Array;
    try {
      bytes = encodeContainer(project, this.appVersion, { recovery: { ...info, gen, savedAt: Date.now() } satisfies RecoveryInfo }, assets);
    } catch (err) {
      this.log('warn', `Autosave failed: ${(err as Error).message}`);
      return this.snapshotChain;
    }
    const job = this.snapshotChain.then(async () => {
      try {
        if (after) await after.catch(() => {});
        await this.flush();
        await writeFileAtomic(this.snapshotFile, bytes);
        await this.removeJournals((g) => g < gen);
      } catch (err) {
        this.log('warn', `Autosave failed: ${(err as Error).message}`);
      }
    });
    this.snapshotChain = job;
    return job;
  }

  private async removeJournals(pred: (gen: number) => boolean): Promise<void> {
    try {
      for (const name of await fsp.readdir(this.dir)) {
        const m = /^journal-(\d+)\.ndjson$/.exec(name);
        if (m && pred(Number(m[1]))) await removeFile(path.join(this.dir, name));
      }
    } catch {
    }
  }

  async recover(): Promise<RecoveredSession | null> {
    if (!exists(this.snapshotFile)) return null;
    let project: Project;
    let info: RecoveryInfo;
    const assets: Record<string, Uint8Array> = {};
    try {
      const decoded = decodeContainer(await readBytes(this.snapshotFile));
      project = validateProject(decoded.project, decoded.meta?.schemaVersion);
      Object.assign(assets, decoded.assets);
      const r = decoded.extra.recovery as Partial<RecoveryInfo> | undefined;
      info = {
        docVersion: Number(r?.docVersion ?? 0),
        savedVersion: Number(r?.savedVersion ?? -1),
        projectPath: typeof r?.projectPath === 'string' ? r.projectPath : null,
        tabId: typeof r?.tabId === 'string' ? r.tabId : null,
        gen: Number(r?.gen ?? 0),
        savedAt: Number(r?.savedAt ?? 0),
      };
    } catch (err) {
      this.log('warn', `Crash recovery snapshot is unusable: ${(err as Error).message}`);
      return null;
    }

    let version = info.docVersion;
    let savedVersion = info.savedVersion;
    let projectPath = info.projectPath;
    let editedAt = info.savedAt || mtimeMs(this.snapshotFile);
    const journals: Array<{ gen: number; name: string }> = [];
    try {
      for (const name of await fsp.readdir(this.dir)) {
        const m = /^journal-(\d+)\.ndjson$/.exec(name);
        if (m) journals.push({ gen: Number(m[1]), name });
      }
    } catch {
    }
    journals.sort((a, b) => a.gen - b.gen);
    let stop = false;
    for (const j of journals) {
      if (stop) break;
      const file = path.join(this.dir, j.name);
      const text = (await readText(file)) ?? '';
      editedAt = Math.max(editedAt, mtimeMs(file));
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        let line: JournalLine;
        try {
          line = JSON.parse(raw);
        } catch {
          stop = true;
          break;
        }
        if ('saved' in line) {
          if (line.v >= info.docVersion) {
            savedVersion = line.v;
            projectPath = line.path;
          }
          continue;
        }
        if (line.v <= version) continue;
        if (line.v !== version + 1) {
          stop = true;
          break;
        }
        try {
          const next = applyPatches(project, line.p);
          if (checkIntegrity(next).length > checkIntegrity(project).length) throw new Error('integrity');
          project = next;
          version = line.v;
        } catch {
          stop = true;
          break;
        }
      }
    }
    const cover = project.meta.cover?.file;
    if (cover && !assets[cover]) {
      try {
        assets[cover] = await readBytes(path.join(this.assetDir, cover));
      } catch {
      }
    }
    return { project, assets, projectPath, tabId: info.tabId ?? null, dirty: version !== savedVersion, editedAt };
  }

  async endClean(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.buffer = [];
    await this.snapshotChain.catch(() => {});
    await this.flushing.catch(() => {});
    await this.removeJournals(() => true);
    await removeFile(this.snapshotFile).catch(() => {});
    await fsp.rm(this.assetDir, { recursive: true, force: true }).catch(() => {});
    removeFileSync(this.lockFile);
  }

  async discardPrevious(): Promise<void> {
    await this.removeJournals(() => true);
    await removeFile(this.snapshotFile).catch(() => {});
    await fsp.rm(this.assetDir, { recursive: true, force: true }).catch(() => {});
  }
}
