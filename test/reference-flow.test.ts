import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { Analysis, SampleInfo } from '@shared/engine/protocol';
import { USER } from '@shared/doc/DocHost';
import type { ActionResult, AgentActivity, FileAccessMode, Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { MCP_CHANNELS } from '../electron/mcp/types';
import { callTool, getTool, newSession, TOOLS, type ToolCaller } from '../electron/mcp/tools';
import { PathConsent, consentElicitation, consentText, type ConsentAsker, type ConsentChoice, type ConsentRequest } from '../electron/mcp/consent';
import { beatPrompt, findAudioReference, likePrompt, parseBeatArgs, SERVER_INSTRUCTIONS } from '../electron/mcp/prompts';
import { BEAT_EXTRA_SLOTS, buildServer, LIKE_EXTRA_SLOTS, type ServerHooks } from '../electron/mcp/server';
import { bandBalance, correlation } from '../electron/mcp/tools/hearing';
import { AnalyzerSupervisor } from '../electron/analyzer/supervisor';
import { ModelManager } from '../electron/analyzer/models';
import { AnalyzerService } from '../electron/analyzer/service';
import { VocalsService } from '../electron/vocals/service';
import { backendFrom, LibraryService } from '../electron/library/service';
import { earsCatalog, fakeSpawn, stageModels, TEST_MODELS, writeFakeAnalyzer } from './fake-analyzer';
import type { ReferenceBrief } from '@shared/reference';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-like-'));
const script = writeFakeAnalyzer(TMP);
const BROWSER = path.join(TMP, 'Browser root');
const DOWNLOADS = path.join(TMP, 'Downloads');
const OTHER = path.join(TMP, 'Other place');
for (const d of [BROWSER, DOWNLOADS, OTHER]) fs.mkdirSync(d, { recursive: true });
const riff = (tag: string) => `RIFF ${tag} ${'x'.repeat(32)}`;
fs.writeFileSync(path.join(BROWSER, 'inside.wav'), riff('inside'));
fs.writeFileSync(path.join(DOWNLOADS, 'My Reference Song.mp3'), riff('ref'));
fs.writeFileSync(path.join(DOWNLOADS, 'second.wav'), riff('second'));
fs.writeFileSync(path.join(DOWNLOADS, 'notes.txt'), 'not audio');
fs.writeFileSync(path.join(OTHER, 'a.wav'), riff('a'));
fs.writeFileSync(path.join(OTHER, 'b.wav'), riff('b'));
const REF = path.join(DOWNLOADS, 'ref key=Am bpm=128.wav');
fs.writeFileSync(REF, riff('reference'));
const SPACED = path.join(DOWNLOADS, 'My Reference Song.mp3');
const real = (p: string) => fs.realpathSync.native(p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function settings0(): Settings {
  return {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [{ id: 'r1', name: 'Browser root', path: BROWSER }],
    recent: [],
    autosaveSec: 60,
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'ask' },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: false,
    library: { fastScan: false, focus: null },
  };
}

async function sampleInfo(p: string): Promise<ActionResult<SampleInfo>> {
  try {
    if (fs.readFileSync(p).subarray(0, 4).toString('latin1') !== 'RIFF') return { ok: false, message: 'Unsupported or corrupt audio file' };
  } catch {
    return { ok: false, message: `File not found: ${p}` };
  }
  return { ok: true, data: { path: p, frames: 352800, sampleRate: 44100, channels: 2, durationSec: 8 } };
}

function scripted(answers: Array<ConsentChoice | 'never' | 'fail'>, where = 'Krypt Studio') {
  const calls: ConsentRequest[] = [];
  let active = 0;
  let most = 0;
  let aborted = 0;
  const asker: ConsentAsker = {
    where,
    async ask(req, signal) {
      calls.push(req);
      active++;
      most = Math.max(most, active);
      try {
        await sleep(15);
        const a = answers.shift() ?? 'deny';
        if (a === 'fail') throw new Error('elicitation failed');
        if (a === 'never') {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          aborted++;
          return 'deny';
        }
        return a;
      } finally {
        active--;
      }
    },
  };
  return { asker, calls, most: () => most, aborted: () => aborted };
}

const RENDER: Analysis = {
  durationSec: 8,
  peakDb: -3,
  truePeakDb: -2.5,
  lufsIntegrated: -14,
  lufsShortTermMax: -12,
  loudnessRange: 4,
  rmsDb: -16,
  crestDb: 10,
  bands: { sub: -16, low: -18, lowMid: -14, mid: -20, highMid: -20, high: -26 },
  stereoCorrelation: 0.8,
  stereoWidth: 0.2,
  energyCurve: [-24, -20, -16, -14, -13, -12, -12, -11],
  clipping: false,
  estimatedBpm: 128,
  spectralCentroidHz: 1800,
};

let n = 0;
async function rig(opts: { dialog?: ConsentAsker | null; timeoutMs?: number; library?: boolean; render?: Analysis; fileAccess?: FileAccessMode; via?: ToolCaller['via'] } = {}) {
  const root = path.join(TMP, `rig${++n}`);
  const userData = path.join(root, 'userData');
  const bundled = path.join(root, 'bundled');
  stageModels(userData, bundled, { stems: true, basicPitch: true });
  const doc = new DocHost(createDefaultProject('Like'), earsCatalog(), { strict: true });
  let settings = settings0();
  if (opts.fileAccess) settings.mcp.fileAccess = opts.fileAccess;
  const log = () => {};
  const activity: AgentActivity[] = [];
  const logs: string[] = [];
  const supervisor = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'not built', log, spawn: fakeSpawn(script), idleShutdownMs: 0 });
  const models = new ModelManager({ catalog: TEST_MODELS, bundledDirs: [bundled], userModelsDir: path.join(userData, 'models'), log });
  const resolveSamplePath = (p: string) => p;
  const analyzer = new AnalyzerService({ doc, supervisor, models, userDataDir: userData, resolveSamplePath, sampleInfo, log });
  await analyzer.init();
  const vocals = new VocalsService({ doc, userDataDir: userData, analyzer, sampleInfo, log });
  const library = opts.library
    ? new LibraryService({ userDataDir: userData, doc, backend: backendFrom(supervisor, models), getSettings: () => settings, updateSettings: (patch) => (settings = { ...settings, ...patch }), log, resumeDelayMs: 0 })
    : undefined;
  if (library) await library.start();
  const getSettings = () => settings;
  const updateSettings = (patch: Partial<Settings>) => (settings = { ...settings, ...patch });
  const broadcast = (channel: string, payload: unknown) => {
    if (channel === MCP_CHANNELS.activity) activity.push(payload as AgentActivity);
  };
  const renders: string[] = [];
  const consent =
    opts.dialog === null
      ? undefined
      : new PathConsent({ getSettings, updateSettings, log: (level, m) => logs.push(`${level} ${m}`), broadcast, dialog: opts.dialog, timeoutMs: opts.timeoutMs });
  const deps: MainDeps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} as never }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async render(job) {
        renders.push(job.path);
        return { ok: true, data: { path: job.path, files: [job.path], durationSec: 8, peakDb: -3, lufsIntegrated: -14, analysis: opts.render ?? RENDER } };
      },
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo,
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Like', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath,
      renderDir: () => path.join(root, 'renders'),
      allowedRoots: () => settings.browserRoots.map((r) => r.path),
    },
    getSettings,
    updateSettings,
    broadcast,
    userDataDir: userData,
    appExePath: process.execPath,
    shimExePath: null,
    log: (level, m) => logs.push(`${level} ${m}`),
    analyzer,
    vocals,
    library,
    consent,
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'claude-code', name: 'Claude Code' }, session: newSession(), via: opts.via ?? 'test' };
  const call = (name: string, args: unknown = {}, asker?: ConsentAsker) => callTool(deps, caller, name, args, { quiet: true, consent: asker });
  const close = async () => {
    await library?.stop();
    await supervisor.stop();
  };
  return { doc, deps, call, consent, activity, logs, renders, library, settings: () => settings, close };
}

