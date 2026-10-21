// MIDI generators (shared/music/generate) + the notes.generate command:
// determinism, keys, voicings, following chords, Euclid, undo.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Note } from '@shared/schema/project';
import { SCALES } from '@shared/music/theory';
import {
  GENERATOR_KINDS,
  PROGRESSIONS,
  arpCycle,
  detectChords,
  euclid,
  euclidString,
  identifyChord,
  inKey,
  parseGeneratorOptions,
  runGenerator,
  variationSeed,
  type GenContext,
  type GeneratorKind,
} from '@shared/music/generate';
import { guessKey, planGenerate, GENERATE_ARGS } from '@shared/commands/generate';

const BAR = 3840;
const pc = (k: number) => ((k % 12) + 12) % 12;

function fresh() {
  const p = createDefaultProject('Gen');
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const keys = p.channelOrder[5]; // Keys (triosc)
  const bass = p.channelOrder[4]; // 808
  const hat = p.channelOrder[2];
  const exec = <T = unknown>(cmd: string, args: Record<string, unknown>) => host.exec<T>(cmd, { patternId: pat, ...args }, { actor: USER });
  const notes = (ch: string): Note[] => Object.values(host.project.patterns[pat].notes[ch] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);
  return { host, pat, keys, bass, hat, exec, notes };
}

function ctx(over: Partial<GenContext> = {}): GenContext {
  return { key: { root: 9, scale: 'minor' }, start: 0, end: 4 * BAR, barTicks: BAR, beatTicks: 960, seed: 1, patternChords: [], defaultNote: 60, ...over };
}

function gen(kind: GeneratorKind, options: Record<string, unknown> = {}, c: Partial<GenContext> = {}) {
  const o = parseGeneratorOptions(kind, options);
  assert.ok(o.ok, o.ok ? '' : o.message);
  return runGenerator(kind, o.options, ctx(c));
}

const sig = (ns: Array<{ tick: number; key: number; dur: number; vel: number }>) => ns.map((n) => `${n.tick}:${n.key}:${n.dur}:${n.vel}`).join(' ');

// Am | F | C | G, close triads, one per bar.
const AM_F_C_G = [
  [57, 60, 64],
  [57, 60, 65],
  [55, 60, 64],
  [55, 59, 62],
];
function writeChords(f: ReturnType<typeof fresh>, ch: string) {
  const ns = AM_F_C_G.flatMap((ks, b) => ks.map((key) => ({ tick: b * BAR, key, dur: BAR })));
  assert.equal(f.exec('notes.replace', { channelId: ch, notes: ns }).ok, true);
}
const CHORD_PCS = AM_F_C_G.map((ks) => ks.map(pc));

// ── Euclid ────────────────────────────────────────────────────────────

test('Euclid: E(3,8) = x..x..x., E(5,8), E(4,16), edges and rotation', () => {
  assert.equal(euclidString(euclid(3, 8)), 'x..x..x.');
  assert.equal(euclidString(euclid(5, 8)), 'x.xx.xx.');
  assert.equal(euclidString(euclid(4, 16)), 'x...x...x...x...');
  assert.equal(euclidString(euclid(0, 4)), '....');
  assert.equal(euclidString(euclid(4, 4)), 'xxxx');
  assert.equal(euclidString(euclid(9, 4)), 'xxxx', 'more pulses than steps fill every step');
  assert.equal(euclidString(euclid(3, 8, 1)), '..x..x.x');
  for (const [k, n] of [[3, 8], [5, 13], [7, 16], [2, 5]]) assert.equal(euclid(k, n).filter(Boolean).length, k);
});

test('rhythm generator: Euclid hits land on the pattern, 8th rate, accents, rolls stay in range', () => {
  const r = gen('rhythm', { steps: 8, pulses: 3, rate: '8th', accents: 'none' }, { end: BAR });
  assert.deepEqual(r.notes.map((n) => n.tick), [0, 3 * 480, 6 * 480], 'x..x..x. on 8ths, one bar');
  assert.ok(r.notes.every((n) => n.key === 60), 'default pitch = the channel root key');
  assert.match(r.detail, /E\(3,8\) = x\.\.x\.\.x\./);
  const acc = gen('rhythm', { steps: 16, pulses: 16, accents: 'backbeat' }, { end: BAR });
  const loud = acc.notes.filter((n) => n.vel > 0.85).map((n) => n.tick);
  assert.deepEqual(loud, [960, 2880], 'backbeat accents on 2 and 4');
  const rolls = gen('rhythm', { steps: 16, pulses: 8, rolls: 1 }, { end: 2 * BAR, seed: 3 });
  assert.ok(rolls.notes.some((n) => n.tick % 240 === 120), '32nd rolls add notes between the 16ths');
  assert.ok(rolls.notes.every((n) => n.tick >= 0 && n.tick < 2 * BAR));
  const ghosts = gen('rhythm', { steps: 16, pulses: 4, ghosts: 1, note: 42 }, { end: BAR });
  assert.ok(ghosts.notes.length > 4 && ghosts.notes.some((n) => n.vel < 0.4) && ghosts.notes.every((n) => n.key === 42));
});

