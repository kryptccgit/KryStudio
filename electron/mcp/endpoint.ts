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

export function pipeNameFor(user = os.userInfo().username, suffix = process.env.KRYPT_MCP_PIPE_SUFFIX, platform: NodeJS.Platform = process.platform): string {
  const name = `krypt-studio-mcp-${slug(user) || 'user'}${suffix ? `-${slug(suffix)}` : ''}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  const dir = platform === 'darwin' ? os.tmpdir() : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.krypt-studio');
  return path.posix.join(dir.replace(/\\/g, '/'), `${name}.sock`);
}

export function prepareSocketDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

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
