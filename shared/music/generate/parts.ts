// Chord, arpeggio and bassline generators. Chords come from a progression
// (preset or numerals) voiced with voice leading; the arp and the bass
// follow the chords already in the pattern, or a progression.

import type { ArpOptions, BassOptions, ChordOptions } from './options';
import { RATE_TICKS } from './options';
import { makeRng, type Rng } from './random';
import {
  applyVoicing,
  chordAt,
  chordPcs,
  degreeToMidi,
  inKey,
  midiToDegree,
  mod12,
  resolveProgression,
  scaleSteps,
  voiceClose,
  type ChordEvent,
  type GenKey,
} from './harmony';
import { chordNames, chordTimeline, vel3, type GenContext, type GenNote, type GenOutput } from './context';

// ── Chords ────────────────────────────────────────────────────────────

/** Stab rhythms in 16th steps of a 16-step bar (cut to shorter bars). */
const STABS = [
  [0, 3, 6],
  [0, 3, 6, 10],
  [0, 6, 10],
  [2, 6, 10, 14],
  [0, 3, 8, 11],
  [0, 6, 8, 14],
];

interface Hit {
  tick: number;
  dur: number;
  accent: boolean;
}

function chordHits(rhythm: ChordOptions['rhythm'], t0: number, t1: number, ctx: GenContext, rng: Rng): Hit[] {
  const beat = ctx.beatTicks;
  const out: Hit[] = [];
  const every = (len: number, offset: number, gate: number): void => {
    for (let t = t0 + offset; t < t1; t += len) out.push({ tick: t, dur: Math.max(1, Math.round(Math.min(len * gate, t1 - t))), accent: (t - ctx.start) % ctx.barTicks === 0 });
  };
  switch (rhythm) {
    case 'whole':
      out.push({ tick: t0, dur: Math.max(1, t1 - t0 - 10), accent: true });
      break;
    case 'halves':
      every(beat * 2, 0, 0.96);
      break;
    case 'quarters':
      every(beat, 0, 0.88);
      break;
    case 'offbeat':
      every(beat, beat / 2, 0.42);
      break;
    case 'pulse':
      every(beat / 2, 0, 0.8);
      break;
    case 'stabs': {
      const step = beat / 4;
      const firstBar = Math.floor((t0 - ctx.start) / ctx.barTicks);
      for (let b = firstBar; ctx.start + b * ctx.barTicks < t1; b++) {
        const bar0 = ctx.start + b * ctx.barTicks;
        const tpl = b === 0 ? STABS[0] : rng.pick(STABS);
        for (const s of tpl) {
          const t = bar0 + s * step;
          if (t >= t0 && t < t1 && s * step < ctx.barTicks) out.push({ tick: t, dur: Math.max(1, Math.min(Math.round(step * 1.6), t1 - t)), accent: s === 0 });
        }
      }
      if (!out.some((h) => h.tick === t0)) out.unshift({ tick: t0, dur: Math.max(1, Math.min(Math.round(step * 1.6), t1 - t0)), accent: true });
      break;
    }
  }
  return out;
}

export function generateChords(o: ChordOptions, ctx: GenContext): GenOutput {
  const rng = makeRng(ctx.seed, 0x22);
  const prog = resolveProgression(o.progression, ctx.key, o.extensions, rng.fork(1));
  const hum = rng.fork(3);
  const stabRng = rng.fork(4);
  const slot = Math.max(1, Math.round(o.barsPerChord * ctx.barTicks));
  const center = (o.octave + 1) * 12 + 4;
  const notes: GenNote[] = [];
  const events: ChordEvent[] = [];
  let prev: number[] | null = null;
  for (let t = ctx.start, i = 0; t < ctx.end; t += slot, i++) {
    const c = prog.chords[i % prog.chords.length];
    const close = voiceClose(c, center, o.inversion, prev);
    prev = close;
    const keys = applyVoicing(close, c, o.voicing).filter((k) => k >= 0 && k <= 127);
    const end = Math.min(ctx.end, t + slot);
    events.push({ tick: t, end, keys, root: c.root, tones: c.tones, name: c.name });
    for (const h of chordHits(o.rhythm, t, end, ctx, stabRng)) {
      const v = o.velocity + (h.accent ? 0.06 : 0) + hum.jitter(0.035);
      for (const k of keys) notes.push({ tick: h.tick, dur: h.dur, key: k, vel: vel3(v + hum.jitter(0.015)) });
    }
  }
  return { notes, chords: chordNames(events, ctx.start, ctx.end), chordSource: 'progression', detail: `${prog.label}, ${o.voicing} voicing, ${o.rhythm}` };
}

// ── Arpeggio ──────────────────────────────────────────────────────────

