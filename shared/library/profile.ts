// Style profiles: aggregate a collection's track features into the
// statistics the AI composes from (research/08 §4.2). Pure, deterministic
// (seeded example sampling). No training: robust percentiles, histograms
// and per-track averages the agent can read.
//
// Rules of thumb used throughout:
//  - Every track weighs the same (per-track averages / weights 1/n), so one
//    long song can't dominate a section.
//  - A section needs data from at least MIN_PROFILE_TRACKS tracks, else it
//    is null and `caveats` says why.
//  - Examples are SAMPLED from the aggregated probabilities with a seeded
//    RNG; nothing is copied from a single track.

import type { DrumRole } from '../analyzer/protocol';
import { printKpn } from '../kpn/print';
import type { PrintNote, PrintTrack } from '../kpn/types';
import { parseKey } from '../music/theory';
import type { BeatChord, BeatNote, Collection, LibraryTrack, Percentiles, StyleProfile, TrackFeatures } from './types';
import { beatMapper, beatMapping, beatsPerBar, DRUM_ROLES, GRID_STEPS } from './grid';
import { clamp, hashString, isNum, median, mod, percentiles, round, sampleFromPercentiles, seededRng, segmentMeans, weightedPercentiles } from './stats';

export interface ProfileInput {
  track: LibraryTrack;
  features: TrackFeatures;
}

/** A profile section needs data from at least this many tracks. */
export const MIN_PROFILE_TRACKS = 3;
/** Below this many analysed tracks the whole profile is flagged as thin. */
const THIN_PROFILE = 10;
/** A track's drum grid needs this many measured bars to count. */
const MIN_DRUM_BARS = 4;
/** A track's bass line needs this many notes to count. */
const MIN_BASS_NOTES = 8;
/** Swing at or above this counts as "swung". */
const SWUNG = 0.15;
/** A 32nd note in beats (kick alignment, glide gap). */
const THIRTY_SECOND = 0.125;
const ENERGY_POINTS = 16;

const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

interface TrackKey {
  root: number;
  minor: boolean;
  /** Canonical spelling (enharmonics merged), e.g. "F#m". */
  name: string;
}

function trackKey(inp: ProfileInput): TrackKey | null {
  const a = inp.features.analysis;
  const name = a?.key?.name ?? inp.track.key ?? null;
  if (!name) return null;
  const k = parseKey(name);
  if (!k) return null;
  const minor = a?.key ? a.key.mode === 'minor' : k.scale === 'minor';
  return { root: k.root, minor, name: (minor ? MINOR_KEYS : MAJOR_KEYS)[k.root] };
}

function trackBpm(inp: ProfileInput): number | null {
  const b = inp.features.analysis?.tempo?.bpm ?? inp.track.bpm;
  return isNum(b) && b > 0 ? b : null;
}

// ── Roman numerals ──────────────────────────────────────────────────────

const MAJOR_NUMERALS = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
/** Minor keys count from the natural minor (i, ii°, III, iv, v, VI, VII), as producers write them. */
const MINOR_NUMERALS = ['I', 'bII', 'II', 'III', '#III', 'IV', 'bV', 'V', 'VI', '#VI', 'VII', '#VII'];

/** A chord as a roman numeral relative to a key: case = quality (i minor, I major), suffix 7 / maj7 / ° / sus / 5. */
export function romanNumeral(root: number, quality: BeatChord['quality'], keyRoot: number, minor: boolean): string {
  const base = (minor ? MINOR_NUMERALS : MAJOR_NUMERALS)[mod(root - keyRoot, 12)];
  const acc = /^[b#]/.test(base) ? base[0] : '';
  let rn = base.slice(acc.length);
  if (quality === 'min' || quality === 'm7' || quality === 'dim') rn = rn.toLowerCase();
  const suffix = quality === 'dim' ? '°' : quality === '7' || quality === 'm7' ? '7' : quality === 'maj7' ? 'maj7' : quality === 'sus' ? 'sus' : quality === '5' ? '5' : '';
  return `${acc}${rn}${suffix}`;
}

/** Rotation-invariant form of a looped progression: start on the tonic when it is in the loop, else the alphabetically first rotation. */
export function canonicalLoop(degrees: readonly string[]): string[] {
  const n = degrees.length;
  const rotations: string[][] = [];
  for (let r = 0; r < n; r++) rotations.push([...degrees.slice(r), ...degrees.slice(0, r)]);
  const isTonic = (d: string) => /^(i|I)(?![iIvV])/.test(d);
  const tonic = rotations.filter((x) => isTonic(x[0]));
  const pool = tonic.length ? tonic : rotations;
  pool.sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : a.join(' ') > b.join(' ') ? 1 : 0));
  return pool[0];
}

// ── Section builders ────────────────────────────────────────────────────

function buildTempo(inputs: ProfileInput[]): StyleProfile['tempo'] {
  const bpms: number[] = [];
  let ambiguous = 0;
  for (const inp of inputs) {
    const bpm = trackBpm(inp);
    if (bpm === null) continue;
    bpms.push(bpm);
    if (halfTimeAmbiguous(inp, bpm)) ambiguous++;
  }
  if (bpms.length < MIN_PROFILE_TRACKS) return null;
  const bins = new Map<number, number>();
  for (const b of bpms) {
    const bin = Math.floor(b / 4) * 4;
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const histogram = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([bpm, count]) => ({ bpm, count }));
  return { bpm: percentiles(bpms, 1), histogram, halfTimeShare: round(ambiguous / bpms.length, 3) };
}

