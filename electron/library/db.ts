// ──────────────────────────────────────────────────────────────────────
// Reference library database: userData/library/library.sqlite through
// node:sqlite (DatabaseSync; built into Node 24 / Electron 44, no native
// module). WAL mode, schema version in PRAGMA user_version, forward-only
// migrations. Every statement here is small and indexed: bulk work
// (imports, removals, profile loads) is chunked by the caller with
// setImmediate so the main process never stalls.
//
// What is stored (research/08 §4): collections, one row per source FILE
// (path + size + mtime, never audio), derived features as JSON, the
// originality n-gram hashes of deep-analysed lines (indexed by hash) and
// cached style profiles (invalidated through collections.rev).
// Node-only (no Electron import): tests open it on a temp dir.
// ──────────────────────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { parseKey } from '@shared/music/theory';
import type { Collection, LibraryTrack, TrackQuery, TrackStatus } from '@shared/library/types';

export const SCHEMA_VERSION = 2;

/** Forward-only migrations: MIGRATIONS[i] takes the schema from version i to i + 1. */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) =>
    db.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE collections (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        folders    TEXT NOT NULL DEFAULT '[]',
        deep       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        rev        INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tracks (
        id            TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        path          TEXT NOT NULL,
        path_key      TEXT NOT NULL,
        name          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        mtime         INTEGER NOT NULL,
        status        TEXT NOT NULL,
        prev_status   TEXT,
        error         TEXT,
        gen           INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        deep_failed   INTEGER NOT NULL DEFAULT 0,
        duration      REAL,
        bpm           REAL,
        bpm_conf      REAL,
        key           TEXT,
        key_pc        INTEGER,
        key_mode      TEXT,
        key_conf      REAL,
        swing         REAL,
        lufs          REAL,
        width         REAL,
        added_at      INTEGER NOT NULL,
        analyzed_at   INTEGER,
        tags          TEXT NOT NULL DEFAULT '[]',
        UNIQUE (collection_id, path_key)
      );
      CREATE INDEX tracks_status ON tracks(status, added_at);
      CREATE INDEX tracks_collection ON tracks(collection_id, status);
      CREATE INDEX tracks_bpm ON tracks(bpm);
      CREATE INDEX tracks_key ON tracks(key_pc, key_mode);
      CREATE TABLE features (
        track_id       TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        json           TEXT NOT NULL,
        vector         TEXT NOT NULL DEFAULT '[]',
        vector_version INTEGER NOT NULL DEFAULT 0,
        lines          INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE line_hashes (
        hash     INTEGER NOT NULL,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        stem     TEXT NOT NULL,
        pos      INTEGER NOT NULL
      );
      CREATE INDEX line_hashes_hash ON line_hashes(hash);
      CREATE INDEX line_hashes_track ON line_hashes(track_id);
      CREATE TABLE profiles (
        collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
        rev           INTEGER NOT NULL,
        json          TEXT NOT NULL,
        built_at      INTEGER NOT NULL
      );
    `),
  // 1 → 2: find the same file in other collections (its analysis is reused, never redone).
  (db) => db.exec('CREATE INDEX tracks_path ON tracks(path_key, size, mtime);'),
];

export interface CollectionRow {
  id: string;
  name: string;
  tags: string;
  folders: string;
  deep: number;
  created_at: number;
  rev: number;
}

export interface TrackRow {
  id: string;
  collection_id: string;
  path: string;
  path_key: string;
  name: string;
  size: number;
  mtime: number;
  status: TrackStatus;
  prev_status: TrackStatus | null;
  error: string | null;
  gen: number;
  attempts: number;
  deep_failed: number;
  duration: number | null;
  bpm: number | null;
  bpm_conf: number | null;
  key: string | null;
  key_pc: number | null;
  key_mode: string | null;
  key_conf: number | null;
  swing: number | null;
  lufs: number | null;
  width: number | null;
  added_at: number;
  analyzed_at: number | null;
  tags: string;
}

export interface NewTrack {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
}

/** Summary columns written by the light pass (fast filters / sorts without parsing features). */
export interface TrackSummary {
  duration: number | null;
  bpm: number | null;
  bpmConf: number | null;
  key: string | null;
  keyConf: number | null;
  swing: number | null;
  lufs: number | null;
  width: number | null;
}

export type Counts = Collection['counts'];

const STATUSES: TrackStatus[] = ['pending', 'light', 'deep', 'failed', 'missing'];
const MAX_PARAMS = 400;

export const emptyCounts = (): Counts => ({ total: 0, pending: 0, light: 0, deep: 0, failed: 0, missing: 0 });

/** Windows paths compare case-insensitively. */
export const pathKey = (p: string): string => p.normalize('NFC').toLowerCase();

function parseList(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const num = (v: number | null | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function rowToTrack(r: TrackRow): LibraryTrack {
  const t: LibraryTrack = {
    id: r.id,
    collectionId: r.collection_id,
    path: r.path,
    name: r.name,
    size: r.size,
    mtime: r.mtime,
    status: r.status,
    addedAt: r.added_at,
    tags: parseList(r.tags),
  };
  if (r.error) t.error = r.error;
  const dur = num(r.duration);
  if (dur !== undefined) t.durationSec = dur;
  if (r.analyzed_at) {
    t.analyzedAt = r.analyzed_at;
    t.bpm = num(r.bpm) ?? null;
    if (num(r.bpm_conf) !== undefined) t.bpmConfidence = r.bpm_conf!;
    t.key = r.key ?? null;
    if (num(r.key_conf) !== undefined) t.keyConfidence = r.key_conf!;
    t.swing = num(r.swing) ?? null;
    if (num(r.lufs) !== undefined) t.lufs = r.lufs!;
    if (num(r.width) !== undefined) t.width = r.width!;
  }
  return t;
}

export function rowToCollection(r: CollectionRow, counts: Counts): Collection {
  return { id: r.id, name: r.name, tags: parseList(r.tags), createdAt: r.created_at, folders: parseList(r.folders), deep: r.deep === 1, counts };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const SORT: Record<NonNullable<TrackQuery['sort']>, string> = {
  name: 'name COLLATE NOCASE',
  bpm: 'bpm',
  key: 'key_pc',
  added: 'added_at',
  lufs: 'lufs',
  duration: 'duration',
};

export class LibraryDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryDbError';
  }
}

export class LibraryDb {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  /** Opens (creating when missing) and migrates. Throws LibraryDbError with a human message. */
  constructor(readonly file: string) {
    try {
      this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 2000 });
    } catch (err) {
      throw new LibraryDbError(`Couldn't open the reference library database (${file}): ${(err as Error).message}`);
    }
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
      this.migrate();
    } catch (err) {
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      if (err instanceof LibraryDbError) throw err;
      throw new LibraryDbError(`The reference library database is unreadable (${file}): ${(err as Error).message}`);
    }
  }

  close(): void {
    this.stmts.clear();
    try {
      if (this.db.isOpen) this.db.close();
    } catch {
      /* already closed */
    }
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  version(): number {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  }

  private migrate(): void {
    const v = this.version();
    if (v > SCHEMA_VERSION) {
      throw new LibraryDbError(`The reference library was written by a newer Krypt Studio (schema ${v}, this build reads up to ${SCHEMA_VERSION}). Update Krypt Studio to use it; nothing was changed.`);
    }
    for (let i = v; i < SCHEMA_VERSION; i++) {
      this.tx(() => {
        MIGRATIONS[i](this.db);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  // ── Generic helpers ────────────────────────────────────────────────

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Run fn in one transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the failure already ended it */
      }
      throw err;
    }
  }

  // ── Meta ───────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.run('DELETE FROM meta WHERE key = ?', key);
    else this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ── Collections ────────────────────────────────────────────────────

  collectionRows(): CollectionRow[] {
    return this.all<CollectionRow>('SELECT * FROM collections ORDER BY created_at, rowid');
  }

  collectionRow(id: string): CollectionRow | undefined {
    return this.get<CollectionRow>('SELECT * FROM collections WHERE id = ?', id);
  }

  counts(): Map<string, Counts> {
    const out = new Map<string, Counts>();
    for (const r of this.all<{ collection_id: string; status: TrackStatus; n: number }>('SELECT collection_id, status, COUNT(*) AS n FROM tracks GROUP BY collection_id, status')) {
      const c = out.get(r.collection_id) ?? emptyCounts();
      if (STATUSES.includes(r.status)) c[r.status] += r.n;
      c.total += r.n;
      out.set(r.collection_id, c);
    }
    return out;
  }

  collections(): Collection[] {
    const counts = this.counts();
    return this.collectionRows().map((r) => rowToCollection(r, counts.get(r.id) ?? emptyCounts()));
  }

  collection(id: string): Collection | null {
    const r = this.collectionRow(id);
    if (!r) return null;
    return rowToCollection(r, this.counts().get(id) ?? emptyCounts());
  }

  insertCollection(c: { id: string; name: string; tags: string[]; createdAt: number }): void {
    this.run('INSERT INTO collections(id, name, tags, folders, deep, created_at, rev) VALUES (?, ?, ?, ?, 0, ?, 0)', c.id, c.name, JSON.stringify(c.tags), '[]', c.createdAt);
  }

  updateCollection(id: string, patch: { name?: string; tags?: string[]; folders?: string[]; deep?: boolean }): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), params.push(patch.name));
    if (patch.tags !== undefined) (sets.push('tags = ?'), params.push(JSON.stringify(patch.tags)));
    if (patch.folders !== undefined) (sets.push('folders = ?'), params.push(JSON.stringify(patch.folders)));
    if (patch.deep !== undefined) (sets.push('deep = ?'), params.push(patch.deep ? 1 : 0));
    if (!sets.length) return;
    this.db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  deleteCollection(id: string): void {
    this.run('DELETE FROM collections WHERE id = ?', id);
  }

  /** Invalidate cached profiles (a collection's tracks changed). */
  bumpRev(collectionId: string): void {
    this.run('UPDATE collections SET rev = rev + 1 WHERE id = ?', collectionId);
  }

  // ── Tracks ─────────────────────────────────────────────────────────

  /** Insert new files (status pending). Paths already in the collection are skipped. */
  insertTracks(collectionId: string, files: NewTrack[], now: number): { added: number; skipped: number } {
    let added = 0;
    this.tx(() => {
      for (const f of files) {
        const r = this.run(
          `INSERT INTO tracks(id, collection_id, path, path_key, name, size, mtime, status, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(collection_id, path_key) DO NOTHING`,
          f.id,
          collectionId,
          f.path,
          pathKey(f.path),
          f.name,
          f.size,
          f.mtime,
          now,
        );
        added += r.changes;
      }
      if (added) this.bumpRev(collectionId);
    });
    return { added, skipped: files.length - added };
  }

  track(id: string): TrackRow | undefined {
    return this.get<TrackRow>('SELECT * FROM tracks WHERE id = ?', id);
  }

  tracksByIds(ids: string[]): TrackRow[] {
    const out: TrackRow[] = [];
    for (let i = 0; i < ids.length; i += MAX_PARAMS) {
      const chunk = ids.slice(i, i + MAX_PARAMS);
      out.push(...(this.db.prepare(`SELECT * FROM tracks WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as TrackRow[]));
    }
    return out;
  }

  /** What rescan compares: one collection's file records. */
  scanRows(collectionId: string): Array<Pick<TrackRow, 'id' | 'path' | 'path_key' | 'size' | 'mtime' | 'status' | 'prev_status'>> {
    return this.all('SELECT id, path, path_key, size, mtime, status, prev_status FROM tracks WHERE collection_id = ?', collectionId);
  }

  trackIdsOf(collectionId: string, limit: number): string[] {
    return this.all<{ id: string }>('SELECT id FROM tracks WHERE collection_id = ? LIMIT ?', collectionId, limit).map((r) => r.id);
  }

  /** Delete track records (features + hashes cascade). Caller chunks large lists. */
  deleteTracks(ids: string[]): number {
    let n = 0;
    this.tx(() => {
      const colls = new Set<string>();
      for (let i = 0; i < ids.length; i += MAX_PARAMS) {
        const chunk = ids.slice(i, i + MAX_PARAMS);
        const marks = chunk.map(() => '?').join(',');
        for (const r of this.db.prepare(`SELECT DISTINCT collection_id FROM tracks WHERE id IN (${marks})`).all(...chunk) as Array<{ collection_id: string }>) colls.add(r.collection_id);
        n += Number(this.db.prepare(`DELETE FROM tracks WHERE id IN (${marks})`).run(...chunk).changes);
      }
      for (const c of colls) this.bumpRev(c);
    });
    return n;
  }

  /** Next tracks for the light pass (oldest first), skipping ids already running. */
  nextPending(limit: number, skip: Set<string>, skipCollections: Set<string>): TrackRow[] {
    const rows = this.all<TrackRow>("SELECT * FROM tracks WHERE status = 'pending' ORDER BY added_at, rowid LIMIT ?", limit + skip.size + 32);
    return rows.filter((r) => !skip.has(r.id) && !skipCollections.has(r.collection_id)).slice(0, limit);
  }

  /** Tracks waiting for the deep pass (collections with deep on, light done, no deep failure). */
  nextDeep(limit: number, skip: Set<string>, skipCollections: Set<string>): TrackRow[] {
    const rows = this.all<TrackRow>(
      `SELECT t.* FROM tracks t JOIN collections c ON c.id = t.collection_id
       WHERE c.deep = 1 AND t.status = 'light' AND t.deep_failed = 0 ORDER BY t.added_at, t.rowid LIMIT ?`,
      limit + skip.size + 32,
    );
    return rows.filter((r) => !skip.has(r.id) && !skipCollections.has(r.collection_id)).slice(0, limit);
  }

  pendingCount(): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM tracks WHERE status = 'pending'")?.n ?? 0;
  }

  /** Deep work left: tracks and their known audio seconds (optionally one collection, pending tracks included). */
  deepRemaining(collectionId?: string, includePending = false): { tracks: number; knownSec: number; known: number } {
    const statuses = includePending ? "('light','pending')" : "('light')";
    const where = `c.deep = 1 AND t.status IN ${statuses} AND t.deep_failed = 0${collectionId ? ' AND t.collection_id = ?' : ''}`;
    const sql = `SELECT COUNT(*) AS n, COALESCE(SUM(t.duration), 0) AS sec, COUNT(t.duration) AS known FROM tracks t JOIN collections c ON c.id = t.collection_id WHERE ${where}`;
    const r = collectionId ? this.get<{ n: number; sec: number; known: number }>(sql, collectionId) : this.get<{ n: number; sec: number; known: number }>(sql);
    return { tracks: r?.n ?? 0, knownSec: r?.sec ?? 0, known: r?.known ?? 0 };
  }

  /** Tracks of a collection that deep analysis would still process (deep on or not). */
  deepCandidates(collectionId: string): { tracks: number; knownSec: number; known: number } {
    const r = this.get<{ n: number; sec: number; known: number }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(duration), 0) AS sec, COUNT(duration) AS known FROM tracks WHERE collection_id = ? AND status IN ('light','pending') AND deep_failed = 0",
      collectionId,
    );
    return { tracks: r?.n ?? 0, knownSec: r?.sec ?? 0, known: r?.known ?? 0 };
  }

  meanDuration(): number | null {
    const r = this.get<{ d: number | null }>('SELECT AVG(duration) AS d FROM tracks WHERE duration IS NOT NULL');
    return r?.d ?? null;
  }

  deepTrackCount(collectionId?: string): number {
    if (collectionId) return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM tracks WHERE status = 'deep' AND collection_id = ?", collectionId)?.n ?? 0;
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM tracks WHERE status = 'deep'")?.n ?? 0;
  }

  /** Reset a track to pending (file changed / retry): features, hashes and errors go. */
  requeue(id: string, file?: { size: number; mtime: number }): void {
    this.tx(() => {
      const row = this.track(id);
      if (!row) return;
      this.run('DELETE FROM features WHERE track_id = ?', id);
      this.run('DELETE FROM line_hashes WHERE track_id = ?', id);
      this.run(
        `UPDATE tracks SET status = 'pending', prev_status = NULL, error = NULL, attempts = 0, deep_failed = 0, gen = gen + 1,
         analyzed_at = NULL, duration = NULL, bpm = NULL, bpm_conf = NULL, key = NULL, key_pc = NULL, key_mode = NULL, key_conf = NULL,
         swing = NULL, lufs = NULL, width = NULL, size = ?, mtime = ? WHERE id = ?`,
        file?.size ?? row.size,
        file?.mtime ?? row.mtime,
        id,
      );
      this.bumpRev(row.collection_id);
    });
  }

  markMissing(id: string): void {
    this.tx(() => {
      const row = this.track(id);
      if (!row || row.status === 'missing') return;
      this.run("UPDATE tracks SET status = 'missing', prev_status = ?, gen = gen + 1 WHERE id = ?", row.status, id);
      this.bumpRev(row.collection_id);
    });
  }

  /** A missing file came back unchanged: restore what it was. */
  restore(id: string): void {
    this.tx(() => {
      const row = this.track(id);
      if (!row || row.status !== 'missing') return;
      const back: TrackStatus = row.prev_status && row.prev_status !== 'missing' ? row.prev_status : 'pending';
      this.run('UPDATE tracks SET status = ?, prev_status = NULL WHERE id = ?', back, id);
      this.bumpRev(row.collection_id);
    });
  }

  /** Light pass failed for this file (status failed, message kept). Only if the record is unchanged since the job started. */
  markFailed(id: string, gen: number, message: string): boolean {
    return this.tx(() => {
      const row = this.track(id);
      if (!row || row.gen !== gen) return false;
      this.run("UPDATE tracks SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?", message.slice(0, 500), id);
      this.bumpRev(row.collection_id);
      return true;
    });
  }

  /** The analyzer itself failed (crash / restart) during this file: count an attempt, keep it pending. */
  bumpAttempt(id: string, gen: number): number {
    this.run('UPDATE tracks SET attempts = attempts + 1 WHERE id = ? AND gen = ?', id, gen);
    return this.track(id)?.attempts ?? 0;
  }

  markDeepFailed(id: string, gen: number, message: string): boolean {
    return this.run("UPDATE tracks SET deep_failed = 1, error = ? WHERE id = ? AND gen = ? AND status = 'light'", message.slice(0, 500), id, gen).changes > 0;
  }

  /** Light pass result: features + summary columns + status light, in one transaction. False when the record changed meanwhile. */
  saveLight(id: string, gen: number, s: TrackSummary, featuresJson: string, vector: number[], vectorVersion: number, now: number): boolean {
    return this.tx(() => {
      const row = this.track(id);
      if (!row || row.gen !== gen || row.status !== 'pending') return false;
      const k = s.key ? parseKey(s.key) : null;
      this.run(
        `UPDATE tracks SET status = 'light', error = NULL, attempts = 0, analyzed_at = ?, duration = ?, bpm = ?, bpm_conf = ?, key = ?, key_pc = ?, key_mode = ?,
         key_conf = ?, swing = ?, lufs = ?, width = ? WHERE id = ?`,
        now,
        s.duration,
        s.bpm,
        s.bpmConf,
        s.key,
        k ? k.root : null,
        k ? k.scale : null,
        s.keyConf,
        s.swing,
        s.lufs,
        s.width,
        id,
      );
      this.run(
        'INSERT INTO features(track_id, json, vector, vector_version, lines) VALUES (?, ?, ?, ?, 0) ON CONFLICT(track_id) DO UPDATE SET json = excluded.json, vector = excluded.vector, vector_version = excluded.vector_version, lines = 0',
        id,
        featuresJson,
        JSON.stringify(vector),
        vectorVersion,
      );
      this.run('DELETE FROM line_hashes WHERE track_id = ?', id);
      this.bumpRev(row.collection_id);
      return true;
    });
  }

  /** Deep pass result: features (stem drums + lines), vector, n-gram hashes, status deep. */
  saveDeep(id: string, gen: number, featuresJson: string, vector: number[], vectorVersion: number, hashes: Array<{ hash: number; stem: string; pos: number }>, lineCount: number, now: number): boolean {
    return this.tx(() => {
      const row = this.track(id);
      if (!row || row.gen !== gen || row.status !== 'light') return false;
      this.run("UPDATE tracks SET status = 'deep', error = NULL, deep_failed = 0, analyzed_at = ? WHERE id = ?", now, id);
      this.run('UPDATE features SET json = ?, vector = ?, vector_version = ?, lines = ? WHERE track_id = ?', featuresJson, JSON.stringify(vector), vectorVersion, lineCount, id);
      this.run('DELETE FROM line_hashes WHERE track_id = ?', id);
      for (const h of hashes) this.run('INSERT INTO line_hashes(hash, track_id, stem, pos) VALUES (?, ?, ?, ?)', h.hash, id, h.stem, h.pos);
      this.bumpRev(row.collection_id);
      return true;
    });
  }

  /** The same unchanged file in another collection, already analysed (deep first). */
  twinOf(row: Pick<TrackRow, 'id' | 'path_key' | 'size' | 'mtime'>): TrackRow | undefined {
    return this.get<TrackRow>(
      "SELECT * FROM tracks WHERE path_key = ? AND size = ? AND mtime = ? AND id != ? AND status IN ('light','deep') ORDER BY status = 'deep' DESC, analyzed_at DESC LIMIT 1",
      row.path_key,
      row.size,
      row.mtime,
      row.id,
    );
  }

  /** Reuse a twin's analysis (summary, features, hashes, status) for a pending record. False when either changed meanwhile. */
  copyAnalysis(from: TrackRow, toId: string, gen: number): boolean {
    return this.tx(() => {
      const src = this.track(from.id);
      const dst = this.track(toId);
      if (!src || !dst || dst.gen !== gen || dst.status !== 'pending' || (src.status !== 'light' && src.status !== 'deep')) return false;
      const f = this.get<{ json: string; vector: string; vector_version: number; lines: number }>('SELECT json, vector, vector_version, lines FROM features WHERE track_id = ?', src.id);
      if (!f) return false;
      this.run(
        `UPDATE tracks SET status = ?, error = NULL, attempts = 0, deep_failed = 0, analyzed_at = ?, duration = ?, bpm = ?, bpm_conf = ?, key = ?, key_pc = ?,
         key_mode = ?, key_conf = ?, swing = ?, lufs = ?, width = ? WHERE id = ?`,
        src.status,
        src.analyzed_at,
        src.duration,
        src.bpm,
        src.bpm_conf,
        src.key,
        src.key_pc,
        src.key_mode,
        src.key_conf,
        src.swing,
        src.lufs,
        src.width,
        toId,
      );
      this.run(
        'INSERT INTO features(track_id, json, vector, vector_version, lines) VALUES (?, ?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET json = excluded.json, vector = excluded.vector, vector_version = excluded.vector_version, lines = excluded.lines',
        toId,
        f.json,
        f.vector,
        f.vector_version,
        f.lines,
      );
      this.run('DELETE FROM line_hashes WHERE track_id = ?', toId);
      this.run('INSERT INTO line_hashes(hash, track_id, stem, pos) SELECT hash, ?, stem, pos FROM line_hashes WHERE track_id = ?', toId, src.id);
      this.bumpRev(dst.collection_id);
      return true;
    });
  }

  /** Re-queue failed tracks (light failures → pending; deep failures cleared). */
  retryFailed(collectionId?: string): number {
    return this.tx(() => {
      const where = collectionId ? ' AND collection_id = ?' : '';
      const p: SQLInputValue[] = collectionId ? [collectionId] : [];
      const colls = this.db.prepare(`SELECT DISTINCT collection_id FROM tracks WHERE (status = 'failed' OR deep_failed = 1)${where}`).all(...p) as Array<{ collection_id: string }>;
      const a = Number(this.db.prepare(`UPDATE tracks SET status = 'pending', error = NULL, attempts = 0, gen = gen + 1 WHERE status = 'failed'${where}`).run(...p).changes);
      const b = Number(this.db.prepare(`UPDATE tracks SET deep_failed = 0, error = NULL WHERE deep_failed = 1${where}`).run(...p).changes);
      for (const c of colls) this.bumpRev(c.collection_id);
      return a + b;
    });
  }

  /** Deep requested for a collection: how many of its tracks will (eventually) get the deep pass. */
  clearDeepFailures(collectionId: string): void {
    this.run('UPDATE tracks SET deep_failed = 0, error = NULL WHERE collection_id = ? AND deep_failed = 1', collectionId);
  }

  // ── Queries ────────────────────────────────────────────────────────

  query(q: TrackQuery): { rows: TrackRow[]; total: number } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.collectionId) (where.push('collection_id = ?'), params.push(q.collectionId));
    const text = q.text?.trim().toLowerCase();
    if (text) {
      const like = `%${escapeLike(text)}%`;
      where.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(path) LIKE ? ESCAPE '\\' OR lower(tags) LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (typeof q.bpmMin === 'number' && Number.isFinite(q.bpmMin)) (where.push('bpm >= ?'), params.push(q.bpmMin));
    if (typeof q.bpmMax === 'number' && Number.isFinite(q.bpmMax)) (where.push('bpm <= ?'), params.push(q.bpmMax));
    const key = q.key?.trim();
    if (key) {
      const mode = /^(minor|min)$/i.test(key) ? 'minor' : /^(major|maj)$/i.test(key) ? 'major' : null;
      if (mode) (where.push('key_mode = ?'), params.push(mode));
      else {
        const k = parseKey(key);
        if (k && (k.scale === 'major' || k.scale === 'minor')) (where.push('key_pc = ? AND key_mode = ?'), params.push(k.root, k.scale));
        else (where.push('key = ?'), params.push(key));
      }
    }
    if (q.status && STATUSES.includes(q.status)) (where.push('status = ?'), params.push(q.status));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM tracks ${w}`).get(...params) as { n: number } | undefined)?.n ?? 0;
    const col = SORT[q.sort ?? 'name'] ?? SORT.name;
    const dir = q.desc ? 'DESC' : 'ASC';
    const limit = Math.max(1, Math.min(1000, Math.round(q.limit ?? 200)));
    const offset = Math.max(0, Math.round(q.offset ?? 0));
    const order = q.sort === 'key' ? `key_pc IS NULL, key_pc ${dir}, key_mode ${dir}` : `${col} IS NULL, ${col} ${dir}`;
    const rows = this.db.prepare(`SELECT * FROM tracks ${w} ORDER BY ${order}, name COLLATE NOCASE, rowid LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as TrackRow[];
    return { rows, total };
  }

  // ── Features ───────────────────────────────────────────────────────

  featuresJson(trackId: string): string | null {
    return this.get<{ json: string }>('SELECT json FROM features WHERE track_id = ?', trackId)?.json ?? null;
  }

  vectorOf(trackId: string): number[] | null {
    const r = this.get<{ vector: string }>('SELECT vector FROM features WHERE track_id = ?', trackId);
    return r ? parseVector(r.vector) : null;
  }

  /** One page of a collection's analysed tracks with their features (rowid paging; caller yields between pages). */
  featurePage(collectionId: string, afterRowid: number, limit: number): Array<{ rowid: number; json: string; vector: string } & TrackRow> {
    return this.all(
      `SELECT t.rowid AS rowid, t.*, f.json AS json, f.vector AS vector FROM tracks t JOIN features f ON f.track_id = t.id
       WHERE t.collection_id = ? AND t.status IN ('light','deep') AND t.rowid > ? ORDER BY t.rowid LIMIT ?`,
      collectionId,
      afterRowid,
      limit,
    );
  }

  /** One page of every analysed track's vector (similarity search). */
  vectorPage(afterRowid: number, limit: number): Array<{ rowid: number; id: string; collection_id: string; vector: string }> {
    return this.all(
      `SELECT t.rowid AS rowid, t.id AS id, t.collection_id AS collection_id, f.vector AS vector FROM tracks t JOIN features f ON f.track_id = t.id
       WHERE t.status IN ('light','deep') AND t.rowid > ? ORDER BY t.rowid LIMIT ?`,
      afterRowid,
      limit,
    );
  }

  /** Tracks whose stored vector is from another VECTOR_VERSION (recomputed at start-up). */
  staleVectors(version: number, limit: number): Array<{ track_id: string; json: string }> {
    return this.all('SELECT track_id, json FROM features WHERE vector_version != ? LIMIT ?', version, limit);
  }

  setVector(trackId: string, vector: number[], version: number): void {
    this.run('UPDATE features SET vector = ?, vector_version = ? WHERE track_id = ?', JSON.stringify(vector), version, trackId);
  }

  // ── Originality hashes ─────────────────────────────────────────────

  /** Reference (track, stem) pairs sharing n-gram hashes with a line, most shared first. */
  hashCandidates(hashes: number[], limit: number): Array<{ track_id: string; stem: string; n: number }> {
    const uniq = [...new Set(hashes.filter((h) => Number.isFinite(h)))];
    const tally = new Map<string, { track_id: string; stem: string; n: number }>();
    for (let i = 0; i < uniq.length; i += MAX_PARAMS) {
      const chunk = uniq.slice(i, i + MAX_PARAMS);
      const rows = this.db.prepare(`SELECT track_id, stem, COUNT(*) AS n FROM line_hashes WHERE hash IN (${chunk.map(() => '?').join(',')}) GROUP BY track_id, stem`).all(...chunk) as Array<{ track_id: string; stem: string; n: number }>;
      for (const r of rows) {
        const k = `${r.track_id}\u0000${r.stem}`;
        const cur = tally.get(k);
        if (cur) cur.n += r.n;
        else tally.set(k, { ...r });
      }
    }
    return [...tally.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  }

  hashCount(trackId?: string): number {
    if (trackId) return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM line_hashes WHERE track_id = ?', trackId)?.n ?? 0;
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM line_hashes')?.n ?? 0;
  }

  /** Deep tracks with transcribed lines (the originality references). */
  referenceCount(): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM tracks t JOIN features f ON f.track_id = t.id WHERE t.status = 'deep' AND f.lines > 0")?.n ?? 0;
  }

  // ── Profiles ───────────────────────────────────────────────────────

  profileRow(collectionId: string): { rev: number; json: string } | undefined {
    return this.get('SELECT rev, json FROM profiles WHERE collection_id = ?', collectionId);
  }

  putProfile(collectionId: string, rev: number, json: string, now: number): void {
    this.run(
      'INSERT INTO profiles(collection_id, rev, json, built_at) VALUES (?, ?, ?, ?) ON CONFLICT(collection_id) DO UPDATE SET rev = excluded.rev, json = excluded.json, built_at = excluded.built_at',
      collectionId,
      rev,
      json,
      now,
    );
  }
}

export function parseVector(s: string | null | undefined): number[] {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x : Number.NaN)) : [];
  } catch {
    return [];
  }
}
