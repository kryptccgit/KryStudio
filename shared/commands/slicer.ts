// ──────────────────────────────────────────────────────────────────────
// Loop slicer commands (research/13-roadmap.md §8.5; the contract is
// shared/schema/slicer.ts). Slice markers live on a 'krypt.slicer'
// channel's generator next to its sample. Pure: no I/O. main finds the
// hits (analyzer onsets) or the grid and passes slice times to
// slicer.slice (electron/racks/slice.ts, shared with slice_to_pads).
//
// Invariant kept by every command: `isValidSlices` (sec strictly
// increasing, unique ids), at most MAX_SLICER_SLICES, `sec` inside the file
// when its length is known (SampleRef frames / rate).
//
// Ordering rule (as for warp markers): an add or a move that would cross or
// land on a neighbouring slice is REFUSED with a message naming it, never
// clamped; the waveform UI clamps its drag between the neighbours before it
// dispatches, so a drag never fails.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { defineCommand, must, plural, CommandError, type CommandContext, type CommandDef } from './types';
import { defaultNote, type Channel, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { PPQ, TICKS_PER_STEP } from '../schema/time';
import { MAX_SLICER_SLICES, MIN_SLICE_GAP_SEC, SLICER_BASE_KEY, SLICER_PLUGIN, SLICE_ID_PREFIX, type Slice } from '../schema/slicer';
import { addChannelWithInsert, cleanSlices, midiNoteName, samplePoolId } from './racks';

const AUDIOCLIP = 'krypt.audioclip';

const fmtSec = (s: number): string => `${Math.round(s * 1000) / 1000} s`;

/** The slicer channel (anything else is refused with a human message). */
function slicerChannel(d: Project, channelId: string): Channel {
  const ch = must(d.channels[channelId], `Channel ${channelId} not found (was it deleted?)`);
  if (ch.generator.type !== SLICER_PLUGIN) throw new CommandError(`"${ch.name}" is not a Slicer channel; switch its instrument to Krypt Slicer first (or use slicer.slice)`);
  return ch;
}

/** The channel's sample length in seconds when the sample pool knows it. */
function lengthOf(d: Project, ch: Channel): number | null {
  const s = ch.generator.sampleId ? d.samples[ch.generator.sampleId] : undefined;
  return s?.frames && s.sampleRate ? s.frames / s.sampleRate : null;
}

/** First key of a slicer channel (its baseKey param, else the default). */
export function slicerBaseKey(ch: Channel): number {
  const k = ch.generator.params.baseKey;
  return typeof k === 'number' && Number.isFinite(k) ? Math.round(k) : SLICER_BASE_KEY;
}

function checkKeys(ch: Channel, count: number): void {
  const base = slicerBaseKey(ch);
  if (base + count - 1 > 127) throw new CommandError(`${plural(count, 'slice')} from ${midiNoteName(base)} would run past the top MIDI note: lower First key or use fewer slices`);
}

function sliceIndex(ch: Channel, sliceId: string): number {
  const i = (ch.generator.slices ?? []).findIndex((s) => s.id === sliceId);
  if (i < 0) throw new CommandError(`Slice ${sliceId} isn't on "${ch.name}" (it may have been removed)`);
  return i;
}

/** Why a slice can't start at `sec` between `prev` and `next` (null = it fits). */
function orderProblem(sec: number, prev: Slice | undefined, next: Slice | undefined, prevN: number): string | null {
  if (prev && !(sec - prev.sec >= MIN_SLICE_GAP_SEC)) return `it would cross or touch slice ${prevN} (at ${fmtSec(prev.sec)})`;
  if (next && !(next.sec - sec >= MIN_SLICE_GAP_SEC)) return `it would cross or touch slice ${prevN + 2} (at ${fmtSec(next.sec)})`;
  return null;
}

function checkInFile(d: Project, ch: Channel, sec: number): void {
  const dur = lengthOf(d, ch);
  if (dur !== null && sec >= dur) throw new CommandError(`${fmtSec(sec)} is past the end of the sample (${fmtSec(dur)} long)`);
}

/**
 * A pattern that replays the loop at `bpm`: slice N at its own time on its key, each note lasting until the next
 * slice. The pattern length is the loop rounded to a 16th.
 */
function addReplayPattern(d: Project, ch: Channel, starts: readonly number[], lengthSec: number, bpm: number, name: string, ctx: CommandContext): string {
  const base = slicerBaseKey(ch);
  const toTick = (sec: number): number => Math.round((sec * bpm * PPQ) / 60);
  const len = Math.max(TICKS_PER_STEP, Math.round(toTick(lengthSec) / TICKS_PER_STEP) * TICKS_PER_STEP);
  const notes: Record<string, ReturnType<typeof defaultNote>> = {};
  starts.forEach((t, i) => {
    const tick = toTick(t);
    if (tick >= len) return;
    const end = Math.min(len, toTick(starts[i + 1] ?? lengthSec));
    const nid = ctx.newId(ID_PREFIX.note);
    notes[nid] = defaultNote({ id: nid, tick, key: base + i, dur: Math.max(1, end - tick) });
  });
  const id = ctx.newId(ID_PREFIX.pattern);
  d.patterns[id] = { id, name: name.slice(0, 64), color: ch.color, length: len, notes: { [ch.id]: notes } };
  d.patternOrder.push(id);
  return id;
}

/** Automation aimed at the old instrument's params points nowhere once the instrument changes. */
function unassignGenAutomation(d: Project, channelId: string): void {
  const prefix = `channel/${channelId}/gen/`;
  for (const aut of Object.values(d.automations)) if (aut.target?.startsWith(prefix)) aut.target = null;
}

// ── Commands ──────────────────────────────────────────────────────────

export const slicerSlice = defineCommand({
  id: 'slicer.slice',
  label: (a) => `Slice into the Slicer (${plural(a.slices.length, 'slice')})`,
  description:
    "Chop a sample into a Krypt Slicer channel: slice N plays on key First key + N - 1 (default C4 = 60 up) at its recorded pitch. slices = slice start times in seconds (analyzer onsets, a grid or by hand; main computes them), lengthSec = the sample's length. Target: channelId (its instrument becomes the Slicer; an existing Slicer keeps its settings and gets the new markers; an audio-clip channel gets a NEW Slicer channel instead) or a NEW channel named `name` (own mixer insert). pattern (default true) adds a pattern replaying the loop at `bpm` (default the project tempo): one note per slice. Sample: sampleId (pool) or samplePath; absent = the channel's own sample. Returns {channelId, insertId, patternId?, slices, baseKey}.",
  args: z.object({
    channelId: z.string().optional(),
    name: z.string().min(1).max(64).optional(),
    sampleId: z.string().optional(),
    samplePath: z.string().min(1).max(400).optional(),
    slices: z.array(z.number().min(0)).min(1).max(MAX_SLICER_SLICES),
    lengthSec: z.number().positive().max(3600),
    bpm: z.number().min(10).max(999).optional(),
    pattern: z.boolean().default(true),
    patternName: z.string().max(64).optional(),
  }),
  run(d, a, ctx) {
    const target = a.channelId ? must(d.channels[a.channelId], `Channel ${a.channelId} not found`) : undefined;
    const sampleId = a.samplePath
      ? samplePoolId(d, a.samplePath, ctx)
      : a.sampleId
        ? must(d.samples[a.sampleId], `Sample ${a.sampleId} not found`).id
        : (target?.generator.sampleId ?? null);
    if (!sampleId) throw new CommandError('Give the sample to slice (sampleId or samplePath), or pick a channel that has one');
    const sample = must(d.samples[sampleId], `Sample ${sampleId} not found`);
    const starts = cleanSlices(a.slices, a.lengthSec, MIN_SLICE_GAP_SEC);
    if (!starts.length) throw new CommandError(`None of the slice times falls inside the sample (0..${a.lengthSec.toFixed(2)} s)`);
    const slices: Slice[] = starts.map((sec) => ({ id: ctx.newId(SLICE_ID_PREFIX), sec }));
    const name = a.name ?? `${sample.name} slicer`;
    let ch: Channel;
    if (target && target.generator.type !== AUDIOCLIP) {
      ch = target;
      if (ch.generator.type === SLICER_PLUGIN) ch.generator = { ...ch.generator, sampleId, slices };
      else {
        unassignGenAutomation(d, ch.id);
        ch.generator = { type: SLICER_PLUGIN, params: {}, sampleId, slices };
      }
      if (a.name) ch.name = a.name;
    } else {
      // An audio clip's own channel would orphan its playlist clips: the Slicer goes on a new channel.
      ch = addChannelWithInsert(d, name, { type: SLICER_PLUGIN, params: {}, sampleId, slices }, ctx);
    }
    checkKeys(ch, slices.length);
    ch.rootKey = slicerBaseKey(ch); // step-sequencer steps play slice 1
    const patternId = a.pattern ? addReplayPattern(d, ch, starts, a.lengthSec, a.bpm ?? d.transport.bpm, a.patternName ?? `${sample.name} loop`, ctx) : undefined;
    return { channelId: ch.id, insertId: ch.insertId, patternId, slices: starts, baseKey: slicerBaseKey(ch) };
  },
});

export const slicerAddSlice = defineCommand({
  id: 'slicer.addSlice',
  label: () => 'Add slice',
  description: "Add a slice marker at `sec` (seconds into the sample) on a Slicer channel. Refused when it would touch another slice or lie past the sample's end. Later slices move up one key. Returns {sliceId, index} (index 0 = slice 1).",
  args: z.object({ channelId: z.string(), sec: z.number().min(0) }),
  run(d, a, ctx) {
    const ch = slicerChannel(d, a.channelId);
    checkInFile(d, ch, a.sec);
    const list = ch.generator.slices ?? [];
    if (list.length >= MAX_SLICER_SLICES) throw new CommandError(`"${ch.name}" already has the most slices (${MAX_SLICER_SLICES}); remove one first`);
    let i = 0;
    while (i < list.length && list[i].sec < a.sec) i++;
    const why = orderProblem(a.sec, list[i - 1], list[i], i);
    if (why) throw new CommandError(`Can't add a slice at ${fmtSec(a.sec)}: ${why}`);
    checkKeys(ch, list.length + 1);
    const slice: Slice = { id: ctx.newId(SLICE_ID_PREFIX), sec: a.sec };
    ch.generator.slices = [...list.slice(0, i), slice, ...list.slice(i)];
    return { sliceId: slice.id, index: i };
  },
});

export const slicerMoveSlice = defineCommand({
  id: 'slicer.moveSlice',
  label: () => 'Move slice',
  description: 'Move a slice marker to `sec` (seconds into the sample). Refused when it would cross or touch a neighbouring slice (the message names it).',
  args: z.object({ channelId: z.string(), sliceId: z.string(), sec: z.number().min(0) }),
  run(d, a) {
    const ch = slicerChannel(d, a.channelId);
    const i = sliceIndex(ch, a.sliceId);
    checkInFile(d, ch, a.sec);
    const list = ch.generator.slices!;
    const why = orderProblem(a.sec, list[i - 1], list[i + 1], i);
    if (why) throw new CommandError(`Can't move slice ${i + 1} to ${fmtSec(a.sec)}: ${why}`);
    list[i].sec = a.sec;
    return {};
  },
});

export const slicerRemoveSlice = defineCommand({
  id: 'slicer.removeSlice',
  label: () => 'Remove slice',
  description: 'Remove a slice marker: the slice before it now plays on to the next marker, and later slices move down one key.',
  args: z.object({ channelId: z.string(), sliceId: z.string() }),
  run(d, a) {
    const ch = slicerChannel(d, a.channelId);
    const i = sliceIndex(ch, a.sliceId);
    ch.generator.slices = ch.generator.slices!.filter((_, k) => k !== i);
    return {};
  },
});

export const slicerSetSlice = defineCommand({
  id: 'slicer.setSlice',
  label: (a) => `Set slice ${[a.pitch !== undefined && 'pitch', a.reverse !== undefined && 'reverse', a.gain !== undefined && 'gain'].filter(Boolean).join(', ') || 'options'}`,
  description: "Per-slice options: pitch (semitones -24..24, on top of the channel pitch), reverse (play it backwards) and gain (linear 0..2, 1 = as recorded). Absent = unchanged; 0 / false / 1 store as 'default'.",
  args: z.object({
    channelId: z.string(),
    sliceId: z.string(),
    pitch: z.number().min(-24).max(24).optional(),
    reverse: z.boolean().optional(),
    gain: z.number().min(0).max(2).optional(),
  }),
  run(d, a) {
    const ch = slicerChannel(d, a.channelId);
    const s = ch.generator.slices![sliceIndex(ch, a.sliceId)];
    if (a.pitch !== undefined) {
      if (a.pitch === 0) delete s.pitch;
      else s.pitch = Math.round(a.pitch * 100) / 100;
    }
    if (a.reverse !== undefined) {
      if (a.reverse) s.reverse = true;
      else delete s.reverse;
    }
    if (a.gain !== undefined) {
      if (a.gain === 1) delete s.gain;
      else s.gain = Math.round(a.gain * 1000) / 1000;
    }
    return {};
  },
});

export const slicerClear = defineCommand({
  id: 'slicer.clear',
  label: () => 'Clear slices',
  description: 'Remove every slice marker of a Slicer channel: the whole sample plays as slice 1 again.',
  args: z.object({ channelId: z.string() }),
  run(d, a) {
    const ch = slicerChannel(d, a.channelId);
    if (!ch.generator.slices?.length) throw new CommandError(`"${ch.name}" has no slice markers to clear`);
    delete ch.generator.slices;
    return {};
  },
});

export const slicerMakePattern = defineCommand({
  id: 'slicer.makePattern',
  label: () => 'Pattern from slices',
  description:
    "Add a pattern that replays a Slicer channel's loop as sliced: slice N at its own time on its key, each note lasting until the next slice, at `bpm` (default the project tempo; give the loop's own tempo so it plays back in time). lengthSec = the sample's length when the pool doesn't know it. Returns {patternId}.",
  args: z.object({ channelId: z.string(), bpm: z.number().min(10).max(999).optional(), lengthSec: z.number().positive().max(3600).optional(), name: z.string().max(64).optional() }),
  run(d, a, ctx) {
    const ch = slicerChannel(d, a.channelId);
    if (!ch.generator.sampleId) throw new CommandError(`"${ch.name}" has no sample to replay`);
    const lengthSec = lengthOf(d, ch) ?? a.lengthSec;
    if (!lengthSec) throw new CommandError(`The length of "${ch.name}"'s sample isn't known yet: open its waveform once, or pass lengthSec`);
    const starts = (ch.generator.slices ?? []).map((s) => s.sec);
    const patternId = addReplayPattern(d, ch, starts.length ? starts : [0], lengthSec, a.bpm ?? d.transport.bpm, a.name ?? `${ch.name} loop`, ctx);
    return { patternId };
  },
});

export const SLICER_COMMANDS: CommandDef[] = [slicerSlice, slicerAddSlice, slicerMoveSlice, slicerRemoveSlice, slicerSetSlice, slicerClear, slicerMakePattern] as CommandDef[];
