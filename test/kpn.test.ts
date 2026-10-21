// KPN (Krypt Pattern Notation) parser, canonical printer and symbolic stats.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { parse, print, printKpn, formatIssues, symbolicStats, chordSymbolToMidi, defaultGrid, type KpnNote, type PrintNote, type PrintTrack } from '@shared/kpn';

const TRAP = `pattern "Trap A" bars=2 grid=16 key=F#m
kick       : x... .... ..x. .... | x... .... .x.. ..x.
snare      : .... X... .... X... | .... X... .... X..o
hat/32     : (x.x.)*7 xxxx | (x.x.)*6 xxxx xxxx
openhat    : .... .... .... ..o. | .... .... .... ....
808 {oct=1}: F#1:6 r:4 C#2:2 E2:4 | F#1:8~ C#1:4 r:2 A1:2`;

const VERSE = `pattern "Verse Keys" bars=4 grid=16 key=Am
chords {oct=3 vel=80}: Am7:16 | Fmaj7:16 | C:16 | G/B:16
lead {oct=5}: ^5:4 ^3:2 ^1 ^2:4 ^3:4 | ^1:8 r:8 | r:4 ^5:2 ^6 ^5:4 ^3:4 | ^2:12 r:4`;

const midi = (n: KpnNote | PrintNote) => Math.round(n.vel * 127);
const track = (r: ReturnType<typeof parse>, name: string) => r.tracks.find((t) => t.name === name)!;
const firstError = (text: string) => parse(text).errors[0]?.message ?? '';

// ── Parsing the research examples ───────────────────────────────────────

test('Trap A: header, grids, holds, /32 lines, velocities, 808 slides', () => {
  const r = parse(TRAP);
  assert.equal(r.ok, true, formatIssues(r.errors));
  assert.deepEqual(r.header, { name: 'Trap A', bars: 2, grid: 16, ts: { num: 4, den: 4 }, tsExplicit: false, key: 'F#m', swing: null, line: 1, extra: {} });
  assert.equal(r.barTicks, 3840);
  assert.equal(r.totalTicks, 7680);
  const kick = track(r, 'kick');
  assert.equal(kick.kind, 'grid');
  assert.deepEqual(kick.notes.map((n) => n.tick), [0, 2400, 3840, 6000, 7200]);
  assert.ok(kick.notes.every((n) => n.dur === 240 && n.key === 60 && midi(n) === 100));
  const snare = track(r, 'snare');
  assert.deepEqual(snare.notes.map(midi), [127, 127, 127, 127, 50]);
  const hat = track(r, 'hat');
  assert.equal(hat.grid, 32);
  assert.equal(hat.notes.length, 38);
  assert.ok(hat.notes.every((n) => n.dur === 120));
  const b = track(r, '808');
  assert.equal(b.kind, 'melodic');
  assert.deepEqual(
    b.notes.map((n) => [n.tick, n.dur, n.key, n.slide]),
    [
      [0, 1440, 30, false],
      [2400, 480, 37, false],
      [2880, 960, 40, false],
      [3840, 1920, 30, false],
      [5760, 960, 25, true],
      [7200, 480, 33, false],
    ],
  );
});

test('Verse Keys: chord symbols, slash chords, scale degrees, sticky lengths', () => {
  const r = parse(VERSE);
  assert.equal(r.ok, true, formatIssues(r.errors));
  const chords = track(r, 'chords');
  const byTick = (t: number) => chords.notes.filter((n) => n.tick === t).map((n) => n.key).sort((a, b) => a - b);
  assert.deepEqual(byTick(0), [57, 60, 64, 67], 'Am7 at oct 3');
  assert.deepEqual(byTick(3840), [53, 57, 60, 64], 'Fmaj7');
  assert.deepEqual(byTick(7680), [48, 52, 55], 'C');
  assert.deepEqual(byTick(11520), [47, 55, 59, 62], 'G/B puts B below the root');
  assert.ok(chords.notes.every((n) => midi(n) === 80 && n.dur === 3840));
  const lead = track(r, 'lead');
  assert.deepEqual(
    lead.notes.slice(0, 5).map((n) => [n.tick, n.dur, n.key]),
    [
      [0, 960, 88],
      [960, 480, 84],
      [1440, 480, 81],
      [1920, 960, 83],
      [2880, 960, 84],
    ],
  );
  assert.equal(lead.notes.length, 11);
});

