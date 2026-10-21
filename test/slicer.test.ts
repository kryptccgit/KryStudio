import assert from 'node:assert/strict';
import { test, run } from './harness';
import { installRackFixtures } from './rack-fixtures';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, zProject } from '@shared/schema/project';
import { getCommand, listCommands } from '@shared/commands/registry';
import { SLICER_COMMANDS } from '@shared/commands/slicer';
import { MAX_SLICER_SLICES, SLICER_PLUGIN, isValidSlices } from '@shared/schema/slicer';

installRackFixtures();

function host() {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  const exec = <T = any>(cmd: string, args: unknown) => doc.exec<T>(cmd, args, { actor: USER });
  const ok = <T = any>(cmd: string, args: unknown): T => {
    const r = exec<T>(cmd, args);
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const bad = (cmd: string, args: unknown, re: RegExp) => {
    const v = doc.version;
    const r = exec(cmd, args);
    assert.equal(r.ok, false, `${cmd} should fail`);
    assert.match(r.message ?? '', re);
    assert.equal(doc.version, v, `${cmd}: a failed command changes nothing`);
  };
  const ch = (id: string) => doc.project.channels[id];
  const secs = (id: string) => (ch(id).generator.slices ?? []).map((s) => s.sec);
  const sound = () => assert.deepEqual(checkIntegrity(doc.project), []);
  return { doc, exec, ok, bad, ch, secs, sound };
}

type Sliced = { channelId: string; insertId: string; patternId?: string; slices: number[]; baseKey: number };

test('the slicer.* commands are registered with descriptions', () => {
  assert.equal(SLICER_COMMANDS.length, 7);
  for (const c of SLICER_COMMANDS) {
    assert.ok(c.id.startsWith('slicer.'), c.id);
    assert.equal(getCommand(c.id), c);
    assert.ok(c.description.length > 60, c.id);
  }
  assert.ok(CATALOG.plugins.some((p) => p.id === SLICER_PLUGIN && p.kind === 'instrument' && p.usesSample), 'the engine catalog has the Slicer');
  const ids = listCommands().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command ids');
});

test('slicer.slice: a new Slicer channel with markers, a replay pattern on keys 60 up, one undo', () => {
  const { doc, ok, ch, secs, sound } = host();
  const channels = Object.keys(doc.project.channels).length;
  const r = ok<Sliced>('slicer.slice', { samplePath: 'C:/loops/break.wav', slices: [1.5, 0, 0.5, 0.502, 1, 9], lengthSec: 2, bpm: 120 });
  assert.deepEqual(r.slices, [0, 0.5, 1, 1.5], 'sorted, the near-duplicate merged, past-the-end dropped');
  assert.equal(r.baseKey, 60);
  const c = ch(r.channelId);
  assert.equal(c.generator.type, SLICER_PLUGIN);
  assert.equal(c.name, 'break slicer');
  assert.equal(c.rootKey, 60, 'steps play slice 1');
  assert.deepEqual(secs(r.channelId), [0, 0.5, 1, 1.5]);
  assert.ok(isValidSlices(c.generator.slices!));
  assert.equal(doc.project.samples[c.generator.sampleId!].path, 'C:/loops/break.wav');
  assert.notEqual(c.insertId, doc.project.mixer.masterId, 'its own insert');
  const pat = doc.project.patterns[r.patternId!];
  assert.equal(pat.length, 3840, '2 s at 120 BPM = 1 bar');
  const notes = Object.values(pat.notes[r.channelId]).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(
    notes.map((n) => [n.tick, n.key, n.dur]),
    [
      [0, 60, 960],
      [960, 61, 960],
      [1920, 62, 960],
      [2880, 63, 960],
    ],
  );
  sound();
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(Object.keys(doc.project.channels).length, channels, 'one undo removes the channel, insert, sample and pattern');
  assert.equal(doc.project.patterns[r.patternId!], undefined);
  sound();
});

test('slicer.slice onto channels: a sampler becomes the Slicer, a Slicer keeps its settings, an audio clip gets a new channel', () => {
  const { doc, ok, bad, ch, secs, sound } = host();
  const first = ok<Sliced>('slicer.slice', { samplePath: 'C:/loops/break.wav', slices: [0, 1], lengthSec: 2, pattern: false });
  ok('channels.setGenParams', { id: first.channelId, params: { baseKey: 48, cut: 0 } });
  const again = ok<Sliced>('slicer.slice', { channelId: first.channelId, slices: [0, 0.25, 0.5], lengthSec: 2, pattern: false });
  assert.equal(again.channelId, first.channelId);
  assert.equal(again.baseKey, 48);
  assert.deepEqual(secs(first.channelId), [0, 0.25, 0.5]);
  assert.equal(ch(first.channelId).generator.params.cut, 0, 'settings kept');
  assert.equal(ch(first.channelId).rootKey, 48);
  const kick = Object.values(doc.project.channels).find((c) => c.generator.type === 'krypt.sampler')!;
  const aut = ok<{ automationId: string }>('automation.create', { target: `channel/${kick.id}/gen/cutoff` });
  const onto = ok<Sliced>('slicer.slice', { channelId: kick.id, samplePath: 'C:/loops/b.wav', slices: [0], lengthSec: 1, pattern: false });
  assert.equal(onto.channelId, kick.id);
  assert.equal(ch(kick.id).generator.type, SLICER_PLUGIN);
  assert.deepEqual(ch(kick.id).generator.params, {});
  assert.equal(doc.project.automations[aut.automationId].target, null);
  bad('slicer.slice', { slices: [0], lengthSec: 1 }, /Give the sample to slice/);
  bad('slicer.slice', { samplePath: 'C:/x.wav', slices: [5], lengthSec: 1 }, /None of the slice times/);
  ok('channels.setGenParams', { id: first.channelId, params: { baseKey: 126 } });
  bad('slicer.slice', { channelId: first.channelId, slices: [0, 0.5, 1], lengthSec: 2 }, /past the top MIDI note/);
  sound();
});

test('add / move / remove / set refuse crossings with a message and keep the map valid', () => {
  const { ok, bad, ch, secs, sound } = host();
  const { channelId } = ok<Sliced>('slicer.slice', { samplePath: 'C:/loops/break.wav', slices: [0, 0.5, 1], lengthSec: 2, pattern: false });
  const ids = () => ch(channelId).generator.slices!.map((s) => s.id);
  const add = ok<{ sliceId: string; index: number }>('slicer.addSlice', { channelId, sec: 0.75 });
  assert.equal(add.index, 2);
  assert.deepEqual(secs(channelId), [0, 0.5, 0.75, 1]);
  bad('slicer.addSlice', { channelId, sec: 0.751 }, /cross or touch slice 3/);
  bad('slicer.moveSlice', { channelId, sliceId: add.sliceId, sec: 1.2 }, /Can't move slice 3 .*slice 4 \(at 1 s\)/);
  bad('slicer.moveSlice', { channelId, sliceId: add.sliceId, sec: 0.4 }, /slice 2 \(at 0.5 s\)/);
  ok('slicer.moveSlice', { channelId, sliceId: add.sliceId, sec: 0.8 });
  assert.deepEqual(secs(channelId), [0, 0.5, 0.8, 1]);
  bad('slicer.moveSlice', { channelId, sliceId: 'nope', sec: 0.1 }, /isn't on/);
  ok('slicer.setSlice', { channelId, sliceId: ids()[1], pitch: -5, reverse: true, gain: 0.5 });
  assert.deepEqual(ch(channelId).generator.slices![1], { id: ids()[1], sec: 0.5, pitch: -5, reverse: true, gain: 0.5 });
  ok('slicer.setSlice', { channelId, sliceId: ids()[1], pitch: 0, reverse: false, gain: 1 });
  assert.deepEqual(ch(channelId).generator.slices![1], { id: ids()[1], sec: 0.5 }, 'defaults stay sparse');
  ok('slicer.removeSlice', { channelId, sliceId: ids()[0] });
  assert.deepEqual(secs(channelId), [0.5, 0.8, 1]);
  ok('slicer.clear', { channelId });
  assert.equal(ch(channelId).generator.slices, undefined);
  bad('slicer.clear', { channelId }, /no slice markers/);
  ok('samples.add', { path: 'C:/loops/known.wav', frames: 48000, sampleRate: 48000 });
  const known = ok<Sliced>('slicer.slice', { samplePath: 'C:/loops/known.wav', slices: [0], lengthSec: 1, pattern: false });
  bad('slicer.addSlice', { channelId: known.channelId, sec: 1.5 }, /past the end of the sample \(1 s long\)/);
  sound();
});

test('makePattern replays the current markers; a new sample resets them; other channels and racks refuse', () => {
  const { doc, ok, bad, ch, sound } = host();
  const { channelId } = ok<Sliced>('slicer.slice', { samplePath: 'C:/loops/break.wav', slices: [0, 0.5], lengthSec: 1, pattern: false });
  bad('slicer.makePattern', { channelId }, /isn't known yet/);
  const { patternId } = ok<{ patternId: string }>('slicer.makePattern', { channelId, bpm: 60, lengthSec: 1 });
  const notes = Object.values(doc.project.patterns[patternId].notes[channelId]).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(
    notes.map((n) => [n.tick, n.key, n.dur]),
    [
      [0, 60, 480],
      [480, 61, 480],
    ],
  );
  ok('samples.add', { path: 'C:/loops/other.wav' });
  const other = Object.values(doc.project.samples).find((s) => s.path === 'C:/loops/other.wav')!;
  ok('channels.setSample', { id: channelId, sampleId: other.id });
  assert.equal(ch(channelId).generator.slices, undefined, 'markers belong to the old audio');
  const sampler = Object.values(doc.project.channels).find((c) => c.generator.type === 'krypt.sampler')!;
  bad('slicer.addSlice', { channelId: sampler.id, sec: 0.1 }, /not a Slicer channel/);
  bad('rack.create', { channelId: channelId }, /Slicer can't go in a rack/);
  ok('slicer.addSlice', { channelId, sec: 0.2 });
  ok('channels.setGenerator', { id: channelId, type: 'krypt.sampler' });
  assert.equal(ch(channelId).generator.slices, undefined);
  sound();
});

test('the schema accepts slice maps and integrity rejects unsorted ones', () => {
  const { doc, ok } = host();
  const { channelId } = ok<Sliced>('slicer.slice', { samplePath: 'C:/loops/break.wav', slices: [0, 0.5], lengthSec: 1, pattern: false });
  const p = JSON.parse(JSON.stringify(doc.project));
  assert.equal(zProject.safeParse(p).success, true);
  p.channels[channelId].generator.slices.reverse();
  assert.match(checkIntegrity(p).join('\n'), /slices are unsorted/);
  p.channels[channelId].generator.slices = Array.from({ length: MAX_SLICER_SLICES + 1 }, (_, i) => ({ id: `s${i}`, sec: i }));
  assert.equal(zProject.safeParse(p).success, false, 'at most MAX_SLICER_SLICES');
  p.channels[channelId].generator.slices = [{ id: 'a', sec: 0, pitch: 99 }];
  assert.equal(zProject.safeParse(p).success, false, 'pitch range');
});

run('slicer');
