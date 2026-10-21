import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { EngineStatus } from '@shared/types';
import { EngineSupervisor } from '../electron/engine/supervisor';
import { EngineBridge } from '../electron/engine/bridge';

const FAKE = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
let hung = false, applies = 0, loads = 0, lastVersion = -1, lastLoad = null, lastApply = null;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stdout.write('not json noise\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const ok = (data) => out({ id: m.id, ok: true, data });
  if (hung) return;
  switch (m.cmd) {
    case 'hello': return ok({ engineVersion: 'fake-1', protocol: m.protocol, telemetry: { port: 4321, token: 'tok' }, device: { open: false, id: null, name: null, backend: null, sampleRate: 48000, bufferFrames: 256, outputLatencyMs: 0 } });
    case 'openDevice': return ok({ open: true, id: m.deviceId ?? 'default', name: 'Fake Out', backend: 'wasapi', sampleRate: m.sampleRate ?? 48000, bufferFrames: m.bufferFrames ?? 256, outputLatencyMs: 5 });
    case 'loadProject': loads++; lastVersion = m.version; lastLoad = m.project; return ok({ version: m.version });
    case 'apply': applies++; lastVersion = m.version; lastApply = m; return ok({ version: m.version });
    case 'ping': return ok({});
    case 'transport': return ok({ playing: m.action === 'play' });
    case 'stats': return ok({ applies, loads, lastVersion, lastApply, samplePath: lastLoad && Object.values(lastLoad.samples)[0].path });
    case 'render': { const seen = lastVersion; out({ event: 'renderProgress', progress: 0.5 }); return setTimeout(() => ok({ path: m.job.path, files: [m.job.path], durationSec: 1, peakDb: -1, lufsIntegrated: -14, modelVersion: seen }), 50); }
    case 'fail': return out({ id: m.id, ok: false, message: 'nope' });
    case 'hang': hung = true; return;
    case 'crash': process.exit(3);
    case 'shutdown': ok({}); return setTimeout(() => process.exit(0), 10);
    default: return out({ id: m.id, ok: false, message: 'unknown cmd ' + m.cmd });
  }
});
rl.on('close', () => process.exit(0));
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-engine-'));
const fakeScript = path.join(dir, 'fake-engine.cjs');
fs.writeFileSync(fakeScript, FAKE);

