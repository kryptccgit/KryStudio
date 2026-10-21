// "Ears" tools (research/08 §3, §6): hear an audio file (tempo, key,
// sections, loudness), split a clip into stems, transcribe audio into a
// pattern, time-stretch / pitch / tempo-sync an audio clip, list models.
// All ML runs in krypt-studio-analyzer.exe through electron/analyzer;
// agents only ever use INSTALLED models — downloads are the user's call.

import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Clip, Project } from '@shared/schema/project';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { AudioTarget, ModelState } from '@shared/types';
import { PPQ } from '@shared/schema/time';
import { defineTool, fail, type RunCtx, type ToolCaller } from './types';
import { agentSamplePath, findChannel, findPluginRef, fmtBars, fmtPos, looksLikePath, parseParamValue, plural, round, safeName } from './util';
import { effectiveBpm, AUDIOCLIP } from '../../analyzer/convert';
import { snapBpm, syncBpm } from '@shared/analyzer/tempo';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
export const NO_INSTALL = "Agents can't download models: ask the user to install it in Krypt Studio's Model Manager.";

type Ears = NonNullable<MainDeps['analyzer']>;

function ears(deps: MainDeps): Ears {
  if (!deps.analyzer) fail('Audio analysis is not available in this session (the analyzer service did not start; see the Krypt Studio log).');
  return deps.analyzer;
}

function runOpts(ctx: RunCtx) {
  return { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'working') : undefined, signal: ctx.signal };
}

export function clipLabel(p: Project, c: Clip): string {
  const ch = c.channelId ? p.channels[c.channelId] : undefined;
  return `"${safeName(ch?.name ?? 'audio')}" @${fmtPos(c.start, p.transport.timeSig)}`;
}

function audioClipsOf(p: Project, channelId: string): Clip[] {
  return Object.values(p.playlist.clips)
    .filter((c) => c.kind === 'audio' && c.channelId === channelId)
    .sort((a, b) => a.start - b.start);
}

/** An audio clip by clip id, or by the name / id of its audio-clip channel (when it has exactly one clip). */
export function findAudioClip(p: Project, ref: string): Clip {
  const r = ref.trim();
  const direct = p.playlist.clips[r];
  if (direct) {
    if (direct.kind !== 'audio') fail(`Clip ${safeName(r)} is a ${direct.kind} clip; this tool works on audio clips`);
    return direct;
  }
  const ch = findChannel(p, r);
  const clips = audioClipsOf(p, ch.id);
  if (clips.length === 1) return clips[0];
  if (clips.length === 0) fail(`"${safeName(ch.name)}" has no audio clip on the Playlist${ch.generator.type === AUDIOCLIP ? '' : ' (it is not an audio-clip channel)'}`);
  fail(`"${safeName(ch.name)}" has ${clips.length} audio clips; pass a clip id: ${clips.map((c) => `${c.id} (${clipLabel(p, c)})`).join(', ')}`);
}

/** clip id → clip; "C:\…" / "factory:…" → file (allow-listed, or allowed by the user); else a channel (its only clip when it has one). */
export function resolveTarget(deps: MainDeps, ref: string, preferClip: boolean, caller?: Pick<ToolCaller, 'via'>): { target: AudioTarget; label: string } {
  const p = deps.doc.project;
  const r = ref.trim();
  if (!r) fail('target is empty: pass an audio clip id, a channel name or a file path');
  if (p.playlist.clips[r]) {
    const c = findAudioClip(p, r);
    return { target: { clipId: c.id }, label: clipLabel(p, c) };
  }
  if (looksLikePath(r)) {
    const { abs } = agentSamplePath(deps, r, caller);
    return { target: { path: abs }, label: `"${safeName(abs.split(/[\\/]/).pop() ?? abs)}"` };
  }
  const ch = findChannel(p, r);
  if (!ch.generator.sampleId) fail(`"${safeName(ch.name)}" plays no sample (${ch.generator.type}); analyse an audio clip, a sampler channel or a file`);
  const clips = audioClipsOf(p, ch.id);
  if (preferClip && clips.length === 1) return { target: { clipId: clips[0].id }, label: clipLabel(p, clips[0]) };
  return { target: { channelId: ch.id }, label: `channel "${safeName(ch.name)}"` };
}

