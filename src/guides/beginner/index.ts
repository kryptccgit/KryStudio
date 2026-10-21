import type { GuideArticle } from '../articles';
import { START } from './start';
import { WINDOWS } from './windows';
import { FIRST_BEAT } from './firstBeat';
import { TRANSPORT } from './transport';
import { SAVE_EXPORT } from './saveExport';
import { MASTER } from './master';
import { AI_SETUP } from './ai';
import { HELP } from './help';

export const BEGINNER_GROUP = 'Start here (step by step)' as const;
export const BEGINNER_FIRST = START.id;

export const BEGINNER_ARTICLES: GuideArticle[] = [START, WINDOWS, FIRST_BEAT, TRANSPORT, SAVE_EXPORT, MASTER, AI_SETUP, HELP];
