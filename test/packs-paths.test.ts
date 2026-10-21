// 'pack:<id>/<path>' samples in main: resolution (never escaping userData/packs), relinking on open with the pack
// named in the message, ProjectService.resolveSamplePath, and the engine launch arg --packs-dir (with the fallback
// for an engine build that predates it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Settings } from '@shared/types';
import { encodeContainer } from '../electron/project/container';
import { isPack, missingPacksText, relinkSamples, resolveFactoryPath, resolvePackPath } from '../electron/project/samples';
import { ProjectService } from '../electron/project/service';
import { EngineSupervisor } from '../electron/engine/supervisor';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-packpaths-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('resolvePackPath: pack:<id>/<path> → <packsDir>/<id>/<path>; unsafe paths resolve to the packs folder itself', () => {
  const dir = path.join(TMP, 'packs');
  assert.equal(resolvePackPath('pack:grand-piano/krypt/grand.sfz', dir), path.join(dir, 'grand-piano', 'krypt', 'grand.sfz'));
  assert.equal(resolvePackPath('pack:drums-1/samples/Kick v1.flac', dir), path.join(dir, 'drums-1', 'samples', 'Kick v1.flac'));
  for (const bad of [
    'pack:grand-piano/../other/x.sfz',
    'pack:grand-piano/a/../../x',
    'pack:../x.sfz',
    'pack:Grand/x.sfz',
    'pack:-x/y.sfz',
    'pack:grand-piano/',
    'pack:grand-piano',
    'pack:/x',
    'pack:grand-piano//x',
    'pack:grand-piano/./x',
    'pack:grand-piano/C:/Windows/x.dll',
    'pack:grand-piano/a\\..\\..\\x',
    'pack:grand-piano/x.sfz:stream',
  ]) {
    assert.equal(resolvePackPath(bad, dir), path.resolve(dir), bad);
  }
  // Not a pack path: unchanged; factory paths keep working.
  assert.equal(resolvePackPath('C:\\x.wav', dir), 'C:\\x.wav');
  assert.equal(isPack('pack:a/b'), true);
  assert.equal(isPack('factory:drums/kick.wav'), false);
  assert.equal(resolveFactoryPath('factory:drums/kick.wav', dir), path.join(dir, 'drums', 'kick.wav'));
});

function projectWith(paths: Record<string, string>) {
  const doc = new DocHost(createDefaultProject('Packs'), CATALOG);
  for (const [name, p] of Object.entries(paths)) doc.exec('samples.add', { path: p, name }, { actor: USER });
  return doc.project;
}

test('relinkSamples: missing pack samples are reported once per pack (by name), never as missing files or rewritten', () => {
  const packs = path.join(TMP, 'relink', 'packs');
  fs.mkdirSync(path.join(packs, 'have-pack', 'krypt'), { recursive: true });
  fs.writeFileSync(path.join(packs, 'have-pack', 'krypt', 'x.sfz'), '<region> sample=a.wav');
  const project = projectWith({
    Piano: 'pack:grand-test/krypt/grand.sfz',
    'Piano soft': 'pack:grand-test/krypt/soft.sfz',
    Strings: 'pack:strings-test/krypt/strings.sfz',
    Have: 'pack:have-pack/krypt/x.sfz',
    Kick: 'factory:drums/kick.wav',
  });
  const r = relinkSamples(project, null, (p) => fs.existsSync(p), { packsDir: packs });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.missingPacks.map((m) => m.id), ['grand-test', 'strings-test']);
  // Unknown to the catalog: the id stands in for the name.
  assert.equal(r.missingPacks[0].name, 'grand-test');
  assert.equal(r.project, project, 'pack paths are portable: never rewritten');
  // Without a packs folder to check, pack paths are assumed present (like factory:).
  assert.deepEqual(relinkSamples(project, null, () => false).missingPacks, []);

  assert.equal(missingPacksText([{ name: 'Grand Piano' }]), 'needs the Grand Piano sound pack: download it in Home ▸ Sounds');
  assert.equal(missingPacksText([{ name: 'Grand Piano' }, { name: 'Acoustic Drums Pack' }, { name: 'Strings' }]), 'needs the Grand Piano, Acoustic Drums and Strings sound packs: download them in Home ▸ Sounds');
  assert.equal(missingPacksText([]), '');
});

function service(root: string) {
  const doc = new DocHost(createDefaultProject('Svc'), CATALOG);
  const svc = new ProjectService({
    doc,
    appVersion: 'test',
    userDataDir: path.join(root, 'userData'),
    factoryDir: path.join(root, 'factory'),
    documentsDir: root,
    getSettings: () => ({ recent: [], autosaveSec: 0, browserRoots: [] }) as unknown as Settings,
    addRecent: () => {},
    log: () => {},
  });
  return { doc, svc };
}

test('ProjectService.resolveSamplePath: pack: → userData/packs (never escaping it), factory: → the factory folder', () => {
  const root = path.join(TMP, 'svc');
  const { svc } = service(root);
  const packs = path.join(root, 'userData', 'packs');
  assert.equal(svc.packsDir(), packs);
  assert.equal(svc.resolveSamplePath('pack:grand-piano/krypt/grand.sfz'), path.join(packs, 'grand-piano', 'krypt', 'grand.sfz'));
  assert.equal(svc.resolveSamplePath('pack:grand-piano/../../secrets.txt'), path.resolve(packs));
  assert.equal(svc.resolveSamplePath('factory:drums/kick.wav'), path.join(root, 'factory', 'drums', 'kick.wav'));
  assert.equal(svc.resolveSamplePath('D:\\Music\\loop.wav'), 'D:\\Music\\loop.wav');
});

