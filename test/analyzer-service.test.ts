import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { AnalyzerState } from '@shared/types';
import { checkIntegrity } from '@shared/schema/project';
import { AnalyzerSupervisor } from '../electron/analyzer/supervisor';
import { ModelManager } from '../electron/analyzer/models';
import { AnalyzerService } from '../electron/analyzer/service';
import { clipPlayback, effectiveBpm, heardSemis, hitsByRole, notesToTicks, secToTick } from '../electron/analyzer/convert';
import { syncBpm } from '@shared/analyzer/tempo';
import { countRuns, earsCatalog, fakeSpawn, stageModels, TEST_MODELS, writeFakeAnalyzer } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-ears-'));
const script = writeFakeAnalyzer(TMP);
const logFile = path.join(TMP, 'calls.log');
const FACTORY = path.join(TMP, 'factory');
fs.mkdirSync(path.join(FACTORY, 'drums'), { recursive: true });
for (const f of ['kick.wav', 'snare.wav', 'hat-closed.wav', 'hat-open.wav', 'perc.wav']) fs.writeFileSync(path.join(FACTORY, 'drums', f), 'RIFF');
const AUDIO = path.join(TMP, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
for (const f of ['Loop.wav', 'SlowLoop.wav', 'crash.wav', 'EmptyVox.wav']) fs.writeFileSync(path.join(AUDIO, f), 'RIFF' + f);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CAT = earsCatalog();

let rigN = 0;
async function rig(opts: { stems?: boolean; basicPitch?: boolean; bpm?: number } = {}) {
  const root = path.join(TMP, `rig${++rigN}`);
  const userData = path.join(root, 'userData');
  const bundled = path.join(root, 'bundled');
  stageModels(userData, bundled, opts);
  const doc = new DocHost(createDefaultProject('Ears'), CAT, { strict: true });
  if (opts.bpm) doc.exec('transport.set', { bpm: opts.bpm }, { actor: USER });
  const logs: string[] = [];
  const log = (level: string, m: string) => logs.push(`${level} ${m}`);
  const supervisor = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'not built', log, spawn: fakeSpawn(script, logFile), idleShutdownMs: 0 });
  const models = new ModelManager({ catalog: TEST_MODELS, bundledDirs: [bundled], userModelsDir: path.join(userData, 'models'), log });
  const states: AnalyzerState[] = [];
  const svc = new AnalyzerService({
    doc,
    supervisor,
    models,
    userDataDir: userData,
    resolveSamplePath: (p) => (p.startsWith('factory:') ? path.join(FACTORY, p.slice('factory:'.length)) : p),
    broadcast: (s) => states.push(s),
    log,
  });
  await svc.init();
  const addLoop = (file = 'Loop.wav', start = 0) => {
    const trackId = doc.project.playlist.trackOrder[0];
    const r = doc.exec<{ clipId: string; channelId: string; sampleId: string }>(
      'playlist.addAudio',
      { path: path.join(AUDIO, file), trackId, start, frames: 352800, sampleRate: 44100, channels: 2 },
      { actor: USER },
    );
    assert.equal(r.ok, true, r.message);
    return r.data!;
  };
  return { doc, svc, states, logs, userData, addLoop, supervisor };
}

const histLen = (doc: DocHost) => doc.getHistory().length;

test('convert: seconds → ticks at a tempo, quantize, drum role dedupe, effective tempo', () => {
  assert.equal(secToTick(0.5, 120), 960);
  assert.equal(secToTick(0.5, 140), 1120);
  assert.equal(secToTick(0.13, 120, 240), 240, 'snapped to a 16th');
  assert.deepEqual(notesToTicks([{ startSec: 0.5, durSec: 0.25, key: 64, vel: 2 }, { startSec: 0, durSec: 0, key: 300, vel: 1 }], 120), [{ tick: 960, key: 64, dur: 480, vel: 1 }]);
  const hits = hitsByRole(
    [
      { timeSec: 0.01, role: 'kick', vel: 0.4 },
      { timeSec: 0.02, role: 'kick', vel: 0.9 },
      { timeSec: 0.5, role: 'snare', vel: 0.5 },
    ],
    120,
    () => 60,
    240,
  );
  assert.deepEqual(hits.get('kick'), [{ tick: 0, key: 60, dur: 240, vel: 0.9 }], 'two kicks on one snapped step keep the louder');
  const doc = new DocHost(createDefaultProject('x'), CAT);
  const p = doc.project;
  assert.deepEqual(effectiveBpm(p, CAT, null), { bpm: 140, synced: false });
  const ch = { ...p.channels[p.channelOrder[0]], generator: { type: 'krypt.audioclip', params: { tempo_sync: 1, src_bpm: 96 }, sampleId: null } };
  assert.deepEqual(effectiveBpm(p, CAT, ch), { bpm: 96, synced: true });
  assert.deepEqual(effectiveBpm(p, CAT, { ...ch, generator: { ...ch.generator, params: { src_bpm: 96 } } }), { bpm: 140, synced: false }, 'not synced → project tempo');
});

