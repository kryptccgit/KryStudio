import type { ChainPreset, PresetFx } from '../types';
import { DEVICE_CHAIN_PRESETS } from './deviceChains';

const fx = (type: string, params: Record<string, number>, mix?: number): PresetFx => (mix === undefined ? { type, params } : { type, params, mix });

const eq = (params: Record<string, number>): PresetFx => fx('krypt.eq', params);
const comp = (params: Record<string, number>, mix?: number): PresetFx => fx('krypt.comp', params, mix);
const limiter = (inputGain: number, release = 60): PresetFx => fx('krypt.limiter', { inputGain, ceiling: -1, release, truePeak: 1 });
const clipper = (drive: number, softness: number, ceiling = -1): PresetFx => fx('krypt.clipper', { drive, ceiling, softness, oversample: 2 });
const drive = (mode: keyof typeof DRIVE, amount: number, tone: number, output = 0): PresetFx => fx('krypt.drive', { mode: DRIVE[mode], drive: amount, tone, output });

const DIV = { '1/16': 3, '1/8T': 5, '1/8': 6, '1/8D': 7, '1/4T': 8, '1/4': 9, '1/4D': 10, '1/2': 11, '1 bar': 12, '2 bars': 13, '4 bars': 14 } as const;
const DRIVE = { tape: 0, tube: 1, hard: 2, fold: 3, bitcrush: 4 } as const;
const VERB = { room: 0, hall: 1, plate: 2 } as const;
const FILTER = { lp12: 0, lp24: 1, hp12: 2, hp24: 3, bandpass: 4, notch: 5 } as const;

const chain = (c: Omit<ChainPreset, 'kind' | 'author'>): ChainPreset => ({ kind: 'chain', author: 'Krypt', ...c });

