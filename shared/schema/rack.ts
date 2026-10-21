import { z } from 'zod';
import type { FxSlot, Generator, Id } from './project';

export const RACK_PLUGIN = 'krypt.rack';
export const DRUM_RACK_PLUGIN = 'krypt.drumrack';
export const FX_RACK_PLUGIN = 'krypt.fxrack';
export const MACRO_COUNT = 8;
export const MACRO_PARAM_IDS = ['macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8'] as const;
export const MAX_RACK_CHAINS = 128;
export const DRUM_RACK_BASE_NOTE = 36;
export const DRUM_RACK_PADS = 16;

export type RackKind = 'instrument' | 'drum' | 'effect';

export interface RackZone {
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
}

export type MacroTarget =
  | { chainId: Id; kind: 'instrument'; param: string }
  | { chainId: Id; kind: 'device'; deviceId: Id; param: string }
  | { chainId: Id; kind: 'chain'; param: 'volume' | 'pan' };

export interface MacroMap {
  id: Id;
  target: MacroTarget;
  min: number;
  max: number;
}

export interface RackMacro {
  name: string;
  maps: Record<Id, MacroMap>;
}

export interface RackVariation {
  id: Id;
  name: string;
  values: number[];
}

export interface RackChain {
  id: Id;
  name: string;
  color: string | null;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  zone?: RackZone;
  instrument?: Generator;
  devices: Record<Id, FxSlot>;
  deviceOrder: Id[];
  choke?: number;
}

export interface RackDef {
  kind: RackKind;
  chains: Record<Id, RackChain>;
  chainOrder: Id[];
  macros: RackMacro[];
  variations: Record<Id, RackVariation>;
  variationOrder: Id[];
}

export function emptyRack(kind: RackKind): RackDef {
  return {
    kind,
    chains: {},
    chainOrder: [],
    macros: Array.from({ length: MACRO_COUNT }, (_, i) => ({ name: `Macro ${i + 1}`, maps: {} })),
    variations: {},
    variationOrder: [],
  };
}

export function isRackPlugin(type: string): boolean {
  return type === RACK_PLUGIN || type === DRUM_RACK_PLUGIN || type === FX_RACK_PLUGIN;
}

export const zGeneratorBase = z.object({
  type: z.string(),
  params: z.record(z.string(), z.number()),
  sampleId: z.string().min(1).nullable(),
  state: z.string().optional(),
  preset: z.object({ id: z.string().max(200), name: z.string().max(64) }).optional(),
});

export const zFxSlotBase = z.object({
  id: z.string().min(1),
  type: z.string(),
  enabled: z.boolean(),
  mix: z.number().min(0).max(1),
  params: z.record(z.string(), z.number()),
  state: z.string().optional(),
  sidechainFrom: z.string().min(1).nullable(),
});

const zMacroTarget = z.union([
  z.object({ chainId: z.string().min(1), kind: z.literal('instrument'), param: z.string().min(1) }),
  z.object({ chainId: z.string().min(1), kind: z.literal('device'), deviceId: z.string().min(1), param: z.string().min(1) }),
  z.object({ chainId: z.string().min(1), kind: z.literal('chain'), param: z.enum(['volume', 'pan']) }),
]);

export const zRack = z.object({
  kind: z.enum(['instrument', 'drum', 'effect']),
  chains: z.record(
    z.string(),
    z.object({
      id: z.string().min(1),
      name: z.string(),
      color: z.string().nullable(),
      volume: z.number().min(0).max(2),
      pan: z.number().min(-1).max(1),
      mute: z.boolean(),
      solo: z.boolean(),
      zone: z
        .object({
          keyLo: z.number().int().min(0).max(127),
          keyHi: z.number().int().min(0).max(127),
          velLo: z.number().min(0).max(1),
          velHi: z.number().min(0).max(1),
        })
        .optional(),
      instrument: zGeneratorBase.optional(),
      devices: z.record(z.string(), zFxSlotBase),
      deviceOrder: z.array(z.string().min(1)),
      choke: z.number().int().min(0).max(32).optional(),
    }),
  ),
  chainOrder: z.array(z.string().min(1)),
  macros: z
    .array(
      z.object({
        name: z.string().max(32),
        maps: z.record(
          z.string(),
          z.object({ id: z.string().min(1), target: zMacroTarget, min: z.number().min(0).max(1), max: z.number().min(0).max(1) }),
        ),
      }),
    )
    .length(MACRO_COUNT),
  variations: z.record(
    z.string(),
    z.object({ id: z.string().min(1), name: z.string().max(64), values: z.array(z.number().min(0).max(1)).length(MACRO_COUNT) }),
  ),
  variationOrder: z.array(z.string().min(1)),
});
