// Device racks, macros, the drum rack and the slicer (shared/commands/racks.ts, research/16 §2.3): every rack.*
// command through a strict DocHost, undo, integrity (checkIntegrity + rackIntegrity), macros through the normal
// ParamRef path, presets with racks (save / load round trip, inner samples) and the factory rack presets — all
// against a fixture catalog that has the rack plugins (test/rack-fixtures.ts).
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { installRackFixtures } from './rack-fixtures';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, MAX_FX_SLOTS, type Project } from '@shared/schema/project';
import { FX_RACK_PLUGIN, MACRO_COUNT, MAX_RACK_CHAINS, type RackDef } from '@shared/schema/rack';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { listCommands, getCommand } from '@shared/commands/registry';
import { DEVICE_RACK_COMMANDS, cleanSlices, rackIntegrity, seededRandom, sliceTimes } from '@shared/commands/racks';
import { zPreset } from '@shared/sounds/schema';
import { chainFromInsert, presetFromChannel } from '@shared/sounds/capture';
import { rackToSpec } from '@shared/sounds/rackSpec';
import { RACK_CHAIN_PRESETS, RACK_INSTRUMENT_PRESETS } from '@shared/sounds/factory/racks';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import { clampToSpec, type ParamSpec, type PluginDescriptor } from '@shared/plugins/types';
import { isRackPreset, pickPreset } from '@shared/sounds/select';
import { LEGACY_FACTORY_PATHS, type ChainPreset, type InstrumentPreset } from '@shared/sounds/types';

installRackFixtures();

