// ──────────────────────────────────────────────────────────────────────
// Album mastering + Export all (research/23 §2). Runs inside the Auto Mix
// service's job slot (one job at a time, Cancel, progress, the tab guard).
//
//   1. read every file (sample info: length, rate) — nothing changes yet
//   2. a NEW project tab "Album: <first> + N": every song on its own track
//      and insert, back to back on bars with a 2-bar gap and a marker per
//      song; the master is emptied (history entry 1: the songs)
//   3. measure each song (a render of its range, the mix only), one song at
//      a time: never all songs in memory
//   4. album targets (shared/automix/album.ts): loudness per song (keep the
//      dynamics, ≤ 4 LU under the loudest, or all on target) and tone per
//      song (the album curve + half the album's shared character + a
//      quarter of the song's own)
//   5. ONE history group (entry 2: the mastering): a safety true-peak
//      limiter on the master, then the existing planner's master chain on
//      EACH song's insert (tone EQ, glue, warmth, imager with mono lows,
//      clipper for loud targets, limiter last), refined with at most 3
//      passes where every song still off target is rendered once per pass
//   6. Cancel / failure rolls the mastering back; the album tab keeps the
//      songs as they were (and says so)
//
// Export all renders each song's range (its audio, through its chain and
// the safety limiter) to "<song> (mastered).wav|mp3": a .partial file
// renamed into place, never overwriting anything.
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import type { Actor } from '@shared/doc/DocHost';
import { MP3_BITRATES, type ActionResult, type Mp3Kbps } from '@shared/types';
import type { AlbumExportOutcome, AlbumExportRequest, AlbumOutcome, AlbumRequest, AlbumSong, AutoMixChange, AutoMixIntent, AutoMixStage, ReferenceMatch, ReferenceSound } from '@shared/automix/types';
import { autoKeepsLoudness, autoPreset, presetById } from '@shared/automix/presets';
import { LUFS_RANGE } from '@shared/automix/intent';
import { applyPlan, meetsTargets, planAutoMix, toneTarget, type ApplyIO, type PlanInput, type PlanMeasure } from '@shared/automix/plan';
import {
  ALBUM_DYNAMICS_CAP_LU,
  ALBUM_MAX_PASSES,
  ALBUM_MAX_SONGS,
  ALBUM_MIN_SONGS,
  albumAverageTone,
  albumLoudnessTargets,
  albumName,
  albumToneTargets,
  exportFileName,
  loudnessSpread,
  placeSongs,
} from '@shared/automix/album';
import { cappedAgainstReference, closeness, fmtDb, referenceTarget, songNameFromPath, toneDistance } from '@shared/automix/reference';
import type { Bands } from '@shared/automix/roles';
import { isAudioFile } from '@shared/audio/formats';
import { factoryChainPresets } from '@shared/sounds/factory';
import type { MainDeps } from '../mcp/types';
import { publicMeasure, type MeasureFn } from './measure';
import { dirExists, listDir, renameDir } from '../system/download';
import { removeFile } from '../system/files';

