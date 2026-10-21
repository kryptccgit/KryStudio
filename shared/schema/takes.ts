// ──────────────────────────────────────────────────────────────────────
// Take lanes + comping (Wave 12.2b, docs/ENGINE_PROTOCOL.md §13).
//
// The model:
//   - A TAKE GROUP belongs to one playlist track and a span of song ticks.
//     It holds the alternatives recorded over a loop region (one TAKE per loop
//     pass), their order (top lane first) and the COMP: a sorted list of
//     non-overlapping segments [start, end) → takeId saying which take plays
//     where. Gaps in the comp are silence.
//   - A take's SOURCE is either an Audio Clip channel (kind 'audio': one
//     channel per take, all playing the SAME continuous recording file; the
//     take is just a different offset into it) or a pattern (kind 'pattern':
//     the MIDI played in that pass). `origin` = the song tick at which source
//     position 0 plays, so a clip of the take at song tick T has
//     offset T − origin. [start, end) = where the take was recorded; audio
//     takes also know where their file ends (`srcEnd`), which bounds the
//     crossfade handles (a continuous file has audio on both sides of a pass).
//   - The comp is MATERIALISED as ordinary playlist clips on the group's
//     track (`materializeComp`): one clip per segment, of that take's source.
//     Crossfades are plain clip fades: at a boundary between two adjacent
//     audio segments the incoming clip starts a little early and the
//     outgoing one ends a little late, both fading over the crossfade
//     (`planCompClips`: centred when both takes have audio there). Each
//     take has its own channel because the engine keeps ONE clip envelope
//     per channel; overlapping fades need two. So the engine has no comp logic
//     at all: it just plays clips.
//   - The comp clips are found again by their source (a take's channel or
//     pattern on the group's track), so no clip ids are stored and nothing
//     dangles when the user deletes a clip. Editing a comp (takes.* commands)
//     rebuilds those clips; hand edits to them (gain, a moved clip) are
//     replaced on the next comp edit.
//   - Removing the track drops its groups; removing a take's channel or
//     pattern drops that take (`dropTakeRefs`, called by the remove commands).
// Pure: no I/O. Commands live in shared/commands/takes.ts.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { Clip, Project } from './project';

export type TakeSource = { kind: 'audio'; channelId: string } | { kind: 'pattern'; patternId: string };

export interface Take {
  id: string;
  name: string;
  /** Recording pass, 1-based ("take from pass N"). */
  pass: number;
  source: TakeSource;
  /** Song tick at which source position 0 plays (clip offset = T − origin). May be negative. */
  origin: number;
  /** Song ticks where this take was recorded. */
  start: number;
  end: number;
  /** Audio: song tick where the source file ends. Absent = unbounded (patterns loop). */
  srcEnd?: number;
}

export interface CompSegment {
  start: number;
  end: number;
  takeId: string;
}

export interface TakeGroup {
  id: string;
  name: string;
  trackId: string;
  /** Span on the song timeline (the union of the takes). */
  start: number;
  end: number;
  takes: Record<string, Take>;
  /** Lane order, top first. */
  takeOrder: string[];
  /** Sorted, non-overlapping; gaps are silence. */
  comp: CompSegment[];
  /** Crossfade length in ticks at comp boundaries (audio takes only). */
  crossfade: number;
}

export const TAKE_ID_PREFIX = { group: 'tg', take: 'tk' } as const;
export const MAX_TAKES = 64;
export const MAX_CROSSFADE = 3840;

// ── Zod ───────────────────────────────────────────────────────────────

const zTakeSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('audio'), channelId: z.string().min(1) }),
  z.object({ kind: z.literal('pattern'), patternId: z.string().min(1) }),
]);

export const zTake = z.object({
  id: z.string().min(1),
  name: z.string().max(64),
  pass: z.number().int().min(1),
  source: zTakeSource,
  origin: z.number(),
  start: z.number().min(0),
  end: z.number().min(0),
  srcEnd: z.number().optional(),
});

