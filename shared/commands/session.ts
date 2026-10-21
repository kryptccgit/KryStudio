// Clip launcher (Session view) commands, Wave 12.2 (research/16 §2.1).
// The grid: one column per playlist track, one row per scene, at most one
// launch clip per slot. `project.session` is created lazily on first use.
// Also the bridges between the launcher and the arrangement:
//   session.fromArrangement  playlist sections → scenes
//   session.scenesToSong     a scene order → playlist clips
//   session.capture          the engine's launch recording → playlist clips
// Pure document edits (no I/O); each is ONE undo step.

import { z } from 'zod';
import { defineCommand, must, plural, CommandError, type CommandContext } from './types';
import { patternLength, type Clip, type Project } from '../schema/project';
import {
  emptySession,
  FOLLOW_ACTIONS,
  LAUNCH_MODES,
  LAUNCH_QUANTS,
  MAX_SCENES,
  type FollowRule,
  type LaunchClip,
  type Session,
} from '../schema/launcher';
import { ID_PREFIX } from '../schema/ids';
import { secondsToTicks, ticksPerBar } from '../schema/time';
import { FALLBACK_CLIP_LENGTH } from '../schema/factory';
import { AUDIOCLIP, audioTickBpm } from '../analyzer/tempo';

export const SCENE_PREFIX = 'scn';
export const LAUNCH_CLIP_PREFIX = 'lc';

const NAME_MAX = 64;

// ── Helpers (exported for main / MCP / tests) ─────────────────────────

/** The project's session, created on first use (inside a command draft). */
export function ensureSession(d: Project): Session {
  if (!d.session) d.session = emptySession();
  return d.session;
}

function scene(d: Project, id: string) {
  return must(d.session?.scenes[id], `Scene ${id} not found`);
}

function launchClip(d: Project, id: string): LaunchClip {
  return must(d.session?.clips[id], `Launch clip ${id} not found`);
}

function slotClip(s: Session, trackId: string, sceneId: string): LaunchClip | undefined {
  for (const c of Object.values(s.clips)) if (c.trackId === trackId && c.sceneId === sceneId) return c;
  return undefined;
}

function nextSceneName(s: Session): string {
  const names = new Set(Object.values(s.scenes).map((x) => x.name));
  let i = s.sceneOrder.length + 1;
  while (names.has(`Scene ${i}`)) i++;
  return `Scene ${i}`;
}

function clipName(s: string): string {
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
}

function addSceneTo(d: Project, ctx: CommandContext, opts: { name?: string; color?: string | null; tempo?: number | null; index?: number }): string {
  const s = ensureSession(d);
  if (s.sceneOrder.length >= MAX_SCENES) throw new CommandError(`The launcher holds at most ${MAX_SCENES} scenes`);
  const id = ctx.newId(SCENE_PREFIX);
  s.scenes[id] = { id, name: clipName(opts.name?.trim() || nextSceneName(s)), color: opts.color ?? null, tempo: opts.tempo ?? null };
  s.sceneOrder.splice(Math.min(opts.index ?? s.sceneOrder.length, s.sceneOrder.length), 0, id);
  return id;
}

/** Length in ticks of an audio-clip channel's audio at the current tempo, rounded up to a bar (FALLBACK when unknown). */
export function audioLaunchLength(d: Project, ctx: Pick<CommandContext, 'catalog'>, channelId: string): number {
  const ch = d.channels[channelId];
  const bar = ticksPerBar(d.transport.timeSig);
  const s = ch?.generator.sampleId ? d.samples[ch.generator.sampleId] : undefined;
  if (!ch || !s?.frames || !s.sampleRate) return FALLBACK_CLIP_LENGTH;
  const ticks = secondsToTicks(s.frames / s.sampleRate, audioTickBpm(d, ctx.catalog, ch).bpm);
  return Math.max(bar, Math.ceil(Math.round(ticks) / bar) * bar);
}

/** The source's natural length: the pattern length, or the audio length at the current tempo (rounded up to a bar). */
function sourceLength(d: Project, ctx: CommandContext, c: Pick<LaunchClip, 'kind' | 'patternId' | 'channelId'>): number {
  if (c.kind === 'pattern') return patternLength(must(d.patterns[c.patternId ?? ''], `Pattern ${c.patternId} not found`), d.transport.timeSig);
  return audioLaunchLength(d, ctx, c.channelId ?? '');
}

