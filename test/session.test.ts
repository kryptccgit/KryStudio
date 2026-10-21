import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { checkIntegrity, type Clip } from '@shared/schema/project';
import { MAX_SCENES } from '@shared/schema/launcher';
import { CATALOG } from '@shared/plugins/catalog';
import { PPQ } from '@shared/schema/time';

const BAR = PPQ * 4;

function fresh() {
  const p = createDefaultProject('Session');
  p.playlist.clips = {};
  p.playlist.markers = {};
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const [kick, snare] = p.channelOrder;
  const tracks = p.playlist.trackOrder;
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = host.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const no = (cmd: string, args: unknown, re: RegExp): void => {
    const r = host.exec(cmd, args, { actor: USER });
    assert.equal(r.ok, false, `${cmd} should fail`);
    assert.match(r.message ?? '', re);
  };
  const pattern = (name: string, length: number): string => {
    const id = ex<{ id: string }>('patterns.add', { name, length, select: false }).id;
    ex('notes.add', { patternId: id, channelId: kick, notes: [{ tick: 0, key: 36 }] });
    return id;
  };
  const audio = (): { channelId: string; clipId: string } => {
    const r = ex<{ channelId: string; clipId: string }>('playlist.addAudio', { path: 'C:/loops/loop.wav', trackId: tracks[15], start: 0, frames: 4 * 48000, sampleRate: 48000 });
    ex('playlist.removeClips', { ids: [r.clipId] });
    return r;
  };
  return { host, pat, kick, snare, tracks, ex, no, pattern, audio };
}