// ── Determinism ───────────────────────────────────────────────────────

test('every generator: same seed → same notes; another seed → another take', () => {
  for (const kind of GENERATOR_KINDS) {
    const a = gen(kind, {}, { seed: 1234 });
    const b = gen(kind, {}, { seed: 1234 });
    const c = gen(kind, {}, { seed: 99 });
    assert.ok(a.notes.length > 0, `${kind} wrote notes`);
    assert.equal(sig(a.notes), sig(b.notes), `${kind}: same seed`);
    assert.notEqual(sig(a.notes), sig(c.notes), `${kind}: different seed`);
  }
  assert.equal(variationSeed(77, 0), 77);
  const vs = [0, 1, 2, 3].map((i) => variationSeed(77, i));
  assert.equal(new Set(vs).size, 4, 'four distinct variation seeds');
  assert.deepEqual(vs, [0, 1, 2, 3].map((i) => variationSeed(77, i)), 'variation seeds are stable');
});

// ── Keys ──────────────────────────────────────────────────────────────

test('chords, arps and melodies stay in the key (every 7-note scale, every preset, many seeds)', () => {
  const seven = Object.keys(SCALES).filter((s) => SCALES[s].length === 7);
  for (const scale of seven) {
    for (const root of [0, 4, 9]) {
      const key = { root, scale };
      for (let seed = 1; seed <= 6; seed++) {
        for (const kind of ['chords', 'arp', 'melody'] as const) {
          const r = gen(kind, {}, { key, seed });
          for (const n of r.notes) assert.ok(inKey(n.key, key), `${kind} ${root} ${scale} seed ${seed}: ${n.key} is out of key`);
        }
      }
      for (const p of PROGRESSIONS) for (const n of gen('chords', { progression: p.id, extensions: 'sevenths' }, { key }).notes) assert.ok(inKey(n.key, key), `${p.id} in ${root} ${scale}`);
    }
  }
  // the melody keeps to pentatonic / blues scales too
  for (const scale of ['minorPentatonic', 'majorPentatonic', 'blues']) {
    for (let seed = 1; seed <= 5; seed++) for (const n of gen('melody', { feel: '16ths' }, { key: { root: 2, scale }, seed }).notes) assert.ok(inKey(n.key, { root: 2, scale }), `${scale}: ${n.key}`);
  }
});

test('melody: range, contour and call and response', () => {
  const r = gen('melody', { low: 62, high: 74, contour: 'rise', callResponse: false, phrase: 4, density: 0.8 }, { seed: 5 });
  assert.ok(r.notes.every((n) => n.key >= 62 && n.key <= 74), 'inside the range');
  const half = r.notes.length / 2;
  const avg = (ns: typeof r.notes) => ns.reduce((s, n) => s + n.key, 0) / ns.length;
  assert.ok(avg(r.notes.slice(half)) > avg(r.notes.slice(0, half)), 'a rising contour climbs');
  const cr = gen('melody', { phrase: 1, callResponse: true, density: 0.7 }, { seed: 8, end: 2 * BAR });
  const call = cr.notes.filter((n) => n.tick < BAR && n.tick < BAR * 0.5);
  const answer = cr.notes.filter((n) => n.tick >= BAR && n.tick < BAR * 1.5);
  assert.deepEqual(answer.map((n) => [n.tick - BAR, n.key]), call.map((n) => [n.tick, n.key]), 'the answer starts as the call');
  for (const bad of [{ low: 70, high: 60 }, { low: 60, high: 62 }]) {
    const o = parseGeneratorOptions('melody', bad);
    assert.ok(o.ok);
    assert.throws(() => runGenerator('melody', o.ok ? o.options : (null as never), ctx()), /lowest|range/);
  }
});

// ── Chords: voicings and voice leading ────────────────────────────────

