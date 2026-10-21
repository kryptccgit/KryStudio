import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, run } from './harness';
import { LibraryDb, LibraryDbError, SCHEMA_VERSION, rowToTrack } from '../electron/library/db';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-libdb-'));
let n = 0;
const fresh = () => new LibraryDb(path.join(TMP, `db${++n}.sqlite`));
const summary = (o: Partial<{ bpm: number; key: string; lufs: number; duration: number }> = {}) => ({
  duration: o.duration ?? 180,
  bpm: o.bpm ?? 120,
  bpmConf: 0.9,
  key: o.key ?? 'F#m',
  keyConf: 0.7,
  swing: 0.1,
  lufs: o.lufs ?? -9,
  width: 0.4,
});

function seed(db: LibraryDb) {
  db.insertCollection({ id: 'c1', name: 'Dark trap', tags: ['trap'], createdAt: 1 });
  db.insertCollection({ id: 'c2', name: 'House', tags: [], createdAt: 2 });
  const files = (dir: string, names: string[]) => names.map((nm, i) => ({ id: `${dir}-${i}`, path: `C:\\Music\\${dir}\\${nm}.wav`, name: nm, size: 100 + i, mtime: 1000 + i }));
  assert.deepEqual(db.insertTracks('c1', files('trap', ['Night Drive', 'Gb Minor Thing', 'Fast One', 'Ambient']), 10), { added: 4, skipped: 0 });
  assert.deepEqual(db.insertTracks('c2', files('house', ['Deep 1', 'Deep 2']), 11), { added: 2, skipped: 0 });
  const ok = (id: string, s: ReturnType<typeof summary>) => assert.equal(db.saveLight(id, 0, s, JSON.stringify({ analysis: { durationSec: 1 } }), [1, 2, 3], 1, 50), true);
  ok('trap-0', summary({ bpm: 140, key: 'F#m', lufs: -8 }));
  ok('trap-1', summary({ bpm: 142, key: 'Gbm', lufs: -10 }));
  ok('trap-2', summary({ bpm: 160, key: 'C', lufs: -6 }));
  ok('house-0', summary({ bpm: 124, key: 'Am', lufs: -7 }));
}

