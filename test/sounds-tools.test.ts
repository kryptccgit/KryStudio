// The preset MCP tools (find_presets, load_preset, save_preset, apply_chain), default sounds for channels created
// by name (chooseInstrument via write_pattern / add_channel) and find_samples with the factory index, through
// callTool against a real DocHost + SoundsService over temp folders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import type { Preset } from '@shared/sounds/types';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, getTool, type ToolCaller } from '../electron/mcp/tools';
import { chooseInstrument, SYNTH_PRESETS } from '../electron/mcp/tools/instruments';
import { classifyUserSample } from '../electron/mcp/tools/discovery';
import { SoundsService } from '../electron/sounds/service';
import { DARK_PLUCK, EIGHT08, FIXTURE_PRESETS, KEYS, LEAD_EDM, LEAD_TRAP, MASTER_EDM, MASTER_LOFI, PAD, PLUCK, REVERB_SEND, SAMPLER_808, writeFactory } from './sounds-fixtures';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-sounds-tools-'));
let n = 0;

const SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
};

interface RigOpts {
  /** 'service' (default): a SoundsService with fixtures; 'empty': a service with no factory presets; 'none': no deps.sounds. */
  sounds?: 'service' | 'empty' | 'none';
  /** Write the factory index (default true). */
  index?: boolean;
  genre?: string;
  presets?: readonly Preset[];
}

