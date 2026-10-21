// ──────────────────────────────────────────────────────────────────────
// Racks and macros, Wave 12.2 (research/16-ableton-parity.md §2.3).
//
// A rack is a stock device that holds parallel CHAINS:
//  - instrument rack: channel generator 'krypt.rack' with `Generator.rack`
//    (kind 'instrument'): each chain = one instrument + its effects, picked
//    by key / velocity zone, all chains summed;
//  - drum rack: channel generator 'krypt.drumrack' (kind 'drum'): each chain
//    is a PAD (zone keyLo = keyHi = the pad's note) with its own instrument
//    (usually the sampler) and effects, plus a choke group;
//  - effect rack: mixer slot 'krypt.fxrack' with `FxSlot.rack` (kind
//    'effect'): the input is split into every chain, each runs its effects,
//    and the chains are summed.
//
// MACROS: every rack device has 8 automatable params `macro1`..`macro8`
// (0..1, default 0) in its normal `params` (so automation, set_params,
// controller links and MIDI learn work unchanged). `RackDef.macros[i]` names
// macro i+1 and maps it onto inner params: inner = min + v·(max − min) in the
// inner param's NORMALIZED 0..1 space (catalog ParamSpec scale). Several
// macros mapping one inner param: the last mapping in macro order wins.
// VARIATIONS are named snapshots of the 8 macro values.
//
// v1 limits (engine refuses with a warning, UI/commands never create them):
// no third-party plugins inside racks, no racks inside racks, max
// MAX_RACK_CHAINS chains and MAX_FX_SLOTS devices per chain.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { FxSlot, Generator, Id } from './project';

export const RACK_PLUGIN = 'krypt.rack';
export const DRUM_RACK_PLUGIN = 'krypt.drumrack';
export const FX_RACK_PLUGIN = 'krypt.fxrack';
export const MACRO_COUNT = 8;
export const MACRO_PARAM_IDS = ['macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8'] as const;
export const MAX_RACK_CHAINS = 128;
/** Default first pad note of a drum rack (C2 with C4 = 60) and the 4×4 pad view. */
export const DRUM_RACK_BASE_NOTE = 36;
export const DRUM_RACK_PADS = 16;

export type RackKind = 'instrument' | 'drum' | 'effect';

export interface RackZone {
  /** MIDI keys, inclusive (0..127). */
  keyLo: number;
  keyHi: number;
  /** Velocity 0..1, inclusive. */
  velLo: number;
  velHi: number;
}

/** What a macro mapping targets inside the rack. */
export type MacroTarget =
  | { chainId: Id; kind: 'instrument'; param: string }
  | { chainId: Id; kind: 'device'; deviceId: Id; param: string } // param 'mix' = the device's wet/dry
  | { chainId: Id; kind: 'chain'; param: 'volume' | 'pan' };

export interface MacroMap {
  id: Id;
  target: MacroTarget;
  /** Normalized 0..1 range of the inner param the macro sweeps (min may be > max to invert). */
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
  /** MACRO_COUNT values 0..1. */
  values: number[];
}

export interface RackChain {
  id: Id;
  name: string;
  color: string | null;
  volume: number; // linear, 1 = 0 dB, max 2
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  /** instrument / drum racks: which notes reach this chain (absent = all). */
  zone?: RackZone;
  /** instrument / drum racks: the chain's sound source. Never a rack, never third-party (v1). */
  instrument?: Generator;
  /** Effects after the instrument (or on the split input, effect racks). Never racks / third-party (v1). */
  devices: Record<Id, FxSlot>;
  deviceOrder: Id[];
  /** drum racks: pads in the same choke group > 0 cut each other (open / closed hats). */
  choke?: number;
}

export interface RackDef {
  kind: RackKind;
  chains: Record<Id, RackChain>;
  chainOrder: Id[];
  /** Exactly MACRO_COUNT entries. */
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

// ── Zod (shared with project.ts, which extends the base generator / slot) ──

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
