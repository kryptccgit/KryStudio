// MCP parity for the small things the app can do: build_session to_song (scenes → playlist), comp_takes rename /
// clear, add_channel clone_of, delete_objects samples / scripts, load_sample relink.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { ticksPerBar } from '@shared/schema/time';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { factoryScripts } from '../electron/scripts/service';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-mcp-gaps-'));
const FACTORY = path.join(TMP, 'factory');
fs.mkdirSync(path.join(FACTORY, 'drums'), { recursive: true });
for (const f of ['kick.wav', 'snare.wav', 'clap.wav']) fs.writeFileSync(path.join(FACTORY, 'drums', f), 'RIFF');

function rig() {
  const doc = new DocHost(createDefaultProject('Gaps'), CATALOG, { strict: true });
  let settings = { mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false } } as unknown as Settings;
  const deps = {
    doc,
    engine: {
      async request() {
        return { ok: true, data: {} };
      },
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async sampleInfo(p: string) {
        return { ok: true, data: { path: p, frames: 96000, sampleRate: 48000, channels: 2, durationSec: 2 } };
      },
    },
    project: {
      status: () => ({ path: null, name: 'Gaps', dirty: false, lastSavedAt: null, recovered: false }),
      resolveSamplePath: (p: string) => (p.startsWith('factory:') ? path.join(FACTORY, p.slice('factory:'.length)) : p),
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [],
    },
    getSettings: () => settings,
    updateSettings: (patch: Partial<Settings>) => (settings = { ...settings, ...patch }),
    broadcast: () => {},
    userDataDir: path.join(TMP, 'userData'),
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'gaps', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = doc.exec<T>(cmd, args, { actor: USER });
    assert.ok(r.ok, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  return { doc, call, ex };
}

test('build_session to_song: a scene order written into the playlist at a bar; bad scenes fail', async () => {
  const { doc, call } = rig();
  let r = await call('build_session', { scenes: [{ name: 'Verse', clips: [{ track: 'Drums', pattern: 'Pattern 1' }] }, { name: 'Hook', clips: [{ track: 'Drums', pattern: 'Pattern 1' }] }] });
  assert.ok(r.ok, r.message);
  const bar = ticksPerBar(doc.project.transport.timeSig);
  const before = Object.keys(doc.project.playlist.clips).length;
  r = await call('build_session', { to_song: { scenes: [{ scene: 'Verse', bars: 4 }, { scene: 2, bars: 2 }], at_bar: 9 } });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /wrote 2 scenes into the playlist at bars 9-14/);
  const placed = Object.values(doc.project.playlist.clips);
  assert.ok(placed.length > before, 'clips were placed');
  assert.equal(Math.min(...placed.map((c) => c.start)), 8 * bar);
  assert.deepEqual(checkIntegrity(doc.project), []);
  r = await call('build_session', { to_song: { scenes: [{ scene: 'Bridge', bars: 4 }] } });
  assert.equal(r.ok, false);
  assert.match(r.message, /Bridge/);
});

test('comp_takes rename and clear: the group gets a name, a range goes silent; repeats are No change', async () => {
  const { doc, call, ex } = rig();
  ex('transport.set', { bpm: 120 });
  const bar = ticksPerBar(doc.project.transport.timeSig);
  const g = ex<{ groupId: string }>('takes.createGroup', {
    name: 'Vocal',
    audio: { path: 'C:/rec/take.wav', frames: 480000, sampleRate: 48000, channels: 1 },
    passes: [
      { start: 2 * bar, end: 4 * bar, sec: 0 },
      { start: 2 * bar, end: 4 * bar, sec: 4 },
    ],
  });
  let r = await call('comp_takes', { group: 'Vocal', rename: 'Lead Vox', clear: [{ bars: '4' }] });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /silenced bar 4/);
  assert.match(r.message, /renamed to "Lead Vox"/);
  const grp = doc.project.takeGroups![g.groupId];
  assert.equal(grp.name, 'Lead Vox');
  assert.ok(grp.comp.every((s) => s.end <= 3 * bar), 'nothing plays in bar 4');
  r = await call('comp_takes', { group: 'Lead Vox', rename: 'Lead Vox', clear: [{ bars: '4' }] });
  assert.equal(r.ok, false);
  assert.match(r.message, /^No change/);
  r = await call('comp_takes', { group: 'Lead Vox', clear: [{ from: '3.9' }] });
  assert.equal(r.ok, false);
  assert.match(r.message, /bars \("8"\) or from \+ to/);
});

