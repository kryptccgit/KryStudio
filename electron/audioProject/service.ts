import path from 'node:path';
import type { Actor } from '@shared/doc/DocHost';
import type { StemName, TranscribedNote } from '@shared/analyzer/protocol';
import type { ActionResult, AudioProjectOptions, AudioProjectOutcome, AudioProjectProgress, AudioProjectStage, AudioTarget } from '@shared/types';
import type { SoundFingerprint } from '@shared/sound-match/types';
import { drumHighpassHz } from '@shared/sound-match/segments';
import type { GenreId } from '@shared/sounds/genres';
import type { SongTranscription, TranscribedPart, TranscriptionMode } from '@shared/transcription/types';
import { PPQ } from '@shared/schema/time';
import type { MainDeps } from '../mcp/types';
import type { StemFiles } from '../analyzer/service';
import { writeProject, type PartSound, type StemTrack, type WritePlan, type WriteResult, type Writer } from './build';
import type { MelodyShape, SongSources, TranscribeCore } from './core';
import { bestMatch, fallbackSound, libraryPresets, matchTarget, partRole, soundLine, type SoundMatcher } from './sounds';

export const OWNERSHIP_LINE = "If this isn't your song, use the result for practice and remix study, not for release.";

export type PartFilter = NonNullable<AudioProjectOptions['parts']>[number];

export interface PipelineRun {
  signal?: AbortSignal;
  progress?(p: AudioProjectProgress): void;
}

export interface PrepareOptions {
  mode: TranscriptionMode;
  mine?: boolean;
  factor?: 1 | 0.5 | 2;
  parts?: PartFilter[];
  keepStems?: boolean;
  genre?: GenreId | null;
  leadChannel?: boolean;
}

export interface Prepared {
  name: string;
  abs: string;
  sources: SongSources;
  t: SongTranscription;
  parts: TranscribedPart[];
  sounds: Record<string, PartSound>;
  lead: PartSound | null;
  melody: MelodyShape | null;
  stems: StemFiles | null;
  stemInfo: Partial<Record<StemName, { frames?: number; sampleRate?: number; channels?: number }>>;
  sectionGainDb: Record<string, number[]>;
  notes: string[];
}

export class PipelineCancelled extends Error {
  constructor() {
    super('Cancelled: nothing was changed.');
    this.name = 'PipelineCancelled';
  }
}

