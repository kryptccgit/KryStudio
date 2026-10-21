// File access for agents: Settings ▸ Agents ▸ File access (settings.mcp.fileAccess).
//
//   tool call with a path ─▶ realUserPath(): UNC / device / ADS / relative /
//   non-audio / missing paths are REFUSED outright in every mode, never asked
//     ─▶ inside the Browser folders, a file the open project already uses, or
//        allowed earlier? carry on
//     ─▶ 'anywhere' (the default; local pipe clients + the built-in agent):
//        any other local file / folder is used without a prompt (logged)
//     ─▶ 'browser': refused with the reason (no prompts in this mode)
//     ─▶ 'ask' (and the HTTP endpoint, which is capped at 'ask'): ASK the
//        user, one prompt at a time:
//          • in the agent's own client when it declared MCP elicitation
//            (form mode: an enum, see consentSchema), or
//          • in Krypt Studio: a native dialog parented to the main window
//            (main.ts injects it; this module never imports Electron).
//   "Allow this file" lasts until Krypt Studio quits. "Allow this folder"
//   adds the folder to the Browser folders (settings.browserRoots: persisted,
//   visible and removable in the Browser panel). Identical requests made at
//   the same time share one prompt; no answer within 120 s is a clear error.
//   Every answer is logged and shown in the agent activity feed.

import crypto from 'node:crypto';
import path from 'node:path';
import type { AgentActivity, Settings } from '@shared/types';
import { MCP_CHANNELS, type MainDeps } from './types';
import type { ToolCaller } from './tools/types';
import { fail } from './tools/types';
import { accessAllows, isDriveRoot, pathAccess, realUserPath, safeName, unquotePath, type PathGrants, type UserPathKind } from './tools/util';

export type ConsentChoice = 'file' | 'folder' | 'deny';
/** 'allowed': nothing to ask (another prompt already covered it); 'unavailable': nobody could be asked. */
export type ConsentOutcome = ConsentChoice | 'timeout' | 'unavailable' | 'allowed';

/** An outcome and where the question was answered ("Claude Code", "Krypt Studio"). */
export interface ConsentResult {
  outcome: ConsentOutcome;
  where: string;
}

export interface ConsentRequest {
  /** Canonical absolute path (realpath). */
  path: string;
  isDir: boolean;
  /** The client's display name, e.g. "Claude Code". */
  client: string;
  clientId: string;
  tool: string;
}

/** Puts the question to the user somewhere and resolves with the answer (null = it couldn't ask). */
export interface ConsentAsker {
  /** Where the question appears, for messages: "Claude Code", "Krypt Studio". */
  where: string;
  ask(req: ConsentRequest, signal: AbortSignal): Promise<ConsentChoice | null>;
}

/**
 * Thrown by an asker that hands the question to the client instead of waiting for it (MCP 2026-07-28
 * multi-round-trip `input_required`): the tool call returns, and the client retries it with the answer.
 */
export class ConsentPending extends Error {
  constructor(
    readonly request: ConsentRequest,
    readonly key: string,
  ) {
    super(`Waiting for the user's answer about ${request.path}`);
    this.name = 'ConsentPending';
  }
}

export const CONSENT_TIMEOUT_MS = 120_000;

const PURPOSE: Record<string, string> = {
  import_audio: 'to put it on the Playlist',
  load_sample: 'as a sample',
  add_channel: 'as a sample',
  analyze_audio: 'to analyse it',
  audio_to_pattern: 'to transcribe it into notes',
  compare_to_reference: 'to compare your mix with it',
  library_import: 'for your reference library',
  set_cover: "as the song's cover art",
};

const pathKey = (p: string): string => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');

/** The folder "Allow this folder" would add, or null for a drive root (never offered: that would be a whole drive). */
export function grantFolder(req: Pick<ConsentRequest, 'path' | 'isDir'>): string | null {
  const dir = path.resolve(req.isDir ? req.path : path.dirname(req.path));
  return dir.toLowerCase() === path.parse(dir).root.toLowerCase() ? null : dir;
}

