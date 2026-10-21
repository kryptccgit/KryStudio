import { z } from 'zod';
import type { PluginDescriptor } from '@shared/plugins/types';
import { formatParam } from '@shared/plugins/types';
import { GATE_STEP_PRESETS, findGateStepPreset, gateStepParams, parseGateSteps, printGateSteps, readGateSteps } from '@shared/plugins/gateSteps';
import { MAX_FX_SLOTS } from '@shared/schema/project';
import { defineTool, fail } from './types';
import { dbToGain, findChannel, findInsert, findPluginRef, findSlot, fmtDb, fmtPan, parseParamValue, pluginName, safeName, tryFindChannel } from './util';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zIns = z.union([z.string(), z.number()]).describe('Insert: name, id, mixer index (0 = master) or a channel name (its insert).');
const zValue = z.union([z.number(), z.string().max(32), z.boolean()]);

function effectParams(desc: PluginDescriptor, input: Record<string, number | string | boolean> | undefined): Record<string, number> | undefined {
  if (!input) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = desc.params.find((s) => s.id === k) ?? desc.params.find((s) => s.id.toLowerCase() === k.toLowerCase() || s.name.toLowerCase() === k.toLowerCase());
    if (!spec) fail(`${desc.name} has no parameter "${safeName(k, 30)}". Params: ${desc.params.map((s) => s.id).join(', ')}`);
    out[spec.id] = parseParamValue(spec, v);
  }
  return out;
}

const zSteps = z
  .string()
  .max(400)
  .optional()
  .describe(
    `Gate/Time only (krypt.gate): custom steps as text or a preset name. Text: [1/32|1/16|1/8|1/4] then 1-16 steps, each P play, R2/R3/R4 roll, RP repeat previous step, H half speed, V reverse, S tape stop, U tape start, . muted; :0-100 sets a level (R4:60). Same codes in a row form one run. Presets: ${GATE_STEP_PRESETS.map((p) => p.name).join(', ')}. Example: "1/16 P P P P P P . P R2 R2 R4 R4 V V S S"`,
  );

function gateSteps(desc: PluginDescriptor, steps: string | undefined): Record<string, number> | undefined {
  if (steps === undefined) return undefined;
  if (desc.id !== 'krypt.gate') fail(`steps only works with Krypt Gate/Time, not ${desc.name}`);
  const preset = findGateStepPreset(steps);
  const r = parseGateSteps(preset ? preset.text : steps);
  if (!r.ok) fail(`${r.message}. Or name a preset: ${GATE_STEP_PRESETS.map((p) => p.name).join(', ')}.`);
  return gateStepParams(r.value);
}

export const setMixer = defineTool({
  name: 'set_mixer',
  title: 'Set mixer levels',
  kind: 'write',
  description: 'Bulk-edit mixer inserts: volume_db, pan (-1..1), stereo_sep (-1 mono .. 1 wide), mute, solo, name, color. Example: {"updates":[{"insert":"808","volume_db":-4},{"insert":"Hat","pan":0.2},{"insert":"Master","volume_db":-1}]}',
  input: z.object({
    updates: z
      .array(
        z.object({
          insert: zIns,
          volume_db: z.number().min(-80).max(6).optional(),
          pan: z.number().min(-1).max(1).optional(),
          stereo_sep: z.number().min(-1).max(1).optional(),
          mute: z.boolean().optional(),
          solo: z.boolean().optional(),
          name: z.string().min(1).max(64).optional(),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        }),
      )
      .min(1)
      .max(128),
    change_label: zLabel,
  }),
  summarize: (a) => a.updates.map((u) => safeName(String(u.insert), 16)).join(', '),
  run(deps, _c, a, ctx) {
    const steps = a.updates.map((u) => {
      const ins = findInsert(deps.doc.project, u.insert);
      return {
        cmd: 'mixer.setInsert',
        args: {
          id: ins.id,
          volume: u.volume_db !== undefined ? Math.min(2, dbToGain(u.volume_db)) : undefined,
          pan: u.pan,
          stereoSep: u.stereo_sep,
          mute: u.mute,
          solo: u.solo,
          name: u.name ? safeName(u.name, 64) : undefined,
          color: u.color,
        },
      };
    });
    ctx.execBatch(steps);
    const p = deps.doc.project;
    const desc = steps.map((s) => {
      const ins = p.mixer.inserts[(s.args as { id: string }).id];
      return `${ins.isMaster ? 'Master' : safeName(ins.name)} ${fmtDb(ins.volume)} pan ${fmtPan(ins.pan)}${ins.stereoSep ? ` sep ${ins.stereoSep}` : ''}${ins.mute ? ' muted' : ''}${ins.solo ? ' solo' : ''}`;
    });
    return { ok: true, message: `Mixer: ${desc.join('; ')}.`, changed: [] };
  },
});

