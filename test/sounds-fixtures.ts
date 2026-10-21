// Fixture presets + a fake factory library for the sounds-* tests (deterministic, independent of the real factory
// data the sound designer ships).
import fs from 'node:fs';
import path from 'node:path';
import type { ChainPreset, FactorySample, InstrumentPreset, Preset } from '@shared/sounds/types';

export const LEAD_EDM: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:lead/anthem-supersaw',
  name: 'Anthem Supersaw',
  plugin: 'krypt.wavetable',
  params: { unison: 7, detune: 0.45, cutoff: 12000 },
  fx: [
    { type: 'krypt.chorus', params: {} },
    { type: 'krypt.reverb', params: { size: 0.8 }, mix: 0.2 },
  ],
  role: 'lead',
  tags: ['bright', 'wide', 'big'],
  genres: ['edm', 'future-bass'],
  description: 'Big detuned supersaw for drops.',
};

export const LEAD_TRAP: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:lead/dark-bell-lead',
  name: 'Dark Bell Lead',
  plugin: 'krypt.triosc',
  params: { osc1Shape: 1, cutoff: 3000 },
  role: 'lead',
  alsoRoles: ['bell'],
  tags: ['dark', 'metallic'],
  genres: ['trap', 'drill'],
  description: 'Glassy dark lead for trap melodies.',
};

export const PLUCK: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:pluck/candy-pluck',
  name: 'Candy Pluck',
  plugin: 'krypt.wavetable',
  params: { ampRelease: 200, cutoff: 6000 },
  fx: [{ type: 'krypt.delay', params: { feedback: 0.3 }, mix: 0.2 }],
  role: 'pluck',
  alsoRoles: ['arp'],
  tags: ['bright', 'short'],
  genres: ['future-bass', 'edm'],
  description: 'Short bright pluck.',
};

export const DARK_PLUCK: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:pluck/night-pluck',
  name: 'Night Pluck',
  plugin: 'krypt.triosc',
  params: { cutoff: 1800 },
  role: 'pluck',
  tags: ['dark', 'short'],
  genres: ['trap'],
  description: 'Muted dark pluck.',
};

export const PAD: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:pad/wide-air',
  name: 'Wide Air',
  plugin: 'krypt.wavetable',
  params: { ampRelease: 2000, unison: 5 },
  fx: [{ type: 'krypt.reverb', params: { size: 0.9 }, mix: 0.35 }],
  role: 'pad',
  tags: ['airy', 'wide'],
  genres: [],
  description: 'Airy wide pad.',
};

export const KEYS: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:keys/soft-ep',
  name: 'Soft EP',
  plugin: 'krypt.fm',
  params: {},
  role: 'keys',
  tags: ['warm', 'soft'],
  genres: ['rnb', 'lofi'],
  description: 'Soft electric piano.',
};

export const EIGHT08: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:808/street-808',
  name: 'Street 808',
  plugin: 'krypt.kick808',
  params: { decay: 2400, drive: 0.4 },
  channel: { mono: true, glideMs: 80, volumeDb: -3 },
  fx: [{ type: 'krypt.clipper', params: { drive: 6 } }],
  role: '808',
  tags: ['dirty', 'long'],
  genres: ['trap', 'drill'],
  description: 'Long distorted 808.',
};

export const SAMPLER_808: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:808/club-sub',
  name: 'Club Sub',
  plugin: 'krypt.sampler',
  params: { ampRelease: 400 },
  sample: 'factory:808/sub-boom.wav',
  channel: { rootKey: 36, mono: true, glideMs: 40 },
  role: '808',
  tags: ['clean'],
  genres: ['edm'],
  description: 'Clean sampled sub for drops.',
};

/** Its sample is not installed: never a default choice. */
export const MISSING_STAB: InstrumentPreset = {
  kind: 'instrument',
  id: 'factory:stab/ghost-stab',
  name: 'Ghost Stab',
  plugin: 'krypt.sampler',
  params: {},
  sample: 'factory:stabs/not-installed.wav',
  role: 'stab',
  tags: [],
  genres: [],
  description: 'A stab whose sample is missing.',
};

export const MASTER_EDM: ChainPreset = {
  kind: 'chain',
  id: 'factory:chain/master/club-loud',
  name: 'Club Loud',
  role: 'master',
  fx: [
    { type: 'krypt.eq', params: {} },
    { type: 'krypt.comp', params: { threshold: -12, ratio: 2 } },
    { type: 'krypt.clipper', params: { drive: 3 } },
    { type: 'krypt.limiter', params: { ceiling: -1 } },
  ],
  targetLufs: -8,
  tags: ['loud'],
  genres: ['edm', 'house'],
  description: 'Loud club master.',
};

