// Connection snippets and installers for MCP clients (research/04 §2.4).
// Every client launches the stdio shim (krypt-studio-mcp.exe), which relays
// to the running app's named pipe. Installers merge ONLY our entry into the
// client's JSON config, write atomically, and keep a .bak of the original.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ActionResult, ClientConfigSnippet } from '@shared/types';

export const SERVER_KEY = 'krypt-studio';
const PLACEHOLDER =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Krypt Studio\\resources\\resources\\bin\\krypt-studio-mcp.exe'
    : process.platform === 'darwin'
      ? '/Applications/Krypt Studio.app/Contents/Resources/resources/bin/krypt-studio-mcp'
      : '/opt/Krypt Studio/resources/resources/bin/krypt-studio-mcp';

interface JsonTarget {
  client: string;
  label: string;
  /** Config files to write (first = primary). */
  files: () => string[];
  /** Folder that must exist for the client to count as installed. */
  detect: () => string;
  /** Top-level key holding servers. */
  key: 'mcpServers' | 'servers';
  entry: (shim: string) => Record<string, unknown>;
}

/** Where desktop apps keep per-user config: Electron's app.getPath('appData') on each OS. */
const appData = (): string =>
  process.platform === 'win32'
    ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const localAppData = () => process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const CLAUDE_DESKTOP_CONFIG =
  process.platform === 'win32'
    ? '%APPDATA%\\Claude\\claude_desktop_config.json'
    : process.platform === 'darwin'
      ? '~/Library/Application Support/Claude/claude_desktop_config.json'
      : '~/.config/Claude/claude_desktop_config.json';

function claudeDesktopFiles(): string[] {
  const out = [path.join(appData(), 'Claude', 'claude_desktop_config.json')];
  if (process.platform !== 'win32') return out;
  // The MSIX build reads a virtualised copy (anthropics/claude-code#26073).
  const pkgs = path.join(localAppData(), 'Packages');
  try {
    for (const d of fs.readdirSync(pkgs)) {
      if (/^Claude_/i.test(d)) {
        const dir = path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude');
        if (fs.existsSync(dir)) out.push(path.join(dir, 'claude_desktop_config.json'));
      }
    }
  } catch {
    /* no MSIX install */
  }
  return out;
}

const TARGETS: JsonTarget[] = [
  {
    client: 'claude-desktop',
    label: 'Claude Desktop',
    files: claudeDesktopFiles,
    detect: () => path.join(appData(), 'Claude'),
    key: 'mcpServers',
    entry: (shim) => ({ command: shim, args: ['--client', 'claude-desktop'] }),
  },
  {
    client: 'cursor',
    label: 'Cursor',
    files: () => [path.join(os.homedir(), '.cursor', 'mcp.json')],
    detect: () => path.join(os.homedir(), '.cursor'),
    key: 'mcpServers',
    entry: (shim) => ({ type: 'stdio', command: shim, args: ['--client', 'cursor'] }),
  },
  {
    client: 'vscode',
    label: 'VS Code',
    files: () => [path.join(appData(), 'Code', 'User', 'mcp.json')],
    detect: () => path.join(appData(), 'Code', 'User'),
    key: 'servers',
    entry: (shim) => ({ type: 'stdio', command: shim, args: ['--client', 'vscode'] }),
  },
];

function quoteArg(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function claudeCodeCommand(shim: string): string {
  return `claude mcp add --scope user ${SERVER_KEY} -- ${quoteArg(shim)} --client claude-code`;
}

export function clientConfigs(shimExePath: string | null): ClientConfigSnippet[] {
  const shim = shimExePath ?? PLACEHOLDER;
  const missing = shimExePath ? '' : ' (The shim is not built in this dev checkout yet: run `npm run engine:build`; the path below is a placeholder.)';
  const json = (t: JsonTarget) => JSON.stringify({ [t.key]: { [SERVER_KEY]: t.entry(shim) } }, null, 2);
  return [
    {
      client: 'claude-code',
      description: `Claude Code: run this once in a terminal (user scope, all projects). Then ask Claude to "use krypt-studio". Connecting from here also lets Claude Code use Krypt Studio without asking before each step (adds "${CLAUDE_CODE_ALLOW_RULE}" to permissions.allow in ~/.claude/settings.json).${missing}`,
      snippet: claudeCodeCommand(shim),
      installable: !!shimExePath,
    },
    {
      client: 'claude-desktop',
      description: `Claude Desktop: adds "${SERVER_KEY}" to mcpServers in ${CLAUDE_DESKTOP_CONFIG}${process.platform === 'win32' ? ' (and the MSIX copy if present)' : ''}. Fully quit and restart Claude Desktop afterwards.${missing}`,
      snippet: json(TARGETS[0]),
      installable: !!shimExePath,
    },
    {
      client: 'cursor',
      description: `Cursor: adds "${SERVER_KEY}" to ~/.cursor/mcp.json (Settings → MCP shows it).${missing}`,
      snippet: json(TARGETS[1]),
      installable: !!shimExePath,
    },
    {
      client: 'vscode',
      description: `VS Code (Copilot agent mode): adds "${SERVER_KEY}" to your user mcp.json ("MCP: Open User Configuration").${missing}`,
      snippet: json(TARGETS[2]),
      installable: !!shimExePath,
    },
  ];
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** Merge our server entry into one JSON config file. Never clobbers other servers. */
export function mergeJsonConfig(file: string, key: 'mcpServers' | 'servers', entry: Record<string, unknown>): { changed: boolean; backup: string | null } {
  let data: Record<string, unknown> = {};
  let original: string | null = null;
  if (fs.existsSync(file)) {
    original = fs.readFileSync(file, 'utf8');
    if (original.trim()) {
      try {
        const parsed = JSON.parse(original.replace(/^\uFEFF/, ''));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
        data = parsed as Record<string, unknown>;
      } catch (e) {
        throw new Error(`${file} isn't plain JSON (${(e as Error).message}); not touching it. Add the snippet by hand.`);
      }
    }
  }
  const servers = (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]) ? (data[key] as Record<string, unknown>) : {}) as Record<string, unknown>;
  if (JSON.stringify(servers[SERVER_KEY]) === JSON.stringify(entry)) return { changed: false, backup: null };
  const next = { ...data, [key]: { ...servers, [SERVER_KEY]: entry } };
  let backup: string | null = null;
  if (original !== null) {
    backup = `${file}.bak`;
    fs.writeFileSync(backup, original, 'utf8');
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, backup };
}

