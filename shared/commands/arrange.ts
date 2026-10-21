// Playlist arrangement tools: split a pattern clip by channel, consolidate
// pattern clips into one pattern, clone clips as unique copies, and insert /
// delete time. Pure document edits (no I/O); each is ONE undo step.

import { z } from 'zod';
import { defineCommand, must, plural, CommandError } from './types';
import { patternLength, type Clip, type Note, type Pattern, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import type { CommandContext } from './types';

const NAME_MAX = 64;

function clipName(s: string): string {
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
}

/** Copy a channel's notes with fresh ids. */
function cloneNotes(src: Record<string, Note>, ctx: CommandContext): Record<string, Note> {
  const out: Record<string, Note> = {};
  for (const n of Object.values(src)) {
    const id = ctx.newId(ID_PREFIX.note);
    out[id] = { ...n, id };
  }
  return out;
}

function clonePattern(src: Pattern, ctx: CommandContext): Record<string, Record<string, Note>> {
  const notes: Record<string, Record<string, Note>> = {};
  for (const [chId, byId] of Object.entries(src.notes)) notes[chId] = cloneNotes(byId, ctx);
  return notes;
}

function uniqueName(d: Project, base: string): string {
  const names = new Set(Object.values(d.patterns).map((p) => p.name));
  let k = 2;
  while (names.has(`${base} #${k}`)) k++;
  return clipName(`${base} #${k}`);
}

function overlaps(c: Clip, start: number, end: number): boolean {
  return c.start < end && c.start + c.length > start;
}

/** Sort clips top-to-bottom, then left-to-right (deterministic processing order). */
function byPosition(d: Project, clips: Clip[]): Clip[] {
  const lane = (c: Clip) => d.playlist.trackOrder.indexOf(c.trackId);
  return [...clips].sort((a, b) => lane(a) - lane(b) || a.start - b.start || a.id.localeCompare(b.id));
}

function newTrack(d: Project, index: number, name: string, height: number, ctx: CommandContext): string {
  const id = ctx.newId(ID_PREFIX.track);
  d.playlist.tracks[id] = { id, name: clipName(name), color: '#3F3F52', height, mute: false, solo: false };
  d.playlist.trackOrder.splice(Math.min(index, d.playlist.trackOrder.length), 0, id);
  return id;
}

// ── Split by channel ──────────────────────────────────────────────────

export const playlistSplitByChannel = defineCommand({
  id: 'playlist.splitByChannel',
  label: (a) => `Split ${plural(a.clipIds.length, 'clip')} by channel`,
  description:
    'FL "Split by channel": every pattern clip in clipIds is replaced by one clip per channel that has notes in its pattern. Each channel gets a new pattern ("<Pattern> – <Channel>", channel colour, same loop length) holding only its notes. The first channel stays on the source track; the others go on the following tracks (a following track is reused only when it is free over the clip time range, otherwise a new track is inserted). Non-pattern clips are ignored. Returns { patternIds, clipIds }.',
  args: z.object({ clipIds: z.array(z.string()).min(1).max(500) }),
  run(d, a, ctx) {
    const src = byPosition(
      d,
      a.clipIds.map((id) => must(d.playlist.clips[id], `Clip ${id} not found`)).filter((c) => c.kind === 'pattern' && c.patternId),
    );
    if (!src.length) throw new CommandError('Select at least one pattern clip to split by channel');
    const ts = d.transport.timeSig;
    // One set of per-channel patterns per distinct source pattern.
    const split = new Map<string, Array<{ channelId: string; patternId: string }>>();
    const patternIds: string[] = [];
    for (const c of src) {
      const pid = c.patternId!;
      if (split.has(pid)) continue;
      const pat = must(d.patterns[pid], `Pattern ${pid} not found`);
      const chans = [
        ...d.channelOrder.filter((ch) => Object.keys(pat.notes[ch] ?? {}).length > 0),
        ...Object.keys(pat.notes).filter((ch) => !d.channelOrder.includes(ch) && d.channels[ch] && Object.keys(pat.notes[ch]).length > 0),
      ];
      if (!chans.length) throw new CommandError(`${pat.name} has no notes to split`);
      const len = patternLength(pat, ts);
      const parts: Array<{ channelId: string; patternId: string }> = [];
      let at = d.patternOrder.indexOf(pid) + 1;
      for (const chId of chans) {
        const ch = d.channels[chId];
        const id = ctx.newId(ID_PREFIX.pattern);
        d.patterns[id] = { id, name: clipName(`${pat.name} – ${ch.name}`), color: ch.color, length: len, notes: { [chId]: cloneNotes(pat.notes[chId], ctx) } };
        d.patternOrder.splice(at++, 0, id);
        parts.push({ channelId: chId, patternId: id });
        patternIds.push(id);
      }
      split.set(pid, parts);
    }
    const removing = new Set(src.map((c) => c.id));
    for (const c of src) delete d.playlist.clips[c.id];
    const clipIds: string[] = [];
    for (const c of src) {
      const parts = split.get(c.patternId!)!;
      const height = d.playlist.tracks[c.trackId]?.height ?? 44;
      let lane = d.playlist.trackOrder.indexOf(c.trackId);
      parts.forEach((part, i) => {
        let trackId = c.trackId;
        if (i > 0) {
          lane++;
          const cand = d.playlist.trackOrder[lane];
          const busy =
            !cand ||
            Object.values(d.playlist.clips).some((o) => o.trackId === cand && !removing.has(o.id) && overlaps(o, c.start, c.start + c.length));
          trackId = busy ? newTrack(d, lane, d.channels[part.channelId]?.name ?? `Track ${lane + 1}`, height, ctx) : cand;
        }
        const id = ctx.newId(ID_PREFIX.clip);
        d.playlist.clips[id] = { id, trackId, kind: 'pattern', start: c.start, length: c.length, offset: c.offset, mute: c.mute, color: null, patternId: part.patternId };
        clipIds.push(id);
      });
    }
    return { patternIds, clipIds };
  },
});

// ── Consolidate ───────────────────────────────────────────────────────

export const playlistConsolidate = defineCommand({
  id: 'playlist.consolidate',
  label: (a) => `Consolidate ${plural(a.clipIds.length, 'clip')}`,
  description:
    'Merge pattern clips into ONE new pattern spanning [earliest start, latest end): every clip\'s notes are written at their song position (honouring the clip offset, the pattern looping inside a longer clip, and notes cut at the clip end). Notes from muted clips are kept but muted. One clip of the new pattern replaces the sources on the topmost involved track. Returns { patternId, clipId }.',
  args: z.object({ clipIds: z.array(z.string()).min(1).max(2000), name: z.string().max(NAME_MAX).optional() }),
  run(d, a, ctx) {
    const src = byPosition(
      d,
      a.clipIds.map((id) => must(d.playlist.clips[id], `Clip ${id} not found`)).filter((c) => c.kind === 'pattern' && c.patternId),
    );
    if (!src.length) throw new CommandError('Select pattern clips to consolidate');
    const ts = d.transport.timeSig;
    const t0 = Math.min(...src.map((c) => c.start));
    const t1 = Math.max(...src.map((c) => c.start + c.length));
    const notes: Record<string, Record<string, Note>> = {};
    for (const c of src) {
      const pat = must(d.patterns[c.patternId!], `Pattern ${c.patternId} not found`);
      const len = patternLength(pat, ts);
      const clipEnd = c.start + c.length;
      for (const [chId, byId] of Object.entries(pat.notes)) {
        for (const n of Object.values(byId)) {
          if (n.tick >= len) continue; // never reached by the looping source
          // unwrapped source positions n.tick + k·len inside [offset, offset + length)
          let k = Math.ceil((c.offset - n.tick) / len);
          for (let p = n.tick + k * len; p < c.offset + c.length; p = n.tick + ++k * len) {
            const song = c.start + p - c.offset;
            const dur = Math.max(1, Math.min(n.dur, clipEnd - song));
            const id = ctx.newId(ID_PREFIX.note);
            (notes[chId] ??= {})[id] = { ...n, id, tick: song - t0, dur, ...(c.mute ? { mute: true } : {}) };
          }
        }
      }
    }
    const first = d.patterns[src[0].patternId!];
    let name = a.name?.trim();
    if (!name) {
      let k = 1;
      const names = new Set(Object.values(d.patterns).map((p) => p.name));
      while (names.has(`Consolidated ${k}`)) k++;
      name = `Consolidated ${k}`;
    }
    const patternId = ctx.newId(ID_PREFIX.pattern);
    d.patterns[patternId] = { id: patternId, name, color: first?.color ?? '#A855F7', length: t1 - t0, notes };
    d.patternOrder.push(patternId);
    const trackId = src[0].trackId; // byPosition: topmost lane first
    for (const c of src) delete d.playlist.clips[c.id];
    const clipId = ctx.newId(ID_PREFIX.clip);
    d.playlist.clips[clipId] = { id: clipId, trackId, kind: 'pattern', start: t0, length: t1 - t0, offset: 0, mute: false, color: null, patternId };
    return { patternId, clipId };
  },
});

// ── Clone as unique ───────────────────────────────────────────────────

export const playlistCloneClips = defineCommand({
  id: 'playlist.cloneClips',
  label: (a) => `Clone ${plural(a.ids.length, 'clip')}`,
  description:
    'Duplicate clips (shifted by `shift` ticks; default: right after the selection) and make every cloned pattern clip unique: each source pattern gets one fresh copy per call, so editing the clones never changes the originals. Returns { ids, patternIds }.',
  args: z.object({ ids: z.array(z.string()).min(1).max(2000), shift: z.number().int().optional() }),
  run(d, a, ctx) {
    const src = a.ids.map((id) => must(d.playlist.clips[id], `Clip ${id} not found`));
    const minStart = Math.min(...src.map((c) => c.start));
    const maxEnd = Math.max(...src.map((c) => c.start + c.length));
    const shift = a.shift ?? maxEnd - minStart;
    const copies = new Map<string, string>();
    const ids: string[] = [];
    for (const c of src) {
      let patternId = c.patternId;
      if (c.kind === 'pattern' && c.patternId) {
        let copy = copies.get(c.patternId);
        if (!copy) {
          const pat = must(d.patterns[c.patternId], `Pattern ${c.patternId} not found`);
          copy = ctx.newId(ID_PREFIX.pattern);
          d.patterns[copy] = { ...pat, id: copy, name: uniqueName(d, pat.name), notes: clonePattern(pat, ctx) };
          d.patternOrder.splice(d.patternOrder.indexOf(pat.id) + 1, 0, copy);
          copies.set(c.patternId, copy);
        }
        patternId = copy;
      }
      const id = ctx.newId(ID_PREFIX.clip);
      d.playlist.clips[id] = { ...c, id, start: Math.max(0, c.start + shift), ...(patternId ? { patternId } : {}) };
      ids.push(id);
    }
    return { ids, patternIds: [...copies.values()] };
  },
});

// ── Insert / delete time ──────────────────────────────────────────────

/** Split clip `c` at absolute tick `at` (strictly inside); returns the new right-hand clip. */
function splitAt(d: Project, c: Clip, at: number, ctx: CommandContext): Clip {
  const rel = at - c.start;
  const id = ctx.newId(ID_PREFIX.clip);
  const right: Clip = { ...c, id, start: at, length: c.length - rel, offset: c.offset + rel };
  if (c.kind === 'audio') {
    right.fadeIn = 0;
    right.fadeOut = Math.min(c.fadeOut ?? 0, right.length);
    c.fadeOut = 0;
  }
  c.length = rel;
  if (c.kind === 'audio') c.fadeIn = Math.min(c.fadeIn ?? 0, c.length);
  d.playlist.clips[id] = right;
  return right;
}

export const playlistInsertTime = defineCommand({
  id: 'playlist.insertTime',
  label: () => 'Insert time',
  description:
    'Insert `length` ticks of silence at song tick `at`: every clip starting at/after `at` moves right, clips crossing `at` are split there and their right part moves, markers at/after `at` move. The song loop region moves when it starts at/after `at` and stretches when it contains `at`. Returns { moved, split }.',
  args: z.object({ at: z.number().int().min(0), length: z.number().int().min(1).max(960 * 4 * 4096) }),
  run(d, a, ctx) {
    let moved = 0;
    let split = 0;
    for (const c of Object.values(d.playlist.clips)) {
      if (c.start >= a.at) {
        c.start += a.length;
        moved++;
      } else if (c.start + c.length > a.at) {
        const right = splitAt(d, c, a.at, ctx);
        right.start += a.length;
        split++;
      }
    }
    for (const m of Object.values(d.playlist.markers)) if (m.tick >= a.at) m.tick += a.length;
    const loop = d.transport.loop;
    if (loop.end > loop.start) {
      if (loop.start >= a.at) {
        loop.start += a.length;
        loop.end += a.length;
      } else if (loop.end > a.at) loop.end += a.length;
    }
    return { moved, split };
  },
});

export const playlistDeleteTime = defineCommand({
  id: 'playlist.deleteTime',
  label: () => 'Delete time',
  description:
    'Remove the song time range [start, end) and close the gap: clips fully inside are deleted, clips crossing an edge are trimmed (the clip offset advances when its left part is cut), a clip spanning the whole range keeps both outer parts as two clips that now touch, and everything after `end` moves left. Markers inside are removed, later ones move left. The loop region is remapped the same way (disabled if it collapses). Returns { removed, trimmed, moved }.',
  args: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }),
  run(d, a, ctx) {
    if (a.end <= a.start) throw new CommandError('The time range to delete is empty');
    const len = a.end - a.start;
    let removed = 0;
    let trimmed = 0;
    let moved = 0;
    for (const c of Object.values(d.playlist.clips)) {
      const cs = c.start;
      const ce = c.start + c.length;
      if (ce <= a.start) continue;
      if (cs >= a.end) {
        c.start -= len;
        moved++;
      } else if (cs >= a.start && ce <= a.end) {
        delete d.playlist.clips[c.id];
        removed++;
      } else if (cs < a.start && ce > a.end) {
        // keep [cs, start) and [end, ce): split at end, drop the middle, butt the right part on
        const right = splitAt(d, c, a.end, ctx);
        right.start = a.start;
        c.length = a.start - cs;
        if (c.kind === 'audio') c.fadeIn = Math.min(c.fadeIn ?? 0, c.length);
        trimmed++;
      } else if (cs < a.start) {
        c.length = a.start - cs;
        if (c.kind === 'audio') c.fadeOut = Math.min(c.fadeOut ?? 0, c.length);
        trimmed++;
      } else {
        const cut = a.end - cs;
        c.start = a.start;
        c.offset += cut;
        c.length -= cut;
        if (c.kind === 'audio') c.fadeIn = Math.min(c.fadeIn ?? 0, c.length);
        trimmed++;
      }
    }
    for (const m of Object.values(d.playlist.markers)) {
      if (m.tick >= a.end) m.tick -= len;
      else if (m.tick >= a.start) delete d.playlist.markers[m.id];
    }
    const loop = d.transport.loop;
    if (loop.end > loop.start) {
      const f = (t: number) => (t < a.start ? t : t >= a.end ? t - len : a.start);
      const s = f(loop.start);
      const e = f(loop.end);
      if (e - s >= 1) {
        loop.start = s;
        loop.end = e;
      } else loop.enabled = false; // the whole region was deleted: keep its old bounds, just switch it off
    }
    return { removed, trimmed, moved };
  },
});

export const ARRANGE_COMMANDS = [playlistSplitByChannel, playlistConsolidate, playlistCloneClips, playlistInsertTime, playlistDeleteTime];
