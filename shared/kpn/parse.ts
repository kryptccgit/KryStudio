// KPN parser (research/04 §10.2, v0.1). Pure TS, no I/O. Never throws:
// every problem becomes a KpnIssue with the line, track and bar it belongs to,
// phrased so a model can fix it on the next call.
//
//   pattern "Trap A" bars=2 grid=16 key=F#m
//   kick       : x... .... ..x. .... | x... .... .x.. ..x.
//   hat/32     : (x.x.)*7 xxxx | (x.x.)*6 xxxx xxxx
//   808 {oct=1}: F#1:6 r:4 C#2:2 E2:4 | F#1:8~ C#1:4 r:2 A1:2
//   chords {oct=3 vel=80}: Am7:16 | Fmaj7:16 | C:16 | G/B:16
//   lead {oct=5}: ^5:4 ^3:2 ^1 ^2:4 ^3:4 | ^1:8 r:8

import { CHORD_QUALITIES, degreeToMidi, noteName, parseKey, parseNoteName, parsePitchClass, type Key } from '../music/theory';
import { ticksPerBar, ticksPerBeat, type TimeSig } from '../schema/time';
import type { KpnHeader, KpnIssue, KpnNote, KpnParseOptions, KpnParseResult, KpnTrack } from './types';

export const KPN_VERSION = '0.1';
export const DEFAULT_DRUM_KEY = 60;
export const DEFAULT_OCTAVE = 4;
export const DEFAULT_VELOCITY = 100;
/** Grid hit velocities (MIDI): x = line vel (100), X = accent, o = ghost, 1-9 = n × 14. */
export const GRID_ACCENT = 127;
export const GRID_GHOST = 50;
export const GRID_DIGIT_STEP = 14;
/** Melodic token velocity marks. */
export const TOKEN_ACCENT = 120;
export const TOKEN_GHOST = 60;
const MAX_EXPANDED = 200_000;
const MAX_REPEAT = 512;

const DEFAULT_TS: TimeSig = { num: 4, den: 4 };

/** Default grid: 16th-note steps per bar for a time signature (16 in 4/4, 12 in 3/4). */
export function defaultGrid(ts: TimeSig): number {
  const g = (ts.num * 16) / ts.den;
  return Number.isInteger(g) && g >= 1 ? g : ts.num * 4;
}

/** Default sticky note length in steps: one beat at the given grid. */
export function defaultLenSteps(grid: number, ts: TimeSig): number {
  return Math.max(1, Math.round((grid * ticksPerBeat(ts)) / ticksPerBar(ts)));
}

/** Chord quality spellings accepted on top of shared/music/theory CHORD_QUALITIES. */
export const CHORD_ALIASES: Record<string, string> = {
  dom7: '7',
  dom9: '9',
  dom11: '11',
  dom13: '13',
  M: '',
  maj: 'maj',
  M7: 'maj7',
  M9: 'maj9',
  ma7: 'maj7',
  min: 'm',
  min7: 'm7',
  min9: 'm9',
  mi: 'm',
  mi7: 'm7',
  '-': 'm',
  '-7': 'm7',
  '+': 'aug',
  o: 'dim',
  o7: 'dim7',
  'ø': 'm7b5',
  'ø7': 'm7b5',
  sus: 'sus4',
  add2: 'add9',
  madd2: 'madd9',
  pow: '5',
};

export function chordIntervals(quality: string): number[] | null {
  if (Object.prototype.hasOwnProperty.call(CHORD_QUALITIES, quality)) return CHORD_QUALITIES[quality];
  const alias = CHORD_ALIASES[quality];
  if (alias !== undefined && Object.prototype.hasOwnProperty.call(CHORD_QUALITIES, alias)) return CHORD_QUALITIES[alias];
  return null;
}

