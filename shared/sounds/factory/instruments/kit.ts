// Builders for the factory instrument presets: full, explicit param sets per
// stock instrument (a preset REPLACES the whole param set, so every sound
// states every knob it relies on) plus compact effect-slot helpers. Values are
// plain units exactly as in shared/plugins/catalog.gen.json;
// test/presets-factory.test.ts checks every one against the catalog.
//
// Gain staging: every preset's level was set by rendering it through the
// engine (scripts/audition-presets.mjs) so presets of one role land within
// about ±2 LU of each other at the default channel volume.

import type { GenreId } from '../../genres';
import type { InstrumentPreset, InstrumentRole, PresetFx } from '../../types';

export type Params = Record<string, number>;

export const WAVE = 'krypt.wavetable';
export const TRI = 'krypt.triosc';
export const FM = 'krypt.fm';
export const K808 = 'krypt.kick808';
export const DRUM = 'krypt.drumsynth';
export const SAMPLER = 'krypt.sampler';

// ── Krypt Wave ────────────────────────────────────────────────────────

/** Wave tables: 0 basic morph (0 sine, 1/3 triangle, 2/3 saw, 1 square), 1 PWM (50% → 6%), 2 formant (a e i o u), 3 harmonic sweep (sine → 64 harmonics), 4 digital (sync ratio 1 → 8, crushed above 0.5). */
export const T = { basic: 0, pwm: 1, formant: 2, harmonic: 3, digital: 4 } as const;
/** Basic-morph positions. */
export const POS = { sine: 0, tri: 1 / 3, saw: 2 / 3, square: 1 } as const;
/** Sync divisions (LFO / delay / filter / phaser index). */
export const DIV = { '1/64': 0, '1/32': 1, '1/16T': 2, '1/16': 3, '1/16D': 4, '1/8T': 5, '1/8': 6, '1/8D': 7, '1/4T': 8, '1/4': 9, '1/4D': 10, '1/2': 11, '1bar': 12, '2bars': 13, '4bars': 14 } as const;
/** LFO shapes. */
export const LFO = { sine: 0, tri: 1, sawUp: 2, sawDown: 3, square: 4 } as const;

const WAVE_BASE: Params = {
  table: 0,
  position: 0.6667,
  coarse: 0,
  fine: 0,
  level: 0.8,
  unison: 1,
  detune: 0.25,
  spread: 0.7,
  subLevel: 0,
  subShape: 0,
  subOctave: 0,
  filterType: 0,
  cutoff: 20000,
  reso: 0,
  filterKeyTrack: 0,
  ampAttack: 3,
  ampHold: 0.1,
  ampDecay: 600,
  ampSustain: 0.8,
  ampRelease: 300,
  modAttack: 5,
  modDecay: 800,
  modSustain: 0,
  modRelease: 400,
  modToPosition: 0,
  modToCutoff: 0,
  lfoShape: 1,
  lfoSync: 0,
  lfoDivision: 9,
  lfoRate: 0.5,
  lfoToPosition: 0,
  lfoToCutoff: 0,
  lfoToPitch: 0,
  gain: -6,
};

/** A full Krypt Wave param set: neutral base (no filter movement, no LFO) + the given values. */
export function wave(p: Params & { gain: number }): Params {
  return { ...WAVE_BASE, ...p };
}

// ── Krypt TriOsc ──────────────────────────────────────────────────────

/** TriOsc shapes. */
export const SH = { sine: 0, tri: 1, saw: 2, square: 3, pulse: 4, noise: 5 } as const;

