// ──────────────────────────────────────────────────────────────────────
// "More like this" (research/13 §12.1): rank the library's sounds by how
// close they are to ONE sound's timbre fingerprint, Ableton-style sound
// similarity search. Pure + deterministic (same inputs, same order); the
// I/O (index, pack cache, analyzer, file access) lives in
// electron/sounds/similar.ts.
//
//   rankSimilar(fp, kind, candidates, opts) → SimilarHit[]
//
// kind: what the source sound is (a preset role, a sample kind, or null =
// unknown, e.g. a user file named "sample_01.wav": inferSampleKind() guesses
// it from its nearest factory neighbours). The kind picks the feature
// weights (match.ts PROFILES: a kick is compared on sub, decay, click …)
// and, with scope 'same', which candidates are eligible: the same kind and
// its close relatives (a kick finds kicks and kick presets; a riser finds
// risers, sweeps and swells). scope 'any' ranks everything by timbre alone.
// ──────────────────────────────────────────────────────────────────────

import { factoryPreset } from '../sounds/factory';
import type { InstrumentPreset, InstrumentRole, SampleKind } from '../sounds/types';
import { compareFingerprints, FEATURE_KEYS, PROFILES, profileFor, usableFingerprint, type FeatureKey, type FeatureWeights, type MatchProfile } from './features';
import { FAMILY_FACTOR, ROLE_FAMILY, sampleKindsFor, sourceKey } from './match';
import type { FingerprintEntry, FingerprintSource, SoundFingerprint } from './types';

/** What the source sound is. sampleKind null = unknown (a user file with no telling name). */
export type SimilarKind = { kind: 'preset'; role: InstrumentRole } | { kind: 'sample'; sampleKind: SampleKind | null };

export type SimilarScope = 'same' | 'any';

/** How a candidate relates to the source's kind. */
export type SimilarRelation = 'exact' | 'family' | 'other';

export interface SimilarHit {
  source: FingerprintSource;
  /** 0..1 (× FAMILY_FACTOR for a related kind with scope 'same'). */
  similarity: number;
  /** One short line: "darker, shorter tail" / "nearly identical" / "close on brightness and length". */
  why: string;
  relation: SimilarRelation;
}

export interface SimilarOptions {
  /** 'same' (default): the source's kind and its relatives only. 'any': every kind, by timbre alone. */
  scope?: SimilarScope;
  /** Which candidates: samples, presets or both (default). */
  want?: 'samples' | 'presets' | 'all';
  /** Best N (default 30, max 200). */
  limit?: number;
  /** The source itself (never proposed). */
  exclude?: FingerprintSource | null;
  /** Extra filter (pack installed, file on disk …). */
  allow?: (s: FingerprintSource) => boolean;
  /** Preset lookup for alsoRoles / kits; default the factory presets. */
  preset?: (id: string) => InstrumentPreset | undefined;
  /** Override the feature weights (tests). */
  weights?: FeatureWeights;
}

// ── Kinds ─────────────────────────────────────────────────────────────

/** Sample kinds that count as "the same kind" as a sample kind: the exact kind first, then close relatives. */
export const SAMPLE_FAMILY: Record<SampleKind, SampleKind[]> = {
  kick: ['kick'],
  snare: ['snare', 'clap', 'rim'],
  clap: ['clap', 'snare', 'snap'],
  hat: ['hat', 'shaker'],
  openhat: ['openhat', 'ride'],
  ride: ['ride', 'openhat', 'crash'],
  crash: ['crash', 'ride'],
  perc: ['perc', 'rim', 'shaker', 'tom', 'snap'],
  tom: ['tom', 'perc'],
  rim: ['rim', 'perc', 'snare', 'snap'],
  shaker: ['shaker', 'hat', 'perc'],
  snap: ['snap', 'clap', 'rim'],
  '808': ['808', 'bass-oneshot'],
  'bass-oneshot': ['bass-oneshot', '808'],
  'stab-oneshot': ['stab-oneshot'],
  riser: ['riser', 'sweep-up', 'swell', 'reverse-cymbal'],
  downlifter: ['downlifter', 'sweep-down', 'sub-drop'],
  impact: ['impact', 'sub-drop'],
  'sweep-up': ['sweep-up', 'riser', 'whoosh'],
  'sweep-down': ['sweep-down', 'downlifter', 'whoosh'],
  'reverse-cymbal': ['reverse-cymbal', 'swell', 'riser'],
  'sub-drop': ['sub-drop', 'impact', 'downlifter'],
  noise: ['noise', 'texture'],
  texture: ['texture', 'noise', 'ambience'],
  fill: ['fill'],
  whoosh: ['whoosh', 'sweep-up', 'sweep-down'],
  'tape-stop': ['tape-stop'],
  swell: ['swell', 'reverse-cymbal', 'riser'],
  zap: ['zap', 'retro'],
  vox: ['vox'],
  foley: ['foley', 'perc'],
  ambience: ['ambience', 'texture'],
  retro: ['retro', 'zap'],
};