function audioChannel(d: Project, id: string) {
  const ch = must(d.channels[id], `Channel ${id} not found`);
  if (ch.generator.type !== AUDIOCLIP) throw new CommandError(`${ch.name} is not an audio clip channel: only audio clips (or patterns) can go in a launcher slot`);
  return ch;
}

/** Remove every launch clip matching `pred` (deletion hooks in the track / pattern / channel commands). */
export function removeLaunchClipsWhere(d: Project, pred: (c: LaunchClip) => boolean): number {
  const s = d.session;
  if (!s) return 0;
  let n = 0;
  for (const c of Object.values(s.clips)) {
    if (pred(c)) {
      delete s.clips[c.id];
      n++;
    }
  }
  return n;
}

/** Key-order-independent JSON (for "did anything change"). */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x));
}

// Arg schemas

const zQuant = z.enum(LAUNCH_QUANTS);
const zFollow = z.object({
  action: z.enum(FOLLOW_ACTIONS),
  chance: z.number().min(0).max(1).default(1),
  otherAction: z.enum(FOLLOW_ACTIONS).default('none'),
  afterBars: z.number().positive().max(1024),
});
const zTempo = z.number().min(10).max(999);

function followRule(f: z.infer<typeof zFollow>): FollowRule {
  return { action: f.action, chance: f.chance, otherAction: f.otherAction, afterBars: f.afterBars };
}

// ── Scenes ────────────────────────────────────────────────────────────

export const sessionAddScene = defineCommand({
  id: 'session.addScene',
  label: (a) => `Add scene${a.name ? ` "${a.name}"` : ''}`,
  description: 'Add a scene (a row of the clip launcher). Optional name, color, tempo (launching the scene sets the project tempo; null = keep) and index. Returns its id.',
  args: z.object({ name: z.string().max(NAME_MAX).optional(), color: z.string().nullable().optional(), tempo: zTempo.nullable().optional(), index: z.number().int().min(0).optional() }),
  run(d, a, ctx) {
    return { id: addSceneTo(d, ctx, a) };
  },
});

export const sessionRemoveScene = defineCommand({
  id: 'session.removeScene',
  label: () => 'Delete scene',
  description: 'Delete a scene and every launch clip in its row.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    scene(d, a.id);
    const s = d.session!;
    delete s.scenes[a.id];
    s.sceneOrder = s.sceneOrder.filter((x) => x !== a.id);
    const removed = removeLaunchClipsWhere(d, (c) => c.sceneId === a.id);
    return { removedClips: removed };
  },
});

export const sessionSetScene = defineCommand({
  id: 'session.setScene',
  label: () => 'Edit scene',
  description: 'Rename a scene, change its color, or set its tempo (bpm applied when the scene launches; null = keep the project tempo).',
  args: z.object({ id: z.string(), name: z.string().max(NAME_MAX).optional(), color: z.string().nullable().optional(), tempo: zTempo.nullable().optional() }),
  run(d, a) {
    const sc = scene(d, a.id);
    if (a.name !== undefined) sc.name = a.name;
    if (a.color !== undefined) sc.color = a.color;
    if (a.tempo !== undefined) sc.tempo = a.tempo === null ? null : Math.round(a.tempo * 1000) / 1000;
    return {};
  },
});

export const sessionMoveScene = defineCommand({
  id: 'session.moveScene',
  label: () => 'Reorder scenes',
  description: 'Move a scene to a new row (0-based index).',
  args: z.object({ id: z.string(), toIndex: z.number().int().min(0) }),
  run(d, a) {
    scene(d, a.id);
    const s = d.session!;
    const order = s.sceneOrder.filter((x) => x !== a.id);
    order.splice(Math.min(a.toIndex, order.length), 0, a.id);
    s.sceneOrder = order;
    return {};
  },
});

// ── Launch clips ──────────────────────────────────────────────────────

const zClipFields = {
  name: z.string().max(NAME_MAX).optional(),
  color: z.string().nullable().optional(),
  length: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
  loop: z.boolean().optional(),
  launchMode: z.enum(LAUNCH_MODES).optional(),
  quantize: zQuant.optional(),
  follow: zFollow.optional(),
  gain: z.number().min(0).max(4).optional(),
};

