// Grid-controller LED feedback (shared/live/gridLeds.ts) and the MIDI-out
// settings helpers (shared/live/midiOut.ts): the view per state, the LED
// messages per layout, change-only updates, palette approximation, Launchpad
// SysEx, and pairing the grid's input with an output port.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { DEFAULT_LAUNCH_GRID, launchGridMap, mergeLaunchGrid } from '@shared/live/launchGrid';
import {
  APC,
  EMPTY_LAUNCHER_STATE,
  LP_DIM_RED,
  LP_GREEN,
  LP_RED,
  LP_WHITE,
  gridView,
  launchpadColor,
  launchpadModel,
  launchpadProgrammerMode,
  ledChanges,
  ledMap,
  ledOff,
  pairLedOutput,
  portKey,
  resolveLedOutput,
} from '@shared/live/gridLeds';
import { DEFAULT_MIDI_OUT, mergeMidiOut, midiOutSettings, outputsToOpen, syncTempoToWrite } from '@shared/live/midiOut';
import type { LauncherLedState } from '@shared/engine/protocol';
import type { LaunchGridSettings } from '@shared/types';

/** 3 tracks, 2 scenes; red clip A at (T1, S1), clip B (pattern colour) at (T3, S2), clip C at (T2, S2). */
function rig() {
  const host = new DocHost(createDefaultProject('Leds'), CATALOG, { strict: true });
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = host.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const pat = host.project.transport.activePatternId!;
  const t = host.project.playlist.trackOrder;
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const s2 = ex<{ id: string }>('session.addScene', {}).id;
  const a = ex<{ id: string }>('session.setClip', { trackId: t[0], sceneId: s1, patternId: pat }).id;
  ex('session.updateClip', { id: a, color: '#ff2020' });
  const b = ex<{ id: string }>('session.setClip', { trackId: t[2], sceneId: s2, patternId: pat }).id;
  const c = ex<{ id: string }>('session.setClip', { trackId: t[1], sceneId: s2, patternId: pat }).id;
  return { host, t, s1, s2, a, b, c, pat };
}

const on = (patch: Partial<LaunchGridSettings> = {}): LaunchGridSettings => ({ ...DEFAULT_LAUNCH_GRID, enabled: true, ...patch });
const st = (p: Partial<LauncherLedState>): LauncherLedState => ({ ...EMPTY_LAUNCHER_STATE, ...p });

test('view: pad states from the launcher state (empty, clip, queued, playing, recording, stopping)', () => {
  const g = rig();
  const p = g.host.project;
  const pad = (v: ReturnType<typeof gridView>, row: number, col: number) => v.pads.find((x) => x.row === row && x.col === col)!;
  let v = gridView(p, on(), EMPTY_LAUNCHER_STATE);
  assert.equal(pad(v, 0, 0).state, 'clip');
  assert.equal(pad(v, 0, 0).color, '#ff2020');
  assert.equal(pad(v, 0, 1).state, 'empty');
  assert.equal(pad(v, 1, 2).color, p.patterns[g.pat].color, 'no clip colour: the pattern colour');
  assert.equal(v.pads.length, 2 * Math.min(8, p.playlist.trackOrder.length), 'two scene rows of visible tracks');
  assert.deepEqual(v.scenes.map((s) => s.state), ['has', 'has']);
  assert.equal(v.stopAll.active, false);
  v = gridView(p, on(), st({ queued: { [g.t[0]]: g.a } }));
  assert.equal(pad(v, 0, 0).state, 'queued');
  assert.equal(v.scenes[0].state, 'queued');
  v = gridView(p, on(), st({ playing: { [g.t[0]]: g.a } }));
  assert.equal(pad(v, 0, 0).state, 'playing');
  assert.equal(v.scenes[0].state, 'playing', 'every clip of the row plays');
  assert.equal(v.stopAll.active, true);
  v = gridView(p, on(), st({ playing: { [g.t[0]]: g.a }, recording: true }));
  assert.equal(pad(v, 0, 0).state, 'recording');
  v = gridView(p, on(), st({ playing: { [g.t[0]]: g.a }, queued: { [g.t[0]]: 'stop' } }));
  assert.equal(pad(v, 0, 0).state, 'stopping');
  // another clip queued on the same track: the playing one is on its way out
  v = gridView(p, on(), st({ playing: { [g.t[2]]: g.b }, queued: { [g.t[2]]: 'lc_other' } }));
  assert.equal(pad(v, 1, 2).state, 'stopping');
  assert.equal(v.scenes[1].state, 'has', 'only one of the row plays');
  // scrolled window: track offset 1 → column 0 is track 2
  v = gridView(p, on({ trackOffset: 1 }), EMPTY_LAUNCHER_STATE);
  assert.equal(pad(v, 1, 0).state, 'clip');
  assert.equal(pad(v, 0, 0).state, 'empty');
});

