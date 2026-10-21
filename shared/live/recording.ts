import type { AudioInputSettings, MidiMapping, MidiSettings, RecordingSettings, Settings } from '../types';
import type { RecordedNote, RecordedTake } from '../engine/protocol';
import type { Clip, Project } from '../schema/project';
import { patternLength } from '../schema/project';
import { secondsToTicks, ticksPerBar } from '../schema/time';

export const DEFAULT_MIDI_SETTINGS: MidiSettings = { autoEnable: true, inputs: {}, mappings: [] };
export const DEFAULT_RECORDING: RecordingSettings = { mode: 'midi', quantize: 0, countInBars: 0 };
export const DEFAULT_AUDIO_INPUT: AudioInputSettings = { deviceId: null, channels: [0, 1], monitor: false };

export const QUANTIZE_GRIDS: Array<{ ticks: number; label: string }> = [
  { ticks: 0, label: 'Off' },
  { ticks: 960, label: '1/4' },
  { ticks: 480, label: '1/8' },
  { ticks: 240, label: '1/16' },
  { ticks: 120, label: '1/32' },
];

export function midiSettings(s: Settings | null | undefined): MidiSettings {
  const m = s?.midi;
  return { ...DEFAULT_MIDI_SETTINGS, ...(m ?? {}), inputs: { ...(m?.inputs ?? {}) }, mappings: [...(m?.mappings ?? [])] };
}

export function recordingSettings(s: Settings | null | undefined): RecordingSettings {
  return { ...DEFAULT_RECORDING, ...(s?.recording ?? {}) };
}

export function audioInputSettings(s: Settings | null | undefined): AudioInputSettings {
  const a = s?.audioInput;
  return { ...DEFAULT_AUDIO_INPUT, ...(a ?? {}), channels: [...(a?.channels ?? DEFAULT_AUDIO_INPUT.channels)] };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
const unit = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined);

export function mergeLiveSettings(
  base: { midi: MidiSettings; recording: RecordingSettings; audioInput: AudioInputSettings },
  input: unknown,
): { midi: MidiSettings; recording: RecordingSettings; audioInput: AudioInputSettings } {
  const o = obj(input);
  const m = obj(o.midi);
  const r = obj(o.recording);
  const a = obj(o.audioInput);
  const inputs: Record<string, boolean> = {};
  if ('inputs' in m) {
    for (const [k, v] of Object.entries(obj(m.inputs))) if (typeof v === 'boolean' && k) inputs[k] = v;
  }
  const mappings: MidiMapping[] = Array.isArray(m.mappings)
    ? m.mappings
        .map(obj)
        .filter((x) => typeof x.paramRef === 'string' && x.paramRef && typeof x.cc === 'number')
        .slice(0, 512)
        .map((x, i) => ({
          id: typeof x.id === 'string' && x.id ? x.id : `map${i}`,
          device: typeof x.device === 'string' && x.device ? x.device : null,
          channel: int(x.channel, 0, 0, 15),
          cc: int(x.cc, 0, 0, 127),
          paramRef: String(x.paramRef),
          ...(typeof x.label === 'string' ? { label: x.label } : {}),
          ...(unit(x.min) !== undefined ? { min: unit(x.min) } : {}),
          ...(unit(x.max) !== undefined ? { max: unit(x.max) } : {}),
        }))
    : base.midi.mappings;
  const mode = r.mode === 'midi' || r.mode === 'audio' || r.mode === 'both' ? r.mode : base.recording.mode;
  const countIn = r.countInBars === 0 || r.countInBars === 1 || r.countInBars === 2 ? r.countInBars : base.recording.countInBars;
  const channels = Array.isArray(a.channels)
    ? a.channels.filter((c): c is number => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < 64).slice(0, 2)
    : base.audioInput.channels;
  return {
    midi: {
      autoEnable: typeof m.autoEnable === 'boolean' ? m.autoEnable : base.midi.autoEnable,
      inputs: 'inputs' in m ? inputs : base.midi.inputs,
      mappings,
    },
    recording: { mode, quantize: int(r.quantize, base.recording.quantize, 0, 3840), countInBars: countIn },
    audioInput: {
      deviceId: 'deviceId' in a ? (typeof a.deviceId === 'string' && a.deviceId ? a.deviceId : null) : base.audioInput.deviceId,
      channels: channels.length ? channels : base.audioInput.channels,
      monitor: typeof a.monitor === 'boolean' ? a.monitor : base.audioInput.monitor,
    },
  };
}

export function matchMappings(mappings: MidiMapping[], device: string, channel: number, cc: number): MidiMapping[] {
  return mappings.filter((m) => m.cc === cc && m.channel === channel && (m.device === null || m.device === device));
}

export function ccToNormalized(m: Pick<MidiMapping, 'min' | 'max'>, value: number): number {
  const lo = m.min ?? 0;
  const hi = m.max ?? 1;
  const v = Math.max(0, Math.min(127, value)) / 127;
  return Math.max(0, Math.min(1, lo + (hi - lo) * v));
}

export interface PlannedNote {
  tick: number;
  key: number;
  dur: number;
  vel: number;
}

