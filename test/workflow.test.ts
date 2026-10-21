import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, patternLength, type Clip, type Project } from '@shared/schema/project';
import { PPQ, TICKS_PER_STEP, formatBBT, ticksPerBar } from '@shared/schema/time';
import { beatGroupTicks, formatTimeSig, isCompound, parseTimeSig, stepsPerBar, stepsPerBeatGroup, timeSigProblem, TIME_SIG_PRESETS } from '@shared/schema/meter';
import { symbolicStats } from '@shared/kpn';
import { cleanMarkerName, markerSection, sortedMarkers } from '@shared/commands/markers';
import { clampFades, crossfadePlan, fadeGainAt, previousTouching, DEFAULT_CROSSFADE } from '@shared/commands/fades';
import { bpmFromName, followTempoMessage, loopBpmFor } from '@shared/audio/loopTempo';
import { cleanTemplateName, describeTemplate, findTemplate, parseTemplateIndex, sortTemplates, type ProjectTemplate } from '@shared/templates';
import { snapTicks } from '../src/editors/snap';
import { gridLevels } from '../src/editors/gridPaint';
import { fadeLabel, fadeLenAt, fadeLines, hitFadeHandle, withFade, FADE_ZONE_H } from '../src/panels/playlist/fades';
import { hitMarker, markersWithDrag } from '../src/panels/playlist/markerHits';
import { TemplateError, TemplateStore } from '../electron/project/templates';
import { ProjectService } from '../electron/project/service';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-workflow-'));
const host = (p?: Project) => new DocHost(p ?? createDefaultProject('W'), CATALOG, { strict: true });
const exec = <T = unknown>(d: DocHost, cmd: string, args: unknown) => d.exec<T>(cmd, args, { actor: USER });

test('time signature parsing, presets and validation', () => {
  assert.deepEqual(parseTimeSig('7/8'), { num: 7, den: 8 });
  assert.deepEqual(parseTimeSig(' 12 / 8 '), { num: 12, den: 8 });
  assert.equal(parseTimeSig('4/3'), null, 'bottom must be 2, 4, 8 or 16');
  assert.equal(parseTimeSig('0/4'), null);
  assert.equal(parseTimeSig('33/4'), null);
  assert.equal(parseTimeSig('four/4'), null);
  assert.match(timeSigProblem(4, 5)!, /bottom number/);
  assert.equal(timeSigProblem(5, 4), null);
  assert.equal(formatTimeSig({ num: 6, den: 8 }), '6/8');
  for (const want of ['4/4', '3/4', '6/8', '7/8', '5/4', '12/8']) assert.ok(TIME_SIG_PRESETS.some((p) => formatTimeSig(p) === want), want);
  for (const p of TIME_SIG_PRESETS) assert.equal(timeSigProblem(p.num, p.den), null, formatTimeSig(p));
});

test('bar grouping: compound meters count dotted quarters; steps per bar are 16ths in every meter', () => {
  const cases: Array<[string, number, number, boolean]> = [
    ['4/4', 16, 4, false],
    ['3/4', 12, 4, false],
    ['6/8', 12, 6, true],
    ['12/8', 24, 6, true],
    ['7/8', 14, 2, false],
    ['5/4', 20, 4, false],
    ['2/2', 16, 8, false],
  ];
  for (const [t, steps, group, compound] of cases) {
    const ts = parseTimeSig(t)!;
    assert.equal(stepsPerBar(ts), steps, `${t} steps`);
    assert.equal(stepsPerBeatGroup(ts), group, `${t} group`);
    assert.equal(isCompound(ts), compound, `${t} compound`);
  }
  assert.equal(beatGroupTicks({ num: 6, den: 8 }), 1440);
  assert.equal(isCompound({ num: 3, den: 8 }), false, '3/8 is felt in one: no grouping');
});

test('editor grids: the Step snap and the finest grid line are 16ths in 6/8 and 2/2 too (were 32nds / 8ths)', () => {
  assert.equal(snapTicks('step', { num: 6, den: 8 }), TICKS_PER_STEP);
  assert.equal(snapTicks('step', { num: 2, den: 2 }), TICKS_PER_STEP);
  assert.equal(snapTicks('step', { num: 4, den: 4 }), TICKS_PER_STEP);
  assert.equal(snapTicks('step', { num: 3, den: 16 }), 240, 'a 16th-note beat is its own step');
  assert.equal(snapTicks('bar', { num: 7, den: 8 }), 7 * 480);
  assert.equal(gridLevels(0.1, { num: 6, den: 8 }).step, TICKS_PER_STEP);
  assert.equal(gridLevels(0.1, { num: 6, den: 8 }).bar, 2880);
});