test('add_channel clone_of: a copy under a new name (notes on request); clone_of refuses instrument / sample', async () => {
  const { doc, call } = rig();
  const p0 = doc.project;
  const src = p0.channelOrder.map((id) => p0.channels[id]).find((c) => Object.values(p0.patterns).some((pt) => Object.keys(pt.notes[c.id] ?? {}).length)) ?? p0.channels[p0.channelOrder[0]];
  let r = await call('add_channel', { name: 'Kick 2', clone_of: src.name, with_notes: true, volume_db: -6 });
  assert.ok(r.ok, r.message);
  const id = (r.data as { id: string }).id;
  const c = doc.project.channels[id];
  assert.equal(c.name, 'Kick 2');
  assert.equal(c.generator.type, src.generator.type);
  assert.equal(c.generator.sampleId, src.generator.sampleId);
  assert.ok(Math.abs(20 * Math.log10(c.volume) + 6) < 0.01);
  const count = (chId: string) => Object.values(doc.project.patterns).reduce((n, pt) => n + Object.keys(pt.notes[chId] ?? {}).length, 0);
  assert.equal(count(id), count(src.id));
  assert.match(r.message, /a copy of/);
  r = await call('add_channel', { name: 'X', clone_of: src.name, instrument: 'synth' });
  assert.equal(r.ok, false);
  r = await call('add_channel', { name: 'Y', clone_of: 'Nope' });
  assert.equal(r.ok, false);
});

test('delete_objects samples (by name, "unused"; in-use refused) and scripts; load_sample relink repoints a sample', async () => {
  const { doc, call, ex } = rig();
  const used = ex<{ id: string }>('samples.add', { path: 'C:/kit/My Kick.wav' }).id;
  const spare = ex<{ id: string }>('samples.add', { path: 'C:/kit/Spare Clap.wav' }).id;
  const spare2 = ex<{ id: string }>('samples.add', { path: 'C:/old/loop.wav' }).id;
  const ch = ex<{ id: string }>('channels.add', { type: 'krypt.sampler', name: 'Kick S', sampleId: used }).id;

  let r = await call('delete_objects', { samples: ['my kick'] });
  assert.equal(r.ok, false);
  assert.match(r.message, /"My Kick" is still used by "Kick S"/);
  assert.ok(doc.project.samples[used]);

  // relink: the missing loop → the snare file; every user follows.
  r = await call('load_sample', { relink: 'loop.wav', sample: 'factory:drums/snare.wav' });
  assert.ok(r.ok, r.message);
  assert.equal(doc.project.samples[spare2].path, 'factory:drums/snare.wav');
  assert.equal(doc.project.samples[spare2].frames, 96000);
  r = await call('load_sample', { relink: spare2, sample: 'factory:drums/snare.wav' });
  assert.equal(r.ok, false);
  assert.match(r.message, /^No change/);
  r = await call('load_sample', { relink: spare2, sample: 'factory:drums/snare.wav', channel: 'Kick S' });
  assert.equal(r.ok, false);

  r = await call('delete_objects', { samples: ['spare clap'] });
  assert.ok(r.ok, r.message);
  assert.equal(doc.project.samples[spare], undefined);
  r = await call('delete_objects', { samples: ['unused'] });
  assert.ok(r.ok && /sample/.test(r.message), r.message);
  assert.equal(doc.project.samples[spare2], undefined);
  assert.ok(doc.project.samples[used], 'the used one stays');
  r = await call('delete_objects', { samples: ['unused'] });
  assert.equal(r.ok, false);
  assert.match(r.message, /^No change/);
  // Deleting the channel and its sample in one call works (channels go first).
  r = await call('delete_objects', { channels: ['Kick S'], samples: ['My Kick.wav'] });
  assert.ok(r.ok, r.message);
  assert.equal(doc.project.samples[used], undefined);
  assert.equal(doc.project.channels[ch], undefined);

  const code = factoryScripts().find((s) => s.header)!.code;
  const s = ex<{ id: string; name: string }>('scripts.save', { code, name: 'My Device' });
  r = await call('delete_objects', { scripts: ['my device'] });
  assert.ok(r.ok && /script "My Device"/.test(r.message), r.message);
  assert.equal(doc.project.scripts?.[s.id], undefined);
  r = await call('delete_objects', { scripts: ['My Device'] });
  assert.equal(r.ok, false);
  assert.match(r.message, /No project script/);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

await run('mcp small gaps');
fs.rmSync(TMP, { recursive: true, force: true });
