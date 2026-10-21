// Plugin / parameter descriptors. The SOURCE OF TRUTH is the Rust engine
// (engine/crates/dsp): `krypt-studio-engine --dump-catalog` writes
// shared/plugins/catalog.gen.json, which the UI, the MCP tools and the
// command layer import. Never hand-edit the generated file once the engine
// produces it.

export type ParamUnit = '' | 'dB' | 'Hz' | 'ms' | 's' | 'st' | 'ct' | '%' | 'x' | 'bpm' | 'deg';

/**
 * How a value maps to a normalized 0..1 knob/automation position:
 *  - linear: norm = (v - min) / (max - min)
 *  - log:    norm = log(v/min) / log(max/min)          (min must be > 0; frequencies, times)
 *  - gain:   linear gain with a fader taper: v = max * norm^3   (min must be 0)
 */
export type ParamScale = 'linear' | 'log' | 'gain';

export interface ParamSpec {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: ParamUnit;
  scale: ParamScale;
  /** Quantization step in plain units (e.g. 1 for semitones / enums). */
  step?: number;
  /** Enum labels: value is the index (min 0, max options.length-1, step 1). */
  options?: string[];
  /** UI grouping, e.g. 'Envelope', 'Filter', 'Osc 1'. */
  group?: string;
  /** Defaults to true. */
  automatable?: boolean;
}

export interface PluginDescriptor {
  /** Stable id, e.g. 'krypt.triosc'. Stored in the project. */
  id: string;
  name: string;
  kind: 'instrument' | 'effect';
  category: string;
  description: string;
  params: ParamSpec[];
  /** Instruments that play a sample (sampler, audio clip). */
  usesSample?: boolean;
  /** Effects with a sidechain input (compressor, ducker). */
  sidechain?: boolean;
  /** Default wet/dry for a new FX slot (effects only). */
  defaultMix?: number;
  // ── Third-party plugins only (scanned VST3/CLAP; ids 'vst3:<CID>' / 'clap:<id>') ──
  // Their params use the plugin's own ids; values are the plugin's plain
  // values (CLAP) or normalized 0..1 / step indices (VST3), scale 'linear'.
  format?: 'vst3' | 'clap';
  vendor?: string;
  version?: string;
  /** Absolute path of the .vst3 / .clap the plugin lives in. */
  path?: string;
  /** The plugin has its own native editor window (plugins.editor). */
  hasEditor?: boolean;
}

export interface PluginCatalog {
  version: number;
  plugins: PluginDescriptor[];
}

// ── Value mapping ─────────────────────────────────────────────────────

export function clampToSpec(spec: ParamSpec, v: number): number {
  let x = Math.min(spec.max, Math.max(spec.min, Number.isFinite(v) ? v : spec.default));
  if (spec.step && spec.step > 0) x = Math.round((x - spec.min) / spec.step) * spec.step + spec.min;
  return x;
}

export function toNormalized(spec: ParamSpec, v: number): number {
  const x = clampToSpec(spec, v);
  if (spec.max === spec.min) return 0;
  switch (spec.scale) {
    case 'log':
      return Math.log(x / spec.min) / Math.log(spec.max / spec.min);
    case 'gain':
      return Math.cbrt(x / spec.max);
    default:
      return (x - spec.min) / (spec.max - spec.min);
  }
}

export function fromNormalized(spec: ParamSpec, n: number): number {
  const t = Math.min(1, Math.max(0, n));
  let v: number;
  switch (spec.scale) {
    case 'log':
      v = spec.min * Math.pow(spec.max / spec.min, t);
      break;
    case 'gain':
      v = spec.max * t * t * t;
      break;
    default:
      v = spec.min + t * (spec.max - spec.min);
  }
  return clampToSpec(spec, v);
}

/** Human-readable value, e.g. "-6.0 dB", "1.20 kHz", "Saw". */
export function formatParam(spec: ParamSpec, v: number): string {
  if (spec.options) return spec.options[Math.round(v)] ?? String(v);
  if (spec.scale === 'gain') {
    const db = v <= 0 ? -Infinity : 20 * Math.log10(v);
    return db === -Infinity ? '-inf dB' : `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  }
  switch (spec.unit) {
    case 'Hz':
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v.toFixed(v < 100 ? 1 : 0)} Hz`;
    case 'ms':
      return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ms`;
    case '%':
      return `${Math.round(v * 100)}%`;
    case 'dB':
      return `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
    case 'st':
      return `${v >= 0 ? '+' : ''}${v.toFixed(spec.step === 1 ? 0 : 2)} st`;
    case 'ct':
      return `${v >= 0 ? '+' : ''}${Math.round(v)} ct`;
    case '':
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
    default:
      return `${Number.isInteger(v) ? v : v.toFixed(2)} ${spec.unit}`;
  }
}
