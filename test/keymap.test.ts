import assert from 'node:assert/strict';
import { test, run } from './harness';
import { normalizeKeys, sanitizeKeymapOverrides } from '@shared/keymap';
import {
  DEFAULT_KEYMAP,
  applyKeymapOverrides,
  bindingFor,
  contextForCommand,
  findKeyConflicts,
  keysForCommand,
  rebindOverrides,
  setKeymap,
  type KeyBinding,
} from '../src/input/keymap';
import { exportRequest, type ExportPrefs } from '../src/app/exportRequest';
import { createDefaultProject } from '@shared/schema/factory';
import { PPQ } from '@shared/schema/time';

test('normalizeKeys orders modifiers like eventToKeys and rejects junk', () => {
  assert.equal(normalizeKeys('Shift+Alt+Y'), 'Alt+Shift+Y');
  assert.equal(normalizeKeys('shift+ctrl+s'), 'Ctrl+Shift+S');
  assert.equal(normalizeKeys('cmd+z'), 'Ctrl+Z');
  assert.equal(normalizeKeys('F5'), 'F5');
  assert.equal(normalizeKeys('NumpadAdd'), 'NumpadAdd');
  assert.equal(normalizeKeys('Ctrl'), '');
  assert.equal(normalizeKeys('Ctrl+A+B'), '');
  assert.equal(normalizeKeys(''), '');
  assert.equal(normalizeKeys('Ctrl+<script>'), '');
});

test('settings validation keeps only sane overrides', () => {
  assert.equal(sanitizeKeymapOverrides(null), undefined);
  assert.equal(sanitizeKeymapOverrides([['x']]), undefined);
  const s = sanitizeKeymapOverrides({
    'pianoRoll.glue': ['ctrl+j', 'Ctrl+J', 'Alt+J', 'F1', 'F2', 'F3'],
    'transport.panic': [],
    'bad id!': ['F1'],
    'file.save': 'Ctrl+S',
    'edit.undo': [42, 'Ctrl+'],
  })!;
  assert.deepEqual(s['pianoRoll.glue'], ['Ctrl+J', 'Alt+J', 'F1', 'F2']);
  assert.deepEqual(s['transport.panic'], []);
  assert.equal('bad id!' in s, false);
  assert.equal('file.save' in s, false);
  assert.deepEqual(s['edit.undo'], []);
});

test('no overrides = defaults, canonical keys; Shift+Alt+Y matches the event form', () => {
  const map = applyKeymapOverrides(DEFAULT_KEYMAP, null);
  assert.equal(map.length, DEFAULT_KEYMAP.length);
  assert.deepEqual(keysForCommand(map, 'edit.redo'), ['Ctrl+Y', 'Ctrl+Shift+Z']);
  assert.deepEqual(keysForCommand(map, 'pianoRoll.flipV'), ['Alt+Shift+Y']);
  setKeymap(map);
  assert.equal(bindingFor('Alt+Shift+Y', 'pianoRoll')?.command, 'pianoRoll.flipV');
  assert.equal(bindingFor('Alt+Shift+Y', null), undefined);
  assert.equal(bindingFor('F11')?.command, 'file.projectInfo');
});

test('overrides replace a command’s defaults and keep its flags/context', () => {
  const map = applyKeymapOverrides(DEFAULT_KEYMAP, { 'edit.redo': ['Ctrl+Shift+Y'], 'transport.panic': [], 'pianoRoll.glue': ['Ctrl+J'], 'pianoRoll.scaleSnap': ['Alt+H'] });
  assert.deepEqual(keysForCommand(map, 'edit.redo'), ['Ctrl+Shift+Y']);
  assert.equal(map.find((b) => b.command === 'edit.redo')?.repeat, true);
  assert.deepEqual(keysForCommand(map, 'transport.panic'), []);
  assert.equal(map.find((b) => b.command === 'pianoRoll.glue')?.context, 'pianoRoll');
  assert.equal(contextForCommand('pianoRoll.scaleSnap'), 'pianoRoll');
  assert.equal(map.find((b) => b.command === 'pianoRoll.scaleSnap')?.context, 'pianoRoll');
  assert.equal(contextForCommand('file.save'), undefined);
});