const ok = (host: DocHost) => assert.deepEqual(checkIntegrity(host.project), []);
const lclips = (host: DocHost) => Object.values(host.project.session?.clips ?? {});
const onTrack = (host: DocHost, trackId: string): Clip[] =>
  Object.values(host.project.playlist.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
const spans = (cs: Clip[]) => cs.map((c) => [c.start, c.length, c.offset]);

test('scenes: the session is created on first use; add / name / index / set / move / remove; one undo removes the new session', () => {
  const { host, ex, no } = fresh();
  assert.equal(host.project.session, undefined);
  const a = ex<{ id: string }>('session.addScene', {}).id;
  const s = host.project.session!;
  assert.equal(s.quantize, '1bar');
  assert.deepEqual(s.scenes[a], { id: a, name: 'Scene 1', color: null, tempo: null });
  assert.match(a, /^scn_/);
  const b = ex<{ id: string }>('session.addScene', { name: 'Drop', tempo: 128, color: '#EC4899' }).id;
  const c = ex<{ id: string }>('session.addScene', { index: 0 }).id;
  assert.deepEqual(host.project.session!.sceneOrder, [c, a, b]);
  assert.equal(host.project.session!.scenes[c].name, 'Scene 3');
  ex('session.setScene', { id: a, name: 'Intro', tempo: 120.5, color: '#22C55E' });
  assert.deepEqual(host.project.session!.scenes[a], { id: a, name: 'Intro', color: '#22C55E', tempo: 120.5 });
  ex('session.setScene', { id: a, tempo: null, color: null });
  assert.equal(host.project.session!.scenes[a].tempo, null);
  assert.equal(host.project.session!.scenes[a].color, null);
  ex('session.moveScene', { id: c, toIndex: 99 });
  assert.deepEqual(host.project.session!.sceneOrder, [a, b, c]);
  ex('session.moveScene', { id: b, toIndex: 0 });
  assert.deepEqual(host.project.session!.sceneOrder, [b, a, c]);
  no('session.setScene', { id: 'scn_nope', name: 'x' }, /Scene scn_nope not found/);
  no('session.addScene', { tempo: 5 }, /tempo/);
  ex('session.removeScene', { id: a });
  assert.deepEqual(host.project.session!.sceneOrder, [b, c]);
  assert.equal(host.project.session!.scenes[a], undefined);
  ok(host);
  for (let i = 0; i < 9; i++) host.undo(USER);
  assert.equal(host.project.session, undefined);
});

test(`scenes: at most ${MAX_SCENES}`, () => {
  const { host, no } = fresh();
  const steps = Array.from({ length: MAX_SCENES }, () => ({ cmd: 'session.addScene', args: {} }));
  assert.equal(host.execBatch(steps, { actor: USER }).ok, true);
  no('session.addScene', {}, new RegExp(`at most ${MAX_SCENES}`));
});

test('setClip: pattern defaults, replace keeps the id, one clip per slot; removing a scene removes its row', () => {
  const { host, pat, tracks, ex, pattern } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const s2 = ex<{ id: string }>('session.addScene', {}).id;
  const long = pattern('Long', BAR * 2);
  const r = ex<{ id: string; replaced: boolean }>('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat });
  assert.equal(r.replaced, false);
  assert.match(r.id, /^lc_/);
  assert.deepEqual(host.project.session!.clips[r.id], { id: r.id, trackId: tracks[0], sceneId: s1, kind: 'pattern', patternId: pat, color: null, length: BAR, offset: 0, loop: true, launchMode: 'trigger' });
  const r2 = ex<{ id: string; replaced: boolean }>('session.setClip', {
    trackId: tracks[0],
    sceneId: s1,
    patternId: long,
    name: 'Verse',
    color: '#06B6D4',
    offset: 240,
    loop: false,
    launchMode: 'gate',
    quantize: '1/4',
    follow: { action: 'next', afterBars: 4 },
  });
  assert.equal(r2.id, r.id);
  assert.equal(r2.replaced, true);
  const c = host.project.session!.clips[r.id];
  assert.equal(c.patternId, long);
  assert.equal(c.length, BAR * 2);
  assert.equal(c.name, 'Verse');
  assert.equal(c.offset, 240);
  assert.equal(c.loop, false);
  assert.equal(c.launchMode, 'gate');
  assert.equal(c.quantize, '1/4');
  assert.deepEqual(c.follow, { action: 'next', chance: 1, otherAction: 'none', afterBars: 4 });
  assert.equal(lclips(host).length, 1);
  ex('session.setClip', { trackId: tracks[1], sceneId: s1, patternId: pat, length: 480 });
  ex('session.setClip', { trackId: tracks[0], sceneId: s2, patternId: pat });
  assert.equal(lclips(host).find((x) => x.trackId === tracks[1])!.length, 480);
  assert.equal(lclips(host).length, 3);
  ex('session.removeScene', { id: s1 });
  assert.deepEqual(lclips(host).map((x) => x.sceneId), [s2]);
  ok(host);
});

test('setClip: audio clip defaults (length at the tempo rounded up to a bar, gain 1) and refusals', () => {
  const { host, pat, kick, tracks, ex, no, audio } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const { channelId } = audio();
  const id = ex<{ id: string }>('session.setClip', { trackId: tracks[2], sceneId: s1, channelId }).id;
  const c = host.project.session!.clips[id];
  assert.equal(c.kind, 'audio');
  assert.equal(c.channelId, channelId);
  assert.equal(c.patternId, undefined);
  assert.equal(c.gain, 1);
  assert.equal(c.length, BAR * 3, '4 s at 140 bpm = 8960 ticks → 3 bars');
  no('session.setClip', { trackId: tracks[2], sceneId: s1, channelId: kick }, /not an audio clip channel/);
  no('session.setClip', { trackId: tracks[2], sceneId: s1 }, /exactly one source/);
  no('session.setClip', { trackId: tracks[2], sceneId: s1, patternId: pat, channelId }, /exactly one source/);
  no('session.setClip', { trackId: 'trk_x', sceneId: s1, patternId: pat }, /Track trk_x not found/);
  no('session.setClip', { trackId: tracks[2], sceneId: 'scn_x', patternId: pat }, /Scene scn_x not found/);
  no('session.setClip', { trackId: tracks[2], sceneId: s1, patternId: 'pat_x' }, /Pattern pat_x not found/);
  no('session.setClip', { trackId: tracks[2], sceneId: s1, channelId: 'ch_x' }, /Channel ch_x not found/);
  ok(host);
});

test('updateClip: edits fields; null clears name / quantize / follow; gain only on audio', () => {
  const { host, pat, tracks, ex, no, audio } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const id = ex<{ id: string }>('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat, name: 'A', quantize: '2bars', follow: { action: 'any', chance: 0.5, otherAction: 'stop', afterBars: 2 } }).id;
  ex('session.updateClip', { id, length: 1920, offset: 480, loop: false, launchMode: 'toggle', color: '#ffffff' });
  let c = host.project.session!.clips[id];
  assert.deepEqual([c.length, c.offset, c.loop, c.launchMode, c.color], [1920, 480, false, 'toggle', '#ffffff']);
  ex('session.updateClip', { id, name: null, quantize: null, follow: null });
  c = host.project.session!.clips[id];
  assert.equal('name' in c, false);
  assert.equal('quantize' in c, false);
  assert.equal('follow' in c, false);
  ex('session.updateClip', { id, follow: { action: 'again', afterBars: 0.5 } });
  assert.deepEqual(host.project.session!.clips[id].follow, { action: 'again', chance: 1, otherAction: 'none', afterBars: 0.5 });
  no('session.updateClip', { id, gain: 0.5 }, /Only audio launch clips have a gain/);
  no('session.updateClip', { id, follow: { action: 'next', afterBars: 0 } }, /afterBars/);
  no('session.updateClip', { id: 'lc_x', loop: true }, /Launch clip lc_x not found/);
  const { channelId } = audio();
  const aid = ex<{ id: string }>('session.setClip', { trackId: tracks[1], sceneId: s1, channelId }).id;
  ex('session.updateClip', { id: aid, gain: 0.5 });
  assert.equal(host.project.session!.clips[aid].gain, 0.5);
  ok(host);
});

test('removeClip ({id} / {ids}) and moveClip (move, copy, replacing the occupant)', () => {
  const { host, pat, tracks, ex, no, pattern } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const s2 = ex<{ id: string }>('session.addScene', {}).id;
  const other = pattern('Other', BAR);
  const a = ex<{ id: string }>('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat, follow: { action: 'next', afterBars: 1 } }).id;
  const b = ex<{ id: string }>('session.setClip', { trackId: tracks[1], sceneId: s2, patternId: other }).id;
  assert.equal(ex<{ id: string }>('session.moveClip', { id: a, trackId: tracks[1], sceneId: s2 }).id, a);
  assert.equal(host.project.session!.clips[b], undefined);
  assert.deepEqual([host.project.session!.clips[a].trackId, host.project.session!.clips[a].sceneId], [tracks[1], s2]);
  const cp = ex<{ id: string }>('session.moveClip', { id: a, trackId: tracks[0], sceneId: s1, copy: true }).id;
  assert.notEqual(cp, a);
  const copy = host.project.session!.clips[cp];
  assert.deepEqual([copy.trackId, copy.sceneId, copy.patternId], [tracks[0], s1, pat]);
  assert.deepEqual(copy.follow, host.project.session!.clips[a].follow);
  ex('session.updateClip', { id: cp, follow: { action: 'stop', afterBars: 2 } });
  assert.equal(host.project.session!.clips[a].follow!.action, 'next', 'the copy does not share the follow rule');
  const before = host.version;
  ex('session.moveClip', { id: a, trackId: tracks[1], sceneId: s2 });
  assert.equal(host.version, before);
  no('session.moveClip', { id: a, trackId: tracks[1], sceneId: s2, copy: true }, /different slot/);
  ex('session.removeClip', { ids: [a, cp] });
  assert.equal(lclips(host).length, 0);
  no('session.removeClip', {}, /Say which launch clip/);
  no('session.removeClip', { id: 'lc_gone' }, /not found/);
  ok(host);
});

test('setQuantize creates the session and validates the value', () => {
  const { host, ex, no } = fresh();
  ex('session.setQuantize', { quantize: '1/16' });
  assert.equal(host.project.session!.quantize, '1/16');
  no('session.setQuantize', { quantize: '3bars' }, /quantize/);
});

test('capture: a span inside an existing clip splits it; edges trim; covered clips go; automation stays; one undo step', () => {
  const { host, pat, tracks, ex, pattern } = fresh();
  const t = tracks[0];
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const p2 = pattern('Two bars', BAR * 2);
  const lc = ex<{ id: string }>('session.setClip', { trackId: t, sceneId: s1, patternId: p2 }).id;
  const big = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: t, start: 0, length: BAR * 8, patternId: pat }).id;
  const aut = ex<{ id: string }>('automation.create', { target: `channel/${host.project.channelOrder[0]}/volume`, trackId: t, start: 0 });
  void aut;
  const autClips = () => onTrack(host, t).filter((c) => c.kind === 'automation').length;
  const autBefore = autClips();
  const r = ex<{ placed: number; spans: number; skipped: number }>('session.capture', { entries: [{ trackId: t, clipId: lc, startTick: BAR * 2, endTick: BAR * 4, offset: BAR * 3 }] });
  assert.deepEqual(r, { placed: 1, spans: 1, skipped: 0 });
  const cs = onTrack(host, t).filter((c) => c.kind === 'pattern');
  assert.deepEqual(spans(cs), [
    [0, BAR * 2, 0],
    [BAR * 2, BAR * 2, BAR],
    [BAR * 4, BAR * 4, BAR * 4],
  ]);
  assert.equal(cs[0].id, big);
  assert.equal(cs[1].patternId, p2);
  assert.equal(cs[2].patternId, pat);
  assert.equal(autClips(), autBefore, 'automation clips are untouched');
  ok(host);
  host.undo(USER);
  assert.deepEqual(spans(onTrack(host, t).filter((c) => c.kind === 'pattern')), [[0, BAR * 8, 0]]);
});

test('capture: spans over several clips (left trim, right cut with offset, removal) and per-track independence', () => {
  const { host, pat, tracks, ex } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const lc = ex<{ id: string }>('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat }).id;
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, length: BAR * 3, patternId: pat, offset: 120 });
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: BAR * 3, length: BAR, patternId: pat });
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: BAR * 4, length: BAR * 4, patternId: pat });
  const other = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: 0, length: BAR * 8, patternId: pat }).id;
  ex('session.capture', { entries: [{ trackId: tracks[0], clipId: lc, startTick: BAR * 2, endTick: BAR * 5, offset: 0 }] });
  assert.deepEqual(spans(onTrack(host, tracks[0])), [
    [0, BAR * 2, 120],
    [BAR * 2, BAR * 3, 0],
    [BAR * 5, BAR * 3, BAR],
  ]);
  assert.deepEqual(spans(onTrack(host, tracks[1])), [[0, BAR * 8, 0]]);
  assert.ok(host.project.playlist.clips[other]);
  ok(host);
});

