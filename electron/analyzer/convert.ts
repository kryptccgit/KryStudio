// Pure helpers: analyzer results (seconds) → document values (ticks, lanes).
// No I/O, so test/analyzer-service.test.ts checks the musical maths directly.

import type { Channel, Project } from '@shared/schema/project';
import type { PluginCatalog } from '@shared/plugins/types';
import type { DrumHit, DrumRole, TranscribedNote } from '@shared/analyzer/protocol';
import { PPQ, secondsToTicks, snapTick, TICKS_PER_STEP } from '@shared/schema/time';
import { isValidWarp, secToBeat, type WarpMarker } from '@shared/schema/warp';
import { AUDIOCLIP, audioTickBpm, genParam } from '@shared/analyzer/tempo';

// Shared with the commands and UI (shared/analyzer/tempo.ts). effectiveBpm =
// the tempo at which the clip's source seconds map to ticks (incl. stretch).
export { AUDIOCLIP, genParam, audioTickBpm as effectiveBpm } from '@shared/analyzer/tempo';

export interface TickNote {
  tick: number;
  key: number;
  dur: number;
  vel: number;
  /** Cents (-50..50): the part of the clip's pitch shift a whole key can't carry. */
  fine?: number;
}

/**
 * How an audio clip plays its source file, so transcribed notes land where (and at the pitch) the listener hears
 * them rather than where they sit in the raw file. Mirrors the engine's audio clip (docs/ENGINE_PROTOCOL.md §4).
 */
export interface ClipPlayback {
  /** The source's tick tempo (audioTickBpm: stretch, Follow tempo). */
  bpm: number;
  /** >= 2 warp markers: they define the timing instead of `bpm`. */
  markers?: WarpMarker[];
  /** The Stretch group's pitch shift, semitones (ignored in repitch). */
  semis?: number;
  /** Warp mode 'repitch': pitch follows the playback speed, measured against this project tempo. */
  repitchAt?: number;
  /** Reversed clip: the source file's length (s); the clip plays it from the end. */
  reverseSec?: number;
}

const playbackOf = (x: number | ClipPlayback): ClipPlayback => (typeof x === 'number' ? { bpm: x } : x);

/** The playback of a channel's source: audio clips bring stretch, warp, pitch and reverse; anything else plays as is. */
export function clipPlayback(p: Project, catalog: PluginCatalog, ch: Channel | null, sample: { frames?: number; sampleRate?: number } | null): ClipPlayback {
  const { bpm } = audioTickBpm(p, catalog, ch);
  if (!ch || ch.generator.type !== AUDIOCLIP) return { bpm };
  const warp = ch.generator.warp;
  const markers = warp && warp.markers.length >= 2 && isValidWarp(warp.markers) ? warp.markers : undefined;
  const durSec = sample?.frames && sample.sampleRate ? sample.frames / sample.sampleRate : 0;
  const pb: ClipPlayback = { bpm };
  if (markers) pb.markers = markers;
  if (warp?.mode === 'repitch') pb.repitchAt = p.transport.bpm;
  else pb.semis = genParam(catalog, ch, 'pitch', 0);
  if (genParam(catalog, ch, 'reverse', 0) >= 0.5 && durSec > 0) pb.reverseSec = durSec;
  return pb;
}

/** Source seconds → unsnapped ticks from the clip's source start (no reverse). */
function sourceTicks(pb: ClipPlayback, sec: number): number {
  const beat = pb.markers ? secToBeat(pb.markers, sec) : null;
  return beat !== null ? beat * PPQ : secondsToTicks(sec, pb.bpm);
}

/** Semitones the listener hears at source time `sec`: the pitch param, or in repitch the speed (2× = +12). */
export function heardSemis(pb: ClipPlayback, sec: number): number {
  if (!pb.repitchAt) return Number.isFinite(pb.semis) ? pb.semis! : 0;
  const d = 0.05;
  const s = Math.max(0, sec);
  const ticksPerSrcSec = (sourceTicks(pb, s + d) - sourceTicks(pb, s)) / d;
  const speed = ticksPerSrcSec > 0 ? secondsToTicks(1, pb.repitchAt) / ticksPerSrcSec : 1;
  return Number.isFinite(speed) && speed > 0 ? 12 * Math.log2(speed) : 0;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.78);