test('opening a project whose pack isn\'t installed says which pack to download (and opens it anyway)', async () => {
  const root = path.join(TMP, 'open');
  fs.mkdirSync(root, { recursive: true });
  const project = projectWith({ Piano: 'pack:grand-test/krypt/grand.sfz' });
  const file = path.join(root, 'song.kstudio');
  fs.writeFileSync(file, encodeContainer(project, 'test'));
  const { doc, svc } = service(root);
  const r = await svc.open(file);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Opened "song" \(needs the grand-test sound pack: download it in Home ▸ Sounds\)/);
  assert.ok(Object.values(doc.project.samples).some((s) => s.path === 'pack:grand-test/krypt/grand.sfz'), 'kept as a portable pack path');
  // Installed: no note.
  const sfz = path.join(root, 'userData', 'packs', 'grand-test', 'krypt', 'grand.sfz');
  fs.mkdirSync(path.dirname(sfz), { recursive: true });
  fs.writeFileSync(sfz, '<region> sample=a.wav');
  const again = await svc.open(file);
  assert.equal(again.ok, true);
  assert.doesNotMatch(again.message!, /sound pack/);
});

// ── Engine launch: --packs-dir ─────────────────────────────────────────

const FAKE = String.raw`
const argv = process.argv.slice(2);
if (process.env.FAKE_OLD === '1') {
  for (const a of argv) if (a.startsWith('--') && !['--parent-pid', '--factory-dir'].includes(a)) { process.stderr.write("Unknown argument '" + a + "'\n\nUSAGE\n"); process.exit(2); }
}
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const ok = (data) => out({ id: m.id, ok: true, data });
  switch (m.cmd) {
    case 'hello': return ok({ engineVersion: 'fake ' + argv.join(' '), protocol: m.protocol, telemetry: { port: 1, token: 't' } });
    case 'openDevice': return ok({ open: true, id: 'x', name: 'Fake', backend: 'wasapi', sampleRate: 48000, bufferFrames: 256, outputLatencyMs: 5 });
    case 'ping': return ok({});
    case 'shutdown': ok({}); return setTimeout(() => process.exit(0), 10);
    default: return ok({});
  }
});
rl.on('close', () => process.exit(0));
`;
const fakeScript = path.join(TMP, 'fake-engine.cjs');
fs.writeFileSync(fakeScript, FAKE);

function engine(opts: { packsDir?: string; old?: boolean; exe?: () => string }) {
  const logs: string[] = [];
  const launches: string[][] = [];
  const sup = new EngineSupervisor({
    resolveExe: opts.exe ?? (() => process.execPath),
    missingMessage: 'missing',
    factoryDir: path.join(TMP, 'factory'),
    packsDir: opts.packsDir,
    audioSettings: () => ({ deviceId: null, bufferFrames: 256, sampleRate: 48000 }),
    loadProject: async () => ({ ok: true }),
    log: (level, m) => logs.push(`${level} ${m}`),
    spawn: (_exe, args) => {
      launches.push(args);
      return spawn(process.execPath, [fakeScript, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, FAKE_OLD: opts.old ? '1' : '0' } });
    },
  });
  return { sup, logs, launches };
}

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
}

test('the engine starts with --packs-dir <userData/packs>', async () => {
  const packs = path.join(TMP, 'userData', 'packs');
  const { sup, launches } = engine({ packsDir: packs });
  sup.start();
  await until(() => sup.status().state === 'running');
  assert.deepEqual(launches[0].slice(-2), ['--packs-dir', packs]);
  assert.match(sup.status().engineVersion ?? '', /--packs-dir/);
  await sup.stop();
  // No packs folder configured: the classic arguments only.
  const plain = engine({});
  plain.sup.start();
  await until(() => plain.sup.status().state === 'running');
  assert.ok(!plain.launches[0].includes('--packs-dir'));
  await plain.sup.stop();
});

test('an engine build that rejects --packs-dir is restarted without it (not counted as a crash), and a new build gets it again', async () => {
  const packs = path.join(TMP, 'userData', 'packs');
  let exe = 'engine-a.exe';
  const { sup, launches, logs } = engine({ packsDir: packs, old: true, exe: () => exe });
  sup.start();
  await until(() => sup.status().state === 'running');
  assert.ok(launches.length >= 2);
  assert.ok(launches[0].includes('--packs-dir'));
  assert.ok(!launches.at(-1)!.includes('--packs-dir'));
  assert.equal(sup.status().restarts, 0, 'not a crash');
  assert.ok(logs.some((l) => /predates sound packs/.test(l)));
  await sup.stop();
  // A different (newer) build: the flag is offered again.
  exe = 'engine-b.exe';
  const before = launches.length;
  sup.start();
  await until(() => launches.length > before);
  assert.ok(launches[before].includes('--packs-dir'));
  await until(() => sup.status().state === 'running');
  await sup.stop();
});

await run('packs-paths');
fs.rmSync(TMP, { recursive: true, force: true });
