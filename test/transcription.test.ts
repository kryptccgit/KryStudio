// Song transcription (shared/transcription, research/15 §3.3): synthetic analyses → SongTranscription on the
// project grid. Beat-synchronous grid (tempo drift), pickups, drums per role (flams, 32nd cap, velocities), chords
// (names, exact / style voicings), bass cleanup + 'style' re-pitching, the copyright line ('style' never holds lead
// or vocal notes), sections (phrase snapping, names, sameAs) and the per-section patterns. Pure, no analyzer.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { AudioAnalysis, ChordQuality, ChordSpan, DrumHit, TranscribedNote } from '@shared/analyzer/protocol';
import {
  chordAt,
  chordPcs,
  chordTimeline,
  exactVoicing,
  fixBass,
  melodyShape,
  melodyShapeText,
  monoCleanup,
  normaliseVelocities,
  referenceMelodyShape,
  sectionPatterns,
  skyline,
  snapPhrases,
  styleVoicings,
  transcribeSong,
  transcriptionGrid,
  type GridChord,
  type GridNote,
  type SongTranscription,
} from '@shared/transcription';

const BAR = 3840;

/** Deterministic jitter in ±amp seconds. */
function jitter(seed: number, amp: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}

interface SongSpec {
  bpm: number;
  bars: number;
  /** Seconds of the first downbeat. */
  t0?: number;
  /** Beats of beat grid (and audio) before the first downbeat. */
  preBeats?: number;
  /** Tempo drift: the beat period swings by ± this fraction (sine over 32 beats). */
  drift?: number;
  sections?: Array<[string, number, number, number]>;
  /** [root, quality, bars] cycled from bar 0. */
  chords?: Array<[number, ChordQuality, number]>;
  key?: string;
}

/** A synthetic analysis and `at(beat)`: seconds of a (fractional) beat from the first downbeat. */
function song(o: SongSpec): { a: AudioAnalysis; at: (beat: number) => number } {
  const t0 = o.t0 ?? 0.5;
  const pre = o.preBeats ?? 0;
  const base = 60 / o.bpm;
  const period = (b: number) => base * (1 + (o.drift ?? 0) * Math.sin((2 * Math.PI * b) / 32));
  const n = o.bars * 4;
  const times = new Map<number, number>([[0, t0]]);
  for (let b = 0; b < n + 4; b++) times.set(b + 1, times.get(b)! + period(b));
  for (let b = -1; b >= -pre - 1; b--) times.set(b, times.get(b + 1)! - base);
  const at = (beat: number) => {
    const i = Math.floor(beat);
    return times.get(i)! + (beat - i) * (times.get(i + 1)! - times.get(i)!);
  };
  const beatList = [...times.keys()].filter((b) => b >= -pre && b <= n).sort((x, y) => x - y);
  const secs = (o.sections ?? [['A', 0, o.bars, -10]]).map(([label, s, e, lufs]) => ({ startSec: s <= 0 ? 0 : at(s * 4), endSec: at(e * 4), label, lufs }));
  const chords: ChordSpan[] = [];
  if (o.chords?.length) {
    let bar = 0;
    let i = 0;
    while (bar < o.bars) {
      const [root, quality, len] = o.chords[i % o.chords.length];
      chords.push({ startSec: at(bar * 4), endSec: at(Math.min(o.bars, bar + len) * 4), root, quality, confidence: 0.8 });
      bar += len;
      i++;
    }
  }
  const a: AudioAnalysis = {
    path: 'C:\\x\\song.wav',
    durationSec: at(n) + 0.05,
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: o.bpm, confidence: 0.9, alternatives: [o.bpm / 2, o.bpm * 2] },
    beats: { times: beatList.map((b) => at(b)), downbeats: beatList.filter((b) => b >= 0 && b % 4 === 0).map((b) => at(b)), beatsPerBar: 4 },
    key: { tonic: 'A', mode: 'minor', name: o.key ?? 'Am', confidence: 0.8 },
    swing: 0,
    sections: secs,
    levels: { lufsIntegrated: -9, lufsShortMax: -7, truePeakDb: -1, peakDb: -1, rmsDb: -12, crestDb: 10, bands: { sub: -20, low: -15, lowMid: -20, mid: -22, highMid: -28, high: -40 }, clipping: false, durationSec: at(n), energyCurve: [] } as unknown as AudioAnalysis['levels'],
    stereo: { width: 0.3, correlation: 0.8 },
    energy: { hopSec: 0.5, lufs: [] },
    onsetRate: 6,
    chords,
    estimated: ['tempo', 'beats'],
    sources: ['test'],
  };
  return { a, at };
}

