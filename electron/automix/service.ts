import path from 'node:path';
import type { Actor } from '@shared/doc/DocHost';
import type { ActionResult } from '@shared/types';
import type {
  AlbumExportOutcome,
  AlbumExportRequest,
  AlbumOutcome,
  AlbumRequest,
  AutoMixChange,
  AutoMixIntent,
  AutoMixMode,
  AutoMixOutcome,
  AutoMixPreset,
  AutoMixProgress,
  AutoMixRequest,
  AutoMixStage,
  MasterFileRequest,
  ReferenceMatch,
  ReferenceSound,
} from '@shared/automix/types';
import { AUTO_MIX_PRESETS, autoKeepsLoudness, autoPreset, presetById } from '@shared/automix/presets';
import { clampIntent, LUFS_RANGE, mergeIntents, parseIntent, tuneInText } from '@shared/automix/intent';
import { applyPlan, masterDrive, meetsTargets, planAutoMix, type ApplyIO, type PlanInput, type PlanMeasure } from '@shared/automix/plan';
import { cappedAgainstReference, closeness, fmtDb, referenceTarget } from '@shared/automix/reference';
import { detectRoles, type InsertInfo } from '@shared/automix/roles';
import { isAudioFile } from '@shared/audio/formats';
import { patternKey } from '@shared/vocals/plan';
import { tuneKeyFor } from '@shared/music/keymatch';
import { factoryChainPresets } from '@shared/sounds/factory';
import type { MainDeps } from '../mcp/types';
import type { RunCtx } from '../mcp/tools/types';
import { createAiIntent, type AiIntentFn } from './ai';
import { measureScope, publicMeasure, renderMeasure, type MeasureFn } from './measure';
import { readReference } from './reference';
import { exportAlbumImpl, masterAlbumImpl, type JobCtx } from './album';

export const MAX_PASSES = 3;

export interface AutoMixRun {
  signal?: AbortSignal;
  progress?(p: AutoMixProgress): void;
}

export interface AutoMixInto {
  actor: Actor;
  ctx?: RunCtx;
}

export class AutoMixCancelled extends Error {
  constructor() {
    super('Cancelled: nothing was changed.');
    this.name = 'AutoMixCancelled';
  }
}