/** Preset roles that play the same part as a sample kind (a kick sample also finds kick presets). */
const SAMPLE_ROLES: Partial<Record<SampleKind, InstrumentRole[]>> = {
  kick: ['kick'],
  snare: ['snare', 'clap'],
  clap: ['clap', 'snare'],
  hat: ['hat'],
  openhat: ['openhat', 'ride'],
  ride: ['ride', 'openhat'],
  crash: ['crash', 'ride'],
  perc: ['perc', 'tom'],
  tom: ['tom', 'perc'],
  rim: ['perc'],
  shaker: ['hat', 'perc'],
  snap: ['clap'],
  '808': ['808', 'sub', 'bass'],
  'bass-oneshot': ['bass', '808', 'sub'],
  'stab-oneshot': ['stab', 'chord'],
  vox: ['vox'],
  texture: ['texture'],
  noise: ['texture', 'fx'],
};

/** The roles + sample kinds that count as "the same kind" as the source (exact first). Unknown kind = nothing. */
export function similarKinds(k: SimilarKind): { roles: InstrumentRole[]; kinds: SampleKind[] } {
  if (k.kind === 'preset') return { roles: [...(ROLE_FAMILY[k.role] ?? [k.role])], kinds: sampleKindsFor({ kind: 'instrument', role: k.role }) };
  if (!k.sampleKind) return { roles: [], kinds: [] };
  return { roles: [...(SAMPLE_ROLES[k.sampleKind] ?? [])], kinds: [...(SAMPLE_FAMILY[k.sampleKind] ?? [k.sampleKind])] };
}

/** A full drum kit on one channel (GM layout): never "like" one sound. */
function isKit(p: InstrumentPreset | undefined): boolean {
  return !!p && p.role === 'kick' && ['snare', 'hat'].every((r) => (p.alsoRoles ?? []).includes(r as InstrumentRole));
}

function defaultPreset(id: string): InstrumentPreset | undefined {
  const p = factoryPreset(id);
  return p && p.kind === 'instrument' ? p : undefined;
}

/** How a candidate relates to the source's kind; null = never a candidate (a drum kit preset). */
export function relationOf(entry: FingerprintEntry, k: SimilarKind, preset: (id: string) => InstrumentPreset | undefined = defaultPreset): SimilarRelation | null {
  const fam = similarKinds(k);
  const src = entry.source;
  if (src.kind === 'sample') {
    const i = fam.kinds.indexOf(src.sampleKind);
    if (i < 0) return 'other';
    // The exact kind: the first of the family, or a preset source's own role played by a sample (a kick preset → kick samples).
    return i === 0 || (k.kind === 'preset' && src.sampleKind === (k.role as string)) ? 'exact' : 'family';
  }
  const p = preset(src.id);
  if (isKit(p)) return null;
  const roles = [src.role, ...(p?.alsoRoles ?? [])];
  const exactRole = k.kind === 'preset' ? k.role : fam.roles[0];
  if (exactRole && roles.includes(exactRole)) return 'exact';
  return roles.some((r) => fam.roles.includes(r)) ? 'family' : 'other';
}

// ── Weights ───────────────────────────────────────────────────────────

/** Feature profile per sample kind (match.ts PROFILES). */
const SAMPLE_PROFILE: Record<SampleKind, MatchProfile> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'snare',
  snap: 'snare',
  rim: 'perc',
  hat: 'hat',
  openhat: 'hat',
  ride: 'hat',
  crash: 'hat',
  shaker: 'hat',
  perc: 'perc',
  tom: 'perc',
  foley: 'perc',
  '808': 'bass',
  'bass-oneshot': 'bass',
  'stab-oneshot': 'chord',
  vox: 'lead',
  retro: 'lead',
  riser: 'fx',
  downlifter: 'fx',
  impact: 'fx',
  'sweep-up': 'fx',
  'sweep-down': 'fx',
  'reverse-cymbal': 'fx',
  'sub-drop': 'fx',
  noise: 'fx',
  texture: 'fx',
  fill: 'fx',
  whoosh: 'fx',
  'tape-stop': 'fx',
  swell: 'fx',
  zap: 'fx',
  ambience: 'fx',
};

