import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { Analysis } from '@shared/engine/protocol';
import type { AlbumOutcome, AutoMixPreset } from '@shared/automix/types';
import { presetById } from '@shared/automix/presets';
import { findKryptSlot, planAutoMix, applyPlan, toneTarget, widthFactor, type PlanMeasure } from '@shared/automix/plan';
import {
  REF_LUFS_RANGE,
  cappedAgainstReference,
  closeness,
  closenessLine,
  isLimitedSource,
  referenceSoundOf,
  referenceSummary,
  referenceTarget,
  songNameFromPath,
  toneDistance,
  toneWords,
  widthWord,
} from '@shared/automix/reference';
import { albumAverageTone, albumLoudnessTargets, albumName, albumToneTargets, exportFileName, loudnessSpread, placeSongs, safeFileStem, clipTicks } from '@shared/automix/album';
import { DEFAULT_FORM, NO_REFERENCE, buildMasterFileRequest, buildRequest, effectiveTarget, presetHeading, referenceAbNote, referenceGain, referencePath } from '../src/automix/logic';
import { DEFAULT_ALBUM_FORM, addMessage, addSongs, albumFormError, albumResultHeadline, albumResultWhere, buildAlbumRequest, buildExportRequest, moveSong, removeSong, songRows } from '../src/automix/albumLogic';
import { mixDoc } from './automix-fixtures';

const balanced = presetById('balanced')!;
const analysis = (o: Partial<Analysis> = {}): Analysis => ({
  durationSec: 200,
  peakDb: -0.5,
  truePeakDb: -0.3,
  lufsIntegrated: -8.4,
  lufsShortTermMax: -6,
  loudnessRange: 5,
  rmsDb: -10,
  crestDb: 8,
  bands: { sub: -14, low: -12, lowMid: -20, mid: -20, highMid: -22, high: -25 },
  stereoCorrelation: 0.6,
  stereoWidth: 0.31,
  energyCurve: [],
  clipping: false,
  estimatedBpm: null,
  spectralCentroidHz: 2000,
  ...o,
});

test('referenceSoundOf: loudness, tone vs the mids, width and a one-line summary; silent / spectrum-less files refused', () => {
  const s = referenceSoundOf(analysis(), { path: 'C:/Music/Big Song.mp3' });
  assert.ok(typeof s === 'object');
  assert.equal(s.name, 'Big Song');
  assert.equal(s.lufs, -8.4);
  assert.deepEqual(s.tone, { sub: 6, low: 8, lowMid: 0, mid: 0, highMid: -2, high: -5 });
  assert.equal(s.width, 0.31);
  assert.equal(s.summary, '−8.4 LUFS · bright · wide');
  assert.match(String(referenceSoundOf(analysis({ lufsIntegrated: -80 }), { path: 'x.wav' })), /silent/);
  assert.match(String(referenceSoundOf(analysis({ bands: undefined as never }), { path: 'x.wav' })), /spectrum/);
  assert.match(String(referenceSoundOf(null, { path: 'x.wav' })), /empty/);
});

test('summary words: bright / dark, heavy low end, mono … wide', () => {
  assert.deepEqual(toneWords(balanced.tone), []);
  assert.deepEqual(toneWords({ ...balanced.tone, highMid: -9, high: -12 }), ['dark']);
  assert.deepEqual(toneWords({ ...balanced.tone, sub: 9, low: 10 }), ['heavy low end']);
  assert.equal(widthWord(0.01), 'mono');
  assert.equal(widthWord(0.07), 'narrow');
  assert.equal(widthWord(0.15), 'normal width');
  assert.equal(widthWord(0.3), 'wide');
  assert.equal(referenceSummary({ lufs: -14, tone: balanced.tone, width: 0.15 }), '−14.0 LUFS · balanced tone · normal width');
  assert.equal(songNameFromPath('C:\\a\\b\\My Track.final.wav'), 'My Track.final');
});

