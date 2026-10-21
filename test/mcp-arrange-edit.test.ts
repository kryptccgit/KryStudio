import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, type Clip } from '@shared/schema/project';
import { PPQ } from '@shared/schema/time';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const BAR = PPQ * 4;

function rig() {
  const p = createDefaultProject('Edit');
  p.playlist.clips = {};
  const doc = new DocHost(p, CATALOG, { strict: true });
  const deps = {
    doc,
    getSettings: () => ({ mcp: { requireConsentForDestructive: false } }) as Settings,
    broadcast: () => {},
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown) => callTool(deps, caller, name, args, { quiet: true });
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = doc.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const clip = (id: string): Clip => doc.project.playlist.clips[id];
  const sound = () => assert.deepEqual(checkIntegrity(doc.project), []);
  return { doc, call, ex, clip, sound, pat: p.transport.activePatternId!, tracks: p.playlist.trackOrder };
}

test('edit_clips: move, change lanes together, resize, trim the left edge; one undo step', async () => {
  const { doc, call, ex, clip, sound, pat, tracks } = rig();
  const a = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, length: BAR * 4, patternId: pat }).id;
  const b = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[1], start: BAR * 4, length: BAR * 4, patternId: pat }).id;
  const v = doc.getHistory().length;
  const r = await call('edit_clips', { ids: [a, b], shift_bars: 2, to_track: 3 });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([clip(a).start, clip(a).trackId, clip(b).start, clip(b).trackId], [BAR * 2, tracks[2], BAR * 6, tracks[3]], 'lane spacing kept');
  assert.equal(doc.getHistory().length, v + 1, 'one undo step');
  assert.equal((await call('edit_clips', { ids: [a], to_bar: 9, length_bars: 2 })).ok, true);
  assert.deepEqual([clip(a).start, clip(a).length], [BAR * 8, BAR * 2]);
  assert.equal((await call('edit_clips', { ids: [b], trim_start_bars: 1 })).ok, true);
  assert.deepEqual([clip(b).start, clip(b).offset, clip(b).length], [BAR * 7, BAR, BAR * 3]);
  assert.equal((await call('edit_clips', { ids: [b], trim_start_bars: -5 })).ok, true, 'reveals no further than the source start');
  assert.deepEqual([clip(b).start, clip(b).offset, clip(b).length], [BAR * 6, 0, BAR * 4]);
  const before = await call('edit_clips', { ids: [a], shift_bars: -20 });
  assert.equal(before.ok, false);
  assert.match(before.message!, /before bar 1/);
  const same = await call('edit_clips', { ids: [a], mute: false });
  assert.equal(same.ok, false);
  assert.match(same.message!, /^No change:/);
  sound();
});

test('edit_clips: split, duplicate with a gap, clone as unique, mute / color / gain (audio only)', async () => {
  const { doc, call, ex, clip, sound, pat, tracks } = rig();
  const a = ex<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: tracks[0], start: 0, length: BAR * 4, patternId: pat }).id;
  const s = await call('edit_clips', { ids: [a], split_at_bar: '3' });
  assert.equal(s.ok, true, s.message);
  const ids = (s.data as { ids: string[] }).ids;
  assert.equal(ids.length, 2);
  assert.deepEqual(ids.map((id) => [clip(id).start, clip(id).length, clip(id).offset]), [[0, BAR * 2, 0], [BAR * 2, BAR * 2, BAR * 2]]);
  const d = await call('edit_clips', { ids, duplicate: { times: 2, gap_bars: 1 } });
  assert.equal(d.ok, true, d.message);
  const created = (d.data as { created: string[] }).created;
  assert.deepEqual(created.map((id) => clip(id).start).sort((x, y) => x - y), [BAR * 5, BAR * 7, BAR * 10, BAR * 12], 'span 4 bars + 1 bar gap');
  const patterns = Object.keys(doc.project.patterns).length;
  const c = await call('edit_clips', { ids: [created[0]], duplicate: { times: 1 }, make_unique: true });
  assert.equal(c.ok, true, c.message);
  const clone = (c.data as { created: string[] }).created[0];
  assert.notEqual(clip(clone).patternId, pat, 'clone plays its own pattern');
  assert.equal(Object.keys(doc.project.patterns).length, patterns + 1);
  assert.equal((await call('edit_clips', { ids: [a], make_unique: true })).ok, true);
  assert.notEqual(clip(a).patternId, pat);
  assert.equal((await call('edit_clips', { pattern: clip(created[1]).patternId!, mute: true, color: '#FF0000' })).ok, true);
  assert.equal(clip(created[1]).mute, true);
  assert.equal(clip(created[1]).color, '#FF0000');
  const g = await call('edit_clips', { ids: [created[1]], gain_db: -6 });
  assert.equal(g.ok, false);
  assert.match(g.message!, /audio/);
  const none = await call('edit_clips', { ids: [created[1]], split_at_bar: '40' });
  assert.match(none.message!, /^No change: no selected clip spans bar 40/);
  sound();
});

