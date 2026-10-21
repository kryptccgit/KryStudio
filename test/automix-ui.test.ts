// Auto Mix dialog logic (src/automix/logic.ts): the form reducer, form → AutoMixRequest / MasterFileRequest, the scope →
// bar range, song length, the Auto preset guess, the effective target, intent chips, the tone-curve geometry, the
// before / after rows, the honest A/B note, the history-entry state, progress stages, failure messages; plus the entry
// points, the mock and the guide anchors being wired.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import type { AutoMixIntent, AutoMixMeasure, AutoMixPreset } from '@shared/automix/types';
import {
  DEFAULT_FORM,
  LUFS_MAX,
  LUFS_MIN,
  NOT_AVAILABLE,
  NO_REFERENCE,
  NO_SONG,
  SAME_AS_ALBUM_SONG,
  SAME_AS_SONG,
  STAGES,
  abNote,
  autoPresetGuess,
  barFraction,
  buildMasterFileRequest,
  buildRequest,
  clampTruePeak,
  doneToast,
  effectiveTarget,
  entryState,
  failureMessage,
  fmtLufs,
  fmtNum,
  formError,
  formReducer,
  genreIdOf,
  groupChanges,
  intentChips,
  isCancelMessage,
  isNoFileMessage,
  loudnessGap,
  fmtDuration,
  masterRunBlocker,
  masterStepOf,
  masterStepStates,
  masterSteps,
  measureRows,
  modeSetsLoudness,
  modeUsesVocals,
  passOf,
  percentText,
  progressDetail,
  promptWorthUnderstanding,
  referenceClash,
  resultHeadline,
  resultWhere,
  samePath,
  scopeBars,
  smoothPath,
  songBars,
  songSummary,
  stageStates,
  tonePoints,
  toneRange,
  toneX,
  toneY,
  understoodLine,
  usableReference,
  type AutoMixForm,
  type SongPick,
} from '../src/automix/logic';
import { HOME_ACTION_IDS } from '../src/home/logic';
import { GUIDE_ANCHORS } from '../src/guides/anchors';
import { articleById } from '../src/guides/articles';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
      /* keep climbing */
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const ROOT = repoRoot();
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const flat = { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };
const preset = (id: string, name: string, targetLufs: number, genres: string[], truePeak = -1): AutoMixPreset => ({
  id,
  name,
  description: name,
  targetLufs,
  truePeak,
  tone: { ...flat, sub: 2, high: 1 },
  punch: 0.5,
  warmth: 0.5,
  brightness: 0.5,
  width: 0.5,
  vocalLevel: 1,
  vocalSpace: 0.4,
  genres,
});
const PRESETS = [preset('streaming-clean', 'Streaming Clean', -14, ['pop']), preset('balanced', 'Balanced', -11, []), preset('loud-trap', 'Loud Trap / Drill', -8, ['trap', 'drill'], -0.5), preset('club-edm', 'Club / EDM', -8, ['edm', 'house'])];
const form = (patch: Partial<AutoMixForm> = {}): AutoMixForm => ({ ...DEFAULT_FORM, ...patch });
const m = (lufs: number, truePeak: number, vocal: number | null, tone = flat): AutoMixMeasure => ({ lufs, truePeak, lra: 6, tone, correlation: 0.7, vocalVsBeat: vocal });

test('form reducer: modes, presets drop overrides, clamps, vocals, reset', () => {
  let f = formReducer(DEFAULT_FORM, { type: 'setMode', mode: 'vocals' });
  assert.equal(f.mode, 'vocals');
  f = formReducer(f, { type: 'set', patch: { targetLufs: -3, truePeak: 2, barsFrom: 0, barsTo: 12.6 } });
  assert.equal(f.targetLufs, LUFS_MAX);
  assert.equal(f.truePeak, -0.1);
  assert.equal(f.barsFrom, 1);
  assert.equal(f.barsTo, 13);
  assert.equal(formReducer(f, { type: 'set', patch: { targetLufs: -40 } }).targetLufs, LUFS_MIN);
  assert.equal(formReducer(f, { type: 'set', patch: { targetLufs: -9.3 } }).targetLufs, -9.5);
  const p = formReducer(f, { type: 'pickPreset', id: 'club-edm' });
  assert.equal(p.preset, 'club-edm');
  assert.equal(p.targetLufs, null, 'a new preset brings its own loudness');
  assert.equal(p.truePeak, null);
  assert.equal(formReducer(p, { type: 'pickPreset', id: 'club-edm' }), p, 'same preset: unchanged');
  const v = formReducer(f, { type: 'setVocals', inserts: ['ins_vox'], label: 'Lead Vox' });
  assert.deepEqual(v.vocalInserts, ['ins_vox']);
  assert.equal(v.vocalLabel, 'Lead Vox');
  const cleared = formReducer(v, { type: 'setVocals', inserts: [], label: 'x' });
  assert.equal(cleared.vocalInserts, null);
  assert.equal(cleared.vocalLabel, null);
  assert.deepEqual(formReducer(v, { type: 'reset' }), DEFAULT_FORM);
  assert.equal(clampTruePeak(NaN), -1);
});