/** The words of the question, shared by the dialog and the elicitation form. */
export function consentText(req: ConsentRequest): { title: string; message: string; detail: string; name: string; folder: string; choices: Array<{ value: ConsentChoice; label: string; hint: string }> } {
  const name = safeName(path.basename(req.path) || req.path, 120);
  const folder = req.isDir ? req.path : path.dirname(req.path);
  const add = grantFolder(req);
  const purpose = PURPOSE[req.tool] ? ` ${PURPOSE[req.tool]}` : '';
  const client = safeName(req.client, 48) || 'An AI agent';
  const choices: Array<{ value: ConsentChoice; label: string; hint: string }> = [
    req.isDir
      ? { value: 'file', label: 'Allow once', hint: 'this folder, until Krypt Studio closes' }
      : { value: 'file', label: 'Allow this file', hint: 'only this file, until Krypt Studio closes' },
  ];
  if (add) choices.push({ value: 'folder', label: req.isDir ? 'Add to Browser folders' : 'Allow this folder', hint: `adds ${add} to your Browser folders (remove it there any time)` });
  choices.push({ value: 'deny', label: 'Deny', hint: `${client} is told you declined` });
  const message = req.isDir ? `${client} wants to read the folder "${name}"${purpose}` : `${client} wants to use "${name}"${purpose}`;
  const detail = [`${req.isDir ? 'Folder' : 'From'}: ${safeName(folder, 260)}`, '', ...choices.map((c) => `${c.label}: ${c.hint}.`), '', 'File access is set to "Ask me" (Settings ▸ Agents): agents read only the files you allow, the factory kit, your Browser folders and this project\'s own files.'].join('\n');
  return { title: 'File access', message, detail, name, folder, choices };
}

/** The form-mode elicitation for a request: one enum field `access`. */
export function consentElicitation(req: ConsentRequest): { mode: 'form'; message: string; requestedSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] } } {
  const t = consentText(req);
  return {
    mode: 'form',
    message: `Krypt Studio: ${t.message}, from ${safeName(t.folder, 260)}. Agents read only the files you allow, the factory kit, your Browser folders and this project's own files.`,
    requestedSchema: {
      type: 'object',
      properties: {
        access: {
          type: 'string',
          title: req.isDir ? 'Allow this folder?' : 'Allow this file?',
          description: t.choices.map((c) => `${c.label}: ${c.hint}`).join('. '),
          oneOf: t.choices.map((c) => ({ const: c.value, title: c.label })),
        },
      },
      required: ['access'],
    },
  };
}

/** Reads the `access` choice out of an elicitation result (decline / cancel / anything odd = deny). */
export function choiceFromElicitResult(r: unknown): ConsentChoice {
  const o = (r ?? {}) as { action?: unknown; content?: { access?: unknown } };
  if (o.action !== 'accept') return 'deny';
  const v = o.content?.access;
  return v === 'file' || v === 'folder' ? v : 'deny';
}

/** Stable per path: the multi-round-trip retry carries the answer under this key. */
export function consentKey(req: Pick<ConsentRequest, 'path' | 'isDir'>): string {
  return `krypt-file-access-${crypto.createHash('sha256').update(`${req.isDir ? 'd' : 'f'}:${pathKey(req.path)}`).digest('hex').slice(0, 16)}`;
}

export interface PathConsentDeps {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** The agent activity feed (mcp:activity). */
  broadcast?(channel: string, payload: unknown): void;
  /** Krypt Studio's own prompt (main.ts: a native dialog), used when the client can't ask. */
  dialog?: ConsentAsker;
  timeoutMs?: number;
}

