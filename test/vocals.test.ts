import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { SampleInfo } from '@shared/engine/protocol';
import type { ActionResult, MatchOutcome, Settings, TuneOutcome } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, TOOLS, type ToolCaller } from '../electron/mcp/tools';
import { AnalyzerSupervisor } from '../electron/analyzer/supervisor';
import { ModelManager } from '../electron/analyzer/models';
import { AnalyzerService } from '../electron/analyzer/service';
import { decodeBase64Audio, MAX_IMPORT_BYTES, uploadName, userGroupApply, VocalsService } from '../electron/vocals/service';
import { decodeContainer, encodeContainer } from '../electron/project/container';
import { validateProject } from '../electron/project/migrations';
import { relinkSamples, withRelativePaths } from '../electron/project/samples';
import { captureManifest } from '../electron/mcp/server';
import { PipeTransport } from '../electron/mcp/transport';
import { mashupPrompt, SERVER_INSTRUCTIONS } from '../electron/mcp/prompts';
import { fmtSemitones, keyShift, keyShortName, semitoneProblem, toKeyRef, tuneKeyFor, TUNE_STYLES, wrapSemitones, type KeyRef } from '@shared/music/keymatch';
import { matchBpm } from '@shared/analyzer/tempo';
import { patternKey, planTune, rescaleForTempo } from '@shared/vocals/plan';
import { cautionsIn, matchSentence, matchTargets, tuneSentence } from '../src/ears/logic';
import { earsCatalog, fakeSpawn, stageModels, TEST_MODELS, writeFakeAnalyzer } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-vocals-'));
const script = writeFakeAnalyzer(TMP);
const USER_ROOT = path.join(TMP, 'browser');
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(USER_ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.wav'), 'RIFF secret');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'browser' },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
};

async function fakeSampleInfo(p: string, running = true): Promise<ActionResult<SampleInfo>> {
  if (!running) return { ok: false, message: "The audio engine isn't running." };
  let head = '';
  try {
    head = fs.readFileSync(p).subarray(0, 4).toString('latin1');
  } catch {
    return { ok: false, message: `File not found: ${p}` };
  }
  if (head !== 'RIFF') return { ok: false, message: 'Unsupported or corrupt audio file (no decoder for this data)' };
  return { ok: true, data: { path: p, frames: 352800, sampleRate: 44100, channels: 2, durationSec: 8 } };
}

let n = 0;
async function rig(opts: { stems?: boolean; engineDown?: boolean } = {}) {
  const root = path.join(TMP, `rig${++n}`);
  const userData = path.join(root, 'userData');
  const bundled = path.join(root, 'bundled');
  stageModels(userData, bundled, { stems: opts.stems });
  const doc = new DocHost(createDefaultProject('Vocals'), earsCatalog(), { strict: true });
  const log = () => {};
  const resolveSamplePath = (p: string) => p;
  const sampleInfo = (p: string) => fakeSampleInfo(p, !opts.engineDown);
  const supervisor = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'not built', log, spawn: fakeSpawn(script), idleShutdownMs: 0 });
  const models = new ModelManager({ catalog: TEST_MODELS, bundledDirs: [bundled], userModelsDir: path.join(userData, 'models'), log });
  const analyzer = new AnalyzerService({ doc, supervisor, models, userDataDir: userData, resolveSamplePath, sampleInfo, log });
  await analyzer.init();
  const vocals = new VocalsService({ doc, userDataDir: userData, analyzer, sampleInfo, log });
  const deps: MainDeps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} as never }),
      status: () => ({ state: opts.engineDown ? 'stopped' : 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async () => ({ ok: false, message: 'n/a' }),
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo,
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Vocals', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath,
      renderDir: () => path.join(root, 'renders'),
      allowedRoots: () => [USER_ROOT],
    },
    getSettings: () => SETTINGS,
    updateSettings: () => SETTINGS,
    broadcast: () => {},
    userDataDir: userData,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    analyzer,
    vocals,
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'vox', name: 'Vox Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const audio = (file: string, track = 0, start = 0): { clipId: string; channelId: string } => {
    const abs = path.join(USER_ROOT, file);
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, `RIFF ${file}`);
    const r = doc.exec<{ clipId: string; channelId: string }>(
      'playlist.addAudio',
      { path: abs, trackId: doc.project.playlist.trackOrder[track], start, frames: 352800, sampleRate: 44100, channels: 2 },
      { actor: USER },
    );
    assert.ok(r.ok && r.data, r.message);
    return r.data!;
  };
  const agentEntries = () => doc.getHistory().filter((h) => h.actorKey === 'agent:vox');
  return { doc, deps, call, audio, vocals, analyzer, supervisor, userData, importsDir: path.join(userData, 'imports'), agentEntries, close: () => supervisor.stop() };
}

function writeGMinor(doc: DocHost): void {
  const p = doc.project;
  const keys = p.channelOrder.find((id) => p.channels[id].name === 'Keys')!;
  const keysNotes = [55, 58, 62, 67, 62, 58, 55, 60, 63, 67, 65, 62, 55, 58, 62, 55];
  const r = doc.exec('notes.add', { patternId: p.patternOrder[0], channelId: keys, notes: keysNotes.map((key, i) => ({ tick: i * 480, key, dur: i % 4 === 0 ? 960 : 480, vel: 0.8 })) }, { actor: USER });
  assert.ok(r.ok, r.message);
}

const K = (s: string): KeyRef => toKeyRef(s)!;
const genParams = (doc: DocHost, chId: string) => doc.project.channels[chId].generator.params;
const pitchSlots = (doc: DocHost, insId: string) => doc.project.mixer.inserts[insId].slotOrder.filter((s) => doc.project.mixer.inserts[insId].slots[s].type === 'krypt.pitch');
const RIFF = (tag: string) => Buffer.from(`RIFF${tag}${'x'.repeat(64)}`);

