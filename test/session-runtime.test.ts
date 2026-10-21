import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER, actorKey } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { PPQ } from '@shared/schema/time';
import type { EngineEvent, EngineRequest } from '@shared/engine/protocol';
import type { EngineStatus, Settings } from '@shared/types';
import { SessionController } from '../electron/session/controller';
import { EVENT } from '../electron/channels';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const BAR = PPQ * 4;

function rig(opts: { running?: boolean } = {}) {
  const doc = new DocHost(createDefaultProject('Live'), CATALOG, { strict: true });
  const requests: EngineRequest[] = [];
  const statusFns = new Set<(s: EngineStatus) => void>();
  const eventFns = new Set<(e: EngineEvent) => void>();
  let status: EngineStatus = { state: opts.running === false ? 'stopped' : 'running', device: null, engineVersion: '0.1.0', restarts: 0 };
  let refuse: string | null = null;
  const engine = {
    async request<T>(req: EngineRequest) {
      if (status.state !== 'running') return { ok: false, message: "The audio engine isn't running." } as { ok: boolean; data?: T; message?: string };
      requests.push(req);
      if (refuse && req.cmd === refuse) return { ok: false, message: 'refused' } as { ok: boolean; data?: T; message?: string };
      return { ok: true, data: {} as T };
    },
    status: () => status,
    onStatus(cb: (s: EngineStatus) => void) {
      statusFns.add(cb);
      return () => statusFns.delete(cb);
    },
    onEvent(cb: (e: EngineEvent) => void) {
      eventFns.add(cb);
      return () => eventFns.delete(cb);
    },
  };
  let settings = { launchGrid: undefined } as unknown as Settings;
  const settingsFns = new Set<(s: Settings, prev: Settings) => void>();
  const broadcasts: Array<{ channel: string; payload: any }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  const ctl = new SessionController({
    doc,
    engine,
    getSettings: () => settings,
    updateSettings(patch) {
      const prev = settings;
      settings = { ...settings, ...patch };
      for (const fn of settingsFns) fn(settings, prev);
      return settings;
    },
    onSettingsChanged(fn) {
      settingsFns.add(fn);
      return () => settingsFns.delete(fn);
    },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    log: (level, message) => logs.push({ level, message }),
  });
  ctl.start();
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = doc.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const setStatus = (state: EngineStatus['state']) => {
    status = { ...status, state };
    for (const fn of statusFns) fn(status);
  };
  const emit = (e: EngineEvent) => {
    for (const fn of eventFns) fn(e);
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const sent = (cmd: string) => requests.filter((r) => r.cmd === cmd) as any[];
  return { doc, ctl, ex, requests, sent, broadcasts, logs, setStatus, emit, flush, refuse: (cmd: string | null) => (refuse = cmd) };
}

function grid(r: ReturnType<typeof rig>) {
  const p = r.doc.project;
  const pat = p.transport.activePatternId!;
  const t = p.playlist.trackOrder;
  const s1 = r.ex<{ id: string }>('session.addScene', { name: 'Intro' }).id;
  const s2 = r.ex<{ id: string }>('session.addScene', { name: 'Drop', tempo: 128 }).id;
  const c1 = r.ex<{ id: string }>('session.setClip', { trackId: t[0], sceneId: s1, patternId: pat }).id;
  const c2 = r.ex<{ id: string }>('session.setClip', { trackId: t[0], sceneId: s2, patternId: pat, length: BAR * 2 }).id;
  return { pat, t, s1, s2, c1, c2 };
}

test('launch / stop / back to arrangement send the engine commands; stale ids and a stopped engine are refused in words', async () => {
  const r = rig();
  const g = grid(r);
  assert.deepEqual(await r.ctl.launch(g.c1), { ok: true, message: `Launched "Pattern 1"` });
  assert.deepEqual(r.sent('launch').at(-1), { cmd: 'launch', clipId: g.c1 });
  await r.ctl.launch(g.c1, true);
  assert.deepEqual(r.sent('launch').at(-1), { cmd: 'launch', clipId: g.c1, release: true });
  assert.equal((await r.ctl.stop(g.t[0])).ok, true);
  assert.deepEqual(r.sent('launchStop').at(-1), { cmd: 'launchStop', trackId: g.t[0] });
  await r.ctl.stop(null);
  assert.deepEqual(r.sent('launchStop').at(-1), { cmd: 'launchStop', trackId: null });
  assert.equal((await r.ctl.backToArrangement()).ok, true);
  assert.equal(r.sent('backToArrangement').length, 1);
  assert.match((await r.ctl.launch('lc_gone')).message!, /no longer exists/);
  assert.match((await r.ctl.stop('trk_gone')).message!, /no longer exists/);
  r.refuse('launch');
  assert.match((await r.ctl.launch(g.c1)).message!, /Couldn't launch the clip: refused/);
  r.setStatus('stopped');
  const down = await r.ctl.launch(g.c1);
  assert.equal(down.ok, false);
  assert.match(down.message!, /isn't running/);
});

test('launchScene sets the scene tempo through transport.set as the user (undoable), then launches; no tempo = no doc edit', async () => {
  const r = rig();
  const g = grid(r);
  const v0 = r.doc.version;
  const a = await r.ctl.launchScene(g.s1);
  assert.equal(a.ok, true);
  assert.equal(r.doc.version, v0, 'no tempo: no edit');
  assert.deepEqual(r.sent('launchScene').at(-1), { cmd: 'launchScene', sceneId: g.s1 });
  const b = await r.ctl.launchScene(g.s2);
  assert.deepEqual(b, { ok: true, message: 'Launched scene "Drop" at 128 bpm', data: { tempo: 128 } });
  assert.equal(r.doc.project.transport.bpm, 128);
  const last = r.doc.getHistory().at(-1)!;
  assert.equal(last.actorKey, 'user');
  assert.match(last.label, /Scene "Drop" tempo 128/);
  const v1 = r.doc.version;
  await r.ctl.launchScene(g.s2);
  assert.equal(r.doc.version, v1);
  r.doc.undo(USER);
  assert.equal(r.doc.project.transport.bpm, 140);
  assert.match((await r.ctl.launchScene('scn_gone')).message!, /no longer exists/);
});

test('launch recording: on/off with "No change", launchRecorded → session.capture (one undo step) + lastCapture broadcast', async () => {
  const r = rig();
  const g = grid(r);
  const on = await r.ctl.setRecord(true);
  assert.equal(on.ok, true);
  assert.deepEqual(r.sent('setLaunchRecord').at(-1), { cmd: 'setLaunchRecord', on: true });
  assert.deepEqual(r.broadcasts.at(-1), { channel: EVENT.sessionRecordState, payload: { on: true } });
  assert.match((await r.ctl.setRecord(true)).message!, /^No change: launch recording is already on/);
  assert.equal(r.sent('setLaunchRecord').length, 1);

  r.emit({ event: 'launchRecorded', entries: [{ trackId: g.t[0], clipId: g.c1, startTick: 0, endTick: BAR * 2, offset: 0 }, { trackId: g.t[0], clipId: g.c2, startTick: BAR * 2, endTick: BAR * 6, offset: BAR }] });
  const clips = Object.values(r.doc.project.playlist.clips).sort((a, b) => a.start - b.start);
  assert.deepEqual(clips.map((c) => [c.start, c.length, c.offset]), [
    [0, BAR * 2, 0],
    [BAR * 2, BAR * 4, 0],
  ]);
  const st = r.broadcasts.at(-1)!;
  assert.equal(st.channel, EVENT.sessionRecordState);
  assert.equal(st.payload.on, true);
  assert.equal(st.payload.lastCapture.ok, true);
  assert.equal(st.payload.lastCapture.id, 1);
  assert.match(st.payload.lastCapture.message, /Launch recording written to the playlist: 2 clips on 1 track/);
  assert.deepEqual(r.ctl.recordState(), st.payload);
  const h = r.doc.getHistory().at(-1)!;
  assert.equal(h.label, 'Record launches');
  assert.equal(h.actorKey, actorKey(USER));
  r.doc.undo(USER);
  assert.equal(Object.keys(r.doc.project.playlist.clips).length, 0);

  const n = r.broadcasts.length;
  r.emit({ event: 'launchRecorded', entries: [] });
  assert.equal(r.broadcasts.length, n);
  r.emit({ event: 'launchRecorded', entries: [{ trackId: g.t[0], clipId: 'lc_gone', startTick: 0, endTick: BAR, offset: 0 }] });
  const bad = r.broadcasts.at(-1)!.payload.lastCapture;
  assert.deepEqual([bad.id, bad.ok], [2, false]);
  assert.match(bad.message, /Nothing from the launch recording could be written \(1 span skipped/);

  assert.equal((await r.ctl.setRecord(false)).ok, true);
  assert.equal(r.ctl.recordState().on, false);
});

test('engine restart: the record switch and the grid map are sent again', async () => {
  const r = rig();
  grid(r);
  await r.ctl.setRecord(true);
  r.ctl.setGridSettings({ enabled: true, layout: 'launchpad' });
  await r.flush();
  assert.equal(r.sent('setLaunchGrid').length, 1);
  r.setStatus('restarting');
  r.setStatus('running');
  await r.flush();
  await r.flush();
  assert.equal(r.sent('setLaunchRecord').filter((x) => x.on).length, 2);
  assert.equal(r.sent('setLaunchGrid').length, 2);
  assert.equal(Object.keys(r.sent('setLaunchGrid').at(-1).notes).length > 0, true);
  r.refuse('setLaunchRecord');
  r.setStatus('restarting');
  r.setStatus('running');
  await r.flush();
  await r.flush();
  assert.equal(r.ctl.recordState().on, false);
  assert.ok(r.logs.some((l) => l.level === 'warn' && /switched off/.test(l.message)));
});

test('grid map: pushed when enabled, when the launcher layout or the settings change, never twice the same; disabling clears it', async () => {
  const r = rig();
  const g = grid(r);
  await r.flush();
  assert.equal(r.sent('setLaunchGrid').length, 0, 'disabled at start: nothing to send');
  const s = r.ctl.setGridSettings({ enabled: true, device: 'LPX', layout: 'launchpad' });
  assert.equal(s.ok, true);
  assert.equal(s.data!.device, 'LPX');
  assert.deepEqual(r.ctl.gridSettings(), s.data);
  await r.flush();
  let last = r.sent('setLaunchGrid').at(-1);
  assert.equal(last.device, 'LPX');
  assert.deepEqual(last.notes['81'], { clipId: g.c1 });
  const c3 = r.ex<{ id: string }>('session.setClip', { trackId: g.t[1], sceneId: g.s1, patternId: g.pat }).id;
  await r.flush();
  last = r.sent('setLaunchGrid').at(-1);
  assert.deepEqual(last.notes['82'], { clipId: c3 });
  const count = r.sent('setLaunchGrid').length;
  r.ex('notes.add', { patternId: g.pat, channelId: r.doc.project.channelOrder[0], notes: [{ tick: 0, key: 36 }] });
  r.ex('transport.set', { bpm: 100 });
  r.ex('session.setScene', { id: g.s1, name: 'Renamed' });
  await r.flush();
  assert.equal(r.sent('setLaunchGrid').length, count);
  r.ex('playlist.addTrack', { index: 0 });
  await r.flush();
  assert.equal(r.sent('setLaunchGrid').length, count + 1);
  r.ctl.setGridSettings({ enabled: false });
  await r.flush();
  assert.deepEqual(r.sent('setLaunchGrid').at(-1).notes, {});
  assert.equal(r.ctl.setGridSettings(null).ok, false);
});

function mcpRig() {
  const r = rig();
  const deps = {
    doc: r.doc,
    engine: {
      request: async () => ({ ok: true }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async () => ({ ok: false, message: 'n/a' }),
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo: async () => ({ ok: false, message: 'n/a' }),
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Live', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p: string) => p,
      renderDir: () => '.',
      allowedRoots: () => [],
    },
    getSettings: () => ({}) as Settings,
    updateSettings: (p: Partial<Settings>) => p as Settings,
    broadcast: () => {},
    userDataDir: '.',
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    session: r.ctl,
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'live-agent', name: 'Live Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { ...r, deps, call };
}

test('build_session: scenes with clips by name (new track names become tracks), follow rules, quantize; one agent history entry; a repeat is "No change"', async () => {
  const m = mcpRig();
  const ac = m.ex<{ channelId: string }>('playlist.addAudio', { path: 'C:/loops/Vox.wav', name: 'Vox', trackId: m.doc.project.playlist.trackOrder[15], start: 0, frames: 48000 * 4, sampleRate: 48000 }).channelId;
  m.ex('playlist.removeClips', { ids: Object.keys(m.doc.project.playlist.clips) });
  const before = m.doc.getHistory().length;
  const args = {
    quantize: '2bars',
    scenes: [
      { name: 'Intro', clips: [{ track: 1, pattern: 'Pattern 1' }, { track: 'Vocals', audio: 'Vox', loop: false }] },
      { name: 'Drop', tempo: 128, clips: [{ track: 'Track 1', pattern: 'Pattern 1', length_bars: 2, launch_mode: 'gate', follow: { action: 'next', after_bars: 4, chance: 0.75, other_action: 'stop' } }] },
    ],
  };
  const r = await m.call('build_session', args);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /added 2 scenes, set 3 slots, new playlist track "Vocals"/);
  const s = m.doc.project.session!;
  assert.equal(s.quantize, '2bars');
  assert.deepEqual(s.sceneOrder.map((id) => [s.scenes[id].name, s.scenes[id].tempo]), [['Intro', null], ['Drop', 128]]);
  const vox = Object.values(s.clips).find((c) => c.kind === 'audio')!;
  assert.equal(vox.channelId, ac);
  assert.equal(vox.loop, false);
  assert.equal(m.doc.project.playlist.tracks[vox.trackId].name, 'Vocals');
  const drop = Object.values(s.clips).find((c) => c.sceneId === s.sceneOrder[1])!;
  assert.deepEqual([drop.length, drop.launchMode, drop.follow], [BAR * 2, 'gate', { action: 'next', chance: 0.75, otherAction: 'stop', afterBars: 4 }]);
  assert.match(r.text!, /Session \(clip launcher\): 2 scenes × 2 tracks with clips, 3 launch clips · quantize 2bars/);
  assert.match(r.text!, /2\. "Drop" \(scn_[a-z0-9]+\) 128 bpm: T1 "Pattern 1" 2 bars \(gate, then next 75% after 4 bars\)/);
  assert.ok(r.changed.some((id) => id.startsWith('scn_')) && r.changed.some((id) => id.startsWith('lc_')));
  const hist = m.doc.getHistory().slice(before);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].actorKey, 'agent:live-agent');
  const again = await m.call('build_session', { quantize: '2bars', scenes: [{ scene: 'Drop', tempo: 128, clips: [{ track: 1, pattern: 'Pattern 1', length_bars: 2, launch_mode: 'gate', follow: { action: 'next', after_bars: 4, chance: 0.75, other_action: 'stop' } }] }] });
  assert.equal(again.ok, false);
  assert.match(again.message, /^No change:/);
  const rm = await m.call('build_session', { scenes: [{ scene: 1, clips: [{ track: 'Vocals', remove: true }] }] });
  assert.equal(rm.ok, true, rm.message);
  assert.equal(Object.values(m.doc.project.session!.clips).some((c) => c.kind === 'audio'), false);
  const bad = await m.call('build_session', { scenes: [{ name: 'X', clips: [{ track: 1, audio: 'Kick' }] }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /instrument channel, not an audio clip/);
  assert.equal(m.doc.project.session!.sceneOrder.length, 2, 'the failed call was rolled back');
  assert.match((await m.call('build_session', {})).message, /Say what to build/);
});

test('build_session from_arrangement + clear; get_project mentions the session', async () => {
  const m = mcpRig();
  const p = m.doc.project;
  m.ex('playlist.addClip', { kind: 'pattern', trackId: p.playlist.trackOrder[0], start: 0, length: BAR * 8, patternId: p.transport.activePatternId });
  m.ex('session.addScene', { name: 'Old' });
  const r = await m.call('build_session', { clear: true, from_arrangement: { bars_per_scene: 4 } });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /removed 1 scene, 2 scenes from the arrangement \(2 clips\)/);
  assert.deepEqual(m.doc.project.session!.sceneOrder.map((id) => m.doc.project.session!.scenes[id].name), ['Bars 1-4', 'Bars 5-8']);
  const ov = await m.call('get_project', {});
  assert.equal(ov.ok, true);
  assert.match(ov.message + (ov.text ?? ''), /Session \(clip launcher\): 2 scenes × 1 track with clips, 2 launch clips/);
});

test('launch: scene (tempo as the agent, undoable), slot, stop all, back to arrangement, record (+ "No change"), bad input', async () => {
  const m = mcpRig();
  const g = grid(m);
  const sc = await m.call('launch', { scene: 'Drop' });
  assert.equal(sc.ok, true, sc.message);
  assert.equal(sc.message, 'Launched scene "Drop" at 128 bpm.');
  assert.equal(m.doc.project.transport.bpm, 128);
  assert.equal(m.doc.getHistory().at(-1)!.actorKey, 'agent:live-agent');
  assert.deepEqual(m.sent('launchScene').at(-1), { cmd: 'launchScene', sceneId: g.s2 });
  const slot = await m.call('launch', { clip: { track: 1, scene: 1 } });
  assert.equal(slot.ok, true, slot.message);
  assert.deepEqual(m.sent('launch').at(-1), { cmd: 'launch', clipId: g.c1 });
  assert.equal((await m.call('launch', { clip: g.c2 })).ok, true);
  assert.equal((await m.call('launch', { stop: 'all' })).ok, true);
  assert.deepEqual(m.sent('launchStop').at(-1), { cmd: 'launchStop', trackId: null });
  assert.equal((await m.call('launch', { stop: 1 })).ok, true);
  assert.deepEqual(m.sent('launchStop').at(-1), { cmd: 'launchStop', trackId: g.t[0] });
  assert.equal((await m.call('launch', { back_to_arrangement: true })).ok, true);
  assert.equal((await m.call('launch', { record: true })).ok, true);
  const same = await m.call('launch', { record: true });
  assert.equal(same.ok, false);
  assert.match(same.message, /^No change: launch recording is already on/);
  assert.match((await m.call('launch', { clip: { track: 2, scene: 1 } })).message, /is empty/);
  assert.match((await m.call('launch', { scene: 'Nope' })).message, /No scene "Nope"/);
  assert.match((await m.call('launch', { scene: 1, stop: 'all' })).message, /exactly one/);
  assert.match((await m.call('launch', {})).message, /exactly one/);
});

await run('session runtime');
