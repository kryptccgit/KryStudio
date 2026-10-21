import fs from 'node:fs';
import path from 'node:path';
import type { MainDeps } from '../types';
import { FACTORY_KIT } from '@shared/schema/factory';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import { genreInText, resolveGenre, type GenreId } from '@shared/sounds/genres';
import { rankPresets, rankSamples, roleFromName } from '@shared/sounds/select';
import { INSTRUMENT_ROLES, type FactoryIndex, type FactorySample, type InstrumentPreset, type InstrumentRole, type Preset, type SampleKind } from '@shared/sounds/types';
import { factoryIndexReader, type IndexReader } from '../../sounds/factoryIndex';
import { missingPack } from '../../packs/gating';
import { findPluginRef, norm } from './util';

export interface InstrumentChoice {
  type: string;
  sample?: string;
  params?: Record<string, number>;
  label: string;
  preset?: InstrumentPreset;
  role?: InstrumentRole | null;
}

export interface SoundLibrary {
  presets: readonly Preset[];
  index: FactoryIndex | null;
  note?: string;
}

const NO_SERVICE_NOTE = "Krypt Studio's sounds service isn't running in this session, so only the built-in factory presets are listed (no user presets).";

const readers = new Map<string, IndexReader>();

export function factoryRoot(deps: Pick<MainDeps, 'project'>): string | null {
  try {
    const probe = deps.project.resolveSamplePath('factory:index.json');
    return probe ? path.dirname(probe) : null;
  } catch {
    return null;
  }
}

export function factoryIndexOf(deps: MainDeps): FactoryIndex | null {
  if (deps.sounds) {
    try {
      return deps.sounds.factoryIndex();
    } catch {
      return null;
    }
  }
  const root = factoryRoot(deps);
  if (!root) return null;
  let r = readers.get(root);
  if (!r) readers.set(root, (r = factoryIndexReader(root, (level, m) => deps.log(level, m))));
  return r.read();
}

export function soundLibrary(deps: MainDeps): SoundLibrary {
  if (deps.sounds) {
    try {
      return { presets: deps.sounds.presets(), index: factoryIndexOf(deps) };
    } catch (e) {
      deps.log('warn', `[sounds] preset list failed, using the factory data: ${(e as Error).message}`);
    }
  }
  return { presets: FACTORY_PRESETS, index: factoryIndexOf(deps), note: NO_SERVICE_NOTE };
}

export function instrumentPresets(presets: readonly Preset[]): InstrumentPreset[] {
  return presets.filter((p): p is InstrumentPreset => p.kind === 'instrument');
}

export function genreContext(deps: MainDeps): GenreId | null {
  const g = deps.doc.project.meta.genre ?? '';
  const fromMeta = resolveGenre(g) ?? (g.trim() ? genreInText(g) : null);
  if (fromMeta) return fromMeta;
  let focus: { name?: string; brief?: string } | null = null;
  try {
    focus = deps.library?.focus() ?? deps.getSettings().library?.focus ?? null;
  } catch {
    focus = null;
  }
  return focus ? genreInText(`${focus.brief ?? ''} ${focus.name ?? ''}`) : null;
}

function fileExists(deps: MainDeps, sample: string): boolean {
  try {
    const abs = deps.project.resolveSamplePath(sample);
    return !!abs && fs.existsSync(abs);
  } catch {
    return false;
  }
}

export function presetPlayable(deps: MainDeps, p: InstrumentPreset): boolean {
  if (missingPack(deps.packs, p)) return false;
  return !p.sample || fileExists(deps, p.sample);
}

export function bestPreset(deps: MainDeps, presets: readonly Preset[], role: InstrumentRole, genre: GenreId | null, plugin?: string, words?: string): InstrumentPreset | null {
  const ranked = rankPresets(instrumentPresets(presets), { role, genre: genre ?? undefined, plugin, kind: 'instrument', text: words }, 60);
  const distinct = (words ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !GENERIC_NAME_WORDS.has(w) && !(INSTRUMENT_ROLES as readonly string[]).includes(w));
  if (distinct.length) {
    const named = ranked.find((p) => presetPlayable(deps, p) && distinct.some((w) => `${p.name} ${p.tags.join(' ')} ${p.description}`.toLowerCase().includes(w)));
    if (named) return named;
  }
  return ranked.find((p) => presetPlayable(deps, p)) ?? null;
}

const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set(['synth', 'sound', 'main', 'new', 'track', 'channel', 'line', 'part', 'layer', 'melody', 'hook', 'leads', 'pads', 'plucks', 'chords', 'bells', 'arps', 'stabs', 'the', 'and', 'for', 'drop', 'intro', 'verse', 'chorus', 'outro', 'build']);

