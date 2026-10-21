// Optional Streamable HTTP endpoint on 127.0.0.1 (settings.mcp.httpEnabled,
// OFF by default). research/04 §7.1 T1: bind loopback only, Host allow-list,
// reject ANY Origin header (real MCP clients don't send one), bearer token
// (constant-time), POST + application/json only, no CORS headers ever.

import http from 'node:http';
import crypto from 'node:crypto';
import { createMcpHandler, localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';
import { MAX_MCP_MESSAGE_BYTES, type MainDeps } from './types';
import { buildServer } from './server';
import { newSession, type ToolCaller } from './tools';

const MAX_BODY = MAX_MCP_MESSAGE_BYTES;

export interface HttpHandle {
  url: string;
  close(): Promise<void>;
}

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startHttp(deps: MainDeps, version: string, token: string, port: number, gate: () => string | null): HttpHandle {
  // HTTP is stateless per request: one actor per client name header (default "http").
  const callers = new Map<string, ToolCaller>();
  // File-access questions handed to a client as input_required, per client name (HTTP builds a server per request).
  const pending = new Map<string, Map<string, number>>();
  const pendingFor = (name: string | null): Map<string, number> => {
    const k = name ?? '';
    let m = pending.get(k);
    if (!m) pending.set(k, (m = new Map()));
    return m;
  };
  const callerFor = (name: string | null): ToolCaller => {
    const slugged = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const id = slugged ? `http-${slugged}` : 'http';
    let c = callers.get(id);
    if (!c) {
      c = { actor: { kind: 'agent', clientId: id, name: name ? `${name.slice(0, 40)} (HTTP)` : 'HTTP client' }, session: newSession(), via: 'http' };
      callers.set(id, c);
    }
    return c;
  };
  const handler = createMcpHandler(
    (ctx) => {
      const name = ctx.requestInfo?.headers.get('x-mcp-client-name') ?? null;
      return buildServer(deps, version, { caller: () => callerFor(name), gate, pendingConsent: pendingFor(name) });
    },
    { legacy: 'stateless', maxRequestBodySize: MAX_BODY, onerror: (e) => deps.log('warn', `MCP HTTP: ${e.message}`) },
  );
  const allowed = localhostAllowedHostnames();
  const deny = (res: http.ServerResponse, code: number, msg: string, extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...extra });
    res.end(msg);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const host = validateHostHeader(req.headers.host, allowed);
      if (!host.ok) return deny(res, 403, 'Forbidden host');
      if (req.headers.origin) return deny(res, 403, 'Browser origins are not allowed');
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      if (!m || !tokenOk(m[1], token)) return deny(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST') return deny(res, 405, 'Method not allowed', { allow: 'POST' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return deny(res, 415, 'Content-Type must be application/json');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return deny(res, 413, `Body too large (the limit is ${MAX_BODY / 1048576} MB)`);
        chunks.push(chunk as Buffer);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/mcp'}`, { method: 'POST', headers, body: Buffer.concat(chunks) });
      const response = await handler.fetch(request);
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (!k.startsWith('access-control-')) out[k] = v;
      });
      res.writeHead(response.status, out);
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (e) {
      deps.log('warn', `MCP HTTP request failed: ${(e as Error).message}`);
      if (!res.headersSent) deny(res, 500, 'Internal error');
      else res.end();
    }
  });
  server.on('error', (e) => deps.log('error', `MCP HTTP endpoint: ${e.message}`));
  server.listen(port, '127.0.0.1');
  deps.log('info', `MCP HTTP endpoint on http://127.0.0.1:${port}/mcp (bearer token in mcp.json)`);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await handler.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
