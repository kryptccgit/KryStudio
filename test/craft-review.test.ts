import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { parse } from '@shared/kpn';
import type { Analysis } from '@shared/engine/protocol';
import type { Playbook } from '@shared/playbooks/types';
import type { ChainPreset, InstrumentPreset, Preset } from '@shared/sounds/types';
import type { SymbolicStats } from '@shared/kpn';
import { collectHeard, kindOf, rangeLoudness, reviewSong, sectionsOf, SEVERITY_WEIGHT, staticRuns, transitionAt, type BarInfo, type ReviewInput } from '../electron/mcp/tools/craftReview';
import { GENERIC_TARGETS } from '../electron/mcp/tools/craftRecipe';

const BAR = 3840;
const USER = { actor: { kind: 'user' as const } };

const PB: Playbook = {
  id: 'edm',
  name: 'EDM',
  summary: 'fixture',
  bpm: { min: 124, max: 128, typical: 126 },
  swing: 0,
  keys: { modes: ['minor'], common: ['Fm'] },
  harmony: { progressions: ['i VI III VII'], rhythm: '', voicing: '' },
  melody: '',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', writing: '' },
    { name: 'Hat', role: 'hat', sample: 'hat', writing: '' },
    { name: 'Bass', role: 'bass', writing: '', duckUnder: 'Kick' },
  ],
  patterns: [],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.3, parts: ['Hat'] },
    { kind: 'drop', label: 'Drop', bars: 8, energy: 1, parts: ['Kick', 'Hat', 'Bass'], transitionIn: ['riser', 'impact'] },
  ],
  mix: { master: { tags: [] }, levels: '' },
  transitions: '',
  mistakes: [],
  targets: { lufs: -8, truePeakDb: -1, bars: [64, 128], bands: { sub: [-2, 6] }, contrastLu: [4, 10], minCorrelation: 0.2, maxStaticBars: 8, minHatVelocitySpread: 8 },
};

const PRESETS: Preset[] = [
  { kind: 'instrument', id: 'factory:keys/warm-ep', name: 'Warm EP', plugin: 'krypt.triosc', params: {}, role: 'keys', tags: [], genres: [], description: 'fixture' } as InstrumentPreset,
  { kind: 'chain', id: 'factory:chain/master/club-loud', name: 'Club Loud', role: 'master', fx: [{ type: 'krypt.limiter', params: {} }], tags: [], genres: ['edm'], description: 'fixture', targetLufs: -8 } as ChainPreset,
];

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    durationSec: 64,
    peakDb: -1.2,
    truePeakDb: -1.2,
    lufsIntegrated: -8.3,
    lufsShortTermMax: -7,
    loudnessRange: 6,
    rmsDb: -11,
    crestDb: 9,
    bands: { sub: -12, low: -10, lowMid: -16, mid: -15, highMid: -19, high: -25 },
    stereoCorrelation: 0.5,
    stereoWidth: 0.4,
    energyCurve: Array.from({ length: 64 }, () => -9),
    clipping: false,
    estimatedBpm: 120,
    spectralCentroidHz: 1800,
    ...over,
  };
}

