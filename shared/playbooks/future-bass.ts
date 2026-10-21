// Future bass: half-time drums, lush stabbed supersaw chords with 7ths and 9ths, bright melodic leads.
import type { Playbook } from './types';

export const FUTURE_BASS: Playbook = {
  id: 'future-bass',
  name: 'Future bass',
  summary:
    'Bright, emotional bass music at 130-160 bpm in a half-time feel (snare on beat 3). The drop is lush, detuned supersaw chords with 7ths and 9ths played as syncopated stabs that pump hard with the kick and swell into each other, a clean sub on the roots, a high pluck or vocal-chop-like lead with octave jumps, and triplet hi-hats. Verses and breakdowns are airy (pads, plucks, soft half-time drums); builds use triplet snare rolls into a beat of silence.',
  bpm: { min: 130, max: 160, typical: 150 },
  grid: 16,
  halfTime: true,
  swing: 10,
  keys: {
    modes: ['major (euphoric)', 'lydian', 'natural minor'],
    common: ['F', 'C', 'G', 'D', 'Bb', 'Eb', 'Am'],
    notes: 'Major keys with 7th and 9th chords; the IV – V – iii – vi loop gives the bittersweet lift.',
  },
  harmony: {
    progressions: ['IVmaj7 – V – iii7 – vi7', 'Imaj9 – vi9 – IVmaj9 – V', 'vi7 – IVmaj7 – I – V', 'IV – V – vi with a borrowed ♭VII before the drop'],
    rhythm: 'One chord per bar; in the drop the chords are stabbed in a syncopated 3-3-4-3-3 rhythm and pitch-swelled into each other, with heavy sidechain pumping.',
    voicing: 'Wide, detuned voicings with 7ths and 9ths spread over octaves 3-5, the root doubled in the sub; pads and plucks use the same voicings softer.',
  },
  melody:
    'High, bright and syncopated: a vocal-chop-like or pluck lead in octave 5-6, pentatonic with octave jumps and slides, 2-bar call and response with the chord stabs; the breakdown plays the same line slowly on a pluck.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy'], writing: 'Half-time: beat 1 plus syncopated pickups; never on the snare.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'big', 'bright'], writing: 'Beat 3 of every bar; drives the triplet build rolls.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'bright'], writing: 'Layered with the snare on beat 3 in the drops.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: 'Triplet-grid hats (/24) with bursts at bar ends; a light transform_notes groove "pop" at 20% on the hats only.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Sub', role: 'sub', tags: ['sub', 'deep', 'clean'], range: [24, 45], writing: 'Sine sub holding each chord root for the bar in octave 1, ducked hard under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Chords', role: 'chord', tags: ['wide', 'big', 'euphoric', 'detuned'], range: [52, 84], writing: 'Supersaw 7th / 9th chords stabbed in a 3-3-4-3-3 rhythm, pumping (the chain pumps on its own), swelling in builds.', chain: 'pad', bus: 'Music Bus' },
    { name: 'Lead', role: 'lead', tags: ['bright', 'wide'], range: [60, 91], writing: 'The drop melody in octave 5-6, syncopated with octave jumps; answers the chord stabs.', chain: 'lead', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Pluck', role: 'pluck', tags: ['bright', 'short'], range: [60, 88], writing: '8th-note chord-tone pluck for the intro, verses and breakdown; layers the second drop.', chain: 'pluck', bus: 'Music Bus' },
    { name: 'Pad', role: 'pad', tags: ['soft', 'dreamy', 'airy'], range: [45, 80], writing: 'Airy pads holding the progression in intro, verses and breakdown.', chain: 'pad', bus: 'Music Bus' },
  ],
  patterns: [
    {
      name: 'Half-Time Drop',
      for: ['drop', 'verse'],
      kpn: `pattern "Half-Time Drop" bars=2 grid=16 key=F
Kick   : x... .... ..x. .... | x... ...x .x.. ....
Snare  : .... .... x... .... | .... .... x... ....
Clap   : .... .... x... .... | .... .... x... ....
Hat/24 : 6..4.. 6..4.. 6..4.. 6.4567 | 6..4.. 6..4.. 6..4.. 6..4..`,
      notes: 'Half-time with triplet hats; leave out the clap in the verses.',
    },
    {
      name: 'Triplet Build',
      for: ['build'],
      kpn: `pattern "Triplet Build" bars=4 grid=16 key=F
Kick     : x... .... x... .... | x... .... x... .... | x... x... x... x... | x.x. x.x. x.x. ....
Snare/24 : (4.....)*4 | (4..)*8 | (5.)*12 | 667788 99XXXX XXXXXX ......`,
      notes: 'Quarter → 8th-triplet → 16th-triplet roll, then a beat of silence before the drop.',
    },
    {
      name: 'Chord Stabs',
      for: ['drop'],
      kpn: `pattern "Chord Stabs" bars=4 grid=16 key=F
Chords {vel=100}: [Bb3 D4 F4 A4]:3 [Bb3 D4 F4 A4] [Bb3 D4 F4 A4]:4 [Bb3 D4 F4 A4]:3 [Bb3 D4 F4 A4] | [C4 E4 G4 C5]:3 [C4 E4 G4 C5] [C4 E4 G4 C5]:4 [C4 E4 G4 C5]:3 [C4 E4 G4 C5] | [A3 C4 E4 G4]:3 [A3 C4 E4 G4] [A3 C4 E4 G4]:4 [A3 C4 E4 G4]:3 [A3 C4 E4 G4] | [A3 D4 F4 C5]:3 [A3 D4 F4 C5] [A3 D4 F4 C5]:4 [A3 D4 F4 C5]:3 [A3 D4 F4 C5]
Sub {oct=1}: Bb1:16 | C2:16 | A1:16 | D2:16`,
      notes: 'IVmaj7 – V – iii7 – vi7 in F, stabbed 3-3-4-3-3 with smooth voice leading; the sub holds the roots.',
    },
    {
      name: 'Lead Hook',
      for: ['drop'],
      kpn: `pattern "Lead Hook" bars=2 grid=16 key=F
Lead {vel=100}: F5:2 G5:2 A5:2 C6:3 A5:3 G5:2 F5:2 | D6:3 C6:3 A5:2 G5:4 F5:4`,
      notes: 'Pentatonic hook on the same 3-3 accents as the chords.',
    },
    {
      name: 'Intro Pluck',
      for: ['intro', 'verse', 'breakdown', 'outro'],
      kpn: `pattern "Intro Pluck" bars=2 grid=16 key=F
Pluck {vel=84}: (A5:2 F5 C5 F5)*2 | (G5 E5 C5 E5)*2
Pad {vel=62}: [F3 A3 C4 E4]:16 | [E3 G3 C4 E4]:16`,
      notes: 'Soft chord-tone pluck over pads.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.35, parts: ['Pad', 'Pluck'], notes: 'Pads and pluck, filtered.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.5, parts: ['Kick', 'Snare', 'Hat', 'Sub', 'Pad', 'Pluck'], transitionIn: ['filter-sweep'], notes: 'Soft half-time drums without the clap.' },
    { kind: 'build', label: 'Build 1', bars: 8, energy: 0.7, parts: ['Kick', 'Snare', 'Pad', 'Pluck', 'Chords'], notes: 'Triplet Build, chords swelling under a rising high-pass.' },
    { kind: 'drop', label: 'Drop 1', bars: 16, energy: 0.95, parts: ['Kick', 'Snare', 'Clap', 'Hat', 'Sub', 'Chords', 'Lead'], transitionIn: ['riser', 'snare-roll', 'silence'], notes: 'Chord stabs and the lead; variation at bar 8.' },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.55, parts: ['Kick', 'Snare', 'Hat', 'Sub', 'Pad', 'Pluck'], transitionIn: ['downlifter'] },
    { kind: 'breakdown', label: 'Breakdown', bars: 8, energy: 0.4, parts: ['Pad', 'Pluck', 'Lead'], notes: 'The hook slowly on the lead, drenched in reverb.' },
    { kind: 'build', label: 'Build 2', bars: 8, energy: 0.75, parts: ['Kick', 'Snare', 'Pad', 'Chords', 'Lead'] },
    { kind: 'drop', label: 'Drop 2', bars: 16, energy: 1, parts: ['Kick', 'Snare', 'Clap', 'Hat', 'Sub', 'Chords', 'Lead', 'Pluck'], transitionIn: ['riser', 'snare-roll', 'silence', 'impact'], notes: 'Pluck layered with the lead; the fullest section.' },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.35, parts: ['Pad', 'Pluck', 'Chords'], transitionIn: ['downlifter'], notes: 'Chords held and fading, pluck alone at the end.' },
  ],
  mix: {
    master: { tags: ['loud', 'big'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['punchy'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['big', 'euphoric'], from: [{ part: 'Lead', amount: 0.25 }, { part: 'Pluck', amount: 0.3 }, { part: 'Pad', amount: 0.3 }, { part: 'Chords', amount: 0.15 }, { part: 'Snare', amount: 0.15 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Lead', amount: 0.2 }, { part: 'Pluck', amount: 0.2 }] },
    ],
    levels:
      'Kick and snare on top, the snare big; the sub 3-5 dB under the kick; chords loud and wide but pumping hard so the kick punches through; lead 2-3 dB under the snare, above the chords; hats 8-10 dB under the snare; pads and plucks low in the drop.',
    notes: 'All music goes to the Music Bus (High-Pass Sweep for builds). The chord pump is the genre: the pumping chain or a deep sidechain on the chords and sub.',
  },
  transitions:
    'Builds: a triplet snare roll, a rising high-pass, chords swelling (automate volume or filter up), a riser, then a beat of silence and the drop with an impact. Into verses and the breakdown: a downlifter and a reverb throw. A stutter gate on the last beat before a drop works well.',
  mistakes: [
    'Plain triads: future bass needs 7ths and 9ths in wide, detuned voicings.',
    'Chords that do not pump: the sidechain pump on the chords is the defining sound.',
    'Snare on 2 and 4: it is half-time, snare on beat 3.',
    'A muddy drop: chords high-passed around 200 Hz, the sub alone in octave 1, mono lows.',
    'A lead that clashes with the chord stabs: put the lead accents on the same 3-3 rhythm or in the gaps.',
    'Straight, stiff hats: use triplet hats with bursts and velocity changes (a light pop groove on the hats only).',
  ],
  groove: { template: 'pop', amount: 0.2, velocity: 0.3, parts: ['Hat'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [80, 144],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-8, 3], highMid: [-10, 2], high: [-15, 3] },
    contrastLu: [6, 14],
    minCorrelation: 0.25,
    maxStaticBars: 8,
    minHatVelocitySpread: 5,
  },
};
