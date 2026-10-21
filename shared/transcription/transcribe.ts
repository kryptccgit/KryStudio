// transcribeSong: one song's analysis + per-stem notes / drum hits → a
// SongTranscription on the project grid (research/15 §3.3), and
// sectionPatterns: what the builder writes as one pattern per section.
//
// The copyright line (§1): 'style' (build_from_reference) keeps the drum
// programming, the chord changes and the bass RHYTHM (pitches from the chord
// roots / fifths), never the melody, the lead, the vocal or the exact bass;
// `mine: true` (the user's own song) may keep the exact bass and lead.
// 'exact' (audio_to_project) transcribes everything. Pure, no I/O.

import type { AudioAnalysis, DrumHit, StemName, TranscribedNote } from '../analyzer/protocol';
import type { Playbook, SectionKind } from '../playbooks/types';
import { listPlaybooks } from '../playbooks';
import { parseKey } from '../music/theory';
import { referenceBrief } from '../reference/brief';
import type { ReferenceBrief } from '../reference/types';
import type { GenreId } from '../sounds/genres';
import { PPQ } from '../schema/time';
import type { GridNote, SongTranscription, TranscribedPart, TranscriptionOptions } from './types';
import { kickTimes, transcriptionGrid, type TempoFactor, type TranscriptionGrid } from './grid';
import { drumParts } from './drums';
import { chordNotes, chordRegister, chordTimeline, exactVoicing, meanConfidence, styleVoicings } from './chords';
import { chordToneShare, cleanNotes, fixBass, monoCleanup, skyline, styleBass, toGridNotes } from './lines';
import { linkSameAs, songSections } from './sections';
import { melodyShape, type MelodyShape } from './melody';

export interface TranscriptionInput {
  /** File name without extension. */
  name: string;
  analysis: AudioAnalysis;
  /** Drum hits of the drum stem, or of the full mix (default: analysis.drumHits, from the mix). */
  drumHits?: readonly DrumHit[] | null;
  /** Where drumHits came from (default 'stem' when `stems.drums` is set and drumHits were given, else 'mix'). */
  drumSource?: 'stem' | 'mix';
  /** Bass stem, mono transcription. */
  bass?: readonly TranscribedNote[] | null;
  /** Other stem (keys, synths, guitars), poly transcription. */
  other?: readonly TranscribedNote[] | null;
  /** Vocal stem, mono transcription: melody SHAPE only (never written as notes). */
  vocals?: readonly TranscribedNote[] | null;
  /** Where bass / other / vocals came from (default 'stem' when `stems` lists any stem, else 'mix'). */
  pitchedSource?: 'stem' | 'mix';
  /** Stem files on disk (cached separation), passed through to the result. */
  stems?: Partial<Record<StemName, string>>;
  /** The genre (wins over the guess): its tempo reading is the default factor, its section words name the sections. */
  genre?: GenreId | null;
  /** Playbooks for the genre guess (default: all). */
  playbooks?: readonly Playbook[];
  /** A brief study_reference already built for this analysis (skips building one). */
  brief?: ReferenceBrief | null;
}

/** Defaults of TranscriptionOptions. */
export const DRUM_GRID = 120;
export const PITCHED_GRID = 240;
export const DRUM_FEEL = 0.5;
export const PITCHED_FEEL = 0.3;

const r2 = (x: number) => Math.round(x * 100) / 100;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

interface Prepared {
  a: AudioAnalysis;
  brief: ReferenceBrief | null;
  playbook: Playbook | null;
  factor: TempoFactor;
  hits: DrumHit[];
  drumSource: 'stem' | 'mix';
  pitchedSource: 'stem' | 'mix';
  grid: TranscriptionGrid;
  bass: TranscribedNote[];
  other: TranscribedNote[];
  vocals: TranscribedNote[];
}

function prepare(input: TranscriptionInput, opts: Pick<TranscriptionOptions, 'factor'>): Prepared {
  const a = input.analysis;
  const stems = input.stems ?? {};
  const hasStems = Object.values(stems).some(Boolean);
  const given = input.drumHits?.length ? input.drumHits : null;
  const hits = (given ?? a.drumHits ?? []).filter((h) => h && isNum(h.timeSec)) as DrumHit[];
  const drumSource = input.drumSource ?? (given && stems.drums ? 'stem' : 'mix');
  const pitchedSource = input.pitchedSource ?? (hasStems ? 'stem' : 'mix');
  const playbooks = input.playbooks ?? listPlaybooks();
  let brief = input.brief ?? null;
  if (!brief && a.tempo) brief = referenceBrief(a, { name: input.name, genre: input.genre ?? null, playbooks, drumHits: hits.length ? { hits, source: drumSource } : null });
  const genre = input.genre ?? brief?.genre ?? null;
  const playbook = genre ? (playbooks.find((p) => p.id === genre) ?? null) : null;
  const f = opts.factor ?? brief?.factor ?? 1;
  const factor: TempoFactor = f === 0.5 || f === 2 ? f : 1;
  const bass = cleanNotes(input.bass);
  const other = cleanNotes(input.other);
  const vocals = cleanNotes(input.vocals);
  const onsets = [...hits.map((h) => h.timeSec), ...bass.map((n) => n.startSec), ...other.map((n) => n.startSec)];
  const grid = transcriptionGrid(a, factor, { onsets, kicks: kickTimes(hits) });
  return { a, brief, playbook, factor, hits, drumSource, pitchedSource, grid, bass, other, vocals };
}