export class PathConsent implements PathGrants {
  private readonly files = new Set<string>();
  private readonly folders = new Set<string>();
  private readonly inflight = new Map<string, Promise<ConsentResult>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PathConsentDeps) {}

  get timeoutMs(): number {
    return this.deps.timeoutMs ?? CONSENT_TIMEOUT_MS;
  }

  /** Allowed for this app session ("Allow this file" / "Allow once"). */
  granted(real: string, isDir: boolean): boolean {
    const k = pathKey(real);
    if (!isDir && this.files.has(k)) return true;
    for (const f of this.folders) if (k === f || k.startsWith(`${f}\\`) || k.startsWith(`${f}/`)) return true;
    return false;
  }

  /** What this session allowed, newest last (files and folders). */
  sessionGrants(): string[] {
    return [...this.files, ...this.folders];
  }

  /**
   * Ask about one path: identical requests made while one is open share it, different ones wait their turn.
   * `covered` re-checks the Browser folders right before asking (an earlier answer may have added the folder).
   */
  request(req: ConsentRequest, asker?: ConsentAsker, covered?: () => boolean): Promise<ConsentResult> {
    const k = `${req.isDir ? 'd' : 'f'}:${pathKey(req.path)}`;
    const open = this.inflight.get(k);
    if (open) return open;
    const run = this.queue.then(() => this.ask(req, asker, covered));
    this.queue = run.catch(() => undefined);
    this.inflight.set(k, run);
    const done = () => {
      if (this.inflight.get(k) === run) this.inflight.delete(k);
    };
    run.then(done, done);
    return run;
  }

  private async ask(req: ConsentRequest, asker: ConsentAsker | undefined, covered: (() => boolean) | undefined): Promise<ConsentResult> {
    if (covered?.() || this.granted(req.path, req.isDir)) return { outcome: 'allowed', where: '' };
    const first = asker ?? this.deps.dialog;
    if (!first) return { outcome: 'unavailable', where: '' };
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve('timeout');
      }, this.timeoutMs);
    });
    let where = first.where;
    try {
      let choice: ConsentChoice | 'timeout' | null;
      try {
        choice = await Promise.race([first.ask(req, ac.signal), expired]);
      } catch (e) {
        if (e instanceof ConsentPending) throw e;
        choice = ac.signal.aborted ? 'timeout' : null;
        if (choice === null) this.deps.log('warn', `File access: couldn't ask in ${first.where}: ${(e as Error)?.message ?? e}`);
      }
      // The client couldn't ask (its elicitation failed): ask in Krypt Studio instead.
      if (choice === null && this.deps.dialog && first !== this.deps.dialog) {
        where = this.deps.dialog.where;
        choice = await Promise.race([this.deps.dialog.ask(req, ac.signal).catch(() => null), expired]);
      }
      return { outcome: this.record(req, choice ?? 'unavailable', where), where };
    } finally {
      clearTimeout(timer);
    }
  }

  private record(req: ConsentRequest, outcome: ConsentChoice | 'timeout' | 'unavailable', where: string): ConsentOutcome {
    const name = safeName(path.basename(req.path) || req.path, 80);
    let summary: string;
    let ok = true;
    if (outcome === 'file') {
      if (req.isDir) this.folders.add(pathKey(req.path));
      else this.files.add(pathKey(req.path));
      summary = `Allowed ${req.isDir ? 'the folder ' : ''}"${name}" until Krypt Studio closes`;
    } else if (outcome === 'folder') {
      const dir = grantFolder(req);
      if (!dir) return this.record(req, 'file', where);
      const added = this.addRoot(dir);
      summary = added ? `Allowed the folder ${safeName(dir, 200)}: added to the Browser folders` : `Allowed the folder ${safeName(dir, 200)} (already in the Browser folders)`;
    } else if (outcome === 'deny') {
      ok = false;
      summary = `Declined access to "${name}"`;
    } else if (outcome === 'timeout') {
      ok = false;
      summary = `No answer about "${name}" within ${Math.round(this.timeoutMs / 1000)} s`;
    } else {
      this.deps.log('warn', `[agent] ${req.client} asked to read ${req.path} (${req.tool}), but nobody could be asked`);
      return 'unavailable';
    }
    const line = `${summary} (${req.tool}, asked in ${where})`;
    this.deps.log(ok ? 'info' : 'warn', `[agent] ${req.client} asked to read ${req.path}: ${line}`);
    const activity: AgentActivity = { clientId: req.clientId, clientName: req.client, tool: 'file access', summary: line.slice(0, 300), ok, time: Date.now() };
    try {
      this.deps.broadcast?.(MCP_CHANNELS.activity, activity);
    } catch {
      /* the activity feed is best-effort */
    }
    return outcome;
  }

  /** Add a folder to the Browser folders unless one already covers it. True when added. */
  private addRoot(dir: string): boolean {
    const s = this.deps.getSettings();
    const k = pathKey(dir);
    const covered = s.browserRoots.some((r) => {
      const rk = pathKey(r.path);
      return k === rk || k.startsWith(`${rk}\\`) || k.startsWith(`${rk}/`);
    });
    if (covered) return false;
    const root = { id: `root_${crypto.randomUUID().slice(0, 8)}`, name: path.basename(dir) || dir, path: dir };
    this.deps.updateSettings({ browserRoots: [...s.browserRoots, root] });
    return true;
  }
}

