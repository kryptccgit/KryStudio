// Clip launcher (Session view) tools: build_session edits the grid through the
// session.* commands (one history group per call); launch drives playback
// through the main-process launcher runtime (electron/session).

import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Project } from '@shared/schema/project';
import { FOLLOW_ACTIONS, LAUNCH_MODES, LAUNCH_QUANTS, type LaunchClip, type Session } from '@shared/schema/launcher';
import { ticksPerBar } from '@shared/schema/time';
import { AUDIOCLIP } from '@shared/analyzer/tempo';
import { defineTool, fail, type RunCtx } from './types';
import { findChannel, findPattern, fmtBars, norm, plural, safeName } from './util';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zTrackRef = z.union([z.number().int().min(1), z.string().min(1).max(64)]).describe('Playlist track: 1-based number, name or id (a new name renames the first empty default track, else adds one).');
const zSceneRef = z.union([z.number().int().min(1), z.string().min(1).max(64)]).describe('Scene: 1-based row, name or id.');

const zFollow = z.object({
  action: z.enum(FOLLOW_ACTIONS).describe('stop | again | next | previous | first | last | any | other | none'),
  after_bars: z.number().positive().max(1024),
  chance: z.number().min(0).max(1).default(1).describe('Probability of action (else other_action).'),
  other_action: z.enum(FOLLOW_ACTIONS).default('none'),
});

const zSlot = z.object({
  track: zTrackRef,
  pattern: z.string().max(64).optional().describe('Pattern name or id.'),
  audio: z.string().max(200).optional().describe('Audio clip channel name or id.'),
  remove: z.boolean().optional().describe('true = empty this slot.'),
  name: z.string().max(64).optional(),
  length_bars: z.number().positive().max(1024).optional().describe('Loop length (default: the pattern / audio length).'),
  offset_bars: z.number().min(0).max(1024).optional().describe('Where the loop starts in the source.'),
  loop: z.boolean().optional().describe('false = play once, then the track stops.'),
  launch_mode: z.enum(LAUNCH_MODES).optional().describe('trigger (default) | gate | toggle | repeat'),
  quantize: z.enum(LAUNCH_QUANTS).optional().describe("This clip's launch quantize (default: the session's)."),
  follow: zFollow.optional(),
});

// ── Lookups ───────────────────────────────────────────────────────────

export function findScene(p: Project, ref: string | number): string {
  const s = p.session;
  const order = s?.sceneOrder ?? [];
  if (!s || !order.length) fail('The launcher has no scenes yet: build_session adds some.');
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = order[Number(ref) - 1];
    if (id) return id;
    fail(`Scene ${ref} doesn't exist (1..${order.length})`);
  }
  const r = String(ref);
  if (s.scenes[r]) return r;
  const exact = order.filter((id) => s.scenes[id].name.toLowerCase() === r.toLowerCase().trim());
  if (exact.length === 1) return exact[0];
  const loose = order.filter((id) => norm(s.scenes[id].name) === norm(r));
  if (loose.length === 1) return loose[0];
  if (exact.length > 1 || loose.length > 1) fail(`"${safeName(r)}" matches several scenes. Use the row number or id.`);
  fail(`No scene "${safeName(r)}". Scenes: ${order.map((id, i) => `${i + 1}. ${safeName(s.scenes[id].name)}`).join(', ')}`);
}

/** A track by number / id / name; an unknown NAME creates a track (reported in `created`). */
function trackFor(ctx: RunCtx, deps: MainDeps, ref: string | number, created: string[]): string {
  const p = deps.doc.project;
  const order = p.playlist.trackOrder;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = order[Number(ref) - 1];
    if (id) return id;
    fail(`Playlist track ${ref} doesn't exist (1..${order.length})`);
  }
  const r = String(ref).trim();
  if (p.playlist.tracks[r]) return r;
  const hit = order.filter((id) => p.playlist.tracks[id].name.toLowerCase() === r.toLowerCase());
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) fail(`Several playlist tracks are called "${safeName(r)}": use the track number.`);
  // Reuse the first untouched default lane ("Track 3": no playlist or launch clips) before adding a track,
  // so a new project's live set starts in column 1 instead of after 16 empty tracks.
  const used = new Set([...Object.values(p.playlist.clips).map((c) => c.trackId), ...Object.values(p.session?.clips ?? {}).map((c) => c.trackId)]);
  const spare = order.find((tid) => !used.has(tid) && /^Track \d+$/.test(p.playlist.tracks[tid].name));
  if (spare) {
    ctx.exec('playlist.setTrack', { id: spare, name: r.slice(0, 64) });
    created.push(r);
    return spare;
  }
  const id = ctx.exec<{ id: string }>('playlist.addTrack', { name: r.slice(0, 64) }).id;
  created.push(r);
  return id;
}

