// Auto Mashup planner (shared/mashup/plan.ts): grid maths, sections on
// 4-bar phrases, the key decision (same / relative / Camelot ±1 / tritone,
// who moves per anchor), tempo readings (half / double, least stretch),
// role choice for vocalFrom 'auto', the structure for each style, problems,
// score / reasons / suggestions and determinism.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import {
  bestKeyMove,
  camelot,
  decideKey,
  decideTempo,
  fifthsDistance,
  planMashup,
  secToSongBar,
  songBarToSec,
  songSections,
  type SongInput,
  type SongGrid,
} from '@shared/mashup/plan';
import type { MashupRequest } from '@shared/mashup/types';
import { toKeyRef } from '@shared/music/keymatch';

/** [label, bars, lufs, vocal activity (undefined = not measured)] */
type Sec = [string, number, number, number?];

function grid(bpm: number, bars: number, t0 = 0.5): SongGrid {
  const p = 60 / bpm;
  const beats = Array.from({ length: bars * 4 + 4 }, (_, i) => t0 + i * p);
  return { beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatsPerBar: 4 };
}

function song(o: { name?: string; bpm: number | null; key?: string | null; keyConf?: number; vp?: number; vocalSource?: SongInput['vocalSource']; kind?: SongInput['kind']; stems?: SongInput['stems']; canSeparate?: boolean; secs?: Sec[]; problem?: string }): SongInput {
  const secs = o.secs ?? [['A', 8, -14], ['B', 16, -10], ['C', 16, -7], ['B', 16, -10], ['C', 16, -7], ['A', 8, -15]];
  const bars = secs.reduce((n, s) => n + s[1], 0);
  const bpm = o.bpm ?? 120;
  const g = o.bpm ? grid(bpm, bars) : null;
  const barSec = (4 * 60) / bpm;
  let bar = 0;
  const sections = secs.map(([label, n, lufs, vocal]) => {
    const s = { startSec: bar === 0 ? 0 : 0.5 + bar * barSec, endSec: 0.5 + (bar + n) * barSec, label, lufs, vocal: vocal ?? null };
    bar += n;
    return s;
  });
  return {
    name: o.name ?? 'Song',
    durationSec: 0.5 + bars * barSec + 0.2,
    bpm: o.bpm,
    bpmAlternatives: o.bpm ? [o.bpm / 2, o.bpm * 2] : [],
    key: o.key === undefined ? 'Am' : o.key,
    keyConfidence: o.keyConf ?? 0.8,
    vocalPresence: o.vp ?? 0.8,
    vocalSource: o.vocalSource ?? 'stems',
    kind: o.kind ?? 'song',
    stems: o.stems ?? ['vocals', 'drums', 'bass', 'other'],
    canSeparate: o.canSeparate ?? true,
    grid: g,
    sections,
    ...(o.problem ? { problem: o.problem } : {}),
  };
}

const req = (r: Partial<MashupRequest> = {}): MashupRequest => ({ a: { path: 'C:\\a.wav' }, b: { path: 'C:\\b.wav' }, style: 'vocalOverBeat', ...r });
const K = (s: string) => toKeyRef(s)!;
const VOCAL_SONG: Sec[] = [['I', 8, -16, 0], ['V', 16, -11, 1], ['H', 8, -7, 1], ['V', 16, -11, 1], ['H', 8, -7, 1], ['O', 8, -16, 0]];
const BED_SONG: Sec[] = [['A', 8, -15, 0], ['B', 16, -10, 0], ['C', 16, -6, 0], ['D', 8, -14, 0], ['C', 16, -6, 0], ['A', 8, -15, 0]];

// ── Grid ────────────────────────────────────────────────────────────────

test('grid: song bars ↔ seconds through the beats, for each tempo reading', () => {
  const g = grid(120, 32);
  assert.equal(songBarToSec(g, 120, 1, 0), 0.5);
  assert.equal(songBarToSec(g, 120, 1, 2), 0.5 + 4);
  assert.equal(songBarToSec(g, 120, 2, 2), 0.5 + 2, 'double time: a bar is 2 tracked beats');
  assert.equal(songBarToSec(g, 120, 0.5, 1), 0.5 + 4, 'half time: a bar is 8 tracked beats');
  for (const f of [1, 0.5, 2] as const) for (const bar of [0, 3, 7.5, 40]) assert.ok(Math.abs(secToSongBar(g, 120, f, songBarToSec(g, 120, f, bar)) - bar) < 1e-9, `round trip ${f} ${bar}`);
  assert.ok(Math.abs(songBarToSec(g, 120, 1, -1) - (0.5 - 2)) < 1e-9, 'extrapolates before the first beat');
  assert.equal(songBarToSec(null, 100, 1, 1), 2.4, 'no beats: the tempo alone');
});