const DRUM_ROLES: ReadonlySet<InstrumentRole> = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc', 'tom']);

const KINDS_FOR_ROLE: Partial<Record<InstrumentRole, SampleKind[]>> = {
  kick: ['kick'],
  snare: ['snare'],
  clap: ['clap', 'snap'],
  hat: ['hat'],
  openhat: ['openhat'],
  ride: ['ride'],
  crash: ['crash'],
  perc: ['perc', 'rim', 'shaker'],
  tom: ['tom'],
};

const LEGACY_KIT: Partial<Record<InstrumentRole, string>> = {
  kick: FACTORY_KIT.kick,
  snare: FACTORY_KIT.snare,
  clap: FACTORY_KIT.clap,
  hat: FACTORY_KIT.hat,
  openhat: FACTORY_KIT.openHat,
  crash: 'factory:drums/crash.wav',
  ride: 'factory:drums/crash.wav',
  perc: 'factory:drums/perc.wav',
  tom: 'factory:drums/tom.wav',
};

const DRUM_VOICE: Record<string, number> = { kick: 0, snare: 1, clap: 2, hat: 3, openhat: 4, tom: 5, rim: 6, cowbell: 7 };

export const SYNTH_PRESETS: Array<{ match: RegExp; label: string; params: Record<string, number> }> = [
  { match: /(reese|wobble|bass|sub)/, label: 'TriOsc bass', params: { osc1Shape: 2, osc2Shape: 3, osc2Fine: 5, osc3Shape: 0, osc3Coarse: -12, osc3Level: 0.6, cutoff: 1400, reso: 0.2, ampAttack: 1, ampSustain: 0.9, ampRelease: 80, filterEnvAmount: 0.25, gain: -6 } },
  { match: /(pad|string|choir|atmos|ambient|drone|swell)/, label: 'TriOsc pad', params: { osc1Shape: 2, osc2Shape: 2, osc2Fine: 12, osc3Shape: 1, osc3Coarse: 12, osc3Level: 0.3, unisonDetune: 0.35, cutoff: 3200, reso: 0.1, ampAttack: 450, ampDecay: 1200, ampSustain: 0.8, ampRelease: 1200, filterEnvAmount: 0.1, gain: -9 } },
  { match: /(pluck|bell|arp|marimba|kalimba|harp)/, label: 'TriOsc pluck', params: { osc1Shape: 1, osc2Shape: 2, osc2Fine: 4, osc3Level: 0.2, cutoff: 5000, reso: 0.2, ampAttack: 0.5, ampDecay: 280, ampSustain: 0, ampRelease: 220, filterEnvAmount: 0.5, filterEnvDecay: 220, gain: -6 } },
  { match: /(key|chord|piano|rhodes|organ|epiano|ep)/, label: 'TriOsc keys', params: { osc1Shape: 1, osc2Shape: 0, osc2Fine: 3, osc3Shape: 0, osc3Coarse: 12, osc3Level: 0.25, cutoff: 4200, reso: 0.05, ampAttack: 3, ampDecay: 900, ampSustain: 0.45, ampRelease: 350, filterEnvAmount: 0.2, gain: -8 } },
  { match: /(lead|melody|synth|saw|hook|vox|vocal)/, label: 'TriOsc lead', params: { osc1Shape: 2, osc2Shape: 2, osc2Fine: 9, osc3Shape: 3, osc3Coarse: 12, osc3Level: 0.25, unisonDetune: 0.2, cutoff: 6500, reso: 0.15, ampAttack: 2, ampSustain: 0.8, ampRelease: 180, gain: -8 } },
];

function drumKind(n: string): string | null {
  if (/^(kick|bd|bassdrum|kickdrum|kik)/.test(n)) return 'kick';
  if (/^(openhat|oh|ohh|openhihat|open)/.test(n)) return 'openhat';
  if (/(hat|^hh|hihat|^chh)/.test(n)) return 'hat';
  if (/(snare|^sd|^snr)/.test(n)) return 'snare';
  if (/(clap|^cp)/.test(n)) return 'clap';
  if (/(rim|stick)/.test(n)) return 'rim';
  if (/(tom|conga|bongo)/.test(n)) return 'tom';
  if (/(cowbell)/.test(n)) return 'cowbell';
  if (/(perc|shaker|tamb)/.test(n)) return 'perc';
  if (/(crash|cymbal)/.test(n)) return 'crash';
  if (/ride/.test(n)) return 'ride';
  return null;
}