/**
 * Half / double-time ambiguity: the detector lists an octave reading in a
 * plausible range (55–190 BPM) AND either its confidence is low or the drums
 * play a half-time backbeat (snare on beat 3 rather than 2 and 4) — i.e. the
 * same groove reads as 70 or 140.
 */
function halfTimeAmbiguous(inp: ProfileInput, bpm: number): boolean {
  const t = inp.features.analysis?.tempo;
  const alts = t?.alternatives ?? [];
  const near = (x: number, y: number) => Math.abs(x / y - 1) <= 0.04;
  const octave = alts.some((x) => isNum(x) && x >= 55 && x <= 190 && (near(x, bpm / 2) || near(x, bpm * 2)));
  if (!octave) return false;
  if (t && isNum(t.confidence) && t.confidence < 0.5) return true;
  const d = inp.features.drums;
  const sn = d && d.bars >= MIN_DRUM_BARS ? d.counts.snare : undefined;
  if (sn && d) {
    const three = sn[16] / d.bars;
    const twoFour = Math.max(sn[8], sn[24]) / d.bars;
    if (three >= 0.5 && three > twoFour * 1.5) return true;
  }
  return false;
}

function buildSwing(inputs: ProfileInput[]): StyleProfile['swing'] {
  const v = inputs.map((i) => i.features.analysis?.swing).filter((x): x is number => isNum(x));
  if (v.length < MIN_PROFILE_TRACKS) return null;
  return { median: round(median(v), 2), share: round(v.filter((x) => x >= SWUNG).length / v.length, 3) };
}

function buildKeys(inputs: ProfileInput[]): StyleProfile['keys'] {
  const counts = new Map<string, number>();
  let minor = 0;
  let n = 0;
  for (const inp of inputs) {
    const k = trackKey(inp);
    if (!k) continue;
    n++;
    if (k.minor) minor++;
    counts.set(k.name, (counts.get(k.name) ?? 0) + 1);
  }
  if (n < MIN_PROFILE_TRACKS) return null;
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([key, count]) => ({ key, count }));
  return { top, minorShare: round(minor / n, 3) };
}

/** Tracks whose drum grid counts for the drum odds: enough measured bars, in 4 (the 32-step grid and step names assume 4/4). */
function drumGridOf(inp: ProfileInput): NonNullable<TrackFeatures['drums']> | null {
  const d = inp.features.drums;
  return d && d.bars >= MIN_DRUM_BARS && beatsPerBar(inp.features.analysis) === 4 ? d : null;
}

function buildDrums(inputs: ProfileInput[]): StyleProfile['drums'] {
  const grids = inputs.map(drumGridOf).filter((d): d is NonNullable<typeof d> => !!d);
  if (grids.length < MIN_PROFILE_TRACKS) return null;
  const roles: NonNullable<StyleProfile['drums']>['roles'] = {};
  for (const role of DRUM_ROLES) {
    if (!grids.some((g) => g.counts[role]?.some((c) => c > 0))) continue;
    const prob = new Array<number>(GRID_STEPS).fill(0);
    const velSum = new Array<number>(GRID_STEPS).fill(0);
    const velN = new Array<number>(GRID_STEPS).fill(0);
    for (const g of grids) {
      const c = g.counts[role];
      const v = g.vel[role];
      if (!c) continue;
      for (let s = 0; s < GRID_STEPS; s++) {
        prob[s] += Math.min(1, (c[s] ?? 0) / g.bars);
        if (c[s] > 0 && v && isNum(v[s])) {
          velSum[s] += v[s] / c[s];
          velN[s]++;
        }
      }
    }
    roles[role] = {
      prob: prob.map((p) => round(p / grids.length, 3)),
      vel: velSum.map((v, s) => (velN[s] ? round(v / velN[s], 3) : 0)),
    };
  }
  const rollsPerBar = grids.reduce((s, g) => s + g.rolls / g.bars, 0) / grids.length;
  const sources = new Set(grids.map((g) => g.source));
  return { roles, rollsPerBar: round(rollsPerBar, 3), tracks: grids.length, source: sources.size > 1 ? 'mixed' : grids[0].source };
}

/**
 * Share of a track's bass notes (sorted by beat) within a 32nd of a kick hit,
 * from the analysis' drum hits. null without kick hits or a tempo.
 * One linear sweep: notes go back to seconds through the O(1) inverse map.
 */
function kickAlignFromHits(inp: ProfileInput, notes: ReadonlyArray<{ beat: number }>): number | null {
  const a = inp.features.analysis;
  const hits = a?.drumHits;
  const m = hits?.length ? beatMapping(a) : null;
  if (!hits?.length || !m) return null;
  const kicks: number[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.role === 'kick' && isNum(h.timeSec)) kicks.push(h.timeSec);
  }
  if (!kicks.length) return null;
  for (let i = 1; i < kicks.length; i++) {
    if (kicks[i] < kicks[i - 1]) {
      kicks.sort((x, y) => x - y);
      break;
    }
  }
  let k = 0;
  let aligned = 0;
  for (let i = 0; i < notes.length; i++) {
    const b = notes[i].beat;
    const t = m.toSec(b);
    const tol = m.toSec(b + THIRTY_SECOND) - t;
    while (k + 1 < kicks.length && kicks[k + 1] <= t) k++;
    const d = Math.min(Math.abs(kicks[k] - t), k + 1 < kicks.length ? Math.abs(kicks[k + 1] - t) : Infinity);
    if (d <= tol + 1e-6) aligned++;
  }
  return aligned / notes.length;
}

