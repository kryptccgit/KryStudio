// Playlist arrangement tools (shared/commands/arrange.ts): split by channel,
// consolidate, clone as unique, insert / delete time.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { checkIntegrity, patternLength, type Clip } from '@shared/schema/project';
import { CATALOG } from '@shared/plugins/catalog';
import { PPQ } from '@shared/schema/time';

const BAR = PPQ * 4;

function fresh() {
  const p = createDefaultProject('Arrange');
  // start from an empty arrangement so positions are predictable
  p.playlist.clips = {};
  p.playlist.markers = {};
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const [kick, snare, , , bass] = p.channelOrder;
  const tracks = p.playlist.trackOrder;
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = host.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  return { host, pat, kick, snare, bass, tracks, ex };
}

const clips = (host: DocHost): Clip[] => Object.values(host.project.playlist.clips).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
const ok = (host: DocHost) => assert.deepEqual(checkIntegrity(host.project), []);

test('split by channel: one pattern + clip per channel, overlap forces a new track', () => {
  const { host, pat, kick, snare, bass, tracks, ex } = fresh();
  ex('notes.clear', { patternId: pat });
  ex('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 36 }, { tick: 960, key: 36 }] });
  ex('notes.add', { patternId: pat, channelId: snare, notes: [{ tick: 960, key: 38 }] });
  ex('notes.add', { patternId: pat, channelId: bass, notes: [{ tick: 0, key: 40, dur: 1900 }] });
  ex('patterns.set', { id: pat, length: BAR * 2 });
  const src = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: BAR, patternId: pat, offset: 120 }).id;
  // something already on track 2 in the same range → the 2nd channel gets a NEW track there
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR * 2, patternId: pat });
  const nTracks = host.project.playlist.trackOrder.length;
  const r = ex<{ patternIds: string[]; clipIds: string[] }>('playlist.splitByChannel', { clipIds: [src] });
  assert.equal(r.patternIds.length, 3);
  assert.equal(r.clipIds.length, 3);
  assert.equal(host.project.playlist.clips[src], undefined);
  const p = host.project;
  const names = r.patternIds.map((id) => p.patterns[id].name);
  assert.deepEqual(names, [`${p.patterns[pat].name} – ${p.channels[kick].name}`, `${p.patterns[pat].name} – ${p.channels[snare].name}`, `${p.patterns[pat].name} – ${p.channels[bass].name}`]);
  for (const id of r.patternIds) assert.equal(p.patterns[id].length, BAR * 2);
  assert.deepEqual(Object.keys(p.patterns[r.patternIds[0]].notes), [kick]);
  assert.equal(Object.keys(p.patterns[r.patternIds[0]].notes[kick]).length, 2);
  assert.equal(p.patterns[r.patternIds[2]].color, p.channels[bass].color);
  // note ids are fresh
  const srcIds = new Set(Object.keys(p.patterns[pat].notes[kick]));
  for (const id of Object.keys(p.patterns[r.patternIds[0]].notes[kick])) assert.ok(!srcIds.has(id));
  const out = r.clipIds.map((id) => p.playlist.clips[id]);
  assert.equal(out[0].trackId, tracks[0]);
  for (const c of out) {
    assert.equal(c.start, BAR);
    assert.equal(c.offset, 120);
  }
  // track 2 was busy → a new track was inserted at index 1, the third goes right after it
  assert.equal(p.playlist.trackOrder.length, nTracks + 2);
  assert.equal(p.playlist.trackOrder.indexOf(out[1].trackId), 1);
  assert.equal(p.playlist.trackOrder.indexOf(out[2].trackId), 2);
  assert.equal(p.playlist.tracks[out[1].trackId].name, p.channels[snare].name);
  ok(host);
  // one undo step restores everything
  host.undo(USER);
  assert.ok(host.project.playlist.clips[src]);
  assert.equal(host.project.playlist.trackOrder.length, nTracks);
  assert.equal(host.project.patterns[r.patternIds[0]], undefined);
});

test('split by channel reuses a free following track and refuses empty patterns', () => {
  const { host, pat, kick, snare, tracks, ex } = fresh();
  ex('notes.clear', { patternId: pat });
  ex('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 36 }] });
  ex('notes.add', { patternId: pat, channelId: snare, notes: [{ tick: 480, key: 38 }] });
  const src = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, patternId: pat }).id;
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR * 4, patternId: pat }); // later: no overlap
  const n = host.project.playlist.trackOrder.length;
  const r = ex<{ clipIds: string[] }>('playlist.splitByChannel', { clipIds: [src] });
  assert.equal(host.project.playlist.trackOrder.length, n);
  assert.equal(host.project.playlist.clips[r.clipIds[1]].trackId, tracks[1]);
  const empty = ex<{ id: string }>('patterns.add', { select: false }).id;
  const e = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[2], start: 0, patternId: empty }).id;
  const bad = host.exec('playlist.splitByChannel', { clipIds: [e] }, { actor: USER });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /has no notes to split/);
});

