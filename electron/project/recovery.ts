// ──────────────────────────────────────────────────────────────────────
// Crash recovery (research/06 §4.6). Files under userData/autosave/:
//   session.lock          present while the app runs; removed on clean exit
//   current.kstudio       latest snapshot (+ recovery.json bookkeeping)
//   journal-<gen>.ndjson  every DocChange after snapshot <gen>, flushed ~1 s
//   assets/cover-*.jpg|png  every cover image the session stored, written
//                         when it is stored (a project.setCover journaled
//                         after the last snapshot still finds its bytes)
//
// A snapshot is taken on every reset (new/open) and every autosaveSec while
// dirty. Taking snapshot G switches journaling to journal-G immediately, and
// older journals are deleted only after the snapshot is durably on disk, so
// a crash at ANY point leaves snapshot + journals that replay to the last
// flushed edit. Replay skips lines at or below the snapshot's docVersion and
// stops at the first version gap.
//
// Project tabs (electron/project/tabs.ts) — the choice: ONE recovery store that
// follows the ACTIVE tab, session-aware rather than per-tab. Each snapshot
// records the active tab's id (recovery.json tabId); a tab switch is a reset,
// so it takes a new snapshot right away (and, because resets are never
// journaled, the version gap stops a replay from mixing two tabs). Inactive
// tabs don't change, so they are kept by the session files instead
// (userData/session/tab-<id>.kstudio, written when a tab is switched away
// from), and a switch's snapshot waits for that file (`after`) before it
// deletes the previous snapshot + journals. After a crash, the session restore
// gives the recovered project to the tab whose id it carries.
// ──────────────────────────────────────────────────────────────────────

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
  /** The project tab this snapshot belongs to (null: before tabs, or tabs not attached). */
  tabId?: string | null;
  gen: number;
  savedAt: number;
}

type JournalLine =
  | { v: number; p: Patch[] }
  | { v: number; saved: true; path: string | null };

export interface RecoveredSession {
  project: Project;
  /** The recovered project's binary assets (its cover), by entry name. */
  assets: Record<string, Uint8Array>;
  projectPath: string | null;
  /** The project tab it belongs to (RecoveryInfo.tabId), or null. */
  tabId: string | null;
  dirty: boolean;
  /** When the last journaled edit was made (ms). */
  editedAt: number;
}

export class RecoveryStore {
  private gen = 0;
  private buffer: Array<{ gen: number; line: string }> = [];
  private flushing: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private snapshotChain: Promise<void> = Promise.resolve();
  /** Doc version captured by the latest snapshot (started). */
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

  /** Mirror a newly stored asset (a cover image) so a crash before the next snapshot keeps it. */
  saveAsset(name: string, bytes: Uint8Array): Promise<void> {
    if (!COVER_FILE_RE.test(name)) return Promise.resolve();
    const file = path.join(this.assetDir, name);
    if (exists(file)) return Promise.resolve();
    return writeFileAtomic(file, bytes).catch((err) => this.log('warn', `Crash recovery couldn't keep the cover image: ${(err as Error).message}`));
  }

  /** True if the previous session didn't exit cleanly. Call BEFORE begin(). */
  crashedLastTime(): boolean {
    return exists(this.lockFile);
  }

  /** Mark this session as running and start the ~1 s journal flusher. */
  begin(): void {
    try {
      writeFileAtomicSync(this.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } catch (err) {
      this.log('warn', `Crash recovery is disabled: couldn't write ${this.lockFile} (${(err as Error).message})`);
    }
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.flushTimer.unref?.();
  }

  // ── Journal ─────────────────────────────────────────────────────────

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
      /* unserializable patch: skip (the next snapshot covers it) */
    }
  }

  /** Append buffered lines to their journal files (serialized). */
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

  // ── Snapshots ───────────────────────────────────────────────────────

  /**
   * Snapshot the project at `info.docVersion`. Journaling switches to the
   * new generation synchronously; old journals are removed after the write.
   * `after` (never rejecting): the write waits for it (a tab switch: the outgoing tab's session file is written
   * first, so its unsaved work is on disk somewhere at every moment).
   */
  snapshot(project: Project, info: Omit<RecoveryInfo, 'gen' | 'savedAt'>, assets: Record<string, Uint8Array> = {}, after?: Promise<unknown>): Promise<void> {
    // Generation + bytes are fixed NOW, so every later journal line lands in
    // this generation's journal; writes are serialized oldest → newest.
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
        await this.flush(); // older-gen lines land in their journals first
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
      /* best effort */
    }
  }

  // ── Recovery ────────────────────────────────────────────────────────

  /** Rebuild the last session from snapshot + journals, or null if there's nothing usable. */
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
      /* no journals */
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
          stop = true; // torn final line
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
    // The cover the replayed project ends on: from the snapshot, else the session's mirrored copy.
    const cover = project.meta.cover?.file;
    if (cover && !assets[cover]) {
      try {
        assets[cover] = await readBytes(path.join(this.assetDir, cover));
      } catch {
        /* missing: the project opens without its cover (ProjectService drops the reference) */
      }
    }
    return { project, assets, projectPath, tabId: info.tabId ?? null, dirty: version !== savedVersion, editedAt };
  }

  /** Clean exit: flush, then delete the lock, snapshot and journals. */
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

  /** Discard the previous session's files (after recovery or when nothing was recoverable). */
  async discardPrevious(): Promise<void> {
    await this.removeJournals(() => true);
    await removeFile(this.snapshotFile).catch(() => {});
    await fsp.rm(this.assetDir, { recursive: true, force: true }).catch(() => {});
  }
}
