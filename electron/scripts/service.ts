import path from 'node:path';
import type { Project } from '@shared/schema/project';
import type { ActionResult } from '@shared/types';
import { CommandError } from '@shared/commands/types';
import { FACTORY_SCRIPTS } from '@shared/scripts/factory';
import { defaultParams, parseScriptHeader, resolveParams } from '@shared/scripts/header';
import { cleanScriptOutput } from '@shared/scripts/output';
import { planScriptApply, scriptContext, scriptScope, type ApplyScriptArgs } from '@shared/scripts/plan';
import { sampleContext } from '@shared/scripts/sample';
import {
  formatIssues,
  scriptSourceOf,
  SCRIPT_LIMITS,
  type ScriptApplyOutcome,
  type ScriptCatalog,
  type ScriptCheck,
  type ScriptHeader,
  type ScriptInfo,
  type ScriptIssue,
  type ScriptPlan,
  type ScriptRunRequest,
} from '@shared/scripts/types';
import { describeFsError, listFilesWithExt, readText, removeFile, writeFileAtomic } from '../system/files';
import { runSandboxed, compileCheck } from './sandbox';

export type ScriptApply = <T = unknown>(cmd: string, args: unknown) => T;

export interface ScriptServiceDeps {
  userDataDir: string;
  project(): Project;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_LIBRARY = 200;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'script';
}

function info(id: string, source: ScriptInfo['source'], code: string, fallbackName: string): ScriptInfo {
  const h = parseScriptHeader(code);
  return { id, source, name: h.ok ? h.header.name : fallbackName, code, header: h.ok ? h.header : null, issues: h.issues };
}

const FACTORY: ScriptInfo[] = FACTORY_SCRIPTS.map((s) => info(s.id, 'factory', s.code, s.id.slice('factory:'.length)));

export function factoryScripts(): ScriptInfo[] {
  return FACTORY;
}

function where(p: { range: { fromBar: number; bars: number } }): string {
  const { fromBar, bars } = p.range;
  return bars === 1 ? `bar ${fromBar}` : `bars ${fromBar}–${fromBar + bars - 1}`;
}

export function cleanRunRequest(v: unknown): ScriptRunRequest | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = (o.script && typeof o.script === 'object' ? o.script : {}) as Record<string, unknown>;
  const script = typeof s.code === 'string' ? { code: s.code.slice(0, SCRIPT_LIMITS.codeChars + 1) } : typeof s.id === 'string' && s.id ? { id: s.id.slice(0, 80) } : null;
  if (!script || typeof o.patternId !== 'string' || typeof o.channelId !== 'string') return null;
  const int = (x: unknown, lo: number, hi: number): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : null);
  const r = (o.range && typeof o.range === 'object' ? o.range : null) as Record<string, unknown> | null;
  const fromBar = r ? int(r.fromBar, 1, 4096) : null;
  const bars = r ? int(r.bars, 1, 256) : null;
  const k = (o.key && typeof o.key === 'object' ? o.key : null) as Record<string, unknown> | null;
  const root = k ? int(k.root, 0, 11) : null;
  return {
    script,
    patternId: o.patternId,
    channelId: o.channelId,
    ids: Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === 'string').slice(0, 20000) : undefined,
    range: fromBar !== null && bars !== null ? { fromBar, bars } : undefined,
    mode: o.mode === 'merge' ? 'merge' : 'replace',
    params: o.params && typeof o.params === 'object' && !Array.isArray(o.params) ? (o.params as Record<string, unknown>) : undefined,
    seed: int(o.seed, 0, 0xffffffff) ?? 1,
    key: root !== null && k && typeof k.scale === 'string' ? { root, scale: k.scale.slice(0, 32) } : undefined,
  };
}

export interface PreparedRun {
  plan: ScriptPlan;
  header: ScriptHeader;
  args: ApplyScriptArgs;
}

export class ScriptService {
  constructor(private readonly deps: ScriptServiceDeps) {}

  get libraryDir(): string {
    return path.join(this.deps.userDataDir, 'scripts');
  }

  private fileFor(slug: string): string {
    return path.join(this.libraryDir, `${slug}.js`);
  }

  async userScripts(): Promise<ScriptInfo[]> {
    const files = (await listFilesWithExt(this.libraryDir, '.js')).slice(0, MAX_LIBRARY);
    const out: ScriptInfo[] = [];
    for (const f of files) {
      const slug = path.basename(f, '.js').toLowerCase();
      if (!SLUG.test(slug)) continue;
      const code = await readText(f);
      if (code === null) continue;
      if (code.length > SCRIPT_LIMITS.codeChars) {
        out.push({ id: `user:${slug}`, source: 'user', name: slug, code: '', header: null, issues: [{ line: 0, message: `${path.basename(f)} is too long (limit ${SCRIPT_LIMITS.codeChars} characters)` }] });
        continue;
      }
      out.push(info(`user:${slug}`, 'user', code, slug));
    }
    return out;
  }

