import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CLIENT_INFO_META_KEY, type JSONRPCMessage } from '@modelcontextprotocol/server';
import type { ActionResult, McpClientInfo, McpStatus } from '@shared/types';
import { MCP_CHANNELS, type MainDeps, type McpController } from './types';
import { PipeTransport } from './transport';
import { buildServer, captureManifest } from './server';
import { clientConfigs, installClientConfig } from './clients';
import { newSession, type AgentActor, type EditSession, type ToolCaller } from './tools';
import { startHttp, type HttpHandle } from './http';
import { clearStaleSocket, pipeNameFor, prepareSocketDir, slug } from './endpoint';

export { pipeNameFor } from './endpoint';

const HELLO_TIMEOUT_MS = 10_000;
const MAX_HELLO = 64 * 1024;
export const TOKEN_META_KEY = 'cc.krypt/token';

const KNOWN_CLIENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop',
  'claude-desktop': 'Claude Desktop',
  'cursor-vscode': 'Cursor',
  cursor: 'Cursor',
  'visual-studio-code': 'VS Code',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  goose: 'Goose',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  'lm-studio': 'LM Studio',
};

function prettyName(raw: string): string {
  const s = slug(raw);
  return KNOWN_CLIENTS[s] ?? raw.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 48);
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

interface Conn {
  id: number;
  socket: net.Socket;
  hint: string | null;
  rawName: string | null;
  name: string;
  actor: AgentActor | null;
  session: EditSession;
  connectedAt: number;
  calls: number;
  authed: boolean;
  close: (() => Promise<void>) | null;
  pendingConsent: Map<string, number>;
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string; name?: string };
    if (pkg.name === 'krypt-studio' && pkg.version) return pkg.version;
  } catch {
  }
  return process.env.npm_package_version ?? '0.1.0';
}

