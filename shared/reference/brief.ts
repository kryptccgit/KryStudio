import type { AudioAnalysis, ChordQuality, DrumHit } from '../analyzer/protocol';
import type { BeatChord, DrumGrid } from '../library/types';
import type { Playbook, PlaybookSection, PlaybookTargets, SectionKind, TransitionKind } from '../playbooks/types';
import { beatsPerBar, chordsToBeats, drumGrid, secToBeat } from '../library/grid';
import { canonicalLoop, normaliseForm, romanNumeral } from '../library/profile';
import { parseKey } from '../music/theory';
import { genreInfo, sameFamily, type GenreId } from '../sounds/genres';
import { drumFeel, feelLine, FEEL_ROLES } from './drums';
import { guessGenres, guessLine, readingFor } from './genre';
import type { PlannedSection, ReferenceBrief, ReferenceSection } from './types';

export const MAX_PLAN_BARS = 256;
const PHRASE = 4;
const PEAK_LU = 1.8;
const MIN_KICK_RATE = 1;

const r1 = (x: number): number => Math.round(x * 10) / 10;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const mod12 = (x: number): number => ((x % 12) + 12) % 12;

function meanLufs(items: Array<{ lufs: number; w: number }>): number {
  const tot = items.reduce((s, x) => s + x.w, 0);
  if (tot <= 0) return items[0]?.lufs ?? -60;
  const p = items.reduce((s, x) => s + x.w * Math.pow(10, Math.max(-70, x.lufs) / 10), 0) / tot;
  return r1(10 * Math.log10(Math.max(1e-7, p)));
}

export function referenceSections(a: AudioAnalysis, hits?: readonly DrumHit[] | null): ReferenceSection[] {
  const raw = (a.sections ?? []).filter((s) => s && isNum(s.startSec) && isNum(s.endSec) && s.endSec > s.startSec).sort((x, y) => x.startSec - y.startSec);
  const names = new Map<string, string>();
  const kicks = hits?.length ? hits.filter((h) => h && h.role === 'kick' && isNum(h.timeSec)).map((h) => h.timeSec) : null;
  const bpb = beatsPerBar(a);
  return raw.map((s) => {
    if (!names.has(s.label)) names.set(s.label, names.size < 26 ? String.fromCharCode(65 + names.size) : `S${names.size + 1}`);
    const startBeat = a.tempo ? round3(secToBeat(a, s.startSec)) : null;
    const endBeat = a.tempo ? round3(secToBeat(a, s.endSec)) : null;
    let kickRate: number | null = null;
    if (kicks) {
      const bars = startBeat !== null && endBeat !== null ? (endBeat - startBeat) / bpb : a.tempo ? ((s.endSec - s.startSec) * a.tempo.bpm) / 60 / bpb : 0;
      if (bars > 0.5) kickRate = r1(kicks.filter((t) => t >= s.startSec && t < s.endSec).length / bars);
    }
    return {
      label: names.get(s.label)!,
      startSec: Math.round(s.startSec * 100) / 100,
      endSec: Math.round(s.endSec * 100) / 100,
      startBeat,
      endBeat,
      lufs: isNum(s.lufs) ? r1(s.lufs) : -60,
      kickRate,
    };
  });
}

function round3(x: number | null): number | null {
  return x === null ? null : Math.round(x * 1000) / 1000;
}