test('convert: notes land where and at the pitch the clip plays them (pitch shift, warp markers, reverse, repitch)', () => {
  const doc = new DocHost(createDefaultProject('x'), CAT);
  const p = doc.project;
  const base = p.channels[p.channelOrder[0]];
  const clip = (params: Record<string, number>, warp?: any) => ({ ...base, generator: { type: 'krypt.audioclip', params, sampleId: null, ...(warp ? { warp } : {}) } }) as any;
  const note = { startSec: 1, durSec: 0.5, key: 60, vel: 0.8 };

  const shifted = clipPlayback(p, CAT, clip({ pitch: 1.73 }), { frames: 480000, sampleRate: 48000 });
  assert.deepEqual(notesToTicks([note], shifted), [{ tick: secToTick(1, 140), key: 62, dur: secToTick(0.5, 140), vel: 0.8, fine: -27 }]);
  assert.deepEqual(notesToTicks([note], clipPlayback(p, CAT, clip({ pitch: -12 }), null))[0].key, 48);
  assert.equal(notesToTicks([note], clipPlayback(p, CAT, clip({}), null))[0].fine, undefined, 'unshifted: no fine');
  assert.deepEqual(notesToTicks([note], 120), [{ tick: 1920, key: 60, dur: 960, vel: 0.8 }], 'a plain tempo still works');

  const markers = [
    { id: 'a', sec: 0, beat: 0 },
    { id: 'b', sec: 2, beat: 8 },
  ];
  const warped = clipPlayback(p, CAT, clip({}, { mode: 'complex', markers }), null);
  assert.equal(secToTick(1, warped), 4 * 960);
  assert.deepEqual(notesToTicks([note], warped)[0], { tick: 3840, key: 60, dur: 1920, vel: 0.8 });

  const rev = clipPlayback(p, CAT, clip({ reverse: 1 }), { frames: 480000, sampleRate: 48000 });
  assert.deepEqual(notesToTicks([note], rev)[0], { tick: secToTick(8.5, 140), key: 60, dur: secToTick(9, 140) - secToTick(8.5, 140), vel: 0.8 });

  const vari = clipPlayback(p, CAT, clip({ tempo_sync: 1, src_bpm: 70, pitch: 5 }, { mode: 'repitch', markers: [] }), null);
  assert.ok(Math.abs(heardSemis(vari, 1) - 12) < 1e-6);
  assert.equal(notesToTicks([note], vari)[0].key, 72);
  assert.deepEqual(clipPlayback(p, CAT, base, null), { bpm: 140 });
});

test('syncBpm: an octave reading near the project tempo replaces a far-off detection; a real off-tempo loop stays', () => {
  assert.equal(syncBpm({ bpm: 75.02, alternatives: [150.04] }, 140), 150, 'stem read at half time');
  assert.equal(syncBpm({ bpm: 70.02 }, 140), 140, 'trap half-time reading');
  assert.equal(syncBpm({ bpm: 280.1 }, 140), 140, 'double-time reading');
  assert.equal(syncBpm({ bpm: 93 }, 140), 93, 'a real 93 bpm loop stays 93 (186 is not near 140 either)');
  assert.equal(syncBpm({ bpm: 128.06 }, 140), 128, 'within ±25%: the detection stands, snapped');
  assert.equal(syncBpm({ bpm: 87.5 }, 0), 87.5);
});