test('chords: close voicings are voice-led (no voice jumps more than a fifth), open / spread are wider', () => {
  for (const p of PROGRESSIONS) {
    for (const ext of ['triads', 'sevenths'] as const) {
      const r = gen('chords', { progression: p.id, extensions: ext, voicing: 'close' }, { end: 8 * BAR, key: { root: 2, scale: 'minor' } });
      const byTick = new Map<number, number[]>();
      for (const n of r.notes) byTick.set(n.tick, [...(byTick.get(n.tick) ?? []), n.key]);
      const chords = [...byTick.values()].map((ks) => ks.sort((a, b) => a - b));
      for (const c of chords) assert.ok(c[c.length - 1] - c[0] <= 12, `${p.id}: close voicing spans ${c}`);
      for (let i = 1; i < chords.length; i++) {
        const a = chords[i - 1];
        const b = chords[i];
        for (const k of b) {
          const move = Math.min(...a.map((x) => Math.abs(x - k)));
          assert.ok(move <= 7, `${p.id} ${ext}: ${a} → ${b} moves a voice ${move} semitones`);
        }
        assert.ok(Math.abs(a[0] - b[0]) <= 12, 'never more than an octave between close voicings');
      }
    }
  }
  const span = (v: string) => {
    const r = gen('chords', { progression: 'pop', voicing: v, rhythm: 'whole' }, { end: BAR });
    return Math.max(...r.notes.map((n) => n.key)) - Math.min(...r.notes.map((n) => n.key));
  };
  assert.ok(span('open') > 12 && span('spread') > span('close'), 'open and spread voicings are wider than close');
  const inv = gen('chords', { progression: '1', inversion: 'first', rhythm: 'whole' }, { end: BAR, key: { root: 0, scale: 'major' } });
  assert.equal(pc(Math.min(...inv.notes.map((n) => n.key))), 4, 'first inversion of C puts E in the bass');
});

test('chords: numerals, presets, rhythm and names', () => {
  const r = gen('chords', { progression: 'i VI III VII', rhythm: 'whole' }, { key: { root: 9, scale: 'minor' } });
  assert.deepEqual(r.chords, ['Am', 'F', 'C', 'G']);
  assert.equal(r.notes.filter((n) => n.tick === 0).length, 3, 'triads');
  const s = gen('chords', { progression: 'ii7 V7 Imaj7', rhythm: 'quarters' }, { key: { root: 0, scale: 'major' }, end: 3 * BAR });
  assert.deepEqual(s.chords, ['Dm7', 'G7', 'Cmaj7']);
  assert.equal(new Set(s.notes.map((n) => n.tick)).size, 12, 'quarters: four hits a bar');
  const borrowed = gen('chords', { progression: 'I bVII IV', rhythm: 'whole' }, { key: { root: 0, scale: 'major' }, end: 3 * BAR });
  assert.deepEqual(borrowed.chords, ['C', 'Bb', 'F']);
  const off = gen('chords', { progression: 'pop', rhythm: 'offbeat' }, { end: BAR });
  assert.deepEqual([...new Set(off.notes.map((n) => n.tick))], [480, 1440, 2400, 3360]);
  const half = gen('chords', { progression: 'pop', barsPerChord: 0.5 }, { end: BAR, key: { root: 0, scale: 'major' } });
  assert.deepEqual(half.chords, ['C', 'G']);
  const bad = parseGeneratorOptions('chords', { progression: 'i Q7' });
  assert.ok(bad.ok);
  assert.throws(() => runGenerator('chords', bad.ok ? bad.options : (null as never), ctx()), /"Q7" is not a chord numeral/);
  const typo = parseGeneratorOptions('chords', { voicng: 'open' });
  assert.equal(typo.ok, false);
  assert.match(typo.ok ? '' : typo.message, /Unknown chords option "voicng"/);
});

// ── Following the chords in a pattern ─────────────────────────────────

test('chord detection reads stacked notes on any channel', () => {
  const f = fresh();
  writeChords(f, f.keys);
  const evs = detectChords([f.notes(f.keys)]);
  assert.deepEqual(evs.map((e) => [e.tick, e.name]), [[0, 'Am'], [BAR, 'F'], [2 * BAR, 'C'], [3 * BAR, 'G']]);
  assert.deepEqual(identifyChord([52, 55, 60]).root, 0, 'C/E is still C');
});

