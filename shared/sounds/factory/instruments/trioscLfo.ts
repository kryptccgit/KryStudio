import type { InstrumentPreset } from '../../types';
import { DIV, HALL, PLATE, ROOM, SH, TAPE, TRI, chorus, delay, drive, eq, imager, preset, reverb, tri, type Params } from './kit';

export const TLFO = { sine: 0, tri: 1, sawUp: 2, sawDown: 3, square: 4, sampleHold: 5, smoothRandom: 6 } as const;
export const TDEST = { pitch: 0, cutoff: 1, amp: 2, pan: 3, detune: 4, oscMix: 5 } as const;
export const TDIV = {
  '1/32T': 0, '1/32': 1, '1/32D': 2, '1/16T': 3, '1/16': 4, '1/16D': 5, '1/8T': 6, '1/8': 7, '1/8D': 8, '1/4T': 9, '1/4': 10, '1/4D': 11,
  '1/2T': 12, '1/2': 13, '1/2D': 14, '1bar': 15, '2bars': 16, '4bars': 17, '8bars': 18,
} as const;

export const TRI_LFO_OFF: Params = {
  lfo1Shape: 0, lfo1Dest: 0, lfo1Amount: 0, lfo1Sync: 0, lfo1Rate: 5, lfo1Division: 10, lfo1Retrig: 0, lfo1Fade: 0,
  lfo2Shape: 0, lfo2Dest: 1, lfo2Amount: 0, lfo2Sync: 0, lfo2Rate: 5, lfo2Division: 10, lfo2Retrig: 0, lfo2Fade: 0,
};

function triLfo(p: Params & { gain: number }): Params {
  return tri({ ...TRI_LFO_OFF, ...p });
}

const monoLows = (freq = 150) => imager(0, 1, 1, { lowFreq: freq });

