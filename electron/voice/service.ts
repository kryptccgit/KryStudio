// ──────────────────────────────────────────────────────────────────────
// VoiceService: Krypt Voice (research/21) for the UI (IPC, actor = user)
// and agents (MCP generate_voice / sing_notes / list_voices).
//
//   speak   text → WAV (Local: the analyzer's `tts` with Kokoro; Cloud: Fish
//           Audio with the user's key) cached in userData/voice/cache/<hash>
//           by engine + voice + speed + text → an audio clip (new track, or
//           `track` / `at`), Follow tempo off → optional Krypt Tune
//   sing    "Sing my notes": the lane's melody (shared/voice/singplan.ts) +
//           the lyrics' syllables (shared/voice/syllables.ts) → speak line by
//           line → where each syllable is (Kokoro word timings, else the
//           analyzer's `syllables`, else equal splits) → the analyzer's `sing`
//           (segments stretched + pitched onto the notes at the project
//           tempo) → one clip at the pattern's first note in song time →
//           Krypt Tune (hard) in the song's key
//   voices  Kokoro presets (the model package's list), Fish's own licensed
//           voices (cached a day; never the community library), and "my
//           voice": a private Fish clone of the USER, made only from a take
//           the app's recorder made in this session, with consent
//
// One job at a time (progress + cancel); a project-tab switch is refused
// while a job that will edit the project runs (busy()). Every edit goes
// through commands via `apply`: one undo step per call. Fish calls are
// logged as "sent to Fish Audio" (electron/voice/fish.ts). Node-only: tests
// drive it with fakes.
// ──────────────────────────────────────────────────────────────────────

import { KOKORO_VOICES } from '@shared/analyzer/models';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DocHost } from '@shared/doc/DocHost';
import type { SingArgs, SingResult, SyllablesResult, TtsResult } from '@shared/analyzer/protocol';
import type { SampleInfo } from '@shared/engine/protocol';
import type { ActionResult } from '@shared/types';
import { PPQ, ticksPerBar } from '@shared/schema/time';
import { keyShortName } from '@shared/music/keymatch';
import { patternKey } from '@shared/vocals/plan';
import { CONSENT_LINE, type SingOutcome, type SingRequest, type SpeakOutcome, type SpeakRequest, type VoiceEngine, type VoiceInfo, type VoiceProgress, type VoiceStage, type VoiceState } from '@shared/voice/types';
import { parseLyrics } from '@shared/voice/syllables';
import { buildSegments, equalSpans, fitSpans, mapSyllables, mappingRows, melodyFromNotes, patternBarRange, wordSpans, type Span } from '@shared/voice/singplan';
import { readBytes, writeFileAtomic } from '../system/files';
import { listDir, makeDir, readJson, removeDir, renameDir, statFile } from '../system/download';
import type { AnalyzerService, Apply, RunOptions } from '../analyzer/service';
import { userGroupApply, type VocalsService } from '../vocals/service';
import { concatWav, parseWav } from './wav';
import { consentHeard, FISH_KEYS_URL, FISH_TTS_MODEL, FishClient, FishError, type FetchLike, type FishVoice } from './fish';

/** What the voice service needs of the analyzer service (electron/analyzer/service.ts). */
export type VoiceAnalyzer = Pick<AnalyzerService, 'voiceModel' | 'runVoiceJob'>;

export interface VoiceDeps {
  doc: DocHost;
  userDataDir: string;
  /** null when the analyzer service didn't start (Local voices and singing are then unavailable). */
  analyzer: VoiceAnalyzer | null;
  /** Krypt Tune on the new clip (electron/vocals). */
  vocals: Pick<VocalsService, 'tune'> | null;
  /** The engine's decoder: frames / rate / channels of a rendered file. */
  sampleInfo(absPath: string): Promise<ActionResult<SampleInfo>>;
  /** HTTP (default: global fetch). */
  fetch?: FetchLike;
  /** The Fish key, encrypted at rest (electron/voice/index.ts: safeStorage). write(null) removes it. */
  secrets: { read(): string | null; write(key: string | null): ActionResult };
  /** The app's audio recorder (electron/input/liveInput.ts): only its takes from this session can become "my voice". */
  recorder: { isSessionTake(absPath: string): boolean } | null;
  /** The song position in ticks, when known (default placement). */
  playheadTick?(): number | null;
  /** Play a rendered file once (Preview). */
  audition?(absPath: string): unknown;
  broadcastState?(s: VoiceState): void;
  broadcastProgress?(p: VoiceProgress): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  now?(): number;
}

/** Text per speak call (Fish bills per byte; Kokoro is happiest under a paragraph). */
export const MAX_SPEAK_CHARS = 1000;
export const MAX_LYRICS_CHARS = 2000;
export const MAX_LINES = 48;
export const MAX_SING_NOTES = 400;
/** A "my voice" recording must be this fresh (and from this session). */
export const RECENT_TAKE_MS = 2 * 60 * 60 * 1000;
export const MIN_CLONE_SEC = 10;
export const MAX_CLONE_SEC = 180;
const MAX_CLONE_BYTES = 40 * 1024 * 1024;
const FISH_VOICES_TTL_MS = 24 * 60 * 60 * 1000;
const FISH_RETRY_MS = 5 * 60 * 1000;
const CACHE_V = 1;
const LINE_GAP_SEC = 0.25;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r1 = (n: number): number => Math.round(n * 10) / 10;
const fail = <T = never>(message: string): ActionResult<T> => ({ ok: false, message });
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** User text in messages: no control / bidi characters, capped. */
function snippet(s: string, max = 40): string {
  const c = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return c.length > max ? `${c.slice(0, max - 1).trim()}…` : c;
}

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** Kokoro voice ids → a readable entry ("af_heart" → Heart, US English · female). English only for now. */
const KOKORO_LANG: Record<string, string> = { a: 'US English', b: 'UK English' };
export const KOKORO_DEFAULT_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'];

export function kokoroVoiceInfo(id: string, extra?: { name?: string; description?: string }): VoiceInfo | null {
  const m = /^([a-z])([fm])_([a-z0-9]+)$/i.exec(id);
  if (!m || !KOKORO_LANG[m[1].toLowerCase()]) return null;
  const lang = KOKORO_LANG[m[1].toLowerCase()];
  const name = extra?.name || m[3][0].toUpperCase() + m[3].slice(1);
  return { id: `local:${id}`, engine: 'local', name, description: extra?.description || `${lang} · ${m[2].toLowerCase() === 'f' ? 'female' : 'male'} · Local (offline)`, language: m[1].toLowerCase() === 'a' ? 'en-US' : 'en-GB' };
}