test('sections: snapped to 4-bar phrases from the first downbeat, energy 0..1, measured vocal flags, names', () => {
  const s = song({ bpm: 120, secs: [['A', 8, -16, 0], ['B', 15, -11, 1], ['C', 17, -6, 1], ['A', 8, -16, 0]] });
  const secs = songSections(s, 1);
  assert.deepEqual(secs.map((x) => [x.startBar, x.bars]), [[0, 8], [8, 16], [24, 16], [40, 8]], '15 / 17 bars snap onto the 4-bar grid');
  assert.deepEqual(secs.map((x) => x.vocal), [false, true, true, false]);
  assert.deepEqual(secs.map((x) => x.name), ['Intro', 'Verse', 'Chorus', 'Outro']);
  assert.equal(secs[2].energy, 1);
  assert.ok(secs[0].energy < secs[1].energy && secs[1].energy < secs[2].energy);
  // Unmeasured: a song with vocals sings everywhere but a quiet intro / outro; an instrumental never.
  const um = songSections(song({ bpm: 120, vp: 0.8, vocalSource: 'name', secs: [['A', 8, -16], ['B', 16, -8], ['A', 8, -16]] }), 1);
  assert.deepEqual(um.map((x) => x.vocal), [false, true, false]);
  assert.ok(songSections(song({ bpm: 120, kind: 'instrumental', secs: BED_SONG }), 1).every((x) => !x.vocal));
  assert.deepEqual(songSections(song({ bpm: 120, kind: 'instrumental', secs: BED_SONG }), 1).map((x) => x.name), ['Intro', 'Build', 'Drop 1', 'Break', 'Drop 2', 'Outro']);
});

// ── Key ─────────────────────────────────────────────────────────────────

test('key helpers: circle-of-fifths distance, Camelot codes, the best move', () => {
  assert.equal(fifthsDistance(K('C'), K('G')), 1);
  assert.equal(fifthsDistance(K('Am'), K('C')), 0);
  assert.equal(fifthsDistance(K('C'), K('F#')), 6);
  assert.equal(fifthsDistance(K('C'), K('D')), 2);
  assert.deepEqual([camelot(K('C')), camelot(K('Am')), camelot(K('G')), camelot(K('Em')), camelot(K('F'))], ['8B', '8A', '9B', '9A', '7B']);
  assert.deepEqual(bestKeyMove(K('Gm'), K('Am'), true), { semitones: 2, leftover: 0, cost: 4 });
  assert.equal(bestKeyMove(K('C'), K('G'), true).semitones, 0, 'a Camelot neighbour stays put (small cost) instead of moving 5 st');
  const tri = bestKeyMove(K('C'), K('F#'), true);
  assert.deepEqual([tri.semitones, tri.leftover], [-1, 1], 'a tritone moves 1 st down onto a Camelot neighbour, not 6 st');
});

