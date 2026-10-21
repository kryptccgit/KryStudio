// ──────────────────────────────────────────────────────────────────────
// Krypt EQ magnitude response, computed exactly like the engine
// (engine/crates/dsp/src/effects/eq.rs on the TPT SVF of blocks/filters.rs:
// `Svf::design` + `Svf::magnitude`). Pure math + the curve's log-frequency
// geometry; test/meters.test.ts checks it against reference values printed
// by the Rust test `combined_response_reference_values`.
// ──────────────────────────────────────────────────────────────────────

export type SvfMode = 'lowpass' | 'highpass' | 'bell' | 'lowShelf' | 'highShelf';

export interface SvfDesign {
  g: number;
  k: number;
  m0: number;
  m1: number;
  m2: number;
}

/** Butterworth section Qs for cascaded 2nd-order cuts (12 / 24 / 48 dB/oct). */
export const BUTTER_Q: readonly (readonly number[])[] = [
  [Math.SQRT1_2],
  [0.541196100146197, 1.3065629648763768],
  [0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055],
];

function svfG(fc: number, fs: number): number {
  const f = Math.min(0.499, Math.max(1e-6, fc / fs));
  return Math.tan(Math.PI * f);
}

export function designSvf(mode: SvfMode, fc: number, qIn: number, gainDb: number, fs: number): SvfDesign {
  const q = Math.max(qIn, 0.025);
  const g = svfG(fc, fs);
  const k = 1 / q;
  switch (mode) {
    case 'lowpass':
      return { g, k, m0: 0, m1: 0, m2: 1 };
    case 'highpass':
      return { g, k, m0: 1, m1: -k, m2: -1 };
    case 'bell': {
      const a = Math.pow(10, gainDb / 40);
      const kb = 1 / (q * a);
      return { g, k: kb, m0: 1, m1: kb * (a * a - 1), m2: 0 };
    }
    case 'lowShelf': {
      const a = Math.pow(10, gainDb / 40);
      return { g: g / Math.sqrt(a), k, m0: 1, m1: k * (a - 1), m2: a * a - 1 };
    }
    case 'highShelf': {
      const a = Math.pow(10, gainDb / 40);
      return { g: g * Math.sqrt(a), k, m0: a * a, m1: k * (1 - a) * a, m2: 1 - a * a };
    }
  }
}

/** Linear magnitude of a designed section at `f` Hz (the digital response on the unit circle). */
export function svfMagnitude(s: SvfDesign, f: number, fs: number): number {
  const w = (2 * Math.PI * Math.min(f, fs * 0.4999)) / fs;
  const sIm = Math.tan(w * 0.5) / s.g;
  const reD = 1 - sIm * sIm;
  const imD = s.k * sIm;
  const reN = s.m0 * (1 - sIm * sIm) + s.m2;
  const imN = s.m0 * s.k * sIm + s.m1 * sIm;
  return Math.sqrt((reN * reN + imN * imN) / (reD * reD + imD * imD));
}

// ── The Krypt EQ's bands ──────────────────────────────────────────────

export type EqBandKind = 'lowCut' | 'lowShelf' | 'bell' | 'highShelf' | 'highCut';

export interface EqBand {
  /** 1..7, as in the param ids (b1Freq …). */
  n: number;
  kind: EqBandKind;
  label: string;
  on: string;
  freq: string;
  gain?: string;
  q?: string;
  slope?: string;
}