const MASTER: ChainPreset[] = [
  chain({
    id: 'factory:chain/master/club-loud',
    name: 'Club Loud',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b2Freq: 70, b2Gain: 1, b3Freq: 300, b3Gain: -1, b3Q: 0.8, b6Freq: 10000, b6Gain: 1.5 }),
      comp({ threshold: -14, ratio: 2, attack: 30, release: 100, knee: 6 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 120, highWidth: 1.1 }),
      clipper(3, 0.4),
      limiter(7.3, 40),
    ],
    targetLufs: -8,
    tags: ['loud', 'punchy', 'club', 'modern'],
    genres: ['house', 'tech-house', 'techno'],
    description: 'Four-on-the-floor club master at about -8 LUFS: low cut, mono lows under 120 Hz, glue comp, clipper, true-peak limiter. House, tech house, techno.',
  }),
  chain({
    id: 'factory:chain/master/festival-max',
    name: 'Festival Max',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 28, b1Slope: 1, b2Freq: 60, b2Gain: 1, b3Freq: 350, b3Gain: -1.5, b3Q: 0.8, b6Freq: 9000, b6Gain: 2 }),
      fx('krypt.squash', { depth: 0.15, time: 0.4 }),
      comp({ threshold: -12, ratio: 2, attack: 20, release: 80, knee: 6 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 130, midWidth: 1.05, highWidth: 1.2 }),
      clipper(4, 0.35),
      limiter(9.5, 30),
    ],
    targetLufs: -7,
    tags: ['loud', 'big', 'aggressive', 'bright', 'modern'],
    genres: ['edm'],
    description: 'Main-stage master at about -7 LUFS: bright tilt, a touch of multiband squash, wide highs, mono lows, hard clipper into the limiter. Big room and festival EDM.',
  }),
  chain({
    id: 'factory:chain/master/bass-weight',
    name: 'Bass Weight',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b3Freq: 280, b3Gain: -1.5, b3Q: 0.9, b6Freq: 10000, b6Gain: 1.5 }),
      fx('krypt.squash', { depth: 0.2, time: 0.35, upward: 0.6 }),
      comp({ threshold: -12, ratio: 2.5, attack: 15, release: 80, knee: 6 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 150, highWidth: 1.15 }),
      clipper(4.5, 0.3),
      limiter(8.5, 30),
    ],
    targetLufs: -7.5,
    tags: ['loud', 'heavy', 'big', 'aggressive'],
    genres: ['dubstep', 'future-bass'],
    description: 'Bass-music master at about -7.5 LUFS: multiband squash for dense mid-bass, mono below 150 Hz, hard clipping. Dubstep, riddim and future bass drops.',
  }),
  chain({
    id: 'factory:chain/master/trap-loud',
    name: 'Trap Loud',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 22, b1Slope: 1, b3Freq: 320, b3Gain: -1.5, b3Q: 0.9, b6Freq: 11000, b6Gain: 1.5 }),
      comp({ threshold: -14, ratio: 2, attack: 35, release: 120, knee: 8 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 140, highWidth: 1.1 }),
      clipper(4, 0.3),
      limiter(7, 50),
    ],
    targetLufs: -8,
    tags: ['loud', 'punchy', 'hard', 'modern'],
    genres: ['trap', 'drill'],
    description: 'Trap and drill master at about -8 LUFS: slow-attack glue keeps the kick and 808 punch, mono lows under 140 Hz, a firm clipper shaves the 808 peaks before the limiter.',
  }),
  chain({
    id: 'factory:chain/master/phonk-slam',
    name: 'Phonk Slam',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b2Freq: 80, b2Gain: 1.5, b6Freq: 9000, b6Gain: 1 }),
      drive('tape', 5, 16000, -2),
      comp({ threshold: -12, ratio: 3, attack: 25, release: 90, knee: 6 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 140 }),
      clipper(5, 0.2),
      limiter(8, 40),
    ],
    targetLufs: -7,
    tags: ['loud', 'distorted', 'dirty', 'aggressive', 'gritty'],
    genres: ['phonk'],
    description: 'Phonk master at about -7 LUFS: tape drive, firm glue and a near-hard clipper for the slammed, saturated sound. Use when the mix is already gritty on purpose.',
  }),
  chain({
    id: 'factory:chain/master/hiphop-punch',
    name: 'Hip-Hop Punch',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b2Freq: 90, b2Gain: 1, b3Freq: 400, b3Gain: -1, b3Q: 0.8, b6Freq: 12000, b6Gain: 1 }),
      comp({ threshold: -16, ratio: 2.5, attack: 30, release: 140, knee: 6 }),
      drive('tape', 3, 16000, -1),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 120 }),
      clipper(2.5, 0.5),
      limiter(5.7, 60),
    ],
    targetLufs: -9,
    tags: ['punchy', 'warm', 'vintage'],
    genres: ['boom-bap'],
    description: 'Boom-bap master at about -9 LUFS: warm low shelf, slow glue that lets the snare crack through, light tape colour, gentle clipper. Keeps the drums breathing.',
  }),
  chain({
    id: 'factory:chain/master/pop-polish',
    name: 'Pop Polish',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b3Freq: 300, b3Gain: -1, b3Q: 0.9, b4Freq: 3000, b4Gain: 0.5, b4Q: 0.7, b6Freq: 12000, b6Gain: 2 }),
      comp({ threshold: -16, ratio: 1.8, attack: 30, release: 150, knee: 8 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 110, highWidth: 1.15 }),
      clipper(2, 0.6),
      limiter(7, 70),
    ],
    targetLufs: -9,
    tags: ['clean', 'bright', 'polished', 'modern'],
    genres: ['pop', 'afrobeats', 'reggaeton'],
    description: 'Clean radio master at about -9 LUFS: air shelf, light mud cut, slow 1.8:1 glue, wide highs, soft clipper. Pop, afrobeats and reggaeton with vocals on top.',
  }),
  chain({
    id: 'factory:chain/master/rnb-silk',
    name: 'R&B Silk',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b2Freq: 80, b2Gain: 1, b3Freq: 350, b3Gain: -1, b3Q: 0.8, b6Freq: 12000, b6Gain: 1.5 }),
      comp({ threshold: -18, ratio: 1.6, attack: 40, release: 200, knee: 10 }),
      drive('tube', 2, 18000, -1),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 110, highWidth: 1.1 }),
      clipper(1.5, 0.7),
      limiter(5.7, 80),
    ],
    targetLufs: -10,
    tags: ['warm', 'soft', 'smooth', 'polished'],
    genres: ['rnb'],
    description: 'Smooth master at about -10 LUFS: warm low shelf, silky top, very gentle glue and tube colour. R&B, neo soul and slow jams where dynamics matter.',
  }),
  chain({
    id: 'factory:chain/master/deep-warm',
    name: 'Deep Warm',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b2Freq: 80, b2Gain: 1, b3Freq: 3500, b3Gain: -0.5, b3Q: 0.6, b6Freq: 11000, b6Gain: 0.5 }),
      comp({ threshold: -16, ratio: 2, attack: 30, release: 120, knee: 8 }),
      drive('tape', 2.5, 15000, -1),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 120 }),
      clipper(2, 0.5),
      limiter(6.4, 60),
    ],
    targetLufs: -9,
    tags: ['warm', 'deep', 'smooth', 'club'],
    genres: ['deep-house'],
    description: 'Deep house master at about -9 LUFS: warm, rounded top, tape colour and gentle glue so the groove keeps its swing. Also good for lounge-y house.',
  }),
  chain({
    id: 'factory:chain/master/dnb-roller',
    name: 'DnB Roller',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 28, b1Slope: 2, b3Freq: 300, b3Gain: -1, b3Q: 0.9, b6Freq: 10000, b6Gain: 1.5 }),
      comp({ threshold: -14, ratio: 2, attack: 10, release: 60, knee: 6 }),
      fx('krypt.squash', { depth: 0.12, time: 0.3 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 150, highWidth: 1.1 }),
      clipper(3.5, 0.4),
      limiter(7.3, 30),
    ],
    targetLufs: -8,
    tags: ['loud', 'punchy', 'tight'],
    genres: ['dnb'],
    description: 'Drum & bass master at about -8 LUFS: steep sub cut, fast glue for the breaks, light squash, mono below 150 Hz, clipper into a fast limiter.',
  }),
  chain({
    id: 'factory:chain/master/retro-glow',
    name: 'Retro Glow',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 1, b2Freq: 90, b2Gain: 1, b6Freq: 9000, b6Gain: 1.5 }),
      comp({ threshold: -16, ratio: 2, attack: 30, release: 160, knee: 8 }),
      drive('tape', 3, 16000, -1),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 120, midWidth: 1.1, highWidth: 1.2 }),
      clipper(2, 0.6),
      limiter(4.5, 70),
    ],
    targetLufs: -10,
    tags: ['warm', 'wide', 'retro', 'vintage'],
    genres: ['synthwave'],
    description: 'Synthwave master at about -10 LUFS: tape glow, a gently lifted top, wide mids and highs, soft clipper. Keeps the big gated snare and pads open.',
  }),
  chain({
    id: 'factory:chain/master/lofi-warm',
    name: 'Lofi Warm',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 30, b1Slope: 1, b2Freq: 100, b2Gain: 1.5, b6Freq: 8000, b6Gain: -2, b7On: 1, b7Freq: 15000, b7Slope: 0 }),
      drive('tape', 4, 10000, -2),
      comp({ threshold: -18, ratio: 2, attack: 30, release: 200, knee: 10 }),
      clipper(1, 0.8),
      limiter(1.4, 100),
    ],
    targetLufs: -13,
    tags: ['warm', 'lofi', 'soft', 'vintage'],
    genres: ['lofi'],
    description: 'Lo-fi master at about -13 LUFS: rolled-off top, tape warmth, slow gentle comp. Quiet on purpose; lo-fi sounds wrong slammed.',
  }),
  chain({
    id: 'factory:chain/master/streaming-clean',
    name: 'Streaming Clean',
    role: 'master',
    fx: [
      eq({ b1On: 1, b1Freq: 20, b1Slope: 1 }),
      comp({ threshold: -20, ratio: 1.5, attack: 30, release: 200, knee: 10 }),
      limiter(2, 100),
    ],
    targetLufs: -14,
    tags: ['clean', 'dynamic', 'soft', 'transparent'],
    genres: [],
    description: 'Transparent master at about -14 LUFS (the streaming reference level): sub-sonic cut, barely-there glue, true-peak safety. For dynamic songs, demos and any genre that should not be loud.',
  }),
];

