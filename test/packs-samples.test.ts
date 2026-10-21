import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { zipSync } from 'fflate';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { PackDef, PackSample } from '@shared/packs/types';
import type { FactoryIndex, FactorySample } from '@shared/sounds/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { transitionGainDb } from '../electron/mcp/tools/craft';
import { sampleCountText } from '../electron/mcp/tools/packs';
import { PacksService } from '../electron/packs/service';
import { extractZipMembers } from '../electron/packs/zip';
import { DownloadCancelled } from '../electron/system/download';
import { SoundsService } from '../electron/sounds/service';
import { DEFAULT_SETTINGS } from '../electron/system/settings-store';
import { packSoundsText } from '../src/sounds/packsLogic';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-packsamples-'));
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex');
const BAR = 3840;

const HIT = new Uint8Array(crypto.randomBytes(40_000));
const WHOOSH = new Uint8Array(Buffer.from('whoosh '.repeat(9000)));
const README = new Uint8Array(Buffer.from('not ours'));
const EVIL = new Uint8Array(Buffer.from('escape attempt'));
const ZIP = zipSync({
  'Pack/Audio/hit_01.wav': [HIT, { level: 0 }],
  'Pack/Audio/whoosh_long.wav': [WHOOSH, { level: 6 }],
  'Pack/License.txt': README,
  '../evil.wav': EVIL,
});
const ZIP_BUF = Buffer.from(ZIP);

const BODY: Record<string, Buffer> = { 'sfx.zip': ZIP_BUF, slow: ZIP_BUF };
const hits: Record<string, number> = {};
const server = http.createServer((req, res) => {
  const key = decodeURIComponent((req.url ?? '/').slice(1));
  hits[key] = (hits[key] ?? 0) + 1;
  const body = BODY[key];
  if (!body) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Length': String(body.length) });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const member = (from: string, p: string, data: Uint8Array) => ({ from, path: p, sha256: sha(data), bytes: data.length });
const psmp = (p: string, kind: PackSample['kind'], extra: Partial<PackSample> = {}): PackSample => ({ path: p, name: p.split('/').pop()!.replace(/\.wav$/, ''), kind, tags: [], genres: [], lengthSec: 1, channels: 2, peakDb: -1, ...extra });

function sfxPack(over: Partial<PackDef> = {}, members = [member('Pack/Audio/hit_01.wav', 'sfx/hit-01.wav', HIT), member('Pack/Audio/whoosh_long.wav', 'sfx/whoosh-long.wav', WHOOSH)]): PackDef {
  const files = [{ path: 'downloads/sfx.zip', url: `${BASE}/sfx.zip`, sha256: sha(ZIP), bytes: ZIP.length, archive: { format: 'zip' as const, members } }];
  return {
    id: 'sfx-test',
    name: 'Test Effects',
    version: 1,
    description: 'Recorded test effects.',
    author: 'Test Recordist',
    homepage: 'https://example.com/sfx',
    licence: { spdx: 'CC0-1.0', name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Test Effects by Test Recordist (CC0 1.0).' },
    files,
    sfz: [],
    samples: [psmp('pack:sfx-test/sfx/hit-01.wav', 'impact', { name: 'Door Slam' }), psmp('pack:sfx-test/sfx/whoosh-long.wav', 'whoosh', { name: 'Long Air Pass', bpm: 120, bars: 1, lengthSec: 2, peakDb: -7 })],
    bytes: ZIP.length,
    ramMb: 0,
    contents: ['Impacts and whooshes'],
    ...over,
  };
}

let n = 0;
function rig(catalog: PackDef[]) {
  const dir = path.join(TMP, `case-${++n}`, 'packs');
  const logs: string[] = [];
  const svc = new PacksService({ dir, catalog, log: (l, m) => logs.push(`${l} ${m}`), freeBytes: async () => null, throttleMs: 5 });
  return { dir, svc, logs };
}

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(path.relative(root, f).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

test('zip: only the listed members are extracted (stored + deflated), verified, the archive deleted; extra entries never written', async () => {
  const { dir, svc } = rig([sfxPack()]);
  const r = await svc.install('sfx-test');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Installed Test Effects .*Its 2 sounds are in the Browser under Sound packs\./);
  const root = path.join(dir, 'sfx-test');
  assert.deepEqual(tree(root), ['LICENSE.txt', 'pack.json', 'sfx/hit-01.wav', 'sfx/whoosh-long.wav']);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, 'sfx', 'hit-01.wav'))), HIT);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, 'sfx', 'whoosh-long.wav'))), WHOOSH);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.wav')) && !fs.existsSync(path.join(path.dirname(dir), 'evil.wav')), "'../evil.wav' in the archive is never written");
  const lic = fs.readFileSync(path.join(root, 'LICENSE.txt'), 'utf8');
  assert.ok(lic.includes('downloads/sfx.zip (a ZIP archive; deleted after these members were extracted from it)'));
  assert.ok(lic.includes(`${sha(HIT)}  ${HIT.length}  sfx/hit-01.wav (from "Pack/Audio/hit_01.wav")`));
  assert.deepEqual(svc.samples().map((s) => [s.path, s.kind]), [
    ['pack:sfx-test/sfx/hit-01.wav', 'impact'],
    ['pack:sfx-test/sfx/whoosh-long.wav', 'whoosh'],
  ]);
  const info = svc.sampleInfo();
  assert.deepEqual(info.packs, [{ id: 'sfx-test', name: 'Test Effects', installed: true, count: 2, byKind: { impact: 1, whoosh: 1 } }]);
  assert.equal(info.samples.length, 2);
  const rm = await svc.remove('sfx-test');
  assert.equal(rm.ok, true, rm.message);
  assert.deepEqual(svc.samples(), []);
  assert.equal(svc.sampleInfo().packs[0].installed, false);
});

