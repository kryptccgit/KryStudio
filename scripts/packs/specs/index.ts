import type { AnySpec } from '../lib';
import { FOLEY_FIELD } from './foley-field';
import { GRAND_PIANO } from './grand-piano';
import { HITS_WHOOSHES } from './hits-whooshes';
import { KEYS_MALLETS } from './keys-mallets';
import { LIVE_DRUMS } from './live-drums';
import { ORCHESTRAL } from './orchestral';
import { PERC_EXTRAS } from './perc-extras';
import { RETRO_GAME } from './retro-game';
import { UPRIGHT_PIANO } from './upright-piano';

export const SPECS: AnySpec[] = [GRAND_PIANO, UPRIGHT_PIANO, LIVE_DRUMS, KEYS_MALLETS, ORCHESTRAL, FOLEY_FIELD, HITS_WHOOSHES, PERC_EXTRAS, RETRO_GAME];
