import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Settings, SoundsState } from '@shared/types';
import { SoundsService } from '../electron/sounds/service';
import { parseFactoryIndex } from '../electron/sounds/factoryIndex';
import { FIXTURE_PRESETS, INDEX_SAMPLES, LEAD_EDM, writeFactory } from './sounds-fixtures';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-sounds-svc-'));
let n = 0;

function rig(opts: { factory?: 'index' | 'none' | 'files'; presets?: typeof FIXTURE_PRESETS; roots?: Settings['browserRoots'] } = {}) {
  const dir = path.join(TMP, `case-${++n}`);
  const userData = path.join(dir, 'userData');
  const factory = path.join(dir, 'factory');
  fs.mkdirSync(factory, { recursive: true });
  if (opts.factory !== 'none') writeFactory(factory, { index: opts.factory !== 'files' });
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  const broadcasts: SoundsState[] = [];
  const logs: Array<{ level: string; m: string }> = [];
  let t = 1_000_000;
  const roots = opts.roots ?? [];
  const svc = new SoundsService({
    doc,
    userDataDir: userData,
    factoryDir: factory,
    getSettings: () => ({ browserRoots: roots }),
    broadcast: (s) => broadcasts.push(s),
    log: (level, m) => logs.push({ level, m }),
    factoryPresets: opts.presets ?? FIXTURE_PRESETS,
    profileDirs: () => ['Documents', 'Music', 'Desktop', 'Downloads'].map((d) => path.join(dir, 'home', d)),
    now: () => t,
  });
  const byName = (name: string) => Object.values(doc.project.channels).find((c) => c.name === name)!;
  return { dir, userData, factory, doc, svc, broadcasts, logs, byName, tick: (ms = 2000) => (t += ms) };
}

test('state: factory + user counts, summaries, the user folder (not created until needed)', () => {
  const { svc, userData } = rig();
  const s = svc.state();
  assert.equal(s.factoryCount, FIXTURE_PRESETS.length);
  assert.equal(s.userCount, 0);
  assert.equal(s.presets.length, FIXTURE_PRESETS.length);
  assert.equal(s.userDir, path.join(userData, 'presets'));
  assert.equal(fs.existsSync(s.userDir), false);
  const lead = s.presets.find((p) => p.id === LEAD_EDM.id)!;
  assert.deepEqual(lead, { id: LEAD_EDM.id, kind: 'instrument', name: 'Anthem Supersaw', role: 'lead', plugin: 'krypt.wavetable', tags: LEAD_EDM.tags, genres: LEAD_EDM.genres, description: LEAD_EDM.description, source: 'factory' });
  assert.equal(svc.get(LEAD_EDM.id).data, LEAD_EDM);
  const missing = svc.get('factory:lead/nope');
  assert.equal(missing.ok, false);
  assert.match(missing.message!, /no longer exists/);
});

