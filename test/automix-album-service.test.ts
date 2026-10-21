import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { ticksPerBar } from '@shared/schema/time';
import type { Analysis, RenderRequest } from '@shared/engine/protocol';
import type { Settings } from '@shared/types';
import type { AlbumOutcome } from '@shared/automix/types';
import { findKryptSlot, gainToDb, isKryptSlot, type PlanMeasure } from '@shared/automix/plan';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { AutoMixService, setAutomix, forgetReferences, cleanAlbumRequest } from '../electron/automix';
import type { MeasureFn } from '../electron/automix/measure';
import { automixCatalog, mixDoc } from './automix-fixtures';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-album-'));
const MUSIC = path.join(TMP, 'Music');
fs.mkdirSync(MUSIC, { recursive: true });
const song = (name: string): string => {
  const p = path.join(MUSIC, name);
  fs.writeFileSync(p, 'RIFF');
  return p;
};
const REF = song('Big Reference.wav');

const SONGS: Record<string, { lufs: number; sec: number; high: number }> = {
  'Intro.wav': { lufs: -20, sec: 40, high: -12 },
  'Single.wav': { lufs: -14, sec: 180, high: -8 },
  'Ballad.mp3': { lufs: -17, sec: 150, high: -10 },
};

const refAnalysis = (): Analysis => ({
  durationSec: 200,
  peakDb: -0.5,
  truePeakDb: -0.3,
  lufsIntegrated: -9,
  lufsShortTermMax: -7,
  loudnessRange: 5,
  rmsDb: -10,
  crestDb: 8,
  bands: { sub: -14, low: -12, lowMid: -20, mid: -20, highMid: -22, high: -26 },
  stereoCorrelation: 0.6,
  stereoWidth: 0.3,
  energyCurve: [],
  clipping: false,
  estimatedBpm: null,
  spectralCentroidHz: 2000,
});

function chainSound(ins: { volume: number; slots: Record<string, { type: string; params: Record<string, number>; enabled: boolean }>; slotOrder: string[] }, base: { lufs: number; high: number }) {
  const lim = findKryptSlot(ins as never, 'limiter', true);
  const eq = findKryptSlot(ins as never, 'eq', true);
  const im = findKryptSlot(ins as never, 'imager', true);
  const gain = lim ? (ins.slots[lim].params.inputGain ?? 0) : 0;
  const trim = eq ? (ins.slots[eq].params.output ?? 0) : 0;
  const lufs = Math.min(-5, base.lufs + gainToDb(ins.volume) + trim + 0.8 * gain);
  const ceil = lim ? (ins.slots[lim].params.ceiling ?? -0.3) : 0;
  const e = eq ? ins.slots[eq].params : {};
  const tone = { sub: 4 + (e.b2Gain ?? 0), low: 6 + (e.b3Gain ?? 0), lowMid: 0 + (e.b4Gain ?? 0), mid: 0, highMid: -6 + (e.b5Gain ?? 0), high: base.high + (e.b6Gain ?? 0) };
  const w = im ? (ins.slots[im].params.midWidth ?? 1) : 1;
  const width = Math.min(0.9, 0.12 * w * w);
  return { lufs, tp: Math.min(lufs + 9, lim ? ceil : 0), tone, width, gr: lim ? { slotId: lim, avg: 0.2 * gain } : null };
}

