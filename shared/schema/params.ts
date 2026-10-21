// ──────────────────────────────────────────────────────────────────────
// ParamRef — a string address for every automatable value in a project.
// Used by automation clips, MCP tools (`params.set`), knob context menus
// ("create automation clip", "link to controller") and the engine.
//
//   transport/bpm | transport/swing | transport/masterVolume
//   channel/<chId>/volume | pan | pitch
//   channel/<chId>/gen/<paramId>
//   insert/<insId>/volume | pan | stereoSep
//   insert/<insId>/slot/<slotId>/mix
//   insert/<insId>/slot/<slotId>/<paramId>
//   insert/<insId>/route/<targetInsId>
//
// Inside racks (Wave 12.2b; <host> = channel/<chId> for instrument / drum
// racks, insert/<insId>/slot/<slotId> for effect racks):
//   <host>/rack/<chainId>/volume | pan
//   <host>/rack/<chainId>/inst/<paramId>              (instrument / drum racks)
//   <host>/rack/<chainId>/dev/<deviceId>/<paramId|mix>
// ──────────────────────────────────────────────────────────────────────

import type { FxSlot, Generator, Project } from './project';
import { DRUM_RACK_PLUGIN, FX_RACK_PLUGIN, RACK_PLUGIN, type MacroTarget, type RackChain } from './rack';
import type { ParamSpec, PluginCatalog, PluginDescriptor } from '../plugins/types';
import { clampToSpec } from '../plugins/types';

export type ParamRef = string;

export type ParsedParamRef =
  | { scope: 'transport'; param: 'bpm' | 'swing' | 'masterVolume' }
  | { scope: 'channel'; channelId: string; param: 'volume' | 'pan' | 'pitch' }
  | { scope: 'gen'; channelId: string; param: string }
  | { scope: 'insert'; insertId: string; param: 'volume' | 'pan' | 'stereoSep' }
  | { scope: 'slot'; insertId: string; slotId: string; param: string }
  | { scope: 'route'; insertId: string; targetId: string }
  | { scope: 'rack'; host: RackParamHost; target: MacroTarget };

/** Which rack a `rack` ParamRef lives in: a channel's instrument / drum rack or a mixer slot's effect rack. */
export type RackParamHost = { kind: 'channel'; channelId: string } | { kind: 'slot'; insertId: string; slotId: string };

/** The `<host>/rack/…` tail (p = all segments, i = index of "rack"). */
function parseRackTail(p: string[], i: number): MacroTarget | null {
  if (p[i] !== 'rack' || !p[i + 1]) return null;
  const chainId = p[i + 1];
  const rest = p.length - i - 2;
  if (rest === 1 && (p[i + 2] === 'volume' || p[i + 2] === 'pan')) return { chainId, kind: 'chain', param: p[i + 2] as 'volume' | 'pan' };
  if (rest === 2 && p[i + 2] === 'inst') return { chainId, kind: 'instrument', param: p[i + 3] };
  if (rest === 3 && p[i + 2] === 'dev') return { chainId, kind: 'device', deviceId: p[i + 3], param: p[i + 4] };
  return null;
}

/** ParamRef of a param inside a rack (named like a macro target). */
export function rackParamRef(host: RackParamHost, target: MacroTarget): ParamRef {
  return formatParamRef({ scope: 'rack', host, target });
}