// ── The helper every path-taking tool goes through ─────────────────────

/**
 * Make sure the agent may read `input` before the tool runs, under the File access setting: paths the policy
 * covers pass (Browser folders, the project's own files, session grants, or anything local in 'anywhere'); in
 * 'ask' mode a local file / folder outside them is put to the user; unsafe paths are refused in every mode.
 * `factory:` and `pack:` paths pass (the tool checks them). In 'browser' mode the tool itself refuses with the reason.
 */
export async function ensurePathAccess(deps: MainDeps, caller: ToolCaller, tool: string, input: string, kind: UserPathKind, asker?: ConsentAsker): Promise<void> {
  const raw = unquotePath(input);
  if ((raw.startsWith('factory:') || raw.startsWith('pack:')) && kind !== 'image' && kind !== 'midi') return;
  const { real, isDir } = realUserPath(raw, kind);
  const acc = pathAccess(deps, caller);
  if (accessAllows(acc, real, isDir)) {
    if (acc.mode === 'anywhere' && !accessAllows({ ...acc, mode: 'browser' }, real, isDir)) {
      deps.log('info', `[agent] ${caller.actor.name} ${tool} reads ${real} (File access: anywhere)`);
    }
    return;
  }
  if (isDir && isDriveRoot(real)) fail(`For safety, agents can't read a whole drive (${safeName(real, 20)}). Ask the user for the folder that holds the songs.`);
  if (acc.mode !== 'ask') return; // 'browser': no prompts; the tool refuses with the reason
  const covered = () => accessAllows(pathAccess(deps, caller), real, isDir);
  if (!deps.consent) return; // no consent service (tests, tools-only hosts): the tool refuses with the allow-list message
  const req: ConsentRequest = { path: real, isDir, client: caller.actor.name, clientId: caller.actor.clientId, tool };
  const { outcome, where } = await deps.consent.request(req, asker, covered);
  const name = safeName(path.basename(real) || real, 120);
  switch (outcome) {
    case 'file':
    case 'folder':
    case 'allowed':
    case 'unavailable':
      return;
    case 'deny':
      fail(`The user declined access to "${name}" (${safeName(isDir ? real : path.dirname(real), 200)}). Don't ask for it again; ask the user to add its folder in the Browser panel or to choose another file.`);
    case 'timeout':
      fail(`The user didn't answer in ${where} within ${Math.round(deps.consent.timeoutMs / 1000)} s, so "${name}" wasn't opened. Ask them in the chat, then try again.`);
  }
}