export const zTakeGroup = z.object({
  id: z.string().min(1),
  name: z.string().max(64),
  trackId: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  takes: z.record(z.string(), zTake),
  takeOrder: z.array(z.string()),
  comp: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), takeId: z.string().min(1) })),
  crossfade: z.number().min(0).max(MAX_CROSSFADE),
});

export const zTakeGroups = z.record(z.string(), zTakeGroup);

// ── Integrity ─────────────────────────────────────────────────────────

/** Dangling references and broken comps (checkIntegrity calls this). */
export function takesIntegrity(p: Project): string[] {
  const errs: string[] = [];
  for (const g of Object.values(p.takeGroups ?? {})) {
    if (!p.playlist.tracks[g.trackId]) errs.push(`take group ${g.id} on missing track`);
    if (!(g.end > g.start)) errs.push(`take group ${g.id} has an empty span`);
    const ids = Object.keys(g.takes);
    if (g.takeOrder.length !== ids.length || new Set(g.takeOrder).size !== g.takeOrder.length || g.takeOrder.some((id) => !g.takes[id])) {
      errs.push(`take group ${g.id} takeOrder doesn't match its takes`);
    }
    for (const t of Object.values(g.takes)) {
      if (t.source.kind === 'audio' && !p.channels[t.source.channelId]) errs.push(`take ${t.id} plays missing channel ${t.source.channelId}`);
      if (t.source.kind === 'pattern' && !p.patterns[t.source.patternId]) errs.push(`take ${t.id} plays missing pattern ${t.source.patternId}`);
    }
    let last = -Infinity;
    for (const s of g.comp) {
      if (!g.takes[s.takeId]) errs.push(`take group ${g.id} comp uses missing take ${s.takeId}`);
      if (!(s.end > s.start)) errs.push(`take group ${g.id} has an empty comp segment`);
      if (s.start < last) errs.push(`take group ${g.id} comp segments overlap or are unsorted`);
      last = s.end;
    }
  }
  return errs;
}

// ── Lookups ───────────────────────────────────────────────────────────

