// Preset / sound-library renderer logic (src/sounds/logic.ts): the preset
// browser's search + role grouping (chains: master first on the master),
// prev/next cycling, the preset bar's "modified" detection, the drag
// payload, factory sample folders, Save dialog defaults and Browser roots.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { ParamSpec } from '@shared/plugins/types';
import { summarizePreset, type FactorySample, type InstrumentPreset, type PresetSummary } from '@shared/sounds/types';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import {
  INSTRUMENT_ROLE_LABELS,
  changedParams,
  chainRoleOrder,
  cycleList,
  cyclePreset,
  decodePresetDrag,
  encodePresetDrag,
  folderName,
  groupFactorySamples,
  groupPresets,
  guessChainRole,
  isPresetModified,
  modifiedHint,
  parseTagList,
  presetMatches,
  presetSaveDefaults,
  roleLabel,
  sampleDetail,
  sampleKindLabel,
  soundsCounts,
  tagCounts,
  validatePresetName,
  withBrowserRoot,
  PRESET_MIME,
} from '../src/sounds/logic';

const inst = (id: string, name: string, role: string, plugin: string, extra: Partial<PresetSummary> = {}): PresetSummary => ({
  id,
  kind: 'instrument',
  name,
  role: role as PresetSummary['role'],
  plugin,
  tags: [],
  genres: [],
  description: '',
  source: id.startsWith('user:') ? 'user' : 'factory',
  ...extra,
});

const chain = (id: string, name: string, role: string, extra: Partial<PresetSummary> = {}): PresetSummary => ({
  id,
  kind: 'chain',
  name,
  role: role as PresetSummary['role'],
  tags: [],
  genres: [],
  description: '',
  source: id.startsWith('user:') ? 'user' : 'factory',
  ...extra,
});

const PRESETS: PresetSummary[] = [
  inst('factory:lead/anthem-supersaw', 'Anthem Supersaw', 'lead', 'krypt.wavetable', { tags: ['bright', 'wide', 'detuned'], genres: ['edm', 'future-bass'], description: 'Huge detuned saw stack for drops.' }),
  inst('factory:lead/glass-lead', 'Glass Lead', 'lead', 'krypt.fm', { tags: ['bright', 'metallic'], genres: ['pop'] }),
  inst('factory:808/long-808', 'Long 808', '808', 'krypt.kick808', { tags: ['deep', 'long'], genres: ['trap', 'drill'] }),
  inst('factory:pluck/dark-pluck', 'Dark Pluck', 'pluck', 'krypt.wavetable', { tags: ['dark', 'short'], genres: ['future-bass'] }),
  inst('factory:kick/punch-kick', 'Punch Kick', 'kick', 'krypt.sampler', { tags: ['punchy'] }),
  inst('user:my-lead', 'Zed Lead', 'lead', 'krypt.wavetable', { tags: ['dark'] }),
  inst('factory:pad/warm-pad-10', 'Warm Pad 10', 'pad', 'krypt.wavetable'),
  inst('factory:pad/warm-pad-2', 'Warm Pad 2', 'pad', 'krypt.wavetable'),
  chain('factory:chain/master/club-loud', 'Club Loud', 'master', { tags: ['loud'], genres: ['edm'] }),
  chain('factory:chain/drumBus/glue', 'Drum Glue', 'drumBus'),
  chain('factory:chain/reverbSend/hall', 'Big Hall', 'reverbSend', { tags: ['long'] }),
  chain('user:chain/my-bus', 'My Bus', 'drumBus'),
];

// ── Search + grouping ────────────────────────────────────────────────