/** What an album job gets from the service. */
export interface JobCtx {
  deps: MainDeps;
  measure: MeasureFn;
  signal: AbortSignal;
  /** Throws (cancelled) once Cancel was pressed. */
  check(): void;
  say(stage: AutoMixStage, within: number, message: string): void;
  understand(prompt: string, useAi?: 'auto' | 'never'): Promise<ActionResult<AutoMixIntent>>;
  reference(path: string): Promise<ActionResult<ReferenceSound>>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r1 = (x: number): number => Math.round(x * 10) / 10;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const clampLufs = (x: number): number => r1(Math.max(LUFS_RANGE.min, Math.min(LUFS_RANGE.max, x)));
const clampTp = (x: number): number => r1(Math.max(-6, Math.min(0, x)));
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function fail<T>(message: string): ActionResult<T> {
  return { ok: false, message };
}

interface SongState {
  name: string;
  path: string;
  trackId: string;
  insertId: string;
  startTick: number;
  endTick: number;
  bars: string;
  barCount: number;
  before: PlanMeasure | null;
  cur: PlanMeasure | null;
  hist: Array<{ drive: number; lufs: number }>;
  drive: number | null;
  changes: Map<string, AutoMixChange>;
  notes: Set<string>;
  edits: number;
  done: boolean;
}

/** The whole album run (see the header). */
export async function masterAlbumImpl(ctx: JobCtx, req: AlbumRequest, actor: Actor): Promise<ActionResult<AlbumOutcome>> {
  const deps = ctx.deps;
  // ── 0. The list
  const paths = (Array.isArray(req.paths) ? req.paths : []).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (paths.length < ALBUM_MIN_SONGS) return fail(`Pick at least ${ALBUM_MIN_SONGS} songs for an album (for one song, use Master a song).`);
  if (paths.length > ALBUM_MAX_SONGS) return fail(`An album takes up to ${ALBUM_MAX_SONGS} songs (you picked ${paths.length}): master it in two parts.`);
  const seen = new Set<string>();
  for (const p of paths) {
    const name = songNameFromPath(p);
    if (!path.isAbsolute(p) || !isAudioFile(p)) return fail(`"${path.basename(p).slice(0, 80)}" isn't an audio file Krypt Studio can read (wav, flac, mp3, ogg, aiff, m4a …).`);
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) return fail(`"${name}" is in the list twice: remove one of them.`);
    seen.add(k);
  }
  if (!deps.project.newProject) return fail("A new project can't be opened from here, so the album has nowhere to go.");
  if (!deps.project.opensNewTabs?.() && deps.project.status().dirty) return fail('The open project has unsaved changes: save it first (the album opens as a new project).');

  // ── 1. Read the files (nothing changes yet)
  const n = paths.length;
  const infos: Array<{ frames: number; sampleRate: number; channels: number }> = [];
  try {
    for (let i = 0; i < n; i++) {
      const name = songNameFromPath(paths[i]);
      ctx.say('measuring', (0.15 * i) / n, `Reading "${name}" (${i + 1} of ${n})…`);
      const info = await deps.engine.sampleInfo(paths[i]).catch((e) => ({ ok: false as const, message: errText(e), data: undefined }));
      ctx.check();
      if (!info.ok || !info.data || !(info.data.frames > 0) || !(info.data.sampleRate > 0)) return fail(`Couldn't read "${name}": ${info.message ?? 'the file could not be opened'}. Nothing was changed.`);
      infos.push({ frames: info.data.frames, sampleRate: info.data.sampleRate, channels: info.data.channels });
    }
  } catch {
    return fail('Cancelled: nothing was changed.');
  }
  let intent: AutoMixIntent | null = null;
  let ref: ReferenceSound | null = null;
  try {
    if (req.prompt?.trim()) {
      ctx.say('understanding', 0.5, 'Reading your prompt…');
      const u = await ctx.understand(req.prompt, req.useAi);
      ctx.check();
      intent = u.ok && u.data ? u.data : null;
    }
    if (req.reference?.trim()) {
      ctx.say('measuring', 0.15, 'Reading the reference song…');
      const rr = await ctx.reference(req.reference);
      ctx.check();
      if (!rr.ok || !rr.data) return fail(`The album couldn't use the reference song: ${rr.message ?? 'it could not be read'} Nothing was changed.`);
      ref = rr.data;
    }
  } catch {
    return fail('Cancelled: nothing was changed.');
  }

