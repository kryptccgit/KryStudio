// Project tabs (electron/project/tabs.ts) with the real DocHost + ProjectService in temp dirs and fakes for the
// engine (transport stop), the windows (broadcast) and the switch guards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER, type Actor, type DocChange } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Settings, TabsState } from '@shared/types';
import type { Project } from '@shared/schema/project';
import { ProjectService } from '../electron/project/service';
import { TabManager, type TabGuardHit } from '../electron/project/tabs';
import { decodeContainer, encodeContainer } from '../electron/project/container';
import { projectOverview } from '../electron/mcp/tools/overview';
import type { MainDeps } from '../electron/mcp/types';

const AGENT: Actor = { kind: 'agent', clientId: 'claude-1', name: 'Claude' };
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-tabs-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(root = tmp()) {
  const doc = new DocHost(createDefaultProject('Untitled'), CATALOG, { strict: true });
  const recent: string[] = [];
  const logs: string[] = [];
  const project = new ProjectService({
    doc,
    appVersion: 'test',
    userDataDir: path.join(root, 'ud'),
    factoryDir: path.join(root, 'factory'),
    documentsDir: path.join(root, 'docs'),
    getSettings: () => ({ recent, autosaveSec: 0, browserRoots: [] }) as unknown as Settings,
    addRecent: (p) => void recent.unshift(p),
    log: (_l, m) => void logs.push(m),
  });
  const states: TabsState[] = [];
  const guard: { hit: TabGuardHit | null } = { hit: null };
  let stops = 0;
  const tabs = new TabManager({
    doc,
    project,
    sessionDir: path.join(root, 'ud', 'session'),
    appVersion: 'test',
    stopTransport: () => void stops++,
    broadcast: (s) => void states.push(s),
    log: (_l, m) => void logs.push(m),
    guards: [() => guard.hit],
    busyPollMs: 0,
  });
  const resets: DocChange[] = [];
  doc.subscribe((c) => {
    if (c.kind === 'reset') resets.push(c);
  });
  const boot = () => project.boot((crashed) => tabs.restore(crashed));
  return { root, doc, project, tabs, states, guard, resets, logs, recent, boot, stops: () => stops };
}

/** A .kstudio on disk named `name`, with `bpm`. */
function projectFile(dir: string, name: string, bpm = 120): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = createDefaultProject(name);
  p.transport.bpm = bpm;
  const file = path.join(dir, `${name}.kstudio`);
  fs.writeFileSync(file, encodeContainer(p, 'test'));
  return file;
}

function addNote(doc: DocHost, key = 60, actor: Actor = USER): void {
  const p = doc.project;
  const r = doc.exec('notes.add', { patternId: p.transport.activePatternId!, channelId: p.channelOrder[0], notes: [{ tick: 0, key }] }, { actor });
  assert.equal(r.ok, true, r.message);
}

function noteKeys(p: Project): number[] {
  const pat = p.patterns[p.transport.activePatternId!];
  return Object.values(pat.notes[p.channelOrder[0]] ?? {}).map((n) => n.key).sort();
}

const titles = (t: TabManager) => t.state().tabs.map((x) => x.title);

