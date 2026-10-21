import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';

export type Result<T = unknown> = { ok: boolean; message: string; data?: T };
export type EngineEvent = { event: string; [k: string]: unknown };

type Pending = { resolve: (r: Result) => void; timer: NodeJS.Timeout };

export class EngineSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private crashTimes: number[] = [];
  private stopping = false;
  private resolveExe: () => string;
  private onEvent: (ev: EngineEvent) => void;
  private log: (line: string) => void;

  constructor(
    resolveExe: () => string,
    onEvent: (ev: EngineEvent) => void,
    log: (line: string) => void = () => {},
  ) {
    this.resolveExe = resolveExe;
    this.onEvent = onEvent;
    this.log = log;
  }

  start(): Result {
    if (this.child) return { ok: true, message: 'Engine already running' };
    let exe: string;
    try {
      exe = this.resolveExe();
    } catch (e) {
      return { ok: false, message: `Engine path error: ${(e as Error).message}` };
    }
    if (!fs.existsSync(exe)) return { ok: false, message: `Engine binary missing: ${exe}` };
    this.stopping = false;
    const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (l) => this.onLine(l));
    createInterface({ input: child.stderr }).on('line', (l) => this.log(`[engine] ${l}`));
    child.on('error', (e) => this.log(`[engine] spawn error: ${e.message}`));
    child.on('exit', (code, signal) => this.onExit(code, signal));
    return { ok: true, message: 'Engine started' };
  }

  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 2000): Promise<Result> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.resolve({ ok: false, message: 'Audio engine is not running' });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, message: `Engine timed out on "${cmd}"` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    await this.request('shutdown', {}, 1000);
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 1500);
    await exited;
    clearTimeout(killTimer);
  }

  private onLine(line: string): void {
    let msg: { id?: number | null; ok?: boolean; message?: string; event?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`[engine] bad line: ${line}`);
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve({ ok: !!msg.ok, message: msg.message ?? (msg.ok ? 'OK' : 'Engine error'), data: msg });
    } else if (msg.event) {
      this.onEvent(msg as EngineEvent);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, message: 'Audio engine exited' });
    }
    this.pending.clear();
    if (this.stopping) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < 60_000).concat(now);
    this.onEvent({ event: 'crashed', code, signal, count: this.crashTimes.length });
    if (this.crashTimes.length > 3) {
      this.onEvent({ event: 'gaveUp', message: 'Audio engine crashed 4 times in 60 s' });
      return;
    }
    const delay = 250 * 2 ** (this.crashTimes.length - 1);
    setTimeout(() => {
      const r = this.start();
      this.onEvent({ event: r.ok ? 'restarted' : 'restartFailed', message: r.message });
    }, delay);
  }
}
