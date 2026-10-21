// PacksService against a local HTTP server and a fake PackDef: install (verify, SFZ + LICENSE.txt + pack.json, one
// rename), hash mismatch naming the file, per-file resume, cancel mid-file, mirrors, the update status and an
// update that reuses unchanged files, remove, disk-full / network / bad-catalog sentences, and start-up cleanup.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, run } from './harness';
import type { PackDef, PacksState } from '@shared/packs/types';
import { fmtSize, licenceText, packFilePath, PacksService } from '../electron/packs/service';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-packs-'));
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Server ──────────────────────────────────────────────────────────────
const BODY: Record<string, Buffer> = {
  a: crypto.randomBytes(120_000),
  b: crypto.randomBytes(80_000),
  b2: crypto.randomBytes(60_000),
  slow: crypto.randomBytes(400_000),
};
const hits: Record<string, number> = {};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').slice(1));
  hits[url] = (hits[url] ?? 0) + 1;
  const [mode, key] = url.includes('/') ? url.split('/') : ['ok', url];
  const body = BODY[key];
  if (!body || mode === '404') {
    res.writeHead(404, 'Not Found');
    return res.end();
  }
  // 'bad/<key>': same length, different bytes (a damaged download).
  const out = mode === 'bad' ? Buffer.from(body.map((x) => x ^ 0xff)) : body;
  res.writeHead(200, { 'Content-Length': String(out.length), 'Content-Type': 'application/octet-stream' });
  if (mode === 'slow') {
    let i = 0;
    const tick = (): void => {
      if (res.destroyed) return;
      if (i >= out.length) return void res.end();
      res.write(out.subarray(i, i + 8192));
      i += 8192;
      setTimeout(tick, 25);
    };
    return tick();
  }
  res.write(out.subarray(0, Math.floor(out.length / 2)));
  setTimeout(() => res.end(out.subarray(Math.floor(out.length / 2))), 5);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ── Catalog ─────────────────────────────────────────────────────────────
const file = (p: string, key: string, url = `${BASE}/${key}`, mirrors?: string[]) => ({ path: p, url, mirrors, sha256: sha(BODY[key]), bytes: BODY[key].length });

function packDef(over: Partial<PackDef> = {}): PackDef {
  const files = over.files ?? [file('samples/a.flac', 'a'), file('samples/b.flac', 'b')];
  return {
    id: 'test-piano',
    name: 'Test Piano',
    version: 1,
    description: 'A fake piano for tests.',
    author: 'Test Recordist',
    homepage: 'https://example.com/piano',
    licence: { spdx: 'LicenseRef-PublicDomain', name: 'Public domain (author statement, 2022)', url: 'https://example.com/statement', attribution: 'Test Piano by Test Recordist', statement: 'I release these samples into the public domain.' },
    files,
    sfz: [{ path: 'krypt/piano.sfz', text: '<region> sample=../samples/a.flac key=60\n' }],
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    ramMb: 12,
    contents: ['Test piano (2 layers)'],
    ...over,
  };
}

let n = 0;
function rig(catalog: PackDef[], extra: Partial<ConstructorParameters<typeof PacksService>[0]> = {}) {
  const dir = path.join(TMP, `case-${++n}`, 'packs');
  const logs: string[] = [];
  const states: PacksState[] = [];
  const installed: string[] = [];
  const svc = new PacksService({
    dir,
    catalog,
    log: (level, m) => logs.push(`${level} ${m}`),
    broadcast: (s) => states.push(s),
    onInstalled: (id) => installed.push(id),
    freeBytes: async () => null,
    throttleMs: 5,
    ...extra,
  });
  return { dir, svc, logs, states, installed };
}

const entry = (svc: PacksService, id = 'test-piano') => svc.state().packs.find((p) => p.id === id)!;
const exists = (p: string) => fs.existsSync(p);

// ── Tests ───────────────────────────────────────────────────────────────

