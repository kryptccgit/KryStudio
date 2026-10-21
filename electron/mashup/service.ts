// ──────────────────────────────────────────────────────────────────────
// Auto Mashup (research/18-auto-mashup.md): two songs → one editable
// mashup project, as ONE undo step. Shared by the IPC handlers (Home ▸
// Audio Tools, actor = user) and the MCP tool auto_mashup (the agent).
//
//   check   read both songs (analysis, stems only when already separated,
//           per-section vocal activity and pitch profiles of cached stems), plan
//           (shared/mashup/plan.ts). Never edits, never separates.
//   build   1 reading     analysis of both songs (cached)
//           2 separating  the stems the plan needs (HT-Demucs, cached)
//           3 analyzing   where each vocal sings (vocal stem loudness), and
//                         what the stems play (pitch profiles of the vocal
//                         and of the bass + other stems: the key fit)
//           4 planning    roles, key, tempo, levels, structure (pure); a
//                         plan that now needs other stems separates them
//           5 building    ONE history group: (a new project) tempo, audio
//                         tracks per stem with a clip per section, pitch,
//                         warp to the grid (tones / beats / complex),
//                         markers, song mode
//           6 mixing      the vocal chain (Krypt Tune, EQ + comp from the
//                         factory vocal chain, reverb / delay sends), the
//                         bed ducking under the vocal, a master chain,
//                         transitions at the boundaries (the same code as
//                         apply_chain / route / sidechain / add_transition)
//
// Stages 1-4 never touch the document, so a cancel or a failure there
// leaves the project as it was. Stage 5-6 run in one group that is rolled
// back when a command fails; once writing starts, cancel answers "too late"
// (it's quick, and one undo removes it).
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import type { Actor } from '@shared/doc/DocHost';
import type { Project, SampleRef } from '@shared/schema/project';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { ActionResult, AudioTarget } from '@shared/types';
import type { ExecResult } from '@shared/doc/DocHost';
import { isAudioFile } from '@shared/audio/formats';
import { MASHUP_RIGHTS_NOTE, type MashupCheck, type MashupOutcome, type MashupProgress, type MashupRequest, type MashupStage, type MashupStem } from '@shared/mashup/types';
import { goodProfile, planMashup, songBarToSec, sumProfiles, type BuildPlan, type PlannedTrack, type Side, type SongInput, type StemHarmony } from '@shared/mashup/plan';
import { secToBeat } from '@shared/schema/warp';
import { PPQ } from '@shared/schema/time';
import { AUDIOCLIP } from '@shared/analyzer/tempo';
import { planTune, rescaleForTempo } from '@shared/vocals/plan';
import { TUNE_EFFECT, tuneKeyFor, toKeyRef } from '@shared/music/keymatch';
import type { MainDeps } from '../mcp/types';
import type { RunCtx, ToolCaller, ToolDef, ToolResult } from '../mcp/tools/types';
import { applyChain } from '../mcp/tools/presets';
import { route, sidechain } from '../mcp/tools/mix';
import { addTransition, TRANSITION_KINDS } from '../mcp/tools/craft';
import { transitionLength } from '../mcp/tools/craftRecipe';
import { cleanName } from '../vocals/service';

export interface MashupRun {
  signal?: AbortSignal;
  progress?(p: MashupProgress): void;
}

/** Where the mashup goes: a NEW project (File ▸ New, then one group of `actor`), or the open one (`ctx` = an agent's call group, else a group of `actor`). */
export type MashupInto = { kind: 'new'; actor: Actor } | { kind: 'current'; actor: Actor; ctx?: RunCtx };

export class MashupCancelled extends Error {
  constructor() {
    super('Cancelled: nothing was changed.');
    this.name = 'MashupCancelled';
  }
}

/** Overall fraction range of each stage (build; check uses reading + planning only). */
const STAGE_RANGE: Record<MashupStage, [number, number]> = {
  reading: [0, 0.15],
  separating: [0.15, 0.65],
  analyzing: [0.65, 0.72],
  planning: [0.72, 0.75],
  building: [0.75, 0.9],
  mixing: [0.9, 1],
};

/** The factory chains the mix uses (shared/sounds/factory/chains.ts). */
export const MASHUP_CHAINS = {
  vocal: 'factory:chain/vocal/stem-vocal',
  reverb: 'factory:chain/reverb-send/plate',
  delay: 'factory:chain/delay-send/dotted-eighth',
  master: 'factory:chain/master/streaming-clean',
} as const;

const STEMS: MashupStem[] = ['vocals', 'drums', 'bass', 'other'];
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const letter = (s: Side): string => s.toUpperCase();
const SIDES: Side[] = ['a', 'b'];

/** The caller the mix tools run under for UI builds (they only use the RunCtx; the actor of the edits is the group's). */
const UI_CALLER: ToolCaller = { actor: { kind: 'agent', clientId: 'krypt-auto-mashup', name: 'Auto Mashup' }, session: { group: null }, via: 'panel' };

interface Resolved {
  side: Side;
  /** What the analyzer reads (a clip keeps the stem cache key separate_stems uses). */
  target: AudioTarget;
  abs: string;
  /** The path stored in the project. */
  docPath: string;
  name: string;
  sample: SampleRef | null;
  /** The source clip (project clips only). */
  clipId?: string;
  /** The clip is itself a stem of another song (origin). */
  stemOf?: string;
  /** Stems of this song already in the project (stem samples whose origin is this sample). */
  projectStems: Partial<Record<MashupStem, string>>;
}

interface StemFile {
  path: string;
  rmsDb: number | null;
}

