// ──────────────────────────────────────────────────────────────────────
// Reference library (Wave 3B) renderer logic with no React and no window
// access, so it is unit-tested in test/library-ui.test.ts: track filters →
// TrackQuery, the windowed table (visible rows, pages to fetch), labels
// for statuses / queue / estimates, and the numbers behind the style
// profile charts (tempo histogram, drum heatmap, bass degrees, energy).
// ──────────────────────────────────────────────────────────────────────

import type { DrumRole } from '@shared/analyzer/protocol';
import type { Collection, LibraryQueueState, Percentiles, StyleProfile, TrackQuery, TrackStatus } from '@shared/library/types';
import { AUDIO_FILE_RE } from '@shared/audio/formats';

// ── Numbers ───────────────────────────────────────────────────────────

/** 1500 → "1,500" (fixed locale so labels and tests agree). */
export function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${fmtCount(n)} ${n === 1 ? word : many}`;
}

/** 0.423 → "42%". */
export function fmtPct(f: number, digits = 0): string {
  if (!Number.isFinite(f)) return '–';
  return `${(Math.max(0, Math.min(1, f)) * 100).toFixed(digits)}%`;
}

/** Whole BPM stays whole, else one decimal; missing → "–". */
export function fmtBpmCell(bpm: number | null | undefined): string {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm) || bpm <= 0) return '–';
  return Math.abs(bpm - Math.round(bpm)) < 0.05 ? String(Math.round(bpm)) : bpm.toFixed(1);
}

/** -8.43 → "-8.4"; missing → "–". */
export function fmtLufs(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(1);
}

/** Track length "3:25" / "1:02:03"; missing → "–". */
export function fmtTrackLength(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return '–';
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Rough human duration for estimates: "45 s", "12 min", "3 h 20 min", "2 days 4 h". */
export function fmtLongDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0 s';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} days ${hh} h` : `${d} days`;
}

/** Queue ETA: "about 14 min left", "under a minute left"; unknown → ''. */
export function fmtEta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return 'under a minute left';
  return `about ${fmtLongDuration(sec)} left`;
}

