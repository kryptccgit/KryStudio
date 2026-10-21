import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

export function spawnSidecar(exe: string, args: string[]): ChildProcessWithoutNullStreams {
  if (!path.isAbsolute(exe)) throw new Error(`Refusing to spawn a non-absolute path: ${exe}`);
  return spawn(exe, args, {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? '1' },
  });
}

export function killSidecar(child: ChildProcessWithoutNullStreams | null): void {
  try {
    if (child && child.exitCode === null && !child.killed) child.kill();
  } catch {
  }
}
