import { z } from 'zod';
import { GENRE_IDS } from './genres';
import { CHAIN_ROLES, INSTRUMENT_ROLES } from './types';
import { MACRO_COUNT, MAX_RACK_CHAINS } from '../schema/rack';
import { MAX_FX_SLOTS } from '../schema/project';

const zParams = z.record(z.string(), z.number().finite());
const zTags = z.array(z.string().min(1).max(32)).max(24);
const zGenres = z.array(z.enum(GENRE_IDS)).max(18);

const zPresetFxBase = z.object({
  type: z.string().min(1).max(200),
  params: zParams,
  mix: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
});

export const zPresetRack = z.object({
  kind: z.enum(['instrument', 'drum', 'effect']),
  chains: z
    .array(
      z.object({
        name: z.string().max(64),
        color: z.string().max(16).optional(),
        volume: z.number().min(0).max(2).optional(),
        pan: z.number().min(-1).max(1).optional(),
        mute: z.boolean().optional(),
        solo: z.boolean().optional(),
        zone: z
          .object({
            keyLo: z.number().int().min(0).max(127),
            keyHi: z.number().int().min(0).max(127),
            velLo: z.number().min(0).max(1),
            velHi: z.number().min(0).max(1),
          })
          .optional(),
        choke: z.number().int().min(0).max(32).optional(),
        instrument: z.object({ plugin: z.string().min(1).max(200), params: zParams, sample: z.string().max(400).optional() }).optional(),
        fx: z.array(zPresetFxBase).max(MAX_FX_SLOTS).optional(),
      }),
    )
    .max(MAX_RACK_CHAINS),
  macros: z
    .array(
      z.object({
        name: z.string().max(32).optional(),
        maps: z
          .array(
            z.object({
              chain: z.number().int().min(0),
              target: z.enum(['instrument', 'device', 'chain']),
              device: z.number().int().min(0).optional(),
              param: z.string().min(1).max(64),
              min: z.number().min(0).max(1).optional(),
              max: z.number().min(0).max(1).optional(),
            }),
          )
          .max(64)
          .optional(),
      }),
    )
    .max(MACRO_COUNT)
    .optional(),
  variations: z
    .array(z.object({ name: z.string().min(1).max(64), values: z.array(z.number().min(0).max(1)).length(MACRO_COUNT) }))
    .max(64)
    .optional(),
});

export const zPresetFx = zPresetFxBase.extend({ rack: zPresetRack.optional() });

export const zInstrumentPreset = z.object({
  kind: z.literal('instrument'),
  id: z.string().regex(/^(factory|user):[a-z0-9][a-z0-9/_-]*$/, 'preset ids look like factory:lead/anthem-supersaw or user:my-lead'),
  name: z.string().min(1).max(64),
  plugin: z.string().min(1).max(200),
  params: zParams,
  sample: z.string().max(400).optional(),
  requires: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).optional(),
  channel: z
    .object({
      volumeDb: z.number().min(-60).max(12).optional(),
      pan: z.number().min(-1).max(1).optional(),
      mono: z.boolean().optional(),
      glideMs: z.number().min(0).max(2000).optional(),
      rootKey: z.number().int().min(0).max(127).optional(),
      cutGroup: z.number().int().min(0).max(32).optional(),
      cutBy: z.number().int().min(0).max(32).optional(),
    })
    .optional(),
  fx: z.array(zPresetFx).max(12).optional(),
  rack: zPresetRack.optional(),
  role: z.enum(INSTRUMENT_ROLES),
  alsoRoles: z.array(z.enum(INSTRUMENT_ROLES)).max(6).optional(),
  tags: zTags,
  genres: zGenres,
  defaultFor: zGenres.optional(),
  description: z.string().max(300),
  range: z.tuple([z.number().int().min(0).max(127), z.number().int().min(0).max(127)]).optional(),
  author: z.string().max(64).optional(),
});

export const zChainPreset = z.object({
  kind: z.literal('chain'),
  id: z.string().regex(/^(factory|user):chain\/[a-z0-9][a-z0-9/_-]*$/, 'chain preset ids look like factory:chain/master/club-loud or user:chain/my-bus'),
  name: z.string().min(1).max(64),
  role: z.enum(CHAIN_ROLES),
  fx: z.array(zPresetFx).min(1).max(12),
  insert: z
    .object({
      volumeDb: z.number().min(-60).max(12).optional(),
      pan: z.number().min(-1).max(1).optional(),
      stereoSep: z.number().min(-1).max(1).optional(),
    })
    .optional(),
  targetLufs: z.number().min(-30).max(-3).optional(),
  tags: zTags,
  genres: zGenres,
  description: z.string().max(300),
  author: z.string().max(64).optional(),
});

export const zPreset = z.discriminatedUnion('kind', [zInstrumentPreset, zChainPreset]);
