// A fake krypt-studio-analyzer.exe: a Node script speaking the NDJSON
// protocol of docs/ANALYZER_PROTOCOL.md. Behaviour is chosen by the input
// path: "crash" exits mid-job, "bad" fails, "slow" separates slowly,
// "hang" never answers (and ignores cancel). Every job is appended to
// FAKE_ANALYZER_LOG ("<cmd> <path>") so tests can count analyzer runs.
// study_reference: a "fullsong" file is a 2-minute 128 bpm house-style track (see fullSong); its fake drum stem
// transcribes to the same hits.
// Wave 3B (reference library): analyze returns `chords` and, with
// args.drums, `drumHits` over a 4-bar beat grid; "lazy" analyses slowly,
// "fast" reads 160 bpm in C; separating an "instrumental" gives a silent
// vocal stem; mono transcription of a stem inside library/tmp returns a
// 12-note melody (vocals) or an 8-note bass line (bass).
// Vocals & mashups: a file name with "key=Am", "bpm=96", "keyconf=0.3",
// "nokey" or "notempo" sets what analyze reports; mono transcription of a
// "melody" file returns the 12-note melody (it fits C major best).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CATALOG } from '@shared/plugins/catalog';
import type { ParamSpec, PluginCatalog } from '@shared/plugins/types';
import type { ModelDef } from '@shared/analyzer/models';

const SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const logFile = process.env.FAKE_ANALYZER_LOG;
const running = new Map();
process.stderr.write('fake analyzer up\n');
process.stdout.write('not json noise\n');

const at = (beat) => 0.1 + beat * 0.5;
const MELODY = [[0, 1, 62], [1, 0.5, 65], [1.5, 0.5, 69], [2, 1, 67], [3, 1.5, 64], [4.5, 0.5, 72], [5, 1, 70], [6, 0.5, 65], [6.5, 0.5, 67], [7, 1, 62], [8, 1, 69], [9, 2, 60]];
const BASS = [[0, 1.5, 42], [1.5, 0.5, 42], [2, 1, 49], [4, 2, 38], [6, 1, 45], [7, 0.5, 47], [7.5, 0.5, 40], [8, 2, 42]];
function drumHits() {
  const hits = [];
  for (let b = 0; b < 16; b++) {
    const j = b % 4;
    if (j === 0 || j === 2) hits.push({ timeSec: at(b), role: 'kick', vel: 0.9 });
    if (j === 1 || j === 3) hits.push({ timeSec: at(b), role: 'snare', vel: 0.8 });
    hits.push({ timeSec: at(b), role: 'hat', vel: 0.5 }, { timeSec: at(b) + 0.25, role: 'hat', vel: 0.4 });
  }
  return hits;
}

