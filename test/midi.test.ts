import assert from 'node:assert/strict';
import { test, run } from './harness';
import { readSmf, writeSmf, convertPpq, SmfError, type SmfFile } from '@shared/midi/smf';
import { planMidiImport, patternToSmf } from '@shared/midi/convert';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';

/** Build an SMF byte array by hand: header + raw MTrk bodies. */
function rawSmf(format: number, ppq: number, bodies: number[][]): Uint8Array {
  const out: number[] = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, bodies.length, (ppq >> 8) & 0xff, ppq & 0xff];
  for (const b of bodies) {
    const n = b.length;
    out.push(0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...b);
  }
  return Uint8Array.from(out);
}

test('write → read round-trips notes, tempo, meter and names (format 1)', () => {
  const src: SmfFile = {
    format: 1,
    ppq: 960,
    tempos: [{ tick: 0, bpm: 128 }],
    timeSigs: [{ tick: 0, num: 3, den: 4 }],
    tracks: [
      { name: 'Lead', program: 81, notes: [{ tick: 0, dur: 480, key: 72, vel: 100, channel: 0 }, { tick: 480, dur: 240, key: 74, vel: 64, channel: 0 }] },
      { name: 'Bass', program: null, notes: [{ tick: 0, dur: 1920, key: 36, vel: 127, channel: 1 }] },
    ],
  };
  const back = readSmf(writeSmf(src));
  assert.equal(back.format, 1);
  assert.equal(back.ppq, 960);
  assert.equal(back.tracks.length, 3, 'conductor + 2 tracks');
  assert.equal(back.tracks[0].notes.length, 0);
  assert.equal(back.tracks[1].name, 'Lead');
  assert.equal(back.tracks[1].program, 81);
  assert.deepEqual(back.tracks[1].notes, src.tracks[0].notes);
  assert.deepEqual(back.tracks[2].notes, src.tracks[1].notes);
  assert.equal(Math.round(back.tempos[0].bpm * 1000) / 1000, 128);
  assert.deepEqual(back.timeSigs[0], { tick: 0, num: 3, den: 4 });
});

test('running status, note-on vel 0 as note-off, PPQ 96 → 960', () => {
  // Format 0, PPQ 96. Tempo 500000 µs (120 BPM). Note C4 at 0 for 96 ticks,
  // then E4 at 96 for 48 ticks written with running status + vel-0 note-off.
  const body = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xff, 0x03, 0x04, 0x50, 0x69, 0x61, 0x6e, // name "Pian"
    0x00, 0x90, 60, 100,
    0x60, 60, 0, // running status note-on vel 0 → off at 96
    0x00, 64, 90, // running status note-on at 96
    0x30, 0x80, 64, 0x40, // explicit note-off at 144
    0x00, 0xff, 0x2f, 0x00,
  ];
  const f = readSmf(rawSmf(0, 96, [body]));
  assert.equal(f.format, 0);
  assert.equal(f.ppq, 96);
  assert.equal(f.tracks[0].name, 'Pian');
  assert.equal(f.tempos[0].bpm, 120);
  assert.deepEqual(f.tracks[0].notes, [
    { tick: 0, dur: 96, key: 60, vel: 100, channel: 0 },
    { tick: 96, dur: 48, key: 64, vel: 90, channel: 0 },
  ]);
  const g = convertPpq(f, 960);
  assert.equal(g.ppq, 960);
  assert.deepEqual(
    g.tracks[0].notes.map((n) => [n.tick, n.dur]),
    [
      [0, 960],
      [960, 480],
    ],
  );
});

test('unterminated notes end at the track end; stray note-offs are ignored', () => {
  const body = [0x00, 0x90, 60, 100, 0x10, 0x80, 61, 0, 0x81, 0x00, 0xff, 0x2f, 0x00];
  // delta 0x81 0x00 = 128: end of track at tick 16 + 128 = 144
  const f = readSmf(rawSmf(0, 96, [body]));
  assert.deepEqual(f.tracks[0].notes, [{ tick: 0, dur: 144, key: 60, vel: 100, channel: 0 }]);
});

test('import plan splits a multi-channel format-0 track by channel and scales velocity', () => {
  const body = [0x00, 0x90, 60, 127, 0x00, 0x99, 36, 64, 0x60, 0x80, 60, 0, 0x00, 0x89, 36, 0, 0x00, 0xff, 0x2f, 0x00];
  const plan = planMidiImport(readSmf(rawSmf(0, 96, [body])));
  assert.equal(plan.tracks.length, 2);
  assert.equal(plan.tracks[0].name, 'MIDI 1 (ch 1)');
  assert.equal(plan.tracks[1].name, 'MIDI 1 (ch 10)');
  assert.deepEqual(plan.tracks[0].notes, [{ tick: 0, dur: 960, key: 60, vel: 1 }]);
  assert.equal(plan.tracks[1].notes[0].key, 36);
  assert.ok(Math.abs(plan.tracks[1].notes[0].vel - 64 / 127) < 1e-9);
  assert.equal(plan.noteCount, 2);
  assert.equal(plan.bpm, null);
});