test('new tab + switch: each tab keeps its project and undo history; a switch resets the engine and stops the transport', async () => {
  const r = rig();
  await r.boot();
  const first = r.tabs.state().activeId;
  addNote(r.doc, 60);
  const n = await r.tabs.newTab();
  assert.equal(n.ok, true, n.message);
  assert.deepEqual(titles(r.tabs), ['Untitled', 'Untitled 2']);
  assert.equal(r.tabs.state().activeId, n.data!.id);
  assert.deepEqual(noteKeys(r.doc.project), []);
  assert.equal(r.doc.exec('transport.set', { bpm: 99 }, { actor: USER }).ok, true);

  const resetsBefore = r.resets.length;
  const stopsBefore = r.stops();
  const v = r.doc.version;
  const s = await r.tabs.switchTo(first);
  assert.equal(s.ok, true, s.message);
  assert.equal(r.resets.length, resetsBefore + 1, 'the engine bridge reloads on the reset');
  assert.equal(r.resets[r.resets.length - 1].project, r.doc.project);
  assert.ok(r.doc.version > v, 'versions keep counting up');
  assert.equal(r.stops(), stopsBefore + 1);
  assert.deepEqual(noteKeys(r.doc.project), [60]);
  assert.equal(r.doc.project.transport.bpm, 140);
  assert.equal(r.project.status().dirty, true, 'still unsaved after coming back');
  assert.equal(r.doc.undo(USER).ok, true, "undo works on the tab's own history");
  assert.deepEqual(noteKeys(r.doc.project), []);

  await r.tabs.switchTo(n.data!.id);
  assert.equal(r.doc.project.transport.bpm, 99);
  assert.equal(r.doc.undo(USER).ok, true);
  assert.equal(r.doc.project.transport.bpm, 140);
  assert.equal(r.states[r.states.length - 1].activeId, n.data!.id, 'every change is broadcast');
  await r.tabs.shutdown();
});

test('open: replaces the untouched new tab, else opens a new tab; an already-open file activates its tab', async () => {
  const r = rig();
  await r.boot();
  const a = projectFile(path.join(r.root, 'docs'), 'Alpha', 101);
  const b = projectFile(path.join(r.root, 'docs'), 'Beta', 102);
  const oa = await r.tabs.open(a);
  assert.equal(oa.ok, true, oa.message);
  assert.deepEqual(titles(r.tabs), ['Alpha'], 'the untouched Untitled tab was replaced');
  assert.equal(r.doc.project.transport.bpm, 101);
  const ob = await r.tabs.open(b);
  assert.deepEqual(titles(r.tabs), ['Alpha', 'Beta']);
  assert.equal(r.doc.project.transport.bpm, 102);
  const again = await r.tabs.open(a);
  assert.equal(again.ok, true);
  assert.match(again.message!, /already open/);
  assert.equal(again.data!.id, oa.data!.id);
  assert.equal(r.tabs.state().activeId, oa.data!.id);
  assert.equal(r.doc.project.transport.bpm, 101);
  // The old project.open API follows the same rules (Home, Recent, File ▸ Open, file association).
  const viaOld = await r.project.open(b);
  assert.equal(viaOld.ok, true);
  assert.equal(r.tabs.state().activeId, ob.data!.id);
  assert.equal(r.tabs.state().tabs.length, 2);
  // A touched new tab is never replaced.
  await r.tabs.newTab();
  addNote(r.doc);
  const c = projectFile(path.join(r.root, 'docs'), 'Gamma');
  await r.tabs.open(c);
  assert.deepEqual(titles(r.tabs), ['Alpha', 'Beta', 'Untitled', 'Gamma']);
  const missing = await r.tabs.open(path.join(r.root, 'nope.kstudio'));
  assert.equal(missing.ok, false);
  assert.match(missing.message!, /not found/);
  assert.equal(r.tabs.state().tabs.length, 4);
  await r.tabs.shutdown();
});