function host() {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  const byName = (n: string) => Object.values(doc.project.channels).find((c) => c.name === n)!;
  const exec = <T = any>(cmd: string, args: unknown) => doc.exec<T>(cmd, args, { actor: USER });
  const ok = <T = any>(cmd: string, args: unknown): T => {
    const r = exec<T>(cmd, args);
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const bad = (cmd: string, args: unknown, re: RegExp) => {
    const v = doc.version;
    const r = exec(cmd, args);
    assert.equal(r.ok, false, `${cmd} should fail`);
    assert.match(r.message ?? '', re);
    assert.equal(doc.version, v, `${cmd}: a failed command changes nothing`);
  };
  const sound = () => {
    assert.deepEqual(checkIntegrity(doc.project), []);
    assert.deepEqual(rackIntegrity(doc.project), []);
  };
  return { doc, byName, exec, ok, bad, sound };
}

const snap = (p: Project) => JSON.stringify(p);
const rackOf = (doc: DocHost, channelId: string): RackDef => doc.project.channels[channelId].generator.rack!;
const chains = (r: RackDef) => r.chainOrder.map((id) => r.chains[id]);

test('every rack.* command is registered, ids are unique and none clash with the step tools', () => {
  const ids = listCommands().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command ids');
  assert.equal(DEVICE_RACK_COMMANDS.length, 22);
  for (const c of DEVICE_RACK_COMMANDS) {
    assert.ok(c.id.startsWith('rack.'), c.id);
    assert.equal(getCommand(c.id), c);
    assert.ok(c.description.length > 20, `${c.id} needs a description (MCP docs reuse it)`);
  }
  for (const id of ['rack.create', 'rack.addChain', 'rack.removeChain', 'rack.setChain', 'rack.moveChain', 'rack.setInstrument', 'rack.addDevice', 'rack.removeDevice', 'rack.moveDevice', 'rack.setDeviceParams', 'rack.setInstrumentParams', 'rack.mapMacro', 'rack.unmapMacro', 'rack.renameMacro', 'rack.storeVariation', 'rack.recallVariation', 'rack.removeVariation', 'rack.randomizeMacros', 'rack.drumPad', 'rack.sliceToPads']) {
    assert.ok(getCommand(id), `missing ${id} (research/16 §2.3)`);
  }
});

test('rack.create wraps a channel instrument into chain 1 (params kept), one undo step', () => {
  const { doc, byName, ok, sound } = host();
  const keys = byName('Keys');
  ok('channels.setGenParams', { id: keys.id, params: { cutoff: 3000 } });
  ok('automation.create', { target: `channel/${keys.id}/gen/cutoff`, trackId: doc.project.playlist.trackOrder[0], start: 0 });
  const before = snap(doc.project);
  const r = ok<{ channelId: string; chainId: string; clearedAutomation: number; movedAutomation: number }>('rack.create', { channelId: keys.id });
  const g = doc.project.channels[keys.id].generator;
  assert.equal(g.type, 'krypt.rack');
  assert.deepEqual(g.params, {});
  const [c] = chains(g.rack!);
  assert.equal(c.id, r.chainId);
  assert.equal(c.instrument!.type, 'krypt.triosc');
  assert.equal(c.instrument!.params.cutoff, 3000);
  assert.equal(c.zone, undefined, 'instrument-rack chains play every note by default');
  // Wave 12.2b: automation on the old instrument param follows it into the rack (an inner ParamRef).
  assert.equal(r.clearedAutomation, 0);
  assert.equal(r.movedAutomation, 1);
  assert.ok(Object.values(doc.project.automations).some((a) => a.target === `channel/${keys.id}/rack/${r.chainId}/inst/cutoff`));
  assert.equal(g.rack!.macros.length, MACRO_COUNT);
  sound();
  assert.equal(doc.getHistory().at(-1)!.label, 'Wrap in rack');
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(snap(doc.project), before, 'undo restores the instrument');
});

test('rack.create: drum rack keeps the sample on pad C2 (key tracking off); an empty rack; errors', () => {
  const { doc, byName, ok, bad, sound } = host();
  const kick = byName('Kick');
  const sampleId = kick.generator.sampleId;
  ok('rack.create', { channelId: kick.id, kind: 'drum' });
  const [pad] = chains(rackOf(doc, kick.id));
  assert.equal(doc.project.channels[kick.id].generator.type, 'krypt.drumrack');
  assert.equal(pad.instrument!.sampleId, sampleId);
  assert.deepEqual(pad.zone, { keyLo: kick.rootKey, keyHi: kick.rootKey, velLo: 0, velHi: 1 }, "the pad sits on the channel's root key, so its notes keep playing");
  assert.equal(pad.instrument!.params.keyTrack, 0);
  assert.equal(pad.choke, 0);
  const keys = byName('Keys');
  ok('rack.create', { channelId: keys.id, wrap: false });
  assert.equal(rackOf(doc, keys.id).chainOrder.length, 0);
  bad('rack.create', { channelId: keys.id }, /already plays a rack/);
  bad('rack.create', { channelId: byName('Clap').id, kind: 'effect' }, /mixer slots/);
  bad('rack.create', {}, /channelId, or an insertId/);
  sound();
});

test('rack.create on a mixer slot wraps the effect (mix moves inside); {insertId} adds an empty effect rack', () => {
  const { doc, byName, ok, bad, sound } = host();
  const insId = byName('Clap').insertId;
  const eq = ok<{ id: string }>('mixer.addSlot', { insertId: insId, type: 'krypt.eq', params: { b2Gain: 3 }, mix: 0.6 }).id;
  const r = ok<{ slotId: string; chainId: string }>('rack.create', { insertId: insId, slotId: eq });
  const slot = doc.project.mixer.inserts[insId].slots[eq];
  assert.equal(r.slotId, eq, 'the rack keeps the slot id (automation on its macros stays valid)');
  assert.equal(slot.type, FX_RACK_PLUGIN);
  assert.equal(slot.mix, 1);
  const c = slot.rack!.chains[r.chainId];
  const dev = c.devices[c.deviceOrder[0]];
  assert.equal(dev.type, 'krypt.eq');
  assert.equal(dev.mix, 0.6);
  assert.equal(dev.params.b2Gain, 3);
  const added = ok<{ slotId: string }>('rack.create', { insertId: insId, kind: 'effect' });
  assert.equal(doc.project.mixer.inserts[insId].slots[added.slotId].rack!.kind, 'effect');
  bad('rack.create', { insertId: insId, kind: 'drum' }, /effect rack/);
  bad('rack.create', { insertId: insId, slotId: eq }, /already holds a rack/);
  sound();
});

test('chains: add (drum pads take the next free note), set, move, remove (+ its macro maps); one undo each', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Kick').id;
  ok('rack.create', { channelId: ch, kind: 'drum' });
  const t = { channelId: ch };
  const a = ok<{ chainId: string }>('rack.addChain', { ...t, instrument: { type: 'krypt.drumsynth', params: { voice: 1 } } }).chainId;
  const b = ok<{ chainId: string }>('rack.addChain', { ...t, name: 'Hat', instrument: { type: 'krypt.sampler', samplePath: 'factory:drums/hat-closed.wav' }, choke: 1 }).chainId;
  const r = rackOf(doc, ch);
  assert.equal(r.chains[a].zone!.keyLo, 36, 'the wrapped kick sits on its root key (C4), so C2 is the first free pad');
  assert.equal(r.chains[a].name, 'Pad C2');
  assert.equal(r.chains[b].zone!.keyLo, 37);
  assert.equal(r.chains[b].choke, 1);
  assert.ok(doc.project.samples[r.chains[b].instrument!.sampleId!], 'the sample path was pooled');
  bad('rack.addChain', { ...t, zone: { keyLo: 36, keyHi: 36, velLo: 0, velHi: 1 } }, /Pad C2 already has a chain/);
  bad('rack.addChain', { ...t, zone: { keyLo: 50, keyHi: 40, velLo: 0, velHi: 1 } }, /starts above its end/);
  ok('rack.setChain', { ...t, chainId: a, name: 'Snare Synth', volume: 0.5, pan: -0.3, mute: true, solo: true, choke: 2 });
  const c = rackOf(doc, ch).chains[a];
  assert.deepEqual([c.name, c.volume, c.pan, c.mute, c.solo, c.choke], ['Snare Synth', 0.5, -0.3, true, true, 2]);
  bad('rack.setChain', { ...t, chainId: a, zone: null }, /needs its note/);
  bad('rack.setChain', { ...t, chainId: a, zone: { keyLo: 37, keyHi: 37, velLo: 0, velHi: 1 } }, /already has a chain/);
  ok('rack.moveChain', { ...t, chainId: b, toIndex: 0 });
  assert.equal(rackOf(doc, ch).chainOrder[0], b);
  ok('rack.mapMacro', { ...t, macro: 1, target: { chainId: a, kind: 'chain', param: 'volume' } });
  ok('rack.removeChain', { ...t, chainId: a });
  assert.equal(rackOf(doc, ch).chains[a], undefined);
  assert.deepEqual(rackOf(doc, ch).macros[0].maps, {}, 'maps onto a removed chain go with it');
  sound();
  const v = snap(doc.project);
  ok('rack.setChain', { ...t, chainId: b, pan: 0.5 });
  doc.undo(USER);
  assert.equal(snap(doc.project), v);
});

