import { CATALOG } from '@shared/plugins/catalog';
import type { ParamSpec, PluginDescriptor } from '@shared/plugins/types';
import { DRUM_RACK_PLUGIN, FX_RACK_PLUGIN, MACRO_PARAM_IDS, RACK_PLUGIN } from '@shared/schema/rack';

const MACROS: ParamSpec[] = MACRO_PARAM_IDS.map((id, i) => ({ id, name: `Macro ${i + 1}`, min: 0, max: 1, default: 0, unit: '', scale: 'linear', group: 'Macros' }));

export const RACK_FIXTURES: PluginDescriptor[] = [
  { id: RACK_PLUGIN, name: 'Krypt Rack', kind: 'instrument', category: 'Rack', description: 'Instrument rack: parallel chains by key and velocity zone, 8 macros.', params: MACROS },
  { id: DRUM_RACK_PLUGIN, name: 'Krypt Drum Rack', kind: 'instrument', category: 'Rack', description: 'Drum rack: one chain per pad, choke groups, 8 macros.', params: MACROS },
  { id: FX_RACK_PLUGIN, name: 'Krypt FX Rack', kind: 'effect', category: 'Rack', description: 'Effect rack: parallel effect chains, 8 macros.', params: MACROS, defaultMix: 1 },
];

export function installRackFixtures(): void {
  for (const d of RACK_FIXTURES) if (!CATALOG.plugins.some((p) => p.id === d.id)) CATALOG.plugins.push(d);
  const sampler = CATALOG.plugins.find((p) => p.id === 'krypt.sampler');
  if (sampler && !sampler.params.some((p) => p.id === 'end')) {
    const at = sampler.params.findIndex((p) => p.id === 'start') + 1;
    sampler.params.splice(at, 0, { id: 'end', name: 'End', min: 0, max: 1, default: 1, unit: '%', scale: 'linear', group: sampler.params[at - 1]?.group });
  }
}
