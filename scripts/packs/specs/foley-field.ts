import type { GenreId } from '@shared/sounds/genres';
import { sample, type SampleDef, type SamplePackSpec } from '../lib';

const LOFI: GenreId[] = ['lofi', 'boom-bap', 'rnb', 'phonk'];
const PERC: GenreId[] = ['lofi', 'boom-bap', 'trap', 'rnb', 'afrobeats', 'pop', 'deep-house', 'tech-house'];
const AMB: GenreId[] = ['lofi', 'boom-bap', 'rnb', 'deep-house', 'synthwave', 'pop'];

type Kind = SampleDef['kind'];
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const pad3 = (n: number) => String(n).padStart(3, '0');

const set = (folder: string, from: string, files: string[], name: string, kind: Kind, tags: string[], genres: GenreId[] = PERC) =>
  files.map((f, i) => sample(folder, from, f, files.length > 1 ? `${name} ${i + 1}` : name, kind, tags, genres));
const one = (folder: string, from: string, ext: string, name: string, kind: Kind, tags: string[], genres: GenreId[] = PERC) => sample(folder, from, undefined, name, kind, tags, genres, { ext });

const OGA = 'https://opengameart.org/sites/default/files/';

export const FOLEY_FIELD: SamplePackSpec = {
  id: 'foley-field',
  type: 'samples',
  sources: {
    casino: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip', path: 'downloads/casino-audio.zip' },
    rpg: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip', path: 'downloads/rpg-audio.zip' },
    impact: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', path: 'downloads/impact-sounds.zip' },
    ui: { type: 'zip', url: 'https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip', path: 'downloads/ui-audio.zip' },
    keyboard: { type: 'zip', url: `${OGA}unicae_games_keyboard_soundpack_1_0.zip`, path: 'downloads/keyboard.zip' },
    clicks: { type: 'zip', url: `${OGA}Click_Clips.zip`, path: 'downloads/clicks.zip' },
    paper: { type: 'zip', url: `${OGA}sounds_6.zip`, path: 'downloads/paper.zip' },
    books: { type: 'zip', url: `${OGA}book_flips_-_starninjas.zip`, path: 'downloads/book-flips.zip' },
    ticks: { type: 'zip', url: `${OGA}ticks.zip`, path: 'downloads/clock-ticks.zip' },
    rainloops: { type: 'zip', url: `${OGA}Rain%20OGG.zip`, path: 'downloads/rain-loops.zip' },
    shop: { type: 'zip', url: `${OGA}legit_audio_-_the_shop_free_sfx_wav.zip`, path: 'downloads/room-tone.zip' },
    tapeOpen: { type: 'url', url: `${OGA}tape_recorder_opening.wav` },
    tapeClose: { type: 'url', url: `${OGA}tape_recorder_closing.wav` },
    bing: { type: 'url', url: `${OGA}bing1.wav` },
    bong: { type: 'url', url: `${OGA}bong1.wav` },
    thud: { type: 'url', url: `${OGA}thud2.wav` },
    glass: { type: 'url', url: `${OGA}glass_breaking.wav` },
    snap1: { type: 'url', url: `${OGA}snap_of_the_fingers1.wav` },
    snap2: { type: 'url', url: `${OGA}snap_of_the_fingers2.wav` },
    snap3: { type: 'url', url: `${OGA}snap_of_the_fingers3.wav` },
    paperRustle: { type: 'url', url: `${OGA}paper_rustling.wav` },
    fabric: { type: 'url', url: `${OGA}rustling.ogg` },
    clock: { type: 'url', url: `${OGA}ticking_clock.wav` },
    fireplace: { type: 'url', url: `${OGA}fire.wav` },
    rain: { type: 'url', url: `${OGA}amb_rain2.ogg` },
    thunder: { type: 'url', url: `${OGA}rain-thunder.ogg` },
    morning: { type: 'url', url: `${OGA}amb_morning_0.ogg` },
    outdoors: { type: 'url', url: `${OGA}amb_outdoor1_loop.wav` },
    applause: { type: 'url', url: `${OGA}applause-clapping-church-crowd-immersive.wav` },
    road: { type: 'url', url: `${OGA}gatve%20Varniu_2.ogg` },
  },
  samples: [
    ...set('cards', 'casino', ['Audio/card-fan-1.ogg', 'Audio/card-fan-2.ogg'], 'Card Fan', 'foley', ['cards', 'paper', 'short']),
    ...set('cards', 'casino', range(1, 4).map((n) => `Audio/card-place-${n}.ogg`), 'Card Place', 'foley', ['cards', 'paper', 'short']),
    ...set('cards', 'casino', range(1, 4).map((n) => `Audio/card-shove-${n}.ogg`), 'Card Shove', 'foley', ['cards', 'paper', 'short']),
    ...set('cards', 'casino', range(1, 8).map((n) => `Audio/card-slide-${n}.ogg`), 'Card Slide', 'foley', ['cards', 'paper', 'short']),
    ...set('cards', 'casino', ['Audio/card-shuffle.ogg'], 'Card Shuffle', 'foley', ['cards', 'paper', 'long']),
    ...set('cards', 'casino', ['Audio/cards-pack-open-1.ogg', 'Audio/cards-pack-open-2.ogg'], 'Card Pack Open', 'foley', ['cards', 'paper']),
    ...set('chips', 'casino', range(1, 6).map((n) => `Audio/chips-stack-${n}.ogg`), 'Chip Stack', 'foley', ['clack', 'short']),
    ...set('chips', 'casino', range(1, 4).map((n) => `Audio/chips-collide-${n}.ogg`), 'Chips Clack', 'foley', ['clack', 'short']),
    ...set('chips', 'casino', range(1, 3).map((n) => `Audio/chip-lay-${n}.ogg`), 'Chip Drop', 'foley', ['clack', 'short']),
    ...set('chips', 'casino', range(1, 6).map((n) => `Audio/chips-handle-${n}.ogg`), 'Chips Handful', 'foley', ['clack', 'rattle']),
    ...set('dice', 'casino', ['Audio/dice-shake-1.ogg', 'Audio/dice-shake-3.ogg'], 'Dice Shake', 'shaker', ['rattle', 'organic']),
    ...set('dice', 'casino', range(1, 3).map((n) => `Audio/dice-throw-${n}.ogg`), 'Dice Roll', 'foley', ['rattle']),
    ...set('dice', 'casino', range(1, 4).map((n) => `Audio/die-throw-${n}.ogg`), 'Single Die Roll', 'foley', ['rattle']),

    ...set('books', 'rpg', ['Audio/bookOpen.ogg'], 'Book Open', 'foley', ['paper', 'short']),
    ...set('books', 'rpg', ['Audio/bookClose.ogg'], 'Book Close', 'foley', ['paper', 'short', 'punchy']),
    ...set('books', 'rpg', ['Audio/bookPlace1.ogg'], 'Book Set Down', 'foley', ['paper', 'short', 'punchy']),
    ...set('books', 'rpg', ['Audio/bookFlip2.ogg', 'Audio/bookFlip3.ogg'], 'Book Page Turn', 'foley', ['paper', 'short']),
    ...set('cloth', 'rpg', range(1, 4).map((n) => `Audio/cloth${n}.ogg`), 'Cloth Rustle', 'foley', ['cloth', 'soft']),
    ...set('cloth', 'rpg', ['Audio/clothBelt.ogg', 'Audio/clothBelt2.ogg'], 'Belt Rustle', 'foley', ['cloth', 'soft']),
    ...set('cloth', 'rpg', ['Audio/beltHandle1.ogg', 'Audio/beltHandle2.ogg'], 'Buckle Jingle', 'foley', ['metallic', 'short']),
    ...set('cloth', 'rpg', ['Audio/dropLeather.ogg'], 'Leather Drop', 'foley', ['punchy', 'short']),
    ...set('doors', 'rpg', ['Audio/doorOpen_1.ogg', 'Audio/doorOpen_2.ogg'], 'Wooden Door Open', 'foley', ['wood', 'creak']),
    ...set('doors', 'rpg', ['Audio/doorClose_2.ogg', 'Audio/doorClose_4.ogg'], 'Wooden Door Close', 'foley', ['wood', 'punchy']),
    ...set('doors', 'rpg', ['Audio/creak1.ogg', 'Audio/creak2.ogg'], 'Wood Creak', 'foley', ['wood', 'creak']),
    ...set('metal', 'rpg', ['Audio/metalClick.ogg'], 'Metal Click', 'foley', ['metallic', 'short']),
    ...set('metal', 'rpg', ['Audio/metalLatch.ogg'], 'Metal Latch', 'foley', ['metallic', 'short']),
    ...set('metal', 'rpg', ['Audio/handleCoins.ogg', 'Audio/handleCoins2.ogg'], 'Coins In Hand', 'foley', ['metallic', 'rattle']),
    ...set('metal', 'rpg', ['Audio/knifeSlice.ogg', 'Audio/knifeSlice2.ogg'], 'Blade Slice', 'foley', ['metallic', 'short']),
    ...set('metal', 'rpg', ['Audio/drawKnife3.ogg'], 'Blade Draw', 'foley', ['metallic', 'short']),
    ...set('wood', 'rpg', ['Audio/chop.ogg'], 'Wood Chop', 'foley', ['wood', 'punchy', 'short']),

    ...set('glass', 'impact', range(0, 4).map((n) => `Audio/impactGlass_heavy_${pad3(n)}.ogg`), 'Glass Knock', 'foley', ['glass', 'short', 'bright']),
    ...set('plates', 'impact', range(0, 4).map((n) => `Audio/impactPlate_heavy_${pad3(n)}.ogg`), 'Plate Hit Hard', 'foley', ['ceramic', 'short', 'bright']),
    ...set('plates', 'impact', range(0, 4).map((n) => `Audio/impactPlate_medium_${pad3(n)}.ogg`), 'Plate Hit', 'foley', ['ceramic', 'short']),
    ...set('plates', 'impact', [0, 2, 3, 4].map((n) => `Audio/impactPlate_light_${pad3(n)}.ogg`), 'Plate Tap', 'foley', ['ceramic', 'short', 'soft']),
    ...set('metal', 'impact', range(0, 4).map((n) => `Audio/impactTin_medium_${pad3(n)}.ogg`), 'Tin Can Hit', 'foley', ['metallic', 'short']),
    ...set('metal', 'impact', [1, 2, 3].map((n) => `Audio/impactMining_${pad3(n)}.ogg`), 'Pick Strike', 'foley', ['metallic', 'hard']),
    ...set('wood', 'impact', ['Audio/impactPlank_medium_000.ogg'], 'Plank Hit', 'foley', ['wood', 'short']),
    ...set('steps', 'impact', range(0, 4).map((n) => `Audio/footstep_snow_${pad3(n)}.ogg`), 'Snow Step', 'foley', ['crunch', 'short']),
    ...set('steps', 'impact', range(0, 4).map((n) => `Audio/footstep_grass_${pad3(n)}.ogg`), 'Grass Step', 'foley', ['crunch', 'short']),
    ...set('steps', 'impact', range(1, 4).map((n) => `Audio/footstep_concrete_${pad3(n)}.ogg`), 'Concrete Step', 'foley', ['short']),
    ...set('steps', 'impact', [0, 1, 3].map((n) => `Audio/footstep_carpet_${pad3(n)}.ogg`), 'Carpet Step', 'foley', ['soft', 'short']),

    ...set('switches', 'ui', [2, 4, 6, 7, 8, 10, 11, 19, 20, 21, 24, 29, 33, 34, 36, 38].map((n) => `Audio/switch${n}.ogg`), 'Switch Click', 'foley', ['click', 'short']),

    ...set('keys', 'keyboard', range(1, 16).map((n) => `Single Keys/keypress-${pad3(n)}.wav`), 'Key Press', 'foley', ['click', 'short', 'keyboard']),
    ...set('keys', 'keyboard', range(1, 4).map((n) => `Human Typing/human_vel-${pad3(n)}.wav`), 'Keyboard Typing', 'foley', ['click', 'keyboard', 'long'], LOFI),
    ...set('clicks', 'clicks', [1, 5, 6, 7, 8, 9, 10, 13, 15, 23, 34, 35, 41, 44, 57, 62, 67, 68, 69, 70, 71, 72, 73, 74, 76].map((n) => `click${n}.wav`), 'Clicky', 'foley', ['click', 'short']),
    ...set('paper', 'paper', ['WAV/Paper Crushed - 1.wav', 'WAV/Paper Crushed - 2.wav'], 'Paper Crumple', 'foley', ['paper', 'short']),
    ...set('paper', 'paper', ['WAV/Paper Ripped - 1.wav'], 'Paper Rip', 'foley', ['paper', 'short']),
    ...set('paper', 'paper', range(1, 4).map((n) => `WAV/Paper Sound - ${n}.wav`), 'Paper Handling', 'foley', ['paper']),
    ...set('books', 'books', [4, 5, 6, 8, 10].map((n) => `book_flip.${n}.ogg`), 'Book Flip', 'foley', ['paper', 'short']),
    ...set('clock', 'ticks', range(1, 4).map((n) => `ticking clock - tick${n}.wav`), 'Clock Tick', 'foley', ['click', 'short', 'wood']),
    one('clock', 'clock', '.wav', 'Clock Ticking', 'foley', ['click', 'loop'], LOFI),
    one('tape', 'tapeOpen', '.wav', 'Tape Deck Open', 'foley', ['tape', 'click', 'vintage'], LOFI),
    one('tape', 'tapeClose', '.wav', 'Tape Deck Close', 'foley', ['tape', 'click', 'vintage'], LOFI),
    one('metal', 'bing', '.wav', 'Metal Bing', 'foley', ['metallic', 'bright']),
    one('metal', 'bong', '.wav', 'Metal Bong', 'foley', ['metallic', 'deep']),
    one('metal', 'thud', '.wav', 'Metal Thud', 'foley', ['metallic', 'short']),
    one('glass', 'glass', '.wav', 'Glass Smash', 'foley', ['glass', 'bright']),
    one('snaps', 'snap1', '.wav', 'Finger Snap 1', 'snap', ['short', 'organic'], PERC),
    one('snaps', 'snap2', '.wav', 'Finger Snap 2', 'snap', ['short', 'organic'], PERC),
    one('snaps', 'snap3', '.wav', 'Finger Snap 3', 'snap', ['short', 'organic'], PERC),
    one('paper', 'paperRustle', '.wav', 'Paper Rustle', 'foley', ['paper', 'texture']),
    one('cloth', 'fabric', '.ogg', 'Fabric Rustles', 'foley', ['cloth', 'soft', 'long']),

    one('ambience', 'rain', '.ogg', 'Steady Rain Long', 'ambience', ['rain', 'long', 'organic'], AMB),
    ...set('ambience', 'rainloops', range(1, 4).map((n) => `${n}.ogg`), 'Rain At The Window', 'ambience', ['rain', 'loop', 'organic'], AMB),
    one('ambience', 'thunder', '.ogg', 'Rain And Thunder', 'ambience', ['rain', 'thunder', 'dark'], [...AMB, 'trap', 'drill']),
    one('ambience', 'morning', '.ogg', 'Morning Birds', 'ambience', ['birds', 'outdoors', 'loop'], AMB),
    one('ambience', 'outdoors', '.wav', 'Evening Outdoors', 'ambience', ['outdoors', 'loop'], AMB),
    one('ambience', 'road', '.ogg', 'Busy Road', 'ambience', ['city', 'traffic'], [...AMB, 'trap', 'drill', 'boom-bap']),
    one('ambience', 'applause', '.wav', 'Applause In A Hall', 'ambience', ['crowd', 'applause', 'wide'], ['pop', 'rnb', 'lofi', 'boom-bap', 'edm']),
    one('ambience', 'fireplace', '.wav', 'Fireplace Crackle', 'texture', ['fire', 'crackle', 'warm'], LOFI),
    ...set('ambience', 'shop', ['TheShopCollection_convenience_store_drinks_fridge_drone.wav', 'TheShopCollection_convenience_store_drinks_fridge_drone_2.wav'], 'Fridge Hum Room Tone', 'texture', ['room', 'hum', 'drone'], AMB),
  ],
};
