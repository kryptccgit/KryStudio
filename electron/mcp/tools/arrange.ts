import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Clip, Marker, Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { toNormalized, formatParam, type ParamSpec } from '@shared/plugins/types';
import { secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from '@shared/schema/time';
import { audioTickBpm } from '@shared/analyzer/tempo';
import { defineTool, fail, type RunCtx } from './types';
import { findReference } from './reference';
import { rackInnerRef } from './rackRefs';
import { findChannel, findInsert, findPattern, findPluginRef, findSlot, findTrack, fmtBars, fmtPos, parseBarRange, parseParamValue, parsePosition, plural, safeName } from './util';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zTrack = z.union([z.number().int().min(1), z.string()]).describe('Playlist track: 1-based number, name or id.');

function overlaps(c: Clip, start: number, end: number): boolean {
  return c.start < end && c.start + c.length > start;
}

function laneFor(deps: MainDeps, ctx: RunCtx, patternId: string | null, start: number, end: number): string {
  const p = deps.doc.project;
  const clips = Object.values(p.playlist.clips);
  if (patternId) {
    const lane = p.playlist.trackOrder.find((t) => clips.some((c) => c.trackId === t && c.patternId === patternId));
    if (lane && !clips.some((c) => c.trackId === lane && c.patternId !== patternId && overlaps(c, start, end))) return lane;
  }
  const empty = p.playlist.trackOrder.find((t) => !clips.some((c) => c.trackId === t));
  if (empty) return empty;
  const free = p.playlist.trackOrder.find((t) => !clips.some((c) => c.trackId === t && overlaps(c, start, end)));
  if (free) return free;
  return ctx.exec<{ id: string }>('playlist.addTrack', {}).id;
}

function trackLabel(p: Project, id: string): string {
  const i = p.playlist.trackOrder.indexOf(id);
  return `track ${i + 1} "${safeName(p.playlist.tracks[id]?.name)}"`;
}

export const arrange = defineTool({
  name: 'arrange',
  title: 'Arrange patterns on the playlist',
  kind: 'write',
  description:
    'Place pattern clips across bar ranges on the Playlist (song arrangement) in one call. Each placement tiles the pattern back-to-back over the bars (inclusive, 1-based). The track defaults to the lane already used by that pattern, else the first empty lane. clear_first removes clips that overlap the ranges on those lanes first. Switches to song mode unless song_mode is false. Example: {"placements":[{"pattern":"Drums","bars":"1-16"},{"pattern":"Bass","bars":"9-16"},{"pattern":"Lead","bars":"9-16","track":4}]}',
  input: z.object({
    placements: z
      .array(z.object({ pattern: z.string(), bars: z.string().describe('"1-8" inclusive'), track: zTrack.optional() }))
      .min(1)
      .max(128),
    clear_first: z.boolean().default(false),
    song_mode: z.boolean().default(true),
    change_label: zLabel,
  }),
  summarize: (a) => `${plural(a.placements.length, 'placement')}`,
  run(deps, _c, a, ctx) {
    const ts = deps.doc.project.transport.timeSig;
    const lines: string[] = [];
    let added = 0;
    let removed = 0;
    for (const pl of a.placements) {
      const p = deps.doc.project;
      const pat = findPattern(p, pl.pattern);
      const range = parseBarRange(pl.bars, ts);
      const len = patternLength(pat, ts);
      const trackId = pl.track !== undefined ? findTrack(p, pl.track) : laneFor(deps, ctx, pat.id, range.start, range.end);
      if (a.clear_first) {
        const ids = Object.values(deps.doc.project.playlist.clips)
          .filter((c) => c.trackId === trackId && overlaps(c, range.start, range.end))
          .map((c) => c.id);
        if (ids.length) {
          ctx.exec('playlist.removeClips', { ids });
          removed += ids.length;
        }
      }
      let n = 0;
      let skipped = 0;
      for (let t = range.start; t < range.end; t += len) {
        const length = Math.min(len, range.end - t);
        const dup = Object.values(deps.doc.project.playlist.clips).some((c) => c.trackId === trackId && c.patternId === pat.id && c.start === t && c.length === length);
        if (dup) {
          skipped++;
          continue;
        }
        ctx.exec('playlist.addClip', { kind: 'pattern', trackId, start: t, length, patternId: pat.id });
        n++;
      }
      added += n;
      lines.push(`"${safeName(pat.name)}" bars ${pl.bars} on ${trackLabel(deps.doc.project, trackId)}: ${plural(n, 'clip')}${skipped ? ` (${skipped} already there)` : ''}`);
    }
    if (a.song_mode && deps.doc.project.transport.mode !== 'song') ctx.exec('transport.setMode', { mode: 'song' });
    if (!added && !removed) fail(`No change: those clips are already on the playlist (${lines.join('; ')}).`);
    const end = Math.max(0, ...Object.values(deps.doc.project.playlist.clips).map((c) => c.start + c.length));
    return { ok: true, message: `Arranged ${plural(added, 'clip')}${removed ? `, removed ${removed}` : ''}: ${lines.join('; ')}. Song is ${fmtBars(end, ts)}${deps.doc.project.transport.mode === 'song' ? ' (song mode)' : ''}.`, changed: [] };
  },
});

export const addClip = defineTool({
  name: 'add_clip',
  title: 'Add one playlist clip',
  kind: 'write',
  description:
    'Place a single pattern clip, an existing automation clip, or a section of an audio clip on the playlist at a bar position. length_bars defaults to the pattern length. audio = an audio clip id or audio channel name: places another clip of the same channel (same stretch, pitch, tempo sync and mixer insert) playing its audio from offset_sec seconds (as analyze_audio reports sections) or offset_bars bars into the file (default: where that clip starts); length_bars defaults to the rest of the audio. Use it to arrange vocals and stems (intro, drop, break). Examples: {"pattern":"Fill","at":"8","track":2} · {"audio":"Song A · Vocals","at":9,"offset_sec":42.5,"length_bars":16}',
  input: z.object({
    pattern: z.string().optional(),
    automation: z.string().optional().describe('Automation id/name instead of a pattern.'),
    audio: z.string().max(200).optional().describe('Audio clip id or audio channel name instead of a pattern.'),
    offset_sec: z.number().min(0).optional().describe('audio: where in the audio file the new clip starts, in seconds.'),
    offset_bars: z.number().min(0).max(4096).optional().describe('audio: where in the audio the new clip starts, in project bars.'),
    at: z.union([z.string(), z.number()]).describe('"bar" or "bar.step" (1-based, 16th steps).'),
    track: zTrack.optional(),
    length_bars: z.number().positive().max(1024).optional(),
    muted: z.boolean().optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.pattern ?? a.automation ?? a.audio ?? '?', 30)} @${a.at}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    const start = parsePosition(a.at, ts);
    const bar = ticksPerBar(ts);
    if ([a.pattern, a.automation, a.audio].filter(Boolean).length !== 1) fail('Pass one of pattern, automation or audio.');
    if (a.audio) {
      const src = p.playlist.clips[a.audio.trim()] ?? (() => {
        const ch = findChannel(p, a.audio!);
        return Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === ch.id).sort((x, y) => x.start - y.start)[0];
      })();
      if (!src || src.kind !== 'audio' || !src.channelId || !p.channels[src.channelId]) fail(`"${safeName(a.audio)}" is not an audio clip (or an audio channel with a clip on the Playlist)`);
      const ch = p.channels[src.channelId];
      const tickBpm = audioTickBpm(p, deps.doc.catalog, ch).bpm;
      const sample = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
      const total = sample?.frames && sample.sampleRate ? Math.round(secondsToTicks(sample.frames / sample.sampleRate, tickBpm)) : src.offset + src.length;
      const offset = a.offset_sec !== undefined ? Math.round(secondsToTicks(a.offset_sec, tickBpm)) : a.offset_bars !== undefined ? Math.round(a.offset_bars * bar) : src.offset;
      if (offset >= total) fail(`The audio of "${safeName(ch.name)}" is only ${fmtBars(total, ts)} long at its current tempo; that offset is past its end.`);
      const length = a.length_bars ? Math.round(a.length_bars * bar) : total - offset;
      const clips = Object.values(p.playlist.clips);
      const trackId = a.track !== undefined ? findTrack(p, a.track) : !clips.some((c) => c.trackId === src.trackId && overlaps(c, start, start + length)) ? src.trackId : laneFor(deps, ctx, null, start, start + length);
      const r = ctx.exec<{ id: string }>('playlist.addClip', { kind: 'audio', trackId, start, length, offset, channelId: ch.id });
      if (a.muted) ctx.exec('playlist.updateClips', { updates: [{ id: r.id, mute: true }] });
      const sec = (t: number) => Math.round(ticksToSeconds(t, tickBpm) * 10) / 10;
      return {
        ok: true,
        message: `Placed "${safeName(ch.name)}" audio ${sec(offset)}–${sec(offset + length)} s at bar ${fmtPos(start, ts)} (${fmtBars(length, ts)}) on ${trackLabel(deps.doc.project, trackId)} — clip ${r.id}.`,
        changed: [],
        data: { id: r.id },
      };
    }
    if (a.pattern) {
      const pat = findPattern(p, a.pattern);
      const length = a.length_bars ? Math.round(a.length_bars * bar) : patternLength(pat, ts);
      const trackId = a.track !== undefined ? findTrack(p, a.track) : laneFor(deps, ctx, pat.id, start, start + length);
      const r = ctx.exec<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId, start, length, patternId: pat.id });
      if (a.muted) ctx.exec('playlist.updateClips', { updates: [{ id: r.id, mute: true }] });
      return { ok: true, message: `Placed "${safeName(pat.name)}" at bar ${fmtPos(start, ts)} (${fmtBars(length, ts)}) on ${trackLabel(deps.doc.project, trackId)} — clip ${r.id}.`, changed: [], data: { id: r.id } };
    }
    const aut = p.automations[a.automation!] ?? Object.values(p.automations).find((x) => x.name.toLowerCase() === a.automation!.toLowerCase());
    if (!aut) fail(`No automation "${safeName(a.automation)}"`);
    const length = a.length_bars ? Math.round(a.length_bars * bar) : undefined;
    const trackId = a.track !== undefined ? findTrack(p, a.track) : laneFor(deps, ctx, null, start, start + (length ?? bar * 4));
    const r = ctx.exec<{ id: string }>('playlist.addClip', { kind: 'automation', trackId, start, length, automationId: aut.id });
    return { ok: true, message: `Placed automation "${safeName(aut.name)}" at bar ${fmtPos(start, ts)} on ${trackLabel(deps.doc.project, trackId)} — clip ${r.id}.`, changed: [], data: { id: r.id } };
  },
});

