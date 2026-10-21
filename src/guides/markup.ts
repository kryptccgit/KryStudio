// ──────────────────────────────────────────────────────────────────────
// The tiny markup the Guides are written in (no markdown dependency; pure,
// tested in test/home.test.ts and test/guides.test.ts). Blocks are
// separated by blank lines:
//
//   ## Heading              ### Smaller heading
//   plain lines             → one paragraph
//   - item                  → bullet list          1. step  → numbered steps (a list may start
//                                                            at any number: "4. …" after a picture)
//   | a | b |               → table (first row = header; |---| rows skipped)
//   > text                  → tip                  !> text  → heads-up
//   [[action:id|Label]]     → on a line of its own: a row of buttons (Home actions)
//   [[show:anchor|Label]]   → on a line of its own: a row of "Show me" buttons
//                             (one row may mix action and show buttons)
//   {{shortcuts}}           → the live keymap      {{catalog:effect}} / {{catalog:instrument}}
//   {{playbook:<genreId>}}  → a fact card built live from shared/playbooks
//   {{kinds}}               → the sample kinds table, counted from the installed library
//   {{video:<id>}}          → a tutorial video player (shared/guides/videos.ts); a video that
//                             isn't shipped yet renders nothing, so there's never a broken player
//   {{videos}}              → the Videos index: every tutorial video as a card
//   {{image:<file>|<caption>}} → an annotated screenshot from resources/guides/images
//                             (shared/guides/images.ts): alt text = caption, click to enlarge;
//                             a file that isn't there shows an "image missing" note
//
// Inline:
//   **bold**, `code`, [[Ctrl+S]] (a key), [[action:id|label]] (a link button)
//   [[show:<anchor>|label]]  opens GUIDE_ANCHORS[anchor].panel (./anchors.ts),
//                            scrolls to the element with data-guide="<anchor>"
//                            and pulses a ring around it ("Show me" without a label)
//   [[guide:<articleId>|label]] / [[guide:<articleId>#<heading>|label]]
//                            a link to another article, optionally to one of its
//                            ## headings (anchorOf(heading text)); no label = its title
//
// Unknown {{…}} lines stay visible as text (the tests flag them).
// ──────────────────────────────────────────────────────────────────────

import { guideVideoById, isVideoReady } from '@shared/guides/videos';
import { isGuideImageFile } from '@shared/guides/images';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; v: string }
  | { t: 'code'; v: string }
  | { t: 'kbd'; v: string }
  | { t: 'action'; id: string; label: string }
  | { t: 'show'; anchor: string; label: string }
  /** label '' = use the article's title. */
  | { t: 'guide'; id: string; heading?: string; label: string };

export type ButtonLink = Extract<Inline, { t: 'action' }> | Extract<Inline, { t: 'show' }>;