const TRI_BASE: Params = {
  osc1Shape: 2,
  osc1Coarse: 0,
  osc1Fine: 0,
  osc1Level: 0.8,
  osc1Pan: 0,
  osc1Phase: 0,
  osc2Shape: 2,
  osc2Coarse: 0,
  osc2Fine: 0,
  osc2Level: 0,
  osc2Pan: 0,
  osc2Phase: 0,
  osc3Shape: 0,
  osc3Coarse: -12,
  osc3Fine: 0,
  osc3Level: 0,
  osc3Pan: 0,
  osc3Phase: 0,
  unisonDetune: 0,
  drift: 0.1,
  gain: -6,
  ampAttack: 2,
  ampHold: 0.1,
  ampDecay: 400,
  ampSustain: 0.7,
  ampRelease: 200,
  filterType: 0,
  cutoff: 20000,
  reso: 0,
  filterEnvAmount: 0,
  filterEnvAttack: 1,
  filterEnvDecay: 350,
  filterEnvSustain: 0,
  filterEnvRelease: 250,
  filterKeyTrack: 0,
};

/** A full Krypt TriOsc param set (osc 2 and 3 silent unless given). */
export function tri(p: Params & { gain: number }): Params {
  return { ...TRI_BASE, ...p };
}

// ── Krypt FM ──────────────────────────────────────────────────────────

/**
 * FM algorithms (index): 0 stack 4>3>2>1 · 1 (4+3)>2>1 · 2 (3>2)+4>1 · 3 (4>3)+2>1 ·
 * 4 pairs 4>3 + 2>1 (carriers 1, 3) · 5 4>(3+2+1) · 6 4>3 + 2 + 1 · 7 additive.
 */
export const ALG = { stack: 0, twoToOne: 1, branch: 2, branch2: 3, pairs: 4, oneToThree: 5, pairPlusTwo: 6, additive: 7 } as const;

export interface Op {
  ratio?: number;
  fine?: number;
  detune?: number;
  level?: number;
  vel?: number;
  a?: number;
  h?: number;
  d?: number;
  s?: number;
  r?: number;
}

const OP_BASE: Required<Op> = { ratio: 1, fine: 0, detune: 0, level: 0, vel: 0.5, a: 1, h: 0.1, d: 1000, s: 1, r: 300 };

function opParams(n: number, o: Op | undefined): Params {
  const x = { ...OP_BASE, ...(o ?? {}) };
  return {
    [`op${n}Ratio`]: x.ratio,
    [`op${n}Fine`]: x.fine,
    [`op${n}Detune`]: x.detune,
    [`op${n}Level`]: x.level,
    [`op${n}Vel`]: x.vel,
    [`op${n}Attack`]: x.a,
    [`op${n}Hold`]: x.h,
    [`op${n}Decay`]: x.d,
    [`op${n}Sustain`]: x.s,
    [`op${n}Release`]: x.r,
  };
}

export interface FmSpec {
  gain: number;
  algorithm: number;
  feedback?: number;
  /** Operators 1-4 (op 1 is always a carrier). */
  ops: [Op?, Op?, Op?, Op?];
  filterType?: number;
  cutoff?: number;
  reso?: number;
  filterEnvAmount?: number;
  filterEnvDecay?: number;
  filterKeyTrack?: number;
  vibratoRate?: number;
  vibrato?: number;
}

/** A full Krypt FM param set. Operators not given are silent (level 0). */
export function fm(p: FmSpec): Params {
  const { ops, gain, algorithm, feedback, ...rest } = p;
  const extra: Params = {};
  for (const [k, v] of Object.entries(rest)) if (typeof v === 'number') extra[k] = v;
  return {
    gain,
    algorithm,
    feedback: feedback ?? 0,
    ...opParams(1, ops[0]),
    ...opParams(2, ops[1]),
    ...opParams(3, ops[2]),
    ...opParams(4, ops[3]),
    filterType: 0,
    cutoff: 20000,
    reso: 0,
    filterEnvAmount: 0,
    filterEnvDecay: 400,
    filterKeyTrack: 0,
    vibratoRate: 5,
    vibrato: 0,
    ...extra,
  };
}

// ── Krypt 808 / DrumSynth / Sampler ───────────────────────────────────

const K808_BASE: Params = { gain: -3, tune: 0, decay: 900, punch: 24, punchDecay: 40, click: 0.2, drive: 0.25, tone: 6000, gate: 0 };

export function k808(p: Params & { gain: number }): Params {
  return { ...K808_BASE, ...p };
}

