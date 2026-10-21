// Percussion Extras: recorded hand and world percussion for grooves and top loops: claps, shakers, tambourines,
// cajon, bongos, congas, darbuka, frame drum, claves, woodblock, cowbells, agogo, log drum, guiro, cabasa, brake
// drum, sleigh bells, a vibraslap, a slapstick, whistles and concert snare rolls.
// Source: the Versilian Community Sample Library (VCSL) by Versilian Studios, CC0 1.0 (LICENSE at the pinned commit,
// the same commit the Keys & Mallets pack uses). Recorded at natural level and shipped as recorded (we can't
// normalise files we don't host): the softest velocity layers (peaks below about -36 dBFS) are left out, and
// `peakDb` lets the app set each one's level.
import type { GenreId } from '@shared/sounds/genres';
import { sample, type SampleDef } from '../lib';
import type { SamplePackSpec } from '../lib';

export const VCSL_SHA = 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e';
export const VCSL_SOURCE = {
  type: 'github' as const,
  base: `https://raw.githubusercontent.com/sgossner/VCSL/${VCSL_SHA}/`,
  mirrors: [`https://cdn.jsdelivr.net/gh/sgossner/VCSL@${VCSL_SHA}/`],
};

const WORLD: GenreId[] = ['afrobeats', 'reggaeton', 'house', 'deep-house', 'tech-house', 'lofi', 'boom-bap', 'rnb', 'pop'];
const GROOVE: GenreId[] = ['house', 'deep-house', 'tech-house', 'afrobeats', 'reggaeton', 'pop', 'rnb', 'lofi', 'boom-bap', 'trap'];

const SI = 'Idiophones/Struck Idiophones/';
const SM = 'Membranophones/Struck Membranophones/';

type Kind = SampleDef['kind'];
/** files[i] → "<name> <i+1>" (just "<name>" for a single file). */
const set = (folder: string, dir: string, files: string[], name: string, kind: Kind, tags: string[], genres: GenreId[] = WORLD) =>
  files.map((f, i) => sample(folder, 'vcsl', `${dir}${f}`, files.length > 1 ? `${name} ${i + 1}` : name, kind, ['organic', ...tags], genres));

