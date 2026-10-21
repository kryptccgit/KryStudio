import type { AudioAnalysis, DrumHit } from '../analyzer/protocol';
import type { Playbook, PlaybookSection, SectionKind } from '../playbooks/types';
import { planKinds, referenceSections } from '../reference/brief';
import type { PlannedSection } from '../reference/types';
import { PPQ } from '../schema/time';
import type { GridChord, GridNote, TranscribedPart, TranscribedSection } from './types';
import type { TranscriptionGrid } from './grid';

export const PHRASE = 4;
export const SAME_AS_MIN = 0.85;
const PEAK_LU = 1.8;
const BREAKS: SectionKind[] = ['break', 'breakdown', 'bridge'];

export const KIND_LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Verse',
  pre: 'Pre',
  hook: 'Hook',
  chorus: 'Chorus',
  build: 'Build',
  drop: 'Drop',
  breakdown: 'Breakdown',
  bridge: 'Bridge',
  break: 'Break',
  outro: 'Outro',
};

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r1 = (x: number) => Math.round(x * 10) / 10;

function meanLufs(items: Array<{ lufs: number; w: number }>): number {
  const tot = items.reduce((s, x) => s + x.w, 0);
  if (tot <= 0) return items[0]?.lufs ?? -60;
  const p = items.reduce((s, x) => s + x.w * Math.pow(10, Math.max(-70, x.lufs) / 10), 0) / tot;
  return r1(10 * Math.log10(Math.max(1e-7, p)));
}

export function snapPhrases(starts: number[], totalBars: number): number[] {
  const s = starts.slice();
  for (let i = 0; i + 1 < s.length; i++) {
    const len = s[i + 1] - s[i];
    const r = len % PHRASE;
    if (len < 3 || (r !== 1 && r !== 3)) continue;
    const target = s[i] + Math.round(len / PHRASE) * PHRASE;
    const limit = i + 2 < s.length ? s[i + 2] : totalBars;
    if (target > s[i] && target < limit) s[i + 1] = target;
  }
  return s;
}

function genericArrangement(peak: SectionKind): PlaybookSection[] {
  const sec = (kind: SectionKind, energy: number): PlaybookSection => ({ kind, label: KIND_LABEL[kind], bars: 8, energy, parts: [] });
  return [sec('intro', 0.4), sec('verse', 0.6), sec('build', 0.7), sec(peak, 1), sec('break', 0.4), sec('outro', 0.35)];
}

export interface SectionInput {
  analysis: AudioAnalysis;
  grid: TranscriptionGrid;
  hits: readonly DrumHit[];
  playbook: Pick<Playbook, 'arrangement'> | null;
  peak: SectionKind;
}

export interface SectionsResult {
  sections: TranscribedSection[];
  kinds: SectionKind[];
}

export function songSections(inp: SectionInput): SectionsResult {
  const g = inp.grid;
  const total = g.totalBars;
  const ref = referenceSections(inp.analysis, inp.hits.length ? (inp.hits as DrumHit[]) : null);
  const barOf = (sec: number) => Math.max(0, Math.min(total, Math.round(g.toTick(sec) / g.ticksPerBar)));
  type Cut = { bar: number; label: string; parts: Array<{ lufs: number; w: number }> };
  const cuts: Cut[] = [];
  for (const s of ref) {
    const at = barOf(s.startSec);
    const part = { lufs: s.lufs, w: Math.max(0.1, s.endSec - s.startSec) };
    const last = cuts[cuts.length - 1];
    if (!last) cuts.push({ bar: 0, label: s.label, parts: [part] });
    else if (at <= last.bar || at >= total) {
      last.parts.push(part);
      if (part.w > last.parts.slice(0, -1).reduce((x, p) => x + p.w, 0)) last.label = s.label;
    } else cuts.push({ bar: at, label: s.label, parts: [part] });
  }
  if (!cuts.length) {
    const lufs = isNum(inp.analysis.levels?.lufsIntegrated) ? r1(inp.analysis.levels.lufsIntegrated) : -14;
    cuts.push({ bar: 0, label: 'A', parts: [{ lufs, w: 1 }] });
  }
  const starts = snapPhrases(
    cuts.map((c) => c.bar),
    total,
  );
  const kickTicks = inp.hits.filter((h) => h && h.role === 'kick' && isNum(h.timeSec)).map((h) => g.toTick(h.timeSec));
  const plan = cuts.map((c, i) => {
    const startBar = starts[i];
    const bars = (i + 1 < cuts.length ? starts[i + 1] : total) - startBar;
    const a = startBar * g.ticksPerBar;
    const b = (startBar + bars) * g.ticksPerBar;
    const kicks = kickTicks.length ? kickTicks.filter((t) => t >= a - PPQ / 8 && t < b - PPQ / 8).length / Math.max(1, bars) : null;
    return { label: c.label, startBar: startBar + 1, bars, lufs: meanLufs(c.parts), kick: kicks, energy: 0 };
  });
  const live = plan.filter((p) => p.bars > 0);
  const top = Math.max(...live.map((p) => p.lufs));
  const topKick = Math.max(0, ...live.map((p) => p.kick ?? 0));
  for (const p of live) {
    const loud = 1 - (top - p.lufs) / 10;
    const kick = topKick >= 1 && p.kick !== null ? Math.min(1, p.kick / topKick) : 1;
    p.energy = Math.max(0.1, Math.round(loud * (0.6 + 0.4 * kick) * 20) / 20);
  }
  const planned: PlannedSection[] = live.map((p) => ({ label: p.label, startBar: p.startBar, bars: p.bars, lufs: p.lufs, energy: p.energy }));
  const kinds: SectionKind[] = planned.length === 1 ? ['verse'] : planKinds(planned, inp.playbook ?? { arrangement: genericArrangement(inp.peak) });
  const firstPeak = planned.findIndex((p) => p.energy >= 1 - PEAK_LU / 10);
  for (let i = 1; i < (firstPeak < 0 ? 0 : firstPeak); i++) if (BREAKS.includes(kinds[i])) kinds[i] = kinds.slice(0, i).every((k) => k === 'intro') && planned[i].energy <= 0.35 ? 'intro' : 'verse';
  const count = new Map<SectionKind, number>();
  for (const k of kinds) count.set(k, (count.get(k) ?? 0) + 1);
  const seen = new Map<SectionKind, number>();
  const sections: TranscribedSection[] = planned.map((p, i) => {
    const k = kinds[i];
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { label: p.label, name: (count.get(k) ?? 1) > 1 ? `${KIND_LABEL[k]} ${n}` : KIND_LABEL[k], startBar: p.startBar, bars: p.bars, energy: p.energy, lufs: p.lufs, sameAs: null };
  });
  return { sections, kinds };
}

