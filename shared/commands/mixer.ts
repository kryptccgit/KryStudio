import { z } from 'zod';
import { defineCommand, must, CommandError } from './types';
import { MAX_FX_SLOTS, MAX_INSERTS, paletteColor, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { findPlugin } from '../schema/params';
import { clampToSpec } from '../plugins/types';

export function wouldCycle(p: Project, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const ins = p.mixer.inserts[cur];
    if (!ins) continue;
    stack.push(...Object.keys(ins.routes));
  }
  return false;
}

export const mixerAddInsert = defineCommand({
  id: 'mixer.addInsert',
  label: () => 'Add mixer insert',
  description: 'Add a mixer insert track routed to the master. Returns its id.',
  args: z.object({ name: z.string().max(64).optional(), color: z.string().optional(), index: z.number().int().min(1).optional() }),
  run(d, a, ctx) {
    if (d.mixer.insertOrder.length >= MAX_INSERTS) throw new CommandError(`The mixer is limited to ${MAX_INSERTS} inserts`);
    const id = ctx.newId(ID_PREFIX.insert);
    const n = d.mixer.insertOrder.length;
    d.mixer.inserts[id] = {
      id,
      name: a.name ?? `Insert ${n}`,
      color: a.color ?? paletteColor(n),
      volume: 1,
      pan: 0,
      stereoSep: 0,
      mute: false,
      solo: false,
      phaseInvert: false,
      swapLR: false,
      slots: {},
      slotOrder: [],
      routes: { [d.mixer.masterId]: 1 },
      isMaster: false,
    };
    const idx = Math.max(1, Math.min(a.index ?? n, n));
    d.mixer.insertOrder.splice(idx, 0, id);
    return { id };
  },
});

export const mixerRemoveInsert = defineCommand({
  id: 'mixer.removeInsert',
  label: () => 'Delete mixer insert',
  description: 'Delete a mixer insert. Channels routed to it fall back to the master; routes and sidechains pointing at it are removed.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    const ins = must(d.mixer.inserts[a.id], `Insert ${a.id} not found`);
    if (ins.isMaster) throw new CommandError('The master insert cannot be deleted');
    delete d.mixer.inserts[a.id];
    d.mixer.insertOrder = d.mixer.insertOrder.filter((i) => i !== a.id);
    for (const ch of Object.values(d.channels)) if (ch.insertId === a.id) ch.insertId = d.mixer.masterId;
    for (const other of Object.values(d.mixer.inserts)) {
      delete other.routes[a.id];
      for (const s of Object.values(other.slots)) if (s.sidechainFrom === a.id) s.sidechainFrom = null;
    }
    if (d.recording?.insertId === a.id) d.recording.insertId = null;
    return {};
  },
});

export const mixerSetInsert = defineCommand({
  id: 'mixer.setInsert',
  label: () => 'Edit mixer insert',
  description: 'Change insert settings: name, color, volume (linear, 1 = 0 dB, max 2), pan (-1..1), stereoSep (-1 mono .. +1 wide), mute, solo, phaseInvert, swapLR.',
  args: z.object({
    id: z.string(),
    name: z.string().max(64).optional(),
    color: z.string().optional(),
    volume: z.number().min(0).max(2).optional(),
    pan: z.number().min(-1).max(1).optional(),
    stereoSep: z.number().min(-1).max(1).optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional(),
    phaseInvert: z.boolean().optional(),
    swapLR: z.boolean().optional(),
  }),
  run(d, a) {
    const ins = must(d.mixer.inserts[a.id], `Insert ${a.id} not found`);
    const { id: _id, ...rest } = a;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (ins as any)[k] = v;
    return {};
  },
});

export const mixerSetRoute = defineCommand({
  id: 'mixer.setRoute',
  label: (a) => (a.level === null ? 'Remove route' : 'Route insert'),
  description: 'Route insert `from` into insert `to` at a send level (linear, 1 = unity). level null removes the route. Cycles are rejected.',
  args: z.object({ from: z.string(), to: z.string(), level: z.number().min(0).max(2).nullable() }),
  run(d, a) {
    const from = must(d.mixer.inserts[a.from], `Insert ${a.from} not found`);
    must(d.mixer.inserts[a.to], `Insert ${a.to} not found`);
    if (from.isMaster) throw new CommandError('The master cannot route into another insert');
    if (a.level === null) {
      delete from.routes[a.to];
      return {};
    }
    if (!from.routes[a.to] && wouldCycle(d, a.from, a.to)) throw new CommandError('That route would create a feedback loop');
    from.routes[a.to] = a.level;
    return {};
  },
});

export const mixerAddSlot = defineCommand({
  id: 'mixer.addSlot',
  label: () => 'Add effect',
  description: "Insert an effect plugin (e.g. 'krypt.eq', 'krypt.comp', 'krypt.reverb') into an insert's FX chain (max 10). Returns the slot id.",
  args: z.object({ insertId: z.string(), type: z.string(), index: z.number().int().min(0).optional(), params: z.record(z.string(), z.number()).optional(), mix: z.number().min(0).max(1).optional() }),
  run(d, a, ctx) {
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    const desc = must(findPlugin(ctx.catalog, a.type), `Unknown effect "${a.type}"`);
    if (desc.kind !== 'effect') throw new CommandError(`${desc.name} is an instrument, not an effect`);
    if (ins.slotOrder.length >= MAX_FX_SLOTS) throw new CommandError(`An insert holds at most ${MAX_FX_SLOTS} effects`);
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(a.params ?? {})) {
      const spec = must(desc.params.find((p) => p.id === k), `${desc.name} has no parameter "${k}"`);
      params[k] = clampToSpec(spec, v);
    }
    const id = ctx.newId(ID_PREFIX.slot);
    ins.slots[id] = { id, type: a.type, enabled: true, mix: a.mix ?? desc.defaultMix ?? 1, params, sidechainFrom: null };
    ins.slotOrder.splice(Math.min(a.index ?? ins.slotOrder.length, ins.slotOrder.length), 0, id);
    return { id };
  },
});

