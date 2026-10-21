// Take lanes + comping (Wave 12.2b): comp algebra, clip materialisation with
// crossfades, every takes.* command through a strict DocHost (undo, integrity),
// cleanup when tracks / channels / patterns go, the loop-take planner and the
// recording finisher that turns a looped take into a take group.

import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, zProject, type Clip, type Project } from '@shared/schema/project';
import {
  clampComp,
  defaultComp,
  eraseComp,
  normalizeComp,
  paintComp,
  planCompClips,
  takesIntegrity,
  type Take,
  type TakeGroup,
} from '@shared/schema/takes';
import { audioTakePasses, isLoopTake, midiTakePasses, MIN_PASS_TICKS } from '@shared/live/takes';
import { defaultCrossfade } from '@shared/commands/takes';
import { DEFAULT_AUDIO_INPUT, DEFAULT_MIDI_SETTINGS, DEFAULT_RECORDING } from '@shared/live/recording';
import type { Settings } from '@shared/types';
import type { EngineEvent, RecordedTake } from '@shared/engine/protocol';
import { LiveInputController } from '../electron/input/liveInput';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import type { MainDeps } from '../electron/mcp/types';
import { buildTrackLanes, laneTakeAt, swipeRange, takeLaneAt, takeLaneCount, takeLaneH } from '../src/panels/playlist/takesLayout';

const BAR = 3840;

function newDoc(): DocHost {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  assert.ok(doc.exec('transport.set', { bpm: 120 }, { actor: USER }).ok);
  return doc;
}
const ok = (doc: DocHost) => assert.deepEqual(checkIntegrity(doc.project), []);
function exec<T = unknown>(doc: DocHost, cmd: string, args: unknown): T {
  const r = doc.exec<T>(cmd, args, { actor: USER });
  assert.ok(r.ok, `${cmd}: ${r.message}`);
  return r.data as T;
}
const seg = (start: number, end: number, takeId: string) => ({ start, end, takeId });
const clipsOn = (p: Project, trackId: string): Clip[] => Object.values(p.playlist.clips).filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);

/** Audio takes for the model tests: 3 passes over the loop [2 bars, 4 bars) at 120 bpm (1920 ticks / s). */
function audioTake(id: string, pass: number, origin: number, start: number, end: number, srcEnd: number): Take {
  return { id, name: `Take ${pass}`, pass, source: { kind: 'audio', channelId: `ch${pass}` }, origin, start, end, srcEnd };
}

// ── Comp algebra ──────────────────────────────────────────────────────

test('paintComp splits the segments it cuts, merges touching segments of one take', () => {
  let c = [seg(0, 100, 'a')];
  c = paintComp(c, 30, 60, 'b');
  assert.deepEqual(c, [seg(0, 30, 'a'), seg(30, 60, 'b'), seg(60, 100, 'a')]);
  c = paintComp(c, 30, 60, 'a');
  assert.deepEqual(c, [seg(0, 100, 'a')], 'painting the same take back merges into one segment');
  c = paintComp(c, 90, 150, 'c');
  assert.deepEqual(c, [seg(0, 90, 'a'), seg(90, 150, 'c')]);
  assert.deepEqual(eraseComp(c, 50, 120), [seg(0, 50, 'a'), seg(120, 150, 'c')]);
  assert.deepEqual(normalizeComp([seg(50, 80, 'b'), seg(0, 50, 'a'), seg(40, 60, 'c'), seg(5, 5, 'x')]), [seg(0, 40, 'a'), seg(40, 60, 'c'), seg(60, 80, 'b')]);
  assert.deepEqual(paintComp(c, 10, 10, 'z'), c, 'an empty range changes nothing');
});