/** One arp cycle over ascending keys. */
export function arpCycle(keys: number[], style: Exclude<ArpOptions['style'], 'random'>): number[] {
  const up = [...keys].sort((a, b) => a - b);
  const down = [...up].reverse();
  switch (style) {
    case 'up':
      return up;
    case 'down':
      return down;
    case 'upDown':
      return up.concat(down.slice(1, -1));
    case 'downUp':
      return down.concat(up.slice(1, -1));
    case 'converge': {
      const out: number[] = [];
      for (let lo = 0, hi = up.length - 1; lo <= hi; lo++, hi--) {
        out.push(up[lo]);
        if (hi !== lo) out.push(up[hi]);
      }
      return out;
    }
  }
}

export function generateArp(o: ArpOptions, ctx: GenContext): GenOutput {
  const rng = makeRng(ctx.seed, 0x33);
  const tl = chordTimeline(o, ctx, rng.fork(1));
  const pick = rng.fork(2);
  const hum = rng.fork(3);
  const rate = RATE_TICKS[o.rate];
  const notes: GenNote[] = [];
  let cur: ChordEvent | null = null;
  let seq: number[] = [];
  let idx = 0;
  let prev = -1;
  for (let t = ctx.start; t < ctx.end; t += rate) {
    const ev = chordAt(tl.events, t);
    if (!ev) continue;
    if (ev !== cur) {
      cur = ev;
      idx = 0;
      const all: number[] = [];
      for (let oc = 0; oc < o.octaves; oc++) for (const k of ev.keys) if (k + 12 * oc <= 127) all.push(k + 12 * oc);
      seq = o.style === 'random' ? [...new Set(all)] : arpCycle([...new Set(all)], o.style);
    }
    if (!seq.length) continue;
    let key: number;
    if (o.style === 'random') {
      let j = Math.floor(pick.next() * seq.length);
      if (seq.length > 1 && seq[j] === prev) j = (j + 1 + Math.floor(pick.next() * (seq.length - 1))) % seq.length;
      key = seq[j];
    } else key = seq[idx % seq.length];
    idx++;
    prev = key;
    const stop = Math.min(ctx.end, ev.tick > t ? ev.tick : nextChange(tl.events, t, ctx.end));
    const dur = Math.max(1, Math.min(Math.round(rate * o.gate), stop - t));
    const onBeat = (t - ctx.start) % ctx.beatTicks === 0;
    notes.push({ tick: t, dur, key, vel: vel3(o.velocity + (onBeat ? 0.08 : 0) + hum.jitter(0.03)) });
  }
  return { notes, chords: chordNames(tl.events, ctx.start, ctx.end), chordSource: tl.source, detail: `${o.style} ${o.rate} over ${tl.label}` };
}

/** Tick of the next chord change after `t` (or `end`). */
function nextChange(events: ChordEvent[], t: number, end: number): number {
  for (const e of events) if (e.tick > t + 10) return Math.min(e.tick, end);
  return end;
}

// ── Bassline ──────────────────────────────────────────────────────────

type BassRhythm = Exclude<BassOptions['rhythm'], 'auto'>;

/** [16th step, length in steps] in a 16-step bar; several takes per rhythm. */
const BASS_RHYTHMS: Record<BassRhythm, Array<Array<[number, number]>>> = {
  whole: [[[0, 16]]],
  halves: [[[0, 8], [8, 8]]],
  quarters: [[[0, 4], [4, 4], [8, 4], [12, 4]]],
  eighths: [Array.from({ length: 8 }, (_, i) => [i * 2, 2] as [number, number])],
  offbeat: [[[2, 2], [6, 2], [10, 2], [14, 2]]],
  tresillo: [[[0, 3], [3, 3], [6, 2], [8, 3], [11, 3], [14, 2]]],
  trap: [
    [[0, 6], [6, 4], [10, 6]],
    [[0, 10], [10, 3], [13, 3]],
    [[0, 3], [3, 7], [10, 2], [12, 4]],
    [[0, 7], [7, 5], [14, 2]],
  ],
  funk: [
    [[0, 2], [3, 1], [6, 2], [8, 1], [10, 2], [11, 1], [14, 2]],
    [[0, 3], [4, 1], [6, 2], [9, 2], [12, 1], [14, 2]],
  ],
};

const AUTO_RHYTHM: Record<BassOptions['style'], BassRhythm> = { root: 'eighths', rootFifth: 'quarters', octave: 'eighths', walking: 'quarters', glide808: 'trap' };

/** The bass register: the pitch class within a fifth above / below the key root at `octave`. */
function bassNote(pc: number, key: GenKey, octave: number): number {
  const base = (octave + 1) * 12 + key.root;
  const k = base + mod12(pc - key.root);
  return k > base + 7 ? k - 12 : k;
}

function fifthOf(ev: { tones: number[] }): number {
  return ev.tones.find((t) => t === 7) ?? ev.tones.find((t) => t === 6 || t === 8) ?? 7;
}