function albumMeasure(o: { gate?: (n: number) => Promise<void> } = {}): { fn: MeasureFn; calls: () => number; scopes: string[] } {
  let n = 0;
  const scopes: string[] = [];
  const fn: MeasureFn = async (deps, scope) => {
    const i = n++;
    scopes.push(scope.bars ?? 'song');
    if (o.gate) await o.gate(i);
    const p = deps.doc.project;
    let base = { lufs: -16, high: -9 };
    let ins = p.mixer.inserts[p.mixer.masterId];
    if (scope.bars) {
      const startBar = Number(scope.bars.split('-')[0]);
      const tick = (startBar - 1) * ticksPerBar(p.transport.timeSig);
      const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'audio' && c.start === tick);
      assert.ok(clip, `a song starts at bar ${startBar}`);
      const ch = p.channels[clip.channelId!];
      const file = path.basename(p.samples[ch.generator.sampleId!].path);
      base = SONGS[file] ?? base;
      ins = p.mixer.inserts[ch.insertId];
      assert.equal(scope.stems, false, 'album songs render the mix only');
    }
    const s = chainSound(ins, base);
    const masterLim = p.mixer.inserts[p.mixer.masterId].slotOrder.map((x) => p.mixer.inserts[p.mixer.masterId].slots[x]).find((x) => x.type === 'krypt.limiter');
    const tp = masterLim ? Math.min(s.tp, masterLim.params.ceiling ?? 0) : s.tp;
    const measure: PlanMeasure = {
      master: { lufs: s.lufs, truePeak: tp, peakDb: tp - 0.2, crestDb: 10, lra: 6, tone: s.tone, correlation: 0.6, width: s.width },
      inserts: {},
      gr: s.gr ? [{ insertId: ins.id, slotId: s.gr.slotId, avgDb: s.gr.avg, maxDb: s.gr.avg * 2, active: 0.3 }] : [],
    };
    return { label: scope.bars ? `bars ${scope.bars}` : 'the song', measure };
  };
  return { fn, calls: () => n, scopes };
}

function rig(o: { gate?: (n: number) => Promise<void>; fromMix?: boolean } = {}) {
  const doc = o.fromMix ? mixDoc().doc : new DocHost(createDefaultProject('Start'), automixCatalog(), { strict: true });
  let settings = {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [],
    recent: [],
    autosaveSec: 60,
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'anywhere' },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: false,
    library: { fastScan: false, focus: null },
  } as unknown as Settings;
  const calls = { analyzeFile: 0, renders: [] as RenderRequest[], previews: [] as Array<{ path: string; gain: number }> };
  let newTabs = 0;
  const deps: MainDeps = {
    doc,
    engine: {
      request: async (req: { cmd: string; path?: string; gain?: number }) => {
        if (req.cmd === 'previewFile') calls.previews.push({ path: req.path!, gain: req.gain! });
        return { ok: true, data: {} as never };
      },
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async (job: RenderRequest) => {
        calls.renders.push(job);
        fs.writeFileSync(job.path, 'audio');
        return { ok: true, data: { path: job.path, files: [job.path], durationSec: 1, peakDb: -1, lufsIntegrated: -9 } };
      },
      analyzeFile: async (p: string) => {
        calls.analyzeFile++;
        return path.basename(p) === 'Silence.wav' ? { ok: true, data: { ...refAnalysis(), lufsIntegrated: -90 } } : { ok: true, data: refAnalysis() };
      },
      sampleInfo: async (p: string) => {
        const s = SONGS[path.basename(p)];
        return { ok: true, data: { path: p, frames: 48000 * (s?.sec ?? 120), sampleRate: 48000, channels: 2, durationSec: s?.sec ?? 120 } };
      },
      restart: async () => ({ ok: true }),
    } as unknown as MainDeps['engine'],
    project: {
      status: () => ({ path: null, name: 'Start', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p: string) => p,
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [TMP],
      newProject: () => {
        newTabs++;
        doc.reset(createDefaultProject('Untitled'));
        return { ok: true, message: 'New project tab' };
      },
      opensNewTabs: () => true,
    },
    getSettings: () => settings,
    updateSettings: (p) => (settings = { ...settings, ...p }),
    broadcast: () => {},
    userDataDir: path.join(TMP, `userData-${Math.random().toString(36).slice(2)}`),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  const sim = albumMeasure({ gate: o.gate });
  const svc = new AutoMixService({ deps, ai: null, measure: sim.fn });
  setAutomix(doc, svc);
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'claude-code', name: 'Claude Code' }, session: newSession(), via: 'test' };
  return { doc, deps, svc, sim, calls, newTabs: () => newTabs, call: (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true }) };
}

const live = (doc: DocHost) => doc.getHistory().filter((h) => !h.undone);
const ALBUM = () => [song('Intro.wav'), song('Single.wav'), song('Ballad.mp3')];

