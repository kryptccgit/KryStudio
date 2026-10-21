import type { Playbook } from './types';

export const LOFI: Playbook = {
  id: 'lofi',
  name: 'Lo-fi',
  summary:
    'Calm, nostalgic instrumental hip-hop at 70-90 bpm. Soft, heavily swung drums sit behind the beat; jazzy 7th and 9th chords on an electric piano or soft keys loop every 4 bars; a round, simple bass plays the roots; a lazy, sparse melody floats on top. Everything is warm and slightly worn: rolled-off highs, tape wobble, vinyl crackle. Short (2-3 minutes) and gentle: contrast comes from drums dropping out, not from builds.',
  bpm: { min: 70, max: 90, typical: 80 },
  grid: 16,
  swing: 40,
  keys: {
    modes: ['major with maj7 / 9th colours', 'dorian', 'natural minor'],
    common: ['F', 'Eb', 'C', 'Dm', 'Am', 'Bb', 'Gm'],
    notes: 'Think jazz harmony at a slow tempo: ii–V–I and descending 7th-chord loops. Avoid plain triads.',
  },
  harmony: {
    progressions: ['ii9 – V9 – Imaj9 – vi9 (jazz loop)', 'Imaj7 – iii7 – vi7 – IVmaj7', 'i9 – iv9 (dorian vamp)', 'IVmaj7 – iii7 – ii7 – Imaj7 (descending)'],
    rhythm: 'One chord per bar in a 4-bar loop that repeats all song. Chords held or re-struck once, slightly late; strum them 10-25 ms (transform_notes strum).',
    voicing: 'Rootless or spread 7th / 9th voicings on keys in octave 3-4 at soft velocities (55-80); the bass plays the roots in octave 1-2. Close, smooth voice leading between chords.',
  },
  melody:
    'Optional and sparse: a lazy top line on a soft lead, flute-like or guitar-like sound, mostly long notes from the major pentatonic plus the 9th, placed behind the beat. Often the top note of the chords is the melody. Leave whole bars empty.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'soft', 'warm'], writing: 'Soft kick on 1 and around beat 3 with a lazy late hit; velocity 80-110. Apply transform_notes groove "soul" at 70% timing, 50% velocity to all drums, bass and keys after writing.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'soft', 'lofi'], writing: 'Snare or rim on 2 and 4, soft (velocity 85-100) with ghost notes (40-50) before the backbeat.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'soft', 'lofi'], writing: 'Swung 8ths with an occasional 16th, quiet (40-75) with the offbeats softer; a short gap every 4 bars.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'shaker', tags: ['perc', 'organic', 'soft'], writing: 'A shaker or tambourine tap now and then in the B sections, very low.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['warm', 'round', 'soft'], range: [28, 52], writing: 'Round, soft bass on the chord roots with a 5th or approach note before the next chord; octave 1-2, follows the kick loosely.', chain: 'bass' },
    { name: 'Keys', role: 'keys', tags: ['warm', 'vintage', 'lofi'], range: [48, 84], writing: 'The heart of the track: 7th / 9th chords held for the bar, strummed and slightly late, velocity 60-80. Runs through every section.', chain: 'character' },
    { name: 'Lead', role: 'lead', tags: ['soft', 'warm'], range: [57, 86], writing: 'Lazy melody in the B sections only: long notes, behind the beat, lots of space; quieter than the keys.', chain: 'lead' },
    { name: 'Texture', role: 'texture', sample: 'texture', tags: ['vinyl', 'lofi'], writing: 'Vinyl crackle or tape hiss bed for the whole song, about 20-25 dB under the keys; load a factory texture sample and loop it as an audio clip.' },
  ],
  patterns: [
    {
      name: 'Lazy Groove',
      for: ['verse', 'hook'],
      kpn: `pattern "Lazy Groove" bars=2 grid=16 key=F
Kick  : 8... .... ..7. .... | 8... ..6. .7.. ....
Snare : .... 7... .... 7..3 | .... 7... .... 7...
Hat   : 5.3. 5.3. 5.3. 5.34 | 5.3. 5.3. 5.3. 5.4.
Perc  : .... .... .... .... | .... .... .... ..3.`,
      notes: 'Set swing to about 40 and the soul groove; nothing is accented hard.',
    },
    {
      name: 'Lazy Fill',
      for: ['verse', 'hook'],
      kpn: `pattern "Lazy Fill" bars=1 grid=16 key=F
Kick  : 8... .... ..7. ..6.
Snare : .... 7... .... 3.6.
Hat   : 5.3. 5.3. 5... ....`,
      notes: 'Bar 8 of a phrase: the hats stop, two soft snares lead back in.',
    },
    {
      name: 'Keys Loop',
      for: ['intro', 'verse', 'hook', 'break', 'outro'],
      kpn: `pattern "Keys Loop" bars=4 grid=16 key=F
Keys {vel=70}: [Bb3 D4 F4 A4]:16 | [Bb3 D4 E4 G4]:16 | [A3 C4 E4 G4]:16 | [A3 C4 E4 F4]:16
Bass {oct=2}: G1:6 r:2 G1:4 D2:4 | C2:6 r:2 C2:4 G1:4 | F1:6 r:2 F1:4 C2:4 | D2:6 r:2 D2:4 A1:4`,
      notes: 'Gm9 – C9 – Fmaj9 – Dm9 (ii–V–I–vi) in rootless voicings; strum the keys 15 ms.',
    },
    {
      name: 'Dusty Lead',
      for: ['hook'],
      kpn: `pattern "Dusty Lead" bars=4 grid=16 key=F
Lead {vel=78}: r:4 A5:4 G5:2 F5:2 D5:4 | C5:12 r:4 | r:4 A5:2 C6:2 A5:4 G5:4 | E5:8 F5:8`,
      notes: 'Pentatonic with the 9th (G over F), lots of space; humanise timing.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 4, energy: 0.3, parts: ['Keys', 'Texture'], notes: 'Keys alone with crackle, low-passed (EQ high cut around 2-3 kHz opening up).' },
    { kind: 'verse', label: 'A', bars: 16, energy: 0.7, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Keys', 'Texture'], transitionIn: ['filter-sweep'], notes: 'Lazy Groove, Lazy Fill at bar 8 and 16.' },
    { kind: 'hook', label: 'B', bars: 8, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Bass', 'Keys', 'Lead', 'Texture'], transitionIn: ['drum-fill'], notes: 'The melody enters; shaker taps.' },
    { kind: 'break', label: 'Break', bars: 4, energy: 0.4, parts: ['Keys', 'Lead', 'Texture'], transitionIn: ['tape-stop'], notes: 'Drums and bass out, the melody echoes on the tape delay.' },
    { kind: 'verse', label: 'A2', bars: 8, energy: 0.75, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Bass', 'Keys', 'Texture'], transitionIn: ['drum-fill'] },
    { kind: 'hook', label: 'B2', bars: 8, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Bass', 'Keys', 'Lead', 'Texture'], notes: 'Melody variation (end on a different note).' },
    { kind: 'outro', label: 'Outro', bars: 4, energy: 0.3, parts: ['Keys', 'Texture'], transitionIn: ['filter-sweep'], notes: 'Keys alone, high cut closing, crackle last.' },
  ],
  mix: {
    master: { tags: ['warm', 'lofi'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['lofi', 'warm'] }],
    sends: [
      { name: 'Room', chain: 'reverbSend', tags: ['short', 'vintage'], from: [{ part: 'Keys', amount: 0.3 }, { part: 'Snare', amount: 0.15 }, { part: 'Lead', amount: 0.3 }] },
      { name: 'Echo', chain: 'delaySend', tags: ['warm', 'lofi'], from: [{ part: 'Lead', amount: 0.25 }, { part: 'Keys', amount: 0.1 }] },
    ],
    levels:
      'Keys and kick about equal and loudest; snare 2-3 dB under the kick; bass 3-4 dB under the kick, round not boomy; hats 10 dB under the snare; lead 2-3 dB under the keys; texture far down (barely noticed until it stops). Nothing should feel loud: this genre is mastered quiet.',
    notes: 'Drums on the Dusty Tape bus; Keys get the Lofi Tape character chain (wobble, rolled-off top). Keep the highs soft everywhere: high cut around 8-10 kHz on keys and lead.',
  },
  transitions:
    'Lo-fi barely uses transitions: the beat tape-stops into the break, a soft fill ends each 8-bar phrase, and the intro and outro filter the keys (automate the EQ high cut or a Low-Pass Sweep). A tape-stop on the last beat (Gate/Time pattern Tape stop) is a nice ending. No risers or impacts.',
  mistakes: [
    'Bright, crisp and loud: lo-fi needs rolled-off highs, tape saturation and a quiet master (-12 to -14 LUFS).',
    'Robotic drums on the grid: use swing around 40 and transform_notes groove "soul" (60-80%), soft velocities and ghost notes.',
    'Plain triads: use maj7, m7, m9 and 9th chords with smooth voice leading.',
    'Hard, punchy drums: soft kicks and snares, nothing accented hard, everything behind the beat.',
    'A busy melody: sparse and lazy, with empty bars; often the chords are enough.',
    'No texture: a quiet vinyl or tape bed glues it together (and its absence in the break is a nice effect).',
    'Too long or too many sections: 2-3 minutes, a 4-bar loop with drums in and out.',
  ],
  groove: { template: 'soul', amount: 0.7, velocity: 0.5, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Bass', 'Keys'] },
  targets: {
    lufs: -13,
    truePeakDb: -1,
    bars: [36, 72],
    bands: { sub: [-8, 13], low: [0, 14], lowMid: [-5, 6], highMid: [-14, 0], high: [-24, -4] },
    contrastLu: [4, 12],
    minCorrelation: 0.4,
    maxStaticBars: 8,
    minHatVelocitySpread: 6,
  },
};