test('groupPresets: role order, empty roles dropped, your presets first, natural name order', () => {
  const g = groupPresets(PRESETS, { kind: 'instrument' });
  assert.deepEqual(
    g.map((x) => x.role),
    ['kick', '808', 'lead', 'pluck', 'pad'],
    'INSTRUMENT_ROLES order (drums, low end, music)',
  );
  assert.equal(g[0].label, 'Kicks');
  const leads = g.find((x) => x.role === 'lead')!;
  assert.deepEqual(
    leads.presets.map((p) => p.name),
    ['Zed Lead', 'Anthem Supersaw', 'Glass Lead'],
    'user preset first, then by name',
  );
  const pads = g.find((x) => x.role === 'pad')!;
  assert.deepEqual(
    pads.presets.map((p) => p.name),
    ['Warm Pad 2', 'Warm Pad 10'],
    'numbers sort naturally',
  );
  assert.ok(g.every((x) => x.presets.every((p) => p.kind === 'instrument')));
});

test('groupPresets: unknown roles go last instead of vanishing', () => {
  const g = groupPresets([...PRESETS, inst('user:odd', 'Odd', 'zither', 'krypt.fm')], { kind: 'instrument' });
  assert.equal(g[g.length - 1].role, 'zither');
  assert.equal(g[g.length - 1].label, 'zither');
});

test('search: every word must match name, description, tags, role, plugin or genre', () => {
  const names = (f: Parameters<typeof groupPresets>[1]) => groupPresets(PRESETS, f).flatMap((g) => g.presets.map((p) => p.name));
  assert.deepEqual(names({ kind: 'instrument', text: 'dark' }), ['Zed Lead', 'Dark Pluck']);
  assert.deepEqual(names({ kind: 'instrument', text: 'dark pluck' }), ['Dark Pluck']);
  assert.deepEqual(names({ kind: 'instrument', text: 'DROPS saw' }), ['Anthem Supersaw'], 'description words, case-insensitive');
  assert.deepEqual(names({ kind: 'instrument', text: 'future bass' }), ['Anthem Supersaw', 'Dark Pluck'], 'genre names match');
  assert.deepEqual(names({ kind: 'instrument', text: 'kick808' }), ['Long 808'], 'plugin id words match');
  assert.deepEqual(names({ kind: 'instrument', text: 'leads' }), ['Zed Lead', 'Anthem Supersaw', 'Glass Lead'], 'role labels match');
  assert.deepEqual(names({ kind: 'instrument', text: 'nothing-like-this' }), []);
});

test('filters: genre, tags (all of them), source, plugin, kind', () => {
  const names = (f: Parameters<typeof groupPresets>[1]) => groupPresets(PRESETS, f).flatMap((g) => g.presets.map((p) => p.name));
  assert.deepEqual(names({ kind: 'instrument', genre: 'trap' }), ['Long 808']);
  assert.deepEqual(names({ kind: 'instrument', tags: ['bright'] }), ['Anthem Supersaw', 'Glass Lead']);
  assert.deepEqual(names({ kind: 'instrument', tags: ['bright', 'wide'] }), ['Anthem Supersaw']);
  assert.deepEqual(names({ kind: 'instrument', tags: ['BRIGHT'] }), ['Anthem Supersaw', 'Glass Lead'], 'tags compare lower-case');
  assert.deepEqual(names({ kind: 'instrument', source: 'user' }), ['Zed Lead']);
  assert.deepEqual(names({ kind: 'chain', source: 'factory' }), ['Drum Glue', 'Big Hall', 'Club Loud']);
  assert.deepEqual(names({ kind: 'instrument', plugin: 'krypt.fm' }), ['Glass Lead']);
  assert.equal(presetMatches(PRESETS[0], { kind: 'chain' }), false);
  assert.equal(presetMatches(PRESETS[0], {}), true);
});

