// The Session view's pure model (src/panels/session/model.ts): slot hit-testing with sticky headers / scene
// column / stop row, keyboard selection moves, slot indexes, labels and colors, bar ↔ tick lengths, the
// follow-action editor's value mapping, live-state fingerprints and drag payload parsing.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { LaunchClip } from '@shared/schema/launcher';
import type { LauncherTelemetry } from '@shared/engine/protocol';
import {
  visibleTracks,
  CHANNEL_MIME,
  LAUNCH_CLIP_MIME,
  PATTERN_MIME,
  SAMPLE_MIME,
  SESSION_LAYOUT as L,
  barsToTicks,
  chanceToPercent,
  clampCell,
  clampNote,
  clipColor,
  clipLabel,
  clipProgress,
  defaultFollow,
  dragKind,
  dropEffectFor,
  firstEmptyScene,
  followActive,
  followSummary,
  formatBars,
  gridSize,
  gridWindowLabel,
  liveSignature,
  moveCell,
  nameFromPath,
  needsRelease,
  normalizeAfterBars,
  parseSamplePayload,
  percentToChance,
  pointToCell,
  sanitizeFollow,
  slotAt,
  slotIndex,
  slotKey,
  slotRect,
  slotStatus,
  ticksToBars,
  trackAccent,
  tracksWithClips,
  withAlpha,
} from '../src/panels/session/model';

const TS = { num: 4, den: 4 };
const BAR = 3840;

function clip(id: string, trackId: string, sceneId: string, extra: Partial<LaunchClip> = {}): LaunchClip {
  return { id, trackId, sceneId, kind: 'pattern', patternId: 'p1', color: null, length: BAR * 4, offset: 0, loop: true, launchMode: 'trigger', ...extra };
}

const PROJ = {
  patterns: { p1: { name: 'Drums', color: '#22C55E' } },
  channels: { ch1: { name: 'Vocal chop', color: '#EC4899' } },
} as unknown as Parameters<typeof clipLabel>[1];

// ── Hit-testing ───────────────────────────────────────────────────────

test('visibleTracks: tracks in use plus spare empties; showAll keeps every track', () => {
  const order = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const lc = (id: string, trackId: string) => ({ [id]: { id, trackId } as LaunchClip });
  assert.deepEqual(visibleTracks(order, undefined, new Set(), false), ['t1', 't2', 't3', 't4'], 'empty project: four to drop onto');
  assert.deepEqual(visibleTracks(order, lc('a', 't5'), new Set(['t2']), false), ['t1', 't2', 't3', 't5'], 'in use + spares up to four, playlist order');
  const busy = { ...lc('a', 't1'), ...lc('b', 't3'), ...lc('c', 't4'), ...lc('d', 't6') };
  assert.deepEqual(visibleTracks(order, busy, new Set(), false), ['t1', 't2', 't3', 't4', 't6'], 'always one empty spare');
  assert.equal(visibleTracks(order, lc('a', 't5'), new Set(), true), order);
});

test('slotAt: cells by column width and row height; outside the slot area is null', () => {
  assert.deepEqual(slotAt(0, 0, 3, 2), { col: 0, row: 0 });
  assert.deepEqual(slotAt(L.colW - 1, L.rowH - 1, 3, 2), { col: 0, row: 0 });
  assert.deepEqual(slotAt(L.colW, L.rowH, 3, 2), { col: 1, row: 1 });
  assert.deepEqual(slotAt(L.colW * 2 + 5, 3, 3, 2), { col: 2, row: 0 });
  assert.equal(slotAt(L.colW * 3, 0, 3, 2), null, 'past the last column (the scene column)');
  assert.equal(slotAt(0, L.rowH * 2, 3, 2), null, 'past the last row (the stop row)');
  assert.equal(slotAt(-1, 0, 3, 2), null);
  assert.equal(slotAt(0, -0.5, 3, 2), null);
  assert.equal(slotAt(Number.NaN, 0, 3, 2), null);
  assert.equal(slotAt(0, 0, 0, 0), null, 'empty grid');
  assert.deepEqual(slotRect({ col: 2, row: 3 }), { x: 2 * L.colW, y: 3 * L.rowH, w: L.colW, h: L.rowH });
});

