import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { SCHEMA_VERSION, zProject, type Note } from '@shared/schema/project';
import { PPQ } from '@shared/schema/time';
import { arpSequence, lfoWave, seededRandom, swungGridLine } from '@shared/commands/noteTools';
import { projectPatches } from '@shared/engine/projection';
import { validateProject } from '../electron/project/migrations';

function fresh() {
  const p = createDefaultProject('Tools');
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const ch = p.channelOrder[5];
  return { host, pat, ch };
}

type In = { tick: number; key: number; dur?: number; vel?: number };

function setup(notes: In[]) {
  const f = fresh();
  const r = f.host.exec<{ ids: string[] }>('notes.replace', { patternId: f.pat, channelId: f.ch, notes }, { actor: USER });
  assert.equal(r.ok, true, r.message);
  const exec = <T = unknown>(cmd: string, args: Record<string, unknown>) => f.host.exec<T>(cmd, { patternId: f.pat, channelId: f.ch, ...args }, { actor: USER });
  const list = (): Note[] =>
    Object.values(f.host.project.patterns[f.pat].notes[f.ch] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);
  return { ...f, ids: r.data!.ids, exec, list };
}

const brief = (ns: Note[]) => ns.map((n) => [n.tick, n.key, n.dur]);

test('quantize starts keeps length; strength pulls part way; ends snaps lengths', () => {
  const s = setup([
    { tick: 250, key: 60, dur: 200 },
    { tick: 470, key: 62, dur: 100 },
  ]);
  assert.equal(s.exec('notes.quantize', { grid: 240 }).ok, true);
  assert.deepEqual(brief(s.list()), [
    [240, 60, 200],
    [480, 62, 100],
  ]);
  const t = setup([{ tick: 100, key: 60, dur: 100 }]);
  t.exec('notes.quantize', { grid: 240, strength: 0.5 });
  assert.deepEqual(brief(t.list()), [[50, 60, 100]]);
  const e = setup([{ tick: 0, key: 60, dur: 200 }]);
  e.exec('notes.quantize', { grid: 240, starts: false, ends: true });
  assert.deepEqual(brief(e.list()), [[0, 60, 240]]);
  const z = setup([{ tick: 0, key: 60, dur: 30 }]);
  z.exec('notes.quantize', { grid: 240, ends: true });
  assert.deepEqual(brief(z.list()), [[0, 60, 240]]);
  assert.equal(s.exec('notes.quantize', { grid: 240, starts: false, ends: false }).ok, false);
});

test('quantize with swing targets delayed odd grid lines', () => {
  assert.equal(swungGridLine(250, 240, 0.5), 300);
  assert.equal(swungGridLine(470, 240, 0.5), 480);
  const s = setup([{ tick: 230, key: 60, dur: 100 }]);
  s.exec('notes.quantize', { grid: 240, swing: 1 });
  assert.equal(s.list()[0].tick, 360);
  assert.equal(s.host.getHistory().length, 2, 'one undo step per tool');
});

test('chop into pieces and by grid keeps properties and returns every piece', () => {
  const s = setup([{ tick: 0, key: 60, dur: 960, vel: 0.5 }]);
  const r = s.exec<{ ids: string[] }>('notes.chop', { mode: 'pieces', pieces: 3 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.ids.length, 3);
  assert.deepEqual(brief(s.list()), [
    [0, 60, 320],
    [320, 60, 320],
    [640, 60, 320],
  ]);
  assert.ok(s.list().every((n) => n.vel === 0.5));
  const g = setup([{ tick: 100, key: 64, dur: 500 }]);
  g.exec('notes.chop', { mode: 'grid', grid: 240 });
  assert.deepEqual(brief(g.list()), [
    [100, 64, 140],
    [240, 64, 240],
    [480, 64, 120],
  ]);
  const short = setup([{ tick: 0, key: 60, dur: 120 }]);
  const bad = short.exec('notes.chop', { mode: 'grid', grid: 240 });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /Nothing to chop/);
});

test('glue merges touching same-pitch notes; legato fills gaps to the next position', () => {
  const s = setup([
    { tick: 0, key: 60, dur: 240 },
    { tick: 240, key: 60, dur: 240 },
    { tick: 600, key: 60, dur: 240 },
    { tick: 240, key: 62, dur: 100 },
  ]);
  const r = s.exec<{ removed: number }>('notes.glue', {});
  assert.equal(r.data!.removed, 1);
  assert.deepEqual(brief(s.list()), [
    [0, 60, 480],
    [240, 62, 100],
    [600, 60, 240],
  ]);
  s.exec('notes.glue', { gap: 120 });
  assert.deepEqual(brief(s.list()), [
    [0, 60, 840],
    [240, 62, 100],
  ]);
  const l = setup([
    { tick: 0, key: 60, dur: 50 },
    { tick: 0, key: 64, dur: 50 },
    { tick: 480, key: 62, dur: 50 },
    { tick: 960, key: 65, dur: 50 },
  ]);
  l.exec('notes.legato', { gap: 10 });
  assert.deepEqual(brief(l.list()), [
    [0, 60, 470],
    [0, 64, 470],
    [480, 62, 470],
    [960, 65, 50],
  ]);
  assert.equal(setup([{ tick: 0, key: 60 }]).exec('notes.legato', {}).ok, false);
});