test('install: every file verified, then the SFZ mappings, LICENSE.txt and pack.json, then one rename', async () => {
  const def = packDef();
  const { dir, svc, states, installed } = rig([def]);
  assert.equal(entry(svc).status, 'available');
  assert.equal(svc.isInstalled('test-piano'), false);
  const r = await svc.install('test-piano');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Installed Test Piano/);
  assert.equal(r.data?.packs[0].status, 'installed');
  const root = path.join(dir, 'test-piano');
  assert.deepEqual(fs.readFileSync(path.join(root, 'samples', 'a.flac')), BODY.a);
  assert.deepEqual(fs.readFileSync(path.join(root, 'samples', 'b.flac')), BODY.b);
  assert.equal(fs.readFileSync(path.join(root, 'krypt', 'piano.sfz'), 'utf8'), def.sfz[0].text);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'));
  assert.equal(manifest.id, 'test-piano');
  assert.equal(manifest.version, 1);
  assert.ok(!Number.isNaN(Date.parse(manifest.installedAt)));
  const lic = fs.readFileSync(path.join(root, 'LICENSE.txt'), 'utf8');
  for (const s of ['Public domain (author statement, 2022)', 'Test Piano by Test Recordist', 'I release these samples into the public domain.', 'https://example.com/statement', sha(BODY.a), 'samples/b.flac']) assert.ok(lic.includes(s), s);
  assert.ok(!exists(path.join(dir, 'test-piano.partial')), 'no staging folder left');
  assert.ok(!exists(path.join(root, '.krypt-partial.json')), 'no staging marker in the installed pack');
  assert.equal(svc.isInstalled('test-piano'), true);
  assert.equal(svc.installedVersion('test-piano'), 1);
  assert.deepEqual(installed, ['test-piano']);
  // Progress was broadcast while downloading, then the installed state.
  const dl = states.filter((s) => s.packs[0].status === 'downloading');
  assert.ok(dl.length >= 1);
  assert.ok(dl.some((s) => (s.packs[0].progress?.bytes ?? 0) > 0));
  assert.equal(dl[0].packs[0].progress?.total, def.bytes);
  assert.equal(states.at(-1)?.packs[0].status, 'installed');
  // A second install is a no-op.
  const again = await svc.install('test-piano');
  assert.equal(again.ok, true);
  assert.match(again.message!, /already installed/);
});

test('a hash mismatch names the file, installs nothing and keeps the files that verified', async () => {
  const def = packDef({ files: [file('samples/a.flac', 'a'), file('samples/b.flac', 'b', `${BASE}/bad/b`)] });
  const { dir, svc, installed } = rig([def]);
  const r = await svc.install('test-piano');
  assert.equal(r.ok, false);
  assert.match(r.message!, /Couldn't install Test Piano: samples\/b\.flac failed verification \(SHA-256 mismatch\)/);
  assert.match(r.message!, /Nothing was installed/);
  const e = entry(svc);
  assert.equal(e.status, 'failed');
  assert.match(e.error!, /samples\/b\.flac/);
  assert.ok(!exists(path.join(dir, 'test-piano')), 'no installed folder');
  assert.equal(svc.isInstalled('test-piano'), false);
  assert.deepEqual(installed, []);
  // The good file stays in staging for the next try; the bad one is gone.
  assert.ok(exists(path.join(dir, 'test-piano.partial', 'samples', 'a.flac')));
  assert.ok(!exists(path.join(dir, 'test-piano.partial', 'samples', 'b.flac')));
});

test('resume: the next Download fetches only the files that are missing', async () => {
  const def = packDef({ files: [file('samples/a.flac', 'a'), file('samples/b.flac', 'b', `${BASE}/bad/b`)] });
  const { dir, svc } = rig([def]);
  await svc.install('test-piano');
  const aHits = hits.a ?? 0;
  // The server (catalog) now serves b correctly.
  def.files[1] = file('samples/b.flac', 'b');
  const r = await svc.install('test-piano');
  assert.equal(r.ok, true, r.message);
  assert.equal(hits.a ?? 0, aHits, 'a.flac was not downloaded again');
  assert.equal(entry(svc).status, 'installed');
  assert.equal(entry(svc).error, undefined);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'test-piano', 'samples', 'a.flac')), BODY.a);
});