const part = (t: SongTranscription, name: string) => t.parts.find((p) => p.name === name);
const step16 = (tick: number) => Math.round(tick / 240);

// ── 4-on-the-floor house at 128 ─────────────────────────────────────────

const AM_F_C_G: Array<[number, ChordQuality, number]> = [
  [9, 'min', 1],
  [5, 'maj', 1],
  [0, 'maj', 1],
  [7, '7', 1],
];

function house() {
  // Intro (kick + hats) 8 bars, Drop 16, Break (no kick) 8, Drop 16; boundaries a little off the bar lines.
  const s = song({ bpm: 128, bars: 48, chords: AM_F_C_G, sections: [['A', 0, 8.3, -14], ['B', 8.3, 23.8, -8], ['C', 23.8, 32, -13], ['B', 32, 48, -8]] });
  const hits: DrumHit[] = [];
  let seed = 1;
  const hit = (beat: number, role: DrumHit['role'], vel: number) => hits.push({ timeSec: s.at(beat) + jitter(seed++, 0.006), role, vel });
  for (let bar = 0; bar < 48; bar++) {
    const drop = (bar >= 8 && bar < 24) || bar >= 32;
    const brk = bar >= 24 && bar < 32;
    for (let b = 0; b < 4; b++) {
      const beat = bar * 4 + b;
      if (!brk) hit(beat, 'kick', 0.9);
      if (drop && (b === 1 || b === 3)) hit(beat, 'snare', 0.8);
      if (b < 3) hit(beat + 0.5, 'hat', b === 1 ? 0.7 : 0.5);
      if (drop && b === 3) hit(beat + 0.5, 'openhat', 0.6);
    }
  }
  // Flams / double detections on the kicks of bar 10 (10 ms apart).
  for (let b = 0; b < 4; b++) hits.push({ timeSec: s.at(36 + b) + 0.01, role: 'kick', vel: 0.6 });
  return { ...s, hits };
}

test('house 128: tempo, bar 1 at the first downbeat, a part per role (hats and open hats apart)', () => {
  const h = house();
  const t = transcribeSong({ name: 'house', analysis: h.a, drumHits: h.hits, drumSource: 'stem', stems: { drums: 'C:\\stems\\drums.wav' } }, { mode: 'exact' });
  assert.equal(t.bpm, 128);
  assert.equal(t.beatsPerBar, 4);
  assert.ok(Math.abs(t.firstDownbeatSec - 0.5) < 0.002);
  assert.equal(t.totalBars, 48);
  assert.deepEqual(
    t.parts.filter((p) => p.kind === 'drum').map((p) => p.name),
    ['Kick', 'Snare', 'Hat', 'Open Hat'],
  );
  for (const p of t.parts.filter((p) => p.kind === 'drum')) assert.equal(p.stem, 'drums');
  const kick = part(t, 'Kick')!;
  assert.equal(kick.notes.length, 40 * 4, 'every kick once (flams merged, none in the break)');
  for (const n of kick.notes) {
    assert.equal(step16(n.tick) % 4, 0, `kick on a beat (${n.tick})`);
    assert.ok(Math.abs(n.tick - step16(n.tick) * 240) <= 10, 'feel kept but small');
  }
  for (const n of part(t, 'Hat')!.notes) assert.equal(step16(n.tick) % 4, 2, 'hats on the offbeats');
  for (const n of part(t, 'Open Hat')!.notes) assert.equal(step16(n.tick) % 16, 14, 'open hat on the and of 4');
  for (const n of part(t, 'Snare')!.notes) assert.ok([4, 12].includes(step16(n.tick) % 16), 'clap on 2 and 4');
  assert.ok(t.notes.some((x) => /merged/.test(x)), 'flams reported');
  assert.ok(!t.notes.some((x) => /full mix/.test(x)), 'drums from the stem: no mix note');
  assert.ok(kick.confidence >= 0.9, `steady kick is confident (${kick.confidence})`);
});

