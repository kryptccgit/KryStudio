// Preset gating on sound packs, through callTool against a real DocHost + SoundsService: a preset whose pack isn't
// installed is skipped by chooseInstrument (write_pattern / add_channel defaults) and get_playbook's picks, flagged
// in find_presets ("needs the … pack (download it in Home ▸ Sounds)"), refused by load_preset when named, replaced
// by a playable match for a word search; once installed it is picked and loads. Plus list_packs, user presets saved
// from a pack channel, and the pure fallback picker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { PackEntryState, PacksState } from '@shared/packs/types';
import type { InstrumentPreset, Preset } from '@shared/sounds/types';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { chooseInstrument, presetPlayable } from '../electron/mcp/tools/instruments';
import { plainPicker } from '../electron/mcp/tools/craftRecipe';
import { SoundsService } from '../electron/sounds/service';
import type { PacksAccess } from '../electron/packs/service';
import { missingPack, needsPackText, packPhrase, presetPackId } from '../electron/packs/gating';
import { resolvePackPath } from '../electron/project/samples';
import { FIXTURE_PRESETS, writeFactory } from './sounds-fixtures';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-packs-gating-'));
let n = 0;

const GRAND: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:piano/test-concert-grand',
  name: 'Test Concert Grand',
  plugin: 'krypt.sampler',
  params: {},
  sample: 'pack:test-piano/krypt/grand.sfz',
  requires: 'test-piano',
  role: 'piano',
  tags: ['acoustic', 'bright', 'grand'],
  genres: ['pop', 'lofi', 'rnb'],
  defaultFor: ['pop', 'lofi'],
  description: 'A real recorded concert grand.',
};
const SYNTH_PIANO: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:piano/synth-piano',
  name: 'Synth Piano',
  plugin: 'krypt.triosc',
  params: { cutoff: 4000 },
  role: 'piano',
  tags: ['synth'],
  genres: ['pop'],
  description: 'A synthesised piano for chords.',
};
const PRESETS: readonly Preset[] = [...FIXTURE_PRESETS, GRAND, SYNTH_PIANO];

const SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
} as Settings;

function packEntry(id: string, name: string, status: PackEntryState['status'], extra: Partial<PackEntryState> = {}): PackEntryState {
  return {
    id,
    name,
    description: `${name} for tests.`,
    author: 'Test Recordist',
    licence: { spdx: 'CC0-1.0', name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: `${name} by Test Recordist` },
    bytes: 300 * 1024 * 1024,
    ramMb: 240,
    contents: [`${name} (4 velocity layers)`],
    status,
    ...extra,
  };
}

function rig(opts: { packs?: 'wired' | 'none'; installed?: boolean; genre?: string } = {}) {
  const dir = path.join(TMP, `case-${++n}`);
  const factory = path.join(dir, 'factory');
  const packsDir = path.join(dir, 'userData', 'packs');
  fs.mkdirSync(factory, { recursive: true });
  writeFactory(factory, { index: true });
  const installed = new Set<string>();
  const install = (): void => {
    installed.add('test-piano');
    const sfz = resolvePackPath(GRAND.sample!, packsDir);
    fs.mkdirSync(path.dirname(sfz), { recursive: true });
    fs.writeFileSync(sfz, '<region> sample=a.wav');
  };
  if (opts.installed) install();
  const packs: PacksAccess = {
    state: (): PacksState => ({
      dir: packsDir,
      packs: [packEntry('test-piano', 'Test Piano', installed.has('test-piano') ? 'installed' : 'available'), packEntry('test-drums', 'Test Drums', 'downloading', { progress: { bytes: 75 * 1024 * 1024, total: 300 * 1024 * 1024 } })],
    }),
    isInstalled: (id) => installed.has(id),
    packName: (id) => ({ 'test-piano': 'Test Piano', 'test-drums': 'Test Drums' })[id],
  };
  const project = createDefaultProject('Test');
  project.meta.genre = opts.genre ?? 'pop';
  const doc = new DocHost(project, CATALOG, { strict: true });
  let settings: Settings = structuredClone(SETTINGS);
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
      resolveSamplePath: (p) => (p.startsWith('factory:') ? path.join(factory, p.slice('factory:'.length)) : p.startsWith('pack:') ? resolvePackPath(p, packsDir) : p),
      renderDir: () => path.join(dir, 'renders'),
      allowedRoots: () => [],
    },
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    broadcast: () => {},
    userDataDir: path.join(dir, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  deps.sounds = new SoundsService({ doc, userDataDir: deps.userDataDir, factoryDir: factory, getSettings: () => settings, broadcast: () => {}, log: () => {}, factoryPresets: PRESETS });
  if (opts.packs !== 'none') deps.packs = packs;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { deps, doc, call, install, packsDir };
}

const NEEDS = 'needs the Test Piano pack (download it in Home ▸ Sounds)';

