// Controller maps (shared/live/controllers.ts): settings validation, the templates, the ControllerRunner state
// machine (presses with hysteresis, dead zone, CC modes, transpose, commands, releasing), pad-input learning, the
// virtual-MIDI byte check, labels, and the midi_setup tool adding / removing maps without MIDI hardware.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import {
  CONTROLLER_TEMPLATES,
  ControllerRunner,
  MAX_CONTROLLER_MAPS,
  VIRTUAL_DEVICE_PREFIX,
  detectPadInput,
  inputLabel,
  isVirtualMidi,
  mapFromTemplate,
  mergeControllers,
  padFamily,
  type ControllerMap,
  type ControllerOutput,
  type PadState,
} from '@shared/live/controllers';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

function map(bindings: ControllerMap['bindings'], extra: Partial<ControllerMap> = {}): ControllerMap {
  return { id: 'm1', name: 'Test', enabled: true, source: 'gamepad', gamepad: null, device: 'Krypt: Test', channel: 0, deadzone: 0.1, bindings, ...extra };
}

const pad = (buttons: number[] = [], axes: number[] = []): PadState => ({ buttons, axes });
const midi = (outs: ControllerOutput[]) => outs.flatMap((o) => (o.kind === 'midi' ? [o.bytes] : []));

test('mergeControllers validates every field and keeps devices unique', () => {
  const merged = mergeControllers(undefined, {
    enabled: false,
    maps: [
      { id: 'a', name: '  Pads  ', source: 'gamepad', device: 'Krypt: Pads', channel: 99, deadzone: 9, bindings: [
        { id: 'b1', input: { kind: 'button', index: 0 }, action: { kind: 'note', note: 300, velocity: 0 } },
        { id: 'b2', input: { kind: 'key', code: 'KeyQ' }, action: { kind: 'note', note: 60 } },
        { id: 'b3', input: { kind: 'axis', index: 2, half: 'sideways' }, action: { kind: 'cc', cc: 127, mode: 'range' } },
        { id: 'b1', input: { kind: 'button', index: 1 }, action: { kind: 'note', note: 61 } },
        { id: 'b4', input: { kind: 'button', index: 1 }, action: { kind: 'transpose', semitones: 0 } },
        { id: 'b5', input: { kind: 'button', index: 9 }, action: { kind: 'command', command: 'rm -rf /' } },
      ] },
      { id: 'b', name: 'Pads', source: 'keyboard', device: 'Krypt: Pads', bindings: [{ id: 'k', input: { kind: 'key', code: 'Numpad1' }, action: { kind: 'cc', cc: 64, mode: 'toggle' } }] },
      { id: 'a', name: 'duplicate id' },
      { id: 'bad id!', name: 'x' },
      { id: 'c', name: 'Hijack', device: 'loopMIDI Port' },
    ],
  });
  assert.equal(merged.enabled, false);
  assert.deepEqual(merged.maps.map((m) => m.id), ['a', 'b', 'c']);
  const [a, b, c] = merged.maps;
  assert.equal(a.name, 'Pads');
  assert.equal(a.channel, 15);
  assert.equal(a.deadzone, 0.5);
  assert.deepEqual(a.bindings.map((x) => x.id), ['b1', 'b3'], 'keys on a pad map, duplicate ids, a 0 transpose and a bad command are dropped');
  assert.deepEqual(a.bindings[0].action, { kind: 'note', note: 127, velocity: 1 });
  assert.deepEqual(a.bindings[1].input, { kind: 'axis', index: 2, half: 'full' });
  assert.deepEqual(a.bindings[1].action, { kind: 'cc', cc: 119, mode: 'range', low: 0, high: 127 }, 'channel-mode CCs (120+) are out of reach');
  assert.equal(b.device, 'Krypt: Pads 2', 'devices stay unique');
  assert.equal(b.gamepad, null);
  assert.equal(c.device, `${VIRTUAL_DEVICE_PREFIX}Hijack`, 'a device must carry the Krypt prefix');
  const many = mergeControllers(undefined, { maps: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) });
  assert.equal(many.maps.length, MAX_CONTROLLER_MAPS);
  assert.deepEqual(mergeControllers(merged, { enabled: true }).maps, merged.maps, 'a patch without maps keeps them');
});