/** DrumSynth voices. */
export const DV = { kick: 0, snare: 1, clap: 2, hat: 3, openhat: 4, tom: 5, rim: 6, cowbell: 7, crash: 8, perc: 9 } as const;

const DRUM_BASE: Params = { gain: -3, voice: 0, tune: 0, decay: 250, tone: 0.5, snap: 0.5, drive: 0.1 };

export function drum(p: Params & { gain: number; voice: number }): Params {
  return { ...DRUM_BASE, ...p };
}

const SAMPLER_BASE: Params = {
  gain: 0,
  oneShot: 1,
  start: 0,
  reverse: 0,
  loop: 0,
  keyTrack: 1,
  ampAttack: 0.1,
  ampHold: 0.1,
  ampDecay: 1000,
  ampSustain: 1,
  ampRelease: 30,
  filterType: 0,
  cutoff: 20000,
  reso: 0,
  pitchEnvAmount: 0,
  pitchEnvDecay: 100,
};

export function sampler(p: Params & { gain: number }): Params {
  return { ...SAMPLER_BASE, ...p };
}

// ── Effects ───────────────────────────────────────────────────────────

export interface EqSpec {
  /** Low cut (Hz) and slope (0 = 12, 1 = 24, 2 = 48 dB/oct). */
  hp?: number;
  hpSlope?: 0 | 1 | 2;
  /** Low shelf [Hz, dB]. */
  low?: [number, number];
  /** Bells [Hz, dB, Q]. */
  b3?: [number, number, number];
  b4?: [number, number, number];
  b5?: [number, number, number];
  /** High shelf [Hz, dB]. */
  high?: [number, number];
  /** High cut (Hz) and slope. */
  lp?: number;
  lpSlope?: 0 | 1 | 2;
  out?: number;
}

/** krypt.eq with only the bands used switched on. */
export function eq(s: EqSpec): PresetFx {
  const p: Params = { b2On: 0, b3On: 0, b4On: 0, b5On: 0, b6On: 0 };
  if (s.hp != null) Object.assign(p, { b1On: 1, b1Freq: s.hp, b1Slope: s.hpSlope ?? 1 });
  if (s.low) Object.assign(p, { b2On: 1, b2Freq: s.low[0], b2Gain: s.low[1], b2Q: 0.7 });
  if (s.b3) Object.assign(p, { b3On: 1, b3Freq: s.b3[0], b3Gain: s.b3[1], b3Q: s.b3[2] });
  if (s.b4) Object.assign(p, { b4On: 1, b4Freq: s.b4[0], b4Gain: s.b4[1], b4Q: s.b4[2] });
  if (s.b5) Object.assign(p, { b5On: 1, b5Freq: s.b5[0], b5Gain: s.b5[1], b5Q: s.b5[2] });
  if (s.high) Object.assign(p, { b6On: 1, b6Freq: s.high[0], b6Gain: s.high[1], b6Q: 0.7 });
  if (s.lp != null) Object.assign(p, { b7On: 1, b7Freq: s.lp, b7Slope: s.lpSlope ?? 1 });
  if (s.out != null) p.output = s.out;
  return { type: 'krypt.eq', params: p };
}

/** Just a low cut. */
export const hp = (freq: number, slope: 0 | 1 | 2 = 1): PresetFx => eq({ hp: freq, hpSlope: slope });

export function chorus(p: { voices?: number; rate?: number; depth?: number; delay?: number; spread?: number; feedback?: number; lowCut?: number; highCut?: number; mix?: number }): PresetFx {
  return {
    type: 'krypt.chorus',
    params: {
      voices: p.voices ?? 3,
      rate: p.rate ?? 0.6,
      depth: p.depth ?? 0.45,
      delay: p.delay ?? 14,
      spread: p.spread ?? 0.8,
      feedback: p.feedback ?? 0,
      lowCut: p.lowCut ?? 200,
      highCut: p.highCut ?? 12000,
      mix: p.mix ?? 0.4,
    },
  };
}

export const ROOM = 0;
export const HALL = 1;
export const PLATE = 2;

