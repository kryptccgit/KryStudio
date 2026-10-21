import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { ActionResult } from '@shared/types';
import type { FactoryIndex, FactorySample, InstrumentPreset, SampleKind } from '@shared/sounds/types';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import type { FingerprintEntry, FingerprintIndex, SoundFingerprint } from '@shared/sound-match/types';
import { PROFILES, compareFingerprints } from '@shared/sound-match/features';
import { inferSampleKind, rankSimilar, relationOf, shortWhy, similarKinds } from '@shared/sound-match/similar';
import { FingerprintService } from '../electron/sounds/fingerprints';
import { browserFileAccess, findSimilar, SIMILAR_INDEX_MISSING, type SimilarDeps } from '../electron/sounds/similar';
import type { FingerprintResult } from '../electron/analyzer/service';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, TOOLS, type ToolCaller } from '../electron/mcp/tools';
import { classifyUserSample } from '../electron/mcp/tools/discovery';
import { INVOKE } from '../electron/channels';
import { DEFAULT_SETTINGS } from '../electron/system/settings-store';
import { kindName, shouldMeasureMore, sourceKindText } from '../src/sounds/similarLogic';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FACTORY = path.join(ROOT, 'resources', 'factory');
const INDEX_FILE = path.join(FACTORY, 'fingerprints.json');
const INDEX = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as FingerprintIndex;
const E = INDEX.entries;
const SAMPLES = (JSON.parse(fs.readFileSync(path.join(FACTORY, 'index.json'), 'utf8')) as FactoryIndex).samples;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-similar-'));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const samplesOf = (k: SampleKind) => E.filter((e): e is FingerprintEntry & { source: { kind: 'sample'; path: string; sampleKind: SampleKind } } => e.source.kind === 'sample' && e.source.sampleKind === k);
const entry = (key: string) => E.find((e) => (e.source.kind === 'sample' ? e.source.path : e.source.id) === key)!;
const isKickish = (s: FingerprintEntry['source']) => (s.kind === 'sample' ? s.sampleKind === 'kick' : s.role === 'kick');
const fpOf = (p: string) => (E.find((e) => e.source.kind === 'sample' && e.source.path === p) as FingerprintEntry).fp;

test('real index: a kick finds kicks (same kind: only kicks; any kind: kicks fill the top 3 for most)', () => {
  const kicks = samplesOf('kick');
  assert.ok(kicks.length >= 10, `the factory index has kicks (${kicks.length})`);
  let anyGood = 0;
  for (const k of kicks) {
    const same = rankSimilar(k.fp, { kind: 'sample', sampleKind: 'kick' }, E, { limit: 10, exclude: k.source });
    assert.ok(same.length >= 5, `${k.source.path}: neighbours`);
    assert.ok(same.every((h) => isKickish(h.source)), `${k.source.path}: same kind = kicks only`);
    assert.ok(!same.some((h) => h.source.kind === 'sample' && h.source.path === k.source.path), 'the source itself is excluded');
    const any = rankSimilar(k.fp, { kind: 'sample', sampleKind: 'kick' }, E, { scope: 'any', limit: 3, exclude: k.source });
    if (any.every((h) => isKickish(h.source))) anyGood++;
  }
  assert.ok(anyGood / kicks.length >= 0.8, `kicks' any-kind top 3 are kicks for ${anyGood}/${kicks.length}`);
});

test('real index: bright hats rank near bright hats, dark hats near dark hats', () => {
  const hats = samplesOf('hat').sort((a, b) => b.fp.centroidHz - a.fp.centroidHz);
  const median = hats[hats.length >> 1].fp.centroidHz;
  const top = (h: (typeof hats)[number], n: number) => rankSimilar(h.fp, { kind: 'sample', sampleKind: 'hat' }, E, { want: 'samples', limit: n, exclude: h.source }).map((x) => fpOf((x.source as { path: string }).path).centroidHz);
  for (const bright of hats.slice(0, 3)) assert.ok(top(bright, 1)[0] >= median, `${bright.source.path}: its closest hat is bright too`);
  const darkest = hats[hats.length - 1];
  assert.ok(top(darkest, 1)[0] < median, 'the darkest hat finds a dark hat');
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(top(hats[0], 3)) > mean(top(darkest, 3)) * 1.25, 'bright neighbourhoods are brighter than dark ones');
});

