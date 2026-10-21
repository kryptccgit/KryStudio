import assert from 'node:assert/strict';
import { test, run } from './harness';
import { PPQ, TICKS_PER_STEP } from '@shared/schema/time';
import {
  buildLanes,
  clampScroll,
  edgeScrollStep,
  keyToY,
  laneAt,
  tickToX,
  visibleKeys,
  visibleLanes,
  wheelZoomFactor,
  xToTick,
  yToKey,
  zoomAt,
  zoomRowsAt,
} from '../src/editors/viewport';
import { cellStart, snapMoveDelta, snapResizeEnd, snapResizeStart, snapTicks, snapTo, SNAP_OPTIONS } from '../src/editors/snap';
import { SpanIndex, edgeZone, hitClip, hitNote, nearestPoint, notesInRect } from '../src/editors/spanIndex';
import { gridLevels } from '../src/editors/gridPaint';
import { duplicateShift, makeNoteClipboard, pasteNotes } from '../src/editors/clipboard';
import { GlowTracker, changedIds } from '../src/editors/agentGlow';
import { defaultNote, type Note } from '@shared/schema/project';

const TS44 = { num: 4, den: 4 };
const BAR = PPQ * 4;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('tick ↔ x round-trips', () => {
  const v = { scrollTick: 1000, pxPerTick: 0.1 };
  assert.equal(tickToX(v, 1000), 0);
  assert.equal(tickToX(v, 2000), 100);
  near(xToTick(v, tickToX(v, 12345)), 12345);
});

test('zoomAt keeps the tick under the cursor fixed and clamps', () => {
  const v = { scrollTick: 960, pxPerTick: 0.05 };
  const anchorX = 300;
  const before = xToTick(v, anchorX);
  const z = zoomAt(v, anchorX, 2, 0.001, 1);
  near(z.pxPerTick, 0.1);
  near(xToTick(z, anchorX), before);
  const big = zoomAt(v, anchorX, 1000, 0.001, 0.2);
  assert.equal(big.pxPerTick, 0.2);
  near(xToTick(big, anchorX), before);
  const out = zoomAt({ scrollTick: 10, pxPerTick: 0.1 }, 500, 0.1, 0.001, 1);
  assert.ok(out.scrollTick >= 0);
});

test('wheel zoom factor is symmetric and bounded', () => {
  near(wheelZoomFactor(100) * wheelZoomFactor(-100), 1);
  assert.ok(wheelZoomFactor(-100) > 1 && wheelZoomFactor(100) < 1);
  assert.equal(wheelZoomFactor(100000), wheelZoomFactor(400));
});

test('clampScroll', () => {
  assert.equal(clampScroll(-5, 100, 50), 0);
  assert.equal(clampScroll(80, 100, 50), 50);
  assert.equal(clampScroll(20, 10, 50), 0);
});

test('key rows: key ↔ y and visible range', () => {
  const kv = { scrollY: 0, rowH: 10 };
  assert.equal(keyToY(kv, 127), 0);
  assert.equal(yToKey(kv, 0), 127);
  assert.equal(yToKey(kv, 9.99), 127);
  assert.equal(yToKey(kv, 10), 126);
  const kv2 = { scrollY: (127 - 72) * 10, rowH: 10 };
  assert.equal(yToKey(kv2, 0), 72);
  assert.deepEqual(visibleKeys(kv2, 100), [63, 72]);
  assert.deepEqual(visibleKeys({ scrollY: 0, rowH: 10 }, 5000), [0, 127]);
});

test('zoomRowsAt keeps the row under the cursor', () => {
  const kv = { scrollY: 500, rowH: 10 };
  const y = 137;
  const key = yToKey(kv, y);
  const z = zoomRowsAt(kv, y, 1.5, 6, 40);
  assert.equal(z.rowH, 15);
  assert.equal(yToKey(z, y), key);
});

test('lanes: variable heights, laneAt, visibleLanes', () => {
  const l = buildLanes(['a', 'b', 'c', 'd'], (id) => (id === 'b' ? 100 : 40));
  assert.deepEqual(l.tops, [0, 40, 140, 180]);
  assert.equal(l.total, 220);
  assert.equal(laneAt(l, -1), -1);
  assert.equal(laneAt(l, 0), 0);
  assert.equal(laneAt(l, 39.9), 0);
  assert.equal(laneAt(l, 40), 1);
  assert.equal(laneAt(l, 139), 1);
  assert.equal(laneAt(l, 219), 3);
  assert.equal(laneAt(l, 220), 4);
  assert.deepEqual(visibleLanes(l, 50, 100), [1, 2]);
  assert.deepEqual(visibleLanes(buildLanes([], () => 10), 0, 100), [0, -1]);
});