test('instrument racks: zones, choke refused, instruments and their params (clamped), sample kept on swap', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Keys').id;
  ok('rack.create', { channelId: ch });
  const t = { channelId: ch };
  const [first] = rackOf(doc, ch).chainOrder;
  const lay = ok<{ chainId: string }>('rack.addChain', { ...t, instrument: { type: 'krypt.wavetable', params: { cutoff: 99999 } }, zone: { keyLo: 60, keyHi: 127, velLo: 0.5, velHi: 1 } }).chainId;
  const c = rackOf(doc, ch).chains[lay];
  assert.equal(c.instrument!.params.cutoff, 20000, 'clamped to the spec');
  assert.equal(c.name, 'Wave', 'named after the instrument');
  bad('rack.addChain', { ...t, choke: 1 }, /drum-rack pads/);
  bad('rack.setInstrumentParams', { ...t, chainId: lay, params: { nope: 1 } }, /no parameter "nope"/);
  ok('rack.setInstrumentParams', { ...t, chainId: lay, params: { reso: 0.5, unison: 99 } });
  assert.equal(rackOf(doc, ch).chains[lay].instrument!.params.unison, 8);
  ok('rack.mapMacro', { ...t, macro: 2, target: { chainId: lay, kind: 'instrument', param: 'unison' } });
  ok('rack.mapMacro', { ...t, macro: 2, target: { chainId: lay, kind: 'instrument', param: 'cutoff' } });
  // Swap to the sampler: 'unison' doesn't exist there (map removed), 'cutoff' does (kept); then load a sample.
  const r = ok<{ removedMaps: number }>('rack.setInstrument', { ...t, chainId: lay, type: 'krypt.sampler' });
  assert.equal(r.removedMaps, 1);
  assert.equal(Object.keys(rackOf(doc, ch).macros[1].maps).length, 1);
  ok('rack.setChainSample', { ...t, chainId: lay, samplePath: 'factory:drums/perc.wav', rename: true });
  assert.equal(rackOf(doc, ch).chains[lay].name, 'perc');
  ok('rack.setInstrument', { ...t, chainId: lay, type: 'krypt.sampler', params: { gain: -3 } });
  assert.ok(rackOf(doc, ch).chains[lay].instrument!.sampleId, 'swapping sampler → sampler keeps the sample');
  ok('rack.setChain', { ...t, chainId: first, zone: { keyLo: 0, keyHi: 59, velLo: 0, velHi: 1 } });
  ok('rack.setChain', { ...t, chainId: first, zone: null });
  assert.equal(rackOf(doc, ch).chains[first].zone, undefined);
  sound();
});

test('v1 limits: no third-party, no nested racks, no audio clip player, chain and device caps', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Keys').id;
  ok('rack.create', { channelId: ch });
  const t = { channelId: ch };
  const [c] = rackOf(doc, ch).chainOrder;
  bad('rack.addChain', { ...t, instrument: { type: 'krypt.rack' } }, /Racks inside racks/);
  bad('rack.addChain', { ...t, instrument: { type: 'vst3:ABCDEF' } }, /stock instruments/);
  bad('rack.addChain', { ...t, instrument: { type: 'krypt.audioclip' } }, /Audio Clip/);
  bad('rack.addChain', { ...t, instrument: { type: 'krypt.reverb' } }, /effect, not an instrument/);
  bad('rack.addDevice', { ...t, chainId: c, type: FX_RACK_PLUGIN }, /Racks inside racks/);
  bad('rack.addDevice', { ...t, chainId: c, type: 'clap:com.x.y' }, /stock effects/);
  bad('rack.addDevice', { ...t, chainId: c, type: 'krypt.eq', params: { b2Gain: 1, bogus: 2 } }, /no parameter "bogus"/);
  for (let i = 0; i < MAX_FX_SLOTS; i++) ok('rack.addDevice', { ...t, chainId: c, type: 'krypt.utility' });
  bad('rack.addDevice', { ...t, chainId: c, type: 'krypt.utility' }, new RegExp(`at most ${MAX_FX_SLOTS} devices`));
  const steps = Array.from({ length: MAX_RACK_CHAINS - 1 }, () => ({ cmd: 'rack.addChain', args: t }));
  assert.equal(doc.execBatch(steps, { actor: USER }).ok, true);
  bad('rack.addChain', t, new RegExp(`at most ${MAX_RACK_CHAINS} chains`));
  const fx = doc.project.mixer.inserts[byName('Clap').insertId];
  ok('rack.create', { insertId: fx.id, kind: 'effect' });
  const slotId = doc.project.mixer.inserts[fx.id].slotOrder.at(-1)!;
  bad('rack.addChain', { insertId: fx.id, slotId, instrument: { type: 'krypt.triosc' } }, /effect rack has no instruments/);
  bad('rack.addChain', { insertId: fx.id, slotId, zone: { keyLo: 0, keyHi: 1, velLo: 0, velHi: 1 } }, /no key zones/);
  bad('rack.addChain', { channelId: byName('Clap').id }, /doesn't hold a rack/);
  sound();
});

