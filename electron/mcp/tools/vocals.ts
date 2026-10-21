// Vocals & mashups tools: bring audio in (a file from the user's folders,
// or the bytes themselves), match a clip's key and tempo to the project or
// to another clip, and auto-tune a vocal with Krypt Tune. The work happens
// in electron/vocals (the clip menu calls the same service through IPC);
// every call is one undo group under the agent.

import { z } from 'zod';
import type { MainDeps, VocalsAccess } from '../types';
import type { AudioTarget } from '@shared/types';
import { TUNE_STYLES, type TuneStyle } from '@shared/music/keymatch';
import { decodeBase64Audio, MAX_IMPORT_BYTES } from '../../vocals/service';
import { defineTool, fail, type RunCtx } from './types';
import { agentSamplePath, findChannel, parsePosition, safeName } from './util';
import { findAudioClip } from './ears';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

function vocals(deps: MainDeps): VocalsAccess {
  if (!deps.vocals) fail('The vocals tools are not available in this session (see the Krypt Studio log).');
  return deps.vocals;
}

function runOpts(ctx: RunCtx) {
  return { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'working') : undefined, signal: ctx.signal };
}

const apply = (ctx: RunCtx) => <T>(cmd: string, args: unknown): T => ctx.exec<T>(cmd, args);

/** An audio clip id, or an audio channel's name / id when it has exactly one clip. */
function clipOf(deps: MainDeps, ref: string): string {
  return findAudioClip(deps.doc.project, ref).id;
}

// ── import_audio ────────────────────────────────────────────────────────

export const importAudio = defineTool({
  name: 'import_audio',
  title: 'Import audio onto the Playlist',
  kind: 'write',
  description:
    `Put an audio file on the Playlist as an audio clip on a new track (one undo step), e.g. a vocal, a whole song to remix, or a reference song to study. Two sources: path = an absolute path to a local audio file (wav, flac, mp3, ogg, aiff, m4a …), used in place: any local file loads directly (e.g. from Downloads). Only when the user set File access to "Ask me" are files outside the factory kit, their Browser folders and the project's own files asked about first (the call waits: allow this file / allow its folder / deny); "Browser folders only" refuses them. Or data + name = the file's bytes as base64, only for clients that hold audio the user can't point to (max ${MAX_IMPORT_BYTES / 1048576} MB decoded; stored once in Krypt Studio's imports folder; name WITH its extension). Prefer path whenever the user gives one. name = the track/clip name (e.g. "Reference: Song"); mute = mute its track (a reference to A/B against); bar = where it starts (default 1; "bar.step" works). Returns the clip id, channel id, track and duration. Next: analyze_audio (tempo, key), separate_stems (vocals / drums / bass / other), match_clip, tune_vocal. Example: {"path":"C:\\\\Users\\\\me\\\\Downloads\\\\song.mp3","name":"Reference: song","mute":true}`,
  input: z.object({
    path: z.string().min(1).max(400).optional().describe('Absolute path to a local audio file, or "factory:…".'),
    data: z.string().optional().describe('The audio file\'s bytes, base64 (a "data:audio/…;base64," prefix is fine).'),
    name: z.string().max(200).optional().describe('With data: the file name with its extension, e.g. "vocal.wav" (also the clip name). With path: an optional clip name.'),
    bar: z.union([z.number(), z.string().max(16)]).optional().describe('Start position: bar (1-based) or "bar.step". Default 1.'),
    mute: z.boolean().default(false).describe('Mute the new track: a reference to compare against, which the user unmutes to A/B.'),
    change_label: zLabel,
  }),
  summarize: (a) => safeName(a.name ?? a.path?.split(/[\\/:]/).pop() ?? 'audio', 40),
  paths: (a) => [{ value: a.path, kind: 'audio' }],
  async run(deps, caller, a, ctx) {
    const svc = vocals(deps);
    if (!!a.path === !!a.data) fail('Pass either path (an audio file on this PC, or "factory:…") or data + name (the audio bytes as base64), not both.');
    const p = deps.doc.project;
    const start = a.bar === undefined ? 0 : parsePosition(a.bar, p.transport.timeSig);
    let r;
    if (a.data) {
      if (!a.name?.trim()) fail('name is required with data: the file name with its extension, e.g. "vocal.wav".');
      const dec = decodeBase64Audio(a.data);
      if ('error' in dec) fail(dec.error);
      r = await svc.importUpload(dec.bytes, a.name, { start }, apply(ctx));
    } else {
      const { docPath, abs } = agentSamplePath(deps, a.path!, caller);
      r = await svc.importFile({ docPath, abs }, { start, name: a.name ? a.name.replace(/\.[a-z0-9]{2,5}$/i, '') : undefined }, apply(ctx));
    }
    if (!r.ok || !r.data) fail(r.message ?? 'Import failed');
    const d = r.data;
    if (a.mute) ctx.exec('playlist.setTrack', { id: d.trackId, mute: true });
    return {
      ok: true,
      message: `${r.message} Clip ${d.clipId}, channel ${d.channelId} ("${safeName(d.name, 64)}")${a.mute ? `; track ${d.track} is muted (the user unmutes it to A/B)` : ''}.`,
      changed: [],
      text: `Next: analyze_audio {"target":"${d.clipId}"} reads its tempo and key; separate_stems {"clip":"${d.clipId}"} splits it into vocals / drums / bass / other (needs the user's stem model, see list_models); match_clip moves it onto the project's key and tempo; tune_vocal adds Krypt Tune.`,
      data: { clipId: d.clipId, channelId: d.channelId, sampleId: d.sampleId, track: d.track, trackId: d.trackId, trackName: d.trackName, name: d.name, durationSec: d.durationSec, sampleRate: d.sampleRate, channels: d.channels, deduped: d.deduped, bytes: d.bytes },
    };
  },
});