test('edge auto-scroll step', () => {
  assert.equal(edgeScrollStep(100, 0, 200), 0);
  assert.ok(edgeScrollStep(2, 0, 200) < 0);
  assert.ok(edgeScrollStep(199, 0, 200) > 0);
  assert.ok(edgeScrollStep(-500, 0, 200) >= -22);
});

test('snap grid sizes (4/4 and 6/8)', () => {
  assert.equal(snapTicks('bar', TS44), BAR);
  assert.equal(snapTicks('beat', TS44), PPQ);
  assert.equal(snapTicks('step', TS44), TICKS_PER_STEP);
  assert.equal(snapTicks('1/3', TS44), 320);
  assert.equal(snapTicks('1/16', TS44), 60);
  assert.equal(snapTicks('none', TS44), 1);
  const ts68 = { num: 6, den: 8 };
  assert.equal(snapTicks('bar', ts68), 480 * 6);
  assert.equal(snapTicks('beat', ts68), 480);
  assert.equal(SNAP_OPTIONS.length, 9);
});

test('snapTo modes', () => {
  assert.equal(snapTo(359, 240), 240);
  assert.equal(snapTo(361, 240), 480);
  assert.equal(snapTo(479, 240, 'floor'), 240);
  assert.equal(snapTo(241, 240, 'ceil'), 480);
  assert.equal(snapTo(959.99999999, 960, 'floor'), 960);
  assert.equal(snapTo(12.6, 1), 13);
});

test('cellStart places notes at the start of the clicked cell; Alt = free', () => {
  assert.equal(cellStart(470, 240), 240);
  assert.equal(cellStart(470, 240, true), 470);
  assert.equal(cellStart(-5, 240), 0);
});

test('snapMoveDelta snaps the grabbed item, keeps all starts >= 0', () => {
  assert.equal(snapMoveDelta(250, 200, 240, 250), 230);
  assert.equal(snapMoveDelta(250, 200, 240, 250, true), 200);
  assert.equal(snapMoveDelta(960, -5000, 240, 480), -480);
});

test('resize edges snap with a one-cell minimum', () => {
  assert.equal(snapResizeEnd(0, 500, 240), 480);
  assert.equal(snapResizeEnd(480, 300, 240), 240);
  assert.equal(snapResizeEnd(0, 7, 240, true), 7);
  assert.deepEqual(snapResizeStart(960, 230, 240), { start: 240, len: 720 });
  assert.deepEqual(snapResizeStart(960, 950, 240), { start: 720, len: 240 });
  assert.deepEqual(snapResizeStart(100, -50, 240), { start: 0, len: 100 });
});

function note(id: string, tick: number, dur: number, key: number): Note {
  return defaultNote({ id, tick, dur, key });
}

test('SpanIndex query = brute force overlap (culling correctness)', () => {
  const items: Note[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) items.push(note(`n${i}`, Math.floor(rnd() * 100000), 1 + Math.floor(rnd() * 5000), 40));
  const idx = new SpanIndex(items, (n) => n.tick, (n) => n.dur);
  for (const [t0, t1] of [
    [0, 100],
    [5000, 9000],
    [99000, 120000],
    [42000, 42001],
  ]) {
    const got = new Set<string>();
    idx.query(t0, t1, (n) => void got.add(n.id));
    const want = new Set(items.filter((n) => n.tick < t1 && n.tick + n.dur > t0).map((n) => n.id));
    assert.deepEqual([...got].sort(), [...want].sort(), `range ${t0}-${t1}`);
  }
  assert.equal(idx.lastEnd(), Math.max(...items.map((n) => n.tick + n.dur)));
});

test('edgeZone: edges are ±px, capped at a third of the width', () => {
  assert.equal(edgeZone(102, 100, 200, 5), 'left');
  assert.equal(edgeZone(150, 100, 200, 5), 'body');
  assert.equal(edgeZone(197, 100, 200, 5), 'right');
  assert.equal(edgeZone(104.5, 100, 109, 5), 'body');
});