export const mixerRemoveSlot = defineCommand({
  id: 'mixer.removeSlot',
  label: () => 'Remove effect',
  description: 'Remove an effect from an insert FX chain.',
  args: z.object({ insertId: z.string(), slotId: z.string() }),
  run(d, a) {
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
    delete ins.slots[a.slotId];
    ins.slotOrder = ins.slotOrder.filter((s) => s !== a.slotId);
    for (const aut of Object.values(d.automations)) if (aut.target?.startsWith(`insert/${a.insertId}/slot/${a.slotId}/`)) aut.target = null;
    return {};
  },
});

export const mixerSetSlot = defineCommand({
  id: 'mixer.setSlot',
  label: () => 'Edit effect',
  description: 'Enable/bypass an effect, set its wet/dry mix (0..1), or set the insert that feeds its sidechain input (null = none).',
  args: z.object({ insertId: z.string(), slotId: z.string(), enabled: z.boolean().optional(), mix: z.number().min(0).max(1).optional(), sidechainFrom: z.string().nullable().optional() }),
  run(d, a, ctx) {
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    const slot = must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
    if (a.enabled !== undefined) slot.enabled = a.enabled;
    if (a.mix !== undefined) slot.mix = a.mix;
    if (a.sidechainFrom !== undefined) {
      if (a.sidechainFrom !== null) {
        must(d.mixer.inserts[a.sidechainFrom], `Insert ${a.sidechainFrom} not found`);
        if (!findPlugin(ctx.catalog, slot.type)?.sidechain) throw new CommandError('This effect has no sidechain input');
        if (wouldCycle(d, a.sidechainFrom, a.insertId)) throw new CommandError('That sidechain would create a feedback loop');
      }
      slot.sidechainFrom = a.sidechainFrom;
    }
    return {};
  },
});

export const mixerSetSlotParams = defineCommand({
  id: 'mixer.setSlotParams',
  label: () => 'Set effect params',
  description: "Set effect parameters (plain units per the plugin's ParamSpec; clamped).",
  args: z.object({ insertId: z.string(), slotId: z.string(), params: z.record(z.string(), z.number()) }),
  run(d, a, ctx) {
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    const slot = must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
    const desc = findPlugin(ctx.catalog, slot.type);
    for (const [k, v] of Object.entries(a.params)) {
      const spec = desc?.params.find((p) => p.id === k);
      if (desc && !spec) throw new CommandError(`${desc.name} has no parameter "${k}"`);
      slot.params[k] = spec ? clampToSpec(spec, v) : v;
    }
    return {};
  },
});

export const mixerMoveSlot = defineCommand({
  id: 'mixer.moveSlot',
  label: () => 'Reorder effects',
  description: 'Move an effect to a new position in the FX chain (optionally into another insert).',
  args: z.object({ insertId: z.string(), slotId: z.string(), toIndex: z.number().int().min(0), toInsertId: z.string().optional() }),
  run(d, a) {
    const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    const slot = must(ins.slots[a.slotId], `Effect slot ${a.slotId} not found`);
    const dest = a.toInsertId ? must(d.mixer.inserts[a.toInsertId], `Insert ${a.toInsertId} not found`) : ins;
    if (dest !== ins && dest.slotOrder.length >= MAX_FX_SLOTS) throw new CommandError(`An insert holds at most ${MAX_FX_SLOTS} effects`);
    ins.slotOrder = ins.slotOrder.filter((s) => s !== a.slotId);
    if (dest !== ins) {
      delete ins.slots[a.slotId];
      dest.slots[a.slotId] = slot;
    }
    dest.slotOrder.splice(Math.min(a.toIndex, dest.slotOrder.length), 0, a.slotId);
    return {};
  },
});

export const mixerMoveInsert = defineCommand({
  id: 'mixer.moveInsert',
  label: () => 'Reorder inserts',
  description: 'Move a mixer insert to a new position (the master always stays first).',
  args: z.object({ id: z.string(), toIndex: z.number().int().min(1) }),
  run(d, a) {
    const ins = must(d.mixer.inserts[a.id], `Insert ${a.id} not found`);
    if (ins.isMaster) throw new CommandError('The master insert stays first');
    const order = d.mixer.insertOrder.filter((i) => i !== a.id);
    order.splice(Math.max(1, Math.min(a.toIndex, order.length)), 0, a.id);
    d.mixer.insertOrder = order;
    return {};
  },
});

export const MIXER_COMMANDS = [
  mixerAddInsert,
  mixerRemoveInsert,
  mixerSetInsert,
  mixerSetRoute,
  mixerAddSlot,
  mixerRemoveSlot,
  mixerSetSlot,
  mixerSetSlotParams,
  mixerMoveSlot,
  mixerMoveInsert,
];
