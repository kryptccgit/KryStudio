import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import type { Analysis, RenderScope, SlotGainReduction } from '@shared/engine/protocol';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import { syncBpm } from '@shared/analyzer/tempo';
import { fmtSemitones, keyShift, keyShortName, toKeyRef } from '@shared/music/keymatch';
import { ticksPerBar, ticksToSeconds } from '@shared/schema/time';
import { symbolicStats, type SymbolicChannel, type SymbolicStats } from '@shared/kpn';
import { parseKey } from '@shared/music/theory';
import { defineTool, fail } from './types';
import { findPattern, fmtBars, looksLikePath, parseBarRange, parsePosition, plural, round, safeName } from './util';
import { isDrumChannel, songLengthTicks } from './overview';
import { resolveTarget } from './ears';
import { dynamicsLine, dynamicsReport } from './dynamics';

const MAX_RENDER_BARS = 64;
const KEEP_PREVIEWS = 20;

export function songNotes(p: Project, start: number, end: number): SymbolicChannel[] {
  const by = new Map<string, SymbolicChannel>();
  const soloTracks = p.playlist.trackOrder.filter((t) => p.playlist.tracks[t].solo);
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || c.mute || !c.patternId) continue;
    const track = p.playlist.tracks[c.trackId];
    if (!track || track.mute || (soloTracks.length && !soloTracks.includes(c.trackId))) continue;
    if (c.start >= end || c.start + c.length <= start) continue;
    const pat = p.patterns[c.patternId];
    if (!pat) continue;
    for (const [chId, notes] of Object.entries(pat.notes)) {
      const ch = p.channels[chId];
      if (!ch || ch.mute) continue;
      let entry = by.get(chId);
      if (!entry) {
        entry = { name: safeName(ch.name), notes: [], drum: isDrumChannel(ch) };
        by.set(chId, entry);
      }
      for (const n of Object.values(notes)) {
        if (n.tick < c.offset || n.tick >= c.offset + c.length) continue;
        const t = c.start + (n.tick - c.offset);
        if (t < start || t >= end) continue;
        entry.notes.push({ tick: t - start, dur: n.dur, key: n.key, vel: n.vel });
      }
    }
  }
  return p.channelOrder.filter((id) => by.has(id)).map((id) => by.get(id)!);
}

export function patternNotes(p: Project, patternId: string): SymbolicChannel[] {
  const pat = p.patterns[patternId];
  return p.channelOrder
    .filter((id) => Object.keys(pat.notes[id] ?? {}).length && !p.channels[id].mute)
    .map((id) => ({ name: safeName(p.channels[id].name), notes: Object.values(pat.notes[id]).map((n) => ({ tick: n.tick, dur: n.dur, key: n.key, vel: n.vel })), drum: isDrumChannel(p.channels[id]) }));
}

function r1(n: number | null | undefined): number | null {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}

export interface CompactAnalysis {
  durationSec: number;
  lufs: number | null;
  lufsShortTermMax: number | null;
  truePeakDb: number | null;
  peakDb: number | null;
  crestDb: number | null;
  loudnessRange: number | null;
  bands: Record<string, number | null>;
  stereo: { correlation: number | null; width: number | null };
  clipping: boolean;
  centroidHz: number | null;
  estimatedBpm: number | null;
  energy: Array<number | null>;
}

export function compactAnalysis(a: Analysis): CompactAnalysis {
  const curve = a.energyCurve ?? [];
  const step = Math.max(1, Math.ceil(curve.length / 24));
  const energy: Array<number | null> = [];
  for (let i = 0; i < curve.length; i += step) {
    const slice = curve.slice(i, i + step).filter((x) => Number.isFinite(x));
    energy.push(slice.length ? r1(Math.max(...slice)) : null);
  }
  return {
    durationSec: round(a.durationSec, 2),
    lufs: r1(a.lufsIntegrated),
    lufsShortTermMax: r1(a.lufsShortTermMax),
    truePeakDb: r1(a.truePeakDb),
    peakDb: r1(a.peakDb),
    crestDb: r1(a.crestDb),
    loudnessRange: r1(a.loudnessRange),
    bands: Object.fromEntries(Object.entries(a.bands ?? {}).map(([k, v]) => [k, r1(v)])),
    stereo: { correlation: a.stereoCorrelation === undefined ? null : round(a.stereoCorrelation, 2), width: a.stereoWidth === undefined ? null : round(a.stereoWidth, 2) },
    clipping: !!a.clipping,
    centroidHz: a.spectralCentroidHz ? Math.round(a.spectralCentroidHz) : null,
    estimatedBpm: a.estimatedBpm ? round(a.estimatedBpm, 1) : null,
    energy,
  };
}

export function isEmptyAnalysis(a: Analysis | undefined | null): boolean {
  if (!a) return true;
  const bands = Object.values(a.bands ?? {});
  return a.lufsIntegrated === 0 && a.truePeakDb === 0 && a.peakDb === 0 && a.crestDb === 0 && bands.every((b) => b === 0);
}

