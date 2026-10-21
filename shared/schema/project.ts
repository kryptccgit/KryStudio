import { z } from 'zod';
import { PPQ, type TimeSig } from './time';
import { zSession, type Session } from './launcher';
import { zFxSlotBase, zGeneratorBase, zRack, type RackDef } from './rack';
import { zWarp, type WarpMap } from './warp';
import { isValidSlices, zSlices, type Slice } from './slicer';
import { checkScriptsIntegrity, zProjectScripts } from '../scripts/schema';
import type { ProjectScript } from '../scripts/types';
import { takesIntegrity, zTakeGroups, type TakeGroup } from './takes';

export const SCHEMA_VERSION = 1;

export type Id = string;

export interface TransportState {
  bpm: number;
  timeSig: TimeSig;
  swing: number;
  mode: 'pattern' | 'song';
  activePatternId: Id | null;
  loop: { enabled: boolean; start: number; end: number };
  metronome: boolean;
  masterVolume: number;
}

export interface Generator {
  type: string;
  params: Record<string, number>;
  sampleId: Id | null;
  state?: string;
  preset?: { id: string; name: string };
  warp?: WarpMap;
  rack?: RackDef;
  slices?: Slice[];
}

export interface Channel {
  id: Id;
  name: string;
  color: string;
  generator: Generator;
  volume: number;
  pan: number;
  pitch: number;
  mute: boolean;
  insertId: Id;
  rootKey: number;
  swing: number;
  poly: { mono: boolean; glideMs: number; cutGroup: number; cutBy: number };
  group?: string;
}

export interface Note {
  id: Id;
  tick: number;
  dur: number;
  key: number;
  vel: number;
  pan: number;
  release: number;
  fine: number;
  slide: boolean;
  modX: number;
  modY: number;
  mute?: boolean;
  color?: number;
}

export interface Pattern {
  id: Id;
  name: string;
  color: string;
  length: number | null;
  notes: Record<Id, Record<Id, Note>>;
}

export interface PlaylistTrack {
  id: Id;
  name: string;
  color: string;
  height: number;
  mute: boolean;
  solo: boolean;
}

export type ClipKind = 'pattern' | 'audio' | 'automation';