  projectScripts(): ScriptInfo[] {
    return Object.values(this.deps.project().scripts ?? {}).map((s) => ({ ...info(s.id, 'project', s.code, s.name), name: s.name }));
  }

  async catalog(): Promise<ScriptCatalog> {
    return { factory: FACTORY, user: await this.userScripts(), project: this.projectScripts(), libraryDir: this.libraryDir };
  }

  async find(ref: string): Promise<ScriptInfo | null> {
    const r = ref.trim();
    const src = scriptSourceOf(r);
    if (src === 'factory') return FACTORY.find((s) => s.id === r) ?? null;
    if (src === 'project') return this.projectScripts().find((s) => s.id === r) ?? null;
    if (src === 'user') return (await this.userScripts()).find((s) => s.id === r.toLowerCase()) ?? null;
    const lower = r.toLowerCase();
    const all = [...this.projectScripts(), ...(await this.userScripts()), ...FACTORY];
    return all.find((s) => s.name.toLowerCase() === lower) ?? all.find((s) => s.id.toLowerCase().endsWith(`:${lower}`)) ?? null;
  }

  async check(code: string, opts: { trial?: boolean } = {}): Promise<ScriptCheck> {
    const h = parseScriptHeader(code);
    if (!h.ok) {
      const compile = typeof code === 'string' && code.trim() && code.length <= SCRIPT_LIMITS.codeChars ? await compileCheck(code) : [];
      const issues = [...h.issues, ...compile.filter((c) => !/needs a function run/.test(c.message) || !h.issues.some((i) => /function run/.test(i.message)))];
      return { ok: false, header: null, issues: issues.sort((a, b) => a.line - b.line) };
    }
    const compile = await compileCheck(code);
    if (compile.length) return { ok: false, header: h.header, issues: compile };
    if (opts.trial) {
      const issues: ScriptIssue[] = [];
      const ctx = sampleContext(h.header, defaultParams(h.header));
      const r = await runSandboxed(code, ctx);
      if (!r.ok) issues.push({ line: r.line, message: `On a test run (2 bars of A minor${h.header.kind === 'transform' ? ' with an Am and an F chord' : ''}): ${r.message}` });
      else {
        const clean = cleanScriptOutput(r.value);
        if (!clean.ok) issues.push({ line: 0, message: `On a test run: ${clean.message}` });
      }
      if (issues.length) return { ok: false, header: h.header, issues };
    }
    return { ok: true, header: h.header, issues: [] };
  }

  async prepare(req: ScriptRunRequest, opts: { strict?: boolean; allowSame?: boolean } = {}): Promise<ActionResult<PreparedRun>> {
    const fail = (message: string): ActionResult<PreparedRun> => ({ ok: false, message });
    let code: string;
    let label: string | null = null;
    if (req.script && 'code' in req.script && typeof req.script.code === 'string') code = req.script.code;
    else if (req.script && 'id' in req.script && typeof req.script.id === 'string') {
      const s = await this.find(req.script.id);
      if (!s) return fail(`No script "${req.script.id.slice(0, 64)}"`);
      code = s.code;
      label = s.name;
    } else return fail('Pick a script first');
    const h = parseScriptHeader(code);
    if (!h.ok) return fail(`The script has errors:\n${formatIssues(h.issues)}`);
    const name = (label ?? h.header.name).slice(0, SCRIPT_LIMITS.nameChars);
    const params = resolveParams(h.header, req.params, opts.strict === true);
    if (!params.ok) return fail(params.message);
    const seed = Number.isFinite(req.seed) ? Math.floor(Math.abs(req.seed)) % 0x100000000 : 1;
    const target = { patternId: String(req.patternId ?? ''), channelId: String(req.channelId ?? ''), ids: req.ids?.length ? req.ids : undefined, range: req.range, mode: req.mode ?? 'replace', key: req.key };
    const project = this.deps.project();
    let ctx;
    try {
      const scope = scriptScope(project, target, h.header.kind);
      ctx = scriptContext(project, target, scope, name, params.params, seed);
    } catch (e) {
      if (e instanceof CommandError) return fail(e.message);
      return fail(`Invalid target: ${(e as Error)?.message ?? String(e)}`);
    }
    const r = await runSandboxed(code, ctx);
    if (!r.ok) return fail(`"${name}"${r.line ? ` line ${r.line}` : ''}: ${r.message}`);
    const clean = cleanScriptOutput(r.value);
    if (!clean.ok) return fail(`"${name}": ${clean.message}`);
    const args: ApplyScriptArgs = { ...target, kind: h.header.kind, name, seed, notes: clean.notes };
    try {
      const p = planScriptApply(this.deps.project(), args, { allowSame: opts.allowSame });
      const plan: ScriptPlan = {
        name,
        kind: h.header.kind,
        seed,
        notes: p.notes.map((n) => ({ tick: n.tick, dur: n.dur, key: n.key, vel: n.vel, pan: n.pan, release: n.release, fine: n.fine, slide: n.slide, ...(n.mute ? { mute: true } : {}), ...(n.color ? { color: n.color } : {}) })),
        remove: p.remove,
        range: p.range,
        keyName: p.keyName,
        dropped: p.dropped,
        skipped: p.skipped,
        extendTo: p.extendTo,
        logs: r.logs,
        ms: r.ms,
      };
      return { ok: true, data: { plan, header: h.header, args } };
    } catch (e) {
      if (e instanceof CommandError) return fail(e.message);
      throw e;
    }
  }