test('reference: one light engine pass, then cached in memory and on disk', async () => {
  forgetReferences();
  const r = rig();
  const a = await r.svc.analyzeReference(REF);
  assert.equal(a.ok, true, a.message);
  assert.equal(a.data!.lufs, -9);
  assert.equal(a.data!.cached, false);
  assert.match(a.data!.summary, /^−9\.0 LUFS · .* · wide$/);
  const b = await r.svc.analyzeReference(REF);
  assert.equal(b.data!.cached, true);
  assert.equal(r.calls.analyzeFile, 1, 'read once');
  forgetReferences();
  const c = await r.svc.analyzeReference(REF);
  assert.equal(c.data!.cached, true, 'the disk cache survives a restart');
  assert.equal(r.calls.analyzeFile, 1);
  assert.match((await r.svc.analyzeReference(path.join(MUSIC, 'missing.wav'))).message!, /wasn't found/);
  assert.match((await r.svc.analyzeReference('relative.wav')).message!, /isn't an audio file/);
  assert.match((await r.svc.analyzeReference(song('Silence.wav'))).message!, /can't be a reference: it is silent/);
});

test('reference run (master): aims at its tone, loudness and width; closeness before → after; one entry', async () => {
  forgetReferences();
  const r = rig({ fromMix: true });
  const h0 = r.doc.getHistory().length;
  const out = await r.svc.run({ mode: 'master', preset: 'pop-polish', reference: REF }, { actor: USER });
  assert.equal(out.ok, true, out.message);
  const o = out.data!;
  assert.equal(r.doc.getHistory().length, h0 + 1, 'one history entry');
  assert.ok(o.reference, 'the outcome names the reference');
  assert.equal(o.reference!.lufs, -9);
  assert.ok(Math.abs(o.after.lufs - -9) <= 0.5, `after ${o.after.lufs} (the reference's loudness, not Pop Polish's −9 by chance: see the next assertion)`);
  assert.deepEqual(o.targetTone, { ...o.reference!.tone });
  assert.ok(o.reference!.distanceAfter < o.reference!.distanceBefore, `${o.reference!.distanceBefore} → ${o.reference!.distanceAfter}`);
  assert.ok(o.after.truePeak <= -1 + 0.05, `the −1 dBTP default with a reference: ${o.after.truePeak}`);
  assert.ok(o.notes.some((n) => /^Matching "Big Reference"/.test(n)), o.notes.join(' | '));
  assert.ok(o.changes.some((c) => /Imager/.test(c.target) && /toward the reference's width/.test(c.what)), o.changes.map((c) => c.what).join(' | '));
  const q = rig({ fromMix: true });
  const quiet = await q.svc.run({ mode: 'master', preset: 'pop-polish', reference: REF, targetLufs: -14 }, { actor: USER });
  assert.ok(Math.abs(quiet.data!.after.lufs - -14) <= 0.5, 'your target wins over the reference');
});

test('reference: a bad file changes nothing; vocals mode ignores it and says so; the matched preview gain', async () => {
  forgetReferences();
  const r = rig({ fromMix: true });
  const before = JSON.stringify(r.doc.project.mixer);
  const bad = await r.svc.run({ mode: 'master', reference: path.join(MUSIC, 'nope.wav') }, { actor: USER });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /couldn't use the reference song.*Nothing was changed/);
  assert.equal(JSON.stringify(r.doc.project.mixer), before);
  assert.equal(r.svc.busy, null);
  const v = await r.svc.run({ mode: 'vocals', reference: path.join(MUSIC, 'nope.wav') }, { actor: USER });
  assert.ok(v.data?.notes.some((n) => /only shapes mastering/.test(n)), v.message);
  const p = await r.svc.playReference(REF, -12);
  assert.equal(p.ok, true, p.message);
  assert.equal(p.data!.gainDb, -3);
  assert.ok(Math.abs(r.calls.previews[0].gain - Math.pow(10, -3 / 20)) < 1e-9);
  assert.match(p.message!, /3\.0 dB quieter/);
});

test('album: a new tab with the songs back to back, ONE mastering entry, a chain per song, only a safety limiter on the master', async () => {
  const r = rig();
  const out = await r.svc.masterAlbum({ paths: ALBUM(), preset: 'balanced' }, USER);
  assert.equal(out.ok, true, out.message);
  const o = out.data as AlbumOutcome;
  const p = r.doc.project;
  assert.equal(r.newTabs(), 1);
  assert.equal(p.meta.name, 'Album: Intro + 2');
  assert.equal(o.songs.length, 3);
  assert.equal(Object.keys(p.playlist.markers).length, 3);
  assert.deepEqual(Object.values(p.playlist.markers).map((m) => m.name).sort(), ['1. Intro', '2. Single', '3. Ballad']);
  const bar = ticksPerBar(p.transport.timeSig);
  for (let i = 1; i < 3; i++) assert.ok(o.songs[i].startTick >= o.songs[i - 1].endTick + 2 * bar - bar, 'a gap of about 2 bars');
  assert.equal(live(r.doc).length, 2, 'the songs, then the mastering');
  assert.ok(o.entryId);
  const master = p.mixer.inserts[p.mixer.masterId];
  assert.deepEqual(master.slotOrder.map((s) => master.slots[s].type), ['krypt.limiter']);
  assert.equal(isKryptSlot(master.slots[master.slotOrder[0]]), false, 'the safety limiter is not Krypt-marked');
  for (const s of o.songs) {
    const ins = p.mixer.inserts[s.insertId];
    const types = ins.slotOrder.map((x) => ins.slots[x].type);
    assert.ok(types.includes('krypt.eq') && types.includes('krypt.glue') && types.includes('krypt.imager'), types.join(','));
    assert.equal(types[types.length - 1], 'krypt.limiter', `${s.name}: limiter last`);
    assert.ok(s.after.truePeak <= o.truePeak + 0.05);
  }
  assert.deepEqual(o.songs.map((s) => s.targetLufs), [-15, -11, -14]);
  for (const s of o.songs) assert.ok(Math.abs(s.after.lufs - s.targetLufs) <= 0.5, `${s.name} ${s.after.lufs} vs ${s.targetLufs}`);
  assert.ok(o.passes >= 1 && o.passes <= 3);
  assert.ok(r.sim.calls() <= 3 + 3 * 3 + 3, `renders ${r.sim.calls()} (each song once per pass)`);
  assert.ok(o.notes.some((n) => /^Loudness: .* LU between the loudest and the quietest/.test(n)));
  assert.match(out.message!, /One undo step removes the mastering/);
  const after = JSON.stringify(p.mixer);
  assert.equal(r.doc.toggleEntry(o.entryId!, USER).ok, true);
  assert.equal(r.doc.project.mixer.inserts[r.doc.project.mixer.masterId].slotOrder.length, 0, 'Before: no chains');
  assert.equal(r.doc.toggleEntry(o.entryId!, USER).ok, true);
  assert.equal(JSON.stringify(r.doc.project.mixer), after);
});

test('album: every song on target without keep-dynamics; the tone of the songs moves closer together', async () => {
  const r = rig();
  const out = await r.svc.masterAlbum({ paths: ALBUM(), preset: 'balanced', targetLufs: -11, keepDynamics: false }, USER);
  assert.equal(out.ok, true, out.message);
  const o = out.data!;
  assert.deepEqual(o.songs.map((s) => s.targetLufs), [-11, -11, -11]);
  const spread = (k: 'before' | 'after') => Math.max(...o.songs.map((s) => s[k].tone.high)) - Math.min(...o.songs.map((s) => s[k].tone.high));
  assert.ok(spread('after') < spread('before'), `highs spread ${spread('before')} → ${spread('after')}`);
});

test('album: bad lists are refused before anything opens; Cancel rolls the mastering back and keeps the songs', async () => {
  const r = rig();
  assert.match((await r.svc.masterAlbum({ paths: [song('Single.wav')] }, USER)).message!, /at least 2 songs/);
  assert.match((await r.svc.masterAlbum({ paths: [song('Single.wav'), song('Single.wav')] }, USER)).message!, /in the list twice/);
  assert.match((await r.svc.masterAlbum({ paths: [song('Single.wav'), path.join(MUSIC, 'x.txt')] }, USER)).message!, /isn't an audio file/);
  assert.equal(r.newTabs(), 0);
  assert.equal(typeof cleanAlbumRequest({ paths: 'nope' }), 'string');

  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let entered!: () => void;
  const inside = new Promise<void>((res) => (entered = res));
  const c = rig({ gate: async (n) => { if (n === 4) { entered(); await gate; } } });
  const job = c.svc.masterAlbum({ paths: ALBUM(), preset: 'balanced' }, USER);
  await inside;
  assert.equal(c.svc.busy, 'Master an album');
  const songsJson = () => JSON.stringify(Object.values(c.doc.project.playlist.clips).map((x) => x.start));
  const layout = songsJson();
  assert.equal(c.svc.cancel().ok, true);
  release();
  const out = await job;
  assert.equal(out.ok, false);
  assert.match(out.message!, /^Cancelled: nothing was mastered\. The songs are in the album tab/);
  assert.equal(live(c.doc).length, 1, 'only the songs entry');
  for (const id of c.doc.project.mixer.insertOrder) assert.equal(c.doc.project.mixer.inserts[id].slotOrder.length, 0, 'no chains left');
  assert.equal(songsJson(), layout);
  assert.equal(c.svc.busy, null);
});

test('Export all: one file per song from its range, "(mastered)", never overwriting; refuses another tab', async () => {
  const r = rig();
  const out = await r.svc.masterAlbum({ paths: ALBUM(), preset: 'balanced' }, USER);
  const o = out.data!;
  const folder = path.join(TMP, 'export');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'Intro (mastered).wav'), 'old');
  const songs = o.songs.map((s) => ({ name: s.name, startTick: s.startTick, endTick: s.endTick }));
  const ex = await r.svc.exportAlbum({ folder, format: 'wav24', songs });
  assert.equal(ex.ok, true, ex.message);
  assert.deepEqual(ex.data!.files.map((f) => path.basename(f)), ['Intro (mastered) 2.wav', 'Single (mastered).wav', 'Ballad (mastered).wav']);
  assert.equal(fs.readFileSync(path.join(folder, 'Intro (mastered).wav'), 'utf8'), 'old', 'nothing overwritten');
  assert.ok(!fs.readdirSync(folder).some((f) => /partial/.test(f)), 'no partial files left');
  assert.equal(r.calls.renders.length, 3);
  assert.deepEqual(r.calls.renders[1].scope, { kind: 'range', startTick: o.songs[1].startTick, endTick: o.songs[1].endTick });
  assert.equal(r.calls.renders[1].format, 'wav24');
  assert.match(ex.message!, /Exported 3 songs .*24-bit WAV/);
  const mp3 = await r.svc.exportAlbum({ folder, format: 'mp3', mp3Kbps: 320, songs });
  assert.ok(mp3.data!.files.every((f) => f.endsWith('.mp3')));
  assert.equal(r.calls.renders[3].mp3Kbps, 320);
  const wrong = await r.svc.exportAlbum({ folder, format: 'wav24', songs: [{ name: 'x', startTick: 12345, endTick: 99999 }] });
  assert.match(wrong.message!, /isn't the open project tab/);
  assert.match((await r.svc.exportAlbum({ folder: path.join(TMP, 'nope'), format: 'wav24', songs })).message!, /doesn't exist/);
});

test('auto_mix (MCP): files = an album (or one song) in a new tab; reference on the open project', async () => {
  forgetReferences();
  const r = rig();
  const res = await r.call('auto_mix', { files: ALBUM(), preset: 'streaming-clean' });
  assert.equal(res.ok, true, res.message);
  assert.match(res.text ?? '', /^album "Album: Intro \+ 2"/);
  assert.match(res.text ?? '', /1\. "Intro" bars 1-/);
  assert.equal(r.newTabs(), 1);
  const agentEntries = r.doc.getHistory().filter((h) => h.actorKey === 'agent:claude-code' && !h.undone);
  assert.equal(agentEntries.length, 2, 'the songs + the mastering, as the agent');
  const one = await r.call('auto_mix', { files: [song('Single.wav')] });
  assert.equal(one.ok, true, one.message);
  assert.match(one.message, /new project tab/);
  const dry = await r.call('auto_mix', { files: ALBUM(), dry_run: true });
  assert.equal(dry.ok, false);
  assert.match(dry.message, /dry_run works on the open project only/);
  const m = rig({ fromMix: true });
  const withRef = await m.call('auto_mix', { mode: 'master', reference: REF });
  assert.equal(withRef.ok, true, withRef.message);
  assert.match(withRef.text ?? '', /reference "Big Reference": -9 LUFS/);
  assert.match(withRef.text ?? '', /Closer to the reference by/);
});

run('automix-album-service');
