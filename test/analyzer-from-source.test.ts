// Instruments made of the transcribed audio (electron/analyzer/fromSource.ts): every note gets its own SFZ region on
// the source copy and a velocity that picks exactly that region, so the converted pattern replays the original.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { JOIN_SEC, MAX_HIT_SEC, PRE_SEC, SOURCE_WAV, TAIL_SEC, drumEvents, monoEvents, shareRegions, slotOf, sourceInstrument } from '../electron/analyzer/fromSource';

type Region = { lokey: number; hikey: number; center: number; lovel: number; hivel: number; offset: number; end: number };

/** Parse what we write: <group> key opcodes, then <region> velocity / range opcodes. */
function parse(sfz: string): Region[] {
  const out: Region[] = [];
  let g: Record<string, number> = {};
  for (const line of sfz.split('\n')) {
    const op = (name: string) => Number(new RegExp(`\\b${name}=(-?\\d+)`).exec(line)?.[1]);
    if (line.startsWith('<group>')) g = { lokey: op('lokey'), hikey: op('hikey'), center: op('pitch_keycenter') };
    if (line.startsWith('<region>')) {
      assert.match(line, new RegExp(`sample=${SOURCE_WAV}\\b`));
      out.push({ lokey: g.lokey, hikey: g.hikey, center: g.center, lovel: op('lovel'), hivel: op('hivel'), offset: op('offset'), end: op('end') });
    }
  }
  return out;
}

/** The region the engine plays for a note: key in range, round(vel × 127) (min 1) in lovel..hivel. */
function play(regions: Region[], key: number, vel: number): Region[] {
  const v = Math.max(1, Math.round(vel * 127));
  return regions.filter((r) => key >= r.lokey && key <= r.hikey && v >= r.lovel && v <= r.hivel);
}

test('every note plays its own original audio; edited notes still find a recording', () => {
  const sr = 48000;
  const notes = [
    { startSec: 1.0, durSec: 0.2, key: 36, vel: 0.9 },
    { startSec: 1.2, durSec: 0.25, key: 48, vel: 0.8 },
    { startSec: 1.45, durSec: 0.2, key: 36, vel: 0.5 },
    { startSec: 2.5, durSec: 0.3, key: 39, vel: 0.7 },
    { startSec: 2.8, durSec: 0.1, key: 36, vel: 0.95 },
  ];
  const ev = monoEvents(notes, 10);
  assert.equal(ev[0].untilSec, 1.2 + JOIN_SEC, 'runs into the next note by JOIN_SEC');
  assert.ok(Math.abs(ev[2].untilSec - (1.65 + TAIL_SEC)) < 1e-9, 'the next note is far: the tail');
  const inst = sourceInstrument(ev, { sampleRate: sr, frames: 10 * sr, name: 'Bass' });
  const regions = parse(inst.sfz);
  assert.equal(inst.regions, 5);
  assert.equal(regions.length, 5);
  notes.forEach((n, i) => {
    const hit = play(regions, n.key, inst.vel[i]);
    assert.equal(hit.length, 1, `note ${i} plays exactly one region`);
    assert.equal(hit[0].center, n.key, 'unpitched');
    assert.equal(hit[0].offset, Math.round((n.startSec - PRE_SEC) * sr), `note ${i} plays its own start`);
    assert.equal(hit[0].end, Math.round(ev[i].untilSec * sr));
  });
  // Quieter originals sit on lower slots.
  assert.ok(inst.vel[2] < inst.vel[0] && inst.vel[0] < inst.vel[4]);
  // Key ranges cover 0..127 without overlap; any key and velocity finds exactly one region.
  for (let k = 0; k <= 127; k++) for (const v of [0, 0.2, 0.5, 0.78, 1]) assert.equal(play(regions, k, v).length, 1, `key ${k} vel ${v}`);
  assert.equal(play(regions, 37, 0.78)[0].center, 36, 'a transposed note plays the nearest recording, pitched');
  assert.equal(play(regions, 44, 0.5)[0].center, 48);
});

