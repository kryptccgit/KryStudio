import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, type Clip } from '@shared/schema/project';
import { getClipClipboard, setClipClipboard } from '../src/editors/clipboard';

function host() {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  const exec = <T = any>(cmd: string, args: unknown) => doc.exec<T>(cmd, args, { actor: USER });
  const ok = <T = any>(cmd: string, args: unknown): T => {
    const r = exec<T>(cmd, args);
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  return { doc, exec, ok };
}

test('clipboard snapshots survive the originals being cut', () => {
  const { doc, ok } = host();
  const p = doc.project;
  const [t1, t2] = p.playlist.trackOrder;
  const pat = p.patternOrder[0];
  const a = ok<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: t1, start: 3840, patternId: pat });
  const b = ok<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: t2, start: 7680, patternId: pat, color: '#FF0000' });
  ok('playlist.updateClips', { updates: [{ id: b.id, mute: true }] });
  const clips = [a.id, b.id].map((id) => doc.project.playlist.clips[id]) as Clip[];
  setClipClipboard(clips);
  const cb = getClipClipboard()!;
  assert.equal(cb.minStart, 3840);
  assert.ok(cb.clips.every((c) => !('id' in c)), 'snapshots carry no ids');
  ok('playlist.removeClips', { ids: [a.id, b.id] });

  const before = Object.keys(doc.project.playlist.clips).length;
  const { ids } = ok<{ ids: string[] }>('playlist.pasteClips', { clips: cb.clips, shift: 15360 - cb.minStart });
  assert.equal(ids.length, 2);
  assert.equal(Object.keys(doc.project.playlist.clips).length, before + 2);
  const [na, nb] = ids.map((id) => doc.project.playlist.clips[id]);
  assert.deepEqual([na.start, na.trackId, na.mute], [15360, t1, false]);
  assert.deepEqual([nb.start, nb.trackId, nb.mute, nb.color], [19200, t2, true, '#FF0000']);
  assert.deepEqual(checkIntegrity(doc.project), []);
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(Object.keys(doc.project.playlist.clips).length, before, 'one undo removes the whole paste');
});

test('paste refuses clips whose source is gone, and clamps at the song start', () => {
  const { doc, exec, ok } = host();
  const t1 = doc.project.playlist.trackOrder[0];
  const { id: pid } = ok<{ id: string }>('patterns.add', {});
  const snap = { trackId: t1, kind: 'pattern' as const, start: 960, length: 3840, patternId: pid };
  const { ids } = ok<{ ids: string[] }>('playlist.pasteClips', { clips: [snap], shift: -5000 });
  assert.equal(doc.project.playlist.clips[ids[0]].start, 0);
  ok('patterns.remove', { id: pid });
  const v = doc.version;
  const r = exec('playlist.pasteClips', { clips: [snap] });
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /pattern was deleted/);
  assert.equal(doc.version, v);
  const r2 = exec('playlist.pasteClips', { clips: [{ ...snap, trackId: 'nope', patternId: doc.project.patternOrder[0] }] });
  assert.match(r2.message ?? '', /track these clips were copied from was deleted/);
});

run('clip paste');
