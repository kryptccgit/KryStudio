// Factory rack presets (Wave 12.2, research/16 §2.3): an instrument rack, a
// drum rack and two effect racks with named macros. Kept OUT of
// INSTRUMENT_PRESETS / CHAIN_PRESETS (whose tests check them against the
// generated catalog, which gets the rack plugins at integration); they are in
// FACTORY_PRESETS, and test/racks.test.ts loads every one through the preset
// commands against a fixture catalog that has the rack plugins.
//
// Macro values are the rack's params macro1..8; maps address chains and
// devices by INDEX (shared/sounds/types.ts PresetRack). Map ranges are in the
// inner param's NORMALIZED space (log params: frequencies, times).

import type { ChainPreset, InstrumentPreset, PresetFx, PresetRack } from '../types';

const fx = (type: string, params: Record<string, number>, mix?: number): PresetFx => (mix === undefined ? { type, params } : { type, params, mix });
const all = { velLo: 0, velHi: 1 };
const pad = (note: number) => ({ keyLo: note, keyHi: note, velLo: 0, velHi: 1 });
/** A one-shot sampler pad at the sample's own pitch. */
const padSampler = (sample: string, params: Record<string, number> = {}) => ({ plugin: 'krypt.sampler', sample, params: { keyTrack: 0, oneShot: 1, ...params } });

// ── Layered keys (instrument rack) ────────────────────────────────────

const KEYS_RACK: PresetRack = {
  kind: 'instrument',
  chains: [
    {
      name: 'Soft EP',
      zone: { keyLo: 0, keyHi: 127, velLo: 0, velHi: 0.72 },
      instrument: { plugin: 'krypt.fm', params: { op2Level: 0.5, op4Level: 0.35, cutoff: 7000, gain: -6 } },
      fx: [fx('krypt.chorus', { voices: 2, rate: 0.5, depth: 0.35, mix: 0.4 }), fx('krypt.reverb', { mode: 0, size: 0.45, decay: 1.4 }, 0.2)],
    },
    {
      name: 'Hard EP',
      zone: { keyLo: 0, keyHi: 127, velLo: 0.72, velHi: 1 },
      instrument: { plugin: 'krypt.fm', params: { op2Level: 0.75, op4Level: 0.6, op4Vel: 1, cutoff: 12000, gain: -6 } },
      fx: [fx('krypt.chorus', { voices: 2, rate: 0.5, depth: 0.35, mix: 0.4 }), fx('krypt.reverb', { mode: 0, size: 0.45, decay: 1.4 }, 0.2)],
    },
    {
      name: 'Bell Top',
      volume: 0.5,
      zone: { keyLo: 60, keyHi: 127, ...all },
      instrument: {
        plugin: 'krypt.wavetable',
        params: { table: 3, position: 0.35, unison: 1, ampAttack: 1, ampDecay: 1800, ampSustain: 0, ampRelease: 600, cutoff: 12000, gain: -9 },
      },
    },
    {
      name: 'Sub Body',
      volume: 0.6,
      zone: { keyLo: 0, keyHi: 54, ...all },
      instrument: { plugin: 'krypt.triosc', params: { osc1Shape: 0, osc2Level: 0, osc3Level: 0, cutoff: 600, filterEnvAmount: 0, gain: -9, ampRelease: 300 } },
    },
  ],
  macros: [
    {
      name: 'Brightness',
      maps: [
        { chain: 0, target: 'instrument', param: 'cutoff', min: 0.55, max: 1 },
        { chain: 1, target: 'instrument', param: 'cutoff', min: 0.65, max: 1 },
        { chain: 2, target: 'instrument', param: 'cutoff', min: 0.5, max: 1 },
      ],
    },
    { name: 'Bell Layer', maps: [{ chain: 2, target: 'chain', param: 'volume', min: 0, max: 0.8 }] },
    { name: 'Sub', maps: [{ chain: 3, target: 'chain', param: 'volume', min: 0, max: 0.8 }] },
    {
      name: 'Chorus',
      maps: [
        { chain: 0, target: 'device', device: 0, param: 'mix', min: 0, max: 1 },
        { chain: 1, target: 'device', device: 0, param: 'mix', min: 0, max: 1 },
      ],
    },
    {
      name: 'Space',
      maps: [
        { chain: 0, target: 'device', device: 1, param: 'mix', min: 0, max: 0.6 },
        { chain: 1, target: 'device', device: 1, param: 'mix', min: 0, max: 0.6 },
      ],
    },
  ],
  variations: [
    { name: 'Mellow', values: [0.45, 0.1, 0.45, 0.25, 0.4, 0, 0, 0] },
    { name: 'Sparkle', values: [1, 0.85, 0.2, 0.5, 0.3, 0, 0, 0] },
  ],
};

// ── Drum kit (drum rack) ──────────────────────────────────────────────

