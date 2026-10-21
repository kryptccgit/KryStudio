// Every factory preset Krypt Studio ships. Instrument presets live in
// ./instruments (one file per role group), chain presets in ./chains.ts.
// test/presets-factory.test.ts checks every entry against the plugin catalog.

import type { ChainPreset, InstrumentPreset, Preset } from '../types';
import { INSTRUMENT_PRESETS } from './instruments';
import { CHAIN_PRESETS } from './chains';
import { RACK_PRESETS } from './racks';

export { INSTRUMENT_PRESETS, CHAIN_PRESETS, RACK_PRESETS };

/** Rack presets (./racks.ts, Wave 12.2) are listed here but not in INSTRUMENT_PRESETS / CHAIN_PRESETS. */
export const FACTORY_PRESETS: readonly Preset[] = [...INSTRUMENT_PRESETS, ...CHAIN_PRESETS, ...RACK_PRESETS];

const BY_ID = new Map<string, Preset>(FACTORY_PRESETS.map((p) => [p.id, p]));

export function factoryPreset(id: string): Preset | undefined {
  return BY_ID.get(id);
}

export function factoryInstrumentPresets(): readonly InstrumentPreset[] {
  return INSTRUMENT_PRESETS;
}

export function factoryChainPresets(): readonly ChainPreset[] {
  return CHAIN_PRESETS;
}