test('transport.set 7/8: patterns are 7 eighths long, BBT counts 7/8 bars, the doc stays valid', () => {
  const d = host();
  const r = exec(d, 'transport.set', { timeSig: { num: 7, den: 8 } });
  assert.equal(r.ok, true);
  const ts = d.project.transport.timeSig;
  assert.equal(ticksPerBar(ts), 3360);
  const pat = d.project.patterns[d.project.patternOrder[0]];
  assert.equal(patternLength(pat, ts), 3360);
  assert.equal(formatBBT(3360, ts), '2:1:000');
  assert.equal(formatBBT(3360 + 480, ts), '2:2:000');
  assert.deepEqual(checkIntegrity(d.project), []);
  assert.equal(exec(d, 'transport.set', { timeSig: { num: 7, den: 6 } }).ok, false, 'denominator 6 is refused');
});

test('a new automation clip is four bars of the project meter (was always 16 quarter notes)', () => {
  const d = host();
  exec(d, 'transport.set', { timeSig: { num: 3, den: 4 } });
  const r = exec<{ clipId: string }>(d, 'automation.create', { target: 'transport/bpm', trackId: d.project.playlist.trackOrder[0] });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.project.playlist.clips[r.data!.clipId].length, 4 * 2880);
});

test('KPN stats name out-of-key notes by 16th step in any meter (3/4 bar 2, beat 2 = step 5, was "2.4")', () => {
  const s = symbolicStats([{ name: 'Lead', notes: [{ tick: 2880 + 960, dur: 240, key: 66, vel: 0.8 }] }], { lengthTicks: 2880 * 2, ts: { num: 3, den: 4 }, key: 'C' });
  assert.ok(s.outOfKeyNotes.some((x) => x.endsWith('@2.5')), s.outOfKeyNotes.join(', '));
});

