import path from 'node:path';
import { USER, type DocHost } from '@shared/doc/DocHost';
import type { ActionResult, MidiLearnState, MidiMapping, RecordState, Settings } from '@shared/types';
import type { DeviceInfo, EngineEvent, InputStatus, MidiInputInfo, RecordStatus, RecordedTake } from '@shared/engine/protocol';
import { newId } from '@shared/schema/ids';
import { patternLength } from '@shared/schema/project';
import { paramSpecFor } from '@shared/schema/params';
import {
  audioInputSettings,
  audioTakeStart,
  audioTakeTicks,
  ccToNormalized,
  countNotes,
  freeTrack,
  matchMappings,
  midiSettings,
  planPatternNotes,
  planSongNotesInClip,
  planSongNotesNew,
  plannedLength,
  recordingSettings,
  songClipFor,
  takeBarStart,
  type NoteGroup,
  recordingInsert,
} from '@shared/live/recording';
import { audioTakePasses, isLoopTake, midiTakePasses, passesSpan, type TakePassArg } from '@shared/live/takes';
import { EVENT } from '../channels';
import type { EngineSupervisor } from '../engine/supervisor';

export interface LiveInputDeps {
  doc: DocHost;
  engine: Pick<EngineSupervisor, 'request' | 'onEvent' | 'onStatus' | 'status'>;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  onSettingsChanged(fn: (s: Settings, prev: Settings) => void): () => void;
  recordDir(): string;
  projectName(): string;
  broadcast(channel: string, payload: unknown): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

const LEARN_TIMEOUT_MS = 30_000;
const TAKE_STALE_MS = 20_000;

interface TakeState {
  groupId: string;
  notes: number;
  messages: string[];
  warnings: string[];
  song?: { kind: 'clip'; clipId: string } | { kind: 'new'; patternId: string; barStart: number; clipId: string | null };
  timer: NodeJS.Timeout | null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class LiveInputController {
  private armed = false;
  private target: string | null = null;
  private input: InputStatus | null = null;
  private lastTake: RecordState['lastTake'];
  private learnPending: { paramRef: string; label: string; resolve: (r: ActionResult<MidiMapping>) => void; timer: NodeJS.Timeout } | null = null;
  private takes = new Map<number, TakeState>();
  private warnedMappings = new Set<string>();
  private lastEngineState = '';
  private offs: Array<() => void> = [];

  constructor(private readonly d: LiveInputDeps) {}

  start(): void {
    this.offs.push(
      this.d.engine.onStatus((s) => {
        const was = this.lastEngineState;
        this.lastEngineState = s.state;
        if (s.state === 'running' && was !== 'running') void this.sync();
        if (s.state !== 'running' && was === 'running') this.engineGone();
      }),
      this.d.engine.onEvent((e) => this.onEngineEvent(e)),
      this.d.onSettingsChanged((s, prev) => {
        if (JSON.stringify(midiSettings(s)) !== JSON.stringify(midiSettings(prev))) {
          const a = midiSettings(s);
          const b = midiSettings(prev);
          if (a.autoEnable !== b.autoEnable || JSON.stringify(a.inputs) !== JSON.stringify(b.inputs)) void this.pushMidiInputs();
        }
        const rec = (x: Settings): string => JSON.stringify([recordingSettings(x), audioInputSettings(x)]);
        if (rec(s) !== rec(prev)) void this.pushRecord();
      }),
    );
    if (this.d.engine.status().state === 'running') {
      this.lastEngineState = 'running';
      void this.sync();
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.finishLearn({ ok: false, message: 'Cancelled' });
  }

  private async sync(): Promise<void> {
    await this.pushMidiInputs();
    await this.d.engine.request({ cmd: 'setMidiTarget', channelId: this.target }, 3000);
    await this.pushRecord();
  }

  private engineGone(): void {
    for (const [id, t] of this.takes) this.finishTake(id, t, 'The audio engine stopped during recording.');
    this.input = null;
    this.broadcastStatus();
  }

  private async pushMidiInputs(): Promise<ActionResult<MidiInputInfo[]>> {
    const m = midiSettings(this.d.getSettings());
    const r = await this.d.engine.request<MidiInputInfo[]>({ cmd: 'setMidiInputs', autoEnable: m.autoEnable, enabled: m.inputs }, 10_000);
    if (r.ok && r.data) this.d.broadcast(EVENT.midiInputsChanged, r.data);
    return r;
  }

  private async pushRecord(): Promise<ActionResult<RecordStatus>> {
    const s = this.d.getSettings();
    const rec = recordingSettings(s);
    const inp = audioInputSettings(s);
    await this.d.engine.request({ cmd: 'setAudioInput', deviceId: inp.deviceId, channels: inp.channels, monitor: inp.monitor, meter: this.meter }, 15_000);
    const r = await this.d.engine.request<RecordStatus>(
      {
        cmd: 'setRecord',
        armed: this.armed,
        midi: rec.mode !== 'audio',
        audio: rec.mode !== 'midi',
        countInBars: rec.countInBars,
        dir: this.d.recordDir(),
        name: this.d.projectName(),
      },
      15_000,
    );
    if (r.ok && r.data) this.input = r.data.input;
    this.broadcastStatus();
    return r;
  }

  private meter = false;

  async setMeter(on: boolean): Promise<ActionResult<InputStatus | null>> {
    this.meter = on;
    const inp = audioInputSettings(this.d.getSettings());
    const r = await this.d.engine.request<InputStatus>({ cmd: 'setAudioInput', deviceId: inp.deviceId, channels: inp.channels, monitor: inp.monitor, meter: on }, 15_000);
    if (!r.ok) {
      this.meter = false;
      return { ok: false, message: `Couldn't open the microphone: ${r.message ?? 'the audio engine is not running'}` };
    }
    this.input = r.data ?? null;
    this.broadcastStatus();
    if (on && !this.input?.open) return { ok: false, message: this.input?.message ?? "The microphone didn't open: check the input device in the Recording Studio", data: this.input };
    return { ok: true, data: this.input, message: on ? `Listening to ${this.input?.name ?? 'the microphone'}` : undefined };
  }

  isRecordingTake(): boolean {
    return this.takes.size > 0;
  }

  status(): RecordState {
    return { armed: this.armed, input: this.input, ...(this.lastTake ? { lastTake: this.lastTake } : {}) };
  }

  private broadcastStatus(): void {
    this.d.broadcast(EVENT.recordStatus, this.status());
  }

  async setArmed(armed: boolean): Promise<ActionResult<RecordState>> {
    this.armed = !!armed;
    const r = await this.pushRecord();
    if (!r.ok) {
      this.broadcastStatus();
      return { ok: false, message: `Couldn't ${armed ? 'arm' : 'disarm'} recording: ${r.message ?? 'the audio engine is not running'}`, data: this.status() };
    }
    const rec = recordingSettings(this.d.getSettings());
    let message = armed ? `Record armed (${rec.mode === 'both' ? 'MIDI + audio' : rec.mode === 'audio' ? 'audio' : 'MIDI'}): press Play to record` : 'Recording disarmed';
    if (armed && rec.mode !== 'midi' && !this.input?.open) {
      message = `Record armed, but no audio input is open${this.input?.message ? `: ${this.input.message}` : ''}. MIDI still records.`;
    }
    return { ok: true, message, data: this.status() };
  }

  listInputDevices(): Promise<ActionResult<DeviceInfo[]>> {
    return this.d.engine.request<DeviceInfo[]>({ cmd: 'listInputDevices' }, 15_000);
  }

  async inputs(): Promise<ActionResult<MidiInputInfo[]>> {
    const r = await this.d.engine.request<MidiInputInfo[]>({ cmd: 'listMidiInputs' }, 10_000);
    if (r.ok && r.data) this.d.broadcast(EVENT.midiInputsChanged, r.data);
    return r;
  }

  async setInputEnabled(id: string, enabled: boolean): Promise<ActionResult<MidiInputInfo[]>> {
    if (!id) return { ok: false, message: 'No MIDI device given' };
    const m = midiSettings(this.d.getSettings());
    this.d.updateSettings({ midi: { ...m, inputs: { ...m.inputs, [id]: !!enabled } } });
    const r = await this.pushMidiInputs();
    if (!r.ok) return r;
    const dev = r.data?.find((x) => x.id === id);
    if (enabled && dev && !dev.open) return { ok: false, message: `${id}: ${dev.error ?? "couldn't open the device"}`, data: r.data };
    return { ...r, message: `${id} ${enabled ? 'enabled' : 'disabled'}` };
  }

  setTarget(channelId: string | null): void {
    const id = typeof channelId === 'string' && channelId ? channelId : null;
    if (id === this.target) return;
    this.target = id;
    void this.d.engine.request({ cmd: 'setMidiTarget', channelId: id }, 2000);
  }

  learn(paramRef: string, label?: string): Promise<ActionResult<MidiMapping>> {
    this.finishLearn({ ok: false, message: 'Cancelled: another parameter is waiting for a controller' });
    const spec = paramSpecFor(this.d.doc.project, this.d.doc.catalog, paramRef);
    if (!spec) return Promise.resolve({ ok: false, message: `Parameter "${paramRef}" doesn't exist` });
    const name = label || spec.name;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishLearn({ ok: false, message: `No controller moved within 30 s, so ${name} wasn't linked.` }), LEARN_TIMEOUT_MS);
      this.learnPending = { paramRef, label: name, resolve, timer };
      this.broadcastLearn();
    });
  }