// ── analyze_audio ───────────────────────────────────────────────────────

function mmss(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function analysisReport(a: AudioAnalysis, label: string): { text: string; data: Record<string, unknown> } {
  const est = new Set(a.estimated ?? []);
  const tag = (f: string): string => (est.has(f) ? ' (estimated)' : '');
  const lines: string[] = [];
  lines.push(`audio     ${label}  ${round(a.durationSec, 1)} s, ${a.sampleRate} Hz, ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`}`);
  const bpm = a.tempo?.bpm ?? null;
  if (a.tempo) {
    const alts = (a.tempo.alternatives ?? []).filter((x) => Number.isFinite(x)).map((x) => round(x, 1));
    lines.push(`tempo     ${round(a.tempo.bpm, 1)} bpm, confidence ${round(a.tempo.confidence, 2)}${alts.length ? `; also plausible ${alts.join(' / ')} bpm` : ''}${tag('tempo')}`);
  } else lines.push(`tempo     no steady pulse detected (ambient, speech or free time)${tag('tempo')}`);
  const beats = a.beats;
  const t0 = beats ? beats.downbeats[0] ?? beats.times[0] ?? 0 : 0;
  const barSec = bpm && beats ? (beats.beatsPerBar * 60) / bpm : 0;
  const barAt = (sec: number): number => (barSec > 0 ? Math.max(1, Math.floor((sec - t0) / barSec + 1e-6) + 1) : 0);
  if (beats) lines.push(`beats     ${beats.times.length} beats, ${beats.beatsPerBar}/bar, first downbeat at ${round(t0, 2)} s${tag('beats')}`);
  lines.push(a.key ? `key       ${a.key.name} (${a.key.tonic} ${a.key.mode}), confidence ${round(a.key.confidence, 2)}${tag('key')}` : `key       not detected (atonal, drums only or ambiguous)${tag('key')}`);
  if (a.swing !== null && a.swing !== undefined) lines.push(`swing     ${Math.round(a.swing * 100)}% (set_swing scale: 0 = straight, ~67 = triplet feel, 100 = maximum)${tag('swing')}`);
  const sections = (a.sections ?? []).map((s) => {
    const bars = barSec > 0 ? (() => {
      const b0 = barAt(s.startSec);
      const b1 = Math.max(b0, barAt(Math.max(s.startSec, s.endSec - 1e-3)));
      return b0 === b1 ? `${b0}` : `${b0}-${b1}`;
    })() : null;
    return { label: s.label, startSec: round(s.startSec, 2), endSec: round(s.endSec, 2), bars, lufs: Number.isFinite(s.lufs) ? round(s.lufs, 1) : null };
  });
  if (sections.length) {
    lines.push(`sections  ${sections.map((s) => `${s.label} ${s.bars ? `bars ${s.bars} ` : ''}(${mmss(s.startSec)}-${mmss(s.endSec)}${s.lufs !== null ? `, ${s.lufs} LUFS` : ''})`).join(' | ')}${tag('sections')}${barSec ? `  [bars at ${round(bpm!, 1)} bpm from the first downbeat]` : ''}`);
  }
  const L = a.levels;
  if (L) {
    lines.push(`loudness  I ${round(L.lufsIntegrated, 1)} LUFS, short-term max ${round(L.lufsShortTermMax, 1)}, true peak ${round(L.truePeakDb, 1)} dBTP, crest ${round(L.crestDb, 1)} dB, LRA ${round(L.loudnessRange, 1)}${L.clipping ? ', CLIPPING' : ''}`);
    if (L.bands) lines.push(`bands dB  ${Object.entries(L.bands).map(([k, v]) => `${k} ${round(v as number, 1)}`).join(' | ')}${L.spectralCentroidHz ? `  centroid ${Math.round(L.spectralCentroidHz)} Hz` : ''}`);
  }
  if (a.stereo) lines.push(`stereo    width ${round(a.stereo.width, 2)} (0 mono .. 1 very wide), correlation ${round(a.stereo.correlation, 2)}`);
  if (Number.isFinite(a.onsetRate)) lines.push(`onsets    ${round(a.onsetRate, 1)} per second`);
  const energy = a.energy?.lufs ?? [];
  if (energy.length) {
    const step = Math.max(1, Math.ceil(energy.length / 24));
    const pts: string[] = [];
    for (let i = 0; i < energy.length; i += step) {
      const slice = energy.slice(i, i + step).filter((x) => Number.isFinite(x));
      pts.push(slice.length ? String(round(Math.max(...slice), 0)) : '-inf');
    }
    lines.push(`energy    ${pts.join(' ')}  (LUFS, ~${round((a.energy.hopSec || 0) * step, 1)} s steps)`);
  }
  if (a.sources?.length) lines.push(`sources   ${a.sources.join(', ')}`);
  lines.push('Values marked (estimated) come from heuristics / ML: confirm by ear (render_preview) before relying on them.');
  return {
    text: lines.join('\n'),
    data: {
      durationSec: round(a.durationSec, 2),
      sampleRate: a.sampleRate,
      channels: a.channels,
      tempo: a.tempo ? { bpm: round(a.tempo.bpm, 2), confidence: round(a.tempo.confidence, 2), alternatives: a.tempo.alternatives } : null,
      beats: beats ? { count: beats.times.length, beatsPerBar: beats.beatsPerBar, firstDownbeatSec: round(t0, 3) } : null,
      key: a.key,
      swing: a.swing,
      sections,
      loudness: L ? { lufs: round(L.lufsIntegrated, 1), truePeakDb: round(L.truePeakDb, 1), peakDb: round(L.peakDb, 1), crestDb: round(L.crestDb, 1), lra: round(L.loudnessRange, 1), clipping: L.clipping, bands: L.bands } : null,
      stereo: a.stereo,
      onsetRate: a.onsetRate,
      estimated: a.estimated,
      sources: a.sources,
    },
  };
}

export const analyzeAudio = defineTool({
  name: 'analyze_audio',
  title: 'Hear an audio file or clip',
  kind: 'read',
  description:
    'Listen to audio (on-device analysis, cached per file): tempo with confidence and half/double-time alternatives, beat grid, key, swing, repeated sections (with bar numbers at the detected tempo), loudness (LUFS, true peak, crest, LRA), 6 band levels, stereo width/correlation, onset rate and an energy curve. Estimates are labelled. target: an audio clip id, an audio / sampler channel name or id, or a file path ("factory:drums/kick.wav" or an absolute path to any local audio file; when the user set File access to "Ask me", files outside their Browser folders are asked about first). Use it to match a loop\'s tempo/key before writing parts, or to read a reference song. Example: {"target":"Drum Loop"}',
  input: z.object({
    target: z.string().min(1).max(400).describe('Audio clip id, channel name/id, or file path.'),
  }),
  summarize: (a) => safeName(a.target, 40),
  paths: (a) => (looksLikePath(a.target) ? [{ value: a.target, kind: 'audio' }] : []),
  async run(deps, caller, a, ctx) {
    const svc = ears(deps);
    const { target, label } = resolveTarget(deps, a.target, false, caller);
    const r = await svc.analyze(target, runOpts(ctx));
    if (!r.ok || !r.data) fail(r.message ?? 'Analysis failed');
    const rep = analysisReport(r.data, label);
    return { ok: true, message: r.message ?? `Analysed ${label}`, changed: [], text: rep.text, data: rep.data };
  },
});

// ── separate_stems ──────────────────────────────────────────────────────

export function defaultOf(models: ModelState[], task: ModelState['def']['task']): ModelState | undefined {
  return models.find((m) => m.def.task === task && m.def.default) ?? models.find((m) => m.def.task === task);
}

export function modelProblem(state: ModelState | undefined, fallbackName: string): string {
  const name = state?.def.name ?? fallbackName;
  if (!state) return `No stem model is known to this build. ${NO_INSTALL}`;
  switch (state.status) {
    case 'downloading':
    case 'verifying':
      return `${name} is being installed right now (${state.status}); try again when it has finished.`;
    case 'unavailable':
      return `${name} isn't available: ${state.message ?? 'no published download'}. ${NO_INSTALL}`;
    case 'failed':
      return `${name} isn't installed (its last install failed: ${state.message ?? 'unknown error'}). ${NO_INSTALL}`;
    default:
      return `${name} isn't installed. ${NO_INSTALL.replace('install it', `install "${name}"`)} (It is an opt-in download${state.def.files.length ? ` of about ${Math.max(1, Math.round(state.def.files.reduce((s, f) => s + f.bytes, 0) / 1048576))} MB` : ''}.)`;
  }
}

