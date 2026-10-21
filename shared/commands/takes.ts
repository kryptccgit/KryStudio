// Take lanes + comping commands (Wave 12.2b; the model is explained in
// shared/schema/takes.ts). Every comp edit rewrites the group's comp and
// rebuilds its clips on the track in the SAME command, so one comp gesture
// is one undo step and the engine only ever sees ordinary clips.

import { z } from 'zod';
import { defineCommand, must, CommandError, type CommandContext } from './types';
import { defaultNote, paletteColor, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { secondsToTicks } from '../schema/time';
import {
  MAX_CROSSFADE,
  MAX_TAKES,
  TAKE_ID_PREFIX,
  clampComp,
  defaultComp,
  eraseComp,
  materializeComp,
  orderedTakes,
  paintComp,
  sameComp,
  takeOfClip,
  type CompSegment,
  type Take,
  type TakeGroup,
} from '../schema/takes';
import { channelsRemove } from './channels';
import { patternsRemove } from './patterns';

/** Default crossfade: 20 ms at the project tempo. */
export function defaultCrossfade(bpm: number): number {
  return Math.max(1, Math.round(secondsToTicks(0.02, bpm)));
}

function group(d: Project, id: string): TakeGroup {
  return must(d.takeGroups?.[id], `Take group ${id} not found (was its track deleted or the comp flattened?)`);
}

function findTake(g: TakeGroup, a: { takeId?: string; pass?: number }): Take {
  if (a.takeId) return must(g.takes[a.takeId], `Take ${a.takeId} is not in "${g.name}"`);
  const t = Object.values(g.takes).find((x) => x.pass === a.pass);
  return must(t, `"${g.name}" has no take from pass ${a.pass} (it has ${orderedTakes(g).map((x) => x.pass).join(', ')})`);
}

const zWhich = {
  takeId: z.string().optional(),
  /** Recording pass, 1-based ("take from pass N"). */
  pass: z.number().int().min(1).optional(),
};
const oneTake = (a: { takeId?: string; pass?: number }) => !!a.takeId !== (a.pass !== undefined);
const ONE_TAKE = { message: 'pass exactly one of takeId or pass' };

/** Run a command body inside this one (same draft); a CommandError from it propagates. */
function sub<A>(def: { args: z.ZodType<A>; run: (d: Project, a: A, ctx: CommandContext) => unknown }, d: Project, args: unknown, ctx: CommandContext): void {
  def.run(d, def.args.parse(args), ctx);
}

// ── Create ────────────────────────────────────────────────────────────

const zPassNote = z.object({
  channelId: z.string(),
  /** Song tick. */
  tick: z.number().min(0),
  dur: z.number().min(1),
  key: z.number().int().min(0).max(127),
  vel: z.number().min(0).max(1),
});

export const takesCreateGroup = defineCommand({
  id: 'takes.createGroup',
  label: (a) => `Record ${a.passes.length} takes`,
  description:
    'Create a take group (take lanes + comp) from the passes of a loop recording. audio: the ONE recorded file (each pass = sec, its start in the file); without audio each pass carries its MIDI notes (song ticks) and becomes a pattern. Each take gets its own source (audio: an Audio Clip channel on one shared insert: `insertId` when given, else a new one; MIDI: a pattern). The comp starts as the last take wherever it was recorded (prefer "first" for the first) and is placed as clips on trackId (default: a new track named after the group). crossfade in ticks (default 20 ms). Returns groupId, trackId, takeIds, clipIds.',
  args: z.object({
    name: z.string().min(1).max(64).default('Take'),
    trackId: z.string().optional(),
    audio: z
      .object({
        path: z.string().min(1),
        name: z.string().max(64).optional(),
        frames: z.number().int().min(1),
        sampleRate: z.number().min(1),
        channels: z.number().int().min(1),
        hash: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
      })
      .optional(),
    passes: z
      .array(
        z.object({
          start: z.number().int().min(0),
          end: z.number().int().min(1),
          /** Audio: seconds into the file where this pass begins. */
          sec: z.number().min(0).default(0),
          notes: z.array(zPassNote).max(20000).optional(),
        }),
      )
      .min(1)
      .max(MAX_TAKES),
    crossfade: z.number().int().min(0).max(MAX_CROSSFADE).optional(),
    prefer: z.enum(['last', 'first']).default('last'),
    /** Audio: play the takes through this existing insert (the Recording Studio's vocal insert) instead of a new one. */
    insertId: z.string().optional(),
  }),
  run(d, a, ctx) {
    for (const [i, p] of a.passes.entries()) if (!(p.end > p.start)) throw new CommandError(`Pass ${i + 1} is empty (it ends where it starts)`);
    const bpm = d.transport.bpm;
    const start = Math.min(...a.passes.map((p) => p.start));
    const end = Math.max(...a.passes.map((p) => p.end));
    let trackId = a.trackId;
    if (trackId) must(d.playlist.tracks[trackId], `Track ${trackId} not found`);
    else {
      trackId = ctx.newId(ID_PREFIX.track);
      d.playlist.tracks[trackId] = { id: trackId, name: a.name, color: '#3F3F52', height: 44, mute: false, solo: false };
      d.playlist.trackOrder.push(trackId);
    }

    const g: TakeGroup = { id: ctx.newId(TAKE_ID_PREFIX.group), name: a.name, trackId, start, end, takes: {}, takeOrder: [], comp: [], crossfade: a.crossfade ?? defaultCrossfade(bpm) };
    let insertId: string | null = null;
    let sampleId: string | null = null;

    if (a.audio) {
      const au = a.audio;
      let sample = Object.values(d.samples).find((s) => s.path === au.path);
      if (!sample) {
        const id = ctx.newId(ID_PREFIX.sample);
        const name = (au.name ?? au.path.split(/[\\/]/).pop() ?? 'Recording').replace(/\.[a-z0-9]+$/i, '').slice(0, 64);
        sample = d.samples[id] = { id, name, path: au.path, frames: au.frames, sampleRate: au.sampleRate, channels: au.channels };
        if (au.hash) sample.hash = au.hash;
      }
      sampleId = sample.id;
      const color = paletteColor(d.channelOrder.length);
      if (a.insertId) insertId = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`).id;
      else {
        insertId = ctx.newId(ID_PREFIX.insert);
        d.mixer.inserts[insertId] = {
          id: insertId, name: a.name, color, volume: 1, pan: 0, stereoSep: 0, mute: false, solo: false,
          phaseInvert: false, swapLR: false, slots: {}, slotOrder: [], routes: { [d.mixer.masterId]: 1 }, isMaster: false,
        };
        d.mixer.insertOrder.push(insertId);
      }
      const fileTicks = Math.round(secondsToTicks(au.frames / au.sampleRate, bpm));
      a.passes.forEach((p, i) => {
        const chId = ctx.newId(ID_PREFIX.channel);
        d.channels[chId] = {
          id: chId, name: `${a.name} take ${i + 1}`.slice(0, 64), color,
          generator: { type: 'krypt.audioclip', params: {}, sampleId: sample!.id },
          volume: 0.78, pan: 0, pitch: 0, mute: false, insertId: insertId!, rootKey: 60, swing: 0,
          poly: { mono: true, glideMs: 0, cutGroup: 0, cutBy: 0 },
        };
        d.channelOrder.push(chId);
        const origin = Math.round(p.start - secondsToTicks(p.sec, bpm));
        const t: Take = { id: ctx.newId(TAKE_ID_PREFIX.take), name: `Take ${i + 1}`, pass: i + 1, source: { kind: 'audio', channelId: chId }, origin, start: p.start, end: p.end, srcEnd: origin + fileTicks };
        g.takes[t.id] = t;
        g.takeOrder.push(t.id);
      });
    } else {
      const len = end - start;
      a.passes.forEach((p, i) => {
        const patId = ctx.newId(ID_PREFIX.pattern);
        const notes: Project['patterns'][string]['notes'] = {};
        for (const n of p.notes ?? []) {
          must(d.channels[n.channelId], `Channel ${n.channelId} not found`);
          const tick = Math.round(n.tick - start);
          if (tick < 0 || tick >= len) continue;
          const id = ctx.newId(ID_PREFIX.note);
          (notes[n.channelId] ??= {})[id] = defaultNote({ id, tick, key: n.key, dur: Math.max(1, Math.min(Math.round(n.dur), len - tick)), vel: n.vel });
        }
        d.patterns[patId] = { id: patId, name: `${a.name} take ${i + 1}`.slice(0, 64), color: paletteColor(d.patternOrder.length), length: len, notes };
        d.patternOrder.push(patId);
        const t: Take = { id: ctx.newId(TAKE_ID_PREFIX.take), name: `Take ${i + 1}`, pass: i + 1, source: { kind: 'pattern', patternId: patId }, origin: start, start: p.start, end: p.end };
        g.takes[t.id] = t;
        g.takeOrder.push(t.id);
      });
    }
    g.comp = clampComp(g, defaultComp(orderedTakes(g), a.prefer));
    (d.takeGroups ??= {})[g.id] = g;
    const clipIds = materializeComp(d, d.takeGroups[g.id], ctx.newId);
    return { groupId: g.id, trackId, takeIds: [...g.takeOrder], clipIds, insertId, sampleId };
  },
});

// ── Comp edits ────────────────────────────────────────────────────────

export const takesSelect = defineCommand({
  id: 'takes.select',
  label: (a) => (a.start !== undefined || a.end !== undefined ? 'Comp a range' : `Use take ${a.pass ?? ''}`.trim()),
  description:
    'Swipe-comp: use one take (takeId, or pass = its recording pass, 1-based) for the song-tick range [start, end), clamped to where that take was recorded. Without start/end the whole take is used ("take from pass N"). The comp clips on the track are rebuilt with crossfades. Returns {changed}.',
  args: z
    .object({ groupId: z.string(), ...zWhich, start: z.number().int().min(0).optional(), end: z.number().int().min(1).optional() })
    .refine(oneTake, ONE_TAKE),
  run(d, a, ctx) {
    const g = group(d, a.groupId);
    const t = findTake(g, a);
    const s = Math.max(a.start ?? t.start, t.start, g.start);
    const e = Math.min(a.end ?? t.end, t.end, g.end);
    if (!(e > s)) throw new CommandError(`${t.name} wasn't recorded in that range (it covers ticks ${t.start}–${t.end})`);
    const comp = paintComp(g.comp, s, e, t.id);
    if (sameComp(comp, g.comp)) return { changed: false };
    g.comp = comp;
    materializeComp(d, g, ctx.newId);
    return { changed: true };
  },
});

export const takesSetCrossfade = defineCommand({
  id: 'takes.setCrossfade',
  label: () => 'Comp crossfade',
  description: 'Set the crossfade length (ticks, 0 = hard cuts) at the boundaries between comp segments of a take group, and rebuild its clips. Returns {changed}.',
  args: z.object({ groupId: z.string(), ticks: z.number().int().min(0).max(MAX_CROSSFADE) }),
  run(d, a, ctx) {
    const g = group(d, a.groupId);
    if (g.crossfade === a.ticks) return { changed: false };
    g.crossfade = a.ticks;
    materializeComp(d, g, ctx.newId);
    return { changed: true };
  },
});

export const takesFlatten = defineCommand({
  id: 'takes.flatten',
  label: () => 'Flatten comp',
  description:
    'Flatten a take group: its comp clips stay on the track as ordinary clips, the take lanes go away, and takes the comp does not use are deleted (their Audio Clip channels or patterns). Returns kept / removed take counts.',
  args: z.object({ groupId: z.string() }),
  run(d, a, ctx) {
    const g = group(d, a.groupId);
    // A take is kept when any clip still plays it (the comp, or a copy the user made elsewhere).
    const used = new Set<string>();
    for (const c of Object.values(d.playlist.clips)) {
      const t = takeOfClip(g, c) ?? takeOfClip(g, { ...c, trackId: g.trackId });
      if (t) used.add(t.id);
    }
    delete d.takeGroups![g.id];
    if (!Object.keys(d.takeGroups!).length) delete d.takeGroups;
    const unused = orderedTakes(g).filter((t) => !used.has(t.id));
    const chans = unused.flatMap((t) => (t.source.kind === 'audio' && d.channels[t.source.channelId] ? [t.source.channelId] : []));
    if (chans.length) sub(channelsRemove, d, { ids: chans }, ctx);
    for (const t of unused) {
      if (t.source.kind !== 'pattern' || !d.patterns[t.source.patternId]) continue;
      if (Object.values(d.playlist.clips).some((c) => c.patternId === (t.source as { patternId: string }).patternId)) continue;
      if (d.patternOrder.length > 1) sub(patternsRemove, d, { id: t.source.patternId }, ctx);
    }
    return { kept: used.size, removed: unused.length };
  },
});

export const takesRemoveTake = defineCommand({
  id: 'takes.removeTake',
  label: () => 'Delete take',
  description:
    'Delete one take (takeId or pass) and its channel / pattern. Where the comp used it, the latest other take recorded there fills in; with no takes left the group is removed. Returns {groupRemoved}.',
  args: z.object({ groupId: z.string(), ...zWhich }).refine(oneTake, ONE_TAKE),
  run(d, a, ctx) {
    const g = group(d, a.groupId);
    const t = findTake(g, a);
    for (const c of Object.values(d.playlist.clips)) if (takeOfClip(g, c)?.id === t.id) delete d.playlist.clips[c.id];
    const holes = g.comp.filter((s) => s.takeId === t.id);
    let comp: CompSegment[] = g.comp.filter((s) => s.takeId !== t.id);
    delete g.takes[t.id];
    g.takeOrder = g.takeOrder.filter((id) => id !== t.id);
    // Fill each hole from the other takes, the latest pass winning.
    const others = orderedTakes(g).sort((x, y) => x.pass - y.pass);
    for (const h of holes) {
      let fill: CompSegment[] = [];
      for (const o of others) {
        const s = Math.max(h.start, o.start);
        const e = Math.min(h.end, o.end);
        if (e > s) fill = paintComp(fill, s, e, o.id);
      }
      for (const f of fill) comp = paintComp(comp, f.start, f.end, f.takeId);
    }
    g.comp = comp;
    const groupRemoved = g.takeOrder.length === 0;
    if (groupRemoved) {
      delete d.takeGroups![g.id];
      if (!Object.keys(d.takeGroups!).length) delete d.takeGroups;
    } else materializeComp(d, g, ctx.newId);
    if (t.source.kind === 'audio') {
      if (d.channels[t.source.channelId]) sub(channelsRemove, d, { ids: [t.source.channelId] }, ctx);
    } else {
      const pid = t.source.patternId;
      if (d.patterns[pid] && d.patternOrder.length > 1 && !Object.values(d.playlist.clips).some((c) => c.patternId === pid)) sub(patternsRemove, d, { id: pid }, ctx);
    }
    return { groupRemoved };
  },
});

export const takesMoveTake = defineCommand({
  id: 'takes.moveTake',
  label: (a) => `Move take ${a.direction}`,
  description: 'Move a take lane (takeId or pass) one place up or down in its group. The comp does not change.',
  args: z.object({ groupId: z.string(), ...zWhich, direction: z.enum(['up', 'down']) }).refine(oneTake, ONE_TAKE),
  run(d, a) {
    const g = group(d, a.groupId);
    const t = findTake(g, a);
    const i = g.takeOrder.indexOf(t.id);
    const j = a.direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= g.takeOrder.length) throw new CommandError(`${t.name} is already the ${a.direction === 'up' ? 'top' : 'bottom'} lane`);
    [g.takeOrder[i], g.takeOrder[j]] = [g.takeOrder[j], g.takeOrder[i]];
    return {};
  },
});

export const takesRename = defineCommand({
  id: 'takes.rename',
  label: () => 'Rename take group',
  description: 'Rename a take group (shown on its take lanes and in comp_takes).',
  args: z.object({ groupId: z.string(), name: z.string().min(1).max(64) }),
  run(d, a) {
    group(d, a.groupId).name = a.name;
    return {};
  },
});

/** Erase a range from the comp (silence there) — e.g. drop a breath between phrases. */
export const takesClearRange = defineCommand({
  id: 'takes.clearRange',
  label: () => 'Silence comp range',
  description: 'Remove [start, end) (song ticks) from a take group\'s comp so nothing plays there, and rebuild its clips. Returns {changed}.',
  args: z.object({ groupId: z.string(), start: z.number().int().min(0), end: z.number().int().min(1) }),
  run(d, a, ctx) {
    const g = group(d, a.groupId);
    const comp = eraseComp(g.comp, a.start, a.end);
    if (sameComp(comp, g.comp)) return { changed: false };
    g.comp = comp;
    materializeComp(d, g, ctx.newId);
    return { changed: true };
  },
});

export const TAKES_COMMANDS = [takesCreateGroup, takesSelect, takesSetCrossfade, takesFlatten, takesRemoveTake, takesMoveTake, takesRename, takesClearRange];