/** Compact ETA for the status bar: "14m", "3h 20m", "<1m". */
export function fmtEtaShort(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return '<1m';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

/** "5m ago" style age of a timestamp (ms). */
export function fmtAgo(t: number, now = Date.now()): string {
  if (!Number.isFinite(t) || t <= 0) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(t).toLocaleDateString();
}

/** File name (with extension) of a Windows or POSIX path. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// ── Keys ──────────────────────────────────────────────────────────────

// Spelled like the analyzer (engine/crates/analyzer key.rs): key-signature friendly.
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** "F#m" → "F# min", "Eb" → "Eb maj"; missing → "–". */
export function fmtKeyShort(key: string | null | undefined): string {
  if (!key) return '–';
  const m = /^([A-G][#b]?)(m?)$/.exec(key.trim());
  if (!m) return key;
  return `${m[1]} ${m[2] ? 'min' : 'maj'}`;
}

/** "F#m" → "F# minor". */
export function fmtKeyLong(key: string | null | undefined): string {
  if (!key) return 'Unknown';
  const m = /^([A-G][#b]?)(m?)$/.exec(key.trim());
  if (!m) return key;
  return `${m[1]} ${m[2] ? 'minor' : 'major'}`;
}

/** Key filter choices: any / a mode / one of the 24 keys (TrackQuery.key). */
export function keyFilterOptions(): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [
    { value: '', label: 'Any key' },
    { value: 'minor', label: 'Minor keys' },
    { value: 'major', label: 'Major keys' },
  ];
  for (let pc = 0; pc < 12; pc++) {
    out.push({ value: MAJOR_NAMES[pc], label: `${MAJOR_NAMES[pc]} major` });
    out.push({ value: `${MINOR_NAMES[pc]}m`, label: `${MINOR_NAMES[pc]} minor` });
  }
  return out;
}

// ── Track statuses ────────────────────────────────────────────────────

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'gradient';

export const STATUS_ORDER: TrackStatus[] = ['pending', 'light', 'deep', 'failed', 'missing'];

export function statusInfo(status: TrackStatus, error?: string): { label: string; tone: Tone; hint: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', tone: 'neutral', hint: 'Waiting in the analysis queue' };
    case 'light':
      return { label: 'Analysed', tone: 'success', hint: 'Light pass done: tempo, key, beats, sections, loudness, drums and chords' };
    case 'deep':
      return { label: 'Deep', tone: 'gradient', hint: 'Deep pass done too: stems separated and bass / melody lines transcribed' };
    case 'failed':
      return { label: 'Failed', tone: 'danger', hint: error ? `Analysis failed: ${error}` : 'Analysis failed. Retry from the queue header.' };
    case 'missing':
      return {
        label: 'Missing',
        tone: 'warn',
        hint: error || 'The file is gone or changed since it was analysed. It is re-queued when it comes back (Rescan).',
      };
    default:
      return { label: String(status), tone: 'neutral', hint: '' };
  }
}

/** Status filter choices. */
export function statusFilterOptions(): Array<{ value: TrackStatus | ''; label: string }> {
  return [
    { value: '', label: 'Any status' },
    { value: 'pending', label: 'Queued' },
    { value: 'light', label: 'Analysed' },
    { value: 'deep', label: 'Deep' },
    { value: 'failed', label: 'Failed' },
    { value: 'missing', label: 'Missing' },
  ];
}

// ── Collections + queue ───────────────────────────────────────────────

/** Tracks with at least the light pass. */
export function analysedCount(c: Pick<Collection, 'counts'>): number {
  return c.counts.light + c.counts.deep;
}

/** Share of a collection that is analysed (0..1; empty → 0). */
export function collectionProgress(c: Pick<Collection, 'counts'>): number {
  const usable = c.counts.total - c.counts.missing;
  return usable > 0 ? Math.min(1, analysedCount(c) / usable) : 0;
}

/** "1,500 tracks · 1,188 analysed · 12 failed". */
export function collectionStatusLine(c: Pick<Collection, 'counts' | 'deep'>): string {
  const k = c.counts;
  if (!k.total) return 'Empty: add a folder or drop files here';
  const parts = [plural(k.total, 'track')];
  const done = analysedCount(c);
  if (done < k.total) parts.push(`${fmtCount(done)} analysed`);
  else parts.push('all analysed');
  if (k.deep) parts.push(`${fmtCount(k.deep)} deep`);
  if (k.failed) parts.push(`${fmtCount(k.failed)} failed`);
  if (k.missing) parts.push(`${fmtCount(k.missing)} missing`);
  return parts.join(' · ');
}

export function libraryTotals(collections: Collection[]): Collection['counts'] {
  const t = { total: 0, pending: 0, light: 0, deep: 0, failed: 0, missing: 0 };
  for (const c of collections) for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += c.counts[k] ?? 0;
  return t;
}

/** Is there queue work worth showing (running, or paused with tracks left)? */
export function queueActive(q: LibraryQueueState | null | undefined): boolean {
  return !!q && (q.running || (q.paused && q.total > q.done));
}

export function queueFraction(q: LibraryQueueState): number {
  return q.total > 0 ? Math.max(0, Math.min(1, q.done / q.total)) : -1;
}

/** Headline for the queue header / status bar. */
export function queueHeadline(q: LibraryQueueState): string {
  const pass = q.phase === 'deep' ? 'deep pass' : 'light pass';
  if (q.paused && q.total > q.done) return `Paused at ${fmtCount(q.done)} of ${fmtCount(q.total)}`;
  if (q.running) return `Analysing ${fmtCount(Math.min(q.total, q.done + 1))} of ${fmtCount(q.total)} · ${pass}`;
  if (q.total > 0 && q.done >= q.total) return `All ${fmtCount(q.total)} queued tracks analysed`;
  return 'Queue idle';
}

/** Estimate sentence for the deep-analysis confirm. */
export function deepEstimateText(e: { tracks: number; seconds: number; device: string }): string {
  const where = e.device === 'directml' ? 'on the GPU (DirectML)' : 'on the CPU';
  if (!e.tracks) return 'Every track in this collection is already deep-analysed.';
  return `${plural(e.tracks, 'track')} · about ${fmtLongDuration(e.seconds)} ${where}`;
}

/** "Added 40 tracks (3 skipped: already in the library or not audio)". */
export function addResultSentence(r: { added: number; skipped: number }, collection: string): string {
  if (!r.added && !r.skipped) return `No audio files found for ${collection}`;
  if (!r.added) return `Nothing new for ${collection}: ${plural(r.skipped, 'file')} skipped (already in the library or not audio)`;
  return `Added ${plural(r.added, 'track')} to ${collection}${r.skipped ? ` (${fmtCount(r.skipped)} skipped)` : ''}. They are queued for analysis.`;
}

export function rescanSentence(r: { added: number; changed: number; missing: number }, collection: string): string {
  if (!r.added && !r.changed && !r.missing) return `${collection} is up to date`;
  const parts: string[] = [];
  if (r.added) parts.push(`${fmtCount(r.added)} new`);
  if (r.changed) parts.push(`${fmtCount(r.changed)} changed`);
  if (r.missing) parts.push(`${fmtCount(r.missing)} missing`);
  return `Rescanned ${collection}: ${parts.join(', ')}`;
}

/** "dark, trap , Dark" → ["dark", "trap"] (trimmed, case-insensitive dedupe, ≤ 12 tags of ≤ 32 chars). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,;\n]/)) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 12) break;
  }
  return out;
}

// ── Drops from Explorer ───────────────────────────────────────────────

export const LIBRARY_AUDIO_EXT = AUDIO_FILE_RE;

/** Common non-audio files people drag along (a folder named "Vol.2" must still count as a folder). */
const OTHER_FILE_EXT = /\.(kstudio|mid|midi|txt|md|pdf|nfo|cue|log|m3u8?|pls|json|xml|ini|db|jpe?g|png|gif|webp|bmp|zip|rar|7z|exe|lnk|url|docx?|xlsx?|mp4|mov|mkv|avi|webm|flp|als|ptx|rpp|logicx)$/i;

/**
 * Split dropped paths: audio files are added as files; known non-audio
 * files are ignored with a note; anything else is treated as a folder
 * (main checks it and reports when it isn't one).
 */
export function classifyDrop(paths: string[]): { files: string[]; folders: string[]; ignored: string[] } {
  const files: string[] = [];
  const folders: string[] = [];
  const ignored: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const name = baseName(p);
    if (LIBRARY_AUDIO_EXT.test(name)) files.push(p);
    else if (OTHER_FILE_EXT.test(name)) ignored.push(p);
    else folders.push(p);
  }
  return { files, folders, ignored };
}

// ── Track table: filters, query, windowing ────────────────────────────

export type SortKey = NonNullable<TrackQuery['sort']>;

export interface TrackFilters {
  text: string;
  bpmMin: number | null;
  bpmMax: number | null;
  /** '' = any, 'minor' / 'major', or an exact key ("F#m"). */
  key: string;
  status: TrackStatus | '';
}

export const EMPTY_FILTERS: TrackFilters = { text: '', bpmMin: null, bpmMax: null, key: '', status: '' };

export function filtersActive(f: TrackFilters): boolean {
  return !!f.text.trim() || f.bpmMin !== null || f.bpmMax !== null || !!f.key || !!f.status;
}

const BPM_LO = 20;
const BPM_HI = 400;

/** Filters + sort → TrackQuery (blank fields dropped, BPM range clamped and ordered). */
export function buildQuery(collectionId: string | null, f: TrackFilters, sort: { key: SortKey; desc: boolean }, offset = 0, limit = PAGE_SIZE): TrackQuery {
  const q: TrackQuery = { sort: sort.key, desc: sort.desc, offset: Math.max(0, Math.floor(offset)), limit: Math.max(1, Math.min(1000, Math.floor(limit))) };
  if (collectionId) q.collectionId = collectionId;
  const text = f.text.trim();
  if (text) q.text = text;
  let lo = f.bpmMin !== null && Number.isFinite(f.bpmMin) ? Math.max(BPM_LO, Math.min(BPM_HI, f.bpmMin)) : null;
  let hi = f.bpmMax !== null && Number.isFinite(f.bpmMax) ? Math.max(BPM_LO, Math.min(BPM_HI, f.bpmMax)) : null;
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  if (lo !== null) q.bpmMin = lo;
  if (hi !== null) q.bpmMax = hi;
  if (f.key) q.key = f.key;
  if (f.status) q.status = f.status;
  return q;
}

/** Stable identity of a query without its paging (cache key for loaded pages). */
export function queryKey(q: TrackQuery): string {
  const { offset: _o, limit: _l, ...rest } = q;
  void _o;
  void _l;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** Clicking a column header: the same column flips direction; another column starts ascending (like Explorer). */
export function nextSort(cur: { key: SortKey; desc: boolean }, key: SortKey): { key: SortKey; desc: boolean } {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: false };
}

export const PAGE_SIZE = 200;

/**
 * Rows to render for a scroll position: [first, last) with overscan,
 * clamped to [0, total). A stale offset past the end (the list just
 * shrank) shows the last rows instead of nothing.
 */
export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 8): { first: number; last: number } {
  if (total <= 0 || rowH <= 0) return { first: 0, last: 0 };
  const vh = Math.max(0, viewportH);
  const top = Math.max(0, Math.min(Number.isFinite(scrollTop) ? scrollTop : 0, total * rowH - vh));
  const first = Math.max(0, Math.floor(top / rowH) - overscan);
  const last = Math.min(total, Math.ceil((top + vh) / rowH) + overscan);
  return { first, last: Math.max(first, last) };
}

/** Page indexes covering rows [first, last). */
export function pagesFor(first: number, last: number, pageSize = PAGE_SIZE): number[] {
  if (last <= first || pageSize <= 0) return [];
  const out: number[] = [];
  for (let p = Math.floor(first / pageSize); p <= Math.floor((last - 1) / pageSize); p++) out.push(p);
  return out;
}

/** Shift-click range selection over the rows loaded so far (ids in display order). */
export function rangeSelect(order: Array<string | undefined>, anchor: string | null, target: string): string[] {
  const b = order.indexOf(target);
  const a = anchor ? order.indexOf(anchor) : -1;
  if (a < 0 || b < 0) return [target];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return order.slice(lo, hi + 1).filter((x): x is string => !!x);
}

// ── Style profile ─────────────────────────────────────────────────────

export interface HistBar {
  bpm: number;
  count: number;
  /** count / max count (0..1), for bar height. */
  frac: number;
  /** count / total (0..1), for labels. */
  share: number;
}

/** The 4-BPM histogram with empty bins filled in between the first and last used bin. */
export function histogramBars(hist: Array<{ bpm: number; count: number }>, binWidth = 4): HistBar[] {
  const used = hist.filter((h) => Number.isFinite(h.bpm) && h.count > 0).sort((a, b) => a.bpm - b.bpm);
  if (!used.length) return [];
  const byBin = new Map<number, number>();
  for (const h of used) byBin.set(Math.round(h.bpm), (byBin.get(Math.round(h.bpm)) ?? 0) + h.count);
  const lo = Math.round(used[0].bpm);
  const hi = Math.round(used[used.length - 1].bpm);
  const max = Math.max(...byBin.values());
  const total = [...byBin.values()].reduce((a, b) => a + b, 0) || 1;
  const out: HistBar[] = [];
  // Bins are binWidth apart; guard against odd inputs with a cap.
  for (let b = lo, n = 0; b <= hi && n < 200; b += binWidth, n++) {
    const count = byBin.get(b) ?? 0;
    out.push({ bpm: b, count, frac: count / max, share: count / total });
  }
  return out;
}

/** Where a BPM value sits across the histogram (0..1, clamped), for the median marker. */
export function histPosition(bars: HistBar[], bpm: number, binWidth = 4): number {
  if (!bars.length || !Number.isFinite(bpm)) return 0;
  const lo = bars[0].bpm;
  const hi = bars[bars.length - 1].bpm + binWidth;
  return Math.max(0, Math.min(1, (bpm - lo) / (hi - lo || 1)));
}

export const DRUM_ROLES: DrumRole[] = ['kick', 'snare', 'hat', 'openhat', 'perc'];

export const ROLE_LABEL: Record<DrumRole, string> = {
  kick: 'Kick',
  snare: 'Snare / clap',
  hat: 'Hat',
  openhat: 'Open hat',
  perc: 'Perc',
};

/**
 * Heatmap cell opacity for a hit probability. A gentle gamma lifts rare
 * hits (5–20%) off the background so ghost notes stay visible; 0 stays 0
 * and 1 stays 1 (monotonic).
 */
export function heatAlpha(prob: number): number {
  if (!Number.isFinite(prob) || prob <= 0) return 0;
  return Math.min(1, Math.pow(Math.min(1, prob), 0.6));
}

/** Grid line kind before a step on the 32-step bar (4/4: a beat is 8 steps). */
export function stepLine(step: number): 'bar' | 'beat' | 'eighth' | 'sixteenth' | 'none' {
  if (step % 32 === 0) return 'bar';
  if (step % 8 === 0) return 'beat';
  if (step % 4 === 0) return 'eighth';
  if (step % 2 === 0) return 'sixteenth';
  return 'none';
}

/** "Beat 2 · on the beat" / "Beat 3 · 2nd 16th" / "Beat 1 · 32nd" for a 0-based step. */
export function stepPosition(step: number): string {
  const s = ((Math.floor(step) % 32) + 32) % 32;
  const beat = Math.floor(s / 8) + 1;
  const sub = s % 8;
  const where = sub === 0 ? 'on the beat' : sub === 4 ? 'the "and"' : sub % 2 === 0 ? `${sub / 2 + 1}${['st', 'nd', 'rd', 'th'][Math.min(3, sub / 2)]} 16th` : 'a 32nd';
  return `Beat ${beat} · ${where}`;
}

/** Semitones from the key root, flat-spelled scale degrees. */
export const DEGREE_LABELS = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];

