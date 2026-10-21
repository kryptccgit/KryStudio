// ──────────────────────────────────────────────────────────────────────
// AnalyzerSupervisor: owns the krypt-studio-analyzer.exe sidecar
// (docs/ANALYZER_PROTOCOL.md). Unlike the audio engine it is LAZY:
//
//   first job ─▶ spawn (absolute path, hidden, piped) ─▶ hello
//     ─▶ {id, cmd, args} jobs, any number concurrently; progress events
//        stream per id; exactly one response line per id
//   cancel(job)  ─▶ {cmd:'cancel', target}; the job answers cancelled. If it
//                   doesn't within the grace period the process is killed.
//   crash        ─▶ every in-flight job resolves ok:false with a clear
//                   message; the NEXT job restarts it (exponential backoff,
//                   5 crashes in a minute = refuse for a while)
//   idle 10 min  ─▶ graceful shutdown (frees model memory); next job respawns
//   stop()       ─▶ shutdown request, kill after 2 s
//
// Every call resolves (never throws). Node-only: no Electron imports, so
// test/analyzer-supervisor.test.ts drives it against a fake analyzer.
// ──────────────────────────────────────────────────────────────────────

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { AnalyzerDevice, AnalyzeArgs, ExtractArgs, FingerprintArgs, HelloResult, SeparateArgs, SingArgs, SyllablesArgs, TranscribeArgs, TtsArgs } from '@shared/analyzer/protocol';
import { killSidecar, spawnSidecar } from '../system/sidecar';

export type AnalyzerJobCmd = 'analyze' | 'separate' | 'transcribe' | 'fingerprint' | 'tts' | 'sing' | 'syllables' | 'extract';

export interface AnalyzerJobArgs {
  analyze: AnalyzeArgs;
  separate: SeparateArgs;
  transcribe: TranscribeArgs;
  fingerprint: FingerprintArgs;
  tts: TtsArgs;
  sing: SingArgs;
  syllables: SyllablesArgs;
  extract: ExtractArgs;
}

export interface JobOutcome<T> {
  ok: boolean;
  data?: T;
  message?: string;
  /** The job was cancelled (by cancel(), shutdown or the analyzer). */
  cancelled?: boolean;
}

export interface JobHandle<T> {
  done: Promise<JobOutcome<T>>;
  /** Ask the analyzer to stop the job (idempotent). */
  cancel(): void;
}

export interface AnalyzerProcessStatus {
  running: boolean;
  pid: number | null;
  version: string | null;
  devices: AnalyzerDevice[];
  /** Last start failure / crash summary, cleared by a successful start. */
  message?: string;
}

export interface AnalyzerSupervisorOptions {
  /** Absolute exe to launch (dev: a shadow copy), or null if not built. */
  resolveExe(): string | null;
  /** Cheap "is the exe there" check for status (default: resolveExe() !== null). */
  exists?(): boolean;
  /** Returned for every job while the exe is missing. */
  missingMessage: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Test hook: replaces the real sidecar spawner. */
  spawn?: (exe: string, args: string[]) => ChildProcessWithoutNullStreams;
  helloTimeoutMs?: number;
  /** How long a cancelled job may take to answer before the process is killed. */
  cancelGraceMs?: number;
  /** Shut the idle process down after this long without jobs (0 = never). */
  idleShutdownMs?: number;
}

interface Pending {
  cmd: string;
  resolve: (r: JobOutcome<unknown>) => void;
  onProgress?: (stage: string, fraction: number) => void;
  timer: NodeJS.Timeout | null;
  cancelRequested: boolean;
}

const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 5;

