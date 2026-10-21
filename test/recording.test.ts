// Live input + recording: take planning (shared/live/recording.ts) and the
// main-process controller (electron/input/liveInput.ts) against a fake engine.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { fromNormalized } from '@shared/plugins/types';
import type { Settings } from '@shared/types';
import type { EngineEvent, EngineRequest, RecordedTake } from '@shared/engine/protocol';
import {
  ccToNormalized,
  DEFAULT_AUDIO_INPUT,
  DEFAULT_MIDI_SETTINGS,
  DEFAULT_RECORDING,
  freeTrack,
  matchMappings,
  mergeLiveSettings,
  midiSettings,
  planPatternNotes,
  planSongNotesInClip,
  planSongNotesNew,
  recordingSettings,
  songClipFor,
  takeBarStart,
} from '@shared/live/recording';
import { LiveInputController } from '../electron/input/liveInput';
import { EVENT } from '../electron/channels';
import { isDeniedPermission } from '../electron/system/permissions';

function newDoc(): DocHost {
  return new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
}

// ── Pure planning ─────────────────────────────────────────────────────

test('settings: untrusted live-input settings are validated over the defaults', () => {
  const base = { midi: DEFAULT_MIDI_SETTINGS, recording: DEFAULT_RECORDING, audioInput: DEFAULT_AUDIO_INPUT };
  const m = mergeLiveSettings(base, {
    midi: { autoEnable: 'yes', inputs: { Keys: false, Bad: 3 }, mappings: [{ id: 'a', cc: 300, channel: -2, paramRef: 'transport/bpm', min: -1, max: 0.5 }, { cc: 1 }] },
    recording: { mode: 'video', quantize: 240.4, countInBars: 3 },
    audioInput: { deviceId: '', channels: [1, 'x', 99, 2, 3], monitor: true },
  });
  assert.equal(m.midi.autoEnable, true);
  assert.deepEqual(m.midi.inputs, { Keys: false });
  assert.equal(m.midi.mappings.length, 1, 'mappings without a paramRef are dropped');
  assert.deepEqual(m.midi.mappings[0], { id: 'a', device: null, channel: 0, cc: 127, paramRef: 'transport/bpm', min: 0, max: 0.5 });
  assert.deepEqual(m.recording, { mode: 'midi', quantize: 240, countInBars: 0 });
  assert.deepEqual(m.audioInput, { deviceId: null, channels: [1, 2], monitor: true });
  // A partial patch keeps everything else.
  const m2 = mergeLiveSettings(m, { recording: { countInBars: 2 } });
  assert.deepEqual(m2.recording, { mode: 'midi', quantize: 240, countInBars: 2 });
  assert.deepEqual(m2.midi, m.midi);
  // Settings objects without the optional fields read as defaults.
  assert.deepEqual(midiSettings({} as Settings), DEFAULT_MIDI_SETTINGS);
  assert.deepEqual(recordingSettings(null), DEFAULT_RECORDING);
});

test('controller links: CC → normalized range, device / channel matching', () => {
  assert.equal(ccToNormalized({}, 0), 0);
  assert.equal(ccToNormalized({}, 127), 1);
  assert.ok(Math.abs(ccToNormalized({}, 64) - 64 / 127) < 1e-12);
  assert.ok(Math.abs(ccToNormalized({ min: 0.2, max: 0.6 }, 127) - 0.6) < 1e-12);
  assert.equal(ccToNormalized({ min: 1, max: 0 }, 127), 0, 'inverted range');
  assert.equal(ccToNormalized({}, 500), 1);
  const maps = [
    { id: '1', device: 'Keys', channel: 0, cc: 74, paramRef: 'a' },
    { id: '2', device: null, channel: 0, cc: 74, paramRef: 'b' },
    { id: '3', device: 'Keys', channel: 1, cc: 74, paramRef: 'c' },
  ];
  assert.deepEqual(matchMappings(maps, 'Keys', 0, 74).map((m) => m.id), ['1', '2']);
  assert.deepEqual(matchMappings(maps, 'Pads', 0, 74).map((m) => m.id), ['2']);
  assert.deepEqual(matchMappings(maps, 'Keys', 0, 1), []);
});