test('consent: a file inside the Browser folders is used without asking', async () => {
  const u = scripted(['deny']);
  const r = await rig({ dialog: u.asker });
  try {
    const out = await r.call('import_audio', { path: path.join(BROWSER, 'inside.wav') });
    assert.equal(out.ok, true, out.message);
    assert.equal(u.calls.length, 0, 'never asked');
  } finally {
    await r.close();
  }
});

test('consent: outside the folders → asked; "Allow this file" lasts the session for that file only', async () => {
  const u = scripted(['file', 'deny']);
  const r = await rig({ dialog: u.asker });
  try {
    const out = await r.call('import_audio', { path: SPACED, name: 'Reference: My Reference Song', mute: true });
    assert.equal(out.ok, true, out.message);
    assert.equal(u.calls.length, 1);
    assert.deepEqual([u.calls[0].path, u.calls[0].isDir, u.calls[0].client, u.calls[0].tool], [real(SPACED), false, 'Claude Code', 'import_audio']);
    const d = out.data as { trackId: string; clipId: string };
    assert.equal(r.doc.project.playlist.tracks[d.trackId].mute, true, 'mute: the reference track is muted');
    assert.equal(r.doc.project.playlist.tracks[d.trackId].name, 'Reference: My Reference Song');
    assert.match(out.message, /is muted \(the user unmutes it to A\/B\)/);
    assert.equal((await r.call('analyze_audio', { target: SPACED })).ok, true);
    assert.equal(u.calls.length, 1, 'the session grant covers the file');
    const other = await r.call('load_sample', { sample: path.join(DOWNLOADS, 'second.wav') });
    assert.equal(other.ok, false);
    assert.equal(u.calls.length, 2);
    assert.match(other.message, /The user declined access to "second\.wav"/);
    assert.deepEqual(r.settings().browserRoots.map((x) => x.id), ['r1'], 'no folder added');
    const feed = r.activity.filter((a) => a.tool === 'file access');
    assert.equal(feed.length, 2);
    assert.equal(feed[0].ok, true);
    assert.match(feed[0].summary, /Allowed "My Reference Song\.mp3" until Krypt Studio closes \(import_audio, asked in Krypt Studio\)/);
    assert.equal(feed[1].ok, false);
    assert.ok(r.logs.some((l) => /^info \[agent\] Claude Code asked to read .*My Reference Song\.mp3: Allowed/.test(l)), r.logs.join('\n'));
  } finally {
    await r.close();
  }
});

test('consent: "Allow this folder" adds it to the Browser folders (persisted) and covers its other files', async () => {
  const u = scripted(['folder']);
  const r = await rig({ dialog: u.asker });
  try {
    const out = await r.call('load_sample', { sample: path.join(OTHER, 'a.wav') });
    assert.equal(out.ok, true, out.message);
    const roots = r.settings().browserRoots;
    assert.equal(roots.length, 2);
    assert.equal(roots[1].path, real(OTHER));
    assert.equal(roots[1].name, 'Other place');
    assert.match(roots[1].id, /^root_[0-9a-f]{8}$/);
    assert.equal((await r.call('import_audio', { path: path.join(OTHER, 'b.wav') })).ok, true);
    assert.equal(u.calls.length, 1, 'the second file in that folder needs no question');
    assert.match(r.activity.find((a) => a.tool === 'file access')!.summary, /added to the Browser folders/);
  } finally {
    await r.close();
  }
});

test('consent: deny gives a clear refusal and changes nothing', async () => {
  const u = scripted(['deny']);
  const r = await rig({ dialog: u.asker });
  try {
    const v = r.doc.version;
    const out = await r.call('import_audio', { path: path.join(OTHER, 'a.wav') });
    assert.equal(out.ok, false);
    assert.match(out.message, /^The user declined access to "a\.wav" \(.*Other place\)/);
    assert.equal(r.doc.version, v);
    assert.equal(r.doc.getHistory().length, 0, 'not even an empty history entry');
  } finally {
    await r.close();
  }
});

test('consent: no answer in time → "didn\'t answer in Krypt Studio", and the question is closed', async () => {
  const u = scripted(['never']);
  const r = await rig({ dialog: u.asker, timeoutMs: 1000 });
  try {
    const t0 = Date.now();
    const out = await r.call('import_audio', { path: path.join(OTHER, 'a.wav') });
    assert.equal(out.ok, false);
    assert.match(out.message, /^The user didn't answer in Krypt Studio within 1 s, so "a\.wav" wasn't opened/);
    assert.ok(Date.now() - t0 >= 950);
    await sleep(30);
    assert.equal(u.aborted(), 1, 'the dialog was told to close');
    assert.match(r.activity.at(-1)!.summary, /No answer about "a\.wav" within 1 s/);
  } finally {
    await r.close();
  }
});

