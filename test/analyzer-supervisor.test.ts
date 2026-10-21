// AnalyzerSupervisor against a fake NDJSON analyzer (test/fake-analyzer.ts):
// lazy start + hello, progress, concurrent jobs, cancel, crash → reject +
// restart on next use, cancel-grace kill, graceful stop, missing exe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import type { AudioAnalysis, StemsResult } from '@shared/analyzer/protocol';
import { AnalyzerSupervisor, type AnalyzerSupervisorOptions } from '../electron/analyzer/supervisor';
import { countRuns, fakeSpawn, writeFakeAnalyzer } from './fake-analyzer';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-analyzer-'));
const script = writeFakeAnalyzer(dir);
const logFile = path.join(dir, 'calls.log');

function rig(extra: Partial<AnalyzerSupervisorOptions> = {}) {
  const logs: string[] = [];
  const sup = new AnalyzerSupervisor({
    resolveExe: () => process.execPath,
    missingMessage: 'not built',
    log: (level, m) => logs.push(`${level} ${m}`),
    spawn: fakeSpawn(script, logFile),
    idleShutdownMs: 0,
    ...extra,
  });
  return { sup, logs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('missing exe → every job fails with the actionable message; available() is false', async () => {
  const sup = new AnalyzerSupervisor({ resolveExe: () => null, missingMessage: 'Run npm run engine:build:debug', log: () => {} });
  assert.equal(sup.available(), false);
  const r = await sup.run('analyze', { path: 'C:/x.wav' }).done;
  assert.deepEqual(r, { ok: false, message: 'Run npm run engine:build:debug' });
  assert.equal(sup.status().running, false);
  assert.equal(sup.status().message, 'Run npm run engine:build:debug');
});

test('lazy start: nothing runs until the first job; hello fills version + devices; progress streams', async () => {
  const { sup, logs } = rig();
  assert.equal(sup.status().running, false, 'not spawned at construction');
  const progress: Array<[string, number]> = [];
  const r = await sup.run<'analyze', AudioAnalysis>('analyze', { path: 'C:/loops/a.wav', sections: true }, (s, f) => progress.push([s, f])).done;
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data!.tempo!.bpm, 120);
  assert.deepEqual(progress, [['decoding', 0.5]]);
  const st = sup.status();
  assert.equal(st.running, true);
  assert.equal(st.version, 'fake-0.1');
  assert.deepEqual(st.devices, ['cpu']);
  assert.ok(typeof st.pid === 'number');
  assert.ok(logs.some((l) => l.includes('analysing a.wav')), 'log events are forwarded');
  assert.ok(logs.some((l) => l.includes('[analyzer:stderr] fake analyzer up')), 'stderr is logged');
  await sup.stop();
  assert.equal(sup.status().running, false);
});

test('concurrent jobs resolve independently; analyzer errors come back verbatim', async () => {
  const { sup } = rig();
  const a = sup.run('analyze', { path: 'C:/one.wav' });
  const b = sup.run('analyze', { path: 'C:/bad.wav' });
  const c = sup.run<'transcribe', { notes: unknown[] }>('transcribe', { path: 'C:/two.wav', mode: 'mono' });
  const [ra, rb, rc] = await Promise.all([a.done, b.done, c.done]);
  assert.equal(ra.ok, true);
  assert.deepEqual(rb, { ok: false, message: 'Unsupported or corrupt audio file C:/bad.wav', cancelled: undefined });
  assert.equal(rc.ok, true);
  assert.equal(rc.data!.notes.length, 2);
  await sup.stop();
});

test('cancel: the job answers cancelled; cancelling before the process started never sends it', async () => {
  const { sup } = rig();
  const before = countRuns(logFile, 'separate');
  const early = sup.run('separate', { path: 'C:/early.wav', model: 'htdemucs', modelDir: dir, outDir: path.join(dir, 'never') });
  early.cancel();
  assert.deepEqual(await early.done, { ok: false, cancelled: true, message: 'Cancelled' });
  assert.equal(countRuns(logFile, 'separate'), before, 'never reached the analyzer');

  const progress: number[] = [];
  const h = sup.run<'separate', StemsResult>('separate', { path: 'C:/slow.wav', model: 'htdemucs', modelDir: dir, outDir: path.join(dir, 'out-slow') }, (_s, f) => progress.push(f));
  while (progress.length < 1) await sleep(10);
  h.cancel();
  h.cancel(); // idempotent
  const r = await h.done;
  assert.deepEqual(r, { ok: false, cancelled: true, message: 'Cancelled' });
  assert.ok(!fs.existsSync(path.join(dir, 'out-slow')), 'no stems written');
  // The process survives a cancel and keeps working.
  const pid = sup.status().pid;
  const ok = await sup.run('analyze', { path: 'C:/after.wav' }).done;
  assert.equal(ok.ok, true);
  assert.equal(sup.status().pid, pid);
  await sup.stop();
});

test('crash → every in-flight job fails with a clear message → the next job restarts the analyzer', async () => {
  const { sup, logs } = rig();
  await sup.run('analyze', { path: 'C:/warm.wav' }).done;
  const pid1 = sup.status().pid;
  const slow = sup.run('separate', { path: 'C:/slow.wav', model: 'htdemucs', modelDir: dir, outDir: path.join(dir, 'out-crash') });
  await sleep(30);
  const crash = sup.run('analyze', { path: 'C:/crash.wav' });
  const [rs, rc] = await Promise.all([slow.done, crash.done]);
  for (const r of [rs, rc]) {
    assert.equal(r.ok, false);
    assert.match(r.message!, /stopped unexpectedly while (separating stems|analysing audio) \(exit code 3\)\. It restarts on the next request/);
  }
  assert.equal(sup.status().running, false);
  assert.match(sup.status().message!, /crashed/);
  assert.ok(logs.some((l) => l.startsWith('error Audio analyzer exited unexpectedly')));
  const t0 = Date.now();
  const again = await sup.run('analyze', { path: 'C:/again.wav' }).done;
  assert.equal(again.ok, true, again.message);
  assert.ok(Date.now() - t0 >= 150, 'restart waited for the backoff');
  assert.notEqual(sup.status().pid, pid1, 'a fresh process');
  assert.equal(sup.status().message, undefined, 'the crash message clears after a good start');
  await sup.stop();
});

test('a cancelled job that never answers gets the process killed after the grace period', async () => {
  const { sup, logs } = rig({ cancelGraceMs: 200 });
  try {
    const before = countRuns(logFile, 'separate');
    const h = sup.run('separate', { path: 'C:/hang.wav', model: 'htdemucs', modelDir: dir, outDir: path.join(dir, 'out-hang') });
    // Cancel once the analyzer has the job (a fixed sleep raced a slow process start on a busy machine).
    for (let t = 0; countRuns(logFile, 'separate') === before; t += 20) {
      assert.ok(t < 10_000, 'the fake analyzer received the job');
      await sleep(20);
    }
    const pid = sup.status().pid;
    h.cancel();
    assert.deepEqual(await h.done, { ok: false, cancelled: true, message: 'Cancelled' });
    assert.ok(logs.some((l) => /didn't stop a cancelled job/.test(l)));
    assert.ok(!logs.some((l) => l.startsWith('error Audio analyzer exited unexpectedly')), 'a deliberate kill is not a crash');
    const r = await sup.run('analyze', { path: 'C:/next.wav' }).done;
    assert.equal(r.ok, true);
    assert.notEqual(sup.status().pid, pid);
  } finally {
    await sup.stop();
  }
});

test('stop(): shutdown request, process exits, later jobs start a new one', async () => {
  const { sup } = rig();
  await sup.run('analyze', { path: 'C:/x.wav' }).done;
  const pid = sup.status().pid;
  const changes: boolean[] = [];
  sup.onStatus((s) => changes.push(s.running));
  await sup.stop();
  assert.equal(sup.status().running, false);
  assert.ok(changes.includes(false));
  const r = await sup.run('analyze', { path: 'C:/y.wav' }).done;
  assert.equal(r.ok, true);
  assert.notEqual(sup.status().pid, pid);
  await sup.stop();
});

test('idle shutdown frees the process; the next job respawns it', async () => {
  const { sup } = rig({ idleShutdownMs: 120 });
  await sup.run('analyze', { path: 'C:/x.wav' }).done;
  assert.equal(sup.status().running, true);
  await sleep(400);
  assert.equal(sup.status().running, false, 'shut down after being idle');
  const r = await sup.run('analyze', { path: 'C:/y.wav' }).done;
  assert.equal(r.ok, true);
  await sup.stop();
});

test('a process that never says hello fails the start with a clear message', async () => {
  const silent = path.join(dir, 'silent.cjs');
  fs.writeFileSync(silent, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  const sup = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'x', log: () => {}, spawn: fakeSpawn(silent), helloTimeoutMs: 300, idleShutdownMs: 0 });
  const r = await sup.run('analyze', { path: 'C:/x.wav' }).done;
  assert.equal(r.ok, false);
  assert.match(r.message!, /didn't complete its handshake/);
  await sup.stop();
});

await run('analyzer supervisor');
fs.rmSync(dir, { recursive: true, force: true });