export const addEffect = defineTool({
  name: 'add_effect',
  title: 'Add an effect',
  kind: 'write',
  description:
    'Insert an effect into a mixer insert\'s FX chain (max 10): eq, comp, limiter, clipper, reverb, delay, drive, filter, duck, utility, gate (Gate/Time: stutters, half-time, tape stop, reverse, gates; `steps` writes a custom step pattern) (or krypt.* ids). position is 1-based (default: end); mix 0..100 %. Example: {"insert":"Lead","effect":"reverb","params":{"mode":"Hall","decay":"2.5s"},"mix":25}',
  input: z.object({
    insert: zIns,
    effect: z.string().max(160),
    params: z.record(z.string(), zValue).optional(),
    steps: zSteps,
    position: z.number().int().min(1).max(MAX_FX_SLOTS).optional(),
    mix: z.number().min(0).max(100).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.effect, 16)} → ${safeName(String(a.insert), 24)}`,
  run(deps, _c, a, ctx) {
    const ins = findInsert(deps.doc.project, a.insert);
    const desc = findPluginRef(deps.doc.catalog, a.effect, 'effect');
    const steps = gateSteps(desc, a.steps);
    const params = steps ? { ...effectParams(desc, a.params), ...steps } : effectParams(desc, a.params);
    const r = ctx.exec<{ id: string }>('mixer.addSlot', { insertId: ins.id, type: desc.id, index: a.position !== undefined ? a.position - 1 : undefined, params, mix: a.mix !== undefined ? a.mix / 100 : undefined });
    const now = deps.doc.project.mixer.inserts[ins.id];
    const pos = now.slotOrder.indexOf(r.id) + 1;
    const stepsNote = steps ? ` Steps: ${printGateSteps(readGateSteps(now.slots[r.id].params))}.` : '';
    return {
      ok: true,
      message: `Added ${desc.name} (${r.id}) to ${now.isMaster ? 'Master' : `"${safeName(now.name)}"`} at slot ${pos}. Chain: ${now.slotOrder.map((s) => pluginName(deps.doc.catalog, now.slots[s].type).replace(/^Krypt /, '')).join(' → ')}.${stepsNote}`,
      changed: [],
      data: { id: r.id, slot: pos },
    };
  },
});

export const setEffect = defineTool({
  name: 'set_effect',
  title: 'Edit an effect',
  kind: 'write',
  description: 'Change an effect slot: params (human units), steps (Gate/Time custom steps), enabled (bypass), mix 0..100 %, move_to (1-based position). effect = 1-based slot, slot id, or plugin name on that insert. Example: {"insert":"Master","effect":"limiter","params":{"ceiling":"-1dB","inputGain":"3dB"}}',
  input: z.object({
    insert: zIns,
    effect: z.union([z.string(), z.number()]),
    params: z.record(z.string(), zValue).optional(),
    steps: zSteps,
    enabled: z.boolean().optional(),
    mix: z.number().min(0).max(100).optional(),
    move_to: z.number().int().min(1).max(MAX_FX_SLOTS).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(String(a.insert), 20)} ${safeName(String(a.effect), 16)}`,
  run(deps, _c, a, ctx) {
    const catalog = deps.doc.catalog;
    const ins = findInsert(deps.doc.project, a.insert);
    const sid = findSlot(ins, a.effect, catalog);
    const desc = findPluginRef(catalog, ins.slots[sid].type);
    const plain = effectParams(desc, a.params);
    const steps = gateSteps(desc, a.steps);
    const params = steps ? { ...plain, ...steps } : plain;
    if (params) ctx.exec('mixer.setSlotParams', { insertId: ins.id, slotId: sid, params });
    if (a.enabled !== undefined || a.mix !== undefined) ctx.exec('mixer.setSlot', { insertId: ins.id, slotId: sid, enabled: a.enabled, mix: a.mix !== undefined ? a.mix / 100 : undefined });
    if (a.move_to !== undefined) ctx.exec('mixer.moveSlot', { insertId: ins.id, slotId: sid, toIndex: a.move_to - 1 });
    if (!params && a.enabled === undefined && a.mix === undefined && a.move_to === undefined) fail('Pass params, steps, enabled, mix or move_to.');
    const slot = deps.doc.project.mixer.inserts[ins.id].slots[sid];
    const shown = Object.keys(plain ?? {}).map((k) => `${k} ${formatParam(desc.params.find((s) => s.id === k)!, slot.params[k])}`);
    if (steps) shown.push(`steps ${printGateSteps(readGateSteps(slot.params))}`);
    return {
      ok: true,
      message: `${desc.name} on ${ins.isMaster ? 'Master' : safeName(ins.name)}: ${[...shown, `${slot.enabled ? 'on' : 'BYPASSED'}`, `mix ${Math.round(slot.mix * 100)}%`, `slot ${deps.doc.project.mixer.inserts[ins.id].slotOrder.indexOf(sid) + 1}`].join(', ')}.`,
      changed: [],
    };
  },
});

