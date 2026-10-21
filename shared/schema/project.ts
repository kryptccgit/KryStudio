// ──────────────────────────────────────────────────────────────────────
// The Krypt Studio project document.
//
// Rules (see research/00-SYNTHESIS.md §2):
//  - Normalized: every collection is Record<Id, T> + an explicit order array.
//    Patches therefore address entities by id, never by array index, which is
//    what makes per-actor / selective undo and engine diffing robust.
//  - All time is integer ticks (PPQ 960, shared/schema/time.ts).
//  - Gains are LINEAR (1 = 0 dB). Pans are -1..1. Normalized params 0..1.
//  - Plugin/generator params are SPARSE: a missing key means "use the
//    ParamSpec default" from shared/plugins/catalog.gen.json.
//  - Nothing in here is runtime state (playing, playhead, meters, selection,
//    zoom). That lives in the engine telemetry / renderer view stores.
// ──────────────────────────────────────────────────────────────────────

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

// ── Transport ─────────────────────────────────────────────────────────

export interface TransportState {
  bpm: number; // 10..999
  timeSig: TimeSig;
  /** Global swing 0..1 (FL main swing). Applied to off-beat 16ths. */
  swing: number;
  mode: 'pattern' | 'song';
  /** Pattern played in pattern mode + target of new notes. */
  activePatternId: Id | null;
  /** Song-mode loop region in ticks. */
  loop: { enabled: boolean; start: number; end: number };
  metronome: boolean;
  /** Master output gain (linear). */
  masterVolume: number;
}

// ── Channels (Channel Rack) ───────────────────────────────────────────

export interface Generator {
  /** Plugin id from the catalog, e.g. 'krypt.sampler', 'krypt.triosc'. */
  type: string;
  /** Sparse param values (missing = catalog default). Plain units (see ParamSpec). */
  params: Record<string, number>;
  /** Sample used by sample-based generators (sampler, audio clip). */
  sampleId: Id | null;
  /** Opaque plugin state (base64), for third-party plugins. */
  state?: string;
  /** The preset this sound was loaded from (shared/sounds); cleared when the instrument is swapped. */
  preset?: { id: string; name: string };
  /** 'krypt.audioclip' only: warp markers + warp mode (shared/schema/warp.ts). Absent = Stretch params only. */
  warp?: WarpMap;
  /** 'krypt.rack' / 'krypt.drumrack' only: chains, zones, macros (shared/schema/rack.ts). */
  rack?: RackDef;
  /** 'krypt.slicer' only: slice markers sorted by sec (shared/schema/slicer.ts). Absent / empty = one slice. */
  slices?: Slice[];
}

export interface Channel {
  id: Id;
  name: string;
  color: string; // #rrggbb
  generator: Generator;
  volume: number; // linear, default 0.78
  pan: number; // -1..1
  /** Pitch offset in semitones (fractional allowed). */
  pitch: number;
  mute: boolean;
  /** Mixer insert this channel feeds. */
  insertId: Id;
  /** MIDI key at which a sample plays at its recorded pitch. */
  rootKey: number;
  /** How much of the global swing this channel follows, 0..1. */
  swing: number;
  /** Mono + glide (808s), and cut groups (open/closed hats). */
  poly: { mono: boolean; glideMs: number; cutGroup: number; cutBy: number };
  /** Channel Rack filter group ("Drums", "Synths" or a custom name). Absent = automatic by instrument type. */
  group?: string;
}

// ── Patterns & notes ──────────────────────────────────────────────────

export interface Note {
  id: Id;
  tick: number; // start within the pattern
  dur: number; // ticks, >= 1
  key: number; // MIDI 0..127 (60 = middle C; FL labels this C5)
  vel: number; // 0..1
  pan: number; // -1..1
  release: number; // 0..1
  /** Fine pitch in cents, -100..100. */
  fine: number;
  /** FL-style slide note: glides the previous note instead of retriggering. */
  slide: boolean;
  modX: number; // 0..1, default 0.5
  modY: number; // 0..1, default 0.5
  /** Muted notes stay in the pattern but never sound (FL mute tool). Absent = false. */
  mute?: boolean;
  /** Note colour group 0..15 (FL's 16 note colours; MIDI channel on export). Absent = 0. */
  color?: number;
}

export interface Pattern {
  id: Id;
  name: string;
  color: string;
  /** Length in ticks; null = auto (content rounded up to a bar, min 1 bar). */
  length: number | null;
  /** notes[channelId][noteId]. Step-sequencer steps ARE notes (dur = 1 step). */
  notes: Record<Id, Record<Id, Note>>;
}

// ── Playlist (arrangement) ────────────────────────────────────────────

export interface PlaylistTrack {
  id: Id;
  name: string;
  color: string;
  height: number; // px, UI hint persisted with the project
  mute: boolean;
  solo: boolean;
}

export type ClipKind = 'pattern' | 'audio' | 'automation';

