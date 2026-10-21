import { z } from 'zod';
import { defineCommand, must, plural, CommandError } from './types';
import { defaultNote, type Note, type Pattern, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { PPQ, TICKS_PER_STEP } from '../schema/time';

const zNoteInput = z.object({
  tick: z.number().int().min(0),
  key: z.number().int().min(0).max(127),
  dur: z.number().int().min(1).optional(),
  vel: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  release: z.number().min(0).max(1).optional(),
  fine: z.number().min(-100).max(100).optional(),
  slide: z.boolean().optional(),
  modX: z.number().min(0).max(1).optional(),
  modY: z.number().min(0).max(1).optional(),
  mute: z.boolean().optional(),
  color: z.number().int().min(0).max(15).optional(),
});
export type NoteInput = z.infer<typeof zNoteInput>;

const zNotePatch = zNoteInput.partial().extend({ id: z.string() });

const zTarget = { patternId: z.string(), channelId: z.string() };

function target(draft: Project, patternId: string, channelId: string): { pat: Pattern; notes: Record<string, Note> } {
  const pat = must(draft.patterns[patternId], `Pattern ${patternId} not found`);
  must(draft.channels[channelId], `Channel ${channelId} not found`);
  if (!pat.notes[channelId]) pat.notes[channelId] = {};
  return { pat, notes: pat.notes[channelId] };
}

function pruneEmpty(pat: Pattern, channelId: string): void {
  if (pat.notes[channelId] && Object.keys(pat.notes[channelId]).length === 0) delete pat.notes[channelId];
}

function insertNotes(notes: Record<string, Note>, inputs: NoteInput[], newId: (p: string) => string): string[] {
  const ids: string[] = [];
  for (const n of inputs) {
    const id = newId(ID_PREFIX.note);
    notes[id] = defaultNote({ ...n, id, dur: n.dur ?? TICKS_PER_STEP });
    ids.push(id);
  }
  return ids;
}

export const notesAdd = defineCommand({
  id: 'notes.add',
  label: (a) => `Add ${plural(a.notes.length, 'note')}`,
  description:
    'Add notes to a channel inside a pattern. Ticks are PPQ 960 (a 16th step = 240 ticks, a beat = 960). key is MIDI (60 = middle C). vel 0..1. Returns the new note ids.',
  args: z.object({ ...zTarget, notes: z.array(zNoteInput).max(10000) }),
  run(d, a, ctx) {
    const { notes } = target(d, a.patternId, a.channelId);
    return { ids: insertNotes(notes, a.notes, ctx.newId) };
  },
});

export const notesReplace = defineCommand({
  id: 'notes.replace',
  label: (a) => `Write ${plural(a.notes.length, 'note')}`,
  description: 'Replace ALL notes of one channel in one pattern with the given notes (used by pattern writers / KPN). Returns the new note ids.',
  args: z.object({ ...zTarget, notes: z.array(zNoteInput).max(10000) }),
  run(d, a, ctx) {
    const { pat } = target(d, a.patternId, a.channelId);
    pat.notes[a.channelId] = {};
    const ids = insertNotes(pat.notes[a.channelId], a.notes, ctx.newId);
    pruneEmpty(pat, a.channelId);
    return { ids };
  },
});

export const notesRemove = defineCommand({
  id: 'notes.remove',
  label: (a) => `Delete ${plural(a.ids.length, 'note')}`,
  description: 'Delete notes by id from a channel in a pattern.',
  args: z.object({ ...zTarget, ids: z.array(z.string()) }),
  run(d, a) {
    const { pat, notes } = target(d, a.patternId, a.channelId);
    let removed = 0;
    for (const id of a.ids) {
      if (notes[id]) {
        delete notes[id];
        removed++;
      }
    }
    pruneEmpty(pat, a.channelId);
    return { removed };
  },
});

export const notesUpdate = defineCommand({
  id: 'notes.update',
  label: (a) => `Edit ${plural(a.updates.length, 'note')}`,
  description: 'Change properties (tick, dur, key, vel, pan, release, fine, slide, modX, modY, mute, color 0..15) of existing notes by id.',
  args: z.object({ ...zTarget, updates: z.array(zNotePatch).max(10000) }),
  run(d, a) {
    const { notes } = target(d, a.patternId, a.channelId);
    for (const u of a.updates) {
      const n = must(notes[u.id], `Note ${u.id} not found`);
      const { id: _id, ...rest } = u;
      Object.assign(n, rest);
    }
    return { updated: a.updates.length };
  },
});

export const notesClear = defineCommand({
  id: 'notes.clear',
  label: (a) => (a.channelId ? 'Clear channel notes' : 'Clear pattern'),
  description: 'Remove every note from a pattern, or only one channel of it when channelId is given.',
  args: z.object({ patternId: z.string(), channelId: z.string().optional() }),
  run(d, a) {
    const pat = must(d.patterns[a.patternId], `Pattern ${a.patternId} not found`);
    if (a.channelId) delete pat.notes[a.channelId];
    else pat.notes = {};
    return {};
  },
});

export const notesToggleStep = defineCommand({
  id: 'notes.toggleStep',
  label: (a) => `Toggle step ${a.step + 1}`,
  description:
    'Step-sequencer toggle: if a note starts on 16th step `step` it is removed, otherwise a one-step note is added at `key` (default: the channel root key).',
  args: z.object({ ...zTarget, step: z.number().int().min(0).max(4095), key: z.number().int().min(0).max(127).optional(), vel: z.number().min(0).max(1).optional() }),
  run(d, a, ctx) {
    const { pat, notes } = target(d, a.patternId, a.channelId);
    const tick = a.step * TICKS_PER_STEP;
    const hits = Object.values(notes).filter((n) => n.tick === tick);
    if (hits.length) {
      for (const n of hits) delete notes[n.id];
      pruneEmpty(pat, a.channelId);
      return { on: false };
    }
    const key = a.key ?? d.channels[a.channelId].rootKey;
    insertNotes(notes, [{ tick, key, dur: TICKS_PER_STEP, vel: a.vel }], ctx.newId);
    return { on: true };
  },
});

export const notesTransform = defineCommand({
  id: 'notes.transform',
  label: () => 'Transform notes',
  description:
    'Bulk edit notes of a channel in a pattern (all, or `ids`): transpose (semitones), shift (ticks), velocity scale/set, quantize starts (and optionally ends) to a grid in ticks with strength 0..1, length scale.',
  args: z.object({
    ...zTarget,
    ids: z.array(z.string()).optional(),
    transpose: z.number().int().min(-127).max(127).optional(),
    shift: z.number().int().optional(),
    velScale: z.number().min(0).max(4).optional(),
    velSet: z.number().min(0).max(1).optional(),
    quantize: z.object({ grid: z.number().int().min(1), strength: z.number().min(0).max(1).default(1), ends: z.boolean().default(false) }).optional(),
    lengthScale: z.number().min(0.01).max(16).optional(),
  }),
  run(d, a) {
    const { notes } = target(d, a.patternId, a.channelId);
    const sel = a.ids ? a.ids.map((id) => must(notes[id], `Note ${id} not found`)) : Object.values(notes);
    for (const n of sel) {
      if (a.transpose) n.key = Math.min(127, Math.max(0, n.key + a.transpose));
      if (a.shift) n.tick = Math.max(0, n.tick + a.shift);
      if (a.velSet !== undefined) n.vel = a.velSet;
      if (a.velScale !== undefined) n.vel = Math.min(1, Math.max(0, n.vel * a.velScale));
      if (a.lengthScale !== undefined) n.dur = Math.max(1, Math.round(n.dur * a.lengthScale));
      if (a.quantize) {
        const { grid, strength, ends } = a.quantize;
        const q = Math.round(n.tick / grid) * grid;
        const end = n.tick + n.dur;
        n.tick = Math.max(0, Math.round(n.tick + (q - n.tick) * strength));
        if (ends) {
          const qe = Math.max(n.tick + grid, Math.round(end / grid) * grid);
          n.dur = Math.max(1, Math.round(end + (qe - end) * strength) - n.tick);
        } else n.dur = Math.max(1, end - n.tick);
      }
    }
    return { count: sel.length };
  },
});

export const notesCopyChannel = defineCommand({
  id: 'notes.copyToPattern',
  label: () => 'Copy notes',
  description: 'Copy notes (all of a channel, or ids) from one pattern into another, offset by `shift` ticks. Returns new ids.',
  args: z.object({
    fromPatternId: z.string(),
    toPatternId: z.string(),
    channelId: z.string(),
    toChannelId: z.string().optional(),
    ids: z.array(z.string()).optional(),
    shift: z.number().int().default(0),
  }),
  run(d, a, ctx) {
    const src = target(d, a.fromPatternId, a.channelId).notes;
    const dst = target(d, a.toPatternId, a.toChannelId ?? a.channelId).notes;
    const list = a.ids ? a.ids.map((id) => must(src[id], `Note ${id} not found`)) : Object.values(src);
    const ids = insertNotes(
      dst,
      list.map(({ id: _id, ...n }) => ({ ...n, tick: Math.max(0, n.tick + a.shift) })),
      ctx.newId,
    );
    if (ids.length === 0 && Object.keys(dst).length === 0) {
      const pat = d.patterns[a.toPatternId];
      pruneEmpty(pat, a.toChannelId ?? a.channelId);
    }
    return { ids };
  },
});

/** Guard used by KPN / MCP writers: patterns longer than this are rejected. */
export const MAX_PATTERN_TICKS = PPQ * 4 * 1024;

export function assertTickRange(tick: number): void {
  if (tick > MAX_PATTERN_TICKS) throw new CommandError('Note is beyond the maximum pattern length (1024 bars)');
}

export const NOTE_COMMANDS = [notesAdd, notesReplace, notesRemove, notesUpdate, notesClear, notesToggleStep, notesTransform, notesCopyChannel];
