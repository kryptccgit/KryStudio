// The reference-library MCP tools against a real DocHost + LibraryService
// + the fake analyzer: plain-language failures without a library, the
// Browser-root restriction of library_import, status / search / read /
// profile / originality output, the focus in get_project and the
// automatic originality warning on commit_edit, plus the focus prompt and
// the krypt://styles resource in the server's discovery answers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { checkImportFolder } from '../electron/mcp/tools/library';
import { captureManifest } from '../electron/mcp/server';
import { SERVER_INSTRUCTIONS } from '../electron/mcp/prompts';
import { AnalyzerSupervisor } from '../electron/analyzer/supervisor';
import { ModelManager } from '../electron/analyzer/models';
import { backendFrom, LibraryService } from '../electron/library/service';
import { earsCatalog, fakeSpawn, stageModels, TEST_MODELS, writeFakeAnalyzer } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-libtools-'));
const script = writeFakeAnalyzer(TMP);
const USER_ROOT = path.join(TMP, 'browser-root');
const SONGS = path.join(USER_ROOT, 'My beats');
const OUTSIDE = path.join(TMP, 'outside');
for (const d of [SONGS, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
for (const n of ['Song.wav', 'Second.wav']) fs.writeFileSync(path.join(SONGS, n), `RIFF${n}`);
fs.writeFileSync(path.join(OUTSIDE, 'Private.wav'), 'RIFF');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CAT = earsCatalog();

function settings0(): Settings {
  return {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [{ id: 'r1', name: 'Browser root', path: USER_ROOT }],
    recent: [],
    autosaveSec: 60,
    // library_import's refusals below are the 'browser' File access mode.
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'browser' },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: false,
    library: { fastScan: false, focus: null },
  };
}

let n = 0;
async function rig(opts: { library?: boolean; stems?: boolean; models?: boolean } = {}) {
  const root = path.join(TMP, `rig${++n}`);
  const userData = path.join(root, 'userData');
  const bundled = path.join(root, 'bundled');
  stageModels(userData, bundled, { stems: opts.stems !== false, basicPitch: true });
  const doc = new DocHost(createDefaultProject('Tools'), CAT, { strict: true });
  let settings = settings0();
  const log = () => {};
  const supervisor = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'not built', log, spawn: fakeSpawn(script), idleShutdownMs: 0 });
  const models = new ModelManager({ catalog: TEST_MODELS, bundledDirs: [bundled], userModelsDir: path.join(userData, 'models'), log });
  await models.refresh();
  const svc = new LibraryService({
    userDataDir: userData,
    doc,
    backend: backendFrom(supervisor, models),
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    log,
    resumeDelayMs: 0,
  });
  await svc.start();
  const deps: MainDeps = {
    doc,
    engine: {
      request: async () => ({ ok: true }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async () => ({ ok: false, message: 'n/a' }),
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo: async () => ({ ok: false, message: 'n/a' }),
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Tools', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => p,
      renderDir: () => path.join(root, 'renders'),
      allowedRoots: () => settings.browserRoots.map((r) => r.path),
    },
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    broadcast: () => {},
    userDataDir: userData,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    library: opts.library === false ? undefined : svc,
    // What library_deep reads to see whether a stem model is installed (MainDeps.analyzer.listModels).
    analyzer: opts.models ? ({ listModels: () => models.states() } as unknown as MainDeps['analyzer']) : undefined,
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'lib-agent', name: 'Lib Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const close = async () => {
    await svc.stop();
    await supervisor.stop();
  };
  return { deps, doc, svc, call, close, settings: () => settings };
}

async function idle(svc: LibraryService): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    const q = svc.state().queue;
    if (!q.running && q.phase === null) return;
    await sleep(25);
  }
  throw new Error('queue never finished');
}

