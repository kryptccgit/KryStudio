// write_script / run_script: Krypt Script for agents (Wave 12.2b). An agent
// writes a JavaScript note device (header + run(ctx)); the app checks it
// (header, compile and one trial run in the QuickJS sandbox) and answers
// with line-numbered errors to fix. run_script runs a script on a channel
// of a pattern as ONE undo step (notes.applyScript), or as a dry run that
// returns the notes as KPN and changes nothing. Scripts never run outside
// the sandbox (electron/scripts/sandbox.ts).

import { z } from 'zod';
import { parseKey } from '@shared/music/theory';
import { ticksPerBar } from '@shared/schema/time';
import { printKpn } from '@shared/kpn';
import { HEADER_SYNTAX, describeParams } from '@shared/scripts/header';
import { formatIssues, SCRIPT_LIMITS } from '@shared/scripts/types';
import { factoryScripts, ScriptService } from '../../scripts/service';
import type { MainDeps } from '../types';
import { defineTool, fail } from './types';
import { findChannel, findPattern, parseBarRange, plural, safeName } from './util';
import { isDrumChannel } from './overview';

const service = (deps: MainDeps): ScriptService => new ScriptService({ userDataDir: deps.userDataDir, project: () => deps.doc.project });

const FACTORY_LIST = factoryScripts()
  .filter((s) => s.header)
  .map((s) => `"${s.name}" (${s.header!.kind}; ${s.header!.params.map((p) => p.id).join(', ')})`)
  .join(', ');

const API = [
  'A script is plain JavaScript (no import/require, no I/O, no timers, no Date: it runs in a sandbox with a 200 ms CPU and 32 MB memory limit) with a header of // @ lines and ONE function run(ctx) that returns notes:',
  HEADER_SYNTAX,
  'function run(ctx) { … return [{ tick, dur, key, vel }] }  (ticks: PPQ 960, pattern ticks; key MIDI 0..127; vel 0..1; optional pan -1..1, slide, mute, color 0..15). At most 4096 notes; values are clamped.',
  'ctx: notes (a transform gets the selected notes or the channel\'s notes in the bars; a generator gets the notes already in the bars), params (the @param values), key (root pitch class 0..11), scale, scaleSteps, keyName, bpm, timeSig, ppq, barTicks, beatTicks, stepTicks, start, end, lengthTicks, bars, chords [{tick,end,keys,root,name}] in the pattern, rootKey, seed; rand() seeded [0,1) with rand.int(lo,hi), rand.range(lo,hi), rand.chance(p), rand.pick(arr), rand.weighted(weights), rand.shuffle(arr) (Math.random is rand too: same seed = same notes); helpers inScale(key), snap(key) (nearest key in the scale), degree(d, octave=4) (scale degree d from 0 → MIDI), euclid(pulses, steps, rotation) → booleans, chordAt(tick), clamp(v,lo,hi), log(...) (console.log works too).',
  'kind generator: writes notes into the bars (replace or merge; notes starting outside the bars are dropped). kind transform: its result REPLACES the notes it got.',
].join('\n');

