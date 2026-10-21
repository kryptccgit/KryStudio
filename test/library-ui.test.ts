import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { Collection, LibraryQueueState, StyleProfile } from '@shared/library/types';
import {
  EMPTY_FILTERS,
  addResultSentence,
  bandBars,
  buildQuery,
  classifyDrop,
  collectionProgress,
  collectionStatusLine,
  deepEstimateText,
  degreeBars,
  filtersActive,
  fmtBpmCell,
  fmtCount,
  fmtEta,
  fmtEtaShort,
  fmtKeyLong,
  fmtKeyShort,
  fmtLongDuration,
  fmtLufs,
  fmtPct,
  fmtRefTime,
  fmtTrackLength,
  heatAlpha,
  histPosition,
  histogramBars,
  keyFilterOptions,
  libraryTotals,
  nextSort,
  pagesFor,
  parseTags,
  profileGaps,
  queryKey,
  queueActive,
  queueFraction,
  queueHeadline,
  rangeSelect,
  rangeText,
  rescanSentence,
  shapePath,
  statusInfo,
  stepLine,
  stepPosition,
  visibleRange,
} from '../src/library/logic';

const counts = (over: Partial<Collection['counts']> = {}): Collection['counts'] => ({ total: 0, pending: 0, light: 0, deep: 0, failed: 0, missing: 0, ...over });
const queue = (over: Partial<LibraryQueueState> = {}): LibraryQueueState => ({ running: false, paused: false, phase: null, done: 0, total: 0, current: null, etaSec: null, ...over });

test('numbers and durations', () => {
  assert.equal(fmtCount(1500), '1,500');
  assert.equal(fmtCount(NaN), '0');
  assert.equal(fmtPct(0.423), '42%');
  assert.equal(fmtPct(1.7), '100%');
  assert.equal(fmtBpmCell(140), '140');
  assert.equal(fmtBpmCell(127.94), '127.9');
  assert.equal(fmtBpmCell(null), '–');
  assert.equal(fmtBpmCell(0), '–');
  assert.equal(fmtLufs(-8.43), '-8.4');
  assert.equal(fmtLufs(undefined), '–');
  assert.equal(fmtTrackLength(205), '3:25');
  assert.equal(fmtTrackLength(3723), '1:02:03');
  assert.equal(fmtTrackLength(undefined), '–');
  assert.equal(fmtLongDuration(45), '45 s');
  assert.equal(fmtLongDuration(12 * 60), '12 min');
  assert.equal(fmtLongDuration(3 * 3600 + 20 * 60), '3 h 20 min');
  assert.equal(fmtLongDuration(52 * 3600), '2 days 4 h');
  assert.equal(fmtEta(30), 'under a minute left');
  assert.equal(fmtEta(14 * 60), 'about 14 min left');
  assert.equal(fmtEta(null), '');
  assert.equal(fmtEtaShort(14 * 60), '14m');
  assert.equal(fmtEtaShort(200 * 60), '3h 20m');
  assert.equal(fmtEtaShort(10), '<1m');
  assert.equal(fmtRefTime(83.7), '1:23');
});

test('keys: short / long labels and the filter list', () => {
  assert.equal(fmtKeyShort('F#m'), 'F# min');
  assert.equal(fmtKeyShort('Eb'), 'Eb maj');
  assert.equal(fmtKeyShort(null), '–');
  assert.equal(fmtKeyLong('Bbm'), 'Bb minor');
  assert.equal(fmtKeyLong('weird'), 'weird');
  const opts = keyFilterOptions();
  assert.equal(opts.length, 3 + 24);
  assert.deepEqual(opts.slice(0, 3).map((o) => o.value), ['', 'minor', 'major']);
  for (const k of ['Db', 'Ab', 'C#m', 'G#m', 'F#m', 'Eb', 'Ebm']) assert.ok(opts.some((o) => o.value === k), k);
  assert.ok(!opts.some((o) => o.value === 'Dbm'));
});

test('track statuses explain themselves', () => {
  assert.equal(statusInfo('pending').label, 'Queued');
  assert.equal(statusInfo('deep').tone, 'gradient');
  assert.match(statusInfo('failed', 'Unsupported codec').hint, /Unsupported codec/);
  assert.match(statusInfo('failed').hint, /Retry/);
  assert.match(statusInfo('missing').hint, /Rescan/);
  assert.equal(statusInfo('missing', 'Moved').hint, 'Moved');
});

test('collection lines, progress and totals', () => {
  const c = { counts: counts({ total: 1500, pending: 300, light: 1000, deep: 180, failed: 12, missing: 8 }), deep: true };
  assert.equal(collectionStatusLine(c), '1,500 tracks · 1,180 analysed · 180 deep · 12 failed · 8 missing');
  assert.equal(collectionStatusLine({ counts: counts({ total: 3, light: 3 }), deep: false }), '3 tracks · all analysed');
  assert.match(collectionStatusLine({ counts: counts(), deep: false }), /^Empty/);
  assert.equal(collectionProgress(c), 1180 / 1492);
  assert.equal(collectionProgress({ counts: counts() }), 0);
  const t = libraryTotals([{ counts: counts({ total: 2, light: 2 }) } as Collection, { counts: counts({ total: 3, failed: 1, pending: 2 }) } as Collection]);
  assert.deepEqual(t, counts({ total: 5, light: 2, failed: 1, pending: 2 }));
});

