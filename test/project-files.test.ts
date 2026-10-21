import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { SCHEMA_VERSION } from '@shared/schema/project';
import { decodeContainer, encodeContainer, ProjectFileError } from '../electron/project/container';
import { validateProject } from '../electron/project/migrations';
import { relinkSamples, resolveFactoryPath, withRelativePaths } from '../electron/project/samples';
import { RecoveryStore } from '../electron/project/recovery';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-test-'));
const noLog = (): void => {};

test('container round-trips project + meta, and plain JSON opens too', () => {
  const p = createDefaultProject('Round');
  const bytes = encodeContainer(p, '9.9.9');
  assert.equal(bytes[0], 0x50);
  const d = decodeContainer(bytes);
  assert.equal(d.meta?.appVersion, '9.9.9');
  assert.equal(d.meta?.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validateProject(d.project, d.meta?.schemaVersion), JSON.parse(JSON.stringify(p)));
  const fromJson = decodeContainer(new TextEncoder().encode('﻿  ' + JSON.stringify(p)));
  assert.equal((fromJson.project as { id: string }).id, p.id);
});

test('validation refuses newer schemas, damage and garbage with readable messages', () => {
  const p = createDefaultProject('V');
  assert.throws(() => validateProject({ ...p, schemaVersion: SCHEMA_VERSION + 1 }), /newer version of Krypt Studio/);
  const broken = JSON.parse(JSON.stringify(p));
  broken.transport.bpm = 5000;
  assert.throws(() => validateProject(broken), /damaged.*transport\.bpm/);
  const dangling = JSON.parse(JSON.stringify(p));
  dangling.channelOrder.push('ch_ghost');
  assert.throws(() => validateProject(dangling), /damaged: channelOrder has unknown ch_ghost/);
  assert.throws(() => decodeContainer(new TextEncoder().encode('hello')), (e: unknown) => e instanceof ProjectFileError);
});

test('sample relPath is stored on save and used to relink a moved project', () => {
  const root = tmp();
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  fs.mkdirSync(path.join(newDir, 'samples'), { recursive: true });
  fs.writeFileSync(path.join(newDir, 'samples', 'loop.wav'), 'x');
  const host = new DocHost(createDefaultProject('S'), CATALOG);
  host.exec('samples.add', { path: path.join(oldDir, 'samples', 'loop.wav') }, { actor: USER });
  const saved = withRelativePaths(host.project, path.join(oldDir, 'song.kstudio'));
  const smp = Object.values(saved.samples).find((s) => s.name === 'loop')!;
  assert.equal(smp.relPath, 'samples/loop.wav');
  assert.ok(Object.values(saved.samples).filter((s) => s.path.startsWith('factory:')).every((s) => s.relPath === undefined));

  const r = relinkSamples(saved, path.join(newDir, 'song.kstudio'), (p) => fs.existsSync(p));
  assert.deepEqual(r.relinked, ['loop']);
  assert.deepEqual(r.missing, []);
  assert.equal(Object.values(r.project.samples).find((s) => s.name === 'loop')!.path, path.join(newDir, 'samples', 'loop.wav'));
  assert.equal(resolveFactoryPath('factory:drums/kick.wav', root), path.join(root, 'drums', 'kick.wav'));
  assert.equal(resolveFactoryPath('factory:../../etc/x', root), path.resolve(root));
});

test('crash journal: snapshot + journal replay restores unsaved edits', async () => {
  const dir = tmp();
  const host = new DocHost(createDefaultProject('Crash'), CATALOG);
  const store = new RecoveryStore(dir, 'test', noLog);
  assert.equal(store.crashedLastTime(), false);
  store.begin();
  host.subscribe((c) => {
    if (c.kind !== 'reset') store.appendChange(c.version, c.patches);
  });
  const savedVersion = host.version;
  await store.snapshot(host.project, { docVersion: host.version, savedVersion, projectPath: null });
  const pat = host.project.transport.activePatternId!;
  const kick = host.project.channelOrder[0];
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60 }] }, { actor: USER });
  await store.snapshot(host.project, { docVersion: host.version, savedVersion, projectPath: null });
  host.exec('transport.set', { bpm: 97 }, { actor: USER });
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 960, key: 62 }] }, { actor: USER });
  await store.flush();
  const next = new RecoveryStore(dir, 'test', noLog);
  assert.equal(next.crashedLastTime(), true);
  const rec = await next.recover();
  assert.ok(rec);
  assert.equal(rec.dirty, true);
  assert.equal(rec.project.transport.bpm, 97);
  assert.equal(Object.keys(rec.project.patterns[pat].notes[kick]).length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(rec.project)), JSON.parse(JSON.stringify(host.project)));

  store.appendSaved(host.version, path.join(dir, 'song.kstudio'));
  await store.flush();
  const rec2 = await new RecoveryStore(dir, 'test', noLog).recover();
  assert.equal(rec2?.dirty, false);
  assert.equal(rec2?.projectPath, path.join(dir, 'song.kstudio'));

  await store.endClean();
  assert.equal(new RecoveryStore(dir, 'test', noLog).crashedLastTime(), false);
  assert.equal(await new RecoveryStore(dir, 'test', noLog).recover(), null);
});

test('crash journal: a torn final line stops replay at the last good edit', async () => {
  const dir = tmp();
  const host = new DocHost(createDefaultProject('Torn'), CATALOG);
  const store = new RecoveryStore(dir, 'test', noLog);
  store.begin();
  host.subscribe((c) => store.appendChange(c.version, c.patches));
  await store.snapshot(host.project, { docVersion: host.version, savedVersion: host.version, projectPath: null });
  host.exec('transport.set', { bpm: 101 }, { actor: USER });
  await store.flush();
  const journal = fs.readdirSync(dir).find((n) => n.startsWith('journal-'))!;
  fs.appendFileSync(path.join(dir, journal), '{"v":99,"p":[{"op":"repl');
  const rec = await new RecoveryStore(dir, 'test', noLog).recover();
  assert.equal(rec?.project.transport.bpm, 101);
  assert.equal(rec?.dirty, true);
  await store.endClean();
});

test('crash journal: a reset during an in-flight snapshot keeps the new project and its edits', async () => {
  const dir = tmp();
  const host = new DocHost(createDefaultProject('A'), CATALOG);
  const store = new RecoveryStore(dir, 'test', noLog);
  store.begin();
  host.subscribe((c) => {
    if (c.kind !== 'reset') store.appendChange(c.version, c.patches);
  });
  host.exec('transport.set', { bpm: 111 }, { actor: USER });
  const first = store.snapshot(host.project, { docVersion: host.version, savedVersion: -1, projectPath: null });
  host.reset(createDefaultProject('B'));
  const second = store.snapshot(host.project, { docVersion: host.version, savedVersion: host.version, projectPath: null });
  host.exec('transport.set', { bpm: 123 }, { actor: USER });
  await Promise.all([first, second]);
  await store.flush();
  const rec = await new RecoveryStore(dir, 'test', noLog).recover();
  assert.equal(rec?.project.meta.name, 'B');
  assert.equal(rec?.project.transport.bpm, 123);
  assert.equal(rec?.dirty, true);
  await store.endClean();
});

await run('project files');
