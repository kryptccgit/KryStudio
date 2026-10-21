// Wave 8a review-mix (research/15 §3.5): closeness to a studied reference
// (electron/mcp/tools/closeness.ts + review_song's issues), match_mix
// (electron/mcp/tools/matchMix.ts) on a fake engine whose render follows the
// mixer, and check_originality against the reference's transcribed melody.
// Synthetic reference: 32 bars at 128 bpm in A minor, Am F C G a bar each,
// four-on-the-floor kick, snare on 2 and 4, off-beat hats; sections
// A (quiet) B C (loud) D (quiet).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { parse } from '@shared/kpn';
import type { Analysis, RenderRequest } from '@shared/engine/protocol';
import type { AudioAnalysis, ChordSpan, DrumHit, StemName } from '@shared/analyzer/protocol';
import type { Project } from '@shared/schema/project';
import type { SoundFingerprint } from '@shared/sound-match/types';
import { listPlaybooks } from '@shared/playbooks';
import { referenceBrief, type ReferenceBrief } from '@shared/reference';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { computeCloseness, boundaryF1, chordFromWeights, grooveScore, readingFactor, tempoScore, balanceDiff, type ClosenessInput } from '../electron/mcp/tools/closeness';
import { reviewSong, collectHeard, sectionsOf, type ReviewInput } from '../electron/mcp/tools/craftReview';
import { GENERIC_TARGETS } from '../electron/mcp/tools/craftRecipe';
import { isMatchEq, MATCH_EQ_BANDS, MATCH_EQ_CAP_DB, nextEqGains, stemGroupLevels } from '../electron/mcp/tools/matchMix';
import { gainToDb } from '../electron/mcp/tools/util';

const USER = { actor: { kind: 'user' as const } };
const BAR = 3840;
const BPM = 128;
const SPB = 60 / BPM;
const BARS = 32;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-closeness-'));

// ── The synthetic reference ─────────────────────────────────────────────

const SECTIONS: Array<[string, number, number, number]> = [
  ['A', 0, 8, -16],
  ['B', 8, 16, -9],
  ['C', 16, 24, -8],
  ['D', 24, 32, -15],
];
const LOOP: Array<{ root: number; quality: 'min' | 'maj'; keys: number[]; bass: number }> = [
  { root: 9, quality: 'min', keys: [57, 60, 64], bass: 33 },
  { root: 5, quality: 'maj', keys: [53, 57, 60], bass: 29 },
  { root: 0, quality: 'maj', keys: [60, 64, 67], bass: 36 },
  { root: 7, quality: 'maj', keys: [55, 59, 62], bass: 31 },
];
const REF_BANDS = { sub: -10, low: -12, lowMid: -14, mid: -20, highMid: -24, high: -30 };
/** The reference vocal melody (beats, length, key). */
const MELODY: Array<[number, number, number]> = [[0, 1, 62], [1, 0.5, 65], [1.5, 0.5, 69], [2, 1, 67], [3, 1.5, 64], [4.5, 0.5, 72], [5, 1, 70], [6, 0.5, 65], [6.5, 0.5, 67], [7, 1, 62], [8, 1, 69], [9, 2, 60]];

const barSec = (bar: number) => bar * 4 * SPB;

function levels(over: Partial<Analysis> = {}): Analysis {
  return {
    durationSec: barSec(BARS),
    peakDb: -1,
    truePeakDb: -1,
    lufsIntegrated: -9,
    lufsShortTermMax: -7,
    loudnessRange: 6,
    rmsDb: -12,
    crestDb: 9,
    bands: { ...REF_BANDS },
    stereoCorrelation: 0.7,
    stereoWidth: 0.3,
    energyCurve: [],
    clipping: false,
    estimatedBpm: BPM,
    spectralCentroidHz: 1800,
    ...over,
  };
}

