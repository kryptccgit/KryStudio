import { z } from 'zod';
import { CommandError, must } from '../commands/types';
import { guessKey, patternChords, type KeyGuess } from '../commands/generate';
import { keyName } from '../music/generate';
import { SCALES } from '../music/theory';
import { defaultNote, patternLength, type Note, type Project } from '../schema/project';
import { PPQ, ticksPerBar, ticksPerBeat } from '../schema/time';
import { cleanScriptOutput } from './output';
import { SCRIPT_KINDS, SCRIPT_LIMITS, type ScriptKind, type ScriptNote, type ScriptParamValues } from './types';

const AUDIO_CLIP = 'krypt.audioclip';

export const SCRIPT_TARGET = z.object({
  patternId: z.string(),
  channelId: z.string(),
  ids: z.array(z.string()).max(20000).optional(),
  range: z.object({ fromBar: z.number().int().min(1).max(4096), bars: z.number().int().min(1).max(256) }).optional(),
  mode: z.enum(['replace', 'merge']).default('replace'),
  key: z.object({ root: z.number().int().min(0).max(11), scale: z.string() }).optional(),
});
export type ScriptTarget = z.input<typeof SCRIPT_TARGET>;

export interface ScriptScope {
  kind: ScriptKind;
  start: number;
  end: number;
  fromBar: number;
  bars: number;
  input: Note[];
  remove: string[];
  key: KeyGuess;
}

export function scriptScope(d: Project, raw: ScriptTarget, kind: ScriptKind): ScriptScope {
  const t = SCRIPT_TARGET.parse(raw);
  const pat = must(d.patterns[t.patternId], `Pattern ${t.patternId} not found`);
  const ch = must(d.channels[t.channelId], `Channel ${t.channelId} not found`);
  if (ch.generator.type === AUDIO_CLIP) throw new CommandError(`"${ch.name}" plays an audio clip; run note scripts on an instrument or drum channel`);
  if (t.key && !SCALES[t.key.scale]) throw new CommandError(`Unknown scale "${t.key.scale}" (use one of: ${Object.keys(SCALES).join(', ')})`);
  const ts = d.transport.timeSig;
  const bar = ticksPerBar(ts);
  const existing = pat.notes[t.channelId] ?? {};
  const sel = (t.ids ?? []).map((id) => must(existing[id], `Note ${id} not found`));
  let start: number;
  let end: number;
  if (t.range) {
    start = (t.range.fromBar - 1) * bar;
    end = start + t.range.bars * bar;
  } else if (sel.length) {
    start = Math.floor(Math.min(...sel.map((n) => n.tick)) / bar) * bar;
    end = Math.max(start + bar, Math.ceil(Math.max(...sel.map((n) => n.tick + n.dur)) / bar) * bar);
  } else {
    start = 0;
    end = Math.max(bar, Math.ceil(patternLength(pat, ts) / bar) * bar);
  }
  const inRange = Object.values(existing).filter((n) => n.tick >= start && n.tick < end);
  const sort = (ns: Note[]): Note[] => [...ns].sort((a, b) => a.tick - b.tick || a.key - b.key || a.id.localeCompare(b.id));
  const where = `bar${end - start === bar ? ` ${start / bar + 1}` : `s ${start / bar + 1}–${end / bar}`}`;
  let input: Note[];
  let remove: string[];
  if (kind === 'transform') {
    input = sort(sel.length ? sel : inRange);
    if (!input.length) throw new CommandError(`"${ch.name}" has no notes in ${where} to transform: write some notes first, or use a generator script`);
    remove = input.map((n) => n.id);
  } else {
    input = sort(inRange);
    remove = t.mode === 'merge' ? [] : sel.length ? sel.map((n) => n.id) : inRange.map((n) => n.id);
  }
  if (input.length > SCRIPT_LIMITS.inputNotes) throw new CommandError(`That is ${input.length} notes; a script can take at most ${SCRIPT_LIMITS.inputNotes}. Select fewer notes or fewer bars.`);
  const key: KeyGuess = t.key ? { key: t.key, source: 'given', name: keyName(t.key) } : guessKey(d, pat.id);
  return { kind, start, end, fromBar: start / bar + 1, bars: (end - start) / bar, input, remove, key };
}

const toScriptNote = (n: Note): ScriptNote => ({
  tick: n.tick,
  dur: n.dur,
  key: n.key,
  vel: n.vel,
  pan: n.pan,
  release: n.release,
  fine: n.fine,
  slide: n.slide,
  mute: !!n.mute,
  color: n.color ?? 0,
});

export interface ScriptContextData {
  kind: ScriptKind;
  name: string;
  notes: ScriptNote[];
  params: ScriptParamValues;
  key: number;
  scale: string;
  scaleSteps: number[];
  keyName: string;
  bpm: number;
  timeSig: { num: number; den: number };
  ppq: number;
  barTicks: number;
  beatTicks: number;
  stepTicks: number;
  start: number;
  end: number;
  lengthTicks: number;
  bars: number;
  chords: Array<{ tick: number; end: number; keys: number[]; root: number; name: string }>;
  rootKey: number;
  seed: number;
}