function rig(opts: RigOpts = {}) {
  const dir = path.join(TMP, `case-${++n}`);
  const factory = path.join(dir, 'factory');
  const userRoot = path.join(dir, 'user-samples');
  fs.mkdirSync(factory, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });
  writeFactory(factory, { index: opts.index !== false });
  const project = createDefaultProject('Test');
  if (opts.genre) project.meta.genre = opts.genre;
  const doc = new DocHost(project, CATALOG, { strict: true });
  let settings: Settings = structuredClone(SETTINGS);
  const logs: string[] = [];
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
      async sampleInfo(p) {
        return { ok: true, data: { path: p, frames: 48000, sampleRate: 48000, channels: 2, durationSec: 1 } };
      },
      async restart() {
        return { ok: true };
      },
    },
    project: {
      status: () => ({ path: null, name: 'Test', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => (p.startsWith('factory:') ? path.join(factory, p.slice('factory:'.length)) : p),
      renderDir: () => path.join(dir, 'renders'),
      allowedRoots: () => [userRoot],
    },
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    broadcast: () => {},
    userDataDir: path.join(dir, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: (_l, m) => logs.push(m),
  };
  let svc: SoundsService | null = null;
  if (opts.sounds !== 'none') {
    svc = new SoundsService({
      doc,
      userDataDir: deps.userDataDir,
      factoryDir: factory,
      getSettings: () => settings,
      broadcast: () => {},
      log: (_l, m) => logs.push(m),
      factoryPresets: opts.sounds === 'empty' ? [] : (opts.presets ?? FIXTURE_PRESETS),
    });
    deps.sounds = svc;
  }
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const byName = (name: string) => Object.values(doc.project.channels).find((c) => c.name.toLowerCase() === name.toLowerCase())!;
  const slotTypes = (insertId: string) => doc.project.mixer.inserts[insertId].slotOrder.map((s) => doc.project.mixer.inserts[insertId].slots[s].type);
  return { dir, factory, userRoot, doc, deps, svc, call, byName, slotTypes, logs, setGenre: (g: string) => (doc.project.meta.genre = g) };
}

// ── Registry ──────────────────────────────────────────────────────────

test('the four preset tools are registered with the right kinds', () => {
  assert.equal(getTool('find_presets')?.kind, 'read');
  assert.equal(getTool('load_preset')?.kind, 'write');
  assert.equal(getTool('save_preset')?.kind, 'transport', 'it writes a user file, never the project');
  assert.equal(getTool('apply_chain')?.kind, 'write');
});

// ── find_presets ──────────────────────────────────────────────────────

test('find_presets: by role + genre (default: the project genre), words, kind, plugin; compact lines', async () => {
  const { call, setGenre } = rig({ genre: 'Big Room' });
  const r = await call('find_presets', { role: 'lead' });
  assert.equal(r.ok, true, r.message);
  const ids = (r.data as { presets: Array<{ id: string }> }).presets.map((p) => p.id);
  assert.deepEqual(ids, [LEAD_EDM.id, LEAD_TRAP.id], 'EDM first for a "big room" project');
  assert.match(r.message, /Ranked for EDM \(the project genre\)/);
  assert.match(r.text!, /^factory:lead\/anthem-supersaw {2}Anthem Supersaw \(lead, Wave\) \[bright, wide, big\] \{edm, future-bass\} — Big detuned supersaw for drops\.$/m);
  setGenre('uk drill');
  const t = await call('find_presets', { role: 'lead' });
  assert.equal((t.data as { presets: Array<{ id: string }> }).presets[0].id, LEAD_TRAP.id);
  const words = await call('find_presets', { text: 'dark pluck', genre: 'any' });
  assert.equal((words.data as { presets: Array<{ id: string }> }).presets[0].id, DARK_PLUCK.id);
  const chains = await call('find_presets', { role: 'master', genre: 'lofi' });
  assert.deepEqual((chains.data as { presets: Array<{ id: string }> }).presets.map((p) => p.id), [MASTER_LOFI.id, MASTER_EDM.id]);
  assert.match(chains.text!, /master chain, 2 effects, ~-12 LUFS/);
  const bass = await call('find_presets', { role: 'bass', kind: 'chain' });
  assert.equal((bass.data as { presets: Array<{ kind: string }> }).presets[0].kind, 'chain');
  const wave = await call('find_presets', { plugin: 'wave' });
  assert.ok((wave.data as { presets: Array<{ plugin: string }> }).presets.every((p) => p.plugin === 'krypt.wavetable'));
  const bad = await call('find_presets', { role: 'kazoo' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /isn't a role/);
  const none = await call('find_presets', { text: 'xylophone' });
  assert.equal(none.ok, true);
  assert.match(none.message, /No presets match "xylophone"/);
  const unknownGenre = await call('find_presets', { role: 'pad', genre: 'polka' });
  assert.match(unknownGenre.warnings!.join(' '), /Unknown genre "polka"/);
});

test('find_presets with no presets installed, and without the sounds service (factory data + a note)', async () => {
  const empty = rig({ sounds: 'empty' });
  const r = await empty.call('find_presets', { role: 'lead' });
  assert.equal(r.ok, true);
  assert.match(r.message, /No presets are installed yet/);
  const bare = rig({ sounds: 'none' });
  const b = await bare.call('find_presets', {});
  assert.equal(b.ok, true, b.message);
  if (FACTORY_PRESETS.length) assert.match(b.warnings!.join(' '), /sounds service isn't running/);
  else assert.match(b.message, /No presets are installed yet/);
});

// ── load_preset ───────────────────────────────────────────────────────

test('load_preset by id onto an existing channel: one undo group, message names preset + channel', async () => {
  const { call, doc, byName, slotTypes } = rig();
  const keys = byName('Keys');
  const r = await call('load_preset', { preset: LEAD_EDM.id, channel: 'keys' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Loaded "Keys" \(ch_[^)]+\) → preset Anthem Supersaw \(factory:lead\/anthem-supersaw; lead, Wave\) with its 2 effects \(Chorus → Reverb\) on insert "Keys"/);
  const ch = doc.project.channels[keys.id];
  assert.equal(ch.generator.type, 'krypt.wavetable');
  assert.deepEqual(slotTypes(ch.insertId), ['krypt.chorus', 'krypt.reverb']);
  assert.ok(r.changed.includes(keys.id));
  const hist = doc.getHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].actorKey, 'agent:test-agent');
  assert.match(hist[0].label, /^load_preset/);
  assert.deepEqual(checkIntegrity(doc.project), []);
  const again = await call('load_preset', { preset: LEAD_EDM.id, channel: 'Keys' });
  assert.equal(again.ok, false, 'reloading the same preset is a no-op');
  assert.match(again.message, /^No change/);
});

test('load_preset by name or words (role from the words, the channel or the name), as a new channel, without FX', async () => {
  const { call, doc, byName, slotTypes } = rig({ genre: 'trap' });
  const byNameCall = await call('load_preset', { preset: 'wide air' });
  assert.equal(byNameCall.ok, true, byNameCall.message);
  assert.match(byNameCall.message, /^Added "Wide Air"/);
  const pad = byName('Wide Air');
  assert.equal(pad.generator.preset?.id, PAD.id);
  assert.equal(doc.project.mixer.inserts[pad.insertId].name, 'Wide Air');
  const words = await call('load_preset', { preset: 'dark pluck', name: 'Pluck' });
  assert.equal(words.ok, true, words.message);
  assert.equal(byName('Pluck').generator.preset?.id, DARK_PLUCK.id);
  assert.match(words.message, /Best match for "dark pluck"; others: Candy Pluck/);
  // "dark" alone has no role: the channel name says lead.
  await call('add_channel', { name: 'Hook', instrument: 'synth', params: { cutoff: 900 } });
  const hint = await call('load_preset', { preset: 'dark', channel: 'Hook', name: 'Hook Lead', with_fx: false });
  assert.equal(hint.ok, true, hint.message);
  const hook = byName('Hook Lead');
  assert.equal(hook.generator.preset?.id, LEAD_TRAP.id);
  assert.deepEqual(slotTypes(hook.insertId), []);
  const chain = await call('load_preset', { preset: MASTER_EDM.id });
  assert.equal(chain.ok, false);
  assert.match(chain.message, /effect-chain preset; load it with apply_chain/);
  const nothing = await call('load_preset', { preset: 'theremin' });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /No instrument preset matches "theremin"\. Call find_presets/);
  const noCh = await call('load_preset', { preset: PAD.id, channel: 'Nope' });
  assert.equal(noCh.ok, false);
  assert.match(noCh.message, /No channel "Nope"/);
});

test('load_preset onto a channel on the master gets it its own insert; a missing sample is a warning', async () => {
  const { call, doc, byName, factory } = rig();
  const snare = byName('Snare');
  await call('route', { channel: 'Snare', to: 'master' });
  assert.equal(doc.project.channels[snare.id].insertId, doc.project.mixer.masterId);
  const r = await call('load_preset', { preset: EIGHT08.id, channel: 'Snare' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /The channel shared the master, so it got its own insert "Snare"/);
  assert.notEqual(doc.project.channels[snare.id].insertId, doc.project.mixer.masterId);
  fs.rmSync(path.join(factory, '808', 'sub-boom.wav'));
  const s = await call('load_preset', { preset: SAMPLER_808.id });
  assert.equal(s.ok, true, s.message);
  assert.match(s.warnings!.join(' '), /isn't installed/);
});

// ── save_preset ───────────────────────────────────────────────────────

test('save_preset: a channel or an insert becomes a user preset file; no project change; then loadable', async () => {
  const { call, doc, svc } = rig();
  await call('load_preset', { preset: PLUCK.id, channel: 'Keys' });
  const h = doc.getHistory().length;
  const keysId = Object.values(doc.project.channels).find((c) => c.name === 'Keys')!.id;
  const params = { ...doc.project.channels[keysId].generator.params };
  const r = await call('save_preset', { channel: 'Keys', name: 'Glass Pluck', tags: ['Bright'], genres: ['future bass'], description: 'Shimmery pluck.' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Saved user preset "Glass Pluck" \(user:glass-pluck; pluck, Wave, 2 changed params, 1 effect\)\. load_preset \{"preset":"user:glass-pluck"\} loads it\./);
  // Only the label changes: the channel now shows the saved preset, as this agent, with no undo step.
  assert.deepEqual(doc.project.channels[keysId].generator.preset, { id: 'user:glass-pluck', name: 'Glass Pluck' });
  assert.deepEqual(doc.project.channels[keysId].generator.params, params);
  assert.equal(doc.getHistory().length, h);
  assert.deepEqual(r.changed, [keysId]);
  const saved = svc!.preset('user:glass-pluck')!;
  assert.equal(saved.author, 'Test Agent');
  assert.deepEqual(saved.genres, ['future-bass']);
  assert.ok(fs.existsSync(path.join(svc!.userDir(), 'glass-pluck.json')));
  const found = await call('find_presets', { text: 'glass' });
  assert.match(found.text!, /user:glass-pluck/);
  const load = await call('load_preset', { preset: 'Glass Pluck' });
  assert.equal(load.ok, true, load.message);
  const v = doc.version;
  const chain = await call('save_preset', { insert: 'master', name: 'My Master' });
  assert.equal(chain.ok, true, chain.message);
  assert.equal(doc.version, v, 'saving a chain changes nothing in the project');
  assert.match(chain.message, /user:chain\/my-master; master chain: Limiter/);
  assert.equal((await call('save_preset', { name: 'x' })).ok, false);
  assert.equal((await call('save_preset', { channel: 'Keys', insert: 'master', name: 'x' })).ok, false);
  const badGenre = await call('save_preset', { channel: 'Keys', name: 'x', genres: ['polka'] });
  assert.match(badGenre.message, /Unknown genre "polka"/);
  const wrongRole = await call('save_preset', { channel: 'Keys', name: 'x', role: 'drumBus' });
  assert.match(wrongRole.message, /chain role; a channel preset needs an instrument role/);
  const noFx = await call('save_preset', { insert: 'Clap', name: 'x' });
  assert.equal(noFx.ok, false);
  assert.match(noFx.message, /has no effects to save/);
  const none = rig({ sounds: 'none' });
  const ns = await none.call('save_preset', { channel: 'Keys', name: 'x' });
  assert.equal(ns.ok, false);
  assert.match(ns.message, /sounds service/);
});

// ── apply_chain ───────────────────────────────────────────────────────

test('apply_chain: words → the genre master on "master"; "new" creates a send; channel name → its insert; warnings', async () => {
  const { call, doc, slotTypes, byName } = rig({ genre: 'edm' });
  const r = await call('apply_chain', { chain: 'club master', insert: 'master' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Loaded chain Club Loud \(factory:chain\/master\/club-loud\) on Master \(replaced 1 effect\): EQ → Comp → Clipper → Limiter\. Tuned for about -8 LUFS/);
  assert.deepEqual(slotTypes(doc.project.mixer.masterId), ['krypt.eq', 'krypt.comp', 'krypt.clipper', 'krypt.limiter']);
  assert.equal(doc.getHistory().length, 1);
  const lofi = rig({ genre: 'lofi' });
  const l = await lofi.call('apply_chain', { chain: 'master', insert: 'master' });
  assert.match(l.message, /Dusty Tape/, 'genre picks the master chain');
  const send = await call('apply_chain', { chain: REVERB_SEND.id, insert: 'new' });
  assert.equal(send.ok, true, send.message);
  assert.match(send.message, /Created insert "Reverb" \(ins_[^)]+\)\. Nothing feeds it yet/);
  const verb = Object.values(doc.project.mixer.inserts).find((i) => i.name === 'Reverb')!;
  assert.deepEqual(slotTypes(verb.id), ['krypt.reverb']);
  const send2 = await call('apply_chain', { chain: REVERB_SEND.id, insert: 'new' });
  assert.match(send2.message, /Created insert "Reverb 2"/);
  const bus = await call('apply_chain', { chain: 'drum bus', insert: 'Kick', mode: 'append' });
  assert.equal(bus.ok, true, bus.message);
  assert.deepEqual(slotTypes(byName('Kick').insertId), ['krypt.comp', 'krypt.clipper']);
  const masterOnInsert = await call('apply_chain', { chain: MASTER_EDM.id, insert: 'Snare' });
  assert.match(masterOnInsert.warnings!.join(' '), /is a master chain/);
  const newMaster = await call('apply_chain', { chain: MASTER_EDM.id, insert: 'new' });
  assert.equal(newMaster.ok, false);
  assert.match(newMaster.message, /insert "new" is for bus and send chains/);
  const inst = await call('apply_chain', { chain: LEAD_EDM.id, insert: 'master' });
  assert.equal(inst.ok, false);
  assert.match(inst.message, /instrument preset; load it with load_preset/);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

// ── Default sounds (chooseInstrument) ─────────────────────────────────

test('chooseInstrument: role from the name + genre → preset / factory sample; legacy fallbacks', () => {
  const { deps, setGenre } = rig({ genre: 'EDM' });
  const pick = (name: string, grid = false, inst?: string) => chooseInstrument(deps, name, inst, grid);
  assert.equal(pick('Supersaw Lead').preset?.id, LEAD_EDM.id);
  assert.equal(pick('Supersaw Lead').label, 'preset Anthem Supersaw');
  assert.equal(pick('Dark Lead').preset?.id, LEAD_TRAP.id, 'a sound word in the name beats the genre');
  assert.equal(pick('Lead 2').preset?.id, LEAD_EDM.id, 'role words and numbers are not sound words');
  assert.equal(pick('Kick').sample, 'factory:kicks/edm-kick-1.wav');
  assert.equal(pick('Kick').label, 'Krypt Sampler (Big Room Kick 1)');
  assert.equal(pick('kick2').sample, 'factory:kicks/edm-kick-1.wav', 'squashed drum words still count');
  assert.equal(pick('808').preset?.id, SAMPLER_808.id, 'EDM: the clean sampled sub');
  assert.equal(pick('Pad').preset?.id, PAD.id);
  assert.equal(pick('Arp').preset?.id, PLUCK.id, 'alsoRoles: a pluck that doubles as an arp');
  assert.equal(pick('Ghost Stab').preset, undefined, 'a preset whose sample is missing is never a default');
  assert.equal(pick('Ghost Stab').type, 'krypt.triosc');
  assert.equal(pick('Mystery').preset?.id, KEYS.id, 'no hint: a playable keys sound');
  assert.equal(pick('Mystery', true).type, 'krypt.drumsynth', 'an unknown grid line is percussion');
  assert.equal(pick('Ride').type, 'krypt.drumsynth', 'no ride sample installed');
  assert.equal(pick('Open Hat').sample, 'factory:drums/hat-open.wav');
  assert.equal(pick('Lead', false, 'synth').preset?.id, LEAD_TRAP.id, '{inst=synth}: the best TriOsc lead');
  assert.equal(pick('Kick', false, 'sampler').sample, 'factory:kicks/edm-kick-1.wav');
  assert.equal(pick('Snare', false, 'drumsynth').params?.voice, 1);
  setGenre('trap');
  assert.equal(pick('Lead').preset?.id, LEAD_TRAP.id);
  assert.equal(pick('Supersaw Lead').preset?.id, LEAD_EDM.id, 'asking for a supersaw by name gets one, whatever the genre');
  assert.equal(pick('Kick').sample, 'factory:kicks/trap-kick-1.wav');
  assert.equal(pick('808').preset?.id, EIGHT08.id);
  // Genre from the library focus when the project has none.
  setGenre('');
  deps.updateSettings({ library: { focus: { collectionId: 'c1', name: 'Refs', brief: 'dark uk drill, sparse' } } } as Partial<Settings>);
  assert.equal(pick('Lead').preset?.id, LEAD_TRAP.id);
});

test('chooseInstrument with no presets / no index: the legacy kit, the 808, the TriOsc patches', () => {
  const { deps } = rig({ sounds: 'empty', index: false });
  const pick = (name: string, grid = false) => chooseInstrument(deps, name, undefined, grid);
  assert.equal(pick('Kick').sample, 'factory:drums/kick.wav');
  assert.equal(pick('Hat').sample, 'factory:drums/hat-closed.wav');
  assert.equal(pick('Ride').type, 'krypt.drumsynth');
  assert.equal(pick('808').type, 'krypt.kick808');
  const bass = pick('Reese Bass');
  assert.equal(bass.type, 'krypt.triosc');
  assert.deepEqual(bass.params, SYNTH_PRESETS[0].params);
  assert.equal(pick('Lead').label, 'TriOsc lead');
  assert.equal(pick('Mystery').label, 'Krypt TriOsc');
  // No service at all: the shared factory data (whatever ships) or the same legacy fallbacks.
  const bare = rig({ sounds: 'none', index: false });
  const lead = chooseInstrument(bare.deps, 'Lead', undefined, false);
  if (lead.preset) {
    assert.ok(FACTORY_PRESETS.some((p) => p.id === lead.preset!.id));
    assert.ok(lead.preset.role === 'lead' || lead.preset.alsoRoles?.includes('lead'));
  } else assert.equal(lead.label, 'TriOsc lead');
});

test('write_pattern create_missing loads the preset (with FX) and says which sound was chosen; one history entry', async () => {
  const { call, doc, byName, slotTypes } = rig({ genre: 'edm' });
  const r = await call('write_pattern', { kpn: 'pattern "Drop" bars=1\nsupersaw: C5:4 E5:4 G5:4 C6:4\nride: x.x. x.x. x.x. x.x.\nkick2: x... x... x... x...' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Created channels "Supersaw" → preset Anthem Supersaw, "Ride" → Krypt DrumSynth \(openhat\), "Kick2" → Krypt Sampler \(Big Room Kick 1\)\./);
  const lead = byName('Supersaw');
  assert.equal(lead.generator.preset?.id, LEAD_EDM.id);
  assert.deepEqual(slotTypes(lead.insertId), ['krypt.chorus', 'krypt.reverb']);
  assert.equal(doc.getHistory().length, 1);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('add_channel: preset by name (own insert + FX), knobs → classic default, explicit insert → no FX on it', async () => {
  const { call, doc, byName, slotTypes } = rig({ genre: 'edm' });
  const a = await call('add_channel', { name: 'Pad', volume_db: -8 });
  assert.equal(a.ok, true, a.message);
  assert.match(a.message, /^Added channel "Pad" \(ch_[^)]+\) → preset Wide Air \(factory:pad\/wide-air; Wave\) with 1 effect → insert "Pad"/);
  const pad = byName('Pad');
  assert.equal(pad.generator.preset?.id, PAD.id);
  assert.deepEqual(slotTypes(pad.insertId), ['krypt.reverb']);
  assert.ok(Math.abs(pad.volume - 0.398) < 0.01, 'volume_db wins over the preset');
  const knobs = await call('add_channel', { name: 'Pad 2', params: { cutoff: '1.2kHz' } });
  assert.equal(knobs.ok, true, knobs.message);
  assert.equal(byName('Pad 2').generator.type, 'krypt.triosc');
  assert.equal(byName('Pad 2').generator.params.cutoff, 1200);
  const m = await call('add_channel', { name: 'Lead', insert: 'master' });
  assert.equal(m.ok, true, m.message);
  assert.match(m.message, /its 2 effects not loaded onto the shared insert/);
  assert.equal(byName('Lead').insertId, doc.project.mixer.masterId);
  assert.deepEqual(slotTypes(doc.project.mixer.masterId), ['krypt.limiter']);
  const kick = await call('add_channel', { name: 'Kick 2' });
  assert.match(kick.message, /Krypt Sampler \(Big Room Kick 1\) with Big Room Kick 1|Krypt Sampler \(Big Room Kick 1\) with edm-kick-1/);
  const wave = await call('add_channel', { name: 'Supersaw', instrument: 'wave' });
  assert.equal(byName('Supersaw').generator.preset?.id, LEAD_EDM.id, 'an explicit plugin still gets its best preset for the role');
  assert.ok(wave.ok);
});

// ── find_samples ──────────────────────────────────────────────────────

test('find_samples: index metadata (kind, bars, root, genre ranking), groups, user files classified by name', async () => {
  const { call, userRoot } = rig({ genre: 'edm' });
  const mk = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(userRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(userRoot, rel), 'RIFF');
  };
  mk('Drums/Kicks/Hard 01.wav');
  mk('Drums/Tight Snare 02.wav');
  mk('Loops/120bpm Groove.wav');
  mk('FX/Risers/Up 4 bar.wav');
  mk('Trap Kit/808 Mafia C1.wav');
  const r = await call('find_samples', { kind: 'riser', bars: 4 });
  assert.equal(r.ok, true, r.message);
  const lines = r.text!.split('\n');
  assert.match(lines[0], /^factory:fx\/riser-noise-4\.wav {2}riser · Noise Riser 4 · 4 bars @128 bpm · \{edm\}$/);
  assert.ok(lines.some((l) => /Up 4 bar\.wav {2}riser · 4 bars$/.test(l)), r.text);
  assert.ok(!r.text!.includes('riser-noise-8'), 'bars filters exactly when a match exists… or ranks by distance');
  const kicks = await call('find_samples', { kind: 'kick' });
  const kl = kicks.text!.split('\n');
  assert.match(kl[0], /^factory:kicks\/edm-kick-1\.wav/, 'the project genre ranks first');
  assert.ok(kl.some((l) => l.includes('Hard 01.wav') && l.endsWith('kick')), kicks.text);
  const trapKicks = await call('find_samples', { kind: 'kick', genre: 'trap' });
  assert.match(trapKicks.text!.split('\n')[0], /trap-kick-1/);
  const fx = await call('find_samples', { kind: 'fx' });
  assert.ok(fx.text!.includes('impact-boom') && fx.text!.includes('riser-noise-8'));
  const eight = await call('find_samples', { kind: '808' });
  assert.match(eight.text!, /factory:808\/sub-boom\.wav {2}808 · Sub Boom · root C2/);
  assert.match(eight.text!, /808 Mafia C1\.wav {2}808/);
  const loops = await call('find_samples', { kind: 'loop' });
  assert.match(loops.text!, /120bpm Groove\.wav {2}loop/);
  const q = await call('find_samples', { query: 'snare' });
  assert.match(q.text!, /Tight Snare 02\.wav {2}snare/);
  const none = await call('find_samples', { kind: 'tom' });
  assert.match(none.message, /^No samples match kind tom\./);
});

test('find_samples without an index lists the factory files by name (legacy kit), still filtering by kind', async () => {
  const { call } = rig({ index: false });
  const r = await call('find_samples', { query: 'snare' });
  assert.equal(r.ok, true);
  assert.match(r.text!, /factory:drums\/snare\.wav {2}snare/);
  const k = await call('find_samples', { kind: 'hat' });
  assert.match(k.text!, /factory:drums\/hat-closed\.wav/);
  assert.ok(!k.text!.includes('hat-open'), 'open hats are their own kind');
});

test('classifyUserSample: file words first, then folders; loops; FX words', () => {
  assert.equal(classifyUserSample('Kicks/Hard 01.wav'), 'kick');
  assert.equal(classifyUserSample('Drums/OpenHat_03.wav'), 'openhat');
  assert.equal(classifyUserSample('HiHats/closed 1.wav'), 'hat');
  assert.equal(classifyUserSample('Snares/Kick Loop 128bpm.wav'), 'loop');
  assert.equal(classifyUserSample('FX/Reverse Crash.wav'), 'reverse-cymbal');
  assert.equal(classifyUserSample('808s/Long.wav'), '808');
  assert.equal(classifyUserSample('Misc/Whoosh Big.wav'), 'whoosh');
  assert.equal(classifyUserSample('FX/Sweep Up 4bar.wav'), 'sweep-up');
  assert.equal(classifyUserSample('Transitions/Tape Stop 1.wav'), 'tape-stop');
  assert.equal(classifyUserSample('FX/Reverb Swell.wav'), 'swell');
  assert.equal(classifyUserSample('Foley/Keys Drop.wav'), 'foley');
  assert.equal(classifyUserSample('Field/City Ambience.wav'), 'ambience');
  assert.equal(classifyUserSample('Game/8bit Coin.wav'), 'retro');
  assert.equal(classifyUserSample('Misc/thing.wav'), null);
  assert.equal(classifyUserSample('Vinyl Crackle.wav'), 'texture');
});

run('sounds tools');
