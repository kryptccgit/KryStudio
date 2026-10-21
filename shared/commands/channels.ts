import { z } from 'zod';
import { defineCommand, must, plural, CommandError } from './types';
import { DEFAULT_CHANNEL_VOLUME, paletteColor, type Channel, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { findPlugin } from '../schema/params';
import { clampToSpec, type PluginCatalog } from '../plugins/types';
import type { CommandContext } from './types';
import { keepAudioInPlace } from './audioTiming';
import { removeLaunchClipsWhere } from './session';
import { dropTakeRefs } from '../schema/takes';
import { SLICER_PLUGIN } from '../schema/slicer';

/** Validate + clamp sparse plugin params against the catalog (unknown param = CommandError naming it; unknown plugin = passed through). */
export function sanitizeParams(catalog: PluginCatalog, type: string, params: Record<string, number>): Record<string, number> {
  const desc = findPlugin(catalog, type);
  if (!desc) return { ...params };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    const spec = desc.params.find((p) => p.id === k);
    if (!spec) throw new CommandError(`${desc.name} has no parameter "${k}"`);
    out[k] = clampToSpec(spec, v);
  }
  return out;
}

/** Create an insert for a channel and return its id. */
function newInsertFor(d: Project, name: string, color: string, ctx: CommandContext): string {
  const id = ctx.newId(ID_PREFIX.insert);
  d.mixer.inserts[id] = {
    id,
    name,
    color,
    volume: 1,
    pan: 0,
    stereoSep: 0,
    mute: false,
    solo: false,
    phaseInvert: false,
    swapLR: false,
    slots: {},
    slotOrder: [],
    routes: { [d.mixer.masterId]: 1 },
    isMaster: false,
  };
  d.mixer.insertOrder.push(id);
  return id;
}

