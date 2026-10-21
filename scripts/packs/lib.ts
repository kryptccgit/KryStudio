// Shared pieces of the sound-pack manifest tool (scripts/packs/build.ts): the pack-spec shapes (instrument packs with
// our SFZ mappings, and Wave 7b sample packs of one-shots / loops / FX), an SFZ writer that only emits the opcodes
// krypt.multisampler supports (shared/packs/types.ts SFZ_OPCODES), and the RAM estimate. Pure: no I/O here.

import { SFZ_OPCODES } from '@shared/packs/types';
import type { SampleKind } from '@shared/sounds/types';
import type { GenreId } from '@shared/sounds/genres';

/** Facts measured from a downloaded file (headers only for FLAC; WAV is also scanned for peak and pitch). */
export interface AudioFacts {
  format: 'wav' | 'flac';
  rate: number;
  channels: number;
  bits: number;
  frames: number;
  /** WAV only: sample peak in dBFS. */
  peakDb?: number;
  /** WAV only: a YIN pitch estimate (fractional MIDI note), null when unpitched. */
  midi?: number | null;
  /** WAV only: first frame within 40 dB of the peak, less 2 ms (where `offset=` can start). */
  onset?: number;
}

/** One upstream file the mappings use. */
export interface SampleRef {
  /** Path in the upstream repository at the pinned revision (not URL-encoded). */
  src: string;
  /** Path inside the pack dir (safe characters only: A-Z a-z 0-9 . _ - and '/'). */
  path: string;
}

export type Opcodes = Record<string, string | number>;

export interface SfzGroup {
  comment?: string;
  opcodes: Opcodes;
  regions: Opcodes[];
}

export interface SfzDoc {
  /** One-line description written as the file's first comment. */
  title: string;
  control?: Opcodes;
  global?: Opcodes;
  groups: SfzGroup[];
}

export interface InstrumentSpec {
  /** Path of the .sfz inside the pack dir (pack root, e.g. 'grand.sfz'). */
  path: string;
  /** Keys the mapping is meant to cover with no holes: an inclusive range or an explicit key list. */
  keys: { lo: number; hi: number } | number[];
  /** Builds the mapping once every sample's facts are known. */
  build(ctx: BuildCtx): SfzDoc;
}

export interface BuildCtx {
  facts(packPath: string): AudioFacts;
  /** Frames for `seconds` of a sample, capped at its length (the `end=` value: last frame index). */
  endFor(packPath: string, seconds: number): number;
}

export interface PackSpec {
  id: string;
  /** Upstream base URL ending in '/', e.g. https://raw.githubusercontent.com/<org>/<repo>/<sha>/ */
  base: string;
  /** Mirror bases with byte-identical files, tried in order. */
  mirrors: string[];
  samples: SampleRef[];
  instruments: InstrumentSpec[];
}

// ── Sample packs (Wave 7b, research/14 §2.2) ──────────────────────────

/** A commit-pinned GitHub repository: each sample is its own download (raw URL + byte-identical mirrors). */
export interface GithubSource {
  type: 'github';
  /** https://raw.githubusercontent.com/<org>/<repo>/<40-hex sha>/ */
  base: string;
  /** e.g. https://cdn.jsdelivr.net/gh/<org>/<repo>@<sha>/ */
  mirrors: string[];
}

/** One file at a stable direct URL on the source's own site (e.g. opengameart.org/sites/default/files/…). */
export interface UrlSource {
  type: 'url';
  url: string;
  mirrors?: string[];
}

/** A ZIP the source only publishes whole: downloaded once, only the listed members are extracted at install. */
export interface ZipSource {
  type: 'zip';
  url: string;
  mirrors?: string[];
  /** Where the archive is downloaded inside the pack dir (deleted after extraction), e.g. 'downloads/kenney-impact.zip'. */
  path: string;
}

export type SampleSource = GithubSource | UrlSource | ZipSource;