test('consent: UNC, device, ADS, relative, non-audio and missing paths are refused without asking', async () => {
  const u = scripted(['file', 'file', 'file', 'file', 'file', 'file', 'file']);
  const r = await rig({ dialog: u.asker });
  try {
    const cases: Array<[string, RegExp]> = [
      ['\\\\server\\share\\song.mp3', /Network \(UNC\) and device paths are not allowed/],
      ['\\\\?\\C:\\song.mp3', /Network \(UNC\) and device paths/],
      ['\\\\.\\C:\\song.mp3', /Network \(UNC\) and device paths/],
      [`${path.join(OTHER, 'a.wav')}:hidden`, /Alternate data streams/],
      ['Downloads\\song.mp3', /must be absolute/],
      [path.join(DOWNLOADS, 'notes.txt'), /"notes\.txt" is not an audio file/],
      [path.join(DOWNLOADS, 'missing.mp3'), /File not found/],
    ];
    for (const [p, why] of cases) {
      const out = await r.call('import_audio', { path: p });
      assert.equal(out.ok, false, p);
      assert.match(out.message, why, p);
    }
    const folder = await r.call('library_import', { folder: '\\\\nas\\music', collection: 'X' });
    assert.match(folder.message, /UNC/);
    const drive = await r.call('library_import', { folder: `${path.parse(TMP).root}`, collection: 'X' });
    assert.match(drive.message, /can't read a whole drive/);
    assert.equal(u.calls.length, 0, 'none of these was put to the user');
  } finally {
    await r.close();
  }
});

test('consent: identical requests share one question; different ones are asked one at a time', async () => {
  const u = scripted(['file', 'file', 'file']);
  const r = await rig({ dialog: u.asker });
  try {
    const same = await Promise.all([r.call('analyze_audio', { target: path.join(OTHER, 'a.wav') }), r.call('analyze_audio', { target: path.join(OTHER, 'a.wav') })]);
    assert.deepEqual(same.map((x) => x.ok), [true, true], same.map((x) => x.message).join(' | '));
    assert.equal(u.calls.length, 1, 'de-duplicated');
    const two = await Promise.all([r.call('analyze_audio', { target: path.join(OTHER, 'b.wav') }), r.call('analyze_audio', { target: path.join(DOWNLOADS, 'second.wav') })]);
    assert.deepEqual(two.map((x) => x.ok), [true, true]);
    assert.equal(u.calls.length, 3);
    assert.equal(u.most(), 1, 'never two questions at once');
  } finally {
    await r.close();
  }
});

test('consent: the client asks first; when its elicitation fails, Krypt Studio asks instead; no consent service = the old refusal', async () => {
  const dialog = scripted(['file']);
  const client = scripted(['fail'], 'Claude Code');
  const r = await rig({ dialog: dialog.asker });
  try {
    const out = await r.call('import_audio', { path: path.join(OTHER, 'a.wav') }, client.asker);
    assert.equal(out.ok, true, out.message);
    assert.deepEqual([client.calls.length, dialog.calls.length], [1, 1]);
    assert.match(r.activity.at(-1)!.summary, /asked in Krypt Studio/);
    const viaClient = scripted(['deny'], 'Claude Code');
    const no = await r.call('import_audio', { path: path.join(OTHER, 'b.wav') }, viaClient.asker);
    assert.match(no.message, /The user declined access to "b\.wav"/);
    assert.match(r.activity.at(-1)!.summary, /asked in Claude Code/);
  } finally {
    await r.close();
  }
  const bare = await rig({ dialog: null });
  try {
    const out = await bare.call('import_audio', { path: path.join(OTHER, 'a.wav') });
    assert.match(out.message, /outside the folders Krypt Studio lets agents read/);
  } finally {
    await bare.close();
  }
});

test('consent texts: the dialog and the elicitation name the client, the file and the folder; drive roots are never offered', () => {
  const win = process.platform === 'win32';
  const req: ConsentRequest = { path: win ? 'C:\\Users\\me\\Downloads\\song.mp3' : '/Users/me/Downloads/song.mp3', isDir: false, client: 'Claude Code', clientId: 'claude-code', tool: 'import_audio' };
  const t = consentText(req);
  assert.equal(t.message, 'Claude Code wants to use "song.mp3" to put it on the Playlist');
  assert.ok(t.detail.startsWith(`From: ${win ? 'C:\\Users\\me\\Downloads' : '/Users/me/Downloads'}`), t.detail);
  assert.deepEqual(t.choices.map((c) => c.label), ['Allow this file', 'Allow this folder', 'Deny']);
  const e = consentElicitation(req);
  assert.equal(e.mode, 'form');
  assert.match(e.message, /Claude Code wants to use "song\.mp3"/);
  const access = e.requestedSchema.properties.access as { oneOf: Array<{ const: string; title: string }> };
  assert.deepEqual(access.oneOf.map((o) => o.const), ['file', 'folder', 'deny']);
  assert.deepEqual(e.requestedSchema.required, ['access']);
  const top = consentText({ ...req, path: win ? 'C:\\song.mp3' : '/song.mp3' });
  assert.deepEqual(top.choices.map((c) => c.value), ['file', 'deny'], 'never "allow the whole drive"');
  const dir = consentText({ ...req, path: win ? 'C:\\Music\\Refs' : '/Music/Refs', isDir: true, tool: 'library_import' });
  assert.deepEqual(dir.choices.map((c) => c.label), ['Allow once', 'Add to Browser folders', 'Deny']);
});

test('beat prompt: garbled positional words become the idea; the referenced song gets the whole workflow', () => {
  const words = `make an edm song like this song, ${REF}`.split(/\s+/);
  const [genre, bpm, key, bars, mood, idea, ...more] = words;
  const parsed = parseBeatArgs({ genre, bpm, key, bars, mood, idea }, more);
  assert.equal(parsed.prose, true);
  assert.equal(parsed.idea, 'make an edm song like this song');
  assert.deepEqual([parsed.reference?.path, parsed.reference?.exists], [REF, true]);
  const text = beatPrompt({ genre, bpm, key, bars, mood, idea }, more);
  assert.match(text, /^Make an edm song in Krypt Studio like a reference song\./);
  assert.ok(text.includes(`study_reference {"file":${JSON.stringify(REF)},"genre":"edm"}`), text);
  for (const step of ['a muted track "Reference: ref key=Am bpm=128"', 'get_playbook {"genre":"edm"}', 'FOLLOWS the reference', "the reference's drum feel", 'check_originality', 'review_song: it grades the song against the reference too', 'never its melody, lyrics, vocal or recognisable hook', 'Leave the reference track muted', 'Only use songs I own or have the rights to'])
    assert.ok(text.includes(step), step);
  assert.match(text, /Style card — edm/);
  assert.doesNotMatch(text, /at an bpm/);
});

test('beat prompt: a path with spaces is joined back; quotes are dropped; positional use still works', () => {
  const q = parseBeatArgs({ idea: 'like' }, `"${SPACED}" but darker`.split(/\s+/));
  assert.deepEqual([q.reference?.path, q.reference?.exists, q.idea], [SPACED, true, 'like but darker']);
  const sp = findAudioReference(['techno', 'like', ...SPACED.split(' '), 'please']);
  assert.deepEqual([sp?.path, sp?.start, sp?.exists], [SPACED, 2, true]);
  const pos = parseBeatArgs({ genre: 'trap', bpm: '140', key: 'F#m', bars: '4', mood: 'dark', idea: 'bouncy' }, ['like', 'driving', 'at', 'night']);
  assert.deepEqual([pos.prose, pos.genre, pos.bpm, pos.key, pos.bars, pos.mood, pos.idea], [false, 'trap', '140', 'F#m', '4', 'dark', 'bouncy like driving at night']);
  assert.match(beatPrompt({ genre: 'trap', bpm: '140', key: 'F#m' }), /^Make a trap beat in Krypt Studio at 140 bpm in F#m\./);
  const refInIdea = parseBeatArgs({ genre: 'house', bpm: '124', key: 'Am', bars: '8', mood: 'deep', idea: REF.split(' ')[0] }, REF.split(' ').slice(1));
  assert.deepEqual([refInIdea.prose, refInIdea.genre, refInIdea.reference?.path], [false, 'house', REF]);
  for (const bad of [{ bpm: '20' }, { bpm: 'fast' }, { key: 'xyz' }, { bars: '2.5' }]) assert.equal(parseBeatArgs({ genre: 'trap', bpm: '140', key: 'Am', bars: '4', ...bad }).prose, true, JSON.stringify(bad));
  const form = beatPrompt({ idea: `an edm song like ${SPACED}` });
  assert.ok(form.includes(`"file":${JSON.stringify(SPACED)}`));
});

test('beat / like prompts: a missing file, a path cut off by Claude Code, a request that may be cut', () => {
  const missing = beatPrompt({ idea: 'like C:\\Nowhere\\gone.mp3' });
  assert.match(missing, /can't find that file/);
  const cut = beatPrompt({ genre: 'make', bpm: 'it', key: 'like', bars: 'C:\\Users\\Krypt\\My', mood: 'Music', idea: 'Folder' });
  assert.match(cut, /arrived cut off here: "C:\\\\Users\\\\Krypt\\\\My Music Folder"/);
  assert.match(cut, /read the FULL path from my slash command/);
  const slots = 6 + BEAT_EXTRA_SLOTS;
  const words = Array.from({ length: slots }, (_, i) => `word${i}`);
  const long = beatPrompt({ genre: words[0], bpm: words[1], key: words[2], bars: words[3], mood: words[4], idea: words[5] }, words.slice(6), { slots });
  assert.match(long, /may be cut off here/);
  const like = likePrompt({ song: SPACED.split(' ')[0], request: SPACED.split(' ')[1] }, [...SPACED.split(' ').slice(2), 'make', 'it', 'techno']);
  assert.match(like, /^Make a song in Krypt Studio like a reference song, as techno\./);
  assert.match(like, /My request: "make it techno"/);
  assert.ok(like.includes(`study_reference {"file":${JSON.stringify(SPACED)},"genre":"techno"}`));
  const noPath = likePrompt({ song: 'that', request: 'song' });
  assert.match(noPath, /I gave no file path Krypt Studio could read/);
  assert.match(likePrompt({ song: SPACED }), /No genre named: make it in the reference's own genre/);
});

async function promptsAs(client: string | null, get?: { name: string; arguments: Record<string, string> }) {
  const r = await rig();
  const hooks: ServerHooks = { caller: () => ({ actor: { kind: 'agent', clientId: 'x', name: 'X' }, session: newSession(), via: 'mcp' }), gate: () => null, client: () => client, pendingConsent: new Map() };
  const [c, s] = InMemoryTransport.createLinkedPair();
  const answers = new Map<number, any>();
  c.onmessage = (m) => {
    const mm = m as { id?: number; result?: unknown; error?: unknown };
    if (typeof mm.id === 'number') answers.set(mm.id, mm.result ?? { error: mm.error });
  };
  await c.start();
  const handle = serveStdio(() => buildServer(r.deps, '0.0.0-test', hooks), { transport: s });
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: client ?? 'x', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} },
    ...(get ? [{ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: get }] : []),
  ] as JSONRPCMessage[];
  for (const m of msgs) await c.send(m);
  for (let i = 0; i < 100 && answers.size < (get ? 3 : 2); i++) await sleep(20);
  await handle.close();
  await r.close();
  return { list: answers.get(2) as { prompts: Array<{ name: string; arguments?: Array<{ name: string }> }> }, got: answers.get(3) as { messages: Array<{ content: { text: string } }> } | undefined };
}

test('Claude Code gets extra word slots on beat / like; other clients keep their form fields', async () => {
  const words = `make an edm song like this song, ${SPACED}`.split(/\s+/);
  const cc = await promptsAs('claude-code');
  const beat = cc.list.prompts.find((p) => p.name === 'beat')!;
  assert.equal(beat.arguments!.length, 6 + BEAT_EXTRA_SLOTS);
  assert.deepEqual(beat.arguments!.slice(0, 7).map((a) => a.name), ['genre', 'bpm', 'key', 'bars', 'mood', 'idea', 'more1']);
  const like = cc.list.prompts.find((p) => p.name === 'like')!;
  assert.equal(like.arguments!.length, 2 + LIKE_EXTRA_SLOTS);
  const other = await promptsAs('claude-ai');
  assert.deepEqual(other.list.prompts.find((p) => p.name === 'beat')!.arguments!.map((a) => a.name), ['genre', 'bpm', 'key', 'bars', 'mood', 'idea']);
  assert.deepEqual(other.list.prompts.find((p) => p.name === 'like')!.arguments!.map((a) => a.name), ['song', 'request']);
  const names = beat.arguments!.map((a) => a.name);
  const zipped = Object.fromEntries(names.map((k, i) => [k, words[i]]).filter(([, v]) => v !== undefined));
  const got = await promptsAs('claude-code', { name: 'beat', arguments: zipped as Record<string, string> });
  const text = got.got!.messages[0].content.text;
  assert.ok(text.includes(`study_reference {"file":${JSON.stringify(SPACED)}`), text);
  assert.match(text, /The user describes it as: "make an edm song like this song"/);
});

test('server instructions: the like workflow in one sentence, still under Claude Code\'s 2048-character cut', () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2048, `${SERVER_INSTRUCTIONS.length} chars`);
  for (const w of ['study_reference', 'a path they drop in', 'muted', 'Reference: <name>', 'get_playbook (it follows the reference)', 'ORIGINAL', 'check_originality', 'review_song grades against it', 'the user is asked first']) assert.ok(SERVER_INSTRUCTIONS.includes(w), w);
});