test('zip: a member whose SHA-256 is wrong fails with a sentence, and nothing of that archive is left behind', async () => {
  const bad = { ...member('Pack/Audio/whoosh_long.wav', 'sfx/whoosh-long.wav', WHOOSH), sha256: sha('something else') };
  const { dir, svc } = rig([sfxPack({}, [member('Pack/Audio/hit_01.wav', 'sfx/hit-01.wav', HIT), bad])]);
  const r = await svc.install('sfx-test');
  assert.equal(r.ok, false);
  assert.match(r.message!, /^Couldn't install Test Effects: downloads\/sfx\.zip couldn't be unpacked: Pack\/Audio\/whoosh_long\.wav failed verification \(SHA-256 mismatch\)/);
  assert.match(r.message!, /Nothing was installed\./);
  const e = svc.state().packs[0];
  assert.equal(e.status, 'failed');
  assert.match(e.error!, /SHA-256 mismatch/);
  assert.ok(!fs.existsSync(path.join(dir, 'sfx-test')), 'not installed');
  assert.deepEqual(tree(path.join(dir, 'sfx-test.partial')).filter((f) => f !== '.krypt-partial.json'), []);
  assert.deepEqual(svc.samples(), []);
});

test('zip: a listed member missing from the archive fails before anything is written', async () => {
  const { dir, svc } = rig([sfxPack({}, [member('Pack/Audio/hit_01.wav', 'sfx/hit-01.wav', HIT), member('Pack/Audio/gone.wav', 'sfx/gone.wav', HIT)])]);
  const r = await svc.install('sfx-test');
  assert.equal(r.ok, false);
  assert.match(r.message!, /the archive doesn't contain "Pack\/Audio\/gone\.wav"; it changed on the server/);
  assert.deepEqual(tree(path.join(dir, 'sfx-test.partial')).filter((f) => f !== '.krypt-partial.json'), []);
});

test("zip: a member path that escapes the pack folder ('../') is refused before any download", async () => {
  const before = hits['sfx.zip'] ?? 0;
  for (const bad of ['../escape.wav', 'sfx/../../escape.wav', 'C:/escape.wav', 'pack.json']) {
    const { dir, svc } = rig([sfxPack({}, [member('../evil.wav', bad, EVIL)])]);
    const r = await svc.install('sfx-test');
    assert.equal(r.ok, false, bad);
    assert.match(r.message!, /invalid file path/, bad);
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.wav')), bad);
    assert.ok(!fs.existsSync(path.join(dir, 'escape.wav')), bad);
  }
  assert.equal(hits['sfx.zip'] ?? 0, before, 'nothing was downloaded');
});

test('zip: cancel mid-extract keeps the finished members; extract skips what is already in place', async () => {
  const dir = path.join(TMP, 'cancel');
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'a.zip');
  fs.writeFileSync(zipPath, ZIP);
  const ctrl = new AbortController();
  const wanted = [
    { from: 'Pack/Audio/hit_01.wav', dest: path.join(dir, 'out', 'hit.wav'), sha256: sha(HIT), bytes: HIT.length },
    { from: 'Pack/Audio/whoosh_long.wav', dest: path.join(dir, 'out', 'whoosh.wav'), sha256: sha(WHOOSH), bytes: WHOOSH.length },
  ];
  let seen = 0;
  await assert.rejects(
    extractZipMembers(zipPath, wanted, {
      signal: ctrl.signal,
      done: async () => {
        if (++seen === 2) ctrl.abort();
        return false;
      },
    }),
    (err) => err instanceof DownloadCancelled,
  );
  assert.ok(fs.existsSync(wanted[0].dest));
  assert.ok(!fs.existsSync(wanted[1].dest));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'out')), ['hit.wav'], 'no temp file left');
  const skipped: string[] = [];
  await extractZipMembers(zipPath, wanted, {
    done: async (m) => {
      const have = fs.existsSync(m.dest);
      if (have) skipped.push(m.from);
      return have;
    },
  });
  assert.deepEqual(skipped, ['Pack/Audio/hit_01.wav']);
  assert.deepEqual(new Uint8Array(fs.readFileSync(wanted[1].dest)), WHOOSH);
  await assert.rejects(extractZipMembers(zipPath, [{ ...wanted[1], dest: path.join(dir, 'out', 'small.wav'), bytes: 10 }]), /wrong size in the archive/);
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'small.wav')));
  fs.writeFileSync(path.join(dir, 'b.zip'), 'definitely not a zip file, just text that is long enough');
  await assert.rejects(extractZipMembers(path.join(dir, 'b.zip'), wanted), /isn't a ZIP archive/);
});