export function wavStats(file: string): { durationSec: number; peakDb: number | null; rmsDb: number | null; crestDb: number | null; correlation: number | null } | null {
  let b: Buffer;
  try {
    b = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { format: number; ch: number; sr: number; bits: number } | null = null;
  let data: { off: number; size: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    else if (id === 'data') data = { off: off + 8, size: Math.min(size, b.length - off - 8) };
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.ch < 1) return null;
  const bytes = fmt.bits / 8;
  const read = (i: number): number => {
    if (fmt!.format === 3 && fmt!.bits === 32) return b.readFloatLE(i);
    if (fmt!.bits === 16) return b.readInt16LE(i) / 32768;
    if (fmt!.bits === 24) return b.readIntLE(i, 3) / 8388608;
    if (fmt!.bits === 32) return b.readInt32LE(i) / 2147483648;
    return 0;
  };
  const frames = Math.floor(data.size / (bytes * fmt.ch));
  let peak = 0;
  let sum = 0;
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let f = 0; f < frames; f++) {
    const base = data.off + f * bytes * fmt.ch;
    const l = read(base);
    const r = fmt.ch > 1 ? read(base + bytes) : l;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sum += (l * l + r * r) / 2;
    lr += l * r;
    ll += l * l;
    rr += r * r;
  }
  const db = (x: number) => (x > 1e-9 ? Math.round(20 * Math.log10(x) * 10) / 10 : null);
  const rms = frames ? Math.sqrt(sum / frames) : 0;
  const peakDb = db(peak);
  const rmsDb = db(rms);
  return {
    durationSec: round(frames / fmt.sr, 2),
    peakDb,
    rmsDb,
    crestDb: peakDb !== null && rmsDb !== null ? round(peakDb - rmsDb, 1) : null,
    correlation: ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 2) : null,
  };
}

export function findIssues(a: CompactAnalysis | null, s: SymbolicStats | null, bpm: number): string[] {
  const out: string[] = [];
  if (a) {
    if (a.lufs === null || a.lufs < -60) out.push('Render is silent: nothing audible played (muted channels, empty pattern, or song mode with no clips in range?)');
    else {
      if (a.lufs < -28) out.push(`Very quiet (${a.lufs} LUFS): raise levels or check that the main parts play`);
      if (a.lufs > -7) out.push(`Very loud (${a.lufs} LUFS): little headroom left for mastering`);
    }
    if (a.truePeakDb !== null && a.truePeakDb > -1) out.push(`True peak ${a.truePeakDb} dBTP: leave >= 1 dB headroom (lower the master or set the master limiter ceiling to -1 dB)`);
    if (a.clipping) out.push('Clipping detected');
    if (a.stereo.correlation !== null && a.stereo.correlation < 0) out.push(`Phase problem: stereo correlation ${a.stereo.correlation} (mono playback will cancel parts)`);
    if (a.crestDb !== null && a.crestDb < 6 && a.lufs !== null && a.lufs > -40) out.push(`Very dense / over-compressed (crest ${a.crestDb} dB)`);
    const b = a.bands;
    const vals = Object.values(b).filter((x): x is number => x !== null);
    if (vals.length >= 4) {
      const avg = vals.reduce((x, y) => x + y, 0) / vals.length;
      if (b.sub !== null && b.sub !== undefined && b.sub - avg > 9) out.push(`Sub-heavy: sub band ${round(b.sub - avg, 1)} dB above the band average`);
      if (b.lowMid !== null && b.lowMid !== undefined && b.mid !== null && b.mid !== undefined && b.lowMid - b.mid > 6) out.push(`Low-mid build-up (250-500 Hz ${round(b.lowMid - b.mid, 1)} dB over mids): cut 300 Hz on pads/keys, or high-pass non-bass parts`);
      if (b.high !== null && b.high !== undefined && b.high - avg < -18) out.push('Dull top end: little above 6 kHz (hats, air, brighter synths?)');
    }
    if (a.estimatedBpm && Math.abs(a.estimatedBpm - bpm) > 3 && Math.abs(a.estimatedBpm - bpm * 2) > 3 && Math.abs(a.estimatedBpm * 2 - bpm) > 3) out.push(`Audio tempo estimate ${a.estimatedBpm} bpm differs from the project ${bpm} bpm (sparse drums can fool the estimate)`);
  }
  if (s) {
    if (s.outOfKeyRatio !== null && s.outOfKeyRatio > 0.1) out.push(`${Math.round(s.outOfKeyRatio * 100)}% of pitched notes are outside ${s.key.given ?? s.key.estimated}: ${s.outOfKeyNotes.slice(0, 4).join(', ')}`);
    for (const c of s.lowClashes.slice(0, 2)) out.push(`Low-register clash: ${c}`);
    if (s.notes === 0) out.push('No notes in this scope');
  }
  return out;
}

function prunePreviews(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^(preview|compare|review)-\d+.*\.wav$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(KEEP_PREVIEWS)) fs.rmSync(path.join(dir, x.f), { force: true });
    const dirs = fs
      .readdirSync(dir)
      .filter((f) => /^(review|mixmatch)-\d+.*-stems$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of dirs.slice(KEEP_STEM_RENDERS)) fs.rmSync(path.join(dir, x.f), { recursive: true, force: true });
  } catch {
  }
}

const KEEP_STEM_RENDERS = 4;

export interface RenderArgs {
  scope?: 'pattern' | 'song' | 'bars';
  pattern?: string;
  bars?: string;
  key?: string;
  loops?: number;
}

export interface RenderPlan {
  scope: 'pattern' | 'song' | 'bars';
  rs: RenderScope;
  symbolic: SymbolicStats;
  label: string;
  lengthTicks: number;
  range: { start: number; end: number } | null;
}

export function audibleSongEnd(p: Project): number {
  const solo = p.playlist.trackOrder.filter((t) => p.playlist.tracks[t]?.solo);
  let end = 0;
  for (const c of Object.values(p.playlist.clips)) {
    const t = p.playlist.tracks[c.trackId];
    if (c.kind === 'automation' || c.mute || !t || t.mute || (solo.length && !solo.includes(c.trackId))) continue;
    if (c.channelId && p.channels[c.channelId]?.mute) continue;
    end = Math.max(end, c.start + c.length);
  }
  return end;
}