test('library_import: one song into "References" (created), its track id returned; outside the folders it is asked about', async () => {
  const u = scripted(['file']);
  const r = await rig({ dialog: u.asker, library: true });
  try {
    fs.writeFileSync(path.join(BROWSER, 'Ref One.wav'), riff('ref one'));
    const one = await r.call('library_import', { file: path.join(BROWSER, 'Ref One.wav'), collection: 'References' });
    assert.equal(one.ok, true, one.message);
    assert.match(one.message, /Created collection "References"\. Added 1 track/);
    const d = one.data as { collectionId: string; added: number; trackId?: string };
    assert.equal(d.added, 1);
    assert.match(d.trackId ?? '', /^lt_/);
    assert.equal(u.calls.length, 0);
    const out = await r.call('library_import', { file: REF, collection: 'References' });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual([u.calls.length, u.calls[0].tool, u.calls[0].isDir], [1, 'library_import', false]);
    assert.equal(r.library!.collections().length, 1);
    assert.equal((await r.library!.query({ collectionId: d.collectionId })).data!.total, 2);
    const both = await r.call('library_import', { file: REF, folder: BROWSER, collection: 'References' });
    assert.match(both.message, /either folder .* or file/);
    const notAudio = await r.call('library_import', { file: path.join(DOWNLOADS, 'notes.txt'), collection: 'References' });
    assert.match(notAudio.message, /not an audio file/);
  } finally {
    await r.close();
  }
});

