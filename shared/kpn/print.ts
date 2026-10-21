// KPN canonical printer: notes → the KPN a model would write. Round-trips
// through parse() for on-grid material (velocity resolution is MIDI 1/127).
//
// Canonical choices (deterministic):
//  - header `pattern "<name>" bars=<n> grid=<16th steps>` (+ ts= when not 4/4, key= when known)
//  - drum channels → step grids when representable (one key, no overlaps,
//    no slides, ≤ 64 steps per bar, ≤ 1 non-standard velocity), else tokens
//  - per-track `/grid` override only when the header grid can't hold the notes
//  - note names are scientific (C4 = MIDI 60); flats in flat keys
//  - sticky lengths minimised; rests split at bar lines; `|` at every bar
//    boundary the cursor lands on; `@bar.step` for overlaps and gaps ≥ 2 bars
//  - identical consecutive grid bars fold into `( ... |)*n`

import { noteName, parseKey } from '../music/theory';
import { ticksPerBar, ticksPerBeat, type TimeSig } from '../schema/time';
import { DEFAULT_DRUM_KEY, DEFAULT_VELOCITY, GRID_ACCENT, GRID_DIGIT_STEP, GRID_GHOST, TOKEN_ACCENT, TOKEN_GHOST, defaultGrid, defaultLenSteps } from './parse';
import type { PrintNote, PrintOptions, PrintResult, PrintTrack } from './types';

const DEFAULT_TS: TimeSig = { num: 4, den: 4 };
const MAX_GRID_LINE = 64;

export function midiVelocity(vel: number): number {
  return Math.min(127, Math.max(1, Math.round(vel * 127)));
}

function divisors(n: number): number[] {
  const out: number[] = [];
  for (let g = 1; g <= n; g++) if (n % g === 0) out.push(g);
  return out;
}

function fits(notes: PrintNote[], stepTicks: number): boolean {
  return notes.every((n) => n.tick % stepTicks === 0 && n.dur % stepTicks === 0 && n.dur >= stepTicks);
}

function chooseGrid(notes: PrintNote[], headerGrid: number, barTicks: number, maxGrid: number): { grid: number; exact: boolean } {
  if (fits(notes, barTicks / headerGrid)) return { grid: headerGrid, exact: true };
  const divs = divisors(barTicks);
  for (const g of divs) {
    if (g > maxGrid) break;
    if (fits(notes, barTicks / g)) return { grid: g, exact: true };
  }
  const usable = divs.filter((g) => g <= maxGrid);
  return { grid: usable[usable.length - 1] ?? headerGrid, exact: false };
}

/** Flats for flat keys (F, Bb, Eb … / Dm, Gm, Cm …), sharps otherwise. */
export function prefersFlats(key: string | null | undefined): boolean {
  if (!key) return false;
  const k = parseKey(key);
  if (!k) return false;
  if (/^[A-G]b/.test(key.trim())) return true;
  const minorish = k.scale === 'minor' || k.scale === 'dorian' || k.scale === 'phrygian' || k.scale === 'harmonicMinor' || k.scale === 'melodicMinor' || k.scale === 'minorPentatonic' || k.scale === 'blues';
  return minorish ? [2, 7, 0, 5, 10, 3].includes(k.root) : [5, 10, 3, 8, 1, 6].includes(k.root);
}