function clipName(p: Project, c: LaunchClip): string {
  if (c.name) return c.name;
  return (c.kind === 'pattern' ? p.patterns[c.patternId ?? '']?.name : p.channels[c.channelId ?? '']?.name) ?? '?';
}

/** Compact grid summary for results and get_project. */
export function sessionSummary(p: Project, maxScenes = 32): string {
  const s: Session | undefined = p.session;
  if (!s || (!s.sceneOrder.length && !Object.keys(s.clips).length)) return 'Session (clip launcher): empty.';
  const ts = p.transport.timeSig;
  const clips = Object.values(s.clips);
  const tracks = new Set(clips.map((c) => c.trackId));
  const lines = [`Session (clip launcher): ${plural(s.sceneOrder.length, 'scene')} × ${plural(tracks.size, 'track')} with clips, ${plural(clips.length, 'launch clip')} · quantize ${s.quantize}`];
  s.sceneOrder.slice(0, maxScenes).forEach((sid, i) => {
    const sc = s.scenes[sid];
    const row = p.playlist.trackOrder
      .map((tid, ti) => {
        const c = clips.find((x) => x.trackId === tid && x.sceneId === sid);
        if (!c) return null;
        const extra = [
          c.kind === 'audio' ? 'audio' : '',
          c.loop ? '' : 'once',
          c.launchMode !== 'trigger' ? c.launchMode : '',
          c.quantize ? `q ${c.quantize}` : '',
          c.follow && c.follow.action !== 'none' ? `then ${c.follow.action}${c.follow.chance < 1 ? ` ${Math.round(c.follow.chance * 100)}%` : ''} after ${c.follow.afterBars} bar${c.follow.afterBars === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        return `T${ti + 1} "${safeName(clipName(p, c), 30)}" ${fmtBars(c.length, ts)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
      })
      .filter(Boolean);
    lines.push(`  ${i + 1}. "${safeName(sc.name, 40)}" (${sid})${sc.tempo !== null ? ` ${sc.tempo} bpm` : ''}: ${row.length ? row.join(' · ') : 'no clips (launching it stops every track)'}`);
  });
  if (s.sceneOrder.length > maxScenes) lines.push(`  … ${s.sceneOrder.length - maxScenes} more scenes`);
  return lines.join('\n');
}

// ── build_session ─────────────────────────────────────────────────────

export const buildSession = defineTool({
  name: 'build_session',
  title: 'Build a live set (clip launcher)',
  kind: 'write',
  description:
    'Build or edit the clip launcher (Session view, a live set): scenes are rows, playlist tracks are columns, each slot holds a looping pattern or audio clip the user (or launch) can fire live. In one call: clear (remove every scene first), from_arrangement (one scene per marker section, or every bars_per_scene bars; each track\'s clip there becomes its slot), quantize (when launches take effect, default 1bar), and scenes: a new scene per entry (or scene: an existing one to edit) with name, tempo (set on launch) and clips [{track, pattern | audio, length_bars, offset_bars, loop, launch_mode, quantize, follow {action, after_bars, chance, other_action}} | {track, remove:true}]. A track name that does not exist yet becomes a new playlist track. Example: {"scenes":[{"name":"Intro","clips":[{"track":"Drums","pattern":"Beat A"},{"track":"Keys","pattern":"Chords"}]},{"name":"Drop","tempo":128,"clips":[{"track":"Drums","pattern":"Beat B","follow":{"action":"next","after_bars":8}}]}]}',
  input: z.object({
    clear: z.boolean().default(false).describe('Remove every existing scene (and its clips) first.'),
    from_arrangement: z.union([z.boolean(), z.object({ bars_per_scene: z.number().int().min(1).max(256).optional() })]).optional(),
    quantize: z.enum(LAUNCH_QUANTS).optional(),
    scenes: z
      .array(
        z.object({
          scene: zSceneRef.optional().describe('Edit this existing scene instead of adding one.'),
          name: z.string().max(64).optional(),
          tempo: z.number().min(10).max(999).nullable().optional(),
          color: z.string().max(16).nullable().optional(),
          clips: z.array(zSlot).max(64).default([]),
        }),
      )
      .max(128)
      .default([]),
    to_song: z
      .object({
        scenes: z.array(z.object({ scene: zSceneRef, bars: z.number().int().min(1).max(1024) })).min(1).max(1024).describe('Scene order, each played for that many bars.'),
        at_bar: z.number().int().min(1).max(100000).optional().describe('First song bar (default: right after the arrangement).'),
      })
      .optional()
      .describe('Write a scene order into the playlist (the live set → a song), after the scenes above are built.'),
    change_label: zLabel,
  }),
  summarize: (a) =>
    [a.clear && 'clear', a.from_arrangement && 'from arrangement', a.quantize && `quantize ${a.quantize}`, a.scenes.length && plural(a.scenes.length, 'scene'), a.to_song && 'to song'].filter(Boolean).join(', '),
  run(deps, _c, a, ctx) {
    if (!a.clear && !a.from_arrangement && !a.quantize && !a.scenes.length && !a.to_song) fail('Say what to build: scenes, from_arrangement, quantize, clear or to_song.');
    const notes: string[] = [];
    const created: string[] = [];
    if (a.clear) {
      const ids = [...(deps.doc.project.session?.sceneOrder ?? [])];
      for (const id of ids) ctx.exec('session.removeScene', { id });
      if (ids.length) notes.push(`removed ${plural(ids.length, 'scene')}`);
    }
    if (a.from_arrangement) {
      const bars = typeof a.from_arrangement === 'object' ? a.from_arrangement.bars_per_scene : undefined;
      const r = ctx.exec<{ sceneIds: string[]; clips: number }>('session.fromArrangement', bars ? { barsPerScene: bars } : {});
      notes.push(`${plural(r.sceneIds.length, 'scene')} from the arrangement (${plural(r.clips, 'clip')})`);
    }
    if (a.quantize) ctx.exec('session.setQuantize', { quantize: a.quantize });
    let added = 0;
    let slots = 0;
    for (const sc of a.scenes) {
      const p = deps.doc.project;
      const bar = ticksPerBar(p.transport.timeSig);
      let sceneId: string;
      if (sc.scene !== undefined) {
        sceneId = findScene(p, sc.scene);
        const patch: Record<string, unknown> = { id: sceneId };
        if (sc.name !== undefined) patch.name = sc.name;
        if (sc.tempo !== undefined) patch.tempo = sc.tempo;
        if (sc.color !== undefined) patch.color = sc.color;
        if (Object.keys(patch).length > 1) ctx.exec('session.setScene', patch);
      } else {
        sceneId = ctx.exec<{ id: string }>('session.addScene', { name: sc.name, tempo: sc.tempo ?? null, color: sc.color ?? null }).id;
        added++;
      }
      for (const slot of sc.clips) {
        const trackId = trackFor(ctx, deps, slot.track, created);
        const q = deps.doc.project;
        if (slot.remove) {
          const old = Object.values(q.session?.clips ?? {}).find((c) => c.trackId === trackId && c.sceneId === sceneId);
          if (old) ctx.exec('session.removeClip', { id: old.id });
          continue;
        }
        if (!!slot.pattern === !!slot.audio) fail(`Each clip needs a pattern or an audio channel (not both): track ${safeName(String(slot.track))}`);
        const args: Record<string, unknown> = { trackId, sceneId };
        if (slot.pattern) args.patternId = findPattern(q, slot.pattern).id;
        else {
          const ch = findChannel(q, slot.audio!);
          if (ch.generator.type !== AUDIOCLIP) fail(`"${safeName(ch.name)}" is an instrument channel, not an audio clip: put one of its patterns in the slot instead.`);
          args.channelId = ch.id;
        }
        if (slot.name) args.name = slot.name;
        if (slot.length_bars !== undefined) args.length = Math.max(1, Math.round(slot.length_bars * bar));
        if (slot.offset_bars !== undefined) args.offset = Math.round(slot.offset_bars * bar);
        if (slot.loop !== undefined) args.loop = slot.loop;
        if (slot.launch_mode) args.launchMode = slot.launch_mode;
        if (slot.quantize) args.quantize = slot.quantize;
        if (slot.follow) args.follow = { action: slot.follow.action, chance: slot.follow.chance, otherAction: slot.follow.other_action, afterBars: slot.follow.after_bars };
        ctx.exec('session.setClip', args);
        slots++;
      }
    }
    if (added) notes.push(`added ${plural(added, 'scene')}`);
    if (slots) notes.push(`set ${plural(slots, 'slot')}`);
    if (a.to_song) {
      const p = deps.doc.project;
      const bar = ticksPerBar(p.transport.timeSig);
      const order = a.to_song.scenes.map((s) => ({ sceneId: findScene(p, s.scene), bars: s.bars }));
      const r = ctx.exec<{ clips: number; start: number; end: number }>('session.scenesToSong', { order, ...(a.to_song.at_bar ? { at: (a.to_song.at_bar - 1) * bar } : {}) });
      notes.push(`wrote ${plural(order.length, 'scene')} into the playlist at bars ${Math.round(r.start / bar) + 1}-${Math.round(r.end / bar)} (${plural(r.clips, 'clip')})`);
    }
    if (created.length) notes.push(`new playlist track${created.length === 1 ? '' : 's'} ${created.map((n) => `"${safeName(n, 30)}"`).join(', ')}`);
    return {
      ok: true,
      message: `Live set updated${notes.length ? `: ${notes.join(', ')}` : ''}. launch {scene} plays a row; the user can also click the Session view.`,
      changed: [],
      text: sessionSummary(deps.doc.project),
    };
  },
});

// ── launch ────────────────────────────────────────────────────────────

export const launch = defineTool({
  name: 'launch',
  title: 'Launch clips / scenes',
  kind: 'transport',
  description:
    'Play the live set (clip launcher) for the user: exactly one of {scene} (a row; sets its tempo when it has one), {clip} (a launch clip id, or {track, scene} for a slot), {stop: track | "all"} (stop launched clips), {back_to_arrangement: true} (every track plays the playlist again) or {record: true|false} (record what you launch into the playlist; written when playback stops). Launches wait for the quantize boundary; with the transport stopped, playback starts.',
  input: z.object({
    scene: zSceneRef.optional(),
    clip: z.union([z.string().min(1), z.object({ track: zTrackRef, scene: zSceneRef })]).optional(),
    stop: z.union([z.literal('all'), zTrackRef]).optional(),
    back_to_arrangement: z.boolean().optional(),
    record: z.boolean().optional(),
  }),
  summarize: (a) =>
    a.scene !== undefined ? `scene ${safeName(String(a.scene), 30)}` : a.clip !== undefined ? 'clip' : a.stop !== undefined ? `stop ${safeName(String(a.stop), 30)}` : a.back_to_arrangement ? 'back to arrangement' : a.record !== undefined ? `record ${a.record ? 'on' : 'off'}` : '',
  async run(deps, _c, a, ctx) {
    const given = [a.scene !== undefined, a.clip !== undefined, a.stop !== undefined, a.back_to_arrangement === true, a.record !== undefined].filter(Boolean).length;
    if (given !== 1) fail('Give exactly one of scene, clip, stop, back_to_arrangement or record.');
    const ses = deps.session ?? fail('The clip launcher is not available in this session.');
    const p = deps.doc.project;
    let r;
    if (a.record !== undefined) {
      r = await ses.setRecord(a.record);
    } else if (a.back_to_arrangement) {
      r = await ses.backToArrangement();
    } else if (a.stop !== undefined) {
      const trackId = a.stop === 'all' ? null : trackOnly(p, a.stop);
      r = await ses.stop(trackId);
    } else if (a.scene !== undefined) {
      r = await ses.launchScene(findScene(p, a.scene), (cmd, args) => ctx.exec(cmd, args));
    } else {
      const clip = a.clip!;
      let clipId: string;
      if (typeof clip === 'string') {
        clipId = p.session?.clips[clip] ? clip : fail(`No launch clip "${safeName(clip)}". Use {clip: {track, scene}} or get_project for the ids.`);
      } else {
        const trackId = trackOnly(p, clip.track);
        const sceneId = findScene(p, clip.scene);
        const c = Object.values(p.session?.clips ?? {}).find((x) => x.trackId === trackId && x.sceneId === sceneId);
        clipId = c ? c.id : fail(`That slot (track ${safeName(String(clip.track))}, scene ${safeName(String(clip.scene))}) is empty.`);
      }
      r = await ses.launch(clipId);
    }
    if (!r.ok) fail(r.message ?? 'The launcher refused that');
    if (r.message?.startsWith('No change')) return { ok: false, message: r.message, changed: [] };
    return { ok: true, message: `${r.message ?? 'Done'}.`, changed: [] };
  },
});

/** An existing playlist track (launch never creates one). */
function trackOnly(p: Project, ref: string | number): string {
  const order = p.playlist.trackOrder;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = order[Number(ref) - 1];
    return id ?? fail(`Playlist track ${ref} doesn't exist (1..${order.length})`);
  }
  const r = String(ref).trim();
  if (p.playlist.tracks[r]) return r;
  const hit = order.filter((id) => p.playlist.tracks[id].name.toLowerCase() === r.toLowerCase());
  if (hit.length === 1) return hit[0];
  fail(`No playlist track "${safeName(r)}" (use a 1-based number or a track name)`);
}

export const SESSION_TOOLS = [buildSession, launch];