test('the counting-mistake example returns the documented errors', () => {
  const r = parse('pattern "Broken" bars=1 grid=16\nkick : x... x... x.x x...\nlead : C4:4 D4:4 E4:6 | F4:2');
  assert.equal(r.ok, false);
  const msgs = r.errors.map((e) => e.message);
  assert.ok(msgs.includes('line 2 (kick): 15 steps total, expected 16 (1 bar × 16)'), msgs.join('\n'));
  assert.ok(msgs.includes('line 3 (lead), bar 1: has 14/16 steps at the bar line (2 short)'), msgs.join('\n'));
  assert.equal(msgs.length, 2, 'no cascade errors after the first lead error');
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3]);
  assert.equal(r.errors[1].bar, 1);
  assert.equal(r.errors[1].track, 'lead');
});

test('merge-mode example: _ clears, digits are velocities, bar lines checked per bar', () => {
  const r = parse('pattern "Trap A" bars=2 grid=16\nsnare/32: .... .... .... .... .... .... .... .... | .... .... .... .... .... .... xxxx 5678\nkick: _... x... .... .... | .... .... .... ....');
  assert.equal(r.ok, true, formatIssues(r.errors));
  const s = track(r, 'snare');
  assert.deepEqual(s.notes.map(midi), [100, 100, 100, 100, 70, 84, 98, 112]);
  assert.equal(s.notes[0].tick, 3840 + 24 * 120);
  assert.deepEqual(track(r, 'kick').clears, [{ tick: 0, dur: 240 }]);
});

// ── Grid lines ──────────────────────────────────────────────────────────

test('grid: bar-line errors name the bar and the count (short and long)', () => {
  assert.equal(firstError('pattern "x" bars=2\nhat: x.x. x.x. x.x. x.x | x.x. x.x. x.x. x.x.'), 'line 2 (hat), bar 1: has 15/16 steps at the bar line (1 short)');
  assert.equal(firstError('pattern "x" bars=2\nhat: x.x. x.x. x.x. x.x.x. | x.x. x.x. x.x. x.x.'), 'line 2 (hat), bar 1: has 18/16 steps at the bar line (2 too many)');
  // After the bad bar the cursor re-syncs, so bar 2 is checked on its own.
  const r = parse('pattern "x" bars=3\nhat: x.x. x.x. x.x. x.x | x.x. x.x. x.x. x.x. | x.x. x.x. x.x. x.x');
  assert.deepEqual(r.errors.map((e) => e.bar ?? null), [1, null]);
  assert.match(r.errors[1].message, /47 steps total, expected 48/);
});

test('grid: holds, repeats, nested repeats, per-line grid and pitch option', () => {
  const r = parse('pattern "g" bars=1\nsub {pitch=C2 vel=90}: x--- .... x--- --..\nk: ((x.)*2 ....)*2\ntrip/12: x.x x.x x.x xxx');
  assert.equal(r.ok, true, formatIssues(r.errors));
  const sub = track(r, 'sub');
  assert.deepEqual(sub.notes.map((n) => [n.tick, n.dur, n.key, midi(n)]), [
    [0, 960, 36, 90],
    [1920, 1440, 36, 90],
  ]);
  assert.equal(sub.pitchExplicit, true);
  assert.deepEqual(track(r, 'k').notes.map((n) => n.tick / 240), [0, 2, 8, 10]);
  const trip = track(r, 'trip');
  assert.equal(trip.grid, 12);
  assert.ok(trip.notes.every((n) => n.dur === 320));
  assert.deepEqual(trip.notes.map((n) => n.tick), [0, 640, 960, 1600, 1920, 2560, 2880, 3200, 3520]);
});

test('grid: a hold with nothing to extend, bad characters and bad repeats are errors', () => {
  assert.match(firstError('pattern "g" bars=1\nk: .-.. .... .... ....'), /'-' \(hold\) at step 1\.2 has no hit before it/);
  assert.match(firstError('pattern "g" bars=1\nk: x... .q.. .... ....'), /unexpected 'q'/);
  assert.match(firstError('k: (x.x.*4'), /needs a repeat count|unbalanced/);
  assert.match(firstError('k: (x.)*0'), /repeat count \*0 must be 1\.\.512/);
  assert.match(firstError('k: x... x...'), /8 steps is not a whole number of bars/);
});

