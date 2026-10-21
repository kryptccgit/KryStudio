import { z } from 'zod';
import { actorKey } from '@shared/doc/DocHost';
import { defineTool, fail } from './types';
import { plural, safeName } from './util';
import { originalityLines } from './library';
import type { MainDeps } from '../types';

export const undoLast = defineTool({
  name: 'undo_last',
  title: 'Undo my last edit',
  kind: 'history',
  description: 'Undo YOUR most recent edit (one tool call, or one begin_edit … commit_edit group). The user\'s own edits are never touched. Fails with the reason if a later edit changed the same thing.',
  input: z.object({}),
  run(deps, caller) {
    const r = deps.doc.undo(caller.actor);
    if (!r.ok) fail(r.message ?? 'Nothing to undo');
    return { ok: true, message: `${r.message ?? 'Undone'}.`, changed: [] };
  },
});

export const revertAll = defineTool({
  name: 'revert_all_agent_edits',
  title: 'Revert all my edits',
  kind: 'history',
  description: 'Undo EVERY edit you (this client) made in this session, newest first — the "put it back how it was" button. Edits the user made later on the same things are kept and reported.',
  input: z.object({ confirm: z.literal(true).describe('Must be true.') }),
  run(deps, caller) {
    if (caller.session.group) {
      deps.doc.endGroup(caller.session.group.id);
      caller.session.group = null;
    }
    const r = deps.doc.revertActor(caller.actor, caller.actor);
    const n = (r.data as { reverted?: number } | undefined)?.reverted ?? 0;
    if (!r.ok) {
      if (n) return { ok: false, message: `Reverted ${plural(n, 'edit')}, but some could not be reverted: ${r.message}`, changed: [] };
      fail(r.message ?? 'Nothing to revert');
    }
    if (!n) fail('No change: you have no edits to revert.');
    return { ok: true, message: `Reverted ${plural(n, 'edit')} — the project is back to how it was before your changes (the user's own edits are kept).`, changed: [] };
  },
});

export const beginEdit = defineTool({
  name: 'begin_edit',
  title: 'Begin a labelled edit group',
  kind: 'history',
  description: 'Start a named group: every edit until commit_edit becomes ONE entry in the user\'s AI history ("Trap drums + 808"), undone with a single undo_last. Use it for multi-step changes the user should judge as one idea.',
  input: z.object({ label: z.string().min(1).max(80) }),
  run(deps, caller, a) {
    if (caller.session.group) fail(`An edit group is already open ("${safeName(caller.session.group.label)}"); call commit_edit first.`);
    const id = deps.doc.beginGroup(caller.actor, safeName(a.label, 80));
    caller.session.group = { id, label: safeName(a.label, 80), started: Date.now(), calls: 0 };
    return { ok: true, message: `Edit group "${safeName(a.label)}" open: your next edits fold into one history entry until commit_edit.`, changed: [], data: { groupId: id } };
  },
});

export const commitEdit = defineTool({
  name: 'commit_edit',
  title: 'Commit the edit group',
  kind: 'history',
  description:
    'Close the group opened by begin_edit. Its edits stay applied as one undoable history entry. When the user has set a style focus whose collection has deep-analysed references, the melodies you wrote in the group are checked against them and close matches come back as warnings (the edit is kept either way).',
  input: z.object({}),
  async run(deps, caller) {
    const g = caller.session.group;
    if (!g) fail('No edit group is open (call begin_edit first).');
    deps.doc.endGroup(g.id);
    caller.session.group = null;
    const entry = deps.doc.getHistory().find((h) => h.groupId === g.id);
    if (!entry) return { ok: true, message: `Closed "${safeName(g.label)}": it made no changes (${plural(g.calls, 'call')}).`, changed: [] };
    const warnings = await focusOriginality(deps, g.touched ?? []);
    return {
      ok: true,
      message: `Committed "${safeName(g.label)}": ${plural(g.calls, 'call')}, ${plural(entry.changes, 'change')} as one history entry${entry.undone ? ' (currently undone)' : ''}.`,
      changed: [],
      warnings: warnings.length ? warnings : undefined,
    };
  },
});

async function focusOriginality(deps: MainDeps, touched: string[]): Promise<string[]> {
  if (!deps.library) return [];
  const p = deps.doc.project;
  const patternIds = touched.filter((id) => !!p.patterns[id]);
  if (!patternIds.length) return [];
  try {
    const rep = await deps.library.originalityForFocus(patternIds);
    if (!rep || !rep.matches.length) return [];
    return [
      `Originality (focus "${safeName(deps.library.focus()?.name ?? '', 60)}"): ${plural(rep.matches.length, 'line')} you wrote sit close to the user's references. Vary the intervals and rhythm, then check_originality:`,
      ...originalityLines(rep, 8),
    ];
  } catch (err) {
    deps.log('warn', `Originality check after commit_edit failed: ${(err as Error).message}`);
    return [];
  }
}

export const getHistory = defineTool({
  name: 'get_history',
  title: 'Edit history',
  kind: 'read',
  description: 'Recent history entries, newest first: who (you, other agents, the user), label, size, age and whether undone. who "me" = only your edits.',
  input: z.object({ limit: z.number().int().min(1).max(100).default(20), who: z.enum(['me', 'all']).default('all') }),
  run(deps, caller, a) {
    const mine = actorKey(caller.actor);
    const now = Date.now();
    const rows = deps.doc
      .getHistory()
      .filter((h) => a.who === 'all' || h.actorKey === mine)
      .slice(-a.limit)
      .reverse()
      .map((h) => ({ id: h.id, who: h.actorKey === mine ? 'you' : safeName(h.actorName, 40), label: safeName(h.label, 100), changes: h.changes, ageSec: Math.round((now - h.time) / 1000), undone: h.undone }));
    const text = rows.map((r) => `${r.id}  ${r.who}: ${r.label} · ${plural(r.changes, 'change')} · ${r.ageSec}s ago${r.undone ? ' · UNDONE' : ''}`).join('\n');
    const open = caller.session.group ? `Open edit group: "${safeName(caller.session.group.label)}".` : '';
    return { ok: true, message: `${plural(rows.length, 'entry', 'entries')}.${open ? ` ${open}` : ''}`, changed: [], text: text || '(empty)', data: { entries: rows } };
  },
});

export const HISTORY_TOOLS = [undoLast, revertAll, beginEdit, commitEdit, getHistory];