test('edit_automation: replace, add, update, remove points at song positions; retarget and rename', async () => {
  const { doc, call, sound } = rig();
  const ch = (i: number) => doc.project.channels[doc.project.channelOrder[i]];
  const made = await call('add_automation', { channel: ch(0).id, param: 'volume', bars: '5-8', from: '0%', to: '100%' });
  assert.equal(made.ok, true, made.message);
  const autId = (made.data as { automationId: string }).automationId;
  const pts = () => Object.values(doc.project.automations[autId].points).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(pts().map((p) => p.tick), [0, BAR * 4]);
  const r = await call('edit_automation', { automation: autId, add: [{ at: 7, value: 0.5, curve: 'exp' }], update: [{ index: 2, value: 0.25 }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(pts().map((p) => [p.tick, p.tension]), [[0, 0], [BAR * 2, -0.5], [BAR * 4, 0]]);
  assert.ok(pts()[2].value < 1 && pts()[2].value > 0, 'updated value');
  assert.equal((await call('edit_automation', { automation: autId, remove_bars: '7' })).ok, true);
  assert.equal(pts().length, 2);
  assert.equal((await call('edit_automation', { automation: autId, remove: [1] })).ok, true);
  assert.equal(pts().length, 1);
  const rep = await call('edit_automation', { automation: autId, points: [{ at: '5', value: 1 }, { at: '6.9', value: 0 }] });
  assert.equal(rep.ok, true, rep.message);
  assert.deepEqual(pts().map((p) => p.tick), [0, BAR + PPQ * 2]);
  const early = await call('edit_automation', { automation: autId, add: [{ at: 2, value: 0 }] });
  assert.equal(early.ok, false);
  assert.match(early.message!, /before this automation's start/);
  const re = await call('edit_automation', { automation: doc.project.automations[autId].name, channel: ch(1).id, param: 'pan', name: 'Pan sweep' });
  assert.equal(re.ok, true, re.message);
  const aut = doc.project.automations[autId];
  assert.equal(aut.name, 'Pan sweep');
  assert.equal(aut.target, `channel/${doc.project.channelOrder[1]}/pan`);
  const nothing = await call('edit_automation', { automation: 'Pan sweep', name: 'Pan sweep' });
  assert.match(nothing.message!, /^No change:/);
  assert.match((await call('edit_automation', { automation: 'nope' })).message!, /No automation "nope"/);
  sound();
});

test('set_tempo: loop region by bars, loop off / on, metronome, master volume; no change refused', async () => {
  const { doc, call } = rig();
  const r = await call('set_tempo', { loop: '9-16', metronome: true });
  assert.equal(r.ok, true, r.message);
  const t = () => doc.project.transport;
  assert.deepEqual(t().loop, { enabled: true, start: BAR * 8, end: BAR * 16 });
  assert.equal(t().metronome, true);
  assert.match(r.message!, /loop on, bars 9–16 \(8 bars\), metronome on/);
  assert.equal((await call('set_tempo', { loop: false })).ok, true);
  assert.equal(t().loop.enabled, false);
  assert.equal((await call('set_tempo', { loop: true })).ok, true);
  assert.deepEqual(t().loop, { enabled: true, start: BAR * 8, end: BAR * 16 }, 'the region is kept');
  assert.equal((await call('set_tempo', { master_volume_db: -6 })).ok, true);
  assert.ok(Math.abs(t().masterVolume - 0.501) < 0.001);
  assert.match((await call('set_tempo', { metronome: true })).message!, /^No change:/);
  assert.equal((await call('set_tempo', { time_signature: '3/4', loop: '1-2' })).ok, true);
  assert.deepEqual([t().loop.start, t().loop.end], [0, PPQ * 6]);
});

run('mcp arrange edit');