test('form → request: loudness only where the mode sets it, vocals only where they matter, AI switch, prompt trimmed', () => {
  const f = form({ mode: 'vocals', preset: 'loud-trap', prompt: '  vocals on top  ', targetLufs: -9, truePeak: -0.5, vocalInserts: ['ins_v'], useAi: false });
  assert.deepEqual(buildRequest(f, 40), { mode: 'vocals', preset: 'loud-trap', keepUserFx: true, useAi: 'never', prompt: 'vocals on top', vocalInserts: ['ins_v'] });
  const full = buildRequest({ ...f, mode: 'full', useAi: true, keepUserFx: false }, 40);
  assert.equal(full.targetLufs, -9);
  assert.equal(full.truePeak, -0.5);
  assert.equal(full.useAi, 'auto');
  assert.equal(full.keepUserFx, false);
  assert.deepEqual(full.vocalInserts, ['ins_v']);
  const master = buildRequest({ ...f, mode: 'master' }, 40);
  assert.equal(master.vocalInserts, undefined, 'Master never touches the vocal inserts');
  assert.equal(master.targetLufs, -9);
  assert.equal(buildRequest(form(), null).prompt, undefined);
  assert.equal(buildRequest(form({ preset: '' }), null).preset, 'auto');
  assert.ok(modeUsesVocals('mix') && !modeUsesVocals('master'));
  assert.ok(modeSetsLoudness('full') && modeSetsLoudness('master') && !modeSetsLoudness('mix') && !modeSetsLoudness('vocals'));
  assert.deepEqual(buildMasterFileRequest(form({ preset: 'club-edm', prompt: ' loud ', targetLufs: -8 }), ' C:\\Music\\My Song.wav '), { path: 'C:\\Music\\My Song.wav', preset: 'club-edm', prompt: 'loud', targetLufs: -8 });
  assert.equal(buildMasterFileRequest(form(), 'C:\\a.wav', 'C:\\ref.mp3').reference, 'C:\\ref.mp3');
});

test('scope → bars, song length, form errors', () => {
  assert.equal(scopeBars(form(), 64), undefined, 'loudest part = the default range');
  assert.equal(scopeBars(form({ scope: 'song' }), 63.2), '1-64');
  assert.equal(scopeBars(form({ scope: 'song' }), null), undefined);
  assert.equal(scopeBars(form({ scope: 'bars', barsFrom: 17, barsTo: 32 }), 64), '17-32');
  assert.equal(scopeBars(form({ scope: 'bars', barsFrom: 32, barsTo: 17 }), 64), '17-32');
  assert.equal(buildRequest(form({ scope: 'bars', barsFrom: 9, barsTo: 16 }), 64).bars, '9-16');
  assert.equal(formError(form({ scope: 'bars', barsFrom: 9, barsTo: 4 })), 'The last bar must be after the first one');
  assert.equal(formError(form({ scope: 'bars', barsFrom: 9, barsTo: 4 })) !== null, true);
  assert.equal(formError(form()), null);
  const proj = (clips: Array<{ start: number; length: number }>, num = 4, den = 4) => ({ playlist: { clips: Object.fromEntries(clips.map((c, i) => [`c${i}`, c])) }, transport: { timeSig: { num, den } } });
  assert.equal(songBars(proj([])), null);
  assert.equal(songBars(proj([{ start: 0, length: 3840 * 8 }, { start: 3840 * 8, length: 100 }])), 9);
  assert.equal(songBars(proj([{ start: 0, length: 2880 * 4 }], 3, 4)), 4);
});

