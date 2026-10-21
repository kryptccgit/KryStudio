// Rhythm generator: Euclidean (pulses spread as evenly as possible over
// steps, Toussaint / Bjorklund) or density by metric weight, with accents,
// ghost notes and 32nd rolls. One pitch: drums, or any channel.

import type { RhythmOptions } from './options';
import { RATE_TICKS } from './options';
import { makeRng } from './random';
import { vel3, type GenContext, type GenNote, type GenOutput } from './context';

/** Bjorklund's algorithm: E(3,8) = x..x..x. ; rotation shifts the start left. */
export function euclid(pulses: number, steps: number, rotation = 0): boolean[] {
  const n = Math.max(1, Math.floor(steps));
  const k = Math.max(0, Math.min(n, Math.floor(pulses)));
  let out: number[];
  if (k === 0) out = new Array(n).fill(0);
  else if (k === n) out = new Array(n).fill(1);
  else {
    let a: number[][] = Array.from({ length: k }, () => [1]);
    let b: number[][] = Array.from({ length: n - k }, () => [0]);
    while (b.length > 1) {
      const m = Math.min(a.length, b.length);
      const joined = a.slice(0, m).map((x, i) => [...x, ...b[i]]);
      const rest = a.length > m ? a.slice(m) : b.slice(m);
      a = joined;
      b = rest;
    }
    out = [...a.flat(), ...b.flat()];
  }
  const r = ((Math.floor(rotation) % n) + n) % n;
  return out.slice(r).concat(out.slice(0, r)).map((v) => v === 1);
}

/** "x..x..x." for a pattern. */
export function euclidString(p: boolean[]): string {
  return p.map((h) => (h ? 'x' : '.')).join('');
}

/** Metric weight of a tick in its bar: 1 downbeat, .8 beats, .55 8ths, .35 16ths, .2 finer. */
export function metricWeight(tick: number, barTicks: number, beatTicks: number): number {
  const t = ((tick % barTicks) + barTicks) % barTicks;
  if (t === 0) return 1;
  if (t % beatTicks === 0) return 0.8;
  if (t % (beatTicks / 2) === 0) return 0.55;
  if (t % (beatTicks / 4) === 0) return 0.35;
  return 0.2;
}

export function generateRhythm(o: RhythmOptions, ctx: GenContext): GenOutput {
  const rng = makeRng(ctx.seed, 0x11);
  const fill = rng.fork(2);
  const step = RATE_TICKS[o.rate];
  const pitch = o.note ?? ctx.defaultNote;
  const pattern = o.mode === 'euclid' ? euclid(Math.min(o.pulses, o.steps), o.steps, o.rotation) : null;
  const slots: Array<{ tick: number; hit: boolean; w: number }> = [];
  for (let t = ctx.start, i = 0; t < ctx.end; t += step, i++) {
    const w = metricWeight(t - ctx.start, ctx.barTicks, ctx.beatTicks);
    let hit: boolean;
    if (pattern) hit = pattern[i % pattern.length];
    else hit = o.density > 0 && (((t - ctx.start) % ctx.barTicks === 0 && o.density >= 0.15) || rng.next() < Math.min(1, o.density * (0.25 + 1.25 * w)));
    slots.push({ tick: t, hit, w });
  }
  const accentAt = (t: number, i: number): boolean => {
    const rel = (t - ctx.start) % ctx.barTicks;
    switch (o.accents) {
      case 'none':
        return false;
      case 'downbeats':
        return rel % ctx.beatTicks === 0;
      case 'backbeat':
        return rel % (ctx.beatTicks * 2) === ctx.beatTicks;
      case 'offbeats':
        return rel % ctx.beatTicks === ctx.beatTicks / 2;
      case 'random':
        return fill.fork(i).chance(0.3);
    }
  };
  const notes: GenNote[] = [];
  const dur = Math.max(1, Math.round(step * o.gate));
  const accent = Math.min(1, o.velocity + 0.17);
  let busy = -1; // a roll covers the slots it spans
  slots.forEach((s, i) => {
    const end = Math.min(ctx.end, s.tick + step);
    if (!s.hit) {
      if (s.tick >= busy && fill.chance(o.ghosts * (s.w < 0.5 ? 1 : 0.4))) notes.push({ tick: s.tick, dur: Math.min(dur, end - s.tick), key: pitch, vel: vel3(0.3 + fill.jitter(0.06)) });
      return;
    }
    const v = (accentAt(s.tick, i) ? accent : o.velocity) + rng.jitter(0.04);
    // a roll: the hit becomes 32nds up to the next hit (at most 1 beat), louder toward the end
    const nearBarEnd = (s.tick - ctx.start) % ctx.barTicks >= ctx.barTicks - ctx.beatTicks;
    const sub = step / 2;
    if (o.rolls > 0 && sub >= 60 && fill.chance(o.rolls * (nearBarEnd ? 0.9 : 0.25))) {
      const next = slots.slice(i + 1).find((x) => x.hit)?.tick ?? ctx.end;
      const span = Math.min(next, s.tick + Math.max(step, Math.min(ctx.beatTicks, step * 2)), ctx.end) - s.tick;
      const parts = Math.max(2, Math.floor(span / sub));
      busy = s.tick + parts * sub;
      for (let j = 0; j < parts; j++) {
        notes.push({ tick: s.tick + j * sub, dur: Math.max(1, Math.round(sub * 0.6)), key: pitch, vel: vel3(v * (0.55 + (0.45 * (j + 1)) / parts)) });
      }
      return;
    }
    notes.push({ tick: s.tick, dur: Math.min(dur, end - s.tick), key: pitch, vel: vel3(v) });
  });
  const detail = pattern ? `E(${Math.min(o.pulses, o.steps)},${o.steps})${o.rotation ? ` rotation ${o.rotation}` : ''} = ${euclidString(pattern)}` : `density ${Math.round(o.density * 100)}%`;
  return { notes, detail };
}
