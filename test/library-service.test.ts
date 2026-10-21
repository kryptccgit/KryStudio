import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { Settings } from '@shared/types';
import type { LibraryState } from '@shared/library/types';
import type { ModelDef } from '@shared/analyzer/models';
import { FEATURE_NAMES } from '@shared/library/similarity';
import { PPQ } from '@shared/schema/time';
import { AnalyzerSupervisor } from '../electron/analyzer/supervisor';
import { ModelManager } from '../electron/analyzer/models';
import { backendFrom, LibraryService, isLibraryAudio } from '../electron/library/service';
import { LibraryDb } from '../electron/library/db';
import { countRuns, earsCatalog, fakeSpawn, stageModels, TEST_MODELS, writeFakeAnalyzer } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-lib-'));
const script = writeFakeAnalyzer(TMP);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CAT = earsCatalog();

const BEAT_WEIGHTS = Buffer.from('beat this weights');
const BEAT_DEF: ModelDef = {
  id: 'beat-this-small',
  name: 'Beat This! (small)',
  task: 'beats',
  description: 'd',
  license: { name: 'MIT', url: 'https://example.com' },
  bundled: true,
  default: true,
  files: [{ name: 'beat.onnx', url: '', sha256: crypto.createHash('sha256').update(BEAT_WEIGHTS).digest('hex'), bytes: BEAT_WEIGHTS.length }],
};
const MODELS = [...TEST_MODELS, BEAT_DEF];

function baseSettings(): Settings {
  return {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [],
    recent: [],
    autosaveSec: 60,
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: false,
    library: { fastScan: false, focus: null },
  };
}

function song(dir: string, name: string, body = 'RIFF'): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `${body}:${name}`);
  return f;
}

let rigN = 0;
interface RigOpts {
  root?: string;
  stems?: boolean;
  basicPitch?: boolean;
  beat?: boolean;
  settings?: Settings;
  noBackend?: boolean;
}
async function rig(o: RigOpts = {}) {
  const root = o.root ?? path.join(TMP, `rig${++rigN}`);
  const userData = path.join(root, 'userData');
  const bundled = path.join(root, 'bundled');
  stageModels(userData, bundled, { stems: o.stems, basicPitch: o.basicPitch });
  if (o.beat) {
    fs.mkdirSync(path.join(bundled, 'beat-this-small'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'beat-this-small', 'beat.onnx'), BEAT_WEIGHTS);
  }
  const logFile = path.join(root, `calls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`);
  const logs: string[] = [];
  const log = (level: string, m: string) => logs.push(`${level} ${m}`);
  const supervisor = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'not built', log, spawn: fakeSpawn(script, logFile), idleShutdownMs: 0 });
  const models = new ModelManager({ catalog: MODELS, bundledDirs: [bundled], userModelsDir: path.join(userData, 'models'), log });
  await models.refresh();
  const doc = new DocHost(createDefaultProject('Lib'), CAT, { strict: true });
  let settings = o.settings ?? baseSettings();
  const states: LibraryState[] = [];
  const svc = new LibraryService({
    userDataDir: userData,
    doc,
    backend: o.noBackend ? null : backendFrom(supervisor, models),
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    sampleInfo: async (p) => ({ ok: true, data: { path: p, frames: 352800, sampleRate: 44100, channels: 2, durationSec: 8 } }),
    broadcast: (s) => states.push(s),
    log,
    resumeDelayMs: 0,
    retryDelayMs: 20,
  });
  await svc.start();
  const music = path.join(root, 'music');
  return { root, userData, svc, doc, states, logs, logFile, supervisor, music, settings: () => settings };
}

async function close(r: { svc: LibraryService; supervisor: AnalyzerSupervisor }): Promise<void> {
  await r.svc.stop();
  await r.supervisor.stop();
}