test('house 128: velocities normalised per role with the accents kept', () => {
  const h = house();
  const t = transcribeSong({ name: 'house', analysis: h.a, drumHits: h.hits }, { mode: 'exact' });
  const hat = part(t, 'Hat')!;
  const acc = hat.notes.filter((n) => step16(n.tick) % 16 === 6).map((n) => n.vel);
  const soft = hat.notes.filter((n) => step16(n.tick) % 16 === 2).map((n) => n.vel);
  assert.ok(Math.min(...acc) > Math.max(...soft), 'accented hats stay louder');
  assert.ok(Math.max(...acc) <= 1 && Math.max(...acc) >= 0.85);
  assert.ok(t.notes.some((x) => /full mix/.test(x)), 'mix hits are flagged');
  assert.deepEqual(normaliseVelocities([0.2, 0.4, 0.4, 0.4]), [0.45, 0.9, 0.9, 0.9]);
});

test('house 128: sections snap to phrases, get names, and the second drop reuses the first', () => {
  const h = house();
  const t = transcribeSong({ name: 'house', analysis: h.a, drumHits: h.hits, genre: 'house' }, { mode: 'exact' });
  assert.deepEqual(
    t.sections.map((s) => [s.startBar, s.bars]),
    [
      [1, 8],
      [9, 16],
      [25, 8],
      [33, 16],
    ],
  );
  const names = t.sections.map((s) => s.name);
  assert.equal(names[0], 'Intro');
  assert.match(names[1], /^(Drop|Chorus|Hook) 1$/);
  assert.equal(names[3], names[1].replace(/1$/, '2'));
  assert.match(names[2], /Break|Breakdown|Bridge/);
  assert.deepEqual(
    t.sections.map((s) => s.sameAs),
    [null, null, null, 1],
  );
  assert.equal(t.sections[1].energy, 1);
  assert.ok(t.sections[2].energy < t.sections[1].energy);

  const pats = sectionPatterns(t);
  assert.equal(pats.length, 4);
  assert.equal(pats[3].patternOf, 1);
  assert.deepEqual(pats[3].parts, pats[1].parts);
  assert.equal(pats[1].lengthTicks, 16 * BAR);
  const kick = pats[1].parts.find((p) => p.name === 'Kick')!;
  assert.equal(kick.notes.length, 64);
  assert.equal(kick.notes[0].tick, Math.max(0, kick.notes[0].tick));
  for (const p of pats) for (const q of p.parts) for (const n of q.notes) assert.ok(n.tick >= 0 && n.tick + n.dur <= p.lengthTicks, `${q.name} inside ${p.name}`);
  assert.equal(pats[2].parts.find((p) => p.name === 'Kick'), undefined, 'the break has no kick');
  // Chords carry over a section boundary: every section starts with a chord.
  for (const p of pats) assert.ok(p.parts.find((q) => q.name === 'Chords')!.notes.some((n) => n.tick === 0));
});

test('sameAs needs similar material: a drop with a different chord loop gets its own pattern', () => {
  const h = house();
  const spans = h.a.chords!.map((c) => (c.startSec >= h.at(32 * 4) - 0.01 ? { ...c, root: (c.root + 2) % 12 } : c));
  const t = transcribeSong({ name: 'house', analysis: { ...h.a, chords: spans }, drumHits: h.hits }, { mode: 'exact' });
  assert.equal(t.sections[3].sameAs, null);
});

// ── Half-time trap at 140 with hat rolls and a pickup ───────────────────