export const route = defineTool({
  name: 'route',
  title: 'Route channels and inserts',
  kind: 'write',
  description:
    'Routing. {channel, to}: send a channel into a mixer insert ("new" = a fresh insert named after the channel). {from_insert, to}: send an insert into another insert (a bus) at level_db; exclusive (default true) removes its other outputs (incl. the master) so it only feeds the bus. remove: true deletes the from_insert → to route. Example: {"from_insert":"Kick","to":"Drum Bus"}',
  input: z.object({
    channel: z.string().optional(),
    from_insert: zIns.optional(),
    to: zIns,
    level_db: z.number().min(-80).max(6).default(0),
    exclusive: z.boolean().default(true),
    remove: z.boolean().default(false),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel ?? String(a.from_insert ?? '?'), 20)} → ${safeName(String(a.to), 20)}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    if (a.channel) {
      const ch = findChannel(p, a.channel);
      let toId: string;
      if (a.to === 'new') toId = ctx.exec<{ id: string }>('mixer.addInsert', { name: safeName(ch.name, 64), color: ch.color }).id;
      else toId = findInsert(p, a.to).id;
      ctx.exec('channels.set', { id: ch.id, insertId: toId });
      const ins = deps.doc.project.mixer.inserts[toId];
      return { ok: true, message: `Channel ${safeName(ch.name)} now plays through ${ins.isMaster ? 'the Master' : `insert "${safeName(ins.name)}" (${toId})`}.`, changed: [] };
    }
    if (a.from_insert === undefined) fail('Pass channel (channel → insert) or from_insert (insert → insert).');
    const from = findInsert(p, a.from_insert);
    if (a.to === 'new') fail('"new" is only for channel routing; create a bus with route {channel,…} or add_channel, or name an existing insert.');
    const to = findInsert(p, a.to);
    if (from.id === to.id) fail('An insert cannot route into itself.');
    if (a.remove) {
      if (from.routes[to.id] === undefined) fail(`No change: ${safeName(from.name)} doesn't route to ${safeName(to.name)}.`);
      ctx.exec('mixer.setRoute', { from: from.id, to: to.id, level: null });
      return { ok: true, message: `Removed the route ${safeName(from.name)} → ${to.isMaster ? 'Master' : safeName(to.name)}.${Object.keys(deps.doc.project.mixer.inserts[from.id].routes).length === 0 ? ' Warning: it now has no output (silent).' : ''}`, changed: [] };
    }
    const steps: Array<{ cmd: string; args: unknown }> = [{ cmd: 'mixer.setRoute', args: { from: from.id, to: to.id, level: Math.min(2, dbToGain(a.level_db)) } }];
    if (a.exclusive) for (const other of Object.keys(from.routes)) if (other !== to.id) steps.push({ cmd: 'mixer.setRoute', args: { from: from.id, to: other, level: null } });
    ctx.execBatch(steps);
    const now = deps.doc.project.mixer.inserts[from.id];
    return { ok: true, message: `${safeName(from.name)} → ${Object.entries(now.routes).map(([t, l]) => `${t === p.mixer.masterId ? 'Master' : safeName(deps.doc.project.mixer.inserts[t].name)} ${fmtDb(l)}`).join(', ')}.`, changed: [] };
  },
});

