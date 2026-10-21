// Krypt Voice planning (pure): the English syllabifier and lyric markup
// (shared/voice/syllables.ts), "Sing my notes" planning (shared/voice/
// singplan.ts: melody, syllable ↔ note mapping, spans, segments), the WAV
// joiner (electron/voice/wav.ts) and the Fish helpers that are pure
// (consent-line check, human error sentences).
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { countSyllables, parseLyrics, syllabifyWord } from '@shared/voice/syllables';
import { buildSegments, equalSpans, fitSpans, mapSyllables, mappingRows, melodyFromNotes, patternBarRange, wordSpans, type MelodyNote } from '@shared/voice/singplan';
import { CONSENT_LINE } from '@shared/voice/types';
import { concatWav, parseWav, silentWav } from '../electron/voice/wav';
import { consentHeard, fishErrorMessage } from '../electron/voice/fish';

// ── Syllabifier ─────────────────────────────────────────────────────────

test('syllabifyWord: common song words split where singers split them', () => {
  const cases: Record<string, string> = {
    love: 'love',
    fire: 'fire',
    tired: 'tired',
    beautiful: 'beau-ti-ful',
    table: 'ta-ble',
    little: 'lit-tle',
    candle: 'can-dle',
    hello: 'hel-lo',
    baby: 'ba-by',
    happy: 'hap-py',
    sister: 'sis-ter',
    thinking: 'think-ing',
    singing: 'sing-ing',
    nation: 'na-tion',
    special: 'spe-cial',
    precious: 'pre-cious',
    glorious: 'glo-ri-ous',
    lion: 'li-on',
    piano: 'pi-a-no',
    radio: 'ra-di-o',
    flying: 'fly-ing',
    language: 'lan-guage',
    guitar: 'gui-tar',
    darkness: 'dark-ness',
    remember: 're-mem-ber',
    tomorrow: 'to-mor-row',
    butterfly: 'but-ter-fly',
    people: 'peo-ple',
    every: 'ev-ery',
    going: 'go-ing',
    rhythm: 'rhythm',
    "don't": "don't",
    world: 'world',
    the: 'the',
  };
  for (const [w, want] of Object.entries(cases)) assert.equal(syllabifyWord(w).join('-'), want, w);
});

test('syllabifyWord: silent final e / -es / -ed, but heard after sibilants and t / d', () => {
  for (const [w, n] of [['makes', 1], ['times', 1], ['boxes', 2], ['changes', 2], ['places', 2], ['loved', 1], ['played', 1], ['wanted', 2], ['needed', 2], ['tables', 2], ['me', 1], ['league', 1]] as const) {
    assert.equal(countSyllables(w), n, w);
  }
});

test('syllabifyWord keeps the original letters and case', () => {
  assert.deepEqual(syllabifyWord('Beautiful'), ['Beau', 'ti', 'ful']);
  assert.deepEqual(syllabifyWord('PEOPLE'), ['PEO', 'PLE']);
  assert.equal(syllabifyWord('Hello').join(''), 'Hello');
  assert.deepEqual(syllabifyWord('2'), ['2'], 'a number is one sung unit');
});

// ── Lyric markup ────────────────────────────────────────────────────────

