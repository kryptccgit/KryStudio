// Tempo maths for audio clips, shared by the commands, the analyzer service,
// the MCP tools and the UI so they agree on where audio sits on the timeline.
// Mirrors the engine's audio-clip stretch (docs/ENGINE_PROTOCOL.md §4):
// output duration = source duration × stretch × (tempo_sync ? src_bpm / project bpm : 1).

import type { Channel, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';

export const AUDIOCLIP = 'krypt.audioclip';

/** A generator param's value (sparse params: missing = catalog default, else `fallback`). */
export function genParam(catalog: PluginCatalog, ch: Channel, id: string, fallback = 0): number {
  const v = ch.generator.params[id];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const spec = catalog.plugins.find((p) => p.id === ch.generator.type)?.params.find((s) => s.id === id);
  return spec ? spec.default : fallback;
}

/**
 * The tempo at which a channel's source audio maps onto ticks
 * (tick = seconds × bpm / 60 × PPQ): `stretch × src_bpm` when the audio clip
 * follows the project tempo, else `stretch × project bpm`. `synced` = the
 * mapping no longer depends on the project tempo.
 */
export function audioTickBpm(p: Project, catalog: PluginCatalog, ch: Channel | null | undefined): { bpm: number; synced: boolean } {
  if (ch && ch.generator.type === AUDIOCLIP) {
    const stretch = genParam(catalog, ch, 'stretch', 1) > 0 ? genParam(catalog, ch, 'stretch', 1) : 1;
    const sync = genParam(catalog, ch, 'tempo_sync', 0) >= 0.5;
    const src = genParam(catalog, ch, 'src_bpm', 0);
    if (sync && src > 0) return { bpm: src * stretch, synced: true };
    return { bpm: p.transport.bpm * stretch, synced: false };
  }
  return { bpm: p.transport.bpm, synced: false };
}

/** A detected tempo worth typing in: near-whole values snap to whole BPM. */
export function snapBpm(bpm: number): number {
  const r = Math.round(bpm);
  return Math.abs(bpm - r) < 0.15 ? r : Math.round(bpm * 100) / 100;
}

/**
 * The reading of a detected tempo to sync a clip with. Tempo detectors often
 * land an octave off (70 for a 140 trap beat), and half / double time is the
 * same pulse musically, so when the detection is far from the project tempo
 * (beyond ±25%) but one of its octave readings (or listed alternatives) is
 * within it, that reading is used: it stretches least. Otherwise the
 * detection stands (a real 93 bpm loop in a 140 project stays 93). Snapped
 * like snapBpm.
 */
export function syncBpm(tempo: { bpm: number; alternatives?: number[] }, projectBpm: number): number {
  const near = Math.log2(1.25);
  const dist = (b: number) => Math.abs(Math.log2(b / projectBpm));
  if (!(projectBpm > 0) || !(tempo.bpm > 0) || dist(tempo.bpm) <= near) return snapBpm(tempo.bpm);
  const cands = [tempo.bpm * 2, tempo.bpm / 2, ...(tempo.alternatives ?? [])].filter((b) => Number.isFinite(b) && b >= 10 && b <= 999 && dist(b) <= near);
  if (!cands.length) return snapBpm(tempo.bpm);
  return snapBpm(cands.reduce((best, b) => (dist(b) < dist(best) ? b : best)));
}

export interface TempoReading {
  /** The source tempo to sync from (src_bpm). */
  bpm: number;
  /** The detected tempo, snapped. */
  detected: number;
  /** How `bpm` relates to the detection. */
  reading: 'as detected' | 'double time' | 'half time' | 'alternative';
  /** Playback speed when following `targetBpm` (target / bpm): 1 = unchanged. */
  ratio: number;
}

/**
 * The source tempo to sync a clip from so it follows `targetBpm` with the
 * least stretch. syncBpm's reading when it lands within ±25% of the target;
 * otherwise the octave reading (or listed alternative) that stretches least,
 * even beyond ±25% (a 96 bpm vocal follows 142 bpm best read as 192 double
 * time: ×0.74 instead of ×1.48). Used by match_clip, where the source is
 * meant to sit on someone else's beat.
 */
export function matchBpm(tempo: { bpm: number; alternatives?: number[] }, targetBpm: number): TempoReading {
  const detected = snapBpm(tempo.bpm);
  const label = (b: number): TempoReading['reading'] => {
    if (Math.abs(b - detected) < 0.01) return 'as detected';
    if (Math.abs(b - snapBpm(tempo.bpm * 2)) < 0.01) return 'double time';
    if (Math.abs(b - snapBpm(tempo.bpm / 2)) < 0.01) return 'half time';
    return 'alternative';
  };
  const out = (b: number): TempoReading => ({ bpm: b, detected, reading: label(b), ratio: targetBpm > 0 && b > 0 ? targetBpm / b : 1 });
  if (!(targetBpm > 0) || !(tempo.bpm > 0)) return out(detected);
  const synced = syncBpm(tempo, targetBpm);
  const dist = (b: number) => Math.abs(Math.log2(b / targetBpm));
  if (dist(synced) <= Math.log2(1.25) + 1e-9) return out(synced);
  const cands = [tempo.bpm, tempo.bpm * 2, tempo.bpm / 2, ...(tempo.alternatives ?? [])].filter((b) => Number.isFinite(b) && b >= 10 && b <= 999);
  const best = cands.reduce((a, b) => (dist(b) < dist(a) - 1e-9 ? b : a), tempo.bpm);
  return out(snapBpm(best));
}