test('key decision: same / relative / Camelot neighbour / move, and who moves for each anchor', () => {
  const pair = (vk: string, bk: string) => ({ a: song({ bpm: 120, key: vk }), b: song({ bpm: 120, key: bk }) });
  const same = decideKey(pair('Am', 'Am'), 'b', 'beat', { moverIsVocal: true });
  assert.deepEqual([same.a, same.b, same.key], [0, 0, 'Am']);
  assert.match(same.reason, /both in A minor: no pitch change/);
  const rel = decideKey(pair('Am', 'C'), 'b', 'beat', { moverIsVocal: true });
  assert.deepEqual([rel.a, rel.b, rel.penalty], [0, 0, 0]);
  assert.match(rel.reason, /A minor and C major share their notes/);
  const cam = decideKey(pair('C', 'G'), 'b', 'beat', { moverIsVocal: true });
  assert.deepEqual([cam.a, cam.b], [0, 0]);
  assert.match(cam.reason, /Camelot neighbours/);
  const move = decideKey(pair('Gm', 'Am'), 'b', 'beat', { moverIsVocal: true });
  assert.deepEqual([move.a, move.b, move.key, move.vocalKey], [2, 0, 'Am', 'Am']);
  assert.match(move.reason, /A moves \+2 st \(G minor → A minor\)/);
  const keepVocal = decideKey(pair('Gm', 'Am'), 'b', 'vocal', { moverIsVocal: true });
  assert.deepEqual([keepVocal.a, keepVocal.b, keepVocal.key], [0, -2, 'Gm'], 'anchor vocal: the beat moves');
  const mid = decideKey(pair('Em', 'Gm'), 'b', 'middle', { moverIsVocal: true });
  assert.deepEqual([mid.a, mid.b], [2, -1], '+3 st split: the vocal +2, the beat −1');
  assert.equal(mid.vocalKey, 'F#m');
  const given = decideKey(pair('Gm', 'Am'), 'b', 'beat', { key: 'Bm', moverIsVocal: true });
  assert.deepEqual([given.a, given.b, given.key], [4, 2, 'Bm']);
  const none = decideKey({ a: song({ bpm: 120, key: null }), b: song({ bpm: 120, key: 'C' }) }, 'b', 'beat', { moverIsVocal: true });
  assert.deepEqual([none.a, none.b], [0, 0]);
  assert.match(none.reason, /A has no clear key/);
  const weak = decideKey({ a: song({ bpm: 120, key: 'Am', keyConf: 0.2 }), b: song({ bpm: 120, key: 'C' }) }, 'b', 'beat', { moverIsVocal: true });
  assert.equal(weak.weak, true);
});

// ── Tempo ───────────────────────────────────────────────────────────────

test('tempo: half / double readings stretch least; the anchor keeps its tempo; middle meets half way', () => {
  const v70 = song({ bpm: 70 });
  const b140 = song({ bpm: 140 });
  const t = decideTempo(v70, b140, 'b');
  assert.deepEqual([t.bpm, t.a.factor, t.a.srcBpm, t.a.speed, t.b.speed], [140, 2, 140, 1, 1], '70 bpm read as double time');
  const t2 = decideTempo(song({ bpm: 140 }), song({ bpm: 70 }), 'b');
  assert.deepEqual([t2.bpm, t2.a.factor, t2.a.speed], [70, 0.5, 1], '140 over a 70 bed reads half time');
  const t3 = decideTempo(song({ bpm: 96 }), song({ bpm: 140 }), 'b');
  assert.equal(t3.a.factor, 2);
  assert.ok(Math.abs(t3.a.speed - 140 / 192) < 1e-9);
  const keepVocal = decideTempo(song({ bpm: 120 }), song({ bpm: 128 }), 'a');
  assert.deepEqual([keepVocal.bpm, keepVocal.a.speed], [120, 1]);
  const mid = decideTempo(song({ bpm: 120 }), song({ bpm: 130 }), null);
  assert.equal(mid.bpm, 125, 'the geometric mean, snapped');
  assert.ok(mid.a.speed > 1 && mid.b.speed < 1);
  const forced = decideTempo(song({ bpm: 70 }), song({ bpm: 140 }), 'b', { factorA: 1 });
  assert.deepEqual([forced.a.factor, forced.a.speed], [1, 2]);
  const fixedBpm = decideTempo(song({ bpm: 70 }), song({ bpm: 128 }), 'b', { bpm: 135 });
  assert.deepEqual([fixedBpm.bpm, fixedBpm.a.factor, fixedBpm.b.factor], [135, 2, 1]);
  const noTempo = decideTempo(song({ bpm: null }), song({ bpm: 128 }), 'b');
  assert.deepEqual([noTempo.bpm, noTempo.a.srcBpm, noTempo.a.speed], [128, null, 1]);
});

// ── Roles ───────────────────────────────────────────────────────────────