test('pointToCell: unscrolled grid, sticky header / scene column / stop row cover no slot', () => {
  // A wide view: the grid (3 tracks × 4 scenes) fits; the scene column sits right after the last track.
  const view = { left: 100, top: 50, right: 1100, bottom: 650 };
  const grid = { left: 100, top: 50 };
  const y0 = 50 + L.headerH;
  assert.deepEqual(pointToCell(101, y0 + 1, grid, view, 3, 4), { col: 0, row: 0 });
  assert.deepEqual(pointToCell(100 + L.colW * 2 + 3, y0 + L.rowH * 3 + 2, grid, view, 3, 4), { col: 2, row: 3 });
  assert.equal(pointToCell(150, 60, grid, view, 3, 4), null, 'track header');
  assert.equal(pointToCell(100 + L.colW * 3 + 10, y0 + 5, grid, view, 3, 4), null, 'scene column');
  assert.equal(pointToCell(150, y0 + L.rowH * 4 + 5, grid, view, 3, 4), null, 'stop row');
  assert.equal(pointToCell(90, y0 + 5, grid, view, 3, 4), null, 'left of the view');
  assert.equal(pointToCell(150, 700, grid, view, 3, 4), null, 'below the view');
});

test('pointToCell: scrolled grid, pinned header / scene column / stop row still block, slots under the scroll map right', () => {
  // A small view over a big grid (20 tracks × 40 scenes), scrolled 500 px right and 300 px down.
  const view = { left: 0, top: 0, right: 600, bottom: 400 };
  const grid = { left: -500, top: -300 };
  const cols = 20;
  const rows = 40;
  // Point at view (10, 200): grid x = 510 → col 4; grid y = 500 - headerH → row ⌊(500 - 40)/34⌋.
  assert.deepEqual(pointToCell(10, 200, grid, view, cols, rows), { col: Math.floor(510 / L.colW), row: Math.floor((500 - L.headerH) / L.rowH) });
  assert.equal(pointToCell(10, L.headerH - 1, grid, view, cols, rows), null, 'pinned header at the top of the view');
  assert.ok(pointToCell(10, L.headerH + 1, grid, view, cols, rows), 'just under the pinned header');
  assert.equal(pointToCell(600 - L.sceneW + 1, 200, grid, view, cols, rows), null, 'pinned scene column at the right edge');
  assert.ok(pointToCell(600 - L.sceneW - 1, 200, grid, view, cols, rows));
  assert.equal(pointToCell(10, 400 - L.footerH + 1, grid, view, cols, rows), null, 'pinned stop row at the bottom');
});

test('gridSize covers headers, slots, stop row and the scene column', () => {
  assert.deepEqual(gridSize(3, 2), { w: 3 * L.colW + L.sceneW, h: L.headerH + 2 * L.rowH + L.footerH });
  assert.deepEqual(gridSize(0, 0), { w: L.sceneW, h: L.headerH + L.footerH });
});

// ── Keyboard selection ────────────────────────────────────────────────

