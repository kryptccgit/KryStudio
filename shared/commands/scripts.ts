import { z } from 'zod';
import { defineCommand, CommandError, must, plural } from './types';
import { ID_PREFIX } from '../schema/ids';
import { parseScriptHeader } from '../scripts/header';
import { formatIssues, SCRIPT_ID_PREFIX, SCRIPT_LIMITS } from '../scripts/types';
import { APPLY_SCRIPT_ARGS, planScriptApply } from '../scripts/plan';

export const scriptsSave = defineCommand({
  id: 'scripts.save',
  label: (a) => `Save script${a.name ? ` "${String(a.name).slice(0, 40)}"` : ''}`,
  description:
    'Keep a Krypt Script (a JavaScript note device) in the project, so the song keeps it. code = the script text with its // @name / @kind / @param header and a function run(ctx). id = update that project script; omitted = add one (or update the one with the same name). name overrides the header name. The header must be valid (errors name their line).',
  args: z.object({
    id: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(SCRIPT_LIMITS.nameChars).optional(),
    code: z.string().max(SCRIPT_LIMITS.codeChars),
  }),
  run(d, a, ctx) {
    const h = parseScriptHeader(a.code);
    if (!h.ok) throw new CommandError(`The script has errors:\n${formatIssues(h.issues)}`);
    const name = a.name ?? h.header.name;
    const scripts = (d.scripts ??= {});
    let id = a.id;
    if (id) {
      if (!id.startsWith(`${SCRIPT_ID_PREFIX}_`)) throw new CommandError(`"${id.slice(0, 40)}" is not a project script id (they start with ${SCRIPT_ID_PREFIX}_)`);
      must(scripts[id], `Script ${id} not found in this project`);
    } else id = Object.values(scripts).find((s) => s.name.toLowerCase() === name.toLowerCase())?.id;
    const created = !id;
    if (!id) {
      if (Object.keys(scripts).length >= SCRIPT_LIMITS.perProject) throw new CommandError(`A project can keep at most ${SCRIPT_LIMITS.perProject} scripts; remove one first`);
      id = ctx.newId(SCRIPT_ID_PREFIX);
      scripts[id] = { id, name, code: a.code };
    } else {
      const s = scripts[id];
      if (s.code === a.code && s.name === name) throw new CommandError(`No change: "${name}" is already saved with this code`);
      s.code = a.code;
      s.name = name;
    }
    return { id, name, created, kind: h.header.kind, params: h.header.params.length };
  },
});

export const scriptsRemove = defineCommand({
  id: 'scripts.remove',
  label: () => 'Remove script',
  description: 'Remove a script kept in the project (notes it already wrote stay).',
  args: z.object({ id: z.string() }),
  run(d, a) {
    const s = must(d.scripts?.[a.id], `Script ${a.id} not found in this project`);
    delete d.scripts![a.id];
    if (d.scripts && !Object.keys(d.scripts).length) delete d.scripts;
    return { id: a.id, name: s.name };
  },
});

export const notesApplyScript = defineCommand({
  id: 'notes.applyScript',
  label: (a) => `Script: ${String(a.name ?? 'notes').slice(0, 40)}`,
  description:
    'Write the notes a Krypt Script returned into one channel of a pattern (ONE undo step). The sandbox runs in the app (MCP run_script); this command only writes: kind transform replaces the notes it was given (the selection ids, else the channel\'s notes in range, else all of them); kind generator replaces the channel\'s notes in the bars (mode replace) or adds to them (merge), dropping notes that start outside the bars. Notes are validated and clamped (≤ 4096).',
  args: APPLY_SCRIPT_ARGS,
  run(d, a, ctx) {
    const plan = planScriptApply(d, a);
    const pat = d.patterns[a.patternId];
    const notes = (pat.notes[a.channelId] ??= {});
    for (const id of plan.remove) delete notes[id];
    const ids: string[] = [];
    for (const n of plan.notes) {
      const id = ctx.newId(ID_PREFIX.note);
      notes[id] = { ...n, id };
      ids.push(id);
    }
    if (plan.extendTo) pat.length = plan.extendTo;
    return {
      ids,
      count: ids.length,
      removed: plan.remove.length,
      dropped: plan.dropped,
      skipped: plan.skipped,
      seed: a.seed,
      name: a.name,
      range: { fromBar: plan.range.fromBar, bars: plan.range.bars },
      keyName: plan.keyName,
      extendedTo: plan.extendTo,
      summary: `${plural(ids.length, 'note')}${plan.remove.length ? `, replaced ${plan.remove.length}` : ''}`,
    };
  },
});

export const SCRIPT_COMMANDS = [scriptsSave, scriptsRemove, notesApplyScript];