test('chains: master chains first on the master, last everywhere else', () => {
  assert.equal(chainRoleOrder(true)[0], 'master');
  assert.equal(chainRoleOrder(false).at(-1), 'master');
  assert.equal(new Set(chainRoleOrder(true)).size, chainRoleOrder(true).length);
  assert.equal(chainRoleOrder(false).length, chainRoleOrder(true).length);
  const onMaster = groupPresets(PRESETS, { kind: 'chain' }, chainRoleOrder(true));
  assert.deepEqual(
    onMaster.map((g) => g.role),
    ['master', 'drumBus', 'reverbSend'],
  );
  assert.equal(onMaster[0].label, 'Master');
  const onInsert = groupPresets(PRESETS, { kind: 'chain' }, chainRoleOrder(false));
  assert.deepEqual(
    onInsert.map((g) => g.role),
    ['drumBus', 'reverbSend', 'master'],
  );
  assert.deepEqual(
    onInsert[0].presets.map((p) => p.name),
    ['My Bus', 'Drum Glue'],
    'your chains first',
  );
  assert.equal(onInsert[0].label, 'Drum bus');
});

test('labels: every role, chain role and sample kind has a readable label', () => {
  for (const [role, label] of Object.entries(INSTRUMENT_ROLE_LABELS)) assert.ok(label && label !== '', role);
  assert.equal(roleLabel('808'), '808s');
  assert.equal(roleLabel('reverbSend', 'chain'), 'Reverb send');
  assert.equal(sampleKindLabel('reverse-cymbal'), 'Reverse cymbals');
  assert.equal(sampleKindLabel('mystery'), 'mystery');
});

test('tagCounts: most used first', () => {
  const t = tagCounts(PRESETS);
  assert.equal(t[0].tag, 'bright');
  assert.equal(t[0].count, 2);
});

// ── Prev / next ───────────────────────────────────────────────────────

test('cycling: same plugin only, browser order, wraps both ways', () => {
  const list = cycleList(PRESETS, 'krypt.wavetable');
  assert.deepEqual(
    list.map((p) => p.name),
    ['Zed Lead', 'Anthem Supersaw', 'Dark Pluck', 'Warm Pad 2', 'Warm Pad 10'],
  );
  assert.equal(cyclePreset(list, 'factory:lead/anthem-supersaw', 1)?.name, 'Dark Pluck');
  assert.equal(cyclePreset(list, 'factory:lead/anthem-supersaw', -1)?.name, 'Zed Lead');
  assert.equal(cyclePreset(list, 'factory:pad/warm-pad-10', 1)?.name, 'Zed Lead', 'wraps forward');
  assert.equal(cyclePreset(list, 'user:my-lead', -1)?.name, 'Warm Pad 10', 'wraps backward');
});

test('cycling: from no preset (or one of another plugin) next = first, previous = last; nothing to cycle = null', () => {
  const list = cycleList(PRESETS, 'krypt.wavetable');
  assert.equal(cyclePreset(list, undefined, 1)?.name, 'Zed Lead');
  assert.equal(cyclePreset(list, null, -1)?.name, 'Warm Pad 10');
  assert.equal(cyclePreset(list, 'factory:lead/glass-lead', 1)?.name, 'Zed Lead');
  assert.equal(cyclePreset(cycleList(PRESETS, 'krypt.drumsynth'), null, 1), null);
  const one = cycleList(PRESETS, 'krypt.fm');
  assert.equal(cyclePreset(one, 'factory:lead/glass-lead', 1)?.id, 'factory:lead/glass-lead', 'a single preset cycles to itself');
});

// ── Modified detection ────────────────────────────────────────────────

const SPECS: ParamSpec[] = [
  { id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, default: 8000, unit: 'Hz', scale: 'log' },
  { id: 'res', name: 'Resonance', min: 0, max: 1, default: 0.2, unit: '', scale: 'linear' },
  { id: 'wave', name: 'Wave', min: 0, max: 4, default: 0, unit: '', scale: 'linear', step: 1, options: ['Saw', 'Square', 'Sine', 'Tri', 'Noise'] },
];

const PRESET: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:lead/test',
  name: 'Test Lead',
  plugin: 'krypt.wavetable',
  params: { cutoff: 1200, wave: 2 },
  role: 'lead',
  tags: [],
  genres: [],
  description: '',
};

