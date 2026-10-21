import type { Playbook } from './types';

export const RNB: Playbook = {
  id: 'rnb',
  name: 'R&B',
  summary:
    'Smooth, intimate contemporary R&B and neo soul at 65-100 bpm. A laid-back groove with a soft kick, a snare or snap on 2 and 4, busy but quiet 16th hats with occasional rolls, and a warm, round bass under rich extended chords (maj9, m9, m11) on electric piano. Pads and a guitar-like pluck answer the vocal between phrases. Space for the voice is the priority: the instrumental supports, never competes.',
  bpm: { min: 65, max: 100, typical: 78 },
  grid: 16,
  swing: 25,
  keys: {
    modes: ['major with extended chords', 'dorian', 'natural minor'],
    common: ['Eb', 'Ab', 'Db', 'Bbm', 'Fm', 'Cm', 'Gb'],
    notes: 'Flat keys suit the voice and the warm keys. Borrow chords freely (iv in major, ♭VII) for the soulful colour.',
  },
  harmony: {
    progressions: ['IVmaj9 – iii7 – ii9 – Imaj9 (descending)', 'ii9 – V13 – Imaj9', 'Imaj7 – vi9 – ii9 – V7sus4', 'i9 – iv9 – ♭VIImaj7 – ♭IIImaj7 (minor)'],
    rhythm: 'One chord per bar, sometimes two in the last bar of a phrase as a turnaround; 4- or 8-bar progressions, the pre-chorus moves faster.',
    voicing: 'Extended, spread voicings (7ths, 9ths, 11ths) on electric piano in octave 3-4, an upper-structure triad on a soft pad above, the bass on roots with chromatic approach notes.',
  },
  melody:
    'Vocal-led: leave the melody to the singer. A guitar-like pluck or keys answers between vocal phrases with short lines on the 9th, 11th and 13th of the chord, stepwise with leaps of a 4th, ending off the root.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'soft', 'deep'], writing: 'Soft, deep kick on 1 with syncopated pickups (step 8, 11, 14); varies between bars. Apply transform_notes groove "soul" at 50% timing and velocity to drums, bass and keys.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'soft'], writing: 'Snare or rimshot on 2 and 4, medium velocity; a small fill in the last bar of the pre-chorus.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snap', role: 'clap', sample: 'snap', tags: ['clap', 'snap'], writing: 'Finger snap layered with the snare on 2 and 4, a little early or late for width; panned slightly.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'soft'], writing: 'Quiet 16ths (on a /32 line) with dynamics, an occasional 1/32 roll into the backbeat; velocity 50-90.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'shaker', tags: ['perc', 'organic'], writing: 'Shaker on the offbeat 8ths in choruses and the second verse, low.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['deep', 'warm', 'sub'], range: [26, 52], writing: 'Warm, round bass or soft 808 on the roots in octave 1-2, long notes with an approach note (5th or a half step) into the next chord.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Keys', role: 'keys', tags: ['warm', 'soft'], range: [48, 84], writing: 'Electric piano chords (maj9, m9, m7) held most of the bar with a re-strike; soft velocity (65-80); the harmonic bed of the whole song.', chain: 'keys' },
    { name: 'Pad', role: 'pad', tags: ['soft', 'warm', 'airy'], range: [55, 84], writing: 'Upper-structure triads above the keys, slow attack, choruses and bridge only, low in the mix.', chain: 'pad' },
    { name: 'Guitar', role: 'pluck', tags: ['organic', 'soft', 'warm'], range: [52, 84], writing: 'Guitar-like pluck answering the vocal between phrases in the choruses and verse 2; short lines, panned off-centre.', chain: 'pluck' },
  ],
  patterns: [
    {
      name: 'Slow Jam Drums',
      for: ['verse', 'chorus'],
      kpn: `pattern "Slow Jam Drums" bars=2 grid=16 key=Eb
Kick    : x... ...x ..x. .... | x... .... ..x. .x..
Snare   : .... x... .... x... | .... x... .... x...
Snap    : .... x... .... x... | .... x... .... x...
Hat/32  : (6.4.5.4.)*3 6.4.6789 | (6.4.5.4.)*4
Perc    : ..4. ..4. ..4. ..4. | ..4. ..4. ..4. ..5.`,
      notes: '16th hats on a /32 line with a roll into the bar-1 backbeat; swing about 25.',
    },
    {
      name: 'Turnaround Fill',
      for: ['pre'],
      kpn: `pattern "Turnaround Fill" bars=1 grid=16 key=Eb
Kick    : x... .... x... ....
Snare   : .... x... .... x.6.
Hat/32  : (6.4.5.4.)*2 5.5.5.5. 6789XXXX`,
      notes: 'Last bar of the pre-chorus.',
    },
    {
      name: 'Neo Soul Chords',
      for: ['intro', 'verse', 'chorus', 'bridge'],
      kpn: `pattern "Neo Soul Chords" bars=4 grid=16 key=Eb
Keys {oct=3 vel=74}: Abmaj9:12 Abmaj9:4 | Gm7:12 Gm7:4 | Fm9:12 Fm9:4 | Ebmaj9:16
Pad {vel=58}: [Eb4 G4 C5]:16 | [D4 F4 Bb4]:16 | [C4 Eb4 Ab4]:16 | [Bb3 D4 G4]:16
Bass {oct=1}: Ab1:10 Ab1:2 Eb2:4 | G1:10 G1:2 D2:4 | F1:10 F1:2 C2:4 | Eb1:12 r:2 F1:2`,
      notes: 'IVmaj9 – iii7 – ii9 – Imaj9 descending; the pad plays upper-structure triads (Cm, Bb, Ab, Gm) over it.',
    },
    {
      name: 'Guitar Answer',
      for: ['chorus'],
      kpn: `pattern "Guitar Answer" bars=2 grid=16 key=Eb
Guitar {vel=82}: r:8 Bb4:2 C5:2 Eb5:2 F5:2 | G5:4 F5:2 Eb5:2 C5:8`,
      notes: 'Fills the gap after the vocal line in bar 1.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 4, energy: 0.3, parts: ['Keys', 'Pad'], notes: 'Keys and pad, maybe a filtered drum loop on bar 4.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.55, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Keys'], transitionIn: ['drum-fill'], notes: 'Sparse groove; leave the mids for the vocal.' },
    { kind: 'pre', label: 'Pre 1', bars: 4, energy: 0.65, parts: ['Kick', 'Snap', 'Hat', 'Bass', 'Keys', 'Pad'], notes: 'Pad enters, Turnaround Fill in the last bar.' },
    { kind: 'chorus', label: 'Chorus 1', bars: 8, energy: 0.85, parts: ['Kick', 'Snare', 'Snap', 'Hat', 'Perc', 'Bass', 'Keys', 'Pad', 'Guitar'], transitionIn: ['reverse-cymbal'] },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.6, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Bass', 'Keys', 'Guitar'], transitionIn: ['drum-fill'], notes: 'Busier than verse 1: shaker and guitar fills.' },
    { kind: 'pre', label: 'Pre 2', bars: 4, energy: 0.7, parts: ['Kick', 'Snap', 'Hat', 'Bass', 'Keys', 'Pad'] },
    { kind: 'chorus', label: 'Chorus 2', bars: 8, energy: 0.9, parts: ['Kick', 'Snare', 'Snap', 'Hat', 'Perc', 'Bass', 'Keys', 'Pad', 'Guitar'], transitionIn: ['reverse-cymbal'] },
    { kind: 'bridge', label: 'Bridge', bars: 8, energy: 0.45, parts: ['Hat', 'Bass', 'Keys', 'Pad'], transitionIn: ['filter-sweep'], notes: 'Kick and snare out, new chord colour (borrowed iv or ♭VII).' },
    { kind: 'chorus', label: 'Chorus 3', bars: 8, energy: 0.95, parts: ['Kick', 'Snare', 'Snap', 'Hat', 'Perc', 'Bass', 'Keys', 'Pad', 'Guitar'], transitionIn: ['drum-fill', 'reverse-cymbal'] },
    { kind: 'outro', label: 'Outro', bars: 4, energy: 0.3, parts: ['Keys', 'Pad'], transitionIn: ['filter-sweep'] },
  ],
  mix: {
    master: { tags: ['warm', 'smooth'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['punchy', 'clean'] }],
    sends: [
      { name: 'Plate', chain: 'reverbSend', tags: ['bright', 'vocal'], from: [{ part: 'Keys', amount: 0.2 }, { part: 'Snare', amount: 0.15 }, { part: 'Guitar', amount: 0.25 }, { part: 'Pad', amount: 0.2 }] },
      { name: 'Echo', chain: 'delaySend', tags: ['warm'], from: [{ part: 'Guitar', amount: 0.2 }] },
    ],
    levels:
      'Kick and bass carry the low end at about equal weight; snare and snap 2 dB under the kick; hats 10-12 dB under the snare; keys 4-6 dB under the snare and warm; pad 8-10 dB under the keys; guitar 2 dB under the keys. Leave the 1-4 kHz range open for a vocal.',
    notes: 'If there is a vocal, it sits on top with the vocal chain (Silk Vocal) and the plate send; carve 2-3 dB at 2-3 kHz out of the keys. Bass ducks lightly under the kick.',
  },
  transitions:
    'Gentle: a one-bar drum fill or snare pickup into choruses, a reverse cymbal on the chorus downbeat, the drums dropping out for the bridge. The pre-chorus lifts with the pad entering and a turnaround fill. No risers or impacts.',
  mistakes: [
    'Plain triads: R&B lives on maj9, m9, m11 and 13th chords with smooth voice leading.',
    'Robotic, on-grid drums: swing around 25 plus transform_notes groove "soul" on drums, bass and keys; quiet hats with real dynamics.',
    'A busy arrangement that fights the vocal: keep the midrange open and let the guitar answer only between vocal phrases.',
    'A hard, bright mix: warm, soft and smooth; the master is around -10 LUFS, not slammed.',
    'Bass and kick clashing: the bass holds roots, ducks lightly under the kick, and the kick stays soft and deep.',
    'Choruses that do not lift: add the pad, shaker and guitar, and open the hats for each chorus.',
  ],
  groove: { template: 'soul', amount: 0.5, velocity: 0.5, parts: ['Kick', 'Snare', 'Snap', 'Hat', 'Perc', 'Bass', 'Keys'] },
  targets: {
    lufs: -10,
    truePeakDb: -1,
    bars: [56, 96],
    bands: { sub: [-6, 14], low: [0, 13], lowMid: [-6, 5], highMid: [-12, 1], high: [-20, -1] },
    contrastLu: [4, 12],
    minCorrelation: 0.4,
    maxStaticBars: 8,
    minHatVelocitySpread: 6,
  },
};