test('schema: fresh DB at the current version, WAL, idempotent reopen', () => {
  const file = path.join(TMP, 'schema.sqlite');
  const db = new LibraryDb(file);
  assert.equal(db.version(), SCHEMA_VERSION);
  assert.equal(String(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toLowerCase(), 'wal');
  db.insertCollection({ id: 'c1', name: 'A', tags: [], createdAt: 1 });
  db.close();
  const again = new LibraryDb(file);
  assert.equal(again.version(), SCHEMA_VERSION);
  assert.equal(again.collections().length, 1, 'reopening keeps the data (no re-migration)');
  again.close();
});

test('schema: an older library is migrated forward and keeps its data (v1 → v2 adds the twin index)', () => {
  const file = path.join(TMP, 'old.sqlite');
  const cur = new LibraryDb(file);
  cur.insertCollection({ id: 'c1', name: 'Kept', tags: [], createdAt: 1 });
  cur.insertTracks('c1', [{ id: 't1', path: 'C:\a.wav', name: 'a', size: 1, mtime: 1 }], 1);
  cur.close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP INDEX tracks_path; PRAGMA user_version = 1;');
  raw.close();
  const db = new LibraryDb(file);
  assert.equal(db.version(), SCHEMA_VERSION);
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tracks_path'"), 'the v2 index exists again');
  assert.equal(db.collection('c1')?.counts.total, 1, 'data survived the migration');
  db.close();
});

test('schema: a library written by a newer build is refused untouched', () => {
  const file = path.join(TMP, 'newer.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE keepme (x INTEGER); PRAGMA user_version = 99;');
  raw.close();
  assert.throws(() => new LibraryDb(file), (e: unknown) => e instanceof LibraryDbError && /newer Krypt Studio/.test((e as Error).message));
  const check = new DatabaseSync(file);
  assert.equal(Number(check.prepare('PRAGMA user_version').get()?.user_version), 99);
  check.close();
});

test('schema: garbage is reported as unreadable (the service moves it aside)', () => {
  const file = path.join(TMP, 'garbage.sqlite');
  fs.writeFileSync(file, 'this is not a database at all, just text '.repeat(200));
  assert.throws(() => new LibraryDb(file), (e: unknown) => e instanceof LibraryDbError && /unreadable|open/i.test((e as Error).message));
});

test('records: per-collection dedupe (case-insensitive paths), counts, row mapping', () => {
  const db = fresh();
  seed(db);
  const again = db.insertTracks('c1', [{ id: 'dup', path: 'c:\\music\\TRAP\\night drive.wav', name: 'x', size: 1, mtime: 1 }], 20);
  assert.deepEqual(again, { added: 0, skipped: 1 });
  const counts = db.counts();
  assert.deepEqual(counts.get('c1'), { total: 4, pending: 1, light: 3, deep: 0, failed: 0, missing: 0 });
  assert.deepEqual(counts.get('c2'), { total: 2, pending: 1, light: 1, deep: 0, failed: 0, missing: 0 });
  const t = rowToTrack(db.track('trap-0')!);
  assert.equal(t.bpm, 140);
  assert.equal(t.key, 'F#m');
  assert.equal(t.status, 'light');
  assert.equal(t.analyzedAt, 50);
  const pending = rowToTrack(db.track('trap-3')!);
  assert.equal(pending.bpm, undefined, 'unanalysed tracks carry no analysis fields');
  db.close();
});

test('status: gen guard, requeue, missing → restore, failures, retry', () => {
  const db = fresh();
  seed(db);
  db.requeue('trap-3', { size: 999, mtime: 2 });
  assert.equal(db.saveLight('trap-3', 0, summary(), '{}', [], 1, 60), false, 'stale gen');
  const gen = db.track('trap-3')!.gen;
  assert.equal(db.saveLight('trap-3', gen, summary(), JSON.stringify({ analysis: {} }), [0], 1, 60), true);
  assert.equal(db.saveDeep('trap-3', gen, JSON.stringify({ analysis: {} }), [0], 1, [{ hash: 42, stem: 'vocals', pos: 0 }], 1, 70), true);
  assert.equal(db.track('trap-3')!.status, 'deep');
  assert.equal(db.hashCount('trap-3'), 1);
  db.requeue('trap-3');
  assert.equal(db.track('trap-3')!.status, 'pending');
  assert.equal(db.featuresJson('trap-3'), null);
  assert.equal(db.hashCount('trap-3'), 0);
  db.markMissing('trap-0');
  assert.equal(db.track('trap-0')!.status, 'missing');
  db.restore('trap-0');
  assert.equal(db.track('trap-0')!.status, 'light');
  assert.equal(db.markFailed('trap-3', db.track('trap-3')!.gen, 'Unsupported or corrupt audio file'), true);
  assert.equal(db.track('trap-3')!.status, 'failed');
  assert.equal(db.track('trap-3')!.error, 'Unsupported or corrupt audio file');
  assert.equal(db.markDeepFailed('trap-1', db.track('trap-1')!.gen, 'Deep analysis failed: x'), true);
  assert.equal(db.retryFailed('c1'), 2);
  assert.equal(db.track('trap-3')!.status, 'pending');
  assert.equal(db.track('trap-1')!.deep_failed, 0);
  db.close();
});

test('twins: the same unchanged file in another collection reuses its analysis and hashes', () => {
  const db = fresh();
  seed(db);
  const t0 = db.track('trap-0')!;
  assert.equal(db.saveDeep(t0.id, t0.gen, JSON.stringify({ analysis: {}, lines: { vocals: [] } }), [1], 1, [{ hash: 7, stem: 'vocals', pos: 0 }], 1, 90), true);
  db.insertTracks('c2', [{ id: 'copy', path: t0.path.toUpperCase(), name: 'Night Drive', size: t0.size, mtime: t0.mtime }], 30);
  const copy = db.track('copy')!;
  const twin = db.twinOf(copy);
  assert.equal(twin?.id, 'trap-0');
  assert.equal(db.copyAnalysis(twin!, 'copy', copy.gen), true);
  const after = db.track('copy')!;
  assert.equal(after.status, 'deep');
  assert.equal(after.bpm, 140);
  assert.equal(db.hashCount('copy'), 1);
  assert.equal(db.twinOf({ id: 'x', path_key: t0.path_key, size: t0.size + 1, mtime: t0.mtime }), undefined, 'a changed file is no twin');
  db.close();
});

test('queries: text, bpm range, key (enharmonic) and mode, status, sort, paging', () => {
  const db = fresh();
  seed(db);
  const names = (q: Parameters<LibraryDb['query']>[0]) => db.query(q).rows.map((r) => r.name);
  assert.deepEqual(names({ text: 'deep' }), ['Deep 1', 'Deep 2']);
  assert.deepEqual(names({ text: 'TRAP' }).sort(), ['Ambient', 'Fast One', 'Gb Minor Thing', 'Night Drive'], 'path and tags match case-insensitively');
  assert.deepEqual(names({ text: '100%_' }), [], 'LIKE wildcards are escaped');
  assert.deepEqual(names({ bpmMin: 139, bpmMax: 150, sort: 'bpm' }), ['Night Drive', 'Gb Minor Thing']);
  assert.deepEqual(names({ key: 'F#m', sort: 'bpm' }), ['Night Drive', 'Gb Minor Thing'], 'Gbm = F#m');
  assert.deepEqual(names({ key: 'minor', sort: 'bpm', desc: true }), ['Gb Minor Thing', 'Night Drive', 'Deep 1']);
  assert.deepEqual(names({ key: 'major' }), ['Fast One']);
  assert.deepEqual(names({ status: 'pending' }), ['Ambient', 'Deep 2']);
  assert.deepEqual(names({ collectionId: 'c1', sort: 'lufs', desc: true }), ['Fast One', 'Night Drive', 'Gb Minor Thing', 'Ambient'], 'nulls last');
  const page = db.query({ sort: 'name', limit: 2, offset: 2 });
  assert.equal(page.total, 6);
  assert.deepEqual(page.rows.map((r) => r.name), ['Deep 2', 'Fast One']);
  db.close();
});

test('hashes: candidates ranked by shared n-grams; deletes cascade to features + hashes', () => {
  const db = fresh();
  seed(db);
  const deep = (id: string, hashes: number[]) => {
    const gen = db.track(id)!.gen;
    assert.equal(db.saveDeep(id, gen, JSON.stringify({ analysis: {}, lines: { vocals: [] } }), [1], 1, hashes.map((h, i) => ({ hash: h, stem: 'vocals', pos: i })), 1, 80), true);
  };
  deep('trap-0', [1, 2, 3, 4]);
  deep('trap-1', [3, 4, 5]);
  deep('house-0', [9]);
  const c = db.hashCandidates([2, 3, 4, 4, 77], 10);
  assert.deepEqual(c.map((x) => [x.track_id, x.n]), [['trap-0', 3], ['trap-1', 2]]);
  assert.equal(db.referenceCount(), 3);
  assert.equal(db.deepTrackCount('c1'), 2);
  db.putProfile('c1', 5, '{"x":1}', 1);
  assert.equal(db.profileRow('c1')?.rev, 5);
  const removed = db.deleteTracks(['trap-0', 'trap-1']);
  assert.equal(removed, 2);
  assert.equal(db.hashCount(), 1);
  assert.equal(db.featuresJson('trap-0'), null);
  assert.ok(db.collectionRow('c1')!.rev > 0, 'deletes invalidate the profile cache (rev bump)');
  db.deleteCollection('c1');
  assert.equal(db.profileRow('c1'), undefined, 'profiles cascade with their collection');
  assert.equal(db.query({ collectionId: 'c1' }).total, 0);
  db.close();
});

void run('library db');