async function waitFor(what: string, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function idle(svc: LibraryService, ms = 20_000): Promise<void> {
  await waitFor('the queue to finish', () => {
    const q = svc.state().queue;
    return !q.running && q.phase === null;
  }, ms);
}

async function collection(svc: LibraryService, name = 'Dark trap') {
  const c = await svc.createCollection(name, ['trap']);
  assert.equal(c.ok, true, c.message);
  return c.data!;
}

async function statuses(svc: LibraryService, collectionId: string): Promise<Record<string, string>> {
  const q = await svc.query({ collectionId, limit: 1000 });
  assert.equal(q.ok, true, q.message);
  return Object.fromEntries(q.data!.tracks.map((t) => [t.name, t.status]));
}

test('import: recursive folder scan, audio only, light pass stores features + summary', async () => {
  const r = await rig({ beat: true });
  try {
    song(r.music, 'Night Drive.wav');
    song(path.join(r.music, 'sub', 'deeper'), 'Smoke.FLAC');
    song(r.music, 'Phone Memo.m4a');
    song(r.music, 'cover.jpg');
    song(r.music, 'notes.txt');
    song(path.join(r.music, '.hidden'), 'Secret.wav');
    assert.equal(isLibraryAudio('x.WMA'), true);
    assert.equal(isLibraryAudio('x.mid'), false);
    const c = await collection(r.svc);
    const add = await r.svc.addFolder(c.id, r.music);
    assert.equal(add.ok, true, add.message);
    assert.deepEqual(add.data, { added: 3, skipped: 0 });
    assert.match(add.message!, /Added 3 tracks to "Dark trap"/);
    const again = await r.svc.addFolder(c.id, r.music);
    assert.deepEqual(again.data, { added: 0, skipped: 3 }, 'the same folder twice adds nothing');
    await idle(r.svc);
    assert.deepEqual(await statuses(r.svc, c.id), { 'Night Drive': 'light', Smoke: 'light', 'Phone Memo': 'light' });
    assert.equal(countRuns(r.logFile, 'analyze'), 3, 'each file analysed exactly once');

    const q = await r.svc.query({ collectionId: c.id, text: 'night' });
    const t = q.data!.tracks[0];
    assert.equal(t.bpm, 120);
    assert.equal(t.key, 'F#m');
    assert.equal(t.lufs, -9.5);
    assert.equal(t.durationSec, 8);
    const d = await r.svc.track(t.id);
    assert.equal(d.ok, true, d.message);
    const f = d.data!.features!;
    assert.ok(f.analysis.sources.includes('beat-this small'), 'the bundled beat model is used by default');
    assert.equal((f.analysis as { drumHits?: unknown }).drumHits, undefined, 'raw drum hits are summarised, never stored');
    assert.ok(f.drums && f.drums.source === 'mix' && f.drums.bars >= 1, 'drum grid from the mix');
    assert.ok((f.drums!.counts.kick ?? []).some((x) => x > 0));
    assert.ok(f.chords.length >= 1, 'chords converted to beats');
    assert.equal(f.vector.length, FEATURE_NAMES.length);
    const st = r.svc.state();
    assert.equal(st.collections[0].folders[0], path.resolve(r.music));
    assert.deepEqual(st.collections[0].counts, { total: 3, pending: 0, light: 3, deep: 0, failed: 0, missing: 0 });
    assert.ok(r.states.some((s) => s.queue.running && s.queue.phase === 'light' && s.queue.total === 3), 'progress was broadcast');
    assert.equal(st.dbPath, path.join(r.userData, 'library', 'library.sqlite'));
    assert.ok(fs.existsSync(st.dbPath));
  } finally {
    await close(r);
  }
});

test('import: fast scan skips the beat model; files outside folders via addFiles', async () => {
  const s = baseSettings();
  s.library = { fastScan: true, focus: null };
  const r = await rig({ beat: true, settings: s });
  try {
    const a = song(path.join(r.root, 'loose'), 'Loose One.mp3');
    const c = await collection(r.svc);
    const add = await r.svc.addFiles(c.id, [a, path.join(r.root, 'nope.wav'), path.join(r.root, 'readme.txt')]);
    assert.equal(add.ok, true, add.message);
    assert.deepEqual(add.data, { added: 1, skipped: 2 });
    assert.match(add.message!, /1 not audio, 1 not found/);
    await idle(r.svc);
    const t = (await r.svc.query({ collectionId: c.id })).data!.tracks[0];
    const f = (await r.svc.track(t.id)).data!.features!;
    assert.deepEqual(f.analysis.sources, ['fake-dsp'], 'fast scan: DSP beats only');
  } finally {
    await close(r);
  }
});

test('twins: a folder already analysed for one collection is reused by another (no second analysis)', async () => {
  const r = await rig();
  try {
    for (const n of ['Shared 1.wav', 'Shared 2.wav']) song(r.music, n);
    const a = await collection(r.svc, 'All');
    await r.svc.addFolder(a.id, r.music);
    await idle(r.svc);
    assert.equal(countRuns(r.logFile, 'analyze'), 2);
    const b = await collection(r.svc, 'Favourites');
    await r.svc.addFolder(b.id, r.music);
    await idle(r.svc);
    assert.deepEqual(await statuses(r.svc, b.id), { 'Shared 1': 'light', 'Shared 2': 'light' });
    assert.equal(countRuns(r.logFile, 'analyze'), 2, 'reused, not analysed again');
    const t = (await r.svc.query({ collectionId: b.id, text: 'shared 1' })).data!.tracks[0];
    assert.equal(t.bpm, 120);
    assert.ok((await r.svc.track(t.id)).data!.features, 'features copied');
  } finally {
    await close(r);
  }
});

test('failures: recorded with the analyzer message, the queue keeps going, retryFailed re-queues', async () => {
  const r = await rig();
  try {
    for (const n of ['One.wav', 'bad take.wav', 'Two.wav', 'Three.wav']) song(r.music, n);
    const c = await collection(r.svc);
    await r.svc.addFolder(c.id, r.music);
    await idle(r.svc);
    const st = await statuses(r.svc, c.id);
    assert.deepEqual(st, { One: 'light', 'bad take': 'failed', Two: 'light', Three: 'light' });
    const bad = (await r.svc.query({ collectionId: c.id, status: 'failed' })).data!.tracks[0];
    assert.match(bad.error!, /Unsupported or corrupt audio file/);
    assert.equal(r.svc.state().collections[0].counts.failed, 1);
    const retry = await r.svc.retryFailed(c.id);
    assert.equal(retry.data!.queued, 1);
    await idle(r.svc);
    assert.equal((await statuses(r.svc, c.id))['bad take'], 'failed', 'still corrupt after a retry');
    assert.equal(countRuns(r.logFile, 'analyze'), 5);
  } finally {
    await close(r);
  }
});

test('analyzer crashes: only the file that crashes it is blamed (after 3 tries); the rest are analysed', async () => {
  const r = await rig();
  try {
    for (const n of ['A crash.wav', 'B ok.wav', 'C ok.wav']) song(r.music, n);
    const c = await collection(r.svc);
    await r.svc.addFolder(c.id, r.music);
    await idle(r.svc, 30_000);
    assert.deepEqual(await statuses(r.svc, c.id), { 'A crash': 'failed', 'B ok': 'light', 'C ok': 'light' });
    const bad = (await r.svc.query({ collectionId: c.id, status: 'failed' })).data!.tracks[0];
    assert.match(bad.error!, /stopped unexpectedly.*failed 3 times on this file/);
    assert.ok(r.logs.some((l) => /attempt 1 of 3/.test(l)));
  } finally {
    await close(r);
  }
});

test('no analyzer: imports are kept and the queue says why it waits', async () => {
  const r = await rig({ noBackend: true });
  try {
    song(r.music, 'Waiting.wav');
    const c = await collection(r.svc);
    const add = await r.svc.addFolder(c.id, r.music);
    assert.equal(add.ok, true);
    assert.match(add.message!, /not available/);
    await sleep(100);
    const q = r.svc.state().queue;
    assert.equal(q.phase, 'light');
    assert.equal(q.running, false);
    assert.match(q.message ?? '', /not available/);
  } finally {
    await close(r);
  }
});

test('resume: a restart continues pending work and never redoes finished tracks', async () => {
  const root = path.join(TMP, 'resume');
  const r1 = await rig({ root });
  const names = ['lazy 1.wav', 'lazy 2.wav', 'lazy 3.wav', 'lazy 4.wav', 'lazy 5.wav', 'lazy 6.wav'];
  for (const n of names) song(r1.music, n);
  const c = await collection(r1.svc);
  await r1.svc.addFolder(c.id, r1.music);
  await waitFor('two tracks analysed', async () => Object.values(await statuses(r1.svc, c.id)).filter((s) => s === 'light').length >= 2);
  const done1 = Object.entries(await statuses(r1.svc, c.id)).filter(([, s]) => s === 'light').map(([n]) => n);
  await close(r1);
  assert.ok(done1.length >= 2 && done1.length < 6, `${done1.length} done before the restart`);

  const r2 = await rig({ root });
  try {
    await idle(r2.svc);
    const st = await statuses(r2.svc, c.id);
    assert.ok(Object.values(st).every((s) => s === 'light'), JSON.stringify(st));
    const second = fs.readFileSync(r2.logFile, 'utf8');
    for (const n of done1) assert.ok(!second.includes(n), `${n} was analysed again after the restart`);
    assert.equal(countRuns(r2.logFile, 'analyze'), 6 - done1.length);
  } finally {
    await close(r2);
  }
});

test('pause: persists across a restart; resume finishes the work', async () => {
  const root = path.join(TMP, 'pause');
  const r1 = await rig({ root });
  const c = await collection(r1.svc);
  const p = await r1.svc.setPaused(true);
  assert.equal(p.ok, true);
  assert.match(p.message!, /paused/);
  for (const n of ['A.wav', 'B.wav']) song(r1.music, n);
  const add = await r1.svc.addFolder(c.id, r1.music);
  assert.match(add.message!, /paused/);
  await close(r1);

  const r2 = await rig({ root });
  try {
    assert.equal(r2.svc.state().queue.paused, true);
    await sleep(300);
    assert.equal(countRuns(r2.logFile, 'analyze'), 0, 'nothing runs while paused');
    const res = await r2.svc.setPaused(false);
    assert.match(res.message!, /resumed: 2 tracks/);
    await idle(r2.svc);
    assert.deepEqual(await statuses(r2.svc, c.id), { A: 'light', B: 'light' });
  } finally {
    await close(r2);
  }
});

test('rescan: new files queued, changed ones re-analysed, deleted ones missing, returned ones restored', async () => {
  const r = await rig();
  try {
    const keep = song(r.music, 'Keep.wav');
    const change = song(r.music, 'Change.wav');
    const gone = song(r.music, 'Gone.wav');
    const away = song(r.music, 'Away.wav');
    const c = await collection(r.svc);
    await r.svc.addFolder(c.id, r.music);
    await idle(r.svc);
    void keep;
    fs.writeFileSync(change, 'RIFF changed and longer');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(change, t, t);
    fs.rmSync(gone);
    const parked = path.join(r.root, 'parked.wav');
    fs.renameSync(away, parked);
    song(path.join(r.music, 'new'), 'Fresh.wav');
    const res = await r.svc.rescan(c.id);
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.data, { added: 1, changed: 1, missing: 2 });
    assert.match(res.message!, /1 new track, 1 changed, 2 missing/);
    await idle(r.svc);
    assert.deepEqual(await statuses(r.svc, c.id), { Keep: 'light', Change: 'light', Gone: 'missing', Away: 'missing', Fresh: 'light' });
    assert.equal(countRuns(r.logFile, 'analyze'), 6, '4 + the changed one again + the new one');
    fs.renameSync(parked, away);
    const back = await r.svc.rescan(c.id);
    assert.deepEqual(back.data, { added: 0, changed: 0, missing: 0 });
    assert.match(back.message!, /1 back/);
    assert.equal((await statuses(r.svc, c.id)).Away, 'light');
    assert.equal(countRuns(r.logFile, 'analyze'), 6);
    const keepId = (await r.svc.query({ collectionId: c.id, text: 'keep' })).data!.tracks[0].id;
    const rm = await r.svc.removeTracks([keepId]);
    assert.equal(rm.ok, true);
    assert.match(rm.message!, /your files were not touched/);
    assert.ok(fs.existsSync(keep), 'the file is still there');
  } finally {
    await close(r);
  }
});

