// The go-to factory preset per role in each genre: what a producer of that
// genre reaches for first. index.ts turns this table into each preset's
// `defaultFor` (select.ts ranks a genre's default +15 over equally tagged
// presets of the same role). Values are preset slugs: role + slug = the id
// 'factory:<role>/<slug>'. One preset per (genre, role); the preset must list
// the genre in its `genres` (test/presets-factory.test.ts checks both).

import type { GenreId } from '../../genres';
import type { InstrumentRole } from '../../types';

export type GenreDefaults = Partial<Record<InstrumentRole, string>>;

export const GENRE_DEFAULTS: Record<GenreId, GenreDefaults> = {
  trap: {
    lead: 'dark-saw', pluck: 'night', pad: 'dark', chord: 'moody', keys: 'lofi', piano: 'felt', bell: 'crystal', arp: 'crystal', stab: 'cinematic-hit',
    strings: 'ensemble', brass: 'trap', vox: 'choir', bass: 'reese', '808': 'clean', sub: 'saturated',
    kick: 'knock', snare: 'fat', clap: 'big', hat: 'trap', openhat: 'long', crash: 'short', fx: 'sub-boom',
  },
  drill: {
    lead: 'dark-saw', pluck: 'night', pad: 'dark', chord: 'moody', piano: 'dark', bell: 'dark', stab: 'cinematic-hit',
    strings: 'staccato', brass: 'trap', vox: 'choir', '808': 'drill-slide', sub: 'glide',
    kick: 'knock', snare: 'fat', clap: 'tight', hat: 'trap', openhat: 'long', perc: 'rim', crash: 'short', fx: 'sub-boom',
  },
  'boom-bap': {
    lead: 'funk-whine', pluck: 'lofi', pad: 'lofi-tape', keys: 'reed', chord: 'lofi', bell: 'vibes', brass: 'fm', vox: 'talk',
    bass: 'electric', '808': 'punchy', kick: 'dusty', snare: 'dusty', hat: 'dusty', ride: 'dark', tom: 'low',
  },
  lofi: {
    lead: 'soft-sine', pluck: 'lofi', pad: 'lofi-tape', keys: 'lofi', chord: 'lofi', piano: 'felt', bell: 'vibes', arp: 'bubble', vox: 'ooh',
    bass: 'upright', '808': 'soft', sub: 'triangle', kick: 'deep', snare: 'dusty', hat: 'dusty', ride: 'dark', texture: 'tape-hiss',
  },
  phonk: {
    lead: 'phonk-cowbell', pluck: 'night', pad: 'haunted', chord: 'moody', piano: 'dark', bell: 'church', strings: 'staccato', brass: 'trap', vox: 'choir',
    bass: 'funk', '808': 'phonk', sub: 'saturated', kick: 'knock', snare: 'dusty', hat: 'trap', perc: 'cowbell', texture: 'tape-hiss',
  },
  rnb: {
    lead: 'soft-sine', pluck: 'silk-harp', pad: 'silk', keys: 'velvet', chord: 'deep', piano: 'felt', bell: 'kalimba', strings: 'ensemble', brass: 'fm', vox: 'ooh',
    bass: 'electric', '808': 'clean', sub: 'warm', kick: 'deep', snare: 'fat', hat: 'trap',
  },
  pop: {
    lead: 'pop-synth', pluck: 'future', pad: 'airy', keys: 'bright-ep', chord: 'supersaw', piano: 'fm-grand', bell: 'glockenspiel', arp: 'crystal', stab: 'brass',
    strings: 'ensemble', brass: 'horn-section', vox: 'chop', bass: 'pluck', '808': 'clean', sub: 'warm',
    kick: 'punchy', snare: 'tight', clap: 'big', hat: 'closed', openhat: 'long', perc: 'shaker', crash: 'full', fx: 'noise-riser',
  },
  afrobeats: {
    lead: 'breathy-flute', pluck: 'highlife', pad: 'silk', keys: 'bright-ep', chord: 'afro-keys', piano: 'house', bell: 'marimba', stab: 'dembow', brass: 'horn-section',
    bass: 'log-drum', '808': 'dembow', sub: 'pure', kick: 'punchy', snare: 'tight', clap: 'tight', hat: 'closed', openhat: 'open', perc: 'shaker', crash: 'short',
  },
  reggaeton: {
    lead: 'pop-synth', pluck: 'dembow', pad: 'silk', keys: 'bright-ep', chord: 'afro-keys', bell: 'island-pan', stab: 'dembow', brass: 'horn-section',
    bass: 'dembow', '808': 'dembow', sub: 'glide', kick: 'knock', snare: 'tight', clap: 'big', hat: 'closed', openhat: 'open', perc: 'rim', crash: 'short', fx: 'noise-riser',
  },
  house: {
    lead: 'analog-saw', pluck: 'deep', pad: 'warm-analog', keys: 'house-organ', chord: 'pumping', piano: 'house', arp: 'bubble', stab: 'house',
    strings: 'string-machine', brass: 'synth', vox: 'chop', bass: 'square', sub: 'warm',
    kick: 'punchy', snare: 'tight', clap: 'big', hat: 'closed', openhat: 'open', perc: 'rim', ride: 'bright', crash: 'full', fx: 'noise-riser',
  },
  'deep-house': {
    lead: 'hollow-pulse', pluck: 'deep', pad: 'velvet', keys: 'mellow-ep', chord: 'deep', piano: 'house', bell: 'vibes', arp: 'bubble', stab: 'dub-chord', vox: 'ooh',
    bass: 'organ', sub: 'warm', kick: 'deep', clap: 'tight', hat: 'closed', openhat: 'open', perc: 'conga', ride: 'bright',
  },
  'tech-house': {
    lead: 'rave-square', pluck: 'square', chord: 'deep', keys: 'house-organ', stab: 'house', arp: 'bleep', bass: 'rolling', sub: 'pure',
    kick: 'punchy', snare: 'tight', clap: 'tight', hat: 'closed', openhat: 'open', perc: 'rim',
  },
  techno: {
    lead: 'hard-sync', pluck: 'techno-blip', pad: 'evolving', chord: 'gated', stab: 'dub-chord', arp: 'bleep', bass: 'rumble', sub: 'triangle',
    kick: 'techno', clap: 'tight', hat: 'closed', openhat: 'open', perc: 'cowbell', ride: 'bright', texture: 'dark-drone',
  },
  edm: {
    lead: 'anthem-supersaw', pluck: 'future', pad: 'supersaw', chord: 'supersaw', piano: 'fm-grand', arp: 'gated-saw', stab: 'rave',
    strings: 'cinematic', brass: 'fanfare', vox: 'chop', bass: 'pluck', '808': 'boom', sub: 'pure',
    kick: 'punchy', snare: 'tight', clap: 'big', hat: 'closed', openhat: 'open', crash: 'full', fx: 'noise-riser', texture: 'shimmer-air',
  },
  'future-bass': {
    lead: 'portamento-saw', pluck: 'future', pad: 'airy', chord: 'wobble', keys: 'dream', bell: 'crystal', arp: 'crystal', stab: 'future', vox: 'chop',
    bass: 'mid', '808': 'boom', sub: 'pure', kick: 'punchy', clap: 'big', hat: 'closed', fx: 'noise-riser', texture: 'shimmer-air',
  },
  dubstep: {
    lead: 'screech', pluck: 'crystal', pad: 'dark', chord: 'wobble', arp: 'rolling', strings: 'cinematic', bass: 'wobble', '808': 'boom', sub: 'pure',
    kick: 'punchy', snare: 'fat', hat: 'closed', crash: 'full', fx: 'laser-zap', texture: 'dark-drone',
  },
  dnb: {
    lead: 'dream', pluck: 'liquid', pad: 'liquid', stab: 'rave', arp: 'rolling', strings: 'cinematic', bass: 'reese', sub: 'pure',
    kick: 'punchy', snare: 'tight', hat: 'closed', openhat: 'long', ride: 'bright', perc: 'rim', crash: 'full', fx: 'noise-riser', texture: 'wind',
  },
  synthwave: {
    lead: 'neon-highway', pluck: 'synthwave', pad: 'sunset', chord: 'synthwave', keys: 'retro-poly', arp: 'synthwave', strings: 'string-machine', brass: 'synth', vox: 'talk',
    bass: 'synthwave', sub: 'triangle', kick: 'punchy', snare: 'gated', clap: 'big', hat: 'closed', openhat: 'open', perc: 'cowbell', tom: 'electro', crash: 'full',
    fx: 'noise-riser', texture: 'wind',
  },
};
