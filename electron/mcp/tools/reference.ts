// "Make something like this song" in one call: study_reference puts the
// song the user gives on the Playlist as a muted "Reference: <name>" track
// (or adopts a clip already there), reads it on-device (tempo, key, swing,
// sections, drums, chords, loudness, tonal balance, width) and answers with
// a brief: the closest genres, the section plan in bars, the drum feel, the
// chord loop and the mix numbers. From then on get_playbook follows the
// reference (its tempo, key, swing, section plan, loudness) and review_song
// grades the song against it, without the agent passing anything along:
// the reference is the muted track, so it survives restarts, and the
// numbers come from the analyzer's cache. shared/reference holds the maths.

import path from 'node:path';
import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Channel, Project } from '@shared/schema/project';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { DrumGrid } from '@shared/library/types';
import { listPlaybooks } from '@shared/playbooks';
import { briefText, referenceBrief, type ReferenceBrief } from '@shared/reference';
import { genreInText, genreInfo, resolveGenre, type GenreId } from '@shared/sounds/genres';
import { defineTool, fail, type RunCtx, type ToolCaller } from './types';
import { agentSamplePath, findChannel, safeName } from './util';
import { findAudioClip } from './ears';

export const REFERENCE_PREFIX = 'Reference: ';
const REFERENCE_NAME = /^\s*ref(?:erence)?\b/i;
const AUDIOCLIP = 'krypt.audioclip';
const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

/** A channel name that marks a reference ("Reference: Song", "Ref - Song", "reference"). */
export function isReferenceName(name: string): boolean {
  return REFERENCE_NAME.test(name);
}

/** "Reference: Song" → "Song". */
export function referenceTitle(name: string): string {
  return name.replace(/^\s*ref(?:erence)?\b\s*[:\-–—]?\s*/i, '').trim() || name.trim() || 'Reference';
}

function audioClipsOf(p: Project, channelId: string) {
  return Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === channelId);
}

export interface ReferenceTrack {
  channel: Channel;
  /** Its first audio clip on the Playlist (null: the channel holds the song but isn't placed). */
  clipId: string | null;
  title: string;
}

/**
 * The reference song of the project: `arg` = a clip id or channel name / id ("none" / "off" = no reference);
 * default = the last audio channel named "Reference …" that plays a sample. null when there is none.
 */
export function findReference(p: Project, arg?: string | null): ReferenceTrack | null {
  const a = arg?.trim();
  if (a && /^(none|off|no|false)$/i.test(a)) return null;
  let ch: Channel | null = null;
  if (a) {
    if (p.playlist.clips[a]) {
      const clip = findAudioClip(p, a);
      ch = clip.channelId ? (p.channels[clip.channelId] ?? null) : null;
    } else ch = findChannel(p, a);
    if (!ch || !ch.generator.sampleId) fail(`"${safeName(a, 60)}" isn't an audio track with a song on it: pass the reference's clip id or its channel name (e.g. "Reference: Song"), or "none".`);
  } else {
    const cands = p.channelOrder.map((id) => p.channels[id]).filter((c) => c && isReferenceName(c.name) && !!c.generator.sampleId && (c.generator.type === AUDIOCLIP || audioClipsOf(p, c.id).length > 0));
    ch = cands.filter((c) => audioClipsOf(p, c.id).length > 0).pop() ?? cands.pop() ?? null;
  }
  if (!ch) return null;
  const clips = audioClipsOf(p, ch.id).sort((x, y) => x.start - y.start);
  return { channel: ch, clipId: clips[0]?.id ?? null, title: referenceTitle(ch.name) };
}

/** Clips of the reference that would play in a render (not muted by clip, track, channel or solo). */
export function audibleReferenceClips(p: Project, ch: Channel): number {
  if (ch.mute) return 0;
  const solo = p.playlist.trackOrder.filter((t) => p.playlist.tracks[t]?.solo);
  return audioClipsOf(p, ch.id).filter((c) => !c.mute && !p.playlist.tracks[c.trackId]?.mute && (!solo.length || solo.includes(c.trackId))).length;
}

