import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { Note } from '@shared/schema/project';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, inputJsonSchema, newSession, type ToolCaller } from '../electron/mcp/tools';

const BAR = 3840;

function rig() {
  const doc = new DocHost(createDefaultProject('Gen'), CATALOG, { strict: true });
  const settings = { mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false } } as unknown as Settings;
  const deps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
    },
    project: { status: () => ({ path: null, name: 'Gen', dirty: false, lastSavedAt: null, recovered: false }), resolveSamplePath: (p: string) => p, renderDir: () => os.tmpdir(), allowedRoots: () => [] },
    getSettings: () => settings,
    updateSettings: () => settings,
    broadcast: () => {},
    userDataDir: path.join(os.tmpdir(), 'krypt-gen-test'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'gen-agent', name: 'Gen Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args);
  const pat = doc.project.transport.activePatternId!;
  const chId = (name: string) => doc.project.channelOrder.find((id) => doc.project.channels[id].name === name)!;
  const notes = (name: string): Note[] => Object.values(doc.project.patterns[pat].notes[chId(name)] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);
  return { doc, call, notes };
}

const sig = (ns: Note[]) => ns.map((n) => `${n.tick}:${n.key}:${n.dur}:${n.vel}`).join(' ');

test('generate_notes: registered as a write tool with a per-generator JSON schema', () => {
  const t = getTool('generate_notes');
  assert.ok(t);
  assert.equal(t!.kind, 'write');
  const s = JSON.stringify(inputJsonSchema(t!));
  for (const w of ['rhythm', 'chords', 'arp', 'melody', 'bass', 'pulses', 'voicing', 'contour', 'glide808']) assert.ok(s.includes(w), `schema mentions ${w}`);
  assert.match(t!.description, /seed/);
  assert.match(t!.description, /i VI III VII/);
});

test('generate_notes: writes in key, summarises notes / bars / key / seed, same seed = same take, one undo', async () => {
  const { call, notes } = rig();
  const r = await call('generate_notes', { channel: 'Keys', generator: { kind: 'chords', progression: 'i VI III VII', rhythm: 'whole' }, key: 'Am', bars: '1-4', seed: 7 });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Chords on Keys in "Pattern 1": 12 notes in bars 1–4, A minor, seed 7/);
  assert.match(r.message, /Chords: Am F C G \(from the progression\)/);
  assert.deepEqual((r.data as { seed: number }).seed, 7);
  const chords = sig(notes('Keys'));

  const bass = await call('generate_notes', { channel: '808', generator: { kind: 'bass', style: 'root', passing: 0 }, seed: 3 });
  assert.equal(bass.ok, true, bass.message);
  assert.match(bass.message, /followed from the pattern/);
  assert.match(bass.message, /read from the pattern/);
  for (const n of notes('808')) assert.ok([[9, 0, 4], [5, 9, 0], [0, 4, 7], [7, 11, 2]][Math.floor(n.tick / BAR)].includes(n.key % 12), `bass ${n.key} on a chord tone`);
  const take = sig(notes('808'));
  assert.equal((await call('generate_notes', { channel: '808', generator: { kind: 'bass', style: 'root', passing: 0 }, seed: 3 })).ok, false, 'the same seed again is the same take: No change');
  const reroll = await call('generate_notes', { channel: '808', generator: { kind: 'bass', style: 'root', passing: 0 }, seed: 4 });
  assert.equal(reroll.ok, true, reroll.message);
  assert.notEqual(sig(notes('808')), take, 'another seed, another take');
  assert.equal((await call('undo_last')).ok, true);
  assert.equal(sig(notes('808')), take, 'undo_last drops the whole re-roll');
  assert.equal(sig(notes('Keys')), chords);

  const fresh = await call('generate_notes', { channel: 'Hat', generator: { kind: 'rhythm', steps: 8, pulses: 3, rate: '8th' }, bars: '2' });
  assert.equal(fresh.ok, true, fresh.message);
  assert.match(fresh.message, /seed \d+/, 'an omitted seed is reported so the take can be repeated');
  assert.match(fresh.message, /E\(3,8\) = x\.\.x\.\.x\./);
  assert.deepEqual(notes('Hat').map((n) => n.tick), [BAR, BAR + 1440, BAR + 2880]);
});

test('generate_notes: errors in plain words', async () => {
  const { call } = rig();
  const cases: Array<[unknown, RegExp]> = [
    [{ channel: 'Keys', generator: { kind: 'melody' }, key: 'H lydian' }, /Unknown key "H lydian"/],
    [{ channel: 'Keys', generator: { kind: 'arp', chords: 'pattern' } }, /No chords to follow/],
    [{ channel: 'Keys', generator: { kind: 'chords', progression: 'I IV Q' } }, /"Q" is not a chord numeral/],
    [{ channel: 'Keys', generator: { kind: 'melody' }, bars: '4-2' }, /bar range "4-2"/],
    [{ channel: 'Nobody', generator: { kind: 'melody' } }, /Nobody/],
    [{ channel: 'Keys', generator: { kind: 'drums' } }, /kind|Invalid/i],
    [{ channel: 'Keys', generator: { kind: 'rhythm', pulse: 3 } }, /pulse|Unrecognized|unrecognized/i],
  ];
  for (const [args, re] of cases) {
    const r = await call('generate_notes', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.message, re, r.message);
  }
});

await run('generate tools');