/** Bass degree shares → bars (height relative to the most common degree). */
export function degreeBars(degrees: number[]): Array<{ label: string; share: number; frac: number }> {
  const v = Array.from({ length: 12 }, (_, i) => (Number.isFinite(degrees[i]) ? Math.max(0, degrees[i]) : 0));
  const max = Math.max(...v) || 1;
  return v.map((share, i) => ({ label: DEGREE_LABELS[i], share, frac: share / max }));
}

/** ["i","VI","III","VII"] → "i – VI – III – VII". */
export function romanText(degrees: string[]): string {
  return degrees.join(' – ');
}

/** Percentile band as text: "130–150" (p10–p90) with a formatter. */
export function rangeText(p: Percentiles, fmt: (v: number) => string = (v) => String(Math.round(v))): string {
  const a = fmt(p.p10);
  const b = fmt(p.p90);
  return a === b ? a : `${a}–${b}`;
}

/** SVG path for a 0..1 series in a w×h box (top = 1). '' when < 2 points. */
export function shapePath(values: number[], w: number, h: number, pad = 2): string {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2 || w <= 0 || h <= 0) return '';
  return (
    'M' +
    v
      .map((x, i) => {
        const px = (i / (v.length - 1)) * w;
        const py = pad + (1 - Math.max(0, Math.min(1, x))) * (h - 2 * pad);
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      })
      .join(' L')
  );
}

