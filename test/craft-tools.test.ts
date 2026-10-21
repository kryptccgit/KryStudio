// Craft tools (research/10-sound-and-craft.md): get_playbook with a fixture
// playbook / presets / factory index (sound resolution, absolute start bars,
// transitions per boundary, the library-focus merge, genre resolution);
// add_transition through callTool with a fake factory index (tempo-synced FX
// that end exactly on the boundary, impacts that start on it, the snare roll
// pattern, the filter-sweep automation, silence, fallbacks without a kit, one
// undo group per call); review_song end to end (read-only, ranked issues).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { getParamValue } from '@shared/schema/params';
import { resolveGenre } from '@shared/sounds/genres';
import type { Analysis } from '@shared/engine/protocol';
import type { Playbook } from '@shared/playbooks/types';
import type { ChainPreset, FactoryIndex, FactorySample, InstrumentPreset, Preset } from '@shared/sounds/types';
import type { StyleProfile } from '@shared/library/types';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, getTool, type RunCtx, type ToolCaller } from '../electron/mcp/tools';
import { craftTools, snareRollNotes, type PlaybookRegistry } from '../electron/mcp/tools/craft';
import { briefNumbers, buildRecipe, chooseGenre, focusNumbers, genericPlaybook } from '../electron/mcp/tools/craftRecipe';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-craft-tools-'));
const BAR = 3840;

// ── Fixtures ────────────────────────────────────────────────────────────

const PB: Playbook = {
  id: 'edm',
  name: 'EDM',
  summary: 'Festival drops (fixture).',
  bpm: { min: 124, max: 128, typical: 126 },
  swing: 0,
  keys: { modes: ['minor'], common: ['Fm', 'Am'] },
  harmony: { progressions: ['i VI III VII'], rhythm: 'one chord per bar', voicing: 'wide saws' },
  melody: 'a short hook',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', writing: 'four on the floor', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', writing: 'on 2 and 4', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', writing: 'offbeat 8ths', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['dark'], writing: 'offbeat roots', duckUnder: 'Kick', chain: 'bass' },
    { name: 'Supersaw', role: 'chord', tags: ['wide'], writing: 'big chords', duckUnder: 'Kick' },
  ],
  patterns: [{ name: 'Drop Drums', for: ['drop'], kpn: 'kick: x... x... x... x...\nclap: .... x... .... x...' }],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 16, energy: 0.3, parts: ['Kick', 'Hat'] },
    { kind: 'build', label: 'Build', bars: 8, energy: 0.6, parts: ['Clap', 'Hat', 'Supersaw'], transitionIn: ['filter-sweep'] },
    { kind: 'drop', label: 'Drop', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'Bass', 'Supersaw'], transitionIn: ['riser', 'impact'] },
    { kind: 'break', label: 'Break', bars: 8, energy: 0.4, parts: ['Supersaw'], transitionIn: ['downlifter'] },
    { kind: 'drop', label: 'Drop', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'Bass', 'Supersaw'], transitionIn: ['riser', 'snare-roll', 'impact'] },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.3, parts: ['Kick', 'Hat'], transitionIn: ['crash'] },
  ],
  mix: {
    master: { tags: ['loud'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus' }],
    sends: [{ name: 'Reverb', chain: 'reverbSend', from: [{ part: 'Supersaw', amount: 0.25 }] }],
    levels: 'kick and bass loudest',
  },
  transitions: 'A riser into every drop.',
  mistakes: ['The same 8 bars everywhere'],
  targets: { lufs: -8, truePeakDb: -1, bars: [64, 128], bands: { sub: [-2, 6] }, contrastLu: [4, 10], minCorrelation: 0.2, maxStaticBars: 8, minHatVelocitySpread: 8 },
};

const inst = (id: string, role: InstrumentPreset['role'], tags: string[], genres: InstrumentPreset['genres'], plugin = 'krypt.triosc'): InstrumentPreset => ({ kind: 'instrument', id, name: id.split('/').pop()!, plugin, params: {}, role, tags, genres, description: 'fixture' });
const chain = (id: string, role: ChainPreset['role'], tags: string[], genres: ChainPreset['genres'], targetLufs?: number): ChainPreset => ({ kind: 'chain', id, name: id.split('/').pop()!, role, fx: [{ type: 'krypt.limiter', params: {} }], tags, genres, description: 'fixture', ...(targetLufs !== undefined ? { targetLufs } : {}) });

const PRESETS: Preset[] = [
  inst('factory:bass/soft-sub', 'bass', ['warm'], ['lofi']),
  inst('factory:bass/dark-reese', 'bass', ['dark'], ['edm']),
  inst('factory:chord/anthem-supersaw', 'chord', ['wide'], ['edm']),
  inst('factory:chord/felt-keys', 'chord', ['soft'], ['lofi']),
  inst('factory:keys/warm-ep', 'keys', ['warm'], []),
  inst('factory:lead/bright-saw', 'lead', ['bright'], ['edm']),
  chain('factory:chain/master/club-loud', 'master', ['loud'], ['edm'], -8),
  chain('factory:chain/master/gentle', 'master', ['soft'], ['lofi'], -12),
  chain('factory:chain/drumbus/glue', 'drumBus', [], ['edm']),
  chain('factory:chain/send/plate', 'reverbSend', [], []),
  chain('factory:chain/bass/reese-grit', 'bass', [], ['edm']),
];

const smp = (p: string, kind: FactorySample['kind'], genres: FactorySample['genres'], lengthSec: number, extra: Partial<FactorySample> = {}): FactorySample => ({ path: p, name: p.split('/').pop()!.replace(/\.wav$/, ''), kind, tags: [], genres, lengthSec, channels: 2, peakDb: -1, ...extra });

const INDEX: FactoryIndex = {
  version: 1,
  generator: 'fixture',
  samples: [
    smp('factory:drums/kick-soft.wav', 'kick', ['lofi'], 0.5),
    smp('factory:drums/kick-punchy.wav', 'kick', ['edm'], 0.5),
    smp('factory:drums/clap-big.wav', 'clap', ['edm'], 0.5),
    smp('factory:drums/hat-tight.wav', 'hat', [], 0.2),
    smp('factory:drums/snare-crack.wav', 'snare', ['edm'], 0.4),
    smp('factory:fx/riser-4.wav', 'riser', ['edm'], 7.5, { bpm: 128, bars: 4 }),
    smp('factory:fx/riser-8.wav', 'riser', ['edm'], 15, { bpm: 128, bars: 8 }),
    smp('factory:fx/impact.wav', 'impact', ['edm'], 2),
    smp('factory:fx/revcym-1.wav', 'reverse-cymbal', [], 1.875, { bpm: 128, bars: 1 }),
  ],
};

// The factory files exist (get_playbook only recommends installed samples, like load_sample / write_pattern).
for (const s of INDEX.samples) {
  const f = path.join(TMP, 'factory', s.path.slice('factory:'.length));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'RIFF');
}

