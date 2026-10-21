import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { Analysis } from '@shared/engine/protocol';
import type { AudioAnalysis, DrumHit, StemName } from '@shared/analyzer/protocol';
import type { ActionResult, FileAccessMode, Settings } from '@shared/types';
import type { SongTranscription } from '@shared/transcription/types';
import type { SoundFingerprint } from '@shared/sound-match/types';
import { PPQ } from '@shared/schema/time';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { PathConsent, type ConsentAsker } from '../electron/mcp/consent';
import { SERVER_INSTRUCTIONS, likePrompt } from '../electron/mcp/prompts';
import { AudioProjectService, OWNERSHIP_LINE, setAudioProject } from '../electron/audioProject';
import type { TranscribeCore } from '../electron/audioProject/core';
import type { SoundMatcher } from '../electron/audioProject/sounds';
import { earsCatalog } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-a2p-'));
const BROWSER = path.join(TMP, 'Browser');
const OUTSIDE = path.join(TMP, 'Outside');
for (const d of [BROWSER, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
const riff = (tag: string) => `RIFF ${tag} ${'x'.repeat(32)}`;
const SONG = path.join(BROWSER, 'My Song.wav');
fs.writeFileSync(SONG, riff('song'));
const ELSEWHERE = path.join(OUTSIDE, 'Other Song.mp3');
fs.writeFileSync(ELSEWHERE, riff('other'));
const STEMS: Record<StemName, string> = {} as Record<StemName, string>;
for (const s of ['drums', 'bass', 'other', 'vocals'] as StemName[]) {
  STEMS[s] = path.join(TMP, 'stems', `${s}.wav`);
  fs.mkdirSync(path.dirname(STEMS[s]), { recursive: true });
  fs.writeFileSync(STEMS[s], riff(s));
}
const KICK_SAMPLE = path.join(TMP, 'kits', 'Matched Kick.wav');
fs.mkdirSync(path.dirname(KICK_SAMPLE), { recursive: true });
fs.writeFileSync(KICK_SAMPLE, riff('kick'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LEVELS: Analysis = {
  durationSec: 45,
  peakDb: -1,
  truePeakDb: -0.8,
  lufsIntegrated: -9,
  lufsShortTermMax: -7,
  loudnessRange: 5,
  rmsDb: -11,
  crestDb: 9,
  bands: { sub: -10, low: -12, lowMid: -14, mid: -20, highMid: -24, high: -30 },
  stereoCorrelation: 0.5,
  stereoWidth: 0.4,
  energyCurve: [-20, -14, -9, -9],
  clipping: false,
  estimatedBpm: 128,
  spectralCentroidHz: 1800,
};

function analysis(p: string): AudioAnalysis {
  const beat = 60 / 128;
  const t0 = 0.5;
  const times = Array.from({ length: 96 }, (_, i) => t0 + i * beat);
  const hits: DrumHit[] = [];
  times.forEach((t, i) => {
    hits.push({ timeSec: t, role: 'kick', vel: 0.9 });
    if (i % 4 === 1 || i % 4 === 3) hits.push({ timeSec: t, role: 'snare', vel: 0.8 });
    hits.push({ timeSec: t + beat / 2, role: 'hat', vel: 0.5 });
  });
  const roots = [9, 5, 0, 7];
  const chords = Array.from({ length: 24 }, (_, b) => ({ startSec: t0 + b * 4 * beat, endSec: t0 + (b + 1) * 4 * beat, root: roots[b % 4], quality: (b % 4 === 0 ? 'min' : 'maj') as 'min' | 'maj', confidence: 0.8 }));
  const bar = 4 * beat;
  return {
    path: p,
    durationSec: t0 + 24 * bar,
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: 128, confidence: 0.9, alternatives: [64, 256] },
    beats: { times, downbeats: times.filter((_, i) => i % 4 === 0), beatsPerBar: 4 },
    key: { tonic: 'A', mode: 'minor', name: 'Am', confidence: 0.8 },
    swing: 0,
    sections: [
      { startSec: t0, endSec: t0 + 8 * bar, label: 'A', lufs: -14 },
      { startSec: t0 + 8 * bar, endSec: t0 + 16 * bar, label: 'B', lufs: -8 },
      { startSec: t0 + 16 * bar, endSec: t0 + 24 * bar, label: 'B', lufs: -8 },
    ],
    levels: LEVELS,
    stereo: { width: 0.4, correlation: 0.5 },
    energy: { hopSec: 0.5, lufs: Array.from({ length: 92 }, (_, i) => (i < 30 ? -14 : -8)) },
    onsetRate: 6,
    chords,
    drumHits: hits,
    estimated: ['tempo', 'key'],
    sources: ['fake'],
  };
}

const BAR = 4 * PPQ;
const notesEvery = (bars: number, perBar: number, key: number, dur: number, vel = 0.8) =>
  Array.from({ length: bars * perBar }, (_, i) => ({ tick: Math.round((i * BAR) / perBar), key, dur, vel }));

function transcription(mode: 'exact' | 'style'): SongTranscription {
  return {
    name: 'My Song',
    durationSec: 45.5,
    bpm: 128,
    beatsPerBar: 4,
    key: 'Am',
    swingPercent: 0,
    firstDownbeatSec: 0.5,
    totalBars: 24,
    sections: [
      { label: 'A', name: 'Intro', startBar: 1, bars: 8, energy: 0.4, lufs: -14, sameAs: null },
      { label: 'B', name: 'Drop 1', startBar: 9, bars: 8, energy: 1, lufs: -8, sameAs: null },
      { label: 'B', name: 'Drop 2', startBar: 17, bars: 8, energy: 1, lufs: -8, sameAs: 1 },
    ],
    chords: [],
    parts: [
      { name: 'Kick', stem: 'drums', kind: 'drum', drumRole: 'kick', notes: notesEvery(24, 4, 60, 240), confidence: 0.9 },
      { name: 'Snare', stem: 'drums', kind: 'drum', drumRole: 'snare', notes: notesEvery(24, 2, 60, 240).map((n) => ({ ...n, tick: n.tick + PPQ })), confidence: 0.9 },
      { name: 'Bass', stem: 'bass', kind: 'bass', notes: notesEvery(24, 2, 45, 900), confidence: 0.8 },
      { name: 'Chords', stem: 'other', kind: 'chords', notes: [...notesEvery(24, 1, 57, BAR), ...notesEvery(24, 1, 60, BAR), ...notesEvery(24, 1, 64, BAR)], confidence: 0.7 },
      { name: 'Lead', stem: 'other', kind: 'lead', notes: notesEvery(24, 4, 72, 200), confidence: 0.6 },
      ...(mode === 'exact' ? [{ name: 'Vocal', stem: 'vocals' as const, kind: 'vocal-audio' as const, notes: [], confidence: 1 }] : []),
    ],
    stems: { ...STEMS },
    notes: ['Fake core note.'],
  };
}

const FP: SoundFingerprint = { lengthSec: 0.25, centroidHz: 180, rolloffHz: 400, flatness: 0.1, harmonicity: 0.5, f0Hz: 50, attackMs: 2, decayMs: 180, sustain: 0.1, bands: { sub: 0, low: -3, lowMid: -12, mid: -20, highMid: -24, high: -30 }, crestDb: 12, width: 0, peakDb: -1, rmsDb: -12 };

interface Gate {
  stems?: Promise<void>;
  entered?: () => void;
}

function rig(opts: { dirty?: boolean; fileAccess?: FileAccessMode; asker?: ConsentAsker; gate?: Gate; noStems?: boolean; sectionRms?: Partial<Record<StemName, number[]>> } = {}) {
  const doc = new DocHost(createDefaultProject('Start'), earsCatalog(), { strict: true });
  let dirty = !!opts.dirty;
  let settings: Settings = {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [{ id: 'r1', name: 'Browser', path: BROWSER }],
    recent: [],
    autosaveSec: 60,
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: opts.fileAccess ?? 'anywhere' },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: false,
    library: { fastScan: false, focus: null },
  };
  const calls: string[] = [];
  const analyzer = {
    async analyze(target: { path?: string; channelId?: string }, o: { cachedOnly?: boolean } = {}): Promise<ActionResult<AudioAnalysis>> {
      calls.push(`analyze${o.cachedOnly ? ':cached' : ''}`);
      return { ok: true, data: analysis(target.path ?? 'ref.wav') };
    },
    async stemFiles(_t: unknown, _o: unknown, run: { signal?: AbortSignal } = {}) {
      calls.push('stems');
      opts.gate?.entered?.();
      if (opts.gate?.stems) await opts.gate.stems;
      if (run.signal?.aborted) return { ok: false, message: 'Stem separation cancelled' };
      if (opts.noStems) return { ok: true, data: null, message: 'No stem model is installed' };
      const stems: Record<string, { path: string; peakDb: number; rmsDb: number }> = {};
      for (const [k, v] of Object.entries(STEMS)) stems[k] = { path: v, peakDb: -3, rmsDb: k === 'drums' ? -14 : k === 'bass' ? -16 : -20 };
      return { ok: true, data: { stems, model: 'htdemucs', modelName: 'HT-Demucs', device: 'cpu' as const, cached: true, seconds: 0 } };
    },
    async transcribeFile(_p: string, mode: string) {
      calls.push(`transcribe:${mode}`);
      return { ok: true, data: { mode: mode as 'poly', notes: [], hits: [], source: 'fake' } };
    },
    async fingerprint(file: string, segs?: Array<{ startSec: number; endSec: number }>) {
      calls.push('fingerprint');
      const stem = (Object.keys(STEMS) as StemName[]).find((k) => STEMS[k] === file);
      const rms = stem ? opts.sectionRms?.[stem] : undefined;
      if (rms && segs && segs.length === rms.length) return { ok: true, data: { segments: rms.map((rmsDb) => ({ ...FP, rmsDb })) } };
      return { ok: true, data: { segments: [FP] } };
    },
    listModels: () => [{ def: { id: 'basic-pitch', task: 'transcribe' }, status: 'installed' }] as never,
    async drumStemHits() {
      return { ok: true, data: null };
    },
    separateStems: async () => ({ ok: false, message: 'n/a' }),
    toPattern: async () => ({ ok: false, message: 'n/a' }),
  };
  const consent = opts.asker ? new PathConsent({ getSettings: () => settings, updateSettings: (p) => (settings = { ...settings, ...p }), log: () => {}, broadcast: () => {}, dialog: opts.asker, timeoutMs: 2000 }) : undefined;
  const deps: MainDeps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} as never }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async () => ({ ok: false, message: 'n/a' }),
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo: async (p: string) => ({ ok: true, data: { path: p, frames: 44100 * 46, sampleRate: 44100, channels: 2, durationSec: 46 } }),
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Start', dirty, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p: string) => p,
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => settings.browserRoots.map((r) => r.path),
      newProject: () => {
        doc.reset(createDefaultProject('Untitled'));
        dirty = false;
        return { ok: true, message: 'New project' };
      },
    },
    getSettings: () => settings,
    updateSettings: (p) => (settings = { ...settings, ...p }),
    broadcast: () => {},
    userDataDir: path.join(TMP, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    analyzer: analyzer as never,
    consent,
  };
  const seen: { mode?: string; mine?: boolean } = {};
  const core: TranscribeCore = {
    transcribeSong: (_src, o) => {
      seen.mode = o.mode;
      seen.mine = o.mine;
      return transcription(o.mode);
    },
    melodyShape: () => ({ source: 'vocals', notes: 40, medianKey: 69, medianName: 'A4', low: 64, high: 76, rangeSemis: 12, notesPerBar: 4, rhythm: { sixteenths: 0.2, eighths: 0.5, quarters: 0.2, long: 0.1 }, phraseBars: 2, restRatio: 0.3, intervals: { repeats: 0.2, steps: 0.6, leaps: 0.2 }, onBeat: 0.5 }),
  };
  const matcher: SoundMatcher = async (_fps, target) =>
    target.kind === 'drum' && target.role === 'kick'
      ? { ok: true, matches: [{ source: { kind: 'sample', path: KICK_SAMPLE, sampleKind: 'kick' }, similarity: 0.91, why: ['close'], tweaks: { pitch: -2, gainDb: -3 } }] }
      : { ok: true, matches: [] };
  const svc = new AudioProjectService({ deps, core, matcher });
  setAudioProject(doc, svc);
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'claude-code', name: 'Claude Code' }, session: newSession(), via: 'test' };
  const progress: Array<{ fraction: number; message: string }> = [];
  const call = (name: string, args: unknown = {}, o: { signal?: AbortSignal } = {}) =>
    callTool(deps, caller, name, args, { quiet: true, signal: o.signal, onProgress: (fraction, message) => progress.push({ fraction, message }) });
  return { doc, deps, svc, call, calls, seen, progress, caller, setDirty: (v: boolean) => (dirty = v) };
}