test('instrument packs without archives install exactly as before (no samples)', async () => {
  const data = new Uint8Array(crypto.randomBytes(5000));
  BODY['plain.flac'] = Buffer.from(data);
  const def = sfxPack({ id: 'plain', name: 'Plain', files: [{ path: 'samples/a.flac', url: `${BASE}/plain.flac`, sha256: sha(data), bytes: data.length }], sfz: [{ path: 'krypt/a.sfz', text: '<region> sample=../samples/a.flac\n' }], samples: undefined, bytes: data.length, ramMb: 4 });
  const { dir, svc } = rig([def]);
  const r = await svc.install('plain');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Its presets are ready in the preset browser\.$/);
  assert.deepEqual(tree(path.join(dir, 'plain')), ['LICENSE.txt', 'krypt/a.sfz', 'pack.json', 'samples/a.flac']);
  assert.deepEqual(svc.sampleInfo(), { packs: [], samples: [] });
});

const fsmp = (p: string, kind: FactorySample['kind'], extra: Partial<FactorySample> = {}): FactorySample => ({ path: p, name: p.split('/').pop()!.replace(/\.wav$/, ''), kind, tags: [], genres: [], lengthSec: 1, channels: 2, peakDb: -1, ...extra });

test('SoundsService: installed pack samples join factoryIndex() after the factory, deduplicated; factorySamples() stays factory-only', () => {
  const dir = path.join(TMP, 'sounds');
  const factory = path.join(dir, 'factory');
  fs.mkdirSync(factory, { recursive: true });
  const idx: FactoryIndex = { version: 1, generator: 'fixture', samples: [fsmp('factory:fx/whoosh-1.wav', 'whoosh'), fsmp('factory:fx/impact.wav', 'impact')] };
  fs.writeFileSync(path.join(factory, 'index.json'), JSON.stringify(idx));
  let packSamples: PackSample[] = [psmp('pack:sfx-test/sfx/a.wav', 'foley'), psmp('pack:sfx-test/sfx/a.wav', 'foley'), psmp('pack:sfx-test/sfx/b.wav', 'retro')];
  const svc = new SoundsService({
    doc: new DocHost(createDefaultProject('T'), CATALOG, { strict: true }),
    userDataDir: path.join(dir, 'userData'),
    factoryDir: factory,
    getSettings: () => ({ browserRoots: [] }),
    broadcast: () => {},
    log: () => {},
    factoryPresets: [],
    packSamples: () => packSamples,
  });
  assert.deepEqual(svc.factoryIndex()!.samples.map((s) => s.path), ['factory:fx/whoosh-1.wav', 'factory:fx/impact.wav', 'pack:sfx-test/sfx/a.wav', 'pack:sfx-test/sfx/b.wav']);
  assert.deepEqual(svc.factorySamples().map((s) => s.path), ['factory:fx/whoosh-1.wav', 'factory:fx/impact.wav']);
  packSamples = [];
  assert.equal(svc.factoryIndex()!.samples.length, 2);
  fs.rmSync(path.join(factory, 'index.json'));
  packSamples = [psmp('pack:sfx-test/sfx/b.wav', 'retro')];
  assert.deepEqual(svc.factoryIndex()!.samples.map((s) => s.path), ['pack:sfx-test/sfx/b.wav']);
  packSamples = [];
  assert.equal(svc.factoryIndex(), null);
});

