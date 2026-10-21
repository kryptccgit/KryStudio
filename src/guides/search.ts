import { ARTICLES, GUIDE_GROUPS, type GuideArticle } from './articles';
import { blockInlines, guideLinks, inlineText, parseGuide, type GuideBlock } from './markup';

export function orderedArticles(list: readonly GuideArticle[] = ARTICLES): GuideArticle[] {
  return GUIDE_GROUPS.flatMap((g) => list.filter((a) => a.group === g));
}

const parsed = new Map<string, GuideBlock[]>();

export function blocksOf(a: GuideArticle): GuideBlock[] {
  const key = `${a.id}\u0000${a.body.length}`;
  let b = parsed.get(key);
  if (!b) {
    b = parseGuide(a.body);
    parsed.set(key, b);
  }
  return b;
}

interface Indexed {
  title: string;
  summary: string;
  headings: string;
  body: string;
  bodyLower: string;
}

const indexCache = new Map<string, Indexed>();

function indexOf(a: GuideArticle): Indexed {
  const key = `${a.id}\u0000${a.body.length}`;
  let ix = indexCache.get(key);
  if (!ix) {
    const blocks = blocksOf(a);
    const headings = blocks.flatMap((b) => (b.type === 'h2' || b.type === 'h3' ? [inlineText(b.text)] : [])).join(' • ');
    const body = inlineText(blockInlines(blocks.filter((b) => b.type !== 'h2' && b.type !== 'h3')))
      .replace(/\s+/g, ' ')
      .trim();
    ix = { title: a.title.toLowerCase(), summary: a.summary.toLowerCase(), headings: headings.toLowerCase(), body, bodyLower: body.toLowerCase() };
    indexCache.set(key, ix);
  }
  return ix;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface SearchHit {
  article: GuideArticle;
  score: number;
  field: 'title' | 'heading' | 'summary' | 'body';
  snippet: Snippet | null;
}

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, ''))
    .filter(Boolean);
}

const wordStart = (text: string, i: number): boolean => i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]);

function snippetAt(text: string, at: number, len: number, radius = 60): Snippet {
  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, at + len + radius * 1.4);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < at) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > at + len) end = sp;
  }
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + len),
    after: text.slice(at + len, end) + (end < text.length ? '…' : ''),
  };
}

export function searchGuides(query: string, list: readonly GuideArticle[] = ARTICLES): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const order = orderedArticles(list);
  const phrase = terms.join(' ');
  const hits: SearchHit[] = [];
  for (const a of order) {
    const ix = indexOf(a);
    let score = 0;
    let best: SearchHit['field'] = 'body';
    let bestRank = 0;
    let ok = true;
    for (const t of terms) {
      const ti = ix.title.indexOf(t);
      const hi = ix.headings.indexOf(t);
      const si = ix.summary.indexOf(t);
      const bi = ix.bodyLower.indexOf(t);
      let s = 0;
      let field: SearchHit['field'] | null = null;
      let rank = 0;
      if (ti !== -1) {
        s = 100 + (wordStart(ix.title, ti) ? 20 : 0);
        field = 'title';
        rank = 4;
      } else if (hi !== -1) {
        s = 40 + (wordStart(ix.headings, hi) ? 8 : 0);
        field = 'heading';
        rank = 3;
      } else if (si !== -1) {
        s = 30 + (wordStart(ix.summary, si) ? 6 : 0);
        field = 'summary';
        rank = 2;
      } else if (bi !== -1) {
        s = 10 + (wordStart(ix.bodyLower, bi) ? 2 : 0);
        field = 'body';
        rank = 1;
      }
      if (!field) {
        ok = false;
        break;
      }
      if (bi !== -1) s += Math.min(8, ix.bodyLower.split(t).length - 1);
      score += s;
      if (rank > bestRank) {
        bestRank = rank;
        best = field;
      }
    }
    if (!ok) continue;
    if (terms.length > 1 && (ix.title.includes(phrase) || ix.bodyLower.includes(phrase))) score += 25;
    let snippet: Snippet | null = null;
    for (const t of [phrase, ...terms]) {
      const bi = ix.bodyLower.indexOf(t);
      if (bi !== -1) {
        snippet = snippetAt(ix.body, bi, t.length);
        break;
      }
    }
    if (!snippet) {
      const si = a.summary.toLowerCase().indexOf(terms[0]);
      if (si !== -1) snippet = snippetAt(a.summary, si, terms[0].length);
    }
    hits.push({ article: a, score, field: best, snippet });
  }
  return hits.sort((x, y) => y.score - x.score);
}

export function relatedArticles(a: GuideArticle, max = 6, list: readonly GuideArticle[] = ARTICLES): GuideArticle[] {
  const order = orderedArticles(list);
  const i = order.findIndex((x) => x.id === a.id);
  const skip = new Set([a.id, order[i - 1]?.id, order[i + 1]?.id].filter(Boolean) as string[]);
  const byId = new Map(order.map((x) => [x.id, x]));
  const out: GuideArticle[] = [];
  const add = (x: GuideArticle | undefined): void => {
    if (x && !skip.has(x.id) && !out.includes(x) && out.length < max) out.push(x);
  };
  for (const l of guideLinks(blocksOf(a))) add(byId.get(l.id));
  for (const x of order) if (x.group === a.group) add(x);
  return out;
}
