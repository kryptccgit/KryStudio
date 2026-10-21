import path from 'node:path';
import type { DocHost } from '@shared/doc/DocHost';
import type { ActionResult, AudioTarget, SliceToPadsOptions, SliceToPadsOutcome } from '@shared/types';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { SampleInfo } from '@shared/engine/protocol';
import { MAX_SLICES, midiNoteName, sliceTimes } from '@shared/commands/racks';
import { DRUM_RACK_BASE_NOTE } from '@shared/schema/rack';
import { SLICER_PLUGIN } from '@shared/schema/slicer';

export type SliceApply = <T = unknown>(cmd: string, args: unknown) => T;

export interface SliceDeps {
  doc: Pick<DocHost, 'project'>;
  analyze?(target: AudioTarget, opts: { drums?: boolean; onProgress?(stage: string, fraction: number): void; signal?: AbortSignal }): Promise<ActionResult<AudioAnalysis>>;
  sampleInfo?(absPath: string): Promise<ActionResult<SampleInfo>>;
  resolveSamplePath(p: string): string;
}

export interface SliceRun {
  onProgress?(stage: string, fraction: number): void;
  signal?: AbortSignal;
}

const fail = <T>(message: string): ActionResult<T> => ({ ok: false, message });

export function cleanSliceOptions(raw: unknown): SliceToPadsOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  const mode = o.mode === 'grid' || o.mode === 'manual' || o.mode === 'onsets' ? o.mode : undefined;
  return {
    to: o.to === 'slicer' || o.to === 'pads' ? o.to : undefined,
    mode,
    times: Array.isArray(o.times) ? o.times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0).slice(0, 512) : undefined,
    division: num(o.division, 1 / 16, 16),
    maxSlices: num(o.maxSlices, 1, MAX_SLICES),
    channelId: typeof o.channelId === 'string' && o.channelId ? o.channelId : undefined,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 64) : undefined,
    pattern: typeof o.pattern === 'boolean' ? o.pattern : undefined,
    bpm: num(o.bpm, 10, 999),
    choke: num(o.choke, 0, 32),
    sensitivity: num(o.sensitivity, 0, 1),
  };
}

