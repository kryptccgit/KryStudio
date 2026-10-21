// The Wave 7b guide library (research/14-sounds-and-guides.md §3): one file per
// writer, so they never edit the same file. articles.ts appends these after
// the original articles; the sidebar orders everything by GUIDE_GROUPS.
import type { GuideArticle } from '../articles';
import { BASICS } from './basics';
import { MIXING } from './mixing';
import { GENRES } from './genres';
import { WORKFLOW } from './workflow';
import { AI } from './ai';
import { REFERENCE } from './reference';

export const LIBRARY_ARTICLES: GuideArticle[] = [...BASICS, ...MIXING, ...GENRES, ...WORKFLOW, ...AI, ...REFERENCE];