export const separateStems = defineTool({
  name: 'separate_stems',
  title: 'Separate an audio clip into stems',
  kind: 'write',
  description:
    'Split an audio clip into stems (drums, bass, vocals, other with HT-Demucs) on-device. Each stem lands on a new playlist track directly under the source clip, aligned with it, as its own audio-clip channel + mixer insert that keeps the source\'s stretch / pitch / tempo-sync settings; the source clip is muted. One undo step. Needs a stem model the USER installed in Model Manager (you can\'t download models; list_models shows what is installed). Takes ~20 s per minute of audio on CPU, a few seconds on a GPU; repeat separations come from a cache. clip: an audio clip id, or the audio channel\'s name when it has one clip. Example: {"clip":"Breakbeat"}',
  input: z.object({
    clip: z.string().min(1).max(200).describe('Audio clip id, or the name/id of an audio-clip channel with exactly one clip.'),
    model: z.string().max(64).optional().describe('Stem model id (default: the default installed stem model, e.g. "htdemucs").'),
    change_label: zLabel,
  }),
  summarize: (a) => safeName(a.clip, 40),
  async run(deps, _c, a, ctx) {
    const svc = ears(deps);
    const clip = findAudioClip(deps.doc.project, a.clip);
    const models = svc.listModels();
    const st = a.model ? models.find((m) => m.def.id === a.model) : defaultOf(models, 'stems');
    if (!st) fail(a.model ? `Unknown model "${safeName(a.model, 40)}". list_models shows the models.` : `No stem model is known to this build. ${NO_INSTALL}`);
    if (st.def.task !== 'stems') fail(`${st.def.name} is a ${st.def.task} model, not a stem separator`);
    const def = st.def;
    if (st.status !== 'installed') fail(modelProblem(st, def.name));
    const r = await svc.separateStems(clip.id, { model: def.id }, (cmd, args) => ctx.exec(cmd, args), runOpts(ctx));
    if (!r.ok || !r.data) fail(r.message ?? 'Stem separation failed');
    const p = deps.doc.project;
    const lines = r.data.trackIds.map((t, i) => `  T${p.playlist.trackOrder.indexOf(t) + 1} "${safeName(p.playlist.tracks[t]?.name)}" → channel ${r.data!.channelIds[i]}`);
    return { ok: true, message: r.message ?? 'Separated', changed: [], data: r.data, text: `New stem tracks:\n${lines.join('\n')}` };
  },
});