test('marker commands: rename (trimmed, never empty / same / too long), move, remove; one undo each', () => {
  const d = host();
  const id = exec<{ id: string }>(d, 'playlist.addMarker', { tick: 0, name: 'Marker 1' }).data!.id;
  assert.equal(exec(d, 'playlist.renameMarker', { id, name: '  Big   Chorus ' }).ok, true);
  assert.equal(d.project.playlist.markers[id].name, 'Big Chorus');
  assert.match(exec(d, 'playlist.renameMarker', { id, name: '   ' }).message!, /can't be empty/);
  assert.match(exec(d, 'playlist.renameMarker', { id, name: 'Big Chorus' }).message!, /already called/);
  assert.match(exec(d, 'playlist.renameMarker', { id, name: 'x'.repeat(65) }).message!, /at most 64/);
  assert.match(exec(d, 'playlist.renameMarker', { id: 'mk_nope', name: 'A' }).message!, /not found/);
  assert.equal(exec(d, 'playlist.moveMarker', { id, tick: 3840 * 4 }).ok, true);
  assert.equal(d.project.playlist.markers[id].tick, 3840 * 4);
  assert.equal(exec(d, 'playlist.moveMarker', { id, tick: 3840 * 4 }).ok, false, 'no-op move is refused');
  assert.equal(exec(d, 'playlist.moveMarker', { id, tick: -1 }).ok, false);
  d.undo(USER);
  assert.equal(d.project.playlist.markers[id].tick, 0, 'undo moves it back');
  assert.equal(d.project.playlist.markers[id].name, 'Big Chorus');
  assert.equal(cleanMarkerName(' a  b '), 'a b');
  assert.equal(cleanMarkerName(''), null);
});

test('markerSection: up to the next marker, else the song end, else one bar; sorted by time', () => {
  const mk = (id: string, tick: number, name = id) => ({ id, tick, name });
  const ms = { b: mk('b', 3840 * 8, 'Drop'), a: mk('a', 0, 'Intro'), c: mk('c', 3840 * 16, 'Outro') };
  assert.deepEqual(sortedMarkers(ms).map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(markerSection(ms, 'a', 3840 * 24, 3840), { start: 0, end: 3840 * 8 });
  assert.deepEqual(markerSection(ms, 'c', 3840 * 24, 3840), { start: 3840 * 16, end: 3840 * 24 });
  assert.deepEqual(markerSection(ms, 'c', 0, 3840), { start: 3840 * 16, end: 3840 * 17 }, 'past the song end: one bar');
  assert.equal(markerSection(ms, 'zz', 0, 3840), null);
  const same = { x: mk('x', 960), y: mk('y', 960) };
  const s = markerSection(same, 'x', 3840, 3840)!;
  assert.ok(s.end > s.start, 'two markers on one tick still give a range');
});

test('ruler marker hit-testing covers the flag and the label; drag preview moves only the dragged marker', () => {
  const tv = { scrollTick: 0, pxPerTick: 0.1 };
  const ms = [
    { id: 'a', tick: 0, name: 'Intro' },
    { id: 'b', tick: 960, name: 'Drop' },
  ];
  const w = (n: string) => n.length * 6;
  assert.equal(hitMarker(ms, tv, 2, 4, w)?.id, 'a');
  assert.equal(hitMarker(ms, tv, 40, 4, w)?.id, 'a', 'on the label');
  assert.equal(hitMarker(ms, tv, 97, 4, w)?.id, 'b', 'later markers win where they overlap');
  assert.equal(hitMarker(ms, tv, 40, 20, w), null, 'below the marker band');
  assert.equal(hitMarker(ms, tv, 400, 4, w), null);
  const moved = markersWithDrag(ms, { id: 'b', orig: 960, tick: 3840, downX: 0, moved: true });
  assert.deepEqual(moved.map((m) => m.tick), [0, 3840]);
  assert.deepEqual(markersWithDrag(ms, { id: 'b', orig: 960, tick: 3840, downX: 0, moved: false }).map((m) => m.tick), [0, 960]);
});

const audio = (id: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({ id, trackId: 't', kind: 'audio', start, length, offset: 0, mute: false, color: null, channelId: 'ch', gain: 1, fadeIn: 0, fadeOut: 0, ...extra });

test('clampFades keeps fades inside the clip; the edited side wins', () => {
  assert.deepEqual(clampFades(1000, 300, 200), { fadeIn: 300, fadeOut: 200 });
  assert.deepEqual(clampFades(1000, 900, 400, 'in'), { fadeIn: 900, fadeOut: 100 });
  assert.deepEqual(clampFades(1000, 900, 400, 'out'), { fadeIn: 600, fadeOut: 400 });
  assert.deepEqual(clampFades(1000, -5, Number.NaN), { fadeIn: 0, fadeOut: 0 });
  assert.deepEqual(clampFades(100, 5000, 0), { fadeIn: 100, fadeOut: 0 });
});

test('fadeGainAt matches the engine envelope (linear; the Rust test: fade-in 960 at tick 480 = half gain)', () => {
  const c = audio('a', 0, 7680, { gain: 0.5, fadeIn: 960 });
  assert.equal(fadeGainAt(c, 480), 0.25);
  assert.equal(fadeGainAt(c, 960), 0.5);
  assert.equal(fadeGainAt(c, 0), 0);
  const o = audio('b', 1000, 1000, { fadeOut: 500 });
  assert.equal(fadeGainAt(o, 1750), 0.5);
  assert.equal(fadeGainAt(o, 2000), 0);
});

test('crossfadePlan: overlap, a split (later clip reaches back), no audio before the cut (earlier reaches on), a dip, refusals', () => {
  const ov = crossfadePlan(audio('a', 0, 2000), audio('b', 1500, 2000), 480, null);
  assert.ok(typeof ov !== 'string' && ov.kind === 'overlap' && ov.length === 500 && ov.prev.fadeOut === 500 && ov.next.fadeIn === 500);
  const split = crossfadePlan(audio('a', 0, 1920), audio('b', 1920, 1920, { offset: 1920 }), 480, null);
  assert.ok(typeof split !== 'string');
  assert.equal(split.kind, 'extend-next');
  assert.deepEqual(split.next, { id: 'b', start: 1440, offset: 1440, length: 2400, fadeIn: 480, fadeOut: 0 });
  assert.equal(split.prev.fadeOut, 480);
  const fresh = crossfadePlan(audio('a', 0, 1920, { offset: 0 }), audio('b', 1920, 1920, { offset: 0 }), 480, 4000);
  assert.ok(typeof fresh !== 'string' && fresh.kind === 'extend-prev' && fresh.prev.length === 2400 && fresh.next.start === 1920);
  const dip = crossfadePlan(audio('a', 0, 1920), audio('b', 1920, 1920), 480, 1920);
  assert.ok(typeof dip !== 'string' && dip.kind === 'dip' && dip.prev.fadeOut === 480 && dip.next.fadeIn === 480);
  const short = crossfadePlan(audio('a', 0, 400), audio('b', 400, 4000, { offset: 4000 }), 960, null);
  assert.ok(typeof short !== 'string' && short.length === 200, 'never more than half a clip');
  assert.match(crossfadePlan(audio('a', 0, 100), audio('b', 300, 100), 480, null) as string, /don't touch/);
  assert.match(crossfadePlan(audio('a', 0, 100), { ...audio('b', 100, 100), trackId: 'u' }, 480, null) as string, /different tracks/);
  assert.match(crossfadePlan({ ...audio('a', 0, 100), kind: 'pattern' }, audio('b', 100, 100), 480, null) as string, /audio clips/);
});

function withAudio(): { d: DocHost; clipId: string; trackId: string } {
  const d = host();
  const trackId = d.project.playlist.trackOrder[0];
  const r = exec<{ clipId: string }>(d, 'playlist.addAudio', { path: 'C:\\loops\\x.wav', trackId, start: 0, frames: 48000 * 4, sampleRate: 48000 });
  assert.equal(r.ok, true, r.message);
  return { d, clipId: r.data!.clipId, trackId };
}

test('playlist.setFades clamps, refuses pattern clips; playlist.crossfade on a split clip is one undo step', () => {
  const { d, clipId } = withAudio();
  const len = d.project.playlist.clips[clipId].length;
  const r = exec<{ clamped: number }>(d, 'playlist.setFades', { updates: [{ id: clipId, fadeIn: len, fadeOut: 100 }] });
  assert.equal(r.ok, true);
  assert.equal(r.data!.clamped, 1);
  assert.equal(d.project.playlist.clips[clipId].fadeIn! + d.project.playlist.clips[clipId].fadeOut!, len);
  assert.equal(exec(d, 'playlist.setFades', { updates: [{ id: clipId, fadeIn: 0, fadeOut: 0 }] }).ok, true);
  const trackId = d.project.playlist.clips[clipId].trackId;
  const pat = exec<{ id: string }>(d, 'playlist.addClip', { kind: 'pattern', trackId, start: 3840 * 8, patternId: d.project.patternOrder[0] }).data!.id;
  assert.match(exec(d, 'playlist.setFades', { updates: [{ id: pat, fadeIn: 10 }] }).message!, /Only audio clips/);
  const [left, right] = exec<{ ids: string[] }>(d, 'playlist.splitClip', { id: clipId, at: 3840 }).data!.ids;
  assert.equal(previousTouching(d.project, d.project.playlist.clips[right])?.id, left);
  const before = structuredClone(d.project.playlist.clips);
  const x = exec<{ kind: string; length: number; prevId: string }>(d, 'playlist.crossfade', { id: right });
  assert.equal(x.ok, true, x.message);
  assert.deepEqual(x.data, { kind: 'extend-next', length: DEFAULT_CROSSFADE, prevId: left });
  const R = d.project.playlist.clips[right];
  assert.equal(R.start, 3840 - DEFAULT_CROSSFADE);
  assert.equal(R.offset, 3840 - DEFAULT_CROSSFADE, 'the audio before the cut plays under the fade');
  assert.equal(R.fadeIn, DEFAULT_CROSSFADE);
  assert.equal(d.project.playlist.clips[left].fadeOut, DEFAULT_CROSSFADE);
  assert.deepEqual(checkIntegrity(d.project), []);
  d.undo(USER);
  assert.deepEqual(d.project.playlist.clips, before);
  assert.match(exec(d, 'playlist.crossfade', { id: left }).message!, /No audio clip touches/);
});

test('fade handles: top-corner hit zones, drag lengths that never cross the other fade, the drawn lines', () => {
  const tv = { scrollTick: 0, pxPerTick: 0.1 };
  const c = audio('a', 1000, 4000, { fadeIn: 400, fadeOut: 0 });
  assert.equal(hitFadeHandle(c, tv, 20, 141, 22), 'in');
  assert.equal(hitFadeHandle(c, tv, 20, 498, 22), 'out');
  assert.equal(hitFadeHandle(c, tv, 20, 141, 20 + FADE_ZONE_H + 5), null, 'only near the top edge');
  assert.equal(hitFadeHandle(c, tv, 20, 300, 22), null, 'not between the handles');
  assert.equal(hitFadeHandle({ ...c, kind: 'pattern' }, tv, 20, 141, 22), null);
  assert.equal(fadeLenAt(c, 'in', 2000), 1000);
  assert.equal(fadeLenAt(c, 'in', 500), 0, 'never negative');
  assert.equal(fadeLenAt({ ...c, fadeOut: 3000 }, 'in', 4800), 1000, 'stops at the fade-out');
  assert.equal(fadeLenAt(c, 'out', 4000), 1000);
  assert.equal(withFade(c, 'out', 77).fadeOut, 77);
  const L = fadeLines({ ...c, fadeOut: 1000 }, tv);
  assert.deepEqual(L.fadeIn, { x0: 100, x1: 140 });
  assert.deepEqual(L.fadeOut, { x0: 400, x1: 500 });
  assert.equal(fadeLines({ ...c, fadeIn: 0 }, tv).fadeIn, null);
  assert.equal(fadeLabel(480, PPQ), '0.5 beats');
  assert.equal(fadeLabel(960, PPQ), '1 beat');
  assert.equal(fadeLabel(0, PPQ), 'No fade');
});

test('bpmFromName reads tempos written in file names; one-shots and keys are not tempos', () => {
  const cases: Array<[string, number | null]> = [
    ['loop_128bpm.wav', 128],
    ['Drums 92 BPM.wav', 92],
    ['C:\\Samples\\hats-140-bpm.flac', 140],
    ['bpm174_dnb_break.wav', 174],
    ['Guitar_BPM_95_Am.wav', 95],
    ['vocal 92.5bpm.wav', 92.5],
    ['dnb_loop_174.wav', 174],
    ['Loop 87 Am.wav', 87],
    ['kick_01.wav', null],
    ['808 slide C.wav', null],
    ['snare 140.wav', null],
    ['loop_01_120_take2_140.wav', null],
    ['loop.wav', null],
    ['crazy 999bpm.wav', null],
    ['bpm.wav', null],
  ];
  for (const [name, want] of cases) assert.equal(bpmFromName(name), want, name);
});

test('loopBpmFor: library metadata wins (a one-shot stays a one-shot even with a number in its name), else the name', () => {
  const lib = [
    { path: 'factory:fx/riser-4bar.wav', bpm: 128 },
    { path: 'factory:drums/kick-140bpm.wav' },
  ];
  assert.deepEqual(loopBpmFor('factory:fx/riser-4bar.wav', 'Riser', lib), { bpm: 128, from: 'library' });
  assert.equal(loopBpmFor('factory:drums/kick-140bpm.wav', undefined, lib), null);
  assert.deepEqual(loopBpmFor('C:\\x\\Break 170 BPM.wav', undefined, lib), { bpm: 170, from: 'name' });
  assert.equal(loopBpmFor('C:\\x\\Clap.wav', 'Clap.wav', lib), null);
  assert.equal(followTempoMessage(128, 140), 'Following tempo (128 → 140 bpm) · undo to keep the original speed');
  assert.equal(followTempoMessage(140, 140), 'Following tempo (140 bpm) · undo to keep the original speed');
});

test('turning on Follow tempo after a drop is its own undo step and rescales the clip to exact bars', () => {
  const { d, clipId } = withAudio();
  const ch = d.project.playlist.clips[clipId].channelId!;
  exec(d, 'transport.set', { bpm: 140 });
  const r = d.execBatch(
    [
      { cmd: 'params.set', args: { ref: `channel/${ch}/gen/src_bpm`, value: 120 } },
      { cmd: 'params.set', args: { ref: `channel/${ch}/gen/tempo_sync`, value: 1 } },
    ],
    { actor: USER, label: 'Follow tempo (120 bpm)' },
  );
  assert.equal(r.ok, true, r.message);
  assert.equal(d.project.playlist.clips[clipId].length, 8 * PPQ, 'two 4/4 bars at any project tempo');
  d.undo(USER);
  assert.ok(d.project.playlist.clips[clipId], 'one undo keeps the clip');
  assert.notEqual(d.project.channels[ch].generator.params.tempo_sync, 1);
});

const tpl = (id: string, name: string, updatedAt = '2026-01-01T00:00:00.000Z'): ProjectTemplate => ({ id, name, createdAt: updatedAt, updatedAt, bpm: 140, timeSig: '4/4', channels: 6, patterns: 1 });

test('template names, index parsing (damaged files never throw), lookup and sorting', () => {
  assert.deepEqual(cleanTemplateName('  Trap   starter '), { ok: true, name: 'Trap starter' });
  assert.equal(cleanTemplateName('').ok, false);
  assert.equal(cleanTemplateName('x'.repeat(65)).ok, false);
  assert.equal(cleanTemplateName('a\u0001b').ok, false);
  assert.deepEqual(parseTemplateIndex(null).templates, []);
  assert.deepEqual(parseTemplateIndex('{nope').templates, []);
  const ix = parseTemplateIndex(JSON.stringify({ version: 1, templates: [tpl('tpl-aaaaaa', 'B'), { id: '../../evil', name: 'x', createdAt: 'z' }, tpl('tpl-aaaaaa', 'dup'), { ...tpl('tpl-bbbbbb', 'A'), bpm: 'fast' }] }));
  assert.deepEqual(ix.templates.map((t) => t.id), ['tpl-aaaaaa', 'tpl-bbbbbb'], 'bad ids and duplicates dropped');
  assert.equal(ix.templates[1].bpm, 0);
  const list = sortTemplates([tpl('tpl-cccccc', 'zeta'), tpl('tpl-dddddd', 'Alpha')]);
  assert.deepEqual(list.map((t) => t.name), ['Alpha', 'zeta']);
  assert.equal(findTemplate(list, 'ALPHA')?.id, 'tpl-dddddd');
  assert.equal(findTemplate(list, 'tpl-cccccc')?.name, 'zeta');
  assert.equal(findTemplate(list, 'nope'), null);
  assert.equal(describeTemplate(tpl('tpl-eeeeee', 'x')), '140 bpm · 4/4 · 6 channels · 1 pattern');
});

test('TemplateStore: save, replace by name, rename (no clashes), delete; atomic, ids never escape the folder', async () => {
  const dir = path.join(TMP, 'store', 'templates');
  const store = new TemplateStore(dir);
  const facts = { bpm: 120, timeSig: '3/4', channels: 2, patterns: 1 };
  const a = await store.save('Waltz', new Uint8Array([1, 2, 3]), facts);
  assert.equal(a.replaced, false);
  assert.match(a.template.id, /^tpl-[a-z0-9]+$/);
  const b = await store.save('Trap', new Uint8Array([4]), { ...facts, bpm: 140 });
  const again = await store.save('  waltz ', new Uint8Array([9, 9]), facts);
  assert.equal(again.replaced, true);
  assert.equal(again.template.id, a.template.id, 'same name (any case) replaces');
  assert.deepEqual([...(await store.read(a.template.id)).bytes], [9, 9]);
  assert.deepEqual(store.list().map((t) => t.name), ['Trap', 'waltz']);
  await assert.rejects(store.rename(b.template.id, 'WALTZ'), /already is a template/);
  assert.equal((await store.rename(b.template.id, 'Trap starter')).name, 'Trap starter');
  await assert.rejects(store.save('', new Uint8Array([1]), facts), TemplateError);
  await assert.rejects(store.read('../../etc'), /doesn't exist/);
  assert.throws(() => store.fileOf('..\\..\\evil'), TemplateError);
  await assert.rejects(store.remove('tpl-zzzzzzzz'), /doesn't exist/);
  await store.remove(a.template.id);
  assert.deepEqual(store.list().map((t) => t.name), ['Trap starter']);
  assert.ok(!fs.existsSync(path.join(dir, `${a.template.id}.kstudio`)));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  await Promise.all(['One', 'Two', 'Three'].map((n) => store.save(n, new Uint8Array([1]), facts)));
  assert.equal(store.list().length, 4);
  fs.rmSync(store.fileOf(store.list()[0].id));
  assert.equal(store.list().length, 3);
});

function service(dir: string) {
  const doc = new DocHost(createDefaultProject('Svc'), CATALOG, { strict: true });
  const svc = new ProjectService({
    doc,
    appVersion: 'test',
    userDataDir: dir,
    factoryDir: path.join(dir, 'factory'),
    documentsDir: path.join(dir, 'docs'),
    getSettings: () => ({ recent: [], autosaveSec: 0, browserRoots: [] }) as unknown as Settings,
    addRecent: () => {},
    log: () => {},
  });
  return { doc, svc };
}

test('ProjectService: Save as template → New from template gives a fresh, unsaved, not-dirty copy (new id, same sounds)', async () => {
  const dir = path.join(TMP, 'svc');
  const { doc, svc } = service(dir);
  doc.exec('transport.set', { bpm: 97, timeSig: { num: 6, den: 8 } }, { actor: USER });
  const chName = doc.project.channels[doc.project.channelOrder[0]].name;
  const saved = await svc.saveAsTemplate('Ballad 6/8');
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.data!.timeSig, '6/8');
  assert.equal(saved.data!.bpm, 97);
  assert.ok(fs.existsSync(path.join(dir, 'templates', 'templates.json')));
  const oldId = doc.project.id;
  doc.exec('transport.set', { bpm: 150, timeSig: { num: 4, den: 4 } }, { actor: USER });
  const r = await svc.newFromTemplate('ballad 6/8');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /New project from "Ballad 6\/8"/);
  assert.equal(doc.project.transport.bpm, 97);
  assert.deepEqual(doc.project.transport.timeSig, { num: 6, den: 8 });
  assert.equal(doc.project.channels[doc.project.channelOrder[0]].name, chName);
  assert.notEqual(doc.project.id, oldId, 'a new project id: backups never mix');
  assert.equal(doc.project.meta.name, 'Untitled');
  const st = svc.status();
  assert.equal(st.path, null, 'Save asks where to keep it');
  assert.equal(st.dirty, false);
  assert.equal(doc.getHistory().length, 0, 'history starts empty like File ▸ New');
  assert.equal((await svc.newFromTemplate('nope')).ok, false);
  assert.equal((await svc.renameTemplate(saved.data!.id, 'Slow 6/8')).ok, true);
  assert.deepEqual(svc.listTemplates().map((t) => t.name), ['Slow 6/8']);
  assert.equal((await svc.deleteTemplate(saved.data!.id)).ok, true);
  assert.deepEqual(svc.listTemplates(), []);
  assert.equal((await svc.saveAsTemplate('   ')).ok, false);
});

function mcp(dir: string) {
  const { doc, svc } = service(dir);
  let dirty = false;
  const deps = {
    doc,
    engine: { status: () => ({ state: 'stopped' }) },
    project: {
      status: () => ({ ...svc.status(), dirty }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p: string) => p,
      renderDir: () => dir,
      allowedRoots: () => [],
      listTemplates: () => svc.listTemplates(),
      newFromTemplate: (ref: string) => svc.newFromTemplate(ref),
    },
    getSettings: () => ({}) as Settings,
    updateSettings: () => ({}) as Settings,
    broadcast: () => {},
    userDataDir: dir,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'wf', name: 'Workflow test' }, session: newSession(), via: 'test' };
  return { doc, svc, call: (name: string, args: unknown) => callTool(deps, caller, name, args), setDirty: (v: boolean) => (dirty = v) };
}

test('MCP add_marker: add, then rename / move / remove by name or id in one call; ambiguity and unknown names fail clearly', async () => {
  const { doc, call } = mcp(path.join(TMP, 'mcp1'));
  assert.equal((await call('add_marker', { markers: [{ at: 1, name: 'Intro' }, { at: 9, name: 'Marker 2' }, { at: 17, name: 'Drop' }] })).ok, true);
  const r = await call('add_marker', { rename: [{ marker: 'marker 2', name: 'Verse' }], move: [{ marker: 'Drop', at: 25 }], remove: ['Intro'] });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Renamed "Marker 2" to "Verse"; moved "Drop" to 25; removed "Intro"/);
  const ms = Object.values(doc.project.playlist.markers).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(ms.map((m) => [m.name, m.tick]), [['Verse', 3840 * 8], ['Drop', 3840 * 24]]);
  const bad = await call('add_marker', { rename: [{ marker: 'Chorus', name: 'X' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /No marker "Chorus"\. Markers: "Verse" @9, "Drop" @25/);
  await call('add_marker', { markers: [{ at: 33, name: 'Drop' }] });
  assert.match((await call('add_marker', { remove: ['Drop'] })).message, /2 markers are called "Drop": pass an id/);
  assert.match((await call('add_marker', {})).message, /Pass markers to add/);
  const id = ms[0].id;
  assert.equal((await call('add_marker', { rename: [{ marker: id, name: 'Verse 1' }] })).ok, true);
  assert.equal(doc.project.playlist.markers[id].name, 'Verse 1');
});

test('MCP set_tempo time_signature and restructure_song op fade (fades in beats, crossfade a split)', async () => {
  const { doc, call } = mcp(path.join(TMP, 'mcp2'));
  assert.equal((await call('set_tempo', { time_signature: '7/8' })).ok, true);
  assert.deepEqual(doc.project.transport.timeSig, { num: 7, den: 8 });
  assert.equal((await call('set_tempo', { time_signature: '7/7' })).ok, false);
  await call('set_tempo', { time_signature: '4/4' });
  const trackId = doc.project.playlist.trackOrder[0];
  const add = doc.exec<{ clipId: string }>('playlist.addAudio', { path: 'C:\\v.wav', trackId, start: 0, frames: 48000 * 8, sampleRate: 48000 }, { actor: USER });
  const clipId = add.data!.clipId;
  const f = await call('restructure_song', { op: 'fade', ids: [clipId], fade_in: 1, fade_out: 2 });
  assert.equal(f.ok, true, f.message);
  assert.equal(doc.project.playlist.clips[clipId].fadeIn, PPQ);
  assert.equal(doc.project.playlist.clips[clipId].fadeOut, 2 * PPQ);
  const [, right] = doc.exec<{ ids: string[] }>('playlist.splitClip', { id: clipId, at: 3840 * 2 }, { actor: USER }).data!.ids;
  const x = await call('restructure_song', { op: 'fade', ids: [right], crossfade: 0.5 });
  assert.equal(x.ok, true, x.message);
  assert.match(x.message, /Crossfaded 1 clip/);
  assert.equal(doc.project.playlist.clips[right].fadeIn, PPQ / 2);
  assert.match((await call('restructure_song', { op: 'fade', ids: [right] })).message, /needs fade_in, fade_out and\/or crossfade/);
  const pat = doc.exec<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId, start: 3840 * 10, patternId: doc.project.patternOrder[0] }, { actor: USER }).data!.id;
  assert.match((await call('restructure_song', { op: 'fade', ids: [pat], fade_in: 1 })).message, /no audio clips match/);
});

test('MCP audio_to_project {template}: a new project from the user template; refused with unsaved changes or an unknown name', async () => {
  const { doc, svc, call, setDirty } = mcp(path.join(TMP, 'mcp3'));
  assert.match((await call('audio_to_project', { template: 'Anything' })).message, /no project templates yet/);
  doc.exec('transport.set', { bpm: 88 }, { actor: USER });
  assert.equal((await svc.saveAsTemplate('Lofi base')).ok, true);
  doc.exec('transport.set', { bpm: 150 }, { actor: USER });
  assert.match((await call('audio_to_project', { template: 'Jazz' })).message, /No template "Jazz"\. The user's templates: "Lofi base"/);
  setDirty(true);
  assert.match((await call('audio_to_project', { template: 'Lofi base' })).message, /unsaved changes/);
  setDirty(false);
  assert.match((await call('audio_to_project', { template: 'Lofi base', path: 'C:\\a.wav' })).message, /either path .* or template/);
  const r = await call('audio_to_project', { template: 'lofi base' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /New project from "Lofi base"/);
  assert.equal(doc.project.transport.bpm, 88);
  assert.match((await call('audio_to_project', {})).message, /Pass path/);
});

void run('workflow (Wave 12.2b)');
