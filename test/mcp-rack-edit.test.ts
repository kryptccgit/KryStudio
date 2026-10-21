// edit_rack (electron/mcp/tools/racks.ts): change a rack in place through callTool against a real strict DocHost —
// chains, pads, instruments, samples, devices, macro maps — as one undo step that rolls back when any op fails, a
// "No change" when nothing moves, and the no-ops listing (chains, devices and macro maps with ids).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { installRackFixtures } from './rack-fixtures';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { rackIntegrity } from '@shared/commands/racks';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';

installRackFixtures();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-rack-edit-'));

const SETTINGS = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [{ id: 'tmp', name: 'Tmp', path: TMP }],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
} as unknown as Settings;

function rig() {
  const doc = new DocHost(createDefaultProject('Test'), CATALOG, { strict: true });
  const deps = {
    doc,
    engine: {
      async request() {
        return { ok: true, data: {} };
      },
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async sampleInfo(p: string) {
        return { ok: true, data: { path: p, frames: 96000, sampleRate: 48000, channels: 2, durationSec: 2 } };
      },
    },
    project: {
      status: () => ({ path: null, name: 'Test', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p: string) => (p.startsWith('factory:') ? '' : p),
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
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const byName = (name: string) => Object.values(doc.project.channels).find((c) => c.name.toLowerCase() === name.toLowerCase())!;
  const sound = () => {
    assert.deepEqual(checkIntegrity(doc.project), []);
    assert.deepEqual(rackIntegrity(doc.project), []);
  };
  const agentEntries = () => doc.getHistory().filter((h) => h.actorKey !== 'user' && !h.undone).length;
  return { doc, call, byName, sound, agentEntries };
}

async function kit(call: ReturnType<typeof rig>['call']) {
  const r = await call('build_rack', {
    kind: 'drum',
    name: 'Kit',
    chains: [
      { name: 'Kick', sample: 'factory:drums/kick.wav' },
      { name: 'Snare', sample: 'factory:drums/snare.wav', devices: [{ effect: 'reverb', mix: 0.2 }] },
      { name: 'Hat', sample: 'factory:drums/hat-closed.wav', note: 'F#2' },
    ],
    macros: [{ name: 'Verb', maps: [{ chain: 'Snare', device: 'reverb', param: 'mix' }] }],
  });
  assert.equal(r.ok, true, r.message);
}

test('edit_rack is a write tool; with no ops it lists the rack with ids and changes nothing', async () => {
  const t = getTool('edit_rack');
  assert.ok(t);
  assert.equal(t.kind, 'write');
  assert.ok(t.description.length > 400);
  const { doc, call, byName } = rig();
  await kit(call);
  const v = doc.version;
  const r = await call('edit_rack', { channel: 'Kit' });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.version, v);
  const rack = byName('Kit').generator.rack!;
  const snare = rack.chains[rack.chainOrder[1]];
  assert.match(r.text!, /^Drum rack on "Kit" · 3 chains/);
  assert.ok(r.text!.includes(`2. Snare [${snare.id}] · pad C#2 · Sampler (Snare)`), r.text);
  assert.ok(r.text!.includes(`1) Reverb [${snare.deviceOrder[0]}] mix 20%`), r.text);
  assert.match(r.text!, /Macro 1 "Verb" = 0% → Snare Reverb mix 0-100% \[/);
  const plain = await call('edit_rack', { channel: 'Kick' });
  assert.equal(plain.ok, false);
  assert.match(plain.message, /not a rack/);
});

test('drum rack: pads, samples, chokes, devices and macro maps in one undo step', async () => {
  const { doc, call, byName, sound, agentEntries } = rig();
  await kit(call);
  const before = agentEntries();
  const r = await call('edit_rack', {
    channel: 'Kit',
    ops: [
      { op: 'set_sample', note: 'D2', sample: 'factory:drums/clap.wav', name: 'Clap' },
      { op: 'set_chain', chain: 'Hat', note: 'G#2', choke: 1, volume_db: -6 },
      { op: 'add_chain', name: 'Open Hat', sample: 'factory:drums/hat-open.wav', note: 'A#2', choke: 1 },
      { op: 'add_device', chain: 'Snare', effect: 'delay', mix: 0.3, index: 1 },
      { op: 'set_device', chain: 'Snare', device: 'reverb', mix: 0.5, enabled: false },
      { op: 'map_macro', macro: 'Verb', chain: 'Open Hat', param: 'volume', min: 0.2, max: 0.8 },
      { op: 'move_chain', chain: 'Clap', to: 1 },
      { op: 'set_sample', chain: 'Kick', sample: 'factory:drums/kick-2.wav' },
    ],
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(agentEntries(), before + 1, 'one undo step');
  assert.match(r.message, /pad D2 \(new\) plays clap\.wav/);
  const p = doc.project;
  const rack = byName('Kit').generator.rack!;
  const chains = rack.chainOrder.map((id) => rack.chains[id]);
  assert.deepEqual(chains.map((c) => c.name), ['Clap', 'Kick', 'Snare', 'Hat', 'Open Hat']);
  const hat = chains[3];
  assert.deepEqual([hat.zone!.keyLo, hat.choke, Math.round(hat.volume * 1000) / 1000], [44, 1, 0.501]);
  assert.equal(p.samples[chains[1].instrument!.sampleId!].path, 'factory:drums/kick-2.wav');
  const snare = chains[2];
  assert.deepEqual(snare.deviceOrder.map((id) => snare.devices[id].type), ['krypt.delay', 'krypt.reverb']);
  const verb = snare.devices[snare.deviceOrder[1]];
  assert.deepEqual([verb.mix, verb.enabled], [0.5, false]);
  const maps = Object.values(rack.macros[0].maps);
  assert.equal(maps.length, 2);
  assert.ok(maps.some((m) => m.target.kind === 'chain' && m.target.chainId === chains[4].id && m.min === 0.2 && m.max === 0.8));
  assert.match(r.text!, /Hat \[[^\]]+\] · pad G#2 · Sampler \(Hat\) · -6\.0 dB · choke 1/);
  sound();

  // Removing a device / chain takes its macro maps with it; unmap by target; undo puts everything back.
  const r2 = await call('edit_rack', {
    channel: 'Kit',
    ops: [
      { op: 'unmap_macro', macro: 1, chain: 'Open Hat', param: 'volume' },
      { op: 'remove_device', chain: 'Snare', device: 'reverb' },
      { op: 'remove_chain', chain: 1 },
    ],
  });
  assert.equal(r2.ok, true, r2.message);
  assert.match(r2.message, /removed Reverb from "Snare" \(and 1 macro map\)/);
  const rack2 = byName('Kit').generator.rack!;
  assert.equal(Object.keys(rack2.macros[0].maps).length, 0);
  assert.deepEqual(rack2.chainOrder.map((id) => rack2.chains[id].name), ['Kick', 'Snare', 'Hat', 'Open Hat']);
  sound();
});

test('instrument rack: swap an instrument, set params, zones, move a device to another chain; effect rack devices', async () => {
  const { doc, call, byName, sound } = rig();
  const b = await call('build_rack', {
    channel: 'Keys',
    chains: [
      { instrument: 'synth', keys: 'C0-B3', devices: [{ effect: 'chorus' }] },
      { instrument: 'wavetable', keys: 'C4-G9' },
    ],
    macros: [{ name: 'Tone', maps: [{ chain: 1, param: 'cutoff' }] }],
  });
  assert.equal(b.ok, true, b.message);
  const r = await call('edit_rack', {
    channel: 'Keys',
    ops: [
      { op: 'set_instrument', chain: 1, instrument: 'fm' },
      { op: 'set_instrument', chain: 2, params: { cutoff: '2kHz' } },
      { op: 'set_chain', chain: 2, all_keys: true, name: 'Pad', mute: true },
      { op: 'set_chain', chain: 1, keys: 'C2-B5', velocity: [0.5, 1] },
      { op: 'move_device', chain: 1, device: 'chorus', to: 1, to_chain: 'Pad' },
    ],
  });
  assert.equal(r.ok, true, r.message);
  const rack = byName('Keys').generator.rack!;
  const [c1, c2] = rack.chainOrder.map((id) => rack.chains[id]);
  assert.equal(c1.instrument!.type, 'krypt.fm');
  assert.deepEqual(c1.zone, { keyLo: 36, keyHi: 83, velLo: 0.5, velHi: 1 });
  assert.equal(c2.name, 'Pad');
  assert.equal(c2.zone, undefined);
  assert.equal(c2.mute, true);
  assert.ok(Math.abs(c2.instrument!.params.cutoff - 2000) < 1);
  assert.deepEqual(c2.deviceOrder.map((id) => c2.devices[id].type), ['krypt.chorus']);
  assert.equal(c1.deviceOrder.length, 0);
  sound();

  // Effect rack on an insert: devices only.
  const fx = await call('build_rack', { kind: 'effect', insert: 'master', chains: [{ name: 'Dry' }, { name: 'Wet', devices: [{ effect: 'reverb' }] }] });
  assert.equal(fx.ok, true, fx.message);
  const e = await call('edit_rack', { insert: 'master', ops: [{ op: 'add_device', chain: 'Dry', effect: 'eq' }, { op: 'set_chain', chain: 'Wet', volume_db: -3 }] });
  assert.equal(e.ok, true, e.message);
  const bad = await call('edit_rack', { insert: 'master', ops: [{ op: 'set_instrument', chain: 1, instrument: 'synth' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /effects only/);
  assert.equal(doc.project.mixer.inserts[doc.project.mixer.masterId].slots[doc.project.mixer.inserts[doc.project.mixer.masterId].slotOrder.find((s) => doc.project.mixer.inserts[doc.project.mixer.masterId].slots[s].type === 'krypt.fxrack')!].rack!.chainOrder.length, 2);
  sound();
});

test('a failing op rolls the whole call back; edits that change nothing are "No change"', async () => {
  const { doc, call, byName } = rig();
  await kit(call);
  const before = JSON.stringify(byName('Kit').generator);
  const r = await call('edit_rack', {
    channel: 'Kit',
    ops: [
      { op: 'set_chain', chain: 'Kick', name: 'Big Kick' },
      { op: 'remove_device', chain: 1, device: 'reverb' },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /Chain "Big Kick" has no device "reverb"/);
  assert.equal(JSON.stringify(byName('Kit').generator), before, 'the rename was rolled back');
  const same = await call('edit_rack', { channel: 'Kit', ops: [{ op: 'move_chain', chain: 'Kick', to: 1 }] });
  assert.equal(same.ok, false);
  assert.match(same.message, /^No change/);
  const clash = await call('edit_rack', { channel: 'Kit', ops: [{ op: 'set_chain', chain: 'Hat', note: 'C2' }] });
  assert.equal(clash.ok, false);
  assert.match(clash.message, /already has a chain \("Kick"\)/);
  const noChain = await call('edit_rack', { channel: 'Kit', ops: [{ op: 'set_chain', chain: 'Cowbell', mute: true }] });
  assert.match(noChain.message, /no chain "Cowbell"\. Its chains: 1\. Kick, 2\. Snare, 3\. Hat/);
  assert.equal(doc.project.channels[byName('Kit').id].generator.rack!.chainOrder.length, 3);
});

await run('mcp rack edit');
fs.rmSync(TMP, { recursive: true, force: true });