test('capture: loop offsets — a loop that is not whole pattern lengths is tiled pass by pass; one-shots play once', () => {
  const { host, pat, tracks, ex } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const lc = ex<{ id: string }>('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat, offset: 240, length: 960 }).id;
  ex('session.capture', { entries: [{ trackId: tracks[0], clipId: lc, startTick: 0, endTick: 2400, offset: 480 }] });
  assert.deepEqual(spans(onTrack(host, tracks[0])), [
    [0, 720, 480],
    [720, 960, 240],
    [1680, 720, 240],
  ]);
  const once = ex<{ id: string }>('session.setClip', { trackId: tracks[1], sceneId: s1, patternId: pat, length: 1920, loop: false }).id;
  ex('session.capture', { entries: [{ trackId: tracks[1], clipId: once, startTick: BAR, endTick: BAR * 3, offset: 0 }] });
  assert.deepEqual(spans(onTrack(host, tracks[1])), [[BAR, 1920, 0]]);
  ok(host);
});

test('capture: audio launch clips tile with the channel, gain and zero fades; deleted clips / tracks and empty spans are skipped', () => {
  const { host, tracks, ex, audio } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const { channelId } = audio();
  const lc = ex<{ id: string }>('session.setClip', { trackId: tracks[3], sceneId: s1, channelId, length: BAR * 2, offset: BAR }).id;
  ex('session.updateClip', { id: lc, gain: 0.7 });
  const r = ex<{ placed: number; spans: number; skipped: number }>('session.capture', {
    entries: [
      { trackId: tracks[3], clipId: lc, startTick: 0, endTick: BAR * 5, offset: BAR * 2 },
      { trackId: tracks[3], clipId: 'lc_deleted', startTick: BAR * 6, endTick: BAR * 7, offset: 0 },
      { trackId: 'trk_gone', clipId: lc, startTick: 0, endTick: BAR, offset: 0 },
      { trackId: tracks[4], clipId: lc, startTick: BAR, endTick: BAR, offset: 0 },
    ],
  });
  assert.deepEqual(r, { placed: 3, spans: 1, skipped: 3 });
  const cs = onTrack(host, tracks[3]);
  assert.deepEqual(spans(cs), [
    [0, BAR, BAR * 2],
    [BAR, BAR * 2, BAR],
    [BAR * 3, BAR * 2, BAR],
  ]);
  for (const c of cs) {
    assert.equal(c.kind, 'audio');
    assert.equal(c.channelId, channelId);
    assert.equal(c.gain, 0.7);
    assert.equal(c.fadeIn, 0);
    assert.equal(c.fadeOut, 0);
  }
  ok(host);
  const v = host.version;
  ex('session.capture', { entries: [{ trackId: tracks[3], clipId: 'lc_deleted', startTick: 0, endTick: BAR, offset: 0 }] });
  assert.equal(host.version, v);
});

test('capture: an audio clip crossing the span keeps its fades on the outer edges', () => {
  const { host, tracks, ex, audio } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const { channelId } = audio();
  const lc = ex<{ id: string }>('session.setClip', { trackId: tracks[2], sceneId: s1, channelId }).id;
  const a = ex<{ id: string }>('playlist.addClip', { kind: 'audio', trackId: tracks[2], start: 0, length: BAR * 4, channelId }).id;
  ex('playlist.updateClips', { updates: [{ id: a, fadeIn: 100, fadeOut: 200 }] });
  ex('session.capture', { entries: [{ trackId: tracks[2], clipId: lc, startTick: BAR, endTick: BAR * 2, offset: 0 }] });
  const cs = onTrack(host, tracks[2]);
  assert.deepEqual(spans(cs), [
    [0, BAR, 0],
    [BAR, BAR, 0],
    [BAR * 2, BAR * 2, BAR * 2],
  ]);
  assert.deepEqual([cs[0].fadeIn, cs[0].fadeOut], [100, 0]);
  assert.deepEqual([cs[2].fadeIn, cs[2].fadeOut], [0, 200]);
  ok(host);
});

test('fromArrangement with markers: one scene per section named after the marker; covering clips become slots (length capped, offset kept)', () => {
  const { host, pat, tracks, ex, no, pattern, audio } = fresh();
  no('session.fromArrangement', {}, /no pattern or audio clips/);
  const eight = pattern('Eight', BAR * 8);
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: BAR * 2, length: BAR * 6, patternId: pat, offset: 240 });
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR * 4, length: BAR * 8, patternId: eight });
  const { channelId } = audio();
  ex('playlist.addClip', { kind: 'audio', trackId: tracks[2], start: BAR * 8, length: BAR * 2, channelId, offset: 480 });
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[3], start: 0, length: BAR * 12, patternId: pat });
  ex('playlist.updateClips', { updates: [{ id: onTrack(host, tracks[3])[0].id, mute: true }] });
  ex('playlist.addMarker', { tick: BAR * 2, name: 'Intro' });
  ex('playlist.addMarker', { tick: BAR * 8, name: 'Drop' });
  const r = ex<{ sceneIds: string[]; clips: number }>('session.fromArrangement', {});
  const s = host.project.session!;
  assert.deepEqual(r.sceneIds.map((id) => s.scenes[id].name), ['Intro', 'Drop'], 'nothing unmuted before the first marker: no "Start" scene');
  assert.equal(r.clips, 3);
  const at = (trackId: string, sceneId: string) => Object.values(s.clips).find((c) => c.trackId === trackId && c.sceneId === sceneId);
  const [intro, drop] = r.sceneIds;
  assert.deepEqual([at(tracks[0], intro)!.patternId, at(tracks[0], intro)!.length, at(tracks[0], intro)!.offset], [pat, BAR * 6, 240]);
  assert.equal(at(tracks[1], intro), undefined, 'T2 starts after the section start');
  assert.equal(at(tracks[0], drop), undefined);
  assert.deepEqual([at(tracks[1], drop)!.length, at(tracks[1], drop)!.offset], [BAR * 4, BAR * 4]);
  const au = at(tracks[2], drop)!;
  assert.deepEqual([au.kind, au.channelId, au.length, au.offset, au.gain], ['audio', channelId, BAR * 2, 480, 1]);
  assert.equal(at(tracks[3], intro), undefined, 'muted clips are skipped');
  ok(host);
  host.undo(USER);
  assert.equal(host.project.session, undefined);
});

