import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import type { MashupPlanSummary } from '@shared/mashup/types';
import {
  DEFAULT_FORM,
  barFraction,
  buildRequest,
  clipSlot,
  doneToast,
  failureMessage,
  fileSlot,
  fmtShift,
  fmtSt,
  formError,
  formReducer,
  libraryTrackCount,
  needsStemModel,
  NOT_AVAILABLE,
  patchChanges,
  percentText,
  planLine,
  requestKey,
  ringDash,
  sameSource,
  scoreTone,
  shiftLabel,
  songRole,
  sourceOf,
  stageStates,
  stretchAudible,
  suggestionPatch,
  tempoChips,
  timelineLayout,
  usesSongs,
  vocalLabel,
  type MashupForm,
} from '../src/mashup/logic';
import { HOME_ACTION_IDS } from '../src/home/logic';
import { GUIDE_ANCHORS } from '../src/guides/anchors';
import { articleById } from '../src/guides/articles';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const ROOT = repoRoot();
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const A = fileSlot('C:\\Music\\Midnight City.mp3');
const B = clipSlot('clip-7', 'Instrumental', 'Track 2 · bar 1');
const both = (patch: Partial<MashupForm> = {}): MashupForm => ({ ...DEFAULT_FORM, stems: { ...DEFAULT_FORM.stems }, a: A, b: B, ...patch });

const PLAN: MashupPlanSummary = {
  style: 'vocalOverBeat',
  vocalFrom: 'a',
  bpm: 124,
  key: 'F minor',
  shiftA: { stretch: 1.04, semitones: 2 },
  shiftB: { stretch: 1, semitones: 0 },
  sections: [
    { name: 'Intro', startBar: 0, bars: 8, uses: 'B beat' },
    { name: 'Verse', startBar: 8, bars: 16, uses: 'A vocal + B beat' },
    { name: 'Chorus', startBar: 24, bars: 16, uses: 'A vocal + B beat' },
    { name: 'Outro', startBar: 40, bars: 8, uses: 'B beat' },
  ],
  bars: 48,
};

test('slots: file / clip / library map to a MashupSource; names and sameness', () => {
  assert.equal(A.name, 'Midnight City');
  assert.equal(A.kind, 'file');
  assert.deepEqual(sourceOf(A), { path: 'C:\\Music\\Midnight City.mp3' });
  assert.deepEqual(sourceOf(B), { clipId: 'clip-7' });
  const lib = fileSlot('D:\\Refs\\song.wav', 'library', 'My song');
  assert.equal(lib.name, 'My song');
  assert.equal(lib.detail, 'Reference library');
  assert.deepEqual(sourceOf(lib), { path: 'D:\\Refs\\song.wav' });
  assert.equal(sameSource(A, fileSlot('c:\\music\\midnight city.mp3')), true, 'paths compare case-insensitively');
  assert.equal(sameSource(B, clipSlot('clip-7', 'x')), true);
  assert.equal(sameSource(A, B), false);
  assert.equal(sameSource(A, null), false);
});

test('reducer: setting a slot resets its tempo reading; swap flips songs, factors, vocalFrom and the stem grid', () => {
  let f = formReducer(both({ factorA: 0.5, factorB: 2, vocalFrom: 'a' }), { type: 'setSlot', song: 'a', slot: fileSlot('C:\\x.wav') });
  assert.equal(f.factorA, 1);
  assert.equal(f.factorB, 2, 'the other song keeps its reading');
  f = formReducer(both({ factorA: 0.5, factorB: 2, vocalFrom: 'a', stems: { vocals: 'a', drums: 'b', bass: null, other: 'b' } }), { type: 'swap' });
  assert.equal(f.a, B);
  assert.equal(f.b, A);
  assert.equal(f.factorA, 2);
  assert.equal(f.factorB, 0.5);
  assert.equal(f.vocalFrom, 'b');
  assert.deepEqual(f.stems, { vocals: 'b', drums: 'a', bass: null, other: 'a' });
  assert.equal(formReducer(both({ vocalFrom: 'auto' }), { type: 'swap' }).vocalFrom, 'auto');
});

