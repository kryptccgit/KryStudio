import type { GenreId } from '@shared/sounds/genres';
import { sample, type SampleDef, type SamplePackSpec } from '../lib';
import { VCSL_SOURCE } from './perc-extras';

const BIG: GenreId[] = ['edm', 'dubstep', 'future-bass', 'trap', 'drill', 'pop', 'dnb', 'techno', 'house'];
const DARK: GenreId[] = ['trap', 'drill', 'phonk', 'dubstep', 'dnb', 'techno'];

type Kind = SampleDef['kind'];
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const pad3 = (n: number) => String(n).padStart(3, '0');
const set = (folder: string, from: string, dir: string, files: string[], name: string, kind: Kind, tags: string[], genres: GenreId[] = BIG) =>
  files.map((f, i) => sample(folder, from, `${dir}${f}`, files.length > 1 ? `${name} ${i + 1}` : name, kind, tags, genres));

const SI = 'Idiophones/Struck Idiophones/';
const SM = 'Membranophones/Struck Membranophones/';
const OGA = 'https://opengameart.org/sites/default/files/';

export const HITS_WHOOSHES: SamplePackSpec = {
  id: 'hits-whooshes',
  type: 'samples',
  sources: {
    vcsl: VCSL_SOURCE,
    scifi: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip', path: 'downloads/sci-fi-sounds.zip' },
    impact: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', path: 'downloads/impact-sounds.zip' },
    swishes: { type: 'zip', url: `${OGA}swishes.zip`, path: 'downloads/swishes.zip' },
    boom: { type: 'url', url: `${OGA}NenadSimic%20-%20Muffled%20Distant%20Explosion.wav` },
  },
  samples: [
    ...set('cymbals', 'vcsl', `${SI}Clash Cymbals 1/`, ['cymbal_crash1_ff2.wav', 'cymbal_crash1_ff3.wav'], 'Orchestral Crash Loud', 'crash', ['big', 'bright', 'long', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Clash Cymbals 1/`, ['cymbal_crash1_mf1.wav', 'cymbal_crash1_mf2.wav'], 'Orchestral Crash', 'crash', ['bright', 'long', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Clash Cymbals 1/`, ['cymbal_crash1_short1.wav', 'cymbal_crash1_short2.wav'], 'Crash Choke', 'crash', ['short', 'bright', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Clash Cymbals 2/`, ['cymbal_crash2_fff1.wav', 'cymbal_crash2_fff2.wav', 'cymbal_crash2_f1.wav'], 'Big Clash', 'crash', ['big', 'long', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Suspended Cymbal 1/`, ['susCymb1_cresc_1.5s.wav', 'susCymb1_cresc_2s.wav', 'susCymb1_cresc_4s.wav', 'susCymb1_cresc_7.5s.wav'], 'Cymbal Crescendo', 'crash', ['crescendo', 'build', 'long', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Suspended Cymbal 1/`, ['susCymb1_hit_fff1.wav', 'susCymb1_hit_f1.wav'], 'Suspended Cymbal Hit', 'crash', ['long', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Suspended Cymbal 1/`, ['susCymb1_hit_bell_fff1.wav'], 'Cymbal Bell Hit', 'ride', ['metallic', 'bright', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Suspended Cymbal 1/`, ['susCymb1_roll_ff2_nloop.wav'], 'Cymbal Roll', 'texture', ['roll', 'build', 'long', 'organic']),
    ...set('cymbals', 'vcsl', `${SI}Suspended Cymbal 1/`, ['susCymb1_bow_20.wav', 'susCymb1_bow_13.wav'], 'Bowed Cymbal', 'texture', ['eerie', 'metallic', 'long', 'organic'], DARK),
    ...set('cymbals', 'vcsl', `${SI}Suspended Cymbal 1/`, ['susCymb1_scrape_1.wav'], 'Cymbal Scrape', 'texture', ['metallic', 'eerie', 'organic'], DARK),
    ...set('gongs', 'vcsl', `${SI}Gong 1/`, ['gong_fff.wav', 'gong_f.wav', 'gong_2_f.wav'], 'Gong Hit', 'impact', ['big', 'long', 'metallic', 'organic']),
    ...set('gongs', 'vcsl', `${SI}Gong 1/`, ['gong_scrape_mf.wav'], 'Gong Scrape', 'texture', ['metallic', 'eerie', 'organic'], DARK),
    ...set('drums', 'vcsl', `${SM}Bass Drum 2/`, ['bassdrum_hit_ff.wav', 'bassdrum_hit_f.wav'], 'Concert Bass Drum Boom', 'impact', ['deep', 'big', 'organic']),
    ...set('drums', 'vcsl', `${SM}Bass Drum 1/`, ['BDrumNew_hit_v7_rr1_Sum.wav', 'BDrumNew_hit_v7_rr2_Sum.wav'], 'Bass Drum Thump', 'impact', ['deep', 'punchy', 'organic']),
    ...set('drums', 'vcsl', `${SM}Bass Drum 2/`, ['bassdrum_cresc_short.wav', 'bassdrum_cresc_med.wav'], 'Bass Drum Crescendo', 'fill', ['crescendo', 'build', 'deep', 'organic']),
    ...set('drums', 'vcsl', `${SM}Bass Drum 2/`, ['bassdrum_roll_ff.wav'], 'Bass Drum Rumble', 'fill', ['roll', 'deep', 'organic']),
    ...set('metal', 'vcsl', `${SI}Anvil/`, ['Anvil_Hit3_v3_rr1_Mid.wav', 'Anvil_Hit2_v3_rr1_Mid.wav', 'Anvil_Hit1_v3_rr1_Mid.wav'], 'Anvil Strike', 'impact', ['metallic', 'hard', 'organic'], [...DARK, 'house']),
    ...set('chimes', 'vcsl', `${SI}Mark Trees/Legacy/`, ['windchimes_asc1.wav', 'windchimes_slowAsc1.wav'], 'Chime Run Up', 'perc', ['chimes', 'bright', 'transition', 'organic'], ['pop', 'rnb', 'lofi', 'future-bass', 'edm']),
    ...set('chimes', 'vcsl', `${SI}Mark Trees/Legacy/`, ['windchimes_desc1.wav', 'windchimes_slowDesc1.wav'], 'Chime Run Down', 'perc', ['chimes', 'bright', 'transition', 'organic'], ['pop', 'rnb', 'lofi', 'future-bass', 'edm']),
    ...set('chimes', 'vcsl', `${SI}Bell Tree/Stroke/`, ['BellTree_Stroke_6_Mid.wav'], 'Bell Tree Sweep', 'perc', ['chimes', 'bright', 'transition', 'organic'], ['pop', 'rnb', 'lofi', 'future-bass']),
    ...set('chimes', 'vcsl', 'Idiophones/Friction Idiophones/Wine Glasses/Sustains/Slow/', ['glass3_A#4_Slow_1_Main.wav'], 'Singing Glass', 'texture', ['glass', 'dreamy', 'long', 'organic'], ['lofi', 'rnb', 'deep-house', 'future-bass']),
    ...set('whistles', 'vcsl', 'Aerophones/Free Aerophones/Siren/', ['Main_SirenWhistle-010.wav', 'Main_SirenWhistle-002.wav', 'Main_SirenWhistle-005.wav'], 'Siren Whistle', 'perc', ['whistle', 'siren'], ['reggaeton', 'dnb', 'dubstep', 'edm', 'afrobeats']),

    ...set('sci-fi', 'scifi', 'Audio/', range(0, 4).map((n) => `explosionCrunch_${pad3(n)}.ogg`), 'Crunch Blast', 'impact', ['explosion', 'gritty', 'distorted'], DARK),
    ...set('sci-fi', 'scifi', 'Audio/', ['lowFrequency_explosion_000.ogg', 'lowFrequency_explosion_001.ogg'], 'Sub Boom', 'impact', ['sub', 'deep', 'big'], [...DARK, 'edm', 'future-bass']),
    ...set('sci-fi', 'scifi', 'Audio/', range(0, 4).map((n) => `laserLarge_${pad3(n)}.ogg`), 'Big Laser', 'zap', ['laser', 'big'], [...DARK, 'synthwave']),
    ...set('sci-fi', 'scifi', 'Audio/', range(0, 3).map((n) => `laserSmall_${pad3(n)}.ogg`), 'Small Laser', 'zap', ['laser', 'short'], [...DARK, 'synthwave']),
    ...set('sci-fi', 'scifi', 'Audio/', ['laserRetro_000.ogg', 'laserRetro_002.ogg', 'laserRetro_004.ogg'], 'Retro Laser', 'zap', ['laser', 'short', 'retro'], [...DARK, 'synthwave']),
    ...set('sci-fi', 'scifi', 'Audio/', ['forceField_000.ogg'], 'Force Field Pulse', 'zap', ['hum']),
    ...set('sci-fi', 'scifi', 'Audio/', ['doorOpen_000.ogg', 'doorClose_000.ogg'], 'Air Lock Swish', 'whoosh', ['sci-fi', 'short']),
    ...set('sci-fi', 'scifi', 'Audio/', ['thrusterFire_000.ogg', 'thrusterFire_001.ogg'], 'Rocket Burn', 'noise', ['noise', 'long'], DARK),
    ...set('sci-fi', 'scifi', 'Audio/', ['computerNoise_000.ogg', 'computerNoise_001.ogg'], 'Computer Chatter', 'texture', ['sci-fi', 'blips'], ['synthwave', 'techno', 'dnb', 'phonk']),
    ...set('sci-fi', 'scifi', 'Audio/', ['spaceEngineLarge_000.ogg'], 'Engine Drone', 'texture', ['drone', 'dark'], DARK),

    ...set('punches', 'impact', 'Audio/', [0, 2, 3].map((n) => `impactPunch_heavy_${pad3(n)}.ogg`), 'Heavy Punch', 'impact', ['punchy', 'short'], DARK),
    ...set('punches', 'impact', 'Audio/', range(0, 3).map((n) => `impactPunch_medium_${pad3(n)}.ogg`), 'Body Punch', 'impact', ['punchy', 'short'], DARK),
    ...set('punches', 'impact', 'Audio/', [0, 1, 3, 4].map((n) => `impactSoft_heavy_${pad3(n)}.ogg`), 'Low Thud', 'impact', ['deep', 'soft', 'short'], DARK),

    ...set('swishes', 'swishes', 'swishes/', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13].map((n) => `swish-${n}.wav`), 'Swish', 'whoosh', ['short', 'airy'], [...BIG, 'phonk', 'lofi']),
    sample('booms', 'boom', undefined, 'Distant Boom', 'impact', ['deep', 'dark', 'long'], [...DARK, 'edm'], { ext: '.wav' }),
  ],
};