/** krypt.reverb at a wet/dry blend (the slot mix). */
export function reverb(mode: number, decay: number, mix: number, o: { size?: number; predelay?: number; damping?: number; lowCut?: number; width?: number; diffusion?: number } = {}): PresetFx {
  return {
    type: 'krypt.reverb',
    params: {
      mode,
      size: o.size ?? 0.6,
      decay,
      predelay: o.predelay ?? 20,
      damping: o.damping ?? 7000,
      lowCut: o.lowCut ?? 250,
      diffusion: o.diffusion ?? 0.75,
      width: o.width ?? 1,
    },
    mix,
  };
}

/** Tempo-synced krypt.delay at a wet/dry blend. */
export function delay(division: number, feedback: number, mix: number, o: { pingPong?: 0 | 1; lowCut?: number; highCut?: number; modDepth?: number } = {}): PresetFx {
  return {
    type: 'krypt.delay',
    params: {
      sync: 1,
      division,
      feedback,
      pingPong: o.pingPong ?? 1,
      lowCut: o.lowCut ?? 300,
      highCut: o.highCut ?? 7000,
      modDepth: o.modDepth ?? 0.1,
    },
    mix,
  };
}

export const TAPE = 0;
export const TUBE = 1;
export const HARD = 2;
export const FOLD = 3;
export const CRUSH = 4;

export function drive(mode: number, amount: number, o: { tone?: number; output?: number; bits?: number; downsample?: number; mix?: number } = {}): PresetFx {
  const params: Params = { mode, drive: amount, tone: o.tone ?? 12000, output: o.output ?? 0 };
  if (mode === CRUSH) Object.assign(params, { bits: o.bits ?? 10, downsample: o.downsample ?? 1 });
  const fx: PresetFx = { type: 'krypt.drive', params };
  if (o.mix != null) fx.mix = o.mix;
  return fx;
}

export function comp(threshold: number, ratio: number, attack: number, release: number, o: { knee?: number; detector?: 0 | 1 } = {}): PresetFx {
  return {
    type: 'krypt.comp',
    params: { threshold, ratio, attack, release, knee: o.knee ?? 6, makeup: 0, autoMakeup: 1, useSidechain: 0, detector: o.detector ?? 1 },
  };
}

export function imager(low: number, mid: number, high: number, o: { lowFreq?: number; highFreq?: number } = {}): PresetFx {
  return { type: 'krypt.imager', params: { lowWidth: low, midWidth: mid, highWidth: high, lowFreq: o.lowFreq ?? 200, highFreq: o.highFreq ?? 4000, output: 0 } };
}

export function clipper(amount: number, ceiling = -1, softness = 0.6): PresetFx {
  return { type: 'krypt.clipper', params: { drive: amount, ceiling, softness, oversample: 1 } };
}

export function phaser(p: { stages?: number; center?: number; depth?: number; rate?: number; feedback?: number; mix?: number; sync?: 0 | 1; division?: number }): PresetFx {
  return {
    type: 'krypt.phaser',
    params: {
      stages: p.stages ?? 6,
      center: p.center ?? 800,
      depth: p.depth ?? 0.6,
      rate: p.rate ?? 0.25,
      sync: p.sync ?? 0,
      division: p.division ?? 11,
      feedback: p.feedback ?? 0.4,
      stereo: 90,
      mix: p.mix ?? 0.4,
    },
  };
}

export function flanger(p: { delay?: number; depth?: number; rate?: number; feedback?: number; mix?: number }): PresetFx {
  return {
    type: 'krypt.flanger',
    params: { delay: p.delay ?? 1.5, depth: p.depth ?? 0.6, rate: p.rate ?? 0.15, sync: 0, division: 12, shape: 1, feedback: p.feedback ?? 0.4, throughZero: 0, stereo: 90, mix: p.mix ?? 0.4 },
  };
}