function quoteName(name: string): string {
  if (/^[^\s"{}:/]+$/.test(name) && name.toLowerCase() !== 'pattern') return name;
  return `"${name.replace(/"/g, '\\"')}"`;
}

function groupSteps(steps: string[], grid: number, ts: TimeSig): string {
  const spb = (grid * ticksPerBeat(ts)) / ticksPerBar(ts);
  const size = Number.isInteger(spb) && spb >= 3 && spb <= 6 ? spb : grid % 4 === 0 && grid >= 8 ? 4 : grid % 3 === 0 && grid >= 6 ? 3 : 0;
  if (!size) return steps.join('');
  const out: string[] = [];
  for (let i = 0; i < steps.length; i += size) out.push(steps.slice(i, i + size).join(''));
  return out.join(' ');
}

function gridChar(v: number, lineVel: number): string | null {
  if (v === lineVel) return 'x';
  if (v === GRID_ACCENT) return 'X';
  if (v === GRID_GHOST) return 'o';
  if (v % GRID_DIGIT_STEP === 0 && v >= GRID_DIGIT_STEP && v <= 9 * GRID_DIGIT_STEP) return String(v / GRID_DIGIT_STEP);
  return null;
}

function isStandardGridVel(v: number): boolean {
  return v === GRID_ACCENT || v === GRID_GHOST || (v % GRID_DIGIT_STEP === 0 && v >= GRID_DIGIT_STEP && v <= 9 * GRID_DIGIT_STEP);
}

interface Line {
  prefix: string;
  body: string;
}

function tryGridLine(track: PrintTrack, notes: PrintNote[], grid: number, barTicks: number, bars: number, headerGrid: number, compress: boolean, ts: TimeSig): Line | null {
  if (grid > MAX_GRID_LINE) return null;
  if (notes.some((n) => n.slide)) return null;
  const key = notes.length ? notes[0].key : (track.drumKey ?? DEFAULT_DRUM_KEY);
  if (notes.some((n) => n.key !== key)) return null;
  for (let i = 1; i < notes.length; i++) if (notes[i].tick < notes[i - 1].tick + notes[i - 1].dur) return null;
  const vels = notes.map((n) => midiVelocity(n.vel));
  const nonStd = [...new Set(vels.filter((v) => !isStandardGridVel(v) && v !== DEFAULT_VELOCITY))];
  let lineVel = DEFAULT_VELOCITY;
  if (nonStd.length > 1) return null;
  if (nonStd.length === 1) {
    if (vels.includes(DEFAULT_VELOCITY)) return null;
    lineVel = nonStd[0];
  }
  const st = barTicks / grid;
  const total = bars * grid;
  const steps = new Array<string>(total).fill('.');
  for (let i = 0; i < notes.length; i++) {
    const s = notes[i].tick / st;
    const k = notes[i].dur / st;
    if (s + k > total) return null;
    const c = gridChar(vels[i], lineVel);
    if (!c) return null;
    steps[s] = c;
    for (let j = 1; j < k; j++) steps[s + j] = '-';
  }
  const barStrs: string[] = [];
  for (let b = 0; b < bars; b++) barStrs.push(groupSteps(steps.slice(b * grid, (b + 1) * grid), grid, ts));
  const parts: string[] = [];
  let i = 0;
  while (i < barStrs.length) {
    let j = i + 1;
    if (compress && !barStrs[i].startsWith('-')) while (j < barStrs.length && barStrs[j] === barStrs[i]) j++;
    const run = j - i;
    if (run >= 2) {
      parts.push(`(${barStrs[i]} |)*${run}`);
    } else {
      parts.push(barStrs[i]);
      if (i < barStrs.length - 1) parts.push('|');
      j = i + 1;
    }
    i = j;
  }
  const opts: string[] = [];
  if (key !== (track.drumKey ?? DEFAULT_DRUM_KEY)) opts.push(`pitch=${noteName(key)}`);
  if (lineVel !== DEFAULT_VELOCITY) opts.push(`vel=${lineVel}`);
  const prefix = `${quoteName(track.name)}${grid !== headerGrid ? `/${grid}` : ''}${opts.length ? ` {${opts.join(' ')}}` : ''}`;
  return { prefix, body: parts.join(' ') };
}

function modeVelocity(vels: number[]): number {
  const counts = new Map<number, number>();
  for (const v of vels) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = DEFAULT_VELOCITY;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && Math.abs(v - DEFAULT_VELOCITY) < Math.abs(best - DEFAULT_VELOCITY))) {
      best = v;
      bestN = n;
    }
  }
  return bestN < 0 ? DEFAULT_VELOCITY : best;
}