/** One sample of a sample pack, in our own words. */
export interface SampleDef {
  /** Key of the pack spec's `sources`. */
  from: string;
  /** github: the path in the repository (not URL-encoded); zip: the entry name exactly as stored; url: omitted. */
  src?: string;
  /** Path inside the pack dir (safe characters only). Defaults to '<folder>/<slug of name>.<ext>'. */
  path: string;
  name: string;
  kind: SampleKind;
  tags: string[];
  genres: GenreId[];
  rootNote?: number;
  /** Tempo-exact loops only. */
  bpm?: number;
  bars?: number;
  credit?: string;
}

export interface SamplePackSpec {
  id: string;
  type: 'samples';
  sources: Record<string, SampleSource>;
  samples: SampleDef[];
}

export type AnySpec = PackSpec | SamplePackSpec;

export const isSamplePack = (s: AnySpec): s is SamplePackSpec => (s as SamplePackSpec).type === 'samples';

/** "Rain On Window 2" → 'rain-on-window-2'. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extension (lower case, with the dot) of an upstream path or URL. */
export function extOf(p: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(decodeURIComponent(p.split('?')[0]));
  if (!m) throw new Error(`no file extension in ${p}`);
  return `.${m[1].toLowerCase()}`;
}

/** Shorthand for sample specs: a sample whose pack path is '<folder>/<slug(name)><ext of src>'. */
export function sample(
  folder: string,
  from: string,
  src: string | undefined,
  name: string,
  kind: SampleKind,
  tags: string[],
  genres: GenreId[],
  extra: Partial<Pick<SampleDef, 'rootNote' | 'bpm' | 'bars' | 'credit'>> & { ext?: string } = {},
): SampleDef {
  const { ext, ...rest } = extra;
  return { from, src, path: `${folder}/${slug(name)}${ext ?? extOf(src ?? '')}`, name, kind, tags, genres, ...rest };
}

const ALLOWED = new Set<string>(SFZ_OPCODES);
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertSafePath(p: string): void {
  if (!SAFE_PATH.test(p) || p.split('/').some((s) => s === '..' || s === '.')) throw new Error(`unsafe pack path "${p}"`);
}

/** URL of an upstream path under a base (each segment percent-encoded: '#', ' ', ',' …). */
export function urlFor(base: string, src: string): string {
  return base + src.split('/').map(encodeURIComponent).join('/');
}

function fmt(v: string | number): string {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) throw new Error(`non-finite opcode value ${v}`);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

function line(o: Opcodes): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (!ALLOWED.has(k)) throw new Error(`opcode "${k}" is not in SFZ_OPCODES`);
    const s = fmt(v);
    if (/[\r\n]/.test(s) || (k !== 'sample' && /\s/.test(s))) throw new Error(`bad value for ${k}: "${s}"`);
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