test('real index: an 808 preset finds 808s (presets and samples), why lines are short words, order is deterministic', () => {
  const boom = entry('factory:808/boom');
  assert.ok(boom, 'factory:808/boom is in the index');
  const k = { kind: 'preset', role: '808' } as const;
  const all = rankSimilar(boom.fp, k, E, { limit: 12, exclude: boom.source });
  assert.ok(all.length >= 8);
  assert.ok(all.every((h) => (h.source.kind === 'preset' ? ['808', 'sub', 'bass'].includes(h.source.role) : ['808', 'bass-oneshot'].includes(h.source.sampleKind))), JSON.stringify(all.map((h) => h.source)));
  assert.ok(!all.some((h) => h.source.kind === 'preset' && h.source.id === 'factory:808/boom'));
  const samples = rankSimilar(boom.fp, k, E, { want: 'samples', limit: 5 });
  assert.ok(samples.length && samples.every((h) => h.source.kind === 'sample' && h.source.sampleKind === '808'));
  assert.ok(all.every((h) => h.why.length > 0 && h.why.length <= 48 && !/\d/.test(h.why)), all.map((h) => h.why).join(' | '));
  assert.deepEqual(rankSimilar(boom.fp, k, [...E].reverse(), { limit: 12, exclude: boom.source }), all, 'same order whatever the candidate order');
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].similarity >= all[i].similarity);
});

test('why: "darker, shorter tail" / "nearly identical"; relations and kinds; inference of an unnamed kick', () => {
  const kick = samplesOf('kick')[0];
  const darker: SoundFingerprint = { ...kick.fp, centroidHz: kick.fp.centroidHz / 2, decayMs: kick.fp.decayMs / 2.5 };
  const cmp = compareFingerprints(kick.fp, darker, PROFILES.kick, { drum: true });
  const why = shortWhy(darker, cmp.deltas, PROFILES.kick, cmp.similarity, 'kick');
  assert.match(why, /shorter tail/);
  assert.match(why, /darker/);
  const same = compareFingerprints(kick.fp, kick.fp, PROFILES.kick, { drum: true });
  assert.equal(shortWhy(kick.fp, same.deltas, PROFILES.kick, same.similarity, 'kick'), 'nearly identical');
  assert.deepEqual(similarKinds({ kind: 'sample', sampleKind: 'riser' }).kinds.slice(0, 2), ['riser', 'sweep-up']);
  const kickPreset = E.find((e) => e.source.kind === 'preset' && e.source.role === 'kick')!;
  assert.equal(relationOf(kickPreset, { kind: 'sample', sampleKind: 'kick' }), 'exact');
  assert.equal(relationOf(samplesOf('snare')[0], { kind: 'sample', sampleKind: 'kick' }), 'other');
  const unknown = rankSimilar(kick.fp, { kind: 'sample', sampleKind: null }, E, { scope: 'same', limit: 5, exclude: kick.source });
  assert.equal(unknown.length, 5);
  assert.equal(inferSampleKind(kick.fp, E.filter((e) => e !== kick))?.kind, 'kick');
  assert.equal(inferSampleKind(samplesOf('hat')[0].fp, E.filter((e) => e !== samplesOf('hat')[0]))?.kind, 'hat');
});

