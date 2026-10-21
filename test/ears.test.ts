// "Ears" renderer logic (src/ears/logic.ts): analysis labels, the section
// timeline, the energy sparkline, Model Manager grouping, the status-bar
// job list and which audio a menu acts on.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { createDefaultProject } from '@shared/schema/factory';
import { DocHost, USER } from '@shared/doc/DocHost';
import { CATALOG } from '@shared/plugins/catalog';
import { MODEL_CATALOG, type ModelDef } from '@shared/analyzer/models';
import type { AnalyzerState, ModelState } from '@shared/types';
import {
  analyzerActivity,
  audioClipChannelOf,
  channelHasAudio,
  confidenceLevel,
  firstClipOfChannel,
  fmtBpm,
  fmtDuration,
  groupModels,
  installedStemModels,
  isCancelMessage,
  isEstimated,
  keyText,
  modelBytes,
  modelSource,
  patternSentence,
  sectionBlocks,
  sectionColor,
  snapBpm,
  sparklineArea,
  sparklinePath,
  stemsSentence,
  swingText,
  targetKey,
  targetName,
  tempoAlternatives,
  tempoText,
  transcribeModelFor,
} from '../src/ears/logic';

const def = (over: Partial<ModelDef>): ModelDef => ({
  id: 'x',
  name: 'X',
  task: 'stems',
  description: '',
  license: { name: 'MIT', url: 'https://example.com' },
  bundled: false,
  files: [],
  ...over,
});
const ms = (d: ModelDef, status: ModelState['status'], extra: Partial<ModelState> = {}): ModelState => ({ def: d, status, ...extra });
const state = (models: ModelState[], jobs: AnalyzerState['jobs'] = []): AnalyzerState => ({
  available: true,
  running: true,
  pid: 1,
  version: '1',
  devices: ['cpu'],
  models,
  jobs,
  modelsDir: 'C:\\m',
});

// ── labels ────────────────────────────────────────────────────────────

test('bpm formatting and snapping', () => {
  assert.equal(fmtBpm(140), '140');
  assert.equal(fmtBpm(140.02), '140');
  assert.equal(fmtBpm(127.94), '127.9');
  assert.equal(snapBpm(139.9), 140);
  assert.equal(snapBpm(127.5), 127.5);
  assert.equal(snapBpm(93.333), 93.33);
});

test('tempo text lists half/double-time alternatives once', () => {
  const t = { bpm: 140, confidence: 0.9, alternatives: [70, 140, 280, 70.01, 5] };
  assert.deepEqual(tempoAlternatives(t), [70, 280]);
  assert.equal(tempoText(t), '140 BPM (or 70 / 280)');
  assert.equal(tempoText({ bpm: 92, confidence: 0.5, alternatives: [] }), '92 BPM');
  assert.equal(tempoText(null), 'No steady tempo');
});

test('key, swing, confidence and estimate labels', () => {
  assert.equal(keyText({ tonic: 'F#', mode: 'minor', name: 'F#m', confidence: 0.8 }), 'F# minor');
  assert.equal(keyText(null), 'No clear key');
  assert.equal(swingText(0), 'Straight');
  assert.equal(swingText(0.18), '18%');
  assert.equal(swingText(null), 'Unknown');
  assert.equal(confidenceLevel(0.9), 'high');
  assert.equal(confidenceLevel(0.5), 'medium');
  assert.equal(confidenceLevel(0.1), 'low');
  assert.ok(isEstimated({ estimated: ['tempo', 'key'] }, 'key'));
  assert.ok(!isEstimated({ estimated: ['tempo'] }, 'levels'));
  assert.equal(fmtDuration(187.4), '3:07');
  assert.equal(fmtDuration(4.256), '4.26 s');
});

// ── sections + sparkline ──────────────────────────────────────────────

test('section blocks are laid out in percent, clamped, empty ones dropped', () => {
  const b = sectionBlocks(
    [
      { startSec: 0, endSec: 25, label: 'A', lufs: -14 },
      { startSec: 25, endSec: 75, label: 'B', lufs: -9 },
      { startSec: 75, endSec: 75, label: 'C', lufs: -9 },
      { startSec: 75, endSec: 140, label: 'A', lufs: -14 },
    ],
    100,
  );
  assert.equal(b.length, 3);
  assert.equal(b[0].left, 0);
  assert.equal(b[0].width, 25);
  assert.equal(b[1].left, 25);
  assert.equal(b[1].width, 50);
  assert.equal(b[2].width, 25); // clamped to the duration
  assert.equal(b[0].color, b[2].color); // same label, same color
  assert.notEqual(sectionColor('A'), sectionColor('B'));
  assert.deepEqual(sectionBlocks([], 0), []);
});

test('sparkline spans the box; silence sits on the floor', () => {
  const d = sparklinePath([-60, -20, -8, -20], 100, 40);
  assert.ok(d.startsWith('M0.0,'));
  const pts = d
    .slice(1)
    .split(' L')
    .map((p) => p.split(',').map(Number));
  assert.equal(pts.length, 4);
  assert.equal(pts[3][0], 100);
  const ys = pts.map((p) => p[1]);
  assert.ok(ys[2] < ys[1] && ys[1] < ys[0], 'louder = higher');
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 40);
  assert.equal(sparklinePath([-10], 100, 40), '');
  assert.ok(sparklineArea([-30, -10], 50, 20).endsWith('Z'));
});

// ── models ────────────────────────────────────────────────────────────

