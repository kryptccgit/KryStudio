// ──────────────────────────────────────────────────────────────────────
// AnalyzerService: "Ears" for both the UI (IPC, actor = user) and agents
// (MCP tools, actor = the agent, inside the call's undo group).
//
//   analyze(target)         tempo / beats / key / swing / sections / loudness
//                           cache: userData/analysis/<key>.json
//   separateStems(clip)     stems (installed model only) → audio.addStems
//                           cache: userData/stems/<key>-<model>/
//   toPattern(target, mode) transcription → audio.addTranscription
//                           cache: userData/analysis/<key>-notes-<mode>.json
//
// <key> = SampleRef.hash when present, else a hash of the absolute path +
// size + mtime. A cache hit never starts the analyzer. Results enter the
// project through ONE command each (one undo step, all-or-nothing). Jobs
// are listed in AnalyzerState with progress and can be cancelled.
// Node-only (no Electron import): tests drive it with a fake analyzer.
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { USER, type DocHost } from '@shared/doc/DocHost';
import type { Channel, Clip, SampleRef } from '@shared/schema/project';
import type { AudioAnalysis, ExtractResult, StemName, StemsResult, TranscribeMode, TranscriptionResult } from '@shared/analyzer/protocol';
import type { ModelDef } from '@shared/analyzer/models';
import type { SoundFingerprint } from '@shared/sound-match/types';
import type { SampleInfo } from '@shared/engine/protocol';
import type { ActionResult, AnalyzerJobInfo, AnalyzerState, AudioTarget, ModelState, StemsOutcome, ToPatternOutcome } from '@shared/types';
import { writeFileAtomic } from '../system/files';
import { dirExists, listDir, makeDir, readJson, removeDir, renameDir, sha256Text, statFile } from '../system/download';
import { SYNTH_PRESETS } from '../mcp/tools/instruments';
import type { AnalyzerSupervisor, AnalyzerJobArgs, AnalyzerJobCmd, JobHandle, JobOutcome } from './supervisor';
import { shortModelName, type ModelManager } from './models';
import { DRUM_ROLES, clipPlayback, effectiveBpm, findChannelByName, heardSemis, hitsByRole, notesToTicks, secToTick } from './convert';
import { PRE_SEC, SOURCE_WAV, drumEvents, monoEvents, sourceInstrument, type SourceEvent } from './fromSource';
import { AUDIO_FILE_RE } from '@shared/audio/formats';

/** Applies a command as the caller (user or agent); throws an Error with a human message on failure. */
export type Apply = <T = unknown>(cmd: string, args: unknown) => T;

export interface RunOptions {
  /** Progress of the analyzer job behind this call (MCP progress notifications). */
  onProgress?(stage: string, fraction: number): void;
  /** Abort = cancel the analyzer job (MCP request cancellation). */
  signal?: AbortSignal;
}

/** stemFiles: the cached stems of a song (no project change). */
export interface StemFiles {
  stems: Partial<Record<StemName, { path: string; peakDb: number; rmsDb: number }>>;
  model: string;
  /** "HT-Demucs" … */
  modelName: string;
  device: StemsResult['device'];
  cached: boolean;
  seconds: number;
}

/** fingerprint: one SoundFingerprint per segment, plus `whole` when no segments were given. */
export interface FingerprintResult {
  segments: SoundFingerprint[];
  whole?: SoundFingerprint;
}

export interface ToPatternOptions {
  mode: TranscribeMode;
  name?: string;
  /** Snap note starts / ends to this grid in ticks (0 / absent = keep the performance timing). */
  quantize?: number;
  /**
   * What plays the notes. 'source' (default for mono and drums): an instrument made of the audio itself, each note
   * its own original recording (fromSource.ts), so the pattern sounds like the source. 'synth': a stock synth / the
   * factory kit (always for poly: one recording per chord can't be split over its notes).
   */
  sound?: 'source' | 'synth';
}

/** Transcription cache version: bump when the analyzer's notes change (2: low lines segmented by lowline.rs). */
const TRANSCRIBE_CACHE_V = 2;

export interface AnalyzerServiceDeps {
  doc: DocHost;
  supervisor: Pick<AnalyzerSupervisor, 'run' | 'status' | 'available' | 'onStatus' | 'stop'>;
  models: ModelManager;
  userDataDir: string;
  /** 'factory:…' / stored sample path → absolute file path. */
  resolveSamplePath(p: string): string;
  /** Engine sample info (frames / rate) for new stem samples; optional. */
  sampleInfo?(absPath: string): Promise<ActionResult<SampleInfo>>;
  /** Fan the state out to every renderer (called throttled on progress). */
  broadcast?(state: AnalyzerState): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

interface ResolvedTarget {
  abs: string;
  /** Display name (channel / sample / file name). */
  name: string;
  sample: SampleRef | null;
  channel: Channel | null;
  clip: Clip | null;
  /** Cache key (file-name safe). */
  key: string;
}

interface Job {
  info: AnalyzerJobInfo;
  handle: JobHandle<unknown>;
  model?: string;
}

const ANALYSIS_CACHE_VERSION = 1;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const AUDIO_FILE = AUDIO_FILE_RE;

function fail<T = never>(message: string): ActionResult<T> {
  return { ok: false, message };
}

function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** DocHost.exec as the user: one command = one undo step. */
export function userApply(doc: DocHost): Apply {
  return <T>(cmd: string, args: unknown): T => {
    const r = doc.exec<T>(cmd, args, { actor: USER });
    if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
    return r.data as T;
  };
}

export class AnalyzerService {
  private jobs = new Map<string, Job>();
  private jobSeq = 0;
  private inflight = new Map<string, Promise<unknown>>();
  private lastBroadcast = 0;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private readonly analysisDir: string;
  private readonly stemsDir: string;
  /** Instruments made of transcribed audio: <key>/source.wav + .sfz mappings (fromSource.ts). */
  private readonly instrumentsDir: string;

