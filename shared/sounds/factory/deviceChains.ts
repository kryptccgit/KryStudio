import type { ChainPreset, PresetFx } from '../types';

const fx = (type: string, params: Record<string, number>, mix?: number): PresetFx => (mix === undefined ? { type, params } : { type, params, mix });
const eq = (params: Record<string, number>): PresetFx => fx('krypt.eq', params);
const chain = (c: Omit<ChainPreset, 'kind' | 'author'>): ChainPreset => ({ kind: 'chain', author: 'Krypt', ...c });

const SHAPE = { soft: 0, tube: 1, tape: 2, hard: 3, fold: 4, rectify: 5, bitcrush: 6 } as const;
const DIV = { '1/16': 3, '1/8T': 5, '1/8': 6, '1/8D': 7, '1/4T': 8, '1/4': 9, '1/4D': 10 } as const;
const RATIO = { '2:1': 0, '4:1': 1, '10:1': 2 } as const;
const ATTACK = { '0.1ms': 0, '0.3ms': 1, '1ms': 2, '3ms': 3, '10ms': 4, '30ms': 5 } as const;
const RELEASE = { '0.1s': 0, '0.3s': 1, '0.6s': 2, '1.2s': 3, auto: 4 } as const;
const SC_HPF = { off: 0, '60': 1, '90': 2, '120': 3, '150': 4, '200': 5, '300': 6 } as const;

