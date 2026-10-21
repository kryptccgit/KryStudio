// ──────────────────────────────────────────────────────────────────────
// notes.generate: the MIDI generators (shared/music/generate) written into
// one channel of a pattern as ONE undo step. Scale-aware (the given key, else
// the key the pattern's notes are in, else the project's), seeded (same seed
// = same notes; another seed = another take), and range-aware: it replaces
// the selected notes, or the channel's notes in a bar range, or merges.
// planGenerate() is pure, so the piano roll previews and draws the
// Variations thumbnails with exactly what Apply will write.
// ──────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { defineCommand, must, CommandError } from './types';
import { defaultNote, patternLength, type Note, type Project } from '../schema/project';
import { ID_PREFIX } from '../schema/ids';
import { ticksPerBar, ticksPerBeat } from '../schema/time';
import { parseKey, SCALES } from '../music/theory';
import { estimateKey } from '../kpn/symbolic';
import {
  GENERATOR_KINDS,
  GENERATOR_LABELS,
  GenerateError,
  detectChords,
  keyName,
  parseGeneratorOptions,
  runGenerator,
  type ChordEvent,
  type GenKey,
  type GeneratorKind,
} from '../music/generate';

/** Channels whose keys are not pitches (drum synth pads, audio clips). */
const UNPITCHED = new Set(['krypt.drumsynth', 'krypt.audioclip']);

export const GENERATE_ARGS = z.object({
  patternId: z.string(),
  channelId: z.string(),
  /** The selection: replaced in mode "replace", and the default bar range. */
  ids: z.array(z.string()).max(20000).optional(),
  kind: z.enum(GENERATOR_KINDS),
  options: z.record(z.string(), z.unknown()).default({}),
  seed: z.number().int().min(0).max(0xffffffff).default(1),
  /** Key to stay in; omitted = the pattern's key (from its notes), else the project's, else A minor. */
  key: z.object({ root: z.number().int().min(0).max(11), scale: z.string() }).optional(),
  /** Bars to fill (1-based); omitted = the selection's bars, else the whole pattern. */
  range: z.object({ fromBar: z.number().int().min(1).max(4096), bars: z.number().int().min(1).max(256) }).optional(),
  mode: z.enum(['replace', 'merge']).default('replace'),
});

export type GenerateArgs = z.input<typeof GENERATE_ARGS>;
type Args = z.output<typeof GENERATE_ARGS>;

export interface KeyGuess {
  key: GenKey;
  source: 'given' | 'pattern' | 'project' | 'default';
  name: string;
}

function pitchedNotes(p: Project, patternIds: string[]): Note[][] {
  const out: Note[][] = [];
  for (const pid of patternIds) {
    const pat = p.patterns[pid];
    if (!pat) continue;
    for (const [chId, byId] of Object.entries(pat.notes)) {
      const ch = p.channels[chId];
      if (!ch || UNPITCHED.has(ch.generator.type)) continue;
      const notes = Object.values(byId).filter((n) => !n.mute);
      // one-shot drum samples sit on one key: no harmony in them
      if (ch.generator.type === 'krypt.sampler' && new Set(notes.map((n) => n.key)).size < 3) continue;
      if (notes.length) out.push(notes);
    }
  }
  return out;
}

function keyFrom(channels: Note[][], minNotes: number): GenKey | null {
  const w = new Array(12).fill(0);
  let count = 0;
  for (const notes of channels) for (const n of notes) {
    w[((n.key % 12) + 12) % 12] += Math.max(1, n.dur);
    count++;
  }
  if (count < minNotes) return null;
  const est = estimateKey(w);
  const k = est ? parseKey(est.key) : null;
  return k ? { root: k.root, scale: k.scale } : null;
}

/** The key a generator stays in when none is given: the pattern's notes, else the project's, else A minor. */
export function guessKey(p: Project, patternId?: string | null): KeyGuess {
  const fromPat = patternId ? keyFrom(pitchedNotes(p, [patternId]), 6) : null;
  if (fromPat) return { key: fromPat, source: 'pattern', name: keyName(fromPat) };
  const fromProject = keyFrom(pitchedNotes(p, p.patternOrder), 8);
  if (fromProject) return { key: fromProject, source: 'project', name: keyName(fromProject) };
  const def = { root: 9, scale: 'minor' };
  return { key: def, source: 'default', name: keyName(def) };
}