test('saveChannel / saveChain write one atomic JSON file per preset, unique ids, broadcast; rename and delete', () => {
  const { svc, doc, byName, broadcasts, userData } = rig();
  const keys = byName('Keys');
  doc.exec('presets.applyToChannel', { channelId: keys.id, preset: LEAD_EDM }, { actor: USER });
  const r = svc.saveChannel(keys.id, { name: 'My Lead', tags: ['Bright'], genres: ['big room', 'nope'], role: 'lead', description: 'Mine.' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.id, 'user:my-lead');
  assert.equal(r.data!.source, 'user');
  assert.match(r.message!, /Saved preset "My Lead"/);
  const file = path.join(userData, 'presets', 'my-lead.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.plugin, 'krypt.wavetable');
  assert.deepEqual(saved.genres, ['edm'], 'aliases resolve, unknown genres are dropped');
  assert.deepEqual(saved.tags, ['bright']);
  assert.equal(saved.fx.length, 2);
  assert.equal(fs.readdirSync(path.join(userData, 'presets')).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].userCount, 1);
  assert.equal(svc.presets().length, FIXTURE_PRESETS.length + 1);
  assert.equal(svc.preset('user:my-lead')?.name, 'My Lead');
  assert.deepEqual(doc.project.channels[keys.id].generator.preset, { id: 'user:my-lead', name: 'My Lead' });
  assert.equal(doc.getHistory().length, 1, 'only the preset load is in the history');
  let lastActor = '';
  doc.subscribe((c) => (lastActor = c.actor.kind));

  const again = svc.saveChannel(keys.id, { name: 'My Lead' });
  assert.equal(again.data!.id, 'user:my-lead-2');
  assert.equal(lastActor, 'user');
  assert.deepEqual(doc.project.channels[keys.id].generator.preset, { id: 'user:my-lead-2', name: 'My Lead' });
  const chain = svc.saveChain('master', { name: 'Club', role: 'master', tags: [] });
  assert.equal(chain.ok, true, chain.message);
  assert.equal(chain.data!.id, 'user:chain/club');
  assert.ok(fs.existsSync(path.join(userData, 'presets', 'chain.club.json')));
  const badRole = svc.saveChannel(keys.id, { name: 'X', role: 'wobble' });
  assert.equal(badRole.ok, false);
  assert.match(badRole.message!, /isn't an instrument role/);
  assert.equal(svc.saveChain('master', { name: 'Y', role: 'lead-ish' }).ok, false);
  assert.equal(svc.saveChannel('ch_nope', { name: 'Z' }).ok, false);
  const noName = svc.saveUser({ ...LEAD_EDM, name: '   ' });
  assert.equal(noName.ok, false);
  assert.match(noName.message!, /name/);
  const emptyChain = svc.saveChain(byName('Keys').insertId, { name: 'Nothing' });
  assert.equal(emptyChain.ok, true, 'Keys has the preset chain');

  const ren = svc.renameUser('user:my-lead', 'Glass Lead');
  assert.equal(ren.ok, true, ren.message);
  assert.equal(ren.data!.id, 'user:my-lead', 'the id is stable');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'Glass Lead');
  assert.equal(svc.renameUser(LEAD_EDM.id, 'x').ok, false);
  const del = svc.deleteUser('user:my-lead');
  assert.equal(del.ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(svc.preset('user:my-lead'), undefined);
  assert.equal(svc.deleteUser(LEAD_EDM.id).ok, false);
  assert.equal(svc.deleteUser('user:gone').ok, false);
  assert.equal(svc.state().userCount, 3);
});

test('user folder: invalid / foreign / duplicate files are skipped with a warning; outside edits are picked up', () => {
  const { svc, userData, logs, broadcasts, tick } = rig();
  const dir = path.join(userData, 'presets');
  fs.mkdirSync(dir, { recursive: true });
  const good = { ...LEAD_EDM, id: 'user:handmade', name: 'Handmade' };
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ ...good, id: 'user:bad', role: 'kazoo' }));
  fs.writeFileSync(path.join(dir, 'factory.json'), JSON.stringify({ ...good, id: 'factory:lead/fake' }));
  fs.writeFileSync(path.join(dir, 'a-handmade.json'), JSON.stringify(good));
  fs.writeFileSync(path.join(dir, 'b-dupe.json'), JSON.stringify(good));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  tick();
  const all = svc.presets();
  assert.equal(all.filter((p) => p.id.startsWith('user:')).length, 1);
  assert.equal(svc.preset('user:handmade')?.name, 'Handmade');
  const warns = logs.filter((l) => l.level === 'warn').map((l) => l.m).join('\n');
  assert.match(warns, /broken\.json: not readable JSON/);
  assert.match(warns, /bad\.json: role/);
  assert.match(warns, /factory\.json: its id "factory:lead\/fake" isn't a user id/);
  assert.match(warns, /b-dupe\.json: another file already has the id/);
  assert.ok(broadcasts.length >= 1, 'an outside change is broadcast');
  fs.writeFileSync(path.join(dir, 'c-new.json'), JSON.stringify({ ...good, id: 'user:new-one', name: 'New One' }));
  assert.equal(svc.preset('user:new-one'), undefined);
  tick();
  assert.equal(svc.preset('user:new-one')?.name, 'New One');
  fs.rmSync(path.join(dir, 'c-new.json'));
  svc.reload();
  assert.equal(svc.preset('user:new-one'), undefined);
});

