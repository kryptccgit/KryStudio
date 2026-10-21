// Applying presets (shared/sounds). The preset OBJECT travels in the args
// (commands do no I/O): the renderer / MCP tools look it up (factory data or
// the main-process sounds service) and pass it in. One command = one undo step
// ("Load preset Anthem Supersaw").
//
// CONTRACT (implementation: sounds-core):
//  - presets.applyToChannel: generator type + params REPLACED by the preset's
//    (sanitised against the catalog; unknown param = CommandError naming it),
//    generator.preset = {id, name}; sample preset → the sample is added to the
//    pool (reusing an existing SampleRef with the same path) and set;
//    channel settings applied (volumeDb → linear volume, mono/glide/rootKey/
//    cut groups). withFx (default true) and preset.fx present → the channel's
//    insert chain is REPLACED by the preset chain; when that insert is master
//    or shared with other channels, the channel first gets its own new insert
//    (named after the channel). rename = true → channel name = preset name.
//    Returns { channelId, insertId }.
//  - presets.addChannel: a new channel (+ its own insert) with the preset, at
//    `index` (default end), named `name` ?? preset name. Returns the same.
//  - presets.applyChain: replace (default) or append the insert's FX slots with
//    the chain; insert settings applied; insertId may be 'master'. Returns
//    { insertId, slotIds }.
//
// Details beyond the contract:
//  - mono / glide belong to the sound: a preset that doesn't set them gets the
//    plugin's defaults (an 808 is mono + 60 ms glide, everything else poly), so
//    a pad loaded onto a former 808 channel plays chords again. rootKey, cut
//    groups, volume and pan are kept unless the preset sets them (they are
//    tied to the notes already written and to the mix).
//  - a shared insert the channel leaves keeps its routing: the channel's new
//    insert feeds it (a drum bus stays in the path), the master gets fed
//    directly.
//  - removed FX slots null the automation clips that targeted them (same as
//    mixer.removeSlot).

