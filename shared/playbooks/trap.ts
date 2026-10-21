import type { Playbook } from './types';

export const TRAP: Playbook = {
  id: 'trap',
  name: 'Trap',
  summary:
    'Dark, spacious half-time hip-hop at 130-160 bpm. A hard kick and a long, saturated 808 carry the low end and the bassline; the clap lands on beat 3 of every bar (the half-time backbeat); fast hi-hats move in 16ths with 1/32 rolls and triplet bursts. Over it sits a short minor melody (bell, pluck, piano or a breathy lead) that loops every 2-4 bars and leaves room for a vocal. Energy comes from the drums dropping in and out, not from more notes.',
  bpm: { min: 130, max: 160, typical: 140 },
  grid: 16,
  halfTime: true,
  swing: 0,
  keys: {
    modes: ['natural minor', 'harmonic minor', 'phrygian'],
    common: ['F#m', 'C#m', 'Gm', 'Am', 'Fm', 'Ebm'],
    notes: 'Harmonic minor (raised 7th) gives the eerie, cinematic leads; phrygian (flat 2nd) the darkest colour. Tune the 808 to the key first: its root should be the tonic.',
  },
  harmony: {
    progressions: ['i – VI (2 bars each)', 'i – i – VI – VII', 'i – iv – VI – V (harmonic-minor V)', 'i – ♭II (phrygian)', 'i only: one chord, the melody and 808 make the movement'],
    rhythm: 'One chord per bar or per 2 bars in 4- or 8-bar loops. Harmony is often implied by the melody and the 808 rather than played as full chords.',
    voicing: 'Sparse: minor triads or open fifths in octave 4-5 for bells and plucks, a high-passed pad in octave 3-4. Nothing chordal under 150 Hz: the 808 owns the low end.',
  },
  melody:
    'A 2- or 4-bar motif of 3-6 notes on ^1 ^3 ^4 ^5 ^6 of the minor key (plus the raised 7th in harmonic minor), repeated with a change in its last bar. Leave rests between phrases so the vocal has room. Bells and plucks sit in octave 5-6; a counter-melody an octave lower answers the main motif in the second and third hooks (call and response).',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'hard'], writing: 'Beat 1 of most bars plus 1-3 syncopated hits that line up with 808 note starts (steps 7, 8, 11, 15). Never on the clap (step 9). Velocity 110-127.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Clap', role: 'clap', sample: 'clap', tags: ['clap', 'bright'], writing: 'Beat 3 of every bar (step 9): the half-time backbeat. Layer it with the Snare; an occasional quiet ghost on step 16 leads into the next bar.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'punchy'], writing: 'Doubles the clap on step 9 about 3 dB lower for weight. In fills it plays 16th and 1/32 rolls ramping velocity from about 60 to 127 over the last beat or two of a phrase.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'bright', 'short'], writing: 'Steady 16ths (write it on a /32 line) with 1/32 rolls (xxxx) and /24 triplet bursts every 1-2 bars, mostly before the clap or at bar ends. Accent the beats, soften the off-16ths: velocity 70-127, never one flat value. Keep the kick and clap on the grid; only the hats get transform_notes groove "hiphop" at 25% timing, 40% velocity.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', tags: ['bright'], writing: 'One open hat per 1-2 bars on an offbeat (step 7 or 15), choked by the closed hat (same cut group). Quieter than the closed hats.', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'rim', tags: ['perc', 'short'], writing: 'A rim or snap on one or two off-steps per 2 bars (e.g. step 13) for bounce in the verses; well under the clap.', chain: 'drums', bus: 'Drum Bus' },
    { name: '808', role: '808', tags: ['distorted', 'long', 'glide'], range: [24, 45], writing: 'Mono with 60-120 ms glide. Each note starts with a kick: a long root on the downbeat, short repeats on the kick syncopations, and a ~ slide up to the 3rd, 5th or octave at the end of a phrase. Mostly octave 1 (F#1 is about 46 Hz).', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Bell', role: 'bell', tags: ['bright', 'dark'], range: [64, 96], writing: 'The main melodic loop: a 2-4 bar motif in octave 5-6 in 8ths and 16ths with rests, velocity 80-105. Present in the intro (filtered) and every hook.', chain: 'pluck' },
    { name: 'Pad', role: 'pad', tags: ['dark', 'evolving'], range: [45, 77], writing: 'Sustained minor chords, one per bar or two, high-passed and low in the mix. Fills the space in the intro, hooks and bridge; drop it in the verses.', chain: 'pad' },
    { name: 'Lead', role: 'lead', tags: ['dark', 'soft'], range: [57, 86], writing: 'Counter-melody for the later hooks: answers the Bell phrase with longer notes an octave lower (octave 4-5), entering after the Bell motif finishes.', chain: 'lead' },
  ],
  patterns: [
    {
      name: 'Hook Drums',
      for: ['hook'],
      kpn: `pattern "Hook Drums" bars=2 grid=16 key=F#m
Kick    : x... .... ..x. ..x. | x... ...x ..x. ....
Clap    : .... .... x... .... | .... .... x... ....
Snare   : .... .... 6... .... | .... .... 6... ..4.
Hat/32  : (8.5.7.5.)*3 6789 8.5. | (8.5.7.5.)*2 678989XX 8.5.7.5.
OpenHat : .... .... .... ..6. | .... .... .... ....`,
      notes: 'Main half-time groove. Hats are 16ths on a /32 line with a 32nd roll on beat 4 of bar 1 and under the clap in bar 2.',
    },
    {
      name: 'Verse Drums',
      for: ['verse'],
      kpn: `pattern "Verse Drums" bars=2 grid=16 key=F#m
Kick    : x... .... .... ..x. | x... .x.. .... ....
Clap    : .... .... x... .... | .... .... x... ....
Hat/24  : (7..5..)*3 567898 | (7..5..)*4
Perc    : .... .... .... x... | .... .... .... ..x.`,
      notes: 'Thinner verse groove: 8th-note hats on a triplet grid with one 16th-triplet burst, a rim for bounce, fewer kicks so the vocal breathes.',
    },
    {
      name: 'Hook Fill',
      for: ['hook', 'bridge'],
      kpn: `pattern "Hook Fill" bars=1 grid=16 key=F#m
Kick     : x... .... ..x. ....
Clap     : .... .... x... ....
Snare/32 : .... .... .... .... 5.5.6.6. 6789XXXX
Hat/32   : 8.5.7.5.8.5.7.5. .... .... .... ....`,
      notes: 'Last bar of every 8-bar phrase: the hats stop after beat 2 and a snare roll (16ths into 32nds) leads into the next phrase.',
    },
    {
      name: '808 Line',
      for: ['hook', 'verse'],
      kpn: `pattern "808 Line" bars=4 grid=16 key=F#m
808 {oct=1}: F#1:10 F#1:4 A1:2~ | F#2:7 C#2:3 E1:6 | D1:10 D1:4 A1:2~ | E1:7 E1:3 B1:4 C#2:2`,
      notes: 'i – i – VI – VII under the Hook Drums: every note starts on a kick, slides end bars 1 and 3. Set the 808 channel mono with glide on.',
    },
    {
      name: 'Hook Melody',
      for: ['hook', 'intro', 'outro'],
      kpn: `pattern "Hook Melody" bars=4 grid=16 key=F#m
Bell {vel=96}: C#6:2 A5:2 F#5:2 G#5:2 A5:4 r:4 | C#6:2 A5:2 F#5:2 E5:2 F#5:6 r:2 | D6:2 C#6:2 A5:2 F#5:2 G#5:4 r:4 | E5:2 F#5:2 A5:2 C#6:2 B5:4 A5:2 G#5:2
Pad {vel=70}: [F#3 A3 C#4]:32 | [D3 F#3 A3 C#4]:16 | [E3 G#3 B3]:16`,
      notes: 'Bell motif over i – VI(maj7) – VII; the same 4 bars repeat through the hook with the last bar varied the second time.',
    },
    {
      name: 'Counter Line',
      for: ['hook'],
      kpn: `pattern "Counter Line" bars=4 grid=16 key=F#m
Lead {vel=88}: r:8 C#5:4 B4:4 | A4:12 r:4 | r:8 F#4:4 A4:4 | G#4:12 r:4`,
      notes: 'Answers the Bell motif in the gaps (bars 1 and 3 second half); add it from Hook 2 on so the hooks grow.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 8, energy: 0.3, parts: ['Bell', 'Pad'], notes: 'Melody and pad alone, low-passed (Low-Pass Sweep chain) and opening over the 8 bars. Optionally the hats enter in bar 5.' },
    { kind: 'hook', label: 'Hook 1', bars: 16, energy: 0.9, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'OpenHat', '808', 'Bell', 'Pad'], transitionIn: ['reverse-cymbal'], notes: 'Everything lands on the downbeat. Hook Fill at bars 8 and 16.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.65, parts: ['Kick', 'Clap', 'Hat', 'Perc', '808', 'Bell'], transitionIn: ['drum-fill'], notes: 'Verse Drums, no pad; the Bell drops to every other 4 bars or gets filtered so a vocal fits. Change the hat pattern at bar 9.' },
    { kind: 'hook', label: 'Hook 2', bars: 16, energy: 0.9, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'OpenHat', '808', 'Bell', 'Pad', 'Lead'], transitionIn: ['silence', 'crash'], notes: 'Cut everything but the Bell for the last half bar of the verse, then hit the hook. The Lead counter-line joins.' },
    { kind: 'bridge', label: 'Bridge', bars: 8, energy: 0.45, parts: ['Bell', 'Pad', '808', 'Hat'], transitionIn: ['tape-stop'], notes: 'No kick or clap: the 808 holds long roots, hats at half density, the melody filtered. Builds tension for the last hook.' },
    { kind: 'hook', label: 'Hook 3', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Snare', 'Hat', 'OpenHat', 'Perc', '808', 'Bell', 'Pad', 'Lead'], transitionIn: ['drum-fill', 'impact'], notes: 'The fullest section: everything plays, extra hat rolls, the 808 slides more.' },
    { kind: 'outro', label: 'Outro', bars: 8, energy: 0.3, parts: ['Bell', 'Pad', 'Hat'], transitionIn: ['filter-sweep'], notes: 'Drums out except hats for 4 bars, then the melody alone low-passing to the end.' },
  ],
  mix: {
    master: { tags: ['loud', 'punchy'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['punchy'] }],
    sends: [
      { name: 'Reverb', chain: 'reverbSend', tags: ['big', 'long'], from: [{ part: 'Bell', amount: 0.25 }, { part: 'Pad', amount: 0.3 }, { part: 'Lead', amount: 0.25 }, { part: 'Clap', amount: 0.12 }] },
      { name: 'Delay', chain: 'delaySend', tags: ['rhythmic'], from: [{ part: 'Bell', amount: 0.2 }, { part: 'Lead', amount: 0.18 }] },
    ],
    levels:
      'Kick and 808 loudest and about equal (the 808 ducks 3-6 dB under each kick); clap 1-2 dB under the kick with the snare layer 3 dB under the clap; closed hats 8-10 dB under the clap, open hat and perc lower still; the Bell 4-6 dB under the clap and clearly audible; Lead 2 dB under the Bell; Pad 10-12 dB under, felt more than heard. Keep about 6 dB of headroom before the master chain.',
    notes: 'Kick, Clap, Snare, Hat, OpenHat and Perc route to the Drum Bus. The 808 stays off it, on its own 808 chain with a sidechain duck keyed from the Kick. No reverb on the kick or 808, everything under 150 Hz mono, high-pass the Bell, Pad and Lead above 150-200 Hz.',
  },
  transitions:
    'Hooks land on a downbeat with kick, 808 and a crash or reverse cymbal. Before a hook, cut everything except the melody for the last half bar (silence) or mute the 808 for one beat so the drop of the low end hits harder. End every 8-bar phrase with a variation: a hat roll, the Hook Fill or a missing kick. The intro and outro use a low-pass sweep on the melody; the bridge drops the kick and clap and lets the 808 ring.',
  mistakes: [
    'Clap on beats 2 and 4 at 140 bpm sounds like a fast pop beat: in trap the backbeat is half-time, one clap on beat 3 (step 9) of every bar.',
    'Hats at one velocity on a plain 16th grid sound like a metronome: vary velocity by 30+, add a 1/32 roll or a 1/24 triplet burst every 1-2 bars, drop hats for a beat before big moments, and run a light hiphop groove on the hats only (the kick and clap stay tight).',
    'Kick and 808 fighting: every 808 note should start with a kick (or sit in a gap between kicks) and duck 3-6 dB under it; two long low notes on top of each other turn to mud.',
    '808 off-key or wandering: it follows the chord roots (mostly the tonic) and slides only at phrase ends. Check its notes are in the key and the sample is tuned.',
    'A clean, quiet 808 disappears on phone speakers: saturate it so its harmonics around 100-400 Hz carry the bassline.',
    'Busy, endless melodies: a trap melody is a 2-4 bar motif with rests, repeated with small changes; the space is where the vocal goes.',
    'Full drums from bar 1: the intro is the melody alone (filtered) so the first hook hits.',
    'The same 2-bar loop for 16 bars: change the hats or add a fill every 8 bars, mute the 808 for a beat before each hook, add the counter-line in later hooks.',
    'Reverb on the kick or 808, or pads and keys under 150 Hz: keep the low end mono and dry and high-pass everything that is not kick or 808.',
  ],
  groove: { template: 'hiphop', amount: 0.25, velocity: 0.4, parts: ['Hat', 'OpenHat'] },
  targets: {
    lufs: -8,
    truePeakDb: -1,
    bars: [64, 112],
    bands: { sub: [0, 16], low: [0, 14], lowMid: [-8, 4], highMid: [-12, 2], high: [-18, 1] },
    contrastLu: [6, 16],
    minCorrelation: 0.3,
    maxStaticBars: 8,
    minHatVelocitySpread: 8,
  },
};