test('keyShift: the smallest move (−6..+6), ties go down', () => {
  const s = (a: string, b: string) => keyShift(K(a), K(b)).semitones;
  assert.equal(s('C', 'D'), 2);
  assert.equal(s('C', 'Bb'), -2);
  assert.equal(s('C', 'B'), -1, 'B is one down, not eleven up');
  assert.equal(s('C', 'G'), -5, 'G: five down beats seven up');
  assert.equal(s('C', 'F#'), -6, 'a tritone either way: down');
  assert.equal(s('Am', 'Gm'), -2);
  assert.equal(s('F#m', 'Am'), 3);
  assert.equal(s('Ebm', 'Em'), 1);
  const r = keyShift(K('Am'), K('Gm'));
  assert.equal(r.relation, 'move');
  assert.equal(keyShortName(r.result), 'Gm');
  for (let a = 0; a < 24; a++) {
    for (let b = 0; b < 24; b++) {
      const from = { pc: a % 12, minor: a >= 12 };
      const to = { pc: b % 12, minor: b >= 12 };
      const k = keyShift(from, to);
      assert.ok(k.semitones >= -6 && k.semitones <= 6, `${a}->${b}: ${k.semitones}`);
      const rel = (x: KeyRef) => (x.minor ? (x.pc + 3) % 12 : x.pc);
      assert.equal(rel(k.result), rel(to), `${a}->${b} lands on the same notes`);
    }
  }
});

test('keyShift: relative major / minor needs 0 (an Am vocal on a C beat stays put)', () => {
  const r = keyShift(K('Am'), K('C'));
  assert.deepEqual([r.semitones, r.relation], [0, 'relative']);
  assert.deepEqual([keyShift(K('C'), K('Am')).semitones, keyShift(K('Em'), K('G')).semitones, keyShift(K('Am'), K('Am')).relation], [0, 0, 'same']);
  const e = keyShift(K('Am'), K('Eb'));
  assert.equal(e.semitones, 3);
  assert.equal(keyShortName(e.result), 'Cm');
});

test('out of range: wrapping, explicit semitone limits, unparseable keys', () => {
  assert.deepEqual([wrapSemitones(11), wrapSemitones(-11), wrapSemitones(18), wrapSemitones(6), wrapSemitones(24), wrapSemitones(-7)], [-1, 1, -6, -6, 0, 5]);
  assert.equal(semitoneProblem(-24), null);
  assert.equal(semitoneProblem(3.5), null);
  assert.match(semitoneProblem(30)!, /between −24 and \+24/);
  assert.match(semitoneProblem(Number.NaN)!, /must be a number/);
  assert.equal(toKeyRef('H'), null);
  assert.equal(toKeyRef('D dorian'), null, 'only major / minor keys are matched');
  assert.deepEqual(toKeyRef({ tonic: 'Eb', mode: 'major' }), { pc: 3, minor: false });
  assert.deepEqual(toKeyRef('F#m'), { pc: 6, minor: true });
  assert.equal(fmtSemitones(-2), '−2 st');
  assert.equal(fmtSemitones(3), '+3 st');
});

