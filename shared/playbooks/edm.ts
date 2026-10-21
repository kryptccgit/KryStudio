// EDM (big room / progressive / electro house): breakdown – build – drop structure with a big lead hook.
import type { Playbook } from './types';

export const EDM: Playbook = {
  id: 'edm',
  name: 'EDM',
  summary:
    'Festival and progressive house at 124-132 bpm built on breakdown – build – drop. The drop is a four-on-the-floor kick, a clap on 2 and 4, offbeat open hats, an offbeat bass over a clean sub, huge pumping supersaw chords and a short, high lead hook. The breakdown states the hook softly on a pluck or piano over pads with no kick; the build adds a snare roll (quarters → 8ths → 16ths → 32nds), a rising high-pass, a riser and a beat of silence before the drop hits with an impact. Euphoric, wide and very loud.',
  bpm: { min: 124, max: 132, typical: 128 },
  grid: 16,
  swing: 0,
  keys: {
    modes: ['natural minor', 'major (euphoric)'],
    common: ['Am', 'Fm', 'C#m', 'Gm', 'F#m', 'Em', 'Dm'],
    notes: 'Minor keys whose relative-major loop (vi – IV – I – V) gives the euphoric lift.',
  },
  harmony: {
    progressions: ['vi – IV – I – V (Am – F – C – G)', 'i – VI – III – VII', 'i – VII – VI – VII', 'VI – VII – i (rising, for builds)'],
    rhythm: 'One chord per bar in drops and breakdowns (4-bar loops); builds hold one chord or climb VI – VII.',
    voicing: 'Wide supersaw chords in octave 3-5 with the root doubled an octave below; the offbeat bass in octave 2 and a sine sub on the root in octave 1; piano or pluck triads in the breakdown.',
  },
  melody:
    'A short, high, memorable lead of 4-8 notes over 2 bars, repeated with the last bar varied; chord tones on the strong beats, a stepwise climb to the top note. It is introduced softly in the breakdown (pluck or piano, no drums) and returns huge in the drop.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'big'], writing: 'Every beat in drops, intro and outro; 16ths in the last bar of the build; out in breakdowns.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'big', 'bright'], writing: 'Beats 2 and 4 in drops, intro and outro; layered with the snare for a bigger hit in drop 2.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'bright'], writing: 'The build roll: quarters, 8ths, 16ths, then 32nds ramping in velocity, a beat of silence before the drop.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright'], writing: 'Tight 16ths skipping the offbeat, accented; at most a light transform_notes groove "dance" at 15% on hats (the kick and clap stay on the grid).', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'Every offbeat 8th in drops, intro and outro.', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['tight', 'punchy'], range: [36, 55], writing: 'Offbeat 8ths on the chord roots in octave 2, short, ducked hard under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Sub', role: 'sub', tags: ['sub', 'deep', 'clean'], range: [24, 45], writing: 'Sine sub holding the chord roots in octave 1 in the drops, mono, ducked under the kick.', chain: 'bass', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Chords', role: 'chord', tags: ['wide', 'big', 'euphoric'], range: [52, 84], writing: 'Held supersaw chords, one per bar, pumping on the quarter notes (the chain pumps by itself, no sidechain needed); swelling in the builds.', chain: 'pad', bus: 'Music Bus' },
    { name: 'Lead', role: 'lead', tags: ['bright', 'big', 'wide'], range: [60, 91], writing: 'The hook in octave 5-6, doubled an octave down for weight in drop 2; plays filtered in the second breakdown.', chain: 'lead', bus: 'Music Bus', duckUnder: 'Kick' },
    { name: 'Pluck', role: 'pluck', tags: ['bright', 'short'], range: [55, 84], writing: 'An 8th-note chord arp that states the harmony in the intro and breakdowns and layers the drop 2 hook.', chain: 'pluck', bus: 'Music Bus' },
    { name: 'Pad', role: 'pad', tags: ['wide', 'airy'], range: [48, 80], writing: 'Wide held chords under the breakdowns and builds.', chain: 'pad', bus: 'Music Bus' },
  ],
  patterns: [
    {
      name: 'Drop Drums',
      for: ['drop', 'intro', 'outro'],
      kpn: `pattern "Drop Drums" bars=2 grid=16 key=Am
Kick    : x... x... x... x... | x... x... x... x...
Clap    : .... x... .... x... | .... x... .... x...
Hat     : 46.6 46.6 46.6 46.6 | 46.6 46.6 46.6 46.7
OpenHat : ..x. ..x. ..x. ..x. | ..x. ..x. ..x. ..x.`,
      notes: 'Tight and on the grid.',
    },
    {
      name: 'Build Roll',
      for: ['build'],
      kpn: `pattern "Build Roll" bars=4 grid=16 key=Am
Kick     : x... x... x... x... | x... x... x... x... | x.x. x.x. x.x. x.x. | xxxx xxxx xxxx ....
Snare/32 : (4.......)*4 | (4...)*8 | (5.)*16 | 6677889XXXXXXXXX ................`,
      notes: 'Quarters → 8ths → 16ths → 32nds, then two beats of silence; pair with a riser and a high-pass sweep.',
    },
    {
      name: 'Drop Harmony',
      for: ['drop'],
      kpn: `pattern "Drop Harmony" bars=4 grid=16 key=Am
Chords {vel=100}: [A3 E4 A4 C5 E5]:16 | [F3 F4 A4 C5]:16 | [C4 E4 G4 C5]:16 | [G3 D4 G4 B4]:16
Bass {oct=2}: (r:2 A2:2)*4 | (r:2 F2:2)*4 | (r:2 C3:2)*4 | (r:2 G2:2)*4
Sub {oct=1}: A1:16 | F1:16 | C2:16 | G1:16`,
      notes: 'vi – IV – I – V (Am – F – C – G): held supersaws, offbeat bass, sine sub on the roots.',
    },
    {
      name: 'Lead Hook',
      for: ['drop', 'breakdown'],
      kpn: `pattern "Lead Hook" bars=4 grid=16 key=Am
Lead {vel=100}: E5:2 A5:2 C6:2 B5:2 A5:2 G5:2 E5:4 | F5:2 A5:2 C6:2 A5:2 C6:4 D6:4 | E5:2 G5:2 C6:2 B5:2 C6:2 D6:2 E6:4 | D6:4 B5:4 G5:4 B5:4`,
      notes: 'Chord tones on the beats, a climb to the top E in bar 3, an open ending on the V.',
    },
    {
      name: 'Breakdown Pluck',
      for: ['breakdown', 'intro', 'build'],
      kpn: `pattern "Breakdown Pluck" bars=4 grid=16 key=Am
Pluck {vel=84}: (A4:2 C5 E5 C5)*2 | (F4 A4 C5 A4)*2 | (C5 E5 G5 E5)*2 | (G4 B4 D5 B4)*2
Pad {vel=64}: [A3 C4 E4]:16 | [F3 A3 C4]:16 | [C4 E4 G4]:16 | [G3 B3 D4]:16`,
      notes: 'The progression on an 8th-note pluck arp over pads, no drums.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 16, energy: 0.45, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Bass', 'Pluck'], notes: 'Drop Drums with the bass and a filtered pluck; DJ-friendly.' },
    { kind: 'breakdown', label: 'Breakdown 1', bars: 16, energy: 0.35, parts: ['Pad', 'Pluck'], transitionIn: ['downlifter', 'crash'], notes: 'No kick: pad and pluck state the progression and tease the hook.' },
    { kind: 'build', label: 'Build 1', bars: 8, energy: 0.65, parts: ['Kick', 'Snare', 'Pad', 'Pluck', 'Chords'], transitionIn: ['filter-sweep'], notes: 'Build Roll, rising high-pass on the Music Bus, chords swelling.' },
    { kind: 'drop', label: 'Drop 1', bars: 16, energy: 0.95, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Bass', 'Sub', 'Chords', 'Lead'], transitionIn: ['riser', 'snare-roll', 'impact'], notes: 'Hook x4; a fill at bar 8, the second 8 bars add a lead octave.' },
    { kind: 'breakdown', label: 'Breakdown 2', bars: 16, energy: 0.4, parts: ['Pad', 'Pluck', 'Lead'], transitionIn: ['downlifter', 'swell'], notes: 'The hook on the lead, low-passed and wet, over pads.' },
    { kind: 'build', label: 'Build 2', bars: 8, energy: 0.7, parts: ['Kick', 'Snare', 'Pad', 'Pluck', 'Chords'], transitionIn: ['filter-sweep'] },
    { kind: 'drop', label: 'Drop 2', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'OpenHat', 'Bass', 'Sub', 'Chords', 'Lead', 'Pluck'], transitionIn: ['riser', 'snare-roll', 'silence', 'impact'], notes: 'The biggest moment: everything plus the pluck layer.' },
    { kind: 'outro', label: 'Outro', bars: 16, energy: 0.45, parts: ['Kick', 'Clap', 'Hat', 'Bass'], transitionIn: ['downlifter'], notes: 'Back to drums and bass for the DJ.' },
  ],
  mix: {
    master: { tags: ['loud', 'big'] },
    buses: [
      { name: 'Drum Bus', chain: 'drumBus', tags: ['club', 'punchy'] },
      { name: 'Music Bus', chain: 'transition', tags: ['build', 'sweep'] },
    ],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['big', 'long', 'euphoric'], from: [{ part: 'Lead', amount: 0.2 }, { part: 'Pluck', amount: 0.3 }, { part: 'Pad', amount: 0.3 }, { part: 'Chords', amount: 0.15 }, { part: 'Clap', amount: 0.1 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Lead', amount: 0.18 }, { part: 'Pluck', amount: 0.2 }] },
    ],
    levels:
      'Kick loudest and clean; sub and bass 3-5 dB under it, ducked hard; clap 2 dB under the kick; lead 3-4 dB under the clap and on top of the chords; chords loud but pumping (they make the width); hats and open hats 8-10 dB under the clap; pads and plucks lower in drops, forward in breakdowns.',
    notes: 'Everything but the drums goes to the Music Bus (High-Pass Sweep automated through each build). Mono below 120 Hz; supersaws wide above 300 Hz. The drop must be at least 6 LU louder than the breakdown.',
  },
  transitions:
    'Build: the snare roll (quarters → 8ths → 16ths → 32nds), the Music Bus high-pass rising to 1-2 kHz, a riser over the last 4-8 bars, kick 16ths in the last bar, then a beat of silence. Drop: impact plus crash on the downbeat, the high-pass snapped back to 20 Hz. Breakdowns open with a downlifter and a crash, kick out. A fill or stutter at bar 8 of each drop.',
  mistakes: [
    'A weak drop: it must contrast with the breakdown (6+ LU): kick, sub and pumping supersaws all land on the downbeat after a beat of silence.',
    'No build: snare roll, rising high-pass and riser over 8 bars; without them the drop does not land.',
    'Muddy supersaws: high-pass the chords around 200 Hz, mono everything below 120 Hz, let the sub and bass own the low end.',
    'No pumping: duck the bass, sub, lead and chords on every kick (or use the pumping chord chain).',
    'A hook that is too long or too busy: 4-8 notes over 2 bars, repeated.',
    'Swung or humanised kicks: EDM is tight; at most a light groove on the hats.',
    'A 16-bar drop with no change: add a lead octave or a fill at bar 8.',
  ],
  groove: { template: 'dance', amount: 0.15, velocity: 0.3, parts: ['Hat', 'OpenHat'] },
  targets: {
    lufs: -7,
    truePeakDb: -1,
    bars: [96, 176],
    bands: { sub: [-2, 14], low: [0, 13], lowMid: [-8, 3], highMid: [-10, 2], high: [-15, 3] },
    contrastLu: [6, 14],
    minCorrelation: 0.25,
    maxStaticBars: 8,
    minHatVelocitySpread: 4,
  },
};
