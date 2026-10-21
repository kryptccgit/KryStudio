import { z } from 'zod';
import { defineCommand, must, CommandError } from './types';
import { defaultNote, patternLength, type Note, type Pattern, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { PPQ, ticksPerBar } from '../schema/time';
import { shapeCurve } from '../schema/automation';
import { CHORD_QUALITIES, SCALES } from '../music/theory';
import { applyGroove, findGroove, grooveClassForChannel, grooveSummary, GROOVE_IDS } from '../grooves/apply';

const zSel = {
  patternId: z.string(),
  channelId: z.string(),
  ids: z.array(z.string()).max(20000).optional(),
};

const zScale = z.object({ root: z.number().int().min(0).max(11), scale: z.string() });

type SelArgs = { patternId: string; channelId: string; ids?: string[] };

interface Sel {
  pat: Pattern;
  notes: Record<string, Note>;
  sel: Note[];
}

function byTime(a: Note, b: Note): number {
  return a.tick - b.tick || a.key - b.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function select(d: Project, a: SelArgs, what: string): Sel {
  const pat = must(d.patterns[a.patternId], `Pattern ${a.patternId} not found`);
  must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
  const notes = pat.notes[a.channelId] ?? {};
  const sel = (a.ids ? a.ids.map((id) => must(notes[id], `Note ${id} not found`)) : Object.values(notes)).sort(byTime);
  if (!sel.length) throw new CommandError(`No notes to ${what}`);
  return { pat, notes, sel };
}

function addNote(pat: Pattern, channelId: string, src: Omit<Note, 'id'>, newId: (p: string) => string): string {
  const id = newId(ID_PREFIX.note);
  (pat.notes[channelId] ??= {})[id] = defaultNote({ ...src, id });
  return id;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampKey = (k: number): number => clamp(Math.round(k), 0, 127);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scaleSteps(name: string): number[] {
  const steps = SCALES[name];
  if (!steps) throw new CommandError(`Unknown scale "${name}" (use one of: ${Object.keys(SCALES).join(', ')})`);
  return steps;
}

function keyToDegree(key: number, root: number, steps: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  const oct = Math.floor((key - root) / 12);
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (let i = 0; i < steps.length; i++) {
      const k = root + o * 12 + steps[i];
      const dist = Math.abs(k - key);
      if (dist < bestDist || (dist === bestDist && k < key)) {
        bestDist = dist;
        best = o * steps.length + i;
      }
    }
  }
  return best;
}

function degreeToKey(deg: number, root: number, steps: number[]): number {
  const n = steps.length;
  const o = Math.floor(deg / n);
  return root + o * 12 + steps[((deg % n) + n) % n];
}

function chordGroups(sel: Note[], window: number): Note[][] {
  const groups: Note[][] = [];
  for (const n of sel) {
    const g = groups[groups.length - 1];
    if (g && n.tick - g[0].tick <= window) g.push(n);
    else groups.push([n]);
  }
  return groups;
}

export function swungGridLine(t: number, grid: number, swing: number): number {
  const line = (i: number): number => i * grid + (i % 2 !== 0 ? Math.round((swing * grid) / 2) : 0);
  const i0 = Math.floor(t / grid);
  let best = line(Math.max(0, i0));
  for (const i of [i0 - 1, i0 + 1]) {
    if (i < 0) continue;
    const l = line(i);
    if (Math.abs(l - t) < Math.abs(best - t)) best = l;
  }
  return best;
}

export const notesQuantize = defineCommand({
  id: 'notes.quantize',
  label: (a) => (a.starts === false && a.ends ? 'Quantize note ends' : 'Quantize'),
  description:
    'Quantize notes (ids, or the whole channel) to a grid in ticks (240 = 16th). starts: move note starts to the grid, keeping their length. ends: snap note ends (changes length). strength 0..1 pulls part of the way (1 = hard). swing 0..1 delays every 2nd grid line by up to half a cell.',
  args: z.object({
    ...zSel,
    grid: z.number().int().min(1).max(PPQ * 16),
    strength: z.number().min(0).max(1).default(1),
    starts: z.boolean().default(true),
    ends: z.boolean().default(false),
    swing: z.number().min(0).max(1).default(0),
  }),
  run(d, a) {
    if (!a.starts && !a.ends) throw new CommandError('Choose start times, note ends, or both to quantize');
    const { sel } = select(d, a, 'quantize');
    const q = (t: number): number => swungGridLine(t, a.grid, a.swing);
    for (const n of sel) {
      let tick = n.tick;
      if (a.starts) tick = Math.max(0, Math.round(n.tick + (q(n.tick) - n.tick) * a.strength));
      let end = a.starts ? tick + n.dur : n.tick + n.dur;
      if (a.ends) {
        let qe = q(end);
        if (qe <= tick) qe = tick + a.grid;
        end = Math.round(end + (qe - end) * a.strength);
      }
      n.tick = tick;
      n.dur = Math.max(1, end - tick);
    }
    return { count: sel.length };
  },
});

export const notesChop = defineCommand({
  id: 'notes.chop',
  label: () => 'Chop notes',
  description:
    'Chop notes into pieces: mode "pieces" splits each note into `pieces` equal parts; mode "grid" cuts each note at every multiple of `grid` ticks (pattern-aligned). Pieces keep every property. Returns the ids of all resulting pieces.',
  args: z.object({
    ...zSel,
    mode: z.enum(['pieces', 'grid']).default('grid'),
    pieces: z.number().int().min(2).max(64).default(2),
    grid: z.number().int().min(1).max(PPQ * 16).default(240),
  }),
  run(d, a, ctx) {
    const { pat, sel } = select(d, a, 'chop');
    const ids: string[] = [];
    let cut = 0;
    for (const n of sel) {
      const end = n.tick + n.dur;
      const points: number[] = [];
      if (a.mode === 'pieces') {
        const len = Math.floor(n.dur / a.pieces);
        if (len >= 1) for (let i = 1; i < a.pieces; i++) points.push(n.tick + i * len);
      } else {
        for (let t = (Math.floor(n.tick / a.grid) + 1) * a.grid; t < end; t += a.grid) points.push(t);
      }
      ids.push(n.id);
      if (!points.length) continue;
      cut++;
      const { id: _id, ...props } = n;
      const bounds = [...points, end];
      n.dur = points[0] - n.tick;
      for (let i = 0; i < points.length; i++) ids.push(addNote(pat, a.channelId, { ...props, tick: points[i], dur: bounds[i + 1] - points[i] }, ctx.newId));
    }
    if (!cut) throw new CommandError(a.mode === 'grid' ? 'Nothing to chop: the notes are not longer than the grid' : 'Nothing to chop: the notes are too short');
    return { ids, chopped: cut };
  },
});

export const notesGlue = defineCommand({
  id: 'notes.glue',
  label: () => 'Glue notes',
  description:
    'Glue notes: notes of the same pitch that touch or overlap (or are at most `gap` ticks apart) merge into one note that keeps the first note\'s properties. Returns the surviving note ids.',
  args: z.object({ ...zSel, gap: z.number().int().min(0).max(PPQ * 4).default(0) }),
  run(d, a) {
    const { notes, sel } = select(d, a, 'glue');
    const byKey = new Map<number, Note[]>();
    for (const n of sel) {
      const arr = byKey.get(n.key);
      if (arr) arr.push(n);
      else byKey.set(n.key, [n]);
    }
    let removed = 0;
    const ids: string[] = [];
    for (const list of byKey.values()) {
      let cur = list[0];
      ids.push(cur.id);
      for (let i = 1; i < list.length; i++) {
        const n = list[i];
        if (n.tick <= cur.tick + cur.dur + a.gap) {
          cur.dur = Math.max(cur.tick + cur.dur, n.tick + n.dur) - cur.tick;
          delete notes[n.id];
          removed++;
        } else {
          cur = n;
          ids.push(cur.id);
        }
      }
    }
    if (!removed) throw new CommandError('Nothing to glue: no touching notes of the same pitch');
    return { removed, ids };
  },
});

export const notesLegato = defineCommand({
  id: 'notes.legato',
  label: () => 'Legato',
  description:
    'Quick legato: each note is lengthened (or shortened) to end where the next note position begins, minus `gap` ticks. Notes starting together (a chord) move as a group; the last position keeps its length.',
  args: z.object({ ...zSel, gap: z.number().int().min(0).max(PPQ * 4).default(0) }),
  run(d, a) {
    const { sel } = select(d, a, 'make legato');
    const starts = [...new Set(sel.map((n) => n.tick))].sort((x, y) => x - y);
    if (starts.length < 2) throw new CommandError('Legato needs notes at two or more positions');
    let changed = 0;
    for (const n of sel) {
      const next = starts.find((s) => s > n.tick);
      if (next === undefined) continue;
      const dur = Math.max(1, next - n.tick - a.gap);
      if (dur !== n.dur) {
        n.dur = dur;
        changed++;
      }
    }
    return { changed };
  },
});

export const notesStrum = defineCommand({
  id: 'notes.strum',
  label: () => 'Strum',
  description:
    'Strum chords (notes starting within `window` ticks of each other): spread their starts over `time` ticks, lowest key first ("up"), highest first ("down") or alternating per chord. curve -1..1 bends the spread (0 = even). keepEnds keeps note ends in place (notes get shorter), otherwise notes keep their length.',
  args: z.object({
    ...zSel,
    time: z.number().int().min(1).max(PPQ * 4),
    curve: z.number().min(-1).max(1).default(0),
    direction: z.enum(['up', 'down', 'alternate']).default('up'),
    keepEnds: z.boolean().default(true),
    window: z.number().int().min(0).max(PPQ).default(20),
  }),
  run(d, a) {
    const { sel } = select(d, a, 'strum');
    const chords = chordGroups(sel, a.window).filter((g) => g.length > 1);
    if (!chords.length) throw new CommandError('Strum needs chords: select notes that start together');
    let count = 0;
    chords.forEach((g, gi) => {
      const up = a.direction === 'up' || (a.direction === 'alternate' && gi % 2 === 0);
      const order = [...g].sort((x, y) => (up ? x.key - y.key : y.key - x.key) || byTime(x, y));
      const base = Math.min(...g.map((n) => n.tick));
      order.forEach((n, i) => {
        const end = n.tick + n.dur;
        const tick = base + Math.round(a.time * shapeCurve(i / (order.length - 1), a.curve));
        n.tick = tick;
        n.dur = a.keepEnds ? Math.max(1, end - tick) : n.dur;
        count++;
      });
    });
    return { chords: chords.length, count };
  },
});

export type ArpPattern = 'up' | 'down' | 'upDown' | 'downUp' | 'random';

export function arpSequence(keys: number[], pattern: Exclude<ArpPattern, 'random'>): number[] {
  const up = [...keys].sort((x, y) => x - y);
  const down = [...up].reverse();
  if (pattern === 'up') return up;
  if (pattern === 'down') return down;
  return pattern === 'upDown' ? up.concat(down.slice(1, -1)) : down.concat(up.slice(1, -1));
}

export const notesArpeggiate = defineCommand({
  id: 'notes.arpeggiate',
  label: (a) => `Arpeggiate (${a.pattern ?? 'up'})`,
  description:
    'Turn chords into arpeggios. Notes starting within `window` ticks form a chord; each chord is replaced by a run of notes every `rate` ticks over the chord\'s span, cycling its keys (plus `octaves` extra octaves) in pattern up / down / upDown / downUp / random (seeded). gate 0.05..1 = note length as a share of the rate. `chord` (e.g. "m7") expands single notes into that chord first. Returns the new note ids.',
  args: z.object({
    ...zSel,
    pattern: z.enum(['up', 'down', 'upDown', 'downUp', 'random']).default('up'),
    rate: z.number().int().min(1).max(PPQ * 4).default(PPQ / 4),
    gate: z.number().min(0.05).max(1).default(0.9),
    octaves: z.number().int().min(1).max(4).default(1),
    seed: z.number().int().default(1),
    chord: z.string().max(8).optional(),
    window: z.number().int().min(0).max(PPQ).default(20),
  }),
  run(d, a, ctx) {
    const { pat, notes, sel } = select(d, a, 'arpeggiate');
    const iv = a.chord ? CHORD_QUALITIES[a.chord] : null;
    if (a.chord && !iv) throw new CommandError(`Unknown chord "${a.chord}"`);
    const rnd = seededRandom(a.seed);
    const ids: string[] = [];
    for (const g of chordGroups(sel, a.window)) {
      const start = Math.min(...g.map((n) => n.tick));
      const end = Math.max(...g.map((n) => n.tick + n.dur));
      let keys = [...new Set(g.map((n) => n.key))].sort((x, y) => x - y);
      if (keys.length === 1 && iv) keys = iv.map((i) => keys[0] + i).filter((k) => k <= 127);
      const all: number[] = [];
      for (let o = 0; o < a.octaves; o++) for (const k of keys) if (k + 12 * o <= 127) all.push(k + 12 * o);
      const seq = a.pattern === 'random' ? all : arpSequence(all, a.pattern);
      const loudest = g.reduce((m, n) => (n.vel > m.vel ? n : m), g[0]);
      const { id: _id, ...base } = g[0];
      for (const n of g) delete notes[n.id];
      let prev = -1;
      for (let t = start, i = 0; t < end; t += a.rate, i++) {
        let key: number;
        if (a.pattern === 'random') {
          let j = Math.floor(rnd() * seq.length);
          if (seq.length > 1 && seq[j] === prev) j = (j + 1 + Math.floor(rnd() * (seq.length - 1))) % seq.length;
          key = seq[j];
        } else key = seq[i % seq.length];
        prev = key;
        const src = g.find((n) => n.key === key) ?? g.find((n) => (key - n.key) % 12 === 0) ?? loudest;
        const dur = Math.max(1, Math.min(Math.round(a.rate * a.gate), end - t));
        ids.push(addNote(pat, a.channelId, { ...base, vel: src.vel, tick: t, dur, key }, ctx.newId));
      }
    }
    return { ids };
  },
});

export const notesRandomize = defineCommand({
  id: 'notes.randomize',
  label: () => 'Randomize notes',
  description:
    'Humanize / randomize notes with a reproducible `seed`: vel (0..1, max ± velocity change), timing (max ± ticks), pitch (max ± steps; scale-degree steps that land in key when `scale` {root 0..11, scale} is given, else semitones), length (0..1, max ± share of the length).',
  args: z.object({
    ...zSel,
    seed: z.number().int(),
    vel: z.number().min(0).max(1).default(0),
    timing: z.number().int().min(0).max(PPQ).default(0),
    pitch: z.number().int().min(0).max(24).default(0),
    length: z.number().min(0).max(1).default(0),
    scale: zScale.optional(),
  }),
  run(d, a) {
    if (!a.vel && !a.timing && !a.pitch && !a.length) throw new CommandError('Nothing to randomize: every amount is 0');
    const { sel } = select(d, a, 'randomize');
    const steps = a.scale ? scaleSteps(a.scale.scale) : null;
    const rnd = seededRandom(a.seed);
    const bi = (): number => rnd() * 2 - 1;
    for (const n of sel) {
      if (a.vel) n.vel = round3(clamp(n.vel + bi() * a.vel, 0, 1));
      if (a.timing) n.tick = Math.max(0, n.tick + Math.round(bi() * a.timing));
      if (a.length) n.dur = Math.max(1, Math.round(n.dur * (1 + bi() * a.length)));
      if (a.pitch) {
        const k = Math.round(bi() * a.pitch);
        if (steps && a.scale) n.key = clampKey(degreeToKey(keyToDegree(n.key, a.scale.root, steps) + k, a.scale.root, steps));
        else n.key = clampKey(n.key + k);
      }
    }
    return { count: sel.length };
  },
});

export const notesFlip = defineCommand({
  id: 'notes.flip',
  label: (a) => (a.axis === 'vertical' ? 'Flip vertically' : 'Flip horizontally'),
  description:
    'Mirror notes. horizontal: reverse them in time inside the span they occupy. vertical: mirror pitches between the lowest and highest key (by scale degree when `scale` {root, scale} is given, so the result stays in key).',
  args: z.object({ ...zSel, axis: z.enum(['horizontal', 'vertical']), scale: zScale.optional() }),
  run(d, a) {
    const { sel } = select(d, a, 'flip');
    if (a.axis === 'horizontal') {
      const t0 = Math.min(...sel.map((n) => n.tick));
      const t1 = Math.max(...sel.map((n) => n.tick + n.dur));
      for (const n of sel) n.tick = Math.max(0, t0 + t1 - (n.tick + n.dur));
    } else if (a.scale) {
      const steps = scaleSteps(a.scale.scale);
      const degs = sel.map((n) => keyToDegree(n.key, a.scale!.root, steps));
      const lo = Math.min(...degs);
      const hi = Math.max(...degs);
      sel.forEach((n, i) => (n.key = clampKey(degreeToKey(lo + hi - degs[i], a.scale!.root, steps))));
    } else {
      const lo = Math.min(...sel.map((n) => n.key));
      const hi = Math.max(...sel.map((n) => n.key));
      for (const n of sel) n.key = clampKey(lo + hi - n.key);
    }
    return { count: sel.length };
  },
});

export const notesScaleSnap = defineCommand({
  id: 'notes.scaleSnap',
  label: () => 'Snap to scale',
  description:
    'Move every note that is out of key onto the scale (root 0..11 = C..B, scale e.g. "minor", "dorian", "majorPentatonic"): nearest scale tone (ties go down), or always "up" / "down".',
  args: z.object({ ...zSel, root: z.number().int().min(0).max(11), scale: z.string(), direction: z.enum(['nearest', 'up', 'down']).default('nearest') }),
  run(d, a) {
    const steps = scaleSteps(a.scale);
    const { sel } = select(d, a, 'snap to the scale');
    const inKey = (k: number): boolean => steps.includes((((k - a.root) % 12) + 12) % 12);
    let changed = 0;
    for (const n of sel) {
      if (inKey(n.key)) continue;
      let up = n.key;
      while (up <= 127 && !inKey(up)) up++;
      let down = n.key;
      while (down >= 0 && !inKey(down)) down--;
      let k: number;
      if (a.direction === 'up') k = up <= 127 ? up : down;
      else if (a.direction === 'down') k = down >= 0 ? down : up;
      else k = down >= 0 && (n.key - down <= up - n.key || up > 127) ? down : up;
      n.key = clampKey(k);
      changed++;
    }
    return { changed };
  },
});

export const notesLimit = defineCommand({
  id: 'notes.limit',
  label: () => 'Limit key range',
  description:
    'Keep notes inside a key range [low, high] (MIDI). mode "octave" moves out-of-range notes by whole octaves (keeps the pitch class; clamps if the range is narrower than an octave); "clamp" pins them to the nearest bound.',
  args: z.object({ ...zSel, low: z.number().int().min(0).max(127), high: z.number().int().min(0).max(127), mode: z.enum(['octave', 'clamp']).default('octave') }),
  run(d, a) {
    if (a.low > a.high) throw new CommandError('The lowest key must be at or below the highest key');
    const { sel } = select(d, a, 'limit');
    let changed = 0;
    for (const n of sel) {
      let k = n.key;
      if (a.mode === 'octave') {
        while (k < a.low && k + 12 <= 127) k += 12;
        while (k > a.high && k - 12 >= 0) k -= 12;
      }
      k = clamp(k, a.low, a.high);
      if (k !== n.key) {
        n.key = k;
        changed++;
      }
    }
    return { changed };
  },
});

const LEVEL_PROPS = {
  vel: { min: 0, max: 1, int: false },
  pan: { min: -1, max: 1, int: false },
  release: { min: 0, max: 1, int: false },
  modX: { min: 0, max: 1, int: false },
  modY: { min: 0, max: 1, int: false },
  fine: { min: -100, max: 100, int: true },
} as const;

export function lfoWave(shape: 'sine' | 'triangle' | 'square' | 'saw', x: number): number {
  const f = x - Math.floor(x);
  switch (shape) {
    case 'sine':
      return Math.sin(2 * Math.PI * x);
    case 'triangle':
      return 1 - 4 * Math.abs(((x + 0.25) - Math.floor(x + 0.25)) - 0.5);
    case 'square':
      return f < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * f - 1;
  }
}

export const notesLevels = defineCommand({
  id: 'notes.levels',
  label: (a) => `${a.mode === 'lfo' ? 'LFO' : 'Ramp'} ${a.prop ?? 'vel'}`,
  description:
    'Shape a note property (vel, pan, release, modX, modY, fine) across the notes by their start time. mode "ramp": from → to (normalized 0..1 of the property range) bent by curve -1..1. mode "lfo": center ± depth/2 following a sine / triangle / square / saw wave with `period` ticks and `phase` 0..1.',
  args: z.object({
    ...zSel,
    prop: z.enum(['vel', 'pan', 'release', 'modX', 'modY', 'fine']).default('vel'),
    mode: z.enum(['ramp', 'lfo']).default('ramp'),
    from: z.number().min(0).max(1).default(0.2),
    to: z.number().min(0).max(1).default(1),
    curve: z.number().min(-1).max(1).default(0),
    shape: z.enum(['sine', 'triangle', 'square', 'saw']).default('sine'),
    period: z.number().int().min(1).max(PPQ * 64).default(PPQ * 4),
    depth: z.number().min(0).max(1).default(1),
    center: z.number().min(0).max(1).default(0.5),
    phase: z.number().min(0).max(1).default(0),
  }),
  run(d, a) {
    const { sel } = select(d, a, 'shape');
    const spec = LEVEL_PROPS[a.prop];
    const t0 = sel[0].tick;
    const t1 = sel[sel.length - 1].tick;
    for (const n of sel) {
      let norm: number;
      if (a.mode === 'ramp') {
        const f = t1 > t0 ? (n.tick - t0) / (t1 - t0) : 0;
        norm = a.from + (a.to - a.from) * shapeCurve(f, a.curve);
      } else {
        norm = a.center + 0.5 * a.depth * lfoWave(a.shape, (n.tick - t0) / a.period + a.phase);
      }
      const v = spec.min + clamp(norm, 0, 1) * (spec.max - spec.min);
      n[a.prop] = spec.int ? Math.round(v) : round3(v);
    }
    return { count: sel.length };
  },
});

export const notesSetProps = defineCommand({
  id: 'notes.setProps',
  label: (a) => (a.mute !== undefined ? 'Mute notes' : a.color !== undefined ? 'Note colour' : 'Slide notes'),
  description:
    'Set flags on notes (ids, or the whole channel): mute (true / false / "toggle": muted notes stay but never play), color (0..15 colour group; exported as the MIDI channel), slide (true / false / "toggle": FL slide notes glide from the previous note). "toggle" turns the flag on unless every note already has it.',
  args: z.object({
    ...zSel,
    mute: z.union([z.boolean(), z.literal('toggle')]).optional(),
    color: z.number().int().min(0).max(15).optional(),
    slide: z.union([z.boolean(), z.literal('toggle')]).optional(),
  }),
  run(d, a) {
    if (a.mute === undefined && a.color === undefined && a.slide === undefined) throw new CommandError('Nothing to set: pass mute, color or slide');
    const { sel } = select(d, a, 'change');
    const mute = a.mute === 'toggle' ? !sel.every((n) => n.mute) : a.mute;
    const slide = a.slide === 'toggle' ? !sel.every((n) => n.slide) : a.slide;
    for (const n of sel) {
      if (mute === true) n.mute = true;
      else if (mute === false) delete n.mute;
      if (a.color !== undefined) {
        if (a.color) n.color = a.color;
        else delete n.color;
      }
      if (slide !== undefined) n.slide = slide;
    }
    return { count: sel.length, mute, slide };
  },
});

export const notesGroove = defineCommand({
  id: 'notes.groove',
  label: (a) => {
    const t = findGroove(a.template);
    return `Groove${t ? ` (${t.label})` : ''}`;
  },
  description: `Apply a groove template measured from real drummers (Groove MIDI Dataset by Google LLC, CC BY 4.0). Each note on a 16th step moves by amount (0..1) × the template's mean timing offset for that step, and its velocity is shaped by velocity (0..1) × the template's accent for that step. instrument kick / snare / hihat / other picks the template's statistics; "auto" reads it from the channel name. Notes already on the groove don't move again, and notes never leave the pattern. Templates: ${GROOVE_IDS.join(', ')}.`,
  args: z.object({
    ...zSel,
    template: z.string().min(1).max(32),
    amount: z.number().min(0).max(1).default(1),
    velocity: z.number().min(0).max(1).default(0.5),
    instrument: z.enum(['auto', 'kick', 'snare', 'hihat', 'other']).default('auto'),
  }),
  run(d, a) {
    const t = findGroove(a.template);
    if (!t) throw new CommandError(`Unknown groove "${a.template}" (use one of: ${GROOVE_IDS.join(', ')})`);
    if (!a.amount && !a.velocity) throw new CommandError('Nothing to apply: timing amount and velocity are both 0');
    const { pat, sel } = select(d, a, 'groove');
    const ts = d.transport.timeSig;
    const cls = a.instrument === 'auto' ? grooveClassForChannel(d.channels[a.channelId].name) : a.instrument;
    const out = applyGroove(sel, { template: t, amount: a.amount, velocity: a.velocity, ppq: PPQ, class: cls, length: patternLength(pat, ts), stepsPerBar: Math.round(ticksPerBar(ts) / (PPQ / 4)) });
    let changed = 0;
    sel.forEach((n, i) => {
      const o = out[i];
      if (o === n) return;
      n.tick = o.tick;
      n.dur = o.dur;
      n.vel = o.vel;
      changed++;
    });
    if (!changed) throw new CommandError(`No change: the notes already follow the ${t.label} groove`);
    return { count: sel.length, changed, template: t.id, instrument: cls, source: grooveSummary(t) };
  },
});

export const NOTE_TOOL_COMMANDS = [
  notesQuantize,
  notesChop,
  notesGlue,
  notesLegato,
  notesStrum,
  notesArpeggiate,
  notesRandomize,
  notesFlip,
  notesScaleSnap,
  notesLimit,
  notesLevels,
  notesSetProps,
  notesGroove,
];