export function parseParamRef(ref: ParamRef): ParsedParamRef | null {
  const p = ref.split('/');
  if (p[0] === 'transport' && p.length === 2 && (p[1] === 'bpm' || p[1] === 'swing' || p[1] === 'masterVolume')) {
    return { scope: 'transport', param: p[1] };
  }
  if (p[0] === 'channel' && p.length === 3 && (p[2] === 'volume' || p[2] === 'pan' || p[2] === 'pitch')) {
    return { scope: 'channel', channelId: p[1], param: p[2] };
  }
  if (p[0] === 'channel' && p.length === 4 && p[2] === 'gen') return { scope: 'gen', channelId: p[1], param: p[3] };
  if (p[0] === 'insert' && p.length === 3 && (p[2] === 'volume' || p[2] === 'pan' || p[2] === 'stereoSep')) {
    return { scope: 'insert', insertId: p[1], param: p[2] };
  }
  if (p[0] === 'insert' && p.length === 5 && p[2] === 'slot') return { scope: 'slot', insertId: p[1], slotId: p[3], param: p[4] };
  if (p[0] === 'insert' && p.length === 4 && p[2] === 'route') return { scope: 'route', insertId: p[1], targetId: p[3] };
  if (p.some((x) => !x)) return null;
  if (p[0] === 'channel' && p.length >= 5 && p[2] === 'rack') {
    const target = parseRackTail(p, 2);
    return target ? { scope: 'rack', host: { kind: 'channel', channelId: p[1] }, target } : null;
  }
  if (p[0] === 'insert' && p.length >= 7 && p[2] === 'slot' && p[4] === 'rack') {
    const target = parseRackTail(p, 4);
    return target ? { scope: 'rack', host: { kind: 'slot', insertId: p[1], slotId: p[3] }, target } : null;
  }
  return null;
}

export function formatParamRef(r: ParsedParamRef): ParamRef {
  switch (r.scope) {
    case 'transport':
      return `transport/${r.param}`;
    case 'channel':
      return `channel/${r.channelId}/${r.param}`;
    case 'gen':
      return `channel/${r.channelId}/gen/${r.param}`;
    case 'insert':
      return `insert/${r.insertId}/${r.param}`;
    case 'slot':
      return `insert/${r.insertId}/slot/${r.slotId}/${r.param}`;
    case 'route':
      return `insert/${r.insertId}/route/${r.targetId}`;
    case 'rack': {
      const h = r.host.kind === 'channel' ? `channel/${r.host.channelId}` : `insert/${r.host.insertId}/slot/${r.host.slotId}`;
      const t = r.target;
      const tail = t.kind === 'chain' ? t.param : t.kind === 'instrument' ? `inst/${t.param}` : `dev/${t.deviceId}/${t.param}`;
      return `${h}/rack/${t.chainId}/${tail}`;
    }
  }
}

// ── Built-in (non-plugin) parameter specs ─────────────────────────────

export const BUILTIN_SPECS = {
  bpm: { id: 'bpm', name: 'Tempo', min: 10, max: 999, default: 140, unit: 'bpm', scale: 'linear' },
  swing: { id: 'swing', name: 'Swing', min: 0, max: 1, default: 0, unit: '%', scale: 'linear' },
  masterVolume: { id: 'masterVolume', name: 'Master volume', min: 0, max: 2, default: 1, unit: '', scale: 'gain' },
  channelVolume: { id: 'volume', name: 'Volume', min: 0, max: 1.25, default: 0.78, unit: '', scale: 'gain' },
  pan: { id: 'pan', name: 'Pan', min: -1, max: 1, default: 0, unit: '', scale: 'linear' },
  pitch: { id: 'pitch', name: 'Pitch', min: -24, max: 24, default: 0, unit: 'st', scale: 'linear' },
  insertVolume: { id: 'volume', name: 'Volume', min: 0, max: 2, default: 1, unit: '', scale: 'gain' },
  stereoSep: { id: 'stereoSep', name: 'Stereo separation', min: -1, max: 1, default: 0, unit: '', scale: 'linear' },
  mix: { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, unit: '%', scale: 'linear' },
  route: { id: 'route', name: 'Send level', min: 0, max: 2, default: 1, unit: '', scale: 'gain' },
} satisfies Record<string, ParamSpec>;