  cancelLearn(): void {
    this.finishLearn({ ok: false, message: 'Link to controller cancelled' });
  }

  private finishLearn(r: ActionResult<MidiMapping>): void {
    const p = this.learnPending;
    if (!p) return;
    this.learnPending = null;
    clearTimeout(p.timer);
    p.resolve(r);
    this.broadcastLearn();
  }

  private broadcastLearn(): void {
    const s: MidiLearnState = this.learnPending ? { paramRef: this.learnPending.paramRef, label: this.learnPending.label } : { paramRef: null };
    this.d.broadcast(EVENT.midiLearnState, s);
  }

  async removeMapping(id: string): Promise<ActionResult> {
    const m = midiSettings(this.d.getSettings());
    const hit = m.mappings.find((x) => x.id === id);
    if (!hit) return { ok: false, message: 'That controller link no longer exists' };
    this.d.updateSettings({ midi: { ...m, mappings: m.mappings.filter((x) => x.id !== id) } });
    return { ok: true, message: `Unlinked ${hit.label ?? hit.paramRef}` };
  }

  private onCc(device: string, channel: number, cc: number, value: number): void {
    if (this.learnPending) {
      const p = this.learnPending;
      const m = midiSettings(this.d.getSettings());
      const mapping: MidiMapping = { id: newId('map'), device, channel, cc, paramRef: p.paramRef, label: p.label };
      const keep = m.mappings.filter((x) => !(x.cc === cc && x.channel === channel && (x.device === device || x.device === null)) && x.paramRef !== p.paramRef);
      this.d.updateSettings({ midi: { ...m, mappings: [...keep, mapping] } });
      this.finishLearn({ ok: true, data: mapping, message: `Linked ${p.label} to CC ${cc} (channel ${channel + 1}, ${device})` });
      return;
    }
    const maps = matchMappings(midiSettings(this.d.getSettings()).mappings, device, channel, cc);
    for (const m of maps) {
      let r;
      try {
        r = this.d.doc.exec('params.set', { ref: m.paramRef, value: ccToNormalized(m, value), normalized: true }, { actor: USER, coalesceKey: `midi:${m.paramRef}`, label: `${m.label ?? 'Parameter'} (controller)` });
      } catch (err) {
        r = { ok: false, message: errText(err) };
      }
      if (!r.ok && !this.warnedMappings.has(m.id)) {
        this.warnedMappings.add(m.id);
        this.d.log('warn', `Controller link CC ${m.cc} → ${m.label ?? m.paramRef} failed: ${r.message ?? 'unknown error'}. Remove it in Settings → Controller links.`);
      }
    }
  }

