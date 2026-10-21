import { z } from 'zod';
import { defineCommand, must, CommandError, type CommandContext } from './types';
import { defaultNote, paletteColor, type Channel, type Clip, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { TICKS_PER_STEP } from '../schema/time';
import { channelsAdd } from './channels';
import { samplesAdd } from './misc';

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function stemLabel(stem: string): string {
  return stem ? stem[0].toUpperCase() + stem.slice(1) : stem;
}

function sub<A, R>(def: { id: string; args: z.ZodType<A>; run: (d: Project, a: A, ctx: CommandContext) => R }, d: Project, args: unknown, ctx: CommandContext): R {
  const parsed = def.args.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CommandError(`${def.id}: ${issue?.message ?? 'invalid arguments'}${issue?.path?.length ? ` at ${issue.path.join('.')}` : ''}`);
  }
  return def.run(d, parsed.data, ctx);
}

function newTrackAfter(d: Project, index: number, name: string, color: string, height: number, ctx: CommandContext): string {
  const id = ctx.newId(ID_PREFIX.track);
  d.playlist.tracks[id] = { id, name: name.slice(0, 64), color, height, mute: false, solo: false };
  d.playlist.trackOrder.splice(Math.min(index, d.playlist.trackOrder.length), 0, id);
  return id;
}

const zStem = z.object({
  stem: z.string().min(1).max(32),
  path: z.string().min(1),
  name: z.string().max(64).optional(),
  frames: z.number().int().min(1).optional(),
  sampleRate: z.number().min(1).optional(),
  channels: z.number().int().min(1).optional(),
  hash: z.string().optional(),
});

export const audioAddStems = defineCommand({
  id: 'audio.addStems',
  label: (a) => `Separate stems (${a.stems.length})`,
  description:
    'Place stems separated from an audio clip: each stem becomes a sample (origin = stem of the source sample), an audio-clip channel that copies the source channel (generator params incl. stretch / pitch / tempo sync, volume, pan) on its own mixer insert routed like the source, and a playlist track directly under the source clip\'s track with a clip at the same start / length / offset. muteSource (default true) mutes the source clip so the stems don\'t double it. Returns trackIds, channelIds, clipIds, sampleIds (stem order).',
  args: z.object({
    clipId: z.string(),
    model: z.string().min(1).max(64),
    stems: z.array(zStem).min(1).max(8),
    muteSource: z.boolean().default(true),
  }),
  run(d, a, ctx) {
    const clip = must(d.playlist.clips[a.clipId], `Clip ${a.clipId} not found (was it deleted?)`);
    if (clip.kind !== 'audio' || !clip.channelId) throw new CommandError('Only audio clips can be separated into stems');
    const src = must(d.channels[clip.channelId], "The clip's audio channel no longer exists");
    const parent = must(src.generator.sampleId ? d.samples[src.generator.sampleId] : undefined, `"${src.name}" has no sample loaded`);
    const seen = new Set<string>();
    for (const s of a.stems) {
      if (seen.has(s.stem)) throw new CommandError(`Stem "${s.stem}" is listed twice`);
      seen.add(s.stem);
    }
    const srcIns = d.mixer.inserts[src.insertId];
    const routes = srcIns && !srcIns.isMaster && Object.keys(srcIns.routes).length ? { ...srcIns.routes } : { [d.mixer.masterId]: 1 };
    const srcTrack = d.playlist.tracks[clip.trackId];
    let trackAt = d.playlist.trackOrder.indexOf(clip.trackId) + 1;
    const srcChannelIndex = d.channelOrder.indexOf(src.id);
    const base = plain(src);
    const baseClip = plain(clip);

    const out = { trackIds: [] as string[], channelIds: [] as string[], clipIds: [] as string[], sampleIds: [] as string[] };
    a.stems.forEach((s, i) => {
      const label = (s.name ?? `${src.name} · ${stemLabel(s.stem)}`).slice(0, 64);
      let sample = Object.values(d.samples).find((x) => x.path === s.path);
      if (!sample) {
        const sid = ctx.newId(ID_PREFIX.sample);
        sample = d.samples[sid] = {
          id: sid,
          name: label,
          path: s.path,
          frames: s.frames,
          sampleRate: s.sampleRate,
          channels: s.channels,
          hash: s.hash,
          origin: { kind: 'stem', parentSampleId: parent.id, stem: s.stem, model: a.model },
        };
        for (const k of ['frames', 'sampleRate', 'channels', 'hash'] as const) if (sample[k] === undefined) delete sample[k];
      }
      const color = paletteColor(d.channelOrder.length);
      const insId = ctx.newId(ID_PREFIX.insert);
      d.mixer.inserts[insId] = {
        id: insId, name: label, color, volume: 1, pan: 0, stereoSep: 0, mute: false, solo: false,
        phaseInvert: false, swapLR: false, slots: {}, slotOrder: [], routes: { ...routes }, isMaster: false,
      };
      d.mixer.insertOrder.push(insId);
      const chId = ctx.newId(ID_PREFIX.channel);
      const ch: Channel = {
        ...plain(base),
        id: chId,
        name: label,
        color,
        insertId: insId,
        mute: false,
        generator: { type: base.generator.type, params: { ...base.generator.params }, sampleId: sample.id },
      };
      d.channels[chId] = ch;
      d.channelOrder.splice(srcChannelIndex >= 0 ? srcChannelIndex + 1 + i : d.channelOrder.length, 0, chId);
      const trkId = newTrackAfter(d, trackAt++, label, srcTrack?.color ?? '#3F3F52', srcTrack?.height ?? 44, ctx);
      const clipId = ctx.newId(ID_PREFIX.clip);
      const c: Clip = { ...baseClip, id: clipId, trackId: trkId, channelId: chId, mute: false };
      d.playlist.clips[clipId] = c;
      out.trackIds.push(trkId);
      out.channelIds.push(chId);
      out.clipIds.push(clipId);
      out.sampleIds.push(sample.id);
    });
    if (a.muteSource) clip.mute = true;
    return out;
  },
});