const STAGE_RANGE: Record<AudioProjectStage, [number, number]> = {
  analyzing: [0, 0.12],
  separating: [0.12, 0.55],
  transcribing: [0.55, 0.82],
  matching: [0.82, 0.92],
  building: [0.92, 1],
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface AudioProjectServiceDeps {
  deps: MainDeps;
  core: TranscribeCore | null;
  matcher?: SoundMatcher | null;
}

export class AudioProjectService {
  private running: { label: string; ctrl: AbortController } | null = null;

  constructor(private readonly s: AudioProjectServiceDeps) {}

  get busy(): string | null {
    return this.running?.label ?? null;
  }

  cancel(): ActionResult {
    if (!this.running) return { ok: false, message: 'No conversion is running' };
    this.running.ctrl.abort();
    return { ok: true, message: `Cancelling "${this.running.label}"…` };
  }

  async prepare(target: AudioTarget, abs: string, name: string, o: PrepareOptions, run: PipelineRun = {}): Promise<Prepared> {
    const ears = this.s.deps.analyzer;
    if (!ears) throw new Error("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log).");
    if (!this.s.core) throw new Error("This build can't transcribe songs yet (the transcription core is missing). Update Krypt Studio.");
    const notes: string[] = [];
    const say = (stage: AudioProjectStage, within: number, message: string) => {
      const [a, b] = STAGE_RANGE[stage];
      try {
        run.progress?.({ stage, fraction: within < 0 ? -1 : a + (b - a) * clamp01(within), message });
      } catch {
      }
    };
    const check = () => {
      if (run.signal?.aborted) throw new PipelineCancelled();
    };
    const jobRun = (stage: AudioProjectStage, message: string) => ({ signal: run.signal, onProgress: (_s: string, f: number) => say(stage, f, message) });

    say('analyzing', 0, `Listening to "${name}": tempo, beats, key, sections…`);
    const an = await ears.analyze(target, { ...jobRun('analyzing', `Listening to "${name}": tempo, beats, key, sections…`), drums: true });
    check();
    if (!an.ok || !an.data) throw new Error(an.message ?? 'Analysis failed');
    const analysis = an.data;
    if (!analysis.tempo) notes.push('No steady tempo was found, so the grid runs at a fixed tempo: expect the notes to drift off the bars.');

    let stems: StemFiles | null = null;
    if (ears.stemFiles) {
      say('separating', 0, 'Splitting the song into stems (HT-Demucs)…');
      const sr = await ears.stemFiles(target, {}, jobRun('separating', 'Splitting the song into stems (HT-Demucs)…'));
      check();
      if (sr.ok) stems = sr.data ?? null;
      else notes.push(`Stem separation failed (${sr.message ?? 'unknown error'}), so everything was read from the full mix.`);
    }
    if (!stems && !notes.some((n) => n.startsWith('Stem separation failed'))) {
      notes.push('No stem model is installed (Model Manager ▸ HT-Demucs), so everything was read from the full mix: expect missing and extra notes, and the vocal stays inside the mix (no vocal track).');
    }
    say('separating', 1, stems ? `Stems ready (${stems.modelName}${stems.cached ? ', cached' : ''}).` : 'No stems: reading the full mix.');

    const stemPath = (n: StemName) => stems?.stems[n]?.path ?? null;
    const sources: SongSources = { name, analysis, drumHits: [], drumSource: 'none', bass: null, other: null, vocals: null, mix: null, stems: {}, genre: o.genre ?? null, notes };
    for (const [k, v] of Object.entries(stems?.stems ?? {})) if (v) sources.stems[k as StemName] = v.path;
    const polyInstalled = (ears.listModels?.() ?? []).some((m) => m.def.task === 'transcribe' && m.status === 'installed');
    const steps: Array<{ label: string; run: () => Promise<void> }> = [];
    const tr = async (file: string, mode: 'poly' | 'mono' | 'drums', what: string, range: { maxKey?: number; minKey?: number } = {}): Promise<{ notes: TranscribedNote[]; hits: SongSources['drumHits'] } | null> => {
      if (!ears.transcribeFile) return null;
      const r = await ears.transcribeFile(file, mode, { ...range, name: `${name} (${what})` }, jobRun('transcribing', `Transcribing the ${what}…`));
      check();
      if (!r.ok || !r.data) {
        notes.push(`The ${what} couldn't be transcribed (${r.message ?? 'unknown error'}).`);
        return null;
      }
      return { notes: r.data.notes ?? [], hits: r.data.hits ?? [] };
    };
    const drumsFile = stemPath('drums');
    steps.push({
      label: 'drums',
      run: async () => {
        if (drumsFile) {
          const r = await tr(drumsFile, 'drums', 'drums');
          if (r && r.hits.length) {
            sources.drumHits = r.hits;
            sources.drumSource = 'stem';
            return;
          }
        }
        if (analysis.drumHits?.length) {
          sources.drumHits = analysis.drumHits;
          sources.drumSource = 'mix';
        }
      },
    });
    const bassFile = stemPath('bass');
    if (bassFile) steps.push({ label: 'bass', run: async () => void (sources.bass = (await tr(bassFile, 'mono', 'bass', { maxKey: 60 }))?.notes ?? null) });
    const otherFile = stemPath('other');
    if (otherFile) {
      steps.push({
        label: 'chords and lead',
        run: async () => {
          if (!polyInstalled) notes.push("Basic Pitch isn't installed, so the chords come from the analyzer's chord reading and the lead from the other stem's top line only.");
          sources.other = (await tr(otherFile, polyInstalled ? 'poly' : 'mono', 'chords and lead'))?.notes ?? null;
        },
      });
    }
    const vocalFile = stemPath('vocals');
    if (vocalFile) steps.push({ label: 'vocal melody', run: async () => void (sources.vocals = (await tr(vocalFile, 'mono', 'vocal melody'))?.notes ?? null) });
    if (!stems && polyInstalled) steps.push({ label: 'notes of the mix', run: async () => void (sources.mix = (await tr(abs, 'poly', 'notes of the mix'))?.notes ?? null) });
    if (!stems && !polyInstalled) notes.push("Basic Pitch isn't installed either, so the bass and chords follow the analyzer's chord reading only.");
    for (let i = 0; i < steps.length; i++) {
      say('transcribing', i / Math.max(1, steps.length), `Transcribing the ${steps[i].label}…`);
      await steps[i].run();
    }
    check();
    if (sources.drumSource === 'none') notes.push('No drum hits were found.');
    else if (sources.drumSource === 'mix' && stems) notes.push('The drum stem gave no hits, so the drums were read from the full mix.');

    let t: SongTranscription;
    try {
      t = this.s.core.transcribeSong(sources, { mode: o.mode, mine: o.mine, factor: o.factor });
    } catch (e) {
      throw new Error(`The song couldn't be put on the grid: ${errText(e)}`);
    }
    for (const n of t.notes) if (!notes.includes(n)) notes.push(n);
    const keep = new Set<PartFilter>(o.parts?.length ? o.parts : ['drums', 'bass', 'chords', 'lead']);
    const parts = t.parts.filter((p) => {
      if (p.kind === 'vocal-audio') return false;
      if (o.mode === 'style' && !o.mine && p.kind === 'lead') return false;
      if (p.kind === 'drum') return keep.has('drums');
      if (p.kind === 'bass') return keep.has('bass');
      if (p.kind === 'chords') return keep.has('chords');
      return keep.has('lead');
    });
    if (!parts.length) throw new Error(`Nothing to write: no ${o.parts?.length ? o.parts.join(' / ') : 'drums, bass, chords or lead'} were found in "${name}".`);
    let melody: MelodyShape | null = null;
    try {
      melody = this.s.core.melodyShape?.(sources, { factor: o.factor }) ?? null;
    } catch (e) {
      notes.push(`The melody shape couldn't be read (${errText(e)}).`);
    }

    say('matching', 0, 'Finding the closest sounds…');
    const deps = this.s.deps;
    const presets = libraryPresets(deps);
    const genre = o.genre ?? null;
    const sounds: Record<string, PartSound> = {};
    let fpProblem: string | null = ears.fingerprint ? null : "this analyzer can't measure sounds yet";
    let matchProblem: string | null = null;
    const secOf = (tick: number) => t.firstDownbeatSec + (tick / PPQ) * (60 / t.bpm);
    const fileOf = (stem: TranscribedPart['stem']) => (stem === 'mix' ? abs : (stemPath(stem) ?? abs));
    const fingerprintsOf = async (file: string, segs: Array<{ startSec: number; endSec: number }>, highpassHz: number | null = null): Promise<SoundFingerprint[]> => {
      if (!ears.fingerprint || fpProblem || !segs.length) return [];
      const r = await ears.fingerprint(file, segs, { highpassHz }, { signal: run.signal });
      check();
      if (!r.ok || !r.data) {
        fpProblem = r.message ?? 'measuring failed';
        return [];
      }
      return r.data.segments.filter((x) => x && Number.isFinite(x.centroidHz));
    };
    const matchFor = async (part: Pick<TranscribedPart, 'kind' | 'name' | 'drumRole'>, file: string, segs: Array<{ startSec: number; endSec: number }>): Promise<PartSound> => {
      const role = partRole(part);
      if (this.s.matcher && !matchProblem) {
        const fps = await fingerprintsOf(file, segs, part.kind === 'drum' && part.drumRole ? drumHighpassHz(part.drumRole) : null);
        if (fps.length) {
          const ms = await this.s.matcher(fps, matchTarget(part)).catch((e) => ({ ok: false as const, problem: errText(e) }));
          check();
          if (!ms.ok) matchProblem = ms.problem;
          else {
            const best = bestMatch(deps, presets, ms.matches, role);
            if (best) return best;
          }
        }
      }
      return fallbackSound(deps, presets, part, genre);
    };
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      say('matching', i / (parts.length + 1), `Finding a sound for the ${part.name.toLowerCase()}…`);
      sounds[part.name] = await matchFor(part, fileOf(part.stem), segmentsOf(part, secOf));
    }
    let lead: PartSound | null = null;
    if (o.leadChannel) {
      const line = sources.vocals?.length ? { file: stemPath('vocals') ?? abs, notes: sources.vocals } : sources.other?.length ? { file: stemPath('other') ?? abs, notes: sources.other } : null;
      const segs = line ? [...line.notes].sort((a, b) => b.vel - a.vel).slice(0, 10).map((n) => ({ startSec: n.startSec, endSec: n.startSec + Math.min(Math.max(n.durSec, 0.1), 0.8) })) : [];
      lead = await matchFor({ kind: 'lead', name: 'Lead' }, line?.file ?? abs, segs);
    }
    if (!this.s.matcher) notes.push("Sound matching isn't available in this build, so the sounds were picked by role and genre.");
    else if (matchProblem) notes.push(`${String(matchProblem).replace(/\s+$/, '')} The sounds were picked by role and genre instead.`);
    else if (fpProblem) notes.push(`The sounds couldn't be measured (${fpProblem}), so they were picked by role and genre.`);
    say('matching', 1, 'Sounds chosen.');

    const stemInfo: Prepared['stemInfo'] = {};
    if (stems && deps.engine?.sampleInfo) {
      for (const [k, v] of Object.entries(stems.stems)) {
        if (!v) continue;
        const si = await deps.engine.sampleInfo(v.path).catch(() => null);
        if (si?.ok && si.data) stemInfo[k as StemName] = { frames: si.data.frames, sampleRate: si.data.sampleRate, channels: si.data.channels };
      }
      check();
    }
    const sectionGainDb: Record<string, number[]> = {};
    if (stems && ears.fingerprint && t.sections.length > 1) {
      const barSec = (60 / t.bpm) * Math.max(1, t.beatsPerBar || 4);
      const segs = t.sections.map((s) => ({ startSec: t.firstDownbeatSec + (s.startBar - 1) * barSec, endSec: t.firstDownbeatSec + (s.startBar - 1 + s.bars) * barSec }));
      const perStem = new Map<string, number[] | null>();
      for (const part of parts) {
        const file = part.stem === 'mix' ? null : stemPath(part.stem);
        if (!file) continue;
        if (!perStem.has(file)) {
          const r = await ears.fingerprint(file, segs, { pitch: false }, { signal: run.signal }).catch(() => null);
          check();
          const rms = r?.ok && r.data ? r.data.segments.map((x) => (x && Number.isFinite(x.rmsDb) && x.lengthSec > 0 ? x.rmsDb : -120)) : null;
          perStem.set(file, rms && rms.length === segs.length ? rms : null);
        }
        const rms = perStem.get(file);
        if (!rms) continue;
        const top = Math.max(...rms);
        if (top > -90) sectionGainDb[part.name] = rms.map((v) => Math.max(-60, Math.min(0, v - top)));
      }
    }
    return { name, abs, sources, t, parts, sounds, lead, melody, stems, stemInfo, sectionGainDb, notes };
  }

  write(plan: WritePlan, how: { writer: Writer } | { fresh: { actor: Actor; label: string } }): WriteResult {
    const doc = this.s.deps.doc;
    const current = () => doc.project;
    if ('writer' in how) return writeProject(how.writer, current, doc.catalog, plan);
    const np = this.s.deps.project.newProject?.();
    if (!np) throw new Error("A new project can't be created from here.");
    if (!np.ok) throw new Error(np.message ?? "Couldn't create a new project");
    const { actor, label } = how.fresh;
    const groupId = doc.beginGroup(actor, label.slice(0, 120));
    const writer: Writer = {
      exec<T>(cmd: string, args: unknown): T {
        const r = doc.exec<T>(cmd, args, { actor, groupId });
        if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
        return r.data as T;
      },
    };
    try {
      return writeProject(writer, current, doc.catalog, plan);
    } catch (e) {
      const entry = doc.getHistory().find((h) => h.groupId === groupId && !h.undone);
      if (entry) doc.toggleEntry(entry.id, actor);
      throw new Error(`${errText(e)} (the new project was left empty)`);
    } finally {
      doc.endGroup(groupId);
    }
  }

  async convert(abs: string, opts: AudioProjectOptions, into: { kind: 'new'; actor: Actor } | { kind: 'current'; writer: Writer }, run: PipelineRun = {}): Promise<ActionResult<AudioProjectOutcome>> {
    const name = path.basename(abs).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Song';
    const doc = this.s.deps.doc;
    const startVersion = doc.version;
    return this.exclusive(name, run.signal, async (signal) => {
      try {
        const keepStems = opts.keepStems !== false;
        const prep = await this.prepare({ path: abs }, abs, name, { mode: 'exact', factor: opts.factor, parts: opts.parts, keepStems, genre: null }, { signal, progress: run.progress });
        if (signal.aborted) throw new PipelineCancelled();
        run.progress?.({ stage: 'building', fraction: STAGE_RANGE.building[0], message: 'Building the project…' });
        if (into.kind === 'new' && !this.s.deps.project.opensNewTabs?.() && doc.version !== startVersion && this.s.deps.project.status().dirty) {
          return { ok: false, message: `The project changed while "${name}" was being read, so nothing was replaced. Save it, then open the audio again (the analysis is cached, so it's quick).` };
        }
        const plan = this.exactPlan(prep, keepStems, into.kind === 'new');
        const res = into.kind === 'new' ? this.write(plan, { fresh: { actor: into.actor, label: `Audio → project "${name}"` } }) : this.write(plan, { writer: into.writer });
        run.progress?.({ stage: 'building', fraction: 1, message: 'Done.' });
        return { ok: true, message: outcomeMessage(prep, res, into.kind === 'new'), data: this.outcome(prep, res, plan) };
      } catch (e) {
        if (e instanceof PipelineCancelled || signal.aborted) return { ok: false, message: 'Cancelled: nothing was changed.' };
        return { ok: false, message: `Couldn't turn "${name}" into a project: ${errText(e)}` };
      }
    });
  }

  async exclusive<T>(label: string, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    if (this.running) return { ok: false, message: `Already converting "${this.running.label}". Cancel it first, or wait for it to finish.` };
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (outer?.aborted) ctrl.abort();
    else outer?.addEventListener('abort', onAbort, { once: true });
    this.running = { label, ctrl };
    try {
      return await fn(ctrl.signal);
    } finally {
      outer?.removeEventListener('abort', onAbort);
      this.running = null;
    }
  }

  exactPlan(prep: Prepared, keepStems: boolean, fresh: boolean): WritePlan {
    const stems: StemTrack[] = [];
    if (prep.stems) {
      const order: StemName[] = ['vocals', 'drums', 'bass', 'other', 'piano', 'guitar'];
      for (const stem of order) {
        const f = prep.stems.stems[stem];
        if (!f) continue;
        if (stem !== 'vocals' && !keepStems) continue;
        stems.push({ stem, path: f.path, ...prep.stemInfo[stem], mute: stem !== 'vocals' });
      }
    }
    return {
      t: prep.t,
      parts: prep.parts,
      sounds: prep.sounds,
      empty: [],
      stems,
      sidechain: pumps(prep.t) ? prep.parts.filter((p) => p.kind === 'bass').map((p) => p.name) : [],
      levelsDb: {},
      sectionGainDb: prep.sectionGainDb,
      clearDefault: fresh,
      title: fresh ? prep.name : null,
      stemPrefix: prep.name.slice(0, 40),
      setTransport: true,
    };
  }

  outcome(prep: Prepared, res: WriteResult, plan: WritePlan, ownership = true): AudioProjectOutcome {
    const sounds = [...prep.parts.map((p) => soundLine(p.name, prep.sounds[p.name])), ...plan.empty.map((e) => soundLine(e.name, e.sound))];
    const notes = [...prep.notes, ...res.notesText];
    if (plan.sidechain.length) notes.push(`The song pumps, so ${plan.sidechain.join(', ')} duck${plan.sidechain.length === 1 ? 's' : ''} under the kick (Krypt Duck).`);
    if (ownership) notes.push(OWNERSHIP_LINE);
    return {
      name: prep.name,
      bpm: prep.t.bpm,
      key: prep.t.key,
      bars: prep.t.totalBars,
      sections: prep.t.sections.length,
      channels: Object.keys(res.channelIds).length,
      patterns: res.patternIds.length,
      sounds,
      notes,
      stemsKept: plan.stems.some((s) => s.mute),
    };
  }
}

