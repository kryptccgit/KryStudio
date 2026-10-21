// The shared MCP / agent tool registry, driven against a real DocHost with a
// fake EngineClient. Also an end-to-end check of the named-pipe MCP server
// (2025 initialize era) when running on Windows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, actorKey } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity } from '@shared/schema/project';
import { getParamValue } from '@shared/schema/params';
import { parse } from '@shared/kpn';
import type { Settings, AgentActivity, McpStatus } from '@shared/types';
import type { Analysis, RenderRequest } from '@shared/engine/protocol';
import type { MainDeps } from '../electron/mcp/types';
import { MCP_CHANNELS } from '../electron/mcp/types';
import { callTool, newSession, TOOLS, inputJsonSchema, resultText, type ToolCaller } from '../electron/mcp/tools';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-mcp-test-'));
const FACTORY = path.join(TMP, 'factory');
const USER_ROOT = path.join(TMP, 'user-samples');
const OUTSIDE = path.join(TMP, 'outside');
for (const d of [path.join(FACTORY, 'drums'), USER_ROOT, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
for (const f of ['kick.wav', 'snare.wav', 'clap.wav', 'hat-closed.wav', 'hat-open.wav']) fs.writeFileSync(path.join(FACTORY, 'drums', f), 'RIFF');
fs.writeFileSync(path.join(USER_ROOT, 'Tight Snare 01.wav'), 'RIFF');
fs.writeFileSync(path.join(OUTSIDE, 'secret.wav'), 'RIFF');

const SETTINGS: Settings = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
};

const ANALYSIS: Analysis = {
  durationSec: 4,
  peakDb: -0.3,
  truePeakDb: -0.2,
  lufsIntegrated: -9.8,
  lufsShortTermMax: -8.1,
  loudnessRange: 3,
  rmsDb: -12,
  crestDb: 9,
  bands: { sub: -10, low: -12, lowMid: -14, mid: -22, highMid: -24, high: -30 },
  stereoCorrelation: 0.7,
  stereoWidth: 0.4,
  energyCurve: [-12, -10, -9, -9],
  clipping: false,
  estimatedBpm: 140,
  spectralCentroidHz: 1800,
};

function makeDeps(opts: { engineRunning?: boolean } = {}) {
  const doc = new DocHost(createDefaultProject('Test'), CATALOG, { strict: true });
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const renders: RenderRequest[] = [];
  const engineRequests: unknown[] = [];
  const running = opts.engineRunning ?? true;
  let settings = structuredClone(SETTINGS);
  const deps: MainDeps = {
    doc,
    engine: {
      async request(req) {
        engineRequests.push(req);
        return running ? { ok: true, data: {} as never } : { ok: false, message: 'engine not running' };
      },
      status: () => ({ state: running ? 'running' : 'failed', device: null, engineVersion: '0.1.0', restarts: 0, message: running ? undefined : 'not built yet' }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async render(job) {
        renders.push(job);
        if (!running) return { ok: false, message: 'engine not running' };
        return { ok: true, data: { path: job.path, files: [job.path], durationSec: 4, peakDb: -0.3, lufsIntegrated: -9.8, analysis: ANALYSIS } };
      },
      async analyzeFile() {
        return { ok: false, message: 'n/a' };
      },
      async sampleInfo(p) {
        return { ok: true, data: { path: p, frames: 48000, sampleRate: 48000, channels: 2, durationSec: 1 } };
      },
      async restart() {
        return { ok: true };
      },
    },
    project: {
      status: () => ({ path: null, name: 'Test', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => (p.startsWith('factory:') ? path.join(FACTORY, p.slice('factory:'.length)) : p),
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [USER_ROOT],
    },
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    userDataDir: path.join(TMP, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args);
  return { deps, doc, caller, call, broadcasts, renders, engineRequests };
}

const TRAP = `pattern "Trap A" bars=2 grid=16 key=F#m
kick       : x... .... ..x. .... | x... .... .x.. ..x.
snare      : .... X... .... X... | .... X... .... X..o
hat/32     : (x.x.)*7 xxxx | (x.x.)*6 xxxx xxxx
openhat    : .... .... .... ..o. | .... .... .... ....
808 {oct=1}: F#1:6 r:4 C#2:2 E2:4 | F#1:8~ C#1:4 r:2 A1:2`;

function notesOf(doc: DocHost, patId: string, chId: string) {
  return Object.values(doc.project.patterns[patId].notes[chId] ?? {});
}

// ── Registry shape ──────────────────────────────────────────────────────

test('registry: 85 uniquely named tools (incl. write_script / run_script, build_rack / set_macro / slice_to_pads, slice_sample / edit_slices, the 7 reference-library, 3 vocals, 3 release, 4 sound, 3 craft and 1 sound-pack tools, compare_to_reference, study_reference and generate_notes) with descriptions and JSON schemas', () => {
  assert.equal(TOOLS.length, 101, `${TOOLS.length} tools (update docs/MCP.md and the README count when this changes)`);
  for (const n of ['library_status', 'search_references', 'read_reference', 'get_style_profile', 'check_originality', 'library_import', 'library_deep', 'import_audio', 'match_clip', 'tune_vocal', 'set_song_info', 'set_cover', 'export_audio']) assert.ok(TOOLS.some((t) => t.name === n), n);
  const names = new Set<string>();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{1,63}$/, t.name);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 30, t.name);
    const s = inputJsonSchema(t);
    assert.equal(s.type, 'object', t.name);
  }
  for (const required of ['get_project', 'list_channels', 'list_patterns', 'describe_plugin', 'list_plugins', 'get_mixer', 'write_pattern', 'read_pattern', 'add_notes', 'clear_pattern', 'create_pattern', 'select_pattern', 'transform_notes', 'shape_notes', 'restructure_song', 'add_channel', 'set_instrument', 'set_params', 'load_sample', 'arrange', 'add_clip', 'remove_clips', 'set_tempo', 'set_swing', 'set_mode', 'add_marker', 'add_automation', 'set_mixer', 'add_effect', 'set_effect', 'route', 'sidechain', 'render_preview', 'play', 'stop', 'undo_last', 'revert_all_agent_edits', 'begin_edit', 'commit_edit', 'get_history', 'analyze_audio', 'separate_stems', 'audio_to_pattern', 'stretch_clip', 'list_models', 'compare_to_reference']) {
    assert.ok(names.has(required), `missing ${required}`);
  }
});

// ── write_pattern / read_pattern ────────────────────────────────────────

test('write_pattern: creates the pattern from the header, maps aliases, creates missing channels', async () => {
  const { doc, call, broadcasts } = makeDeps();
  const r = await call('write_pattern', { kpn: TRAP });
  assert.equal(r.ok, true, r.message);
  const p = doc.project;
  const pat = Object.values(p.patterns).find((x) => x.name === 'Trap A')!;
  assert.ok(pat, 'pattern created');
  assert.equal(p.transport.activePatternId, pat.id);
  assert.equal(pat.length, 2 * 3840);
  const byName = (n: string) => p.channelOrder.map((id) => p.channels[id]).find((c) => c.name.toLowerCase() === n.toLowerCase())!;
  assert.equal(notesOf(doc, pat.id, byName('Kick').id).length, 5);
  assert.equal(notesOf(doc, pat.id, byName('Hat').id).length, 38, 'hat alias maps to the Hat channel');
  const oh = byName('Openhat');
  assert.ok(oh, 'openhat channel created');
  assert.equal(oh.generator.type, 'krypt.sampler');
  assert.equal(p.samples[oh.generator.sampleId!].path, 'factory:drums/hat-open.wav');
  const eight = notesOf(doc, pat.id, byName('808').id).sort((a, b) => a.tick - b.tick);
  assert.equal(eight.length, 6);
  assert.equal(eight.filter((n) => n.slide).length, 1, 'the ~ makes the next note a slide note');
  assert.ok(r.changed.includes(pat.id));
  assert.ok(r.changed.includes(oh.id));
  assert.deepEqual(checkIntegrity(doc.project), []);
  // Exactly one history entry for the whole call, by the agent.
  const hist = doc.getHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].actorKey, 'agent:test-agent');
  assert.match(hist[0].label, /write_pattern/);
  const act = broadcasts.filter((b) => b.channel === MCP_CHANNELS.activity).map((b) => b.payload as AgentActivity);
  assert.equal(act.length, 1);
  assert.equal(act[0].ok, true);
  assert.equal(act[0].tool, 'write_pattern');
  assert.ok(act[0].touched?.some((t) => t.kind === 'pattern'));
});

