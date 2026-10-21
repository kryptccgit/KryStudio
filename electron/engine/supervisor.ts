// ──────────────────────────────────────────────────────────────────────
// EngineSupervisor: owns the krypt-studio-engine.exe sidecar.
//
//   spawn (absolute path, --parent-pid, --factory-dir, windowsHide)
//     → hello → openDevice (settings) → loadProject (bridge) → running
//   NDJSON over stdio: requests carry ids + timeouts; lines without an id
//   are events (log / device / renderProgress / applied / xrun).
//   Heartbeat: ping every 1 s; 3 misses (or any exit) → restart with
//   exponential backoff; 5 crashes inside a minute → 'failed' until the
//   user clicks Restart engine.
//
// Implements the EngineClient contract (electron/engine/types.ts). Every
// call resolves to an ActionResult and never throws.
// ──────────────────────────────────────────────────────────────────────

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { ActionResult, EngineStatus } from '@shared/types';
import {
  PROTOCOL_VERSION,
  type Analysis,
  type DeviceStatus,
  type EngineEvent,
  type EngineRequest,
  type HelloData,
  type RenderRequest,
  type RenderResult,
  type SampleInfo,
} from '@shared/engine/protocol';
import type { EngineClient } from './types';
import { killSidecar, spawnSidecar } from '../system/sidecar';

export interface SupervisorOptions {
  /** Absolute exe to launch (dev: a shadow copy), or null if not built. */
  resolveExe(): string | null;
  /** Shown as the 'failed' message when the exe is missing. */
  missingMessage: string;
  factoryDir: string;
  /**
   * userData/packs, passed as --packs-dir ('pack:<id>/…' samples). An engine build older than that flag rejects it
   * at start-up; the supervisor then runs that build without it (main still resolves pack paths before they reach
   * the engine) and tries the flag again with the next build.
   */
  packsDir?: string;
  audioSettings(): { deviceId: string | null; bufferFrames: number; sampleRate: number };
  /** Send the current project (loadProject). Called on every (re)start. */
  loadProject(): Promise<ActionResult>;
  /** Push document changes still queued for the engine and wait for the ack: renders read the engine's model. */
  syncDoc?(): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Test hook: replaces the real sidecar spawner. */
  spawn?: (exe: string, args: string[]) => ChildProcessWithoutNullStreams;
}

interface Pending {
  cmd: string;
  resolve: (r: ActionResult<any>) => void;
  timer: NodeJS.Timeout | null;
}

const DEFAULT_TIMEOUT_MS = 5000;
const PING_EVERY_MS = 1000;
const PING_TIMEOUT_MS = 1000;
const MAX_MISSES = 3;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 5;

/** Requests that legitimately keep the control loop busy (don't count missed pings meanwhile). */
const NO_HEARTBEAT_SUSPEND = new Set(['ping', 'render', 'cancelRender', 'audition', 'auditionOff', 'transport', 'locate']);