/** Valid notes sorted by beat; returns the input itself when it already is (lines from notesToBeats are). */
function validSorted(notes: readonly BeatNote[]): readonly BeatNote[] {
  let ok = true;
  for (let i = 0; i < notes.length && ok; i++) {
    const n = notes[i];
    if (!n || !isNum(n.beat) || !isNum(n.dur) || !(n.dur > 0) || !isNum(n.key) || (i > 0 && n.beat < notes[i - 1].beat)) ok = false;
  }
  if (ok) return notes;
  return notes.filter((n) => n && isNum(n.beat) && isNum(n.dur) && n.dur > 0 && isNum(n.key)).sort((a, b) => a.beat - b.beat || b.key - a.key);
}

function buildBass(inputs: ProfileInput[]): StyleProfile['bass'] {
  const lengths: Array<{ v: number; w: number }> = [];
  const degrees = new Array<number>(12).fill(0);
  let degreeTracks = 0;
  const align: number[] = [];
  const glides: number[] = [];
  let tracks = 0;
  for (const inp of inputs) {
    const raw = inp.features.lines?.bass;
    if (!raw) continue;
    const notes = validSorted(raw);
    if (notes.length < MIN_BASS_NOTES) continue;
    tracks++;
    // Lengths: 33 quantiles per track, each track weighing 1.
    const durs = new Float64Array(notes.length);
    for (let i = 0; i < notes.length; i++) durs[i] = notes[i].dur;
    durs.sort();
    const Q = 33;
    for (let q = 0; q < Q; q++) lengths.push({ v: durs[Math.min(durs.length - 1, Math.round((q / (Q - 1)) * (durs.length - 1)))], w: 1 / Q });
    // Degrees relative to the track's key root.
    const key = trackKey(inp);
    if (key) {
      degreeTracks++;
      for (const n of notes) degrees[mod(Math.round(n.key) - key.root, 12)] += 1 / notes.length;
    }
    // Kick alignment: drum hits when available, else the drum grid's likely kick steps.
    const fromHits = kickAlignFromHits(inp, notes);
    if (fromHits !== null) {
      align.push(fromHits);
    } else {
      const d = inp.features.drums;
      const kc = d && d.bars >= MIN_DRUM_BARS ? d.counts.kick : undefined;
      if (kc && d) {
        const bpb = beatsPerBar(inp.features.analysis);
        const likely = (s: number) => kc[mod(s, GRID_STEPS)] / d.bars >= 0.4;
        const hit = notes.filter((n) => {
          const s = Math.round((mod(n.beat, bpb) / bpb) * GRID_STEPS);
          return likely(s - 1) || likely(s) || likely(s + 1);
        }).length;
        align.push(hit / notes.length);
      }
    }
    // Glides: the next note starts within a 32nd of this one ending (or overlaps) at another pitch.
    let g = 0;
    for (let i = 0; i + 1 < notes.length; i++) {
      const gap = notes[i + 1].beat - (notes[i].beat + notes[i].dur);
      if (gap < THIRTY_SECOND && notes[i + 1].key !== notes[i].key) g++;
    }
    glides.push(g / (notes.length - 1));
  }
  if (tracks < MIN_PROFILE_TRACKS) return null;
  return {
    length: weightedPercentiles(lengths, 3),
    degrees: degreeTracks ? degrees.map((d) => round(d / degreeTracks, 3)) : new Array<number>(12).fill(0),
    kickAlign: align.length ? round(align.reduce((s, x) => s + x, 0) / align.length, 3) : NaN,
    glide: round(glides.reduce((s, x) => s + x, 0) / glides.length, 3),
    tracks,
  };
}

