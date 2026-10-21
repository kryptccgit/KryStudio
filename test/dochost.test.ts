import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER, type Actor, type DocChange } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { checkIntegrity, zProject, patternLength } from '@shared/schema/project';
import { CATALOG } from '@shared/plugins/catalog';
import { projectPatches } from '@shared/engine/projection';
import { listCommands } from '@shared/commands/registry';
import { getParamValue } from '@shared/schema/params';
import { TICKS_PER_STEP, PPQ } from '@shared/schema/time';

const AGENT: Actor = { kind: 'agent', clientId: 'claude-1', name: 'Claude' };

function fresh() {
  const p = createDefaultProject('Test');
  const host = new DocHost(p, CATALOG, { strict: true });
  const pat = p.transport.activePatternId!;
  const [kick, , , , bass] = p.channelOrder;
  return { host, pat, kick, bass };
}

test('default project is valid', () => {
  const p = createDefaultProject();
  assert.equal(zProject.safeParse(p).success, true, JSON.stringify(zProject.safeParse(p).error?.issues?.[0]));
  assert.deepEqual(checkIntegrity(p), []);
  assert.equal(p.channelOrder.length, 6);
});

test('every command has a description and zod args', () => {
  for (const c of listCommands()) {
    assert.ok(c.description.length > 10, c.id);
    assert.ok(typeof c.args.safeParse === 'function', c.id);
  }
});

test('toggleStep adds then removes a note; history + emit', () => {
  const { host, pat, kick } = fresh();
  const changes: DocChange[] = [];
  host.subscribe((c) => changes.push(c));
  const r1 = host.exec<{ on: boolean }>('notes.toggleStep', { patternId: pat, channelId: kick, step: 4 }, { actor: USER });
  assert.equal(r1.ok, true);
  assert.equal(r1.data?.on, true);
  const notes = Object.values(host.project.patterns[pat].notes[kick]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tick, 4 * TICKS_PER_STEP);
  const r2 = host.exec<{ on: boolean }>('notes.toggleStep', { patternId: pat, channelId: kick, step: 4 }, { actor: USER });
  assert.equal(r2.data?.on, false);
  assert.equal(host.project.patterns[pat].notes[kick], undefined);
  assert.equal(changes.length, 2);
  assert.equal(host.getHistory().length, 2);
});

test('invalid args and bad refs fail cleanly without changing the doc', () => {
  const { host, pat } = fresh();
  const v = host.version;
  const r = host.exec('notes.add', { patternId: pat, channelId: 'nope', notes: [{ tick: 0, key: 60 }] }, { actor: USER });
  assert.equal(r.ok, false);
  assert.match(r.message!, /Channel nope not found/);
  const r2 = host.exec('notes.add', { patternId: pat, channelId: 'x', notes: [{ tick: -5, key: 60 }] }, { actor: USER });
  assert.equal(r2.ok, false);
  assert.equal(host.version, v);
  assert.equal(host.exec('does.not.exist', {}, { actor: USER }).ok, false);
});

test('per-actor undo: user undo does not touch agent edits', () => {
  const { host, pat, kick, bass } = fresh();
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60 }] }, { actor: USER });
  host.exec('notes.add', { patternId: pat, channelId: bass, notes: [{ tick: 0, key: 36, dur: PPQ }] }, { actor: AGENT });
  const u = host.undo(USER);
  assert.equal(u.ok, true, u.message);
  assert.equal(host.project.patterns[pat].notes[kick], undefined);
  assert.equal(Object.keys(host.project.patterns[pat].notes[bass]).length, 1);
  const r = host.redo(USER);
  assert.equal(r.ok, true, r.message);
  assert.equal(Object.keys(host.project.patterns[pat].notes[kick]).length, 1);
});

test('agent group = one undo step; revertActor removes all agent work', () => {
  const { host, pat, kick, bass } = fresh();
  const g = host.beginGroup(AGENT, 'Write trap beat');
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60 }, { tick: 960, key: 60 }] }, { actor: AGENT, groupId: g });
  host.exec('notes.add', { patternId: pat, channelId: bass, notes: [{ tick: 0, key: 36 }] }, { actor: AGENT, groupId: g });
  host.exec('transport.set', { bpm: 150 }, { actor: AGENT, groupId: g });
  host.endGroup(g);
  const agentEntries = host.getHistory().filter((h) => h.actorKey === 'agent:claude-1');
  assert.equal(agentEntries.length, 1);
  assert.equal(agentEntries[0].label, 'Write trap beat');
  const rv = host.revertActor(AGENT);
  assert.equal(rv.ok, true, rv.message);
  assert.equal(host.project.transport.bpm, 140);
  assert.deepEqual(host.project.patterns[pat].notes, {});
});