export class EngineSupervisor implements EngineClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private busy = 0;
  private stopping = false;
  private crashes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private misses = 0;
  private pinging = false;
  private telemetry: { port: number; token: string } | null = null;
  private stderrTail: string[] = [];
  private playing = false;
  private generation = 0;
  private missingPoll: NodeJS.Timeout | null = null;
  /** The exe of the current process, and whether it got --packs-dir. */
  private launched: { exe: string; packsArg: boolean } | null = null;
  /** An engine exe that rejected --packs-dir (an older build): started without it. */
  private noPacksArgExe: string | null = null;

  private _status: EngineStatus = { state: 'stopped', device: null, engineVersion: null, restarts: 0 };
  private statusListeners = new Set<(s: EngineStatus) => void>();
  private eventListeners = new Set<(e: EngineEvent) => void>();
  private playingListeners = new Set<(playing: boolean) => void>();

  constructor(private readonly opts: SupervisorOptions) {}

  // ── Status / events ────────────────────────────────────────────────

  status(): EngineStatus {
    return this._status;
  }

  onStatus(cb: (s: EngineStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onEvent(cb: (e: EngineEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onPlaying(cb: (playing: boolean) => void): () => void {
    this.playingListeners.add(cb);
    return () => this.playingListeners.delete(cb);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** True once hello succeeded on the current process. */
  isAlive(): boolean {
    return !!this.child && this.telemetry !== null;
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    const next: EngineStatus = { ...this._status, ...patch };
    // A patch only touches `message` when it names it; `message: undefined` clears it.
    if ('message' in patch && patch.message === undefined) delete next.message;
    if (JSON.stringify(next) === JSON.stringify(this._status)) return;
    this._status = next;
    for (const fn of this.statusListeners) {
      try {
        fn(next);
      } catch {
        /* ignore */
      }
    }
  }

  private setPlaying(p: boolean): void {
    if (p === this.playing) return;
    this.playing = p;
    for (const fn of this.playingListeners) {
      try {
        fn(p);
      } catch {
        /* ignore */
      }
    }
  }

  private emitEvent(e: EngineEvent): void {
    for (const fn of this.eventListeners) {
      try {
        fn(e);
      } catch {
        /* ignore */
      }
    }
  }

  telemetryUrl(): string | null {
    if (!this.child || !this.telemetry) return null;
    return `ws://127.0.0.1:${this.telemetry.port}/?token=${encodeURIComponent(this.telemetry.token)}`;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.child) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopping = false;
    let exe: string | null;
    try {
      exe = this.opts.resolveExe();
    } catch (err) {
      this.setStatus({ state: 'failed', message: `Couldn't prepare the audio engine: ${(err as Error).message}` });
      return;
    }
    if (!exe) {
      this.setStatus({ state: 'failed', message: this.opts.missingMessage, device: null, engineVersion: null });
      return;
    }

    const restarting = this._status.state === 'restarting';
    this.setStatus({ state: restarting ? 'restarting' : 'starting', message: restarting ? 'Restarting the audio engine…' : 'Starting the audio engine…' });
    let child: ChildProcessWithoutNullStreams;
    const packsArg = !!this.opts.packsDir && this.noPacksArgExe !== exe;
    const args = ['--parent-pid', String(process.pid), '--factory-dir', this.opts.factoryDir, ...(packsArg ? ['--packs-dir', this.opts.packsDir!] : [])];
    this.launched = { exe, packsArg };
    try {
      child = (this.opts.spawn ?? spawnSidecar)(exe, args);
    } catch (err) {
      this.setStatus({ state: 'failed', message: `Couldn't start the audio engine: ${(err as Error).message}` });
      return;
    }
    const gen = ++this.generation;
    this.child = child;
    this.telemetry = null;
    this.misses = 0;
    this.stderrTail = [];

    child.stdin.on('error', (e) => this.opts.log('debug', `[engine] stdin: ${e.message}`));
    child.on('error', (e) => {
      this.opts.log('error', `[engine] process error: ${e.message}`);
      // 'error' without 'exit' happens when spawn itself fails.
      if (child.pid === undefined) this.onExit(gen, null, null);
    });
    child.on('exit', (code, signal) => this.onExit(gen, code, signal));
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => this.onLine(l));
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (l) => {
      // An engine build from before --packs-dir refuses it (and exits): remember that exe (see onExit).
      if (packsArg && l.includes("Unknown argument '--packs-dir'")) this.noPacksArgExe = exe;
      this.stderrTail.push(l);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.opts.log('debug', `[engine:stderr] ${l}`);
    });

    void this.handshake(gen);
  }

  private async handshake(gen: number): Promise<void> {
    const hello = await this.request<HelloData>({ cmd: 'hello', protocol: PROTOCOL_VERSION }, 8000);
    if (gen !== this.generation) return;
    if (!hello.ok || !hello.data) {
      this.opts.log('error', `Audio engine handshake failed: ${hello.message ?? 'no reply'}`);
      this.kill();
      return;
    }
    if (hello.data.protocol !== PROTOCOL_VERSION) {
      this.stopping = true; // don't crash-loop on a version mismatch
      this.kill();
      this.setStatus({
        state: 'failed',
        message: `Audio engine speaks protocol ${hello.data.protocol}, the app expects ${PROTOCOL_VERSION}. Rebuild the engine (npm run engine:build:debug).`,
      });
      return;
    }
    this.telemetry = hello.data.telemetry ?? null;
    this.setStatus({ engineVersion: hello.data.engineVersion ?? null, device: hello.data.device ?? null });

    const a = this.opts.audioSettings();
    const dev = await this.request<DeviceStatus>({ cmd: 'openDevice', deviceId: a.deviceId, bufferFrames: a.bufferFrames, sampleRate: a.sampleRate }, 15000);
    if (gen !== this.generation) return;
    if (dev.ok && dev.data) this.setStatus({ device: dev.data });
    else this.opts.log('warn', `Couldn't open the audio device: ${dev.message ?? 'unknown error'}`);

    const load = await this.opts.loadProject();
    if (gen !== this.generation) return;
    if (!load.ok) this.opts.log('error', `Audio engine couldn't load the project: ${load.message ?? 'unknown error'}`);

    this.crashes = this.crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    const devMsg = this._status.device && !this._status.device.open ? this._status.device.message ?? 'No audio output device is open.' : undefined;
    this.setStatus({ state: 'running', message: load.ok ? devMsg : `Project didn't load in the engine: ${load.message}` });
    this.startHeartbeat(gen);
  }

  private startHeartbeat(gen: number): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(async () => {
      if (gen !== this.generation || !this.child) return this.stopHeartbeat();
      if (this.pinging || this.busy > 0) return;
      this.pinging = true;
      const r = await this.request({ cmd: 'ping' }, PING_TIMEOUT_MS);
      this.pinging = false;
      if (gen !== this.generation) return;
      if (r.ok) {
        this.misses = 0;
        return;
      }
      this.misses++;
      if (this.misses >= MAX_MISSES) {
        this.opts.log('warn', `Audio engine stopped responding (${MAX_MISSES} missed heartbeats); restarting it.`);
        this.kill();
      }
    }, PING_EVERY_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.pinging = false;
  }

  private kill(): void {
    killSidecar(this.child);
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (gen !== this.generation) return;
    this.generation++;
    this.child = null;
    this.telemetry = null;
    this.stopHeartbeat();
    this.setPlaying(false);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ ok: false, message: 'The audio engine stopped before answering' });
    }
    this.pending.clear();
    this.busy = 0;

    if (this.stopping) {
      this.setStatus({ state: 'stopped', message: undefined });
      return;
    }
    // An engine build from before --packs-dir: run it without the flag (not a crash).
    const launched = this.launched;
    if (launched?.packsArg && this.noPacksArgExe === launched.exe) {
      this.opts.log('warn', 'This audio engine build predates sound packs (--packs-dir); starting it without that option. Rebuild the engine for pack instruments in offline renders.');
      this.setStatus({ state: 'restarting', message: 'Restarting the audio engine…', device: null });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, 50);
      return;
    }
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    const tail = this.stderrTail.slice(-6).join(' | ');
    this.opts.log('error', `Audio engine exited unexpectedly (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})${tail ? `: ${tail}` : ''}`);
    if (this.crashes.length >= MAX_CRASHES) {
      this.setStatus({
        state: 'failed',
        message: `The audio engine crashed ${this.crashes.length} times in a minute. Check the log, then use Restart engine.`,
        device: null,
      });
      return;
    }
    const delay = Math.min(8000, 250 * 2 ** (this.crashes.length - 1));
    this.setStatus({ state: 'restarting', message: `Audio engine stopped; restarting in ${(delay / 1000).toFixed(1)} s…`, restarts: this._status.restarts + 1, device: null });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  /** Graceful stop; resolves once the process has exited. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.missingPoll) clearInterval(this.missingPoll);
    this.missingPoll = null;
    this.stopHeartbeat();
    const child = this.child;
    if (!child) {
      if (this._status.state !== 'failed') this.setStatus({ state: 'stopped', message: undefined });
      return;
    }
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    await this.request({ cmd: 'shutdown' }, 800);
    try {
      child.stdin.end(); // EOF also makes the engine exit
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => killSidecar(child), 1500);
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2500))]);
    clearTimeout(killTimer);
  }

  async restart(): Promise<ActionResult> {
    await this.stop();
    this.crashes = [];
    this.stopping = false;
    this.setStatus({ state: 'starting', message: 'Starting the audio engine…', restarts: this._status.restarts + 1 });
    this.start();
    const s = await this.waitSettled(20000);
    if (s.state === 'running') return { ok: true, message: 'Audio engine restarted' };
    return { ok: false, message: s.message ?? `Audio engine is ${s.state}` };
  }

  /** In dev, start automatically once the exe appears (after engine:build). */
  watchForBinary(intervalMs = 2000): void {
    if (this.missingPoll) return;
    this.missingPoll = setInterval(() => {
      if (this.child || this._status.state !== 'failed' || this.stopping) return;
      let exe: string | null = null;
      try {
        exe = this.opts.resolveExe();
      } catch {
        exe = null;
      }
      if (exe && this._status.message === this.opts.missingMessage) {
        this.opts.log('info', 'Audio engine binary found; starting it.');
        this.start();
      }
    }, intervalMs);
  }

  private waitSettled(timeoutMs: number): Promise<EngineStatus> {
    return new Promise((resolve) => {
      const done = (s: EngineStatus): boolean => s.state === 'running' || s.state === 'failed' || s.state === 'stopped';
      if (done(this._status)) return resolve(this._status);
      const timer = setTimeout(() => {
        off();
        resolve(this._status);
      }, timeoutMs);
      const off = this.onStatus((s) => {
        if (!done(s)) return;
        clearTimeout(timer);
        off();
        resolve(s);
      });
    });
  }

  // ── Requests ───────────────────────────────────────────────────────

  request<T = unknown>(req: EngineRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ActionResult<T>> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      const why = this._status.state === 'failed' && this._status.message ? ` ${this._status.message}` : '';
      return Promise.resolve({ ok: false, message: `The audio engine isn't running.${why}` });
    }
    const id = this.nextId++;
    const counts = !NO_HEARTBEAT_SUSPEND.has(req.cmd);
    if (counts) this.busy++;
    return new Promise<ActionResult<T>>((resolve) => {
      const finish = (r: ActionResult<T>): void => {
        if (!this.pending.delete(id)) return;
        if (counts) this.busy = Math.max(0, this.busy - 1);
        if (req.cmd === 'transport' && r.ok) this.setPlaying(!!(r.data as { playing?: boolean } | undefined)?.playing);
        resolve(r);
      };
      const timer =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(() => finish({ ok: false, message: `The audio engine didn't answer "${req.cmd}" in time` }), timeoutMs)
          : null;
      this.pending.set(id, { cmd: req.cmd, resolve: finish as (r: ActionResult<any>) => void, timer });
      try {
        child.stdin.write(JSON.stringify({ id, ...req }) + '\n');
      } catch (err) {
        if (timer) clearTimeout(timer);
        finish({ ok: false, message: `Couldn't talk to the audio engine: ${(err as Error).message}` });
      }
    });
  }

  private onLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t);
    } catch {
      this.opts.log('debug', `[engine:stdout] ${t.slice(0, 300)}`);
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return; // timed out earlier
      if (p.timer) clearTimeout(p.timer);
      p.resolve(
        msg.ok
          ? { ok: true, data: msg.data as unknown, message: typeof msg.message === 'string' ? msg.message : undefined }
          : { ok: false, message: typeof msg.message === 'string' && msg.message ? msg.message : `Audio engine error on "${p.cmd}"` },
      );
      return;
    }
    if (typeof msg.event === 'string') this.handleEvent(msg as unknown as EngineEvent);
  }

  private handleEvent(e: EngineEvent): void {
    switch (e.event) {
      case 'log':
        this.opts.log(e.level === 'debug' ? 'debug' : e.level, `[engine] ${e.message}`);
        break;
      case 'device':
        this.setStatus({ device: e.status, message: e.status.open ? undefined : e.status.message ?? 'Audio device lost; retrying…' });
        break;
      case 'xrun':
        this.opts.log('debug', `[engine] xrun x${e.count}`);
        break;
      default:
        break;
    }
    this.emitEvent(e);
  }

  // ── Convenience wrappers (EngineClient) ────────────────────────────

  /** Open an output device and reflect it in the status. */
  async openDevice(o: { deviceId?: string | null; bufferFrames?: number; sampleRate?: number }): Promise<ActionResult<DeviceStatus>> {
    const r = await this.request<DeviceStatus>({ cmd: 'openDevice', ...o }, 15_000);
    if (r.ok && r.data) this.setStatus({ device: r.data, message: r.data.open ? undefined : r.data.message ?? 'No audio output device is open.' });
    return r;
  }

  private renders = 0;

  /** A render (export, agent preview) is running: the project tabs refuse a switch meanwhile. */
  isRendering(): boolean {
    return this.renders > 0;
  }

  async render(job: RenderRequest): Promise<ActionResult<RenderResult>> {
    this.renders++;
    try {
      // An edit made just before (an agent's write_pattern → render_preview) may
      // still sit in the bridge's coalescing window; render what the user sees.
      await this.opts.syncDoc?.();
      return await this.request<RenderResult>({ cmd: 'render', job }, 0);
    } finally {
      this.renders--;
    }
  }

  analyzeFile(path: string): Promise<ActionResult<Analysis>> {
    return this.request<Analysis>({ cmd: 'analyzeFile', path }, 120_000);
  }

  sampleInfo(path: string): Promise<ActionResult<SampleInfo>> {
    return this.request<SampleInfo>({ cmd: 'sampleInfo', path }, 20_000);
  }
}
