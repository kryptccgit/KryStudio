import { z } from 'zod';
import { rackSampleIds } from './racks';
import { defineCommand, must, CommandError } from './types';
import { COVER_FILE_RE, coverMimeOf, paletteColor, type AutomationPoint } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { getParamValue, paramLabel, paramSpecFor, setParamValue } from '../schema/params';
import { fromNormalized, toNormalized } from '../plugins/types';
import { fallbackClipLength } from '../schema/factory';
import { keepAudioInPlace } from './audioTiming';

export const transportSet = defineCommand({
  id: 'transport.set',
  label: (a) => (a.bpm !== undefined ? `Tempo ${a.bpm}` : 'Edit transport'),
  description: 'Set tempo (bpm 10..999), time signature, global swing (0..1), metronome, master volume (linear) and the song loop region (ticks).',
  args: z.object({
    bpm: z.number().min(10).max(999).optional(),
    timeSig: z.object({ num: z.number().int().min(1).max(32), den: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]) }).optional(),
    swing: z.number().min(0).max(1).optional(),
    metronome: z.boolean().optional(),
    masterVolume: z.number().min(0).max(2).optional(),
    loop: z.object({ enabled: z.boolean().optional(), start: z.number().int().min(0).optional(), end: z.number().int().min(1).optional() }).optional(),
  }),
  run(d, a) {
    const t = d.transport;
    if (a.bpm !== undefined) t.bpm = Math.round(a.bpm * 1000) / 1000;
    if (a.timeSig) t.timeSig = a.timeSig;
    if (a.swing !== undefined) t.swing = a.swing;
    if (a.metronome !== undefined) t.metronome = a.metronome;
    if (a.masterVolume !== undefined) t.masterVolume = a.masterVolume;
    if (a.loop) {
      const next = { ...t.loop, ...Object.fromEntries(Object.entries(a.loop).filter(([, v]) => v !== undefined)) };
      if (next.end <= next.start) throw new CommandError('Loop end must be after loop start');
      t.loop = next;
    }
    return {};
  },
});

export const transportSetMode = defineCommand({
  id: 'transport.setMode',
  label: (a) => `${a.mode === 'song' ? 'Song' : 'Pattern'} mode`,
  description: 'Switch between pattern mode (loop the active pattern) and song mode (play the playlist).',
  args: z.object({ mode: z.enum(['pattern', 'song']) }),
  history: false,
  run(d, a) {
    d.transport.mode = a.mode;
    return {};
  },
});

export const samplesAdd = defineCommand({
  id: 'samples.add',
  label: () => 'Add sample',
  description: "Add an audio file to the project sample pool (absolute path or 'factory:...'). Deduplicates by path. Returns the sample id.",
  args: z.object({ path: z.string().min(1), name: z.string().optional(), frames: z.number().int().optional(), sampleRate: z.number().optional(), channels: z.number().int().optional(), hash: z.string().optional() }),
  run(d, a, ctx) {
    const existing = Object.values(d.samples).find((s) => s.path === a.path);
    if (existing) return { id: existing.id, existed: true };
    const id = ctx.newId(ID_PREFIX.sample);
    const name = (a.name ?? a.path.split(/[\\/:]/).pop() ?? 'Sample').replace(/\.[a-z0-9]+$/i, '');
    d.samples[id] = { id, name, path: a.path, frames: a.frames, sampleRate: a.sampleRate, channels: a.channels, hash: a.hash };
    return { id, existed: false };
  },
});

export const samplesRemove = defineCommand({
  id: 'samples.remove',
  label: () => 'Remove sample',
  description: 'Remove a sample from the pool. Fails if a channel still uses it.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    must(d.samples[a.id], `Sample ${a.id} not found`);
    const user = Object.values(d.channels).find((c) => c.generator.sampleId === a.id);
    if (user) throw new CommandError(`Sample is used by channel "${user.name}"`);
    const rackUser = Object.values(d.channels).find((c) => Object.values(c.generator.rack?.chains ?? {}).some((x) => x.instrument?.sampleId === a.id));
    if (rackUser) throw new CommandError(`Sample is used inside the rack on channel "${rackUser.name}"`);
    if (rackSampleIds(d).has(a.id)) throw new CommandError('Sample is used inside an effect rack');
    delete d.samples[a.id];
    return {};
  },
});

export const samplesRelink = defineCommand({
  id: 'samples.relink',
  label: () => 'Relink sample',
  description: 'Point a sample at a new file path (missing-sample relink).',
  args: z.object({ id: z.string(), path: z.string().min(1), frames: z.number().int().optional(), sampleRate: z.number().optional(), channels: z.number().int().optional() }),
  run(d, a) {
    const s = must(d.samples[a.id], `Sample ${a.id} not found`);
    s.path = a.path;
    if (a.frames !== undefined) s.frames = a.frames;
    if (a.sampleRate !== undefined) s.sampleRate = a.sampleRate;
    if (a.channels !== undefined) s.channels = a.channels;
    return {};
  },
});