function cosine(a: Map<number, number>, b: Map<number, number>): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (const [k, v] of a) {
    aa += v * v;
    ab += v * (b.get(k) ?? 0);
  }
  for (const v of b.values()) bb += v * v;
  if (aa < 1e-9 && bb < 1e-9) return 1;
  if (aa < 1e-9 || bb < 1e-9) return 0;
  return ab / Math.sqrt(aa * bb);
}

function cells(notes: readonly GridNote[], from: number, to: number, pitched: boolean): Map<number, number> {
  const m = new Map<number, number>();
  const step = PPQ / 4;
  for (const n of notes) {
    if (n.tick < from - step / 2 || n.tick >= to - step / 2) continue;
    const c = Math.max(0, Math.round((n.tick - from) / step));
    const id = pitched ? c * 128 + n.key : c;
    m.set(id, Math.max(m.get(id) ?? 0, n.vel || 0.5));
  }
  return m;
}

function partsSimilarity(parts: readonly TranscribedPart[], a: [number, number], b: [number, number], pitched: boolean): number | null {
  let w = 0;
  let s = 0;
  for (const p of parts) {
    const ca = cells(p.notes, a[0], a[1], pitched);
    const cb = cells(p.notes, b[0], b[1], pitched);
    const n = ca.size + cb.size;
    if (!n) continue;
    w += n;
    s += n * cosine(ca, cb);
  }
  return w ? s / w : null;
}

function chordSimilarity(chords: readonly GridChord[], a: [number, number], b: [number, number]): number | null {
  const at = (t: number) => {
    const c = chords.find((x) => x.tick <= t && t < x.tick + x.dur);
    return c ? c.name : '';
  };
  let same = 0;
  let n = 0;
  let any = false;
  for (let t = 0; a[0] + t < a[1]; t += PPQ) {
    const x = at(a[0] + t);
    const y = at(b[0] + t);
    if (x || y) any = true;
    same += x === y ? 1 : 0;
    n++;
  }
  return any && n ? same / n : null;
}

export interface SameAsOptions {
  pitched: boolean;
}

export function linkSameAs(sections: TranscribedSection[], parts: readonly TranscribedPart[], chords: readonly GridChord[], ticksPerBar: number, opts: SameAsOptions): number[] {
  const drums = parts.filter((p) => p.kind === 'drum');
  const pitchedParts = parts.filter((p) => p.kind === 'bass' || p.kind === 'lead');
  const span = (s: TranscribedSection): [number, number] => [(s.startBar - 1) * ticksPerBar, (s.startBar - 1 + s.bars) * ticksPerBar];
  const sims: number[] = [];
  sections.forEach((s, i) => {
    s.sameAs = null;
    for (let j = 0; j < i; j++) {
      const o = sections[j];
      if (o.sameAs !== null || o.label !== s.label || o.bars !== s.bars) continue;
      const d = partsSimilarity(drums, span(o), span(s), false);
      const c = chordSimilarity(chords, span(o), span(s));
      const known = [d, c].filter((x): x is number => x !== null);
      const sim = known.length ? known.reduce((x, y) => x + y, 0) / known.length : 1;
      if (sim < SAME_AS_MIN) continue;
      if (opts.pitched) {
        const p = partsSimilarity(pitchedParts, span(o), span(s), true);
        if (p !== null && p < SAME_AS_MIN) continue;
      }
      s.sameAs = j;
      sims.push(Math.round(sim * 100) / 100);
      break;
    }
  });
  return sims;
}
