// Reggaeton: the dembow rhythm, minor four-chord loops, an 808 sub and short chant-like hooks.
import type { Playbook } from './types';

export const REGGAETON: Playbook = {
  id: 'reggaeton',
  name: 'Reggaeton',
  summary:
    'Latin urban pop at 88-100 bpm driven by the dembow rhythm: a kick on every beat and a snare or rim on the 3-3-2 accents (the "a" of 1, the "and" of 2, and the same in the second half of the bar). Under it an 808-like sub plays the roots of a minor four-chord loop; plucked or piano chords hit on the dembow accents; a short, chant-like vocal hook is answered by a synth lead. The groove never stops for long; contrast comes from dropping the kick in pre-choruses and bridges.',
  bpm: { min: 88, max: 100, typical: 94 },
  grid: 16,
  swing: 0,
  keys: {
    modes: ['natural minor', 'harmonic minor'],
    common: ['Am', 'Bm', 'C#m', 'F#m', 'Dm', 'Em', 'Gm'],
    notes: 'Minor keys almost always; the harmonic-minor V adds Latin drama in pre-choruses.',
  },
  harmony: {
    progressions: ['i – VI – III – VII', 'i – iv – VII – III', 'vi – IV – I – V (major-sounding romantic loop)', 'i – VII – VI – V (harmonic-minor V)'],
    rhythm: 'One chord per bar in a 4-bar loop that runs the whole song; the dembow, not the harmony, drives it.',
    voicing: 'Plucked or piano triads in octave 4 hit on the dembow accents (3-3-2); soft pads underneath; the 808 sub on the roots in octave 1.',
  },
  melody:
    'Vocal-driven: short, rhythmic, chant-like phrases that land on the dembow accents, small range (a 5th), minor pentatonic. A synth lead or pluck answers the vocal in the gaps of the chorus with a 2-bar phrase.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy'], writing: 'Every beat (four on the floor), steady velocity; drops out in pre-choruses and the bridge for contrast.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'bright'], writing: 'The dembow: steps 4, 7, 12 and 15 of every bar (a snare or rim). Rolls into choruses. Light latin feel: transform_notes groove "latin" at 35% timing, 40% velocity on snare, hats and perc only; the kick stays straight.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: '8th-note hats with accents on the beat, a 16th pickup at bar ends.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'perc', tags: ['perc', 'organic'], writing: 'Timbales, bongos or a woodblock adding one or two syncopated hits per bar in choruses.', chain: 'drums', bus: 'Drum Bus' },
    { name: '808', role: '808', tags: ['deep', 'punchy'], range: [24, 45], writing: 'Sub-heavy 808 on the chord roots following the kick and the dembow (onsets on steps 1, 8, 13); mono; ducks under the kick.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Chords', role: 'chord', tags: ['bright', 'short'], range: [55, 84], writing: 'Plucked or piano triads in octave 4 hitting on a 3-3-2 rhythm each half bar; the harmonic loop of the song.', chain: 'pluck' },
    { name: 'Lead', role: 'lead', tags: ['bright'], range: [57, 86], writing: 'Chorus answer phrase in octave 4-5, on the dembow accents; also plays the hook in the intro.', chain: 'lead' },
    { name: 'Pad', role: 'pad', tags: ['soft', 'warm'], range: [48, 80], writing: 'Soft pad under intros, pre-choruses, choruses and the bridge.', chain: 'pad' },
  ],
  patterns: [
    {
      name: 'Dembow',
      for: ['verse', 'chorus'],
      kpn: `pattern "Dembow" bars=2 grid=16 key=Am
Kick  : x... x... x... x... | x... x... x... x...
Snare : ...x ..x. ...x ..x. | ...x ..x. ...x ..x.
Hat   : 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. 6.4. 6.46
Perc  : .... .... ..x. .... | .... .... ..x. .x..`,
      notes: 'The core rhythm: four-on-the-floor kick, snare on the 3-3-2 accents.',
    },
    {
      name: 'Dembow Break',
      for: ['pre', 'chorus'],
      kpn: `pattern "Dembow Break" bars=2 grid=16 key=Am
Kick  : x... .... .... .... | x... .... x... x...
Snare : ...x ..x. ...x ..x. | ...x ..x. xxxx 6789
Hat   : 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. .... ....`,
      notes: 'Kick drops out, the snare rolls into the next section.',
    },
    {
      name: '808 + Chords',
      for: ['verse', 'chorus', 'intro', 'outro'],
      kpn: `pattern "808 + Chords" bars=4 grid=16 key=Am
808 {oct=1}: A1:7 A1:5 E1:4 | F1:7 F1:5 C2:4 | C2:7 C2:5 G1:4 | G1:7 G1:5 D2:4
Chords {oct=4 vel=84}: (Am:3 Am:3 Am:2)*2 | (F:3 F:3 F:2)*2 | (C:3 C:3 C:2)*2 | (G:3 G:3 G:2)*2`,
      notes: 'i – VI – III – VII; chords on the 3-3-2, the 808 on 1, the dembow accent and beat 4.',
    },
    {
      name: 'Lead Hook',
      for: ['chorus', 'intro'],
      kpn: `pattern "Lead Hook" bars=2 grid=16 key=Am
Lead {vel=96}: E5:3 E5:3 D5:2 C5:3 D5:3 E5:2 | A4:3 C5:3 D5:2 E5:8`,
      notes: 'Same 3-3-2 rhythm as the chords; bar 2 lands on a long 5th.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 4, energy: 0.35, parts: ['Chords', 'Pad', 'Lead'], notes: 'Chords and the hook, filtered; a vocal tag goes here.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.65, parts: ['Kick', 'Snare', 'Hat', '808', 'Chords'], transitionIn: ['silence'], notes: 'Dembow from the downbeat; keep it steady for the vocal.' },
    { kind: 'pre', label: 'Pre 1', bars: 4, energy: 0.6, parts: ['Snare', 'Hat', '808', 'Chords', 'Pad'], transitionIn: ['filter-sweep'], notes: 'Kick out; Dembow Break in the last 2 bars.' },
    { kind: 'chorus', label: 'Chorus 1', bars: 8, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'Perc', '808', 'Chords', 'Lead', 'Pad'], transitionIn: ['silence'] },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.7, parts: ['Kick', 'Snare', 'Hat', 'Perc', '808', 'Chords'], transitionIn: ['drum-fill'] },
    { kind: 'pre', label: 'Pre 2', bars: 4, energy: 0.65, parts: ['Snare', 'Hat', '808', 'Chords', 'Pad'], transitionIn: ['filter-sweep'] },
    { kind: 'chorus', label: 'Chorus 2', bars: 8, energy: 0.95, parts: ['Kick', 'Snare', 'Hat', 'Perc', '808', 'Chords', 'Lead', 'Pad'], transitionIn: ['silence'] },
    { kind: 'bridge', label: 'Bridge', bars: 8, energy: 0.45, parts: ['Perc', '808', 'Chords', 'Pad'], transitionIn: ['downlifter'], notes: 'No dembow: pads, chords and percussion; the dembow returns with a snare roll.' },
    { kind: 'chorus', label: 'Chorus 3', bars: 8, energy: 1, parts: ['Kick', 'Snare', 'Hat', 'Perc', '808', 'Chords', 'Lead', 'Pad'], transitionIn: ['snare-roll'] },
    { kind: 'outro', label: 'Outro', bars: 4, energy: 0.35, parts: ['Perc', 'Chords', 'Pad'], transitionIn: ['filter-sweep'] },
  ],
  mix: {
    master: { tags: ['clean', 'polished'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['punchy'] }],
    sends: [
      { name: 'Room', chain: 'reverbSend', tags: ['short'], from: [{ part: 'Snare', amount: 0.15 }, { part: 'Chords', amount: 0.2 }, { part: 'Lead', amount: 0.2 }, { part: 'Pad', amount: 0.2 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Lead', amount: 0.2 }] },
    ],
    levels:
      'Kick and 808 dominate the low end (the 808 ducks under the kick); the dembow snare 1-2 dB under the kick and bright; hats 8-10 dB under the snare; chords 5-6 dB under the snare; lead 2-3 dB under the snare in the chorus; pad low.',
    notes: 'Everything below 120 Hz is kick and 808 only. Keep the dembow snare dry and crisp; reverb on the melodic parts.',
  },
  transitions:
    'The dembow stops (silence or kick out) for the last beat or bar before each chorus, then returns on the downbeat. Pre-choruses drop the kick and filter the music; the bridge removes the dembow entirely and comes back with a snare roll.',
  mistakes: [
    'A wrong dembow: the snare is on steps 4, 7, 12, 15 against a four-on-the-floor kick; any other placement loses the genre.',
    'No breaks in the dembow: drop the kick in pre-choruses and the bridge so the chorus returns with impact.',
    'Too much swing: reggaeton is straight; a light latin groove on snare, hats and perc only.',
    'Muddy low end: 808 and kick share the sub, so duck the 808 and keep pads and chords high-passed.',
    'Long, wide-range melodies: hooks are short chants in a small range on the dembow accents.',
    'Sections that never change: alternate full dembow, kick-out pre-choruses and a no-dembow bridge.',
  ],
  groove: { template: 'latin', amount: 0.35, velocity: 0.4, parts: ['Snare', 'Hat', 'Perc'] },
  targets: {
    lufs: -9,
    truePeakDb: -1,
    bars: [64, 104],
    bands: { sub: [-2, 15], low: [0, 13], lowMid: [-7, 4], highMid: [-11, 1], high: [-16, 1] },
    contrastLu: [4, 12],
    minCorrelation: 0.35,
    maxStaticBars: 8,
    minHatVelocitySpread: 5,
  },
};
