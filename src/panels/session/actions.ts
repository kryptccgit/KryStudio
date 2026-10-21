// ──────────────────────────────────────────────────────────────────────
// Session view verbs. Grid edits are doc commands (`session.*`, launcher-app's
// shared/commands/session.ts) through dispatch(); playback goes through
// window.krypt.session. Every failure ends in a toast: dispatch() toasts
// failed commands itself, report() toasts failed runtime calls.
// ──────────────────────────────────────────────────────────────────────

import type { Id } from '@shared/schema/project';
import type { FollowRule, LaunchClip, LaunchQuant } from '@shared/schema/launcher';
import type { ActionResult } from '@shared/types';
import { dispatch, getProject, withGroup } from '../../doc/store';
import { report, toast } from '../../app/notify';
import { flashHint } from '../../app/hints';
import { firstEmptyScene, nameFromPath } from './model';

// ── Runtime (window.krypt.session) ────────────────────────────────────

async function runtime(what: string, fn: () => Promise<ActionResult>): Promise<boolean> {
  try {
    return report(await fn());
  } catch (err) {
    toast.error(`${what} failed: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

/** Launch a clip; `release` = mouse / key up for gate and repeat clips. */
export function launchClip(clipId: Id, release?: boolean): Promise<boolean> {
  return runtime(release ? 'Release clip' : 'Launch clip', () => window.krypt.session.launch(clipId, release));
}

export function launchScene(sceneId: Id): Promise<boolean> {
  return runtime('Launch scene', () => window.krypt.session.launchScene(sceneId));
}

/** Stop one track's launch clip (quantized) or every track (null). */
export function stopTrack(trackId: Id | null): Promise<boolean> {
  return runtime(trackId ? 'Stop track' : 'Stop all clips', () => window.krypt.session.stop(trackId));
}

export async function backToArrangement(): Promise<boolean> {
  const ok = await runtime('Back to arrangement', () => window.krypt.session.backToArrangement());
  if (ok) flashHint('Back to arrangement: every track follows the playlist again', 'ok');
  return ok;
}

export async function setLaunchRecord(on: boolean): Promise<boolean> {
  const ok = await runtime(on ? 'Record to arrangement' : 'Stop recording launches', () => window.krypt.session.setRecord(on));
  if (ok)
    flashHint(
      on ? 'Recording launches: press play in Song mode and launch clips. They are written into the playlist when you stop.' : 'Launch recording off',
      'ok',
      on ? 4200 : 2000,
    );
  return ok;
}

// ── Doc edits (session.* commands) ────────────────────────────────────
// Arg names follow research/16 §2.1 and shared/commands/session.ts.

export async function addScene(index?: number): Promise<Id | null> {
  const r = await dispatch<{ id: Id }>('session.addScene', index === undefined ? {} : { index });
  return r.ok && r.data ? r.data.id : null;
}

export async function removeScene(id: Id): Promise<boolean> {
  return (await dispatch('session.removeScene', { id })).ok;
}

export async function setScene(id: Id, patch: { name?: string; color?: string | null; tempo?: number | null }): Promise<boolean> {
  return (await dispatch('session.setScene', { id, ...patch })).ok;
}

export async function moveScene(id: Id, toIndex: number): Promise<boolean> {
  return (await dispatch('session.moveScene', { id, toIndex })).ok;
}

export type ClipPatch = Partial<Pick<LaunchClip, 'length' | 'offset' | 'loop' | 'launchMode' | 'gain'>> & {
  /** null = back to the pattern / channel name. */
  name?: string | null;
  color?: string | null;
  /** null = back to the global quantize. */
  quantize?: LaunchQuant | null;
  /** null = no follow action. */
  follow?: FollowRule | null;
};

export async function updateClip(id: Id, patch: ClipPatch, label?: string): Promise<boolean> {
  return (await dispatch('session.updateClip', { id, ...patch }, label ? { label } : undefined)).ok;
}

export async function removeClip(id: Id): Promise<boolean> {
  return (await dispatch('session.removeClip', { id })).ok;
}

/** Move (or copy) a clip to another slot; an occupied target is replaced by the command. */
export async function moveClip(id: Id, trackId: Id, sceneId: Id, copy: boolean): Promise<boolean> {
  return (await dispatch('session.moveClip', { id, trackId, sceneId, copy })).ok;
}

export async function setGlobalQuantize(quantize: LaunchQuant): Promise<boolean> {
  return (await dispatch('session.setQuantize', { quantize })).ok;
}

/** Scenes from the arrangement: one per marker section, or every `barsPerScene` bars when the song has no markers. */
export async function fromArrangement(barsPerScene?: number): Promise<boolean> {
  const r = await dispatch<{ sceneIds?: string[]; clips?: number }>('session.fromArrangement', barsPerScene ? { barsPerScene } : {});
  if (r.ok) {
    const n = r.data?.sceneIds?.length ?? 0;
    const c = r.data?.clips ?? 0;
    toast.success(`Built ${n} scene${n === 1 ? '' : 's'} with ${c} clip${c === 1 ? '' : 's'} from the arrangement`);
  }
  return r.ok;
}

export interface SetClipExtras {
  offset?: number;
  length?: number;
  name?: string;
  groupId?: string;
}

export async function setClipFromPattern(trackId: Id, sceneId: Id, patternId: Id, extra: SetClipExtras = {}): Promise<Id | null> {
  const { groupId, ...rest } = extra;
  const r = await dispatch<{ id: Id }>('session.setClip', { trackId, sceneId, patternId, ...rest }, groupId ? { groupId } : undefined);
  return r.ok && r.data ? r.data.id : null;
}

export async function setClipFromChannel(trackId: Id, sceneId: Id, channelId: Id, extra: SetClipExtras = {}): Promise<Id | null> {
  const { groupId, ...rest } = extra;
  const r = await dispatch<{ id: Id }>('session.setClip', { trackId, sceneId, channelId, ...rest }, groupId ? { groupId } : undefined);
  return r.ok && r.data ? r.data.id : null;
}

/** Probe a file's length (frames) like the playlist does; {} when the engine can't read it. */
async function probe(path: string): Promise<{ frames?: number; sampleRate?: number; channels?: number }> {
  try {
    const r = await window.krypt.engine.sampleInfo(path);
    if (r.ok && r.data) return { frames: r.data.frames, sampleRate: r.data.sampleRate, channels: r.data.channels };
    toast.warn(`Couldn't read "${nameFromPath(path)}" (${r.message ?? 'engine unavailable'}): the clip gets a default length`);
  } catch {
    toast.warn('Audio engine unavailable: the clip gets a default length');
  }
  return {};
}

/** A new audio-clip channel for a sample already in the pool (same path as the playlist's audio drop). */
async function newAudioClipChannel(sampleId: Id, name: string, groupId: string): Promise<Id | null> {
  const c = await dispatch<{ id: Id }>('channels.add', { type: 'krypt.audioclip', sampleId, name: name.slice(0, 64) }, { groupId });
  return c.ok && c.data ? c.data.id : null;
}

/**
 * An audio file (browser / Explorer) into a slot: pool sample → its own audio-clip channel (and mixer insert)
 * → the launch clip. One undo step.
 */
export async function setClipFromSample(trackId: Id, sceneId: Id, path: string, name?: string): Promise<Id | null> {
  const label = (name ?? nameFromPath(path)).replace(/\.[a-z0-9]+$/i, '');
  const info = await probe(path);
  const id = await withGroup(`Add ${label} to the Session view`, async (groupId) => {
    const s = await dispatch<{ id: Id }>('samples.add', { path, name: label, ...info }, { groupId });
    if (!s.ok || !s.data) return null;
    const ch = await newAudioClipChannel(s.data.id, label, groupId);
    if (!ch) return null;
    return setClipFromChannel(trackId, sceneId, ch, { groupId });
  });
  if (id) flashHint(`Added ${label} as an audio clip`, 'ok');
  return id;
}

/**
 * A Channel Rack row dropped on a slot: an audio-clip channel plays as itself; a sampler's sample gets its own
 * audio-clip channel; instruments without audio play from patterns, so say so.
 */
export async function setClipFromChannelDrag(trackId: Id, sceneId: Id, channelId: Id): Promise<Id | null> {
  const p = getProject();
  const ch = p?.channels[channelId];
  if (!ch) {
    toast.error('That channel no longer exists');
    return null;
  }
  if (ch.generator.type === 'krypt.audioclip') return setClipFromChannel(trackId, sceneId, channelId);
  const sampleId = ch.generator.sampleId;
  if (!sampleId || !p.samples[sampleId]) {
    toast.info(`${ch.name} is an instrument: drag a pattern (or the pattern picker) onto the slot to launch its notes`);
    return null;
  }
  const label = p.samples[sampleId].name;
  return withGroup(`Add ${label} to the Session view`, async (groupId) => {
    const nc = await newAudioClipChannel(sampleId, label, groupId);
    return nc ? setClipFromChannel(trackId, sceneId, nc, { groupId }) : null;
  });
}

/** Playlist clip menu → "Send to Session view": its track's first empty slot (a new scene when the column is full). */
export async function sendPlaylistClipToSession(clipId: Id): Promise<boolean> {
  const p = getProject();
  const c = p?.playlist.clips[clipId];
  if (!p || !c) {
    toast.error('That clip no longer exists');
    return false;
  }
  if (c.kind === 'automation') {
    toast.info("Automation clips can't be launched: send pattern or audio clips");
    return false;
  }
  const id = await withGroup('Send clip to the Session view', async (groupId) => {
    const s = getProject().session;
    let sceneId = s ? firstEmptyScene(c.trackId, s.sceneOrder, s.clips) : null;
    if (!sceneId) {
      const r = await dispatch<{ id: Id }>('session.addScene', {}, { groupId });
      if (!r.ok || !r.data) return null;
      sceneId = r.data.id;
    }
    const extra: SetClipExtras = { offset: c.offset, length: c.length, groupId };
    if (c.kind === 'pattern' && c.patternId) return setClipFromPattern(c.trackId, sceneId, c.patternId, extra);
    if (c.kind === 'audio' && c.channelId) return setClipFromChannel(c.trackId, sceneId, c.channelId, extra);
    toast.error('That clip has no pattern or audio to launch');
    return null;
  });
  if (id) {
    const s = getProject().session;
    const row = s ? s.sceneOrder.indexOf(s.clips[id]?.sceneId ?? '') + 1 : 0;
    flashHint(`Sent to the Session view${row ? `, scene ${row}` : ''}`, 'ok');
  }
  return !!id;
}