test('launchpad: notes for pads (static ch1 / flash ch2 / pulse ch3), CCs for scenes and stop-all', () => {
  const g = rig();
  const p = g.host.project;
  const s = on({ device: 'LPX MIDI' });
  let m = ledMap(s, gridView(p, s, EMPTY_LAUNCHER_STATE));
  assert.deepEqual(m.n81, [[0x90, 81, 5]], 'red clip, static red');
  assert.deepEqual(m.n82, [[0x90, 82, 0]], 'empty pad off');
  assert.deepEqual(m.c89, [[0xb0, 89, 1]], 'scene with clips: dim white');
  assert.deepEqual(m.c98, [[0xb0, 98, LP_DIM_RED]]);
  m = ledMap(s, gridView(p, s, st({ queued: { [g.t[0]]: g.a } })));
  assert.deepEqual(m.n81, [[0x90, 81, 5], [0x91, 81, LP_GREEN]], 'queued: flash from the clip colour to green');
  assert.deepEqual(m.c89, [[0xb0, 89, 1], [0xb1, 89, LP_GREEN]]);
  m = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a } })));
  assert.deepEqual(m.n81, [[0x92, 81, LP_GREEN]], 'playing: pulse green');
  assert.deepEqual(m.c89, [[0xb0, 89, LP_GREEN]]);
  assert.deepEqual(m.c98, [[0xb0, 98, LP_RED]]);
  m = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a }, recording: true })));
  assert.deepEqual(m.n81, [[0x92, 81, LP_RED]], 'recording: pulse red');
  m = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a }, queued: { [g.t[0]]: 'stop' } })));
  assert.deepEqual(m.n81, [[0x90, 81, 0], [0x91, 81, 5]], 'stopping: flash the clip colour');
});

test('apc mini: velocities 0..6 on pads, single LEDs on scene and track buttons; generic: 127 / 0 on its channel', () => {
  const g = rig();
  const p = g.host.project;
  const s = on({ layout: 'apc-mini' });
  let m = ledMap(s, gridView(p, s, EMPTY_LAUNCHER_STATE));
  assert.deepEqual(m.n56, [[0x90, 56, APC.yellow]]);
  assert.deepEqual(m.n57, [[0x90, 57, APC.off]]);
  assert.deepEqual(m.n82, [[0x90, 82, 0]]);
  assert.deepEqual(m.n64, [[0x90, 64, 0]]);
  assert.equal(m.n98, undefined, 'Shift has no LED');
  m = ledMap(s, gridView(p, s, st({ queued: { [g.t[0]]: g.a } })));
  assert.deepEqual(m.n56, [[0x90, 56, APC.greenBlink]]);
  assert.deepEqual(m.n82, [[0x90, 82, 2]]);
  m = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a } })));
  assert.deepEqual(m.n56, [[0x90, 56, APC.green]]);
  assert.deepEqual(m.n64, [[0x90, 64, 1]], 'track button lit while its track plays');
  m = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a }, recording: true })));
  assert.deepEqual(m.n56, [[0x90, 56, APC.red]]);
  m = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a }, queued: { [g.t[0]]: 'stop' } })));
  assert.deepEqual(m.n56, [[0x90, 56, APC.yellowBlink]]);
  assert.deepEqual(m.n64, [[0x90, 64, 2]]);
  // generic, base note 36, channel 10 (index 9)
  const gs = on({ layout: 'generic', baseNote: 36, channel: 9 });
  m = ledMap(gs, gridView(p, gs, EMPTY_LAUNCHER_STATE));
  assert.deepEqual(m.n36, [[0x99, 36, 0]], 'a stopped clip stays dark');
  m = ledMap(gs, gridView(p, gs, st({ playing: { [g.t[0]]: g.a } })));
  assert.deepEqual(m.n36, [[0x99, 36, 127]]);
  assert.deepEqual(m.n100, [[0x99, 100, 127]], 'scene 1 plays');
  assert.deepEqual(m.n108, [[0x99, 108, 127]], 'stop-all lit while anything plays');
});