test('devices: add / set (clamped, mix, bypass) / move across chains (maps follow) / remove (maps go)', () => {
  const { doc, byName, ok, bad, sound } = host();
  const insId = byName('Clap').insertId;
  const { slotId } = ok<{ slotId: string }>('rack.create', { insertId: insId });
  const t = { insertId: insId, slotId };
  const a = ok<{ chainId: string }>('rack.addChain', { ...t, name: 'Dry' }).chainId;
  const b = ok<{ chainId: string }>('rack.addChain', { ...t, name: 'Verb', devices: [{ type: 'krypt.reverb', mix: 1 }] }).chainId;
  const d1 = ok<{ deviceId: string }>('rack.addDevice', { ...t, chainId: a, type: 'krypt.drive', params: { drive: 100 } }).deviceId;
  const slot = () => doc.project.mixer.inserts[insId].slots[slotId];
  assert.equal(slot().rack!.chains[a].devices[d1].params.drive, 48, 'clamped');
  ok('rack.setDeviceParams', { ...t, chainId: a, deviceId: d1, params: { tone: 5000 }, mix: 0.5, enabled: false });
  const dev = slot().rack!.chains[a].devices[d1];
  assert.deepEqual([dev.params.tone, dev.mix, dev.enabled], [5000, 0.5, false]);
  bad('rack.setDeviceParams', { ...t, chainId: a, deviceId: d1, params: { size: 1 } }, /no parameter "size"/);
  const { mapId } = ok<{ mapId: string }>('rack.mapMacro', { ...t, macro: 3, target: { chainId: a, kind: 'device', deviceId: d1, param: 'drive' }, min: 0.2, max: 0.8 });
  ok('rack.moveDevice', { ...t, chainId: a, deviceId: d1, toChainId: b, toIndex: 0 });
  assert.deepEqual(slot().rack!.chains[b].deviceOrder[0], d1);
  assert.equal(slot().rack!.macros[2].maps[mapId].target.chainId, b, 'the map follows its device');
  ok('rack.removeDevice', { ...t, chainId: b, deviceId: d1 });
  assert.deepEqual(slot().rack!.macros[2].maps, {});
  sound();
});

test('macros: map (validated, re-map updates range), unmap, rename; values through the ParamRef path', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Keys').id;
  const { chainId } = ok<{ chainId: string }>('rack.create', { channelId: ch });
  const t = { channelId: ch };
  bad('rack.mapMacro', { ...t, macro: 1, target: { chainId, kind: 'instrument', param: 'wobble' } }, /no parameter "wobble"/);
  bad('rack.mapMacro', { ...t, macro: 1, target: { chainId: 'chn_x', kind: 'chain', param: 'pan' } }, /isn't in this rack/);
  bad('rack.mapMacro', { ...t, macro: 9, target: { chainId, kind: 'chain', param: 'pan' } }, /macro/i);
  const m1 = ok<{ mapId: string }>('rack.mapMacro', { ...t, macro: 1, target: { chainId, kind: 'instrument', param: 'cutoff' }, min: 0.9, max: 0.2 });
  const m2 = ok<{ mapId: string; updated: boolean }>('rack.mapMacro', { ...t, macro: 1, target: { chainId, kind: 'instrument', param: 'cutoff' }, min: 0.1, max: 0.6 });
  assert.equal(m2.mapId, m1.mapId);
  assert.equal(m2.updated, true);
  assert.deepEqual([rackOf(doc, ch).macros[0].maps[m1.mapId].min, rackOf(doc, ch).macros[0].maps[m1.mapId].max], [0.1, 0.6]);
  ok('rack.renameMacro', { ...t, macro: 1, name: '  Brightness  ' });
  assert.equal(rackOf(doc, ch).macros[0].name, 'Brightness');
  ok('rack.renameMacro', { ...t, macro: 1, name: '' });
  assert.equal(rackOf(doc, ch).macros[0].name, 'Macro 1');
  // Macro values are the rack's own params: channel/<ch>/gen/macroN resolves like any instrument param.
  const ref = `channel/${ch}/gen/macro3`;
  assert.equal(paramSpecFor(doc.project, CATALOG, ref)?.group, 'Macros');
  ok('params.set', { ref, value: 0.7 });
  assert.equal(getParamValue(doc.project, CATALOG, ref), 0.7);
  ok('params.set', { ref, value: 5 });
  assert.equal(getParamValue(doc.project, CATALOG, ref), 1, 'clamped to 0..1');
  const insId = byName('Clap').insertId;
  const { slotId } = ok<{ slotId: string }>('rack.create', { insertId: insId });
  ok('params.set', { ref: `insert/${insId}/slot/${slotId}/macro2`, value: 0.25 });
  assert.equal(doc.project.mixer.inserts[insId].slots[slotId].params.macro2, 0.25);
  ok('automation.create', { target: `insert/${insId}/slot/${slotId}/macro2`, trackId: doc.project.playlist.trackOrder[0], start: 0 });
  ok('rack.unmapMacro', { ...t, macro: 1, mapId: m1.mapId });
  assert.deepEqual(rackOf(doc, ch).macros[0].maps, {});
  bad('rack.unmapMacro', { ...t, macro: 1 }, /mapId/);
  sound();
});