test('pattern mode: ticks wrap at the pattern length, quantize, durations never extend the pattern', () => {
  const p = createDefaultProject('T');
  const pid = p.transport.activePatternId!;
  const ch = p.channelOrder[5];
  const n = (tick: number, dur: number, key = 60) => ({ channelId: ch, patternId: pid, tick, dur, key, vel: 0.8 });
  const groups = planPatternNotes(p, [n(182.4, 19.2), n(3830, 400, 62), n(1000.6, 3000.2, 64), { ...n(0, 10), channelId: 'nope' }, { ...n(0, 10), patternId: 'nope' }], 240);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].notes, [
    { tick: 240, key: 60, dur: 19, vel: 0.8 },
    { tick: 0, key: 62, dur: 400, vel: 0.8 }, // 3830 → 3840 → wraps to 0
    { tick: 960, key: 64, dur: 2880, vel: 0.8 }, // clamped to the 1-bar pattern end
  ]);
  const raw = planPatternNotes(p, [n(182.4, 19.2)], 0);
  assert.equal(raw[0].notes[0].tick, 182);
});

test('song mode: through the active pattern clip, or a new pattern at the start bar', () => {
  const doc = newDoc();
  const p0 = doc.project;
  const pid = p0.transport.activePatternId!;
  const ch = p0.channelOrder[5];
  const t1 = p0.playlist.trackOrder[0];
  assert.equal(songClipFor(p0, 5000), null, 'no clip of the active pattern yet');
  const r = doc.exec<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: t1, start: 3840, length: 7680, offset: 960, patternId: pid }, { actor: USER });
  assert.ok(r.ok);
  const clip = songClipFor(doc.project, 5000)!;
  assert.equal(clip.id, r.data!.id);
  // song 5000 → clip-relative 1160 + offset 960 = 2120; song 9000 → 6120 → wraps (1 bar) → 2280.
  const g = planSongNotesInClip(doc.project, clip, [
    { channelId: ch, patternId: null, tick: 5000, dur: 100, key: 60, vel: 1 },
    { channelId: ch, patternId: null, tick: 9000, dur: 100, key: 61, vel: 1 },
  ], 0);
  assert.deepEqual(g[0].notes.map((x) => x.tick), [2120, 2280]);
  // New pattern: relative to the bar where recording started (bar 3 = 7680).
  assert.equal(takeBarStart(doc.project, 8000), 7680);
  const nw = planSongNotesNew(doc.project, 7680, [{ channelId: ch, patternId: null, tick: 7600, dur: 50, key: 60, vel: 1 }, { channelId: ch, patternId: null, tick: 8950, dur: 50, key: 62, vel: 1 }], 240);
  assert.deepEqual(nw[0].notes.map((x) => x.tick), [0, 1200], 'early notes clamp to the bar, later ones quantize');
  // Free track: track 1 is busy over [3840, 11520).
  assert.equal(freeTrack(doc.project, 4000, 5000), doc.project.playlist.trackOrder[1]);
  assert.equal(freeTrack(doc.project, 0, 3840), t1);
});

test('Chromium MIDI permissions are denied, others untouched', () => {
  assert.equal(isDeniedPermission('midi'), true);
  assert.equal(isDeniedPermission('midiSysex'), true);
  assert.equal(isDeniedPermission('clipboard-sanitized-write'), false);
});

// ── Controller (main) against a fake engine ───────────────────────────

