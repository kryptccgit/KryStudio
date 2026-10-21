import type { Playbook } from './types';

export const TECH_HOUSE: Playbook = {
  id: 'tech-house',
  name: 'Tech house',
  summary:
    'Groove-first club music at 124-128 bpm. A punchy four-on-the-floor kick, a clap on 2 and 4, open hats on the offbeats, a ride and busy, syncopated percussion (bongos, rims, shakers) make a dense, rolling groove. The hook is the bassline: a funky 16th-note riff that avoids the kick, with octave jumps and ghost notes. Harmony barely moves (single stabs or none); development comes from adding and removing elements every 8-16 bars and from filter sweeps.',
  bpm: { min: 124, max: 128, typical: 126 },
  grid: 16,
  swing: 15,
  keys: {
    modes: ['natural minor', 'phrygian', 'dorian'],
    common: ['Gm', 'Fm', 'Am', 'Dm', 'Em', 'Cm'],
    notes: 'Keys matter mostly for the bass riff and the stab; stay on the tonic.',
  },
  harmony: {
    progressions: ['i only: the bassline is the hook', 'i – ♭VII (two-note bass riff)', 'i7 stab with filter movement (no progression)'],
    rhythm: 'Harmony barely moves; changes come from arrangement and filtering every 8-16 bars.',
    voicing: 'Short minor-7th or single-note stabs in octave 3-4, filtered; often no chords at all.',
  },
  melody:
    'The rolling bass riff is the melody: 16ths around the root with octave jumps and a passing note at the end of 2 bars. A stab or vocal chop answers it every 2-4 bars in the second drop.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'club'], writing: 'Every beat, punchy and short so the bass fits between kicks.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'bright'], writing: 'Beats 2 and 4, tight and bright; doubles up into 16th rolls over the last 2 bars of each build.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: 'Shuffling 16ths that skip the offbeat; apply transform_notes groove "funk" at 25% timing, 50% velocity to hats, ride and percussion.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'Every offbeat 8th (steps 3, 7, 11, 15), choked by the closed hat; out in the breakdown.', bus: 'Drum Bus' },
    { name: 'Ride', role: 'ride', sample: 'ride', tags: ['bright', 'airy'], writing: 'An 8th-note ride, accented on the beat, in drop 2 only: the extra drive of the peak.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'perc', tags: ['perc', 'organic'], writing: 'Bongos, rims or toms in a syncopated 2-bar pattern that changes every section; panned around.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['tight', 'punchy'], range: [28, 52], writing: 'Rolling 16th riff on the off-16ths (never on the kick), octave jumps, a passing note at the end of each 2 bars; short, dry, ducked under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Stab', role: 'stab', tags: ['dark', 'short'], range: [55, 84], writing: 'A short minor-7th stab answering the bass every 1-2 bars in the second drop and breakdown.', chain: 'lead', bus: 'Music Bus' },
    { name: 'Pad', role: 'pad', tags: ['dark', 'wide'], range: [45, 80], writing: 'Dark, filtered atmosphere for the breakdown and drop 2, very low.', chain: 'pad', bus: 'Music Bus' },
  ],
  patterns: [
    {
      name: 'Tech Groove',
      for: ['groove', 'drop', 'drop 2'],
      kpn: `pattern "Tech Groove" bars=2 grid=16 key=Gm
Kick    : x... x... x... x... | x... x... x... x...
Clap    : .... x... .... x... | .... x... .... x...
Hat     : 46.5 46.5 46.5 46.5 | 46.5 46.5 46.5 46.6
OpenHat : ..x. ..x. ..x. ..x. | ..x. ..x. ..x. ..x.
Perc    : ...x ..x. .x.. ..x. | ...x ..x. .x.. x.x.`,
      notes: 'The core groove; add the Ride line (5.3. 5.3. 5.3. 5.3.) in drop 2.',
    },
    {
      name: 'Tech Fill',
      for: ['drop', 'drop 2'],
      kpn: `pattern "Tech Fill" bars=1 grid=16 key=Gm
Kick : x... x... x... x...
Clap : .... x... .... xxxx
Perc : ...x ..x. .x.. 6789`,
      notes: 'Bar 8 or 16 of a phrase.',
    },
    {
      name: 'Rolling Bass',
      for: ['groove', 'build', 'drop', 'drop 2'],
      kpn: `pattern "Rolling Bass" bars=2 grid=16 key=Gm
Bass {oct=2 vel=100}: r:1 G1 G1 r r G2 G1 r r G1 Bb1 r r G1 F1:2 | r:1 G1 G1 r r G2 G1 r r D2 C2 r r Bb1 G1:2`,
      notes: 'Every note avoids the kick; the octave jump and the end-of-bar walk are the hook.',
    },
    {
      name: 'Stab Hits',
      for: ['drop 2', 'breakdown'],
      kpn: `pattern "Stab Hits" bars=2 grid=16 key=Gm
Stab {oct=4 vel=96}: r:2 Gm7:1 r:5 r:3 Gm7:1 r:4 | r:2 Gm7:1 r:3 Gm7:1 r:1 Gm7:1 r:7`,
      notes: 'Short stabs in the bass gaps; send to the reverb for a tail.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 16, energy: 0.4, parts: ['Kick', 'Hat', 'Perc'], notes: 'DJ-friendly drums; the clap enters at bar 9.' },
    { kind: 'verse', label: 'Groove', bars: 16, energy: 0.6, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Perc', 'Bass'], notes: 'The bass riff enters, filtered, opening over 16 bars.' },
    { kind: 'build', label: 'Build', bars: 8, energy: 0.65, parts: ['Clap', 'Hat', 'Perc', 'Bass'], transitionIn: ['filter-sweep'], notes: 'Kick out, high-pass on the Music Bus, clap roll.' },
    { kind: 'drop', label: 'Drop 1', bars: 32, energy: 0.9, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Stab'], transitionIn: ['riser', 'crash'], notes: 'Tech Fill every 8 bars; a new percussion pattern at bar 17.' },
    { kind: 'breakdown', label: 'Breakdown', bars: 16, energy: 0.4, parts: ['Perc', 'Stab', 'Pad'], transitionIn: ['downlifter'], notes: 'Kick and bass out, stabs and pad with long reverb.' },
    { kind: 'build', label: 'Build 2', bars: 8, energy: 0.7, parts: ['Clap', 'Hat', 'Perc', 'Bass', 'Pad'], transitionIn: ['filter-sweep'] },
    { kind: 'drop', label: 'Drop 2', bars: 32, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Ride', 'Perc', 'Bass', 'Stab', 'Pad'], transitionIn: ['riser', 'crash'], notes: 'Ride and pad join; the fullest groove.' },
    { kind: 'outro', label: 'Outro', bars: 16, energy: 0.4, parts: ['Kick', 'Hat', 'Perc', 'Bass'], transitionIn: ['downlifter'], notes: 'Strip back; the bass leaves at bar 9.' },
  ],
  mix: {
    master: { tags: ['loud', 'club'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['club', 'tight'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['short'], from: [{ part: 'Clap', amount: 0.15 }, { part: 'Stab', amount: 0.3 }, { part: 'Perc', amount: 0.15 }, { part: 'Pad', amount: 0.25 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Stab', amount: 0.2 }, { part: 'Perc', amount: 0.1 }] },
    ],
    levels:
      'Kick and bass dominate and alternate (the bass never sits on the kick); clap 2-3 dB under the kick; percussion 6-8 dB under the clap and spread in stereo; hats and ride lower; stab 4-6 dB under the clap; pad barely audible.',
    notes: 'Tight low end: short kick, dry mono bass ducked under it. Bass, Stab and Pad go to the Music Bus for the build sweeps.',
  },
  transitions:
    'DJ phrasing: changes on 8- and 16-bar boundaries. Builds drop the kick and sweep a high-pass up the Music Bus with a clap roll and riser; drops land with a crash. A Stutter Gate on the last beat of a build (automate Active) is a tech-house staple.',
  mistakes: [
    'The bass on the kick: the riff must live on the off-16ths, or the kick and bass smear.',
    'Too much harmony: tech house is groove music; one stab or none.',
    'Lifeless percussion: swing 10-20 and transform_notes groove "funk" (20-30%) on hats, ride and percussion; vary the percussion every section.',
    'A long, unchanging loop: add or remove an element every 8 bars and use fills at phrase ends.',
    'No DJ intro and outro: 16 bars of drums at each end.',
    'Wide or reverberant bass: mono and dry below 150 Hz.',
  ],
  groove: { template: 'funk', amount: 0.25, velocity: 0.5, parts: ['Hat', 'OpenHat', 'Ride', 'Perc'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [112, 224],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-8, 4], highMid: [-11, 1], high: [-16, 3] },
    contrastLu: [4, 12],
    minCorrelation: 0.35,
    maxStaticBars: 16,
    minHatVelocitySpread: 5,
  },
};
