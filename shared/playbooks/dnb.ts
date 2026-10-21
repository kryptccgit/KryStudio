import type { Playbook } from './types';

export const DNB: Playbook = {
  id: 'dnb',
  name: 'Drum & bass',
  summary:
    'Fast, rolling breakbeat music at 170-178 bpm. The two-step groove (kick on 1 and the "and" of 3, snare on 2 and 4) is dressed with ghost snares, shuffling hats and a ride, edited like a chopped break. Underneath, a clean sub and a moving reese or mid-bass carry the harmony every 1-2 bars. Liquid styles add lush minor 9th pads and a soulful lead; neuro and jump-up make the bass the hook. Long DJ intros and outros, 32-bar drops, an atmospheric breakdown.',
  bpm: { min: 170, max: 178, typical: 174 },
  grid: 16,
  swing: 0,
  keys: {
    modes: ['natural minor', 'dorian', 'phrygian'],
    common: ['Fm', 'Gm', 'Am', 'Em', 'Dm', 'F#m', 'Cm'],
    notes: 'Liquid leans dorian with 9th chords; neuro stays on the tonic with phrygian movement in the bass.',
  },
  harmony: {
    progressions: ['i – ♭VI – ♭VII – i (liquid)', 'i9 – iv9 (dorian, liquid)', 'i only: the bass riff moves ^1 ^3 ^4 ^7 (neuro / jump-up)', 'i – ♭III – ♭VII – iv'],
    rhythm: 'One chord per 2 bars (liquid) or static (neuro); 8- and 16-bar phrases; the reese and sub change note every 1-2 bars.',
    voicing: 'Liquid: lush m9 / maj7 pads and soft keys in octave 3-4. Neuro: no chords; a mid-range reese carries the harmony with a clean sub an octave below.',
  },
  melody:
    'Liquid: a soulful lead or vocal phrase over 4-8 bars with long notes, above 300 Hz. Neuro and jump-up: the bass riff is the hook, a 2-bar call and response. Keep melodies sparse: the drums are dense.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'tight'], writing: 'Two-step: beat 1 and the "and" of 3 (step 11), with a pickup before bar 2 sometimes; tight and short.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'bright', 'punchy'], writing: 'Loud snare on 2 and 4 (steps 5 and 13) with ghost snares (velocity 40-60) around them like a chopped break.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: '8ths with 16th ghost notes, accented on the beat; apply transform_notes groove "funk" at 30% timing, 50% velocity to hats, ride and percussion for a break feel.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Ride', role: 'ride', sample: 'ride', tags: ['bright', 'airy'], writing: '8th-note ride in the second drop and the outro.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'shaker', tags: ['perc', 'organic'], writing: 'Shaker or ghost-snare texture on off-16ths, quiet; gives the roll.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Sub', role: 'sub', tags: ['sub', 'deep', 'clean'], range: [24, 45], writing: 'Clean sine sub in octave 1 following the reese roots, long notes, mono, ducked under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Reese', role: 'bass', tags: ['gritty', 'wide', 'detuned'], range: [36, 60], writing: 'Detuned, moving mid-bass in octave 2, long notes changing every 1-2 bars, filter automation for movement; high-passed above the sub.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Pad', role: 'pad', tags: ['dark', 'evolving'], range: [45, 80], writing: 'Lush minor 9th pads for intro, breakdown and outro.', chain: 'pad', bus: 'Music Bus' },
    { name: 'Lead', role: 'lead', tags: ['dark', 'emotional'], range: [60, 88], writing: 'A soulful long-note lead for the breakdown and the second drop, octave 5.', chain: 'lead', bus: 'Music Bus' },
  ],
  patterns: [
    {
      name: 'Two-Step',
      for: ['drop', 'drop 2'],
      kpn: `pattern "Two-Step" bars=2 grid=16 key=Fm
Kick  : x... .... ..x. .... | x... .... ..x. ..x.
Snare : .... x... .... x... | .... x... .... x..o
Hat   : 6.46 6.4. 6.46 6.4. | 6.46 6.4. 6.46 6.45
Perc  : ..3. .... 3... ..3. | ..3. .... 3... ....`,
      notes: 'The core two-step with ghost-note hats and percussion.',
    },
    {
      name: 'Break Edit',
      for: ['drop 2', 'build'],
      kpn: `pattern "Break Edit" bars=2 grid=16 key=Fm
Kick  : x... .... ..x. .... | ..x. .... x... ....
Snare : .... x..o .o.. x... | .... x... .o.. x.xo
Hat   : 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. 6.4. 6.4.
Ride  : 4.3. 4.3. 4.3. 4.3. | 4.3. 4.3. 4.3. 4.3.`,
      notes: 'A chopped-break variation with ghost snares and the ride.',
    },
    {
      name: 'Reese + Sub',
      for: ['drop', 'drop 2'],
      kpn: `pattern "Reese + Sub" bars=4 grid=16 key=Fm
Reese {oct=2 vel=100}: F2:12 Ab2:4 | Eb2:8 Db2:8 | F2:12 C3:4 | Bb2:8 Ab2:4 Eb2:4
Sub {oct=1}: F1:12 Ab1:4 | Eb1:8 Db1:8 | F1:12 C2:4 | Bb1:8 Ab1:4 Eb1:4`,
      notes: 'The reese and sub move together; automate the reese filter over the 4 bars.',
    },
    {
      name: 'Liquid Pads',
      for: ['intro', 'breakdown', 'build', 'outro'],
      kpn: `pattern "Liquid Pads" bars=4 grid=16 key=Fm
Pad {oct=3 vel=70}: Fm9:16 | Dbmaj7:16 | Eb:16 | Fm9:16
Lead {vel=88}: C6:8 Ab5:4 G5:4 | F5:12 r:4 | Eb5:4 F5:4 G5:4 Ab5:4 | G5:16`,
      notes: 'i9 – ♭VImaj7 – ♭VII – i9 with a slow lead.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 32, energy: 0.4, parts: ['Kick', 'Hat', 'Perc', 'Pad'], notes: 'DJ intro: filtered drums and pads, adding one element every 8 bars.' },
    { kind: 'drop', label: 'Drop 1', bars: 32, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Sub', 'Reese'], transitionIn: ['riser', 'drum-fill', 'impact'], notes: 'Two-Step with Reese + Sub; a variation every 8 bars.' },
    { kind: 'breakdown', label: 'Breakdown', bars: 16, energy: 0.35, parts: ['Pad', 'Lead'], transitionIn: ['downlifter'], notes: 'Drums out; pads and the lead.' },
    { kind: 'build', label: 'Build', bars: 8, energy: 0.7, parts: ['Snare', 'Hat', 'Perc', 'Pad', 'Lead'], transitionIn: ['filter-sweep'], notes: 'Filtered break and a snare roll.' },
    { kind: 'drop', label: 'Drop 2', bars: 32, energy: 1, parts: ['Kick', 'Snare', 'Hat', 'Ride', 'Perc', 'Sub', 'Reese', 'Lead'], transitionIn: ['riser', 'snare-roll', 'impact'], notes: 'Break Edit alternating with Two-Step, the ride and lead on top.' },
    { kind: 'outro', label: 'Outro', bars: 32, energy: 0.4, parts: ['Kick', 'Hat', 'Ride', 'Perc', 'Pad'], transitionIn: ['downlifter'], notes: 'DJ outro: remove an element every 8 bars.' },
  ],
  mix: {
    master: { tags: ['loud', 'punchy', 'tight'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['tight', 'punchy'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['dark', 'long'], from: [{ part: 'Pad', amount: 0.3 }, { part: 'Lead', amount: 0.3 }, { part: 'Snare', amount: 0.1 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Lead', amount: 0.2 }, { part: 'Perc', amount: 0.1 }] },
    ],
    levels:
      'Snare and kick loudest, the snare cracking; sub 3-4 dB under the kick, the reese just under the snare; hats and ride 8-10 dB under the snare, ghost notes quiet; pads and lead behind in the drops, forward in the breakdown.',
    notes: 'Tight, short drums (fast tempo leaves little room for tails); mono sub below 100 Hz, the reese high-passed and wide above 200 Hz. Music goes to the Music Bus for the build sweep.',
  },
  transitions:
    'DJ phrasing: changes on 8-, 16- and 32-bar boundaries. Into the drop: a riser and a drum fill or snare roll, then an impact on the downbeat. The breakdown starts with a downlifter and the drums out. Edit the break every 8 bars (ghost snares, a dropped kick, a reversed snare).',
  mistakes: [
    'Kick and snare in the wrong places: the two-step is kick on 1 and the "and" of 3, snare on 2 and 4.',
    'Stiff, machine drums: ghost snares, 16th ghost hats and a light funk groove (transform_notes groove "funk" around 30%) make it roll.',
    'Long drum tails: at 174 bpm kicks and snares must be short and tight.',
    'Reese and sub in the same range: a clean sub below 100 Hz, the reese high-passed above it.',
    'Short sections: DnB uses 16-32 bar sections and 32-bar DJ intros and outros.',
    'A static drop: vary the break or the bass every 8 bars.',
  ],
  groove: { template: 'funk', amount: 0.3, velocity: 0.5, parts: ['Hat', 'Ride', 'Perc'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [128, 256],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-8, 4], highMid: [-10, 2], high: [-15, 3] },
    contrastLu: [5, 14],
    minCorrelation: 0.3,
    maxStaticBars: 8,
    minHatVelocitySpread: 6,
  },
};