  constructor(private readonly deps: AnalyzerServiceDeps) {
    this.analysisDir = path.join(deps.userDataDir, 'analysis');
    this.stemsDir = path.join(deps.userDataDir, 'stems');
    this.instrumentsDir = path.join(deps.userDataDir, 'instruments');
    deps.supervisor.onStatus(() => this.notify());
  }

  /** Verify models, drop half-written stem folders. */
  async init(): Promise<void> {
    await this.deps.models.refresh();
    for (const name of await listDir(this.stemsDir)) {
      if (/\.tmp-[a-z0-9]+$/i.test(name)) await removeDir(path.join(this.stemsDir, name)).catch(() => {});
    }
    this.notify();
  }

  async stop(): Promise<void> {
    for (const j of this.jobs.values()) j.handle.cancel();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    await this.deps.supervisor.stop();
  }

  // ── State ──────────────────────────────────────────────────────────

  state(): AnalyzerState {
    const s = this.deps.supervisor.status();
    return {
      available: this.deps.supervisor.available(),
      running: s.running,
      pid: s.pid,
      version: s.version,
      devices: s.devices,
      models: this.deps.models.states(),
      jobs: [...this.jobs.values()].map((j) => ({ ...j.info })),
      modelsDir: this.deps.models.modelsDir,
    };
  }

  listModels(): ModelState[] {
    return this.deps.models.states();
  }

  /**
   * The shared sidecar + Model Manager for the reference library's own queue (electron/library). Library jobs
   * report their progress in LibraryState.queue, so they stay out of `jobs`.
   */
  shared(): { supervisor: AnalyzerServiceDeps['supervisor']; models: ModelManager } {
    return { supervisor: this.deps.supervisor, models: this.deps.models };
  }

  /** Broadcast now (structural change) or throttled to ~6/s (progress). */
  notify(throttle = false): void {
    const send = (): void => {
      this.broadcastTimer = null;
      this.lastBroadcast = Date.now();
      try {
        this.deps.broadcast?.(this.state());
      } catch {
        /* a window mid-teardown */
      }
    };
    if (!throttle) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      send();
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(send, Math.max(0, 150 - (Date.now() - this.lastBroadcast)));
    this.broadcastTimer.unref?.();
  }

  // ── Models (UI only: agents never download) ────────────────────────

  async installModel(id: string): Promise<ActionResult<AnalyzerState>> {
    const r = await this.deps.models.install(String(id));
    return { ...r, data: this.state() };
  }

  cancelInstall(id: string): ActionResult {
    return this.deps.models.cancelInstall(String(id));
  }

  async importModel(id: string, folder?: string): Promise<ActionResult<AnalyzerState>> {
    const r = await this.deps.models.importModel(String(id), folder);
    return { ...r, data: this.state() };
  }

  async removeModel(id: string): Promise<ActionResult<AnalyzerState>> {
    const busy = [...this.jobs.values()].find((j) => j.model === id);
    if (busy) return { ok: false, message: `${this.deps.models.def(id)?.name ?? id} is in use by "${busy.info.label}"; cancel it first`, data: this.state() };
    const r = await this.deps.models.remove(String(id));
    return { ...r, data: this.state() };
  }

  // ── Jobs ───────────────────────────────────────────────────────────

  cancelJob(jobId: string): ActionResult {
    const j = this.jobs.get(String(jobId));
    if (!j) return fail('That job already finished');
    j.handle.cancel();
    return { ok: true, message: `Cancelling: ${j.info.label}` };
  }

  private async runJob<C extends AnalyzerJobCmd, T>(cmd: C, args: AnalyzerJobArgs[C], label: string, opts: RunOptions, model?: string): Promise<JobOutcome<T>> {
    const id = `job-${++this.jobSeq}`;
    const kind: AnalyzerJobInfo['kind'] = cmd;
    const info: AnalyzerJobInfo = { id, kind, label, stage: 'starting', fraction: -1, startedAt: Date.now() };
    const handle = this.deps.supervisor.run<C, T>(cmd, args, (stage, fraction) => {
      if (stage) info.stage = stage;
      info.fraction = fraction;
      try {
        opts.onProgress?.(info.stage, fraction);
      } catch {
        /* best effort */
      }
      this.notify(true);
    });
    this.jobs.set(id, { info, handle: handle as JobHandle<unknown>, model });
    const onAbort = (): void => handle.cancel();
    if (opts.signal?.aborted) handle.cancel();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    this.notify();
    try {
      return await handle.done;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.jobs.delete(id);
      this.notify();
    }
  }

  // ── Krypt Voice (electron/voice): tts / sing / syllables jobs, listed and cancellable like the others ──

  /** The Local voice model (Kokoro, Model Manager task 'tts'): dir null until installed; null when this build has none. */
  voiceModel(): { id: string; name: string; dir: string | null; status?: string; message?: string } | null {
    const def = this.deps.models.defs().find((m) => (m.task as string) === 'tts' && m.default) ?? this.deps.models.defs().find((m) => (m.task as string) === 'tts');
    if (!def) return null;
    const st = this.deps.models.state(def.id);
    return { id: def.id, name: shortModelName(def), dir: this.deps.models.dirFor(def.id), status: st?.status, message: st?.message };
  }

  runVoiceJob<C extends 'tts' | 'sing' | 'syllables', T>(cmd: C, args: AnalyzerJobArgs[C], label: string, opts: RunOptions = {}): Promise<JobOutcome<T>> {
    return this.runJob<C, T>(cmd, args, label, opts, cmd === 'tts' ? this.voiceModel()?.id : undefined);
  }

  /** Share one in-flight run per key (two clicks on the same clip = one job). */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.inflight.get(key);
    if (hit) return hit as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // ── Targets ────────────────────────────────────────────────────────