interface ClipFilter {
  ids?: string[];
  track?: number | string;
  bars?: string;
  pattern?: string;
  kind?: Clip['kind'];
}

function filterClips(p: Project, a: ClipFilter): Clip[] {
  if (!a.ids && a.track === undefined && !a.bars && !a.pattern && !a.kind) fail('Pass ids, or a filter (track, bars, pattern, kind).');
  let clips = Object.values(p.playlist.clips);
  if (a.ids) {
    const missing = a.ids.filter((id) => !p.playlist.clips[id]);
    if (missing.length) fail(`No clip ${missing.slice(0, 5).join(', ')}`);
    clips = clips.filter((c) => a.ids!.includes(c.id));
  }
  if (a.track !== undefined) {
    const t = findTrack(p, a.track);
    clips = clips.filter((c) => c.trackId === t);
  }
  if (a.bars) {
    const r = parseBarRange(a.bars, p.transport.timeSig);
    clips = clips.filter((c) => overlaps(c, r.start, r.end));
  }
  if (a.pattern) {
    const pat = findPattern(p, a.pattern);
    clips = clips.filter((c) => c.patternId === pat.id);
  }
  if (a.kind) clips = clips.filter((c) => c.kind === a.kind);
  if (!clips.length) fail('No change: no clips match.');
  return clips;
}

export const removeClips = defineTool({
  name: 'remove_clips',
  title: 'Remove playlist clips',
  kind: 'destructive',
  description:
    'Remove playlist clips by id, or every clip matching a filter (track, bar range overlap, pattern). At least one selector is required. close_gap: true instead deletes the bar range from the WHOLE song (all tracks; pass only bars): clips inside go, clips crossing the edges are trimmed, and everything after moves left. Examples: {"pattern":"Drums","bars":"13-16"} · {"bars":"17-24","close_gap":true}',
  input: z.object({
    ids: z.array(z.string()).max(1000).optional(),
    track: zTrack.optional(),
    bars: z.string().optional(),
    pattern: z.string().optional(),
    close_gap: z.boolean().default(false),
    change_label: zLabel,
  }),
  summarize: (a) => (a.close_gap ? `delete bars ${a.bars}` : a.ids ? plural(a.ids.length, 'clip') : [a.pattern, a.bars && `bars ${a.bars}`, a.track && `track ${a.track}`].filter(Boolean).join(', ')),
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    if (a.close_gap) {
      if (!a.bars || a.ids || a.track !== undefined || a.pattern) fail('close_gap deletes a bar range from the whole song: pass only bars (e.g. "17-24").');
      const ts = p.transport.timeSig;
      const r = parseBarRange(a.bars, ts);
      const d = ctx.exec<{ removed: number; trimmed: number; moved: number }>('playlist.deleteTime', { start: r.start, end: r.end });
      return { ok: true, message: `Deleted bars ${a.bars} (${fmtBars(r.end - r.start, ts)}) from the song: ${plural(d.removed, 'clip')} removed, ${d.trimmed} trimmed, ${d.moved} moved left.`, changed: [] };
    }
    const clips = filterClips(p, a);
    ctx.exec('playlist.removeClips', { ids: clips.map((c) => c.id) });
    return { ok: true, message: `Removed ${plural(clips.length, 'clip')}.`, changed: [] };
  },
});