test('close: unsaved needs a decision; save writes the file; discard + reopen brings the unsaved state back; the last tab leaves a fresh Untitled', async () => {
  const r = rig();
  await r.boot();
  const a = projectFile(path.join(r.root, 'docs'), 'Alpha');
  await r.tabs.open(a);
  addNote(r.doc, 64);
  const aId = r.tabs.state().activeId;
  const ask = await r.tabs.close(aId);
  assert.equal(ask.ok, false);
  assert.equal(ask.data?.needsDecision, true);
  assert.match(ask.message!, /"Alpha" has unsaved changes/);

  // Close an INACTIVE dirty tab with 'save': it is activated, saved, then closed.
  const nb = await r.tabs.newTab();
  const saved = await r.tabs.close(aId, 'save');
  assert.equal(saved.ok, true, saved.message);
  const onDisk = decodeContainer(fs.readFileSync(a)).project as Project;
  assert.deepEqual(noteKeys(onDisk), [64]);
  assert.deepEqual(titles(r.tabs), ['Untitled']);
  assert.equal(r.tabs.state().activeId, nb.data!.id);

  // Discard an unsaved untitled tab, then reopen it: its edits and dirty flag are back.
  addNote(r.doc, 67);
  const other = await r.tabs.newTab();
  await r.tabs.switchTo(nb.data!.id);
  const d = await r.tabs.close(nb.data!.id, 'discard');
  assert.equal(d.ok, true, d.message);
  assert.equal(r.tabs.state().activeId, other.data!.id);
  assert.equal(r.tabs.state().closed[0].id, nb.data!.id);
  const re = await r.tabs.reopenClosed();
  assert.equal(re.ok, true, re.message);
  assert.equal(r.tabs.state().activeId, nb.data!.id);
  assert.deepEqual(noteKeys(r.doc.project), [67]);
  assert.equal(r.project.status().dirty, true);
  assert.equal((await r.tabs.reopenClosed()).ok, true, 'Alpha (closed after saving) reopens too');
  assert.match((await r.tabs.reopenClosed()).message!, /No closed tab/);

  // Close everything: never zero tabs.
  for (const t of r.tabs.state().tabs) await r.tabs.close(t.id, 'discard');
  const left = r.tabs.state();
  assert.equal(left.tabs.length, 1);
  assert.equal(left.tabs[0].title, 'Untitled');
  assert.equal(left.tabs[0].dirty, false);
  assert.deepEqual(noteKeys(r.doc.project), []);
  await r.tabs.shutdown();
});

test('move reorders the strip', async () => {
  const r = rig();
  await r.boot();
  await r.tabs.newTab();
  await r.tabs.newTab();
  const [a, b, c] = r.tabs.state().tabs.map((t) => t.id);
  assert.equal(r.tabs.move(c, 0).ok, true);
  assert.deepEqual(r.tabs.state().tabs.map((t) => t.id), [c, a, b]);
  assert.equal(r.tabs.move(a, 99).ok, true);
  assert.deepEqual(r.tabs.state().tabs.map((t) => t.id), [c, b, a]);
  assert.equal(r.tabs.move('nope', 0).ok, false);
  await r.tabs.shutdown();
});

test('guards: an agent group or a busy job refuses switching (busy shown), but main-side new projects still open a tab', async () => {
  const r = rig();
  await r.boot();
  const first = r.tabs.state().activeId;
  await r.tabs.newTab();
  const g = r.doc.beginGroup(AGENT, 'Write beat');
  const sw = await r.tabs.switchTo(first);
  assert.equal(sw.ok, false);
  assert.match(sw.message!, /An agent \(Claude\) is editing "Untitled 2": wait for it or stop it in the Agents panel/);
  assert.equal(r.tabs.state().tabs[1].busy, 'Claude is editing');
  assert.equal((await r.tabs.newTab()).ok, false);
  r.doc.endGroup(g);

  r.guard.hit = { busy: 'Building the mashup…', message: 'Auto Mashup is building in "Untitled 2": wait for it.' };
  assert.equal(r.tabs.state().tabs[1].busy, 'Building the mashup…');
  const refused = await r.tabs.switchTo(first);
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /Auto Mashup is building/);
  assert.equal((await r.tabs.open(projectFile(path.join(r.root, 'docs'), 'X'))).ok, false);
  const closing = await r.tabs.close(r.tabs.state().activeId, 'discard');
  assert.equal(closing.ok, false, "the busy tab can't close");

  // Audio → Project / Auto Mashup / agents: ProjectService.newProject() opens a NEW tab (their own job is busy).
  addNote(r.doc, 70);
  const np = r.project.newProject();
  assert.equal(np.ok, true, np.message);
  assert.equal(r.tabs.state().tabs.length, 3);
  assert.equal(r.project.opensNewTabs(), true);
  const built = createDefaultProject('Mash');
  const m = r.tabs.openProjectInNewTab(built, 'My Mashup');
  assert.equal(m.ok, true, m.message);
  assert.equal(r.tabs.state().tabs.find((t) => t.id === m.data!.id)?.title, 'My Mashup');
  assert.equal(r.tabs.state().tabs.find((t) => t.id === m.data!.id)?.dirty, true);
  r.guard.hit = null;
  await r.tabs.switchTo(r.tabs.state().tabs[1].id);
  assert.deepEqual(noteKeys(r.doc.project), [70], 'the tab that was busy kept its work');
  await r.tabs.shutdown();
});