test('factory index: read and validated, bad entries skipped, missing = null, regenerated = re-read', () => {
  const { svc, factory, logs } = rig();
  const idx = svc.factoryIndex();
  assert.ok(idx);
  assert.equal(idx!.samples.length, INDEX_SAMPLES.length);
  assert.deepEqual(svc.factorySamples().map((s) => s.path), INDEX_SAMPLES.map((s) => s.path));
  const extra = [{ path: 'nope.wav', name: 'x' }, { ...INDEX_SAMPLES[0], path: 'factory:../../evil.wav' }, { ...INDEX_SAMPLES[2], path: 'factory:kicks/k3.wav', genres: ['trap', 'polka'] }];
  fs.writeFileSync(path.join(factory, 'index.json'), JSON.stringify({ version: 1, generator: 'test 2', samples: [...INDEX_SAMPLES, ...extra], padding: 'x'.repeat(10) }));
  const idx2 = svc.factoryIndex()!;
  assert.equal(idx2.generator, 'test 2');
  assert.equal(idx2.samples.length, INDEX_SAMPLES.length + 1);
  assert.deepEqual(idx2.samples.find((s) => s.path === 'factory:kicks/k3.wav')!.genres, ['trap']);
  assert.match(logs.map((l) => l.m).join('\n'), /skipped 2 malformed entries/);
  fs.writeFileSync(path.join(factory, 'index.json'), JSON.stringify({ version: 2, samples: [] }));
  assert.equal(svc.factoryIndex(), null);
  assert.match(logs.map((l) => l.m).join('\n'), /is not valid/);
  fs.rmSync(path.join(factory, 'index.json'));
  assert.equal(svc.factoryIndex(), null);
  assert.deepEqual(svc.factorySamples(), []);
  assert.equal(parseFactoryIndex(null).index, null);
  assert.equal(parseFactoryIndex({ version: 1, generator: 'g', samples: [] }).index?.samples.length, 0);
});

test('works with no factory data at all', () => {
  const { svc } = rig({ factory: 'none', presets: [] });
  assert.equal(svc.state().factoryCount, 0);
  assert.equal(svc.presets().length, 0);
  assert.equal(svc.factoryIndex(), null);
});

test('suggestSampleFolders: sample-library names under the profile, ≥ 20 audio files, outer folders only, inBrowser', async () => {
  const dir = path.join(TMP, `case-${n + 1}`);
  const home = path.join(dir, 'home');
  const wavs = (sub: string, count: number, ext = 'wav') => {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(home, sub, `s${i}.${ext}`), 'RIFF');
  };
  wavs('Documents/Samples/Kicks', 15);
  wavs('Documents/Samples/Snares', 12);
  wavs('Downloads/Trap Drum Kit Vol 2', 30);
  wavs('Downloads/Holiday Photos', 50);
  wavs('Music/Loops Pack', 5);
  wavs('Desktop/Producing/My One Shots', 22, 'flac');
  wavs('Music/Splice/Samples/packs', 25);
  fs.writeFileSync(path.join(home, 'Downloads', 'Trap Drum Kit Vol 2', 'readme.txt'), 'x');
  const { svc } = rig({ roots: [{ id: 'r1', name: 'Kit', path: path.join(home, 'Downloads', 'Trap Drum Kit Vol 2') }] });
  const out = await svc.suggestSampleFolders();
  const rel = out.map((o) => ({ ...o, path: path.relative(home, o.path).split(path.sep).join('/') }));
  assert.deepEqual(rel, [
    { path: 'Documents/Samples', audioFiles: 27, inBrowser: false },
    { path: 'Music/Splice', audioFiles: 25, inBrowser: false },
    { path: 'Desktop/Producing/My One Shots', audioFiles: 22, inBrowser: false },
    { path: 'Downloads/Trap Drum Kit Vol 2', audioFiles: 30, inBrowser: true },
  ]);
});

run('sounds service');
