import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { PluginCatalog } from '@shared/plugins/types';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, TOOLS, resultText, type ToolCaller } from '../electron/mcp/tools';
import { AnalyzerSupervisor } from '../electron/analyzer/supervisor';
import { ModelManager } from '../electron/analyzer/models';
import { AnalyzerService } from '../electron/analyzer/service';
import { countRuns, earsCatalog, fakeSpawn, stageModels, TEST_MODELS, writeFakeAnalyzer } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-ears-mcp-'));
const script = writeFakeAnalyzer(TMP);
const logFile = path.join(TMP, 'calls.log');
const FACTORY = path.join(TMP, 'factory');
fs.mkdirSync(path.join(FACTORY, 'drums'), { recursive: true });
for (const f of ['kick.wav', 'snare.wav', 'hat-closed.wav', 'hat-open.wav', 'perc.wav']) fs.writeFileSync(path.join(FACTORY, 'drums', f), 'RIFF');
const USER_ROOT = path.join(TMP, 'samples');
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(USER_ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(USER_ROOT, 'Breakbeat.wav'), 'RIFF breakbeat');
fs.writeFileSync(path.join(OUTSIDE, 'secret.wav'), 'RIFF');

const SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'browser' },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
};

let n = 0;
async function rig(opts: { stems?: boolean; basicPitch?: boolean; catalog?: PluginCatalog; noAnalyzer?: boolean } = {}) {
  const root = path.join(TMP, `rig${++n}`);
  const userData = path.join(root, 'userData');
  const bundled = path.join(root, 'bundled');
  stageModels(userData, bundled, opts);
  const doc = new DocHost(createDefaultProject('Ears'), opts.catalog ?? earsCatalog(), { strict: true });
  const resolveSamplePath = (p: string) => (p.startsWith('factory:') ? path.join(FACTORY, p.slice('factory:'.length)) : p);
  const supervisor = new AnalyzerSupervisor({ resolveExe: () => process.execPath, missingMessage: 'not built', log: () => {}, spawn: fakeSpawn(script, logFile), idleShutdownMs: 0 });
  const models = new ModelManager({ catalog: TEST_MODELS, bundledDirs: [bundled], userModelsDir: path.join(userData, 'models'), log: () => {} });
  const analyzer = new AnalyzerService({ doc, supervisor, models, userDataDir: userData, resolveSamplePath, log: () => {} });
  await analyzer.init();
  const deps: MainDeps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} as never }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async () => ({ ok: false, message: 'n/a' }),
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo: async (p) => ({ ok: true, data: { path: p, frames: 352800, sampleRate: 44100, channels: 2, durationSec: 8 } }),
      restart: async () => ({ ok: true }),
    },
    project: {
      status: () => ({ path: null, name: 'Ears', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath,
      renderDir: () => path.join(root, 'renders'),
      allowedRoots: () => [USER_ROOT],
    },
    getSettings: () => SETTINGS,
    updateSettings: () => SETTINGS,
    broadcast: () => {},
    userDataDir: userData,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    analyzer: opts.noAnalyzer ? undefined : analyzer,
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'ears-agent', name: 'Ears Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const r = doc.exec<{ clipId: string; channelId: string }>(
    'playlist.addAudio',
    { path: path.join(USER_ROOT, 'Breakbeat.wav'), trackId: doc.project.playlist.trackOrder[0], start: 0, frames: 352800, sampleRate: 44100, channels: 2 },
    { actor: USER },
  );
  return { doc, deps, call, supervisor, clipId: r.data!.clipId, channelId: r.data!.channelId };
}

const agentEntries = (doc: DocHost) => doc.getHistory().filter((h) => h.actorKey === 'agent:ears-agent');

test('registry: the five ears tools are registered with the right kinds', () => {
  const kinds = Object.fromEntries(['analyze_audio', 'separate_stems', 'audio_to_pattern', 'stretch_clip', 'list_models'].map((t) => [t, getTool(t)?.kind]));
  assert.deepEqual(kinds, { analyze_audio: 'read', separate_stems: 'write', audio_to_pattern: 'write', stretch_clip: 'write', list_models: 'read' });
  assert.equal(TOOLS.length, 101, 'Wave 3B added the reference-library tools, Vocals & mashups import_audio / match_clip / tune_vocal / library_deep, then compare_to_reference, then set_song_info / set_cover / export_audio, then Wave 4 find_presets / load_preset / save_preset / apply_chain / get_playbook / review_song / add_transition, then Wave 5 list_packs, then study_reference, then Wave 8a match_sounds, match_mix, audio_to_project and build_from_reference, then 12.1 generate_notes, then 12.2 warp_clip, build_session, launch, build_rack, set_macro and slice_to_pads, then 12.2b write_script and run_script, comp_takes, and midi_setup, then auto_mashup, then auto_mix, then Krypt Voice list_voices, generate_voice and sing_notes, then the Slicer slice_sample and edit_slices, then the parity tools edit_clips, edit_automation, edit_rack, setup_recording, export_midi, import_midi and save_project');
});

