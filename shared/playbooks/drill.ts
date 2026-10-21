// Drill: dark, sliding 808s, syncopated snares and skippy triplet hats at ~142 bpm half-time.
import type { Playbook } from './types';

export const DRILL: Playbook = {
  id: 'drill',
  name: 'Drill',
  summary:
    'Cold, menacing half-time rap at 138-146 bpm. The 808 is the lead instrument: short notes that glide an octave or a fifth up and down. Snares are syncopated (beat 3 of each bar plus an early, off-grid feeling hit in the second bar), hats skip in triplet groups with gaps, and kicks are sparse. Over it sit dark harmonic-minor strings or piano and a high bell or choir line. Tension, not density.',
  bpm: { min: 138, max: 146, typical: 142 },
  grid: 16,
  halfTime: true,
  swing: 0,
  keys: {
    modes: ['harmonic minor', 'natural minor', 'phrygian'],
    common: ['C#m', 'F#m', 'Bbm', 'Gm', 'Em', 'Ebm'],
    notes: 'Harmonic minor is the drill sound: the raised 7th as a leading tone and the major V chord. The 808 glides between the root, the octave and the 5th.',
  },
  harmony: {
    progressions: ['i – VI – iv – V (harmonic-minor V)', 'i – ♭II – i (phrygian tension)', 'i – iv – VI – V', 'i – VII – VI – V'],
    rhythm: 'One chord per bar in 4-bar loops, sometimes held for 2 bars; strings or piano voice it, often with a moving top note.',
    voicing: 'Close-voiced strings in octave 3-4 with smooth voice leading (common tones held), piano melody in octave 4-5, a bell or choir an octave above in the hooks. No chords below octave 3.',
  },
  melody:
    'Cinematic and dark: a slow 2-bar string or piano motif in harmonic minor that resolves through the leading tone; quarter and 8th notes, rarely 16ths. A sparse high bell line answers it in the later hooks. The sliding 808 is the second melody, so keep the top line simple.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'hard'], writing: 'Sparse: beat 1 and one or two syncopated hits per 2 bars that start 808 notes. Leave gaps for the 808 slides.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'hard'], writing: 'Beat 3 of every bar (step 9) plus one early syncopated snare in the second bar (step 4) for the drill bounce; ghost hits before the backbeat. Velocity 100-127, ghosts 50-60.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'short', 'bright'], writing: 'Write on a /24 (16th-triplet) line: groups of two or three hits with gaps, a fast triplet run once per 2 bars. Accent the first hit of each group; velocity 60-110. Groove the hats and perc only: transform_notes groove "hiphop" at 20% timing, 40% velocity; kick and snare stay on the grid.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'One open hat at the end of a 2- or 4-bar phrase, choked by the closed hat; quiet.', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'perc', tags: ['perc', 'dark'], writing: 'A rim, snap or metallic hit once per 2 bars on an off-step to break the grid; low in the mix.', chain: 'drums', bus: 'Drum Bus' },
    { name: '808', role: '808', tags: ['glide', 'distorted', 'punchy'], range: [24, 47], writing: 'Mono, glide 80-150 ms. Short-to-medium notes on the kicks with ~ slides up an octave or to the 5th and back down within the bar; the slide is the hook. Octave 1-2.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Strings', role: 'strings', tags: ['dark', 'emotional'], range: [48, 84], writing: 'Close-voiced minor chords, one per bar, slow attack, held. Carries the harmony in intros, hooks and the outro.', chain: 'pad' },
    { name: 'Piano', role: 'piano', tags: ['dark', 'soft'], range: [55, 88], writing: 'The melodic motif in octave 4-5: 8th and quarter notes resolving through the raised 7th, soft velocity (70-90), lots of reverb.', chain: 'keys' },
    { name: 'Bell', role: 'bell', tags: ['dark', 'metallic'], range: [72, 98], writing: 'A sparse high counter-line (one or two notes per bar) in octave 6 for the second and third hooks.', chain: 'lead' },
  ],
  patterns: [
    {
      name: 'Drill Drums',
      for: ['hook'],
      kpn: `pattern "Drill Drums" bars=2 grid=16 key=C#m
Kick    : x... .... .... ..x. | x... .... ..x. ....
Snare   : .... .... x... .... | ...x .... x... ...o
Hat/24  : 7..5.. 7..5.6 7..... 7..567 | 7..5.. 7..... 7..5.. 7.5.7.
OpenHat : .... .... .... .... | .... .... .... ..5.`,
      notes: 'Snare on beat 3 plus the early snare on step 4 of bar 2; triplet-grid hats in skipping groups.',
    },
    {
      name: 'Drill Drums B',
      for: ['verse'],
      kpn: `pattern "Drill Drums B" bars=2 grid=16 key=C#m
Kick    : x... .... .... .... | x... ..x. .... ....
Snare   : .... .... x... .... | .... .... x... ..x.
Hat/24  : 7..... 7..5.. 7..... 7..5.. | 7..5.. 7..5.. 7..... 765432
Perc    : .... ..x. .... .... | .... .... .... ....`,
      notes: 'Verse variation: fewer kicks, a late snare at the end of bar 2, a falling triplet hat run.',
    },
    {
      name: '808 Glides',
      for: ['hook', 'verse'],
      kpn: `pattern "808 Glides" bars=4 grid=16 key=C#m
808 {oct=1}: C#1:14~ C#2:2 | C#2:6~ B1:4 C#1:6 | A1:10 A1:4~ E1:2 | G#1:6~ B1:4 G#1:6`,
      notes: 'i – i – VI – V: octave slide up into bar 2, glide down, then the leading-tone G# for the V. Mono + glide on the channel.',
    },
    {
      name: 'Dark Keys',
      for: ['intro', 'hook', 'outro'],
      kpn: `pattern "Dark Keys" bars=4 grid=16 key=C#m
Strings {vel=80}: [C#4 E4 G#4]:16 | [C#4 E4 A4]:16 | [C#4 F#4 A4]:16 | [C4 D#4 G#4]:16
Piano {vel=82}: G#5:4 E5:2 C#5:2 D#5:4 E5:4 | C#5:6 B4:2 C#5:8 | A5:4 G#5:2 F#5:2 E5:4 F#5:4 | G#5:6 F#5:2 E5:4 C5:4`,
      notes: 'C#m – A/C# – F#m/C# – G#/C: the strings keep C# on top while the bass of the harmony moves; the piano resolves through the leading tone (C) at the end.',
    },
    {
      name: 'Bell Line',
      for: ['hook'],
      kpn: `pattern "Bell Line" bars=4 grid=16 key=C#m
Bell {vel=84}: r:8 G#6:8 | r:16 | r:8 E6:4 F#6:4 | G#6:16`,
      notes: 'Sparse high counter-line for Hook 2 and 3.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.3, parts: ['Strings', 'Piano'], notes: 'Strings and piano alone; a single 808 slide on the last bar teases the drop.' },
    { kind: 'hook', label: 'Hook 1', bars: 16, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', '808', 'Strings', 'Piano'], transitionIn: ['silence', 'reverse-cymbal'], notes: 'Drill Drums and 808 Glides; variation at bar 8 (drop the kick for a bar).' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.65, parts: ['Kick', 'Snare', 'Hat', 'Perc', '808', 'Piano'], transitionIn: ['drum-fill'], notes: 'Drill Drums B; strings out, piano thinner. Change the hat groups every 4 bars.' },
    { kind: 'hook', label: 'Hook 2', bars: 16, energy: 0.95, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', '808', 'Strings', 'Piano', 'Bell'], transitionIn: ['silence'], notes: 'Bell line joins; more 808 slides in the second half.' },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.65, parts: ['Kick', 'Snare', 'Hat', 'Perc', '808', 'Strings'], transitionIn: ['drum-fill'], notes: 'Strings instead of piano for contrast with Verse 1; mute the 808 for one bar at bar 8.' },
    { kind: 'hook', label: 'Hook 3', bars: 16, energy: 1, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Perc', '808', 'Strings', 'Piano', 'Bell'], transitionIn: ['silence', 'reverse-cymbal'], notes: 'Everything; the busiest hats and the most slides.' },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.3, parts: ['Strings', 'Piano', 'Hat'], transitionIn: ['filter-sweep'], notes: 'Drums fall away to hats, then strings and piano alone, low-passing out.' },
  ],
  mix: {
    master: { tags: ['loud', 'hard'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['dirty', 'aggressive'] }],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['dark', 'long'], from: [{ part: 'Piano', amount: 0.35 }, { part: 'Strings', amount: 0.3 }, { part: 'Bell', amount: 0.3 }, { part: 'Snare', amount: 0.1 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Piano', amount: 0.15 }, { part: 'Bell', amount: 0.2 }] },
    ],
    levels:
      'The 808 is the loudest element with the kick just above it on the hits; snare 1-2 dB under the kick; hats 8-10 dB under the snare and bright; strings and piano 6-8 dB under the snare, wide and wet; bell quieter than the piano. Keep 6 dB of headroom before the master.',
    notes: 'Drums to the Drum Bus (gritty), 808 on its own insert with saturation and a duck from the Kick. High-pass strings and piano at 150-200 Hz; the reverb is long and dark, kept off the low end.',
  },
  transitions:
    'Before a hook, cut to silence (or strings alone) for the last half bar and restart the drums and 808 on the downbeat; a reverse cymbal also works. Between hook and verse, a one-bar variation: no kick, a triplet hat run, or the 808 holding one long slide. End each 8-bar phrase with a missing kick or an extra snare. The outro low-passes the music bus.',
  mistakes: [
    'Clap or snare on 2 and 4: drill is half-time, the snare is on beat 3 with an extra syncopated hit, never a straight backbeat.',
    'Straight 16th hats: drill hats skip in triplet groups with gaps (write them on a /24 line) and change every 2-4 bars.',
    '808 without glide: set the channel mono with 80-150 ms glide and use ~ slides; a drill 808 that never slides sounds like trap.',
    'Kick under every 808 note plus a busy kick pattern: drill kicks are sparse; let the 808 slides speak in the gaps.',
    'Bright major chords: use harmonic minor and dark strings or piano; the leading tone and the major V give the menace.',
    'Too much melody over the 808: one slow motif, the 808 is the second melody.',
    'Static loop: vary the hat groups and the second snare every 4-8 bars, drop the kick or the 808 for a bar before phrases.',
    'Muddy low end: strings and piano high-passed, the reverb return low-cut, only the 808 and kick below 150 Hz.',
  ],
  groove: { template: 'hiphop', amount: 0.2, velocity: 0.4, parts: ['Hat', 'OpenHat', 'Perc'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [64, 112],
    bands: { sub: [0, 16], low: [0, 14], lowMid: [-8, 4], highMid: [-12, 2], high: [-18, 1] },
    contrastLu: [6, 16],
    minCorrelation: 0.3,
    maxStaticBars: 8,
    minHatVelocitySpread: 8,
  },
};