test('modified: a fresh load (params missing on either side = default) is not modified', () => {
  const cur = { type: 'krypt.wavetable', params: { cutoff: 1200, wave: 2, res: 0.2 }, samplePath: null };
  assert.equal(isPresetModified(cur, PRESET, SPECS), false);
  assert.equal(isPresetModified({ ...cur, params: { cutoff: 1200, wave: 2 } }, PRESET, SPECS), false);
  assert.deepEqual(changedParams(cur, PRESET, SPECS), []);
});

test('modified: tolerance for float noise, clamping and steps; a real knob move counts', () => {
  const base = { type: 'krypt.wavetable', samplePath: null };
  assert.equal(isPresetModified({ ...base, params: { cutoff: 1200.0000001, wave: 2 } }, PRESET, SPECS), false, 'float noise');
  assert.equal(isPresetModified({ ...base, params: { cutoff: 1200, wave: 2.2 } }, PRESET, SPECS), false, 'stepped params compare stepped');
  assert.equal(
    isPresetModified({ ...base, params: { cutoff: 1200, wave: 2 } }, { ...PRESET, params: { ...PRESET.params, res: 5 } }, SPECS),
    true,
    'res 5 clamps to 1, which differs from the default 0.2',
  );
  assert.equal(isPresetModified({ ...base, params: { cutoff: 1300, wave: 2 } }, PRESET, SPECS), true);
  assert.deepEqual(changedParams({ ...base, params: { cutoff: 1300, wave: 3, res: 0.2 } }, PRESET, SPECS), ['cutoff', 'wave']);
  assert.equal(isPresetModified({ ...base, params: { cutoff: 1200, wave: 2, res: 0.5 } }, PRESET, SPECS), true, 'a param the preset leaves at default');
});

test('modified: another instrument, or a different sample, counts too', () => {
  assert.equal(isPresetModified({ type: 'krypt.triosc', params: { cutoff: 1200, wave: 2 }, samplePath: null }, PRESET, SPECS), true);
  const sampler: InstrumentPreset = { ...PRESET, plugin: 'krypt.sampler', params: {}, sample: 'factory:drums/kick.wav' };
  assert.equal(isPresetModified({ type: 'krypt.sampler', params: {}, samplePath: 'factory:drums/kick.wav' }, sampler, []), false);
  assert.equal(isPresetModified({ type: 'krypt.sampler', params: {}, samplePath: 'C:\\x\\other.wav' }, sampler, []), true);
  assert.equal(isPresetModified({ type: 'krypt.sampler', params: {}, samplePath: 'C:\\x\\any.wav' }, { ...sampler, sample: undefined }, []), false, 'no preset sample = not compared');
  assert.match(modifiedHint({ type: 'krypt.sampler', params: {}, samplePath: 'C:\\x\\other.wav' }, sampler, []), /the sample/);
  assert.match(modifiedHint({ type: 'krypt.wavetable', params: { cutoff: 900 }, samplePath: null }, PRESET, SPECS), /2 settings/);
});

test('modified: without specs, the union of both param maps is compared as-is', () => {
  const cur = { type: 'krypt.wavetable', params: { cutoff: 1200, wave: 2 }, samplePath: null };
  assert.equal(isPresetModified(cur, PRESET), false);
  assert.equal(isPresetModified({ ...cur, params: { ...cur.params, extra: 1 } }, PRESET), true);
  assert.deepEqual(changedParams({ ...cur, params: { cutoff: 1200 } }, PRESET), ['wave']);
});

// ── Drag payload ──────────────────────────────────────────────────────