  // ── 2. The album tab (history entry 1)
  const names = paths.map(songNameFromPath);
  const title = albumName(names).slice(0, 64);
  const np = deps.project.newProject();
  if (!np.ok) return fail(np.message ?? "Couldn't open a new project for the album.");
  const doc = deps.doc;
  const songs: SongState[] = [];
  {
    const gid = doc.beginGroup(actor, `${title}: the songs`);
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
      const { bpm, timeSig } = doc.project.transport;
      const slots = placeSongs(
        infos.map((x) => x.frames / x.sampleRate),
        bpm,
        timeSig,
      );
      const tracks = [...doc.project.playlist.trackOrder];
      for (let i = 0; i < n; i++) {
        const name = names[i];
        const trackId = tracks[i] ?? ex<{ id: string }>('playlist.addTrack', { name: name.slice(0, 64) }).id;
        ex('playlist.setTrack', { id: trackId, name: `${i + 1}. ${name}`.slice(0, 64) });
        const r = ex<{ clipId: string; channelId: string; insertId: string }>('playlist.addAudio', { path: paths[i], name, trackId, start: slots[i].startTick, frames: infos[i].frames, sampleRate: infos[i].sampleRate, channels: infos[i].channels });
        ex('channels.set', { id: r.channelId, name, volume: 1 });
        ex('mixer.setInsert', { id: r.insertId, name });
        ex('playlist.addMarker', { tick: slots[i].startTick, name: `${i + 1}. ${name}`.slice(0, 64) });
        const clip = doc.project.playlist.clips[r.clipId];
        const end = clip ? clip.start + clip.length : slots[i].endTick;
        songs.push({ name, path: paths[i], trackId, insertId: r.insertId, startTick: slots[i].startTick, endTick: end, bars: slots[i].bars, barCount: slots[i].endBar - slots[i].startBar + 1, before: null, cur: null, hist: [], drive: null, changes: new Map(), notes: new Set(), edits: 0, done: false });
      }
      ex('project.setMeta', { name: title });
      ex('transport.setMode', { mode: 'song' });
    } catch (e) {
      doc.endGroup(gid);
      const entry = doc.getHistory().find((h) => h.groupId === gid && !h.undone);
      if (entry) doc.toggleEntry(entry.id, actor);
      return fail(`Couldn't lay out the album: ${errText(e)} (the new project tab was left empty).`);
    }
    doc.endGroup(gid);
  }

  // ── 3-6. Measure, plan, apply, refine (history entry 2)
  let group: string | null = null;
  const rollback = (): boolean => {
    if (!group) return true;
    doc.endGroup(group);
    const entry = doc.getHistory().find((h) => h.groupId === group && !h.undone);
    group = null;
    return entry ? doc.toggleEntry(entry.id, actor).ok : true;
  };
  const measureSong = async (s: SongState): Promise<PlanMeasure> => {
    try {
      return (await ctx.measure(deps, { bars: s.bars, stems: false, maxBars: s.barCount + 2 })).measure;
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      throw new Error(`"${s.name}" couldn't be measured: ${errText(e)}`);
    }
  };
  try {
    for (let i = 0; i < n; i++) {
      const s = songs[i];
      ctx.say('measuring', 0.2 + (0.8 * i) / n, `Measuring "${s.name}" (${i + 1} of ${n})…`);
      s.before = await measureSong(s);
      s.cur = s.before;
      ctx.check();
    }
    ctx.say('planning', 0, 'Planning the album…');
    const notes: string[] = [];
    const beforeLufs = songs.map((s) => s.before!.master.lufs);
    const beforeTones = songs.map((s) => s.before!.master.tone);
    let preset = req.preset && req.preset !== 'auto' ? presetById(req.preset) : null;
    if (req.preset && req.preset !== 'auto' && !preset) notes.push(`There is no preset "${req.preset.slice(0, 40)}": picked one automatically.`);
    if (!preset && intent?.presetId) preset = presetById(intent.presetId);
    const autoPicked = !preset;
    if (!preset) {
      const avg = albumAverageTone(beforeTones);
      const hint = ref ? { lufs: ref.lufs, subVsMid: ref.tone.sub, highVsMid: ref.tone.high } : { lufs: Math.max(...beforeLufs), subVsMid: avg.sub, highVsMid: avg.high };
      const picked = autoPreset(null, hint);
      preset = picked.preset;
      notes.push(`Preset ${preset.name}, from ${ref ? picked.why.replace('the analysis', "the reference's sound") : picked.why.replace('no genre is set, so the balanced card', 'the songs (nothing stood out, so the balanced card)')}.`);
    }
    const lufsBase = isNum(req.targetLufs) ? req.targetLufs : intent?.targetLufs ?? preset.targetLufs + (intent?.louder ?? 0);
    const target = { lufs: clampLufs(lufsBase), truePeak: clampTp(isNum(req.truePeak) ? req.truePeak : preset.truePeak) };
    if (autoPicked && !ref && !isNum(req.targetLufs) && intent?.targetLufs === undefined && !intent?.louder) {
      // the album's loudest song sets it: Auto never turns the record down
      const keepLoud = autoKeepsLoudness(target.lufs, Math.max(...beforeLufs));
      if (keepLoud) {
        target.lufs = clampLufs(keepLoud.lufs);
        notes.push(keepLoud.note.replace('Already loud (', "The loudest song is already loud ("));
      }
    }
    let curve: Bands = toneTarget(preset, intent);
    let widthAim: number | null = null;
    if (ref) {
      const rt = referenceTarget(ref, preset, intent, { targetLufs: req.targetLufs, truePeak: req.truePeak });
      target.lufs = clampLufs(rt.lufs);
      target.truePeak = clampTp(rt.truePeak);
      curve = rt.tone;
      widthAim = rt.width;
      notes.push(`Matching "${ref.name}" (${ref.summary}) for the whole album: its tone curve and width${rt.lufsFrom === 'reference' ? ` and loudness (${fmtDb(target.lufs)} LUFS)` : ''}; ${preset.name} adds its character. The reference is only measured, never copied.`);
      notes.push(...rt.notes);
    }
    const keep = req.keepDynamics !== false;
    const lufsTargets = albumLoudnessTargets(beforeLufs, target.lufs, keep);
    const { targets: toneTargets } = albumToneTargets(curve, beforeTones);
    notes.push(
      keep
        ? `Kept the album's dynamics: the loudest song aims at ${fmtDb(target.lufs)} LUFS and the others keep their distance to it (at most ${ALBUM_DYNAMICS_CAP_LU} LU under).`
        : `Every song aims at ${fmtDb(target.lufs)} LUFS.`,
    );
    notes.push('Tone: every song moves toward the album curve, keeping half of what the songs share and a quarter of its own colour, so they sound like one record.');

    const io: ApplyIO = {
      project: () => doc.project,
      catalog: doc.catalog,
      exec: <T>(cmd: string, args: unknown): T => {
        ctx.check();
        if (!group) group = doc.beginGroup(actor, `${title}: mastering (${preset!.name})`);
        const r = doc.exec<T>(cmd, args, { actor, groupId: group });
        if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
        return r.data as T;
      },
      chain: (id) => factoryChainPresets().find((c) => c.id === id) ?? null,
    };
    const albumChanges: AutoMixChange[] = [];
    // The master keeps only a safety true-peak limiter (not Krypt-marked: a later Auto Master treats it as yours).
    if (doc.catalog.plugins.some((x) => x.id === 'krypt.limiter')) {
      io.exec('mixer.addSlot', { insertId: doc.project.mixer.masterId, type: 'krypt.limiter', params: { inputGain: 0, ceiling: target.truePeak, release: 100, truePeak: 1 } });
      albumChanges.push({ target: 'Master ▸ Krypt Limiter', what: `safety true-peak limiter at ${fmtDb(target.truePeak)} dBTP (each song has its own chain)` });
    }
    const input = (i: number): Omit<PlanInput, 'project' | 'catalog' | 'measure' | 'pass'> => ({
      mode: 'master',
      preset: preset!,
      intent,
      target: { lufs: lufsTargets[i], truePeak: target.truePeak },
      keepUserFx: true,
      roles: {},
      tone: toneTargets[i],
      widthTarget: widthAim,
      masterInsertId: songs[i].insertId,
    });
    let passes = 0;
    for (let pass = 1; pass <= ALBUM_MAX_PASSES; pass++) {
      const touched: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = songs[i];
        if (s.done) continue;
        const plan = planAutoMix({ ...input(i), project: doc.project, catalog: doc.catalog, measure: s.cur!, pass, loudHistory: s.hist });
        if (pass > 1 && plan.converged) {
          for (const x of plan.notes) if (x.startsWith('Loudness capped')) s.notes.add(x);
          s.done = true;
          continue;
        }
        ctx.say(pass === 1 ? 'applying' : 'refining', pass === 1 ? i / n : ((pass - 1) * n + i) / (ALBUM_MAX_PASSES * n), `${pass === 1 ? 'Setting' : 'Refining'} "${s.name}" (${i + 1} of ${n}${pass > 1 ? `, pass ${pass}` : ''})…`);
        const res = applyPlan(plan, io, { keepUserFx: true });
        s.edits += res.edits;
        for (const [k, v] of res.changes) s.changes.set(k, v);
        for (const x of [...plan.notes, ...res.notes]) s.notes.add(x);
        s.drive = plan.drive;
        if (plan.drive !== null) s.hist.push({ drive: plan.drive, lufs: s.cur!.master.lufs });
        if (!res.edits) {
          s.done = true;
          continue;
        }
        touched.push(i);
      }
      if (!touched.length) break;
      passes = pass;
      for (const i of touched) {
        const s = songs[i];
        ctx.say('refining', (pass * n - touched.length + touched.indexOf(i) + 1) / (ALBUM_MAX_PASSES * n), `Measuring "${s.name}" again (pass ${pass})…`);
        s.cur = await measureSong(s);
        ctx.check();
        if (s.drive !== null && s.hist.length) s.hist[s.hist.length - 1] = { drive: s.drive, lufs: s.cur.master.lufs };
        if (meetsTargets({ ...input(i), measure: s.cur }).ok) s.done = true;
      }
    }
    // Safety: no song over the ceiling.
    for (let i = 0; i < n; i++) {
      const s = songs[i];
      if (!s.edits || s.cur!.master.truePeak <= target.truePeak + 0.05) continue;
      const plan = planAutoMix({ ...input(i), project: doc.project, catalog: doc.catalog, measure: s.cur!, pass: passes + 1, loudHistory: s.hist });
      const res = applyPlan({ ...plan, ops: plan.ops.filter((o) => o.op === 'slot' && o.kind === 'limiter') }, io, { keepUserFx: true });
      for (const [k, v] of res.changes) s.changes.set(k, v);
      if (res.edits) {
        s.cur = await measureSong(s);
        ctx.check();
      }
      s.notes.add(s.cur!.master.truePeak > target.truePeak + 0.05 ? `The true peak is still ${r1(s.cur!.master.truePeak)} dBTP (ceiling ${target.truePeak}): lower its limiter's ceiling a little more.` : "The limiter ceiling was lowered once more to keep the true peak under the ceiling.");
    }
    for (let i = 0; i < n; i++) {
      const s = songs[i];
      if (!s.edits) continue;
      const capped = [...s.notes].some((x) => x.startsWith('Loudness capped'));
      if (!capped && Math.abs(s.cur!.master.lufs - lufsTargets[i]) > 0.5) s.notes.add(`Loudness ended at ${r1(s.cur!.master.lufs)} LUFS (aimed at ${lufsTargets[i]}).`);
      if (capped && ref) {
        const line = cappedAgainstReference(ref.lufs, s.cur!.master.lufs, lufsTargets[i]);
        if (line) s.notes.add(line);
      }
    }
    const g = group as string | null;
    if (g) doc.endGroup(g);
    const entryId = g ? (doc.getHistory().find((h) => h.groupId === g && !h.undone)?.id ?? null) : null;
    group = null;
    ctx.say('done', 1, 'Done.');

    // ── The result
    const out: AlbumSong[] = songs.map((s, i) => ({
      name: s.name,
      path: s.path,
      trackId: s.trackId,
      insertId: s.insertId,
      startTick: s.startTick,
      endTick: s.endTick,
      bars: s.bars,
      targetLufs: lufsTargets[i],
      before: publicMeasure(s.before!, {}),
      after: publicMeasure(s.cur!, {}),
      targetTone: { ...toneTargets[i] },
      changes: [...s.changes.values()],
      notes: [...s.notes],
    }));
    const afterLufs = songs.map((s) => s.cur!.master.lufs);
    const avgBefore = albumAverageTone(out.map((s) => s.before.tone));
    const avgAfter = albumAverageTone(out.map((s) => s.after.tone));
    const consistency = (key: 'before' | 'after', avg: Bands) => r1(out.reduce((sum, s) => sum + toneDistance(s[key].tone, avg), 0) / n);
    notes.push(`Loudness: ${loudnessSpread(beforeLufs)} → ${loudnessSpread(afterLufs)} LU between the loudest and the quietest song.`);
    notes.push(`Tone: the songs differ from the album's average by ${consistency('before', avgBefore).toFixed(1)} → ${consistency('after', avgAfter).toFixed(1)} dB per band on average.`);
    let match: ReferenceMatch | null = null;
    if (ref) {
      const c = closeness(avgBefore, avgAfter, ref.tone);
      match = { path: ref.path, name: ref.name, lufs: ref.lufs, tone: { ...ref.tone }, width: ref.width, summary: ref.summary, distanceBefore: c.before, distanceAfter: c.after };
    }
    const edits = songs.reduce((x, s) => x + s.edits, 0);
    const changeCount = out.reduce((x, s) => x + s.changes.length, 0) + albumChanges.length;
    const outcome: AlbumOutcome = {
      name: title,
      preset: { id: preset.id, name: preset.name },
      intent,
      reference: match,
      targetLufs: target.lufs,
      truePeak: target.truePeak,
      keepDynamics: keep,
      curve: { ...curve },
      songs: out,
      entryId: edits || albumChanges.length ? entryId : null,
      passes,
      notes,
    };
    if (albumChanges.length && out.length) out[0].changes.unshift(...albumChanges);
    const loudest = Math.max(...out.map((s) => s.after.lufs));
    const tpMax = Math.max(...out.map((s) => s.after.truePeak));
    return {
      ok: true,
      message: `Mastered ${plural(n, 'song')} as one album in a new project tab ("${title}", ${preset.name}): the loudest at ${fmtDb(loudest)} LUFS, true peaks up to ${fmtDb(tpMax)} dBTP; ${plural(changeCount, 'change')} in ${passes} pass${passes === 1 ? '' : 'es'}. One undo step removes the mastering.`,
      data: outcome,
    };
  } catch (e) {
    const cancelled = ctx.signal.aborted;
    const back = rollback();
    const kept = `The songs are in the album tab ("${title}"), unmastered.`;
    if (cancelled) return fail(back ? `Cancelled: nothing was mastered. ${kept}` : 'Cancelled, but the mastering so far could not be undone automatically: undo it in Edit ▸ History.');
    return fail(`The album couldn't be mastered: ${errText(e)}.${back ? ` Nothing was mastered. ${kept}` : ''}`);
  }
}

