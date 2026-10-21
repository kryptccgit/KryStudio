import type { ActionResult } from '@shared/types';
import type { ChainPreset, FactoryIndex, InstrumentPreset, Preset, PresetSummary } from '@shared/sounds/types';

export interface SoundsAccess {
  presets(): readonly Preset[];
  preset(id: string): Preset | undefined;
  factoryIndex(): FactoryIndex | null;
  saveUser(p: InstrumentPreset | ChainPreset): ActionResult<PresetSummary>;
  deleteUser(id: string): ActionResult;
}