export const DEVICE_CHAIN_PRESETS: readonly ChainPreset[] = [
  chain({
    id: 'factory:chain/bass/heat-808-warmth',
    name: 'Heat 808 Warmth',
    role: 'bass',
    fx: [
      fx('krypt.heat', {
        lowFreq: 120, highFreq: 1800,
        lowDrive: 3, lowShape: SHAPE.tube, lowLevel: 0,
        midDrive: 15, midShape: SHAPE.tape, midLevel: 1,
        highDrive: 6, highShape: SHAPE.soft, highLevel: -3,
        mix: 1, output: -3,
      }),
    ],
    tags: ['warm', 'gritty', '808', 'audible'],
    genres: ['trap', 'drill', 'phonk', 'boom-bap'],
    description: 'Multiband 808 saturation: the sub under 120 Hz stays nearly clean while the mids get tape grit, so the 808 reads on phone speakers without losing weight.',
  }),
  chain({
    id: 'factory:chain/drum-bus/heat-crunch',
    name: 'Heat Crunch Bus',
    role: 'drumBus',
    fx: [
      fx('krypt.heat', {
        lowFreq: 150, highFreq: 4000,
        lowDrive: 4, lowShape: SHAPE.tube, lowLevel: 0,
        midDrive: 12, midShape: SHAPE.hard, midLevel: -1,
        highDrive: 8, highShape: SHAPE.tape, highLevel: 0,
        mix: 0.6, output: -2,
      }),
    ],
    tags: ['punchy', 'crunchy', 'dirty', 'parallel'],
    genres: ['boom-bap', 'phonk', 'techno', 'dnb'],
    description: 'Parallel drum-bus crunch: hard-clipped mids and taped highs blended 60% under the clean kit. Snares bite, kicks keep their low end.',
  }),
  chain({
    id: 'factory:chain/character/heat-air',
    name: 'Heat Air',
    role: 'character',
    fx: [
      fx('krypt.heat', {
        lowFreq: 200, highFreq: 6000,
        lowDrive: 0, lowShape: SHAPE.soft, lowLevel: 0,
        midDrive: 2, midShape: SHAPE.tube, midLevel: 0,
        highDrive: 10, highShape: SHAPE.soft, highLevel: 2,
        mix: 0.5, output: -1,
      }),
    ],
    tags: ['bright', 'airy', 'exciter', 'subtle'],
    genres: [],
    description: 'Harmonic exciter: only the top above 6 kHz is saturated and blended in, adding air and presence to vocals, pads or a dull mix without harshness.',
  }),
  chain({
    id: 'factory:chain/delay-send/tape-echo-dub',
    name: 'Dub Tape Echo',
    role: 'delaySend',
    fx: [
      fx('krypt.tapeecho', { sync: 1, division: DIV['1/8D'], feedback: 0.72, saturation: 0.6, wow: 0.35, flutter: 0.25, age: 0.55, pingPong: 0, mix: 1 }, 1),
      eq({ b1On: 1, b1Freq: 250, b1Slope: 1 }),
    ],
    tags: ['dub', 'warm', 'vintage', 'wobbly'],
    genres: ['reggaeton', 'lofi', 'boom-bap', 'afrobeats'],
    description: 'Dotted-eighth dub echo return (100% wet): long, darkening, saturated repeats with tape wobble. Automate Feedback past 100% for a runaway build, or Freeze for a held loop.',
  }),
  chain({
    id: 'factory:chain/delay-send/tape-slapback',
    name: 'Tape Slapback',
    role: 'delaySend',
    fx: [
      fx('krypt.tapeecho', { sync: 0, timeMs: 110, feedback: 0.15, saturation: 0.4, wow: 0.15, flutter: 0.3, age: 0.35, pingPong: 0, mix: 1 }, 1),
      eq({ b1On: 1, b1Freq: 300, b1Slope: 1 }),
    ],
    tags: ['slapback', 'vintage', 'short', 'warm'],
    genres: ['rnb', 'pop', 'synthwave'],
    description: 'Short 110 ms tape slapback return (100% wet), one soft repeat with a little flutter. Thickens vocals and guitars-style leads; send about -14 dB.',
  }),
  chain({
    id: 'factory:chain/vocal/tape-throw',
    name: 'Tape Throw',
    role: 'vocal',
    fx: [fx('krypt.tapeecho', { sync: 1, division: DIV['1/8'], feedback: 0.45, saturation: 0.35, wow: 0.2, flutter: 0.2, age: 0.4, pingPong: 1, mix: 0.25 })],
    tags: ['wide', 'echo', 'vintage', 'rhythmic'],
    genres: ['trap', 'rnb', 'pop', 'house'],
    description: 'Eighth-note ping-pong tape echo on the vocal insert at 25% mix: worn repeats bounce left and right behind the dry voice. Raise Mix on line ends for throws.',
  }),
  chain({
    id: 'factory:chain/pad/grain-shimmer-cloud',
    name: 'Grain Shimmer Cloud',
    role: 'pad',
    fx: [fx('krypt.grain', { mode: 0, delay: 180, size: 140, density: 30, pitch: 12, spray: 0.6, reverse: 0.2, feedback: 0.45, freeze: 0, mix: 0.35 })],
    tags: ['shimmer', 'ambient', 'wide', 'texture'],
    genres: ['future-bass', 'synthwave', 'lofi'],
    description: 'Octave-up grain cloud behind a pad or keys: scattered, partly reversed grains with feedback build a shimmering halo. Freeze it on a chord for a drone.',
  }),
  chain({
    id: 'factory:chain/transition/grain-freeze',
    name: 'Grain Freeze',
    role: 'transition',
    fx: [fx('krypt.grain', { mode: 0, delay: 60, size: 220, density: 40, pitch: 0, spray: 0.5, reverse: 0, feedback: 0, freeze: 0, mix: 0 })],
    tags: ['freeze', 'build', 'glitch', 'texture'],
    genres: [],
    description: 'Freeze transition: transparent at Mix 0. Automate Freeze to On and Mix up to 70-100% on the last beat before a drop to hold the sound as a granular cloud.',
  }),
  chain({
    id: 'factory:chain/reverb-send/spectral-blur',
    name: 'Spectral Blur',
    role: 'reverbSend',
    fx: [
      fx('krypt.grain', { mode: 1, blur: 0.75, freeze: 0, mix: 1 }, 1),
      eq({ b1On: 1, b1Freq: 200, b1Slope: 1, b7On: 1, b7Freq: 9000, b7Slope: 0 }),
    ],
    tags: ['ambient', 'wash', 'dreamy', 'smear'],
    genres: ['lofi', 'future-bass', 'synthwave'],
    description: 'Spectral smear return (100% wet): every frequency hangs on for a few seconds like an infinite, pitch-true reverb. Ambient pads, vocal tails, intros.',
  }),
  chain({
    id: 'factory:chain/drum-bus/vca-glue',
    name: 'VCA Glue',
    role: 'drumBus',
    fx: [fx('krypt.glue', { threshold: -14, ratio: RATIO['2:1'], attack: ATTACK['10ms'], release: RELEASE.auto, makeup: 2, range: 40, scHpf: SC_HPF['120'], useSidechain: 0, mix: 1 })],
    tags: ['glue', 'punchy', 'cohesive', 'bus'],
    genres: ['house', 'boom-bap', 'pop', 'edm'],
    description: 'Classic bus glue: 2:1, 10 ms attack lets transients through, auto release, 120 Hz sidechain HPF so the kick does not pump the kit. Aim for 2-4 dB of reduction.',
  }),
  chain({
    id: 'factory:chain/drum-bus/glue-smash',
    name: 'Glue Smash',
    role: 'drumBus',
    fx: [fx('krypt.glue', { threshold: -30, ratio: RATIO['10:1'], attack: ATTACK['0.3ms'], release: RELEASE['0.1s'], makeup: 9, range: 40, scHpf: SC_HPF.off, useSidechain: 0, mix: 0.35 })],
    tags: ['parallel', 'aggressive', 'room', 'punchy'],
    genres: ['boom-bap', 'dnb', 'techno', 'phonk'],
    description: 'Parallel smash: 10:1 with the fastest attack and release, blended 35% under the dry kit. Brings up room, ghost notes and sustain while the hits stay punchy.',
  }),
  chain({
    id: 'factory:chain/vocal/glue-vocal-bus',
    name: 'Glue Vocal Bus',
    role: 'vocal',
    fx: [fx('krypt.glue', { threshold: -18, ratio: RATIO['4:1'], attack: ATTACK['3ms'], release: RELEASE['0.3s'], makeup: 3, range: 12, scHpf: SC_HPF['90'], useSidechain: 0, mix: 1 })],
    tags: ['smooth', 'upfront', 'controlled', 'bus'],
    genres: ['pop', 'rnb', 'trap'],
    description: 'Vocal-bus control: 4:1 with a 3 ms attack and 0.3 s release, capped at 12 dB of reduction, keeps lead and doubles level and upfront as one voice.',
  }),
];