const channelNames = (doc: DocHost) => doc.project.channelOrder.map((id) => doc.project.channels[id].name);
const agentEntries = (doc: DocHost) => doc.getHistory().filter((h) => h.actorKey.startsWith('agent') && !h.undone);
const notesOf = (doc: DocHost, channelName: string) => {
  const ch = Object.values(doc.project.channels).find((c) => c.name === channelName);
  if (!ch) return -1;
  return Object.values(doc.project.patterns).reduce((n, p) => n + Object.keys(p.notes[ch.id] ?? {}).length, 0);
};

test('audio_to_project: a NEW project with channels, a pattern per section (repeats reused), arrangement, markers, stems muted and the vocal audible, in ONE undo step', async () => {
  const r = rig();
  const out = await r.call('audio_to_project', { path: SONG });
  assert.equal(out.ok, true, out.message);
  const p = r.doc.project;
  assert.equal(p.meta.name, 'My Song', 'title = the file name');
  assert.equal(p.transport.bpm, 128);
  assert.equal(p.transport.mode, 'song');
  assert.deepEqual(channelNames(r.doc).slice(0, 5), ['Kick', 'Snare', 'Bass', 'Chords', 'Lead'], 'the default kit is gone; one channel per part');
  assert.equal(r.seen.mode, 'exact');
  assert.deepEqual(p.patternOrder.map((id) => p.patterns[id].name), ['Intro', 'Drop 1']);
  const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern').sort((a, b) => a.start - b.start);
  assert.deepEqual(clips.map((c) => [c.start / BAR + 1, p.patterns[c.patternId!].name]), [[1, 'Intro'], [9, 'Drop 1'], [17, 'Drop 1']]);
  assert.deepEqual(Object.values(p.playlist.markers).map((m) => m.name).sort(), ['Drop 1', 'Drop 2', 'Intro']);
  assert.ok(notesOf(r.doc, 'Lead') > 0, "exact: the song's own lead is transcribed");
  for (const n of ['Kick', 'Bass', 'Chords']) {
    const ch = Object.values(p.channels).find((c) => c.name === n)!;
    assert.equal(p.mixer.inserts[ch.insertId].name, n);
  }
  const kick = Object.values(p.channels).find((c) => c.name === 'Kick')!;
  assert.equal(p.samples[kick.generator.sampleId!].path, KICK_SAMPLE);
  assert.equal(kick.pitch, -2);
  const audio = Object.values(p.playlist.clips).filter((c) => c.kind === 'audio');
  assert.equal(audio.length, 4);
  for (const c of audio) {
    const ch = p.channels[c.channelId!];
    const muted = p.playlist.tracks[c.trackId].mute;
    assert.equal(muted, !/Vocals/.test(ch.name), `${ch.name} muted=${muted}`);
    assert.equal(ch.generator.params.tempo_sync, 1);
    assert.equal(ch.generator.params.src_bpm, 128);
    assert.equal(c.start, 0);
    assert.equal(c.offset, Math.round(0.5 * (128 / 60) * PPQ), 'the pickup before bar 1 is skipped');
  }
  const bass = Object.values(p.channels).find((c) => c.name === 'Bass')!;
  const duck = Object.values(p.mixer.inserts[bass.insertId].slots).find((s) => s.type === 'krypt.duck');
  assert.ok(duck && duck.sidechainFrom === kick.insertId, 'bass sidechained to the kick');
  const o = out.data as { sounds: string[]; notes: string[]; stemsKept: boolean; patterns: number; sections: number };
  assert.ok(o.sounds.some((s) => /^Kick → Matched Kick \(similarity 0\.91\)/.test(s)), o.sounds.join(' | '));
  assert.ok(o.sounds.some((s) => /^Bass → .*picked by role/.test(s)));
  assert.ok(o.notes.includes(OWNERSHIP_LINE));
  assert.ok(o.notes.includes('Fake core note.'));
  assert.equal(o.stemsKept, true);
  assert.equal(o.patterns, 2);
  assert.match(out.text ?? '', /If this isn't your song, use the result for practice and remix study, not for release\./);
  assert.ok(r.progress.length >= 5 && r.progress.some((x) => /stems/i.test(x.message)));
  assert.equal(r.doc.getHistory().length, 1, 'one history entry');
  const undo = await r.call('undo_last');
  assert.equal(undo.ok, true, undo.message);
  assert.deepEqual(channelNames(r.doc), ['Kick', 'Clap', 'Hat', 'Snare', '808', 'Keys'], 'back to a fresh default project');
  assert.equal(Object.keys(r.doc.project.playlist.clips).length, 0);
});

test("audio_to_project follows the stems' dynamics: a part drops out where its stem is silent, a quieter repeat gets its own pattern with softer notes", async () => {
  const r = rig({ sectionRms: { drums: [-60, -10, -10], bass: [-14, -2, -12] } });
  const out = await r.call('audio_to_project', { path: SONG });
  assert.equal(out.ok, true, out.message);
  const p = r.doc.project;
  const byName = (n: string) => p.patternOrder.map((id) => p.patterns[id]).find((x) => x.name === n)!;
  const ch = (n: string) => Object.values(p.channels).find((c) => c.name === n)!;
  const count = (pat: { notes: Record<string, Record<string, unknown>> }, n: string) => Object.keys(pat.notes[ch(n).id] ?? {}).length;
  assert.equal(count(byName('Intro'), 'Kick'), 0, 'no kick where the drum stem is silent');
  assert.ok(count(byName('Drop 1'), 'Kick') > 0);
  assert.deepEqual(p.patternOrder.map((id) => p.patterns[id].name), ['Intro', 'Drop 1', 'Drop 2']);
  const vel = (n: string) => Object.values(byName(n).notes[ch('Bass').id] ?? {}).map((x) => (x as { vel: number }).vel);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  assert.ok(vel('Drop 2').length > 0 && avg(vel('Drop 2')) < avg(vel('Drop 1')) * 0.6, `softer: ${avg(vel('Drop 2'))} vs ${avg(vel('Drop 1'))}`);
  assert.ok((out.data as { notes: string[] }).notes.some((n) => /Followed the reference's dynamics/.test(n)));
});

test('audio_to_project: keep_stems false keeps only the vocal; without a stem model it reads the mix and says so', async () => {
  const r = rig();
  const out = await r.call('audio_to_project', { path: SONG, keep_stems: false, parts: ['drums', 'bass'] });
  assert.equal(out.ok, true, out.message);
  const audio = Object.values(r.doc.project.playlist.clips).filter((c) => c.kind === 'audio');
  assert.equal(audio.length, 1);
  assert.match(r.doc.project.channels[audio[0].channelId!].name, /Vocals/);
  assert.deepEqual(channelNames(r.doc), ['Kick', 'Snare', 'Bass', 'My Song · Vocals']);

  const r2 = rig({ noStems: true });
  const out2 = await r2.call('audio_to_project', { path: SONG });
  assert.equal(out2.ok, true, out2.message);
  const o = out2.data as { notes: string[]; stemsKept: boolean };
  assert.ok(o.notes.some((n) => /No stem model is installed/.test(n)), o.notes.join('\n'));
  assert.equal(o.stemsKept, false);
  assert.ok(!r2.calls.includes('transcribe:mono'), 'no stems: nothing to transcribe per stem');
  assert.ok(r2.calls.includes('transcribe:poly'), "the mix's notes instead");
});

test('audio_to_project: cancelling mid-way writes nothing', async () => {
  let release!: () => void;
  let entered!: () => void;
  const inStems = new Promise<void>((res) => (entered = res));
  const gate: Gate = { stems: new Promise<void>((res) => (release = res)), entered: () => entered() };
  const r = rig({ gate });
  const v0 = r.doc.version;
  const pending = r.call('audio_to_project', { path: SONG });
  await inStems;
  assert.equal(r.svc.busy, 'My Song');
  const second = await r.svc.convert(SONG, {}, { kind: 'new', actor: USER });
  assert.equal(second.ok, false);
  assert.match(second.message ?? '', /Already converting "My Song"/);
  assert.equal(r.svc.cancel().ok, true);
  release();
  const out = await pending;
  assert.equal(out.ok, false);
  assert.match(out.message, /Cancelled: nothing was changed/);
  assert.equal(r.doc.version, v0, 'the document never changed');
  assert.equal(r.doc.getHistory().length, 0);
  assert.equal(r.svc.busy, null);
  const ctrl = new AbortController();
  ctrl.abort();
  const aborted = await r.call('audio_to_project', { path: SONG }, { signal: ctrl.signal });
  assert.equal(aborted.ok, false);
  assert.equal(r.doc.version, v0);
});

test("audio_to_project: 'new' is refused while the project has unsaved changes; into 'current' adds the parts as one step", async () => {
  const r = rig({ dirty: true });
  const v0 = r.doc.version;
  const out = await r.call('audio_to_project', { path: SONG });
  assert.equal(out.ok, false);
  assert.match(out.message, /Save or close the current project first \(or ask me to add it to this one with into: 'current'\)/);
  assert.equal(r.doc.version, v0);
  assert.deepEqual(r.calls, [], 'refused before any analysis');

  const cur = await r.call('audio_to_project', { path: SONG, into: 'current', keep_stems: false });
  assert.equal(cur.ok, true, cur.message);
  assert.equal(r.doc.project.meta.name, 'Start', 'the open project keeps its name');
  assert.ok(channelNames(r.doc).includes('Clap'), "the open project's channels stay");
  assert.equal(agentEntries(r.doc).length, 1, 'one undo step');
  const undo = await r.call('undo_last');
  assert.equal(undo.ok, true);
  assert.equal(Object.keys(r.doc.project.playlist.clips).length, 0);
});

test('audio_to_project: file consent works like import_audio (asked outside the Browser folders; refused when declined)', async () => {
  const asks: string[] = [];
  const asker: ConsentAsker = {
    where: 'Krypt Studio',
    async ask(req) {
      asks.push(req.path);
      await sleep(5);
      return 'deny';
    },
  };
  const r = rig({ fileAccess: 'ask', asker });
  const inside = await r.call('audio_to_project', { path: SONG, keep_stems: false });
  assert.equal(inside.ok, true, inside.message);
  assert.equal(asks.length, 0, 'inside the Browser folders: no question');
  const v = r.doc.version;
  const out = await r.call('audio_to_project', { path: ELSEWHERE, into: 'current' });
  assert.equal(out.ok, false);
  assert.equal(asks.length, 1);
  assert.match(out.message, /declined/);
  assert.equal(r.doc.version, v);
  const browserOnly = rig({ fileAccess: 'browser' });
  const refused = await browserOnly.call('audio_to_project', { path: ELSEWHERE });
  assert.equal(refused.ok, false);
  assert.deepEqual(browserOnly.calls, []);
});

function withReference(r: ReturnType<typeof rig>) {
  const tr = r.doc.project.playlist.trackOrder[0];
  const add = r.doc.exec<{ clipId: string; channelId: string; trackId?: string }>('playlist.addAudio', { path: SONG, name: 'Reference: My Song', trackId: tr, start: 0, frames: 44100 * 46, sampleRate: 44100, channels: 2 }, { actor: USER });
  assert.equal(add.ok, true, add.message);
  r.doc.exec('channels.set', { id: add.data!.channelId, name: 'Reference: My Song' }, { actor: USER });
  r.doc.exec('playlist.setTrack', { id: tr, mute: true }, { actor: USER });
  return add.data!;
}

test('build_from_reference: the instrumental bed in one step, an EMPTY matched Lead, the melody shape; never the lead or vocal in style', async () => {
  const r = rig();
  const ref = withReference(r);
  const out = await r.call('build_from_reference', {});
  assert.equal(out.ok, true, out.message);
  assert.equal(r.seen.mode, 'style');
  assert.equal(r.seen.mine, false);
  assert.equal(agentEntries(r.doc).length, 1, 'one undo step');
  assert.equal(r.doc.project.transport.bpm, 128);
  assert.equal(notesOf(r.doc, 'Lead'), 0, 'no lead notes');
  assert.equal(notesOf(r.doc, 'Vocal'), -1, 'no vocal channel');
  assert.ok(notesOf(r.doc, 'Kick') > 0 && notesOf(r.doc, 'Bass') > 0 && notesOf(r.doc, 'Chords') > 0);
  const stemPaths = new Set(Object.values(STEMS));
  assert.ok(!Object.values(r.doc.project.samples).some((x) => stemPaths.has(x.path)), "no stem of the reference is used in the new song");
  const audio = Object.values(r.doc.project.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === ref.channelId);
  assert.equal(audio.length, 1);
  assert.equal(r.doc.project.channels[ref.channelId].generator.params.tempo_sync, 1);
  assert.equal(audio[0].offset, Math.round(0.5 * (128 / 60) * PPQ));
  assert.equal(r.doc.project.playlist.tracks[audio[0].trackId].mute, true);
  const d = out.data as { melodyShape: { medianName: string } | null; lead: { channel: string; sections: string[] } };
  assert.equal(d.melodyShape?.medianName, 'A4');
  assert.equal(d.lead.channel, 'Lead');
  assert.deepEqual(d.lead.sections, ['Drop 1', 'Drop 2']);
  assert.match(out.message, /NOT copied/);
  const text = out.text ?? '';
  assert.match(text, /Melody shape/);
  assert.ok(text.indexOf('write_pattern an ORIGINAL melody') < text.indexOf('check_originality'));
  assert.ok(text.indexOf('check_originality') < text.indexOf('match_mix'));
  assert.ok(text.indexOf('match_mix') < text.indexOf('review_song'));
  assert.match(text, /Bass -2, Chords -6/);
  assert.equal((await r.call('undo_last')).ok, true);
  assert.equal(notesOf(r.doc, 'Bass'), -1);

  const mine = rig();
  withReference(mine);
  const own = await mine.call('build_from_reference', { mine: true });
  assert.equal(own.ok, true, own.message);
  assert.ok(notesOf(mine.doc, 'Lead') > 0, 'the user\'s own song: the lead is kept');
});

test('build_from_reference: without a studied reference it asks for study_reference first', async () => {
  const r = rig();
  const out = await r.call('build_from_reference', {});
  assert.equal(out.ok, false);
  assert.match(out.message, /call study_reference \{"file":"<the song the user gave>"\} first/i);
});

test('set_tempo: locked to the studied reference (±3% of ×0.5 / ×1 / ×2) unless override', async () => {
  const r = rig();
  assert.equal((await r.call('set_tempo', { bpm: 175 })).ok, true, 'no reference: anything goes');
  withReference(r);
  const off = await r.call('set_tempo', { bpm: 175 });
  assert.equal(off.ok, false);
  assert.match(off.message, /Refused: the studied reference "My Song" plays at 64 \/ 128 \/ 256 bpm/);
  assert.match(off.message, /override: true/);
  assert.ok(r.calls.includes('analyze:cached'), 'the lock reads the cached analysis only');
  for (const bpm of [128, 130, 64, 256, 125]) assert.equal((await r.call('set_tempo', { bpm })).ok, true, `${bpm}`);
  assert.equal((await r.call('set_tempo', { bpm: 132 })).ok, false, '3.1% off');
  const forced = await r.call('set_tempo', { bpm: 175, override: true });
  assert.equal(forced.ok, true, forced.message);
  assert.equal(r.doc.project.transport.bpm, 175);
  assert.equal((await r.call('set_tempo', { time_signature: '3/4' })).ok, true, 'a meter change alone is never locked');
});

test('SERVER_INSTRUCTIONS and the like prompt send agents to build_from_reference first (still ≤ 2048 characters)', () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2048, `${SERVER_INSTRUCTIONS.length} chars`);
  for (const w of ['build_from_reference FIRST', 'audio_to_project', 'its tempo is locked', 'match_mix', 'ORIGINAL melody']) assert.ok(SERVER_INSTRUCTIONS.includes(w), w);
  const like = likePrompt({ song: SONG });
  const i = (s: string) => like.indexOf(s);
  assert.ok(i('study_reference') >= 0 && i('study_reference') < i('build_from_reference'));
  assert.ok(i('build_from_reference') < i('Write an ORIGINAL melody on "Lead"'));
  assert.ok(i('Write an ORIGINAL melody') < i('check_originality') && i('check_originality') < i('match_mix') && i('match_mix') < i('7. review_song'));
});

void run('audio-project');