test('drag payload: round-trips id, kind and name; anything else is null', () => {
  assert.equal(PRESET_MIME, 'application/x-krypt-preset');
  for (const p of PRESETS) assert.deepEqual(decodePresetDrag(encodePresetDrag(p)), { id: p.id, kind: p.kind, name: p.name });
  const raw = encodePresetDrag(PRESETS[0]);
  assert.deepEqual(JSON.parse(raw), { id: 'factory:lead/anthem-supersaw', kind: 'instrument', name: 'Anthem Supersaw' }, 'payload is small JSON');
  assert.equal(decodePresetDrag(''), null);
  assert.equal(decodePresetDrag(null), null);
  assert.equal(decodePresetDrag('factory:drums/kick.wav'), null, 'a sample path is not a preset');
  assert.equal(decodePresetDrag(JSON.stringify({ id: 'C:\\evil', kind: 'instrument', name: 'x' })), null);
  assert.equal(decodePresetDrag(JSON.stringify({ id: 'user:x', kind: 'sample', name: 'x' })), null);
  assert.deepEqual(decodePresetDrag(JSON.stringify({ id: 'user:x', kind: 'chain' })), { id: 'user:x', kind: 'chain', name: 'user:x' }, 'missing name falls back to the id');
});

// ── Factory samples ───────────────────────────────────────────────────

const sample = (path: string, name: string, kind: FactorySample['kind'], extra: Partial<FactorySample> = {}): FactorySample => ({
  path,
  name,
  kind,
  tags: [],
  genres: [],
  lengthSec: 1,
  channels: 1,
  peakDb: -1,
  ...extra,
});

const SAMPLES: FactorySample[] = [
  sample('factory:fx/riser-4.wav', 'Noise Riser', 'riser', { bpm: 128, bars: 4, tags: ['big'] }),
  sample('factory:drums/808.wav', 'Long 808', '808', { rootNote: 36, genres: ['trap'] }),
  sample('factory:drums/kick-b.wav', 'Kick 10', 'kick'),
  sample('factory:drums/kick-a.wav', 'Kick 2', 'kick', { tags: ['punchy'] }),
  sample('factory:fx/rev-1.wav', 'Reverse Cymbal', 'reverse-cymbal', { bars: 1 }),
];

test('factory samples: folders by kind in SAMPLE_KINDS order, natural name order, labels', () => {
  const g = groupFactorySamples(SAMPLES);
  assert.deepEqual(
    g.map((x) => x.kind),
    ['kick', '808', 'riser', 'reverse-cymbal'],
  );
  assert.deepEqual(
    g[0].samples.map((s) => s.name),
    ['Kick 2', 'Kick 10'],
  );
  assert.deepEqual(
    g.map((x) => x.label),
    ['Kicks', '808s', 'Risers', 'Reverse cymbals'],
  );
  assert.deepEqual(
    groupFactorySamples(SAMPLES, 'trap').flatMap((x) => x.samples.map((s) => s.name)),
    ['Long 808'],
    'search covers genres',
  );
  assert.deepEqual(
    groupFactorySamples(SAMPLES, 'punchy kick').flatMap((x) => x.samples.map((s) => s.name)),
    ['Kick 2'],
  );
});

test('factory samples: root note for tonal sounds (C4 = MIDI 60), bars for synced FX', () => {
  assert.equal(sampleDetail({ rootNote: 36 }), 'C2');
  assert.equal(sampleDetail({ rootNote: 60 }), 'C4', 'MIDI 60 shows as C4, like the Piano Roll and the root-key knob');
  assert.equal(sampleDetail({ bars: 4 }), '4 bars');
  assert.equal(sampleDetail({ bars: 1 }), '1 bar');
  assert.equal(sampleDetail({ rootNote: 45, bars: 2 }), 'A2 · 2 bars');
  assert.equal(sampleDetail({}), '');
});

// ── Save dialogs ──────────────────────────────────────────────────────

test('save: tags are parsed lower-case and unique; names are validated', () => {
  assert.deepEqual(parseTagList('dark, Wide ,, pluck,dark;  big   room '), ['dark', 'wide', 'pluck', 'big room']);
  assert.deepEqual(parseTagList(''), []);
  assert.equal(parseTagList(Array.from({ length: 40 }, (_, i) => `t${i}`).join(',')).length, 24);
  assert.equal(parseTagList('x'.repeat(50))[0].length, 32);
  assert.equal(validatePresetName('  '), 'The preset needs a name');
  assert.equal(validatePresetName('x'.repeat(65)), 'At most 64 characters');
  assert.equal(validatePresetName('Night Pluck'), null);
});