export function planRender(deps: MainDeps, a: RenderArgs, maxBars: number, opts: { audibleSong?: boolean } = {}): RenderPlan {
  const p = deps.doc.project;
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const loops = a.loops ?? 1;
  if (a.key && !parseKey(a.key)) fail(`key "${safeName(a.key, 16)}" isn't a key (e.g. "Am", "F#m", "Eb")`);
  const songLen = songLengthTicks(p);
  const scope = a.scope ?? (a.bars ? 'bars' : p.transport.mode === 'song' && songLen > 0 ? 'song' : 'pattern');
  if (scope === 'pattern') {
    const pat = findPattern(p, a.pattern);
    const lengthTicks = patternLength(pat, ts) * loops;
    if (lengthTicks > maxBars * bar) fail(`That is ${fmtBars(lengthTicks, ts)}; render at most ${maxBars} bars (fewer loops).`);
    return {
      scope,
      rs: { kind: 'pattern', patternId: pat.id },
      symbolic: symbolicStats(patternNotes(p, pat.id), { lengthTicks: patternLength(pat, ts), ts, key: a.key ?? null }),
      label: `pattern "${safeName(pat.name)}" (${fmtBars(patternLength(pat, ts), ts)}${loops > 1 ? ` × ${loops}` : ''})`,
      lengthTicks,
      range: null,
    };
  }
  let start = 0;
  let end = songLen;
  let trimmed = false;
  if (scope === 'song' && opts.audibleSong) {
    const audible = audibleSongEnd(p);
    if (audible <= 0) fail('Nothing of yours plays in the song yet (every clip is muted, or the Playlist only holds the reference): arrange your patterns first, or compare scope "pattern".');
    if (audible < songLen) {
      end = audible;
      trimmed = true;
    }
  }
  if (scope === 'bars') {
    if (!a.bars) fail('scope "bars" needs bars, e.g. "9-16"');
    const r = parseBarRange(a.bars, ts);
    start = r.start;
    end = r.end;
  }
  if (end <= start) fail('The playlist is empty: arrange patterns first (arrange), or render scope "pattern".');
  if (end - start > maxBars * bar) fail(`That is ${fmtBars(end - start, ts)}; render at most ${maxBars} bars at a time (use bars, e.g. "1-32").`);
  return {
    scope,
    rs: scope === 'song' && !trimmed ? { kind: 'song' } : { kind: 'range', startTick: start, endTick: end },
    symbolic: symbolicStats(songNotes(p, start, end), { lengthTicks: end - start, ts, key: a.key ?? null }),
    label: scope === 'song' ? `the song (${fmtBars(end, ts)}${trimmed ? ', to its last audible clip' : ''})` : `bars ${a.bars}`,
    lengthTicks: end - start,
    range: { start, end },
  };
}

async function renderPlan(deps: MainDeps, plan: RenderPlan, loops = 1, prefix: RenderPrefix = 'preview', stems = false) {
  const dir = deps.project.renderDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
  }
  const file = path.join(dir, `${prefix}-${Date.now()}-${plan.scope}${stems ? '-stems' : '.wav'}`);
  const res = await deps.engine.render({ path: file, scope: plan.rs, format: 'wav16', tailSec: 1, analyze: true, loops: plan.scope === 'pattern' ? loops : undefined, ...(stems ? { stems: true } : {}) });
  prunePreviews(dir);
  return res;
}

type RenderPrefix = 'preview' | 'compare' | 'review' | 'mixmatch';

export interface StemRender {
  insertId: string;
  name: string;
  path: string;
  analysis: Analysis | null;
}

export interface RenderOutcome {
  plan: RenderPlan;
  ok: boolean;
  error?: string;
  file: string | null;
  raw: Analysis | null;
  analysis: CompactAnalysis | null;
  measured: ReturnType<typeof wavStats>;
  issues: string[];
  seconds: number;
  stems?: StemRender[] | null;
  stemsProblem?: string;
  gainReduction?: SlotGainReduction[];
}