const DRUM_BUS: ChainPreset[] = [
  chain({
    id: 'factory:chain/drum-bus/punchy-glue',
    name: 'Punchy Glue',
    role: 'drumBus',
    fx: [
      comp({ threshold: -18, ratio: 4, attack: 30, release: 80, knee: 4, detector: 0 }),
      fx('krypt.transient', { attack: 0.25, sustain: -0.05 }),
      eq({ b2Freq: 60, b2Gain: 1, b3Freq: 400, b3Gain: -1.5, b3Q: 1, b5Freq: 5000, b5Gain: 1.5 }),
      clipper(2, 0.5),
    ],
    tags: ['punchy', 'clean', 'modern'],
    genres: ['trap', 'drill', 'pop', 'rnb', 'afrobeats', 'reggaeton', 'future-bass', 'synthwave'],
    description: 'All-round drum bus: slow-attack 4:1 glue that keeps the transients, extra snap, a little low-mid cut and a soft clipper. Route every drum channel here.',
  }),
  chain({
    id: 'factory:chain/drum-bus/club-tight',
    name: 'Club Tight',
    role: 'drumBus',
    fx: [
      eq({ b1On: 1, b1Freq: 30, b1Slope: 1, b3Freq: 350, b3Gain: -2, b3Q: 1, b6Freq: 10000, b6Gain: 1 }),
      comp({ threshold: -16, ratio: 3, attack: 10, release: 50, knee: 4, detector: 0 }),
      fx('krypt.transient', { attack: 0.15, sustain: -0.2 }),
      clipper(2.5, 0.4),
    ],
    tags: ['tight', 'punchy', 'club'],
    genres: ['house', 'deep-house', 'tech-house', 'techno', 'edm', 'dnb'],
    description: 'Tight club drum bus: fast glue, shortened tails so kicks and claps stay separate at speed, clipper for level. House, techno, EDM and drum & bass.',
  }),
  chain({
    id: 'factory:chain/drum-bus/dirty-crunch',
    name: 'Dirty Crunch',
    role: 'drumBus',
    fx: [
      drive('tube', 8, 10000, -3),
      comp({ threshold: -24, ratio: 8, attack: 3, release: 60, knee: 2, detector: 0 }, 0.4),
      eq({ b3Freq: 300, b3Gain: -1.5, b3Q: 1, b6Freq: 8000, b6Gain: 2 }),
      clipper(3, 0.3),
    ],
    tags: ['dirty', 'gritty', 'aggressive', 'distorted'],
    genres: ['phonk', 'drill', 'dubstep', 'boom-bap'],
    description: 'Aggressive drum bus: tube drive, a blended-in smash compressor, bright top, clipper. Phonk, drill and heavy drums that should bite.',
  }),
  chain({
    id: 'factory:chain/drum-bus/dusty-tape',
    name: 'Dusty Tape',
    role: 'drumBus',
    fx: [
      eq({ b1On: 1, b1Freq: 35, b1Slope: 1, b2Freq: 100, b2Gain: 1, b7On: 1, b7Freq: 9000, b7Slope: 0 }),
      drive('tape', 7, 8000, -3),
      comp({ threshold: -20, ratio: 4, attack: 15, release: 120, knee: 6 }),
    ],
    tags: ['lofi', 'warm', 'vintage', 'dirty'],
    genres: ['lofi', 'boom-bap', 'rnb'],
    description: 'Sampled-break drum bus: rolled-off top, tape saturation, medium glue. Makes clean drums sound like they came off a record. Lo-fi and boom bap.',
  }),
];

const DRUMS: ChainPreset[] = [
  chain({
    id: 'factory:chain/drums/kick-punch',
    name: 'Kick Punch',
    role: 'drums',
    fx: [
      eq({ b1On: 1, b1Freq: 28, b1Slope: 1, b3Freq: 350, b3Gain: -3, b3Q: 1.2, b5Freq: 4000, b5Gain: 2, b5Q: 1 }),
      fx('krypt.transient', { attack: 0.35, sustain: -0.1 }),
      comp({ threshold: -12, ratio: 3, attack: 15, release: 80, knee: 4, detector: 0 }),
    ],
    tags: ['kick', 'punchy', 'tight'],
    genres: [],
    description: 'Kick insert: sub-sonic cut, boxiness scooped at 350 Hz, click lifted at 4 kHz, extra attack, slow-attack comp for punch.',
  }),
  chain({
    id: 'factory:chain/drums/snare-crack',
    name: 'Snare Crack',
    role: 'drums',
    fx: [
      eq({ b1On: 1, b1Freq: 120, b1Slope: 1, b3Freq: 220, b3Gain: 1.5, b3Q: 1.2, b4Freq: 900, b4Gain: -1.5, b4Q: 1.4, b5Freq: 5000, b5Gain: 3, b5Q: 0.9 }),
      fx('krypt.transient', { attack: 0.3 }),
      comp({ threshold: -16, ratio: 4, attack: 8, release: 100, knee: 4, detector: 0 }),
    ],
    tags: ['snare', 'clap', 'bright', 'punchy'],
    genres: [],
    description: 'Snare or clap insert: low cut, body at 220 Hz, honk cut, crack at 5 kHz, sharper attack and a fast comp. Pair with a plate or room send.',
  }),
  chain({
    id: 'factory:chain/drums/hat-shine',
    name: 'Hat Shine',
    role: 'drums',
    fx: [
      eq({ b1On: 1, b1Freq: 400, b1Slope: 1, b4Freq: 2500, b4Gain: -1.5, b4Q: 1.5, b6Freq: 10000, b6Gain: 2 }),
      fx('krypt.transient', { attack: -0.1, sustain: -0.1 }),
      fx('krypt.imager', { highWidth: 1.3 }),
    ],
    tags: ['hat', 'bright', 'airy', 'wide'],
    genres: [],
    description: 'Hi-hat, shaker or ride insert: everything under 400 Hz removed, harsh 2.5 kHz tamed, air shelf, a softened click and wider highs. Sits hats out of the way.',
  }),
  chain({
    id: 'factory:chain/drums/perc-pocket',
    name: 'Perc Pocket',
    role: 'drums',
    fx: [
      eq({ b1On: 1, b1Freq: 200, b1Slope: 1, b3Freq: 600, b3Gain: -1.5, b3Q: 1, b6Freq: 9000, b6Gain: 1 }),
      fx('krypt.transient', { attack: 0.2, sustain: -0.25 }),
      fx('krypt.delay', { sync: 1, division: DIV['1/8D'], feedback: 0.25, pingPong: 1, lowCut: 500, highCut: 6000 }, 0.12),
    ],
    tags: ['perc', 'short', 'wide', 'organic'],
    genres: [],
    description: 'Percussion insert for congas, rims, shakers and toms: low cut, tightened tails, a faint dotted-eighth ping-pong that spreads the groove.',
  }),
];