test('audio clip timing params keep the same audio on screen: setGenParams / params.set / reset rescale the clips, other params do not', () => {
  const doc = new DocHost(createDefaultProject('t'), CAT, { strict: true });
  const exec = (cmd: string, args: unknown) => {
    const r = doc.exec<any>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data;
  };
  const trackId = doc.project.playlist.trackOrder[0];
  const { clipId, channelId } = exec('playlist.addAudio', { path: path.join(AUDIO, 'Loop.wav'), trackId, start: 960, frames: 441000, sampleRate: 44100, channels: 2 });
  exec('playlist.updateClips', { updates: [{ id: clipId, length: 22400, offset: 1400, fadeIn: 280, fadeOut: 560 }] });
  const clip = () => doc.project.playlist.clips[clipId];
  const shape = () => [clip().start, clip().length, clip().offset, clip().fadeIn, clip().fadeOut];
  assert.deepEqual(shape(), [960, 22400, 1400, 280, 560]);
  exec('channels.setGenParams', { id: channelId, params: { tempo_sync: 1, src_bpm: 70 } });
  assert.deepEqual(shape(), [960, 11200, 700, 140, 280], 'synced from 70 bpm: the same audio spans half the ticks; start unchanged');
  exec('params.set', { ref: `channel/${channelId}/gen/stretch`, value: 2 });
  assert.deepEqual(shape(), [960, 22400, 1400, 280, 560], 'stretch ×2 through a knob (params.set) doubles it again');
  exec('channels.setGenParams', { id: channelId, params: { pitch: 3, formant: 0 } });
  assert.deepEqual(shape(), [960, 22400, 1400, 280, 560], 'pitch / formant do not move audio in time');
  exec('channels.setGenParams', { id: channelId, params: { tempo_sync: 1, src_bpm: 140, stretch: 1 } });
  exec('transport.set', { bpm: 70 });
  assert.deepEqual(shape(), [960, 22400, 1400, 280, 560], 'a synced clip keeps its ticks when the project tempo changes');
  exec('channels.resetGenParams', { id: channelId });
  assert.deepEqual(shape(), [960, 11200, 700, 140, 280], 'reset → plays at its own speed at the project 70 bpm');
  doc.undo(USER);
  assert.deepEqual(shape(), [960, 22400, 1400, 280, 560], 'undo restores clip and params together');
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('separateStems without the model: clear message, project untouched', async () => {
  const { doc, svc, addLoop, supervisor } = await rig();
  const { clipId } = addLoop();
  const v = doc.version;
  const r = await svc.separateStems(clipId);
  assert.deepEqual(r, { ok: false, message: 'Install HT-Demucs in Model Manager first.' });
  assert.equal(doc.version, v);
  assert.equal(supervisor.status().running, false, 'the analyzer was never started');
});

test('separateStems: 4 stems under the source track, one undo step, origin set, params copied, clips aligned, source muted; then from cache', async () => {
  const { doc, svc, states, addLoop, userData, supervisor } = await rig({ stems: true });
  const { clipId, channelId, sampleId } = addLoop('Loop.wav', 1920);
  doc.exec('channels.setGenParams', { id: channelId, params: { gain: -3, pitch: 2, tempo_sync: 1, src_bpm: 120 } }, { actor: USER });
  doc.exec('channels.set', { id: channelId, volume: 0.6, pan: -0.25 }, { actor: USER });
  doc.exec('playlist.updateClips', { updates: [{ id: clipId, length: 7680, offset: 480, gain: 0.8 }] }, { actor: USER });
  const src = structuredClone(doc.project.playlist.clips[clipId]);
  const srcTrackIdx = doc.project.playlist.trackOrder.indexOf(src.trackId);
  const before = histLen(doc);
  const runs = countRuns(logFile, 'separate');

  const r = await svc.separateStems(clipId);
  assert.equal(r.ok, true, r.message);
  assert.equal(countRuns(logFile, 'separate'), runs + 1);
  assert.match(r.message!, /^Separated "Loop" into drums, bass, vocals and other \(HT-Demucs on the CPU, 2 s\)\. The stems are on 4 new tracks under "Track 1"; the original clip is muted\.$/);
  const out = r.data!;
  assert.deepEqual(out.stems, ['drums', 'bass', 'vocals', 'other']);
  assert.equal(out.model, 'htdemucs');
  assert.equal(out.device, 'cpu');

  const p = doc.project;
  assert.deepEqual(checkIntegrity(p), []);
  assert.equal(histLen(doc), before + 1, 'ONE history entry');
  const h = doc.getHistory().at(-1)!;
  assert.equal(h.label, 'Separate stems (4)');
  assert.equal(h.actorKey, 'user');
  assert.deepEqual(p.playlist.trackOrder.slice(srcTrackIdx + 1, srcTrackIdx + 5), out.trackIds, 'directly under the source track, in stem order');
  assert.deepEqual(out.trackIds.map((t) => p.playlist.tracks[t].name), ['Loop · Drums', 'Loop · Bass', 'Loop · Vocals', 'Loop · Other']);
  assert.equal(p.playlist.clips[clipId].mute, true, 'source clip muted');
  const srcCh = p.channels[channelId];
  out.channelIds.forEach((chId, i) => {
    const ch = p.channels[chId];
    assert.equal(ch.generator.type, 'krypt.audioclip');
    assert.deepEqual(ch.generator.params, srcCh.generator.params, 'generator params copied (stretch / pitch / tempo sync)');
    assert.equal(ch.volume, 0.6);
    assert.equal(ch.pan, -0.25);
    assert.notEqual(ch.insertId, srcCh.insertId);
    assert.deepEqual(p.mixer.inserts[ch.insertId].routes, { [p.mixer.masterId]: 1 });
    const s = p.samples[ch.generator.sampleId!];
    assert.deepEqual(s.origin, { kind: 'stem', parentSampleId: sampleId, stem: out.stems[i], model: 'htdemucs' });
    assert.ok(s.path.startsWith(path.join(userData, 'stems')), s.path);
    assert.ok(fs.existsSync(s.path));
    assert.equal(s.frames, 352800);
    assert.equal(s.sampleRate, 44100);
    const clip = Object.values(p.playlist.clips).find((c) => c.channelId === chId)!;
    assert.equal(clip.trackId, out.trackIds[i]);
    assert.deepEqual([clip.start, clip.length, clip.offset, clip.gain, clip.mute], [src.start, src.length, src.offset, src.gain, false], 'aligned with the source clip');
  });
  const stemsRoot = path.join(userData, 'stems');
  assert.equal(fs.readdirSync(stemsRoot).filter((n) => n.includes('.tmp-')).length, 0, 'temp folder renamed into place');
  assert.ok(states.some((s) => s.jobs.some((j) => j.kind === 'separate' && j.label === 'Separating "Loop" (HT-Demucs)')), 'job broadcast');
  assert.equal(states.at(-1)!.jobs.length, 0, 'finished job removed from the broadcast state');
  assert.equal(svc.state().jobs.length, 0);

  const u = doc.undo(USER);
  assert.equal(u.ok, true, u.message);
  assert.equal(doc.project.playlist.clips[clipId].mute, false);
  assert.ok(out.channelIds.every((id) => !doc.project.channels[id]));

  const r2 = await svc.separateStems(clipId);
  assert.equal(r2.ok, true, r2.message);
  assert.match(r2.message!, /from the stem cache/);
  assert.equal(r2.data!.seconds, 0);
  assert.equal(countRuns(logFile, 'separate'), runs + 1);
  await supervisor.stop();
});

test('separateStems: unknown / wrong-task model, pattern clip, deleted clip', async () => {
  const { doc, svc, addLoop, supervisor } = await rig({ stems: true });
  const { clipId } = addLoop();
  assert.match((await svc.separateStems(clipId, { model: 'nope' })).message!, /Unknown stem model "nope"\. Stem models: htdemucs/);
  assert.match((await svc.separateStems(clipId, { model: 'basic-pitch' })).message!, /Basic Pitch is a transcribe model/);
  const pat = doc.project.patternOrder[0];
  const pc = doc.exec<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: doc.project.playlist.trackOrder[2], start: 0, patternId: pat }, { actor: USER }).data!.id;
  assert.match((await svc.separateStems(pc)).message!, /That is a pattern clip; only audio clips can be analysed/);
  assert.equal((await svc.separateStems('clip_gone')).message, 'That clip no longer exists');
  await supervisor.stop();
});