function refAnalysis(file = 'C:/ref/Ref Song.wav'): AudioAnalysis {
  const times: number[] = [];
  for (let b = 0; b <= BARS * 4; b++) times.push(b * SPB);
  const chords: ChordSpan[] = [];
  const hits: DrumHit[] = [];
  for (let bar = 0; bar < BARS; bar++) {
    const c = LOOP[bar % 4];
    chords.push({ startSec: barSec(bar), endSec: barSec(bar + 1), root: c.root, quality: c.quality, confidence: 0.8 });
    if (bar < 8 || bar >= 24) continue;
    for (let beat = 0; beat < 4; beat++) {
      const t = barSec(bar) + beat * SPB;
      hits.push({ timeSec: t, role: 'kick', vel: 0.9 });
      if (beat % 2 === 1) hits.push({ timeSec: t, role: 'snare', vel: 0.8 });
      hits.push({ timeSec: t + SPB / 2, role: 'hat', vel: 0.5 });
    }
  }
  const energy: number[] = [];
  for (let i = 0; i * 0.5 < barSec(BARS); i++) {
    const s = SECTIONS.find((x) => i * 0.5 >= barSec(x[1]) && i * 0.5 < barSec(x[2])) ?? SECTIONS[3];
    energy.push(s[3]);
  }
  return {
    path: file,
    durationSec: barSec(BARS),
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: BPM, confidence: 0.9, alternatives: [64, 256] },
    beats: { times, downbeats: times.filter((_, i) => i % 4 === 0), beatsPerBar: 4 },
    key: { tonic: 'A', mode: 'minor', name: 'Am', confidence: 0.8 },
    swing: null,
    sections: SECTIONS.map(([label, a, b, lufs]) => ({ label, startSec: barSec(a), endSec: barSec(b), lufs })),
    levels: levels({ energyCurve: energy.filter((_, i) => i % 2 === 0) }),
    stereo: { width: 0.3, correlation: 0.7 },
    energy: { hopSec: 0.5, lufs: energy },
    onsetRate: 4,
    chords,
    drumHits: hits,
    estimated: ['tempo', 'key', 'chords', 'sections', 'drumHits'],
    sources: ['fake'],
  };
}

const REF = refAnalysis();
const BRIEF: ReferenceBrief = referenceBrief(REF, { name: 'Ref Song', genre: 'house', playbooks: listPlaybooks() });

// ── A project built through the commands ────────────────────────────────