export const sessionSetClip = defineCommand({
  id: 'session.setClip',
  label: () => 'Set launch clip',
  description:
    'Create or replace the launch clip in a slot (trackId × sceneId) from a pattern {patternId} or an audio clip channel {channelId}. Defaults: length = the pattern length (or the audio length at the current tempo, rounded up to a bar), offset 0, loop on, launchMode trigger, color null (source color), quantize = the session\'s. A replaced slot keeps its clip id. Returns { id, replaced }.',
  args: z.object({ trackId: z.string(), sceneId: z.string(), patternId: z.string().optional(), channelId: z.string().optional(), ...zClipFields }),
  run(d, a, ctx) {
    must(d.playlist.tracks[a.trackId], `Track ${a.trackId} not found`);
    scene(d, a.sceneId);
    if (!!a.patternId === !!a.channelId) throw new CommandError('A launch clip needs exactly one source: a pattern or an audio clip channel');
    const s = ensureSession(d);
    const old = slotClip(s, a.trackId, a.sceneId);
    const id = old?.id ?? ctx.newId(LAUNCH_CLIP_PREFIX);
    const c: LaunchClip = { id, trackId: a.trackId, sceneId: a.sceneId, kind: 'pattern', color: a.color ?? null, length: 1, offset: a.offset ?? 0, loop: a.loop ?? true, launchMode: a.launchMode ?? 'trigger' };
    if (a.patternId) {
      c.patternId = must(d.patterns[a.patternId], `Pattern ${a.patternId} not found`).id;
    } else {
      c.kind = 'audio';
      c.channelId = audioChannel(d, a.channelId!).id;
      c.gain = a.gain ?? 1;
    }
    c.length = a.length ?? sourceLength(d, ctx, c);
    if (a.name) c.name = a.name;
    if (a.quantize) c.quantize = a.quantize;
    if (a.follow) c.follow = followRule(a.follow);
    if (!old || canonical(old) !== canonical(c)) s.clips[id] = c; // an identical slot is not an edit
    return { id, replaced: !!old };
  },
});

export const sessionUpdateClip = defineCommand({
  id: 'session.updateClip',
  label: () => 'Edit launch clip',
  description:
    'Edit a launch clip: name (null = the source name), color, length / offset (ticks), loop, launchMode (trigger | gate | toggle | repeat), quantize (null = the session\'s), follow {action, chance, otherAction, afterBars} (null = none), gain (audio).',
  args: z.object({
    id: z.string(),
    name: z.string().max(NAME_MAX).nullable().optional(),
    color: z.string().nullable().optional(),
    length: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    loop: z.boolean().optional(),
    launchMode: z.enum(LAUNCH_MODES).optional(),
    quantize: zQuant.nullable().optional(),
    follow: zFollow.nullable().optional(),
    gain: z.number().min(0).max(4).optional(),
  }),
  run(d, a) {
    const c = launchClip(d, a.id);
    if (a.name !== undefined) {
      if (a.name) c.name = a.name;
      else delete c.name;
    }
    if (a.color !== undefined) c.color = a.color;
    if (a.length !== undefined) c.length = a.length;
    if (a.offset !== undefined) c.offset = a.offset;
    if (a.loop !== undefined) c.loop = a.loop;
    if (a.launchMode !== undefined) c.launchMode = a.launchMode;
    if (a.quantize !== undefined) {
      if (a.quantize) c.quantize = a.quantize;
      else delete c.quantize;
    }
    if (a.follow !== undefined) {
      if (a.follow) c.follow = followRule(a.follow);
      else delete c.follow;
    }
    if (a.gain !== undefined) {
      if (c.kind !== 'audio') throw new CommandError('Only audio launch clips have a gain');
      c.gain = a.gain;
    }
    return {};
  },
});

export const sessionRemoveClip = defineCommand({
  id: 'session.removeClip',
  label: (a) => (a.ids && a.ids.length > 1 ? `Delete ${plural(a.ids.length, 'launch clip')}` : 'Delete launch clip'),
  description: 'Delete launch clips by id ({id} or {ids}).',
  args: z.object({ id: z.string().optional(), ids: z.array(z.string()).max(4096).optional() }),
  run(d, a) {
    const ids = [...(a.id ? [a.id] : []), ...(a.ids ?? [])];
    if (!ids.length) throw new CommandError('Say which launch clip to delete');
    for (const id of ids) launchClip(d, id);
    for (const id of ids) delete d.session!.clips[id];
    return {};
  },
});