export async function sliceToPads(deps: SliceDeps, source: AudioTarget, opts: SliceToPadsOptions, apply: SliceApply, run: SliceRun = {}): Promise<ActionResult<SliceToPadsOutcome>> {
  const p = deps.doc.project;
  let sampleId: string | undefined;
  let samplePath: string | undefined;
  let display: string;
  let poolPath: string;
  if ('path' in source) {
    samplePath = source.path.trim();
    if (!samplePath) return fail('No file to slice');
    poolPath = samplePath;
    display = path.basename(samplePath).replace(/\.[a-z0-9]+$/i, '');
  } else {
    const clip = 'clipId' in source ? p.playlist.clips[source.clipId] : undefined;
    if ('clipId' in source && (!clip || clip.kind !== 'audio' || !clip.channelId)) return fail('Pick an audio clip to slice');
    const chId = 'clipId' in source ? clip!.channelId! : source.channelId;
    const ch = p.channels[chId];
    if (!ch) return fail('That channel no longer exists');
    const s = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
    if (!s) return fail(`"${ch.name}" has no sample to slice`);
    sampleId = s.id;
    poolPath = s.path;
    display = ch.name || s.name;
  }

  const mode = opts.mode ?? (opts.times?.length ? 'manual' : 'onsets');
  if (mode === 'manual' && !opts.times?.length) return fail('Give the slice times (seconds) to slice by hand');
  let lengthSec: number | undefined;
  let bpm = opts.bpm;
  let onsets: number[] = [];
  let strengths: number[] = [];
  let analysisNote = '';
  if (deps.analyze && (mode === 'onsets' || !bpm)) {
    run.onProgress?.('analysing', 0);
    const a = await deps.analyze(sampleId ? source : { path: poolPath }, { drums: mode === 'onsets', onProgress: run.onProgress, signal: run.signal });
    if (a.ok && a.data) {
      lengthSec = a.data.durationSec;
      if (!bpm && a.data.tempo?.bpm) bpm = Math.round(a.data.tempo.bpm * 100) / 100;
      const hits = (a.data.drumHits ?? []).filter((h) => (opts.sensitivity === undefined ? true : h.vel >= 1 - opts.sensitivity));
      onsets = hits.map((h) => h.timeSec);
      strengths = hits.map((h) => h.vel);
    } else if (mode === 'onsets') return fail(`Couldn't find the hits in "${display}": ${a.message ?? 'analysis failed'}. Try slicing by grid instead.`);
    else analysisNote = ' (tempo not detected: used the project tempo)';
  } else if (mode === 'onsets') return fail('Finding the hits needs the audio analyzer, which is not available. Slice by grid instead.');
  if (lengthSec === undefined) {
    const s = sampleId ? p.samples[sampleId] : undefined;
    if (s?.frames && s.sampleRate) lengthSec = s.frames / s.sampleRate;
    else if (deps.sampleInfo) {
      const info = await deps.sampleInfo(deps.resolveSamplePath(poolPath));
      if (info.ok && info.data) lengthSec = info.data.durationSec;
      else return fail(`Couldn't read "${display}": ${info.message ?? 'unknown error'}`);
    }
  }
  if (!lengthSec || !(lengthSec > 0)) return fail(`Couldn't tell how long "${display}" is`);
  if (run.signal?.aborted) return fail('Slicing cancelled');

  const loopBpm = bpm ?? p.transport.bpm;
  const times = sliceTimes({ mode, lengthSec, times: mode === 'manual' ? opts.times : onsets, strengths: mode === 'onsets' ? strengths : undefined, bpm: loopBpm, division: opts.division, maxSlices: opts.maxSlices ?? 16 });
  if (!times.length) return fail(`No slices: nothing in "${display}" to cut at`);
  run.onProgress?.('building', 0.95);
  const how = mode === 'onsets' ? 'at its hits' : mode === 'grid' ? `every ${opts.division ?? 1} beat${(opts.division ?? 1) === 1 ? '' : 's'}` : 'at the given times';
  if (opts.to === 'slicer') {
    const own = 'channelId' in source && p.channels[source.channelId]?.generator.type === SLICER_PLUGIN ? source.channelId : undefined;
    let s: { channelId: string; insertId: string; patternId?: string; slices: number[]; baseKey: number };
    try {
      s = apply('slicer.slice', {
        channelId: opts.channelId ?? own,
        name: opts.name?.slice(0, 64),
        ...(sampleId ? { sampleId } : { samplePath }),
        slices: times,
        lengthSec,
        bpm: loopBpm,
        pattern: opts.pattern ?? true,
      });
    } catch (e) {
      return fail((e as Error).message);
    }
    const sch = deps.doc.project.channels[s.channelId];
    const keys = `${midiNoteName(s.baseKey)}-${midiNoteName(s.baseKey + s.slices.length - 1)}`;
    return {
      ok: true,
      message: `Sliced "${display}" ${how} into ${s.slices.length} slice${s.slices.length === 1 ? '' : 's'} on the Slicer "${sch?.name ?? 'channel'}" (keys ${keys})${s.patternId ? `, with a pattern replaying it at ${loopBpm} BPM` : ''}${analysisNote}`,
      data: { channelId: s.channelId, insertId: s.insertId, patternId: s.patternId, slices: s.slices.length, times: s.slices, mode, bpm: loopBpm, lengthSec, hasEnd: true, to: 'slicer', baseKey: s.baseKey },
    };
  }
  let r: { channelId: string; insertId: string; chainIds: string[]; patternId?: string; slices: number[]; hasEnd: boolean };
  try {
    r = apply('rack.sliceToPads', {
      channelId: opts.channelId,
      name: opts.name ?? `${display} slices`.slice(0, 64),
      ...(sampleId ? { sampleId } : { samplePath }),
      slices: times,
      lengthSec,
      bpm: loopBpm,
      pattern: opts.pattern ?? true,
      choke: opts.choke ?? 0,
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  const ch = deps.doc.project.channels[r.channelId];
  const end = r.hasEnd ? '' : ' (this engine build has no Sampler end point yet, so each pad plays to the end of the sample)';
  return {
    ok: true,
    message: `Sliced "${display}" ${how} into ${r.slices.length} pad${r.slices.length === 1 ? '' : 's'} on "${ch?.name ?? 'the drum rack'}"${r.patternId ? `, with a pattern replaying it at ${loopBpm} BPM` : ''}${analysisNote}${end}`,
    data: { channelId: r.channelId, insertId: r.insertId, patternId: r.patternId, slices: r.slices.length, times: r.slices, mode, bpm: loopBpm, lengthSec, hasEnd: r.hasEnd, to: 'pads', baseKey: DRUM_RACK_BASE_NOTE },
  };
}