export async function renderAndAnalyse(deps: MainDeps, a: RenderArgs, opts: { maxBars: number; audibleSong?: boolean; prefix?: RenderPrefix; stems?: boolean }): Promise<RenderOutcome> {
  const p = deps.doc.project;
  const plan = planRender(deps, a, opts.maxBars, { audibleSong: opts.audibleSong });
  const seconds = round(ticksToSeconds(plan.lengthTicks, p.transport.bpm), 1);
  let res = await renderPlan(deps, plan, a.loops ?? 1, opts.prefix ?? 'preview', !!opts.stems);
  let stemsProblem: string | undefined;
  if (opts.stems && (!res.ok || !res.data || !res.data.stemResults?.length)) {
    stemsProblem = !res.ok || !res.data ? `this engine build can't render stems (${res.message ?? 'no result'})` : 'this engine build returned no stem files';
    if (!res.ok || !res.data) res = await renderPlan(deps, plan, a.loops ?? 1, opts.prefix ?? 'preview', false);
  }
  if (!res.ok || !res.data) {
    return { plan, ok: false, error: res.message ?? 'the audio engine returned no result', file: null, raw: null, analysis: null, measured: null, issues: findIssues(null, plan.symbolic, p.transport.bpm), seconds, stems: null, stemsProblem };
  }
  const stemList = res.data.stemResults?.length ? res.data.stemResults : null;
  const master = stemList?.find((s) => s.insertId === p.mixer.masterId || s.name === 'Master');
  const top = res.data.analysis && !isEmptyAnalysis(res.data.analysis) ? res.data.analysis : null;
  const raw = top ?? (master?.analysis && !isEmptyAnalysis(master.analysis) ? master.analysis : null);
  const stems: StemRender[] | null = stemList
    ? stemList.filter((s) => s !== master).map((s) => ({ insertId: s.insertId, name: s.name, path: s.path, analysis: s.analysis && !isEmptyAnalysis(s.analysis) ? s.analysis : null }))
    : null;
  const mixFile = stemList ? (master?.path ?? res.data.path) : res.data.path;
  const analysis = raw ? compactAnalysis(raw) : null;
  const measured = analysis ? null : wavStats(mixFile);
  const issues = findIssues(analysis, plan.symbolic, p.transport.bpm);
  if (measured) {
    if (measured.peakDb === null) issues.unshift('Render is silent: nothing audible played (muted channels, empty pattern, or song mode with no clips in range?)');
    else if (measured.peakDb > -1) issues.unshift(`Sample peak ${measured.peakDb} dBFS: leave >= 1 dB headroom (lower the master or set the limiter ceiling to -1 dB)`);
    if (measured.correlation !== null && measured.correlation < 0) issues.push(`Phase problem: stereo correlation ${measured.correlation}`);
  }
  return { plan, ok: true, file: mixFile, raw, analysis, measured, issues, seconds, stems, ...(stemsProblem ? { stemsProblem } : {}), ...(res.data.gainReduction ? { gainReduction: res.data.gainReduction } : {}) };
}

export const renderPreview = defineTool({
  name: 'render_preview',
  title: 'Render and analyse (the agent\'s ears)',
  kind: 'read',
  description:
    'Your ears. Offline-renders the song, a pattern, or a bar range through the full mixer (post-FX) and returns compact analysis: integrated / short-term LUFS, true peak, crest, 6 band levels (sub <60, low 60-250, lowMid 250-500, mid 500-2k, highMid 2-6k, high 6-20k dB), stereo correlation/width, clipping, an energy curve (LUFS over time), PLUS exact symbolic stats from the notes: key estimate, chords per bar, out-of-key notes vs `key`, pitch ranges, note density, low-register clashes, the measured gain reduction of every compressor / limiter slot — and a list of issues. Render after big changes, fix the issues, render again. Max 64 bars. Example: {"scope":"bars","bars":"9-16","key":"F#m"}',
  input: z.object({
    scope: z.enum(['pattern', 'song', 'bars']).optional().describe('Default: bars if given, else song in song mode, else the active pattern.'),
    pattern: z.string().optional().describe('Pattern for scope "pattern" (default: active).'),
    bars: z.string().optional().describe('Song bar range "9-16" (inclusive).'),
    key: z.string().max(16).optional().describe('Key for out-of-key stats, e.g. "F#m".'),
    loops: z.number().int().min(1).max(4).default(1).describe('Pattern loops to render.'),
  }),
  summarize: (a) => (a.bars ? `bars ${a.bars}` : a.scope ?? (a.pattern ? safeName(a.pattern, 30) : 'auto')),
  async run(deps, _c, a) {
    const p = deps.doc.project;
    const out = await renderAndAnalyse(deps, a, { maxBars: MAX_RENDER_BARS });
    const { scope, symbolic, label } = out.plan;
    const { analysis, measured, issues, seconds: secs } = out;
    if (!out.ok || !out.file) {
      return {
        ok: false,
        message: `Render of ${label} failed: ${out.error}. Symbolic stats (from the notes) are still below.`,
        changed: [],
        data: { scope, symbolic, issues },
        text: JSON.stringify({ symbolic, issues }),
      };
    }
    const lines: string[] = [];
    lines.push(`render ${path.basename(out.file)}  ${label}  ${secs}s @ ${p.transport.bpm} bpm`);
    if (measured) {
      lines.push(`level     peak ${measured.peakDb ?? '-inf'} dBFS  RMS ${measured.rmsDb ?? '-inf'} dBFS  crest ${measured.crestDb ?? '?'} dB  stereo corr ${measured.correlation ?? '?'}  (measured from the WAV: this engine build returned no loudness/spectrum analysis, so LUFS and band levels are unavailable)`);
    }
    if (analysis) {
      lines.push(`loudness  I=${analysis.lufs ?? '-inf'} LUFS  ST.max=${analysis.lufsShortTermMax ?? '-inf'}  TP=${analysis.truePeakDb ?? '-inf'} dBTP  peak=${analysis.peakDb ?? '-inf'}  crest=${analysis.crestDb ?? '?'} dB  LRA=${analysis.loudnessRange ?? '?'}${analysis.clipping ? '  CLIPPING' : ''}`);
      lines.push(`bands dB  ${Object.entries(analysis.bands).map(([k, v]) => `${k} ${v ?? '-inf'}`).join(' | ')}  centroid ${analysis.centroidHz ?? '?'} Hz`);
      lines.push(`stereo    corr ${analysis.stereo.correlation ?? '?'}  width ${analysis.stereo.width ?? '?'}${analysis.estimatedBpm ? `   tempo est ${analysis.estimatedBpm} bpm` : ''}`);
      if (analysis.energy.length) lines.push(`energy    ${analysis.energy.map((x) => x ?? '-inf').join(' ')}  (LUFS, ~${round(analysis.durationSec / analysis.energy.length, 1)}s steps)`);
    } else if (!measured) lines.push('analysis  (the engine returned no analysis and the WAV could not be read)');
    lines.push(`symbolic  key ${symbolic.key.given ? `given ${symbolic.key.given}, ` : ''}est ${symbolic.key.estimated ?? '?'} (${symbolic.key.confidence}) · chords ${symbolic.chords.join(' ')} · ${symbolic.notes} notes, ${symbolic.density}/beat${symbolic.outOfKeyRatio !== null ? ` · out-of-key ${Math.round(symbolic.outOfKeyRatio * 100)}%` : ''}`);
    lines.push(`channels  ${symbolic.channels.map((c) => `${c.name} ${c.notes}${c.range ? ` ${c.range}` : ''}`).join(' · ')}`);
    const dynamics = dynamicsReport(p, deps.doc.catalog, out.gainReduction);
    const dynLine = dynamicsLine(dynamics);
    if (dynLine) lines.push(dynLine);
    lines.push(issues.length ? `issues    ${issues.map((x, i) => `${i + 1}) ${x}`).join('  ')}` : 'issues    none found');
    return {
      ok: true,
      message: `Rendered ${label}: ${analysis ? `${analysis.lufs ?? '-inf'} LUFS, true peak ${analysis.truePeakDb ?? '-inf'} dBTP` : measured ? `peak ${measured.peakDb ?? '-inf'} dBFS, RMS ${measured.rmsDb ?? '-inf'} dBFS (no LUFS/spectrum from this engine build)` : 'no analysis'}; ${plural(issues.length, 'issue')}.`,
      changed: [],
      text: lines.join('\n'),
      data: { file: out.file, scope, seconds: secs, analysis, measured, symbolic, issues, ...(dynamics?.length ? { dynamics } : {}) },
    };
  },
});

