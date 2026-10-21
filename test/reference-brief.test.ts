// "Make something like this song" (shared/reference): the brief study_reference
// builds from one analysis (tempo reading, section plan in 4-bar phrases with
// energy, drum feel per 16th, chord loop, mix numbers), the genre guess
// against every playbook's own drum patterns, the playbook adapted to the
// reference (get_playbook / review_song), the recipe text, and review_song's
// checks against the reference. Pure: synthetic analyses, no analyzer.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { AudioAnalysis, DrumHit } from '@shared/analyzer/protocol';
import type { Playbook } from '@shared/playbooks/types';
import { listPlaybooks, playbookFor } from '@shared/playbooks';
import { parse } from '@shared/kpn';
import { sameFamily, type GenreId } from '@shared/sounds/genres';
import { adaptPlaybook, briefText, chordKeys, chordLoop, closeCall, diatonic, drumFeel, gridSteps16, guessGenres, loopNumerals, pickKey, planKinds, playbookDrums, prefersMinor, readingFor, referenceBrief, sectionPlan } from '@shared/reference';
import { drumGrid } from '@shared/library/grid';
import { buildRecipe, plainPicker } from '../electron/mcp/tools/craftRecipe';
import { FACTORY_PRESETS } from '@shared/sounds/factory';

const PBS = listPlaybooks();

/** A synthetic analysis: `bars` bars at `bpm` (downbeat at 0.1 s), sections [label, startBar, endBar, lufs], hits at beats. */
function song(o: { bpm: number; bars: number; sections?: Array<[string, number, number, number]>; hits?: Array<{ beat: number; role: DrumHit['role'] }>; key?: string; swing?: number | null; chords?: Array<[number, 'maj' | 'min', number]>; lufs?: number }): AudioAnalysis {
  const spb = 60 / o.bpm;
  const t = (beat: number) => 0.1 + beat * spb;
  const n = o.bars * 4;
  const secs = (o.sections ?? [['A', 0, o.bars, -10]]).map(([label, a, b, lufs]) => ({ startSec: a === 0 ? 0 : t(a * 4), endSec: t(b * 4), label, lufs }));
  const chords = (o.chords ?? []).length
    ? Array.from({ length: o.bars }, (_, bar) => {
        const c = o.chords![bar % o.chords!.length];
        return { startSec: t(bar * 4), endSec: t(bar * 4 + 4), root: c[0], quality: c[1], confidence: 0.8 };
      })
    : [];
  const key = o.key ?? 'Am';
  return {
    path: 'C:\\x\\song.wav',
    durationSec: t(n),
    sampleRate: 44100,
    channels: 2,
    tempo: { bpm: o.bpm, confidence: 0.9, alternatives: [o.bpm / 2, o.bpm * 2] },
    beats: { times: Array.from({ length: n }, (_, i) => t(i)), downbeats: Array.from({ length: o.bars }, (_, i) => t(i * 4)), beatsPerBar: 4 },
    key: { tonic: key.replace(/m$/, ''), mode: key.endsWith('m') ? 'minor' : 'major', name: key, confidence: 0.8 },
    swing: o.swing === undefined ? 0.02 : o.swing,
    sections: secs,
    levels: { durationSec: t(n), peakDb: -0.5, truePeakDb: -0.3, lufsIntegrated: o.lufs ?? -8, lufsShortTermMax: -7, loudnessRange: 6, rmsDb: -10, crestDb: 8, bands: { sub: -9, low: -10, lowMid: -14, mid: -16, highMid: -20, high: -27 }, stereoCorrelation: 0.5, stereoWidth: 0.4, energyCurve: [], clipping: false, estimatedBpm: o.bpm, spectralCentroidHz: 1500 },
    stereo: { width: 0.4, correlation: 0.5 },
    energy: { hopSec: 0.5, lufs: [] },
    onsetRate: 5,
    chords,
    drumHits: (o.hits ?? []).map((h) => ({ timeSec: t(h.beat), role: h.role, vel: 0.8 })),
    estimated: ['tempo', 'beats', 'key', 'swing', 'sections', 'chords', 'drumHits'],
    sources: ['test'],
  };
}

