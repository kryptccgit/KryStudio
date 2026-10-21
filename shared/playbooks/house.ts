import type { Playbook } from './types';

export const HOUSE: Playbook = {
  id: 'house',
  name: 'House',
  summary:
    'Classic and modern house at 120-128 bpm: a four-on-the-floor kick, a clap on 2 and 4, an open hat on every offbeat and shuffling 16th closed hats and percussion. Above it, syncopated piano or organ stabs (minor 7th and 9th chords) and an offbeat, bouncy bassline; a short riff or vocal-chop hook in the second drop. The track is built for DJs: drum-only intro and outro, 8-bar phrasing, elements entering and leaving at phrase boundaries, a breakdown with the kick out and a filtered build back in.',
  bpm: { min: 120, max: 128, typical: 124 },
  grid: 16,
  swing: 20,
  keys: {
    modes: ['natural minor', 'dorian', 'major'],
    common: ['Am', 'Dm', 'Fm', 'Gm', 'C', 'F', 'Ebm'],
    notes: 'Dorian vamps (i7 – iv7) are the soulful house sound; major keys for disco and piano house.',
  },
  harmony: {
    progressions: ['i7 – iv9 (dorian vamp, 2 bars each)', 'i – VI – VII – v', 'ii7 – V7 – Imaj7 – vi7 (disco / soulful)', 'Imaj7 – IVmaj7 (two-chord piano house)'],
    rhythm: 'One chord per bar or a two-chord vamp over 2-4 bars; 8-bar phrases. The stab rhythm (offbeats and syncopated 16ths) matters more than the chord changes.',
    voicing: 'Piano or organ stabs (m7, m9, maj7) in octave 3-4, short and syncopated; pads or strings hold the chord in breakdowns; the bass sits in octave 1-2 on the offbeats.',
  },
  melody:
    'Hooks are short and repetitive: a 1-2 bar piano riff, a vocal-chop phrase or a synth riff, brought in for the second drop. Melody enters and leaves at 8-bar boundaries instead of playing all song.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'club'], writing: 'Every beat, steady velocity; out in the breakdown, back on the drop downbeat.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'bright'], writing: 'Beats 2 and 4, a ghost or flam at the end of 8-bar phrases; carries the build.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: '16th closed hats skipping the offbeat (the open hat owns it), accent pattern loud-soft so they shuffle; apply transform_notes groove "dance" at 35% timing, 40% velocity to the hats and percussion.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'Every offbeat 8th (steps 3, 7, 11, 15): the house pulse. Enters with the groove, leaves in breakdowns.', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'perc', tags: ['perc', 'organic'], writing: 'Conga, rim or shaker hits on syncopated 16ths, a different 2-bar pattern for each section.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['tight', 'punchy'], range: [28, 52], writing: 'Offbeat 8ths on the root with an octave jump or passing note at the end of 2 bars; short notes so the kick stays clear; ducks under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Piano', role: 'piano', tags: ['bright', 'clean'], range: [48, 84], writing: 'Syncopated m7 / m9 stabs (offbeats plus a 16th push before the bar) in octave 3-4; the main hook of drop 1 and the breakdown.', chain: 'keys', bus: 'Music Bus' },
    { name: 'Pad', role: 'pad', tags: ['wide', 'pumping'], range: [45, 80], writing: 'Held chords in the build, breakdown and drop 2, pumping with the kick.', chain: 'pad', bus: 'Music Bus' },
    { name: 'Lead', role: 'lead', tags: ['bright'], range: [60, 91], writing: 'A 2-bar riff for drop 2 only (or a vocal chop doing the same rhythm), octave 5.', chain: 'lead', bus: 'Music Bus', duckUnder: 'Kick' },
  ],
  patterns: [
    {
      name: 'Four To The Floor',
      for: ['groove', 'drop'],
      kpn: `pattern "Four To The Floor" bars=2 grid=16 key=Am
Kick    : x... x... x... x... | x... x... x... x...
Clap    : .... x... .... x... | .... x... .... x..o
Hat     : 35.4 35.4 35.4 35.4 | 35.4 35.4 35.4 35.6
OpenHat : ..x. ..x. ..x. ..x. | ..x. ..x. ..x. ..x.
Perc    : .... ..x. .... .x.. | .... ..x. ..x. ....`,
      notes: 'The core groove; swing about 20 plus the dance groove on hats and perc.',
    },
    {
      name: 'DJ Intro',
      for: ['intro', 'outro'],
      kpn: `pattern "DJ Intro" bars=2 grid=16 key=Am
Kick : x... x... x... x... | x... x... x... x...
Hat  : 35.4 35.4 35.4 35.4 | 35.4 35.4 35.4 35.4
Perc : .... ..x. .... ..x. | .... ..x. .... ..x.`,
      notes: 'Mix-friendly: kick, hats and a little percussion only.',
    },
    {
      name: 'Phrase Fill',
      for: ['drop', 'drop 2', 'groove'],
      kpn: `pattern "Phrase Fill" bars=1 grid=16 key=Am
Kick    : x... x... x... ....
Clap    : .... x... .... x.x.
OpenHat : ..x. ..x. ..x. ..x.
Perc    : .... ..x. ..x. 5678`,
      notes: 'Bar 8 of a phrase: the last kick drops, the percussion rolls into the next downbeat.',
    },
    {
      name: 'Bass + Piano',
      for: ['groove', 'drop', 'drop 2', 'breakdown'],
      kpn: `pattern "Bass + Piano" bars=4 grid=16 key=Am
Piano {oct=3 vel=90}: (r:2 Am7:2)*3 r:1 Am7:3 | (r:2 Am7:2)*4 | (r:2 Dm9:2)*3 r:1 Dm9:3 | (r:2 Dm9:2)*4
Bass {oct=2}: (r:2 A1:2)*4 | (r:2 A1:1 A2:1)*4 | (r:2 D2:2)*4 | (r:2 D2:1 C2:1)*2 (r:2 E2:2)*2`,
      notes: 'i7 – iv9 dorian vamp: offbeat stabs with a 16th push, the bass on the offbeats with octave jumps.',
    },
    {
      name: 'Lead Riff',
      for: ['drop 2'],
      kpn: `pattern "Lead Riff" bars=2 grid=16 key=Am
Lead {vel=96}: A5:2 r:1 C6:1 r:2 E6:2 D6:3 C6:3 A5:2 | G5:2 r:1 A5:1 r:2 C6:2 A5:8`,
      notes: 'Syncopated 2-bar hook for the second drop.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 16, energy: 0.4, parts: ['Kick', 'Hat', 'Perc'], notes: 'DJ Intro; clap enters at bar 9.' },
    { kind: 'verse', label: 'Groove', bars: 16, energy: 0.6, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Perc', 'Bass'], notes: 'Full drums and bass; the open hat lands at bar 1, the bass at bar 9.' },
    { kind: 'build', label: 'Build', bars: 8, energy: 0.65, parts: ['Clap', 'Hat', 'Perc', 'Bass', 'Piano', 'Pad'], transitionIn: ['filter-sweep'], notes: 'Kick out, piano enters through a rising high-pass on the Music Bus; clap roll in the last 2 bars.' },
    { kind: 'drop', label: 'Drop 1', bars: 32, energy: 0.9, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Piano'], transitionIn: ['riser', 'snare-roll', 'crash'], notes: 'Phrase Fill every 8 bars; change the percussion pattern at bar 17.' },
    { kind: 'breakdown', label: 'Breakdown', bars: 16, energy: 0.4, parts: ['Piano', 'Pad', 'Perc'], transitionIn: ['downlifter'], notes: 'Kick and bass out, piano and pad with a low-pass slowly opening.' },
    { kind: 'build', label: 'Build 2', bars: 8, energy: 0.7, parts: ['Clap', 'Hat', 'Bass', 'Piano', 'Pad'], transitionIn: ['filter-sweep'] },
    { kind: 'drop', label: 'Drop 2', bars: 32, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Piano', 'Pad', 'Lead'], transitionIn: ['riser', 'snare-roll', 'crash'], notes: 'The Lead Riff joins; the fullest section.' },
    { kind: 'outro', label: 'Outro', bars: 16, energy: 0.4, parts: ['Kick', 'Hat', 'Perc', 'Bass'], transitionIn: ['downlifter'], notes: 'Strip back to the DJ Intro groove; bass leaves at bar 9.' },
  ],
  mix: {
    master: { tags: ['loud', 'club'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['club', 'tight'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['bright', 'vocal', 'snare'], from: [{ part: 'Clap', amount: 0.15 }, { part: 'Piano', amount: 0.2 }, { part: 'Pad', amount: 0.25 }, { part: 'Lead', amount: 0.2 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Lead', amount: 0.2 }, { part: 'Piano', amount: 0.1 }] },
    ],
    levels:
      'Kick loudest; bass 3-4 dB under the kick and ducked by it; clap 2-3 dB under the kick; open hat 6-8 dB under the clap, closed hats and percussion lower; piano 4-6 dB under the clap; pad low and pumping; lead 2-3 dB under the piano.',
    notes: 'Bass, Piano, Pad and Lead go to the Music Bus, whose High-Pass Sweep chain is automated through the builds. Only the kick and bass below 120 Hz; everything else high-passed.',
  },
  transitions:
    'Every change lands on an 8-bar boundary. Builds: kick out, a high-pass sweep on the Music Bus, a clap or snare roll over the last 2 bars and a riser, then the drop downbeat with a crash. The breakdown starts with a downlifter. Bar 8 of every phrase gets a small fill (missing kick, a percussion roll).',
  mistakes: [
    'Bass on the kick: the house bass lives on the offbeats and ducks under the kick; a bass note on every beat with the kick turns to mud.',
    'Missing the offbeat open hat: it is the house pulse; closed hats skip that step.',
    'Changes off the 8-bar grid: elements enter and leave at phrase boundaries (bar 1, 9, 17, 25 of a section).',
    'Stiff, quantised percussion: swing around 20 and transform_notes groove "dance" (30-40%) on hats and percussion; vary the percussion pattern between sections.',
    'No DJ intro or outro: 16 bars of drums at the start and end.',
    'Busy chords: one or two chords with a strong stab rhythm beat a long progression.',
    'A static 32-bar drop: add or remove one element every 8 bars and use a fill at each phrase end.',
  ],
  groove: { template: 'dance', amount: 0.35, velocity: 0.4, parts: ['Hat', 'OpenHat', 'Perc'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [96, 192],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-8, 4], highMid: [-11, 1], high: [-16, 3] },
    contrastLu: [4, 12],
    minCorrelation: 0.35,
    maxStaticBars: 16,
    minHatVelocitySpread: 5,
  },
};