test('every template builds a valid map that survives validation unchanged', () => {
  const taken: ControllerMap[] = [];
  for (const t of CONTROLLER_TEMPLATES) {
    const m = mapFromTemplate(t.id, { id: `t${taken.length}`, taken });
    taken.push(m);
    assert.equal(m.source, t.source, t.id);
    assert.ok(m.bindings.length >= 14, `${t.id}: ${m.bindings.length} bindings`);
    const inputs = m.bindings.map((b) => JSON.stringify(b.input));
    assert.equal(new Set(inputs).size, inputs.length, `${t.id}: an input is bound twice`);
    assert.deepEqual(mergeControllers(undefined, { maps: [m] }).maps[0], m, `${t.id} changed under validation`);
  }
  assert.equal(new Set(taken.map((m) => m.device)).size, taken.length);
  const drums = mapFromTemplate('gamepad-drums', { id: 'x', taken: [] });
  assert.deepEqual(drums.bindings.slice(0, 4).map((b) => (b.action.kind === 'note' ? b.action.note : -1)), [36, 37, 38, 39], 'face buttons = pads 1-4 from C2');
  const empty = mapFromTemplate('empty-keyboard', { id: 'y', source: 'keyboard', taken: [] });
  assert.deepEqual([empty.source, empty.bindings.length, empty.name], ['keyboard', 0, 'Keyboard map']);
});

test('buttons: note on at the press threshold, off below the release threshold (no chatter), on the map channel', () => {
  const r = new ControllerRunner(map([{ id: 'n', input: { kind: 'button', index: 6 }, action: { kind: 'note', note: 36, velocity: 90 } }], { channel: 9 }));
  assert.deepEqual(midi(r.frame(pad([0, 0, 0, 0, 0, 0, 0.45]))), []);
  assert.deepEqual(midi(r.frame(pad([0, 0, 0, 0, 0, 0, 0.6]))), [[0x99, 36, 90]]);
  assert.deepEqual(midi(r.frame(pad([0, 0, 0, 0, 0, 0, 0.4]))), [], 'still held between the thresholds');
  assert.deepEqual(midi(r.frame(pad([0, 0, 0, 0, 0, 0, 0.3]))), [[0x89, 36, 0]]);
  assert.deepEqual(midi(r.frame(pad([]))), [], 'a missing button reads 0');
});

test('CC modes: range follows (baseline first, no repeats), hold returns low, toggle flips', () => {
  const r = new ControllerRunner(
    map([
      { id: 'x', input: { kind: 'axis', index: 2, half: 'full' }, action: { kind: 'cc', cc: 74, mode: 'range', low: 0, high: 127 } },
      { id: 'u', input: { kind: 'axis', index: 1, half: 'minus' }, action: { kind: 'cc', cc: 1, mode: 'range', low: 0, high: 127 } },
      { id: 'h', input: { kind: 'button', index: 0 }, action: { kind: 'cc', cc: 64, mode: 'hold', low: 0, high: 127 } },
      { id: 't', input: { kind: 'button', index: 1 }, action: { kind: 'cc', cc: 80, mode: 'toggle', low: 10, high: 100 } },
    ]),
  );
  assert.deepEqual(midi(r.frame(pad([0, 0], [0, 0.05, 0.05, 0]))), [], 'the first poll only sets the baseline');
  assert.deepEqual(midi(r.frame(pad([0, 0], [0, -1, 1, 0]))), [[0xb0, 74, 127], [0xb0, 1, 127]], 'in binding order');
  assert.deepEqual(midi(r.frame(pad([0, 0], [0, -1, 1, 0]))), [], 'unchanged values are not resent');
  assert.deepEqual(midi(r.frame(pad([0, 0], [0, 0.08, 0.05, 0]))), [[0xb0, 74, 64], [0xb0, 1, 0]], 'inside the dead zone: full rests in the middle, a half at 0');
  assert.deepEqual(midi(r.frame(pad([1, 1]))), [[0xb0, 64, 127], [0xb0, 80, 100]]);
  assert.deepEqual(midi(r.frame(pad([0, 0]))), [[0xb0, 64, 0]], 'hold goes back to low; toggle waits for the next press');
  r.frame(pad([0, 1]));
  assert.deepEqual(midi(r.frame(pad([0, 0]))), []);
  assert.deepEqual(midi(r.frame(pad([0, 1]))), [[0xb0, 80, 100]], 'third press: on again');
});

test('transpose shifts later notes, a held note ends on the note it started; commands and keys', () => {
  const r = new ControllerRunner(
    map(
      [
        { id: 'n', input: { kind: 'key', code: 'KeyZ' }, action: { kind: 'note', note: 60, velocity: 100 } },
        { id: 'up', input: { kind: 'key', code: 'NumpadAdd' }, action: { kind: 'transpose', semitones: 12 } },
        { id: 'play', input: { kind: 'key', code: 'Space' }, action: { kind: 'command', command: 'transport.togglePlay' } },
      ],
      { source: 'keyboard' },
    ),
  );
  assert.equal(r.key('KeyP', true), null, 'unbound keys are left to the app');
  assert.deepEqual(midi(r.key('KeyZ', true)!), [[0x90, 60, 100]]);
  const t = r.key('NumpadAdd', true)!;
  assert.deepEqual(t, [{ kind: 'transpose', total: 12, bindingId: 'up' }]);
  r.key('NumpadAdd', false);
  assert.deepEqual(midi(r.key('KeyZ', false)!), [[0x80, 60, 0]], 'the release matches the note that sounded');
  assert.deepEqual(midi(r.key('KeyZ', true)!), [[0x90, 72, 100]]);
  assert.deepEqual(r.key('Space', true), [{ kind: 'command', command: 'transport.togglePlay', bindingId: 'play' }]);
  assert.deepEqual(r.key('Space', true), [], 'a held key never repeats its command');
  assert.deepEqual(midi(r.releaseAll()), [[0x80, 72, 0]]);
  assert.deepEqual(midi(r.releaseAll()), [], 'nothing left to release');
});