test('templates open in a new tab; get_project lists the open tabs with the active one marked', async () => {
  const r = rig();
  await r.boot();
  r.doc.exec('transport.set', { bpm: 133 }, { actor: USER });
  assert.equal((await r.project.saveAsTemplate('Trap starter')).ok, true);
  const t = await r.tabs.newTab({ template: 'Trap starter' });
  assert.equal(t.ok, true, t.message);
  assert.equal(t.data!.template?.name, 'Trap starter');
  assert.equal(r.doc.project.transport.bpm, 133);
  assert.equal(r.tabs.state().tabs.length, 2);
  const text = projectOverview({ doc: r.doc, project: r.project, tabs: r.tabs, engine: { status: () => ({ state: 'running', device: null }) } } as unknown as MainDeps).text;
  assert.match(text, /Open tabs \(2\): "Untitled" \(unsaved\), "Untitled 2" ← active/);
  await r.tabs.shutdown();
});

test('session: quit and relaunch restores every tab (active first, others lazily), unsaved state included', async () => {
  const root = tmp();
  const a = projectFile(path.join(root, 'docs'), 'Alpha', 101);
  const b = projectFile(path.join(root, 'docs'), 'Beta', 102);
  {
    const r = rig(root);
    await r.boot();
    await r.tabs.open(a);
    addNote(r.doc, 61); // Alpha: dirty
    await r.tabs.newTab();
    addNote(r.doc, 62); // Untitled (the only untitled tab): never saved
    await r.tabs.open(b); // Beta: clean
    await r.tabs.switchTo(r.tabs.state().tabs[1].id); // quit on Untitled
    addNote(r.doc, 63);
    const res = await r.tabs.shutdown();
    assert.equal(res.ok, true, res.message);
    const files = fs.readdirSync(path.join(root, 'ud', 'session')).sort();
    assert.equal(files.filter((f) => /^tab-.*\.kstudio$/.test(f)).length, 2, `only the unsaved tabs keep a snapshot: ${files.join(', ')}`);
    assert.ok(files.includes('tabs.json'));
    assert.equal(fs.existsSync(path.join(root, 'ud', 'autosave', 'session.lock')), false, 'a clean exit');
  }
  const r = rig(root);
  await r.boot();
  const s = r.tabs.state();
  assert.deepEqual(s.tabs.map((t) => [t.title, t.dirty]), [
    ['Alpha', true],
    ['Untitled', true],
    ['Beta', false],
  ]);
  assert.equal(s.activeId, s.tabs[1].id);
  assert.deepEqual(noteKeys(r.doc.project), [62, 63]);
  assert.equal(r.project.status().dirty, true);
  const resets = r.resets.length;
  await r.tabs.switchTo(s.tabs[0].id); // lazily loaded from its snapshot
  assert.equal(r.resets.length, resets + 1);
  assert.equal(r.doc.project.transport.bpm, 101);
  assert.deepEqual(noteKeys(r.doc.project), [61]);
  assert.equal(r.project.status().dirty, true);
  assert.equal(r.project.status().path, a, 'the restored tab still saves to its file');
  await r.tabs.switchTo(s.tabs[2].id); // lazily loaded from its file
  assert.equal(r.doc.project.transport.bpm, 102);
  assert.equal(r.project.status().dirty, false);
  // Untitled came back from memory (its state was kept when switching away), still dirty.
  await r.tabs.switchTo(s.tabs[1].id);
  assert.deepEqual(noteKeys(r.doc.project), [62, 63]);
  await r.tabs.shutdown();
});