export const paramsSet = defineCommand({
  id: 'params.set',
  label: () => 'Set parameter',
  description:
    'Set any automatable value by ParamRef, e.g. "channel/<id>/gen/cutoff", "insert/<id>/volume", "insert/<id>/slot/<slotId>/threshold", "transport/bpm"; knobs inside racks: "channel/<id>/rack/<chainId>/inst/cutoff", "channel/<id>/rack/<chainId>/dev/<deviceId>/<param|mix>", "<…>/rack/<chainId>/volume|pan" (effect racks: "insert/<id>/slot/<slotId>/rack/…"). `value` is in plain units unless normalized=true (0..1 knob position).',
  args: z.object({ ref: z.string(), value: z.number(), normalized: z.boolean().default(false) }),
  run(d, a, ctx) {
    const spec = must(paramSpecFor(d, ctx.catalog, a.ref), `Parameter "${a.ref}" does not exist`);
    const v = a.normalized ? fromNormalized(spec, a.value) : a.value;
    const gen = /^channel\/([^/]+)\/gen\//.exec(a.ref);
    const err = gen ? keepAudioInPlace(d, ctx.catalog, gen[1], () => setParamValue(d, ctx.catalog, a.ref, v)) : setParamValue(d, ctx.catalog, a.ref, v);
    if (err) throw new CommandError(err);
    return { value: getParamValue(d, ctx.catalog, a.ref) };
  },
});

const zPoint = z.object({ tick: z.number().int().min(0), value: z.number().min(0).max(1), tension: z.number().min(-1).max(1).default(0) });

export const automationCreate = defineCommand({
  id: 'automation.create',
  label: () => 'Create automation clip',
  description:
    'Create an automation for a ParamRef. points are {tick (relative), value 0..1 normalized, tension -1..1}; default = a flat line at the current value. If trackId is given, also places a clip at `start`. Returns automationId (and clipId).',
  args: z.object({
    target: z.string(),
    name: z.string().optional(),
    points: z.array(zPoint).optional(),
    trackId: z.string().optional(),
    start: z.number().int().min(0).default(0),
    length: z.number().int().min(1).optional(),
  }),
  run(d, a, ctx) {
    const spec = must(paramSpecFor(d, ctx.catalog, a.target), `Parameter "${a.target}" does not exist`);
    const cur = getParamValue(d, ctx.catalog, a.target) ?? spec.default;
    const len = a.length ?? fallbackClipLength(d.transport.timeSig);
    const pts = a.points ?? [
      { tick: 0, value: toNormalized(spec, cur), tension: 0 },
      { tick: len, value: toNormalized(spec, cur), tension: 0 },
    ];
    const id = ctx.newId(ID_PREFIX.automation);
    const points: Record<string, AutomationPoint> = {};
    for (const p of pts) {
      const pid = ctx.newId(ID_PREFIX.point);
      points[pid] = { id: pid, tick: p.tick, value: p.value, tension: p.tension ?? 0 };
    }
    d.automations[id] = { id, name: a.name ?? `${paramLabel(d, ctx.catalog, a.target) ?? spec.name} automation`, color: paletteColor(Object.keys(d.automations).length + 3), target: a.target, points };
    let clipId: string | undefined;
    if (a.trackId) {
      must(d.playlist.tracks[a.trackId], `Track ${a.trackId} not found`);
      clipId = ctx.newId(ID_PREFIX.clip);
      d.playlist.clips[clipId] = { id: clipId, trackId: a.trackId, kind: 'automation', start: a.start, length: len, offset: 0, mute: false, color: null, automationId: id };
    }
    return { automationId: id, clipId };
  },
});

export const automationSetPoints = defineCommand({
  id: 'automation.setPoints',
  label: () => 'Edit automation',
  description: 'Replace all points of an automation ({tick relative, value 0..1, tension}).',
  args: z.object({ id: z.string(), points: z.array(zPoint).max(20000) }),
  run(d, a, ctx) {
    const aut = must(d.automations[a.id], `Automation ${a.id} not found`);
    aut.points = {};
    for (const p of a.points) {
      const pid = ctx.newId(ID_PREFIX.point);
      aut.points[pid] = { id: pid, tick: p.tick, value: p.value, tension: p.tension ?? 0 };
    }
    return {};
  },
});

export const automationEditPoints = defineCommand({
  id: 'automation.editPoints',
  label: () => 'Edit automation points',
  description: 'Add, update and remove individual automation points by id.',
  args: z.object({
    id: z.string(),
    add: z.array(zPoint).optional(),
    update: z.array(z.object({ id: z.string(), tick: z.number().int().min(0).optional(), value: z.number().min(0).max(1).optional(), tension: z.number().min(-1).max(1).optional() })).optional(),
    remove: z.array(z.string()).optional(),
  }),
  run(d, a, ctx) {
    const aut = must(d.automations[a.id], `Automation ${a.id} not found`);
    const added: string[] = [];
    for (const id of a.remove ?? []) delete aut.points[id];
    for (const u of a.update ?? []) {
      const p = must(aut.points[u.id], `Point ${u.id} not found`);
      if (u.tick !== undefined) p.tick = u.tick;
      if (u.value !== undefined) p.value = u.value;
      if (u.tension !== undefined) p.tension = u.tension;
    }
    for (const p of a.add ?? []) {
      const pid = ctx.newId(ID_PREFIX.point);
      aut.points[pid] = { id: pid, tick: p.tick, value: p.value, tension: p.tension ?? 0 };
      added.push(pid);
    }
    return { added };
  },
});

