import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Channel } from '@shared/schema/project';
import { MAX_SLICER_SLICES, SLICER_PLUGIN } from '@shared/schema/slicer';
import { midiNoteName } from '@shared/commands/racks';
import { slicerBaseKey } from '@shared/commands/slicer';
import { defineTool, fail, type ToolResult } from './types';
import { agentSamplePath, findChannel, plural, safeName } from './util';
import { sliceToPads } from '../../racks/slice';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

function slicerChannel(deps: MainDeps, ref: string): Channel {
  const ch = findChannel(deps.doc.project, ref);
  if (ch.generator.type !== SLICER_PLUGIN) fail(`"${safeName(ch.name)}" is not a Slicer channel. Chop a loop into one with slice_sample first.`);
  return ch;
}

function describeSlices(ch: Channel): string {
  const base = slicerBaseKey(ch);
  const list = ch.generator.slices ?? [];
  if (!list.length) return `no markers: the whole sample plays on ${midiNoteName(base)}`;
  return list
    .map((s, i) => {
      const extras = [s.pitch ? `${s.pitch > 0 ? '+' : ''}${s.pitch} st` : '', s.reverse ? 'reversed' : '', s.gain !== undefined && s.gain !== 1 ? `gain ${s.gain}` : ''].filter(Boolean);
      return `${i + 1}: ${midiNoteName(base + i)} @ ${s.sec.toFixed(3)} s${extras.length ? ` (${extras.join(', ')})` : ''}`;
    })
    .join('; ');
}

