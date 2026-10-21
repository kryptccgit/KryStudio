// Techno: driving four-on-the-floor, rumbling bass, hypnotic sequences developed by automation.
import type { Playbook } from './types';

export const TECHNO: Playbook = {
  id: 'techno',
  name: 'Techno',
  summary:
    'Driving, hypnotic club music at 125-140 bpm (hard techno up to 150). A heavy four-on-the-floor kick with a rumbling, offbeat bass underneath, a clap or rim on 2 and 4, open hats on the offbeats, a ride and sparse percussion. On top, a short 16th-note sequence or arpeggio and occasional dark stabs. Harmony is static; the track develops through timbre: filter cutoff, resonance, delay feedback and reverb sends automated over 16-32 bars, and elements entering one at a time. Long sections, long intros and outros for DJs.',
  bpm: { min: 125, max: 140, typical: 132 },
  grid: 16,
  swing: 5,
  keys: {
    modes: ['natural minor', 'phrygian', 'minor pentatonic'],
    common: ['Am', 'Fm', 'Gm', 'Em', 'Cm', 'F#m'],
    notes: 'The key matters for the bass and sequence only; phrygian (flat 2nd) for menace, minor triads for melodic techno.',
  },
  harmony: {
    progressions: ['i only (drone / one-note bass)', 'i – ♭II (phrygian stab)', 'i – ♭VI (melodic techno)', 'i – ♭VII – ♭VI – ♭VII (melodic techno sequence over 8 bars)'],
    rhythm: 'Static for long stretches; at most one chord change every 2-8 bars. Development is timbre, not harmony.',
    voicing: 'Open fifths or single notes for stabs in octave 3-4; melodic techno arps a minor triad in octave 4-5; the bass is a single note in octave 1.',
  },
  melody:
    'Hypnotic repetition: a 1-bar 16th-note sequence of 3-5 notes, changed by automating its filter, decay and delay rather than rewriting notes. Melodic techno adds a long, simple lead line in the peak.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'hard', 'punchy'], writing: 'Every beat, loud and steady; the anchor. Out only in the breakdown.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'hard'], writing: 'Clap or rim on 2 and 4 from the groove section on, with a dark reverb tail.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'metallic'], writing: '16th closed hats skipping the offbeat, accented; very light transform_notes groove "dance" at 20% timing, 30% velocity on hats and percussion only.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'Every offbeat 8th from the groove section on.', bus: 'Drum Bus' },
    { name: 'Ride', role: 'ride', sample: 'ride', tags: ['bright', 'airy'], writing: '8th-note ride for the drops: the drive of peak-time techno.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'perc', tags: ['perc', 'metallic'], writing: 'Metallic or tom-like hits on 1-2 syncopated 16ths per bar, changing every 16 bars; heavy delay.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['dark', 'deep'], range: [24, 48], writing: 'Rumbling offbeat 16ths on the root in octave 1 (three notes per beat, never on the kick); a turn at the end of 2 bars. Low-pass and duck hard under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Arp', role: 'arp', tags: ['dark', 'evolving'], range: [55, 84], writing: '1-bar 16th sequence of a minor triad in octave 4-5; automate its filter cutoff and the delay send over 16-32 bars.', chain: 'lead', bus: 'Music Bus' },
    { name: 'Stab', role: 'stab', tags: ['dark', 'short'], range: [45, 84], writing: 'Short open-fifth stabs on offbeats in the breakdown and drop 2, drenched in the long reverb.', chain: 'lead', bus: 'Music Bus' },
    { name: 'Pad', role: 'pad', tags: ['dark', 'evolving'], range: [45, 80], writing: 'A dark, slowly moving atmosphere for the breakdown and build.', chain: 'pad', bus: 'Music Bus' },
  ],
  patterns: [
    {
      name: 'Techno Drive',
      for: ['drop', 'drop 2'],
      kpn: `pattern "Techno Drive" bars=2 grid=16 key=Am
Kick    : x... x... x... x... | x... x... x... x...
Clap    : .... x... .... x... | .... x... .... x...
Hat     : 46.6 46.6 46.6 46.6 | 46.6 46.6 46.6 46.7
OpenHat : ..x. ..x. ..x. ..x. | ..x. ..x. ..x. ..x.
Ride    : 5.3. 5.3. 5.3. 5.3. | 5.3. 5.3. 5.3. 5.3.
Perc    : .... ..x. .... .x.. | .... ..x. ..x. .x..`,
      notes: 'Peak-time groove; drop the ride for the groove section.',
    },
    {
      name: 'Techno Fill',
      for: ['groove', 'drop', 'drop 2'],
      kpn: `pattern "Techno Fill" bars=1 grid=16 key=Am
Kick : x... x... x... x.x.
Clap : .... x... .... x.xx
Hat  : 46.6 46.6 46.6 46.6
Perc : .... ..x. ..x. xxxx`,
      notes: 'End of a 16- or 32-bar phrase.',
    },
    {
      name: 'Rumble + Arp',
      for: ['intro', 'groove', 'drop', 'drop 2', 'breakdown'],
      kpn: `pattern "Rumble + Arp" bars=2 grid=16 key=Am
Bass {oct=1 vel=100}: (r:1 A1 A1 A1)*4 | (r:1 A1 A1 A1)*3 r C2 A1 G1
Arp {vel=86}: (A4:1 C5 E5 C5)*4 | (A4 C5 E5 G5)*2 (A4 C5 F5 C5)*2`,
      notes: 'Offbeat rumble (never on the kick) and a 1-bar sequence that changes colour in bar 2.',
    },
    {
      name: 'Stab Hits',
      for: ['breakdown', 'drop 2'],
      kpn: `pattern "Stab Hits" bars=2 grid=16 key=Am
Stab {vel=96}: r:2 [A3 E4]:1 r:5 r:2 [A3 E4]:1 r:5 | r:2 [A3 E4]:1 r:3 [A3 E4]:1 r:1 [Bb3 F4]:1 r:7`,
      notes: 'Open-fifth stabs with a phrygian flat-2nd answer; long dark reverb.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 32, energy: 0.45, parts: ['Kick', 'Hat', 'Perc', 'Bass'], notes: 'Kick and hats for DJs; the rumble enters at bar 17, low-passed.' },
    { kind: 'verse', label: 'Groove', bars: 32, energy: 0.65, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Arp'], notes: 'Clap and open hat at bar 1, the arp at bar 17 with its filter opening over 16 bars.' },
    { kind: 'drop', label: 'Drop 1', bars: 32, energy: 0.85, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Ride', 'Perc', 'Bass', 'Arp'], transitionIn: ['filter-sweep', 'crash'], notes: 'The ride drives it; automate the arp delay feedback up through bars 17-32.' },
    { kind: 'breakdown', label: 'Breakdown', bars: 16, energy: 0.35, parts: ['Arp', 'Stab', 'Pad'], transitionIn: ['downlifter'], notes: 'Kick and bass out: stabs, pad and the arp in a wash of reverb.' },
    { kind: 'build', label: 'Build', bars: 8, energy: 0.6, parts: ['Clap', 'Hat', 'Arp', 'Pad'], transitionIn: ['filter-sweep'], notes: 'Rising high-pass and resonance on the Music Bus; claps double up.' },
    { kind: 'drop', label: 'Drop 2', bars: 32, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Ride', 'Perc', 'Bass', 'Arp', 'Stab'], transitionIn: ['riser', 'impact'], notes: 'Everything, stabs included; the peak.' },
    { kind: 'outro', label: 'Outro', bars: 32, energy: 0.45, parts: ['Kick', 'Hat', 'Perc', 'Bass'], transitionIn: ['downlifter'], notes: 'Remove one element every 8 bars back to kick and hats.' },
  ],
  mix: {
    master: { tags: ['loud', 'club'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['club', 'tight'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['dark', 'long'], from: [{ part: 'Clap', amount: 0.2 }, { part: 'Stab', amount: 0.4 }, { part: 'Arp', amount: 0.2 }, { part: 'Pad', amount: 0.3 }, { part: 'Perc', amount: 0.2 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Arp', amount: 0.25 }, { part: 'Perc', amount: 0.25 }] },
    ],
    levels:
      'Kick clearly loudest; the rumble 4-6 dB under it and ducked hard; clap 3-4 dB under the kick; hats, ride and percussion 8-12 dB under; arp 6-8 dB under the kick; stabs and pad in the reverb, behind.',
    notes: 'Mono, tight low end; keep the kick transient untouched. Automation is the arrangement: filter cutoff, delay feedback and send levels move over every 16-32 bars.',
  },
  transitions:
    'Long, gradual changes: elements enter or leave every 8-16 bars, filters open over 16-32 bars, and the breakdown drops the kick with a downlifter. The build sweeps a resonant high-pass up the Music Bus; the drop returns with an impact. Avoid pop-style snare rolls; use delay throws and reverb swells.',
  mistakes: [
    'Changing the notes instead of the sound: techno develops by automation (filter, resonance, delay, reverb) over 16-32 bars.',
    'A bass on the kick: the rumble sits on the off-16ths and ducks hard under the kick.',
    'Too many elements at once: introduce one element at a time on phrase boundaries.',
    'Short sections: techno uses 16-32 bar sections and long DJ intros and outros.',
    'A soft, small kick: the kick is the loudest and most important sound.',
    'Pop harmony: one chord or none; menace comes from the phrygian flat 2nd and timbre.',
  ],
  groove: { template: 'dance', amount: 0.2, velocity: 0.3, parts: ['Hat', 'OpenHat', 'Perc'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [128, 256],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-8, 4], highMid: [-11, 1], high: [-16, 3] },
    contrastLu: [4, 12],
    minCorrelation: 0.35,
    maxStaticBars: 32,
    minHatVelocitySpread: 4,
  },
};