test('parseLyrics: "-" splits exactly, "_" holds, lines, spoken text keeps punctuation', () => {
  const p = parseLyrics('Hel-lo, my baby_ _\nI love you__ so / beau_ti-ful');
  assert.equal(p.lines.length, 3);
  assert.equal(p.lines[0].text, 'Hello, my baby');
  assert.deepEqual(p.lines[0].words, ['Hello', 'my', 'baby']);
  assert.deepEqual(p.lines[0].syllables.map((s) => s.text), ['Hel', 'lo', 'my', 'ba', 'by']);
  assert.equal(p.lines[0].syllables[4].hold, 2, 'baby_ plus a lone "_"');
  assert.equal(p.lines[1].syllables.find((s) => s.text === 'you')!.hold, 2);
  assert.equal(p.lines[2].text, 'beautiful', 'markup never reaches the spoken text');
  assert.deepEqual(p.lines[2].syllables.map((s) => [s.text, s.hold]), [['beau', 1], ['ti', 0], ['ful', 0]], '"_" inside a word = split + hold');
  assert.deepEqual(p.syllables.map((s) => s.line), [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
  const by = p.syllables[4];
  assert.equal(by.word, 'baby');
  assert.equal(by.wordInLine, 2);
  assert.ok(!by.wordStart && by.wordEnd);
});

test('parseLyrics: punctuation-only tokens and blank lines vanish; a leading "_" is reported', () => {
  const p = parseLyrics('_ oh!\n\n  ... \n(yeah) — ok?');
  assert.deepEqual(p.syllables.map((s) => s.text), ['oh', 'yeah', 'ok']);
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines[1].text, '(yeah) — ok?'.replace(' —', ''), 'a dash token is not a word');
  assert.match(p.notes.join(' '), /holds nothing/);
  assert.deepEqual(parseLyrics('').syllables, []);
});

// ── Melody ──────────────────────────────────────────────────────────────

test('melodyFromNotes: the highest note of a chord, overlaps trimmed, muted notes skipped, a bar range clipped', () => {
  const m = melodyFromNotes([
    { tick: 0, dur: 960, key: 60 },
    { tick: 0, dur: 960, key: 64 },
    { tick: 0, dur: 960, key: 67 }, // chord → 67
    { tick: 960, dur: 1920, key: 62 },
    { tick: 1920, dur: 960, key: 69 }, // higher: cuts the held 62 at 1920
    { tick: 2400, dur: 960, key: 55 }, // lower under the 69 (ends 2880): sounds from 2880
    { tick: 4000, dur: 480, key: 70, mute: true },
  ]);
  assert.deepEqual(m, [
    { tick: 0, dur: 960, key: 67 },
    { tick: 960, dur: 960, key: 62 },
    { tick: 1920, dur: 960, key: 69 },
    { tick: 2880, dur: 480, key: 55 },
  ]);
  const short = melodyFromNotes([{ tick: 0, dur: 960, key: 72 }, { tick: 100, dur: 900, key: 60 }]);
  assert.deepEqual(short, [{ tick: 0, dur: 960, key: 72 }], 'a lower note left with a sliver after the held one is dropped');
  const ranged = melodyFromNotes([{ tick: 0, dur: 960, key: 60 }, { tick: 3840, dur: 7680, key: 62 }, { tick: 8000, dur: 100, key: 64 }], { start: 3840, end: 7680 });
  assert.deepEqual(ranged, [{ tick: 3840, dur: 3840, key: 62 }], 'starts inside the range, clipped at its end');
});

// ── Mapping ─────────────────────────────────────────────────────────────

const syl = (...xs: Array<string | [string, number]>) => xs.map((x) => (typeof x === 'string' ? { text: x, hold: 0 } : { text: x[0], hold: x[1] }));

test('mapSyllables: one per note, holds take notes, extra notes extend the last syllable', () => {
  const a = mapSyllables(syl('a', 'b', 'c'), 3);
  assert.deepEqual(a.groups, [{ syllables: [0], notes: [0] }, { syllables: [1], notes: [1] }, { syllables: [2], notes: [2] }]);
  assert.deepEqual(a.notes, []);
  const held = mapSyllables(syl(['love', 2], 'you'), 4);
  assert.deepEqual(held.groups, [{ syllables: [0], notes: [0, 1, 2] }, { syllables: [1], notes: [3] }]);
  const extra = mapSyllables(syl('hey', 'you'), 5);
  assert.deepEqual(extra.groups[1], { syllables: [1], notes: [1, 2, 3, 4] });
  assert.equal(extra.extraNotes, 3);
  assert.match(extra.notes[0], /3 more notes than syllables: "you" is held over the last 4 notes/);
});

test('mapSyllables: extra syllables squeeze onto the last note; a hold past the end is cut', () => {
  const m = mapSyllables(syl('one', 'two', 'three', 'four'), 2);
  assert.deepEqual(m.groups, [{ syllables: [0], notes: [0] }, { syllables: [1, 2, 3], notes: [1] }]);
  assert.equal(m.extraSyllables, 2);
  assert.match(m.notes[0], /2 more syllables than notes: the last note sings "two three four" together/);
  const cut = mapSyllables(syl('a', ['b', 5]), 3);
  assert.deepEqual(cut.groups[1].notes, [1, 2]);
  assert.match(cut.notes.join(' '), /cut short/);
  assert.deepEqual(mapSyllables(syl('a'), 0).groups, []);
});

// ── Spans ───────────────────────────────────────────────────────────────

test('equalSpans / fitSpans: exactly the expected count, merged or split, sorted', () => {
  assert.deepEqual(equalSpans(2, 0, 1), [{ startSec: 0, endSec: 0.5 }, { startSec: 0.5, endSec: 1 }]);
  const detected = [{ startSec: 0.5, endSec: 0.6 }, { startSec: 0, endSec: 0.2 }, { startSec: 0.62, endSec: 0.7 }, { startSec: 1, endSec: 1.4 }];
  const merged = fitSpans(detected, 3);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((s) => s.startSec), [0, 0.5, 1], 'the closest neighbours (0.5 / 0.62) merged');
  const split = fitSpans([{ startSec: 0, endSec: 1 }], 2);
  assert.deepEqual(split, [{ startSec: 0, endSec: 0.5 }, { startSec: 0.5, endSec: 1 }]);
  assert.deepEqual(fitSpans([], 3), []);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i].startSec >= merged[i - 1].endSec - 1e-9, 'no overlap');
});

