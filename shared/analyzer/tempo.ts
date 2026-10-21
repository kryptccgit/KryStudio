import type { Channel, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';

export const AUDIOCLIP = 'krypt.audioclip';

export function genParam(catalog: PluginCatalog, ch: Channel, id: string, fallback = 0): number {
  const v = ch.generator.params[id];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const spec = catalog.plugins.find((p) => p.id === ch.generator.type)?.params.find((s) => s.id === id);
  return spec ? spec.default : fallback;
}

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

export function snapBpm(bpm: number): number {
  const r = Math.round(bpm);
  return Math.abs(bpm - r) < 0.15 ? r : Math.round(bpm * 100) / 100;
}

export function syncBpm(tempo: { bpm: number; alternatives?: number[] }, projectBpm: number): number {
  const near = Math.log2(1.25);
  const dist = (b: number) => Math.abs(Math.log2(b / projectBpm));
  if (!(projectBpm > 0) || !(tempo.bpm > 0) || dist(tempo.bpm) <= near) return snapBpm(tempo.bpm);
  const cands = [tempo.bpm * 2, tempo.bpm / 2, ...(tempo.alternatives ?? [])].filter((b) => Number.isFinite(b) && b >= 10 && b <= 999 && dist(b) <= near);
  if (!cands.length) return snapBpm(tempo.bpm);
  return snapBpm(cands.reduce((best, b) => (dist(b) < dist(best) ? b : best)));
}

export interface TempoReading {
  bpm: number;
  detected: number;
  reading: 'as detected' | 'double time' | 'half time' | 'alternative';
  ratio: number;
}

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
