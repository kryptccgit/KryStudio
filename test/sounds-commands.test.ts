import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { zPreset } from '@shared/sounds/schema';
import { chainFromInsert, guessChainRole, presetFromChannel, presetSlug, sparseParams } from '@shared/sounds/capture';
import type { InstrumentPreset } from '@shared/sounds/types';
import { DRUM_BUS, EIGHT08, LEAD_EDM, MASTER_EDM, PAD, REVERB_SEND, SAMPLER_808 } from './sounds-fixtures';

function host() {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  const byName = (n: string) => Object.values(doc.project.channels).find((c) => c.name === n)!;
  const exec = <T = any>(cmd: string, args: unknown) => doc.exec<T>(cmd, args, { actor: USER });
  return { doc, byName, exec };
}

const slotTypes = (doc: DocHost, insertId: string) => doc.project.mixer.inserts[insertId].slotOrder.map((s) => doc.project.mixer.inserts[insertId].slots[s].type);

test('applyToChannel replaces instrument, params and the own insert chain; one undo step', () => {
  const { doc, byName, exec } = host();
  const keys = byName('Keys');
  const insId = keys.insertId;
  exec('mixer.addSlot', { insertId: insId, type: 'krypt.eq' });
  const r = exec<{ channelId: string; insertId: string; splitFrom?: string }>('presets.applyToChannel', { channelId: keys.id, preset: LEAD_EDM });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.channelId, keys.id, 'returns { channelId, insertId } (the UI reads them)');
  assert.equal(r.data!.insertId, insId, 'an own insert is reused');
  assert.equal(r.data!.splitFrom, undefined);
  const ch = doc.project.channels[keys.id];
  assert.equal(ch.generator.type, 'krypt.wavetable');
  assert.deepEqual(ch.generator.params, { unison: 7, detune: 0.45, cutoff: 12000 });
  assert.deepEqual(ch.generator.preset, { id: LEAD_EDM.id, name: 'Anthem Supersaw' });
  assert.equal(ch.generator.sampleId, null);
  assert.deepEqual(slotTypes(doc, insId), ['krypt.chorus', 'krypt.reverb'], 'the EQ was replaced by the preset chain');
  const ins = doc.project.mixer.inserts[insId];
  const [chorus, reverb] = ins.slotOrder.map((s) => ins.slots[s]);
  assert.equal(chorus.mix, 1, 'default mix from the catalog');
  assert.equal(reverb.mix, 0.2);
  assert.equal(reverb.params.size, 0.8);
  assert.deepEqual(checkIntegrity(doc.project), []);
  const hist = doc.getHistory();
  assert.equal(hist[hist.length - 1].label, 'Load preset Anthem Supersaw');
  assert.equal(doc.undo(USER).ok, true);
  const back = doc.project.channels[keys.id];
  assert.equal(back.generator.type, 'krypt.triosc');
  assert.equal(back.generator.preset, undefined);
  assert.deepEqual(slotTypes(doc, insId), ['krypt.eq'], 'one undo restores the old chain too');
});

test('params are sanitised: clamped, unknown param / effect / instrument = an error naming it, nothing written', () => {
  const { doc, byName, exec } = host();
  const keys = byName('Keys');
  const loud: InstrumentPreset = { ...LEAD_EDM, id: 'user:loud', params: { cutoff: 99999 } };
  assert.equal(exec('presets.applyToChannel', { channelId: keys.id, preset: loud }).ok, true);
  assert.equal(doc.project.channels[keys.id].generator.params.cutoff, 20000);
  const v = doc.version;
  const bad = exec('presets.applyToChannel', { channelId: keys.id, preset: { ...LEAD_EDM, params: { nope: 1 } } });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /Anthem Supersaw.*nope/);
  const badFx = exec('presets.applyToChannel', { channelId: keys.id, preset: { ...LEAD_EDM, fx: [{ type: 'krypt.shimmer', params: {} }] } });
  assert.equal(badFx.ok, false);
  assert.match(badFx.message!, /krypt\.shimmer/);
  const badFxParam = exec('presets.applyChain', { insertId: 'master', preset: { ...MASTER_EDM, fx: [{ type: 'krypt.limiter', params: { thrust: 1 } }] } });
  assert.equal(badFxParam.ok, false);
  assert.match(badFxParam.message!, /thrust/);
  const badInst = exec('presets.addChannel', { preset: { ...LEAD_EDM, plugin: 'krypt.nothing' } });
  assert.equal(badInst.ok, false);
  assert.match(badInst.message!, /krypt\.nothing/);
  const fxAsInst = exec('presets.addChannel', { preset: { ...LEAD_EDM, plugin: 'krypt.reverb' } });
  assert.equal(fxAsInst.ok, false);
  assert.match(fxAsInst.message!, /effect, not an instrument/);
  const sampleOnSynth = exec('presets.addChannel', { preset: { ...LEAD_EDM, sample: 'factory:x.wav' } });
  assert.equal(sampleOnSynth.ok, false);
  assert.equal(doc.version, v, 'failed loads change nothing');
});