/** Seconds from the start of the source file → ticks at `bpm` or through a clip's playback (optionally snapped to `grid` ticks). */
export function secToTick(sec: number, play: number | ClipPlayback, grid = 0): number {
  const pb = playbackOf(play);
  const s = Math.max(0, pb.reverseSec ? pb.reverseSec - sec : sec);
  const t = Math.max(0, sourceTicks(pb, s));
  return grid > 1 ? Math.max(0, snapTick(t, grid)) : Math.round(t);
}

/**
 * Transcribed notes → pattern notes as the clip plays them: timing through `play` (a tempo, or the clip's stretch /
 * warp / reverse) and keys moved by the pitch shift the listener hears (whole keys, the rest in `fine` cents).
 */
export function notesToTicks(notes: TranscribedNote[], play: number | ClipPlayback, grid = 0): TickNote[] {
  const pb = playbackOf(play);
  const out: TickNote[] = [];
  for (const n of notes) {
    if (!Number.isFinite(n.startSec) || !Number.isFinite(n.durSec) || !Number.isInteger(n.key) || n.key < 0 || n.key > 127) continue;
    const a = secToTick(n.startSec, pb, grid);
    const b = secToTick(n.startSec + Math.max(0, n.durSec), pb, grid);
    const tick = Math.min(a, b); // reversed: the note's end comes first
    const pitch = n.key + heardSemis(pb, n.startSec + Math.max(0, n.durSec) / 2);
    const key = Math.round(pitch);
    if (key < 0 || key > 127) continue;
    const fine = Math.round((pitch - key) * 100);
    out.push({ tick, key, dur: Math.max(1, Math.abs(b - a) || (grid > 1 ? grid : 1)), vel: clamp01(n.vel), ...(fine ? { fine } : {}) });
  }
  return out.sort((a, b) => a.tick - b.tick || a.key - b.key);
}

export interface DrumRoleDef {
  role: DrumRole;
  /** Channel name created / reused in the project. */
  name: string;
  /** Factory kit sample. */
  sample: string;
  /** Krypt DrumSynth voice when the factory kit is missing. */
  voice: number;
  poly?: { cutGroup: number; cutBy: number };
}

export const DRUM_ROLES: DrumRoleDef[] = [
  { role: 'kick', name: 'Kick', sample: 'factory:drums/kick.wav', voice: 0 },
  { role: 'snare', name: 'Snare', sample: 'factory:drums/snare.wav', voice: 1 },
  { role: 'hat', name: 'Hat', sample: 'factory:drums/hat-closed.wav', voice: 3, poly: { cutGroup: 1, cutBy: 1 } },
  { role: 'openhat', name: 'Open Hat', sample: 'factory:drums/hat-open.wav', voice: 4, poly: { cutGroup: 1, cutBy: 1 } },
  { role: 'perc', name: 'Perc', sample: 'factory:drums/perc.wav', voice: 6 },
];

/** Drum hits → one tick list per role (one 16th long each, at `key`). */
export function hitsByRole(hits: DrumHit[], play: number | ClipPlayback, key: (role: DrumRole) => number, grid = 0): Map<DrumRole, TickNote[]> {
  const out = new Map<DrumRole, TickNote[]>();
  for (const h of hits) {
    if (!Number.isFinite(h.timeSec) || !DRUM_ROLES.some((r) => r.role === h.role)) continue;
    const list = out.get(h.role) ?? [];
    list.push({ tick: secToTick(h.timeSec, play, grid), key: key(h.role), dur: TICKS_PER_STEP, vel: clamp01(h.vel) });
    out.set(h.role, list);
  }
  for (const [role, list] of out) {
    // Two hits on the same tick (after snapping) would stack: keep the louder.
    const byTick = new Map<number, TickNote>();
    for (const n of list) {
      const prev = byTick.get(n.tick);
      if (!prev || n.vel > prev.vel) byTick.set(n.tick, n);
    }
    out.set(role, [...byTick.values()].sort((a, b) => a.tick - b.tick));
  }
  return out;
}

/** Channel name lookup for drum roles: exact (case-insensitive) or loose ("OpenHat", "open hat"). */
export function findChannelByName(p: Project, name: string): Channel | null {
  const loose = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const chans = p.channelOrder.map((id) => p.channels[id]).filter(Boolean);
  return chans.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? chans.find((c) => loose(c.name) === loose(name)) ?? null;
}
