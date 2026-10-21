import type { PluginDescriptor } from '../plugins/types';
import { pluginById } from '../plugins/catalog';
import { factoryPreset } from '../sounds/factory';
import type { InstrumentPreset, InstrumentRole, SampleKind } from '../sounds/types';
import { aggregateFingerprints, compareFingerprints, isDrumTarget, PROFILES, profileFor, semitones, usableFingerprint, type FeatureKey, type FeatureWeights } from './features';
import { tweaksFor } from './tweaks';
import type { FingerprintEntry, FingerprintSource, MatchTarget, SoundFingerprint, SoundMatch } from './types';

export { aggregateFingerprints, compareFingerprints, PROFILES, profileFor, isDrumTarget } from './features';
export { tweaksFor, levelDiffDb, CHANNEL_TWEAKS, isChannelTweak } from './tweaks';

const MIN_CUTOFF_HZ: Partial<Record<MatchTarget['role'], number>> = { hat: 4000, openhat: 4000, snare: 2500, clap: 2500, perc: 1200, kick: 300 };

export const DRUM_SAMPLE_KINDS: Partial<Record<InstrumentRole, SampleKind[]>> = {
  kick: ['kick'],
  snare: ['snare', 'clap', 'rim'],
  clap: ['clap', 'snare', 'snap'],
  hat: ['hat', 'shaker'],
  openhat: ['openhat', 'ride'],
  ride: ['ride', 'openhat'],
  crash: ['crash', 'ride'],
  perc: ['perc', 'rim', 'shaker', 'tom', 'snap'],
  tom: ['tom', 'perc'],
};

export const ROLE_FAMILY: Record<InstrumentRole, InstrumentRole[]> = {
  kick: ['kick'],
  snare: ['snare', 'clap'],
  clap: ['clap', 'snare'],
  hat: ['hat'],
  openhat: ['openhat', 'ride'],
  ride: ['ride', 'openhat'],
  crash: ['crash', 'ride'],
  perc: ['perc', 'tom'],
  tom: ['tom', 'perc'],
  '808': ['808', 'sub', 'bass'],
  sub: ['sub', '808', 'bass'],
  bass: ['bass', '808', 'sub'],
  lead: ['lead', 'pluck', 'arp', 'bell', 'brass', 'vox'],
  pluck: ['pluck', 'arp', 'bell', 'keys', 'lead'],
  arp: ['arp', 'pluck', 'lead', 'bell'],
  bell: ['bell', 'pluck', 'keys', 'arp'],
  pad: ['pad', 'strings', 'chord', 'vox', 'texture'],
  keys: ['keys', 'piano', 'chord', 'pluck'],
  piano: ['piano', 'keys'],
  chord: ['chord', 'stab', 'keys', 'piano', 'pad', 'strings', 'brass'],
  stab: ['stab', 'chord', 'pluck', 'brass'],
  strings: ['strings', 'pad', 'chord'],
  brass: ['brass', 'stab', 'lead'],
  vox: ['vox', 'pad', 'lead'],
  fx: ['fx', 'texture'],
  texture: ['texture', 'pad', 'fx'],
};

const TONAL_SAMPLE_KINDS: Partial<Record<InstrumentRole, SampleKind[]>> = {
  '808': ['808'],
  sub: ['808'],
  bass: ['bass-oneshot', '808'],
  stab: ['stab-oneshot'],
  chord: ['stab-oneshot'],
};

export function sampleKindsFor(target: MatchTarget): SampleKind[] {
  return [...((isDrumTarget(target) ? DRUM_SAMPLE_KINDS[target.role] : TONAL_SAMPLE_KINDS[target.role]) ?? [])];
}

export const FAMILY_FACTOR = 0.93;

function isKit(p: InstrumentPreset | undefined): boolean {
  return !!p && p.role === 'kick' && ['snare', 'hat'].every((r) => (p.alsoRoles ?? []).includes(r as InstrumentRole));
}

export interface MatchOptions {
  limit?: number;
  preset?: (id: string) => InstrumentPreset | undefined;
  plugin?: (id: string) => PluginDescriptor | undefined;
  allow?: (source: FingerprintSource) => boolean;
  levelOffsetDb?: number;
  weights?: FeatureWeights;
  partLabel?: string;
}

