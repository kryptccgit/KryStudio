import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { installRackFixtures } from './rack-fixtures';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { rackIntegrity } from '@shared/commands/racks';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { ActionResult, Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { cleanSliceOptions, sliceToPads } from '../electron/racks/slice';

installRackFixtures();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-racks-tools-'));
const LOOP = path.join(TMP, 'break.wav');
fs.writeFileSync(LOOP, Buffer.alloc(64));

const SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [{ id: 'tmp', name: 'Tmp', path: TMP }],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
} as Settings;

function analysis(p: string): AudioAnalysis {
  return {
    path: p,
    durationSec: 2,
    sampleRate: 48000,
    channels: 2,
    tempo: { bpm: 120, confidence: 0.9, alternatives: [] },
    beats: null,
    key: null,
    swing: null,
    sections: [],
    levels: {} as AudioAnalysis['levels'],
    stereo: { width: 0.2, correlation: 0.9 },
    energy: { hopSec: 0.5, lufs: [] },
    onsetRate: 4,
    drumHits: [
      { timeSec: 0, role: 'kick', vel: 1 },
      { timeSec: 0.5, role: 'snare', vel: 0.9 },
      { timeSec: 0.75, role: 'hat', vel: 0.3 },
      { timeSec: 1, role: 'kick', vel: 0.95 },
      { timeSec: 1.5, role: 'snare', vel: 0.85 },
    ],
    estimated: [],
    sources: ['fake'],
  };
}