/** krypt.filter: type 0 LP12, 1 LP24, 2 HP12, 3 HP24, 4 BP, 5 notch; optional LFO on cutoff. */
export function filter(p: { type?: number; cutoff: number; reso?: number; drive?: number; lfoSync?: 0 | 1; lfoDivision?: number; lfoRate?: number; lfoDepth?: number; lfoShape?: number }): PresetFx {
  return {
    type: 'krypt.filter',
    params: {
      type: p.type ?? 1,
      cutoff: p.cutoff,
      reso: p.reso ?? 0.1,
      drive: p.drive ?? 0,
      lfoSync: p.lfoSync ?? 1,
      lfoDivision: p.lfoDivision ?? 9,
      lfoRate: p.lfoRate ?? 1,
      lfoDepth: p.lfoDepth ?? 0,
      lfoShape: p.lfoShape ?? 0,
    },
  };
}

export function transient(attack: number, sustain: number, output = 0): PresetFx {
  return { type: 'krypt.transient', params: { attack, sustain, attackWindow: 15, sustainWindow: 200, output } };
}

/** krypt.utility: width 0 = mono … 2 = extra wide. */
export function utility(p: { gain?: number; width?: number; mono?: 0 | 1; pan?: number }): PresetFx {
  return { type: 'krypt.utility', params: { gain: p.gain ?? 0, pan: p.pan ?? 0, width: p.width ?? 1, mono: p.mono ?? 0, invertL: 0, invertR: 0, dcFilter: 0 } };
}

/** krypt.duck in tempo-shape mode (the classic sidechain pump without a kick routed): rate 0 1/8, 1 1/4, 2 1/2, 3 1 bar. */
export function pump(depth: number, rate = 1, curve = 0.5): PresetFx {
  return { type: 'krypt.duck', params: { mode: 0, depth, rate, curve, attack: 1, release: 180, threshold: -24 } };
}

/** krypt.gate pattern (0 half-time … 7 gate 1/8, 8 gate 1/16 trance, 9 gate 3-3-2), always on. */
export function gatePattern(pattern: number, depth = 1, smoothing = 4): PresetFx {
  return { type: 'krypt.gate', params: { pattern, trigger: 0, active: 0, depth, smoothing, mix: 1 } };
}

export function squash(p: { depth?: number; time?: number; upward?: number; downward?: number; outGain?: number; lowGain?: number; midGain?: number; highGain?: number }): PresetFx {
  return {
    type: 'krypt.squash',
    params: {
      depth: p.depth ?? 0.3,
      time: p.time ?? 0.5,
      upward: p.upward ?? 0.6,
      downward: p.downward ?? 1,
      inGain: 0,
      outGain: p.outGain ?? 0,
      lowGain: p.lowGain ?? 0,
      midGain: p.midGain ?? 0,
      highGain: p.highGain ?? 0,
      lowFreq: 88,
      highFreq: 2500,
    },
  };
}

// ── Preset ────────────────────────────────────────────────────────────

export interface PresetSpec {
  id: string;
  name: string;
  plugin: string;
  params: Params;
  sample?: string;
  channel?: InstrumentPreset['channel'];
  fx?: PresetFx[];
  alsoRoles?: InstrumentRole[];
  tags: string[];
  genres: GenreId[];
  description: string;
  range: [number, number];
}

/** A factory instrument preset; the role comes from the id ('factory:<role>/<slug>'). */
export function preset(s: PresetSpec): InstrumentPreset {
  const m = /^factory:([a-z0-9]+)\//.exec(s.id);
  if (!m) throw new Error(`Bad factory preset id ${s.id}`);
  const out: InstrumentPreset = {
    kind: 'instrument',
    id: s.id,
    name: s.name,
    plugin: s.plugin,
    params: s.params,
    role: m[1] as InstrumentRole,
    tags: s.tags,
    genres: s.genres,
    description: s.description,
    range: s.range,
    author: 'Krypt Studio',
  };
  if (s.sample) out.sample = s.sample;
  if (s.channel) out.channel = s.channel;
  if (s.fx?.length) out.fx = s.fx;
  if (s.alsoRoles?.length) out.alsoRoles = s.alsoRoles;
  return out;
}