test('strum spreads chords up / down / alternate, keeping ends by default', () => {
  const chord = [
    { tick: 0, key: 60, dur: 960 },
    { tick: 0, key: 64, dur: 960 },
    { tick: 5, key: 67, dur: 955 },
  ];
  const s = setup(chord);
  assert.equal(s.exec('notes.strum', { time: 120 }).ok, true);
  const byKey = (ns: Note[]) => Object.fromEntries(ns.map((n) => [n.key, [n.tick, n.dur]]));
  assert.deepEqual(byKey(s.list()), { 60: [0, 960], 64: [60, 900], 67: [120, 840] });
  const d = setup(chord);
  d.exec('notes.strum', { time: 120, direction: 'down', keepEnds: false });
  assert.deepEqual(byKey(d.list()), { 67: [0, 955], 64: [60, 960], 60: [120, 960] });
  const alt = setup([...chord, { tick: 960, key: 60, dur: 100 }, { tick: 960, key: 64, dur: 100 }]);
  alt.exec('notes.strum', { time: 100, direction: 'alternate' });
  const second = alt.list().filter((n) => n.tick >= 960);
  assert.deepEqual(second.map((n) => [n.key, n.tick]), [
    [64, 960],
    [60, 1060],
  ]);
  assert.equal(setup([{ tick: 0, key: 60 }]).exec('notes.strum', { time: 60 }).ok, false);
});