const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const editClips = defineTool({
  name: 'edit_clips',
  title: 'Move, resize, trim, split or duplicate playlist clips',
  kind: 'write',
  description:
    'Edit clips already on the Playlist, in one undo step. Select by ids and/or a filter (track, bars = overlapping that range, pattern, kind pattern | audio | automation), as in remove_clips. Then any mix of: shift_bars (move by ± bars; fractions allowed) or to_bar (the earliest selected clip moves there, the others keep their distance); to_track (the topmost selected lane moves there, the others keep their lane spacing); length_bars (new length, from the start); trim_start_bars (move the LEFT edge: + cuts the start off, - reveals more, like dragging the clip\'s edge); mute; color ("#RRGGBB", null = the source\'s color); gain_db (audio clips, -60..+12); split_at_bar (cut every selected clip that spans that position into two); duplicate {times, gap_bars} (copies after the selection, back to back or with a gap); make_unique (pattern clips get their own copy of the pattern, so editing it changes only them; with duplicate the copies are unique instead). Order: move / resize / trim / mute / color / gain, then split, then duplicate / make_unique. Bars are 1-based. Examples: {"pattern":"Drums","bars":"9-16","shift_bars":4} · {"ids":["cl_3"],"split_at_bar":"5.9"} · {"track":"Lead","duplicate":{"times":3}} · {"kind":"audio","track":2,"gain_db":-3,"trim_start_bars":1}',
  input: z.object({
    ids: z.array(z.string()).max(2000).optional(),
    track: zTrack.optional(),
    bars: z.string().optional().describe('Select clips overlapping this bar range, e.g. "9-16".'),
    pattern: z.string().optional(),
    kind: z.enum(['pattern', 'audio', 'automation']).optional(),
    shift_bars: z.number().min(-4096).max(4096).optional(),
    to_bar: z.union([z.string(), z.number()]).optional().describe('"bar" or "bar.step": where the earliest selected clip starts.'),
    to_track: zTrack.optional(),
    length_bars: z.number().positive().max(4096).optional(),
    trim_start_bars: z.number().min(-4096).max(4096).optional(),
    mute: z.boolean().optional(),
    color: zColor.nullable().optional(),
    gain_db: z.number().min(-60).max(12).optional(),
    split_at_bar: z.union([z.string(), z.number()]).optional().describe('"bar" or "bar.step" (song position).'),
    duplicate: z.object({ times: z.number().int().min(1).max(64).default(1), gap_bars: z.number().min(0).max(1024).default(0) }).optional(),
    make_unique: z.boolean().optional(),
    change_label: zLabel,
  }),
  summarize: (a) =>
    [
      a.ids ? plural(a.ids.length, 'clip') : [a.pattern, a.kind, a.bars && `bars ${a.bars}`, a.track !== undefined && `track ${a.track}`].filter(Boolean).join(' '),
      a.shift_bars !== undefined && `move ${a.shift_bars > 0 ? '+' : ''}${a.shift_bars} bars`,
      a.to_bar !== undefined && `to bar ${a.to_bar}`,
      a.to_track !== undefined && `to track ${a.to_track}`,
      a.length_bars !== undefined && `length ${a.length_bars}`,
      a.split_at_bar !== undefined && `split @${a.split_at_bar}`,
      a.duplicate && `duplicate ×${a.duplicate.times}`,
      a.make_unique && 'unique',
    ]
      .filter(Boolean)
      .join(' · '),
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    const bar = ticksPerBar(ts);
    const clips = filterClips(p, { ids: a.ids, track: a.track, bars: a.bars, pattern: a.pattern, kind: a.kind }).sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
    if (a.shift_bars !== undefined && a.to_bar !== undefined) fail('Pass shift_bars or to_bar, not both.');
    const done: string[] = [];

    let shift = 0;
    if (a.shift_bars !== undefined) shift = Math.round(a.shift_bars * bar);
    if (a.to_bar !== undefined) shift = parsePosition(a.to_bar, ts) - clips[0].start;
    const order = p.playlist.trackOrder;
    let laneShift = 0;
    if (a.to_track !== undefined) {
      const top = Math.min(...clips.map((c) => order.indexOf(c.trackId)));
      const bottom = Math.max(...clips.map((c) => order.indexOf(c.trackId)));
      laneShift = order.indexOf(findTrack(p, a.to_track)) - top;
      if (bottom + laneShift >= order.length) fail(`Moving them to track ${a.to_track} would need ${bottom + laneShift + 1 - order.length} more track(s) below the last one (${order.length}).`);
    }
    const gain = a.gain_db !== undefined ? Math.min(4, 10 ** (a.gain_db / 20)) : undefined;
    if (gain !== undefined && !clips.some((c) => c.kind === 'audio')) fail('gain_db is for audio clips; none of the selected clips is audio.');
    const updates: Array<Record<string, unknown>> = [];
    const skipped: string[] = [];
    for (const c of clips) {
      let start = c.start + shift;
      let length = c.length;
      let offset = c.offset;
      if (a.trim_start_bars !== undefined) {
        const d = Math.max(-Math.min(offset, start), Math.min(length - 1, Math.round(a.trim_start_bars * bar)));
        start += d;
        offset += d;
        length -= d;
      }
      if (a.length_bars !== undefined) length = Math.max(1, Math.round(a.length_bars * bar));
      if (start < 0) fail(`That would move clip ${c.id} (at bar ${fmtPos(c.start, ts)}) before bar 1.`);
      const u: Record<string, unknown> = { id: c.id };
      if (start !== c.start) u.start = start;
      if (length !== c.length) u.length = length;
      if (offset !== c.offset) u.offset = offset;
      if (laneShift) u.trackId = order[order.indexOf(c.trackId) + laneShift];
      if (a.mute !== undefined && a.mute !== c.mute) u.mute = a.mute;
      if (a.color !== undefined && (a.color ?? null) !== c.color) u.color = a.color ?? null;
      if (gain !== undefined) {
        if (c.kind !== 'audio') skipped.push(`${c.id} is not audio (gain)`);
        else if (Math.abs((c.gain ?? 1) - gain) > 1e-6) u.gain = gain;
      }
      if (Object.keys(u).length > 1) updates.push(u);
    }
    if (updates.length) {
      ctx.exec('playlist.updateClips', { updates });
      const what = [
        shift && `moved ${shift > 0 ? 'later' : 'earlier'} by ${fmtBars(Math.abs(shift), ts)}`,
        laneShift && `to track ${a.to_track}`,
        a.trim_start_bars !== undefined && `trimmed the start by ${a.trim_start_bars} bars`,
        a.length_bars !== undefined && `length ${fmtBars(Math.round(a.length_bars * bar), ts)}`,
        a.mute !== undefined && (a.mute ? 'muted' : 'unmuted'),
        a.color !== undefined && (a.color ? `colored ${a.color}` : 'source color'),
        gain !== undefined && `gain ${a.gain_db} dB`,
      ].filter(Boolean);
      done.push(`${plural(updates.length, 'clip')}: ${what.join(', ')}`);
    }

    let ids = clips.map((c) => c.id);
    if (a.split_at_bar !== undefined) {
      const at = parsePosition(a.split_at_bar, ts);
      let n = 0;
      for (const id of [...ids]) {
        const c = deps.doc.project.playlist.clips[id];
        if (!c || !(at > c.start && at < c.start + c.length)) continue;
        const r = ctx.exec<{ ids: string[] }>('playlist.splitClip', { id, at });
        ids.push(r.ids[1]);
        n++;
      }
      if (n) done.push(`split ${plural(n, 'clip')} at bar ${fmtPos(at, ts)}`);
      else skipped.push(`no selected clip spans bar ${fmtPos(at, ts)}`);
    }

    const created: string[] = [];
    if (a.duplicate) {
      const cur = ids.map((id) => deps.doc.project.playlist.clips[id]).filter(Boolean);
      const span = Math.max(...cur.map((c) => c.start + c.length)) - Math.min(...cur.map((c) => c.start));
      const step = span + Math.round(a.duplicate.gap_bars * bar);
      for (let k = 1; k <= a.duplicate.times; k++) {
        const r = ctx.exec<{ ids: string[] }>(a.make_unique ? 'playlist.cloneClips' : 'playlist.duplicateClips', { ids, shift: step * k });
        created.push(...r.ids);
      }
      done.push(`${a.make_unique ? 'cloned (unique patterns)' : 'duplicated'} ${a.duplicate.times}× after bar ${fmtPos(Math.max(...cur.map((c) => c.start + c.length)) - 1, ts).split('.')[0]}: ${plural(created.length, 'new clip')}`);
    } else if (a.make_unique) {
      let n = 0;
      for (const id of ids) {
        const c = deps.doc.project.playlist.clips[id];
        if (c?.kind !== 'pattern') continue;
        ctx.exec('playlist.makeUnique', { clipId: id });
        n++;
      }
      if (n) done.push(`made ${plural(n, 'pattern clip')} unique`);
      else skipped.push('make_unique needs pattern clips');
    }

    if (!done.length) fail(`No change: ${skipped.length ? skipped.slice(0, 4).join('; ') : 'the selected clips are already like that (or no edit was asked for)'}.`);
    const msg = done.join('; ');
    return {
      ok: true,
      message: `${msg.charAt(0).toUpperCase()}${msg.slice(1)}.${skipped.length ? ` Skipped: ${skipped.slice(0, 4).join('; ')}.` : ''}`,
      changed: [],
      data: { ids, created },
    };
  },
});