const VERB: Record<string, string> = {
  hello: 'starting up',
  analyze: 'analysing audio',
  separate: 'separating stems',
  transcribe: 'transcribing audio',
  tts: 'speaking',
  sing: 'singing',
  syllables: 'finding syllables',
  cancel: 'cancelling a job',
  shutdown: 'shutting down',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AnalyzerSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private starting: Promise<JobOutcome<HelloResult>> | null = null;
  private hello: HelloResult | null = null;
  private stopping = false;
  private crashes: number[] = [];
  private stderrTail: string[] = [];
  private lastMessage: string | undefined;
  private idleTimer: NodeJS.Timeout | null = null;
  private jobsInFlight = 0;
  private listeners = new Set<(s: AnalyzerProcessStatus) => void>();
  /** Child processes we killed on purpose (cancel grace, failed hello): not crashes. */
  private killedOnPurpose = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(private readonly opts: AnalyzerSupervisorOptions) {}

  // ── Status ─────────────────────────────────────────────────────────

  status(): AnalyzerProcessStatus {
    const s: AnalyzerProcessStatus = {
      running: !!this.child && !!this.hello,
      pid: this.child?.pid ?? null,
      version: this.hello?.version ?? null,
      devices: this.hello?.devices ?? [],
    };
    if (this.lastMessage) s.message = this.lastMessage;
    return s;
  }

  onStatus(cb: (s: AnalyzerProcessStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const s = this.status();
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* a listener must never break the supervisor */
      }
    }
  }

  /** The exe exists (a job can be attempted). */
  available(): boolean {
    try {
      return this.opts.exists ? this.opts.exists() : !!this.opts.resolveExe();
    } catch {
      return false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Start the process if needed and complete the hello handshake. */
  ensureStarted(): Promise<JobOutcome<HelloResult>> {
    if (this.child && this.hello) return Promise.resolve({ ok: true, data: this.hello });
    if (this.starting) return this.starting;
    const p = this.doStart().finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  private async doStart(): Promise<JobOutcome<HelloResult>> {
    this.stopping = false;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASHES) {
      const waitS = Math.ceil((CRASH_WINDOW_MS - (now - this.crashes[0])) / 1000);
      return { ok: false, message: `The audio analyzer crashed ${this.crashes.length} times in the last minute. Check the log, then try again in ${waitS} s.` };
    }
    if (this.crashes.length) {
      const delay = Math.min(8000, 250 * 2 ** (this.crashes.length - 1)) - (now - this.crashes[this.crashes.length - 1]);
      if (delay > 0) await sleep(delay);
    }

    let exe: string | null;
    try {
      exe = this.opts.resolveExe();
    } catch (err) {
      return this.startFailed(`Couldn't prepare the audio analyzer: ${(err as Error).message}`);
    }
    if (!exe) return this.startFailed(this.opts.missingMessage);

    let child: ChildProcessWithoutNullStreams;
    try {
      // No arguments (protocol): every path arrives inside a job. Never
      // detached, so the kill-on-close job object takes it down with us.
      child = (this.opts.spawn ?? spawnSidecar)(exe, []);
    } catch (err) {
      return this.startFailed(`Couldn't start the audio analyzer: ${(err as Error).message}`);
    }
    const gen = ++this.generation;
    this.child = child;
    this.hello = null;
    this.stderrTail = [];
    child.stdin.on('error', (e) => this.opts.log('debug', `[analyzer] stdin: ${e.message}`));
    child.on('error', (e) => {
      this.opts.log('error', `[analyzer] process error: ${e.message}`);
      if (child.pid === undefined) this.onExit(gen, child, null, null);
    });
    child.on('exit', (code, signal) => this.onExit(gen, child, code, signal));
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => this.onLine(gen, l));
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (l) => {
      this.stderrTail.push(l);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.opts.log('debug', `[analyzer:stderr] ${l}`);
    });

    const r = await this.send<HelloResult>(gen, { cmd: 'hello' }, undefined, this.opts.helloTimeoutMs ?? 20_000);
    if (gen !== this.generation) return { ok: false, message: r.message ?? 'The audio analyzer stopped while starting' };
    if (!r.ok || !r.data) {
      const why = r.message ?? 'no reply';
      this.killedOnPurpose.add(child);
      killSidecar(child);
      return this.startFailed(`The audio analyzer didn't complete its handshake: ${why}`);
    }
    this.hello = { version: String(r.data.version ?? '?'), devices: Array.isArray(r.data.devices) ? r.data.devices : ['cpu'] };
    this.lastMessage = undefined;
    this.opts.log('info', `Audio analyzer ${this.hello.version} started (pid ${child.pid ?? '?'}; ${this.hello.devices.join(', ') || 'cpu'})`);
    this.emit();
    this.armIdle();
    return { ok: true, data: this.hello };
  }

  private startFailed(message: string): JobOutcome<HelloResult> {
    this.lastMessage = message;
    this.emit();
    return { ok: false, message };
  }

  private onExit(gen: number, child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (gen !== this.generation) return;
    this.generation++;
    this.child = null;
    this.hello = null;
    this.clearIdle();
    const purposeful = this.stopping || this.killedOnPurpose.has(child);
    const tail = this.stderrTail.slice(-4).join(' | ');
    const exitText = `exit code ${code ?? 'none'}${signal ? `, ${signal}` : ''}`;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      if (p.cancelRequested) p.resolve({ ok: false, cancelled: true, message: 'Cancelled' });
      else if (this.stopping) p.resolve({ ok: false, cancelled: true, message: 'The audio analyzer was shut down before it finished' });
      else p.resolve({ ok: false, message: `The audio analyzer stopped unexpectedly while ${VERB[p.cmd] ?? p.cmd} (${exitText}). It restarts on the next request.${tail ? ` Last output: ${tail}` : ''}` });
    }
    this.pending.clear();
    this.jobsInFlight = 0;
    if (!purposeful) {
      this.crashes.push(Date.now());
      this.lastMessage = `The audio analyzer crashed (${exitText}); it restarts on the next request.`;
      this.opts.log('error', `Audio analyzer exited unexpectedly (${exitText})${tail ? `: ${tail}` : ''}`);
    } else {
      this.opts.log('debug', `Audio analyzer exited (${exitText})`);
    }
    this.emit();
  }

  /** Graceful shutdown (app quit): shutdown request, kill after 2 s. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearIdle();
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((r) => {
      if (child.exitCode !== null) r();
      else child.once('exit', () => r());
    });
    void this.send(this.generation, { cmd: 'shutdown' }, undefined, 2000);
    // No new job goes to the exiting process: the next one spawns a fresh analyzer.
    this.hello = null;
    this.emit();
    const killTimer = setTimeout(() => killSidecar(child), 2000);
    await Promise.race([exited, sleep(3000)]);
    clearTimeout(killTimer);
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
  }

  private armIdle(): void {
    this.clearIdle();
    const ms = this.opts.idleShutdownMs ?? 10 * 60_000;
    if (!ms || !this.child || this.jobsInFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.jobsInFlight > 0 || !this.child) return;
      this.opts.log('debug', 'Audio analyzer idle; shutting it down to free memory');
      void this.stop().then(() => {
        this.stopping = false;
      });
    }, ms);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ── Requests ───────────────────────────────────────────────────────

  private send<T>(gen: number, req: { cmd: string; args?: unknown }, onProgress?: (stage: string, fraction: number) => void, timeoutMs = 0, onSent?: (id: number) => void): Promise<JobOutcome<T>> {
    const child = this.child;
    if (!child || gen !== this.generation || !child.stdin.writable) {
      return Promise.resolve({ ok: false, message: this.lastMessage ?? "The audio analyzer isn't running" });
    }
    const id = this.nextId++;
    return new Promise<JobOutcome<T>>((resolve) => {
      const entry: Pending = {
        cmd: req.cmd,
        onProgress,
        cancelRequested: false,
        timer: null,
        resolve: (r) => {
          if (!this.pending.delete(id)) return;
          if (entry.timer) clearTimeout(entry.timer);
          resolve(r as JobOutcome<T>);
        },
      };
      if (timeoutMs > 0) entry.timer = setTimeout(() => entry.resolve({ ok: false, message: `The audio analyzer didn't answer "${req.cmd}" in time` }), timeoutMs);
      this.pending.set(id, entry);
      try {
        child.stdin.write(JSON.stringify({ id, ...req }) + '\n');
        onSent?.(id);
      } catch (err) {
        entry.resolve({ ok: false, message: `Couldn't talk to the audio analyzer: ${(err as Error).message}` });
      }
    });
  }

  /**
   * Run a job. Starts the analyzer when needed. `done` always resolves:
   * {ok:true,data} | {ok:false,message} | {ok:false,cancelled:true}.
   */
  run<C extends AnalyzerJobCmd, T = unknown>(cmd: C, args: AnalyzerJobArgs[C], onProgress?: (stage: string, fraction: number) => void): JobHandle<T> {
    let cancelled = false;
    let sentId: number | null = null;
    let gen = -1;
    let graceTimer: NodeJS.Timeout | null = null;
    this.clearIdle();
    this.jobsInFlight++;

    const requestCancel = (): void => {
      if (sentId === null || gen !== this.generation) return;
      const p = this.pending.get(sentId);
      if (!p || p.cancelRequested) return;
      p.cancelRequested = true;
      void this.send(gen, { cmd: 'cancel', args: { target: sentId } }, undefined, 5000);
      const child = this.child;
      graceTimer = setTimeout(() => {
        if (sentId !== null && this.pending.has(sentId) && child && this.child === child) {
          this.opts.log('warn', `The audio analyzer didn't stop a cancelled job within ${Math.round((this.opts.cancelGraceMs ?? 5000) / 1000)} s; restarting it.`);
          this.killedOnPurpose.add(child);
          killSidecar(child);
        }
      }, this.opts.cancelGraceMs ?? 5000);
    };

    const done = (async (): Promise<JobOutcome<T>> => {
      const started = await this.ensureStarted();
      if (cancelled) return { ok: false, cancelled: true, message: 'Cancelled' };
      if (!started.ok) return { ok: false, message: started.message };
      gen = this.generation;
      const r = await this.send<T>(gen, { cmd, args }, onProgress, 0, (id) => {
        sentId = id;
        if (cancelled) queueMicrotask(requestCancel);
      });
      if (graceTimer) clearTimeout(graceTimer);
      if (!r.ok && (r.cancelled || cancelled)) return { ok: false, cancelled: true, message: 'Cancelled' };
      return r;
    })().finally(() => {
      this.jobsInFlight = Math.max(0, this.jobsInFlight - 1);
      if (this.jobsInFlight === 0) this.armIdle();
    });

    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        requestCancel();
      },
    };
  }

  private onLine(gen: number, line: string): void {
    if (gen !== this.generation) return;
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t);
    } catch {
      this.opts.log('debug', `[analyzer:stdout] ${t.slice(0, 300)}`);
      return;
    }
    if (typeof msg.event === 'string') {
      if (msg.event === 'progress' && typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        const fraction = Number(msg.fraction);
        try {
          p?.onProgress?.(typeof msg.stage === 'string' ? msg.stage : '', Number.isFinite(fraction) ? (fraction < 0 ? -1 : Math.min(1, fraction)) : -1);
        } catch {
          /* progress listeners are best-effort */
        }
      } else if (msg.event === 'log') {
        const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'debug';
        this.opts.log(level, `[analyzer] ${String(msg.message ?? '')}`);
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return; // timed out earlier
    if (msg.ok === true) p.resolve({ ok: true, data: msg.data });
    else {
      const message = typeof msg.message === 'string' && msg.message ? msg.message : `Audio analyzer error while ${VERB[p.cmd] ?? p.cmd}`;
      p.resolve({ ok: false, message, cancelled: msg.cancelled === true ? true : undefined });
    }
  }
}