test('write_pattern: identical rewrite is reported as a no-op, never as success', async () => {
  const { doc, call } = makeDeps();
  assert.equal((await call('write_pattern', { kpn: TRAP })).ok, true);
  const v = doc.version;
  const r = await call('write_pattern', { kpn: TRAP });
  assert.equal(r.ok, false);
  assert.match(r.message, /^No change/);
  assert.equal(doc.version, v);
  assert.deepEqual(r.changed, []);
});

test('write_pattern: parse errors name line/bar and write nothing', async () => {
  const { doc, call } = makeDeps();
  const v = doc.version;
  const r = await call('write_pattern', { kpn: 'pattern "Broken" bars=1\nkick : x... x... x.x x...\nlead : C4:4 D4:4 E4:6 | F4:2' });
  assert.equal(r.ok, false);
  assert.match(r.message, /line 2 \(kick\): 15 steps total, expected 16/);
  assert.match(r.message, /line 3 \(lead\), bar 1: has 14\/16 steps/);
  assert.equal(doc.version, v);
  assert.equal(doc.getHistory().length, 0);
});

test('write_pattern: create_missing false lists the channels instead of creating', async () => {
  const { doc, call } = makeDeps();
  const before = doc.project.channelOrder.length;
  const r = await call('write_pattern', { kpn: 'lead: C4 D4 E4 F4', create_missing: false });
  assert.equal(r.ok, false);
  assert.match(r.message, /No channel for "lead"/);
  assert.equal(doc.project.channelOrder.length, before);
});

test('write_pattern: merge sets, clears with _ and keeps . untouched; append extends', async () => {
  const { doc, call } = makeDeps();
  await call('write_pattern', { kpn: 'pattern "M" bars=1\nkick: x... x... x... x...' });
  const pat = Object.values(doc.project.patterns).find((x) => x.name === 'M')!;
  const kick = doc.project.channelOrder.find((id) => doc.project.channels[id].name === 'Kick')!;
  const r = await call('write_pattern', { kpn: 'kick: _... .... ..X. ....', pattern: 'M', mode: 'merge' });
  assert.equal(r.ok, true, r.message);
  const ticks = notesOf(doc, pat.id, kick).map((n) => n.tick).sort((a, b) => a - b);
  assert.deepEqual(ticks, [960, 1920, 2400, 2880]);
  const ap = await call('write_pattern', { kpn: 'kick: x... .... .... ....', pattern: 'M', mode: 'append' });
  assert.equal(ap.ok, true, ap.message);
  assert.equal(doc.project.patterns[pat.id].length, 2 * 3840);
  assert.ok(notesOf(doc, pat.id, kick).some((n) => n.tick === 3840));
});

test('write_pattern: shrinking bars never truncates channels that were not written', async () => {
  const { doc, call } = makeDeps();
  await call('write_pattern', { kpn: 'pattern "Long" bars=2\nkick: x... .... .... .... | x... .... .... ....\nclap: .... x... .... x... | .... x... .... x...' });
  const r = await call('write_pattern', { kpn: 'pattern "Long" bars=1\nkick: x... x... x... x...' });
  assert.equal(r.ok, true);
  const pat = Object.values(doc.project.patterns).find((x) => x.name === 'Long')!;
  assert.equal(pat.length, 2 * 3840);
  assert.ok(r.warnings?.some((w) => /kept the pattern at 2 bars/.test(w)));
});