export const channelsAdd = defineCommand({
  id: 'channels.add',
  label: (a) => `Add channel${a.name ? ` "${a.name}"` : ''}`,
  description:
    "Add a channel to the Channel Rack with a generator plugin (e.g. 'krypt.sampler', 'krypt.triosc', 'krypt.kick808', 'krypt.drumsynth'). insertId: an existing mixer insert, 'master', or 'new' (default: a new insert named after the channel). Returns the channel id.",
  args: z.object({
    type: z.string(),
    name: z.string().max(64).optional(),
    color: z.string().optional(),
    sampleId: z.string().nullable().optional(),
    insertId: z.string().optional(),
    index: z.number().int().min(0).optional(),
    params: z.record(z.string(), z.number()).optional(),
  }),
  run(d, a, ctx) {
    const desc = must(findPlugin(ctx.catalog, a.type), `Unknown instrument "${a.type}"`);
    if (desc.kind !== 'instrument') throw new CommandError(`${desc.name} is an effect, not an instrument`);
    if (a.sampleId) must(d.samples[a.sampleId], `Sample ${a.sampleId} not found`);
    const id = ctx.newId(ID_PREFIX.channel);
    const color = a.color ?? paletteColor(d.channelOrder.length);
    const name = a.name ?? (a.sampleId ? d.samples[a.sampleId].name : desc.name.replace(/^Krypt /, ''));
    let insertId: string;
    if (!a.insertId || a.insertId === 'new') insertId = newInsertFor(d, name, color, ctx);
    else if (a.insertId === 'master') insertId = d.mixer.masterId;
    else insertId = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`).id;
    const ch: Channel = {
      id,
      name,
      color,
      generator: { type: a.type, params: sanitizeParams(ctx.catalog, a.type, a.params ?? {}), sampleId: a.sampleId ?? null },
      volume: DEFAULT_CHANNEL_VOLUME,
      pan: 0,
      pitch: 0,
      mute: false,
      insertId,
      rootKey: a.type === 'krypt.kick808' ? 36 : 60, // 808s play true pitch; steps land on C2
      swing: 1,
      poly: { mono: a.type === 'krypt.kick808', glideMs: a.type === 'krypt.kick808' ? 60 : 0, cutGroup: 0, cutBy: 0 },
    };
    d.channels[id] = ch;
    const idx = a.index ?? d.channelOrder.length;
    d.channelOrder.splice(Math.min(idx, d.channelOrder.length), 0, id);
    return { id, insertId };
  },
});

export const channelsRemove = defineCommand({
  id: 'channels.remove',
  label: (a) => `Delete ${plural(a.ids.length, 'channel')}`,
  description: 'Delete channels, their notes in every pattern and any audio clips that play through them. Their mixer inserts are kept.',
  args: z.object({ ids: z.array(z.string()).min(1) }),
  run(d, a) {
    for (const id of a.ids) {
      must(d.channels[id], `Channel ${id} not found`);
      delete d.channels[id];
      for (const p of Object.values(d.patterns)) delete p.notes[id];
      for (const c of Object.values(d.playlist.clips)) if (c.kind === 'audio' && c.channelId === id) delete d.playlist.clips[c.id];
      removeLaunchClipsWhere(d, (c) => c.kind === 'audio' && c.channelId === id);
      dropTakeRefs(d, { channelIds: [id] }); // takes: a take that played this channel goes
    }
    d.channelOrder = d.channelOrder.filter((c) => !a.ids.includes(c));
    return {};
  },
});

const zPoly = z.object({ mono: z.boolean(), glideMs: z.number().min(0).max(5000), cutGroup: z.number().int().min(0).max(64), cutBy: z.number().int().min(0).max(64) }).partial();

export const channelsSet = defineCommand({
  id: 'channels.set',
  label: () => 'Edit channel',
  description:
    'Change channel settings: name, color, volume (linear gain, 0.78 default, 1 = 0 dB), pan (-1..1), pitch (semitones), mute, insertId (mixer routing), rootKey, swing (0..1 share of global swing), poly {mono, glideMs, cutGroup, cutBy}, group (Channel Rack filter group name; null = automatic).',
  args: z.object({
    id: z.string(),
    name: z.string().max(64).optional(),
    color: z.string().optional(),
    volume: z.number().min(0).max(1.25).optional(),
    pan: z.number().min(-1).max(1).optional(),
    pitch: z.number().min(-24).max(24).optional(),
    mute: z.boolean().optional(),
    insertId: z.string().optional(),
    rootKey: z.number().int().min(0).max(127).optional(),
    swing: z.number().min(0).max(1).optional(),
    poly: zPoly.optional(),
    group: z.string().trim().max(32).nullable().optional(),
  }),
  run(d, a) {
    const ch = must(d.channels[a.id], `Channel ${a.id} not found`);
    const { id: _id, poly, insertId, group, ...rest } = a;
    if (insertId !== undefined) ch.insertId = must(d.mixer.inserts[insertId], `Insert ${insertId} not found`).id;
    if (group !== undefined) {
      if (group) ch.group = group;
      else delete ch.group; // null / '' = back to automatic
    }
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (ch as any)[k] = v;
    if (poly) ch.poly = { ...ch.poly, ...Object.fromEntries(Object.entries(poly).filter(([, v]) => v !== undefined)) };
    return {};
  },
});

export const channelsSolo = defineCommand({
  id: 'channels.solo',
  label: () => 'Solo channel',
  description: 'FL-style solo: unmute this channel and mute every other one. Calling it again on a soloed channel unmutes all.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    must(d.channels[a.id], `Channel ${a.id} not found`);
    const others = d.channelOrder.filter((c) => c !== a.id);
    const alreadySolo = !d.channels[a.id].mute && others.every((c) => d.channels[c].mute);
    for (const c of d.channelOrder) d.channels[c].mute = alreadySolo ? false : c !== a.id;
    return { soloed: !alreadySolo };
  },
});

export const channelsSetGenerator = defineCommand({
  id: 'channels.setGenerator',
  label: () => 'Replace instrument',
  description: 'Swap the generator plugin of a channel (params reset to defaults; sample kept if the new plugin uses samples).',
  args: z.object({ id: z.string(), type: z.string(), params: z.record(z.string(), z.number()).optional() }),
  run(d, a, ctx) {
    const ch = must(d.channels[a.id], `Channel ${a.id} not found`);
    const desc = must(findPlugin(ctx.catalog, a.type), `Unknown instrument "${a.type}"`);
    if (desc.kind !== 'instrument') throw new CommandError(`${desc.name} is not an instrument`);
    ch.generator = { type: a.type, params: sanitizeParams(ctx.catalog, a.type, a.params ?? {}), sampleId: desc.usesSample ? ch.generator.sampleId : null };
    return {};
  },
});

export const channelsSetGenParams = defineCommand({
  id: 'channels.setGenParams',
  label: (a) => `Set ${plural(Object.keys(a.params).length, 'instrument param')}`,
  description: "Set generator plugin parameters (plain units per the plugin's ParamSpec; clamped). Use plugins.describe to list params.",
  args: z.object({ id: z.string(), params: z.record(z.string(), z.number()) }),
  run(d, a, ctx) {
    const ch = must(d.channels[a.id], `Channel ${a.id} not found`);
    keepAudioInPlace(d, ctx.catalog, a.id, () => Object.assign(ch.generator.params, sanitizeParams(ctx.catalog, ch.generator.type, a.params)));
    return {};
  },
});

export const channelsResetGenParams = defineCommand({
  id: 'channels.resetGenParams',
  label: () => 'Reset instrument',
  description: 'Reset generator params to defaults (all, or the listed ids).',
  args: z.object({ id: z.string(), params: z.array(z.string()).optional() }),
  run(d, a, ctx) {
    const ch = must(d.channels[a.id], `Channel ${a.id} not found`);
    keepAudioInPlace(d, ctx.catalog, a.id, () => {
      if (!a.params) {
        ch.generator.params = {};
        delete ch.generator.preset; // defaults are no longer that preset's sound
      } else for (const p of a.params) delete ch.generator.params[p];
    });
    return {};
  },
});

export const channelsSetSample = defineCommand({
  id: 'channels.setSample',
  label: () => 'Load sample',
  description: 'Point a sample-based channel (sampler / audio clip) at a sample from the project sample pool (samples.add first).',
  args: z.object({ id: z.string(), sampleId: z.string().nullable(), rename: z.boolean().default(false) }),
  run(d, a, ctx) {
    const ch = must(d.channels[a.id], `Channel ${a.id} not found`);
    const desc = findPlugin(ctx.catalog, ch.generator.type);
    if (desc && !desc.usesSample) throw new CommandError(`${desc.name} does not play samples`);
    if (a.sampleId) must(d.samples[a.sampleId], `Sample ${a.sampleId} not found`);
    // slice markers point into the old audio: a new sample starts as one slice
    if (ch.generator.type === SLICER_PLUGIN && ch.generator.sampleId !== a.sampleId) delete ch.generator.slices;
    ch.generator.sampleId = a.sampleId;
    if (a.rename && a.sampleId) ch.name = d.samples[a.sampleId].name;
    return {};
  },
});

export const channelsMove = defineCommand({
  id: 'channels.move',
  label: () => 'Reorder channels',
  description: 'Move a channel to a new position in the Channel Rack.',
  args: z.object({ id: z.string(), toIndex: z.number().int().min(0) }),
  run(d, a) {
    must(d.channels[a.id], `Channel ${a.id} not found`);
    const order = d.channelOrder.filter((c) => c !== a.id);
    order.splice(Math.min(a.toIndex, order.length), 0, a.id);
    d.channelOrder = order;
    return {};
  },
});

export const channelsClone = defineCommand({
  id: 'channels.clone',
  label: () => 'Clone channel',
  description: 'Duplicate a channel (settings and generator; optionally its notes in every pattern). Returns the new id.',
  args: z.object({ id: z.string(), withNotes: z.boolean().default(false) }),
  run(d, a, ctx) {
    const src = must(d.channels[a.id], `Channel ${a.id} not found`);
    const id = ctx.newId(ID_PREFIX.channel);
    // JSON copy: structuredClone throws on Immer drafts (proxies).
    d.channels[id] = { ...(JSON.parse(JSON.stringify(src)) as Channel), id, name: `${src.name} #2` };
    d.channelOrder.splice(d.channelOrder.indexOf(a.id) + 1, 0, id);
    if (a.withNotes) {
      for (const p of Object.values(d.patterns)) {
        const notes = p.notes[a.id];
        if (!notes) continue;
        p.notes[id] = {};
        for (const n of Object.values(notes)) {
          const nid = ctx.newId(ID_PREFIX.note);
          p.notes[id][nid] = { ...n, id: nid };
        }
      }
    }
    return { id };
  },
});

export const CHANNEL_COMMANDS = [
  channelsAdd,
  channelsRemove,
  channelsSet,
  channelsSolo,
  channelsSetGenerator,
  channelsSetGenParams,
  channelsResetGenParams,
  channelsSetSample,
  channelsMove,
  channelsClone,
];
