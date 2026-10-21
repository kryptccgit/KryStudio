import type { PackDef, PackFile, PackLicence, PackSample, PackSfz } from './types';
import * as GRAND from './data/grand-piano.gen';
import * as UPRIGHT from './data/upright-piano.gen';
import * as DRUMS from './data/live-drums.gen';
import * as MALLETS from './data/keys-mallets.gen';
import * as ORCH from './data/orchestral.gen';
import * as FOLEY from './data/foley-field.gen';
import * as HITS from './data/hits-whooshes.gen';
import * as PERC from './data/perc-extras.gen';
import * as RETRO from './data/retro-game.gen';

interface Generated {
  FILES: PackFile[];
  SFZ: PackSfz[];
  RAM_MB: Record<string, number>;
}

function samplePack(def: Omit<PackDef, 'files' | 'sfz' | 'bytes' | 'ramMb' | 'samples'>, gen: Generated & { SAMPLES: PackSample[] }): PackDef {
  return { ...pack(def, gen), samples: gen.SAMPLES };
}

function pack(def: Omit<PackDef, 'files' | 'sfz' | 'bytes' | 'ramMb'>, gen: Generated): PackDef {
  return {
    ...def,
    files: gen.FILES,
    sfz: gen.SFZ,
    bytes: gen.FILES.reduce((a, f) => a + f.bytes, 0),
    ramMb: Math.ceil(Math.max(0, ...Object.values(gen.RAM_MB))),
  };
}

const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const OUR_MAPPINGS = 'The .sfz mappings in this folder were written by Krypt Studio and are MIT-licensed like the app.';

const SALAMANDER_PAGE = 'https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/';
const SALAMANDER_ARCHIVE = 'https://web.archive.org/web/20261009164910/https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/';

const SALAMANDER: PackLicence = {
  spdx: 'LicenseRef-PublicDomain',
  name: "Public domain (the author's statement, 4 March 2022)",
  url: SALAMANDER_PAGE,
  attribution: 'Salamander Grand Piano V3 by Alexander Holm (public domain since 4 March 2022).',
  statement: [
    'Salamander Grand Piano V3',
    'Recorded by Alexander Holm (a grand piano, two AKG C414 microphones in AB above the strings, 48 kHz / 24-bit).',
    '',
    `The author's page: ${SALAMANDER_PAGE}`,
    `Archived copy (9 October 2026): ${SALAMANDER_ARCHIVE}`,
    '',
    "The author's statement on that page, verbatim:",
    '  "As of 4.3.2022, this is now public domain! Have fun with it, it\'s yours and noones!"',
    'and, about copies: "others are welcome to mirror!"',
    '',
    'Krypt Studio downloads the sample files from the sfzinstruments mirror of version 3',
    '(https://github.com/sfzinstruments/SalamanderGrandPiano, commit 3382bf9496bba2486f5ab0de55a264d1dfc38404), which was',
    "uploaded in January 2022 under the work's earlier licence, Creative Commons Attribution 3.0. The author's 4 March",
    '2022 dedication covers these same recordings. Krypt Studio credits the author anyway, which also gives the credit',
    'the earlier licence asked for.',
    '',
    OUR_MAPPINGS,
  ].join('\n'),
};

const VSCO_TERMS = [
  'VS Chamber Orchestra 2: Community Edition is dedicated to the public domain under CC0 1.0 Universal: see the',
  'LICENSE file at https://github.com/sgossner/VSCO-2-CE/blob/440300901dfe9275fd84e0b7763af1f8443ae62e/LICENSE',
  `(${CC0_URL}).`,
  '',
  "The library's 2016 Readme.txt adds, as requests: \"Please provide credit to Versilian Studios/Sam Gossner, and/or Ivy",
  'Audio/Simon Dalzell where applicable, and link to the VSCO: CE homepage" and "We ask that you do not sell the samples',
  'directly". Krypt Studio credits them, never sells the samples, and has you download them from the upstream repository.',
  'Homepage: http://vis.versilstudios.net/vsco-community.html',
];