test('roles: auto picks the song with the vocal over the instrumental, either way round; the other way loses without stems', () => {
  const vocal = song({ name: 'Vocal Song', bpm: 120, vp: 0.9, secs: VOCAL_SONG });
  const inst = song({ name: 'Beat', bpm: 120, vp: 0.05, kind: 'instrumental', secs: BED_SONG });
  assert.equal(planMashup(req(), vocal, inst).build.vocalFrom, 'a');
  assert.equal(planMashup(req(), inst, vocal).build.vocalFrom, 'b');
  // Neither measured: a tie goes to A; a key / tempo cost decides otherwise.
  const u1 = song({ bpm: 120, vp: 0.5, vocalSource: 'unknown' });
  const u2 = song({ bpm: 120, vp: 0.5, vocalSource: 'unknown' });
  assert.equal(planMashup(req(), u1, u2).build.vocalFrom, 'a');
  // A can't give a vocal (no stems, no model, a full song): B's vocal on A.
  const stuck = song({ bpm: 120, vp: 0.9, stems: [], canSeparate: false });
  const acap = song({ bpm: 120, vp: 0.95, kind: 'acapella', stems: [], canSeparate: false });
  assert.equal(planMashup(req(), stuck, acap).build.vocalFrom, 'b');
  // An explicit vocalFrom is kept, with a suggestion when the other way fits much better.
  const forced = planMashup(req({ vocalFrom: 'b' }), vocal, inst);
  assert.equal(forced.build.vocalFrom, 'b');
  assert.ok(forced.check.suggestions.some((s) => /Take the vocal from A instead/.test(s)), forced.check.suggestions.join(' | '));
});

// ── Structure ───────────────────────────────────────────────────────────

