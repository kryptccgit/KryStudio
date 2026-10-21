// The Recording Studio's recording target (shared/commands/recording.ts, Project.recording): recording.setupVocals
// (insert + track + vocal chain, one undo step, reused on a second run), recording.setTarget, takes routed through the
// target insert (playlist.addAudio / takes.createGroup insertId), the target track preferred by freeTrack, and the
// target cleared when its insert or track is deleted.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, zProject } from '@shared/schema/project';
import { factoryChainPresets } from '@shared/sounds/factory';
import { freeTrack, recordingInsert } from '@shared/live/recording';

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
    assert.equal(doc.version, v);
  };
  const sound = () => {
    assert.deepEqual(checkIntegrity(doc.project), []);
    assert.equal(zProject.safeParse(JSON.parse(JSON.stringify(doc.project))).success, true);
  };
  return { doc, ok, bad, sound };
}

type Setup = { insertId: string; trackId: string; createdInsert: boolean; createdTrack: boolean };
const popVocal = () => factoryChainPresets().find((c) => c.name === 'Pop Vocal')!;

test('setupVocals: a Vocals insert with the chain and a Vocals track on top, one undo step; a second run reuses them', () => {
  const { doc, ok, sound } = host();
  const inserts = doc.project.mixer.insertOrder.length;
  const tracks = doc.project.playlist.trackOrder.length;
  const r = ok<Setup>('recording.setupVocals', { chain: popVocal() });
  assert.deepEqual([r.createdInsert, r.createdTrack], [true, true]);
  const ins = doc.project.mixer.inserts[r.insertId];
  assert.equal(ins.name, 'Vocals');
  assert.deepEqual(ins.slotOrder.map((s) => ins.slots[s].type), popVocal().fx.map((f) => f.type));
  assert.equal(doc.project.playlist.trackOrder[0], r.trackId, 'the Vocals track goes on top');
  assert.deepEqual(doc.project.recording, { insertId: r.insertId, trackId: r.trackId });
  assert.equal(recordingInsert(doc.project), r.insertId);
  sound();
  const again = ok<Setup>('recording.setupVocals', { name: 'Lead Vox', chain: null });
  assert.deepEqual([again.insertId, again.trackId, again.createdInsert, again.createdTrack], [r.insertId, r.trackId, false, false]);
  assert.equal(doc.project.mixer.inserts[r.insertId].name, 'Lead Vox');
  assert.equal(doc.project.mixer.inserts[r.insertId].slotOrder.length, popVocal().fx.length, 'chain null leaves the effects alone');
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(doc.project.recording, undefined);
  assert.equal(doc.project.mixer.insertOrder.length, inserts, 'one undo per setup removes the insert');
  assert.equal(doc.project.playlist.trackOrder.length, tracks);
  sound();
});

test('takes play through the target insert; without one each take gets its own', () => {
  const { doc, ok, bad, sound } = host();
  const { insertId, trackId } = ok<Setup>('recording.setupVocals', { chain: null });
  const before = doc.project.mixer.insertOrder.length;
  const a = ok<{ channelId: string; insertId: string }>('playlist.addAudio', { path: 'C:/rec/take 1.wav', trackId, start: 0, frames: 48000, sampleRate: 48000, channels: 1, insertId });
  assert.equal(a.insertId, insertId);
  assert.equal(doc.project.channels[a.channelId].insertId, insertId);
  assert.equal(doc.project.mixer.insertOrder.length, before, 'no new insert');
  const g = ok<{ takeIds: string[] }>('takes.createGroup', {
    name: 'Recording',
    trackId,
    insertId,
    audio: { path: 'C:/rec/take 2.wav', frames: 96000, sampleRate: 48000, channels: 1 },
    passes: [
      { start: 3840, end: 7680, sec: 0 },
      { start: 3840, end: 7680, sec: 1 },
    ],
  });
  assert.equal(g.takeIds.length, 2);
  const takeChannels = Object.values(doc.project.channels).filter((c) => c.name.startsWith('Recording take'));
  assert.ok(takeChannels.length === 2 && takeChannels.every((c) => c.insertId === insertId));
  assert.equal(doc.project.mixer.insertOrder.length, before);
  const plain = ok<{ insertId: string }>('playlist.addAudio', { path: 'C:/rec/other.wav', trackId, start: 99999 });
  assert.notEqual(plain.insertId, insertId, 'no insertId = a new insert, as before');
  bad('playlist.addAudio', { path: 'C:/x.wav', trackId, start: 0, insertId: 'nope' }, /Insert nope not found/);
  sound();
});

test('freeTrack prefers the target track while it has room; deleting the insert or track clears the target', () => {
  const { doc, ok, bad, sound } = host();
  const { insertId, trackId } = ok<Setup>('recording.setupVocals', { chain: null });
  assert.equal(freeTrack(doc.project, 0, 3840), trackId);
  ok('playlist.addAudio', { path: 'C:/rec/a.wav', trackId, start: 0, frames: 48000, sampleRate: 48000, insertId });
  assert.notEqual(freeTrack(doc.project, 0, 100), trackId, 'busy there: the first free track instead');
  assert.equal(freeTrack(doc.project, 100_000, 103_840), trackId);
  bad('recording.setTarget', { insertId: doc.project.mixer.masterId }, /master/);
  bad('recording.setTarget', { trackId: 'nope' }, /Track nope not found/);
  ok('mixer.removeInsert', { id: insertId });
  assert.deepEqual(doc.project.recording, { insertId: null, trackId });
  assert.equal(recordingInsert(doc.project), undefined);
  ok('playlist.removeTrack', { id: trackId });
  assert.deepEqual(doc.project.recording, { insertId: null, trackId: null });
  sound();
  ok('recording.setTarget', { insertId: null, trackId: null });
  assert.equal(doc.project.recording, undefined, 'an empty target goes away');
  const p = JSON.parse(JSON.stringify(doc.project));
  p.recording = { insertId: 'gone', trackId: null };
  assert.match(checkIntegrity(p).join('\n'), /recording target insert is missing/);
});

run('recording target');