test('drum key defaults to 60, or the callback (channel root key), or {pitch=}', () => {
  const r = parse('kick: x... .... .... ....\nperc {pitch=64}: x... .... .... ....', { drumKey: (n) => (n === 'kick' ? 48 : 60) });
  assert.equal(track(r, 'kick').notes[0].key, 48);
  assert.equal(track(r, 'perc').notes[0].key, 64);
});

// ── Melodic lines ───────────────────────────────────────────────────────

test('tokens: velocity marks, chords with per-note velocity, prefix slide, @ positions', () => {
  const r = parse('pattern "m" bars=2\nlead {vel=90}: C4:2 D4! E4? F4v33 [C4 E4v70 G4]:4 r:4 | @2.9 ~A4:8');
  assert.equal(r.ok, true, formatIssues(r.errors));
  const n = track(r, 'lead').notes;
  assert.deepEqual(n.map((x) => [x.tick, x.dur, x.key, midi(x), x.slide]), [
    [0, 480, 60, 90, false],
    [480, 480, 62, 120, false],
    [960, 480, 64, 60, false],
    [1440, 480, 65, 33, false],
    [1920, 960, 60, 90, false],
    [1920, 960, 64, 70, false],
    [1920, 960, 67, 90, false],
    [5760, 1920, 69, 90, true],
  ]);
});

