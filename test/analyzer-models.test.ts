import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, run } from './harness';
import type { ModelDef } from '@shared/analyzer/models';
import { ModelManager } from '../electron/analyzer/models';
import { checkDownloadUrl, downloadFile, shadowCopySync } from '../electron/system/download';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-models-'));
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FILES: Record<string, Buffer> = {
  'good/a.onnx': crypto.randomBytes(200_000),
  'good/b.json': Buffer.from('{"layers":4}'),
  'bad/w.onnx': crypto.randomBytes(5_000),
  'slow/big.onnx': crypto.randomBytes(400_000),
};
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  const key = decodeURIComponent((req.url ?? '/').slice(1));
  const body = FILES[key];
  if (!body) {
    res.writeHead(404, 'Not Found');
    return res.end();
  }
  res.writeHead(200, { 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream' });
  if (key.startsWith('slow/')) {
    let i = 0;
    const tick = (): void => {
      if (res.destroyed) return;
      if (i >= body.length) return void res.end();
      res.write(body.subarray(i, i + 8192));
      i += 8192;
      setTimeout(tick, 30);
    };
    return tick();
  }
  res.write(body.subarray(0, Math.floor(body.length / 2)));
  setTimeout(() => res.end(body.subarray(Math.floor(body.length / 2))), 10);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const lic = { name: 'MIT', url: 'https://example.com/LICENSE' };
const file = (key: string, name: string, over: Partial<{ url: string; mirrors: string[]; sha256: string; bytes: number }> = {}) => ({
  name,
  url: `${BASE}/${key}`,
  sha256: sha(FILES[key]),
  bytes: FILES[key].length,
  ...over,
});
const LOCAL = Buffer.from('local-only weights');
const BUNDLED = Buffer.from('bundled weights');
const CATALOG: ModelDef[] = [
  { id: 'good', name: 'Good Model', task: 'stems', description: 'd', license: lic, bundled: false, default: true, stems: ['drums', 'bass', 'vocals', 'other'], files: [file('good/a.onnx', 'a.onnx'), file('good/b.json', 'b.json')] },
  { id: 'bad', name: 'Bad Model', task: 'stems', description: 'd', license: lic, bundled: false, files: [file('bad/w.onnx', 'w.onnx', { sha256: 'f'.repeat(64) })] },
  { id: 'slow', name: 'Slow Model', task: 'stems', description: 'd', license: lic, bundled: false, files: [file('slow/big.onnx', 'big.onnx')] },
  { id: 'local', name: 'Local Model', task: 'transcribe', description: 'd', license: lic, bundled: false, files: [{ name: 'local.onnx', url: '', sha256: sha(LOCAL), bytes: LOCAL.length }] },
  { id: 'nosha', name: 'Unfinished Model', task: 'beats', description: 'd', license: lic, bundled: false, files: [{ name: 'x.onnx', url: `${BASE}/x`, sha256: '', bytes: 0 }] },
  { id: 'mirrored', name: 'Mirrored Model', task: 'stems', description: 'd', license: lic, bundled: false, files: [file('good/a.onnx', 'a.onnx', { url: `${BASE}/gone/a.onnx`, mirrors: [`${BASE}/bad/w.onnx`, `${BASE}/good/a.onnx`] })] },
  { id: 'nowhere', name: 'Unreachable Model', task: 'stems', description: 'd', license: lic, bundled: false, files: [file('good/a.onnx', 'a.onnx', { url: `${BASE}/gone/1.onnx`, mirrors: [`${BASE}/gone/2.onnx`] })] },
  { id: 'bund', name: 'Bundled Model', task: 'transcribe', description: 'd', license: lic, bundled: true, default: true, files: [{ name: 'nmp.onnx', url: '', sha256: sha(BUNDLED), bytes: BUNDLED.length }] },
];

const BUNDLED_DIR = path.join(TMP, 'resources', 'models');
fs.mkdirSync(path.join(BUNDLED_DIR, 'bund'), { recursive: true });
fs.writeFileSync(path.join(BUNDLED_DIR, 'bund', 'nmp.onnx'), BUNDLED);

function manager(userDir: string) {
  let changes = 0;
  const logs: string[] = [];
  const m = new ModelManager({
    catalog: CATALOG,
    bundledDirs: [BUNDLED_DIR],
    userModelsDir: userDir,
    log: (level, msg) => logs.push(`${level} ${msg}`),
    onChange: () => changes++,
  });
  return { m, logs, changes: () => changes };
}

const statusOf = (m: ModelManager, id: string) => m.state(id)!.status;

test('initial statuses: available / unavailable (importable or not) / bundled installed', async () => {
  const userDir = path.join(TMP, 'u1');
  const { m } = manager(userDir);
  await m.refresh();
  assert.equal(statusOf(m, 'good'), 'available');
  assert.equal(statusOf(m, 'local'), 'unavailable');
  assert.equal(m.state('local')!.message, 'No download published yet — use Install from folder.');
  assert.equal(statusOf(m, 'nosha'), 'unavailable');
  assert.match(m.state('nosha')!.message!, /isn't available in this version yet/);
  assert.equal(statusOf(m, 'bund'), 'installed');
  assert.equal(m.dirFor('bund'), path.join(BUNDLED_DIR, 'bund'));
  assert.equal(m.defaultFor('stems')!.id, 'good');
  assert.equal(m.modelsDir, userDir);
  const r = await m.install('nosha');
  assert.equal(r.ok, false);
  assert.equal((await m.install('nope')).message, 'Unknown model "nope"');
});

test('download: streaming progress, SHA-256 verified, atomic rename, manifest + cache; a new manager trusts the cache', async () => {
  const userDir = path.join(TMP, 'u2');
  const { m, changes } = manager(userDir);
  await m.refresh();
  const seen: Array<{ status: string; received: number }> = [];
  const poll = setInterval(() => {
    const s = m.state('good')!;
    if (s.status === 'downloading' && s.progress) seen.push({ status: s.status, received: s.progress.received });
  }, 1);
  const r = await m.install('good');
  clearInterval(poll);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /^Installed Good Model \(0\.2 MB\)$/);
  assert.equal(statusOf(m, 'good'), 'installed');
  const dir = m.dirFor('good')!;
  assert.equal(dir, path.join(userDir, 'good'));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a.onnx')), FILES['good/a.onnx']);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(userDir, 'good.partial')), 'staging folder renamed away');
  assert.ok(changes() > 3, 'progress changes were reported');
  assert.ok(seen.length >= 1, 'downloading state with progress was visible');
  assert.ok(fs.existsSync(path.join(userDir, 'verified.json')));

  const before = hits;
  assert.equal((await m.install('good')).message, 'Good Model is already installed');
  assert.equal(hits, before);

  const { m: m2 } = manager(userDir);
  await m2.refresh();
  assert.equal(statusOf(m2, 'good'), 'installed');
  fs.appendFileSync(path.join(dir, 'b.json'), ' ');
  const { m: m3, logs } = manager(userDir);
  await m3.refresh();
  assert.equal(statusOf(m3, 'good'), 'available');
  assert.ok(logs.some((l) => /Good Model is not usable/.test(l)));
});

test('SHA-256 mismatch: failed with a clear message and NOTHING installed', async () => {
  const userDir = path.join(TMP, 'u3');
  const { m } = manager(userDir);
  await m.refresh();
  const r = await m.install('bad');
  assert.equal(r.ok, false);
  assert.match(r.message!, /w\.onnx failed verification \(SHA-256 mismatch\).*Nothing was installed/);
  const s = m.state('bad')!;
  assert.equal(s.status, 'failed');
  assert.match(s.message!, /SHA-256 mismatch/);
  assert.ok(!fs.existsSync(path.join(userDir, 'bad')));
  assert.ok(!fs.existsSync(path.join(userDir, 'bad.partial')));
  assert.equal(m.dirFor('bad'), null);
});

test('cancel mid-download: back to available, staging removed', async () => {
  const userDir = path.join(TMP, 'u4');
  const { m } = manager(userDir);
  await m.refresh();
  const p = m.install('slow');
  while (!(m.state('slow')!.progress?.received ?? 0)) await sleep(10);
  assert.equal(statusOf(m, 'slow'), 'downloading');
  assert.equal((await m.install('slow')).message, 'Slow Model is already being installed');
  assert.equal(m.cancelInstall('slow').ok, true);
  const r = await p;
  assert.deepEqual(r, { ok: false, message: 'Slow Model download cancelled' });
  assert.equal(statusOf(m, 'slow'), 'available');
  assert.ok(!fs.existsSync(path.join(userDir, 'slow.partial')));
  assert.ok(!fs.existsSync(path.join(userDir, 'slow')));
  assert.equal(m.cancelInstall('slow').ok, false);
});

test('refresh removes a stale .partial folder left by a crash', async () => {
  const userDir = path.join(TMP, 'u5');
  fs.mkdirSync(path.join(userDir, 'good.partial'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'good.partial', 'a.onnx'), 'half');
  const { m, logs } = manager(userDir);
  await m.refresh();
  assert.ok(!fs.existsSync(path.join(userDir, 'good.partial')));
  assert.ok(logs.some((l) => /unfinished download \(good\.partial\)/.test(l)));
  assert.equal(statusOf(m, 'good'), 'available');
});

test('install from folder: hashes checked, copied atomically; wrong / missing files install nothing', async () => {
  const userDir = path.join(TMP, 'u6');
  const { m } = manager(userDir);
  await m.refresh();
  const wrong = path.join(TMP, 'wrong');
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(wrong, 'local.onnx'), 'something else');
  let r = await m.importModel('local', wrong);
  assert.equal(r.ok, false);
  assert.match(r.message!, /local\.onnx in that folder isn't the Local Model file .*SHA-256 mismatch/);
  assert.equal(statusOf(m, 'local'), 'failed');
  assert.ok(!fs.existsSync(path.join(userDir, 'local')));

  r = await m.importModel('local', path.join(TMP, 'empty-dir-that-does-not-exist'));
  assert.match(r.message!, /The folder has no local\.onnx/);

  const good = path.join(TMP, 'downloads');
  fs.mkdirSync(path.join(good, 'local'), { recursive: true });
  fs.writeFileSync(path.join(good, 'local', 'local.onnx'), LOCAL);
  r = await m.importModel('local', good);
  assert.equal(r.ok, true, r.message);
  assert.equal(statusOf(m, 'local'), 'installed');
  assert.deepEqual(fs.readFileSync(path.join(userDir, 'local', 'local.onnx')), LOCAL);
  assert.ok(fs.existsSync(path.join(good, 'local', 'local.onnx')), 'the source is copied, not moved');

  const m2 = new ModelManager({ catalog: CATALOG, bundledDirs: [], userModelsDir: path.join(TMP, 'u6b'), log: () => {}, pickFolder: async () => null });
  assert.deepEqual(await m2.importModel('local'), { ok: false, message: 'No folder chosen' });
  assert.match((await m2.importModel('nosha', good)).message!, /isn't available in this version yet/);
});

test('remove: user-installed models go away; bundled ones refuse', async () => {
  const userDir = path.join(TMP, 'u2');
  const { m } = manager(userDir);
  await m.refresh();
  fs.rmSync(path.join(userDir, 'good'), { recursive: true, force: true });
  await m.refresh();
  assert.equal(statusOf(m, 'good'), 'available');
  assert.equal((await m.install('good')).ok, true);
  const r = await m.remove('good');
  assert.deepEqual(r, { ok: true, message: 'Removed Good Model' });
  assert.equal(statusOf(m, 'good'), 'available');
  assert.ok(!fs.existsSync(path.join(userDir, 'good')));
  assert.equal((await m.remove('good')).message, "Good Model isn't installed");
  const b = await m.remove('bund');
  assert.equal(b.ok, false);
  assert.match(b.message!, /ships with Krypt Studio and can't be removed/);
  assert.equal(statusOf(m, 'bund'), 'installed');
});

test('downloads: HTTPS only (plain http just for loopback); HTTP errors are sentences', async () => {
  assert.throws(() => checkDownloadUrl('http://example.com/model.onnx'), /only fetched over HTTPS/);
  assert.throws(() => checkDownloadUrl('ftp://127.0.0.1/x'), /Refusing to download over ftp/);
  assert.doesNotThrow(() => checkDownloadUrl('https://huggingface.co/x'));
  const dest = path.join(TMP, 'dl', 'missing.bin');
  await assert.rejects(downloadFile(`${BASE}/nope`, dest), /answered HTTP 404/);
  assert.ok(!fs.existsSync(dest), 'no partial file left');
  const ok = await downloadFile(`${BASE}/good/b.json`, path.join(TMP, 'dl', 'b.json'));
  assert.equal(ok.sha256, sha(FILES['good/b.json']));
});

test('mirrors: a failing source (HTTP error, wrong bytes) falls through to the next; all failing names every source and installs nothing', async () => {
  const userDir = path.join(TMP, 'mirrors');
  const { m, logs } = manager(userDir);
  await m.refresh();
  const ok = await m.install('mirrored');
  assert.equal(ok.ok, true, ok.message);
  assert.equal(statusOf(m, 'mirrored'), 'installed');
  assert.deepEqual(fs.readFileSync(path.join(userDir, 'mirrored', 'a.onnx')), FILES['good/a.onnx']);
  assert.equal(logs.filter((l) => /trying the next source/.test(l)).length, 2, logs.join(' | '));
  const bad = await m.install('nowhere');
  assert.equal(bad.ok, false);
  assert.match(bad.message ?? '', /any of its 2 sources/);
  assert.match(bad.message ?? '', /404/);
  assert.equal(statusOf(m, 'nowhere'), 'failed');
  assert.ok(!fs.existsSync(path.join(userDir, 'nowhere')) && !fs.existsSync(path.join(userDir, 'nowhere.partial')), 'nothing installed or left behind');
});

test('dev shadow copy: runtime DLLs come from next to the exe, else from the fallback folder (resources/bin)', () => {
  const cargoOut = path.join(TMP, 'shadow', 'target', 'release');
  const staged = path.join(TMP, 'shadow', 'resources', 'bin');
  fs.mkdirSync(cargoOut, { recursive: true });
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(cargoOut, 'analyzer.exe'), 'exe');
  fs.writeFileSync(path.join(cargoOut, 'own.dll'), 'own');
  fs.writeFileSync(path.join(staged, 'own.dll'), 'staged copy, must not win');
  fs.writeFileSync(path.join(staged, 'onnxruntime.dll'), 'ort');
  fs.writeFileSync(path.join(staged, 'notes.txt'), 'not a dll');
  const dst = path.join(TMP, 'shadow', 'run', 'analyzer.exe');
  shadowCopySync(path.join(cargoOut, 'analyzer.exe'), dst, /\.dll$/i, [staged, path.join(TMP, 'shadow', 'missing')]);
  const got = fs.readdirSync(path.dirname(dst)).sort();
  assert.deepEqual(got, ['analyzer.exe', 'onnxruntime.dll', 'own.dll']);
  assert.equal(fs.readFileSync(path.join(path.dirname(dst), 'own.dll'), 'utf8'), 'own');
});



await run('analyzer models');
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
