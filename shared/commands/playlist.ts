import { z } from 'zod';
import { defineCommand, must, plural, CommandError } from './types';
import { patternLength, paletteColor, type Clip } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { secondsToTicks } from '../schema/time';
import { fallbackClipLength } from '../schema/factory';
import { removeLaunchClipsWhere } from './session';
import { dropTakeRefs } from '../schema/takes';

export const playlistAddTrack = defineCommand({
  id: 'playlist.addTrack',
  label: () => 'Add playlist track',
  description: 'Add a playlist track (lane). Any lane can hold pattern, audio and automation clips. Returns its id.',
  args: z.object({ name: z.string().max(64).optional(), index: z.number().int().min(0).optional() }),
  run(d, a, ctx) {
    const id = ctx.newId(ID_PREFIX.track);
    const n = d.playlist.trackOrder.length + 1;
    d.playlist.tracks[id] = { id, name: a.name ?? `Track ${n}`, color: '#3F3F52', height: 44, mute: false, solo: false };
    d.playlist.trackOrder.splice(Math.min(a.index ?? n, d.playlist.trackOrder.length), 0, id);
    return { id };
  },
});

export const playlistRemoveTrack = defineCommand({
  id: 'playlist.removeTrack',
  label: () => 'Delete playlist track',
  description: 'Delete a playlist track and all clips on it.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    must(d.playlist.tracks[a.id], `Track ${a.id} not found`);
    delete d.playlist.tracks[a.id];
    d.playlist.trackOrder = d.playlist.trackOrder.filter((t) => t !== a.id);
    for (const c of Object.values(d.playlist.clips)) if (c.trackId === a.id) delete d.playlist.clips[c.id];
    removeLaunchClipsWhere(d, (c) => c.trackId === a.id); // its launcher column goes too
    dropTakeRefs(d, { trackIds: [a.id] }); // and its take lanes
    if (d.recording?.trackId === a.id) d.recording.trackId = null;
    return {};
  },
});

export const playlistSetTrack = defineCommand({
  id: 'playlist.setTrack',
  label: () => 'Edit playlist track',
  description: 'Rename / recolor / resize / mute / solo a playlist track.',
  args: z.object({ id: z.string(), name: z.string().max(64).optional(), color: z.string().optional(), height: z.number().min(16).max(400).optional(), mute: z.boolean().optional(), solo: z.boolean().optional() }),
  run(d, a) {
    const t = must(d.playlist.tracks[a.id], `Track ${a.id} not found`);
    const { id: _id, ...rest } = a;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (t as any)[k] = v;
    return {};
  },
});

export const playlistAddClip = defineCommand({
  id: 'playlist.addClip',
  label: (a) => `Add ${a.kind} clip`,
  description:
    'Place a clip on the playlist. kind "pattern" needs patternId; "audio" needs channelId (an audio-clip channel, see playlist.addAudio); "automation" needs automationId. start/length/offset in ticks (length defaults to the source length). Returns the clip id.',
  args: z.object({
    kind: z.enum(['pattern', 'audio', 'automation']),
    trackId: z.string(),
    start: z.number().int().min(0),
    length: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).default(0),
    patternId: z.string().optional(),
    channelId: z.string().optional(),
    automationId: z.string().optional(),
    color: z.string().nullable().optional(),
  }),
  run(d, a, ctx) {
    must(d.playlist.tracks[a.trackId], `Track ${a.trackId} not found`);
    let length = a.length;
    const clip: Clip = { id: ctx.newId(ID_PREFIX.clip), trackId: a.trackId, kind: a.kind, start: a.start, length: 1, offset: a.offset, mute: false, color: a.color ?? null };
    if (a.kind === 'pattern') {
      const pat = must(a.patternId ? d.patterns[a.patternId] : undefined, `Pattern ${a.patternId} not found`);
      clip.patternId = pat.id;
      length ??= patternLength(pat, d.transport.timeSig);
    } else if (a.kind === 'audio') {
      const ch = must(a.channelId ? d.channels[a.channelId] : undefined, `Channel ${a.channelId} not found`);
      clip.channelId = ch.id;
      clip.gain = 1;
      clip.fadeIn = 0;
      clip.fadeOut = 0;
      const s = ch.generator.sampleId ? d.samples[ch.generator.sampleId] : undefined;
      if (length === undefined && s?.frames && s.sampleRate) length = Math.max(1, Math.round(secondsToTicks(s.frames / s.sampleRate, d.transport.bpm)));
    } else {
      const aut = must(a.automationId ? d.automations[a.automationId] : undefined, `Automation ${a.automationId} not found`);
      clip.automationId = aut.id;
      if (length === undefined) {
        const end = Math.max(0, ...Object.values(aut.points).map((p) => p.tick));
        length = end > 0 ? end : fallbackClipLength(d.transport.timeSig);
      }
    }
    clip.length = length ?? fallbackClipLength(d.transport.timeSig);
    d.playlist.clips[clip.id] = clip;
    return { id: clip.id };
  },
});

