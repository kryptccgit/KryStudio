// Channel Rack step tools: notes.fillSteps, notes.shiftSteps, channel filter groups.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { TICKS_PER_STEP } from '@shared/schema/time';
import type { Note } from '@shared/schema/project';

function fresh() {
  const p = createDefaultProject('Rack');
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const [kick, clap, hat, , bass, keys] = p.channelOrder;
  return { host, pat, kick, clap, hat, bass, keys };
}

const exec = <T = unknown>(host: DocHost, cmd: string, args: unknown) => host.exec<T>(cmd, args, { actor: USER });

function notesOf(host: DocHost, pat: string, ch: string): Note[] {
  return Object.values(host.project.patterns[pat].notes[ch] ?? {}).sort((a, b) => a.tick - b.tick);
}
const steps = (ns: Note[]) => ns.map((n) => n.tick / TICKS_PER_STEP);

test('fill each 2 / 4 / 8 steps over a 16-step bar', () => {
  const { host, pat, kick } = fresh();
  for (const [every, expect] of [
    [2, [0, 2, 4, 6, 8, 10, 12, 14]],
    [4, [0, 4, 8, 12]],
    [8, [0, 8]],
  ] as const) {
    const r = exec<{ ids: string[] }>(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every });
    assert.equal(r.ok, true, r.message);
    const ns = notesOf(host, pat, kick);
    assert.deepEqual(steps(ns), expect, `every ${every}`);
    assert.equal(r.data!.ids.length, expect.length);
    for (const n of ns) {
      assert.equal(n.dur, TICKS_PER_STEP);
      assert.equal(n.key, host.project.channels[kick].rootKey);
    }
  }
  assert.equal(host.getHistory().length, 3, 'one undo step per fill');
});

test('fill with offset, explicit row length, velocity and key', () => {
  const { host, pat, hat } = fresh();
  const r = exec(host, 'notes.fillSteps', { patternId: pat, channelId: hat, every: 4, offset: 2, steps: 32, vel: 0.5, key: 42 });
  assert.equal(r.ok, true, r.message);
  const ns = notesOf(host, pat, hat);
  assert.deepEqual(steps(ns), [2, 6, 10, 14, 18, 22, 26, 30]);
  assert.ok(ns.every((n) => n.vel === 0.5 && n.key === 42));
});

test('fill replaces existing steps by default, keeps them with replace=false, and reuses the row pitch', () => {
  const { host, pat, clap } = fresh();
  exec(host, 'notes.add', { patternId: pat, channelId: clap, notes: [{ tick: 1 * TICKS_PER_STEP, key: 50, dur: TICKS_PER_STEP }, { tick: 4 * TICKS_PER_STEP, key: 50, dur: TICKS_PER_STEP, vel: 1 }] });
  const keep = exec(host, 'notes.fillSteps', { patternId: pat, channelId: clap, every: 4, replace: false });
  assert.equal(keep.ok, true, keep.message);
  let ns = notesOf(host, pat, clap);
  assert.deepEqual(steps(ns), [0, 1, 4, 8, 12]);
  assert.equal(ns.find((n) => n.tick === 4 * TICKS_PER_STEP)!.vel, 1, 'occupied step untouched');
  assert.ok(ns.every((n) => n.key === 50), 'new steps use the row pitch');

  const rep = exec(host, 'notes.fillSteps', { patternId: pat, channelId: clap, every: 8 });
  assert.equal(rep.ok, true);
  ns = notesOf(host, pat, clap);
  assert.deepEqual(steps(ns), [0, 8]);
  assert.ok(ns.every((n) => n.key === 50));
});

test('fill keeps long piano-roll notes when replacing steps', () => {
  const { host, pat, keys } = fresh();
  exec(host, 'notes.add', { patternId: pat, channelId: keys, notes: [{ tick: 0, key: 60, dur: 960 }] });
  exec(host, 'notes.fillSteps', { patternId: pat, channelId: keys, every: 4 });
  const ns = notesOf(host, pat, keys);
  assert.equal(ns.filter((n) => n.dur === 960).length, 1);
  assert.deepEqual(steps(ns.filter((n) => n.dur === TICKS_PER_STEP)), [4, 8, 12], 'step 0 is occupied by the long note');
});

test('fill args are validated', () => {
  const { host, pat, kick } = fresh();
  const v = host.version;
  assert.equal(exec(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every: 0 }).ok, false);
  assert.equal(exec(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every: 4, offset: 4 }).ok, false);
  assert.equal(exec(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every: 65 }).ok, false);
  const bad = exec(host, 'notes.fillSteps', { patternId: pat, channelId: 'nope', every: 2 });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /Channel nope not found/);
  assert.equal(host.version, v);
});