test('fromArrangement: a "Start" scene before the first marker; without markers every N bars', () => {
  const { host, pat, tracks, ex } = fresh();
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, length: BAR * 10, patternId: pat });
  ex('playlist.addMarker', { tick: BAR * 4, name: 'Verse' });
  let r = ex<{ sceneIds: string[]; clips: number }>('session.fromArrangement', {});
  let s = host.project.session!;
  assert.deepEqual(r.sceneIds.map((id) => s.scenes[id].name), ['Start', 'Verse']);
  const verse = Object.values(s.clips).find((c) => c.sceneId === r.sceneIds[1])!;
  assert.deepEqual([verse.offset, verse.length], [0, BAR * 6]);
  host.undo(USER);
  ex('playlist.removeMarker', { id: Object.keys(host.project.playlist.markers)[0] });
  r = ex<{ sceneIds: string[]; clips: number }>('session.fromArrangement', { barsPerScene: 4 });
  s = host.project.session!;
  assert.deepEqual(r.sceneIds.map((id) => s.scenes[id].name), ['Bars 1-4', 'Bars 5-8', 'Bars 9-12']);
  assert.deepEqual(Object.values(s.clips).map((c) => c.length).sort((a, b) => a - b), [BAR * 2, BAR * 4, BAR * 4], 'the last section is capped at the clip end');
  ex('session.addScene', { name: 'Mine' });
  r = ex<{ sceneIds: string[]; clips: number }>('session.fromArrangement', { barsPerScene: 8 });
  assert.equal(host.project.session!.sceneOrder.length, 6);
  assert.equal(host.project.session!.scenes[host.project.session!.sceneOrder[3]].name, 'Mine');
  ok(host);
});