// ── Helpers ───────────────────────────────────────────────────────────

test('gating helpers: the pack a preset needs, whether it is missing, the sentence', () => {
  assert.equal(presetPackId(GRAND), 'test-piano');
  assert.equal(presetPackId({ ...GRAND, requires: undefined }), 'test-piano', 'from the pack: sample');
  assert.equal(presetPackId(SYNTH_PIANO), null);
  assert.equal(presetPackId(FIXTURE_PRESETS.find((p) => p.kind === 'chain')!), null);
  const packs = { isInstalled: (id: string) => id === 'x', packName: (id: string) => (id === 'test-piano' ? 'Test Piano' : undefined) };
  assert.deepEqual(missingPack(packs, GRAND), { id: 'test-piano', name: 'Test Piano' });
  assert.equal(missingPack(packs, SYNTH_PIANO), null);
  assert.deepEqual(missingPack(undefined, GRAND), { id: 'test-piano', name: 'test-piano' }, 'no service: not installed');
  assert.equal(needsPackText('Test Piano'), NEEDS);
  assert.equal(packPhrase('Orchestra Pack'), 'the Orchestra Pack');
});

// ── Automatic picks ──────────────────────────────────────────────────

test('chooseInstrument: a missing pack is skipped for the role; once installed it is the pick', () => {
  const r = rig();
  assert.equal(presetPlayable(r.deps, GRAND), false);
  const before = chooseInstrument(r.deps, 'Piano', undefined, false);
  assert.equal(before.preset?.id, SYNTH_PIANO.id);
  r.install();
  assert.equal(presetPlayable(r.deps, GRAND), true);
  const after = chooseInstrument(r.deps, 'Piano', undefined, false);
  assert.equal(after.preset?.id, GRAND.id);
  assert.equal(after.sample, GRAND.sample);
  // Installed per the service but the mapping file is gone: still skipped.
  const gone = rig();
  (gone.deps.packs as PacksAccess).isInstalled = () => true;
  assert.equal(chooseInstrument(gone.deps, 'Piano', undefined, false).preset?.id, SYNTH_PIANO.id);
  // No packs service wired: pack presets never become defaults.
  const none = rig({ packs: 'none' });
  assert.equal(chooseInstrument(none.deps, 'Piano', undefined, false).preset?.id, SYNTH_PIANO.id);
});

test('write_pattern creates a missing "Piano" channel without the missing pack', async () => {
  const r = rig();
  const res = await r.call('write_pattern', { pattern: 'Verse', kpn: 'Piano: C4 E4 G4 C5' });
  assert.equal(res.ok, true, res.message);
  const ch = Object.values(r.doc.project.channels).find((c) => c.name === 'Piano')!;
  assert.equal(ch.generator.preset?.id, SYNTH_PIANO.id);
  assert.ok(!Object.values(r.doc.project.samples).some((s) => s.path.startsWith('pack:')));
});

test('get_playbook picks the pack preset only once the pack is installed', async () => {
  const pianoRef = (res: { data?: unknown }) => (res.data as { parts: Array<{ name: string; role?: string; sound: { ref: string | null } }> }).parts.find((p) => p.name === 'Piano')?.sound.ref;
  const r = rig({ genre: 'pop' });
  const a = await r.call('get_playbook', { genre: 'pop' });
  assert.equal(a.ok, true, a.message);
  assert.ok(pianoRef(a), 'the pop playbook has a Piano part');
  assert.notEqual(pianoRef(a), GRAND.id);
  assert.ok(!JSON.stringify(a).includes(GRAND.id));
  r.install();
  const b = await r.call('get_playbook', { genre: 'pop' });
  assert.equal(pianoRef(b), GRAND.id);
});

test('plainPicker (no app sound library) skips pack presets', () => {
  const pick = plainPicker([GRAND, SYNTH_PIANO], null);
  assert.equal(pick.preset({ name: 'Piano', role: 'piano', tags: [] } as never, 'pop')?.id, SYNTH_PIANO.id);
});

// ── find_presets / load_preset ──────────────────────────────────────

