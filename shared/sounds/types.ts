// Sounds: instrument presets, effect-chain presets and the factory sample
// index. Contract shared by the preset data (shared/sounds/factory), the
// commands that apply presets (shared/commands/presets.ts), the main-process
// sounds service (electron/sounds), the MCP tools (find_presets, load_preset,
// save_preset, apply_chain, find_samples, add_transition, get_playbook) and the
// renderer's preset browser. Pure TS, no I/O.
//
// Param values are PLAIN units per the plugin's ParamSpec (shared/plugins/
// types.ts), exactly what channels.setGenParams / mixer.setSlotParams take.
// Params a preset doesn't list are the plugin's defaults (presets replace the
// whole param set; they never merge onto the previous sound).

import type { GenreId } from './genres';
import type { RackKind, RackZone } from '../schema/rack';

// ── Roles ─────────────────────────────────────────────────────────────

/**
 * What a sound is FOR in a song. One primary role per preset / sample; the
 * playbooks ask for sounds by role (+ genre + tags), never by preset id, so
 * presets can be added or renamed freely.
 */
export const INSTRUMENT_ROLES = [
  // drums & percussion (mostly samples; DrumSynth / sampler presets also exist)
  'kick',
  'snare',
  'clap',
  'hat',
  'openhat',
  'ride',
  'crash',
  'perc',
  'tom',
  // low end
  '808',
  'sub',
  'bass',
  // music
  'lead',
  'pluck',
  'pad',
  'keys',
  'piano',
  'bell',
  'arp',
  'stab',
  'chord',
  'strings',
  'brass',
  'vox',
  // ear candy
  'fx',
  'texture',
] as const;
export type InstrumentRole = (typeof INSTRUMENT_ROLES)[number];

/** Where an effect-chain preset goes. */
export const CHAIN_ROLES = [
  'master', // the master insert: tone, glue, clipper, limiter at a loudness target
  'drumBus', // a bus all drums route to
  'drums', // one drum channel's insert (kick punch, snare crack, hat shine)
  'bass', // 808 / bass insert
  'lead',
  'pad',
  'keys',
  'pluck',
  'vocal',
  'reverbSend', // a send/return insert holding 100% wet reverb
  'delaySend',
  'character', // lo-fi, tape, telephone, bitcrush style colour on any insert
  'transition', // filter-sweep / riser processing for an FX insert
] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];

/** Descriptive words presets and samples use (free-form tags are allowed too; these are the ones search ranks). */
export const COMMON_TAGS = [
  'dark',
  'bright',
  'warm',
  'cold',
  'soft',
  'hard',
  'aggressive',
  'clean',
  'dirty',
  'distorted',
  'wide',
  'mono',
  'big',
  'small',
  'short',
  'long',
  'punchy',
  'deep',
  'airy',
  'lofi',
  'vintage',
  'modern',
  'detuned',
  'evolving',
  'glide',
  'emotional',
  'euphoric',
  'dreamy',
  'gritty',
  'metallic',
  'organic',
  'retro',
] as const;

// ── Presets ───────────────────────────────────────────────────────────

/** One effect in a chain. `type` = a stock effect id ('krypt.eq' …). */
export interface PresetFx {
  type: string;
  /** Plain units; missing = defaults. */
  params: Record<string, number>;
  /** Wet/dry 0..1 (default: the effect's defaultMix). */
  mix?: number;
  enabled?: boolean;
  /** 'krypt.fxrack' only: the effect rack's chains + macros (macro values are `params.macro1..8`). */
  rack?: PresetRack;
}

// ── Racks inside presets (Wave 12.2, research/16 §2.3) ───────────────
// Id-free: chains, devices and macro targets are addressed by INDEX, and
// inner samples by path ('factory:…' / absolute), exactly like preset
// samples. shared/commands/racks.ts builds a RackDef from it (rackFromSpec);
// shared/sounds/rackSpec.ts captures one (rackToSpec). build_rack takes the
// same shape. v1: stock plugins only, no racks inside racks.