test('only changed controls are sent; vanished controls go dark; ledOff clears a map', () => {
  const g = rig();
  const p = g.host.project;
  const s = on();
  const a = ledMap(s, gridView(p, s, EMPTY_LAUNCHER_STATE));
  const all = ledChanges(null, a);
  assert.equal(all.length, Object.values(a).flat().length, 'first send: everything');
  assert.deepEqual(ledChanges(a, a), [], 'nothing changed: nothing sent');
  const b = ledMap(s, gridView(p, s, st({ playing: { [g.t[0]]: g.a } })));
  assert.deepEqual(ledChanges(a, b), [[0x92, 81, LP_GREEN], [0xb0, 89, LP_GREEN], [0xb0, 98, LP_RED]]);
  // a scene removed: its controls are switched off
  const fewer = { ...a };
  delete fewer.c79;
  assert.deepEqual(ledChanges(a, fewer), [[0xb0, 79, 0]]);
  const off = ledOff(b);
  assert.deepEqual(off.n81, [[0x90, 81, 0]], 'pulse channel → static off');
  assert.deepEqual(off.c89, [[0xb0, 89, 0]]);
});

test('palette: clip colours map to the nearest saturated Launchpad colour; greys and junk → white', () => {
  assert.equal(launchpadColor('#ff0000'), 5);
  assert.equal(launchpadColor('#800000'), 5, 'dark red still lights red');
  assert.equal(launchpadColor('#00ff00'), 21);
  assert.equal(launchpadColor('#0000ff'), 45);
  assert.equal(launchpadColor('#ffff00'), 13);
  assert.equal(launchpadColor('#ff8000'), 9);
  assert.equal(launchpadColor('#a855f7'), 49, 'the Krypt purple');
  assert.equal(launchpadColor('#ec4899'), 57, 'the Krypt pink');
  assert.equal(launchpadColor('#808080'), LP_WHITE);
  assert.equal(launchpadColor('#000'), LP_WHITE);
  assert.equal(launchpadColor(null), LP_WHITE);
  assert.equal(launchpadColor('teal'), LP_WHITE);
});

test('launchpad SysEx: programmer / live mode per model; unknown → every model', () => {
  assert.equal(launchpadModel('LPX MIDI')?.id, 'lpx');
  assert.equal(launchpadModel('MIDIOUT2 (LPMiniMK3 MIDI)')?.id, 'lpminimk3');
  assert.equal(launchpadModel('Launchpad Pro MK3')?.id, 'lppromk3');
  assert.equal(launchpadModel('Launchpad'), null);
  assert.deepEqual(launchpadProgrammerMode('LPX MIDI', true), [[0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7]]);
  assert.deepEqual(launchpadProgrammerMode('LPMiniMK3 MIDI', false), [[0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x00, 0xf7]]);
  assert.deepEqual(
    launchpadProgrammerMode('Launchpad', true).map((m) => m[5]),
    [0x0c, 0x0d, 0x0e],
  );
});