test('variations: store current / given values, recall, delete; randomize is seeded', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Keys').id;
  const { chainId } = ok<{ chainId: string }>('rack.create', { channelId: ch });
  const t = { channelId: ch };
  ok('params.set', { ref: `channel/${ch}/gen/macro1`, value: 0.3 });
  const v1 = ok<{ variationId: string; name: string }>('rack.storeVariation', t);
  assert.equal(v1.name, 'Variation 1');
  assert.deepEqual(rackOf(doc, ch).variations[v1.variationId].values, [0.3, 0, 0, 0, 0, 0, 0, 0]);
  const v2 = ok<{ variationId: string }>('rack.storeVariation', { ...t, name: 'Big', values: [1, 1, 1, 1, 0, 0, 0, 0.5] }).variationId;
  ok('rack.recallVariation', { ...t, variationId: v2 });
  const g = () => doc.project.channels[ch].generator.params;
  assert.deepEqual([g().macro1, g().macro4, g().macro8], [1, 1, 0.5]);
  ok('rack.recallVariation', { ...t, variationId: v1.variationId });
  assert.equal(g().macro1, 0.3);
  ok('rack.removeVariation', { ...t, variationId: v2 });
  assert.deepEqual(rackOf(doc, ch).variationOrder, [v1.variationId]);
  bad('rack.recallVariation', { ...t, variationId: v2 }, /isn't in this rack/);
  // Randomize: only the mapped macros by default, the same seed gives the same values.
  ok('rack.mapMacro', { ...t, macro: 2, target: { chainId, kind: 'chain', param: 'pan' } });
  const before = { ...g() };
  const r1 = ok<{ values: number[] }>('rack.randomizeMacros', { ...t, seed: 42 });
  assert.equal(g().macro1, before.macro1, 'unmapped macros are left alone');
  assert.notEqual(r1.values[1], 0);
  doc.undo(USER);
  const r2 = ok<{ values: number[] }>('rack.randomizeMacros', { ...t, seed: 42 });
  assert.deepEqual(r2.values, r1.values, 'deterministic');
  const r3 = ok<{ values: number[] }>('rack.randomizeMacros', { ...t, seed: 7, macros: [1, 2, 3, 4, 5, 6, 7, 8], amount: 0.5 });
  assert.ok(r3.values.every((v) => v >= 0 && v <= 1));
  const rnd = seededRandom(1);
  const xs = Array.from({ length: 100 }, rnd);
  assert.ok(xs.every((x) => x >= 0 && x < 1) && new Set(xs).size > 90);
  sound();
});

test('rack.drumPad creates a pad by note (sampler, sample, choke) and updates it; drum racks only', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Hat').id;
  ok('rack.create', { channelId: ch, kind: 'drum', wrap: false });
  const t = { channelId: ch };
  const a = ok<{ chainId: string; created: boolean }>('rack.drumPad', { ...t, note: 42, samplePath: 'factory:drums/hat-closed.wav', choke: 1 });
  assert.equal(a.created, true);
  const pad = rackOf(doc, ch).chains[a.chainId];
  assert.equal(pad.name, doc.project.samples[pad.instrument!.sampleId!].name, 'named after its sample');
  assert.deepEqual([pad.zone!.keyLo, pad.choke, pad.instrument!.type, pad.instrument!.params.keyTrack], [42, 1, 'krypt.sampler', 0]);
  const b = ok<{ chainId: string; created: boolean }>('rack.drumPad', { ...t, note: 42, samplePath: 'factory:drums/hat-open.wav', name: 'OH' });
  assert.equal(b.created, false);
  assert.equal(b.chainId, a.chainId);
  assert.equal(rackOf(doc, ch).chains[a.chainId].name, 'OH');
  ok('rack.drumPad', { ...t, note: 42, sampleId: null });
  assert.equal(rackOf(doc, ch).chains[a.chainId].instrument!.sampleId, null);
  const keys = byName('Keys').id;
  ok('rack.create', { channelId: keys });
  bad('rack.drumPad', { channelId: keys, note: 40 }, /pads are for drum racks/);
  sound();
});

test('slice helpers: cleanSlices, sliceTimes (onsets thinned by strength, grid, manual)', () => {
  assert.deepEqual(cleanSlices([0.5, 0, 0.505, 2, -1, NaN, 1.2], 1.5), [0, 0.5, 1.2]);
  assert.deepEqual(sliceTimes({ mode: 'grid', lengthSec: 2, bpm: 120, division: 1 }), [0, 0.5, 1, 1.5]);
  assert.deepEqual(sliceTimes({ mode: 'grid', lengthSec: 2, bpm: 120, division: 0.25, maxSlices: 3 }), [0, 0.125, 0.25]);
  const on = sliceTimes({ mode: 'onsets', lengthSec: 2, times: [0.1, 0.11, 0.5, 1, 1.5], strengths: [0.2, 0.9, 0.5, 0.1, 0.8], maxSlices: 3 });
  assert.deepEqual(on, [0, 0.11, 1.5], 'the start is kept, near hits merge to the stronger, the strongest win');
  assert.deepEqual(sliceTimes({ mode: 'manual', lengthSec: 1, times: [0.75, 0.25, 3] }), [0.25, 0.75]);
});