/** The chords already written in a pattern (every pitched channel). */
export function patternChords(p: Project, patternId: string): ChordEvent[] {
  return detectChords(pitchedNotes(p, [patternId]));
}

export interface GeneratePlan {
  kind: GeneratorKind;
  seed: number;
  /** New notes (pattern ticks), without ids. */
  notes: Array<Omit<Note, 'id'>>;
  /** Existing note ids the generated notes replace. */
  remove: string[];
  key: GenKey;
  keySource: KeyGuess['source'];
  keyName: string;
  range: { fromBar: number; bars: number; start: number; end: number };
  chords?: string[];
  chordSource?: 'pattern' | 'progression' | 'none';
  detail: string;
  /** Generated notes left out because an identical note (same start and key) stays. */
  skipped: number;
  /** New pattern length when the range runs past a fixed-length pattern. */
  extendTo: number | null;
}

const EMPTY_HINT: Record<GeneratorKind, string> = {
  rhythm: 'raise the pulses or the density',
  chords: 'try a longer bar range',
  arp: 'try a faster rate or a longer bar range',
  melody: 'raise the density or try a longer bar range',
  bass: 'try another rhythm or a longer bar range',
};

/** Everything notes.generate would do, without touching the project. Throws CommandError. */
export function planGenerate(d: Project, a: Args, flags: { allowSame?: boolean } = {}): GeneratePlan {
  const pat = must(d.patterns[a.patternId], `Pattern ${a.patternId} not found`);
  const ch = must(d.channels[a.channelId], `Channel ${a.channelId} not found`);
  if (ch.generator.type === 'krypt.audioclip') throw new CommandError(`"${ch.name}" plays an audio clip; generate notes on an instrument or drum channel`);
  const opts = parseGeneratorOptions(a.kind, a.options);
  if (!opts.ok) throw new CommandError(opts.message);
  if (a.key && !SCALES[a.key.scale]) throw new CommandError(`Unknown scale "${a.key.scale}" (use one of: ${Object.keys(SCALES).join(', ')})`);

  const ts = d.transport.timeSig;
  const bar = ticksPerBar(ts);
  const existing = pat.notes[a.channelId] ?? {};
  const sel = (a.ids ?? []).map((id) => must(existing[id], `Note ${id} not found`));
  let start: number;
  let end: number;
  if (a.range) {
    start = (a.range.fromBar - 1) * bar;
    end = start + a.range.bars * bar;
  } else if (sel.length) {
    start = Math.floor(Math.min(...sel.map((n) => n.tick)) / bar) * bar;
    end = Math.max(start + bar, Math.ceil(Math.max(...sel.map((n) => n.tick + n.dur)) / bar) * bar);
  } else {
    start = 0;
    end = Math.max(bar, Math.ceil(patternLength(pat, ts) / bar) * bar);
  }

  const guess: KeyGuess = a.key ? { key: a.key, source: 'given', name: keyName(a.key) } : guessKey(d, pat.id);
  let out;
  try {
    out = runGenerator(a.kind, opts.options, {
      key: guess.key,
      start,
      end,
      barTicks: bar,
      beatTicks: ticksPerBeat(ts),
      seed: a.seed,
      patternChords: patternChords(d, pat.id),
      defaultNote: ch.rootKey ?? 60,
    });
  } catch (err) {
    if (err instanceof GenerateError) throw new CommandError(err.message);
    throw err;
  }

  const remove = a.mode === 'merge' ? [] : sel.length ? sel.map((n) => n.id) : Object.values(existing).filter((n) => n.tick >= start && n.tick < end).map((n) => n.id);
  const gone = new Set(remove);
  const kept = new Set(Object.values(existing).filter((n) => !gone.has(n.id)).map((n) => `${n.tick}|${n.key}`));
  const seen = new Set<string>();
  const notes: Array<Omit<Note, 'id'>> = [];
  let skipped = 0;
  for (const n of out.notes) {
    const tick = Math.round(n.tick);
    const key = Math.round(n.key);
    if (tick < start || tick >= end || key < 0 || key > 127) continue;
    const sig = `${tick}|${key}`;
    if (kept.has(sig) || seen.has(sig)) {
      skipped++;
      continue;
    }
    seen.add(sig);
    const { id: _id, ...base } = defaultNote({ id: '', tick, key, dur: Math.max(1, Math.min(Math.round(n.dur), end - tick)), vel: n.vel, ...(n.slide ? { slide: true } : {}) });
    notes.push(base);
  }
  const label = GENERATOR_LABELS[a.kind].toLowerCase();
  const fromBar = start / bar + 1;
  const bars = (end - start) / bar;
  if (!notes.length) {
    if (skipped) throw new CommandError(`No change: every generated note is already in bars ${fromBar}–${fromBar + bars - 1}; try another seed or replace mode`);
    throw new CommandError(`The ${label} generator wrote no notes in bars ${fromBar}–${fromBar + bars - 1}: ${EMPTY_HINT[a.kind]}`);
  }
  if (!flags.allowSame && remove.length === notes.length) {
    const sigOf = (n: Omit<Note, 'id'>): string => `${n.tick}|${n.key}|${n.dur}|${n.vel}|${n.slide ? 1 : 0}`;
    const was = remove.map((id) => sigOf(existing[id])).sort();
    const now = notes.map(sigOf).sort();
    if (was.every((x, i) => x === now[i])) throw new CommandError(`No change: this take (seed ${a.seed}) is already there; use another seed for a new take`);
  }
  return {
    kind: a.kind,
    seed: a.seed,
    notes,
    remove,
    key: guess.key,
    keySource: guess.source,
    keyName: guess.name,
    range: { fromBar, bars, start, end },
    chords: out.chords,
    chordSource: out.chordSource,
    detail: out.detail,
    skipped,
    extendTo: pat.length != null && pat.length > 0 && end > pat.length ? end : null,
  };
}