test('tuneKeyFor: keys and modes onto Krypt Tune Key + Scale', () => {
  assert.deepEqual(tuneKeyFor('F#m'), { root: 6, scale: 2, label: 'F# minor' });
  assert.deepEqual(tuneKeyFor('Bb'), { root: 10, scale: 1, label: 'Bb major' });
  assert.deepEqual(tuneKeyFor('D dorian'), { root: 2, scale: 6, label: 'D Dorian' });
  const phryg = tuneKeyFor('E phrygian');
  assert.deepEqual([phryg.root, phryg.scale], [0, 1]);
  assert.match(phryg.note!, /same notes as C major/);
  assert.deepEqual(tuneKeyFor(K('Am'), 'minor pentatonic'), { root: 9, scale: 5, label: 'A Minor pentatonic' });
  assert.equal(tuneKeyFor('C', 'chromatic').label, 'Chromatic');
  assert.throws(() => tuneKeyFor('C', 'lydian dominant'), /no "lydian dominant" scale/);
  assert.throws(() => tuneKeyFor('C melodicMinor'), /no melodicMinor scale/);
  assert.throws(() => tuneKeyFor('nope'), /isn't a key/);
});

test('matchBpm: syncBpm within ±25%, else the octave reading that stretches least', () => {
  const a = matchBpm({ bpm: 96, alternatives: [48, 192] }, 142);
  assert.deepEqual([a.bpm, a.reading], [192, 'double time']);
  assert.ok(Math.abs(a.ratio - 142 / 192) < 1e-9);
  assert.deepEqual([matchBpm({ bpm: 128 }, 140).bpm, matchBpm({ bpm: 128 }, 140).reading], [128, 'as detected']);
  assert.deepEqual([matchBpm({ bpm: 70 }, 140).bpm, matchBpm({ bpm: 70 }, 140).reading], [140, 'double time']);
  assert.deepEqual([matchBpm({ bpm: 180 }, 90).bpm, matchBpm({ bpm: 180 }, 90).reading], [90, 'half time']);
  assert.equal(matchBpm({ bpm: 93 }, 140).bpm, 186, 'a 93 bpm loop follows 140 best at 186 (×0.75), not 93 (×1.51)');
});

test('planTune: first in the chain or update the one there; master and full chains refused', () => {
  const doc = new DocHost(createDefaultProject('Plan'), earsCatalog(), { strict: true });
  const ins = doc.project.mixer.insertOrder[1];
  for (const type of ['krypt.eq', 'krypt.comp']) assert.ok(doc.exec('mixer.addSlot', { insertId: ins, type }, { actor: USER }).ok);
  const key = tuneKeyFor('Gm');
  const fresh = planTune(doc.project, ins, key, 'hard');
  assert.equal(fresh.slotId, null);
  assert.deepEqual(fresh.steps, [{ cmd: 'mixer.addSlot', args: { insertId: ins, type: 'krypt.pitch', index: 0, params: { root: 7, scale: 2, speed: 0, humanize: 0, amount: 1 } } }]);
  assert.deepEqual(fresh.after, ['krypt.eq', 'krypt.comp']);
  assert.ok(doc.execBatch(fresh.steps, { actor: USER }).ok);
  const slot = doc.project.mixer.inserts[ins].slotOrder[0];
  assert.ok(doc.exec('mixer.setSlot', { insertId: ins, slotId: slot, enabled: false }, { actor: USER }).ok);
  const again = planTune(doc.project, ins, key, 'natural', { amount: 0.5 });
  assert.equal(again.slotId, slot);
  assert.equal(again.enable, true);
  assert.deepEqual(again.steps.map((s) => s.cmd), ['mixer.setSlotParams', 'mixer.setSlot']);
  assert.deepEqual(again.params, { root: 7, scale: 2, speed: 60, humanize: 0.4, amount: 0.5 });
  assert.throws(() => planTune(doc.project, doc.project.mixer.masterId, key, 'pop'), /straight into the Master/);
  const full = doc.project.mixer.insertOrder[2];
  for (let i = 0; i < 10; i++) doc.exec('mixer.addSlot', { insertId: full, type: 'krypt.eq' }, { actor: USER });
  assert.throws(() => planTune(doc.project, full, key, 'pop'), /already has 10 effects/);
  assert.deepEqual(Object.fromEntries(Object.entries(TUNE_STYLES).map(([k, v]) => [k, [v.speed, v.humanize]])), { natural: [60, 0.4], pop: [25, 0.2], hard: [0, 0] });
});

test('patternKey and rescaleForTempo (pure)', () => {
  const doc = new DocHost(createDefaultProject('Keys'), earsCatalog(), { strict: true });
  assert.equal(patternKey(doc.project), null, 'no pitched notes');
  writeGMinor(doc);
  const pk = patternKey(doc.project)!;
  assert.ok(['Gm', 'Bb'].includes(pk.name), pk.name);
  assert.equal(pk.notes, 16);
  const r = doc.exec<{ clipId: string }>('playlist.addAudio', { path: 'C:\\a\\loop.wav', trackId: doc.project.playlist.trackOrder[0], start: 960, frames: 352800, sampleRate: 44100 }, { actor: USER });
  const step = rescaleForTempo(doc.project, doc.catalog, 140, 70)!;
  assert.equal(step.cmd, 'playlist.updateClips');
  const len0 = doc.project.playlist.clips[r.data!.clipId].length;
  assert.deepEqual((step.args.updates as Array<{ id: string; length: number }>).map((u) => [u.id, u.length]), [[r.data!.clipId, Math.round(len0 / 2)]]);
  assert.equal(rescaleForTempo(doc.project, doc.catalog, 140, 140), null);
});

test('import_audio: Browser-folder paths are placed in place; anything outside is refused', async () => {
  const { call, doc, importsDir, close } = await rig();
  try {
    const out = await call('import_audio', { path: path.join(OUTSIDE, 'secret.wav') });
    assert.equal(out.ok, false);
    assert.match(out.message, /outside the folders Krypt Studio lets agents read/);
    fs.writeFileSync(path.join(USER_ROOT, 'Hook take 2.wav'), 'RIFF hook');
    const r = await call('import_audio', { path: path.join(USER_ROOT, 'Hook take 2.wav'), bar: 5 });
    assert.equal(r.ok, true, r.message);
    const d = r.data as { clipId: string; track: number; durationSec: number };
    const clip = doc.project.playlist.clips[d.clipId];
    assert.equal(clip.start, 4 * 3840, 'bar 5');
    assert.equal(d.track, 1, 'a new lane at the top of an empty project');
    assert.equal(doc.project.playlist.trackOrder.length, 17);
    assert.equal(d.durationSec, 8);
    const sample = doc.project.samples[doc.project.channels[clip.channelId!].generator.sampleId!];
    assert.equal(sample.path, fs.realpathSync.native(path.join(USER_ROOT, 'Hook take 2.wav')), 'referenced in place, not copied');
    assert.equal(sample.name, 'Hook take 2');
    assert.equal(fs.existsSync(importsDir), false, 'nothing written to imports for a path import');
    assert.match(r.text!, /analyze_audio/);
    assert.match(r.text!, /separate_stems/);
    const both = await call('import_audio', { path: path.join(USER_ROOT, 'Hook take 2.wav'), data: 'UklGRg==', name: 'x.wav' });
    assert.match(both.message, /either path .* or data \+ name/);
  } finally {
    await close();
  }
});

test('import_audio: base64 uploads land in userData/imports (content hash, atomic), deduplicated, with the hash on the sample', async () => {
  const { call, doc, importsDir, agentEntries, close } = await rig();
  try {
    const bytes = RIFF('vocal-take');
    const r = await call('import_audio', { data: bytes.toString('base64'), name: 'Hook vocal.WAV', bar: '3.5' });
    assert.equal(r.ok, true, r.message);
    const d = r.data as { clipId: string; channelId: string; deduped: boolean; name: string; bytes: number };
    assert.equal(d.deduped, false);
    assert.equal(d.name, 'Hook vocal');
    assert.equal(d.bytes, bytes.length);
    const sample = doc.project.samples[doc.project.channels[d.channelId].generator.sampleId!];
    assert.equal(path.dirname(sample.path), importsDir);
    assert.match(path.basename(sample.path), /^[a-f0-9]{64}\.wav$/);
    assert.equal(sample.hash, path.basename(sample.path, '.wav'));
    assert.deepEqual(fs.readFileSync(sample.path), bytes);
    assert.equal(doc.project.playlist.clips[d.clipId].start, 2 * 3840 + 4 * 240, 'bar 3, step 5');
    assert.equal(agentEntries().length, 1, 'track + clip = one undo group');
    const again = await call('import_audio', { data: `data:audio/wav;base64,${bytes.toString('base64')}`, name: 'other name.wav' });
    assert.equal(again.ok, true, again.message);
    assert.equal((again.data as { deduped: boolean }).deduped, true);
    assert.match(again.message, /imported before/);
    assert.deepEqual(fs.readdirSync(importsDir), [path.basename(sample.path)], 'one file, no temp leftovers');
    const sneaky = await call('import_audio', { data: RIFF('sneaky').toString('base64'), name: '..\\..\\Windows\\evil.wav' });
    assert.equal(sneaky.ok, true, sneaky.message);
    assert.equal((sneaky.data as { name: string }).name, 'evil');
    for (const f of fs.readdirSync(importsDir)) assert.match(f, /^[a-f0-9]{64}\.wav$/);
    assert.equal(fs.existsSync(path.join(path.dirname(importsDir), '..', 'Windows')), false);
  } finally {
    await close();
  }
});

test('import_audio: size cap, extension allow-list, bad base64 and undecodable bytes are refused cleanly', async () => {
  const { call, doc, importsDir, close } = await rig();
  try {
    const v = doc.version;
    const big = await call('import_audio', { data: 'A'.repeat(Math.ceil(((MAX_IMPORT_BYTES + 1024 * 1024) * 4) / 3)), name: 'huge.wav' });
    assert.equal(big.ok, false);
    assert.match(big.message, /The audio is 61\.0 MB; import_audio takes at most 60\.0 MB per file/);
    for (const name of ['vocal.exe', 'vocal', 'vocal.txt']) {
      const r = await call('import_audio', { data: RIFF('x').toString('base64'), name });
      assert.equal(r.ok, false, name);
      assert.match(r.message, /name must be a file name with an audio extension \(wav, aif, aiff, flac, mp3, ogg, m4a/, name);
    }
    const noName = await call('import_audio', { data: RIFF('x').toString('base64') });
    assert.match(noName.message, /name is required with data/);
    const junk = await call('import_audio', { data: '@@@ not base64 @@@', name: 'v.wav' });
    assert.match(junk.message, /not valid base64/);
    const notAudio = await call('import_audio', { data: Buffer.from('MZ this is not audio at all').toString('base64'), name: 'fake.mp3' });
    assert.equal(notAudio.ok, false);
    assert.ok(!notAudio.message.includes(importsDir), 'the internal imports path is not shown');
    assert.match(notAudio.message, /"fake\.mp3" isn't audio Krypt Studio can decode: Unsupported or corrupt audio file/);
    assert.deepEqual(fs.existsSync(importsDir) ? fs.readdirSync(importsDir) : [], [], 'the undecodable upload was removed again');
    assert.equal(doc.version, v, 'nothing changed in the project');
    assert.deepEqual(uploadName('Take 3.FLAC'), { ext: 'flac', title: 'Take 3' });
    assert.ok('error' in decodeBase64Audio('A'.repeat(200), 100));
    assert.deepEqual(Buffer.from((decodeBase64Audio('UklGRg') as { bytes: Uint8Array }).bytes).toString(), 'RIFF', 'unpadded base64 is fine');
  } finally {
    await close();
  }
});

test('import_audio while the engine is down says so (nothing stored, nothing placed)', async () => {
  const { call, doc, importsDir, close } = await rig({ engineDown: true });
  try {
    const v = doc.version;
    const r = await call('import_audio', { data: RIFF('x').toString('base64'), name: 'v.wav' });
    assert.equal(r.ok, false);
    assert.match(r.message, /The audio engine isn't running/);
    assert.equal(doc.version, v);
    assert.deepEqual(fs.existsSync(importsDir) ? fs.readdirSync(importsDir) : [], []);
  } finally {
    await close();
  }
});

test('a saved project keeps playing its upload: saved with its path + hash, reopened, relinked from another profile', async () => {
  const { call, doc, importsDir, close } = await rig();
  try {
    const r = await call('import_audio', { data: RIFF('keeper').toString('base64'), name: 'Keeper.wav' });
    assert.equal(r.ok, true, r.message);
    const projDir = path.join(TMP, 'projects', 'Mashup');
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, 'Mashup.kstudio');
    fs.writeFileSync(file, encodeContainer(withRelativePaths(doc.project, file), '0.1.0'));
    const decoded = decodeContainer(fs.readFileSync(file));
    const project = validateProject(decoded.project, decoded.meta?.schemaVersion);
    const s = Object.values(project.samples).find((x) => x.name === 'Keeper')!;
    assert.equal(path.dirname(s.path), importsDir);
    assert.ok(s.relPath, 'relPath stored like every other sample');
    assert.match(s.hash!, /^[a-f0-9]{64}$/);
    const same = relinkSamples(project, file, (p) => fs.existsSync(p), { importsDir });
    assert.deepEqual([same.relinked, same.missing], [[], []], 'opens with its audio on this PC');
    const other = path.join(TMP, 'other-profile', 'imports');
    fs.mkdirSync(other, { recursive: true });
    const moved = { ...project, samples: Object.fromEntries(Object.entries(project.samples).map(([id, x]) => [id, x.name === 'Keeper' ? { ...x, path: path.join(TMP, 'gone', path.basename(x.path)), relPath: undefined } : x])) };
    fs.copyFileSync(s.path, path.join(other, path.basename(s.path)));
    const rel = relinkSamples(moved, file, (p) => fs.existsSync(p), { importsDir: other });
    assert.deepEqual(rel.relinked, ['Keeper']);
    assert.equal(Object.values(rel.project.samples).find((x) => x.name === 'Keeper')!.path, path.join(other, path.basename(s.path)));
    const lost = relinkSamples(moved, file, (p) => fs.existsSync(p), { importsDir: path.join(TMP, 'empty') });
    assert.deepEqual(lost.missing, ['Keeper']);
  } finally {
    await close();
  }
});

test('pipe transport: a 12 MB upload line arrives whole (linear framing); an oversized one gets an error and the connection stays open', async () => {
  const { EventEmitter } = await import('node:events');
  const sock = Object.assign(new EventEmitter(), { destroyed: false, written: [] as string[], write(s: string) { this.written.push(s); return true; }, end() {}, destroy() {} });
  const t = new PipeTransport(sock as never, Buffer.alloc(0), undefined, 1024 * 1024 * 16);
  const got: Array<{ id?: number; params?: { arguments?: { data?: string } } }> = [];
  const errors: string[] = [];
  t.onmessage = (m) => void got.push(m as never);
  t.onerror = (e) => void errors.push(e.message);
  await t.start();
  const big = 'A'.repeat(12 * 1024 * 1024);
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'import_audio', arguments: { data: big, name: 'v.wav' } } })}\n`);
  const t0 = Date.now();
  for (let i = 0; i < line.length; i += 65536) sock.emit('data', line.subarray(i, i + 65536));
  assert.ok(Date.now() - t0 < 3000, `framing took ${Date.now() - t0} ms`);
  assert.equal(got.length, 1);
  assert.equal(got[0].params?.arguments?.data?.length, big.length);
  const huge = Buffer.from(`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"import_audio","arguments":{"data":"${'B'.repeat(17 * 1024 * 1024)}"}}}\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n`);
  for (let i = 0; i < huge.length; i += 65536) sock.emit('data', huge.subarray(i, i + 65536));
  assert.equal(sock.written.length, 1);
  const reply = JSON.parse(sock.written[0]) as { id: number; error: { code: number; message: string } };
  assert.deepEqual([reply.id, reply.error.code], [8, -32600]);
  assert.match(reply.error.message, /Request too large: 17\.0 MB; Krypt Studio accepts up to 16\.0 MB per message/);
  assert.deepEqual(got.map((m) => m.id), [7, 9], 'the connection kept working');
  assert.equal(errors.length, 1);
  await t.close();
});

test('match_clip to the project: key from the patterns (−2 st, Am → Gm), tempo at the double-time reading, one undo group', async () => {
  const { call, doc, audio, agentEntries, vocals, close } = await rig();
  try {
    writeGMinor(doc);
    const { clipId, channelId } = audio('vocal key=Am bpm=96.wav');
    const len0 = doc.project.playlist.clips[clipId].length;
    const r = await call('match_clip', { clip: clipId });
    assert.equal(r.ok, true, r.message);
    const d = r.data as MatchOutcome;
    assert.deepEqual([d.semitones, d.fromKey, d.resultKey, d.sourceBpm, d.reading, d.followsBpm], [-2, 'Am', 'Gm', 192, 'double time', 140]);
    const g = genParams(doc, channelId);
    assert.deepEqual([g.pitch, g.formant, g.tempo_sync, g.src_bpm], [-2, 1, 1, 192]);
    assert.match(r.message, /moved −2 st \(A minor → G minor/);
    assert.match(r.message, /detected 96 bpm, read as 192 \(double time\)/);
    assert.match(r.message, /big stretch \(×0\.73\)/);
    assert.match(r.message, /project's patterns/);
    assert.equal(doc.project.playlist.clips[clipId].length, Math.round((len0 * 192) / 140), 'rescaled: the same audio stays visible');
    assert.equal(agentEntries().length, 1);
    const again = await call('match_clip', { clip: clipId });
    assert.equal(again.ok, false);
    assert.match(again.message, /^No change/);
    const menu = await vocals.match(clipId, {}, (cmd, args) => doc.exec(cmd, args, { actor: USER }).data as never);
    assert.match(menu.message!, /already matches the project: pitch −2 st \(A minor → G minor\), following 140 bpm from 192 bpm; nothing changed/);
    const undo = await call('undo_last');
    assert.equal(undo.ok, true, undo.message);
    assert.equal(genParams(doc, channelId).pitch, undefined);
  } finally {
    await close();
  }
});

test('match_clip: relative keys need 0 st; the project key can come from other audio; semitones override and its limits', async () => {
  const { call, doc, audio, close } = await rig();
  try {
    const beat = audio('beat key=C bpm=140.wav', 1);
    const vox = audio('vox key=Am bpm=140.wav', 0);
    const r = await call('match_clip', { clip: vox.clipId });
    assert.equal(r.ok, true, r.message);
    assert.equal((r.data as MatchOutcome).semitones, 0);
    assert.match(r.message, /stays in A minor: the project is in C major, its relative major \(the same notes\), so it needs 0 st/);
    assert.match(r.message, /"beat key=C bpm=140" in C major/);
    assert.equal(genParams(doc, vox.channelId).pitch, 0);
    assert.equal(genParams(doc, beat.channelId).tempo_sync, undefined, 'the beat is left alone');
    const bad = await call('match_clip', { clip: vox.clipId, semitones: 30 });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /between −24 and \+24/);
    const oct = await call('match_clip', { clip: vox.clipId, semitones: -12, tempo: false });
    assert.equal(oct.ok, true, oct.message);
    assert.deepEqual([genParams(doc, vox.channelId).pitch, genParams(doc, vox.channelId).formant], [-12, 1]);
    const off = await call('match_clip', { clip: vox.clipId, key: false, tempo: false });
    assert.match(off.message, /Nothing to match/);
  } finally {
    await close();
  }
});

test('match_clip to a clip at its own tempo: that tempo becomes the project tempo, other free-running audio stays in place', async () => {
  const { call, doc, audio, agentEntries, close } = await rig();
  try {
    const vox = audio('vocal2 key=Am bpm=96.wav', 0);
    const beat = audio('beat key=Gm bpm=90.wav', 1);
    const loop = audio('loop key=C bpm=90.wav', 2);
    const len0 = doc.project.playlist.clips[beat.clipId].length;
    const r = await call('match_clip', { clip: 'vocal2 key=Am bpm=96', to: 'beat key=Gm bpm=90' });
    assert.equal(r.ok, true, r.message);
    const d = r.data as MatchOutcome;
    assert.deepEqual([d.semitones, d.toKey, d.sourceBpm, d.reading, d.followsBpm, d.projectBpm, d.projectTempoChanged], [-2, 'Gm', 96, 'as detected', 90, 90, true]);
    assert.equal(doc.project.transport.bpm, 90);
    assert.deepEqual([genParams(doc, beat.channelId).tempo_sync, genParams(doc, beat.channelId).src_bpm], [1, 90], 'the beat follows the tempo at its own tempo: unstretched');
    assert.equal(doc.project.playlist.clips[beat.clipId].length, Math.round((len0 * 90) / 140));
    assert.equal(doc.project.playlist.clips[loop.clipId].length, Math.round((len0 * 90) / 140), 'the unrelated loop still shows its 8 s');
    assert.equal(doc.project.playlist.clips[vox.clipId].length, Math.round((Math.round((len0 * 90) / 140) * 96) / 90));
    assert.match(r.message, /Project tempo set to 90 bpm from "beat key=Gm bpm=90", which now follows it unstretched \(was 140 bpm\)/);
    assert.equal(agentEntries().length, 1, 'beat + loop + tempo + vocal = one undo step');
    const undo = await call('undo_last');
    assert.equal(undo.ok, true, undo.message);
    assert.equal(doc.project.transport.bpm, 140);
    assert.equal(doc.project.playlist.clips[loop.clipId].length, len0);
  } finally {
    await close();
  }
});

test('match_clip on a stem reads key and tempo from its source mix; no key = tempo only, with a warning', async () => {
  const { call, doc, audio, close } = await rig({ stems: true });
  try {
    writeGMinor(doc);
    const song = audio('song key=Am bpm=128.wav', 0);
    const sep = await call('separate_stems', { clip: song.clipId });
    assert.equal(sep.ok, true, sep.message);
    const vocalsCh = doc.project.channelOrder.find((id) => doc.project.channels[id].name === 'song key=Am bpm=128 · Vocals')!;
    const stemClip = Object.values(doc.project.playlist.clips).find((c) => c.channelId === vocalsCh)!;
    const r = await call('match_clip', { clip: stemClip.id });
    assert.equal(r.ok, true, r.message);
    assert.equal((r.data as MatchOutcome).semitones, -2, 'Am from the source mix (the stem file alone reads F#m, which would be +1)');
    assert.equal((r.data as MatchOutcome).sourceBpm, 128);
    assert.match(r.message, /its source mix "song key=Am bpm=128"/);
    const nk = audio('plain nokey bpm=128.wav', 3);
    const r2 = await call('match_clip', { clip: nk.clipId });
    assert.equal(r2.ok, true, r2.message);
    assert.equal((r2.data as MatchOutcome).semitones, null);
    assert.match(r2.message, /Key left alone: "plain nokey bpm=128" has no clear key/);
    assert.equal(genParams(doc, nk.channelId).src_bpm, 128);
  } finally {
    await close();
  }
});

test('a weak chroma key on one voice: the key of its transcribed notes decides (match_clip and tune_vocal)', async () => {
  const a = await rig();
  try {
    writeGMinor(a.doc);
    const v = a.audio('melody key=E keyconf=0.3 bpm=140.wav');
    const r = await a.call('match_clip', { clip: v.clipId, tempo: false });
    assert.equal(r.ok, true, r.message);
    const d = r.data as MatchOutcome;
    assert.deepEqual([d.fromKey, d.semitones], ['C', -2], 'C major notes onto G minor: −2 (the weak E major reading would have said −6)');
    assert.match(r.message, /read from its 12 transcribed notes \(confidence 0\.82; the audio's own key reading, E major at 0\.3, was weak\)/);
  } finally {
    await a.close();
  }
  const b = await rig();
  try {
    const v = b.audio('melody key=E keyconf=0.3.wav');
    b.doc.exec('channels.setGenParams', { id: v.channelId, params: { pitch: -2 } }, { actor: USER });
    const r = await b.call('tune_vocal', { clip: v.clipId, style: 'hard' });
    assert.equal(r.ok, true, r.message);
    const d = r.data as TuneOutcome;
    assert.deepEqual([d.keySource, d.key, d.root], ['vocal', 'Bb major', 10]);
    assert.match(r.message, /the vocal's 12 transcribed notes: Bb major \(C pitched −2 st\), confidence 0\.82, because the vocal's own key reading is weak/);
  } finally {
    await b.close();
  }
});

test('tune_vocal: Krypt Tune goes FIRST before EQ / Comp, presets set retune + humanize, never duplicated, re-enabled', async () => {
  const { call, doc, audio, agentEntries, close } = await rig();
  try {
    const v = audio('tv key=Am bpm=100.wav');
    const ins = doc.project.channels[v.channelId].insertId;
    for (const type of ['krypt.eq', 'krypt.comp']) assert.ok(doc.exec('mixer.addSlot', { insertId: ins, type }, { actor: USER }).ok);
    const r = await call('tune_vocal', { clip: 'tv key=Am bpm=100', style: 'natural' });
    assert.equal(r.ok, true, r.message);
    const d = r.data as TuneOutcome;
    assert.deepEqual([d.created, d.key, d.keySource, d.style], [true, 'A minor', 'vocal', 'natural']);
    const chain = doc.project.mixer.inserts[ins];
    assert.deepEqual(chain.slotOrder.map((s) => chain.slots[s].type), ['krypt.pitch', 'krypt.eq', 'krypt.comp']);
    assert.deepEqual(chain.slots[chain.slotOrder[0]].params, { root: 9, scale: 2, speed: 60, humanize: 0.4, amount: 1 });
    assert.match(r.message, /added Krypt Tune to "tv key=Am bpm=100" in slot 1, before EQ → Comp: A minor, Natural \(retune 60 ms, humanize 40%\)/);
    assert.match(r.message, /Key from the vocal's own analysis: A minor, confidence 0\.8/);
    assert.equal(agentEntries().length, 1);
    for (const [style, speed, humanize] of [['hard', 0, 0], ['pop', 25, 0.2]] as const) {
      const s = await call('tune_vocal', { clip: v.clipId, style });
      assert.equal(s.ok, true, s.message);
      assert.equal(pitchSlots(doc, ins).length, 1, 'updated, not duplicated');
      const slot = doc.project.mixer.inserts[ins].slots[pitchSlots(doc, ins)[0]];
      assert.deepEqual([slot.params.speed, slot.params.humanize], [speed, humanize], style);
      assert.match(s.message, /updated the Krypt Tune already in slot 1/);
    }
    const slotId = pitchSlots(doc, ins)[0];
    doc.exec('mixer.setSlot', { insertId: ins, slotId, enabled: false }, { actor: USER });
    const back = await call('tune_vocal', { clip: v.clipId, style: 'pop' });
    assert.equal(back.ok, true, back.message);
    assert.match(back.message, /switched it back on/);
    assert.equal(doc.project.mixer.inserts[ins].slots[slotId].enabled, true);
    const same = await call('tune_vocal', { clip: v.clipId, style: 'pop' });
    assert.match(same.message, /^No change/);
  } finally {
    await close();
  }
});

test('tune_vocal: key after a pitch shift, from the instrumental when the vocal is weak, from patterns, or given', async () => {
  const { call, doc, audio, close } = await rig();
  try {
    const shifted = audio('pv key=Am.wav', 0);
    doc.exec('channels.setGenParams', { id: shifted.channelId, params: { pitch: -2 } }, { actor: USER });
    const a = await call('tune_vocal', { clip: shifted.clipId, style: 'hard' });
    assert.equal(a.ok, true, a.message);
    assert.deepEqual([(a.data as TuneOutcome).key, (a.data as TuneOutcome).root], ['G minor', 7]);
    assert.match(a.message, /G minor \(Am pitched −2 st\)/);

    doc.exec('playlist.updateClips', { updates: [{ id: shifted.clipId, mute: true }] }, { actor: USER });
    const weak = audio('weak key=Am keyconf=0.2.wav', 1);
    audio('inst key=Eb bpm=100.wav', 2);
    const b = await call('tune_vocal', { clip: weak.clipId });
    assert.equal(b.ok, true, b.message);
    const bd = b.data as TuneOutcome;
    assert.deepEqual([bd.keySource, bd.key, bd.style], ['instrumental', 'Eb major', 'pop']);
    assert.match(b.message, /"inst key=Eb bpm=100" in Eb major.*\(the instrumental\), because the vocal's own key reading is weak \(A minor, confidence 0\.2\)/);

    writeGMinor(doc);
    const c = await call('tune_vocal', { clip: 'Keys', style: 'natural' });
    assert.equal(c.ok, true, c.message);
    assert.equal((c.data as TuneOutcome).keySource, 'instrumental', 'a synth has no audio: the other audio in the project comes first');

    const given = await call('tune_vocal', { clip: weak.clipId, key: 'F#m', scale: 'minor pentatonic' });
    assert.equal(given.ok, true, given.message);
    assert.deepEqual([(given.data as TuneOutcome).keySource, (given.data as TuneOutcome).root, (given.data as TuneOutcome).scale], ['given', 6, 5]);
    const badKey = await call('tune_vocal', { clip: weak.clipId, key: 'X#q' });
    assert.match(badKey.message, /isn't a key/);

    const master = audio('master key=C.wav', 3);
    doc.exec('channels.set', { id: master.channelId, insertId: doc.project.mixer.masterId }, { actor: USER });
    const m = await call('tune_vocal', { clip: master.clipId });
    assert.equal(m.ok, false);
    assert.match(m.message, /plays straight into the Master: route it to its own mixer insert first/);
  } finally {
    await close();
  }
});

test('tune_vocal on a synth with only patterns: the patterns give the key', async () => {
  const { call, doc, close } = await rig();
  try {
    writeGMinor(doc);
    const r = await call('tune_vocal', { clip: 'Keys' });
    assert.equal(r.ok, true, r.message);
    const d = r.data as TuneOutcome;
    assert.equal(d.keySource, 'patterns');
    assert.ok(['G minor', 'Bb major'].includes(d.key), d.key);
    assert.match(r.message, /because the vocal has no sample to analyse/);
  } finally {
    await close();
  }
});

test('clip menu path: the same service as one USER undo step; a failure leaves no trace', async () => {
  const { doc, audio, vocals, close } = await rig();
  try {
    const v = audio('menu key=Dm bpm=100.wav');
    const g = userGroupApply(doc, 'Tune vocal "menu" (Hard)');
    const r = await vocals.tune({ clipId: v.clipId }, { style: 'hard' }, g.apply);
    g.finish(r.ok);
    assert.equal(r.ok, true, r.message);
    const hist = doc.getHistory().filter((h) => h.label === 'Tune vocal "menu" (Hard)');
    assert.equal(hist.length, 1);
    assert.equal(hist[0].actorKey, 'user');
    const ver = doc.version;
    const g2 = userGroupApply(doc, 'Match');
    const bad = await vocals.match(v.clipId, { semitones: 99 }, g2.apply);
    g2.finish(bad.ok);
    assert.equal(bad.ok, false);
    assert.equal(doc.version, ver);
    const other = audio('other key=Am bpm=100.wav', 1);
    assert.deepEqual(matchTargets(doc.project, v.clipId).map((t) => [t.clipId, t.label, t.detail]), [[other.clipId, 'other key=Am bpm=100', 'Track 2 · bar 1']]);
    assert.equal(tuneSentence('Vocal', r.data!), 'Vocal: Krypt Tune added first in its chain · D minor, Hard · key from the vocal');
    const md: MatchOutcome = { channelId: 'c', semitones: -2, fromKey: 'Am', toKey: 'Gm', resultKey: 'Gm', sourceBpm: 192, reading: 'double time', followsBpm: 142, ratio: 0.74, projectBpm: 142, projectTempoChanged: true, changed: true };
    assert.equal(matchSentence('Vocal', md, 'the project'), 'Vocal moved −2 st (Am → Gm) and follows 142 BPM (read as 192, double time) · project tempo now 142 BPM');
    assert.deepEqual(cautionsIn('"V": moved −2 st. That is a big stretch (×0.73): expect artefacts. Keys: fine.'), ['That is a big stretch (×0.73): expect artefacts.']);
    assert.deepEqual(cautionsIn(`Tuned "V": added Krypt Tune. Key from "B" in F minor, confidence 0.89 (the instrumental), because the vocal's own key reading is weak (C major, confidence 0.38).`), [], 'an informational "Key from" is not a caution');
    assert.deepEqual(cautionsIn('Tuned "V". The key reading is weak: listen, and pass a key.'), ['The key reading is weak: listen, and pass a key.']);
  } finally {
    await close();
  }
});