  private async resolve(target: AudioTarget): Promise<ActionResult<ResolvedTarget>> {
    const p = this.deps.doc.project;
    let sample: SampleRef | null = null;
    let channel: Channel | null = null;
    let clip: Clip | null = null;
    let abs: string;
    let name: string;
    if (!target || typeof target !== 'object') return fail('Nothing to analyze: pick an audio clip, a channel or a file');
    if ('clipId' in target && typeof target.clipId === 'string') {
      clip = p.playlist.clips[target.clipId] ?? null;
      if (!clip) return fail('That clip no longer exists');
      if (clip.kind !== 'audio' || !clip.channelId) return fail(`That is a ${clip.kind} clip; only audio clips can be analysed`);
      channel = p.channels[clip.channelId] ?? null;
      if (!channel) return fail("The clip's audio channel no longer exists");
    } else if ('channelId' in target && typeof target.channelId === 'string') {
      channel = p.channels[target.channelId] ?? null;
      if (!channel) return fail('That channel no longer exists');
    } else if ('path' in target && typeof target.path === 'string') {
      const raw = target.path.trim();
      if (!raw) return fail('No file given');
      abs = raw.startsWith('factory:') ? this.deps.resolveSamplePath(raw) : raw;
      if (!path.isAbsolute(abs)) return fail(`"${raw}" is not an absolute file path`);
      if (!AUDIO_FILE.test(abs)) return fail(`"${path.basename(abs)}" is not an audio file (wav, aiff, flac, mp3, ogg)`);
      const st = await statFile(abs);
      if (!st) return fail(`File not found: ${abs}`);
      name = path.basename(abs).replace(/\.[a-z0-9]+$/i, '');
      return { ok: true, data: { abs, name, sample: null, channel: null, clip: null, key: sha256Text(`${abs.toLowerCase()}|${st.size}|${st.mtimeMs}`).slice(0, 32) } };
    } else return fail('Nothing to analyze: pick an audio clip, a channel or a file');

    sample = channel.generator.sampleId ? p.samples[channel.generator.sampleId] ?? null : null;
    if (!sample) return fail(`"${channel.name}" has no sample loaded`);
    abs = this.deps.resolveSamplePath(sample.path);
    name = channel.name || sample.name;
    const st = await statFile(abs);
    if (!st) return fail(`The audio file of "${name}" is missing (${abs}). Relink it first.`);
    const hash = sample.hash ? sample.hash.replace(/[^a-z0-9_-]/gi, '').slice(0, 64) : '';
    const key = hash ? `h-${hash}` : sha256Text(`${abs.toLowerCase()}|${st.size}|${st.mtimeMs}`).slice(0, 32);
    return { ok: true, data: { abs, name, sample, channel, clip, key } };
  }

  // ── analyze ────────────────────────────────────────────────────────

  /**
   * `drums`: also return the drum hits (study_reference); a cached analysis without them is redone once with them.
   * `light`: only what the harmony and level readings need (pitchProfile, key, levels; no beat model, no sections),
   * for stems (Auto Mashup's key fit): a cached full analysis with a pitch profile serves, else a quick run cached on
   * its own (`<key>.light.json`), never over the full one.
   */
  async analyze(target: AudioTarget, opts: RunOptions & { drums?: boolean; cachedOnly?: boolean; light?: boolean } = {}): Promise<ActionResult<AudioAnalysis>> {
    const r = await this.resolve(target);
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to analyze');
    const t = r.data;
    const beatDir = this.deps.models.dirFor('beat-this-small');
    const file = path.join(this.analysisDir, `${t.key}.json`);
    const cached = await readJson<{ v: number; beatModel: boolean; analysis: AudioAnalysis }>(file);
    // cachedOnly (set_tempo's reference lock): any cached reading, never a new analyzer run.
    if (opts.cachedOnly) return cached?.analysis ? { ok: true, data: { ...cached.analysis, path: t.abs } } : fail(`"${t.name}" hasn't been analysed yet`);
    if (opts.light) {
      if (cached?.v === ANALYSIS_CACHE_VERSION && cached.analysis?.pitchProfile) return { ok: true, data: { ...cached.analysis, path: t.abs } };
      const lightFile = path.join(this.analysisDir, `${t.key}.light.json`);
      const lc = await readJson<{ v: number; analysis: AudioAnalysis }>(lightFile);
      if (lc?.v === ANALYSIS_CACHE_VERSION && lc.analysis?.pitchProfile) return { ok: true, data: { ...lc.analysis, path: t.abs } };
      return this.once(`analyze:${t.key}:light`, async () => {
        const out = await this.runJob<'analyze', AudioAnalysis>('analyze', { path: t.abs, sections: false }, `Reading the notes of "${t.name}"`, opts);
        if (!out.ok) return fail<AudioAnalysis>(out.cancelled ? 'Analysis cancelled' : out.message ?? 'Analysis failed');
        const a = out.data;
        if (!a || typeof a !== 'object' || typeof a.durationSec !== 'number') return fail<AudioAnalysis>('The analyzer returned an unexpected result (update or rebuild krypt-studio-analyzer)');
        await writeFileAtomic(lightFile, JSON.stringify({ v: ANALYSIS_CACHE_VERSION, analysis: a })).catch((err) => this.deps.log('warn', `Couldn't cache the reading of "${t.name}": ${errText(err)}`));
        return { ok: true, data: { ...a, path: t.abs } };
      });
    }
    if (cached && cached.v === ANALYSIS_CACHE_VERSION && cached.analysis && (cached.beatModel || !beatDir) && (!opts.drums || Array.isArray(cached.analysis.drumHits))) {
      const a = { ...cached.analysis, path: t.abs };
      return { ok: true, message: `Analysed "${t.name}" (cached): ${describeAnalysis(a)}`, data: a };
    }
    const drums = !!opts.drums;
    return this.once(`analyze:${t.key}${drums ? ':drums' : ''}`, async () => {
      const out = await this.runJob<'analyze', AudioAnalysis>('analyze', { path: t.abs, sections: true, ...(drums ? { drums: true } : {}), ...(beatDir ? { beatModelDir: beatDir } : {}) }, `Analysing "${t.name}"`, opts);
      if (!out.ok) return fail<AudioAnalysis>(out.cancelled ? 'Analysis cancelled' : out.message ?? 'Analysis failed');
      const a = out.data;
      if (!a || typeof a !== 'object' || typeof a.durationSec !== 'number') return fail<AudioAnalysis>('The analyzer returned an unexpected result (update or rebuild krypt-studio-analyzer)');
      try {
        await writeFileAtomic(file, JSON.stringify({ v: ANALYSIS_CACHE_VERSION, beatModel: !!beatDir, analysis: a }));
      } catch (err) {
        this.deps.log('warn', `Couldn't cache the analysis of "${t.name}": ${errText(err)}`);
      }
      const data = { ...a, path: t.abs };
      return { ok: true, message: `Analysed "${t.name}": ${describeAnalysis(data)}`, data };
    });
  }