const MAX_COMPARE_BARS = 160;
const BAND_KEYS = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'] as const;
type BandKey = (typeof BAND_KEYS)[number];
const BAND_WORDS: Record<BandKey, string> = { sub: 'sub (<60 Hz)', low: 'low (60-250 Hz)', lowMid: 'low mids (250-500 Hz)', mid: 'mids (500 Hz-2 kHz)', highMid: 'high mids (2-6 kHz)', high: 'highs (6-20 kHz)' };
const BAND_GROUPS: Array<{ name: string; bands: BandKey[]; more: string; less: string }> = [
  { name: 'low end', bands: ['sub', 'low'], more: 'turn up the kick / 808 / bass or boost below ~120 Hz', less: 'turn down the kick / 808 / bass or cut below ~120 Hz (and high-pass the non-bass parts)' },
  { name: 'mids', bands: ['lowMid', 'mid'], more: 'bring up chords, leads or vocals, or cut less around 300 Hz-1 kHz', less: 'cut 300-800 Hz on pads and keys (the usual mud), or lower the busiest mid-range part' },
  { name: 'highs', bands: ['highMid', 'high'], more: 'brighten hats, leads and the master top (EQ shelf above ~6 kHz), or add air with reverb', less: 'tame hats and bright synths (EQ shelf or low-pass above ~8 kHz) or lower the hats' },
];

export function bandBalance(bands: Partial<Record<string, number>> | undefined): Record<BandKey, number> | null {
  if (!bands) return null;
  const vals = BAND_KEYS.map((k) => bands[k]);
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const total = 10 * Math.log10((vals as number[]).reduce((sum, v) => sum + Math.pow(10, v / 10), 0));
  if (!Number.isFinite(total)) return null;
  return Object.fromEntries(BAND_KEYS.map((k) => [k, round((bands[k] as number) - total, 1)])) as Record<BandKey, number>;
}

function resampleCurve(curve: number[], n: number): number[] | null {
  const v = curve.map((x) => (Number.isFinite(x) ? Math.max(-60, x) : -60));
  if (v.length < 2) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (v.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(v.length - 1, lo + 1);
    out.push(v[lo] + (v[hi] - v[lo]) * (t - lo));
  }
  return out;
}

export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  if (saa < 1e-9 || sbb < 1e-9) return null;
  return round(sab / Math.sqrt(saa * sbb), 2);
}

export interface ReferenceComparison {
  tempo: { project: number; reference: number | null; reading: number | null; diff: number | null };
  key: { project: string | null; projectSource: 'given' | 'notes' | null; reference: string | null; relation: 'same' | 'relative' | 'move' | null; semitones: number | null };
  loudness: { project: number | null; reference: number | null; diff: number | null };
  truePeak: { project: number | null; reference: number | null };
  bands: { project: Record<BandKey, number> | null; reference: Record<BandKey, number> | null; diff: Record<BandKey, number> | null; groups: Record<string, number> | null };
  width: { project: number | null; reference: number | null; diff: number | null };
  energy: { correlation: number | null; projectRange: number | null; referenceRange: number | null; partial: boolean };
  suggestions: string[];
}

function spread(curve: number[]): number | null {
  const v = curve.filter((x) => Number.isFinite(x) && x > -60).sort((x, y) => x - y);
  if (v.length < 3) return null;
  return round(v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)], 1);
}