/** A rack chain's volume: linear, 1 = 0 dB, max 2 (the engine's built-in rack target spec). */
export const RACK_CHAIN_VOLUME: ParamSpec = { id: 'volume', name: 'Chain volume', min: 0, max: 2, default: 1, unit: '', scale: 'gain' };
export const RACK_CHAIN_PAN: ParamSpec = { id: 'pan', name: 'Chain pan', min: -1, max: 1, default: 0, unit: '', scale: 'linear' };

// ── Params inside racks ───────────────────────────────────────────────

/** The chain a rack ParamRef names (null if the host isn't a rack of the right kind or the chain is gone). */
function rackChainAt(project: Project, host: RackParamHost, chainId: string): RackChain | null {
  if (host.kind === 'channel') {
    const g = project.channels[host.channelId]?.generator;
    if (!g || (g.type !== RACK_PLUGIN && g.type !== DRUM_RACK_PLUGIN)) return null;
    return g.rack?.chains[chainId] ?? null;
  }
  const s = project.mixer.inserts[host.insertId]?.slots[host.slotId];
  if (!s || s.type !== FX_RACK_PLUGIN) return null;
  return s.rack?.chains[chainId] ?? null;
}

/** What a rack ParamRef points at: the chain, plus the instrument or device it addresses. */
function rackParamTarget(project: Project, host: RackParamHost, t: MacroTarget): { chain: RackChain; inst?: Generator; dev?: FxSlot } | null {
  const chain = rackChainAt(project, host, t.chainId);
  if (!chain) return null;
  if (t.kind === 'chain') return { chain };
  if (t.kind === 'instrument') {
    // Effect racks ignore instruments (the engine never plays them).
    if (host.kind !== 'channel' || !chain.instrument) return null;
    return { chain, inst: chain.instrument };
  }
  const dev = chain.devices[t.deviceId];
  return dev ? { chain, dev } : null;
}

/** Spec of a param inside a rack: chain volume / pan, a device's mix, or the inner plugin's own spec. */
function rackParamSpec(project: Project, catalog: PluginCatalog, host: RackParamHost, t: MacroTarget): ParamSpec | null {
  const at = rackParamTarget(project, host, t);
  if (!at) return null;
  if (t.kind === 'chain') return t.param === 'volume' ? RACK_CHAIN_VOLUME : RACK_CHAIN_PAN;
  if (at.inst) return findPlugin(catalog, at.inst.type)?.params.find((s) => s.id === t.param) ?? null;
  if (!at.dev) return null;
  if (t.param === 'mix') return BUILTIN_SPECS.mix;
  return findPlugin(catalog, at.dev.type)?.params.find((s) => s.id === t.param) ?? null;
}

export function findPlugin(catalog: PluginCatalog, type: string): PluginDescriptor | undefined {
  return catalog.plugins.find((p) => p.id === type);
}

/** Resolve the ParamSpec for a ref (null if the target doesn't exist). */
export function paramSpecFor(project: Project, catalog: PluginCatalog, ref: ParamRef): ParamSpec | null {
  const r = parseParamRef(ref);
  if (!r) return null;
  switch (r.scope) {
    case 'transport':
      return BUILTIN_SPECS[r.param];
    case 'channel':
      if (!project.channels[r.channelId]) return null;
      return r.param === 'volume' ? BUILTIN_SPECS.channelVolume : r.param === 'pan' ? BUILTIN_SPECS.pan : BUILTIN_SPECS.pitch;
    case 'gen': {
      const ch = project.channels[r.channelId];
      if (!ch) return null;
      return findPlugin(catalog, ch.generator.type)?.params.find((s) => s.id === r.param) ?? null;
    }
    case 'insert':
      if (!project.mixer.inserts[r.insertId]) return null;
      return r.param === 'volume' ? BUILTIN_SPECS.insertVolume : r.param === 'pan' ? BUILTIN_SPECS.pan : BUILTIN_SPECS.stereoSep;
    case 'slot': {
      const slot = project.mixer.inserts[r.insertId]?.slots[r.slotId];
      if (!slot) return null;
      if (r.param === 'mix') return BUILTIN_SPECS.mix;
      return findPlugin(catalog, slot.type)?.params.find((s) => s.id === r.param) ?? null;
    }
    case 'route':
      if (!project.mixer.inserts[r.insertId] || !project.mixer.inserts[r.targetId]) return null;
      return BUILTIN_SPECS.route;
    case 'rack':
      return rackParamSpec(project, catalog, r.host, r.target);
  }
}