test('shift steps right / left wraps around the pattern', () => {
  const { host, pat, kick } = fresh();
  exec(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every: 4 }); // 0 4 8 12
  exec(host, 'notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 15 * TICKS_PER_STEP, key: 60 }] }); // + 15
  let r = exec<{ moved: number }>(host, 'notes.shiftSteps', { patternId: pat, channelId: kick, steps: 1 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.moved, 5);
  assert.deepEqual(steps(notesOf(host, pat, kick)), [0, 1, 5, 9, 13], '15 wraps past the end to 0');
  r = exec(host, 'notes.shiftSteps', { patternId: pat, channelId: kick, steps: -2 });
  assert.equal(r.ok, true);
  assert.deepEqual(steps(notesOf(host, pat, kick)), [3, 7, 11, 14, 15], '0 and 1 wrap past 0 to 14 / 15');
  // a full-length rotation is the identity
  exec(host, 'notes.shiftSteps', { patternId: pat, channelId: kick, steps: 16 });
  assert.deepEqual(steps(notesOf(host, pat, kick)), [3, 7, 11, 14, 15]);
});

test('shift steps honours an explicit length, and wrap=false drops what falls out', () => {
  const { host, pat, hat } = fresh();
  exec(host, 'notes.fillSteps', { patternId: pat, channelId: hat, every: 2, steps: 8 }); // 0 2 4 6
  exec(host, 'notes.shiftSteps', { patternId: pat, channelId: hat, steps: 3, length: 8 * TICKS_PER_STEP });
  assert.deepEqual(steps(notesOf(host, pat, hat)), [1, 3, 5, 7]);
  const r = exec<{ moved: number; removed: number }>(host, 'notes.shiftSteps', { patternId: pat, channelId: hat, steps: -2, wrap: false });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.data, { moved: 3, removed: 1 });
  assert.deepEqual(steps(notesOf(host, pat, hat)), [1, 3, 5]);
  const v = host.version;
  assert.equal(exec(host, 'notes.shiftSteps', { patternId: pat, channelId: hat, steps: 0 }).ok, false);
  assert.equal(host.version, v);
});

test('shifting is one undo step', () => {
  const { host, pat, kick } = fresh();
  exec(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every: 4 });
  exec(host, 'notes.shiftSteps', { patternId: pat, channelId: kick, steps: 1 });
  assert.deepEqual(steps(notesOf(host, pat, kick)), [1, 5, 9, 13]);
  assert.equal(host.undo(USER).ok, true);
  assert.deepEqual(steps(notesOf(host, pat, kick)), [0, 4, 8, 12]);
});

test('channel filter group: set, rename and clear via channels.set', () => {
  const { host, bass, keys } = fresh();
  assert.equal(host.project.channels[keys].group, undefined);
  assert.equal(exec(host, 'channels.set', { id: keys, group: 'Leads' }).ok, true);
  assert.equal(host.project.channels[keys].group, 'Leads');
  assert.equal(exec(host, 'channels.set', { id: bass, group: '  Bass  ' }).ok, true);
  assert.equal(host.project.channels[bass].group, 'Bass', 'trimmed');
  assert.equal(exec(host, 'channels.set', { id: keys, group: null }).ok, true);
  assert.equal('group' in host.project.channels[keys], false, 'null clears back to automatic');
  assert.equal(exec(host, 'channels.set', { id: bass, group: '' }).ok, true);
  assert.equal('group' in host.project.channels[bass], false, 'empty clears too');
  assert.equal(exec(host, 'channels.set', { id: bass, group: 'x'.repeat(33) }).ok, false);
});

test('clone channel copies settings deeply (and notes on request) without touching the source', () => {
  const { host, pat, kick } = fresh();
  exec(host, 'notes.fillSteps', { patternId: pat, channelId: kick, every: 4 });
  const r = exec<{ id: string }>(host, 'channels.clone', { id: kick, withNotes: true });
  assert.equal(r.ok, true, r.message);
  const id = r.data!.id;
  const src = host.project.channels[kick];
  const dup = host.project.channels[id];
  assert.equal(dup.name, `${src.name} #2`);
  assert.deepEqual(dup.generator, src.generator);
  assert.notEqual(dup.generator, src.generator, 'a copy, not a shared object');
  assert.deepEqual(steps(notesOf(host, pat, id)), steps(notesOf(host, pat, kick)));
  assert.equal(host.project.channelOrder.indexOf(id), host.project.channelOrder.indexOf(kick) + 1);
});

void run('rack tools');