// ── audio_to_pattern ────────────────────────────────────────────────────

const GRIDS: Record<string, number> = { off: 0, '1/8': PPQ / 2, '1/16': PPQ / 4, '1/32': PPQ / 8, '1/64': PPQ / 16 };

export const audioToPattern = defineTool({
  name: 'audio_to_pattern',
  title: 'Transcribe audio into a pattern',
  kind: 'write',
  description:
    'Transcribe audio into a NEW pattern (one undo step). mode "poly" = chords / polyphonic parts (Basic Pitch; best on a clean stem such as the "other" or piano stem), "mono" = one melodic line (vocal, lead, bass), "drums" = kick / snare / hat / open hat / perc hits. sound "original" (default for mono and drums): the notes play the audio itself, every note / hit its own recording picked by its velocity (an SFZ instrument on new channels "<source> <role>"), so the pattern re-creates the source and edits still play real audio; keep each note\'s velocity unless the user wants another take of it. sound "synth" (always for poly): a stock synth, and for drums the existing Kick, Snare, Hat, Open Hat, Perc channels (else the factory kit). Never transcribe a full mix: separate_stems first and convert each stem in its mode (drums stem → "drums", bass / vocals → "mono", other → "poly"). Timing uses the clip\'s source tempo when it is tempo-synced, else the project tempo; a pitched clip\'s notes are moved to the pitch heard. For a clip target the pattern is placed on a new track under the clip, aligned with it. Estimates: check with read_pattern / render_preview and clean up with transform_notes. target: audio clip id, audio channel name, or a file path. Example: {"target":"Drum Loop · Drums","mode":"drums","quantize":"1/16"}',
  input: z.object({
    target: z.string().min(1).max(400).describe('Audio clip id, channel name/id, or file path.'),
    mode: z.enum(['poly', 'mono', 'drums']),
    name: z.string().min(1).max(64).optional().describe('Pattern name (default "<source> notes" / "<source> drums").'),
    quantize: z.enum(['off', '1/8', '1/16', '1/32', '1/64']).default('off').describe('Snap notes to a grid (default off: keeps the performance timing).'),
    sound: z.enum(['original', 'synth']).optional().describe('What plays the notes: "original" (default for mono / drums) = the source audio itself, note by note; "synth" = a stock synth / your drum channels. poly is always synth.'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.target, 30)} (${a.mode})`,
  paths: (a) => (looksLikePath(a.target) ? [{ value: a.target, kind: 'audio' }] : []),
  async run(deps, caller, a, ctx) {
    const svc = ears(deps);
    const { target } = resolveTarget(deps, a.target, true, caller);
    if (a.mode === 'poly') {
      const st = defaultOf(svc.listModels(), 'transcribe');
      if (!st || st.status !== 'installed') fail(`Polyphonic transcription needs the ${st?.def.name ?? 'Basic Pitch'} model, which isn't installed${st?.message ? ` (${st.message})` : ''}. Use mode "mono" for a single line or "drums", or ask the user to (re)install it in Model Manager.`);
    }
    const sound = a.sound === 'synth' ? 'synth' : a.sound === 'original' ? 'source' : undefined;
    const r = await svc.toPattern(target, { mode: a.mode, name: a.name ? safeName(a.name, 64) : undefined, quantize: GRIDS[a.quantize] ?? 0, sound }, (cmd, args) => ctx.exec(cmd, args), runOpts(ctx));
    if (!r.ok || !r.data) fail(r.message ?? 'Transcription failed');
    return { ok: true, message: r.message ?? 'Transcribed', changed: [], data: r.data };
  },
});