/** A sharper drum grid from the reference library's deep pass (drum stem), when it has one for this file. */
async function libraryDrums(deps: MainDeps, abs: string): Promise<DrumGrid | null> {
  const lib = deps.library;
  if (!lib) return null;
  try {
    const name = path.basename(abs).replace(/\.[a-z0-9]+$/i, '');
    const q = await lib.query({ text: name, limit: 50 });
    const hit = q.ok ? q.data?.tracks.find((t) => t.path.toLowerCase() === abs.toLowerCase() && t.status === 'deep') : undefined;
    if (!hit) return null;
    const t = await lib.track(hit.id);
    const d = t.ok ? t.data?.features?.drums : null;
    return d && d.source === 'stem' ? d : null;
  } catch {
    return null;
  }
}

function runOpts(ctx: Pick<RunCtx, 'progress' | 'signal'>) {
  return { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'working') : undefined, signal: ctx.signal };
}

export interface StudiedReference {
  track: ReferenceTrack;
  analysis: AudioAnalysis;
  brief: ReferenceBrief;
  /** The drums came from the drum stem (a stem model is installed): which model, and whether the stems were cached. */
  stems: { model: string; cached: boolean; seconds: number } | null;
  /** Why the drum stem wasn't used, when a stem model is installed but it failed. */
  stemProblem?: string;
}

/**
 * Analyse the reference (cached per file) and build its brief, laid out for `genre` (else its best guess). `stems`:
 * 'run' separates the song for its drum stem when a stem model is installed (cached), 'cached' uses the drum stem
 * only when it is already cached (get_playbook / review_song never start a separation), 'off' never.
 */
export async function studyReference(deps: MainDeps, track: ReferenceTrack, genre: GenreId | null, ctx: Pick<RunCtx, 'progress' | 'signal'>, stems: 'run' | 'cached' | 'off' = 'cached'): Promise<StudiedReference> {
  if (!deps.analyzer) fail("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so the reference can't be read.");
  const target = { channelId: track.channel.id };
  const r = await deps.analyzer.analyze(target, { ...runOpts(ctx), drums: true });
  if (!r.ok || !r.data) fail(`Couldn't analyse the reference "${safeName(track.channel.name, 60)}": ${r.message ?? 'analysis failed'}`);
  const analysis = r.data;
  let drumHits: { hits: NonNullable<AudioAnalysis['drumHits']>; source: 'stem' } | null = null;
  let stemInfo: StudiedReference['stems'] = null;
  let stemProblem: string | undefined;
  if (stems !== 'off' && deps.analyzer.drumStemHits) {
    try {
      const s = await deps.analyzer.drumStemHits(target, { cachedOnly: stems === 'cached' }, runOpts(ctx));
      if (s.ok && s.data && s.data.hits.length >= 8) {
        drumHits = { hits: s.data.hits, source: 'stem' };
        stemInfo = { model: s.data.model, cached: s.data.cached, seconds: s.data.seconds };
      } else if (!s.ok) stemProblem = s.message ?? 'the drum stem failed';
    } catch (e) {
      stemProblem = (e as Error)?.message ?? String(e);
    }
  }
  const drums = drumHits ? null : await libraryDrums(deps, analysis.path);
  const brief = referenceBrief(analysis, { name: safeName(track.title, 80), genre, playbooks: listPlaybooks(), drums, drumHits });
  return { track, analysis, brief, stems: stemInfo, ...(stemProblem ? { stemProblem } : {}) };
}

/**
 * The project's reference for get_playbook / review_song: null when there is none (or `arg` is "none"); a warning
 * instead of a failure when it can't be read, so the recipe / review still work without it.
 */
