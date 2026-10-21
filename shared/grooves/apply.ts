import { roleFromName } from '../sounds/select';
import type { InstrumentRole } from '../sounds/types';
import { GROOVE_TEMPLATES } from './templates.gen';
import type { GrooveClass, GrooveTemplate } from './types';

export { GROOVE_TEMPLATES, GROOVE_ATTRIBUTION } from './templates.gen';
export * from './types';

export const GROOVE_IDS: readonly string[] = GROOVE_TEMPLATES.map((t) => t.id);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function findGroove(name: string): GrooveTemplate | null {
  const q = squash(name);
  if (!q) return null;
  return GROOVE_TEMPLATES.find((t) => t.id === q || squash(t.label) === q) ?? null;
}

export function grooveSummary(t: GrooveTemplate): string {
  return `${t.label} (${t.performances} drummer performance${t.performances === 1 ? '' : 's'})`;
}

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

export function grooveClassForChannel(name: string): GrooveClass {
  return grooveClassForRole(roleFromName(name));
}

export interface GrooveNote {
  tick: number;
  dur: number;
  vel: number;
}

export interface ApplyGrooveOptions {
  template: GrooveTemplate | string;
  amount?: number;
  velocity?: number;
  ppq?: number;
  class?: GrooveClass;
  channelName?: string;
  length?: number;
  stepsPerBar?: number;
}

const ON_GRID = 0.25;

const MIN_VEL = 0.008;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function stepOf(k: number, stepsPerBar: number): number {
  return (((k % stepsPerBar) + stepsPerBar) % stepsPerBar) % 16;
}

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
      k = nearestStraight.k;
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
