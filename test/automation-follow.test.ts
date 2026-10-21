import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { patternToSmf } from '@shared/midi/convert';
import { automationValueAt, isAutomated } from '../src/live/automationEval';

function withAutomation() {
  const host = new DocHost(createDefaultProject('Auto'), CATALOG, { strict: true });
  const ch = host.project.channelOrder[0];
  const ref = `channel/${ch}/volume`;
  const track = host.project.playlist.trackOrder[2];
  const r = host.exec<{ automationId: string; clipId: string }>(
    'automation.create',
    { target: ref, trackId: track, start: 3840, length: 3840, points: [{ tick: 0, value: 0 }, { tick: 3840, value: 1 }] },
    { actor: USER },
  );
  assert.equal(r.ok, true, r.message);
  return { host, ref, track, clipId: r.data!.clipId };
}

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test('inside a clip: the curve; before: nothing; after: the last value holds', () => {
  const { host, ref } = withAutomation();
  const p = host.project;
  assert.equal(isAutomated(p, ref), true);
  assert.equal(isAutomated(p, 'transport/bpm'), false);
  assert.equal(automationValueAt(p, ref, 0), null, 'no clip has played yet → document value');
  near(automationValueAt(p, ref, 3840), 0);
  near(automationValueAt(p, ref, 3840 + 1920), 0.5);
  near(automationValueAt(p, ref, 3840 * 3), 1);
});

test('clip offset is respected, and the most recent clip wins when several played', () => {
  const { host, ref, clipId, track } = withAutomation();
  host.exec('playlist.updateClips', { updates: [{ id: clipId, offset: 1920, length: 1920 }] }, { actor: USER });
  near(automationValueAt(host.project, ref, 3840), 0.5);
  const aut = host.project.playlist.clips[clipId].automationId!;
  host.exec('playlist.addClip', { kind: 'automation', automationId: aut, trackId: track, start: 3840 * 4, length: 960 }, { actor: USER });
  near(automationValueAt(host.project, ref, 3840 * 4 + 480), 0.125);
  near(automationValueAt(host.project, ref, 3840 * 8), 0.25);
});

test('muted clips, muted tracks and non-soloed tracks do not drive the knob', () => {
  const a = withAutomation();
  a.host.exec('playlist.updateClips', { updates: [{ id: a.clipId, mute: true }] }, { actor: USER });
  assert.equal(isAutomated(a.host.project, a.ref), false);
  const b = withAutomation();
  b.host.exec('playlist.setTrack', { id: b.track, mute: true }, { actor: USER });
  assert.equal(automationValueAt(b.host.project, b.ref, 4000), null);
  const c = withAutomation();
  const other = c.host.project.playlist.trackOrder[0];
  c.host.exec('playlist.setTrack', { id: other, solo: true }, { actor: USER });
  assert.equal(isAutomated(c.host.project, c.ref), false);
  c.host.exec('playlist.setTrack', { id: c.track, solo: true }, { actor: USER });
  assert.equal(isAutomated(c.host.project, c.ref), true);
});

test('MIDI export skips muted notes and maps colour groups to MIDI channels', () => {
  const host = new DocHost(createDefaultProject('Midi'), CATALOG, { strict: true });
  const pat = host.project.transport.activePatternId!;
  const ch = host.project.channelOrder[5];
  host.exec(
    'notes.replace',
    { patternId: pat, channelId: ch, notes: [{ tick: 0, key: 60 }, { tick: 240, key: 62, mute: true }, { tick: 480, key: 64, color: 3 }] },
    { actor: USER },
  );
  const smf = patternToSmf(host.project, pat);
  const t = smf.tracks.find((x) => x.notes.some((n) => n.key === 60))!;
  assert.deepEqual(t.notes.map((n) => n.key), [60, 64]);
  assert.equal(t.notes.find((n) => n.key === 64)!.channel, 3);
  assert.notEqual(t.notes.find((n) => n.key === 60)!.channel, 3);
});

void run('automation follow');