export const PERC_EXTRAS: SamplePackSpec = {
  id: 'perc-extras',
  type: 'samples',
  sources: { vcsl: VCSL_SOURCE },
  samples: [
    // claps and shakers
    ...set('claps', `${SI}Claps/`, ['Clap_rr1.wav', 'Clap_rr2.wav', 'Clap_rr3.wav', 'Clap_rr4.wav', 'Clap_rr5.wav', 'Clap_rr6.wav'], 'Group Clap', 'clap', ['big', 'wide'], GROOVE),
    ...set('claps', `${SI}Claps/`, ['SoloClap_vl2.wav', 'SoloClap_vl3.wav', 'SoloClap_vl4.wav'], 'Solo Clap', 'clap', ['short'], GROOVE),
    ...set('shakers', `${SI}Shaker, Small/`, ['Mid_ShakerHighFaster_Up_rr1.wav', 'Mid_ShakerHighFaster_Up_rr2.wav', 'Mid_ShakerLowFaster_Up_rr1.wav', 'Mid_ShakerLowFaster_Up_rr2.wav'], 'Shaker Tick', 'shaker', ['short'], GROOVE),
    ...set('shakers', `${SI}Shaker, Small/`, ['Mid_ShakerDouble_Down_rr1.wav', 'Mid_ShakerDouble_Down_rr2.wav'], 'Shaker Double', 'shaker', ['short'], GROOVE),
    ...set('shakers', `${SI}Shaker, Small/`, ['Mid_Shaker_Slap_rr1.wav', 'Mid_Shaker_Slap_rr2.wav'], 'Shaker Slap', 'shaker', ['short'], GROOVE),
    ...set('shakers', `${SI}Shaker, Small/`, ['Mid_Shaker_Roll_Fast_rr1.wav', 'Mid_Shaker_Roll_Fast_rr2.wav'], 'Shaker Roll', 'shaker', ['roll'], GROOVE),
    ...set('shakers', `${SI}Shaker, Large/`, ['LShaker_Hit_rr1_Mid.wav', 'LShaker_Hit_rr2_Mid.wav'], 'Big Shaker Hit', 'shaker', ['short'], GROOVE),
    ...set('shakers', `${SI}Shaker, Large/`, ['LShaker_Shake1D_rr2_Mid.wav', 'LShaker_Shake1D_rr3_Mid.wav', 'LShaker_Shake1U_rr4_Mid.wav'], 'Big Shaker Shake', 'shaker', [], GROOVE),
    ...set('shakers', `${SI}Cabasa/`, ['Cabasa1_Hit_rr1_Mid.wav', 'Cabasa1_Hit_rr2_Mid.wav'], 'Cabasa Hit', 'shaker', ['short']),
    ...set('shakers', `${SI}Cabasa/`, ['Cabasa1_Rub_v2_rr1_Mid.wav', 'Cabasa1_Rub_v2_rr2_Mid.wav'], 'Cabasa Twist', 'shaker', []),
    // tambourines and bells
    ...set('tambourine', `${SI}Tambourine 1/`, ['Tamb1_Hit_v2_rr1_Mid.wav', 'Tamb1_Hit_v1_rr1_Mid.wav'], 'Tambourine Hit', 'perc', ['tambourine', 'bright'], GROOVE),
    ...set('tambourine', `${SI}Tambourine 2/`, ['Tamb2_Hit_v2_rr2_Mid.wav', 'Tamb2_Hit_v1_rr1_Mid.wav'], 'Tambourine Hit Dry', 'perc', ['tambourine', 'bright'], GROOVE),
    ...set('tambourine', `${SI}Tambourine 1/`, ['Tamb1_Shake_rr1_Mid.wav', 'Tamb1_Shake_rr2_Mid.wav'], 'Tambourine Shake', 'shaker', ['tambourine'], GROOVE),
    ...set('tambourine', `${SI}Tambourine 2/`, ['Tamb2_Shake_rr3_Mid.wav', 'Tamb2_Shake_rr4_Mid.wav'], 'Tambourine Shake Dry', 'shaker', ['tambourine'], GROOVE),
    ...set('tambourine', `${SI}Tambourine 1/`, ['Tamb1_Roll_v3_rr1_Mid.wav'], 'Tambourine Roll', 'shaker', ['tambourine', 'roll', 'long'], GROOVE),
    ...set('tambourine', `${SI}Tambourine 2/`, ['Tamb2_Roll_v3_rr1_Mid.wav'], 'Tambourine Roll Dry', 'shaker', ['tambourine', 'roll', 'long'], GROOVE),
    ...set('bells', `${SI}Sleigh Bells/`, ['sleighbell2_hit_loud.wav', 'sleighbell2_hit_2.wav', 'Sleighbells_Hit_rr1_Mid.wav', 'Sleighbells_Hit_rr2_Mid.wav'], 'Sleigh Bells Hit', 'perc', ['bells', 'bright'], ['pop', 'rnb', 'lofi', 'house']),
    ...set('bells', `${SI}Sleigh Bells/`, ['sleighbell1_shake1.wav'], 'Sleigh Bells Shake', 'shaker', ['bells', 'long'], ['pop', 'rnb', 'lofi', 'house']),
    ...set('bells', `${SI}Cowbells/`, ['Cowbell1_Normal_v3_rr1_Mid.wav', 'Cowbell2_Normal_v3_rr1_Mid.wav', 'Cowbell1_Hit_v4_rr1_Mid.wav'], 'Cowbell', 'perc', ['metallic', 'bright'], [...WORLD, 'phonk', 'trap']),
    ...set('bells', `${SI}Cowbells/`, ['Cowbell1_Muted_v3_rr1_Mid.wav', 'Cowbell2_Muted_v3_rr1_Mid.wav'], 'Cowbell Muted', 'perc', ['metallic', 'short'], [...WORLD, 'phonk', 'trap']),
    ...set('bells', `${SI}Cowbells/`, ['Cowbell2_Double_v3_rr1_Mid.wav'], 'Cowbell Double', 'perc', ['metallic'], [...WORLD, 'phonk', 'trap']),
    ...set('bells', `${SI}Agogo Bells/`, ['Agogo_High_v3_rr1_Mid.wav', 'Agogo_High_v2_rr1_Mid.wav'], 'Agogo High', 'perc', ['metallic', 'bright']),
    ...set('bells', `${SI}Agogo Bells/`, ['Agogo_Low_v2_rr1_Mid.wav'], 'Agogo Low', 'perc', ['metallic']),
    // wood
    ...set('wood', `${SI}Claves/`, ['Claves1_Hit_v3_rr1_Mid.wav', 'Claves2_Hit_v3_rr1_Mid.wav', 'Claves1_Hit_v2_rr1_Mid.wav', 'Claves2_Hit_v2_rr1_Mid.wav'], 'Claves', 'perc', ['wood', 'short', 'bright']),
    ...set('wood', `${SI}Woodblock/`, ['wood_click_ff.wav', 'wood_click_f_rr1.wav', 'wood_click_f_rr2.wav', 'wood_click3_vl2.wav', 'wood_click2_mp.wav'], 'Woodblock', 'perc', ['wood', 'short']),
    ...set('wood', `${SI}Slit Drum/`, ['LogDrumHi_MedM_v3_rr1_Sum.wav', 'LogDrumHi_MedM_v2_rr1_Sum.wav'], 'Log Drum High', 'perc', ['wood', 'warm'], ['afrobeats', 'deep-house', 'house', 'lofi', 'reggaeton']),
    ...set('wood', `${SI}Slit Drum/`, ['LogDrumLo_MedM_v3_rr1_Sum.wav', 'LogDrumLo_MedM_v2_rr1_Sum.wav'], 'Log Drum Low', 'perc', ['wood', 'warm', 'deep'], ['afrobeats', 'deep-house', 'house', 'lofi', 'reggaeton']),
    ...set('wood', `${SI}Guiro/`, ['Guiro_Hit_rr2_Mid.wav', 'Guiro_Fast_rr1_Mid.wav'], 'Guiro Scrape', 'perc', ['wood']),
    ...set('wood', `${SI}Slapstick/`, ['slapstick_rr1.wav', 'slapstick_rr2.wav', 'slapstick_rr3.wav'], 'Slapstick', 'clap', ['wood', 'punchy', 'short'], GROOVE),
    ...set('wood', `${SI}Vibraslap/Legacy/`, ['vibraslap_rr1.wav', 'vibraslap_rr3.wav'], 'Vibraslap', 'perc', ['rattle']),
    ...set('wood', `${SI}Ratchet/`, ['Ratchet1_Crank_rr1_Mid.wav', 'Ratchet2_Crank_v1_rr1_Mid.wav'], 'Ratchet Crank', 'perc', ['wood', 'rattle']),
    ...set('wood', `${SI}Ratchet/`, ['Ratchet1_Fast_rr1_Mid.wav'], 'Ratchet Spin', 'perc', ['wood', 'rattle', 'long']),
    // hand drums
    ...set('cajon', `${SI}Cajon/`, ['Cajon_hit1_fff_rr1.wav', 'Cajon_hit1_fff_rr2.wav', 'Cajon_hit1_f_rr1.wav', 'Cajon_hit1_f_rr2.wav'], 'Cajon Hit A', 'perc', ['wood', 'punchy'], GROOVE),
    ...set('cajon', `${SI}Cajon/`, ['Cajon_hit2_f_rr1.wav', 'Cajon_hit2_f_rr2.wav', 'Cajon_hit2_mp_rr1.wav'], 'Cajon Hit B', 'perc', ['wood', 'punchy'], GROOVE),
    ...set('cajon', `${SI}Cajon/`, ['Cajon_hit3_f_rr1.wav', 'Cajon_hit3_f_rr2.wav', 'Cajon_hit3_mp_rr1.wav'], 'Cajon Hit C', 'perc', ['wood', 'punchy'], GROOVE),
    ...set('bongos', `${SM}Bongos/`, ['BongoH_Hit1_v3_rr1_Mid.wav', 'BongoH_Hit1_v3_rr2_Mid.wav'], 'Bongo High Open', 'perc', ['bright']),
    ...set('bongos', `${SM}Bongos/`, ['BongoH_HitMuted1_v3_rr1_Mid.wav', 'BongoH_HitMuted1_v3_rr2_Mid.wav'], 'Bongo High Muted', 'perc', ['short']),
    ...set('bongos', `${SM}Bongos/`, ['BongoL_Hit1_v3_rr1_Mid.wav', 'BongoL_Hit1_v3_rr2_Mid.wav'], 'Bongo Low Open', 'perc', ['warm']),
    ...set('bongos', `${SM}Bongos/`, ['BongoL_HitMuted2_v3_rr1_Mid.wav', 'BongoL_HitMuted2_v3_rr2_Mid.wav'], 'Bongo Low Muted', 'perc', ['short']),
    ...set('bongos', `${SM}Bongos/`, ['BongoH_Roll_v3_rr1_Mid.wav', 'BongoL_Roll_v3_rr1_Mid.wav'], 'Bongo Roll', 'fill', ['roll']),
    ...set('congas', `${SM}Conga/`, ['Conga_HitN_v3_rr1_Sum.wav', 'Conga_HitN_v3_rr2_Sum.wav'], 'Conga Open', 'perc', ['warm']),
    ...set('congas', `${SM}Conga/`, ['Conga_HitFM_v2_rr1_Sum.wav', 'Conga_HitFM_v2_rr2_Sum.wav'], 'Conga Muted', 'perc', ['short']),
    ...set('congas', `${SM}Conga/`, ['Quinto_HitN_v3_rr1_Sum.wav', 'Quinto_HitN_v3_rr2_Sum.wav'], 'Quinto Open', 'perc', ['bright']),
    ...set('congas', `${SM}Conga/`, ['Quinto_HitFM1_v2_rr1_Sum.wav', 'Quinto_HitFM1_v2_rr2_Sum.wav'], 'Quinto Muted', 'perc', ['short']),
    ...set('congas', `${SM}Conga/`, ['Tumba_HitN_v4_rr1_Sum.wav', 'Tumba_HitN_v4_rr2_Sum.wav'], 'Tumba Open', 'perc', ['deep', 'warm']),
    ...set('congas', `${SM}Conga/`, ['Tumba_HitFM_v4_rr1_Sum.wav', 'Tumba_HitFM_v4_rr2_Sum.wav'], 'Tumba Muted', 'perc', ['deep', 'short']),
    ...set('darbuka', `${SM}Darbuka/`, ['Darbuka_1_hit_vl2_rr1.wav', 'Darbuka_1_hit_vl2_rr2.wav'], 'Darbuka Doum', 'perc', ['deep', 'punchy']),
    ...set('darbuka', `${SM}Darbuka/`, ['Darbuka_2_hit_vl2_rr1.wav', 'Darbuka_2_hit_vl2_rr2.wav'], 'Darbuka Tek', 'perc', ['bright', 'short']),
    ...set('darbuka', `${SM}Darbuka/`, ['Darbuka_3_hit_vl2_rr1.wav', 'Darbuka_3_hit_vl2_rr2.wav'], 'Darbuka Ka', 'perc', ['short']),
    ...set('darbuka', `${SM}Darbuka/`, ['Darbuka_4_hit_vl2_rr1.wav', 'Darbuka_4_hit_vl2_rr2.wav'], 'Darbuka Slap', 'perc', ['short']),
    ...set('darbuka', `${SM}Darbuka/`, ['Darbuka_5_hit_vl2_rr1.wav'], 'Darbuka Snap', 'perc', ['short']),
    ...set('frame-drum', `${SM}Frame Drum/`, ['HDrumL_Hit_v3_rr1_Sum.wav', 'HDrumL_Hit_v3_rr2_Sum.wav'], 'Frame Drum Low', 'perc', ['deep', 'warm']),
    ...set('frame-drum', `${SM}Frame Drum/`, ['HDrumL_HitMuted_v3_rr1_Sum.wav', 'HDrumL_HitMuted_v3_rr2_Sum.wav'], 'Frame Drum Low Muted', 'perc', ['deep', 'short']),
    ...set('frame-drum', `${SM}Frame Drum/`, ['HDrumS_Hit_v3_rr1_Sum.wav', 'HDrumS_Hit_v3_rr2_Sum.wav'], 'Frame Drum Small', 'perc', ['warm']),
    ...set('frame-drum', `${SM}Frame Drum/`, ['HDrumS_HitMuted_v3_rr1_Sum.wav'], 'Frame Drum Small Muted', 'perc', ['short']),
    // metal
    ...set('metal', `${SI}Brake Drum/`, ['BrakeDrum1_Hammer_v3_rr1_Mid.wav', 'BrakeDrum1_Hammer_v2_rr1_Mid.wav', 'BrakeDrum2_Hammer1_v2_rr1_Mid.wav', 'BrakeDrum2_Hammer3_v3_rr1_Mid.wav'], 'Brake Drum Hit', 'perc', ['metallic', 'hard'], [...GROOVE, 'techno']),
    ...set('metal', `${SI}Brake Drum/`, ['BrakeDrum1_YarnM_v3_rr1_Mid.wav'], 'Brake Drum Soft', 'perc', ['metallic'], [...GROOVE, 'techno']),
    ...set('metal', `${SI}Brake Drum/`, ['BrakeDrum1_Susp_v3_rr1_Mid.wav', 'BrakeDrum2_Susp_v2_rr1_Mid.wav'], 'Brake Drum Ring', 'perc', ['metallic', 'long'], [...GROOVE, 'techno']),
    // whistles, toys and snare rolls
    ...set('whistles', 'Aerophones/Edge-blown Aerophones/Ball Whistle/', ['Main_BallWhistle_Short-001.wav'], 'Samba Whistle Short', 'perc', ['whistle'], ['reggaeton', 'afrobeats', 'house', 'edm']),
    ...set('whistles', 'Aerophones/Edge-blown Aerophones/Ball Whistle/', ['Main_BallWhistle_Long-001.wav'], 'Samba Whistle Long', 'perc', ['whistle'], ['reggaeton', 'afrobeats', 'house', 'edm']),
    ...set('whistles', 'Aerophones/Edge-blown Aerophones/Train Whistle, Toy/', ['Main_TrainMed_Short-001.wav'], 'Toy Train Whistle', 'perc', ['whistle'], ['pop', 'lofi', 'house']),
    ...set('toys', `${SI}Flexatone/`, ['flexatone1.wav', 'flexatone_fast.wav'], 'Flexatone Wobble', 'perc', ['metallic', 'wobble'], ['lofi', 'pop', 'phonk']),
    ...set('rolls', `${SM}Snare Drum, Modern 1/`, ['Snare2_rollSN_v4_rr1_Mid.wav', 'Snare2_rollSN_v5_rr2_Mid.wav'], 'Concert Snare Roll', 'fill', ['roll', 'snare'], ['pop', 'edm', 'trap', 'drill', 'house']),
    ...set('rolls', `${SM}Snare Drum, Modern 1/`, ['Snare2_rollNS_v5_rr1_Mid.wav'], 'Tom Style Roll', 'fill', ['roll'], ['pop', 'edm', 'trap', 'drill', 'house']),
  ],
};
