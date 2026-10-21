import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { GR_PLUGINS, SCOPE_BINS, hasGrMeter, scopeBinHz, slotKey } from '@shared/engine/meters';
import type { TelemetryFrame } from '@shared/engine/protocol';
import {
  EQ_BANDS,
  bandResponseDb,
  dbToY,
  designSvf,
  eqResponseDb,
  freqToX,
  svfMagnitude,
  xToFreq,
  yToDb,
  type EqParams,
} from '../src/panels/plugin/eqResponse';
import { GrBallistics, SpectrumSmoother, formatGr, formatLevel, grToMeter, readSlotScope, watchSet } from '../src/live/slotMeters';
import { dynamicsLine, dynamicsReport } from '../electron/mcp/tools/dynamics';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≉ ${b} (±${tol})`);

const eqSpec = CATALOG.plugins.find((p) => p.id === 'krypt.eq')!;
const paramsOf = (vals: Record<string, number>): EqParams => (id) => vals[id] ?? eqSpec.params.find((p) => p.id === id)!.default;

test('EQ response matches the engine (Rust reference values)', () => {
  const p = paramsOf({
    b1On: 1, b1Freq: 80, b1Slope: 1,
    b2Freq: 200, b2Gain: 4, b2Q: 0.7,
    b3Freq: 400, b3Gain: -6, b3Q: 2,
    b4Freq: 1500, b4Gain: 3, b4Q: 1,
    b6Freq: 10000, b6Gain: -3, b6Q: 0.7,
    b7On: 1, b7Freq: 16000, b7Slope: 0,
    output: 2,
  });
  const freqs = [30, 80, 200, 400, 1000, 1500, 5000, 10000, 16000, 20000];
  const ref = [-28.091401, 2.813753, 3.418132, -3.510774, 3.427807, 4.87138, 2.138428, 0.385178, -3.876857, -14.522336];
  eqResponseDb(p, freqs, 48000).forEach((db, i) => near(db, ref[i], 1e-3, `${freqs[i]} Hz`));
});

test('EQ sections: exact bell gain at the centre, Butterworth −3 dB at the cutoff, flat defaults', () => {
  for (const g of [-12, -3, 6, 18]) near(20 * Math.log10(svfMagnitude(designSvf('bell', 1000, 1.5, g, 48000), 1000, 48000)), g, 1e-9, `bell ${g}`);
  near(20 * Math.log10(svfMagnitude(designSvf('highpass', 500, Math.SQRT1_2, 0, 48000), 500, 48000)), -3.0103, 1e-3, 'hp');
  near(20 * Math.log10(svfMagnitude(designSvf('lowShelf', 100, 0.7, 9, 48000), 20, 48000)), 9, 0.3, 'shelf');
  const lowCut = EQ_BANDS[0];
  const p = paramsOf({ b1On: 1, b1Freq: 400, b1Slope: 1 });
  near(bandResponseDb(lowCut, p, 400, 48000), -3.0103, 1e-3, 'cut');
  near(bandResponseDb(lowCut, p, 200, 48000), -24.1, 0.3, 'octave');
  for (const db of eqResponseDb(paramsOf({}), [20, 100, 1000, 10000, 20000], 48000)) near(db, 0, 1e-9, 'flat');
  near(bandResponseDb(EQ_BANDS[2], paramsOf({ b3On: 0, b3Gain: 12, b3Freq: 1000 }), 1000, 48000), 0, 1e-12, 'off');
});

test('EQ curve geometry round-trips', () => {
  near(freqToX(20, 600), 0, 1e-9);
  near(freqToX(20000, 600), 600, 1e-9);
  near(freqToX(632.456, 600), 300, 0.01);
  near(xToFreq(freqToX(1234, 777), 777), 1234, 1e-6);
  near(dbToY(0, 200, 24), 100, 1e-9);
  near(yToDb(dbToY(-7.5, 200, 24), 200, 24), -7.5, 1e-9);
  assert.equal(dbToY(99, 200, 24), 0);
});

test('GR meter scaling and readout', () => {
  assert.equal(grToMeter(0), 0);
  assert.equal(grToMeter(-3), 0);
  assert.equal(grToMeter(NaN), 0);
  near(grToMeter(12), 0.5, 1e-12);
  assert.equal(grToMeter(30), 1);
  near(grToMeter(3, 6), 0.5, 1e-12);
  assert.equal(formatGr(4.24), '-4.2');
  assert.equal(formatGr(0.01), '0.0');
  assert.equal(formatLevel(null), '-inf');
  assert.equal(formatLevel(-14.04), '-14.0');
  for (const id of Object.keys(GR_PLUGINS)) assert.ok(CATALOG.plugins.some((p) => p.id === id), `${id} is a stock effect`);
  assert.ok(hasGrMeter('krypt.comp') && hasGrMeter('krypt.limiter') && !hasGrMeter('krypt.eq') && !hasGrMeter('toString'));
});

test('GR ballistics: instant attack, 40 dB/s fall, peak hold, time-based (several readers per frame)', () => {
  const b = new GrBallistics(40, 1500);
  b.ingest({ 'i/a': 6 }, 0);
  assert.deepEqual(b.read('i/a', 0), [6, 6]);
  assert.deepEqual(b.read('i/a', 0), [6, 6], 'a second reader in the same frame sees the same value');
  b.ingest({}, 16);
  const [shown, hold] = b.read('i/a', 100);
  near(shown, 2, 1e-9, 'fell 4 dB in 100 ms');
  assert.equal(hold, 6);
  assert.deepEqual(b.read('i/b', 100), [0, 0], 'unknown slot');
  const [, held] = b.read('i/a', 1700);
  assert.equal(held, 0, 'hold expires');
});

test('spectrum smoother: rises at once, falls at its rate, holds peaks', () => {
  const s = new SpectrumSmoother(30, 1000, -100);
  s.push([-20, -40, -200], 0);
  assert.deepEqual([...s.shown], [-20, -40, -100]);
  s.push([-50, -10, -100], 10);
  assert.deepEqual([...s.shown], [-20, -10, -100]);
  s.decay(0.5, 500);
  near(s.shown[0], -35, 1e-4);
  assert.equal(s.peak[0], -20, 'peak held');
  s.decay(0.5, 1200);
  near(s.peak[0], -35, 1e-4, 'peak falls after the hold');
});

test('telemetry: a watched slot is read from the frame, junk is rejected', () => {
  const key = slotKey('ins1', 'slotA');
  assert.equal(key, 'ins1/slotA');
  const frame = {
    t: 'frame',
    gr: { 'ins1/comp': 3.2 },
    scopes: {
      [key]: { lufsM: -14.2, lufsS: -15, lufsI: null, truePeak: -1.3, correlation: 0.92, spectrum: Array(SCOPE_BINS).fill(-60), scope: [0, 0.1, -0.1] },
      'ins1/bad': { lufsM: 'loud', spectrum: [1, 'x'] },
    },
  } as unknown as TelemetryFrame;
  const d = readSlotScope(frame, key)!;
  assert.equal(d.lufsM, -14.2);
  assert.equal(d.lufsI, null);
  assert.equal(d.spectrum!.length, SCOPE_BINS);
  assert.deepEqual(d.scope, [0, 0.1, -0.1]);
  const bad = readSlotScope(frame, 'ins1/bad')!;
  assert.equal(bad.lufsM, null);
  assert.equal(bad.spectrum, undefined);
  assert.equal(readSlotScope(frame, 'nope'), null);
  assert.equal(readSlotScope(null, key), null);
  assert.deepEqual(watchSet(new Map([['b', 1], ['a', 2], ['c', 0]])), ['a', 'b']);
  near(scopeBinHz(0), 20 * Math.pow(1000, 0.5 / SCOPE_BINS), 1e-9);
  near(scopeBinHz(SCOPE_BINS - 1), 20000 / Math.pow(1000, 0.5 / SCOPE_BINS), 1e-6);
});

test('render_preview dynamics report: measured GR per dynamics slot, "never reduced" for idle ones', () => {
  const host = new DocHost(createDefaultProject('Dyn'), CATALOG, { strict: true });
  const p0 = host.project;
  const ins = p0.mixer.insertOrder.find((id) => !p0.mixer.inserts[id].isMaster)!;
  const comp = host.exec<{ id: string }>('mixer.addSlot', { insertId: ins, type: 'krypt.comp' }, { actor: USER });
  const eq = host.exec<{ id: string }>('mixer.addSlot', { insertId: ins, type: 'krypt.eq' }, { actor: USER });
  const lim = host.exec<{ id: string }>('mixer.addSlot', { insertId: p0.mixer.masterId, type: 'krypt.limiter' }, { actor: USER });
  assert.ok(comp.ok && eq.ok && lim.ok, comp.message);
  const compId = comp.data!.id;
  const p = host.project;
  assert.equal(dynamicsReport(p, CATALOG, undefined), null, 'older engine: nothing to report');
  const rows = dynamicsReport(p, CATALOG, [{ insertId: ins, slotId: compId, avgDb: 3.14, maxDb: 7.06, active: 0.42 }])!;
  const masterLimiters = p.mixer.inserts[p.mixer.masterId].slotOrder.filter((s) => p.mixer.inserts[p.mixer.masterId].slots[s].type === 'krypt.limiter');
  assert.equal(rows.length, 1 + masterLimiters.length, 'comp + the master limiter(s), not the EQ');
  const c = rows.find((r) => r.effect === 'Krypt Comp')!;
  assert.deepEqual([c.avgDb, c.maxDb, c.activePct], [3.1, 7.1, 42]);
  const line = dynamicsLine(rows);
  assert.match(line, /^dynamics {2}/);
  assert.match(line, /Krypt Comp \(slot \d+\) GR avg 3\.1 \/ max 7\.1 dB, >1 dB 42% of the time/);
  assert.match(line, /Master ▸ Krypt Limiter \(slot \d+\) never reduced/);
  assert.equal(dynamicsLine([]), '');
});

void run('meters');