test('selective undo is refused when a later edit touched the same data', () => {
  const { host, pat, kick } = fresh();
  const add = host.exec<{ ids: string[] }>('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60 }] }, { actor: AGENT });
  const id = add.data!.ids[0];
  host.exec('notes.update', { patternId: pat, channelId: kick, updates: [{ id, vel: 0.2 }] }, { actor: USER });
  const r = host.undo(AGENT);
  assert.equal(r.ok, false);
  assert.match(r.message!, /changed the same thing/);
  // Undo the user's edit first, then the agent's works.
  assert.equal(host.undo(USER).ok, true);
  assert.equal(host.undo(AGENT).ok, true);
});

test('coalesceKey merges knob drags into one entry', () => {
  const { host, kick } = fresh();
  for (const v of [0.1, 0.2, 0.3, 0.4]) host.exec('channels.set', { id: kick, volume: v }, { actor: USER, coalesceKey: 'knob:vol' });
  assert.equal(host.getHistory().length, 1);
  host.undo(USER);
  assert.equal(host.project.channels[kick].volume, 0.78);
});

test('execBatch is atomic', () => {
  const { host, pat, kick } = fresh();
  const v = host.version;
  const r = host.execBatch(
    [
      { cmd: 'notes.add', args: { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60 }] } },
      { cmd: 'channels.set', args: { id: 'missing', volume: 0.5 } },
    ],
    { actor: AGENT },
  );
  assert.equal(r.ok, false);
  assert.equal(host.version, v);
  assert.deepEqual(host.project.patterns[pat].notes, {});
});

test('history:false commands emit but do not record', () => {
  const { host } = fresh();
  host.exec('patterns.add', { name: 'B' }, { actor: USER });
  const before = host.getHistory().length;
  const first = host.project.patternOrder[0];
  assert.equal(host.exec('patterns.select', { id: first }, { actor: USER }).ok, true);
  assert.equal(host.project.transport.activePatternId, first);
  assert.equal(host.getHistory().length, before);
});

test('mixer: routes reject cycles; removing an insert reroutes channels to master', () => {
  const { host, kick } = fresh();
  const a = host.exec<{ id: string }>('mixer.addInsert', { name: 'Bus A' }, { actor: USER }).data!.id;
  const b = host.exec<{ id: string }>('mixer.addInsert', { name: 'Bus B' }, { actor: USER }).data!.id;
  assert.equal(host.exec('mixer.setRoute', { from: a, to: b, level: 1 }, { actor: USER }).ok, true);
  const cyc = host.exec('mixer.setRoute', { from: b, to: a, level: 1 }, { actor: USER });
  assert.equal(cyc.ok, false);
  host.exec('channels.set', { id: kick, insertId: a }, { actor: USER });
  host.exec('mixer.removeInsert', { id: a }, { actor: USER });
  assert.equal(host.project.channels[kick].insertId, host.project.mixer.masterId);
});

test('fx slots + params.set via ParamRef with clamping', () => {
  const { host } = fresh();
  const master = host.project.mixer.masterId;
  const slot = host.exec<{ id: string }>('mixer.addSlot', { insertId: master, type: 'krypt.reverb' }, { actor: USER }).data!.id;
  assert.equal(host.project.mixer.inserts[master].slots[slot].mix, 0.25);
  const ref = `insert/${master}/slot/${slot}/decay`;
  const r = host.exec<{ value: number }>('params.set', { ref, value: 999 }, { actor: AGENT });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.value, 20);
  assert.equal(getParamValue(host.project, CATALOG, ref), 20);
  assert.equal(host.exec('mixer.addSlot', { insertId: master, type: 'krypt.triosc' }, { actor: USER }).ok, false);
});

test('playlist: pattern clip length defaults to pattern length; makeUnique clones', () => {
  const { host, pat, kick } = fresh();
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: PPQ * 4 * 1 + 10, key: 60 }] }, { actor: USER });
  const track = host.project.playlist.trackOrder[0];
  const clip = host.exec<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: track, start: 0, patternId: pat }, { actor: USER }).data!.id;
  assert.equal(host.project.playlist.clips[clip].length, patternLength(host.project.patterns[pat], host.project.transport.timeSig));
  assert.equal(host.project.playlist.clips[clip].length, PPQ * 4 * 2);
  const mu = host.exec<{ patternId: string }>('playlist.makeUnique', { clipId: clip }, { actor: USER });
  assert.equal(mu.ok, true);
  assert.notEqual(mu.data!.patternId, pat);
  assert.equal(host.project.playlist.clips[clip].patternId, mu.data!.patternId);
});

test('automation.create + engine projection', () => {
  const { host, kick } = fresh();
  const track = host.project.playlist.trackOrder[1];
  const changes: DocChange[] = [];
  host.subscribe((c) => changes.push(c));
  const r = host.exec<{ automationId: string; clipId: string }>('automation.create', { target: `channel/${kick}/volume`, trackId: track, start: 0 }, { actor: USER });
  assert.equal(r.ok, true, r.message);
  const diff = projectPatches(host.project, changes[0].patches);
  const kinds = diff.upserts.map((u) => u.kind).sort();
  assert.deepEqual(kinds, ['automation', 'clip']);
  host.exec('playlist.removeClips', { ids: [r.data!.clipId] }, { actor: USER });
  const d2 = projectPatches(host.project, changes[1].patches);
  assert.deepEqual(d2.deletes, [{ kind: 'clip', id: r.data!.clipId }]);
});