test('registry: seven library tools with the right kinds; library_import / library_deep never touch the project', () => {
  const kinds = Object.fromEntries(['library_status', 'search_references', 'read_reference', 'get_style_profile', 'check_originality', 'library_import', 'library_deep'].map((t) => [t, getTool(t)?.kind]));
  assert.deepEqual(kinds, { library_status: 'read', search_references: 'read', read_reference: 'read', get_style_profile: 'read', check_originality: 'read', library_import: 'transport', library_deep: 'transport' });
  assert.match(SERVER_INSTRUCTIONS, /reference library/);
  assert.match(SERVER_INSTRUCTIONS, /check_originality/);
});

test('without a library every library tool fails in plain words', async () => {
  const r = await rig({ library: false });
  try {
    for (const [name, args] of [['library_status', {}], ['search_references', {}], ['read_reference', { track: 'x' }], ['get_style_profile', {}], ['check_originality', {}], ['library_import', { folder: SONGS, collection: 'x' }], ['library_deep', { collection: 'x' }]] as const) {
      const res = await r.call(name, args);
      assert.equal(res.ok, false, name);
      assert.match(res.message, /reference library is not available/, name);
    }
  } finally {
    await r.close();
  }
});

test('library_import: only folders inside the Browser roots; creates the collection; records only', async () => {
  const r = await rig();
  try {
    assert.throws(() => checkImportFolder('\\\\server\\share\\music', [USER_ROOT]), /UNC/);
    assert.throws(() => checkImportFolder('music\\beats', [USER_ROOT]), /absolute/);
    const out = await r.call('library_import', { folder: OUTSIDE, collection: 'Stolen' });
    assert.equal(out.ok, false);
    assert.match(out.message, /only import folders inside the folders the user added to the Browser/);
    assert.equal(r.svc.collections().length, 0, 'nothing created on refusal');
    const missing = await r.call('library_import', { folder: path.join(USER_ROOT, 'nope'), collection: 'X' });
    assert.match(missing.message, /Folder not found/);
    const before = r.doc.version;
    const ok = await r.call('library_import', { folder: SONGS, collection: 'My beats', tags: ['mine'] });
    assert.equal(ok.ok, true, ok.message);
    assert.match(ok.message, /Created collection "My beats"\. Added 2 tracks/);
    assert.equal(r.doc.version, before, 'the project is untouched');
    const again = await r.call('library_import', { folder: SONGS, collection: 'my beats' });
    assert.equal(again.ok, true, again.message);
    assert.match(again.message, /Nothing new/);
    assert.equal(r.svc.collections().length, 1, 'name lookup is case-insensitive');
    assert.deepEqual(r.svc.collections()[0].tags, ['mine']);
    const root = await r.call('library_import', { folder: USER_ROOT, collection: 'Everything' });
    assert.equal(root.ok, true, 'the Browser root itself is allowed');
  } finally {
    await r.close();
  }
});