test('hitNote finds the note under (tick, key) with zones; later notes win', () => {
  const ns = [note('a', 0, 960, 60), note('b', 960, 480, 60), note('c', 480, 960, 62)];
  const idx = new SpanIndex(ns, (n) => n.tick, (n) => n.dur);
  const px = 0.1;
  assert.equal(hitNote(idx, 300, 60, px)?.note.id, 'a');
  assert.equal(hitNote(idx, 300, 60, px)?.zone, 'body');
  assert.equal(hitNote(idx, 950, 60, px)?.zone, 'right');
  assert.equal(hitNote(idx, 1000, 60, px)?.note.id, 'b');
  assert.equal(hitNote(idx, 300, 61, px), null);
  assert.equal(hitNote(idx, 600, 62, px)?.note.id, 'c');
  assert.equal(hitNote(idx, 300, 60, px, 5, new Set(['a'])), null);
  const ov = new SpanIndex([note('x', 0, 960, 60), note('y', 480, 960, 60)], (n) => n.tick, (n) => n.dur);
  assert.equal(hitNote(ov, 600, 60, px)?.note.id, 'y');
});

test('notesInRect (marquee) is inclusive on keys, overlap on time', () => {
  const ns = [note('a', 0, 240, 60), note('b', 960, 240, 64), note('c', 2000, 240, 70)];
  const idx = new SpanIndex(ns, (n) => n.tick, (n) => n.dur);
  assert.deepEqual(notesInRect(idx, 100, 1000, 64, 60).map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(notesInRect(idx, 1000, 100, 70, 61).map((n) => n.id), ['b']);
});

test('hitClip with edge zones', () => {
  const clips = [
    { id: 'p', start: 0, length: 3840 },
    { id: 'q', start: 3840, length: 3840 },
  ];
  const idx = new SpanIndex(clips, (c) => c.start, (c) => c.length);
  const px = 0.02;
  assert.equal(hitClip(idx, 100, px)?.clip.id, 'p');
  assert.equal(hitClip(idx, 100, px)?.zone, 'left');
  assert.equal(hitClip(idx, 2000, px)?.zone, 'body');
  assert.equal(hitClip(idx, 3800, px)?.zone, 'right');
  assert.equal(hitClip(idx, 4000, px)?.clip.id, 'q');
  assert.equal(hitClip(idx, 99999, px), null);
  assert.equal(hitClip(undefined, 0, px), null);
});

test('nearestPoint picks the closest within the radius', () => {
  const pts = [
    { x: 10, y: 10 },
    { x: 20, y: 10 },
  ];
  assert.equal(nearestPoint(pts, 18, 11, 6), 1);
  assert.equal(nearestPoint(pts, 50, 50, 6), -1);
});

test('gridLevels: lines are never denser than ~7px', () => {
  for (const px of [0.0005, 0.002, 0.01, 0.03, 0.1, 1]) {
    const L = gridLevels(px, TS44);
    assert.ok(L.unit * px >= 7 || L.unit === L.bar * L.barEvery, `px=${px}`);
    assert.ok(L.bar * L.barEvery * px >= 12 || L.barEvery >= 4096);
  }
  assert.equal(gridLevels(0.1, TS44).unit, TICKS_PER_STEP);
  assert.equal(gridLevels(0.01, TS44).unit, PPQ);
});

test('note clipboard is relative and pastes at any tick', () => {
  const cb = makeNoteClipboard([note('a', 960, 240, 60), note('b', 1440, 480, 64)])!;
  assert.equal(cb.span, 960);
  assert.deepEqual(cb.notes.map((n) => n.tick), [0, 480]);
  const pasted = pasteNotes(cb, 3840);
  assert.deepEqual(pasted.map((n) => [n.tick, n.key, n.dur]), [
    [3840, 60, 240],
    [4320, 64, 480],
  ]);
  assert.equal(makeNoteClipboard([]), null);
});

test('duplicateShift rounds the span up to the grid', () => {
  assert.equal(duplicateShift(0, 3840, 960), 3840);
  assert.equal(duplicateShift(0, 480, 960), 960);
  assert.equal(duplicateShift(240, 3900, 3840), 3840);
  assert.equal(duplicateShift(0, 700, 1), 700);
});

test('changedIds finds added + replaced entries only', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const prev = { a, b };
  const next = { a, b: { id: 'b' }, c: { id: 'c' } };
  assert.deepEqual(changedIds(prev, next).sort(), ['b', 'c']);
  assert.deepEqual(changedIds(prev, prev), []);
  assert.deepEqual(changedIds(undefined, { a }), ['a']);
  assert.deepEqual(changedIds(prev, undefined), []);
});

test('GlowTracker fades and prunes', () => {
  const g = new GlowTracker();
  g.mark(['x'], 1000, 1000);
  assert.equal(g.alpha('x', 1000, 1000), 1);
  near(g.alpha('x', 1500, 1000), 0.5);
  assert.equal(g.alpha('y', 1500, 1000), 0);
  assert.equal(g.active(1500), true);
  assert.equal(g.active(2500), false);
  assert.equal(g.size, 0);
});

await run('editors');
