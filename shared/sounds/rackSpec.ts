// Racks in presets (Wave 12.2): a project RackDef → the id-free PresetRack a
// preset stores (shared/sounds/types.ts). Chains, devices and macro targets
// become indices; inner samples become their pool paths (like preset
// samples); params are sparse (only what differs from the defaults). The
// reverse is rackFromSpec in shared/commands/racks.ts. Pure.

import type { Project } from '../schema/project';
import type { RackDef } from '../schema/rack';
import { MACRO_COUNT } from '../schema/rack';
import type { PluginCatalog } from '../plugins/types';
import { findPlugin } from '../schema/params';
import type { PresetFx, PresetMacroMap, PresetRack, PresetRackChain } from './types';

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Params that differ from the plugin's defaults (local copy of capture.sparseParams, to keep the import graph flat). */
function sparse(catalog: PluginCatalog, type: string, params: Record<string, number>): Record<string, number> {
  const desc = findPlugin(catalog, type);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!Number.isFinite(v)) continue;
    const spec = desc?.params.find((p) => p.id === k);
    if (desc && !spec) continue;
    if (spec && Math.abs(v - spec.default) < 1e-9) continue;
    out[k] = round(v);
  }
  return out;
}

/** The preset form of a rack. Chains with an instrument that isn't in the catalog keep it as is (validated on load). */
export function rackToSpec(project: Project, catalog: PluginCatalog, rack: RackDef): PresetRack {
  const chainIdx = new Map<string, number>();
  const chains: PresetRackChain[] = rack.chainOrder
    .map((id) => rack.chains[id])
    .filter((c) => !!c)
    .map((c, i) => {
      chainIdx.set(c.id, i);
      const out: PresetRackChain = { name: c.name };
      if (c.color) out.color = c.color;
      if (Math.abs(c.volume - 1) > 1e-9) out.volume = round(c.volume);
      if (Math.abs(c.pan) > 1e-9) out.pan = round(c.pan);
      if (c.mute) out.mute = true;
      if (c.solo) out.solo = true;
      if (c.zone) out.zone = { ...c.zone };
      if (c.choke) out.choke = c.choke;
      if (c.instrument) {
        out.instrument = { plugin: c.instrument.type, params: sparse(catalog, c.instrument.type, c.instrument.params) };
        const s = c.instrument.sampleId ? project.samples[c.instrument.sampleId] : undefined;
        if (s) out.instrument.sample = s.path;
      }
      const fx: PresetFx[] = c.deviceOrder
        .map((id) => c.devices[id])
        .filter((dv) => !!dv)
        .map((dv) => {
          const f: PresetFx = { type: dv.type, params: sparse(catalog, dv.type, dv.params) };
          if (Math.abs(dv.mix - (findPlugin(catalog, dv.type)?.defaultMix ?? 1)) > 1e-9) f.mix = round(dv.mix);
          if (!dv.enabled) f.enabled = false;
          return f;
        });
      if (fx.length) out.fx = fx;
      return out;
    });
  const macros = rack.macros.slice(0, MACRO_COUNT).map((m, i) => {
    const maps: PresetMacroMap[] = [];
    for (const map of Object.values(m.maps)) {
      const ci = chainIdx.get(map.target.chainId);
      if (ci === undefined) continue;
      const base = { chain: ci, param: map.target.param, ...(map.min !== 0 ? { min: round(map.min) } : {}), ...(map.max !== 1 ? { max: round(map.max) } : {}) };
      if (map.target.kind === 'device') {
        const di = rack.chains[map.target.chainId].deviceOrder.indexOf(map.target.deviceId);
        if (di < 0) continue;
        maps.push({ ...base, target: 'device', device: di });
      } else maps.push({ ...base, target: map.target.kind });
    }
    const named = m.name && m.name !== `Macro ${i + 1}`;
    return { ...(named ? { name: m.name } : {}), ...(maps.length ? { maps } : {}) };
  });
  // Trailing default macros are left out.
  while (macros.length && !macros[macros.length - 1].name && !macros[macros.length - 1].maps) macros.pop();
  const spec: PresetRack = { kind: rack.kind, chains };
  if (macros.length) spec.macros = macros;
  const variations = rack.variationOrder.map((id) => rack.variations[id]).filter((v) => !!v);
  if (variations.length) spec.variations = variations.map((v) => ({ name: v.name || 'Variation', values: v.values.map(round) }));
  return spec;
}