export const restructureSong = defineTool({
  name: 'restructure_song',
  title: 'Insert bars, split, consolidate or fade clips',
  kind: 'write',
  description:
    'Song-structure edits on the Playlist. op insert_bars {at, bars}: insert empty bars at a position across all tracks (clips after it move right, clips crossing it split; markers and the loop region follow). op split_by_channel {clip filter}: replace each pattern clip with one clip per channel, each holding a new single-channel pattern. op consolidate {clip filter, name}: merge the matched pattern clips into ONE new pattern placed where they were. Clip filter = ids / track / bars (overlap) / pattern, as in remove_clips. op fade {clip filter, fade_in?, fade_out?, crossfade?}: on the matched AUDIO clips set linear fade-in / fade-out lengths in beats (0 removes), and/or crossfade each with the audio clip touching it from the left on its track (crossfade = its length in beats; a split clip overlaps back over the cut). To delete bars use remove_clips with close_gap. Examples: {"op":"insert_bars","at":17,"bars":8} · {"op":"split_by_channel","pattern":"Drums","bars":"1-4"} · {"op":"consolidate","bars":"1-8","track":1,"name":"Intro"} · {"op":"fade","track":"Vocals","bars":"1-4","fade_in":2} · {"op":"fade","ids":["cl_2"],"crossfade":0.5}',
  input: z.object({
    op: z.enum(['insert_bars', 'split_by_channel', 'consolidate', 'fade']),
    at: z.union([z.string(), z.number()]).optional().describe('insert_bars: "bar" or "bar.step" (1-based).'),
    bars: z.union([z.string(), z.number()]).optional().describe('insert_bars: how many bars to insert. Other ops: bar range filter, e.g. "1-8".'),
    ids: z.array(z.string()).max(2000).optional(),
    track: zTrack.optional(),
    pattern: z.string().optional(),
    name: z.string().max(64).optional().describe('consolidate: name of the new pattern.'),
    fade_in: z.number().min(0).max(256).optional().describe('fade: fade-in length in beats (0 = none).'),
    fade_out: z.number().min(0).max(256).optional().describe('fade: fade-out length in beats (0 = none).'),
    crossfade: z.number().positive().max(64).optional().describe('fade: crossfade with the audio clip touching from the left, length in beats.'),
    change_label: zLabel,
  }),
  summarize: (a) => (a.op === 'insert_bars' ? `insert ${a.bars} bars @${a.at}` : `${a.op.replace(/_/g, ' ')} ${[a.pattern, a.bars && `bars ${a.bars}`].filter(Boolean).join(', ')}`),
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    if (a.op === 'insert_bars') {
      if (a.at === undefined) fail('insert_bars needs at (the bar to insert at).');
      const count = Number(a.bars);
      if (!Number.isFinite(count) || count <= 0 || count > 4096) fail('insert_bars needs bars: how many bars to insert (e.g. 8).');
      const at = parsePosition(a.at, ts);
      const length = Math.round(count * ticksPerBar(ts));
      const r = ctx.exec<{ moved: number; split: number }>('playlist.insertTime', { at, length });
      return { ok: true, message: `Inserted ${fmtBars(length, ts)} at bar ${fmtPos(at, ts)}: ${plural(r.moved, 'clip')} moved right${r.split ? `, ${r.split} split` : ''}.`, changed: [] };
    }
    const filter = { ids: a.ids, track: a.track, pattern: a.pattern, bars: a.bars === undefined ? undefined : String(a.bars) };
    if (a.op === 'fade') return fadeClips(deps, ctx, filterClips(p, filter), a);
    const clips = filterClips(p, filter).filter((c) => c.kind === 'pattern');
    if (!clips.length) fail('No change: no pattern clips match.');
    const clipIds = clips.map((c) => c.id);
    if (a.op === 'split_by_channel') {
      const r = ctx.exec<{ patternIds: string[]; clipIds: string[] }>('playlist.splitByChannel', { clipIds });
      const names = r.patternIds.map((id) => `"${safeName(deps.doc.project.patterns[id]?.name)}"`);
      return { ok: true, message: `Split ${plural(clips.length, 'clip')} by channel into ${plural(r.clipIds.length, 'clip')}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}.`, changed: [], data: r };
    }
    const r = ctx.exec<{ patternId: string; clipId: string }>('playlist.consolidate', { clipIds, name: a.name ? safeName(a.name, 64) : undefined });
    const pat = deps.doc.project.patterns[r.patternId];
    return { ok: true, message: `Consolidated ${plural(clips.length, 'clip')} into pattern "${safeName(pat?.name)}" (${fmtBars(pat ? patternLength(pat, ts) : 0, ts)}), clip ${r.clipId}.`, changed: [], data: r };
  },
});

function fadeClips(deps: MainDeps, ctx: RunCtx, matched: Clip[], a: { fade_in?: number; fade_out?: number; crossfade?: number }) {
  if (a.fade_in === undefined && a.fade_out === undefined && a.crossfade === undefined) fail('op fade needs fade_in, fade_out and/or crossfade (in beats).');
  const clips = matched.filter((c) => c.kind === 'audio').sort((x, y) => x.start - y.start);
  if (!clips.length) fail('No change: no audio clips match (fades are for audio clips).');
  const beat = ticksPerBeat(deps.doc.project.transport.timeSig);
  const lines: string[] = [];
  const crossfaded: string[] = [];
  const skipped: string[] = [];
  if (a.crossfade !== undefined) {
    for (const c of clips) {
      const r = ctx.tryExec<{ kind: string; length: number }>('playlist.crossfade', { id: c.id, length: Math.max(1, Math.round(a.crossfade * beat)) });
      if (r.ok) crossfaded.push(`${c.id}${r.data?.kind === 'dip' ? ' (a dip: no audio past the cut)' : ''}`);
      else skipped.push(`${c.id}: ${r.message ?? 'failed'}`);
    }
    if (crossfaded.length) lines.push(`crossfaded ${plural(crossfaded.length, 'clip')} with the clip before (${crossfaded.slice(0, 8).join(', ')})`);
  }
  if (a.fade_in !== undefined || a.fade_out !== undefined) {
    const updates = clips.map((c) => ({ id: c.id, fadeIn: a.fade_in === undefined ? undefined : Math.round(a.fade_in * beat), fadeOut: a.fade_out === undefined ? undefined : Math.round(a.fade_out * beat) }));
    const r = ctx.exec<{ clamped: number }>('playlist.setFades', { updates });
    lines.push(`set ${[a.fade_in !== undefined && `fade-in ${a.fade_in} beats`, a.fade_out !== undefined && `fade-out ${a.fade_out} beats`].filter(Boolean).join(' and ')} on ${plural(clips.length, 'audio clip')}${r.clamped ? ` (${r.clamped} shortened to fit the clip)` : ''}`);
  }
  if (!lines.length) fail(`No change: ${skipped.slice(0, 5).join('; ')}`);
  const msg = lines.join('; ');
  return { ok: true, message: `${msg.charAt(0).toUpperCase()}${msg.slice(1)}.${skipped.length ? ` Skipped ${skipped.slice(0, 5).join('; ')}.` : ''}`, changed: [] };
}