test('find_presets lists pack presets with "needs the … pack (download it in Home ▸ Sounds)" until installed', async () => {
  const r = rig();
  const res = await r.call('find_presets', { role: 'piano' });
  assert.equal(res.ok, true, res.message);
  const line = res.text!.split('\n').find((l) => l.startsWith(GRAND.id))!;
  assert.ok(line.endsWith(`— ${NEEDS}`), line);
  assert.ok(!res.text!.split('\n').find((l) => l.startsWith(SYNTH_PIANO.id))!.includes('needs the'));
  assert.match(res.message, /1 preset marked "needs the … pack" only play once the user downloads that pack in Home ▸ Sounds \(you can't download packs; list_packs shows them\)/);
  const data = res.data as { presets: Array<{ id: string; needsPack?: { id: string; name: string } }> };
  assert.deepEqual(data.presets.find((p) => p.id === GRAND.id)?.needsPack, { id: 'test-piano', name: 'Test Piano' });
  assert.equal(data.presets.find((p) => p.id === SYNTH_PIANO.id)?.needsPack, undefined);
  r.install();
  const after = await r.call('find_presets', { role: 'piano' });
  assert.ok(!after.text!.includes('needs the'));
  assert.doesNotMatch(after.message, /needs the/);
});

test('load_preset: a named pack preset is refused with the pack to download; words fall back to one that plays', async () => {
  const r = rig();
  for (const preset of [GRAND.id, GRAND.name]) {
    const res = await r.call('load_preset', { preset });
    assert.equal(res.ok, false);
    assert.match(res.message, new RegExp(`Test Concert Grand \\(${GRAND.id}\\) needs the Test Piano pack \\(download it in Home ▸ Sounds\\)\\. You can't download packs`));
  }
  assert.ok(!Object.values(r.doc.project.channels).some((c) => c.generator.preset?.id === GRAND.id));
  const words = await r.call('load_preset', { preset: 'grand piano' });
  assert.equal(words.ok, true, words.message);
  assert.match(words.message, /preset Synth Piano/);
  assert.ok(words.warnings?.some((w) => w.includes(`The best match, Test Concert Grand (${GRAND.id}) ${NEEDS}; loaded Synth Piano instead`)), JSON.stringify(words.warnings));
  // Installed: it loads, with its pack sample.
  r.install();
  const ok = await r.call('load_preset', { preset: GRAND.id, name: 'Grand' });
  assert.equal(ok.ok, true, ok.message);
  const ch = Object.values(r.doc.project.channels).find((c) => c.name === 'Grand')!;
  assert.equal(ch.generator.preset?.id, GRAND.id);
  assert.equal(r.doc.project.samples[ch.generator.sampleId!].path, GRAND.sample);
});

test('a user preset saved from a pack channel remembers the pack it needs', () => {
  const r = rig({ installed: true });
  const svc = r.deps.sounds as SoundsService;
  const saved = svc.saveUser({ ...GRAND, id: 'user:x', name: 'My Grand', requires: undefined });
  assert.equal(saved.ok, true, saved.message);
  const p = svc.preset(saved.data!.id) as InstrumentPreset;
  assert.equal(p.requires, 'test-piano');
  const plain = svc.saveUser({ ...SYNTH_PIANO, id: 'user:y', name: 'My Synth Piano' });
  assert.equal((svc.preset(plain.data!.id) as InstrumentPreset).requires, undefined);
});

// ── list_packs ──────────────────────────────────────────────────────

test('list_packs: read tool with status, size, RAM, licence, presets and how the USER installs them', async () => {
  assert.equal(getTool('list_packs')?.kind, 'read');
  const r = rig();
  const res = await r.call('list_packs');
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /^2 sound packs, 0 installed\. To add one, the user opens Home ▸ Sounds ▸ Sound packs and clicks Download \(Test Piano\); you can't download packs\./);
  const text = res.text!;
  assert.match(text, /^test-piano {2}Test Piano: not downloaded · 300 MB download · ~240 MB RAM per instrument · CC0 1\.0 Universal · adds Test Piano \(4 velocity layers\); presets: Test Concert Grand \(piano, factory:piano\/test-concert-grand\)/m);
  assert.match(text, /^test-drums {2}Test Drums: downloading now 25%/m);
  const data = res.data as { dir: string; packs: Array<{ id: string; status: string; installed: boolean; downloadMb: number; presets: Array<{ id: string }>; licence: { attribution: string } }> };
  assert.equal(data.dir, r.packsDir);
  assert.deepEqual(
    data.packs.map((p) => [p.id, p.status, p.installed, p.downloadMb, p.presets.map((x) => x.id)]),
    [
      ['test-piano', 'available', false, 300, [GRAND.id]],
      ['test-drums', 'downloading', false, 300, []],
    ],
  );
  assert.equal(data.packs[0].licence.attribution, 'Test Piano by Test Recordist');
  // Nothing changed in the project (read tool).
  assert.deepEqual(res.changed, []);
  r.install();
  const after = await r.call('list_packs');
  assert.match(after.message, /^2 sound packs, 1 installed\./);
  assert.match(after.text!, /Test Piano: installed ·/);
});

test('list_packs without the packs service: the catalog as not downloaded, with a warning', async () => {
  const r = rig({ packs: 'none' });
  const res = await r.call('list_packs');
  assert.equal(res.ok, true, res.message);
  // The shared catalog may be empty while it is being filled; either way the call says what it knows.
  if ((res.data as { packs: unknown[] }).packs.length) assert.ok(res.warnings?.some((w) => /sound-pack service isn't running/.test(w)));
  else assert.match(res.message, /offers no sound packs/);
});

await run('packs-gating');
fs.rmSync(TMP, { recursive: true, force: true });