test('closeness: mean absolute band difference over the five bands, before → after, with an honest line', () => {
  const ref = { sub: 6, low: 8, lowMid: 0, mid: 0, highMid: -2, high: -5 };
  const before = { sub: 2, low: 4, lowMid: 2, mid: 0, highMid: -6, high: -11 };
  const after = { sub: 5, low: 7, lowMid: 0.5, mid: 0, highMid: -3, high: -7 };
  assert.equal(toneDistance(ref, ref), 0);
  assert.equal(toneDistance(before, ref), 4);
  const c = closeness(before, after, ref);
  assert.deepEqual(c, { before: 4, after: 1.1, gained: 2.9 });
  assert.match(closenessLine(c.before, c.after), /^Closer to the reference by 2\.9 dB \(4\.0 → 1\.1 dB/);
  assert.match(closenessLine(8.4, 8.3, '"neon-fog"', { limitedSource: true }), /^Only 0\.1 dB closer to "neon-fog" .*already mastered loud.*limiter off/);
  assert.match(closenessLine(8.4, 8.3, '"neon-fog"'), /^Closer to "neon-fog" by 0\.1 dB/);
  assert.equal(isLimitedSource({ lufs: -10.3, truePeak: -0.2 }), true);
  assert.equal(isLimitedSource({ lufs: -13.6, truePeak: 0.4 }), false);
  assert.match(closenessLine(1, 2), /^1\.0 dB further from the reference/);
  assert.match(closenessLine(2, 2), /^About as close/);
});

test('referenceTarget: its tone (prompt on top), loudness clamped to the safe range, −1 dBTP, width clamped; you and the prompt win', () => {
  const ref = { name: 'R', lufs: -4.5, tone: { sub: 6, low: 8, lowMid: 0, mid: 0, highMid: -2, high: -5 }, width: 0.6 };
  const t = referenceTarget(ref, balanced, null);
  assert.equal(t.lufs, REF_LUFS_RANGE.max);
  assert.equal(t.lufsFrom, 'reference');
  assert.equal(t.truePeak, -1);
  assert.equal(t.width, 0.45);
  assert.deepEqual(t.tone, { ...ref.tone });
  assert.ok(t.notes.some((n) => /−4\.5 LUFS: matched at −6\.0 LUFS/.test(n)), t.notes.join(' | '));
  assert.ok(t.notes.some((n) => /width/.test(n)));
  const bright = referenceTarget(ref, balanced, { summary: 'brighter', source: 'keywords', brighter: 2 });
  assert.equal(bright.tone.high, ref.tone.high + 3, 'the prompt still applies on top of the reference curve');
  assert.deepEqual(bright.tone, toneTarget({ ...balanced, tone: ref.tone }, { summary: '', source: 'keywords', brighter: 2 }));
  assert.equal(referenceTarget(ref, balanced, null, { targetLufs: -12, truePeak: -2 }).lufs, -12);
  assert.equal(referenceTarget(ref, balanced, null, { targetLufs: -12, truePeak: -2 }).truePeak, -2);
  assert.equal(referenceTarget({ ...ref, lufs: -10 }, balanced, { summary: '', source: 'keywords', targetLufs: -13 }).lufsFrom, 'prompt');
  assert.equal(referenceTarget({ ...ref, lufs: -25 }, balanced, null).lufs, REF_LUFS_RANGE.min);
  assert.match(cappedAgainstReference(-6, -8.5, -6)!, /reference is −6\.0 LUFS; your song starts to distort past −8\.5 LUFS/);
  assert.equal(cappedAgainstReference(-6, -6.2, -6), null);
});

test('planner: a master chain on any insert (album songs), aiming at a given tone and width', () => {
  const { doc, ids } = mixDoc();
  const p = doc.project;
  const target = { sub: 6, low: 8, lowMid: 0, mid: 0, highMid: -2, high: -5 };
  const measure: PlanMeasure = { master: { lufs: -16, truePeak: -4, peakDb: -4.2, crestDb: 12, lra: 6, tone: { sub: 2, low: 4, lowMid: 2, mid: 0, highMid: -6, high: -11 }, correlation: 0.6, width: 0.1 }, inserts: {}, gr: [] };
  const plan = planAutoMix({ mode: 'master', preset: balanced, intent: null, target: { lufs: -10, truePeak: -1 }, keepUserFx: true, project: p, catalog: doc.catalog, measure, roles: {}, pass: 1, masterInsertId: ids.Keys, tone: target, widthTarget: 0.3 });
  const slots = plan.ops.filter((o) => o.op === 'slot');
  assert.ok(slots.length >= 4);
  assert.ok(slots.every((o) => o.insertId === ids.Keys), 'nothing on the Master');
  assert.ok(slots.every((o) => o.target.startsWith('Keys ▸')));
  const eq = slots.find((o) => o.op === 'slot' && o.kind === 'eq')!;
  assert.ok(eq.op === 'slot' && eq.params.b6Gain > 0 && eq.params.b2Gain > 0, 'tone EQ moves toward the given curve');
  const im = slots.find((o) => o.op === 'slot' && o.kind === 'imager')!;
  assert.ok(im.op === 'slot' && im.params.midWidth > 1.2 && im.params.lowWidth === 0, 'wider toward the reference, lows mono');
  assert.match(im.what, /toward the reference's width 30%/);
  let execs = 0;
  applyPlan(plan, { project: () => doc.project, catalog: doc.catalog, exec: (cmd, args) => { execs++; const r = doc.exec(cmd, args, { actor: { kind: 'system' } }); if (!r.ok) throw new Error(r.message); return r.data as never; }, chain: () => null }, { keepUserFx: true });
  assert.ok(execs > 0);
  const k = doc.project.mixer.inserts[ids.Keys];
  assert.equal(k.slots[k.slotOrder[k.slotOrder.length - 1]].type, 'krypt.limiter', "the song's limiter is last");
  assert.ok(findKryptSlot(k, 'limiter', true));
  assert.equal(doc.project.mixer.inserts[p.mixer.masterId].slotOrder.length, p.mixer.inserts[p.mixer.masterId].slotOrder.length, 'the Master is untouched');
  assert.ok(Math.abs(widthFactor(0.2, 0.2) - 1) < 1e-9);
  assert.ok(widthFactor(0.1, 0.3) > 1 && widthFactor(0.3, 0.1) < 1);
  assert.equal(widthFactor(0.001, 0.9), 1.6, 'clamped');
});

test('placeSongs: back to back on bars, a 2-bar gap, ranges that never overlap; lengths as playlist.addAudio makes them', () => {
  const ts = { num: 4, den: 4 };
  const slots = placeSongs([120, 61, 30], 120, ts);
  const bar = 3840;
  assert.equal(slots[0].startTick, 0);
  assert.equal(slots[0].lengthTicks, clipTicks(120, 120));
  assert.equal(slots[0].bars, '1-60');
  assert.equal(slots[1].startTick, 62 * bar, '2 empty bars after bar 60');
  assert.equal(slots[1].bars, '63-93');
  assert.equal(slots[2].startTick, 95 * bar);
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i].startTick >= slots[i - 1].endBar * bar + 2 * bar);
  assert.equal(placeSongs([10], 100, { num: 3, den: 4 })[0].bars, '1-6');
});

