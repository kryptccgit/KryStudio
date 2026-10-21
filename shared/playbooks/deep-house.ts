import type { Playbook } from './types';

export const DEEP_HOUSE: Playbook = {
  id: 'deep-house',
  name: 'Deep house',
  summary:
    'Warm, late-night house at 118-124 bpm. A softer four-on-the-floor kick, a clap or rim on 2 and 4, shuffling hats and shakers with real swing, and a round, melodic bass under rich minor 9th and 11th chords on electric piano or a soft analog stab. Movement comes from filters and chord colour rather than drops: long phrases, a gentle breakdown, an understated pluck motif. Smooth and hypnotic, never harsh.',
  bpm: { min: 118, max: 124, typical: 122 },
  grid: 16,
  swing: 25,
  keys: {
    modes: ['dorian', 'natural minor', 'minor with 9ths and 11ths'],
    common: ['Fm', 'Cm', 'Gm', 'Dm', 'Bbm', 'Am', 'Ebm'],
    notes: 'Minor keys with dorian colour; voicings with the 9th and 11th give the deep, jazzy mood.',
  },
  harmony: {
    progressions: ['i9 – iv9 (dorian vamp, 2 bars each)', 'i7 – ♭VIImaj7 – ♭VImaj7 – v7', 'ii9 – V13 – Imaj9', 'i9 – ♭IIImaj7 (two-chord float)'],
    rhythm: 'One chord per bar or a two-chord vamp over 4-8 bars; stabs on the offbeats or held chords moved by a slow filter.',
    voicing: 'Rich m9 / m11 / maj9 voicings on electric piano or a soft analog stab in octave 3-4; nothing low (the bass owns octave 1-2).',
  },
  melody:
    'Minimal: a soft pluck motif or vocal-chop phrase in the second drop, small range around the 9th and 11th, or no lead at all. Mood comes from chord colour and filter movement.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'soft', 'deep'], writing: 'Four on the floor, a rounder, softer kick than house; velocity steady.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'soft'], writing: 'Soft clap or rim on 2 and 4, with reverb; a flam at phrase ends.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'soft'], writing: 'Offbeat 8th hats, soft; apply transform_notes groove "funk" at 30% timing, 50% velocity to hats, shaker and keys.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'An open hat at the end of each 2-bar phrase in the drops.', bus: 'Drum Bus' },
    { name: 'Shaker', role: 'perc', sample: 'shaker', tags: ['perc', 'organic'], writing: 'Constant 16th shaker with accents, the main shuffle; a short roll at phrase ends.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['deep', 'warm', 'round'], range: [26, 52], writing: 'Round, melodic bass in octave 1-2: the root on the downbeat, syncopated passing notes through the bar; ducks under the kick.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Keys', role: 'keys', tags: ['warm', 'soft'], range: [48, 84], writing: 'm9 stabs on the offbeats and syncopated 16ths in octave 3, slow filter movement over 8-16 bars.', chain: 'keys' },
    { name: 'Pad', role: 'pad', tags: ['warm', 'dreamy', 'soft'], range: [45, 80], writing: 'Held chords for the breakdown and drop 2, pumping gently.', chain: 'pad' },
    { name: 'Pluck', role: 'pluck', tags: ['soft', 'dreamy'], range: [60, 88], writing: 'A soft 2-bar motif with space, drop 2 only, with delay.', chain: 'pluck' },
  ],
  patterns: [
    {
      name: 'Deep Groove',
      for: ['drop', 'drop 2', 'groove'],
      kpn: `pattern "Deep Groove" bars=2 grid=16 key=Fm
Kick    : x... x... x... x... | x... x... x... x...
Clap    : .... x... .... x... | .... x... .... x...
Hat     : ..5. ..5. ..5. ..5. | ..5. ..5. ..5. ....
OpenHat : .... .... .... .... | .... .... .... ..4.
Shaker  : 3535 3535 3535 3535 | 3535 3535 3535 3536`,
      notes: 'Soft and shuffling: swing around 25 plus the funk groove.',
    },
    {
      name: 'Deep Intro',
      for: ['intro', 'outro'],
      kpn: `pattern "Deep Intro" bars=2 grid=16 key=Fm
Kick   : x... x... x... x... | x... x... x... x...
Hat    : ..4. ..4. ..4. ..4. | ..4. ..4. ..4. ..4.
Shaker : 3535 3535 3535 3535 | 3535 3535 3535 3535`,
      notes: 'DJ-friendly intro and outro groove.',
    },
    {
      name: 'Deep Fill',
      for: ['drop', 'drop 2'],
      kpn: `pattern "Deep Fill" bars=1 grid=16 key=Fm
Kick   : x... x... x... ....
Clap   : .... x... .... x.x.
Shaker : 3535 3535 3535 5678`,
      notes: 'End of every 8-bar phrase.',
    },
    {
      name: 'Bass + Keys',
      for: ['groove', 'drop', 'drop 2', 'breakdown'],
      kpn: `pattern "Bass + Keys" bars=4 grid=16 key=Fm
Keys {oct=3 vel=78}: r:2 Fm9:4 r:2 r:2 Fm9:2 r:4 | r:2 Fm9:4 r:2 r:4 Fm9:4 | r:2 Bbm9:4 r:2 r:2 Bbm9:2 r:4 | r:2 Bbm9:4 r:2 r:4 Bbm9:4
Bass {oct=1}: F1:3 r:3 F1:2 r:2 Ab1:2 C2:2 F1:2 | F1:3 r:3 F1:2 r:2 Eb2:2 C2:2 Ab1:2 | Bb1:3 r:3 Bb1:2 r:2 Db2:2 F2:2 Bb1:2 | Bb1:3 r:3 Bb1:2 r:2 Ab1:2 G1:2 Eb1:2`,
      notes: 'i9 – iv9 vamp; the bass walks through chord tones and lands back on the root.',
    },
    {
      name: 'Pluck Motif',
      for: ['drop 2'],
      kpn: `pattern "Pluck Motif" bars=2 grid=16 key=Fm
Pluck {vel=84}: C6:2 r:2 Ab5:2 r:2 G5:2 r:2 F5:4 | Eb5:2 r:2 F5:2 r:2 G5:2 Ab5:2 G5:4`,
      notes: 'Soft, spacious motif with a dotted-eighth delay.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 16, energy: 0.35, parts: ['Kick', 'Hat', 'Shaker'], notes: 'Deep Intro; the clap appears at bar 9.' },
    { kind: 'verse', label: 'Groove', bars: 16, energy: 0.55, parts: ['Kick', 'Clap', 'Hat', 'Shaker', 'Bass'], notes: 'The bass enters; keys teased through a closed low-pass in the last 4 bars.' },
    { kind: 'drop', label: 'Drop 1', bars: 32, energy: 0.8, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Shaker', 'Bass', 'Keys'], transitionIn: ['filter-sweep'], notes: 'Keys open up over 16 bars (automate the filter); Deep Fill every 8 bars.' },
    { kind: 'breakdown', label: 'Breakdown', bars: 16, energy: 0.35, parts: ['Keys', 'Pad', 'Shaker'], transitionIn: ['downlifter'], notes: 'Kick and bass out; chords and pad breathe with reverb.' },
    { kind: 'drop', label: 'Drop 2', bars: 32, energy: 0.9, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Shaker', 'Bass', 'Keys', 'Pad', 'Pluck'], transitionIn: ['riser', 'crash'], notes: 'The pluck motif and pad join.' },
    { kind: 'outro', label: 'Outro', bars: 16, energy: 0.35, parts: ['Kick', 'Hat', 'Shaker', 'Bass'], transitionIn: ['filter-sweep'], notes: 'Back to the groove; bass leaves at bar 9.' },
  ],
  mix: {
    master: { tags: ['warm', 'deep'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['club', 'tight'] }],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['dark', 'long'], from: [{ part: 'Clap', amount: 0.2 }, { part: 'Keys', amount: 0.25 }, { part: 'Pad', amount: 0.3 }, { part: 'Pluck', amount: 0.25 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Pluck', amount: 0.25 }, { part: 'Keys', amount: 0.1 }] },
    ],
    levels:
      'Kick and bass together at the top (bass ducked); clap 3-4 dB under the kick, soft; shaker and hats 10 dB under the clap; keys 4-6 dB under the clap, warm; pad low; pluck 2 dB under the keys.',
    notes: 'Warmth over loudness: soften the top (high shelf -1 to -2 dB on keys), tape saturation on the master, nothing harsh above 8 kHz.',
  },
  transitions:
    'Smooth: filter sweeps on the keys and pad (low-pass opening over 8-16 bars), a downlifter into the breakdown, a soft riser and crash back into the drop. Small fills at the end of each 8-bar phrase.',
  mistakes: [
    'Bright, hard sounds: deep house is warm and round; soften the kick and the top end.',
    'Plain triads: m9, m11 and maj9 chords are the sound.',
    'Rigid hats and shakers: swing 20-30 and transform_notes groove "funk" (25-35%) on the hats, shaker and keys.',
    'Big EDM builds and risers: movement comes from slow filter automation, not snare rolls.',
    'A boring root-only bass: the bass is melodic and syncopated, walking through chord tones.',
    'No space: leave room in the stab rhythm; the groove breathes.',
  ],
  groove: { template: 'funk', amount: 0.3, velocity: 0.5, parts: ['Hat', 'OpenHat', 'Shaker', 'Keys'] },
  targets: {
    lufs: -9,
    truePeakDb: -1,
    bars: [96, 192],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-6, 5], highMid: [-12, 0], high: [-20, 0] },
    contrastLu: [3, 10],
    minCorrelation: 0.4,
    maxStaticBars: 16,
    minHatVelocitySpread: 4,
  },
};