export async function projectReference(deps: MainDeps, arg: string | undefined, genre: GenreId | null, ctx: Pick<RunCtx, 'progress' | 'signal'>, warnings: string[]): Promise<StudiedReference | null> {
  let track: ReferenceTrack | null;
  try {
    track = findReference(deps.doc.project, arg);
  } catch (e) {
    if (arg) throw e;
    return null;
  }
  if (!track) return null;
  if (!deps.analyzer) {
    warnings.push(`The reference "${safeName(track.channel.name, 60)}" can't be read in this session (no audio analyzer), so this ignores it.`);
    return null;
  }
  try {
    return await studyReference(deps, track, genre, ctx);
  } catch (e) {
    if (arg) throw e;
    warnings.push(`The reference "${safeName(track.channel.name, 60)}" couldn't be read (${(e as Error)?.message ?? e}), so this ignores it.`);
    return null;
  }
}

/** The genre a user named ("make it house", "uk drill") or null. */
function genreArg(g: string | undefined): { id: GenreId | null; unknown: string | null } {
  const t = g?.trim();
  if (!t) return { id: null, unknown: null };
  const id = resolveGenre(t) ?? genreInText(t);
  return id ? { id, unknown: null } : { id: null, unknown: t.slice(0, 40) };
}

/** Put the deep analysis of the References collection in motion when a stem model is installed (originality check). */
async function libraryNote(deps: MainDeps, abs: string): Promise<string> {
  const lib = deps.library;
  if (!lib) return 'The reference library is not available in this session, so check_originality has nothing to compare with.';
  try {
    let coll = lib.findCollection('References');
    if (!coll || coll.name.toLowerCase() !== 'references') {
      const c = await lib.createCollection('References', ['reference']);
      if (!c.ok || !c.data) return `Couldn't add it to the reference library (${c.message ?? 'no collection'}).`;
      coll = c.data;
    }
    const add = await lib.addFiles(coll.id, [abs]);
    if (!add.ok) return `Couldn't add it to the reference library: ${add.message ?? 'unknown error'}.`;
    const stems = deps.analyzer?.listModels().filter((m) => m.def.task === 'stems') ?? [];
    if (!stems.some((m) => m.status === 'installed')) {
      return "Added to the References collection. check_originality compares melodies only after a deep analysis, which needs a stem model (HT-Demucs) the user installs in Model Manager; without it, keep every line your own by writing it fresh (don't transcribe the song).";
    }
    if (coll.deep) return 'Added to the References collection; its deep analysis (stems → transcribed lines) runs in the background, so check_originality can compare your melodies with it in a minute or so.';
    const est = await lib.estimateDeep(coll.id);
    if (est.ok && est.data && est.data.tracks <= 5) {
      const on = await lib.setDeep(coll.id, true);
      if (on.ok) return `Added to the References collection and started its deep analysis in the background (about ${Math.max(1, Math.round(est.data.seconds))} s on ${est.data.device}), so check_originality can compare your melodies with it.`;
    }
    return 'Added to the References collection. For check_originality to compare melodies with it, library_deep {"collection":"References"} (runs in the background).';
  } catch (e) {
    return `Couldn't add it to the reference library: ${(e as Error)?.message ?? e}.`;
  }
}

/** Mute what the reference plays through: its tracks when it has them to itself, else the channel. */
function muteReference(ctx: RunCtx, p: Project, ch: Channel): boolean {
  if (audibleReferenceClips(p, ch) === 0) return false;
  const clips = audioClipsOf(p, ch.id);
  const tracks = [...new Set(clips.map((c) => c.trackId))];
  const shared = tracks.some((t) => Object.values(p.playlist.clips).some((c) => c.trackId === t && c.channelId !== ch.id));
  if (shared) ctx.exec('channels.set', { id: ch.id, mute: true });
  else for (const t of tracks) if (!p.playlist.tracks[t]?.mute) ctx.exec('playlist.setTrack', { id: t, mute: true });
  return true;
}