test("albumLoudnessTargets: keep the album's dynamics (the loudest on target, ≤ 4 LU under) or all on target", () => {
  assert.deepEqual(albumLoudnessTargets([-14, -16, -22, -15], -9, true), [-9, -11, -13, -10]);
  assert.deepEqual(albumLoudnessTargets([-14, -16, -22], -9, false), [-9, -9, -9]);
  assert.deepEqual(albumLoudnessTargets([-14, NaN], -9, true), [-9, -9]);
  assert.equal(loudnessSpread([-14, -16, -22]), 8);
});

test('albumToneTargets: the curve + half the shared deviation + a quarter of each song\'s own', () => {
  const curve = { sub: 4, low: 6, lowMid: -1, mid: 0, highMid: -5, high: -8 };
  const a = { sub: 4, low: 6, lowMid: -1, mid: 0, highMid: -7, high: -12 };
  const b = { sub: 4, low: 6, lowMid: -1, mid: 0, highMid: -5, high: -8 };
  const { targets, deviation } = albumToneTargets(curve, [a, b]);
  assert.equal(deviation.high, -2);
  assert.equal(targets[0].high, -9.5);
  assert.equal(targets[1].high, -8.5);
  assert.equal(targets[0].mid, 0);
  assert.ok(Math.abs(targets[0].high - targets[1].high) < Math.abs(a.high - b.high), 'closer together than before');
  const same = albumToneTargets(curve, [curve, curve]).targets;
  assert.deepEqual(same[0], curve);
  assert.deepEqual(albumAverageTone([a, b]).high, -10);
});