test('resume ignores a damaged kept file and a staging folder from another catalog version', async () => {
  const def = packDef();
  const { dir, svc } = rig([def]);
  const staging = path.join(dir, 'test-piano.partial');
  fs.mkdirSync(path.join(staging, 'samples'), { recursive: true });
  fs.writeFileSync(path.join(staging, '.krypt-partial.json'), JSON.stringify({ id: 'test-piano', version: 1 }));
  fs.writeFileSync(path.join(staging, 'samples', 'a.flac'), Buffer.alloc(BODY.a.length)); // right size, wrong bytes
  fs.writeFileSync(path.join(staging, 'samples', 'b.flac'), BODY.b); // complete
  const before = { a: hits.a ?? 0, b: hits.b ?? 0 };
  assert.equal((await svc.install('test-piano')).ok, true);
  assert.equal(hits.a, before.a + 1, 'the damaged a.flac was fetched again');
  assert.equal(hits.b ?? 0, before.b, 'the complete b.flac was kept');

  // A staging folder written for another version is started over (a stray file in it never reaches the pack).
  const { dir: dir2, svc: svc2 } = rig([packDef({ version: 3 })]);
  const st2 = path.join(dir2, 'test-piano.partial');
  fs.mkdirSync(st2, { recursive: true });
  fs.writeFileSync(path.join(st2, '.krypt-partial.json'), JSON.stringify({ id: 'test-piano', version: 2 }));
  fs.writeFileSync(path.join(st2, 'stray.bin'), 'x');
  assert.equal((await svc2.install('test-piano')).ok, true);
  assert.ok(!exists(path.join(dir2, 'test-piano', 'stray.bin')));
});

test('cancel mid-file: nothing installed, finished files kept, the half file removed', async () => {
  const def = packDef({ files: [file('samples/a.flac', 'a'), file('samples/slow.flac', 'slow', `${BASE}/slow/slow`)] });
  const { dir, svc } = rig([def]);
  const p = svc.install('test-piano');
  assert.equal(entry(svc).status, 'downloading');
  // A second click while it runs is refused with a sentence.
  const dup = await svc.install('test-piano');
  assert.equal(dup.ok, false);
  assert.match(dup.message!, /already downloading/);
  for (let i = 0; i < 200 && !exists(path.join(dir, 'test-piano.partial', 'samples', 'slow.flac')); i++) await sleep(10);
  await sleep(60);
  assert.ok((entry(svc).progress?.bytes ?? 0) > BODY.a.length, 'progress counts the finished file plus the current one');
  assert.ok(!exists(path.join(dir, 'test-piano')), 'never visible as installed while downloading');
  const c = svc.cancel('test-piano');
  assert.equal(c.ok, true);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.message!, /Test Piano download cancelled\. Files that finished are kept/);
  assert.equal(entry(svc).status, 'available');
  assert.equal(entry(svc).error, undefined);
  assert.equal(svc.isInstalled('test-piano'), false);
  assert.ok(!exists(path.join(dir, 'test-piano')));
  assert.ok(exists(path.join(dir, 'test-piano.partial', 'samples', 'a.flac')));
  assert.ok(!exists(path.join(dir, 'test-piano.partial', 'samples', 'slow.flac')));
  // Cancel when nothing runs says so.
  const none = svc.cancel('test-piano');
  assert.equal(none.ok, false);
  assert.match(none.message!, /isn't downloading/);
});