export function eligibility(entry: FingerprintEntry, target: MatchTarget, preset?: (id: string) => InstrumentPreset | undefined): number {
  const role = target.role;
  const src = entry.source;
  if (src.kind === 'sample') {
    const i = sampleKindsFor(target).indexOf(src.sampleKind);
    return i < 0 ? 0 : i === 0 ? 1 : FAMILY_FACTOR;
  }
  const p = (preset ?? defaultPreset)(src.id);
  if (isKit(p)) return 0;
  const family = ROLE_FAMILY[role] ?? [role];
  const roles = [src.role, ...(p?.alsoRoles ?? [])];
  if (roles.includes(role)) return 1;
  return roles.some((r) => family.includes(r)) ? FAMILY_FACTOR : 0;
}

function defaultPreset(id: string): InstrumentPreset | undefined {
  const p = factoryPreset(id);
  return p && p.kind === 'instrument' ? p : undefined;
}

const hz = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)} kHz` : `${Math.round(x)} Hz`);
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const db = (x: number) => `${Math.round(x)} dB`;
const n2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

const BAND_WORD: Record<string, string> = { sub: 'sub', low: 'low end', lowMid: 'low-mids', mid: 'mids', highMid: 'presence (2-6 kHz)', high: 'air (6 kHz+)' };

function featureNoun(key: FeatureKey, profile: string): string {
  switch (key) {
    case 'centroid':
      return 'brightness';
    case 'rolloff':
      return 'top end';
    case 'flatness':
      return profile === 'bass' ? 'grit' : 'noise';
    case 'harmonicity':
      return 'tonality';
    case 'f0':
      return 'pitch';
    case 'attack':
      return 'attack';
    case 'decay':
      return 'length';
    case 'sustain':
      return 'sustain';
    case 'crest':
      return 'punch';
    case 'width':
      return 'width';
    case 'highMid':
      return profile === 'kick' ? 'click' : BAND_WORD.highMid;
    default:
      return BAND_WORD[key] ?? key;
  }
}

function differenceText(key: FeatureKey, z: number, t: SoundFingerprint, c: SoundFingerprint, part: string, profile: string): string {
  const more = z > 0;
  switch (key) {
    case 'centroid':
      return `${more ? 'brighter' : 'darker'} than ${part}: centroid ${hz(c.centroidHz)} vs ${hz(t.centroidHz)}`;
    case 'rolloff':
      return `${more ? 'more' : 'less'} top end than ${part}: 85% of its energy below ${hz(c.rolloffHz)} vs ${hz(t.rolloffHz)}`;
    case 'flatness':
      return `${more ? (profile === 'bass' ? 'grittier / more distorted' : 'noisier') : 'cleaner, more tonal'} than ${part} (flatness ${n2(c.flatness)} vs ${n2(t.flatness)})`;
    case 'harmonicity':
      return `${more ? 'more' : 'less'} pitched than ${part} (harmonicity ${n2(c.harmonicity)} vs ${n2(t.harmonicity)})`;
    case 'f0':
      if (!t.f0Hz || !c.f0Hz) return t.f0Hz ? `unpitched where ${part} has a pitch (${hz(t.f0Hz)})` : `pitched (${hz(c.f0Hz!)}) where ${part} has no clear pitch`;
      return `pitched ${more ? 'higher' : 'lower'}: ${hz(c.f0Hz)} vs ${hz(t.f0Hz)} (${Math.abs(semitones(t.f0Hz, c.f0Hz)).toFixed(1)} semitones)`;
    case 'attack':
      return `${more ? 'slower' : 'faster'} attack than ${part}: ${ms(c.attackMs)} vs ${ms(t.attackMs)}`;
    case 'decay':
      return `${more ? 'longer' : 'shorter'} than ${part}: decays in ${ms(c.decayMs)} vs ${ms(t.decayMs)}`;
    case 'sustain':
      return `${more ? 'more sustained' : 'more percussive'} than ${part} (sustain ${n2(c.sustain)} vs ${n2(t.sustain)})`;
    case 'crest':
      return `${more ? 'punchier transient' : 'flatter, more compressed'} than ${part} (crest ${db(c.crestDb)} vs ${db(t.crestDb)})`;
    case 'width':
      return `${more ? 'wider' : 'narrower'} than ${part} (width ${n2(c.width)} vs ${n2(t.width)})`;
    default: {
      const word = key === 'highMid' && profile === 'kick' ? 'click' : BAND_WORD[key] ?? key;
      return `${more ? 'more' : 'less'} ${word} than ${part} (${db(c.bands[key])} vs ${db(t.bands[key])} rel. the loudest band)`;
    }
  }
}

function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export function whyText(target: SoundFingerprint, cand: SoundFingerprint, deltas: Partial<Record<FeatureKey, number>>, weights: FeatureWeights, similarity: number, part: string, profile: string, family: boolean): string[] {
  const keys = (Object.keys(deltas) as FeatureKey[]).filter((k) => (weights[k] ?? 0) > 0);
  const close = keys
    .filter((k) => Math.abs(deltas[k]!) < 0.35 && (k !== 'f0' || (!!target.f0Hz && !!cand.f0Hz)))
    .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a.localeCompare(b))
    .slice(0, 3)
    .map((k) => featureNoun(k, profile));
  const out = [`${Math.round(similarity * 100)}% match${family ? ' (a related sound type)' : ''}${close.length ? `: close on ${joinWords([...new Set(close)])}` : ''}.`];
  const diffs = keys
    .filter((k) => Math.abs(deltas[k]!) >= 0.5)
    .sort((a, b) => (weights[b] ?? 0) * deltas[b]! ** 2 - (weights[a] ?? 0) * deltas[a]! ** 2 || a.localeCompare(b))
    .slice(0, 2);
  for (const k of diffs) {
    const s = differenceText(k, deltas[k]!, target, cand, part, profile);
    out.push(`${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
  }
  return out;
}