  // ── separateStems ──────────────────────────────────────────────────

  async separateStems(clipId: string, opts: { model?: string } = {}, apply: Apply = userApply(this.deps.doc), run: RunOptions = {}): Promise<ActionResult<StemsOutcome>> {
    const def = opts.model ? this.deps.models.def(opts.model) : this.deps.models.defaultFor('stems');
    if (!def) return fail(`Unknown stem model "${opts.model}". Stem models: ${this.deps.models.defs().filter((m) => m.task === 'stems').map((m) => m.id).join(', ') || 'none'}`);
    if (def.task !== 'stems') return fail(`${def.name} is a ${def.task} model, not a stem separator`);
    const modelDir = this.deps.models.dirFor(def.id);
    if (!modelDir) {
      const st = this.deps.models.state(def.id);
      if (st?.status === 'downloading' || st?.status === 'verifying') return fail(`${shortModelName(def)} is still being installed; try again when Model Manager shows it as installed.`);
      return fail(`Install ${shortModelName(def)} in Model Manager first.`);
    }
    // A second request for the same clip while one runs (double click, UI + agent) shares it: stems are added once.
    return this.once(`stems-op:${clipId}:${def.id}`, () => this.separateResolved(String(clipId), def, modelDir, apply, run));
  }

  private async separateResolved(clipId: string, def: ModelDef, modelDir: string, apply: Apply, run: RunOptions): Promise<ActionResult<StemsOutcome>> {
    const r = await this.resolve({ clipId });
    if (!r.ok || !r.data) return fail(r.message ?? 'Clip not found');
    const t = r.data;
    const outDir = path.join(this.stemsDir, `${t.key}-${def.id}`);

    const sep = await this.once(`separate:${t.key}:${def.id}`, () => this.stemsFor(t, def.id, modelDir, outDir, run));
    if (!sep.ok || !sep.data) return fail(sep.message ?? 'Separation failed');
    const { result, cached, seconds } = sep.data;

    // Order: the model's declared stems first, then anything else it produced.
    const order = (def.stems ?? []) as string[];
    const stems = [...result.stems].sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
    let info: { frames?: number; sampleRate?: number; channels?: number } = {};
    if (t.sample?.frames && t.sample.sampleRate) info = { frames: t.sample.frames, sampleRate: t.sample.sampleRate, channels: 2 };
    else if (this.deps.sampleInfo && stems[0]) {
      const si = await this.deps.sampleInfo(stems[0].path).catch(() => null);
      if (si?.ok && si.data) info = { frames: si.data.frames, sampleRate: si.data.sampleRate, channels: si.data.channels };
    }

    let placed: { trackIds: string[]; channelIds: string[] };
    try {
      placed = apply<{ trackIds: string[]; channelIds: string[] }>('audio.addStems', {
        clipId: t.clip!.id,
        model: def.id,
        stems: stems.map((s) => ({ stem: s.name, path: s.path, ...info })),
        muteSource: true,
      });
    } catch (err) {
      return fail(`The stems are ready but couldn't be added to the project: ${errText(err)}`);
    }
    const p = this.deps.doc.project;
    const track = p.playlist.tracks[p.playlist.clips[t.clip!.id]?.trackId ?? '']?.name ?? 'the source track';
    const names = stems.map((s) => s.name);
    const how = cached ? 'from the stem cache' : `${shortModelName(def)} on ${result.device === 'directml' ? 'the GPU (DirectML)' : 'the CPU'}, ${Math.round(seconds)} s`;
    return {
      ok: true,
      message: `Separated "${t.name}" into ${joinList(names)} (${how}). The stems are on ${placed.trackIds.length} new tracks under "${track}"; the original clip is muted.`,
      data: { trackIds: placed.trackIds, channelIds: placed.channelIds, stems: names as StemName[], model: def.id, device: result.device, seconds: cached ? 0 : seconds },
    };
  }

  /** Cached stems, or run the analyzer into a temp folder and rename it into place. */
  private async stemsFor(t: ResolvedTarget, model: string, modelDir: string, outDir: string, run: RunOptions): Promise<ActionResult<{ result: StemsResult; cached: boolean; seconds: number }>> {
    const manifest = path.join(outDir, 'stems.json');
    const cached = await readJson<{ v: number; result: StemsResult }>(manifest);
    if (cached?.v === 1 && cached.result?.stems?.length) {
      const result: StemsResult = { ...cached.result, stems: cached.result.stems.map((s) => ({ ...s, path: path.join(outDir, path.basename(s.path)) })) };
      const present = await Promise.all(result.stems.map((s) => statFile(s.path)));
      if (present.every(Boolean)) return { ok: true, data: { result, cached: true, seconds: 0 } };
    }
    const def = this.deps.models.def(model);
    const tmp = `${outDir}.tmp-${Date.now().toString(36)}`;
    const started = Date.now();
    try {
      await makeDir(path.dirname(tmp));
      const out = await this.runJob<'separate', StemsResult>('separate', { path: t.abs, model, modelDir, outDir: tmp, device: 'auto' }, `Separating "${t.name}" (${def ? shortModelName(def) : model})`, run, model);
      if (!out.ok || !out.data) {
        await removeDir(tmp).catch(() => {});
        return fail(out.cancelled ? 'Stem separation cancelled' : out.message ?? 'Stem separation failed');
      }
      const raw = out.data;
      if (!Array.isArray(raw.stems) || raw.stems.length === 0) throw new Error('The analyzer produced no stems');
      for (const s of raw.stems) {
        const f = path.join(tmp, path.basename(String(s.path)));
        if (!(await statFile(f))) throw new Error(`The analyzer reported ${s.name} but didn't write ${path.basename(String(s.path))}`);
      }
      const result: StemsResult = { ...raw, stems: raw.stems.map((s) => ({ ...s, path: path.join(outDir, path.basename(String(s.path))) })) };
      await writeFileAtomic(path.join(tmp, 'stems.json'), JSON.stringify({ v: 1, source: t.abs, result }, null, 1));
      if (await dirExists(outDir)) await removeDir(outDir);
      await renameDir(tmp, outDir);
      return { ok: true, data: { result, cached: false, seconds: Number.isFinite(raw.seconds) ? raw.seconds : (Date.now() - started) / 1000 } };
    } catch (err) {
      await removeDir(tmp).catch(() => {});
      return fail(`Stem separation failed: ${errText(err)}`);
    }
  }

