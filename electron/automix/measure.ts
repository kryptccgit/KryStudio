// Auto Mix: measure the song (research/20 §3). One offline render of the
// scope with the engine's analysis, a file per insert (stems) and the gain
// reduction of every dynamics slot (Wave 12.2b), turned into the planner's
// PlanMeasure. The same render path as render_preview / review_song /
// match_mix (electron/mcp/tools/hearing.ts).

import type { Project } from '@shared/schema/project';
import { ticksPerBar } from '@shared/schema/time';
import type { Analysis } from '@shared/engine/protocol';
import type { AutoMixMeasure } from '@shared/automix/types';
import { toneOf, vocalVsBeat, type InsertMeasure, type PlanMeasure } from '@shared/automix/plan';
import type { InsertInfo } from '@shared/automix/roles';
import type { MainDeps } from '../mcp/types';
import { audibleSongEnd, renderAndAnalyse } from '../mcp/tools/hearing';
import { collectHeard } from '../mcp/tools/craftReview';

/** Longest song rendered whole; longer songs are measured on their fullest 32 bars. */
export const MAX_WHOLE_BARS = 128;
export const WINDOW_BARS = 32;

export interface Measured {
  measure: PlanMeasure;
  /** What was rendered ("the song (64 bars)", "bars 33-64"). */
  label: string;
}

/** bars: the range (default the whole audible song); stems false: the mix only (album songs); maxBars: the longest range allowed. */
export interface MeasureScope {
  bars?: string;
  stems?: boolean;
  maxBars?: number;
}

export type MeasureFn = (deps: MainDeps, scope: MeasureScope) => Promise<Measured>;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The bar range to measure: the request's, the whole audible song, or the fullest 32-bar window of a long one. */
export function measureScope(p: Project, bars?: string): { bars?: string } {
  if (bars?.trim()) return { bars: bars.trim() };
  const barTicks = ticksPerBar(p.transport.timeSig);
  const end = audibleSongEnd(p);
  const n = Math.ceil(end / barTicks);
  if (p.transport.mode !== 'song' || n <= MAX_WHOLE_BARS) return {};
  const heard = collectHeard(p, 0, end);
  const dens = heard.bars.map((b) => b.channels.size + b.audio);
  let best = 0;
  let bestSum = -1;
  for (let i = 0; i + WINDOW_BARS <= dens.length; i++) {
    const s = dens.slice(i, i + WINDOW_BARS).reduce((a, b) => a + b, 0);
    if (s > bestSum) {
      bestSum = s;
      best = i;
    }
  }
  return { bars: `${best + 1}-${best + WINDOW_BARS}` };
}

function insertMeasure(a: Analysis | null): InsertMeasure {
  if (!a) return { lufs: null, peakDb: null, crestDb: null, bands: null };
  return {
    lufs: isNum(a.lufsIntegrated) && a.lufsIntegrated > -70 ? a.lufsIntegrated : null,
    peakDb: isNum(a.peakDb) && a.peakDb > -100 ? a.peakDb : null,
    crestDb: isNum(a.crestDb) ? a.crestDb : null,
    bands: a.bands && isNum(a.bands.mid) ? { ...a.bands } : null,
    centroidHz: isNum(a.spectralCentroidHz) ? a.spectralCentroidHz : null,
  };
}

/** The real measurement: one render with analysis + stems (+ gain reduction). Throws with a human message. */
export const renderMeasure: MeasureFn = async (deps, scope) => {
  const args = scope.bars ? { scope: 'bars' as const, bars: scope.bars } : {};
  const out = await renderAndAnalyse(deps, args, { maxBars: Math.max(MAX_WHOLE_BARS, 160, scope.maxBars ?? 0), audibleSong: true, prefix: 'mixmatch', stems: scope.stems !== false });
  if (!out.ok) throw new Error(`the render failed: ${out.error ?? 'unknown error'}`);
  const a = out.raw;
  if (!a) throw new Error("this engine build returned no loudness / spectrum analysis, so there is nothing to measure (update or rebuild Krypt Studio's engine)");
  if (!isNum(a.lufsIntegrated) || a.lufsIntegrated < -60) throw new Error('the render is silent: nothing audible plays (muted tracks or channels, or no clips in range)');
  const inserts: Record<string, InsertMeasure> = {};
  for (const s of out.stems ?? []) inserts[s.insertId] = insertMeasure(s.analysis);
  return {
    label: out.plan.label,
    measure: {
      master: {
        lufs: a.lufsIntegrated,
        truePeak: a.truePeakDb,
        peakDb: isNum(a.peakDb) ? a.peakDb : null,
        crestDb: isNum(a.crestDb) ? a.crestDb : null,
        lra: a.loudnessRange,
        tone: toneOf(a.bands),
        correlation: a.stereoCorrelation,
        width: isNum(a.stereoWidth) ? a.stereoWidth : null,
      },
      inserts,
      gr: out.gainReduction ?? [],
    },
  };
};

const r1 = (x: number): number => Math.round(x * 10) / 10;

/** The contract's before / after numbers. */
export function publicMeasure(m: PlanMeasure, roles: Record<string, InsertInfo>): AutoMixMeasure {
  const t = m.master.tone;
  const vb = vocalVsBeat(m, roles);
  return {
    lufs: r1(m.master.lufs),
    truePeak: r1(m.master.truePeak),
    lra: r1(m.master.lra),
    tone: { sub: r1(t.sub), low: r1(t.low), lowMid: r1(t.lowMid), mid: 0, highMid: r1(t.highMid), high: r1(t.high) },
    correlation: Math.round(m.master.correlation * 100) / 100,
    width: isNum(m.master.width) ? Math.round(m.master.width * 100) / 100 : null,
    vocalVsBeat: vb ? vb.delta : null,
  };
}