/** Drum hits (in beats) of a playbook's own main drum pattern, repeated over `bars` bars. */
function playbookHits(pb: Playbook, bars: number): Array<{ beat: number; role: DrumHit['role'] }> {
  const pat = pb.patterns.find((x) => x.for.some((f) => ['drop', 'hook', 'chorus'].includes(f.toLowerCase()))) ?? pb.patterns[0];
  const r = parse(pat.kpn, { requireHeader: true });
  const map: Record<string, DrumHit['role']> = { kick: 'kick', snare: 'snare', clap: 'snare', hat: 'hat', openhat: 'openhat', perc: 'perc', rim: 'perc', tom: 'perc' };
  const out: Array<{ beat: number; role: DrumHit['role'] }> = [];
  const beatsPer = r.barTicks / 4;
  for (const tr of r.tracks) {
    const part = pb.parts.find((x) => x.name.toLowerCase() === tr.name.replace(/\/\d+$/, '').trim().toLowerCase());
    const role = part ? map[part.role] : undefined;
    if (!role) continue;
    for (let rep = 0; rep * r.bars < bars; rep++) for (const n of tr.notes) out.push({ beat: rep * r.bars * 4 + n.tick / beatsPer, role });
  }
  return out;
}

// ── Genre guess ─────────────────────────────────────────────────────────

test('genre guess: each playbook\'s own drums at its own tempo come back as that genre (or its family) near the top', () => {
  let top1 = 0;
  let top3 = 0;
  let family = 0;
  const misses: string[] = [];
  for (const pb of PBS) {
    const a = song({ bpm: pb.bpm.typical, bars: 32, hits: playbookHits(pb, 32), swing: pb.swing / 100 });
    const grid = drumGrid(a, a.drumHits!, 'mix');
    const g = guessGenres({ detectedBpm: pb.bpm.typical, swing: pb.swing / 100, grid }, PBS, 3);
    if (g[0]?.id === pb.id) top1++;
    if (g.some((x) => x.id === pb.id)) top3++;
    else misses.push(`${pb.id} → ${g.map((x) => `${x.id} ${x.score}`).join(', ')}`);
    if (g[0] && (g[0].id === pb.id || sameFamily(g[0].id, pb.id))) family++;
  }
  // Measured 2026-10-12: exact 16/18, top 3 17/18, family 17/18 (future bass reads as trap-family half-time).
  assert.ok(top3 >= PBS.length - 2, `in the top 3 for ${top3}/${PBS.length}; misses: ${misses.join(' | ')}`);
  assert.ok(family >= PBS.length - 2, `top guess in the right family for ${family}/${PBS.length}`);
  assert.ok(top1 >= PBS.length - 4, `top guess exact for ${top1}/${PBS.length}`);
});

test('genre guess: half / double-time readings; no tempo → no guess; reasons in words', () => {
  const trap = playbookFor('trap')!;
  // A trap beat that the detector read at half its tempo still reads as trap at the playbook's tempo.
  const r = readingFor(trap, trap.bpm.typical / 2);
  assert.deepEqual([r.bpm, r.factor, r.inRange], [trap.bpm.typical, 2, true]);
  assert.equal(readingFor(trap, 400).inRange, false);
  const a = song({ bpm: 128, bars: 16, hits: Array.from({ length: 64 }, (_, b) => [{ beat: b, role: 'kick' as const }, ...(b % 2 ? [{ beat: b, role: 'snare' as const }] : []), { beat: b + 0.5, role: 'hat' as const }]).flat() });
  const g = guessGenres({ detectedBpm: 128, swing: 0.02, grid: drumGrid(a, a.drumHits!, 'mix') }, PBS, 3);
  assert.ok(g.length === 3 && g.every((x) => x.score > 0 && x.score <= 1));
  assert.ok(['house', 'tech-house', 'deep-house', 'techno', 'edm'].includes(g[0].id), JSON.stringify(g));
  assert.ok(g[0].why.some((w) => /tempo 128 in/.test(w)), g[0].why.join());
  assert.deepEqual(guessGenres({ detectedBpm: null, swing: null, grid: null }, PBS), []);
  // Without drums the tempo alone keeps every score modest.
  assert.ok(guessGenres({ detectedBpm: 128, swing: null, grid: null }, PBS, 1)[0].score <= 0.6);
});