  // ── transcription (shared by toPattern and transcribe) ─────────────

  /** The analyzer's notes / hits for a resolved target: cached per file + mode (+ key range), one run per key at a time. */
  private transcription(t: ResolvedTarget, mode: TranscribeMode, modelDir: string | undefined, run: RunOptions, range: { minKey?: number; maxKey?: number } = {}): Promise<ActionResult<TranscriptionResult>> {
    const r = `${range.minKey !== undefined ? `-k${range.minKey}` : ''}${range.maxKey !== undefined ? `-K${range.maxKey}` : ''}`;
    const cacheFile = path.join(this.analysisDir, `${t.key}-notes-${mode}${r}.json`);
    return this.once(`transcribe:${t.key}:${mode}${r}`, async (): Promise<ActionResult<TranscriptionResult>> => {
      const cached = await readJson<{ v: number; result: TranscriptionResult }>(cacheFile);
      if (cached?.v === TRANSCRIBE_CACHE_V && cached.result) return { ok: true, data: cached.result };
      const what = mode === 'drums' ? 'drums' : mode === 'mono' ? 'melody' : 'notes';
      const out = await this.runJob<'transcribe', TranscriptionResult>('transcribe', { path: t.abs, mode, ...(modelDir ? { modelDir } : {}), ...range }, `Transcribing "${t.name}" (${what})`, run, mode === 'poly' ? this.deps.models.defaultFor('transcribe')?.id : undefined);
      if (!out.ok || !out.data) return fail(out.cancelled ? 'Transcription cancelled' : out.message ?? 'Transcription failed');
      const result: TranscriptionResult = { mode, notes: Array.isArray(out.data.notes) ? out.data.notes : [], hits: Array.isArray(out.data.hits) ? out.data.hits : [], source: String(out.data.source ?? '') };
      await writeFileAtomic(cacheFile, JSON.stringify({ v: TRANSCRIBE_CACHE_V, result })).catch((err) => this.deps.log('warn', `Couldn't cache the transcription of "${t.name}": ${errText(err)}`));
      return { ok: true, data: result };
    });
  }

  /**
   * Notes of one melodic line (mode mono, no model needed) or drum hits, WITHOUT changing the project: the vocals
   * service reads a vocal's key from its notes when the chroma key reading is weak. Cached like toPattern's.
   */
  async transcribe(target: AudioTarget, mode: 'mono' | 'drums' = 'mono', run: RunOptions = {}): Promise<ActionResult<TranscriptionResult>> {
    if (mode !== 'mono' && mode !== 'drums') return fail('mode must be mono or drums');
    const r = await this.resolve(target);
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to transcribe');
    return this.transcription(r.data, mode, undefined, run);
  }

  /**
   * Drum hits from the DRUM STEM of a target, WITHOUT changing the project (study_reference: sharper drums than the
   * full mix's onsets). Separates with the default installed stem model (cached per file, the same cache as
   * separate_stems) and transcribes the drum stem (cached). data null when no stem model is installed, or with
   * `cachedOnly` when the stems aren't cached yet (get_playbook / review_song never start a separation).
   */
  async drumStemHits(target: AudioTarget, opts: { cachedOnly?: boolean } = {}, run: RunOptions = {}): Promise<ActionResult<{ hits: TranscriptionResult['hits']; model: string; cached: boolean; seconds: number } | null>> {
    const def = this.deps.models.defaultFor('stems');
    const modelDir = def ? this.deps.models.dirFor(def.id) : null;
    if (!def || !modelDir) return { ok: true, data: null, message: 'No stem model is installed' };
    const r = await this.resolve(target);
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to separate');
    const t = r.data;
    const outDir = path.join(this.stemsDir, `${t.key}-${def.id}`);
    if (opts.cachedOnly && !(await statFile(path.join(outDir, 'stems.json')))) return { ok: true, data: null, message: 'The stems are not cached yet' };
    const sep = await this.once(`separate:${t.key}:${def.id}`, () => this.stemsFor(t, def.id, modelDir, outDir, run));
    if (!sep.ok || !sep.data) return fail(sep.message ?? 'Stem separation failed');
    const drums = sep.data.result.stems.find((s) => s.name === 'drums');
    if (!drums) return fail(`${shortModelName(def)} produced no drum stem`);
    const stem: ResolvedTarget = { abs: drums.path, name: `${t.name} (drums)`, sample: null, channel: null, clip: null, key: `${t.key}-${def.id}-drums` };
    const tr = await this.transcription(stem, 'drums', undefined, run);
    if (!tr.ok || !tr.data) return fail(tr.message ?? 'Reading the drum stem failed');
    return { ok: true, data: { hits: tr.data.hits, model: def.id, cached: sep.data.cached, seconds: sep.data.seconds } };
  }

  // ── Audio → project (Wave 8a, electron/audioProject) ───────────────