function trap() {
  const s = song({ bpm: 140, bars: 16, t0: 1.2, preBeats: 2, chords: [[0, 'min', 2], [8, 'maj', 2]], key: 'Cm', sections: [['A', 0, 8, -9], ['A', 8, 16, -9]] });
  const hits: DrumHit[] = [];
  let seed = 7;
  const hit = (beat: number, role: DrumHit['role'], vel: number) => hits.push({ timeSec: s.at(beat) + jitter(seed++, 0.004), role, vel });
  // Pickup: a snare run into bar 1 (2 beats before the first downbeat).
  for (const b of [-2, -1.5, -1, -0.75, -0.5, -0.25]) hit(b, 'snare', 0.6);
  for (let bar = 0; bar < 16; bar++) {
    const o = bar * 4;
    hit(o, 'kick', 1);
    hit(o + 2.75, 'kick', 0.8);
    hit(o + 2, 'snare', 0.9); // beat 3: half time
    for (let e = 0; e < 8; e++) if (!(bar % 4 === 3 && e >= 4 && e < 6)) hit(o + e / 2, 'hat', e % 2 ? 0.5 : 0.7);
    if (bar % 4 === 3) {
      // A 32nd roll over beat 3, plus a double detection 25 ms late (inside the same 32nd at 140 bpm: the cap).
      for (let k = 0; k < 8; k++) hit(o + 2 + k / 8, 'hat', 0.4 + k * 0.05);
      hits.push({ timeSec: s.at(o + 2) + 0.025, role: 'hat', vel: 0.3 });
    }
  }
  return { ...s, hits };
}

test('trap 140 half time: pickup dropped, bar 1 on the downbeat, snare on 3, 32nd hat rolls kept and capped', () => {
  const tr = trap();
  const t = transcribeSong({ name: 'trap', analysis: tr.a, drumHits: tr.hits }, { mode: 'exact' });
  assert.equal(t.bpm, 140, 'the trap reading of 140 is 140');
  assert.ok(Math.abs(t.firstDownbeatSec - 1.2) < 0.002);
  assert.ok(t.notes.some((x) => /pickup/.test(x)), `pickup reported: ${t.notes.join(' | ')}`);
  const snare = part(t, 'Snare')!;
  assert.equal(snare.notes.length, 16, 'the pickup roll is not in bar 1');
  for (const n of snare.notes) assert.equal(step16(n.tick) % 16, 8, 'snare on beat 3');
  const kick = part(t, 'Kick')!;
  assert.deepEqual([...new Set(kick.notes.map((n) => step16(n.tick) % 16))].sort((a, b) => a - b), [0, 11]);
  const hat = part(t, 'Hat')!;
  const roll = hat.notes.filter((n) => n.tick >= 3 * BAR + 2 * 960 && n.tick < 3 * BAR + 3 * 960);
  assert.equal(roll.length, 8, 'eight 32nds over beat 3 of bar 4');
  for (let i = 1; i < roll.length; i++) assert.ok(Math.abs(roll[i].tick - roll[i - 1].tick - 120) <= 12, '32nd spacing');
  for (let i = 1; i < hat.notes.length; i++) assert.ok(hat.notes[i].tick - hat.notes[i - 1].tick >= 100, 'never denser than 32nds');
  assert.ok(roll.every((n) => n.dur <= 140), 'roll notes no longer than the gap');
  assert.ok(roll[7].vel > roll[0].vel, 'roll crescendo kept');
});

test('trap: a whole bar of material before the first downbeat moves bar 1 back instead of dropping it', () => {
  const s = song({ bpm: 140, bars: 8, t0: 2.0, preBeats: 4 });
  const hits: DrumHit[] = [];
  for (let b = -4; b < 32; b++) hits.push({ timeSec: s.at(b), role: 'kick', vel: 0.9 });
  const t = transcribeSong({ name: 'x', analysis: s.a, drumHits: hits }, { mode: 'exact', factor: 1 });
  assert.ok(Math.abs(t.firstDownbeatSec - s.at(-4)) < 0.005, `bar 1 a bar earlier (${t.firstDownbeatSec})`);
  assert.equal(part(t, 'Kick')!.notes.length, 36);
  assert.equal(part(t, 'Kick')!.notes[0].tick, 0);
});

// ── A live recording with ±3% tempo drift ───────────────────────────────