test('write_pattern → read_pattern round-trips through canonical KPN', async () => {
  const { doc, call } = makeDeps();
  await call('write_pattern', { kpn: TRAP });
  const read = await call('read_pattern', { pattern: 'Trap A', key: 'F#m' });
  assert.equal(read.ok, true);
  const kpn = read.text!;
  assert.match(kpn, /^pattern "Trap A" bars=2 grid=16 key=F#m/);
  assert.match(kpn, /Kick\s*: x\.\.\. \.\.\.\. \.\.x\. \.\.\.\. \| x\.\.\. \.\.\.\. \.x\.\. \.\.x\./);
  assert.match(kpn, /Hat\/32/);
  // Writing the canonical text back is a no-op.
  const again = await call('write_pattern', { kpn, pattern: 'Trap A' });
  assert.equal(again.ok, false);
  assert.match(again.message, /^No change/);
  const json = await call('read_pattern', { pattern: 'Trap A', format: 'json', channels: ['808'] });
  const ch = (json.data as { channels: Array<{ notes: Array<{ tick: number; note: string }> }> }).channels[0];
  assert.equal(ch.notes[0].note, 'F#1');
  void doc;
});

// ── Notes, patterns, transforms ─────────────────────────────────────────

test('add_notes, transform_notes (transpose by degrees, humanize), clear_pattern', async () => {
  const { doc, call } = makeDeps();
  const r = await call('add_notes', { channel: 'Keys', notes: [{ key: 'A3', at: '1', len: 4 }, { key: 'C4', at: '1.5', len: 4 }, { key: 64, tick: 1920, dur: 960, vel: 90 }] });
  assert.equal(r.ok, true, r.message);
  const pat = doc.project.transport.activePatternId!;
  const keys = doc.project.channelOrder.find((id) => doc.project.channels[id].name === 'Keys')!;
  const t = await call('transform_notes', { channel: 'Keys', ops: [{ op: 'transpose', degrees: 2, key: 'Am' }] });
  assert.equal(t.ok, true, t.message);
  assert.deepEqual(notesOf(doc, pat, keys).map((n) => n.key).sort(), [60, 64, 67].sort(), 'A3 C4 E4 up a third in A minor → C4 E4 G4');
  const h = await call('transform_notes', { channel: 'Keys', ops: [{ op: 'velocity', set: 100 }] });
  assert.equal(h.ok, true);
  const noop = await call('transform_notes', { channel: 'Keys', ops: [{ op: 'velocity', set: 100 }] });
  assert.equal(noop.ok, false);
  assert.match(noop.message, /No change/);
  const c = await call('clear_pattern', { channels: ['Keys'] });
  assert.equal(c.ok, true);
  assert.equal(notesOf(doc, pat, keys).length, 0);
  const c2 = await call('clear_pattern', { channels: ['Keys'] });
  assert.equal(c2.ok, false);
});

test('shape_notes: arpeggiate → levels chain on the new notes, scale snap, in-key randomize, flags no-op', async () => {
  const { doc, call } = makeDeps();
  const add = await call('add_notes', { channel: 'Keys', notes: [{ key: 'C4', at: '1', len: 16 }, { key: 'E4', at: '1', len: 16 }, { key: 'G4', at: '1', len: 16 }, { key: 'C#4', at: '2', len: 4 }] });
  assert.equal(add.ok, true, add.message);
  const pat = doc.project.transport.activePatternId!;
  const keys = doc.project.channelOrder.find((id) => doc.project.channels[id].name === 'Keys')!;
  const bar1 = () => notesOf(doc, pat, keys).filter((n) => n.tick < 3840).sort((x, y) => x.tick - y.tick);

  const r = await call('shape_notes', { channel: 'Keys', select: { bars: '1' }, ops: [{ op: 'arpeggiate', style: 'up', rate_steps: 4 }, { op: 'levels', prop: 'velocity', from: 0.25, to: 1 }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(bar1().map((n) => [n.tick, n.key, n.vel, n.dur]), [[0, 60, 0.25, 864], [960, 64, 0.5, 864], [1920, 67, 0.75, 864], [2880, 60, 1, 864]], 'quarter-note arp, then the ramp shapes the NEW notes');
  assert.equal((await call('undo_last')).ok, true);
  assert.deepEqual(bar1().map((n) => n.key).sort(), [60, 64, 67], 'one undo restores the chord: the whole chain was ONE step');
  assert.equal((await call('shape_notes', { channel: 'Keys', select: { bars: '1' }, ops: [{ op: 'arpeggiate', style: 'up', rate_steps: 4 }] })).ok, true);

  const snap = await call('shape_notes', { channel: 'Keys', select: { bars: '2' }, ops: [{ op: 'scale_snap', key: 'C' }] });
  assert.equal(snap.ok, true, snap.message);
  assert.deepEqual(notesOf(doc, pat, keys).filter((n) => n.tick >= 3840).map((n) => n.key), [60], 'C#4 ties go down to C4');

  const rnd = await call('shape_notes', { channel: 'Keys', ops: [{ op: 'randomize', pitch: 3, key: 'A minorPentatonic', seed: 7 }] });
  assert.equal(rnd.ok, true, rnd.message);
  for (const n of notesOf(doc, pat, keys)) assert.ok([9, 0, 2, 4, 7].includes(n.key % 12), `${n.key} left A minor pentatonic`);

  const mute = await call('shape_notes', { channel: 'Keys', select: { bars: '1' }, ops: [{ op: 'flags', mute: true, color: 3 }] });
  assert.equal(mute.ok, true, mute.message);
  assert.ok(bar1().every((n) => n.mute === true && n.color === 3));
  const again = await call('shape_notes', { channel: 'Keys', select: { bars: '1' }, ops: [{ op: 'flags', mute: true, color: 3 }] });
  assert.equal(again.ok, false, 'identical flags are a no-op, never a false success');
  const bad = await call('shape_notes', { channel: 'Keys', ops: [{ op: 'scale_snap', key: 'H lydian' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Unknown key/);
});

test('transform_notes quantize with swing uses the piano roll grid', async () => {
  const { doc, call } = makeDeps();
  await call('create_pattern', { name: 'Swing', bars: 1, select: true });
  await call('add_notes', { channel: 'Keys', notes: [0, 250, 480, 730].map((tick) => ({ key: 60, tick, dur: 100 })) });
  const pat = doc.project.transport.activePatternId!;
  const keys = doc.project.channelOrder.find((id) => doc.project.channels[id].name === 'Keys')!;
  const r = await call('transform_notes', { channel: 'Keys', ops: [{ op: 'quantize', grid: 16, swing: 0.5 }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(notesOf(doc, pat, keys).map((n) => n.tick).sort((a, b) => a - b), [0, 300, 480, 780], 'odd 16ths land 60 ticks late');
});

test('create_pattern / select_pattern (no-op detection)', async () => {
  const { doc, call } = makeDeps();
  const r = await call('create_pattern', { name: 'Verse', bars: 4, select: false });
  assert.equal(r.ok, true);
  const id = (r.data as { id: string }).id;
  assert.equal(doc.project.patterns[id].length, 4 * 3840);
  assert.notEqual(doc.project.transport.activePatternId, id);
  assert.equal((await call('select_pattern', { pattern: 'Verse' })).ok, true);
  assert.equal(doc.project.transport.activePatternId, id);
  const again = await call('select_pattern', { pattern: 'Verse' });
  assert.equal(again.ok, false);
});

// ── Sound ───────────────────────────────────────────────────────────────

test('add_channel picks instruments by name; set_params takes human units and reports before → after', async () => {
  const { doc, call } = makeDeps();
  const r = await call('add_channel', { name: 'Pad', params: { cutoff: '1.2kHz' } });
  assert.equal(r.ok, true, r.message);
  const id = (r.data as { id: string }).id;
  assert.equal(doc.project.channels[id].generator.type, 'krypt.triosc');
  assert.equal(doc.project.channels[id].generator.params.cutoff, 1200);
  const s = await call('set_params', { channel: 'Pad', params: { cutoff: '800Hz', reso: '30%', osc1Shape: 'Square' } });
  assert.equal(s.ok, true, s.message);
  assert.match(s.message, /cutoff 1\.20 kHz → 800 Hz/);
  assert.equal(doc.project.channels[id].generator.params.osc1Shape, 3);
  const bad = await call('set_params', { channel: 'Pad', params: { cutof: 100 } });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Close matches: cutoff/);
  const same = await call('set_params', { channel: 'Pad', params: { cutoff: 800 } });
  assert.equal(same.ok, false, 'setting the current value is a no-op');
  const mix = await call('set_params', { insert: 'Master', effect: 'limiter', params: { ceiling: '-2dB' } });
  assert.equal(mix.ok, true, mix.message);
  const master = doc.project.mixer.inserts[doc.project.mixer.masterId];
  assert.equal(master.slots[master.slotOrder[0]].params.ceiling, -2);
  const ref = await call('set_params', { params: { [`channel/${id}/gen/reso`]: 0.5 } });
  assert.equal(ref.ok, true, ref.message);
  assert.equal(getParamValue(doc.project, CATALOG, `channel/${id}/gen/reso`), 0.5);
});

test('set_channel / set_instrument', async () => {
  const { doc, call } = makeDeps();
  const r = await call('set_channel', { channel: '808', volume_db: -6, glide_ms: 90, pan: -0.2 });
  assert.equal(r.ok, true, r.message);
  const ch = Object.values(doc.project.channels).find((c) => c.name === '808')!;
  assert.ok(Math.abs(ch.volume - 0.501) < 0.01);
  assert.equal(ch.poly.glideMs, 90);
  const s = await call('set_instrument', { channel: 'Keys', instrument: 'drumsynth', params: { voice: 'Cowbell' } });
  assert.equal(s.ok, true, s.message);
  const keys = Object.values(doc.project.channels).find((c) => c.name === 'Keys')!;
  assert.equal(keys.generator.type, 'krypt.drumsynth');
  assert.equal(keys.generator.params.voice, 7);
});

test('load_sample: factory, roots and (File access "anywhere") any local file; UNC, relative, ADS refused; "browser" refuses outside files', async () => {
  const { doc, call, deps } = makeDeps();
  const f = await call('load_sample', { sample: 'factory:drums/snare.wav', name: 'Snare 2' });
  assert.equal(f.ok, true, f.message);
  const u = await call('load_sample', { sample: path.join(USER_ROOT, 'Tight Snare 01.wav'), channel: 'Snare 2' });
  assert.equal(u.ok, true, u.message);
  const ch = Object.values(doc.project.channels).find((c) => c.name === 'Snare 2')!;
  assert.match(doc.project.samples[ch.generator.sampleId!].path, /Tight Snare 01\.wav$/);
  for (const bad of ['\\\\server\\share\\x.wav', 'relative\\x.wav', 'factory:../../etc/x.wav', `${path.join(USER_ROOT, 'Tight Snare 01.wav')}:stream`, path.join(USER_ROOT, 'nope.wav')]) {
    const r = await call('load_sample', { sample: bad });
    assert.equal(r.ok, false, `should refuse ${bad}`);
  }
  // The default File access ("anywhere") opens any local audio file; "browser" keeps agents to the roots.
  assert.equal((await call('load_sample', { sample: path.join(OUTSIDE, 'secret.wav') })).ok, true);
  fs.writeFileSync(path.join(OUTSIDE, 'other.wav'), 'RIFF');
  deps.updateSettings({ mcp: { ...deps.getSettings().mcp, fileAccess: 'browser' } });
  const refused = await call('load_sample', { sample: path.join(OUTSIDE, 'other.wav') });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /outside the folders Krypt Studio lets agents read \(Settings ▸ Agents ▸ File access is set to "Browser folders only"\)/);
  assert.equal((await call('load_sample', { sample: path.join(OUTSIDE, 'secret.wav') })).ok, true, 'a file the project already uses is always allowed');
  const notSampler = await call('load_sample', { sample: 'factory:drums/kick.wav', channel: 'Keys' });
  assert.equal(notSampler.ok, false);
  assert.match(notSampler.message, /set_instrument/);
  const found = await call('find_samples', { query: 'snare' });
  assert.equal(found.ok, true);
  assert.match(found.text!, /factory:drums\/snare\.wav/);
  assert.match(found.text!, /Tight Snare 01\.wav/);
});

// ── Arrangement & mixing ────────────────────────────────────────────────

test('arrange tiles patterns over bar ranges, switches to song mode, and is idempotent', async () => {
  const { doc, call } = makeDeps();
  await call('write_pattern', { kpn: TRAP });
  const r = await call('arrange', { placements: [{ pattern: 'Trap A', bars: '1-8' }] });
  assert.equal(r.ok, true, r.message);
  const clips = Object.values(doc.project.playlist.clips);
  assert.equal(clips.length, 4);
  assert.deepEqual(clips.map((c) => c.start).sort((a, b) => a - b), [0, 7680, 15360, 23040]);
  assert.equal(doc.project.transport.mode, 'song');
  const again = await call('arrange', { placements: [{ pattern: 'Trap A', bars: '1-8' }] });
  assert.equal(again.ok, false);
  const m = await call('add_marker', { markers: [{ at: 1, name: 'Intro' }, { at: 5, name: 'Drop' }] });
  assert.equal(m.ok, true);
  const rm = await call('remove_clips', { bars: '5-8' });
  assert.equal(rm.ok, true);
  assert.equal(Object.keys(doc.project.playlist.clips).length, 2);
  const add = await call('add_clip', { pattern: 'Trap A', at: '9', track: 2 });
  assert.equal(add.ok, true, add.message);
});

test('restructure_song: insert bars, split by channel, consolidate; remove_clips close_gap deletes song time', async () => {
  const { doc, call } = makeDeps();
  await call('write_pattern', { kpn: TRAP });
  await call('arrange', { placements: [{ pattern: 'Trap A', bars: '1-8' }] });
  const starts = () => Object.values(doc.project.playlist.clips).map((c) => c.start).sort((a, b) => a - b);

  const ins = await call('restructure_song', { op: 'insert_bars', at: 5, bars: 4 });
  assert.equal(ins.ok, true, ins.message);
  assert.deepEqual(starts(), [0, 7680, 30720, 38400]);
  const del = await call('remove_clips', { bars: '5-8', close_gap: true });
  assert.equal(del.ok, true, del.message);
  assert.deepEqual(starts(), [0, 7680, 15360, 23040], 'deleting the inserted bars closes the gap again');
  const mixed = await call('remove_clips', { bars: '5-8', pattern: 'Trap A', close_gap: true });
  assert.equal(mixed.ok, false, 'close_gap is song-wide: filters other than bars are refused');

  const split = await call('restructure_song', { op: 'split_by_channel', bars: '1-2' });
  assert.equal(split.ok, true, split.message);
  const firstBars = Object.values(doc.project.playlist.clips).filter((c) => c.start === 0);
  assert.equal(firstBars.length, 5, 'one clip per channel with notes');
  assert.ok(firstBars.every((c) => c.patternId && Object.keys(doc.project.patterns[c.patternId].notes).length === 1));

  const cons = await call('restructure_song', { op: 'consolidate', bars: '3-8', name: 'Body' });
  assert.equal(cons.ok, true, cons.message);
  const body = Object.values(doc.project.patterns).find((p) => p.name === 'Body')!;
  assert.ok(body, cons.message);
  const bodyClips = Object.values(doc.project.playlist.clips).filter((c) => c.patternId === body.id);
  assert.deepEqual(bodyClips.map((c) => [c.start, c.length]), [[7680, 23040]]);
  assert.equal(Object.keys(doc.project.playlist.clips).length, 6);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('tempo, swing, mode, automation', async () => {
  const { doc, call } = makeDeps();
  assert.equal((await call('set_tempo', { bpm: 92, time_signature: '4/4' })).ok, true);
  assert.equal(doc.project.transport.bpm, 92);
  assert.equal((await call('set_swing', { percent: 30 })).ok, true);
  assert.equal(doc.project.transport.swing, 0.3);
  assert.equal((await call('set_swing', { percent: 30 })).ok, false, 'same swing is a no-op');
  assert.equal((await call('set_mode', { mode: 'song' })).ok, true);
  assert.equal((await call('set_mode', { mode: 'song' })).ok, false);
  const a = await call('add_automation', { channel: 'Keys', param: 'cutoff', bars: '1-4', from: '300Hz', to: '8kHz', curve: 'exp' });
  assert.equal(a.ok, true, a.message);
  const aut = Object.values(doc.project.automations)[0];
  assert.match(aut.target!, /^channel\/.+\/gen\/cutoff$/);
  assert.equal(Object.keys(aut.points).length, 2);
  assert.equal(Object.values(doc.project.playlist.clips).filter((c) => c.kind === 'automation').length, 1);
});

test('mixer: set_mixer, add_effect, set_effect, route to a bus, sidechain', async () => {
  const { doc, call } = makeDeps();
  const v = await call('set_mixer', { updates: [{ insert: '808', volume_db: -4 }, { insert: 'Hat', pan: 0.2 }] });
  assert.equal(v.ok, true, v.message);
  const e = await call('add_effect', { insert: 'Keys', effect: 'reverb', params: { mode: 'Hall', decay: '2.5s' }, mix: 25 });
  assert.equal(e.ok, true, e.message);
  const keysIns = Object.values(doc.project.mixer.inserts).find((i) => i.name === 'Keys')!;
  const slot = keysIns.slots[keysIns.slotOrder[0]];
  assert.equal(slot.type, 'krypt.reverb');
  assert.equal(slot.params.mode, 1);
  assert.equal(slot.mix, 0.25);
  const se = await call('set_effect', { insert: 'Keys', effect: 'reverb', enabled: false });
  assert.equal(se.ok, true);
  const bus = await call('route', { channel: 'Clap', to: 'new' });
  assert.equal(bus.ok, true, bus.message);
  const r = await call('route', { from_insert: 'Kick', to: 'Snare' });
  assert.equal(r.ok, true, r.message);
  const kickIns = Object.values(doc.project.mixer.inserts).find((i) => i.name === 'Kick')!;
  assert.deepEqual(Object.keys(kickIns.routes), [Object.values(doc.project.mixer.inserts).find((i) => i.name === 'Snare')!.id]);
  const sc = await call('sidechain', { source: 'Kick', target: '808', depth: 60 });
  assert.equal(sc.ok, true, sc.message);
  const eightIns = Object.values(doc.project.mixer.inserts).find((i) => i.name === '808')!;
  const duck = Object.values(eightIns.slots).find((s) => s.type === 'krypt.duck')!;
  assert.equal(duck.sidechainFrom, kickIns.id);
  const loop = await call('route', { from_insert: 'Snare', to: 'Kick' });
  assert.equal(loop.ok, false, 'feedback loops are refused');
  assert.match(loop.message, /feedback loop/);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('Gate/Time custom steps: add_effect / set_effect take step text or a preset name, with human errors', async () => {
  const { doc, call } = makeDeps();
  const e = await call('add_effect', { insert: 'Keys', effect: 'stutter', steps: '1/8 P P R2 R2 V V . S:50' });
  assert.equal(e.ok, true, e.message);
  assert.match(e.message, /Steps: 1\/8 P P R2 R2 V V \. S:50/);
  const keys = () => Object.values(doc.project.mixer.inserts).find((i) => i.name === 'Keys')!;
  const slot = () => keys().slots[keys().slotOrder[0]];
  assert.equal(slot().type, 'krypt.gate');
  assert.equal(slot().params.pattern, 10);
  assert.equal(slot().params.stepDiv, 2);
  assert.equal(slot().params.stepCount, 8);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => slot().params[`s${i}`]), [0, 0, 1, 1, 6, 6, 0, 7, 0]);
  assert.equal(slot().params.g7, 0);
  assert.equal(slot().params.g8, 0.5);
  const p = await call('set_effect', { insert: 'Keys', effect: 'gate', steps: 'Tape stop end' });
  assert.equal(p.ok, true, p.message);
  assert.match(p.message, /steps 1\/16 P P P P P P P P P P P P S S S S/);
  assert.equal(slot().params.stepCount, 16);
  assert.equal(slot().params.g8, 1, 'a preset rewrites every step');
  const bad = await call('set_effect', { insert: 'Keys', effect: 'gate', steps: 'P Q P' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Step 2 "Q"/);
  assert.match(bad.message, /Build roll/, 'lists the presets');
  await call('add_effect', { insert: 'Keys', effect: 'reverb' });
  const wrong = await call('set_effect', { insert: 'Keys', effect: 'reverb', steps: 'P P' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /only works with Krypt Gate\/Time/);
  assert.deepEqual(checkIntegrity(doc.project), []);
});

test('delete_objects removes channels and patterns; failures roll back partial edits', async () => {
  const { doc, call } = makeDeps();
  await call('create_pattern', { name: 'Tmp' });
  const before = doc.project.channelOrder.length;
  const r = await call('delete_objects', { channels: ['Keys'], patterns: ['Tmp'] });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.project.channelOrder.length, before - 1);
  // The channel delete succeeds, then the unknown pattern fails → the whole call is rolled back.
  const v = doc.version;
  const bad = await call('delete_objects', { channels: ['Clap'], patterns: ['Nope'] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rolled back/);
  assert.ok(doc.project.channelOrder.some((id) => doc.project.channels[id].name === 'Clap'));
  assert.ok(doc.version > v, 'rollback is itself a document change');
});

// ── Hearing & transport ─────────────────────────────────────────────────

test('render_preview returns compact analysis, symbolic stats and issues', async () => {
  const { call, renders } = makeDeps();
  await call('write_pattern', { kpn: TRAP });
  const r = await call('render_preview', { key: 'F#m' });
  assert.equal(r.ok, true, r.message);
  assert.equal(renders.length, 1);
  assert.equal(renders[0].analyze, true);
  assert.equal(renders[0].scope.kind, 'pattern');
  assert.ok(renders[0].path.startsWith(path.join(TMP, 'renders')));
  const data = r.data as { analysis: { lufs: number }; symbolic: { key: { estimated: string }; outOfKeyRatio: number; chords: string[] }; issues: string[] };
  assert.equal(data.analysis.lufs, -9.8);
  assert.equal(data.symbolic.key.estimated, 'F#m');
  assert.equal(data.symbolic.outOfKeyRatio, 0);
  assert.equal(data.symbolic.chords.length, 2);
  assert.ok(data.issues.some((i) => /True peak/.test(i)));
  assert.match(r.text!, /loudness\s+I=-9\.8 LUFS/);
  const bars = await call('render_preview', { bars: '1-200' });
  assert.equal(bars.ok, false);
  assert.match(bars.message, /at most 64 bars/);
});

test('render_preview without an engine still returns symbolic stats, honestly failed', async () => {
  const { call } = makeDeps({ engineRunning: false });
  await call('write_pattern', { kpn: TRAP });
  const r = await call('render_preview', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /Render of .* failed/);
  assert.ok((r.data as { symbolic: unknown }).symbolic);
  const p = await call('play', {});
  assert.equal(p.ok, false);
  assert.match(p.message, /engine is failed/);
});

test('render_preview never reads an all-zero engine analysis as "0 LUFS"; it measures the WAV instead', async () => {
  const { deps, call } = makeDeps();
  deps.engine.render = async (job) => {
    // 0.5 s stereo 16-bit sine at -6 dBFS.
    const sr = 48000;
    const n = sr / 2;
    const pcm = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5 * 32767);
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(2, 22);
    h.writeUInt32LE(sr, 24);
    h.writeUInt32LE(sr * 4, 28);
    h.writeUInt16LE(4, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    fs.mkdirSync(path.dirname(job.path), { recursive: true });
    fs.writeFileSync(job.path, Buffer.concat([h, pcm]));
    const zero: Analysis = { ...ANALYSIS, peakDb: 0, truePeakDb: 0, lufsIntegrated: 0, lufsShortTermMax: 0, crestDb: 0, bands: { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 } };
    return { ok: true, data: { path: job.path, files: [job.path], durationSec: 0.5, peakDb: 0, lufsIntegrated: 0, analysis: zero } };
  };
  await call('write_pattern', { kpn: TRAP });
  const r = await call('render_preview', {});
  assert.equal(r.ok, true, r.message);
  const data = r.data as { analysis: unknown; measured: { peakDb: number; rmsDb: number; correlation: number }; issues: string[] };
  assert.equal(data.analysis, null);
  assert.equal(data.measured.peakDb, -6);
  assert.equal(data.measured.rmsDb, -9);
  assert.equal(data.measured.correlation, 1);
  assert.ok(!data.issues.some((i) => /Very loud|True peak/.test(i)), data.issues.join('; '));
  assert.match(r.text!, /measured from the WAV/);
});

test('play / stop drive the engine transport', async () => {
  const { call, engineRequests } = makeDeps();
  assert.equal((await call('play', { mode: 'pattern', from_bar: 2 })).ok, true);
  assert.equal((await call('stop')).ok, true);
  assert.deepEqual(engineRequests, [{ cmd: 'locate', tick: 3840 }, { cmd: 'transport', action: 'play' }, { cmd: 'transport', action: 'stop' }]);
});

// ── History & safety ────────────────────────────────────────────────────

test('undo_last undoes only the agent\'s own last call; user edits stay', async () => {
  const { doc, call } = makeDeps();
  await call('set_tempo', { bpm: 100 });
  doc.exec('transport.set', { swing: 0.5 }, { actor: { kind: 'user' } });
  await call('set_tempo', { bpm: 120 });
  const u = await call('undo_last');
  assert.equal(u.ok, true, u.message);
  assert.equal(doc.project.transport.bpm, 100);
  assert.equal(doc.project.transport.swing, 0.5);
});

test('begin_edit / commit_edit fold several calls into ONE history entry', async () => {
  const { doc, call } = makeDeps();
  assert.equal((await call('begin_edit', { label: 'Trap drums + 808' })).ok, true);
  await call('write_pattern', { kpn: TRAP });
  await call('set_tempo', { bpm: 143 });
  await call('sidechain', { source: 'Kick', target: '808' });
  const c = await call('commit_edit');
  assert.equal(c.ok, true, c.message);
  const hist = doc.getHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].label, 'Trap drums + 808');
  assert.equal((await call('commit_edit')).ok, false);
  const u = await call('undo_last');
  assert.equal(u.ok, true);
  assert.equal(doc.project.transport.bpm, 140);
  assert.ok(!Object.values(doc.project.patterns).some((p) => p.name === 'Trap A'));
});

test('revert_all_agent_edits restores the pre-agent project and keeps user edits', async () => {
  const { doc, call } = makeDeps();
  const startChannels = doc.project.channelOrder.length;
  await call('write_pattern', { kpn: TRAP });
  doc.exec('transport.set', { metronome: true }, { actor: { kind: 'user' } });
  await call('add_effect', { insert: 'Keys', effect: 'eq' });
  await call('set_tempo', { bpm: 150 });
  const r = await call('revert_all_agent_edits', { confirm: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.project.transport.bpm, 140);
  assert.equal(doc.project.channelOrder.length, startChannels);
  assert.equal(doc.project.transport.metronome, true, 'the user edit survives');
  assert.ok(doc.getHistory().filter((h) => h.actorKey === actorKey({ kind: 'agent', clientId: 'test-agent', name: '' })).every((h) => h.undone));
  const again = await call('revert_all_agent_edits', { confirm: true });
  assert.equal(again.ok, false);
});

test('get_project / list tools / describe_plugin / get_history are read-only', async () => {
  const { doc, call } = makeDeps();
  await call('write_pattern', { kpn: TRAP });
  const v = doc.version;
  for (const [name, args] of [
    ['get_project', {}],
    ['list_channels', {}],
    ['list_patterns', {}],
    ['list_plugins', { kind: 'effect' }],
    ['describe_plugin', { channel: 'Keys', filter: 'cutoff' }],
    ['describe_plugin', { insert: 'Master', effect: 1 }],
    ['get_mixer', {}],
    ['get_history', { who: 'me' }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.ok, true, `${name}: ${r.message}`);
    assert.ok(resultText(r, 'read').length > 10, name);
  }
  assert.equal(doc.version, v);
  const proj = await call('get_project');
  assert.match(proj.text!, /Tempo 140 bpm/);
  assert.match(proj.text!, /"Trap A"/);
  const d = await call('describe_plugin', { channel: 'Keys', filter: 'cutoff' });
  assert.match(d.text!, /cutoff .*ref channel\/ch_/);
});

test('invalid arguments and unknown tools fail cleanly', async () => {
  const { call } = makeDeps();
  const r = await call('set_tempo', { bpm: 5 });
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid arguments for set_tempo: bpm/);
  const u = await call('make_trap_beat', {});
  assert.equal(u.ok, false);
  const n = await call('set_channel', { channel: 'Nope', mute: true });
  assert.equal(n.ok, false);
  assert.match(n.message, /No channel "Nope"\. Channels: Kick, Clap/);
});

test('the KPN cheat sheet examples in tool descriptions parse', () => {
  const desc = TOOLS.find((t) => t.name === 'write_pattern')!.description;
  const ex = /Example: (\{.*\})$/m.exec(desc)![1];
  const kpn = JSON.parse(ex).kpn as string;
  assert.equal(parse(kpn).ok, true);
});

// ── Built-in agent loop against a mock Messages API ─────────────────────

test('agent loop: streams, runs tools through the registry, caches, and returns tool_results', async () => {
  const http = await import('node:http');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { createAgentCore } = await import('../electron/agent/loop');
  const { deps, doc, broadcasts } = makeDeps();
  const requests: Array<{ body: any; beta: string }> = [];
  const kpn = 'pattern "Agent Beat" bars=1\nkick: x... ..x. x... ....\nclap: .... x... .... x...';
  const sse = (res: import('node:http').ServerResponse, events: unknown[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
  const start = (id: string) => ({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0 } } });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw), beta: String(req.headers['anthropic-beta'] ?? '') });
      if (requests.length === 1) {
        sse(res, [
          start('msg_1'),
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Writing the drums.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_pattern', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ kpn }).slice(0, 20) } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ kpn }).slice(20) } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 120 } },
          { type: 'message_stop' },
        ]);
      } else {
        sse(res, [
          start('msg_2'),
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Done: a one-bar beat.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },
          { type: 'message_stop' },
        ]);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const core = createAgentCore(deps, () => new Anthropic({ apiKey: 'sk-ant-test', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }));
    const r = await core.send('Make me a one-bar beat');
    assert.equal(r.ok, true, r.message);
    assert.match(r.message ?? '', /Writing the drums\. Done: a one-bar beat\./);
    // The edit landed as the panel agent, through the shared registry.
    assert.ok(Object.values(doc.project.patterns).some((p) => p.name === 'Agent Beat'));
    assert.equal(doc.getHistory().at(-1)!.actorKey, 'agent:krypt-panel');
    // Request shape: caching breakpoints, deterministic tools, adaptive thinking, fallbacks.
    const b1 = requests[0].body;
    assert.equal(b1.model, 'claude-opus-5-5');
    assert.equal(b1.stream, true);
    assert.deepEqual(b1.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(b1.cache_control, { type: 'ephemeral' });
    assert.equal(b1.tools.length, TOOLS.length);
    assert.deepEqual(b1.tools.map((t: { name: string }) => t.name), TOOLS.map((t) => t.name));
    assert.deepEqual(b1.tools.at(-1).cache_control, { type: 'ephemeral' });
    assert.ok(b1.tools.every((t: { eager_input_streaming: boolean }) => t.eager_input_streaming === true));
    assert.deepEqual(b1.thinking, { type: 'adaptive' });
    assert.equal(b1.output_config.effort, 'medium');
    assert.equal(b1.fallbacks, 'default');
    assert.match(requests[0].beta, /server-side-fallback-2026-07-01/);
    assert.match(b1.messages[0].content[0].text, /^<project_overview doc_version=/);
    // Turn 2 carries the assistant tool_use and our tool_result, append-only.
    const m2 = requests[1].body.messages;
    assert.equal(m2.length, 3);
    assert.equal(m2[1].role, 'assistant');
    assert.equal(m2[1].content[1].type, 'tool_use');
    assert.equal(m2[2].content[0].type, 'tool_result');
    assert.equal(m2[2].content[0].tool_use_id, 'toolu_1');
    assert.equal(m2[2].content[0].is_error, undefined);
    assert.match(m2[2].content[0].content, /Created and wrote pattern "Agent Beat"/);
    // Events streamed to the renderer, with usage and an estimated cost.
    const ev = broadcasts.filter((x) => x.channel === MCP_CHANNELS.agentEvent).map((x) => x.payload as { type: string; usage?: { costUsd: number; inputTokens: number } });
    assert.deepEqual([...new Set(ev.map((e) => e.type))], ['text', 'tool_use', 'tool_result', 'done']);
    const done = ev.at(-1)!;
    assert.equal(done.usage!.inputTokens, 20000);
    assert.equal(done.usage!.costUsd, Math.round(((2000 * 4 + 150 * 20 + 18000 * 5) / 1e6) * 10000) / 10000);
    assert.equal(core.history().length, 4);
    // No key → a clear message, no request.
    const none = createAgentCore(deps, () => null);
    assert.match((await none.send('hi')).message ?? '', /Add your Anthropic API key/);
  } finally {
    server.close();
  }
});

test('agent loop (OpenAI-compatible: OpenAI, OpenRouter): streams, runs tools through the registry, answers each call', async () => {
  const { createCompatCore, compatErrorMessage } = await import('../electron/agent/openaiLoop');
  const { deps, doc, broadcasts } = makeDeps();
  const kpn = 'pattern "Compat Beat" bars=1\nkick: x... ..x. x... ....\nclap: .... x... .... x...';
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const sse = (chunks: unknown[]) =>
    new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const args = JSON.stringify({ kpn });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    if (requests.length === 1)
      return sse([
        { choices: [{ delta: { content: 'Writing the drums.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_pattern', arguments: args.slice(0, 15) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(15) } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.002 } },
      ]);
    return sse([{ choices: [{ delta: { content: ' Done.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, cost: 0.001 } }]);
  }) as unknown as typeof fetch;
  const core = createCompatCore(deps, () => ({ provider: 'openrouter', key: 'sk-or-test', model: 'openrouter/auto', headers: { 'X-Title': 'Krypt Studio' } }), fakeFetch);
  const r = await core.send('Make me a one-bar beat');
  assert.equal(r.ok, true, r.message);
  assert.match(r.message ?? '', /Writing the drums\. Done\./);
  assert.ok(Object.values(doc.project.patterns).some((p) => p.name === 'Compat Beat'), 'the tool ran through the registry');
  assert.equal(doc.getHistory().at(-1)!.actorKey, 'agent:krypt-panel', 'as the panel agent: undoable like any agent edit');
  // Request shape: the endpoint, the key as a bearer token, every tool as a function, streamed with usage.
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-or-test');
  assert.equal(requests[0].headers['X-Title'], 'Krypt Studio');
  const b1 = requests[0].body;
  assert.equal(b1.model, 'openrouter/auto');
  assert.equal(b1.stream, true);
  assert.deepEqual(b1.stream_options, { include_usage: true });
  assert.deepEqual(b1.usage, { include: true }, 'OpenRouter reports the cost');
  assert.deepEqual(b1.tools.map((t: { function: { name: string } }) => t.function.name), TOOLS.map((t) => t.name));
  assert.equal(b1.messages[0].role, 'system');
  assert.match(b1.messages[1].content, /<project_overview doc_version=/);
  // Turn 2: the assistant's tool call and its answer.
  const m2 = requests[1].body.messages;
  assert.equal(m2.at(-2).role, 'assistant');
  assert.equal(m2.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(m2.at(-1).role, 'tool');
  assert.equal(m2.at(-1).tool_call_id, 'call_1');
  assert.match(m2.at(-1).content, /Created and wrote pattern "Compat Beat"/);
  const ev = broadcasts.filter((x) => x.channel === MCP_CHANNELS.agentEvent).map((x) => x.payload as { type: string; usage?: { costUsd: number; inputTokens: number } });
  assert.deepEqual([...new Set(ev.map((e) => e.type))], ['text', 'tool_use', 'tool_result', 'done']);
  assert.equal(ev.at(-1)!.usage!.inputTokens, 1900);
  assert.equal(ev.at(-1)!.usage!.costUsd, 0.003);
  // Errors in plain words; no key → a clear message, no request.
  const http = (status: number) => (async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status })) as unknown as typeof fetch;
  const bad = createCompatCore(deps, () => ({ provider: 'openai', key: 'sk-test', model: 'gpt-5' }), http(401));
  assert.match((await bad.send('hi')).message ?? '', /OpenAI \(ChatGPT\) key was rejected/);
  assert.match(compatErrorMessage('openrouter', 'x', new TypeError('fetch failed')), /Couldn't reach OpenRouter/);
  const none = createCompatCore(deps, () => null, fakeFetch);
  assert.match((await none.send('hi')).message ?? '', /Add an API key/);
});

// ── MCP server over the named pipe (Windows) ────────────────────────────

test('MCP server: pipe auth, initialize, tools/list, write_pattern round trip, kill switch', async () => {
  if (process.platform !== 'win32') return;
  const { startMcp } = await import('../electron/mcp/index');
  const net = await import('node:net');
  const { deps, doc, broadcasts } = makeDeps();
  fs.mkdirSync(deps.userDataDir, { recursive: true });
  process.env.KRYPT_MCP_PIPE_SUFFIX = `test-${process.pid}`;
  const mcp = await Promise.resolve(startMcp(deps));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(deps.userDataDir, 'mcp.json'), 'utf8'));
    assert.match(cfg.pipe, /^\\\\\.\\pipe\\krypt-studio-mcp-/);
    assert.equal(cfg.token.length, 64);
    const manifestFile = path.join(deps.userDataDir, 'mcp-manifest.json');
    for (let i = 0; i < 100 && !fs.existsSync(manifestFile); i++) await new Promise((r) => setTimeout(r, 50));
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.legacy['tools/list'].tools.length, TOOLS.length);
    assert.equal(manifest.legacy.initialize.serverInfo.name, 'krypt-studio');
    assert.ok(manifest.modern['server/discover'], 'modern discover captured');

    const connect = (token: string) =>
      new Promise<{ send: (m: unknown) => void; next: () => Promise<any>; close: () => void }>((resolve, reject) => {
        const sock = net.connect(cfg.pipe);
        let buf = '';
        const lines: any[] = [];
        const waiters: Array<(v: any) => void> = [];
        sock.on('data', (d) => {
          buf += d.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            const w = waiters.shift();
            if (w) w(msg);
            else lines.push(msg);
          }
        });
        sock.on('error', reject);
        sock.on('connect', () => {
          sock.write(`${JSON.stringify({ krypt: 'hello', v: 1, token, client: 'test-client' })}\n`);
          resolve({
            send: (m) => sock.write(`${JSON.stringify(m)}\n`),
            next: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r))),
            close: () => sock.destroy(),
          });
        });
      });

    const bad = await connect('0'.repeat(64));
    const deny = await bad.next();
    assert.equal(deny.krypt, 'error');
    bad.close();

    const c = await connect(cfg.token);
    const welcome = await c.next();
    assert.equal(welcome.krypt, 'welcome');
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pipe-test', version: '1' } } });
    const init = await c.next();
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, 'krypt-studio');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await c.next();
    assert.equal(list.result.tools.length, TOOLS.length);
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), TOOLS.map((t) => t.name));
    const status = mcp.status();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].name, 'pipe-test');
    assert.ok(broadcasts.some((b) => b.channel === MCP_CHANNELS.status && (b.payload as McpStatus).clients.length === 1));

    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_pattern', arguments: { kpn: TRAP } } });
    const w = await c.next();
    assert.equal(w.id, 3);
    assert.equal(w.result.isError, false, JSON.stringify(w.result));
    assert.match(w.result.content[0].text, /Created and wrote pattern "Trap A"/);
    assert.ok(Object.values(doc.project.patterns).some((p) => p.name === 'Trap A'));
    const entry = doc.getHistory().at(-1)!;
    assert.equal(entry.actorKey, 'agent:pipe-test');

    c.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_pattern', arguments: { pattern: 'Trap A' } } });
    const rd = await c.next();
    assert.match(rd.result.content[0].text, /pattern "Trap A" bars=2/);

    c.send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'krypt://docs/kpn' } });
    const res = await c.next();
    assert.match(res.result.contents[0].text, /KPN — Krypt Pattern Notation/);

    c.send({ jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'beat', arguments: { genre: 'trap' } } });
    const pr = await c.next();
    assert.match(pr.result.messages[0].content.text, /trap/i);
    // Every argument is optional: a bare /krypt-studio:beat (or just an idea) must not block on parameters.
    c.send({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'beat', arguments: {} } });
    const bare = await c.next();
    assert.ok(bare.result, JSON.stringify(bare.error));
    assert.match(bare.result.messages[0].content.text, /Choose anything not given/);
    c.send({ jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'beat', arguments: { idea: 'dark bouncy trap like driving at night' } } });
    const idea = await c.next();
    assert.match(idea.result.messages[0].content.text, /Style card — trap/);
    assert.match(idea.result.messages[0].content.text, /driving at night/);

    // Kill switch: everyone is disconnected and calls are refused.
    const off = await mcp.setEnabled(false);
    assert.equal(off.ok, true);
    assert.equal(mcp.status().clients.length, 0);
    const c2 = await connect(cfg.token);
    await c2.next();
    c2.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'late', version: '1' } } });
    await c2.next();
    c2.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
    const refused = await c2.next();
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /turned off/);
    c2.close();
    c.close();
    assert.equal((await mcp.setEnabled(true)).ok, true);
  } finally {
    await mcp.stop();
    delete process.env.KRYPT_MCP_PIPE_SUFFIX;
  }
});