test('separateStems twice at once (double click): one analyzer run, stems added once, both callers get the outcome', async () => {
  const { doc, svc, addLoop, supervisor } = await rig({ stems: true });
  const { clipId } = addLoop('Loop.wav');
  const tracks = doc.project.playlist.trackOrder.length;
  const runs = countRuns(logFile, 'separate');
  const [a, b] = await Promise.all([svc.separateStems(clipId), svc.separateStems(clipId)]);
  assert.equal(a.ok && b.ok, true, `${a.message} / ${b.message}`);
  assert.deepEqual(a.data!.trackIds, b.data!.trackIds);
  assert.equal(doc.project.playlist.trackOrder.length, tracks + 4);
  assert.ok(countRuns(logFile, 'separate') <= runs + 1);
  await supervisor.stop();
});

test('jobs: listed with progress, cancellable; cancel leaves nothing behind; a model in use cannot be removed', async () => {
  const { doc, svc, addLoop, userData, supervisor } = await rig({ stems: true });
  const { clipId } = addLoop('SlowLoop.wav');
  const v = doc.version;
  const p = svc.separateStems(clipId);
  while (!(svc.state().jobs[0]?.fraction > 0)) await sleep(10);
  const job = svc.state().jobs[0];
  assert.equal(job.kind, 'separate');
  assert.equal(job.stage, 'separating', 'progress reaches the job list');
  assert.ok(job.startedAt > 0);
  const rm = await svc.removeModel('htdemucs');
  assert.equal(rm.ok, false);
  assert.match(rm.message!, /in use by "Separating "SlowLoop" \(HT-Demucs\)"/);
  assert.equal(svc.cancelJob(job.id).ok, true);
  const r = await p;
  assert.deepEqual(r, { ok: false, message: 'Stem separation cancelled' });
  assert.equal(doc.version, v, 'project unchanged');
  assert.equal(svc.state().jobs.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(userData, 'stems')), [], 'no stems, no temp folder');
  assert.equal(svc.cancelJob(job.id).message, 'That job already finished');
  await supervisor.stop();
});