test('Auto guess from the genre text; effective target: you > prompt > preset > Auto guess > default', () => {
  assert.equal(genreIdOf('Trap'), 'trap');
  assert.equal(genreIdOf('uk drill'), 'drill');
  assert.equal(genreIdOf('Big Room'), 'edm');
  assert.equal(genreIdOf(''), null);
  assert.equal(genreIdOf('polka'), null);
  assert.equal(autoPresetGuess(PRESETS, 'Trap')?.id, 'loud-trap');
  assert.equal(autoPresetGuess(PRESETS, 'polka')?.id, 'balanced');
  assert.equal(autoPresetGuess([], 'Trap'), null);
  const intent = (p: Partial<AutoMixIntent>): AutoMixIntent => ({ summary: '', source: 'keywords', ...p });
  assert.deepEqual(effectiveTarget(form({ targetLufs: -12 }), PRESETS, intent({ targetLufs: -8 })), { lufs: -12, truePeak: -1, from: 'you' });
  assert.equal(effectiveTarget(form(), PRESETS, intent({ targetLufs: -8.2 })).lufs, -8);
  assert.equal(effectiveTarget(form(), PRESETS, intent({ targetLufs: -8.2 })).from, 'prompt');
  assert.deepEqual(effectiveTarget(form(), PRESETS, intent({ presetId: 'club-edm' })), { lufs: -8, truePeak: -1, from: 'prompt' });
  assert.deepEqual(effectiveTarget(form({ preset: 'streaming-clean' }), PRESETS, null), { lufs: -14, truePeak: -1, from: 'preset' });
  assert.deepEqual(effectiveTarget(form(), PRESETS, null, 'drill'), { lufs: -8, truePeak: -0.5, from: 'auto' });
  assert.deepEqual(effectiveTarget(form({ truePeak: -2 }), [], null), { lufs: -11, truePeak: -2, from: 'default' });
});

test('prompt: chips from the intent, the understood line, short prompts skipped', () => {
  const i: AutoMixIntent = { presetId: 'club-edm', targetLufs: -8, louder: 2, brighter: -1, vocalsForward: 1, lessHarsh: 1, wider: 0, summary: 'louder, darker, vocals forward, less harsh', source: 'ai' };
  assert.deepEqual(
    intentChips(i, PRESETS).map((c) => `${c.label}${c.strength > 1 ? '+' : ''}`),
    ['Preset: Club / EDM', `${fmtNum(-8)} LUFS`, 'Louder+', 'Darker', 'Vocals up', 'Less harsh'],
  );
  assert.deepEqual(intentChips(null), []);
  assert.equal(understoodLine(i), 'Understood as: louder, darker, vocals forward, less harsh');
  assert.equal(understoodLine({ summary: ' ', source: 'keywords' }), 'Understood as: no change from the preset');
  assert.equal(understoodLine(null), '');
  assert.ok(!promptWorthUnderstanding(' a '));
  assert.ok(promptWorthUnderstanding('dry'));
});

test('tone geometry: log x, clamped y, ranges, a smooth path through every band', () => {
  assert.equal(toneX(30, 300), 0);
  assert.equal(toneX(15000, 300), 300);
  assert.equal(toneX(5, 300), 0, 'clamped below');
  assert.ok(toneX(1000, 300) > toneX(320, 300));
  assert.equal(toneY(0, 100, 12), 50);
  assert.equal(toneY(12, 100, 12), 0);
  assert.equal(toneY(-40, 100, 12), 100);
  assert.equal(toneY(NaN, 100, 12), 50);
  assert.equal(toneRange(flat), 6);
  assert.equal(toneRange({ ...flat, sub: 8 }, null), 12);
  assert.equal(toneRange({ ...flat, high: -14 }), 18);
  const pts = tonePoints({ ...flat, sub: 6 }, 200, 60, 6, 10);
  assert.equal(pts.length, 6);
  assert.equal(pts[0].y, 0);
  assert.ok(pts[0].x >= 10 && pts[5].x <= 190);
  const d = smoothPath(pts);
  assert.match(d, /^M[\d.]+ [\d.]+( C[\d. -]+){5}$/);
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([{ x: 1, y: 2 }]), 'M1 2');
});

