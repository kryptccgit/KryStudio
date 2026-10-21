import type { GenreId } from './genres';
import type { RackKind, RackZone } from '../schema/rack';

export const INSTRUMENT_ROLES = [
  'kick',
  'snare',
  'clap',
  'hat',
  'openhat',
  'ride',
  'crash',
  'perc',
  'tom',
  '808',
  'sub',
  'bass',
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
  'fx',
  'texture',
] as const;
export type InstrumentRole = (typeof INSTRUMENT_ROLES)[number];

export const CHAIN_ROLES = [
  'master',
  'drumBus',
  'drums',
  'bass',
  'lead',
  'pad',
  'keys',
  'pluck',
  'vocal',
  'reverbSend',
  'delaySend',
  'character',
  'transition',
] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];

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

export interface PresetFx {
  type: string;
  params: Record<string, number>;
  mix?: number;
  enabled?: boolean;
  rack?: PresetRack;
}

export interface PresetRackInstrument {
  plugin: string;
  params: Record<string, number>;
  sample?: string;
}

export interface PresetRackChain {
  name: string;
  color?: string;
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  zone?: RackZone;
  choke?: number;
  instrument?: PresetRackInstrument;
  fx?: PresetFx[];
}

export interface PresetMacroMap {
  chain: number;
  target: 'instrument' | 'device' | 'chain';
  device?: number;
  param: string;
  min?: number;
  max?: number;
}

export interface PresetRack {
  kind: RackKind;
  chains: PresetRackChain[];
  macros?: Array<{ name?: string; maps?: PresetMacroMap[] }>;
  variations?: Array<{ name: string; values: number[] }>;
}

export interface InstrumentPreset {
  kind: 'instrument';
  id: string;
  name: string;
  plugin: string;
  params: Record<string, number>;
  sample?: string;
  requires?: string;
  channel?: {
    volumeDb?: number;
    pan?: number;
    mono?: boolean;
    glideMs?: number;
    rootKey?: number;
    cutGroup?: number;
    cutBy?: number;
  };
  fx?: PresetFx[];
  rack?: PresetRack;
  role: InstrumentRole;
  alsoRoles?: InstrumentRole[];
  tags: string[];
  genres: GenreId[];
  defaultFor?: GenreId[];
  description: string;
  range?: [number, number];
  author?: string;
}

export interface ChainPreset {
  kind: 'chain';
  id: string;
  name: string;
  role: ChainRole;
  fx: PresetFx[];
  insert?: { volumeDb?: number; pan?: number; stereoSep?: number };
  targetLufs?: number;
  tags: string[];
  genres: GenreId[];
  description: string;
  author?: string;
}

export type Preset = InstrumentPreset | ChainPreset;

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
  'riser',
  'downlifter',
  'impact',
  'sweep-up',
  'sweep-down',
  'reverse-cymbal',
  'sub-drop',
  'noise',
  'texture',
  'fill',
  'whoosh',
  'tape-stop',
  'swell',
  'zap',
  'vox',
  'foley',
  'ambience',
  'retro',
] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

export interface FactorySample {
  path: string;
  name: string;
  kind: SampleKind;
  tags: string[];
  genres: GenreId[];
  rootNote?: number;
  lengthSec: number;
  channels: 1 | 2;
  bpm?: number;
  bars?: number;
  peakDb: number;
}

export interface FactoryIndex {
  version: 1;
  generator: string;
  samples: FactorySample[];
}

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
