// MIDI hardware runtime in main (electron/midi/hardware.ts) against a fake
// engine: the open set / clock / sync pushes, grid LEDs (programmer mode on
// connect, only changes afterwards, hand-back on disconnect), the external
// tempo written on sync stop, engine restarts; and the midi_setup MCP tool.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { DEFAULT_LAUNCH_GRID } from '@shared/live/launchGrid';
import { DEFAULT_MIDI_OUT } from '@shared/live/midiOut';
import type { EngineEvent, EngineRequest, MidiInputInfo, MidiOutputInfo } from '@shared/engine/protocol';
import type { EngineStatus, Settings } from '@shared/types';
import { HardwareController } from '../electron/midi/hardware';
import { EVENT } from '../electron/channels';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const PORTS = ['LPX MIDI', 'TR-8', 'Synth'];
const LPX_PROGRAMMER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7];
const LPX_LIVE = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x00, 0xf7];

function rig(initial: Partial<Settings> = {}) {
  const doc = new DocHost(createDefaultProject('Hw'), CATALOG, { strict: true });
  const requests: EngineRequest[] = [];
  const statusFns = new Set<(s: EngineStatus) => void>();
  const eventFns = new Set<(e: EngineEvent) => void>();
  let status: EngineStatus = { state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 };
  let enabled: string[] = [];
  const outputs = (): MidiOutputInfo[] => PORTS.map((id) => ({ id, name: id, enabled: enabled.includes(id), open: enabled.includes(id) }));
  const inputs: MidiInputInfo[] = [
    { id: 'LPX MIDI', name: 'LPX MIDI', enabled: true, open: true },
    { id: 'Clock In', name: 'Clock In', enabled: true, open: true },
  ];
  const engine = {
    async request<T>(req: EngineRequest) {
      if (status.state !== 'running') return { ok: false, message: "The audio engine isn't running." } as { ok: boolean; data?: T; message?: string };
      requests.push(req);
      let data: unknown = {};
      if (req.cmd === 'listMidiOutputs') data = outputs();
      if (req.cmd === 'listMidiInputs') data = inputs;
      if (req.cmd === 'setMidiOutputs') {
        enabled = req.enabled.filter((x) => PORTS.includes(x));
        data = outputs();
      }
      if (req.cmd === 'setMidiClock') data = { ports: req.ports, open: req.ports.filter((p) => enabled.includes(p)), offsetMs: req.offsetMs ?? 0 };
      if (req.cmd === 'midiSend') {
        if (!enabled.includes(req.port)) return { ok: false, message: `MIDI output '${req.port}' isn't open` } as { ok: boolean; data?: T; message?: string };
        data = { sent: req.messages.length };
      }
      return { ok: true, data: data as T };
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
  let settings = { midiOut: { ...DEFAULT_MIDI_OUT }, launchGrid: { ...DEFAULT_LAUNCH_GRID }, ...initial } as unknown as Settings;
  const settingsFns = new Set<(s: Settings, prev: Settings) => void>();
  const broadcasts: Array<{ channel: string; payload: any }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  const hw = new HardwareController({
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
  hw.start();
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
  /** Let debounced LED updates and queued pushes finish. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
      await hw.settle();
    }
  };
  const sent = (cmd: string) => requests.filter((r) => r.cmd === cmd) as any[];
  const setGrid = (patch: Record<string, unknown>) => hwUpdate({ launchGrid: { ...settings.launchGrid!, ...patch } as any });
  const hwUpdate = (patch: Partial<Settings>) => {
    const prev = settings;
    settings = { ...settings, ...patch };
    for (const fn of settingsFns) fn(settings, prev);
  };
  return { doc, hw, ex, requests, sent, broadcasts, logs, setStatus, emit, settle, setGrid, settings: () => settings, enabled: () => enabled };
}

/** Two scenes with a clip on track 1 (scene 1). */
function session(r: ReturnType<typeof rig>) {
  const p = r.doc.project;
  const pat = p.transport.activePatternId!;
  const t = p.playlist.trackOrder;
  const s1 = r.ex<{ id: string }>('session.addScene', {}).id;
  r.ex('session.addScene', {});
  const c1 = r.ex<{ id: string }>('session.setClip', { trackId: t[0], sceneId: s1, patternId: pat }).id;
  r.ex('session.updateClip', { id: c1, color: '#00ff00' });
  return { t, c1 };
}

test('start: list outputs, open the enabled set, clock and sync settings go to the engine; restart re-sends them', async () => {
  const r = rig({ midiOut: { ...DEFAULT_MIDI_OUT, outputs: { Synth: true }, clockPorts: ['TR-8'], clockOffsetMs: -3, syncInput: 'Clock In' } } as Partial<Settings>);
  await r.settle();
  assert.equal(r.sent('listMidiOutputs').length, 1);
  assert.deepEqual(r.sent('setMidiOutputs').at(-1), { cmd: 'setMidiOutputs', enabled: ['Synth', 'TR-8'] }, 'user outputs + clock ports');
  assert.deepEqual(r.sent('setMidiClock').at(-1), { cmd: 'setMidiClock', ports: ['TR-8'], offsetMs: -3 });
  assert.deepEqual(r.sent('setMidiSync').at(-1), { cmd: 'setMidiSync', device: 'Clock In' });
  assert.ok(r.broadcasts.some((b) => b.channel === EVENT.midiOutputsChanged));
  const n = r.requests.length;
  r.emit({ event: 'midiOutputs', outputs: [] });
  await r.settle();
  assert.equal(r.sent('setMidiOutputs').length, 1, 'same open set: not re-sent');
  r.setStatus('restarting');
  r.setStatus('running');
  await r.settle();
  assert.ok(r.requests.length > n);
  assert.equal(r.sent('setMidiOutputs').length, 2);
  assert.equal(r.sent('setMidiClock').length, 2);
  assert.equal(r.sent('setMidiSync').length, 2);
});

test('grid LEDs: the paired port opens, programmer mode + the full map, then only changes; Live mode at close', async () => {
  const r = rig();
  const g = session(r);
  await r.settle();
  assert.equal(r.sent('midiSend').length, 0, 'grid off: no LEDs');
  r.setGrid({ enabled: true, device: 'LPX MIDI', layout: 'launchpad' });
  await r.settle();
  assert.ok(r.enabled().includes('LPX MIDI'), 'the LED port was opened');
  const first = r.sent('midiSend').at(-1);
  assert.equal(first.port, 'LPX MIDI');
  assert.deepEqual(first.messages[0], LPX_PROGRAMMER, 'programmer mode first');
  assert.ok(first.messages.some((m: number[]) => m[0] === 0x90 && m[1] === 81 && m[2] === 21), 'the green clip on pad 81');
  assert.deepEqual(first.atClose.at(-1), LPX_LIVE, 'back to Live mode when the port closes');
  const count = r.sent('midiSend').length;
  // the clip starts playing: only the changed controls
  r.emit({ event: 'launcherState', playing: { [g.t[0]]: g.c1 }, queued: {}, overridden: [g.t[0]], recording: false });
  await r.settle();
  assert.equal(r.sent('midiSend').length, count + 1);
  const upd = r.sent('midiSend').at(-1);
  assert.deepEqual(upd.messages, [[0x92, 81, 21], [0xb0, 89, 21], [0xb0, 98, 5]], 'pad pulses, its scene and stop-all light');
  assert.equal(upd.atClose, undefined);
  // the same state again and an unrelated edit: nothing sent
  r.emit({ event: 'launcherState', playing: { [g.t[0]]: g.c1 }, queued: {}, overridden: [g.t[0]], recording: false });
  r.ex('transport.set', { bpm: 99 });
  await r.settle();
  assert.equal(r.sent('midiSend').length, count + 1);
  // a doc edit that moves the grid (a new clip) updates its pad
  r.ex('session.setClip', { trackId: g.t[1], sceneId: r.doc.project.session!.sceneOrder[0], patternId: r.doc.project.transport.activePatternId });
  await r.settle();
  assert.equal(r.sent('midiSend').length, count + 2);
  assert.ok(r.sent('midiSend').at(-1).messages.some((m: number[]) => m[1] === 82));
  // LEDs off: the old port is cleared and handed back to Live mode, then closed
  r.setGrid({ ledOutput: null });
  await r.settle();
  const bye = r.sent('midiSend').at(-1);
  assert.equal(bye.port, 'LPX MIDI');
  assert.deepEqual(bye.atClose, []);
  assert.deepEqual(bye.messages.at(-1), LPX_LIVE);
  assert.ok(bye.messages.slice(0, -1).every((m: number[]) => m[2] === 0), 'everything dark');
  assert.ok(!r.enabled().includes('LPX MIDI'), 'closed again');
});

test('grid LEDs: the engine restart re-initializes; a chosen output that is not connected gets nothing', async () => {
  const r = rig();
  session(r);
  r.setGrid({ enabled: true, device: 'LPX MIDI', layout: 'apc-mini' });
  await r.settle();
  const n = r.sent('midiSend').length;
  assert.ok(n >= 1);
  assert.notDeepEqual(r.sent('midiSend').at(-1).messages[0], LPX_PROGRAMMER, 'no Launchpad SysEx for the APC layout');
  r.setStatus('restarting');
  r.setStatus('running');
  await r.settle();
  assert.equal(r.sent('midiSend').length, n + 1, 'full map again after a restart');
  r.setGrid({ ledOutput: 'Gone Port' });
  await r.settle();
  assert.equal(r.sent('midiSend').length, n + 2, 'only the hand-back of the old port');
  assert.equal(r.sent('midiSend').at(-1).port, 'LPX MIDI');
  assert.ok(!r.sent('midiSend').some((m) => m.port === 'Gone Port'), 'an output that is not connected gets nothing');
});

test('sync stop writes the external tempo into the project (one user undo step), unless lost or switched off', async () => {
  const r = rig({ midiOut: { ...DEFAULT_MIDI_OUT, syncInput: 'Clock In' } } as Partial<Settings>);
  await r.settle();
  r.emit({ event: 'midiSync', running: true, bpm: 128.04 });
  assert.equal(r.doc.project.transport.bpm, 140, 'nothing while running');
  assert.ok(r.logs.some((l) => /Following the external MIDI clock from Clock In at 128\.0 bpm/.test(l.message)));
  r.emit({ event: 'midiSync', running: false, bpm: 128.04 });
  assert.equal(r.doc.project.transport.bpm, 128);
  const h = r.doc.getHistory().at(-1)!;
  assert.equal(h.actorKey, 'user');
  assert.equal(h.label, 'Tempo from external clock');
  r.emit({ event: 'midiSync', running: false, bpm: 128.01 });
  assert.equal(r.doc.getHistory().at(-1)!.id, h.id, 'same tempo: no new step');
  r.emit({ event: 'midiSync', running: false, bpm: null, lost: true });
  assert.equal(r.doc.project.transport.bpm, 128);
  const r2 = rig({ midiOut: { ...DEFAULT_MIDI_OUT, syncInput: 'Clock In', syncWritesTempo: false } } as Partial<Settings>);
  r2.emit({ event: 'midiSync', running: false, bpm: 90 });
  assert.equal(r2.doc.project.transport.bpm, 140);
});

test('setClockSettings / setOutputEnabled: persisted, pushed, said in words; unknown ports refused', async () => {
  const r = rig();
  await r.settle();
  let s = await r.hw.setClockSettings({ clockPorts: ['TR-8'], clockOffsetMs: 4 });
  assert.equal(s.ok, true, s.message);
  assert.equal(s.message, 'MIDI clock out to TR-8 (offset +4 ms)');
  assert.deepEqual(r.sent('setMidiClock').at(-1), { cmd: 'setMidiClock', ports: ['TR-8'], offsetMs: 4 });
  assert.ok(r.enabled().includes('TR-8'), 'clock ports are opened');
  s = await r.hw.setClockSettings({ syncInput: 'Clock In' });
  assert.equal(s.message, 'Following the MIDI clock from Clock In (press Play on that device)');
  s = await r.hw.setClockSettings({ syncInput: 'Clock In' });
  assert.match(s.message!, /^No change:/);
  s = await r.hw.setClockSettings({ clockPorts: ['Nope'] });
  assert.equal(s.ok, false);
  assert.match(s.message!, /No MIDI output called "Nope" is connected/);
  const e = await r.hw.setOutputEnabled('Synth', true);
  assert.equal(e.ok, true, e.message);
  assert.equal(e.message, 'Synth enabled');
  assert.equal(r.settings().midiOut!.outputs.Synth, true);
  assert.equal((await r.hw.setOutputEnabled('Ghost', true)).ok, false);
  assert.equal((await r.hw.setClockSettings(null)).ok, false);
});

test('midi_setup: lists ports, sets clock out / sync by name, "internal"; unknown names fail in words', async () => {
  const r = rig();
  await r.settle();
  const deps = {
    doc: r.doc,
    getSettings: () => ({}) as Settings,
    broadcast: () => {},
    log: () => {},
    hardware: r.hw,
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'hw-agent', name: 'Hw Agent' }, session: newSession(), via: 'test' };
  const call = (args: unknown = {}) => callTool(deps, caller, 'midi_setup', args, { quiet: true });
  const list = await call();
  assert.equal(list.ok, true, list.message);
  assert.match(list.message, /MIDI inputs: LPX MIDI \(open\); Clock In \(open\)/);
  assert.match(list.message, /MIDI outputs: LPX MIDI \(off\); TR-8 \(off\); Synth \(off\)/);
  assert.match(list.message, /clock out off; internal clock/);
  const clk = await call({ clock_out: ['tr-8'], sync_input: 'clock' });
  assert.equal(clk.ok, true, clk.message);
  assert.match(clk.message, /MIDI clock out to TR-8/);
  assert.match(clk.message, /TR-8 \(open, clock\)/);
  assert.match(clk.message, /following the clock of Clock In/);
  assert.equal(r.doc.getHistory().length, 0, 'settings, not project edits');
  const internal = await call({ sync_input: 'internal', clock_out: [] });
  assert.equal(internal.ok, true, internal.message);
  assert.match(internal.message, /Internal clock/);
  assert.match(internal.message, /clock out off/);
  const bad = await call({ clock_out: ['Moog'] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /No MIDI outputs match "Moog"/);
  const none = { ...deps, hardware: undefined } as unknown as MainDeps;
  assert.match((await callTool(none, caller, 'midi_setup', {}, { quiet: true })).message, /not available/);
});

await run('midi hardware');