test('defaultComp: the last take wherever it was recorded, earlier ones fill the rest', () => {
  const takes = [audioTake('t1', 1, 9600, 9600, 15360, 30000), audioTake('t2', 2, 0, 7680, 15360, 30000), audioTake('t3', 3, -7680, 7680, 11520, 11520)];
  assert.deepEqual(defaultComp(takes), [seg(7680, 11520, 't3'), seg(11520, 15360, 't2')]);
  assert.deepEqual(defaultComp(takes, 'first'), [seg(7680, 9600, 't2'), seg(9600, 15360, 't1')]);
  const g = { takes: Object.fromEntries(takes.map((t) => [t.id, t])), start: 7680, end: 15360 };
  assert.deepEqual(clampComp(g, [seg(0, 20000, 't3'), seg(5000, 6000, 'gone')]), [seg(7680, 11520, 't3')], 'clamped to where the take was recorded; unknown takes dropped');
});

test('planCompClips: centred crossfades, one-sided where a take has no audio past the cut, hard cuts at 0', () => {
  const t1 = audioTake('t1', 1, 7680, 7680, 15360, 26880);
  const t2 = audioTake('t2', 2, 0, 7680, 15360, 19200);
  const t3 = audioTake('t3', 3, -7680, 7680, 11520, 11520);
  const takes = { t1, t2, t3 };
  // t1 → t2 at 9600: both have audio around the cut → centred 40-tick crossfade.
  let plan = planCompClips({ takes, crossfade: 40, comp: [seg(7680, 9600, 't1'), seg(9600, 15360, 't2')] });
  assert.deepEqual(plan, [
    { takeId: 't1', start: 7680, length: 9620 - 7680, offset: 0, fadeIn: 0, fadeOut: 40 },
    { takeId: 't2', start: 9580, length: 15360 - 9580, offset: 9580, fadeIn: 40, fadeOut: 0 },
  ]);
  // t3 → t2 at 11520: t3 (the last pass) ends exactly there → t2 starts the whole crossfade early.
  plan = planCompClips({ takes, crossfade: 40, comp: [seg(7680, 11520, 't3'), seg(11520, 15360, 't2')] });
  assert.equal(plan[0].start + plan[0].length, 11520);
  assert.equal(plan[0].fadeOut, 40);
  assert.equal(plan[0].offset, 7680 + 7680, 'offset = clip start − origin');
  assert.deepEqual([plan[1].start, plan[1].fadeIn, plan[1].offset], [11480, 40, 11480]);
  // Short segments cap the crossfade at half their length; 0 = hard cuts.
  plan = planCompClips({ takes, crossfade: 400, comp: [seg(7680, 9600, 't1'), seg(9600, 9660, 't2'), seg(9660, 15360, 't1')] });
  assert.ok(plan.every((c) => c.fadeIn + c.fadeOut <= c.length), JSON.stringify(plan));
  // The long neighbours carry the crossfade; the 60-tick segment only lends 30 ticks to each side.
  assert.deepEqual([plan[1].start, plan[1].length, plan[1].fadeIn, plan[1].fadeOut], [9600 - 370, 60 + 370 + 370, 400, 400]);
  assert.deepEqual([plan[0].start + plan[0].length, plan[2].start], [9630, 9630]);
  plan = planCompClips({ takes, crossfade: 0, comp: [seg(7680, 9600, 't1'), seg(9600, 15360, 't2')] });
  assert.deepEqual(plan.map((c) => [c.start, c.length, c.fadeIn, c.fadeOut]), [[7680, 1920, 0, 0], [9600, 5760, 0, 0]]);
  // A gap: no crossfade across silence.
  plan = planCompClips({ takes, crossfade: 40, comp: [seg(7680, 9000, 't1'), seg(9600, 15360, 't2')] });
  assert.deepEqual(plan.map((c) => [c.fadeIn, c.fadeOut]), [[0, 0], [0, 0]]);
});

// ── Commands through DocHost ──────────────────────────────────────────

/** A 3-pass audio loop recording: loop [2 bars, 4 bars) = 4 s, stopped 2 s into pass 3; 10 s file. */
function recordAudioGroup(doc: DocHost, extra: Record<string, unknown> = {}) {
  return exec<{ groupId: string; trackId: string; takeIds: string[]; clipIds: string[]; insertId: string; sampleId: string }>(doc, 'takes.createGroup', {
    name: 'Vocal',
    audio: { path: 'C:/rec/Song take 1.wav', frames: 480000, sampleRate: 48000, channels: 1 },
    passes: [
      { start: 2 * BAR, end: 4 * BAR, sec: 0 },
      { start: 2 * BAR, end: 4 * BAR, sec: 4 },
      { start: 2 * BAR, end: 3 * BAR, sec: 8 },
    ],
    crossfade: 40,
    ...extra,
  });
}