/** A track's chord sequence for progression counting: spans under half a beat dropped, repeats merged. */
function chordSequence(chords: BeatChord[]): BeatChord[] {
  const out: BeatChord[] = [];
  for (const c of chords) {
    if (!isNum(c.beat) || !isNum(c.dur) || c.dur < 0.5) continue;
    const prev = out[out.length - 1];
    if (prev && prev.root === c.root && prev.quality === c.quality) {
      prev.dur = c.beat + c.dur - prev.beat;
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

const QUALITIES: ReadonlyArray<BeatChord['quality']> = ['maj', 'min', '7', 'maj7', 'm7', 'dim', 'sus', '5'];
/** Numeral ids: (interval × 8 + quality) × 2 + minor → 192 possible numerals. */
const NUMERAL_IDS = 12 * QUALITIES.length * 2;
const numeralText = new Map<number, string>();
const loopCache = new Map<number, { id: string; loop: string[] }>();

function numeralId(root: number, quality: BeatChord['quality'], keyRoot: number, minor: boolean): number {
  const q = Math.max(0, QUALITIES.indexOf(quality));
  const id = (mod(root - keyRoot, 12) * QUALITIES.length + q) * 2 + (minor ? 1 : 0);
  if (!numeralText.has(id)) numeralText.set(id, romanNumeral(mod(root - keyRoot, 12), QUALITIES[q], 0, minor));
  return id;
}

/** Canonical loop for a raw 4-numeral window (integer key), cached across tracks. */
function canonicalWindow(key: number): { id: string; loop: string[] } {
  let c = loopCache.get(key);
  if (!c) {
    const ids: number[] = [];
    let k = key;
    for (let i = 0; i < 4; i++) {
      ids.unshift(k % NUMERAL_IDS);
      k = Math.floor(k / NUMERAL_IDS);
    }
    const loop = canonicalLoop(ids.map((id) => numeralText.get(id) ?? '?'));
    c = { id: loop.join(' '), loop };
    if (loopCache.size > 50_000) loopCache.clear();
    loopCache.set(key, c);
  }
  return c;
}

function buildHarmony(inputs: ProfileInput[]): StyleProfile['harmony'] {
  const presence = new Map<string, { degrees: string[]; tracks: number; total: number }>();
  const changes: number[] = [];
  let tracks = 0;
  for (const inp of inputs) {
    const key = trackKey(inp);
    const seq = chordSequence(inp.features.chords ?? []);
    if (!key || seq.length < 4) continue;
    tracks++;
    const ids = seq.map((c) => numeralId(c.root, c.quality, key.root, key.minor));
    // Count raw windows first (a looped song repeats a handful of them), then canonicalise each once.
    const raw = new Map<number, number>();
    for (let i = 0; i + 4 <= ids.length; i++) {
      const w = ((ids[i] * NUMERAL_IDS + ids[i + 1]) * NUMERAL_IDS + ids[i + 2]) * NUMERAL_IDS + ids[i + 3];
      raw.set(w, (raw.get(w) ?? 0) + 1);
    }
    const mine = new Map<string, { loop: string[]; n: number }>();
    for (const [w, n] of raw) {
      const c = canonicalWindow(w);
      const e = mine.get(c.id);
      if (e) e.n += n;
      else mine.set(c.id, { loop: c.loop, n });
    }
    for (const [id, { loop, n }] of mine) {
      const e = presence.get(id) ?? { degrees: loop, tracks: 0, total: 0 };
      e.tracks++;
      e.total += n;
      presence.set(id, e);
    }
    const bpb = beatsPerBar(inp.features.analysis);
    const span = seq[seq.length - 1].beat + seq[seq.length - 1].dur - seq[0].beat;
    // Harmonic rhythm: chords per bar over the span the chords cover (a chord every bar = 1).
    if (span > 0) changes.push(seq.length / (span / bpb));
  }
  if (tracks < MIN_PROFILE_TRACKS) return null;
  const progressions = [...presence.entries()]
    .sort((a, b) => b[1].tracks - a[1].tracks || b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([, e]) => ({ degrees: e.degrees.slice(), count: e.tracks }));
  return { progressions, changesPerBar: round(median(changes), 2), tracks };
}

/** Section labels relabelled by first appearance (A, B, C …), consecutive repeats collapsed. */
export function normaliseForm(labels: readonly string[]): string[] {
  const map = new Map<string, string>();
  const out: string[] = [];
  for (const l of labels) {
    if (!map.has(l)) map.set(l, map.size < 26 ? String.fromCharCode(65 + map.size) : `S${map.size + 1}`);
    const x = map.get(l)!;
    if (out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

function buildStructure(inputs: ProfileInput[]): StyleProfile['structure'] {
  const sectionBars: Array<{ v: number; w: number }> = [];
  const forms = new Map<string, { form: string[]; count: number }>();
  const shapes: number[][] = [];
  const lengths: number[] = [];
  let tracks = 0;
  for (const inp of inputs) {
    const a = inp.features.analysis;
    if (!a) continue;
    if (isNum(a.durationSec) && a.durationSec > 0) lengths.push(a.durationSec);
    const curve = a.energy?.lufs ?? [];
    if (curve.length >= ENERGY_POINTS) {
      let top = -Infinity;
      for (const x of curve) if (isNum(x) && x > top) top = x;
      if (isNum(top)) {
        const seg = segmentMeans(curve.map((x) => (isNum(x) ? Math.max(x, top - 40) : top - 40)), ENERGY_POINTS);
        const lo = Math.min(...seg);
        const hi = Math.max(...seg);
        if (hi - lo >= 0.5) shapes.push(seg.map((x) => (x - lo) / (hi - lo)));
      }
    }
    const map = beatMapper(a);
    const secs = (a.sections ?? []).filter((s) => isNum(s.startSec) && isNum(s.endSec) && s.endSec > s.startSec);
    if (secs.length < 2 || !map) continue;
    tracks++;
    const bpb = beatsPerBar(a);
    for (const s of secs) sectionBars.push({ v: (map(s.endSec) - map(s.startSec)) / bpb, w: 1 / secs.length });
    const form = normaliseForm(secs.map((s) => s.label));
    if (form.length <= 16) {
      const id = form.join(' ');
      const e = forms.get(id) ?? { form, count: 0 };
      e.count++;
      forms.set(id, e);
    }
  }
  if (tracks < MIN_PROFILE_TRACKS) return null;
  let energyShape: number[] = [];
  if (shapes.length) {
    const med = new Array<number>(ENERGY_POINTS).fill(0).map((_, i) => median(shapes.map((s) => s[i])));
    const lo = Math.min(...med);
    const hi = Math.max(...med);
    energyShape = med.map((x) => round(hi - lo > 0.05 ? (x - lo) / (hi - lo) : x, 3));
  }
  return {
    sectionBars: weightedPercentiles(sectionBars, 1),
    forms: [...forms.values()].sort((a, b) => b.count - a.count || a.form.length - b.form.length || (a.form.join(' ') < b.form.join(' ') ? -1 : 1)).slice(0, 5),
    energyShape,
    lengthSec: percentiles(lengths, 0),
  };
}

const BAND_NAMES = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'] as const;

function buildMix(inputs: ProfileInput[]): StyleProfile['mix'] {
  const lufs: number[] = [];
  const tp: number[] = [];
  const width: number[] = [];
  const rel: Record<(typeof BAND_NAMES)[number], number[]> = { sub: [], low: [], lowMid: [], mid: [], highMid: [], high: [] };
  let tracks = 0;
  for (const inp of inputs) {
    const a = inp.features.analysis;
    const lv = a?.levels;
    if (!lv) continue;
    tracks++;
    if (isNum(lv.lufsIntegrated) && lv.lufsIntegrated > -70) lufs.push(lv.lufsIntegrated);
    if (isNum(lv.truePeakDb) && lv.truePeakDb > -70) tp.push(lv.truePeakDb);
    const w = a.stereo?.width ?? lv.stereoWidth;
    if (isNum(w)) width.push(w);
    const bands = BAND_NAMES.map((b) => lv.bands?.[b]);
    if (bands.every(isNum)) {
      const top = Math.max(...(bands as number[]));
      BAND_NAMES.forEach((b, i) => rel[b].push((bands[i] as number) - top));
    }
  }
  if (tracks < MIN_PROFILE_TRACKS || lufs.length < MIN_PROFILE_TRACKS) return null;
  const bands = {} as NonNullable<StyleProfile['mix']>['bands'];
  for (const b of BAND_NAMES) bands[b] = rel[b].length ? round(median(rel[b]), 1) : NaN;
  return { lufs: percentiles(lufs, 1), truePeakDb: percentiles(tp, 1), width: percentiles(width, 2), bands };
}

// ── Examples (seeded sampling) ──────────────────────────────────────────

const STEP_TICKS_16 = 240;
const STEP_TICKS_32 = 120;
const BAR_TICKS = 3840;
/** Steps at or above this probability are always played in examples. */
const STRONG = 0.8;
/** Steps below this probability are never played in examples (noise). */
const RARE = 0.12;

function safeTitle(name: string): string {
  const t = name.replace(/["\\\r\n]/g, "'").trim().slice(0, 40);
  return t || 'Style';
}

function exampleVel(v: number): number {
  if (v >= 0.9) return 127;
  if (v > 0 && v <= 0.45) return 50;
  return 100;
}

interface DrumSketch {
  kpn: string;
  /** Kick onsets per bar (16th step indices 0..15). */
  kicks: number[][];
}

function sampleDrums(drums: NonNullable<StyleProfile['drums']>, title: string, rng: () => number): DrumSketch | null {
  const tracks: PrintTrack[] = [];
  const kicks: number[][] = [[], []];
  for (const role of DRUM_ROLES) {
    const r = drums.roles[role];
    if (!r) continue;
    const maxP = Math.max(...r.prob);
    if (maxP < RARE + 0.03) continue;
    const odd = r.prob.filter((_, s) => s % 2 === 1);
    const rolls = role === 'hat' && drums.rollsPerBar >= 0.1;
    const use32 = rolls || Math.max(...odd) >= 0.25;
    const stepTicks = use32 ? STEP_TICKS_32 : STEP_TICKS_16;
    const notes: PrintNote[] = [];
    const argmax = r.prob.indexOf(maxP);
    for (let bar = 0; bar < 2; bar++) {
      const on = new Set<number>();
      for (let s = 0; s < GRID_STEPS; s++) {
        if (!use32 && s % 2 === 1) continue;
        const p = r.prob[s];
        if (p >= STRONG || (p >= RARE && rng() < p)) on.add(s);
      }
      if (bar === 0 && maxP >= 0.5) on.add(argmax);
      if (rolls) {
        // A roll in bar 2 always (the style rolls), in bar 1 by its rate.
        if (bar === 1 || rng() < drums.rollsPerBar) {
          const start = [24, 26, 28][Math.floor(rng() * 3)];
          for (let s = start; s < GRID_STEPS; s++) on.add(s);
        }
      }
      for (const s of [...on].sort((a, b) => a - b)) {
        notes.push({ tick: bar * BAR_TICKS + s * STEP_TICKS_32, dur: stepTicks, key: 60, vel: exampleVel(r.vel[s]) / 127 });
        if (role === 'kick') kicks[bar].push(s / 2);
      }
    }
    if (notes.length) tracks.push({ name: role, notes, drum: true, drumKey: 60 });
  }
  if (!tracks.length) return null;
  const res = printKpn(tracks, { name: `${title} drums sketch`, bars: 2, grid: 16, compress: false });
  return { kpn: res.text, kicks: kicks.map((k) => k.filter((s) => Number.isInteger(s))) };
}

const MINOR_DEGREE_TOKENS = ['^1', '^b2', '^2', '^3', '^#3', '^4', '^b5', '^5', '^6', '^#6', '^7', '^#7'];
const MAJOR_DEGREE_TOKENS = ['^1', '^b2', '^2', '^b3', '^3', '^4', '^#4', '^5', '^b6', '^6', '^b7', '^7'];

/** A length in beats sampled from a percentile summary → 16th steps in [lo, hi] (4 steps when the summary is unusable). */
function sampleSteps(p: Percentiles, rng: () => number, lo: number, hi: number): number {
  const beats = sampleFromPercentiles(p, rng());
  return clamp(isNum(beats) ? Math.round(beats * 4) : 4, lo, hi);
}

function pickWeighted(weights: readonly number[], rng: () => number): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!(total > 0)) return 0;
  let x = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= Math.max(0, weights[i]);
    if (x < 0) return i;
  }
  return weights.length - 1;
}

function sampleBass(bass: NonNullable<StyleProfile['bass']>, minor: boolean, kicks: number[][] | null, title: string, rng: () => number): string {
  const key = minor ? 'Am' : 'C';
  const oct = minor ? 1 : 2;
  const tokens = minor ? MINOR_DEGREE_TOKENS : MAJOR_DEGREE_TOKENS;
  const align = isNum(bass.kickAlign) ? bass.kickAlign : 0.5;
  const barTokens: string[][] = [];
  for (let bar = 0; bar < 2; bar++) {
    // Onsets (16th steps): on the kicks by the style's alignment, plus off-kick notes.
    const on = new Set<number>([0]);
    const k = kicks?.[bar] ?? [];
    if (k.length) {
      for (const s of k) if (s === 0 || rng() < align) on.add(s);
      const extra = Math.round((k.length * (1 - align)) / Math.max(align, 0.25));
      for (let e = 0; e < extra; e++) on.add(2 * Math.floor(rng() * 8));
    } else {
      let pos = 0;
      while (pos < 16) {
        const len = sampleSteps(bass.length, rng, 1, 8);
        pos += len + (rng() < 0.3 ? 2 : 0);
        if (pos < 16) on.add(pos);
      }
    }
    const steps = [...on].filter((s) => s >= 0 && s < 16).sort((a, b) => a - b);
    const degs = steps.map((s) => (s === 0 ? 0 : pickWeighted(bass.degrees, rng)));
    const toks: string[] = [];
    let cursor = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const next = i + 1 < steps.length ? steps[i + 1] : 16;
      if (s > cursor) toks.push(`r:${s - cursor}`);
      const deg = degs[i];
      // Slides only into a different pitch.
      const glide = next < 16 && degs[i + 1] !== deg && rng() < bass.glide;
      const want = sampleSteps(bass.length, rng, 1, 16);
      const len = glide ? next - s : Math.min(want, next - s);
      toks.push(`${tokens[deg]}:${len}${glide ? '~' : ''}`);
      cursor = s + len;
    }
    if (cursor < 16) toks.push(`r:${16 - cursor}`);
    barTokens.push(toks);
  }
  return `pattern "${title} bass sketch" bars=2 grid=16 key=${key}\nbass {oct=${oct}}: ${barTokens.map((t) => t.join(' ')).join(' | ')}`;
}

// ── buildProfile ────────────────────────────────────────────────────────

/** Aggregate a collection. Sections with too little data are null and explained in `caveats`. */
export function buildProfile(collection: Pick<Collection, 'id' | 'name'>, tracks: ProfileInput[], opts: { seed?: number; now?: number } = {}): StyleProfile {
  const inputs = tracks.filter((t) => t && t.features && t.features.analysis);
  const analysed = inputs.length;
  const deep = inputs.filter((t) => t.track?.status === 'deep' || Object.values(t.features.lines ?? {}).some((l) => (l?.length ?? 0) > 0)).length;

  const tempo = buildTempo(inputs);
  const swing = buildSwing(inputs);
  const keys = buildKeys(inputs);
  const drums = buildDrums(inputs);
  const bass = buildBass(inputs);
  const harmony = buildHarmony(inputs);
  const structure = buildStructure(inputs);
  const mix = buildMix(inputs);

  const seed = isNum(opts.seed) ? opts.seed >>> 0 : hashString(collection.id);
  const title = safeTitle(collection.name);
  const drumSketch = drums ? sampleDrums(drums, title, seededRng(seed)) : null;
  const minor = keys ? keys.minorShare >= 0.5 : true;
  const bassText = bass ? sampleBass(bass, minor, drumSketch?.kicks ?? null, title, seededRng((seed ^ 0x9e3779b9) >>> 0)) : null;

  const caveats: string[] = [];
  const need = (what: string, have: number) => `${what} (have ${have}, need ${MIN_PROFILE_TRACKS}).`;
  if (analysed === 0) caveats.push('No analysed tracks yet: import references and wait for the light pass.');
  else if (analysed < THIN_PROFILE) caveats.push(`Only ${analysed} analysed track${analysed === 1 ? '' : 's'}: treat these numbers as hints (10+ references give a steadier profile).`);
  if (!tempo) caveats.push(need('Tempo: too few tracks with a stable tempo', inputs.filter((i) => trackBpm(i) !== null).length));
  if (!swing) caveats.push(need('Swing: too few tracks with measurable 16th swing', inputs.filter((i) => isNum(i.features.analysis.swing)).length));
  if (!keys) caveats.push(need('Keys: too few tracks with a detected key', inputs.filter((i) => trackKey(i)).length));
  const odd = inputs.filter((i) => (i.features.drums?.bars ?? 0) >= MIN_DRUM_BARS && beatsPerBar(i.features.analysis) !== 4).length;
  if (!drums) caveats.push(need('Drums: too few tracks in 4/4 with a usable beat grid and drum hits', inputs.filter((i) => drumGridOf(i)).length));
  else if (drums.source !== 'stem') caveats.push(`Drum hits come from the full mix${drums.source === 'mixed' ? ' for some tracks' : ''}: kick and snare are fair, hats and percussion are rough. Deep analysis (drum stem) is more accurate.`);
  if (odd) caveats.push(`${odd} track${odd === 1 ? ' is' : 's are'} not in 4/4 and left out of the drum odds.`);
  if (!bass) caveats.push(need('Bass/808: needs deep analysis (stems + transcription) on enough tracks', inputs.filter((i) => (i.features.lines?.bass?.length ?? 0) >= MIN_BASS_NOTES).length));
  if (!harmony) caveats.push(need('Harmony: too few tracks with a key and 4+ chord estimates', inputs.filter((i) => trackKey(i) && chordSequence(i.features.chords ?? []).length >= 4).length));
  else caveats.push('Chords are rough estimates (chroma templates): trust the common progressions more than any single one.');
  if (!structure) caveats.push(need('Structure: too few tracks with a section map', inputs.filter((i) => (i.features.analysis.sections?.length ?? 0) >= 2).length));
  if (!mix) caveats.push(need('Mix: too few tracks with loudness data', inputs.filter((i) => isNum(i.features.analysis.levels?.lufsIntegrated)).length));
  if (tempo && tempo.halfTimeShare >= 0.3) caveats.push(`Tempo reads as half or double time in ${Math.round(tempo.halfTimeShare * 100)}% of tracks: the same groove can be written at either tempo.`);

  return {
    collectionId: collection.id,
    name: collection.name,
    tracks: tracks.length,
    analysed,
    deep,
    updatedAt: isNum(opts.now) ? opts.now : Date.now(),
    tempo,
    swing,
    keys,
    drums,
    bass,
    harmony,
    structure,
    mix,
    examples: { drums: drumSketch?.kpn ?? null, bass: bassText },
    caveats,
  };
}

// ── profileText ─────────────────────────────────────────────────────────

const ROLE_LABEL: Record<DrumRole, string> = { kick: 'Kick', snare: 'Snare/clap', hat: 'Hi-hat', openhat: 'Open hat', perc: 'Perc' };
const DEGREE_LABEL = ['root', 'b2', '2nd', 'b3', '3rd', '4th', 'b5', '5th', 'b6', '6th', 'b7', '7th'];

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Name of a 32nd step in "1 e & a" counting. */
export function stepName(s: number): string {
  const beat = Math.floor(s / 8) + 1;
  const sub = s % 8;
  if (sub === 0) return `beat ${beat}`;
  if (sub === 4) return `the "and" of ${beat}`;
  if (sub === 2) return `the "e" of ${beat}`;
  if (sub === 6) return `the "a" of ${beat}`;
  return `the 32nd after ${stepName(s - 1)}`;
}

function describeRole(role: DrumRole, prob: number[]): string {
  const sixteenths = prob.filter((_, s) => s % 2 === 0);
  const dense = sixteenths.filter((p) => p >= 0.5).length;
  if (dense >= 14) return 'steady 16ths';
  const eighths = sixteenths.filter((_, i) => i % 2 === 0);
  const offs = sixteenths.filter((_, i) => i % 2 === 1);
  if (role !== 'kick' && eighths.every((p) => p >= 0.5) && offs.every((p) => p < 0.3)) return 'straight 8ths';
  const items = prob
    .map((p, s) => ({ p, s }))
    .filter((x) => x.p >= 0.2)
    .sort((a, b) => b.p - a.p || a.s - b.s)
    .slice(0, 5);
  if (!items.length) return 'sparse, no fixed spot';
  return items
    .map(({ p, s }) => (p >= 0.9 ? `${stepName(s)} always` : p >= 0.7 ? `${stepName(s)} in most bars (${pct(p)})` : `${stepName(s)} in ${pct(p)} of bars`))
    .join(', ');
}

/** One char per 16th: 9 = ~always … 1 = rare, . = never. */
function sketchLine(prob: number[]): string {
  const chars: string[] = [];
  for (let i = 0; i < 16; i++) {
    const p = Math.max(prob[2 * i], prob[2 * i + 1]);
    chars.push(p < 0.05 ? '.' : String(Math.min(9, Math.max(1, Math.round(p * 10)))));
  }
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join(' ');
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "140 BPM (middle half 138 to 142)"; just the median when the middle half is one value. */
function range(p: Percentiles, fmt: (x: number) => string, unit: string): string {
  const lo = fmt(p.p25);
  const hi = fmt(p.p75);
  return lo === hi ? `${fmt(p.median)}${unit}` : `${fmt(p.median)}${unit} (middle half ${lo} to ${hi})`;
}

/** Compact plain text for an agent (MCP get_style_profile, focus prompt, built-in agent): numbers, idioms and KPN examples. */
export function profileText(profile: StyleProfile, opts: { brief?: string; maxChars?: number } = {}): string {
  const maxChars = Math.max(400, opts.maxChars ?? 3500);
  // Blocks in reading order with a priority (lower = dropped first when over budget).
  const blocks: Array<{ text: string; prio: number }> = [];
  const add = (text: string | null, prio: number) => {
    if (text) blocks.push({ text, prio });
  };

  add(
    `STYLE PROFILE "${profile.name}": ${profile.analysed} analysed reference track${profile.analysed === 1 ? '' : 's'}${profile.deep ? ` (${profile.deep} deep-analysed)` : ''}. ` +
      'Estimates aggregated from the user\'s own references: compose ORIGINAL material in this style, never recreate a reference.',
    100,
  );
  const brief = opts.brief?.trim();
  if (brief) add(`User's brief (follow it): "${brief.slice(0, 400)}"`, 99);
  add(
    'How to use: pick a tempo and key from the ranges, fix the "always" drum steps and vary the likelier ones bar to bar, let the bass follow the kick as described, use a common progression as a starting point, and run check_originality on finished melodies.',
    35,
  );

  // Tempo & feel.
  const feel: string[] = [];
  if (profile.tempo) {
    const t = profile.tempo;
    const common = t.histogram
      .slice()
      .sort((a, b) => b.count - a.count || a.bpm - b.bpm)
      .slice(0, 3)
      .map((h) => `${h.bpm}–${h.bpm + 3} (${h.count})`)
      .join(', ');
    let s = `Tempo: ${range(t.bpm, (x) => `${Math.round(x)}`, ' BPM')}; most common ${common}.`;
    if (t.halfTimeShare >= 0.3) s += ` Half/double-time feel in ${pct(t.halfTimeShare)} of tracks: e.g. ${Math.round(t.bpm.median)} BPM with a half-time backbeat reads like ${Math.round(t.bpm.median / 2)}.`;
    feel.push(s);
  }
  if (profile.swing) {
    const sw = profile.swing;
    feel.push(sw.median < 0.1 && sw.share < 0.3 ? `Feel: straight 16ths (median swing ${sw.median.toFixed(2)}).` : `Feel: swung in ${pct(sw.share)} of tracks (median swing ${sw.median.toFixed(2)}; set it with set_swing).`);
  }
  add(feel.join(' ') || null, 90);

  if (profile.keys) {
    const k = profile.keys;
    add(`Keys: ${pct(k.minorShare)} minor. Common: ${k.top.slice(0, 5).map((x) => `${x.key} (${x.count})`).join(', ')}.`, 85);
  }

  // Drums.
  if (profile.drums) {
    const d = profile.drums;
    const lines: string[] = [`Drums (${d.tracks} tracks, from ${d.source === 'stem' ? 'drum stems' : d.source === 'mix' ? 'the full mix, rough' : 'mix + stems'}; per bar):`];
    for (const role of DRUM_ROLES) {
      const r = d.roles[role];
      if (!r || Math.max(...r.prob) < 0.1) continue;
      let s = `- ${ROLE_LABEL[role]}: ${describeRole(role, r.prob)}`;
      if (role === 'snare') {
        const three = r.prob[16];
        const twoFour = Math.max(r.prob[8], r.prob[24]);
        if (three >= 0.5 && three > twoFour * 1.5) s += ' (half-time backbeat on 3)';
        else if (twoFour >= 0.5) s += ' (backbeat on 2 and 4)';
      }
      if (role === 'hat' && d.rollsPerBar >= 0.05) s += `; 32nd rolls about ${d.rollsPerBar >= 1 ? `${d.rollsPerBar.toFixed(1)} per bar` : `once every ${Math.max(1, Math.round(1 / d.rollsPerBar))} bars`}`;
      lines.push(`${s}.`);
    }
    add(lines.join('\n'), 80);
    const sketch = DRUM_ROLES.filter((r) => d.roles[r] && Math.max(...d.roles[r]!.prob) >= 0.1).map((r) => `  ${r.padEnd(7)} ${sketchLine(d.roles[r]!.prob)}`);
    if (sketch.length) add(`Step odds per 16th (9 = nearly every bar … 1 = rare, . = never):\n${sketch.join('\n')}`, 40);
  }

  if (profile.bass) {
    const b = profile.bass;
    const degs = b.degrees
      .map((p, i) => ({ p, i }))
      .filter((x) => x.p >= 0.05)
      .sort((x, y) => y.p - x.p)
      .slice(0, 5)
      .map((x) => `${DEGREE_LABEL[x.i]} ${pct(x.p)}`)
      .join(', ');
    const parts = [`Bass/808 (${b.tracks} deep tracks): note length ${range(b.length, (x) => `${round(x, 2)}`, b.length.median === 1 && b.length.p25 === b.length.p75 ? ' beat' : ' beats')}`];
    if (degs) parts.push(`notes vs the key root: ${degs}`);
    if (isNum(b.kickAlign)) parts.push(`${pct(b.kickAlign)} of notes land with a kick`);
    parts.push(`${pct(b.glide)} slide into the next note (~ in KPN)`);
    add(`${parts.join('; ')}.`, 75);
  }

  if (profile.harmony) {
    const h = profile.harmony;
    const progs = h.progressions.slice(0, 4).map((p) => `${p.degrees.join('–')} (${p.count} track${p.count === 1 ? '' : 's'})`).join(', ');
    const rate = h.changesPerBar > 0 ? (h.changesPerBar >= 0.9 ? `about ${h.changesPerBar.toFixed(1)} chord changes per bar` : `a chord every ${Math.max(1, Math.round(1 / h.changesPerBar))} bars or so`) : 'chords rarely change';
    add(`Harmony (roman numerals vs each track's key; lowercase = minor): ${progs || 'no common loop'}; ${rate}.`, 70);
  }

  if (profile.structure) {
    const st = profile.structure;
    const parts = [`Structure: sections ${range(st.sectionBars, (x) => `${Math.round(x)}`, ' bars')}`];
    if (st.forms.length) parts.push(`common forms ${st.forms.slice(0, 2).map((f) => `${f.form.join(' ')} (${f.count})`).join('; ')}`);
    if (st.energyShape.length) parts.push(`energy across the track (0 low … 9 peak): ${st.energyShape.map((x) => Math.min(9, Math.round(x * 9))).join('')}`);
    parts.push(`length ${fmtTime(st.lengthSec.median)} (${fmtTime(st.lengthSec.p25)}–${fmtTime(st.lengthSec.p75)})`);
    add(`${parts.join('; ')}.`, 60);
  }

  if (profile.mix) {
    const m = profile.mix;
    const bands = (['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'] as const).map((b) => `${b} ${isNum(m.bands[b]) ? Math.round(m.bands[b]) : '?'}`).join(', ');
    add(`Mix targets: ${range(m.lufs, (x) => x.toFixed(1), ' LUFS')}, true peak ${m.truePeakDb.median.toFixed(1)} dBTP, width ${m.width.median.toFixed(2)}; band balance vs the loudest band (dB): ${bands}.`, 55);
  }

  if (profile.examples.drums) add(`Example drums, sampled from these odds (KPN for write_pattern; vary it, don't loop it verbatim):\n${profile.examples.drums}`, 50);
  if (profile.examples.bass) add(`Example bass in scale degrees (transpose with key=):\n${profile.examples.bass}`, 45);
  if (profile.caveats.length) add(`Caveats: ${profile.caveats.join(' ')}`, 30);

  const join = (bs: typeof blocks) => bs.map((b) => b.text).join('\n');
  let kept = blocks.slice();
  while (kept.length > 1 && join(kept).length > maxChars) {
    const lowest = kept.reduce((lo, b) => (b.prio < lo.prio ? b : lo), kept[0]);
    kept = kept.filter((b) => b !== lowest);
  }
  let text = join(kept);
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}