export const REFERENCE_TEMPO_TOLERANCE = 0.03;

export async function referenceTempoRefusal(deps: MainDeps, bpm: number): Promise<string | null> {
  const ref = findReference(deps.doc.project);
  if (!ref || !deps.analyzer) return null;
  let detected: number | null = null;
  try {
    const r = await deps.analyzer.analyze({ channelId: ref.channel.id }, { cachedOnly: true });
    detected = r.ok && r.data?.tempo && Number.isFinite(r.data.tempo.bpm) ? r.data.tempo.bpm : null;
  } catch {
    detected = null;
  }
  if (!detected) return null;
  const readings = [0.5, 1, 2].map((f) => Math.round(detected! * f * 10) / 10).filter((b) => b >= 10 && b <= 999);
  if (readings.some((b) => Math.abs(bpm - b) / b <= REFERENCE_TEMPO_TOLERANCE)) return null;
  const nearest = readings.reduce((x, y) => (Math.abs(Math.log2(y / bpm)) < Math.abs(Math.log2(x / bpm)) ? y : x), readings[0]);
  return `Refused: the studied reference "${safeName(ref.title, 60)}" plays at ${readings.join(' / ')} bpm (its tempo, half and double time), and ${bpm} bpm is more than 3% off every reading, so the song would stop sitting on the reference's grid (its drums, sections and A/B no longer line up). Use ${nearest} bpm, or pass override: true only when the user asked for a different tempo.`;
}

export const setTempo = defineTool({
  name: 'set_tempo',
  title: 'Set tempo / time signature',
  kind: 'write',
  description:
    'Set the project tempo (bpm 10..999) and/or time signature ("4/4", "3/4", "6/8"), the song loop region (loop: "9-16" = bars 9 to 16 inclusive, loops playback there; false turns looping off; true turns the existing region back on), the metronome (true / false) and the master volume (master_volume_db, -60..+6). Affects the whole song. While a reference song is studied (study_reference), a tempo more than 3% off its tempo (or its half / double-time reading) is refused unless override is true: keep the reference\'s tempo. Examples: {"bpm":140} · {"loop":"17-24","metronome":true} · {"loop":false}',
  input: z.object({
    bpm: z.number().min(10).max(999).optional(),
    time_signature: z.string().regex(/^\d{1,2}\/(2|4|8|16)$/).optional(),
    loop: z.union([z.string().max(16), z.boolean()]).optional().describe('"9-16" (bars, inclusive) sets and enables the loop region; false disables it; true re-enables the current region.'),
    metronome: z.boolean().optional(),
    master_volume_db: z.number().min(-60).max(6).optional(),
    override: z.boolean().default(false).describe('Set the tempo even when it is off the studied reference\'s tempo (only when the user asked for it).'),
    change_label: zLabel,
  }),
  summarize: (a) =>
    [a.bpm && `${a.bpm} bpm`, a.time_signature, a.loop !== undefined && `loop ${a.loop === false ? 'off' : a.loop === true ? 'on' : a.loop}`, a.metronome !== undefined && `metronome ${a.metronome ? 'on' : 'off'}`, a.master_volume_db !== undefined && `master ${a.master_volume_db} dB`]
      .filter(Boolean)
      .join(', '),
  async run(deps, _c, a, ctx) {
    if (a.bpm === undefined && !a.time_signature && a.loop === undefined && a.metronome === undefined && a.master_volume_db === undefined) fail('Pass bpm, time_signature, loop, metronome and/or master_volume_db.');
    if (a.bpm !== undefined && !a.override) {
      const refusal = await referenceTempoRefusal(deps, a.bpm);
      if (refusal) fail(refusal);
    }
    const before = deps.doc.project.transport;
    const timeSig = a.time_signature ? { num: Number(a.time_signature.split('/')[0]), den: Number(a.time_signature.split('/')[1]) } : undefined;
    let loop: { enabled: boolean; start?: number; end?: number } | undefined;
    if (a.loop === false || a.loop === true) {
      if (a.loop && !(before.loop.end > before.loop.start)) fail('There is no loop region yet: pass the bars, e.g. loop: "9-16".');
      loop = { enabled: a.loop };
    } else if (typeof a.loop === 'string') {
      const r = parseBarRange(a.loop, timeSig ?? before.timeSig);
      loop = { enabled: true, start: r.start, end: r.end };
    }
    const masterVolume = a.master_volume_db !== undefined ? Math.min(2, 10 ** (a.master_volume_db / 20)) : undefined;
    const tempoOnly = a.loop === undefined && a.metronome === undefined && a.master_volume_db === undefined;
    const same =
      (a.bpm === undefined || a.bpm === before.bpm) &&
      (!timeSig || (timeSig.num === before.timeSig.num && timeSig.den === before.timeSig.den)) &&
      (!loop || (loop.enabled === before.loop.enabled && (loop.start === undefined || (loop.start === before.loop.start && loop.end === before.loop.end)))) &&
      (a.metronome === undefined || a.metronome === before.metronome) &&
      (masterVolume === undefined || Math.abs(masterVolume - before.masterVolume) < 1e-4);
    if (same && !tempoOnly) fail('No change: the transport is already set like that.');
    ctx.exec('transport.set', { bpm: a.bpm, timeSig, loop, metronome: a.metronome, masterVolume });
    const t = deps.doc.project.transport;
    const ts = t.timeSig;
    const parts = [`Tempo ${t.bpm} bpm, ${ts.num}/${ts.den}`];
    if (loop) parts.push(t.loop.enabled ? `loop on, bars ${fmtPos(t.loop.start, ts)}–${fmtPos(t.loop.end - 1, ts).split('.')[0]} (${fmtBars(t.loop.end - t.loop.start, ts)})` : 'loop off');
    if (a.metronome !== undefined) parts.push(`metronome ${t.metronome ? 'on' : 'off'}`);
    if (masterVolume !== undefined) parts.push(`master volume ${t.masterVolume > 0 ? `${Math.round(20 * Math.log10(t.masterVolume) * 10) / 10} dB` : '-inf dB'}`);
    return { ok: true, message: `${parts.join(', ')}.`, changed: [] };
  },
});

export const setSwing = defineTool({
  name: 'set_swing',
  title: 'Set global swing',
  kind: 'write',
  description: 'Set the global swing in percent (0 = straight, 50 = strong shuffle, 100 = maximum). It delays off-beat 16ths; each channel follows it by its own swing share.',
  input: z.object({ percent: z.number().min(0).max(100), change_label: zLabel }),
  summarize: (a) => `${a.percent}%`,
  run(deps, _c, a, ctx) {
    ctx.exec('transport.set', { swing: a.percent / 100 });
    return { ok: true, message: `Swing ${Math.round(deps.doc.project.transport.swing * 100)}%.`, changed: [] };
  },
});