function build(opts: { bpm?: number; drums?: 'same' | 'halftime'; transpose?: number; markers?: boolean } = {}) {
  const doc = new DocHost(createDefaultProject('Closeness'), CATALOG, { strict: true });
  doc.exec('transport.set', { bpm: opts.bpm ?? BPM }, USER);
  const p = () => doc.project;
  const ch = (name: string) => p().channelOrder.find((id) => p().channels[id].name === name)!;
  const tr = (i: number) => p().playlist.trackOrder[i];
  const pattern = (name: string, notes: Record<string, Array<{ tick: number; key: number; dur: number; vel: number }>>) => {
    const id = doc.exec<{ id: string }>('patterns.add', { name, select: false }, USER).data!.id;
    for (const [c, ns] of Object.entries(notes)) doc.exec('notes.add', { patternId: id, channelId: ch(c), notes: ns }, USER);
    return id;
  };
  const kpn = (text: string) => {
    const r = parse(text, { ts: p().transport.timeSig, drumKey: () => 60 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return Object.fromEntries(r.tracks.map((t) => [t.name, t.notes.map((n) => ({ tick: n.tick, key: n.key, dur: n.dur, vel: n.vel }))]));
  };
  const t = opts.transpose ?? 0;
  const harmony: Record<string, Array<{ tick: number; key: number; dur: number; vel: number }>> = { Keys: [], '808': [] };
  LOOP.forEach((c, i) => {
    for (const k of c.keys) harmony.Keys.push({ tick: i * BAR, key: k + t, dur: BAR, vel: 0.7 });
    harmony['808'].push({ tick: i * BAR, key: c.bass + t, dur: BAR, vel: 0.9 });
  });
  const chords = pattern('Chords', { Keys: harmony.Keys });
  const bass = pattern('Bass', { '808': harmony['808'] });
  const drums = pattern(
    'Drums',
    kpn(
      opts.drums === 'halftime'
        ? 'Kick: x... .... .... ....\nSnare: .... .... x... ....\nHat: xxxx xxxx xxxx xxxx'
        : 'Kick: x... x... x... x...\nSnare: .... x... .... x...\nHat: ..x. ..x. ..x. ..x.',
    ),
  );
  const place = (patternId: string, fromBar: number, toBar: number, lane: number, len: number) => {
    for (let s = (fromBar - 1) * BAR; s < toBar * BAR; s += len) doc.exec('playlist.addClip', { kind: 'pattern', trackId: tr(lane), start: s, length: len, patternId }, USER);
  };
  place(chords, 1, 32, 0, 4 * BAR);
  place(bass, 9, 24, 1, 4 * BAR);
  place(drums, 9, 24, 2, BAR);
  if (opts.markers !== false) for (const [name, a] of [['Intro', 1], ['Build', 9], ['Drop', 17], ['Outro', 25]] as const) doc.exec('playlist.addMarker', { tick: (a - 1) * BAR, name }, USER);
  return { doc, ch, tr };
}

/** The render of a project laid out like the reference: energy per second follows its sections. */
function renderLike(bpm = BPM, over: Partial<Analysis> = {}): Analysis {
  const sec = (BARS * 4 * 60) / bpm;
  const curve: number[] = [];
  for (let i = 0; i < Math.ceil(sec); i++) {
    const bar = (i * bpm) / 60 / 4;
    curve.push((SECTIONS.find((x) => bar >= x[1] && bar < x[2]) ?? SECTIONS[3])[3]);
  }
  return levels({ durationSec: sec, energyCurve: curve, ...over });
}

function closenessOf(p: Project, over: Partial<ClosenessInput> = {}) {
  const range = { start: 0, end: BARS * BAR };
  const sections = sectionsOf(p, range, collectHeard(p, 0, range.end));
  return computeCloseness({
    project: p,
    range,
    sections,
    projectKey: 'Am',
    render: renderLike(p.transport.bpm),
    reference: { brief: BRIEF, analysis: REF },
    balance: { project: { drums: -12, bass: -15, other: -14 }, reference: { drums: -12, bass: -15, other: -14 } },
    ...over,
  });
}

const dim = (c: ReturnType<typeof computeCloseness>, id: string) => c.dims.find((d) => d.id === id)!;

// ── Pure helpers ────────────────────────────────────────────────────────

test('helpers: tempo readings, reading factor, groove cosine, boundaries, chords, balance', () => {
  assert.equal(tempoScore(128, 128).score, 100);
  assert.equal(tempoScore(256, 128).score, 100, 'double time is the same pulse');
  assert.equal(tempoScore(64, 128).score, 100, 'half time too');
  assert.equal(tempoScore(175, 143).score, 0, 'the lemezia mistake: 175 for a 143 song');
  const near = tempoScore(131, 128);
  assert.ok(near.score > 60 && near.score < 80, `2.3 % off: ${near.score}`);
  assert.equal(readingFactor(143, 71.5), 2);
  assert.equal(readingFactor(70, 140), 0.5);
  const four = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  assert.equal(grooveScore({ kick: four }, { kick: four }).score, 100);
  assert.ok(grooveScore({ kick: [1, ...new Array(15).fill(0)] }, { kick: four }).score <= 50);
  assert.deepEqual(boundaryF1([9, 17, 26], [9, 17, 25]), { f1: 1, missing: [], extra: [] });
  assert.equal(boundaryF1([5], [9, 17]).f1, 0);
  const am = new Array(12).fill(0);
  am[9] = 2;
  am[0] = 1;
  am[4] = 1;
  assert.equal(chordFromWeights(am)?.name, 'Am');
  assert.deepEqual(balanceDiff({ drums: -10, bass: -10 }, { drums: -12, bass: -12 }), { drums: 0, bass: 0 }, 'only the balance counts, not the level');
  assert.deepEqual(stemGroupLevels({ drums: -12, vocals: -80, guitar: -20, other: -20 }), { drums: -12, other: -17 });
});

// ── Closeness ───────────────────────────────────────────────────────────

test('closeness: a project laid out like the reference scores ~100 in every dimension', () => {
  const { doc } = build();
  const c = closenessOf(doc.project);
  for (const d of c.dims.filter((x) => x.id !== 'sounds')) assert.notEqual(d.score, null, `${d.id} measured (${d.note})`);
  assert.equal(dim(c, 'tempo').score, 100);
  assert.equal(dim(c, 'key').score, 100);
  assert.ok(dim(c, 'groove').score! >= 95, `groove ${dim(c, 'groove').score} ${JSON.stringify(dim(c, 'groove').detail)}`);
  assert.ok(dim(c, 'harmony').score! >= 95, `harmony ${dim(c, 'harmony').score} ${dim(c, 'harmony').measured} vs ${dim(c, 'harmony').reference}`);
  assert.ok(dim(c, 'arrangement').score! >= 90, `arrangement ${dim(c, 'arrangement').score} ${dim(c, 'arrangement').measured}`);
  assert.ok(dim(c, 'mix').score! >= 95, `mix ${dim(c, 'mix').score}`);
  assert.equal(dim(c, 'sounds').score, null, 'no fingerprints: skipped with a note');
  assert.match(dim(c, 'sounds').note ?? '', /fingerprint/);
  assert.ok(c.overall! >= 95, `overall ${c.overall}`);
  assert.equal(c.topFixes.length, 0);
  // Key estimates mix up relative keys: notes reading as C while the chords centre on Am is the same key.
  const rel = closenessOf(doc.project, { projectKey: 'C' });
  assert.equal(dim(rel, 'key').score, 100);
  assert.match(dim(rel, 'key').note ?? '', /centre on Am/);
});

test('closeness: a bar-range review (bars 17-32) lines up with the same bars of the reference', () => {
  const { doc } = build();
  const p = doc.project;
  const range = { start: 16 * BAR, end: 32 * BAR };
  const full = renderLike(BPM).energyCurve;
  const from = Math.floor((16 * 4 * 60) / BPM);
  const c = computeCloseness({
    project: p,
    range,
    sections: sectionsOf(p, range, collectHeard(p, range.start, range.end)),
    projectKey: 'Am',
    render: renderLike(BPM, { energyCurve: full.slice(from) }),
    reference: { brief: BRIEF, analysis: REF },
  });
  assert.ok(dim(c, 'harmony').score! >= 95, `harmony ${dim(c, 'harmony').score}`);
  const arr = dim(c, 'arrangement');
  assert.equal((arr.detail?.boundaries as { f1: number }).f1, 1, arr.measured);
  assert.match(arr.reference, /sections at 17, 25/);
});

test('closeness: the wrong tempo scores low and the fix is set_tempo to the reference reading', () => {
  const { doc } = build({ bpm: 175 });
  const c = closenessOf(doc.project);
  const t = dim(c, 'tempo');
  assert.equal(t.score, 0);
  assert.match(t.fix ?? '', /set_tempo \{"bpm":128\}/);
  assert.equal(c.topFixes[0].dim, 'tempo', 'the biggest gain comes first');
  assert.ok(c.overall! < 85, `overall ${c.overall}`);
});

test('closeness: a half-time groove against a four-on-the-floor reference is detected, with a KPN fix', () => {
  const same = closenessOf(build().doc.project);
  const { doc } = build({ drums: 'halftime' });
  const c = closenessOf(doc.project);
  const g = dim(c, 'groove');
  assert.ok(g.score! < 70, `groove ${g.score}`);
  assert.ok(g.score! < dim(same, 'groove').score! - 25);
  assert.match(g.fix ?? '', /write_pattern .*Kick : x\.\.\. x\.\.\. x\.\.\. x\.\.\./);
  assert.ok(c.overall! < same.overall!);
});

test('closeness: another key costs the key score, not the harmony (compared after transposing)', () => {
  const { doc } = build({ transpose: 2 });
  const c = closenessOf(doc.project, { projectKey: 'Bm' });
  assert.equal(dim(c, 'key').score, 20);
  assert.match(dim(c, 'key').fix ?? '', /"semitones":-2/);
  assert.ok(dim(c, 'harmony').score! >= 90, `harmony ${dim(c, 'harmony').score}`);
  assert.match(dim(c, 'harmony').note ?? '', /transposing/);
});

test('closeness: missing section changes and an off balance are scored and fixed', () => {
  const { doc } = build({ markers: false });
  // Markers in the wrong places: changes at bars 5 and 13 instead of 9, 17, 25.
  for (const [name, a] of [['Intro', 1], ['Verse', 5], ['Drop', 13]] as const) doc.exec('playlist.addMarker', { tick: (a - 1) * BAR, name }, USER);
  const c = closenessOf(doc.project, { balance: { project: { drums: -6, bass: -15, other: -14 }, reference: { drums: -12, bass: -15, other: -14 } } });
  const arr = dim(c, 'arrangement');
  assert.ok(arr.score! < 80, `arrangement ${arr.score}`);
  assert.match(arr.fix ?? '', /bars .*9.*17.*25/);
  const mix = dim(c, 'mix');
  assert.ok(mix.score! < 95);
  assert.match(mix.fix ?? '', /match_mix .*drums .* too loud/);
});

test('review_song: closeness issues join the ranked list; without a reference nothing changes', () => {
  const { doc } = build({ bpm: 175, drums: 'halftime' });
  const p = doc.project;
  const end = Math.max(...Object.values(p.playlist.clips).map((c) => c.start + c.length));
  const base: ReviewInput = { project: p, catalog: CATALOG, playbook: null, targets: GENERIC_TARGETS, range: { start: 0, end }, wholeSong: true, analysis: renderLike(175), measured: null, symbolic: null, presets: [], samples: null, genre: null };
  const plain = reviewSong(base);
  assert.equal(plain.closeness, undefined);
  assert.ok(!plain.issues.some((x) => x.check.startsWith('closeness')));
  const t0 = performance.now();
  const r = reviewSong({ ...base, closeness: { reference: { brief: BRIEF, analysis: REF }, balance: null, balanceNote: 'no stems' } });
  const ms = performance.now() - t0;
  assert.ok(r.closeness && r.closeness.overall! < 70, `overall ${r.closeness?.overall}`);
  const tempo = r.issues.find((x) => x.check === 'closeness-tempo');
  assert.ok(tempo, JSON.stringify(r.issues.map((x) => x.check)));
  assert.equal(tempo!.severity, 'high');
  assert.match(tempo!.fix, /set_tempo/);
  assert.ok(r.issues.some((x) => x.check === 'closeness-groove'));
  assert.ok(r.issues.findIndex((x) => x.check === 'closeness-tempo') <= 1, 'tempo ranks at the top');
  assert.ok(r.score < plain.score, 'the gaps count in the score');
  assert.ok(ms < 500, `the closeness review of 32 bars took ${ms.toFixed(1)} ms`);
  console.log(`    closeness + review of 32 bars: ${ms.toFixed(1)} ms`);
});

// ── The tool rig: a fake engine whose render follows the mixer, a fake analyzer ──

/** Each part's level before its fader (LUFS). */
const BASE: Record<string, number> = { Kick: -24, Clap: -60, Hat: -32, Snare: -30, '808': -20, Keys: -22, Lead: -26 };
/** The master's bands before any EQ (dB): too much sub / low / lowMid, far too little top. */
const MIX_BANDS = { sub: -8, low: -10, lowMid: -12, mid: -20, highMid: -30, high: -40 };
const BAND_PARAM: Record<string, string> = { sub: 'b2Gain', low: 'b3Gain', lowMid: 'b4Gain', highMid: 'b5Gain', high: 'b6Gain' };

function fakeRender(p: Project): { analysis: Analysis; stems: Array<{ insertId: string; name: string; level: number }> } {
  const stems: Array<{ insertId: string; name: string; level: number }> = [];
  let power = 0;
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    const base = BASE[ch.name];
    if (base === undefined || ch.mute) continue;
    const ins = p.mixer.inserts[ch.insertId];
    const level = base + gainToDb(ins.volume);
    stems.push({ insertId: ins.id, name: ins.name, level });
    power += Math.pow(10, level / 10);
  }
  const m = p.mixer.inserts[p.mixer.masterId];
  const slots = m.slotOrder.map((s) => m.slots[s]);
  const eq = slots.find((s) => isMatchEq(s));
  const im = slots.find((s) => s.type === 'krypt.imager');
  const lim = slots.find((s) => s.type === 'krypt.limiter');
  const bands = { ...MIX_BANDS };
  for (const [k, prm] of Object.entries(BAND_PARAM)) (bands as Record<string, number>)[k] += eq?.params[prm] ?? 0;
  const lufs = 10 * Math.log10(power) + (lim?.params.inputGain ?? 0);
  return { analysis: levels({ lufsIntegrated: lufs, bands, stereoWidth: 0.12 * (im?.params.midWidth ?? 1), energyCurve: [lufs, lufs, lufs, lufs] }), stems };
}

const STEM_LEVELS: Record<StemName, number> = { drums: -12, bass: -15, other: -14, vocals: -80, guitar: -90, piano: -90 };

let rigN = 0;
async function rig(opts: { stems?: boolean; melody?: boolean; kickFp?: { index: SoundFingerprint; reference: SoundFingerprint } } = {}) {
  const root = path.join(TMP, `rig${++rigN}`);
  fs.mkdirSync(root, { recursive: true });
  const { doc, ch, tr } = build();
  // The studied reference: a muted "Reference: Ref Song" audio track.
  const refPath = path.join(root, 'Ref Song.wav');
  fs.writeFileSync(refPath, 'RIFF fake');
  const lastTrack = doc.project.playlist.trackOrder[doc.project.playlist.trackOrder.length - 1];
  const added = doc.exec<{ channelId: string }>('playlist.addAudio', { path: refPath, name: 'Reference: Ref Song', trackId: lastTrack, start: 0, frames: 44100 * 60, sampleRate: 44100 }, USER).data!;
  doc.exec('playlist.setTrack', { id: lastTrack, mute: true }, USER);
  const stemDir = path.join(root, 'stems');
  const stemPath = (s: StemName) => path.join(stemDir, `${s}.wav`);
  const renders: RenderRequest[] = [];
  const analyzer = {
    async analyze(target: { channelId?: string; path?: string }) {
      if (target.channelId) return { ok: true, data: REF };
      const name = path.basename(target.path ?? '').replace(/\.wav$/, '') as StemName;
      const lvl = STEM_LEVELS[name] ?? -90;
      return { ok: true, data: { ...REF, path: target.path!, energy: { hopSec: 0.5, lufs: REF.energy.lufs.map(() => lvl) } } };
    },
    async drumStemHits() {
      return { ok: true, data: null };
    },
    async stemFiles() {
      if (opts.stems === false) return { ok: true, data: null, message: 'The stems are not cached yet' };
      const stems: Partial<Record<StemName, { path: string; peakDb: number; rmsDb: number }>> = {};
      for (const s of ['drums', 'bass', 'other', 'vocals'] as StemName[]) stems[s] = { path: stemPath(s), peakDb: STEM_LEVELS[s] + 10, rmsDb: s === 'vocals' && opts.melody ? -20 : STEM_LEVELS[s] };
      return { ok: true, data: { stems, model: 'htdemucs', modelName: 'HT-Demucs', device: 'cpu', cached: true, seconds: 0 } };
    },
    async transcribeFile(p: string) {
      const notes = /vocals/.test(p) && opts.melody ? MELODY.map(([b, d, k]) => ({ startSec: b * SPB, durSec: d * SPB, key: k, vel: 0.8 })) : [];
      return { ok: true, data: { mode: 'mono', notes, hits: [], source: 'fake' } };
    },
    listModels: () => [],
    ...(opts.kickFp
      ? {
          async fingerprint(_abs: string, segs?: Array<{ startSec: number; endSec: number }>) {
            return { ok: true, data: { segments: (segs ?? []).map(() => opts.kickFp!.reference) } };
          },
        }
      : {}),
  } as unknown as MainDeps['analyzer'];
  if (opts.kickFp) {
    // The factory fingerprint index holds the project's kick sample.
    const kick = doc.project.channels[ch('Kick')];
    const kickPath = doc.project.samples[kick.generator.sampleId!].path;
    fs.writeFileSync(path.join(root, 'fingerprints.json'), JSON.stringify({ version: 1, generator: 'test', entries: [{ source: { kind: 'sample', path: kickPath, sampleKind: 'kick' }, fp: opts.kickFp.index }] }));
  }
  const deps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} as never }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async render(job: RenderRequest) {
        renders.push(job);
        const r = fakeRender(doc.project);
        if (job.stems && opts.stems === false) return { ok: false, message: 'Stem export is not supported yet' };
        return {
          ok: true,
          data: {
            path: job.path,
            files: [job.path],
            durationSec: 8,
            peakDb: -1,
            lufsIntegrated: r.analysis.lufsIntegrated,
            analysis: r.analysis,
            ...(job.stems
              ? { stemResults: [...r.stems.map((s) => ({ insertId: s.insertId, name: s.name, path: path.join(job.path, `${s.name}.wav`), analysis: levels({ lufsIntegrated: s.level, rmsDb: s.level }) })), { insertId: doc.project.mixer.masterId, name: 'Master', path: path.join(job.path, 'Master.wav'), analysis: r.analysis }] }
              : {}),
          },
        };
      },
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo: async () => ({ ok: false, message: 'n/a' }),
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Closeness', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (x: string) => (x === 'factory:fingerprints.json' ? path.join(root, 'fingerprints.json') : x),
      renderDir: () => path.join(root, 'renders'),
      allowedRoots: () => [root],
    },
    getSettings: () => ({}) as never,
    updateSettings: () => ({}) as never,
    broadcast: () => {},
    userDataDir: root,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    analyzer,
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'claude-code', name: 'Claude Code' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { doc, ch, tr, deps, call, renders, refChannel: added.channelId };
}