test('createGroup (audio): one sample, one insert, a channel per take, the comp placed as clips', () => {
  const doc = newDoc();
  const before = doc.getHistory().length;
  const chBefore = doc.project.channelOrder.length;
  const r = recordAudioGroup(doc);
  ok(doc);
  const p = doc.project;
  const g = p.takeGroups![r.groupId];
  assert.equal(g.takeOrder.length, 3);
  assert.equal(p.channelOrder.length, chBefore + 3);
  const chans = g.takeOrder.map((id) => g.takes[id].source).map((s) => (s.kind === 'audio' ? p.channels[s.channelId] : null)!);
  assert.ok(chans.every((c) => c.insertId === r.insertId && c.generator.sampleId === r.sampleId && c.generator.type === 'krypt.audioclip'));
  assert.equal(Object.values(p.samples).filter((s) => s.path === 'C:/rec/Song take 1.wav').length, 1);
  const [t1, t2, t3] = g.takeOrder.map((id) => g.takes[id]);
  assert.deepEqual([t1.origin, t2.origin, t3.origin], [7680, 0, -7680], 'origin = pass start − sec at 120 bpm');
  assert.deepEqual([t1.srcEnd, t3.srcEnd], [7680 + 19200, -7680 + 19200]);
  // Default comp: the last take where it exists (bar 3), take 2 for bar 4.
  assert.deepEqual(g.comp, [seg(7680, 11520, t3.id), seg(11520, 15360, t2.id)]);
  const clips = clipsOn(p, r.trackId);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map((c) => [c.kind, c.start, c.offset, c.fadeIn, c.fadeOut]), [
    ['audio', 7680, 15360, 0, 40],
    ['audio', 11480, 11480, 40, 0],
  ]);
  assert.equal(p.playlist.tracks[r.trackId].name, 'Vocal', 'a new track named after the group');
  assert.equal(doc.getHistory().length, before + 1);
  // Undo removes everything it made.
  assert.ok(doc.undo(USER).ok);
  assert.equal(doc.project.takeGroups, undefined);
  assert.equal(doc.project.channelOrder.length, chBefore);
  ok(doc);
});