test('before / after: rows with real minus signs, vocal row only with vocals, deltas', () => {
  assert.equal(fmtNum(-9.25), '−9.3');
  assert.equal(fmtNum(2, true), '+2.0');
  assert.equal(fmtNum(0, true), '0.0');
  assert.equal(fmtNum(NaN), '–');
  assert.equal(fmtLufs(-14), '−14.0 LUFS');
  const rows = measureRows(m(-17.8, -3.4, -1.2), m(-9, -1.1, 1.5));
  assert.deepEqual(
    rows.map((r) => r.key),
    ['lufs', 'tp', 'vocal', 'lra'],
  );
  assert.equal(rows[0].delta, '+8.8 LU');
  assert.equal(rows[2].after, '+1.5 dB');
  assert.equal(measureRows(m(-12, -1, null), m(-9, -1, null)).some((r) => r.key === 'vocal'), false);
  const half = measureRows(m(-12, -1, null), m(-9, -1, 2)).find((r) => r.key === 'vocal')!;
  assert.equal(half.before, 'No vocal found');
  assert.equal(half.delta, '');
});

test('A/B honesty: say how much louder, and how far to turn down', () => {
  assert.equal(loudnessGap({ before: m(-17, -3, null), after: m(-9, -1, null) }), 8);
  assert.match(abNote(8), /After is 8 dB louder.*louder always sounds better.*turn your speakers down about 8 dB/);
  assert.match(abNote(1.24), /1\.2 dB louder/);
  assert.match(abNote(-2), /quieter.*turn your speakers up about 2\.0 dB/);
  assert.match(abNote(0.3), /about as loud/);
});

test('history entry state for A/B (entry by id, or a group), result grouping, toast', () => {
  const h = [
    { id: 'e1', undone: false, groupId: null },
    { id: 'e2', undone: true, groupId: 'g1' },
    { id: 'e3', undone: true, groupId: 'g1' },
  ];
  assert.equal(entryState(h, 'e1'), 'live');
  assert.equal(entryState(h, 'e2'), 'undone');
  assert.equal(entryState(h, 'g1'), 'undone');
  assert.equal(entryState([...h, { id: 'e4', undone: false, groupId: 'g1' }], 'g1'), 'live');
  assert.equal(entryState(h, 'nope'), 'missing');
  assert.equal(entryState(h, null), 'missing');
  const g = groupChanges([
    { target: 'Vocals ▸ Krypt EQ', what: 'cut 3 dB at 300 Hz' },
    { target: 'Master ▸ Limiter', what: 'input +4 dB' },
    { target: 'Vocals ▸ Volume', what: '+2 dB' },
    { target: 'Bass', what: 'ducks under the kick' },
  ]);
  assert.deepEqual(
    g.map((x) => [x.where, x.items.length]),
    [
      ['Vocals', 2],
      ['Master', 1],
      ['Bass', 1],
    ],
  );
  assert.equal(g[0].items[0].device, 'Krypt EQ');
  assert.equal(g[2].items[0].device, '');
  assert.equal(doneToast({ mode: 'full', before: m(-17, -3, null), after: m(-9, -1, null), changes: [{ target: 'a', what: 'b' }] }), `Auto Mix + Master done: ${fmtLufs(-17)} → ${fmtLufs(-9)}, 1 change`);
});

