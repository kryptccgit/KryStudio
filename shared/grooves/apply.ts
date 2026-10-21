// Apply a groove template to notes: pure + deterministic (no randomness, no I/O).
//
// Timing: each note is measured against the straight 16th grid. A note on (or near) a grid step
// moves by `amount` × the template's mean offset for that step, keeping its own small deviation.
// A note already sitting on the grooved position stays put, so applying a groove twice doesn't
// push notes further. Notes far off the grid (triplets, rolls, flams) move with their nearest
// step so they stay attached to the notes around them. Notes never move before 0 or to/after
// the pattern end, and a note that ended inside the pattern still does.
//
// Velocity: multiplied by 1 + velocity × (accent − 1), where accent is the template's relative
// velocity for the note's class and step; the result stays within MIDI 1..127.
//
// The instrument class comes from the channel name via roleFromName (shared/sounds/select.ts):
// kick → kick; snare / clap → snare; hat / open hat / ride → hihat; anything else → other.

import { roleFromName } from '../sounds/select';
import type { InstrumentRole } from '../sounds/types';
import { GROOVE_TEMPLATES } from './templates.gen';
import type { GrooveClass, GrooveTemplate } from './types';

export { GROOVE_TEMPLATES, GROOVE_ATTRIBUTION } from './templates.gen';
export * from './types';

/** Template ids in display order (hiphop, funk, soul, …). */
export const GROOVE_IDS: readonly string[] = GROOVE_TEMPLATES.map((t) => t.id);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A template by id or label, case- and space-insensitive ("hip hop" → hiphop). */
export function findGroove(name: string): GrooveTemplate | null {
  const q = squash(name);
  if (!q) return null;
  return GROOVE_TEMPLATES.find((t) => t.id === q || squash(t.label) === q) ?? null;
}

/** "Hip hop (32 drummer performances)". Used in tool descriptions and messages. */
export function grooveSummary(t: GrooveTemplate): string {
  return `${t.label} (${t.performances} drummer performance${t.performances === 1 ? '' : 's'})`;
}

/** The groove class for an instrument role. */
export function grooveClassForRole(role: InstrumentRole | string | null | undefined): GrooveClass {
  switch (role) {
    case 'kick':
      return 'kick';
    case 'snare':
    case 'clap':
      return 'snare';
    case 'hat':
    case 'openhat':
    case 'ride':
      return 'hihat';
    default:
      return 'other';
  }
}

/** The groove class a channel's name implies ("Kick" → kick, "Open Hat" → hihat, "Keys" → other). */
export function grooveClassForChannel(name: string): GrooveClass {
  return grooveClassForRole(roleFromName(name));
}

export interface GrooveNote {
  tick: number;
  dur: number;
  /** 0..1 (MIDI velocity / 127). */
  vel: number;
}

export interface ApplyGrooveOptions {
  /** A template, or its id / label. */
  template: GrooveTemplate | string;
  /** Timing: 0..1 share of the template's offsets (default 1). */
  amount?: number;
  /** Velocity: 0..1 share of the template's accents (default 0.5). */
  velocity?: number;
  /** Ticks per quarter note (default 960). */
  ppq?: number;
  /** Instrument class; default: from `channelName`, else "other". */
  class?: GrooveClass;
  channelName?: string;
  /** Pattern length in ticks. Notes inside it stay inside it. */
  length?: number;
  /** 16th steps per bar (16 in 4/4, 12 in 3/4). Template steps wrap every 16. Default 16. */
  stepsPerBar?: number;
}

/** A note within this many 16ths of a grid step (or of its grooved position) counts as on the grid. */
const ON_GRID = 0.25;

/** Lowest stored velocity: 0.008 × 127 = 1.016 → MIDI velocity 1. */
const MIN_VEL = 0.008;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Template step (0..15) for an absolute 16th index. */
function stepOf(k: number, stepsPerBar: number): number {
  return (((k % stepsPerBar) + stepsPerBar) % stepsPerBar) % 16;
}

/**
 * Returns a new array in the same order: changed notes are copies (other fields kept), unchanged
 * notes are the input objects. Throws on an unknown template id.
 */
export function applyGroove<T extends GrooveNote>(notes: readonly T[], opts: ApplyGrooveOptions): T[] {
  const t = typeof opts.template === 'string' ? findGroove(opts.template) : opts.template;
  if (!t) throw new Error(`Unknown groove "${String(opts.template)}" (use one of: ${GROOVE_IDS.join(', ')})`);
  const amount = clamp(opts.amount ?? 1, 0, 1);
  const velocity = clamp(opts.velocity ?? 0.5, 0, 1);
  const ppq = opts.ppq ?? 960;
  const six = ppq / 4;
  const spb = Math.max(1, Math.round(opts.stepsPerBar ?? 16));
  const cls = opts.class ?? (opts.channelName !== undefined ? grooveClassForChannel(opts.channelName) : 'other');
  const cells = t.classes[cls];
  const len = opts.length !== undefined && opts.length > 0 ? opts.length : Infinity;

  return notes.map((n) => {
    const q = n.tick / six;
    // Nearest anchor: a straight grid step k, or its grooved position k + offset. Ties prefer the straight grid, then the earlier step.
    let best = { k: Math.round(q), d: Infinity, grooved: false };
    let nearestStraight = { k: Math.round(q), d: Infinity };
    for (let k = Math.floor(q) - 1; k <= Math.floor(q) + 2; k++) {
      if (k < 0) continue;
      const off = cells.offset[stepOf(k, spb)];
      const dS = Math.abs(q - k);
      const dG = Math.abs(q - (k + off));
      if (dS < nearestStraight.d) nearestStraight = { k, d: dS };
      if (dS < best.d) best = { k, d: dS, grooved: false };
      if (dG < best.d) best = { k, d: dG, grooved: true };
    }
    let k: number;
    let shift: number;
    if (best.d > ON_GRID) {
      k = nearestStraight.k; // off-grid: ride along with the nearest step
      shift = amount * cells.offset[stepOf(k, spb)];
    } else {
      k = best.k;
      shift = best.grooved ? 0 : amount * cells.offset[stepOf(k, spb)];
    }

    let tick = n.tick;
    let dur = n.dur;
    const inside = n.tick >= 0 && n.tick < len;
    if (shift !== 0 && inside) {
      tick = clamp(Math.round(n.tick + shift * six), 0, Number.isFinite(len) ? len - 1 : Number.MAX_SAFE_INTEGER);
      if (tick !== n.tick && n.tick + n.dur <= len) dur = Math.max(1, Math.min(n.dur, len - tick));
    }

    let vel = n.vel;
    if (velocity > 0) {
      const v = clamp(n.vel * (1 + velocity * (cells.vel[stepOf(k, spb)] - 1)), MIN_VEL, 1);
      if (Math.abs(v - n.vel) > 1e-6) vel = Math.max(MIN_VEL, Math.round(v * 1000) / 1000);
    }
    return tick === n.tick && dur === n.dur && vel === n.vel ? n : { ...n, tick, dur, vel };
  });
}