export const playlistAddAudio = defineCommand({
  id: 'playlist.addAudio',
  label: () => 'Add audio clip',
  description:
    'Import an audio file onto the playlist: adds the sample to the pool, creates an "Audio Clip" channel (routed to a new insert, or to `insertId` when given) and places a clip. frames/sampleRate let the clip length be computed; hash (content SHA-256, e.g. of an upload in userData/imports) keys the analysis cache and lets a moved upload be relinked. Returns clipId, channelId, sampleId.',
  args: z.object({
    path: z.string().min(1),
    name: z.string().optional(),
    trackId: z.string(),
    start: z.number().int().min(0),
    frames: z.number().int().min(1).optional(),
    sampleRate: z.number().min(1).optional(),
    channels: z.number().int().min(1).optional(),
    hash: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    /** Route the new channel to this existing insert (the Recording Studio's vocal insert) instead of a new one. */
    insertId: z.string().optional(),
  }),
  run(d, a, ctx) {
    must(d.playlist.tracks[a.trackId], `Track ${a.trackId} not found`);
    if (a.insertId) must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
    let sample = Object.values(d.samples).find((s) => s.path === a.path);
    if (!sample) {
      const id = ctx.newId(ID_PREFIX.sample);
      const name = (a.name ?? a.path.split(/[\\/]/).pop() ?? 'Audio').replace(/\.[a-z0-9]+$/i, '');
      sample = d.samples[id] = { id, name, path: a.path, frames: a.frames, sampleRate: a.sampleRate, channels: a.channels };
      if (a.hash) sample.hash = a.hash;
    }
    const color = paletteColor(d.channelOrder.length);
    let insId = a.insertId;
    if (!insId) {
      insId = ctx.newId(ID_PREFIX.insert);
      d.mixer.inserts[insId] = {
        id: insId, name: sample.name, color, volume: 1, pan: 0, stereoSep: 0, mute: false, solo: false,
        phaseInvert: false, swapLR: false, slots: {}, slotOrder: [], routes: { [d.mixer.masterId]: 1 }, isMaster: false,
      };
      d.mixer.insertOrder.push(insId);
    }
    const chId = ctx.newId(ID_PREFIX.channel);
    d.channels[chId] = {
      id: chId, name: sample.name, color,
      generator: { type: 'krypt.audioclip', params: {}, sampleId: sample.id },
      volume: 0.78, pan: 0, pitch: 0, mute: false, insertId: insId, rootKey: 60, swing: 0,
      poly: { mono: true, glideMs: 0, cutGroup: 0, cutBy: 0 },
    };
    d.channelOrder.push(chId);
    const s = sample;
    const length = s.frames && s.sampleRate ? Math.max(1, Math.round(secondsToTicks(s.frames / s.sampleRate, d.transport.bpm))) : fallbackClipLength(d.transport.timeSig);
    const clipId = ctx.newId(ID_PREFIX.clip);
    d.playlist.clips[clipId] = { id: clipId, trackId: a.trackId, kind: 'audio', start: a.start, length, offset: 0, mute: false, color: null, channelId: chId, gain: 1, fadeIn: 0, fadeOut: 0 };
    return { clipId, channelId: chId, sampleId: s.id, insertId: insId };
  },
});