test('names: the album tab, Windows-safe export files that never reuse a name', () => {
  assert.equal(albumName(['Intro', 'Two', 'Three']), 'Album: Intro + 2');
  assert.equal(safeFileStem('a/b:c*?"<>|'), 'a b c');
  assert.equal(safeFileStem('CON'), '_CON');
  assert.equal(safeFileStem('dots...  '), 'dots');
  assert.equal(exportFileName('Song', 'wav', new Set()), 'Song (mastered).wav');
  assert.equal(exportFileName('Song', 'wav', new Set(['song (MASTERED).wav'])), 'Song (mastered) 2.wav');
  assert.equal(exportFileName('Song', 'mp3', new Set(['Song (mastered).mp3', 'Song (mastered) 2.mp3'])), 'Song (mastered) 3.mp3');
});

test('Auto Mix form + reference: requests carry it for master / full only; the target follows it (clamped); the ceiling defaults to −1', () => {
  const presets: AutoMixPreset[] = [presetById('loud-trap')!, balanced];
  const f = { ...DEFAULT_FORM, mode: 'master' as const, preset: 'loud-trap' };
  assert.equal(buildRequest(f, 40, 'C:/r.wav').reference, 'C:/r.wav');
  assert.equal(buildRequest({ ...f, mode: 'vocals' }, 40, 'C:/r.wav').reference, undefined);
  assert.equal(buildRequest(f, 40, null).reference, undefined);
  assert.equal(buildMasterFileRequest(f, 'C:/song.wav', ' C:/r.wav ').reference, 'C:/r.wav');
  assert.equal(buildMasterFileRequest(f, 'C:/song.wav', ' C:/r.wav ').path, 'C:/song.wav', 'the song picked in step 1, never a dialog');
  const t = effectiveTarget(f, presets, null, null, { lufs: -4.2 });
  assert.deepEqual(t, { lufs: -6, truePeak: -1, from: 'reference' });
  assert.equal(effectiveTarget({ ...f, targetLufs: -12 }, presets, null, null, { lufs: -4.2 }).from, 'you');
  assert.equal(effectiveTarget(f, presets, null, null, null).truePeak, presetById('loud-trap')!.truePeak);
  assert.equal(referencePath({ status: 'failed', path: 'x.wav', sound: null, error: 'no' }), null);
  assert.equal(referencePath({ status: 'busy', path: 'x.wav', sound: null, error: null }), 'x.wav');
  assert.equal(presetHeading(NO_REFERENCE), 'Preset');
  assert.equal(referenceGain(-9, -6), -3);
  assert.match(referenceAbNote(-9, -6), /3\.0 dB quieter/);
  assert.match(referenceAbNote(-9, -9.1), /own level/);
});

