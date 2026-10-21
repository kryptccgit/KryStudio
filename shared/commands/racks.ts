// ──────────────────────────────────────────────────────────────────────
// Device racks, macros, the drum rack and the slicer (Wave 12.2,
// research/16-ableton-parity.md §2.3; data: shared/schema/rack.ts).
// Command ids `rack.*` (the Channel Rack step tools in ./rack.ts use
// `notes.*`, so the namespace is free).
//
// A rack lives on a channel generator ('krypt.rack' / 'krypt.drumrack',
// `Generator.rack`) or on a mixer slot ('krypt.fxrack', `FxSlot.rack`).
// Every command addresses it with { channelId } or { insertId, slotId }.
// A rack plugin without a `rack` object (a channel just created with
// channels.add type 'krypt.rack') is treated as an empty rack.
//
// Macro VALUES are the rack's own params macro1..8, set through the normal
// ParamRef path (`channel/<ch>/gen/macroN`, `insert/<i>/slot/<s>/macroN`:
// params.set, automation, controller links). Inner device params are edited
// with rack.setInstrumentParams / rack.setDeviceParams (no inner ParamRef
// scope in v1: automate a macro mapped onto the inner param instead).
//
// v1 limits enforced here: stock plugins only (no VST3 / CLAP, no audio
// clip player), no racks inside racks, ≤ MAX_RACK_CHAINS chains, ≤
// MAX_FX_SLOTS devices per chain. Params are clamped to the catalog specs.
// Pure: no I/O; the slicer gets its slice times from main (analyzer onsets,
// a grid or the caller) and the randomizer its seed from the caller.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { defineCommand, must, plural, CommandError, type CommandContext, type CommandDef } from './types';
import { DEFAULT_CHANNEL_VOLUME, MAX_FX_SLOTS, MAX_INSERTS, defaultNote, paletteColor, type Channel, type FxSlot, type Generator, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { findPlugin } from '../schema/params';
import { clampToSpec, type PluginCatalog, type PluginDescriptor } from '../plugins/types';
import { PPQ, TICKS_PER_STEP } from '../schema/time';
import {
  DRUM_RACK_BASE_NOTE,
  DRUM_RACK_PLUGIN,
  FX_RACK_PLUGIN,
  MACRO_COUNT,
  MACRO_PARAM_IDS,
  MAX_RACK_CHAINS,
  RACK_PLUGIN,
  emptyRack,
  isRackPlugin,
  type MacroTarget,
  type RackChain,
  type RackDef,
  type RackKind,
  type RackZone,
} from '../schema/rack';
import { sanitizeParams } from './channels';
import { SLICER_PLUGIN } from '../schema/slicer';
import type { PresetRack } from '../sounds/types';
import { zPresetRack } from '../sounds/schema';

// ── Constants / small helpers ─────────────────────────────────────────

export const RACK_ID_PREFIX = { chain: 'chn', map: 'mmap', variation: 'var' } as const;
/** Most slices one slice_to_pads call makes (each is a pad + a chain). */
export const MAX_SLICES = 64;
export const MAX_VARIATIONS = 64;
const AUDIOCLIP = 'krypt.audioclip';
const SAMPLER = 'krypt.sampler';

export const RACK_PLUGIN_FOR: Record<RackKind, string> = { instrument: RACK_PLUGIN, drum: DRUM_RACK_PLUGIN, effect: FX_RACK_PLUGIN };

export function rackKindOf(type: string): RackKind | null {
  return type === RACK_PLUGIN ? 'instrument' : type === DRUM_RACK_PLUGIN ? 'drum' : type === FX_RACK_PLUGIN ? 'effect' : null;
}

const RACK_NAME: Record<RackKind, string> = { instrument: 'instrument rack', drum: 'drum rack', effect: 'effect rack' };

function isThirdParty(type: string): boolean {
  return type.startsWith('vst3:') || type.startsWith('clap:');
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** MIDI note name with C4 = 60 (the app's convention). */
export function midiNoteName(n: number): string {
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

const shortName = (desc: PluginDescriptor | undefined, fallback: string): string => (desc ? desc.name.replace(/^Krypt /, '') : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** JSON copy (structuredClone throws on Immer drafts). */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Deterministic PRNG (mulberry32) for rack.randomizeMacros. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The sample pool entry for `path`: an existing SampleRef with that path, else a new one. */
export function samplePoolId(d: Project, path: string, ctx: CommandContext): string {
  const existing = Object.values(d.samples).find((s) => s.path === path);
  if (existing) return existing.id;
  const id = ctx.newId(ID_PREFIX.sample);
  const base = path.split(/[\\/:]/).pop() || 'Sample';
  d.samples[id] = { id, name: base.replace(/\.[a-z0-9]+$/i, ''), path };
  return id;
}

// ── Finding a rack ────────────────────────────────────────────────────

const targetShape = {
  channelId: z.string().optional().describe('The channel holding an instrument / drum rack.'),
  insertId: z.string().optional().describe('With slotId: the mixer slot holding an effect rack.'),
  slotId: z.string().optional(),
};

export interface RackHost {
  rack: RackDef;
  /** The rack device's own params (macro1..8 live here). */
  params: Record<string, number>;
  type: string;
  /** "Keys" / "Insert 3 slot 2" for messages. */
  where: string;
  /** ParamRef prefix of the rack device (`channel/<ch>/gen/` or `insert/<i>/slot/<s>/`). */
  refPrefix: string;
}

/** The rack at { channelId } or { insertId, slotId }; a rack plugin without a rack object gets an empty one. */
export function rackHost(d: Project, a: { channelId?: string; insertId?: string; slotId?: string }, catalog?: PluginCatalog): RackHost {
  if (a.channelId) {
    const ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
    const g = ch.generator;
    const kind = rackKindOf(g.type);
    if (!kind || kind === 'effect') {
      const name = catalog ? shortName(findPlugin(catalog, g.type), g.type) : g.type;
      throw new CommandError(`"${ch.name}" doesn't hold a rack (it plays ${name}). Wrap it in a rack first (rack.create).`);
    }
    if (!g.rack || g.rack.kind !== kind) g.rack = emptyRack(kind);
    return { rack: g.rack, params: g.params, type: g.type, where: `"${ch.name}"`, refPrefix: `channel/${ch.id}/gen/` };
  }
  if (a.insertId && a.slotId) {
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    const slot = must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
    if (slot.type !== FX_RACK_PLUGIN) throw new CommandError(`That mixer slot holds ${catalog ? shortName(findPlugin(catalog, slot.type), slot.type) : slot.type}, not an effect rack. Wrap it in a rack first (rack.create).`);
    if (!slot.rack || slot.rack.kind !== 'effect') slot.rack = emptyRack('effect');
    const where = `${ins.isMaster ? 'the master' : `"${ins.name}"`} slot ${ins.slotOrder.indexOf(slot.id) + 1}`;
    return { rack: slot.rack, params: slot.params, type: slot.type, where, refPrefix: `insert/${ins.id}/slot/${slot.id}/` };
  }
  throw new CommandError('Say which rack: a channelId, or an insertId with a slotId');
}

function chainOf(host: RackHost, chainId: string): RackChain {
  return must(host.rack.chains[chainId], `Chain ${chainId} isn't in the rack on ${host.where}`);
}

// ── Validation ────────────────────────────────────────────────────────

/** A stock instrument a rack chain may hold (v1). */
export function checkRackInstrument(catalog: PluginCatalog, type: string, kind: RackKind, where = 'A rack chain'): PluginDescriptor {
  if (kind === 'effect') throw new CommandError("An effect rack has no instruments: its chains process the insert's audio. Add effects to the chain instead.");
  if (isRackPlugin(type)) throw new CommandError('Racks inside racks are not supported yet: put the instrument itself in the chain');
  if (isThirdParty(type)) throw new CommandError(`${where} can only hold Krypt Studio's stock instruments for now (third-party plugins can't go in racks yet)`);
  if (type === AUDIOCLIP) throw new CommandError("The Audio Clip player can't go in a rack: use the Sampler (or Slice to pads)");
  if (type === SLICER_PLUGIN) throw new CommandError("The Slicer can't go in a rack yet (its slice markers live on its channel): use Slice to pads for a drum rack of slices");
  const desc = must(findPlugin(catalog, type), `Unknown instrument "${type}"`);
  if (desc.kind !== 'instrument') throw new CommandError(`${desc.name} is an effect, not an instrument`);
  return desc;
}

/** A stock effect a rack chain may hold (v1). */
export function checkRackEffect(catalog: PluginCatalog, type: string, where = 'A rack chain'): PluginDescriptor {
  if (isRackPlugin(type)) throw new CommandError('Racks inside racks are not supported yet: add the effects to the chain itself');
  if (isThirdParty(type)) throw new CommandError(`${where} can only hold Krypt Studio's stock effects for now (third-party plugins can't go in racks yet)`);
  const desc = must(findPlugin(catalog, type), `Unknown effect "${type}"`);
  if (desc.kind !== 'effect') throw new CommandError(`${desc.name} is an instrument, not an effect`);
  return desc;
}

function checkZone(z0: RackZone): RackZone {
  if (z0.keyLo > z0.keyHi) throw new CommandError(`The key zone starts above its end (${midiNoteName(z0.keyLo)} > ${midiNoteName(z0.keyHi)})`);
  if (z0.velLo > z0.velHi) throw new CommandError(`The velocity zone starts above its end (${z0.velLo} > ${z0.velHi})`);
  return { keyLo: z0.keyLo, keyHi: z0.keyHi, velLo: z0.velLo, velHi: z0.velHi };
}

/** The macro target exists and names a real param; returns its display name. */
function checkTarget(rack: RackDef, t: MacroTarget, catalog: PluginCatalog): string {
  const chain = must(rack.chains[t.chainId], `Chain ${t.chainId} isn't in this rack`);
  if (t.kind === 'chain') return `${chain.name} ${t.param}`;
  if (t.kind === 'instrument') {
    const inst = must(chain.instrument, `Chain "${chain.name}" has no instrument to map`);
    const desc = must(findPlugin(catalog, inst.type), `Unknown instrument "${inst.type}"`);
    const spec = must(desc.params.find((p) => p.id === t.param), `${desc.name} has no parameter "${t.param}"`);
    return `${chain.name} ${spec.name}`;
  }
  const dev = must(chain.devices[t.deviceId], `Device ${t.deviceId} isn't in chain "${chain.name}"`);
  const desc = must(findPlugin(catalog, dev.type), `Unknown effect "${dev.type}"`);
  if (t.param === 'mix') return `${chain.name} ${shortName(desc, dev.type)} mix`;
  const spec = must(desc.params.find((p) => p.id === t.param), `${desc.name} has no parameter "${t.param}"`);
  return `${chain.name} ${shortName(desc, dev.type)} ${spec.name}`;
}

const sameTarget = (a: MacroTarget, b: MacroTarget): boolean =>
  a.chainId === b.chainId && a.kind === b.kind && a.param === b.param && (a.kind !== 'device' || (b.kind === 'device' && a.deviceId === b.deviceId));

/** Remove the macro maps matching `drop`; returns how many went. */
function pruneMaps(rack: RackDef, drop: (t: MacroTarget) => boolean): number {
  let n = 0;
  for (const m of rack.macros) {
    for (const [id, map] of Object.entries(m.maps)) {
      if (drop(map.target)) {
        delete m.maps[id];
        n++;
      }
    }
  }
  return n;
}

// ── Building chains ───────────────────────────────────────────────────

export interface ChainInput {
  name?: string;
  color?: string | null;
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  zone?: RackZone | null;
  choke?: number;
  instrument?: { type: string; params?: Record<string, number>; sampleId?: string | null; samplePath?: string };
  devices?: Array<{ type: string; params?: Record<string, number>; mix?: number; enabled?: boolean }>;
}

/** A sampler pad plays its slice at the recorded pitch whatever its note (drum racks). */
const PAD_SAMPLER_DEFAULTS: Record<string, number> = { keyTrack: 0, oneShot: 1 };

/** Next free pad note of a drum rack (from `base`), or null when every note up to 127 is taken. */
export function nextPadNote(rack: RackDef, base = DRUM_RACK_BASE_NOTE): number | null {
  const used = new Set(Object.values(rack.chains).map((c) => c.zone?.keyLo).filter((n): n is number => n !== undefined));
  for (let n = base; n <= 127; n++) if (!used.has(n)) return n;
  return null;
}

/** The drum-rack pad on `note` (its zone is exactly that key). */
export function padChain(rack: RackDef, note: number): RackChain | undefined {
  return rack.chainOrder.map((id) => rack.chains[id]).find((c) => c?.zone && c.zone.keyLo === note && c.zone.keyHi === note);
}

function makeDevice(catalog: PluginCatalog, dv: NonNullable<ChainInput['devices']>[number], ctx: CommandContext, where: string): FxSlot {
  const desc = checkRackEffect(catalog, dv.type, where);
  let params: Record<string, number>;
  try {
    params = sanitizeParams(catalog, dv.type, dv.params ?? {});
  } catch (e) {
    throw new CommandError(`${where}: ${(e as Error).message}`);
  }
  const id = ctx.newId(ID_PREFIX.slot);
  return { id, type: dv.type, enabled: dv.enabled ?? true, mix: clamp(dv.mix ?? desc.defaultMix ?? 1, 0, 1), params, sidechainFrom: null };
}

function makeInstrument(d: Project, catalog: PluginCatalog, kind: RackKind, inst: NonNullable<ChainInput['instrument']>, ctx: CommandContext, where: string): Generator {
  const desc = checkRackInstrument(catalog, inst.type, kind, where);
  let params: Record<string, number>;
  try {
    params = sanitizeParams(catalog, inst.type, inst.params ?? {});
  } catch (e) {
    throw new CommandError(`${where}: ${(e as Error).message}`);
  }
  let sampleId: string | null = null;
  if (inst.samplePath) sampleId = samplePoolId(d, inst.samplePath, ctx);
  else if (inst.sampleId) sampleId = must(d.samples[inst.sampleId], `Sample ${inst.sampleId} not found`).id;
  if (sampleId && !desc.usesSample) throw new CommandError(`${where}: ${desc.name} doesn't play samples`);
  return { type: inst.type, params, sampleId };
}

/** Build one chain (validated, params clamped, samples pooled). Not inserted. */
export function makeChain(d: Project, catalog: PluginCatalog, rack: RackDef, input: ChainInput, ctx: CommandContext, where = 'A rack chain'): RackChain {
  const devices = input.devices ?? [];
  if (devices.length > MAX_FX_SLOTS) throw new CommandError(`${where} has ${devices.length} devices; a chain holds at most ${MAX_FX_SLOTS}`);
  if (input.instrument && rack.kind === 'effect') checkRackInstrument(catalog, input.instrument.type, 'effect');
  const instrument = input.instrument ? makeInstrument(d, catalog, rack.kind, input.instrument, ctx, where) : undefined;
  const id = ctx.newId(RACK_ID_PREFIX.chain);
  const chain: RackChain = {
    id,
    name: '',
    color: input.color ?? null,
    volume: clamp(input.volume ?? 1, 0, 2),
    pan: clamp(input.pan ?? 0, -1, 1),
    mute: input.mute ?? false,
    solo: input.solo ?? false,
    devices: {},
    deviceOrder: [],
  };
  if (instrument) chain.instrument = instrument;
  for (const dv of devices) {
    const dev = makeDevice(catalog, dv, ctx, where);
    chain.devices[dev.id] = dev;
    chain.deviceOrder.push(dev.id);
  }
  if (rack.kind === 'drum') {
    let zone = input.zone ?? null;
    if (!zone) {
      const note = nextPadNote(rack);
      if (note === null) throw new CommandError('Every pad note up to G9 is taken in this drum rack');
      zone = { keyLo: note, keyHi: note, velLo: 0, velHi: 1 };
    }
    chain.zone = checkZone(zone);
    chain.choke = input.choke ?? 0;
  } else if (rack.kind === 'instrument') {
    if (input.zone) chain.zone = checkZone(input.zone);
    if (input.choke) throw new CommandError('Choke groups are for drum-rack pads');
  } else {
    if (input.zone) throw new CommandError("An effect rack's chains all get the whole input: they have no key zones");
    if (input.choke) throw new CommandError('Choke groups are for drum-rack pads');
  }
  const n = rack.chainOrder.length + 1;
  const instName = instrument ? shortName(findPlugin(catalog, instrument.type), instrument.type) : null;
  chain.name = (input.name?.trim() || (rack.kind === 'drum' && chain.zone ? `Pad ${midiNoteName(chain.zone.keyLo)}` : instName ?? `Chain ${n}`)).slice(0, 64);
  return chain;
}

function insertChain(rack: RackDef, chain: RackChain, index?: number): void {
  if (rack.chainOrder.length >= MAX_RACK_CHAINS) throw new CommandError(`A rack holds at most ${MAX_RACK_CHAINS} chains`);
  if (rack.kind === 'drum' && chain.zone) {
    const clash = padChain(rack, chain.zone.keyLo);
    if (clash && chain.zone.keyLo === chain.zone.keyHi) throw new CommandError(`Pad ${midiNoteName(chain.zone.keyLo)} already has a chain ("${clash.name}")`);
  }
  rack.chains[chain.id] = chain;
  rack.chainOrder.splice(Math.min(index ?? rack.chainOrder.length, rack.chainOrder.length), 0, chain.id);
}

// ── Spec (presets / build_rack) → RackDef ─────────────────────────────

/**
 * Build a RackDef from an id-free spec (presets, build_rack). Validates everything (stock plugins, limits, params,
 * macro targets) and pools inner samples by path. Throws CommandError naming `label` on any problem.
 */
export function rackFromSpec(d: Project, catalog: PluginCatalog, spec: PresetRack, ctx: CommandContext, label = 'The rack'): RackDef {
  const rack = emptyRack(spec.kind);
  if (spec.chains.length > MAX_RACK_CHAINS) throw new CommandError(`${label} has ${spec.chains.length} chains; a rack holds at most ${MAX_RACK_CHAINS}`);
  const ids: string[] = [];
  spec.chains.forEach((c, i) => {
    const where = `${label}, chain ${i + 1} ("${c.name}")`;
    for (const f of c.fx ?? []) if ((f as { rack?: unknown }).rack) throw new CommandError(`${where}: racks inside racks are not supported yet`);
    const chain = makeChain(
      d,
      catalog,
      rack,
      {
        name: c.name,
        color: c.color ?? null,
        volume: c.volume,
        pan: c.pan,
        mute: c.mute,
        solo: c.solo,
        zone: c.zone,
        choke: c.choke,
        instrument: c.instrument ? { type: c.instrument.plugin, params: c.instrument.params, samplePath: c.instrument.sample } : undefined,
        devices: (c.fx ?? []).map((f) => ({ type: f.type, params: f.params, mix: f.mix, enabled: f.enabled })),
      },
      ctx,
      where,
    );
    insertChain(rack, chain);
    ids.push(chain.id);
  });
  (spec.macros ?? []).slice(0, MACRO_COUNT).forEach((m, mi) => {
    if (m.name?.trim()) rack.macros[mi].name = m.name.trim().slice(0, 32);
    for (const map of m.maps ?? []) {
      const chainId = ids[map.chain];
      if (!chainId) throw new CommandError(`${label}: macro ${mi + 1} maps chain ${map.chain + 1}, which doesn't exist`);
      let target: MacroTarget;
      if (map.target === 'device') {
        const chain = rack.chains[chainId];
        const deviceId = map.device !== undefined ? chain.deviceOrder[map.device] : undefined;
        if (!deviceId) throw new CommandError(`${label}: macro ${mi + 1} maps device ${(map.device ?? -1) + 1} of chain ${map.chain + 1}, which doesn't exist`);
        target = { chainId, kind: 'device', deviceId, param: map.param };
      } else if (map.target === 'chain') {
        if (map.param !== 'volume' && map.param !== 'pan') throw new CommandError(`${label}: macro ${mi + 1} can map a chain's volume or pan, not "${map.param}"`);
        target = { chainId, kind: 'chain', param: map.param };
      } else target = { chainId, kind: 'instrument', param: map.param };
      try {
        checkTarget(rack, target, catalog);
      } catch (e) {
        throw new CommandError(`${label}, macro ${mi + 1}: ${(e as Error).message}`);
      }
      const id = ctx.newId(RACK_ID_PREFIX.map);
      rack.macros[mi].maps[id] = { id, target, min: clamp(map.min ?? 0, 0, 1), max: clamp(map.max ?? 1, 0, 1) };
    }
  });
  for (const v of spec.variations ?? []) {
    if (rack.variationOrder.length >= MAX_VARIATIONS) break;
    const id = ctx.newId(RACK_ID_PREFIX.variation);
    rack.variations[id] = { id, name: v.name.slice(0, 64), values: v.values.slice(0, MACRO_COUNT).map((x) => clamp(x, 0, 1)) };
    rack.variationOrder.push(id);
  }
  return rack;
}

/** Macro values (macro1..8) for a rack device, clamped (catalog spec when present, else 0..1). */
export function macroParams(catalog: PluginCatalog, type: string, params: Record<string, number> | undefined): Record<string, number> {
  const desc = findPlugin(catalog, type);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    const spec = desc?.params.find((p) => p.id === k);
    if (spec) out[k] = clampToSpec(spec, v);
    else if ((MACRO_PARAM_IDS as readonly string[]).includes(k)) out[k] = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    else throw new CommandError(`${desc?.name ?? type} has no parameter "${k}"`);
  }
  return out;
}

// ── Helpers for wrapping ──────────────────────────────────────────────

/**
 * Automation clips aimed at a device's own params (not its macros) lose their target; returns how many.
 * Params INSIDE the rack it held go too (`channel/<ch>/rack/…`, `insert/<i>/slot/<s>/rack/…`): the device is replaced.
 */
function unassignAutomation(d: Project, prefix: string, inner: string | null = `${prefix.replace(/gen\/$/, '')}rack/`): number {
  let n = 0;
  for (const aut of Object.values(d.automations)) {
    if (inner && aut.target?.startsWith(inner)) {
      aut.target = null;
      n++;
      continue;
    }
    if (!aut.target?.startsWith(prefix)) continue;
    const param = aut.target.slice(prefix.length);
    // Macros stay; so do refs inside the rack when the caller keeps them (inner = null).
    if ((MACRO_PARAM_IDS as readonly string[]).includes(param) || param.includes('/')) continue;
    aut.target = null;
    n++;
  }
  return n;
}

/**
 * Wrapping a device in a rack: automation aimed at its own params (`from` + paramId) follows it inside the rack
 * (`to` + paramId, a rack ParamRef, Wave 12.2b). Params `keep` rejects are unassigned instead. Returns [moved, cleared].
 */
function retargetAutomation(d: Project, from: string, to: string, keep: (param: string) => boolean): [number, number] {
  let moved = 0;
  let cleared = 0;
  for (const aut of Object.values(d.automations)) {
    if (!aut.target?.startsWith(from)) continue;
    const param = aut.target.slice(from.length);
    if (param.includes('/')) continue;
    if (keep(param)) {
      aut.target = `${to}${param}`;
      moved++;
    } else {
      aut.target = null;
      cleared++;
    }
  }
  return [moved, cleared];
}

/** `channel/<ch>/rack/` or `insert/<i>/slot/<s>/rack/`: where a rack's inner ParamRefs start (shared/schema/params.ts). */
export function innerRefBase(host: Pick<RackHost, 'refPrefix'>): string {
  return `${host.refPrefix.replace(/gen\/$/, '')}rack/`;
}

/** Automation aimed at params inside a rack that just went away (`prefix` + rest, `drop(rest)`) loses its target. */
function unassignInner(d: Project, prefix: string, drop: (rest: string) => boolean = () => true): number {
  let n = 0;
  for (const aut of Object.values(d.automations)) {
    if (!aut.target?.startsWith(prefix) || !drop(aut.target.slice(prefix.length))) continue;
    aut.target = null;
    n++;
  }
  return n;
}

function newInsert(d: Project, name: string, color: string, ctx: CommandContext): string {
  if (d.mixer.insertOrder.length >= MAX_INSERTS) throw new CommandError(`The mixer is full (${MAX_INSERTS} inserts). Delete an unused insert first, or pick a channel to slice onto.`);
  const id = ctx.newId(ID_PREFIX.insert);
  d.mixer.inserts[id] = {
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
    routes: { [d.mixer.masterId]: 1 },
    isMaster: false,
  };
  d.mixer.insertOrder.push(id);
  return id;
}

/** A new channel (own insert) playing `gen`. */
/** A new channel playing `gen`, on its own new mixer insert. */
export function addChannelWithInsert(d: Project, name: string, gen: Generator, ctx: CommandContext): Channel {
  const color = paletteColor(d.channelOrder.length);
  const insertId = newInsert(d, name, color, ctx);
  const id = ctx.newId(ID_PREFIX.channel);
  const ch: Channel = {
    id,
    name: name.slice(0, 64),
    color,
    generator: gen,
    volume: DEFAULT_CHANNEL_VOLUME,
    pan: 0,
    pitch: 0,
    mute: false,
    insertId,
    rootKey: 60,
    swing: 1,
    poly: { mono: false, glideMs: 0, cutGroup: 0, cutBy: 0 },
  };
  d.channels[id] = ch;
  d.channelOrder.push(id);
  return ch;
}

// ── Zod pieces ────────────────────────────────────────────────────────

const zZone = z.object({
  keyLo: z.number().int().min(0).max(127),
  keyHi: z.number().int().min(0).max(127),
  velLo: z.number().min(0).max(1),
  velHi: z.number().min(0).max(1),
});

const zParams = z.record(z.string(), z.number());

const zInstrumentArg = z.object({
  type: z.string().min(1),
  params: zParams.optional(),
  sampleId: z.string().nullable().optional(),
  samplePath: z.string().min(1).max(400).optional(),
});

const zDeviceArg = z.object({ type: z.string().min(1), params: zParams.optional(), mix: z.number().min(0).max(1).optional(), enabled: z.boolean().optional() });

const zMacroTarget = z.union([
  z.object({ chainId: z.string().min(1), kind: z.literal('instrument'), param: z.string().min(1) }),
  z.object({ chainId: z.string().min(1), kind: z.literal('device'), deviceId: z.string().min(1), param: z.string().min(1) }),
  z.object({ chainId: z.string().min(1), kind: z.literal('chain'), param: z.enum(['volume', 'pan']) }),
]);

const zMacro = z.number().int().min(1).max(MACRO_COUNT).describe('Macro number 1..8.');

// ── Commands ──────────────────────────────────────────────────────────

export const rackCreate = defineCommand({
  id: 'rack.create',
  label: (a) => (a.wrap === false ? `New ${RACK_NAME[a.kind ?? (a.channelId ? 'instrument' : 'effect')]}` : 'Wrap in rack'),
  description:
    "Make a rack. On a channel ({channelId}, kind 'instrument' (default) or 'drum'): wrap (default) puts the channel's current instrument (params + sample) into chain 1 of a new rack; wrap=false replaces the instrument with an empty rack. On a mixer slot ({insertId, slotId}): wrap puts that effect into chain 1 of an effect rack in the same slot. Wrapping moves the device's automation onto the same knob inside the rack (movedAutomation). {insertId} alone adds a NEW empty effect rack at `index` (default the end). Returns {channelId | insertId+slotId, chainId?}.",
  args: z.object({ ...targetShape, kind: z.enum(['instrument', 'drum', 'effect']).optional(), wrap: z.boolean().default(true), index: z.number().int().min(0).optional() }),
  run(d, a, ctx) {
    if (a.channelId) {
      const ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
      const kind = a.kind ?? 'instrument';
      if (kind === 'effect') throw new CommandError('Effect racks go in mixer slots; a channel takes an instrument or drum rack');
      if (isRackPlugin(ch.generator.type)) throw new CommandError(`"${ch.name}" already plays a rack`);
      const rack = emptyRack(kind);
      let chainId: string | undefined;
      let moved = 0;
      if (a.wrap) {
        const g = ch.generator;
        if (g.type === AUDIOCLIP) throw new CommandError(`"${ch.name}" plays an audio clip; slice it to pads instead (rack.sliceToPads)`);
        const desc = checkRackInstrument(ctx.catalog, g.type, kind, `"${ch.name}"`);
        // A drum pad sits on the channel's root key, so the notes and steps it already has keep playing it.
        const zone = kind === 'drum' ? { keyLo: ch.rootKey, keyHi: ch.rootKey, velLo: 0, velHi: 1 } : undefined;
        const chain = makeChain(d, ctx.catalog, rack, { name: g.preset?.name ?? shortName(desc, g.type), zone }, ctx);
        chain.instrument = { type: g.type, params: copy(g.params), sampleId: g.sampleId };
        if (kind === 'drum' && g.type === SAMPLER) chain.instrument.params = sanitizeParams(ctx.catalog, SAMPLER, { ...chain.instrument.params, ...PAD_SAMPLER_DEFAULTS });
        insertChain(rack, chain);
        chainId = chain.id;
        // Its automation follows the instrument into the rack (channel/<ch>/rack/<chain>/inst/<param>).
        moved = retargetAutomation(d, `channel/${ch.id}/gen/`, `channel/${ch.id}/rack/${chain.id}/inst/`, (p) => desc.params.some((s) => s.id === p))[0];
      }
      // (Not the refs inside the new rack the wrap just moved there.)
      const cleared = unassignAutomation(d, `channel/${ch.id}/gen/`, null);
      ch.generator = { type: RACK_PLUGIN_FOR[kind], params: {}, sampleId: null, rack };
      if (kind === 'drum' && !a.wrap) ch.rootKey = DRUM_RACK_BASE_NOTE; // step-sequencer steps play pad 1
      return { channelId: ch.id, chainId, clearedAutomation: cleared, movedAutomation: moved };
    }
    if (!a.insertId) throw new CommandError('Say where: a channelId, or an insertId (+ slotId to wrap an effect)');
    if (a.kind && a.kind !== 'effect') throw new CommandError('A mixer slot takes an effect rack; instrument and drum racks go on channels');
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    if (!a.slotId) {
      if (ins.slotOrder.length >= MAX_FX_SLOTS) throw new CommandError(`An insert holds at most ${MAX_FX_SLOTS} effects`);
      const id = ctx.newId(ID_PREFIX.slot);
      ins.slots[id] = { id, type: FX_RACK_PLUGIN, enabled: true, mix: 1, params: {}, sidechainFrom: null, rack: emptyRack('effect') };
      ins.slotOrder.splice(Math.min(a.index ?? ins.slotOrder.length, ins.slotOrder.length), 0, id);
      return { insertId: ins.id, slotId: id };
    }
    const slot = must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
    if (isRackPlugin(slot.type)) throw new CommandError('That slot already holds a rack');
    const rack = emptyRack('effect');
    let chainId: string | undefined;
    let droppedSidechain = false;
    let moved = 0;
    if (a.wrap) {
      const desc = checkRackEffect(ctx.catalog, slot.type, 'That slot');
      const chain = makeChain(d, ctx.catalog, rack, { name: shortName(desc, slot.type) }, ctx);
      const devId = ctx.newId(ID_PREFIX.slot);
      chain.devices[devId] = { id: devId, type: slot.type, enabled: true, mix: slot.mix, params: copy(slot.params), sidechainFrom: null };
      chain.deviceOrder.push(devId);
      droppedSidechain = slot.sidechainFrom !== null;
      insertChain(rack, chain);
      chainId = chain.id;
      // The effect's params (and its old wet/dry) now live inside the rack: their automation follows them there.
      const base = `insert/${ins.id}/slot/${slot.id}/`;
      moved = retargetAutomation(d, base, `${base}rack/${chain.id}/dev/${devId}/`, (p) => p === 'mix' || desc.params.some((s) => s.id === p))[0];
    }
    const cleared = unassignAutomation(d, `insert/${ins.id}/slot/${slot.id}/`, null);
    ins.slots[slot.id] = { id: slot.id, type: FX_RACK_PLUGIN, enabled: slot.enabled, mix: 1, params: {}, sidechainFrom: null, rack };
    return { insertId: ins.id, slotId: slot.id, chainId, clearedAutomation: cleared, movedAutomation: moved, droppedSidechain };
  },
});

export const rackBuild = defineCommand({
  id: 'rack.build',
  label: () => 'Build rack',
  description:
    "Build a whole rack in one step from an id-free spec (the preset / build_rack shape: chains with instrument {plugin, params, sample path}, fx, zone, choke; macros with names + maps by chain / device INDEX; variations). Target: {channelId} (its instrument is REPLACED by the rack; kind must be instrument or drum), {insertId, slotId} (that effect is replaced) or {insertId} (a new slot). `macros` = the 8 macro values 0..1. Returns {channelId | insertId+slotId, chainIds}.",
  args: z.object({ ...targetShape, spec: zPresetRack, macros: z.array(z.number().min(0).max(1)).max(MACRO_COUNT).optional(), index: z.number().int().min(0).optional() }),
  run(d, a, ctx) {
    const rack = rackFromSpec(d, ctx.catalog, a.spec, ctx);
    const params: Record<string, number> = {};
    (a.macros ?? []).forEach((v, i) => {
      params[MACRO_PARAM_IDS[i]] = v;
    });
    const type = RACK_PLUGIN_FOR[a.spec.kind];
    const mp = macroParams(ctx.catalog, type, params);
    if (a.channelId) {
      const ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
      if (a.spec.kind === 'effect') throw new CommandError('An effect rack goes in a mixer slot, not on a channel');
      if (ch.generator.type === AUDIOCLIP) throw new CommandError(`"${ch.name}" plays an audio clip; build the rack on an instrument channel`);
      unassignAutomation(d, `channel/${ch.id}/gen/`);
      ch.generator = { type, params: mp, sampleId: null, rack };
      if (a.spec.kind === 'drum') {
        const notes = Object.values(rack.chains).map((c) => c.zone?.keyLo ?? 127);
        ch.rootKey = notes.length ? Math.min(...notes) : DRUM_RACK_BASE_NOTE; // step-sequencer steps play the first pad
      }
      return { channelId: ch.id, chainIds: [...rack.chainOrder] };
    }
    if (!a.insertId) throw new CommandError('Say where: a channelId, or an insertId (+ slotId to replace an effect)');
    if (a.spec.kind !== 'effect') throw new CommandError(`A mixer slot takes an effect rack, not an ${RACK_NAME[a.spec.kind]}`);
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    if (a.slotId) {
      const slot = must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
      unassignAutomation(d, `insert/${ins.id}/slot/${slot.id}/`);
      ins.slots[slot.id] = { id: slot.id, type, enabled: slot.enabled, mix: slot.type === FX_RACK_PLUGIN ? slot.mix : 1, params: mp, sidechainFrom: null, rack };
      return { insertId: ins.id, slotId: slot.id, chainIds: [...rack.chainOrder] };
    }
    if (ins.slotOrder.length >= MAX_FX_SLOTS) throw new CommandError(`An insert holds at most ${MAX_FX_SLOTS} effects`);
    const id = ctx.newId(ID_PREFIX.slot);
    ins.slots[id] = { id, type, enabled: true, mix: 1, params: mp, sidechainFrom: null, rack };
    ins.slotOrder.splice(Math.min(a.index ?? ins.slotOrder.length, ins.slotOrder.length), 0, id);
    return { insertId: ins.id, slotId: id, chainIds: [...rack.chainOrder] };
  },
});

export const rackAddChain = defineCommand({
  id: 'rack.addChain',
  label: (a) => `Add chain${a.name ? ` "${a.name}"` : ''}`,
  description:
    "Add a chain to a rack: optional instrument {type, params, sampleId | samplePath} (instrument / drum racks; stock instruments only), devices [{type, params, mix}], zone {keyLo, keyHi, velLo, velHi}, choke (drum racks), volume, pan, index. A drum-rack chain without a zone becomes the next free pad (from C2 = 36). Returns {chainId}.",
  args: z.object({
    ...targetShape,
    name: z.string().max(64).optional(),
    color: z.string().nullable().optional(),
    instrument: zInstrumentArg.optional(),
    devices: z.array(zDeviceArg).max(MAX_FX_SLOTS).optional(),
    zone: zZone.optional(),
    choke: z.number().int().min(0).max(32).optional(),
    volume: z.number().min(0).max(2).optional(),
    pan: z.number().min(-1).max(1).optional(),
    index: z.number().int().min(0).optional(),
  }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    if (host.rack.chainOrder.length >= MAX_RACK_CHAINS) throw new CommandError(`A rack holds at most ${MAX_RACK_CHAINS} chains`);
    const chain = makeChain(d, ctx.catalog, host.rack, a, ctx);
    insertChain(host.rack, chain, a.index);
    return { chainId: chain.id };
  },
});

export const rackRemoveChain = defineCommand({
  id: 'rack.removeChain',
  label: () => 'Remove chain',
  description: 'Remove a chain from a rack (macro maps onto it go too; automation aimed at knobs inside it loses its target).',
  args: z.object({ ...targetShape, chainId: z.string() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    chainOf(host, a.chainId);
    delete host.rack.chains[a.chainId];
    host.rack.chainOrder = host.rack.chainOrder.filter((c) => c !== a.chainId);
    const maps = pruneMaps(host.rack, (t) => t.chainId === a.chainId);
    const cleared = unassignInner(d, `${innerRefBase(host)}${a.chainId}/`);
    return { removedMaps: maps, clearedAutomation: cleared };
  },
});

export const rackSetChain = defineCommand({
  id: 'rack.setChain',
  label: (a) => (a.mute !== undefined ? (a.mute ? 'Mute chain' : 'Unmute chain') : a.solo !== undefined ? (a.solo ? 'Solo chain' : 'Unsolo chain') : 'Edit chain'),
  description:
    "Change a rack chain: name, color, volume (linear, 1 = 0 dB, max 2), pan (-1..1), mute, solo (any soloed chain mutes the others in that rack), zone {keyLo, keyHi, velLo, velHi} (null = every note; drum pads keep a zone), choke group 0..32 (drum racks).",
  args: z.object({
    ...targetShape,
    chainId: z.string(),
    name: z.string().max(64).optional(),
    color: z.string().nullable().optional(),
    volume: z.number().min(0).max(2).optional(),
    pan: z.number().min(-1).max(1).optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional(),
    zone: zZone.nullable().optional(),
    choke: z.number().int().min(0).max(32).optional(),
  }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    if (a.name !== undefined) c.name = a.name.trim().slice(0, 64) || c.name;
    if (a.color !== undefined) c.color = a.color;
    if (a.volume !== undefined) c.volume = a.volume;
    if (a.pan !== undefined) c.pan = a.pan;
    if (a.mute !== undefined) c.mute = a.mute;
    if (a.solo !== undefined) c.solo = a.solo;
    if (a.zone !== undefined) {
      if (host.rack.kind === 'effect') throw new CommandError("An effect rack's chains all get the whole input: they have no key zones");
      if (a.zone === null) {
        if (host.rack.kind === 'drum') throw new CommandError('A drum pad needs its note: give it a zone');
        delete c.zone;
      } else {
        const zone = checkZone(a.zone);
        if (host.rack.kind === 'drum' && zone.keyLo === zone.keyHi) {
          const clash = padChain(host.rack, zone.keyLo);
          if (clash && clash.id !== c.id) throw new CommandError(`Pad ${midiNoteName(zone.keyLo)} already has a chain ("${clash.name}")`);
        }
        c.zone = zone;
      }
    }
    if (a.choke !== undefined) {
      if (host.rack.kind !== 'drum') throw new CommandError('Choke groups are for drum-rack pads');
      c.choke = a.choke;
    }
    return {};
  },
});

export const rackMoveChain = defineCommand({
  id: 'rack.moveChain',
  label: () => 'Reorder chains',
  description: 'Move a chain to a new position in its rack.',
  args: z.object({ ...targetShape, chainId: z.string(), toIndex: z.number().int().min(0) }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    chainOf(host, a.chainId);
    const order = host.rack.chainOrder.filter((c) => c !== a.chainId);
    order.splice(Math.min(a.toIndex, order.length), 0, a.chainId);
    host.rack.chainOrder = order;
    return {};
  },
});

export const rackSetInstrument = defineCommand({
  id: 'rack.setInstrument',
  label: () => 'Set chain instrument',
  description:
    "Set (or replace) a chain's instrument: a stock instrument type with params (plain units; missing = defaults). The sample is kept when the new instrument plays samples, unless sampleId / samplePath is given (null clears it). Macro maps onto params the new instrument lacks are removed. Instrument and drum racks only.",
  args: z.object({ ...targetShape, chainId: z.string(), type: z.string(), params: zParams.optional(), sampleId: z.string().nullable().optional(), samplePath: z.string().min(1).max(400).optional() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    const keep = a.sampleId === undefined && !a.samplePath ? c.instrument?.sampleId ?? null : null;
    const gen = makeInstrument(d, ctx.catalog, host.rack.kind, { type: a.type, params: a.params, sampleId: a.sampleId ?? null, samplePath: a.samplePath }, ctx, `Chain "${c.name}"`);
    const desc = findPlugin(ctx.catalog, a.type)!;
    if (keep && desc.usesSample && !gen.sampleId) gen.sampleId = keep;
    const changed = c.instrument?.type !== a.type;
    c.instrument = gen;
    const maps = changed ? pruneMaps(host.rack, (t) => t.chainId === c.id && t.kind === 'instrument' && !desc.params.some((p) => p.id === t.param)) : 0;
    const cleared = changed ? unassignInner(d, `${innerRefBase(host)}${c.id}/inst/`, (p) => !desc.params.some((s) => s.id === p)) : 0;
    return { removedMaps: maps, clearedAutomation: cleared };
  },
});

export const rackSetInstrumentParams = defineCommand({
  id: 'rack.setInstrumentParams',
  label: (a) => `Set ${plural(Object.keys(a.params).length, 'instrument param')}`,
  description: "Set params of a chain's instrument (plain units per the plugin's ParamSpec; clamped; unknown param = error naming it).",
  args: z.object({ ...targetShape, chainId: z.string(), params: zParams }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    const inst = must(c.instrument, `Chain "${c.name}" has no instrument`);
    Object.assign(inst.params, sanitizeParams(ctx.catalog, inst.type, a.params));
    return {};
  },
});

export const rackSetChainSample = defineCommand({
  id: 'rack.setChainSample',
  label: () => 'Load sample into chain',
  description: "Point a chain's sample-based instrument (sampler) at a sample: sampleId from the pool, or samplePath ('factory:…' / absolute; pooled), or null to clear. Params are kept.",
  args: z.object({ ...targetShape, chainId: z.string(), sampleId: z.string().nullable().optional(), samplePath: z.string().min(1).max(400).optional(), rename: z.boolean().default(false) }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    const inst = must(c.instrument, `Chain "${c.name}" has no instrument: set one first`);
    const desc = findPlugin(ctx.catalog, inst.type);
    if (desc && !desc.usesSample) throw new CommandError(`${desc.name} doesn't play samples`);
    if (a.samplePath) inst.sampleId = samplePoolId(d, a.samplePath, ctx);
    else if (a.sampleId) inst.sampleId = must(d.samples[a.sampleId], `Sample ${a.sampleId} not found`).id;
    else if (a.sampleId === null) inst.sampleId = null;
    else throw new CommandError('Give a sampleId, a samplePath, or null to clear');
    if (a.rename && inst.sampleId) c.name = d.samples[inst.sampleId].name.slice(0, 64);
    return { sampleId: inst.sampleId };
  },
});

export const rackAddDevice = defineCommand({
  id: 'rack.addDevice',
  label: () => 'Add device to chain',
  description: `Add a stock effect to a rack chain (max ${MAX_FX_SLOTS} per chain), optionally at index with params / mix. Returns {deviceId}.`,
  args: z.object({ ...targetShape, chainId: z.string(), type: z.string(), params: zParams.optional(), mix: z.number().min(0).max(1).optional(), index: z.number().int().min(0).optional() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    if (c.deviceOrder.length >= MAX_FX_SLOTS) throw new CommandError(`A rack chain holds at most ${MAX_FX_SLOTS} devices`);
    const dev = makeDevice(ctx.catalog, { type: a.type, params: a.params, mix: a.mix }, ctx, `Chain "${c.name}"`);
    c.devices[dev.id] = dev;
    c.deviceOrder.splice(Math.min(a.index ?? c.deviceOrder.length, c.deviceOrder.length), 0, dev.id);
    return { deviceId: dev.id };
  },
});

export const rackRemoveDevice = defineCommand({
  id: 'rack.removeDevice',
  label: () => 'Remove device from chain',
  description: 'Remove an effect from a rack chain (macro maps onto it go too; automation aimed at its knobs loses its target).',
  args: z.object({ ...targetShape, chainId: z.string(), deviceId: z.string() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    must(c.devices[a.deviceId], `Device ${a.deviceId} isn't in chain "${c.name}"`);
    delete c.devices[a.deviceId];
    c.deviceOrder = c.deviceOrder.filter((x) => x !== a.deviceId);
    const maps = pruneMaps(host.rack, (t) => t.kind === 'device' && t.deviceId === a.deviceId);
    const cleared = unassignInner(d, `${innerRefBase(host)}${c.id}/dev/${a.deviceId}/`);
    return { removedMaps: maps, clearedAutomation: cleared };
  },
});

export const rackMoveDevice = defineCommand({
  id: 'rack.moveDevice',
  label: () => 'Reorder devices',
  description: 'Move an effect within its chain, or into another chain of the same rack (toChainId); its macro maps follow it.',
  args: z.object({ ...targetShape, chainId: z.string(), deviceId: z.string(), toIndex: z.number().int().min(0), toChainId: z.string().optional() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const from = chainOf(host, a.chainId);
    const dev = must(from.devices[a.deviceId], `Device ${a.deviceId} isn't in chain "${from.name}"`);
    const to = a.toChainId ? chainOf(host, a.toChainId) : from;
    if (to !== from && to.deviceOrder.length >= MAX_FX_SLOTS) throw new CommandError(`Chain "${to.name}" already holds ${MAX_FX_SLOTS} devices`);
    from.deviceOrder = from.deviceOrder.filter((x) => x !== a.deviceId);
    if (to !== from) {
      delete from.devices[a.deviceId];
      to.devices[a.deviceId] = dev;
      for (const m of host.rack.macros) for (const map of Object.values(m.maps)) if (map.target.kind === 'device' && map.target.deviceId === a.deviceId) map.target.chainId = to.id;
    }
    to.deviceOrder.splice(Math.min(a.toIndex, to.deviceOrder.length), 0, a.deviceId);
    return {};
  },
});

export const rackSetDeviceParams = defineCommand({
  id: 'rack.setDeviceParams',
  label: () => 'Set device params',
  description: "Set a rack device's params (plain units; clamped), its wet/dry mix (0..1) and/or enabled (bypass).",
  args: z.object({ ...targetShape, chainId: z.string(), deviceId: z.string(), params: zParams.optional(), mix: z.number().min(0).max(1).optional(), enabled: z.boolean().optional() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const c = chainOf(host, a.chainId);
    const dev = must(c.devices[a.deviceId], `Device ${a.deviceId} isn't in chain "${c.name}"`);
    if (a.params) Object.assign(dev.params, sanitizeParams(ctx.catalog, dev.type, a.params));
    if (a.mix !== undefined) dev.mix = a.mix;
    if (a.enabled !== undefined) dev.enabled = a.enabled;
    return {};
  },
});

export const rackMapMacro = defineCommand({
  id: 'rack.mapMacro',
  label: (a) => `Map macro ${a.macro}`,
  description:
    "Map macro N (1..8) onto an inner param: target {chainId, kind:'instrument', param} | {chainId, kind:'device', deviceId, param ('mix' = wet/dry)} | {chainId, kind:'chain', param:'volume'|'pan'}. min / max = the normalized 0..1 range the macro sweeps (min > max inverts; defaults 0 / 1). Mapping the same target again updates its range. Returns {mapId}.",
  args: z.object({ ...targetShape, macro: zMacro, target: zMacroTarget, min: z.number().min(0).max(1).default(0), max: z.number().min(0).max(1).default(1) }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const label = checkTarget(host.rack, a.target as MacroTarget, ctx.catalog);
    const m = host.rack.macros[a.macro - 1];
    const existing = Object.values(m.maps).find((x) => sameTarget(x.target, a.target as MacroTarget));
    if (existing) {
      existing.min = a.min;
      existing.max = a.max;
      return { mapId: existing.id, target: label, updated: true };
    }
    if (Object.keys(m.maps).length >= 64) throw new CommandError(`Macro ${a.macro} already has 64 mappings`);
    const id = ctx.newId(RACK_ID_PREFIX.map);
    m.maps[id] = { id, target: copy(a.target) as MacroTarget, min: a.min, max: a.max };
    return { mapId: id, target: label, updated: false };
  },
});

export const rackUnmapMacro = defineCommand({
  id: 'rack.unmapMacro',
  label: (a) => `Unmap macro ${a.macro}`,
  description: 'Remove one mapping (mapId) from macro N, or every mapping of macro N (all: true).',
  args: z.object({ ...targetShape, macro: zMacro, mapId: z.string().optional(), all: z.boolean().default(false) }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const m = host.rack.macros[a.macro - 1];
    if (a.all) {
      const n = Object.keys(m.maps).length;
      m.maps = {};
      return { removed: n };
    }
    if (!a.mapId) throw new CommandError('Give the mapId to remove, or all: true');
    must(m.maps[a.mapId], `Macro ${a.macro} has no mapping ${a.mapId}`);
    delete m.maps[a.mapId];
    return { removed: 1 };
  },
});

export const rackRenameMacro = defineCommand({
  id: 'rack.renameMacro',
  label: (a) => `Rename macro ${a.macro}`,
  description: 'Rename macro N (max 32 characters; empty = "Macro N").',
  args: z.object({ ...targetShape, macro: zMacro, name: z.string().max(64) }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    host.rack.macros[a.macro - 1].name = a.name.trim().slice(0, 32) || `Macro ${a.macro}`;
    return {};
  },
});

function currentMacros(host: RackHost, catalog: PluginCatalog): number[] {
  const desc = findPlugin(catalog, host.type);
  return MACRO_PARAM_IDS.map((id) => clamp(host.params[id] ?? desc?.params.find((p) => p.id === id)?.default ?? 0, 0, 1));
}

function writeMacros(host: RackHost, catalog: PluginCatalog, values: number[]): void {
  const params = macroParams(
    catalog,
    host.type,
    Object.fromEntries(values.slice(0, MACRO_COUNT).map((v, i) => [MACRO_PARAM_IDS[i], v])),
  );
  Object.assign(host.params, params);
}

export const rackStoreVariation = defineCommand({
  id: 'rack.storeVariation',
  label: (a) => `Store variation${a.name ? ` "${a.name}"` : ''}`,
  description: 'Store the 8 macro values (current ones, or `values`) as a named variation. Returns {variationId}.',
  args: z.object({ ...targetShape, name: z.string().max(64).optional(), values: z.array(z.number().min(0).max(1)).length(MACRO_COUNT).optional() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const r = host.rack;
    if (r.variationOrder.length >= MAX_VARIATIONS) throw new CommandError(`A rack keeps at most ${MAX_VARIATIONS} variations: delete one first`);
    const id = ctx.newId(RACK_ID_PREFIX.variation);
    const name = a.name?.trim().slice(0, 64) || `Variation ${r.variationOrder.length + 1}`;
    r.variations[id] = { id, name, values: a.values ? [...a.values] : currentMacros(host, ctx.catalog) };
    r.variationOrder.push(id);
    return { variationId: id, name };
  },
});

export const rackRecallVariation = defineCommand({
  id: 'rack.recallVariation',
  label: () => 'Recall variation',
  description: "Set the rack's 8 macros to a stored variation's values.",
  args: z.object({ ...targetShape, variationId: z.string() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const v = must(host.rack.variations[a.variationId], `Variation ${a.variationId} isn't in this rack`);
    writeMacros(host, ctx.catalog, v.values);
    return { name: v.name, values: [...v.values] };
  },
});

export const rackRemoveVariation = defineCommand({
  id: 'rack.removeVariation',
  label: () => 'Delete variation',
  description: 'Delete a stored macro variation.',
  args: z.object({ ...targetShape, variationId: z.string() }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    must(host.rack.variations[a.variationId], `Variation ${a.variationId} isn't in this rack`);
    delete host.rack.variations[a.variationId];
    host.rack.variationOrder = host.rack.variationOrder.filter((v) => v !== a.variationId);
    return {};
  },
});

export const rackRandomizeMacros = defineCommand({
  id: 'rack.randomizeMacros',
  label: () => 'Randomize macros',
  description:
    'Set macros to seeded random values (same seed = same result). macros = which (1..8; default the mapped ones, or all 8 when none is mapped); amount 0..1 moves each that far from its current value toward the random one (1 = fully random).',
  args: z.object({ ...targetShape, seed: z.number().int(), macros: z.array(zMacro).max(MACRO_COUNT).optional(), amount: z.number().min(0).max(1).default(1) }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    const mapped = host.rack.macros.map((m, i) => (Object.keys(m.maps).length ? i + 1 : 0)).filter(Boolean);
    const which = new Set(a.macros ?? (mapped.length ? mapped : [1, 2, 3, 4, 5, 6, 7, 8]));
    const rnd = seededRandom(a.seed);
    const values = currentMacros(host, ctx.catalog).map((cur, i) => {
      const r = rnd(); // drawn for every macro, so a macro's value doesn't depend on which others were picked
      return which.has(i + 1) ? Math.round((cur + (r - cur) * a.amount) * 1e4) / 1e4 : cur;
    });
    writeMacros(host, ctx.catalog, values);
    return { values };
  },
});

export const rackDrumPad = defineCommand({
  id: 'rack.drumPad',
  label: (a) => `Set pad ${midiNoteName(a.note)}`,
  description:
    "Set a drum-rack pad by note: creates the pad (a sampler chain with zone = that note) if it has none, and loads sampleId / samplePath into it (null clears). Optional name and choke group. A new pad's sampler plays at the sample's own pitch (key tracking off). Returns {chainId, created}.",
  args: z.object({
    ...targetShape,
    note: z.number().int().min(0).max(127),
    sampleId: z.string().nullable().optional(),
    samplePath: z.string().min(1).max(400).optional(),
    name: z.string().max(64).optional(),
    choke: z.number().int().min(0).max(32).optional(),
  }),
  run(d, a, ctx) {
    const host = rackHost(d, a, ctx.catalog);
    if (host.rack.kind !== 'drum') throw new CommandError(`The rack on ${host.where} is an ${RACK_NAME[host.rack.kind]}; pads are for drum racks`);
    let c = padChain(host.rack, a.note);
    let created = false;
    if (!c) {
      const chain = makeChain(
        d,
        ctx.catalog,
        host.rack,
        { name: a.name, zone: { keyLo: a.note, keyHi: a.note, velLo: 0, velHi: 1 }, choke: a.choke, instrument: { type: SAMPLER, params: PAD_SAMPLER_DEFAULTS, samplePath: a.samplePath, sampleId: a.sampleId ?? null } },
        ctx,
        `Pad ${midiNoteName(a.note)}`,
      );
      if (!a.name && chain.instrument?.sampleId) chain.name = d.samples[chain.instrument.sampleId].name.slice(0, 64);
      insertChain(host.rack, chain);
      return { chainId: chain.id, created: true };
    }
    if (a.samplePath !== undefined || a.sampleId !== undefined) {
      if (!c.instrument) c.instrument = makeInstrument(d, ctx.catalog, 'drum', { type: SAMPLER, params: PAD_SAMPLER_DEFAULTS }, ctx, `Pad ${midiNoteName(a.note)}`);
      const desc = findPlugin(ctx.catalog, c.instrument.type);
      if (desc && !desc.usesSample) throw new CommandError(`Pad ${midiNoteName(a.note)} plays ${desc.name}, which doesn't play samples`);
      c.instrument.sampleId = a.samplePath ? samplePoolId(d, a.samplePath, ctx) : a.sampleId ? must(d.samples[a.sampleId], `Sample ${a.sampleId} not found`).id : null;
      if (!a.name && c.instrument.sampleId) c.name = d.samples[c.instrument.sampleId].name.slice(0, 64);
    }
    if (a.name !== undefined && a.name.trim()) c.name = a.name.trim().slice(0, 64);
    if (a.choke !== undefined) c.choke = a.choke;
    return { chainId: c.id, created };
  },
});

// ── Slicer ────────────────────────────────────────────────────────────

/**
 * Clean slice start times (seconds): finite, inside [0, lengthSec), sorted, closer than `minGapSec` merged. A
 * first slice after 0 keeps the lead-in out (as given).
 */
export function cleanSlices(times: readonly number[], lengthSec: number, minGapSec = 0.01): number[] {
  const out: number[] = [];
  for (const t of [...times].filter((x) => Number.isFinite(x) && x >= 0 && x < lengthSec).sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] >= minGapSec) out.push(t);
  }
  return out;
}

/**
 * Slice times for a loop (pure; main feeds it analyzer onsets). mode 'onsets': the given onsets, thinned to
 * `maxSlices` by keeping the strongest (`strengths`, else the earliest) plus 0 when `includeStart`. mode 'grid':
 * every `division` beats (0.25 = 16ths) at `bpm`. mode 'manual': the given times.
 */
export function sliceTimes(opts: {
  mode: 'onsets' | 'grid' | 'manual';
  lengthSec: number;
  times?: readonly number[];
  strengths?: readonly number[];
  bpm?: number;
  division?: number;
  maxSlices?: number;
  includeStart?: boolean;
  minGapSec?: number;
}): number[] {
  const max = Math.max(1, Math.min(MAX_SLICES, opts.maxSlices ?? 16));
  const gap = opts.minGapSec ?? 0.03;
  if (opts.mode === 'grid') {
    const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : 120;
    const step = (60 / bpm) * (opts.division && opts.division > 0 ? opts.division : 1);
    const out: number[] = [];
    for (let t = 0; t < opts.lengthSec - 1e-6 && out.length < max; t += step) out.push(Math.round(t * 1e6) / 1e6);
    return out;
  }
  const raw = (opts.times ?? []).map((t, i) => ({ t, s: opts.strengths?.[i] ?? 0, i }));
  const cleaned: Array<{ t: number; s: number; i: number }> = [];
  for (const r of raw.filter((x) => Number.isFinite(x.t) && x.t >= 0 && x.t < opts.lengthSec).sort((a, b) => a.t - b.t)) {
    const last = cleaned[cleaned.length - 1];
    if (last && r.t - last.t < gap) {
      if (r.s > last.s) cleaned[cleaned.length - 1] = r; // keep the stronger of two near hits
      continue;
    }
    cleaned.push(r);
  }
  if (opts.mode === 'onsets' && (opts.includeStart ?? true) && (!cleaned.length || cleaned[0].t > gap)) cleaned.unshift({ t: 0, s: Infinity, i: -1 });
  let keep = cleaned;
  if (keep.length > max) {
    keep = [...keep].sort((a, b) => b.s - a.s || a.t - b.t).slice(0, max).sort((a, b) => a.t - b.t);
  }
  return keep.map((x) => Math.round(x.t * 1e6) / 1e6);
}

export const rackSliceToPads = defineCommand({
  id: 'rack.sliceToPads',
  label: (a) => `Slice to pads (${plural(a.slices.length, 'slice')})`,
  description:
    "Slice a sample onto a drum rack: one pad per slice from baseNote (default C2 = 36), each a sampler playing start..end of the sample (normalized; key tracking off). slices = slice start times in seconds (from analyzer onsets, a grid or by hand; main computes them), lengthSec = the sample's length. Target: channelId (its instrument is replaced by the drum rack) or a NEW channel named `name` (own mixer insert). pattern (default true) adds a pattern that replays the loop at `bpm` (default the project tempo): one note per slice. Sample: sampleId (pool) or samplePath. Returns {channelId, insertId, chainIds, patternId?, hasEnd}.",
  args: z.object({
    channelId: z.string().optional(),
    name: z.string().min(1).max(64).optional(),
    sampleId: z.string().optional(),
    samplePath: z.string().min(1).max(400).optional(),
    slices: z.array(z.number().min(0)).min(1).max(MAX_SLICES),
    lengthSec: z.number().positive().max(3600),
    bpm: z.number().min(10).max(999).optional(),
    pattern: z.boolean().default(true),
    patternName: z.string().max(64).optional(),
    baseNote: z.number().int().min(0).max(127).default(DRUM_RACK_BASE_NOTE),
    choke: z.number().int().min(0).max(32).default(0).describe('Choke group for every pad (1 = each slice cuts the previous one, like a classic slicer).'),
  }),
  run(d, a, ctx) {
    const sampleId = a.samplePath ? samplePoolId(d, a.samplePath, ctx) : a.sampleId ? must(d.samples[a.sampleId], `Sample ${a.sampleId} not found`).id : null;
    if (!sampleId) throw new CommandError('Give the sample to slice (sampleId or samplePath)');
    const sample = d.samples[sampleId];
    const slices = cleanSlices(a.slices, a.lengthSec);
    if (!slices.length) throw new CommandError(`None of the slice times falls inside the sample (0..${a.lengthSec.toFixed(2)} s)`);
    if (a.baseNote + slices.length - 1 > 127) throw new CommandError(`${plural(slices.length, 'slice')} from ${midiNoteName(a.baseNote)} would run past the top MIDI note: use a lower base note or fewer slices`);
    const samplerDesc = must(findPlugin(ctx.catalog, SAMPLER), 'The Sampler is missing from the plugin catalog');
    const hasEnd = samplerDesc.params.some((p) => p.id === 'end');
    const rack = emptyRack('drum');
    slices.forEach((t, i) => {
      const next = slices[i + 1] ?? a.lengthSec;
      const note = a.baseNote + i;
      const params: Record<string, number> = { ...PAD_SAMPLER_DEFAULTS, start: Math.round((t / a.lengthSec) * 1e6) / 1e6 };
      if (hasEnd) params.end = Math.round((next / a.lengthSec) * 1e6) / 1e6;
      const chain = makeChain(
        d,
        ctx.catalog,
        rack,
        { name: `Slice ${i + 1}`, zone: { keyLo: note, keyHi: note, velLo: 0, velHi: 1 }, choke: a.choke, instrument: { type: SAMPLER, params, sampleId } },
        ctx,
        `Slice ${i + 1}`,
      );
      insertChain(rack, chain);
    });
    let ch: Channel;
    if (a.channelId) {
      ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
      if (ch.generator.type === AUDIOCLIP) {
        // Slicing an audio clip's own channel would orphan its playlist clips: the drum rack goes on a new channel.
        ch = addChannelWithInsert(d, a.name ?? `${sample.name} slices`, { type: DRUM_RACK_PLUGIN, params: {}, sampleId: null, rack }, ctx);
      } else {
        unassignAutomation(d, `channel/${ch.id}/gen/`);
        ch.generator = { type: DRUM_RACK_PLUGIN, params: {}, sampleId: null, rack };
        if (a.name) ch.name = a.name;
      }
    } else ch = addChannelWithInsert(d, a.name ?? `${sample.name} slices`, { type: DRUM_RACK_PLUGIN, params: {}, sampleId: null, rack }, ctx);
    ch.rootKey = a.baseNote; // step-sequencer steps play the first slice
    let patternId: string | undefined;
    if (a.pattern) {
      const bpm = a.bpm ?? d.transport.bpm;
      const toTick = (sec: number): number => Math.round((sec * bpm * PPQ) / 60);
      const len = Math.max(TICKS_PER_STEP, Math.round(toTick(a.lengthSec) / TICKS_PER_STEP) * TICKS_PER_STEP);
      const id = ctx.newId(ID_PREFIX.pattern);
      const notes: Record<string, ReturnType<typeof defaultNote>> = {};
      slices.forEach((t, i) => {
        const tick = toTick(t);
        if (tick >= len) return;
        const end = Math.min(len, toTick(slices[i + 1] ?? a.lengthSec));
        const nid = ctx.newId(ID_PREFIX.note);
        notes[nid] = defaultNote({ id: nid, tick, key: a.baseNote + i, dur: Math.max(1, end - tick) });
      });
      d.patterns[id] = { id, name: (a.patternName ?? `${sample.name} loop`).slice(0, 64), color: ch.color, length: len, notes: { [ch.id]: notes } };
      d.patternOrder.push(id);
      patternId = id;
    }
    return { channelId: ch.id, insertId: ch.insertId, chainIds: [...rack.chainOrder], patternId, slices, hasEnd };
  },
});

export const DEVICE_RACK_COMMANDS: CommandDef[] = [
  rackCreate,
  rackBuild,
  rackAddChain,
  rackRemoveChain,
  rackSetChain,
  rackMoveChain,
  rackSetInstrument,
  rackSetInstrumentParams,
  rackSetChainSample,
  rackAddDevice,
  rackRemoveDevice,
  rackMoveDevice,
  rackSetDeviceParams,
  rackMapMacro,
  rackUnmapMacro,
  rackRenameMacro,
  rackStoreVariation,
  rackRecallVariation,
  rackRemoveVariation,
  rackRandomizeMacros,
  rackDrumPad,
  rackSliceToPads,
] as CommandDef[];

// ── Integrity (dangling references inside racks) ─────────────────────

/** Problems inside a project's racks: samples, chain / device order, macro targets. Empty = fine. */
export function rackIntegrity(p: Project): string[] {
  const errs: string[] = [];
  const check = (rack: RackDef | undefined, where: string): void => {
    if (!rack) return;
    for (const id of rack.chainOrder) if (!rack.chains[id]) errs.push(`${where}: chainOrder has unknown ${id}`);
    for (const c of Object.values(rack.chains)) {
      if (!rack.chainOrder.includes(c.id)) errs.push(`${where}: chain ${c.id} missing from chainOrder`);
      if (c.instrument?.sampleId && !p.samples[c.instrument.sampleId]) errs.push(`${where}: chain ${c.id} references missing sample`);
      for (const id of c.deviceOrder) if (!c.devices[id]) errs.push(`${where}: chain ${c.id} deviceOrder has unknown ${id}`);
      if (c.deviceOrder.length > MAX_FX_SLOTS) errs.push(`${where}: chain ${c.id} has more than ${MAX_FX_SLOTS} devices`);
      if (c.instrument && isRackPlugin(c.instrument.type)) errs.push(`${where}: chain ${c.id} holds a rack`);
      for (const dv of Object.values(c.devices)) if (isRackPlugin(dv.type)) errs.push(`${where}: chain ${c.id} holds a rack device`);
    }
    if (rack.macros.length !== MACRO_COUNT) errs.push(`${where}: ${rack.macros.length} macros`);
    rack.macros.forEach((m, i) => {
      for (const map of Object.values(m.maps)) {
        const c = rack.chains[map.target.chainId];
        if (!c) errs.push(`${where}: macro ${i + 1} maps missing chain ${map.target.chainId}`);
        else if (map.target.kind === 'device' && !c.devices[map.target.deviceId]) errs.push(`${where}: macro ${i + 1} maps missing device ${map.target.deviceId}`);
        else if (map.target.kind === 'instrument' && !c.instrument) errs.push(`${where}: macro ${i + 1} maps the instrument of a chain without one`);
      }
    });
    for (const id of rack.variationOrder) if (!rack.variations[id]) errs.push(`${where}: variationOrder has unknown ${id}`);
  };
  for (const ch of Object.values(p.channels)) check(ch.generator.rack, `channel ${ch.id} rack`);
  for (const ins of Object.values(p.mixer.inserts)) for (const s of Object.values(ins.slots)) check(s.rack, `insert ${ins.id} slot ${s.id} rack`);
  return errs;
}

/** Sample ids the racks of a project use (samples.remove keeps them; the pool view counts them). */
export function rackSampleIds(p: Project): Set<string> {
  const out = new Set<string>();
  const add = (rack: RackDef | undefined): void => {
    for (const c of Object.values(rack?.chains ?? {})) if (c.instrument?.sampleId) out.add(c.instrument.sampleId);
  };
  for (const ch of Object.values(p.channels)) add(ch.generator.rack);
  for (const ins of Object.values(p.mixer.inserts)) for (const s of Object.values(ins.slots)) add(s.rack);
  return out;
}