export const setMode = defineTool({
  name: 'set_mode',
  title: 'Pattern or song mode',
  kind: 'write',
  description: 'Switch playback between pattern mode (loops the active pattern) and song mode (plays the playlist arrangement).',
  input: z.object({ mode: z.enum(['pattern', 'song']) }),
  summarize: (a) => a.mode,
  run(deps, _c, a, ctx) {
    if (deps.doc.project.transport.mode === a.mode) fail(`No change: already in ${a.mode} mode.`);
    ctx.exec('transport.setMode', { mode: a.mode });
    return { ok: true, message: `Now in ${a.mode} mode.`, changed: [] };
  },
});

export const addMarker = defineTool({
  name: 'add_marker',
  title: 'Add, rename, move or remove song markers',
  kind: 'write',
  description:
    'Song markers / section labels on the playlist timeline. markers adds them; rename, move and remove edit existing ones, found by id or name (get_project lists them). Any mix in one call, one undo step. Examples: {"markers":[{"at":1,"name":"Intro"},{"at":9,"name":"Drop"}]} · {"rename":[{"marker":"Marker 2","name":"Chorus"}],"move":[{"marker":"Drop","at":17}],"remove":["Marker 3"]}',
  input: z.object({
    markers: z.array(z.object({ at: z.union([z.string(), z.number()]).describe('bar or "bar.step"'), name: z.string().min(1).max(64) })).max(64).optional(),
    rename: z.array(z.object({ marker: z.string().min(1).max(80).describe('Marker id or name.'), name: z.string().min(1).max(64) })).max(64).optional(),
    move: z.array(z.object({ marker: z.string().min(1).max(80).describe('Marker id or name.'), at: z.union([z.string(), z.number()]).describe('bar or "bar.step"') })).max(64).optional(),
    remove: z.array(z.string().min(1).max(80)).max(64).optional().describe('Marker ids or names.'),
    change_label: zLabel,
  }),
  summarize: (a) =>
    [a.markers?.map((m) => safeName(m.name, 16)).join(', '), a.rename?.length && `rename ${a.rename.length}`, a.move?.length && `move ${a.move.length}`, a.remove?.length && `remove ${a.remove.length}`].filter(Boolean).join(' · '),
  run(deps, _c, a, ctx) {
    if (!a.markers?.length && !a.rename?.length && !a.move?.length && !a.remove?.length) fail('Pass markers to add, or rename / move / remove.');
    const ts = deps.doc.project.transport.timeSig;
    const done: string[] = [];
    const find = (ref: string) => findMarker(deps.doc.project, ref);
    for (const r of a.rename ?? []) {
      const m = find(r.marker);
      const name = safeName(r.name, 64);
      if (m.name === name) continue;
      ctx.exec('playlist.renameMarker', { id: m.id, name });
      done.push(`renamed "${safeName(m.name)}" to "${name}"`);
    }
    for (const mv of a.move ?? []) {
      const m = find(mv.marker);
      const tick = parsePosition(mv.at, ts);
      if (m.tick === tick) continue;
      ctx.exec('playlist.moveMarker', { id: m.id, tick });
      done.push(`moved "${safeName(m.name)}" to ${fmtPos(tick, ts)}`);
    }
    for (const ref of a.remove ?? []) {
      const m = find(ref);
      ctx.exec('playlist.removeMarker', { id: m.id });
      done.push(`removed "${safeName(m.name)}"`);
    }
    const added: string[] = [];
    for (const m of a.markers ?? []) {
      const tick = parsePosition(m.at, ts);
      const exists = Object.values(deps.doc.project.playlist.markers).some((x) => x.tick === tick && x.name === m.name);
      if (exists) continue;
      ctx.exec('playlist.addMarker', { tick, name: safeName(m.name, 64) });
      added.push(`${safeName(m.name)} @${fmtPos(tick, ts)}`);
    }
    if (added.length) done.unshift(`added ${plural(added.length, 'marker')}: ${added.join(', ')}`);
    if (!done.length) fail('No change: those markers already exist / are already like that.');
    const msg = done.join('; ');
    return { ok: true, message: `${msg.charAt(0).toUpperCase()}${msg.slice(1)}.`, changed: [] };
  },
});

function findMarker(p: Project, ref: string): Marker {
  const t = ref.trim();
  const byId = p.playlist.markers[t];
  if (byId) return byId;
  const all = Object.values(p.playlist.markers);
  const hits = all.filter((m) => m.name.toLowerCase() === t.toLowerCase());
  if (hits.length === 1) return hits[0];
  const ts = p.transport.timeSig;
  if (hits.length > 1) fail(`${hits.length} markers are called "${safeName(t, 40)}": pass an id (${hits.map((m) => `${m.id} @${fmtPos(m.tick, ts)}`).join(', ')}).`);
  fail(`No marker "${safeName(t, 40)}". Markers: ${all.length ? all.sort((x, y) => x.tick - y.tick).slice(0, 20).map((m) => `"${safeName(m.name, 30)}" @${fmtPos(m.tick, ts)}`).join(', ') : 'none yet'}.`);
}

function resolveTarget(
  deps: MainDeps,
  a: { ref?: string; channel?: string; insert?: string | number; effect?: string | number; chain?: string | number; device?: string | number; param?: string },
): { ref: string; spec: ParamSpec; label: string } {
  const p = deps.doc.project;
  const catalog = deps.doc.catalog;
  let ref: string;
  let label: string;
  if (!a.ref && a.chain !== undefined) {
    const param = a.param ?? fail('param is required with chain (e.g. "cutoff", "volume", "pan", or a device param / "mix" with device)');
    if (a.channel) {
      const ch = findChannel(p, a.channel);
      const r = rackInnerRef(p, catalog, { kind: 'channel', channelId: ch.id }, `"${safeName(ch.name)}"`, a.chain, a.device, param);
      return { ...r, label: `${safeName(ch.name)} ${r.label}` };
    }
    if (a.insert !== undefined && a.effect !== undefined) {
      const ins = findInsert(p, a.insert);
      const sid = findSlot(ins, a.effect, catalog);
      const r = rackInnerRef(p, catalog, { kind: 'slot', insertId: ins.id, slotId: sid }, 'That effect', a.chain, a.device, param);
      return { ...r, label: `${ins.isMaster ? 'Master' : safeName(ins.name)} ${r.label}` };
    }
    fail('chain addresses a knob inside a rack: pass it with "channel" (instrument / drum rack) or "insert" + "effect" (effect rack).');
  }
  if (a.ref) {
    ref = a.ref;
    label = a.ref;
  } else if (a.channel) {
    const ch = findChannel(p, a.channel);
    const param = a.param ?? fail('param is required with channel (e.g. "cutoff", or "volume"/"pan"/"pitch")');
    if (['volume', 'pan', 'pitch'].includes(param)) ref = `channel/${ch.id}/${param}`;
    else {
      const desc = findPluginRef(catalog, ch.generator.type);
      const spec = desc.params.find((s) => s.id === param || s.name.toLowerCase() === param.toLowerCase());
      if (!spec) fail(`${desc.name} has no parameter "${safeName(param, 30)}" (describe_plugin {"channel":"${safeName(ch.name, 30)}"})`);
      ref = `channel/${ch.id}/gen/${spec.id}`;
    }
    label = `${safeName(ch.name)} ${param}`;
  } else if (a.insert !== undefined) {
    const ins = findInsert(p, a.insert);
    const param = a.param ?? fail('param is required with insert (e.g. "volume", or an effect param with effect)');
    if (a.effect !== undefined) {
      const sid = findSlot(ins, a.effect, catalog);
      const desc = findPluginRef(catalog, ins.slots[sid].type);
      const spec = param === 'mix' ? null : desc.params.find((s) => s.id === param || s.name.toLowerCase() === param.toLowerCase());
      if (param !== 'mix' && !spec) fail(`${desc.name} has no parameter "${safeName(param, 30)}"`);
      ref = `insert/${ins.id}/slot/${sid}/${spec ? spec.id : 'mix'}`;
      label = `${ins.isMaster ? 'Master' : safeName(ins.name)} ${desc.name.replace(/^Krypt /, '')} ${param}`;
    } else {
      ref = `insert/${ins.id}/${param}`;
      label = `${ins.isMaster ? 'Master' : safeName(ins.name)} ${param}`;
    }
  } else fail('Pass a target: ref (ParamRef), channel + param, or insert (+ effect) + param.');
  const spec = paramSpecFor(p, catalog, ref);
  if (!spec) fail(`"${safeName(ref, 80)}" is not an automatable parameter`);
  return { ref, spec, label };
}