test('compare_to_reference: tempo, key, loudness, band balance, width and energy shape against the reference, in plain words', async () => {
  const r = await rig({ dialog: scripted(['file']).asker });
  try {
    assert.equal((await r.call('set_tempo', { bpm: 128 })).ok, true);
    const w = await r.call('write_pattern', { kpn: 'pattern "Drop" bars=4 key=Am\nkick: x... x... x... x... | x... x... x... x... | x... x... x... x... | x... x... x... x...\nKeys: Am:16 | F:16 | C:16 | G:16' });
    assert.equal(w.ok, true, w.message);
    const imp = await r.call('import_audio', { path: REF, name: 'Reference: Song', mute: true });
    assert.equal(imp.ok, true, imp.message);
    const out = await r.call('compare_to_reference', { reference: 'Reference: Song', scope: 'pattern', pattern: 'Drop', key: 'Am' });
    assert.equal(out.ok, true, out.message);
    const c = out.data as {
      tempo: { project: number; reading: number; diff: number };
      key: { project: string; reference: string; relation: string };
      loudness: { project: number; reference: number; diff: number };
      bands: { groups: Record<string, number>; diff: Record<string, number> };
      width: { project: number; reference: number };
      energy: { correlation: number; partial: boolean };
      suggestions: string[];
    };
    assert.deepEqual([c.tempo.project, c.tempo.reading, c.tempo.diff], [128, 128, 0]);
    assert.deepEqual([c.key.project, c.key.reference, c.key.relation], ['Am', 'Am', 'same']);
    assert.deepEqual([c.loudness.project, c.loudness.reference, c.loudness.diff], [-14, -9.5, -4.5]);
    assert.ok(c.bands.groups['low end'] < -2 && c.bands.groups.highs > 2, JSON.stringify(c.bands.groups));
    assert.deepEqual([c.width.project, c.width.reference], [0.2, 0.4]);
    assert.ok(c.energy.correlation > 0.8, `${c.energy.correlation}`);
    assert.equal(c.energy.partial, false);
    const all = c.suggestions.join('\n');
    assert.match(all, /your low end \d dB under the reference/);
    assert.match(all, /your highs \d dB over the reference/);
    assert.match(all, /4\.5 dB quieter than the reference/);
    assert.match(all, /narrower than the reference/);
    assert.doesNotMatch(all, /^Tempo/m);
    assert.match(out.text!, /balance {3}sub /);
    assert.match(out.text!, /Match the feel, not the song/);
    assert.equal(r.renders.length, 1);
    assert.match(path.basename(r.renders[0]), /^compare-/);
    assert.equal(out.warnings, undefined, 'the reference track is muted');
    assert.equal(getTool('compare_to_reference')?.kind, 'read');
  } finally {
    await r.close();
  }
});

