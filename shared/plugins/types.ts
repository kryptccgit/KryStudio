export type ParamUnit = '' | 'dB' | 'Hz' | 'ms' | 's' | 'st' | 'ct' | '%' | 'x' | 'bpm' | 'deg';

export type ParamScale = 'linear' | 'log' | 'gain';

export interface ParamSpec {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: ParamUnit;
  scale: ParamScale;
  step?: number;
  options?: string[];
  group?: string;
  automatable?: boolean;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  kind: 'instrument' | 'effect';
  category: string;
  description: string;
  params: ParamSpec[];
  usesSample?: boolean;
  sidechain?: boolean;
  defaultMix?: number;
  format?: 'vst3' | 'clap';
  vendor?: string;
  version?: string;
  path?: string;
  hasEditor?: boolean;
}

export interface PluginCatalog {
  version: number;
  plugins: PluginDescriptor[];
}

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
