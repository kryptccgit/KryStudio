import path from 'node:path';
import crypto from 'node:crypto';
import { USER, type DocHost } from '@shared/doc/DocHost';
import { PPQ } from '@shared/schema/time';
import type { AnalyzerDevice, AudioAnalysis, HelloResult, StemsResult, TranscribeArgs, TranscriptionResult } from '@shared/analyzer/protocol';
import type { ModelDef } from '@shared/analyzer/models';
import type { SampleInfo } from '@shared/engine/protocol';
import type { ActionResult, Settings } from '@shared/types';
import type {
  BeatNote,
  Collection,
  LibraryFocus,
  LibraryQueueState,
  LibraryState,
  LibraryTrack,
  OriginalityMatch,
  OriginalityReport,
  ProjectLine,
  StyleProfile,
  TrackDetail,
  TrackFeatures,
  TrackQuery,
  TrackStatus,
} from '@shared/library/types';
import { chordsToBeats, drumGrid, notesToBeats } from '@shared/library/grid';
import { featureVector, nearest, VECTOR_VERSION } from '@shared/library/similarity';
import { buildProfile, profileText, type ProfileInput } from '@shared/library/profile';
import { findMatches, lineHashes, originalitySummary, projectLines, type ReferenceLine } from '@shared/library/originality';
import type { AnalyzerJobArgs, AnalyzerJobCmd, AnalyzerProcessStatus, JobHandle, JobOutcome } from '../analyzer/supervisor';
import { isDirectory, statSource, walkFiles } from '../system/walk';
import { makeDir, removeDir, renameDir } from '../system/download';
import { LibraryDb, LibraryDbError, parseVector, pathKey, rowToTrack, type TrackRow, type TrackSummary } from './db';
import { AUDIO_EXTENSIONS, AUDIO_FILE_RE } from '@shared/audio/formats';

export const LIBRARY_AUDIO_EXTENSIONS: readonly string[] = AUDIO_EXTENSIONS;
const ENGINE_AUDIO = AUDIO_FILE_RE;

export function isLibraryAudio(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return LIBRARY_AUDIO_EXTENSIONS.includes(ext);
}

const BEAT_MODEL = 'beat-this-small';
export const LIGHT_CONCURRENCY = 2;
const STEM_SILENCE_DB = -55;
const VOCAL_SILENCE_DB = -42;
const MAX_ATTEMPTS = 3;
const DEEP_SEC_PER_MIN: Record<AnalyzerDevice, number> = { directml: 7 + 2, cpu: 26 + 3 };
const DEFAULT_TRACK_SEC = 210;
const PAGE = 200;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const newId = (prefix: string): string => `${prefix}${crypto.randomBytes(6).toString('hex')}`;
const fileName = (p: string): string => path.basename(p).replace(/\.[a-z0-9]+$/i, '');

const ANALYZER_FAILURE =
  /audio analyzer (crashed|stopped unexpectedly|was shut down|isn't running|is not built|didn't (complete|answer))|couldn't (start|prepare|talk to) the audio analyzer|krypt-studio-analyzer(\.exe)? is missing/i;

function fail<T = never>(message: string): ActionResult<T> {
  return { ok: false, message };
}

function plural(n: number, w: string, pl = `${w}s`): string {
  return `${n} ${n === 1 ? w : pl}`;
}

export function compactJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'number' && Number.isFinite(x) && !Number.isInteger(x) ? Math.round(x * 1e4) / 1e4 : x));
}

export function parseFeatures(json: string, vector?: string | number[]): TrackFeatures | null {
  try {
    const f = JSON.parse(json) as Partial<TrackFeatures>;
    if (!f || typeof f !== 'object' || !f.analysis || typeof f.analysis !== 'object') return null;
    return {
      analysis: f.analysis,
      drums: f.drums ?? null,
      chords: Array.isArray(f.chords) ? f.chords : [],
      lines: f.lines && typeof f.lines === 'object' ? f.lines : {},
      vector: Array.isArray(vector) ? vector : parseVector(vector ?? '[]'),
    };
  } catch {
    return null;
  }
}

export function lightFeatures(a: AudioAnalysis): { features: Omit<TrackFeatures, 'vector'>; vector: number[]; summary: TrackSummary } {
  const { drumHits, ...analysis } = a;
  const drums = Array.isArray(drumHits) ? drumGrid(a, drumHits, 'mix') : null;
  const chords = Array.isArray(a.chords) && a.chords.length ? chordsToBeats(a, a.chords) : [];
  const vector = featureVector(analysis, drums);
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    features: { analysis, drums, chords, lines: {} },
    vector,
    summary: {
      duration: n(a.durationSec),
      bpm: n(a.tempo?.bpm),
      bpmConf: n(a.tempo?.confidence),
      key: a.key?.name ?? null,
      keyConf: n(a.key?.confidence),
      swing: n(a.swing),
      lufs: n(a.levels?.lufsIntegrated),
      width: n(a.stereo?.width),
    },
  };
}

export function linesHashes(lines: TrackFeatures['lines']): { hashes: Array<{ hash: number; stem: string; pos: number }>; lines: number } {
  const hashes: Array<{ hash: number; stem: string; pos: number }> = [];
  let count = 0;
  for (const [stem, notes] of Object.entries(lines)) {
    if (!notes?.length) continue;
    count++;
    for (const h of lineHashes(notes.map((n) => ({ start: n.beat, dur: n.dur, key: n.key })))) hashes.push({ hash: h.hash, stem, pos: h.pos });
  }
  return { hashes, lines: count };
}

export interface LibraryBackend {
  run<C extends AnalyzerJobCmd, T = unknown>(cmd: C, args: AnalyzerJobArgs[C], onProgress?: (stage: string, fraction: number) => void): JobHandle<T>;
  available(): boolean;
  status(): AnalyzerProcessStatus;
  onStatus(cb: (s: AnalyzerProcessStatus) => void): () => void;
  ensureStarted?(): Promise<JobOutcome<HelloResult>>;
  modelDir(id: string): string | null;
  defaultModel(task: ModelDef['task']): ModelDef | undefined;
}

export function backendFrom(
  supervisor: Pick<LibraryBackend, 'run' | 'available' | 'status' | 'onStatus'> & { ensureStarted?(): Promise<JobOutcome<HelloResult>> },
  models: { dirFor(id: string): string | null; defaultFor(task: ModelDef['task']): ModelDef | undefined },
): LibraryBackend {
  return {
    run: <C extends AnalyzerJobCmd, T = unknown>(cmd: C, args: AnalyzerJobArgs[C], onProgress?: (stage: string, fraction: number) => void) => supervisor.run<C, T>(cmd, args, onProgress),
    available: () => supervisor.available(),
    status: () => supervisor.status(),
    onStatus: (cb) => supervisor.onStatus(cb),
    ensureStarted: typeof supervisor.ensureStarted === 'function' ? () => supervisor.ensureStarted!() : undefined,
    modelDir: (id) => models.dirFor(id),
    defaultModel: (task) => models.defaultFor(task),
  };
}

export interface LibraryDeps {
  userDataDir: string;
  doc: DocHost;
  backend: LibraryBackend | null;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  sampleInfo?(absPath: string): Promise<ActionResult<SampleInfo>>;
  pickFolder?(title: string): Promise<string | null>;
  pickFiles?(title: string, extensions: readonly string[]): Promise<string[] | null>;
  broadcast?(state: LibraryState): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  resumeDelayMs?: number;
  retryDelayMs?: number;
  now?(): number;
}