test('reducer: options, the stem grid, bars clamped, reset', () => {
  let f = formReducer(both(), { type: 'set', patch: { style: 'stemBlend', anchor: 'middle', tune: 'hard', bars: 500 } });
  assert.equal(f.style, 'stemBlend');
  assert.equal(f.anchor, 'middle');
  assert.equal(f.tune, 'hard');
  assert.equal(f.bars, 128);
  assert.equal(formReducer(f, { type: 'set', patch: { bars: 3 } }).bars, 8);
  assert.equal(formReducer(f, { type: 'set', patch: { bars: null } }).bars, null);
  f = formReducer(f, { type: 'setStem', stem: 'bass', pick: null });
  assert.equal(f.stems.bass, null);
  assert.equal(DEFAULT_FORM.stems.bass, 'b', 'the default grid is never mutated');
  const r = formReducer(f, { type: 'reset' });
  assert.equal(r.a, null);
  assert.equal(r.style, 'vocalOverBeat');
  assert.deepEqual(r.stems, { vocals: 'a', drums: 'b', bass: 'b', other: 'b' });
});

test('formError: songs first, then different songs, then the stem grid', () => {
  assert.equal(formError(DEFAULT_FORM), 'Pick two songs');
  assert.equal(formError({ ...DEFAULT_FORM, b: B }), 'Pick song A');
  assert.equal(formError({ ...DEFAULT_FORM, a: A }), 'Pick song B');
  assert.equal(formError(both({ b: fileSlot(A.path!) })), 'Pick two different songs');
  assert.equal(formError(both()), null);
  assert.match(formError(both({ style: 'stemBlend', stems: { vocals: null, drums: null, bass: null, other: null } }))!, /at least one stem/);
  assert.match(formError(both({ style: 'stemBlend', stems: { vocals: 'a', drums: 'a', bass: null, other: 'a' } }))!, /each song/);
  assert.equal(formError(both({ style: 'stemBlend' })), null);
  assert.equal(formError(both({ style: 'backAndForth', stems: { vocals: null, drums: null, bass: null, other: null } })), null, 'the grid only matters for Stem blend');
});

test('buildRequest: only the fields the style uses; factors and bars only when set', () => {
  assert.equal(buildRequest(DEFAULT_FORM), null);
  assert.deepEqual(buildRequest(both()), {
    a: { path: 'C:\\Music\\Midnight City.mp3' },
    b: { clipId: 'clip-7' },
    style: 'vocalOverBeat',
    newProject: true,
    transitions: true,
    vocalFrom: 'auto',
    tune: 'natural',
  });
  assert.equal(buildRequest(both({ anchor: 'beat' }))!.anchor, 'beat', 'an anchor picked is sent; Auto sends none');
  const blend = buildRequest(both({ style: 'stemBlend', factorB: 0.5, bars: 64, newProject: false }))!;
  assert.deepEqual(blend.stems, { vocals: 'a', drums: 'b', bass: 'b', other: 'b' });
  assert.equal(blend.vocalFrom, undefined);
  assert.equal(blend.factorA, undefined);
  assert.equal(blend.factorB, 0.5);
  assert.equal(blend.bars, 64);
  assert.equal(blend.newProject, false);
  const bf = buildRequest(both({ style: 'backAndForth', transitions: false }))!;
  assert.equal(bf.tune, undefined, 'no Krypt Tune on two full songs');
  assert.equal(bf.stems, undefined);
  assert.equal(bf.transitions, false);
});

test('requestKey: stable, and changes with anything check / build would see', () => {
  const k = requestKey(buildRequest(both()));
  assert.ok(k);
  assert.equal(requestKey(buildRequest(both())), k);
  assert.notEqual(requestKey(buildRequest(both({ tune: 'pop' }))), k);
  assert.notEqual(requestKey(buildRequest(both({ factorA: 2 }))), k);
  const g1 = requestKey(buildRequest(both({ style: 'stemBlend' })));
  const g2 = requestKey(buildRequest(both({ style: 'stemBlend', stems: { vocals: 'a', drums: 'b', bass: 'a', other: 'b' } })));
  assert.notEqual(g1, g2);
  assert.equal(requestKey(null), null);
});