export function sectionPlan(b: Pick<ReferenceBrief, 'sections' | 'detectedBpm' | 'beatsPerBar' | 'endBeat' | 'durationSec'>, bpm: number | null): PlannedSection[] {
  if (!bpm || b.sections.length < 3) return [];
  const bpb = b.beatsPerBar || 4;
  const factor = b.detectedBpm ? bpm / b.detectedBpm : 0;
  const exact = !!b.detectedBpm && [0.5, 1, 2].some((f) => Math.abs(factor - f) < 0.03);
  const barAt = (sec: number, beat: number | null): number => (exact && beat !== null ? (beat * factor) / bpb : (sec * bpm) / 60 / bpb);
  const snap = (x: number) => Math.max(0, Math.round(x / PHRASE) * PHRASE);
  const endBar = Math.min(MAX_PLAN_BARS, Math.max(PHRASE, snap(barAt(b.durationSec, b.endBeat))));
  type Part = { lufs: number; w: number; kick: number | null };
  const cuts: Array<{ bar: number; label: string; parts: Part[] }> = [];
  for (const s of b.sections) {
    const at = Math.min(endBar, snap(barAt(s.startSec, s.startBeat)));
    const part: Part = { lufs: s.lufs, w: Math.max(0.1, s.endSec - s.startSec), kick: s.kickRate ?? null };
    const last = cuts[cuts.length - 1];
    if (!cuts.length) cuts.push({ bar: 0, label: s.label, parts: [part] });
    else if (at <= last.bar || at >= endBar) {
      last.parts.push(part);
      if (part.w > last.parts.slice(0, -1).reduce((x, p) => x + p.w, 0)) last.label = s.label;
    } else cuts.push({ bar: at, label: s.label, parts: [part] });
  }
  const kickOf = (parts: Part[]): number | null => {
    const k = parts.filter((p) => p.kick !== null);
    if (!k.length) return null;
    const w = k.reduce((x, p) => x + p.w, 0);
    return k.reduce((x, p) => x + p.w * p.kick!, 0) / w;
  };
  const plan = cuts.map((c, i) => ({ label: c.label, startBar: c.bar + 1, bars: (i + 1 < cuts.length ? cuts[i + 1].bar : endBar) - c.bar, lufs: meanLufs(c.parts), kick: kickOf(c.parts), energy: 0 }));
  const live = plan.filter((p) => p.bars > 0);
  if (live.length < 3) return [];
  const top = Math.max(...live.map((p) => p.lufs));
  const topKick = Math.max(0, ...live.map((p) => p.kick ?? 0));
  for (const p of live) {
    const loud = 1 - (top - p.lufs) / 10;
    const kick = topKick >= MIN_KICK_RATE && p.kick !== null ? Math.min(1, p.kick / topKick) : 1;
    p.energy = Math.max(0.1, Math.round(loud * (0.6 + 0.4 * kick) * 20) / 20);
  }
  return live.map(({ kick: _k, ...p }) => p);
}

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function chordName(root: number, quality: ChordQuality): string {
  const suffix: Record<ChordQuality, string> = { maj: '', min: 'm', '7': '7', maj7: 'maj7', m7: 'm7', dim: 'dim', sus: 'sus', '5': '5' };
  return `${NOTE_NAMES[mod12(root)]}${suffix[quality] ?? ''}`;
}

export function diatonic(root: number, quality: ChordQuality, tonic: number, minor: boolean): boolean {
  const scale = minor ? MINOR_SCALE : MAJOR_SCALE;
  const iv = mod12(root - tonic);
  const third = quality === 'min' || quality === 'm7' || quality === 'dim' ? 3 : quality === 'maj' || quality === 'maj7' || quality === '7' ? 4 : null;
  const fifth = quality === 'dim' ? 6 : 7;
  return scale.includes(iv) && (third === null || scale.includes(mod12(iv + third))) && scale.includes(mod12(iv + fifth));
}

const KEY_NAMES = (minor: boolean, tonic: number): string => (minor ? ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'] : ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'])[mod12(tonic)];

export interface ChordLoopInfo {
  chords: Array<{ root: number; quality: ChordQuality }> | null;
  changesPerBar: number | null;
}