export const MASTER_LOFI: ChainPreset = {
  kind: 'chain',
  id: 'factory:chain/master/dusty-tape',
  name: 'Dusty Tape',
  role: 'master',
  fx: [
    { type: 'krypt.drive', params: {} },
    { type: 'krypt.limiter', params: { ceiling: -1 } },
  ],
  targetLufs: -12,
  tags: ['lofi', 'warm'],
  genres: ['lofi'],
  description: 'Soft tape master for lo-fi.',
};

export const DRUM_BUS: ChainPreset = {
  kind: 'chain',
  id: 'factory:chain/drum-bus/glue',
  name: 'Drum Bus Glue',
  role: 'drumBus',
  fx: [
    { type: 'krypt.comp', params: { ratio: 3 } },
    { type: 'krypt.clipper', params: { drive: 2 } },
  ],
  tags: ['punchy'],
  genres: [],
  description: 'Glue for the drum bus.',
};

export const REVERB_SEND: ChainPreset = {
  kind: 'chain',
  id: 'factory:chain/reverb-send/big-hall',
  name: 'Big Hall Send',
  role: 'reverbSend',
  fx: [{ type: 'krypt.reverb', params: { size: 0.95, decay: 4 }, mix: 1 }],
  insert: { volumeDb: -6 },
  tags: ['long'],
  genres: [],
  description: '100% wet hall for a send.',
};

export const BASS_CHAIN: ChainPreset = {
  kind: 'chain',
  id: 'factory:chain/bass/weight',
  name: 'Bass Weight',
  role: 'bass',
  fx: [{ type: 'krypt.comp', params: {} }],
  tags: [],
  genres: [],
  description: 'Bass insert chain.',
};

export const FIXTURE_PRESETS: readonly Preset[] = [LEAD_EDM, LEAD_TRAP, PLUCK, DARK_PLUCK, PAD, KEYS, EIGHT08, SAMPLER_808, MISSING_STAB, MASTER_EDM, MASTER_LOFI, DRUM_BUS, REVERB_SEND, BASS_CHAIN];

const sample = (path: string, name: string, kind: FactorySample['kind'], extra: Partial<FactorySample> = {}): FactorySample => ({
  path,
  name,
  kind,
  tags: [],
  genres: [],
  lengthSec: 0.5,
  channels: 1,
  peakDb: -1,
  ...extra,
});

export const INDEX_SAMPLES: FactorySample[] = [
  sample('factory:drums/kick.wav', 'Kick', 'kick'),
  sample('factory:drums/hat-open.wav', 'Open Hat', 'openhat'),
  sample('factory:kicks/trap-kick-1.wav', 'Trap Kick 1', 'kick', { genres: ['trap'], tags: ['punchy'] }),
  sample('factory:kicks/edm-kick-1.wav', 'Big Room Kick 1', 'kick', { genres: ['edm', 'house'], tags: ['big'] }),
  sample('factory:hats/edm-hat.wav', 'Bright Hat', 'hat', { genres: ['edm'] }),
  sample('factory:808/sub-boom.wav', 'Sub Boom', '808', { rootNote: 36, lengthSec: 2 }),
  sample('factory:fx/riser-noise-4.wav', 'Noise Riser 4', 'riser', { bars: 4, bpm: 128, lengthSec: 7.5, genres: ['edm'], channels: 2 }),
  sample('factory:fx/riser-noise-8.wav', 'Noise Riser 8', 'riser', { bars: 8, bpm: 128, lengthSec: 15, genres: ['edm'], channels: 2 }),
  sample('factory:fx/impact-boom.wav', 'Boom Impact', 'impact', { lengthSec: 3 }),
];

/** A temp factory folder: the files of INDEX_SAMPLES (+ the legacy kit) and, unless `index` is false, index.json. */
export function writeFactory(dir: string, opts: { index?: boolean; extraEntries?: unknown[] } = {}): void {
  const files = new Set([...INDEX_SAMPLES.map((s) => s.path), 'factory:drums/snare.wav', 'factory:drums/clap.wav', 'factory:drums/hat-closed.wav']);
  for (const p of files) {
    const abs = path.join(dir, p.slice('factory:'.length));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'RIFF');
  }
  if (opts.index !== false) {
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, generator: 'test', samples: [...INDEX_SAMPLES, ...(opts.extraEntries ?? [])] }));
  }
}