export interface Clip {
  id: Id;
  trackId: Id;
  kind: ClipKind;
  start: number;
  length: number;
  offset: number;
  mute: boolean;
  color: string | null;
  patternId?: Id;
  channelId?: Id;
  automationId?: Id;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface Marker {
  id: Id;
  tick: number;
  name: string;
}

export interface Playlist {
  tracks: Record<Id, PlaylistTrack>;
  trackOrder: Id[];
  clips: Record<Id, Clip>;
  markers: Record<Id, Marker>;
}

export interface AutomationPoint {
  id: Id;
  tick: number;
  value: number;
  tension: number;
}

export interface Automation {
  id: Id;
  name: string;
  color: string;
  target: string | null;
  points: Record<Id, AutomationPoint>;
}

export interface FxSlot {
  id: Id;
  type: string;
  enabled: boolean;
  mix: number;
  params: Record<string, number>;
  state?: string;
  sidechainFrom: Id | null;
  rack?: RackDef;
}

export interface MixerInsert {
  id: Id;
  name: string;
  color: string;
  volume: number;
  pan: number;
  stereoSep: number;
  mute: boolean;
  solo: boolean;
  phaseInvert: boolean;
  swapLR: boolean;
  slots: Record<Id, FxSlot>;
  slotOrder: Id[];
  routes: Record<Id, number>;
  isMaster: boolean;
}

export interface Mixer {
  inserts: Record<Id, MixerInsert>;
  insertOrder: Id[];
  masterId: Id;
}

export interface SampleRef {
  id: Id;
  name: string;
  path: string;
  relPath?: string;
  hash?: string;
  sampleRate?: number;
  channels?: number;
  frames?: number;
  origin?: SampleOrigin;
}

export interface SampleOrigin {
  kind: 'stem';
  parentSampleId: Id;
  stem: string;
  model: string;
}

export interface CoverRef {
  file: string;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export const COVER_FILE_RE = /^cover-[0-9a-f]{16}\.(jpg|png)$/;
export const COVER_MAX_SIDE = 1400;

export interface ProjectMeta {
  name: string;
  author: string;
  genre: string;
  notes: string;
  createdAt: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  trackNumber?: number;
  cover?: CoverRef;
}

export interface Project {
  schemaVersion: number;
  id: Id;
  meta: ProjectMeta;
  transport: TransportState;
  channels: Record<Id, Channel>;
  channelOrder: Id[];
  patterns: Record<Id, Pattern>;
  patternOrder: Id[];
  playlist: Playlist;
  automations: Record<Id, Automation>;
  mixer: Mixer;
  samples: Record<Id, SampleRef>;
  session?: Session;
  scripts?: Record<Id, ProjectScript>;
  takeGroups?: Record<Id, TakeGroup>;
  recording?: RecordingTarget;
}

export interface RecordingTarget {
  insertId: Id | null;
  trackId: Id | null;
}

export const DEFAULT_CHANNEL_VOLUME = 0.78;
export const MAX_FX_SLOTS = 10;
export const MAX_INSERTS = 128;

export const PALETTE = [
  '#A855F7', '#6366F1', '#EC4899', '#22C55E', '#F59E0B', '#06B6D4',
  '#EF4444', '#84CC16', '#8B5CF6', '#14B8A6', '#F97316', '#3B82F6',
];

export function paletteColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function defaultNote(partial: Partial<Note> & Pick<Note, 'id' | 'tick' | 'key'>): Note {
  return {
    dur: PPQ / 4,
    vel: 0.78,
    pan: 0,
    release: 0.5,
    fine: 0,
    slide: false,
    modX: 0.5,
    modY: 0.5,
    ...partial,
  };
}

export function patternLength(p: Pattern, ts: TimeSig): number {
  const bar = (PPQ * 4 * ts.num) / ts.den;
  if (p.length != null && p.length > 0) return p.length;
  let end = 0;
  for (const byNote of Object.values(p.notes)) {
    for (const n of Object.values(byNote)) end = Math.max(end, n.tick + n.dur);
  }
  return Math.max(bar, Math.ceil(end / bar) * bar);
}

const zId = z.string().min(1);
const zColor = z.string();
const zRecord = <T extends z.ZodTypeAny>(v: T) => z.record(z.string(), v);

export const zNote = z.object({
  id: zId,
  tick: z.number().int().min(0),
  dur: z.number().int().min(1),
  key: z.number().int().min(0).max(127),
  vel: z.number().min(0).max(1),
  pan: z.number().min(-1).max(1),
  release: z.number().min(0).max(1),
  fine: z.number().min(-100).max(100),
  slide: z.boolean(),
  modX: z.number().min(0).max(1),
  modY: z.number().min(0).max(1),
  mute: z.boolean().optional(),
  color: z.number().int().min(0).max(15).optional(),
});

export const zProject = z.object({
  schemaVersion: z.number().int(),
  id: zId,
  meta: z.object({
    name: z.string(),
    author: z.string(),
    genre: z.string(),
    notes: z.string(),
    createdAt: z.string(),
    title: z.string().max(200).optional(),
    artist: z.string().max(200).optional(),
    album: z.string().max(200).optional(),
    year: z.number().int().min(1000).max(9999).optional(),
    trackNumber: z.number().int().min(1).max(999).optional(),
    cover: z
      .object({
        file: z.string().regex(COVER_FILE_RE),
        mime: z.enum(['image/png', 'image/jpeg']),
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
      })
      .optional(),
  }),
  transport: z.object({
    bpm: z.number().min(10).max(999),
    timeSig: z.object({ num: z.number().int().min(1).max(32), den: z.number().int().min(1).max(32) }),
    swing: z.number().min(0).max(1),
    mode: z.enum(['pattern', 'song']),
    activePatternId: zId.nullable(),
    loop: z.object({ enabled: z.boolean(), start: z.number().min(0), end: z.number().min(0) }),
    metronome: z.boolean(),
    masterVolume: z.number().min(0).max(4),
  }),
  channels: zRecord(
    z.object({
      id: zId,
      name: z.string(),
      color: zColor,
      generator: zGeneratorBase.extend({ warp: zWarp.optional(), rack: zRack.optional(), slices: zSlices.optional() }),
      volume: z.number().min(0).max(4),
      pan: z.number().min(-1).max(1),
      pitch: z.number().min(-96).max(96),
      mute: z.boolean(),
      insertId: zId,
      rootKey: z.number().int().min(0).max(127),
      swing: z.number().min(0).max(1),
      poly: z.object({
        mono: z.boolean(),
        glideMs: z.number().min(0),
        cutGroup: z.number().int().min(0),
        cutBy: z.number().int().min(0),
      }),
      group: z.string().max(32).optional(),
    }),
  ),
  channelOrder: z.array(zId),
  patterns: zRecord(
    z.object({
      id: zId,
      name: z.string(),
      color: zColor,
      length: z.number().int().min(1).nullable(),
      notes: zRecord(zRecord(zNote)),
    }),
  ),
  patternOrder: z.array(zId),
  playlist: z.object({
    tracks: zRecord(
      z.object({
        id: zId,
        name: z.string(),
        color: zColor,
        height: z.number(),
        mute: z.boolean(),
        solo: z.boolean(),
      }),
    ),
    trackOrder: z.array(zId),
    clips: zRecord(
      z.object({
        id: zId,
        trackId: zId,
        kind: z.enum(['pattern', 'audio', 'automation']),
        start: z.number().min(0),
        length: z.number().min(1),
        offset: z.number().min(0),
        mute: z.boolean(),
        color: zColor.nullable(),
        patternId: zId.optional(),
        channelId: zId.optional(),
        automationId: zId.optional(),
        gain: z.number().optional(),
        fadeIn: z.number().optional(),
        fadeOut: z.number().optional(),
      }),
    ),
    markers: zRecord(z.object({ id: zId, tick: z.number().min(0), name: z.string() })),
  }),
  automations: zRecord(
    z.object({
      id: zId,
      name: z.string(),
      color: zColor,
      target: z.string().nullable(),
      points: zRecord(
        z.object({
          id: zId,
          tick: z.number().min(0),
          value: z.number().min(0).max(1),
          tension: z.number().min(-1).max(1),
        }),
      ),
    }),
  ),
  mixer: z.object({
    inserts: zRecord(
      z.object({
        id: zId,
        name: z.string(),
        color: zColor,
        volume: z.number().min(0).max(4),
        pan: z.number().min(-1).max(1),
        stereoSep: z.number().min(-1).max(1),
        mute: z.boolean(),
        solo: z.boolean(),
        phaseInvert: z.boolean(),
        swapLR: z.boolean(),
        slots: zRecord(zFxSlotBase.extend({ rack: zRack.optional() })),
        slotOrder: z.array(zId),
        routes: zRecord(z.number().min(0).max(4)),
        isMaster: z.boolean(),
      }),
    ),
    insertOrder: z.array(zId),
    masterId: zId,
  }),
  samples: zRecord(
    z.object({
      id: zId,
      name: z.string(),
      path: z.string(),
      relPath: z.string().optional(),
      hash: z.string().optional(),
      sampleRate: z.number().optional(),
      channels: z.number().optional(),
      frames: z.number().optional(),
      origin: z.object({ kind: z.literal('stem'), parentSampleId: z.string(), stem: z.string(), model: z.string() }).optional(),
    }),
  ),
  session: zSession.optional(),
  scripts: zProjectScripts.optional(),
  takeGroups: zTakeGroups.optional(),
  recording: z.object({ insertId: zId.nullable(), trackId: zId.nullable() }).optional(),
});

export function checkIntegrity(p: Project): string[] {
  const errs: string[] = [];
  const ins = p.mixer.inserts;
  if (!ins[p.mixer.masterId]) errs.push('mixer.masterId does not exist');
  for (const ch of Object.values(p.channels)) {
    if (!ins[ch.insertId]) errs.push(`channel ${ch.id} routes to missing insert ${ch.insertId}`);
    if (ch.generator.sampleId && !p.samples[ch.generator.sampleId]) errs.push(`channel ${ch.id} references missing sample`);
    if (ch.generator.slices && !isValidSlices(ch.generator.slices)) errs.push(`channel ${ch.id} slices are unsorted or repeat an id`);
  }
  for (const id of p.channelOrder) if (!p.channels[id]) errs.push(`channelOrder has unknown ${id}`);
  for (const id of p.patternOrder) if (!p.patterns[id]) errs.push(`patternOrder has unknown ${id}`);
  for (const pat of Object.values(p.patterns)) {
    for (const chId of Object.keys(pat.notes)) if (!p.channels[chId]) errs.push(`pattern ${pat.id} has notes for missing channel ${chId}`);
  }
  for (const c of Object.values(p.playlist.clips)) {
    if (!p.playlist.tracks[c.trackId]) errs.push(`clip ${c.id} on missing track`);
    if (c.kind === 'pattern' && (!c.patternId || !p.patterns[c.patternId])) errs.push(`clip ${c.id} missing pattern`);
    if (c.kind === 'audio' && (!c.channelId || !p.channels[c.channelId])) errs.push(`clip ${c.id} missing audio channel`);
    if (c.kind === 'automation' && (!c.automationId || !p.automations[c.automationId])) errs.push(`clip ${c.id} missing automation`);
  }
  for (const i of Object.values(ins)) {
    for (const t of Object.keys(i.routes)) if (!ins[t]) errs.push(`insert ${i.id} routes to missing ${t}`);
    for (const s of i.slotOrder) if (!i.slots[s]) errs.push(`insert ${i.id} slotOrder has unknown ${s}`);
  }
  if (p.transport.activePatternId && !p.patterns[p.transport.activePatternId]) errs.push('activePatternId missing');
  if (p.session) {
    const s = p.session;
    for (const id of s.sceneOrder) if (!s.scenes[id]) errs.push(`session.sceneOrder has unknown ${id}`);
    const slots = new Set<string>();
    for (const c of Object.values(s.clips)) {
      if (!p.playlist.tracks[c.trackId]) errs.push(`launch clip ${c.id} on missing track`);
      if (!s.scenes[c.sceneId]) errs.push(`launch clip ${c.id} in missing scene`);
      if (c.kind === 'pattern' && (!c.patternId || !p.patterns[c.patternId])) errs.push(`launch clip ${c.id} missing pattern`);
      if (c.kind === 'audio' && (!c.channelId || !p.channels[c.channelId])) errs.push(`launch clip ${c.id} missing audio channel`);
      const k = `${c.trackId}/${c.sceneId}`;
      if (slots.has(k)) errs.push(`two launch clips in slot ${k}`);
      slots.add(k);
    }
  }
  errs.push(...checkScriptsIntegrity(p.scripts));
  errs.push(...takesIntegrity(p));
  if (p.recording?.insertId && !ins[p.recording.insertId]) errs.push('recording target insert is missing');
  if (p.recording?.trackId && !p.playlist.tracks[p.recording.trackId]) errs.push('recording target track is missing');
  const cover = p.meta.cover;
  if (cover && cover.mime !== coverMimeOf(cover.file)) errs.push(`meta.cover ${cover.file} is not ${cover.mime}`);
  return errs;
}

export function coverMimeOf(file: string): 'image/png' | 'image/jpeg' | null {
  return /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : null;
}

export function songInfo(meta: ProjectMeta, fallbackTitle?: string): { title: string; artist: string; album: string; year: string; genre: string; track: string } {
  return {
    title: (meta.title ?? '').trim() || (fallbackTitle ?? '').trim() || meta.name.trim(),
    artist: (meta.artist ?? '').trim() || meta.author.trim(),
    album: (meta.album ?? '').trim(),
    year: meta.year ? String(meta.year) : '',
    genre: meta.genre.trim(),
    track: meta.trackNumber ? String(meta.trackNumber) : '',
  };
}