/** Weights for a sound of unknown kind: every audible trait a little. */
export const GENERAL_WEIGHTS: FeatureWeights = { centroid: 2, decay: 2, flatness: 1.5, harmonicity: 1, sustain: 1, attack: 1, rolloff: 1, sub: 0.75, low: 0.75, lowMid: 0.5, mid: 0.5, highMid: 0.5, high: 0.75, crest: 0.5, f0: 0.5, width: 0.25 };

const DRUM_PROFILES: ReadonlySet<string> = new Set(['kick', 'snare', 'hat', 'perc']);

/** The feature profile for a source kind ('general' when unknown). */
export function similarProfile(k: SimilarKind): { profile: MatchProfile | 'general'; weights: FeatureWeights; drum: boolean } {
  const profile = k.kind === 'preset' ? profileFor({ kind: 'instrument', role: k.role }) : k.sampleKind ? SAMPLE_PROFILE[k.sampleKind] : 'general';
  const weights = profile === 'general' ? GENERAL_WEIGHTS : PROFILES[profile];
  return { profile, weights, drum: DRUM_PROFILES.has(profile) };
}

// ── Why (one short line) ──────────────────────────────────────────────

/** Features that say the same thing to the ear: only the strongest of a group is named. */
const WHY_GROUP: Partial<Record<FeatureKey, string>> = { centroid: 'bright', rolloff: 'bright', high: 'bright', decay: 'length', sustain: 'length', sub: 'low', low: 'low' };

function diffWord(key: FeatureKey, more: boolean, profile: string, cand: SoundFingerprint): string {
  switch (key) {
    case 'centroid':
      return more ? 'brighter' : 'darker';
    case 'rolloff':
      return more ? 'more top end' : 'less top end';
    case 'flatness':
      return profile === 'bass' ? (more ? 'grittier' : 'cleaner') : more ? 'noisier' : 'cleaner';
    case 'harmonicity':
      return more ? 'more tonal' : 'less tonal';
    case 'f0':
      return more ? 'higher pitched' : cand.f0Hz ? 'lower pitched' : 'unpitched';
    case 'attack':
      return more ? 'softer attack' : 'snappier attack';
    case 'decay':
      return more ? 'longer tail' : 'shorter tail';
    case 'sustain':
      return more ? 'more sustained' : 'more percussive';
    case 'sub':
      return more ? 'more sub' : 'less sub';
    case 'low':
      return more ? 'more low end' : 'less low end';
    case 'lowMid':
      return more ? 'fuller low-mids' : 'thinner low-mids';
    case 'mid':
      return more ? 'more mids' : 'fewer mids';
    case 'highMid':
      return profile === 'kick' ? (more ? 'more click' : 'less click') : more ? 'more presence' : 'less presence';
    case 'high':
      return more ? 'more air' : 'less air';
    case 'crest':
      return more ? 'punchier' : 'more compressed';
    case 'width':
      return more ? 'wider' : 'narrower';
  }
}

function closeNoun(key: FeatureKey): string {
  switch (key) {
    case 'centroid':
    case 'rolloff':
    case 'high':
      return 'brightness';
    case 'decay':
    case 'sustain':
      return 'length';
    case 'attack':
      return 'attack';
    case 'flatness':
      return 'noise';
    case 'harmonicity':
    case 'f0':
      return 'pitch';
    case 'crest':
      return 'punch';
    case 'width':
      return 'width';
    default:
      return 'tone';
  }
}

/**
 * One short line about how a candidate differs from the source (z > 0 = the candidate has more): the two biggest
 * weighted differences of distinct kinds ("darker, shorter tail"); "nearly identical" when there's no audible one;
 * otherwise what is close ("close on brightness and length").
 */