// ── Drum feel ───────────────────────────────────────────────────────────

test('drum feel: four on the floor, backbeat, hat density, per 16th at each tempo reading', () => {
  const hits = Array.from({ length: 64 }, (_, b) => [{ beat: b, role: 'kick' as const }, ...(b % 4 === 1 || b % 4 === 3 ? [{ beat: b, role: 'snare' as const }] : []), { beat: b, role: 'hat' as const }, { beat: b + 0.5, role: 'hat' as const }]).flat();
  const a = song({ bpm: 124, bars: 16, hits });
  const grid = drumGrid(a, a.drumHits!, 'mix')!;
  const f = drumFeel(grid, 1, 124, 4);
  assert.deepEqual([f.fourOnFloor, f.backbeat, f.hats, f.bars], [true, 'two-four', '8ths', 16]);
  assert.deepEqual(f.steps.kick, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  // Read at double time, one analysed bar is two bars here: the kick lands on every other beat, the snare on 3.
  const d = gridSteps16(grid, 2);
  assert.deepEqual(d.kick, [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(drumFeel(grid, 2, 124, 4).backbeat, 'three');
  // Half time: two analysed bars per bar here.
  assert.equal(gridSteps16(grid, 0.5).kick!.filter((x) => x > 0).length, 8);
  // A playbook's own drums measure the same way.
  const house = playbookDrums(playbookFor('house')!)!;
  assert.ok(house.bars >= 2 && (house.steps.kick?.[0] ?? 0) > 0.9 && (house.steps.kick?.[4] ?? 0) > 0.9, JSON.stringify(house.steps.kick));
});

// ── Section plan ────────────────────────────────────────────────────────

const EDM_SECTIONS: Array<[string, number, number, number]> = [
  ['A', 0, 8, -16],
  ['B', 8, 16, -12],
  ['C', 16, 32, -8],
  ['D', 32, 40, -15],
  ['C', 40, 56, -8],
  ['A', 56, 64, -14],
];

test('section plan: 4-bar phrases, energy against the loudest, tiny sections merged, readings double the bars', () => {
  const a = song({ bpm: 128, bars: 64, sections: EDM_SECTIONS });
  const b = referenceBrief(a, { name: 'Song', genre: 'edm', playbooks: PBS });
  assert.deepEqual(b.plan.map((p) => [p.label, p.startBar, p.bars, p.energy]), [
    ['A', 1, 8, 0.2],
    ['B', 9, 8, 0.6],
    ['C', 17, 16, 1],
    ['D', 33, 8, 0.3],
    ['C', 41, 16, 1],
    ['A', 57, 8, 0.4],
  ]);
  assert.equal(b.totalBars, 64);
  assert.equal(b.form, 'A B C D C A');
  // Read at double time (detected 64 for a 128 genre), every section doubles in bars.
  const half = song({ bpm: 64, bars: 32, sections: EDM_SECTIONS.map(([l, s, e, v]) => [l, s / 2, e / 2, v] as [string, number, number, number]) });
  const p2 = sectionPlan(referenceBrief(half, { name: 'x', playbooks: [] }), 128);
  assert.deepEqual(p2.map((p) => p.bars), [8, 8, 16, 8, 16, 8]);
  // A section that snaps onto its neighbour's phrase merges into it.
  const blip = song({ bpm: 128, bars: 32, sections: [['A', 0, 8, -14], ['B', 8, 9, -9], ['C', 9, 24, -8], ['D', 24, 32, -15]] });
  assert.deepEqual(sectionPlan(referenceBrief(blip, { name: 'x', playbooks: [] }), 128).map((p) => [p.startBar, p.bars]), [[1, 8], [9, 16], [25, 8]]);
  // Fewer than 3 sections: no plan.
  assert.deepEqual(referenceBrief(song({ bpm: 128, bars: 16, sections: [['A', 0, 8, -10], ['B', 8, 16, -9]] }), { name: 'x', playbooks: PBS }).plan, []);
  // A 7-minute song caps at 256 bars.
  const long = song({ bpm: 174, bars: 300, sections: [['A', 0, 100, -12], ['B', 100, 200, -8], ['C', 200, 300, -12]] });
  const pl = sectionPlan(referenceBrief(long, { name: 'x', playbooks: [] }), 174);
  assert.equal(pl[pl.length - 1].startBar + pl[pl.length - 1].bars - 1, 256);
});

test('section kinds in each playbook\'s words: peaks are its drops / choruses, dips its breaks, the edges intro and outro', () => {
  const a = song({ bpm: 128, bars: 64, sections: EDM_SECTIONS });
  const plan = referenceBrief(a, { name: 'Song', genre: 'edm', playbooks: PBS }).plan;
  assert.deepEqual(planKinds(plan, playbookFor('edm')!), ['intro', 'build', 'drop', 'breakdown', 'drop', 'outro']);
  const pop = planKinds(plan, playbookFor('pop')!);
  assert.equal(pop[0], 'intro');
  assert.ok(['chorus', 'hook'].includes(pop[2]) && pop[2] === pop[4], pop.join());
  assert.equal(pop[5], 'outro');
  // A mastered EDM track (w6 end to end, "Night Drive"): a drum-heavy intro nearly as loud as the drops, loud 8-bar
  // builds before each drop, a breakdown without the kick: intro, breakdown, build, drop, breakdown, build, drop, outro.
  const P = (label: string, bars: number, energy: number) => ({ label, startBar: 0, bars, lufs: -7, energy });
  const night = [P('A', 16, 0.95), P('B', 16, 0.4), P('C', 8, 1), P('D', 16, 0.95), P('E', 16, 0.6), P('C', 8, 1), P('D', 16, 0.95), P('A', 16, 0.9)];
  assert.deepEqual(planKinds(night, playbookFor('edm')!), ['intro', 'breakdown', 'build', 'drop', 'breakdown', 'build', 'drop', 'outro']);
  // A pop song that opens on its chorus (the first section's material is a peak mid-song) keeps it a chorus.
  const cold = [P('A', 8, 1), P('B', 16, 0.75), P('A', 8, 1), P('B', 16, 0.75), P('A', 8, 1), P('C', 8, 0.5)];
  const ck = planKinds(cold, playbookFor('pop')!);
  assert.ok(['chorus', 'hook'].includes(ck[0]) && ck[0] === ck[2], ck.join());
  assert.equal(ck[5], 'outro');
});

// ── Harmony, brief text ─────────────────────────────────────────────────

test('chord loop: the most repeated 4-chord window as roman numerals; unclear chords give none', () => {
  const a = song({ bpm: 120, bars: 16, chords: [[9, 'min', 0], [5, 'maj', 0], [0, 'maj', 0], [7, 'maj', 0]] });
  const b = referenceBrief(a, { name: 'x', playbooks: [] });
  assert.deepEqual(b.harmony.loop, ['i', 'VI', 'III', 'VII']);
  assert.equal(b.harmony.changesPerBar, 1);
  assert.deepEqual(chordLoop([], 'Am', 4, 1), { loop: null, changesPerBar: null });
});

test('the brief: numbers, closest genres, sections, drum feel, loop and mix in plain text', () => {
  const hits = Array.from({ length: 256 }, (_, b) => [{ beat: b, role: 'kick' as const }, ...(b % 4 === 1 || b % 4 === 3 ? [{ beat: b, role: 'snare' as const }] : []), { beat: b + 0.5, role: 'hat' as const }]).flat();
  const a = song({ bpm: 128, bars: 64, sections: EDM_SECTIONS, hits, chords: [[9, 'min', 0], [5, 'maj', 0], [0, 'maj', 0], [7, 'maj', 0]] });
  const b = referenceBrief(a, { name: 'Night Drive', playbooks: PBS });
  assert.equal(b.genreSource, 'guessed');
  assert.ok(b.genre && ['house', 'tech-house', 'deep-house', 'techno', 'edm'].includes(b.genre), b.genre ?? 'none');
  assert.deepEqual([b.bpm, b.key, b.swingPercent, b.drums?.fourOnFloor, b.mix.lufs, b.mix.contrastLu], [128, 'Am', 0, true, -8, 8]);
  assert.deepEqual(b.mix.bandsVsMid, { sub: 7, low: 6, lowMid: 2, highMid: -4, high: -11 });
  const text = briefText(b);
  for (const s of ['REFERENCE — "Night Drive"', 'Tempo 128 bpm', 'key Am', 'Closest genres (estimated):', 'Form: A B C D C A', 'Sections (bars at 128 bpm', '17-32', 'four-on-the-floor kick', 'kick     9... 9... 9... 9...', 'Harmony: Am F C G (i VI III VII) loop', 'Mix: -8 LUFS']) assert.ok(text.includes(s), `${s}\n${text}`);
  // A genre the user named wins over the guess and lays the plan out in its words.
  const asked = referenceBrief(a, { name: 'Night Drive', genre: 'pop', playbooks: PBS });
  assert.deepEqual([asked.genre, asked.genreSource], ['pop', 'given']);
  assert.match(briefText(asked), /You asked for Pop: the plan below uses it/);
});

// ── The adapted playbook ────────────────────────────────────────────────

test('adaptPlaybook: the reference\'s tempo reading, key, swing, section plan, loudness and contrast; the playbook\'s parts', () => {
  const edm = playbookFor('edm')!;
  const a = song({ bpm: 126, bars: 64, sections: EDM_SECTIONS, lufs: -6.2, swing: 0.2 });
  const b = referenceBrief(a, { name: 'Song', genre: 'edm', playbooks: PBS });
  const x = adaptPlaybook(edm, b);
  assert.equal(x.arrangement, 'sections');
  assert.deepEqual([x.bpm, x.key, x.swing], [126, 'Am', 20]);
  assert.match(x.bpmWhy, /the reference: detected 126/);
  const arr = x.playbook.arrangement;
  assert.deepEqual(arr.map((s) => [s.label, s.kind, s.bars, s.energy]), [
    ['Intro', 'intro', 8, 0.2],
    ['Build', 'build', 8, 0.6],
    ['Drop', 'drop', 16, 1],
    ['Breakdown', 'breakdown', 8, 0.3],
    ['Drop 2', 'drop', 16, 1],
    ['Outro', 'outro', 8, 0.4],
  ]);
  const drop = edm.arrangement.find((s) => s.kind === 'drop')!;
  assert.deepEqual(arr[2].parts, drop.parts, 'a drop takes the playbook drop\'s parts');
  assert.ok(arr[2].transitionIn?.length, 'transitions into the drop');
  assert.equal(arr[0].transitionIn, undefined);
  assert.equal(x.playbook.targets.lufs, -7, 'clamped to -7');
  assert.deepEqual(x.playbook.targets.bars, [54, 74]);
  assert.deepEqual(x.playbook.targets.contrastLu, [5, 12]);
  assert.equal(x.playbook.keys.common[0], 'Am');
  assert.equal(x.playbook.bpm.typical, 126);
  // The same song for a genre whose tempo no reading fits: that genre's tempo, the sections keep their durations.
  const dnb = playbookFor('dnb')!;
  const y = adaptPlaybook(dnb, referenceBrief(a, { name: 'Song', genre: 'dnb', playbooks: PBS }));
  assert.equal(y.bpm, readingFor(dnb, 126).inRange ? readingFor(dnb, 126).bpm : dnb.bpm.typical);
  if (!readingFor(dnb, 126).inRange) {
    assert.match(y.bpmWhy, /outside/);
    assert.equal(y.swing, dnb.swing, 'no swing from another tempo');
  }
  // Two sections: the playbook's arrangement scaled to the reference's length; an unsure key stays the playbook's.
  const short = song({ bpm: 128, bars: 96, sections: [['A', 0, 48, -10], ['B', 48, 96, -9]] });
  const sb = referenceBrief(short, { name: 's', genre: 'edm', playbooks: PBS });
  sb.keyConfidence = 0.2;
  const z = adaptPlaybook(edm, sb);
  assert.equal(z.arrangement, 'length');
  const total = z.playbook.arrangement.reduce((s, x) => s + x.bars, 0);
  assert.ok(Math.abs(total - 96) <= 12, `${total} bars for a 96-bar song`);
  assert.equal(z.key, null);
  assert.deepEqual(z.playbook.keys, edm.keys);
});

// ── get_playbook's recipe with a reference ──────────────────────────────

test('recipe: the reference wins over the playbook and the focus, the user\'s words win over the reference', () => {
  const edm = playbookFor('edm')!;
  const hits = Array.from({ length: 256 }, (_, b) => [{ beat: b, role: 'kick' as const }, { beat: b + 0.5, role: 'hat' as const }]).flat();
  const a = song({ bpm: 126, bars: 64, sections: EDM_SECTIONS, hits, chords: [[9, 'min', 0], [5, 'maj', 0], [0, 'maj', 0], [7, 'maj', 0]] });
  const brief = referenceBrief(a, { name: 'Night Drive', genre: 'edm', playbooks: PBS });
  const adapted = adaptPlaybook(edm, brief);
  const ctx = { genre: 'edm' as GenreId, source: 'reference' as const, presets: FACTORY_PRESETS, samples: null, picker: plainPicker(FACTORY_PRESETS, null), channels: [], projectBpm: 140, projectSwing: 0, reference: { brief, adapted, track: 'Reference: Night Drive' } };
  const r = buildRecipe(adapted.playbook, ctx);
  assert.deepEqual([r.bpm, r.key, r.totalBars, r.sections.length], [126, 'Am', 64, 6]);
  assert.deepEqual(r.reference, { name: 'Night Drive', track: 'Reference: Night Drive', arrangement: 'sections' });
  for (const s of ['REFERENCE SONG "Night Drive" (the muted track "Reference: Night Drive")', 'the ARRANGEMENT below is ITS section plan', 'four-on-the-floor kick', 'Its chord loop: Am F C G (i VI III VII)', 'ORIGINAL ONLY', 'check_originality: rewrite any line', '"label":"Like Night Drive"', 'set_tempo {"bpm":126}', '17-32    Drop'])
    assert.ok(r.text.includes(s), `${s}\n${r.text.slice(0, 3000)}`);
  assert.ok(r.text.indexOf('check_originality') < r.text.indexOf('review_song {'));
  const words = buildRecipe(adapted.playbook, { ...ctx, brief: 'at 132 bpm in F#m' });
  assert.deepEqual([words.bpm, words.key], [132, 'F#m']);
  const focus = { name: 'Mine', analysed: 12, bpm: 100, bpmRange: [95, 105] as [number, number], swingPercent: 40, keys: ['Cm'], progressions: [], sectionBars: 8, forms: [], lufs: -12 };
  const both = buildRecipe(adapted.playbook, { ...ctx, focus });
  assert.deepEqual([both.bpm, both.key, both.targets.lufs], [126, 'Am', -8]);
  assert.doesNotMatch(both.text, /YOUR REFERENCES SAY/);
});

// ── Real-song lessons (w6 end to end) ───────────────────────────────────

test('kick-aware energy: a mastered breakdown nearly as loud as the drop still reads as a dip when its kick drops out', () => {
  const secs: Array<[string, number, number, number]> = [['A', 0, 8, -9], ['B', 8, 24, -8], ['C', 24, 40, -8.4], ['B', 40, 56, -8], ['D', 56, 64, -10]];
  const kicked = new Set([1, 3]);
  const hits = Array.from({ length: 64 * 4 }, (_, b) => {
    const s = secs.findIndex(([, a, e]) => b >= a * 4 && b < e * 4);
    return [...(kicked.has(s) ? [{ beat: b, role: 'kick' as const }] : []), { beat: b + 0.5, role: 'hat' as const }];
  }).flat();
  const loudOnly = referenceBrief(song({ bpm: 128, bars: 64, sections: secs }), { name: 'x', genre: 'edm', playbooks: PBS });
  const withKicks = referenceBrief(song({ bpm: 128, bars: 64, sections: secs, hits }), { name: 'x', genre: 'edm', playbooks: PBS });
  assert.deepEqual(loudOnly.plan.map((p) => p.energy), [0.9, 1, 0.95, 1, 0.8]);
  assert.deepEqual(withKicks.plan.map((p) => p.energy), [0.55, 1, 0.6, 1, 0.5]);
  assert.equal(loudOnly.kinds[2], 'drop', 'by loudness alone the breakdown looks like a drop');
  assert.deepEqual(withKicks.kinds, ['intro', 'drop', 'breakdown', 'drop', 'outro']);
  assert.deepEqual(withKicks.sections.map((s) => s.kickRate), [0, 4, 0, 4, 0]);
  // A song with no kick at all keeps the loudness reading.
  const noKick = referenceBrief(song({ bpm: 128, bars: 64, sections: secs, hits: hits.filter((h) => h.role === 'hat') }), { name: 'x', genre: 'edm', playbooks: PBS });
  assert.deepEqual(noKick.plan.map((p) => p.energy), loudOnly.plan.map((p) => p.energy));
});

test('key from the chords: a tuned kick pulls the pitch profile to G, the Am F C G loop says Am (or C)', () => {
  const am: Array<{ root: number; quality: 'maj' | 'min' }> = [{ root: 9, quality: 'min' }, { root: 5, quality: 'maj' }, { root: 0, quality: 'maj' }, { root: 7, quality: 'maj' }];
  assert.deepEqual(chordKeys(am, 'G'), ['Am', 'C']);
  assert.deepEqual(chordKeys(am, 'Am'), [], 'the detected key holds the loop');
  assert.deepEqual(chordKeys(am, 'C'), []);
  assert.deepEqual(chordKeys(am.slice(0, 2).concat(am.slice(0, 2)), 'G'), [], 'two chords say too little');
  assert.deepEqual([diatonic(4, 'maj', 9, true), diatonic(4, 'min', 9, true), diatonic(11, 'dim', 0, false), diatonic(2, 'sus', 7, false)], [false, true, true, true]);
  assert.deepEqual(loopNumerals(am, 'Am'), { numerals: ['i', 'VI', 'III', 'VII'], chords: ['Am', 'F', 'C', 'G'] });
  assert.deepEqual(loopNumerals([am[2], am[3], am[0], am[1]], 'C')?.chords, ['C', 'G', 'Am', 'F']);
  const a = song({ bpm: 128, bars: 64, sections: EDM_SECTIONS, key: 'G', chords: [[9, 'min', 0], [5, 'maj', 0], [0, 'maj', 0], [7, 'maj', 0]] });
  const b = referenceBrief(a, { name: 'Night Drive', genre: 'edm', playbooks: PBS });
  assert.deepEqual([b.key, b.keyAlternatives, b.keyFromChords, b.harmony.loopChords?.join(' ')], ['G', ['Am', 'C'], 'Am', 'Am F C G']);
  assert.match(briefText(b), /key Am \(from its chords: the pitch profile read G, but the chord loop sits in Am \/ C\)/);
  assert.equal(adaptPlaybook(playbookFor('edm')!, b).key, 'Am', 'EDM prefers minor');
  const major = playbookFor('pop')!;
  assert.equal(adaptPlaybook(major, b).key, prefersMinor(major) ? 'Am' : 'C');
  assert.equal(pickKey(['Am', 'C'], false), 'C');
  assert.equal(pickKey([], true), null);
});

test('a close call is said out loud, within a family or across them', () => {
  const g = (id: GenreId, score: number) => ({ id, score, bpm: 140, why: [] });
  assert.deepEqual(closeCall({ genres: [g('phonk', 0.76), g('trap', 0.75), g('drill', 0.74)] }), { close: true, family: true });
  assert.deepEqual(closeCall({ genres: [g('phonk', 0.76), g('future-bass', 0.75)] }), { close: true, family: false });
  assert.deepEqual(closeCall({ genres: [g('edm', 0.91), g('techno', 0.8)] }), { close: false, family: false });
  const hits = Array.from({ length: 64 }, (_, b) => [{ beat: b, role: 'kick' as const }, { beat: b + 0.5, role: 'hat' as const }]).flat();
  const b = referenceBrief(song({ bpm: 128, bars: 16, hits }), { name: 'x', playbooks: PBS });
  b.genres = [g('house', 0.8), g('tech-house', 0.79), g('deep-house', 0.78)];
  assert.match(briefText(b), /A close call within one family \(House and its neighbours\)/);
});

run('reference brief');