test('queue headline, activity and fraction', () => {
  assert.ok(!queueActive(null));
  assert.ok(!queueActive(queue()));
  assert.ok(queueActive(queue({ running: true, total: 10, done: 2 })));
  assert.ok(queueActive(queue({ paused: true, total: 10, done: 2 })));
  assert.ok(!queueActive(queue({ paused: true, total: 10, done: 10 })));
  assert.equal(queueHeadline(queue({ running: true, total: 1154, done: 829, phase: 'light' })), 'Analysing 830 of 1,154 · light pass');
  assert.equal(queueHeadline(queue({ running: true, total: 10, done: 3, phase: 'deep' })), 'Analysing 4 of 10 · deep pass');
  assert.equal(queueHeadline(queue({ paused: true, total: 10, done: 3 })), 'Paused at 3 of 10');
  assert.equal(queueHeadline(queue({ total: 10, done: 10 })), 'All 10 queued tracks analysed');
  assert.equal(queueFraction(queue({ total: 4, done: 1 })), 0.25);
  assert.equal(queueFraction(queue()), -1);
});

test('filters → TrackQuery: blanks dropped, BPM clamped and ordered, limit capped', () => {
  assert.ok(!filtersActive(EMPTY_FILTERS));
  assert.ok(filtersActive({ ...EMPTY_FILTERS, status: 'failed' }));
  const q = buildQuery('c1', { text: '  midnight ', bpmMin: 180, bpmMax: 120, key: 'minor', status: '' }, { key: 'bpm', desc: true }, 400, 5000);
  assert.deepEqual(q, { collectionId: 'c1', text: 'midnight', bpmMin: 120, bpmMax: 180, key: 'minor', sort: 'bpm', desc: true, offset: 400, limit: 1000 });
  const all = buildQuery(null, { ...EMPTY_FILTERS, bpmMin: 5 }, { key: 'name', desc: false });
  assert.equal(all.collectionId, undefined);
  assert.equal(all.bpmMin, 20);
  assert.equal(all.text, undefined);
  assert.equal(all.limit, 200);
  assert.equal(queryKey({ ...q, offset: 0, limit: 200 }), queryKey(q));
  assert.notEqual(queryKey({ ...q, desc: false }), queryKey(q));
});

test('sorting by header click', () => {
  assert.deepEqual(nextSort({ key: 'name', desc: false }, 'name'), { key: 'name', desc: true });
  assert.deepEqual(nextSort({ key: 'name', desc: true }, 'bpm'), { key: 'bpm', desc: false });
});

test('windowed rows and the pages to fetch', () => {
  assert.deepEqual(visibleRange(0, 280, 28, 1500, 0), { first: 0, last: 10 });
  assert.deepEqual(visibleRange(1100 * 28, 280, 28, 1500, 5), { first: 1095, last: 1115 });
  assert.deepEqual(visibleRange(1e9, 280, 28, 20, 5), { first: 5, last: 20 });
  assert.deepEqual(visibleRange(500, 280, 28, 4, 5), { first: 0, last: 4 });
  assert.deepEqual(visibleRange(0, 280, 28, 0), { first: 0, last: 0 });
  assert.deepEqual(pagesFor(0, 10), [0]);
  assert.deepEqual(pagesFor(190, 215), [0, 1]);
  assert.deepEqual(pagesFor(1095, 1115), [5]);
  assert.deepEqual(pagesFor(10, 10), []);
});

test('shift-click range selection over loaded rows', () => {
  const order = ['a', 'b', undefined, 'd', 'e'];
  assert.deepEqual(rangeSelect(order, 'b', 'e'), ['b', 'd', 'e']);
  assert.deepEqual(rangeSelect(order, 'e', 'a'), ['a', 'b', 'd', 'e']);
  assert.deepEqual(rangeSelect(order, null, 'd'), ['d']);
  assert.deepEqual(rangeSelect(order, 'zz', 'd'), ['d']);
});

test('drops from Explorer: audio files, folders, everything else', () => {
  const r = classifyDrop(['D:\\Music\\Dark trap', 'D:\\a\\song.WAV', 'D:\\a\\b.m4a', 'D:\\a\\notes.txt', 'D:\\a\\proj.kstudio', '', '/home/x/Beats', 'E:\\Rips\\Vol.2']);
  assert.deepEqual(r.files, ['D:\\a\\song.WAV', 'D:\\a\\b.m4a']);
  assert.deepEqual(r.folders, ['D:\\Music\\Dark trap', '/home/x/Beats', 'E:\\Rips\\Vol.2']);
  assert.deepEqual(r.ignored, ['D:\\a\\notes.txt', 'D:\\a\\proj.kstudio']);
});