test('consolidate renders offset, looping and the clip-end cut into one pattern', () => {
  const { host, pat, kick, bass, tracks, ex } = fresh();
  ex('notes.clear', { patternId: pat });
  ex('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 36, dur: 240 }, { tick: 1920, key: 36, dur: 240 }] });
  ex('patterns.set', { id: pat, length: BAR }); // 3840 ticks
  const p2 = ex<{ id: string }>('patterns.add', { select: false }).id;
  ex('notes.add', { patternId: p2, channelId: bass, notes: [{ tick: 0, key: 40, dur: 3000 }] });
  // clip A: offset 1920, length 2 bars → plays pattern from 1920 and loops
  const a = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR, length: BAR * 2, offset: 1920, patternId: pat }).id;
  // clip B: muted, on the top track, cut short (bass note 3000 long cut at 1000)
  const b = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: BAR * 2, length: 1000, patternId: p2 }).id;
  ex('playlist.updateClips', { updates: [{ id: b, mute: true }] });
  const r = ex<{ patternId: string; clipId: string }>('playlist.consolidate', { clipIds: [a, b] });
  const p = host.project;
  assert.equal(p.playlist.clips[a], undefined);
  assert.equal(p.playlist.clips[b], undefined);
  const c = p.playlist.clips[r.clipId];
  assert.equal(c.trackId, tracks[0]); // topmost involved track
  assert.equal(c.start, BAR);
  assert.equal(c.length, BAR * 2);
  const np = p.patterns[r.patternId];
  assert.equal(np.length, BAR * 2);
  // kick: source ticks 1920 (at song BAR), 3840+0 (BAR+1920), 3840+1920 (BAR+3840), 7680 (BAR+5760)
  const kicks = Object.values(np.notes[kick]).map((n) => n.tick).sort((x, y) => x - y);
  assert.deepEqual(kicks, [0, 1920, 3840, 5760]);
  const bassNotes = Object.values(np.notes[bass]);
  assert.equal(bassNotes.length, 1);
  assert.equal(bassNotes[0].tick, BAR);
  assert.equal(bassNotes[0].dur, 1000); // cut at the clip end
  assert.equal(bassNotes[0].mute, true); // came from a muted clip
  assert.equal(patternLength(np, p.transport.timeSig), BAR * 2);
  ok(host);
});

test('cloneClips makes one unique pattern copy per source pattern', () => {
  const { host, pat, tracks, ex } = fresh();
  const a = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, patternId: pat }).id;
  const b = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: 0, patternId: pat }).id;
  const len = host.project.playlist.clips[a].length;
  const r = ex<{ ids: string[]; patternIds: string[] }>('playlist.cloneClips', { ids: [a, b] });
  assert.equal(r.ids.length, 2);
  assert.equal(r.patternIds.length, 1);
  const p = host.project;
  const [ca, cb] = r.ids.map((id) => p.playlist.clips[id]);
  assert.equal(ca.patternId, r.patternIds[0]);
  assert.equal(cb.patternId, r.patternIds[0]);
  assert.equal(ca.start, len);
  assert.notEqual(r.patternIds[0], pat);
  assert.match(p.patterns[r.patternIds[0]].name, /#\d+$/);
  // editing the clone's pattern leaves the source alone
  const before = JSON.stringify(p.patterns[pat].notes);
  ex('notes.clear', { patternId: r.patternIds[0] });
  assert.equal(JSON.stringify(host.project.patterns[pat].notes), before);
  ok(host);
});

