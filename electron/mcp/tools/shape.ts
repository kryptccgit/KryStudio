import { z } from 'zod';
import { PPQ } from '@shared/schema/time';
import { parseKey, parseNoteName, type Key } from '@shared/music/theory';
import { defineTool, fail } from './types';
import { findChannel, findPattern, plural, safeName } from './util';
import { selectNotes, zNoteSelect } from './compose';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zKey = z.string().max(24).describe('Key, e.g. "F#m", "C", "D dorian".');
const zPitch = z.union([z.number().int().min(0).max(127), z.string().max(6)]).describe('Note name ("C3") or MIDI number.');
const zFlag = z.union([z.boolean(), z.literal('toggle')]);

const STEP = PPQ / 4;
const DEFAULT_SEED = 0x6b727970;

const zShapeOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('arpeggiate'),
    style: z.enum(['up', 'down', 'up_down', 'down_up', 'random']).default('up'),
    rate_steps: z.number().positive().max(16).default(1).describe('16th steps between arp notes (0.5 = 32nds, 4/3 = 8th triplets).'),
    gate: z.number().min(0.05).max(1).default(0.9).describe('Note length as a share of the rate.'),
    octaves: z.number().int().min(1).max(4).default(1),
    chord: z.string().max(8).optional().describe('Expand single notes into this chord first, e.g. "m7", "maj7", "sus4".'),
    seed: z.number().int().optional(),
  }),
  z.object({ op: z.literal('glue'), gap_steps: z.number().min(0).max(16).default(0).describe('Also merge same-pitch notes at most this many 16th steps apart.') }),
  z.object({ op: z.literal('scale_snap'), key: zKey, direction: z.enum(['nearest', 'up', 'down']).default('nearest') }),
  z.object({ op: z.literal('flip'), axis: z.enum(['time', 'pitch']), key: zKey.optional().describe('axis pitch only: mirror by scale degree so the result stays in this key.') }),
  z.object({
    op: z.literal('randomize'),
    pitch: z.number().int().min(0).max(24).default(0).describe('Max ± steps: scale degrees when key is given (stays in key), else semitones.'),
    key: zKey.optional(),
    velocity: z.number().min(0).max(1).default(0).describe('Max ± velocity change (0..1).'),
    timing_steps: z.number().min(0).max(4).default(0).describe('Max ± 16th steps.'),
    length: z.number().min(0).max(1).default(0).describe('Max ± share of each note length.'),
    seed: z.number().int().optional(),
  }),
  z.object({ op: z.literal('limit'), low: zPitch, high: zPitch, mode: z.enum(['octave', 'clamp']).default('octave').describe('octave: move by whole octaves into range; clamp: pin to the nearest bound.') }),
  z.object({
    op: z.literal('levels'),
    prop: z.enum(['velocity', 'pan', 'release', 'mod_x', 'mod_y', 'fine']),
    shape: z.enum(['ramp', 'sine', 'triangle', 'square', 'saw']).default('ramp'),
    from: z.number().min(0).max(1).default(0.2).describe('ramp start, 0..1 of the property range (pan 0.5 = centre, fine 0.5 = 0 cents).'),
    to: z.number().min(0).max(1).default(1).describe('ramp end, 0..1.'),
    curve: z.number().min(-1).max(1).default(0).describe('ramp bend; 0 = straight.'),
    period_steps: z.number().positive().max(256).default(16).describe('LFO period in 16th steps.'),
    depth: z.number().min(0).max(1).default(1),
    center: z.number().min(0).max(1).default(0.5),
    phase: z.number().min(0).max(1).default(0),
  }),
  z.object({
    op: z.literal('flags'),
    mute: zFlag.optional().describe('Muted notes stay in the pattern but never play.'),
    color: z.number().int().min(0).max(15).optional().describe('Colour group 0..15 (MIDI channel on export).'),
    slide: zFlag.optional().describe('Slide notes glide from the previous note.'),
  }),
]);

type ShapeOp = z.infer<typeof zShapeOp>;

const ARP_STYLE = { up: 'up', down: 'down', up_down: 'upDown', down_up: 'downUp', random: 'random' } as const;
const LEVEL_PROP = { velocity: 'vel', pan: 'pan', release: 'release', mod_x: 'modX', mod_y: 'modY', fine: 'fine' } as const;

function key(s: string): Key {
  return parseKey(s) ?? fail(`Unknown key "${safeName(s, 24)}" (use e.g. "F#m", "C", "D dorian", "A minorPentatonic")`);
}

function pitch(v: number | string): number {
  if (typeof v === 'number') return v;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : parseNoteName(v);
  if (n === null || n < 0 || n > 127) fail(`"${safeName(v, 8)}" is not a note name or MIDI number`);
  return n;
}

const ticks = (steps: number): number => Math.max(1, Math.round(steps * STEP));