const masterSlots = (p: Project) => {
  const m = p.mixer.inserts[p.mixer.masterId];
  return m.slotOrder.map((s) => m.slots[s]);
};

interface Gaps {
  balance: Record<string, number>;
  bands: Record<string, number>;
  width: number | null;
  lufs: number | null;
}
const meanAbs = (x: Record<string, number>) => {
  const v = Object.values(x);
  return v.reduce((s, d) => s + Math.abs(d), 0) / Math.max(1, v.length);
};

// ── match_mix ───────────────────────────────────────────────────────────

test('match_mix: the gaps shrink round by round, the Match EQ is capped at ±6 dB, all in one undo step', async () => {
  const r = await rig();
  const before = r.doc.getHistory().length;
  const out = await r.call('match_mix', { rounds: 3 });
  assert.equal(out.ok, true, out.message);
  const d = out.data as { before: Gaps; after: Gaps; history: Gaps[]; stems: boolean };
  assert.equal(d.stems, true);
  assert.ok(meanAbs(d.after.balance) < meanAbs(d.before.balance) * 0.5, `balance ${JSON.stringify(d.before.balance)} → ${JSON.stringify(d.after.balance)}`);
  assert.ok(meanAbs(d.after.bands) < meanAbs(d.before.bands) * 0.6, `bands ${JSON.stringify(d.before.bands)} → ${JSON.stringify(d.after.bands)}`);
  assert.ok(Math.abs(d.after.lufs!) < 0.6 && Math.abs(d.before.lufs!) > 5, `lufs ${d.before.lufs} → ${d.after.lufs}`);
  assert.ok(Math.abs(d.after.width!) < Math.abs(d.before.width!), `width ${d.before.width} → ${d.after.width}`);
  for (let i = 1; i < d.history.length; i++) assert.ok(meanAbs(d.history[i].bands) <= meanAbs(d.history[i - 1].bands) + 0.05, `round ${i} bands didn't grow`);
  const eqs = masterSlots(r.doc.project).filter((s) => isMatchEq(s));
  assert.equal(eqs.length, 1);
  for (const b of MATCH_EQ_BANDS) assert.ok(Math.abs(eqs[0].params[`${b.p}Gain`]) <= MATCH_EQ_CAP_DB, `${b.band} ${eqs[0].params[`${b.p}Gain`]}`);
  assert.equal(eqs[0].params.b6Gain, MATCH_EQ_CAP_DB, 'the top needs +10 dB but gets the +6 dB cap');
  const order = masterSlots(r.doc.project).map((s) => s.type);
  assert.ok(order.indexOf('krypt.eq') < order.indexOf('krypt.limiter'), `Match EQ before the limiter: ${order.join(' → ')}`);
  assert.ok(r.renders.every((j) => j.stems), 'every render with stems');
  assert.match(out.text ?? '', /balance vs the reference .*drums .* → /);
  assert.match(out.text ?? '', /round 1: .*Match EQ/);
  const hist = r.doc.getHistory();
  assert.equal(hist.length, before + 1, 'one undo step');
  assert.match(hist[hist.length - 1].label, /match_mix/);
  // Undo removes all of it.
  r.doc.undo({ kind: 'agent', clientId: 'claude-code', name: 'Claude Code' });
  assert.equal(masterSlots(r.doc.project).filter((s) => isMatchEq(s)).length, 0);
});

