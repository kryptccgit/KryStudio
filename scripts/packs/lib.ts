import { SFZ_OPCODES } from '@shared/packs/types';
import type { SampleKind } from '@shared/sounds/types';
import type { GenreId } from '@shared/sounds/genres';

export interface AudioFacts {
  format: 'wav' | 'flac';
  rate: number;
  channels: number;
  bits: number;
  frames: number;
  peakDb?: number;
  midi?: number | null;
  onset?: number;
}

export interface SampleRef {
  src: string;
  path: string;
}

export type Opcodes = Record<string, string | number>;

export interface SfzGroup {
  comment?: string;
  opcodes: Opcodes;
  regions: Opcodes[];
}

export interface SfzDoc {
  title: string;
  control?: Opcodes;
  global?: Opcodes;
  groups: SfzGroup[];
}

export interface InstrumentSpec {
  path: string;
  keys: { lo: number; hi: number } | number[];
  build(ctx: BuildCtx): SfzDoc;
}

export interface BuildCtx {
  facts(packPath: string): AudioFacts;
  endFor(packPath: string, seconds: number): number;
}

export interface PackSpec {
  id: string;
  base: string;
  mirrors: string[];
  samples: SampleRef[];
  instruments: InstrumentSpec[];
}

export interface GithubSource {
  type: 'github';
  base: string;
  mirrors: string[];
}

export interface UrlSource {
  type: 'url';
  url: string;
  mirrors?: string[];
}

export interface ZipSource {
  type: 'zip';
  url: string;
  mirrors?: string[];
  path: string;
}

export type SampleSource = GithubSource | UrlSource | ZipSource;

export interface SampleDef {
  from: string;
  src?: string;
  path: string;
  name: string;
  kind: SampleKind;
  tags: string[];
  genres: GenreId[];
  rootNote?: number;
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

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function extOf(p: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(decodeURIComponent(p.split('?')[0]));
  if (!m) throw new Error(`no file extension in ${p}`);
  return `.${m[1].toLowerCase()}`;
}

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

export function samplesOf(doc: SfzDoc): string[] {
  const dp = String(doc.control?.default_path ?? '');
  const out = new Set<string>();
  for (const g of doc.groups) for (const r of g.regions) out.add(dp + String(r.sample ?? g.opcodes.sample));
  return [...out];
}

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

export function noteNumber(name: string, c4 = 60): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad note name ${name}`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'] ?? 0;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return c4 + (Number(m[3]) - 4) * 12 + base + acc;
}

export function keySplits(roots: number[], lo: number, hi: number): { root: number; lokey: number; hikey: number }[] {
  const r = [...roots].sort((a, b) => a - b);
  return r.map((root, i) => {
    const lokey = i === 0 ? lo : Math.floor((r[i - 1] + root) / 2) + 1;
    const hikey = i === r.length - 1 ? hi : Math.floor((root + r[i + 1]) / 2);
    return { root, lokey, hikey };
  });
}

export const db = (v: number): number => Math.round(v * 10) / 10;

export interface Zone {
  sample: string;
  root: number;
  layer: number;
  tune?: number;
}

export interface LayerSpec {
  lovel: number;
  hivel: number;
  xfin?: [number, number];
  xfout?: [number, number];
  peakDb?: number;
}

export interface MelodicOpts {
  lo: number;
  hi: number;
  layers: LayerSpec[];
  keep?: (root: number) => number;
  fade?: number;
  skipSilenceMs?: number;
  extra?: Opcodes;
  fillLayers?: boolean;
}

export function melodic(ctx: BuildCtx, zones: Zone[], o: MelodicOpts, dir = 'samples/'): Opcodes[] {
  const out: Opcodes[] = [];
  const allRoots = [...new Set(zones.map((z) => z.root))].sort((a, b) => a - b);
  o.layers.forEach((L, li) => {
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

export function noteIn(name: string, re: RegExp, c4: number): number {
  const m = re.exec(name);
  if (!m) throw new Error(`no note in ${name}`);
  return noteNumber(m[1], c4);
}

export const safeName = (s: string): string => s.replace(/#/g, 's').replace(/[ ,]+/g, '-');