export const sessionMoveClip = defineCommand({
  id: 'session.moveClip',
  label: (a) => (a.copy ? 'Copy launch clip' : 'Move launch clip'),
  description: 'Move (or with copy:true, duplicate) a launch clip to another slot (trackId × sceneId). A clip already in the target slot is replaced. Returns the id of the clip now in the target slot.',
  args: z.object({ id: z.string(), trackId: z.string(), sceneId: z.string(), copy: z.boolean().default(false) }),
  run(d, a, ctx) {
    const c = launchClip(d, a.id);
    must(d.playlist.tracks[a.trackId], `Track ${a.trackId} not found`);
    scene(d, a.sceneId);
    const s = d.session!;
    if (c.trackId === a.trackId && c.sceneId === a.sceneId) {
      if (a.copy) throw new CommandError('Copy the clip to a different slot');
      return { id: c.id };
    }
    const occupant = slotClip(s, a.trackId, a.sceneId);
    if (occupant) delete s.clips[occupant.id];
    if (a.copy) {
      const id = ctx.newId(LAUNCH_CLIP_PREFIX);
      const { follow, ...rest } = c;
      s.clips[id] = { ...rest, ...(follow ? { follow: { ...follow } } : {}), id, trackId: a.trackId, sceneId: a.sceneId };
      return { id };
    }
    c.trackId = a.trackId;
    c.sceneId = a.sceneId;
    return { id: c.id };
  },
});

export const sessionSetQuantize = defineCommand({
  id: 'session.setQuantize',
  label: (a) => `Launch quantize ${a.quantize}`,
  description: `Set the global launch quantize: when a launch takes effect (${LAUNCH_QUANTS.join(', ')}). Default 1bar.`,
  args: z.object({ quantize: zQuant }),
  run(d, a) {
    ensureSession(d).quantize = a.quantize;
    return {};
  },
});

// ── Playlist clip surgery (capture, scenesToSong) ─────────────────────