export const shapeNotes = defineTool({
  name: 'shape_notes',
  title: 'Piano roll tools',
  kind: 'write',
  description:
    'Piano roll "Tools" on one channel of a pattern (all notes, or select by bars / pitch), applied in order as ONE undo step. ops: arpeggiate {style up|down|up_down|down_up|random, rate_steps, gate, octaves, chord}, glue {gap_steps}, scale_snap {key, direction}, flip {axis time|pitch, key}, randomize {pitch + key (stays in key), velocity, timing_steps, length, seed}, limit {low, high, mode}, levels {prop velocity|pan|release|mod_x|mod_y|fine, shape ramp (from→to, curve) | sine|triangle|square|saw (period_steps, depth, center)}, flags {mute, color, slide}. Ops that replace notes pass the new notes to the next op. For transpose, shift, quantize, humanize, legato, strum or chop use transform_notes. Example: {"channel":"Keys","ops":[{"op":"arpeggiate","style":"up_down","rate_steps":1,"octaves":2},{"op":"levels","prop":"velocity","from":0.4,"to":1}]}',
  input: z.object({
    pattern: z.string().max(80).optional(),
    channel: z.string(),
    select: zNoteSelect.optional(),
    ops: z.array(zShapeOp).min(1).max(8),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel, 30)}: ${a.ops.map((o) => o.op).join(', ')}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    let ids = selectNotes(p, pat, ch, a.select).map((n) => n.id);
    const done: string[] = [];
    const run = <T>(cmd: string, op: Record<string, unknown>): T => ctx.exec<T>(cmd, { patternId: pat.id, channelId: ch.id, ids, ...op });
    for (const op of a.ops as ShapeOp[]) {
      switch (op.op) {
        case 'arpeggiate': {
          const r = run<{ ids: string[] }>('notes.arpeggiate', { pattern: ARP_STYLE[op.style], rate: ticks(op.rate_steps), gate: op.gate, octaves: op.octaves, chord: op.chord, seed: op.seed ?? 1 });
          ids = r.ids;
          done.push(`arpeggiated ${op.style} into ${plural(ids.length, 'note')}`);
          break;
        }
        case 'glue': {
          const r = run<{ removed: number; ids: string[] }>('notes.glue', { gap: Math.round(op.gap_steps * STEP) });
          ids = r.ids;
          done.push(`glued ${plural(r.removed, 'note')} away`);
          break;
        }
        case 'scale_snap': {
          const k = key(op.key);
          const r = run<{ changed: number }>('notes.scaleSnap', { root: k.root, scale: k.scale, direction: op.direction });
          done.push(`snapped ${plural(r.changed, 'note')} into ${op.key}`);
          break;
        }
        case 'flip':
          run('notes.flip', { axis: op.axis === 'time' ? 'horizontal' : 'vertical', scale: op.axis === 'pitch' && op.key ? key(op.key) : undefined });
          done.push(op.axis === 'time' ? 'reversed in time' : `mirrored in pitch${op.key ? ` (in ${op.key})` : ''}`);
          break;
        case 'randomize': {
          run('notes.randomize', { seed: op.seed ?? DEFAULT_SEED, vel: op.velocity, timing: Math.round(op.timing_steps * STEP), pitch: op.pitch, length: op.length, scale: op.key ? key(op.key) : undefined });
          done.push(op.pitch && !op.key ? 'randomized (pitch moved chromatically; pass key to stay in key)' : 'randomized');
          break;
        }
        case 'limit': {
          const r = run<{ changed: number }>('notes.limit', { low: pitch(op.low), high: pitch(op.high), mode: op.mode });
          done.push(`moved ${plural(r.changed, 'note')} into ${op.low}–${op.high}`);
          break;
        }
        case 'levels': {
          const lfo = op.shape !== 'ramp';
          run('notes.levels', {
            prop: LEVEL_PROP[op.prop],
            mode: lfo ? 'lfo' : 'ramp',
            from: op.from,
            to: op.to,
            curve: op.curve,
            shape: lfo ? op.shape : undefined,
            period: Math.min(PPQ * 64, ticks(op.period_steps)),
            depth: op.depth,
            center: op.center,
            phase: op.phase,
          });
          done.push(lfo ? `${op.shape} LFO on ${op.prop}` : `${op.prop} ramp ${op.from}→${op.to}`);
          break;
        }
        case 'flags': {
          const r = run<{ count: number; mute?: boolean; slide?: boolean }>('notes.setProps', { mute: op.mute, color: op.color, slide: op.slide });
          const what = [r.mute !== undefined && (r.mute ? 'muted' : 'unmuted'), op.color !== undefined && `colour ${op.color}`, r.slide !== undefined && (r.slide ? 'slide on' : 'slide off')].filter(Boolean);
          done.push(`${what.join(', ')} on ${plural(r.count, 'note')}`);
          break;
        }
      }
    }
    return { ok: true, message: `${safeName(ch.name)} in "${safeName(pat.name)}": ${done.join('; ')}. Now ${plural(ids.length, 'note')} in the selection.`, changed: [] };
  },
});

export const SHAPE_TOOLS = [shapeNotes];