test('vocalOverBeat: the hook over the bed\'s drops, verses over the build, an instrumental intro / break / outro, on 4-bar phrases', () => {
  const r = planMashup(req({ vocalFrom: 'a' }), song({ name: 'Vocal Song', bpm: 120, key: 'Gm', secs: VOCAL_SONG }), song({ name: 'Beat', bpm: 120, key: 'Am', vp: 0.6, secs: BED_SONG }));
  const p = r.check.plan;
  assert.deepEqual(p.sections.map((s) => [s.name, s.startBar, s.bars]), [['Intro', 1, 8], ['Verse', 9, 16], ['Chorus 1', 25, 16], ['Break', 41, 8], ['Chorus 2', 49, 16], ['Outro', 65, 8]]);
  assert.equal(p.bars, 72);
  assert.ok(p.sections.every((s) => (s.startBar - 1) % 4 === 0 && s.bars % 4 === 0));
  assert.match(p.sections[2].uses, /Beat instrumental \+ Vocal Song vocal \(Chorus/);
  assert.equal(p.sections[0].uses, 'Beat instrumental');
  const t = r.build.tracks;
  assert.deepEqual(t.map((x) => [x.role, x.part, x.warp, x.semitones, x.formant]), [['vocal', 'vocals', 'tones', 2, true], ['drums', 'drums', 'beats', 0, false], ['bass', 'bass', 'complex', 0, false], ['other', 'other', 'complex', 0, false]]);
  const vocal = t[0];
  // The hook (8 bars at song bar 24) fills each 16-bar chorus twice; the verse plays the first verse in order.
  const hookAt = (start: number) => vocal.clips.filter((c) => c.startBar >= start && c.startBar < start + 16).map((c) => [c.startBar, c.bars, c.songBar]);
  assert.deepEqual(hookAt(25), [[25, 8, 24], [33, 8, 24]]);
  assert.deepEqual(hookAt(9), [[9, 16, 8]]);
  assert.ok(!vocal.clips.some((c) => c.startBar < 9 || (c.startBar >= 41 && c.startBar < 49) || c.startBar >= 65), 'no vocal in the intro, the break or the outro');
  // The bed plays in its own order: mashup bar n = bed bar n−1.
  assert.ok(t[1].clips.every((c) => c.songBar === c.startBar - 1));
  assert.equal(r.build.tune, 'off', 'Krypt Tune only when asked: a finished vocal is in tune');
  assert.equal(r.build.tuneKey, 'Am');
  assert.deepEqual(r.build.transitions.map((x) => [x.bar, x.kind]), [[9, 'crash'], [25, 'riser'], [41, 'downlifter'], [49, 'riser'], [65, 'downlifter']]);
  assert.deepEqual(r.check.problems, []);
  assert.deepEqual(r.build.songs.a.needStems, ['vocals']);
  assert.deepEqual(r.build.songs.b.needStems, ['drums', 'bass', 'other']);
});

test('vocalOverBeat: target bars cut the bed on a phrase; an a cappella and an instrumental need no stems', () => {
  const r = planMashup(req({ vocalFrom: 'a', bars: 40 }), song({ bpm: 120, kind: 'acapella', stems: [], canSeparate: false, secs: VOCAL_SONG }), song({ bpm: 120, kind: 'instrumental', vp: 0, stems: [], canSeparate: false, secs: BED_SONG }));
  assert.equal(r.check.plan.bars, 40);
  assert.deepEqual(r.check.problems, []);
  assert.deepEqual(r.build.tracks.map((t) => [t.role, t.part]), [['vocal', 'mix'], ['mix', 'mix']]);
  assert.equal(r.check.plan.sections[r.check.plan.sections.length - 1].name, 'Outro');
  const long = planMashup(req({ vocalFrom: 'a', bars: 400 }), song({ bpm: 120, secs: VOCAL_SONG }), song({ bpm: 120, secs: BED_SONG }));
  assert.equal(long.check.plan.bars, 72, 'never longer than the bed');
  assert.ok(long.build.notes.some((n) => /only 72 bars long/.test(n)));
});

test('backAndForth: A intro, then B and A trade 8 / 16-bar sections (best energy first) with crossfades and a transition at every switch', () => {
  const r = planMashup(req({ style: 'backAndForth', bars: 64 }), song({ name: 'Alpha', bpm: 124, key: 'Am', stems: [], canSeparate: false, secs: BED_SONG }), song({ name: 'Beta', bpm: 126, key: 'C', stems: [], canSeparate: false, secs: VOCAL_SONG }));
  const p = r.check.plan;
  assert.deepEqual(r.check.problems, [], 'no stems needed');
  assert.equal(p.vocalFrom, null);
  assert.equal(p.sections[0].name, 'Intro');
  assert.equal(p.sections[p.sections.length - 1].name, 'Outro');
  assert.ok(p.bars <= 64);
  const sides = r.build.sections.slice(1, -1).map((s) => s.name[0]);
  for (let i = 1; i < sides.length; i++) assert.notEqual(sides[i], sides[i - 1], `alternates: ${sides.join('')}`);
  assert.equal(sides[0], 'B');
  assert.match(r.build.sections[1].name, /^B · (Chorus|H)/, 'B starts with its best-energy section');
  assert.ok(r.build.sections.every((s) => [4, 8, 16].includes(s.bars)));
  assert.equal(r.build.transitions.length, p.sections.length - 1);
  const mixA = r.build.tracks.find((t) => t.song === 'a')!;
  assert.equal(mixA.part, 'mix');
  assert.ok(mixA.clips.some((c) => c.fadeOut === 1), 'crossfades at the switches');
  assert.deepEqual([r.check.plan.shiftA.semitones, r.check.plan.shiftB.semitones], [0, 0], 'Am / C: relative keys');
  assert.equal(r.check.plan.bpm, 124, 'anchor beat = A in backAndForth');
});

test('stemBlend: picked stems from both songs; the other song\'s drums follow the energy of the structure', () => {
  const r = planMashup(req({ style: 'stemBlend', stems: { vocals: 'a', drums: 'b', bass: 'b', other: 'a' } }), song({ name: 'A', bpm: 120, secs: VOCAL_SONG }), song({ name: 'B', bpm: 120, secs: BED_SONG }));
  assert.deepEqual(r.build.tracks.map((t) => [t.song, t.part]), [['a', 'vocals'], ['b', 'drums'], ['b', 'bass'], ['a', 'other']]);
  const other = r.build.tracks[3];
  const chorus = r.build.sections.find((s) => /Chorus 1/.test(s.name))!;
  const inChorus = other.clips.filter((c) => c.startBar >= chorus.startBar && c.startBar < chorus.startBar + chorus.bars);
  assert.ok(inChorus.length && inChorus.every((c) => c.songBar === 24 || c.songBar === 56), `A's loudest section under B's drop: ${JSON.stringify(inChorus)}`);
  assert.deepEqual(r.build.songs.a.needStems, ['vocals', 'other']);
  assert.match(chorus.uses, /\+ A other/);
  const none = planMashup(req({ style: 'stemBlend', stems: { vocals: null, drums: null, bass: null, other: null } }), song({ bpm: 120 }), song({ bpm: 120 }));
  assert.ok(none.check.problems.some((x) => /at least one stem/.test(x)));
});

// ── Problems, score, suggestions, determinism ──────────────────────────

test('problems: stems needed without a stem model name the Model Manager; unreadable songs are listed', () => {
  const r = planMashup(req({ vocalFrom: 'a' }), song({ name: 'Hit', bpm: 120, stems: [], canSeparate: false }), song({ name: 'Other hit', bpm: 120, stems: [], canSeparate: false }));
  assert.equal(r.check.problems.length, 2);
  assert.match(r.check.problems[0], /A \("Hit"\) needs its vocals stem, and no stem model is installed\. Install HT-Demucs in Home ▸ Model Manager/);
  assert.match(r.check.problems[1], /drums \/ bass \/ other stems/);
  assert.ok(r.check.suggestions.some((s) => /backAndForth/.test(s)));
  const bad = planMashup(req(), song({ bpm: 120, problem: 'File not found: C:\\x.wav' }), song({ bpm: 120 }));
  assert.match(bad.check.problems[0], /^A \("Song"\): File not found/);
});

test('score + reasons: a perfect fit scores high; a big stretch and a far key score lower, with a "middle" suggestion', () => {
  const good = planMashup(req({ vocalFrom: 'a' }), song({ bpm: 128, key: 'Am', secs: VOCAL_SONG }), song({ bpm: 128, key: 'C', secs: BED_SONG }));
  assert.ok(good.check.score >= 95, String(good.check.score));
  assert.equal(good.check.reasons.length, 5);
  assert.match(good.check.reasons[3], /^Bed: B's own vocal is left out/);
  assert.match(good.check.reasons[0], /^Tempo: 128 bpm/);
  assert.match(good.check.reasons[1], /share their notes/);
  assert.match(good.check.reasons[2], /^Vocal: A has a clear lead vocal \(from its vocal stem\)/);
  assert.match(good.check.reasons[4], /^Structure:/);
  // No anchor: 100 → 128 bpm would play the vocal ×1.28, so both meet half way (×1.13 / ×0.88, clean).
  const half = planMashup(req({ vocalFrom: 'a' }), song({ bpm: 100, key: 'Bbm', secs: VOCAL_SONG }), song({ bpm: 128, key: 'Em', secs: BED_SONG }));
  assert.equal(half.check.plan.bpm, 113);
  assert.match(half.check.reasons[0], /Met half way: keeping B's tempo would stretch the other song further\./);
  assert.ok(!half.build.notes.some((n) => /outside ×0\.85/.test(n)), half.build.notes.join(' | '));
  assert.ok(half.check.score < good.check.score, `${half.check.score} vs ${good.check.score}`);
  // Anchor "beat" asked: the beat keeps its tempo, the stretch is audible and "middle" is suggested.
  const bad = planMashup(req({ vocalFrom: 'a', anchor: 'beat' }), song({ bpm: 100, key: 'Bbm', secs: VOCAL_SONG }), song({ bpm: 128, key: 'Em', secs: BED_SONG }));
  assert.equal(bad.check.plan.bpm, 128);
  assert.ok(bad.check.score < good.check.score - 20, `${bad.check.score} vs ${good.check.score}`);
  assert.match(bad.check.reasons[0], /an audible stretch/);
  assert.ok(bad.build.notes.some((n) => /outside ×0\.85–×1\.18/.test(n)));
  assert.ok(bad.check.suggestions.some((s) => /^Anchor "middle": each song stretches at most/.test(s)), bad.check.suggestions.join(' | '));
  const forced = planMashup(req({ vocalFrom: 'a', factorA: 1, anchor: 'beat' }), song({ bpm: 70, secs: VOCAL_SONG }), song({ bpm: 140, secs: BED_SONG }));
  assert.ok(forced.check.suggestions.some((s) => s === 'Use A at double time: it plays ×1 instead of ×2.'), forced.check.suggestions.join(' | '));
  assert.equal(forced.check.plan.shiftA.stretch, 0.5, 'stretch = output ÷ input duration');
  // C over E: the vocal moves −1 st onto B major, a Camelot neighbour of E, rather than +4 st.
  const near = planMashup(req({ vocalFrom: 'a' }), song({ bpm: 128, key: 'C', secs: VOCAL_SONG }), song({ bpm: 128, key: 'E', secs: BED_SONG }));
  assert.equal(near.check.plan.shiftA.semitones, -1);
  assert.match(near.check.reasons[1], /A moves −1 st \(C major → B major\) next to B's E major \(Camelot neighbours\)/);
  const far = planMashup(req({ vocalFrom: 'a', key: 'E' }), song({ bpm: 128, key: 'C', secs: VOCAL_SONG }), song({ bpm: 128, key: 'E', secs: BED_SONG }));
  assert.equal(far.check.plan.shiftA.semitones, 4);
  assert.ok(far.build.notes.some((n) => /A's vocal is pitched \+4 st: listen for artefacts/.test(n)));
});

test('readings: 1-based sections, tempo alternatives, the source path; determinism (same input, same plan)', () => {
  const a = { ...song({ name: 'A', bpm: 120, secs: VOCAL_SONG }), path: 'C:\\Music\\a.wav' };
  const b = song({ name: 'B', bpm: 90, key: 'F#m', secs: BED_SONG });
  const r1 = planMashup(req(), a, b);
  const r2 = planMashup(req(), structuredClone(a), structuredClone(b));
  assert.deepEqual(r1, r2);
  assert.equal(r1.check.a.path, 'C:\\Music\\a.wav');
  assert.equal(r1.check.b.path, undefined);
  assert.equal(r1.check.a.sections[0].startBar, 1);
  assert.deepEqual(r1.check.b.bpmAlternatives, [45, 180]);
  // Section order in the input doesn't matter.
  const shuffled = { ...b, sections: [...b.sections].reverse() };
  assert.deepEqual(planMashup(req(), a, shuffled).check.plan, r1.check.plan);
});

// ── Measured harmony, levels ─────────────────────────────────────────────

/** A pitch profile: the scale of `tonic` (major / minor) with the tonic and fifth strongest. */
function profileOf(tonic: number, minor: boolean): number[] {
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const p = new Array<number>(12).fill(0.01);
  for (const s of steps) p[(tonic + s) % 12] = 0.1;
  p[tonic % 12] = 0.2;
  p[(tonic + 7) % 12] = 0.15;
  const t = p.reduce((x, y) => x + y, 0);
  return p.map((v) => v / t);
}

test("key by the stems: the vocal stem's notes against the instrumental's decide the shift, not the songs' key labels", () => {
  // A's mix reads G#m, but its vocal sings in Db; B's beat plays E major. Labels say "Camelot neighbours, no shift": the notes say +3.
  const a = { ...song({ name: 'A', bpm: 120, key: 'G#m', secs: VOCAL_SONG }), harmony: { vocal: { profile: profileOf(1, false), key: 'Db', keyConfidence: 0.86 } } };
  const b = { ...song({ name: 'B', bpm: 120, key: 'E', keyConf: 0.44, secs: BED_SONG }), harmony: { bed: { profile: profileOf(4, false), key: null, keyConfidence: 0 } } };
  const byLabel = planMashup(req({ vocalFrom: 'a' }), { ...a, harmony: undefined }, { ...b, harmony: undefined });
  assert.equal(byLabel.check.plan.shiftA.semitones, 0, 'the labels alone: no move');
  const r = planMashup(req({ vocalFrom: 'a' }), a, b);
  assert.deepEqual([r.check.plan.shiftA.semitones, r.check.plan.shiftB.semitones, r.check.plan.key], [3, 0, 'E']);
  assert.equal(r.build.tuneKey, 'E', 'Db + 3 = E: Krypt Tune (when asked) corrects to what the vocal now sings');
  assert.match(r.check.reasons[1], /^Key: measured on the stems: A's vocal \(Db major\) moves \+3 st \(to E major\) to fit B's instrumental \(E major\): the notes match 100% \(unmoved: \d+%\)\./);
  assert.ok(r.check.score > byLabel.check.score - 10, 'a measured good fit is not penalised like a weak label reading');
  assert.equal(r.build.tracks.find((t) => t.role === 'vocal')!.semitones, 3);
  // Anchor vocal: the instrumental moves instead (−3); middle splits (+2 / −1).
  const kv = planMashup(req({ vocalFrom: 'a', anchor: 'vocal' }), a, b);
  assert.deepEqual([kv.check.plan.shiftA.semitones, kv.check.plan.shiftB.semitones], [0, -3]);
  const mid = planMashup(req({ vocalFrom: 'a', anchor: 'middle' }), a, b);
  assert.deepEqual([mid.check.plan.shiftA.semitones, mid.check.plan.shiftB.semitones], [2, -1]);
  // Already fitting: no move. Never fitting (a whole-tone line fits no major scale): a warning.
  const same = planMashup(req({ vocalFrom: 'a' }), { ...a, harmony: { vocal: { profile: profileOf(4, false), key: 'E', keyConfidence: 0.8 } } }, b);
  assert.equal(same.check.plan.shiftA.semitones, 0);
  assert.match(same.check.reasons[1], /fits B's instrumental \(E major\) as it is/);
  const wholeTone = Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.001 : 1 / 6));
  const none = planMashup(req({ vocalFrom: 'a' }), { ...a, harmony: { vocal: { profile: wholeTone, key: null, keyConfidence: 0 } } }, b);
  assert.match(none.check.reasons[1], /may not fit/);
  // An explicit key still wins over the measurement.
  assert.equal(planMashup(req({ vocalFrom: 'a', key: 'F' }), a, b).check.plan.key, 'F');
});

test('levels: every song at MIX_LUFS on the channel gain, the vocal a little over; unmeasured = untouched', () => {
  const r = planMashup(req({ vocalFrom: 'a' }), { ...song({ name: 'A', bpm: 120, secs: VOCAL_SONG }), lufs: -11.8 }, { ...song({ name: 'B', bpm: 120, secs: BED_SONG }), lufs: -6.2 });
  const g = Object.fromEntries(r.build.tracks.map((t) => [t.role, t.gainDb]));
  assert.deepEqual(g, { vocal: -1.2, drums: -7.8, bass: -7.8, other: -7.8 });
  const u = planMashup(req({ vocalFrom: 'a' }), song({ name: 'A', bpm: 120, secs: VOCAL_SONG }), song({ name: 'B', bpm: 120, secs: BED_SONG }));
  assert.ok(u.build.tracks.every((t) => t.gainDb === 0));
});

await test('vocalOverBeat: a measured no-vocal donor is a blocking problem (both instrumentals → try Back & forth)', () => {
  const req: MashupRequest = { a: { path: 'a.wav' }, b: { path: 'b.wav' }, style: 'vocalOverBeat', vocalFrom: 'a' };
  const both = planMashup(req, song({ name: 'Beat A', bpm: 140, vp: 0.02, kind: 'instrumental' }), song({ name: 'Beat B', bpm: 140, vp: 0.03, kind: 'instrumental' }));
  assert.ok(both.check.problems.some((p) => /Neither song has a lead vocal/.test(p) && /Back & forth/.test(p)), both.check.problems.join(' | '));
  const one = planMashup(req, song({ name: 'Beat A', bpm: 140, vp: 0.02, kind: 'instrumental' }), song({ name: 'Singer', bpm: 140, vp: 0.9 }));
  assert.ok(one.check.problems.some((p) => /has no lead vocal/.test(p) && /from B/.test(p)), one.check.problems.join(' | '));
  const unmeasured = planMashup(req, song({ name: 'Beat A', bpm: 140, vp: 0.5, vocalSource: 'unknown' }), song({ name: 'Beat B', bpm: 140 }));
  assert.ok(!unmeasured.check.problems.some((p) => /lead vocal/.test(p)), 'not measured yet: no problem, the stems will tell');
  const bf = planMashup({ ...req, style: 'backAndForth' }, song({ name: 'Beat A', bpm: 140, vp: 0.02 }), song({ name: 'Beat B', bpm: 140, vp: 0.02 }));
  assert.ok(!bf.check.problems.some((p) => /lead vocal/.test(p)), 'Back & forth needs no vocal');
});

run('mashup-plan');