test('analyze: clip / channel / file targets, cached per file, errors in plain words', async () => {
  const { svc, addLoop, supervisor } = await rig();
  const { clipId, channelId } = addLoop();
  const runs = countRuns(logFile, 'analyze');
  const r = await svc.analyze({ clipId });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.tempo!.bpm, 120);
  assert.equal(r.data!.key!.name, 'F#m');
  assert.equal(r.data!.path, path.join(AUDIO, 'Loop.wav'));
  assert.match(r.message!, /^Analysed "Loop": ~120 bpm, key F#m, 8 s, -9\.5 LUFS$/);
  const r2 = await svc.analyze({ channelId });
  assert.match(r2.message!, /\(cached\)/);
  assert.equal(countRuns(logFile, 'analyze'), runs + 1, 'the channel shares the clip file cache');
  const r3 = await svc.analyze({ path: path.join(AUDIO, 'Loop.wav') });
  assert.equal(r3.ok, true);
  assert.equal((await svc.analyze({ path: path.join(AUDIO, 'missing.wav') })).message, `File not found: ${path.join(AUDIO, 'missing.wav')}`);
  assert.match((await svc.analyze({ path: 'relative.wav' })).message!, /not an absolute file path/);
  assert.match((await svc.analyze({ path: path.join(AUDIO, 'notes.txt') })).message!, /is not an audio file/);
  const crash = await svc.analyze({ path: path.join(AUDIO, 'crash.wav') });
  assert.equal(crash.ok, false);
  assert.match(crash.message!, /stopped unexpectedly while analysing audio/);
  await supervisor.stop();
});

