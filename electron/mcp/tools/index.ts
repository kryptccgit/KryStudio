import { z } from 'zod';
import type { Patch } from 'immer';
import { actorKey, type ExecResult } from '@shared/doc/DocHost';
import type { AgentActivity } from '@shared/types';
import { MCP_CHANNELS, type MainDeps } from '../types';
import { ToolFailure, type EditSession, type RunCtx, type ToolCaller, type ToolDef, type ToolResult } from './types';
import { idsFromPatches, safeName, touchedFromIds } from './util';
import { ConsentPending, ensurePathAccess, type ConsentAsker, type ConsentRequest } from '../consent';
import { DISCOVERY_TOOLS } from './discovery';
import { COMPOSE_TOOLS } from './compose';
import { SHAPE_TOOLS } from './shape';
import { GENERATE_TOOLS } from './generate';
import { SOUND_TOOLS } from './sound';
import { ARRANGE_TOOLS } from './arrange';
import { MIX_TOOLS } from './mix';
import { MATCH_MIX_TOOLS } from './matchMix';
import { HEARING_TOOLS, TRANSPORT_TOOLS } from './hearing';
import { HISTORY_TOOLS } from './history';
import { PLUGIN_TOOLS } from './plugins';
import { EARS_TOOLS } from './ears';
import { VOCALS_TOOLS } from './vocals';
import { VOICE_TOOLS } from './voice';
import { LIBRARY_TOOLS } from './library';
import { FILE_TOOLS, RELEASE_TOOLS } from './release';
import { RECORDING_TOOLS } from './recording';
import { PRESET_TOOLS } from './presets';
import { MATCH_TOOLS } from './match';
import { CRAFT_TOOLS } from './craft';
import { PACK_TOOLS } from './packs';
import { REFERENCE_TOOLS } from './reference';
import { AUDIO_PROJECT_TOOLS } from './audioProject';
import { MASHUP_TOOLS } from './mashup';
import { AUTOMIX_TOOLS } from './automix';
import { SESSION_TOOLS } from './session';
import { WARP_TOOLS } from './warp';
import { RACK_TOOLS } from './racks';
import { SLICER_TOOLS } from './slicer';
import { SCRIPT_TOOLS } from './scripts';
import { TAKES_TOOLS } from './takes';
import { MIDI_TOOLS } from './midi';

export * from './types';
export { projectOverview } from './overview';
export { patternKpn } from './compose';

export const TOOLS: ToolDef[] = [
  ...DISCOVERY_TOOLS,
  ...COMPOSE_TOOLS,
  ...SHAPE_TOOLS,
  ...GENERATE_TOOLS,
  ...SOUND_TOOLS,
  ...ARRANGE_TOOLS,
  ...MIX_TOOLS,
  ...MATCH_MIX_TOOLS,
  ...AUTOMIX_TOOLS,
  ...HEARING_TOOLS,
  ...TRANSPORT_TOOLS,
  ...HISTORY_TOOLS,
  ...PLUGIN_TOOLS,
  ...EARS_TOOLS,
  ...VOCALS_TOOLS,
  ...VOICE_TOOLS,
  ...LIBRARY_TOOLS,
  ...RELEASE_TOOLS,
  ...PRESET_TOOLS,
  ...MATCH_TOOLS,
  ...CRAFT_TOOLS,
  ...REFERENCE_TOOLS,
  ...AUDIO_PROJECT_TOOLS,
  ...MASHUP_TOOLS,
  ...PACK_TOOLS,
  ...SESSION_TOOLS,
  ...WARP_TOOLS,
  ...RACK_TOOLS,
  ...SLICER_TOOLS,
  ...SCRIPT_TOOLS,
  ...TAKES_TOOLS,
  ...MIDI_TOOLS,
  ...RECORDING_TOOLS,
  ...FILE_TOOLS,
] as ToolDef[];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export function isMutating(def: ToolDef): boolean {
  return def.kind !== 'read';
}

export function newSession(): EditSession {
  return { group: null };
}