  private onEngineEvent(e: EngineEvent): void {
    try {
      switch (e.event) {
        case 'midiInputs':
          this.d.broadcast(EVENT.midiInputsChanged, e.inputs);
          break;
        case 'midiCc':
          this.onCc(String(e.device), Number(e.channel) | 0, Number(e.cc) | 0, Number(e.value) | 0);
          break;
        case 'recorded':
          this.onRecorded(e);
          break;
        case 'inputStatus':
          this.input = e.status;
          this.broadcastStatus();
          break;
        default:
          break;
      }
    } catch (err) {
      this.d.log('error', `Live input: ${errText(err)}`);
    }
  }

  private exec<T = unknown>(t: TakeState, cmd: string, args: unknown): T | null {
    const r = this.d.doc.exec<T>(cmd, args, { actor: USER, groupId: t.groupId });
    if (!r.ok) {
      t.warnings.push(r.message ?? `${cmd} failed`);
      return null;
    }
    return (r.data ?? null) as T | null;
  }

  private ensureTrack(t: TakeState, start: number, end: number): string | null {
    const free = freeTrack(this.d.doc.project, start, end);
    if (free) return free;
    return this.exec<{ id: string }>(t, 'playlist.addTrack', { name: 'Recording' })?.id ?? null;
  }