test('conflicts: same scope is hard, global vs editor is a soft note', () => {
  const map: KeyBinding[] = applyKeymapOverrides(DEFAULT_KEYMAP, null);
  const hard = findKeyConflicts(map, 'Ctrl+S', 'file.open', null);
  assert.deepEqual(hard.map((c) => [c.kind, c.binding.command]), [['same-scope', 'file.save']]);
  assert.deepEqual(findKeyConflicts(map, 'Ctrl+G', 'file.open', null).map((c) => c.kind), ['shadowed']);
  assert.deepEqual(findKeyConflicts(map, 'Space', 'pianoRoll.glue', 'pianoRoll').map((c) => [c.kind, c.binding.command]), [['shadows', 'transport.togglePlay']]);
  assert.deepEqual(findKeyConflicts(map, 'Ctrl+S', 'file.save', null), []);
  assert.deepEqual(findKeyConflicts(map, 'Ctrl+L', 'pianoRoll.chop', 'pianoRoll').map((c) => c.kind), ['same-scope']);
});

test('rebind: replace strips the combo from the conflicting command; back-to-default is dropped', () => {
  let ov = rebindOverrides(DEFAULT_KEYMAP, {}, 'file.open', 'Ctrl+S', true);
  assert.deepEqual(ov, { 'file.save': [], 'file.open': ['Ctrl+S'] });
  const map = applyKeymapOverrides(DEFAULT_KEYMAP, ov);
  assert.deepEqual(keysForCommand(map, 'file.save'), []);
  setKeymap(map);
  assert.equal(bindingFor('Ctrl+S')?.command, 'file.open');
  ov = rebindOverrides(DEFAULT_KEYMAP, ov, 'transport.panic', null);
  assert.deepEqual(ov['transport.panic'], []);
  ov = rebindOverrides(DEFAULT_KEYMAP, { 'file.new': ['Ctrl+Alt+N'] }, 'file.new', 'Ctrl+N');
  assert.equal('file.new' in ov, false);
  setKeymap(applyKeymapOverrides(DEFAULT_KEYMAP, null));
});

test('export dialog builds the right render request per scope', () => {
  const p = createDefaultProject('Exp');
  const base: ExportPrefs = { scope: 'song', patternId: null, loops: 1, format: 'wav16', tail: 'leave', tailSec: 3, normalize: true, openFolder: true };
  const song = exportRequest(base, p)!;
  assert.deepEqual(song.opts, { scope: { kind: 'song' }, format: 'wav16', tailSec: 3, normalize: true });
  assert.equal(song.ticks % (PPQ * 4), 0);
  const pid = p.transport.activePatternId!;
  const pat = exportRequest({ ...base, scope: 'pattern', patternId: pid, loops: 4, tail: 'cut', normalize: false }, p)!;
  assert.deepEqual(pat.opts, { scope: { kind: 'pattern', patternId: pid }, format: 'wav16', tailSec: 0, loops: 4 });
  p.transport.loop = { enabled: false, start: 0, end: 0 };
  assert.equal(exportRequest({ ...base, scope: 'loop' }, p), null);
  p.transport.loop = { enabled: true, start: PPQ * 4, end: PPQ * 12 };
  const loop = exportRequest({ ...base, scope: 'loop' }, p)!;
  assert.deepEqual(loop.opts.scope, { kind: 'range', startTick: PPQ * 4, endTick: PPQ * 12 });
  assert.equal(loop.ticks, PPQ * 8);
  assert.deepEqual(exportRequest({ ...base, format: 'mp3', mp3Kbps: 192 }, p)!.opts.mp3Kbps, 192);
  assert.equal(exportRequest({ ...base, format: 'mp3' }, p)!.opts.mp3Kbps, 320);
  assert.equal('mp3Kbps' in song.opts, false);
});

void run('keymap + export');
