import { z } from 'zod';
import type { Project } from '@shared/schema/project';
import { orderedTakes, takeGroupsOnTrack, type TakeGroup } from '@shared/schema/takes';
import { secondsToTicks, ticksPerBar, ticksToSeconds } from '@shared/schema/time';
import { defineTool, fail } from './types';
import { findTrack, fmtPos, parseBarRange, parsePosition, plural, round, safeName } from './util';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

export function fmtRange(p: Project, a: number, b: number): string {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  if (a % bar === 0 && b % bar === 0 && b > a) {
    const x = a / bar + 1;
    const y = b / bar;
    return x === y ? `bar ${x}` : `bars ${x}–${y}`;
  }
  return `${fmtPos(a, ts)} to ${fmtPos(b, ts)}`;
}

export function describeTakeGroup(p: Project, g: TakeGroup): string {
  const track = p.playlist.tracks[g.trackId]?.name ?? '?';
  const takes = orderedTakes(g);
  const kind = takes[0]?.source.kind === 'pattern' ? 'MIDI' : 'audio';
  const lanes = takes.map((t) => `take ${t.pass} (${fmtRange(p, t.start, t.end)})`).join(', ');
  const comp = g.comp.length ? g.comp.map((s) => `${fmtRange(p, s.start, s.end)}: take ${g.takes[s.takeId]?.pass ?? '?'}`).join(' · ') : 'empty (silent)';
  const xf = kind === 'audio' ? `, crossfade ${round(ticksToSeconds(g.crossfade, p.transport.bpm) * 1000, 0)} ms` : '';
  return `"${safeName(g.name)}" [${g.id}] on track "${safeName(track)}", ${fmtRange(p, g.start, g.end)}: ${plural(takes.length, `${kind} take`)} (${lanes}). Comp: ${comp}${xf}.`;
}

function findGroup(p: Project, ref: string | undefined): TakeGroup {
  const all = Object.values(p.takeGroups ?? {});
  if (!all.length) fail('There are no take groups. Record in song mode with a loop region on: each loop pass becomes a take.');
  if (ref === undefined || ref === '') {
    if (all.length === 1) return all[0];
    fail(`Several take groups exist; pass group (id, name or track): ${all.map((g) => `"${safeName(g.name)}" [${g.id}]`).join(', ')}`);
  }
  const r = ref.trim();
  if (p.takeGroups?.[r]) return p.takeGroups[r];
  const byName = all.filter((g) => g.name.toLowerCase() === r.toLowerCase());
  if (byName.length === 1) return byName[0];
  let trackId: string | null = null;
  try {
    trackId = findTrack(p, r);
  } catch {
    trackId = null;
  }
  const onTrack = trackId ? takeGroupsOnTrack(p, trackId) : [];
  if (onTrack.length === 1) return onTrack[0];
  if (onTrack.length > 1) fail(`Track "${safeName(r)}" has ${onTrack.length} take groups; pass one id: ${onTrack.map((g) => g.id).join(', ')}`);
  fail(`No take group "${safeName(r)}" (groups: ${all.map((g) => `"${safeName(g.name)}" [${g.id}]`).join(', ')})`);
}

function takeIdOf(g: TakeGroup, take: number | string): string {
  if (typeof take === 'number' || /^\d+$/.test(take)) {
    const t = Object.values(g.takes).find((x) => x.pass === Number(take));
    if (!t) fail(`"${safeName(g.name)}" has no take ${take} (takes: ${orderedTakes(g).map((x) => x.pass).join(', ')})`);
    return t.id;
  }
  if (g.takes[take]) return take;
  const t = Object.values(g.takes).find((x) => x.name.toLowerCase() === take.toLowerCase());
  if (!t) fail(`"${safeName(g.name)}" has no take "${safeName(take)}"`);
  return t.id;
}

const zTakeRef = z.union([z.number().int().min(1), z.string().min(1).max(80)]).describe('Take number (its recording pass, 1-based), name ("Take 2") or id.');