function project() {
  const doc = new DocHost(createDefaultProject('Review'), CATALOG, { strict: true });
  doc.exec('transport.set', { bpm: 120 }, USER);
  const p = () => doc.project;
  const ch = (name: string) => p().channelOrder.find((id) => p().channels[id].name === name)!;
  const track = (i: number) => p().playlist.trackOrder[i];
  const pattern = (name: string, kpn: string): string => {
    const r = parse(kpn, { ts: p().transport.timeSig, drumKey: () => 60 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const id = doc.exec<{ id: string }>('patterns.add', { name, select: false }, USER).data!.id;
    for (const t of r.tracks) doc.exec('notes.add', { patternId: id, channelId: ch(t.name), notes: t.notes.map((n) => ({ tick: n.tick, key: n.key, dur: n.dur, vel: n.vel })) }, USER);
    return id;
  };
  const place = (patternId: string, fromBar: number, toBar: number, lane = 0) => {
    const len = Math.max(BAR, ...Object.values(p().patterns[patternId].notes).flatMap((byId) => Object.values(byId).map((n) => Math.ceil((n.tick + n.dur) / BAR) * BAR)));
    for (let t = (fromBar - 1) * BAR; t < toBar * BAR; t += len) doc.exec('playlist.addClip', { kind: 'pattern', trackId: track(lane), start: t, length: Math.min(len, toBar * BAR - t), patternId }, USER);
  };
  const marker = (bar: number, name: string) => doc.exec('playlist.addMarker', { tick: (bar - 1) * BAR, name }, USER);
  return { doc, p, ch, track, pattern, place, marker };
}

function input(doc: DocHost, over: Partial<ReviewInput> = {}): ReviewInput {
  const p = doc.project;
  const end = Math.max(...Object.values(p.playlist.clips).map((c) => c.start + c.length));
  return { project: p, catalog: CATALOG, playbook: PB, targets: PB.targets, range: { start: 0, end }, wholeSong: true, analysis: analysis(), measured: null, symbolic: null, presets: PRESETS, samples: null, genre: 'edm', ...over };
}

const checks = (r: ReturnType<typeof reviewSong>) => r.issues.map((x) => x.check);

test('kindOf, rangeLoudness and staticRuns', () => {
  assert.deepEqual(['Intro', 'Pre-Chorus', 'Drop 2', 'Breakdown', 'Break', 'Build up', 'Hook', 'Outro', 'Verse 1', 'Bridge', 'Mystery'].map(kindOf), ['intro', 'pre', 'drop', 'breakdown', 'break', 'build', 'hook', 'outro', 'verse', 'bridge', null]);
  const curve = [-30, -30, -20, -20, -20, -20, -20, -20, -8, -8, -8, -8, -8, -8, -8, -8];
  assert.equal(rangeLoudness(curve, 120, 0, 0, 4 * BAR), -20.6);
  assert.equal(rangeLoudness(curve, 120, 0, 4 * BAR, 8 * BAR), -8);
  assert.equal(rangeLoudness([], 120, 0, 0, BAR), null);
  const bar = (sig: string): BarInfo => ({ sig, drumSig: '', channels: new Set(), notes: sig ? 1 : 0, lastBeatNotes: 0, audio: 0, automation: 0 });
  const bars = [...Array.from({ length: 12 }, (_, i) => bar(i % 2 ? 'b' : 'a')), bar('c'), bar('d'), bar('e'), bar('f')];
  assert.deepEqual(staticRuns(bars, 8), [{ start: 0, end: 12, period: 2 }]);
  assert.deepEqual(staticRuns(bars, 12), []);
  assert.deepEqual(staticRuns(Array.from({ length: 20 }, () => bar('')), 8), [], 'silence is not a static loop');
});

test('sections from markers, else inferred where the playing channels change; transitionAt finds FX, fills, automation and crashes', () => {
  const { doc, pattern, place, marker } = project();
  const hats = pattern('Hats', 'Hat: x.x. x.x. x.x. x.x.');
  const full = pattern('Full', 'Kick: x... x... x... x...\nHat: x.x. x.x. x.x. x.x.');
  place(hats, 1, 8);
  place(full, 9, 16, 1);
  let heard = collectHeard(doc.project, 0, 16 * BAR);
  const inferred = sectionsOf(doc.project, { start: 0, end: 16 * BAR }, heard);
  assert.deepEqual(inferred.map((s) => [s.source, s.start / BAR + 1, s.end / BAR]), [['inferred', 1, 8], ['inferred', 9, 16]]);
  assert.equal(transitionAt(doc.project, heard, 8 * BAR), null);
  marker(1, 'Intro');
  marker(9, 'Drop');
  heard = collectHeard(doc.project, 0, 16 * BAR);
  assert.deepEqual(sectionsOf(doc.project, { start: 0, end: 16 * BAR }, heard).map((s) => [s.name, s.kind]), [['Intro', 'intro'], ['Drop', 'drop']]);
  const fill = pattern('Fill', 'Hat: xxxx xxxx xxxx xxxx');
  doc.exec('playlist.addClip', { kind: 'pattern', trackId: doc.project.playlist.trackOrder[2], start: 7 * BAR, length: BAR, patternId: fill }, USER);
  assert.match(transitionAt(doc.project, collectHeard(doc.project, 0, 16 * BAR), 8 * BAR) ?? '', /pattern "Fill"|drum variation/);
});

test('mix checks: loudness vs target (fix = the master limiter), peaks / clipping, band balance, stereo, bare master, ranking and score', () => {
  const { doc, pattern, place } = project();
  place(pattern('Beat', 'Kick: x... x... x... x...\nHat: x.x. x.x. x.x. x.x.'), 1, 8);
  const ok = reviewSong(input(doc));
  assert.ok(!checks(ok).includes('lufs'));
  assert.ok(ok.works.some((w) => /Loudness on target: -8.3 LUFS/.test(w)));

  const r = reviewSong(input(doc, { analysis: analysis({ lufsIntegrated: -14.5, truePeakDb: 0.4, clipping: true, stereoCorrelation: -0.2, bands: { sub: -3, low: -10, lowMid: -16, mid: -15, highMid: -19, high: -25 } }) }));
  const by = Object.fromEntries(r.issues.map((x) => [x.check, x]));
  assert.equal(by.lufs.severity, 'high');
  assert.match(by.lufs.problem, /Too quiet: -14.5 LUFS integrated vs the -8 LUFS target \(6.5 LU under\)/);
  assert.match(by.lufs.fix, /set_effect \{"insert":"Master","effect":"limiter","params":\{"inputGain":"6.5dB","ceiling":"-1dB"\}\}/);
  assert.match(by.lufs.fix, /apply_chain \{"chain":"factory:chain\/master\/club-loud","insert":"master"\}/);
  assert.equal(by.peaks.severity, 'high');
  assert.match(by.peaks.problem, /Clipping/);
  assert.match(by.bands.problem, /sub \(<60 Hz\) \+12 dB vs the mids \(target -2..6\): too much/);
  assert.equal(by.stereo.severity, 'high');
  assert.equal(by.master.severity, 'medium', 'the default limiter at its defaults is a bare master');
  const rank = { high: 0, medium: 1, low: 2 } as const;
  for (let i = 1; i < r.issues.length; i++) assert.ok(rank[r.issues[i - 1].severity] <= rank[r.issues[i].severity]);
  assert.ok(r.issues.length <= 10);
  assert.ok(r.score >= 0 && r.score <= 100 - r.issues.reduce((s, x) => s + SEVERITY_WEIGHT[x.severity], 0) + 0);
  assert.ok(r.score < ok.score);

  const none = reviewSong(input(doc, { analysis: null }));
  assert.ok(!checks(none).includes('lufs'));
  assert.ok(none.skipped.some((s) => /loudness/.test(s)));
});

test('sidechain: a part the playbook ducks under the kick must be sidechained', () => {
  const { doc, p, ch, pattern, place } = project();
  const bass = doc.exec<{ id: string }>('channels.add', { type: 'krypt.triosc', name: 'Bass' }, USER).data!.id;
  doc.exec('channels.setGenParams', { id: bass, params: { cutoff: 900 } }, USER);
  place(pattern('Groove', 'Kick: x... x... x... x...\nBass: C2:2 r:2 C2:2 r:2 C2:2 r:2 C2:2 r:2'), 1, 8);
  const r = reviewSong(input(doc));
  const sc = r.issues.find((x) => x.check === 'sidechain')!;
  assert.equal(sc.severity, 'high');
  assert.equal(sc.fix, 'sidechain {"source":"Kick","target":"Bass"}');
  const ins = p().channels[bass].insertId;
  const slot = doc.exec<{ id: string }>('mixer.addSlot', { insertId: ins, type: 'krypt.duck', params: { mode: 1 } }, USER).data!.id;
  doc.exec('mixer.setSlot', { insertId: ins, slotId: slot, sidechainFrom: p().channels[ch('Kick')].insertId }, USER);
  const after = reviewSong(input(doc));
  assert.ok(!checks(after).includes('sidechain'));
  assert.ok(after.works.some((w) => /Sidechain in place: Bass/.test(w)) || after.works.length === 4);
});

test('arrangement: length vs targets, odd phrase lengths, static loops, missing transitions (with the planned kinds), silent intro, abrupt end', () => {
  const { doc, pattern, place, marker } = project();
  const loop = pattern('Loop', 'Kick: x... x... x... x...\nHat: x.x. x.x. x.x. x.x.');
  place(loop, 3, 22);
  marker(1, 'Intro');
  marker(9, 'Drop');
  marker(15, 'Break');
  const r = reviewSong(input(doc));
  const by = Object.fromEntries(r.issues.map((x) => [x.check, x]));
  assert.match(by.length.problem, /Only 22 bars: a sketch, not a finished song \(target 64-128 bars\)/);
  assert.equal(by.length.severity, 'high');
  assert.match(by.phrases.problem, /Drop \(6 bars\)/);
  assert.equal(by.static.severity, 'high');
  assert.match(by.static.bars!, /^3-22$/);
  assert.match(by.static.fix, /create_pattern \{"name":"Loop B","clone_from":"Loop"\}/);
  assert.match(by.transitions.problem, /No transition into Drop \(bar 9\), Break \(bar 15\)/);
  assert.match(by.transitions.fix, /add_transition \{"kind":"riser","at_bars":\[9\],"length_bars":8\}/, 'the playbook plans a riser + impact into the drop');
  assert.match(by.transitions.fix, /add_transition \{"kind":"impact","at_bars":\[9\]\}/);
  assert.match(by.transitions.fix, /add_transition \{"kind":"downlifter","at_bars":\[15\]\}/, 'a break gets a downlifter');
  assert.equal(by.transitions.severity, 'high');
  assert.match(by.intro.problem, /opens with 2 silent bars/);
  assert.match(by.ending.problem, /stops abruptly at full energy/);

  const ch = doc.exec<{ clipId: string; channelId: string }>('playlist.addAudio', { path: 'factory:fx/riser-4.wav', name: 'Riser', trackId: doc.project.playlist.trackOrder[3], start: 4 * BAR, frames: 48000 * 8, sampleRate: 48000 }, USER).data!;
  doc.exec('playlist.updateClips', { updates: [{ id: ch.clipId, start: 4 * BAR, length: 4 * BAR }] }, USER);
  marker(19, 'Outro');
  const after = reviewSong(input(doc));
  const t = after.issues.find((x) => x.check === 'transitions');
  assert.ok(!t || !/bar 9\)/.test(t.problem), 'the riser covers the drop');
  assert.ok(!checks(after).includes('ending'));
});

test('energy: flat sections are flagged (contrast and the planned shape); a quiet intro and loud drop pass', () => {
  const { doc, pattern, place, marker } = project();
  place(pattern('Hats', 'Hat: x.x. x.x. x.x. x.x.'), 1, 8);
  place(pattern('Full', 'Kick: x... x... x... x...\nHat: x.x. x.x. x.x. x.x.'), 9, 16, 1);
  marker(1, 'Intro');
  marker(9, 'Drop');
  const flat = reviewSong(input(doc, { analysis: analysis({ energyCurve: Array.from({ length: 32 }, () => -9) }) }));
  const by = Object.fromEntries(flat.issues.map((x) => [x.check, x]));
  assert.equal(by.contrast.severity, 'high');
  assert.match(by.contrast.problem, /Flat energy: every section sits at about -9 LUFS/);
  assert.equal(by.shape, undefined, 'no second issue for the same flatness');
  const inverted = reviewSong(input(doc, { analysis: analysis({ energyCurve: [...Array.from({ length: 16 }, () => -8), ...Array.from({ length: 16 }, () => -16)] }) }));
  const shape = inverted.issues.find((x) => x.check === 'shape')!;
  assert.equal(shape.severity, 'high');
  assert.match(shape.problem, /Drop \(bars 9-16\) is 8 LU quieter than Intro \(bars 1-8\)/);
  const good = reviewSong(input(doc, { analysis: analysis({ energyCurve: [...Array.from({ length: 16 }, () => -16), ...Array.from({ length: 16 }, () => -8)] }) }));
  assert.ok(!checks(good).includes('contrast') && !checks(good).includes('shape'));
  assert.equal(good.metrics.contrastLu, 8);
  assert.deepEqual(good.sections.map((s) => s.lufs), [-16, -8]);
});

test('sound: bare default synths (fix = load_preset), flat hats and robotic drums (fix = the groove op), out-of-key notes and low clashes', () => {
  const { doc, pattern, place } = project();
  place(pattern('Keys line', 'Keys: C4:4 E4:4 G4:4 C5:4\nHat: x.x. x.x. x.x. x.x.\nKick: x... x... x... x...'), 1, 8);
  const sym: SymbolicStats = { bars: 8, beats: 32, notes: 40, density: 1, channels: [], key: { given: null, estimated: 'Fm', confidence: 0.6 }, outOfKeyRatio: 0.25, outOfKeyNotes: ['E4', 'B3'], chords: [], lowClashes: ['bar 2: Bass C2 vs Keys C#2'] };
  const r = reviewSong(input(doc, { symbolic: sym }));
  const by = Object.fromEntries(r.issues.map((x) => [x.check, x]));
  assert.match(by.presets.problem, /bare default instrument .*Keys/);
  assert.match(by.presets.fix, /load_preset \{"channel":"Keys","preset":"factory:keys\/warm-ep"\}/);
  assert.match(by.velocity.problem, /Machine-gun hats: Hat velocity spread 0/);
  assert.match(by.velocity.fix, /transform_notes \{"pattern":"Keys line","channel":"Hat","ops":\[\{"op":"groove","template":"dance"/);
  assert.match(by.key.problem, /25% of the pitched notes are outside Fm: E4, B3/);
  assert.match(by.key.fix, /"op":"scale_snap","key":"Fm"/);
  assert.match(by.clash.problem, /Low-register clash/);

  const swingPb: Playbook = { ...PB, id: 'lofi', name: 'Lo-fi', swing: 25 };
  const lofi = reviewSong(input(doc, { playbook: swingPb, genre: 'lofi', targets: swingPb.targets }));
  const g = lofi.issues.find((x) => x.check === 'groove')!;
  assert.match(g.problem, /Robotic drums: every hit sits exactly on the grid with swing 0%, but Lo-fi swings \(about 25%\)/);
  assert.match(g.fix, /transform_notes \{"pattern":"Keys line","channel":"(Hat|Kick)","ops":\[\{"op":"groove","template":"hiphop"/);
  assert.match(g.fix, /set_swing \{"percent":25\}/);
  doc.exec('transport.set', { swing: 0.2 }, USER);
  const swung = reviewSong(input(doc, { playbook: swingPb, genre: 'lofi', targets: swingPb.targets }));
  assert.ok(!checks(swung).includes('groove'));
});

test('generic targets without a playbook; at most 10 issues; 2-4 "what works" lines', () => {
  const { doc, pattern, place } = project();
  place(pattern('Loop', 'Keys: C4:4 E4:4 G4:4 C5:4\nHat: x.x. x.x. x.x. x.x.'), 2, 40);
  const r = reviewSong(input(doc, { playbook: null, targets: GENERIC_TARGETS, genre: null, analysis: analysis({ lufsIntegrated: -20, truePeakDb: 1, clipping: true, stereoCorrelation: -0.5, energyCurve: Array.from({ length: 80 }, () => -20) }), symbolic: { bars: 40, beats: 160, notes: 10, density: 1, channels: [], key: { given: null, estimated: 'C', confidence: 1 }, outOfKeyRatio: 0.5, outOfKeyNotes: ['F#4'], chords: [], lowClashes: ['x', 'y'] } }));
  assert.ok(r.total > 10);
  assert.equal(r.issues.length, 10);
  assert.ok(!checks(r).includes('sidechain'), 'sidechain needs a playbook');
  assert.ok(r.works.length >= 1 && r.works.length <= 4);
  const clean = reviewSong(input(doc, { playbook: null, targets: GENERIC_TARGETS, genre: null }));
  assert.ok(clean.works.length >= 2 && clean.works.length <= 4, clean.works.join(' | '));
});

test('reference: tonal balance and width against the song, the energy shape over time, and what already matches', () => {
  const { doc, pattern, place } = project();
  place(pattern('Beat', ['Kick: x... x... x... x...', 'Hat: x.x. x.x. x.x. x.x.'].join(String.fromCharCode(10))), 1, 8);
  const cmp =(over: { groups?: Record<string, number>; width?: number | null; corr?: number | null; partial?: boolean }) => ({
    name: 'Night Drive',
    comparison: {
      tempo: { project: 128, reference: 128, reading: 128, diff: 0 },
      key: { project: 'Am', projectSource: 'notes' as const, reference: 'Am', relation: 'same' as const, semitones: 0 },
      loudness: { project: -9, reference: -8, diff: -1 },
      truePeak: { project: -1, reference: -0.3 },
      bands: { project: null, reference: null, diff: null, groups: over.groups ?? { 'low end': 0, mids: 0, highs: 0 } },
      width: { project: 0.3, reference: 0.45, diff: over.width === undefined ? 0 : over.width },
      energy: { correlation: over.corr === undefined ? 0.8 : over.corr, projectRange: 6, referenceRange: 8, partial: !!over.partial },
      suggestions: [],
    },
  });
  const off = reviewSong(input(doc, { reference: cmp({ groups: { 'low end': -7, mids: 1, highs: 4 }, width: -0.15, corr: 0.1 }) }));
  const ref = off.issues.filter((x) => x.check.startsWith('ref-'));
  const low = ref.find((x) => x.check === 'ref-balance' && /low end/.test(x.problem))!;
  assert.equal(low.severity, 'medium');
  assert.match(low.problem, /Your low end sit 7 dB under the reference "Night Drive"/);
  assert.match(low.fix, /raise the kick \/ 808 \/ bass/);
  const highs = ref.find((x) => /highs/.test(x.problem))!;
  assert.deepEqual([highs.severity, /tame the hats/.test(highs.fix)], ['low', true]);
  assert.ok(!ref.some((x) => /mids/.test(x.problem)), 'within 3 dB is fine');
  assert.ok(ref.some((x) => x.check === 'ref-width' && /Narrower than the reference/.test(x.problem)));
  assert.ok(ref.some((x) => x.check === 'ref-shape' && x.severity === 'medium' && /shape correlation 0.1/.test(x.problem)));
  const close = reviewSong(input(doc, { reference: cmp({}) }));
  assert.ok(!close.issues.some((x) => x.check.startsWith('ref-')));
  assert.ok(close.works.some((w) => /Tonal balance within 3 dB of the reference "Night Drive"/.test(w)) || close.works.length === 4, close.works.join(' | '));
  assert.ok(off.score < close.score);
  assert.ok(!reviewSong(input(doc, { reference: cmp({ corr: -0.5, partial: true }) })).issues.some((x) => x.check === 'ref-shape'));
  assert.ok(!reviewSong(input(doc)).issues.some((x) => x.check.startsWith('ref-')));
});

await run('craft-review');
