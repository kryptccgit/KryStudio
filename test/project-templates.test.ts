import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Settings } from '@shared/types';
import { encodeContainer } from '../electron/project/container';
import { isInside, ProjectService } from '../electron/project/service';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-templates-'));
const demos = path.join(root, 'app', 'resources', 'demos');
const docs = path.join(root, 'Documents');
fs.mkdirSync(demos, { recursive: true });
fs.mkdirSync(docs, { recursive: true });

function service(recent: string[] = []) {
  const doc = new DocHost(createDefaultProject('Svc'), CATALOG, { strict: true });
  const svc = new ProjectService({
    doc,
    appVersion: 'test',
    userDataDir: path.join(root, 'ud'),
    factoryDir: path.join(root, 'app', 'resources', 'factory'),
    documentsDir: docs,
    getSettings: () => ({ recent, autosaveSec: 0, browserRoots: [] }) as unknown as Settings,
    addRecent: (p) => void recent.unshift(p),
    log: () => {},
    templateDirs: [demos],
  });
  return { doc, svc, recent };
}

test('isInside: nested files only, case-insensitive on Windows, never the dir itself or a sibling with the same prefix', () => {
  assert.equal(isInside(demos, path.join(demos, 'Neon Fog.kstudio')), true);
  assert.equal(isInside(demos, path.join(demos, 'sub', 'x.kstudio')), true);
  assert.equal(isInside(demos, demos), false);
  assert.equal(isInside(demos, path.join(`${demos}-mine`, 'x.kstudio')), false);
  assert.equal(isInside(demos, path.join(docs, 'x.kstudio')), false);
  if (process.platform === 'win32') assert.equal(isInside(demos.toUpperCase(), path.join(demos, 'a.kstudio')), true);
});

test('a demo opens as a template: no file path (Save asks), not dirty, says so; dialogs default to Documents', async () => {
  const demo = path.join(demos, 'Neon Fog.kstudio');
  fs.writeFileSync(demo, encodeContainer(createDefaultProject('Neon Fog'), 'test'));
  const { svc, recent } = service();
  const r = await svc.open(demo);
  assert.equal(r.ok, true);
  assert.match(r.message!, /a demo: saving makes your own copy in Documents/);
  const s = svc.status();
  assert.equal(s.path, null);
  assert.equal(s.dirty, false);
  assert.equal(s.name, 'Neon Fog');
  assert.deepEqual(recent, [demo], 'still listed in recents so it can be reopened');
  assert.equal(svc.defaultDir(), docs, 'never the app folder, even with the demo as the most recent file');
});

test('a normal project keeps its path and its folder as the dialog default; recents skip template dirs', async () => {
  const mine = path.join(docs, 'beats', 'mine.kstudio');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, encodeContainer(createDefaultProject('Mine'), 'test'));
  const a = service();
  assert.equal((await a.svc.open(mine)).ok, true);
  assert.equal(a.svc.status().path, mine);
  assert.equal(a.svc.defaultDir(), path.dirname(mine));
  const b = service([path.join(demos, 'Neon Fog.kstudio'), mine]);
  assert.equal(b.svc.defaultDir(), path.dirname(mine));
});

void run('project templates').finally(() => fs.rmSync(root, { recursive: true, force: true }));
