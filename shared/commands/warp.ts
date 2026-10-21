import { z } from 'zod';
import { defineCommand, must, CommandError, plural } from './types';
import type { Channel, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';
import { MAX_WARP_MARKERS, WARP_MODES, isValidWarp, type WarpMap, type WarpMarker, type WarpMode } from '../schema/warp';
import { AUDIOCLIP, syncBpm } from '../analyzer/tempo';
import { PPQ, ticksPerBar } from '../schema/time';
import { keepAudioInPlace } from './audioTiming';

export const WARP_MARKER_PREFIX = 'wm';

const round = (v: number, d = 3): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const fmtSec = (s: number): string => `${round(s, 3)} s`;
const fmtBeat = (b: number): string => `beat ${round(b, 3)}`;

function audioChannel(d: Project, channelId: string): Channel {
  const ch = must(d.channels[channelId], `Channel ${channelId} not found (was it deleted?)`);
  if (ch.generator.type !== AUDIOCLIP) throw new CommandError(`"${ch.name}" is not an audio clip channel; warping works on audio clips`);
  return ch;
}

export function sampleDurationSec(d: Project, ch: Channel): number | null {
  const s = ch.generator.sampleId ? d.samples[ch.generator.sampleId] : undefined;
  return s && s.frames && s.sampleRate ? s.frames / s.sampleRate : null;
}

function ensureWarp(ch: Channel): WarpMap {
  return (ch.generator.warp ??= { mode: 'complex', markers: [] });
}

function checkInFile(d: Project, ch: Channel, sec: number): void {
  const dur = sampleDurationSec(d, ch);
  if (dur !== null && sec >= dur) throw new CommandError(`${fmtSec(sec)} is past the end of "${ch.name}" (${fmtSec(dur)} long)`);
}

function orderProblem(m: { sec: number; beat: number }, prev: WarpMarker | undefined, next: WarpMarker | undefined): string | null {
  if (prev && !(m.sec > prev.sec)) return `it would cross the previous marker (${fmtBeat(prev.beat)} at ${fmtSec(prev.sec)})`;
  if (next && !(m.sec < next.sec)) return `it would cross the next marker (${fmtBeat(next.beat)} at ${fmtSec(next.sec)})`;
  if (prev && !(m.beat > prev.beat)) return `its beat must be after the previous marker's (${fmtBeat(prev.beat)} at ${fmtSec(prev.sec)})`;
  if (next && !(m.beat < next.beat)) return `its beat must be before the next marker's (${fmtBeat(next.beat)} at ${fmtSec(next.sec)})`;
  return null;
}

function insertIndex(markers: WarpMarker[], sec: number): number {
  let i = 0;
  while (i < markers.length && markers[i].sec < sec) i++;
  return i;
}

function assertValid(ch: Channel): void {
  const w = ch.generator.warp;
  if (w && !isValidWarp(w.markers)) throw new CommandError(`The warp markers of "${ch.name}" would be out of order`);
}

const zChannel = z.string().min(1);
const zSec = z.number().finite().min(0);
const zBeat = z.number().finite().min(0).max(1_000_000);

export const audioSetWarpMode = defineCommand({
  id: 'audio.setWarpMode',
  label: (a) => `Warp mode ${a.mode}`,
  description:
    "Set an audio clip channel's warp mode: complex (full mixes), tones (vocals, bass, leads), beats (drums: transient slices at original speed), texture (granular pads / noise), repitch (varispeed, pitch follows speed). Creates the warp map when the channel has none (no markers yet: timing still comes from the Stretch params).",
  args: z.object({ channelId: zChannel, mode: z.enum(WARP_MODES) }),
  run(d, a) {
    const ch = audioChannel(d, a.channelId);
    ensureWarp(ch).mode = a.mode;
    return {};
  },
});

export const audioSetWarpOptions = defineCommand({
  id: 'audio.setWarpOptions',
  label: () => 'Warp options',
  description:
    'Set warp mode options on an audio clip channel: beatsSlice ("transients" | "1/16" | "1/8" | "1/4") and beatsFadeMs (0..200) for beats mode, grainMs (10..500) and flux (0..1) for texture mode. Pass null to reset one to its default. Values are clamped to their ranges.',
  args: z.object({
    channelId: zChannel,
    beatsSlice: z.enum(['transients', '1/16', '1/8', '1/4']).nullable().optional(),
    beatsFadeMs: z.number().finite().nullable().optional(),
    grainMs: z.number().finite().nullable().optional(),
    flux: z.number().finite().nullable().optional(),
  }),
  run(d, a) {
    const ch = audioChannel(d, a.channelId);
    const w = ensureWarp(ch);
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const set = <K extends 'beatsSlice' | 'beatsFadeMs' | 'grainMs' | 'flux'>(k: K, v: WarpMap[K] | null | undefined) => {
      if (v === undefined) return;
      if (v === null) delete w[k];
      else w[k] = v as WarpMap[K];
    };
    set('beatsSlice', a.beatsSlice);
    set('beatsFadeMs', a.beatsFadeMs == null ? a.beatsFadeMs : clamp(a.beatsFadeMs, 0, 200));
    set('grainMs', a.grainMs == null ? a.grainMs : clamp(a.grainMs, 10, 500));
    set('flux', a.flux == null ? a.flux : clamp(a.flux, 0, 1));
    return {};
  },
});

export const audioAddWarpMarker = defineCommand({
  id: 'audio.addWarpMarker',
  label: (a) => `Add warp marker (${fmtBeat(a.beat)})`,
  description:
    'Add a warp marker to an audio clip channel: the moment `sec` of the source file plays on `beat` (quarter notes from the sample start, at the project tempo). Markers stay strictly increasing in both sec and beat: a marker that would land on or cross a neighbour is refused. With 2+ markers the markers define the timing (they override the Stretch group\'s stretch / tempo sync / source BPM). Returns the marker id.',
  args: z.object({ channelId: zChannel, sec: zSec, beat: zBeat }),
  run(d, a, ctx) {
    const ch = audioChannel(d, a.channelId);
    checkInFile(d, ch, a.sec);
    const w = ensureWarp(ch);
    if (w.markers.length >= MAX_WARP_MARKERS) throw new CommandError(`"${ch.name}" already has ${MAX_WARP_MARKERS} warp markers (the limit)`);
    const i = insertIndex(w.markers, a.sec);
    const why = orderProblem(a, w.markers[i - 1], w.markers[i]);
    if (why) throw new CommandError(`Can't add a warp marker at ${fmtSec(a.sec)} on ${fmtBeat(a.beat)}: ${why}`);
    const id = ctx.newId(WARP_MARKER_PREFIX);
    w.markers.splice(i, 0, { id, sec: a.sec, beat: a.beat });
    assertValid(ch);
    return { id };
  },
});

export const audioMoveWarpMarker = defineCommand({
  id: 'audio.moveWarpMarker',
  label: () => 'Move warp marker',
  description:
    'Move a warp marker: a new `sec` re-pins which moment of the audio lands on the marker\'s beat (what dragging it in the waveform does); a new `beat` moves where that moment plays. A move that would land on or cross a neighbouring marker is refused (nothing changes) with the neighbour named.',
  args: z.object({ channelId: zChannel, markerId: z.string().min(1), sec: zSec.optional(), beat: zBeat.optional() }),
  run(d, a) {
    const ch = audioChannel(d, a.channelId);
    const w = ch.generator.warp;
    const i = w ? w.markers.findIndex((m) => m.id === a.markerId) : -1;
    if (!w || i < 0) throw new CommandError(`Warp marker ${a.markerId} not found on "${ch.name}"`);
    if (a.sec === undefined && a.beat === undefined) throw new CommandError('Nothing to move: pass sec and/or beat');
    const m = w.markers[i];
    const next = { sec: a.sec ?? m.sec, beat: a.beat ?? m.beat };
    if (a.sec !== undefined) checkInFile(d, ch, a.sec);
    const why = orderProblem(next, w.markers[i - 1], w.markers[i + 1]);
    if (why) throw new CommandError(`Can't move the warp marker on ${fmtBeat(m.beat)} to ${fmtSec(next.sec)} / ${fmtBeat(next.beat)}: ${why}`);
    m.sec = next.sec;
    m.beat = next.beat;
    assertValid(ch);
    return {};
  },
});

export const audioRemoveWarpMarker = defineCommand({
  id: 'audio.removeWarpMarker',
  label: () => 'Remove warp marker',
  description: 'Remove one warp marker from an audio clip channel (with fewer than 2 left, timing comes from the Stretch params again).',
  args: z.object({ channelId: zChannel, markerId: z.string().min(1) }),
  run(d, a) {
    const ch = audioChannel(d, a.channelId);
    const w = ch.generator.warp;
    const i = w ? w.markers.findIndex((m) => m.id === a.markerId) : -1;
    if (!w || i < 0) throw new CommandError(`Warp marker ${a.markerId} not found on "${ch.name}"`);
    w.markers.splice(i, 1);
    return {};
  },
});

export const audioClearWarp = defineCommand({
  id: 'audio.clearWarp',
  label: (a) => (a.all ? 'Warp off' : 'Clear warp markers'),
  description:
    "Remove every warp marker of an audio clip channel (mode and options stay). all: true removes the whole warp map, so the clip plays exactly as before warping existed (Stretch params only). Refused when there's nothing to clear.",
  args: z.object({ channelId: zChannel, all: z.boolean().default(false) }),
  run(d, a) {
    const ch = audioChannel(d, a.channelId);
    const w = ch.generator.warp;
    if (!w) throw new CommandError(`"${ch.name}" isn't warped`);
    if (a.all) {
      delete ch.generator.warp;
      return { removed: w.markers.length };
    }
    if (!w.markers.length) throw new CommandError(`"${ch.name}" has no warp markers to clear`);
    const removed = w.markers.length;
    w.markers = [];
    return { removed };
  },
});

export type WarpHint = 'drums' | 'mono' | 'mix';

export function modeForHint(hint: WarpHint | undefined): WarpMode {
  return hint === 'drums' ? 'beats' : hint === 'mono' ? 'tones' : 'complex';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface AutoWarpPlan {
  markers: Array<{ sec: number; beat: number }>;
  beatUnit: number;
  srcBpm: number;
  beatsPerBar: number;
}

export function planAutoWarp(input: {
  beatTimes: number[];
  downbeatIndex?: number;
  every?: 'bar' | 'beat';
  beatsPerBar?: number;
  beatUnit?: number;
  durationSec?: number | null;
  projectBpm: number;
  barQuarters: number;
}): AutoWarpPlan {
  let times = input.beatTimes.filter((t) => Number.isFinite(t) && t >= 0 && (input.durationSec == null || t < input.durationSec)).sort((a, b) => a - b);
  times = times.filter((t, i) => i === 0 || t - times[i - 1] >= 0.001);
  if (times.length < 2) throw new CommandError(`Auto-warp needs at least 2 beats inside the file (got ${times.length})`);
  const period = median(times.slice(1).map((t, i) => t - times[i]));
  const trackedBpm = 60 / period;
  let unit = input.beatUnit;
  if (unit === undefined) {
    const reading = input.projectBpm > 0 ? syncBpm({ bpm: trackedBpm }, input.projectBpm) : trackedBpm;
    const r = reading / trackedBpm;
    unit = r > 1.5 ? 2 : r < 0.75 ? 0.5 : 1;
  }
  const bpb = Math.max(1, Math.round(input.beatsPerBar ?? 4));
  const d = Math.min(Math.max(0, Math.round(input.downbeatIndex ?? 0)), times.length - 1);
  const preRoll = (d + times[0] / period) * unit;
  const bar = input.barQuarters > 0 ? input.barQuarters : 4;
  const base = Math.max(0, Math.ceil((preRoll - 0.25) / bar)) * bar;
  const beatOf = (j: number): number => (j - d) * unit + base;
  const idx: number[] = [];
  for (let j = 0; j < times.length; j++) {
    if (beatOf(j) < 0) continue;
    if (input.every === 'beat' || (((j - d) % bpb) + bpb) % bpb === 0) idx.push(j);
  }
  if (input.every !== 'beat' && idx[idx.length - 1] !== times.length - 1 && beatOf(times.length - 1) >= 0) idx.push(times.length - 1);
  if (idx.length < 2) throw new CommandError('Auto-warp found fewer than 2 bars to pin: use every "beat", or warp a longer clip');
  const capped = idx.length > MAX_WARP_MARKERS ? idx.filter((_, k) => k % Math.ceil(idx.length / MAX_WARP_MARKERS) === 0) : idx;
  const markers = capped.map((j) => ({ sec: times[j], beat: beatOf(j) }));
  const first = markers[0];
  const last = markers[markers.length - 1];
  const srcBpm = ((last.beat - first.beat) / (last.sec - first.sec)) * 60;
  return { markers, beatUnit: unit, srcBpm, beatsPerBar: bpb };
}

function catalogHas(catalog: PluginCatalog, id: string): boolean {
  return !!catalog.plugins.find((p) => p.id === AUDIOCLIP)?.params.some((s) => s.id === id);
}

export const audioAutoWarp = defineCommand({
  id: 'audio.autoWarp',
  label: (a) => `Auto-warp (${a.every === 'beat' ? 'every beat' : 'every bar'})`,
  description:
    "Warp an audio clip channel to a beat grid: beatTimes (seconds, from beat tracking), downbeatIndex (which of them starts a bar, default 0), every 'bar' (default: one marker per bar + the last beat) or 'beat'. Replaces the existing markers. Beat values: the downbeat lands on a project bar line, each tracked beat is beatUnit quarter notes (auto: 0.5 / 1 / 2, the reading nearest the project tempo, so a half-time detection keeps its speed). Mode: `mode`, else from hint (drums → beats, mono → tones, mix → complex). The Stretch params are made consistent with the markers (follow tempo on, source BPM = the markers' tempo, stretch 1×) so the playlist clips keep showing the same audio and nothing fights the markers; the clips are rescaled like a tempo-sync change. Returns the marker count, mode and source tempo.",
  args: z.object({
    channelId: zChannel,
    beatTimes: z.array(z.number().finite()).min(2).max(20000),
    downbeatIndex: z.number().int().min(0).optional(),
    every: z.enum(['bar', 'beat']).default('bar'),
    hint: z.enum(['drums', 'mono', 'mix']).optional(),
    mode: z.enum(WARP_MODES).optional(),
    beatsPerBar: z.number().int().min(1).max(16).optional(),
    beatUnit: z.number().min(0.25).max(4).optional(),
  }),
  run(d, a, ctx) {
    const ch = audioChannel(d, a.channelId);
    const plan = planAutoWarp({
      beatTimes: a.beatTimes,
      downbeatIndex: a.downbeatIndex,
      every: a.every,
      beatsPerBar: a.beatsPerBar,
      beatUnit: a.beatUnit,
      durationSec: sampleDurationSec(d, ch),
      projectBpm: d.transport.bpm,
      barQuarters: ticksPerBar(d.transport.timeSig) / PPQ,
    });
    const mode = a.mode ?? modeForHint(a.hint);
    const params: Record<string, number> = {};
    if (catalogHas(ctx.catalog, 'tempo_sync')) params.tempo_sync = 1;
    if (catalogHas(ctx.catalog, 'src_bpm')) params.src_bpm = Math.min(999, Math.max(1, round(plan.srcBpm, 3)));
    if (catalogHas(ctx.catalog, 'stretch')) params.stretch = 1;
    keepAudioInPlace(d, ctx.catalog, ch.id, () => {
      Object.assign(ch.generator.params, params);
      const w = ensureWarp(ch);
      w.mode = mode;
      w.markers = plan.markers.map((m) => ({ id: ctx.newId(WARP_MARKER_PREFIX), sec: m.sec, beat: m.beat }));
    });
    assertValid(ch);
    return {
      markers: plan.markers.length,
      mode,
      srcBpm: round(plan.srcBpm, 2),
      beatUnit: plan.beatUnit,
      summary: `${plural(plan.markers.length, 'warp marker')}, ${mode} mode, from ${round(plan.srcBpm, 2)} bpm`,
    };
  },
});

export const WARP_COMMANDS = [audioSetWarpMode, audioSetWarpOptions, audioAddWarpMarker, audioMoveWarpMarker, audioRemoveWarpMarker, audioClearWarp, audioAutoWarp];
