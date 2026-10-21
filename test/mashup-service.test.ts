// Auto Mashup service (electron/mashup) + the auto_mashup MCP tool, over an
// in-process fake analyzer (analysis per file name, cached / separated stems,
// vocal-stem loudness per section) and the real DocHost + commands:
//
//  - check reads both songs and plans without editing or separating;
//  - build is ONE history entry (a new project, or new tracks in the open
//    one) and one undo restores the project exactly;
//  - vocalOverBeat / stemBlend / backAndForth place sensible tracks, clips
//    per section (warped, pitched), markers, the vocal chain and sends;
//  - a style that needs stems without a stem model is refused with the
//    Model Manager hint (check lists it as a problem); backAndForth works;
//  - cancelling during separation leaves the project untouched;
//  - the key comes from the stems' notes (light reads of the vocal / bass /
//    other stems) and every song is level-matched;
//  - auto_mashup: dry_run, a build into the open project, File access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { Analysis } from '@shared/engine/protocol';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { ActionResult, AudioTarget, FileAccessMode, Settings } from '@shared/types';
import type { MashupCheck, MashupOutcome, MashupProgress, MashupRequest } from '@shared/mashup/types';
import { MASHUP_RIGHTS_NOTE } from '@shared/mashup/types';
import { PPQ } from '@shared/schema/time';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { MashupService, setMashup, cleanMashupRequest } from '../electron/mashup';
import { earsCatalog } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-mashup-'));
const BROWSER = path.join(TMP, 'Browser');
const OUTSIDE = path.join(TMP, 'Outside');
for (const d of [BROWSER, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
const riff = (tag: string) => `RIFF ${tag} ${'x'.repeat(32)}`;
const VOCAL = path.join(BROWSER, 'Vocal Song.wav');
const BEAT = path.join(BROWSER, 'Beat Song.wav');
const FAR = path.join(OUTSIDE, 'Far Song.wav');
for (const f of [VOCAL, BEAT, FAR]) fs.writeFileSync(f, riff(path.basename(f)));
const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'] as const;
const stemPath = (song: string, stem: string) => path.join(TMP, 'stems', song, `${stem}.wav`);
for (const song of ['Vocal Song', 'Beat Song', 'Far Song']) {
  for (const s of STEM_NAMES) {
    fs.mkdirSync(path.dirname(stemPath(song, s)), { recursive: true });
    fs.writeFileSync(stemPath(song, s), riff(`${song} ${s}`));
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────

const BPM = 120;
const BAR = 2; // seconds per bar at 120 bpm
const T0 = 0.5; // first downbeat
/** [label, bars, lufs, vocal stem rms dB] */
type Sec = [string, number, number, number];
const SONGS: Record<string, { key: string; secs: Sec[]; rms: Record<string, number> }> = {
  'Vocal Song': {
    key: 'Gm',
    secs: [['I', 8, -16, -70], ['V', 16, -11, -18], ['H', 8, -7, -16], ['V', 16, -11, -18], ['H', 8, -7, -16], ['O', 8, -16, -70]],
    rms: { vocals: -16, drums: -20, bass: -22, other: -21 },
  },
  'Beat Song': {
    key: 'Am',
    secs: [['A', 8, -15, -70], ['B', 16, -10, -30], ['C', 16, -6, -28], ['D', 8, -14, -70], ['C', 16, -6, -28], ['A', 8, -15, -70]],
    rms: { vocals: -30, drums: -14, bass: -16, other: -18 },
  },
  'Far Song': {
    key: 'C',
    secs: [['A', 8, -15, -70], ['B', 16, -9, -20], ['A', 8, -15, -70]],
    rms: { vocals: -20, drums: -15, bass: -17, other: -19 },
  },
};
const songOf = (file: string) => Object.keys(SONGS).find((n) => path.basename(file).startsWith(n)) ?? 'Vocal Song';
const barsOf = (song: string) => SONGS[song].secs.reduce((n, s) => n + s[1], 0);
const durOf = (song: string) => T0 + barsOf(song) * BAR + 1;

const LEVELS: Analysis = { durationSec: 100, peakDb: -1, truePeakDb: -0.8, lufsIntegrated: -9, lufsShortTermMax: -7, loudnessRange: 5, rmsDb: -11, crestDb: 9, bands: { sub: -10, low: -12, lowMid: -14, mid: -20, highMid: -24, high: -30 }, stereoCorrelation: 0.5, stereoWidth: 0.4, energyCurve: [-12, -9], clipping: false, estimatedBpm: BPM, spectralCentroidHz: 1800 };

function analysis(file: string): AudioAnalysis {
  const song = songOf(file);
  const s = SONGS[song];
  const bars = barsOf(song);
  const times = Array.from({ length: bars * 4 }, (_, i) => T0 + i * 0.5);
  let bar = 0;
  const sections = s.secs.map(([label, n, lufs]) => {
    const x = { startSec: bar === 0 ? 0 : T0 + bar * BAR, endSec: T0 + (bar + n) * BAR, label, lufs };
    bar += n;
    return x;
  });
  return {
    path: file,
    durationSec: durOf(song),
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: BPM, confidence: 0.9, alternatives: [60, 240] },
    beats: { times, downbeats: times.filter((_, i) => i % 4 === 0), beatsPerBar: 4 },
    key: { tonic: s.key.replace(/m$/, ''), mode: s.key.endsWith('m') ? 'minor' : 'major', name: s.key, confidence: 0.8 },
    swing: 0,
    sections,
    levels: LEVELS,
    stereo: { width: 0.4, correlation: 0.5 },
    energy: { hopSec: 0.5, lufs: [-12, -9] },
    onsetRate: 5,
    estimated: ['tempo', 'key'],
    sources: ['fake'],
  };
}

/** A pitch profile: the scale of `tonic` with the tonic and fifth strongest. */
function profileOf(tonic: number, minor: boolean): number[] {
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const p = new Array<number>(12).fill(0.01);
  for (const s of steps) p[(tonic + s) % 12] = 0.1;
  p[tonic % 12] = 0.2;
  p[(tonic + 7) % 12] = 0.15;
  const t = p.reduce((x, y) => x + y, 0);
  return p.map((v) => v / t);
}
/** What each song's stems play (by default: its key label). */
const STEM_PROFILES: Record<string, Record<string, number[]>> = {
  'Vocal Song': { vocals: profileOf(7, true), bass: profileOf(7, true), other: profileOf(7, true) },
  'Beat Song': { vocals: profileOf(9, true), bass: profileOf(9, true), other: profileOf(9, true) },
  'Far Song': { vocals: profileOf(0, false), bass: profileOf(0, false), other: profileOf(0, false) },
};

interface RigOpts {
  /** Override what a song's vocal stem sings (a pitch profile). */
  vocalProfile?: Record<string, number[]>;
  noModel?: boolean;
  /** Stems already separated (cached) for these songs. */
  cached?: string[];
  fileAccess?: FileAccessMode;
  dirty?: boolean;
  gate?: { stems: Promise<void>; entered: () => void };
}

function rig(opts: RigOpts = {}) {
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
  const cached = new Set(opts.cached ?? []);
  const fileOfTarget = (t: AudioTarget): string => {
    if ('path' in t) return t.path;
    const p = doc.project;
    const chId = 'clipId' in t ? p.playlist.clips[t.clipId]?.channelId : t.channelId;
    const ch = chId ? p.channels[chId] : undefined;
    return ch?.generator.sampleId ? p.samples[ch.generator.sampleId].path : '';
  };
  const analyzer = {
    async analyze(t: AudioTarget, o: { light?: boolean } = {}): Promise<ActionResult<AudioAnalysis>> {
      const f = fileOfTarget(t);
      if (!f || !fs.existsSync(f)) return { ok: false, message: `File not found: ${f}` };
      // A stem: TMP/stems/<song>/<stem>.wav.
      const stemOfSong = f.includes(`${path.sep}stems${path.sep}`) ? path.basename(path.dirname(f)) : null;
      if (stemOfSong) {
        const stem = path.basename(f, '.wav');
        calls.push(`${o.light ? 'light' : 'analyze'} ${stemOfSong} ${stem}`);
        const profile = (stem === 'vocals' && opts.vocalProfile?.[stemOfSong]) || STEM_PROFILES[stemOfSong][stem];
        return { ok: true, data: { ...analysis(f), pitchProfile: profile, key: null } };
      }
      calls.push(`analyze ${songOf(f)}`);
      return { ok: true, data: analysis(f) };
    },
    async stemFiles(t: AudioTarget, o: { cachedOnly?: boolean } = {}, runO: { signal?: AbortSignal; onProgress?: (s: string, f: number) => void } = {}) {
      const song = songOf(fileOfTarget(t));
      if (opts.noModel) return { ok: true, data: null, message: 'No stem model is installed' };
      if (o.cachedOnly && !cached.has(song)) return { ok: true, data: null, message: 'The stems are not cached yet' };
      if (!o.cachedOnly) {
        calls.push(`separate ${song}`);
        runO.onProgress?.('separating', 0.5);
        opts.gate?.entered();
        if (opts.gate) await opts.gate.stems;
        if (runO.signal?.aborted) return { ok: false, message: 'Stem separation cancelled' };
        cached.add(song);
      }
      const stems: Record<string, { path: string; peakDb: number; rmsDb: number }> = {};
      for (const s of STEM_NAMES) stems[s] = { path: stemPath(song, s), peakDb: -3, rmsDb: SONGS[song].rms[s] };
      return { ok: true, data: { stems, model: 'htdemucs', modelName: 'HT-Demucs', device: 'cpu' as const, cached: !!o.cachedOnly, seconds: 0 } };
    },
    async fingerprint(file: string, segs?: Array<{ startSec: number; endSec: number }>) {
      calls.push(`fingerprint ${path.basename(file)}`);
      const song = Object.keys(SONGS).find((n) => file.includes(`${path.sep}${n}${path.sep}`));
      if (!song || !segs) return { ok: false, message: 'n/a' };
      return { ok: true, data: { segments: SONGS[song].secs.map((x) => ({ lengthSec: 1, rmsDb: x[3], centroidHz: 1000 })) } };
    },
    listModels: () => (opts.noModel ? [] : [{ def: { id: 'htdemucs', task: 'stems' }, status: 'installed' }]) as never,
    separateStems: async () => ({ ok: false, message: 'n/a' }),
    toPattern: async () => ({ ok: false, message: 'n/a' }),
    drumStemHits: async () => ({ ok: true, data: null }),
  };
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
      sampleInfo: async (p: string) => {
        const d = durOf(songOf(p.includes(`${path.sep}stems${path.sep}`) ? path.basename(path.dirname(p)) : p));
        return { ok: true, data: { path: p, frames: Math.round(44100 * d), sampleRate: 44100, channels: 2, durationSec: d } };
      },
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
  };
  const svc = new MashupService({ deps });
  setMashup(doc, svc);
  const progress: MashupProgress[] = [];
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'claude-code', name: 'Claude Code' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { doc, deps, svc, calls, progress, onProgress: (p: MashupProgress) => progress.push(p), call, setDirty: (v: boolean) => (dirty = v) };
}

const req = (r: Partial<MashupRequest> = {}): MashupRequest => ({ a: { path: VOCAL }, b: { path: BEAT }, style: 'vocalOverBeat', ...r });
const channelByName = (doc: DocHost, re: RegExp) => Object.values(doc.project.channels).find((c) => re.test(c.name));
const clipsOf = (doc: DocHost, channelId: string) => Object.values(doc.project.playlist.clips).filter((c) => c.channelId === channelId).sort((a, b) => a.start - b.start);
const markers = (doc: DocHost) => Object.values(doc.project.playlist.markers).sort((a, b) => a.tick - b.tick).map((m) => [m.tick / (4 * PPQ) + 1, m.name]);
const BARTICKS = 4 * PPQ;

// ── check ───────────────────────────────────────────────────────────────

test('check: both songs read and planned, cached stems used, nothing edited or separated', async () => {
  const r = rig({ cached: ['Vocal Song', 'Beat Song'] });
  const v0 = r.doc.version;
  const out = await r.svc.check(req(), { progress: r.onProgress });
  assert.equal(out.ok, true, out.message);
  const c = out.data as MashupCheck;
  assert.equal(r.doc.version, v0, 'no edits');
  assert.equal(r.doc.getHistory().length, 0);
  assert.ok(!r.calls.some((x) => x.startsWith('separate')), 'no separation in check');
  assert.deepEqual([c.a.name, c.b.name, c.a.path, c.b.bpm, c.a.key], ['Vocal Song', 'Beat Song', VOCAL, 120, 'Gm']);
  assert.deepEqual(c.a.stems, ['vocals', 'drums', 'bass', 'other']);
  assert.equal(c.a.vocalPresence, 1);
  assert.ok(c.b.vocalPresence < 0.6, String(c.b.vocalPresence));
  assert.deepEqual(c.a.sections.map((s) => s.vocal), [false, true, true, true, true, false], 'vocal sections from the vocal stem');
  assert.equal(c.plan.vocalFrom, 'a');
  assert.deepEqual([c.plan.shiftA.semitones, c.plan.shiftB.semitones, c.plan.key], [2, 0, 'Am']);
  assert.deepEqual(c.problems, []);
  assert.ok(c.score >= 80, String(c.score));
  assert.match(out.message ?? '', /"Vocal Song" \+ "Beat Song": \d+\/100/);
  assert.ok(r.progress.some((p) => p.stage === 'reading') && r.progress.some((p) => p.stage === 'planning'));
});

test('check: without a stem model, vocalOverBeat lists the Model Manager problem; backAndForth has none; a missing file is a problem', async () => {
  const r = rig({ noModel: true });
  const c = (await r.svc.check(req())).data as MashupCheck;
  assert.ok(c.problems.some((p) => /Install HT-Demucs in Home ▸ Model Manager/.test(p)), c.problems.join(' | '));
  assert.deepEqual(c.a.stems, []);
  const bf = (await r.svc.check(req({ style: 'backAndForth' }))).data as MashupCheck;
  assert.deepEqual(bf.problems, []);
  const missing = (await r.svc.check(req({ b: { path: path.join(BROWSER, 'Nope.wav') } }))).data as MashupCheck;
  assert.ok(missing.problems.some((p) => /^B \("Nope"\): File not found/.test(p)), missing.problems.join(' | '));
  const bad = cleanMashupRequest({ a: { path: VOCAL }, b: { path: BEAT }, style: 'vocalOverBeat', key: 'H#' });
  assert.equal(typeof bad, 'string');
  assert.equal(typeof cleanMashupRequest({ a: { path: '' }, b: { clipId: 'c1' }, style: 'backAndForth', factorA: 2 }), 'object');
});

// ── build ───────────────────────────────────────────────────────────────

test('build vocalOverBeat: a NEW project as ONE undo step: stems separated, tracks with a clip per section, warped and pitched, markers, vocal chain, sends, ducking, master', async () => {
  const r = rig();
  const out = await r.svc.build(req(), { kind: 'new', actor: USER }, { progress: r.onProgress });
  assert.equal(out.ok, true, out.message);
  const o = out.data as MashupOutcome;
  assert.equal(o.rightsNote, MASHUP_RIGHTS_NOTE);
  assert.equal(o.tracks, 4, `${r.doc.project.channelOrder.map((id) => r.doc.project.channels[id].name).join(', ')} | ${o.notes.join(' | ')}`);
  assert.deepEqual(r.calls.filter((x) => x.startsWith('separate')), ['separate Vocal Song', 'separate Beat Song']);
  const p = r.doc.project;
  assert.equal(p.meta.name, 'Vocal Song × Beat Song');
  assert.equal(p.transport.bpm, 120);
  assert.equal(p.transport.mode, 'song');
  const chNames = p.channelOrder.map((id) => p.channels[id].name);
  assert.deepEqual(chNames.filter((n) => n.includes(' · ')), ['Vocal Song · Vocals', 'Beat Song · Drums', 'Beat Song · Bass', 'Beat Song · Other']);
  assert.ok(!chNames.some((n) => ['Kick', 'Clap', 'Hat', 'Snare', '808', 'Keys'].includes(n)), 'the default kit made way');
  assert.ok(chNames.some((n) => /^FX/.test(n)), 'transitions at the boundaries (add_transition)');
  assert.deepEqual(markers(r.doc), [[1, 'Intro'], [9, 'Verse'], [25, 'Chorus 1'], [41, 'Break'], [49, 'Chorus 2'], [65, 'Outro']]);
  // The vocal: Gm → Am (+2 st, formants kept), tones warp, its hook (song bar 24) twice in each chorus.
  const voc = channelByName(r.doc, /Vocals$/)!;
  assert.equal(voc.generator.params.pitch, 2);
  assert.equal(voc.generator.params.formant, 1);
  assert.equal(voc.generator.warp?.mode, 'tones');
  assert.ok((voc.generator.warp?.markers.length ?? 0) > 10, 'warped bar by bar');
  const vc = clipsOf(r.doc, voc.id);
  // autoWarp puts the first downbeat (0.5 s, after a 1-beat pickup) on bar 2 of the sample grid: song bar k = beat 4 + 4k.
  const at = (bar: number) => vc.filter((c) => c.start === (bar - 1) * BARTICKS).map((c) => [c.length / BARTICKS, c.offset / PPQ]);
  assert.deepEqual(at(25), [[8, 4 + 4 * 24]]);
  assert.deepEqual(at(33), [[8, 4 + 4 * 24]]);
  assert.deepEqual(at(9), [[16, 4 + 4 * 8]], 'the first verse plays in order');
  assert.ok(!vc.some((c) => c.start < 8 * BARTICKS || (c.start >= 40 * BARTICKS && c.start < 48 * BARTICKS) || c.start >= 64 * BARTICKS), 'no vocal in the intro, break and outro');
  // The bed: drums beats-warped and never pitched; a clip per section in its own order.
  const drums = channelByName(r.doc, /Drums$/)!;
  assert.equal(drums.generator.warp?.mode, 'beats');
  assert.ok(!drums.generator.params.pitch);
  assert.deepEqual(clipsOf(r.doc, drums.id).map((c) => [c.start / BARTICKS + 1, c.offset / PPQ]), [[1, 4], [9, 36], [25, 100], [41, 164], [49, 196], [65, 260]]);
  // Mix: the Stem Vocal chain (no Krypt Tune unless asked); reverb + delay sends; the Other stem ducks under the vocal; a master chain.
  const vins = p.mixer.inserts[voc.insertId];
  const types = vins.slotOrder.map((s) => vins.slots[s].type);
  assert.deepEqual(types, ['krypt.eq', 'krypt.comp'], 'Stem Vocal: EQ + one gentle comp');
  const names = p.mixer.insertOrder.map((id) => p.mixer.inserts[id].name);
  assert.ok(names.includes('Vocal Reverb') && names.includes('Vocal Delay'), names.join(','));
  const rev = p.mixer.insertOrder.find((id) => p.mixer.inserts[id].name === 'Vocal Reverb')!;
  assert.ok(vins.routes[rev] !== undefined && vins.routes[p.mixer.masterId] !== undefined, 'a send, the vocal still feeds the master');
  const other = channelByName(r.doc, /Other$/)!;
  const duck = Object.values(p.mixer.inserts[other.insertId].slots).find((s) => s.type === 'krypt.duck');
  assert.ok(duck && duck.sidechainFrom === voc.insertId, 'Other ducks under the vocal');
  assert.ok(p.mixer.inserts[p.mixer.masterId].slotOrder.length >= 2, 'master chain');
  // ONE history entry; its undo leaves the fresh project's own state.
  assert.equal(r.doc.getHistory().length, 1);
  assert.ok(o.notes.every((n) => typeof n === 'string'));
  assert.ok(['reading', 'separating', 'analyzing', 'planning', 'building', 'mixing'].every((s) => r.progress.some((x) => x.stage === s)), r.progress.map((x) => x.stage).join(','));
  const fr = r.progress.map((x) => x.fraction).filter((f) => f >= 0);
  assert.ok(fr.every((f, i) => i === 0 || f >= fr[i - 1] - 1e-9), 'progress only moves forward');
  const u = r.doc.undo(USER);
  assert.equal(u.ok, true, u.message);
  assert.ok(r.doc.project.channelOrder.every((id) => !/·/.test(r.doc.project.channels[id].name)), 'undo removes it all');
  assert.equal(Object.keys(r.doc.project.playlist.markers).length, 0);
});

test('build into the open project: new tracks, the source clips muted, one undo step restores the project exactly', async () => {
  const r = rig({ cached: ['Vocal Song', 'Beat Song'] });
  const tA = r.doc.exec<{ id: string }>('playlist.addTrack', { name: 'A' }, { actor: USER }).data!.id;
  const a = r.doc.exec<{ clipId: string }>('playlist.addAudio', { path: VOCAL, name: 'Vocal Song', trackId: tA, start: 0 }, { actor: USER }).data!;
  const tB = r.doc.exec<{ id: string }>('playlist.addTrack', { name: 'B' }, { actor: USER }).data!.id;
  const b = r.doc.exec<{ clipId: string }>('playlist.addAudio', { path: BEAT, name: 'Beat Song', trackId: tB, start: 0 }, { actor: USER }).data!;
  // Song / pattern mode is UI state outside undo history (transport.setMode history: false), like File ▸ Open audio as project.
  const snap = () => JSON.stringify({ ...r.doc.project, transport: { ...r.doc.project.transport, mode: 'x' } });
  const before = snap();
  const h0 = r.doc.getHistory().length;
  const out = await r.svc.build(req({ a: { clipId: a.clipId }, b: { clipId: b.clipId }, newProject: false, transitions: false }), { kind: 'current', actor: USER });
  assert.equal(out.ok, true, out.message);
  assert.equal(r.doc.getHistory().length, h0 + 1, 'one history entry');
  assert.ok(!r.calls.some((x) => x.startsWith('separate')), 'cached stems reused');
  const p = r.doc.project;
  assert.equal(p.playlist.tracks[tA].mute, true);
  assert.equal(p.playlist.tracks[tB].mute, true);
  assert.ok(channelByName(r.doc, /^Vocal Song · Vocals$/));
  assert.ok((out.data as MashupOutcome).notes.some((n) => /master chain was left as it was/.test(n)));
  assert.ok((out.data as MashupOutcome).notes.some((n) => /project tempo changed from 140 to 120 bpm/.test(n)));
  const u = r.doc.undo(USER);
  assert.equal(u.ok, true, u.message);
  assert.equal(snap(), before, 'undo restores the project exactly');
});

test('build backAndForth without a stem model: both full mixes trade sections with crossfades and markers', async () => {
  const r = rig({ noModel: true });
  const out = await r.svc.build(req({ style: 'backAndForth', bars: 64 }), { kind: 'new', actor: USER });
  assert.equal(out.ok, true, out.message);
  const p = r.doc.project;
  const A = channelByName(r.doc, /^Vocal Song · Full mix$/)!;
  const B = channelByName(r.doc, /^Beat Song · Full mix$/)!;
  assert.ok(A && B);
  assert.equal(A.generator.warp?.mode, 'complex');
  const all = [...clipsOf(r.doc, A.id).map((c) => ({ ...c, side: 'A' })), ...clipsOf(r.doc, B.id).map((c) => ({ ...c, side: 'B' }))].sort((x, y) => x.start - y.start);
  for (let i = 1; i < all.length; i++) {
    assert.equal(all[i].start, all[i - 1].start + all[i - 1].length, 'back to back');
    assert.notEqual(all[i].side, all[i - 1].side, 'alternating');
  }
  assert.ok(all.some((c) => c.fadeIn === PPQ) && all.some((c) => c.fadeOut === PPQ), 'one-beat crossfades');
  assert.equal(markers(r.doc)[0][1], 'Intro');
  assert.equal(markers(r.doc).length, all.length);
  assert.ok(all[all.length - 1].start + all[all.length - 1].length <= 64 * BARTICKS);
  assert.ok(!Object.values(p.mixer.inserts).some((i) => i.name === 'Vocal Reverb'), 'no vocal chain without a vocal');
  assert.equal((out.data as MashupOutcome).plan.vocalFrom, null);
});

test('build stemBlend: the picked stems from both songs', async () => {
  const r = rig({ cached: ['Vocal Song', 'Beat Song'] });
  const out = await r.svc.build(req({ style: 'stemBlend', stems: { vocals: 'b', drums: 'a', bass: 'a', other: 'b' }, transitions: false, tune: 'natural' }), { kind: 'new', actor: USER });
  assert.equal(out.ok, true, out.message);
  const names = r.doc.project.channelOrder.map((id) => r.doc.project.channels[id].name);
  assert.deepEqual(names.filter((n) => n.includes(' · ')), ['Beat Song · Vocals', 'Vocal Song · Drums', 'Vocal Song · Bass', 'Beat Song · Other']);
  const voc = channelByName(r.doc, /^Beat Song · Vocals$/)!;
  const tune = r.doc.project.mixer.inserts[voc.insertId].slots[r.doc.project.mixer.inserts[voc.insertId].slotOrder[0]];
  assert.equal(tune.type, 'krypt.pitch', 'tune asked: Krypt Tune first');
  assert.equal(tune.params.speed, 60, 'natural');
  assert.match((out.data as MashupOutcome).plan.sections[2].uses, /Beat Song other/);
});

test('build without a stem model: refused with the Model Manager hint, nothing changed', async () => {
  const r = rig({ noModel: true });
  const v0 = r.doc.version;
  const out = await r.svc.build(req(), { kind: 'new', actor: USER });
  assert.equal(out.ok, false);
  assert.match(out.message ?? '', /Install HT-Demucs in Home ▸ Model Manager/);
  assert.equal(r.doc.version, v0);
  assert.equal(r.doc.project.meta.name, 'Start', 'the open project was not replaced');
});

test('cancel during separation: nothing is changed; a second build while one runs is refused; cancel when idle says so', async () => {
  let release!: () => void;
  let entered!: () => void;
  const inSep = new Promise<void>((res) => (entered = res));
  const r = rig({ gate: { stems: new Promise<void>((res) => (release = res)), entered: () => entered() } });
  assert.equal(r.svc.cancel().ok, false);
  const v0 = r.doc.version;
  const job = r.svc.build(req(), { kind: 'new', actor: USER });
  await inSep;
  const again = await r.svc.build(req(), { kind: 'new', actor: USER });
  assert.match(again.message ?? '', /Already building the mashup "Vocal Song × Beat Song"/);
  const c = r.svc.cancel();
  assert.equal(c.ok, true, c.message);
  release();
  const out = await job;
  assert.equal(out.ok, false);
  assert.equal(out.message, 'Cancelled: nothing was changed.');
  assert.equal(r.doc.version, v0);
  assert.equal(r.doc.project.meta.name, 'Start');
  assert.equal(r.doc.getHistory().length, 0);
});

test("key from the stems' notes: a vocal that already sings in the beat's key isn't moved, whatever its song's label; levels matched", async () => {
  // Vocal Song's mix reads Gm, but its vocal stem sings in A minor: on Beat Song (Am) it needs no shift.
  const r = rig({ cached: ['Vocal Song', 'Beat Song'], vocalProfile: { 'Vocal Song': profileOf(9, true) } });
  const c = (await r.svc.check(req())).data as MashupCheck;
  assert.deepEqual([c.plan.shiftA.semitones, c.plan.shiftB.semitones], [0, 0]);
  assert.ok(c.reasons.some((x) => /^Key: measured on the stems: A's vocal \(A minor\) fits B's instrumental \(A minor\) as it is/.test(x)), c.reasons.join(' | '));
  assert.ok(['light Vocal Song vocals', 'light Beat Song bass', 'light Beat Song other'].every((x) => r.calls.includes(x)), r.calls.join(', '));
  assert.ok(!r.calls.some((x) => x.startsWith('analyze ') && x.split(' ').length > 3), 'stems are only read light');
  const out = await r.svc.build(req({ transitions: false }), { kind: 'new', actor: USER });
  assert.equal(out.ok, true, out.message);
  const voc = channelByName(r.doc, /Vocals$/)!;
  assert.ok(!voc.generator.params.pitch, 'not pitched');
  // Both songs measure -9 LUFS: every part at -14 (-5 dB on the channel's 0.78), the vocal 1 dB over.
  const drums = channelByName(r.doc, /Drums$/)!;
  assert.ok(Math.abs(drums.volume - 0.78 * Math.pow(10, -5 / 20)) < 1e-3, String(drums.volume));
  assert.ok(Math.abs(voc.volume - 0.78 * Math.pow(10, -4 / 20)) < 1e-3, String(voc.volume));
});

// ── auto_mashup (MCP) ───────────────────────────────────────────────────

test('auto_mashup: dry_run checks without editing; a build into the open project is one agent step; File access applies to paths', async () => {
  const r = rig({ cached: ['Vocal Song', 'Beat Song'] });
  const dry = await r.call('auto_mashup', { a: VOCAL, b: BEAT, dry_run: true });
  assert.equal(dry.ok, true, dry.message);
  assert.match(dry.message, /^Checked, nothing changed:/);
  assert.match(dry.text ?? '', /Plan: A \("Vocal Song"\)'s vocal over B \("Beat Song"\)'s instrumental, 120 bpm, Am/);
  assert.match(dry.text ?? '', /Fit: \d+\/100/);
  assert.ok((dry.text ?? '').includes(MASHUP_RIGHTS_NOTE));
  assert.equal(r.doc.getHistory().length, 0);
  // new_project refused while the project has unsaved changes.
  r.setDirty(true);
  const refused = await r.call('auto_mashup', { a: VOCAL, b: BEAT });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /unsaved changes/);
  const built = await r.call('auto_mashup', { a: VOCAL, b: BEAT, new_project: false, tune: 'hard', transitions: false });
  assert.equal(built.ok, true, built.message);
  const hist = r.doc.getHistory().filter((h) => h.actorKey.startsWith('agent'));
  assert.equal(hist.length, 1, 'one agent history entry');
  assert.ok((built.text ?? '').includes(MASHUP_RIGHTS_NOTE));
  const voc = channelByName(r.doc, /Vocals$/)!;
  const tune = r.doc.project.mixer.inserts[voc.insertId].slots[r.doc.project.mixer.inserts[voc.insertId].slotOrder[0]];
  assert.equal(tune.params.speed, 0, 'tune: hard');
  const undo = await r.call('undo_last');
  assert.equal(undo.ok, true, undo.message);
  assert.ok(!channelByName(r.doc, /Vocals$/));
  // A clip name works as a source; File access "browser" refuses a file outside the Browser folders.
  const r2 = rig({ fileAccess: 'browser', cached: ['Vocal Song', 'Far Song'] });
  const tr = r2.doc.exec<{ id: string }>('playlist.addTrack', { name: 'A' }, { actor: USER }).data!.id;
  r2.doc.exec('playlist.addAudio', { path: VOCAL, name: 'Vocal Song', trackId: tr, start: 0 }, { actor: USER });
  const byName = await r2.call('auto_mashup', { a: 'Vocal Song', b: BEAT, dry_run: true });
  assert.equal(byName.ok, true, byName.message);
  const outside = await r2.call('auto_mashup', { a: 'Vocal Song', b: FAR, dry_run: true });
  assert.equal(outside.ok, false);
  assert.ok(!r2.calls.some((x) => x.includes('Far Song')), 'the outside file was never read');
});

await run('mashup-service');
fs.rmSync(TMP, { recursive: true, force: true });