test('moveCell: arrows move and clamp; no selection starts top-left; empty grid has none', () => {
  assert.deepEqual(moveCell(null, 'ArrowDown', 3, 3), { col: 0, row: 0 });
  assert.deepEqual(moveCell({ col: 1, row: 1 }, 'ArrowUp', 3, 3), { col: 1, row: 0 });
  assert.deepEqual(moveCell({ col: 1, row: 1 }, 'ArrowDown', 3, 3), { col: 1, row: 2 });
  assert.deepEqual(moveCell({ col: 1, row: 1 }, 'ArrowLeft', 3, 3), { col: 0, row: 1 });
  assert.deepEqual(moveCell({ col: 1, row: 1 }, 'ArrowRight', 3, 3), { col: 2, row: 1 });
  assert.deepEqual(moveCell({ col: 0, row: 0 }, 'ArrowUp', 3, 3), { col: 0, row: 0 });
  assert.deepEqual(moveCell({ col: 2, row: 2 }, 'ArrowRight', 3, 3), { col: 2, row: 2 });
  assert.equal(moveCell({ col: 0, row: 0 }, 'ArrowDown', 3, 0), null);
  assert.deepEqual(clampCell({ col: 5, row: 9 }, 3, 4), { col: 2, row: 3 });
  assert.equal(clampCell({ col: 1, row: 1 }, 0, 4), null);
  assert.equal(clampCell(null, 3, 3), null);
});

// ── Slots, labels, colors ─────────────────────────────────────────────

test('slot index, columns with clips and the first empty scene of a track', () => {
  const clips = { a: clip('a', 't1', 's1'), b: clip('b', 't1', 's2'), c: clip('c', 't2', 's3') };
  const idx = slotIndex(clips);
  assert.equal(idx.get(slotKey('t1', 's2')), 'b');
  assert.equal(idx.get(slotKey('t2', 's1')), undefined);
  assert.notEqual(slotKey('t1', 's2'), slotKey('t1s', '2'), 'keys never collide across ids');
  assert.deepEqual([...tracksWithClips(clips)].sort(), ['t1', 't2']);
  assert.equal(firstEmptyScene('t1', ['s1', 's2', 's3'], clips), 's3');
  assert.equal(firstEmptyScene('t2', ['s1', 's2', 's3'], clips), 's1');
  assert.equal(firstEmptyScene('t1', ['s1', 's2'], clips), null, 'full column');
  assert.equal(firstEmptyScene('t9', [], undefined), null);
  assert.equal(slotIndex(undefined).size, 0);
});

test('clip labels and colors fall back to the source; track accent for the default color', () => {
  assert.equal(clipLabel(clip('a', 't', 's'), PROJ), 'Drums');
  assert.equal(clipLabel(clip('a', 't', 's', { name: 'Fill' }), PROJ), 'Fill');
  assert.equal(clipLabel(clip('a', 't', 's', { kind: 'audio', patternId: undefined, channelId: 'ch1' }), PROJ), 'Vocal chop');
  assert.equal(clipLabel(clip('a', 't', 's', { patternId: 'gone' }), PROJ), 'Missing pattern');
  assert.equal(clipColor(clip('a', 't', 's'), PROJ), '#22C55E');
  assert.equal(clipColor(clip('a', 't', 's', { color: '#F59E0B' }), PROJ), '#F59E0B');
  assert.equal(clipColor(clip('a', 't', 's', { kind: 'audio', channelId: 'ch1' }), PROJ), '#EC4899');
  assert.equal(clipColor(clip('a', 't', 's', { patternId: 'gone' }), PROJ), '#A855F7');
  assert.equal(trackAccent('#3F3F52'), 'rgba(168,85,247,0.35)');
  assert.equal(trackAccent('#EF4444'), '#EF4444');
  assert.equal(withAlpha('#A855F7', 0.2), 'rgba(168,85,247,0.2)');
  assert.equal(withAlpha('#fff', 2), 'rgba(255,255,255,1)');
  assert.equal(withAlpha('red', 0.5), 'red');
});