test('setMap releases only the bindings that changed', () => {
  const a = { id: 'a', input: { kind: 'button' as const, index: 0 }, action: { kind: 'note' as const, note: 36, velocity: 100 } };
  const b = { id: 'b', input: { kind: 'button' as const, index: 1 }, action: { kind: 'note' as const, note: 37, velocity: 100 } };
  const r = new ControllerRunner(map([a, b]));
  r.frame(pad([1, 1]));
  assert.deepEqual(midi(r.setMap(map([a, { ...b, action: { ...b.action, note: 40 } }]))), [[0x80, 37, 0]]);
  assert.deepEqual(midi(r.frame(pad([1, 1]))), [[0x90, 40, 100]], 'the edited binding re-presses with its new note; the other keeps sounding');
  assert.deepEqual(midi(r.setMap(map([a, { ...b, action: { ...b.action, note: 40 } }], { channel: 3 }))), [[0x80, 36, 0], [0x80, 40, 0]], 'a channel change releases everything on the old channel');
});

test('pad learning, the virtual MIDI check, families and labels', () => {
  assert.deepEqual(detectPadInput(pad([0, 0]), pad([0, 1])), { kind: 'button', index: 1 });
  assert.deepEqual(detectPadInput(pad([], [0, 0]), pad([], [0, -0.9])), { kind: 'axis', index: 1, half: 'minus' });
  assert.equal(detectPadInput(pad([1], [0.5]), pad([1], [0.7])), null, 'already held / already deflected is not a new input');
  assert.ok(isVirtualMidi([0x90, 36, 100, 0xb0, 1, 64]));
  for (const bad of [[], [0x90, 36], [0xf0, 1, 2], [0xe0, 0, 64], [0x90, 128, 1], [0x90, 1.5, 1]]) assert.equal(isVirtualMidi(bad), false, JSON.stringify(bad));
  assert.equal(padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(padFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'switch');
  assert.equal(padFamily('USB Gamepad'), 'generic');
  assert.equal(inputLabel({ kind: 'button', index: 0 }, 'playstation'), 'Cross');
  assert.equal(inputLabel({ kind: 'button', index: 4 }, 'xbox'), 'LB');
  assert.equal(inputLabel({ kind: 'axis', index: 3, half: 'minus' }), 'Right stick up');
  assert.equal(inputLabel({ kind: 'key', code: 'Numpad7' }), 'Num 7');
  assert.equal(inputLabel({ kind: 'key', code: 'KeyQ' }), 'Q');
});

test('midi_setup adds and removes controller maps without MIDI hardware', async () => {
  let settings = { controllers: { enabled: false, maps: [] } } as unknown as Settings;
  const deps = {
    doc: new DocHost(createDefaultProject('T'), CATALOG, { strict: true }),
    getSettings: () => settings,
    updateSettings: (patch: Partial<Settings>) => (settings = { ...settings, controllers: mergeControllers(settings.controllers, patch.controllers) }),
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 't', name: 'T' }, session: newSession(), via: 'test' };
  const call = (args: unknown) => callTool(deps, caller, 'midi_setup', args, { quiet: true });
  const add = await call({ add_controller: 'Gamepad drum pads', controller_name: 'PS5 pads' });
  assert.equal(add.ok, true, add.message);
  assert.match(add.message, /Added the controller map "PS5 pads" \(\d+ bindings, MIDI input "Krypt: PS5 pads"/);
  assert.equal(settings.controllers!.enabled, true, 'adding a map turns maps on');
  const kb = await call({ add_controller: 'keyboard' });
  assert.equal(kb.ok, true, kb.message);
  assert.equal(settings.controllers!.maps[1].source, 'keyboard');
  const bad = await call({ add_controller: 'theremin' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /No controller template "theremin"/);
  const rm = await call({ remove_controller: 'ps5 pads' });
  assert.equal(rm.ok, true, rm.message);
  assert.deepEqual(settings.controllers!.maps.map((m) => m.name), ['Keyboard map']);
  const list = await call({});
  assert.match(list.message, /Controller maps \(on\): "Keyboard map" \(keyboard, on/);
});

run('controllers');