function velSuffix(v: number, lineVel: number): string {
  if (v === lineVel) return '';
  if (v === TOKEN_ACCENT) return '!';
  if (v === TOKEN_GHOST) return '?';
  return `v${v}`;
}

interface Event {
  tick: number;
  dur: number;
  slide: boolean;
  keys: number[];
  vels: number[];
}

function melodicLine(track: PrintTrack, notes: PrintNote[], grid: number, barTicks: number, ts: TimeSig, headerGrid: number, flats: boolean): Line {
  const st = barTicks / grid;
  const vels = notes.map((n) => midiVelocity(n.vel));
  const lineVel = modeVelocity(vels);
  // Group simultaneous notes with equal length + slide flag into chords.
  const byKey = new Map<string, Event>();
  const events: Event[] = [];
  notes.forEach((n, i) => {
    const k = `${n.tick}|${n.dur}|${n.slide ? 1 : 0}`;
    let e = byKey.get(k);
    if (!e) {
      e = { tick: n.tick, dur: n.dur, slide: !!n.slide, keys: [], vels: [] };
      byKey.set(k, e);
      events.push(e);
    }
    e.keys.push(n.key);
    e.vels.push(vels[i]);
  });
  events.sort((a, b) => a.tick - b.tick || b.dur - a.dur || a.keys[0] - b.keys[0]);
  for (const e of events) {
    const idx = e.keys.map((_, i) => i).sort((a, b) => e.keys[a] - e.keys[b]);
    e.keys = idx.map((i) => e.keys[i]);
    e.vels = idx.map((i) => e.vels[i]);
  }

  const tokens: string[] = [];
  let cursor = 0;
  let sticky = defaultLenSteps(grid, ts) * st;
  let lastJump = false;
  let prevNoteIdx = -1;
  const name = (k: number) => noteName(k, 'scientific', flats);
  const barLine = () => {
    if (cursor > 0 && cursor % barTicks === 0 && tokens.length && tokens[tokens.length - 1] !== '|' && !lastJump) tokens.push('|');
  };
  const lenSuffix = (dur: number) => {
    if (dur === sticky) return '';
    sticky = dur;
    return `:${dur / st}`;
  };
  const jump = (tick: number) => {
    const bar = Math.floor(tick / barTicks) + 1;
    const step = (tick - (bar - 1) * barTicks) / st + 1;
    tokens.push(`@${bar}.${step}`);
    cursor = tick;
    lastJump = true;
  };

  for (const e of events) {
    if (e.tick < cursor) jump(e.tick);
    else if (e.tick > cursor) {
      if (e.tick - cursor >= 2 * barTicks) jump(e.tick);
      else {
        while (cursor < e.tick) {
          const nextBar = (Math.floor(cursor / barTicks) + 1) * barTicks;
          const seg = Math.min(e.tick, nextBar) - cursor;
          barLine();
          tokens.push(`r${lenSuffix(seg)}`);
          lastJump = false;
          cursor += seg;
        }
      }
    }
    barLine();
    let head: string;
    let tokenVel = '';
    if (e.keys.length === 1) {
      head = name(e.keys[0]);
      tokenVel = velSuffix(e.vels[0], lineVel);
    } else {
      const same = e.vels.every((v) => v === e.vels[0]);
      head = same ? `[${e.keys.map(name).join(' ')}]` : `[${e.keys.map((k, i) => `${name(k)}${velSuffix(e.vels[i], lineVel)}`).join(' ')}]`;
      tokenVel = same ? velSuffix(e.vels[0], lineVel) : '';
    }
    let tok = `${head}${lenSuffix(e.dur)}${tokenVel}`;
    if (e.slide) {
      if (prevNoteIdx >= 0 && !tokens[prevNoteIdx].endsWith('~')) tokens[prevNoteIdx] += '~';
      else tok = `~${tok}`;
    }
    tokens.push(tok);
    prevNoteIdx = tokens.length - 1;
    lastJump = false;
    cursor = e.tick + e.dur;
  }
  const opts = lineVel !== DEFAULT_VELOCITY ? ` {vel=${lineVel}}` : '';
  const prefix = `${quoteName(track.name)}${grid !== headerGrid ? `/${grid}` : ''}${opts}`;
  return { prefix, body: tokens.join(' ') };
}