test('lengths: bars ↔ ticks in the time signature, readable bar counts', () => {
  assert.equal(ticksToBars(BAR * 4, TS), 4);
  assert.equal(ticksToBars(2880, { num: 3, den: 4 }), 1);
  assert.equal(barsToTicks(2, TS), BAR * 2);
  assert.equal(barsToTicks(0.25, TS), 960);
  assert.equal(barsToTicks(0, TS), 1, 'at least one tick');
  assert.equal(formatBars(1), '1 bar');
  assert.equal(formatBars(4), '4 bars');
  assert.equal(formatBars(1.5), '1.5 bars');
  assert.equal(needsRelease('gate'), true);
  assert.equal(needsRelease('repeat'), true);
  assert.equal(needsRelease('trigger'), false);
  assert.equal(needsRelease('toggle'), false);
});

// ── Follow-action editor mapping ──────────────────────────────────────

test('follow editor: percent ↔ chance, after-bars in quarter bars, clean rules', () => {
  assert.equal(chanceToPercent(0.755), 76);
  assert.equal(chanceToPercent(2), 100);
  assert.equal(chanceToPercent(-1), 0);
  assert.equal(chanceToPercent(Number.NaN), 100);
  assert.equal(percentToChance(75), 0.75);
  assert.equal(percentToChance(33.4), 0.33);
  assert.equal(percentToChance(150), 1);
  assert.equal(percentToChance(-5), 0);
  for (let p = 0; p <= 100; p++) assert.equal(chanceToPercent(percentToChance(p)), p, `round trip ${p}`);
  assert.equal(normalizeAfterBars(3.1), 3);
  assert.equal(normalizeAfterBars(0.3), 0.25);
  assert.equal(normalizeAfterBars(0), 0.25);
  assert.equal(normalizeAfterBars(5000), 1024);
  assert.equal(normalizeAfterBars(Number.NaN), 1);
  assert.deepEqual(defaultFollow(8), { action: 'next', chance: 1, otherAction: 'none', afterBars: 8 });
  assert.deepEqual(defaultFollow(0), { action: 'next', chance: 1, otherAction: 'none', afterBars: 4 });
  assert.deepEqual(sanitizeFollow({ action: 'other', chance: 0.666, otherAction: 'bogus' as never, afterBars: 2.3 }), {
    action: 'other',
    chance: 0.67,
    otherAction: 'none',
    afterBars: 2.25,
  });
});

test('follow summary and badge', () => {
  assert.equal(followSummary(undefined), 'No follow action');
  assert.equal(followSummary({ action: 'next', chance: 1, otherAction: 'stop', afterBars: 4 }), 'Next after 4 bars');
  assert.equal(followSummary({ action: 'next', chance: 0.75, otherAction: 'stop', afterBars: 2 }), 'Next 75 % · Stop 25 % after 2 bars');
  assert.equal(followSummary({ action: 'next', chance: 0, otherAction: 'any', afterBars: 1 }), 'Any after 1 bar');
  assert.equal(followSummary({ action: 'none', chance: 1, otherAction: 'none', afterBars: 1 }), 'Keeps looping');
  assert.equal(followActive({ action: 'none', chance: 1, otherAction: 'stop', afterBars: 1 }), false, '100 % keep looping');
  assert.equal(followActive({ action: 'none', chance: 0.5, otherAction: 'stop', afterBars: 1 }), true);
  assert.equal(followActive({ action: 'again', chance: 1, otherAction: 'none', afterBars: 1 }), true);
  assert.equal(followActive(undefined), false);
});

// ── Live state ────────────────────────────────────────────────────────

const live = (x: Partial<LauncherTelemetry> = {}): LauncherTelemetry => ({ playing: {}, queued: {}, progress: {}, overridden: [], recording: false, ...x });

test('live signature ignores progress and key order; changes on launches, overrides and recording', () => {
  const a = live({ playing: { t1: 'c1', t2: 'c2' }, progress: { c1: 0.1 } });
  const b = live({ playing: { t2: 'c2', t1: 'c1' }, progress: { c1: 0.9, c2: 0.5 } });
  assert.equal(liveSignature(a), liveSignature(b));
  assert.notEqual(liveSignature(a), liveSignature(live({ playing: { t1: 'c1' } })));
  assert.notEqual(liveSignature(a), liveSignature({ ...a, queued: { t3: 'stop' } }));
  assert.notEqual(liveSignature(a), liveSignature({ ...a, overridden: ['t1'] }));
  assert.notEqual(liveSignature(a), liveSignature({ ...a, recording: true }));
  assert.equal(liveSignature(undefined), '');
});

