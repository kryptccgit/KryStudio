// Warp (Wave 12.2, research/16 §2.2): the audio.*Warp* commands keep the
// markers valid (isValidWarp after every command) and undo cleanly;
// planAutoWarp's grid maths; auto-warp in main with a fake analyzer (beat
// grid, tempo-only fallback, no beat, stems on their source mix); the
// warp_clip MCP tool through callTool (one undo group, "No change").
import assert from 'node:assert/strict';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, zProject } from '@shared/schema/project';
import { isValidWarp, secToBeat, type WarpMap } from '@shared/schema/warp';
import { getCommand } from '@shared/commands/registry';
import { modeForHint, planAutoWarp } from '@shared/commands/warp';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { ActionResult, AudioTarget, Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { autoWarpChannel, guessWarpHint } from '../electron/warp/autoWarp';
import { userApply } from '../electron/analyzer/service';
import { beatLabel, clampDragSec, gridLines, snapBeat, warpMapping } from '../src/panels/plugin/warpView';

const FILE = path.join('C:', 'audio', 'Drum Loop.wav');

function rig(opts: { frames?: number; name?: string } = {}) {
  const doc = new DocHost(createDefaultProject('Warp'), CATALOG, { strict: true });
  const r = doc.exec<{ clipId: string; channelId: string; sampleId: string }>(
    'playlist.addAudio',
    { path: opts.name ? path.join('C:', 'audio', `${opts.name}.wav`) : FILE, trackId: doc.project.playlist.trackOrder[0], start: 0, frames: opts.frames ?? 44100 * 8, sampleRate: 44100, channels: 2 },
    { actor: USER },
  );
  assert.ok(r.ok, r.message);
  const ch = r.data!.channelId;
  const exec = <T = unknown>(cmd: string, args: unknown) => doc.exec<T>(cmd, args, { actor: USER });
  const warp = (): WarpMap | undefined => doc.project.channels[ch].generator.warp;
  const valid = () => {
    const w = warp();
    if (w) assert.ok(isValidWarp(w.markers), `markers out of order: ${JSON.stringify(w.markers)}`);
    assert.equal(zProject.safeParse(doc.project).success, true);
    assert.deepEqual(checkIntegrity(doc.project), []);
  };
  return { doc, ch, clipId: r.data!.clipId, sampleId: r.data!.sampleId, exec, warp, valid };
}

// ── Commands ──────────────────────────────────────────────────────────

test('every warp command is registered with a description', () => {
  for (const id of ['audio.setWarpMode', 'audio.addWarpMarker', 'audio.moveWarpMarker', 'audio.removeWarpMarker', 'audio.clearWarp', 'audio.setWarpOptions', 'audio.autoWarp']) {
    const c = getCommand(id);
    assert.ok(c, id);
    assert.ok(c.description.length > 40, id);
  }
});

test('setWarpMode creates the map; options clamp and reset; undo restores "not warped"', () => {
  const { ch, exec, warp, valid, doc } = rig();
  assert.equal(warp(), undefined);
  assert.ok(exec('audio.setWarpMode', { channelId: ch, mode: 'beats' }).ok);
  assert.deepEqual(warp(), { mode: 'beats', markers: [] });
  valid();
  assert.ok(exec('audio.setWarpOptions', { channelId: ch, beatsSlice: '1/8', beatsFadeMs: 999, grainMs: 1, flux: 0.5 }).ok);
  assert.deepEqual({ ...warp(), markers: undefined }, { mode: 'beats', markers: undefined, beatsSlice: '1/8', beatsFadeMs: 200, grainMs: 10, flux: 0.5 });
  valid();
  assert.ok(exec('audio.setWarpOptions', { channelId: ch, beatsSlice: null, flux: null }).ok);
  assert.equal(warp()!.beatsSlice, undefined);
  assert.equal(warp()!.flux, undefined);
  valid();
  doc.undo(USER);
  doc.undo(USER);
  doc.undo(USER);
  assert.equal(warp(), undefined, 'three undos = back to no warp map');
  assert.equal(exec('audio.setWarpMode', { channelId: doc.project.channelOrder[0], mode: 'tones' }).ok, false, 'only audio clip channels');
});

test('add keeps markers sorted; crossing / duplicate / past-the-end adds are refused with the neighbour named', () => {
  const { ch, exec, warp, valid } = rig();
  const a = exec<{ id: string }>('audio.addWarpMarker', { channelId: ch, sec: 2, beat: 4 });
  assert.ok(a.ok);
  valid();
  assert.equal(warp()!.mode, 'complex', 'default mode');
  assert.ok(exec('audio.addWarpMarker', { channelId: ch, sec: 0.5, beat: 1 }).ok);
  assert.ok(exec('audio.addWarpMarker', { channelId: ch, sec: 4, beat: 8 }).ok);
  valid();
  assert.deepEqual(warp()!.markers.map((m) => m.beat), [1, 4, 8]);
  const cross = exec('audio.addWarpMarker', { channelId: ch, sec: 3, beat: 2 });
  assert.equal(cross.ok, false);
  assert.match(cross.message!, /beat must be after the previous marker's \(beat 4 at 2 s\)/);
  const dup = exec('audio.addWarpMarker', { channelId: ch, sec: 2, beat: 5 });
  assert.equal(dup.ok, false);
  assert.match(dup.message!, /cross/);
  const past = exec('audio.addWarpMarker', { channelId: ch, sec: 8, beat: 20 });
  assert.equal(past.ok, false);
  assert.match(past.message!, /past the end of .* \(8 s long\)/);
  valid();
  assert.equal(warp()!.markers.length, 3, 'refusals change nothing');
});

test('move: sec re-pins the audio (beat stays); crossing a neighbour is refused, never clamped; remove + clear; undo', () => {
  const { ch, exec, warp, valid, doc } = rig();
  for (const [sec, beat] of [[0, 0], [2, 4], [4, 8]]) exec('audio.addWarpMarker', { channelId: ch, sec, beat });
  const mid = warp()!.markers[1];
  assert.ok(exec('audio.moveWarpMarker', { channelId: ch, markerId: mid.id, sec: 2.2 }).ok);
  assert.deepEqual([warp()!.markers[1].sec, warp()!.markers[1].beat], [2.2, 4], 'beat stays when only sec moves');
  valid();
  const bad = exec('audio.moveWarpMarker', { channelId: ch, markerId: mid.id, sec: 4.5 });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /would cross the next marker \(beat 8 at 4 s\)/);
  assert.equal(warp()!.markers[1].sec, 2.2, 'refused, not clamped');
  const badBeat = exec('audio.moveWarpMarker', { channelId: ch, markerId: mid.id, beat: 0 });
  assert.equal(badBeat.ok, false);
  assert.ok(exec('audio.moveWarpMarker', { channelId: ch, markerId: mid.id, beat: 5, sec: 2.5 }).ok);
  valid();
  assert.equal(exec('audio.moveWarpMarker', { channelId: ch, markerId: 'wm-nope', sec: 1 }).ok, false);
  assert.ok(exec('audio.removeWarpMarker', { channelId: ch, markerId: mid.id }).ok);
  assert.equal(warp()!.markers.length, 2);
  valid();
  doc.undo(USER);
  assert.equal(warp()!.markers.length, 3, 'undo brings the marker back');
  assert.deepEqual([warp()!.markers[1].sec, warp()!.markers[1].beat], [2.5, 5]);
  valid();
  const c = exec<{ removed: number }>('audio.clearWarp', { channelId: ch });
  assert.equal(c.data!.removed, 3);
  assert.deepEqual(warp(), { mode: 'complex', markers: [] }, 'clear keeps the mode');
  assert.equal(exec('audio.clearWarp', { channelId: ch }).ok, false, 'nothing to clear');
  assert.ok(exec('audio.clearWarp', { channelId: ch, all: true }).ok);
  assert.equal(warp(), undefined);
  assert.equal(exec('audio.clearWarp', { channelId: ch, all: true }).ok, false);
  valid();
});

// ── Auto-warp maths ───────────────────────────────────────────────────

const grid = (bpm: number, n: number, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + (i * 60) / bpm);

test('planAutoWarp: bar markers on bar lines, the last beat pinned, source tempo from the markers', () => {
  const p = planAutoWarp({ beatTimes: grid(120, 16, 0.01), every: 'bar', projectBpm: 120, barQuarters: 4 });
  assert.deepEqual(p.markers.map((m) => m.beat), [0, 4, 8, 12, 15]);
  assert.ok(Math.abs(p.srcBpm - 120) < 1e-6);
  assert.equal(p.beatUnit, 1);
  const beats = planAutoWarp({ beatTimes: grid(120, 8), every: 'beat', projectBpm: 120, barQuarters: 4 });
  assert.deepEqual(beats.markers.map((m) => m.beat), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('planAutoWarp: a pickup before the downbeat shifts the grid by whole bars; downbeat on a bar line', () => {
  // Beats at 0.25 s steps from 0.1 s; the downbeat is the 3rd beat (index 2): 2 beats + a bit of pickup.
  const p = planAutoWarp({ beatTimes: grid(240, 12, 0.1), downbeatIndex: 2, every: 'beat', projectBpm: 240, barQuarters: 4 });
  const db = p.markers.find((m) => Math.abs(m.sec - (0.1 + 0.5)) < 1e-9)!;
  assert.equal(db.beat % 4, 0, 'the downbeat sits on a bar line');
  assert.equal(db.beat, 4);
  assert.equal(p.markers[0].beat, 2, 'the pickup beats keep positive beats');
  assert.ok(isValidWarp(p.markers.map((m, i) => ({ id: String(i), ...m }))));
});

test('planAutoWarp: half-time tracking keeps the loop speed (beatUnit 2); noisy, unsorted input is cleaned', () => {
  const p = planAutoWarp({ beatTimes: grid(70, 9), every: 'bar', beatsPerBar: 4, projectBpm: 140, barQuarters: 4 });
  assert.equal(p.beatUnit, 2);
  assert.ok(Math.abs(p.srcBpm - 140) < 1e-6, `${p.srcBpm}`);
  assert.deepEqual(p.markers.map((m) => m.beat), [0, 8, 16]);
  const messy = planAutoWarp({ beatTimes: [1.5, 0.5, 1, 1.0004, 2, -1, NaN, 9], every: 'beat', projectBpm: 120, barQuarters: 4, durationSec: 4 });
  assert.deepEqual(messy.markers.map((m) => m.sec), [0.5, 1, 1.5, 2]);
  assert.throws(() => planAutoWarp({ beatTimes: [1], projectBpm: 120, barQuarters: 4 }), /at least 2 beats/);
  assert.equal(modeForHint('drums'), 'beats');
  assert.equal(modeForHint('mono'), 'tones');
  assert.equal(modeForHint('mix'), 'complex');
  assert.equal(modeForHint(undefined), 'complex');
});

test('audio.autoWarp: replaces markers, sets the mode from the hint, makes the Stretch params agree and rescales the clip; one undo', () => {
  const { ch, clipId, exec, warp, valid, doc } = rig();
  doc.exec('transport.set', { bpm: 120 }, { actor: USER });
  exec('audio.addWarpMarker', { channelId: ch, sec: 1, beat: 1 });
  const len0 = doc.project.playlist.clips[clipId].length;
  const r = exec<{ markers: number; mode: string; srcBpm: number }>('audio.autoWarp', { channelId: ch, beatTimes: grid(100, 13), hint: 'drums' });
  assert.ok(r.ok, r.message);
  assert.equal(r.data!.mode, 'beats');
  assert.equal(r.data!.markers, 4, 'bars at 0, 4, 8 + the last beat (12)');
  assert.equal(warp()!.mode, 'beats');
  assert.equal(warp()!.markers.length, 4);
  const g = doc.project.channels[ch].generator.params;
  assert.equal(g.tempo_sync, 1);
  assert.ok(Math.abs(g.src_bpm - 100) < 0.01, `src_bpm ${g.src_bpm}`);
  assert.equal(g.stretch, 1);
  const len1 = doc.project.playlist.clips[clipId].length;
  assert.ok(Math.abs(len1 / len0 - 100 / 120) < 0.01, `clip rescaled like a tempo-sync change (${len0} → ${len1})`);
  // The marker map and the Stretch params agree: beat 8 lands where 100 bpm puts it.
  assert.ok(Math.abs(secToBeat(warp()!.markers, 4.8)! - 8) < 1e-9);
  valid();
  doc.undo(USER);
  assert.equal(warp()!.markers.length, 1, 'one undo restores the hand marker');
  assert.equal(doc.project.playlist.clips[clipId].length, len0);
  const tooFew = exec('audio.autoWarp', { channelId: ch, beatTimes: [9, 10] });
  assert.equal(tooFew.ok, false, 'beats past the 8 s file are dropped');
  assert.match(tooFew.message!, /at least 2 beats/);
});

// ── Auto-warp in main (fake analyzer) ─────────────────────────────────

function analysis(over: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    path: FILE,
    durationSec: 8,
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: 120, confidence: 0.9, alternatives: [60, 240] },
    beats: { times: grid(120, 16, 0.02), downbeats: [0.02, 2.02, 4.02, 6.02], beatsPerBar: 4 },
    key: null,
    swing: null,
    sections: [],
    levels: {} as AudioAnalysis['levels'],
    stereo: { width: 0.3, correlation: 0.8 },
    energy: { hopSec: 0.5, lufs: [] },
    onsetRate: 5,
    estimated: ['tempo', 'beats'],
    sources: ['stratum-dsp 1.0', 'beat-this small'],
    ...over,
  };
}

function fakeAnalyzer(byTarget: (t: AudioTarget) => ActionResult<AudioAnalysis>) {
  const calls: AudioTarget[] = [];
  return { calls, analyze: async (t: AudioTarget) => (calls.push(t), byTarget(t)) };
}

test('autoWarpChannel: beat grid from the beat model, mode guessed (drum loop → beats), one user undo step', async () => {
  const { doc, ch, warp, valid } = rig();
  const an = fakeAnalyzer(() => ({ ok: true, data: analysis() }));
  const r = await autoWarpChannel({ doc, analyzer: an }, ch, {}, userApply(doc));
  assert.ok(r.ok, r.message);
  assert.equal(r.data!.mode, 'beats');
  assert.equal(r.data!.hint, 'drums');
  assert.equal(r.data!.markers, 5);
  assert.match(r.message!, /Warped "Drum Loop": 5 markers \(every bar\), beats mode for drums, 120 → 140 bpm\. Beats from the Beat This! beat model\./);
  assert.equal(warp()!.markers[0].beat, 0);
  valid();
  const entries = doc.getHistory().filter((h) => !h.undone);
  doc.undo(USER);
  assert.equal(warp(), undefined);
  assert.ok(entries.length >= 2);
});

test('autoWarpChannel: tempo-only fallback warns; no beat and no analyzer fail with how to warp by hand', async () => {
  const { doc, ch, warp } = rig({ name: 'Pad Swell' });
  const tempoOnly = fakeAnalyzer(() => ({ ok: true, data: analysis({ beats: null, sources: ['stratum-dsp 1.0'], key: { tonic: 'C', mode: 'minor', name: 'Cm', confidence: 0.6 } }) }));
  const r = await autoWarpChannel({ doc, analyzer: tempoOnly }, ch, { every: 'beat' }, userApply(doc));
  assert.ok(r.ok, r.message);
  assert.equal(r.data!.mode, 'complex');
  assert.equal(r.data!.markers, 16);
  assert.match(r.data!.warning!, /only a tempo/);
  assert.match(r.message!, /detected tempo \(120 bpm\) only/);
  const none = fakeAnalyzer(() => ({ ok: true, data: analysis({ beats: null, tempo: null }) }));
  const n = await autoWarpChannel({ doc, analyzer: none }, ch, {}, userApply(doc));
  assert.equal(n.ok, false);
  assert.match(n.message!, /No steady beat was found in "Pad Swell".*double-click the waveform/);
  const off = await autoWarpChannel({ doc, analyzer: null }, ch, {}, userApply(doc));
  assert.equal(off.ok, false);
  assert.match(off.message!, /needs the audio analyzer/);
  const failing = fakeAnalyzer(() => ({ ok: false, message: 'The audio file is missing' }));
  const f = await autoWarpChannel({ doc, analyzer: failing }, ch, {}, userApply(doc));
  assert.equal(f.ok, false);
  assert.match(f.message!, /Couldn't auto-warp "Pad Swell": The audio file is missing/);
  assert.equal(warp()!.markers.length, 16, 'failures leave the last warp alone');
});

test('autoWarpChannel: a stem is tracked on its source mix; the vocal stem gets tones', async () => {
  const { doc, ch, sampleId } = rig({ name: 'Song' });
  const stemPath = path.join('C:', 'stems', 'vocals.wav');
  const s = doc.exec<{ channelIds: string[] }>('audio.addStems', { clipId: Object.keys(doc.project.playlist.clips)[0], model: 'htdemucs', stems: [{ stem: 'vocals', path: stemPath, frames: 44100 * 8, sampleRate: 44100 }] }, { actor: USER });
  assert.ok(s.ok, s.message);
  const stemCh = s.data!.channelIds[0];
  const an = fakeAnalyzer(() => ({ ok: true, data: analysis() }));
  const r = await autoWarpChannel({ doc, analyzer: an }, stemCh, {}, userApply(doc));
  assert.ok(r.ok, r.message);
  assert.equal(r.data!.mode, 'tones');
  assert.deepEqual(an.calls[0], { path: doc.project.samples[sampleId].path });
  assert.match(r.message!, /on its source mix "Song"/);
  assert.equal(guessWarpHint(doc.project, doc.project.channels[ch], null), 'mix');
});

// ── UI maths (src/panels/plugin/warpView.ts) ──────────────────────────

test('warpView: mapping from markers or the Stretch rate, grid lines, drag clamp, snapping, labels', () => {
  const ms = [
    { id: 'a', sec: 0.5, beat: 0 },
    { id: 'b', sec: 2.5, beat: 4 },
  ];
  const m = warpMapping(ms, 999);
  assert.equal(m.warped, true);
  assert.equal(m.beatAt(1.5), 2);
  assert.equal(m.secAt(8), 4.5, 'extrapolates with the edge segment');
  const one = warpMapping([{ id: 'a', sec: 1, beat: 4 }], 120);
  assert.equal(one.warped, false);
  assert.equal(one.beatAt(1), 4, 'one marker shifts the Stretch rate');
  assert.equal(one.beatAt(1.5), 5);
  assert.equal(warpMapping([], 60).beatAt(2), 2);
  const lines = gridLines(m, 4.5, 800, 4);
  assert.deepEqual(lines.filter((l) => l.bar).map((l) => l.beat), [0, 4, 8]);
  assert.equal(lines.length, 9);
  assert.ok(Math.abs(lines[1].x - (1 / 4.5) * 800) < 1e-9);
  assert.deepEqual(gridLines(m, 4.5, 30, 4).map((l) => l.beat), [0, 4, 8], 'too dense for beats: bars only');
  assert.equal(clampDragSec(ms, 0, 3, 8), 2.499);
  assert.equal(clampDragSec(ms, 1, 0.1, 8), 0.501);
  assert.equal(clampDragSec(ms, 1, 9, 8), 7.999);
  assert.equal(snapBeat(3.13), 3.25);
  assert.equal(beatLabel(0, 4), '1.1');
  assert.equal(beatLabel(5, 4), '2.2');
  assert.equal(beatLabel(5.5, 4), '2.2.50');
  assert.equal(beatLabel(6, 3), '3.1');
});

// ── warp_clip (MCP) ───────────────────────────────────────────────────

const SETTINGS = { mcp: { fileAccess: 'anywhere' } } as unknown as Settings;

function mcpRig(an?: ReturnType<typeof fakeAnalyzer>) {
  const r = rig();
  const deps = {
    doc: r.doc,
    getSettings: () => SETTINGS,
    updateSettings: () => SETTINGS,
    broadcast: () => {},
    log: () => {},
    analyzer: an,
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'warp-agent', name: 'Warp Agent' }, session: newSession(), via: 'test' };
  const call = (args: unknown) => callTool(deps, caller, 'warp_clip', args, { quiet: true });
  return { ...r, call };
}

test('warp_clip: registered as a write tool; auto by clip id is one agent undo group', async () => {
  assert.equal(getTool('warp_clip')?.kind, 'write');
  const { call, clipId, warp, doc, valid } = mcpRig(fakeAnalyzer(() => ({ ok: true, data: analysis() })));
  const r = await call({ clip: clipId, auto: true, every: 'beat' });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /"Drum Loop": auto-warped: 16 markers \(every beat\), beats mode/);
  assert.match(r.message, /Now beats mode \(slices transients, fade 20 ms\), 16 markers \(beat 0 @ 0\.02 s … beat 15 @ 7\.52 s\)\./);
  assert.equal(warp()!.markers.length, 16);
  valid();
  const agent = doc.getHistory().filter((h) => h.actorKey === 'agent:warp-agent' && !h.undone);
  assert.equal(agent.length, 1, 'one history entry for the call');
});

test('warp_clip: hand markers by channel name, mode + options, ordering refusal, "No change", off', async () => {
  const { call, warp, valid } = mcpRig();
  const bad = await call({ clip: 'Drum Loop', markers: [{ sec: 1, beat: 2 }, { sec: 0.5, beat: 3 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /strictly increasing.*marker 2 \(0\.5 s, beat 3\)/);
  const r = await call({ clip: 'Drum Loop', markers: [{ sec: 0.1, beat: 0 }, { sec: 2.1, beat: 4 }], mode: 'texture', options: { grainMs: 120 } });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /2 markers set by hand; texture mode; options grainMs 120\. Now texture mode \(grain 120 ms, flux 0\.2\), 2 markers/);
  valid();
  const same = await call({ clip: 'Drum Loop', mode: 'texture' });
  assert.equal(same.ok, false);
  assert.match(same.message, /^No change:/);
  const again = await call({ clip: 'Drum Loop', markers: [{ sec: 0.2, beat: 0 }, { sec: 2.2, beat: 4 }, { sec: 4.2, beat: 8 }] });
  assert.ok(again.ok);
  assert.deepEqual(warp()!.markers.map((m) => m.sec), [0.2, 2.2, 4.2], 'markers replace the old ones');
  const tooFar = await call({ clip: 'Drum Loop', markers: [{ sec: 1, beat: 0 }, { sec: 9, beat: 4 }] });
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.message, /past the end/);
  assert.equal(warp()!.markers.length, 3, 'a failed call rolls back its partial edits');
  const noAuto = await call({ clip: 'Drum Loop', auto: true });
  assert.equal(noAuto.ok, false);
  assert.match(noAuto.message, /needs the audio analyzer/);
  const off = await call({ clip: 'Drum Loop', mode: 'off' });
  assert.ok(off.ok);
  assert.equal(warp(), undefined);
  assert.match(off.message, /warp removed/);
  const nothing = await call({ clip: 'Drum Loop' });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /Nothing to change/);
  valid();
});

await run('warp');