test('insertTime moves later clips, splits crossing clips, shifts markers and the loop', () => {
  const { host, pat, tracks, ex } = fresh();
  const before = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, length: BAR, patternId: pat }).id;
  const cross = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR, length: BAR * 2, offset: 0, patternId: pat }).id;
  const after = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[2], start: BAR * 2, length: BAR, patternId: pat }).id;
  const m1 = ex<{ id: string }>('playlist.addMarker', { tick: BAR, name: 'Verse' }).id;
  const m2 = ex<{ id: string }>('playlist.addMarker', { tick: BAR * 3, name: 'Hook' }).id;
  ex('transport.set', { loop: { enabled: true, start: BAR, end: BAR * 4 } });
  const r = ex<{ moved: number; split: number }>('playlist.insertTime', { at: BAR * 2, length: BAR });
  assert.deepEqual(r, { moved: 1, split: 1 });
  const p = host.project;
  assert.equal(p.playlist.clips[before].start, 0);
  assert.equal(p.playlist.clips[after].start, BAR * 3);
  assert.equal(p.playlist.clips[cross].length, BAR);
  const right = clips(host).find((c) => c.trackId === tracks[1] && c.id !== cross)!;
  assert.equal(right.start, BAR * 3);
  assert.equal(right.offset, BAR);
  assert.equal(right.length, BAR);
  assert.equal(p.playlist.markers[m1].tick, BAR);
  assert.equal(p.playlist.markers[m2].tick, BAR * 4);
  assert.deepEqual(p.transport.loop, { enabled: true, start: BAR, end: BAR * 5 }); // contained the point → stretched
  ex('playlist.insertTime', { at: 0, length: BAR });
  assert.deepEqual(host.project.transport.loop, { enabled: true, start: BAR * 2, end: BAR * 6 }); // after the point → moved
  ok(host);
});

test('deleteTime removes, trims, joins and shifts; loop collapses to off', () => {
  const { host, pat, tracks, ex } = fresh();
  const inside = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: BAR * 2, length: BAR, patternId: pat }).id;
  const leftCut = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR, length: BAR * 2, patternId: pat }).id;
  const rightCut = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[2], start: BAR * 3, length: BAR * 2, offset: 60, patternId: pat }).id;
  const spans = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[3], start: BAR, length: BAR * 4, patternId: pat }).id;
  const later = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[4], start: BAR * 6, length: BAR, patternId: pat }).id;
  const mIn = ex<{ id: string }>('playlist.addMarker', { tick: BAR * 2 + 10, name: 'gone' }).id;
  const mAfter = ex<{ id: string }>('playlist.addMarker', { tick: BAR * 5, name: 'kept' }).id;
  ex('transport.set', { loop: { enabled: true, start: BAR * 2, end: BAR * 4 } });
  // delete bars 3..4 (ticks 2·BAR .. 4·BAR)
  const r = ex<{ removed: number; trimmed: number; moved: number }>('playlist.deleteTime', { start: BAR * 2, end: BAR * 4 });
  assert.deepEqual(r, { removed: 1, trimmed: 3, moved: 1 });
  const p = host.project;
  assert.equal(p.playlist.clips[inside], undefined);
  assert.deepEqual([p.playlist.clips[leftCut].start, p.playlist.clips[leftCut].length], [BAR, BAR]);
  const rc = p.playlist.clips[rightCut];
  assert.deepEqual([rc.start, rc.length, rc.offset], [BAR * 2, BAR, 60 + BAR]);
  assert.deepEqual([p.playlist.clips[spans].start, p.playlist.clips[spans].length], [BAR, BAR]);
  const joined = clips(host).find((c) => c.trackId === tracks[3] && c.id !== spans)!;
  assert.deepEqual([joined.start, joined.length, joined.offset], [BAR * 2, BAR, BAR * 3]);
  assert.equal(p.playlist.clips[later].start, BAR * 4);
  assert.equal(p.playlist.markers[mIn], undefined);
  assert.equal(p.playlist.markers[mAfter].tick, BAR * 3);
  assert.equal(p.transport.loop.enabled, false); // the whole loop region was deleted
  ok(host);
  const bad = host.exec('playlist.deleteTime', { start: 100, end: 100 }, { actor: USER });
  assert.equal(bad.ok, false);
  // one undo step
  host.undo(USER);
  assert.ok(host.project.playlist.clips[inside]);
  assert.equal(host.project.transport.loop.enabled, true);
});

test('deleteTime remaps a loop region that survives', () => {
  const { host, ex } = fresh();
  ex('transport.set', { loop: { enabled: true, start: BAR, end: BAR * 5 } });
  ex('playlist.deleteTime', { start: BAR * 2, end: BAR * 3 });
  assert.deepEqual(host.project.transport.loop, { enabled: true, start: BAR, end: BAR * 4 });
  ex('playlist.deleteTime', { start: 0, end: BAR * 2 });
  assert.deepEqual(host.project.transport.loop, { enabled: true, start: 0, end: BAR * 2 });
});

void run('arrange tools');
