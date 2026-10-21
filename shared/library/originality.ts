// Originality check (research/08 §4.4): the project's melodic lines vs the
// deep-analysed references' transcribed lines, transposition-invariant
// (pitch intervals) with rhythm (duration ratios). Pure. The DB layer
// stores lineHashes() for every reference line and looks candidates up by
// hash; findMatches() verifies them.
//
// Pipeline:
//  1. Monophonic reduction: notes whose onsets lie within 0.06 beat are one
//     onset; the highest note wins (the melody usually sits on top).
//  2. lineHashes: every NGRAM_NOTES-note window → (4 pitch intervals, 3 IOI
//     ratio classes shorter/same/longer) → FNV-1a 32-bit. Intervals make it
//     transposition-invariant, IOI ratios make it tempo-invariant (a melody
//     written at double speed hashes the same).
//  3. findMatches: seeds = windows whose 4 intervals agree exactly; each seed
//     is extended both ways while intervals agree and the rhythm stays within
//     tolerance of the seed's tempo ratio. Near-misses ride over transcription
//     errors: a rhythm off by up to ~75 %, an interval off by a semitone, or
//     one wrong note (two neighbouring intervals off by +e / -e) — at most one
//     per 8 notes, never two in a row, and a run never ends on one. Runs of
//     ≥ minNotes notes that aren't "too generic" (repeated notes, plain scale
//     runs, two-note trills, ≤ 2 pitch classes, low interval entropy) are
//     reported; runs overlapping in the project line are deduped per reference.
//
// Units: lineHashes() and findMatches() work in BEATS. Use beatNoteHashes()
// for reference lines (BeatNote) and projectLineHashes() for project lines
// (ticks) so both sides of the hash index agree.

import type { AudioAnalysis } from '../analyzer/protocol';
import type { Channel, Project } from '../schema/project';
import { PPQ, ticksPerBar } from '../schema/time';
import type { BeatNote, OriginalityMatch, OriginalityReport, ProjectLine } from './types';
import { beatToSec } from './grid';
import { isNum, round } from './stats';

/** n-gram length used for hashing (notes per n-gram). */
export const NGRAM_NOTES = 5;
/** Default minimum run (notes) that counts as a match. */
export const MIN_MATCH_NOTES = 8;
/** Onsets closer than this (beats) are one onset (chord / transcription double). */
export const ONSET_TOLERANCE = 0.06;
/** |log2(IOI ratio)| below this counts as "same length" in a hash. */
const RHYTHM_SAME = 0.25;
/** Rhythm tolerance when verifying (|log2| deviation from the run's tempo ratio). */
const RHYTHM_OK = 0.35;
const RHYTHM_SOFT = 0.8;
const MAX_INTERVAL = 36;
const MAX_MATCHES_PER_LINE = 24;

export interface MonoLine {
  /** Onsets, in the input's time unit (beats). */
  start: number[];
  key: number[];
}

/** Monophonic reduction: one note per onset (the highest), onsets within `tolerance` merged. */
export function monophonic(notes: ReadonlyArray<{ start: number; dur?: number; key: number }>, tolerance = ONSET_TOLERANCE): MonoLine {
  const sorted = notes.filter((n) => n && isNum(n.start) && isNum(n.key)).slice().sort((a, b) => a.start - b.start || b.key - a.key);
  const start: number[] = [];
  const key: number[] = [];
  let clusterStart = -Infinity;
  for (const n of sorted) {
    if (start.length && n.start - clusterStart <= tolerance) {
      if (n.key > key[key.length - 1]) key[key.length - 1] = n.key;
      continue;
    }
    clusterStart = n.start;
    start.push(n.start);
    key.push(Math.round(n.key));
  }
  return { start, key };
}

function intervalsOf(m: MonoLine): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < m.key.length; i++) out.push(Math.max(-MAX_INTERVAL, Math.min(MAX_INTERVAL, m.key[i + 1] - m.key[i])));
  return out;
}

function ioisOf(m: MonoLine): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < m.start.length; i++) out.push(Math.max(1e-6, m.start[i + 1] - m.start[i]));
  return out;
}

function rhythmClass(prevIoi: number, ioi: number): number {
  const r = Math.log2(ioi / prevIoi);
  return r > RHYTHM_SAME ? 2 : r < -RHYTHM_SAME ? 0 : 1;
}