const PACK_DIR = path.join(TMP, 'packs', 'testpack');
const USER_DIR = path.join(TMP, 'My Samples');
fs.mkdirSync(path.join(PACK_DIR, 'kicks'), { recursive: true });
fs.mkdirSync(path.join(PACK_DIR, 'hats'), { recursive: true });
fs.mkdirSync(USER_DIR, { recursive: true });
const PACK_FILES: Array<{ file: string; kind: SampleKind; like: string }> = [
  ...[0, 1, 2, 3, 4].map((i) => ({ file: `kicks/k${i}.wav`, kind: 'kick' as const, like: samplesOf('kick')[i].source.path })),
  ...[0, 1, 2].map((i) => ({ file: `hats/h${i}.wav`, kind: 'hat' as const, like: samplesOf('hat')[i].source.path })),
];
for (const f of PACK_FILES) fs.writeFileSync(path.join(PACK_DIR, f.file), 'RIFF');
const PACK_SAMPLES: FactorySample[] = PACK_FILES.map((f) => ({ path: `pack:testpack/${f.file}`, name: `Pack ${path.basename(f.file, '.wav')}`, kind: f.kind, tags: [], genres: [], lengthSec: 0.4, channels: 1, peakDb: -1 }));
const USER_KICK = path.join(USER_DIR, 'thing 01.wav');
const USER_HAT_NAMED = path.join(USER_DIR, 'Hats', 'bright one.wav');
fs.mkdirSync(path.dirname(USER_HAT_NAMED), { recursive: true });
fs.writeFileSync(USER_KICK, 'RIFF');
fs.writeFileSync(USER_HAT_NAMED, 'RIFF');
const OUTSIDE = path.join(TMP, 'elsewhere.wav');
fs.writeFileSync(OUTSIDE, 'RIFF');

const resolveSample = (p: string) => (p.startsWith('pack:testpack/') ? path.join(PACK_DIR, ...p.slice('pack:testpack/'.length).split('/')) : p.startsWith('factory:') ? path.join(FACTORY, ...p.slice(8).split('/')) : p);

function fakeAnalyzer(calls: string[], opts: { fail?: RegExp } = {}) {
  return async (abs: string): Promise<ActionResult<FingerprintResult>> => {
    calls.push(path.basename(abs));
    if (opts.fail?.test(abs)) return { ok: false, message: 'Unsupported or corrupt audio file' };
    const pf = PACK_FILES.find((f) => path.join(PACK_DIR, f.file) === abs);
    const like = pf ? pf.like : abs === USER_KICK ? samplesOf('kick')[2].source.path : samplesOf('hat')[0].source.path;
    const base = fpOf(like);
    return { ok: true, data: { segments: [], whole: { ...base, rmsDb: base.rmsDb - 1 } } };
  };
}

function simDeps(o: { indexFile?: string; fingerprint?: SimilarDeps['fingerprint']; userData?: string; userPresets?: InstrumentPreset[] } = {}): SimilarDeps {
  const userData = o.userData ?? fs.mkdtempSync(path.join(TMP, 'ud-'));
  const svc = new FingerprintService({
    indexFile: o.indexFile ?? INDEX_FILE,
    userDataDir: userData,
    fingerprint: o.fingerprint,
    packSamples: () => PACK_SAMPLES.map((s) => ({ path: s.path, kind: s.kind })),
    resolveSamplePath: resolveSample,
    log: () => {},
  });
  const presets = new Map<string, InstrumentPreset>();
  for (const p of FACTORY_PRESETS) if (p.kind === 'instrument') presets.set(p.id, p);
  for (const p of o.userPresets ?? []) presets.set(p.id, p);
  return {
    svc,
    preset: (id) => presets.get(id),
    playable: () => true,
    samples: () => [...SAMPLES, ...PACK_SAMPLES],
    resolveSamplePath: resolveSample,
    fingerprint: o.fingerprint,
    userFile: browserFileAccess(() => [USER_DIR, FACTORY]),
    classify: classifyUserSample,
  };
}