test('compare_to_reference: warns when the reference plays in the render; a file path works too; helpers', async () => {
  const r = await rig({ dialog: scripted(['file']).asker });
  try {
    const imp = await r.call('import_audio', { path: REF, name: 'Reference: Loud' });
    assert.equal(imp.ok, true, imp.message);
    await r.call('write_pattern', { kpn: 'pattern "A" bars=4\nkick: x... x... x... x... | x... x... x... x... | x... x... x... x... | x... x... x... x...' });
    await r.call('arrange', { placements: [{ pattern: 'A', bars: '1-4' }] });
    const out = await r.call('compare_to_reference', { reference: 'Reference: Loud', scope: 'song' });
    assert.equal(out.ok, true, out.message);
    assert.match(out.warnings?.[0] ?? '', /The reference plays in this render/);
    const trackId = (imp.data as { trackId: string }).trackId;
    r.doc.exec('playlist.setTrack', { id: trackId, mute: true }, { actor: { kind: 'user' } });
    const byPath = await r.call('compare_to_reference', { reference: REF, scope: 'song' });
    assert.equal(byPath.ok, true, byPath.message);
    assert.equal(byPath.warnings, undefined);
    assert.match(byPath.message, /the song \(4 bars, to its last audible clip\)/);
    assert.equal((byPath.data as { render: { seconds: number } }).render.seconds, 6.9, '4 bars at 140 bpm, not the 8 s reference');
  } finally {
    await r.close();
  }
  assert.deepEqual(bandBalance({ sub: -10, low: -10, lowMid: -10, mid: -10, highMid: -10, high: -10 }), { sub: -7.8, low: -7.8, lowMid: -7.8, mid: -7.8, highMid: -7.8, high: -7.8 });
  assert.equal(bandBalance({ sub: -10 }), null);
  assert.equal(correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(correlation([1, 2, 3], [5, 5, 5]), null);
});

const FULL = path.join(DOWNLOADS, 'fullsong house.wav');
fs.writeFileSync(FULL, riff('fullsong'));

test('study_reference: the song lands muted as "Reference: …" and comes back as a brief; a second call re-reads it', async () => {
  const u = scripted(['file']);
  const r = await rig({ dialog: u.asker, library: true });
  try {
    const out = await r.call('study_reference', { file: FULL });
    assert.equal(out.ok, true, out.message);
    const d = out.data as { channelId: string; clipId: string; name: string; brief: ReferenceBrief };
    assert.equal(d.name, 'Reference: fullsong house');
    const p = r.doc.project;
    assert.equal(p.playlist.tracks[p.playlist.clips[d.clipId].trackId].mute, true, 'its track is muted');
    const b = d.brief;
    assert.deepEqual([b.bpm, b.key, b.form, b.totalBars, b.drums?.fourOnFloor, b.drums?.backbeat, b.mix.lufs], [128, 'Am', 'A B C D C A', 64, true, 'two-four', -8.5]);
    assert.deepEqual(b.plan.map((x) => [x.startBar, x.bars, x.energy]), [[1, 8, 0.1], [9, 8, 0.6], [17, 16, 1], [33, 8, 0.2], [41, 16, 1], [57, 8, 0.25]]);
    assert.equal(b.drums?.source, 'stem', 'the drums come from the drum stem (a stem model is installed)');
    assert.deepEqual(b.harmony.loop, ['i', 'VI', 'III', 'VII']);
    assert.ok(['house', 'tech-house', 'deep-house', 'techno', 'edm'].includes(b.genre ?? ''), b.genre ?? 'no genre');
    assert.equal(b.genreSource, 'guessed');
    assert.match(out.message, /^Studied "fullsong house" \(imported on track \d+, muted, drums from the drum stem in \d+ s\): 128 bpm, Am, closest genre /);
    for (const s of ['REFERENCE — "fullsong house"', 'Sections (bars at 128 bpm', 'four-on-the-floor kick', 'Harmony: Am F C G (i VI III VII) loop', 'References collection', 'One prompt = a finished song', 'get_playbook {"genre":', 'check_originality, match_mix, then review_song', 'set_tempo refuses a tempo more than 3% off it', 'NEXT: build_from_reference'])
      assert.ok(out.text!.includes(s), `${s}\n${out.text}`);
    assert.match(out.text!.split('\n').pop()!, /^NEXT: build_from_reference /, 'the result ends with the next call');
    assert.equal(u.calls.length, 1, 'asked once about the file outside the Browser folders');
    assert.ok(r.library!.collections().some((c) => c.name === 'References' && c.counts.total === 1), 'added to References');
    const again = await r.call('study_reference', { file: FULL, genre: 'house' });
    assert.equal(again.ok, true, again.message);
    assert.match(again.message, /already on the Playlist/);
    assert.equal(Object.values(r.doc.project.channels).filter((c) => c.name.startsWith('Reference')).length, 1);
    assert.deepEqual([(again.data as { brief: ReferenceBrief }).brief.genre, (again.data as { brief: ReferenceBrief }).brief.genreSource], ['house', 'given']);
    const bare = await r.call('study_reference', {});
    assert.equal(bare.ok, true, bare.message);
    assert.match(bare.message, /the project's reference/);
    const imp = await r.call('import_audio', { path: path.join(BROWSER, 'inside.wav'), name: 'Their Song' });
    const adopt = await r.call('study_reference', { clip: (imp.data as { clipId: string }).clipId });
    assert.equal(adopt.ok, true, adopt.message);
    const ch = r.doc.project.channels[(adopt.data as { channelId: string }).channelId];
    assert.equal(ch.name, 'Reference: Their Song');
    assert.equal(r.doc.project.playlist.tracks[(imp.data as { trackId: string }).trackId].mute, true);
    assert.equal(getTool('study_reference')?.kind, 'write');
    assert.equal((await r.call('study_reference', { file: FULL, clip: 'x' })).ok, false);
  } finally {
    await r.close();
  }
});

test('get_playbook follows the reference (tempo, key, section plan, drum feel); review_song grades against it and refuses an unmuted reference', async () => {
  const r = await rig({ dialog: scripted(['file']).asker });
  try {
    assert.equal((await r.call('study_reference', { file: FULL, genre: 'house' })).ok, true);
    const pb = await r.call('get_playbook', { genre: 'house' });
    assert.equal(pb.ok, true, pb.message);
    const data = pb.data as { bpm: number; key: string; totalBars: number; sections: Array<{ name: string; bars: number; energy: number }>; reference: { name: string; arrangement: string } };
    assert.deepEqual([data.bpm, data.key, data.totalBars], [128, 'Am', 64]);
    assert.deepEqual(data.sections.map((s) => [s.bars, s.energy]), [[8, 0.1], [8, 0.6], [16, 1], [8, 0.2], [16, 1], [8, 0.25]]);
    assert.deepEqual([data.reference.name, data.reference.arrangement], ['fullsong house', 'sections']);
    assert.match(pb.message, /following the reference "fullsong house" \(its section plan\)/);
    for (const s of ['REFERENCE SONG "fullsong house" (the muted track "Reference: fullsong house")', 'Its chord loop: Am F C G (i VI III VII)', 'check_originality: rewrite any line', 'Like fullsong house']) assert.ok(pb.text!.includes(s), s);
    const none = await r.call('get_playbook', { genre: 'house', reference: 'none' });
    assert.doesNotMatch(none.text!, /REFERENCE SONG/);
    const auto = await r.call('get_playbook', {});
    assert.match(auto.message, /the reference song's closest genre/);

    assert.equal((await r.call('set_tempo', { bpm: 128 })).ok, true);
    assert.equal((await r.call('write_pattern', { kpn: 'pattern "Drop" bars=4 key=Am\nkick: x... x... x... x... | x... x... x... x... | x... x... x... x... | x... x... x... x...' })).ok, true);
    assert.equal((await r.call('arrange', { placements: [{ pattern: 'Drop', bars: '1-4' }] })).ok, true);
    const rv = await r.call('review_song', { genre: 'house' });
    assert.equal(rv.ok, true, rv.message);
    assert.match(rv.text!, /against the reference "fullsong house" \(its sections, energy shape, loudness and tonal balance\) with House playbook targets/);
    assert.match(rv.text!, /vs the reference: tempo 128 vs 128 bpm · loudness -14 vs -8\.5 LUFS · balance low end -?\d/);
    const rd = rv.data as { targets: { lufs: number }; reference: { comparison: { bands: { groups: Record<string, number> } } } };
    assert.equal(rd.targets.lufs, -8.5, "the reference's loudness is the target");
    assert.ok(rd.reference.comparison.bands.groups['low end'] < -2);
    const refCh = Object.values(r.doc.project.channels).find((c) => c.name === 'Reference: fullsong house')!;
    const clip = Object.values(r.doc.project.playlist.clips).find((c) => c.channelId === refCh.id)!;
    r.doc.exec('playlist.setTrack', { id: clip.trackId, mute: false }, { actor: { kind: 'user' } });
    const loud = await r.call('review_song', {});
    assert.equal(loud.ok, false);
    assert.match(loud.message, /isn't muted.*set_channel \{"channel":"Reference: fullsong house","mute":true\}/);
    assert.equal((await r.call('set_channel', { channel: 'Reference: fullsong house', mute: true })).ok, true);
    assert.equal((await r.call('review_song', {})).ok, true);
    assert.doesNotMatch((await r.call('review_song', { genre: 'house', reference: 'none' })).text!, /vs the reference/);
  } finally {
    await r.close();
  }
});

async function pipeClient(pipe: string, token: string) {
  const net = await import('node:net');
  return new Promise<{ send: (m: unknown) => void; next: () => Promise<any>; close: () => void }>((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    const lines: any[] = [];
    const waiters: Array<(v: any) => void> = [];
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const w = waiters.shift();
        if (w) w(msg);
        else lines.push(msg);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ krypt: 'hello', v: 1, token, client: 'claude-code' })}\n`);
      resolve({
        send: (m) => sock.write(`${JSON.stringify(m)}\n`),
        next: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r))),
        close: () => sock.destroy(),
      });
    });
  });
}

test('pipe: a 2025-era client that declared elicitation is asked with elicitation/create while the call waits', async () => {
  if (process.platform !== 'win32') return;
  const dialog = scripted(['deny']);
  const r = await rig({ dialog: dialog.asker });
  const { startMcp } = await import('../electron/mcp/index');
  fs.mkdirSync(r.deps.userDataDir, { recursive: true });
  process.env.KRYPT_MCP_PIPE_SUFFIX = `like-legacy-${process.pid}`;
  const mcp = await Promise.resolve(startMcp(r.deps));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(r.deps.userDataDir, 'mcp.json'), 'utf8'));
    for (let i = 0; i < 100 && !mcp.status().pipeName; i++) await sleep(20);
    const c = await pipeClient(cfg.pipe, cfg.token);
    assert.equal((await c.next()).krypt, 'welcome');
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'claude-code', version: 't' } } });
    assert.equal((await c.next()).id, 1);
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'import_audio', arguments: { path: path.join(OTHER, 'a.wav') } } });
    const ask = await c.next();
    assert.equal(ask.method, 'elicitation/create', JSON.stringify(ask));
    assert.equal(ask.params.mode, 'form');
    assert.match(ask.params.message, /Claude Code wants to use "a\.wav"/);
    c.send({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: { access: 'folder' } } });
    const res = await c.next();
    assert.equal(res.id, 2);
    assert.equal(res.result.isError, false, JSON.stringify(res.result));
    assert.ok(r.settings().browserRoots.some((x) => x.path === real(OTHER)), 'folder added');
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'import_audio', arguments: { path: path.join(OTHER, 'b.wav') } } });
    const res2 = await c.next();
    assert.equal(res2.id, 3);
    assert.equal(res2.result.isError, false, JSON.stringify(res2.result));
    c.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'import_audio', arguments: { path: path.join(DOWNLOADS, 'second.wav') } } });
    const ask2 = await c.next();
    c.send({ jsonrpc: '2.0', id: ask2.id, result: { action: 'decline' } });
    const res3 = await c.next();
    assert.equal(res3.result.isError, true);
    assert.match(res3.result.content[0].text, /The user declined access to "second\.wav"/);
    assert.equal(dialog.calls.length, 0, 'the client asked; Krypt Studio never had to');
    c.close();
  } finally {
    await mcp.stop();
    delete process.env.KRYPT_MCP_PIPE_SUFFIX;
    await r.close();
  }
});

test('pipe: on protocol 2026-07-28 the question goes back as input_required and the retry carries the answer; no elicitation → the dialog', async () => {
  if (process.platform !== 'win32') return;
  const dialog = scripted(['file']);
  const r = await rig({ dialog: dialog.asker });
  const { startMcp } = await import('../electron/mcp/index');
  fs.mkdirSync(r.deps.userDataDir, { recursive: true });
  process.env.KRYPT_MCP_PIPE_SUFFIX = `like-modern-${process.pid}`;
  const mcp = await Promise.resolve(startMcp(r.deps));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(r.deps.userDataDir, 'mcp.json'), 'utf8'));
    for (let i = 0; i < 100 && !mcp.status().pipeName; i++) await sleep(20);
    const c = await pipeClient(cfg.pipe, cfg.token);
    assert.equal((await c.next()).krypt, 'welcome');
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: 't' } };
    c.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
    const disc = await c.next();
    assert.ok(disc.result, JSON.stringify(disc));
    const call = { name: 'import_audio', arguments: { path: path.join(OTHER, 'a.wav'), name: 'Reference: A', mute: true } };
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { ...call, _meta: meta } });
    const first = await c.next();
    assert.equal(first.result.resultType, 'input_required', JSON.stringify(first));
    const [key, req] = Object.entries(first.result.inputRequests as Record<string, { method: string; params: { message: string; requestedSchema: unknown } }>)[0];
    assert.equal(req.method, 'elicitation/create');
    assert.match(req.params.message, /wants to use "a\.wav"/);
    assert.equal(r.doc.getHistory().length, 0, 'nothing ran yet');
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { ...call, _meta: meta, inputResponses: { 'krypt-file-access-0000000000000000': { action: 'accept', content: { access: 'file' } } } } });
    assert.equal((await c.next()).result.resultType, 'input_required');
    c.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { ...call, _meta: meta, inputResponses: { [key]: { action: 'accept', content: { access: 'file' } } } } });
    const done = await c.next();
    assert.equal(done.id, 4);
    assert.equal(done.result.isError, false, JSON.stringify(done.result));
    assert.match(done.result.content[0].text, /Imported "Reference: A"/);
    assert.equal(dialog.calls.length, 0);
    const plain = { ...meta, 'io.modelcontextprotocol/clientCapabilities': {} };
    c.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'analyze_audio', arguments: { target: path.join(OTHER, 'b.wav') }, _meta: plain } });
    const viaDialog = await c.next();
    assert.equal(viaDialog.result.isError, false, JSON.stringify(viaDialog.result));
    assert.equal(dialog.calls.length, 1);
    c.close();
  } finally {
    await mcp.stop();
    delete process.env.KRYPT_MCP_PIPE_SUFFIX;
    await r.close();
  }
});

test('file access "anywhere" (the default): any local audio file opens without a prompt, and it is logged', async () => {
  const u = scripted(['deny']);
  const r = await rig({ dialog: u.asker, fileAccess: 'anywhere' });
  try {
    const out = await r.call('import_audio', { path: SPACED, name: 'Reference: song', mute: true });
    assert.equal(out.ok, true, out.message);
    assert.equal((await r.call('analyze_audio', { target: path.join(OTHER, 'a.wav') })).ok, true);
    assert.equal((await r.call('load_sample', { sample: path.join(DOWNLOADS, 'second.wav') })).ok, true);
    const lib = await rig({ dialog: u.asker, fileAccess: 'anywhere', library: true });
    try {
      const imp = await lib.call('library_import', { folder: DOWNLOADS, collection: 'Anywhere' });
      assert.equal(imp.ok, true, imp.message);
      assert.match((await lib.call('library_import', { folder: path.parse(TMP).root, collection: 'Drive' })).message, /can't read a whole drive/);
    } finally {
      await lib.close();
    }
    assert.equal(u.calls.length, 0, 'never asked');
    assert.ok(r.logs.some((l) => /^info \[agent\] Claude Code import_audio reads .*My Reference Song\.mp3 \(File access: anywhere\)/.test(l)), r.logs.join('\n'));
    assert.deepEqual(r.settings().browserRoots.map((x) => x.id), ['r1'], 'no folder added');
  } finally {
    await r.close();
  }
  const fresh = await rig({ dialog: null });
  try {
    delete (fresh.deps.getSettings().mcp as { fileAccess?: FileAccessMode }).fileAccess;
    assert.equal((await fresh.call('import_audio', { path: path.join(OTHER, 'b.wav') })).ok, true);
  } finally {
    await fresh.close();
  }
});

test('file access: UNC, device, ADS, relative, non-audio and missing paths are refused in EVERY mode, never asked', async () => {
  for (const mode of ['anywhere', 'ask', 'browser'] as const) {
    const u = scripted(['file', 'file', 'file', 'file', 'file', 'file', 'file']);
    const r = await rig({ dialog: u.asker, fileAccess: mode });
    try {
      const cases: Array<[string, RegExp]> = [
        ['\\\\attacker\\share\\song.mp3', /Network \(UNC\) and device paths are not allowed.*would send your Windows login to that host/],
        ['//attacker/share/song.mp3', /Network \(UNC\)/],
        ['\\\\?\\C:\\song.mp3', /Network \(UNC\) and device paths/],
        ['\\\\.\\C:\\song.mp3', /Network \(UNC\) and device paths/],
        [`${path.join(OTHER, 'a.wav')}:hidden`, /Alternate data streams/],
        ['Downloads\\song.mp3', /must be absolute/],
        [path.join(DOWNLOADS, 'notes.txt'), /"notes\.txt" is not an audio file/],
        [path.join(DOWNLOADS, 'missing.mp3'), /File not found/],
      ];
      for (const [p, why] of cases) {
        const out = await r.call('import_audio', { path: p });
        assert.equal(out.ok, false, `${mode}: ${p}`);
        assert.match(out.message, why, `${mode}: ${p}`);
      }
      assert.equal(u.calls.length, 0, `${mode}: none of these was put to the user`);
    } finally {
      await r.close();
    }
  }
});

test('file access "browser": outside files are refused with the setting named; no prompts', async () => {
  const u = scripted(['file']);
  const r = await rig({ dialog: u.asker, fileAccess: 'browser', library: true });
  try {
    assert.equal((await r.call('import_audio', { path: path.join(BROWSER, 'inside.wav') })).ok, true);
    const out = await r.call('analyze_audio', { target: path.join(OTHER, 'a.wav') });
    assert.equal(out.ok, false);
    assert.match(out.message, /outside the folders Krypt Studio lets agents read \(Settings ▸ Agents ▸ File access is set to "Browser folders only"\)/);
    assert.match(out.message, /or to set File access to "Anywhere" or "Ask me"/);
    assert.match((await r.call('library_import', { folder: OTHER, collection: 'X' })).message, /only import folders inside/);
    assert.equal(u.calls.length, 0);
  } finally {
    await r.close();
  }
});

test('file access: a song the user dropped in is ALWAYS readable (clip, channel and its own path), in every mode', async () => {
  for (const mode of ['browser', 'ask', 'anywhere'] as const) {
    const u = scripted(['deny']);
    const r = await rig({ dialog: u.asker, fileAccess: mode });
    try {
      const p = r.doc.project;
      const drop = r.doc.exec<{ clipId: string; channelId: string }>('playlist.addAudio', { path: SPACED, name: 'Dropped Song', trackId: p.playlist.trackOrder[0], start: 0, frames: 352800, sampleRate: 44100 }, { actor: USER });
      assert.equal(drop.ok, true, drop.message);
      for (const target of [drop.data!.clipId, 'Dropped Song', SPACED, `"${SPACED}"`]) {
        const out = await r.call('analyze_audio', { target });
        assert.equal(out.ok, true, `${mode}: ${target}: ${out.message}`);
      }
      const cmp = await r.call('audio_to_pattern', { target: SPACED, mode: 'drums' });
      assert.equal(cmp.ok, true, `${mode}: audio_to_pattern by path: ${cmp.message}`);
      const other = await r.call('analyze_audio', { target: path.join(DOWNLOADS, 'second.wav') });
      assert.equal(other.ok, mode === 'anywhere', `${mode}: second.wav ${other.message}`);
      assert.equal(u.calls.length, mode === 'ask' ? 1 : 0, `${mode}: asked only about second.wav, and only in ask mode`);
    } finally {
      await r.close();
    }
  }
});

test('file access: the HTTP endpoint never gets "anywhere" (it is asked like "ask"); pipe clients do', async () => {
  const u = scripted(['deny']);
  const http = await rig({ dialog: u.asker, fileAccess: 'anywhere', via: 'http' });
  try {
    const out = await http.call('import_audio', { path: path.join(OTHER, 'a.wav') });
    assert.equal(out.ok, false);
    assert.match(out.message, /The user declined access to "a\.wav"/);
    assert.equal(u.calls.length, 1, 'asked');
  } finally {
    await http.close();
  }
  const pipe = await rig({ dialog: scripted([]).asker, fileAccess: 'anywhere', via: 'mcp' });
  try {
    assert.equal((await pipe.call('import_audio', { path: path.join(OTHER, 'a.wav') })).ok, true);
  } finally {
    await pipe.close();
  }
  const { fileAccessMode } = await import('../electron/mcp/tools/util');
  const s = (fileAccess?: FileAccessMode) => ({ mcp: { enabled: true, httpEnabled: true, httpPort: 1, requireConsentForDestructive: false, fileAccess } });
  assert.deepEqual([fileAccessMode(s(), 'mcp'), fileAccessMode(s('anywhere'), 'http'), fileAccessMode(s('browser'), 'http'), fileAccessMode(s('ask'), 'panel')], ['anywhere', 'ask', 'browser', 'ask']);
});

test('registry: 83 tools incl. compare_to_reference and study_reference; docs and README agree', () => {
  assert.equal(TOOLS.length, 101);
  const root = path.resolve(import.meta.dirname, '..', '..');
  const doc = fs.readFileSync(path.join(root, 'docs', 'MCP.md'), 'utf8');
  assert.match(doc, /## Tools \(101\)/);
  assert.ok(doc.includes('`compare_to_reference`') && doc.includes('`study_reference`'));
  assert.match(doc, /\/krypt-studio:like/);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /MCP server with 101 tools/);
  assert.ok(getTool('import_audio')!.paths, 'path tools declare their paths');
  for (const t of ['import_audio', 'load_sample', 'add_channel', 'analyze_audio', 'audio_to_pattern', 'library_import', 'compare_to_reference', 'set_cover', 'study_reference']) assert.ok(getTool(t)?.paths, t);
});

await run('reference flow');
fs.rmSync(TMP, { recursive: true, force: true });