test('pairing: same name, then the same name key (MIDIIN2 ↔ MIDIOUT2, In ↔ Out), any-input grids by model; overrides', () => {
  const outs = [
    { id: 'Microsoft GS Wavetable Synth', name: 'Microsoft GS Wavetable Synth' },
    { id: 'LPX MIDI', name: 'LPX MIDI' },
    { id: 'MIDIOUT2 (LPX MIDI)', name: 'MIDIOUT2 (LPX MIDI)' },
    { id: 'APC MINI', name: 'APC MINI' },
    { id: 'Pads Out', name: 'Pads Out' },
  ];
  assert.equal(portKey('MIDIIN2 (LPX MIDI)'), portKey('MIDIOUT2 (LPX MIDI)'));
  assert.equal(portKey('Pads In'), portKey('Pads Out'));
  assert.equal(pairLedOutput('LPX MIDI', 'launchpad', outs), 'LPX MIDI');
  assert.equal(pairLedOutput('MIDIIN2 (LPX MIDI)', 'launchpad', outs), 'MIDIOUT2 (LPX MIDI)');
  assert.equal(pairLedOutput('Pads In', 'generic', outs), 'Pads Out');
  assert.equal(pairLedOutput('Keys', 'generic', outs), null, 'no output of that name');
  assert.equal(pairLedOutput(null, 'apc-mini', outs), 'APC MINI', 'any input: the one APC output');
  assert.equal(pairLedOutput(null, 'launchpad', outs), null, 'two Launchpad ports: ambiguous, pick one in the popover');
  assert.equal(pairLedOutput(null, 'generic', outs), null);
  assert.equal(resolveLedOutput(on({ device: 'LPX MIDI' }), outs), 'LPX MIDI');
  assert.equal(resolveLedOutput(on({ device: 'LPX MIDI', ledOutput: 'MIDIOUT2 (LPX MIDI)' }), outs), 'MIDIOUT2 (LPX MIDI)', 'explicit output');
  assert.equal(resolveLedOutput(on({ device: 'LPX MIDI', ledOutput: null }), outs), null, 'LEDs off');
  assert.equal(resolveLedOutput(on({ device: 'LPX MIDI', ledOutput: '' }), outs), 'LPX MIDI', "'' = automatic");
  assert.equal(resolveLedOutput({ ...on({ device: 'LPX MIDI' }), enabled: false }, outs), null, 'grid off: no LEDs');
});

test('grid settings keep the LED choice; the Launchpad map asks for CCs only with a device', () => {
  const m = mergeLaunchGrid(DEFAULT_LAUNCH_GRID, { ledOutput: 'Pads Out' });
  assert.equal(m.ledOutput, 'Pads Out');
  assert.equal(mergeLaunchGrid(m, { enabled: true }).ledOutput, 'Pads Out', 'other patches keep it');
  assert.equal(mergeLaunchGrid(m, { ledOutput: null }).ledOutput, null);
  assert.equal(mergeLaunchGrid(m, { ledOutput: '' }).ledOutput, '', 'back to automatic, explicitly');
  assert.equal(mergeLaunchGrid(mergeLaunchGrid(m, { ledOutput: '' }), { ...DEFAULT_LAUNCH_GRID }).ledOutput, '', 'a later full merge does not revive the old port');
  assert.equal('ledOutput' in mergeLaunchGrid(DEFAULT_LAUNCH_GRID, { enabled: true }), false, 'untouched = absent');
  const g = rig();
  assert.equal(launchGridMap(g.host.project, on({ device: 'LPX MIDI' })).cc, true);
  assert.equal(launchGridMap(g.host.project, on({ device: null })).cc, undefined, 'any input: a keyboard pedal must not launch');
  assert.equal(launchGridMap(g.host.project, on({ layout: 'apc-mini', device: 'APC MINI' })).cc, undefined);
});

test('midi out settings: validation, the open set, the tempo written on sync stop', () => {
  assert.deepEqual(midiOutSettings(undefined), DEFAULT_MIDI_OUT);
  const m = mergeMidiOut(DEFAULT_MIDI_OUT, { outputs: { Synth: true, Bad: 'yes', '': true }, clockPorts: ['Synth', 'Synth', 'TR-8', 3, ''], clockOffsetMs: -250, syncInput: '  ', syncWritesTempo: false });
  assert.deepEqual(m, { outputs: { Synth: true }, clockPorts: ['Synth', 'TR-8'], clockOffsetMs: -100, syncInput: null, syncWritesTempo: false });
  assert.deepEqual(mergeMidiOut(m, { syncInput: 'Clock In', clockOffsetMs: 3.14159 }), { ...m, syncInput: 'Clock In', clockOffsetMs: 3.1 });
  assert.deepEqual(mergeMidiOut(m, 'junk'), m);
  assert.deepEqual(outputsToOpen({ ...m, outputs: { Synth: true, Off: false } }, 'LPX MIDI'), ['LPX MIDI', 'Synth', 'TR-8']);
  assert.deepEqual(outputsToOpen(DEFAULT_MIDI_OUT, null), []);
  assert.equal(syncTempoToWrite(127.96, 140), 128);
  assert.equal(syncTempoToWrite(140.02, 140), null, 'already the project tempo');
  assert.equal(syncTempoToWrite(null, 140), null);
  assert.equal(syncTempoToWrite(5, 140), null);
});

await run('grid leds');
