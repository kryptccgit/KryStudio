// Dubstep: half-time drums at 140, a growling mid-bass in call and response over a clean sub, cinematic breakdowns.
import type { Playbook } from './types';

export const DUBSTEP: Playbook = {
  id: 'dubstep',
  name: 'Dubstep',
  summary:
    'Heavy bass music at 140-150 bpm in half-time (snare on beat 3, so it feels like 70-75). The drop is a hard kick and a huge snare with a growling, distorted mid-bass playing short call-and-response phrases with silence between hits, over a clean sine sub on the root. Intros and breakdowns are cinematic: pads, piano and a simple lead. Builds use a riser, a rising high-pass and a beat of silence before the drop. Loud, aggressive and full of contrast.',
  bpm: { min: 140, max: 150, typical: 140 },
  grid: 16,
  halfTime: true,
  swing: 0,
  keys: {
    modes: ['natural minor', 'phrygian', 'harmonic minor'],
    common: ['Fm', 'F#m', 'Em', 'Gm', 'Dm', 'Am'],
    notes: 'F to G minor puts the sub at 43-49 Hz where club systems hit hardest.',
  },
  harmony: {
    progressions: ['i – ♭VI – ♭III – ♭VII (intro / breakdown)', 'i – ♭II (phrygian menace)', 'i only in the drop: the bass sound is the harmony', 'i – iv – ♭VI – V (melodic dubstep)'],
    rhythm: 'Breakdowns: one chord per bar on pads and piano. Drops: root-based bass phrases in 1-2 bar call and response; harmony is implied.',
    voicing: 'Pads and piano triads in octave 3-4 for intros and breaks; in the drop, the clean sub on the root an octave under the mid-bass.',
  },
  melody:
    'Intro and breakdown: a simple cinematic lead or piano motif over 4 bars, long notes. Drop: the melody is the rhythm of the bass: short growl hits in call (bars 1, 3) and response (bars 2, 4) with silence between, each hit a slightly different timbre (automate its filter or alternate patches).',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'hard', 'punchy'], writing: 'Half-time: beat 1 and a pickup or two in the second bar; tight and loud. Very light transform_notes groove "hiphop" at 15% on the hats only; kick and snare stay on the grid.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'big', 'hard'], writing: 'Huge snare on beat 3 of every bar (accent); rolls in fills.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: 'Straight 8ths with accents, a 16th run at the end of 2 bars.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'One open hat at the end of bar 1 of each 2-bar phrase.', bus: 'Drum Bus' },
    { name: 'Sub', role: 'sub', tags: ['sub', 'deep', 'clean'], range: [24, 45], writing: 'Clean sine sub under the growl phrases on the same roots in octave 1, mono, ducked under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Growl', role: 'bass', tags: ['gritty', 'distorted', 'aggressive'], range: [36, 63], writing: 'Short distorted mid-bass hits in octave 2-3, call and response with silence between; automate its filter per hit; high-passed above the sub.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Pad', role: 'pad', tags: ['dark', 'wide'], range: [45, 77], writing: 'Dark, wide chords for the intro, builds and breakdown.', chain: 'pad', bus: 'Music Bus' },
    { name: 'Lead', role: 'lead', tags: ['bright', 'big'], range: [60, 91], writing: 'The cinematic motif in the intro, builds and breakdown; returns as a high layer in drop 2.', chain: 'lead', bus: 'Music Bus' },
    { name: 'Piano', role: 'piano', tags: ['soft', 'emotional'], range: [48, 84], writing: 'Sustained triads under the lead in the intro, breakdown and outro.', chain: 'keys', bus: 'Music Bus' },
  ],
  patterns: [
    {
      name: 'Half-Time Drop',
      for: ['drop'],
      kpn: `pattern "Half-Time Drop" bars=2 grid=16 key=Fm
Kick    : x... .... .... .... | x... ..x. .... ....
Snare   : .... .... X... .... | .... .... X... ....
Hat     : 7.5. 7.5. 7.5. 7... | 7.5. 7.5. 7.5. 7567
OpenHat : .... .... .... ..5. | .... .... .... ....`,
      notes: 'Sparse half-time drums: the growl fills the gaps.',
    },
    {
      name: 'Drop Fill',
      for: ['drop', 'build'],
      kpn: `pattern "Drop Fill" bars=1 grid=16 key=Fm
Kick  : x... ..x. .... x.x.
Snare : .... .... X... 6789`,
      notes: 'Bar 8 and 16 of a drop.',
    },
    {
      name: 'Growl Call',
      for: ['drop'],
      kpn: `pattern "Growl Call" bars=4 grid=16 key=Fm
Growl {oct=2 vel=110}: F2:2 r:2 F2:1 r:1 F2:2 r:4 Ab2:2 F2:2 | r:8 C3:2 r:2 Eb2:4 | F2:2 r:2 F2:1 r:1 F2:2 r:4 Db3:2 C3:2 | r:4 F2:1 F2:1 F2:1 F2:1 r:4 E2:4
Sub {oct=1}: F1:8 r:4 Ab1:4 | r:8 C2:2 r:2 Eb1:4 | F1:8 r:4 Db2:4 | r:4 F1:4 r:4 E1:4`,
      notes: 'Call in bars 1 and 3, response in 2 and 4 (with silence first); the sub follows the roots; E natural is the harmonic-minor leading tone.',
    },
    {
      name: 'Breakdown Keys',
      for: ['intro', 'breakdown', 'build', 'outro'],
      kpn: `pattern "Breakdown Keys" bars=4 grid=16 key=Fm
Piano {oct=4 vel=80}: Fm:16 | Db:16 | Ab:16 | Eb:16
Pad {oct=3 vel=70}: Fm:16 | Db:16 | Ab:16 | Eb:16
Lead {vel=92}: C6:4 Ab5:4 G5:4 F5:4 | F5:8 Ab5:4 Bb5:4 | C6:4 Eb6:4 C6:4 Bb5:4 | G5:12 r:4`,
      notes: 'i – ♭VI – ♭III – ♭VII with a simple cinematic lead.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 16, energy: 0.35, parts: ['Pad', 'Piano'], notes: 'Cinematic: pads and piano, the lead motif hinted at bar 9.' },
    { kind: 'build', label: 'Build 1', bars: 8, energy: 0.65, parts: ['Kick', 'Snare', 'Pad', 'Lead'], transitionIn: ['filter-sweep'], notes: 'Kick on the beat, snare roll, riser, rising high-pass.' },
    { kind: 'drop', label: 'Drop 1', bars: 32, energy: 0.95, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Sub', 'Growl'], transitionIn: ['riser', 'silence', 'impact'], notes: 'Growl Call; vary the growl timbre every 4 bars; a fill at 8, 16, 24.' },
    { kind: 'breakdown', label: 'Breakdown', bars: 16, energy: 0.35, parts: ['Pad', 'Piano', 'Lead'], transitionIn: ['downlifter'], notes: 'Drums and bass out; the full cinematic motif.' },
    { kind: 'build', label: 'Build 2', bars: 8, energy: 0.7, parts: ['Kick', 'Snare', 'Pad', 'Lead'], transitionIn: ['filter-sweep'] },
    { kind: 'drop', label: 'Drop 2', bars: 32, energy: 1, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Sub', 'Growl', 'Lead'], transitionIn: ['riser', 'silence', 'sub-drop'], notes: 'New growl variations and the lead layered high.' },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.3, parts: ['Pad', 'Piano'], transitionIn: ['downlifter'] },
  ],
  mix: {
    master: { tags: ['loud', 'heavy'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['aggressive', 'dirty'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['big', 'long'], from: [{ part: 'Lead', amount: 0.3 }, { part: 'Piano', amount: 0.3 }, { part: 'Pad', amount: 0.3 }, { part: 'Snare', amount: 0.15 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Lead', amount: 0.2 }] },
    ],
    levels:
      'Kick and snare loudest in the drop (the snare huge); sub 3-4 dB under the kick, the growl as loud as the snare but ducked under the kick; hats 8-10 dB under; in breakdowns, the lead and piano lead and the pads sit behind.',
    notes: 'Split the low end: the sub is clean and mono below 100 Hz, the growl is high-passed around 100-150 Hz and wide only above 200 Hz. The drop must be 8+ LU louder than the breakdown.',
  },
  transitions:
    'Builds: a snare roll, a riser and a rising high-pass, then one beat or a half bar of silence and the drop on the downbeat with an impact or a sub drop. Breakdowns start with a downlifter and a reverb throw of the last growl. Fills (a snare roll, a stutter) every 8 bars in the drop.',
  mistakes: [
    'A full-time beat: the snare is on beat 3 (half-time); a 2-and-4 snare at 140 bpm is the wrong genre.',
    'One growl on loop: vary the bass timbre per phrase (filter automation, alternate patches) and leave silence between hits.',
    'Sub and growl fighting: a clean mono sine sub below 100 Hz, the growl high-passed above it.',
    'No contrast: the breakdown must be quiet and musical so the drop hits (8+ LU difference).',
    'No silence before the drop: a beat or half bar of nothing makes the drop land.',
    'A weak snare: the half-time snare carries the groove and must be huge.',
  ],
  groove: { template: 'hiphop', amount: 0.15, velocity: 0.3, parts: ['Hat', 'OpenHat'] },
  targets: {
    lufs: -7,
    truePeakDb: -1,
    bars: [96, 160],
    bands: { sub: [-2, 15], low: [0, 13], lowMid: [-8, 4], highMid: [-10, 2], high: [-15, 3] },
    contrastLu: [8, 18],
    minCorrelation: 0.25,
    maxStaticBars: 8,
    minHatVelocitySpread: 4,
  },
};