const BASS: ChainPreset[] = [
  chain({
    id: 'factory:chain/bass/808-grit',
    name: '808 Grit',
    role: 'bass',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 2 }),
      drive('tube', 7, 6000, -3),
      clipper(3, 0.6),
    ],
    insert: { stereoSep: -1 },
    tags: ['808', 'distorted', 'gritty', 'mono', 'punchy'],
    genres: ['trap', 'drill', 'phonk'],
    description: '808 insert: steep sub-sonic cut, tube drive so the 808 reads on phones, clipper for even level, mono insert. Add the sidechain duck from the kick.',
  }),
  chain({
    id: 'factory:chain/bass/clean-sub',
    name: 'Clean Sub',
    role: 'bass',
    fx: [
      eq({ b1On: 1, b1Freq: 25, b1Slope: 2, b3Freq: 300, b3Gain: -2, b3Q: 1, b7On: 1, b7Freq: 5000, b7Slope: 1 }),
      comp({ threshold: -18, ratio: 3, attack: 20, release: 120, knee: 6 }),
      fx('krypt.utility', { mono: 1 }),
    ],
    tags: ['sub', 'clean', 'deep', 'mono'],
    genres: ['rnb', 'pop', 'lofi', 'deep-house', 'dnb'],
    description: 'Clean sub or soft 808: sub-sonic and low-mid cut, gentle comp to even the notes, fully mono. When the low end should be felt, not heard.',
  }),
  chain({
    id: 'factory:chain/bass/tight-bass',
    name: 'Tight Bass',
    role: 'bass',
    fx: [
      eq({ b1On: 1, b1Freq: 30, b1Slope: 1, b3Freq: 250, b3Gain: -2, b3Q: 1, b5Freq: 2000, b5Gain: 1.5, b5Q: 1 }),
      comp({ threshold: -20, ratio: 4, attack: 5, release: 60, knee: 4 }),
      drive('tape', 4, 9000, -1),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 140 }),
    ],
    tags: ['tight', 'punchy', 'clean', 'mono'],
    genres: ['house', 'tech-house', 'techno', 'edm', 'pop', 'afrobeats', 'reggaeton', 'synthwave', 'boom-bap'],
    description: 'Synth or picked bass insert: mud cut, attack definition at 2 kHz, fast even comp, light tape saturation, mono lows. Club basslines and pop bass.',
  }),
  chain({
    id: 'factory:chain/bass/mid-bass-growl',
    name: 'Mid-Bass Growl',
    role: 'bass',
    fx: [
      eq({ b1On: 1, b1Freq: 35, b1Slope: 1, b3Freq: 300, b3Gain: -3, b3Q: 1, b5Freq: 3000, b5Gain: 2, b5Q: 0.8 }),
      drive('tube', 10, 10000, -4),
      fx('krypt.squash', { depth: 0.35, time: 0.3, lowFreq: 120, highFreq: 3000 }),
      fx('krypt.imager', { lowWidth: 0, lowFreq: 180, midWidth: 1.3 }),
    ],
    tags: ['gritty', 'distorted', 'aggressive', 'wide'],
    genres: ['dubstep', 'dnb', 'future-bass'],
    description: 'Reese, growl or wobble insert: heavy tube drive, multiband squash for dense harmonics, mono under 180 Hz and wide mids. Layer a clean sub under it.',
  }),
];