test('rack.sliceToPads: a new drum-rack channel, one pad per slice (start/end), a pattern replaying the loop', () => {
  const { doc, byName, ok, bad, sound } = host();
  const before = snap(doc.project);
  const r = ok<{ channelId: string; chainIds: string[]; patternId: string; hasEnd: boolean }>('rack.sliceToPads', { samplePath: 'C:/loops/break.wav', slices: [0, 0.5, 1, 1.5], lengthSec: 2, bpm: 120 });
  const ch = doc.project.channels[r.channelId];
  assert.equal(ch.name, 'break slices');
  assert.equal(ch.rootKey, 36, 'step-sequencer steps play the first slice');
  assert.equal(ch.generator.type, 'krypt.drumrack');
  assert.ok(doc.project.mixer.inserts[ch.insertId], 'its own insert');
  const pads = chains(ch.generator.rack!);
  assert.equal(pads.length, 4);
  assert.equal(r.hasEnd, true);
  assert.deepEqual(
    pads.map((p) => [p.zone!.keyLo, p.instrument!.params.start, p.instrument!.params.end]),
    [
      [36, 0, 0.25],
      [37, 0.25, 0.5],
      [38, 0.5, 0.75],
      [39, 0.75, 1],
    ],
  );
  assert.ok(pads.every((p) => p.instrument!.sampleId === pads[0].instrument!.sampleId && p.instrument!.params.keyTrack === 0));
  const pat = doc.project.patterns[r.patternId];
  assert.equal(pat.length, 3840, '2 s at 120 bpm = 4 beats');
  const notes = Object.values(pat.notes[r.channelId]).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(
    notes.map((n) => [n.tick, n.key, n.dur]),
    [
      [0, 36, 960],
      [960, 37, 960],
      [1920, 38, 960],
      [2880, 39, 960],
    ],
  );
  sound();
  doc.undo(USER);
  assert.equal(snap(doc.project), before, 'one undo removes channel, insert, sample and pattern');
  // Onto an existing channel, without a pattern, every pad choking the others.
  const keys = byName('Keys').id;
  const smp = ok<{ id: string }>('samples.add', { path: 'C:/loops/vox.wav' }).id;
  const r2 = ok<{ channelId: string; patternId?: string }>('rack.sliceToPads', { channelId: keys, sampleId: smp, slices: [0.2, 0.6], lengthSec: 1, pattern: false, choke: 1 });
  assert.equal(r2.channelId, keys);
  assert.equal(r2.patternId, undefined);
  assert.ok(chains(rackOf(doc, keys)).every((p) => p.choke === 1));
  bad('rack.sliceToPads', { sampleId: smp, slices: [5], lengthSec: 1 }, /falls inside the sample/);
  bad('rack.sliceToPads', { slices: [0], lengthSec: 1 }, /Give the sample/);
  bad('rack.sliceToPads', { sampleId: smp, slices: [0, 0.1, 0.2], lengthSec: 1, baseNote: 126 }, /top MIDI note/);
  bad('samples.remove', { id: smp }, /inside the rack/);
  sound();
});

test('slicing an audio-clip channel puts the drum rack on a new channel (its clips keep playing)', () => {
  const { doc, ok, sound } = host();
  const clip = ok<{ channelId: string; sampleId: string }>('playlist.addAudio', { path: 'C:/loops/loop.wav', trackId: doc.project.playlist.trackOrder[0], start: 0 });
  const audioCh = clip.channelId;
  const smp = clip.sampleId;
  const r = ok<{ channelId: string }>('rack.sliceToPads', { channelId: audioCh, sampleId: smp, slices: [0, 1], lengthSec: 2 });
  assert.notEqual(r.channelId, audioCh);
  assert.equal(doc.project.channels[audioCh].generator.type, 'krypt.audioclip');
  sound();
});

test('rack.build: a whole rack from a spec (indices → ids, samples pooled), macro values; errors name the problem', () => {
  const { doc, byName, ok, bad, sound } = host();
  const ch = byName('Keys').id;
  const spec = {
    kind: 'instrument',
    chains: [
      { name: 'Low', zone: { keyLo: 0, keyHi: 59, velLo: 0, velHi: 1 }, instrument: { plugin: 'krypt.triosc', params: { cutoff: 2000 } }, fx: [{ type: 'krypt.chorus', params: {} }] },
      { name: 'High', zone: { keyLo: 60, keyHi: 127, velLo: 0, velHi: 1 }, instrument: { plugin: 'krypt.sampler', params: {}, sample: 'factory:drums/perc.wav' } },
    ],
    macros: [{ name: 'Tone', maps: [{ chain: 0, target: 'instrument', param: 'cutoff' }, { chain: 0, target: 'device', device: 0, param: 'mix', max: 0.5 }] }, { name: 'High', maps: [{ chain: 1, target: 'chain', param: 'volume' }] }],
    variations: [{ name: 'A', values: [0.5, 0.5, 0, 0, 0, 0, 0, 0] }],
  };
  const r = ok<{ chainIds: string[] }>('rack.build', { channelId: ch, spec, macros: [0.5, 0.25] });
  const g = doc.project.channels[ch].generator;
  assert.equal(g.type, 'krypt.rack');
  assert.deepEqual([g.params.macro1, g.params.macro2], [0.5, 0.25]);
  const rack = g.rack!;
  assert.deepEqual(rack.chainOrder, r.chainIds);
  assert.equal(rack.macros[0].name, 'Tone');
  const maps = Object.values(rack.macros[0].maps);
  assert.equal(maps.length, 2);
  const dm = maps.find((m) => m.target.kind === 'device')!;
  assert.equal(dm.target.kind === 'device' && rack.chains[r.chainIds[0]].devices[dm.target.deviceId].type, 'krypt.chorus');
  assert.equal(dm.max, 0.5);
  assert.ok(doc.project.samples[rack.chains[r.chainIds[1]].instrument!.sampleId!]);
  // Round trip: the captured spec builds the same structure.
  assert.deepEqual(rackToSpec(doc.project, CATALOG, rack), spec);
  bad('rack.build', { channelId: ch, spec: { ...spec, macros: [{ maps: [{ chain: 5, target: 'chain', param: 'pan' }] }] } }, /chain 6/);
  bad('rack.build', { channelId: ch, spec: { ...spec, chains: [{ name: 'x', fx: [{ type: FX_RACK_PLUGIN, params: {} }] }] } }, /Racks inside racks|racks inside racks/);
  bad('rack.build', { channelId: ch, spec: { kind: 'effect', chains: [] } }, /mixer slot/);
  const insId = byName('Clap').insertId;
  const fx = ok<{ slotId: string }>('rack.build', { insertId: insId, spec: { kind: 'effect', chains: [{ name: 'A', fx: [{ type: 'krypt.reverb', params: { size: 0.3 } }] }] } });
  assert.equal(doc.project.mixer.inserts[insId].slots[fx.slotId].type, FX_RACK_PLUGIN);
  sound();
});

