// Retro Game FX: 8-bit coins, jumps, power-ups, blips, lasers and explosions, chip-style alarms and falls, plus
// arcade-announcer voice shots. research/14 §5 has each source's licence evidence.
//   junkala  "The Essential Retro Video Game Sound Effects Collection [512 sounds]" by Juhani Junkala (SubspaceAudio),
//            CC0 on opengameart.org/content/512-sound-effects-8-bit-style and in its INFO.txt. 44.1 kHz 16-bit mono WAV.
//   kdigital Kenney "Digital Audio" (CC0, kenney.nl/assets/digital-audio + License.txt in the ZIP). Ogg Vorbis.
//   kfighter Kenney "Voiceover Pack: Fighter" (CC0, kenney.nl/assets/voiceover-pack-fighter + License.txt).
//   kvoice   Kenney "Voiceover Pack" (CC0, kenney.nl/assets/voiceover-pack + License.txt).
// Left out: death screams, guns, footsteps/ladders/vehicles (not musical), byte-identical or near-identical takes.
import type { GenreId } from '@shared/sounds/genres';
import { sample, type SampleDef, type SamplePackSpec } from '../lib';

const J = 'The Essential Retro Video Game Sound Effects Collection [512 sounds] By Juhani Junkala/';
const RETRO: GenreId[] = ['synthwave', 'phonk', 'trap', 'future-bass', 'edm', 'dnb'];
const GAME_TRAP: GenreId[] = ['trap', 'phonk', 'drill', 'synthwave', 'future-bass'];
const HYPE: GenreId[] = ['trap', 'phonk', 'drill', 'edm', 'dubstep', 'dnb'];

const j = (dir: string, file: string, name: string, kind: SampleDef['kind'], tags: string[], genres: GenreId[] = RETRO) =>
  sample(`8bit/${dir.split('/').pop()!.toLowerCase().replace(/[^a-z]+/g, '-')}`, 'junkala', `${J}${dir}/${file}`, name, kind, ['8-bit', 'retro', ...tags], genres);
const series = (dir: string, stem: string, nums: number[], name: string, kind: SampleDef['kind'], tags: string[], genres?: GenreId[]) =>
  nums.map((n, i) => j(dir, `${stem}${n}.wav`, `${name} ${i + 1}`, kind, tags, genres));

const kd = (file: string, name: string, kind: SampleDef['kind'], tags: string[]) =>
  sample('synth-fx', 'kdigital', `Audio/${file}`, name, kind, ['synth', ...tags], RETRO);