export function chordLoopChords(chords: BeatChord[], bpb: number, factor: number): ChordLoopInfo {
  const seq: BeatChord[] = [];
  for (const c of chords) {
    if (!isNum(c.beat) || !isNum(c.dur) || c.dur < 0.5) continue;
    const prev = seq[seq.length - 1];
    if (prev && prev.root === c.root && prev.quality === c.quality) {
      prev.dur = c.beat + c.dur - prev.beat;
      continue;
    }
    seq.push({ ...c });
  }
  if (seq.length < 4) return { chords: null, changesPerBar: null };
  const counts = new Map<string, { loop: Array<{ root: number; quality: ChordQuality }>; n: number }>();
  for (let i = 0; i + 4 <= seq.length; i++) {
    const w = seq.slice(i, i + 4).map((c) => ({ root: mod12(c.root), quality: c.quality }));
    const ids = w.map((c) => chordName(c.root, c.quality));
    const rots = ids.map((_, r) => [...ids.slice(r), ...ids.slice(0, r)].join(' '));
    const id = [...rots].sort()[0];
    const e = counts.get(id) ?? { loop: w, n: 0 };
    e.n++;
    counts.set(id, e);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const span = seq[seq.length - 1].beat + seq[seq.length - 1].dur - seq[0].beat;
  const changes = span > 0 ? Math.round((seq.length / ((span * factor) / bpb)) * 100) / 100 : null;
  return { chords: best && best.n >= 2 ? best.loop : null, changesPerBar: changes };
}

export function loopNumerals(loop: ReadonlyArray<{ root: number; quality: ChordQuality }>, key: string): { numerals: string[]; chords: string[] } | null {
  const k = parseKey(key);
  if (!k) return null;
  const minor = k.scale === 'minor';
  const rn = loop.map((c) => romanNumeral(c.root, c.quality, k.root, minor));
  const canon = canonicalLoop(rn);
  const shift = rn.findIndex((_, r) => [...rn.slice(r), ...rn.slice(0, r)].join(' ') === canon.join(' '));
  const rot = [...loop.slice(shift), ...loop.slice(0, shift)];
  return { numerals: canon, chords: rot.map((c) => chordName(c.root, c.quality)) };
}

export function chordKeys(loop: ReadonlyArray<{ root: number; quality: ChordQuality }> | null, detected: string | null): string[] {
  if (!loop || new Set(loop.map((c) => chordName(c.root, c.quality))).size < 3) return [];
  const fits = (tonic: number, minor: boolean) => loop.every((c) => diatonic(c.root, c.quality, tonic, minor));
  const d = detected ? parseKey(detected) : null;
  if (d && fits(d.root, d.scale === 'minor')) return [];
  const out: string[] = [];
  for (const minor of [true, false]) for (let t = 0; t < 12; t++) if (fits(t, minor)) out.push(KEY_NAMES(minor, t));
  const inLoop = (k: string) => {
    const pk = parseKey(k)!;
    return loop.some((c) => mod12(c.root) === pk.root && (pk.scale === 'minor' ? c.quality === 'min' || c.quality === 'm7' : c.quality === 'maj' || c.quality === 'maj7'));
  };
  return out.sort((a, b) => Number(inLoop(b)) - Number(inLoop(a))).slice(0, 4);
}

export function pickKey(keys: readonly string[], preferMinor: boolean | null): string | null {
  if (!keys.length) return null;
  if (preferMinor === null) return keys[0];
  return keys.find((k) => parseKey(k)?.scale === (preferMinor ? 'minor' : 'major')) ?? keys[0];
}

export function prefersMinor(pb: Pick<Playbook, 'keys'> | null): boolean | null {
  if (!pb) return null;
  const k = pb.keys.common[0] ? parseKey(pb.keys.common[0]) : null;
  if (k) return k.scale === 'minor';
  const m = (pb.keys.modes[0] ?? '').toLowerCase();
  return m ? /minor|aeolian|dorian|phrygian/.test(m) : null;
}

export function chordLoop(chords: BeatChord[], key: string | null, bpb: number, factor: number): { loop: string[] | null; changesPerBar: number | null } {
  const info = chordLoopChords(chords, bpb, factor);
  const n = info.chords && key ? loopNumerals(info.chords, key) : null;
  return { loop: n?.numerals ?? null, changesPerBar: info.changesPerBar };
}

export interface BriefOptions {
  name: string;
  genre?: GenreId | null;
  playbooks: readonly Playbook[];
  drums?: DrumGrid | null;
  drumHits?: { hits: DrumHit[]; source: 'mix' | 'stem' } | null;
}

const BAND_KEYS = ['sub', 'low', 'lowMid', 'highMid', 'high'] as const;

export function swingPercent(swing: number | null | undefined): number | null {
  return isNum(swing) ? (swing < 0.1 ? 0 : Math.round(Math.min(1, swing) * 100)) : null;
}

export function referenceBrief(a: AudioAnalysis, opts: BriefOptions): ReferenceBrief {
  const detected = a.tempo && isNum(a.tempo.bpm) && a.tempo.bpm > 0 ? Math.round(a.tempo.bpm * 10) / 10 : null;
  const bpb = beatsPerBar(a);
  const hits = opts.drumHits?.hits?.length ? opts.drumHits : a.drumHits?.length ? { hits: a.drumHits, source: 'mix' as const } : null;
  const grid = opts.drums ?? (hits ? drumGrid(a, hits.hits, hits.source) : null);
  const genres = guessGenres({ detectedBpm: detected, swing: isNum(a.swing) ? a.swing : null, grid }, opts.playbooks, 3);
  const genre = opts.genre ?? genres[0]?.id ?? null;
  const pb = genre ? opts.playbooks.find((p) => p.id === genre) ?? null : null;
  const reading = detected && pb ? readingFor(pb, detected) : null;
  const bpm = detected ? (reading ? reading.bpm : Math.round(detected)) : null;
  const factor = detected && bpm ? [0.5, 1, 2].reduce((x, f) => (Math.abs(bpm / detected - f) < Math.abs(bpm / detected - x) ? f : x), 1) : 1;
  const sections = referenceSections(a, hits?.hits ?? null);
  const endBeat = a.tempo ? round3(secToBeat(a, a.durationSec)) : null;
  const base = { sections, detectedBpm: detected, beatsPerBar: bpb, endBeat, durationSec: a.durationSec };
  const plan = sectionPlan(base, bpm);
  const totalBars = plan.length ? plan[plan.length - 1].startBar + plan[plan.length - 1].bars - 1 : bpm ? Math.round((a.durationSec * bpm) / 60 / bpb) : null;
  const loop = chordLoopChords(a.chords?.length ? chordsToBeats(a, a.chords) : [], bpb, factor);
  const detectedKey = a.key?.name ?? null;
  const keyAlternatives = chordKeys(loop.chords, detectedKey);
  const keyFromChords = pickKey(keyAlternatives, pb ? prefersMinor(pb) : a.key ? a.key.mode === 'minor' : null);
  const numeralsKey = keyFromChords ?? detectedKey;
  const named = loop.chords && numeralsKey ? loopNumerals(loop.chords, numeralsKey) : null;
  const L = a.levels;
  const bandsVsMid =
    L?.bands && isNum(L.bands.mid) ? (Object.fromEntries(BAND_KEYS.filter((k) => isNum(L.bands[k])).map((k) => [k, r1(L.bands[k] - L.bands.mid)])) as ReferenceBrief['mix']['bandsVsMid']) : null;
  const lufsS = plan.length ? plan.map((p) => p.lufs) : sections.filter((s) => s.endSec - s.startSec >= 8).map((s) => s.lufs);
  return {
    name: opts.name,
    durationSec: r1(a.durationSec),
    detectedBpm: detected,
    tempoConfidence: a.tempo && isNum(a.tempo.confidence) ? Math.round(a.tempo.confidence * 100) / 100 : null,
    bpm,
    factor,
    key: detectedKey,
    keyConfidence: a.key && isNum(a.key.confidence) ? Math.round(a.key.confidence * 100) / 100 : null,
    keyAlternatives,
    keyFromChords,
    swing: isNum(a.swing) ? Math.round(a.swing * 1000) / 1000 : null,
    swingPercent: factor === 1 ? swingPercent(a.swing) : null,
    beatsPerBar: bpb,
    endBeat,
    sections,
    plan,
    totalBars,
    form: normaliseForm(sections.map((s) => s.label)).join(' '),
    drums: grid && detected ? drumFeel(grid, factor, detected, bpb) : null,
    harmony: { loop: named?.numerals ?? null, loopChords: named?.chords ?? null, changesPerBar: loop.changesPerBar, chords: a.chords?.length ?? 0 },
    mix: {
      lufs: L && isNum(L.lufsIntegrated) ? r1(L.lufsIntegrated) : null,
      truePeakDb: L && isNum(L.truePeakDb) ? r1(L.truePeakDb) : null,
      bandsVsMid,
      width: isNum(a.stereo?.width) ? Math.round(a.stereo.width * 100) / 100 : null,
      correlation: isNum(a.stereo?.correlation) ? Math.round(a.stereo.correlation * 100) / 100 : null,
      contrastLu: lufsS.length >= 2 ? r1(Math.max(...lufsS) - Math.min(...lufsS)) : null,
    },
    genres,
    genre,
    genreSource: opts.genre ? 'given' : genre ? 'guessed' : null,
    kinds: pb ? planKinds(plan, pb) : plan.map((_, i) => genericKind(plan, i)),
  };
}

export function closeCall(b: Pick<ReferenceBrief, 'genres'>): { close: boolean; family: boolean } {
  const g = b.genres;
  if (g.length < 2) return { close: false, family: false };
  const close = g[0].score - g[1].score < 0.04;
  const near = g.filter((x) => g[0].score - x.score < 0.04);
  return { close, family: near.length >= 2 && near.every((x) => sameFamily(x.id, g[0].id)) };
}

const KIND_LABEL: Record<SectionKind, string> = {
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
const PEAK_ORDER: SectionKind[] = ['drop', 'chorus', 'hook'];

function genericKind(plan: readonly PlannedSection[], i: number): SectionKind {
  const e = plan[i].energy;
  const peak = 1 - PEAK_LU / 10;
  if (e >= peak) return 'hook';
  if (i === 0) return 'intro';
  if (i === plan.length - 1) return 'outro';
  if (plan[i + 1]?.energy >= peak && e >= 0.4 && plan[i].bars <= 16) return 'build';
  return e < 0.5 ? 'break' : 'verse';
}

export function planKinds(plan: readonly PlannedSection[], pb: Pick<Playbook, 'arrangement'>): SectionKind[] {
  const has = new Set(pb.arrangement.map((s) => s.kind));
  const top = Math.max(0, ...pb.arrangement.map((s) => s.energy));
  const peakKind = PEAK_ORDER.find((k) => pb.arrangement.some((s) => s.kind === k && s.energy >= top - 0.05)) ?? pb.arrangement.find((s) => s.energy >= top - 0.05)?.kind ?? 'hook';
  const middle = pb.arrangement.filter((s) => !['intro', 'outro'].includes(s.kind) && s.kind !== peakKind);
  const nearest = (e: number): SectionKind =>
    has.has('verse') ? 'verse' : middle.length ? middle.reduce((a, b) => (Math.abs(b.energy - e) < Math.abs(a.energy - e) ? b : a)).kind : peakKind;
  const peak = 1 - PEAK_LU / 10;
  const isPeak = (i: number) => !!plan[i] && plan[i].energy >= peak;
  const buildKind: SectionKind | null = has.has('build') ? 'build' : has.has('pre') ? 'pre' : null;
  const breakKind: SectionKind | null = has.has('breakdown') ? 'breakdown' : has.has('break') ? 'break' : has.has('bridge') ? 'bridge' : null;
  const edges = plan.length >= 4;
  const coldOpen = edges && plan.slice(1, -1).some((p, j) => p.label === plan[0].label && isPeak(j + 1));
  return plan.map((p, i) => {
    const e = p.energy;
    const last = i === plan.length - 1;
    if (i === 0 && edges && !coldOpen) return has.has('intro') ? 'intro' : nearest(e);
    if (last && edges && (!isPeak(i) || p.label === plan[0].label || p.bars <= 8)) return has.has('outro') ? 'outro' : nearest(e);
    if (!last && i > 0 && p.bars <= 8 && e >= 0.45 && isPeak(i + 1) && p.label !== plan[i + 1].label && buildKind) return buildKind;
    if (isPeak(i)) return peakKind;
    if (i === 0) return has.has('intro') ? 'intro' : nearest(e);
    if (last) return has.has('outro') ? 'outro' : nearest(e);
    if (e < 0.5 || (p.bars >= 16 && e <= 0.65)) return breakKind ?? nearest(e);
    if (isPeak(i + 1) && e >= 0.4 && p.bars <= 16 && buildKind) return buildKind;
    return nearest(e);
  });
}

function defaultTransitions(prev: number, e: number, kind: SectionKind): TransitionKind[] {
  if (['drop', 'hook', 'chorus'].includes(kind) || e - prev >= 0.3) return ['riser', 'impact'];
  if (prev - e >= 0.3) return ['downlifter'];
  return ['crash'];
}

export function planSections(plan: readonly PlannedSection[], kinds: readonly SectionKind[], pb: Pick<Playbook, 'arrangement'>): PlaybookSection[] {
  const seen = new Map<SectionKind, number>();
  const labels = new Map<string, number>();
  return plan.map((p, i) => {
    const kind = kinds[i];
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    const same = pb.arrangement.filter((s) => s.kind === kind);
    const pool = pb.arrangement.filter((s) => (i === 0 || i === plan.length - 1 ? true : !['intro', 'outro'].includes(s.kind)));
    const tpl = same.length ? same[Math.min(n, same.length - 1)] : (pool.length ? pool : pb.arrangement).reduce((a, b) => (Math.abs(b.energy - p.energy) < Math.abs(a.energy - p.energy) ? b : a));
    const base = KIND_LABEL[kind];
    const k = (labels.get(base) ?? 0) + 1;
    labels.set(base, k);
    const prevE = i > 0 ? plan[i - 1].energy : p.energy;
    const transitionIn = i === 0 ? undefined : tpl?.transitionIn?.length ? [...tpl.transitionIn] : defaultTransitions(prevE, p.energy, kind);
    return {
      kind,
      label: k > 1 ? `${base} ${k}` : base,
      bars: p.bars,
      energy: p.energy,
      parts: tpl ? [...tpl.parts] : [],
      ...(transitionIn ? { transitionIn } : {}),
      notes: `the reference's ${p.label} section${tpl?.notes ? `; ${tpl.notes}` : ''}`,
    };
  });
}

export function scaleArrangement(arr: readonly PlaybookSection[], totalBars: number): PlaybookSection[] {
  const sum = arr.reduce((s, x) => s + x.bars, 0);
  if (!sum || !totalBars) return arr.map((s) => ({ ...s }));
  const k = Math.min(MAX_PLAN_BARS, totalBars) / sum;
  return arr.map((s) => ({ ...s, bars: Math.max(PHRASE, Math.round((s.bars * k) / PHRASE) * PHRASE) }));
}

export interface AdaptedPlaybook {
  playbook: Playbook;
  bpm: number;
  bpmWhy: string;
  key: string | null;
  swing: number;
  arrangement: 'sections' | 'length' | 'playbook';
}

export function adaptPlaybook(pb: Playbook, ref: ReferenceBrief): AdaptedPlaybook {
  let bpm = pb.bpm.typical;
  let bpmWhy = `${pb.name} typical: the reference has no steady tempo`;
  let swing = pb.swing;
  let plan: PlannedSection[] = [];
  if (ref.detectedBpm) {
    const r = readingFor(pb, ref.detectedBpm);
    if (r.inRange) {
      bpm = r.bpm;
      bpmWhy = `the reference: detected ${ref.detectedBpm}${r.factor !== 1 ? `, read at ${r.bpm} (${r.factor === 2 ? 'double' : 'half'} time) for ${pb.name}` : ''}`;
      const sw = r.factor === 1 ? swingPercent(ref.swing) : null;
      if (sw !== null) swing = sw;
      plan = ref.factor === r.factor && ref.bpm === r.bpm ? ref.plan : sectionPlan(ref, r.bpm);
    } else {
      bpmWhy = `${pb.name} typical: the reference's ${ref.detectedBpm} bpm (or its half / double) is outside ${pb.name}'s ${pb.bpm.min}-${pb.bpm.max}; its sections keep their durations`;
      plan = sectionPlan(ref, bpm);
    }
  }
  const fromChords = pickKey(ref.keyAlternatives ?? [], prefersMinor(pb));
  const confident = fromChords ?? (ref.key && (ref.keyConfidence ?? 0) >= 0.35 && parseKey(ref.key) ? ref.key : null);
  let arrangement: PlaybookSection[];
  let how: AdaptedPlaybook['arrangement'];
  if (plan.length >= 3) {
    arrangement = planSections(plan, planKinds(plan, pb), pb);
    how = 'sections';
  } else if (ref.durationSec > 20) {
    arrangement = scaleArrangement(pb.arrangement, Math.round((ref.durationSec * bpm) / 60 / (ref.beatsPerBar || 4)));
    how = 'length';
  } else {
    arrangement = pb.arrangement.map((s) => ({ ...s }));
    how = 'playbook';
  }
  const total = arrangement.reduce((s, x) => s + x.bars, 0);
  const targets: PlaybookTargets = { ...pb.targets };
  if (ref.mix.lufs !== null) targets.lufs = Math.max(-16, Math.min(-7, ref.mix.lufs));
  if (how !== 'playbook' && total) targets.bars = [Math.max(8, Math.floor(total * 0.85)), Math.ceil(total * 1.15)];
  if (ref.mix.contrastLu !== null && how === 'sections') targets.contrastLu = [Math.max(2, r1(ref.mix.contrastLu - 3)), Math.max(8, r1(ref.mix.contrastLu + 4))];
  return {
    playbook: {
      ...pb,
      bpm: { min: Math.min(pb.bpm.min, bpm), max: Math.max(pb.bpm.max, bpm), typical: bpm },
      swing,
      keys: confident ? { ...pb.keys, common: [confident, ...pb.keys.common.filter((k) => k !== confident)] } : pb.keys,
      arrangement,
      targets,
    },
    bpm,
    bpmWhy,
    key: confident,
    swing,
    arrangement: how,
  };
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const sgn = (x: number): string => `${x > 0 ? '+' : ''}${x}`;

export function briefText(b: ReferenceBrief): string {
  const L: string[] = [];
  L.push(`REFERENCE — "${b.name}" (${fmtTime(b.durationSec)}; estimated from the audio)`);
  const tempo = b.bpm
    ? `${b.bpm} bpm${b.detectedBpm && b.bpm !== Math.round(b.detectedBpm) ? ` (detected ${b.detectedBpm}, read ${b.factor === 2 ? 'double' : 'half'}-time${b.genre ? ` for ${genreInfo(b.genre).name}` : ''})` : ''}${b.tempoConfidence !== null ? `, confidence ${b.tempoConfidence}` : ''}`
    : 'no steady tempo found';
  const keyText = b.keyFromChords
    ? `${b.keyFromChords} (from its chords: the pitch profile read ${b.key ?? 'nothing clear'}, but the chord loop sits in ${b.keyAlternatives.join(' / ')})`
    : `${b.key ?? 'unclear'}${b.keyConfidence !== null && b.key ? ` (confidence ${b.keyConfidence})` : ''}`;
  L.push(`Tempo ${tempo} · key ${keyText} · swing ${b.swingPercent !== null ? `${b.swingPercent}%` : 'n/a at this reading'} · ${b.beatsPerBar}/4${b.totalBars ? ` · about ${b.totalBars} bars` : ''}`);
  if (b.genres.length) {
    const cc = closeCall(b);
    const note = cc.close ? (cc.family ? ` A close call within one family (${genreInfo(b.genres[0].id).name} and its neighbours): any of them fits; the user's words or the song's name decide.` : ` A close call${b.drums?.source === 'mix' ? ' (the drums were heard in the full mix, so they are rough)' : ''}: weigh the user's words, the song's name and render_preview of the reference.`) : '';
    L.push(`Closest genres (estimated): ${b.genres.map(guessLine).join(' · ')}.${note}${b.genreSource === 'given' && b.genre ? ` You asked for ${genreInfo(b.genre).name}: the plan below uses it.` : ''}`);
  }
  else L.push('Closest genres: unknown (no steady tempo): judge it by ear with render_preview of the reference, or use the genre the user named.');
  if (b.form) L.push(`Form: ${b.form} (same letter = similar material)`);
  if (b.plan.length) {
    L.push(`Sections (bars at ${b.bpm} bpm; energy 1 = the loudest):`);
    b.plan.forEach((p, i) => L.push(`  ${`${p.startBar}-${p.startBar + p.bars - 1}`.padEnd(8)} ${(b.kinds[i] ? KIND_LABEL[b.kinds[i]] : '?').padEnd(10)} ${p.label} · energy ${p.energy} · ${p.lufs} LUFS`));
  } else if (b.sections.length) {
    L.push(`Sections (seconds): ${b.sections.map((s) => `${s.label} ${fmtTime(s.startSec)}-${fmtTime(s.endSec)} (${s.lufs} LUFS)`).join(' · ')}`);
  }
  if (b.drums) {
    const d = b.drums;
    const feel = [d.fourOnFloor ? 'four-on-the-floor kick' : '', d.backbeat === 'two-four' ? 'snare / clap on 2 and 4' : d.backbeat === 'three' ? 'snare / clap on beat 3 (half-time)' : '', d.hats !== 'none' ? `${d.hats} hats` : '', d.rollsPerMin >= 1 ? `${d.rollsPerMin} hat rolls per minute` : ''].filter(Boolean).join(', ');
    L.push(`Drums (from the ${d.source === 'stem' ? 'drum stem' : 'full mix, so rough'}, ${d.bars} bars; one character per 16th: 9 = nearly every bar, . = never)${feel ? `: ${feel}` : ''}`);
    for (const role of FEEL_ROLES) if (d.steps[role]) L.push(`  ${role.padEnd(8)} ${feelLine(d.steps[role]!)}`);
  }
  if (b.harmony.loop) L.push(`Harmony: ${b.harmony.loopChords ? `${b.harmony.loopChords.join(' ')} (${b.harmony.loop.join(' ')})` : b.harmony.loop.join(' ')} loop${b.harmony.changesPerBar ? `, about ${b.harmony.changesPerBar} chord changes per bar` : ''} (estimated). A progression is common ground: use it or a variation; voicing, rhythm and melody are yours.`);
  else if (b.harmony.chords) L.push('Harmony: no clear repeating loop (estimated chords vary): use the playbook\'s progressions in the reference\'s key.');
  const m = b.mix;
  const bands = m.bandsVsMid ? Object.entries(m.bandsVsMid).map(([k, v]) => `${k} ${sgn(v as number)}`).join(', ') : null;
  L.push(`Mix: ${m.lufs !== null ? `${m.lufs} LUFS` : 'loudness n/a'}${m.truePeakDb !== null ? `, true peak ${m.truePeakDb} dBTP` : ''}${bands ? ` · bands vs mids (dB): ${bands}` : ''}${m.width !== null ? ` · width ${m.width}` : ''}${m.contrastLu !== null ? ` · ${m.contrastLu} LU between its quietest and loudest sections` : ''}`);
  return L.join('\n');
}