test('presets: a rack channel saves and loads back (chains, inner samples as paths, macros, variations)', () => {
  const { doc, byName, ok, sound } = host();
  const kick = byName('Kick');
  ok('rack.create', { channelId: kick.id, kind: 'drum' });
  ok('rack.drumPad', { channelId: kick.id, note: 38, samplePath: 'factory:drums/snare.wav', choke: 2 });
  const [padA] = rackOf(doc, kick.id).chainOrder;
  ok('rack.addDevice', { channelId: kick.id, chainId: padA, type: 'krypt.drive', params: { drive: 12 } });
  ok('rack.mapMacro', { channelId: kick.id, macro: 4, target: { chainId: padA, kind: 'instrument', param: 'cutoff' }, min: 0.3 });
  ok('rack.renameMacro', { channelId: kick.id, macro: 4, name: 'Kick Tone' });
  ok('rack.storeVariation', { channelId: kick.id, name: 'Dark', values: [0, 0, 0, 0.2, 0, 0, 0, 0] });
  ok('params.set', { ref: `channel/${kick.id}/gen/macro4`, value: 0.6 });
  const preset = presetFromChannel(doc.project, CATALOG, kick.id, { name: 'My Kit', role: 'perc' });
  assert.equal(zPreset.safeParse(preset).success, true, JSON.stringify(zPreset.safeParse(preset).error?.issues));
  assert.equal(preset.plugin, 'krypt.drumrack');
  assert.deepEqual(preset.params, { macro4: 0.6 });
  assert.equal(preset.rack!.chains.length, 2);
  assert.equal(preset.rack!.chains[1].instrument!.sample, 'factory:drums/snare.wav', 'inner samples travel as paths');
  assert.equal(preset.rack!.macros![3].name, 'Kick Tone');
  // Load it onto another channel: the same rack.
  const keys = byName('Keys');
  ok('presets.applyToChannel', { channelId: keys.id, preset: JSON.parse(JSON.stringify(preset)), withFx: false });
  const loaded = doc.project.channels[keys.id].generator;
  assert.equal(loaded.type, 'krypt.drumrack');
  assert.equal(loaded.params.macro4, 0.6);
  assert.deepEqual(rackToSpec(doc.project, CATALOG, loaded.rack!), preset.rack);
  assert.deepEqual(loaded.preset, { id: preset.id, name: 'My Kit' });
  sound();
  // A plain preset replaces the rack; mismatched rack data is refused.
  const bad = { ...preset, rack: { ...preset.rack!, kind: 'instrument' as const } };
  const r = doc.exec('presets.applyToChannel', { channelId: keys.id, preset: bad }, { actor: USER });
  assert.equal(r.ok, false);
  assert.match(r.message!, /instrument rack inside/);
});