test('live drift ±3%: onsets land on the right 16ths (a constant tempo would not)', () => {
  const s = song({ bpm: 120, bars: 32, drift: 0.03 });
  const PAT: Record<string, number[]> = { kick: [0, 6, 10], snare: [4, 12], hat: [1, 3, 5, 7, 9, 11, 13, 15] };
  const hits: DrumHit[] = [];
  const expected = new Map<string, number[]>();
  let seed = 3;
  for (let bar = 0; bar < 32; bar++)
    for (const [role, steps] of Object.entries(PAT))
      for (const st of steps) {
        hits.push({ timeSec: s.at(bar * 4 + st / 4) + jitter(seed++, 0.008), role: role as DrumHit['role'], vel: 0.8 });
        expected.set(role, [...(expected.get(role) ?? []), bar * 16 + st]);
      }
  const t = transcribeSong({ name: 'live', analysis: s.a, drumHits: hits }, { mode: 'exact', factor: 1 });
  for (const [role, steps] of expected) {
    const p = t.parts.find((x) => x.drumRole === role)!;
    assert.deepEqual(
      p.notes.map((n) => step16(n.tick)),
      steps.sort((a, b) => a - b),
      role,
    );
  }
  // The same hits at one constant tempo drift off the grid.
  const t0 = s.at(0);
  const wrong = hits.filter((h, i) => Math.round(((h.timeSec - t0) * 120) / 60 * 4) !== [...expected.values()].flat()[i]).length;
  assert.ok(wrong > 50, `a constant tempo misplaces many hits (${wrong})`);
});

// ── Chords ──────────────────────────────────────────────────────────────

test('chords: snapped to beats, merged, named; exact voicing from agreeing poly notes, else root position', () => {
  const s = song({ bpm: 120, bars: 8 });
  const b = (beat: number) => s.at(beat);
  const spans: ChordSpan[] = [
    { startSec: b(0) + 0.04, endSec: b(4) - 0.03, root: 9, quality: 'min', confidence: 0.8 },
    { startSec: b(4) - 0.03, endSec: b(8), root: 9, quality: 'min', confidence: 0.6 },
    { startSec: b(8), endSec: b(12) + 0.04, root: 5, quality: 'maj', confidence: 0.7 },
    { startSec: b(12) + 0.04, endSec: b(14), root: 0, quality: 'maj', confidence: 0.7 },
    { startSec: b(14), endSec: b(16), root: 7, quality: '7', confidence: 0.5 },
  ];
  const g = transcriptionGrid(s.a, 1);
  const chords = chordTimeline(spans, g);
  assert.deepEqual(
    chords.map((c) => [c.name, c.tick / 960, c.dur / 960]),
    [
      ['Am', 0, 8],
      ['F', 8, 4],
      ['C', 12, 2],
      ['G7', 14, 2],
    ],
  );
  assert.equal(chords[0].confidence, 0.7);
  // Poly notes: a clear A minor (A3 C4 E4) under Am; under F something else entirely.
  const poly = [
    { tick: 0, end: 8 * 960, key: 57 },
    { tick: 0, end: 8 * 960, key: 60 },
    { tick: 0, end: 8 * 960, key: 64 },
    { tick: 8 * 960, end: 12 * 960, key: 62 },
    { tick: 8 * 960, end: 12 * 960, key: 68 },
  ];
  const am = exactVoicing(chords[0], poly, 55);
  assert.deepEqual(am, { keys: [57, 60, 64], fromNotes: true });
  const f = exactVoicing(chords[1], poly, 55);
  assert.equal(f.fromNotes, false);
  assert.deepEqual(f.keys, [65, 69, 72], 'F root position from the register up');
  // Style: close voicings around C4 with the same changes, smooth voice leading.
  const v = styleVoicings(chords);
  v.forEach((keys, i) => {
    assert.ok(keys.every((k) => k >= 55 && k <= 72), `around C4: ${keys}`);
    assert.deepEqual(new Set(keys.map((k) => k % 12)), new Set(chordPcs(chords[i])));
  });
  for (let i = 1; i < v.length; i++) {
    const mean = (x: number[]) => x.reduce((p, q) => p + q, 0) / x.length;
    assert.ok(Math.abs(mean(v[i]) - mean(v[i - 1])) <= 4, 'smooth voice leading');
  }
  assert.equal(chordAt(chords, 13 * 960)!.name, 'C');
  assert.equal(chordAt(chords, 16 * 960), null);
});