test('toPattern mono on a tempo-synced clip: ticks at the source tempo, aligned pattern clip, one undo step', async () => {
  const { doc, svc, addLoop, supervisor } = await rig({ bpm: 140 });
  const { clipId, channelId } = addLoop('Loop.wav', 3840);
  doc.exec('channels.setGenParams', { id: channelId, params: { tempo_sync: 1, src_bpm: 120 } }, { actor: USER });
  doc.exec('playlist.updateClips', { updates: [{ id: clipId, length: 7680, offset: 960 }] }, { actor: USER });
  const before = histLen(doc);
  const src = doc.project.playlist.clips[clipId];
  const srcIdx = doc.project.playlist.trackOrder.indexOf(src.trackId);
  const r = await svc.toPattern({ clipId }, { mode: 'mono', sound: 'synth' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /timed at the clip's source tempo \(120 bpm\)/);
  const p = doc.project;
  assert.equal(histLen(doc), before + 1);
  const pat = p.patterns[r.data!.patternId];
  assert.equal(pat.name, 'Loop notes');
  assert.equal(p.transport.activePatternId, pat.id);
  assert.equal(r.data!.channelIds.length, 1);
  const ch = p.channels[r.data!.channelIds[0]];
  assert.equal(ch.name, 'Loop Lead');
  assert.equal(ch.generator.type, 'krypt.triosc');
  assert.equal(ch.poly.mono, true);
  const notes = Object.values(pat.notes[ch.id]).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(notes.map((n) => [n.tick, n.dur, n.key]), [[0, 480, 60], [960, 960, 64]], '0.5 s at 120 bpm = 960 ticks');
  assert.equal(notes[1].fine, 0, 'notes stay in tune (cents are not applied)');
  const pc = Object.values(p.playlist.clips).find((c) => c.kind === 'pattern' && c.patternId === pat.id)!;
  assert.deepEqual([pc.start, pc.length, pc.offset], [src.start, src.length, src.offset], 'same window as the audio clip');
  assert.equal(p.playlist.trackOrder.indexOf(pc.trackId), srcIdx + 1, 'on a new track right under the clip');
  assert.equal(r.data!.notes, 2);
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(doc.project.patterns[pat.id], undefined);
  assert.equal(doc.project.channels[ch.id], undefined);
  await supervisor.stop();
});

test('toPattern: unsynced clips use the project tempo; poly needs Basic Pitch; empty results change nothing', async () => {
  const { doc, svc, addLoop, supervisor } = await rig({ bpm: 140 });
  const { clipId } = addLoop();
  const r = await svc.toPattern({ clipId }, { mode: 'mono', name: 'Hook' });
  assert.equal(r.ok, true, r.message);
  const p = doc.project;
  const ticks = Object.values(p.patterns[r.data!.patternId].notes[r.data!.channelIds[0]]).map((n) => n.tick).sort((a, b) => a - b);
  assert.deepEqual(ticks, [0, 1120], '0.5 s at 140 bpm = 1120 ticks');
  assert.equal(p.patterns[r.data!.patternId].name, 'Hook');

  const poly = await svc.toPattern({ clipId }, { mode: 'poly' });
  assert.equal(poly.ok, false);
  assert.match(poly.message!, /Polyphonic transcription needs the Basic Pitch model, which isn't installed/);

  const v = doc.version;
  const empty = await svc.toPattern({ path: path.join(AUDIO, 'EmptyVox.wav') }, { mode: 'mono' });
  assert.deepEqual(empty, { ok: false, message: 'No notes were detected in "EmptyVox"' });
  assert.equal(doc.version, v);
  assert.equal((await svc.toPattern({ clipId }, { mode: 'chords' as never })).message, 'mode must be poly, mono or drums');
  await supervisor.stop();
});

test('toPattern poly with Basic Pitch installed → a Keys channel; a file target makes a pattern without a clip', async () => {
  const { doc, svc, supervisor } = await rig({ basicPitch: true });
  const r = await svc.toPattern({ path: path.join(AUDIO, 'Loop.wav') }, { mode: 'poly' });
  assert.equal(r.ok, true, r.message);
  const p = doc.project;
  assert.equal(p.channels[r.data!.channelIds[0]].name, 'Loop Keys');
  assert.ok(!Object.values(p.playlist.clips).some((c) => c.patternId === r.data!.patternId), 'no playlist clip for a file target');
  await supervisor.stop();
});

test('toPattern drums: hits onto existing Kick / Snare / Hat, a new Open Hat from the factory kit, no empty roles', async () => {
  const { doc, svc, addLoop, supervisor } = await rig();
  const { clipId, channelId } = addLoop();
  doc.exec('channels.setGenParams', { id: channelId, params: { tempo_sync: 1, src_bpm: 120 } }, { actor: USER });
  const p0 = doc.project;
  const kick = p0.channelOrder.find((id) => p0.channels[id].name === 'Kick')!;
  const channelsBefore = p0.channelOrder.length;
  const r = await svc.toPattern({ clipId }, { mode: 'drums', sound: 'synth' });
  assert.equal(r.ok, true, r.message);
  const p = doc.project;
  const pat = p.patterns[r.data!.patternId];
  assert.equal(pat.name, 'Loop drums');
  const names = r.data!.channelIds.map((id) => p.channels[id].name);
  assert.deepEqual(names, ['Kick', 'Snare', 'Hat', 'Open Hat']);
  assert.equal(r.data!.channelIds[0], kick, 'existing Kick reused');
  assert.equal(p.channelOrder.length, channelsBefore + 1, 'only Open Hat was created');
  const oh = p.channels[r.data!.channelIds[3]];
  assert.equal(oh.generator.type, 'krypt.sampler');
  assert.equal(p.samples[oh.generator.sampleId!].path, 'factory:drums/hat-open.wav');
  assert.deepEqual([oh.poly.cutGroup, oh.poly.cutBy], [1, 1]);
  const kickTicks = Object.values(pat.notes[kick]).map((n) => n.tick).sort((a, b) => a - b);
  assert.deepEqual(kickTicks, [0, 1920], 'kicks at 0 s and 1 s (120 bpm source tempo)');
  assert.ok(Object.values(pat.notes[kick]).every((n) => n.key === p.channels[kick].rootKey));
  assert.match(r.message!, /5 drum hits on Kick, Snare, Hat and Open Hat/);
  assert.ok(!p.channelOrder.some((id) => p.channels[id].name === 'Perc'));
  await supervisor.stop();
});

test('toPattern plays the notes with the original audio: one region per note, picked by velocity (mono and drums)', async () => {
  const { doc, svc, addLoop, supervisor, userData } = await rig({ bpm: 120 });
  const { clipId } = addLoop();
  const r = await svc.toPattern({ clipId }, { mode: 'mono' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Played by the original audio: every note is its own recording/);
  const p = doc.project;
  const ch = p.channels[r.data!.channelIds[0]];
  assert.equal(ch.generator.type, 'krypt.multisampler');
  assert.equal(ch.poly.mono, true);
  const sfzPath = p.samples[ch.generator.sampleId!].path;
  assert.ok(sfzPath.startsWith(path.join(userData, 'instruments')) && sfzPath.endsWith('mono.sfz'), sfzPath);
  assert.ok(fs.existsSync(path.join(path.dirname(sfzPath), 'source.wav')), 'the source copy sits next to the mapping');
  const sfz = fs.readFileSync(sfzPath, 'utf8');
  assert.equal((sfz.match(/<region>/g) ?? []).length, 2, 'one region per note');
  const notes = Object.values(p.patterns[r.data!.patternId].notes[ch.id]).sort((a, b) => a.tick - b.tick);
  const offsets = notes.map((n) => {
    const v = Math.max(1, Math.round(n.vel * 127));
    const group = sfz.split('<group>').find((g) => new RegExp(`pitch_keycenter=${n.key}\\b`).test(g))!;
    const line = group.split('\n').find((l) => l.startsWith('<region>') && v >= Number(/lovel=(\d+)/.exec(l)![1]) && v <= Number(/hivel=(\d+)/.exec(l)![1]))!;
    return Number(/offset=(\d+)/.exec(line)![1]);
  });
  assert.deepEqual(offsets, [0, Math.round((0.5 - 0.003) * 48000)]);

  const d = await svc.toPattern({ clipId }, { mode: 'drums' });
  assert.equal(d.ok, true, d.message);
  const q = doc.project;
  const names = d.data!.channelIds.map((id) => q.channels[id].name);
  assert.deepEqual(names, ['Loop Kick', 'Loop Snare', 'Loop Hat', 'Loop Open Hat'], 'new channels: the existing Kick plays the factory kit, not this song');
  assert.ok(d.data!.channelIds.every((id) => q.channels[id].generator.type === 'krypt.multisampler'));
  const kicks = Object.values(q.patterns[d.data!.patternId].notes[d.data!.channelIds[0]]).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(kicks.map((n) => [n.tick, n.dur]), [[0, Math.round(0.247 * 1920)], [1920, Math.round(1 * 1920)]], 'each hit lasts until the next hit (0.25 s - 3 ms), the last one to the end of the file');
  await supervisor.stop();
});

await run('analyzer service');
fs.rmSync(TMP, { recursive: true, force: true });