const LEAD: ChainPreset[] = [
  chain({
    id: 'factory:chain/lead/bright-wide',
    name: 'Bright Wide Lead',
    role: 'lead',
    fx: [
      eq({ b1On: 1, b1Freq: 180, b1Slope: 1, b3Freq: 500, b3Gain: -1.5, b3Q: 1, b5Freq: 4000, b5Gain: 2, b6Freq: 12000, b6Gain: 2 }),
      comp({ threshold: -18, ratio: 3, attack: 10, release: 80, knee: 6 }),
      fx('krypt.chorus', { voices: 3, rate: 0.5, depth: 0.3, spread: 1, lowCut: 300, mix: 0.25 }),
      fx('krypt.imager', { midWidth: 1.2, highWidth: 1.4 }),
    ],
    tags: ['bright', 'wide', 'modern', 'big'],
    genres: ['edm', 'future-bass', 'pop', 'trap', 'dubstep', 'house'],
    description: 'Lead or supersaw insert: low cut at 180 Hz, presence and air, steady comp, a little chorus and wide highs so it sits on top. Add reverb and delay sends.',
  }),
  chain({
    id: 'factory:chain/lead/warm-analog',
    name: 'Warm Analog Lead',
    role: 'lead',
    fx: [
      eq({ b1On: 1, b1Freq: 150, b1Slope: 1, b3Freq: 2500, b3Gain: 1, b3Q: 0.8, b6Freq: 9000, b6Gain: -1.5 }),
      drive('tape', 4, 10000, -1),
      fx('krypt.chorus', { voices: 2, rate: 0.35, depth: 0.4, spread: 0.9, lowCut: 250, mix: 0.3 }),
      comp({ threshold: -20, ratio: 2.5, attack: 15, release: 120, knee: 8 }),
    ],
    tags: ['warm', 'retro', 'vintage', 'soft'],
    genres: ['synthwave', 'deep-house', 'lofi', 'rnb', 'boom-bap'],
    description: 'Vintage synth lead: tape warmth, gentle chorus, a softened top and easy comp. Synthwave, deep house and soulful melodies.',
  }),
  chain({
    id: 'factory:chain/lead/dark-cut',
    name: 'Dark Cut Lead',
    role: 'lead',
    fx: [
      eq({ b1On: 1, b1Freq: 200, b1Slope: 1, b4Freq: 1200, b4Gain: 1.5, b4Q: 0.9, b7On: 1, b7Freq: 9000, b7Slope: 1 }),
      drive('tube', 6, 8000, -2),
      comp({ threshold: -18, ratio: 3, attack: 8, release: 70, knee: 6 }),
      fx('krypt.imager', { midWidth: 1.1 }),
    ],
    tags: ['dark', 'gritty', 'mono', 'aggressive'],
    genres: ['techno', 'drill', 'trap', 'phonk', 'dnb', 'tech-house'],
    description: 'Dark lead, bell or stab insert: upper mids forward, highs rolled off at 9 kHz, tube grit and firm comp. Drill melodies, techno stabs and phonk cowbells.',
  }),
];

const PAD: ChainPreset[] = [
  chain({
    id: 'factory:chain/pad/wide-wash',
    name: 'Wide Wash',
    role: 'pad',
    fx: [
      eq({ b1On: 1, b1Freq: 250, b1Slope: 1, b3Freq: 500, b3Gain: -2, b3Q: 0.8, b6Freq: 10000, b6Gain: 1.5 }),
      fx('krypt.chorus', { voices: 4, rate: 0.3, depth: 0.4, spread: 1, lowCut: 300, mix: 0.35 }),
      fx('krypt.imager', { midWidth: 1.4, highWidth: 1.5 }),
    ],
    tags: ['wide', 'airy', 'soft', 'dreamy'],
    genres: [],
    description: 'Pad insert: high-passed at 250 Hz so it never fights the bass, low-mid scoop, chorus and extra width. For beds behind everything else.',
  }),
  chain({
    id: 'factory:chain/pad/pumping',
    name: 'Pumping Chords',
    role: 'pad',
    fx: [
      eq({ b1On: 1, b1Freq: 200, b1Slope: 1, b3Freq: 400, b3Gain: -2, b3Q: 0.8, b6Freq: 11000, b6Gain: 2 }),
      fx('krypt.duck', { mode: 0, depth: 0.7, rate: 1, curve: 0.45 }),
      fx('krypt.imager', { midWidth: 1.3, highWidth: 1.4 }),
    ],
    tags: ['wide', 'pumping', 'big', 'euphoric'],
    genres: ['edm', 'future-bass', 'house', 'deep-house', 'tech-house'],
    description: 'Supersaw chord or pad insert with a beat-locked quarter-note pump (no sidechain routing needed), low cut and wide highs. The EDM and future-bass chord sound.',
  }),
  chain({
    id: 'factory:chain/pad/dark-drift',
    name: 'Dark Drift',
    role: 'pad',
    fx: [
      eq({ b1On: 1, b1Freq: 220, b1Slope: 1, b3Freq: 450, b3Gain: -1.5, b3Q: 0.8 }),
      fx('krypt.filter', { type: FILTER.lp12, cutoff: 3500, reso: 0.15, lfoSync: 1, lfoDivision: DIV['4 bars'], lfoDepth: 0.25, lfoShape: 1 }),
      fx('krypt.imager', { midWidth: 1.3, highWidth: 1.3 }),
    ],
    tags: ['dark', 'evolving', 'wide', 'deep'],
    genres: ['techno', 'dnb', 'drill', 'trap', 'dubstep'],
    description: 'Dark, moving pad: high-passed, a low-pass that breathes over 4 bars on a synced triangle LFO, wide. Atmospheres for techno, drum & bass and dark trap.',
  }),
];

const KEYS: ChainPreset[] = [
  chain({
    id: 'factory:chain/keys/warm-keys',
    name: 'Warm Keys',
    role: 'keys',
    fx: [
      eq({ b1On: 1, b1Freq: 90, b1Slope: 1, b3Freq: 300, b3Gain: -2, b3Q: 1, b6Freq: 9000, b6Gain: -1.5 }),
      comp({ threshold: -20, ratio: 2.5, attack: 15, release: 120, knee: 6 }),
      drive('tape', 3, 10000, -1),
      fx('krypt.chorus', { voices: 2, rate: 0.4, depth: 0.25, spread: 0.8, lowCut: 200, mix: 0.2 }),
    ],
    tags: ['warm', 'soft', 'vintage'],
    genres: ['rnb', 'lofi', 'boom-bap', 'deep-house', 'afrobeats'],
    description: 'Electric piano, organ or soft keys: mud cut, softened top, light comp, tape warmth and a slow chorus. R&B, lo-fi, boom bap and deep house chords.',
  }),
  chain({
    id: 'factory:chain/keys/bright-piano',
    name: 'Bright Piano',
    role: 'keys',
    fx: [
      eq({ b1On: 1, b1Freq: 70, b1Slope: 1, b3Freq: 350, b3Gain: -2, b3Q: 1, b5Freq: 4000, b5Gain: 2, b6Freq: 12000, b6Gain: 1.5 }),
      comp({ threshold: -18, ratio: 3, attack: 10, release: 100, knee: 6 }),
      fx('krypt.imager', { midWidth: 1.15, highWidth: 1.2 }),
    ],
    tags: ['bright', 'clean', 'modern'],
    genres: ['pop', 'house', 'afrobeats', 'reggaeton', 'edm', 'trap'],
    description: 'Piano or bright keys: low-mid cut, presence and air, firm comp so the chords stay level under a vocal, a little width. Pop, piano house, afrobeats.',
  }),
];