test('save: defaults come from the loaded preset (a factory one gets "My …"), else from the channel name', () => {
  const f = presetSaveDefaults('Lead 2', { id: 'factory:lead/anthem', name: 'Anthem Supersaw', role: 'lead', tags: ['wide'], genres: ['edm'], description: 'Big.' });
  assert.deepEqual(f, { name: 'My Anthem Supersaw', role: 'lead', tags: ['wide'], genres: ['edm'], description: 'Big.' });
  assert.equal(presetSaveDefaults('x', { id: 'user:mine', name: 'Mine', role: 'pad', tags: [], genres: [], description: '' }).name, 'Mine');
  assert.deepEqual(presetSaveDefaults('Sub 808', null), { name: 'Sub 808', role: '808', tags: [], genres: [], description: '' });
  assert.equal(presetSaveDefaults('Channel 7').role, 'lead', 'unknown names default to lead');
});

test('save chain: the role is guessed from the insert name', () => {
  assert.equal(guessChainRole('Anything', true), 'master');
  assert.equal(guessChainRole('Drum Bus', false), 'drumBus');
  assert.equal(guessChainRole('Drums', false), 'drumBus');
  assert.equal(guessChainRole('Kick', false), 'drums');
  assert.equal(guessChainRole('808', false), 'bass');
  assert.equal(guessChainRole('Reverb', false), 'reverbSend');
  assert.equal(guessChainRole('Echo', false), 'delaySend');
  assert.equal(guessChainRole('Lead Vox', false), 'vocal');
  assert.equal(guessChainRole('Supersaw Lead', false), 'lead');
  assert.equal(guessChainRole('Insert 3', false), 'character');
});

// ── Home ▸ Sounds + Browser roots ─────────────────────────────────────

test('counts: presets by source and kind, factory samples', () => {
  assert.deepEqual(soundsCounts(PRESETS, SAMPLES), { factoryPresets: 10, userPresets: 2, instrumentPresets: 8, chainPresets: 4, factorySamples: 5 });
  assert.equal(soundsCounts([], null).factorySamples, 0);
});

test('Add to Browser: appends once; the same folder in another case or with slashes is already there', () => {
  const roots = [{ id: 'r1', name: 'Samples', path: 'C:\\Users\\you\\Documents\\Samples' }];
  const a = withBrowserRoot(roots, 'D:\\Packs\\Vol 2\\', 'r2');
  assert.equal(a.added, true);
  assert.equal(a.name, 'Vol 2');
  assert.deepEqual(a.roots[1], { id: 'r2', name: 'Vol 2', path: 'D:\\Packs\\Vol 2\\' });
  assert.equal(roots.length, 1, 'input not mutated');
  const b = withBrowserRoot(roots, 'c:/users/YOU/documents/samples/', 'r3');
  assert.equal(b.added, false);
  assert.equal(b.name, 'Samples');
  assert.equal(b.roots.length, 1);
  assert.equal(folderName('C:\\a\\b\\'), 'b');
  assert.equal(folderName('D:'), 'D:');
});

// ── Against the shipped factory data ─────────────────────────────────

test('factory presets: every one lands in a labelled group and drags as a valid payload', () => {
  const summaries = FACTORY_PRESETS.map(summarizePreset);
  for (const kind of ['instrument', 'chain'] as const) {
    const grouped = groupPresets(summaries, { kind }).flatMap((g) => g.presets);
    assert.equal(grouped.length, summaries.filter((p) => p.kind === kind).length, `${kind}: every preset is listed`);
  }
  for (const p of summaries) {
    assert.ok(roleLabel(p.role, p.kind), `${p.id}: label`);
    assert.deepEqual(decodePresetDrag(encodePresetDrag(p))?.id, p.id, `${p.id}: drag payload`);
  }
});

void run('sounds-ui');