const PROFILE = {
  collectionId: 'c1',
  name: 'Club refs',
  tracks: 12,
  analysed: 12,
  deep: 0,
  updatedAt: 0,
  tempo: { bpm: { p10: 60, p25: 62, median: 64, p75: 66, p90: 68 }, histogram: [], halfTimeShare: 0.6 },
  swing: { median: 0.04, share: 0.1 },
  keys: { top: [{ key: 'Gm', count: 5 }], minorShare: 0.9 },
  drums: null,
  bass: null,
  harmony: { progressions: [{ degrees: ['i', 'iv', 'VI', 'V'], count: 3 }], changesPerBar: 1, tracks: 8 },
  structure: { sectionBars: { p10: 8, p25: 8, median: 8, p75: 16, p90: 16 }, forms: [{ form: ['A', 'B', 'A', 'B'], count: 2 }], energyShape: [], lengthSec: { p10: 150, p25: 170, median: 190, p75: 210, p90: 230 } },
  mix: { lufs: { p10: -9, p25: -8, median: -7.5, p75: -7, p90: -6.5 }, truePeakDb: { p10: -1, p25: -1, median: -0.8, p75: -0.5, p90: -0.3 }, width: { p10: 0.3, p25: 0.35, median: 0.4, p75: 0.45, p90: 0.5 }, bands: { sub: -10, low: -6, lowMid: -9, mid: -10, highMid: -14, high: -20 } },
  examples: { drums: null, bass: null },
  caveats: [],
} as unknown as StyleProfile;

