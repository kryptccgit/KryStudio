// Boom bap: swung, sample-style 90s hip-hop with a hard kick and snare, dusty keys and a horn hook.
import type { Playbook } from './types';

export const BOOM_BAP: Playbook = {
  id: 'boom-bap',
  name: 'Boom bap',
  summary:
    'Head-nod hip-hop at 84-98 bpm with a heavy swing. A hard, slightly dirty kick on 1 and around beat 3, a cracking snare on 2 and 4, and swung 8th or 16th hats with ghost notes make the groove; a dusty, sampled-sounding loop of jazzy minor 7th chords and a warm bass that follows the kick carry the music. The hook adds a short horn or string stab phrase. Drums are loud and up front; everything else sounds like it came off a record.',
  bpm: { min: 84, max: 98, typical: 90 },
  grid: 16,
  swing: 35,
  keys: {
    modes: ['natural minor', 'dorian', 'minor with 7ths and 9ths'],
    common: ['Dm', 'Am', 'Gm', 'Cm', 'Em', 'Fm'],
    notes: 'Dorian (major 6th) gives the soulful jazz colour; keep chords as m7 / m9 and maj7 for the sampled-soul sound.',
  },
  harmony: {
    progressions: ['i9 – iv9 (2 bars each)', 'i7 – ♭VImaj7', 'ii7 – V7 – Imaj7 (jazz turnaround, in major)', 'i – ♭VII – ♭VI – V (descending soul loop)'],
    rhythm: '1-2 chords per 2-bar loop; the same 2- or 4-bar loop runs under the whole verse. Chords are played short and chopped, like sample hits.',
    voicing: 'm7 / m9 / maj7 voicings in octave 3-4 on electric piano or keys, sometimes chopped into stabs; the bass takes the root an octave or two below.',
  },
  melody:
    'Very little lead melody: the loop is the hook. A 1-2 bar horn or string stab phrase answers in the hook, built on the minor pentatonic with the 9th, played tight to the swing. Leave the midrange for the rapper.',
  parts: [
    { name: 'Kick', role: 'kick', sample: 'kick', tags: ['kick', 'punchy', 'vintage'], writing: 'Beat 1 and one or two hits around beat 3 (steps 11, 14) per bar, varying between the two bars; slightly behind the beat. Velocity 100-127.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Snare', role: 'snare', sample: 'snare', tags: ['snare', 'punchy', 'vintage'], writing: 'Hard snare on 2 and 4 (steps 5 and 13), with a ghost note before the second backbeat every couple of bars. Never moves.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Hat', role: 'hat', sample: 'hat', tags: ['hat', 'vintage'], writing: 'Swung 8ths with off-8th 16ths here and there; strong accent on the beat, the offbeats 30-40 velocity lower. After writing, apply transform_notes groove "hiphop" (60% timing, 60% velocity) to every drum part, then the same at 40% to Bass and Keys so they sit in the pocket.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'OpenHat', role: 'openhat', sample: 'openhat', writing: 'An open hat at the end of bar 2 or 4, choked by the closed hat.', bus: 'Drum Bus' },
    { name: 'Perc', role: 'perc', sample: 'shaker', tags: ['perc', 'organic'], writing: 'Tambourine or shaker on the offbeats of 2 and 4 in the hooks only; low.', chain: 'drums', bus: 'Drum Bus' },
    { name: 'Bass', role: 'bass', tags: ['warm', 'round', 'vintage'], range: [28, 52], writing: 'Warm, short bass notes locked to the kick: root on 1, fifth or octave on the kick syncopations, a passing note into the next chord. Octave 1-2.', chain: 'bass', duckUnder: 'Kick' },
    { name: 'Keys', role: 'keys', tags: ['warm', 'vintage', 'lofi'], range: [48, 84], writing: 'The loop: m9 / maj7 chords played short and chopped in a 2-bar rhythm, soft velocity (70-85), slightly late. Runs through the verses.', chain: 'character' },
    { name: 'Horns', role: 'brass', tags: ['vintage', 'warm'], range: [55, 86], writing: 'Hook only: a tight 1-2 bar stab phrase (short notes, pentatonic) answering the vocal, panned slightly.', chain: 'lead' },
  ],
  patterns: [
    {
      name: 'Boom Bap Main',
      for: ['verse'],
      kpn: `pattern "Boom Bap Main" bars=2 grid=16 key=Dm
Kick    : x... .... ..x. .x.. | x... ..x. .... ....
Snare   : .... x... .... x... | .... x... .... x..o
Hat     : 7.4. 7.4. 7.4. 7.5. | 7.4. 7.4. 7.4. 7...
OpenHat : .... .... .... .... | .... .... .... ..4.`,
      notes: 'The verse groove; set swing around 35 so the off-16ths lean back.',
    },
    {
      name: 'Boom Bap Hook',
      for: ['hook'],
      kpn: `pattern "Boom Bap Hook" bars=2 grid=16 key=Dm
Kick    : x... ..x. ..x. .... | x..x .... ..x. .x..
Snare   : .... x... .... x... | .... x..o .... x...
Hat     : 7.4. 7.4o 7.4. 7.4. | 7.4. 7.4. 7.4. 7.4.
Perc    : .... ..x. .... ..x. | .... ..x. .... ..x.`,
      notes: 'Busier kicks, a ghost snare, tambourine on the offbeats of 2 and 4.',
    },
    {
      name: 'Boom Bap Fill',
      for: ['verse', 'hook'],
      kpn: `pattern "Boom Bap Fill" bars=1 grid=16 key=Dm
Kick  : x... .... x.x. ....
Snare : .... x... ..o. 5678
Hat   : 7.4. 7.4. 7... ....`,
      notes: 'Last bar of an 8-bar phrase: hats stop, the snare walks into the next downbeat.',
    },
    {
      name: 'Loop',
      for: ['verse', 'hook', 'intro', 'bridge'],
      kpn: `pattern "Loop" bars=4 grid=16 key=Dm
Keys {oct=3 vel=78}: Dm9:6 Dm9:2 r:8 | r:4 Dm9:4 r:2 Dm9:6 | Gm9:6 Gm9:2 r:8 | r:4 Gm9:4 r:2 Bbmaj7:6
Bass {oct=2}: D2:6 r:4 D2:3 A1:3 | D2:6 F2:4 r:2 C2:4 | G1:6 r:4 G1:3 D2:3 | G1:6 Bb1:4 r:2 A1:4`,
      notes: 'i9 – iv9 chopped loop; the bass hits with the kicks of Boom Bap Main and walks up to the next chord.',
    },
    {
      name: 'Horn Hook',
      for: ['hook'],
      kpn: `pattern "Horn Hook" bars=2 grid=16 key=Dm
Horns {vel=96}: r:2 D5:2 F5:2 r:2 A5:4 G5:2 F5:2 | E5:2 r:2 D5:4 r:8`,
      notes: 'A call that leaves bar 2 open for the vocal answer.',
    },
  ],
  arrangement: [
    { kind: 'intro', label: 'Intro', bars: 4, energy: 0.3, parts: ['Keys', 'Perc'], notes: 'The loop alone, filtered like a record, with a tambourine.' },
    { kind: 'verse', label: 'Verse 1', bars: 16, energy: 0.65, parts: ['Kick', 'Snare', 'Hat', 'Bass', 'Keys'], transitionIn: ['drum-fill'], notes: 'Boom Bap Main; Boom Bap Fill at bars 8 and 16.' },
    { kind: 'hook', label: 'Hook 1', bars: 8, energy: 0.85, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Keys', 'Horns'], transitionIn: ['drum-fill'], notes: 'Boom Bap Hook and the horn phrase.' },
    { kind: 'verse', label: 'Verse 2', bars: 16, energy: 0.7, parts: ['Kick', 'Snare', 'Hat', 'Perc', 'Bass', 'Keys'], transitionIn: ['silence'], notes: 'Drop the drums for the first bar (just keys), then back in; vary the kick at bar 9.' },
    { kind: 'hook', label: 'Hook 2', bars: 8, energy: 0.9, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Keys', 'Horns'], transitionIn: ['drum-fill', 'crash'] },
    { kind: 'bridge', label: 'Bridge', bars: 8, energy: 0.45, parts: ['Hat', 'Bass', 'Keys'], transitionIn: ['silence'], notes: 'Kick and snare out: hats, bass and the loop only, a breather before the last hook.' },
    { kind: 'hook', label: 'Hook 3', bars: 8, energy: 0.95, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Keys', 'Horns'], transitionIn: ['drum-fill'], notes: 'Horns double an octave up on the repeat.' },
    { kind: 'outro', label: 'Outro', bars: 4, energy: 0.3, parts: ['Keys', 'Perc'], transitionIn: ['filter-sweep'], notes: 'Loop alone again, fading through the low-pass.' },
  ],
  mix: {
    master: { tags: ['punchy', 'warm'] },
    buses: [{ name: 'Drum Bus', chain: 'drumBus', tags: ['vintage', 'warm'] }],
    sends: [
      { name: 'Room', chain: 'reverbSend', tags: ['short', 'vintage'], from: [{ part: 'Snare', amount: 0.2 }, { part: 'Horns', amount: 0.2 }, { part: 'Keys', amount: 0.15 }] },
      { name: 'Echo', chain: 'delaySend', tags: ['warm', 'vintage'], from: [{ part: 'Horns', amount: 0.15 }] },
    ],
    levels:
      'Kick and snare loudest and equal; bass 2-3 dB under the kick, ducking a little; hats 6-8 dB under the snare; keys loop 6-8 dB under the snare (it should sound like a sample under the drums); horns 3-4 dB under the snare in the hooks; tambourine low.',
    notes: 'All drums to the Drum Bus with the dusty tape chain. Keys get the lofi tape character chain (rolled-off top) so they sit behind the drums. Short room reverb only, no big halls.',
  },
  transitions:
    'Boom bap transitions are drum moves: a one-bar fill at the end of each 8-bar phrase, the drums dropping out for one bar at the start of a verse (silence with the loop only), or the snare walking into the hook. A crash on the hook downbeat is optional. The intro and outro are the loop alone through a low-pass.',
  mistakes: [
    'Straight, robotic drums: boom bap needs swing (25-45), hats with clearly lower off-beat velocities, and a real-drummer feel (transform_notes groove "hiphop" at 50-70%) on the drums, bass and keys.',
    'A soft or buried snare: the snare cracks on 2 and 4 at the same level as the kick.',
    'Clean, bright, wide keys: the loop should sound sampled and dusty (rolled-off top, tape saturation), sitting behind the drums.',
    'A bass that ignores the kick: bass notes start with the kick hits and stay short.',
    'Too much melody: the loop is the music; a short horn or string phrase in the hook is enough.',
    'Big washy reverbs: use a short room; boom bap is dry and in your face.',
    'Never changing for 16 bars: add a fill or drop the kick every 8 bars, and swap the hat pattern in the hooks.',
  ],
  groove: { template: 'hiphop', amount: 0.6, velocity: 0.6, parts: ['Kick', 'Snare', 'Hat', 'OpenHat', 'Perc', 'Bass', 'Keys'] },
  targets: {
    lufs: -9,
    truePeakDb: -1,
    bars: [56, 96],
    bands: { sub: [-6, 14], low: [0, 14], lowMid: [-6, 5], highMid: [-12, 1], high: [-20, -1] },
    contrastLu: [4, 13],
    minCorrelation: 0.45,
    maxStaticBars: 8,
    minHatVelocitySpread: 8,
  },
};