test('a channel on a shared insert gets its own insert, which keeps feeding the old bus; master → own insert to master', () => {
  const { doc, byName, exec } = host();
  const kick = byName('Kick');
  const clap = byName('Clap');
  assert.equal(exec('channels.set', { id: clap.id, insertId: kick.insertId }).ok, true);
  exec('mixer.addSlot', { insertId: kick.insertId, type: 'krypt.comp' });
  const r = exec<{ insertId: string; splitFrom?: string }>('presets.applyToChannel', { channelId: clap.id, preset: { ...PAD, id: 'user:clap-verb', name: 'Clap Verb' } });
  assert.equal(r.ok, true, r.message);
  const own = r.data!.insertId;
  assert.notEqual(own, kick.insertId);
  assert.equal(r.data!.splitFrom, kick.insertId);
  const ins = doc.project.mixer.inserts[own];
  assert.equal(ins.name, 'Clap');
  assert.deepEqual(ins.routes, { [kick.insertId]: 1 }, 'the new insert feeds the bus the channel used to feed');
  assert.deepEqual(slotTypes(doc, own), ['krypt.reverb']);
  assert.deepEqual(slotTypes(doc, kick.insertId), ['krypt.comp'], 'the shared insert keeps its chain');
  assert.equal(doc.project.channels[clap.id].insertId, own);

  const snare = byName('Snare');
  exec('channels.set', { id: snare.id, insertId: doc.project.mixer.masterId });
  const m = exec<{ insertId: string; splitFrom?: string }>('presets.applyToChannel', { channelId: snare.id, preset: PAD });
  assert.equal(m.ok, true);
  assert.deepEqual(doc.project.mixer.inserts[m.data!.insertId].routes, { [doc.project.mixer.masterId]: 1 });
  assert.deepEqual(slotTypes(doc, doc.project.mixer.masterId), ['krypt.limiter'], 'the master chain is never replaced by an instrument preset');
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('withFx false leaves the chain; a shared insert with an fx-less preset is not split; rename; audio clips refused', () => {
  const { doc, byName, exec } = host();
  const keys = byName('Keys');
  exec('mixer.addSlot', { insertId: keys.insertId, type: 'krypt.eq' });
  assert.equal(exec('presets.applyToChannel', { channelId: keys.id, preset: LEAD_EDM, withFx: false, rename: true }).ok, true);
  assert.deepEqual(slotTypes(doc, keys.insertId), ['krypt.eq']);
  assert.equal(doc.project.channels[keys.id].name, 'Anthem Supersaw');
  const hat = byName('Hat');
  exec('channels.set', { id: hat.id, insertId: doc.project.mixer.masterId });
  const before = doc.project.mixer.insertOrder.length;
  const noFx: InstrumentPreset = { ...LEAD_EDM, fx: [] };
  assert.equal(exec('presets.applyToChannel', { channelId: hat.id, preset: noFx }).ok, true);
  assert.equal(doc.project.mixer.insertOrder.length, before, 'no empty insert is created');
  assert.equal(doc.project.channels[hat.id].insertId, doc.project.mixer.masterId);
});

test('sample presets reuse an existing SampleRef with the same path, else add one (once)', () => {
  const { doc, byName, exec } = host();
  const kick = byName('Kick');
  const kickSample = kick.generator.sampleId!;
  const kickPath = doc.project.samples[kickSample].path;
  const samples0 = Object.keys(doc.project.samples).length;
  const reuse: InstrumentPreset = { ...SAMPLER_808, id: 'user:kick-again', name: 'Kick Again', sample: kickPath, channel: undefined };
  assert.equal(exec('presets.applyToChannel', { channelId: byName('Keys').id, preset: reuse }).ok, true);
  assert.equal(doc.project.channels[byName('Keys').id].generator.sampleId, kickSample);
  assert.equal(Object.keys(doc.project.samples).length, samples0);
  const a = exec<{ channelId: string }>('presets.addChannel', { preset: SAMPLER_808 });
  const b = exec<{ channelId: string }>('presets.addChannel', { preset: SAMPLER_808, name: 'Sub 2' });
  assert.equal(Object.keys(doc.project.samples).length, samples0 + 1);
  const sa = doc.project.channels[a.data!.channelId].generator.sampleId;
  assert.equal(sa, doc.project.channels[b.data!.channelId].generator.sampleId);
  assert.equal(doc.project.samples[sa!].path, 'factory:808/sub-boom.wav');
  assert.equal(doc.project.channels[a.data!.channelId].rootKey, 36);
  const env: InstrumentPreset = { ...SAMPLER_808, id: 'user:env', name: 'Env', sample: undefined, channel: undefined };
  assert.equal(exec('presets.applyToChannel', { channelId: kick.id, preset: env }).ok, true);
  assert.equal(doc.project.channels[kick.id].generator.sampleId, kickSample);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('channel settings: volumeDb, mono/glide from the preset, else the plugin defaults; rootKey kept', () => {
  const { doc, byName, exec } = host();
  const keys = byName('Keys');
  exec('channels.set', { id: keys.id, rootKey: 48, pan: 0.3 });
  assert.equal(exec('presets.applyToChannel', { channelId: keys.id, preset: EIGHT08 }).ok, true);
  let ch = doc.project.channels[keys.id];
  assert.equal(ch.poly.mono, true);
  assert.equal(ch.poly.glideMs, 80);
  assert.ok(Math.abs(ch.volume - 0.7079) < 0.001);
  assert.equal(ch.rootKey, 48, 'root key stays with the notes already written');
  assert.equal(ch.pan, 0.3);
  assert.equal(exec('presets.applyToChannel', { channelId: keys.id, preset: PAD }).ok, true);
  ch = doc.project.channels[keys.id];
  assert.equal(ch.poly.mono, false, 'a pad after an 808 plays chords again');
  assert.equal(ch.poly.glideMs, 0);
  assert.ok(Math.abs(ch.volume - 0.7079) < 0.001, 'volume kept when the preset has none');
});

test('addChannel: own insert named after the channel, at an index, with the chain; a full mixer is a clear error', () => {
  const { doc, exec } = host();
  const r = exec<{ channelId: string; insertId: string; slotIds: string[] }>('presets.addChannel', { preset: LEAD_EDM, name: 'Drop Lead', index: 0 });
  assert.equal(r.ok, true, r.message);
  const { channelId, insertId } = r.data!;
  assert.ok(doc.project.channels[channelId] && doc.project.mixer.inserts[insertId], 'returns { channelId, insertId }');
  assert.equal(doc.project.channelOrder[0], channelId);
  const ch = doc.project.channels[channelId];
  assert.equal(ch.name, 'Drop Lead');
  assert.equal(ch.insertId, insertId);
  assert.equal(doc.project.mixer.inserts[insertId].name, 'Drop Lead');
  assert.equal(r.data!.slotIds.length, 2);
  const e = exec<{ channelId: string }>('presets.addChannel', { preset: EIGHT08 });
  const c808 = doc.project.channels[e.data!.channelId];
  assert.equal(c808.name, 'Street 808');
  assert.equal(c808.rootKey, 36);
  assert.equal(doc.project.channelOrder[doc.project.channelOrder.length - 1], c808.id);
  assert.equal(doc.getHistory().filter((h) => h.label.startsWith('Add ')).length, 2);
  for (let i = doc.project.mixer.insertOrder.length; i < 128; i++) exec('mixer.addInsert', {});
  const v = doc.version;
  const full = exec('presets.addChannel', { preset: PAD });
  assert.equal(full.ok, false);
  assert.match(full.message!, /mixer is full/);
  assert.equal(doc.version, v);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('applyChain: replace / append, master alias, insert settings, slot limit, automations of removed slots unassigned', () => {
  const { doc, exec } = host();
  const masterId = doc.project.mixer.masterId;
  const limiter = doc.project.mixer.inserts[masterId].slotOrder[0];
  const autId = exec<{ automationId: string }>('automation.create', { name: 'Ceiling', target: `insert/${masterId}/slot/${limiter}/ceiling` }).data!.automationId;
  assert.ok(doc.project.automations[autId]?.target);
  const r = exec<{ insertId: string; slotIds: string[] }>('presets.applyChain', { insertId: 'master', preset: MASTER_EDM });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.insertId, masterId);
  assert.deepEqual(slotTypes(doc, masterId), ['krypt.eq', 'krypt.comp', 'krypt.clipper', 'krypt.limiter']);
  assert.equal(doc.project.automations[autId].target, null, 'the automation lost its (deleted) slot');
  const send = exec<{ id: string }>('mixer.addInsert', { name: 'Verb' }).data!.id;
  assert.equal(exec('presets.applyChain', { insertId: send, preset: REVERB_SEND }).ok, true);
  assert.ok(Math.abs(doc.project.mixer.inserts[send].volume - 0.501) < 0.001, 'insert volumeDb applied');
  assert.equal(exec('presets.applyChain', { insertId: send, preset: DRUM_BUS, mode: 'append' }).ok, true);
  assert.deepEqual(slotTypes(doc, send), ['krypt.reverb', 'krypt.comp', 'krypt.clipper']);
  for (let i = 0; i < 3; i++) exec('presets.applyChain', { insertId: send, preset: DRUM_BUS, mode: 'append' });
  const over = exec('presets.applyChain', { insertId: send, preset: DRUM_BUS, mode: 'append' });
  assert.equal(over.ok, false);
  assert.match(over.message!, /10-effect limit/);
  assert.equal(exec('presets.applyChain', { insertId: 'ins_nope', preset: DRUM_BUS }).ok, false);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('capture: presetFromChannel is sparse, valid and round-trips through presets.addChannel', () => {
  const { doc, byName, exec } = host();
  const keys = byName('Keys');
  exec('presets.applyToChannel', { channelId: keys.id, preset: LEAD_EDM });
  exec('channels.setGenParams', { id: keys.id, params: { cutoff: 9000, gain: -3 } });
  exec('channels.set', { id: keys.id, volume: 0.5, poly: { mono: true, glideMs: 30 } });
  const p = presetFromChannel(doc.project, CATALOG, keys.id, { name: 'My Lead!', tags: ['Bright', ' wide ', 'bright'], genres: ['edm'] });
  assert.equal(zPreset.safeParse(p).success, true, JSON.stringify(zPreset.safeParse(p).error?.issues));
  assert.equal(p.id, 'user:my-lead');
  assert.equal(p.role, 'lead', 'the loaded preset says lead (the channel is still called "Keys")');
  assert.deepEqual(p.params, { unison: 7, detune: 0.45, gain: -3 }, 'defaults are left out');
  assert.deepEqual(p.tags, ['bright', 'wide']);
  assert.equal(p.channel?.mono, true);
  assert.equal(p.channel?.glideMs, 30);
  assert.ok(Math.abs(p.channel!.volumeDb! - -6) < 0.1);
  assert.deepEqual(p.fx?.map((f) => f.type), ['krypt.chorus', 'krypt.reverb']);
  assert.deepEqual(p.fx?.[1], { type: 'krypt.reverb', params: { size: 0.8 }, mix: 0.2 });
  const r = exec<{ channelId: string; insertId: string }>('presets.addChannel', { preset: p });
  assert.equal(r.ok, true, r.message);
  const copy = doc.project.channels[r.data!.channelId];
  const orig = doc.project.channels[keys.id];
  assert.deepEqual(sparseParams(CATALOG, copy.generator.type, copy.generator.params), sparseParams(CATALOG, orig.generator.type, orig.generator.params));
  assert.deepEqual(slotTypes(doc, r.data!.insertId), slotTypes(doc, keys.insertId));
  assert.equal(copy.poly.mono, true);
  assert.ok(Math.abs(copy.volume - 0.5) < 0.01);
});

test('capture: shared-insert chains stay out; samplers keep sample + root key; chains from inserts; audio clips refused', () => {
  const { doc, byName, exec } = host();
  const kick = byName('Kick');
  const clap = byName('Clap');
  exec('channels.set', { id: clap.id, insertId: kick.insertId });
  exec('mixer.addSlot', { insertId: kick.insertId, type: 'krypt.comp', params: { ratio: 6 } });
  const p = presetFromChannel(doc.project, CATALOG, kick.id, { name: 'Kick' });
  assert.equal(p.fx, undefined, 'a shared insert is not part of the sound');
  assert.equal(p.sample, 'factory:drums/kick.wav');
  assert.equal(p.channel?.rootKey, 60);
  assert.equal(p.role, 'kick');
  const c = chainFromInsert(doc.project, CATALOG, kick.insertId, { name: 'Drum glue' });
  assert.equal(c.id, 'user:chain/drum-glue');
  assert.equal(c.role, 'drumBus', 'two drum channels feed it');
  assert.deepEqual(c.fx, [{ type: 'krypt.comp', params: { ratio: 6 } }]);
  assert.equal(zPreset.safeParse(c).success, true);
  const m = chainFromInsert(doc.project, CATALOG, 'master', { name: 'Master' });
  assert.equal(m.role, 'master');
  assert.equal(m.insert, undefined, "the master fader isn't saved");
  assert.equal(guessChainRole(doc.project, byName('808').insertId), 'bass');
  assert.throws(() => chainFromInsert(doc.project, CATALOG, byName('Keys').insertId, { name: 'Empty' }), /no effects/);
  const audio = exec<{ channelId: string }>('playlist.addAudio', { path: 'C:/x/vocal.wav', trackId: doc.project.playlist.trackOrder[0], start: 0 });
  assert.equal(audio.ok, true, audio.message);
  assert.throws(() => presetFromChannel(doc.project, CATALOG, audio.data!.channelId, { name: 'Vox' }), /audio clip/);
  const refused = exec('presets.applyToChannel', { channelId: audio.data!.channelId, preset: PAD });
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /audio clip/);
  assert.equal(presetSlug('  Dark Pluck #2!  '), 'dark-pluck-2');
  assert.equal(presetSlug('***'), 'preset');
});

test('markChannel labels (or clears) the preset a channel plays, without an undo step', () => {
  const { doc, byName, exec } = host();
  const keys = byName('Keys');
  const h = doc.getHistory().length;
  const params = { ...doc.project.channels[keys.id].generator.params };
  assert.equal(exec('presets.markChannel', { channelId: keys.id, preset: { id: 'user:mine', name: 'Mine' } }).ok, true);
  assert.deepEqual(doc.project.channels[keys.id].generator.preset, { id: 'user:mine', name: 'Mine' });
  assert.deepEqual(doc.project.channels[keys.id].generator.params, params, 'the sound is unchanged');
  assert.equal(doc.getHistory().length, h);
  assert.equal(exec('presets.markChannel', { channelId: keys.id, preset: null }).ok, true);
  assert.equal(doc.project.channels[keys.id].generator.preset, undefined);
  const bad = exec('presets.markChannel', { channelId: 'ch_nope', preset: null });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /not found/);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

run('sounds commands');
