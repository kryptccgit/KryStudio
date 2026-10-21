import type { DrumRole } from '../analyzer/protocol';
import type { DrumGrid } from '../library/types';
import type { Playbook } from '../playbooks/types';
import { parse, type KpnNote, type KpnParseResult } from '../kpn';
import type { DrumFeel } from './types';

export const FEEL_ROLES: readonly DrumRole[] = ['kick', 'snare', 'hat', 'openhat', 'perc'];

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function gridSteps16(grid: DrumGrid, factor: number): Partial<Record<DrumRole, number[]>> {
  const out: Partial<Record<DrumRole, number[]>> = {};
  if (!grid.bars) return out;
  for (const role of FEEL_ROLES) {
    const c = grid.counts[role];
    if (!c) continue;
    const p = c.map((x) => Math.max(0, Math.min(1, x / grid.bars)));
    const s = new Array<number>(16).fill(0);
    for (let i = 0; i < 16; i++) {
      if (factor >= 1.5) s[i] = (p[i] + p[16 + i]) / 2;
      else if (factor <= 0.75) {
        const j = (i % 8) * 4;
        s[i] = Math.max(p[j], p[j + 1], p[j + 2], p[j + 3]);
      } else s[i] = Math.max(p[2 * i], p[2 * i + 1]);
    }
    if (s.some((x) => x > 0)) out[role] = s.map(r2);
  }
  return out;
}

export function hitsPerBar(steps: number[] | undefined): number {
  return steps ? steps.reduce((a, b) => a + b, 0) : 0;
}

export function drumFeel(grid: DrumGrid, factor: number, detectedBpm: number, beatsPerBar: number): DrumFeel {
  const steps = gridSteps16(grid, factor);
  const k = steps.kick ?? [];
  const sn = steps.snare ?? [];
  const fourOnFloor = [0, 4, 8, 12].every((i) => (k[i] ?? 0) >= 0.6);
  const two = Math.min(sn[4] ?? 0, sn[12] ?? 0);
  const three = sn[8] ?? 0;
  const backbeat = two >= 0.5 && two >= three * 0.8 ? 'two-four' : three >= 0.5 && three > Math.max(sn[4] ?? 0, sn[12] ?? 0) * 1.5 ? 'three' : 'none';
  const minutes = (grid.bars * beatsPerBar) / Math.max(1, detectedBpm);
  const rollsPerMin = minutes > 0 ? Math.round((grid.rolls / minutes) * 10) / 10 : 0;
  const hatHits = hitsPerBar(steps.hat);
  const hats = rollsPerMin >= 4 ? '32nds' : hatHits >= 10 ? '16ths' : hatHits >= 5 ? '8ths' : hatHits > 0.5 ? 'sparse' : 'none';
  return { source: grid.source, bars: grid.bars, steps, fourOnFloor, backbeat, hats, rollsPerMin };
}

export function feelLine(steps: number[]): string {
  const ch = steps.map((p) => (p < 0.05 ? '.' : String(Math.min(9, Math.max(1, Math.round(p * 10))))));
  return [0, 4, 8, 12].map((i) => ch.slice(i, i + 4).join('')).join(' ');
}

export interface PlaybookDrums {
  steps: Partial<Record<DrumRole, number[]>>;
  bars: number;
}

const PART_TO_FEEL: Record<string, DrumRole | undefined> = { kick: 'kick', snare: 'snare', clap: 'snare', hat: 'hat', openhat: 'openhat', perc: 'perc', rim: 'perc', tom: 'perc' };
const pbCache = new WeakMap<Playbook, PlaybookDrums | null>();

export function playbookDrums(pb: Playbook): PlaybookDrums | null {
  if (pbCache.has(pb)) return pbCache.get(pb) ?? null;
  const counts: Partial<Record<DrumRole, number[]>> = {};
  let bars = 0;
  for (const pat of pb.patterns) {
    let r: KpnParseResult;
    try {
      r = parse(pat.kpn, { requireHeader: true });
    } catch {
      continue;
    }
    if (!r.ok || !r.barTicks) continue;
    const drumTracks = r.tracks
      .map((t) => {
        const name = t.name.replace(/\/\d+$/, '').trim().toLowerCase();
        const part = pb.parts.find((x) => x.name.toLowerCase() === name);
        const role = part ? (PART_TO_FEEL[part.role] ?? (part.sample ? PART_TO_FEEL[part.sample] : undefined)) : undefined;
        return role ? { role, notes: t.notes } : null;
      })
      .filter((x): x is { role: DrumRole; notes: KpnNote[] } => !!x);
    if (!drumTracks.length) continue;
    const n = Math.max(1, r.bars);
    bars += n;
    for (const { role, notes } of drumTracks) {
      const hit = new Set<number>();
      for (const note of notes) {
        const bar = Math.floor(note.tick / r.barTicks);
        if (bar >= n) continue;
        const step = Math.round((note.tick - bar * r.barTicks) / (r.barTicks / 16)) % 16;
        hit.add(bar * 16 + step);
      }
      const c = (counts[role] ??= new Array<number>(16).fill(0));
      for (const g of hit) c[g % 16]++;
    }
  }
  const out = bars ? { steps: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v!.map((x) => r2(x / bars))])) as PlaybookDrums['steps'], bars } : null;
  pbCache.set(pb, out);
  return out;
}

export function cosine(a: number[] | undefined, b: number[] | undefined): number {
  const x = a ?? [];
  const y = b ?? [];
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < 16; i++) {
    ab += (x[i] ?? 0) * (y[i] ?? 0);
    aa += (x[i] ?? 0) ** 2;
    bb += (y[i] ?? 0) ** 2;
  }
  if (aa < 1e-9 && bb < 1e-9) return 1;
  if (aa < 1e-9 || bb < 1e-9) return 0;
  return ab / Math.sqrt(aa * bb);
}