function fmtNorm(spec: ParamSpec, n: number): string {
  const plain = spec.scale === 'log' ? spec.min * Math.pow(spec.max / spec.min, n) : spec.scale === 'gain' ? spec.max * n ** 3 : spec.min + n * (spec.max - spec.min);
  return formatParam(spec, plain);
}

export const addAutomation = defineTool({
  name: 'add_automation',
  title: 'Write automation',
  kind: 'write',
  description:
    'Automate a parameter over a bar range: creates an automation clip on the playlist. Give a ramp (from → to with curve linear | exp (slow start) | log (fast start) | hold) or explicit points [{at:"5.1", value:"2kHz"}] (song positions, values in human units). Target: {channel, param} | {insert, effect?, param} | {ref}; a knob inside a rack: add chain (+ device for an effect in it), e.g. {"channel":"Keys","chain":"Piano","param":"cutoff"} or {"insert":"Master","effect":"FX Rack","chain":1,"device":"delay","param":"mix"}. Example: {"channel":"Pad","param":"cutoff","bars":"1-8","from":"300Hz","to":"8kHz","curve":"exp"}',
  input: z.object({
    ref: z.string().optional(),
    channel: z.string().optional(),
    insert: z.union([z.string(), z.number()]).optional(),
    effect: z.union([z.string(), z.number()]).optional(),
    chain: z.union([z.string().max(64), z.number().int().min(1)]).optional().describe('A chain inside the rack on that channel / effect (name or number).'),
    device: z.union([z.string().max(64), z.number().int().min(1)]).optional().describe('With chain: an effect in that chain (name, plugin id or number).'),
    param: z.string().optional(),
    bars: z.string().describe('"1-8" inclusive'),
    from: z.union([z.number(), z.string()]).optional(),
    to: z.union([z.number(), z.string()]).optional(),
    curve: z.enum(['linear', 'exp', 'log', 'hold']).default('linear'),
    points: z.array(z.object({ at: z.union([z.string(), z.number()]), value: z.union([z.number(), z.string()]) })).max(512).optional(),
    track: zTrack.optional(),
    name: z.string().max(64).optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel ?? String(a.insert ?? a.ref ?? ''), 24)} ${a.param ?? ''} bars ${a.bars}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    const range = parseBarRange(a.bars, ts);
    const { ref, spec, label } = resolveTarget(deps, a);
    const len = range.end - range.start;
    const norm = (v: number | string) => toNormalized(spec, parseParamValue(spec, v));
    let points: Array<{ tick: number; value: number; tension: number }>;
    if (a.points?.length) {
      points = a.points
        .map((pt) => ({ tick: parsePosition(pt.at, ts) - range.start, value: norm(pt.value), tension: 0 }))
        .sort((x, y) => x.tick - y.tick);
      const bad = points.find((pt) => pt.tick < 0 || pt.tick > len);
      if (bad) fail(`automation point at ${fmtPos(bad.tick + range.start, ts)} is outside bars ${a.bars}`);
    } else {
      if (a.from === undefined || a.to === undefined) fail('Pass from + to (a ramp) or points.');
      const v0 = norm(a.from);
      const v1 = norm(a.to);
      if (a.curve === 'hold') points = [{ tick: 0, value: v0, tension: 0 }, { tick: Math.max(1, len - 1), value: v0, tension: 0 }, { tick: len, value: v1, tension: 0 }];
      else points = [{ tick: 0, value: v0, tension: a.curve === 'exp' ? -0.5 : a.curve === 'log' ? 0.5 : 0 }, { tick: len, value: v1, tension: 0 }];
    }
    const trackId = a.track !== undefined ? findTrack(p, a.track) : laneFor(deps, ctx, null, range.start, range.end);
    const r = ctx.exec<{ automationId: string; clipId: string }>('automation.create', { target: ref, name: safeName(a.name ?? `${label} automation`, 64), points, trackId, start: range.start, length: len });
    const cur = getParamValue(deps.doc.project, deps.doc.catalog, ref);
    const fmtN = (n: number) => fmtNorm(spec, n);
    return {
      ok: true,
      message: `Automated ${label} over bars ${a.bars} (${plural(points.length, 'point')}: ${points.map((pt) => `${fmtN(pt.value)}@${fmtPos(pt.tick + range.start, ts)}`).slice(0, 6).join(' → ')}) on ${trackLabel(deps.doc.project, trackId)}. Automation ${r.automationId}, clip ${r.clipId}. Plays in song mode${cur !== null ? `; the knob's static value is ${formatParam(spec, cur)}` : ''}.`,
      changed: [],
      data: { automationId: r.automationId, clipId: r.clipId, ref },
    };
  },
});

const TENSION = { linear: 0, exp: -0.5, log: 0.5 } as const;
const zAutPoint = z.object({
  at: z.union([z.string(), z.number()]).describe('Song position "bar" or "bar.step".'),
  value: z.union([z.number(), z.string()]).describe('In the parameter\'s units ("2kHz", "-6dB", "50%") or a number.'),
  curve: z.enum(['linear', 'exp', 'log']).optional().describe('Shape of the line from this point to the next.'),
});