test('progress stages, bar and failure messages', () => {
  assert.equal(STAGES.length, 5);
  assert.deepEqual(stageStates('running', null), ['active', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(stageStates('running', 'planning'), ['done', 'done', 'active', 'pending', 'pending']);
  assert.deepEqual(stageStates('cancelled', 'applying'), ['done', 'done', 'done', 'stopped', 'pending']);
  assert.deepEqual(stageStates('failed', 'measuring'), ['failed', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(stageStates('running', 'done'), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(barFraction('running', null), -1);
  assert.equal(barFraction('running', { stage: 'measuring', fraction: 1.4, message: '' }), 1);
  assert.equal(barFraction('done', null), 1);
  assert.equal(percentText(0.426), '43 %');
  assert.equal(percentText(-1), '');
  assert.equal(failureMessage(new Error("Error invoking remote method 'automix:run': Error: No handler registered for 'automix:run'")), NOT_AVAILABLE);
  assert.equal(failureMessage("Error invoking remote method 'automix:run': Error: The song is silent"), 'The song is silent');
  assert.equal(failureMessage(''), 'Auto Mix failed without saying why');
  assert.ok(isCancelMessage('Cancelled by the user'));
  assert.ok(isNoFileMessage('No file chosen'));
  assert.ok(!isNoFileMessage('The file is damaged'));
});

// ── Master a song: pick vs run, the reference guard, the working steps, the headline ──

const songAt = (path: string): SongPick => ({ status: 'ready', path, summary: '3:24 · stereo · 44.1 kHz', error: null });

test('Master a song: the run button is disabled with a reason until step 1 has a song', () => {
  assert.equal(masterRunBlocker(NO_SONG, form()), 'Choose your song first');
  assert.equal(masterRunBlocker({ ...NO_SONG, status: 'busy', path: 'C:\\a.wav' }, form()), 'Reading your song…');
  assert.match(masterRunBlocker({ status: 'failed', path: 'C:\\a.wav', summary: null, error: 'damaged' }, form())!, /choose another/);
  assert.equal(masterRunBlocker({ status: 'ready', path: null, summary: null, error: null }, form()), 'Choose your song first', 'ready without a path is not ready');
  assert.equal(masterRunBlocker(songAt('C:\\a.wav'), form()), null);
  assert.match(masterRunBlocker(songAt('C:\\a.wav'), form({ prompt: 'x'.repeat(501) }))!, /too long/, 'the form checks still apply');
});

test('Master a song: the reference can never be the song itself (and is left out of the run)', () => {
  assert.ok(samePath('C:\\Music\\Song.WAV', 'c:/music/song.wav'), 'case and slashes do not matter');
  assert.ok(!samePath('C:\\Music\\Song.wav', 'C:\\Music\\Song 2.wav'));
  assert.ok(!samePath('', ''), 'two empty paths are not a match');
  assert.equal(referenceClash('C:\\Music\\Song.wav', ['c:/music/song.wav']), SAME_AS_SONG);
  assert.equal(SAME_AS_SONG, "That's your own song — pick a different one to match");
  assert.equal(referenceClash('C:\\Music\\Ref.wav', ['C:\\Music\\Song.wav']), null);
  assert.equal(referenceClash(null, ['C:\\Music\\Song.wav']), null);
  assert.equal(referenceClash('C:\\a.wav', ['C:\\b.wav', 'C:\\A.wav'], true), SAME_AS_ALBUM_SONG);
  const ready = { status: 'ready' as const, path: 'C:\\Music\\Song.wav', sound: null, error: null };
  assert.equal(usableReference(ready, ['C:\\Music\\Song.wav']), null, 'the same file is not used');
  assert.equal(usableReference(ready, ['C:\\Music\\Other.wav']), 'C:\\Music\\Song.wav');
  assert.equal(usableReference({ ...ready, status: 'failed' }, []), null, 'a failed read is not used');
  assert.equal(usableReference(NO_REFERENCE, []), null);
});

test('Master a song: step 1 shows the length and format (no analysis)', () => {
  assert.equal(fmtDuration(204.4), '3:24');
  assert.equal(fmtDuration(3723), '1:02:03');
  assert.equal(fmtDuration(NaN), '–');
  assert.equal(songSummary({ durationSec: 204, sampleRate: 44100, channels: 2 }), '3:24 · stereo · 44.1 kHz');
  assert.equal(songSummary({ durationSec: 61, sampleRate: 48000, channels: 1 }), '1:01 · mono · 48 kHz');
});

test('Master a song: the working steps tick through the stages main reports, in order', () => {
  const steps = masterSteps({ song: 'My Song', prompt: false, reference: false });
  assert.deepEqual(
    steps.map((s) => s.id),
    ['open', 'measure', 'plan', 'apply', 'check'],
  );
  assert.equal(steps[0].label, 'Opening "My Song" in a new tab');
  assert.match(steps.find((s) => s.id === 'apply')!.label, /tone EQ → glue → width → loudness/);
  const all = masterSteps({ song: 'x', prompt: true, reference: true });
  assert.deepEqual(
    all.map((s) => s.id),
    ['open', 'prompt', 'reference', 'measure', 'plan', 'apply', 'check'],
  );
  assert.equal(masterStepOf(null), 'open', 'before main says anything, the song is being opened');
  assert.equal(masterStepOf({ stage: 'understanding', message: 'Reading your prompt…' }), 'prompt');
  assert.equal(masterStepOf({ stage: 'measuring', message: 'Reading the reference song…' }), 'reference');
  assert.equal(masterStepOf({ stage: 'measuring', message: 'Rendering and measuring the song…' }), 'measure');
  assert.equal(masterStepOf({ stage: 'planning', message: 'Planning…' }), 'plan');
  assert.equal(masterStepOf({ stage: 'applying', message: 'Setting the knobs…' }), 'apply');
  assert.equal(masterStepOf({ stage: 'refining', message: 'Refining (pass 2 of 3)…' }), 'check');
  assert.equal(masterStepOf({ stage: 'done', message: 'Done.' }), 'done');
  assert.equal(masterStepOf({ stage: 'measuring', message: 'Reading "Intro" (1 of 9)…' }, true), 'open', 'the album reads its files first');
  assert.equal(masterStepOf({ stage: 'measuring', message: 'Measuring "Intro" (1 of 9)…' }, true), 'measure');
  assert.deepEqual(masterStepStates('running', steps, 'plan'), ['done', 'done', 'active', 'pending', 'pending']);
  assert.deepEqual(masterStepStates('running', steps, 'open'), ['active', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(masterStepStates('cancelled', steps, 'apply'), ['done', 'done', 'done', 'stopped', 'pending']);
  assert.deepEqual(masterStepStates('failed', steps, 'measure'), ['done', 'failed', 'pending', 'pending', 'pending']);
  assert.deepEqual(masterStepStates('done', steps, 'check'), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(masterStepStates('running', steps, 'prompt'), ['active', 'pending', 'pending', 'pending', 'pending'], 'a step that is not listed falls back to the first');
  assert.equal(passOf('Refining (pass 2 of 3)…'), 'pass 2');
  assert.equal(passOf('Setting the knobs…'), '');
  assert.equal(progressDetail('Refining "Intro" (3 of 9, pass 2)…'), '"Intro" (3 of 9) · pass 2');
  assert.equal(progressDetail('Measuring the result (pass 1)…'), 'pass 1');
  assert.equal(progressDetail(null), '');
});

test('the result headline: one plain sentence with the song, the loudness and clipping', () => {
  const o = { mode: 'master' as const, before: m(-13.6, -0.2, null), after: m(-9.7, -1, null), entryId: 'e1' };
  assert.equal(resultHeadline(o, 'file', 'My Song'), `Done! "My Song" is mastered (${fmtNum(-13.6)} → ${fmtNum(-9.7)} LUFS, no clipping)`);
  assert.match(resultHeadline({ ...o, after: m(-9, 0.3, null) }, 'file', 'My Song'), /peaks at 0 or above: see Details/);
  assert.match(resultHeadline({ ...o, entryId: null }, 'file', 'My Song'), /already met the target/);
  assert.match(resultHeadline(o, 'project', null), /^Done! Auto Master finished/);
  assert.match(resultWhere('file', 'My Song'), /new tab called "My Song"\. Your original file is untouched/);
  assert.match(resultWhere('file', 'My Song'), /LUFS \(loudness\)/);
});

test('the Master a song dialog: one song picker (step 1), a reference picker that says it is a different song, and the run split from the pick', () => {
  const dialog = read('src/automix/AutoMixDialog.tsx');
  assert.match(dialog, /data-guide="automix\.song"/);
  assert.match(dialog, /Choose your song…/);
  assert.match(dialog, /Master my song/);
  assert.match(dialog, /Pick a reference song…/);
  assert.match(dialog, /Sound like a song you love \(optional\)/);
  assert.match(dialog, /A finished song you want yours to sound like\. It's only measured, never copied\./);
  assert.ok(!/Choose a song and master it/.test(dialog), 'the old pick-and-run button is gone');
  assert.ok(!/'Pick a song…'/.test(dialog), 'the reference button no longer reads like the main picker');
  assert.match(dialog, /disabled=\{!!blocker\}[^>]*onClick=\{\(\) => void startRun\(\)\}/, 'Master my song is disabled while there is a reason');
  assert.match(dialog, /Peak \(no clipping below 0\)|Peak limit \(no clipping\)/);
  assert.match(dialog, /Details/);
  const actions = read('src/automix/actions.ts');
  assert.match(actions, /window\.krypt\.dialog\.openFile\(\{ title: 'Choose your song to master'/, 'the song is picked in the renderer');
  assert.match(actions, /window\.krypt\.engine\.sampleInfo\(path\)/, 'its length comes from sampleInfo (cheap)');
  assert.match(actions, /buildMasterFileRequest\(s\.form, songPath, usableReference\(s\.reference, \[songPath\]\)\)/, 'the run masters the picked song, never asks again');
  assert.match(actions, /guard: \(p\) => \(getAutoMix\(\)\.target === 'file' \? referenceClash\(p, \[getAutoMix\(\)\.song\.path\]\) : null\)/);
  const album = read('src/automix/AlbumDialog.tsx');
  assert.match(album, /Choose your songs…/);
  assert.match(album, /Master my album/);
  assert.match(album, /Sound like a song you love \(optional\)/);
  assert.match(read('src/automix/albumActions.ts'), /guard: \(p\) => referenceClash\(p, getAlbum\(\)\.form\.songs, true\)/);
});

test('entry points are wired: Mixer toolbar + master strip, Tools command + menu, Home card + actions, playlist clip menu', () => {
  const mixer = read('src/panels/mixer/Mixer.tsx');
  assert.match(mixer, /data-guide="automix\.open"[\s\S]{0,120}openAutoMix\(/);
  assert.match(mixer, /data-guide="automix\.master"[\s\S]{0,200}openAutoMaster\(/);
  assert.ok((HOME_ACTION_IDS as readonly string[]).includes('autoMix'));
  assert.ok((HOME_ACTION_IDS as readonly string[]).includes('masterSong'));
  assert.match(read('src/home/actions.ts'), /masterSong:\s*\{[^}]*openMasterSong\(\)/);
  assert.match(read('src/app/actions.ts'), /id: 'tools\.autoMix'[^\n]*openAutoMix\(/);
  assert.match(read('src/app/TitleBar.tsx'), /cmd\('tools\.autoMix', 'Auto Mix…'/);
  assert.match(read('src/panels/playlist/Playlist.tsx'), /label: 'Auto-mix this vocal…'[^\n]*autoMixVocalClip\(clipId, doc\)/);
  const card = read('src/home/screens/AudioToolsScreen.tsx');
  assert.match(card, /<MasterSongCard \/>/);
  assert.match(card, /const \{ song, album \} = masterCardActions\(\);/);
  assert.match(card, /runHomeAction\(song\)/);
  assert.match(card, /data-guide="home\.masterSong"/);
  const actions = read('src/automix/actions.ts');
  assert.match(actions, /window\.krypt\.doc\.toggleEntry\(o\.entryId\)/, 'A/B goes through DocHost.toggleEntry');
  assert.match(actions, /window\.krypt\.automix\.masterFile\(buildMasterFileRequest/);
  assert.match(read('src/dev/mockKrypt.ts'), /automix: createMockAutomix\(host\)/);
});

test('guides: the Auto Mix & Master article, its anchors, the Mixer and Mastering articles pointing to it', () => {
  const art = articleById('auto-mix');
  assert.ok(art, 'the article exists');
  for (const id of ['automix.open', 'automix.master', 'home.masterSong', 'automix.modes', 'automix.song', 'automix.presets', 'automix.prompt', 'automix.options', 'automix.run', 'automix.ab']) {
    assert.ok(id in GUIDE_ANCHORS, `${id} is an anchor`);
    assert.ok(art!.body.includes(`[[show:${id}`), `the article shows ${id}`);
  }
  assert.match(art!.body, /auto_mix/);
  assert.match(art!.body, /louder always sounds better/);
  assert.ok(!/auto-?tune/i.test(art!.body), 'Krypt Tune, never Auto-Tune');
  assert.match(articleById('mixer')!.body, /\[\[guide:auto-mix\|/);
  assert.match(articleById('mastering')!.body, /\[\[guide:auto-mix\|/);
  const dialog = read('src/automix/AutoMixDialog.tsx');
  for (const id of ['automix.modes', 'automix.song', 'automix.reference', 'automix.presets', 'automix.prompt', 'automix.options', 'automix.run', 'automix.ab']) assert.ok(dialog.includes(`data-guide="${id}"`), `the dialog sets ${id}`);
  assert.ok(!/auto-?tune/i.test(dialog));
  const show = read('src/guides/show.ts');
  assert.match(show, /'automix\.presets': openAutoMixForm/);
  assert.match(show, /'automix\.song': openMasterSongForm/);
  assert.match(show, /'automix\.reference': unfoldOr\('reference'\)/, 'Show me unfolds step 3');
  assert.match(show, /'home\.masterSong': \(\) => showHome\('audio'\)/);
});

void run('automix-ui');