export function scriptContext(d: Project, t: { patternId: string; channelId: string }, scope: ScriptScope, name: string, params: ScriptParamValues, seed: number): ScriptContextData {
  const ts = d.transport.timeSig;
  const chords = patternChords(d, t.patternId)
    .filter((c) => c.tick < scope.end && c.end > scope.start)
    .map((c) => ({ tick: c.tick, end: c.end, keys: [...c.keys], root: c.root, name: c.name }));
  return {
    kind: scope.kind,
    name,
    notes: scope.input.map(toScriptNote),
    params,
    key: scope.key.key.root,
    scale: scope.key.key.scale,
    scaleSteps: [...(SCALES[scope.key.key.scale] ?? SCALES.minor)],
    keyName: scope.key.name,
    bpm: d.transport.bpm,
    timeSig: { num: ts.num, den: ts.den },
    ppq: PPQ,
    barTicks: ticksPerBar(ts),
    beatTicks: ticksPerBeat(ts),
    stepTicks: PPQ / 4,
    start: scope.start,
    end: scope.end,
    lengthTicks: scope.end - scope.start,
    bars: scope.bars,
    chords,
    rootKey: d.channels[t.channelId]?.rootKey ?? 60,
    seed: seed >>> 0,
  };
}

export const APPLY_SCRIPT_ARGS = SCRIPT_TARGET.extend({
  kind: z.enum(SCRIPT_KINDS as unknown as [ScriptKind, ...ScriptKind[]]),
  name: z.string().min(1).max(SCRIPT_LIMITS.nameChars),
  seed: z.number().int().min(0).max(0xffffffff).default(0),
  notes: z.array(z.unknown()).max(SCRIPT_LIMITS.notes),
});
export type ApplyScriptArgs = z.input<typeof APPLY_SCRIPT_ARGS>;

export interface ScriptApplyPlan {
  notes: Array<Omit<Note, 'id'>>;
  remove: string[];
  range: { fromBar: number; bars: number; start: number; end: number };
  keyName: string;
  dropped: number;
  skipped: number;
  extendTo: number | null;
}

export function planScriptApply(d: Project, raw: ApplyScriptArgs, flags: { allowSame?: boolean } = {}): ScriptApplyPlan {
  const a = APPLY_SCRIPT_ARGS.parse(raw);
  const scope = scriptScope(d, a, a.kind);
  const clean = cleanScriptOutput(a.notes);
  if (!clean.ok) throw new CommandError(`"${a.name}": ${clean.message}`);
  const pat = d.patterns[a.patternId];
  const existing = pat.notes[a.channelId] ?? {};
  const gone = new Set(scope.remove);
  const kept = new Set(Object.values(existing).filter((n) => !gone.has(n.id)).map((n) => `${n.tick}|${n.key}`));
  const seen = new Set<string>();
  const notes: Array<Omit<Note, 'id'>> = [];
  let dropped = 0;
  let skipped = 0;
  for (const n of clean.notes) {
    if (a.kind === 'generator' && (n.tick < scope.start || n.tick >= scope.end)) {
      dropped++;
      continue;
    }
    const sig = `${n.tick}|${n.key}`;
    if (kept.has(sig) || seen.has(sig)) {
      skipped++;
      continue;
    }
    seen.add(sig);
    const dur = a.kind === 'generator' ? Math.max(1, Math.min(n.dur, scope.end - n.tick)) : n.dur;
    const { id: _id, ...base } = defaultNote({
      id: '',
      tick: n.tick,
      key: n.key,
      dur,
      vel: n.vel,
      ...(n.pan !== undefined ? { pan: n.pan } : {}),
      ...(n.release !== undefined ? { release: n.release } : {}),
      ...(n.fine !== undefined ? { fine: n.fine } : {}),
      slide: !!n.slide,
      ...(n.mute ? { mute: true } : {}),
      ...(n.color ? { color: n.color } : {}),
    });
    notes.push(base);
  }
  const where = `bar${scope.bars === 1 ? ` ${scope.fromBar}` : `s ${scope.fromBar}–${scope.fromBar + scope.bars - 1}`}`;
  if (!notes.length && !scope.remove.length) {
    if (skipped) throw new CommandError(`No change: every note "${a.name}" returned is already in ${where}`);
    throw new CommandError(`"${a.name}" returned no notes for ${where}${dropped ? ` (${dropped} started outside those bars)` : ''}: try other params or another seed`);
  }
  if (!flags.allowSame && scope.remove.length === notes.length) {
    const sigOf = (n: Omit<Note, 'id'>): string => `${n.tick}|${n.key}|${n.dur}|${n.vel}|${n.slide ? 1 : 0}|${n.pan}|${n.fine}|${n.release}|${n.mute ? 1 : 0}|${n.color ?? 0}`;
    const was = scope.remove.map((id) => sigOf(existing[id])).sort();
    const now = notes.map(sigOf).sort();
    if (was.every((x, i) => x === now[i])) throw new CommandError(`No change: "${a.name}" (seed ${a.seed}) gives exactly the notes already in ${where}`);
  }
  const bar = ticksPerBar(d.transport.timeSig);
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.tick + n.dur), a.kind === 'generator' ? scope.end : 0);
  const extendTo = pat.length != null && pat.length > 0 && lastEnd > pat.length ? Math.ceil(lastEnd / bar) * bar : null;
  return { notes, remove: scope.remove, range: { fromBar: scope.fromBar, bars: scope.bars, start: scope.start, end: scope.end }, keyName: scope.key.name, dropped, skipped, extendTo };
}