test('match_mix: a re-run updates the same Match EQ slot', async () => {
  const r = await rig();
  assert.equal((await r.call('match_mix', { rounds: 1 })).ok, true);
  const first = masterSlots(r.doc.project).filter((s) => isMatchEq(s));
  assert.equal(first.length, 1);
  const out = await r.call('match_mix', { rounds: 1 });
  assert.equal(out.ok, true, out.message);
  const again = masterSlots(r.doc.project).filter((s) => isMatchEq(s));
  assert.equal(again.length, 1, 'no second Match EQ');
  assert.equal(again[0].id, first[0].id);
});

test('match_mix: without engine stems it matches the full mix only and says so; nothing studied → a clear refusal', async () => {
  const r = await rig({ stems: false });
  const out = await r.call('match_mix', { rounds: 1 });
  assert.equal(out.ok, true, out.message);
  assert.match(out.message + (out.text ?? ''), /balance skipped/i);
  assert.equal((out.data as { stems: boolean }).stems, false);
  assert.ok(masterSlots(r.doc.project).some((s) => isMatchEq(s)));
  // The reference unmuted: refused.
  const r2 = await rig();
  r2.doc.exec('playlist.setTrack', { id: r2.doc.project.playlist.trackOrder[r2.doc.project.playlist.trackOrder.length - 1], mute: false }, USER);
  const bad = await r2.call('match_mix', {});
  assert.equal(bad.ok, false);
  assert.match(bad.message, /isn't muted/);
  // No reference at all.
  const r3 = await rig();
  r3.doc.exec('channels.set', { id: r3.refChannel, name: 'Some audio' }, USER);
  const none = await r3.call('match_mix', {});
  assert.equal(none.ok, false);
  assert.match(none.message, /study_reference/);
});

test('nextEqGains: damped toward the gap, capped, small gaps left alone', () => {
  const g = nextEqGains({ sub: 0, high: 5 }, { sub: 2, low: 0.3, high: -10 });
  assert.equal(g.sub, -1.6);
  assert.equal(g.low, 0);
  assert.equal(g.high, 6);
});

// ── review_song + check_originality through the tools ───────────────────

test('review_song with a studied reference: one stems render, closeness in the result, timings reported', async () => {
  const r = await rig();
  const out = await r.call('review_song', {});
  assert.equal(out.ok, true, out.message);
  assert.equal(r.renders.length, 1, 'one render');
  assert.equal(r.renders[0].stems, true);
  const d = out.data as { closeness: { overall: number; dims: Array<{ id: string; score: number | null; detail?: { balance?: unknown } }> }; timings: { renderMs: number; reviewMs: number } };
  assert.ok(d.closeness.overall > 0);
  assert.ok(d.closeness.dims.find((x) => x.id === 'mix')!.detail?.balance, 'per-part balance from the stems');
  assert.match(out.text ?? '', /CLOSENESS to the reference: \d+\/100/);
  assert.match(out.message, /closeness to the reference \d+\/100/);
  console.log(`    review_song (fake engine) render ${d.timings.renderMs} ms, review + closeness ${d.timings.reviewMs} ms`);
});

const KICK_FP: SoundFingerprint = { lengthSec: 0.4, centroidHz: 180, rolloffHz: 700, flatness: 0.08, harmonicity: 0.4, f0Hz: 52, attackMs: 2, decayMs: 260, sustain: 0.1, bands: { sub: 0, low: -3, lowMid: -14, mid: -22, highMid: -26, high: -34 }, crestDb: 12, width: 0, peakDb: -1, rmsDb: -12 };
const CLICKY_FP: SoundFingerprint = { lengthSec: 0.15, centroidHz: 2600, rolloffHz: 9000, flatness: 0.55, harmonicity: 0.05, f0Hz: null, attackMs: 1, decayMs: 50, sustain: 0.02, bands: { sub: -30, low: -18, lowMid: -10, mid: -4, highMid: 0, high: -3 }, crestDb: 18, width: 0.2, peakDb: -1, rmsDb: -18 };

test("review_song: the sounds dimension compares each part's current sound with the reference part (fingerprints)", async () => {
  const same = await rig({ kickFp: { index: KICK_FP, reference: KICK_FP } });
  const a = await same.call('review_song', {});
  assert.equal(a.ok, true, a.message);
  const sa = (a.data as { closeness: { dims: Array<{ id: string; score: number | null; measured: string; note?: string }> } }).closeness.dims.find((x) => x.id === 'sounds')!;
  assert.ok(sa.score! >= 95, `same kick: ${sa.score} ${sa.measured} ${sa.note}`);
  assert.match(sa.measured, /Kick \d+%/);
  const off = await rig({ kickFp: { index: CLICKY_FP, reference: KICK_FP } });
  const b = await off.call('review_song', {});
  const sb = (b.data as { closeness: { dims: Array<{ id: string; score: number | null; fix: string | null }> } }).closeness.dims.find((x) => x.id === 'sounds')!;
  assert.ok(sb.score! < 60, `a clicky kick against a deep one: ${sb.score}`);
  assert.match(sb.fix ?? '', /match_sounds \{"parts":\["kick"\],"apply":true\}/);
});

test('check_originality flags a copied reference melody (transposed) and passes an original one', async () => {
  const r = await rig({ melody: true });
  const lead = r.doc.exec<{ id: string }>('channels.add', { name: 'Lead', type: 'krypt.triosc' }, USER).data!.id;
  const hook = r.doc.exec<{ id: string }>('patterns.add', { name: 'Hook', select: false }, USER).data!.id;
  r.doc.exec('notes.add', { patternId: hook, channelId: lead, notes: MELODY.map(([b, d, k]) => ({ tick: Math.round(b * 960), dur: Math.round(d * 960), key: k + 3, vel: 0.8 })) }, USER);
  const out = await r.call('check_originality', {});
  assert.equal(out.ok, true, out.message);
  assert.match(out.message, /^COPIED from the studied reference "Ref Song"/);
  assert.match(out.text ?? '', /COPIED FROM THE REFERENCE: Pattern "Hook" · Lead from bar 1: 12 notes in a row follow the reference "Ref Song" vocal melody/);
  // An original line: other intervals and rhythm.
  const mine = r.doc.exec<{ id: string }>('patterns.add', { name: 'Mine', select: false }, USER).data!.id;
  const own = [60, 67, 65, 64, 72, 71, 69, 62, 64, 57, 59, 60];
  r.doc.exec('notes.add', { patternId: mine, channelId: lead, notes: own.map((k, i) => ({ tick: i * 720, dur: 480, key: k, vel: 0.8 })) }, USER);
  const ok = await r.call('check_originality', { pattern: 'Mine' });
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /^No copied melody/);
});

await run('closeness');