export function roleForName(name: string): InstrumentRole | null {
  const r = roleFromName(name);
  if (r) return r;
  const k = drumKind(norm(name));
  if (!k) return null;
  return k === 'rim' || k === 'cowbell' ? 'perc' : (k as InstrumentRole);
}

export function bestDrumSample(deps: MainDeps, index: FactoryIndex | null, role: InstrumentRole, genre: GenreId | null, name?: string): FactorySample | null {
  if (!index) return null;
  for (const kind of KINDS_FOR_ROLE[role] ?? []) {
    const hits = rankSamples(index.samples, { kind, genre: genre ?? undefined, text: name }, 6);
    const ok = hits.find((x) => fileExists(deps, x.path));
    if (ok) return ok;
  }
  return null;
}

function drumChoice(deps: MainDeps, lib: SoundLibrary, role: InstrumentRole, genre: GenreId | null, name: string, forceSampler: boolean): InstrumentChoice | null {
  const s = bestDrumSample(deps, lib.index, role, genre, name);
  if (s) return { type: 'krypt.sampler', sample: s.path, label: `Krypt Sampler (${s.name})`, role };
  const legacy = LEGACY_KIT[role];
  if (legacy && fileExists(deps, legacy)) return { type: 'krypt.sampler', sample: legacy, label: `Krypt Sampler (${legacy.replace('factory:', '')})`, role };
  if (forceSampler) return null;
  const k = drumKind(norm(name));
  const voiceKey = role === 'perc' ? (k === 'cowbell' ? 'cowbell' : 'rim') : role === 'crash' || role === 'ride' ? 'openhat' : role;
  return { type: 'krypt.drumsynth', params: { voice: DRUM_VOICE[voiceKey] ?? 6 }, label: `Krypt DrumSynth (${voiceKey})`, role };
}

function presetChoice(p: InstrumentPreset, role: InstrumentRole | null): InstrumentChoice {
  return { type: p.plugin, label: `preset ${p.name}`, preset: p, role, sample: p.sample };
}

export function chooseInstrument(deps: MainDeps, name: string, inst: string | undefined, gridLine: boolean, usePresets = true): InstrumentChoice {
  const role = roleForName(name);
  const lib: SoundLibrary = usePresets ? soundLibrary(deps) : { presets: [], index: factoryIndexOf(deps) };
  const genre = genreContext(deps);
  if (inst) {
    const p = findPluginRef(deps.doc.catalog, inst, 'instrument');
    if (p.id === 'krypt.sampler') {
      const drum = role && DRUM_ROLES.has(role) ? drumChoice(deps, lib, role, genre, name, true) : null;
      if (drum) return drum;
      const sp = role ? bestPreset(deps, lib.presets, role, genre, p.id, name) : null;
      if (sp) return presetChoice(sp, role);
      const kick = fileExists(deps, FACTORY_KIT.kick) ? FACTORY_KIT.kick : undefined;
      return { type: p.id, sample: kick, label: p.name, role };
    }
    if (p.id === 'krypt.drumsynth') {
      const k = drumKind(norm(name)) ?? (role && DRUM_ROLES.has(role) ? role : null);
      const voice = k === 'perc' ? 'rim' : k ?? 'rim';
      return { type: p.id, params: { voice: DRUM_VOICE[voice] ?? 6 }, label: `${p.name} (${voice})`, role };
    }
    const pp = role ? bestPreset(deps, lib.presets, role, genre, p.id, name) : null;
    if (pp) return presetChoice(pp, role);
    return { type: p.id, label: p.name, role };
  }

  if (role && DRUM_ROLES.has(role)) return drumChoice(deps, lib, role, genre, name, false)!;

  if (role === '808') {
    const p = bestPreset(deps, lib.presets, '808', genre, undefined, name);
    if (p) return presetChoice(p, role);
    return { type: 'krypt.kick808', label: 'Krypt 808 (mono + glide)', role };
  }

  if (role) {
    const p = bestPreset(deps, lib.presets, role, genre, undefined, name);
    if (p) return presetChoice(p, role);
  } else if (gridLine) {
    return { type: 'krypt.drumsynth', params: { voice: 6 }, label: 'Krypt DrumSynth (rim/perc)', role: null };
  } else {
    const p = bestPreset(deps, lib.presets, 'keys', genre);
    if (p) return presetChoice(p, null);
  }
  const n = norm(name);
  const legacy = SYNTH_PRESETS.find((s) => s.match.test(n));
  if (legacy) return { type: 'krypt.triosc', params: legacy.params, label: legacy.label, role };
  return { type: 'krypt.triosc', label: 'Krypt TriOsc', role };
}