interface SongRead {
  r: Resolved | null;
  analysis: AudioAnalysis | null;
  stems: Partial<Record<MashupStem, StemFile>>;
  /** Per analysis section: vocal activity 0 / 1 (null = not measured). */
  vocalBySection: Array<number | null> | null;
  /** What the stems play (readHarmony): the vocal stem, the bass + other stems. */
  harmony?: { vocal?: StemHarmony | null; bed?: StemHarmony | null };
  problem?: string;
}

type Say = (stage: MashupStage, within: number, message: string) => void;

/** `say` for one part of a stage: within 0..1 maps onto [lo, hi] of it (two songs share a stage). */
function part(say: Say, lo: number, hi: number): Say {
  return (stage, within, message) => say(stage, within < 0 ? -1 : lo + (hi - lo) * clamp01(within), message);
}

function addStems(read: SongRead, stems: Partial<Record<string, { path: string; rmsDb: number }>> | undefined): void {
  for (const [k, v] of Object.entries(stems ?? {})) {
    if (v && STEMS.includes(k as MashupStem) && !read.stems[k as MashupStem]) read.stems[k as MashupStem] = { path: v.path, rmsDb: Number.isFinite(v.rmsDb) ? v.rmsDb : null };
  }
}

export interface MashupServiceDeps {
  deps: MainDeps;
}

export class MashupService {
  private running: { label: string; ctrl: AbortController; writing: boolean } | null = null;
  private checking: AbortController | null = null;

  constructor(private readonly s: MashupServiceDeps) {}

  private get deps(): MainDeps {
    return this.s.deps;
  }

  get busy(): string | null {
    return this.running?.label ?? null;
  }

  /** IPC mashup:cancel / the MCP request's cancellation. */
  cancel(): ActionResult {
    if (this.running) {
      if (this.running.writing) return { ok: false, message: `Too late to cancel "${this.running.label}": the mashup is being written. Undo removes it in one step.` };
      this.running.ctrl.abort();
      return { ok: true, message: `Cancelling the mashup "${this.running.label}"…` };
    }
    if (this.checking) {
      this.checking.abort();
      return { ok: true, message: 'Cancelling the mashup check…' };
    }
    return { ok: false, message: 'No mashup is running' };
  }

  // ── Reading ────────────────────────────────────────────────────────

  private stemModelInstalled(): boolean {
    const ears = this.deps.analyzer;
    if (!ears?.stemFiles) return false;
    try {
      return (ears.listModels?.() ?? []).some((m) => m.def.task === 'stems' && m.status === 'installed');
    } catch {
      return false;
    }
  }

  private resolve(side: Side, src: MashupRequest['a']): Resolved | string {
    const p = this.deps.doc.project;
    if (src && typeof src === 'object' && 'clipId' in src) {
      const clip = p.playlist.clips[String(src.clipId)];
      if (!clip) return 'That clip no longer exists.';
      if (clip.kind !== 'audio' || !clip.channelId) return `That is a ${clip.kind} clip; a mashup needs songs (audio clips or files).`;
      const ch = p.channels[clip.channelId];
      if (!ch) return "The clip's audio channel no longer exists.";
      const sample = ch.generator.sampleId ? p.samples[ch.generator.sampleId] ?? null : null;
      if (!sample) return `"${cleanName(ch.name)}" has no audio loaded.`;
      const abs = this.deps.project.resolveSamplePath(sample.path);
      const projectStems: Partial<Record<MashupStem, string>> = {};
      for (const sm of Object.values(p.samples)) {
        if (sm.origin?.kind !== 'stem' || sm.origin.parentSampleId !== sample.id) continue;
        const st = sm.origin.stem as MashupStem;
        if (STEMS.includes(st)) projectStems[st] = this.deps.project.resolveSamplePath(sm.path);
      }
      return { side, target: { clipId: clip.id }, abs, docPath: sample.path, name: cleanName(ch.name, 64) || cleanName(sample.name, 64) || `Song ${letter(side)}`, sample, clipId: clip.id, stemOf: sample.origin?.kind === 'stem' ? sample.origin.stem : undefined, projectStems };
    }
    const raw = String((src as { path?: string } | undefined)?.path ?? '').trim();
    if (!raw) return 'No file given.';
    const factory = raw.startsWith('factory:');
    const abs = factory ? this.deps.project.resolveSamplePath(raw) : raw;
    if (!path.isAbsolute(abs)) return `"${cleanName(raw, 120)}" is not an absolute file path.`;
    if (!isAudioFile(abs)) return `"${cleanName(path.basename(abs), 80)}" isn't an audio file Krypt Studio can read (wav, flac, mp3, ogg, aiff, m4a …).`;
    const name = cleanName(path.basename(abs).replace(/\.[a-z0-9]{2,5}$/i, ''), 64) || `Song ${letter(side)}`;
    return { side, target: { path: abs }, abs, docPath: factory ? raw : abs, name, sample: null, projectStems: {} };
  }

  /** Analysis + the stems that are already there (project stems, the stem cache). Never edits, never separates. */
  private async read(r: Resolved, run: MashupRun, opts: { say: Say; check: () => void }): Promise<SongRead> {
    const ears = this.deps.analyzer!;
    const out: SongRead = { r, analysis: null, stems: {}, vocalBySection: null };
    const msg = `Listening to "${r.name}": tempo, beats, key, sections…`;
    opts.say('reading', 0, msg);
    const an = await ears.analyze(r.target, { signal: run.signal, onProgress: (_s, f) => opts.say('reading', f, msg) });
    opts.check();
    if (!an.ok || !an.data) {
      out.problem = an.message ?? 'The audio could not be analysed.';
      return out;
    }
    out.analysis = an.data;
    for (const [k, v] of Object.entries(r.projectStems)) if (v) out.stems[k as MashupStem] = { path: v, rmsDb: null };
    if (r.stemOf || !ears.stemFiles || STEMS.every((x) => out.stems[x])) return out;
    const sr = await ears.stemFiles(r.target, { cachedOnly: true }, { signal: run.signal });
    opts.check();
    if (sr.ok) addStems(out, sr.data?.stems);
    opts.say('reading', 1, msg);
    return out;
  }