const VCSL_COMMIT = 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e';
const READ = '2026-10-14';

const VCSL_TERMS = [
  '- Versilian Community Sample Library (VCSL) by Versilian Studios.',
  `  LICENSE at the pinned commit: https://github.com/sgossner/VCSL/blob/${VCSL_COMMIT}/LICENSE ("CC0 1.0 Universal").`,
  '  README: "This collection is under a Creative Commons 0 license."',
].join('\n');

function kenneyTerms(title: string, slug: string, header: string): string {
  return [
    `- "${title}" by Kenney (www.kenney.nl).`,
    `  Page: https://kenney.nl/assets/${slug} (read ${READ}): "License: Creative Commons CC0".`,
    `  License.txt in the ZIP ("${header}"): "Creative Commons Zero, CC0", "http://creativecommons.org/publicdomain/zero/1.0/".`,
  ].join('\n');
}

function ogaTerms(title: string, author: string, slug: string): string {
  return `- "${title}" by ${author}. Page: https://opengameart.org/content/${slug} (read ${READ}): "License(s): CC0".`;
}

function sourcesStatement(pack: string, sources: string[]): string {
  return [
    `${pack}`,
    '',
    'Every recording in this pack is dedicated to the public domain under CC0 1.0 Universal',
    `(${CC0_URL}) by its author. Krypt Studio downloads the files from each source's own site at the`,
    'URLs pinned (with SHA-256 and size) in shared/packs/catalog.ts, renames them in its own words and changes',
    'nothing else. The sources and where their licence is stated:',
    '',
    ...sources,
    '',
    'Credit is not required by CC0; Krypt Studio credits every author anyway.',
  ].join('\n');
}

