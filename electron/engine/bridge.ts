// DocHost → engine bridge. Every DocChange becomes an entity-level diff
// (shared/engine/projection.ts) sent as `apply {version}`; bursts within
// ~8 ms are coalesced into one apply. A reset (new/open project) — or any
// failed apply — sends the whole project with `loadProject` instead.
// Sample paths are resolved to absolute paths before they reach the engine.

import type { Patch } from 'immer';
import type { DocChange, DocHost } from '@shared/doc/DocHost';
import type { Project, SampleRef } from '@shared/schema/project';
import { projectPatches } from '@shared/engine/projection';
import type { ActionResult } from '@shared/types';
import type { EngineSupervisor } from './supervisor';

const COALESCE_MS = 8;

type Mode = 'idle' | 'loading' | 'live';

export class EngineBridge {
  private mode: Mode = 'idle';
  private pending: Patch[] = [];
  private timer: NodeJS.Timeout | null = null;
  private loadSeq = 0;
  private failedApplies = 0;
  private lastLoadAt = 0;
  /** The last loadProject/apply sent. The engine answers stdin in order, so its ack covers every earlier one. */
  private lastSent: Promise<unknown> = Promise.resolve();
  private unsub: () => void;

  constructor(
    private readonly doc: DocHost,
    private readonly engine: EngineSupervisor,
    private readonly resolveSamplePath: (p: string) => string,
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', m: string) => void,
  ) {
    this.unsub = doc.subscribe((c) => this.onChange(c));
    // The process died (or hasn't said hello yet): nothing to keep in sync.
    // The supervisor calls load() again as the last step of every (re)start.
    engine.onStatus(() => {
      if (!engine.isAlive()) this.toIdle();
    });
  }

  dispose(): void {
    this.unsub();
    this.toIdle();
  }

  private toIdle(): void {
    this.mode = 'idle';
    this.pending = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private resolveSample = (s: SampleRef): SampleRef => ({ ...s, path: this.resolveSamplePath(s.path) });

  /** The project as the engine should see it (absolute sample paths). */
  engineProject(p: Project = this.doc.project): Project {
    const samples: Record<string, SampleRef> = {};
    for (const [id, s] of Object.entries(p.samples)) samples[id] = this.resolveSample(s);
    return { ...p, samples };
  }

  /** Send the whole project. Changes arriving meanwhile are queued and applied after the ack. */
  async load(): Promise<ActionResult> {
    const seq = ++this.loadSeq;
    this.lastLoadAt = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.mode = 'loading';
    const version = this.doc.version;
    const req = this.engine.request<{ version: number }>({ cmd: 'loadProject', version, project: this.engineProject() }, 60_000);
    this.lastSent = req;
    const r = await req;
    if (seq !== this.loadSeq) return r; // superseded by a newer load
    if (!r.ok) {
      this.mode = 'idle';
      return r;
    }
    this.mode = 'live';
    this.failedApplies = 0;
    if (this.pending.length) this.schedule();
    return r;
  }

  private onChange(c: DocChange): void {
    if (c.kind === 'reset') {
      if (this.engine.isAlive()) void this.load();
      return;
    }
    if (this.mode === 'idle') {
      // Engine alive but the last load/apply failed: retry a full load (at most every 5 s).
      if (this.engine.isAlive() && this.engine.status().state === 'running' && Date.now() - this.lastLoadAt > 5000) void this.load();
      return;
    }
    for (const p of c.patches) this.pending.push(p);
    if (this.mode === 'live') this.schedule();
  }

  /**
   * Send changes still waiting in the coalescing window now and resolve once
   * the engine has acked everything sent so far, including a load in progress
   * and the changes queued behind it. Never rejects; a failed apply has
   * already triggered a resync, which this waits for too.
   */
  async sync(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.mode === 'live' && this.pending.length) void this.flush();
      const sent = this.lastSent;
      await sent.catch(() => undefined);
      if (sent === this.lastSent && !this.timer && (this.mode !== 'live' || !this.pending.length)) return;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), COALESCE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.mode !== 'live' || this.pending.length === 0) return;
    const patches = this.pending;
    this.pending = [];
    const version = this.doc.version;
    let diff: ReturnType<typeof projectPatches>;
    try {
      diff = projectPatches(this.doc.project, patches, this.resolveSample);
    } catch (err) {
      this.log('warn', `Engine sync: couldn't project changes (${(err as Error).message}); reloading the project`);
      void this.load();
      return;
    }
    const seq = this.loadSeq;
    const req = this.engine.request({ cmd: 'apply', version, upserts: diff.upserts, deletes: diff.deletes }, 15_000);
    this.lastSent = req;
    const r = await req;
    if (r.ok || seq !== this.loadSeq || !this.engine.isAlive()) return;
    this.failedApplies++;
    this.log('warn', `Engine rejected a change (${r.message ?? 'unknown'}); resyncing the whole project`);
    if (this.failedApplies <= 3) void this.load();
    else this.mode = 'idle';
  }
}