/** Cut notes to the song's last bar (drop those starting after it). */
function clip(notes: GridNote[], endTick: number): GridNote[] {
  return notes.filter((n) => n.tick < endTick).map((n) => (n.tick + n.dur > endTick ? { ...n, dur: Math.max(1, endTick - n.tick) } : n));
}

/** One song → its transcription on the project grid. */
export function transcribeSong(input: TranscriptionInput, opts: TranscriptionOptions): SongTranscription {
  const P = prepare(input, opts);
  const { a, grid: g } = P;
  const mode = opts.mode;
  const style = mode === 'style';
  const keepLines = !style || !!opts.mine;
  const drumGrid = opts.grid ?? DRUM_GRID;
  const pitchGrid = opts.grid ?? PITCHED_GRID;
  const drumFeel = opts.feel ?? DRUM_FEEL;
  const pitchFeel = opts.feel ?? PITCHED_FEEL;
  const endTick = g.totalBars * g.ticksPerBar;
  const notes: string[] = [];
  const parts: TranscribedPart[] = [];
  const pitchedStem = (s: StemName): StemName | 'mix' => (P.pitchedSource === 'stem' ? s : 'mix');

  if (!g.detectedBpm) notes.push(`No steady tempo was found: the grid assumes ${g.bpm} bpm from the start, so timing is rough.`);
  if (g.factor !== 1 && g.detectedBpm) notes.push(`Read at ${g.factor === 2 ? 'double' : 'half'} time: ${g.bpm} bpm (detected ${Math.round(g.detectedBpm * 10) / 10}).`);
  if (g.shiftedBars) notes.push(`The song has ${g.shiftedBars} bar${g.shiftedBars > 1 ? 's' : ''} before the first detected downbeat: bar 1 starts there.`);

  // Chords first: the bass is checked against them.
  const chords = chordTimeline(a.chords ?? [], g).filter((c) => c.tick < endTick);
  const keyRoot = (() => {
    const k = P.brief?.keyFromChords ?? a.key?.name ?? null;
    return k ? (parseKey(k)?.root ?? null) : null;
  })();

  // Drums.
  if (P.hits.length) {
    const d = drumParts(P.hits, g, { grid: drumGrid, feel: drumFeel, source: P.drumSource });
    for (const p of d.parts) parts.push({ ...p, notes: clip(p.notes, endTick) });
    if (P.drumSource === 'mix') notes.push('No drum stem: the drums were read from the full mix, so expect missing or extra hits (busy mixes blur hats and snares).');
    if (d.merged) notes.push(`${d.merged} double detection${d.merged > 1 ? 's' : ''} / flam${d.merged > 1 ? 's' : ''} merged.`);
    if (d.pickup) notes.push(`${d.pickup} drum hit${d.pickup > 1 ? 's' : ''} before bar 1 (a pickup) left out.`);
  } else notes.push('No drum hits: there are no drum parts.');

  // Bass.
  let bassLine: GridNote[] = [];
  if (P.bass.length) {
    const mono = monoCleanup(P.bass, 0.04, 0.03);
    const gl = toGridNotes(mono.notes, g, { grid: pitchGrid, feel: pitchFeel, mono: true });
    const fixed = fixBass(gl.notes, chords);
    bassLine = clip(fixed.notes, endTick);
    if (bassLine.length) {
      const share = chordToneShare(bassLine, chords);
      const kept = mono.notes.length / Math.max(1, P.bass.length);
      const conf = (P.pitchedSource === 'stem' ? 0.85 : 0.5) * (0.6 + 0.4 * (share ?? 0.5)) * (0.7 + 0.3 * kept);
      const styled = style && !opts.mine;
      parts.push({
        name: 'Bass',
        stem: pitchedStem('bass'),
        kind: 'bass',
        notes: styled ? styleBass(bassLine, chords, keyRoot) : bassLine,
        confidence: r2(Math.min(1, conf)),
      });
      if (styled) notes.push("Style: the bass keeps the reference's rhythm; its notes are the chord roots, fifths and octaves (not the reference's bassline).");
      if (fixed.octaveFixes) notes.push(`${fixed.octaveFixes} bass note${fixed.octaveFixes > 1 ? 's' : ''} moved by an octave (octave errors against the line and the chords).`);
      if (P.pitchedSource === 'mix') notes.push('No bass stem: the bass was read from the full mix, so some notes may be wrong.');
    }
  }

  // Lead: the other stem's top line ('exact', or the user's own song). Worked out before the chords so its notes
  // stay out of the chord voicings.
  const bars = Math.max(1, g.totalBars);
  if (P.other.length && P.other.length < bars / 2) notes.push(`The other stem is sparse (${P.other.length} notes over ${bars} bars): few chord or lead notes to go by.`);
  let leadPart: TranscribedPart | null = null;
  const leadByKey = new Map<number, Array<[number, number]>>();
  if (keepLines && P.other.length) {
    const top = skyline(P.other, 0.08);
    const gl = toGridNotes(top, g, { grid: pitchGrid, feel: pitchFeel, mono: true });
    const lead = clip(gl.notes, endTick);
    if (lead.length >= 4) {
      const per = lead.length / bars;
      leadPart = { name: 'Lead', stem: pitchedStem('other'), kind: 'lead', notes: lead, confidence: r2((P.pitchedSource === 'stem' ? 0.7 : 0.4) * Math.min(1, 0.5 + per / 4)) };
      for (const n of top) leadByKey.set(n.key, [...(leadByKey.get(n.key) ?? []), [n.startSec - 0.01, n.startSec + n.durSec]]);
    }
  }

  // Chords part.
  const polyTicks = P.other
    .filter((n) => !(leadByKey.get(n.key) ?? []).some(([a, b]) => n.startSec >= a && n.startSec < b))
    .map((n) => ({ tick: g.toTick(n.startSec), end: g.toTick(n.startSec + n.durSec), key: n.key }));
  if (chords.length) {
    let voicings: number[][];
    if (style) voicings = styleVoicings(chords);
    else {
      const reg = chordRegister(P.other);
      const ex = chords.map((c) => exactVoicing(c, polyTicks, reg));
      voicings = ex.map((v) => v.keys);
      const from = ex.filter((v) => v.fromNotes).length;
      if (P.other.length) notes.push(`${from} of ${chords.length} chords voiced from the ${P.pitchedSource === 'stem' ? 'other stem' : 'mix'}'s notes; the rest in root position.`);
    }
    const mc = meanConfidence(chords) ?? 0;
    parts.push({ name: 'Chords', stem: pitchedStem('other'), kind: 'chords', notes: clip(chordNotes(chords, voicings), endTick), confidence: r2(mc) });
    if (mc < 0.45) notes.push(`The chords are uncertain (mean confidence ${mc.toFixed(2)}): check them by ear.`);
    if (style) notes.push('Style: the chords follow the reference\'s changes with fresh close voicings around C4.');
  } else notes.push('No chords were found (atonal, or the analysis predates chord reading): there is no Chords part.');

  if (leadPart) parts.push(leadPart);
  if (!style && input.stems?.vocals) parts.push({ name: 'Vocal', stem: 'vocals', kind: 'vocal-audio', notes: [], confidence: 1 });
  if (style) notes.push(opts.mine ? 'Your own song: the exact bass and lead were kept.' : 'Style: no melody, lead or vocal notes were copied. Write an original top line (see the melody shape).');
  if (g.pickupBeats) notes.push(`A pickup of ${g.pickupBeats} beat${g.pickupBeats === 1 ? '' : 's'} before bar 1 was left out.`);

  // Sections and pattern reuse.
  const hasVocals = P.vocals.length > 0 || !!input.stems?.vocals;
  const peak: SectionKind = hasVocals ? 'chorus' : 'drop';
  const { sections } = songSections({ analysis: a, grid: g, hits: P.hits, playbook: P.playbook, peak });
  linkSameAs(sections, parts, chords, g.ticksPerBar, { pitched: keepLines });

  return {
    name: input.name,
    durationSec: Math.round(a.durationSec * 1000) / 1000,
    bpm: g.bpm,
    beatsPerBar: g.beatsPerBar,
    key: P.brief?.keyFromChords ?? a.key?.name ?? null,
    swingPercent: g.factor === 1 && isNum(a.swing) ? (a.swing < 0.1 ? 0 : Math.round(Math.min(1, a.swing) * 100)) : null,
    firstDownbeatSec: g.firstDownbeatSec,
    totalBars: g.totalBars,
    sections,
    chords,
    parts,
    stems: { ...(input.stems ?? {}) },
    notes,
  };
}