interface Inflight {
  id: string;
  phase: 'light' | 'deep';
  name: string;
  collectionId: string;
  handle: JobHandle<unknown> | null;
  cancelled: boolean;
  startedAt: number;
}

class LibraryError extends Error {}

export class LibraryService {
  private db: LibraryDb | null = null;
  private dbError: string | null = null;
  private started = false;
  private stopped = false;
  private queueOpen = false;
  private paused = false;
  private message: string | null = null;
  private inflight = new Map<string, Inflight>();
  private running = new Set<Promise<void>>();
  private removing = new Set<string>();
  private pumpTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private backoffUntil = 0;
  private solo = false;
  private doneLight = 0;
  private doneDeep = 0;
  private emaLightSec: number | null = null;
  private emaDeepSecPerMin: number | null = null;
  private lastDevices: AnalyzerDevice[] = [];
  private lastBroadcast = 0;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private profiles = new Map<string, { rev: number; profile: StyleProfile }>();
  private building = new Map<string, Promise<StyleProfile>>();
  private vectors: Map<string, { collectionId: string; vector: number[] }> | null = null;
  private unsubBackend: (() => void) | null = null;
  readonly libDir: string;
  readonly dbPath: string;
  readonly tmpDir: string;

  constructor(private readonly deps: LibraryDeps) {
    this.libDir = path.join(deps.userDataDir, 'library');
    this.dbPath = path.join(this.libDir, 'library.sqlite');
    this.tmpDir = path.join(this.libDir, 'tmp');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await makeDir(this.libDir);
      this.db = await this.openDb();
      this.paused = this.db.getMeta('paused') === '1';
      try {
        const devs = JSON.parse(this.db.getMeta('devices') ?? '[]');
        if (Array.isArray(devs)) this.lastDevices = devs.filter((d): d is AnalyzerDevice => d === 'cpu' || d === 'directml');
      } catch {
      }
    } catch (err) {
      this.dbError = errText(err);
      this.deps.log('error', `Reference library unavailable: ${this.dbError}`);
    }
    await removeDir(this.tmpDir).catch((err) => this.deps.log('warn', `Couldn't clear the library's temporary stems (${this.tmpDir}): ${errText(err)}`));
    this.unsubBackend =
      this.deps.backend?.onStatus((s) => {
        if (s.devices.length && s.devices.join() !== this.lastDevices.join()) {
          this.lastDevices = [...s.devices];
          try {
            this.db?.setMeta('devices', JSON.stringify(this.lastDevices));
          } catch {
          }
        }
      }) ?? null;
    this.validateFocus();
    this.notify();
    if (this.db) {
      void this.refreshVectors();
      const delay = this.deps.resumeDelayMs ?? 8000;
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        this.openQueue();
      }, delay);
      this.resumeTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of [this.pumpTimer, this.resumeTimer, this.broadcastTimer]) if (t) clearTimeout(t);
    this.pumpTimer = this.resumeTimer = this.broadcastTimer = null;
    this.unsubBackend?.();
    for (const j of this.inflight.values()) {
      j.cancelled = true;
      j.handle?.cancel();
    }
    await Promise.race([Promise.allSettled([...this.running]), sleep(3000)]);
    this.db?.close();
    this.db = null;
  }

  private async openDb(): Promise<LibraryDb> {
    try {
      return new LibraryDb(this.dbPath);
    } catch (err) {
      const msg = errText(err);
      if (/newer Krypt Studio/.test(msg) || !(err instanceof LibraryDbError)) throw err;
      const aside = `${this.dbPath}.corrupt-${this.now().toString(36)}`;
      this.deps.log('error', `${msg}. Moving it to ${path.basename(aside)} and starting an empty library.`);
      await renameDir(this.dbPath, aside);
      for (const ext of ['-wal', '-shm']) await renameDir(`${this.dbPath}${ext}`, `${aside}${ext}`).catch(() => {});
      return new LibraryDb(this.dbPath);
    }
  }

  private requireDb(): LibraryDb {
    if (this.db) return this.db;
    if (this.stopped) throw new LibraryError('The reference library is shutting down');
    if (!this.started) throw new LibraryError('The reference library is still starting; try again in a moment');
    throw new LibraryError(`The reference library is unavailable: ${this.dbError ?? 'unknown error'}`);
  }

  private async guard<T>(fn: (db: LibraryDb) => Promise<ActionResult<T>> | ActionResult<T>): Promise<ActionResult<T>> {
    try {
      return await fn(this.requireDb());
    } catch (err) {
      if (!(err instanceof LibraryError)) this.deps.log('error', `Reference library: ${errText(err)}`);
      return fail(errText(err));
    }
  }

  state(): LibraryState {
    const db = this.db;
    let collections: Collection[] = [];
    let queue: LibraryQueueState = { running: false, paused: this.paused, phase: null, done: 0, total: 0, current: null, etaSec: null };
    try {
      if (db) {
        collections = db.collections();
        queue = this.queueState(db);
      }
    } catch (err) {
      this.deps.log('warn', `Reference library state: ${errText(err)}`);
    }
    if (!db && this.dbError) queue.message = `The reference library is unavailable: ${this.dbError}`;
    return { collections, queue, focus: this.focus(), dbPath: this.dbPath };
  }

  private stemModel(): { def: ModelDef; dir: string } | null {
    const def = this.deps.backend?.defaultModel('stems');
    const dir = def ? this.deps.backend?.modelDir(def.id) : null;
    return def && dir ? { def, dir } : null;
  }

  private queueState(db: LibraryDb): LibraryQueueState {
    const jobs = [...this.inflight.values()];
    const light = jobs.filter((j) => j.phase === 'light');
    const deep = jobs.filter((j) => j.phase === 'deep');
    const pending = db.pendingCount();
    const deepLeft = db.deepRemaining();
    const phase: LibraryQueueState['phase'] = light.length || pending ? 'light' : deep.length || deepLeft.tracks ? 'deep' : null;
    const done = phase === 'deep' ? this.doneDeep : phase === 'light' ? this.doneLight : 0;
    const remaining = phase === 'light' ? pending : phase === 'deep' ? deepLeft.tracks : 0;
    let etaSec: number | null = null;
    if (jobs.length && !this.paused) {
      if (phase === 'light') {
        const per = this.emaLightSec ?? (this.deps.getSettings().library?.fastScan ? 1.5 : 4);
        etaSec = Math.round((remaining * per) / LIGHT_CONCURRENCY);
      } else if (phase === 'deep') {
        const unknown = Math.max(0, deepLeft.tracks - deepLeft.known);
        const sec = deepLeft.knownSec + unknown * (db.meanDuration() ?? DEFAULT_TRACK_SEC);
        etaSec = Math.round((sec / 60) * this.deepRate());
      }
    }
    const newest = jobs.sort((a, b) => b.startedAt - a.startedAt)[0];
    const q: LibraryQueueState = {
      running: jobs.length > 0 && !this.paused,
      paused: this.paused,
      phase,
      done,
      total: done + remaining,
      current: newest ? newest.name : null,
      etaSec,
    };
    if (this.message && !this.paused && phase) q.message = this.message;
    return q;
  }

  private deepRate(): number {
    if (this.emaDeepSecPerMin) return this.emaDeepSecPerMin;
    return DEEP_SEC_PER_MIN[this.lastDevices.includes('directml') ? 'directml' : 'cpu'];
  }

  notify(throttle = false): void {
    if (!this.deps.broadcast) return;
    const send = (): void => {
      this.broadcastTimer = null;
      this.lastBroadcast = Date.now();
      try {
        this.deps.broadcast?.(this.state());
      } catch {
      }
    };
    if (!throttle) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      send();
      return;
    }
    if (this.broadcastTimer || this.stopped) return;
    this.broadcastTimer = setTimeout(send, Math.max(0, 250 - (Date.now() - this.lastBroadcast)));
    this.broadcastTimer.unref?.();
  }

  private openQueue(): void {
    this.queueOpen = true;
    this.pump();
  }

  private pump(delay = 0): void {
    if (this.stopped || !this.db || !this.queueOpen) return;
    if (this.pumpTimer) {
      if (delay > 0) return;
      clearTimeout(this.pumpTimer);
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.tick();
    }, delay);
    this.pumpTimer.unref?.();
  }

  private launch(p: Promise<void>): void {
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  private tick(): void {
    const db = this.db;
    if (!db || this.stopped || !this.queueOpen) return;
    try {
      if (this.paused) return this.notify();
      const now = this.now();
      if (now < this.backoffUntil) return this.pump(this.backoffUntil - now);
      const be = this.deps.backend;
      const busyLight = [...this.inflight.values()].filter((j) => j.phase === 'light').length;
      const busyDeep = [...this.inflight.values()].filter((j) => j.phase === 'deep').length;
      const pending = db.pendingCount();
      const deepLeft = db.deepRemaining().tracks;
      if (!pending && !deepLeft) {
        this.message = null;
        if (!this.inflight.size) this.doneLight = this.doneDeep = 0;
        return this.notify();
      }
      if (!be || !be.available()) {
        this.message = be ? 'Analysis is waiting for the audio analyzer (krypt-studio-analyzer.exe isn\'t available; see the log).' : 'Audio analysis is not available in this session.';
        this.notify();
        return this.pump(30_000);
      }
      this.message = null;
      const cap = this.solo ? 1 : LIGHT_CONCURRENCY;
      if (pending && busyLight < cap) {
        const skip = new Set(this.inflight.keys());
        for (const row of db.nextPending(cap - busyLight, skip, this.removing)) this.launch(this.runLight(row));
      }
      if (!pending && busyLight === 0 && busyDeep === 0 && deepLeft) {
        const stem = this.stemModel();
        if (!stem) {
          const def = be.defaultModel('stems');
          this.message = `Deep analysis is waiting for a stem model: install ${def?.name ?? 'a stem model'} in Model Manager.`;
          this.pump(30_000);
        } else {
          const [row] = db.nextDeep(1, new Set(this.inflight.keys()), this.removing);
          if (row) this.launch(this.runDeep(row, stem));
        }
      }
      this.notify(true);
    } catch (err) {
      this.deps.log('error', `Reference library queue: ${errText(err)}`);
      this.pump(10_000);
    }
  }

  private begin(row: TrackRow, phase: Inflight['phase']): Inflight {
    const job: Inflight = { id: row.id, phase, name: row.name, collectionId: row.collection_id, handle: null, cancelled: false, startedAt: this.now() };
    this.inflight.set(row.id, job);
    this.notify(true);
    return job;
  }

  private end(job: Inflight): void {
    this.inflight.delete(job.id);
    if (this.stopped) return;
    this.notify(true);
    this.pump();
  }

  private gone(job: Inflight): boolean {
    return this.stopped || job.cancelled || !this.db;
  }

  private onFailure(job: Inflight, gen: number, message: string, deep: boolean): void {
    const db = this.db;
    if (!db) return;
    if (/crashed \d+ times/i.test(message)) {
      this.backoffUntil = this.now() + 30_000;
      this.deps.log('warn', `Library: ${message}`);
      return;
    }
    if (ANALYZER_FAILURE.test(message)) {
      const attempts = db.bumpAttempt(job.id, gen);
      this.solo = true;
      this.backoffUntil = this.now() + (this.deps.retryDelayMs ?? 3000);
      this.deps.log('warn', `Library: the analyzer failed on "${job.name}" (attempt ${attempts} of ${MAX_ATTEMPTS}): ${message}`);
      if (attempts < MAX_ATTEMPTS) return;
      message = `${message} (the analyzer failed ${MAX_ATTEMPTS} times on this file)`;
    }
    if (deep) db.markDeepFailed(job.id, gen, `Deep analysis failed: ${message}`);
    else db.markFailed(job.id, gen, message);
    this.dropVector(job.id);
    this.deps.log('warn', `Library: ${deep ? 'deep analysis of' : 'analysis of'} "${job.name}" failed: ${message}`);
  }

  private async checkSource(job: Inflight, row: TrackRow): Promise<number | null> {
    const st = await statSource(row.path);
    if (this.gone(job)) return null;
    const db = this.db!;
    if (!st) {
      db.markMissing(row.id);
      this.dropVector(row.id);
      this.deps.log('info', `Library: "${row.name}" is missing (${row.path}); it is re-checked on rescan`);
      return null;
    }
    if (st.size !== row.size || st.mtime !== row.mtime) {
      db.requeue(row.id, st);
      this.dropVector(row.id);
      if (row.status === 'pending') return db.track(row.id)?.gen ?? null;
      return null;
    }
    return row.gen;
  }

  private async runLight(row: TrackRow): Promise<void> {
    const job = this.begin(row, 'light');
    try {
      const gen = await this.checkSource(job, row);
      if (gen === null || this.gone(job)) return;
      const cur = this.db!.track(row.id);
      const twin = cur ? this.db!.twinOf(cur) : undefined;
      if (twin && this.db!.copyAnalysis(twin, row.id, gen)) {
        this.doneLight++;
        this.vectors = null;
        return;
      }
      const be = this.deps.backend!;
      const beatDir = this.deps.getSettings().library?.fastScan ? null : be.modelDir(BEAT_MODEL);
      const handle = be.run<'analyze', AudioAnalysis>('analyze', { path: row.path, sections: true, drums: true, ...(beatDir ? { beatModelDir: beatDir } : {}) });
      job.handle = handle as JobHandle<unknown>;
      const started = this.now();
      const out = await handle.done;
      if (this.gone(job) || out.cancelled) return;
      if (!out.ok || !out.data) return this.onFailure(job, gen, out.message ?? 'Analysis failed', false);
      const a = out.data;
      if (!a || typeof a !== 'object' || typeof a.durationSec !== 'number') {
        return this.onFailure(job, gen, 'The analyzer returned an unexpected result (update or rebuild krypt-studio-analyzer)', false);
      }
      let lf: ReturnType<typeof lightFeatures>;
      try {
        lf = lightFeatures({ ...a, path: row.path });
      } catch (err) {
        return this.onFailure(job, gen, `Couldn't derive features from the analysis: ${errText(err)}`, false);
      }
      const ok = this.db!.saveLight(row.id, gen, lf.summary, compactJson(lf.features), lf.vector, VECTOR_VERSION, this.now());
      if (!ok) return;
      this.solo = false;
      this.doneLight++;
      const sec = (this.now() - started) / 1000;
      this.emaLightSec = this.emaLightSec === null ? sec : this.emaLightSec * 0.8 + sec * 0.2;
      if (this.vectors) this.vectors.set(row.id, { collectionId: row.collection_id, vector: lf.vector });
    } catch (err) {
      if (!this.gone(job)) this.deps.log('error', `Library: analysing "${row.name}" failed unexpectedly: ${errText(err)}`);
    } finally {
      this.end(job);
    }
  }

  private async runDeep(row: TrackRow, stem: { def: ModelDef; dir: string }): Promise<void> {
    const job = this.begin(row, 'deep');
    const tmp = path.join(this.tmpDir, `${row.id}-${this.now().toString(36)}`);
    try {
      const gen = await this.checkSource(job, row);
      if (gen === null || this.gone(job)) return;
      const json = this.db!.featuresJson(row.id);
      const feats = json ? parseFeatures(json) : null;
      if (!feats) {
        this.db!.requeue(row.id);
        return;
      }
      const a = feats.analysis;
      const be = this.deps.backend!;
      await makeDir(tmp);
      if (this.gone(job)) return;
      const started = this.now();
      const sepH = be.run<'separate', StemsResult>('separate', { path: row.path, model: stem.def.id, modelDir: stem.dir, outDir: tmp, device: 'auto' });
      job.handle = sepH as JobHandle<unknown>;
      const sep = await sepH.done;
      if (this.gone(job) || sep.cancelled) return;
      if (!sep.ok || !sep.data || !Array.isArray(sep.data.stems)) return this.onFailure(job, gen, `stem separation: ${sep.message ?? 'no stems were produced'}`, true);

      const bpDef = be.defaultModel('transcribe');
      const bpDir = bpDef ? be.modelDir(bpDef.id) : null;
      const lines: TrackFeatures['lines'] = {};
      let drums = feats.drums;
      let done = 0;
      const failures: string[] = [];
      for (const s of sep.data.stems) {
        const quiet = s.name === 'vocals' ? VOCAL_SILENCE_DB : STEM_SILENCE_DB;
        if (typeof s.rmsDb === 'number' && Number.isFinite(s.rmsDb) && s.rmsDb < quiet) continue;
        let args: Omit<TranscribeArgs, 'path'> | null = null;
        if (s.name === 'drums') args = { mode: 'drums' };
        else if (s.name === 'bass') args = { mode: 'mono', minKey: 21, maxKey: 72 };
        else if (s.name === 'vocals') args = { mode: 'mono' };
        else if (bpDir) args = { mode: 'poly', modelDir: bpDir };
        if (!args) continue;
        const stemPath = path.join(tmp, path.basename(String(s.path)));
        const h = be.run<'transcribe', TranscriptionResult>('transcribe', { path: stemPath, ...args });
        job.handle = h as JobHandle<unknown>;
        const r = await h.done;
        if (this.gone(job) || r.cancelled) return;
        if (!r.ok || !r.data) {
          if (ANALYZER_FAILURE.test(r.message ?? '')) return this.onFailure(job, gen, r.message ?? 'transcription failed', true);
          failures.push(`${s.name}: ${r.message ?? 'transcription failed'}`);
          continue;
        }
        done++;
        if (args.mode === 'drums') {
          const g = drumGrid(a, Array.isArray(r.data.hits) ? r.data.hits : [], 'stem');
          if (g) drums = g;
        } else {
          const notes: BeatNote[] = notesToBeats(a, Array.isArray(r.data.notes) ? r.data.notes : []);
          if (notes.length) lines[s.name] = notes;
        }
      }
      if (!done && failures.length) return this.onFailure(job, gen, `transcription: ${failures.join('; ')}`, true);
      const vector = featureVector(a, drums);
      const lh = linesHashes(lines);
      const next: Omit<TrackFeatures, 'vector'> = { analysis: a, drums, chords: feats.chords, lines };
      if (!this.db!.saveDeep(row.id, gen, compactJson(next), vector, VECTOR_VERSION, lh.hashes, lh.lines, this.now())) return;
      this.doneDeep++;
      const minutes = Math.max(0.1, (a.durationSec || DEFAULT_TRACK_SEC) / 60);
      const rate = (this.now() - started) / 1000 / minutes;
      this.emaDeepSecPerMin = this.emaDeepSecPerMin === null ? rate : this.emaDeepSecPerMin * 0.7 + rate * 0.3;
      if (this.vectors) this.vectors.set(row.id, { collectionId: row.collection_id, vector });
      if (failures.length) this.deps.log('warn', `Library: deep analysis of "${row.name}" skipped ${failures.join('; ')}`);
    } catch (err) {
      if (!this.gone(job)) {
        this.deps.log('error', `Library: deep analysis of "${row.name}" failed unexpectedly: ${errText(err)}`);
        try {
          this.db?.markDeepFailed(row.id, row.gen, `Deep analysis failed: ${errText(err)}`);
        } catch {
        }
      }
    } finally {
      await removeDir(tmp).catch((err) => this.deps.log('warn', `Library: couldn't delete temporary stems ${tmp}: ${errText(err)}`));
      this.end(job);
    }
  }

  private cancelWhere(pred: (j: Inflight) => boolean): number {
    let n = 0;
    for (const j of this.inflight.values()) {
      if (!pred(j)) continue;
      j.cancelled = true;
      j.handle?.cancel();
      n++;
    }
    return n;
  }

  setPaused(paused: boolean): Promise<ActionResult> {
    return this.guard((db) => {
      this.paused = !!paused;
      db.setMeta('paused', this.paused ? '1' : null);
      if (this.paused) {
        const n = this.cancelWhere(() => true);
        this.notify();
        return { ok: true, message: `Library analysis paused${n ? ` (${plural(n, 'running job')} stopped; ${n === 1 ? 'it runs' : 'they run'} again on resume)` : ''}. It stays paused after a restart.` };
      }
      this.openQueue();
      this.notify();
      const left = db.pendingCount() + db.deepRemaining().tracks;
      return { ok: true, message: left ? `Library analysis resumed: ${plural(left, 'track')} to go.` : 'Library analysis resumed (nothing is waiting).' };
    });
  }

  private cleanName(name: unknown): string {
    const n = String(name ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 64);
    if (!n) throw new LibraryError('Give the collection a name');
    return n;
  }

  private cleanTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const out: string[] = [];
    for (const t of tags) {
      const s = String(t ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 32);
      if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    }
    return out.slice(0, 16);
  }

  private nameTaken(db: LibraryDb, name: string, except?: string): boolean {
    return db.collectionRows().some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase());
  }

  findCollection(ref: string): Collection | null {
    const db = this.db;
    if (!db) return null;
    const r = String(ref ?? '').trim();
    if (!r) return null;
    const byId = db.collection(r);
    if (byId) return byId;
    const all = db.collections();
    return all.find((c) => c.name.toLowerCase() === r.toLowerCase()) ?? all.find((c) => c.name.toLowerCase().includes(r.toLowerCase())) ?? null;
  }

  collections(): Collection[] {
    try {
      return this.db?.collections() ?? [];
    } catch {
      return [];
    }
  }

  createCollection(name: string, tags?: string[]): Promise<ActionResult<Collection>> {
    return this.guard((db) => {
      const n = this.cleanName(name);
      if (this.nameTaken(db, n)) return fail(`A collection named "${n}" already exists`);
      const id = newId('lc_');
      db.insertCollection({ id, name: n, tags: this.cleanTags(tags), createdAt: this.now() });
      this.notify();
      return { ok: true, message: `Created the collection "${n}". Add a folder of your own songs to it.`, data: db.collection(id)! };
    });
  }

  updateCollection(id: string, patch: { name?: string; tags?: string[] }): Promise<ActionResult<Collection>> {
    return this.guard((db) => {
      const c = db.collection(String(id));
      if (!c) return fail('That collection no longer exists');
      const p = patch && typeof patch === 'object' ? patch : {};
      const upd: { name?: string; tags?: string[] } = {};
      if (p.name !== undefined) {
        upd.name = this.cleanName(p.name);
        if (this.nameTaken(db, upd.name, c.id)) return fail(`A collection named "${upd.name}" already exists`);
      }
      if (p.tags !== undefined) upd.tags = this.cleanTags(p.tags);
      db.updateCollection(c.id, upd);
      const f = this.focus();
      if (upd.name && f?.collectionId === c.id) this.writeFocus({ ...f, name: upd.name });
      this.profiles.delete(c.id);
      this.notify();
      return { ok: true, message: upd.name && upd.name !== c.name ? `Renamed "${c.name}" to "${upd.name}"` : `Updated "${c.name}"`, data: db.collection(c.id)! };
    });
  }

  removeCollection(id: string): Promise<ActionResult> {
    return this.guard(async (db) => {
      const c = db.collection(String(id));
      if (!c) return fail('That collection no longer exists');
      this.removing.add(c.id);
      try {
        this.cancelWhere((j) => j.collectionId === c.id);
        let removed = 0;
        for (;;) {
          if (!this.db) throw new LibraryError('The reference library closed while removing the collection');
          const ids = this.db.trackIdsOf(c.id, 500);
          if (!ids.length) break;
          removed += this.db.deleteTracks(ids);
          await yieldNow();
        }
        this.requireDb().deleteCollection(c.id);
        this.profiles.delete(c.id);
        this.vectors = null;
        if (this.deps.getSettings().library?.focus?.collectionId === c.id) this.writeFocus(null);
        this.notify();
        return { ok: true, message: `Removed "${c.name}" from the library (${plural(removed, 'track record')}; your files were not touched).` };
      } finally {
        this.removing.delete(c.id);
      }
    });
  }

  setDeep(collectionId: string, deep: boolean): Promise<ActionResult<{ queued: number }>> {
    return this.guard((db) => {
      const c = db.collection(String(collectionId));
      if (!c) return fail('That collection no longer exists');
      if (!deep) {
        db.updateCollection(c.id, { deep: false });
        const n = this.cancelWhere((j) => j.phase === 'deep' && j.collectionId === c.id);
        this.notify();
        this.pump();
        return { ok: true, message: `Deep analysis off for "${c.name}"${n ? ' (the running job was stopped)' : ''}. Tracks already analysed in depth keep their data.`, data: { queued: 0 } };
      }
      const stem = this.stemModel();
      if (!stem) {
        const def = this.deps.backend?.defaultModel('stems');
        return fail(`Deep analysis needs a stem model: install ${def?.name ?? 'a stem model'} in Model Manager first.`);
      }
      db.updateCollection(c.id, { deep: true });
      db.clearDeepFailures(c.id);
      const left = db.deepCandidates(c.id);
      const est = this.estimateFor(db, left);
      this.openQueue();
      this.notify();
      return {
        ok: true,
        message: left.tracks
          ? `Deep analysis on for "${c.name}": ${plural(left.tracks, 'track')} queued, about ${fmtDuration(est.seconds)} on the ${est.device === 'directml' ? 'GPU (DirectML)' : 'CPU'}. It runs after the light pass, one track at a time; temporary stems are deleted after each track.`
          : `Deep analysis on for "${c.name}": every track is already analysed in depth.`,
        data: { queued: left.tracks },
      };
    });
  }

  private estimateFor(db: LibraryDb, left: { tracks: number; knownSec: number; known: number }, device?: AnalyzerDevice): { seconds: number; device: AnalyzerDevice } {
    const dev: AnalyzerDevice = device ?? (this.lastDevices.includes('directml') ? 'directml' : 'cpu');
    const unknown = Math.max(0, left.tracks - left.known);
    const audioSec = left.knownSec + unknown * (db.meanDuration() ?? DEFAULT_TRACK_SEC);
    const rate = this.emaDeepSecPerMin ?? DEEP_SEC_PER_MIN[dev];
    return { seconds: Math.round((audioSec / 60) * rate), device: dev };
  }

  estimateDeep(collectionId: string): Promise<ActionResult<{ tracks: number; seconds: number; device: AnalyzerDevice }>> {
    return this.guard(async (db) => {
      const c = db.collection(String(collectionId));
      if (!c) return fail('That collection no longer exists');
      let devices = this.deps.backend?.status().devices ?? [];
      if (!devices.length) devices = this.lastDevices;
      const be = this.deps.backend;
      if (!devices.length && be?.available() && be.ensureStarted) {
        const r = await Promise.race([be.ensureStarted(), sleep(20_000).then(() => null)]);
        if (r?.ok && r.data) devices = r.data.devices;
      }
      const device: AnalyzerDevice = devices.includes('directml') ? 'directml' : 'cpu';
      const left = this.requireDb().deepCandidates(c.id);
      const est = this.estimateFor(this.requireDb(), left, device);
      return {
        ok: true,
        message: `Deep analysis of ${plural(left.tracks, 'track')} in "${c.name}" would take about ${fmtDuration(est.seconds)} on ${device === 'directml' ? 'the GPU (DirectML)' : 'the CPU'}.`,
        data: { tracks: left.tracks, seconds: est.seconds, device },
      };
    });
  }

  private queueNote(): string {
    if (this.paused) return ' The analysis queue is paused; resume it to analyse them.';
    const be = this.deps.backend;
    if (!be) return ' Audio analysis is not available in this session, so they wait.';
    if (!be.available()) return " They're analysed once the audio analyzer (krypt-studio-analyzer.exe) is available.";
    return ' Analysis runs in the background.';
  }

  private async insertFiles(collectionId: string, files: Array<{ path: string; size: number; mtime: number }>): Promise<{ added: number; skipped: number }> {
    let added = 0;
    let skipped = 0;
    for (let i = 0; i < files.length; i += 500) {
      const db = this.requireDb();
      const r = db.insertTracks(
        collectionId,
        files.slice(i, i + 500).map((f) => ({ id: newId('lt_'), path: f.path, name: fileName(f.path), size: f.size, mtime: f.mtime })),
        this.now(),
      );
      added += r.added;
      skipped += r.skipped;
      if (i + 500 < files.length) await yieldNow();
    }
    return { added, skipped };
  }

  addFolder(collectionId: string, folder?: string): Promise<ActionResult<{ added: number; skipped: number }>> {
    return this.guard(async (db) => {
      const c = db.collection(String(collectionId));
      if (!c) return fail('That collection no longer exists');
      let dir = typeof folder === 'string' ? folder.trim() : '';
      if (!dir) {
        const picked = await this.deps.pickFolder?.(`Add a folder of your own songs to "${c.name}"`);
        if (!picked) return fail('Import cancelled');
        dir = picked;
      }
      if (!path.isAbsolute(dir)) return fail(`"${dir}" is not an absolute folder path`);
      dir = path.resolve(dir);
      if (!(await isDirectory(dir))) return fail(`Folder not found: ${dir}`);
      const walked = await walkFiles(dir, isLibraryAudio);
      if (!walked.files.length) {
        return fail(`No audio files in ${dir}${walked.unreadable ? ` (${plural(walked.unreadable, 'folder')} couldn't be read)` : ''}. The library imports ${LIBRARY_AUDIO_EXTENSIONS.filter((e) => !['wave', 'oga'].includes(e)).join(', ')}.`);
      }
      const r = await this.insertFiles(c.id, walked.files);
      const db2 = this.requireDb();
      const cur = db2.collection(c.id);
      if (!cur) return fail('The collection was removed during the import');
      if (!cur.folders.some((f) => pathKey(f) === pathKey(dir))) db2.updateCollection(c.id, { folders: [...cur.folders, dir] });
      this.openQueue();
      this.notify();
      const extra = [walked.truncated ? ` Stopped at ${walked.files.length} files (the per-import limit).` : '', walked.unreadable ? ` ${plural(walked.unreadable, 'subfolder')} couldn't be read.` : ''].join('');
      return {
        ok: true,
        message: `${r.added ? `Added ${plural(r.added, 'track')} to "${c.name}"` : `Nothing new in ${path.basename(dir)}`}${r.skipped ? ` (${r.skipped} already there)` : ''}.${r.added ? this.queueNote() : ''}${extra}`,
        data: r,
      };
    });
  }

  addFiles(collectionId: string, paths?: string[]): Promise<ActionResult<{ added: number; skipped: number }>> {
    return this.guard(async (db) => {
      const c = db.collection(String(collectionId));
      if (!c) return fail('That collection no longer exists');
      let list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim()) : [];
      if (!list.length) {
        const picked = await this.deps.pickFiles?.(`Add your own songs to "${c.name}"`, LIBRARY_AUDIO_EXTENSIONS);
        if (!picked?.length) return fail('Import cancelled');
        list = picked;
      }
      const files: Array<{ path: string; size: number; mtime: number }> = [];
      let notAudio = 0;
      let missing = 0;
      for (let i = 0; i < list.length; i += 32) {
        const stats = await Promise.all(
          list.slice(i, i + 32).map(async (p) => {
            if (!path.isAbsolute(p) || !isLibraryAudio(p)) return { p, st: null, audio: false };
            return { p: path.resolve(p), st: await statSource(p), audio: true };
          }),
        );
        for (const s of stats) {
          if (!s.audio) notAudio++;
          else if (!s.st) missing++;
          else files.push({ path: s.p, size: s.st.size, mtime: s.st.mtime });
        }
      }
      if (!files.length) return fail(notAudio ? `None of those are audio files the library can import (${LIBRARY_AUDIO_EXTENSIONS.join(', ')})` : 'Those files no longer exist');
      const r = await this.insertFiles(c.id, files);
      this.openQueue();
      this.notify();
      const skippedNote = [notAudio ? `${notAudio} not audio` : '', missing ? `${missing} not found` : '', r.skipped ? `${r.skipped} already there` : ''].filter(Boolean).join(', ');
      return {
        ok: true,
        message: `${r.added ? `Added ${plural(r.added, 'track')} to "${c.name}"` : 'Nothing new was added'}${skippedNote ? ` (${skippedNote})` : ''}.${r.added ? this.queueNote() : ''}`,
        data: { added: r.added, skipped: r.skipped + notAudio + missing },
      };
    });
  }

  removeTracks(ids: string[]): Promise<ActionResult> {
    return this.guard(async () => {
      const list = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x))] : [];
      if (!list.length) return fail('No tracks selected');
      const set = new Set(list);
      this.cancelWhere((j) => set.has(j.id));
      let removed = 0;
      for (let i = 0; i < list.length; i += 500) {
        removed += this.requireDb().deleteTracks(list.slice(i, i + 500));
        if (i + 500 < list.length) await yieldNow();
      }
      for (const id of list) this.vectors?.delete(id);
      this.notify();
      if (!removed) return fail('Those tracks were already removed');
      return { ok: true, message: `Removed ${plural(removed, 'track')} from the library (records only; your files were not touched).` };
    });
  }

  rescan(collectionId: string): Promise<ActionResult<{ added: number; changed: number; missing: number }>> {
    return this.guard(async (db) => {
      const c = db.collection(String(collectionId));
      if (!c) return fail('That collection no longer exists');
      const found = new Map<string, { path: string; size: number; mtime: number }>();
      let unreadable = 0;
      const goneFolders: string[] = [];
      for (const f of c.folders) {
        if (!(await isDirectory(f))) {
          goneFolders.push(f);
          continue;
        }
        const w = await walkFiles(f, isLibraryAudio);
        unreadable += w.unreadable;
        for (const x of w.files) found.set(pathKey(x.path), x);
      }
      let changed = 0;
      let missing = 0;
      let restored = 0;
      const rows = this.requireDb().scanRows(c.id);
      const known = new Set(rows.map((r) => r.path_key));
      for (let i = 0; i < rows.length; i += 32) {
        const chunk = rows.slice(i, i + 32);
        const stats = await Promise.all(chunk.map(async (r) => found.get(r.path_key) ?? (await statSource(r.path))));
        const d = this.requireDb();
        chunk.forEach((r, k) => {
          const st = stats[k];
          if (!st) {
            if (r.status !== 'missing') {
              d.markMissing(r.id);
              this.cancelWhere((j) => j.id === r.id);
              this.vectors?.delete(r.id);
              missing++;
            }
            return;
          }
          const same = st.size === r.size && st.mtime === r.mtime;
          if (r.status === 'missing' && same) {
            d.restore(r.id);
            this.vectors = null;
            restored++;
          } else if (!same) {
            this.cancelWhere((j) => j.id === r.id);
            d.requeue(r.id, { size: st.size, mtime: st.mtime });
            this.vectors?.delete(r.id);
            changed++;
          }
        });
        await yieldNow();
      }
      const fresh = [...found.entries()].filter(([k]) => !known.has(k)).map(([, v]) => v);
      const r = fresh.length ? await this.insertFiles(c.id, fresh) : { added: 0, skipped: 0 };
      this.openQueue();
      this.notify();
      const parts = [plural(r.added, 'new track'), `${changed} changed`, `${missing} missing`];
      if (restored) parts.push(`${restored} back`);
      const notes = [goneFolders.length ? ` ${plural(goneFolders.length, 'folder')} no longer exist${goneFolders.length === 1 ? 's' : ''}: ${goneFolders.join(', ')}.` : '', unreadable ? ` ${plural(unreadable, 'subfolder')} couldn't be read.` : ''].join('');
      return {
        ok: true,
        message: `Rescanned "${c.name}": ${parts.join(', ')}.${r.added || changed ? ' New and changed files are queued for analysis.' : ''}${notes}`,
        data: { added: r.added, changed, missing },
      };
    });
  }

  retryFailed(collectionId?: string): Promise<ActionResult<{ queued: number }>> {
    return this.guard((db) => {
      if (collectionId && !db.collection(String(collectionId))) return fail('That collection no longer exists');
      const n = db.retryFailed(collectionId ? String(collectionId) : undefined);
      this.openQueue();
      this.notify();
      return { ok: true, message: n ? `Re-queued ${plural(n, 'failed track')}.` : 'No failed tracks to retry.', data: { queued: n } };
    });
  }

  query(q: TrackQuery): Promise<ActionResult<{ tracks: LibraryTrack[]; total: number }>> {
    return this.guard((db) => {
      const o = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
      const numv = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const sorts = ['name', 'bpm', 'key', 'added', 'lufs', 'duration'];
      const statuses: TrackStatus[] = ['pending', 'light', 'deep', 'failed', 'missing'];
      const clean: TrackQuery = {
        collectionId: str(o.collectionId),
        text: str(o.text),
        bpmMin: numv(o.bpmMin),
        bpmMax: numv(o.bpmMax),
        key: str(o.key),
        status: statuses.includes(o.status as TrackStatus) ? (o.status as TrackStatus) : undefined,
        sort: sorts.includes(String(o.sort)) ? (o.sort as TrackQuery['sort']) : 'name',
        desc: o.desc === true,
        offset: numv(o.offset),
        limit: numv(o.limit),
      };
      const r = db.query(clean);
      return { ok: true, data: { tracks: r.rows.map(rowToTrack), total: r.total } };
    });
  }

  track(id: string): Promise<ActionResult<TrackDetail>> {
    return this.guard((db) => {
      const row = db.track(String(id));
      if (!row) return fail('That track is no longer in the library');
      const json = db.featuresJson(row.id);
      const features = json ? parseFeatures(json, db.vectorOf(row.id) ?? []) : null;
      return { ok: true, data: { ...rowToTrack(row), features } };
    });
  }

  profile(collectionId: string): Promise<ActionResult<StyleProfile>> {
    return this.guard(async (db) => {
      const row = db.collectionRow(String(collectionId));
      if (!row) return fail('That collection no longer exists');
      const p = await this.buildOrCached(row.id);
      return { ok: true, message: `Style profile of "${p.name}" from ${plural(p.analysed, 'analysed track')}${p.deep ? ` (${p.deep} in depth)` : ''}.`, data: p };
    });
  }

  private async buildOrCached(collectionId: string): Promise<StyleProfile> {
    const db = this.requireDb();
    const row = db.collectionRow(collectionId);
    if (!row) throw new LibraryError('That collection no longer exists');
    const mem = this.profiles.get(row.id);
    if (mem && mem.rev === row.rev && mem.profile.name === row.name) return mem.profile;
    const stored = db.profileRow(row.id);
    if (stored && stored.rev === row.rev) {
      try {
        const p = JSON.parse(stored.json) as StyleProfile;
        if (p && p.collectionId === row.id) {
          p.name = row.name;
          this.profiles.set(row.id, { rev: row.rev, profile: p });
          return p;
        }
      } catch {
      }
    }
    const key = `${row.id}:${row.rev}`;
    const running = this.building.get(key);
    if (running) return running;
    const p = this.buildProfileNow(row.id, row.name, row.rev).finally(() => this.building.delete(key));
    this.building.set(key, p);
    return p;
  }

  private async buildProfileNow(collectionId: string, name: string, rev: number): Promise<StyleProfile> {
    const inputs: ProfileInput[] = [];
    let after = 0;
    for (;;) {
      const page = this.requireDb().featurePage(collectionId, after, PAGE);
      if (!page.length) break;
      for (const r of page) {
        after = r.rowid;
        const features = parseFeatures(r.json, r.vector);
        if (features) inputs.push({ track: rowToTrack(r), features });
      }
      await yieldNow();
    }
    const profile = buildProfile({ id: collectionId, name }, inputs, { now: this.now() });
    try {
      this.requireDb().putProfile(collectionId, rev, JSON.stringify(profile), this.now());
    } catch (err) {
      this.deps.log('warn', `Library: couldn't cache the profile of "${name}": ${errText(err)}`);
    }
    this.profiles.set(collectionId, { rev, profile });
    return profile;
  }

  async profileText(ref?: string, opts: { brief?: string; maxChars?: number } = {}): Promise<ActionResult<{ text: string; collection: Collection; profile: StyleProfile }>> {
    return this.guard(async () => {
      const focus = this.focus();
      const c = ref ? this.findCollection(ref) : focus ? this.findCollection(focus.collectionId) : null;
      if (!c) {
        const names = this.collections().map((x) => `"${x.name}"`);
        if (ref) return fail(`No collection "${ref}" in the reference library.${names.length ? ` Collections: ${names.join(', ')}.` : ' The library is empty.'}`);
        return fail(`No style focus is set.${names.length ? ` Name a collection (${names.join(', ')}), or ask the user to set a focus.` : ' The reference library is empty: the user imports their own songs in the Library panel.'}`);
      }
      const profile = await this.buildOrCached(c.id);
      const brief = opts.brief ?? (focus?.collectionId === c.id ? focus.brief : undefined);
      const text = profileText(profile, { brief: brief || undefined, maxChars: opts.maxChars });
      return { ok: true, data: { text, collection: c, profile } };
    });
  }

  private async loadVectors(): Promise<Map<string, { collectionId: string; vector: number[] }>> {
    if (this.vectors) return this.vectors;
    const map = new Map<string, { collectionId: string; vector: number[] }>();
    let after = 0;
    for (;;) {
      const page = this.requireDb().vectorPage(after, 500);
      if (!page.length) break;
      for (const r of page) {
        after = r.rowid;
        map.set(r.id, { collectionId: r.collection_id, vector: parseVector(r.vector) });
      }
      await yieldNow();
    }
    this.vectors = map;
    return map;
  }

  private dropVector(id: string): void {
    this.vectors?.delete(id);
  }

  similar(trackId: string, opts: { collectionId?: string; limit?: number } = {}): Promise<ActionResult<Array<{ track: LibraryTrack; score: number }>>> {
    return this.guard(async (db) => {
      const row = db.track(String(trackId));
      if (!row) return fail('That track is no longer in the library');
      if (row.status !== 'light' && row.status !== 'deep') return fail(`"${row.name}" isn't analysed yet (${row.status})`);
      const all = await this.loadVectors();
      const target = all.get(row.id)?.vector ?? this.requireDb().vectorOf(row.id);
      if (!target?.length) return fail(`"${row.name}" has no feature vector yet`);
      const coll = typeof opts?.collectionId === 'string' && opts.collectionId ? opts.collectionId : null;
      const limit = Math.max(1, Math.min(100, Math.round(opts?.limit ?? 10)));
      const items: Array<{ id: string; vector: number[] }> = [];
      for (const [id, v] of all) if (id !== row.id && (!coll || v.collectionId === coll)) items.push({ id, vector: v.vector });
      const near = nearest(target, items, limit);
      const rows = new Map(this.requireDb().tracksByIds(near.map((n) => n.id)).map((r) => [r.id, r]));
      const data = near.filter((n) => rows.has(n.id)).map((n) => ({ track: rowToTrack(rows.get(n.id)!), score: n.score }));
      return { ok: true, message: `${plural(data.length, 'track')} that sound most like "${row.name}" (feature similarity, an estimate).`, data };
    });
  }

  private async refreshVectors(): Promise<void> {
    let fixed = 0;
    try {
      for (;;) {
        if (this.stopped || !this.db) return;
        const rows = this.db.staleVectors(VECTOR_VERSION, 100);
        if (!rows.length) break;
        for (const r of rows) {
          const f = parseFeatures(r.json);
          let v: number[] = [];
          try {
            if (f) v = featureVector(f.analysis, f.drums);
          } catch {
            v = [];
          }
          this.db.setVector(r.track_id, v, VECTOR_VERSION);
          fixed++;
        }
        await yieldNow();
      }
      if (fixed) {
        this.vectors = null;
        this.deps.log('info', `Library: recomputed ${plural(fixed, 'similarity vector')} for this version`);
      }
    } catch (err) {
      this.deps.log('warn', `Library: couldn't refresh similarity vectors: ${errText(err)}`);
    }
  }

  checkOriginality(opts: { patternId?: string; patternIds?: string[] } = {}): Promise<ActionResult<OriginalityReport>> {
    return this.guard(async (db) => {
      const p = this.deps.doc.project;
      let lines: ProjectLine[] = projectLines(p);
      if (opts?.patternId) {
        if (!p.patterns[opts.patternId]) return fail('That pattern no longer exists');
        lines = lines.filter((l) => l.patternId === opts.patternId);
      } else if (Array.isArray(opts?.patternIds)) {
        const set = new Set(opts.patternIds);
        lines = lines.filter((l) => set.has(l.patternId));
      }
      const references = db.referenceCount();
      const matches: OriginalityMatch[] = [];
      if (references > 0) {
        const featCache = new Map<string, { row: TrackRow; f: TrackFeatures } | null>();
        const load = (trackId: string) => {
          if (!featCache.has(trackId)) {
            const row = this.requireDb().track(trackId);
            const json = row ? this.requireDb().featuresJson(trackId) : null;
            const f = json ? parseFeatures(json) : null;
            featCache.set(trackId, row && f ? { row, f } : null);
          }
          return featCache.get(trackId) ?? null;
        };
        for (const line of lines) {
          const hashes = lineHashes(line.notes.map((n) => ({ start: n.tick / PPQ, dur: n.dur / PPQ, key: n.key }))).map((h) => h.hash);
          if (!hashes.length) continue;
          const refs: ReferenceLine[] = [];
          for (const cand of this.requireDb().hashCandidates(hashes, 24)) {
            const x = load(cand.track_id);
            const notes = x?.f.lines[cand.stem];
            if (!x || !notes?.length) continue;
            const a = x.f.analysis;
            refs.push({
              trackId: x.row.id,
              trackName: x.row.name,
              stem: cand.stem,
              notes,
              bpm: x.row.bpm ?? a.tempo?.bpm ?? 120,
              downbeatSec: a.beats?.downbeats?.[0] ?? a.beats?.times?.[0] ?? 0,
            });
          }
          if (refs.length) matches.push(...findMatches(line, refs));
          await yieldNow();
        }
      }
      matches.sort((x, y) => y.notes - x.notes || y.similarity - x.similarity);
      const base = { checkedLines: lines.length, references, matches };
      return { ok: true, data: { ...base, summary: originalitySummary(base) } };
    });
  }

  async originalityForFocus(patternIds: string[]): Promise<OriginalityReport | null> {
    const f = this.focus();
    if (!f || !this.db || !patternIds.length) return null;
    if (this.db.deepTrackCount(f.collectionId) === 0) return null;
    const r = await this.checkOriginality({ patternIds });
    return r.ok && r.data ? r.data : null;
  }

  focus(): LibraryFocus | null {
    const f = this.deps.getSettings().library?.focus ?? null;
    if (!f) return null;
    if (this.db) {
      try {
        const row = this.db.collectionRow(f.collectionId);
        if (!row) return null;
        if (row.name !== f.name) return { ...f, name: row.name };
      } catch {
      }
    }
    return f;
  }

  private writeFocus(focus: LibraryFocus | null): void {
    const s = this.deps.getSettings();
    this.deps.updateSettings({ library: { fastScan: s.library?.fastScan ?? false, focus } });
  }

  private validateFocus(): void {
    const f = this.deps.getSettings().library?.focus;
    if (!f || !this.db) return;
    try {
      if (!this.db.collectionRow(f.collectionId)) {
        this.writeFocus(null);
        this.deps.log('info', `Library: cleared the style focus ("${f.name}" no longer exists)`);
      }
    } catch {
    }
  }

  setFocus(focus: { collectionId: string; brief?: string } | null): Promise<ActionResult<LibraryFocus | null>> {
    return this.guard((db) => {
      if (!focus) {
        const had = this.focus();
        this.writeFocus(null);
        this.notify();
        return { ok: true, message: had ? `Focus cleared: the AI no longer leans on "${had.name}".` : 'No focus was set.', data: null };
      }
      const c = db.collection(String(focus.collectionId ?? ''));
      if (!c) return fail('That collection no longer exists');
      const brief = String(focus.brief ?? '')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 500);
      const f: LibraryFocus = { collectionId: c.id, name: c.name, brief };
      this.writeFocus(f);
      this.notify();
      const analysed = c.counts.light + c.counts.deep;
      const note = analysed ? '' : c.counts.pending ? ` Its ${plural(c.counts.pending, 'track')} ${c.counts.pending === 1 ? 'is' : 'are'} still being analysed, so the profile fills in as they finish.` : ' It has no analysed tracks yet, so the profile is empty.';
      return { ok: true, message: `Focus: "${c.name}". The AI composes original music from its style profile${brief ? ` with your brief "${brief}"` : ''}.${note}`, data: f };
    });
  }

  async focusContext(): Promise<{ key: string; text: string } | null> {
    try {
      const f = this.focus();
      if (!f || !this.db) return null;
      const row = this.db.collectionRow(f.collectionId);
      if (!row) return null;
      const r = await this.profileText(f.collectionId, { brief: f.brief });
      if (!r.ok || !r.data) return null;
      return { key: `${f.collectionId}|${row.rev}|${f.brief}`, text: r.data.text };
    } catch (err) {
      this.deps.log('warn', `Library: couldn't prepare the focus profile for the agent: ${errText(err)}`);
      return null;
    }
  }

  addToProject(trackId: string): Promise<ActionResult<{ clipId: string; channelId: string }>> {
    return this.guard(async (db) => {
      const row = db.track(String(trackId));
      if (!row) return fail('That track is no longer in the library');
      const st = await statSource(row.path);
      if (!st) return fail(`The file is missing: ${row.path}. Rescan the collection after moving it back.`);
      let info: { frames?: number; sampleRate?: number; channels?: number } = {};
      const si = this.deps.sampleInfo ? await this.deps.sampleInfo(row.path).catch((e) => fail<SampleInfo>(errText(e))) : null;
      if (si?.ok && si.data) info = { frames: si.data.frames, sampleRate: si.data.sampleRate, channels: si.data.channels };
      else if (!ENGINE_AUDIO.test(row.path)) {
        return fail(`Krypt Studio's audio engine can't play ${path.extname(row.path).slice(1).toUpperCase()} files yet${si?.message ? ` (${si.message})` : ''}. Convert "${row.name}" to WAV or FLAC to put it on the playlist.`);
      } else {
        const json = this.requireDb().featuresJson(row.id);
        const a = json ? parseFeatures(json)?.analysis : null;
        if (a && a.sampleRate > 0 && a.durationSec > 0) info = { frames: Math.round(a.durationSec * a.sampleRate), sampleRate: a.sampleRate, channels: a.channels };
      }
      const doc = this.deps.doc;
      const groupId = doc.beginGroup(USER, `Add reference "${row.name}"`);
      let out: { clipId: string; channelId: string };
      try {
        const t = doc.exec<{ id: string }>('playlist.addTrack', { name: row.name.slice(0, 64) }, { actor: USER, groupId });
        if (!t.ok || !t.data) throw new Error(t.message ?? "Couldn't add a playlist track");
        const a = doc.exec<{ clipId: string; channelId: string }>('playlist.addAudio', { path: row.path, name: row.name, trackId: t.data.id, start: 0, ...info }, { actor: USER, groupId });
        if (!a.ok || !a.data) throw new Error(a.message ?? "Couldn't add the audio clip");
        out = { clipId: a.data.clipId, channelId: a.data.channelId };
      } catch (err) {
        doc.endGroup(groupId);
        const entry = doc.getHistory().find((h) => h.groupId === groupId && !h.undone);
        if (entry) doc.toggleEntry(entry.id, USER);
        return fail(`Couldn't add "${row.name}" to the project: ${errText(err)}`);
      }
      doc.endGroup(groupId);
      return { ok: true, message: `Added "${row.name}" to the playlist on a new track at bar 1 (one undo step).`, data: out };
    });
  }
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 48) return `${h} h${mm ? ` ${mm} min` : ''}`;
  return `${Math.round(h / 24)} days`;
}