test('status, search, read_reference, style profile, originality; focus in get_project and commit_edit', async () => {
  const r = await rig();
  try {
    const imp = await r.call('library_import', { folder: SONGS, collection: 'My beats' });
    assert.equal(imp.ok, true, imp.message);
    const c = r.svc.collections()[0];
    const deep = await r.svc.setDeep(c.id, true); // the user's choice (UI), never an agent's
    assert.equal(deep.ok, true, deep.message);
    await idle(r.svc);

    const st = await r.call('library_status');
    assert.equal(st.ok, true, st.message);
    assert.match(st.text!, /"My beats" \[mine\]|"My beats"/);
    assert.match(st.text!, /2 tracks: 2 analysed \(2 deep\), 0 queued, 0 failed, 0 missing · deep on/);
    assert.match(st.text!, /Focus: none set\./);

    const s1 = await r.call('search_references', { collection: 'My beats', key: 'minor', bpm_min: 100, bpm_max: 130 });
    assert.equal(s1.ok, true, s1.message);
    assert.match(s1.message, /2 tracks match/);
    assert.match(s1.text!, /"Second"\s+120 bpm · F#m · -9\.5 LUFS · 0:08 · deep/);
    const like = await r.call('search_references', { like: 'Song' });
    assert.equal(like.ok, true, like.message);
    assert.match(like.text!, /"Second".*similarity \d+%/);
    const amb = await r.call('read_reference', { track: 'S' });
    assert.equal(amb.ok, false, 'an ambiguous name lists ids');
    assert.match(amb.message, /pass an id/);

    const rd = await r.call('read_reference', { track: 'song' });
    assert.equal(rd.ok, true, rd.message);
    assert.match(rd.text!, /tempo {5}120 bpm, confidence 0\.9; also plausible 60 \/ 240 \(estimated\)/);
    assert.match(rd.text!, /key {7}F#m, confidence 0\.7 \(estimated\) · swing 12%/);
    assert.match(rd.text!, /drums {5}from the drum stem/);
    assert.match(rd.text!, /chords {4}1:i 2:VI 3:III 4:VII/);
    assert.match(rd.text!, /lines {5}.*vocals 12 notes/);
    assert.match(rd.text!, /never copy a reference/);
    assert.ok(!/\b62\b.*\b65\b.*\b69\b/.test(rd.text!), 'no note-by-note dump of a reference');

    const nf = await r.call('get_style_profile');
    assert.equal(nf.ok, false);
    assert.match(nf.message, /No style focus is set/);
    const prof = await r.call('get_style_profile', { collection: 'my beats' });
    assert.equal(prof.ok, true, prof.message);
    assert.match(prof.text!, /STYLE PROFILE "My beats"/);

    // The user sets a focus (UI): agents see it everywhere.
    await r.svc.setFocus({ collectionId: c.id, brief: 'dark and sparse' });
    const pf = await r.call('get_style_profile');
    assert.equal(pf.ok, true, pf.message);
    assert.match(pf.message, /\(the active focus\)/);
    assert.match(pf.text!, /dark and sparse/);
    const gp = await r.call('get_project');
    assert.match(gp.text!, /Style focus: "My beats" \(brief: "dark and sparse"\)\. .*get_style_profile/);
    assert.deepEqual((gp.data as { focus: unknown }).focus, { collectionId: c.id, name: 'My beats', brief: 'dark and sparse' });
    const st2 = await r.call('library_status');
    assert.match(st2.text!, /Focus: "My beats" — brief: "dark and sparse"/);

    // An agent writes the reference vocal melody (transposed) inside an edit group → commit_edit warns.
    const melody: Array<[number, number, number]> = [[0, 1, 62], [1, 0.5, 65], [1.5, 0.5, 69], [2, 1, 67], [3, 1.5, 64], [4.5, 0.5, 72], [5, 1, 70], [6, 0.5, 65], [6.5, 0.5, 67], [7, 1, 62], [8, 1, 69], [9, 2, 60]];
    assert.equal((await r.call('begin_edit', { label: 'Hook' })).ok, true);
    const add = await r.call('add_notes', { channel: 'Keys', notes: melody.map(([b, d, k]) => ({ key: k + 5, tick: b * 960, dur: d * 960 })) });
    assert.equal(add.ok, true, add.message);
    const commit = await r.call('commit_edit');
    assert.equal(commit.ok, true, commit.message);
    assert.ok(commit.warnings?.length, 'originality warning attached');
    assert.match(commit.warnings![0], /Originality \(focus "My beats"\)/);
    assert.match(commit.warnings!.join('\n'), /consecutive notes match "(Song|Second)" \(vocals\)/);
    assert.ok(r.doc.getHistory().some((h) => h.label === 'Hook' && !h.undone), 'the edit is kept (never blocked)');

    const co = await r.call('check_originality');
    assert.equal(co.ok, true, co.message);
    assert.match(co.message, /checked against 2 deep-analysed references: \d+ match/);
    assert.match(co.text!, /legal advice/i);

    // A group that writes nothing melodic: no check, no warning.
    await r.call('begin_edit', { label: 'Tempo' });
    await r.call('set_tempo', { bpm: 141 });
    const c2 = await r.call('commit_edit');
    assert.equal(c2.warnings, undefined);
  } finally {
    await r.close();
  }
});

test('library_deep: refused without an installed stem model (never a download); with one, the estimate first, then queued', async () => {
  // No stem model, the Model Manager visible to the tool: refused before anything starts.
  const a = await rig({ stems: false, models: true });
  try {
    const imp = await a.call('library_import', { folder: SONGS, collection: 'Deep test' });
    assert.equal(imp.ok, true, imp.message);
    const r = await a.call('library_deep', { collection: 'Deep test' });
    assert.equal(r.ok, false);
    assert.match(r.message, /Deep analysis needs a stem model, and none is installed \(HT-Demucs \(4 stems\): available\)\. Agents can't download models/);
    assert.equal(a.svc.findCollection('Deep test')?.deep, false, 'nothing switched on');
    assert.equal(a.doc.getHistory().length, 0);
  } finally {
    await a.close();
  }
  // No stem model and no model list for the tool: the library itself refuses, the agent gets the same advice.
  const b = await rig({ stems: false });
  try {
    await b.call('library_import', { folder: SONGS, collection: 'Deep test' });
    const r = await b.call('library_deep', { collection: 'Deep test' });
    assert.equal(r.ok, false);
    assert.match(r.message, /Deep analysis needs a stem model: install HT-Demucs \(4 stems\) in Model Manager first\. Agents can't download models/);
    assert.equal(b.svc.findCollection('Deep test')?.deep, false);
  } finally {
    await b.close();
  }
  // With the stem model installed: estimate_only reports, then deep turns on with the estimate in the message.
  const c = await rig({ models: true });
  try {
    await c.call('library_import', { folder: SONGS, collection: 'Deep test' });
    const est = await c.call('library_deep', { collection: 'Deep test', estimate_only: true });
    assert.equal(est.ok, true, est.message);
    assert.match(est.message, /Deep analysis of 2 tracks in "Deep test" would take about .* on the CPU/);
    assert.equal(c.svc.findCollection('Deep test')?.deep, false, 'estimate only');
    const on = await c.call('library_deep', { collection: 'Deep test' });
    assert.equal(on.ok, true, on.message);
    assert.match(on.message, /Deep analysis on for "Deep test": 2 tracks queued, about .* on the CPU/);
    assert.equal(c.svc.findCollection('Deep test')?.deep, true);
    assert.equal((on.data as { queued: number }).queued, 2);
    const off = await c.call('library_deep', { collection: 'Deep test', deep: false });
    assert.equal(off.ok, true, off.message);
    assert.equal(c.svc.findCollection('Deep test')?.deep, false);
    assert.equal(c.doc.getHistory().length, 0, 'the project is never touched');
  } finally {
    await c.close();
  }
});

test('server: focus prompt and krypt://styles resource template are discoverable', async () => {
  const r = await rig();
  try {
    const m = (await captureManifest(r.deps, '0.1.0')) as { legacy: Record<string, { prompts?: Array<{ name: string; arguments?: Array<{ name: string }> }>; resourceTemplates?: Array<{ uriTemplate: string }> }> };
    const prompts = m.legacy['prompts/list'].prompts ?? [];
    const focus = prompts.find((p) => p.name === 'focus');
    assert.ok(focus, prompts.map((p) => p.name).join(', '));
    assert.deepEqual(focus!.arguments?.map((a) => a.name).sort(), ['collection', 'idea']);
    const templates = m.legacy['resources/templates/list'].resourceTemplates ?? [];
    assert.ok(templates.some((t) => t.uriTemplate === 'krypt://styles/{collectionId}'), JSON.stringify(templates));
  } finally {
    await r.close();
  }
});

void run('library tools');
