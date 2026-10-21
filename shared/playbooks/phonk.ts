// Phonk (drift phonk): distorted 808s, a pitched cowbell riff, half-time drums at ~145 bpm.
import type { Playbook } from './types';

export const PHONK: Playbook = {
  id: 'phonk',
  name: 'Phonk',
  summary:
    'Aggressive, saturated drift phonk at 125-160 bpm with a half-time feel: a hard kick, a loud clap on beat 3, steady hats with rolls, and a distorted 808 that pumps with the kick. The hook is a short pitched cowbell riff (a tuned metallic hit playing a 3-4 note phrygian motif in 16ths), with a dark pad or a distorted lead answering it. Everything is driven into saturation; it is loud, gritty and short (around 2 minutes). Classic Memphis-style phonk is slower (80-100 bpm, snare on 2 and 4) with chopped samples; this playbook is the drift style.',
  bpm: { min: 125, max: 160, typical: 145 },
  grid: 16,
  halfTime: true,
  swing: 10,
  keys: {
    modes: ['phrygian', 'natural minor'],
    common: ['Am', 'C#m', 'Fm', 'Gm', 'Em', 'F#m'],
    notes: 'Phrygian (flat 2nd) is the signature: the riff leans on ^1 ^b2 ^3 ^5. Write the riff with key="A phrygian" in the KPN header.',
  },
  harmony: {
    progressions: ['i – ♭II (phrygian, the cowbell outlines it)', 'i – ♭VI – ♭VII', 'i only: a one-chord riff, the cowbell carries the harmony'],
    rhythm: 'Riff-based: a 1-2 bar cowbell riff repeats, the 808 follows its root, harmony changes at most every 2 bars.',
    voicing: 'Rarely chords: a dark pad holding the root triad in octave 3-4 in intros and breaks; the riff and 808 imply the rest.',
  },
  melody:
    'The cowbell riff is the hook: 3-4 pitches (^1 ^b2 ^3 ^5 of phrygian), 16th-note syncopation with short notes, repeated every bar with a different ending in the second bar. In the second drop a distorted lead answers it with longer notes an octave lower.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'hard', 'distorted'], writing: 'Hard kick on beat 1 and 2-3 syncopated hits per bar that the 808 doubles; never on the clap. Velocity 120-127.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'hard'], writing: 'Loud clap on beat 3 of every bar (step 9), accent (X); a ghost before it in fills.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: 'Straight 8ths or 16ths with accents on the beat, 1/32 rolls at the end of bars in the second drop. Groove the hats only: transform_notes groove "hiphop" at 30% timing, 40% velocity.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'An open hat on the last offbeat of the bar (step 15) every 2 bars.', bus: 'Drum Bus' },
    { name: '808', role: '808', tags: ['distorted', 'punchy', 'glide'], range: [24, 45], writing: 'Heavily saturated 808 doubling the kick rhythm on the riff root, with a slide up a 3rd or down to ^b7 at bar ends; mono, short glide.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Cowbell', role: 'perc', sample: 'perc', tags: ['cowbell', 'metallic', 'distorted'], range: [64, 90], writing: 'A tuned metallic one-shot (cowbell) played pitched across the riff notes in octave 5-6, short notes, velocity 100-120; load a cowbell-like perc sample in a sampler or a bell preset tagged cowbell.', chain: 'lead' },
    { name: 'Lead', role: 'lead', tags: ['distorted', 'dark'], range: [57, 84], writing: 'Second drop only: a distorted lead answering the riff with longer notes in octave 4-5.', chain: 'lead' },
    { name: 'Pad', role: 'pad', tags: ['dark'], range: [45, 77], writing: 'Dark held root chord for the intro, build and break; filtered.', chain: 'pad' },
  ],
  patterns: [
    {
      name: 'Phonk Drums',
      for: ['drop'],
      kpn: `pattern "Phonk Drums" bars=2 grid=16 key=Am
Kick    : x... ..x. ..x. .... | x... ..x. .... ..x.
Clap    : .... .... X... .... | .... .... X... ....
Hat     : 7.5. 7.5. 7.5. 7... | 7.5. 7.5. 7.5. 7567
OpenHat : .... .... .... ..5. | .... .... .... ....`,
      notes: 'Half-time: the clap on beat 3, the kick pattern doubled by the 808.',
    },
    {
      name: 'Phonk Drums B',
      for: ['drop 2'],
      kpn: `pattern "Phonk Drums B" bars=2 grid=16 key=Am
Kick    : x..x ..x. ..x. .x.. | x... ..x. ..x. x.x.
Clap    : .... .... X... .... | .... .... X... ..o.
Hat/32  : (7.5.)*6 7.5.6789 | (7.5.)*4 (7654)*2 7.5.7.5.`,
      notes: 'Busier kick and 1/32 hat rolls for the second drop.',
    },
    {
      name: 'Cowbell Riff',
      for: ['drop', 'drop 2', 'intro', 'build'],
      kpn: `pattern "Cowbell Riff" bars=2 grid=16 key="A phrygian"
Cowbell {vel=110}: A5:2 r:1 A5:1 C6:2 r:2 Bb5:2 A5:2 r:2 E5:2 | A5:2 r:1 A5:1 C6:2 r:2 D6:2 C6:2 Bb5:2 G5:2`,
      notes: 'Phrygian riff on A with the flat 2nd (Bb); bar 2 climbs before falling back.',
    },
    {
      name: '808 Drive',
      for: ['drop', 'drop 2'],
      kpn: `pattern "808 Drive" bars=2 grid=16 key=Am
808 {oct=1}: A1:6 A1:4 C2:6~ | A1:6 Bb1:8 G1:2`,
      notes: 'Each note starts on a Phonk Drums kick; the slide falls back to the root.',
    },
    {
      name: 'Dark Pad + Lead',
      for: ['intro', 'break', 'drop 2'],
      kpn: `pattern "Dark Pad + Lead" bars=4 grid=16 key=Am
Pad {vel=70}: [A3 C4 E4]:32 | [Bb3 D4 F4]:32
Lead {vel=96}: r:8 E5:4 F5:4 | E5:8 C5:4 Bb4:4 | r:8 E5:4 F5:4 | G5:8 F5:4 E5:4`,
      notes: 'i – ♭II pad; the lead answers the cowbell in the gaps.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.35, parts: ['Cowbell', 'Pad'], notes: 'The riff alone, low-passed and bit-crushed, opening up.' },
    { kind: 'build', label: 'Build', bars: 8, energy: 0.6, parts: ['Hat', '808', 'Cowbell', 'Pad'], transitionIn: ['filter-sweep'], notes: 'Hats and 808 hits enter; a clap roll in the last bar.' },
    { kind: 'drop', label: 'Drop 1', bars: 16, energy: 0.95, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', '808', 'Cowbell'], transitionIn: ['silence', 'impact'], notes: 'Phonk Drums + 808 Drive + Cowbell Riff; variation at bar 8.' },
    { kind: 'break', label: 'Break', bars: 8, energy: 0.4, parts: ['Pad', 'Cowbell', 'Hat'], transitionIn: ['downlifter'], notes: 'Kick, clap and 808 out; the riff filtered.' },
    { kind: 'build', label: 'Build 2', bars: 8, energy: 0.65, parts: ['Clap', 'Hat', '808', 'Cowbell', 'Pad'], transitionIn: ['filter-sweep'] },
    { kind: 'drop', label: 'Drop 2', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', '808', 'Cowbell', 'Lead'], transitionIn: ['silence', 'impact'], notes: 'Phonk Drums B, the lead answers the riff.' },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.3, parts: ['Cowbell', 'Pad'], transitionIn: ['filter-sweep'], notes: 'The riff alone, crushed and fading.' },
  ],
  mix: {
    master: { tags: ['loud', 'distorted'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['dirty', 'distorted'] }],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['dark'], from: [{ part: 'Cowbell', amount: 0.2 }, { part: 'Pad', amount: 0.3 }, { part: 'Lead', amount: 0.2 }, { part: 'Clap', amount: 0.1 }] },
      { name: 'Echo', chain: 'delaySend', tags: ['dark'], from: [{ part: 'Cowbell', amount: 0.15 }] },
    ],
    levels:
      'Kick, clap and 808 at the top (the 808 ducks under the kick); the cowbell 2-4 dB under the clap, loud but not piercing (cut around 3-5 kHz if harsh); hats 6-8 dB under the clap; lead under the cowbell; pad low.',
    notes: 'Drums on the Dirty Crunch bus, the 808 on its own saturated chain. Saturate on purpose but keep the kick transient readable: do not clip every channel and the master.',
  },
  transitions:
    'Drops start after a beat of silence with an impact (or 808 boom) on the downbeat. Builds use a high-pass or low-pass sweep on the riff plus a clap or snare roll in the last bar. The break drops kick, clap and 808 at once (downlifter). The outro is the riff alone.',
  mistakes: [
    'No riff: the pitched cowbell motif is the hook; write it first and keep it to 3-4 notes in phrygian.',
    'A clean 808: phonk 808s are saturated and loud, doubling the kick rhythm.',
    'Harsh cowbell: it is loud but must not pierce; tame 3-5 kHz and keep it under the clap.',
    'Clap on 2 and 4 at 145 bpm: this style is half-time, clap on beat 3 (or switch to the four-on-the-floor variant at 125-135 with claps on 2 and 4 on purpose).',
    'Clipping everything: distortion on the drum bus, 808 and master at once flattens the kick; pick where the grit lives.',
    'Too long: drift phonk is short; two drops, around 2 minutes.',
    'Machine-flat hats: accent the beats and roll the bar ends; a light hiphop groove on the hats only.',
  ],
  groove: { template: 'hiphop', amount: 0.3, velocity: 0.4, parts: ['Hat', 'OpenHat'] },
  targets: {
    lufs: -7,
    truePeakDb: -1,
    bars: [56, 104],
    bands: { sub: [0, 16], low: [0, 14], lowMid: [-6, 5], highMid: [-12, 2], high: [-18, 2] },
    contrastLu: [6, 16],
    minCorrelation: 0.35,
    maxStaticBars: 8,
    minHatVelocitySpread: 6,
  },
};