export const sidechain = defineTool({
  name: 'sidechain',
  title: 'Sidechain one sound to another',
  kind: 'write',
  description:
    'Make `target` duck when `source` hits (the classic kick → 808/bass/pad pump). Adds (or reuses) a Krypt Duck in "Sidechain follow" mode — or a sidechained Krypt Comp with style "compressor" — on the target\'s insert, fed by the source insert. depth 0..100 %, release_ms. Example: {"source":"Kick","target":"808","depth":70}',
  input: z.object({
    source: zIns.describe('The trigger (e.g. "Kick"): a channel name or insert.'),
    target: zIns.describe('What ducks (e.g. "808", "Bass", "Pad").'),
    style: z.enum(['duck', 'compressor']).default('duck'),
    depth: z.number().min(0).max(100).default(70),
    release_ms: z.number().min(10).max(2000).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(String(a.source), 20)} → ${safeName(String(a.target), 20)}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const src = findInsert(p, a.source);
    const dst = findInsert(p, a.target);
    if (src.id === dst.id) {
      const sc = tryFindChannel(p, String(a.source));
      fail(`${safeName(String(a.source))} and ${safeName(String(a.target))} play through the same insert (${safeName(src.name)}${sc ? '' : ''}); route one of them to its own insert first (route {channel, to:"new"}).`);
    }
    if (dst.isMaster) fail('Sidechaining the master would duck everything; pick the bass/pad/808 insert.');
    const type = a.style === 'duck' ? 'krypt.duck' : 'krypt.comp';
    let sid = dst.slotOrder.find((s) => dst.slots[s].type === type);
    if (!sid) {
      const params = a.style === 'duck' ? { mode: 1, depth: a.depth / 100, release: a.release_ms ?? 160 } : { useSidechain: 1, threshold: -30, ratio: 4 + (a.depth / 100) * 8, attack: 1, release: a.release_ms ?? 120 };
      sid = ctx.exec<{ id: string }>('mixer.addSlot', { insertId: dst.id, type, params, index: 0 }).id;
    } else {
      const params = a.style === 'duck' ? { mode: 1, depth: a.depth / 100, ...(a.release_ms ? { release: a.release_ms } : {}) } : { useSidechain: 1, ratio: 4 + (a.depth / 100) * 8, ...(a.release_ms ? { release: a.release_ms } : {}) };
      ctx.exec('mixer.setSlotParams', { insertId: dst.id, slotId: sid, params });
    }
    ctx.exec('mixer.setSlot', { insertId: dst.id, slotId: sid, sidechainFrom: src.id, enabled: true });
    return {
      ok: true,
      message: `${dst.isMaster ? 'Master' : safeName(dst.name)} now ducks under ${safeName(src.name)}: ${pluginName(deps.doc.catalog, type)} (${sid}) depth ${a.depth}% sidechained from insert ${src.id}. Check it with render_preview.`,
      changed: [],
      data: { slotId: sid },
    };
  },
});

export const MIX_TOOLS = [setMixer, addEffect, setEffect, route, sidechain];