test('findSimilar: a factory preset and a factory sample resolve from the index (no analyzer needed)', async () => {
  const d = simDeps();
  const p = await findSimilar(d, { kind: 'preset', id: 'factory:808/boom' }, { want: 'presets', limit: 5 }, { maxNewPackSamples: 0 });
  assert.ok(p.ok && p.data, p.message);
  assert.equal(p.data.source.kind, '808');
  assert.ok(p.data.items.length === 5 && p.data.items.every((i) => i.type === 'preset' && i.id !== 'factory:808/boom' && i.name && i.percent > 0 && i.percent <= 100));
  const kick = samplesOf('kick')[0].source.path;
  const s = await findSimilar(d, { kind: 'sample', path: kick }, { want: 'samples', limit: 8 }, { maxNewPackSamples: 0 });
  assert.ok(s.ok && s.data, s.message);
  assert.equal(s.data.source.name, SAMPLES.find((x) => x.path === kick)!.name);
  assert.ok(s.data.items.every((i) => i.type === 'sample' && i.kind === 'kick' && i.path !== kick && i.sameKind), JSON.stringify(s.data.items.slice(0, 3)));
  assert.equal(s.data.pending, 5, 'five pack kicks not measured (0 allowed per call)');
  const notes = await findSimilar(d, { kind: 'sample', path: kick }, { want: 'samples' });
  assert.ok(notes.ok && notes.data!.notes.some((n) => /no audio analyzer/.test(n)), JSON.stringify(notes.data?.notes));
});

test('findSimilar: pack samples are measured lazily (progress, pending, next call measures the rest, cancel stops)', async () => {
  const calls: string[] = [];
  const d = simDeps({ fingerprint: fakeAnalyzer(calls) });
  const kick = samplesOf('kick')[0].source.path;
  const progress: string[] = [];
  const first = await findSimilar(d, { kind: 'sample', path: kick }, { want: 'samples', limit: 40 }, { maxNewPackSamples: 2, onMeasured: (done, total) => progress.push(`${done}/${total}`) });
  assert.ok(first.ok && first.data, first.message);
  assert.equal(first.data.measured, 2);
  assert.equal(first.data.pending, 3);
  assert.deepEqual(progress, ['1/2', '2/2']);
  assert.ok(calls.every((c) => /^k\d\.wav$/.test(c)), `only pack kicks are measured for a kick (${calls})`);
  assert.equal(first.data.items.filter((i) => i.type === 'sample' && i.origin === 'pack').length, 2);
  const second = await findSimilar(d, { kind: 'sample', path: kick }, { want: 'samples', limit: 40 }, { maxNewPackSamples: 24 });
  assert.equal(second.data!.pending, 0);
  assert.equal(second.data!.measured, 3);
  const top = second.data!.items[0];
  assert.ok(top.type === 'sample' && top.path === 'pack:testpack/kicks/k0.wav' && top.origin === 'pack' && top.name === 'Pack k0', JSON.stringify(top));
  const n = calls.length;
  const again = await findSimilar(simDeps({ fingerprint: fakeAnalyzer(calls), userData: path.dirname(path.dirname(path.join((d.svc as unknown as { packFile: string }).packFile))) }), { kind: 'sample', path: kick }, { want: 'samples' });
  assert.equal(again.data!.pending, 0);
  assert.equal(calls.length, n);
  const ac = new AbortController();
  ac.abort();
  const cancelled = await findSimilar(simDeps({ fingerprint: fakeAnalyzer(calls) }), { kind: 'preset', id: 'factory:808/boom' }, {}, { signal: ac.signal });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.message!, /cancelled/);
  const hatSrc = await findSimilar(simDeps({ fingerprint: fakeAnalyzer(calls) }), { kind: 'sample', path: 'pack:testpack/hats/h1.wav' }, { want: 'samples', scope: 'any' });
  assert.ok(hatSrc.ok && hatSrc.data, hatSrc.message);
  assert.equal(hatSrc.data.source.kind, 'hat');
  assert.ok(!hatSrc.data.items.some((i) => i.type === 'sample' && i.path === 'pack:testpack/hats/h1.wav'), 'not itself');
  const gone = await findSimilar(simDeps({ fingerprint: fakeAnalyzer(calls) }), { kind: 'sample', path: 'pack:otherpack/x.wav' });
  assert.equal(gone.ok, false);
  assert.match(gone.message!, /installed sound pack/);
});