export interface NoteGroup {
  patternId: string;
  channelId: string;
  notes: PlannedNote[];
}

function q(tick: number, grid: number): number {
  return grid > 0 ? Math.round(tick / grid) * grid : Math.round(tick);
}

function note(n: RecordedNote, tick: number, maxEnd: number | null): PlannedNote {
  let dur = Math.max(1, Math.round(n.dur));
  if (maxEnd !== null) dur = Math.max(1, Math.min(dur, maxEnd - tick));
  return { tick, key: Math.max(0, Math.min(127, Math.round(n.key))), dur, vel: Math.max(0, Math.min(1, n.vel)) };
}

function push(groups: Map<string, NoteGroup>, patternId: string, channelId: string, n: PlannedNote): void {
  const k = `${patternId}\u0000${channelId}`;
  let g = groups.get(k);
  if (!g) groups.set(k, (g = { patternId, channelId, notes: [] }));
  g.notes.push(n);
}

function wrapTick(rel: number, len: number, grid: number): number {
  let t = q(Math.max(0, rel), grid);
  if (len > 0) t = ((t % len) + len) % len;
  return t;
}

export function planPatternNotes(p: Project, notes: RecordedNote[], quantize: number): NoteGroup[] {
  const groups = new Map<string, NoteGroup>();
  for (const n of notes) {
    const pat = n.patternId ? p.patterns[n.patternId] : undefined;
    if (!pat || !p.channels[n.channelId]) continue;
    const len = patternLength(pat, p.transport.timeSig);
    const tick = wrapTick(n.tick, len, quantize);
    push(groups, pat.id, n.channelId, note(n, tick, len));
  }
  return [...groups.values()];
}

export function songClipFor(p: Project, startTick: number): Clip | null {
  const pid = p.transport.activePatternId;
  if (!pid || !p.patterns[pid]) return null;
  const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId === pid && c.start <= startTick && startTick < c.start + c.length);
  clips.sort((a, b) => b.start - a.start);
  return clips[0] ?? null;
}

export function planSongNotesInClip(p: Project, clip: Clip, notes: RecordedNote[], quantize: number): NoteGroup[] {
  const pat = clip.patternId ? p.patterns[clip.patternId] : undefined;
  if (!pat) return [];
  const len = patternLength(pat, p.transport.timeSig);
  const groups = new Map<string, NoteGroup>();
  for (const n of notes) {
    if (!p.channels[n.channelId]) continue;
    const tick = wrapTick(n.tick - clip.start + clip.offset, len, quantize);
    push(groups, pat.id, n.channelId, note(n, tick, len));
  }
  return [...groups.values()];
}

export function takeBarStart(p: Project, startTick: number): number {
  const bar = ticksPerBar(p.transport.timeSig);
  return Math.max(0, Math.floor(Math.max(0, startTick) / bar) * bar);
}

export function planSongNotesNew(p: Project, barStart: number, notes: RecordedNote[], quantize: number): Array<{ channelId: string; notes: PlannedNote[] }> {
  const by = new Map<string, PlannedNote[]>();
  for (const n of notes) {
    if (!p.channels[n.channelId]) continue;
    const tick = q(Math.max(0, n.tick - barStart), quantize);
    const list = by.get(n.channelId) ?? [];
    list.push(note(n, tick, null));
    by.set(n.channelId, list);
  }
  return [...by.entries()].map(([channelId, list]) => ({ channelId, notes: list }));
}

export function plannedLength(p: Project, groups: Array<{ notes: PlannedNote[] }>): number {
  const bar = ticksPerBar(p.transport.timeSig);
  let end = 0;
  for (const g of groups) for (const n of g.notes) end = Math.max(end, n.tick + n.dur);
  return Math.max(bar, Math.ceil(end / bar) * bar);
}

export function freeTrack(p: Project, start: number, end: number): string | null {
  const target = p.recording?.trackId;
  if (target && p.playlist.tracks[target] && trackIsFree(p, target, start, end)) return target;
  for (const id of p.playlist.trackOrder) if (trackIsFree(p, id, start, end)) return id;
  return null;
}

export function trackIsFree(p: Project, id: string, start: number, end: number): boolean {
  return !Object.values(p.playlist.clips).some((c) => c.trackId === id && c.start < end && c.start + c.length > start);
}

export function recordingInsert(p: Project): string | undefined {
  const id = p.recording?.insertId;
  return id && p.mixer.inserts[id] && !p.mixer.inserts[id].isMaster ? id : undefined;
}

export function audioTakeTicks(p: Project, frames: number, sampleRate: number): number {
  if (!(frames > 0) || !(sampleRate > 0)) return 1;
  return Math.max(1, Math.round(secondsToTicks(frames / sampleRate, p.transport.bpm)));
}

export function audioTakeStart(take: Pick<RecordedTake, 'mode'>, startTick: number): number {
  return take.mode === 'song' ? Math.max(0, Math.round(startTick)) : 0;
}

export function countNotes(groups: Array<{ notes: PlannedNote[] }>): number {
  return groups.reduce((n, g) => n + g.notes.length, 0);
}