const LIB = path.join(TMP, 'lib');

function resolve(p: string): string {
  if (p.startsWith('factory:')) return path.join(LIB, 'factory', p.slice('factory:'.length));
  if (p.startsWith('pack:')) return path.join(LIB, 'packs', p.slice('pack:'.length));
  return p;
}

function touch(samples: readonly FactorySample[]): void {
  for (const s of samples) {
    const f = resolve(s.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'RIFF');
  }
}

function makeDeps(index: FactoryIndex | null, packs?: PacksService) {
  const doc = new DocHost(createDefaultProject('Packs'), CATALOG, { strict: true });
  doc.exec('transport.set', { bpm: 120 }, { actor: USER });
  const deps: MainDeps = {
    doc,
    engine: {
      async request() {
        return { ok: true, data: {} as never };
      },
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async render() {
        return { ok: false, message: 'n/a' };
      },
      async analyzeFile() {
        return { ok: false, message: 'n/a' };
      },
      async sampleInfo(p) {
        return { ok: true, data: { path: p, frames: 48000, sampleRate: 48000, channels: 2, durationSec: 1 } };
      },
      async restart() {
        return { ok: true };
      },
    },
    project: {
      status: () => ({ path: null, name: 'Packs', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: resolve,
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [],
    },
    getSettings: () => DEFAULT_SETTINGS,
    updateSettings: () => DEFAULT_SETTINGS,
    broadcast: () => {},
    userDataDir: path.join(TMP, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  if (index !== null) deps.sounds = { presets: () => [], preset: () => undefined, factoryIndex: () => index, saveUser: () => ({ ok: false, message: 'n/a' }), deleteUser: () => ({ ok: false, message: 'n/a' }) };
  if (packs) deps.packs = packs;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'packs-test', name: 'Packs Test' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { deps, doc, call };
}

const LIBRARY: FactoryIndex = {
  version: 1,
  generator: 'fixture',
  samples: [
    fsmp('factory:fx/whoosh-short.wav', 'whoosh', { bpm: 120, bars: 1, lengthSec: 2 }),
    fsmp('factory:fx/tape-stop.wav', 'tape-stop', { lengthSec: 1 }),
    fsmp('factory:fx/swell-2.wav', 'swell', { bpm: 120, bars: 2, lengthSec: 4 }),
    fsmp('factory:fx/sweep-up-1.wav', 'sweep-up', { bpm: 120, bars: 1, lengthSec: 2 }),
    fsmp('factory:fx/revcym-1.wav', 'reverse-cymbal', { bpm: 120, bars: 1, lengthSec: 2 }),
    { ...psmp('pack:sfx-test/sfx/whoosh-short.wav', 'whoosh', { bpm: 120, bars: 1, lengthSec: 2 }) },
    { ...psmp('pack:sfx-test/sfx/whoosh-dark.wav', 'whoosh', { name: 'Dark Air Pass', bpm: 120, bars: 2, lengthSec: 4, tags: ['dark'], peakDb: -7 }) },
    { ...psmp('pack:sfx-test/sfx/rain.wav', 'ambience', { name: 'Rain On Window', tags: ['rain'] }) },
  ],
};
touch(LIBRARY.samples);

const fx = (doc: DocHost) => {
  const p = doc.project;
  return Object.values(p.playlist.clips)
    .filter((c) => c.kind === 'audio')
    .map((c) => ({ clip: c, ch: p.channels[c.channelId!], path: p.samples[p.channels[c.channelId!].generator.sampleId!].path }))
    .sort((a, b) => a.clip.start - b.clip.start);
};

test('find_samples: installed pack samples are listed (source "pack"), factory wins exact ties, new kinds filter', async () => {
  const { call } = makeDeps(LIBRARY);
  const w = await call('find_samples', { kind: 'whoosh', genre: 'any' });
  assert.equal(w.ok, true, w.message);
  const rows = (w.data as { samples: Array<{ path: string; source: string }> }).samples;
  assert.deepEqual(rows.map((r) => [r.path, r.source]), [
    ['factory:fx/whoosh-short.wav', 'factory'],
    ['pack:sfx-test/sfx/whoosh-dark.wav', 'pack'],
    ['pack:sfx-test/sfx/whoosh-short.wav', 'pack'],
  ]);
  const dark = await call('find_samples', { kind: 'whoosh', query: 'dark', genre: 'any' });
  assert.equal((dark.data as { samples: Array<{ path: string }> }).samples[0].path, 'pack:sfx-test/sfx/whoosh-dark.wav');
  assert.match(dark.text!, /pack:sfx-test\/sfx\/whoosh-dark\.wav {2}whoosh · Dark Air Pass · 2 bars @120 bpm/);
  const amb = await call('find_samples', { kind: 'ambience' });
  assert.deepEqual((amb.data as { samples: Array<{ path: string }> }).samples.map((s) => s.path), ['pack:sfx-test/sfx/rain.wav']);
  const all = await call('find_samples', { kind: 'fx', genre: 'any', limit: 100 });
  const kinds = new Set((all.data as { samples: Array<{ kind: string }> }).samples.map((s) => s.kind));
  for (const k of ['whoosh', 'tape-stop', 'swell']) assert.ok(kinds.has(k), k);
  assert.ok(!kinds.has('ambience'));
});

test('load_sample: pack: paths load like factory ones; a missing pack or a bad path is refused with a sentence', async () => {
  const { doc, call } = makeDeps(LIBRARY);
  const r = await call('load_sample', { sample: 'pack:sfx-test/sfx/rain.wav', name: 'Rain' });
  assert.equal(r.ok, true, r.message);
  const ch = Object.values(doc.project.channels).find((c) => c.name === 'Rain')!;
  assert.equal(doc.project.samples[ch.generator.sampleId!].path, 'pack:sfx-test/sfx/rain.wav');
  const missing = await call('load_sample', { sample: 'pack:no-such-pack/a.wav' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /There's no sound pack "no-such-pack"/);
  const notThere = await call('load_sample', { sample: 'pack:sfx-test/sfx/never.wav' });
  assert.equal(notThere.ok, false);
  const bad = await call('load_sample', { sample: 'pack:sfx-test/../../etc.wav' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not a valid sound-pack sample path/);
});

test('add_transition whoosh / swell / tape-stop: end on the boundary, pack sounds levelled by their peak', async () => {
  const { doc, call } = makeDeps(LIBRARY);
  const w = await call('add_transition', { at_bars: [9], kind: 'whoosh', length_bars: 2 });
  assert.equal(w.ok, true, w.message);
  assert.match(w.message, /"Dark Air Pass" from the Test Effects pack|"Dark Air Pass" from the sfx-test pack/);
  let clips = fx(doc);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].path, 'pack:sfx-test/sfx/whoosh-dark.wav');
  assert.equal(clips[0].clip.start + clips[0].clip.length, 8 * BAR, 'ends exactly on the boundary');
  assert.equal(clips[0].clip.length, 2 * BAR);
  assert.ok(Math.abs(clips[0].ch.volume - 10 ** (-4 / 20)) < 1e-3, String(clips[0].ch.volume));

  const sw = await call('add_transition', { at_bars: [17], kind: 'swell' });
  assert.equal(sw.ok, true, sw.message);
  clips = fx(doc);
  const swell = clips.find((c) => c.path === 'factory:fx/swell-2.wav')!;
  assert.equal(swell.clip.start, 14 * BAR);
  assert.equal(swell.clip.start + swell.clip.length, 16 * BAR);

  const ts = await call('add_transition', { at_bars: [25], kind: 'tape-stop' });
  assert.equal(ts.ok, true, ts.message);
  const stop = fx(doc).find((c) => c.path === 'factory:fx/tape-stop.wav')!;
  assert.equal(stop.clip.start + stop.clip.length, 24 * BAR, 'the tape stop ends on the boundary');
  assert.equal(stop.clip.length, Math.round(1 * (120 / 60) * 960));
  assert.ok(Math.abs(stop.ch.volume - 10 ** (-8 / 20)) < 1e-3);
});

test('add_transition without whoosh / swell / tape-stop samples: up-sweep, reverse cymbal, silence; without any kit: filter sweep, reversed crash', async () => {
  const thin: FactoryIndex = { version: 1, generator: 'fixture', samples: LIBRARY.samples.filter((s) => s.kind === 'sweep-up' || s.kind === 'reverse-cymbal') };
  const { doc, call } = makeDeps(thin);
  const w = await call('add_transition', { at_bars: [9], kind: 'whoosh' });
  assert.equal(w.ok, true, w.message);
  assert.match(w.message, /No whoosh sample: neither the factory kit nor an installed sound pack has "whoosh" samples\. Used an up-sweep \("sweep-up-1"\) instead\./);
  const sw = await call('add_transition', { at_bars: [17], kind: 'swell' });
  assert.equal(sw.ok, true, sw.message);
  assert.match(sw.message, /Used a reverse cymbal \("revcym-1"\) instead/);
  assert.deepEqual(fx(doc).map((c) => [c.path, c.clip.start + c.clip.length]), [
    ['factory:fx/sweep-up-1.wav', 8 * BAR],
    ['factory:fx/revcym-1.wav', 16 * BAR],
  ]);
  const ts = await call('add_transition', { at_bars: [25], kind: 'tape-stop' });
  assert.equal(ts.ok, true, ts.message);
  assert.match(ts.message, /Dropped the master out for the last beat instead/);
  assert.equal(Object.values(doc.project.automations).length, 1);

  const none = makeDeps(null);
  const w2 = await none.call('add_transition', { at_bars: [9], kind: 'whoosh' });
  assert.equal(w2.ok, true, w2.message);
  assert.match(w2.message, /Used a filter sweep instead\./);
  const s2 = await none.call('add_transition', { at_bars: [17], kind: 'swell' });
  assert.equal(s2.ok, true, s2.message);
  assert.match(s2.message, /Used a reversed crash/);
  const crash = fx(none.doc)[0];
  assert.equal(crash.ch.generator.params.reverse, 1);
  assert.equal(crash.clip.start + crash.clip.length, 16 * BAR);
});

test('list_packs: sample counts by kind for every pack, with a find_samples hint once installed', async () => {
  const pack = sfxPack();
  const { svc } = rig([pack]);
  const before = makeDeps(LIBRARY, svc);
  const r = await before.call('list_packs', {});
  assert.equal(r.ok, true, r.message);
  const row = (r.data as { packs: Array<{ id: string; samples: { count: number; byKind: Record<string, number> }; ramMb: number }> }).packs[0];
  assert.deepEqual(row.samples, { count: 2, byKind: { impact: 1, whoosh: 1 } });
  assert.equal(row.ramMb, 0);
  assert.match(r.text!, /2 sounds \((impact 1, whoosh 1|whoosh 1, impact 1)\)/);
  assert.doesNotMatch(r.text!, /RAM per instrument/);
  assert.doesNotMatch(r.text!, /in find_samples/);
  const inst = await svc.install('sfx-test');
  assert.equal(inst.ok, true, inst.message);
  const after = await before.call('list_packs', {});
  assert.match(after.text!, /2 sounds \(.*\) in find_samples/);
});

test('helpers: transitionGainDb, sampleCountText, packSoundsText', () => {
  assert.equal(transitionGainDb({ path: 'factory:fx/a.wav', peakDb: -12 }, -8), -8);
  assert.equal(transitionGainDb({ path: 'pack:x/a.wav', peakDb: -7 }, -10), -4);
  assert.equal(transitionGainDb({ path: 'pack:x/a.wav', peakDb: -40 }, -10), 2, 'at most +12 dB');
  assert.equal(transitionGainDb({ path: 'pack:x/a.wav', peakDb: 3 }, -10), -14, 'hot files come down');
  assert.equal(sampleCountText(140, { foley: 60, ambience: 40, impact: 20, whoosh: 20 }), '140 sounds (foley 60, ambience 40, impact 20, whoosh 20)');
  assert.equal(packSoundsText({ count: 140, byKind: { impact: 20, foley: 60, ambience: 40, retro: 20 } }), 'Adds 140 sounds: foley, ambience, impacts…');
  assert.equal(packSoundsText({ count: 1, byKind: { whoosh: 1 } }), 'Adds 1 sound: whooshes');
  assert.equal(packSoundsText({ count: 0, byKind: {} }), null);
  assert.equal(packSoundsText(undefined), null);
});

await run('packs-samples');
server.close();