export function compareAnalyses(proj: Analysis, ref: AudioAnalysis, ctx: { bpm: number; key: string | null; keySource: 'given' | 'notes' | null; renderSec: number }): ReferenceComparison {
  const r1n = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? round(x, 1) : null);
  const s: string[] = [];
  const reading = ref.tempo ? syncBpm(ref.tempo, ctx.bpm) : null;
  const tDiff = reading !== null ? round(ctx.bpm - reading, 1) : null;
  if (tDiff !== null && Math.abs(tDiff) >= 2) s.push(`Tempo: the project runs at ${ctx.bpm} bpm, the reference at about ${reading} bpm. set_tempo ${reading} if you want its feel.`);
  const pk = toKeyRef(ctx.key);
  const rk = ref.key ? toKeyRef({ tonic: ref.key.tonic, mode: ref.key.mode }) : null;
  const shift = pk && rk ? keyShift(pk, rk) : null;
  if (shift?.relation === 'move') s.push(`Key: your notes read ${keyShortName(pk!)}, the reference ${keyShortName(rk!)} (${fmtSemitones(shift.semitones)} away). Transpose (transform_notes) only if you want the same key; a different key is fine for an original.`);
  const pl = r1n(proj.lufsIntegrated);
  const rl = r1n(ref.levels?.lufsIntegrated);
  const lDiff = pl !== null && rl !== null ? round(pl - rl, 1) : null;
  if (lDiff !== null && lDiff <= -2) s.push(`Loudness: ${Math.abs(lDiff)} dB quieter than the reference (${pl} vs ${rl} LUFS). Released songs are mastered: push the master limiter (Krypt Limiter gain, ceiling -1 dB) for a like-for-like A/B, or compare at matched levels.`);
  if (lDiff !== null && lDiff >= 2) s.push(`Loudness: ${lDiff} dB louder than the reference (${pl} vs ${rl} LUFS): ease off the master limiter or the loudest inserts.`);
  const ptp = r1n(proj.truePeakDb);
  if (ptp !== null && ptp > -1) s.push(`True peak ${ptp} dBTP: set the master limiter ceiling to -1 dB.`);
  const pb = bandBalance(proj.bands);
  const rb = bandBalance(ref.levels?.bands);
  let diff: Record<BandKey, number> | null = null;
  let groups: Record<string, number> | null = null;
  if (pb && rb) {
    diff = Object.fromEntries(BAND_KEYS.map((k) => [k, round(pb[k] - rb[k], 1)])) as Record<BandKey, number>;
    groups = Object.fromEntries(BAND_GROUPS.map((g) => [g.name, round(g.bands.reduce((x, k) => x + diff![k], 0) / g.bands.length, 1)]));
    const parts: string[] = [];
    const fixes: string[] = [];
    for (const g of BAND_GROUPS) {
      const d = groups[g.name];
      if (Math.abs(d) < 2) continue;
      parts.push(`your ${g.name} ${d < 0 ? `${Math.abs(Math.round(d))} dB under` : `${Math.round(d)} dB over`} the reference`);
      fixes.push(d < 0 ? g.more : g.less);
    }
    if (parts.length) s.push(`Balance: ${parts.join('; ')} (relative to each track's overall level). To get closer: ${fixes.join('; ')}.`);
    const worst = BAND_KEYS.map((k) => ({ k, d: diff![k] })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
    if (!parts.length && Math.abs(worst.d) >= 3) s.push(`Balance: the ${BAND_WORDS[worst.k]} band is ${Math.abs(worst.d)} dB ${worst.d < 0 ? 'under' : 'over'} the reference.`);
  }
  const pw = typeof proj.stereoWidth === 'number' ? round(proj.stereoWidth, 2) : null;
  const rw = typeof ref.stereo?.width === 'number' ? round(ref.stereo.width, 2) : typeof ref.levels?.stereoWidth === 'number' ? round(ref.levels.stereoWidth, 2) : null;
  const wDiff = pw !== null && rw !== null ? round(pw - rw, 2) : null;
  if (wDiff !== null && wDiff <= -0.1) s.push(`Stereo: narrower than the reference (width ${pw} vs ${rw}): widen pads, leads and effects (stereo separation, chorus, reverb), keep kick and bass in the centre.`);
  if (wDiff !== null && wDiff >= 0.1) s.push(`Stereo: wider than the reference (width ${pw} vs ${rw}): check it in mono; narrow the widest parts a little.`);
  const pc = resampleCurve(proj.energyCurve ?? [], 32);
  const rc = resampleCurve(ref.energy?.lufs ?? [], 32);
  const corr = pc && rc ? correlation(pc, rc) : null;
  const partial = ref.durationSec > 0 && ctx.renderSec < ref.durationSec * 0.5;
  const pRange = spread(proj.energyCurve ?? []);
  const rRange = spread(ref.energy?.lufs ?? []);
  if (partial) s.push(`Energy shape: your render is ${round(ctx.renderSec, 0)} s against a ${round(ref.durationSec, 0)} s reference, so the shape comparison stays rough until your arrangement is about as long as the reference (or compare matching sections with bars).`);
  else if (corr !== null && corr < 0.4) s.push(`Energy shape: the rise and fall over time differs from the reference (correlation ${corr}). Compare the section plan from analyze_audio with your arrangement (where the drops and breaks land).`);
  if (pRange !== null && rRange !== null && rRange - pRange >= 4) s.push(`Dynamics: the reference moves ${rRange} dB between quiet and loud parts, yours ${pRange} dB: make breaks thinner or drops fuller (mute parts, automation).`);
  if (!s.length) s.push('Close to the reference on every measure: trust your ears for the rest.');
  return {
    tempo: { project: ctx.bpm, reference: ref.tempo ? round(ref.tempo.bpm, 1) : null, reading, diff: tDiff },
    key: { project: pk ? keyShortName(pk) : null, projectSource: pk ? ctx.keySource : null, reference: rk ? keyShortName(rk) : ref.key?.name ?? null, relation: shift?.relation ?? null, semitones: shift ? shift.semitones : null },
    loudness: { project: pl, reference: rl, diff: lDiff },
    truePeak: { project: ptp, reference: r1n(ref.levels?.truePeakDb) },
    bands: { project: pb, reference: rb, diff, groups },
    width: { project: pw, reference: rw, diff: wDiff },
    energy: { correlation: corr, projectRange: pRange, referenceRange: rRange, partial },
    suggestions: s,
  };
}