/** A short human name for a ref: the spec name, prefixed by its chain inside racks ("Keys · Cutoff"). */
export function paramLabel(project: Project, catalog: PluginCatalog, ref: ParamRef): string | null {
  const spec = paramSpecFor(project, catalog, ref);
  const r = parseParamRef(ref);
  if (!spec || !r) return null;
  if (r.scope !== 'rack') return spec.name;
  return `${rackParamTarget(project, r.host, r.target)!.chain.name} · ${spec.name}`;
}

/** Current plain value of a param (falls back to the spec default for sparse params). */
export function getParamValue(project: Project, catalog: PluginCatalog, ref: ParamRef): number | null {
  const r = parseParamRef(ref);
  const spec = paramSpecFor(project, catalog, ref);
  if (!r || !spec) return null;
  switch (r.scope) {
    case 'transport':
      return project.transport[r.param];
    case 'channel':
      return project.channels[r.channelId][r.param];
    case 'gen':
      return project.channels[r.channelId].generator.params[r.param] ?? spec.default;
    case 'insert':
      return project.mixer.inserts[r.insertId][r.param];
    case 'slot': {
      const slot = project.mixer.inserts[r.insertId].slots[r.slotId];
      return r.param === 'mix' ? slot.mix : slot.params[r.param] ?? spec.default;
    }
    case 'route':
      return project.mixer.inserts[r.insertId].routes[r.targetId] ?? 0;
    case 'rack': {
      const at = rackParamTarget(project, r.host, r.target)!;
      const t = r.target;
      if (t.kind === 'chain') return at.chain[t.param];
      if (at.inst) return at.inst.params[t.param] ?? spec.default;
      return t.param === 'mix' ? at.dev!.mix : at.dev!.params[t.param] ?? spec.default;
    }
  }
}

/**
 * Write a plain value into a (draft) project. Clamps to the spec.
 * Returns an error message, or null on success.
 */
export function setParamValue(draft: Project, catalog: PluginCatalog, ref: ParamRef, value: number): string | null {
  const r = parseParamRef(ref);
  if (!r) return `Invalid parameter reference "${ref}"`;
  const spec = paramSpecFor(draft, catalog, ref);
  if (!spec) return `Parameter "${ref}" does not exist`;
  const v = clampToSpec(spec, value);
  switch (r.scope) {
    case 'transport':
      draft.transport[r.param] = v;
      break;
    case 'channel':
      draft.channels[r.channelId][r.param] = v;
      break;
    case 'gen':
      draft.channels[r.channelId].generator.params[r.param] = v;
      break;
    case 'insert':
      draft.mixer.inserts[r.insertId][r.param] = v;
      break;
    case 'slot': {
      const slot = draft.mixer.inserts[r.insertId].slots[r.slotId];
      if (r.param === 'mix') slot.mix = v;
      else slot.params[r.param] = v;
      break;
    }
    case 'route':
      draft.mixer.inserts[r.insertId].routes[r.targetId] = v;
      break;
    case 'rack': {
      const at = rackParamTarget(draft, r.host, r.target)!;
      const t = r.target;
      if (t.kind === 'chain') at.chain[t.param] = v;
      else if (at.inst) at.inst.params[t.param] = v;
      else if (t.param === 'mix') at.dev!.mix = v;
      else at.dev!.params[t.param] = v;
      break;
    }
  }
  return null;
}