function fnvByte(h: number, b: number): number {
  return Math.imul(h ^ (b & 0xff), 0x01000193);
}

/**
 * Hashes of every n-gram of a line (positions = note index of the n-gram start). Monophonic reduction first (highest note per onset).
 * Times are beats (any unit works when `tolerance` — the chord-onset merge window — is given in that unit).
 * Windows of one repeated note are skipped (they would match everything).
 */
export function lineHashes(notes: Array<{ start: number; dur: number; key: number }>, opts: { tolerance?: number } = {}): Array<{ hash: number; pos: number }> {
  const m = monophonic(notes, opts.tolerance ?? ONSET_TOLERANCE);
  const iv = intervalsOf(m);
  const ioi = ioisOf(m);
  const out: Array<{ hash: number; pos: number }> = [];
  for (let i = 0; i + NGRAM_NOTES <= m.key.length; i++) {
    let h = 0x811c9dc5;
    let allZero = true;
    for (let j = 0; j < NGRAM_NOTES - 1; j++) {
      const d = iv[i + j];
      if (d !== 0) allZero = false;
      h = fnvByte(h, d + 64);
    }
    if (allZero) continue;
    for (let j = 1; j < NGRAM_NOTES - 1; j++) h = fnvByte(h, 200 + rhythmClass(ioi[i + j - 1], ioi[i + j]));
    out.push({ hash: h >>> 0, pos: i });
  }
  return out;
}

/** lineHashes of a reference line (BeatNote, beats from the first downbeat). */
export function beatNoteHashes(notes: readonly BeatNote[]): Array<{ hash: number; pos: number }> {
  return lineHashes(notes.map((n) => ({ start: n.beat, dur: n.dur, key: n.key })));
}

/** lineHashes of a project line (ticks at PPQ 960 → beats). */
export function projectLineHashes(line: Pick<ProjectLine, 'notes'>): Array<{ hash: number; pos: number }> {
  return lineHashes(line.notes.map((n) => ({ start: n.tick / PPQ, dur: n.dur / PPQ, key: n.key })));
}

// ── Project lines ───────────────────────────────────────────────────────

const DRUM_NAME = /kick|snare|clap|hi-?hat|\bhats?\b|perc|rim|\btoms?\b|cymbal|crash|\bride\b|shaker|tamb|conga|bongo|cowbell|\bsnap|drum|\bkit\b/i;
const DRUM_CODE = /^(bd|sd|cp|hh|oh|ch|ohh|chh|rs|cb)\d*$/i;
const DRUM_GENERATORS = new Set(['krypt.drumsynth', 'krypt.audioclip']);

/** Whether a channel is percussion (excluded from the originality check). */
export function isPercussionChannel(ch: Channel, distinctKeys: number): boolean {
  const name = ch.name.trim();
  const group = ch.group?.trim();
  if (group && /drum|perc/i.test(group)) return true;
  if (DRUM_GENERATORS.has(ch.generator.type)) return true;
  if (DRUM_NAME.test(name) || DRUM_CODE.test(name)) return true;
  // A sampler is a one-shot (drum) unless it plays a line, or the user grouped it elsewhere.
  if (ch.generator.type === 'krypt.sampler' && !group && distinctKeys < 3) return true;
  return false;
}

/** Melodic lines of the project: every pattern × pitched channel with ≥ NGRAM_NOTES notes (drum channels excluded). */
export function projectLines(p: Project): ProjectLine[] {
  const barTicks = ticksPerBar(p.transport.timeSig);
  const out: ProjectLine[] = [];
  for (const pid of p.patternOrder) {
    const pat = p.patterns[pid];
    if (!pat) continue;
    for (const cid of p.channelOrder) {
      const ch = p.channels[cid];
      const byId = pat.notes[cid];
      if (!ch || !byId) continue;
      const notes = Object.values(byId)
        .filter((n) => !n.mute)
        .map((n) => ({ tick: n.tick, dur: n.dur, key: n.key }))
        .sort((a, b) => a.tick - b.tick || a.key - b.key);
      if (notes.length < NGRAM_NOTES) continue;
      const distinct = new Set(notes.map((n) => n.key)).size;
      // Fewer than 3 pitches is a drum part or a pedal, never a melody worth checking.
      if (distinct < 3 || isPercussionChannel(ch, distinct)) continue;
      out.push({ label: `Pattern "${pat.name}" · ${ch.name}`, patternId: pid, channelId: cid, notes, barTicks });
    }
  }
  return out;
}

