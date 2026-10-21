// ──────────────────────────────────────────────────────────────────────
// Clip launcher (the Session view), Wave 12.2 (research/16-ableton-parity.md §2.1).
//
// A grid of launch clips: one column per playlist track, one row per scene.
// Launching a clip loops it on its track from the next quantize boundary;
// while a track plays a launch clip, that track's arrangement clips are
// silent until "Back to arrangement". Optional and additive to schema 1:
// a project without `session` has an empty launcher.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { Id } from './project';

/** Launch quantization: when a launch takes effect. 'none' = immediately. */
export const LAUNCH_QUANTS = ['none', '1/16', '1/8', '1/4', '1/2', '1bar', '2bars', '4bars', '8bars'] as const;
export type LaunchQuant = (typeof LAUNCH_QUANTS)[number];

/**
 * After `afterBars` of playing, the clip runs `action` (with probability `chance`) else `otherAction`.
 *  stop: stop the track · again: restart this clip · next / previous: the clip in the next / previous
 *  scene row of this track (wraps; skips empty slots) · first / last: of this track · any: a random clip of
 *  this track (may repeat) · other: a random OTHER clip of this track · none: keep looping.
 */
export const FOLLOW_ACTIONS = ['none', 'stop', 'again', 'next', 'previous', 'first', 'last', 'any', 'other'] as const;
export type FollowAction = (typeof FOLLOW_ACTIONS)[number];

export interface FollowRule {
  action: FollowAction;
  /** 0..1: probability of `action`; otherwise `otherAction`. */
  chance: number;
  otherAction: FollowAction;
  /** Bars after launch (fractional allowed, > 0). */
  afterBars: number;
}

/**
 * trigger: click/note-on launches, note-off ignored · gate: plays only while held (note-off / mouse-up stops the
 * track) · toggle: launching the playing clip stops it · repeat: retriggers every quantize step while held.
 */
export const LAUNCH_MODES = ['trigger', 'gate', 'toggle', 'repeat'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export interface LaunchClip {
  id: Id;
  /** Column: a playlist track. */
  trackId: Id;
  /** Row: a scene. At most one clip per (trackId, sceneId). */
  sceneId: Id;
  kind: 'pattern' | 'audio';
  /** kind 'pattern'. */
  patternId?: Id;
  /** kind 'audio': the audio-clip channel (generator 'krypt.audioclip'), as on playlist audio clips. */
  channelId?: Id;
  /** Display name; absent = the pattern / channel name. */
  name?: string;
  color: string | null;
  /** Loop length in ticks (>= 1). */
  length: number;
  /** Ticks into the source where the loop starts. */
  offset: number;
  /** false = play once (length ticks) then stop the track. */
  loop: boolean;
  launchMode: LaunchMode;
  /** Absent = the session's global quantize. */
  quantize?: LaunchQuant;
  follow?: FollowRule;
  /** kind 'audio': linear gain. */
  gain?: number;
}

export interface Scene {
  id: Id;
  name: string;
  color: string | null;
  /** Launching the scene also sets the project tempo to this (null = keep). */
  tempo: number | null;
}

export interface Session {
  scenes: Record<Id, Scene>;
  sceneOrder: Id[];
  clips: Record<Id, LaunchClip>;
  /** Global launch quantize (default '1bar'). */
  quantize: LaunchQuant;
}

export const MAX_SCENES = 128;

export function emptySession(): Session {
  return { scenes: {}, sceneOrder: [], clips: {}, quantize: '1bar' };
}

/** Quantize step in ticks for a time signature (bar = PPQ·4·num/den). 0 = none. */
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

/** The clip in a slot, if any. */
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