export function takeGroupsOnTrack(p: Project, trackId: string): TakeGroup[] {
  return Object.values(p.takeGroups ?? {})
    .filter((g) => g.trackId === trackId)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function orderedTakes(g: TakeGroup): Take[] {
  return g.takeOrder.map((id) => g.takes[id]).filter((t): t is Take => !!t);
}

/** Whether a clip on the group's track plays one of its takes (= a comp clip). */
export function isCompClip(g: TakeGroup, c: Clip): boolean {
  if (c.trackId !== g.trackId) return false;
  for (const t of Object.values(g.takes)) {
    if (t.source.kind === 'audio' && c.kind === 'audio' && c.channelId === t.source.channelId) return true;
    if (t.source.kind === 'pattern' && c.kind === 'pattern' && c.patternId === t.source.patternId) return true;
  }
  return false;
}

/** The take a comp clip plays (null = not a comp clip of this group). */
export function takeOfClip(g: TakeGroup, c: Clip): Take | null {
  if (c.trackId !== g.trackId) return null;
  for (const t of Object.values(g.takes)) {
    if (t.source.kind === 'audio' && c.kind === 'audio' && c.channelId === t.source.channelId) return t;
    if (t.source.kind === 'pattern' && c.kind === 'pattern' && c.patternId === t.source.patternId) return t;
  }
  return null;
}

// ── Comp algebra (pure) ───────────────────────────────────────────────

/** Sort, drop empty segments, merge touching segments of the same take. Later segments win overlaps. */
export function normalizeComp(segs: CompSegment[]): CompSegment[] {
  let out: CompSegment[] = [];
  for (const s of segs) if (s.end > s.start) out = paintComp(out, s.start, s.end, s.takeId, false);
  return mergeComp(out);
}

function mergeComp(segs: CompSegment[]): CompSegment[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: CompSegment[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.takeId === s.takeId && prev.end === s.start) prev.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** Use `takeId` for [start, end): splits the segments it cuts, keeps the rest. */
export function paintComp(comp: CompSegment[], start: number, end: number, takeId: string, merge = true): CompSegment[] {
  if (!(end > start)) return merge ? mergeComp(comp) : comp.map((s) => ({ ...s }));
  const out: CompSegment[] = [];
  for (const s of comp) {
    if (s.end <= start || s.start >= end) {
      out.push({ ...s });
      continue;
    }
    if (s.start < start) out.push({ start: s.start, end: start, takeId: s.takeId });
    if (s.end > end) out.push({ start: end, end: s.end, takeId: s.takeId });
  }
  out.push({ start, end, takeId });
  out.sort((a, b) => a.start - b.start);
  return merge ? mergeComp(out) : out;
}

/** Remove [start, end) from the comp (silence there). */
export function eraseComp(comp: CompSegment[], start: number, end: number): CompSegment[] {
  return paintComp(comp, start, end, '\u0000', false).filter((s) => s.takeId !== '\u0000');
}

/**
 * The default comp: the LAST take wherever it has audio, earlier takes only
 * where later ones don't reach (a punch-in that started mid-loop, a last
 * pass stopped halfway). `prefer: 'first'` does the opposite.
 */
export function defaultComp(takes: Take[], prefer: 'last' | 'first' = 'last'): CompSegment[] {
  const order = prefer === 'last' ? [...takes] : [...takes].reverse();
  // Paint the least-preferred first so the preferred ones overwrite it.
  let comp: CompSegment[] = [];
  for (const t of order) comp = paintComp(comp, t.start, t.end, t.id);
  return comp;
}

/** Each segment clamped to its take's recorded range (and the group span); empty ones dropped. */
export function clampComp(g: Pick<TakeGroup, 'takes' | 'start' | 'end'>, comp: CompSegment[]): CompSegment[] {
  const out: CompSegment[] = [];
  for (const s of comp) {
    const t = g.takes[s.takeId];
    if (!t) continue;
    const a = Math.max(s.start, t.start, g.start);
    const b = Math.min(s.end, t.end, g.end);
    if (b > a) out.push({ start: a, end: b, takeId: s.takeId });
  }
  return mergeComp(out);
}

/** Comps equal (same segments in the same order). */
export function sameComp(a: CompSegment[], b: CompSegment[]): boolean {
  return a.length === b.length && a.every((s, i) => s.start === b[i].start && s.end === b[i].end && s.takeId === b[i].takeId);
}

// ── Materialisation (comp → clips) ────────────────────────────────────

export interface CompClipPlan {
  takeId: string;
  start: number;
  length: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * The clips a comp plays: one per segment, with crossfades at the boundaries
 * between touching audio segments of different takes. At a boundary b the
 * incoming clip starts `hIn` early and the outgoing one ends `hOut` late; both
 * fade over hIn + hOut (= the crossfade, centred on b when both sides have
 * audio). Each side is limited by half of the segment it reaches into and by
 * the audio its take has there (the incoming take before b, the outgoing take
 * after b: a last pass that stopped exactly at b gives a one-sided fade);
 * clip starts never go below tick 0 and offsets never below 0.
 */
export function planCompClips(g: Pick<TakeGroup, 'takes' | 'comp' | 'crossfade'>): CompClipPlan[] {
  const segs = g.comp.filter((s) => g.takes[s.takeId] && s.end > s.start);
  // bounds[i] = the boundary before segs[i] (bounds[0] and bounds[n] stay 0).
  const bounds: Array<{ hIn: number; hOut: number }> = Array.from({ length: segs.length + 1 }, () => ({ hIn: 0, hOut: 0 }));
  const X = Math.floor(Math.max(0, g.crossfade));
  for (let i = 1; i < segs.length && X > 0; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    if (a.end !== b.start || a.takeId === b.takeId) continue;
    const ta = g.takes[a.takeId];
    const tb = g.takes[b.takeId];
    if (ta.source.kind !== 'audio' || tb.source.kind !== 'audio') continue;
    const availIn = Math.max(0, Math.min(Math.floor((a.end - a.start) / 2), Math.floor(b.start - tb.origin), Math.floor(b.start)));
    const availOut = Math.max(0, Math.min(Math.floor((b.end - b.start) / 2), ta.srcEnd === undefined ? Infinity : Math.floor(ta.srcEnd - a.end)));
    let hIn = Math.min(Math.floor(X / 2), availIn);
    let hOut = Math.min(Math.floor(X / 2), availOut);
    hOut = Math.min(X - hIn, availOut);
    hIn = Math.min(X - hOut, availIn);
    bounds[i] = { hIn, hOut };
  }
  return segs.map((s, i) => {
    const t = g.takes[s.takeId];
    const before = bounds[i];
    const after = bounds[i + 1];
    const start = Math.round(s.start - before.hIn);
    const end = Math.round(s.end + after.hOut);
    return {
      takeId: s.takeId,
      start,
      length: Math.max(1, end - start),
      offset: Math.max(0, Math.round(start - t.origin)),
      fadeIn: before.hIn + before.hOut,
      fadeOut: after.hIn + after.hOut,
    };
  });
}

/**
 * Rebuild the group's comp clips on its track (draft mutation): removes the
 * clips that play one of its takes there, then places `planCompClips`.
 * Returns the new clip ids in comp order.
 */
export function materializeComp(d: Project, g: TakeGroup, newId: (prefix: string) => string): string[] {
  for (const c of Object.values(d.playlist.clips)) if (isCompClip(g, c)) delete d.playlist.clips[c.id];
  const ids: string[] = [];
  for (const plan of planCompClips(g)) {
    const t = g.takes[plan.takeId];
    const id = newId('clip');
    const base = { id, trackId: g.trackId, start: plan.start, length: plan.length, offset: plan.offset, mute: false, color: null };
    if (t.source.kind === 'audio') {
      d.playlist.clips[id] = { ...base, kind: 'audio', channelId: t.source.channelId, gain: 1, fadeIn: plan.fadeIn, fadeOut: plan.fadeOut };
    } else {
      d.playlist.clips[id] = { ...base, kind: 'pattern', patternId: t.source.patternId };
    }
    ids.push(id);
  }
  return ids;
}

// ── Cleanup when referenced objects go away ───────────────────────────

/**
 * Drop take groups on removed tracks and takes whose channel / pattern was
 * removed (draft mutation; the remove commands call it). A group left with
 * no takes is deleted; its comp loses the removed takes' segments (silence).
 */
export function dropTakeRefs(d: Project, gone: { trackIds?: string[]; channelIds?: string[]; patternIds?: string[] }): void {
  const groups = d.takeGroups;
  if (!groups) return;
  const tracks = new Set(gone.trackIds ?? []);
  const chans = new Set(gone.channelIds ?? []);
  const pats = new Set(gone.patternIds ?? []);
  for (const g of Object.values(groups)) {
    if (tracks.has(g.trackId)) {
      delete groups[g.id];
      continue;
    }
    const dead = Object.values(g.takes).filter((t) => (t.source.kind === 'audio' ? chans.has(t.source.channelId) : pats.has(t.source.patternId)));
    if (!dead.length) continue;
    for (const t of dead) delete g.takes[t.id];
    const deadIds = new Set(dead.map((t) => t.id));
    g.takeOrder = g.takeOrder.filter((id) => !deadIds.has(id));
    g.comp = g.comp.filter((s) => !deadIds.has(s.takeId));
    if (!g.takeOrder.length) delete groups[g.id];
  }
  if (!Object.keys(groups).length) delete d.takeGroups;
}
