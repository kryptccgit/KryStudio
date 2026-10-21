import { z } from 'zod';
import { defineCommand, must, plural, CommandError, type CommandDef } from './types';
import { defaultNote, patternLength, type Note, type Pattern, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { TICKS_PER_STEP } from '../schema/time';

const MAX_STEPS = 4096;

function rackTarget(d: Project, patternId: string, channelId: string): { pat: Pattern; notes: Record<string, Note> } {
  const pat = must(d.patterns[patternId], `Pattern ${patternId} not found`);
  must(d.channels[channelId], `Channel ${channelId} not found`);
  if (!pat.notes[channelId]) pat.notes[channelId] = {};
  return { pat, notes: pat.notes[channelId] };
}

function pruneEmpty(pat: Pattern, channelId: string): void {
  if (pat.notes[channelId] && Object.keys(pat.notes[channelId]).length === 0) delete pat.notes[channelId];
}

function isStepNote(n: Note): boolean {
  return n.tick % TICKS_PER_STEP === 0 && n.dur <= TICKS_PER_STEP;
}

export const notesFillSteps = defineCommand({
  id: 'notes.fillSteps',
  label: (a) => `Fill each ${plural(a.every, 'step')}`,
  description:
    'Channel Rack "Fill each N steps": put a one-step note on every `every`-th 16th step of a channel row, starting at step `offset` (0-based). `steps` is the row length in steps (default: the pattern length / 240). key defaults to the pitch the row already uses, else the channel root key. With replace (default true) the row\'s existing one-step notes are removed first; otherwise occupied steps are kept. Returns the new note ids.',
  args: z
    .object({
      patternId: z.string(),
      channelId: z.string(),
      every: z.number().int().min(1).max(64),
      offset: z.number().int().min(0).max(63).default(0),
      steps: z.number().int().min(1).max(MAX_STEPS).optional(),
      key: z.number().int().min(0).max(127).optional(),
      vel: z.number().min(0).max(1).optional(),
      replace: z.boolean().default(true),
    })
    .refine((a) => a.offset < a.every, { message: 'offset must be smaller than every', path: ['offset'] }),
  run(d, a, ctx) {
    const { pat, notes } = rackTarget(d, a.patternId, a.channelId);
    const steps = a.steps ?? Math.max(1, Math.round(patternLength(pat, d.transport.timeSig) / TICKS_PER_STEP));
    const rowEnd = steps * TICKS_PER_STEP;
    const existing = Object.values(notes);
    const key = a.key ?? existing.find(isStepNote)?.key ?? existing[0]?.key ?? d.channels[a.channelId].rootKey;
    let removed = 0;
    if (a.replace) {
      for (const n of existing) {
        if (isStepNote(n) && n.tick < rowEnd) {
          delete notes[n.id];
          removed++;
        }
      }
    }
    const occupied = new Set(Object.values(notes).map((n) => n.tick));
    const ids: string[] = [];
    for (let s = a.offset; s < steps; s += a.every) {
      const tick = s * TICKS_PER_STEP;
      if (occupied.has(tick)) continue;
      const id = ctx.newId(ID_PREFIX.note);
      notes[id] = defaultNote({ id, tick, key, dur: TICKS_PER_STEP, ...(a.vel !== undefined ? { vel: a.vel } : {}) });
      ids.push(id);
    }
    pruneEmpty(pat, a.channelId);
    return { ids, removed };
  },
});

export const notesShiftSteps = defineCommand({
  id: 'notes.shiftSteps',
  label: (a) => `Shift steps ${a.steps < 0 ? 'left' : 'right'}`,
  description:
    'Rotate a channel row: move ALL of the channel\'s notes in a pattern by `steps` 16th steps (negative = left). With wrap (default true) start times wrap modulo `length` (ticks; default: the effective pattern length), like FL\'s rotate left/right, so nothing is lost. With wrap=false notes pushed before 0 or to/after `length` are deleted. Returns { moved, removed }.',
  args: z.object({
    patternId: z.string(),
    channelId: z.string(),
    steps: z
      .number()
      .int()
      .min(-MAX_STEPS)
      .max(MAX_STEPS)
      .refine((v) => v !== 0, { message: 'steps must not be 0' }),
    wrap: z.boolean().default(true),
    length: z.number().int().min(1).optional(),
  }),
  run(d, a) {
    const { pat, notes } = rackTarget(d, a.patternId, a.channelId);
    const len = a.length ?? patternLength(pat, d.transport.timeSig);
    if (len <= 0) throw new CommandError('The pattern has no length to shift within');
    const shift = a.steps * TICKS_PER_STEP;
    let moved = 0;
    let removed = 0;
    for (const n of Object.values(notes)) {
      const t = n.tick + shift;
      if (a.wrap) {
        n.tick = ((t % len) + len) % len;
        moved++;
      } else if (t < 0 || t >= len) {
        delete notes[n.id];
        removed++;
      } else {
        n.tick = t;
        moved++;
      }
    }
    pruneEmpty(pat, a.channelId);
    return { moved, removed };
  },
});

export const RACK_COMMANDS: CommandDef[] = [notesFillSteps, notesShiftSteps] as CommandDef[];