test('pattern → SMF → import plan preserves notes (PPQ 960)', () => {
  const p = createDefaultProject('Midi');
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const [kick, , , , bass, keys] = p.channelOrder;
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60, dur: 240, vel: 1 }, { tick: 960, key: 60, dur: 240, vel: 0.5 }] }, { actor: USER });
  host.exec('notes.add', { patternId: pat, channelId: keys, notes: [{ tick: 120, key: 67, dur: 3000, vel: 0.78 }] }, { actor: USER });
  const smf = patternToSmf(host.project, pat);
  assert.equal(smf.tracks.length, 2, 'only channels with notes become tracks');
  assert.equal(smf.tracks[0].name, 'Kick');
  assert.equal(smf.tracks[1].name, 'Keys');
  assert.equal(smf.tempos[0].bpm, 140);
  assert.ok(!smf.tracks.some((t) => t.name === host.project.channels[bass].name));

  const plan = planMidiImport(readSmf(writeSmf(smf)));
  assert.equal(plan.bpm, 140);
  assert.deepEqual(plan.timeSig, { num: 4, den: 4 });
  assert.deepEqual(plan.tracks.map((t) => t.name), ['Kick', 'Keys']);
  assert.deepEqual(plan.tracks[0].notes.map((n) => [n.tick, n.dur, n.key, Math.round(n.vel * 127)]), [
    [0, 240, 60, 127],
    [960, 240, 60, 64],
  ]);
  assert.deepEqual(plan.tracks[1].notes.map((n) => [n.tick, n.dur, n.key]), [[120, 3000, 67]]);
});

test('import plan applies cleanly through DocHost commands', () => {
  const body = [0x00, 0xff, 0x03, 0x02, 0x48, 0x69, 0x00, 0x90, 48, 80, 0x83, 0x60, 0x80, 48, 0, 0x00, 0xff, 0x2f, 0x00];
  const plan = planMidiImport(readSmf(rawSmf(1, 480, [body])));
  const host = new DocHost(createDefaultProject('Imp'), CATALOG, { strict: true });
  const g = host.beginGroup(USER, 'Import MIDI');
  const pr = host.exec<{ id: string }>('patterns.add', { name: 'imported' }, { actor: USER, groupId: g });
  assert.equal(pr.ok, true);
  for (const t of plan.tracks) {
    const cr = host.exec<{ id: string }>('channels.add', { type: 'krypt.triosc', name: t.name }, { actor: USER, groupId: g });
    assert.equal(cr.ok, true, cr.message);
    const nr = host.exec('notes.add', { patternId: pr.data!.id, channelId: cr.data!.id, notes: t.notes }, { actor: USER, groupId: g });
    assert.equal(nr.ok, true, nr.message);
  }
  host.endGroup(g);
  assert.equal(host.getHistory().length, 1, 'whole import is one undo step');
  const notes = Object.values(host.project.patterns[pr.data!.id].notes).flatMap((m) => Object.values(m));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].dur, 960); // 480 ticks @ PPQ 480 = 1 beat
  assert.equal(host.undo().ok, true);
  assert.equal(host.project.patterns[pr.data!.id], undefined);
});

test('garbage input fails with a readable SmfError', () => {
  assert.throws(() => readSmf(new TextEncoder().encode('hello world, not midi')), (e: unknown) => e instanceof SmfError && /Not a MIDI file/.test((e as Error).message));
  assert.throws(() => readSmf(rawSmf(1, 96, [])), /no tracks/);
});

test('RIFF/RMID wrapper is unwrapped', () => {
  const inner = writeSmf({ format: 0, ppq: 96, tempos: [], timeSigs: [], tracks: [{ name: '', program: null, notes: [{ tick: 0, dur: 10, key: 50, vel: 70, channel: 2 }] }] });
  const riff: number[] = [];
  const le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  riff.push(...[0x52, 0x49, 0x46, 0x46], ...le(4 + 8 + inner.length), ...[0x52, 0x4d, 0x49, 0x44], ...[0x64, 0x61, 0x74, 0x61], ...le(inner.length), ...inner);
  const f = readSmf(Uint8Array.from(riff));
  assert.deepEqual(f.tracks[0].notes, [{ tick: 0, dur: 10, key: 50, vel: 70, channel: 2 }]);
});

await run('midi');