export function sourceKey(s: FingerprintSource): string {
  return s.kind === 'preset' ? `preset:${s.id}` : `sample:${s.path}`;
}

const PART_WORD: Partial<Record<InstrumentRole, string>> = { chord: 'chords', hat: 'hi-hat', openhat: 'open hat', keys: 'keys', strings: 'strings', brass: 'brass', fx: 'FX' };

export function rankMatches(targetFps: ReadonlyArray<SoundFingerprint | null | undefined>, candidates: readonly FingerprintEntry[], target: MatchTarget, opts: MatchOptions = {}): SoundMatch[] {
  const agg = aggregateFingerprints(targetFps);
  if (!agg) return [];
  const drum = isDrumTarget(target);
  const profile = profileFor(target);
  const weights = opts.weights ?? PROFILES[profile];
  const presetOf = opts.preset ?? defaultPreset;
  const pluginOf = opts.plugin ?? pluginById;
  const part = opts.partLabel ?? `the reference ${PART_WORD[target.role] ?? target.role}`;
  const limit = Math.max(1, Math.floor(opts.limit ?? 3));
  const scored: Array<{ m: SoundMatch; key: string }> = [];
  const seen = new Set<string>();
  for (const e of candidates) {
    if (!e || !usableFingerprint(e.fp)) continue;
    const key = sourceKey(e.source);
    if (seen.has(key)) continue;
    const factor = eligibility(e, target, presetOf);
    if (factor <= 0) continue;
    if (opts.allow && !opts.allow(e.source)) continue;
    let plugin: PluginDescriptor | undefined;
    let params: Record<string, number> = {};
    if (e.source.kind === 'preset') {
      const p = presetOf(e.source.id);
      if (!p) continue;
      plugin = pluginOf(p.plugin);
      params = p.params;
    } else plugin = pluginOf('krypt.sampler');
    seen.add(key);
    const cmp = compareFingerprints(agg, e.fp, weights, { drum, relCentroid: !drum });
    const similarity = Math.round(cmp.similarity * factor * 1000) / 1000;
    scored.push({
      key,
      m: {
        source: e.source,
        similarity,
        why: whyText(agg, e.fp, cmp.deltas, weights, similarity, part, profile, factor < 1),
        tweaks: tweaksFor(agg, e.fp, { plugin, params, drum, levelOffsetDb: opts.levelOffsetDb, attack: profile === 'chord' || profile === 'lead' || profile === 'fx', minCutoffHz: MIN_CUTOFF_HZ[target.role] }),
      },
    });
  }
  scored.sort((a, b) => b.m.similarity - a.m.similarity || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((s) => s.m);
}