/** Chord symbol ("Am7", "Fmaj7", "G/B", "C#m9/G#") → MIDI notes, bass first. */
export function chordSymbolToMidi(symbol: string, octave: number): { notes: number[] } | { error: string } {
  const m = /^([A-G](?:#|b)?)([^/]*)(?:\/([A-G](?:#|b)?))?$/.exec(symbol);
  if (!m) return { error: `"${symbol}" is not a note, chord symbol, degree or rest` };
  const root = parsePitchClass(m[1]);
  const intervals = chordIntervals(m[2]);
  if (root === null) return { error: `bad chord root in "${symbol}"` };
  if (!intervals) {
    const known = ['', 'm', 'maj7', 'm7', 'dom7', 'dim', 'aug', 'sus2', 'sus4', 'add9', 'm9', 'maj9', 'm7b5', 'dim7'].map((q) => `${m[1]}${q}`);
    return { error: `unknown chord quality "${m[2]}" in "${symbol}" (try ${known.slice(0, 8).join(', ')}; a letter + digit like G7 is always a NOTE, write Gdom7 for the chord)` };
  }
  const base = (octave + 1) * 12 + root;
  let notes = intervals.map((i) => base + i);
  if (m[3]) {
    const bass = parsePitchClass(m[3]);
    if (bass === null) return { error: `bad bass note in "${symbol}"` };
    let b = (octave + 1) * 12 + bass;
    while (b >= notes[0]) b -= 12;
    notes = [b, ...notes];
  }
  if (notes.some((n) => n < 0 || n > 127)) return { error: `"${symbol}" at octave ${octave} is outside the MIDI range` };
  return { notes };
}

const NOTE_RE = /^[A-Ga-g](?:##|bb|#|b)?-?\d+$/;
const DEGREE_RE = /^\^([b#]{0,2})(\d{1,2})(['’,]*)$/;

interface Ctx {
  errors: KpnIssue[];
  warnings: KpnIssue[];
  barTicks: number;
}

function fmt(line: number, track: string | undefined, bar: number | undefined, msg: string): string {
  const where = line > 0 ? `line ${line}` : 'kpn';
  return `${where}${track ? ` (${track})` : ''}${bar ? `, bar ${bar}` : ''}: ${msg}`;
}

function issue(list: KpnIssue[], line: number, track: string | undefined, bar: number | undefined, msg: string): void {
  list.push({ line, track, bar, message: fmt(line, track, bar, msg) });
}

/** Strip a `//` comment that is not inside a quoted name. */
function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inQuote = !inQuote;
    else if (!inQuote && c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Parse `k=v k2="v 2"` (space or comma separated). */
function parseKv(s: string): { kv: Record<string, string>; bad: string[] } {
  const kv: Record<string, string> = {};
  const bad: string[] = [];
  const re = /\s*([A-Za-z_][\w-]*)\s*=\s*("([^"]*)"|[^\s,]+)\s*,?/y;
  let i = 0;
  const str = s.trim();
  while (i < str.length) {
    re.lastIndex = i;
    const m = re.exec(str);
    if (!m) {
      const rest = str.slice(i).trim().split(/[\s,]+/)[0];
      if (rest) bad.push(rest);
      const next = str.indexOf(' ', i + 1);
      if (next < 0) break;
      i = next;
      continue;
    }
    kv[m[1]] = m[3] !== undefined ? m[3] : m[2];
    i = re.lastIndex;
  }
  return { kv, bad };
}

/** Expand `( ... )*n` groups, innermost first. */
function expandRepeats(body: string): { text: string; error?: string } {
  let s = body;
  let guard = 0;
  for (;;) {
    const next = s.replace(/\(([^()]*)\)\s*\*\s*(\d+)/g, (_m, inner: string, n: string) => {
      const count = Number(n);
      if (count < 1 || count > MAX_REPEAT) return `\u0000BADREPEAT${n}\u0000`;
      return ` ${Array(count).fill(inner).join(' ')} `;
    });
    if (next.includes('\u0000BADREPEAT')) {
      const n = /BADREPEAT(\d+)/.exec(next)?.[1];
      return { text: s, error: `repeat count *${n} must be 1..${MAX_REPEAT}` };
    }
    if (next.length > MAX_EXPANDED) return { text: s, error: `repeats expand to more than ${MAX_EXPANDED} characters` };
    if (next === s) break;
    s = next;
    if (++guard > 64) return { text: s, error: 'repeats are nested too deeply' };
  }
  if (/[()]/.test(s)) {
    if (/\([^()]*\)(?!\s*\*)/.test(s)) return { text: s, error: 'a ( ... ) group needs a repeat count, e.g. (x.x.)*4' };
    return { text: s, error: 'unbalanced ( or ) in repeat group' };
  }
  return { text: s };
}

interface TrackState {
  track: KpnTrack;
  /** Melodic: sticky length in ticks. */
  stickyTicks: number | null;
  /** Melodic: suffix `~` seen; the next note token slides. */
  pendingSlide: boolean;
  /** Grid: last note eligible for `-` holds. */
  holdNote: KpnNote | null;
  /** Position of the last bar line (or line start / jump). */
  lastBar: number;
  /** Last grid used (for total-length messages). */
  lastGrid: number;
  lastLine: number;
  pastEndReported: boolean;
}

function stepsLabel(ticks: number, stepTicks: number): string {
  const n = ticks / stepTicks;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function barOf(tick: number, barTicks: number): number {
  return Math.floor(tick / barTicks) + 1;
}

function posLabel(tick: number, barTicks: number, stepTicks: number): string {
  const bar = barOf(tick, barTicks);
  const step = (tick - (bar - 1) * barTicks) / stepTicks + 1;
  return `${bar}.${Number.isInteger(step) ? step : step.toFixed(2)}`;
}

/** Validate a `|` bar check. Returns the (re-synced) cursor. */
function barCheck(st: TrackState, pos: number, line: number, ctx: Ctx, stepTicks: number, grid: number): number {
  const { barTicks } = ctx;
  const name = st.track.name;
  if (pos % barTicks === 0) {
    st.lastBar = pos;
    return pos;
  }
  const since = pos - st.lastBar;
  const bar = barOf(st.lastBar, barTicks);
  if (since > 0 && since < 2 * barTicks && st.lastBar % barTicks === 0) {
    const n = stepsLabel(since, stepTicks);
    const diff = Math.abs(since - barTicks) / stepTicks;
    const what = since < barTicks ? `${Number.isInteger(diff) ? diff : diff.toFixed(2)} short` : `${Number.isInteger(diff) ? diff : diff.toFixed(2)} too many`;
    issue(ctx.errors, line, name, bar, `has ${n}/${grid} steps at the bar line (${what})`);
  } else {
    issue(ctx.errors, line, name, barOf(pos, barTicks), `bar line at step ${stepsLabel(pos, stepTicks)} is not on a bar boundary (${grid} steps per bar)`);
  }
  // Re-sync to the nearest bar boundary so later bars are checked on their own.
  const nb = Math.max(1, Math.round(since / barTicks));
  const resync = st.lastBar + nb * barTicks;
  st.lastBar = resync;
  return resync;
}

function parseGridBody(body: string, st: TrackState, line: number, ctx: Ctx, stepTicks: number, grid: number, vel: number, key: number): void {
  const { barTicks } = ctx;
  const t = st.track;
  let pos = t.end;
  for (const ch of body) {
    if (ch === ' ' || ch === '\t') continue;
    if (ch === '|') {
      pos = barCheck(st, pos, line, ctx, stepTicks, grid);
      continue;
    }
    if (ch === '-') {
      const h = st.holdNote;
      if (h && h.tick + h.dur === pos) h.dur += stepTicks;
      else issue(ctx.errors, line, t.name, barOf(pos, barTicks), `'-' (hold) at step ${posLabel(pos, barTicks, stepTicks)} has no hit before it to extend`);
      pos += stepTicks;
      continue;
    }
    if (ch === '.') {
      st.holdNote = null;
      pos += stepTicks;
      continue;
    }
    if (ch === '_') {
      t.clears.push({ tick: pos, dur: stepTicks });
      st.holdNote = null;
      pos += stepTicks;
      continue;
    }
    let v: number | null = null;
    if (ch === 'x') v = vel;
    else if (ch === 'X') v = GRID_ACCENT;
    else if (ch === 'o') v = GRID_GHOST;
    else if (ch >= '1' && ch <= '9') v = Number(ch) * GRID_DIGIT_STEP;
    if (v === null) {
      issue(ctx.errors, line, t.name, barOf(pos, barTicks), `unexpected '${ch}' in a step grid (use x X o 1-9 for hits, . rest, - hold, _ clear, | bar line)`);
      pos += stepTicks;
      continue;
    }
    const n: KpnNote = { tick: pos, dur: stepTicks, key, vel: v / 127, slide: false };
    t.notes.push(n);
    st.holdNote = n;
    pos += stepTicks;
  }
  t.end = pos;
}

interface PitchSpec {
  keys: number[];
  /** Per-key velocity overrides (MIDI) for chord elements. */
  vels: Array<number | null>;
}

function parseVelMark(s: string): { vel: number | null; rest: string } {
  const m = /^v(\d{1,3})/.exec(s);
  if (m) return { vel: Number(m[1]), rest: s.slice(m[0].length) };
  if (s.startsWith('!')) return { vel: TOKEN_ACCENT, rest: s.slice(1) };
  if (s.startsWith('?')) return { vel: TOKEN_GHOST, rest: s.slice(1) };
  return { vel: null, rest: s };
}

function parseDegree(head: string, key: Key | null, oct: number): { key: number } | { error: string } {
  const m = DEGREE_RE.exec(head);
  if (!m) return { error: `bad scale degree "${head}" (write ^1..^7, ^b3, ^#4, ^5' up an octave, ^1, down an octave)` };
  if (!key) return { error: `scale degree ${head} needs key= in the pattern header (e.g. key=Am)` };
  const degree = Number(m[2]);
  if (degree < 1 || degree > 21) return { error: `scale degree ${head} must be 1..21` };
  let acc = 0;
  for (const c of m[1]) acc += c === '#' ? 1 : -1;
  let midi = degreeToMidi(degree, key, oct, acc);
  for (const c of m[3]) midi += c === ',' ? -12 : 12;
  if (midi < 0 || midi > 127) return { error: `${head} at octave ${oct} is outside the MIDI range` };
  return { key: midi };
}

function parseSinglePitch(el: string, key: Key | null, oct: number): { key: number } | { error: string } {
  if (NOTE_RE.test(el)) {
    const k = parseNoteName(el);
    if (k === null) return { error: `note ${el} is outside the MIDI range (C-1..G9)` };
    return { key: k };
  }
  if (el.startsWith('^')) return parseDegree(el, key, oct);
  return { error: `"${el}" is not a note (C4, F#2, Bb3) or scale degree (^1..^7)` };
}

function parseHead(head: string, key: Key | null, oct: number): PitchSpec | { error: string } {
  if (head.startsWith('[')) {
    if (!head.endsWith(']')) return { error: `chord "${head}" is missing its closing ]` };
    const inner = head.slice(1, -1).trim();
    if (!inner) return { error: 'empty chord []' };
    const keys: number[] = [];
    const vels: Array<number | null> = [];
    for (const raw of inner.split(/[\s,]+/)) {
      if (!raw) continue;
      const cut = raw.search(/v\d|[!?]/);
      const pitchPart = cut > 0 ? raw.slice(0, cut) : raw;
      const velPart = cut > 0 ? raw.slice(cut) : '';
      const p = parseSinglePitch(pitchPart, key, oct);
      if ('error' in p) return { error: `in chord ${head}: ${p.error}` };
      let v: number | null = null;
      if (velPart) {
        const pv = parseVelMark(velPart);
        if (pv.vel === null || pv.rest) return { error: `in chord ${head}: can't read "${velPart}" after ${pitchPart}` };
        v = pv.vel;
      }
      keys.push(p.key);
      vels.push(v);
    }
    return { keys, vels };
  }
  if (head.startsWith('^') || NOTE_RE.test(head)) {
    const p = parseSinglePitch(head, key, oct);
    if ('error' in p) return p;
    return { keys: [p.key], vels: [null] };
  }
  if (/^[A-G]/.test(head)) {
    const c = chordSymbolToMidi(head, oct);
    if ('error' in c) return c;
    return { keys: c.notes, vels: c.notes.map(() => null) };
  }
  if (/^[a-g](?:#|b)?$/.test(head)) return { error: `"${head}": note names need an octave (${head.toUpperCase()}4); chord symbols start with a capital letter` };
  return { error: `"${head}" is not a note, chord, scale degree or rest` };
}

function parseMelodicBody(body: string, st: TrackState, line: number, ctx: Ctx, stepTicks: number, grid: number, total: number | null, key: Key | null, ts: TimeSig, opts: { oct: number; vel: number }, maxNotes: number, noteCount: { n: number }): void {
  const { barTicks } = ctx;
  const t = st.track;
  const spaced = body.replace(/\|/g, ' | ');
  const tokens = spaced.match(/~?\[[^\]]*\]\S*|\S+/g) ?? [];
  let pos = t.end;
  if (st.stickyTicks === null) st.stickyTicks = defaultLenSteps(grid, ts) * stepTicks;
  for (const tok of tokens) {
    const bar = barOf(pos, barTicks);
    if (tok === '|') {
      pos = barCheck(st, pos, line, ctx, stepTicks, grid);
      continue;
    }
    if (tok.startsWith('@')) {
      const m = /^@(\d+)(?:\.(\d+))?$/.exec(tok);
      if (!m) {
        issue(ctx.errors, line, t.name, bar, `bad position "${tok}" (write @bar.step, 1-based, e.g. @3.1)`);
        continue;
      }
      const b = Number(m[1]);
      const s = m[2] ? Number(m[2]) : 1;
      if (b < 1 || s < 1 || s > grid) {
        issue(ctx.errors, line, t.name, bar, `position ${tok} is out of range (bar >= 1, step 1..${grid})`);
        continue;
      }
      pos = (b - 1) * barTicks + (s - 1) * stepTicks;
      st.lastBar = (b - 1) * barTicks;
      continue;
    }
    let rest = tok;
    let slideIn = false;
    if (rest.startsWith('~') && rest.length > 1) {
      slideIn = true;
      rest = rest.slice(1);
    }
    // Split head / suffixes.
    let head: string;
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      head = close >= 0 ? rest.slice(0, close + 1) : rest;
      rest = close >= 0 ? rest.slice(close + 1) : '';
    } else {
      const cut = rest.search(/[:!?~]|v\d/);
      head = cut >= 0 ? rest.slice(0, cut) : rest;
      rest = cut >= 0 ? rest.slice(cut) : '';
    }
    let lenTicks: number | null = null;
    let vel: number | null = null;
    let slideOut = false;
    let bad = '';
    while (rest.length) {
      const lm = /^:(\d+(?:\.\d+)?)/.exec(rest);
      if (lm) {
        const steps = Number(lm[1]);
        if (!Number.isInteger(steps) || steps < 1) {
          bad = `length :${lm[1]} must be a whole number of steps >= 1 (use a finer grid such as ${t.name}/${grid * 2} for shorter notes)`;
          break;
        }
        lenTicks = steps * stepTicks;
        rest = rest.slice(lm[0].length);
        continue;
      }
      const pv = parseVelMark(rest);
      if (pv.vel !== null) {
        if (pv.vel < 1 || pv.vel > 127) {
          bad = `velocity v${pv.vel} must be 1..127`;
          break;
        }
        vel = pv.vel;
        rest = pv.rest;
        continue;
      }
      if (rest.startsWith('~')) {
        slideOut = true;
        rest = rest.slice(1);
        continue;
      }
      bad = `can't read "${rest}" in "${tok}" (suffixes: :len v1-127 ! ? ~)`;
      break;
    }
    if (bad) {
      issue(ctx.errors, line, t.name, bar, bad);
      continue;
    }
    if (lenTicks !== null) st.stickyTicks = lenTicks;
    const dur = st.stickyTicks!;
    if (head === 'r' || head === 'R') {
      if (vel !== null || slideOut || slideIn) issue(ctx.warnings, line, t.name, bar, `rest "${tok}" ignores velocity/slide marks`);
      pos += dur;
      continue;
    }
    if (head === '') {
      issue(ctx.errors, line, t.name, bar, `"${tok}" has no note before its suffix`);
      continue;
    }
    const p = parseHead(head, key, opts.oct);
    if ('error' in p) {
      issue(ctx.errors, line, t.name, bar, p.error);
      pos += dur;
      continue;
    }
    if (p.keys.length === 1 && p.keys[0] >= 96 && !head.startsWith('^') && !head.startsWith('[') && /^[A-G](?:#|b)?(7|9)$/.test(head)) {
      issue(ctx.warnings, line, t.name, bar, `${head} is the NOTE ${noteName(p.keys[0])} (MIDI ${p.keys[0]}); for a dominant chord write ${head.replace(/\d$/, '')}dom${head.slice(-1)}`);
    }
    const lineVel = vel ?? opts.vel;
    const slide = slideIn || st.pendingSlide;
    st.pendingSlide = slideOut;
    if (total !== null && pos + dur > total && !st.pastEndReported && !ctx.errors.some((e) => e.track === t.name)) {
      issue(ctx.errors, line, t.name, bar, `${tok} at ${posLabel(pos, barTicks, stepTicks)} ends at step ${stepsLabel(pos + dur, stepTicks)}, past the pattern end (${stepsLabel(total, stepTicks)} steps)`);
      st.pastEndReported = true;
    }
    for (let i = 0; i < p.keys.length; i++) {
      if (noteCount.n >= maxNotes) {
        if (noteCount.n === maxNotes) issue(ctx.errors, line, t.name, bar, `too many notes (max ${maxNotes} per call)`);
        noteCount.n++;
        break;
      }
      t.notes.push({ tick: pos, dur, key: p.keys[i], vel: (p.vels[i] ?? lineVel) / 127, slide });
      noteCount.n++;
    }
    pos += dur;
  }
  t.end = pos;
}

function parseHeaderLine(rest: string, line: number, header: KpnHeader, ctx: Ctx): void {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)")?(.*)$/.exec(rest);
  if (m?.[1] !== undefined) header.name = m[1].replace(/\\"/g, '"');
  const { kv, bad } = parseKv(m?.[2] ?? '');
  for (const b of bad) issue(ctx.errors, line, undefined, undefined, `can't read "${b}" in the pattern header (write key=value, e.g. bars=2 grid=16 key=Am)`);
  for (const [k, v] of Object.entries(kv)) {
    switch (k) {
      case 'bars': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 1024) issue(ctx.errors, line, undefined, undefined, `bars=${v} must be a whole number 1..1024`);
        else header.bars = n;
        break;
      }
      case 'grid': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 3840) issue(ctx.errors, line, undefined, undefined, `grid=${v} must be a whole number of steps per bar (16 = 16ths, 32, 12/24 for triplets)`);
        else header.grid = n;
        break;
      }
      case 'ts': {
        const tm = /^(\d{1,2})\/(2|4|8|16)$/.exec(v);
        if (!tm || Number(tm[1]) < 1) issue(ctx.errors, line, undefined, undefined, `ts=${v} must look like 4/4, 3/4 or 6/8`);
        else {
          header.ts = { num: Number(tm[1]), den: Number(tm[2]) };
          header.tsExplicit = true;
        }
        break;
      }
      case 'key': {
        if (!parseKey(v)) issue(ctx.errors, line, undefined, undefined, `key=${v} isn't a key I know (e.g. key=Am, key=F#m, key=C, key="D dorian")`);
        else header.key = v;
        break;
      }
      case 'swing': {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) issue(ctx.errors, line, undefined, undefined, `swing=${v} must be 0..100`);
        else header.swing = n;
        break;
      }
      default:
        header.extra[k] = v;
        issue(ctx.warnings, line, undefined, undefined, `unknown header option ${k}= (ignored)`);
    }
  }
}

const TRACK_RE = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"{}:/]+))\s*(?:\/\s*(\d+))?\s*(?:\{([^}]*)\})?\s*:(.*)$/;

/** Parse KPN text. Never throws. */
export function parse(text: string, options: KpnParseOptions = {}): KpnParseResult {
  const errors: KpnIssue[] = [];
  const warnings: KpnIssue[] = [];
  const baseTs = options.ts ?? DEFAULT_TS;
  const header: KpnHeader = { name: null, bars: null, grid: defaultGrid(baseTs), ts: baseTs, tsExplicit: false, key: null, swing: null, line: 0, extra: {} };
  const maxNotes = options.maxNotes ?? 20000;
  const lines = String(text ?? '').split(/\r?\n/);

  // Pass 1: find the header (first non-empty line) so ts/grid/bars apply to every track.
  let firstContent = -1;
  for (let i = 0; i < lines.length; i++) {
    if (stripComment(lines[i]).trim()) {
      firstContent = i;
      break;
    }
  }
  const ctx: Ctx = { errors, warnings, barTicks: 0 };
  let headerGridExplicit = false;
  if (firstContent >= 0) {
    const l = stripComment(lines[firstContent]).trim();
    const hm = /^pattern\b(?!\s*[/{:])(.*)$/i.exec(l);
    if (hm) {
      header.line = firstContent + 1;
      parseHeaderLine(hm[1], header.line, header, ctx);
      headerGridExplicit = /\bgrid\s*=/.test(hm[1]);
      if (header.tsExplicit && !headerGridExplicit) header.grid = defaultGrid(header.ts);
    }
  }
  if (options.requireHeader && header.line === 0) {
    issue(errors, firstContent + 1, undefined, undefined, 'KPN must start with a header like: pattern "Name" bars=2 grid=16');
  }
  const barTicks = ticksPerBar(header.ts);
  ctx.barTicks = barTicks;
  if (barTicks % header.grid !== 0) {
    issue(errors, header.line, undefined, undefined, `grid=${header.grid} doesn't divide a ${header.ts.num}/${header.ts.den} bar into whole ticks (try ${defaultGrid(header.ts)}, ${defaultGrid(header.ts) * 2} or 12/24 for triplets)`);
    header.grid = defaultGrid(header.ts);
  }
  const stepTicks = barTicks / header.grid;
  const total = header.bars !== null ? header.bars * barTicks : null;
  const key = header.key ? parseKey(header.key) : null;

  const states = new Map<string, TrackState>();
  const order: TrackState[] = [];
  const noteCount = { n: 0 };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = stripComment(lines[i]);
    if (!raw.trim()) continue;
    if (lineNo === header.line) continue;
    if (/^\s*pattern\b/i.test(raw) && !/^\s*pattern\s*[/{:]/i.test(raw)) {
      issue(errors, lineNo, undefined, undefined, header.line ? `only one pattern header is allowed (the first is on line ${header.line}); write one pattern per call` : 'the pattern header must be the first line');
      continue;
    }
    const tm = TRACK_RE.exec(raw);
    if (!tm) {
      issue(errors, lineNo, undefined, undefined, `expected "<channel>: <notes>" (missing ':'?) — got "${raw.trim().slice(0, 40)}"`);
      continue;
    }
    const name = (tm[1] !== undefined ? tm[1].replace(/\\"/g, '"') : tm[2]).trim();
    if (!name) {
      issue(errors, lineNo, undefined, undefined, 'empty channel name');
      continue;
    }
    let grid = header.grid;
    if (tm[3]) {
      const g = Number(tm[3]);
      if (!Number.isInteger(g) || g < 1 || barTicks % g !== 0) {
        issue(errors, lineNo, name, undefined, `/${tm[3]} doesn't divide the bar into whole ticks (use /16, /32, /12, /24, /48, /64)`);
        continue;
      }
      grid = g;
    }
    const lineStep = barTicks / grid;
    const { kv, bad } = parseKv(tm[4] ?? '');
    for (const b of bad) issue(errors, lineNo, name, undefined, `can't read option "${b}" (write {oct=3 vel=90 pitch=C4})`);

    const lk = name.toLowerCase();
    let st = states.get(lk);
    if (!st) {
      const track: KpnTrack = {
        name,
        line: lineNo,
        lines: [lineNo],
        kind: 'empty',
        grid,
        opts: {},
        notes: [],
        clears: [],
        end: 0,
        drumKey: options.drumKey ? options.drumKey(name) : DEFAULT_DRUM_KEY,
        pitchExplicit: false,
      };
      st = { track, stickyTicks: null, pendingSlide: false, holdNote: null, lastBar: 0, lastGrid: grid, lastLine: lineNo, pastEndReported: false };
      states.set(lk, st);
      order.push(st);
    } else {
      st.track.lines.push(lineNo);
      st.lastLine = lineNo;
      st.lastGrid = grid;
      if (st.track.end % barTicks !== 0) {
        issue(warnings, lineNo, name, barOf(st.track.end, barTicks), `continues mid-bar (previous line for ${name} ended at step ${stepsLabel(st.track.end % barTicks, lineStep)} of the bar)`);
      }
      st.lastBar = Math.floor(st.track.end / barTicks) * barTicks;
    }
    const t = st.track;
    Object.assign(t.opts, kv);

    // Validate options.
    let oct = DEFAULT_OCTAVE;
    let vel = DEFAULT_VELOCITY;
    if (t.opts.oct !== undefined) {
      const o = Number(t.opts.oct);
      if (!Number.isInteger(o) || o < -1 || o > 9) issue(errors, lineNo, name, undefined, `oct=${t.opts.oct} must be -1..9`);
      else oct = o;
    }
    if (t.opts.vel !== undefined) {
      const v = Number(t.opts.vel);
      if (!Number.isInteger(v) || v < 1 || v > 127) issue(errors, lineNo, name, undefined, `vel=${t.opts.vel} must be 1..127`);
      else vel = v;
    }
    if (kv.pitch !== undefined) {
      const p = /^\d+$/.test(kv.pitch) ? Number(kv.pitch) : parseNoteName(kv.pitch);
      if (p === null || p < 0 || p > 127) issue(errors, lineNo, name, undefined, `pitch=${kv.pitch} must be a note like C4 or a MIDI number 0..127`);
      else {
        t.drumKey = p;
        t.pitchExplicit = true;
      }
    }
    if (kv.len !== undefined) {
      const l = Number(kv.len);
      if (!Number.isInteger(l) || l < 1) issue(errors, lineNo, name, undefined, `len=${kv.len} must be a whole number of steps`);
      else st.stickyTicks = l * lineStep;
    }
    for (const k of Object.keys(kv)) {
      if (!['oct', 'vel', 'pitch', 'len', 'inst', 'type', 'color'].includes(k)) issue(warnings, lineNo, name, undefined, `unknown option ${k}= (ignored)`);
    }

    const exp = expandRepeats(tm[5]);
    if (exp.error) {
      issue(errors, lineNo, name, undefined, exp.error);
      continue;
    }
    const body = exp.text.trim();
    if (!body) continue;
    const strictGrid = /^[xXo.\-|_1-9\s]+$/.test(body);
    // A step grid with a typo ("x... .q..") should report the bad character, not "x... is not a note".
    const looksGrid = !strictGrid && /[xXo.]{3,}/.test(body) && !/[A-G](?:#|b)?-?\d|[:[\]^@]/.test(body) && body.replace(/[xXo.\-|_1-9\s]/g, '').length <= 3;
    const isGrid = strictGrid || looksGrid;
    const kind = isGrid ? 'grid' : 'melodic';
    if (t.kind !== 'empty' && t.kind !== kind) {
      issue(errors, lineNo, name, undefined, `mixes a step grid and note tokens; use one style per channel`);
      continue;
    }
    t.kind = kind;
    if (isGrid) {
      if (noteCount.n > maxNotes) continue;
      const before = t.notes.length;
      parseGridBody(body, st, lineNo, ctx, lineStep, grid, vel, t.drumKey);
      noteCount.n += t.notes.length - before;
      if (noteCount.n > maxNotes) issue(errors, lineNo, name, undefined, `too many notes (max ${maxNotes} per call)`);
    } else {
      if (/(^|\s)_/.test(body)) issue(warnings, lineNo, name, undefined, `'_' (clear) only works in step grids; note tokens never erase (use mode "replace" or transform_notes)`);
      parseMelodicBody(body.replace(/(^|\s)_(?=\s|$)/g, ' '), st, lineNo, ctx, lineStep, grid, total, key, header.ts, { oct, vel }, maxNotes, noteCount);
    }
  }

  // Finish tracks: total-length checks and dangling slides.
  let maxEnd = 0;
  for (const st of order) {
    const t = st.track;
    for (const n of t.notes) maxEnd = Math.max(maxEnd, n.tick + n.dur);
    maxEnd = Math.max(maxEnd, t.kind === 'grid' ? t.end : 0);
    const lastStep = barTicks / st.lastGrid;
    if (t.kind === 'grid') {
      if (total !== null && t.end !== total) {
        issue(errors, st.lastLine, t.name, undefined, `${stepsLabel(t.end, lastStep)} steps total, expected ${stepsLabel(total, lastStep)} (${header.bars} bar${header.bars === 1 ? '' : 's'} × ${barTicks / lastStep})`);
      } else if (total === null && t.end % barTicks !== 0) {
        issue(errors, st.lastLine, t.name, undefined, `${stepsLabel(t.end, lastStep)} steps is not a whole number of bars (${barTicks / lastStep} steps per bar)`);
      }
    }
    if (st.pendingSlide) issue(warnings, st.lastLine, t.name, undefined, `the last note has a '~' slide but no note follows it (ignored)`);
    t.notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
  }
  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);
  const bars = header.bars ?? Math.max(1, Math.ceil(maxEnd / barTicks));
  return {
    ok: errors.length === 0,
    header,
    tracks: order.map((s) => s.track),
    errors,
    warnings,
    barTicks,
    stepTicks,
    totalTicks: bars * barTicks,
    bars,
  };
}

/** Human summary of parse errors for tool results (first `max`, then a count). */
export function formatIssues(list: KpnIssue[], max = 12): string {
  const shown = list.slice(0, max).map((e) => `- ${e.message}`);
  if (list.length > max) shown.push(`- … and ${list.length - max} more`);
  return shown.join('\n');
}