test('deep: needs a stem model; separate → transcribe → lines + hashes; temp stems deleted; silent vocals skipped', async () => {
  const none = await rig();
  try {
    const c0 = await collection(none.svc);
    const r0 = await none.svc.setDeep(c0.id, true);
    assert.equal(r0.ok, false);
    assert.match(r0.message!, /install HT-Demucs \(4 stems\) in Model Manager first/);
  } finally {
    await close(none);
  }

  const r = await rig({ stems: true, basicPitch: true });
  try {
    song(r.music, 'Song.wav');
    song(r.music, 'Instrumental.wav');
    const c = await collection(r.svc);
    await r.svc.addFolder(c.id, r.music);
    const est = await r.svc.estimateDeep(c.id);
    assert.equal(est.ok, true, est.message);
    assert.equal(est.data!.tracks, 2);
    assert.equal(est.data!.device, 'cpu', 'the fake analyzer reports CPU only');
    assert.ok(est.data!.seconds > 0);
    const on = await r.svc.setDeep(c.id, true);
    assert.equal(on.ok, true, on.message);
    assert.equal(on.data!.queued, 2);
    assert.match(on.message!, /temporary stems are deleted/);
    await idle(r.svc, 30_000);
    assert.deepEqual(await statuses(r.svc, c.id), { Song: 'deep', Instrumental: 'deep' });
    assert.equal(countRuns(r.logFile, 'separate'), 2);
    const tmp = path.join(r.userData, 'library', 'tmp');
    assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [], 'temporary stems deleted');

    const songId = (await r.svc.query({ collectionId: c.id, text: 'song' })).data!.tracks[0].id;
    const f = (await r.svc.track(songId)).data!.features!;
    assert.equal(f.lines.vocals?.length, 12, 'vocal melody transcribed');
    assert.equal(f.lines.bass?.length, 8, 'bass line transcribed');
    assert.ok(f.drums && f.drums.source === 'stem', 'the drum stem replaces the mix grid');
    const instId = (await r.svc.query({ collectionId: c.id, text: 'instrumental' })).data!.tracks[0].id;
    const fi = (await r.svc.track(instId)).data!.features!;
    assert.equal(fi.lines.vocals, undefined, 'near-silent vocal stem skipped');
    const log = fs.readFileSync(r.logFile, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('transcribe '));
    assert.equal(log.filter((l) => l.endsWith('vocals.wav')).length, 1, 'only the real vocal stem was transcribed');
    const db = new LibraryDb(path.join(r.userData, 'library', 'library.sqlite'));
    try {
      assert.ok(db.hashCount(songId) > 0, 'originality hashes stored');
      assert.equal(db.referenceCount(), 2);
    } finally {
      db.close();
    }
    const off = await r.svc.setDeep(c.id, false);
    assert.match(off.message!, /keep their data/);
  } finally {
    await close(r);
  }
});