  private addGroups(t: TakeState, groups: NoteGroup[]): void {
    for (const g of groups) {
      if (!g.notes.length) continue;
      if (this.exec(t, 'notes.add', { patternId: g.patternId, channelId: g.channelId, notes: g.notes })) t.notes += g.notes.length;
    }
  }

  private sessionTakes = new Set<string>();

  isSessionTake(absPath: string): boolean {
    return this.sessionTakes.has(path.resolve(String(absPath ?? '')).toLowerCase());
  }

  private onRecorded(ev: RecordedTake): void {
    const hasNotes = Array.isArray(ev.notes) && ev.notes.length > 0;
    if (ev.audio?.path && ev.audio.frames > 0) {
      const p = path.resolve(ev.audio.path);
      const rel = path.relative(path.resolve(this.d.recordDir()).toLowerCase(), p.toLowerCase());
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) this.sessionTakes.add(p.toLowerCase());
    }
    let t = this.takes.get(ev.take);
    if (!t && !hasNotes && !ev.audio) {
      if (ev.final) {
        const what = ev.error ? ev.error : ev.audio === null ? 'The audio take failed.' : recordingSettings(this.d.getSettings()).mode === 'audio' ? 'No audio was captured.' : 'No notes were played, so nothing was recorded.';
        this.report(ev.take, false, what);
      }
      return;
    }
    if (!t) {
      t = { groupId: this.d.doc.beginGroup(USER, 'Record'), notes: 0, messages: [], warnings: [], timer: null };
      this.takes.set(ev.take, t);
    }
    const quantize = recordingSettings(this.d.getSettings()).quantize;
    if (hasNotes) {
      if (ev.mode === 'pattern') this.addGroups(t, planPatternNotes(this.d.doc.project, ev.notes, quantize));
      else if (!this.addLoopMidiTakes(t, ev, quantize)) this.addSongNotes(t, ev, quantize);
    }
    if (ev.audio && !this.addLoopAudioTakes(t, ev)) this.addAudio(t, ev);
    if (ev.error) t.warnings.push(ev.error);
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (ev.final) this.finishTake(ev.take, t);
    else {
      const take = ev.take;
      t.timer = setTimeout(() => {
        const cur = this.takes.get(take);
        if (cur) this.finishTake(take, cur, 'The rest of the take never arrived.');
      }, TAKE_STALE_MS);
    }
  }

  private addSongNotes(t: TakeState, ev: RecordedTake, quantize: number): void {
    const p = this.d.doc.project;
    if (t.song?.kind === 'clip') {
      const clip = p.playlist.clips[t.song.clipId];
      if (clip) {
        this.addGroups(t, planSongNotesInClip(p, clip, ev.notes, quantize));
        return;
      }
      t.song = undefined;
    }
    if (!t.song) {
      const clip = songClipFor(p, ev.startTick);
      if (clip) {
        t.song = { kind: 'clip', clipId: clip.id };
        this.addGroups(t, planSongNotesInClip(p, clip, ev.notes, quantize));
        t.messages.push(`into ${p.patterns[clip.patternId!]?.name ?? 'the pattern'}`);
        return;
      }
      const barStart = takeBarStart(p, ev.startTick);
      const planned = planSongNotesNew(p, barStart, ev.notes, quantize);
      if (!countNotes(planned)) return;
      const pat = this.exec<{ id: string }>(t, 'patterns.add', { select: true });
      if (!pat) return;
      t.song = { kind: 'new', patternId: pat.id, barStart, clipId: null };
    }
    if (t.song.kind !== 'new') return;
    const song = t.song;
    const planned = planSongNotesNew(this.d.doc.project, song.barStart, ev.notes, quantize);
    this.addGroups(
      t,
      planned.map((g) => ({ patternId: song.patternId, channelId: g.channelId, notes: g.notes })),
    );
    const p2 = this.d.doc.project;
    const pat = p2.patterns[song.patternId];
    if (!pat) return;
    const len = Math.max(patternLength(pat, p2.transport.timeSig), plannedLength(p2, planned));
    const clip = song.clipId ? p2.playlist.clips[song.clipId] : undefined;
    if (!clip) {
      const trackId = this.ensureTrack(t, song.barStart, song.barStart + len);
      if (!trackId) return;
      const c = this.exec<{ id: string }>(t, 'playlist.addClip', { kind: 'pattern', trackId, start: song.barStart, patternId: song.patternId });
      song.clipId = c?.id ?? null;
      if (c) t.messages.push(`into new ${pat.name} on ${p2.playlist.tracks[trackId]?.name ?? 'the playlist'}`);
    } else if (clip.length < len) {
      this.exec(t, 'playlist.updateClips', { updates: [{ id: clip.id, length: len }] });
    }
  }

  private addTakeGroup(t: TakeState, passes: TakePassArg[], audio: RecordedTake['audio'] | undefined): boolean {
    const span = passesSpan(passes);
    const trackId = freeTrack(this.d.doc.project, span.start, span.end) ?? undefined;
    const args = {
      name: 'Recording',
      trackId,
      passes: passes.map((p) => ({ start: p.start, end: p.end, sec: p.sec, ...(p.notes ? { notes: p.notes } : {}) })),
      ...(audio ? { audio: { path: audio.path, name: path.basename(audio.path).replace(/\.wav$/i, ''), frames: audio.frames, sampleRate: audio.sampleRate, channels: audio.channels }, insertId: recordingInsert(this.d.doc.project) } : {}),
    };
    const r = this.exec<{ groupId: string; trackId: string; takeIds: string[] }>(t, 'takes.createGroup', args);
    if (!r) return false;
    const track = this.d.doc.project.playlist.tracks[r.trackId]?.name ?? 'the playlist';
    const n = r.takeIds.length;
    if (audio) {
      t.messages.push(`${n} audio takes on ${track} (comp them in its take lanes)`);
      if (audio.peak < 1e-4) t.warnings.push('The audio take is silent: check the input device and channels in Settings → Audio input.');
    } else {
      t.notes += passes.reduce((k, p) => k + (p.notes?.length ?? 0), 0);
      t.messages.push(`into ${n} MIDI takes on ${track}`);
    }
    return true;
  }

  private addLoopMidiTakes(t: TakeState, ev: RecordedTake, quantize: number): boolean {
    if (!isLoopTake(ev)) return false;
    const p = this.d.doc.project;
    const passes = midiTakePasses(ev, quantize, (id) => !!p.channels[id]);
    return passes.length >= 2 && this.addTakeGroup(t, passes, undefined);
  }

  private addLoopAudioTakes(t: TakeState, ev: RecordedTake): boolean {
    const a = ev.audio;
    if (!a || !(a.frames > 0) || !isLoopTake(ev)) return false;
    const passes = audioTakePasses(ev.passes!);
    if (passes.length >= 2) return this.addTakeGroup(t, passes, a);
    const clipId = this.addAudio(t, ev);
    const first = passes[0] ?? { start: Math.round(ev.passes![0].startTick), end: Math.round(ev.passes![0].endTick) };
    const clip = clipId ? this.d.doc.project.playlist.clips[clipId] : undefined;
    if (clip && first.end > clip.start && clip.start + clip.length > first.end) this.exec(t, 'playlist.updateClips', { updates: [{ id: clip.id, length: first.end - clip.start }] });
    return true;
  }

  private addAudio(t: TakeState, ev: RecordedTake): string | null {
    const a = ev.audio;
    if (!a) return null;
    if (!(a.frames > 0)) {
      t.warnings.push('The audio take is empty (the input delivered no audio).');
      return null;
    }
    const p = this.d.doc.project;
    const start = audioTakeStart(ev, a.startTick);
    const len = audioTakeTicks(p, a.frames, a.sampleRate);
    const trackId = this.ensureTrack(t, start, start + len);
    if (!trackId) return null;
    const name = path.basename(a.path).replace(/\.wav$/i, '');
    this.exec(t, 'samples.add', { path: a.path, name, frames: a.frames, sampleRate: a.sampleRate, channels: a.channels });
    const r = this.exec<{ clipId: string }>(t, 'playlist.addAudio', { path: a.path, name, trackId, start, frames: a.frames, sampleRate: a.sampleRate, channels: a.channels, insertId: recordingInsert(p) });
    if (r) {
      const secs = (a.frames / a.sampleRate).toFixed(1);
      t.messages.push(`${secs} s of audio on ${this.d.doc.project.playlist.tracks[trackId]?.name ?? 'the playlist'}`);
      if (a.peak < 1e-4) t.warnings.push('The audio take is silent: check the input device and channels in Settings → Audio input.');
    }
    return r?.clipId ?? null;
  }

  private finishTake(id: number, t: TakeState, extraWarning?: string): void {
    if (t.timer) clearTimeout(t.timer);
    this.takes.delete(id);
    this.d.doc.endGroup(t.groupId);
    if (extraWarning) t.warnings.push(extraWarning);
    const parts: string[] = [];
    if (t.notes) parts.push(`${t.notes} note${t.notes === 1 ? '' : 's'}`);
    const notesWhere = t.messages.filter((m) => m.startsWith('into'));
    const audio = t.messages.filter((m) => !m.startsWith('into'));
    let msg = parts.length ? `Recorded ${parts.join('')}${notesWhere.length ? ` ${notesWhere[0]}` : ''}` : '';
    if (audio.length) msg = msg ? `${msg}, and ${audio.join(', ')}` : `Recorded ${audio.join(', ')}`;
    if (!msg) msg = 'Nothing was recorded';
    const ok = t.warnings.length === 0 && (t.notes > 0 || audio.length > 0);
    if (t.warnings.length) msg = `${msg}. ${t.warnings.join(' ')}`;
    this.report(id, ok, msg);
  }

  private report(id: number, ok: boolean, message: string): void {
    this.lastTake = { id: Date.now() * 1000 + (id % 1000), ok, message };
    this.d.log(ok ? 'info' : 'warn', `Recording: ${message}`);
    this.broadcastStatus();
  }
}