const REGISTRY: PlaybookRegistry = { playbookFor: (g) => (resolveGenre(g) === 'edm' ? PB : null), list: () => [PB] };

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

const ANALYSIS: Analysis = {
  durationSec: 120,
  peakDb: -1.2,
  truePeakDb: -1.1,
  lufsIntegrated: -8.4,
  lufsShortTermMax: -7,
  loudnessRange: 6,
  rmsDb: -11,
  crestDb: 9,
  bands: { sub: -12, low: -10, lowMid: -16, mid: -15, highMid: -19, high: -25 },
  stereoCorrelation: 0.5,
  stereoWidth: 0.4,
  energyCurve: Array.from({ length: 120 }, () => -9),
  clipping: false,
  estimatedBpm: 126,
  spectralCentroidHz: 1800,
};

function makeDeps(opts: { index?: FactoryIndex | null; focus?: { name: string; brief: string } | null; analysis?: Analysis } = {}) {
  const doc = new DocHost(createDefaultProject('Craft'), CATALOG, { strict: true });
  let settings = structuredClone(SETTINGS);
  const renders: unknown[] = [];
  const analysis = { current: opts.analysis ?? ANALYSIS };
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
      async render(job) {
        renders.push(job);
        return { ok: true, data: { path: job.path, files: [job.path], durationSec: analysis.current.durationSec, peakDb: analysis.current.peakDb, lufsIntegrated: analysis.current.lufsIntegrated, analysis: analysis.current } };
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
      status: () => ({ path: null, name: 'Craft', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => (p.startsWith('factory:') ? path.join(TMP, 'factory', p.slice('factory:'.length)) : p),
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [],
    },
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    broadcast: () => {},
    userDataDir: path.join(TMP, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  if (opts.index !== null) {
    const index = opts.index ?? INDEX;
    deps.sounds = { presets: () => PRESETS, preset: (id) => PRESETS.find((x) => x.id === id), factoryIndex: () => index, saveUser: () => ({ ok: false, message: 'n/a' }), deleteUser: () => ({ ok: false, message: 'n/a' }) };
  }
  if (opts.focus) {
    const f = { collectionId: 'c1', name: opts.focus.name, brief: opts.focus.brief };
    deps.library = {
      focus: () => f,
      profileText: async () => ({ ok: true, data: { text: 'profile', collection: { id: 'c1', name: f.name }, profile: PROFILE } }),
    } as unknown as MainDeps['library'];
  }
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'craft-test', name: 'Craft Test' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { deps, doc, caller, call, renders, analysis };
}

const READ_CTX: RunCtx = {
  groupId: '',
  exec: () => {
    throw new Error('read-only');
  },
  execBatch: () => {
    throw new Error('read-only');
  },
  tryExec: () => {
    throw new Error('read-only');
  },
};

/** get_playbook over the fixture registry (the real one is filled by the playbooks agent). */
async function playbook(deps: MainDeps, caller: ToolCaller, args: Record<string, unknown>) {
  const def = craftTools(REGISTRY).find((t) => t.name === 'get_playbook')!;
  return def.run(deps, caller, def.input.parse(args) as never, READ_CTX);
}

// ── get_playbook ────────────────────────────────────────────────────────

test('get_playbook: sounds resolved by role + genre, absolute start bars, transitions per boundary, exact build order', async () => {
  const { deps, caller } = makeDeps();
  const r = await playbook(deps, caller, { genre: 'big room' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Playbook for EDM \(as asked\): 126 bpm in Fm/);
  const d = r.data as { bpm: number; key: string; parts: Array<{ name: string; sound: { kind: string; ref: string } }>; sections: Array<{ name: string; start: number; end: number }>; transitions: Array<{ kind: string; at_bars: number[]; length_bars?: number }>; master: { id: string }; groove: { template: string } | null; totalBars: number };
  assert.deepEqual(d.parts.map((p) => [p.name, p.sound.kind, p.sound.ref]), [
    ['Kick', 'sample', 'factory:drums/kick-punchy.wav'],
    ['Clap', 'sample', 'factory:drums/clap-big.wav'],
    ['Hat', 'sample', 'factory:drums/hat-tight.wav'],
    ['Bass', 'preset', 'factory:bass/dark-reese'],
    ['Supersaw', 'preset', 'factory:chord/anthem-supersaw'],
  ]);
  assert.deepEqual(d.sections.map((s) => [s.name, s.start, s.end]), [['Intro', 1, 16], ['Build', 17, 24], ['Drop', 25, 40], ['Break', 41, 48], ['Drop 2', 49, 64], ['Outro', 65, 72]]);
  assert.equal(d.totalBars, 72);
  assert.deepEqual(d.transitions, [
    { kind: 'filter-sweep', at_bars: [17], length_bars: 8 },
    { kind: 'riser', at_bars: [25, 49], length_bars: 8 },
    { kind: 'impact', at_bars: [25, 49] },
    { kind: 'downlifter', at_bars: [41] },
    { kind: 'snare-roll', at_bars: [49], length_bars: 4 },
    { kind: 'crash', at_bars: [65] },
  ]);
  assert.equal(d.master.id, 'factory:chain/master/club-loud');
  assert.equal(d.groove?.template, 'dance');
  const text = r.text!;
  for (const s of [
    'BUILD ORDER',
    'begin_edit {"label":"EDM song"}',
    'set_tempo {"bpm":126}',
    'load_sample {"channel":"Kick","sample":"factory:drums/kick-punchy.wav"}', // Kick exists in the default kit
    'load_preset {"preset":"factory:bass/dark-reese","name":"Bass"}', // Bass doesn't: a new channel
    'apply_chain {"chain":"factory:chain/bass/reese-grit","insert":"Bass"}',
    '"op":"groove","template":"dance"',
    'arrange {"placements":[{"pattern":"Intro","bars":"1-16"},{"pattern":"Build","bars":"17-24"},{"pattern":"Drop","bars":"25-40"}',
    'add_marker {"markers":[{"at":1,"name":"Intro"}',
    'add_transition {"kind":"riser","at_bars":[25,49],"length_bars":8}',
    'apply_chain {"chain":"factory:chain/drumbus/glue","insert":"new:Drum Bus"}', // buses are created with the playbook's name
    'route {"from_insert":"Kick","to":"Drum Bus"}',
    'route {"from_insert":"Supersaw","to":"Reverb","level_db":-12,"exclusive":false}',
    'apply_chain {"chain":"factory:chain/master/club-loud","insert":"master"}',
    'sidechain {"source":"Kick","target":"Bass"}',
    'review_song {"genre":"edm"}',
    'create_pattern {"name":"Drop 2","clone_from":"Drop"}',
    'kick: x... x... x... x...',
    'TARGETS (review_song measures these): -8 LUFS integrated',
    'MISTAKES',
  ])
    assert.ok(text.includes(s), `missing: ${s}\n${text}`);
  assert.ok(text.indexOf('Groove, after the notes are written') > text.indexOf('Patterns: one pattern per section'), 'groove comes after the patterns are written');
  assert.ok(text.indexOf('review_song {"genre"') > text.indexOf('add_transition {'), 'review after the transitions');
  assert.ok(text.indexOf('add_transition {') > text.indexOf('arrange {'), 'transitions after the arrangement');
});

test('get_playbook: genre from the argument, the project, the brief, then the library focus; generic recipe otherwise', async () => {
  assert.deepEqual(chooseGenre({ arg: 'UK Drill', projectGenre: 'edm' }), { id: 'drill', source: 'argument', unknown: null });
  assert.deepEqual(chooseGenre({ projectGenre: 'Big Room', brief: 'lofi please' }), { id: 'edm', source: 'project', unknown: null });
  assert.deepEqual(chooseGenre({ projectGenre: 'my stuff', brief: 'a dark uk drill beat' }), { id: 'drill', source: 'brief', unknown: null });
  assert.deepEqual(chooseGenre({ focusText: 'Trap bangers dark' }), { id: 'trap', source: 'focus', unknown: null });
  assert.deepEqual(chooseGenre({ arg: 'polka' }), { id: null, source: 'argument', unknown: 'polka' });

  const { deps, caller, doc } = makeDeps();
  doc.exec('project.setMeta', { genre: 'Big Room' }, { actor: { kind: 'user' } });
  const fromProject = await playbook(deps, caller, {});
  assert.match(fromProject.message, /Playbook for EDM \(from the project's genre\)/);
  const drill = await playbook(deps, caller, { brief: 'a dark uk drill beat' });
  assert.equal(drill.ok, true);
  assert.match(drill.message, /^Playbook for EDM/, 'the project genre comes before the brief');
  doc.exec('project.setMeta', { genre: '' }, { actor: { kind: 'user' } });
  const generic = await playbook(deps, caller, { brief: 'a dark uk drill beat' });
  assert.match(generic.message, /No playbook for Drill yet: here is a generic finished-song recipe/);
  assert.match(generic.message, /Playbooks: edm\./);
  assert.match(generic.text!, /BUILD ORDER/);
  assert.match(generic.text!, /"op":"groove","template":"hiphop"/, 'the genre default groove');
  const unknown = await playbook(deps, caller, { genre: 'polka' });
  assert.match(unknown.message, /"polka" isn't a genre Krypt Studio knows/);
  const none = await playbook(deps, caller, {});
  assert.match(none.message, /No genre given/);

  // The real registry (empty until the playbooks land, full after): never an error.
  const real = await makeDeps().call('get_playbook', { genre: 'edm' });
  assert.equal(real.ok, true, real.message);
  assert.match(real.text ?? '', /BUILD ORDER/);
  assert.equal(getTool('get_playbook')?.kind, 'read');
});

test('get_playbook: a library style focus overrides tempo (octave reading), key, swing, loudness; its progressions and structure are listed', async () => {
  const n = focusNumbers('Club refs', PROFILE)!;
  assert.deepEqual([n.bpm, n.swingPercent, n.keys, n.progressions, n.sectionBars, n.forms, n.lufs], [64, 0, ['Gm'], ['i iv VI V'], 8, ['A B A B'], -7.5]);
  const { deps, caller } = makeDeps({ focus: { name: 'Club refs', brief: 'edm festival' } });
  const r = await playbook(deps, caller, {});
  assert.match(r.message, /Playbook for EDM \(from the library focus\): 128 bpm in Gm/);
  assert.match(r.message, /your references \("Club refs"\) overriding the numbers/);
  const d = r.data as { bpm: number; key: string; targets: { lufs: number } };
  assert.deepEqual([d.bpm, d.key, d.targets.lufs], [128, 'Gm', -7.5]);
  assert.match(r.text!, /YOUR REFERENCES SAY \(style focus "Club refs", 12 analysed songs\)/);
  assert.match(r.text!, /progressions "i iv VI V"; sections of about 8 bars; form "A B A B"; loudness -7.5 LUFS/);
  assert.ok(r.text!.includes('Tempo 128 bpm (your references: median 64, read at 128 for this genre)'), r.text);
  // The user's words beat the references.
  const brief = await playbook(deps, caller, { brief: 'edm at 140 bpm in F# minor' });
  assert.deepEqual([(brief.data as { bpm: number }).bpm, (brief.data as { key: string }).key], [140, 'F# minor']);
  assert.deepEqual(briefNumbers('trap 150 bpm, F#m vibes'), { bpm: 150, key: 'F#m' });
  assert.deepEqual(briefNumbers('in a dark mood'), { bpm: null, key: null });
});

test('get_playbook: without presets or a factory index the recipe still resolves (legacy kit) and says so', () => {
  const rec = buildRecipe(PB, { genre: 'edm', source: 'argument', presets: [], samples: null, channels: [], projectBpm: 140, projectSwing: 0 });
  assert.equal(rec.parts[0].sound.ref, 'factory:drums/kick.wav');
  assert.equal(rec.parts[3].sound.kind, 'none');
  assert.match(rec.text, /no factory sound for role bass yet/);
  assert.match(rec.text, /no master chain preset installed/);
  const g = genericPlaybook(null);
  assert.ok(g.arrangement.length >= 6 && g.parts.length >= 6);
});

test('get_playbook: the playbook\'s own groove (template, amounts, parts) goes into the build order after the patterns', () => {
  const pb = { ...PB, groove: { template: 'hiphop', amount: 0.25, velocity: 0.4, parts: ['Hat'] } } as Playbook;
  const rec = buildRecipe(pb, { genre: 'edm', source: 'argument', presets: PRESETS, samples: INDEX.samples, channels: ['Hat'], projectBpm: 126, projectSwing: 0 });
  assert.deepEqual(rec.groove, { template: 'hiphop', amount: 0.25, velocity: 0.4, melodic: false, parts: ['Hat'], source: 'playbook' });
  assert.ok(rec.text.includes('transform_notes {"pattern":"Intro","channel":"Hat","ops":[{"op":"groove","template":"hiphop","amount":0.25,"velocity":0.4}]}'), rec.text);
  assert.match(rec.text, /the same op for Hat in every section pattern \(only these: the rest stays on the grid\)/);
  assert.match(rec.text, /Groove: transform_notes op "groove", template "hiphop" \(amount 0.25, velocity 0.4\) on Hat/);
  // An unknown template is ignored (the genre default applies).
  const odd = buildRecipe({ ...PB, groove: { template: 'polka', amount: 1, velocity: 1, parts: [] } } as Playbook, { genre: 'edm', source: 'argument', presets: [], samples: null, channels: [], projectBpm: 126, projectSwing: 0 });
  assert.equal(odd.groove?.template, 'dance');
});

// ── add_transition ──────────────────────────────────────────────────────

function fxClips(doc: DocHost) {
  const p = doc.project;
  return Object.values(p.playlist.clips)
    .filter((c) => /^FX/.test(p.playlist.tracks[c.trackId]?.name ?? ''))
    .sort((a, b) => a.start - b.start);
}

test('add_transition riser: tempo-synced FX end exactly on each boundary, on an "FX" lane through one "FX" insert, one undo step', async () => {
  const { doc, call } = makeDeps();
  const before = doc.getHistory().length;
  const r = await call('add_transition', { at_bars: [17, 33], kind: 'riser', length_bars: 4 });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Added riser at 2 boundaries \(bars 17, 33\)/);
  assert.equal(doc.getHistory().length, before + 1, 'one call = one undo step');
  const clips = fxClips(doc);
  assert.deepEqual(clips.map((c) => [c.kind, c.start, c.start + c.length]), [
    ['audio', 12 * BAR, 16 * BAR],
    ['audio', 28 * BAR, 32 * BAR],
  ]);
  const p = doc.project;
  const ch = p.channels[clips[0].channelId!];
  assert.equal(ch.generator.type, 'krypt.audioclip');
  assert.deepEqual([ch.generator.params.tempo_sync, ch.generator.params.src_bpm], [1, 128]);
  assert.equal(p.samples[ch.generator.sampleId!].path, 'factory:fx/riser-4.wav');
  assert.equal(clips[1].channelId, ch.id, 'the same channel is reused');
  assert.equal(p.mixer.inserts[ch.insertId].name, 'FX');
  assert.equal(p.playlist.tracks[clips[0].trackId].name, 'FX');

  // An impact STARTS on the downbeat (one-shot at the project tempo), through the same FX insert.
  const imp = await call('add_transition', { at_bars: [17], kind: 'impact' });
  assert.equal(imp.ok, true, imp.message);
  const p2 = doc.project;
  const impact = fxClips(doc).find((c) => p2.samples[p2.channels[c.channelId!].generator.sampleId!].path === 'factory:fx/impact.wav')!;
  assert.equal(impact.start, 16 * BAR);
  assert.equal(impact.length, Math.round(2 * (140 / 60) * 960));
  assert.equal(p2.channels[impact.channelId!].insertId, ch.insertId);
  assert.equal(p2.mixer.insertOrder.filter((id) => p2.mixer.inserts[id].name === 'FX').length, 1, 'one FX insert');

  // 8 bars picks the 8-bar riser; a length between the samples stretches one to exactly that many bars.
  const r8 = await call('add_transition', { at_bars: [49], kind: 'riser', length_bars: 8 });
  assert.equal(r8.ok, true, r8.message);
  const long = fxClips(doc).find((c) => c.start === 40 * BAR)!;
  assert.equal(long.length, 8 * BAR);
  const r6 = await call('add_transition', { at_bars: [65], kind: 'riser', length_bars: 6 });
  assert.equal(r6.ok, true, r6.message);
  const six = fxClips(doc).find((c) => c.start + c.length === 64 * BAR)!;
  assert.equal(six.length, 6 * BAR);
  assert.match(r6.message, /stretched to 6 bars/);

  // The same call again changes nothing: reported, never a fake success.
  const again = await call('add_transition', { at_bars: [17, 33], kind: 'riser', length_bars: 4 });
  assert.equal(again.ok, false);
  assert.match(again.message, /No change/);

  // undo_last reverts the whole call.
  const undo = await call('undo_last', {});
  assert.equal(undo.ok, true, undo.message);
  assert.equal(fxClips(doc).filter((c) => c.start + c.length === 64 * BAR).length, 0);
});

test('add_transition snare-roll: 8ths → 16ths → 32nds with a rising velocity, in the bars before the boundary', async () => {
  const notes = snareRollNotes(2, BAR, 60);
  assert.equal(notes.length, 8 + 8 + 16);
  assert.deepEqual(notes.slice(0, 2).map((n) => n.tick), [0, 480]);
  assert.deepEqual(notes.slice(8, 10).map((n) => n.tick), [BAR, BAR + 240]);
  assert.deepEqual(notes.slice(16, 18).map((n) => n.tick), [1.5 * BAR, 1.5 * BAR + 120]);
  for (let i = 1; i < notes.length; i++) assert.ok(notes[i].vel > notes[i - 1].vel, 'velocity ramps up');

  const { doc, call } = makeDeps();
  const r = await call('add_transition', { at_bars: [17, 49], kind: 'snare-roll' });
  assert.equal(r.ok, true, r.message);
  const p = doc.project;
  const pat = Object.values(p.patterns).find((x) => x.name === 'Snare Roll')!;
  assert.ok(pat, 'a "Snare Roll" pattern');
  const snare = p.channelOrder.find((id) => p.channels[id].name === 'Snare')!;
  assert.equal(Object.keys(pat.notes[snare]).length, 32);
  assert.equal(pat.length, 2 * BAR);
  const clips = Object.values(p.playlist.clips).filter((c) => c.patternId === pat.id).sort((a, b) => a.start - b.start);
  assert.deepEqual(clips.map((c) => [c.start, c.length]), [[14 * BAR, 2 * BAR], [46 * BAR, 2 * BAR]]);
  assert.notEqual(p.transport.activePatternId, pat.id, 'the active pattern stays');
  // A second roll of the same length reuses the pattern.
  const r2 = await call('add_transition', { at_bars: [33], kind: 'snare-roll' });
  assert.equal(r2.ok, true);
  assert.equal(Object.values(doc.project.patterns).filter((x) => x.name.startsWith('Snare Roll')).length, 1);
});

test('add_transition filter-sweep and silence: automation that rises into the boundary and resets on it', async () => {
  const { doc, call } = makeDeps();
  const r = await call('add_transition', { at_bars: [17], kind: 'filter-sweep', length_bars: 4 });
  assert.equal(r.ok, true, r.message);
  let p = doc.project;
  const master = p.mixer.inserts[p.mixer.masterId];
  const slot = master.slots[master.slotOrder[0]];
  assert.equal(slot.type, 'krypt.filter');
  assert.equal(slot.params.type, 3, 'HP 24');
  const aut = Object.values(p.automations)[0];
  assert.equal(aut.target, `insert/${master.id}/slot/${slot.id}/cutoff`);
  const pts = Object.values(aut.points).sort((a, b) => a.tick - b.tick);
  assert.equal(pts.length, 3);
  assert.ok(pts[1].value > pts[0].value + 0.2, 'rises');
  assert.equal(pts[2].value, pts[0].value, 'resets on the downbeat');
  const clip = Object.values(p.playlist.clips).find((c) => c.automationId === aut.id)!;
  assert.deepEqual([clip.start, clip.start + clip.length], [12 * BAR, 16 * BAR]);
  assert.equal(getParamValue(p, CATALOG, aut.target!), 20, 'the knob stays open (transparent) outside the sweep');

  const s = await call('add_transition', { at_bars: [25], kind: 'silence' });
  assert.equal(s.ok, true, s.message);
  p = doc.project;
  const dip = Object.values(p.automations).find((x) => x.target === `insert/${p.mixer.masterId}/volume`)!;
  const dclip = Object.values(p.playlist.clips).find((c) => c.automationId === dip.id)!;
  assert.deepEqual([dclip.start, dclip.length], [24 * BAR - 960, 960]);
  const dp = Object.values(dip.points).sort((a, b) => a.tick - b.tick);
  assert.equal(dp[1].value, 0);
  assert.equal(dp[dp.length - 1].value, dp[0].value, 'the level comes back on the downbeat');
});

test('add_transition without a factory kit: a clear sentence plus the fallback (filter sweep, reversed crash, fill pattern), else a refusal', async () => {
  const { doc, call } = makeDeps({ index: null });
  const riser = await call('add_transition', { at_bars: [17], kind: 'riser', length_bars: 8 });
  assert.equal(riser.ok, true, riser.message);
  assert.match(riser.message, /factory sample kit isn't installed .*Used a filter sweep instead/);
  assert.equal(Object.values(doc.project.automations).length, 1);

  const rev = await call('add_transition', { at_bars: [33], kind: 'reverse-cymbal' });
  assert.equal(rev.ok, true, rev.message);
  assert.match(rev.message, /Used a reversed crash/);
  const p = doc.project;
  const ch = Object.values(p.channels).find((c) => c.generator.type === 'krypt.audioclip')!;
  assert.equal(p.samples[ch.generator.sampleId!].path, 'factory:drums/crash.wav');
  assert.equal(ch.generator.params.reverse, 1);
  const clip = Object.values(p.playlist.clips).find((c) => c.channelId === ch.id)!;
  assert.equal(clip.start + clip.length, 32 * BAR, 'the reversed crash swells INTO the downbeat');

  const fill = await call('add_transition', { at_bars: [41], kind: 'drum-fill' });
  assert.equal(fill.ok, true, fill.message);
  assert.ok(Object.values(doc.project.patterns).some((x) => x.name === 'Drum Fill'));

  const down = await call('add_transition', { at_bars: [41], kind: 'downlifter' });
  assert.equal(down.ok, false);
  assert.match(down.message, /No downlifter sample: the factory sample kit isn't installed/);
  const early = await call('add_transition', { at_bars: [1], kind: 'snare-roll' });
  assert.equal(early.ok, false);
  assert.match(early.message, /needs 2 bars before it/);
});

// ── review_song ─────────────────────────────────────────────────────────

test('review_song: renders the song, returns a score and ranked issues with tool-call fixes, and never modifies the project', async () => {
  const { doc, call, renders } = makeDeps();
  const empty = await call('review_song', {});
  assert.equal(empty.ok, false);
  assert.match(empty.message, /Nothing is arranged yet/);

  const w = await call('write_pattern', { kpn: 'pattern "Loop" bars=1\nkick: x... x... x... x...\nhat: x.x. x.x. x.x. x.x.\nKeys: C4:4 E4:4 G4:4 C5:4' });
  assert.equal(w.ok, true, w.message);
  const a = await call('arrange', { placements: [{ pattern: 'Loop', bars: '1-24' }] });
  assert.equal(a.ok, true, a.message);
  const before = doc.project;
  const hist = doc.getHistory().length;
  const r = await call('review_song', { genre: 'edm' });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.project, before, 'read-only');
  assert.equal(doc.getHistory().length, hist);
  assert.equal(renders.length, 1);
  const d = r.data as { score: number; issues: Array<{ check: string; severity: string; fix: string }>; works: string[] };
  assert.ok(d.score >= 0 && d.score < 100);
  assert.ok(d.issues.length >= 1 && d.issues.length <= 10);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  for (let i = 1; i < d.issues.length; i++) assert.ok(rank[d.issues[i - 1].severity as keyof typeof rank] <= rank[d.issues[i].severity as keyof typeof rank], 'ranked by severity');
  assert.ok(d.issues.some((x) => x.check === 'static'), 'a 1-bar loop for 24 bars is static');
  assert.ok(d.issues.some((x) => x.check === 'presets' && /load_preset|find_presets/.test(x.fix)), 'Keys is a bare default synth');
  assert.ok(d.works.length >= 2 && d.works.length <= 4);
  assert.match(r.text!, /score \d+\/100/);
  assert.match(r.text!, /ISSUES \(\d+ found/);
  assert.match(r.text!, /WHAT WORKS:/);
  assert.match(r.text!, /review_song again/);
  const bad = await call('review_song', { scope: 'chorus' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /must be "song" or a bar range/);
  const bars = await call('review_song', { scope: '9-16' });
  assert.equal(bars.ok, true, bars.message);
  assert.match(bars.message, /bars 9-16/);
});

await run('craft-tools');
fs.rmSync(TMP, { recursive: true, force: true });