test('findSimilar: user files only inside the Browser folders; the kind from the name, else judged by the sound', async () => {
  const calls: string[] = [];
  const d = simDeps({ fingerprint: fakeAnalyzer(calls) });
  const out = await findSimilar(d, { kind: 'sample', path: OUTSIDE });
  assert.equal(out.ok, false);
  assert.match(out.message!, /isn't in a Browser folder/);
  assert.equal(calls.length, 0, 'never measured');
  const notAudio = await findSimilar(d, { kind: 'sample', path: path.join(USER_DIR, 'notes.txt') });
  assert.match(notAudio.message!, /isn't an audio file/);
  const unc = await findSimilar(d, { kind: 'sample', path: '\\\\server\\share\\kick.wav' });
  assert.equal(unc.ok, false);
  const guessed = await findSimilar(d, { kind: 'sample', path: USER_KICK }, { limit: 10 }, { maxNewPackSamples: 0 });
  assert.ok(guessed.ok && guessed.data, guessed.message);
  assert.deepEqual(guessed.data.source, { name: 'thing 01', kind: 'kick', inferred: true });
  assert.ok(guessed.data.items.every((i) => (i.type === 'sample' ? i.kind === 'kick' : i.role === 'kick')));
  assert.equal(sourceKindText(guessed.data), 'Sounds like a kick (judged by its sound)');
  const named = await findSimilar(d, { kind: 'sample', path: USER_HAT_NAMED }, { want: 'samples', limit: 5 }, { maxNewPackSamples: 0 });
  assert.ok(named.ok && named.data);
  assert.deepEqual(named.data.source, { name: 'bright one', kind: 'hat', inferred: false });
  assert.ok(named.data.items.every((i) => i.type === 'sample' && ['hat', 'shaker'].includes(i.kind)));
  const broken = await findSimilar(simDeps({ fingerprint: fakeAnalyzer([], { fail: /thing/ }) }), { kind: 'sample', path: USER_KICK });
  assert.equal(broken.ok, false);
  assert.match(broken.message!, /Couldn't measure "thing 01": Unsupported/);
});

test('findSimilar: user presets (a one-sample preset is measured from its sample; synth presets say why not); chains and unknown ids', async () => {
  const calls: string[] = [];
  const sampler: InstrumentPreset = { kind: 'instrument', id: 'user:my-kick', name: 'My Kick', plugin: 'krypt.sampler', params: {}, sample: USER_KICK, role: 'kick', tags: [], genres: [], description: '' };
  const synth: InstrumentPreset = { kind: 'instrument', id: 'user:my-lead', name: 'My Lead', plugin: 'krypt.wavetable', params: {}, role: 'lead', tags: [], genres: [], description: '' };
  const d = simDeps({ fingerprint: fakeAnalyzer(calls), userPresets: [sampler, synth] });
  const s = await findSimilar(d, { kind: 'preset', id: 'user:my-kick' }, { limit: 5 }, { maxNewPackSamples: 0 });
  assert.ok(s.ok && s.data, s.message);
  assert.equal(s.data.source.kind, 'kick');
  assert.deepEqual(calls, ['thing 01.wav']);
  const l = await findSimilar(d, { kind: 'preset', id: 'user:my-lead' });
  assert.equal(l.ok, false);
  assert.match(l.message!, /"My Lead" hasn't been measured/);
  const none = await findSimilar(d, { kind: 'preset', id: 'factory:nope/nothing' });
  assert.match(none.message!, /no instrument preset/);
});

test('findSimilar: a missing index says how to get it (npm run fingerprints; installed copies ship it)', async () => {
  const r = await findSimilar(simDeps({ indexFile: path.join(TMP, 'nowhere', 'fingerprints.json') }), { kind: 'preset', id: 'factory:808/boom' });
  assert.equal(r.ok, false);
  assert.equal(r.message, SIMILAR_INDEX_MISSING);
  assert.match(r.message!, /npm run fingerprints/);
  assert.match(r.message!, /reinstall/);
});

test('IPC: sounds.similar has a channel, a preload binding, a validated handler and a browser mock', () => {
  assert.equal(INVOKE.soundsSimilar, 'sounds:similar');
  assert.match(read('shared/types.ts'), /similar\(source: SimilarSource, query\?: SimilarQuery\): Promise<ActionResult<SimilarResult>>;/);
  assert.match(read('electron/preload.ts'), /similar: \(source, query\) => invoke\(INVOKE\.soundsSimilar, source, query\)/);
  const ipc = read('electron/ipc.ts');
  assert.match(ipc, /handle\(INVOKE\.soundsSimilar,/);
  assert.match(ipc, /browserFileAccess\(\(\) => browserRoots\(d\.browser\)/, 'user files follow the Browser folder rule');
  assert.match(read('src/dev/mockSounds.ts'), /\n {4}similar: async \(source, q = \{\}\) =>/);
  for (const f of ['src/panels/browser/SimilarList.tsx', 'src/sounds/similar.ts', 'src/sounds/similarLogic.ts']) {
    const src = read(f);
    assert.doesNotMatch(src, /fingerprints\.json|from ['"](\.\.\/)+electron|@shared\/sound-match/, f);
  }
  assert.match(read('src/panels/browser/SimilarList.tsx'), /data-guide="browser\.similar"/);
});

test('browserFileAccess: absolute audio files inside a root that still exist', () => {
  const rule = browserFileAccess(() => [USER_DIR]);
  assert.deepEqual(rule(USER_KICK), { abs: USER_KICK });
  assert.ok('error' in rule(OUTSIDE));
  assert.ok('error' in rule('relative/kick.wav'));
  assert.ok('error' in rule(path.join(USER_DIR, 'gone.wav')));
});

test('renderer logic: kind names, when to ask main again', () => {
  assert.equal(kindName('kick'), 'Kick');
  assert.equal(kindName('reverse-cymbal'), 'Reverse cymbal');
  assert.equal(kindName('whoosh'), 'Whoosh');
  assert.equal(kindName('sweep-up'), 'Sweep up');
  assert.equal(kindName('808'), '808');
  assert.equal(kindName(null), 'Sound');
  assert.equal(shouldMeasureMore({ pending: 3, measured: 0 }, 0), true);
  assert.equal(shouldMeasureMore({ pending: 3, measured: 0 }, 1), false, 'no progress: stop asking');
  assert.equal(shouldMeasureMore({ pending: 3, measured: 2 }, 4), true);
  assert.equal(shouldMeasureMore({ pending: 0, measured: 2 }, 1), false);
});

function mcpDeps(): MainDeps {
  const doc = new DocHost(createDefaultProject('Similar'), CATALOG, { strict: true });
  const calls: string[] = [];
  const fingerprint = fakeAnalyzer(calls);
  const factoryIndex: FactoryIndex = { version: 1, generator: 'test', samples: [...SAMPLES, ...PACK_SAMPLES] };
  return {
    doc,
    engine: {} as MainDeps['engine'],
    project: {
      status: () => ({ path: null, name: 'Similar', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => (p === 'factory:fingerprints.json' ? INDEX_FILE : resolveSample(p)),
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [USER_DIR],
    },
    getSettings: () => ({ ...DEFAULT_SETTINGS, mcp: { ...DEFAULT_SETTINGS.mcp, fileAccess: 'browser' } }),
    updateSettings: () => DEFAULT_SETTINGS,
    broadcast: () => {},
    userDataDir: fs.mkdtempSync(path.join(TMP, 'mcp-ud-')),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    analyzer: {
      analyze: async () => ({ ok: false, message: 'n/a' }),
      separateStems: async () => ({ ok: false, message: 'n/a' }),
      toPattern: async () => ({ ok: false, message: 'n/a' }),
      listModels: () => [],
      drumStemHits: async () => ({ ok: true, data: null }),
      fingerprint: (abs) => fingerprint(abs),
    },
    sounds: { presets: () => FACTORY_PRESETS, preset: (id) => FACTORY_PRESETS.find((p) => p.id === id), factoryIndex: () => factoryIndex, saveUser: () => ({ ok: false, message: 'n/a' }), deleteUser: () => ({ ok: false, message: 'n/a' }) },
  };
}

test('MCP find_samples {like}: closest samples by timbre, same kind first, kind for another kind, user files under File access', async () => {
  const deps = mcpDeps();
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'sim-test', name: 'Similar Test' }, session: newSession(), via: 'test' };
  const call = (args: unknown) => callTool(deps, caller, 'find_samples', args, { quiet: true });
  const kick = samplesOf('kick')[0].source.path;
  const r = await call({ like: kick, limit: 6 });
  assert.ok(r.ok, r.message);
  const data = r.data as { like: { kind: string }; samples: Array<{ path: string; kind: string; similarity: number; why: string; source: string }>; pending: number };
  assert.equal(data.like.kind, 'kick');
  assert.ok(data.samples.length === 6 && data.samples.every((s) => s.kind === 'kick' && s.path !== kick && s.similarity > 0 && s.why), JSON.stringify(data.samples));
  assert.match(r.text!, /% · /);
  assert.match(r.message, /closest first/);
  assert.equal(data.pending, 0);
  const hats = await call({ like: kick, kind: 'hat', limit: 3 });
  assert.ok(hats.ok && (hats.data as typeof data).samples.every((s) => s.kind === 'hat'));
  const fromPreset = await call({ like: 'factory:808/boom', limit: 3 });
  assert.ok(fromPreset.ok && (fromPreset.data as typeof data).samples.every((s) => s.kind === '808' || s.kind === 'bass-oneshot'), fromPreset.message);
  const user = await call({ like: USER_KICK, limit: 3 });
  assert.ok(user.ok, user.message);
  assert.match(user.message, /sounds like a kick/);
  const outside = await call({ like: OUTSIDE });
  assert.equal(outside.ok, false, outside.message);
  const def = TOOLS.find((t) => t.name === 'find_samples')!;
  assert.deepEqual(def.paths!({ like: USER_KICK } as never), [{ value: USER_KICK, kind: 'audio' }]);
  assert.deepEqual(def.paths!({ like: 'user:my-lead' } as never), []);
  const bad = await call({ like: 'not a thing' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /isn't a sample path or a preset/);
  const plain = await call({ kind: 'kick', genre: 'any', limit: 2 });
  assert.ok(plain.ok && (plain.data as { samples: unknown[] }).samples.length === 2);
});

test('MCP find_presets {like}: closest instrument presets by timbre (role family; role picks another), from a preset or a sample', async () => {
  const deps = mcpDeps();
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'sim-test', name: 'Similar Test' }, session: newSession(), via: 'test' };
  const call = (args: unknown) => callTool(deps, caller, 'find_presets', args, { quiet: true });
  const r = await call({ like: 'factory:808/boom', limit: 5 });
  assert.ok(r.ok, r.message);
  const presets = (r.data as { presets: Array<{ id: string; role: string; similarity: number; why: string }> }).presets;
  assert.equal(presets.length, 5);
  assert.ok(presets.every((p) => ['808', 'sub', 'bass'].includes(p.role) && p.id !== 'factory:808/boom' && p.similarity > 0), JSON.stringify(presets));
  assert.match(r.text!, /factory:808\/\S+ {2}.+ \(808, .+\) · \d+% · /);
  const fromSample = await call({ like: samplesOf('kick')[1].source.path, limit: 3 });
  assert.ok(fromSample.ok && (fromSample.data as { presets: Array<{ role: string }> }).presets.every((p) => p.role === 'kick'), fromSample.message);
  const pads = await call({ like: 'factory:808/boom', role: 'pad', limit: 2 });
  assert.ok(pads.ok && (pads.data as { presets: Array<{ role: string }> }).presets.every((p) => p.role === 'pad'));
  const chainRole = await call({ like: 'factory:808/boom', role: 'master' });
  assert.equal(chainRole.ok, false);
  const plain = await call({ role: 'lead', limit: 2 });
  assert.ok(plain.ok && (plain.data as { presets: unknown[] }).presets.length === 2);
});

void run('similar');