  async previews(req: ScriptRunRequest, seeds: number[]): Promise<Array<ActionResult<ScriptPlan>>> {
    const out: Array<ActionResult<ScriptPlan>> = [];
    for (const seed of seeds.slice(0, 8)) {
      const r = await this.prepare({ ...req, seed }, { allowSame: true });
      out.push(r.ok && r.data ? { ok: true, data: r.data.plan } : { ok: false, message: r.message });
    }
    return out;
  }

  async apply(req: ScriptRunRequest, apply: ScriptApply, opts: { strict?: boolean } = {}): Promise<ActionResult<ScriptApplyOutcome>> {
    const prep = await this.prepare(req, { strict: opts.strict });
    if (!prep.ok || !prep.data) return { ok: false, message: prep.message };
    let r: { ids: string[]; count: number; removed: number; seed: number; name: string; range: { fromBar: number; bars: number }; keyName: string; extendedTo: number | null };
    try {
      r = apply('notes.applyScript', prep.data.args);
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? String(e) };
    }
    const plan = prep.data.plan;
    return {
      ok: true,
      message: `${r.name}: ${r.count} note${r.count === 1 ? '' : 's'} in ${where(r)}${r.removed ? `, replacing ${r.removed}` : ''} · ${r.keyName} · seed ${r.seed}${plan.logs.length ? ` · ${plan.logs.length} log line${plan.logs.length === 1 ? '' : 's'}` : ''}`,
      data: { ids: r.ids, count: r.count, removed: r.removed, seed: r.seed, name: r.name, range: r.range, keyName: r.keyName },
    };
  }

  async saveToLibrary(code: string, name?: string): Promise<ActionResult<{ id: string; name: string; path: string; created: boolean }>> {
    const h = parseScriptHeader(code);
    if (!h.ok) return { ok: false, message: `The script has errors:\n${formatIssues(h.issues)}` };
    let text = code;
    const finalName = (name?.trim() || h.header.name).slice(0, SCRIPT_LIMITS.nameChars);
    if (finalName !== h.header.name) text = code.replace(/^(\s*\/\/\s*@name\s+).*$/m, `$1${finalName}`);
    const slug = slugify(finalName);
    const file = this.fileFor(slug);
    const before = await readText(file);
    if (before === text) return { ok: false, message: `No change: "${finalName}" is already in your library with this code` };
    if (before === null && (await listFilesWithExt(this.libraryDir, '.js')).length >= MAX_LIBRARY) return { ok: false, message: `Your script library is full (${MAX_LIBRARY} scripts); remove one first` };
    try {
      await writeFileAtomic(file, text);
    } catch (e) {
      return { ok: false, message: `Couldn't save "${finalName}": ${describeFsError(e, file)}` };
    }
    return { ok: true, message: `${before === null ? 'Saved' : 'Updated'} "${finalName}" in your script library`, data: { id: `user:${slug}`, name: finalName, path: file, created: before === null } };
  }

  async removeFromLibrary(id: string): Promise<ActionResult> {
    const slug = String(id ?? '').startsWith('user:') ? String(id).slice(5).toLowerCase() : '';
    if (!SLUG.test(slug)) return { ok: false, message: 'Only scripts in your library can be removed here' };
    const file = this.fileFor(slug);
    const code = await readText(file);
    if (code === null) return { ok: false, message: 'That script is no longer in your library' };
    try {
      await removeFile(file);
    } catch (e) {
      return { ok: false, message: `Couldn't remove it: ${describeFsError(e, file)}` };
    }
    const h = parseScriptHeader(code);
    return { ok: true, message: `Removed "${h.ok ? h.header.name : slug}" from your script library` };
  }
}