// ── match_clip ──────────────────────────────────────────────────────────

export const matchClip = defineTool({
  name: 'match_clip',
  title: 'Match a clip to the key and tempo',
  kind: 'write',
  description:
    'Match an audio clip (e.g. a vocal) to the project or to another audio clip, in one undo step. Key: pitches the clip by the smallest move (−6..+6 st) that puts its key on the target\'s, from analyze_audio readings; relative keys share their notes, so an A minor vocal on a C major beat needs 0 st. Formants are kept. The project\'s key comes from its pitched patterns, else its other audio. semitones sets the pitch yourself (−24..24). Tempo: the clip follows the project tempo from its detected tempo, read at the half / double-time reading that stretches least. to = a clip that plays at its own tempo: that tempo becomes the project tempo (that clip then follows it unstretched, like the beat of a mashup) and other audio that plays at its own speed is rescaled to stay in place. A stem reads key and tempo from its source mix. Example: {"clip":"Song A · Vocals","to":"Song B"}',
  input: z.object({
    clip: z.string().min(1).max(200).describe('Audio clip id, or the name/id of an audio channel with one clip.'),
    to: z.string().max(200).default('project').describe('"project" (default) or another audio clip id / audio channel name.'),
    key: z.boolean().default(true).describe('Match the key (default true).'),
    tempo: z.boolean().default(true).describe('Follow the tempo (default true).'),
    semitones: z.number().optional().describe('Set the pitch to this many semitones instead of the detected key move.'),
    formant: z.boolean().default(true).describe('Keep formants on a pitch shift (default true; false = chipmunk / monster voice).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.clip, 30)} → ${safeName(a.to, 24)}`,
  async run(deps, _c, a, ctx) {
    const svc = vocals(deps);
    const clipId = clipOf(deps, a.clip);
    const toRaw = a.to.trim();
    const to = !toRaw || /^project$/i.test(toRaw) ? ('project' as const) : { clipId: clipOf(deps, toRaw) };
    const r = await svc.match(clipId, { to, key: a.key, tempo: a.tempo, semitones: a.semitones, formant: a.formant }, apply(ctx), runOpts(ctx));
    if (!r.ok || !r.data) fail(r.message ?? 'Match failed');
    return { ok: true, message: r.message ?? 'Matched', changed: [], data: r.data };
  },
});

// ── tune_vocal ──────────────────────────────────────────────────────────

const STYLE_TEXT = (Object.keys(TUNE_STYLES) as TuneStyle[]).map((k) => `${k} (retune ${TUNE_STYLES[k].speed} ms, humanize ${Math.round(TUNE_STYLES[k].humanize * 100)}%)`).join(', ');

export const tuneVocal = defineTool({
  name: 'tune_vocal',
  title: 'Tune a vocal (Krypt Tune)',
  kind: 'write',
  description:
    `Pitch-correct a vocal (or any one-note-at-a-time part) with Krypt Tune on its mixer insert, in one undo step: added FIRST in the chain (before EQ, compression and space effects), or the Krypt Tune already there is updated, never duplicated. style: ${STYLE_TEXT}; natural fixes pitch and keeps vibrato, hard is the robotic trap effect. Key: pass key ("F#m", "A minor", "D dorian") or let it be detected: from the vocal's own analysis (after any pitch shift), else from the instrumental when the vocal's reading is weak, else from the patterns; the result says which. scale overrides the scale (chromatic, major, minor, harmonic minor, major pentatonic, minor pentatonic, dorian, mixolydian, blues). clip: an audio clip id, or a channel name/id. Example: {"clip":"Song A · Vocals","style":"hard"}`,
  input: z.object({
    clip: z.string().min(1).max(200).describe('Audio clip id, or a channel name / id (its mixer insert gets Krypt Tune).'),
    style: z.enum(['natural', 'pop', 'hard']).default('pop'),
    key: z.string().max(32).optional().describe('e.g. "F#m", "A minor", "Eb", "D dorian". Default: detected.'),
    scale: z.string().max(32).optional().describe('Override the scale, e.g. "chromatic", "minor pentatonic", "blues".'),
    amount: z.number().min(0).max(100).optional().describe('Correction amount in % (default 100).'),
    mix: z.number().min(0).max(100).optional().describe("Krypt Tune's wet mix in % (default 100)."),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.clip, 30)} (${a.style})`,
  async run(deps, _c, a, ctx) {
    const svc = vocals(deps);
    const p = deps.doc.project;
    const r0 = a.clip.trim();
    let target: AudioTarget;
    if (p.playlist.clips[r0]) target = { clipId: findAudioClip(p, r0).id };
    else {
      const ch = findChannel(p, r0);
      const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === ch.id);
      target = clips.length === 1 ? { clipId: clips[0].id } : { channelId: ch.id };
    }
    const r = await svc.tune(target, { style: a.style, key: a.key, scale: a.scale, amount: a.amount !== undefined ? a.amount / 100 : undefined, mix: a.mix !== undefined ? a.mix / 100 : undefined }, apply(ctx), runOpts(ctx));
    if (!r.ok || !r.data) fail(r.message ?? 'Tuning failed');
    return { ok: true, message: r.message ?? 'Tuned', changed: [], data: r.data };
  },
});

export const VOCALS_TOOLS = [importAudio, matchClip, tuneVocal];