/** Claude Code's permission rule that matches every tool of our server. */
export const CLAUDE_CODE_ALLOW_RULE = `mcp__${SERVER_KEY}`;

/** Claude Code's user settings file (CLAUDE_CONFIG_DIR moves it). */
export function claudeCodeSettingsFile(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

/**
 * Lets Claude Code use every Krypt Studio tool without a permission prompt per
 * call: adds `mcp__krypt-studio` to `permissions.allow` in the user settings.
 * Safe to auto-approve because every edit is undoable per agent
 * (revert_all_agent_edits), exports never overwrite, and file access follows
 * the app's own File access setting. Merges only that one rule, keeps a .bak,
 * writes atomically; refuses a file that isn't plain JSON.
 */
export function allowClaudeCodeTools(file = claudeCodeSettingsFile()): { changed: boolean; backup: string | null } {
  let data: Record<string, unknown> = {};
  let original: string | null = null;
  if (fs.existsSync(file)) {
    original = fs.readFileSync(file, 'utf8');
    if (original.trim()) {
      try {
        const parsed = JSON.parse(original.replace(/^﻿/, ''));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
        data = parsed as Record<string, unknown>;
      } catch (e) {
        throw new Error(`${file} isn't plain JSON (${(e as Error).message}); not touching it. Add "${CLAUDE_CODE_ALLOW_RULE}" to permissions.allow by hand.`);
      }
    }
  }
  const perms = data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions) ? (data.permissions as Record<string, unknown>) : {};
  const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
  if (allow.includes(CLAUDE_CODE_ALLOW_RULE) || allow.includes(`${CLAUDE_CODE_ALLOW_RULE}__*`)) return { changed: false, backup: null };
  const next = { ...data, permissions: { ...perms, allow: [...allow, CLAUDE_CODE_ALLOW_RULE] } };
  let backup: string | null = null;
  if (original !== null) {
    backup = `${file}.bak`;
    fs.writeFileSync(backup, original, 'utf8');
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, backup };
}

function runClaudeCli(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: 30_000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err ? (err as Error).message : '') });
    });
  });
}

export async function installClientConfig(client: string, shimExePath: string | null): Promise<ActionResult> {
  if (!shimExePath) return { ok: false, message: 'The MCP shim (krypt-studio-mcp.exe) is not built in this checkout, so there is nothing to point clients at yet. Run `npm run engine:build`.' };
  if (client === 'claude-code') {
    const args = ['mcp', 'add', '--scope', 'user', SERVER_KEY, '--', shimExePath, '--client', 'claude-code'];
    let r = await runClaudeCli(args);
    if (!r.ok && /already exists/i.test(r.out)) {
      await runClaudeCli(['mcp', 'remove', '--scope', 'user', SERVER_KEY]);
      r = await runClaudeCli(args);
    }
    if (!r.ok) {
      const notFound = /not recognized|ENOENT|not found/i.test(r.out);
      return { ok: false, message: notFound ? `The Claude Code CLI ("claude") isn't on PATH. Run this in a terminal instead: ${claudeCodeCommand(shimExePath)}` : `claude mcp add failed: ${r.out.slice(0, 300)}` };
    }
    let allowNote: string;
    try {
      allowNote = allowClaudeCodeTools().changed ? ' It can use Krypt Studio without asking before each step (everything it does stays undoable).' : '';
    } catch (e) {
      allowNote = ` Claude Code will still ask before each Krypt Studio step: ${(e as Error).message}`;
    }
    return { ok: true, message: `Added krypt-studio to Claude Code (user scope).${allowNote} Start a new Claude Code session to use it.` };
  }
  const t = TARGETS.find((x) => x.client === client);
  if (!t) return { ok: false, message: `Unknown client "${client}". Use claude-code, claude-desktop, cursor or vscode.` };
  if (!fs.existsSync(t.detect())) return { ok: false, message: `${t.label} doesn't seem to be installed (no ${t.detect()}). Install it first, or copy the snippet by hand.` };
  const done: string[] = [];
  try {
    for (const file of t.files()) {
      const r = mergeJsonConfig(file, t.key, t.entry(shimExePath));
      done.push(r.changed ? `${file}${r.backup ? ` (backup: ${path.basename(r.backup)})` : ''}` : `${file} (already set)`);
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const restart = client === 'claude-desktop' ? ' Fully quit Claude Desktop (tray icon → Quit) and reopen it.' : ' Reload the window to pick it up.';
  return { ok: true, message: `Connected ${t.label}: ${done.join('; ')}.${restart}` };
}