export const compareToReference = defineTool({
  name: 'compare_to_reference',
  title: 'Compare the mix with a reference song',
  kind: 'read',
  description:
    'Render the song (or bars / a pattern) and compare it with a reference track: tempo, key, integrated loudness, true peak, band balance (each band against the reference, relative to each track\'s overall level), stereo width and how the energy curve rises and falls (shape correlation), with plain-language suggestions ("your low end is 4 dB under the reference; your highs 3 dB over"). reference = an audio clip id, an audio channel name (e.g. "Reference: Song") or a local audio file path (the user\'s File access setting applies). Mute the reference\'s track so it isn\'t in your render. Renders up to 160 bars. Example: {"reference":"Reference: Song","scope":"song"}',
  input: z.object({
    reference: z.string().min(1).max(400).describe('Audio clip id, audio channel name/id, or audio file path.'),
    scope: z.enum(['pattern', 'song', 'bars']).optional().describe('What of yours to render. Default: the song in song mode, else the active pattern.'),
    pattern: z.string().optional(),
    bars: z.string().optional().describe('Song bar range "17-32" (inclusive).'),
    key: z.string().max(16).optional().describe('Your key, e.g. "F#m" (default: estimated from your notes).'),
  }),
  summarize: (a) => safeName(a.reference, 40),
  paths: (a) => (looksLikePath(a.reference) ? [{ value: a.reference, kind: 'audio' }] : []),
  async run(deps, caller, a, ctx) {
    if (!deps.analyzer) fail('Audio analysis is not available in this session (the analyzer service did not start; see the Krypt Studio log), so the reference can\'t be read.');
    const p = deps.doc.project;
    const { target, label: refLabel } = resolveTarget(deps, a.reference, true, caller);
    const plan = planRender(deps, a, MAX_COMPARE_BARS, { audibleSong: true });
    const warnings: string[] = [];
    const refClipIds = 'clipId' in target ? [target.clipId] : 'channelId' in target ? Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === target.channelId).map((c) => c.id) : [];
    const audible = refClipIds
      .map((id) => p.playlist.clips[id])
      .filter((c) => c && !c.mute && !p.playlist.tracks[c.trackId]?.mute && !(c.channelId && p.channels[c.channelId]?.mute))
      .filter((c) => plan.scope !== 'pattern' && plan.range && c.start < plan.range.end && c.start + c.length > plan.range.start);
    if (audible.length) warnings.push(`The reference plays in this render (track "${safeName(p.playlist.tracks[audible[0].trackId]?.name)}" isn't muted), so it is partly compared with itself: mute that track and compare again.`);

    const opts = { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'working') : undefined, signal: ctx.signal };
    const refR = await deps.analyzer.analyze(target, opts);
    if (!refR.ok || !refR.data) fail(`Couldn't analyse the reference ${refLabel}: ${refR.message ?? 'analysis failed'}`);
    const ref = refR.data;

    const res = await renderPlan(deps, plan, 1, 'compare');
    if (!res.ok || !res.data) fail(`Render of ${plan.label} failed: ${res.message ?? 'the audio engine returned no result'}.`);
    let mine: Analysis | null = res.data.analysis && !isEmptyAnalysis(res.data.analysis) ? res.data.analysis : null;
    if (!mine) {
      const back = await deps.analyzer.analyze({ path: res.data.path }, opts);
      if (back.ok && back.data?.levels) mine = { ...back.data.levels, energyCurve: back.data.energy?.lufs ?? back.data.levels.energyCurve, stereoWidth: back.data.stereo?.width ?? back.data.levels.stereoWidth };
    }
    if (!mine) fail(`The render of ${plan.label} came back without loudness or spectrum analysis, so there is nothing to compare. Update / rebuild Krypt Studio's engine.`);
    if (mine.lufsIntegrated !== null && mine.lufsIntegrated < -60) fail(`The render of ${plan.label} is silent: nothing of yours plays there yet (muted channels, or no clips in range?).`);

    const keyGiven = a.key?.trim() || null;
    const key = keyGiven ?? plan.symbolic.key.estimated ?? null;
    const renderSec = ticksToSeconds(plan.lengthTicks, p.transport.bpm);
    const c = compareAnalyses(mine, ref, { bpm: p.transport.bpm, key, keySource: keyGiven ? 'given' : key ? 'notes' : null, renderSec });

    const fmt = (x: number | null, unit = '') => (x === null ? '?' : `${x}${unit}`);
    const signed = (x: number | null, unit = ' dB') => (x === null ? '?' : `${x > 0 ? '+' : ''}${x}${unit}`);
    const lines: string[] = [];
    lines.push(`compare   ${plan.label} (${round(renderSec, 1)} s) vs reference ${refLabel} (${round(ref.durationSec, 1)} s)`);
    lines.push(`tempo     ${c.tempo.project} bpm vs ${c.tempo.reading ?? '?'} bpm${c.tempo.reference !== null && c.tempo.reading !== c.tempo.reference ? ` (detected ${c.tempo.reference}, same pulse)` : ''}${c.tempo.diff !== null ? `  → ${signed(c.tempo.diff, ' bpm')}` : ''}`);
    lines.push(`key       ${c.key.project ?? '?'}${c.key.projectSource === 'notes' ? ' (from your notes)' : ''} vs ${c.key.reference ?? '?'}${ref.key ? ` (confidence ${round(ref.key.confidence, 2)})` : ''}${c.key.relation ? `  → ${c.key.relation === 'same' ? 'same key' : c.key.relation === 'relative' ? 'relative major/minor (same notes)' : `${fmtSemitones(c.key.semitones ?? 0)} apart`}` : ''}`);
    lines.push(`loudness  ${fmt(c.loudness.project, ' LUFS')} vs ${fmt(c.loudness.reference, ' LUFS')}  → ${signed(c.loudness.diff)}; true peak ${fmt(c.truePeak.project, ' dBTP')} vs ${fmt(c.truePeak.reference, ' dBTP')}`);
    if (c.bands.diff) lines.push(`balance   ${BAND_KEYS.map((k) => `${k} ${signed(c.bands.diff![k], '')}`).join(' | ')} dB vs the reference (each band relative to its track's overall level)`);
    else lines.push('balance   (band levels unavailable for one of the two)');
    lines.push(`stereo    width ${fmt(c.width.project)} vs ${fmt(c.width.reference)}${c.width.diff !== null ? `  → ${signed(c.width.diff, '')}` : ''}`);
    lines.push(`energy    shape correlation ${c.energy.correlation ?? '?'} (1 = the same rise and fall)${c.energy.partial ? ', partial render' : ''}; quiet-to-loud range ${fmt(c.energy.projectRange, ' dB')} vs ${fmt(c.energy.referenceRange, ' dB')}`);
    lines.push('Suggestions:', ...c.suggestions.map((x) => `- ${x}`));
    lines.push('Match the feel, not the song: keep your melody, chords and hook your own (check_originality).');
    return {
      ok: true,
      message: `Compared ${plan.label} with ${refLabel}: ${c.loudness.diff !== null ? `${signed(c.loudness.diff)} loudness` : 'loudness n/a'}${c.bands.groups ? `, low end ${signed(c.bands.groups['low end'])}, highs ${signed(c.bands.groups.highs)}` : ''}; ${plural(c.suggestions.length, 'suggestion')}.`,
      changed: [],
      text: lines.join('\n'),
      warnings: warnings.length ? warnings : undefined,
      data: { render: { file: res.data.path, scope: plan.scope, seconds: round(renderSec, 1) }, reference: { label: refLabel, durationSec: round(ref.durationSec, 1) }, ...c },
    };
  },
});