/** A chain's sound source (instrument / drum racks). */
export interface PresetRackInstrument {
  plugin: string;
  /** Plain units; missing = defaults. */
  params: Record<string, number>;
  /** Sample for sample-based instruments (sampler): a 'factory:…' or absolute path. */
  sample?: string;
}

export interface PresetRackChain {
  name: string;
  color?: string;
  /** Linear gain, 1 = 0 dB (default 1). */
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  /** Key / velocity zone (instrument and drum racks; absent = every note). Drum pads: keyLo = keyHi = the pad's note. */
  zone?: RackZone;
  /** Drum racks: pads in the same choke group > 0 cut each other. */
  choke?: number;
  instrument?: PresetRackInstrument;
  /** Effects after the instrument (effect racks: on the split input). No racks. */
  fx?: PresetFx[];
}

/** A macro mapping: chain index, then the instrument param, a device (index) param or 'mix', or the chain's volume / pan. */
export interface PresetMacroMap {
  chain: number;
  target: 'instrument' | 'device' | 'chain';
  device?: number;
  param: string;
  /** Normalized 0..1 range the macro sweeps (min > max inverts). Defaults 0 / 1. */
  min?: number;
  max?: number;
}

export interface PresetRack {
  kind: RackKind;
  chains: PresetRackChain[];
  /** Up to 8 macros in order (name + maps); missing ones keep their default names. */
  macros?: Array<{ name?: string; maps?: PresetMacroMap[] }>;
  /** Named snapshots of the 8 macro values. */
  variations?: Array<{ name: string; values: number[] }>;
}

/** A playable sound: an instrument with its params, optional sample and the insert chain it was designed with. */
export interface InstrumentPreset {
  kind: 'instrument';
  /** 'factory:<role>/<slug>' (factory) or 'user:<slug>' (saved by the user or an agent). Stable forever once shipped. */
  id: string;
  /** Short display name, e.g. "Anthem Supersaw". Unique within its role. */
  name: string;
  /** Stock instrument id ('krypt.wavetable', 'krypt.triosc', 'krypt.fm', 'krypt.kick808', 'krypt.drumsynth', 'krypt.sampler'). */
  plugin: string;
  params: Record<string, number>;
  /** 'factory:…' sample for 'krypt.sampler' presets, or 'pack:<id>/….sfz' for 'krypt.multisampler' presets. */
  sample?: string;
  /** A sound pack (shared/packs) the preset needs; it is hidden from agents' defaults until that pack is installed. */
  requires?: string;
  /** Channel settings the sound needs (an 808 is mono with glide; a sampler preset's root key). */
  channel?: {
    volumeDb?: number;
    pan?: number;
    mono?: boolean;
    glideMs?: number;
    rootKey?: number;
    cutGroup?: number;
    cutBy?: number;
  };
  /** The insert chain the sound was designed with (applied unless the caller says withFx: false). */
  fx?: PresetFx[];
  /** 'krypt.rack' / 'krypt.drumrack' presets: the rack (macro values are `params.macro1..8`). */
  rack?: PresetRack;
  role: InstrumentRole;
  /** Extra roles it also works as (a pluck that doubles as an arp). */
  alsoRoles?: InstrumentRole[];
  tags: string[];
  /** Genres it suits; [] = genre-neutral. */
  genres: GenreId[];
  /**
   * Genres where this is THE go-to sound for its role (the first pick when an agent asks for "a lead" in trap).
   * At most one preset per role + genre should claim a genre.
   */
  defaultFor?: GenreId[];
  /** One sentence: what it sounds like and when to use it. */
  description: string;
  /** MIDI range it sounds best in, e.g. [48, 84]. */
  range?: [number, number];
  author?: string;
}

/** An effect chain for an insert (master, a bus, a channel insert or a send). */
export interface ChainPreset {
  kind: 'chain';
  /** 'factory:chain/<role>/<slug>' or 'user:chain/<slug>'. */
  id: string;
  name: string;
  role: ChainRole;
  fx: PresetFx[];
  /** Insert settings that belong to the chain (a send return at -6 dB, a mono bass insert …). */
  insert?: { volumeDb?: number; pan?: number; stereoSep?: number };
  /** For master chains: the integrated loudness it is tuned to reach on a typical full mix, e.g. -9. */
  targetLufs?: number;
  tags: string[];
  genres: GenreId[];
  description: string;
  author?: string;
}