test('models group by task (stems, transcription, beats) with the default first', () => {
  const g = groupModels([
    ms(def({ id: 'b', name: 'Beat', task: 'beats' }), 'installed'),
    ms(def({ id: 's2', name: 'Alpha', task: 'stems' }), 'available'),
    ms(def({ id: 's1', name: 'Zeta', task: 'stems', default: true }), 'available'),
    ms(def({ id: 't', name: 'Pitch', task: 'transcribe' }), 'installed'),
  ]);
  assert.deepEqual(
    g.map((x) => x.title),
    ['Stems', 'Transcription', 'Beats'],
  );
  assert.deepEqual(
    g[0].models.map((m) => m.def.id),
    ['s1', 's2'],
  );
});

test('model size, source host, installed stem models, transcription needs', () => {
  const d = def({ files: [{ name: 'a', url: 'https://github.com/x/a.onnx', sha256: '', bytes: 1000 }, { name: 'b', url: '', sha256: '', bytes: 24 }] });
  assert.equal(modelBytes(d), 1024);
  assert.equal(modelSource(d), 'github.com');
  assert.equal(modelSource(def({})), null);
  const st = state([
    ms(def({ id: 'a', name: 'A' }), 'installed'),
    ms(def({ id: 'b', name: 'B', default: true }), 'installed'),
    ms(def({ id: 'c', name: 'C' }), 'available'),
    ms(def({ id: 'bp', name: 'Basic Pitch', task: 'transcribe', default: true }), 'available'),
  ]);
  assert.deepEqual(
    installedStemModels(st).map((m) => m.id),
    ['b', 'a'],
  );
  assert.deepEqual(installedStemModels(null), []);
  assert.equal(transcribeModelFor(st, 'poly')?.def.id, 'bp');
  assert.equal(transcribeModelFor(st, 'drums'), null);
  // the real catalog has a default stems model and a bundled transcriber
  assert.ok(MODEL_CATALOG.some((m) => m.task === 'stems' && m.default));
  assert.ok(MODEL_CATALOG.some((m) => m.task === 'transcribe' && m.bundled));
});

test('status-bar activity: jobs oldest first, then downloads with progress', () => {
  const st = state(
    [
      ms(def({ id: 'h', name: 'HT-Demucs' }), 'downloading', { progress: { received: 25, total: 100 } }),
      ms(def({ id: 'v', name: 'Vox' }), 'verifying'),
      ms(def({ id: 'i', name: 'Inst' }), 'installed'),
    ],
    [
      { id: 'j2', kind: 'separate', label: 'Separating "Loop"', stage: 'separating', fraction: 0.5, startedAt: 20 },
      { id: 'j1', kind: 'analyze', label: 'Analyzing "Loop"', stage: 'decoding', fraction: -1, startedAt: 10 },
    ],
  );
  const a = analyzerActivity(st);
  assert.deepEqual(
    a.map((x) => x.key),
    ['j1', 'j2', 'dl:h', 'dl:v'],
  );
  assert.equal(a[2].fraction, 0.25);
  assert.equal(a[2].label, 'Downloading HT-Demucs');
  assert.equal(a[3].fraction, -1);
  assert.equal(a[3].label, 'Verifying Vox');
  assert.equal(a[0].jobId, 'j1');
  assert.equal(a[2].modelId, 'h');
  assert.deepEqual(analyzerActivity(null), []);
});

// ── targets ───────────────────────────────────────────────────────────

test('targets resolve to names, audio-clip channels and clips', () => {
  const host = new DocHost(createDefaultProject('T'), CATALOG);
  const track = host.project.playlist.trackOrder[0];
  const r = host.exec<{ clipId: string; channelId: string }>('playlist.addAudio', { path: 'C:\\a\\Loop 1.wav', trackId: track, start: 960 }, { actor: USER });
  assert.ok(r.ok && r.data);
  const { clipId, channelId } = r.data!;
  const later = host.exec<{ id: string }>('playlist.addClip', { trackId: track, kind: 'audio', channelId, start: 9600 }, { actor: USER });
  assert.ok(later.ok, later.message);
  const p = host.project;
  assert.equal(targetName(p, { clipId }), 'Loop 1');
  assert.equal(targetName(p, { path: 'C:\\x\\kick.wav' }), 'kick.wav');
  assert.equal(audioClipChannelOf(p, { clipId }), channelId);
  assert.equal(audioClipChannelOf(p, { channelId }), channelId);
  assert.equal(audioClipChannelOf(p, { path: 'x.wav' }), null);
  assert.equal(firstClipOfChannel(p, channelId), clipId);
  assert.ok(channelHasAudio(p, channelId));
  const synth = p.channelOrder.find((id) => p.channels[id].generator.type !== 'krypt.audioclip' && !p.channels[id].generator.sampleId);
  if (synth) assert.ok(!channelHasAudio(p, synth));
  // clip and channel of the same sample share one cache key
  assert.equal(targetKey(p, { clipId }), targetKey(p, { channelId }));
  assert.equal(targetKey(p, { clipId }), 'path:C:\\a\\Loop 1.wav');
});

test('outcome sentences and cancel detection', () => {
  assert.equal(stemsSentence(4, 'Loop 1'), "4 stems added under 'Loop 1'");
  assert.equal(stemsSentence(1, 'X'), "1 stem added under 'X'");
  assert.equal(patternSentence('Loop notes', 42, 1), "Pattern 'Loop notes' created: 42 notes");
  assert.equal(patternSentence('Drums', 30, 3), "Pattern 'Drums' created: 30 notes on 3 channels");
  assert.ok(isCancelMessage('Cancelled'));
  assert.ok(isCancelMessage('Download cancelled'));
  assert.ok(!isCancelMessage('SHA-256 mismatch'));
});

void run('ears');
