// ──────────────────────────────────────────────────────────────────────
// Vocals & mashups: the pure half of "auto-tune a vocal" and "match a clip
// to the project / another clip". No I/O and no analysis: the main-side
// service (electron/vocals) analyses the audio, then turns the decisions
// below into commands, so MCP tools, the clip menu and the browser mock all
// produce the same edits.
//
//   planTune          add Krypt Tune first in an insert's chain, or update
//                     the one that is there (never a duplicate)
//   patternKey        the key of the project's pitched notes
//   keySources        which other audio clips stand for "the instrumental"
//   rescaleForTempo   keep audio that doesn't follow the tempo in place
//                     when the project tempo changes
// ──────────────────────────────────────────────────────────────────────

import type { Channel, Clip, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';
import { AUDIOCLIP, audioTickBpm, genParam } from '../analyzer/tempo';
import { estimateKey } from '../kpn/symbolic';
import { TUNE_EFFECT, TUNE_STYLES, toKeyRef, type KeyRef, type TuneKey, type TuneStyle } from '../music/keymatch';

export interface Step {
  cmd: string;
  args: Record<string, unknown>;
}

/** A detected key below this confidence is "weak": another source is tried first. */
export const KEY_WEAK = 0.45;
/** An insert holds at most this many effects (shared/commands/mixer.ts). */
const MAX_FX = 10;

export function audioClipsOf(p: Project, channelId: string): Clip[] {
  return Object.values(p.playlist.clips)
    .filter((c) => c.kind === 'audio' && c.channelId === channelId)
    .sort((a, b) => a.start - b.start);
}

/** The Audio Clip pitch shift of a channel in whole semitones (0 for other instruments). */
export function channelPitch(catalog: PluginCatalog, ch: Channel): number {
  if (ch.generator.type !== AUDIOCLIP) return 0;
  const v = genParam(catalog, ch, 'pitch', 0);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/** Does this audio-clip channel follow the project tempo (tempo sync on with a source tempo)? */
export function followsTempo(catalog: PluginCatalog, ch: Channel): boolean {
  return ch.generator.type === AUDIOCLIP && genParam(catalog, ch, 'tempo_sync', 0) >= 0.5 && genParam(catalog, ch, 'src_bpm', 0) > 0;
}

/** The channel playing the mix a stem was separated from, while it is still in the project. */
export function parentChannel(p: Project, ch: Channel): Channel | null {
  const sid = ch.generator.sampleId;
  const parentId = sid ? p.samples[sid]?.origin?.parentSampleId : undefined;
  if (!parentId) return null;
  return p.channelOrder.map((id) => p.channels[id]).find((c) => c && c.id !== ch.id && c.generator.sampleId === parentId) ?? null;
}

/** The sample a channel's audio comes from, following stems to their source mix (two stems of one song share it). */
export function songOf(p: Project, ch: Channel): string | null {
  const sid = ch.generator.sampleId;
  if (!sid) return null;
  return p.samples[sid]?.origin?.parentSampleId ?? sid;
}

// ── Krypt Tune ────────────────────────────────────────────────────────

export interface TunePlan {
  insertId: string;
  /** The Krypt Tune slot that is updated, or null when a new one is added. */
  slotId: string | null;
  /** 0-based chain position it ends up at. */
  index: number;
  params: Record<string, number>;
  /** An existing Tune was bypassed and gets switched back on. */
  enable: boolean;
  /** Effect types after it in the chain (for "before EQ → Comp"). */
  after: string[];
  /** Further Krypt Tune slots on the insert (left alone). */
  extra: number;
  steps: Step[];
}

/**
 * Krypt Tune on an insert: update the Tune that is already there (params,
 * switched back on if bypassed), else add one FIRST in the chain so it
 * corrects the raw vocal before any EQ, compressor or space effect.
 * Throws an Error with a human message (master insert, full chain).
 */
export function planTune(p: Project, insertId: string, key: TuneKey, style: TuneStyle, opts: { amount?: number; mix?: number } = {}): TunePlan {
  const ins = p.mixer.inserts[insertId];
  if (!ins) throw new Error('That mixer insert no longer exists');
  if (ins.isMaster) throw new Error('This audio plays straight into the Master: route it to its own mixer insert first, so the correction only touches the vocal');
  const preset = TUNE_STYLES[style];
  if (!preset) throw new Error(`Unknown style "${style}": use natural, pop or hard`);
  const params: Record<string, number> = {
    root: key.root,
    scale: key.scale,
    speed: preset.speed,
    humanize: preset.humanize,
    amount: clamp01(opts.amount ?? 1),
  };
  if (opts.mix !== undefined) params.mix = clamp01(opts.mix);
  const tunes = ins.slotOrder.filter((s) => ins.slots[s]?.type === TUNE_EFFECT);
  if (tunes.length) {
    const slotId = tunes[0];
    const slot = ins.slots[slotId];
    const index = ins.slotOrder.indexOf(slotId);
    const steps: Step[] = [{ cmd: 'mixer.setSlotParams', args: { insertId, slotId, params } }];
    if (!slot.enabled) steps.push({ cmd: 'mixer.setSlot', args: { insertId, slotId, enabled: true } });
    return { insertId, slotId, index, params, enable: !slot.enabled, after: ins.slotOrder.slice(index + 1).map((s) => ins.slots[s].type), extra: tunes.length - 1, steps };
  }
  if (ins.slotOrder.length >= MAX_FX) throw new Error(`"${ins.name}" already has ${MAX_FX} effects (the most an insert holds): remove one first`);
  return {
    insertId,
    slotId: null,
    index: 0,
    params,
    enable: false,
    after: ins.slotOrder.map((s) => ins.slots[s].type),
    extra: 0,
    steps: [{ cmd: 'mixer.addSlot', args: { insertId, type: TUNE_EFFECT, index: 0, params } }],
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

// ── Keys from the project ─────────────────────────────────────────────

/** Instruments whose notes are not pitches (drum hits, audio clip triggers). */
const UNPITCHED = new Set(['krypt.sampler', 'krypt.drumsynth', AUDIOCLIP]);

export interface PatternKey {
  key: KeyRef;
  name: string;
  confidence: number;
  notes: number;
}

/**
 * The key of the project's pitched notes (Krumhansl–Schmuckler on
 * duration-weighted pitch classes): the patterns placed on the Playlist
 * (unmuted), or every pattern when none is placed. Drum and sample channels
 * are ignored. null below `minNotes` pitched notes.
 */
export function patternKey(p: Project, minNotes = 8): PatternKey | null {
  const muted = new Set(p.playlist.trackOrder.filter((t) => p.playlist.tracks[t]?.mute));
  const placed = Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId && !c.mute && !muted.has(c.trackId) && p.patterns[c.patternId]);
  const patternIds = placed.length ? [...new Set(placed.map((c) => c.patternId!))] : p.patternOrder;
  const weights = new Array(12).fill(0);
  let notes = 0;
  for (const pid of patternIds) {
    const pat = p.patterns[pid];
    if (!pat) continue;
    for (const [chId, byId] of Object.entries(pat.notes)) {
      const ch = p.channels[chId];
      if (!ch || ch.mute || UNPITCHED.has(ch.generator.type)) continue;
      for (const n of Object.values(byId)) {
        weights[((n.key % 12) + 12) % 12] += Math.max(1, n.dur);
        notes++;
      }
    }
  }
  if (notes < minNotes) return null;
  const est = estimateKey(weights);
  const key = est ? toKeyRef(est.key) : null;
  if (!est || !key) return null;
  return { key, name: est.key, confidence: est.confidence, notes };
}

/**
 * The key of a transcribed melodic line (a vocal's notes): Krumhansl–Schmuckler on duration-weighted pitch
 * classes. Steadier than a chroma reading for a single detuned or vibrato-heavy voice, whose harmonics and
 * in-between pitches smear the chroma. null below `minNotes` notes.
 */
export function notesKey(notes: Array<{ key: number; durSec: number }>, minNotes = 8): PatternKey | null {
  const weights = new Array(12).fill(0);
  let count = 0;
  for (const n of notes) {
    if (!Number.isFinite(n.key) || !(n.durSec > 0)) continue;
    weights[((Math.round(n.key) % 12) + 12) % 12] += n.durSec;
    count++;
  }
  if (count < minNotes) return null;
  const est = estimateKey(weights);
  const key = est ? toKeyRef(est.key) : null;
  return est && key ? { key, name: est.key, confidence: est.confidence, notes: count } : null;
}

export interface KeySource {
  /** The audio clip that stands for this part of the project. */
  clip: Clip;
  channel: Channel;
  /** What to analyse: the stem's source mix when it is still in the project (a steadier key), else the channel itself. */
  analyseChannelId: string;
  /** Semitones the listener hears it shifted by (the clip channel's pitch). */
  pitch: number;
  /** Source sample id (stems → their mix): one KeySource per song. */
  song: string;
}

/**
 * Audio clips that make up "the rest of the project" for key detection,
 * longest first, one per song: unmuted audio clips on unmuted tracks, not
 * on `excludeChannels`, and not from `excludeSongs` (e.g. the vocal's own
 * song when it is being moved onto someone else's).
 */
export function keySources(p: Project, catalog: PluginCatalog, excludeChannels: Set<string>, excludeSongs: Set<string> = new Set()): KeySource[] {
  const mutedTracks = new Set(p.playlist.trackOrder.filter((t) => p.playlist.tracks[t]?.mute));
  const byChannel = new Map<string, { clip: Clip; total: number }>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'audio' || !c.channelId || c.mute || mutedTracks.has(c.trackId) || excludeChannels.has(c.channelId)) continue;
    const ch = p.channels[c.channelId];
    if (!ch || ch.mute || !ch.generator.sampleId) continue;
    const cur = byChannel.get(c.channelId);
    byChannel.set(c.channelId, { clip: cur && cur.clip.length >= c.length ? cur.clip : c, total: (cur?.total ?? 0) + c.length });
  }
  const seen = new Set<string>();
  const out: KeySource[] = [];
  for (const [chId, v] of [...byChannel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const ch = p.channels[chId];
    const song = songOf(p, ch) ?? chId;
    if (excludeSongs.has(song) || seen.has(song)) continue;
    seen.add(song);
    const parent = parentChannel(p, ch);
    out.push({ clip: v.clip, channel: ch, analyseChannelId: parent?.id ?? ch.id, pitch: channelPitch(catalog, ch), song });
  }
  return out;
}

// ── Tempo changes ─────────────────────────────────────────────────────

/**
 * When the project tempo changes from `fromBpm` to `toBpm`, audio clips that
 * play at their own speed (no tempo sync) would cover a different stretch of
 * audio. One playlist.updateClips step that rescales them (start kept;
 * length, offset and fades follow), or null when there are none.
 */
export function rescaleForTempo(p: Project, catalog: PluginCatalog, fromBpm: number, toBpm: number, skipChannels: Set<string> = new Set()): Step | null {
  if (!(fromBpm > 0) || !(toBpm > 0) || Math.abs(toBpm / fromBpm - 1) < 1e-9) return null;
  const f = toBpm / fromBpm;
  const updates: Array<Record<string, unknown>> = [];
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'audio' || !c.channelId || skipChannels.has(c.channelId)) continue;
    const ch = p.channels[c.channelId];
    if (!ch || ch.generator.type !== AUDIOCLIP || audioTickBpm(p, catalog, ch).synced) continue;
    const u: Record<string, unknown> = { id: c.id, length: Math.max(1, Math.round(c.length * f)), offset: Math.max(0, Math.round(c.offset * f)) };
    if (c.fadeIn) u.fadeIn = Math.max(0, Math.round(c.fadeIn * f));
    if (c.fadeOut) u.fadeOut = Math.max(0, Math.round(c.fadeOut * f));
    updates.push(u);
  }
  return updates.length ? { cmd: 'playlist.updateClips', args: { updates } } : null;
}