test('tempo chips: detected + half / double alternatives, sorted, the active factor marked', () => {
  const chips = tempoChips({ bpm: 96, bpmAlternatives: [48, 192] }, 1);
  assert.deepEqual(
    chips.map((c) => [c.label, c.factor, c.active]),
    [
      ['48', 0.5, false],
      ['96', 1, true],
      ['192', 2, false],
    ],
  );
  assert.equal(tempoChips({ bpm: 96, bpmAlternatives: [48] }, 0.5).find((c) => c.active)?.label, '48');
  assert.deepEqual(
    tempoChips({ bpm: 140, bpmAlternatives: [93.3] }, 1).map((c) => c.factor),
    [1],
    'a 2:3 reading is not a half / double chip',
  );
  const kept = tempoChips({ bpm: 120, bpmAlternatives: [] }, 2);
  assert.deepEqual(
    kept.map((c) => [c.label, c.active]),
    [
      ['120', false],
      ['240', true],
    ],
    'a chosen factor the analyzer no longer offers still shows',
  );
  assert.deepEqual(tempoChips({ bpm: null, bpmAlternatives: [] }, 1), []);
  assert.equal(tempoChips({ bpm: 127.94, bpmAlternatives: [] }, 1)[0].label, '127.9');
});

test('score tone, ring geometry, vocal labels', () => {
  assert.equal(scoreTone(85), 'good');
  assert.equal(scoreTone(70), 'good');
  assert.equal(scoreTone(50), 'ok');
  assert.equal(scoreTone(10), 'poor');
  const r = ringDash(25, 10);
  const c = 2 * Math.PI * 10;
  assert.ok(Math.abs(r.dash - c / 4) < 1e-9);
  assert.ok(Math.abs(r.dash + r.gap - c) < 1e-9);
  assert.equal(ringDash(150, 10).gap, 0);
  assert.equal(ringDash(NaN, 10).dash, 0);
  assert.match(vocalLabel(0.7), /most/);
  assert.match(vocalLabel(0.2), /Some/);
  assert.match(vocalLabel(0.02), /Instrumental/);
});

test('shifts: "+2 st, ×1.04", roles per style, audible stretch', () => {
  assert.equal(fmtSt(2), '+2 st');
  assert.equal(fmtSt(-1.5), '−1.5 st');
  assert.equal(fmtShift({ stretch: 1.04, semitones: 2 }), '+2 st, ×1.04');
  assert.equal(fmtShift({ stretch: 1, semitones: 0 }), '');
  assert.equal(fmtShift({ stretch: 0.98, semitones: 0 }), '×0.98');
  assert.equal(songRole(PLAN, 'a'), 'vocal');
  assert.equal(songRole(PLAN, 'b'), 'beat');
  assert.equal(songRole({ style: 'stemBlend', vocalFrom: null }, 'b', { vocals: 'a', drums: 'b', bass: 'b', other: null }), 'drums + bass');
  assert.equal(songRole({ style: 'backAndForth', vocalFrom: null }, 'a'), 'song A');
  assert.equal(shiftLabel(PLAN, 'a'), 'vocal +2 st, ×1.04');
  assert.equal(shiftLabel(PLAN, 'b'), '');
  assert.equal(stretchAudible(1.1), false);
  assert.equal(stretchAudible(1.25), true);
  assert.equal(stretchAudible(0.8), true);
  assert.equal(planLine(PLAN), '124 BPM · F minor · 48 bars');
});