test('more than 127 notes on one key share regions; velocity slots are unique and ordered', () => {
  assert.equal(slotOf(0, 1), 100);
  assert.deepEqual([slotOf(0, 3), slotOf(1, 3), slotOf(2, 3)], [1, 64, 127]);
  const notes = Array.from({ length: 300 }, (_, i) => ({ startSec: i * 0.2, durSec: 0.1 + (i % 7) * 0.01, key: 40, vel: (i % 50) / 50 }));
  const ev = monoEvents(notes, 100);
  const inst = sourceInstrument(ev, { sampleRate: 44100, frames: 100 * 44100, name: 'x' });
  const regions = parse(inst.sfz);
  assert.equal(regions.length, 127);
  const lows = regions.map((r) => r.lovel);
  assert.deepEqual(lows, [...lows].sort((a, b) => a - b));
  notes.forEach((_, i) => assert.equal(play(regions, 40, inst.vel[i]).length, 1));
});

test('drums: simultaneous hits merge into the loudest; each slice runs to the next hit', () => {
  const hits = [
    { timeSec: 1.0, role: 'kick', vel: 0.9 },
    { timeSec: 1.004, role: 'hat', vel: 0.3 },
    { timeSec: 1.25, role: 'hat', vel: 0.4 },
    { timeSec: 1.5, role: 'snare', vel: 0.5 },
    { timeSec: 1.51, role: 'kick', vel: 0.8 },
    { timeSec: 9.0, role: 'kick', vel: 0.7 },
    { timeSec: 50, role: 'kick', vel: 1 },
  ];
  const ev = drumEvents(hits, 12);
  assert.deepEqual(ev.map((e) => [e.role, e.event.startSec]), [
    ['kick', 1.0],
    ['hat', 1.25],
    ['kick', 1.5],
    ['kick', 9.0],
  ]);
  assert.ok(Math.abs(ev[0].event.untilSec - (1.25 - PRE_SEC)) < 1e-9);
  assert.equal(ev[2].event.untilSec, 1.5 + MAX_HIT_SEC, 'a long silence: capped');
  assert.equal(ev[3].event.untilSec, 11, 'capped by MAX_HIT_SEC');
  const kicks = ev.filter((e) => e.role === 'kick');
  const inst = sourceInstrument(kicks.map((k) => k.event), { sampleRate: 48000, frames: 12 * 48000, name: 'Kick' });
  const regions = parse(inst.sfz);
  kicks.forEach((k, i) => assert.equal(play(regions, 60, inst.vel[i])[0].offset, Math.round((k.event.startSec - PRE_SEC) * 48000)));
});

test('crowded keys share regions by sound when timbres are known: a hit never borrows a different-sounding slice', () => {
  // 400 hits of one drum: three sounds (a loop's kick, a ghost kick, a kick under a clap), loudness noisy.
  const kinds = [[0, -6, -20, -30, -40, -50], [-12, -10, -25, -35, -45, -55], [0, -6, -8, -10, -12, -20]];
  const events = Array.from({ length: 400 }, (_, i) => ({ startSec: i * 0.3, untilSec: i * 0.3 + 0.2 + (i % 5) * 0.01, key: 60, vel: ((i * 37) % 100) / 100 }));
  const kind = (i: number) => (i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0);
  const features = events.map((_, i) => kinds[kind(i)].map((v, k) => v + ((i * 13 + k * 7) % 5) * 0.2));
  const groups = shareRegions(events.map((_, i) => i), events, features);
  assert.equal(groups.length, 127);
  assert.equal(groups.reduce((n, g) => n + g.members.length, 0), 400, 'every hit has a region');
  for (const g of groups) for (const m of g.members) assert.equal(kind(m), kind(g.rep), `hit ${m} plays slice ${g.rep}`);
  // Without timbres: velocity bands (each band's longest slice).
  const bands = shareRegions(events.map((_, i) => i), events);
  assert.equal(bands.length, 127);
  for (const g of bands) assert.ok(g.members.includes(g.rep));
  // The instrument uses them: every event still finds exactly one region.
  const inst = sourceInstrument(events, { sampleRate: 48000, frames: 200 * 48000, name: 'k', features });
  const regions = parse(inst.sfz);
  events.forEach((_, i) => assert.equal(play(regions, 60, inst.vel[i]).length, 1));
});

run('analyzer from source');