test('takes.select: swipe-comp a range splits at the boundaries; whole take; pass N; no-op; undo', () => {
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  const g0 = doc.project.takeGroups![r.groupId];
  const [t1, t2, t3] = g0.takeOrder.map((id) => g0.takes[id]);
  // Bar 3 beats 2–3 from take 1.
  const res = exec<{ changed: boolean }>(doc, 'takes.select', { groupId: r.groupId, takeId: t1.id, start: 8640, end: 10560 });
  assert.equal(res.changed, true);
  let g = doc.project.takeGroups![r.groupId];
  assert.deepEqual(g.comp, [seg(7680, 8640, t3.id), seg(8640, 10560, t1.id), seg(10560, 11520, t3.id), seg(11520, 15360, t2.id)]);
  let clips = clipsOn(doc.project, r.trackId);
  assert.equal(clips.length, 4);
  for (const c of clips) {
    const take = Object.values(g.takes).find((t) => t.source.kind === 'audio' && t.source.channelId === c.channelId)!;
    assert.equal(c.offset, c.start - take.origin, 'every clip plays its take at the right file position');
    assert.ok(c.fadeIn! + c.fadeOut! <= c.length);
  }
  assert.deepEqual(clips.map((c) => [c.start, c.fadeIn, c.fadeOut]), [[7680, 0, 40], [8620, 40, 40], [10540, 40, 40], [11480, 40, 0]]);
  ok(doc);
  // The same pick again: nothing changes, no history entry.
  const h = doc.getHistory().length;
  assert.equal(exec<{ changed: boolean }>(doc, 'takes.select', { groupId: r.groupId, takeId: t1.id, start: 8640, end: 10560 }).changed, false);
  assert.equal(doc.getHistory().length, h);
  // "Take from pass 1": the whole take.
  exec(doc, 'takes.select', { groupId: r.groupId, pass: 1 });
  g = doc.project.takeGroups![r.groupId];
  assert.deepEqual(g.comp, [seg(7680, 15360, t1.id)]);
  clips = clipsOn(doc.project, r.trackId);
  assert.deepEqual(clips.map((c) => [c.start, c.length, c.offset]), [[7680, 7680, 0]]);
  // Clamped to where the take was recorded: take 3 only covers bar 3.
  exec(doc, 'takes.select', { groupId: r.groupId, pass: 3, start: 0, end: 99999 });
  assert.deepEqual(doc.project.takeGroups![r.groupId].comp, [seg(7680, 11520, t3.id), seg(11520, 15360, t1.id)]);
  // Errors are human.
  const bad = doc.exec('takes.select', { groupId: r.groupId, pass: 9 }, { actor: USER });
  assert.ok(!bad.ok && /no take from pass 9/.test(bad.message!), bad.message);
  const out = doc.exec('takes.select', { groupId: r.groupId, pass: 3, start: 13000, end: 14000 }, { actor: USER });
  assert.ok(!out.ok && /wasn't recorded in that range/.test(out.message!), out.message);
  // Undo the last comp edit → the previous comp and clips come back.
  assert.ok(doc.undo(USER).ok);
  assert.deepEqual(doc.project.takeGroups![r.groupId].comp, [seg(7680, 15360, t1.id)]);
  assert.equal(clipsOn(doc.project, r.trackId).length, 1);
  ok(doc);
});

test('takes.setCrossfade: 0 = hard cuts; same value = no change', () => {
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  assert.equal(exec<{ changed: boolean }>(doc, 'takes.setCrossfade', { groupId: r.groupId, ticks: 40 }).changed, false);
  exec(doc, 'takes.setCrossfade', { groupId: r.groupId, ticks: 0 });
  const clips = clipsOn(doc.project, r.trackId);
  assert.deepEqual(clips.map((c) => [c.start, c.length, c.fadeIn, c.fadeOut]), [[7680, 3840, 0, 0], [11520, 3840, 0, 0]]);
  ok(doc);
  assert.equal(defaultCrossfade(120), 38, '20 ms at 120 bpm');
});

test('takes.moveTake reorders lanes; edges are refused with a message', () => {
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  exec(doc, 'takes.moveTake', { groupId: r.groupId, pass: 3, direction: 'up' });
  const g = doc.project.takeGroups![r.groupId];
  assert.deepEqual(g.takeOrder.map((id) => g.takes[id].pass), [1, 3, 2]);
  const e = doc.exec('takes.moveTake', { groupId: r.groupId, pass: 1, direction: 'up' }, { actor: USER });
  assert.ok(!e.ok && /already the top lane/.test(e.message!));
  ok(doc);
});

test('takes.removeTake: the latest other take fills in; its channel goes; last take removes the group', () => {
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  const g0 = doc.project.takeGroups![r.groupId];
  const [t1, t2, t3] = g0.takeOrder.map((id) => g0.takes[id]);
  const ch3 = (t3.source as { channelId: string }).channelId;
  exec(doc, 'takes.removeTake', { groupId: r.groupId, takeId: t3.id });
  let g = doc.project.takeGroups![r.groupId];
  assert.deepEqual(g.comp, [seg(7680, 15360, t2.id)], 'take 2 (the latest left) fills bar 3');
  assert.equal(doc.project.channels[ch3], undefined);
  assert.deepEqual(clipsOn(doc.project, r.trackId).map((c) => [c.start, c.length]), [[7680, 7680]]);
  ok(doc);
  exec(doc, 'takes.removeTake', { groupId: r.groupId, pass: 2 });
  g = doc.project.takeGroups![r.groupId];
  assert.deepEqual(g.comp, [seg(7680, 15360, t1.id)]);
  const r2 = exec<{ groupRemoved: boolean }>(doc, 'takes.removeTake', { groupId: r.groupId, pass: 1 });
  assert.equal(r2.groupRemoved, true);
  assert.equal(doc.project.takeGroups, undefined);
  assert.equal(clipsOn(doc.project, r.trackId).length, 0);
  ok(doc);
  // Undo all three.
  for (let i = 0; i < 3; i++) assert.ok(doc.undo(USER).ok);
  assert.equal(doc.project.takeGroups![r.groupId].takeOrder.length, 3);
  ok(doc);
});

test('takes.flatten keeps the comp clips, drops unused takes and the lanes', () => {
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  const g0 = doc.project.takeGroups![r.groupId];
  const [t1] = g0.takeOrder.map((id) => g0.takes[id]);
  const clipsBefore = clipsOn(doc.project, r.trackId).map((c) => c.id);
  const res = exec<{ kept: number; removed: number }>(doc, 'takes.flatten', { groupId: r.groupId });
  assert.deepEqual(res, { kept: 2, removed: 1 });
  assert.equal(doc.project.takeGroups, undefined);
  assert.deepEqual(clipsOn(doc.project, r.trackId).map((c) => c.id), clipsBefore, 'the comp is untouched');
  assert.equal(doc.project.channels[(t1.source as { channelId: string }).channelId], undefined, 'take 1 was unused');
  ok(doc);
  assert.ok(!doc.exec('takes.select', { groupId: r.groupId, pass: 1 }, { actor: USER }).ok);
});

test('createGroup (MIDI): a pattern per pass, notes relative to the span, comp as pattern clips', () => {
  const doc = newDoc();
  const ch = doc.project.channelOrder[5];
  const note = (tick: number, key: number) => ({ channelId: ch, tick, dur: 480, key, vel: 0.8 });
  const r = exec<{ groupId: string; trackId: string; takeIds: string[] }>(doc, 'takes.createGroup', {
    name: 'Keys',
    trackId: doc.project.playlist.trackOrder[2],
    passes: [
      { start: BAR, end: 3 * BAR, notes: [note(BAR + 960, 60)] },
      { start: BAR, end: 3 * BAR, notes: [note(BAR, 62), note(3 * BAR - 100, 64)] },
    ],
  });
  ok(doc);
  const p = doc.project;
  const g = p.takeGroups![r.groupId];
  const pats = g.takeOrder.map((id) => g.takes[id].source).map((s) => (s.kind === 'pattern' ? p.patterns[s.patternId] : null)!);
  assert.deepEqual(pats.map((x) => x.length), [2 * BAR, 2 * BAR]);
  const n2 = Object.values(pats[1].notes[ch]).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(n2.map((n) => [n.tick, n.key, n.dur]), [[0, 62, 480], [2 * BAR - 100, 64, 100]], 'relative ticks; durations kept inside the pattern');
  let clips = clipsOn(p, r.trackId);
  assert.deepEqual(clips.map((c) => [c.kind, c.patternId, c.start, c.length, c.offset]), [['pattern', pats[1].id, BAR, 2 * BAR, 0]]);
  exec(doc, 'takes.select', { groupId: r.groupId, pass: 1, start: 2 * BAR, end: 3 * BAR });
  clips = clipsOn(doc.project, r.trackId);
  assert.deepEqual(clips.map((c) => [c.patternId, c.start, c.length, c.offset, c.fadeIn]), [
    [pats[1].id, BAR, BAR, 0, undefined],
    [pats[0].id, 2 * BAR, BAR, BAR, undefined],
  ]);
  ok(doc);
});

test('removing the track, a take channel or a take pattern cleans the take groups (integrity holds)', () => {
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  const g0 = doc.project.takeGroups![r.groupId];
  const ch2 = (g0.takes[g0.takeOrder[1]].source as { channelId: string }).channelId;
  exec(doc, 'channels.remove', { ids: [ch2] });
  const g = doc.project.takeGroups![r.groupId];
  assert.equal(g.takeOrder.length, 2);
  assert.ok(g.comp.every((s) => g.takes[s.takeId]), 'its comp segments went with it');
  ok(doc);
  exec(doc, 'playlist.removeTrack', { id: r.trackId });
  assert.equal(doc.project.takeGroups, undefined);
  ok(doc);
  // Pattern takes.
  const ch = doc.project.channelOrder[5];
  const m = exec<{ groupId: string }>(doc, 'takes.createGroup', {
    passes: [
      { start: 0, end: BAR, notes: [{ channelId: ch, tick: 0, dur: 100, key: 60, vel: 1 }] },
      { start: 0, end: BAR, notes: [{ channelId: ch, tick: 10, dur: 100, key: 61, vel: 1 }] },
    ],
  });
  const mg = doc.project.takeGroups![m.groupId];
  exec(doc, 'patterns.remove', { id: (mg.takes[mg.takeOrder[0]].source as { patternId: string }).patternId });
  assert.equal(doc.project.takeGroups![m.groupId].takeOrder.length, 1);
  ok(doc);
});

test('schema: takeGroups round-trip through zod; integrity catches broken comps and dangling refs', () => {
  const doc = newDoc();
  recordAudioGroup(doc);
  const p = JSON.parse(JSON.stringify(doc.project)) as Project;
  assert.ok(zProject.safeParse(p).success);
  assert.deepEqual(takesIntegrity(p), []);
  const g = Object.values(p.takeGroups!)[0] as TakeGroup;
  g.comp = [seg(9000, 12000, g.takeOrder[0]), seg(8000, 9500, g.takeOrder[1]), seg(1, 1, 'nope')];
  g.takeOrder = [...g.takeOrder, 'ghost'];
  g.trackId = 'trk_missing';
  const errs = takesIntegrity(p);
  for (const re of [/missing track/, /takeOrder/, /missing take nope/, /empty comp segment/, /overlap/]) assert.ok(errs.some((e) => re.test(e)), `${re}: ${errs.join(' | ')}`);
  const bad = JSON.parse(JSON.stringify(doc.project));
  bad.takeGroups[Object.keys(bad.takeGroups)[0]].crossfade = -1;
  assert.ok(!zProject.safeParse(bad).success);
});

// ── Loop recording → take group ───────────────────────────────────────

const passes = [
  { startTick: 2 * BAR, endTick: 4 * BAR, sec: 0 },
  { startTick: 2 * BAR, endTick: 4 * BAR, sec: 4 },
  { startTick: 2 * BAR, endTick: 2 * BAR + 500, sec: 8 },
];

test('planner: audio passes under a beat are dropped; MIDI passes need notes; quantize applies', () => {
  assert.ok(isLoopTake({ mode: 'song', passes }));
  assert.ok(!isLoopTake({ mode: 'song', passes: passes.slice(0, 1) }) && !isLoopTake({ mode: 'pattern', passes }));
  assert.deepEqual(audioTakePasses(passes).map((p) => [p.start, p.end, p.sec]), [[7680, 15360, 0], [7680, 15360, 4]]);
  assert.ok(500 < MIN_PASS_TICKS);
  const notes = [
    { channelId: 'a', patternId: null, tick: 7700, dur: 100, key: 60, vel: 1, pass: 0 },
    { channelId: 'a', patternId: null, tick: 15350, dur: 100, key: 61, vel: 1, pass: 0 },
    { channelId: 'gone', patternId: null, tick: 8000, dur: 100, key: 62, vel: 1, pass: 1 },
    { channelId: 'a', patternId: null, tick: 7900, dur: 100, key: 63, vel: 1, pass: 2 },
  ];
  const m = midiTakePasses({ notes, passes }, 240, (id) => id === 'a');
  assert.deepEqual(m.map((p) => p.notes!.map((n) => [n.tick, n.key])), [[[7680, 60], [15359, 61]], [[7920, 63]]], 'quantized, kept inside the pass; pass 1 has no playable notes');
});

function controller() {
  const doc = newDoc();
  const settings = { midi: DEFAULT_MIDI_SETTINGS, recording: { ...DEFAULT_RECORDING, mode: 'both' }, audioInput: DEFAULT_AUDIO_INPUT } as unknown as Settings;
  let emit: (e: EngineEvent) => void = () => {};
  const ctl = new LiveInputController({
    doc,
    engine: {
      request: async () => ({ ok: true, data: { armed: false, state: 'idle', input: null } }),
      onEvent: (cb: (e: EngineEvent) => void) => ((emit = cb), () => {}),
      onStatus: () => () => {},
      status: () => ({ state: 'stopped' as const, device: null, engineVersion: '0', restarts: 0 }),
    } as never,
    getSettings: () => settings,
    updateSettings: () => settings,
    onSettingsChanged: () => () => {},
    recordDir: () => 'C:/proj/recordings',
    projectName: () => 'Song',
    broadcast: () => {},
    log: () => {},
  });
  ctl.start();
  const take = (t: Partial<RecordedTake> & { take: number }) =>
    emit({ event: 'recorded', final: false, mode: 'song', patternId: null, startTick: 2 * BAR, notes: [], audioPending: false, ...t });
  return { doc, ctl, take };
}

test('finisher: a looped MIDI + audio take becomes two take groups in ONE undo step', () => {
  const h = controller();
  const ch = h.doc.project.channelOrder[5];
  const before = h.doc.getHistory().length;
  const groupsBefore = Object.keys(h.doc.project.takeGroups ?? {}).length;
  h.take({
    take: 4,
    audioPending: true,
    passes,
    notes: [
      { channelId: ch, patternId: null, tick: 7700, dur: 200, key: 60, vel: 1, pass: 0 },
      { channelId: ch, patternId: null, tick: 9600, dur: 200, key: 62, vel: 1, pass: 1 },
    ],
  });
  h.take({ take: 4, final: true, passes, audio: { path: 'C:/proj/recordings/Song take 4.wav', frames: 432000, sampleRate: 48000, channels: 1, startTick: 2 * BAR, peak: 0.4 } });
  const p = h.doc.project;
  const groups = Object.values(p.takeGroups ?? {});
  assert.equal(groups.length, groupsBefore + 2);
  const audio = groups.find((g) => g.takes[g.takeOrder[0]].source.kind === 'audio')!;
  const midi = groups.find((g) => g.takes[g.takeOrder[0]].source.kind === 'pattern')!;
  assert.equal(audio.takeOrder.length, 2, 'the 500-tick last pass is dropped');
  assert.equal(midi.takeOrder.length, 2);
  assert.notEqual(audio.trackId, midi.trackId, 'each group on its own free track');
  assert.equal(h.doc.getHistory().length, before + 1, 'one undo step for the whole take');
  const lt = h.ctl.status().lastTake!;
  assert.ok(lt.ok && /2 notes/.test(lt.message) && /2 MIDI takes/.test(lt.message) && /2 audio takes/.test(lt.message), lt.message);
  ok(h.doc);
  assert.ok(h.doc.undo(USER).ok);
  assert.equal(Object.keys(h.doc.project.takeGroups ?? {}).length, groupsBefore);
});

test('finisher: a looped audio take with one usable pass is a plain clip trimmed to that pass', () => {
  const h = controller();
  const ps = [{ startTick: 2 * BAR, endTick: 4 * BAR, sec: 0 }, { startTick: 2 * BAR, endTick: 2 * BAR + 100, sec: 4 }];
  h.take({ take: 1, final: true, passes: ps, audio: { path: 'C:/proj/recordings/Song take 1.wav', frames: 196800, sampleRate: 48000, channels: 1, startTick: 2 * BAR, peak: 0.4 } });
  const clip = Object.values(h.doc.project.playlist.clips).find((c) => c.kind === 'audio')!;
  assert.deepEqual([clip.start, clip.length], [2 * BAR, 2 * BAR]);
  assert.equal(h.doc.project.takeGroups, undefined);
  ok(h.doc);
});

// ── MCP: comp_takes ───────────────────────────────────────────────────

test('comp_takes: lists, picks per bar range, crossfade, delete, flatten; No change when nothing changes', async () => {
  const doc = newDoc();
  const deps = { doc, broadcast: () => {}, log: () => {} } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 't', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (args: unknown) => callTool(deps, caller, 'comp_takes', args, { quiet: true });
  let r = await call({});
  assert.ok(r.ok && /No take groups yet/.test(r.message), r.message);
  const g = recordAudioGroup(doc);
  r = await call({});
  assert.ok(r.ok && /"Vocal" \[tg_/.test(r.message) && /3 audio takes \(take 1 \(bars 3–4\), take 2 \(bars 3–4\), take 3 \(bar 3\)\)/.test(r.message) && /Comp: bar 3: take 3 · bar 4: take 2/.test(r.message) && /crossfade 21 ms/.test(r.message), r.message);
  // Bars 3 and 4 hold the loop; take 1 for bar 3, take 2 already plays bar 4.
  r = await call({ group: 'Vocal', picks: [{ take: 1, bars: '3' }], crossfade_ms: 10 });
  assert.ok(r.ok && /take 1 for bar 3/.test(r.message) && /crossfade 10 ms/.test(r.message), r.message);
  const gg = doc.project.takeGroups![g.groupId];
  assert.deepEqual(gg.comp.map((s) => gg.takes[s.takeId].pass), [1, 2]);
  assert.equal(gg.crossfade, 19);
  const hist = doc.getHistory().length;
  r = await call({ picks: [{ take: 1, bars: '3' }] });
  assert.ok(!r.ok && /^No change:/.test(r.message), r.message);
  assert.equal(doc.getHistory().length, hist);
  r = await call({ group: 'Vocal', take: 9 });
  assert.ok(!r.ok && /no take 9/.test(r.message), r.message);
  r = await call({ delete_take: 3, flatten: true });
  assert.ok(r.ok && /deleted take 3/.test(r.message) && /flattened/.test(r.message) && /lanes are gone/.test(r.message), r.message);
  assert.equal(doc.project.takeGroups, undefined);
  ok(doc);
  // One undo step for the whole call.
  assert.ok(doc.undo({ kind: 'agent', clientId: 't', name: 'Test Agent' }).ok);
  assert.equal(doc.project.takeGroups![g.groupId].takeOrder.length, 3);
});

// ── Playlist take lanes (pure layout) ─────────────────────────────────

test('lane layout: clip rows keep their height, take lanes sit under them, hits map to (track, lane)', () => {
  const l = buildTrackLanes(['a', 'b', 'c'], () => 44, (id) => (id === 'b' ? 3 * 26 : 0));
  assert.deepEqual([l.tops, l.heights, l.extra, l.total], [[0, 44, 166], [44, 44, 44], [0, 78, 0], 210]);
  assert.equal(takeLaneAt(l, 50, 26), null, 'clip row of b');
  assert.deepEqual(takeLaneAt(l, 88, 26), { track: 1, lane: 0 });
  assert.deepEqual(takeLaneAt(l, 88 + 26 * 2 + 25, 26), { track: 1, lane: 2 });
  assert.equal(takeLaneAt(l, 170, 26), null, 'track c');
  assert.equal(takeLaneH(1), 26);
  assert.equal(takeLaneH(0.3), 14, 'never too thin to click');
  assert.deepEqual(swipeRange(1000, 500, 240, false), { start: 480, end: 1200 }, 'snapped outward, either direction');
  assert.deepEqual(swipeRange(500, 1000, 240, true), { start: 500, end: 1000 });
  const doc = newDoc();
  const r = recordAudioGroup(doc);
  assert.equal(takeLaneCount(doc.project, r.trackId), 3);
  assert.equal(laneTakeAt(doc.project, r.trackId, 2, 8000)?.take.pass, 3);
  assert.equal(laneTakeAt(doc.project, r.trackId, 0, 100), null, 'nothing recorded there');
});

await run('takes');