test('timeline: blocks placed by bar, toned by the songs they use, labelled with the shifts', () => {
  assert.deepEqual(usesSongs('A vocal + B beat'), { a: true, b: true });
  assert.deepEqual(usesSongs('B (drop)'), { a: false, b: true });
  assert.deepEqual(usesSongs('Both songs'), { a: true, b: true });
  assert.deepEqual(usesSongs('A beautiful intro'), { a: true, b: false }, 'a capital A word counts: planners write A / B as words');
  const t = timelineLayout(PLAN);
  assert.equal(t.total, 48);
  assert.equal(t.blocks.length, 4);
  assert.deepEqual(
    t.blocks.map((b) => [b.name, b.tone, +(b.left * 48).toFixed(3), +(b.width * 48).toFixed(3)]),
    [
      ['Intro', 'b', 0, 8],
      ['Verse', 'both', 8, 16],
      ['Chorus', 'both', 24, 16],
      ['Outro', 'b', 40, 8],
    ],
  );
  assert.equal(t.blocks[1].shift, 'vocal +2 st, ×1.04');
  assert.equal(t.blocks[0].shift, '', 'B is untouched');
  assert.deepEqual(t.ticks, [0, 16, 32, 48]);
  const t2 = timelineLayout({ ...PLAN, bars: 0, sections: [...PLAN.sections, { name: 'Tag', startBar: 48, bars: 16, uses: 'A' }, { name: 'Nothing', startBar: 64, bars: 0, uses: 'B' }] });
  assert.equal(t2.total, 64);
  assert.equal(t2.blocks.length, 5);
  assert.ok(t2.blocks.every((b) => b.left + b.width <= 1 + 1e-9));
  const names = { a: 'Midnight City (Extended Club Mix)', b: 'Nightcall' };
  const t3 = timelineLayout(
    {
      ...PLAN,
      sections: [
        { name: 'Intro', startBar: 1, bars: 8, uses: 'Nightcall instrumental' },
        { name: 'Chorus 1', startBar: 9, bars: 16, uses: 'Nightcall instrumental + Midnight City (Extended… vocal (Chorus)' },
        { name: 'Outro', startBar: 25, bars: 8, uses: 'Midnight City (Extended… (full mix, from its bar 97)' },
      ],
      bars: 32,
    },
    undefined,
    names,
  );
  assert.equal(t3.total, 32);
  assert.deepEqual(
    t3.blocks.map((b) => [b.firstBar, b.tone, +(b.left * 32).toFixed(3)]),
    [
      [1, 'b', 0],
      [9, 'both', 8],
      [25, 'a', 24],
    ],
  );
  assert.equal(t3.blocks[1].shift, 'vocal +2 st, ×1.04');
  assert.deepEqual(usesSongs('Nightcall instrumental', names), { a: false, b: true });
});

test('suggestions → options: tempo readings, vocal direction, anchor, style, tune, length, transitions', () => {
  assert.deepEqual(suggestionPatch('Use B at half time: stretch ×1.02 instead of ×0.51'), { factorB: 0.5 });
  assert.deepEqual(suggestionPatch("Read A's tempo at double time (stretch ×1.01)"), { factorA: 2 });
  assert.deepEqual(suggestionPatch('Try half time for B: ×0.98'), { factorB: 0.5 });
  assert.deepEqual(suggestionPatch('Use B as detected: stretch ×1.03 instead of ×0.52'), { factorB: 1 });
  assert.deepEqual(suggestionPatch("Take the vocal from B: it has more vocal and needs only −1 st"), { vocalFrom: 'b' });
  assert.deepEqual(suggestionPatch("Use A's vocal instead"), { vocalFrom: 'a' });
  assert.deepEqual(suggestionPatch('Meet in the middle: each song moves 1 st instead of one moving 2'), { anchor: 'middle' });
  assert.deepEqual(suggestionPatch('Keep the vocal: the beat moves less'), { anchor: 'vocal' });
  assert.deepEqual(suggestionPatch('No stem model: try Back & forth, which needs none'), { style: 'backAndForth' });
  assert.deepEqual(suggestionPatch('Try Krypt Tune off: the vocal is already in tune'), { tune: 'off' });
  assert.deepEqual(suggestionPatch('Use 64 bars: the beat has only 64 bars of material'), { bars: 64 });
  assert.deepEqual(suggestionPatch('Without transitions the hard cuts suit this pair'), { transitions: false });
  assert.deepEqual(suggestionPatch('Use A at double time: it plays ×1.02 instead of ×0.51.'), { factorA: 2 });
  assert.deepEqual(suggestionPatch('Anchor "middle": each song stretches at most ×1.09 instead of ×1.19.'), { anchor: 'middle' });
  assert.deepEqual(suggestionPatch('Take the vocal from B instead: a better fit (score 81 vs 70).'), { vocalFrom: 'b' });
  assert.deepEqual(suggestionPatch('Without a stem model, the backAndForth style still works: the two songs trade sections on one grid.'), { style: 'backAndForth' });
  assert.equal(suggestionPatch('Set the key yourself (key: "F#m") if the vocal sounds off: the key couldn\'t be read.'), null);
  assert.equal(suggestionPatch('These two songs are a great match'), null);
  assert.equal(suggestionPatch('A vocal pitched more than 3 st can sound thin'), null, 'advice without an option stays advice');
  const f = both({ factorB: 0.5 });
  assert.equal(patchChanges(f, { factorB: 0.5 }), false, 'already applied: no Apply button');
  assert.equal(patchChanges(f, { factorB: 1 }), true);
  assert.equal(patchChanges(f, null), false);
});