import { z } from 'zod';
import { defineCommand, must, plural, CommandError } from './types';
import { DEFAULT_CHANNEL_VOLUME, MAX_FX_SLOTS, MAX_INSERTS, paletteColor, type Channel, type MixerInsert, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { findPlugin } from '../schema/params';
import type { CommandContext } from './types';
import { sanitizeParams } from './channels';
import { zChainPreset, zInstrumentPreset } from '../sounds/schema';
import type { InstrumentPreset, PresetFx, PresetRack } from '../sounds/types';
import { FX_RACK_PLUGIN, emptyRack } from '../schema/rack';
import { rackFromSpec, rackKindOf } from './racks';

const AUDIOCLIP = 'krypt.audioclip';
const KICK808 = 'krypt.kick808';

const dbToGain = (db: number): number => Math.pow(10, db / 20);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A new mixer insert routed to `routeTo` (default master). */
function addInsert(d: Project, name: string, color: string, ctx: CommandContext, routeTo?: string): string {
  if (d.mixer.insertOrder.length >= MAX_INSERTS) throw new CommandError(`The mixer is full (${MAX_INSERTS} inserts). Delete an unused insert first, or load the preset without its effects.`);
  const id = ctx.newId(ID_PREFIX.insert);
  const ins: MixerInsert = {
    id,
    name: name.slice(0, 64),
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
    routes: { [routeTo ?? d.mixer.masterId]: 1 },
    isMaster: false,
  };
  d.mixer.inserts[id] = ins;
  d.mixer.insertOrder.push(id);
  return id;
}

/** Validate a whole chain before touching the document: unknown effects / params name the preset. */
function checkChain(fx: readonly PresetFx[], presetName: string, ctx: CommandContext): Array<{ type: string; params: Record<string, number>; mix: number; enabled: boolean; rack?: PresetRack }> {
  return fx.map((f) => {
    // Effect racks (Wave 12.2): a 'krypt.fxrack' slot carries its chains + macros; rackFromSpec validates them.
    if (f.rack && f.type !== FX_RACK_PLUGIN) throw new CommandError(`Preset "${presetName}": only an effect rack (${FX_RACK_PLUGIN}) can carry a rack, not "${f.type}"`);
    if (f.rack && f.rack.kind !== 'effect') throw new CommandError(`Preset "${presetName}": a mixer slot takes an effect rack, not an ${f.rack.kind} rack`);
    const desc = findPlugin(ctx.catalog, f.type);
    if (!desc) throw new CommandError(`Preset "${presetName}" uses an effect this build doesn't have: "${f.type}"`);
    if (desc.kind !== 'effect') throw new CommandError(`Preset "${presetName}" lists ${desc.name} as an effect, but it is an instrument`);
    let params: Record<string, number>;
    try {
      params = sanitizeParams(ctx.catalog, f.type, f.params ?? {});
    } catch (e) {
      throw new CommandError(`Preset "${presetName}": ${(e as Error).message}`);
    }
    return { type: f.type, params, mix: clamp(f.mix ?? desc.defaultMix ?? 1, 0, 1), enabled: f.enabled ?? true, ...(f.rack ? { rack: f.rack } : {}) };
  });
}

/** Remove every FX slot of an insert (automation clips aimed at them become unassigned). */
function clearSlots(d: Project, ins: MixerInsert): void {
  for (const sid of ins.slotOrder) {
    for (const aut of Object.values(d.automations)) if (aut.target?.startsWith(`insert/${ins.id}/slot/${sid}/`)) aut.target = null;
  }
  ins.slots = {};
  ins.slotOrder = [];
}

const sameParams = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** The insert already holds exactly this chain (effects, params, mix, bypass): reloading keeps its slots (a no-op). */
function sameChain(ins: MixerInsert, chain: ReturnType<typeof checkChain>): boolean {
  if (ins.slotOrder.length !== chain.length) return false;
  if (chain.some((f) => f.rack) || ins.slotOrder.some((sid) => ins.slots[sid]?.rack)) return false; // racks always reload
  return ins.slotOrder.every((sid, i) => {
    const s = ins.slots[sid];
    const f = chain[i];
    return !!s && s.type === f.type && s.enabled === f.enabled && Math.abs(s.mix - f.mix) < 1e-9 && sameParams(s.params, f.params);
  });
}

/** Replace an insert's effects with `chain` (kept as they are when identical). */
function replaceSlots(d: Project, ins: MixerInsert, chain: ReturnType<typeof checkChain>, ctx: CommandContext, presetName?: string): string[] {
  if (sameChain(ins, chain)) return [...ins.slotOrder];
  clearSlots(d, ins);
  return addSlots(d, ins, chain, ctx, presetName);
}

function addSlots(d: Project, ins: MixerInsert, chain: ReturnType<typeof checkChain>, ctx: CommandContext, presetName = 'The chain'): string[] {
  const ids: string[] = [];
  for (const f of chain) {
    const id = ctx.newId(ID_PREFIX.slot);
    ins.slots[id] = { id, type: f.type, enabled: f.enabled, mix: f.mix, params: f.params, sidechainFrom: null };
    if (f.type === FX_RACK_PLUGIN) ins.slots[id].rack = f.rack ? rackFromSpec(d, ctx.catalog, f.rack, ctx, `Preset "${presetName}" effect rack`) : emptyRack('effect');
    ins.slotOrder.push(id);
    ids.push(id);
  }
  return ids;
}

/** The sample pool entry for `path`: an existing SampleRef with that path, else a new one. */
function sampleFor(d: Project, path: string, ctx: CommandContext): string {
  const existing = Object.values(d.samples).find((s) => s.path === path);
  if (existing) return existing.id;
  const id = ctx.newId(ID_PREFIX.sample);
  const base = path.split(/[\\/:]/).pop() || 'Sample';
  d.samples[id] = { id, name: base.replace(/\.[a-z0-9]+$/i, ''), path };
  return id;
}

/** Everything about the preset that can fail, checked before the first write. */
function checkInstrumentPreset(preset: InstrumentPreset, ctx: CommandContext) {
  const desc = findPlugin(ctx.catalog, preset.plugin);
  if (!desc) throw new CommandError(`Preset "${preset.name}" needs the instrument "${preset.plugin}", which this build doesn't have`);
  if (desc.kind !== 'instrument') throw new CommandError(`Preset "${preset.name}" names ${desc.name}, which is an effect, not an instrument`);
  if (desc.id === AUDIOCLIP) throw new CommandError(`Preset "${preset.name}" can't use the Audio Clip player; presets are for instruments`);
  if (preset.sample && !desc.usesSample) throw new CommandError(`Preset "${preset.name}" has a sample, but ${desc.name} doesn't play samples`);
  const rackKind = rackKindOf(desc.id);
  if (preset.rack && !rackKind) throw new CommandError(`Preset "${preset.name}" carries a rack, but ${desc.name} isn't a rack`);
  if (preset.rack && rackKind && preset.rack.kind !== rackKind) throw new CommandError(`Preset "${preset.name}" is a ${desc.name} with an ${preset.rack.kind} rack inside`);
  let params: Record<string, number>;
  try {
    params = sanitizeParams(ctx.catalog, preset.plugin, preset.params);
  } catch (e) {
    throw new CommandError(`Preset "${preset.name}": ${(e as Error).message}`);
  }
  return { desc, params };
}

interface Applied {
  channelId: string;
  insertId: string;
  /** The channel moved off a shared / master insert onto its own new one. */
  splitFrom?: string;
  slotIds: string[];
}

function applyPreset(d: Project, ch: Channel, preset: InstrumentPreset, withFx: boolean, ctx: CommandContext): Applied {
  if (ch.generator.type === AUDIOCLIP) throw new CommandError(`"${ch.name}" plays an audio clip; load presets onto instrument channels`);
  const { desc, params } = checkInstrumentPreset(preset, ctx);
  const chain = withFx && preset.fx ? checkChain(preset.fx, preset.name, ctx) : null;
  if (chain && chain.length > MAX_FX_SLOTS) throw new CommandError(`Preset "${preset.name}" has ${chain.length} effects; an insert holds at most ${MAX_FX_SLOTS}`);

  // Instrument + params (replaced, never merged) + sample.
  let sampleId: string | null = null;
  if (preset.sample) sampleId = sampleFor(d, preset.sample, ctx);
  else if (desc.usesSample) sampleId = ch.generator.sampleId; // a sampler preset without its own sample keeps the loaded one
  const g = ch.generator;
  const label = { id: preset.id, name: preset.name.slice(0, 64) };
  if (rackKindOf(preset.plugin)) {
    // Racks (Wave 12.2): the chains, inner samples and macro maps come from the preset; always written fresh.
    const rack = preset.rack ? rackFromSpec(d, ctx.catalog, preset.rack, ctx, `Preset "${preset.name}"`) : emptyRack(rackKindOf(preset.plugin)!);
    ch.generator = { type: preset.plugin, params, sampleId: null, preset: label, rack };
  } else if (g.type !== preset.plugin || !sameParams(g.params, params) || g.sampleId !== sampleId || g.preset?.id !== label.id || g.preset?.name !== label.name || g.state !== undefined) {
    ch.generator = { type: preset.plugin, params, sampleId, preset: label };
  }

  // Channel settings.
  const c = preset.channel ?? {};
  const is808 = preset.plugin === KICK808;
  if (c.volumeDb !== undefined) ch.volume = clamp(dbToGain(c.volumeDb), 0, 1.25);
  if (c.pan !== undefined) ch.pan = clamp(c.pan, -1, 1);
  if (c.rootKey !== undefined) ch.rootKey = c.rootKey;
  ch.poly.mono = c.mono ?? is808;
  ch.poly.glideMs = c.glideMs ?? (is808 ? 60 : 0);
  if (c.cutGroup !== undefined) ch.poly.cutGroup = c.cutGroup;
  if (c.cutBy !== undefined) ch.poly.cutBy = c.cutBy;

  // Effects: the channel's own insert gets the preset chain.
  let insertId = ch.insertId;
  let splitFrom: string | undefined;
  let slotIds: string[] = [];
  if (chain) {
    const cur = d.mixer.inserts[insertId];
    const shared = !cur || cur.isMaster || d.channelOrder.some((id) => id !== ch.id && d.channels[id]?.insertId === insertId);
    if (shared && chain.length === 0) return { channelId: ch.id, insertId, slotIds }; // nothing to put on an own insert
    if (shared) {
      splitFrom = cur?.id;
      insertId = addInsert(d, ch.name, ch.color, ctx, cur && !cur.isMaster ? cur.id : undefined);
      ch.insertId = insertId;
    }
    slotIds = replaceSlots(d, d.mixer.inserts[insertId], chain, ctx, preset.name);
  }
  return { channelId: ch.id, insertId, splitFrom, slotIds };
}

export const presetsApplyToChannel = defineCommand({
  id: 'presets.applyToChannel',
  label: (a) => `Load preset ${a.preset.name}`,
  description: "Load an instrument preset onto a channel: replaces the instrument, its params, sample and (withFx) the insert's effect chain.",
  args: z.object({ channelId: z.string(), preset: zInstrumentPreset, withFx: z.boolean().default(true), rename: z.boolean().default(false) }),
  run(d, a, ctx) {
    const ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
    const r = applyPreset(d, ch, a.preset, a.withFx, ctx);
    if (a.rename) ch.name = a.preset.name.slice(0, 64);
    return { channelId: r.channelId, insertId: r.insertId, splitFrom: r.splitFrom, slotIds: r.slotIds };
  },
});

export const presetsAddChannel = defineCommand({
  id: 'presets.addChannel',
  label: (a) => `Add ${a.name ?? a.preset.name}`,
  description: 'Add a channel (with its own mixer insert) playing an instrument preset.',
  args: z.object({ preset: zInstrumentPreset, name: z.string().min(1).max(64).optional(), index: z.number().int().min(0).optional(), withFx: z.boolean().default(true) }),
  run(d, a, ctx) {
    checkInstrumentPreset(a.preset, ctx); // fail before creating anything
    const name = (a.name ?? a.preset.name).slice(0, 64);
    const color = paletteColor(d.channelOrder.length);
    const insertId = addInsert(d, name, color, ctx);
    const id = ctx.newId(ID_PREFIX.channel);
    const is808 = a.preset.plugin === KICK808;
    const ch: Channel = {
      id,
      name,
      color,
      generator: { type: a.preset.plugin, params: {}, sampleId: null },
      volume: DEFAULT_CHANNEL_VOLUME,
      pan: 0,
      pitch: 0,
      mute: false,
      insertId,
      rootKey: is808 ? 36 : 60, // 808s play true pitch; steps land on C2
      swing: 1,
      poly: { mono: is808, glideMs: is808 ? 60 : 0, cutGroup: 0, cutBy: 0 },
    };
    d.channels[id] = ch;
    d.channelOrder.splice(Math.min(a.index ?? d.channelOrder.length, d.channelOrder.length), 0, id);
    const r = applyPreset(d, d.channels[id], a.preset, a.withFx, ctx);
    return { channelId: id, insertId: r.insertId, slotIds: r.slotIds };
  },
});

export const presetsApplyChain = defineCommand({
  id: 'presets.applyChain',
  label: (a) => `Load chain ${a.preset.name}`,
  description: "Load an effect-chain preset onto a mixer insert ('master' for the master): replaces (or appends to) its effects.",
  args: z.object({ insertId: z.string(), preset: zChainPreset, mode: z.enum(['replace', 'append']).default('replace') }),
  run(d, a, ctx) {
    const insertId = a.insertId === 'master' ? d.mixer.masterId : a.insertId;
    const ins = must(d.mixer.inserts[insertId], `Insert ${a.insertId} not found`);
    const chain = checkChain(a.preset.fx, a.preset.name, ctx);
    const total = (a.mode === 'append' ? ins.slotOrder.length : 0) + chain.length;
    if (total > MAX_FX_SLOTS) {
      throw new CommandError(
        a.mode === 'append'
          ? `${ins.isMaster ? 'The master' : `"${ins.name}"`} already has ${plural(ins.slotOrder.length, 'effect')}; adding ${chain.length} more would pass the ${MAX_FX_SLOTS}-effect limit. Use replace instead.`
          : `Chain "${a.preset.name}" has ${chain.length} effects; an insert holds at most ${MAX_FX_SLOTS}`,
      );
    }
    const slotIds = a.mode === 'replace' ? replaceSlots(d, ins, chain, ctx, a.preset.name) : addSlots(d, ins, chain, ctx, a.preset.name);
    const s = a.preset.insert;
    if (s?.volumeDb !== undefined) ins.volume = clamp(dbToGain(s.volumeDb), 0, 2);
    if (s?.pan !== undefined) ins.pan = clamp(s.pan, -1, 1);
    if (s?.stereoSep !== undefined) ins.stereoSep = clamp(s.stereoSep, -1, 1);
    return { insertId, slotIds };
  },
});

/**
 * Which preset a channel's sound came from, e.g. right after the sound was saved as a user preset (the preset bar
 * then shows the saved name). The sound itself doesn't change, so this is not an undo step of its own.
 */
export const presetsMarkChannel = defineCommand({
  id: 'presets.markChannel',
  label: (a) => (a.preset ? `Name sound ${a.preset.name}` : 'Clear preset name'),
  description: "Set (or clear, with null) the preset a channel's sound is labelled with (generator.preset). Params, sample and effects are unchanged.",
  args: z.object({ channelId: z.string(), preset: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(64) }).nullable() }),
  history: false,
  run(d, a) {
    const ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
    if (a.preset) ch.generator.preset = { id: a.preset.id, name: a.preset.name };
    else delete ch.generator.preset;
    return {};
  },
});

export const PRESET_COMMANDS = [presetsApplyToChannel, presetsAddChannel, presetsApplyChain, presetsMarkChannel];