  /** Separate a song (HT-Demucs, cached per file) for the stems the plan needs. Never edits. */
  private async separate(read: SongRead, run: MashupRun, opts: { say: Say; check: () => void }): Promise<void> {
    const ears = this.deps.analyzer!;
    const r = read.r!;
    const msg = `Splitting "${r.name}" into stems (HT-Demucs)…`;
    opts.say('separating', 0, msg);
    const sr = await ears.stemFiles!(r.target, {}, { signal: run.signal, onProgress: (_s, f) => opts.say('separating', f, msg) });
    opts.check();
    if (!sr.ok) {
      read.problem = `Stem separation failed: ${sr.message ?? 'unknown error'}`;
      return;
    }
    if (!sr.data) {
      read.problem = 'No stem model is installed: install HT-Demucs in Home ▸ Model Manager.';
      return;
    }
    addStems(read, sr.data.stems);
    opts.say('separating', 1, msg);
  }

  /** Where the vocal sings: the vocal stem's loudness per analysis section (fingerprint, cached). */
  private async vocalActivity(read: SongRead, run: MashupRun, check: () => void): Promise<void> {
    const ears = this.deps.analyzer;
    const voc = read.stems.vocals?.path;
    const secs = read.analysis?.sections ?? [];
    if (!ears?.fingerprint || !voc || !secs.length) return;
    const r = await ears.fingerprint(voc, secs.map((s) => ({ startSec: s.startSec, endSec: s.endSec })), { pitch: false }, { signal: run.signal }).catch(() => null);
    check();
    const rms = r?.ok && r.data ? r.data.segments.map((x) => (x && Number.isFinite(x.rmsDb) && x.lengthSec > 0 ? x.rmsDb : -120)) : null;
    if (!rms || rms.length !== secs.length) return;
    const top = Math.max(...rms);
    read.vocalBySection = rms.map((v) => (top > -60 && v > -50 && v >= top - 15 ? 1 : 0));
  }

  /** The notes the stems play (pitch profiles, light analyzer reads, cached per file): the key fit. Stems not there are skipped. */
  private async readHarmony(read: SongRead, run: MashupRun, check: () => void): Promise<void> {
    const ears = this.deps.analyzer;
    if (!ears || !read.r || !read.analysis) return;
    const h = (read.harmony ??= {});
    const light = async (file: string | undefined): Promise<AudioAnalysis | null> => {
      if (!file) return null;
      const r = await ears.analyze({ path: file }, { light: true, signal: run.signal }).catch(() => null);
      check();
      return r?.ok && r.data && goodProfile(r.data.pitchProfile) ? r.data : null;
    };
    if (!h.vocal) {
      const v = await light(read.stems.vocals?.path);
      if (v) h.vocal = { profile: v.pitchProfile!, key: v.key?.name ?? null, keyConfidence: v.key?.confidence ?? 0 };
    }
    if (!h.bed && read.stems.bass && read.stems.other) {
      const parts = [await light(read.stems.bass.path), await light(read.stems.other.path)];
      // The key comes from the summed profile (planner), not from either part alone (a bass line reads as minor easily).
      const profile = sumProfiles(parts.map((x) => x?.pitchProfile));
      if (profile) h.bed = { profile, key: null, keyConfidence: 0 };
    }
  }