function harness() {
  const doc = newDoc();
  let settings = { midi: DEFAULT_MIDI_SETTINGS, recording: DEFAULT_RECORDING, audioInput: DEFAULT_AUDIO_INPUT } as unknown as Settings;
  const settingsListeners: Array<(s: Settings, prev: Settings) => void> = [];
  const requests: EngineRequest[] = [];
  let emit: (e: EngineEvent) => void = () => {};
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const logs: string[] = [];
  const engine = {
    request: async (req: EngineRequest) => {
      requests.push(req);
      if (req.cmd === 'setRecord') return { ok: true, data: { armed: req.armed, state: 'idle', input: { open: req.audio && req.armed, deviceId: null, name: 'Mic', sampleRate: 48000, channels: [0, 1], deviceChannels: 2, latencyMs: 3 } } };
      if (req.cmd === 'setMidiInputs' || req.cmd === 'listMidiInputs') return { ok: true, data: [{ id: 'Keys', name: 'Keys', enabled: true, open: true }] };
      return { ok: true, data: {} };
    },
    onEvent: (cb: (e: EngineEvent) => void) => {
      emit = cb;
      return () => {};
    },
    onStatus: () => () => {},
    status: () => ({ state: 'running' as const, device: null, engineVersion: '0', restarts: 0 }),
  };
  const ctl = new LiveInputController({
    doc,
    engine: engine as never,
    getSettings: () => settings,
    updateSettings: (patch) => {
      const prev = settings;
      settings = { ...settings, ...patch };
      for (const fn of settingsListeners) fn(settings, prev);
      return settings;
    },
    onSettingsChanged: (fn) => {
      settingsListeners.push(fn);
      return () => {};
    },
    recordDir: () => 'C:/proj/recordings',
    projectName: () => 'Song',
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    log: (_l, m) => logs.push(m),
  });
  ctl.start();
  const take = (t: Partial<RecordedTake> & { take: number }): void =>
    emit({ event: 'recorded', final: false, mode: 'pattern', patternId: doc.project.transport.activePatternId, startTick: 0, notes: [], audioPending: false, ...t });
  return { doc, ctl, requests, emit: (e: EngineEvent) => emit(e), take, broadcasts, logs, settings: () => settings, setSettings: (s: Partial<Settings>) => (settings = { ...settings, ...s }) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('controller: syncs the engine on start and arms with the record settings', async () => {
  const h = harness();
  await flush();
  await flush();
  const cmds = h.requests.map((r) => r.cmd);
  assert.deepEqual(cmds.slice(0, 4), ['setMidiInputs', 'setMidiTarget', 'setAudioInput', 'setRecord']);
  h.setSettings({ recording: { mode: 'both', quantize: 0, countInBars: 2 } });
  const r = await h.ctl.setArmed(true);
  assert.ok(r.ok && r.data?.armed);
  const rec = h.requests.filter((x) => x.cmd === 'setRecord').pop() as Extract<EngineRequest, { cmd: 'setRecord' }>;
  assert.deepEqual({ ...rec }, { cmd: 'setRecord', armed: true, midi: true, audio: true, countInBars: 2, dir: 'C:/proj/recordings', name: 'Song' });
  assert.ok(h.broadcasts.some((b) => b.channel === EVENT.recordStatus && (b.payload as { armed: boolean }).armed));
  h.ctl.setTarget('ch_x');
  h.ctl.setTarget('ch_x'); // no duplicate request
  assert.equal(h.requests.filter((x) => x.cmd === 'setMidiTarget' && x.channelId === 'ch_x').length, 1);
});

test('controller: a pattern-mode take with several loop passes is ONE undo group', async () => {
  const h = harness();
  await flush();
  const pid = h.doc.project.transport.activePatternId!;
  const ch = h.doc.project.channelOrder[5];
  h.setSettings({ recording: { mode: 'midi', quantize: 240, countInBars: 0 } });
  const before = h.doc.getHistory().length;
  const note = (tick: number, key: number) => ({ channelId: ch, patternId: pid, tick, dur: 200, key, vel: 0.9 });
  h.take({ take: 7, notes: [note(250, 60), note(1000, 62)] });
  h.take({ take: 7, notes: [note(2000, 64)] });
  h.take({ take: 7, final: true, notes: [note(2900, 65)] });
  const notes = Object.values(h.doc.project.patterns[pid].notes[ch] ?? {}).sort((a, b) => a.tick - b.tick);
  assert.deepEqual(notes.map((n) => [n.tick, n.key, n.dur]), [[240, 60, 200], [960, 62, 200], [1920, 64, 200], [2880, 65, 200]]);
  const hist = h.doc.getHistory();
  assert.equal(hist.length, before + 1, 'one history entry for the whole take');
  assert.equal(hist[hist.length - 1].label, 'Record');
  // Undo removes the whole take.
  assert.ok(h.doc.undo(USER).ok);
  assert.equal(Object.keys(h.doc.project.patterns[pid].notes[ch] ?? {}).length, 0);
  const st = h.ctl.status();
  assert.ok(st.lastTake?.ok && /4 notes/.test(st.lastTake.message), st.lastTake?.message);
});

test('controller: song-mode take without a clip creates a pattern + clip at the start bar', async () => {
  const h = harness();
  await flush();
  const ch = h.doc.project.channelOrder[5];
  const patternsBefore = h.doc.project.patternOrder.length;
  h.take({ take: 1, mode: 'song', patternId: null, startTick: 8000, final: true, notes: [{ channelId: ch, patternId: null, tick: 8100, dur: 480, key: 67, vel: 1 }] });
  const p = h.doc.project;
  assert.equal(p.patternOrder.length, patternsBefore + 1);
  const newPid = p.patternOrder[p.patternOrder.length - 1];
  assert.equal(p.transport.activePatternId, newPid, 'the new pattern becomes active');
  const n = Object.values(p.patterns[newPid].notes[ch])[0];
  assert.deepEqual([n.tick, n.key, n.dur], [420, 67, 480]);
  const clip = Object.values(p.playlist.clips).find((c) => c.patternId === newPid)!;
  assert.equal(clip.start, 7680);
  assert.equal(clip.trackId, p.playlist.trackOrder[0]);
  assert.equal(h.doc.getHistory().filter((e) => e.label === 'Record').length, 1);
});

test('controller: MIDI + audio take lands as one group; the audio clip goes on a free track at the start tick', async () => {
  const h = harness();
  await flush();
  const ch = h.doc.project.channelOrder[5];
  const t1 = h.doc.project.playlist.trackOrder[0];
  h.doc.exec('playlist.addClip', { kind: 'pattern', trackId: t1, start: 0, length: 20000, patternId: h.doc.project.transport.activePatternId! }, { actor: USER });
  const before = h.doc.getHistory().length;
  h.take({ take: 3, mode: 'song', patternId: null, startTick: 3840, final: false, audioPending: true, notes: [{ channelId: ch, patternId: null, tick: 3900, dur: 100, key: 60, vel: 1 }] });
  assert.equal(h.ctl.status().lastTake, undefined, 'not finished while the audio is pending');
  h.take({ take: 3, mode: 'song', patternId: null, startTick: 3840, final: true, audio: { path: 'C:/proj/recordings/Song take 3.wav', frames: 96000, sampleRate: 48000, channels: 2, startTick: 3840, peak: 0.5 } });
  const p = h.doc.project;
  const sample = Object.values(p.samples).find((s) => s.path.endsWith('Song take 3.wav'))!;
  assert.ok(sample && sample.frames === 96000);
  const audioClip = Object.values(p.playlist.clips).find((c) => c.kind === 'audio')!;
  assert.equal(audioClip.start, 3840);
  assert.equal(audioClip.trackId, p.playlist.trackOrder[1], 'track 1 is busy');
  assert.equal(audioClip.length, Math.round((2 * p.transport.bpm * 960) / 60));
  assert.equal(h.doc.getHistory().length, before + 1, 'notes + audio = one undo entry');
  const lt = h.ctl.status().lastTake!;
  assert.ok(lt.ok && /1 note/.test(lt.message) && /2\.0 s of audio/.test(lt.message), lt.message);
  // A silent take is kept but flagged.
  h.take({ take: 4, mode: 'song', patternId: null, startTick: 0, final: true, audio: { path: 'C:/x/silent.wav', frames: 4800, sampleRate: 48000, channels: 1, startTick: 0, peak: 0 } });
  assert.ok(!h.ctl.status().lastTake!.ok && /silent/.test(h.ctl.status().lastTake!.message));
  // An empty final report is reported, not silently dropped.
  h.take({ take: 5, final: true });
  assert.match(h.ctl.status().lastTake!.message, /nothing was recorded/i);
});

test('controller: MIDI-learn stores a mapping; CCs then set the param, one undo entry per twist', async () => {
  const h = harness();
  await flush();
  const ref = 'transport/swing';
  const learning = h.ctl.learn(ref, 'Swing');
  assert.ok(h.broadcasts.some((b) => b.channel === EVENT.midiLearnState && (b.payload as { paramRef: string | null }).paramRef === ref));
  h.emit({ event: 'midiCc', device: 'Keys', channel: 2, cc: 21, value: 10 });
  const r = await learning;
  assert.ok(r.ok, r.message);
  assert.deepEqual({ ...r.data, id: 'x' }, { id: 'x', device: 'Keys', channel: 2, cc: 21, paramRef: ref, label: 'Swing' });
  assert.equal(midiSettings(h.settings()).mappings.length, 1);
  const before = h.doc.getHistory().length;
  for (const v of [0, 20, 40, 64, 100, 127]) h.emit({ event: 'midiCc', device: 'Keys', channel: 2, cc: 21, value: v });
  const spec = paramSpecFor(h.doc.project, CATALOG, ref)!;
  assert.ok(Math.abs((getParamValue(h.doc.project, CATALOG, ref) ?? -1) - fromNormalized(spec, 1)) < 1e-9);
  assert.equal(h.doc.getHistory().length, before + 1, 'a twist coalesces into one entry');
  // Other channel / cc: ignored.
  h.emit({ event: 'midiCc', device: 'Keys', channel: 3, cc: 21, value: 0 });
  assert.ok(Math.abs((getParamValue(h.doc.project, CATALOG, ref) ?? -1) - fromNormalized(spec, 1)) < 1e-9);
  // Re-linking the same CC to another param replaces the old link.
  const again = h.ctl.learn('transport/masterVolume', 'Master');
  h.emit({ event: 'midiCc', device: 'Keys', channel: 2, cc: 21, value: 0 });
  assert.ok((await again).ok);
  const maps = midiSettings(h.settings()).mappings;
  assert.deepEqual(maps.map((m) => m.paramRef), ['transport/masterVolume']);
  assert.ok((await h.ctl.removeMapping(maps[0].id)).ok);
  assert.equal(midiSettings(h.settings()).mappings.length, 0);
  // Cancel + unknown params.
  const c = h.ctl.learn(ref);
  h.ctl.cancelLearn();
  assert.equal((await c).ok, false);
  assert.equal((await h.ctl.learn('channel/nope/volume')).ok, false);
});

void run('recording');