export const automationSet = defineCommand({
  id: 'automation.set',
  label: () => 'Edit automation',
  description: 'Rename / recolor an automation or retarget it to another ParamRef (null = unassigned).',
  args: z.object({ id: z.string(), name: z.string().optional(), color: z.string().optional(), target: z.string().nullable().optional() }),
  run(d, a, ctx) {
    const aut = must(d.automations[a.id], `Automation ${a.id} not found`);
    if (a.name !== undefined) aut.name = a.name;
    if (a.color !== undefined) aut.color = a.color;
    if (a.target !== undefined) {
      if (a.target !== null) must(paramSpecFor(d, ctx.catalog, a.target), `Parameter "${a.target}" does not exist`);
      aut.target = a.target;
    }
    return {};
  },
});

export const automationRemove = defineCommand({
  id: 'automation.remove',
  label: () => 'Delete automation',
  description: 'Delete an automation and its playlist clips.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    must(d.automations[a.id], `Automation ${a.id} not found`);
    delete d.automations[a.id];
    for (const c of Object.values(d.playlist.clips)) if (c.kind === 'automation' && c.automationId === a.id) delete d.playlist.clips[c.id];
    return {};
  },
});

export const projectSetMeta = defineCommand({
  id: 'project.setMeta',
  label: () => 'Edit project info',
  description: 'Set project name, author, genre and notes.',
  args: z.object({ name: z.string().max(128).optional(), author: z.string().max(128).optional(), genre: z.string().max(64).optional(), notes: z.string().max(20000).optional() }),
  run(d, a) {
    for (const [k, v] of Object.entries(a)) if (v !== undefined) (d.meta as any)[k] = v;
    return {};
  },
});

const zInfoText = (max: number) => z.string().max(max).optional();

export const projectSetInfo = defineCommand({
  id: 'project.setInfo',
  label: () => 'Edit song info',
  description:
    'Set the song info embedded in exported files: title (empty = use the project name), artist (empty = use the author), album, year (1000..9999, null clears), genre, trackNumber (1..999, null clears). Omitted fields stay as they are; an empty string clears a field.',
  args: z.object({
    title: zInfoText(200),
    artist: zInfoText(200),
    album: zInfoText(200),
    year: z.number().int().min(1000).max(9999).nullable().optional(),
    genre: zInfoText(64),
    trackNumber: z.number().int().min(1).max(999).nullable().optional(),
  }),
  run(d, a) {
    const m = d.meta;
    for (const k of ['title', 'artist', 'album'] as const) {
      const v = a[k];
      if (v === undefined) continue;
      const t = v.trim();
      if (t) m[k] = t;
      else delete m[k];
    }
    if (a.genre !== undefined) m.genre = a.genre.trim();
    if (a.year !== undefined) {
      if (a.year === null) delete m.year;
      else m.year = a.year;
    }
    if (a.trackNumber !== undefined) {
      if (a.trackNumber === null) delete m.trackNumber;
      else m.trackNumber = a.trackNumber;
    }
    return {};
  },
});

export const projectSetCover = defineCommand({
  id: 'project.setCover',
  label: () => 'Set cover art',
  description:
    "Point the project's cover at an image main already stored for it (file = cover-<16 hex>.jpg|png, from the cover import / generator). The image bytes never pass through the document.",
  args: z.object({
    file: z.string().regex(COVER_FILE_RE, 'file must be a stored cover name (cover-<16 hex>.jpg or .png)'),
    mime: z.enum(['image/png', 'image/jpeg']),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
  }),
  run(d, a) {
    if (coverMimeOf(a.file) !== a.mime) throw new CommandError(`${a.file} is not ${a.mime}`);
    d.meta.cover = { file: a.file, mime: a.mime, width: a.width, height: a.height };
    return {};
  },
});

export const projectClearCover = defineCommand({
  id: 'project.clearCover',
  label: () => 'Remove cover art',
  description: "Remove the project's cover image (undo brings it back).",
  args: z.object({}),
  run(d) {
    if (!d.meta.cover) throw new CommandError('The project has no cover image');
    delete d.meta.cover;
    return {};
  },
});

export const MISC_COMMANDS = [
  transportSet,
  transportSetMode,
  samplesAdd,
  samplesRemove,
  samplesRelink,
  paramsSet,
  automationCreate,
  automationSetPoints,
  automationEditPoints,
  automationSet,
  automationRemove,
  projectSetMeta,
  projectSetInfo,
  projectSetCover,
  projectClearCover,
];