  /** A SongRead → the planner's input. */
  private songInput(read: SongRead, side: Side, canSeparate: boolean): SongInput {
    const r = read.r;
    const name = r?.name ?? `Song ${letter(side)}`;
    const a = read.analysis;
    if (!r || !a) {
      return { name, ...(r && 'path' in r.target ? { path: r.abs } : {}), durationSec: 0, bpm: null, bpmAlternatives: [], key: null, keyConfidence: 0, vocalPresence: 0, vocalSource: 'unknown', kind: 'song', stems: [], canSeparate: false, grid: null, sections: [], problem: read.problem ?? 'The song could not be read.' };
    }
    // Vocal presence: the vocal stem against the loudest stem, else the stem origin / file name, else unknown.
    let vp = 0.5;
    let source: SongInput['vocalSource'] = 'unknown';
    let kind: SongInput['kind'] = 'song';
    const rms = (s: MashupStem) => read.stems[s]?.rmsDb ?? null;
    const allRms = STEMS.map(rms).filter((x): x is number => x !== null);
    const voc = rms('vocals');
    if (r.stemOf) {
      source = 'name';
      if (r.stemOf === 'vocals') {
        vp = 1;
        kind = 'acapella';
      } else {
        vp = 0;
        kind = 'instrumental';
      }
    } else if (voc !== null && allRms.length >= 2) {
      source = 'stems';
      const loudest = Math.max(...allRms);
      vp = clamp01((voc - loudest + 24) / 18);
      const others = (['drums', 'bass', 'other'] as MashupStem[]).map(rms).filter((x): x is number => x !== null);
      if (vp < 0.1) kind = 'instrumental';
      else if (others.length && others.every((x) => x < -55 || x < voc - 30)) kind = 'acapella';
    } else {
      const n = r.name.toLowerCase();
      if (/\b(a ?cap+el+a|acapella|vocals? only|vox only|dry vocals?)\b/.test(n)) {
        vp = 1;
        kind = 'acapella';
        source = 'name';
      } else if (/\b(instrumental|inst|karaoke|no vocals?)\b/.test(n)) {
        vp = 0;
        kind = 'instrumental';
        source = 'name';
      }
    }
    const activity = read.vocalBySection;
    // An a cappella / instrumental file plays as itself: its own notes.
    const own: StemHarmony | null = goodProfile(a.pitchProfile) ? { profile: a.pitchProfile, key: a.key?.name ?? null, keyConfidence: a.key?.confidence ?? 0 } : null;
    const harmony = { vocal: read.harmony?.vocal ?? (kind === 'acapella' ? own : null), bed: read.harmony?.bed ?? (kind === 'instrumental' ? own : null) };
    const lufs = a.levels?.lufsIntegrated;
    return {
      name,
      ...('path' in r.target ? { path: r.abs } : {}),
      durationSec: a.durationSec,
      bpm: a.tempo?.bpm ?? null,
      bpmAlternatives: a.tempo?.alternatives ?? [],
      key: a.key?.name ?? null,
      keyConfidence: a.key?.confidence ?? 0,
      vocalPresence: vp,
      vocalSource: source,
      kind,
      stems: STEMS.filter((s) => !!read.stems[s]),
      canSeparate: canSeparate && !r.stemOf,
      grid: a.beats && a.beats.times.length >= 2 ? { beats: a.beats.times, downbeats: a.beats.downbeats, beatsPerBar: a.beats.beatsPerBar || 4 } : null,
      sections: a.sections.map((x, i) => ({ startSec: x.startSec, endSec: x.endSec, label: x.label, lufs: x.lufs, vocal: activity ? activity[i] ?? null : null })),
      ...(harmony.vocal || harmony.bed ? { harmony } : {}),
      ...(Number.isFinite(lufs) && lufs > -70 ? { lufs } : {}),
    };
  }

  private sayer(run: MashupRun, ranges: Partial<Record<MashupStage, [number, number]>> = STAGE_RANGE): Say {
    return (stage: MashupStage, within: number, message: string) => {
      const [lo, hi] = ranges[stage] ?? STAGE_RANGE[stage];
      try {
        run.progress?.({ stage, fraction: within < 0 ? -1 : lo + (hi - lo) * clamp01(within), message });
      } catch {
        /* progress is best-effort */
      }
    };
  }

  // ── check ──────────────────────────────────────────────────────────

  /** Read both songs and propose a plan. Edits nothing; separates nothing (stems are used when already there). */
  async check(req: MashupRequest, run: MashupRun = {}): Promise<ActionResult<MashupCheck>> {
    if (!this.deps.analyzer) return { ok: false, message: "Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so the songs can't be read." };
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (run.signal?.aborted) ctrl.abort();
    else run.signal?.addEventListener('abort', onAbort, { once: true });
    this.checking = ctrl;
    const signal = ctrl.signal;
    const check = () => {
      if (signal.aborted) throw new MashupCancelled();
    };
    // check only reads and plans: its own scale, so it ends at 1.
    const say = this.sayer(run, { reading: [0, 0.85], analyzing: [0.85, 0.95], planning: [0.95, 1] });
    try {
      const canSep = this.stemModelInstalled();
      const reads: Record<Side, SongRead> = { a: { r: null, analysis: null, stems: {}, vocalBySection: null }, b: { r: null, analysis: null, stems: {}, vocalBySection: null } };
      for (const side of SIDES) {
        const r = this.resolve(side, req[side]);
        const sub = part(say, side === 'a' ? 0 : 0.5, side === 'a' ? 0.5 : 1);
        if (typeof r === 'string') reads[side].problem = r;
        else reads[side] = await this.read(r, { signal }, { say: sub, check });
        await this.vocalActivity(reads[side], { signal }, check);
      }
      say('analyzing', 0, 'Reading the notes of the stems…');
      for (const side of SIDES) await this.readHarmony(reads[side], { signal }, check);
      say('planning', 0, 'Planning the mashup…');
      const plan = planMashup(req, this.songInput(reads.a, 'a', canSep), this.songInput(reads.b, 'b', canSep));
      say('planning', 1, 'Plan ready.');
      const c = plan.check;
      const verdict = c.problems.length ? `${c.problems.length} problem${c.problems.length === 1 ? '' : 's'} to fix first` : c.score >= 75 ? 'a good fit' : c.score >= 50 ? 'workable' : 'a hard fit';
      return { ok: true, message: `"${c.a.name}" + "${c.b.name}": ${c.score}/100, ${verdict}. ${c.plan.bpm} bpm${c.plan.key ? `, ${c.plan.key}` : ''}, ${c.plan.bars} bars in ${c.plan.sections.length} sections.`, data: c };
    } catch (e) {
      if (e instanceof MashupCancelled || signal.aborted) return { ok: false, message: 'Cancelled: nothing was changed.' };
      return { ok: false, message: `Couldn't check the mashup: ${errText(e)}` };
    } finally {
      run.signal?.removeEventListener('abort', onAbort);
      if (this.checking === ctrl) this.checking = null;
    }
  }

  // ── build ──────────────────────────────────────────────────────────

