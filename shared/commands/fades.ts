// Audio-clip fades and crossfades (Wave 12.2b). The engine plays a clip's
// fadeIn / fadeOut (ticks) as LINEAR gain ramps from the clip's start / to
// its end (engine core.rs ClipEnv); the Playlist draws the same lines.
//
// Crossfade with the previous clip on the same track:
//   - overlapping clips: each fades over the overlap;
//   - touching clips (a split): the later clip is extended back over the cut
//     by the crossfade length (its audio before the cut plays, fading in)
//     while the earlier one fades out; when the later clip has no audio
//     before the cut, the earlier clip is extended past it instead (if its
//     file is long enough); else both fade at the cut (a short dip).

import { z } from 'zod';
import { defineCommand, must, plural, CommandError } from './types';
import type { Clip, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';
import { PPQ, secondsToTicks } from '../schema/time';
import { audioTickBpm } from '../analyzer/tempo';

/** Clamp fades into a clip: each >= 0 and together at most the clip length (`keep` wins when they collide). */
export function clampFades(length: number, fadeIn: number, fadeOut: number, keep: 'in' | 'out' = 'in'): { fadeIn: number; fadeOut: number } {
  const len = Math.max(1, Math.round(length));
  let fi = Math.max(0, Math.round(Number.isFinite(fadeIn) ? fadeIn : 0));
  let fo = Math.max(0, Math.round(Number.isFinite(fadeOut) ? fadeOut : 0));
  if (keep === 'in') {
    fi = Math.min(fi, len);
    fo = Math.min(fo, len - fi);
  } else {
    fo = Math.min(fo, len);
    fi = Math.min(fi, len - fo);
  }
  return { fadeIn: fi, fadeOut: fo };
}

/** The clip's gain envelope at a song tick (0..1 × clip gain), exactly as the engine computes it. */
export function fadeGainAt(c: Pick<Clip, 'start' | 'length' | 'fadeIn' | 'fadeOut' | 'gain'>, tick: number): number {
  let g = c.gain ?? 1;
  const fi = c.fadeIn ?? 0;
  const fo = c.fadeOut ?? 0;
  const end = c.start + c.length;
  if (fi > 0) g *= Math.min(1, Math.max(0, (tick - c.start) / fi));
  if (fo > 0) g *= Math.min(1, Math.max(0, (end - tick) / fo));
  return g;
}

/** Length of a clip's source audio in ticks at its channel's current tempo mapping; null when unknown (no frames, warped). */
export function sourceTicks(p: Project, catalog: PluginCatalog, c: Clip): number | null {
  const ch = c.channelId ? p.channels[c.channelId] : undefined;
  if (!ch || (ch.generator.warp?.markers.length ?? 0) >= 2) return null;
  const s = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
  if (!s?.frames || !s.sampleRate) return null;
  return Math.round(secondsToTicks(s.frames / s.sampleRate, audioTickBpm(p, catalog, ch).bpm));
}

export type CrossfadeKind = 'overlap' | 'extend-next' | 'extend-prev' | 'dip';

export interface CrossfadePlan {
  kind: CrossfadeKind;
  length: number;
  prev: { id: string; length: number; fadeOut: number; fadeIn: number };
  next: { id: string; start: number; offset: number; length: number; fadeIn: number; fadeOut: number };
}

/** The default crossfade: an eighth note. */
export const DEFAULT_CROSSFADE = PPQ / 2;

/**
 * Plan a crossfade between `prev` (earlier) and `next` on one track. `want` = the crossfade length for touching
 * clips (overlaps always use the overlap). `prevSource` = prev's source length in ticks (null = unknown).
 * Returns a human reason instead when they can't be crossfaded.
 */
export function crossfadePlan(prev: Clip, next: Clip, want: number, prevSource: number | null): CrossfadePlan | string {
  if (prev.kind !== 'audio' || next.kind !== 'audio') return 'Crossfades are for audio clips';
  if (prev.trackId !== next.trackId) return 'The clips are on different tracks';
  if (prev.start >= next.start) return 'The first clip must start before the second';
  const prevEnd = prev.start + prev.length;
  const overlap = prevEnd - next.start;
  const cap = (x: number) => Math.max(1, Math.round(x));
  if (overlap > 0) {
    const L = cap(Math.min(overlap, prev.length, next.length));
    return finish('overlap', L, prev, next, { length: prev.length }, { start: next.start, offset: next.offset, length: next.length });
  }
  if (overlap < 0) return `The clips don't touch (a gap of ${-overlap} ticks): move them together first`;
  // Touching: room limits so neither clip is all fade.
  let L = cap(Math.min(Math.max(1, want), prev.length / 2, next.length / 2));
  if (next.offset >= 1) {
    L = Math.min(L, next.offset);
    return finish('extend-next', L, prev, next, { length: prev.length }, { start: next.start - L, offset: next.offset - L, length: next.length + L });
  }
  const after = prevSource === null ? 0 : prevSource - (prev.offset + prev.length);
  if (after >= 1) {
    L = Math.min(L, after);
    return finish('extend-prev', L, prev, next, { length: prev.length + L }, { start: next.start, offset: next.offset, length: next.length });
  }
  return finish('dip', L, prev, next, { length: prev.length }, { start: next.start, offset: next.offset, length: next.length });
}

function finish(kind: CrossfadeKind, L: number, prev: Clip, next: Clip, p: { length: number }, n: { start: number; offset: number; length: number }): CrossfadePlan {
  const pf = clampFades(p.length, prev.fadeIn ?? 0, L, 'out');
  const nf = clampFades(n.length, L, next.fadeOut ?? 0, 'in');
  return {
    kind,
    length: L,
    prev: { id: prev.id, length: p.length, fadeIn: pf.fadeIn, fadeOut: pf.fadeOut },
    next: { id: next.id, ...n, fadeIn: nf.fadeIn, fadeOut: nf.fadeOut },
  };
}

/** The audio clip right before `c` on its track that touches or overlaps it (latest start wins). */
export function previousTouching(p: Project, c: Clip): Clip | null {
  let best: Clip | null = null;
  for (const o of Object.values(p.playlist.clips)) {
    if (o.id === c.id || o.kind !== 'audio' || o.trackId !== c.trackId || o.start >= c.start) continue;
    if (o.start + o.length < c.start) continue;
    if (!best || o.start > best.start) best = o;
  }
  return best;
}

export const playlistSetFades = defineCommand({
  id: 'playlist.setFades',
  label: (a) => (a.updates.length === 1 ? 'Clip fade' : `Fade ${plural(a.updates.length, 'clip')}`),
  description: 'Set fade-in / fade-out lengths (ticks, linear gain ramps) on audio clips. Fades are clamped so fade-in + fade-out never exceed the clip. Returns how many were clamped.',
  args: z.object({ updates: z.array(z.object({ id: z.string(), fadeIn: z.number().int().min(0).optional(), fadeOut: z.number().int().min(0).optional() })).min(1).max(2000) }),
  run(d, a) {
    let clamped = 0;
    for (const u of a.updates) {
      const c = must(d.playlist.clips[u.id], `Clip ${u.id} not found`);
      if (c.kind !== 'audio') throw new CommandError('Only audio clips have fades');
      const wantIn = u.fadeIn ?? c.fadeIn ?? 0;
      const wantOut = u.fadeOut ?? c.fadeOut ?? 0;
      const f = clampFades(c.length, wantIn, wantOut, u.fadeOut !== undefined && u.fadeIn === undefined ? 'out' : 'in');
      if (f.fadeIn !== wantIn || f.fadeOut !== wantOut) clamped++;
      c.fadeIn = f.fadeIn;
      c.fadeOut = f.fadeOut;
    }
    return { clamped };
  },
});

export const playlistCrossfade = defineCommand({
  id: 'playlist.crossfade',
  label: () => 'Crossfade clips',
  description:
    'Crossfade an audio clip with the audio clip right before it on the same track (they must touch or overlap). Overlaps fade over the overlap; touching clips (a split) overlap by `length` ticks (default an eighth note): the later clip reaches back over the cut when it has audio there, else the earlier one reaches past it, else both fade at the cut. Returns { kind, length, prevId }.',
  args: z.object({ id: z.string(), length: z.number().int().min(1).max(PPQ * 64).optional() }),
  run(d, a, ctx) {
    const next = must(d.playlist.clips[a.id], `Clip ${a.id} not found`);
    if (next.kind !== 'audio') throw new CommandError('Crossfades are for audio clips');
    const prev = previousTouching(d, next);
    if (!prev) throw new CommandError('No audio clip touches this one from the left on its track');
    const plan = crossfadePlan(prev, next, a.length ?? DEFAULT_CROSSFADE, sourceTicks(d, ctx.catalog, prev));
    if (typeof plan === 'string') throw new CommandError(plan);
    const p = d.playlist.clips[prev.id];
    p.length = plan.prev.length;
    p.fadeIn = plan.prev.fadeIn;
    p.fadeOut = plan.prev.fadeOut;
    next.start = plan.next.start;
    next.offset = plan.next.offset;
    next.length = plan.next.length;
    next.fadeIn = plan.next.fadeIn;
    next.fadeOut = plan.next.fadeOut;
    return { kind: plan.kind, length: plan.length, prevId: prev.id };
  },
});

export const FADE_COMMANDS = [playlistSetFades, playlistCrossfade];