test('arpeggiate: patterns, rate, gate, octaves, chord expansion, seeded random', () => {
  assert.deepEqual(arpSequence([60, 64, 67], 'up'), [60, 64, 67]);
  assert.deepEqual(arpSequence([60, 64, 67], 'down'), [67, 64, 60]);
  assert.deepEqual(arpSequence([60, 64, 67], 'upDown'), [60, 64, 67, 64]);
  assert.deepEqual(arpSequence([60, 64, 67], 'downUp'), [67, 64, 60, 64]);
  const s = setup([
    { tick: 0, key: 60, dur: 960, vel: 0.5 },
    { tick: 0, key: 64, dur: 960, vel: 0.9 },
    { tick: 0, key: 67, dur: 960, vel: 0.7 },
  ]);
  const r = s.exec<{ ids: string[] }>('notes.arpeggiate', { pattern: 'upDown', rate: 240, gate: 0.5 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.ids.length, 4);
  assert.deepEqual(brief(s.list()), [
    [0, 60, 120],
    [240, 64, 120],
    [480, 67, 120],
    [720, 64, 120],
  ]);
  assert.deepEqual(s.list().map((n) => n.vel), [0.5, 0.9, 0.7, 0.9]);
  const o = setup([{ tick: 0, key: 60, dur: 960 }]);
  o.exec('notes.arpeggiate', { rate: 120, octaves: 2, chord: 'm' });
  assert.deepEqual(o.list().map((n) => n.key), [60, 63, 67, 72, 75, 79, 60, 63]);
  const r1 = setup([{ tick: 0, key: 60, dur: 1920 }, { tick: 0, key: 64, dur: 1920 }, { tick: 0, key: 67, dur: 1920 }]);
  const r2 = setup([{ tick: 0, key: 60, dur: 1920 }, { tick: 0, key: 64, dur: 1920 }, { tick: 0, key: 67, dur: 1920 }]);
  r1.exec('notes.arpeggiate', { pattern: 'random', rate: 120, seed: 42 });
  r2.exec('notes.arpeggiate', { pattern: 'random', rate: 120, seed: 42 });
  const k1 = r1.list().map((n) => n.key);
  assert.deepEqual(k1, r2.list().map((n) => n.key), 'same seed → same arp');
  assert.equal(k1.length, 16);
  for (let i = 1; i < k1.length; i++) assert.notEqual(k1[i], k1[i - 1], 'random arp never repeats a key back to back');
  assert.equal(o.exec('notes.arpeggiate', { chord: 'nope' }).ok, false);
});

test('randomize is reproducible, bounded and stays in the scale', () => {
  const notes = Array.from({ length: 16 }, (_, i) => ({ tick: i * 240, key: 60 + (i % 7), dur: 200, vel: 0.5 }));
  const a = setup(notes);
  const b = setup(notes);
  const args = { seed: 7, vel: 0.2, timing: 30, pitch: 2, scale: { root: 0, scale: 'major' } };
  assert.equal(a.exec('notes.randomize', args).ok, true);
  b.exec('notes.randomize', args);
  assert.deepEqual(brief(a.list()), brief(b.list()));
  const major = [0, 2, 4, 5, 7, 9, 11];
  for (const n of a.list()) {
    assert.ok(n.vel >= 0.3 - 1e-9 && n.vel <= 0.7 + 1e-9, `vel ${n.vel}`);
    assert.ok(major.includes(n.key % 12), `key ${n.key} in C major`);
  }
  assert.notDeepEqual(brief(a.list()), brief(setup(notes).list()));
  assert.equal(a.exec('notes.randomize', { seed: 1 }).ok, false);
  const r = seededRandom(3);
  const xs = Array.from({ length: 1000 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('flip horizontal / vertical (also by scale degree)', () => {
  const s = setup([
    { tick: 0, key: 60, dur: 240 },
    { tick: 480, key: 67, dur: 480 },
  ]);
  s.exec('notes.flip', { axis: 'horizontal' });
  assert.deepEqual(brief(s.list()), [
    [0, 67, 480],
    [720, 60, 240],
  ]);
  s.exec('notes.flip', { axis: 'vertical' });
  assert.deepEqual(s.list().map((n) => n.key), [60, 67]);
  const sc = setup([
    { tick: 0, key: 60, dur: 240 },
    { tick: 240, key: 62, dur: 240 },
    { tick: 480, key: 67, dur: 240 },
  ]);
  sc.exec('notes.flip', { axis: 'vertical', scale: { root: 0, scale: 'major' } });
  assert.deepEqual(sc.list().map((n) => n.key), [67, 65, 60]);
});

test('scale snap, limit range and level shapes', () => {
  const s = setup([
    { tick: 0, key: 61, dur: 240 },
    { tick: 240, key: 63, dur: 240 },
    { tick: 480, key: 64, dur: 240 },
  ]);
  const r = s.exec<{ changed: number }>('notes.scaleSnap', { root: 0, scale: 'major' });
  assert.equal(r.data!.changed, 2);
  assert.deepEqual(s.list().map((n) => n.key), [60, 62, 64]);
  const up = setup([{ tick: 0, key: 61, dur: 240 }]);
  up.exec('notes.scaleSnap', { root: 0, scale: 'major', direction: 'up' });
  assert.equal(up.list()[0].key, 62);
  assert.equal(up.exec('notes.scaleSnap', { root: 0, scale: 'klingon' }).ok, false);

  const l = setup([
    { tick: 0, key: 36, dur: 240 },
    { tick: 240, key: 90, dur: 240 },
    { tick: 480, key: 62, dur: 240 },
  ]);
  l.exec('notes.limit', { low: 55, high: 72 });
  assert.deepEqual(l.list().map((n) => n.key), [60, 66, 62]);
  l.exec('notes.limit', { low: 61, high: 63, mode: 'clamp' });
  assert.deepEqual(l.list().map((n) => n.key), [61, 63, 62]);
  assert.equal(l.exec('notes.limit', { low: 70, high: 60 }).ok, false);

  const v = setup(Array.from({ length: 5 }, (_, i) => ({ tick: i * 240, key: 60, dur: 100 })));
  v.exec('notes.levels', { prop: 'vel', mode: 'ramp', from: 0, to: 1 });
  assert.deepEqual(v.list().map((n) => n.vel), [0, 0.25, 0.5, 0.75, 1]);
  v.exec('notes.levels', { prop: 'pan', mode: 'lfo', shape: 'square', period: 480, depth: 1, center: 0.5 });
  assert.deepEqual(v.list().map((n) => n.pan), [1, -1, 1, -1, 1]);
  v.exec('notes.levels', { prop: 'fine', mode: 'ramp', from: 0.5, to: 1, curve: 0 });
  assert.deepEqual(v.list().map((n) => n.fine), [0, 25, 50, 75, 100]);
  assert.equal(Math.round(lfoWave('triangle', 0.25) * 1000) / 1000, 1);
  assert.equal(lfoWave('saw', 0), -1);
});

test('setProps toggles mute and slide, sets colour groups, and the engine sees mute', () => {
  const s = setup([
    { tick: 0, key: 60, dur: 240 },
    { tick: 240, key: 62, dur: 240 },
  ]);
  const v0 = s.host.project;
  const r = s.exec<{ mute: boolean }>('notes.setProps', { ids: [s.ids[0]], mute: 'toggle' });
  assert.equal(r.data!.mute, true);
  assert.equal(s.host.project.patterns[s.pat].notes[s.ch][s.ids[0]].mute, true);
  s.exec('notes.setProps', { mute: 'toggle' });
  assert.ok(s.list().every((n) => n.mute === true));
  s.exec('notes.setProps', { mute: 'toggle' });
  assert.ok(s.list().every((n) => !('mute' in n)));
  s.exec('notes.setProps', { color: 5, slide: 'toggle' });
  assert.ok(s.list().every((n) => n.color === 5 && n.slide === true));
  s.exec('notes.setProps', { color: 0 });
  assert.ok(s.list().every((n) => !('color' in n)));
  assert.equal(s.exec('notes.setProps', { color: 16 }).ok, false);
  assert.equal(s.exec('notes.setProps', {}).ok, false);
  assert.equal(s.exec('notes.update', { updates: [{ id: s.ids[1], mute: true, color: 2 }] }).ok, true);
  const diff = projectPatches(s.host.project, [{ op: 'replace', path: ['patterns', s.pat, 'notes', s.ch, s.ids[1], 'mute'], value: true }]);
  const sent = diff.upserts[0].value as { notes: Record<string, Record<string, Note>> };
  assert.equal(sent.notes[s.ch][s.ids[1]].mute, true);
  assert.notEqual(v0, s.host.project);
});

test('every tool rejects a bad note id and an empty channel cleanly', () => {
  const s = setup([{ tick: 0, key: 60, dur: 240 }]);
  for (const [cmd, args] of [
    ['notes.quantize', { grid: 240 }],
    ['notes.chop', {}],
    ['notes.glue', {}],
    ['notes.legato', {}],
    ['notes.strum', { time: 100 }],
    ['notes.arpeggiate', {}],
    ['notes.randomize', { seed: 1, vel: 0.1 }],
    ['notes.flip', { axis: 'vertical' }],
    ['notes.scaleSnap', { root: 0, scale: 'minor' }],
    ['notes.limit', { low: 0, high: 127 }],
    ['notes.levels', {}],
    ['notes.setProps', { mute: true }],
  ] as const) {
    const v = s.host.version;
    const bad = s.exec(cmd, { ...args, ids: ['n_missing'] });
    assert.equal(bad.ok, false, cmd);
    assert.match(bad.message!, /not found/, cmd);
    assert.equal(s.host.version, v, `${cmd} left the doc untouched`);
  }
  const empty = fresh();
  const r = empty.host.exec('notes.quantize', { patternId: empty.pat, channelId: empty.ch, grid: 240 }, { actor: USER });
  assert.equal(r.ok, false);
  assert.match(r.message!, /No notes to quantize/);
});

test('schema: v1 files without mute/color/group still load; new fields round-trip and are validated', () => {
  const p = createDefaultProject('Mig');
  assert.equal(p.schemaVersion, SCHEMA_VERSION);
  const old = JSON.parse(JSON.stringify(p));
  const loaded = validateProject(old);
  assert.equal(Object.values(loaded.channels).some((c) => 'group' in c), false);

  const withNew = JSON.parse(JSON.stringify(p));
  const pat = withNew.transport.activePatternId;
  const ch = withNew.channelOrder[0];
  withNew.patterns[pat].notes[ch] = {
    n_a: { id: 'n_a', tick: 0, dur: 240, key: 60, vel: 0.8, pan: 0, release: 0.5, fine: 0, slide: false, modX: 0.5, modY: 0.5, mute: true, color: 7 },
  };
  withNew.channels[ch].group = 'Drums';
  const back = validateProject(withNew);
  assert.equal(back.patterns[pat].notes[ch].n_a.mute, true);
  assert.equal(back.patterns[pat].notes[ch].n_a.color, 7);
  assert.equal(back.channels[ch].group, 'Drums');
  assert.equal(zProject.safeParse(back).success, true);

  const bad = JSON.parse(JSON.stringify(withNew));
  bad.patterns[pat].notes[ch].n_a.color = 99;
  assert.throws(() => validateProject(bad), /damaged/);
  const badGroup = JSON.parse(JSON.stringify(withNew));
  badGroup.channels[ch].group = 'x'.repeat(40);
  assert.throws(() => validateProject(badGroup), /damaged/);
});

test('channels.set group: set, trim, clear back to automatic', () => {
  const { host } = fresh();
  const ch = host.project.channelOrder[0];
  assert.equal(host.exec('channels.set', { id: ch, group: '  Drums ' }, { actor: USER }).ok, true);
  assert.equal(host.project.channels[ch].group, 'Drums');
  host.exec('channels.set', { id: ch, group: null }, { actor: USER });
  assert.equal('group' in host.project.channels[ch], false);
  assert.equal(host.exec('channels.set', { id: ch, group: 'x'.repeat(33) }, { actor: USER }).ok, false);
  assert.equal(PPQ, 960);
});

void run('note tools');