async function transport(deps: MainDeps, action: 'play' | 'stop'): Promise<{ ok: boolean; message?: string }> {
  const st = deps.engine.status();
  if (st.state !== 'running') return { ok: false, message: `the audio engine is ${st.state}${st.message ? ` (${st.message})` : ''}` };
  return deps.engine.request({ cmd: 'transport', action });
}

export const play = defineTool({
  name: 'play',
  title: 'Play',
  kind: 'transport',
  description: 'Start playback for the user to listen (you cannot hear it — use render_preview for analysis). Optional: mode "pattern" | "song", which pattern to loop, and from_bar.',
  input: z.object({ mode: z.enum(['pattern', 'song']).optional(), pattern: z.string().optional(), from_bar: z.union([z.number(), z.string()]).optional() }),
  summarize: (a) => [a.mode, a.pattern && safeName(a.pattern, 20), a.from_bar && `from ${a.from_bar}`].filter(Boolean).join(' '),
  async run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    if (a.pattern) {
      const pat = findPattern(p, a.pattern);
      if (p.transport.activePatternId !== pat.id) ctx.exec('patterns.select', { id: pat.id });
      if (!a.mode && p.transport.mode !== 'pattern') ctx.exec('transport.setMode', { mode: 'pattern' });
    }
    if (a.mode && deps.doc.project.transport.mode !== a.mode) ctx.exec('transport.setMode', { mode: a.mode });
    if (a.from_bar !== undefined) {
      const tick = parsePosition(a.from_bar, p.transport.timeSig);
      const r = await deps.engine.request({ cmd: 'locate', tick });
      if (!r.ok) fail(`Couldn't move the playhead: ${r.message ?? 'engine error'}`);
    }
    const r = await transport(deps, 'play');
    if (!r.ok) fail(`Couldn't start playback: ${r.message ?? 'engine error'}`);
    const t = deps.doc.project.transport;
    const what = t.mode === 'song' ? 'the song' : `pattern "${safeName(p.patterns[t.activePatternId ?? '']?.name ?? '?')}"`;
    return { ok: true, message: `Playing ${what}${a.from_bar !== undefined ? ` from bar ${a.from_bar}` : ''}.`, changed: [] };
  },
});

export const stop = defineTool({
  name: 'stop',
  title: 'Stop',
  kind: 'transport',
  description: 'Stop playback (the transport, whether it is looping a pattern or playing the song).',
  input: z.object({}),
  async run(deps) {
    const r = await transport(deps, 'stop');
    if (!r.ok) fail(`Couldn't stop: ${r.message ?? 'engine error'}`);
    return { ok: true, message: 'Stopped.', changed: [] };
  },
});

export const HEARING_TOOLS = [renderPreview, compareToReference];
export const TRANSPORT_TOOLS = [play, stop];