export function shortWhy(cand: SoundFingerprint, deltas: Partial<Record<FeatureKey, number>>, weights: FeatureWeights, similarity: number, profile: string): string {
  if (similarity >= 0.97) return 'nearly identical';
  const keys = (Object.keys(deltas) as FeatureKey[]).filter((k) => (weights[k] ?? 0) > 0);
  const score = (k: FeatureKey) => (weights[k] ?? 0) * deltas[k]! ** 2;
  const words: string[] = [];
  const groups = new Set<string>();
  for (const k of keys.filter((x) => Math.abs(deltas[x]!) >= 0.5).sort((a, b) => score(b) - score(a) || FEATURE_KEYS.indexOf(a) - FEATURE_KEYS.indexOf(b))) {
    const g = WHY_GROUP[k] ?? k;
    if (groups.has(g)) continue;
    groups.add(g);
    words.push(diffWord(k, deltas[k]! > 0, profile, cand));
    if (words.length === 2) break;
  }
  if (words.length) return words.join(', ');
  const close = [...new Set(keys.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || FEATURE_KEYS.indexOf(a) - FEATURE_KEYS.indexOf(b)).map(closeNoun).filter((n) => n !== 'tone'))].slice(0, 2);
  return close.length ? `close on ${close.join(' and ')}` : 'very close';
}

// ── Ranking ───────────────────────────────────────────────────────────

/**
 * The library sounds closest to one fingerprint, best first. Candidates with an unusable fingerprint, the source
 * itself, drum kits, ones `allow` refuses and (scope 'same') other kinds are skipped. similarity = exp(-d²/2) over
 * the kind's weighted feature deltas (compareFingerprints), × FAMILY_FACTOR for a related kind with scope 'same'.
 * An unknown kind with scope 'same' falls back to 'any'. Ties break on the source key (deterministic).
 */
export function rankSimilar(fp: SoundFingerprint, k: SimilarKind, candidates: readonly FingerprintEntry[], opts: SimilarOptions = {}): SimilarHit[] {
  if (!usableFingerprint(fp)) return [];
  const { profile, weights: base, drum } = similarProfile(k);
  const weights = opts.weights ?? base;
  const presetOf = opts.preset ?? defaultPreset;
  const unknown = k.kind === 'sample' && !k.sampleKind;
  const scope: SimilarScope = unknown ? 'any' : (opts.scope ?? 'same');
  const want = opts.want ?? 'all';
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 30)));
  const skip = opts.exclude ? sourceKey(opts.exclude) : null;
  const seen = new Set<string>();
  const scored: Array<{ hit: SimilarHit; key: string }> = [];
  for (const e of candidates) {
    if (!e || !usableFingerprint(e.fp)) continue;
    if (want === 'samples' && e.source.kind !== 'sample') continue;
    if (want === 'presets' && e.source.kind !== 'preset') continue;
    const key = sourceKey(e.source);
    if (key === skip || seen.has(key)) continue;
    const relation = relationOf(e, k, presetOf);
    if (!relation) continue;
    if (scope === 'same' && relation === 'other') continue;
    if (opts.allow && !opts.allow(e.source)) continue;
    seen.add(key);
    const cmp = compareFingerprints(fp, e.fp, weights, { drum, relCentroid: !drum });
    const factor = scope === 'same' && relation === 'family' ? FAMILY_FACTOR : 1;
    const similarity = Math.round(cmp.similarity * factor * 1000) / 1000;
    scored.push({ key, hit: { source: e.source, similarity, why: shortWhy(e.fp, cmp.deltas, weights, cmp.similarity, profile), relation } });
  }
  scored.sort((a, b) => b.hit.similarity - a.hit.similarity || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((s) => s.hit);
}

/**
 * The likely kind of a sound nobody named, from its nearest factory samples (a similarity-weighted vote of the
 * closest `k`, timbre alone). null when there are no sample candidates.
 */
export function inferSampleKind(fp: SoundFingerprint, candidates: readonly FingerprintEntry[], k = 7): { kind: SampleKind; confidence: number } | null {
  const near = rankSimilar(fp, { kind: 'sample', sampleKind: null }, candidates, { scope: 'any', want: 'samples', limit: k });
  if (!near.length) return null;
  const votes = new Map<SampleKind, number>();
  let total = 0;
  for (const h of near) {
    if (h.source.kind !== 'sample') continue;
    votes.set(h.source.sampleKind, (votes.get(h.source.sampleKind) ?? 0) + h.similarity);
    total += h.similarity;
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best && total > 0 ? { kind: best[0], confidence: Math.round((best[1] / total) * 100) / 100 } : null;
}