// ── Bass, lead and the copyright line ───────────────────────────────────

function withLines() {
  const h = house();
  const n = (beat: number, beats: number, key: number, vel = 0.8): TranscribedNote => ({ startSec: h.at(beat), durSec: h.at(beat + beats) - h.at(beat), key, vel });
  const ROOT = [45, 41, 36, 43]; // A2 F2 C2 G2 (Am F C G)
  const bass: TranscribedNote[] = [];
  const other: TranscribedNote[] = [];
  const vocals: TranscribedNote[] = [];
  const TRIAD: Record<number, number[]> = { 0: [57, 60, 64], 1: [53, 57, 60], 2: [55, 60, 64], 3: [55, 59, 62, 65] };
  const MELODY = [76, 74, 72, 74, 76, 76, 79, 77];
  for (let bar = 0; bar < 48; bar++) {
    const r = ROOT[bar % 4];
    // An offbeat bassline: root, root, octave, fifth.
    bass.push(n(bar * 4 + 0.5, 0.5, r), n(bar * 4 + 1.5, 0.5, r), n(bar * 4 + 2.5, 0.5, r + 12), n(bar * 4 + 3.5, 0.25, r + 7));
    for (const k of TRIAD[bar % 4]) other.push(n(bar * 4, 4, k, 0.6));
    // A lead on top, an octave up, eighths.
    for (let e = 0; e < 8; e++) other.push(n(bar * 4 + e / 2, 0.5, MELODY[(bar + e) % 8], 0.7));
    for (let e = 0; e < 4; e++) vocals.push(n(bar * 4 + e, 0.75, MELODY[(bar * 3 + e) % 8] - 12, 0.7));
  }
  // Mono transcription faults: a 20 ms blip, a legato fragment and an octave error.
  bass.push({ startSec: h.at(1.1), durSec: 0.02, key: 70, vel: 0.5 });
  bass.push({ startSec: h.at(4.5) + (h.at(5) - h.at(4.5)) + 0.005, durSec: 0.05, key: 41, vel: 0.5 });
  const err = bass.findIndex((x) => Math.abs(x.startSec - h.at(9 * 4 + 1.5)) < 1e-6);
  bass[err] = { ...bass[err], key: bass[err].key + 24 };
  return { ...h, bass, other, vocals };
}

test("style never holds lead or vocal notes; its bass keeps the rhythm on chord tones", () => {
  const w = withLines();
  const input = { name: 'ref', analysis: w.a, drumHits: w.hits, bass: w.bass, other: w.other, vocals: w.vocals, stems: { drums: 'd.wav', bass: 'b.wav', other: 'o.wav', vocals: 'v.wav' } };
  const exact = transcribeSong(input, { mode: 'exact' });
  const style = transcribeSong(input, { mode: 'style' });
  assert.ok(part(exact, 'Lead'), 'exact has the lead');
  assert.ok(part(exact, 'Vocal')?.kind === 'vocal-audio', 'exact keeps the vocal as audio');
  for (const p of style.parts) assert.ok(['drum', 'bass', 'chords'].includes(p.kind), `style part ${p.name} (${p.kind})`);
  assert.ok(!style.parts.some((p) => /lead|vocal/i.test(p.name)));
  for (const p of sectionPatterns(style)) for (const q of p.parts) assert.ok(['drum', 'bass', 'chords'].includes(q.kind));
  // The melody's notes appear nowhere: every pitched note is a tone of the chord under it.
  const eb = part(exact, 'Bass')!;
  const sb = part(style, 'Bass')!;
  assert.deepEqual(
    sb.notes.map((n) => [n.tick, n.dur]),
    eb.notes.map((n) => [n.tick, n.dur]),
    'bass onsets and lengths kept',
  );
  for (const n of sb.notes) {
    const c = chordAt(style.chords, n.tick)!;
    assert.ok(chordPcs(c).includes(n.key % 12), `bass ${n.key} in ${c.name}`);
    assert.ok(n.key >= 28 && n.key <= 64, 'bass register');
  }
  for (const n of part(style, 'Chords')!.notes) assert.ok(chordPcs(chordAt(style.chords, n.tick)!).includes(n.key % 12));
  // The contour survives: the octave hits sit above the roots.
  const bar2 = sb.notes.filter((n) => n.tick >= BAR * 12 && n.tick < BAR * 13);
  assert.equal(bar2[2].key - bar2[0].key, 12, 'octave class');
  assert.equal(bar2[3].key - bar2[0].key, 7, 'fifth class');
  assert.ok(style.notes.some((x) => /no melody, lead or vocal/i.test(x)));
  // The user's own song: exact bass and the lead are kept.
  const mine = transcribeSong(input, { mode: 'style', mine: true });
  assert.deepEqual(part(mine, 'Bass')!.notes, eb.notes);
  assert.ok(part(mine, 'Lead'));
  assert.ok(!part(mine, 'Vocal'));
});

