// Factory ARP presets: short, tight notes built for fast 1/16 sequences.

import type { InstrumentPreset } from '../../types';
import { ALG, DIV, FM, HALL, PLATE, POS, ROOM, SH, T, TRI, WAVE, chorus, delay, eq, fm, preset, reverb, tri, wave } from './kit';

export const ARP_PRESETS: InstrumentPreset[] = [
  preset({
    id: 'factory:arp/gated-saw',
    name: 'Gated Saw Arp',
    plugin: WAVE,
    params: wave({
      gain: -1.5, table: T.basic, position: POS.saw, unison: 3, detune: 0.12, spread: 0.6, cutoff: 2500, reso: 0.15, filterKeyTrack: 0.4,
      modAttack: 0.5, modDecay: 120, modToCutoff: 0.35, ampAttack: 0.5, ampDecay: 180, ampSustain: 0.3, ampRelease: 80,
    }),
    fx: [eq({ hp: 200 }), delay(DIV['1/16D'], 0.3, 0.15), reverb(PLATE, 1.4, 0.12)],
    alsoRoles: ['pluck'],
    tags: ['bright', 'short', 'punchy', 'trance'],
    genres: ['edm', 'techno', 'synthwave', 'house'],
    description: 'Tight saw arp with a filter snap; driving 1/16 sequences for trance-style EDM and melodic techno.',
    range: [48, 88],
  }),
  preset({
    id: 'factory:arp/synthwave',
    name: 'Synthwave Arp',
    plugin: TRI,
    params: tri({
      gain: -1.5, osc1Shape: SH.square, osc1Level: 0.8, osc2Shape: SH.saw, osc2Coarse: 12, osc2Level: 0.35, drift: 0.3,
      cutoff: 1400, reso: 0.15, filterEnvAmount: 0.5, filterEnvDecay: 160, filterKeyTrack: 0.4, ampAttack: 0.5, ampDecay: 220, ampSustain: 0, ampRelease: 120,
    }),
    fx: [eq({ hp: 180 }), chorus({ mix: 0.3 }), delay(DIV['1/8D'], 0.35, 0.2), reverb(PLATE, 1.6, 0.14)],
    alsoRoles: ['pluck'],
    tags: ['retro', 'bright', 'short', 'analog'],
    genres: ['synthwave', 'pop'],
    description: 'Square-plus-octave-saw arp with dotted echoes; the pulsing 80s arpeggio of synthwave.',
    range: [45, 88],
  }),
  preset({
    id: 'factory:arp/crystal',
    name: 'Crystal Arp',
    plugin: FM,
    params: fm({
      gain: -3.5, algorithm: ALG.pairs,
      ops: [
        { ratio: 1, level: 0.85, vel: 0.6, a: 0.1, d: 350, s: 0, r: 150 },
        { ratio: 2, level: 0.6, vel: 0.8, a: 0.1, d: 120, s: 0, r: 80 },
        { ratio: 3, level: 0.4, vel: 0.6, a: 0.1, d: 250, s: 0, r: 120 },
        { ratio: 8, level: 0.4, vel: 0.9, a: 0.1, d: 60, s: 0, r: 50 },
      ],
    }),
    fx: [eq({ hp: 300 }), delay(DIV['1/8D'], 0.3, 0.16), reverb(HALL, 2, 0.16)],
    alsoRoles: ['pluck', 'bell'],
    tags: ['bright', 'glassy', 'short', 'clean'],
    genres: ['pop', 'future-bass', 'edm', 'trap'],
    description: 'Short, glassy FM arp; sparkling 1/16 patterns over pop, future bass and trap chords.',
    range: [60, 96],
  }),
  preset({
    id: 'factory:arp/bleep',
    name: 'Bleep Arp',
    plugin: WAVE,
    params: wave({
      gain: 3.5, table: T.digital, position: 0.2, unison: 1, cutoff: 7000, modAttack: 0.1, modDecay: 50, modToPosition: 0.25,
      ampAttack: 0.5, ampDecay: 120, ampSustain: 0, ampRelease: 60,
    }),
    fx: [eq({ hp: 300, lp: 12000 }), delay(DIV['1/16D'], 0.4, 0.14), reverb(ROOM, 0.8, 0.08)],
    alsoRoles: ['pluck'],
    tags: ['short', 'cold', 'digital', 'minimal'],
    genres: ['techno', 'tech-house', 'house'],
    description: 'Clicky digital bleep; hypnotic sequences for techno and tech house.',
    range: [48, 96],
  }),
  preset({
    id: 'factory:arp/bubble',
    name: 'Bubble Arp',
    plugin: WAVE,
    params: wave({
      gain: 1.5, table: T.harmonic, position: 0.05, unison: 1, modAttack: 0.1, modDecay: 80, modToPosition: 0.45,
      ampAttack: 0.5, ampDecay: 250, ampSustain: 0, ampRelease: 150,
    }),
    fx: [eq({ hp: 200 }), delay(DIV['1/8D'], 0.3, 0.16), reverb(PLATE, 1.6, 0.14)],
    alsoRoles: ['pluck'],
    tags: ['soft', 'warm', 'short', 'round'],
    genres: ['deep-house', 'house', 'lofi', 'dnb'],
    description: 'Round, bubbly blip with a soft harmonic pop; gentle arps for deep house, lo-fi and liquid drum & bass.',
    range: [48, 91],
  }),
  preset({
    id: 'factory:arp/rolling',
    name: 'Rolling Arp',
    plugin: WAVE,
    params: wave({
      gain: -2, table: T.basic, position: POS.saw, unison: 2, detune: 0.1, spread: 0.4, cutoff: 900, reso: 0.5, filterKeyTrack: 0.5,
      modAttack: 0.1, modDecay: 100, modToCutoff: 0.45, ampAttack: 0.5, ampDecay: 200, ampSustain: 0.1, ampRelease: 80,
    }),
    fx: [eq({ hp: 200 }), delay(DIV['1/16D'], 0.35, 0.14), reverb(ROOM, 1, 0.1)],
    alsoRoles: ['pluck'],
    tags: ['dark', 'short', 'punchy', 'resonant'],
    genres: ['dnb', 'dubstep', 'techno'],
    description: 'Resonant, squelchy saw arp; rolling tension sequences for drum & bass, dubstep builds and techno.',
    range: [45, 84],
  }),
];