export const studyReferenceTool = defineTool({
  name: 'study_reference',
  title: 'Study a song to make something like it',
  kind: 'write',
  readsWhenUnchanged: true,
  description:
    'START HERE when the user gives a song to make something "like" / "similar to" (a file path they dropped in, or a clip already on the Playlist). One call: puts the song on the Playlist as a MUTED track "Reference: <name>" (the user unmutes it to A/B), reads it on-device and returns a brief: tempo (the half / double-time reading that fits the genre), key, swing, the closest genres with reasons, the section plan in bars with relative energy (where the peaks and breaks land), the drum feel per 16th, the chord loop as roman numerals, loudness, tonal balance and width. NEXT call build_from_reference: one call builds the whole instrumental bed from it (drums, chords, bass, arrangement, sounds, mix) and returns the melody shape for your ORIGINAL top line. get_playbook also FOLLOWS the reference, review_song grades your song against it and set_tempo keeps its tempo; you don\'t pass anything along. file = the song\'s absolute path (any local file by default; with File access "Ask me" the user is asked first); clip = an audio clip id or channel already on the Playlist. genre = the genre the user asked for ("make it house"), else the closest one is used. Write ORIGINAL music: never its melody, lyrics, vocal or hook. Example: {"file":"C:\\\\Users\\\\me\\\\Downloads\\\\song.mp3"}',
  input: z.object({
    file: z.string().min(1).max(400).optional().describe('Absolute path of the song file (wav, mp3, flac, m4a, ogg, aiff …).'),
    clip: z.string().min(1).max(200).optional().describe('Instead of file: an audio clip id or channel name already on the Playlist.'),
    genre: z.string().max(40).optional().describe('The genre the user wants ("house", "uk drill"). Default: the closest genre to the song.'),
    stems: z.boolean().default(true).describe('Read the drums from the drum stem when a stem model is installed: much sharper than the full mix (cached; the first time about 20 s per minute of audio on a CPU, a few seconds on a GPU).'),
    change_label: zLabel,
  }),
  summarize: (a) => safeName(a.file ? (a.file.split(/[\\/]/).pop() ?? a.file) : (a.clip ?? 'reference'), 40),
  paths: (a) => [{ value: a.file, kind: 'audio' }],
  async run(deps, caller: ToolCaller, a, ctx) {
    if (a.file && a.clip) fail('Pass either file (a song on this PC) or clip (one already on the Playlist), not both.');
    if (!deps.analyzer) fail("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so the song can't be studied.");
    const g = genreArg(a.genre);
    const warnings: string[] = [];
    if (g.unknown) warnings.push(`"${safeName(g.unknown, 40)}" isn't a genre Krypt Studio has a playbook for; the closest genre to the song is used. Genres: ${listPlaybooks().map((x) => x.id).join(', ')}.`);
    let p = deps.doc.project;
    let track: ReferenceTrack | null = null;
    let how = '';
    let abs: string | null = null;
    if (a.file) {
      const sp = agentSamplePath(deps, a.file, caller);
      abs = sp.abs;
      const same = (c: Channel) => {
        const s = c.generator.sampleId ? p.samples[c.generator.sampleId] : undefined;
        return !!s && deps.project.resolveSamplePath(s.path).toLowerCase() === sp.abs.toLowerCase() && audioClipsOf(p, c.id).length > 0;
      };
      const existing = p.channelOrder.map((id) => p.channels[id]).filter(same);
      const known = existing.find((c) => isReferenceName(c.name)) ?? existing[0];
      if (known) {
        if (!isReferenceName(known.name)) ctx.exec('channels.set', { id: known.id, name: `${REFERENCE_PREFIX}${known.name}`.slice(0, 64) });
        p = deps.doc.project;
        track = findReference(p, known.id);
        how = 'already on the Playlist';
      } else {
        if (!deps.vocals) fail("Importing audio isn't available in this session (see the Krypt Studio log).");
        const title = path.basename(sp.abs).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || 'Song';
        const r = await deps.vocals.importFile({ docPath: sp.docPath, abs: sp.abs }, { start: 0, name: `${REFERENCE_PREFIX}${title}` }, <T,>(cmd: string, args: unknown): T => ctx.exec<T>(cmd, args));
        if (!r.ok || !r.data) fail(r.message ?? 'Import failed');
        p = deps.doc.project;
        track = findReference(p, r.data.channelId);
        how = `imported on track ${r.data.track}`;
      }
    } else if (a.clip) {
      const clip = findAudioClip(p, a.clip);
      const ch = clip.channelId ? p.channels[clip.channelId] : undefined;
      if (!ch || !ch.generator.sampleId) fail(`Clip ${safeName(a.clip, 40)} has no song on it.`);
      if (!isReferenceName(ch.name)) ctx.exec('channels.set', { id: ch.id, name: `${REFERENCE_PREFIX}${ch.name}`.slice(0, 64) });
      p = deps.doc.project;
      track = findReference(p, ch.id);
      how = 'adopted from the Playlist';
    } else {
      track = findReference(p);
      if (!track) fail('No song given: pass file (the path of the song the user gave, e.g. one they dragged into the chat) or clip (a song already on the Playlist).');
      how = 'the project\'s reference';
    }
    if (!track) fail("Couldn't find the reference track after placing it.");
    const muted = muteReference(ctx, deps.doc.project, track.channel);
    const studied = await studyReference(deps, track, g.id, ctx, a.stems === false ? 'off' : 'run');
    if (studied.stemProblem) warnings.push(`The drum stem couldn't be read (${studied.stemProblem}), so the drums come from the full mix (rougher).`);
    const b = studied.brief;
    const lib = await libraryNote(deps, abs ?? studied.analysis.path);
    const name = deps.doc.project.channels[track.channel.id]?.name ?? track.channel.name;
    const genre = b.genre;
    const gName = genre ? genreInfo(genre).name : null;
    const tempoNote = b.bpm ? ` Keep its tempo (${b.bpm} bpm): while the reference is studied, set_tempo refuses a tempo more than 3% off it.` : '';
    const next = [
      `One prompt = a finished song; don't stop to ask the user.${tempoNote}`,
      `${b.genreSource === 'guessed' ? `The genre is an estimate: if the user named one, or the song is clearly another (${b.genres.slice(1).map((x) => genreInfo(x.id).name).join(', ') || 'see the list'}), pass it as genre. ` : ''}get_playbook ${JSON.stringify(genre ? { genre } : {})} still gives ${gName ?? 'the genre'}'s recipe (it follows this reference) for parts you add by hand.`,
      'After the build: write the ORIGINAL melody it asks for, check_originality, match_mix, then review_song (it grades your song against the reference: closeness, energy shape, loudness, tonal balance, width); fix the top issues, at most 2 rounds.',
      `Answer briefly: what you took from "${safeName(track.title, 60)}" (tempo, key, structure, drum feel, chords, sounds) and what is new, the review score, and 2-3 edits the user could ask for. The reference stays muted on its own track for A/B.`,
      `NEXT: build_from_reference ${JSON.stringify(genre ? { genre } : {})}: ONE call writes the whole instrumental bed from this reference (its drum programming, chord progression, bass rhythm, sections, markers, transitions, matched sounds, buses, master, sidechain, levels) as one undo step, plus an empty matched "Lead" channel and the melody SHAPE for your ORIGINAL top line (never its melody, lyrics or hook).`,
    ];
    return {
      ok: true,
      message: `Studied "${safeName(track.title, 60)}" (${how}${muted ? ', muted' : ''}${studied.stems ? `, drums from the ${studied.stems.cached ? 'cached ' : ''}drum stem${studied.stems.cached ? '' : ` in ${Math.round(studied.stems.seconds)} s`}` : ''}): ${b.bpm ? `${b.bpm} bpm` : 'no steady tempo'}${b.keyFromChords ?? b.key ? `, ${b.keyFromChords ?? b.key}` : ''}${gName ? `, closest genre ${gName}${b.genreSource === 'given' ? ' (as asked)' : ''}` : ''}${b.plan.length ? `, ${b.plan.length} sections over ${b.totalBars} bars` : ''}. get_playbook and review_song now follow it (track "${safeName(name, 64)}").`,
      changed: [],
      text: [briefText(b), '', lib, '', ...next].join('\n'),
      warnings: warnings.length ? warnings : undefined,
      data: { channelId: track.channel.id, clipId: track.clipId, name, brief: b },
    };
  },
});

export const REFERENCE_TOOLS = [studyReferenceTool];