test('problems, stages, progress, outcome and failure messages', () => {
  assert.equal(needsStemModel('Vocal over beat needs stems: install HT-Demucs in the Model Manager'), true);
  assert.equal(needsStemModel("Couldn't read song B: unsupported file"), false);
  assert.deepEqual(stageStates('running', 'analyzing'), ['done', 'done', 'active', 'pending', 'pending', 'pending']);
  assert.deepEqual(stageStates('failed', 'building'), ['done', 'done', 'done', 'done', 'failed', 'pending']);
  assert.deepEqual(stageStates('cancelled', null), ['stopped', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.ok(stageStates('done', 'mixing').every((s) => s === 'done'));
  assert.equal(barFraction('running', null), -1);
  assert.equal(barFraction('running', { stage: 'building', fraction: 1.4, message: '' }), 1);
  assert.equal(barFraction('done', null), 1);
  assert.equal(percentText(0.374), '37 %');
  assert.equal(percentText(-1), '');
  assert.equal(doneToast({ name: 'A x B', plan: PLAN, score: 80, notes: [], tracks: 1, rightsNote: '' }), '"A x B" is ready: 124 BPM · F minor · 48 bars, 1 track');
  assert.equal(failureMessage(new Error("Error invoking remote method 'mashup:check': Error: No handler registered for 'mashup:check'")), NOT_AVAILABLE);
  assert.equal(failureMessage("Error invoking remote method 'mashup:build': Error: Song B has no beat"), 'Song B has no beat');
  assert.equal(failureMessage(''), 'The mashup failed without saying why');
  assert.equal(libraryTrackCount([{ counts: { total: 10, missing: 2, failed: 1 } }, { counts: { total: 3, missing: 0, failed: 0 } }]), 10);
  assert.equal(libraryTrackCount(null), 0);
});

test('entry points are wired: Home action, Tools command + menu, playlist clip menu, Home card', () => {
  assert.ok((HOME_ACTION_IDS as readonly string[]).includes('autoMashup'));
  assert.match(read('src/home/actions.ts'), /autoMashup:\s*\{[^}]*openMashup\(\)/);
  assert.match(read('src/app/actions.ts'), /id: 'tools\.autoMashup'[^\n]*openMashup\(/);
  assert.match(read('src/app/TitleBar.tsx'), /cmd\('tools\.autoMashup', 'Auto Mashup…'/);
  assert.match(read('src/panels/playlist/Playlist.tsx'), /label: 'Mashup with…'[^\n]*mashupWithClip\(clipId, doc\)/);
  const card = read('src/home/screens/AudioToolsScreen.tsx');
  assert.match(card, /<AutoMashupCard analyzer=\{a\} \/>/);
  assert.match(card, /runHomeAction\('autoMashup'\)/);
  assert.match(card, /openGuides\('auto-mashup'\)/);
});

test('guides: the Auto Mashup article, its anchors, and Vocals & mashups pointing to it', () => {
  const art = articleById('auto-mashup');
  assert.ok(art, 'the article exists');
  for (const id of ['home.autoMashup', 'mashup.songs', 'mashup.score', 'mashup.style', 'mashup.stems', 'mashup.options', 'mashup.plan', 'mashup.build']) {
    assert.ok(id in GUIDE_ANCHORS, `${id} is an anchor`);
    assert.ok(art!.body.includes(`[[show:${id}`), `the article shows ${id}`);
  }
  assert.match(art!.body, /auto_mashup/);
  assert.match(art!.body, /not for release/);
  assert.ok(!/auto-?tune/i.test(art!.body.replace(/auto-mashup/gi, '')), 'Krypt Tune, never Auto-Tune');
  const vocals = articleById('vocals')!;
  assert.match(vocals.body, /\[\[guide:auto-mashup\|/);
  assert.match(vocals.body, /\[\[action:autoMashup\|/);
  const show = read('src/guides/show.ts');
  assert.match(show, /'mashup\.build': openMashupForm/);
  assert.match(show, /'home\.autoMashup': \(\) => showHome\('audio'\)/);
});

void run('mashup-ui');