// ── stretch_clip ────────────────────────────────────────────────────────

const zValue = z.union([z.number(), z.string().max(32), z.boolean()]);

export const stretchClip = defineTool({
  name: 'stretch_clip',
  title: 'Time-stretch / pitch an audio clip',
  kind: 'write',
  description:
    'Change how an audio clip plays (its Audio Clip channel, so every clip of that channel follows): pitch in semitones (e.g. -2, "+3st"), formant (preserve formants on pitch shifts: true/false or a value), stretch (time-stretch amount / mode as the Audio Clip exposes it; describe_plugin {"channel":…} lists the range), and sync_to_tempo: true to make the clip follow the project tempo — its source tempo comes from source_bpm or, when omitted, from analyze_audio (for a stem, of its source mix; a half/double-time reading is used when only that one is near the project tempo). The clip lengths are rescaled so the same audio stays visible. One undo step. Example: {"clip":"Vocal Chop","sync_to_tempo":true,"pitch":2}',
  input: z.object({
    clip: z.string().min(1).max(200).describe('Audio clip id, or the name/id of its audio-clip channel.'),
    pitch: z.union([z.number().min(-48).max(48), z.string().max(16)]).optional(),
    formant: zValue.optional(),
    stretch: zValue.optional(),
    sync_to_tempo: z.boolean().optional(),
    source_bpm: z.number().min(20).max(999).optional().describe("The clip's original tempo (skips detection)."),
    change_label: zLabel,
  }),
  summarize: (a) => safeName(a.clip, 40),
  async run(deps, _c, a, ctx) {
    const p0 = deps.doc.project;
    const r0 = a.clip.trim();
    const clip0 = p0.playlist.clips[r0] ? findAudioClip(p0, r0) : null;
    const ch = clip0?.channelId ? p0.channels[clip0.channelId] : findChannel(p0, r0);
    if (!ch) fail('That clip has no audio channel');
    if (ch.generator.type !== AUDIOCLIP) fail(`stretch_clip works on audio clips; "${safeName(ch.name)}" is a ${findPluginRef(deps.doc.catalog, ch.generator.type).name} channel (use set_channel pitch for instruments)`);
    const desc = findPluginRef(deps.doc.catalog, AUDIOCLIP, 'instrument');
    const spec = (id: string) =>
      desc.params.find((s) => s.id === id) ??
      fail(`This build's Audio Clip has no "${id}" parameter yet: the time-stretch engine update isn't built. Ask the user to update / rebuild Krypt Studio (npm run engine:build).`);

    const params: Record<string, number> = {};
    const notes: string[] = [];
    if (a.pitch !== undefined) {
      params.pitch = parseParamValue(spec('pitch'), a.pitch);
      notes.push(`pitch ${params.pitch >= 0 ? '+' : ''}${round(params.pitch, 2)} st`);
    }
    if (a.formant !== undefined) {
      params.formant = parseParamValue(spec('formant'), a.formant);
      notes.push(`formant ${params.formant}`);
    }
    if (a.stretch !== undefined) {
      params.stretch = parseParamValue(spec('stretch'), a.stretch);
      notes.push(`stretch ${params.stretch}`);
    }
    if (a.sync_to_tempo === true) {
      let bpm = a.source_bpm;
      let how = 'given';
      if (bpm === undefined) {
        const svc = ears(deps);
        // A stem's own tempo reading is less reliable than its full mix's: use the source mix when it is still in the project.
        const parentId = ch.generator.sampleId ? p0.samples[ch.generator.sampleId]?.origin?.parentSampleId : undefined;
        const parent = parentId ? Object.values(p0.channels).find((c) => c.generator.sampleId === parentId) : undefined;
        const target: AudioTarget = parent ? { channelId: parent.id } : clip0 ? { clipId: clip0.id } : { channelId: ch.id };
        const r = await svc.analyze(target, runOpts(ctx));
        if (!r.ok || !r.data) fail(`Couldn't detect the clip's tempo: ${r.message ?? 'analysis failed'}. Pass source_bpm.`);
        if (!r.data.tempo) fail(`No steady tempo was detected in "${safeName(parent?.name ?? ch.name)}". Pass source_bpm (its original tempo) to sync it.`);
        bpm = syncBpm(r.data.tempo, p0.transport.bpm);
        const raw = snapBpm(r.data.tempo.bpm);
        how = `detected${parent ? ` on its source mix "${safeName(parent.name)}"` : ''}, confidence ${round(r.data.tempo.confidence, 2)}${raw !== bpm ? `; read as ${bpm} rather than ${raw}, the same pulse nearest the project tempo` : ''}`;
      }
      spec('tempo_sync');
      params.tempo_sync = 1;
      params.src_bpm = parseParamValue(spec('src_bpm'), bpm);
      notes.push(`synced to the project tempo from ${params.src_bpm} bpm (${how})`);
    } else if (a.sync_to_tempo === false) {
      params.tempo_sync = parseParamValue(spec('tempo_sync'), 0);
      notes.push('tempo sync off');
      if (a.source_bpm !== undefined) params.src_bpm = parseParamValue(spec('src_bpm'), a.source_bpm);
    } else if (a.source_bpm !== undefined) {
      params.src_bpm = parseParamValue(spec('src_bpm'), a.source_bpm);
      notes.push(`source tempo ${params.src_bpm} bpm`);
    }
    if (Object.keys(params).length === 0) fail('Nothing to change: pass pitch, formant, stretch, sync_to_tempo or source_bpm.');

    // channels.setGenParams rescales the channel's clips itself when the timing changes (shared/commands/audioTiming.ts).
    const lengths = new Map(audioClipsOf(p0, ch.id).map((c) => [c.id, c.length]));
    ctx.exec('channels.setGenParams', { id: ch.id, params });
    const p = deps.doc.project;
    const after = effectiveBpm(p, deps.doc.catalog, p.channels[ch.id]);
    const moved = audioClipsOf(p, ch.id).filter((c) => lengths.has(c.id) && lengths.get(c.id) !== c.length);
    const lengthNote = moved.length
      ? ` ${plural(moved.length, 'clip')} rescaled so the same audio stays visible (${fmtBars(lengths.get(moved[0].id)!, p.transport.timeSig)} → ${fmtBars(moved[0].length, p.transport.timeSig)}${moved.length > 1 ? ' for the first' : ''}).`
      : '';
    return {
      ok: true,
      message: `"${safeName(ch.name)}": ${notes.join(', ')}.${after.synced ? ` It now follows the project's ${p.transport.bpm} bpm.` : ''}${lengthNote}`,
      changed: [],
      data: { channelId: ch.id, params, effectiveBpm: after.bpm, synced: after.synced },
    };
  },
});