test('mirrors are tried in order; when every source fails the message lists them', async () => {
  const good = packDef({ files: [file('samples/a.flac', 'a', `${BASE}/404/a`, [`${BASE}/a`])] });
  const { svc, logs } = rig([good]);
  const r = await svc.install('test-piano');
  assert.equal(r.ok, true, r.message);
  assert.ok(logs.some((l) => /trying the next source/.test(l)));

  const bad = packDef({ files: [file('samples/a.flac', 'a', `${BASE}/404/a`, [`${BASE}/bad/a`])] });
  const { svc: svc2 } = rig([bad]);
  const r2 = await svc2.install('test-piano');
  assert.equal(r2.ok, false);
  assert.match(r2.message!, /samples\/a\.flac couldn't be downloaded from any of its 2 sources/);
  assert.match(r2.message!, /HTTP 404/);
  assert.match(r2.message!, /SHA-256 mismatch/);
});

test('network failure and a full disk end in a sentence', async () => {
  // A port nobody listens on.
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const { svc } = rig([packDef({ files: [file('samples/a.flac', 'a', `http://127.0.0.1:${port}/a`)] })]);
  const r = await svc.install('test-piano');
  assert.equal(r.ok, false);
  assert.match(r.message!, /Couldn't reach 127\.0\.0\.1:\d+.*Check your internet connection/);

  const { svc: full, dir } = rig([packDef()], { freeBytes: async () => 10 * 1024 * 1024 });
  const r2 = await full.install('test-piano');
  assert.equal(r2.ok, false);
  assert.match(r2.message!, /Not enough disk space: Test Piano needs \d+ MB free and the disk with .+ has 10 MB/);
  assert.equal(entry(full).status, 'failed');
  assert.ok(!exists(path.join(dir, 'test-piano')));
});

test('a catalog entry with an unsafe or missing file path, checksum or URL is refused before any download', async () => {
  const bad = [
    packDef({ files: [{ ...file('samples/a.flac', 'a'), path: '../evil.flac' }] }),
    packDef({ files: [{ ...file('samples/a.flac', 'a'), path: 'C:/Windows/evil.dll' }] }),
    packDef({ files: [{ ...file('samples/a.flac', 'a'), path: 'pack.json' }] }),
    packDef({ files: [{ ...file('samples/a.flac', 'a'), sha256: 'abc' }] }),
    packDef({ files: [{ ...file('samples/a.flac', 'a'), url: '' }] }),
    packDef({ sfz: [{ path: '../x.sfz', text: '' }] }),
    packDef({ files: [] }),
  ];
  for (const def of bad) {
    const before = hits.a ?? 0;
    const { svc, dir } = rig([def]);
    const r = await svc.install('test-piano');
    assert.equal(r.ok, false, JSON.stringify(def.files[0]?.path));
    assert.match(r.message!, /Test Piano/);
    assert.equal(hits.a ?? 0, before);
    assert.ok(!exists(path.join(dir, 'test-piano')));
  }
  const { svc } = rig([packDef()]);
  const unknown = await svc.install('nope');
  assert.equal(unknown.ok, false);
  assert.match(unknown.message!, /no sound pack called "nope"/);
});

test('update: an older installed version shows "update"; Update reuses unchanged files and swaps atomically', async () => {
  const v1 = packDef();
  const { dir, svc } = rig([v1]);
  assert.equal((await svc.install('test-piano')).ok, true);
  // Catalog v2: a changed b, an extra file, a new mapping.
  const v2 = packDef({ version: 2, files: [file('samples/a.flac', 'a'), file('samples/b.flac', 'b2'), file('samples/c.flac', 'b')], sfz: [{ path: 'krypt/piano.sfz', text: '<region> sample=../samples/c.flac\n' }] });
  // A newer catalog over the same folder (the next app version).
  const s2 = new PacksService({ dir, catalog: [v2], log: () => {}, freeBytes: async () => null });
  assert.equal(entry(s2).status, 'update');
  assert.equal(s2.isInstalled('test-piano'), true, 'an older version still plays');
  const aHits = hits.a ?? 0;
  const r = await s2.install('test-piano');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /^Updated Test Piano/);
  assert.equal(hits.a ?? 0, aHits, 'the unchanged a.flac came from the installed copy');
  assert.equal(entry(s2).status, 'installed');
  assert.equal(s2.installedVersion('test-piano'), 2);
  const root = path.join(dir, 'test-piano');
  assert.deepEqual(fs.readFileSync(path.join(root, 'samples', 'b.flac')), BODY.b2);
  assert.match(fs.readFileSync(path.join(root, 'krypt', 'piano.sfz'), 'utf8'), /c\.flac/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8')).version, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['test-piano'], 'no staging or old copy left');
});

test('remove deletes only that pack (and its unfinished download)', async () => {
  const other = packDef({ id: 'other-pack', name: 'Other Pack' });
  const { dir, svc } = rig([packDef(), other]);
  assert.equal((await svc.install('test-piano')).ok, true);
  fs.mkdirSync(path.join(dir, 'other-pack.partial'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other-pack.partial', 'keep.bin'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'user file');
  const r = await svc.remove('test-piano');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Removed Test Piano/);
  assert.ok(!exists(path.join(dir, 'test-piano')));
  assert.ok(exists(path.join(dir, 'other-pack.partial', 'keep.bin')));
  assert.ok(exists(path.join(dir, 'notes.txt')));
  assert.equal(entry(svc).status, 'available');
  assert.equal(svc.isInstalled('test-piano'), false);
  const again = await svc.remove('test-piano');
  assert.equal(again.ok, false);
  assert.match(again.message!, /isn't installed/);
  // An unfinished download alone can be removed too.
  const partial = await svc.remove('other-pack');
  assert.equal(partial.ok, true);
  assert.match(partial.message!, /unfinished Other Pack download/);
  assert.ok(!exists(path.join(dir, 'other-pack.partial')));
});

test('start-up: an interrupted update swap is restored, unknown unfinished downloads removed, known ones kept', async () => {
  const { dir } = rig([packDef()]);
  fs.mkdirSync(path.join(dir, 'test-piano.old-123'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test-piano.old-123', 'pack.json'), JSON.stringify({ id: 'test-piano', version: 1, installedAt: new Date().toISOString() }));
  fs.mkdirSync(path.join(dir, 'gone-pack.partial'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test-piano.partial'), { recursive: true });
  const svc = new PacksService({ dir, catalog: [packDef()], log: () => {} });
  assert.equal(svc.isInstalled('test-piano'), false);
  await svc.refresh();
  assert.ok(exists(path.join(dir, 'test-piano', 'pack.json')), 'the old copy is back in place');
  assert.ok(!exists(path.join(dir, 'gone-pack.partial')));
  assert.ok(exists(path.join(dir, 'test-piano.partial')));
  assert.equal(svc.isInstalled('test-piano'), true);
  // A damaged pack.json counts as not installed (and says so in the log).
  fs.writeFileSync(path.join(dir, 'test-piano', 'pack.json'), '{nope');
  const logs: string[] = [];
  const s2 = new PacksService({ dir, catalog: [packDef()], log: (_l, m) => logs.push(m) });
  assert.equal(s2.isInstalled('test-piano'), false);
  assert.ok(logs.some((m) => /pack\.json isn't readable/.test(m)));
});

test('state carries the card fields; packName / packDir / helpers', async () => {
  const { svc, dir } = rig([packDef()]);
  const e = entry(svc);
  assert.deepEqual(
    { id: e.id, name: e.name, author: e.author, bytes: e.bytes, ramMb: e.ramMb, contents: e.contents, licence: e.licence.name },
    { id: 'test-piano', name: 'Test Piano', author: 'Test Recordist', bytes: BODY.a.length + BODY.b.length, ramMb: 12, contents: ['Test piano (2 layers)'], licence: 'Public domain (author statement, 2022)' },
  );
  assert.equal(svc.state().dir, dir);
  assert.equal(svc.packName('test-piano'), 'Test Piano');
  assert.equal(svc.packName('nope'), undefined);
  assert.equal(svc.packDir('test-piano'), null);
  await svc.install('test-piano');
  assert.equal(svc.packDir('test-piano'), path.join(dir, 'test-piano'));

  assert.equal(packFilePath(dir, 'samples/a.flac'), path.join(dir, 'samples', 'a.flac'));
  for (const bad of ['../a', 'a/../../b', '/abs', 'C:/x', 'a\\b', 'x:stream', 'a/./b', 'a//b', 'trailing.', ' lead', '']) assert.equal(packFilePath(dir, bad), null, bad);
  assert.equal(fmtSize(312 * 1024 * 1024), '312 MB');
  assert.equal(fmtSize(1.5 * 1024 * 1024 * 1024), '1.5 GB');
  assert.match(licenceText(packDef()), /Recordings by: Test Recordist/);
});

await run('packs-service');
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