test('without the analyzer service every ears tool fails in plain words', async () => {
  const { call, supervisor } = await rig({ noAnalyzer: true });
  for (const [tool, args] of [['analyze_audio', { target: 'Breakbeat' }], ['list_models', {}], ['separate_stems', { clip: 'Breakbeat' }]] as const) {
    const r = await call(tool, args);
    assert.equal(r.ok, false, tool);
    assert.match(r.message, /Audio analysis is not available in this session/, tool);
  }
  await supervisor.stop();
});

test('list_models: statuses, licences and the "agents can\'t download" rule', async () => {
  const { call, supervisor } = await rig({ basicPitch: true });
  const r = await call('list_models');
  assert.equal(r.ok, true);
  assert.equal(r.message, '2 models, 1 installed.');
  assert.match(r.text!, /basic-pitch\s+Basic Pitch · transcribe · installed \(bundled\) · licence MIT/);
  assert.match(r.text!, /htdemucs\s+HT-Demucs \(4 stems\) · stems · not installed \(the user can download it in Model Manager\) · licence MIT \(note: Trained partly on MUSDB18\.\)/);
  assert.match(r.text!, /Agents can't download or import models/);
  await supervisor.stop();
});

test('analyze_audio: by channel name → readable report with bars at the detected tempo; allow-listed files only', async () => {
  const { call, doc, supervisor } = await rig();
  const v = doc.version;
  const r = await call('analyze_audio', { target: 'Breakbeat' });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.version, v, 'read tool');
  assert.match(r.text!, /tempo {5}120 bpm, confidence 0\.9; also plausible 60 \/ 240 bpm \(estimated\)/);
  assert.match(r.text!, /key {7}F#m \(F# minor\), confidence 0\.7 \(estimated\)/);
  assert.match(r.text!, /swing {5}12%/);
  assert.match(r.text!, /sections {2}A bars 1-2 \(0:00\.1-0:04\.1, -10 LUFS\) \| B bars 3-4 \(0:04\.1-0:08\.0, -8 LUFS\)/);
  assert.match(r.text!, /loudness {2}I -9\.5 LUFS/);
  assert.match(r.text!, /stereo {4}width 0\.4/);
  const data = r.data as { tempo: { bpm: number }; sections: Array<{ bars: string }> };
  assert.equal(data.tempo.bpm, 120);
  assert.deepEqual(data.sections.map((s) => s.bars), ['1-2', '3-4']);
  assert.match(resultText(r, 'read'), /Analysed "Breakbeat"/);

  const file = await call('analyze_audio', { target: path.join(USER_ROOT, 'Breakbeat.wav') });
  assert.equal(file.ok, true, file.message);
  const out = await call('analyze_audio', { target: path.join(OUTSIDE, 'secret.wav') });
  assert.equal(out.ok, false);
  assert.match(out.message, /outside the folders Krypt Studio lets agents read/);
  const none = await call('analyze_audio', { target: 'Nope' });
  assert.match(none.message, /No channel "Nope"/);
  await supervisor.stop();
});

test('separate_stems without a model: tells the agent to ask the user; nothing changes, nothing runs', async () => {
  const { call, doc, supervisor } = await rig();
  const v = doc.version;
  const runs = countRuns(logFile, 'separate');
  const r = await call('separate_stems', { clip: 'Breakbeat' });
  assert.equal(r.ok, false);
  assert.match(r.message, /HT-Demucs \(4 stems\) isn't installed\. Agents can't download models: ask the user to install "HT-Demucs \(4 stems\)" in Krypt Studio's Model Manager\./);
  assert.equal(doc.version, v);
  assert.equal(countRuns(logFile, 'separate'), runs);
  const bad = await call('separate_stems', { clip: 'Breakbeat', model: 'basic-pitch' });
  assert.match(bad.message, /Basic Pitch is a transcribe model, not a stem separator/);
  await supervisor.stop();
});

test('separate_stems with a model: one agent undo group, stems on tracks under the clip, undo_last reverts it', async () => {
  const { call, doc, clipId, supervisor } = await rig({ stems: true });
  const r = await call('separate_stems', { clip: clipId, change_label: 'Split the break' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.text!, /New stem tracks:\n {2}T2 "Breakbeat · Drums" → channel ch_/);
  const entries = agentEntries(doc);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'Split the break');
  assert.ok(r.changed.length >= 12, `changed ids come from patches (${r.changed.length})`);
  assert.equal(doc.project.playlist.clips[clipId].mute, true);
  const undo = await call('undo_last');
  assert.equal(undo.ok, true, undo.message);
  assert.equal(doc.project.playlist.clips[clipId].mute, false);
  await supervisor.stop();
});

test('audio_to_pattern: drums by channel name with quantize; poly without Basic Pitch fails clearly', async () => {
  const { call, doc, supervisor } = await rig();
  const r = await call('audio_to_pattern', { target: 'Breakbeat', mode: 'drums', quantize: '1/16', name: 'Break drums' });
  assert.equal(r.ok, true, r.message);
  const data = r.data as { patternId: string; channelIds: string[]; notes: number };
  const pat = doc.project.patterns[data.patternId];
  assert.equal(pat.name, 'Break drums');
  assert.equal(data.notes, 5);
  for (const notes of Object.values(pat.notes)) for (const note of Object.values(notes)) assert.equal(note.tick % 240, 0, 'on the 16th grid');
  assert.ok(Object.values(doc.project.playlist.clips).some((c) => c.patternId === pat.id), 'placed under the clip');
  assert.equal(agentEntries(doc).length, 1);
  const poly = await call('audio_to_pattern', { target: 'Breakbeat', mode: 'poly' });
  assert.equal(poly.ok, false);
  assert.match(poly.message, /Polyphonic transcription needs the Basic Pitch model, which isn't installed/);
  await supervisor.stop();
});

test('stretch_clip: sync_to_tempo uses the analysed tempo and rescales the clip; pitch/formant; no-op = "No change"', async () => {
  const { call, doc, clipId, channelId, supervisor } = await rig();
  const len0 = doc.project.playlist.clips[clipId].length;
  const r = await call('stretch_clip', { clip: 'Breakbeat', sync_to_tempo: true, pitch: '+2st', formant: true });
  assert.equal(r.ok, true, r.message);
  const ch = doc.project.channels[channelId];
  assert.deepEqual([ch.generator.params.tempo_sync, ch.generator.params.src_bpm, ch.generator.params.pitch, ch.generator.params.formant], [1, 120, 2, 1]);
  assert.match(r.message, /synced to the project tempo from 120 bpm \(detected, confidence 0\.9\)/);
  assert.match(r.message, /It now follows the project's 140 bpm/);
  const len1 = doc.project.playlist.clips[clipId].length;
  assert.equal(len1, Math.round((len0 * 120) / 140), 'same audio, new tick scale');
  assert.equal(agentEntries(doc).length, 1, 'params + clip rescale = one undo group');
  const again = await call('stretch_clip', { clip: clipId, sync_to_tempo: true, source_bpm: 120 });
  assert.equal(again.ok, false);
  assert.match(again.message, /^No change/);
  const off = await call('stretch_clip', { clip: clipId, sync_to_tempo: false });
  assert.equal(off.ok, true, off.message);
  assert.equal(doc.project.playlist.clips[clipId].length, Math.round((len1 * 140) / 120));
  const nothing = await call('stretch_clip', { clip: clipId });
  assert.match(nothing.message, /Nothing to change/);
  const synth = await call('stretch_clip', { clip: 'Keys', pitch: 1 });
  assert.match(synth.message, /stretch_clip works on audio clips; "Keys" is a Krypt TriOsc channel/);
  await supervisor.stop();
});

test('stretch_clip on an engine build without the stretch params says so', async () => {
  const stock = structuredClone(CATALOG) as PluginCatalog;
  const ac = stock.plugins.find((p) => p.id === 'krypt.audioclip')!;
  ac.params = ac.params.filter((p) => !['pitch', 'formant', 'tempo_sync', 'src_bpm', 'stretch'].includes(p.id));
  const { call, supervisor } = await rig({ catalog: stock });
  const r = await call('stretch_clip', { clip: 'Breakbeat', pitch: 3 });
  assert.equal(r.ok, false);
  assert.match(r.message, /This build's Audio Clip has no "pitch" parameter yet/);
  await supervisor.stop();
});

await run('ears tools');
fs.rmSync(TMP, { recursive: true, force: true });