test('presets: an effect rack in an insert chain saves (chainFromInsert) and loads back (applyChain)', () => {
  const { doc, byName, ok, sound } = host();
  const insId = byName('Snare').insertId;
  ok('mixer.addSlot', { insertId: insId, type: 'krypt.eq' });
  const { slotId } = ok<{ slotId: string }>('rack.create', { insertId: insId });
  const a = ok<{ chainId: string }>('rack.addChain', { insertId: insId, slotId, name: 'Crush', devices: [{ type: 'krypt.drive', params: { mode: 4 } }] }).chainId;
  ok('rack.addChain', { insertId: insId, slotId, name: 'Room', volume: 0.4, devices: [{ type: 'krypt.reverb', mix: 1 }] });
  ok('rack.mapMacro', { insertId: insId, slotId, macro: 1, target: { chainId: a, kind: 'chain', param: 'volume' } });
  const chain = chainFromInsert(doc.project, CATALOG, insId, { name: 'Crush Bus', role: 'character' });
  assert.equal(zPreset.safeParse(chain).success, true);
  assert.equal(chain.fx[1].type, FX_RACK_PLUGIN);
  assert.equal(chain.fx[1].rack!.chains.length, 2);
  const other = byName('Clap').insertId;
  ok('presets.applyChain', { insertId: other, preset: JSON.parse(JSON.stringify(chain)) });
  const ins = doc.project.mixer.inserts[other];
  const rackSlot = ins.slots[ins.slotOrder[1]];
  assert.equal(rackSlot.type, FX_RACK_PLUGIN);
  assert.deepEqual(rackToSpec(doc.project, CATALOG, rackSlot.rack!), chain.fx[1].rack);
  ok('presets.applyChain', { insertId: other, preset: JSON.parse(JSON.stringify(chain)), mode: 'append' });
  assert.equal(doc.project.mixer.inserts[other].slotOrder.length, 4);
  sound();
  const wrong = { ...chain, fx: [{ type: 'krypt.eq', params: {}, rack: chain.fx[1].rack }] };
  const r = doc.exec('presets.applyChain', { insertId: other, preset: wrong }, { actor: USER });
  assert.equal(r.ok, false);
  assert.match(r.message!, /only an effect rack/);
});

test('factory rack presets: ≥ 4, valid, stock-only, params on-spec, they load and build what they promise', () => {
  const all: Array<InstrumentPreset | ChainPreset> = [...RACK_INSTRUMENT_PRESETS, ...RACK_CHAIN_PRESETS];
  assert.ok(all.length >= 4);
  for (const p of all) {
    assert.ok(FACTORY_PRESETS.includes(p), `${p.id} is listed in FACTORY_PRESETS`);
    assert.ok(isRackPreset(p), p.id);
    const z = zPreset.safeParse(p);
    assert.ok(z.success, `${p.id}: ${z.success ? '' : z.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const racks = p.kind === 'instrument' ? [p.rack!] : p.fx.map((f) => f.rack!).filter(Boolean);
    for (const rack of racks) {
      for (const c of rack.chains) {
        const check = (type: string, params: Record<string, number>) => {
          const desc: PluginDescriptor | undefined = CATALOG.plugins.find((d) => d.id === type);
          assert.ok(desc, `${p.id}: unknown ${type}`);
          for (const [k, v] of Object.entries(params)) {
            const ps: ParamSpec | undefined = desc.params.find((x) => x.id === k);
            assert.ok(ps, `${p.id} ${c.name}: ${type} has no ${k}`);
            assert.equal(clampToSpec(ps, v), v, `${p.id} ${c.name}: ${type}.${k} = ${v} is off-spec`);
          }
        };
        if (c.instrument) check(c.instrument.plugin, c.instrument.params);
        for (const f of c.fx ?? []) check(f.type, f.params);
        if (c.instrument?.sample) assert.ok((LEGACY_FACTORY_PATHS as readonly string[]).includes(c.instrument.sample), `${p.id}: ${c.instrument.sample} isn't a factory sample every install has`);
      }
    }
  }
  const named = (id: string) => all.find((p) => p.id === id)!;
  const { doc, byName, ok, sound } = host();
  // Layered keys: velocity + key zones, macros named.
  const keys = byName('Keys').id;
  ok('presets.applyToChannel', { channelId: keys, preset: named('factory:keys/layered-keys-rack') });
  const kr = rackOf(doc, keys);
  assert.ok(chains(kr).some((c) => c.zone && c.zone.velLo > 0), 'a velocity zone');
  assert.ok(chains(kr).some((c) => c.zone && c.zone.keyLo > 0), 'a key zone');
  assert.ok(kr.macros.filter((m) => Object.keys(m.maps).length).length >= 4);
  // Drum kit: factory samples on pads, the hats choke each other.
  const r = ok<{ channelId: string }>('presets.addChannel', { preset: named('factory:perc/drum-kit-rack') });
  const kit = rackOf(doc, r.channelId);
  const hats = chains(kit).filter((c) => /hat/i.test(c.name));
  assert.equal(hats.length, 2);
  assert.ok(hats.every((h) => h.choke === 1));
  assert.equal(doc.project.channels[r.channelId].rootKey, 36, 'steps play the kick pad');
  assert.ok(chains(kit).every((c) => c.instrument?.sampleId && doc.project.samples[c.instrument.sampleId].path.startsWith('factory:')));
  // Lo-fi: the four macros.
  const insId = byName('Clap').insertId;
  ok('presets.applyChain', { insertId: insId, preset: named('factory:chain/character/lofi-rack') });
  const lofi = doc.project.mixer.inserts[insId].slots[doc.project.mixer.inserts[insId].slotOrder[0]];
  assert.deepEqual(lofi.rack!.macros.slice(0, 4).map((m) => m.name), ['Age', 'Wobble', 'Crush', 'Space']);
  assert.equal(lofi.params.macro1, 0.5);
  ok('presets.applyChain', { insertId: byName('Snare').insertId, preset: named('factory:chain/vocal/vocal-rack') });
  sound();
  // Plain role picks prefer plain presets; asking for a rack finds one.
  assert.ok(!isRackPreset(pickPreset(FACTORY_PRESETS, 'keys')!), 'a role-only pick is not a rack');
  assert.ok(pickPreset(FACTORY_PRESETS.filter((p) => p.kind === 'instrument'), 'keys', null, undefined) !== null);
});

run('racks');