export const compTakes = defineTool({
  name: 'comp_takes',
  title: 'Comp recorded takes',
  kind: 'write',
  readsWhenUnchanged: true,
  description:
    'Take lanes + comping. Recording in song mode over a loop region makes a take group: one take per loop pass (audio: the same file at another offset; MIDI: a pattern per pass); the comp (which take plays where) is placed on the track as ordinary clips with crossfades. With no edit arguments this LISTS the groups (takes, comp, crossfade). Edits, applied in this order: take (use one whole take, "take from pass N"), picks [{take, bars: "5-6"} or {take, from: "5.9", to: "7"}] (swipe-comp: bars inclusive and 1-based, from/to as bar.step with to exclusive; clamped to where the take was recorded), clear [{bars: "8"} or {from, to}] (silence those ranges in the comp, e.g. a breath), crossfade_ms (0 = hard cuts), delete_take, rename (the group), flatten (keep the comp clips, drop the lanes and unused takes). One undo step. Example: {"group":"Vocal","picks":[{"take":2,"bars":"5-6"},{"take":3,"bars":"7"}]}',
  input: z.object({
    group: z.string().max(200).optional().describe('Take group id or name, or its track (name or 1-based number). Optional when there is only one group.'),
    take: zTakeRef.optional().describe('Use this whole take.'),
    picks: z
      .array(
        z.object({
          take: zTakeRef,
          bars: z.string().max(20).optional().describe('Inclusive 1-based bar range, e.g. "5-6" or "7".'),
          from: z.union([z.string(), z.number()]).optional().describe('Start position (bar or "bar.step").'),
          to: z.union([z.string(), z.number()]).optional().describe('End position (exclusive).'),
        }),
      )
      .max(64)
      .optional(),
    clear: z
      .array(
        z.object({
          bars: z.string().max(20).optional().describe('Inclusive 1-based bar range to silence, e.g. "8" or "8-9".'),
          from: z.union([z.string(), z.number()]).optional().describe('Start position (bar or "bar.step").'),
          to: z.union([z.string(), z.number()]).optional().describe('End position (exclusive).'),
        }),
      )
      .max(64)
      .optional()
      .describe('Silence these ranges in the comp (nothing plays there).'),
    crossfade_ms: z.number().min(0).max(500).optional(),
    delete_take: zTakeRef.optional(),
    rename: z.string().min(1).max(64).optional().describe('New name for the take group.'),
    flatten: z.boolean().optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.group ? safeName(a.group, 30) : 'takes'}${a.picks ? ` (${plural(a.picks.length, 'pick')})` : ''}${a.flatten ? ' flatten' : ''}`,
  run(deps, _c, a, ctx) {
    const p0 = deps.doc.project;
    const edits = a.take !== undefined || !!a.picks?.length || !!a.clear?.length || a.crossfade_ms !== undefined || a.delete_take !== undefined || a.rename !== undefined || !!a.flatten;
    if (!edits) {
      const groups = Object.values(p0.takeGroups ?? {});
      if (a.group) {
        const g = findGroup(p0, a.group);
        return { ok: true, message: describeTakeGroup(p0, g), changed: [], data: { groups: [g] } };
      }
      if (!groups.length) return { ok: true, message: 'No take groups yet. Record in song mode with a loop region on: each loop pass becomes a take you can comp here.', changed: [], data: { groups: [] } };
      return { ok: true, message: `${plural(groups.length, 'take group')}:\n${groups.map((g) => `- ${describeTakeGroup(p0, g)}`).join('\n')}`, changed: [], data: { groups } };
    }

    const g0 = findGroup(p0, a.group);
    const gid = g0.id;
    const ts = p0.transport.timeSig;
    const done: string[] = [];
    const cur = () => deps.doc.project.takeGroups?.[gid];

    if (a.take !== undefined) {
      const takeId = takeIdOf(g0, a.take);
      if (ctx.exec<{ changed: boolean }>('takes.select', { groupId: gid, takeId }).changed) done.push(`take ${g0.takes[takeId].pass} everywhere it was recorded`);
    }
    for (const pk of a.picks ?? []) {
      const g = cur()!;
      const takeId = takeIdOf(g, pk.take);
      let start: number;
      let end: number;
      if (pk.bars) ({ start, end } = parseBarRange(pk.bars, ts));
      else if (pk.from !== undefined && pk.to !== undefined) {
        start = parsePosition(pk.from, ts);
        end = parsePosition(pk.to, ts);
      } else fail('each pick needs bars ("5-6") or from + to');
      if (!(end > start)) fail(`pick for take ${pk.take}: the range ends before it starts`);
      if (ctx.exec<{ changed: boolean }>('takes.select', { groupId: gid, takeId, start, end }).changed) done.push(`take ${g.takes[takeId].pass} for ${fmtRange(deps.doc.project, start, end)}`);
    }
    for (const c of a.clear ?? []) {
      let start: number;
      let end: number;
      if (c.bars) ({ start, end } = parseBarRange(c.bars, ts));
      else if (c.from !== undefined && c.to !== undefined) {
        start = parsePosition(c.from, ts);
        end = parsePosition(c.to, ts);
      } else fail('each clear range needs bars ("8") or from + to');
      if (!(end > start)) fail('a clear range ends before it starts');
      if (ctx.exec<{ changed: boolean }>('takes.clearRange', { groupId: gid, start, end }).changed) done.push(`silenced ${fmtRange(deps.doc.project, start, end)}`);
    }
    if (a.crossfade_ms !== undefined) {
      const ticks = Math.round(secondsToTicks(a.crossfade_ms / 1000, deps.doc.project.transport.bpm));
      if (ctx.exec<{ changed: boolean }>('takes.setCrossfade', { groupId: gid, ticks }).changed) done.push(`crossfade ${a.crossfade_ms} ms`);
    }
    if (a.delete_take !== undefined) {
      const g = cur();
      if (!g) fail('The take group is gone (it was flattened or its last take deleted)');
      const takeId = takeIdOf(g, a.delete_take);
      const pass = g.takes[takeId].pass;
      ctx.exec('takes.removeTake', { groupId: gid, takeId });
      done.push(`deleted take ${pass}`);
    }
    if (a.rename !== undefined) {
      const g = cur();
      if (!g) fail('The take group is gone (its last take was deleted)');
      const name = a.rename.trim();
      if (name && name !== g.name) {
        ctx.exec('takes.rename', { groupId: gid, name });
        done.push(`renamed to "${safeName(name)}"`);
      }
    }
    if (a.flatten) {
      if (!cur()) fail('The take group is gone (its last take was deleted)');
      const r = ctx.exec<{ kept: number; removed: number }>('takes.flatten', { groupId: gid });
      done.push(`flattened (kept ${plural(r.kept, 'take')} in the comp, removed ${r.removed} unused)`);
    }
    if (!done.length) fail(`No change: the comp already matched. ${describeTakeGroup(deps.doc.project, cur() ?? g0)}`);
    const g = cur();
    return {
      ok: true,
      message: `"${safeName(g0.name)}": ${done.join('; ')}.${g ? ` Now ${describeTakeGroup(deps.doc.project, g)}` : ' The take lanes are gone; the comp stays as ordinary clips.'}`,
      changed: [],
      data: { group: g ?? null },
    };
  },
});

export const TAKES_TOOLS = [compTakes];