test('profile (cached per change), similar, originality, focus and addToProject end to end', async () => {
  const r = await rig({ stems: true, basicPitch: true });
  try {
    for (const n of ['Song.wav', 'Second.wav', 'fast banger.wav']) song(r.music, n);
    const c = await collection(r.svc);
    await r.svc.addFolder(c.id, r.music);
    await r.svc.setDeep(c.id, true);
    await idle(r.svc, 30_000);

    const p1 = await r.svc.profile(c.id);
    assert.equal(p1.ok, true, p1.message);
    assert.equal(p1.data!.analysed, 3);
    assert.equal(p1.data!.deep, 3);
    assert.equal(p1.data!.name, 'Dark trap');
    const p2 = await r.svc.profile(c.id);
    assert.equal(p2.data, p1.data, 'second call comes from the cache');
    await r.svc.updateCollection(c.id, { name: 'Night trap' });
    const p3 = await r.svc.profile(c.id);
    assert.equal(p3.data!.name, 'Night trap');

    const ids = Object.fromEntries((await r.svc.query({ collectionId: c.id })).data!.tracks.map((t) => [t.name, t.id]));
    const sim = await r.svc.similar(ids.Song, { limit: 5 });
    assert.equal(sim.ok, true, sim.message);
    assert.equal(sim.data!.length, 2);
    assert.equal(sim.data![0].track.name, 'Second', 'the 120 bpm F#m twin ranks above the 160 bpm C major one');
    assert.ok(sim.data![0].score >= sim.data![1].score);

    const p = r.doc.project;
    const keys = p.channelOrder.find((id) => /keys/i.test(p.channels[id].name))!;
    const melody: Array<[number, number, number]> = [[0, 1, 62], [1, 0.5, 65], [1.5, 0.5, 69], [2, 1, 67], [3, 1.5, 64], [4.5, 0.5, 72], [5, 1, 70], [6, 0.5, 65], [6.5, 0.5, 67], [7, 1, 62], [8, 1, 69], [9, 2, 60]];
    const pat = r.doc.exec<{ id: string }>('patterns.add', { name: 'Hook' }, { actor: USER });
    assert.equal(pat.ok, true, pat.message);
    const add = r.doc.exec('notes.add', { patternId: pat.data!.id, channelId: keys, notes: melody.map(([b, d, k]) => ({ tick: Math.round(b * PPQ), dur: Math.round(d * PPQ), key: k + 3, vel: 0.8 })) }, { actor: USER });
    assert.equal(add.ok, true, add.message);
    const rep = await r.svc.checkOriginality({ patternId: pat.data!.id });
    assert.equal(rep.ok, true, rep.message);
    assert.equal(rep.data!.checkedLines, 1);
    assert.equal(rep.data!.references, 3);
    assert.ok(rep.data!.matches.length >= 1, JSON.stringify(rep.data));
    assert.equal(rep.data!.matches[0].stem, 'vocals');
    assert.ok(rep.data!.matches[0].notes >= 8);
    assert.match(rep.data!.summary, /legal advice/i);

    const f = await r.svc.setFocus({ collectionId: c.id, brief: 'dark, sparse' });
    assert.equal(f.ok, true, f.message);
    assert.deepEqual(r.settings().library?.focus, { collectionId: c.id, name: 'Night trap', brief: 'dark, sparse' });
    const ctx = await r.svc.focusContext();
    assert.ok(ctx && ctx.text.includes('Night trap') && ctx.text.includes('dark, sparse'));
    const forFocus = await r.svc.originalityForFocus([pat.data!.id]);
    assert.ok(forFocus && forFocus.matches.length >= 1, 'commit_edit check applies (focus + deep references)');

    const before = r.doc.getHistory().length;
    const tracksBefore = r.doc.project.playlist.trackOrder.length;
    const atp = await r.svc.addToProject(ids.Song);
    assert.equal(atp.ok, true, atp.message);
    assert.equal(r.doc.project.playlist.trackOrder.length, tracksBefore + 1);
    const clip = r.doc.project.playlist.clips[atp.data!.clipId];
    assert.equal(clip.kind, 'audio');
    assert.equal(clip.start, 0);
    assert.equal(r.doc.getHistory().length, before + 1, 'one undo step');
    assert.equal(r.doc.project.playlist.tracks[clip.trackId].name, 'Song');

    const rm = await r.svc.removeCollection(c.id);
    assert.equal(rm.ok, true, rm.message);
    assert.match(rm.message!, /3 track records; your files were not touched/);
    assert.equal(r.settings().library?.focus, null, 'focus cleared with its collection');
    assert.equal(await r.svc.focusContext(), null);
    assert.ok(fs.existsSync(path.join(r.music, 'Song.wav')));
  } finally {
    await close(r);
  }
});

