import { z } from 'zod';
import { PPQ } from '../../schema/time';

export const GENERATOR_KINDS = ['rhythm', 'chords', 'arp', 'melody', 'bass'] as const;
export type GeneratorKind = (typeof GENERATOR_KINDS)[number];

export const GENERATOR_LABELS: Record<GeneratorKind, string> = { rhythm: 'Rhythm', chords: 'Chords', arp: 'Arpeggio', melody: 'Melody', bass: 'Bassline' };

export const RATES = ['4th', '8th', '8thT', '16th', '16thT', '32nd'] as const;
export type Rate = (typeof RATES)[number];
export const RATE_TICKS: Record<Rate, number> = { '4th': PPQ, '8th': PPQ / 2, '8thT': PPQ / 3, '16th': PPQ / 4, '16thT': PPQ / 6, '32nd': PPQ / 8 };
export const RATE_LABELS: Record<Rate, string> = { '4th': '1/4', '8th': '1/8', '8thT': '1/8 triplet', '16th': '1/16', '16thT': '1/16 triplet', '32nd': '1/32' };

const zRate = z.enum(RATES);
const zVel = (d: number) => z.number().min(0.05).max(1).default(d);
const zProgression = z.string().max(160).default('auto').describe('A preset (pop, sad, epic, dark, jazzy, lofi, house, circle), "auto" (the seed picks one) or numerals in the key: "i VI III VII", "ii7 V7 Imaj7", "1 5 6 4".');
const zExtensions = z.enum(['auto', 'triads', 'sevenths', 'ninths']).default('auto');
const zBarsPerChord = z.union([z.literal(0.5), z.literal(1), z.literal(2), z.literal(4)]).default(1);
const zChordSource = z.enum(['auto', 'pattern', 'progression']).default('auto').describe('auto: the chords already in the pattern (any channel), else the progression.');

export const RHYTHM_OPTIONS = z.strictObject({
  mode: z.enum(['euclid', 'density']).default('euclid').describe('euclid: `pulses` spread evenly over `steps`; density: hits by metric weight.'),
  steps: z.number().int().min(1).max(64).default(16),
  pulses: z.number().int().min(0).max(64).default(5),
  rotation: z.number().int().min(0).max(63).default(0),
  rate: zRate.default('16th'),
  density: z.number().min(0).max(1).default(0.5),
  accents: z.enum(['none', 'downbeats', 'backbeat', 'offbeats', 'random']).default('downbeats'),
  ghosts: z.number().min(0).max(1).default(0).describe('Chance of soft ghost notes on empty steps.'),
  rolls: z.number().min(0).max(1).default(0).describe('Chance of 32nd rolls (hats), mostly at the end of a bar.'),
  note: z.number().int().min(0).max(127).optional().describe('MIDI key; default the channel root key.'),
  velocity: zVel(0.78),
  gate: z.number().min(0.05).max(1).default(0.5),
});

export const CHORD_OPTIONS = z.strictObject({
  progression: zProgression,
  extensions: zExtensions,
  voicing: z.enum(['close', 'open', 'spread']).default('close'),
  inversion: z.enum(['auto', 'root', 'first', 'second', 'third']).default('auto').describe('auto = voice leading: each chord moves as little as possible.'),
  rhythm: z.enum(['whole', 'halves', 'quarters', 'stabs', 'offbeat', 'pulse']).default('whole'),
  barsPerChord: zBarsPerChord,
  octave: z.number().int().min(1).max(7).default(4),
  velocity: zVel(0.74),
});

export const ARP_OPTIONS = z.strictObject({
  chords: zChordSource,
  progression: zProgression,
  extensions: zExtensions,
  barsPerChord: zBarsPerChord,
  style: z.enum(['up', 'down', 'upDown', 'downUp', 'converge', 'random']).default('up'),
  rate: zRate.default('16th'),
  octaves: z.number().int().min(1).max(4).default(1),
  gate: z.number().min(0.05).max(1).default(0.8),
  octave: z.number().int().min(1).max(7).default(4).describe('Register when the chords come from the progression.'),
  velocity: zVel(0.74),
});

export const MELODY_OPTIONS = z.strictObject({
  contour: z.enum(['rise', 'fall', 'arch', 'valley', 'wave']).default('arch'),
  low: z.number().int().min(0).max(127).default(60),
  high: z.number().int().min(0).max(127).default(79),
  density: z.number().min(0.05).max(1).default(0.6),
  feel: z.enum(['quarters', '8ths', '16ths', 'syncopated']).default('8ths'),
  phrase: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(2).describe('Bars per phrase.'),
  callResponse: z.boolean().default(true).describe('Every second phrase repeats the first with a new ending.'),
  chordTones: z.number().min(0).max(1).default(0.7).describe('How strongly strong beats land on chord tones.'),
  chords: z.enum(['auto', 'pattern', 'progression', 'none']).default('auto'),
  progression: zProgression,
  barsPerChord: zBarsPerChord,
  velocity: zVel(0.8),
});

export const BASS_OPTIONS = z.strictObject({
  style: z.enum(['root', 'rootFifth', 'octave', 'walking', 'glide808']).default('root'),
  rhythm: z.enum(['auto', 'whole', 'halves', 'quarters', 'eighths', 'offbeat', 'tresillo', 'trap', 'funk']).default('auto'),
  octave: z.number().int().min(0).max(4).default(2),
  passing: z.number().min(0).max(1).default(0.15).describe('Chance of a passing / approach note before a chord change.'),
  chords: zChordSource,
  progression: zProgression,
  barsPerChord: zBarsPerChord,
  gate: z.number().min(0.05).max(1).default(0.9),
  velocity: zVel(0.82),
});

export const GENERATOR_OPTIONS = {
  rhythm: RHYTHM_OPTIONS,
  chords: CHORD_OPTIONS,
  arp: ARP_OPTIONS,
  melody: MELODY_OPTIONS,
  bass: BASS_OPTIONS,
} as const;

export type RhythmOptions = z.infer<typeof RHYTHM_OPTIONS>;
export type ChordOptions = z.infer<typeof CHORD_OPTIONS>;
export type ArpOptions = z.infer<typeof ARP_OPTIONS>;
export type MelodyOptions = z.infer<typeof MELODY_OPTIONS>;
export type BassOptions = z.infer<typeof BASS_OPTIONS>;
export type GeneratorOptions = { rhythm: RhythmOptions; chords: ChordOptions; arp: ArpOptions; melody: MelodyOptions; bass: BassOptions };

export function parseGeneratorOptions<K extends GeneratorKind>(kind: K, raw: unknown): { ok: true; options: GeneratorOptions[K] } | { ok: false; message: string } {
  const r = GENERATOR_OPTIONS[kind].safeParse(raw ?? {});
  if (r.success) return { ok: true, options: r.data as GeneratorOptions[K] };
  const issue = r.error.issues[0];
  const known = Object.keys(GENERATOR_OPTIONS[kind].shape).join(', ');
  if (issue?.code === 'unrecognized_keys') return { ok: false, message: `Unknown ${GENERATOR_LABELS[kind].toLowerCase()} option ${(issue.keys as string[]).map((k) => `"${k}"`).join(', ')} (options: ${known})` };
  const at = issue?.path.length ? `"${issue.path.join('.')}"` : 'options';
  return { ok: false, message: `${GENERATOR_LABELS[kind]} option ${at}: ${issue?.message ?? 'invalid'}` };
}