export const BAND_ORDER: Array<keyof NonNullable<StyleProfile['mix']>['bands']> = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'];

export const BAND_LABEL: Record<(typeof BAND_ORDER)[number], string> = {
  sub: 'Sub',
  low: 'Low',
  lowMid: 'Low mid',
  mid: 'Mid',
  highMid: 'High mid',
  high: 'High',
};

/** Band balance (dB below the loudest band, ≤ 0) → bar fractions over a `floorDb` range. */
export function bandBars(bands: NonNullable<StyleProfile['mix']>['bands'], floorDb = -30): Array<{ key: string; label: string; db: number; frac: number }> {
  return BAND_ORDER.map((k) => {
    const db = Number.isFinite(bands[k]) ? bands[k] : floorDb;
    return { key: k, label: BAND_LABEL[k], db, frac: Math.max(0, Math.min(1, 1 - Math.min(0, db) / floorDb)) };
  });
}

/** What the profile can't say yet, beyond its own caveats (UI empty states). */
export function profileGaps(p: StyleProfile): { empty: boolean; needsDeep: boolean } {
  return { empty: p.analysed === 0, needsDeep: !p.bass && p.deep === 0 };
}

/** Similarity score (0..1) → "92% similar". */
export function similarityText(score: number): string {
  return `${fmtPct(score)} similar`;
}

/** Seconds into a reference → "1:23". */
export function fmtRefTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