// ── list_models ─────────────────────────────────────────────────────────

function statusText(m: ModelState): string {
  switch (m.status) {
    case 'installed':
      return m.def.bundled ? 'installed (bundled)' : 'installed';
    case 'available':
      return 'not installed (the user can download it in Model Manager)';
    case 'downloading':
      return `downloading${m.progress && m.progress.total ? ` ${Math.round((100 * m.progress.received) / m.progress.total)}%` : ''}`;
    case 'verifying':
      return 'verifying';
    case 'failed':
      return `install failed: ${m.message ?? 'unknown error'}`;
    default:
      return `unavailable: ${m.message ?? 'not published'}`;
  }
}

export const listModels = defineTool({
  name: 'list_models',
  title: 'List on-device ML models',
  kind: 'read',
  description:
    'On-device ML models (Model Manager): what each does (stems / transcribe / beats), whether it is installed, its licence and caveats. separate_stems and audio_to_pattern mode "poly" need an installed model. Only the user can download or import models.',
  input: z.object({}),
  run(deps) {
    const models = ears(deps).listModels();
    const lines = models.map((m) => {
      const mb = m.def.files.reduce((s, f) => s + f.bytes, 0) / 1048576;
      return `  ${m.def.id.padEnd(16)} ${safeName(m.def.name)} · ${m.def.task} · ${statusText(m)} · licence ${m.def.license.name}${m.def.license.notice ? ` (note: ${m.def.license.notice})` : ''}${mb >= 1 ? ` · ${Math.round(mb)} MB` : ''}${m.def.speed ? ` · ${m.def.speed}` : ''}`;
    });
    const installed = models.filter((m) => m.status === 'installed').length;
    return {
      ok: true,
      message: `${plural(models.length, 'model')}, ${installed} installed.`,
      changed: [],
      text: `Models:\n${lines.join('\n')}\nAgents can't download or import models; ask the user (Model Manager) when one you need isn't installed.`,
      data: models.map((m) => ({ id: m.def.id, name: m.def.name, task: m.def.task, status: m.status, bundled: m.def.bundled, license: m.def.license, message: m.message, stems: m.def.stems, description: m.def.description })),
    };
  },
});

export const EARS_TOOLS = [analyzeAudio, separateStems, audioToPattern, stretchClip, listModels];