/** Print tracks as canonical KPN, with warnings (off-grid notes, content past the end). */
export function printKpn(tracks: PrintTrack[], opts: PrintOptions = {}): PrintResult {
  const ts = opts.ts ?? DEFAULT_TS;
  const barTicks = ticksPerBar(ts);
  const headerGrid = opts.grid && barTicks % opts.grid === 0 ? opts.grid : defaultGrid(ts);
  const maxGrid = opts.maxGrid ?? 192;
  const warnings: string[] = [];
  const flats = prefersFlats(opts.key);

  let maxEnd = 0;
  for (const t of tracks) for (const n of t.notes) maxEnd = Math.max(maxEnd, n.tick + n.dur);
  const contentBars = Math.max(1, Math.ceil(maxEnd / barTicks));
  let bars = opts.bars && opts.bars > 0 ? opts.bars : contentBars;
  if (contentBars > bars) {
    warnings.push(`notes run past the pattern length (${bars} bar${bars === 1 ? '' : 's'}); printed ${contentBars} bars`);
    bars = contentBars;
  }

  const lines: Line[] = [];
  for (const t of tracks) {
    const sorted = [...t.notes]
      .filter((n) => n.dur > 0)
      .sort((a, b) => a.tick - b.tick || a.key - b.key)
      .map((n) => ({ tick: Math.max(0, Math.round(n.tick)), dur: Math.max(1, Math.round(n.dur)), key: n.key, vel: n.vel, slide: !!n.slide }));
    if (sorted.length === 0) {
      lines.push({ prefix: quoteName(t.name), body: '' });
      continue;
    }
    const { grid, exact } = chooseGrid(sorted, headerGrid, barTicks, maxGrid);
    let notes = sorted;
    if (!exact) {
      const st = barTicks / grid;
      let moved = 0;
      notes = sorted.map((n) => {
        const tick = Math.round(n.tick / st) * st;
        const dur = Math.max(st, Math.round(n.dur / st) * st);
        if (tick !== n.tick || dur !== n.dur) moved++;
        return { ...n, tick, dur };
      });
      warnings.push(`${t.name}: ${moved} note${moved === 1 ? ' is' : 's are'} off-grid; shown quantized to 1/${grid} bar (exact ticks are kept in the project)`);
    }
    let line: Line | null = null;
    if (t.drum) line = tryGridLine(t, notes, grid, barTicks, bars, headerGrid, opts.compress ?? true, ts);
    if (!line) line = melodicLine(t, notes, grid, barTicks, ts, headerGrid, flats);
    lines.push(line);
  }

  const out: string[] = [];
  if (opts.header ?? true) {
    let h = 'pattern';
    if (opts.name) h += ` "${opts.name.replace(/"/g, '\\"')}"`;
    h += ` bars=${bars} grid=${headerGrid}`;
    if (ts.num !== 4 || ts.den !== 4) h += ` ts=${ts.num}/${ts.den}`;
    if (opts.key) h += /\s/.test(opts.key) ? ` key="${opts.key}"` : ` key=${opts.key}`;
    out.push(h);
  }
  const width = opts.align === false ? 0 : Math.min(16, Math.max(0, ...lines.map((l) => l.prefix.length)));
  for (const l of lines) {
    const pad = l.prefix.length < width ? l.prefix.padEnd(width) : l.prefix;
    out.push(l.body ? `${pad}: ${l.body}` : `${pad}:`);
  }
  return { text: out.join('\n'), warnings };
}

/** Canonical KPN text (see printKpn for warnings). */
export function print(tracks: PrintTrack[], opts: PrintOptions = {}): string {
  return printKpn(tracks, opts).text;
}