  async build(req: MashupRequest, into: MashupInto, run: MashupRun = {}): Promise<ActionResult<MashupOutcome>> {
    const deps = this.deps;
    if (!deps.analyzer) return { ok: false, message: "Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so a mashup can't be built." };
    if (this.running) return { ok: false, message: `Already building the mashup "${this.running.label}". Cancel it first, or wait for it to finish.` };
    const res: Record<Side, Resolved | string> = { a: this.resolve('a', req.a), b: this.resolve('b', req.b) };
    for (const side of SIDES) if (typeof res[side] === 'string') return { ok: false, message: `Song ${letter(side)}: ${res[side]}` };
    const ra = res.a as Resolved;
    const rb = res.b as Resolved;
    const label = `${ra.name} × ${rb.name}`.slice(0, 120);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (run.signal?.aborted) ctrl.abort();
    else run.signal?.addEventListener('abort', onAbort, { once: true });
    this.running = { label, ctrl, writing: false };
    const signal = ctrl.signal;
    const check = () => {
      if (signal.aborted) throw new MashupCancelled();
    };
    const say = this.sayer(run);
    const startVersion = deps.doc.version;
    try {
      const canSep = this.stemModelInstalled();
      // 1. Read (cached analysis + stems already there).
      const reads: Record<Side, SongRead> = { a: await this.read(ra, { signal }, { say: part(say, 0, 0.5), check }), b: await this.read(rb, { signal }, { say: part(say, 0.5, 1), check }) };
      for (const side of SIDES) if (reads[side].problem) return { ok: false, message: `Song ${letter(side)} ("${reads[side].r!.name}"): ${reads[side].problem}` };
      // 2. Separate what the plan needs.
      const first = planMashup(req, this.songInput(reads.a, 'a', canSep), this.songInput(reads.b, 'b', canSep), { noSuggestions: true });
      const toSplit = canSep ? SIDES.filter((side) => first.build.songs[side].needStems.some((s) => !reads[side].stems[s])) : [];
      for (const [i, side] of toSplit.entries()) {
        await this.separate(reads[side], { signal }, { say: part(say, i / toSplit.length, (i + 1) / toSplit.length), check });
        if (reads[side].problem) return { ok: false, message: `Song ${letter(side)} ("${reads[side].r!.name}"): ${reads[side].problem}` };
      }
      say('separating', 1, 'Stems ready.');
      // 3. Where each vocal sings, and what the stems play.
      say('analyzing', 0, 'Finding the vocal sections…');
      for (const side of SIDES) await this.vocalActivity(reads[side], { signal }, check);
      say('analyzing', 0.5, 'Reading the notes of the stems…');
      for (const side of SIDES) await this.readHarmony(reads[side], { signal }, check);
      // 4. Plan. The measured notes can turn the vocal round ('auto'): separate what that plan needs, then plan again.
      say('planning', 0, 'Planning the mashup…');
      let result = planMashup(req, this.songInput(reads.a, 'a', canSep), this.songInput(reads.b, 'b', canSep), { noSuggestions: true });
      const more = canSep ? SIDES.filter((side) => result.build.songs[side].needStems.some((s) => !reads[side].stems[s])) : [];
      if (more.length) {
        for (const side of more) {
          await this.separate(reads[side], { signal }, { say: () => {}, check });
          if (reads[side].problem) return { ok: false, message: `Song ${letter(side)} ("${reads[side].r!.name}"): ${reads[side].problem}` };
          await this.vocalActivity(reads[side], { signal }, check);
          await this.readHarmony(reads[side], { signal }, check);
        }
        result = planMashup(req, this.songInput(reads.a, 'a', canSep), this.songInput(reads.b, 'b', canSep), { noSuggestions: true });
      }
      const plan = result.build;
      if (result.check.problems.length) return { ok: false, message: `The mashup can't be built yet: ${result.check.problems.join(' ')}` };
      if (!plan.tracks.length) return { ok: false, message: 'Nothing to place: the plan has no audio tracks (check the stem picks).' };
      // Sample info of every file placed (clip lengths, warp limits).
      const files = new Map<string, { frames?: number; sampleRate?: number; channels?: number }>();
      for (const t of plan.tracks) {
        const f = fileOf(reads[t.song], t);
        if (!f || files.has(f.abs)) continue;
        const si = await deps.engine.sampleInfo(f.abs).catch(() => null);
        files.set(f.abs, si?.ok && si.data ? { frames: si.data.frames, sampleRate: si.data.sampleRate, channels: si.data.channels } : {});
      }
      check();
      // 5-6. Write: one group, no cancel from here on.
      if (into.kind === 'new' && !deps.project.opensNewTabs?.() && deps.doc.version !== startVersion && deps.project.status().dirty) {
        return { ok: false, message: `The project changed while the songs were being read, so nothing was replaced. Save it, then build the mashup again (the analysis is cached, so it's quick).` };
      }
      this.running.writing = true;
      say('building', 0, 'Building the mashup…');
      const out = await this.write(plan, reads, files, into, req, label, say);
      say('mixing', 1, 'Done.');
      const notes = [...plan.notes, ...out.notes];
      const outcome: MashupOutcome = { name: label, plan: result.check.plan, score: result.check.score, notes, tracks: out.tracks, rightsNote: MASHUP_RIGHTS_NOTE };
      const p = result.check.plan;
      return {
        ok: true,
        message: `${into.kind === 'new' ? `New project "${label}"` : `Added the mashup "${label}" to the project`}: ${p.style === 'vocalOverBeat' ? `${letter(p.vocalFrom ?? 'a')}'s vocal over ${letter(p.vocalFrom === 'a' ? 'b' : 'a')}'s instrumental` : p.style === 'stemBlend' ? 'a blend of both songs\' stems' : 'the two songs trading sections'}, ${p.bpm} bpm${p.key ? `, ${p.key}` : ''}, ${p.bars} bars in ${p.sections.length} sections, ${out.tracks} audio track${out.tracks === 1 ? '' : 's'}. Fit ${result.check.score}/100. One undo step removes it all.`,
        data: outcome,
      };
    } catch (e) {
      if (e instanceof MashupCancelled || (signal.aborted && !this.running?.writing)) return { ok: false, message: 'Cancelled: nothing was changed.' };
      return { ok: false, message: `Couldn't build the mashup "${label}": ${errText(e)}` };
    } finally {
      run.signal?.removeEventListener('abort', onAbort);
      this.running = null;
    }
  }

