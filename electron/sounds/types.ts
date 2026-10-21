// What the rest of main (MCP tools, agent panel, IPC) uses from the sounds
// service (electron/sounds/service.ts, owned by sounds-core).

import type { ActionResult } from '@shared/types';
import type { ChainPreset, FactoryIndex, InstrumentPreset, Preset, PresetSummary } from '@shared/sounds/types';

export interface SoundsAccess {
  /** Factory + user presets (user presets reloaded from userData/presets when they change). */
  presets(): readonly Preset[];
  preset(id: string): Preset | undefined;
  /**
   * The sample index: resources/factory/index.json plus installed sound packs' samples ('pack:<id>/…', after the
   * factory's). Null when neither is there (the factory kit isn't installed / readable and no sample pack is).
   */
  factoryIndex(): FactoryIndex | null;
  /**
   * Store a user preset (validated with zPreset; the id becomes 'user:<slug>' / 'user:chain/<slug>', made unique;
   * written atomically to userData/presets/<slug>.json). Returns its summary.
   */
  saveUser(p: InstrumentPreset | ChainPreset): ActionResult<PresetSummary>;
  deleteUser(id: string): ActionResult;
}