test('album form: add (audio only, once each, ≤ 20), reorder, remove, request, errors', () => {
  const r = addSongs([], ['C:/a.wav', 'C:/b.mp3', 'C:/A.WAV', 'C:/notes.txt']);
  assert.deepEqual(r.songs, ['C:/a.wav', 'C:/b.mp3']);
  assert.equal(r.duplicates, 1);
  assert.equal(r.notAudio, 1);
  assert.match(addMessage(r), /1 already in the list, 1 not audio/);
  const many = addSongs(r.songs, Array.from({ length: 25 }, (_, i) => `C:/s${i}.wav`));
  assert.equal(many.songs.length, 20);
  assert.equal(many.overCap, 7);
  assert.deepEqual(moveSong(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveSong(['a', 'b', 'c'], 2, -5), ['c', 'a', 'b']);
  assert.deepEqual(removeSong(['a', 'b', 'c'], 1), ['a', 'c']);
  assert.match(albumFormError(DEFAULT_ALBUM_FORM)!, /Choose your songs first \(2 to 20\)/);
  assert.match(albumFormError({ ...DEFAULT_ALBUM_FORM, songs: ['a.wav'] })!, /one more/);
  assert.equal(albumFormError({ ...DEFAULT_ALBUM_FORM, songs: ['a.wav', 'b.wav'] }), null);
  assert.deepEqual(buildAlbumRequest({ ...DEFAULT_ALBUM_FORM, songs: ['a.wav', 'b.wav'], prompt: ' warm ', keepDynamics: false, useAi: false }, 'C:/ref.wav'), {
    paths: ['a.wav', 'b.wav'],
    preset: 'auto',
    keepDynamics: false,
    useAi: 'never',
    prompt: 'warm',
    reference: 'C:/ref.wav',
  });
});

test('album result rows: before → after against the aim, flags a song off its aim or over the ceiling; export request', () => {
  const m = (lufs: number, tp: number) => ({ lufs, truePeak: tp, lra: 5, tone: { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 }, correlation: 0.5, vocalVsBeat: null });
  const o = {
    truePeak: -1,
    songs: [
      { name: 'One', path: 'a', trackId: 't', insertId: 'i', startTick: 0, endTick: 100, bars: '1-2', targetLufs: -9, before: m(-15, -3), after: m(-9.2, -1.1), targetTone: m(0, 0).tone, changes: [{ target: 'One ▸ Krypt EQ', what: 'x' }], notes: [] },
      { name: 'Two', path: 'b', trackId: 't2', insertId: 'i2', startTick: 500, endTick: 900, bars: '3-4', targetLufs: -11, before: m(-17, -3), after: m(-12.5, -0.8), targetTone: m(0, 0).tone, changes: [], notes: ['Loudness capped'] },
    ],
  } as unknown as AlbumOutcome;
  const rows = songRows(o);
  assert.equal(rows[0].warn, false);
  assert.equal(rows[0].delta, '+5.8 LU');
  assert.equal(rows[1].warn, true);
  assert.match(rows[1].why, /Peak over the .* limit/);
  assert.match(albumResultHeadline({ ...o, entryId: 'e1' }), /^Done! Your \d+ songs are mastered as one album \(loudest .* LUFS, /);
  assert.match(albumResultHeadline({ ...o, entryId: null }), /already met the target/);
  assert.match(albumResultWhere({ name: 'Album: Intro + 1' }), /new tab called "Album: Intro \+ 1".*original files are untouched/);
  assert.deepEqual(buildExportRequest(o, 'mp3'), { folder: '', format: 'mp3', mp3Kbps: 320, songs: [{ name: 'One', startTick: 0, endTick: 100 }, { name: 'Two', startTick: 500, endTick: 900 }] });
  assert.equal(buildExportRequest(o, 'wav24').mp3Kbps, undefined);
});

run('automix-album');

test('Auto never turns an already-loud song down (up to the loudest card); quieter songs keep the card', async () => {
  const { autoKeepsLoudness, AUTO_LOUDEST_LUFS } = await import('../shared/automix/presets');
  assert.equal(autoKeepsLoudness(-11, -13.6), null, 'a quiet mix gets the card');
  assert.equal(autoKeepsLoudness(-11, -10.8), null, 'within 0.5 LU: the card stands');
  const k = autoKeepsLoudness(-11, -9.5)!;
  assert.equal(k.lufs, -9.5);
  assert.match(k.note, /Auto keeps it at −9\.5 LUFS instead of turning it down/);
  assert.equal(autoKeepsLoudness(-11, -6.2)!.lufs, AUTO_LOUDEST_LUFS, 'capped at the loudest card');
  assert.equal(autoKeepsLoudness(-11, Number.NaN), null);
});