// ── Export all ────────────────────────────────────────────────────────

const FORMAT_LABEL = { wav24: '24-bit WAV', wav16: '16-bit WAV', mp3: 'MP3' } as const;

/** One file per song (its range of the open album tab), into a folder. */
export async function exportAlbumImpl(ctx: JobCtx, req: AlbumExportRequest): Promise<ActionResult<AlbumExportOutcome>> {
  const deps = ctx.deps;
  const folder = String(req.folder ?? '').trim();
  if (!folder || !path.isAbsolute(folder)) return fail('Choose a folder to export the album into.');
  if (!(await dirExists(folder))) return fail(`The folder "${folder}" doesn't exist any more: choose another one.`);
  const format = req.format === 'mp3' || req.format === 'wav16' ? req.format : 'wav24';
  const kbps: Mp3Kbps = MP3_BITRATES.includes(Number(req.mp3Kbps) as Mp3Kbps) ? (Number(req.mp3Kbps) as Mp3Kbps) : 320;
  const ext = format === 'mp3' ? 'mp3' : 'wav';
  const list = Array.isArray(req.songs) ? req.songs.slice(0, ALBUM_MAX_SONGS) : [];
  if (!list.length) return fail('There are no songs to export: master an album first.');
  // The ranges must be the open tab's songs: an audio clip starts at each one.
  const p = deps.doc.project;
  const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'audio');
  const jobs: Array<{ name: string; start: number; end: number }> = [];
  for (const s of list) {
    const start = Math.round(Number(s?.startTick));
    const clip = clips.find((c) => c.start === start);
    if (!clip || !Number.isFinite(start)) return fail('The album tab isn\'t the open project tab (or its songs moved): switch to the album tab, then Export all.');
    jobs.push({ name: String(s?.name ?? '').slice(0, 100) || 'Song', start, end: clip.start + clip.length });
  }
  const taken = new Set(await listDir(folder));
  const files: string[] = [];
  const failed: Array<{ name: string; message: string }> = [];
  const n = jobs.length;
  let cancelled = false;
  for (let i = 0; i < n; i++) {
    if (ctx.signal.aborted) {
      cancelled = true;
      break;
    }
    const j = jobs[i];
    const file = exportFileName(j.name, ext, taken);
    taken.add(file);
    const final = path.join(folder, file);
    const part = path.join(folder, `${file.slice(0, -(ext.length + 1))}.partial.${ext}`);
    taken.add(path.basename(part));
    ctx.say('exporting', i / n, `Exporting "${j.name}" (${i + 1} of ${n})…`);
    const stop = () => void deps.engine.request({ cmd: 'cancelRender' }).catch(() => undefined);
    ctx.signal.addEventListener('abort', stop, { once: true });
    let r;
    try {
      r = await deps.engine.render({ path: part, scope: { kind: 'range', startTick: j.start, endTick: j.end }, format, ...(format === 'mp3' ? { mp3Kbps: kbps } : {}), tailSec: 0, analyze: false });
    } catch (e) {
      r = { ok: false as const, message: errText(e) };
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
    if (ctx.signal.aborted) {
      await removeFile(part).catch(() => undefined);
      cancelled = true;
      break;
    }
    if (!r.ok) {
      await removeFile(part).catch(() => undefined);
      failed.push({ name: j.name, message: r.message ?? 'the render failed' });
      continue;
    }
    try {
      await renameDir(part, final);
      files.push(final);
    } catch (e) {
      await removeFile(part).catch(() => undefined);
      failed.push({ name: j.name, message: `couldn't write ${file}: ${errText(e)}` });
    }
  }
  ctx.say('done', 1, 'Done.');
  const data: AlbumExportOutcome = { folder, files, failed };
  const what = `${FORMAT_LABEL[format]}${format === 'mp3' ? ` ${kbps} kbps` : ''}`;
  if (cancelled) return { ok: false, message: `Export cancelled: ${files.length} of ${n} songs were written to "${folder}".`, data };
  if (!files.length) return { ok: false, message: `Export all failed: ${failed[0]?.message ?? 'nothing was written'}.`, data };
  const bad = failed.length ? ` ${plural(failed.length, 'song')} failed: ${failed.map((f) => `"${f.name}" (${f.message})`).join(', ')}.` : '';
  return { ok: true, message: `Exported ${plural(files.length, 'song')} to "${folder}" (${what}).${bad}`, data };
}
