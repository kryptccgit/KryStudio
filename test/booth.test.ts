// The Vocal Booth's pure logic (src/booth/logic.ts): empty song, the beat to loop and its placement (never on the
// Vocals track, one clip per pattern length), bar labels, the blocker and "Hear yourself" sentences; plus the entry
// points being wired (Home action, record button, Recording Studio, command list).
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { HOME_ACTION_IDS } from '../src/home/logic';
import { barLabel, beatPattern, boothBlocker, fmtTakeSeconds, LOOP_BARS, loopBeatSteps, monitorStatus, nextBarTick, songIsEmpty, targetTrackName } from '../src/booth/logic';

const BAR = 3840;
/** The repo root (the bundled test runs from test/.out). */
function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
      /* keep climbing */
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const root = repoRoot();

function newDoc(): DocHost {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  assert.ok(doc.exec('transport.set', { bpm: 120 }, { actor: USER }).ok);
  return doc;
}
function exec<T = unknown>(doc: DocHost, cmd: string, args: unknown): T {
  const r = doc.exec<T>(cmd, args, { actor: USER });
  assert.ok(r.ok, `${cmd}: ${r.message}`);
  return r.data as T;
}
function addBeat(doc: DocHost): string {
  const p = doc.project;
  const patternId = p.transport.activePatternId!;
  const channelId = p.channelOrder[0];
  exec(doc, 'notes.add', { patternId, channelId, notes: [{ tick: 0, dur: 240, key: 60, vel: 0.8 }, { tick: BAR + 960, dur: 240, key: 60, vel: 0.8 }] });
  return patternId;
}

test('an empty song, and the beat to loop: the active pattern when it has notes', () => {
  const doc = newDoc();
  assert.equal(songIsEmpty(doc.project), true);
  assert.equal(beatPattern(doc.project), null, 'no notes anywhere: nothing to loop');
  assert.equal(loopBeatSteps(doc.project), null);
  const pid = addBeat(doc);
  assert.equal(beatPattern(doc.project), pid);
});

test('Loop my beat: clips back to back over the first bars, never on the Vocals track, one undo step', () => {
  const doc = newDoc();
  const pid = addBeat(doc); // 2 bars long
  const vocals = exec<{ trackId: string }>(doc, 'recording.setupVocals', { name: 'Vocals', chain: null });
  const steps = loopBeatSteps(doc.project)!;
  assert.equal(steps.length, LOOP_BARS / 2);
  const args = steps.map((s) => s.args as { trackId: string; start: number; patternId: string; length: number });
  assert.ok(args.every((a) => a.trackId !== vocals.trackId && a.patternId === pid && a.length === 2 * BAR));
  assert.deepEqual(args.map((a) => a.start), Array.from({ length: LOOP_BARS / 2 }, (_, i) => i * 2 * BAR));
  const r = doc.execBatch(steps, { actor: USER, label: 'Loop the beat for the vocal' });
  assert.ok(r.ok, r.message);
  assert.deepEqual(checkIntegrity(doc.project), []);
  assert.equal(songIsEmpty(doc.project), false);
  assert.equal(Object.values(doc.project.playlist.clips).filter((c) => c.trackId === vocals.trackId).length, 0);
  assert.equal(targetTrackName(doc.project), 'Vocals');
});

test('bars, the next bar after a take, take lengths', () => {
  const p = newDoc().project;
  assert.equal(barLabel(p, 0), 'bar 1');
  assert.equal(barLabel(p, 8 * BAR + 10), 'bar 9');
  assert.equal(nextBarTick(p, 4 * BAR), 4 * BAR);
  assert.equal(nextBarTick(p, 4 * BAR + 1), 5 * BAR);
  assert.equal(fmtTakeSeconds(12.34), '12.3 s');
  assert.equal(fmtTakeSeconds(75), '1:15');
  assert.equal(fmtTakeSeconds(null), '');
});

test('what blocks recording, as a sentence', () => {
  assert.equal(boothBlocker({ engineRunning: true, inputOpen: true }), null);
  assert.match(boothBlocker({ engineRunning: false, inputOpen: true })!, /engine/);
  assert.match(boothBlocker({ engineRunning: true, inputOpen: false, inputMessage: 'device busy' })!, /device busy/);
});

test('"Hear yourself": off, rate problem, working, and on-but-silent are told apart', () => {
  const base = { monitorOn: true, inputOpen: true, running: true, micPeak: 0, monitorPeak: 0, rateProblem: null };
  assert.equal(monitorStatus({ ...base, monitorOn: false }).tone, 'off');
  assert.equal(monitorStatus({ ...base, rateProblem: 'rates differ' }).text, 'rates differ');
  assert.equal(monitorStatus({ ...base, micPeak: 0.1, monitorPeak: 0.1 }).tone, 'ok');
  const silent = monitorStatus({ ...base, micPeak: 0.1, monitorPeak: 0 });
  assert.equal(silent.tone, 'warn');
  assert.match(silent.text, /isn’t reaching/);
  assert.equal(monitorStatus({ ...base, running: false }).tone, 'ok', 'an engine without monitorPeak just says on');
  assert.equal(monitorStatus({ ...base, inputOpen: false }).tone, 'warn');
});

test('entry points are wired: Home action, record button, Recording Studio, command list', () => {
  assert.ok((HOME_ACTION_IDS as readonly string[]).includes('booth'));
  const read = (f: string): string => readFileSync(path.join(root, f), 'utf8');
  assert.match(read('src/app/RecordControls.tsx'), /openBooth\(\)/);
  assert.match(read('src/home/screens/RecordingScreen.tsx'), /Open the Vocal Booth/);
  assert.match(read('src/app/actions.ts'), /id: 'record\.booth'/);
  assert.match(read('src/App.tsx'), /<BoothHost \/>/);
});

void run('booth');