const kf = (file: string, name: string, tags: string[] = []) => sample('voice', 'kfighter', `Audio/${file}`, name, 'vox', ['voice', 'announcer', ...tags], HYPE);
const kv = (file: string, name: string, tags: string[] = []) => sample('voice', 'kvoice', file, name, 'vox', ['voice', ...tags], HYPE);

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const RETRO_GAME: SamplePackSpec = {
  id: 'retro-game',
  type: 'samples',
  sources: {
    junkala: { type: 'zip', url: 'https://opengameart.org/sites/default/files/The%20Essential%20Retro%20Video%20Game%20Sound%20Effects%20Collection%20%5B512%20sounds%5D.zip', path: 'downloads/retro-512.zip' },
    kdigital: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip', path: 'downloads/digital-audio.zip' },
    kfighter: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/voiceover-pack-fighter/6ceb77c6f1-1677589837/kenney_voiceover-pack-fighter.zip', path: 'downloads/voiceover-fighter.zip' },
    kvoice: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/voiceover-pack/3f7f168698-1677589897/kenney_voiceover-pack.zip', path: 'downloads/voiceover.zip' },
  },
  samples: [
    // ── Junkala: pickups and rewards
    ...series('General Sounds/Coins', 'sfx_coin_single', range(1, 6), 'Coin Pickup', 'retro', ['coin', 'short', 'bright']),
    ...series('General Sounds/Coins', 'sfx_coin_double', range(1, 7), 'Double Coin', 'retro', ['coin', 'short', 'bright']),
    ...series('General Sounds/Coins', 'sfx_coin_cluster', [1, 2, 3, 4, 7, 8, 9], 'Coin Shower', 'retro', ['coin', 'bright']),
    ...series('General Sounds/Positive Sounds', 'sfx_sounds_powerup', range(1, 18), 'Power Up', 'retro', ['power-up', 'rising', 'bright']),
    ...series('General Sounds/Fanfares', 'sfx_sounds_fanfare', range(1, 3), 'Chip Fanfare', 'retro', ['fanfare', 'win', 'bright']),
    j('General Sounds/Weird Sounds', 'sfx_sound_bling.wav', 'Chip Bling', 'retro', ['bright', 'short']),
    // ── jumps, falls, portals (pitch sweeps: good little risers / drops for game-flavoured beats)
    ...series('Movement/Jumping and Landing', 'sfx_movement_jump', range(1, 20), 'Chip Jump', 'retro', ['jump', 'rising', 'short']),
    ...series('Movement/Jumping and Landing', 'sfx_movement_jump', [9, 11, 13, 15, 17, 19].map((n) => n), 'Chip Landing', 'retro', ['landing', 'short']).map((s, i) => ({
      ...s,
      src: `${J}Movement/Jumping and Landing/sfx_movement_jump${[9, 11, 13, 15, 17, 19][i]}_landing.wav`,
    })),
    ...series('Movement/Falling Sounds', 'sfx_sounds_falling', range(1, 12), 'Chip Fall', 'retro', ['falling', 'downlifter']),
    ...series('Movement/Portals and Transitions', 'sfx_movement_portal', range(1, 6), 'Chip Portal', 'retro', ['transition', 'sweep']),
    j('General Sounds/Weird Sounds', 'sfx_sound_poweron.wav', 'Chip Power On', 'retro', ['rising', 'transition']),
    j('General Sounds/Weird Sounds', 'sfx_sound_shutdown1.wav', 'Chip Power Down 1', 'retro', ['falling', 'transition']),
    j('General Sounds/Weird Sounds', 'sfx_sound_shutdown2.wav', 'Chip Power Down 2', 'retro', ['falling', 'transition']),
    j('General Sounds/Weird Sounds', 'sfx_sound_vaporizing.wav', 'Chip Vaporize', 'zap', ['falling', 'noise']),
    j('General Sounds/Weird Sounds', 'sfx_sound_depressurizing.wav', 'Chip Air Release', 'retro', ['noise', 'long']),
    // ── blips, menus, buttons
    ...series('General Sounds/Simple Bleeps', 'sfx_sounds_Blip', range(1, 11), 'Chip Blip', 'retro', ['blip', 'short']),
    ...series('General Sounds/Menu Sounds', 'sfx_menu_move', range(1, 5), 'Menu Move', 'retro', ['blip', 'short']),
    ...series('General Sounds/Menu Sounds', 'sfx_menu_select', range(1, 5), 'Menu Select', 'retro', ['blip', 'short']),
    ...series('General Sounds/Buttons', 'sfx_sounds_button', range(1, 14), 'Chip Button', 'retro', ['blip', 'short']),
    ...series('General Sounds/High Pitched Sounds', 'sfx_sounds_high', range(1, 7), 'High Chirp', 'retro', ['bright', 'short']),
    ...series('General Sounds/Interactions', 'sfx_sounds_interaction', range(1, 26), 'Chip Interaction', 'retro', ['blip']),
    ...series('General Sounds/Neutral Sounds', 'sfx_sound_neutral', range(1, 11), 'Chip Tone', 'retro', ['blip']),
    ...range(1, 7).flatMap((n) => [
      j('General Sounds/Pause Sounds', `sfx_sounds_pause${n}_in.wav`, `Pause In ${n}`, 'retro', ['blip', 'short']),
      ...(n === 7 ? [] : [j('General Sounds/Pause Sounds', `sfx_sounds_pause${n}_out.wav`, `Pause Out ${n}`, 'retro', ['blip', 'short'])]),
    ]),
    // ── hits, errors, damage
    ...series('General Sounds/Impacts', 'sfx_sounds_impact', range(1, 15), 'Chip Hit', 'retro', ['hit', 'short', 'punchy']),
    ...series('General Sounds/Simple Damage Sounds', 'sfx_damage_hit', range(1, 10), 'Chip Damage', 'retro', ['hit', 'short']),
    ...series('General Sounds/Negative Sounds', 'sfx_sounds_error', range(1, 15), 'Chip Error', 'retro', ['error', 'short']),
    ...series('General Sounds/Negative Sounds', 'sfx_sounds_damage', range(1, 3), 'Chip Hurt', 'retro', ['hit', 'short']),
    ...series('General Sounds/Negative Sounds', 'sfx_sounds_negative', range(1, 2), 'Chip Fail', 'retro', ['error', 'falling']),
    // ── alarms (looping chip alarms; not tempo-synced)
    ...series('General Sounds/Alarms/Alarms', 'sfx_alarm_loop', range(1, 8), 'Chip Alarm Loop', 'retro', ['alarm', 'loop']),
    ...series('General Sounds/Alarms/Low health Alarms', 'sfx_lowhealth_alarmloop', [1, 2, 3, 5, 6, 7], 'Low Health Beep Loop', 'retro', ['alarm', 'loop']),
    j('General Sounds/Weird Sounds', 'sfx_sound_nagger1.wav', 'Chip Nag 1', 'retro', ['alarm']),
    j('General Sounds/Weird Sounds', 'sfx_sound_nagger2.wav', 'Chip Nag 2', 'retro', ['alarm']),
    j('General Sounds/Weird Sounds', 'sfx_sound_noise.wav', 'Chip Noise Burst', 'noise', ['noise', 'short']),
    j('General Sounds/Weird Sounds', 'sfx_sound_refereewhistle.wav', 'Chip Whistle', 'retro', ['whistle']),
    // ── lasers and explosions
    ...series('Weapons/Lasers', 'sfx_wpn_laser', range(1, 12), 'Chip Laser', 'zap', ['laser', 'short'], GAME_TRAP),
    j('Weapons/Grenade Whistles', 'sfx_wpn_grenadewhistle1.wav', 'Chip Falling Whistle 1', 'downlifter', ['falling', 'whistle']),
    j('Weapons/Grenade Whistles', 'sfx_wpn_grenadewhistle2.wav', 'Chip Falling Whistle 2', 'downlifter', ['falling', 'whistle']),
    j('Weapons/Grenade Whistles', 'sfx_wpn_missilelaunch.wav', 'Chip Launch', 'whoosh', ['rising', 'noise']),
    ...series('Explosions/Shortest', 'sfx_exp_shortest_hard', range(1, 10), 'Chip Blast Tiny', 'impact', ['explosion', 'short', 'hard']),
    ...series('Explosions/Short', 'sfx_exp_short_hard', range(1, 17), 'Chip Blast Short', 'impact', ['explosion', 'hard']),
    ...series('Explosions/Short', 'sfx_exp_short_soft', range(1, 12), 'Chip Thump', 'impact', ['explosion', 'soft']),
    ...series('Explosions/Medium Length', 'sfx_exp_medium', range(1, 13), 'Chip Explosion', 'impact', ['explosion', 'big']),
    ...series('Explosions/Long', 'sfx_exp_long', range(1, 5), 'Chip Explosion Long', 'impact', ['explosion', 'big', 'long']),
    ...series('Explosions/Double', 'sfx_exp_double', range(1, 3), 'Chip Double Blast', 'impact', ['explosion', 'big']),
    ...series('Explosions/Clusters', 'sfx_exp_cluster', range(1, 11), 'Chip Blast Cluster', 'impact', ['explosion', 'big']),
    ...series('Explosions/Odd', 'sfx_exp_odd', range(1, 7), 'Chip Odd Blast', 'impact', ['explosion', 'gritty']),
    ...series('Explosions/Various', 'sfx_exp_various', range(1, 7), 'Chip Crash', 'impact', ['explosion']),

    // ── Kenney Digital Audio: synth zaps, phasers and power-ups
    ...range(1, 9).map((n) => kd(`laser${n}.ogg`, `Synth Laser ${n}`, 'zap', ['laser', 'short'])),
    ...range(1, 7).map((n) => kd(`phaserUp${n}.ogg`, `Phaser Up ${n}`, 'zap', ['rising', 'short'])),
    ...range(1, 3).map((n) => kd(`phaserDown${n}.ogg`, `Phaser Down ${n}`, 'zap', ['falling', 'short'])),
    ...range(3, 5).map((n, i) => kd(`phaseJump${n}.ogg`, `Phase Jump ${i + 1}`, 'zap', ['short'])),
    ...[3, 4, 5, 6, 8, 9, 10].map((n, i) => kd(`powerUp${n}.ogg`, `Synth Power Up ${i + 1}`, 'retro', ['power-up', 'rising'])),
    ...range(1, 5).map((n) => kd(`spaceTrash${n}.ogg`, `Space Debris ${n}`, 'zap', ['noise', 'gritty'])),
    kd('zap1.ogg', 'Synth Zap 1', 'zap', ['short']),
    kd('zap2.ogg', 'Synth Zap 2', 'zap', ['short']),
    kd('zapThreeToneUp.ogg', 'Three Tone Zap Up', 'zap', ['rising']),
    kd('zapThreeToneDown.ogg', 'Three Tone Zap Down', 'zap', ['falling']),
    kd('zapTwoTone.ogg', 'Two Tone Zap 1', 'zap', []),
    kd('zapTwoTone2.ogg', 'Two Tone Zap 2', 'zap', []),
    kd('pepSound1.ogg', 'Pep Blip 1', 'retro', ['blip', 'short']),
    kd('pepSound2.ogg', 'Pep Blip 2', 'retro', ['blip', 'short']),
    kd('pepSound3.ogg', 'Pep Blip 3', 'retro', ['blip', 'short']),
    kd('pepSound5.ogg', 'Pep Blip 4', 'retro', ['blip', 'short']),
    kd('threeTone2.ogg', 'Three Tone Chime', 'retro', ['blip']),
    kd('twoTone2.ogg', 'Two Tone Chime', 'retro', ['blip']),

    // ── Kenney voiceovers: arcade-announcer shots (in our words: what is said)
    kf('fight.ogg', 'Announcer Fight', ['hype']),
    kf('ready.ogg', 'Announcer Ready', ['hype']),
    kf('begin.ogg', 'Announcer Begin', ['hype']),
    kf('round_1.ogg', 'Announcer Round One'),
    kf('round_2.ogg', 'Announcer Round Two'),
    kf('round_3.ogg', 'Announcer Round Three'),
    kf('final_round.ogg', 'Announcer Final Round', ['hype']),
    kf('winner.ogg', 'Announcer Winner', ['hype']),
    kf('you_win.ogg', 'Announcer You Win'),
    kf('you_lose.ogg', 'Announcer You Lose'),
    kf('game_over.ogg', 'Announcer Game Over'),
    kf('combo.ogg', 'Announcer Combo', ['hype']),
    kf('multi_kill.ogg', 'Announcer Multi Hit', ['hype']),
    kf('sudden_death.ogg', 'Announcer Sudden Death'),
    kf('prepare_yourself.ogg', 'Announcer Prepare Yourself', ['hype']),
    kf('time.ogg', 'Announcer Time'),
    ...range(1, 5).map((n) => kf(`${n}.ogg`, `Announcer Count ${n}`, ['count'])),
    kv('Male/go.ogg', 'Voice Go', ['hype']),
    kv('Male/ready.ogg', 'Voice Ready'),
    kv('Male/set.ogg', 'Voice Set'),
    kv('Male/level_up.ogg', 'Voice Level Up', ['hype']),
    kv('Male/hurry_up.ogg', 'Voice Hurry Up'),
    kv('Male/congratulations.ogg', 'Voice Congratulations'),
    kv('Female/go.ogg', 'Voice Go Female', ['hype']),
    kv('Female/ready.ogg', 'Voice Ready Female'),
    kv('Female/level_up.ogg', 'Voice Level Up Female', ['hype']),
    kv('Female/power_up.ogg', 'Voice Power Up Female', ['hype']),
  ],
};