const PLUCK: ChainPreset[] = [
  chain({
    id: 'factory:chain/pluck/tight-pluck',
    name: 'Tight Pluck',
    role: 'pluck',
    fx: [
      eq({ b1On: 1, b1Freq: 200, b1Slope: 1, b5Freq: 3500, b5Gain: 2, b6Freq: 11000, b6Gain: 1 }),
      comp({ threshold: -18, ratio: 4, attack: 3, release: 50, knee: 4 }),
      fx('krypt.delay', { sync: 1, division: DIV['1/8D'], feedback: 0.3, pingPong: 1, lowCut: 400, highCut: 7000 }, 0.15),
      fx('krypt.imager', { highWidth: 1.3 }),
    ],
    tags: ['bright', 'short', 'wide', 'modern'],
    genres: ['edm', 'future-bass', 'house', 'trap', 'pop', 'tech-house'],
    description: 'Pluck or arp insert: low cut, bite at 3.5 kHz, fast comp, a dotted-eighth ping-pong tail and wide highs. Progressive plucks, trap bells, pop arps.',
  }),
  chain({
    id: 'factory:chain/pluck/dreamy-pluck',
    name: 'Dreamy Pluck',
    role: 'pluck',
    fx: [
      eq({ b1On: 1, b1Freq: 180, b1Slope: 1, b6Freq: 9000, b6Gain: -1 }),
      fx('krypt.chorus', { voices: 3, rate: 0.45, depth: 0.45, spread: 1, lowCut: 250, mix: 0.35 }),
      fx('krypt.delay', { sync: 1, division: DIV['1/4'], feedback: 0.4, pingPong: 1, lowCut: 400, highCut: 5000, modDepth: 0.3 }, 0.2),
      fx('krypt.reverb', { mode: VERB.hall, size: 0.7, decay: 2.8, predelay: 20, damping: 6000, lowCut: 300 }, 0.2),
    ],
    tags: ['dreamy', 'soft', 'airy', 'wide'],
    genres: ['lofi', 'synthwave', 'rnb', 'future-bass', 'deep-house'],
    description: 'Soft pluck, bell or arp in its own space: chorus, a wobbly quarter-note ping-pong and a hall built in. Lo-fi, synthwave and dreamy R&B.',
  }),
];

const VOCAL: ChainPreset[] = [
  chain({
    id: 'factory:chain/vocal/pop-vocal',
    name: 'Pop Vocal',
    role: 'vocal',
    fx: [
      eq({ b1On: 1, b1Freq: 100, b1Slope: 1, b3Freq: 300, b3Gain: -2, b3Q: 1.2, b4Freq: 3000, b4Gain: 1.5, b4Q: 0.8, b5Freq: 7000, b5Gain: -2, b5Q: 4 }),
      comp({ threshold: -22, ratio: 4, attack: 5, release: 80, knee: 6 }),
      comp({ threshold: -14, ratio: 2, attack: 30, release: 200, knee: 8 }),
      eq({ b6Freq: 12000, b6Gain: 3 }),
    ],
    tags: ['bright', 'clean', 'polished', 'upfront'],
    genres: ['pop', 'edm', 'future-bass', 'house', 'afrobeats', 'reggaeton'],
    description: 'Lead vocal: low cut, mud cut, presence, a narrow sibilance dip at 7 kHz, two-stage compression and air. Put pitch correction (Krypt Tune) before it, sends after.',
  }),
  chain({
    id: 'factory:chain/vocal/rap-upfront',
    name: 'Rap Upfront',
    role: 'vocal',
    fx: [
      eq({ b1On: 1, b1Freq: 90, b1Slope: 1, b3Freq: 250, b3Gain: -2.5, b3Q: 1.2, b4Freq: 2500, b4Gain: 2, b4Q: 0.9, b6Freq: 11000, b6Gain: 2 }),
      comp({ threshold: -24, ratio: 6, attack: 3, release: 60, knee: 4 }),
      drive('tube', 3, 16000, -1),
      clipper(1.5, 0.8),
    ],
    tags: ['punchy', 'upfront', 'dry', 'bright'],
    genres: ['trap', 'drill', 'boom-bap', 'phonk'],
    description: 'Rap vocal: low cut, mud cut, 2.5 kHz bite, hard 6:1 comp, a little tube grit and a soft clipper for peaks. Dry and in front; use a short delay send, not a big reverb.',
  }),
  chain({
    id: 'factory:chain/vocal/silk-vocal',
    name: 'Silk Vocal',
    role: 'vocal',
    fx: [
      eq({ b1On: 1, b1Freq: 90, b1Slope: 1, b3Freq: 320, b3Gain: -1.5, b3Q: 1, b5Freq: 6500, b5Gain: -1.5, b5Q: 4, b6Freq: 12000, b6Gain: 3 }),
      comp({ threshold: -20, ratio: 3, attack: 15, release: 150, knee: 8 }),
      fx('krypt.chorus', { voices: 2, rate: 0.3, depth: 0.2, delay: 18, spread: 1, lowCut: 300, mix: 0.15 }),
    ],
    tags: ['airy', 'soft', 'wide', 'smooth'],
    genres: ['rnb', 'lofi', 'deep-house', 'synthwave'],
    description: 'Soft, airy vocal: gentle comp, sibilance dip, lots of air and a faint doubling chorus. R&B, lo-fi and deep house vocals that sit inside the track.',
  }),
  chain({
    id: 'factory:chain/vocal/stem-vocal',
    name: 'Stem Vocal',
    role: 'vocal',
    fx: [
      eq({ b1On: 1, b1Freq: 120, b1Slope: 1, b3Freq: 300, b3Gain: -1.5, b3Q: 1, b5Freq: 6500, b5Gain: -2, b5Q: 2 }),
      comp({ threshold: -20, ratio: 2, attack: 15, release: 150, knee: 8 }),
    ],
    tags: ['clean', 'natural', 'transparent'],
    genres: [],
    description: 'A vocal lifted from a finished song (a separated stem or an a cappella): it is already mixed, so only a low cut under its new beat, a little mud and separation-fizz cut, and gentle levelling. No air boost: that brings the separation artefacts up. Auto Mashup uses it.',
  }),
];