function rig() {
  const doc = new DocHost(createDefaultProject('Eng'), CATALOG);
  const logs: string[] = [];
  let bridge: EngineBridge | null = null;
  const engine = new EngineSupervisor({
    resolveExe: () => process.execPath,
    missingMessage: 'missing',
    factoryDir: '/factory',
    audioSettings: () => ({ deviceId: null, bufferFrames: 128, sampleRate: 44100 }),
    loadProject: () => bridge!.load(),
    syncDoc: () => bridge!.sync(),
    log: (level, m) => logs.push(`${level} ${m}`),
    spawn: (_exe, args) => spawn(process.execPath, [fakeScript, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  });
  bridge = new EngineBridge(doc, engine, (p) => p.replace(/^factory:/, 'C:/factory/'), (level, m) => logs.push(`${level} ${m}`));
  return { doc, engine, bridge, logs };
}

function waitFor(engine: EngineSupervisor, pred: (s: EngineStatus) => boolean, ms = 8000): Promise<EngineStatus> {
  return new Promise((resolve, reject) => {
    if (pred(engine.status())) return resolve(engine.status());
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting; last status ${JSON.stringify(engine.status())}`));
    }, ms);
    const off = engine.onStatus((s) => {
      if (!pred(s)) return;
      clearTimeout(t);
      off();
      resolve(s);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Stats = { applies: number; loads: number; lastVersion: number; lastApply: { upserts: Array<{ kind: string }> }; samplePath: string };

test('missing exe → failed with the actionable message', () => {
  const e = new EngineSupervisor({ resolveExe: () => null, missingMessage: 'run npm run engine:build:debug', factoryDir: '', audioSettings: () => ({ deviceId: null, bufferFrames: 256, sampleRate: 48000 }), loadProject: async () => ({ ok: true }), log: () => {} });
  e.start();
  assert.equal(e.status().state, 'failed');
  assert.equal(e.status().message, 'run npm run engine:build:debug');
  assert.equal(e.telemetryUrl(), null);
});

test('handshake, coalesced applies, transport, render progress, crash restart, hang restart', async () => {
  const { doc, engine, logs } = rig();
  engine.start();
  const s = await waitFor(engine, (x) => x.state === 'running');
  assert.equal(s.engineVersion, 'fake-1');
  assert.equal(s.device?.name, 'Fake Out');
  assert.equal(s.device?.sampleRate, 44100, 'openDevice used the settings');
  assert.equal(engine.telemetryUrl(), 'ws://127.0.0.1:4321/?token=tok');

  let st = (await engine.request<Stats>({ cmd: 'stats' } as never)).data!;
  assert.equal(st.loads, 1);
  assert.equal(st.samplePath.startsWith('C:/factory/'), true, 'factory: paths resolved for the engine');

  const pat = doc.project.transport.activePatternId!;
  const kick = doc.project.channelOrder[0];
  for (let i = 0; i < 5; i++) doc.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: i * 240, key: 60 }] }, { actor: USER });
  await sleep(80);
  st = (await engine.request<Stats>({ cmd: 'stats' } as never)).data!;
  assert.equal(st.applies, 1);
  assert.equal(st.lastVersion, doc.version);
  assert.deepEqual(st.lastApply.upserts.map((u) => u.kind), ['pattern']);

  const playing: boolean[] = [];
  engine.onPlaying((p) => playing.push(p));
  assert.equal((await engine.request({ cmd: 'transport', action: 'play' })).ok, true);
  assert.equal(engine.isPlaying(), true);
  assert.deepEqual(playing, [true]);

  const progress: number[] = [];
  engine.onEvent((e) => e.event === 'renderProgress' && progress.push(e.progress));
  const r = await engine.render({ path: 'C:/out.wav', scope: { kind: 'song' }, format: 'wav24' });
  assert.equal(r.ok, true);
  assert.deepEqual(progress, [0.5]);

  const bad = await engine.request({ cmd: 'fail' } as never);
  assert.deepEqual(bad, { ok: false, message: 'nope' });

  void engine.request({ cmd: 'crash' } as never);
  await waitFor(engine, (x) => x.state === 'restarting');
  assert.equal(engine.isPlaying(), false);
  const s2 = await waitFor(engine, (x) => x.state === 'running');
  assert.equal(s2.restarts, 1);
  st = (await engine.request<Stats>({ cmd: 'stats' } as never)).data!;
  assert.equal(st.loads, 1, 'fresh process got exactly one loadProject');
  assert.equal(st.lastVersion, doc.version);

  void engine.request({ cmd: 'hang' } as never, 200);
  await waitFor(engine, (x) => x.state === 'restarting', 8000);
  await waitFor(engine, (x) => x.state === 'running', 8000);
  assert.ok(logs.some((l) => /missed heartbeats/.test(l)), 'logged the hang');

  doc.reset(createDefaultProject('Other'));
  await sleep(50);
  st = (await engine.request<Stats>({ cmd: 'stats' } as never)).data!;
  assert.equal(st.loads, 2);
  assert.equal(st.lastVersion, doc.version);

  await engine.stop();
  assert.equal(engine.status().state, 'stopped');
  assert.equal(engine.telemetryUrl(), null);
  const after = await engine.request({ cmd: 'ping' });
  assert.equal(after.ok, false);
});

test('render waits for edits still in the coalescing window (an agent writes, then listens at once)', async () => {
  const { doc, engine } = rig();
  engine.start();
  await waitFor(engine, (x) => x.state === 'running');
  const pat = doc.project.transport.activePatternId!;
  const kick = doc.project.channelOrder[0];
  for (let i = 0; i < 3; i++) {
    doc.exec('notes.add', { patternId: pat, channelId: kick, notes: [{ tick: i * 480, key: 60 }] }, { actor: USER });
    const r = await engine.render({ path: 'C:/out.wav', scope: { kind: 'song' }, format: 'wav24' });
    assert.equal(r.ok, true);
    assert.equal((r.data as unknown as { modelVersion: number }).modelVersion, doc.version, 'the render saw the edit made right before it');
  }
  doc.reset(createDefaultProject('Fresh'));
  const r2 = await engine.render({ path: 'C:/out.wav', scope: { kind: 'song' }, format: 'wav24' });
  assert.equal((r2.data as unknown as { modelVersion: number }).modelVersion, doc.version);
  await engine.stop();
});

await run('engine supervisor');
fs.rmSync(dir, { recursive: true, force: true });