  // ── Writing (one history group) ────────────────────────────────────

  private async write(plan: BuildPlan, reads: Record<Side, SongRead>, files: Map<string, { frames?: number; sampleRate?: number; channels?: number }>, into: MashupInto, req: MashupRequest, label: string, say: Say): Promise<{ tracks: number; notes: string[] }> {
    const deps = this.deps;
    let ctx: RunCtx;
    let finish: (ok: boolean) => void = () => {};
    const fresh = into.kind === 'new';
    if (into.kind === 'new') {
      const np = deps.project.newProject?.();
      if (!np) throw new Error("a new project can't be created from here (use newProject: false to add it to the open project)");
      if (!np.ok) throw new Error(np.message ?? "couldn't create a new project");
      ({ ctx, finish } = groupCtx(deps, into.actor, `Auto Mashup "${label}"`));
    } else if (into.ctx) ctx = into.ctx;
    else ({ ctx, finish } = groupCtx(deps, into.actor, `Auto Mashup "${label}"`));
    let ok = false;
    try {
      const notes: string[] = [];
      const placed = this.place(ctx, plan, reads, files, fresh, notes);
      say('mixing', 0, 'Mixing: vocal chain, sends, ducking, transitions…');
      await this.mix(ctx, plan, placed, fresh, req, notes);
      if (fresh) ctx.exec('project.setMeta', { name: label.slice(0, 128) });
      ok = true;
      return { tracks: placed.length, notes };
    } catch (e) {
      throw new Error(`${errText(e)}${fresh ? ' (the new project was left empty)' : ' (nothing was changed)'}`);
    } finally {
      finish(ok);
    }
  }