const KIT_RACK: PresetRack = {
  kind: 'drum',
  chains: [
    { name: 'Kick', zone: pad(36), instrument: padSampler('factory:drums/kick.wav') },
    { name: 'Kick 2', zone: pad(37), instrument: padSampler('factory:drums/kick-2.wav') },
    { name: 'Snare', zone: pad(38), instrument: padSampler('factory:drums/snare.wav') },
    { name: 'Clap', zone: pad(39), instrument: padSampler('factory:drums/clap.wav') },
    { name: 'Rim', zone: pad(40), instrument: padSampler('factory:drums/rim.wav') },
    { name: 'Tom', zone: pad(41), instrument: padSampler('factory:drums/tom.wav') },
    { name: 'Closed Hat', zone: pad(42), choke: 1, pan: 0.15, instrument: padSampler('factory:drums/hat-closed.wav', { ampSustain: 0, ampDecay: 180 }) },
    { name: 'Perc', zone: pad(43), pan: -0.2, instrument: padSampler('factory:drums/perc.wav') },
    { name: '808', zone: pad(44), instrument: padSampler('factory:drums/808.wav') },
    { name: 'Open Hat', zone: pad(46), choke: 1, pan: 0.15, instrument: padSampler('factory:drums/hat-open.wav', { ampSustain: 0, ampDecay: 700 }) },
    { name: 'Crash', zone: pad(49), volume: 0.7, instrument: padSampler('factory:drums/crash.wav') },
  ],
  macros: [
    {
      name: 'Hat Decay',
      maps: [
        { chain: 6, target: 'instrument', param: 'ampDecay', min: 0.35, max: 0.7 },
        { chain: 9, target: 'instrument', param: 'ampDecay', min: 0.5, max: 0.9 },
      ],
    },
    { name: 'Snare Tone', maps: [{ chain: 2, target: 'instrument', param: 'cutoff', min: 0.55, max: 1 }] },
    { name: 'Kick Level', maps: [{ chain: 0, target: 'chain', param: 'volume', min: 0.6, max: 0.92 }] },
    {
      name: 'Hat Width',
      maps: [
        { chain: 6, target: 'chain', param: 'pan', min: 0.5, max: 0.8 },
        { chain: 9, target: 'chain', param: 'pan', min: 0.5, max: 0.2 },
      ],
    },
  ],
};

// ── Lo-fi (effect rack) ───────────────────────────────────────────────

const LOFI_RACK: PresetRack = {
  kind: 'effect',
  chains: [
    {
      name: 'Tape',
      fx: [
        fx('krypt.eq', { b1On: 1, b1Freq: 90, b7On: 1, b7Freq: 12000, b7Slope: 1 }),
        fx('krypt.drive', { mode: 0, drive: 4, tone: 9000 }),
        fx('krypt.drive', { mode: 4, drive: 0, bits: 16, downsample: 1, tone: 20000 }),
        fx('krypt.chorus', { voices: 1, rate: 0.35, depth: 0.2, delay: 8, mix: 0.5 }),
      ],
    },
    {
      name: 'Room',
      volume: 0,
      fx: [fx('krypt.eq', { b1On: 1, b1Freq: 250, b7On: 1, b7Freq: 6000 }), fx('krypt.reverb', { mode: 0, size: 0.5, decay: 1.6, damping: 4000 }, 1)],
    },
  ],
  macros: [
    {
      name: 'Age',
      maps: [
        { chain: 0, target: 'device', device: 0, param: 'b7Freq', min: 0.9, max: 0.45 },
        { chain: 0, target: 'device', device: 1, param: 'drive', min: 0.05, max: 0.35 },
      ],
    },
    {
      name: 'Wobble',
      maps: [
        { chain: 0, target: 'device', device: 3, param: 'depth', min: 0, max: 0.8 },
        { chain: 0, target: 'device', device: 3, param: 'mix', min: 0, max: 1 },
      ],
    },
    {
      name: 'Crush',
      maps: [
        { chain: 0, target: 'device', device: 2, param: 'bits', min: 1, max: 0.35 },
        { chain: 0, target: 'device', device: 2, param: 'downsample', min: 0, max: 0.2 },
      ],
    },
    { name: 'Space', maps: [{ chain: 1, target: 'chain', param: 'volume', min: 0, max: 0.75 }] },
  ],
  variations: [
    { name: 'Dusty', values: [0.6, 0.3, 0.15, 0.3, 0, 0, 0, 0] },
    { name: 'Broken Tape', values: [0.9, 0.85, 0.55, 0.45, 0, 0, 0, 0] },
  ],
};

// ── Vocal chain (effect rack) ─────────────────────────────────────────