test('tokens: errors for unknown chords (with the dom7 hint), degrees without key, bad suffixes, past the end', () => {
  assert.match(firstError('x: Cfoo'), /unknown chord quality "foo"/);
  assert.match(firstError('x: Cfoo'), /write Gdom7 for the chord/);
  assert.match(firstError('x: ^3'), /needs key= in the pattern header/);
  assert.match(firstError('x: C4:2q'), /can't read "q"/);
  assert.match(firstError('x: C4:1.5'), /whole number of steps/);
  assert.match(firstError('x: C4v200'), /velocity v200 must be 1\.\.127/);
  assert.match(firstError('pattern "p" bars=1\nx: C4:12 D4:8'), /D4:8 at 1\.13 ends at step 20, past the pattern end \(16 steps\)/);
  assert.match(firstError('x: c'), /note names need an octave/);
  assert.equal(parse('x: c4 bb3').tracks[0].notes.map((n) => n.key).join(), '60,58', 'lowercase note names are accepted');
  assert.match(firstError('x: @0.1 C4'), /out of range/);
  const w = parse('x: G7:16');
  assert.equal(w.ok, true);
  assert.match(w.warnings[0].message, /G7 is the NOTE G7 \(MIDI 103\); for a dominant chord write Gdom7/);
  assert.deepEqual(chordSymbolToMidi('Gdom7', 3), { notes: [55, 59, 62, 65] });
});

test('degrees: accidentals, octave marks, multi-octave degrees, modes', () => {
  const r = parse('pattern "d" key=C\nx: ^1 ^b3 ^#4 ^5\' ^1, ^8 ^9');
  assert.equal(r.ok, true, formatIssues(r.errors));
  assert.deepEqual(track(r, 'x').notes.map((n) => n.key), [60, 63, 66, 79, 48, 72, 74]);
  const dor = parse('pattern "d" key="D dorian"\nx {oct=3}: ^3 ^6');
  assert.equal(dor.ok, true, formatIssues(dor.errors));
  assert.deepEqual(track(dor, 'x').notes.map((n) => n.key), [53, 59]);
});

test('ts=3/4 defaults the grid to 12; header option errors are precise', () => {
  const r = parse('pattern "Waltz" bars=1 ts=3/4\nk: x.. x.. x.. x..');
  assert.equal(r.ok, true, formatIssues(r.errors));
  assert.equal(r.header.grid, 12);
  assert.equal(r.barTicks, 2880);
  assert.deepEqual(track(r, 'k').notes.map((n) => n.tick), [0, 720, 1440, 2160]);
  assert.equal(defaultGrid({ num: 6, den: 8 }), 12);
  assert.match(firstError('pattern "x" bars=0'), /bars=0 must be a whole number 1\.\.1024/);
  assert.match(firstError('pattern "x" key=H'), /key=H isn't a key/);
  assert.match(firstError('pattern "x" grid=7'), /grid=7 doesn't divide/);
  assert.match(firstError('pattern "x" ts=4/5'), /ts=4\/5 must look like 4\/4/);
  assert.match(parse('pattern "x" bpm=140').warnings[0].message, /unknown header option bpm=/);
});

test('structure: quoted names, comments, continuation lines, one header, mixed styles', () => {
  const r = parse(`// a comment
pattern "S" bars=2
"Open Hat": .... ..x. .... ..x. // trailing comment
lead: C4 D4 E4 F4 |
lead: G4:16
"Open Hat": .... ..x. .... ..x.`);
  assert.equal(r.ok, true, formatIssues(r.errors));
  assert.equal(r.tracks.length, 2);
  assert.equal(track(r, 'Open Hat').notes.length, 4);
  assert.deepEqual(track(r, 'Open Hat').lines, [3, 6]);
  assert.deepEqual(track(r, 'lead').notes.map((n) => n.tick), [0, 960, 1920, 2880, 3840]);
  assert.match(firstError('pattern "a"\npattern "b"\nk: x...'), /only one pattern header/);
  assert.match(firstError('k: x... ....\nk: C4'), /mixes a step grid and note tokens/);
  assert.match(firstError('kick x... x...'), /expected "<channel>: <notes>"/);
  assert.match(parse('k: C4', { requireHeader: true }).errors[0].message, /must start with a header/);
  const noHeader = parse('k: x... x... x... x... | x... .... .... ....');
  assert.equal(noHeader.ok, true);
  assert.equal(noHeader.bars, 2, 'bars inferred from content');
});

test('never throws on garbage', () => {
  for (const s of ['', '\n\n', ':::', '{', 'pattern', '"unterminated: x', 'k: [C4 E4', 'k: ((((x)*2)*2)*2)*2', 'k: ' + '(x.)*512 '.repeat(5), '\u0000‮']) {
    const r = parse(s);
    assert.equal(typeof r.ok, 'boolean');
  }
});

// ── Canonical printer ───────────────────────────────────────────────────

const N = (tick: number, dur: number, key: number, vel = 100, slide = false): PrintNote => ({ tick, dur, key, vel: vel / 127, slide });

test('print: drum grids, compression of identical bars, pitch/vel options', () => {
  const four = [0, 960, 1920, 2880].map((t) => N(t, 240, 60));
  assert.equal(print([{ name: 'kick', notes: four, drum: true }], { name: 'Four', bars: 1 }), 'pattern "Four" bars=1 grid=16\nkick: x... x... x... x...');
  const four4 = [0, 1, 2, 3].flatMap((b) => four.map((n) => ({ ...n, tick: n.tick + b * 3840 })));
  assert.equal(print([{ name: 'kick', notes: four4, drum: true }], { bars: 4, header: false }), 'kick: (x... x... x... x... |)*4');
  const sub = [N(0, 960, 36, 90), N(1920, 480, 36, 127)];
  assert.equal(print([{ name: 'sub', notes: sub, drum: true }], { bars: 1, header: false }), 'sub {pitch=C2 vel=90}: x--- .... X-.. ....');
});

test('print: melodic tokens, sticky lengths, chords, rests, bar lines, slides, @ jumps', () => {
  const lead = [N(0, 960, 60), N(960, 960, 64), N(1920, 1920, 67), N(3840, 3840, 60), N(3840, 3840, 64), N(3840, 3840, 67)];
  assert.equal(print([{ name: 'lead', notes: lead }], { bars: 2, header: false }), 'lead: C4 E4 G4:8 | [C4 E4 G4]:16');
  assert.equal(print([{ name: 'b', notes: [N(0, 960, 57), N(960, 960, 59, 100, true)] }], { header: false }), 'b: A3~ B3');
  assert.equal(print([{ name: 'b', notes: [N(0, 960, 57, 100, true)] }], { header: false }), 'b: ~A3');
  assert.equal(print([{ name: 'x', notes: [N(7680, 960, 60)] }], { bars: 4, header: false }), 'x: @3.1 C4');
  assert.equal(print([{ name: 'x', notes: [N(0, 1920, 60), N(960, 960, 64)] }], { header: false }), 'x: C4:8 @1.5 E4:4');
  assert.equal(print([{ name: 'x', notes: [N(240, 240, 60), N(4080, 240, 62, 120), N(4320, 240, 64, 60)] }], { bars: 2, header: false }), 'x: r:1 C4 r:14 | r:1 D4! E4?');
  assert.equal(print([{ name: 'x', notes: [N(0, 960, 60, 80), N(960, 960, 62, 80), N(1920, 960, 64, 33)] }], { header: false }), 'x {vel=80}: C4 D4 E4v33');
});

test('print: grid selection (triplets, 32nds), off-grid warning, flats, quoting, header', () => {
  const trip = [0, 320, 640].map((t) => N(t, 320, 60));
  assert.equal(print([{ name: 'h', notes: trip, drum: true }], { header: false }), 'h/12: xxx ... ... ...');
  const r32 = print([{ name: 'h', notes: [N(0, 120, 60), N(120, 120, 60)], drum: true }], { header: false });
  assert.equal(r32, 'h/32: xx.. .... .... .... .... .... .... ....');
  const off = printKpn([{ name: 'x', notes: [N(7, 240, 60)] }], { header: false });
  assert.match(off.warnings[0], /1 note is off-grid; shown quantized to 1\/192 bar/);
  assert.equal(print([{ name: 'x', notes: [N(0, 960, 63)] }], { header: false, key: 'Cm' }), 'x: Eb4');
  assert.equal(print([{ name: 'x', notes: [N(0, 960, 63)] }], { header: false, key: 'E' }), 'x: D#4');
  assert.equal(print([{ name: 'Open Hat', notes: [N(0, 240, 60)], drum: true }], { header: false }), '"Open Hat": x... .... .... ....');
  assert.equal(print([], { name: 'Odd "name"', bars: 2, ts: { num: 3, den: 4 }, key: 'D dorian' }), 'pattern "Odd \\"name\\"" bars=2 grid=12 ts=3/4 key="D dorian"');
  const warn = printKpn([{ name: 'x', notes: [N(3840, 960, 60)] }], { bars: 1 });
  assert.match(warn.warnings[0], /notes run past the pattern length/);
});

test('print: non-representable drum lines fall back to tokens', () => {
  const twoKeys = print([{ name: 'kit', notes: [N(0, 240, 60), N(960, 240, 62)], drum: true }], { header: false });
  assert.equal(twoKeys, 'kit: C4:1 r:3 D4:1');
  const vels = print([{ name: 'k', notes: [N(0, 240, 60, 99), N(960, 240, 60, 101)], drum: true }], { header: false });
  assert.match(vels, /^k \{vel=\d+\}: C4:1/);
});

test('canonical round trip: the doc examples print → parse to identical notes', () => {
  for (const src of [TRAP, VERSE]) {
    const a = parse(src);
    const drums = new Set(['kick', 'snare', 'hat', 'openhat']);
    const text = print(
      a.tracks.map((t) => ({ name: t.name, notes: t.notes, drum: drums.has(t.name) })),
      { name: a.header.name, bars: a.header.bars, key: a.header.key },
    );
    const b = parse(text);
    assert.equal(b.ok, true, `${text}\n${formatIssues(b.errors)}`);
    const sig = (r: typeof a) => r.tracks.map((t) => t.notes.map((n) => `${n.tick}|${n.dur}|${n.key}|${midi(n)}|${n.slide}`).sort().join(','));
    assert.deepEqual(sig(b), sig(a));
    assert.equal(print(b.tracks.map((t) => ({ name: t.name, notes: t.notes, drum: drums.has(t.name) })), { name: b.header.name, bars: b.header.bars, key: b.header.key }), text, 'printing is idempotent');
  }
});

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigOf = (notes: Array<KpnNote | PrintNote>) => notes.map((n) => `${n.tick}|${n.dur}|${n.key}|${midi(n)}|${!!n.slide}`).sort();

test('property: random on-grid melodic material round-trips exactly (300 cases)', () => {
  const rand = rng(1234);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  for (let c = 0; c < 300; c++) {
    const grid = pick([16, 32, 12, 24, 8]);
    const st = 3840 / grid;
    const bars = 1 + Math.floor(rand() * 4);
    const n = Math.floor(rand() * 14);
    const notes: PrintNote[] = [];
    for (let i = 0; i < n; i++) {
      const tick = Math.floor(rand() * bars * grid) * st;
      const maxLen = Math.max(1, Math.min(grid, (bars * 3840 - tick) / st));
      const dur = (1 + Math.floor(rand() * maxLen)) * st;
      const vel = rand() < 0.5 ? 100 : 1 + Math.floor(rand() * 127);
      notes.push(N(tick, dur, 24 + Math.floor(rand() * 84), vel, rand() < 0.15));
    }
    const tr: PrintTrack = { name: 'lead', notes };
    const text = print([tr], { name: 'P', bars, key: pick([null, 'Cm', 'F#m', 'Bb', 'E']) });
    const r = parse(text);
    assert.equal(r.ok, true, `case ${c}:\n${text}\n${formatIssues(r.errors)}`);
    assert.deepEqual(sigOf(r.tracks[0]?.notes ?? []), sigOf(notes), `case ${c}:\n${text}`);
  }
});

test('property: random drum lines round-trip exactly as grids (200 cases)', () => {
  const rand = rng(99);
  for (let c = 0; c < 200; c++) {
    const grid = rand() < 0.5 ? 16 : 32;
    const st = 3840 / grid;
    const bars = 1 + Math.floor(rand() * 4);
    const lineVel = rand() < 0.5 ? 100 : 60 + Math.floor(rand() * 60);
    const notes: PrintNote[] = [];
    let s = 0;
    while (s < bars * grid) {
      if (rand() < 0.4) {
        const len = 1 + Math.floor(rand() * Math.min(4, bars * grid - s));
        const r = rand();
        const vel = r < 0.6 ? lineVel : r < 0.75 ? 127 : r < 0.85 ? 50 : 14 * (1 + Math.floor(rand() * 9));
        notes.push(N(s * st, len * st, 60, vel));
        s += len;
      } else s++;
    }
    const text = print([{ name: 'hat', notes, drum: true }], { bars });
    const r = parse(text);
    assert.equal(r.ok, true, `case ${c}:\n${text}\n${formatIssues(r.errors)}`);
    if (notes.length) assert.equal(r.tracks[0].kind, 'grid', `case ${c} should print as a grid:\n${text}`);
    assert.deepEqual(sigOf(r.tracks[0]?.notes ?? []), sigOf(notes), `case ${c}:\n${text}`);
  }
});

// ── Symbolic stats ──────────────────────────────────────────────────────

test('symbolic stats: key estimate, chords per bar, out-of-key notes, ranges, low clashes', () => {
  const r = parse(VERSE);
  const s = symbolicStats(r.tracks.map((t) => ({ name: t.name, notes: t.notes })), { lengthTicks: r.totalTicks, ts: { num: 4, den: 4 }, key: 'Am' });
  assert.deepEqual(s.chords, ['Am7', 'Fmaj7', 'C', 'G']);
  assert.equal(s.outOfKeyRatio, 0);
  assert.equal(s.channels[0].range, 'B2–G4');
  assert.equal(s.bars, 4);
  const cmaj = symbolicStats([{ name: 'x', notes: [60, 62, 64, 65, 67, 69, 71, 72, 64, 67, 60].map((k, i) => ({ tick: i * 960, dur: 960, key: k, vel: 0.8 })) }], { lengthTicks: 4 * 3840, ts: { num: 4, den: 4 } });
  assert.equal(cmaj.key.estimated, 'C');
  const out = symbolicStats([{ name: 'x', notes: [{ tick: 0, dur: 960, key: 61, vel: 1 }, { tick: 960, dur: 960, key: 60, vel: 1 }] }], { lengthTicks: 3840, ts: { num: 4, den: 4 }, key: 'C' });
  assert.equal(out.outOfKeyRatio, 0.5);
  assert.deepEqual(out.outOfKeyNotes, ['x C#4 @1.1']);
  const mud = symbolicStats(
    [
      { name: 'bass', notes: [{ tick: 0, dur: 3840, key: 36, vel: 1 }] },
      { name: 'pad', notes: [{ tick: 0, dur: 3840, key: 37, vel: 1 }] },
    ],
    { lengthTicks: 3840, ts: { num: 4, den: 4 } },
  );
  assert.match(mud.lowClashes[0], /bar 1: bass C2 vs pad C#2 \(minor 2nd below C3\)/);
  const drums = symbolicStats([{ name: 'kick', notes: [{ tick: 0, dur: 240, key: 60, vel: 1 }], drum: true }], { lengthTicks: 3840, ts: { num: 4, den: 4 }, key: 'C#' });
  assert.equal(drums.outOfKeyRatio, null, 'drums are not judged for key');
});

await run('kpn');