export type GuideBlock =
  | { type: 'h2'; text: Inline[]; anchor: string }
  | { type: 'h3'; text: Inline[] }
  | { type: 'p'; text: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  /** `start`: the first step's number when it isn't 1 (a list carried on after a screenshot). */
  | { type: 'ol'; items: Inline[][]; start?: number }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { type: 'tip'; text: Inline[] }
  | { type: 'warn'; text: Inline[] }
  /** A row of Home-action buttons only. */
  | { type: 'actions'; items: Array<{ id: string; label: string }> }
  /** A row with at least one "Show me" button (and maybe action buttons). */
  | { type: 'buttons'; items: ButtonLink[] }
  | { type: 'shortcuts' }
  | { type: 'catalog'; kind: 'effect' | 'instrument' }
  | { type: 'playbook'; id: string }
  | { type: 'kinds' }
  | { type: 'video'; id: string }
  | { type: 'videos' }
  /** An annotated screenshot: resources/guides/images/<file>, described by `caption` (also its alt text). */
  | { type: 'image'; file: string; caption: string };

export const SHOW_ME = 'Show me';

const INLINE =
  /\*\*(.+?)\*\*|`([^`]+)`|\[\[action:([\w-]+)\|([^\]]+)\]\]|\[\[show:([\w.-]+)(?:\|([^\]]+))?\]\]|\[\[guide:([\w-]+)(?:#([\w-]+))?(?:\|([^\]]+))?\]\]|\[\[([^\]]+)\]\]/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'text', v: src.slice(last, i) });
    if (m[1] !== undefined) out.push({ t: 'b', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'action', id: m[3], label: m[4].trim() });
    else if (m[5] !== undefined) out.push({ t: 'show', anchor: m[5], label: m[6]?.trim() || SHOW_ME });
    else if (m[7] !== undefined) out.push({ t: 'guide', id: m[7], ...(m[8] ? { heading: m[8] } : {}), label: m[9]?.trim() ?? '' });
    else if (m[10] !== undefined) out.push({ t: 'kbd', v: m[10].trim() });
    last = i + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

/** Plain text of inline runs (search, headings' anchors, tests). */
export function inlineText(runs: Inline[]): string {
  return runs.map((r) => (r.t === 'action' || r.t === 'show' || r.t === 'guide' ? r.label : r.v)).join('');
}

export function anchorOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

const BUTTON = String.raw`\[\[(?:action:[\w-]+\|[^\]]+|show:[\w.-]+(?:\|[^\]]+)?)\]\]`;
const BUTTONS_LINE = new RegExp(String.raw`^(\s*${BUTTON}\s*)+$`);
const GENERATED = /^\{\{([\w-]+)(?::([\w-]+))?\}\}$/;
/** {{image:<file>|<caption>}}: a flat file name the protocol serves, and a one-line caption. */
const IMAGE = /^\{\{image:([^|{}\s]+)\|([^{}]+)\}\}$/;
const isTableSep = (l: string): boolean => /^\|?[\s:|-]+\|?$/.test(l) && l.includes('-');
/** Table cells: split on |, except inside [[…|label]] links. */
function cells(l: string): string[] {
  const s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('[[', i)) {
      depth++;
      cur += '[[';
      i++;
    } else if (depth > 0 && s.startsWith(']]', i)) {
      depth--;
      cur += ']]';
      i++;
    } else if (s[i] === '|' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

/** The generated block for a {{name}} / {{name:arg}} line, or null when the name is unknown. */
function generated(line: string): GuideBlock | null {
  const img = IMAGE.exec(line);
  if (img) {
    const caption = img[2].trim();
    return isGuideImageFile(img[1]) && caption ? { type: 'image', file: img[1], caption } : null;
  }
  const m = GENERATED.exec(line);
  if (!m) return null;
  const [, name, arg] = m;
  if (name === 'shortcuts' && !arg) return { type: 'shortcuts' };
  if (name === 'catalog' && (arg === 'effect' || arg === 'instrument')) return { type: 'catalog', kind: arg };
  if (name === 'playbook' && arg) return { type: 'playbook', id: arg };
  if (name === 'kinds' && !arg) return { type: 'kinds' };
  if (name === 'video' && arg) return { type: 'video', id: arg };
  if (name === 'videos' && !arg) return { type: 'videos' };
  return null;
}

function buttonRow(line: string): GuideBlock {
  const items = parseInline(line).filter((r): r is ButtonLink => r.t === 'action' || r.t === 'show');
  const actions = items.flatMap((r) => (r.t === 'action' ? [{ id: r.id, label: r.label }] : []));
  return actions.length === items.length ? { type: 'actions', items: actions } : { type: 'buttons', items };
}

/** Parse a guide body into blocks. Never throws: unknown lines become paragraphs. */
export function parseGuide(src: string): GuideBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: GuideBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    const gen = line.startsWith('{{') ? generated(line) : null;
    if (gen) {
      blocks.push(gen);
      i++;
    } else if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', text: parseInline(line.slice(4).trim()) });
      i++;
    } else if (line.startsWith('## ')) {
      const text = parseInline(line.slice(3).trim());
      blocks.push({ type: 'h2', text, anchor: anchorOf(inlineText(text)) });
      i++;
    } else if (BUTTONS_LINE.test(line)) {
      blocks.push(buttonRow(line));
      i++;
    } else if (/^- /.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^- /.test(lines[i].trim())) {
        let text = lines[i].trim().slice(2);
        i++;
        // continuation lines (indented, not a new item) join the item
        while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && !/^\s*(- |\d+\. )/.test(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push(parseInline(text));
      }
      blocks.push({ type: 'ul', items });
    } else if (/^\d+\. /.test(line)) {
      const items: Inline[][] = [];
      const start = parseInt(line, 10);
      while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
        let text = lines[i].trim().replace(/^\d+\.\s+/, '');
        i++;
        while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && !/^\s*(- |\d+\. )/.test(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push(parseInline(text));
      }
      blocks.push(start > 1 ? { type: 'ol', items, start } : { type: 'ol', items });
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const l = lines[i].trim();
        if (!isTableSep(l)) rows.push(cells(l));
        i++;
      }
      const [head = [], ...body] = rows;
      blocks.push({ type: 'table', head: head.map(parseInline), rows: body.map((r) => r.map(parseInline)) });
    } else if (line.startsWith('!> ') || line.startsWith('> ')) {
      const warn = line.startsWith('!> ');
      const prefix = warn ? '!> ' : '> ';
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(prefix)) parts.push(lines[i++].trim().slice(prefix.length));
      blocks.push({ type: warn ? 'warn' : 'tip', text: parseInline(parts.join(' ')) });
    } else {
      // A paragraph always takes its first line (so an unknown {{…}} line stays visible as text).
      const parts: string[] = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || /^(#{2,3} |- |\d+\. |\||> |!> |\{\{)/.test(l) || BUTTONS_LINE.test(l)) break;
        parts.push(l);
        i++;
      }
      blocks.push({ type: 'p', text: parseInline(parts.join(' ')) });
    }
  }
  return blocks;
}

/** Every inline run of a block list (search, link checks). */
/** Between blocks, list items and cells, so flattened text never glues two sentences together. */
const SPACE: Inline = { t: 'text', v: ' ' };

export function blockInlines(blocks: GuideBlock[]): Inline[] {
  const out: Inline[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'h2':
      case 'h3':
      case 'p':
      case 'tip':
      case 'warn':
        out.push(...b.text, SPACE);
        break;
      case 'ul':
      case 'ol':
        for (const it of b.items) out.push(...it, SPACE);
        break;
      case 'table':
        for (const c of b.head) out.push(...c, SPACE);
        for (const r of b.rows) for (const c of r) out.push(...c, SPACE);
        break;
      case 'actions':
        for (const a of b.items) out.push({ t: 'action', id: a.id, label: a.label });
        break;
      case 'buttons':
        out.push(...b.items);
        break;
      case 'image':
        // the caption says what the picture shows: searchable like a line of text
        out.push({ t: 'text', v: b.caption }, SPACE);
        break;
      case 'video': {
        // searchable by its title and line, once it ships
        const v = guideVideoById(b.id);
        if (isVideoReady(v)) out.push({ t: 'text', v: `Video: ${v.title}. ${v.description}` }, SPACE);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Action ids a guide links to (buttons and inline links). */
export function guideActionIds(blocks: GuideBlock[]): string[] {
  return [...new Set(blockInlines(blocks).flatMap((r) => (r.t === 'action' ? [r.id] : [])))];
}

/** "Show me" anchors a guide uses (buttons and inline links). */
export function guideShowAnchors(blocks: GuideBlock[]): string[] {
  return [...new Set(blockInlines(blocks).flatMap((r) => (r.t === 'show' ? [r.anchor] : [])))];
}

/** Other articles a guide links to, in order of mention (with the heading when one is named). */
export function guideLinks(blocks: GuideBlock[]): Array<{ id: string; heading?: string }> {
  return blockInlines(blocks).flatMap((r) => (r.t === 'guide' ? [r.heading ? { id: r.id, heading: r.heading } : { id: r.id }] : []));
}

/** Genre ids of the {{playbook:…}} cards in a guide. */
export function guidePlaybookIds(blocks: GuideBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === 'playbook' ? [b.id] : []));
}

/** Ids of the {{video:…}} players in a guide, in order. */
export function guideVideoIds(blocks: GuideBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === 'video' ? [b.id] : []));
}

/** File names of the {{image:…}} screenshots in a guide, in order. */
export function guideImageFiles(blocks: GuideBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === 'image' ? [b.file] : []));
}

/** The ## headings of a guide (targets of [[guide:id#anchor]]). */
export function guideHeadings(blocks: GuideBlock[]): Array<{ anchor: string; text: string }> {
  return blocks.flatMap((b) => (b.type === 'h2' ? [{ anchor: b.anchor, text: inlineText(b.text) }] : []));
}