export interface Clip {
  id: Id;
  trackId: Id;
  kind: ClipKind;
  start: number; // ticks on the song timeline
  length: number; // ticks
  /** Ticks into the source where playback starts (trimmed clip start). */
  offset: number;
  mute: boolean;
  color: string | null; // null = source color
  patternId?: Id; // kind 'pattern'
  /** kind 'audio': the audio-clip channel (generator 'krypt.audioclip') that owns sample + routing. */
  channelId?: Id;
  automationId?: Id; // kind 'automation'
  /** kind 'audio' only. */
  gain?: number; // linear
  fadeIn?: number; // ticks
  fadeOut?: number; // ticks
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

// ── Automation ────────────────────────────────────────────────────────

export interface AutomationPoint {
  id: Id;
  tick: number; // relative to the automation start
  /** Normalized 0..1, mapped through the target ParamSpec range/scale. */
  value: number;
  /** Curve of the segment leaving this point, -1..1 (0 = linear). */
  tension: number;
}

export interface Automation {
  id: Id;
  name: string;
  color: string;
  /** ParamRef string (shared/schema/params.ts); null = unassigned. */
  target: string | null;
  points: Record<Id, AutomationPoint>;
}

// ── Mixer ─────────────────────────────────────────────────────────────

export interface FxSlot {
  id: Id;
  /** Effect plugin id, e.g. 'krypt.eq'. */
  type: string;
  enabled: boolean;
  /** Wet/dry 0..1. */
  mix: number;
  params: Record<string, number>;
  state?: string;
  /** Insert whose post-fader signal feeds this slot's sidechain input. */
  sidechainFrom: Id | null;
  /** 'krypt.fxrack' only: parallel chains + macros (shared/schema/rack.ts). */
  rack?: RackDef;
}

export interface MixerInsert {
  id: Id;
  name: string;
  color: string;
  volume: number; // linear, 1 = 0 dB, max 2
  pan: number; // -1..1
  /** Stereo separation -1 (mono) .. 0 .. +1 (wider). */
  stereoSep: number;
  mute: boolean;
  solo: boolean;
  phaseInvert: boolean;
  swapLR: boolean;
  slots: Record<Id, FxSlot>;
  slotOrder: Id[]; // max 10
  /** Outgoing routes: target insert id → send level (linear). Default { [master]: 1 }. */
  routes: Record<Id, number>;
  isMaster: boolean;
}

export interface Mixer {
  inserts: Record<Id, MixerInsert>;
  insertOrder: Id[]; // master first
  masterId: Id;
}

// ── Samples ───────────────────────────────────────────────────────────

export interface SampleRef {
  id: Id;
  name: string;
  /** Absolute path, or 'factory:<relative>' for bundled factory content. */
  path: string;
  /** Path relative to the project file, for relinking moved projects. */
  relPath?: string;
  hash?: string;
  sampleRate?: number;
  channels?: number;
  frames?: number;
  /** How Krypt produced this file (absent = imported/recorded audio). Optional, additive: no migration. */
  origin?: SampleOrigin;
}

/** A stem separated from another sample by the analyzer (Model Manager model id). */
export interface SampleOrigin {
  kind: 'stem';
  parentSampleId: Id;
  stem: string;
  model: string;
}

// ── Project ───────────────────────────────────────────────────────────

/**
 * The project's cover image. The bytes live INSIDE the .kstudio zip as `file` (never in project.json); main keeps
 * them for the open project (electron/project/assets.ts). Content-addressed name: `cover-<16 hex>.jpg|png`.
 */
export interface CoverRef {
  file: string;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** Cover entry names inside the .kstudio zip: the first 16 hex digits of the image's SHA-256. */
export const COVER_FILE_RE = /^cover-[0-9a-f]{16}\.(jpg|png)$/;
export const COVER_MAX_SIDE = 1400;

export interface ProjectMeta {
  name: string;
  author: string;
  genre: string;
  notes: string;
  createdAt: string; // ISO
  // Song info, embedded as tags in exports (all optional, additive to schema 1).
  /** Song title; absent = the project name. */
  title?: string;
  /** Artist; absent = author. */
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
  /** Clip launcher (Session view, shared/schema/launcher.ts). Absent = empty. Additive: no migration. */
  session?: Session;
  /** Krypt Script note devices this song keeps (shared/scripts). Absent = none. Additive: no migration. */
  scripts?: Record<Id, ProjectScript>;
  /** Take lanes + comps per track span (shared/schema/takes.ts). Absent = none. Additive: no migration. */
  takeGroups?: Record<Id, TakeGroup>;
  /** Where recorded audio goes (Home ▸ Recording Studio): takes play through `insertId` and land on `trackId` when it
   * is free. Absent / null = a new insert per take and the first free track. Additive: no migration. */
  recording?: RecordingTarget;
}

export interface RecordingTarget {
  insertId: Id | null;
  trackId: Id | null;
}

// ── Defaults & helpers ────────────────────────────────────────────────

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

/** Effective pattern length in ticks (auto = content rounded up to a bar, min 1 bar). */
export function patternLength(p: Pattern, ts: TimeSig): number {
  const bar = (PPQ * 4 * ts.num) / ts.den;
  if (p.length != null && p.length > 0) return p.length;
  let end = 0;
  for (const byNote of Object.values(p.notes)) {
    for (const n of Object.values(byNote)) end = Math.max(end, n.tick + n.dur);
  }
  return Math.max(bar, Math.ceil(end / bar) * bar);
}

// ── Zod schema (load-time validation of untrusted JSON) ───────────────

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

/** Structural integrity checks zod can't express (dangling references). */
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

/** The mime a cover entry name implies (from its extension). */
export function coverMimeOf(file: string): 'image/png' | 'image/jpeg' | null {
  return /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : null;
}

/** Export tags from the meta: title falls back to the project name, artist to the author. */
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