  /**
   * The stem files of a target (a file, clip or channel), separated with the default installed stem model and cached
   * per file (the same cache as separate_stems). Never changes the project. data null when no stem model is installed
   * (or, with `cachedOnly`, when the stems aren't cached yet).
   */
  async stemFiles(target: AudioTarget, opts: { cachedOnly?: boolean } = {}, run: RunOptions = {}): Promise<ActionResult<StemFiles | null>> {
    const def = this.deps.models.defaultFor('stems');
    const modelDir = def ? this.deps.models.dirFor(def.id) : null;
    if (!def || !modelDir) return { ok: true, data: null, message: 'No stem model is installed' };
    const r = await this.resolve(target);
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to separate');
    const t = r.data;
    const outDir = path.join(this.stemsDir, `${t.key}-${def.id}`);
    if (opts.cachedOnly && !(await statFile(path.join(outDir, 'stems.json')))) return { ok: true, data: null, message: 'The stems are not cached yet' };
    const sep = await this.once(`separate:${t.key}:${def.id}`, () => this.stemsFor(t, def.id, modelDir, outDir, run));
    if (!sep.ok || !sep.data) return fail(sep.message ?? 'Stem separation failed');
    const stems: StemFiles['stems'] = {};
    for (const s of sep.data.result.stems) stems[s.name] = { path: s.path, peakDb: s.peakDb, rmsDb: s.rmsDb };
    return { ok: true, data: { stems, model: def.id, modelName: shortModelName(def), device: sep.data.result.device, cached: sep.data.cached, seconds: sep.data.seconds } };
  }

  /**
   * Notes (poly / mono) or drum hits of any audio file (e.g. a cached stem) WITHOUT changing the project. Cached per
   * file + mode + key range. poly needs the installed transcription model (fails with a sentence otherwise).
   */
  async transcribeFile(absPath: string, mode: TranscribeMode, opts: { minKey?: number; maxKey?: number; name?: string } = {}, run: RunOptions = {}): Promise<ActionResult<TranscriptionResult>> {
    if (mode !== 'poly' && mode !== 'mono' && mode !== 'drums') return fail('mode must be poly, mono or drums');
    const r = await this.resolve({ path: absPath });
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to transcribe');
    let modelDir: string | undefined;
    if (mode === 'poly') {
      const def = this.deps.models.defaultFor('transcribe');
      const dir = def ? this.deps.models.dirFor(def.id) : null;
      if (!def || !dir) return fail(`Polyphonic transcription needs the ${def?.name ?? 'Basic Pitch'} model, which isn't installed.`);
      modelDir = dir;
    }
    const range: { minKey?: number; maxKey?: number } = {};
    if (Number.isInteger(opts.minKey)) range.minKey = Math.max(0, Math.min(127, opts.minKey!));
    if (Number.isInteger(opts.maxKey)) range.maxKey = Math.max(0, Math.min(127, opts.maxKey!));
    const t = { ...r.data, name: opts.name?.slice(0, 80) || r.data.name };
    return this.transcription(t, mode, modelDir, run, range);
  }

  /**
   * Timbre fingerprints (shared/sound-match/types.ts) of an audio file, whole or per segment (seconds), from the
   * analyzer's `fingerprint` cmd. Cached per file + segments. An analyzer built before Wave 8a fails with a sentence.
   */
  async fingerprint(absPath: string, segments?: Array<{ startSec: number; endSec: number }>, opts: { pitch?: boolean; highpassHz?: number | null } = {}, run: RunOptions = {}): Promise<ActionResult<FingerprintResult>> {
    const r = await this.resolve({ path: absPath });
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to measure');
    const t = r.data;
    const segs = (segments ?? []).filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec).slice(0, 512);
    const hp = opts.highpassHz && Number.isFinite(opts.highpassHz) && opts.highpassHz > 0 ? Math.round(opts.highpassHz) : null;
    const sig = sha256Text(JSON.stringify([segs.map((s) => [Math.round(s.startSec * 1000), Math.round(s.endSec * 1000)]), opts.pitch !== false, ...(hp ? [hp] : [])])).slice(0, 16);
    const cacheFile = path.join(this.analysisDir, `${t.key}-fp-${sig}.json`);
    return this.once(`fingerprint:${t.key}:${sig}`, async (): Promise<ActionResult<FingerprintResult>> => {
      const cached = await readJson<{ v: number; result: FingerprintResult }>(cacheFile);
      if (cached?.v === 1 && cached.result) return { ok: true, data: cached.result };
      const out = await this.runJob<'fingerprint', FingerprintResult>('fingerprint', { path: t.abs, ...(segs.length ? { segments: segs } : {}), pitch: opts.pitch !== false, ...(hp ? { highpassHz: hp } : {}) }, `Measuring the sounds of "${t.name}"`, run);
      if (!out.ok || !out.data) return fail(out.cancelled ? 'Sound measuring cancelled' : out.message ?? 'Sound measuring failed');
      const result: FingerprintResult = { segments: Array.isArray(out.data.segments) ? out.data.segments : [], ...(out.data.whole ? { whole: out.data.whole } : {}) };
      await writeFileAtomic(cacheFile, JSON.stringify({ v: 1, result })).catch((err) => this.deps.log('warn', `Couldn't cache the fingerprints of "${t.name}": ${errText(err)}`));
      return { ok: true, data: result };
    });
  }

  // ── Instruments from the source audio ────────────────────────────