/**
 * The melody shape of the reference for 'style' builds: the vocal line (mono cleanup) when there is one, else the
 * other stem's top line. null with too few notes.
 */
export function referenceMelodyShape(input: TranscriptionInput, opts: Pick<TranscriptionOptions, 'factor'> = {}): MelodyShape | null {
  const P = prepare(input, opts);
  const g = P.grid;
  const shapeOf = (src: 'vocals' | 'other'): MelodyShape | null => {
    const line = src === 'vocals' ? monoCleanup(P.vocals, 0.06, 0.04).notes : skyline(P.other, 0.08);
    if (line.length < 4) return null;
    return melodyShape(toGridNotes(line, g, { grid: PITCHED_GRID, feel: 0, mono: true }).notes, g.ticksPerBar, src);
  };
  // An instrumental's vocal stem is mostly bleed: a handful of scattered "notes" over a huge range. Use it only
  // when it reads like a sung line (enough notes across the song, a singable range), else the other stem's top line.
  const vocal = shapeOf('vocals');
  const bars = Math.max(1, g.totalBars);
  const sung = !!vocal && vocal.notes >= Math.max(8, bars * 0.5) && vocal.rangeSemis <= 24 && vocal.restRatio < 0.9;
  return sung ? vocal : (shapeOf('other') ?? vocal);
}

