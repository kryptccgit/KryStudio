import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { AudioAnalysis, ChordQuality, ChordSpan, DrumHit, DrumRole } from '@shared/analyzer/protocol';
import { beatMapper, beatToSec, chordsToBeats, drumGrid, notesToBeats, secToBeat, unswingBeat } from '@shared/library/grid';
import { buildProfile, canonicalLoop, profileText, romanNumeral, stepName, type ProfileInput } from '@shared/library/profile';
import { FEATURE_NAMES, VECTOR_VERSION, featureVector, nearest, similarity } from '@shared/library/similarity';
import { NGRAM_NOTES, beatNoteHashes, findMatches, isGenericRun, lineHashes, originalitySummary, projectLineHashes, projectLines, type ReferenceLine } from '@shared/library/originality';
import type { BeatNote, LibraryTrack, ProjectLine, TrackFeatures } from '@shared/library/types';
import { parse, formatIssues } from '@shared/kpn';
import { createDefaultProject, makeChannel, makePattern } from '@shared/schema/factory';
import { defaultNote } from '@shared/schema/project';
import { PPQ } from '@shared/schema/time';

const close = (a: number, b: number, eps = 1e-6, msg?: string) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≈ ${b}`);

interface Hit {
  step: number;
  role: DrumRole;
  vel?: number;
}

interface SynthOpts {
  bpm: number;
  bars: number;
  offset?: number;
  key?: string | null;
  confidence?: number;
  swing?: number | null;
  drums?: (bar: number) => Hit[];
  chords?: Array<[number, ChordQuality]>;
  sections?: Array<[string, number]>;
  lufs?: number;
  width?: number;
  onsetRate?: number;
  jitter?: number;
}

function synth(o: SynthOpts): AudioAnalysis {
  const offset = o.offset ?? 0.5;
  const period = 60 / o.bpm;
  const nBeats = o.bars * 4;
  const times = Array.from({ length: nBeats }, (_, i) => offset + i * period);
  const downbeats = times.filter((_, i) => i % 4 === 0);
  const timeAt = (beat: number) => offset + beat * period;
  const durationSec = offset + nBeats * period + 0.5;
  const hits: DrumHit[] = [];
  if (o.drums) {
    let n = 0;
    for (let bar = 0; bar < o.bars; bar++) {
      for (const h of o.drums(bar)) {
        let beat = bar * 4 + h.step / 8;
        if (o.swing && h.step % 4 === 2) beat += o.swing * 0.125;
        const j = o.jitter ? (n++ % 2 ? 1 : -1) * o.jitter : 0;
        hits.push({ timeSec: timeAt(beat) + j, role: h.role, vel: h.vel ?? 0.8 });
      }
    }
  }
  const chords: ChordSpan[] = [];
  if (o.chords) {
    for (let bar = 0; bar < o.bars; bar++) {
      const [root, quality] = o.chords[bar % o.chords.length];
      chords.push({ startSec: timeAt(bar * 4), endSec: timeAt(bar * 4 + 4), root, quality, confidence: 0.6 });
    }
  }
  const sections: AudioAnalysis['sections'] = [];
  const energy: number[] = [];
  if (o.sections) {
    let bar = 0;
    for (const [label, len] of o.sections) {
      const lufs = label === 'A' ? -12 : label === 'B' ? -7 : -15;
      sections.push({ startSec: timeAt(bar * 4), endSec: timeAt((bar + len) * 4), label, lufs });
      bar += len;
    }
  }
  for (let t = 0; t < durationSec; t += 0.5) {
    const s = sections.find((x) => t >= x.startSec && t < x.endSec);
    energy.push(s ? s.lufs : -30);
  }
  const keyName = o.key === undefined ? 'F#m' : o.key;
  const minor = !!keyName && keyName.endsWith('m');
  const lufs = o.lufs ?? -8;
  return {
    path: `C:/refs/${o.bpm}.wav`,
    durationSec,
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: o.bpm, confidence: o.confidence ?? 0.9, alternatives: [o.bpm / 2, o.bpm * 2] },
    beats: { times, downbeats, beatsPerBar: 4 },
    key: keyName ? { tonic: keyName.replace(/m$/, ''), mode: minor ? 'minor' : 'major', name: keyName, confidence: 0.8 } : null,
    swing: o.swing === undefined ? 0.04 : o.swing,
    sections,
    levels: {
      durationSec,
      peakDb: -0.3,
      truePeakDb: -0.5,
      lufsIntegrated: lufs,
      lufsShortTermMax: lufs + 2,
      loudnessRange: 5,
      rmsDb: lufs - 3,
      crestDb: 9,
      bands: { sub: -10, low: -12, lowMid: -18, mid: -20, highMid: -24, high: -30 },
      stereoCorrelation: 0.6,
      stereoWidth: o.width ?? 0.3,
      energyCurve: [],
      clipping: false,
      estimatedBpm: o.bpm,
      spectralCentroidHz: 1800,
    },
    stereo: { width: o.width ?? 0.3, correlation: 0.6 },
    energy: { hopSec: 0.5, lufs: energy },
    onsetRate: o.onsetRate ?? 5,
    chords,
    drumHits: hits,
    estimated: ['tempo', 'beats', 'key', 'swing', 'sections', 'chords'],
    sources: ['synthetic'],
  };
}

function trapDrums(halfTime: boolean, kick12Always = false) {
  return (bar: number): Hit[] => {
    const h: Hit[] = [{ step: 0, role: 'kick', vel: 0.95 }];
    if (kick12Always || bar % 5 < 3) h.push({ step: 12, role: 'kick', vel: 0.85 });
    if (halfTime) h.push({ step: 16, role: 'snare', vel: 0.92 });
    else h.push({ step: 8, role: 'snare', vel: 0.92 }, { step: 24, role: 'snare', vel: 0.92 });
    for (let s = 0; s < 32; s += 2) h.push({ step: s, role: 'hat', vel: s % 4 === 0 ? 0.6 : 0.4 });
    if (bar % 4 === 3) h.push({ step: 29, role: 'hat', vel: 0.5 }, { step: 31, role: 'hat', vel: 0.5 });
    return h;
  };
}

const MINOR_LOOP = (root: number): Array<[number, ChordQuality]> => [
  [root, 'min'],
  [(root + 8) % 12, 'maj'],
  [(root + 3) % 12, 'maj'],
  [(root + 10) % 12, 'maj'],
];
const MAJOR_LOOP = (root: number): Array<[number, ChordQuality]> => [
  [root, 'maj'],
  [(root + 7) % 12, 'maj'],
  [(root + 9) % 12, 'min'],
  [(root + 5) % 12, 'maj'],
];

function bassLine(rootKey: number, bars: number): BeatNote[] {
  const out: BeatNote[] = [];
  for (let b = 0; b < bars; b++) {
    out.push({ beat: b * 4, dur: 1, key: rootKey, vel: 0.9 });
    out.push({ beat: b * 4 + 1.5, dur: 1, key: rootKey + 7, vel: 0.8 });
    out.push({ beat: b * 4 + 2.5, dur: 1, key: rootKey + 10, vel: 0.8 });
  }
  return out;
}

function track(id: string, a: AudioAnalysis, status: LibraryTrack['status'] = 'light'): LibraryTrack {
  return { id, collectionId: 'c1', path: a.path, name: id, size: 1, mtime: 1, status, bpm: a.tempo?.bpm ?? null, key: a.key?.name ?? null, addedAt: 1, tags: [] };
}

function features(a: AudioAnalysis, lines: TrackFeatures['lines'] = {}): TrackFeatures {
  const drums = drumGrid(a, a.drumHits ?? [], 'mix');
  return { analysis: a, drums, chords: chordsToBeats(a, a.chords ?? []), lines, vector: featureVector(a, drums) };
}

const FORM: Array<[string, number]> = [
  ['A', 8],
  ['B', 8],
  ['A', 8],
  ['B', 8],
  ['C', 8],
];
const FORM_LONG: Array<[string, number]> = FORM.map(([l, n]) => [l, n * 2]);

function trapCollection(): ProfileInput[] {
  const specs: Array<{ id: string; bpm: number; key: string; root: number; minor: boolean; bars: number; half: boolean; bass?: number }> = [
    { id: 't1', bpm: 140, key: 'F#m', root: 6, minor: true, bars: 40, half: true, bass: 30 },
    { id: 't2', bpm: 138, key: 'C#m', root: 1, minor: true, bars: 40, half: true, bass: 25 },
    { id: 't3', bpm: 140, key: 'Am', root: 9, minor: true, bars: 40, half: true, bass: 33 },
    { id: 't4', bpm: 142, key: 'F#m', root: 6, minor: true, bars: 40, half: true },
    { id: 't5', bpm: 145, key: 'C', root: 0, minor: false, bars: 80, half: false },
  ];
  return specs.map((s) => {
    const a = synth({
      bpm: s.bpm,
      bars: s.bars,
      key: s.key,
      drums: trapDrums(s.half, s.id === 't5'),
      chords: s.minor ? MINOR_LOOP(s.root) : MAJOR_LOOP(s.root),
      sections: s.bars === 40 ? FORM : FORM_LONG,
      jitter: 0.006,
    });
    const lines = s.bass !== undefined ? { bass: bassLine(s.bass, s.bars) } : {};
    return { track: track(s.id, a, s.bass !== undefined ? 'deep' : 'light'), features: features(a, lines) };
  });
}

test('secToBeat follows a drifting beat grid, origin at the first downbeat, extrapolates at the local tempo', () => {
  const times: number[] = [];
  let t = 1;
  for (let i = 0; i < 21; i++) {
    times.push(t);
    t += 0.5 - (0.1 * i) / 20;
  }
  const a = synth({ bpm: 120, bars: 1 });
  a.beats = { times, downbeats: [times[2], times[6], times[10]], beatsPerBar: 4 };
  close(secToBeat(a, times[2])!, 0);
  close(secToBeat(a, times[10])!, 8);
  close(secToBeat(a, times[0])!, -2, 1e-9, 'beats before the first downbeat are negative');
  close(secToBeat(a, (times[5] + times[6]) / 2)!, 3.5);
  const head = (times[4] - times[0]) / 4;
  close(secToBeat(a, times[0] - head)!, -3);
  const tail = (times[20] - times[16]) / 4;
  close(secToBeat(a, times[20] + 2 * tail)!, 20);
  close(secToBeat(a, times[20] + tail / 2)!, 18.5);
  for (const b of [-3.25, -2, 0, 3.5, 7.75, 18, 19.5]) close(secToBeat(a, beatToSec(a, b)!)!, b, 1e-9, `round trip ${b}`);
});

test('secToBeat falls back to the tempo from 0 s, and is null without a tempo', () => {
  const a = synth({ bpm: 120, bars: 2 });
  a.beats = null;
  close(secToBeat(a, 1.5)!, 3);
  const b = synth({ bpm: 120, bars: 2 });
  b.beats = null;
  b.tempo = null;
  assert.equal(secToBeat(b, 1), null);
  assert.equal(beatMapper(b), null);
  assert.deepEqual(notesToBeats(b, [{ startSec: 1, durSec: 1, key: 60, vel: 1 }]), []);
});

test('notesToBeats and chordsToBeats convert seconds to beats; adjacent repeated chords merge', () => {
  const a = synth({ bpm: 120, bars: 4, offset: 1 });
  const notes = notesToBeats(a, [
    { startSec: 2, durSec: 0.25, key: 64, vel: 0.5 },
    { startSec: 0.5, durSec: 0.5, key: 60, vel: 0.7 },
  ]);
  assert.deepEqual(notes, [
    { beat: -1, dur: 1, key: 60, vel: 0.7 },
    { beat: 2, dur: 0.5, key: 64, vel: 0.5 },
  ]);
  const chords = chordsToBeats(a, [
    { startSec: 1, endSec: 2, root: 9, quality: 'min', confidence: 0.5 },
    { startSec: 2, endSec: 3, root: 9, quality: 'min', confidence: 0.5 },
    { startSec: 3, endSec: 5, root: 5, quality: 'maj', confidence: 0.5 },
    { startSec: 5, endSec: 6, root: 9, quality: 'min', confidence: 0.5 },
  ]);
  assert.deepEqual(chords, [
    { beat: 0, dur: 4, root: 9, quality: 'min' },
    { beat: 4, dur: 4, root: 5, quality: 'maj' },
    { beat: 8, dur: 2, root: 9, quality: 'min' },
  ]);
});

test('drumGrid: a known trap pattern lands on the right 32nd steps (with jitter), velocities and rolls', () => {
  const a = synth({ bpm: 140, bars: 40, drums: trapDrums(true), jitter: 0.008 });
  const g = drumGrid(a, a.drumHits!, 'mix')!;
  assert.ok(g);
  assert.equal(g.steps, 32);
  assert.equal(g.bars, 40);
  assert.equal(g.source, 'mix');
  assert.equal(g.counts.kick![0], 40);
  assert.equal(g.counts.kick![12], 24, 'the "and" of 2 in 60 % of bars');
  assert.equal(g.counts.snare![16], 40);
  assert.equal(g.counts.snare![8], 0);
  for (let s = 0; s < 32; s += 2) assert.equal(g.counts.hat![s], 40, `hat step ${s}`);
  assert.equal(g.counts.hat![29], 10);
  assert.equal(g.counts.hat![1], 0);
  close(g.vel.kick![0] / g.counts.kick![0], 0.95, 1e-3);
  close(g.vel.hat![2] / g.counts.hat![2], 0.4, 1e-3);
  assert.equal(g.rolls, 10, 'one roll every 4th bar');
  assert.equal(g.counts.openhat, undefined);
});

test('drumGrid: swing is undone, drum-less bars and bars without a confident downbeat are skipped', () => {
  const sw = synth({ bpm: 100, bars: 8, swing: 0.5, drums: trapDrums(false) });
  const g = drumGrid(sw, sw.drumHits!, 'stem')!;
  for (let s = 0; s < 32; s += 2) assert.equal(g.counts.hat![s], 8);
  assert.equal(g.counts.hat![3], 0);
  close(unswingBeat(0.25 + 0.5 * 0.125, 0.5), 0.25);
  close(unswingBeat(0.75 + 0.5 * 0.125, 0.5), 0.75);
  close(unswingBeat(0.5, 0.5), 0.5);

  const a = synth({ bpm: 140, bars: 40, drums: (bar) => (bar < 4 ? [] : trapDrums(true)(bar)) });
  a.beats!.downbeats = a.beats!.downbeats.filter((_, i) => i !== 20);
  const h = drumGrid(a, a.drumHits!, 'mix')!;
  assert.equal(h.bars, 40 - 4 - 2);
  assert.equal(h.counts.kick![0], 34);

  const nb = synth({ bpm: 140, bars: 4, drums: trapDrums(true) });
  nb.beats = null;
  assert.equal(drumGrid(nb, nb.drumHits!, 'mix'), null);
});

test('buildProfile: tempo, half-time share, keys, swing on 5 synthetic trap tracks', () => {
  const p = buildProfile({ id: 'c1', name: 'Dark trap' }, trapCollection(), { seed: 7, now: 1234 });
  assert.equal(p.collectionId, 'c1');
  assert.equal(p.updatedAt, 1234);
  assert.equal(p.tracks, 5);
  assert.equal(p.analysed, 5);
  assert.equal(p.deep, 3);
  assert.ok(p.tempo);
  assert.equal(p.tempo!.bpm.median, 140);
  assert.equal(p.tempo!.bpm.p25, 140);
  assert.deepEqual(p.tempo!.histogram, [
    { bpm: 136, count: 1 },
    { bpm: 140, count: 3 },
    { bpm: 144, count: 1 },
  ]);
  close(p.tempo!.halfTimeShare, 0.8, 1e-9, 'four half-time tracks (snare on 3), one with a 2-and-4 backbeat');
  assert.equal(p.keys!.minorShare, 0.8);
  assert.deepEqual(p.keys!.top[0], { key: 'F#m', count: 2 });
  assert.equal(p.keys!.top.length, 4);
  assert.equal(p.swing!.median, 0.04);
  assert.equal(p.swing!.share, 0);
});

test('buildProfile: drum probabilities are averaged per track (a long song does not dominate)', () => {
  const p = buildProfile({ id: 'c1', name: 'Dark trap' }, trapCollection(), { seed: 7, now: 0 });
  const d = p.drums!;
  assert.equal(d.tracks, 5);
  assert.equal(d.source, 'mix');
  assert.equal(d.roles.kick!.prob[0], 1);
  close(d.roles.kick!.prob[12], 0.68, 1e-9);
  close(d.roles.snare!.prob[16], 0.8, 1e-9);
  close(d.roles.snare!.prob[8], 0.2, 1e-9);
  for (let s = 0; s < 32; s += 2) assert.equal(d.roles.hat!.prob[s], 1);
  close(d.roles.hat!.prob[29], 0.25, 1e-9);
  close(d.rollsPerBar, 0.25, 1e-9);
  close(d.roles.kick!.vel[0], 0.95, 1e-3);
  close(d.roles.snare!.vel[16], 0.92, 1e-3);
  assert.equal(d.roles.openhat, undefined);
});

test('buildProfile: bass from deep lines — lengths, degrees vs key root, kick alignment, glides', () => {
  const p = buildProfile({ id: 'c1', name: 'Dark trap' }, trapCollection(), { seed: 7, now: 0 });
  const b = p.bass!;
  assert.ok(b);
  assert.equal(b.tracks, 3);
  assert.equal(b.length.median, 1);
  close(b.degrees[0], 1 / 3, 1e-3);
  close(b.degrees[7], 1 / 3, 1e-3);
  close(b.degrees[10], 1 / 3, 1e-3);
  assert.equal(b.degrees[3], 0);
  close(b.kickAlign, 1.6 / 3, 1e-3);
  close(b.glide, 40 / 119, 1e-3);
});

test('buildProfile: harmony finds i–VI–III–VII as the top loop (rotation-invariant), structure and mix', () => {
  const p = buildProfile({ id: 'c1', name: 'Dark trap' }, trapCollection(), { seed: 7, now: 0 });
  const h = p.harmony!;
  assert.equal(h.tracks, 5);
  assert.deepEqual(h.progressions[0], { degrees: ['i', 'VI', 'III', 'VII'], count: 4 });
  assert.deepEqual(h.progressions[1], { degrees: ['I', 'V', 'vi', 'IV'], count: 1 });
  assert.equal(h.progressions.length, 2, 'all rotations of a loop count as one progression');
  assert.equal(h.changesPerBar, 1);
  const s = p.structure!;
  assert.deepEqual(s.forms[0], { form: ['A', 'B', 'A', 'B', 'C'], count: 5 });
  assert.equal(s.sectionBars.median, 8);
  assert.equal(s.sectionBars.p90, 16);
  assert.equal(s.energyShape.length, 16);
  assert.equal(Math.min(...s.energyShape), 0);
  assert.equal(Math.max(...s.energyShape), 1);
  assert.ok(s.energyShape[4] > s.energyShape[0], 'B sections are louder than A');
  const m = p.mix!;
  assert.equal(m.lufs.median, -8);
  assert.equal(m.truePeakDb.median, -0.5);
  assert.equal(m.width.median, 0.3);
  assert.deepEqual(m.bands, { sub: 0, low: -2, lowMid: -8, mid: -10, highMid: -14, high: -20 });
  assert.ok(p.caveats.some((c) => /full mix/.test(c)));
  assert.ok(p.caveats.some((c) => /Only 5 analysed tracks/.test(c)));
});

test('romanNumeral and canonicalLoop', () => {
  assert.equal(romanNumeral(6, 'min', 6, true), 'i');
  assert.equal(romanNumeral(2, 'maj', 6, true), 'VI');
  assert.equal(romanNumeral(1, '7', 6, true), 'V7');
  assert.equal(romanNumeral(11, 'm7', 6, true), 'iv7');
  assert.equal(romanNumeral(11, 'dim', 0, false), 'vii°');
  assert.equal(romanNumeral(10, 'maj', 0, false), 'bVII');
  assert.equal(romanNumeral(3, 'maj', 0, false), 'bIII');
  assert.deepEqual(canonicalLoop(['VII', 'i', 'VI', 'III']), ['i', 'VI', 'III', 'VII']);
  assert.deepEqual(canonicalLoop(['VI', 'i', 'VII', 'i']), ['i', 'VI', 'i', 'VII']);
  assert.deepEqual(canonicalLoop(['IV', 'V', 'iii', 'vi']), ['IV', 'V', 'iii', 'vi']);
  assert.equal(stepName(0), 'beat 1');
  assert.equal(stepName(12), 'the "and" of 2');
  assert.equal(stepName(29), 'the 32nd after the "and" of 4');
});

test('buildProfile: thin data → null sections with caveats, no examples', () => {
  const two = trapCollection().slice(0, 2);
  const p = buildProfile({ id: 'c2', name: 'Thin' }, two, { now: 0 });
  assert.equal(p.tempo, null);
  assert.equal(p.drums, null);
  assert.equal(p.bass, null);
  assert.equal(p.harmony, null);
  assert.equal(p.structure, null);
  assert.equal(p.mix, null);
  assert.deepEqual(p.examples, { drums: null, bass: null });
  for (const word of ['Tempo', 'Drums', 'Bass/808', 'Harmony', 'Structure', 'Mix', 'Keys']) assert.ok(p.caveats.some((c) => c.startsWith(word)), `caveat for ${word}`);
  const light = trapCollection().map((x) => ({ ...x, features: { ...x.features, lines: {} } }));
  const q = buildProfile({ id: 'c3', name: 'Light' }, light, { now: 0 });
  assert.equal(q.bass, null);
  assert.equal(q.examples.bass, null);
  assert.ok(q.caveats.some((c) => /deep analysis/.test(c)));
  assert.ok(q.drums && q.examples.drums);
  const waltz = trapCollection();
  waltz[4].features.analysis.beats!.beatsPerBar = 3;
  const w = buildProfile({ id: 'c5', name: 'Waltz' }, waltz, { now: 0 });
  assert.equal(w.drums!.tracks, 4);
  assert.ok(w.caveats.some((c) => c.startsWith('1 track is not in 4/4')));
  const e = buildProfile({ id: 'c4', name: 'Empty' }, [], { now: 0 });
  assert.equal(e.analysed, 0);
  assert.ok(e.caveats[0].startsWith('No analysed tracks'));
  assert.ok(profileText(e).length > 0);
});

test('profile examples are valid KPN for write_pattern and deterministic for a seed', () => {
  const inputs = trapCollection();
  const p = buildProfile({ id: 'c1', name: 'Dark "trap"' }, inputs, { seed: 7, now: 0 });
  const drums = parse(p.examples.drums!, { requireHeader: true });
  assert.equal(drums.ok, true, `${formatIssues(drums.errors)}\n${p.examples.drums}`);
  assert.equal(drums.bars, 2);
  const names = drums.tracks.map((t) => t.name);
  assert.deepEqual(names, ['kick', 'snare', 'hat']);
  assert.ok(drums.tracks.every((t) => t.kind === 'grid'));
  const kick = drums.tracks[0];
  assert.ok(kick.notes.some((n) => n.tick === 0) && kick.notes.some((n) => n.tick === 3840), 'kick on beat 1 of both bars (always)');
  const snare = drums.tracks[1];
  assert.ok(snare.notes.some((n) => n.tick === 1920), 'half-time snare on beat 3 (80 %, sampled)');
  const hat = drums.tracks[2];
  assert.equal(hat.grid, 32, 'the style rolls → hat/32');
  const bar2 = hat.notes.filter((n) => n.tick >= 3840).map((n) => (n.tick - 3840) / 120);
  assert.ok([29, 30, 31].every((s) => bar2.includes(s)), 'a 32nd roll at the end of bar 2');

  const bass = parse(p.examples.bass!, { requireHeader: true });
  assert.equal(bass.ok, true, `${formatIssues(bass.errors)}\n${p.examples.bass}`);
  assert.equal(bass.header.key, 'Am', 'minor collection → neutral A minor');
  assert.equal(bass.tracks[0].name, 'bass');
  assert.equal(bass.tracks[0].kind, 'melodic');
  assert.ok(bass.tracks[0].notes.length >= 2);
  assert.equal(bass.tracks[0].notes[0].tick, 0);
  assert.equal(bass.tracks[0].notes[0].key, 33, 'starts on the root (A1)');
  assert.ok(bass.tracks[0].notes.every((n) => n.tick + n.dur <= 7680));
  assert.ok(/^pattern "Dark 'trap' drums sketch"/.test(p.examples.drums!), 'quotes in the collection name are made safe');

  const again = buildProfile({ id: 'c1', name: 'Dark "trap"' }, inputs, { seed: 7, now: 0 });
  assert.deepEqual(again.examples, p.examples);
  const variants = new Set<string>();
  for (let seed = 1; seed <= 8; seed++) {
    const q = buildProfile({ id: 'c1', name: 'x' }, inputs, { seed, now: 0 });
    const r1 = parse(q.examples.drums!);
    const r2 = parse(q.examples.bass!);
    assert.equal(r1.ok && r2.ok, true, `seed ${seed}: ${formatIssues([...r1.errors, ...r2.errors])}`);
    variants.add(`${q.examples.drums}\n${q.examples.bass}`);
  }
  assert.ok(variants.size > 1, 'different seeds sample different examples');
});

test('profileText reads like guidance, includes the brief and the examples, respects maxChars', () => {
  const p = buildProfile({ id: 'c1', name: 'Dark trap' }, trapCollection(), { seed: 7, now: 0 });
  const text = profileText(p, { brief: 'dark, sparse, lots of space' });
  assert.ok(text.length <= 3500, `length ${text.length}`);
  assert.ok(text.startsWith('STYLE PROFILE "Dark trap"'));
  assert.ok(text.includes('"dark, sparse, lots of space"'));
  assert.ok(text.includes('Tempo: 140 BPM (middle half 140 to 142); most common 140–143 (3)'), text);
  assert.ok(/Kick: beat 1 always, the "and" of 2 in 68% of bars/.test(text), text);
  assert.ok(/half-time backbeat on 3/.test(text));
  assert.ok(/Hi-hat: steady 16ths; 32nd rolls about once every 4 bars/.test(text), text);
  assert.ok(text.includes('i–VI–III–VII (4 tracks)'));
  assert.ok(/root 33%/.test(text) && /land with a kick/.test(text));
  assert.ok(text.includes('pattern "Dark trap drums sketch"'));
  assert.ok(text.includes('pattern "Dark trap bass sketch"'));
  assert.ok(/Caveats:/.test(text));
  const short = profileText(p, { maxChars: 900 });
  assert.ok(short.length <= 900, `short length ${short.length}`);
  assert.ok(short.startsWith('STYLE PROFILE'));
  assert.ok(short.includes('Tempo:'), 'high-priority blocks survive');
});

test('featureVector layout, NaN for missing data, similarity bounds', () => {
  assert.equal(VECTOR_VERSION, 1);
  const a = synth({ bpm: 140, bars: 16, drums: trapDrums(true) });
  const v = featureVector(a, drumGrid(a, a.drumHits!, 'mix'));
  assert.equal(v.length, FEATURE_NAMES.length);
  assert.ok(v.every((x) => Number.isFinite(x)), 'a full analysis fills every dimension');
  const noDrums = featureVector(a, null);
  assert.ok(Number.isNaN(noDrums[FEATURE_NAMES.indexOf('drums.kick')]));
  const half = featureVector(synth({ bpm: 70, bars: 16 }), null);
  close(half[0], noDrums[0], 1e-3);
  close(half[1], noDrums[1], 1e-3);
  assert.notEqual(half[2], noDrums[2]);
  const am = featureVector(synth({ bpm: 100, bars: 4, key: 'Am' }), null);
  const c = featureVector(synth({ bpm: 100, bars: 4, key: 'C' }), null);
  const ki = FEATURE_NAMES.indexOf('key.fifths.sin');
  close(am[ki], c[ki], 1e-9);
  assert.notEqual(am[ki + 2], c[ki + 2]);
  assert.equal(similarity(v, v), 1);
  close(similarity(v, noDrums), similarity(noDrums, v), 1e-12);
  const json = JSON.parse(JSON.stringify(noDrums)) as number[];
  assert.equal(similarity(json, noDrums), 1, 'NaN dims survive a JSON round trip as null and are skipped');
  assert.equal(similarity([], v), 0);
});

test('nearest ranks a near-duplicate first', () => {
  const inputs = trapCollection();
  const items = inputs.map((x) => ({ id: x.track.id, vector: x.features.vector }));
  const ambient = synth({ bpm: 80, bars: 16, key: 'D', lufs: -16, width: 0.8, onsetRate: 1.2 });
  items.push({ id: 'ambient', vector: featureVector(ambient, null) });
  const dup = synth({ bpm: 141, bars: 30, key: 'Am', lufs: -8.3, drums: trapDrums(true) });
  const target = featureVector(dup, drumGrid(dup, dup.drumHits!, 'mix'));
  const res = nearest(target, items, 3);
  assert.equal(res.length, 3);
  assert.equal(res[0].id, 't3');
  assert.ok(res[0].score > 0.8, `score ${res[0].score}`);
  assert.ok(!res.some((r) => r.id === 'ambient'));
  assert.ok(res[0].score >= res[1].score && res[1].score >= res[2].score);
  assert.deepEqual(nearest(target, items, 0), []);
});

const HOOK: Array<[number, number]> = [
  [0, 67],
  [0.5, 70],
  [0.75, 72],
  [1, 70],
  [1.5, 67],
  [2.5, 65],
  [3, 67],
  [3.5, 62],
  [4.25, 65],
  [4.5, 67],
];

function referenceLine(hookAt = 16): BeatNote[] {
  const out: BeatNote[] = [];
  const filler = [60, 72, 55, 69, 58, 76, 61, 53, 74, 64, 57, 71];
  for (let i = 0; i < 12; i++) out.push({ beat: i * 1.25, dur: 0.5, key: filler[i], vel: 0.8 });
  for (const [b, k] of HOOK) out.push({ beat: hookAt + b, dur: 0.25, key: k, vel: 0.8 });
  for (let i = 0; i < 12; i++) out.push({ beat: hookAt + 6 + i * 0.75, dur: 0.5, key: filler[(i * 5) % 12] + 1, vel: 0.8 });
  return out;
}

function ref(notes: BeatNote[], id = 'r1'): ReferenceLine {
  return { trackId: id, trackName: `Ref ${id}`, stem: 'vocals', notes, bpm: 120, downbeatSec: 0.5 };
}

function line(notes: Array<{ tick: number; dur: number; key: number }>, label = 'Pattern "Hook" · Lead'): ProjectLine {
  return { label, patternId: 'p1', channelId: 'ch1', notes };
}

function projectHook(semi: number, scale: number, tick: number, mutate?: (keys: number[]) => void): ProjectLine {
  const keys = HOOK.map(([, k]) => k + semi);
  mutate?.(keys);
  const notes = [
    { tick: 0, dur: 480, key: 50 },
    { tick: 960, dur: 480, key: 62 },
    { tick: 1920, dur: 480, key: 45 },
    ...HOOK.map(([b], i) => ({ tick: tick + Math.round(b * scale * PPQ), dur: 240, key: keys[i] })),
    { tick: tick + Math.round(6 * scale * PPQ), dur: 480, key: 40 },
    { tick: tick + Math.round(7 * scale * PPQ), dur: 480, key: 79 },
  ];
  return line(notes);
}

test('lineHashes are transposition- and tempo-invariant; repeated-note windows are skipped', () => {
  const orig = HOOK.map(([b, k]) => ({ start: b, dur: 0.25, key: k }));
  const copy = HOOK.map(([b, k]) => ({ start: 10 + b * 2, dur: 0.5, key: k - 7 }));
  const h1 = lineHashes(orig);
  const h2 = lineHashes(copy);
  assert.equal(h1.length, HOOK.length - NGRAM_NOTES + 1);
  assert.deepEqual(h1, h2);
  assert.ok(h1.every((h) => Number.isInteger(h.hash) && h.hash >= 0 && h.hash <= 0xffffffff));
  const chordy = [...orig, ...orig.map((n) => ({ ...n, key: n.key - 12, start: n.start + 0.01 }))];
  assert.deepEqual(lineHashes(chordy), h1);
  const refHashes = new Set(beatNoteHashes(referenceLine(16)).map((h) => h.hash));
  const projHashes = projectLineHashes(projectHook(5, 2, 7680));
  assert.equal(projHashes.filter((h) => refHashes.has(h.hash)).length, HOOK.length - NGRAM_NOTES + 1);
  const pedal = Array.from({ length: 8 }, (_, i) => ({ start: i, dur: 0.5, key: 40 }));
  assert.deepEqual(lineHashes(pedal), []);
  const other = HOOK.map(([b, k], i) => ({ start: i % 2 ? b + 0.2 : b, dur: 0.25, key: k }));
  assert.notDeepEqual(lineHashes(other), h1);
});

test('findMatches finds a transposed, tempo-scaled copy inside a longer reference line', () => {
  const r = ref(referenceLine(16));
  const pl = projectHook(5, 2, 2 * 3840);
  const m = findMatches(pl, [r]);
  assert.equal(m.length, 1, JSON.stringify(m));
  assert.equal(m[0].notes, 10);
  assert.equal(m[0].atBar, 3);
  assert.equal(m[0].refAtSec, 8.5, 'downbeat 0.5 s + 16 beats at 120 BPM');
  const withGrid = findMatches(pl, [{ ...r, analysis: synth({ bpm: 100, bars: 16, offset: 1 }) }]);
  assert.equal(withGrid[0].refAtSec, 10.6);
  assert.equal(m[0].similarity, 1);
  assert.equal(m[0].trackId, 'r1');
  assert.equal(m[0].stem, 'vocals');
  assert.equal(m[0].line, 'Pattern "Hook" · Lead');
  assert.deepEqual(findMatches(pl, [r], { minNotes: 12 }), []);
  const twice = ref([...referenceLine(16), ...HOOK.map(([b, k]) => ({ beat: 60 + b, dur: 0.25, key: k, vel: 0.8 }))]);
  const m2 = findMatches(pl, [twice, ref(referenceLine(16), 'r2')]);
  assert.equal(m2.filter((x) => x.trackId === 'r1').length, 1, 'deduped per reference');
  assert.equal(m2.filter((x) => x.trackId === 'r2').length, 1);
});

test('findMatches rides over one wrong note, ignores different melodies and generic runs', () => {
  const r = ref(referenceLine(16));
  const wrong = findMatches(projectHook(0, 1, 7680, (k) => (k[5] += 2)), [r]);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].notes, 10);
  assert.ok(wrong[0].similarity < 1 && wrong[0].similarity >= 0.85, `similarity ${wrong[0].similarity}`);
  const other = projectHook(0, 1, 7680, (k) => k.splice(0, k.length, 60, 64, 59, 67, 62, 71, 57, 66, 61, 69));
  assert.deepEqual(findMatches(other, [r]), []);
  const scale = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];
  const refGeneric = ref([...scale.map((s, i) => ({ beat: i * 0.5, dur: 0.5, key: 60 + s, vel: 0.8 })), ...Array.from({ length: 10 }, (_, i) => ({ beat: 8 + i * 0.5, dur: 0.5, key: 55, vel: 0.8 }))]);
  const projScale = line(scale.map((s, i) => ({ tick: i * 480, dur: 480, key: 65 + s })));
  assert.deepEqual(findMatches(projScale, [refGeneric]), []);
  const projPedal = line(Array.from({ length: 10 }, (_, i) => ({ tick: i * 480, dur: 480, key: 43 })));
  assert.deepEqual(findMatches(projPedal, [refGeneric]), []);
  assert.equal(isGenericRun([2, 2, 1, 2, 2, 2, 1]), true, 'scale run');
  assert.equal(isGenericRun([2, -2, 2, -2, 2, -2, 2]), true, 'trill');
  assert.equal(isGenericRun([2, 2, 1, 2, -2, -1, -2]), true, 'up-and-down scale');
  assert.equal(isGenericRun([3, 2, -2, -3, -2, 2, -5, 3, 2]), false, 'the hook');
});

test('projectLines: pitched channels only, labels, mute and bar length', () => {
  const p = createDefaultProject('Orig');
  const pat = p.patterns[p.patternOrder[0]];
  pat.name = 'Hook';
  const id = (name: string) => p.channelOrder.find((c) => p.channels[c].name === name)!;
  let n = 0;
  const put = (ch: string, keys: number[], mute = false) => {
    pat.notes[ch] = {};
    keys.forEach((k, i) => {
      const note = defaultNote({ id: `n${n++}`, tick: i * 240, key: k });
      if (mute) note.mute = true;
      pat.notes[ch][note.id] = note;
    });
  };
  put(id('Kick'), [60, 60, 60, 60, 60, 60]);
  put(id('Hat'), [60, 62, 64, 65, 67, 69]);
  put(id('808'), [36, 36, 43, 46, 36, 41]);
  put(id('Keys'), [60, 64, 67, 72, 71, 67, 64]);
  const ins = p.mixer.insertOrder[1];
  const chop = makeChannel({ name: 'Vox chop', type: 'krypt.sampler', insertId: ins, color: '#ffffff' });
  p.channels[chop.id] = chop;
  p.channelOrder.push(chop.id);
  put(chop.id, [60, 63, 65, 67, 70]);
  const ds = makeChannel({ name: 'Lead', type: 'krypt.drumsynth', insertId: ins, color: '#ffffff' });
  p.channels[ds.id] = ds;
  p.channelOrder.push(ds.id);
  put(ds.id, [60, 62, 64, 65, 67, 69]);
  const muted = makeChannel({ name: 'Pad', type: 'krypt.triosc', insertId: ins, color: '#ffffff' });
  p.channels[muted.id] = muted;
  p.channelOrder.push(muted.id);
  put(muted.id, [60, 62, 64, 65, 67, 69], true);
  const pat2 = makePattern('Short', '#000000');
  p.patterns[pat2.id] = pat2;
  p.patternOrder.push(pat2.id);
  pat2.notes[id('Keys')] = { a: defaultNote({ id: 'a', tick: 0, key: 60 }) };
  p.transport.timeSig = { num: 3, den: 4 };

  const lines = projectLines(p);
  assert.deepEqual(
    lines.map((l) => l.label),
    ['Pattern "Hook" · 808', 'Pattern "Hook" · Keys', 'Pattern "Hook" · Vox chop'],
  );
  const keys = lines[1];
  assert.equal(keys.notes.length, 7);
  assert.deepEqual(keys.notes[1], { tick: 240, dur: 240, key: 64 });
  assert.equal(keys.barTicks, 2880);
  assert.equal(keys.patternId, pat.id);
});

test('originalitySummary always carries the disclaimer', () => {
  const r = ref(referenceLine(16));
  const matches = findMatches(projectHook(5, 2, 2 * 3840), [r]);
  const s = originalitySummary({ checkedLines: 3, references: 4, matches });
  assert.ok(s.includes('production aid, not legal advice'));
  assert.ok(s.includes('Pattern "Hook" · Lead, from bar 3: 10 notes in a row match "Ref r1" (vocals) at 0:09'), s);
  assert.ok(s.trim().endsWith('non-infringing.'));
  const none = originalitySummary({ checkedLines: 3, references: 4, matches: [] });
  assert.ok(/no run of 8\+ notes/.test(none) && none.includes('not legal advice'));
  assert.ok(originalitySummary({ checkedLines: 0, references: 0, matches: [] }).includes('deep analysis'));
  assert.ok(originalitySummary({ checkedLines: 0, references: 2, matches: [] }).includes('No melodic lines'));
});

const PERF_TRACKS = process.env.KRYPT_PERF ? 5000 : 500;
test(`buildProfile over ${PERF_TRACKS} tracks stays well under a second`, () => {
  const base = trapCollection();
  const inputs: ProfileInput[] = [];
  for (let i = 0; i < PERF_TRACKS; i++) {
    const src = base[i % base.length];
    inputs.push({ track: { ...src.track, id: `t${i}` }, features: src.features });
  }
  const t0 = performance.now();
  const p = buildProfile({ id: 'big', name: 'Big' }, inputs, { seed: 1, now: 0 });
  const ms = performance.now() - t0;
  console.log(`    buildProfile × ${PERF_TRACKS} tracks: ${ms.toFixed(0)} ms`);
  assert.equal(p.analysed, PERF_TRACKS);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

await run('library-core');