export function startMcp(deps: MainDeps): McpController {
  const version = appVersion();
  const pipe = pipeNameFor();
  const token = crypto.randomBytes(32).toString('hex');
  const conns = new Map<number, Conn>();
  let nextId = 1;
  let enabled = deps.getSettings().mcp.enabled !== false;
  let listening = false;
  let listenError: string | null = null;
  let http: HttpHandle | null = null;

  const gate = (): string | null =>
    enabled ? null : 'Krypt Studio has AI agent access turned off (the user flipped the kill switch in Settings → Agents). Ask them to turn it back on, then retry.';

  const cfgFile = path.join(deps.userDataDir, 'mcp.json');
  const manifestFile = path.join(deps.userDataDir, 'mcp-manifest.json');
  const appArgs = process.defaultApp && process.argv[1] ? [path.resolve(process.argv[1])] : [];
  try {
    fs.mkdirSync(deps.userDataDir, { recursive: true });
    writeAtomic(
      cfgFile,
      `${JSON.stringify({ pipe, token, appExePath: deps.appExePath, appArgs, shimExePath: deps.shimExePath, version, pid: process.pid, writtenAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (e) {
    deps.log('error', `MCP: couldn't write ${cfgFile}: ${(e as Error).message}`);
  }
  void captureManifest(deps, version)
    .then((m) => writeAtomic(manifestFile, `${JSON.stringify(m, null, 1)}\n`))
    .catch((e) => deps.log('warn', `MCP: couldn't write the offline manifest: ${(e as Error).message}`));

  const status = (): McpStatus => ({
    enabled,
    pipeName: listening ? pipe : null,
    http: http ? { enabled: true, url: http.url } : { enabled: false, url: null },
    clients: [...conns.values()]
      .filter((c) => c.authed)
      .map<McpClientInfo>((c) => ({ clientId: c.actor?.clientId ?? `pending-${c.id}`, name: c.name, connectedAt: c.connectedAt, calls: c.calls })),
    shimPath: deps.shimExePath,
  });
  const broadcastStatus = () => {
    try {
      deps.broadcast(MCP_CHANNELS.status, status());
    } catch {
    }
  };

  const resolveActor = (c: Conn): AgentActor => {
    if (c.actor) return c.actor;
    const raw = c.rawName ?? c.hint ?? 'mcp-client';
    const base = slug(raw);
    const taken = new Set([...conns.values()].filter((o) => o !== c && o.actor).map((o) => o.actor!.clientId));
    let clientId = base;
    for (let i = 2; taken.has(clientId); i++) clientId = `${base}-${i}`;
    c.name = prettyName(raw);
    c.actor = { kind: 'agent', clientId, name: c.name };
    return c.actor;
  };
  const observe = (c: Conn, m: JSONRPCMessage) => {
    if (c.rawName) return;
    const msg = m as { method?: string; params?: Record<string, unknown> };
    if (!msg.method) return;
    const info =
      msg.method === 'initialize'
        ? (msg.params?.clientInfo as { name?: string } | undefined)
        : ((msg.params?._meta as Record<string, unknown> | undefined)?.[CLIENT_INFO_META_KEY] as { name?: string } | undefined);
    if (info && typeof info.name === 'string' && info.name.trim()) {
      c.rawName = info.name.trim();
      if (!c.actor) resolveActor(c);
      broadcastStatus();
    }
  };
  const callerFor = (c: Conn): ToolCaller => ({ actor: resolveActor(c), session: c.session, via: 'mcp' });

  const endSession = (c: Conn) => {
    if (c.session.group) {
      deps.doc.endGroup(c.session.group.id);
      c.session.group = null;
    }
  };

  const serveConnection = (c: Conn, initial: Buffer) => {
    c.authed = true;
    const transport = new PipeTransport(c.socket, initial, (m) => observe(c, m));
    const handle = serveStdio(() => buildServer(deps, version, { caller: () => callerFor(c), gate, counted: () => c.calls++, client: () => c.rawName ?? c.hint, pendingConsent: c.pendingConsent }), {
      transport,
      onerror: (e) => deps.log('warn', `MCP (${c.name}): ${e.message}`),
    });
    c.close = () => handle.close();
    broadcastStatus();
  };

  const onSocket = (socket: net.Socket) => {
    const c: Conn = { id: nextId++, socket, hint: null, rawName: null, name: 'MCP client', actor: null, session: newSession(), connectedAt: Date.now(), calls: 0, authed: false, close: null, pendingConsent: new Map() };
    conns.set(c.id, c);
    let buf = Buffer.alloc(0);
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) socket.destroy();
    }, HELLO_TIMEOUT_MS);
    const deny = (line: string) => {
      clearTimeout(timer);
      socket.end(`${line}\n`);
      setTimeout(() => socket.destroy(), 200).unref?.();
    };
    const onHello = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_HELLO) deny(JSON.stringify({ krypt: 'error', message: 'hello line too long' }));
        return;
      }
      socket.off('data', onHello);
      const first = buf.subarray(0, nl).toString('utf8').trim();
      const rest = buf.subarray(nl + 1);
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(first) as Record<string, unknown>;
      } catch {
        msg = null;
      }
      if (msg && msg.krypt === 'hello') {
        if (!tokenOk(msg.token, token)) {
          deps.log('warn', 'MCP: rejected a pipe connection with a bad token');
          return deny(JSON.stringify({ krypt: 'error', code: 'bad_token', message: 'Bad token: re-read mcp.json (Krypt Studio rewrites it at every start).' }));
        }
        authed = true;
        clearTimeout(timer);
        if (typeof msg.client === 'string' && msg.client.trim()) {
          c.hint = msg.client.trim().slice(0, 48);
          c.name = prettyName(c.hint);
        }
        socket.write(`${JSON.stringify({ krypt: 'welcome', v: 1, server: 'Krypt Studio', version, enabled })}\n`);
        return serveConnection(c, rest);
      }
      const meta = (msg?.params as Record<string, unknown> | undefined)?._meta as Record<string, unknown> | undefined;
      if (msg && msg.jsonrpc === '2.0' && tokenOk(meta?.[TOKEN_META_KEY], token)) {
        authed = true;
        clearTimeout(timer);
        return serveConnection(c, buf);
      }
      deps.log('warn', 'MCP: rejected an unauthenticated pipe connection');
      if (msg && msg.jsonrpc === '2.0' && msg.id !== undefined) {
        return deny(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Unauthorized: connect through krypt-studio-mcp.exe (it sends the token from mcp.json).' } }));
      }
      deny(JSON.stringify({ krypt: 'error', code: 'unauthorized', message: 'Send {"krypt":"hello","token":"…"} first.' }));
    };
    socket.on('data', onHello);
    socket.on('error', () => {
    });
    socket.on('close', () => {
      clearTimeout(timer);
      endSession(c);
      const was = conns.delete(c.id);
      if (was && authed) broadcastStatus();
    });
  };

  const server = net.createServer({ pauseOnConnect: false }, onSocket);
  let retriedStale = false;
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && process.platform !== 'win32' && !retriedStale) {
      retriedStale = true;
      void clearStaleSocket(pipe).then((cleared) => {
        if (cleared) {
          deps.log('info', `removed a stale MCP socket at ${pipe}`);
          server.listen(pipe);
        } else {
          server.emit('error', e);
        }
      });
      return;
    }
    listening = false;
    listenError = e.code === 'EADDRINUSE' ? `another Krypt Studio is already serving ${pipe}` : e.message;
    deps.log('error', `MCP pipe server: ${listenError}`);
    broadcastStatus();
  });
  if (process.platform !== 'win32') {
    try {
      prepareSocketDir(pipe);
    } catch (e) {
      deps.log('error', `MCP socket folder for ${pipe}: ${(e as Error).message}`);
    }
  }
  server.listen(pipe, () => {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(pipe, 0o600);
      } catch (e) {
        deps.log('warn', `MCP socket permissions: ${(e as Error).message}`);
      }
    }
    listening = true;
    listenError = null;
    deps.log('info', `MCP server listening on ${pipe}${enabled ? '' : ' (agents are turned off)'}`);
    broadcastStatus();
  });

  const s0 = deps.getSettings().mcp;
  if (s0.httpEnabled) {
    try {
      http = startHttp(deps, version, token, s0.httpPort, gate);
    } catch (e) {
      deps.log('warn', `MCP HTTP endpoint not started: ${(e as Error).message}`);
    }
  }

  const dropAll = async () => {
    const all = [...conns.values()];
    for (const c of all) {
      endSession(c);
      try {
        await c.close?.();
      } catch {
      }
      c.socket.destroy();
      conns.delete(c.id);
    }
  };

  return {
    status,
    clientConfigs: () => clientConfigs(deps.shimExePath),
    installClientConfig: (client: string) => installClientConfig(client, deps.shimExePath),
    async setEnabled(on: boolean): Promise<ActionResult> {
      enabled = on;
      if (!on) await dropAll();
      try {
        const s = deps.getSettings();
        if (s.mcp.enabled !== on) deps.updateSettings({ mcp: { ...s.mcp, enabled: on } });
      } catch (e) {
        deps.log('warn', `MCP: couldn't persist the agents setting: ${(e as Error).message}`);
      }
      broadcastStatus();
      deps.log('info', `MCP agents ${on ? 'enabled' : 'turned off (kill switch): all clients disconnected'}`);
      return {
        ok: true,
        message: on ? `AI agents can connect again${listening ? '' : ` — but the pipe isn't listening: ${listenError ?? 'unknown error'}`}.` : 'AI agents turned off: every client was disconnected and further calls are refused.',
      };
    },
    async stop(): Promise<void> {
      await dropAll();
      await new Promise<void>((r) => server.close(() => r()));
      listening = false;
      if (http) await http.close();
      http = null;
    },
  };
}
