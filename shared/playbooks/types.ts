// Genre playbooks: how a finished, release-quality track in a genre is built,
// as data an agent follows step by step and review_song checks against.
// Sounds are asked for by ROLE (+ tags), never by preset id: get_playbook
// resolves them through shared/sounds/select.ts against the presets that
// exist. Pure TS.

import type { GenreId } from '../sounds/genres';
import type { ChainRole, InstrumentRole, SampleKind } from '../sounds/types';

/** One part (one Channel Rack channel) of the arrangement. */
export interface PlaybookPart {
  /** Channel name the agent creates, e.g. "Kick", "Supersaw", "Sub". Unique per playbook. */
  name: string;
  role: InstrumentRole;
  /** Preferred sound character, ranked by select.ts ("wide", "detuned"). */
  tags?: string[];
  /** Drums: which factory sample kind fits better than a synth preset. */
  sample?: SampleKind;
  /** Register in MIDI notes, e.g. [24, 43] for an 808. */
  range?: [number, number];
  /** How it's written: rhythm, register, velocity, which notes. One or two sentences. */
  writing: string;
  /** Insert chain role for this part (load with apply_chain), if any. */
  chain?: ChainRole;
  /** Route to this bus part name ("Drum Bus"). */
  bus?: string;
  /** Duck under this part (sidechain), e.g. "Kick". */
  duckUnder?: string;
}

/** A KPN example (write_pattern syntax) for one or more parts. ORIGINAL idioms, never a known song's riff. */
export interface PlaybookPattern {
  name: string;
  /** Which section(s) it suits, e.g. ['drop'] or ['verse', 'hook']. */
  for: string[];
  /** KPN lines for write_pattern, e.g. "Kick: x... x... x... x...". Bars at the playbook's grid (16ths unless noted). */
  kpn: string;
  notes?: string;
}

export type SectionKind = 'intro' | 'verse' | 'pre' | 'hook' | 'chorus' | 'build' | 'drop' | 'breakdown' | 'bridge' | 'break' | 'outro';

export type TransitionKind =
  | 'riser' // noise/synth uplifter over the last 2-8 bars
  | 'reverse-cymbal'
  | 'snare-roll' // 8ths → 16ths → 32nds (a pattern, not audio)
  | 'drum-fill'
  | 'filter-sweep' // high-pass / low-pass automation on the music bus or master
  | 'impact' // boom on the downbeat
  | 'downlifter'
  | 'sub-drop'
  | 'silence' // a beat or a half bar of nothing before the drop
  | 'crash' // crash on the downbeat
  | 'whoosh' // air / swish that ends on the downbeat
  | 'tape-stop' // the music slows to a halt into the boundary (breaks, endings)
  | 'swell'; // reverse-reverb / volume swell into the downbeat

export interface PlaybookSection {
  kind: SectionKind;
  /** Display label (e.g. "Drop 2"). */
  label: string;
  bars: number;
  /** 0..1 relative energy; review_song checks the rendered loudness follows this shape. */
  energy: number;
  /** Names of parts (PlaybookPart.name) that play. */
  parts: string[];
  /** Transitions INTO this section (at its first bar). */
  transitionIn?: TransitionKind[];
  /** What changes in this section (variations, automation, a filter opening). */
  notes?: string;
}

/** Numbers review_song measures a render against. */
export interface PlaybookTargets {
  /** Integrated loudness of the full song after the master chain, e.g. -8 (EDM) … -12 (lofi). */
  lufs: number;
  /** Max true peak, dBTP. */
  truePeakDb: number;
  /** Song length range in bars. */
  bars: [number, number];
  /**
   * Band balance relative to the mid band (500-2k), dB, as [min, max]: e.g. { sub: [-2, 6] } means the sub band sits
   * 2 dB under to 6 dB over the mids. Missing bands are not checked.
   */
  bands?: Partial<Record<'sub' | 'low' | 'lowMid' | 'highMid' | 'high', [number, number]>>;
  /** Loudest section minus quietest section, LU (energy contrast). */
  contrastLu?: [number, number];
  /** Stereo correlation lower bound of the full mix (wide but mono-safe). */
  minCorrelation?: number;
  /** Max bars a section may repeat the exact same clip content before review flags it as static. */
  maxStaticBars?: number;
  /** Drums need velocity variation (std dev in velocity units) at least this. */
  minHatVelocitySpread?: number;
}

/**
 * A groove template (shared/grooves, from the Groove MIDI Dataset) to apply with transform_notes
 * {op: "groove", template, amount, velocity} on the listed parts after writing their patterns.
 */
export interface PlaybookGroove {
  /** Template id: hiphop, funk, soul, jazz, shuffle, latin, reggae, afrobeat, rock, pop, dance. */
  template: string;
  /** Timing share of the template's offsets, 0..1. */
  amount: number;
  /** Velocity share of the template's accents, 0..1. */
  velocity: number;
  /** Part names it applies to (drums first; bass / keys where the genre swings them too). */
  parts: string[];
}

export interface Playbook {
  id: GenreId;
  name: string;
  /** One paragraph: the feel, the references in words (never artist names as targets to copy). */
  summary: string;
  bpm: { min: number; max: number; typical: number };
  /** Grid of the drum programming: 16 = 16th notes per bar (KPN default), 24 / 32 for triplet / 32nd hats. */
  grid?: number;
  /** Half-time feel at this tempo (trap, dubstep, future bass). */
  halfTime?: boolean;
  swing: number; // 0..100 (set_swing)
  keys: { modes: string[]; common: string[]; notes?: string };
  harmony: { progressions: string[]; rhythm: string; voicing: string };
  melody: string;
  /** The channels to build, in Channel Rack order. */
  parts: PlaybookPart[];
  patterns: PlaybookPattern[];
  arrangement: PlaybookSection[];
  mix: {
    /** Master chain role tags, e.g. { role: 'master', tags: ['loud'] } — resolved with select.ts. */
    master: { tags?: string[] };
    /** Buses to create (name → chain role), e.g. { name: 'Drum Bus', chain: 'drumBus' }. */
    buses?: Array<{ name: string; chain: ChainRole; tags?: string[] }>;
    /** Send effects, e.g. { name: 'Reverb', chain: 'reverbSend' } with the parts that send to it and how much (0..1). */
    sends?: Array<{ name: string; chain: ChainRole; tags?: string[]; from: Array<{ part: string; amount: number }> }>;
    /** Level plan, loudest first, in plain words ("Kick and 808 lead, clap -3 dB under the kick …"). */
    levels: string;
    notes?: string;
  };
  transitions: string;
  /** Things that make tracks in this genre sound amateur, phrased as checks. */
  mistakes: string[];
  targets: PlaybookTargets;
  /** How to humanise the programmed parts. */
  groove?: PlaybookGroove;
}
