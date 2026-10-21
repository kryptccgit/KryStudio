import type { GuideArticle } from '../articles';
import { BASICS } from './basics';
import { MIXING } from './mixing';
import { GENRES } from './genres';
import { WORKFLOW } from './workflow';
import { AI } from './ai';
import { REFERENCE } from './reference';

export const LIBRARY_ARTICLES: GuideArticle[] = [...BASICS, ...MIXING, ...GENRES, ...WORKFLOW, ...AI, ...REFERENCE];