  /** A WAV copy of the target's audio in userData/instruments/<key>/ (cached), for SFZ regions to point at. */
  private sourceCopy(t: ResolvedTarget, run: RunOptions): Promise<ActionResult<{ dir: string; sampleRate: number; frames: number }>> {
    const dir = path.join(this.instrumentsDir, t.key);
    const meta = path.join(dir, 'source.json');
    return this.once(`extract:${t.key}`, async () => {
      const m = await readJson<{ v: number; sampleRate: number; frames: number }>(meta);
      if (m?.v === 1 && m.sampleRate > 0 && m.frames > 0 && (await statFile(path.join(dir, SOURCE_WAV)))) return { ok: true, data: { dir, sampleRate: m.sampleRate, frames: m.frames } };
      await makeDir(dir);
      const out = await this.runJob<'extract', ExtractResult>('extract', { path: t.abs, out: path.join(dir, SOURCE_WAV) }, `Making "${t.name}" playable as an instrument`, run);
      if (!out.ok || !out.data) return fail(out.cancelled ? 'Cancelled' : out.message ?? 'The audio could not be copied');
      await writeFileAtomic(meta, JSON.stringify({ v: 1, source: t.abs, sampleRate: out.data.sampleRate, frames: out.data.frames, channels: out.data.channels }));
      return { ok: true, data: { dir, sampleRate: out.data.sampleRate, frames: out.data.frames } };
    });
  }

  /**
   * Timbre per event (6 band levels, dB) for keys with more than 127 events, so the shared regions are picked by
   * sound (fromSource.shareRegions). Undefined when no key needs it or the measuring fails (velocity bands then).
   */
  private async sliceFeatures(t: ResolvedTarget, events: SourceEvent[], run: RunOptions): Promise<Array<number[] | null> | undefined> {
    const perKey = new Map<number, number>();
    for (const e of events) perKey.set(e.key, (perKey.get(e.key) ?? 0) + 1);
    const idx = events.map((_, i) => i).filter((i) => (perKey.get(events[i].key) ?? 0) > 127);
    if (!idx.length) return undefined;
    const out: Array<number[] | null> = new Array(events.length).fill(null);
    for (let a = 0; a < idx.length; a += 512) {
      const chunk = idx.slice(a, a + 512);
      const segs = chunk.map((i) => ({ startSec: Math.max(0, events[i].startSec - PRE_SEC), endSec: Math.min(events[i].untilSec, events[i].startSec + 0.08) }));
      const r = await this.fingerprint(t.abs, segs, { pitch: false }, run);
      if (!r.ok || !r.data || r.data.segments.length !== segs.length) return undefined;
      chunk.forEach((i, k) => {
        const f = r.data!.segments[k];
        out[i] = [f.bands.sub, f.bands.low, f.bands.lowMid, f.bands.mid, f.bands.highMid, f.bands.high].map((b) => b + f.peakDb);
      });
    }
    return out;
  }

  // ── toPattern ──────────────────────────────────────────────────────