const zNote = z.object({
  tick: z.number().int().min(0),
  key: z.number().int().min(0).max(127),
  dur: z.number().int().min(1).optional(),
  vel: z.number().min(0).max(1).optional(),
  fine: z.number().min(-100).max(100).optional(),
});

const zCreate = z.object({
  type: z.string(),
  name: z.string().min(1).max(64),
  samplePath: z.string().min(1).optional(),
  params: z.record(z.string(), z.number()).optional(),
  poly: z.object({ mono: z.boolean(), glideMs: z.number().min(0).max(5000), cutGroup: z.number().int().min(0).max(64), cutBy: z.number().int().min(0).max(64) }).partial().optional(),
  rootKey: z.number().int().min(0).max(127).optional(),
});

const zLane = z
  .object({
    channelId: z.string().optional(),
    create: zCreate.optional(),
    notes: z.array(zNote).max(20000),
  })
  .refine((l) => !!l.channelId !== !!l.create, { message: 'each lane needs exactly one of channelId or create' });

export const audioAddTranscription = defineCommand({
  id: 'audio.addTranscription',
  label: (a) => `Audio to pattern "${a.name}"`,
  description:
    'Write transcribed audio as a NEW pattern: one lane per channel (an existing channelId, or a channel to create with an instrument / sample), notes in ticks (PPQ 960). With clipId (the source audio clip) the pattern is also placed on a new playlist track under that clip\'s track with the same start / length / offset, so it plays in sync. Empty lanes are skipped. Returns patternId, channelIds, trackId, clipId and the note count.',
  args: z.object({
    name: z.string().min(1).max(64),
    lanes: z.array(zLane).min(1).max(16),
    clipId: z.string().optional(),
    trackName: z.string().max(64).optional(),
    select: z.boolean().default(true),
  }),
  run(d, a, ctx) {
    const lanes = a.lanes.filter((l) => l.notes.length > 0);
    if (lanes.length === 0) throw new CommandError('No notes to write');
    const total = lanes.reduce((s, l) => s + l.notes.length, 0);
    if (total > 50000) throw new CommandError(`Too many notes (${total}); the limit is 50000 per pattern`);
    const src = a.clipId ? must(d.playlist.clips[a.clipId], `Clip ${a.clipId} not found (was it deleted?)`) : null;

    const patternId = ctx.newId(ID_PREFIX.pattern);
    d.patterns[patternId] = { id: patternId, name: a.name, color: paletteColor(d.patternOrder.length), length: null, notes: {} };
    d.patternOrder.push(patternId);
    const pat = d.patterns[patternId];

    const channelIds: string[] = [];
    for (const lane of lanes) {
      let chId: string;
      if (lane.channelId) chId = must(d.channels[lane.channelId], `Channel ${lane.channelId} not found`).id;
      else {
        const c = lane.create!;
        let sampleId: string | undefined;
        if (c.samplePath) sampleId = sub(samplesAdd, d, { path: c.samplePath }, ctx).id;
        chId = sub(channelsAdd, d, { type: c.type, name: c.name, sampleId, params: c.params }, ctx).id;
        const ch = d.channels[chId];
        if (c.poly) ch.poly = { ...ch.poly, ...Object.fromEntries(Object.entries(c.poly).filter(([, v]) => v !== undefined)) };
        if (c.rootKey !== undefined) ch.rootKey = c.rootKey;
      }
      const notes = (pat.notes[chId] ??= {});
      for (const n of lane.notes) {
        const id = ctx.newId(ID_PREFIX.note);
        notes[id] = defaultNote({ ...n, id, dur: n.dur ?? TICKS_PER_STEP });
      }
      if (!channelIds.includes(chId)) channelIds.push(chId);
    }
    if (a.select) d.transport.activePatternId = patternId;

    let trackId: string | null = null;
    let clipId: string | null = null;
    if (src) {
      const srcTrack = d.playlist.tracks[src.trackId];
      trackId = newTrackAfter(d, d.playlist.trackOrder.indexOf(src.trackId) + 1, a.trackName ?? a.name, srcTrack?.color ?? '#3F3F52', srcTrack?.height ?? 44, ctx);
      clipId = ctx.newId(ID_PREFIX.clip);
      d.playlist.clips[clipId] = { id: clipId, trackId, kind: 'pattern', start: src.start, length: src.length, offset: src.offset, mute: false, color: null, patternId };
    }
    return { patternId, channelIds, trackId, clipId, notes: total };
  },
});

export const AUDIO_COMMANDS = [audioAddStems, audioAddTranscription];