// ── Verification ────────────────────────────────────────────────────────

export interface ReferenceLine {
  trackId: string;
  trackName: string;
  stem: string;
  notes: BeatNote[];
  /** Track tempo, to report positions in seconds. */
  bpm: number;
  /** Seconds of the first downbeat (beat 0). */
  downbeatSec: number;
  /** Optional: the track's analysis. When given, refAtSec follows its beat grid exactly (tempo drift safe) instead of bpm + downbeatSec. */
  analysis?: AudioAnalysis;
}

/** Shannon entropy (bits) of a list of values. */
function entropy(values: readonly number[]): number {
  const c = new Map<number, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  let h = 0;
  for (const n of c.values()) {
    const p = n / values.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * True when a run of intervals is too generic to flag: a repeated note, a
 * two-note trill / alternation, a plain stepwise scale run (at most one turn),
 * one or two pitch classes, or very low interval entropy.
 */
export function isGenericRun(intervals: readonly number[], keys?: readonly number[]): boolean {
  if (intervals.length < 2) return true;
  if (new Set(intervals).size < 3) return true;
  if (keys && new Set(keys.map((k) => ((k % 12) + 12) % 12)).size <= 2) return true;
  const moves = intervals.filter((x) => x !== 0);
  if (moves.length && moves.every((x) => Math.abs(x) <= 2)) {
    let turns = 0;
    for (let i = 1; i < moves.length; i++) if (Math.sign(moves[i]) !== Math.sign(moves[i - 1])) turns++;
    if (turns <= 1) return true;
  }
  return entropy(intervals) < 1.2;
}

interface Run {
  /** First transition index in the project line / reference (note index of the run's first note). */
  i: number;
  j: number;
  /** Transitions in the run (notes = len + 1). */
  len: number;
  similarity: number;
}

type Verdict = 'ok' | 'soft' | 'bad';

/** Verified matches of ≥ minNotes consecutive notes between a project line and candidate reference lines. */
export function findMatches(line: ProjectLine, refs: ReferenceLine[], opts: { minNotes?: number; barTicks?: number } = {}): OriginalityMatch[] {
  const minNotes = Math.max(NGRAM_NOTES, Math.round(opts.minNotes ?? MIN_MATCH_NOTES));
  const barTicks = line.barTicks && line.barTicks > 0 ? line.barTicks : opts.barTicks && opts.barTicks > 0 ? opts.barTicks : PPQ * 4;
  const P = monophonic(line.notes.map((n) => ({ start: n.tick / PPQ, dur: n.dur / PPQ, key: n.key })));
  if (P.key.length < minNotes) return [];
  const pIv = intervalsOf(P);
  const pIoi = ioisOf(P);
  const seedLen = NGRAM_NOTES - 1;

  // Seed index: project interval 4-grams → positions.
  const index = new Map<string, number[]>();
  for (let i = 0; i + seedLen <= pIv.length; i++) {
    const k = pIv.slice(i, i + seedLen).join(',');
    const list = index.get(k);
    if (list) list.push(i);
    else index.set(k, [i]);
  }

  const matches: OriginalityMatch[] = [];
  for (const ref of refs) {
    if (!ref?.notes?.length) continue;
    const R = monophonic(ref.notes.map((n) => ({ start: n.beat, dur: n.dur, key: n.key })));
    if (R.key.length < minNotes) continue;
    const rIv = intervalsOf(R);
    const rIoi = ioisOf(R);

    /** Signed pitch-interval difference and |rhythm deviation| from the run's tempo ratio for one transition pair. */
    const look = (a: number, b: number, logS: number) => ({ dp: pIv[a] - rIv[b], dr: Math.abs(Math.log2(pIoi[a] / rIoi[b]) - logS) });

    const covered = new Map<number, Array<[number, number]>>();
    const isCovered = (i: number, j: number) => (covered.get(j - i) ?? []).some(([a, b]) => i >= a && i <= b);
    const cover = (i: number, j: number, a: number, b: number) => {
      const list = covered.get(j - i) ?? [];
      list.push([a, b]);
      covered.set(j - i, list);
    };
    const runs: Run[] = [];

    for (let j = 0; j + seedLen <= rIv.length; j++) {
      const seeds = index.get(rIv.slice(j, j + seedLen).join(','));
      if (!seeds) continue;
      for (const i of seeds) {
        if (isCovered(i, j)) continue;
        // The run's tempo ratio (project beats per reference beat) from the seed's median IOI ratio.
        const logs: number[] = [];
        for (let t = 0; t < seedLen; t++) logs.push(Math.log2(pIoi[i + t] / rIoi[j + t]));
        const sortedLogs = logs.slice().sort((x, y) => x - y);
        const logS = (sortedLogs[(seedLen - 1) >> 1] + sortedLogs[seedLen >> 1]) / 2;
        // Verdict per transition, keyed by offset from the seed start.
        const verdicts = new Map<number, Verdict>();
        let softs = 0;
        let seedBad = false;
        for (let t = 0; t < seedLen; t++) {
          const { dr } = look(i + t, j + t, logS);
          const v: Verdict = dr <= RHYTHM_OK ? 'ok' : dr <= RHYTHM_SOFT ? 'soft' : 'bad';
          if (v === 'bad') seedBad = true;
          if (v === 'soft') softs++;
          verdicts.set(t, v);
        }
        if (seedBad || softs > 1) {
          cover(i, j, i, i);
          continue;
        }
        let lo = 0;
        let hi = seedLen - 1;
        const budget = (notes: number) => Math.max(1, Math.floor(notes / 8));
        const inRange = (t: number) => i + t >= 0 && j + t >= 0 && i + t < pIv.length && j + t < rIv.length;
        // Extend right (dir 1) then left (dir -1). Near-misses ("soft"): the rhythm off by up to ~75 %,
        // an interval off by a semitone, or one wrong note (two neighbouring intervals off by +e / -e, |e| <= 2).
        // Never two near-misses in a row, at most one per 8 notes.
        for (const dir of [1, -1] as const) {
          let t = dir > 0 ? hi + 1 : lo - 1;
          let lastSoft = verdicts.get(dir > 0 ? hi : lo) === 'soft';
          let edge = dir > 0 ? hi : lo;
          while (inRange(t)) {
            const a = look(i + t, j + t, logS);
            if (a.dp === 0 && a.dr <= RHYTHM_OK) {
              verdicts.set(t, 'ok');
              edge = t;
              lastSoft = false;
              t += dir;
              continue;
            }
            const notes = (dir > 0 ? t - lo : hi - t) + 2;
            if (lastSoft || softs + 1 > budget(notes)) break;
            if (a.dp !== 0 && Math.abs(a.dp) <= 2 && a.dr <= RHYTHM_OK) {
              const t2 = t + dir;
              const b = inRange(t2) ? look(i + t2, j + t2, logS) : null;
              if (b && b.dp === -a.dp && b.dr <= RHYTHM_OK) {
                verdicts.set(t, 'soft');
                verdicts.set(t2, 'soft');
                softs++;
                edge = t2;
                lastSoft = true;
                t = t2 + dir;
                continue;
              }
              if (Math.abs(a.dp) !== 1) break;
            } else if (!(a.dp === 0 && a.dr <= RHYTHM_SOFT)) break;
            verdicts.set(t, 'soft');
            softs++;
            edge = t;
            lastSoft = true;
            t += dir;
          }
          if (dir > 0) hi = edge;
          else lo = edge;
        }
        // Runs end on solid matches.
        while (hi > lo && verdicts.get(hi) === 'soft') hi--;
        while (lo < hi && verdicts.get(lo) === 'soft') lo++;
        cover(i, j, i + lo, i + hi);

        const len = hi - lo + 1;
        if (len + 1 < minNotes) continue;
        const a0 = i + lo;
        if (isGenericRun(pIv.slice(a0, a0 + len), P.key.slice(a0, a0 + len + 1))) continue;
        let pitch = 0;
        let rhythm = 0;
        for (let t = lo; t <= hi; t++) {
          const { dp, dr } = look(i + t, j + t, logS);
          pitch += dp === 0 ? 1 : 0.5;
          rhythm += Math.max(0, 1 - dr / RHYTHM_SOFT);
        }
        runs.push({ i: a0, j: j + lo, len, similarity: round(0.6 * (pitch / len) + 0.4 * (rhythm / len), 2) });
      }
    }

    // Dedupe: per reference, keep the best run for each stretch of the project line.
    runs.sort((x, y) => y.len - x.len || y.similarity - x.similarity || x.i - y.i || x.j - y.j);
    const kept: Run[] = [];
    for (const r of runs) {
      const overlaps = kept.some((k) => {
        const a = Math.max(k.i, r.i);
        const b = Math.min(k.i + k.len, r.i + r.len);
        return b - a >= Math.min(k.len, r.len) / 2;
      });
      if (!overlaps) kept.push(r);
    }
    const bpm = isNum(ref.bpm) && ref.bpm > 0 ? ref.bpm : 120;
    const down = isNum(ref.downbeatSec) ? ref.downbeatSec : 0;
    for (const r of kept) {
      matches.push({
        line: line.label,
        patternId: line.patternId,
        channelId: line.channelId,
        trackId: ref.trackId,
        trackName: ref.trackName,
        stem: ref.stem,
        notes: r.len + 1,
        atBar: Math.floor((P.start[r.i] * PPQ) / barTicks) + 1,
        refAtSec: round(Math.max(0, (ref.analysis ? beatToSec(ref.analysis, R.start[r.j]) : null) ?? down + (R.start[r.j] * 60) / bpm), 2),
        similarity: r.similarity,
      });
    }
  }
  matches.sort((x, y) => y.notes - x.notes || y.similarity - x.similarity || x.atBar - y.atBar || (x.trackId < y.trackId ? -1 : x.trackId > y.trackId ? 1 : 0));
  return matches.slice(0, MAX_MATCHES_PER_LINE);
}

// ── Summary ─────────────────────────────────────────────────────────────

export const ORIGINALITY_DISCLAIMER =
  'This is a production aid, not legal advice: it only compares transcribed melodies (transcription can be wrong), so it can miss similarities and it does not certify that anything is non-infringing.';

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Plain-language summary for a report (always ends with the "production aid, not legal advice" note). */
export function originalitySummary(r: Omit<OriginalityReport, 'summary'>, opts: { minNotes?: number } = {}): string {
  const minNotes = Math.max(NGRAM_NOTES, Math.round(opts.minNotes ?? MIN_MATCH_NOTES));
  const parts: string[] = [];
  if (r.references === 0) {
    parts.push('No deep-analysed reference tracks to compare against yet. Run deep analysis on a collection (stems + transcription) to enable the melody check.');
  } else if (r.checkedLines === 0) {
    parts.push(`No melodic lines to check: the project has no pitched pattern with ${NGRAM_NOTES} or more notes (drum channels are not checked).`);
  } else if (!r.matches.length) {
    parts.push(`Checked ${plural(r.checkedLines, 'melodic line')} against ${plural(r.references, 'reference track')}: no run of ${minNotes}+ notes matches a reference melody (transposition and tempo don't matter to the check).`);
  } else {
    const lines = new Set(r.matches.map((m) => `${m.patternId}/${m.channelId}`));
    const tracks = new Set(r.matches.map((m) => m.trackId));
    parts.push(
      `Checked ${plural(r.checkedLines, 'melodic line')} against ${plural(r.references, 'reference track')}: ${plural(lines.size, 'line')} ${lines.size === 1 ? 'resembles' : 'resemble'} ${plural(tracks.size, 'reference')} (${plural(r.matches.length, 'match', 'matches')}).`,
    );
    const top = r.matches
      .slice()
      .sort((a, b) => b.notes - a.notes || b.similarity - a.similarity)
      .slice(0, 3);
    for (const m of top) {
      parts.push(`- ${m.line}, from bar ${m.atBar}: ${m.notes} notes in a row match "${m.trackName}" (${m.stem}) at ${fmtSec(m.refAtSec)}, ${Math.round(m.similarity * 100)}% pitch + rhythm agreement.`);
    }
    if (r.matches.length > top.length) parts.push(`- … and ${plural(r.matches.length - top.length, 'more match', 'more matches')}.`);
    parts.push('To make a flagged phrase your own, change its rhythm or a few of its intervals and check again.');
  }
  parts.push(ORIGINALITY_DISCLAIMER);
  return parts.join('\n');
}