  async toPattern(target: AudioTarget, opts: ToPatternOptions, apply: Apply = userApply(this.deps.doc), run: RunOptions = {}): Promise<ActionResult<ToPatternOutcome>> {
    const mode = opts?.mode;
    if (mode !== 'poly' && mode !== 'mono' && mode !== 'drums') return fail('mode must be poly, mono or drums');
    const r = await this.resolve(target);
    if (!r.ok || !r.data) return fail(r.message ?? 'Nothing to transcribe');
    const t = r.data;

    let modelDir: string | undefined;
    if (mode === 'poly') {
      const def = this.deps.models.defaultFor('transcribe');
      const dir = def ? this.deps.models.dirFor(def.id) : null;
      if (!def || !dir) {
        const st = def ? this.deps.models.state(def.id) : null;
        return fail(`Polyphonic transcription needs the ${def?.name ?? 'Basic Pitch'} model, which isn't installed${st?.message ? `: ${st.message}` : '.'} Monophonic and drum transcription work without it.`);
      }
      modelDir = dir;
    }

    const tr = await this.transcription(t, mode, modelDir, run);
    if (!tr.ok || !tr.data) return fail(tr.message ?? 'Transcription failed');
    const result = tr.data;

    // Convert against the CURRENT project (the user may have edited meanwhile).
    const p = this.deps.doc.project;
    const clip = t.clip ? p.playlist.clips[t.clip.id] ?? null : null;
    if (t.clip && !clip) return fail('The clip was deleted while it was being transcribed');
    const channel = t.channel ? p.channels[t.channel.id] ?? null : null;
    const eff = effectiveBpm(p, this.deps.doc.catalog, channel);
    // Where and at what pitch the clip plays its file: warp markers, stretch, pitch shift, reverse.
    const play = clipPlayback(p, this.deps.doc.catalog, channel, t.sample);
    const grid = Math.max(0, Math.round(opts.quantize ?? 0));
    const baseName = t.name.slice(0, 48);
    const name = (opts.name?.trim() || `${baseName} ${mode === 'drums' ? 'drums' : 'notes'}`).slice(0, 64);

    // What plays the notes: the audio itself (each note its own recording) unless asked otherwise, or poly, or a
    // reversed clip (regions play forwards). A failed copy falls back to the synth and says so.
    let sound: 'source' | 'synth' = opts.sound ?? (mode === 'poly' ? 'synth' : 'source');
    let soundNote = '';
    if (mode === 'poly' || play.reverseSec) sound = 'synth';
    let src: { dir: string; sampleRate: number; frames: number } | null = null;
    if (sound === 'source') {
      const c = await this.sourceCopy(t, run);
      if (c.ok && c.data) src = c.data;
      else {
        sound = 'synth';
        soundNote = ` The original audio couldn't be used as the instrument (${c.message ?? 'copy failed'}), so a stand-in plays it.`;
      }
    }
    const writeSfz = async (file: string, text: string): Promise<string> => {
      const abs = path.join(src!.dir, file);
      await writeFileAtomic(abs, text);
      return abs;
    };
    const fileSec = src ? src.frames / src.sampleRate : Infinity;

    const lanes: Array<Record<string, unknown>> = [];
    let count = 0;
    if (mode === 'drums' && src) {
      // Every hit plays its own slice up to the next hit (hits at the same instant merged into the loudest), on
      // one channel per drum role: the drum lane re-creates the source.
      const kept = drumEvents(result.hits, fileSec);
      for (const d of DRUM_ROLES) {
        const mine = kept.filter((k) => k.role === d.role);
        if (!mine.length) continue;
        const events = mine.map((k) => k.event);
        const inst = sourceInstrument(events, { sampleRate: src.sampleRate, frames: src.frames, name: `${t.name} ${d.name}`, features: await this.sliceFeatures(t, events, run) });
        const notes = mine.map((k, i) => {
          const tick = secToTick(k.event.startSec, play, grid);
          return { tick, key: 60, dur: Math.max(1, secToTick(k.event.untilSec, play, grid) - tick), vel: inst.vel[i] };
        });
        count += notes.length;
        const sfz = await writeSfz(`drums-${d.role}.sfz`, inst.sfz);
        lanes.push({ create: { type: 'krypt.multisampler', name: `${baseName} ${d.name}`.slice(0, 64), samplePath: sfz }, notes });
      }
    } else if (mode === 'drums') {
      const roleChannel = new Map(DRUM_ROLES.map((d) => [d.role, findChannelByName(p, d.name)]));
      const byRole = hitsByRole(result.hits, play, (role) => roleChannel.get(role)?.rootKey ?? 60, grid);
      for (const d of DRUM_ROLES) {
        const notes = byRole.get(d.role) ?? [];
        if (!notes.length) continue;
        count += notes.length;
        const existing = roleChannel.get(d.role);
        if (existing) lanes.push({ channelId: existing.id, notes });
        else if (await statFile(this.deps.resolveSamplePath(d.sample))) lanes.push({ create: { type: 'krypt.sampler', name: d.name, samplePath: d.sample, poly: d.poly }, notes });
        else lanes.push({ create: { type: 'krypt.drumsynth', name: d.name, params: { voice: d.voice }, poly: d.poly }, notes });
      }
    } else {
      const role = instrumentRole(mode, t);
      // "Loop Bass"; a source already named for its role (a "Song · Bass" stem) gets "Song · Bass notes", never its own name.
      const chName = (new RegExp(`\\b${role}$`, 'i').test(baseName) ? `${baseName} notes` : `${baseName} ${role}`).slice(0, 64);
      if (src) {
        // One region per note; each note written with the velocity that picks its own region.
        const events = monoEvents(result.notes, fileSec);
        const inst = sourceInstrument(events, { sampleRate: src.sampleRate, frames: src.frames, name: t.name, features: await this.sliceFeatures(t, events, run) });
        const notes = notesToTicks(result.notes.map((n, i) => ({ ...n, vel: inst.vel[i] })), play, grid);
        count = notes.length;
        const sfz = await writeSfz(`${mode}.sfz`, inst.sfz);
        lanes.push({ create: { type: 'krypt.multisampler', name: chName, samplePath: sfz, poly: mode === 'mono' ? { mono: true, glideMs: 0 } : undefined }, notes });
      } else {
        const notes = notesToTicks(result.notes, play, grid);
        count = notes.length;
        const preset = SYNTH_PRESETS.find((s) => s.match.test(role.toLowerCase()));
        lanes.push({ create: { type: 'krypt.triosc', name: chName, params: preset?.params, poly: mode === 'mono' ? { mono: true, glideMs: 0 } : undefined }, notes });
      }
    }
    if (count === 0) return fail(`No ${mode === 'drums' ? 'drum hits' : 'notes'} were detected in "${t.name}"`);

    let out: { patternId: string; channelIds: string[]; trackId: string | null; notes: number };
    try {
      out = apply('audio.addTranscription', { name, lanes, clipId: clip?.id, select: true });
    } catch (err) {
      return fail(`The transcription is ready but couldn't be added to the project: ${errText(err)}`);
    }
    const timing = play.markers ? "timed through the clip's warp markers" : eff.synced ? `timed at the clip's source tempo (${eff.bpm} bpm)` : `timed at ${eff.bpm} bpm`;
    const shift = mode === 'drums' ? 0 : Math.round(heardSemis(play, 0) * 100) / 100;
    const pitched = shift ? `, moved ${shift > 0 ? '+' : ''}${shift} st to match the clip's pitch` : play.repitchAt ? ", pitched with the clip's speed" : '';
    const where = out.trackId ? ` on a new track under the clip, aligned with it` : '';
    const what = mode === 'drums' ? `${out.notes} drum hits on ${joinList(out.channelIds.map((id) => this.deps.doc.project.channels[id]?.name ?? id))}` : `${out.notes} notes`;
    const played = src ? ` Played by the original audio: every ${mode === 'drums' ? 'hit' : 'note'} is its own recording, so the pattern sounds like the source (the velocity picks the recording).` : soundNote;
    return {
      ok: true,
      message: `Transcribed "${t.name}" into pattern "${name}": ${what}${where} (${timing}${pitched}${play.reverseSec ? ', reversed like the clip' : ''}${grid ? `, quantized to ${grid} ticks` : ''}; estimated by ${result.source || 'the analyzer'}).${played}`,
      data: { patternId: out.patternId, channelIds: out.channelIds, notes: out.notes },
    };
  }
}

/** Which synth role a transcription gets: bass stems / bass-named sources → bass; mono → lead; poly → keys. */
function instrumentRole(mode: TranscribeMode, t: ResolvedTarget): string {
  const hint = `${t.sample?.origin?.stem ?? ''} ${t.name}`.toLowerCase();
  if (/(bass|808|sub)/.test(hint)) return 'Bass';
  if (mode === 'mono') return 'Lead';
  return 'Keys';
}

/** "128 bpm (confidence 0.82), F#m, 12.4 s" — the one-line summary used in messages. */
export function describeAnalysis(a: AudioAnalysis): string {
  const parts: string[] = [];
  if (a.tempo) parts.push(`~${Math.round(a.tempo.bpm * 10) / 10} bpm`);
  else parts.push('no steady tempo');
  if (a.key) parts.push(`key ${a.key.name}`);
  parts.push(`${Math.round(a.durationSec * 10) / 10} s`);
  if (a.levels && Number.isFinite(a.levels.lufsIntegrated)) parts.push(`${Math.round(a.levels.lufsIntegrated * 10) / 10} LUFS`);
  return parts.join(', ');
}