test('bass cleanup: blips dropped, legato fragments merged, octave errors fixed, register sane', () => {
  const w = withLines();
  const t = transcribeSong({ name: 'ref', analysis: w.a, drumHits: w.hits, bass: w.bass, stems: { bass: 'b.wav' } }, { mode: 'exact' });
  const bass = part(t, 'Bass')!;
  assert.equal(bass.stem, 'bass');
  assert.equal(bass.notes.length, 48 * 4, 'blip and fragment gone');
  assert.ok(!bass.notes.some((n) => n.key === 70));
  const fixed = bass.notes.find((n) => n.tick === BAR * 9 + 1.5 * 960 || Math.abs(n.tick - (BAR * 9 + 1440)) < 30)!;
  assert.equal(fixed.key, 41, 'the octave error is back on F2');
  assert.ok(t.notes.some((x) => /octave/.test(x)));
  for (let i = 1; i < bass.notes.length; i++) assert.ok(bass.notes[i - 1].tick + bass.notes[i - 1].dur <= bass.notes[i].tick, 'mono');
  // Unit: monoCleanup and fixBass directly.
  const m = monoCleanup([
    { startSec: 0, durSec: 0.2, key: 40, vel: 0.8 },
    { startSec: 0.21, durSec: 0.06, key: 40, vel: 0.8 },
    { startSec: 0.5, durSec: 0.03, key: 50, vel: 0.8 },
    { startSec: 0.6, durSec: 0.2, key: 40, vel: 0.8 },
    { startSec: 0.8, durSec: 0.2, key: 40, vel: 0.8 },
  ]);
  assert.equal(m.notes.length, 3, 'a repeated note is not a fragment');
  assert.ok(Math.abs(m.notes[0].durSec - 0.27) < 1e-9);
  assert.equal(m.blips, 1);
  assert.equal(m.merged, 1);
  const high: GridNote[] = Array.from({ length: 8 }, (_, i) => ({ tick: i * 960, key: 69, dur: 480, vel: 0.8 }));
  const chords: GridChord[] = [{ tick: 0, dur: 8 * 960, root: 9, quality: 'min', name: 'Am', confidence: 1 }];
  const r = fixBass(high, chords);
  assert.equal(r.registerShift, -24);
  assert.ok(r.notes.every((n) => n.key === 45));
});

test('exact chords are voiced from the other stem; the lead is its top line without the block chords', () => {
  const w = withLines();
  const t = transcribeSong({ name: 'ref', analysis: w.a, drumHits: w.hits, other: w.other, stems: { other: 'o.wav' } }, { mode: 'exact' });
  const chordsPart = part(t, 'Chords')!;
  const first = chordsPart.notes.filter((n) => n.tick === 0).map((n) => n.key);
  assert.deepEqual(first, [57, 60, 64], 'Am as played');
  assert.ok(t.notes.some((x) => /48 of 48 chords voiced/.test(x)), t.notes.join(' | '));
  const lead = part(t, 'Lead')!;
  assert.equal(lead.notes.length, 48 * 8);
  assert.ok(lead.notes.every((n) => n.key >= 72), 'only the melody, no chord tones from the pad');
  const top = skyline(w.other);
  assert.equal(top.length, 48 * 8);
});