const VOCAL_RACK: PresetRack = {
  kind: 'effect',
  chains: [
    {
      name: 'Lead',
      fx: [
        fx('krypt.eq', { b1On: 1, b1Freq: 100, b1Slope: 1, b3Freq: 300, b3Gain: -2, b3Q: 1, b4Freq: 3000, b4Gain: 1.5, b4Q: 0.8, b6Freq: 10000, b6Gain: 2 }),
        fx('krypt.comp', { threshold: -20, ratio: 4, attack: 5, release: 80, knee: 6 }),
      ],
    },
    {
      name: 'Air',
      volume: 0.3,
      fx: [fx('krypt.eq', { b1On: 1, b1Freq: 2000, b1Slope: 2, b6Freq: 12000, b6Gain: 4 }), fx('krypt.comp', { threshold: -35, ratio: 10, attack: 1, release: 60 })],
    },
    {
      name: 'Delay',
      volume: 0.35,
      fx: [fx('krypt.delay', { sync: 1, division: 7, feedback: 0.3, pingPong: 1, lowCut: 300, highCut: 7000 }, 1)],
    },
    {
      name: 'Reverb',
      volume: 0.35,
      fx: [fx('krypt.reverb', { mode: 2, size: 0.6, decay: 2.2, predelay: 30, lowCut: 250 }, 1)],
    },
  ],
  macros: [
    { name: 'Presence', maps: [{ chain: 0, target: 'device', device: 0, param: 'b4Gain', min: 0.5, max: 0.72 }] },
    { name: 'Compression', maps: [{ chain: 0, target: 'device', device: 1, param: 'threshold', min: 0.8, max: 0.5 }] },
    { name: 'Air', maps: [{ chain: 1, target: 'chain', param: 'volume', min: 0, max: 0.75 }] },
    { name: 'Delay', maps: [{ chain: 2, target: 'chain', param: 'volume', min: 0, max: 0.75 }] },
    { name: 'Reverb', maps: [{ chain: 3, target: 'chain', param: 'volume', min: 0, max: 0.75 }] },
  ],
  variations: [
    { name: 'Dry Up Front', values: [0.6, 0.6, 0.4, 0.1, 0.15, 0, 0, 0] },
    { name: 'Big Hook', values: [0.7, 0.7, 0.6, 0.5, 0.6, 0, 0, 0] },
  ],
};

export const RACK_INSTRUMENT_PRESETS: readonly InstrumentPreset[] = [
  {
    kind: 'instrument',
    id: 'factory:keys/layered-keys-rack',
    name: 'Layered Keys Rack',
    plugin: 'krypt.rack',
    params: { macro1: 0.75, macro2: 0.35, macro3: 0.3, macro4: 0.35, macro5: 0.3 },
    rack: KEYS_RACK,
    fx: [fx('krypt.eq', { b1On: 1, b1Freq: 40 })],
    role: 'keys',
    alsoRoles: ['piano'],
    tags: ['rack', 'layered', 'warm', 'velocity'],
    genres: [],
    description: 'An instrument rack: soft and hard FM electric pianos split by velocity, a bell layer above middle C and a sine sub below; macros for brightness, layers, chorus and space.',
    range: [36, 96],
    author: 'Krypt',
  },
  {
    kind: 'instrument',
    id: 'factory:perc/drum-kit-rack',
    name: 'Drum Kit Rack',
    plugin: 'krypt.drumrack',
    params: { macro1: 0.4, macro2: 0.8, macro3: 0.6, macro4: 0.3 },
    rack: KIT_RACK,
    // Steps in the Channel Rack play the root key: the kick pad.
    channel: { rootKey: 36 },
    fx: [fx('krypt.eq', { b1On: 1, b1Freq: 30 })],
    role: 'perc',
    alsoRoles: ['kick', 'snare', 'hat'],
    tags: ['rack', 'kit', 'drums', 'punchy'],
    genres: [],
    description: 'A drum rack of the factory one-shots on pads from C2: kick, snare, clap, rim, tom, hats (closed and open choke each other), perc, 808 and crash.',
    range: [36, 51],
    author: 'Krypt',
  },
];

export const RACK_CHAIN_PRESETS: readonly ChainPreset[] = [
  {
    kind: 'chain',
    id: 'factory:chain/character/lofi-rack',
    name: 'Lo-fi Rack',
    role: 'character',
    fx: [{ type: 'krypt.fxrack', params: { macro1: 0.5, macro2: 0.3, macro3: 0.15, macro4: 0.3 }, rack: LOFI_RACK }],
    tags: ['rack', 'lofi', 'tape', 'vintage', 'warm'],
    genres: [],
    description: 'An effect rack with four macros: Age (high cut + tape drive), Wobble (tape flutter), Crush (bits and sample rate) and Space (a parallel dark room).',
    author: 'Krypt',
  },
  {
    kind: 'chain',
    id: 'factory:chain/vocal/vocal-rack',
    name: 'Vocal Rack',
    role: 'vocal',
    fx: [{ type: 'krypt.fxrack', params: { macro1: 0.6, macro2: 0.6, macro3: 0.4, macro4: 0.3, macro5: 0.35 }, rack: VOCAL_RACK }],
    tags: ['rack', 'vocal', 'clean', 'modern'],
    genres: [],
    description: 'A vocal effect rack: cleaned and compressed lead, a parallel air band, and dotted-eighth delay and plate reverb chains; macros for presence, compression, air, delay and reverb.',
    author: 'Krypt',
  },
];

export const RACK_PRESETS: readonly (InstrumentPreset | ChainPreset)[] = [...RACK_INSTRUMENT_PRESETS, ...RACK_CHAIN_PRESETS];