  /** Tracks, clips per section, pitch, warp, markers, song mode. Returns the placed tracks with their channel / insert. */
  private place(ctx: RunCtx, plan: BuildPlan, reads: Record<Side, SongRead>, files: Map<string, { frames?: number; sampleRate?: number; channels?: number }>, fresh: boolean, notes: string[]): Array<{ t: PlannedTrack; channelId: string; insertId: string }> {
    const doc = this.deps.doc;
    const cat = doc.catalog;
    const ac = cat.plugins.find((x) => x.id === AUDIOCLIP);
    if (!ac) throw new Error("this build's Audio Clip instrument is missing");
    const has = (id: string) => ac.params.some((s) => s.id === id);
    const p0: Project = doc.project;
    if (fresh) {
      // The File ▸ New kit makes way for the songs.
      if (p0.channelOrder.length) ctx.exec('channels.remove', { ids: [...p0.channelOrder] });
      for (const id of p0.mixer.insertOrder) if (!p0.mixer.inserts[id].isMaster) ctx.exec('mixer.removeInsert', { id });
      ctx.exec('transport.set', { bpm: plan.bpm, timeSig: { num: 4, den: 4 } });
    } else {
      const from = p0.transport.bpm;
      if (Math.abs(from - plan.bpm) > 1e-6) {
        const keep = rescaleForTempo(p0, cat, from, plan.bpm);
        if (keep) ctx.exec(keep.cmd, keep.args);
        ctx.exec('transport.set', { bpm: plan.bpm });
        notes.push(`The project tempo changed from ${from} to ${plan.bpm} bpm.`);
      }
      if (p0.transport.timeSig.num !== 4 || p0.transport.timeSig.den !== 4) notes.push(`The project is in ${p0.transport.timeSig.num}/${p0.transport.timeSig.den}: the mashup's sections are 4/4 bars, so its markers sit off your bar lines.`);
      // The source clips would play under the mashup: mute their tracks.
      for (const side of SIDES) {
        const cid = reads[side].r?.clipId;
        const clip = cid ? doc.project.playlist.clips[cid] : undefined;
        if (clip && !doc.project.playlist.tracks[clip.trackId]?.mute) {
          ctx.exec('playlist.setTrack', { id: clip.trackId, mute: true });
          notes.push(`The track of "${reads[side].r!.name}" was muted (the mashup plays its parts on new tracks).`);
        }
      }
    }
    // Mashup bars are 4/4 bars of the shared tempo (a new project is set to 4/4).
    const barTicks = 4 * PPQ;
    const lanes = freeLanes(doc.project);
    const lane = (name: string): string => {
      const free = lanes.shift();
      if (free) {
        ctx.exec('playlist.setTrack', { id: free, name });
        return free;
      }
      return ctx.exec<{ id: string }>('playlist.addTrack', { name }).id;
    };
    const placed: Array<{ t: PlannedTrack; channelId: string; insertId: string }> = [];
    let unwarped = 0;
    for (const t of plan.tracks) {
      const read = reads[t.song];
      const f = fileOf(read, t);
      if (!f) {
        notes.push(`"${t.name}" was left out: its audio isn't there.`);
        continue;
      }
      const info = files.get(f.abs) ?? {};
      const trackId = lane(t.name);
      const r = ctx.exec<{ clipId: string; channelId: string; insertId: string }>('playlist.addAudio', { path: f.docPath, name: t.name, trackId, start: 0, ...(info.frames ? { frames: info.frames } : {}), ...(info.sampleRate ? { sampleRate: info.sampleRate } : {}), ...(info.channels ? { channels: info.channels } : {}) });
      // Level match: the plan's gain on the channel's own default; a boost past the channel's +1.9 dB goes on its insert.
      const vol0 = doc.project.channels[r.channelId]?.volume ?? 0.78;
      const want = vol0 * Math.pow(10, t.gainDb / 20);
      const chVol = Math.min(1.25, want);
      const insVol = Math.min(2, want / chVol);
      const r4 = (x: number) => Math.round(x * 10000) / 10000;
      ctx.exec('channels.set', { id: r.channelId, name: t.name, ...(t.gainDb ? { volume: r4(chVol) } : {}) });
      ctx.exec('mixer.setInsert', { id: r.insertId, name: t.name, ...(insVol > 1.0001 ? { volume: r4(insVol) } : {}) });
      const params: Record<string, number> = {};
      if (t.semitones && has('pitch')) {
        params.pitch = t.semitones;
        if (has('formant')) params.formant = t.formant ? 1 : 0;
      }
      if (Object.keys(params).length) ctx.exec('channels.setGenParams', { id: r.channelId, params });
      if (t.semitones && !has('pitch')) notes.push(`"${t.name}" should be pitched ${t.semitones} st, but this build's Audio Clip can't pitch-shift.`);
      // Warp onto the grid from the song's own beats (stems share their mix's timing).
      const d = plan.songs[t.song];
      const a = read.analysis!;
      const grid = a.beats && a.beats.times.length >= 2 ? { beats: a.beats.times, downbeats: a.beats.downbeats, beatsPerBar: a.beats.beatsPerBar || 4 } : null;
      let markers: Array<{ sec: number; beat: number }> | null = null;
      if (grid && a.tempo) {
        const db = grid.downbeats[0];
        let di = 0;
        if (db !== undefined) {
          let best = Infinity;
          grid.beats.forEach((x, i) => {
            if (Math.abs(x - db) < best) {
              best = Math.abs(x - db);
              di = i;
            }
          });
        }
        const w: ExecResult = ctx.tryExec('audio.autoWarp', { channelId: r.channelId, beatTimes: grid.beats.slice(0, 20000), downbeatIndex: di, beatsPerBar: Math.max(1, Math.min(16, Math.round(grid.beatsPerBar))), beatUnit: d.factor, every: 'bar', mode: t.warp });
        if (w.ok) markers = doc.project.channels[r.channelId]?.generator.warp?.markers ?? null;
        if (!markers || markers.length < 2) markers = null;
      }
      if (!markers) {
        unwarped++;
        if (d.srcBpm && has('tempo_sync') && has('src_bpm')) ctx.exec('channels.setGenParams', { id: r.channelId, params: { tempo_sync: 1, src_bpm: d.srcBpm } });
      }
      const bpmNow = doc.project.transport.bpm;
      const tickOf = (songBar: number): number => {
        const sec = songBarToSec(grid, a.tempo?.bpm ?? null, d.factor, songBar);
        if (markers) return (secToBeat(markers as never, sec) ?? 0) * PPQ;
        const tickBpm = d.srcBpm && has('tempo_sync') ? d.srcBpm : bpmNow;
        return sec * (tickBpm / 60) * PPQ;
      };
      const updates: Array<Record<string, unknown>> = [];
      t.clips.forEach((c, i) => {
        const start = (c.startBar - 1) * barTicks;
        const length = Math.max(1, c.bars * barTicks);
        const offset = Math.max(0, Math.round(tickOf(c.songBar)));
        const fades = { ...(c.fadeIn ? { fadeIn: Math.round(c.fadeIn * PPQ) } : {}), ...(c.fadeOut ? { fadeOut: Math.round(c.fadeOut * PPQ) } : {}) };
        if (i === 0) updates.push({ id: r.clipId, start, length, offset, ...fades });
        else {
          const id = ctx.exec<{ id: string }>('playlist.addClip', { kind: 'audio', trackId, start, length, offset, channelId: r.channelId }).id;
          if (c.fadeIn || c.fadeOut) updates.push({ id, ...fades });
        }
      });
      if (updates.length) ctx.exec('playlist.updateClips', { updates });
      placed.push({ t, channelId: r.channelId, insertId: r.insertId });
    }
    if (!placed.length) throw new Error('none of the planned tracks could be placed');
    if (unwarped) notes.push(`${unwarped === placed.length ? 'The audio' : `${unwarped} track${unwarped === 1 ? '' : 's'}`} couldn't be warped to the grid (no beat grid was found), so ${unwarped === 1 ? 'it follows' : 'they follow'} the tempo from the detected bpm only: listen for drift.`);
    for (const s of plan.sections) ctx.exec('playlist.addMarker', { tick: (s.startBar - 1) * barTicks, name: s.name.slice(0, 64) });
    ctx.exec('transport.setMode', { mode: 'song' });
    return placed;
  }