export const writeScript = defineTool({
  name: 'write_script',
  title: 'Write a script (note device)',
  kind: 'write',
  readsWhenUnchanged: true,
  description: [
    'Create or update a Krypt Script: a small JavaScript NOTE device (generator or transform) the user can run from the piano roll (Tools ▸ Scripts…) and you can run with run_script. The app checks the header, compiles it and runs it once on a made-up 2-bar A minor context; any problem comes back as "Line N: …" so you can fix it and call again. Nothing is saved until it passes.',
    API,
    'where: project (default; the song keeps the device, one undo step) or library (the user\'s script library, for every project). A project script with the same name is updated (or pass id). Factory scripts to learn from or run directly: ' + FACTORY_LIST + '.',
  ].join('\n'),
  input: z.object({
    code: z.string().min(1).max(SCRIPT_LIMITS.codeChars).describe('The whole script: the // @ header lines and function run(ctx).'),
    where: z.enum(['project', 'library']).default('project'),
    id: z.string().max(64).optional().describe('A project script id (scr_…) to update.'),
    name: z.string().max(SCRIPT_LIMITS.nameChars).optional().describe('Overrides the @name in the header.'),
    change_label: z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel."),
  }),
  summarize: (a) => `${a.where === 'library' ? 'library' : 'project'} script${a.name ? ` "${safeName(a.name, 40)}"` : ''}`,
  async run(deps, _c, a, ctx) {
    const svc = service(deps);
    const check = await svc.check(a.code, { trial: true });
    if (!check.ok) {
      const headerProblem = !check.header;
      fail(`The script has ${plural(check.issues.length, 'problem')}; nothing was saved. Fix and call write_script again:\n${formatIssues(check.issues, 12)}${headerProblem ? `\nHeader syntax:\n${HEADER_SYNTAX}` : ''}`);
    }
    const h = check.header!;
    const name = (a.name?.trim() || h.name).slice(0, SCRIPT_LIMITS.nameChars);
    const params = describeParams(h);
    if (a.where === 'library') {
      const r = await svc.saveToLibrary(a.code, a.name);
      if (!r.ok || !r.data) fail(r.message ?? 'Saving to the library failed');
      return {
        ok: true,
        message: `${r.data.created ? 'Saved' : 'Updated'} "${safeName(r.data.name)}" (${h.kind}; ${params}) in the user's script library as ${r.data.id}. Run it with run_script {"script":"${safeName(r.data.name)}","channel":…}; dry_run shows the notes first.`,
        changed: [],
        data: { id: r.data.id, name: r.data.name, kind: h.kind, params: h.params.map((p) => p.id) },
      };
    }
    const r = ctx.exec<{ id: string; name: string; created: boolean }>('scripts.save', { id: a.id, name: a.name?.trim() || undefined, code: a.code });
    return {
      ok: true,
      message: `${r.created ? 'Saved' : 'Updated'} "${safeName(r.name)}" (${h.kind}; ${params}) in the project as ${r.id}. Run it with run_script {"script":"${safeName(name)}","channel":…}; dry_run shows the notes first. The user finds it in the piano roll under Tools ▸ Scripts….`,
      changed: [],
      data: { id: r.id, name: r.name, kind: h.kind, params: h.params.map((p) => p.id) },
    };
  },
});