// ── The Rust stdio shim ⇄ pipe ⇄ server (skipped when the shim isn't built) ──

function findShim(): string | undefined {
  const root = path.resolve(process.cwd());
  return [
    process.env.KRYPT_SHIM,
    path.join(root, 'engine', 'target-shim', 'debug', 'krypt-studio-mcp.exe'),
    path.join(root, 'engine', 'target-shim', 'release', 'krypt-studio-mcp.exe'),
    path.join(root, 'engine', 'target', 'release', 'krypt-studio-mcp.exe'),
    path.join(root, 'engine', 'target', 'debug', 'krypt-studio-mcp.exe'),
    path.join(root, 'resources', 'bin', 'krypt-studio-mcp.exe'),
  ].find((p) => p && fs.existsSync(p));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shimClient(shim: string, args: string[]) {
  const { spawn } = await import('node:child_process');
  const p = spawn(shim, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const q: any[] = [];
  const w: Array<(v: any) => void> = [];
  p.stdout.on('data', (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      const m = JSON.parse(l);
      const f = w.shift();
      if (f) f(m);
      else q.push(m);
    }
  });
  return {
    send: (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`),
    next: (): Promise<any> => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => w.push(r))),
    queued: () => q.splice(0),
    end: () => p.stdin.end(),
  };
}

test('shim: relays a stdio session to the app, then answers discovery offline once the app quits', async () => {
  if (process.platform !== 'win32') return;
  const shim = findShim();
  if (!shim) {
    console.log('  (skipped: krypt-studio-mcp.exe not built)');
    return;
  }
  const { startMcp } = await import('../electron/mcp/index');
  const { deps, doc } = makeDeps();
  fs.mkdirSync(deps.userDataDir, { recursive: true });
  process.env.KRYPT_MCP_PIPE_SUFFIX = `shim-${process.pid}`;
  const mcp = await Promise.resolve(startMcp(deps));
  const cfg = path.join(deps.userDataDir, 'mcp.json');
  const manifestFile = path.join(deps.userDataDir, 'mcp-manifest.json');
  for (let i = 0; i < 100 && !fs.existsSync(manifestFile); i++) await new Promise((r) => setTimeout(r, 50));
  const client = () => shimClient(shim, ['--config', cfg, '--client', 'shim-test', '--no-launch']);
  try {
    const c = await client();
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 't' } } });
    assert.equal((await c.next()).result.serverInfo.name, 'krypt-studio');
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_pattern', arguments: { kpn: 'pattern "Via Shim" bars=1\nkick: x... x... x... x...' } } });
    const w = await c.next();
    assert.equal(w.result.isError, false, JSON.stringify(w.result));
    assert.ok(Object.values(doc.project.patterns).some((p) => p.name === 'Via Shim'));
    assert.equal(doc.getHistory().at(-1)!.actorKey, 'agent:claude-code');
    await mcp.stop();
    await new Promise((r) => setTimeout(r, 300));
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
    const after = await c.next();
    assert.equal(after.result.isError, true);
    assert.match(after.result.content[0].text, /Krypt Studio isn't running/);
    c.end();
    const off = await client();
    off.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline', version: 't' } } });
    const oi = await off.next();
    assert.equal(oi.result.protocolVersion, '2025-06-18');
    off.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal((await off.next()).result.tools.length, TOOLS.length);
    off.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
    const err = await off.next();
    assert.equal(err.result.isError, true);
    off.end();
  } finally {
    await mcp.stop();
    delete process.env.KRYPT_MCP_PIPE_SUFFIX;
  }
});

test('shim: a client re-opening its change subscription never starts the app; the subscription waits for the next connection', async () => {
  if (process.platform !== 'win32') return;
  const shim = findShim();
  if (!shim) {
    console.log('  (skipped: krypt-studio-mcp.exe not built)');
    return;
  }
  const { startMcp } = await import('../electron/mcp/index');
  const { deps } = makeDeps();
  fs.mkdirSync(deps.userDataDir, { recursive: true });
  process.env.KRYPT_MCP_PIPE_SUFFIX = `shim-listen-${process.pid}`;
  // A stand-in "app" that only leaves a marker, so any launch is visible.
  const marker = path.join(deps.userDataDir, 'launched.txt');
  const fakeApp = path.join(deps.userDataDir, 'fake-app.cjs');
  fs.writeFileSync(fakeApp, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`);
  const cfg = path.join(deps.userDataDir, 'mcp-launch.json');
  const writeCfg = () => {
    const real = JSON.parse(fs.readFileSync(path.join(deps.userDataDir, 'mcp.json'), 'utf8'));
    fs.writeFileSync(cfg, JSON.stringify({ ...real, appExePath: process.execPath, appArgs: [fakeApp] }));
  };
  let mcp = await Promise.resolve(startMcp(deps));
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: 't' } };
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(deps.userDataDir, 'mcp-manifest.json')); i++) await sleep(50);
    writeCfg();
    await mcp.stop(); // the user closed Krypt Studio
    const c = await shimClient(shim, ['--config', cfg, '--client', 'claude-code']);
    c.send({ jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: { _meta: meta, notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ['krypt://mixer'] } } });
    const ack = await c.next();
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged', JSON.stringify(ack));
    assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], 7);
    assert.deepEqual(ack.params.notifications, { toolsListChanged: true, promptsListChanged: true }, 'narrowed to what the app can deliver');
    c.send({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: meta } });
    assert.equal((await c.next()).result.tools.length, TOOLS.length, 'discovery still answers offline');
    await sleep(1500);
    assert.equal(fs.existsSync(marker), false, 'a background subscription must not reopen the app');
    // The user opens Krypt Studio again; the next real call connects and hands the subscription over.
    mcp = await Promise.resolve(startMcp(deps));
    for (let i = 0; i < 100 && !mcp.status().pipeName; i++) await sleep(20);
    writeCfg();
    c.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_project', arguments: {}, _meta: meta } });
    const res = await c.next();
    assert.equal(res.id, 9, JSON.stringify(res));
    assert.equal(res.result.isError, false, JSON.stringify(res.result));
    c.send({ jsonrpc: '2.0', id: 10, method: 'ping', params: { _meta: meta } });
    for (let m = await c.next(); m.id !== 10; m = await c.next()) assert.fail(`unexpected ${JSON.stringify(m)}`);
    assert.deepEqual(c.queued(), [], "the app's own acknowledgement is not repeated, and the subscription stays open");
    assert.equal(fs.existsSync(marker), false);
    c.end();
  } finally {
    await mcp.stop();
    delete process.env.KRYPT_MCP_PIPE_SUFFIX;
  }
});

await run('mcp-tools');
fs.rmSync(TMP, { recursive: true, force: true });