  /** The vocal chain + sends, the bed ducking under the vocal, a master chain, transitions. Failures become notes. */
  private async mix(ctx: RunCtx, plan: BuildPlan, placed: Array<{ t: PlannedTrack; channelId: string; insertId: string }>, fresh: boolean, req: MashupRequest, notes: string[]): Promise<void> {
    const deps = this.deps;
    const tryTool = async (def: ToolDef, args: Record<string, unknown>, what: string): Promise<ToolResult | null> => {
      try {
        const parsed = def.input.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid arguments');
        return await def.run(deps, UI_CALLER, parsed.data as never, ctx);
      } catch (e) {
        notes.push(`${what} skipped: ${errText(e)}`);
        return null;
      }
    };
    const vocal = placed.find((x) => x.t.role === 'vocal');
    if (vocal) {
      await tryTool(applyChain, { chain: MASHUP_CHAINS.vocal, insert: vocal.insertId }, 'The vocal chain (EQ + compression)');
      if (plan.tune !== 'off') {
        const key = plan.tuneKey ? toKeyRef(plan.tuneKey) : null;
        if (!deps.doc.catalog.plugins.some((x) => x.id === TUNE_EFFECT)) notes.push("This build has no Krypt Tune, so the vocal isn't pitch-corrected.");
        else if (!key) notes.push("Krypt Tune was left off: the vocal's key couldn't be read (tune_vocal with a key adds it).");
        else {
          try {
            const tp = planTune(deps.doc.project, vocal.insertId, tuneKeyFor(key), plan.tune);
            for (const s of tp.steps) ctx.exec(s.cmd, s.args);
          } catch (e) {
            notes.push(`Krypt Tune skipped: ${errText(e)}`);
          }
        }
      }
      for (const send of [
        { chain: MASHUP_CHAINS.reverb, name: 'Vocal Reverb', db: -12 },
        { chain: MASHUP_CHAINS.delay, name: 'Vocal Delay', db: -18 },
      ]) {
        const made = await tryTool(applyChain, { chain: send.chain, insert: `new:${send.name}` }, `The ${send.name.toLowerCase()} send`);
        const id = (made?.data as { insertId?: string } | undefined)?.insertId;
        if (id) await tryTool(route, { from_insert: vocal.insertId, to: id, level_db: send.db, exclusive: false }, `Sending the vocal to ${send.name}`);
      }
      // Carve room for the vocal: the bed's Other stem (or the whole instrumental) ducks a little under it.
      const bed = placed.filter((x) => x.t.song !== vocal.t.song && (x.t.role === 'other' || x.t.role === 'mix'));
      for (const b of bed) await tryTool(sidechain, { source: vocal.insertId, target: b.insertId, style: 'duck', depth: b.t.role === 'other' ? 30 : 20, release_ms: 220 }, `Ducking "${b.t.name}" under the vocal`);
    }
    if (fresh) await tryTool(applyChain, { chain: MASHUP_CHAINS.master, insert: 'master' }, 'The master chain');
    else notes.push('Your master chain was left as it was.');
    if (req.transitions !== false && plan.transitions.length) {
      const calls = new Map<string, { kind: string; at_bars: number[]; length_bars?: number }>();
      for (const tr of plan.transitions) {
        if (!(TRANSITION_KINDS as readonly string[]).includes(tr.kind)) continue;
        const len = transitionLength(tr.kind, tr.prevBars);
        const k = `${tr.kind}|${len ?? ''}`;
        const c = calls.get(k) ?? { kind: tr.kind, at_bars: [], ...(len !== undefined ? { length_bars: len } : {}) };
        if (!c.at_bars.includes(tr.bar)) c.at_bars.push(tr.bar);
        calls.set(k, c);
      }
      for (const c of calls.values()) await tryTool(addTransition, { ...c, at_bars: c.at_bars.slice(0, 32) }, `The ${c.kind} at bar${c.at_bars.length === 1 ? '' : 's'} ${c.at_bars.join(', ')}`);
    }
  }
}

/** The file a planned track plays: the song's stem, or the song itself. */
function fileOf(read: SongRead, t: PlannedTrack): { abs: string; docPath: string } | null {
  if (!read.r) return null;
  if (t.part === 'mix') return { abs: read.r.abs, docPath: read.r.docPath };
  const s = read.stems[t.part];
  return s ? { abs: s.path, docPath: s.path } : null;
}

/** Empty playlist lanes below the last one that holds clips, in order. */
function freeLanes(p: Project): string[] {
  const used = new Set(Object.values(p.playlist.clips).map((c) => c.trackId));
  let last = -1;
  p.playlist.trackOrder.forEach((t, i) => {
    if (used.has(t)) last = i;
  });
  return p.playlist.trackOrder.slice(last + 1).filter((t) => !used.has(t));
}

/** A RunCtx over one new history group of `actor`; finish(false) rolls the group back. */
export function groupCtx(deps: MainDeps, actor: Actor, label: string): { ctx: RunCtx; finish(ok: boolean): void } {
  const doc = deps.doc;
  const groupId = doc.beginGroup(actor, label.slice(0, 120));
  const opts = { actor, groupId };
  const ctx: RunCtx = {
    groupId,
    exec<T>(cmd: string, args: unknown): T {
      const r = doc.exec<T>(cmd, args, opts);
      if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
      return r.data as T;
    },
    execBatch(steps) {
      const r = doc.execBatch(steps, opts);
      if (!r.ok) throw new Error(r.message ?? 'batch failed');
      return (r.data as unknown[]) ?? [];
    },
    tryExec<T>(cmd: string, args: unknown): ExecResult<T> {
      return doc.exec<T>(cmd, args, opts);
    },
  };
  return {
    ctx,
    finish(ok: boolean) {
      doc.endGroup(groupId);
      if (ok) return;
      const entry = doc.getHistory().find((h) => h.groupId === groupId && !h.undone);
      if (entry) doc.toggleEntry(entry.id, actor);
    },
  };
}