test('scenesToSong: scenes in order for N bars each; loops fill, one-shots play once; one undo step', () => {
  const { host, pat, tracks, ex, no, pattern } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', { name: 'A' }).id;
  const s2 = ex<{ id: string }>('session.addScene', { name: 'B' }).id;
  const two = pattern('Two', BAR * 2);
  ex('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat });
  ex('session.setClip', { trackId: tracks[1], sceneId: s1, patternId: two, length: BAR * 3 });
  ex('session.setClip', { trackId: tracks[0], sceneId: s2, patternId: two, loop: false });
  const r = ex<{ clips: number; start: number; end: number }>('session.scenesToSong', { order: [{ sceneId: s1, bars: 4 }, { sceneId: s2, bars: 4 }, { sceneId: s1, bars: 2 }] });
  assert.deepEqual([r.start, r.end], [0, BAR * 10]);
  assert.deepEqual(spans(onTrack(host, tracks[0])), [
    [0, BAR * 4, 0],
    [BAR * 4, BAR * 2, 0],
    [BAR * 8, BAR * 2, 0],
  ]);
  assert.deepEqual(spans(onTrack(host, tracks[1])), [
    [0, BAR * 3, 0],
    [BAR * 3, BAR, 0],
    [BAR * 8, BAR * 2, 0],
  ]);
  assert.equal(r.clips, 6);
  ok(host);
  const r2 = ex<{ clips: number; start: number; end: number }>('session.scenesToSong', { order: [{ sceneId: s2, bars: 1 }] });
  assert.equal(r2.start, BAR * 10);
  host.undo(USER);
  host.undo(USER);
  assert.equal(Object.keys(host.project.playlist.clips).length, 0);
  no('session.scenesToSong', { order: [{ sceneId: 'scn_x', bars: 1 }] }, /Scene scn_x not found/);
});

test('scenesToSong at an explicit tick clears the launcher tracks there but leaves other tracks alone', () => {
  const { host, pat, tracks, ex } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  ex('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat });
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, length: BAR * 8, patternId: pat });
  ex('playlist.addClip', { kind: 'pattern', trackId: tracks[5], start: 0, length: BAR * 8, patternId: pat });
  ex('session.scenesToSong', { order: [{ sceneId: s1, bars: 2 }], at: BAR * 2 });
  assert.deepEqual(spans(onTrack(host, tracks[0])), [
    [0, BAR * 2, 0],
    [BAR * 2, BAR * 2, 0],
    [BAR * 4, BAR * 4, BAR * 4],
  ]);
  assert.deepEqual(spans(onTrack(host, tracks[5])), [[0, BAR * 8, 0]]);
  ok(host);
});

