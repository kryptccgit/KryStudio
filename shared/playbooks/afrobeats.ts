// Afrobeats: syncopated percussion grooves, bright maj7 chords, a melodic bass and call-and-response hooks.
import type { Playbook } from './types';

export const AFROBEATS: Playbook = {
  id: 'afrobeats',
  name: 'Afrobeats',
  summary:
    'Warm, bouncy West African pop at 95-115 bpm. The groove is everything: a syncopated kick, a rim pattern that plays against it, a constant shaker with accents and congas filling the gaps, all with a gentle swing. Bright major-7th chords are played rhythmically on keys and a picked, guitar-like pluck; a melodic bass moves with the kick. Hooks are short and repeated in call and response. Amapiano (108-115 bpm) shares the shaker bed but swaps the bass for a pitched, gliding log drum and is sparser and more piano-led.',
  bpm: { min: 95, max: 115, typical: 104 },
  grid: 16,
  swing: 20,
  keys: {
    modes: ['major', 'dorian', 'natural minor'],
    common: ['Ab', 'Eb', 'Db', 'Bb', 'F#m', 'Bbm', 'C#m'],
    notes: 'Major keys with maj7 and 9th colours dominate; minor and dorian for the darker, amapiano-leaning tracks.',
  },
  harmony: {
    progressions: ['I – vi – IV – V', 'Imaj7 – IVmaj7 (two-chord vamp)', 'ii7 – V7 – Imaj7', 'i – iv – ♭VII – ♭III (minor)'],
    rhythm: 'Mostly 2-4 chords looped over 4 bars, often a two-chord vamp. Chords are played as rhythm (offbeat stabs, 16th-note guitar-like patterns), not held.',
    voicing: 'Bright maj7 / 9 voicings on keys in octave 4, a picked guitar-like line in octave 4-5 outlining the chord; a warm pad underneath in the choruses.',
  },
  melody:
    'Call and response: short, catchy vocal phrases answered by the guitar-like pluck or a synth lead; pentatonic, syncopated against the 3-3-2 feel, repeated with small rhythmic changes. Melodies sit in a comfortable mid range and rarely leap.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'warm'], writing: 'Syncopated, not four-on-the-floor: beat 1, the "and" of 2 (step 7), beat 3 and a pickup (step 15). After writing, apply transform_notes groove "afrobeat" at 60% timing, 60% velocity to every drum part and 40% to the bass.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Rim', role: 'perc', sample: 'rim', tags: ['perc', 'short'], writing: 'The signature counter-rhythm: rimshots on off-steps (4, 7, 12, 14) that dance around the kick; changes slightly in the second bar.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'soft'], writing: 'Soft clap or snare on 2 and 4 under the rim; louder in choruses.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Shaker', role: 'perc', sample: 'shaker', tags: ['perc', 'organic'], writing: 'Constant 16ths with accents on the offbeats (alternating soft/loud), never stopping; drop single hits now and then so it breathes.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'perc', tags: ['perc', 'organic'], writing: 'Congas or bongos filling the gaps between kick and rim, 2-bar phrases, low-mid velocity.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: 'Open-ish hats on the offbeat 8ths in the choruses only.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['warm', 'round'], range: [26, 52], writing: 'Melodic, syncopated bass in a 3-3-2-4-4 rhythm on the chord roots with 5ths and passing notes; octave 1-2. (Amapiano: a pitched log drum gliding between notes instead.)', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Keys', role: 'keys', tags: ['warm', 'soft'], range: [55, 84], writing: 'Offbeat chord stabs (maj7 / m7) in octave 4, every 8th offbeat, velocity 75-90.', chain: 'keys' },
    { name: 'Guitar', role: 'pluck', tags: ['bright', 'organic'], range: [55, 84], writing: 'A picked, guitar-like 16th-note riff outlining the chords; the main melodic hook between vocals.', chain: 'pluck' },
    { name: 'Pad', role: 'pad', tags: ['warm', 'soft'], range: [48, 80], writing: 'Warm sustained chords under the choruses and the break; low.', chain: 'pad' },
  ],
  patterns: [
    {
      name: 'Afro Groove',
      for: ['verse', 'chorus'],
      kpn: `pattern "Afro Groove" bars=2 grid=16 key=Ab
Kick    : x... ..x. x... ..x. | x... ..x. x..x ....
Rim     : ...x ..x. ...x .x.. | ...x ..x. .... x.x.
Clap    : .... 6... .... 6... | .... 6... .... 6...
Shaker  : 4646 4646 4646 4646 | 4646 4646 4646 4657
Perc    : .... ..5. 5.7. .... | ..5. ..6. 5... 7.5.`,
      notes: 'The rim answers the kick; congas fill the holes; set swing about 20 and the afrobeat groove.',
    },
    {
      name: 'Afro Chorus',
      for: ['chorus'],
      kpn: `pattern "Afro Chorus" bars=2 grid=16 key=Ab
Kick    : x... ..x. x... ..x. | x... ..x. x... x.x.
Rim     : ...x ..x. ...x .x.. | ...x ..x. ...x .x..
Clap    : .... x... .... x... | .... x... .... x...
Hat     : ..5. ..5. ..5. ..5. | ..5. ..5. ..5. ..56
Shaker  : 4646 4646 4646 4646 | 4646 4646 4646 4646`,
      notes: 'Louder claps and offbeat hats lift the chorus.',
    },
    {
      name: 'Bass + Keys',
      for: ['verse', 'chorus', 'break'],
      kpn: `pattern "Bass + Keys" bars=4 grid=16 key=Ab
Keys {oct=4 vel=82}: (r:2 Abmaj7:2)*4 | (r:2 Fm7:2)*4 | (r:2 Dbmaj7:2)*4 | (r:2 Eb:2)*4
Bass {oct=1}: Ab1:3 Ab1:3 Eb2:2 Ab1:4 C2:4 | F1:3 F1:3 C2:2 F1:4 Ab1:4 | Db2:3 Db2:3 Ab1:2 Db2:4 F1:4 | Eb1:3 Eb1:3 Bb1:2 Eb2:4 G1:4`,
      notes: 'I – vi – IV – V with offbeat keys; the bass rhythm is 3-3-2 then 4-4.',
    },
    {
      name: 'Guitar Riff',
      for: ['intro', 'verse', 'chorus', 'outro'],
      kpn: `pattern "Guitar Riff" bars=2 grid=16 key=Ab
Guitar {vel=84}: Eb5:2 C5:1 Ab4:1 Eb5:2 C5:2 F5:2 Eb5:2 C5:2 Ab4:2 | Eb5:2 C5:1 Ab4:1 Eb5:2 C5:2 Bb4:2 Ab4:2 G4:4`,
      notes: 'Picked chord-tone riff; pan it off-centre and give it the dotted-eighth delay.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.35, parts: ['Guitar', 'Keys', 'Shaker'], notes: 'Guitar riff, keys and shaker; the kick may enter on bar 5.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.6, parts: ['Kick', 'Rim', 'Shaker', 'Bass', 'Keys'], transitionIn: ['drum-fill'], notes: 'Afro Groove without clap; leave space for the vocal.' },
    { kind: 'chorus', label: 'Chorus 1', bars: 8, energy: 0.85, parts: ['Kick', 'Rim', 'Clap', 'Shaker', 'Perc', 'Hat', 'Bass', 'Keys', 'Guitar'], transitionIn: ['drum-fill'] },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.65, parts: ['Kick', 'Rim', 'Clap', 'Shaker', 'Perc', 'Bass', 'Keys', 'Guitar'], notes: 'Congas and guitar join; vary the rim every 4 bars.' },
    { kind: 'chorus', label: 'Chorus 2', bars: 8, energy: 0.9, parts: ['Kick', 'Rim', 'Clap', 'Shaker', 'Perc', 'Hat', 'Bass', 'Keys', 'Guitar', 'Pad'], transitionIn: ['drum-fill'] },
    { kind: 'break', label: 'Break', bars: 8, energy: 0.45, parts: ['Keys', 'Pad', 'Shaker', 'Perc'], transitionIn: ['filter-sweep'], notes: 'Kick and bass out: percussion and chords only, then everything back.' },
    { kind: 'chorus', label: 'Chorus 3', bars: 8, energy: 1, parts: ['Kick', 'Rim', 'Clap', 'Shaker', 'Perc', 'Hat', 'Bass', 'Keys', 'Guitar', 'Pad'], transitionIn: ['drum-fill'] },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.35, parts: ['Guitar', 'Shaker', 'Perc', 'Pad'], transitionIn: ['filter-sweep'] },
  ],
  mix: {
    master: { tags: ['clean', 'polished'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['punchy', 'clean'] }],
    sends: [
      { name: 'Room', chain: 'reverbSend', tags: ['short', 'organic'], from: [{ part: 'Rim', amount: 0.2 }, { part: 'Perc', amount: 0.2 }, { part: 'Keys', amount: 0.2 }, { part: 'Guitar', amount: 0.15 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Guitar', amount: 0.2 }, { part: 'Keys', amount: 0.1 }] },
    ],
    levels:
      'Kick and bass lead the low end together (bass ducks lightly); rim and clap 3-4 dB under the kick; shaker 10-12 dB under, constant; congas 6-8 dB under the rim; keys and guitar 5-6 dB under the clap, panned apart; pad low.',
    notes: 'Pan the percussion (rim slightly left, congas right, shaker wide) so the groove has width; keep kick and bass mono. Light, warm master: it should bounce, not slam.',
  },
  transitions:
    'Smooth and groove-led: a one-bar conga or rim fill into choruses, a break where the kick and bass drop out and the percussion carries, then everything returning on the downbeat. Filter sweeps on the music for intros and outros. No big risers.',
  mistakes: [
    'Four-on-the-floor kick: afrobeats kicks are syncopated (beat 1, the "and" of 2, beat 3, a pickup).',
    'Robotic percussion: swing around 20 plus transform_notes groove "afrobeat" on all drums, and a shaker with real accents.',
    'No counter-rhythm: the rim and congas must play against the kick, not with it.',
    'Held, static chords: play the chords as rhythm (offbeat stabs, a picked guitar-like riff).',
    'A boring root-note bass: the bass is melodic and syncopated, moving between roots, 5ths and passing notes.',
    'A slammed, harsh master: warm and bouncy around -9 LUFS; percussion must keep its transients.',
  ],
  groove: { template: 'afrobeat', amount: 0.6, velocity: 0.6, parts: ['Kick', 'Rim', 'Clap', 'Shaker', 'Perc', 'Hat', 'Bass'] },
  targets: {
    lufs: -9,
    truePeakDb: -1,
    bars: [64, 104],
    bands: { sub: [-6, 13], low: [0, 13], lowMid: [-7, 4], highMid: [-11, 1], high: [-16, 1] },
    contrastLu: [4, 12],
    minCorrelation: 0.35,
    maxStaticBars: 8,
    minHatVelocitySpread: 6,
  },
};