test('wordSpans: each word\'s timing split over its syllables by letters; a word-count mismatch gives null', () => {
  const line = parseLyrics('hello world').lines[0];
  const spans = wordSpans(line.syllables, line.words, [
    { text: 'hello', startSec: 0, endSec: 1 },
    { text: ',', startSec: 1, endSec: 1.05 },
    { text: 'world', startSec: 1.1, endSec: 1.6 },
  ]);
  assert.ok(spans);
  assert.deepEqual(spans!.map((s) => Math.round(s.startSec * 100) / 100), [0, 0.6, 1.1], 'hel (3 letters) / lo (2)');
  assert.equal(wordSpans(line.syllables, line.words, [{ text: 'hello', startSec: 0, endSec: 1 }]), null);
});

// ── Segments ────────────────────────────────────────────────────────────

test('buildSegments: notes → seconds at the project tempo, octave shift, held syllables split over their notes', () => {
  const melody: MelodyNote[] = [
    { tick: 960, dur: 960, key: 60 },
    { tick: 1920, dur: 480, key: 62 },
    { tick: 2400, dur: 1440, key: 64 },
  ];
  const groups = [{ syllables: [0], notes: [0] }, { syllables: [1], notes: [1, 2] }];
  const spans = [{ startSec: 0, endSec: 0.3 }, { startSec: 0.3, endSec: 0.7 }];
  const segs = buildSegments(groups, melody, spans, { bpm: 120, originTick: 960, octave: -1 });
  assert.deepEqual(segs, [
    { srcStartSec: 0, srcEndSec: 0.3, outStartSec: 0, durSec: 0.5, midi: 48 },
    { srcStartSec: 0.3, srcEndSec: 0.4, outStartSec: 0.5, durSec: 0.25, midi: 50 },
    { srcStartSec: 0.4, srcEndSec: 0.7, outStartSec: 0.75, durSec: 0.75, midi: 52 },
  ]);
  const merged = buildSegments([{ syllables: [0, 1], notes: [0] }], melody, spans, { bpm: 60, originTick: 0 });
  assert.deepEqual(merged, [{ srcStartSec: 0, srcEndSec: 0.7, outStartSec: 1, durSec: 1, midi: 60 }], 'squeezed syllables share one note');
  assert.equal(buildSegments(groups, melody, spans, { bpm: 120, originTick: 960, octave: 9 })[0].midi, 84, 'octave clamped to ±2');
});