test('tags and outcome sentences', () => {
  assert.deepEqual(parseTags('dark, trap , Dark,,  140  bpm '), ['dark', 'trap', '140 bpm']);
  assert.equal(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).length, 12);
  assert.equal(parseTags('x'.repeat(50))[0].length, 32);
  assert.equal(addResultSentence({ added: 40, skipped: 2 }, 'Dark trap'), 'Added 40 tracks to Dark trap (2 skipped). They are queued for analysis.');
  assert.match(addResultSentence({ added: 0, skipped: 3 }, 'X'), /Nothing new for X: 3 files skipped/);
  assert.equal(addResultSentence({ added: 0, skipped: 0 }, 'X'), 'No audio files found for X');
  assert.equal(rescanSentence({ added: 0, changed: 0, missing: 0 }, 'X'), 'X is up to date');
  assert.equal(rescanSentence({ added: 3, changed: 0, missing: 2 }, 'X'), 'Rescanned X: 3 new, 2 missing');
  assert.equal(deepEstimateText({ tracks: 120, seconds: 5400, device: 'directml' }), '120 tracks · about 1 h 30 min on the GPU (DirectML)');
  assert.match(deepEstimateText({ tracks: 0, seconds: 0, device: 'cpu' }), /already deep-analysed/);
});

test('tempo histogram fills gaps and scales bars', () => {
  const bars = histogramBars([
    { bpm: 140, count: 40 },
    { bpm: 132, count: 10 },
    { bpm: 144, count: 0 },
    { bpm: 148, count: 20 },
  ]);
  assert.deepEqual(bars.map((b) => b.bpm), [132, 136, 140, 144, 148]);
  assert.deepEqual(bars.map((b) => b.count), [10, 0, 40, 0, 20]);
  assert.equal(bars[2].frac, 1);
  assert.equal(bars[0].frac, 0.25);
  assert.ok(Math.abs(bars.reduce((a, b) => a + b.share, 0) - 1) < 1e-9);
  assert.deepEqual(histogramBars([]), []);
  assert.equal(histPosition(bars, 132), 0);
  assert.equal(histPosition(bars, 152), 1);
  assert.equal(histPosition(bars, 142), 0.5);
  assert.equal(histPosition(bars, 999), 1);
});

test('drum heatmap: intensity scaling and grid lines', () => {
  assert.equal(heatAlpha(0), 0);
  assert.equal(heatAlpha(-1), 0);
  assert.equal(heatAlpha(NaN), 0);
  assert.equal(heatAlpha(1), 1);
  assert.equal(heatAlpha(3), 1);
  let prev = 0;
  for (let p = 0.01; p <= 1; p += 0.01) {
    const a = heatAlpha(p);
    assert.ok(a >= prev, `monotonic at ${p}`);
    prev = a;
  }
  assert.ok(heatAlpha(0.1) > 0.2, 'rare hits stay visible');
  assert.deepEqual([0, 8, 16, 4, 2, 1].map(stepLine), ['bar', 'beat', 'beat', 'eighth', 'sixteenth', 'none']);
  assert.equal(stepPosition(0), 'Beat 1 · on the beat');
  assert.equal(stepPosition(12), 'Beat 2 · the "and"');
  assert.equal(stepPosition(18), 'Beat 3 · 2nd 16th');
  assert.equal(stepPosition(22), 'Beat 3 · 4th 16th');
  assert.equal(stepPosition(9), 'Beat 2 · a 32nd');
});

test('bass degrees, band balance, energy shape, ranges', () => {
  const d = degreeBars([0.5, 0, 0, 0.25]);
  assert.equal(d.length, 12);
  assert.equal(d[0].label, '1');
  assert.equal(d[3].label, 'b3');
  assert.equal(d[0].frac, 1);
  assert.equal(d[3].frac, 0.5);
  assert.equal(d[11].share, 0);
  const bands = bandBars({ sub: 0, low: -3, lowMid: -15, mid: -30, highMid: -45, high: NaN } as NonNullable<StyleProfile['mix']>['bands']);
  assert.deepEqual(bands.map((b) => b.key), ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high']);
  assert.equal(bands[0].frac, 1);
  assert.equal(bands[2].frac, 0.5);
  assert.equal(bands[3].frac, 0);
  assert.equal(bands[4].frac, 0);
  assert.equal(bands[5].db, -30);
  assert.equal(shapePath([1], 100, 50), '');
  const path = shapePath([0, 1], 100, 50, 0);
  assert.equal(path, 'M0.0,50.0 L100.0,0.0');
  assert.equal(rangeText({ p10: 130, p25: 135, median: 140, p75: 145, p90: 150 }), '130–150');
  assert.equal(rangeText({ p10: 8, p25: 8, median: 8, p75: 8, p90: 8 }), '8');
});

test('profile gaps drive the empty states', () => {
  const base = { analysed: 0, deep: 0, bass: null } as unknown as StyleProfile;
  assert.deepEqual(profileGaps(base), { empty: true, needsDeep: true });
  assert.deepEqual(profileGaps({ ...base, analysed: 40 }), { empty: false, needsDeep: true });
  assert.deepEqual(profileGaps({ ...base, analysed: 40, deep: 3 }), { empty: false, needsDeep: false });
});

void run('library-ui');