/** Clear [start, end) on a track: pattern / audio clips inside are removed, crossing ones trimmed or split. */
export function clearTrackSpan(d: Project, trackId: string, start: number, end: number, ctx: CommandContext): void {
  if (end <= start) return;
  for (const c of Object.values(d.playlist.clips)) {
    if (c.trackId !== trackId || (c.kind !== 'pattern' && c.kind !== 'audio')) continue;
    const cs = c.start;
    const ce = c.start + c.length;
    if (ce <= start || cs >= end) continue;
    if (cs >= start && ce <= end) {
      delete d.playlist.clips[c.id];
    } else if (cs < start && ce > end) {
      const id = ctx.newId(ID_PREFIX.clip);
      const right: Clip = { ...c, id, start: end, length: ce - end, offset: c.offset + (end - cs) };
      if (c.kind === 'audio') {
        right.fadeIn = 0;
        right.fadeOut = Math.min(c.fadeOut ?? 0, right.length);
      }
      d.playlist.clips[id] = right;
      c.length = start - cs;
      if (c.kind === 'audio') {
        c.fadeOut = 0;
        c.fadeIn = Math.min(c.fadeIn ?? 0, c.length);
      }
    } else if (cs < start) {
      c.length = start - cs;
      if (c.kind === 'audio') {
        c.fadeOut = 0;
        c.fadeIn = Math.min(c.fadeIn ?? 0, c.length);
      }
    } else {
      const cut = end - cs;
      c.start = end;
      c.offset += cut;
      c.length -= cut;
      if (c.kind === 'audio') {
        c.fadeIn = 0;
        c.fadeOut = Math.min(c.fadeOut ?? 0, c.length);
      }
    }
  }
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * Write what launch clip `lc` plays over [start, end) on `trackId` as playlist clips. `srcPos` = ticks into the
 * source at `start` (absent = the clip's own offset, i.e. launched at `start`). A looping clip wraps at
 * offset + length; a pattern clip whose loop is whole pattern lengths becomes ONE playlist clip (playlist pattern
 * clips loop by themselves), anything else is tiled one loop pass per clip. Returns the new clip ids.
 */
export function writeLaunchSpan(d: Project, lc: LaunchClip, trackId: string, start: number, end: number, srcPos: number | undefined, ctx: CommandContext): string[] {
  const ids: string[] = [];
  if (end <= start) return ids;
  const L = Math.max(1, lc.length);
  const loopPos = srcPos === undefined ? 0 : lc.loop ? mod(srcPos - lc.offset, L) : Math.max(0, Math.min(L, srcPos - lc.offset));
  const place = (at: number, length: number, offset: number): void => {
    const id = ctx.newId(ID_PREFIX.clip);
    const c: Clip = { id, trackId, kind: lc.kind, start: at, length, offset, mute: false, color: lc.color };
    if (lc.kind === 'pattern') c.patternId = lc.patternId;
    else {
      c.channelId = lc.channelId;
      c.gain = lc.gain ?? 1;
      c.fadeIn = 0;
      c.fadeOut = 0;
    }
    d.playlist.clips[id] = c;
    ids.push(id);
  };
  if (lc.kind === 'pattern') {
    const pat = d.patterns[lc.patternId ?? ''];
    if (!pat) return ids;
    const pl = patternLength(pat, d.transport.timeSig);
    if (lc.loop && mod(lc.offset, pl) === 0 && L % pl === 0) {
      place(start, end - start, mod(lc.offset + loopPos, pl));
      return ids;
    }
  }
  if (!lc.loop) {
    const len = Math.min(end - start, L - loopPos);
    if (len >= 1) place(start, len, lc.offset + loopPos);
    return ids;
  }
  let t = start;
  let pos = loopPos;
  while (t < end) {
    const len = Math.min(end - t, L - pos);
    place(t, len, lc.offset + pos);
    t += len;
    pos = 0;
  }
  return ids;
}

// ── Session ⇄ arrangement ─────────────────────────────────────────────

const zEntry = z.object({
  trackId: z.string(),
  clipId: z.string(),
  startTick: z.number().min(0),
  endTick: z.number().min(0),
  offset: z.number().min(0),
});

export const sessionCapture = defineCommand({
  id: 'session.capture',
  label: (a) => `Record ${plural(a.entries.length, 'launch')} into the playlist`,
  description:
    "Write launch-recorded spans ({trackId, clipId, startTick, endTick, offset}) into the playlist: on each span the track's pattern / audio clips are removed, trimmed or split (automation clips stay), then the launch clip's source is placed with the recorded loop position. Spans of clips or tracks deleted since are skipped. Switches to song mode when anything was placed. Returns { placed, spans, skipped }.",
  args: z.object({ entries: z.array(zEntry).max(20_000) }),
  run(d, a, ctx) {
    let placed = 0;
    let spans = 0;
    let skipped = 0;
    const entries = [...a.entries].sort((x, y) => x.startTick - y.startTick);
    for (const e of entries) {
      const lc = d.session?.clips[e.clipId];
      const start = Math.max(0, Math.round(e.startTick));
      const end = Math.round(e.endTick);
      const sourceOk = lc && (lc.kind === 'pattern' ? !!d.patterns[lc.patternId ?? ''] : !!d.channels[lc.channelId ?? '']);
      if (!lc || !sourceOk || !d.playlist.tracks[e.trackId] || end <= start) {
        skipped++;
        continue;
      }
      clearTrackSpan(d, e.trackId, start, end, ctx);
      placed += writeLaunchSpan(d, lc, e.trackId, start, end, Math.round(e.offset), ctx).length;
      spans++;
    }
    // The capture IS the arrangement now: Play should play it, not the active pattern.
    if (placed > 0) d.transport.mode = 'song';
    return { placed, spans, skipped };
  },
});

export const sessionFromArrangement = defineCommand({
  id: 'session.fromArrangement',
  label: () => 'Scenes from arrangement',
  description:
    "Turn the arrangement into scenes: one scene per marker section (named after the marker; a section before the first marker becomes \"Start\" when it has clips), or every `barsPerScene` bars (default 8) when there are no markers. In each section, every track's pattern / audio clip that covers the section start becomes that track's launch clip (length = the section, capped at the clip's end; the clip's offset is kept). Scenes are appended after existing ones. Returns { sceneIds, clips }.",
  args: z.object({ barsPerScene: z.number().int().min(1).max(256).default(8) }),
  run(d, a, ctx) {
    const bar = ticksPerBar(d.transport.timeSig);
    const clips = Object.values(d.playlist.clips).filter((c) => (c.kind === 'pattern' || c.kind === 'audio') && !c.mute);
    const songEnd = clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
    if (songEnd <= 0) throw new CommandError('The playlist has no pattern or audio clips to turn into scenes');
    const sections: Array<{ name: string; start: number; end: number }> = [];
    const markers = Object.values(d.playlist.markers)
      .filter((m) => m.tick < songEnd)
      .sort((x, y) => x.tick - y.tick || x.name.localeCompare(y.name));
    if (markers.length) {
      const first = markers[0].tick;
      if (first > 0 && clips.some((c) => c.start < first)) sections.push({ name: 'Start', start: 0, end: first });
      markers.forEach((m, i) => {
        const end = i + 1 < markers.length ? markers[i + 1].tick : Math.max(songEnd, m.tick + bar);
        if (end > m.tick) sections.push({ name: m.name.trim() || `Section ${i + 1}`, start: m.tick, end });
      });
    } else {
      const step = a.barsPerScene * bar;
      for (let t = 0; t < songEnd; t += step) {
        const b0 = Math.round(t / bar) + 1;
        sections.push({ name: `Bars ${b0}-${b0 + a.barsPerScene - 1}`, start: t, end: t + step });
      }
    }
    const s = ensureSession(d);
    if (s.sceneOrder.length + sections.length > MAX_SCENES) {
      throw new CommandError(`That makes ${sections.length} scenes, more than the launcher's ${MAX_SCENES}${markers.length ? '' : ': use more bars per scene'}`);
    }
    const sceneIds: string[] = [];
    let made = 0;
    for (const sec of sections) {
      const sceneId = addSceneTo(d, ctx, { name: sec.name });
      sceneIds.push(sceneId);
      for (const trackId of d.playlist.trackOrder) {
        const c = clips
          .filter((x) => x.trackId === trackId && x.start <= sec.start && x.start + x.length > sec.start)
          .sort((x, y) => y.start - x.start || x.id.localeCompare(y.id))[0];
        if (!c) continue;
        const into = sec.start - c.start;
        const length = Math.max(1, Math.min(sec.end, c.start + c.length) - sec.start);
        const id = ctx.newId(LAUNCH_CLIP_PREFIX);
        const lc: LaunchClip = { id, trackId, sceneId, kind: c.kind as 'pattern' | 'audio', color: c.color, length, offset: c.offset + into, loop: true, launchMode: 'trigger' };
        if (c.kind === 'pattern') {
          lc.patternId = c.patternId;
          const pat = d.patterns[c.patternId ?? ''];
          if (pat) lc.offset = mod(lc.offset, patternLength(pat, d.transport.timeSig));
        } else {
          lc.channelId = c.channelId;
          lc.gain = c.gain ?? 1;
        }
        s.clips[id] = lc;
        made++;
      }
    }
    return { sceneIds, clips: made };
  },
});

export const sessionScenesToSong = defineCommand({
  id: 'session.scenesToSong',
  label: (a) => `${plural(a.order.length, 'scene')} to song`,
  description:
    'Write a scene order into the playlist: each {sceneId, bars} plays for that many bars, one after another, starting at song tick `at` (default: the end of the arrangement, rounded up to a bar). On every track with launch clips in the order, the span is cleared first (clips removed / trimmed / split), then each scene\'s clips are placed (looping clips repeat to fill the span; one-shot clips play once). Returns { clips, start, end }.',
  args: z.object({ order: z.array(z.object({ sceneId: z.string(), bars: z.number().int().min(1).max(1024) })).min(1).max(1024), at: z.number().int().min(0).optional() }),
  run(d, a, ctx) {
    const bar = ticksPerBar(d.transport.timeSig);
    for (const o of a.order) scene(d, o.sceneId);
    const s = d.session!;
    let start = a.at;
    if (start === undefined) {
      const end = Object.values(d.playlist.clips).reduce((m, c) => Math.max(m, c.start + c.length), 0);
      start = Math.ceil(end / bar) * bar;
    }
    const sceneSet = new Set(a.order.map((o) => o.sceneId));
    const tracks = new Set(Object.values(s.clips).filter((c) => sceneSet.has(c.sceneId) && d.playlist.tracks[c.trackId]).map((c) => c.trackId));
    let t = start;
    let placed = 0;
    for (const o of a.order) {
      const end = t + o.bars * bar;
      for (const trackId of d.playlist.trackOrder) {
        if (!tracks.has(trackId)) continue;
        clearTrackSpan(d, trackId, t, end, ctx);
        const lc = slotClip(s, trackId, o.sceneId);
        if (lc) placed += writeLaunchSpan(d, lc, trackId, t, end, undefined, ctx).length;
      }
      t = end;
    }
    return { clips: placed, start, end: t };
  },
});

export const SESSION_COMMANDS = [
  sessionAddScene,
  sessionRemoveScene,
  sessionSetScene,
  sessionMoveScene,
  sessionSetClip,
  sessionUpdateClip,
  sessionRemoveClip,
  sessionMoveClip,
  sessionSetQuantize,
  sessionFromArrangement,
  sessionScenesToSong,
  sessionCapture,
];