export type Preset = InstrumentPreset | ChainPreset;

/** A preset as listed by search (no params; cheap to send to the renderer / agents). */
export interface PresetSummary {
  id: string;
  kind: Preset['kind'];
  name: string;
  role: InstrumentRole | ChainRole;
  plugin?: string;
  tags: string[];
  genres: GenreId[];
  description: string;
  source: 'factory' | 'user';
  /** Sound pack the preset needs (shared/packs). */
  requires?: string;
}

export function summarizePreset(p: Preset): PresetSummary {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    role: p.role,
    plugin: p.kind === 'instrument' ? p.plugin : undefined,
    tags: [...p.tags],
    genres: [...p.genres],
    description: p.description,
    source: p.id.startsWith('user:') ? 'user' : 'factory',
    ...(p.kind === 'instrument' && p.requires ? { requires: p.requires } : {}),
  };
}

// ── Factory sample index (resources/factory/index.json) ───────────────

/** Sample kinds in the factory index. Drum kinds match the drum roles. */
export const SAMPLE_KINDS = [
  'kick',
  'snare',
  'clap',
  'hat',
  'openhat',
  'ride',
  'crash',
  'perc',
  'tom',
  'rim',
  'shaker',
  'snap',
  '808',
  'bass-oneshot',
  'stab-oneshot',
  'riser', // noise / synth uplifter, ends at its last bar line
  'downlifter',
  'impact', // boom / hit for a downbeat
  'sweep-up',
  'sweep-down',
  'reverse-cymbal', // swells into the next downbeat
  'sub-drop',
  'noise', // white/pink noise beds, wind
  'texture', // vinyl crackle, tape hiss, rain-like, room tone
  'fill', // drum fill / snare roll audio
  // Wave 7b (research/14): more transitions and FX. Engine-made ones live in the
  // factory; recorded CC0 ones come from sample packs (PackDef.samples).
  'whoosh', // pass-by air / swish; its loudest point is its END (crosses the boundary)
  'tape-stop', // the music slowing to a halt; ends at the boundary
  'swell', // reverse-reverb / volume swell that ends at the boundary
  'zap', // laser, blip, sci-fi and glitch one-shots
  'vox', // vocal one-shots and chops ("hey", breaths, formant blips)
  'foley', // recorded objects and hits (cassette clicks, paper, glass, keys)
  'ambience', // field recordings and rooms (rain, city, crowd, birds)
  'retro', // 8-bit / chiptune game sounds
] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

export interface FactorySample {
  /** 'factory:<folder>/<file>.wav' — what load_sample / samples.add accept. */
  path: string;
  /** Display name, e.g. "Punchy Kick 2". */
  name: string;
  kind: SampleKind;
  tags: string[];
  genres: GenreId[];
  /** MIDI note the sample sounds at (808s, tonal one-shots); absent for unpitched sounds. */
  rootNote?: number;
  lengthSec: number;
  channels: 1 | 2;
  /**
   * Tempo-synced FX and loops: written at `bpm`, `bars` long, so an audio clip with tempo_sync on and src_bpm = bpm
   * spans exactly `bars` bars at any project tempo. Risers / reverse cymbals END on their last bar line.
   */
  bpm?: number;
  bars?: number;
  /** Peak level it was normalised to (dBFS). */
  peakDb: number;
}

export interface FactoryIndex {
  version: 1;
  /** e.g. "krypt-studio-engine 0.1.0". */
  generator: string;
  samples: FactorySample[];
}

/** The sample paths every older project uses: the generator must always write these. */
export const LEGACY_FACTORY_PATHS = [
  'factory:drums/808.wav',
  'factory:drums/clap.wav',
  'factory:drums/crash.wav',
  'factory:drums/hat-closed.wav',
  'factory:drums/hat-open.wav',
  'factory:drums/kick-2.wav',
  'factory:drums/kick.wav',
  'factory:drums/perc.wav',
  'factory:drums/rim.wav',
  'factory:drums/snare.wav',
  'factory:drums/tom.wav',
] as const;