// "fullsong": a 2-minute, 128 bpm, A minor four-on-the-floor track: intro 8 bars, build 8, drop 16, break 8,
// drop 16, outro 8 (sections A B C D C A); kick on every beat and clap on 2 and 4 in the build and drops, off-beat
// hats throughout (with args.drums); an Am F C G loop, a bar per chord.
function fullSong(p, beat, lib) {
  const spb = 60 / 128;
  const n = 256;
  const t = (b) => 0.05 + b * spb;
  const parts = [['A', 0, 32, -16], ['B', 32, 64, -12], ['C', 64, 128, -8], ['D', 128, 160, -15], ['C', 160, 224, -8], ['A', 224, 256, -14]];
  const sections = parts.map((x) => ({ startSec: x[1] === 0 ? 0 : t(x[1]), endSec: t(x[2]), label: x[0], lufs: x[3] }));
  const energy = [];
  for (let i = 0; i * 0.5 < t(n); i++) {
    const s = sections.find((x) => i * 0.5 >= x.startSec && i * 0.5 < x.endSec) || sections[sections.length - 1];
    energy.push(s.lufs);
  }
  const hits = [];
  if (lib) {
    for (let b = 0; b < n; b++) {
      const part = parts.find((x) => b >= x[1] && b < x[2]);
      const full = part[0] === 'B' || part[0] === 'C';
      if (full) hits.push({ timeSec: t(b), role: 'kick', vel: 0.95 });
      if (full && (b % 4 === 1 || b % 4 === 3)) hits.push({ timeSec: t(b), role: 'snare', vel: 0.85 });
      hits.push({ timeSec: t(b) + spb / 2, role: 'hat', vel: b % 2 ? 0.6 : 0.5 });
    }
  }
  const roots = [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']];
  const chords = [];
  for (let bar = 0; bar < n / 4; bar++) chords.push({ startSec: t(bar * 4), endSec: t(bar * 4 + 4), root: roots[bar % 4][0], quality: roots[bar % 4][1], confidence: 0.8 });
  return {
    path: p, durationSec: Math.round(t(n) * 100) / 100, sampleRate: 44100, channels: 2,
    tempo: { bpm: 128, confidence: 0.92, alternatives: [64, 256] },
    beats: { times: Array.from({ length: n }, (_, i) => t(i)), downbeats: Array.from({ length: n / 4 }, (_, i) => t(i * 4)), beatsPerBar: 4 },
    key: { tonic: 'A', mode: 'minor', name: 'Am', confidence: 0.8 },
    swing: 0.02,
    sections,
    levels: { durationSec: t(n), peakDb: -0.3, truePeakDb: -0.2, lufsIntegrated: -8.5, lufsShortTermMax: -7.5, loudnessRange: 7, rmsDb: -10, crestDb: 8,
      bands: { sub: -9, low: -10, lowMid: -14, mid: -16, highMid: -20, high: -27 }, stereoCorrelation: 0.5, stereoWidth: 0.45, energyCurve: energy.filter((_, i) => i % 2 === 0), clipping: false, estimatedBpm: 128, spectralCentroidHz: 1700 },
    stereo: { width: 0.45, correlation: 0.5 },
    energy: { hopSec: 0.5, lufs: energy },
    onsetRate: 6.1,
    chords,
    ...(lib ? { drumHits: hits } : {}),
    estimated: ['tempo', 'beats', 'key', 'swing', 'sections', 'chords', ...(lib ? ['drumHits'] : [])],
    sources: beat ? ['fake-dsp', 'beat-this small'] : ['fake-dsp'],
  };
}

function analysis(p, beat, lib) {
  const base = path.basename(p);
  if (/fullsong/i.test(base)) return fullSong(p, beat, lib);
  const fast = /fast/i.test(base);
  // Vocals tests: "vocal key=Am bpm=96 keyconf=0.3.wav" sets the key / tempo / key confidence; "nokey" / "notempo" remove them.
  const km = /key=([A-G][#b]?m?)(?![a-z])/.exec(base);
  const bm = /bpm=(\d+(?:\.\d+)?)/.exec(base);
  const cm = /keyconf=(\d*\.\d+)/.exec(base);
  const named = (k) => ({ tonic: k.replace(/m$/, ''), mode: /m$/.test(k) ? 'minor' : 'major', name: k, confidence: cm ? Number(cm[1]) : 0.8 });
  return {
    path: p, durationSec: 8, sampleRate: 44100, channels: 2,
    tempo: /notempo/i.test(base) ? null : bm ? { bpm: Number(bm[1]), confidence: 0.9, alternatives: [Number(bm[1]) / 2, Number(bm[1]) * 2] } : { bpm: fast ? 160 : 120, confidence: 0.9, alternatives: fast ? [80, 320] : [60, 240] },
    beats: lib
      ? { times: Array.from({ length: 16 }, (_, i) => at(i)), downbeats: [at(0), at(4), at(8), at(12)], beatsPerBar: 4 }
      : { times: [0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6], downbeats: [0.1, 2.1], beatsPerBar: 4 },
    key: /nokey/i.test(base) ? null : km ? named(km[1]) : fast ? { tonic: 'C', mode: 'major', name: 'C', confidence: 0.6 } : { tonic: 'F#', mode: 'minor', name: 'F#m', confidence: 0.7 },
    swing: 0.12,
    sections: [ { startSec: 0.1, endSec: 4.1, label: 'A', lufs: -10 }, { startSec: 4.1, endSec: 8, label: 'B', lufs: -8 } ],
    levels: { durationSec: 8, peakDb: -0.5, truePeakDb: -0.3, lufsIntegrated: -9.5, lufsShortTermMax: -8, loudnessRange: 3, rmsDb: -12, crestDb: 9,
      bands: { sub: -10, low: -12, lowMid: -14, mid: -20, highMid: -24, high: -30 }, stereoCorrelation: 0.6, stereoWidth: 0.4, energyCurve: [-12, -10], clipping: false, estimatedBpm: 120, spectralCentroidHz: 1500 },
    stereo: { width: 0.4, correlation: 0.6 },
    energy: { hopSec: 0.5, lufs: [-12, -11, -10, -9] },
    onsetRate: fast ? 7.5 : 4.2,
    chords: [
      { startSec: at(0), endSec: at(4), root: 6, quality: 'min', confidence: 0.8 },
      { startSec: at(4), endSec: at(8), root: 2, quality: 'maj', confidence: 0.7 },
      { startSec: at(8), endSec: at(12), root: 9, quality: 'maj', confidence: 0.7 },
      { startSec: at(12), endSec: 8, root: 4, quality: 'maj', confidence: 0.6 },
    ],
    ...(lib ? { drumHits: drumHits() } : {}),
    estimated: ['tempo', 'beats', 'key', 'swing', 'sections', 'chords'],
    sources: beat ? ['fake-dsp', 'beat-this small'] : ['fake-dsp'],
  };
}

rl.on('line', (line) => {
  const m = JSON.parse(line);
  const ok = (data) => out({ id: m.id, ok: true, data });
  const fail = (message, extra) => out(Object.assign({ id: m.id, ok: false, message }, extra || {}));
  const p = (m.args && m.args.path) || '';
  if (logFile && ['analyze', 'separate', 'transcribe'].includes(m.cmd)) fs.appendFileSync(logFile, m.cmd + ' ' + p + '\n');
  switch (m.cmd) {
    case 'hello': return ok({ version: 'fake-0.1', devices: ['cpu'] });
    case 'cancel': {
      const j = running.get(m.args.target);
      if (!j) return fail('No such job');
      ok({});
      return j();
    }
    case 'shutdown': ok({}); return setTimeout(() => process.exit(0), 10);
    case 'analyze':
      if (/crash/i.test(p)) process.exit(3);
      if (/bad/i.test(p)) return fail('Unsupported or corrupt audio file ' + p);
      out({ event: 'progress', id: m.id, stage: 'decoding', fraction: 0.5 });
      out({ event: 'log', level: 'info', message: 'analysing ' + path.basename(p) });
      return setTimeout(() => ok(analysis(p, !!m.args.beatModelDir, !!m.args.drums)), /lazy/i.test(path.basename(p)) ? 400 : 20);
    case 'separate': {
      if (/hang/i.test(p)) { running.set(m.id, () => {}); return; }
      let step = 0, cancelled = false;
      running.set(m.id, () => { cancelled = true; });
      const slow = /slow/i.test(p);
      const tick = () => {
        if (cancelled) { running.delete(m.id); return fail('Cancelled', { cancelled: true }); }
        step++;
        out({ event: 'progress', id: m.id, stage: 'separating', fraction: step / 5 });
        if (step < 5) return setTimeout(tick, slow ? 150 : 5);
        fs.mkdirSync(m.args.outDir, { recursive: true });
        const stems = ['drums', 'bass', 'vocals', 'other'].map((n) => {
          const f = path.join(m.args.outDir, n + '.wav');
          fs.writeFileSync(f, 'RIFF' + n + ' ' + path.basename(p));
          return { name: n, path: f, peakDb: -3, rmsDb: n === 'vocals' && /instrumental/i.test(path.basename(p)) ? -70 : -18 };
        });
        running.delete(m.id);
        ok({ model: m.args.model, device: 'cpu', seconds: 1.5, stems });
      };
      return tick();
    }
    case 'transcribe':
      // The drum stem of a "fullsong" (its source name is inside the fake stem file): the song's own hits.
      if (m.args.mode === 'drums' && /fullsong/i.test((() => { try { return fs.readFileSync(p, 'latin1'); } catch (e) { return ''; } })())) {
        return ok({ mode: 'drums', notes: [], source: 'onsets', hits: fullSong(p, false, true).drumHits });
      }
      if (m.args.mode === 'drums') {
        return ok({ mode: 'drums', notes: [], source: 'onsets', hits: [
          { timeSec: 0, role: 'kick', vel: 1 }, { timeSec: 0.25, role: 'hat', vel: 0.5 },
          { timeSec: 0.5, role: 'snare', vel: 0.8 }, { timeSec: 0.75, role: 'openhat', vel: 0.6 }, { timeSec: 1, role: 'kick', vel: 0.9 } ] });
      }
      if (/empty/i.test(p)) return ok({ mode: m.args.mode, notes: [], hits: [], source: 'pyin' });
      if (m.args.mode === 'mono' && /melody/i.test(path.basename(p))) {
        return ok({ mode: 'mono', hits: [], source: 'pyin', notes: MELODY.map(([b, d, k]) => ({ startSec: at(b), durSec: d * 0.5, key: k, vel: 0.8, cents: 0 })) });
      }
      if (m.args.mode === 'mono' && /[\\/]library[\\/]tmp[\\/]/i.test(p)) {
        const line = /bass/i.test(path.basename(p)) ? BASS : MELODY;
        return ok({ mode: 'mono', hits: [], source: 'pyin', notes: line.map(([b, d, k]) => ({ startSec: at(b), durSec: d * 0.5, key: k, vel: 0.8 })) });
      }
      return ok({ mode: m.args.mode, hits: [], source: m.args.mode === 'poly' ? 'basic-pitch' : 'pyin', notes: [
        { startSec: 0, durSec: 0.25, key: 60, vel: 0.8 }, { startSec: 0.5, durSec: 0.5, key: 64, vel: 0.6, cents: 12 } ] });
    case 'extract': {
      // A copy of the file under its new name; 2 s of 48 kHz mono, whatever it really is.
      fs.mkdirSync(path.dirname(m.args.out), { recursive: true });
      fs.copyFileSync(p, m.args.out);
      return ok({ path: m.args.out, frames: 96000, sampleRate: 48000, channels: 1 });
    }
    default: return fail('unknown cmd ' + m.cmd);
  }
});
rl.on('close', () => process.exit(0));
`;

export function writeFakeAnalyzer(dir: string): string {
  const file = path.join(dir, 'fake-analyzer.cjs');
  fs.writeFileSync(file, SCRIPT);
  return file;
}

/** A spawn hook for AnalyzerSupervisor that runs the fake with node. */
export function fakeSpawn(script: string, logFile?: string): (exe: string, args: string[]) => ChildProcessWithoutNullStreams {
  return (_exe, args) =>
    spawn(process.execPath, [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(logFile ? { FAKE_ANALYZER_LOG: logFile } : {}) },
    });
}

export function countRuns(logFile: string, cmd: string): number {
  try {
    return fs
      .readFileSync(logFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.startsWith(`${cmd} `)).length;
  } catch {
    return 0;
  }
}

// ── Shared fixtures ─────────────────────────────────────────────────────

/** The stock catalog plus the audio-clip params the engine adds for Wave 3A (when this build lacks them). */
export function earsCatalog(): PluginCatalog {
  const cat = structuredClone(CATALOG) as PluginCatalog;
  const ac = cat.plugins.find((p) => p.id === 'krypt.audioclip')!;
  const add = (s: ParamSpec) => {
    if (!ac.params.some((p) => p.id === s.id)) ac.params.push(s);
  };
  add({ id: 'pitch', name: 'Pitch', min: -24, max: 24, default: 0, unit: 'st', scale: 'linear', step: 0.01 });
  add({ id: 'formant', name: 'Formant', min: 0, max: 1, default: 1, unit: '', scale: 'linear', step: 1, options: ['Off', 'On'] });
  add({ id: 'tempo_sync', name: 'Tempo sync', min: 0, max: 1, default: 0, unit: '', scale: 'linear', step: 1, options: ['Off', 'On'] });
  add({ id: 'src_bpm', name: 'Source tempo', min: 0, max: 999, default: 0, unit: 'bpm', scale: 'linear' });
  add({ id: 'stretch', name: 'Stretch', min: 0.25, max: 4, default: 1, unit: 'x', scale: 'linear' });
  return cat;
}

const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
export const STEM_WEIGHTS = Buffer.from('demucs weights');
export const BP_WEIGHTS = Buffer.from('basic pitch weights');
const lic = { name: 'MIT', url: 'https://example.com' };

/** Model catalog for tests: Basic Pitch (bundled) + HT-Demucs (download), with real hashes of the weights above. */
export const TEST_MODELS: ModelDef[] = [
  { id: 'basic-pitch', name: 'Basic Pitch', task: 'transcribe', description: 'd', license: lic, bundled: true, default: true, files: [{ name: 'nmp.onnx', url: '', sha256: sha(BP_WEIGHTS), bytes: BP_WEIGHTS.length }] },
  { id: 'htdemucs', name: 'HT-Demucs (4 stems)', task: 'stems', description: 'd', license: { ...lic, notice: 'Trained partly on MUSDB18.' }, bundled: false, default: true, stems: ['drums', 'bass', 'vocals', 'other'], files: [{ name: 'htdemucs.onnx', url: 'https://example.com/htdemucs.onnx', sha256: sha(STEM_WEIGHTS), bytes: STEM_WEIGHTS.length }] },
];

/** Put model files where a ModelManager finds them: stems in userData/models, Basic Pitch in a bundled dir. */
export function stageModels(userDataDir: string, bundledDir: string, which: { stems?: boolean; basicPitch?: boolean }): void {
  if (which.stems) {
    fs.mkdirSync(path.join(userDataDir, 'models', 'htdemucs'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'models', 'htdemucs', 'htdemucs.onnx'), STEM_WEIGHTS);
  }
  if (which.basicPitch) {
    fs.mkdirSync(path.join(bundledDir, 'basic-pitch'), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, 'basic-pitch', 'nmp.onnx'), BP_WEIGHTS);
  }
}