test('deleting a track, a pattern or an audio channel removes the launch clips that use it (integrity stays clean, undo restores)', () => {
  const { host, pat, tracks, ex, pattern, audio } = fresh();
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const s2 = ex<{ id: string }>('session.addScene', {}).id;
  const other = pattern('Other', BAR);
  const { channelId } = audio();
  const onT0 = ex<{ id: string }>('session.setClip', { trackId: tracks[0], sceneId: s1, patternId: pat }).id;
  const otherClip = ex<{ id: string }>('session.setClip', { trackId: tracks[1], sceneId: s1, patternId: other }).id;
  const otherClip2 = ex<{ id: string }>('session.setClip', { trackId: tracks[1], sceneId: s2, patternId: other }).id;
  const audioClip = ex<{ id: string }>('session.setClip', { trackId: tracks[2], sceneId: s2, channelId }).id;
  const keep = ex<{ id: string }>('session.setClip', { trackId: tracks[2], sceneId: s1, patternId: pat }).id;

  ex('playlist.removeTrack', { id: tracks[0] });
  assert.equal(host.project.session!.clips[onT0], undefined);
  ok(host);
  ex('patterns.remove', { id: other });
  assert.equal(host.project.session!.clips[otherClip], undefined);
  assert.equal(host.project.session!.clips[otherClip2], undefined);
  ok(host);
  ex('channels.remove', { ids: [channelId] });
  assert.equal(host.project.session!.clips[audioClip], undefined);
  assert.ok(host.project.session!.clips[keep], 'unrelated clips stay');
  ok(host);
  host.undo(USER);
  host.undo(USER);
  host.undo(USER);
  assert.equal(lclips(host).length, 5);
  ok(host);
});

await run('session');
