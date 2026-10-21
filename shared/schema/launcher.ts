import { z } from 'zod';
import type { Id } from './project';

export const LAUNCH_QUANTS = ['none', '1/16', '1/8', '1/4', '1/2', '1bar', '2bars', '4bars', '8bars'] as const;
export type LaunchQuant = (typeof LAUNCH_QUANTS)[number];

export const FOLLOW_ACTIONS = ['none', 'stop', 'again', 'next', 'previous', 'first', 'last', 'any', 'other'] as const;
export type FollowAction = (typeof FOLLOW_ACTIONS)[number];

export interface FollowRule {
  action: FollowAction;
  chance: number;
  otherAction: FollowAction;
  afterBars: number;
}

export const LAUNCH_MODES = ['trigger', 'gate', 'toggle', 'repeat'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export interface LaunchClip {
  id: Id;
  trackId: Id;
  sceneId: Id;
  kind: 'pattern' | 'audio';
  patternId?: Id;
  channelId?: Id;
  name?: string;
  color: string | null;
  length: number;
  offset: number;
  loop: boolean;
  launchMode: LaunchMode;
  quantize?: LaunchQuant;
  follow?: FollowRule;
  gain?: number;
}

export interface Scene {
  id: Id;
  name: string;
  color: string | null;
  tempo: number | null;
}

export interface Session {
  scenes: Record<Id, Scene>;
  sceneOrder: Id[];
  clips: Record<Id, LaunchClip>;
  quantize: LaunchQuant;
}

export const MAX_SCENES = 128;

export function emptySession(): Session {
  return { scenes: {}, sceneOrder: [], clips: {}, quantize: '1bar' };
}

export function quantTicks(q: LaunchQuant, ppq: number, num: number, den: number): number {
  const bar = (ppq * 4 * num) / den;
  switch (q) {
    case 'none':
      return 0;
    case '1/16':
      return ppq / 4;
    case '1/8':
      return ppq / 2;
    case '1/4':
      return ppq;
    case '1/2':
      return ppq * 2;
    case '1bar':
      return bar;
    case '2bars':
      return bar * 2;
    case '4bars':
      return bar * 4;
    case '8bars':
      return bar * 8;
  }
}

export function clipAt(s: Session | undefined, trackId: Id, sceneId: Id): LaunchClip | undefined {
  if (!s) return undefined;
  for (const c of Object.values(s.clips)) if (c.trackId === trackId && c.sceneId === sceneId) return c;
  return undefined;
}

const zFollow = z.object({
  action: z.enum(FOLLOW_ACTIONS),
  chance: z.number().min(0).max(1),
  otherAction: z.enum(FOLLOW_ACTIONS),
  afterBars: z.number().positive().max(1024),
});

export const zSession = z.object({
  scenes: z.record(
    z.string(),
    z.object({ id: z.string().min(1), name: z.string(), color: z.string().nullable(), tempo: z.number().min(10).max(999).nullable() }),
  ),
  sceneOrder: z.array(z.string().min(1)),
  clips: z.record(
    z.string(),
    z.object({
      id: z.string().min(1),
      trackId: z.string().min(1),
      sceneId: z.string().min(1),
      kind: z.enum(['pattern', 'audio']),
      patternId: z.string().min(1).optional(),
      channelId: z.string().min(1).optional(),
      name: z.string().max(64).optional(),
      color: z.string().nullable(),
      length: z.number().min(1),
      offset: z.number().min(0),
      loop: z.boolean(),
      launchMode: z.enum(LAUNCH_MODES),
      quantize: z.enum(LAUNCH_QUANTS).optional(),
      follow: zFollow.optional(),
      gain: z.number().min(0).max(4).optional(),
    }),
  ),
  quantize: z.enum(LAUNCH_QUANTS),
});