interface MyVoice {
  id: string;
  referenceId: string;
  name: string;
  createdAt: number;
}

interface Rendered {
  path: string;
  durationSec: number;
  words: TtsResult['words'];
  engine: VoiceEngine;
  cached: boolean;
  key: string;
}

interface ResolvedVoice {
  engine: VoiceEngine;
  /** Kokoro voice id or Fish reference id. */
  ref: string;
  name: string;
  mine: boolean;
}

interface Job {
  label: string;
  edits: boolean;
  ctrl: AbortController;
}

export class VoiceService {
  private current: Job | null = null;
  private fishVoices: { at: number; voices: FishVoice[] } | null = null;
  private fishLoaded = false;
  private fishTried = 0;
  private fishMessage: string | undefined;
  private refreshing: Promise<void> | null = null;
  private readonly dir: string;
  private readonly cacheDir: string;
  private readonly fish: FishClient;

  constructor(private readonly deps: VoiceDeps) {
    this.dir = path.join(deps.userDataDir, 'voice');
    this.cacheDir = path.join(this.dir, 'cache');
    const f: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
    this.fish = new FishClient({ fetch: f, log: deps.log });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get doc(): DocHost {
    return this.deps.doc;
  }

  /** Drop half-written renders from a crash. */
  async init(): Promise<void> {
    for (const name of await listDir(this.cacheDir)) {
      if (/\.tmp-[a-z0-9]+\.wav$/i.test(name)) await removeDir(path.join(this.cacheDir, name)).catch(() => {});
    }
  }

  // ── State ──────────────────────────────────────────────────────────

  /** A job that will edit the project is running (the project-tab guard): its label, else null. */
  busy(): string | null {
    return this.current && this.current.edits ? this.current.label : null;
  }

  async state(): Promise<VoiceState> {
    const a = this.deps.analyzer;
    const model = a?.voiceModel() ?? null;
    let localMessage: string | undefined;
    if (!a) localMessage = "Local voices need Krypt Studio's audio analyzer, which didn't start in this session (see the log).";
    else if (!model) localMessage = "This build doesn't include the Local voice model (Kokoro) yet. Use a Cloud (Fish Audio) voice.";
    else if (!model.dir) {
      localMessage =
        model.status === 'downloading' || model.status === 'verifying'
          ? `${model.name} is being installed…`
          : `Install ${model.name} in Model Manager (Home ▸ Audio Tools ▸ Models) to speak offline, for free.${model.message ? ` (${model.message})` : ''}`;
    }
    const keySet = !!this.deps.secrets.read();
    if (keySet) this.refreshFishVoices(false);
    const voices: VoiceInfo[] = [];
    if (model?.dir) voices.push(...(await this.kokoroVoices(model.dir)));
    if (keySet) {
      await this.loadFishCache();
      for (const v of this.fishVoices?.voices ?? []) voices.push(fishInfo(v));
    }
    for (const m of await this.myVoices()) voices.push({ id: `mine:${m.id}`, engine: 'fish', name: m.name, description: 'Your own voice · Cloud (Fish Audio, private)', language: 'multi', mine: true });
    return {
      local: { installed: !!model?.dir, modelId: model?.id ?? null, ...(localMessage ? { message: localMessage } : {}) },
      fish: { keySet, ...(keySet ? (this.fishMessage ? { message: this.fishMessage } : {}) : { message: `Add your own free Fish Audio key in Settings ▸ Voice to use Cloud voices (${FISH_KEYS_URL}). Your text is sent to Fish Audio.` }) },
      voices,
    };
  }

  /** Broadcast the state to every window (best effort; failures are logged). */
  notifyState(): void {
    if (!this.deps.broadcastState) return;
    void this.state()
      .then((s) => this.deps.broadcastState?.(s))
      .catch((err) => this.deps.log('warn', `Krypt Voice: couldn't read the voice state: ${errText(err)}`));
  }

  /** The Kokoro voices the installed model package lists (voices.json, or voices/<id>.*), else the known English set. */
  private async kokoroVoices(modelDir: string): Promise<VoiceInfo[]> {
    const listed = await readJson<unknown>(path.join(modelDir, 'voices.json'));
    const out: VoiceInfo[] = [];
    const add = (id: string, extra?: { name?: string; description?: string }) => {
      const v = kokoroVoiceInfo(id, extra);
      if (v && !out.some((x) => x.id === v.id)) out.push(v);
    };
    const arr = Array.isArray(listed) ? listed : listed && typeof listed === 'object' && Array.isArray((listed as { voices?: unknown }).voices) ? (listed as { voices: unknown[] }).voices : null;
    if (arr) {
      for (const x of arr) {
        if (typeof x === 'string') add(x);
        else if (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') {
          const o = x as { id: string; name?: unknown; description?: unknown };
          add(o.id, { name: typeof o.name === 'string' ? snippet(o.name, 32) : undefined, description: typeof o.description === 'string' ? snippet(o.description, 80) : undefined });
        }
      }
    }
    if (!out.length) for (const f of await listDir(path.join(modelDir, 'voices'))) add(f.replace(/\.[a-z0-9]+$/i, ''));
    // The Model Manager installs flat: <modelDir>/<voice>.bin, named and described in KOKORO_VOICES.
    if (!out.length) {
      const files = new Set((await listDir(modelDir)).map((f) => f.toLowerCase()));
      for (const k of KOKORO_VOICES) if (files.has(`${k.id}.bin`)) add(k.id, { name: k.name, description: `${k.description} · Local (offline)` });
    }
    if (!out.length) for (const id of KOKORO_DEFAULT_VOICES) add(id);
    // af_heart (Kokoro's best-rated voice) first.
    out.sort((a, b) => (a.id === 'local:af_heart' ? -1 : b.id === 'local:af_heart' ? 1 : 0));
    return out;
  }

  private async loadFishCache(): Promise<void> {
    if (this.fishLoaded) return;
    this.fishLoaded = true;
    const c = await readJson<{ v: number; at: number; voices: FishVoice[] }>(path.join(this.dir, 'fish-voices.json'));
    if (c?.v === 1 && Array.isArray(c.voices) && !this.fishVoices) this.fishVoices = { at: c.at, voices: c.voices };
  }

  /** Re-read Fish's official voices when the cache is a day old (or `force`). Never throws; failures land in fish.message. */
  refreshFishVoices(force: boolean): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.loadFishCache();
      const key = this.deps.secrets.read();
      if (!key) return false;
      if (!force && this.fishVoices && this.now() - this.fishVoices.at < FISH_VOICES_TTL_MS) return false;
      // After a failure, wait a while before asking again on our own (state() → refresh → notify must not loop).
      if (!force && this.now() - this.fishTried < FISH_RETRY_MS) return false;
      this.fishTried = this.now();
      try {
        const voices = await this.fish.officialVoices(key);
        this.fishVoices = { at: this.now(), voices };
        this.fishMessage = voices.length ? undefined : "Fish Audio listed no official voices right now; your own voice still works.";
        await makeDir(this.dir);
        await writeFileAtomic(path.join(this.dir, 'fish-voices.json'), JSON.stringify({ v: 1, at: this.fishVoices.at, voices }));
      } catch (err) {
        this.fishMessage = `Couldn't load Fish Audio's voices: ${errText(err)}`;
        this.deps.log('warn', `Krypt Voice: ${this.fishMessage}`);
      }
      return true;
    })().then((fetched) => {
      this.refreshing = null;
      // Only after a real fetch: notifyState → state() → refreshFishVoices(false) must not loop.
      if (fetched) this.notifyState();
    });
    return this.refreshing;
  }

  private async myVoices(): Promise<MyVoice[]> {
    const j = await readJson<{ v: number; voices: MyVoice[] }>(path.join(this.dir, 'my-voices.json'));
    return j?.v === 1 && Array.isArray(j.voices) ? j.voices.filter((v) => v && typeof v.id === 'string' && typeof v.referenceId === 'string') : [];
  }

  private async saveMyVoices(list: MyVoice[]): Promise<void> {
    await makeDir(this.dir);
    await writeFileAtomic(path.join(this.dir, 'my-voices.json'), JSON.stringify({ v: 1, voices: list }, null, 1));
  }

  // ── Voices ─────────────────────────────────────────────────────────

  /** A voice id → engine + reference. Fish voices must be official or the user's own (never a community voice). */
  private async resolveVoice(voiceId: string | undefined, engine?: VoiceEngine): Promise<ActionResult<ResolvedVoice>> {
    const id = String(voiceId ?? '').trim();
    const st = await this.state();
    if (!id) {
      const pick = st.voices.find((v) => (engine ? v.engine === engine : v.engine === 'local')) ?? (engine ? undefined : st.voices.find((v) => v.engine === 'fish'));
      if (!pick) {
        if (engine === 'fish' || (!engine && !st.local.installed)) return fail(st.fish.keySet ? `No Cloud voice is available: ${st.fish.message ?? 'Fish Audio listed none'}` : `${st.local.message ?? 'No Local voice is installed.'} ${st.fish.message ?? ''}`.trim());
        return fail(st.local.message ?? 'No Local voice is installed.');
      }
      return this.resolveVoice(pick.id);
    }
    const m = /^(local|fish|mine):(.+)$/.exec(id);
    if (!m) return fail(`Unknown voice "${snippet(id, 40)}": use an id from the voice list (e.g. "local:af_heart").`);
    const [, kind, ref] = m;
    if (kind === 'local') {
      if (!st.local.installed) return fail(st.local.message ?? 'The Local voice model is not installed.');
      const v = st.voices.find((x) => x.id === id);
      if (!v) return fail(`The Local model has no voice "${snippet(ref, 24)}". Voices: ${st.voices.filter((x) => x.engine === 'local').slice(0, 8).map((x) => x.id).join(', ')}.`);
      return { ok: true, data: { engine: 'local', ref, name: v.name, mine: false } };
    }
    if (!st.fish.keySet) return fail(`That is a Cloud voice (Fish Audio): add your own Fish key in Settings ▸ Voice first (free keys: ${FISH_KEYS_URL}).`);
    if (kind === 'mine') {
      const mine = (await this.myVoices()).find((v) => v.id === ref);
      if (!mine) return fail('That "my voice" entry no longer exists. Record your voice again in Settings ▸ Voice.');
      return { ok: true, data: { engine: 'fish', ref: mine.referenceId, name: mine.name, mine: true } };
    }
    let v = (this.fishVoices?.voices ?? []).find((x) => x.id === ref);
    if (!v) {
      await this.refreshFishVoices(true);
      v = (this.fishVoices?.voices ?? []).find((x) => x.id === ref);
    }
    if (!v && !this.fishVoices?.voices.length && this.fishMessage) return fail(this.fishMessage);
    if (!v) return fail("Only Fish Audio's official voices and your own voice can be used (no community voices). Pick one from the voice list.");
    return { ok: true, data: { engine: 'fish', ref, name: v.title, mine: false } };
  }

  // ── Jobs ───────────────────────────────────────────────────────────

  cancel(): ActionResult {
    if (!this.current) return fail('Krypt Voice is not rendering anything');
    this.current.ctrl.abort();
    return { ok: true, message: `Cancelling: ${this.current.label}` };
  }

  private async job<T>(label: string, edits: boolean, run: RunOptions, fn: (signal: AbortSignal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    if (this.current) return fail(`Krypt Voice is busy with "${this.current.label}": wait for it or press Cancel.`);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (run.signal?.aborted) ctrl.abort();
    else run.signal?.addEventListener('abort', onAbort, { once: true });
    this.current = { label, edits, ctrl };
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      if (err instanceof Cancelled || ctrl.signal.aborted) return fail(`${label}: cancelled`);
      if (err instanceof FishError) return fail(err.cancelled ? `${label}: cancelled` : err.message);
      this.deps.log('error', `Krypt Voice: ${label} failed: ${errText(err)}`);
      return fail(`${label} failed: ${errText(err)}`);
    } finally {
      run.signal?.removeEventListener('abort', onAbort);
      this.current = null;
    }
  }

  private progress(run: RunOptions, stage: VoiceStage, fraction: number, message: string): void {
    const p: VoiceProgress = { stage, fraction: Math.max(-1, Math.min(1, fraction)), message };
    try {
      this.deps.broadcastProgress?.(p);
    } catch {
      /* a window mid-teardown */
    }
    try {
      run.onProgress?.(message, p.fraction);
    } catch {
      /* best effort */
    }
  }

  private analyzerRun(signal: AbortSignal, run: RunOptions, stage: VoiceStage, base: number, span: number): RunOptions {
    return {
      signal,
      onProgress: (s, f) => this.progress(run, stage, f < 0 ? -1 : base + f * span, s || stage),
    };
  }

  // ── Rendering ──────────────────────────────────────────────────────

  /** Text → cached WAV with one voice. */
  private async render(text: string, voice: ResolvedVoice, speed: number, signal: AbortSignal, run: RunOptions, stage: VoiceStage, base: number, span: number): Promise<Rendered> {
    const model = voice.engine === 'local' ? this.deps.analyzer?.voiceModel() : null;
    const key = sha(JSON.stringify({ v: CACHE_V, engine: voice.engine, model: voice.engine === 'local' ? model?.id ?? '' : FISH_TTS_MODEL, voice: voice.ref, speed: Math.round(speed * 100) / 100, text })).slice(0, 40);
    const wav = path.join(this.cacheDir, `${key}.wav`);
    const meta = path.join(this.cacheDir, `${key}.json`);
    const cached = await readJson<{ v: number; durationSec: number; words: TtsResult['words'] }>(meta);
    if (cached?.v === CACHE_V && (await statFile(wav))) return { path: wav, durationSec: cached.durationSec, words: Array.isArray(cached.words) ? cached.words : [], engine: voice.engine, cached: true, key };
    if (signal.aborted) throw new Cancelled();
    await makeDir(this.cacheDir);
    if (voice.engine === 'local') {
      const a = this.deps.analyzer;
      if (!a || !model?.dir) throw new Error('the Local voice model is not installed');
      const tmp = path.join(this.cacheDir, `${key}.tmp-${crypto.randomBytes(4).toString('hex')}.wav`);
      const out = await a.runVoiceJob<'tts', TtsResult>('tts', { text, voice: voice.ref, speed, out: tmp, modelDir: model.dir }, `Speaking "${snippet(text, 32)}"`, this.analyzerRun(signal, run, stage, base, span));
      if (!out.ok || !out.data) {
        await removeDir(tmp).catch(() => {});
        if (out.cancelled) throw new Cancelled();
        throw new Error(out.message ?? 'the Local voice failed');
      }
      if (!(await statFile(tmp))) throw new Error("the analyzer reported speech but didn't write the file (update or rebuild krypt-studio-analyzer)");
      await renameDir(tmp, wav);
      const words = Array.isArray(out.data.words) ? out.data.words.filter((w) => w && typeof w.text === 'string') : [];
      const durationSec = Number.isFinite(out.data.durationSec) ? out.data.durationSec : 0;
      await writeFileAtomic(meta, JSON.stringify({ v: CACHE_V, durationSec, words, engine: 'local' }));
      return { path: wav, durationSec, words, engine: 'local', cached: false, key };
    }
    const fishKey = this.deps.secrets.read();
    if (!fishKey) throw new Error(`Cloud voices need your Fish Audio key (Settings ▸ Voice; free keys: ${FISH_KEYS_URL})`);
    this.progress(run, stage, -1, `Sending to Fish Audio (Cloud)…`);
    const bytes = await this.fish.tts(fishKey, { text, referenceId: voice.ref, speed, signal });
    const info = parseWav(bytes);
    if ('error' in info) throw new Error(`Fish Audio sent audio Krypt Studio couldn't read (${info.error})`);
    await writeFileAtomic(wav, bytes);
    await writeFileAtomic(meta, JSON.stringify({ v: CACHE_V, durationSec: info.durationSec, words: [], engine: 'fish' }));
    return { path: wav, durationSec: info.durationSec, words: [], engine: 'fish', cached: false, key };
  }

  // ── Placement ──────────────────────────────────────────────────────

  private parseAt(at: string | undefined): number | { error: string } | null {
    if (at === undefined || !String(at).trim()) return null;
    const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(String(at));
    if (!m || Number(m[1]) < 1 || (m[2] !== undefined && Number(m[2]) < 1)) return { error: `at "${snippet(String(at), 12)}" must be a bar ("9") or bar.step ("9.3"), 1-based` };
    const ts = this.doc.project.transport.timeSig;
    return (Number(m[1]) - 1) * ticksPerBar(ts) + (m[2] ? Number(m[2]) - 1 : 0) * (PPQ / 4);
  }

  private findTrack(ref: string | undefined): string | null | { error: string } {
    if (ref === undefined || !String(ref).trim()) return null;
    const p = this.doc.project;
    const r = String(ref).trim();
    if (/^\d+$/.test(r)) {
      const id = p.playlist.trackOrder[Number(r) - 1];
      return id ?? { error: `Playlist track ${r} doesn't exist (1..${p.playlist.trackOrder.length})` };
    }
    if (p.playlist.tracks[r]) return r;
    const hit = p.playlist.trackOrder.filter((id) => p.playlist.tracks[id].name.toLowerCase() === r.toLowerCase());
    if (hit.length === 1) return hit[0];
    return { error: hit.length > 1 ? `Several Playlist tracks are called "${snippet(r, 30)}": use its number` : `No Playlist track "${snippet(r, 30)}" (use its number or name)` };
  }

  /** The rendered file → one audio clip (a new track unless `trackId`). */
  private async place(file: { abs: string; hash: string }, name: string, start: number, trackId: string | null, apply: Apply): Promise<ActionResult<{ clipId: string; channelId: string; trackId: string; track: number; durationSec: number }>> {
    let info: ActionResult<SampleInfo>;
    try {
      info = await this.deps.sampleInfo(file.abs);
    } catch (err) {
      info = fail(errText(err));
    }
    if (!info.ok || !info.data || !(info.data.frames > 0)) {
      const why = info.message ?? 'no audio frames';
      if (/isn'?t running|not running|is starting|restarting/i.test(why)) return fail(`The voice is rendered, but the audio engine isn't running, so it can't be placed. Try again once it runs (Settings ▸ Audio). (${why})`);
      return fail(`The rendered voice couldn't be read back: ${why}`);
    }
    const p = this.doc.project;
    let tid = trackId;
    try {
      if (!tid) {
        const used = new Set(Object.values(p.playlist.clips).map((c) => c.trackId));
        let index = 0;
        p.playlist.trackOrder.forEach((t, i) => {
          if (used.has(t)) index = i + 1;
        });
        tid = apply<{ id: string }>('playlist.addTrack', { name, index }).id;
      }
      // An audio-clip channel plays at its own speed by default (tempo_sync 0 = Follow tempo off).
      const a = apply<{ clipId: string; channelId: string }>('playlist.addAudio', {
        path: file.abs,
        name,
        trackId: tid,
        start: Math.max(0, Math.round(start)),
        frames: info.data.frames,
        sampleRate: info.data.sampleRate,
        channels: info.data.channels,
        hash: file.hash,
      });
      const p2 = this.doc.project;
      return { ok: true, data: { clipId: a.clipId, channelId: a.channelId, trackId: tid, track: p2.playlist.trackOrder.indexOf(tid) + 1, durationSec: info.data.frames / info.data.sampleRate } };
    } catch (err) {
      return fail(`The voice is rendered but couldn't be placed on the Playlist: ${errText(err)}`);
    }
  }

  private async tune(clipId: string, style: 'natural' | 'pop' | 'hard', key: string | undefined, apply: Apply, run: RunOptions): Promise<string> {
    if (!this.deps.vocals) return 'Krypt Tune is not available in this session, so the clip is untuned.';
    const r = await this.deps.vocals.tune({ clipId }, { style, key }, apply, run).catch((err) => fail(errText(err)));
    return r.ok ? (r.message ?? `Krypt Tune (${style}) added.`) : `Krypt Tune wasn't added: ${r.message ?? 'unknown error'}.`;
  }

  /** Run `fn` with the caller's apply, or as ONE user undo step (IPC). */
  private async withApply<T>(apply: Apply | undefined, label: string, fn: (a: Apply) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    if (apply) return fn(apply);
    const g = userGroupApply(this.doc, label);
    let r: ActionResult<T> = fail(`${label} failed`);
    try {
      r = await fn(g.apply);
    } finally {
      g.finish(r.ok);
    }
    return r;
  }

  private audition(abs: string): void {
    try {
      const r = this.deps.audition?.(abs);
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((err) => this.deps.log('warn', `Krypt Voice: preview playback failed: ${errText(err)}`));
    } catch (err) {
      this.deps.log('warn', `Krypt Voice: preview playback failed: ${errText(err)}`);
    }
  }

  // ── speak ──────────────────────────────────────────────────────────

  async speak(req: SpeakRequest & { engine?: VoiceEngine }, apply?: Apply, run: RunOptions = {}): Promise<ActionResult<SpeakOutcome>> {
    let text = String(req?.text ?? '').trim();
    if (!text) return fail('Type something for the voice to say');
    if ([...text].length > MAX_SPEAK_CHARS) return fail(`That is ${[...text].length} characters; Krypt Voice speaks up to ${MAX_SPEAK_CHARS} at a time. Split it into shorter parts.`);
    const speed = Number.isFinite(req.speed) ? Math.max(0.5, Math.min(2, Number(req.speed))) : 1;
    const tune = req.tune && req.tune !== 'off' ? req.tune : null;
    if (req.tune && !['off', 'natural', 'pop', 'hard'].includes(req.tune)) return fail('tune must be off, natural, pop or hard');
    const v = await this.resolveVoice(req.voiceId, req.engine);
    if (!v.ok || !v.data) return fail(v.message ?? 'No voice');
    const voice = v.data;
    const notes: string[] = [];
    if (voice.engine === 'local') {
      if (/\[[a-z][a-z ]{1,24}\]/i.test(text)) {
        text = text.replace(/\[[a-z][a-z ]{1,24}\]/gi, ' ').replace(/\s+/g, ' ').trim();
        notes.push('Emotion tags like [whisper] only work with Cloud (Fish Audio) voices, so they were left out.');
        if (!text) return fail('Only emotion tags were given; type the words to say');
      }
      if (/[^\u0000-ɏḀ-ỿ -⁯₠-⃏\s]/u.test(text)) return fail('The Local voice speaks English for now. Use a Cloud (Fish Audio) voice for other languages.');
    }
    // Validate the placement before rendering (no wasted Cloud request).
    const preview = !!req.preview;
    const at = preview ? null : this.parseAt(req.at);
    if (at && typeof at === 'object') return fail(at.error);
    const track = preview ? null : this.findTrack(req.track);
    if (track && typeof track === 'object') return fail(track.error);

    const label = `Speak "${snippet(text, 28)}"`;
    return this.job(label, !preview, run, async (signal) => {
      this.progress(run, 'speaking', 0, `Speaking with ${voice.name}…`);
      const r = await this.render(text, voice, speed, signal, run, 'speaking', 0, 0.9);
      if (signal.aborted) throw new Cancelled();
      const how = `${voice.name}, ${voice.engine === 'fish' ? 'Cloud: your text was sent to Fish Audio' : 'Local, offline'}, ${r1(r.durationSec)} s${r.cached ? ', from the cache' : ''}`;
      if (preview) {
        this.audition(r.path);
        this.progress(run, 'placing', 1, 'Previewing');
        return { ok: true, message: `Previewing "${snippet(text, 40)}" (${how}).${notes.length ? ` ${notes.join(' ')}` : ''}`, data: { path: r.path, durationSec: r1(r.durationSec), engine: r.engine, notes } };
      }
      this.progress(run, 'placing', 0.95, 'Adding the clip…');
      const start = typeof at === 'number' ? at : Math.max(0, Math.round(this.deps.playheadTick?.() ?? 0));
      const name = `Voice: ${snippet(text, 24)}`;
      return this.withApply<SpeakOutcome>(apply, label, async (ap) => {
        const placed = await this.place({ abs: r.path, hash: `voice-${r.key}` }, name, start, typeof track === 'string' ? track : null, ap);
        if (!placed.ok || !placed.data) return fail(placed.message ?? 'Placing failed');
        const d = placed.data;
        let tuned = '';
        if (tune) tuned = ` ${await this.tune(d.clipId, tune, undefined, ap, { signal })}`;
        const bar = Math.floor(start / ticksPerBar(this.doc.project.transport.timeSig)) + 1;
        this.progress(run, 'placing', 1, 'Done');
        return {
          ok: true,
          message: `Added "${snippet(text, 40)}" (${how}) on ${typeof track === 'string' ? '' : 'new '}track ${d.track} at bar ${bar}; it plays at its own speed (Follow tempo off).${tuned}${notes.length ? ` ${notes.join(' ')}` : ''}`,
          data: { path: r.path, durationSec: r1(r.durationSec), engine: r.engine, clipId: d.clipId, channelId: d.channelId, notes },
        };
      });
    });
  }

  // ── sing ───────────────────────────────────────────────────────────

  async sing(req: SingRequest, apply?: Apply, run: RunOptions = {}): Promise<ActionResult<SingOutcome>> {
    const p0 = this.doc.project;
    const pat = p0.patterns[String(req?.patternId ?? '')];
    if (!pat) return fail('That pattern no longer exists');
    const ch = p0.channels[String(req?.channelId ?? '')];
    if (!ch) return fail('That channel no longer exists');
    const lyrics = String(req?.lyrics ?? '');
    if (!lyrics.trim()) return fail('Type the lyrics to sing');
    if ([...lyrics].length > MAX_LYRICS_CHARS) return fail(`The lyrics are ${[...lyrics].length} characters; sing up to ${MAX_LYRICS_CHARS} at a time (a verse or a hook).`);
    const tpb = ticksPerBar(p0.transport.timeSig);
    const range = patternBarRange(req.bars, tpb);
    if (range && 'error' in range) return fail(range.error);
    const melody = melodyFromNotes(Object.values(pat.notes[ch.id] ?? {}), range ?? undefined);
    const where = `"${snippet(ch.name, 30)}" in "${snippet(pat.name, 30)}"${req.bars ? ` (bars ${snippet(req.bars, 10)})` : ''}`;
    if (!melody.length) return fail(`${where} has no notes to sing: draw the melody in the piano roll first.`);
    if (melody.length > MAX_SING_NOTES) return fail(`${where} has ${melody.length} notes; sing up to ${MAX_SING_NOTES} at a time (pick bars).`);
    const parsed = parseLyrics(lyrics);
    if (!parsed.syllables.length) return fail('The lyrics have no words to sing');
    if (parsed.lines.length > MAX_LINES) return fail(`The lyrics have ${parsed.lines.length} lines; sing up to ${MAX_LINES} at a time.`);
    if (!this.deps.analyzer) return fail("Singing needs Krypt Studio's audio analyzer, which didn't start in this session (see the log).");
    const v = await this.resolveVoice(req.voiceId);
    if (!v.ok || !v.data) return fail(v.message ?? 'No voice');
    const voice = v.data;
    const octave = Number.isFinite(req.octave) ? Math.max(-2, Math.min(2, Math.round(Number(req.octave)))) : 0;
    const vibrato = Number.isFinite(req.vibrato) ? Math.max(0, Math.min(1, Number(req.vibrato))) : 0.2;
    const glideMs = Number.isFinite(req.glideMs) ? Math.max(0, Math.min(300, Number(req.glideMs))) : 40;
    const tune = req.tune ?? 'hard';
    if (!['off', 'natural', 'pop', 'hard'].includes(tune)) return fail('tune must be off, natural, pop or hard');
    const map = mapSyllables(parsed.syllables, melody.length);
    const preview = !!req.preview;
    const label = `Sing "${snippet(parsed.lines[0].text, 24)}"`;

    return this.job(label, !preview, run, async (signal) => {
      const notes: string[] = [...parsed.notes, ...map.notes];
      // 1. Speak each line (cached).
      const lines: Rendered[] = [];
      const nLines = parsed.lines.length;
      for (let i = 0; i < nLines; i++) {
        if (signal.aborted) throw new Cancelled();
        this.progress(run, 'speaking', (i / nLines) * 0.5, `Speaking line ${i + 1} of ${nLines}${voice.engine === 'fish' ? ' (Cloud: Fish Audio)' : ''}…`);
        lines.push(await this.render(parsed.lines[i].text, voice, 1, signal, run, 'speaking', (i / nLines) * 0.5, 0.5 / nLines));
      }
      // 2. One source file (lines joined with a short silence).
      let srcPath = lines[0].path;
      let offsets = [0];
      if (lines.length > 1) {
        const joined = concatWav(await Promise.all(lines.map((l) => readBytes(l.path))), LINE_GAP_SEC);
        if ('error' in joined) throw new Error(`couldn't join the spoken lines (${joined.error})`);
        srcPath = path.join(this.cacheDir, `src-${sha(lines.map((l) => l.key).join('|')).slice(0, 40)}.wav`);
        if (!(await statFile(srcPath))) await writeFileAtomic(srcPath, joined.bytes);
        offsets = joined.offsets;
      }
      // 3. Where each syllable is.
      const spans: Span[] = [];
      const methods = new Set<string>();
      for (let i = 0; i < nLines; i++) {
        if (signal.aborted) throw new Cancelled();
        const line = parsed.lines[i];
        const r = lines[i];
        let s: Span[] | null = r.words.length ? wordSpans(line.syllables, line.words, r.words) : null;
        if (s) methods.add('word timings');
        else {
          this.progress(run, 'syllables', 0.5 + (i / nLines) * 0.1, `Finding the syllables of line ${i + 1}…`);
          const out = await this.deps.analyzer!.runVoiceJob<'syllables', SyllablesResult>('syllables', { path: r.path, expected: line.syllables.length }, `Finding syllables in "${snippet(line.text, 24)}"`, this.analyzerRun(signal, run, 'syllables', 0.5 + (i / nLines) * 0.1, 0.1 / nLines));
          if (out.cancelled) throw new Cancelled();
          const det = out.ok && out.data && Array.isArray(out.data.syllables) ? out.data.syllables : [];
          const fit = fitSpans(det, line.syllables.length);
          if (fit.length === line.syllables.length) {
            s = fit;
            methods.add('the syllable finder');
          } else {
            if (!out.ok) this.deps.log('warn', `Krypt Voice: syllable finding failed (${out.message ?? 'no answer'}); splitting evenly`);
            s = equalSpans(line.syllables.length, Math.min(0.05, r.durationSec / 10), Math.max(0.1, r.durationSec - 0.05));
            methods.add('even splits (rough)');
          }
        }
        for (const x of s) spans.push({ startSec: x.startSec + offsets[i], endSec: x.endSec + offsets[i] });
      }
      if (methods.has('even splits (rough)')) notes.push('Some syllables were split evenly in time (the syllable finder gave no answer), so their timing is rough.');
      // 4. Sing.
      const bpm = this.doc.project.transport.bpm;
      const segments = buildSegments(map.groups, melody, spans, { bpm, originTick: melody[0].tick, octave });
      if (!segments.length) throw new Error('nothing to sing (no syllable met a note)');
      const sungKey = sha(JSON.stringify({ v: CACHE_V, src: srcPath, segments, vibrato, glideMs })).slice(0, 40);
      const sungDir = path.join(this.dir, 'sung');
      const sungPath = path.join(sungDir, `${sungKey}.wav`);
      let durationSec = 0;
      const sungMeta = await readJson<{ v: number; durationSec: number }>(path.join(sungDir, `${sungKey}.json`));
      if (sungMeta?.v === CACHE_V && (await statFile(sungPath))) durationSec = sungMeta.durationSec;
      else {
        await makeDir(sungDir);
        const tmp = path.join(sungDir, `${sungKey}.tmp-${crypto.randomBytes(4).toString('hex')}.wav`);
        this.progress(run, 'singing', 0.65, `Singing ${segments.length} notes…`);
        const args: SingArgs = { path: srcPath, out: tmp, segments, vibrato, glideMs };
        const out = await this.deps.analyzer!.runVoiceJob<'sing', SingResult>('sing', args, `Singing "${snippet(parsed.lines[0].text, 24)}"`, this.analyzerRun(signal, run, 'singing', 0.65, 0.3));
        if (!out.ok || !out.data) {
          await removeDir(tmp).catch(() => {});
          if (out.cancelled) throw new Cancelled();
          throw new Error(out.message ?? 'the analyzer could not sing it');
        }
        if (!(await statFile(tmp))) throw new Error("the analyzer reported singing but didn't write the file (update or rebuild krypt-studio-analyzer)");
        await renameDir(tmp, sungPath);
        durationSec = Number.isFinite(out.data.durationSec) ? out.data.durationSec : 0;
        await writeFileAtomic(path.join(sungDir, `${sungKey}.json`), JSON.stringify({ v: CACHE_V, durationSec }));
        const unvoiced = (out.data.segments ?? []).filter((x) => x && x.f0Hz === null).length;
        if (unvoiced > segments.length / 3) notes.push(`${unvoiced} of ${segments.length} notes landed on unvoiced sounds (consonants or breaths), so they may sound thin: check the syllable split.`);
      }
      if (signal.aborted) throw new Cancelled();
      const mapping = mappingRows(map.groups, melody, parsed.syllables);
      const how = `${voice.name}, ${voice.engine === 'fish' ? 'Cloud: your lyrics were sent to Fish Audio' : 'Local, offline'}; syllables from ${[...methods].join(' and ')}`;
      const summary = `${parsed.syllables.length} syllables on ${melody.length} notes of ${where}${octave ? `, ${octave > 0 ? '+' : ''}${octave} octave` : ''}`;
      if (preview) {
        this.audition(sungPath);
        this.progress(run, 'placing', 1, 'Previewing');
        return { ok: true, message: `Previewing ${summary} (${how}).${notes.length ? ` ${notes.join(' ')}` : ''}`, data: { path: sungPath, durationSec: r1(durationSec), engine: voice.engine, notes, mapping } };
      }
      // 5. Place at the pattern's first note in song time, or the playhead when the pattern isn't on the Playlist.
      this.progress(run, 'placing', 0.97, 'Adding the clip…');
      const p = this.doc.project;
      if (!p.patterns[pat.id]) throw new Error('the pattern was deleted while singing');
      const clip = Object.values(p.playlist.clips)
        .filter((c) => c.kind === 'pattern' && c.patternId === pat.id)
        .sort((a, b) => a.start - b.start)[0];
      let start: number;
      let whereText: string;
      const bar = (t: number) => Math.floor(t / ticksPerBar(p.transport.timeSig)) + 1;
      if (clip) {
        start = clip.start + Math.max(0, melody[0].tick - clip.offset);
        whereText = `at bar ${bar(start)}, under the first "${snippet(pat.name, 30)}" clip`;
      } else {
        const ph = this.deps.playheadTick?.() ?? 0;
        const barTicks = ticksPerBar(p.transport.timeSig);
        start = Math.floor(Math.max(0, ph) / barTicks) * barTicks + Math.max(0, melody[0].tick - (range?.start ?? 0));
        whereText = `at bar ${bar(start)} ("${snippet(pat.name, 30)}" isn't on the Playlist)`;
      }
      const name = `Sung: ${snippet(parsed.lines[0].text, 24)}`;
      return this.withApply<SingOutcome>(apply, label, async (ap) => {
        const placed = await this.place({ abs: sungPath, hash: `sung-${sungKey}` }, name, start, null, ap);
        if (!placed.ok || !placed.data) return fail(placed.message ?? 'Placing failed');
        const d = placed.data;
        let tuned = '';
        if (tune !== 'off') {
          const pk = patternKey(this.doc.project);
          tuned = ` ${await this.tune(d.clipId, tune, pk && pk.confidence >= 0.5 ? keyShortName(pk.key) : undefined, ap, { signal })}`;
        }
        this.progress(run, 'placing', 1, 'Done');
        return {
          ok: true,
          message: `Sang ${summary} (${how}): ${r1(durationSec)} s on new track ${d.track} ${whereText}.${tuned}${notes.length ? ` ${notes.join(' ')}` : ''}`,
          data: { path: sungPath, durationSec: r1(durationSec), engine: voice.engine, clipId: d.clipId, channelId: d.channelId, notes, mapping },
        };
      });
    });
  }

  // ── Fish key ───────────────────────────────────────────────────────

  async setFishKey(key: string | null): Promise<ActionResult> {
    if (key === null || (typeof key === 'string' && !key.trim())) {
      const r = this.deps.secrets.write(null);
      if (!r.ok) return r;
      this.fishVoices = null;
      this.fishMessage = undefined;
      this.notifyState();
      return { ok: true, message: 'Fish Audio key removed. Cloud voices are off; Local voices still work.' };
    }
    if (typeof key !== 'string') return fail('Paste your Fish Audio API key');
    const k = key.trim();
    if (/\s/.test(k) || k.length < 16 || k.length > 256) return fail(`That doesn't look like a Fish Audio API key (copy it from ${FISH_KEYS_URL}).`);
    let free: boolean | null = null;
    try {
      free = (await this.fish.verify(k)).freeCredit;
    } catch (err) {
      return fail(err instanceof FishError ? err.message : `Couldn't check the key: ${errText(err)}`);
    }
    const w = this.deps.secrets.write(k);
    if (!w.ok) return w;
    this.fishMessage = undefined;
    await this.refreshFishVoices(true);
    this.notifyState();
    const tier = free === false ? ` Fish says this account has no free credit left, so Cloud voices may need credit at fish.audio.` : ` Cloud voices use the free developer tier (${FISH_TTS_MODEL}) while Fish offers it.`;
    return { ok: true, message: `Fish Audio key saved (encrypted with Windows' secure storage).${tier} Your text is sent to Fish Audio whenever you use a Cloud voice.` };
  }

  // ── My voice ───────────────────────────────────────────────────────

  async cloneMyVoice(opts: { recordingPath: string; name: string; consent: true }): Promise<ActionResult<VoiceInfo>> {
    if (!opts || opts.consent !== true) return fail('Cloning needs your consent: confirm that this is your own voice and that you agree to turn it into an AI voice.');
    const raw = String(opts.recordingPath ?? '').trim();
    if (!raw || !path.isAbsolute(raw) || !/\.wav$/i.test(raw)) return fail('Record your voice with Krypt Studio\'s recorder first ("Record my voice"); only that recording can be cloned.');
    const abs = path.resolve(raw);
    if (!this.deps.recorder?.isSessionTake(abs)) return fail("Only a recording made with Krypt Studio's recorder in this session can become your voice (no uploaded or older files). Record yourself reading the consent line, then try again.");
    const st = await statFile(abs);
    if (!st) return fail('That recording is gone. Record your voice again.');
    if (this.now() - st.mtimeMs > RECENT_TAKE_MS || st.mtimeMs - this.now() > 60_000) return fail('That recording is too old to use for your voice. Record yourself reading the consent line again.');
    if (st.size > MAX_CLONE_BYTES) return fail(`That recording is too large (${Math.round(st.size / 1048576)} MB): record ${MAX_CLONE_SEC / 60} minutes or less.`);
    const name = snippet(String(opts.name ?? ''), 40) || 'My voice';
    const key = this.deps.secrets.read();
    if (!key) return fail(`Your voice is made on Fish Audio (Cloud): add your own Fish key in Settings ▸ Voice first (free keys: ${FISH_KEYS_URL}).`);
    let info: ActionResult<SampleInfo>;
    try {
      info = await this.deps.sampleInfo(abs);
    } catch (err) {
      info = fail(errText(err));
    }
    if (!info.ok || !info.data) return fail(`The recording couldn't be read: ${info.message ?? 'no audio'}`);
    const secs = info.data.frames / info.data.sampleRate;
    if (secs < MIN_CLONE_SEC) return fail(`The recording is ${r1(secs)} s; read the consent line and a few sentences (at least ${MIN_CLONE_SEC} s) so the voice sounds like you.`);
    if (secs > MAX_CLONE_SEC) return fail(`The recording is ${Math.round(secs)} s; ${MAX_CLONE_SEC / 60} minutes at most.`);
    return this.job('Make my voice', false, {}, async (signal) => {
      const wav = await readBytes(abs);
      // The recording must start with the consent line (checked by Fish's speech-to-text; the recording goes to Fish anyway).
      let transcript = '';
      let checked = false;
      try {
        transcript = await this.fish.transcribe(key, wav, signal);
        checked = true;
      } catch (err) {
        if (err instanceof FishError && (err.cancelled || err.status === 401 || err.status === 402 || err.status === 429)) throw err;
        this.deps.log('warn', `Krypt Voice: the consent check couldn't run (${errText(err)}); relying on the live recording and the confirmation`);
      }
      if (checked && !consentHeard(transcript)) {
        return fail(`The recording doesn't start with the consent line, so it wasn't sent for cloning. Record yourself reading: "${CONSENT_LINE}" and then a few more sentences.`);
      }
      const made = await this.fish.createVoice(key, { title: name, wav, text: transcript || undefined, signal });
      const entry: MyVoice = { id: crypto.randomBytes(8).toString('hex'), referenceId: made.id, name, createdAt: this.now() };
      const list = await this.myVoices();
      list.push(entry);
      try {
        await this.saveMyVoices(list);
      } catch (err) {
        // Don't leave an orphan clone at Fish we can't track.
        await this.fish.deleteVoice(key, made.id).catch(() => {});
        return fail(`Your voice was made but couldn't be saved here (${errText(err)}), so it was deleted at Fish Audio again.`);
      }
      this.notifyState();
      const v: VoiceInfo = { id: `mine:${entry.id}`, engine: 'fish', name, description: 'Your own voice · Cloud (Fish Audio, private)', language: 'multi', mine: true };
      return { ok: true, message: `"${name}" is ready: a private voice on Fish Audio made from your recording${checked ? '' : ' (the consent line could not be checked automatically)'}. It is in the voice list under My voice; remove it any time.`, data: v };
    });
  }

  async removeMyVoice(id: string): Promise<ActionResult> {
    const ref = String(id ?? '').replace(/^mine:/, '');
    const list = await this.myVoices();
    const entry = list.find((v) => v.id === ref);
    if (!entry) return fail('That voice is already gone.');
    const key = this.deps.secrets.read();
    let atFish = '';
    if (key) {
      try {
        const r = await this.fish.deleteVoice(key, entry.referenceId);
        atFish = r === 'gone' ? ' (Fish Audio no longer had it)' : ' and deleted at Fish Audio';
      } catch (err) {
        return fail(`Couldn't delete "${entry.name}" at Fish Audio, so it was kept here too: ${errText(err)}`);
      }
    } else atFish = `. Without your Fish key it couldn't be deleted at Fish Audio: delete "${entry.name}" in your Fish Audio account (fish.audio ▸ My voices)`;
    try {
      await this.saveMyVoices(list.filter((v) => v.id !== ref));
    } catch (err) {
      return fail(`"${entry.name}" was deleted at Fish Audio but couldn't be removed from the list here: ${errText(err)}`);
    }
    this.notifyState();
    return { ok: true, message: `Removed "${entry.name}"${atFish}.` };
  }
}

function fishInfo(v: FishVoice): VoiceInfo {
  const lang = v.languages[0] ?? 'multi';
  const desc = [v.languages.join(', ') || 'multilingual', ...v.tags.slice(0, 2), 'Cloud (Fish Audio)'].filter(Boolean).join(' · ');
  return { id: `fish:${v.id}`, engine: 'fish', name: v.title, description: desc, language: lang };
}