const REVERB_SENDS: ChainPreset[] = [
  chain({
    id: 'factory:chain/reverb-send/plate',
    name: 'Bright Plate',
    role: 'reverbSend',
    fx: [
      fx('krypt.reverb', { mode: VERB.plate, size: 0.5, decay: 1.6, predelay: 20, damping: 9000, lowCut: 250, diffusion: 0.8 }, 1),
      eq({ b1On: 1, b1Freq: 300, b1Slope: 1, b3Freq: 500, b3Gain: -2, b3Q: 0.8, b6Freq: 8000, b6Gain: -1 }),
    ],
    tags: ['bright', 'short', 'vocal', 'snare'],
    genres: [],
    description: 'Plate return (100% wet): 1.6 s bright plate with 20 ms pre-delay, mud cut. Vocals, snares and claps. Send about -12 dB.',
  }),
  chain({
    id: 'factory:chain/reverb-send/hall',
    name: 'Big Hall',
    role: 'reverbSend',
    fx: [
      fx('krypt.reverb', { mode: VERB.hall, size: 0.85, decay: 3.5, predelay: 30, damping: 6500, lowCut: 250, diffusion: 0.8 }, 1),
      eq({ b1On: 1, b1Freq: 300, b1Slope: 1, b3Freq: 450, b3Gain: -2, b3Q: 0.8, b6Freq: 9000, b6Gain: -2 }),
    ],
    tags: ['big', 'long', 'wide', 'euphoric'],
    genres: ['edm', 'future-bass', 'pop', 'synthwave', 'dubstep', 'trap'],
    description: 'Hall return (100% wet): 3.5 s wide hall, 30 ms pre-delay, low end and mud removed. Leads, pads and breakdowns. Send about -15 dB.',
  }),
  chain({
    id: 'factory:chain/reverb-send/room',
    name: 'Tight Room',
    role: 'reverbSend',
    fx: [
      fx('krypt.reverb', { mode: VERB.room, size: 0.35, decay: 0.7, predelay: 5, damping: 8000, lowCut: 200, diffusion: 0.7 }, 1),
      eq({ b1On: 1, b1Freq: 250, b1Slope: 1, b3Freq: 400, b3Gain: -2, b3Q: 1 }),
    ],
    tags: ['short', 'small', 'organic', 'vintage'],
    genres: ['boom-bap', 'lofi', 'house', 'tech-house', 'afrobeats', 'reggaeton', 'dnb'],
    description: 'Room return (100% wet): 0.7 s small room. Glues drums and percussion into one space without washing them out. Send about -14 dB.',
  }),
  chain({
    id: 'factory:chain/reverb-send/dark-space',
    name: 'Dark Space',
    role: 'reverbSend',
    fx: [
      fx('krypt.reverb', { mode: VERB.hall, size: 1, decay: 7, predelay: 45, damping: 4000, lowCut: 300, diffusion: 0.9 }, 1),
      eq({ b1On: 1, b1Freq: 350, b1Slope: 1, b3Freq: 500, b3Gain: -2, b3Q: 0.7 }),
    ],
    tags: ['dark', 'long', 'deep', 'evolving'],
    genres: ['techno', 'dnb', 'deep-house', 'drill', 'lofi'],
    description: 'Long dark return (100% wet): 7 s heavily damped hall. Atmospheres, techno stabs, throws on the last hit of a phrase. Send low (about -18 dB).',
  }),
];

const DELAY_SENDS: ChainPreset[] = [
  chain({
    id: 'factory:chain/delay-send/dotted-eighth',
    name: 'Dotted Eighth',
    role: 'delaySend',
    fx: [
      fx('krypt.delay', { sync: 1, division: DIV['1/8D'], feedback: 0.35, pingPong: 0, lowCut: 300, highCut: 6000, modDepth: 0.1 }, 1),
      eq({ b1On: 1, b1Freq: 300, b1Slope: 1, b3Freq: 500, b3Gain: -2, b3Q: 0.8 }),
    ],
    tags: ['rhythmic', 'clean', 'modern'],
    genres: [],
    description: 'Dotted-eighth delay return (100% wet, tempo-synced): echoes fill the gaps of straight-eighth parts. Leads, plucks, vocal throws. Send about -15 dB.',
  }),
  chain({
    id: 'factory:chain/delay-send/quarter-ping-pong',
    name: 'Quarter Ping-Pong',
    role: 'delaySend',
    fx: [
      fx('krypt.delay', { sync: 1, division: DIV['1/4'], feedback: 0.4, pingPong: 1, lowCut: 350, highCut: 7000, modDepth: 0.1 }, 1),
      eq({ b1On: 1, b1Freq: 350, b1Slope: 1, b3Freq: 500, b3Gain: -2, b3Q: 0.8 }),
    ],
    tags: ['wide', 'rhythmic', 'clean'],
    genres: [],
    description: 'Quarter-note ping-pong return (100% wet, synced): the first echo lands left a beat later, the next right. Wide vocal and lead throws. Send about -16 dB.',
  }),
  chain({
    id: 'factory:chain/delay-send/tape-echo',
    name: 'Tape Echo',
    role: 'delaySend',
    fx: [
      fx('krypt.delay', { sync: 1, division: DIV['1/8'], feedback: 0.5, pingPong: 0, lowCut: 250, highCut: 3500, modDepth: 0.35 }, 1),
      drive('tape', 6, 5000, -2),
      eq({ b1On: 1, b1Freq: 300, b1Slope: 1 }),
    ],
    tags: ['warm', 'lofi', 'dark', 'vintage'],
    genres: ['lofi', 'boom-bap', 'phonk', 'rnb', 'synthwave'],
    description: 'Dark, wobbly eighth-note tape echo return (100% wet): saturated repeats that fade into the background. Lo-fi keys, boom-bap horns, ad-lib throws.',
  }),
];