function findAutomation(p: Project, ref: string): Project['automations'][string] {
  const t = ref.trim();
  const byId = p.automations[t] ?? (p.playlist.clips[t]?.automationId ? p.automations[p.playlist.clips[t].automationId!] : undefined);
  if (byId) return byId;
  const all = Object.values(p.automations);
  const hits = all.filter((x) => x.name.toLowerCase() === t.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail(`${hits.length} automations are called "${safeName(t, 40)}": pass an id (${hits.map((x) => x.id).join(', ')}).`);
  fail(`No automation "${safeName(t, 40)}". Automations: ${all.length ? all.slice(0, 20).map((x) => `"${safeName(x.name, 30)}" (${x.id})`).join(', ') : 'none yet (add_automation creates one)'}.`);
}

export const editAutomation = defineTool({
  name: 'edit_automation',
  title: 'Edit an existing automation',
  kind: 'write',
  description:
    'Change an automation that already exists (by id, name, or the id of one of its playlist clips; get_project lists them), in one undo step. points replaces every point; or add / update (by 1-based index in time order) / remove (indices) / remove_bars (every point in that bar range). Positions are SONG positions ("9", "9.5") read through the automation\'s first playlist clip (where it plays); values are in the parameter\'s units ("2kHz", "-6dB") or numbers; curve shapes the line to the next point (linear | exp = slow start | log = fast start). Retarget to another parameter with the same target fields as add_automation ({channel, param} | {insert, effect?, param} | {ref}; values keep their 0..1 position). name and color rename / recolor it. Example: {"automation":"Pad cutoff automation","update":[{"index":2,"value":"6kHz"}],"add":[{"at":"12.1","value":"300Hz","curve":"exp"}]}',
  input: z.object({
    automation: z.string().min(1).max(120),
    points: z.array(zAutPoint).min(1).max(512).optional(),
    add: z.array(zAutPoint).max(512).optional(),
    update: z.array(z.object({ index: z.number().int().min(1), at: z.union([z.string(), z.number()]).optional(), value: z.union([z.number(), z.string()]).optional(), curve: z.enum(['linear', 'exp', 'log']).optional() })).max(512).optional(),
    remove: z.array(z.number().int().min(1)).max(512).optional().describe('1-based point indices in time order (before this edit).'),
    remove_bars: z.string().optional().describe('Remove every point in this song bar range, e.g. "9-12".'),
    ref: z.string().optional(),
    channel: z.string().optional(),
    insert: z.union([z.string(), z.number()]).optional(),
    effect: z.union([z.string(), z.number()]).optional(),
    chain: z.union([z.string().max(64), z.number().int().min(1)]).optional(),
    device: z.union([z.string().max(64), z.number().int().min(1)]).optional(),
    param: z.string().optional(),
    name: z.string().min(1).max(64).optional(),
    color: zColor.optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.automation, 30)}${a.points ? ` · ${plural(a.points.length, 'point')}` : ''}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    const aut = findAutomation(p, a.automation);
    if (a.points && (a.add?.length || a.update?.length || a.remove?.length || a.remove_bars)) fail('points replaces every point: pass it alone, or use add / update / remove.');
    const done: string[] = [];

    const retarget = a.ref !== undefined || a.channel !== undefined || a.insert !== undefined;
    const target = retarget ? resolveTarget(deps, a) : null;
    const set: Record<string, unknown> = {};
    if (target && target.ref !== aut.target) set.target = target.ref;
    if (a.name && safeName(a.name, 64) !== aut.name) set.name = safeName(a.name, 64);
    if (a.color && a.color !== aut.color) set.color = a.color;
    if (Object.keys(set).length) {
      ctx.exec('automation.set', { id: aut.id, ...set });
      if (set.target) done.push(`now automates ${target!.label}`);
      if (set.name) done.push(`renamed to "${set.name}"`);
      if (set.color) done.push(`colored ${set.color}`);
    }

    const clip = Object.values(deps.doc.project.playlist.clips).filter((c) => c.automationId === aut.id).sort((x, y) => x.start - y.start)[0];
    const base = clip ? clip.start - clip.offset : 0;
    const rel = (at: string | number) => {
      const t = parsePosition(at, ts) - base;
      if (t < 0) fail(`${at} is before this automation's start (bar ${fmtPos(base, ts)}, where its clip begins).`);
      return t;
    };
    const targetRef = deps.doc.project.automations[aut.id].target;
    const spec = targetRef ? paramSpecFor(deps.doc.project, deps.doc.catalog, targetRef) : null;
    const norm = (v: number | string) => {
      if (spec) return toNormalized(spec, parseParamValue(spec, v));
      if (typeof v !== 'number' || v < 0 || v > 1) fail('This automation has no target: values must be numbers 0..1 (or retarget it first).');
      return v;
    };
    const show = (n: number) => (spec ? fmtNorm(spec, n) : `${Math.round(n * 100)}%`);
    const sorted = Object.values(aut.points).sort((x, y) => x.tick - y.tick);
    const pick = (i: number) => sorted[i - 1] ?? fail(`There is no point ${i}: this automation has ${plural(sorted.length, 'point')}.`);

    if (a.points) {
      const pts = a.points.map((pt) => ({ tick: rel(pt.at), value: norm(pt.value), tension: TENSION[pt.curve ?? 'linear'] })).sort((x, y) => x.tick - y.tick);
      ctx.exec('automation.setPoints', { id: aut.id, points: pts });
      done.push(`replaced the points with ${plural(pts.length, 'point')}`);
    } else if (a.add?.length || a.update?.length || a.remove?.length || a.remove_bars) {
      const remove = new Set<string>((a.remove ?? []).map((i) => pick(i).id));
      if (a.remove_bars) {
        const r = parseBarRange(a.remove_bars, ts);
        for (const pt of sorted) if (pt.tick + base >= r.start && pt.tick + base < r.end) remove.add(pt.id);
      }
      const update = (a.update ?? []).map((u) => {
        const pt = pick(u.index);
        if (remove.has(pt.id)) fail(`Point ${u.index} is both updated and removed.`);
        return { id: pt.id, ...(u.at !== undefined ? { tick: rel(u.at) } : {}), ...(u.value !== undefined ? { value: norm(u.value) } : {}), ...(u.curve ? { tension: TENSION[u.curve] } : {}) };
      });
      const changedUpdates = update.filter((u) => {
        const pt = aut.points[u.id];
        return (u.tick !== undefined && u.tick !== pt.tick) || (u.value !== undefined && Math.abs(u.value - pt.value) > 1e-9) || (u.tension !== undefined && u.tension !== pt.tension);
      });
      const add = (a.add ?? []).map((pt) => ({ tick: rel(pt.at), value: norm(pt.value), tension: TENSION[pt.curve ?? 'linear'] }));
      if (remove.size || changedUpdates.length || add.length) {
        ctx.exec('automation.editPoints', { id: aut.id, ...(add.length ? { add } : {}), ...(changedUpdates.length ? { update: changedUpdates } : {}), ...(remove.size ? { remove: [...remove] } : {}) });
        done.push([add.length && `added ${plural(add.length, 'point')}`, changedUpdates.length && `changed ${plural(changedUpdates.length, 'point')}`, remove.size && `removed ${plural(remove.size, 'point')}`].filter(Boolean).join(', '));
      }
    }
    if (!done.length) fail(`No change: "${safeName(aut.name)}" is already like that.`);

    const after = Object.values(deps.doc.project.automations[aut.id].points).sort((x, y) => x.tick - y.tick);
    const lastSong = after.length ? after[after.length - 1].tick + base : 0;
    const beyond = clip && lastSong > clip.start + clip.length ? ` Its last point (bar ${fmtPos(lastSong, ts)}) is past the end of its clip: lengthen the clip (edit_clips length_bars) to hear it.` : '';
    const list = after.slice(0, 8).map((pt) => `${show(pt.value)}@${fmtPos(pt.tick + base, ts)}`).join(' → ');
    const msg = done.join('; ');
    return {
      ok: true,
      message: `"${safeName(deps.doc.project.automations[aut.id].name)}": ${msg}. Now ${plural(after.length, 'point')}: ${list}${after.length > 8 ? ' …' : ''}.${clip ? '' : ' It has no playlist clip yet (add_clip {"automation":…} places one); positions were read from bar 1.'}${beyond}`,
      changed: [],
      data: { automationId: aut.id, points: after.length },
    };
  },
});

export const ARRANGE_TOOLS = [arrange, addClip, removeClips, editClips, restructureSong, setTempo, setSwing, setMode, addMarker, addAutomation, editAutomation];