export const PACKS: readonly PackDef[] = [
  pack(
    {
      id: 'grand-piano',
      name: 'Grand Piano',
      version: 1,
      description: 'A recorded concert grand: 5 velocity layers sampled every minor third, with the key-release noise of each key. The piano for pop, R&B, ballads and house chords.',
      author: 'Alexander Holm',
      homepage: SALAMANDER_PAGE,
      licence: SALAMANDER,
      contents: ['Grand piano (5 velocity layers, key-release noise)', 'Soft grand (the two softest layers, for mellow chords)'],
    },
    GRAND,
  ),
  pack(
    {
      id: 'live-drums',
      name: 'Live Drum Kit',
      version: 2,
      description: 'A real club/jazz drum kit played with sticks: close mics with overheads, up to 36 velocity layers and round robins, plus the same kit through a dusty vintage mic.',
      author: 'Versilian Studios and Karoryfer Samples (drummer: Austin McMahon)',
      homepage: 'https://github.com/sfzinstruments/virtuosity_drums',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal',
        url: 'https://github.com/sfzinstruments/virtuosity_drums/blob/9f04cf9a734527edfbb0a4eee1f674e45bbf71bc/LICENSE',
        attribution: 'Virtuosity Drums by Versilian Studios and Karoryfer Samples, performed by Austin McMahon, recorded at Virtuosity Musical Instruments, Boston (CC0 1.0).',
      },
      contents: [
        'Full kit in the GM layout (kick, snare, cross-stick, rimshot, two toms, hats, ride, crash)',
        'The same kit through a vintage lo-fi mic',
        'Single pieces in both mixes: kick, snare, cross-stick, closed and open hat, ride, crash, low and high tom',
      ],
    },
    DRUMS,
  ),
  pack(
    {
      id: 'upright-piano',
      name: 'Upright Piano',
      version: 1,
      description: 'A warm upright piano in three dynamics, sampled every major third. The lo-fi, boom bap and soul piano.',
      author: 'Simon Dalzell (Ivy Audio) for Versilian Studios',
      homepage: 'https://github.com/sgossner/VSCO-2-CE',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal',
        url: 'https://github.com/sgossner/VSCO-2-CE/blob/440300901dfe9275fd84e0b7763af1f8443ae62e/LICENSE',
        attribution: 'Upright piano sampled by Simon Dalzell (Ivy Audio), from VS Chamber Orchestra 2: Community Edition by Versilian Studios (CC0 1.0).',
        statement: [...VSCO_TERMS, '', OUR_MAPPINGS].join('\n'),
      },
      contents: ['Upright piano (3 dynamics)', 'Soft upright (the quietest dynamic, for lo-fi chords)'],
    },
    UPRIGHT,
  ),
  pack(
    {
      id: 'keys-mallets',
      name: 'Keys & Mallets',
      version: 1,
      description: 'Recorded vibraphone (soft and hard mallets), marimba, glockenspiel and kalimba for lo-fi, R&B, afrobeats and pop melodies.',
      author: 'Versilian Studios (Versilian Community Sample Library)',
      homepage: 'https://github.com/sgossner/VCSL',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal',
        url: 'https://github.com/sgossner/VCSL/blob/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/LICENSE',
        attribution: 'Versilian Community Sample Library (VCSL) by Versilian Studios (CC0 1.0).',
      },
      contents: ['Vibraphone, soft mallets (2 velocity layers)', 'Vibraphone, hard mallets (2 velocity layers)', 'Marimba (3 velocity layers)', 'Glockenspiel (3 velocity layers)', 'Kalimba (27 tines)'],
    },
    MALLETS,
  ),
  pack(
    {
      id: 'orchestral',
      name: 'Orchestral Essentials',
      version: 1,
      description: 'Real string sections (sustained, spiccato and pizzicato), a brass section for stabs, a flute and a concert harp, for trap, drill and cinematic pop.',
      author: 'Versilian Studios (Sam Gossner, Simon Dalzell)',
      homepage: 'https://github.com/sgossner/VSCO-2-CE',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal',
        url: 'https://github.com/sgossner/VSCO-2-CE/blob/440300901dfe9275fd84e0b7763af1f8443ae62e/LICENSE',
        attribution: 'VS Chamber Orchestra 2: Community Edition by Versilian Studios (Sam Gossner) with Ivy Audio (Simon Dalzell) (CC0 1.0).',
        statement: [...VSCO_TERMS, '', OUR_MAPPINGS].join('\n'),
      },
      contents: [
        'String ensemble, sustained (2 dynamics)',
        'String ensemble, spiccato (2 dynamics, round robins)',
        'Violin section pizzicato',
        'Brass section stabs (trumpet, horn and trombone)',
        'Flute, sustained with vibrato',
        'Concert harp',
      ],
    },
    ORCH,
  ),
  samplePack(
    {
      id: 'perc-extras',
      name: 'Percussion Extras',
      version: 1,
      description: 'Recorded hand and world percussion for grooves and top loops: claps, shakers, tambourines, cajon, bongos, congas, darbuka, log drum, cowbells, woodblock and more.',
      author: 'Versilian Studios (Versilian Community Sample Library)',
      homepage: 'https://github.com/sgossner/VCSL',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal',
        url: `https://github.com/sgossner/VCSL/blob/${VCSL_COMMIT}/LICENSE`,
        attribution: 'Percussion from the Versilian Community Sample Library (VCSL) by Versilian Studios (CC0 1.0).',
      },
      contents: ['Claps, shakers, cabasa and tambourines', 'Cajon, bongos, congas, darbuka and frame drums', 'Claves, woodblock, log drums, cowbells, agogo and brake drum', 'Guiro, vibraslap, ratchet, slapstick, whistles and concert snare rolls'],
    },
    PERC,
  ),
  samplePack(
    {
      id: 'hits-whooshes',
      name: 'Hits & Whooshes',
      version: 1,
      description: 'Recorded impacts and transition ear candy: orchestral crashes and cymbal crescendos, gongs, concert bass drum booms, anvils, chime runs, swishes, punches, sub booms and sci-fi blasts.',
      author: 'Versilian Studios, Kenney, artisticdude and Nenad Simic',
      homepage: 'https://github.com/sgossner/VCSL',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal (every source)',
        url: CC0_URL,
        attribution: 'Hits & Whooshes: VCSL by Versilian Studios, Sci-Fi Sounds and Impact Sounds by Kenney (kenney.nl), Swishes by artisticdude and Muffled Distant Explosion by Nenad Simic (all CC0 1.0).',
        statement: sourcesStatement('Hits & Whooshes', [VCSL_TERMS, kenneyTerms('Sci-Fi Sounds', 'sci-fi-sounds', 'Sci-Fi Sounds (1.0) ... Creation date: 11-10-2020'), kenneyTerms('Impact Sounds', 'impact-sounds', 'Impact Sounds (1.0) ... Creation date: 19-12-2019'), ogaTerms('Swishes Sound Pack', 'artisticdude', 'swishes-sound-pack'), ogaTerms('Muffled Distant Explosion', 'NenadSimic', 'muffled-distant-explosion')]),
      },
      contents: ['Orchestral crashes, chokes and cymbal crescendos', 'Gongs, concert bass drum booms and rolls, anvil strikes', 'Chime runs, a bell tree, a singing glass, bowed cymbal and scrapes', 'Swishes, punches, low thuds, sub booms, sci-fi blasts and lasers'],
    },
    HITS,
  ),
  samplePack(
    {
      id: 'foley-field',
      name: 'Foley & Field Recordings',
      version: 1,
      description: 'Recorded objects for percussion layers and ear candy (cards, chips, dice, books, paper, keys, switches, glass, tape deck) and field recordings for intros and lo-fi beds: rain, thunder, a busy road, birds, applause and room tone.',
      author: 'Kenney and OpenGameArt contributors',
      homepage: 'https://opengameart.org/',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal (every source)',
        url: CC0_URL,
        attribution: 'Foley & Field Recordings: Casino Audio, RPG Audio, Impact Sounds and UI Audio by Kenney (kenney.nl), and CC0 recordings from OpenGameArt.org by unicaegames, OwlishMedia, Luckius, StarNinjas, bart, Ylmir, LEGIT Audio, Spring Spring, BMacZero, Till Behrend, Vinrax, scorcher24, Iochi Glaucus, PagDev, Kresiek The Furry, WuxiaScrub, IgnasD and eXpl0it3r (all CC0 1.0).',
        statement: sourcesStatement('Foley & Field Recordings', [
          kenneyTerms('Casino Audio', 'casino-audio', 'Casino Audio'),
          kenneyTerms('RPG Audio', 'rpg-audio', 'RPG Audio'),
          kenneyTerms('Impact Sounds', 'impact-sounds', 'Impact Sounds (1.0) ... Creation date: 19-12-2019'),
          kenneyTerms('UI Audio', 'ui-audio', 'UI Audio'),
          ogaTerms('Keyboard Soundpack #1 [Typing and Single Keystrokes]', 'unicaegames', 'keyboard-soundpack-1-typing-and-single-keystrokes'),
          ogaTerms('87 Clickety Clips', 'OwlishMedia', '87-clickety-clips'),
          ogaTerms('Various Paper Sound Effects', 'Luckius', 'various-paper-sound-effects'),
          ogaTerms('10 Book Page Flips', 'StarNinjas', '10-book-page-flips'),
          ogaTerms('Ticking clock.', 'bart', 'ticking-clock'),
          ogaTerms('Rain (loopable)', 'Ylmir', 'rain-loopable'),
          ogaTerms('The Shop', 'LEGIT Audio', 'the-shop'),
          ogaTerms('Tape Recorder Opening and Closing Sound Effects', 'Spring Spring', 'tape-recorder-opening-and-closing-sound-effects'),
          ogaTerms('Metal Impact Sounds', 'BMacZero', 'metal-impact-sounds'),
          ogaTerms('Glass Break', 'Till Behrend', 'glass-break'),
          ogaTerms('Snap of the fingers sounds', 'Vinrax', 'snap-of-the-fingers-sounds'),
          ogaTerms("Scorcher's Foley Sounds", 'scorcher24', 'scorchers-foley-sounds'),
          ogaTerms('Fabric Rustling', 'Iochi Glaucus', 'fabric-rustling'),
          ogaTerms('Fireplace Sound loop', 'PagDev', 'fireplace-sound-loop'),
          ogaTerms('AMB Rain Loop 2', 'Kresiek The Furry', 'amb-rain-loop-2'),
          ogaTerms('AMB Morning Sounds (Perfect Loop)', 'Kresiek The Furry', 'amb-morning-sounds-perfect-loop'),
          ogaTerms('AMB Outside 1', 'Kresiek The Furry', 'amb-outside-1'),
          ogaTerms('Rain + Long Thunder', 'WuxiaScrub', 'rain-long-thunder'),
          ogaTerms('High traffic road sounds', 'IgnasD', 'high-traffic-road-sounds'),
          ogaTerms('Applause in a large hall or church', 'eXpl0it3r', 'applause-in-a-large-hall-or-church'),
        ]),
      },
      contents: ['Cards, chips and dice', 'Books, paper, cloth, doors, keys, switches and clicks', 'Glass, plates, tin, metal and footsteps', 'Tape deck, clock ticks and finger snaps', 'Rain, thunder, birds, a busy road, applause, a fireplace and room tone'],
    },
    FOLEY,
  ),
  samplePack(
    {
      id: 'retro-game',
      name: 'Retro Game FX',
      version: 1,
      description: 'Chiptune game sounds for game-flavoured beats: coins, jumps, power-ups, blips, lasers, falls and explosions, synth zaps, and arcade-announcer voice shots.',
      author: 'Juhani Junkala and Kenney',
      homepage: 'https://opengameart.org/content/512-sound-effects-8-bit-style',
      licence: {
        spdx: 'CC0-1.0',
        name: 'CC0 1.0 Universal (every source)',
        url: CC0_URL,
        attribution: 'Retro Game FX: The Essential Retro Video Game Sound Effects Collection by Juhani Junkala, and Digital Audio, Voiceover Pack and Voiceover Pack: Fighter by Kenney (kenney.nl) (all CC0 1.0).',
        statement: sourcesStatement('Retro Game FX', [
          [
            '- "The Essential Retro Video Game Sound Effects Collection [512 sounds]" by Juhani Junkala (SubspaceAudio).',
            '  Page: https://opengameart.org/content/512-sound-effects-8-bit-style (read 2026-10-14): "License(s): CC0".',
            '  INFO.txt in the ZIP, verbatim: "These sound effects have been released under CC0 creative commons license. You can do',
            '  anything you want with these sounds."',
          ].join('\n'),
          kenneyTerms('Digital Audio', 'digital-audio', 'Digital Audio'),
          kenneyTerms('Voiceover Pack', 'voiceover-pack', 'Voiceover Pack #1 by Kenney Vleugels (Kenney.nl)'),
          kenneyTerms('Voiceover Pack: Fighter', 'voiceover-pack-fighter', 'Voiceover Pack: Fighter by Kenney Vleugels (Kenney.nl)'),
        ]),
      },
      contents: ['8-bit coins, jumps, power-ups, falls, portals and fanfares', 'Blips, menu sounds, hits and errors, chip alarms', '8-bit lasers and explosions; synth zaps and phasers', 'Arcade-announcer and voice shots (fight, ready, go, round one, winner, counts)'],
    },
    RETRO,
  ),
];

const BY_ID = new Map(PACKS.map((p) => [p.id, p]));

export function packById(id: string): PackDef | undefined {
  return BY_ID.get(id);
}