test('mappingRows: one row per note, held notes show "_"; patternBarRange parses bars', () => {
  const melody: MelodyNote[] = [{ tick: 0, dur: 960, key: 60 }, { tick: 960, dur: 960, key: 62 }];
  assert.deepEqual(mappingRows([{ syllables: [0], notes: [0, 1] }], melody, [{ text: 'oh' }]), [
    { syllable: 'oh', noteTick: 0, key: 60 },
    { syllable: '_', noteTick: 960, key: 62 },
  ]);
  assert.deepEqual(patternBarRange('2-3', 3840), { start: 3840, end: 11520 });
  assert.deepEqual(patternBarRange('4', 3840), { start: 11520, end: 15360 });
  assert.equal(patternBarRange(undefined, 3840), null);
  assert.ok('error' in (patternBarRange('3-1', 3840) as object));
  assert.ok('error' in (patternBarRange('x', 3840) as object));
});

// ── WAV ─────────────────────────────────────────────────────────────────

test('wav: parse, join with silence (offsets), streamed sizes, mismatched formats refused', () => {
  const a = silentWav(1, 24000);
  const b = silentWav(0.5, 24000);
  const pa = parseWav(a);
  assert.ok(!('error' in pa));
  assert.equal((pa as { durationSec: number }).durationSec, 1);
  const j = concatWav([a, b], 0.25);
  assert.ok(!('error' in j));
  const jj = j as { bytes: Buffer; offsets: number[]; durationSec: number };
  assert.deepEqual(jj.offsets, [0, 1.25]);
  assert.equal(jj.durationSec, 1.75);
  assert.equal((parseWav(jj.bytes) as { durationSec: number }).durationSec, 1.75);
  const streamed = Buffer.from(b);
  streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal((parseWav(streamed) as { durationSec: number }).durationSec, 0.5, 'a streamed WAV reads to its end');
  assert.ok('error' in concatWav([a, silentWav(1, 44100)]));
  assert.ok('error' in parseWav(new Uint8Array(10)));
});

// ── Fish helpers ────────────────────────────────────────────────────────

test('consentHeard: the consent line (with ASR slips) at the start, not something else', () => {
  assert.ok(consentHeard(`${CONSENT_LINE} Here is some more of me talking.`));
  assert.ok(consentHeard('I am recording my own voice and I agree to have it turned into a AI voice for my own musik. Hello there'));
  assert.ok(!consentHeard('This is a song by somebody famous, yeah yeah.'));
  assert.ok(!consentHeard(''));
});

test('fishErrorMessage: human sentences for a bad key, no credit, the free tier ending, rate limits and outages', () => {
  assert.match(fishErrorMessage(401, '{"status":401,"message":"Invalid token"}', 'speech'), /didn't accept your API key.*Settings ▸ Voice/);
  assert.match(fishErrorMessage(402, '{"status":402,"message":"Insufficient balance"}', 'speech'), /no credit left.*free developer tier.*Local voice/);
  assert.match(fishErrorMessage(403, '{"message":"The free tier has ended"}', 'speech'), /free developer tier \(s2\.1-pro-free\) has ended/);
  assert.match(fishErrorMessage(429, '', 'speech'), /rate-limiting/);
  assert.match(fishErrorMessage(503, '<html>busy</html>', 'speech'), /busy or down right now \(HTTP 503\)/);
  assert.doesNotMatch(fishErrorMessage(400, '{"message":"‮bad\u0007"}', 'speech'), /[‮\u0007]/, 'control / bidi characters stripped');
});

void run('voice-plan');