export const EQ_BANDS: readonly EqBand[] = [
  { n: 1, kind: 'lowCut', label: 'Low cut', on: 'b1On', freq: 'b1Freq', slope: 'b1Slope' },
  { n: 2, kind: 'lowShelf', label: 'Low shelf', on: 'b2On', freq: 'b2Freq', gain: 'b2Gain', q: 'b2Q' },
  { n: 3, kind: 'bell', label: 'Peak 1', on: 'b3On', freq: 'b3Freq', gain: 'b3Gain', q: 'b3Q' },
  { n: 4, kind: 'bell', label: 'Peak 2', on: 'b4On', freq: 'b4Freq', gain: 'b4Gain', q: 'b4Q' },
  { n: 5, kind: 'bell', label: 'Peak 3', on: 'b5On', freq: 'b5Freq', gain: 'b5Gain', q: 'b5Q' },
  { n: 6, kind: 'highShelf', label: 'High shelf', on: 'b6On', freq: 'b6Freq', gain: 'b6Gain', q: 'b6Q' },
  { n: 7, kind: 'highCut', label: 'High cut', on: 'b7On', freq: 'b7Freq', slope: 'b7Slope' },
];

/** Reads a plain param value (doc value or the catalog default). */
export type EqParams = (id: string) => number;

/** The sections one band contributes (none while it is off; a band at 0 dB is unity anyway). */
export function bandSections(b: EqBand, p: EqParams, fs: number): SvfDesign[] {
  if (p(b.on) < 0.5) return [];
  const f = p(b.freq);
  switch (b.kind) {
    case 'lowCut':
      return BUTTER_Q[Math.min(2, Math.max(0, Math.round(p(b.slope!))))].map((q) => designSvf('highpass', f, q, 0, fs));
    case 'highCut':
      return BUTTER_Q[Math.min(2, Math.max(0, Math.round(p(b.slope!))))].map((q) => designSvf('lowpass', Math.min(f, fs * 0.49), q, 0, fs));
    default:
      return [designSvf(b.kind, Math.min(f, fs * 0.49), p(b.q!), p(b.gain!), fs)];
  }
}

/** One band's response in dB at `f`. */
export function bandResponseDb(b: EqBand, p: EqParams, f: number, fs: number): number {
  let db = 0;
  for (const s of bandSections(b, p, fs)) db += 20 * Math.log10(svfMagnitude(s, f, fs));
  return db;
}

/** The EQ's combined response (all bands + output gain) in dB at each frequency. */
export function eqResponseDb(p: EqParams, freqs: readonly number[], fs: number): number[] {
  const sections = EQ_BANDS.flatMap((b) => bandSections(b, p, fs));
  const out = p('output');
  return freqs.map((f) => sections.reduce((db, s) => db + 20 * Math.log10(svfMagnitude(s, f, fs)), out));
}

// ── Curve geometry (log frequency, linear dB) ─────────────────────────

export const CURVE_MIN_HZ = 20;
export const CURVE_MAX_HZ = 20000;

export function freqToX(f: number, width: number): number {
  return (Math.log(Math.max(CURVE_MIN_HZ, Math.min(CURVE_MAX_HZ, f)) / CURVE_MIN_HZ) / Math.log(CURVE_MAX_HZ / CURVE_MIN_HZ)) * width;
}

export function xToFreq(x: number, width: number): number {
  return CURVE_MIN_HZ * Math.pow(CURVE_MAX_HZ / CURVE_MIN_HZ, Math.min(1, Math.max(0, x / width)));
}

/** dB → y with ±range dB over the height (0 dB in the middle). */
export function dbToY(db: number, height: number, range: number): number {
  return height / 2 - (Math.max(-range, Math.min(range, db)) / range) * (height / 2);
}

export function yToDb(y: number, height: number, range: number): number {
  return Math.max(-range, Math.min(range, ((height / 2 - y) / (height / 2)) * range));
}

/** `n` log-spaced frequencies across the curve. */
export function logFreqs(n: number): number[] {
  return Array.from({ length: n }, (_, i) => CURVE_MIN_HZ * Math.pow(CURVE_MAX_HZ / CURVE_MIN_HZ, i / Math.max(1, n - 1)));
}

/** Grid lines: 20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k. */
export const FREQ_GRID: readonly number[] = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

export function formatHz(f: number): string {
  return f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`;
}