// ── Sections and melody shape ───────────────────────────────────────────

test('phrase snapping: lengths within a bar of a 4-bar phrase take it; others stay', () => {
  assert.deepEqual(snapPhrases([0, 7, 15, 31], 40), [0, 8, 16, 32]);
  assert.deepEqual(snapPhrases([0, 9, 17], 26), [0, 8, 16]);
  assert.deepEqual(snapPhrases([0, 6, 12], 20), [0, 6, 12], '2 bars off a phrase: kept');
  assert.deepEqual(snapPhrases([0, 3, 4], 8), [0, 3, 4], 'cannot swallow the next section');
  const s = song({ bpm: 124, bars: 40, sections: [['A', 0, 7.2, -12], ['B', 7.2, 15.1, -8], ['A', 15.1, 31, -12], ['B', 31, 40, -8]] });
  const t = transcribeSong({ name: 'x', analysis: s.a }, { mode: 'exact', factor: 1 });
  assert.deepEqual(
    t.sections.map((x) => [x.startBar, x.bars]),
    [
      [1, 8],
      [9, 8],
      [17, 16],
      [33, 8],
    ],
  );
  assert.equal(t.notes.some((x) => /No drum hits/.test(x)), true);
});

test('half / double readings: the grid scales, sections keep their place', () => {
  const h = house();
  const half = transcribeSong({ name: 'h', analysis: h.a, drumHits: h.hits }, { mode: 'exact', factor: 0.5 });
  assert.equal(half.bpm, 64);
  assert.equal(half.totalBars, 24);
  assert.equal(half.sections[1].startBar, 5);
  assert.ok(half.notes.some((x) => /half time/.test(x)));
  const dbl = transcribeSong({ name: 'h', analysis: h.a, drumHits: h.hits }, { mode: 'exact', factor: 2 });
  assert.equal(dbl.bpm, 256);
  assert.equal(dbl.totalBars, 96);
  assert.equal(dbl.swingPercent, null);
  for (const n of part(dbl, 'Kick')!.notes) assert.equal(step16(n.tick) % 8, 0, 'a kick every half bar');
});

test('melody shape: register, density, rhythm, phrases, rests and steps vs leaps', () => {
  const line: GridNote[] = [];
  // Two-bar phrases of eighths (C D E D C D E D), a bar of rest, repeated 4 times.
  const keys = [72, 74, 76, 74, 72, 74, 76, 74];
  for (let p = 0; p < 4; p++) for (let i = 0; i < 16; i++) line.push({ tick: p * 3 * BAR + i * 480, key: keys[i % 8], dur: 480, vel: 0.7 });
  const s = melodyShape(line, BAR, 'vocals')!;
  assert.equal(s.medianName, 'D5');
  assert.equal(s.rangeSemis, 4);
  assert.equal(s.notesPerBar, 8);
  assert.equal(s.rhythm.eighths, 1);
  assert.equal(s.phraseBars, 2);
  assert.ok(s.restRatio > 0.25 && s.restRatio < 0.4, `rests ${s.restRatio}`);
  assert.ok(s.intervals.steps > 0.9);
  assert.equal(s.onBeat, 0.5);
  assert.match(melodyShapeText(s), /ORIGINAL melody/);
  assert.equal(melodyShape(line.slice(0, 3)), null);
  const w = withLines();
  const ref = referenceMelodyShape({ name: 'r', analysis: w.a, drumHits: w.hits, vocals: w.vocals })!;
  assert.equal(ref.source, 'vocals');
  assert.equal(ref.notesPerBar, 4);
});

test('no tempo: a rough grid with a plain note, nothing thrown', () => {
  const s = song({ bpm: 120, bars: 4 });
  const a: AudioAnalysis = { ...s.a, tempo: null, beats: null, sections: [], chords: [] };
  const t = transcribeSong({ name: 'amb', analysis: a }, { mode: 'style' });
  assert.equal(t.bpm, 120);
  assert.equal(t.sections.length, 1);
  assert.ok(t.notes.some((x) => /No steady tempo/.test(x)));
});

void run('transcription');