test('arp follows the chords already in the pattern (another channel, or replacing them on the same one)', () => {
  const f = fresh();
  writeChords(f, f.keys);
  const r = f.exec<{ count: number; chordSource: string; chords: string[] }>('notes.generate', { channelId: f.bass, kind: 'arp', options: { style: 'upDown', rate: '16th', octaves: 2 }, seed: 4 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.chordSource, 'pattern');
  assert.deepEqual(r.data!.chords, ['Am', 'F', 'C', 'G']);
  const arp = f.notes(f.bass);
  assert.equal(arp.length, 64, '16ths over 4 bars');
  for (const n of arp) assert.ok(CHORD_PCS[Math.floor(n.tick / BAR)].includes(pc(n.key)), `arp note ${n.key} at ${n.tick} is not in the chord`);
  // on the chord channel itself: the chords become the arp (detected before they are replaced)
  const same = f.exec('notes.generate', { channelId: f.keys, kind: 'arp', options: { style: 'converge' } });
  assert.equal(same.ok, true, same.message);
  const ks = f.notes(f.keys);
  assert.equal(new Set(ks.map((n) => n.tick)).size, ks.length, 'one note at a time: the block chords are gone');
  for (const n of ks) assert.ok(CHORD_PCS[Math.floor(n.tick / BAR)].includes(pc(n.key)));
  assert.deepEqual(arpCycle([60, 64, 67, 72], 'converge'), [60, 72, 64, 67]);
});

test('bass sits on chord tones (root, fifth, octave) and an 808 line glides', () => {
  const f = fresh();
  writeChords(f, f.keys);
  for (const style of ['root', 'rootFifth', 'octave'] as const) {
    for (const rhythm of ['quarters', 'tresillo', 'trap', 'funk'] as const) {
      const r = f.exec('notes.generate', { channelId: f.bass, kind: 'bass', options: { style, rhythm, passing: 0 }, seed: 11 });
      assert.equal(r.ok, true, r.message);
      const ns = f.notes(f.bass);
      for (const n of ns) assert.ok(CHORD_PCS[Math.floor(n.tick / BAR)].includes(pc(n.key)), `${style}/${rhythm}: ${n.key} at ${n.tick}`);
      for (let b = 0; b < 4; b++) assert.equal(pc(ns.find((n) => n.tick === b * BAR)!.key), [9, 5, 0, 7][b], `${style}: the root on the downbeat of bar ${b + 1}`);
      assert.ok(ns.every((n) => n.key >= 24 && n.key <= 60), 'bass register');
    }
  }
  const walk = f.exec('notes.generate', { channelId: f.bass, kind: 'bass', options: { style: 'walking' }, seed: 2 });
  assert.equal(walk.ok, true);
  assert.equal(f.notes(f.bass).length, 16, 'walking: quarter notes');
  let slides = 0;
  for (let seed = 1; seed <= 8; seed++) {
    f.exec('notes.generate', { channelId: f.bass, kind: 'bass', options: { style: 'glide808', octave: 1 }, seed });
    slides += f.notes(f.bass).filter((n) => n.slide).length;
  }
  assert.ok(slides > 0, '808 glides set the slide flag');
});

test('melody lands on chord tones on strong beats when the pattern has chords', () => {
  const f = fresh();
  writeChords(f, f.keys);
  let strong = 0;
  let hits = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = f.exec('notes.generate', { channelId: f.bass, kind: 'melody', options: { chordTones: 1, feel: '8ths' }, seed });
    assert.equal(r.ok, true, r.message);
    for (const n of f.notes(f.bass)) {
      if (n.tick % 960 !== 0) continue;
      strong++;
      if (CHORD_PCS[Math.floor(n.tick / BAR)].includes(pc(n.key))) hits++;
    }
  }
  assert.ok(hits / strong > 0.85, `chord tones on ${hits}/${strong} strong beats`);
});

// ── The command ───────────────────────────────────────────────────────