export const TRIOSC_LFO_PRESETS: InstrumentPreset[] = [
  preset({
    id: 'factory:bass/wobble-eighths',
    name: 'Wobble Bass 1/8',
    plugin: TRI,
    params: triLfo({
      gain: -4, osc1Shape: SH.saw, osc1Level: 0.8, osc2Shape: SH.square, osc2Coarse: -12, osc2Level: 0.55, osc2Fine: 0, drift: 0.05,
      cutoff: 420, reso: 0.45, filterKeyTrack: 0.3, ampAttack: 2, ampDecay: 300, ampSustain: 1, ampRelease: 90,
      lfo1Shape: TLFO.sine, lfo1Dest: TDEST.cutoff, lfo1Amount: 0.75, lfo1Sync: 1, lfo1Division: TDIV['1/8'],
    }),
    channel: { mono: true, glideMs: 30 },
    fx: [eq({ hp: 30, b3: [300, -2, 1] }), drive(TAPE, 8, { tone: 7000 }), monoLows()],
    tags: ['wobble', 'growl', 'synced', 'aggressive', 'lfo'],
    genres: ['dubstep', 'edm', 'dnb'],
    description: 'Saw and sub-square bass whose filter wobbles in eighth notes, locked to the beat grid; change lfo1Division for faster or slower wobbles.',
    range: [28, 52],
  }),
  preset({
    id: 'factory:pad/trance-gate',
    name: 'Trance Gate Pad',
    plugin: TRI,
    params: triLfo({
      gain: -10.5, osc1Shape: SH.saw, osc1Level: 0.8, osc2Shape: SH.saw, osc2Fine: 8, osc2Level: 0.7, osc3Shape: SH.saw, osc3Coarse: 12, osc3Level: 0.3,
      unisonDetune: 0.35, drift: 0.2, cutoff: 4200, reso: 0.1, filterKeyTrack: 0.3, ampAttack: 30, ampDecay: 800, ampSustain: 1, ampRelease: 350,
      lfo1Shape: TLFO.square, lfo1Dest: TDEST.amp, lfo1Amount: 1, lfo1Sync: 1, lfo1Division: TDIV['1/16'],
      lfo2Shape: TLFO.sine, lfo2Dest: TDEST.pan, lfo2Amount: 0.3, lfo2Sync: 1, lfo2Division: TDIV['1bar'],
    }),
    fx: [eq({ hp: 200 }), delay(DIV['1/8D'], 0.3, 0.15), reverb(HALL, 3, 0.22)],
    tags: ['gated', 'rhythmic', 'wide', 'euphoric', 'synced', 'lfo'],
    genres: ['edm', 'techno', 'future-bass'],
    description: 'Wide detuned saw chord chopped into sixteenth notes by a square amp LFO locked to the song, with a slow one-bar auto-pan.',
    range: [55, 84],
  }),
  preset({
    id: 'factory:lead/vibrato-fade',
    name: 'Vibrato Lead',
    plugin: TRI,
    params: triLfo({
      gain: -0.5, osc1Shape: SH.saw, osc1Level: 0.8, osc2Shape: SH.square, osc2Fine: -6, osc2Level: 0.45, drift: 0.2,
      cutoff: 3800, reso: 0.18, filterEnvAmount: 0.2, filterEnvDecay: 500, filterEnvSustain: 0.4, filterKeyTrack: 0.5,
      ampAttack: 6, ampDecay: 400, ampSustain: 0.9, ampRelease: 220,
      lfo1Shape: TLFO.sine, lfo1Dest: TDEST.pitch, lfo1Amount: 0.03, lfo1Rate: 5.5, lfo1Retrig: 1, lfo1Fade: 700,
    }),
    channel: { mono: true, glideMs: 40 },
    fx: [eq({ hp: 160 }), chorus({ mix: 0.2, depth: 0.3 }), delay(DIV['1/4'], 0.25, 0.12), reverb(PLATE, 1.6, 0.14)],
    tags: ['expressive', 'vibrato', 'warm', 'singing', 'mono', 'lfo'],
    genres: ['synthwave', 'pop', 'rnb', 'edm'],
    description: 'Singing mono lead whose vibrato (about 35 cents at 5.5 Hz) fades in over 0.7 s, so short notes stay straight and held notes bloom.',
    range: [57, 86],
  }),
  preset({
    id: 'factory:fx/sample-hold-bleeps',
    name: 'S&H Bleeps',
    plugin: TRI,
    params: triLfo({
      gain: 1.5, osc1Shape: SH.tri, osc1Level: 0.8, osc2Shape: SH.square, osc2Coarse: 12, osc2Level: 0.25, drift: 0,
      cutoff: 2600, reso: 0.55, filterKeyTrack: 0.6, ampAttack: 1, ampDecay: 400, ampSustain: 1, ampRelease: 120,
      lfo1Shape: TLFO.sampleHold, lfo1Dest: TDEST.pitch, lfo1Amount: 0.5, lfo1Sync: 1, lfo1Division: TDIV['1/16'],
      lfo2Shape: TLFO.square, lfo2Dest: TDEST.amp, lfo2Amount: 1, lfo2Sync: 1, lfo2Division: TDIV['1/16'],
    }),
    fx: [eq({ hp: 250 }), delay(DIV['1/8'], 0.4, 0.2, { pingPong: 1 }), reverb(ROOM, 1.2, 0.15)],
    tags: ['random', 'computer', 'bleeps', 'sci-fi', 'synced', 'lfo'],
    genres: ['techno', 'edm', 'dnb'],
    description: 'Hold one note and it chirps random sixteenth-note pitches (sample and hold, ±6 semitones) gated in time; deterministic, so every render matches.',
    range: [60, 84],
  }),
  preset({
    id: 'factory:pluck/auto-pan',
    name: 'Auto-Pan Pluck',
    plugin: TRI,
    params: triLfo({
      gain: 0.5, osc1Shape: SH.square, osc1Level: 0.8, osc2Shape: SH.saw, osc2Fine: 7, osc2Level: 0.5, drift: 0.1,
      cutoff: 900, reso: 0.25, filterEnvAmount: 0.5, filterEnvDecay: 220, filterEnvSustain: 0, filterKeyTrack: 0.5,
      ampAttack: 1, ampDecay: 320, ampSustain: 0, ampRelease: 200,
      lfo1Shape: TLFO.tri, lfo1Dest: TDEST.pan, lfo1Amount: 0.8, lfo1Sync: 1, lfo1Division: TDIV['1/4D'],
    }),
    fx: [eq({ hp: 180 }), delay(DIV['1/8D'], 0.3, 0.15), reverb(PLATE, 1.4, 0.15)],
    tags: ['plucky', 'stereo', 'moving', 'bouncy', 'synced', 'lfo'],
    genres: ['house', 'deep-house', 'future-bass', 'pop'],
    description: 'Short square-saw pluck that drifts left and right on a dotted-quarter triangle LFO, so repeated notes bounce across the stereo field.',
    range: [55, 88],
  }),
  preset({
    id: 'factory:pad/filter-sweep',
    name: 'Filter Sweep Pad',
    plugin: TRI,
    params: triLfo({
      gain: -10.5, osc1Shape: SH.saw, osc1Level: 0.8, osc2Shape: SH.saw, osc2Fine: -9, osc2Level: 0.7, osc3Shape: SH.saw, osc3Coarse: -12, osc3Level: 0.3,
      unisonDetune: 0.3, drift: 0.4, cutoff: 900, reso: 0.35, filterKeyTrack: 0.3, ampAttack: 600, ampDecay: 1000, ampSustain: 1, ampRelease: 1500,
      lfo1Shape: TLFO.sine, lfo1Dest: TDEST.cutoff, lfo1Amount: 0.6, lfo1Sync: 1, lfo1Division: TDIV['2bars'],
      lfo2Shape: TLFO.smoothRandom, lfo2Dest: TDEST.detune, lfo2Amount: 0.35, lfo2Rate: 0.4,
    }),
    fx: [eq({ hp: 180 }), chorus({ mix: 0.35 }), reverb(HALL, 4.5, 0.3)],
    tags: ['evolving', 'sweeping', 'warm', 'lush', 'synced', 'lfo'],
    genres: ['synthwave', 'house', 'deep-house', 'edm'],
    description: 'Resonant saw pad whose filter opens and closes over two bars in time with the song, while a slow random LFO breathes the detune.',
    range: [48, 80],
  }),
  preset({
    id: 'factory:keys/tremolo-keys',
    name: 'Tremolo Keys',
    plugin: TRI,
    params: triLfo({
      gain: -6.5, osc1Shape: SH.sine, osc1Level: 0.8, osc2Shape: SH.tri, osc2Coarse: 12, osc2Level: 0.3, osc3Shape: SH.sine, osc3Coarse: 24, osc3Level: 0.12, drift: 0.15,
      cutoff: 5000, filterEnvAmount: 0.2, filterEnvDecay: 600, filterKeyTrack: 0.4, ampAttack: 2, ampDecay: 1800, ampSustain: 0.4, ampRelease: 400,
      lfo1Shape: TLFO.sine, lfo1Dest: TDEST.amp, lfo1Amount: 0.35, lfo1Rate: 4.5,
      lfo2Shape: TLFO.sine, lfo2Dest: TDEST.pan, lfo2Amount: 0.45, lfo2Rate: 4.5,
    }),
    fx: [eq({ hp: 120, high: [8000, -2] }), drive(TAPE, 3, { tone: 9000 }), reverb(ROOM, 1.4, 0.18)],
    tags: ['vintage', 'warm', 'soft', 'tremolo', 'stereo', 'lfo'],
    genres: ['rnb', 'lofi', 'pop'],
    description: 'Soft sine electric-piano tone with a vintage stereo tremolo: one LFO pulses the level while the other swings it across the speakers.',
    range: [48, 84],
  }),
];