function rig(opts: { analyzer?: boolean } = {}) {
  const doc = new DocHost(createDefaultProject('Test'), CATALOG, { strict: true });
  const analyzed: string[] = [];
  const deps: MainDeps = {
    doc,
    engine: {
      async request() {
        return { ok: true, data: {} as never };
      },
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async render() {
        return { ok: false, message: 'n/a' };
      },
      async analyzeFile() {
        return { ok: false, message: 'n/a' };
      },
      async sampleInfo(p: string) {
        return { ok: true, data: { path: p, frames: 96000, sampleRate: 48000, channels: 2, durationSec: 2 } };
      },
      async restart() {
        return { ok: true };
      },
    } as unknown as MainDeps['engine'],
    project: {
      status: () => ({ path: null, name: 'Test', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => (p.startsWith('factory:') ? '' : p),
      renderDir: () => TMP,
      allowedRoots: () => [TMP],
    },
    getSettings: () => SETTINGS,
    updateSettings: () => SETTINGS,
    broadcast: () => {},
    userDataDir: TMP,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  if (opts.analyzer !== false) {
    deps.analyzer = {
      async analyze(t: { path?: string }): Promise<ActionResult<AudioAnalysis>> {
        analyzed.push(JSON.stringify(t));
        return { ok: true, data: analysis(t.path ?? 'x') };
      },
    } as unknown as MainDeps['analyzer'];
  }
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const byName = (name: string) => Object.values(doc.project.channels).find((c) => c.name.toLowerCase() === name.toLowerCase())!;
  const sound = () => {
    assert.deepEqual(checkIntegrity(doc.project), []);
    assert.deepEqual(rackIntegrity(doc.project), []);
  };
  return { doc, deps, call, byName, sound, analyzed };
}

test('the three rack tools are registered as write tools with long-enough docs', () => {
  for (const n of ['build_rack', 'set_macro', 'slice_to_pads']) {
    const t = getTool(n);
    assert.ok(t, n);
    assert.equal(t.kind, 'write');
    assert.ok(t.description.length > 200, n);
  }
});

test('build_rack: a drum kit on a new channel (pads by note, chokes, sample paths, macro by chain name); one history entry', async () => {
  const { doc, call, byName, sound } = rig();
  const r = await call('build_rack', {
    kind: 'drum',
    name: 'Kit',
    chains: [
      { name: 'Kick', sample: 'factory:drums/kick.wav' },
      { name: 'Snare', sample: 'factory:drums/snare.wav', devices: [{ effect: 'reverb', params: { size: '50%' }, mix: 0.2 }] },
      { name: 'Hat', sample: 'factory:drums/hat-closed.wav', note: 'F#2', choke: 1 },
      { name: 'Open Hat', sample: 'factory:drums/hat-open.wav', note: 'A#2', choke: 1 },
    ],
    macros: [{ name: 'Hat Decay', value: 0.4, maps: [{ chain: 'Open Hat', param: 'ampDecay', min: 0.4, max: 0.9 }] }, { name: 'Verb', maps: [{ chain: 2, device: 'reverb', param: 'mix' }] }],
  });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /drum rack on new channel "Kit"/);
  assert.match(r.message, /1 Hat Decay = 40% \(1 target\)/);
  assert.match(r.text!, /Hat @ F#2 .*choke 1/);
  const ch = byName('Kit');
  const rack = ch.generator.rack!;
  const pads = rack.chainOrder.map((id) => rack.chains[id]);
  assert.deepEqual(pads.map((p) => p.zone!.keyLo), [36, 37, 42, 46]);
  assert.equal(pads[0].instrument!.params.keyTrack, 0, 'pads play at the sample pitch');
  assert.equal(doc.project.samples[pads[1].instrument!.sampleId!].path, 'factory:drums/snare.wav');
  assert.equal(ch.generator.params.macro1, 0.4);
  const agentEntries = doc.getHistory().filter((h) => h.actorKey !== 'user');
  assert.equal(agentEntries.length, 1, 'one undo step');
  sound();
  const again = await call('build_rack', { kind: 'drum', channel: 'Kit', chains: [{ note: 'C2' }, { note: 36 }] });
  assert.equal(again.ok, false);
  assert.match(again.message, /used twice/);
});

test('build_rack: an instrument rack from presets + zones on an existing channel; effect rack on an insert; errors', async () => {
  const { doc, call, byName, sound } = rig();
  const r = await call('build_rack', {
    channel: 'Keys',
    chains: [
      { instrument: 'synth', params: { cutoff: '2kHz' }, keys: 'C0-B3' },
      { instrument: 'wavetable', keys: 'C4-G9', velocity: [0.6, 1], volume_db: -6 },
    ],
    macros: [{ name: 'Tone', maps: [{ chain: 1, param: 'cutoff' }, { chain: 2, param: 'Cutoff', min: 0.2 }] }, { name: 'Top', maps: [{ chain: 2, param: 'volume' }] }],
  });
  assert.equal(r.ok, true, r.message);
  const g = byName('Keys').generator;
  assert.equal(g.type, 'krypt.rack');
  const [a, b] = g.rack!.chainOrder.map((id) => g.rack!.chains[id]);
  assert.deepEqual([a.zone!.keyLo, a.zone!.keyHi, a.instrument!.params.cutoff], [12, 59, 2000]);
  assert.deepEqual([b.zone!.velLo, b.zone!.velHi], [0.6, 1]);
  assert.ok(Math.abs(b.volume - 0.501) < 0.01);
  const insId = byName('Snare').insertId;
  const fx = await call('build_rack', { insert: 'Snare', chains: [{ name: 'Dry' }, { name: 'Crush', devices: [{ effect: 'drive', params: { mode: 'Bitcrush' } }], volume_db: -8 }], macros: [{ name: 'Crush', maps: [{ chain: 'Crush', param: 'volume' }] }] });
  assert.equal(fx.ok, true, fx.message);
  const ins = doc.project.mixer.inserts[insId];
  assert.equal(ins.slots[ins.slotOrder.at(-1)!].type, 'krypt.fxrack');
  sound();
  for (const [args, re] of [
    [{ insert: 'Snare', chains: [{ instrument: 'synth' }] }, /effect rack's chains hold effects only/],
    [{ kind: 'effect', chains: [{}] }, /mixer insert/],
    [{ channel: 'Keys', chains: [{ instrument: 'krypt.rack' }] }, /racks can't hold racks/],
    [{ channel: 'Keys', chains: [{ instrument: 'synth', params: { wobble: 1 } }] }, /no parameter "wobble"/],
    [{ channel: 'Keys', chains: [{ instrument: 'synth' }], macros: [{ maps: [{ chain: 5, param: 'cutoff' }] }] }, /no chain "5"/],
    [{ kind: 'drum', channel: 'Keys', chains: [{ keys: 'C1-C2' }] }, /note|zones/],
  ] as const) {
    const res = await call('build_rack', args);
    assert.equal(res.ok, false, JSON.stringify(args));
    assert.match(res.message, re);
  }
});

test('set_macro: by number / name / values, rename, variations (store, recall by name, remove), seeded randomize, No change', async () => {
  const { doc, call, byName, sound } = rig();
  await call('build_rack', { channel: 'Keys', chains: [{ instrument: 'synth' }], macros: [{ name: 'Tone', maps: [{ chain: 1, param: 'cutoff' }] }, { name: 'Width', maps: [{ chain: 1, param: 'pan' }] }] });
  const g = () => byName('Keys').generator;
  let r = await call('set_macro', { macro: 'tone', value: 0.8 });
  assert.equal(r.ok, true, r.message);
  assert.equal(g().params.macro1, 0.8);
  r = await call('set_macro', { channel: 'Keys', values: { Width: 0.25, '3': 0.5 } });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([g().params.macro2, g().params.macro3], [0.25, 0.5]);
  r = await call('set_macro', { channel: 'Keys', macro: 3, rename: 'Air', store_variation: 'Bright' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /stored variation "Bright"/);
  assert.equal(g().rack!.macros[2].name, 'Air');
  await call('set_macro', { channel: 'Keys', macro: 1, value: 0 });
  r = await call('set_macro', { channel: 'Keys', recall_variation: 'bright' });
  assert.equal(r.ok, true, r.message);
  assert.equal(g().params.macro1, 0.8);
  const noop = await call('set_macro', { channel: 'Keys', macro: 1, value: 0.8 });
  assert.equal(noop.ok, false);
  assert.match(noop.message, /^No change/);
  r = await call('set_macro', { channel: 'Keys', randomize: true, seed: 3 });
  assert.equal(r.ok, true, r.message);
  r = await call('set_macro', { channel: 'Keys', remove_variation: 'Bright' });
  assert.equal(r.ok, true, r.message);
  assert.equal(g().rack!.variationOrder.length, 0);
  const bad = await call('set_macro', { channel: 'Keys', macro: 'Nope', value: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /No macro "Nope"/);
  const notRack = await call('set_macro', { channel: 'Kick', macro: 1, value: 1 });
  assert.match(notRack.message, /not a rack/);
  sound();
  void doc;
});

test('slice_to_pads: onsets from the analyzer → pads + a pattern at the detected tempo; grid and manual; one undo', async () => {
  const { doc, call, sound, analyzed } = rig();
  const r = await call('slice_to_pads', { sample: LOOP, max_slices: 4 });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Sliced "break" at its hits into 4 pads/);
  assert.match(r.message, /at 120 BPM/);
  assert.equal(analyzed.length, 1);
  const d = r.data as { channelId: string; patternId: string; times: number[] };
  assert.deepEqual(d.times, [0, 0.5, 1, 1.5], 'the weakest hit (the hat) is dropped');
  const pat = doc.project.patterns[d.patternId];
  assert.equal(pat.length, 3840);
  sound();
  assert.equal(doc.undo({ kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }).ok, true);
  assert.equal(doc.project.channels[d.channelId], undefined, 'one undo removes it all');
  const grid = await call('slice_to_pads', { sample: LOOP, mode: 'grid', division: 0.25, max_slices: 8, pattern: false, onto: 'Keys' });
  assert.equal(grid.ok, true, grid.message);
  assert.match(grid.message, /every 0.25 beats into 8 pads/);
  const manual = await call('slice_to_pads', { sample: LOOP, mode: 'manual', times: [0.2, 0.9] });
  assert.equal(manual.ok, true, manual.message);
  const two = await call('slice_to_pads', { sample: LOOP, channel: 'Kick' });
  assert.equal(two.ok, false);
  assert.match(two.message, /exactly one source/);
  sound();
});

test('the shared slicer without an analyzer: grid works from the sample length, onsets says why it cannot', async () => {
  const { doc, deps, byName } = rig({ analyzer: false });
  const apply = <T,>(cmd: string, args: unknown): T => {
    const x = doc.exec<T>(cmd, args, { actor: USER });
    if (!x.ok) throw new Error(x.message);
    return x.data as T;
  };
  const sd = { doc, sampleInfo: (p: string) => deps.engine.sampleInfo(p), resolveSamplePath: (p: string) => p };
  const no = await sliceToPads(sd, { channelId: byName('Kick').id }, {}, apply);
  assert.equal(no.ok, false);
  assert.match(no.message!, /needs the audio analyzer/);
  const ok = await sliceToPads(sd, { channelId: byName('Kick').id }, cleanSliceOptions({ mode: 'grid', division: 1, maxSlices: 99, bpm: 120, choke: 1 }), apply);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.data!.slices, 4, '2 s at 120 bpm, one per beat');
  assert.match(ok.message!, /on "Kick slices"/);
  assert.deepEqual(cleanSliceOptions({ maxSlices: 1000, mode: 'x', times: [1, -1, 'a'] }).maxSlices, 64);
});

test('slice_sample: hits → one Slicer channel (keys C4 up) + a replay pattern; re-slicing keeps the channel; one undo', async () => {
  const { doc, call, byName, sound } = rig();
  const agent = { kind: 'agent' as const, clientId: 'test-agent', name: 'Test Agent' };
  assert.equal(getTool('slice_sample')?.kind, 'write');
  const before = Object.keys(doc.project.channels).length;
  const r = await call('slice_sample', { sample: LOOP, max_slices: 4 });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Sliced "break" at its hits into 4 slices on the Slicer "break slicer" \(keys C4-D#4\), with a pattern replaying it at 120 BPM/);
  assert.match(r.message, /4: D#4 @ 1\.500 s/);
  const d = r.data as { channelId: string; patternId: string; times: number[]; to: string; baseKey: number };
  assert.deepEqual([d.to, d.baseKey, d.times], ['slicer', 60, [0, 0.5, 1, 1.5]]);
  const ch = doc.project.channels[d.channelId];
  assert.equal(ch.generator.type, 'krypt.slicer');
  assert.deepEqual(Object.values(doc.project.patterns[d.patternId].notes[d.channelId]).map((n) => n.key).sort(), [60, 61, 62, 63]);
  assert.equal(Object.keys(doc.project.channels).length, before + 1, 'one channel, not a rack of pads');
  sound();
  const grid = await call('slice_sample', { channel: 'break slicer', mode: 'grid', division: 0.5, pattern: false });
  assert.equal(grid.ok, true, grid.message);
  assert.equal((grid.data as { channelId: string }).channelId, d.channelId);
  assert.equal(doc.project.channels[d.channelId].generator.slices!.length, 8);
  assert.equal(doc.undo(agent).ok, true);
  assert.equal(doc.project.channels[d.channelId].generator.slices!.length, 4, 'one undo per call');
  const both = await call('slice_sample', { sample: LOOP, channel: 'Kick' });
  assert.match(both.message, /exactly one source/);
  void byName;
});

test('edit_slices: clear / remove / move / add / set in order, numbered slices, refusals and "No change"', async () => {
  const { doc, call, sound } = rig();
  const r = await call('slice_sample', { sample: LOOP, mode: 'manual', times: [0, 0.5, 1, 1.5], pattern: false });
  assert.equal(r.ok, true, r.message);
  const id = (r.data as { channelId: string }).channelId;
  const secs = () => doc.project.channels[id].generator.slices!.map((s) => s.sec);
  const e = await call('edit_slices', { channel: 'break slicer', remove: [2], move: [{ slice: 1, sec: 0.1 }], add: [0.75], set: [{ slice: 2, reverse: true, pitch: -3 }] });
  assert.equal(e.ok, true, e.message);
  assert.deepEqual(secs(), [0.1, 0.75, 1, 1.5], 'remove uses the numbers before the call; move numbers after it');
  assert.match(e.message, /2: C#4 @ 0\.750 s \(-3 st, reversed\)/);
  const cross = await call('edit_slices', { channel: 'break slicer', move: [{ slice: 3, sec: 0.5 }] });
  assert.equal(cross.ok, false);
  assert.match(cross.message, /slice 2 \(at 0\.75 s\)/);
  assert.deepEqual(secs(), [0.1, 0.75, 1, 1.5], 'a refused call changes nothing');
  const none = await call('edit_slices', { channel: 'break slicer' });
  assert.equal(none.ok, false);
  assert.match(none.message, /^No change:/);
  const missing = await call('edit_slices', { channel: 'break slicer', set: [{ slice: 9, gain: 0.5 }] });
  assert.match(missing.message, /there is no slice 9/);
  const notSlicer = await call('edit_slices', { channel: 'Kick', add: [0.1] });
  assert.match(notSlicer.message, /not a Slicer channel/);
  const pat = await call('edit_slices', { channel: 'break slicer', clear: true, add: [0, 1], pattern: true, bpm: 120 });
  assert.equal(pat.ok, true, pat.message);
  assert.deepEqual(secs(), [0, 1]);
  assert.match(pat.message, /replays it/);
  sound();
});

run('racks tools');