test('registry + docs: 78 tools incl. import_audio / match_clip / tune_vocal / library_deep; docs/MCP.md and the README agree', () => {
  assert.equal(TOOLS.length, 101);
  assert.deepEqual(['import_audio', 'match_clip', 'tune_vocal', 'library_deep'].map((t) => getTool(t)?.kind), ['write', 'write', 'write', 'transport']);
  const mcpDoc = fs.readFileSync(path.join(ROOT, 'docs', 'MCP.md'), 'utf8');
  assert.match(mcpDoc, new RegExp(`## Tools \\(${TOOLS.length}\\)`));
  for (const t of TOOLS) assert.ok(mcpDoc.includes(`\`${t.name}\``), `docs/MCP.md lists ${t.name}`);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`MCP server with ${TOOLS.length} tools`));
  assert.match(SERVER_INSTRUCTIONS, /import_audio/);
  assert.match(SERVER_INSTRUCTIONS, /match_clip/);
  assert.match(SERVER_INSTRUCTIONS, /tune_vocal/);
  assert.match(SERVER_INSTRUCTIONS, /mashup prompt/);
  assert.match(SERVER_INSTRUCTIONS, /auto_mashup FIRST/);
});

test('mashup prompt: discoverable, every argument optional, the whole workflow', async () => {
  const { deps, close } = await rig();
  try {
    const manifest = (await captureManifest(deps, '0.0.0-test')) as { legacy: { 'prompts/list': { prompts: Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }> } } };
    const p = manifest.legacy['prompts/list'].prompts.find((x) => x.name === 'mashup');
    assert.ok(p, 'mashup prompt listed');
    assert.deepEqual(p!.arguments?.map((a) => [a.name, !!a.required]), [['a', false], ['b', false], ['tune', false]]);
    const text = mashupPrompt({ a: 'Song A', b: 'Song B', tune: 'hard' });
    for (const step of ['auto_mashup FIRST', '"dry_run": true', 'Model Manager', 'backAndForth', 'match_clip', 'tune_vocal', '"tune":"hard"', 'add_clip', 'render_preview', 'masking', 'begin_edit', 'commit_edit', "you can't download models", 'variations', 'rights note']) assert.ok(text.includes(step), step);
    assert.ok(text.indexOf('auto_mashup FIRST') < text.indexOf('tune_vocal'), 'auto_mashup before the manual refinements');
    assert.match(text, /vocal of "Song A" on the instrumental of "Song B"/);
    assert.match(mashupPrompt({}), /If it is not obvious which two songs I mean/);
  } finally {
    await close();
  }
});

await run('vocals');
fs.rmSync(TMP, { recursive: true, force: true });
