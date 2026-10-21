// Where the MCP server listens (electron/mcp/index.ts) and the stdio shim connects (engine/crates/mcp-shim):
// a named pipe on Windows, a Unix domain socket on macOS / Linux. Kept free of the MCP SDK so tests can load it.

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'client'
  );
}

/**
 * Windows: a named pipe. macOS / Linux: a Unix domain socket in a folder only this user can enter, so nobody
 * else can claim the path first and collect the token the shim sends: macOS's per-user temp dir, Linux's
 * $XDG_RUNTIME_DIR, else ~/.krypt-studio (never the shared /tmp). Short enough for the 104-byte sun_path limit.
 */
export function pipeNameFor(user = os.userInfo().username, suffix = process.env.KRYPT_MCP_PIPE_SUFFIX, platform: NodeJS.Platform = process.platform): string {
  const name = `krypt-studio-mcp-${slug(user) || 'user'}${suffix ? `-${slug(suffix)}` : ''}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  const dir = platform === 'darwin' ? os.tmpdir() : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.krypt-studio');
  return path.posix.join(dir.replace(/\\/g, '/'), `${name}.sock`);
}

/** Unix: create the socket's folder private to this user (a no-op for folders that already exist). */
export function prepareSocketDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

/** A Unix socket file left behind by a crashed app refuses connections: remove it so listen() can bind. */
export function clearStaleSocket(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT') return resolve(false);
      try {
        fs.rmSync(file, { force: true });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  });
}