/** SFZ text: header comment, <control>, <global>, then <group> blocks with one <region> per line. */
export function renderSfz(doc: SfzDoc): string {
  const out: string[] = [`// ${doc.title}`];
  if (doc.control && Object.keys(doc.control).length) out.push('<control>', line(doc.control));
  if (doc.global && Object.keys(doc.global).length) out.push('<global>', line(doc.global));
  for (const g of doc.groups) {
    out.push('');
    if (g.comment) out.push(`// ${g.comment}`);
    out.push(Object.keys(g.opcodes).length ? `<group> ${line(g.opcodes)}` : '<group>');
    for (const r of g.regions) {
      if (r.sample === undefined) throw new Error('region without sample');
      out.push(`<region> ${line(r)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** Every sample path a mapping references (default_path applied). */
export function samplesOf(doc: SfzDoc): string[] {
  const dp = String(doc.control?.default_path ?? '');
  const out = new Set<string>();
  for (const g of doc.groups) for (const r of g.regions) out.add(dp + String(r.sample ?? g.opcodes.sample));
  return [...out];
}

/**
 * RAM the engine needs for a mapping: every distinct (sample, offset, end) decoded as 16-bit stereo at the file's
 * own rate (research/12 §2). Returned in MB (10^6 bytes).
 */
export function ramMb(doc: SfzDoc, facts: (p: string) => AudioFacts): number {
  const dp = String(doc.control?.default_path ?? '');
  const seen = new Map<string, number>();
  for (const g of doc.groups) {
    for (const r of g.regions) {
      const merged = { ...doc.global, ...g.opcodes, ...r };
      const p = dp + String(merged.sample);
      const f = facts(p);
      const offset = Number(merged.offset ?? 0);
      const end = merged.end !== undefined ? Number(merged.end) : f.frames - 1;
      const frames = Math.max(0, Math.min(end, f.frames - 1) - offset + 1);
      seen.set(`${p}|${offset}|${end}`, frames * 2 * 2);
    }
  }
  let bytes = 0;
  for (const b of seen.values()) bytes += b;
  return bytes / 1e6;
}

/** MIDI note number of a note name in scientific pitch (C4 = 60): 'A0' → 21, 'D#1' → 27, 'Bb2' → 46. */
export function noteNumber(name: string, c4 = 60): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad note name ${name}`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'] ?? 0;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return c4 + (Number(m[3]) - 4) * 12 + base + acc;
}

/** Splits keys between sorted sample roots: each root owns the keys nearest to it (ties go to the lower root), within [lo, hi]. */
export function keySplits(roots: number[], lo: number, hi: number): { root: number; lokey: number; hikey: number }[] {
  const r = [...roots].sort((a, b) => a - b);
  return r.map((root, i) => {
    const lokey = i === 0 ? lo : Math.floor((r[i - 1] + root) / 2) + 1;
    const hikey = i === r.length - 1 ? hi : Math.floor((root + r[i + 1]) / 2);
    return { root, lokey, hikey };
  });
}

/** dB → a rounded SFZ volume value. */
export const db = (v: number): number => Math.round(v * 10) / 10;

// ── Melodic multisamples ──────────────────────────────────────────────

/** One sampled note of a melodic instrument. */
export interface Zone {
  /** Path relative to the .sfz's default_path ('samples/'), e.g. 'vibes/Vibes_soft_F2_v1_rr1_Main.wav'. */
  sample: string;
  /** MIDI note the file sounds at. */
  root: number;
  /** Velocity layer index (0 = softest). */
  layer: number;
  /** Cents to add so the note is in tune. */
  tune?: number;
}

export interface LayerSpec {
  lovel: number;
  hivel: number;
  /** Equal-power velocity crossfades (the engine's xfin/xfout). */
  xfin?: [number, number];
  xfout?: [number, number];
  /** Peak level (dBFS) every file of the layer is normalised to (WAV only; FLAC keeps its recorded level). */
  peakDb?: number;
}

export interface MelodicOpts {
  /** Keys the instrument covers (the outermost samples stretch to reach them). */
  lo: number;
  hi: number;
  layers: LayerSpec[];
  /** Seconds kept per root (trim with a fade before the cut), or undefined to keep whole files. */
  keep?: (root: number) => number;
  fade?: number;
  /** Skip leading silence (WAV onset) when it is longer than this many ms. */
  skipSilenceMs?: number;
  /** Extra opcodes for every region (e.g. an envelope). */
  extra?: Opcodes;
  /** A layer missing a root borrows the nearest other layer's file for it (default true). */
  fillLayers?: boolean;
}

/**
 * Regions for a melodic instrument: per velocity layer, every root owns the keys nearest to it; several files of
 * one root + layer become round robins; WAV files are peak-normalised per layer; long files are trimmed with a fade.
 */
export function melodic(ctx: BuildCtx, zones: Zone[], o: MelodicOpts, dir = 'samples/'): Opcodes[] {
  const out: Opcodes[] = [];
  const allRoots = [...new Set(zones.map((z) => z.root))].sort((a, b) => a - b);
  o.layers.forEach((L, li) => {
    // zones of this layer, by root (filling roots another layer has, from the nearest layer)
    const byRoot = new Map<number, Zone[]>();
    for (const root of allRoots) {
      let pick = zones.filter((z) => z.layer === li && z.root === root);
      if (!pick.length && o.fillLayers !== false) {
        for (let d = 1; d < o.layers.length && !pick.length; d++) {
          for (const l of [li - d, li + d]) {
            if (!pick.length) pick = zones.filter((z) => z.layer === l && z.root === root);
          }
        }
      }
      if (pick.length) byRoot.set(root, pick);
    }
    // roots outside [lo, hi] lose their keys to the in-range neighbours (and are not mapped at all)
    const splits = keySplits([...byRoot.keys()], o.lo, o.hi)
      .map((s) => ({ ...s, lokey: Math.max(s.lokey, o.lo), hikey: Math.min(s.hikey, o.hi) }))
      .filter((s) => s.lokey <= s.hikey);
    if (splits.length) {
      splits[0].lokey = o.lo;
      splits[splits.length - 1].hikey = o.hi;
    }
    for (const s of splits) {
      const rr = byRoot.get(s.root)!;
      rr.forEach((z, i) => {
        const p = dir + z.sample;
        const f = ctx.facts(p);
        const r: Opcodes = { sample: z.sample, lokey: s.lokey, hikey: s.hikey, pitch_keycenter: z.root };
        if (z.tune) r.tune = Math.round(z.tune);
        r.lovel = L.lovel;
        r.hivel = L.hivel;
        if (L.xfin) Object.assign(r, { xfin_lovel: L.xfin[0], xfin_hivel: L.xfin[1] });
        if (L.xfout) Object.assign(r, { xfout_lovel: L.xfout[0], xfout_hivel: L.xfout[1] });
        if (rr.length > 1) Object.assign(r, { seq_length: rr.length, seq_position: i + 1 });
        if (L.peakDb !== undefined && f.peakDb !== undefined && Number.isFinite(f.peakDb)) {
          const v = Math.max(-24, Math.min(24, L.peakDb - f.peakDb));
          if (Math.abs(v) >= 0.05) r.volume = db(v);
        }
        let offset = 0;
        if (o.skipSilenceMs !== undefined && f.onset !== undefined && (f.onset / f.rate) * 1000 > o.skipSilenceMs) {
          offset = f.onset;
          r.offset = offset;
        }
        if (o.keep) {
          const keep = o.keep(z.root);
          const fade = o.fade ?? 1;
          if ((f.frames - offset) / f.rate > keep) {
            r.end = Math.min(f.frames - 1, offset + Math.round(keep * f.rate));
            Object.assign(r, { ampeg_hold: db(keep - fade), ampeg_decay: fade, ampeg_sustain: 0 });
          }
        }
        out.push({ ...r, ...(o.extra ?? {}) });
      });
    }
  });
  return out;
}

/** Evenly split 1..127 into n velocity layers, with optional crossfades of `xf` velocities around each boundary. */
export function velLayers(n: number, xf = 0, peaks?: number[]): LayerSpec[] {
  const bounds = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : Math.round((i * 127) / n)));
  return Array.from({ length: n }, (_, i) => {
    const lo = bounds[i] + 1;
    const hi = bounds[i + 1];
    const L: LayerSpec = { lovel: lo, hivel: hi };
    if (xf > 0) {
      if (i > 0) {
        L.lovel = Math.max(1, lo - xf);
        L.xfin = [L.lovel, Math.min(127, lo + xf)];
      }
      if (i < n - 1) {
        L.hivel = Math.min(127, hi + xf);
        L.xfout = [Math.max(1, hi - xf), L.hivel];
      }
    }
    if (peaks) L.peakDb = peaks[i];
    return L;
  });
}

/** A file name's note (e.g. 'Vibes_soft_F2_v1…' with the C3 = 60 convention: c4 = 72). */
export function noteIn(name: string, re: RegExp, c4: number): number {
  const m = re.exec(name);
  if (!m) throw new Error(`no note in ${name}`);
  return noteNumber(m[1], c4);
}

/** Pack-safe file name ('#' → 's', spaces and commas → '-'). */
export const safeName = (s: string): string => s.replace(/#/g, 's').replace(/[ ,]+/g, '-');
