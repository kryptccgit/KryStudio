import type { Playbook } from './types';

export const POP: Playbook = {
  id: 'pop',
  name: 'Pop',
  summary:
    'Radio and dance pop at 95-128 bpm built around one big, singable hook. Verses are sparse (kick, light hats, bass, piano), the pre-chorus builds tension with a rising drum pattern, and the chorus opens up wide: claps and snare on 2 and 4, tambourine, full chords, a synth pluck doubling the hook. Clear four-chord harmony, short sections, a bridge for contrast and a doubled final chorus. Polished, bright and clean, every element with its own space.',
  bpm: { min: 95, max: 128, typical: 118 },
  grid: 16,
  swing: 0,
  keys: {
    modes: ['major', 'natural minor (relative minor)'],
    common: ['C', 'G', 'D', 'A', 'F', 'Bb', 'Am', 'Em'],
    notes: 'Pick the key for the singer. Chorus melodies often start on the 3rd or 5th; a key change up a whole step for the final chorus is a classic lift (use sparingly).',
  },
  harmony: {
    progressions: ['I – V – vi – IV', 'vi – IV – I – V', 'I – vi – IV – V', 'IV – I – V – vi (chorus lift)', 'i – VI – III – VII (minor pop)'],
    rhythm: 'One chord per bar in verses and choruses (4-bar loops); the pre-chorus may move two per bar or climb IV – V; the bridge uses a fresh progression (vi – IV – I – V or starting on IV).',
    voicing: 'Triads and add9 / sus2 voicings in octave 4 on piano and synth chords with smooth inversions; the bass on roots in octave 1-2; the chorus widens with octave doubling and wide synths.',
  },
  melody:
    'The hook is everything: a 2-bar motif of 4-7 notes in an octave range, mostly stepwise with one leap, repeated with a changed ending (A A\' or A A B A). Verse melodies sit lower and are more rhythmic; the chorus jumps up a 3rd to a 5th and holds longer notes. A synth pluck doubles or answers the vocal hook in the chorus and post-chorus.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'clean'], writing: 'Verse: beat 1 and the "and" of 2; chorus: busier, with pickups into beats 3 and 1. Velocity 100-120. Light pop groove: transform_notes groove "pop" at 35% timing, 40% velocity on the drums.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'bright'], writing: 'Clap on 2 and 4 in every section with drums.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'punchy'], writing: 'Layered with the clap on 2 and 4 in choruses; drives the pre-chorus build (quarters → 8ths → 16ths, then a beat of silence).', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: '8th notes with accented downbeats, a 16th pickup at the end of a phrase; out in the first half of verse 1.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'shaker', tags: ['perc', 'bright'], writing: 'Tambourine or shaker 16ths in choruses only: the classic chorus lift.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['tight', 'punchy'], range: [28, 55], writing: 'Roots on the chord changes in octave 1-2 with 8th-note movement (octave or 5th) following the kick; ducks lightly under it.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Piano', role: 'piano', tags: ['bright', 'clean'], range: [48, 84], writing: 'Rhythmic chord pulse (quarter + two 8ths) in smooth inversions; the backbone from intro to outro.', chain: 'keys' },
    { name: 'Chords', role: 'chord', tags: ['wide', 'bright'], range: [52, 84], writing: 'Held synth chords that widen the chorus and bridge, slow attack, behind the piano.', chain: 'pad' },
    { name: 'Pluck', role: 'pluck', tags: ['bright', 'short'], range: [60, 88], writing: 'The instrumental hook: doubles or answers the vocal hook in the chorus and plays it alone in the intro and outro.', chain: 'pluck' },
    { name: 'Pad', role: 'pad', tags: ['soft', 'airy'], range: [48, 80], writing: 'Soft sustained bed in the pre-chorus, choruses and bridge; low and wide.', chain: 'pad' },
  ],
  patterns: [
    {
      name: 'Chorus Drums',
      for: ['chorus'],
      kpn: `pattern "Chorus Drums" bars=2 grid=16 key=C
Kick  : x... ..x. x... .... | x... ..x. x... ..x.
Clap  : .... x... .... x... | .... x... .... x...
Snare : .... 6... .... 6... | .... 6... .... 6...
Hat   : 7.5. 7.5. 7.5. 7.5. | 7.5. 7.5. 7.5. 7.56
Perc  : 3535 3535 3535 3535 | 3535 3535 3535 3536`,
      notes: 'Full chorus groove with tambourine 16ths.',
    },
    {
      name: 'Verse Drums',
      for: ['verse'],
      kpn: `pattern "Verse Drums" bars=2 grid=16 key=C
Kick : x... .... x... .... | x... ..x. .... ....
Clap : .... x... .... x... | .... x... .... x...
Hat  : 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. 6.4. 6.4.`,
      notes: 'Sparse verse groove: room for the vocal.',
    },
    {
      name: 'Pre Build',
      for: ['pre'],
      kpn: `pattern "Pre Build" bars=4 grid=16 key=C
Kick  : x... .... x... .... | x... .... x... .... | x... x... x... x... | x... x... x... x...
Snare : .... x... .... x... | .... x... .... x... | x.x. x.x. x.x. x.x. | 4455 5566 7788 ....
Hat   : 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. 6.4. 6.4. | .... .... .... ....`,
      notes: 'Tension: kick goes to quarters, the snare doubles up, then a beat of silence before the chorus.',
    },
    {
      name: 'Chords + Bass',
      for: ['verse', 'chorus', 'intro'],
      kpn: `pattern "Chords + Bass" bars=4 grid=16 key=C
Piano {vel=82}: ([C4 E4 G4]:4 [C4 E4 G4]:2 [C4 E4 G4]:2)*2 | ([B3 D4 G4]:4 [B3 D4 G4]:2 [B3 D4 G4]:2)*2 | ([C4 E4 A4]:4 [C4 E4 A4]:2 [C4 E4 A4]:2)*2 | ([C4 F4 A4]:4 [C4 F4 A4]:2 [C4 F4 A4]:2)*2
Bass {oct=2}: C2:6 C2:2 C2:4 G1:4 | B1:6 B1:2 B1:4 G1:4 | A1:6 A1:2 A1:4 E2:4 | F1:6 F1:2 F1:4 G1:4`,
      notes: 'I – V/7 – vi – IV (C – G/B – Am – F) with smooth piano inversions; the bass walks into each chord.',
    },
    {
      name: 'Pluck Hook',
      for: ['chorus', 'intro', 'outro'],
      kpn: `pattern "Pluck Hook" bars=2 grid=16 key=C
Pluck {vel=92}: E5:2 G5:2 A5:2 G5:2 E5:2 D5:2 C5:4 | E5:2 G5:2 A5:2 C6:2 B5:4 G5:4
Chords {vel=72}: [E4 G4 C5]:16 | [D4 G4 B4]:16`,
      notes: 'An A A\' hook (bar 2 answers by climbing to the top note); the held chords widen it.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 4, energy: 0.35, parts: ['Piano', 'Pluck'], notes: 'The hook on the pluck over piano, filtered.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.5, parts: ['Kick', 'Clap', 'Hat', 'Bass', 'Piano'], notes: 'Verse Drums; hats and clap come in at bar 9.' },
    { kind: 'pre', label: 'Pre 1', bars: 4, energy: 0.65, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Piano', 'Pad'], transitionIn: ['drum-fill'], notes: 'Pre Build; harmony climbs IV – V.' },
    { kind: 'chorus', label: 'Chorus 1', bars: 8, energy: 0.9, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'Perc', 'Bass', 'Piano', 'Chords', 'Pluck', 'Pad'], transitionIn: ['whoosh', 'silence', 'crash'] },
    { kind: 'verse', label: 'Verse 2', bars: 8, energy: 0.55, parts: ['Kick', 'Clap', 'Hat', 'Perc', 'Bass', 'Piano'], transitionIn: ['downlifter'], notes: 'Keep a little of the chorus energy (shaker) so verse 2 moves faster.' },
    { kind: 'pre', label: 'Pre 2', bars: 4, energy: 0.7, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Piano', 'Pad'] },
    { kind: 'chorus', label: 'Chorus 2', bars: 8, energy: 0.95, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'Perc', 'Bass', 'Piano', 'Chords', 'Pluck', 'Pad'], transitionIn: ['silence', 'crash'] },
    { kind: 'bridge', label: 'Bridge', bars: 8, energy: 0.45, parts: ['Bass', 'Piano', 'Chords', 'Pad'], transitionIn: ['downlifter'], notes: 'Drums out (or kick only), a fresh progression; build back in the last 2 bars.' },
    { kind: 'chorus', label: 'Final Chorus', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'Perc', 'Bass', 'Piano', 'Chords', 'Pluck', 'Pad'], transitionIn: ['snare-roll', 'crash'], notes: 'Chorus twice; the second time the pluck goes up an octave and the drums add fills.' },
    { kind: 'outro', label: 'Outro', bars: 4, energy: 0.35, parts: ['Piano', 'Pluck', 'Pad'], transitionIn: ['filter-sweep'] },
  ],
  mix: {
    master: { tags: ['clean', 'bright', 'polished'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['punchy', 'clean'] }],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['big'], from: [{ part: 'Piano', amount: 0.15 }, { part: 'Pluck', amount: 0.25 }, { part: 'Clap', amount: 0.15 }, { part: 'Chords', amount: 0.2 }, { part: 'Pad', amount: 0.25 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Pluck', amount: 0.2 }] },
    ],
    levels:
      'Vocal space first: kick and clap/snare as the loudest instruments, bass 2-3 dB under the kick; piano 5-6 dB under the clap; pluck 3 dB under the clap in the chorus; chords and pad 8-10 dB under, wide; tambourine and hats 10-12 dB under the clap.',
    notes: 'Bright and clean: high-pass everything but kick and bass above 100-150 Hz, cut 300 Hz mud on the piano and chords, sidechain the bass lightly. If there is a vocal, it is the loudest thing in the chorus (Pop Vocal chain) and the piano dips at 2-4 kHz.',
  },
  transitions:
    'The pre-chorus build (quarters → 8ths → 16ths on the snare, the kick going to quarters) ends with one beat of silence, then the chorus hits with a crash. Choruses end into verses with a downlifter or a reverse reverb. The bridge strips back, and the final chorus enters with a snare roll and crash; double it.',
  mistakes: [
    'No clear hook: write the 2-bar chorus hook first and make every other section serve it.',
    'Choruses no bigger than verses: add claps, tambourine, wide chords and the pluck, and thin the verses so the chorus contrast is obvious (3-6 LU).',
    'Muddy midrange: piano, chords and pad pile up at 200-500 Hz; high-pass and cut so the vocal range stays clear.',
    'Overlong intros and sections: get to the first chorus within about 45 seconds.',
    'Quantised and lifeless drums: a light pop groove (transform_notes groove "pop" around 35%) and real velocity variation on hats and tambourine.',
    'Random chords: stick to one clear 4-chord loop per section; change it only for the bridge.',
    'A dull master: pop is bright and polished (air shelf, controlled lows) around -9 LUFS.',
  ],
  groove: { template: 'pop', amount: 0.35, velocity: 0.4, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'Perc'] },
  targets: {
    lufs: -9,
    truePeakDb: -1,
    bars: [64, 112],
    bands: { sub: [-6, 13], low: [0, 13], lowMid: [-7, 4], highMid: [-11, 1], high: [-16, 1] },
    contrastLu: [4, 12],
    minCorrelation: 0.35,
    maxStaticBars: 8,
    minHatVelocitySpread: 6,
  },
};