export const sliceSampleTool = defineTool({
  name: 'slice_sample',
  title: 'Chop a loop into the Slicer',
  kind: 'write',
  description:
    'Chop a loop into ONE Krypt Slicer channel (one undo step): slice N plays on key First key + N - 1 (C4 = 60 up) at its recorded pitch whatever the tempo, plus (pattern, default true) a pattern replaying the loop note by note at its tempo. Rearrange it with write_pattern on those keys (flip the order, repeat a hit, stutter a snare); tweak slices with edit_slices. Lighter than slice_to_pads (one channel, no drum rack), up to 64 auto slices. Source: sample (a "factory:…" or allowed audio path), clip (an audio clip id) or channel (its sample; re-slicing a Slicer channel keeps its settings). mode onsets (default: the analyzer finds the hits, keeping the strongest max_slices), grid (every division beats: 0.25 = 16ths) or manual (times in seconds). onto = an existing channel to turn into the Slicer; else a new channel (name). Use the user\'s own audio; follow the originality rules for anything you release. Example: {"sample":"C:/Samples/break.wav","max_slices":16}',
  input: z.object({
    sample: z.string().max(400).optional(),
    clip: z.string().max(80).optional(),
    channel: z.string().max(80).optional(),
    mode: z.enum(['onsets', 'grid', 'manual']).optional(),
    times: z.array(z.number().min(0)).max(MAX_SLICER_SLICES).optional(),
    division: z.number().min(1 / 16).max(16).optional(),
    max_slices: z.number().int().min(1).max(64).optional(),
    sensitivity: z.number().min(0).max(1).optional().describe('onsets: 0..1, higher keeps softer hits (default: all hits).'),
    onto: z.string().max(80).optional(),
    name: z.string().min(1).max(64).optional(),
    pattern: z.boolean().optional(),
    bpm: z.number().min(10).max(999).optional().describe("The loop's tempo (default: detected)."),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.sample?.split(/[\\/:]/).pop() ?? a.clip ?? a.channel ?? '?', 40)}${a.mode ? ` (${a.mode})` : ''}`,
  paths: (a) => [{ value: a.sample, kind: 'audio' }],
  async run(deps, caller, a, ctx): Promise<ToolResult> {
    const given = [a.sample, a.clip, a.channel].filter((x) => x !== undefined).length;
    if (given !== 1) fail('Pass exactly one source: sample (a path), clip (an audio clip id) or channel (its sample).');
    const p = deps.doc.project;
    let source: { path: string } | { clipId: string } | { channelId: string };
    if (a.sample) source = { path: agentSamplePath(deps, a.sample, caller).docPath };
    else if (a.clip) {
      const c = p.playlist.clips[a.clip];
      if (!c || c.kind !== 'audio') fail(`No audio clip "${safeName(a.clip, 40)}" (get_project lists the clips)`);
      source = { clipId: c.id };
    } else source = { channelId: findChannel(p, a.channel!).id };
    const onto = a.onto ? findChannel(p, a.onto).id : undefined;
    const r = await sliceToPads(
      {
        doc: deps.doc,
        analyze: deps.analyzer ? (t, o) => deps.analyzer!.analyze(t, o) : undefined,
        sampleInfo: (abs) => deps.engine.sampleInfo(abs),
        resolveSamplePath: (x) => deps.project.resolveSamplePath(x),
      },
      source,
      { to: 'slicer', mode: a.mode, times: a.times, division: a.division, maxSlices: a.max_slices, sensitivity: a.sensitivity, channelId: onto, name: a.name ? safeName(a.name, 64) : undefined, pattern: a.pattern, bpm: a.bpm },
      (cmd, args) => ctx.exec(cmd, args),
      { onProgress: (stage, f) => ctx.progress?.(f, stage), signal: ctx.signal },
    );
    if (!r.ok || !r.data) fail(r.message ?? 'Slicing failed');
    const d = r.data;
    const ch = deps.doc.project.channels[d.channelId];
    const pat = d.patternId ? deps.doc.project.patterns[d.patternId] : undefined;
    return {
      ok: true,
      message: `${r.message}. Channel ${d.channelId}${pat ? `; pattern "${safeName(pat.name)}" (${d.patternId}) replays the loop: rewrite it with write_pattern to rearrange the slices` : ''}. Slices: ${ch ? describeSlices(ch) : '?'}.`,
      changed: [],
      data: d,
    };
  },
});

const zSliceNo = z.number().int().min(1).max(MAX_SLICER_SLICES);

export const editSlicesTool = defineTool({
  name: 'edit_slices',
  title: 'Edit Slicer markers',
  kind: 'write',
  description:
    'Edit the slices of a Krypt Slicer channel (one undo step). Slices are numbered from 1 in time order (slice N plays on First key + N - 1). Runs in this order: clear (remove every marker), remove (slice numbers, as they are before this call), move ([{slice, sec}]), add (start times in seconds), set ([{slice, pitch (semitones -24..24), reverse, gain (0..2, 1 = as recorded)}], numbered after the adds). A marker may not touch or cross a neighbour (5 ms apart at least). pattern: true then adds a pattern replaying the loop as now sliced (bpm = the loop\'s tempo, default the project tempo). Returns every slice with its key. Example: {"channel":"Break slicer","set":[{"slice":4,"reverse":true},{"slice":2,"pitch":-5}]}',
  input: z.object({
    channel: z.string().max(80),
    clear: z.boolean().optional(),
    remove: z.array(zSliceNo).max(MAX_SLICER_SLICES).optional(),
    move: z.array(z.object({ slice: zSliceNo, sec: z.number().min(0) })).max(MAX_SLICER_SLICES).optional(),
    add: z.array(z.number().min(0)).max(MAX_SLICER_SLICES).optional(),
    set: z
      .array(z.object({ slice: zSliceNo, pitch: z.number().min(-24).max(24).optional(), reverse: z.boolean().optional(), gain: z.number().min(0).max(2).optional() }))
      .max(MAX_SLICER_SLICES)
      .optional(),
    pattern: z.boolean().optional(),
    bpm: z.number().min(10).max(999).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel, 40)}: ${[a.clear && 'clear', a.remove?.length && `-${a.remove.length}`, a.move?.length && `move ${a.move.length}`, a.add?.length && `+${a.add.length}`, a.set?.length && `set ${a.set.length}`, a.pattern && 'pattern'].filter(Boolean).join(', ') || 'list'}`,
  async run(deps, _c, a, ctx): Promise<ToolResult> {
    const id = slicerChannel(deps, a.channel).id;
    const current = () => slicerChannel(deps, id);
    const idOf = (n: number): string => {
      const list = current().generator.slices ?? [];
      if (n > list.length) fail(`"${safeName(current().name)}" has ${plural(list.length, 'slice')}; there is no slice ${n}`);
      return list[n - 1].id;
    };
    const done: string[] = [];
    if (a.clear && current().generator.slices?.length) {
      ctx.exec('slicer.clear', { channelId: id });
      done.push('cleared the markers');
    }
    if (a.remove?.length) {
      const ids = [...new Set(a.remove)].map(idOf);
      for (const sliceId of ids) ctx.exec('slicer.removeSlice', { channelId: id, sliceId });
      done.push(`removed ${plural(ids.length, 'slice')}`);
    }
    for (const m of a.move ?? []) ctx.exec('slicer.moveSlice', { channelId: id, sliceId: idOf(m.slice), sec: m.sec });
    if (a.move?.length) done.push(`moved ${plural(a.move.length, 'slice')}`);
    for (const sec of a.add ?? []) ctx.exec('slicer.addSlice', { channelId: id, sec });
    if (a.add?.length) done.push(`added ${plural(a.add.length, 'slice')}`);
    for (const s of a.set ?? []) {
      if (s.pitch === undefined && s.reverse === undefined && s.gain === undefined) fail(`set slice ${s.slice}: give pitch, reverse or gain`);
      ctx.exec('slicer.setSlice', { channelId: id, sliceId: idOf(s.slice), pitch: s.pitch, reverse: s.reverse, gain: s.gain });
    }
    if (a.set?.length) done.push(`set ${plural(a.set.length, 'slice')}`);
    let patternNote = '';
    if (a.pattern) {
      const s = deps.doc.project.samples[current().generator.sampleId ?? ''];
      const info = s ? await deps.engine.sampleInfo(deps.project.resolveSamplePath(s.path)).catch(() => null) : null;
      const lengthSec = info?.ok && info.data && info.data.durationSec > 0 ? info.data.durationSec : undefined;
      const { patternId } = ctx.exec<{ patternId: string }>('slicer.makePattern', { channelId: id, bpm: a.bpm, lengthSec });
      patternNote = `; pattern "${safeName(deps.doc.project.patterns[patternId]?.name)}" (${patternId}) replays it`;
      done.push('made a replay pattern');
    }
    const ch = current();
    if (!done.length) fail(`No change: "${safeName(ch.name)}" ${a.clear ? 'has no markers to clear' : 'was given nothing to do (clear, remove, move, add, set or pattern)'}. Slices: ${describeSlices(ch)}.`);
    return { ok: true, message: `${done.join(', ')} on "${safeName(ch.name)}"${patternNote}. Slices: ${describeSlices(ch)}.`, changed: [] };
  },
});

export const SLICER_TOOLS = [sliceSampleTool, editSlicesTool];