export function segmentsOf(part: TranscribedPart, secOf: (tick: number) => number): Array<{ startSec: number; endSec: number }> {
  const win = (durSec: number) => (part.kind === 'drum' ? 0.25 : part.kind === 'chords' ? Math.min(Math.max(durSec, 0.2), 2) : Math.min(Math.max(durSec, 0.1), 0.8));
  return [...part.notes]
    .sort((a, b) => b.vel - a.vel)
    .slice(0, 12)
    .map((n) => {
      const s = secOf(n.tick);
      return { startSec: Math.max(0, s), endSec: Math.max(0, s) + win(secOf(n.tick + n.dur) - s) };
    })
    .sort((a, b) => a.startSec - b.startSec);
}

export function pumps(t: SongTranscription): boolean {
  const kick = t.parts.find((p) => p.kind === 'drum' && p.drumRole === 'kick');
  if (!kick || !t.sections.length || !t.parts.some((p) => p.kind === 'bass')) return false;
  const loud = [...t.sections].sort((a, b) => b.energy - a.energy)[0];
  const bpb = Math.max(1, Math.round(t.beatsPerBar || 4));
  const start = (loud.startBar - 1) * bpb * PPQ;
  const end = start + loud.bars * bpb * PPQ;
  const beats = new Set<number>();
  for (const n of kick.notes) {
    if (n.tick < start || n.tick >= end) continue;
    const off = n.tick % PPQ;
    if (off < PPQ / 8 || off > PPQ - PPQ / 8) beats.add(Math.round(n.tick / PPQ));
  }
  return beats.size >= 0.7 * loud.bars * bpb;
}

function outcomeMessage(prep: Prepared, res: WriteResult, fresh: boolean): string {
  const t = prep.t;
  return `${fresh ? `New project "${prep.name}"` : `Added "${prep.name}" to the project`}: ${t.bpm} bpm${t.key ? `, ${t.key}` : ''}, ${t.totalBars} bars in ${t.sections.length} section${t.sections.length === 1 ? '' : 's'}, ${Object.keys(res.channelIds).length} channels, ${res.patternIds.length} patterns (${res.notes} notes)${res.stemTracks.length ? `, ${res.stemTracks.length} stem track${res.stemTracks.length === 1 ? '' : 's'}` : ''}. One undo step removes it all.`;
}