/** The grid a transcription would use (for callers lining up audio or converting other material the same way). */
export function songGrid(input: TranscriptionInput, opts: Pick<TranscriptionOptions, 'factor'> = {}): TranscriptionGrid {
  return prepare(input, opts).grid;
}

// ── Per-section patterns ────────────────────────────────────────────────

export interface SectionPart {
  name: string;
  kind: TranscribedPart['kind'];
  drumRole?: TranscribedPart['drumRole'];
  /** Ticks from the section's first bar; nothing runs past the section's end. */
  notes: GridNote[];
}

export interface SectionPattern {
  /** Index into SongTranscription.sections. */
  index: number;
  name: string;
  label: string;
  startBar: number;
  bars: number;
  /** Ticks of the section's first bar from bar 1, and its length. */
  startTick: number;
  lengthTicks: number;
  /** The section whose pattern this one plays: itself, or its `sameAs` (then `parts` repeats that section's notes). */
  patternOf: number;
  /** Parts with notes in this section (vocal audio is never a pattern part). */
  parts: SectionPart[];
}

/** Notes of sustained parts that start before the section and sound at least this long into it restart on its bar 1. */
const CARRY_MIN = PPQ / 2;
/** A note this close before the section start (an early-played downbeat, feel) belongs to the section. */
const EARLY_TOL = 60;

function sliceNotes(notes: readonly GridNote[], from: number, len: number, carry: boolean): GridNote[] {
  const to = from + len;
  const out: GridNote[] = [];
  for (const n of notes) {
    const end = n.tick + n.dur;
    let rel: number;
    let dur: number;
    if (n.tick >= from - EARLY_TOL && n.tick < to - EARLY_TOL) {
      rel = Math.max(0, n.tick - from);
      dur = Math.min(n.dur, len - rel);
    } else if (carry && n.tick < from - EARLY_TOL && end - from >= CARRY_MIN) {
      rel = 0;
      dur = Math.min(end - from, len);
    } else continue;
    if (dur > 0) out.push({ tick: rel, key: n.key, dur, vel: n.vel });
  }
  return out.sort((a, b) => a.tick - b.tick || a.key - b.key);
}

/** Per section, per part: the notes the builder writes as that section's pattern (sameAs sections repeat theirs). */
export function sectionPatterns(t: SongTranscription): SectionPattern[] {
  const tpb = t.beatsPerBar * PPQ;
  const own = (i: number): SectionPart[] => {
    const s = t.sections[i];
    const from = (s.startBar - 1) * tpb;
    const len = s.bars * tpb;
    return t.parts
      .filter((p) => p.kind !== 'vocal-audio')
      .map((p) => ({ name: p.name, kind: p.kind, ...(p.drumRole ? { drumRole: p.drumRole } : {}), notes: sliceNotes(p.notes, from, len, p.kind !== 'drum') }))
      .filter((p) => p.notes.length > 0);
  };
  const cache = new Map<number, SectionPart[]>();
  const partsOf = (i: number) => {
    if (!cache.has(i)) cache.set(i, own(i));
    return cache.get(i)!;
  };
  return t.sections.map((s, i) => {
    let src = i;
    // Follow the chain to the section that has its own pattern (sameAs points at an earlier one).
    for (let guard = 0; guard < t.sections.length && t.sections[src].sameAs !== null && t.sections[src].sameAs! < src; guard++) src = t.sections[src].sameAs!;
    const parts = partsOf(src).map((p) => ({ ...p, notes: p.notes.map((n) => ({ ...n })) }));
    return { index: i, name: s.name, label: s.label, startBar: s.startBar, bars: s.bars, startTick: (s.startBar - 1) * tpb, lengthTicks: s.bars * tpb, patternOf: src, parts };
  });
}