test('session: a missing file becomes a tab that says so instead of failing the launch', async () => {
  const root = tmp();
  const a = projectFile(path.join(root, 'docs'), 'Alpha');
  const b = projectFile(path.join(root, 'docs'), 'Beta');
  {
    const r = rig(root);
    await r.boot();
    await r.tabs.open(a);
    await r.tabs.open(b);
    await r.tabs.shutdown();
  }
  fs.rmSync(b); // Beta was the active tab
  const r = rig(root);
  await r.boot();
  const s = r.tabs.state();
  assert.deepEqual(s.tabs.map((t) => t.title), ['Alpha', 'Beta (missing)']);
  assert.equal(s.activeId, s.tabs[0].id, 'the launch fell back to a tab that loads');
  const sw = await r.tabs.switchTo(s.tabs[1].id);
  assert.equal(sw.ok, false);
  assert.match(sw.message!, /isn't at .* any more\. Put the file back, or close this tab/);
  assert.equal((await r.tabs.close(s.tabs[1].id)).ok, true);
  await r.tabs.shutdown();
});

test('crash: recovery gives the active tab its journaled edits, inactive tabs come back from their session files', async () => {
  const root = tmp();
  {
    const r = rig(root);
    await r.boot();
    addNote(r.doc, 71); // Untitled: edits, then switched away from
    await r.tabs.newTab();
    addNote(r.doc, 72); // Untitled 2: active at the crash, edits only in the recovery journal
    addNote(r.doc, 73);
    await r.tabs.saveSession(); // what tab changes already wrote (the active tab's content isn't in it)
    await sleep(500); // the recovery snapshot waits for the outgoing tab's session file
    await r.project.shutdown(false); // a crash: the journal is flushed, the lock stays
  }
  const r = rig(root);
  await r.boot();
  const s = r.tabs.state();
  assert.deepEqual(s.tabs.map((t) => [t.title, t.dirty]), [
    ['Untitled', true],
    ['Untitled 2', true],
  ]);
  assert.equal(s.activeId, s.tabs[1].id, 'the recovered tab is active');
  assert.deepEqual(noteKeys(r.doc.project), [72, 73]);
  assert.equal(r.project.status().recovered, true);
  await r.tabs.switchTo(s.tabs[0].id);
  assert.deepEqual(noteKeys(r.doc.project), [71]);
  assert.equal(r.project.status().dirty, true);
  await r.tabs.shutdown();
});

test('crash before tabs existed (no tabs.json): recovery still restores the project as one tab', async () => {
  const root = tmp();
  {
    const doc = new DocHost(createDefaultProject('Old'), CATALOG);
    const svc = new ProjectService({
      doc,
      appVersion: 'test',
      userDataDir: path.join(root, 'ud'),
      factoryDir: path.join(root, 'factory'),
      documentsDir: path.join(root, 'docs'),
      getSettings: () => ({ recent: [], autosaveSec: 0, browserRoots: [] }) as unknown as Settings,
      addRecent: () => {},
      log: () => {},
    });
    await svc.boot();
    addNote(doc, 80);
    await sleep(50);
    await svc.shutdown(false);
  }
  const r = rig(root);
  await r.boot();
  assert.equal(r.tabs.state().tabs.length, 1);
  assert.deepEqual(noteKeys(r.doc.project), [80]);
  assert.equal(r.project.status().dirty, true);
  await r.tabs.shutdown();
});

void run('Project tabs');