export function inputJsonSchema(def: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export interface CallOptions {
  gate?: () => string | null;
  quiet?: boolean;
  onProgress?(fraction: number, message: string): void;
  signal?: AbortSignal;
  consent?: ConsentAsker;
}

export interface CallResult extends ToolResult {
  tool: string;
  summary: string;
  pending?: { request: ConsentRequest; key: string };
}

function zodMessage(name: string, err: z.ZodError): string {
  const issues = err.issues.slice(0, 4).map((i) => {
    const where = i.path.length ? i.path.join('.') : 'arguments';
    return `${where}: ${i.message}`;
  });
  return `Invalid arguments for ${name}: ${issues.join('; ')}${err.issues.length > 4 ? ` (+${err.issues.length - 4} more)` : ''}`;
}

function errMessage(name: string, e: unknown): string {
  if (e instanceof ToolFailure) return e.message;
  return `Internal error in ${name}: ${(e as Error)?.message ?? String(e)}`;
}

export async function callTool(deps: MainDeps, caller: ToolCaller, name: string, rawArgs: unknown, opts: CallOptions = {}): Promise<CallResult> {
  const def = BY_NAME.get(name);
  let result: CallResult;
  if (!def) {
    result = { ok: false, message: `Unknown tool "${safeName(name, 64)}"`, changed: [], tool: name, summary: '' };
    return finish(deps, caller, result, opts);
  }
  const refusal = opts.gate?.();
  if (refusal) return finish(deps, caller, { ok: false, message: refusal, changed: [], tool: name, summary: '' }, opts);
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return finish(deps, caller, { ok: false, message: zodMessage(name, parsed.error), changed: [], tool: name, summary: '' }, opts);
  const args = parsed.data as Record<string, unknown>;
  let summary = '';
  try {
    summary = def.summarize ? def.summarize(args as never, deps) : '';
  } catch {
    summary = '';
  }

  if (def.paths) {
    try {
      for (const p of def.paths(args as never)) {
        if (typeof p.value === 'string' && p.value.trim()) await ensurePathAccess(deps, caller, name, p.value, p.kind, opts.consent);
      }
    } catch (e) {
      if (e instanceof ConsentPending) return { ok: false, message: `Waiting for the user to allow ${e.request.path}`, changed: [], tool: name, summary, pending: { request: e.request, key: e.key } };
      return finish(deps, caller, { ok: false, message: errMessage(name, e), changed: [], tool: name, summary }, opts);
    }
  }

  if (def.kind === 'read') {
    try {
      const r = await def.run(deps, caller, args as never, { ...readOnlyCtx(name), progress: opts.onProgress, signal: opts.signal });
      result = { ...r, changed: [], tool: name, summary };
    } catch (e) {
      result = { ok: false, message: errMessage(name, e), changed: [], tool: name, summary };
    }
    return finish(deps, caller, result, opts);
  }

  result = await serialize(() => runMutating(deps, caller, def, args, summary, opts));
  return finish(deps, caller, result, opts);
}

function readOnlyCtx(name: string): RunCtx {
  const no = (): never => {
    throw new ToolFailure(`${name} is read-only`);
  };
  return { groupId: '', exec: no, execBatch: no, tryExec: no };
}

async function runMutating(deps: MainDeps, caller: ToolCaller, def: ToolDef, args: Record<string, unknown>, summary: string, callOpts: CallOptions = {}): Promise<CallResult> {
  const name = def.name;
  const actor = caller.actor;
  const key = actorKey(actor);
  const declared = caller.session.group;
  const changeLabel = typeof args.change_label === 'string' && args.change_label.trim() ? safeName(args.change_label, 80) : '';
  const label = changeLabel || `${name}${summary ? `: ${summary}` : ''}`.slice(0, 120);
  const ownGroup = def.kind !== 'history' && !declared;
  const groupId = def.kind === 'history' ? '' : declared ? declared.id : deps.doc.beginGroup(actor, label);

  const patches: Patch[] = [];
  const unsub = deps.doc.subscribe((c) => {
    if (c.kind !== 'reset' && actorKey(c.actor) === key) patches.push(...c.patches);
  });
  const opts = () => ({ actor, groupId: groupId || undefined });
  const ctx: RunCtx = {
    groupId,
    exec<T>(cmd: string, a: unknown): T {
      const r = deps.doc.exec<T>(cmd, a, opts());
      if (!r.ok) throw new ToolFailure(r.message ?? `${cmd} failed`);
      return r.data as T;
    },
    execBatch(steps) {
      const r = deps.doc.execBatch(steps, opts());
      if (!r.ok) throw new ToolFailure(r.message ?? 'batch failed');
      return (r.data as unknown[]) ?? [];
    },
    tryExec<T>(cmd: string, a: unknown): ExecResult<T> {
      return deps.doc.exec<T>(cmd, a, opts());
    },
    progress: callOpts.onProgress,
    signal: callOpts.signal,
  };

  let r: ToolResult | null = null;
  let error: unknown = null;
  try {
    r = await def.run(deps, caller, args as never, ctx);
  } catch (e) {
    error = e;
  } finally {
    unsub();
    if (ownGroup) deps.doc.endGroup(groupId);
    if (declared) declared.calls++;
  }
  let changed = idsFromPatches(patches);
  if (declared && changed.length) declared.touched = [...new Set([...(declared.touched ?? []), ...changed])];

  if (error !== null || (r && !r.ok)) {
    let message = error !== null ? errMessage(name, error) : r!.message;
    if (changed.length && def.kind !== 'history') {
      if (ownGroup) {
        const entry = deps.doc.getHistory().find((h) => h.groupId === groupId && !h.undone);
        const back = entry ? deps.doc.toggleEntry(entry.id, actor) : null;
        if (back?.ok) {
          message += ' (Partial edits from this call were rolled back; the project is unchanged.)';
          changed = [];
        } else message += ` (Some edits were applied before the failure: ${changed.join(', ')}.)`;
      } else message += ` (Edits applied before the failure stay in the open group "${safeName(declared?.label)}": ${changed.join(', ')}.)`;
    }
    return { ok: false, message, changed, data: r?.data, text: r?.text, warnings: r?.warnings, tool: name, summary };
  }

  const res = r!;
  if ((def.kind === 'write' || def.kind === 'destructive') && changed.length === 0 && !def.readsWhenUnchanged) {
    return { ok: false, message: `No change: nothing in the project was modified (it already matched the request${summary ? `: ${summary}` : ''}).`, changed: [], warnings: res.warnings, tool: name, summary };
  }
  return { ...res, changed, tool: name, summary };
}

function finish(deps: MainDeps, caller: ToolCaller, result: CallResult, opts: CallOptions): CallResult {
  const def = BY_NAME.get(result.tool);
  const ownTouched = touchedFromIds(result.changed.filter((id) => id !== 'transport' && id !== 'meta' && id !== 'session'));
  if (!opts.quiet) {
    const activity: AgentActivity = {
      clientId: caller.actor.clientId,
      clientName: caller.actor.name,
      tool: result.tool,
      summary: `${result.summary ? `${result.summary} — ` : ''}${result.message}`.slice(0, 300),
      ok: result.ok,
      time: Date.now(),
      touched: ownTouched.length ? ownTouched : undefined,
    };
    try {
      deps.broadcast(MCP_CHANNELS.activity, activity);
    } catch {
    }
    if (def && def.kind !== 'read') deps.log(result.ok ? 'info' : 'warn', `[agent] ${caller.actor.name} ${result.tool}${result.summary ? ` (${result.summary})` : ''}: ${result.ok ? 'ok' : 'failed'} — ${result.message.slice(0, 240)}`);
  }
  return result;
}

export function resultText(r: ToolResult, kind?: string): string {
  const parts = [r.message];
  if (r.warnings?.length) parts.push(`Warnings:\n${r.warnings.map((w) => `- ${w}`).join('\n')}`);
  if (r.text) parts.push(r.text);
  else if (r.data !== undefined && (kind === 'read' || !r.ok)) parts.push(JSON.stringify(r.data));
  if (r.changed.length) parts.push(`changed: ${r.changed.slice(0, 40).join(', ')}${r.changed.length > 40 ? ` (+${r.changed.length - 40})` : ''}`);
  return parts.join('\n\n');
}

export function annotationsFor(def: ToolDef): { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } {
  return {
    title: def.title,
    readOnlyHint: def.kind === 'read',
    destructiveHint: def.kind === 'destructive' || def.name === 'revert_all_agent_edits',
    idempotentHint: def.kind === 'read' || def.name === 'write_pattern' || def.name.startsWith('set_'),
    openWorldHint: false,
  };
}