export const runScript = defineTool({
  name: 'run_script',
  title: 'Run a script',
  kind: 'write',
  readsWhenUnchanged: true,
  description: [
    'Run a Krypt Script (a JavaScript note device: write your own with write_script) on one channel of a pattern, as ONE undo step. script = a name or id: a project script, one from the user\'s library, or a factory one: ' + FACTORY_LIST + '.',
    'A generator writes into the bars (mode replace rewrites the channel there; merge adds). A transform replaces the channel\'s notes in the bars (all of them when bars is omitted) with what it returns. params = the script\'s @param values (unknown names are errors); seed: the same seed gives the same notes, another seed (or none) a new take. key defaults to the pattern\'s key.',
    'dry_run: true runs it and returns the notes as KPN without changing anything (check a take before writing it).',
    'Example: {"script":"Euclid with probability","channel":"Hat","params":{"pulses":7,"chance":0.7},"bars":"1-4","seed":3}',
  ].join('\n'),
  input: z.object({
    script: z.string().min(1).max(80).describe('Script name or id (factory:…, user:…, scr_…).'),
    channel: z.string().describe('Channel name or id.'),
    pattern: z.string().max(80).optional().describe('Pattern id or name; default the active pattern.'),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    seed: z.number().int().min(0).max(2147483647).optional().describe('Omit for a fresh take; reuse one from an earlier result to get that take again.'),
    bars: z.string().max(16).optional().describe('"1-4" (1-based, inclusive). Default: the whole pattern.'),
    mode: z.enum(['replace', 'merge']).default('replace').describe('Generators only.'),
    key: z.string().max(24).optional().describe('Key, e.g. "F#m", "C", "D dorian". Default: the key the pattern is in.'),
    dry_run: z.boolean().default(false),
    change_label: z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel."),
  }),
  summarize: (a) => `${safeName(a.script, 40)} on ${safeName(a.channel, 30)}${a.dry_run ? ' (dry run)' : ''}`,
  async run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const svc = service(deps);
    const found = await svc.find(a.script);
    if (!found) {
      const cat = await svc.catalog();
      const names = [...cat.project, ...cat.user, ...cat.factory].map((s) => `"${safeName(s.name, 40)}"`).join(', ');
      fail(`No script "${safeName(a.script, 60)}". Scripts: ${names}. Write one with write_script.`);
    }
    if (!found.header) fail(`"${safeName(found.name)}" has errors:\n${formatIssues(found.issues)}\nFix it with write_script.`);
    let key: { root: number; scale: string } | undefined;
    if (a.key) {
      const k = parseKey(a.key);
      if (!k) fail(`Unknown key "${safeName(a.key, 24)}" (use e.g. "F#m", "C", "D dorian", "A minorPentatonic")`);
      key = { root: k.root, scale: k.scale };
    }
    const bar = ticksPerBar(p.transport.timeSig);
    const range = a.bars ? (({ start, bars }) => ({ fromBar: start / bar + 1, bars }))(parseBarRange(a.bars, p.transport.timeSig)) : undefined;
    const seed = a.seed ?? Math.floor(Math.random() * 2 ** 31);
    const req = { script: { id: found.id }, patternId: pat.id, channelId: ch.id, range, mode: a.mode, params: a.params, seed, key };
    const prep = await svc.prepare(req, { strict: true, allowSame: a.dry_run });
    if (!prep.ok || !prep.data) fail(prep.message ?? 'The script failed');
    const plan = prep.data.plan;
    const where = plan.range.bars === 1 ? `bar ${plan.range.fromBar}` : `bars ${plan.range.fromBar}–${plan.range.fromBar + plan.range.bars - 1}`;
    const logs = plan.logs.length ? `\nScript log:\n${plan.logs.slice(0, 20).join('\n')}` : '';
    const extra = `${plan.dropped ? ` ${plural(plan.dropped, 'note')} started outside the bars and were left out.` : ''}${plan.skipped ? ` ${plural(plan.skipped, 'duplicate note')} left out.` : ''}`;
    if (a.dry_run) {
      const kpn = printKpn([{ name: safeName(ch.name, 40), notes: plan.notes, drum: isDrumChannel(ch), drumKey: ch.rootKey }], {
        name: safeName(pat.name, 64),
        bars: plan.range.fromBar - 1 + plan.range.bars,
        ts: p.transport.timeSig,
        key: plan.keyName,
      });
      return {
        ok: true,
        message: `Dry run of "${safeName(plan.name)}" on ${safeName(ch.name)} in "${safeName(pat.name)}": ${plural(plan.notes.length, 'note')} in ${where}${plan.remove.length ? `, would replace ${plan.remove.length}` : ''}, ${plan.keyName}, seed ${plan.seed}, ${plan.ms} ms.${extra} Nothing was changed; call again without dry_run (same seed) to write this take.${logs}`,
        changed: [],
        text: kpn.text,
        data: { seed: plan.seed, notes: plan.notes.length, replaces: plan.remove.length },
      };
    }
    const r = ctx.exec<{ ids: string[]; count: number; removed: number; extendedTo: number | null }>('notes.applyScript', prep.data.args);
    const grown = r.extendedTo ? ` The pattern grew to ${r.extendedTo / bar} bars.` : '';
    return {
      ok: true,
      message: `"${safeName(plan.name)}" on ${safeName(ch.name)} in "${safeName(pat.name)}": ${plural(r.count, 'note')} in ${where}${r.removed ? `, replacing ${r.removed}` : ''}, ${plan.keyName}, seed ${plan.seed}.${extra}${grown} Same seed = same notes; call again with another seed for a new take, or undo_last to drop it.${logs}`,
      changed: [],
      data: { seed: plan.seed, notes: r.count, replaced: r.removed },
    };
  },
});

export const SCRIPT_TOOLS = [writeScript, runScript];