/** A note leading into `target`: a scale step above or below, or a half step below. */
function approach(target: number, key: GenKey, rng: Rng): number {
  const steps = scaleSteps(key.scale);
  const d = midiToDegree(target, key, steps);
  const opts = [degreeToMidi(d - 1, key, steps), degreeToMidi(d + 1, key, steps), target - 1].filter((k) => k !== target);
  const k = opts[rng.weighted([3, 2, inKey(target - 1, key) ? 1 : 1.5])];
  return k ?? target - 1;
}

export function generateBass(o: BassOptions, ctx: GenContext): GenOutput {
  const rng = makeRng(ctx.seed, 0x44);
  const tl = chordTimeline({ ...o, extensions: 'triads', octave: 3 }, ctx, rng.fork(1));
  const tplRng = rng.fork(2);
  const walk = rng.fork(3);
  const hum = rng.fork(4);
  const rhythm = o.rhythm === 'auto' ? AUTO_RHYTHM[o.style] : o.rhythm;
  const step = ctx.beatTicks / 4;
  const barSteps = Math.max(1, Math.round(ctx.barTicks / step));
  // hit positions: the rhythm per bar, plus every chord change
  const starts = new Set<number>();
  const lens = new Map<number, number>();
  for (let b = 0; ctx.start + b * ctx.barTicks < ctx.end; b++) {
    const takes = BASS_RHYTHMS[rhythm];
    const tpl = b === 0 ? takes[0] : takes[tplRng.int(0, takes.length - 1)];
    for (let off = 0; off < barSteps; off += 16) {
      for (const [s, l] of tpl) {
        if (off + s >= barSteps) continue;
        const t = ctx.start + b * ctx.barTicks + (off + s) * step;
        if (t < ctx.end) {
          starts.add(t);
          lens.set(t, l * step);
        }
      }
    }
  }
  for (const e of tl.events) if (e.tick >= ctx.start && e.tick < ctx.end && !starts.has(e.tick)) {
    starts.add(e.tick);
    lens.set(e.tick, ctx.beatTicks);
  }
  const ticks = [...starts].sort((a, b) => a - b);
  const notes: GenNote[] = [];
  let j = 0;
  let cur: ChordEvent | null = null;
  let prevKey = -1;
  ticks.forEach((t, i) => {
    const ev = chordAt(tl.events, t);
    if (!ev) return;
    if (ev !== cur) {
      cur = ev;
      j = 0;
    }
    const next = ticks[i + 1] ?? ctx.end;
    const nextEv = chordAt(tl.events, next < ctx.end ? next : t);
    const lastBeforeChange = next < ctx.end && nextEv !== ev && j > 0;
    const root = bassNote(ev.root, ctx.key, o.octave);
    let key = root;
    let slide = false;
    switch (o.style) {
      case 'root':
        break;
      case 'rootFifth':
        key = j % 2 === 1 ? root + fifthOf(ev) : root;
        break;
      case 'octave':
        key = j % 2 === 1 ? root + 12 : root;
        break;
      case 'glide808':
        if (j > 0 && walk.chance(0.3)) key = walk.chance(0.6) ? root + 12 : root + fifthOf(ev);
        break;
      case 'walking': {
        if (j === 0) break;
        const target = nextEv && nextEv !== ev ? bassNote(nextEv.root, ctx.key, o.octave) : root;
        if (lastBeforeChange) {
          key = approach(target, ctx.key, walk);
          break;
        }
        // chord tones (and the octave) nearest a line from the root toward the next root
        const pcs = chordPcs(ev);
        const span = Math.max(1, (nextEv && nextEv !== ev ? nextEv.tick : ev.end) - ev.tick);
        const aim = root + ((target - root) * (t - ev.tick)) / span + walk.jitter(3);
        const cands: number[] = [];
        for (let k = root - 5; k <= root + 12; k++) if (pcs.includes(mod12(k)) && k !== prevKey) cands.push(k);
        key = cands.sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim))[0] ?? root;
        break;
      }
    }
    if (o.style !== 'walking' && lastBeforeChange && nextEv && walk.chance(o.passing)) key = approach(bassNote(nextEv.root, ctx.key, o.octave), ctx.key, walk);
    if (o.style === 'glide808' && prevKey >= 0 && key !== prevKey && walk.chance(0.6)) slide = true;
    key = Math.max(0, Math.min(127, key));
    const room = Math.min(next, ctx.end) - t;
    const len = lens.get(t) ?? step * 2;
    const dur = o.style === 'glide808' ? room : Math.max(1, Math.round(Math.min(len, room) * o.gate));
    const accent = (t - ctx.start) % ctx.beatTicks === 0;
    notes.push({ tick: t, dur: Math.max(1, dur), key, vel: vel3(o.velocity + (accent ? 0.06 : -0.02) + hum.jitter(0.04)), ...(slide ? { slide: true } : {}) });
    prevKey = key;
    j++;
  });
  return { notes, chords: chordNames(tl.events, ctx.start, ctx.end), chordSource: tl.source, detail: `${o.style} on ${rhythm}, following ${tl.label}` };
}