const CHARACTER: ChainPreset[] = [
  chain({
    id: 'factory:chain/character/lofi-tape',
    name: 'Lofi Tape',
    role: 'character',
    fx: [
      eq({ b1On: 1, b1Freq: 70, b1Slope: 0, b7On: 1, b7Freq: 7500, b7Slope: 0 }),
      drive('tape', 8, 7000, -3),
      fx('krypt.chorus', { voices: 1, rate: 0.5, depth: 0.12, delay: 6, spread: 0, lowCut: 20, highCut: 20000, mix: 1 }),
      comp({ threshold: -20, ratio: 2.5, attack: 20, release: 150, knee: 8 }),
    ],
    tags: ['lofi', 'warm', 'vintage', 'tape'],
    genres: ['lofi', 'boom-bap', 'rnb', 'phonk'],
    description: 'Worn tape on any insert: dull top, warm saturation and a slow pitch wobble. Lo-fi keys, samples and whole-beat colour. Automate the EQ high cut for intros.',
  }),
  chain({
    id: 'factory:chain/character/telephone',
    name: 'Telephone',
    role: 'character',
    fx: [
      eq({ b1On: 1, b1Freq: 450, b1Slope: 2, b4Freq: 1500, b4Gain: 4, b4Q: 1, b7On: 1, b7Freq: 3200, b7Slope: 2 }),
      drive('tube', 10, 4000, -4),
      fx('krypt.utility', { mono: 1 }),
    ],
    tags: ['lofi', 'small', 'telephone', 'radio'],
    genres: [],
    description: 'Telephone or small-radio voice: steep band-pass 450 Hz to 3.2 kHz, honky mid boost, tube grit, mono. Intros, a verse line, a breakdown vocal.',
  }),
  chain({
    id: 'factory:chain/character/crushed',
    name: 'Bit Crushed',
    role: 'character',
    fx: [
      fx('krypt.drive', { mode: DRIVE.bitcrush, drive: 3, bits: 9, downsample: 3, tone: 12000, output: -3 }),
      eq({ b1On: 1, b1Freq: 40, b1Slope: 1, b7On: 1, b7Freq: 10000, b7Slope: 0 }),
    ],
    tags: ['crushed', 'dirty', 'digital', 'gritty'],
    genres: ['phonk', 'dubstep', 'trap', 'lofi'],
    description: 'Bit-crushed colour: 9-bit, 3x sample-rate reduction, harsh top trimmed. Drums, cowbells, vocal chops and FX that should sound broken.',
  }),
  chain({
    id: 'factory:chain/character/tube-warmth',
    name: 'Tube Warmth',
    role: 'character',
    fx: [
      drive('tube', 4, 16000, -1),
      eq({ b2Freq: 100, b2Gain: 1, b6Freq: 10000, b6Gain: -1 }),
    ],
    tags: ['warm', 'analog', 'soft', 'vintage'],
    genres: [],
    description: 'Gentle tube saturation with a warm tilt. Thickens thin synths, keys and buses without obvious distortion.',
  }),
];

const TRANSITION: ChainPreset[] = [
  chain({
    id: 'factory:chain/transition/hp-sweep',
    name: 'High-Pass Sweep',
    role: 'transition',
    fx: [fx('krypt.filter', { type: FILTER.hp24, cutoff: 20, reso: 0.3, lfoDepth: 0 })],
    tags: ['build', 'riser', 'sweep'],
    genres: [],
    description: 'Build sweep on a music bus or the master: transparent at 20 Hz. Automate Cutoff up to 1-2 kHz over the build, snap back to 20 Hz on the drop downbeat.',
  }),
  chain({
    id: 'factory:chain/transition/lp-sweep',
    name: 'Low-Pass Sweep',
    role: 'transition',
    fx: [fx('krypt.filter', { type: FILTER.lp24, cutoff: 20000, reso: 0.25, lfoDepth: 0 })],
    tags: ['breakdown', 'intro', 'sweep', 'filter'],
    genres: [],
    description: 'Muffle-and-open filter: transparent fully open. Automate Cutoff down to 300-800 Hz for an intro or breakdown, then open it back up across the build.',
  }),
  chain({
    id: 'factory:chain/transition/stutter',
    name: 'Stutter Gate',
    role: 'transition',
    fx: [fx('krypt.gate', { pattern: 2, trigger: 1, active: 0, depth: 1, smoothing: 4 })],
    tags: ['stutter', 'build', 'glitch'],
    genres: [],
    description: '1/16 stutter that only runs while Active is on: automate Active to On for the last beat or two before a drop or a new section. Passes audio untouched otherwise.',
  }),
];

export const CHAIN_PRESETS: readonly ChainPreset[] = [
  ...MASTER,
  ...DRUM_BUS,
  ...DRUMS,
  ...BASS,
  ...LEAD,
  ...PAD,
  ...KEYS,
  ...PLUCK,
  ...VOCAL,
  ...REVERB_SENDS,
  ...DELAY_SENDS,
  ...CHARACTER,
  ...TRANSITION,
  ...DEVICE_CHAIN_PRESETS,
];
