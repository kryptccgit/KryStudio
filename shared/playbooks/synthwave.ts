import type { Playbook } from './types';

export const SYNTHWAVE: Playbook = {
  id: 'synthwave',
  name: 'Synthwave',
  summary:
    'Nostalgic, cinematic retro electronic music at 80-118 bpm. A steady 80s drum-machine beat with a big, roomy snare on 2 and 4 and tom fills, a pulsing 8th-note bass that bounces between octaves, slow-attack polysynth pads, 16th-note arpeggios and a bright, singable lead with chorus and delay. Song structure (verse, chorus, bridge) with a solo-like final chorus. Warm, wide and glowing rather than loud.',
  bpm: { min: 80, max: 118, typical: 100 },
  grid: 16,
  swing: 0,
  keys: {
    modes: ['natural minor', 'dorian', 'major (sunset mood)'],
    common: ['Am', 'Em', 'F#m', 'Dm', 'Bm', 'C', 'G'],
    notes: 'Minor keys with sus2 / add9 colour; major for the brighter, sunset feel.',
  },
  harmony: {
    progressions: ['i – ♭VI – ♭III – ♭VII', 'i – ♭VII – ♭VI – ♭VII', 'vi – IV – I – V', 'i – iv – ♭VI – ♭VII'],
    rhythm: 'One chord per bar or per 2 bars in 4- and 8-bar loops; pads hold while the bass and arp pulse.',
    voicing: 'Big slow-attack pads in octave 3-4 (triads with add9 / sus2 / maj7), the 8th-note bass on the root in octave 1-2, the arp on chord tones in octave 4-5.',
  },
  melody:
    'A singable, nostalgic lead in octave 4-5 with long notes and a rising pickup, ending phrases on the 3rd or 5th; a second, higher lead (or a solo) in the last chorus. The arpeggio runs in 16ths under it.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'retro'], writing: 'Beats 1 and 3 with a pickup in the second bar; drum-machine steady. Barely humanised: transform_notes groove "rock" at 15% timing, 30% velocity on kick, snare and hats.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'big', 'retro'], writing: 'Big snare on 2 and 4 (accent) with a long, bright reverb.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'retro'], writing: 'Steady 8ths with an accent pattern, a 16th at the end of 2 bars.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Tom', role: 'tom', sample: 'tom', tags: ['punchy', 'big'], writing: 'Descending tom fills (pitched notes from the tom sample) in the last bar of 8-bar phrases and into choruses.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['tight', 'retro'], range: [28, 52], writing: 'Pulsing 8ths on the chord root bouncing to the octave (root-root-octave-root), octave 1-2; ducks lightly under the kick.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Arp', role: 'arp', tags: ['bright', 'retro'], range: [55, 86], writing: '16th-note arpeggio of the chord tones in octave 4-5 with delay; from the intro on, filtered in verses.', chain: 'pluck' },
    { name: 'Pad', role: 'pad', tags: ['warm', 'wide', 'retro'], range: [45, 80], writing: 'Slow-attack polysynth chords, one per bar, the whole song.', chain: 'pad' },
    { name: 'Lead', role: 'lead', tags: ['retro', 'warm', 'bright'], range: [57, 91], writing: 'The singable chorus melody in octave 5 with chorus and delay; an octave-up variation in the last chorus.', chain: 'lead' },
  ],
  patterns: [
    {
      name: 'Drive Beat',
      for: ['verse', 'chorus'],
      kpn: `pattern "Drive Beat" bars=2 grid=16 key=Am
Kick  : x... .... x... .... | x... .... x.x. ....
Snare : .... X... .... X... | .... X... .... X...
Hat   : 6.4. 6.4. 6.4. 6.4. | 6.4. 6.4. 6.4. 6.45`,
      notes: 'Straight 80s drum-machine beat.',
    },
    {
      name: 'Tom Fill',
      for: ['verse', 'chorus'],
      kpn: `pattern "Tom Fill" bars=1 grid=16 key=Am
Kick  : x... .... x... ....
Snare : .... X... .... ....
Tom   : r:8 D4:2 C4:2 A3:2 F3:2`,
      notes: 'Last bar of an 8-bar phrase: a descending tom run into the next downbeat.',
    },
    {
      name: 'Pulse Bass + Pads',
      for: ['verse', 'chorus', 'bridge'],
      kpn: `pattern "Pulse Bass + Pads" bars=4 grid=16 key=Am
Bass {oct=2}: (A1:2 A1 A2 A1)*2 | (F1 F1 F2 F1)*2 | (C2 C2 C3 C2)*2 | (G1 G1 G2 G1)*2
Pad {oct=3 vel=72}: Am:16 | Fmaj7:16 | Cadd9:16 | G:16`,
      notes: 'i – ♭VI – ♭III – ♭VII: the octave-bouncing 8th bass under slow pads.',
    },
    {
      name: 'Arp',
      for: ['intro', 'chorus', 'bridge', 'outro'],
      kpn: `pattern "Arp" bars=4 grid=16 key=Am
Arp {vel=80}: (A4:1 C5 E5 A5)*4 | (F4 A4 C5 F5)*4 | (C5 E5 G5 C6)*4 | (G4 B4 D5 G5)*4`,
      notes: '16th chord-tone arp over the same progression; put the dotted-eighth delay on it.',
    },
    {
      name: 'Lead Melody',
      for: ['chorus', 'outro'],
      kpn: `pattern "Lead Melody" bars=4 grid=16 key=Am
Lead {vel=96}: r:4 E5:2 G5:2 A5:4 C6:4 | B5:8 G5:8 | r:4 E5:2 G5:2 C6:4 E6:4 | D6:8 B5:4 G5:4`,
      notes: 'Rising pickups into long notes, ending open on the ♭VII.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.35, parts: ['Pad', 'Arp'], notes: 'Pads and a filtered arp opening up.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.55, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Pad'], transitionIn: ['crash'], notes: 'Drive Beat and the pulse bass; Tom Fill at bar 16.' },
    { kind: 'chorus', label: 'Chorus 1', bars: 16, energy: 0.85, parts: ['Kick', 'Snare', 'Hat', 'Tom', 'Bass', 'Arp', 'Pad', 'Lead'], transitionIn: ['drum-fill', 'crash'] },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.6, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Arp', 'Pad'], transitionIn: ['downlifter'], notes: 'The arp stays, filtered.' },
    { kind: 'chorus', label: 'Chorus 2', bars: 16, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'Tom', 'Bass', 'Arp', 'Pad', 'Lead'], transitionIn: ['drum-fill', 'crash'] },
    { kind: 'bridge', label: 'Bridge', bars: 8, energy: 0.45, parts: ['Bass', 'Arp', 'Pad'], transitionIn: ['filter-sweep'], notes: 'Drums out; the arp and pads, the bass pulse building back.' },
    { kind: 'chorus', label: 'Chorus 3', bars: 16, energy: 1, parts: ['Kick', 'Snare', 'Hat', 'Tom', 'Bass', 'Arp', 'Pad', 'Lead'], transitionIn: ['drum-fill', 'crash'], notes: 'The lead an octave up or a solo variation.' },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.35, parts: ['Arp', 'Pad', 'Lead'], transitionIn: ['downlifter'], notes: 'Lead and arp over pads, fading.' },
  ],
  mix: {
    master: { tags: ['warm', 'wide', 'retro'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['punchy', 'big'] }],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['big', 'long'], from: [{ part: 'Snare', amount: 0.35 }, { part: 'Lead', amount: 0.25 }, { part: 'Pad', amount: 0.25 }, { part: 'Arp', amount: 0.2 }, { part: 'Tom', amount: 0.25 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['warm'], from: [{ part: 'Lead', amount: 0.25 }, { part: 'Arp', amount: 0.2 }] },
    ],
    levels:
      'Kick and snare lead, the snare big and wet; bass 3 dB under the kick; lead on top of the music, 2-3 dB under the snare; pads wide and warm behind; arp 4-6 dB under the lead; hats quiet.',
    notes: 'The big reverb on the snare is the sound (a long hall, low-cut). Chorus on pads and lead for width; tape warmth on the master; keep it glowing, not slammed (around -10 LUFS).',
  },
  transitions:
    'Tom fills and a crash into each chorus; a downlifter or reverb swell out of choruses; the bridge drops the drums and filters the arp, then builds back with a tom fill. Intros and outros fade the arp through a low-pass.',
  mistakes: [
    'Modern trap or EDM drums: synthwave uses a steady 80s beat, snare on 2 and 4 with big reverb, tom fills.',
    'A static bass: the 8th-note pulse bouncing between octaves drives the track.',
    'Dry, narrow synths: chorus, delay and reverb on pads, arp and lead are part of the style.',
    'A lead without a tune: write a singable melody with long notes, like a vocal line.',
    'Over-humanised drums: the drum machine should stay steady (a very light rock groove at most).',
    'Over-compressed: synthwave breathes; aim around -10 LUFS with a warm top.',
  ],
  groove: { template: 'rock', amount: 0.15, velocity: 0.3, parts: ['Kick', 'Snare', 'Hat'] },
  targets: {
    lufs: -10,
    truePeakDb: -1,
    bars: [80, 128],
    bands: { sub: [-6, 13], low: [0, 13], lowMid: [-6, 5], highMid: [-11, 1], high: [-16, 1] },
    contrastLu: [5, 13],
    minCorrelation: 0.3,
    maxStaticBars: 8,
    minHatVelocitySpread: 5,
  },
};