test('slot status (queued wins over playing for a relaunch) and clamped progress', () => {
  const l = live({ playing: { t1: 'c1', t2: 'c2' }, queued: { t2: 'c2', t3: 'stop' }, progress: { c1: 1.4, c2: Number.NaN } });
  assert.equal(slotStatus('c1', 't1', l), 'playing');
  assert.equal(slotStatus('c2', 't2', l), 'queued');
  assert.equal(slotStatus('c9', 't1', l), 'idle');
  assert.equal(slotStatus('c1', 't1', null), 'idle');
  assert.equal(clipProgress('c1', l), 1);
  assert.equal(clipProgress('c2', l), null);
  assert.equal(clipProgress('c3', l), null);
  assert.equal(clipProgress('c1', undefined), null);
});

// ── Drag and drop ─────────────────────────────────────────────────────

test('drag kinds by MIME (a launch clip also carrying its pattern is still a slot move); drop effects', () => {
  assert.equal(dragKind([LAUNCH_CLIP_MIME, PATTERN_MIME]), 'slot');
  assert.equal(dragKind([PATTERN_MIME]), 'pattern');
  assert.equal(dragKind([SAMPLE_MIME, 'text/plain']), 'sample');
  assert.equal(dragKind([CHANNEL_MIME]), 'channel');
  assert.equal(dragKind(['Files']), 'files');
  assert.equal(dragKind(['text/plain']), null);
  assert.equal(dragKind(null), null);
  assert.equal(dropEffectFor('slot', false), 'move');
  assert.equal(dropEffectFor('slot', true), 'copy');
  assert.equal(dropEffectFor('pattern', false), 'copy');
  assert.equal(dropEffectFor('channel', true), 'move', 'Channel Rack rows only allow move');
  // The MIME strings must match the other panels' drag sources.
  assert.equal(PATTERN_MIME, 'application/x-krypt-pattern');
  assert.equal(SAMPLE_MIME, 'application/x-krypt-sample');
  assert.equal(CHANNEL_MIME, 'application/x-krypt-channel');
});

test('sample payloads: plain paths, JSON {path, name}, junk', () => {
  assert.deepEqual(parseSamplePayload('C:\\Samples\\kick.wav'), { path: 'C:\\Samples\\kick.wav' });
  assert.deepEqual(parseSamplePayload('factory:drums/kick 1.wav'), { path: 'factory:drums/kick 1.wav' });
  assert.deepEqual(parseSamplePayload('{"path":"D:/loop.flac","name":"Loop"}'), { path: 'D:/loop.flac', name: 'Loop' });
  assert.equal(parseSamplePayload('{"name":"no path"}'), null);
  assert.equal(parseSamplePayload('{broken'), null);
  assert.equal(parseSamplePayload('   '), null);
  assert.equal(parseSamplePayload(undefined), null);
  assert.equal(nameFromPath('C:\\a\\Vocal Take 3.wav'), 'Vocal Take 3');
  assert.equal(nameFromPath('factory:fx/riser.ogg'), 'riser');
});

// ── Grid controller ───────────────────────────────────────────────────

test('grid controller helpers', () => {
  assert.equal(clampNote(200), 127);
  assert.equal(clampNote(-3), 0);
  assert.equal(clampNote(36.6), 37);
  assert.equal(clampNote(Number.NaN), 36);
  assert.equal(gridWindowLabel({ trackOffset: 0, sceneOffset: 8 }), 'Tracks 1-8 · Scenes 9-16');
});

await run('session-ui');