test('channels.remove cleans notes and audio clips; patterns.remove cleans clips', () => {
  const { host, pat, kick } = fresh();
  host.exec('notes.toggleStep', { patternId: pat, channelId: kick, step: 0 }, { actor: USER });
  host.exec('channels.remove', { ids: [kick] }, { actor: USER });
  assert.equal(host.project.patterns[pat].notes[kick], undefined);
  const p2 = host.exec<{ id: string }>('patterns.add', {}, { actor: USER }).data!.id;
  const track = host.project.playlist.trackOrder[0];
  host.exec('playlist.addClip', { kind: 'pattern', trackId: track, start: 0, patternId: p2 }, { actor: USER });
  host.exec('patterns.remove', { id: p2 }, { actor: USER });
  assert.equal(Object.keys(host.project.playlist.clips).length, 0);
  assert.deepEqual(checkIntegrity(host.project), []);
});

// ── Project tabs: exportState / swap (research/19-project-tabs.md) ─────

test('swap: undo/redo per tab survives switching there and back; versions keep counting up', () => {
  const { host, pat, kick } = fresh();
  host.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: 0, key: 60 }] }, { actor: USER });
  host.exec('transport.set', { bpm: 150 }, { actor: USER });
  assert.equal(host.undo(USER).ok, true); // bpm back to 140, redo pending
  const a = host.exportState();
  const vA = host.version;

  const b = createDefaultProject('B');
  host.swap({ project: b, history: [], undoSeq: 0 });
  assert.ok(host.version > vA);
  assert.equal(host.project.meta.name, 'B');
  assert.equal(host.canUndo(USER), false);
  const bPat = b.transport.activePatternId!;
  host.exec('notes.add', { patternId: bPat, channelId: b.channelOrder[0], notes: [{ tick: 0, key: 61 }] }, { actor: USER });
  const bState = host.exportState();

  const vBefore = host.version;
  host.swap(a);
  assert.ok(host.version > vBefore, 'versions are monotonic across swaps');
  assert.equal(Object.keys(host.project.patterns[pat].notes[kick]).length, 1);
  assert.equal(host.redo(USER).ok, true, 'the redo stack came back with the tab');
  assert.equal(host.project.transport.bpm, 150);
  assert.equal(host.undo(USER).ok, true);
  assert.equal(host.undo(USER).ok, true);
  assert.equal(host.project.patterns[pat].notes[kick], undefined);
  assert.equal(host.undo(USER).ok, false);

  host.swap(bState);
  assert.equal(host.undo(USER).ok, true, "tab B's own edit is undoable after coming back");
  assert.deepEqual(host.project.patterns[bPat].notes, {});
});

test('swap: coalescing never merges an edit into the other tab, or across a switch', () => {
  const { host, kick } = fresh();
  host.exec('channels.set', { id: kick, volume: 0.1 }, { actor: USER, coalesceKey: 'knob:vol' });
  const a = host.exportState();
  host.swap({ project: createDefaultProject('B'), history: [], undoSeq: 0 });
  host.swap(a);
  // Same key, same actor, within the window: still a NEW entry after a switch.
  host.exec('channels.set', { id: kick, volume: 0.2 }, { actor: USER, coalesceKey: 'knob:vol' });
  assert.equal(host.getHistory().length, 2);
  // Without a switch, drags coalesce as before.
  host.exec('channels.set', { id: kick, volume: 0.3 }, { actor: USER, coalesceKey: 'knob:vol' });
  assert.equal(host.getHistory().length, 2);
  // The exported state is a copy: edits made after exporting don't leak into it.
  assert.equal(a.history.length, 1);
});

test('swap: subscribers see a reset carrying the project; open groups are ended', () => {
  const { host, pat, kick } = fresh();
  const seen: DocChange[] = [];
  host.subscribe((c) => seen.push(c));
  const g = host.beginGroup(AGENT, 'Write beat');
  assert.equal(host.listOpenGroups().length, 1);
  assert.equal(host.listOpenGroups()[0].actor.kind, 'agent');
  const b = createDefaultProject('B');
  host.swap({ project: b, history: [], undoSeq: 0 });
  const last = seen[seen.length - 1];
  assert.equal(last.kind, 'reset');
  assert.equal(last.project, b);
  assert.equal(last.version, host.version);
  assert.equal(host.listOpenGroups().length, 0);
  // A late edit naming the ended group becomes an ordinary entry; endGroup is a no-op.
  host.exec('transport.set', { bpm: 99 }, { actor: AGENT, groupId: g });
  host.endGroup(g);
  assert.equal(host.getHistory().length, 1);
  assert.equal(host.getHistory()[0].groupId, null);
  void pat;
  void kick;
});

void run('DocHost + commands');