test('collections: names are unique and required; a corrupt database is moved aside', async () => {
  const root = path.join(TMP, 'corrupt');
  const lib = path.join(root, 'userData', 'library');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'library.sqlite'), 'garbage '.repeat(500));
  const r = await rig({ root });
  try {
    assert.ok(r.logs.some((l) => /starting an empty library/.test(l)), r.logs.join('\n'));
    assert.ok(fs.readdirSync(lib).some((f) => /^library\.sqlite\.corrupt-/.test(f)), 'the unreadable file is kept aside');
    const a = await r.svc.createCollection('  Lofi  ');
    assert.equal(a.data!.name, 'Lofi');
    const dup = await r.svc.createCollection('lofi');
    assert.equal(dup.ok, false);
    assert.match(dup.message!, /already exists/);
    const empty = await r.svc.createCollection('   ');
    assert.equal(empty.ok, false);
    assert.match(empty.message!, /name/);
    const gone = await r.svc.addFolder('lc_nope', r.music);
    assert.equal(gone.ok, false);
    assert.match(gone.message!, /no longer exists/);
    const nodir = await r.svc.addFolder(a.data!.id, path.join(root, 'does-not-exist'));
    assert.match(nodir.message!, /Folder not found/);
    fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
    const noaudio = await r.svc.addFolder(a.data!.id, path.join(root, 'empty'));
    assert.match(noaudio.message!, /No audio files/);
  } finally {
    await close(r);
  }
});

void run('library service');
