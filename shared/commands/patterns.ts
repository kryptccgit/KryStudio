import { z } from 'zod';
import { defineCommand, must, CommandError } from './types';
import { paletteColor } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { removeLaunchClipsWhere } from './session';
import { dropTakeRefs } from '../schema/takes';

function nextPatternName(names: string[]): string {
  let i = names.length + 1;
  while (names.includes(`Pattern ${i}`)) i++;
  return `Pattern ${i}`;
}

export const patternsAdd = defineCommand({
  id: 'patterns.add',
  label: (a) => `Add pattern${a.name ? ` "${a.name}"` : ''}`,
  description: 'Create a new empty pattern. Selected as the active pattern unless select=false. Returns its id.',
  args: z.object({ name: z.string().max(64).optional(), color: z.string().optional(), select: z.boolean().default(true), length: z.number().int().min(1).nullable().optional() }),
  run(d, a, ctx) {
    const id = ctx.newId(ID_PREFIX.pattern);
    const name = a.name ?? nextPatternName(Object.values(d.patterns).map((p) => p.name));
    d.patterns[id] = { id, name, color: a.color ?? paletteColor(d.patternOrder.length), length: a.length ?? null, notes: {} };
    d.patternOrder.push(id);
    if (a.select) d.transport.activePatternId = id;
    return { id };
  },
});

export const patternsRemove = defineCommand({
  id: 'patterns.remove',
  label: () => 'Delete pattern',
  description: 'Delete a pattern and every playlist clip that references it.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    must(d.patterns[a.id], `Pattern ${a.id} not found`);
    if (d.patternOrder.length <= 1) throw new CommandError('A project needs at least one pattern');
    delete d.patterns[a.id];
    d.patternOrder = d.patternOrder.filter((p) => p !== a.id);
    for (const c of Object.values(d.playlist.clips)) if (c.kind === 'pattern' && c.patternId === a.id) delete d.playlist.clips[c.id];
    removeLaunchClipsWhere(d, (c) => c.kind === 'pattern' && c.patternId === a.id);
    dropTakeRefs(d, { patternIds: [a.id] }); // takes: a take that played this pattern goes
    if (d.transport.activePatternId === a.id) d.transport.activePatternId = d.patternOrder[0] ?? null;
    return {};
  },
});

export const patternsSet = defineCommand({
  id: 'patterns.set',
  label: () => 'Edit pattern',
  description: 'Rename a pattern, change its color, or set its length in ticks (null = auto from content, rounded up to a bar).',
  args: z.object({ id: z.string(), name: z.string().max(64).optional(), color: z.string().optional(), length: z.number().int().min(1).nullable().optional() }),
  run(d, a) {
    const p = must(d.patterns[a.id], `Pattern ${a.id} not found`);
    if (a.name !== undefined) p.name = a.name;
    if (a.color !== undefined) p.color = a.color;
    if (a.length !== undefined) p.length = a.length;
    return {};
  },
});

export const patternsClone = defineCommand({
  id: 'patterns.clone',
  label: () => 'Clone pattern',
  description: 'Duplicate a pattern (notes get new ids). Returns the new pattern id; it becomes active unless select=false.',
  args: z.object({ id: z.string(), name: z.string().optional(), select: z.boolean().default(true) }),
  run(d, a, ctx) {
    const src = must(d.patterns[a.id], `Pattern ${a.id} not found`);
    const id = ctx.newId(ID_PREFIX.pattern);
    const notes: typeof src.notes = {};
    for (const [chId, byId] of Object.entries(src.notes)) {
      notes[chId] = {};
      for (const n of Object.values(byId)) {
        const nid = ctx.newId(ID_PREFIX.note);
        notes[chId][nid] = { ...n, id: nid };
      }
    }
    d.patterns[id] = { id, name: a.name ?? `${src.name} #2`, color: src.color, length: src.length, notes };
    const idx = d.patternOrder.indexOf(a.id);
    d.patternOrder.splice(idx + 1, 0, id);
    if (a.select) d.transport.activePatternId = id;
    return { id };
  },
});

export const patternsMove = defineCommand({
  id: 'patterns.move',
  label: () => 'Reorder patterns',
  description: 'Move a pattern to a new position in the pattern list.',
  args: z.object({ id: z.string(), toIndex: z.number().int().min(0) }),
  run(d, a) {
    must(d.patterns[a.id], `Pattern ${a.id} not found`);
    const order = d.patternOrder.filter((p) => p !== a.id);
    order.splice(Math.min(a.toIndex, order.length), 0, a.id);
    d.patternOrder = order;
    return {};
  },
});

export const patternsSelect = defineCommand({
  id: 'patterns.select',
  label: () => 'Select pattern',
  description: 'Make a pattern the active one (what plays in pattern mode and what the Channel Rack / Piano Roll edit).',
  args: z.object({ id: z.string() }),
  history: false,
  run(d, a) {
    must(d.patterns[a.id], `Pattern ${a.id} not found`);
    d.transport.activePatternId = a.id;
    return {};
  },
});

export const PATTERN_COMMANDS = [patternsAdd, patternsRemove, patternsSet, patternsClone, patternsMove, patternsSelect];