export const notesGenerate = defineCommand({
  id: 'notes.generate',
  label: (a) => `Generate ${GENERATOR_LABELS[a.kind as GeneratorKind]?.toLowerCase() ?? 'notes'}`,
  description:
    'Generate notes into one channel of a pattern (ONE undo step). kind: rhythm (Euclidean or density, accents, ghosts, 32nd rolls) | chords (progression by degree: preset or numerals like "i VI III VII", voicing close/open/spread, voice-led inversions, rhythm) | arp (over the chords in the pattern or a progression: up/down/upDown/downUp/converge/random) | melody (in the key: contour, range, density, feel, phrases with call and response, chord tones on strong beats) | bass (follows the chords: root/rootFifth/octave/walking/glide808 with slides, genre rhythms). key {root 0..11, scale} defaults to the key the pattern is in. range {fromBar (1-based), bars} defaults to the selection\'s bars (ids), else the whole pattern. mode replace removes the selection (ids) or the channel\'s notes in the range; merge keeps them. Same seed = same notes; another seed = another take.',
  args: GENERATE_ARGS,
  run(d, a, ctx) {
    const plan = planGenerate(d, a);
    const pat = d.patterns[a.patternId];
    const notes = (pat.notes[a.channelId] ??= {});
    for (const id of plan.remove) delete notes[id];
    const ids: string[] = [];
    for (const n of plan.notes) {
      const id = ctx.newId(ID_PREFIX.note);
      notes[id] = { ...n, id };
      ids.push(id);
    }
    if (plan.extendTo) pat.length = plan.extendTo;
    return {
      ids,
      count: ids.length,
      removed: plan.remove.length,
      skipped: plan.skipped,
      kind: plan.kind,
      seed: plan.seed,
      key: plan.keyName,
      keySource: plan.keySource,
      range: { fromBar: plan.range.fromBar, bars: plan.range.bars },
      chords: plan.chords,
      chordSource: plan.chordSource,
      detail: plan.detail,
      extendedTo: plan.extendTo,
    };
  },
});

export const GENERATE_COMMANDS = [notesGenerate];