test('notes.generate: one undo step, bar range, replace vs merge, selection, key from the pattern', () => {
  const f = fresh();
  const seedNotes = [{ tick: 0, key: 60, dur: 240 }, { tick: BAR, key: 62, dur: 240 }, { tick: 2 * BAR + 480, key: 64, dur: 240 }];
  assert.equal(f.exec('notes.replace', { channelId: f.hat, notes: seedNotes }).ok, true);
  const before = f.notes(f.hat).map((n) => n.id);
  const hist = f.host.getHistory().length;
  const r = f.exec<{ ids: string[]; removed: number; range: { fromBar: number; bars: number } }>('notes.generate', { channelId: f.hat, kind: 'rhythm', options: { steps: 16, pulses: 4 }, range: { fromBar: 2, bars: 1 } });
  assert.equal(r.ok, true, r.message);
  assert.equal(f.host.getHistory().length, hist + 1, 'one history entry');
  assert.equal(r.data!.removed, 1, 'replace removes the channel notes in bar 2 only');
  assert.deepEqual(r.data!.range, { fromBar: 2, bars: 1 });
  const after = f.notes(f.hat);
  assert.ok(after.some((n) => n.tick === 0) && after.some((n) => n.tick === 2 * BAR + 480), 'notes outside the range stay');
  assert.deepEqual(after.filter((n) => n.tick >= BAR && n.tick < 2 * BAR).map((n) => n.tick), [BAR, BAR + 960, BAR + 1920, BAR + 2880]);
  assert.equal(f.host.undo(USER).ok, true);
  assert.deepEqual(f.notes(f.hat).map((n) => n.id).sort(), [...before].sort(), 'one undo restores the channel');

  // merge keeps everything; identical notes are not stacked
  const m = f.exec<{ skipped: number }>('notes.generate', { channelId: f.hat, kind: 'rhythm', options: { steps: 4, pulses: 4, rate: '4th', note: 60 }, range: { fromBar: 1, bars: 1 }, mode: 'merge' });
  assert.equal(m.ok, true, m.message);
  assert.equal(m.data!.skipped, 1, 'the existing C4 on beat 1 is not doubled');
  assert.equal(f.notes(f.hat).length, 3 + 3);
  f.host.undo(USER);

  // selection: replaces just the selected notes, range = their bars
  const sel = f.notes(f.hat).filter((n) => n.tick >= 2 * BAR).map((n) => n.id);
  const s = f.exec<{ removed: number; range: { fromBar: number } }>('notes.generate', { channelId: f.hat, kind: 'melody', ids: sel, seed: 3 });
  assert.equal(s.ok, true, s.message);
  assert.equal(s.data!.removed, 1);
  assert.equal(s.data!.range.fromBar, 3);
  assert.ok(f.notes(f.hat).filter((n) => n.tick >= 2 * BAR).every((n) => n.tick < 3 * BAR), 'stays inside bar 3');

  // key: given > the pattern's notes > the project > A minor
  writeChords(f, f.keys);
  const guessed = guessKey(f.host.project, f.pat);
  assert.equal(guessed.source, 'pattern');
  assert.ok(['A minor', 'C major'].includes(guessed.name), `Am F C G reads as A minor / C major (same notes), got ${guessed.name}`);
  const fresh2 = fresh();
  assert.equal(guessKey(fresh2.host.project, fresh2.pat).source, 'default');
  const k = f.exec<{ key: string; keySource: string }>('notes.generate', { channelId: f.bass, kind: 'melody', key: { root: 2, scale: 'dorian' } });
  assert.equal(k.data!.key, 'D dorian');
  assert.equal(k.data!.keySource, 'given');
});

test('notes.generate: human errors, nothing written', () => {
  const f = fresh();
  const v = f.host.version;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ channelId: f.keys, kind: 'arp', options: { chords: 'pattern' } }, /No chords to follow/],
    [{ channelId: f.keys, kind: 'melody', options: { contur: 'arch' } }, /Unknown melody option "contur"/],
    [{ channelId: f.keys, kind: 'chords', options: { progression: 'I IV XI' } }, /"XI" is not a chord numeral/],
    [{ channelId: f.keys, kind: 'rhythm', options: { pulses: 0 } }, /wrote no notes.*raise the pulses/],
    [{ channelId: f.keys, kind: 'melody', key: { root: 0, scale: 'klingon' } }, /Unknown scale "klingon"/],
    [{ channelId: 'ch_nope', kind: 'melody' }, /Channel ch_nope not found/],
    [{ channelId: f.keys, kind: 'melody', ids: ['n_nope'] }, /Note n_nope not found/],
  ];
  for (const [args, re] of cases) {
    const r = f.exec('notes.generate', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.message ?? '', re);
  }
  assert.equal(f.host.version, v, 'failed generates change nothing');
  // a fixed-length pattern grows to fit the range
  f.host.exec('patterns.set', { id: f.pat, length: BAR }, { actor: USER });
  const g = f.exec<{ extendedTo: number }>('notes.generate', { channelId: f.keys, kind: 'chords', range: { fromBar: 1, bars: 2 } });
  assert.equal(g.ok, true, g.message);
  assert.equal(f.host.project.patterns[f.pat].length, 2 * BAR);
});

test('planGenerate is pure and matches what the command writes (the dialog preview / Variations)', () => {
  const f = fresh();
  writeChords(f, f.keys);
  const args = GENERATE_ARGS.parse({ patternId: f.pat, channelId: f.bass, kind: 'bass', seed: 42 });
  const v = f.host.version;
  const plan = planGenerate(f.host.project, args);
  assert.equal(f.host.version, v);
  f.exec('notes.generate', { channelId: f.bass, kind: 'bass', seed: 42 });
  assert.deepEqual(f.notes(f.bass).map((n) => [n.tick, n.key, n.dur, n.vel]), plan.notes.map((n) => [n.tick, n.key, n.dur, n.vel]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});

await run('generate');