export const playlistRemoveClips = defineCommand({
  id: 'playlist.removeClips',
  label: (a) => `Delete ${plural(a.ids.length, 'clip')}`,
  description: 'Delete playlist clips by id.',
  args: z.object({ ids: z.array(z.string()) }),
  run(d, a) {
    for (const id of a.ids) delete d.playlist.clips[id];
    return {};
  },
});

const zClipPatch = z.object({
  id: z.string(),
  trackId: z.string().optional(),
  start: z.number().int().min(0).optional(),
  length: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
  mute: z.boolean().optional(),
  color: z.string().nullable().optional(),
  gain: z.number().min(0).max(4).optional(),
  fadeIn: z.number().int().min(0).optional(),
  fadeOut: z.number().int().min(0).optional(),
});

export const playlistUpdateClips = defineCommand({
  id: 'playlist.updateClips',
  label: (a) => `Edit ${plural(a.updates.length, 'clip')}`,
  description: 'Move / resize / trim / mute clips (start, length, offset in ticks; trackId to change lane; gain/fades for audio).',
  args: z.object({ updates: z.array(zClipPatch).max(5000) }),
  run(d, a) {
    for (const u of a.updates) {
      const c = must(d.playlist.clips[u.id], `Clip ${u.id} not found`);
      if (u.trackId !== undefined) must(d.playlist.tracks[u.trackId], `Track ${u.trackId} not found`);
      const { id: _id, ...rest } = u;
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (c as any)[k] = v;
    }
    return {};
  },
});

export const playlistDuplicateClips = defineCommand({
  id: 'playlist.duplicateClips',
  label: (a) => `Duplicate ${plural(a.ids.length, 'clip')}`,
  description: 'Copy clips, shifted by `shift` ticks (default: right after the selection). Returns new clip ids.',
  args: z.object({ ids: z.array(z.string()).min(1), shift: z.number().int().optional() }),
  run(d, a, ctx) {
    const src = a.ids.map((id) => must(d.playlist.clips[id], `Clip ${id} not found`));
    const minStart = Math.min(...src.map((c) => c.start));
    const maxEnd = Math.max(...src.map((c) => c.start + c.length));
    const shift = a.shift ?? maxEnd - minStart;
    const ids: string[] = [];
    for (const c of src) {
      const id = ctx.newId(ID_PREFIX.clip);
      d.playlist.clips[id] = { ...c, id, start: Math.max(0, c.start + shift) };
      ids.push(id);
    }
    return { ids };
  },
});

const zClipCopy = z.object({
  trackId: z.string(),
  kind: z.enum(['pattern', 'audio', 'automation']),
  start: z.number().int().min(0),
  length: z.number().int().min(1),
  offset: z.number().int().min(0).default(0),
  mute: z.boolean().default(false),
  color: z.string().nullable().default(null),
  patternId: z.string().optional(),
  channelId: z.string().optional(),
  automationId: z.string().optional(),
  gain: z.number().min(0).max(4).optional(),
  fadeIn: z.number().int().min(0).optional(),
  fadeOut: z.number().int().min(0).optional(),
});

export const playlistPasteClips = defineCommand({
  id: 'playlist.pasteClips',
  label: (a) => `Paste ${plural(a.clips.length, 'clip')}`,
  description:
    'Place copies of clip snapshots (from Copy / Cut; the originals may be gone), shifted by `shift` ticks. Their pattern / audio channel / automation must still exist. Returns the new clip ids.',
  args: z.object({ clips: z.array(zClipCopy).min(1).max(5000), shift: z.number().int().default(0) }),
  run(d, a, ctx) {
    const ids: string[] = [];
    for (const s of a.clips) {
      must(d.playlist.tracks[s.trackId], 'The track these clips were copied from was deleted');
      if (s.kind === 'pattern') must(s.patternId ? d.patterns[s.patternId] : undefined, 'A copied clip’s pattern was deleted');
      else if (s.kind === 'audio') must(s.channelId ? d.channels[s.channelId] : undefined, 'A copied audio clip’s channel was deleted');
      else must(s.automationId ? d.automations[s.automationId] : undefined, 'A copied clip’s automation was deleted');
      const id = ctx.newId(ID_PREFIX.clip);
      const clip: Clip = { id, trackId: s.trackId, kind: s.kind, start: Math.max(0, s.start + a.shift), length: s.length, offset: s.offset, mute: s.mute, color: s.color };
      if (s.kind === 'pattern') clip.patternId = s.patternId;
      else if (s.kind === 'audio') Object.assign(clip, { channelId: s.channelId, gain: s.gain ?? 1, fadeIn: s.fadeIn ?? 0, fadeOut: s.fadeOut ?? 0 });
      else clip.automationId = s.automationId;
      d.playlist.clips[id] = clip;
      ids.push(id);
    }
    return { ids };
  },
});