const MODE_NAME: Record<AutoMixMode, string> = { vocals: 'Vocals', mix: 'Mix', master: 'Master', full: 'Mix + Master' };
const STAGE_RANGE: Record<AutoMixStage, [number, number]> = {
  understanding: [0, 0.05],
  measuring: [0.05, 0.3],
  planning: [0.3, 0.33],
  applying: [0.33, 0.4],
  refining: [0.4, 0.98],
  exporting: [0, 0.99],
  done: [1, 1],
};
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r1 = (x: number): number => Math.round(x * 10) / 10;
const sgn = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(r1(x))}`;

export interface AutoMixServiceDeps {
  deps: MainDeps;
  ai?: AiIntentFn | null;
  measure?: MeasureFn;
}

export class AutoMixService {
  private running: { label: string; ctrl: AbortController } | null = null;
  private readonly ai: AiIntentFn | null;
  private readonly measureFn: MeasureFn;

  constructor(private readonly s: AutoMixServiceDeps) {
    this.ai = s.ai === undefined ? createAiIntent(s.deps) : s.ai;
    this.measureFn = s.measure ?? renderMeasure;
  }

  private get deps(): MainDeps {
    return this.s.deps;
  }

  get busy(): string | null {
    return this.running?.label ?? null;
  }

  presets(): AutoMixPreset[] {
    return AUTO_MIX_PRESETS.map((p) => ({ ...p, tone: { ...p.tone }, genres: [...p.genres] }));
  }

  cancel(): ActionResult {
    if (!this.running) return { ok: false, message: 'Auto Mix is not running' };
    this.running.ctrl.abort();
    return { ok: true, message: `Cancelling Auto Mix (${this.running.label}): nothing will be changed.` };
  }

  private claim(label: string, run: AutoMixRun): { ctx: JobCtx; release(): void } | null {
    if (this.running) return null;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (run.signal?.aborted) ctrl.abort();
    else run.signal?.addEventListener('abort', onAbort, { once: true });
    this.running = { label, ctrl };
    const signal = ctrl.signal;
    return {
      ctx: {
        deps: this.deps,
        measure: this.measureFn,
        signal,
        check: () => {
          if (signal.aborted) throw new AutoMixCancelled();
        },
        say: this.sayer(run),
        understand: (prompt, useAi) => this.understand(prompt, { useAi, signal }),
        reference: (p) => readReference(this.deps, p, { signal }),
      },
      release: () => {
        run.signal?.removeEventListener('abort', onAbort);
        this.running = null;
      },
    };
  }

  async analyzeReference(p: string, opts: { signal?: AbortSignal } = {}): Promise<ActionResult<ReferenceSound>> {
    return readReference(this.deps, p, opts);
  }

  async playReference(p: string, matchLufs: number | null): Promise<ActionResult<{ gainDb: number }>> {
    const r = await readReference(this.deps, p);
    if (!r.ok || !r.data) return { ok: false, message: r.message ?? "Couldn't read the reference" };
    const ref = r.data;
    const want = typeof matchLufs === 'number' && Number.isFinite(matchLufs) ? matchLufs - ref.lufs : 0;
    const gainDb = r1(Math.max(-40, Math.min(12, want)));
    const res = await this.deps.engine.request({ cmd: 'previewFile', path: ref.path, gain: Math.pow(10, gainDb / 20) }, 15_000).catch((e) => ({ ok: false as const, message: errText(e) }));
    if (!res.ok) return { ok: false, message: `Couldn't play "${ref.name}": ${res.message ?? 'the audio engine refused'}` };
    const how =
      Math.abs(gainDb) < 0.3
        ? 'at its own level (already as loud as your result)'
        : `${Math.abs(gainDb).toFixed(1)} dB ${gainDb < 0 ? 'quieter' : 'louder'} than it is, so it is as loud as your result${Math.abs(want - gainDb) > 0.3 ? ' (as close as the preview allows)' : ''}`;
    return { ok: true, message: `Playing the reference "${ref.name}" from its start, ${how}.`, data: { gainDb } };
  }

  async masterAlbum(req: AlbumRequest, actor: Actor, run: AutoMixRun = {}): Promise<ActionResult<AlbumOutcome>> {
    const job = this.claim('Master an album', run);
    if (!job) return { ok: false, message: `Auto Mix is already running (${this.running?.label ?? 'another job'}): cancel it first, or wait for it to finish.` };
    try {
      return await masterAlbumImpl(job.ctx, req, actor);
    } finally {
      job.release();
    }
  }

  async exportAlbum(req: AlbumExportRequest, run: AutoMixRun = {}): Promise<ActionResult<AlbumExportOutcome>> {
    const job = this.claim('Exporting the album', run);
    if (!job) return { ok: false, message: `Auto Mix is busy (${this.running?.label ?? 'another job'}): wait for it to finish, or cancel it.` };
    try {
      return await exportAlbumImpl(job.ctx, req);
    } finally {
      job.release();
    }
  }

  async understand(prompt: string, opts: { useAi?: 'auto' | 'never'; signal?: AbortSignal } = {}): Promise<ActionResult<AutoMixIntent>> {
    const text = String(prompt ?? '').trim().slice(0, 2000);
    if (!text) return { ok: false, message: 'Type what you want (for example "vocals on top, punchy, not harsh, streaming loud").' };
    const kw = parseIntent(text);
    let intent: AutoMixIntent = kw;
    if (opts.useAi !== 'never' && this.ai) {
      const fromAi = await this.ai(text, opts.signal).catch(() => null);
      if (fromAi) intent = mergeIntents(clampIntent({ ...fromAi, ...(kw.targetLufs !== undefined && fromAi.targetLufs === undefined ? { targetLufs: kw.targetLufs } : {}) }, 'ai'), null)!;
    }
    return { ok: true, message: `Understood (${intent.source === 'ai' ? 'AI' : 'keywords'}): ${intent.summary || 'nothing specific, the preset as it is'}.`, data: intent };
  }

  private sayer(run: AutoMixRun) {
    return (stage: AutoMixStage, within: number, message: string) => {
      const [lo, hi] = STAGE_RANGE[stage];
      try {
        run.progress?.({ stage, fraction: within < 0 ? -1 : lo + (hi - lo) * Math.max(0, Math.min(1, within)), message });
      } catch {
      }
    };
  }

  async run(req: AutoMixRequest, into: AutoMixInto, run: AutoMixRun = {}, opts: { dryRun?: boolean } = {}): Promise<ActionResult<AutoMixOutcome>> {
    const mode = req.mode;
    if (!['vocals', 'mix', 'master', 'full'].includes(mode)) return { ok: false, message: `Unknown Auto Mix mode "${String(mode).slice(0, 20)}": use vocals, mix, master or full.` };
    if (this.running) return { ok: false, message: `Auto Mix is already running (${this.running.label}): cancel it first, or wait for it to finish.` };
    const label = `Auto ${mode === 'master' ? 'Master' : 'Mix'}${mode === 'full' ? ' + Master' : mode === 'vocals' ? ' (vocals)' : ''}`;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (run.signal?.aborted) ctrl.abort();
    else run.signal?.addEventListener('abort', onAbort, { once: true });
    this.running = { label, ctrl };
    const signal = ctrl.signal;
    const check = () => {
      if (signal.aborted) throw new AutoMixCancelled();
    };
    const say = this.sayer(run);
    const doc = this.deps.doc;
    const keepUserFx = req.keepUserFx !== false;
    let group: { id: string; own: boolean } | null = null;
    const rollback = (): boolean => {
      if (!group) return true;
      if (!group.own) {
        group = null;
        return true;
      }
      doc.endGroup(group.id);
      const entry = doc.getHistory().find((h) => h.groupId === group!.id && !h.undone);
      const ok = entry ? doc.toggleEntry(entry.id, into.actor).ok : true;
      group = null;
      return ok;
    };
    try {
      let intent: AutoMixIntent | null = null;
      if (req.prompt?.trim()) {
        say('understanding', 0, 'Reading your prompt…');
        const u = await this.understand(req.prompt, { useAi: req.useAi, signal });
        check();
        intent = u.ok && u.data ? u.data : null;
      }
      let ref: ReferenceSound | null = null;
      const masters = mode === 'master' || mode === 'full';
      if (req.reference?.trim() && masters) {
        say('measuring', 0, 'Reading the reference song…');
        const rr = await readReference(this.deps, req.reference, { signal });
        check();
        if (!rr.ok || !rr.data) return { ok: false, message: `Auto Mix couldn't use the reference song: ${rr.message ?? 'it could not be read'} Nothing was changed.` };
        ref = rr.data;
      }
      say('measuring', 0.05, 'Rendering and measuring the song…');
      const scope = measureScope(doc.project, req.bars);
      const first = await this.measureFn(this.deps, scope);
      check();
      const before = first.measure;
      say('planning', 0, 'Planning…');
      const notes: string[] = [];
      let preset: AutoMixPreset | null = req.preset && req.preset !== 'auto' ? presetById(req.preset) : null;
      if (req.preset && req.preset !== 'auto' && !preset) notes.push(`There is no preset "${req.preset.slice(0, 40)}": picked one automatically.`);
      if (!preset && intent?.presetId) preset = presetById(intent.presetId);
      const useRef = ref && masters ? ref : null;
      const autoPicked = !preset;
      if (!preset) {
        const hint = useRef ? { lufs: useRef.lufs, subVsMid: useRef.tone.sub, highVsMid: useRef.tone.high } : { lufs: before.master.lufs, subVsMid: before.master.tone.sub, highVsMid: before.master.tone.high };
        const picked = autoPreset(doc.project.meta.genre, hint);
        preset = picked.preset;
        notes.push(`Preset ${preset.name}, from ${useRef ? picked.why.replace('the analysis', "the reference's sound") : picked.why}.`);
      }
      if (req.reference?.trim() && !masters) notes.push(`The reference song only shapes mastering (Master or Mix + Master): this ${MODE_NAME[mode]} run didn't use it.`);
      const lufsBase = typeof req.targetLufs === 'number' && Number.isFinite(req.targetLufs) ? req.targetLufs : intent?.targetLufs ?? preset.targetLufs + (intent?.louder ?? 0);
      const target = {
        lufs: r1(Math.max(LUFS_RANGE.min, Math.min(LUFS_RANGE.max, lufsBase))),
        truePeak: r1(Math.max(-6, Math.min(0, typeof req.truePeak === 'number' && Number.isFinite(req.truePeak) ? req.truePeak : preset.truePeak))),
      };
      if (autoPicked && !useRef && masters && !(typeof req.targetLufs === 'number' && Number.isFinite(req.targetLufs)) && intent?.targetLufs === undefined && !intent?.louder) {
        const keep = autoKeepsLoudness(target.lufs, before.master.lufs);
        if (keep) {
          target.lufs = r1(Math.max(LUFS_RANGE.min, Math.min(LUFS_RANGE.max, keep.lufs)));
          notes.push(keep.note);
        }
      }
      let toneAim: PlanInput['tone'] = null;
      let widthAim: number | null = null;
      if (useRef) {
        const rt = referenceTarget(useRef, preset, intent, { targetLufs: req.targetLufs, truePeak: req.truePeak });
        target.lufs = r1(Math.max(LUFS_RANGE.min, Math.min(LUFS_RANGE.max, rt.lufs)));
        target.truePeak = r1(Math.max(-6, Math.min(0, rt.truePeak)));
        toneAim = rt.tone;
        widthAim = rt.width;
        notes.push(`Matching "${useRef.name}" (${useRef.summary}): its tone curve and width${rt.lufsFrom === 'reference' ? ` and loudness (${fmtDb(target.lufs)} LUFS)` : `, at ${fmtDb(target.lufs)} LUFS (${rt.lufsFrom === 'you' ? 'your target' : 'your prompt'})`}; ${preset.name} adds its character on top. The reference is only measured, never copied.`);
        notes.push(...rt.notes);
      }
      const sound = Object.fromEntries(Object.entries(before.inserts).map(([id, m]) => [id, { bands: m.bands, centroidHz: m.centroidHz }]));
      const roles = detectRoles(doc.project, doc.catalog, { vocalInserts: req.vocalInserts, sound });
      const vocals = Object.values(roles).filter((r) => r.vocal);
      const outcome = (after: PlanMeasure, changes: AutoMixChange[], entryId: string | null, passes: number): AutoMixOutcome => {
        const b = publicMeasure(before, roles);
        const a = publicMeasure(after, roles);
        let match: ReferenceMatch | null = null;
        if (useRef) {
          const c = closeness(b.tone, a.tone, useRef.tone);
          match = { path: useRef.path, name: useRef.name, lufs: useRef.lufs, tone: { ...useRef.tone }, width: useRef.width, summary: useRef.summary, distanceBefore: c.before, distanceAfter: c.after };
        }
        return { mode, preset: { id: preset!.id, name: preset!.name }, intent, before: b, after: a, changes, entryId, passes, notes, targetTone: toneAim ? { ...toneAim } : null, reference: match };
      };
      if (mode === 'vocals' && !vocals.length) {
        notes.push('No vocals found: vocal mode did nothing. Name the vocal track "Vocals" (or "Vox"), or pick the vocal insert, then run it again.');
        say('done', 1, 'No vocals found.');
        return { ok: true, message: 'No change: no vocals were found, so vocal mode did nothing. Name the vocal track "Vocals" (or pick its insert) and run it again.', data: outcome(before, [], null, 0) };
      }
      if (mode !== 'master' && vocals.length) notes.push(`Vocals: ${vocals.map((v) => `"${v.name}"${v.why === 'name' ? '' : ` (${v.why})`}`).join(', ')}.`);
      if (mode !== 'master' && !Object.keys(before.inserts).length) notes.push("This engine build can't render a file per insert, so the per-track measurements (levels, EQ, compression) were skipped.");
      let tune: PlanInput['tune'] = null;
      const style = req.prompt ? tuneInText(req.prompt) : null;
      if (style && mode !== 'master') {
        const pk = patternKey(doc.project);
        const tk = pk ? tuneKeyFor(pk.key) : null;
        tune = { style, key: tk ? { root: tk.root, scale: tk.scale, name: tk.label } : null };
      }
      const io: ApplyIO = {
        project: () => doc.project,
        catalog: doc.catalog,
        exec: <T>(cmd: string, args: unknown): T => {
          check();
          if (into.ctx) return into.ctx.exec<T>(cmd, args);
          if (!group) group = { id: doc.beginGroup(into.actor, `${label}: ${preset!.name}`), own: true };
          const r = doc.exec<T>(cmd, args, { actor: into.actor, groupId: group.id });
          if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
          return r.data as T;
        },
        chain: (id) => factoryChainPresets().find((c) => c.id === id) ?? null,
      };
      if (into.ctx) group = { id: into.ctx.groupId, own: false };
      const changes = new Map<string, AutoMixChange>();
      const loudHistory: Array<{ drive: number; lufs: number }> = [{ drive: masterDrive(doc.project, keepUserFx), lufs: before.master.lufs }];
      let current = before;
      let passes = 0;
      let edits = 0;
      const planNotes = new Set<string>();
      const base = { mode, preset, intent, target, keepUserFx, roles, tune, tone: toneAim, widthTarget: widthAim } as const;
      if (opts.dryRun) {
        const plan = planAutoMix({ ...base, project: doc.project, catalog: doc.catalog, measure: current, pass: 1, loudHistory });
        notes.push(...plan.notes);
        say('done', 1, 'Planned (nothing changed).');
        const planned = plan.ops.map((o) => ({ target: o.target, what: o.what }));
        return { ok: true, message: `Planned, nothing changed: ${planned.length} change${planned.length === 1 ? '' : 's'} for ${MODE_NAME[mode]} with ${preset.name} (target ${target.lufs} LUFS, ceiling ${target.truePeak} dBTP; now ${r1(before.master.lufs)} LUFS, true peak ${r1(before.master.truePeak)} dBTP).`, data: outcome(before, planned, null, 0) };
      }
      while (passes < MAX_PASSES) {
        const plan = planAutoMix({ ...base, project: doc.project, catalog: doc.catalog, measure: current, pass: passes + 1, loudHistory });
        if (passes > 0 && plan.converged) {
          for (const n of plan.notes) if (n.startsWith('Loudness capped')) planNotes.add(n);
          break;
        }
        say(passes ? 'refining' : 'applying', passes / MAX_PASSES, passes ? `Refining (pass ${passes + 1} of ${MAX_PASSES})…` : 'Setting the knobs…');
        const res = applyPlan(plan, io, { keepUserFx });
        passes++;
        edits += res.edits;
        for (const [k, v] of res.changes) changes.set(k, v);
        for (const n of [...plan.notes, ...res.notes]) planNotes.add(n);
        if (plan.drive !== null) loudHistory.push({ drive: plan.drive, lufs: current.master.lufs });
        if (!res.edits) break;
        say('refining', passes / MAX_PASSES, `Measuring the result (pass ${passes})…`);
        current = (await this.measureFn(this.deps, scope)).measure;
        check();
        if (plan.drive !== null) loudHistory[loudHistory.length - 1] = { drive: plan.drive, lufs: current.master.lufs };
        if (meetsTargets({ ...base, measure: current }).ok) break;
      }
      if ((mode === 'master' || mode === 'full') && edits && current.master.truePeak > target.truePeak + 0.05) {
        const plan = planAutoMix({ ...base, project: doc.project, catalog: doc.catalog, measure: current, pass: passes + 1, loudHistory });
        const limOnly = { ...plan, ops: plan.ops.filter((o) => o.op === 'slot' && o.kind === 'limiter') };
        const res = applyPlan(limOnly, io, { keepUserFx });
        for (const [k, v] of res.changes) changes.set(k, v);
        if (res.edits) {
          current = (await this.measureFn(this.deps, scope)).measure;
          check();
        }
        if (current.master.truePeak > target.truePeak + 0.05) notes.push(`The true peak is still ${r1(current.master.truePeak)} dBTP (ceiling ${target.truePeak}): lower the master limiter's ceiling a little more.`);
        else notes.push('The limiter ceiling was lowered once more to keep the true peak under the ceiling.');
      }
      for (const n of planNotes) notes.push(n);
      if ((mode === 'master' || mode === 'full') && edits) {
        const d = current.master.lufs - target.lufs;
        const capped = [...planNotes].some((n) => n.startsWith('Loudness capped'));
        if (Math.abs(d) > 0.5 && !capped) notes.push(`Loudness ended at ${r1(current.master.lufs)} LUFS (target ${target.lufs}) after ${passes} passes.`);
        if (capped && useRef) {
          const line = cappedAgainstReference(useRef.lufs, current.master.lufs, target.lufs);
          if (line) notes.push(line);
        }
      }
      const ownGroup = group as { id: string; own: boolean } | null;
      if (ownGroup?.own) doc.endGroup(ownGroup.id);
      const entryId = ownGroup ? (doc.getHistory().find((h) => h.groupId === ownGroup.id && !h.undone)?.id ?? null) : null;
      group = null;
      say('done', 1, 'Done.');
      const out = outcome(current, [...changes.values()], edits ? entryId : null, passes);
      const b = out.before;
      const a = out.after;
      if (!edits) return { ok: true, message: `No change: the ${mode === 'vocals' ? 'vocals are' : mode === 'master' ? 'master is' : 'mix is'} already on target for ${preset.name} (${b.lufs} LUFS, true peak ${b.truePeak} dBTP).`, data: out };
      const vb = a.vocalVsBeat !== null && b.vocalVsBeat !== null && mode !== 'master' ? `, vocal ${sgn(b.vocalVsBeat)} → ${sgn(a.vocalVsBeat)} dB vs the beat` : '';
      return {
        ok: true,
        message: `${label} (${MODE_NAME[mode]}, ${preset.name}): ${b.lufs} → ${a.lufs} LUFS, true peak ${b.truePeak} → ${a.truePeak} dBTP${vb}; ${out.changes.length} change${out.changes.length === 1 ? '' : 's'} in ${passes} pass${passes === 1 ? '' : 'es'}. One undo step removes it all.`,
        data: out,
      };
    } catch (e) {
      const cancelled = e instanceof AutoMixCancelled || signal.aborted;
      const back = rollback();
      if (cancelled) return { ok: false, message: back ? 'Cancelled: nothing was changed.' : 'Cancelled, but the edits so far could not be undone automatically: undo "Auto Mix" in the history.' };
      return { ok: false, message: `Auto Mix couldn't finish: ${errText(e)}${back ? ' (nothing was changed)' : ''}.` };
    } finally {
      run.signal?.removeEventListener('abort', onAbort);
      this.running = null;
    }
  }

  async masterFile(req: MasterFileRequest, actor: Actor, run: AutoMixRun = {}): Promise<ActionResult<AutoMixOutcome>> {
    const deps = this.deps;
    const abs = String(req.path ?? '').trim();
    if (!abs) return { ok: false, message: 'Pick an audio file to master.' };
    if (!path.isAbsolute(abs) || !isAudioFile(abs)) return { ok: false, message: `"${path.basename(abs).slice(0, 80)}" isn't an audio file Krypt Studio can read (wav, flac, mp3, ogg, aiff, m4a …).` };
    if (this.running) return { ok: false, message: `Auto Mix is already running (${this.running.label}): cancel it first, or wait for it to finish.` };
    if (!deps.project.newProject) return { ok: false, message: "A new project can't be opened from here." };
    if (!deps.project.opensNewTabs?.() && deps.project.status().dirty) return { ok: false, message: 'The open project has unsaved changes: save it first (mastering a file opens it as a new project).' };
    const info = await deps.engine.sampleInfo(abs).catch(() => null);
    if (!info?.ok || !info.data) return { ok: false, message: `Couldn't read "${path.basename(abs).slice(0, 80)}": ${info?.message ?? 'the file could not be opened'}.` };
    const name = path.basename(abs).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Song';
    const np = deps.project.newProject();
    if (!np.ok) return { ok: false, message: np.message ?? "Couldn't open a new project for the file." };
    const doc = deps.doc;
    const gid = doc.beginGroup(actor, `Master a song: "${name}"`);
    const ex = <T>(cmd: string, args: unknown): T => {
      const r = doc.exec<T>(cmd, args, { actor, groupId: gid });
      if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
      return r.data as T;
    };
    try {
      const p0 = doc.project;
      if (p0.channelOrder.length) ex('channels.remove', { ids: [...p0.channelOrder] });
      for (const id of p0.mixer.insertOrder) if (!p0.mixer.inserts[id].isMaster) ex('mixer.removeInsert', { id });
      const master = doc.project.mixer.inserts[doc.project.mixer.masterId];
      for (const s of [...master.slotOrder]) ex('mixer.removeSlot', { insertId: master.id, slotId: s });
      const track = doc.project.playlist.trackOrder[0] ?? ex<{ id: string }>('playlist.addTrack', { name }).id;
      ex('playlist.setTrack', { id: track, name });
      const d = info.data;
      const r = ex<{ channelId: string; insertId: string }>('playlist.addAudio', { path: abs, name, trackId: track, start: 0, frames: d.frames, sampleRate: d.sampleRate, channels: d.channels });
      ex('channels.set', { id: r.channelId, name, volume: 1 });
      ex('mixer.setInsert', { id: r.insertId, name });
      ex('project.setMeta', { name });
      ex('transport.setMode', { mode: 'song' });
    } catch (e) {
      doc.endGroup(gid);
      const entry = doc.getHistory().find((h) => h.groupId === gid && !h.undone);
      if (entry) doc.toggleEntry(entry.id, actor);
      return { ok: false, message: `Couldn't open "${name}" for mastering: ${errText(e)} (the new project was left empty).` };
    }
    doc.endGroup(gid);
    const res = await this.run({ mode: 'master', preset: req.preset, prompt: req.prompt, targetLufs: req.targetLufs, truePeak: req.truePeak, keepUserFx: true, ...(req.useAi ? { useAi: req.useAi } : {}), ...(req.reference?.trim() ? { reference: req.reference } : {}) }, { actor }, run);
    if (!res.ok || !res.data) return { ok: false, message: `"${name}" is open in a new project tab, but mastering it failed: ${res.message ?? 'unknown error'}` };
    return { ok: true, message: `Mastered "${name}" in a new project tab: ${res.message ?? ''} Export it with File ▸ Export (WAV 24-bit / MP3 320).`, data: res.data };
  }
}

export function rolesLine(roles: Record<string, InsertInfo>): string {
  return Object.values(roles)
    .map((r) => `${r.name}: ${r.vocal ? 'vocal' : r.role}`)
    .join(', ');
}
