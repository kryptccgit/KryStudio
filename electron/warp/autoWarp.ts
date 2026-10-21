import type { DocHost } from '@shared/doc/DocHost';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { Channel, Project } from '@shared/schema/project';
import type { WarpMode } from '@shared/schema/warp';
import type { ActionResult, AudioTarget, AutoWarpOptions, AutoWarpOutcome, WarpHint } from '@shared/types';
import { AUDIOCLIP } from '@shared/analyzer/tempo';
import { modeForHint } from '@shared/commands/warp';
import type { Apply, RunOptions } from '../analyzer/service';

export interface AutoWarpDeps {
  doc: Pick<DocHost, 'project'>;
  analyzer?: { analyze(target: AudioTarget, opts?: RunOptions): Promise<ActionResult<AudioAnalysis>> } | null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r2 = (v: number): number => Math.round(v * 100) / 100;

export function guessWarpHint(p: Project, ch: Channel, a: AudioAnalysis | null): WarpHint {
  const s = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
  if (s?.origin?.kind === 'stem') {
    const stem = s.origin.stem.toLowerCase();
    if (stem === 'drums') return 'drums';
    if (stem === 'vocals' || stem === 'bass') return 'mono';
    return 'mix';
  }
  const name = `${ch.name} ${s?.name ?? ''}`.toLowerCase();
  if (/\b(drums?|drum ?loop|break(beat)?s?|beat|kick|snare|hats?|hi-?hats?|perc(ussion)?|tops?|groove)\b/.test(name)) return 'drums';
  if (/\b(vox|vocals?|acapella|a cappella|voice|bass(line)?|808|lead|melody|flute|sax|guitar riff)\b/.test(name)) return 'mono';
  if (a && !a.key && a.onsetRate >= 3) return 'drums';
  return 'mix';
}

function downbeatIndexOf(times: number[], downbeats: number[]): number {
  if (!downbeats.length) return 0;
  const t = downbeats[0];
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  return best;
}

function sourceName(a: AudioAnalysis): string {
  const s = a.sources.join(' ').toLowerCase();
  return s.includes('beat-this') || s.includes('beat this') ? 'the Beat This! beat model' : "the analyzer's beat tracker";
}

export async function autoWarpChannel(deps: AutoWarpDeps, channelId: string, opts: AutoWarpOptions, apply: Apply, run: RunOptions = {}): Promise<ActionResult<AutoWarpOutcome>> {
  const p = deps.doc.project;
  const ch = p.channels[channelId];
  if (!ch) return { ok: false, message: 'That channel no longer exists' };
  if (ch.generator.type !== AUDIOCLIP) return { ok: false, message: `"${ch.name}" is not an audio clip channel; only audio clips can be warped` };
  const sample = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
  if (!sample) return { ok: false, message: `"${ch.name}" has no sample loaded` };
  if (!deps.analyzer) return { ok: false, message: "Auto-warp needs the audio analyzer, which isn't running in this session (see the log). Warp by hand: double-click the waveform on a beat to add a marker, then drag it." };

  const parentId = sample.origin?.kind === 'stem' ? sample.origin.parentSampleId : undefined;
  const parent = parentId ? p.samples[parentId] : undefined;
  let analysis: AudioAnalysis | null = null;
  let onMix = false;
  let firstError: string | null = null;
  if (parent) {
    const r = await deps.analyzer.analyze({ path: parent.path }, run);
    if (r.ok && r.data?.beats && r.data.beats.times.length >= 2) {
      analysis = r.data;
      onMix = true;
    } else if (!r.ok) firstError = r.message ?? null;
    if (run.signal?.aborted) return { ok: false, message: 'Auto-warp cancelled' };
  }
  if (!analysis) {
    const r = await deps.analyzer.analyze({ channelId }, run);
    if (!r.ok || !r.data) return { ok: false, message: `Couldn't auto-warp "${ch.name}": ${r.message ?? firstError ?? 'the analysis failed'}` };
    analysis = r.data;
  }

  const a = analysis;
  const dur = a.durationSec > 0 ? a.durationSec : Infinity;
  let beatTimes: number[];
  let downbeatIndex = 0;
  let beatsPerBar = 4;
  let source: string;
  let warning: string | undefined;
  if (a.beats && a.beats.times.filter((t) => t < dur).length >= 2) {
    beatTimes = a.beats.times.filter((t) => t >= 0 && t < dur);
    downbeatIndex = downbeatIndexOf(beatTimes, a.beats.downbeats);
    beatsPerBar = Math.max(1, Math.min(16, Math.round(a.beats.beatsPerBar || 4)));
    source = `${sourceName(a)}${onMix ? ` on its source mix "${parent!.name}"` : ''}`;
  } else if (a.tempo && a.tempo.bpm > 0 && Number.isFinite(dur)) {
    const period = 60 / a.tempo.bpm;
    beatTimes = [];
    for (let t = 0; t < dur && beatTimes.length < 20000; t += period) beatTimes.push(t);
    source = `the detected tempo (${r2(a.tempo.bpm)} bpm) only`;
    warning = 'No beat grid was found, only a tempo, so the grid starts at the top of the file: check that the first marker sits on a beat and drag it if not.';
  } else {
    return { ok: false, message: `No steady beat was found in "${ch.name}", so it can't be auto-warped. Warp by hand: double-click the waveform on a beat to add a marker, then drag it.` };
  }
  if (beatTimes.length < 2) return { ok: false, message: `"${ch.name}" is too short to auto-warp (fewer than 2 beats)` };

  const hint: WarpHint = opts.hint ?? guessWarpHint(p, ch, a);
  const mode: WarpMode = opts.mode ?? modeForHint(hint);
  const every = opts.every ?? 'bar';
  let out: { markers: number; mode: WarpMode; srcBpm: number; beatUnit: number };
  try {
    out = apply('audio.autoWarp', { channelId, beatTimes, downbeatIndex, every, hint, mode, beatsPerBar });
  } catch (err) {
    return { ok: false, message: `Couldn't auto-warp "${ch.name}": ${errText(err)}` };
  }
  const bpm = deps.doc.project.transport.bpm;
  const unitNote = out.beatUnit === 2 ? ' (heard in half time, so each beat counts as two)' : out.beatUnit === 0.5 ? ' (heard in double time, so each beat counts as half)' : '';
  const message =
    `Warped "${ch.name}": ${out.markers} markers (every ${every}), ${out.mode} mode${opts.mode ? '' : ` for ${hint === 'drums' ? 'drums' : hint === 'mono' ? 'a single voice' : 'a full mix'}`}, ` +
    `${out.srcBpm} → ${bpm} bpm${unitNote}. Beats from ${source}.${warning ? ` ${warning}` : ''}`;
  return { ok: true, message, data: { channelId, markers: out.markers, mode: out.mode, hint, every, srcBpm: out.srcBpm, beatUnit: out.beatUnit, source, warning } };
}