export const playlistSplitClip = defineCommand({
  id: 'playlist.splitClip',
  label: () => 'Split clip',
  description: 'Split a clip at an absolute song tick into two clips. Returns both ids.',
  args: z.object({ id: z.string(), at: z.number().int().min(1) }),
  run(d, a, ctx) {
    const c = must(d.playlist.clips[a.id], `Clip ${a.id} not found`);
    const rel = a.at - c.start;
    if (rel <= 0 || rel >= c.length) throw new CommandError('Split point must be inside the clip');
    const id = ctx.newId(ID_PREFIX.clip);
    d.playlist.clips[id] = { ...c, id, start: a.at, length: c.length - rel, offset: c.offset + rel, fadeIn: c.kind === 'audio' ? 0 : c.fadeIn };
    c.length = rel;
    if (c.kind === 'audio') c.fadeOut = 0;
    return { ids: [c.id, id] };
  },
});

export const playlistMakeUnique = defineCommand({
  id: 'playlist.makeUnique',
  label: () => 'Make unique',
  description: 'Clone the pattern behind a pattern clip and point the clip at the copy, so edits only affect this clip. Returns the new pattern id.',
  args: z.object({ clipId: z.string() }),
  run(d, a, ctx) {
    const c = must(d.playlist.clips[a.clipId], `Clip ${a.clipId} not found`);
    if (c.kind !== 'pattern' || !c.patternId) throw new CommandError('Only pattern clips can be made unique');
    const src = must(d.patterns[c.patternId], 'Pattern not found');
    const id = ctx.newId(ID_PREFIX.pattern);
    const notes: typeof src.notes = {};
    for (const [chId, byId] of Object.entries(src.notes)) {
      notes[chId] = {};
      for (const n of Object.values(byId)) {
        const nid = ctx.newId(ID_PREFIX.note);
        notes[chId][nid] = { ...n, id: nid };
      }
    }
    let k = 2;
    while (Object.values(d.patterns).some((p) => p.name === `${src.name} #${k}`)) k++;
    d.patterns[id] = { ...src, id, name: `${src.name} #${k}`, notes };
    d.patternOrder.splice(d.patternOrder.indexOf(src.id) + 1, 0, id);
    c.patternId = id;
    return { patternId: id };
  },
});

export const playlistAddMarker = defineCommand({
  id: 'playlist.addMarker',
  label: () => 'Add marker',
  description: 'Add a named time marker (e.g. "Chorus") at a song tick. Returns its id.',
  args: z.object({ tick: z.number().int().min(0), name: z.string().max(64) }),
  run(d, a, ctx) {
    const id = ctx.newId('mk');
    d.playlist.markers[id] = { id, tick: a.tick, name: a.name };
    return { id };
  },
});

export const playlistRemoveMarker = defineCommand({
  id: 'playlist.removeMarker',
  label: () => 'Delete marker',
  description: 'Delete a time marker.',
  args: z.object({ id: z.string() }),
  run(d, a) {
    must(d.playlist.markers[a.id], `Marker ${a.id} not found`);
    delete d.playlist.markers[a.id];
    return {};
  },
});

export const PLAYLIST_COMMANDS = [
  playlistAddTrack,
  playlistRemoveTrack,
  playlistSetTrack,
  playlistAddClip,
  playlistAddAudio,
  playlistRemoveClips,
  playlistUpdateClips,
  playlistDuplicateClips,
  playlistPasteClips,
  playlistSplitClip,
  playlistMakeUnique,
  playlistAddMarker,
  playlistRemoveMarker,
];
