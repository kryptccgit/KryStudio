import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import { PLAYBOOKS } from '@shared/playbooks';
import { SAMPLE_KINDS } from '@shared/sounds/types';
import { ARTICLES, GUIDE_GROUPS, articleById, type GuideArticle } from '../src/guides/articles';
import { GUIDE_ANCHORS, isGuideAnchor } from '../src/guides/anchors';
import { ICONS } from '../src/guides/icons';
import { kindRows, playbookById, playbookFacts, playbookIds } from '../src/guides/facts';
import {
  SHOW_ME,
  blockInlines,
  guideActionIds,
  guideHeadings,
  guideLinks,
  guidePlaybookIds,
  guideShowAnchors,
  inlineText,
  parseGuide,
  parseInline,
} from '../src/guides/markup';
import { blocksOf, orderedArticles, queryTerms, relatedArticles, searchGuides } from '../src/guides/search';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const SRC = path.join(repoRoot(), 'src');

test('inline show links: with and without a label, never mistaken for a key', () => {
  const runs = parseInline('Find [[show:transport.tempo|the tempo box]] or [[show:mixer.master]], then press [[F5]].');
  assert.deepEqual(
    runs.map((r) => r.t),
    ['text', 'show', 'text', 'show', 'text', 'kbd', 'text'],
  );
  assert.deepEqual(runs[1], { t: 'show', anchor: 'transport.tempo', label: 'the tempo box' });
  assert.deepEqual(runs[3], { t: 'show', anchor: 'mixer.master', label: SHOW_ME });
  assert.equal(inlineText(runs), `Find the tempo box or ${SHOW_ME}, then press F5.`);
});

test('inline guide links: plain, to a heading, without a label', () => {
  const runs = parseInline('See [[guide:mixer|the Mixer guide]], [[guide:piano-roll#the-scale-highlight|scales]] and [[guide:exporting]].');
  const links = runs.filter((r) => r.t === 'guide');
  assert.deepEqual(links, [
    { t: 'guide', id: 'mixer', label: 'the Mixer guide' },
    { t: 'guide', id: 'piano-roll', heading: 'the-scale-highlight', label: 'scales' },
    { t: 'guide', id: 'exporting', label: '' },
  ]);
  assert.deepEqual(guideLinks(parseGuide('x [[guide:a#b|c]] y [[guide:d|e]]')), [{ id: 'a', heading: 'b' }, { id: 'd' }]);
});

test('button rows: actions only stay an actions block; a show button makes a mixed buttons block', () => {
  const b = parseGuide('[[action:studio|Go]] [[action:mixer|Mixer]]\n\n[[show:transport.play|Play button]]\n\n[[action:studio|Studio]] [[show:mixer.fxSlots|Effect slots]]');
  assert.deepEqual(
    b.map((x) => x.type),
    ['actions', 'buttons', 'buttons'],
  );
  assert.deepEqual((b[0] as { items: unknown }).items, [
    { id: 'studio', label: 'Go' },
    { id: 'mixer', label: 'Mixer' },
  ]);
  assert.deepEqual((b[2] as { items: unknown }).items, [
    { t: 'action', id: 'studio', label: 'Studio' },
    { t: 'show', anchor: 'mixer.fxSlots', label: 'Effect slots' },
  ]);
  assert.deepEqual(guideActionIds(b), ['studio', 'mixer']);
  assert.deepEqual(guideShowAnchors(b), ['transport.play', 'mixer.fxSlots']);
});

test('generated blocks: playbook and kinds; an unknown {{…}} line stays visible text and never hangs the parser', () => {
  const b = parseGuide('## Trap\n\n{{playbook:trap}}\n\n{{kinds}}\n\n{{nope}}\n\n{{playbook:}}\ntext after');
  assert.deepEqual(
    b.map((x) => x.type),
    ['h2', 'playbook', 'kinds', 'p', 'p'],
  );
  assert.equal((b[1] as { id: string }).id, 'trap');
  assert.equal(inlineText((b[3] as { text: Parameters<typeof inlineText>[0] }).text), '{{nope}}');
  assert.equal(inlineText((b[4] as { text: Parameters<typeof inlineText>[0] }).text), '{{playbook:}} text after');
  assert.deepEqual(guidePlaybookIds(b), ['trap']);
  assert.deepEqual(guideHeadings(b), [{ anchor: 'trap', text: 'Trap' }]);
});

test('links with labels inside table cells keep their | (not split into cells)', () => {
  const [t] = parseGuide('| Synth | Notes |\n|---|---|\n| 808 | see [[guide:bass-808|Bass and 808s]] or [[show:mixer.master|the master]] |');
  assert.equal(t.type, 'table');
  const rows = (t as Extract<ReturnType<typeof parseGuide>[number], { type: 'table' }>).rows;
  assert.equal(rows[0].length, 2);
  assert.deepEqual(
    rows[0][1].map((r) => r.t),
    ['text', 'guide', 'text', 'show'],
  );
});

test('every article has a known group, an icon in ICONS, and every group has articles', () => {
  for (const a of ARTICLES) {
    assert.ok(GUIDE_GROUPS.includes(a.group), `${a.id}: unknown group ${a.group}`);
    assert.ok(Object.prototype.hasOwnProperty.call(ICONS, a.icon), `${a.id}: icon "${a.icon}" isn't in ICONS (src/guides/icons.ts)`);
  }
  for (const g of GUIDE_GROUPS) assert.ok(ARTICLES.some((a) => a.group === g), `empty group ${g}`);
});

test('every [[show:…]] in an article is a GUIDE_ANCHORS id', () => {
  for (const a of ARTICLES) {
    for (const id of guideShowAnchors(blocksOf(a))) assert.ok(isGuideAnchor(id), `${a.id}: [[show:${id}]] isn't in src/guides/anchors.ts`);
  }
});

test('every [[guide:…]] link resolves to an article (and its #heading to one of that article’s ## headings)', () => {
  for (const a of ARTICLES) {
    for (const l of guideLinks(blocksOf(a))) {
      const target = articleById(l.id);
      assert.ok(target, `${a.id}: [[guide:${l.id}]] is not an article`);
      if (l.heading) {
        const anchors = guideHeadings(blocksOf(target)).map((h) => h.anchor);
        assert.ok(anchors.includes(l.heading), `${a.id}: [[guide:${l.id}#${l.heading}]]: no such ## heading (has ${anchors.join(', ')})`);
      }
    }
  }
});

test('every {{playbook:…}} names a real playbook, and no unknown {{…}} block is left in an article', () => {
  for (const a of ARTICLES) {
    const blocks = blocksOf(a);
    for (const id of guidePlaybookIds(blocks)) assert.ok(playbookById(id), `${a.id}: {{playbook:${id}}} is not a playbook (ids: ${playbookIds().join(', ')})`);
    for (const r of blockInlines(blocks)) if (r.t === 'text') assert.ok(!/\{\{|\}\}/.test(r.v), `${a.id}: unknown generated block in "${r.v.slice(0, 60)}"`);
  }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test('every GUIDE_ANCHORS id is placed on a real element (data-guide) somewhere under src/', () => {
  const texts = sourceFiles(SRC)
    .filter((f) => !f.includes(`${path.sep}guides${path.sep}`))
    .map((f) => readFileSync(f, 'utf8'))
    .filter((t) => t.includes('data-guide'));
  assert.ok(texts.length > 0, `no data-guide attributes found under ${SRC}`);
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of Object.keys(GUIDE_ANCHORS)) {
    const q = `["']${esc(id)}["']`;
    const re = new RegExp(`data-guide=(?:${q}|\\{\\s*${q}\\s*\\}|\\{[^}]*\\?\\s*${q})|\\bguide:\\s*${q}`);
    assert.ok(
      texts.some((t) => re.test(t)),
      `anchor ${id} (${GUIDE_ANCHORS[id as keyof typeof GUIDE_ANCHORS].label}) has no data-guide="${id}" element`,
    );
  }
});

const fixture = (id: string, title: string, body: string, group: GuideArticle['group'] = 'Make music', summary = 'A guide.'): GuideArticle => ({ id, title, summary, group, icon: 'book', body });

const FIX: GuideArticle[] = [
  fixture('in-body', 'Arranging', '## Sections\n\nAdd a **riser** before the drop so the hook lands.'),
  fixture('in-heading', 'Transitions', '## Riser and impact\n\nPlace them at section boundaries.'),
  fixture('in-title', 'Riser basics', '## What\n\nNothing else here.'),
  fixture('none', 'Mixing', '## Levels\n\nGain staging first.', 'Mixing'),
];

test('search: title beats headings beats body, every word must match, snippets show the match', () => {
  assert.deepEqual(searchGuides('', FIX), []);
  assert.deepEqual(queryTerms('  "Riser,"  DROP '), ['riser', 'drop']);
  const hits = searchGuides('riser', FIX);
  assert.deepEqual(
    hits.map((h) => h.article.id),
    ['in-title', 'in-heading', 'in-body'],
  );
  assert.deepEqual(
    hits.map((h) => h.field),
    ['title', 'heading', 'body'],
  );
  const body = hits.find((h) => h.article.id === 'in-body')!;
  assert.ok(body.snippet, 'a body hit has a snippet');
  assert.equal(body.snippet!.match.toLowerCase(), 'riser');
  assert.ok(!/\*\*|\[\[/.test(body.snippet!.before + body.snippet!.after), 'snippets are markup-free');
  assert.deepEqual(
    searchGuides('riser drop', FIX).map((h) => h.article.id),
    ['in-body'],
    'all words must match',
  );
  assert.deepEqual(searchGuides('zzzz', FIX), []);
});

test('search over the real articles finds them by title', () => {
  for (const a of ARTICLES.slice(0, 10)) {
    const hits = searchGuides(a.title);
    assert.ok(hits.length > 0, `no hit for "${a.title}"`);
    assert.ok(hits.slice(0, 3).some((h) => h.article.id === a.id), `"${a.title}" isn't in its own top 3`);
  }
});

test('Related: linked articles first, then the same group, never itself, Previous or Next', () => {
  const list: GuideArticle[] = [
    fixture('a', 'A', '## x\n\nSee [[guide:z|Z]] and [[guide:c|C]] and [[guide:a|me]].'),
    fixture('b', 'B', '## x\n\ny'),
    fixture('c', 'C', '## x\n\ny'),
    fixture('d', 'D', '## x\n\ny'),
    fixture('z', 'Z', '## x\n\ny', 'Help'),
  ];
  const ordered = orderedArticles(list).map((x) => x.id);
  assert.deepEqual(ordered, ['a', 'b', 'c', 'd', 'z']);
  const rel = relatedArticles(list[0], 6, list).map((x) => x.id);
  assert.deepEqual(rel, ['z', 'c', 'd'], 'b is Next, a is itself');
  assert.deepEqual(
    relatedArticles(list[2], 6, list).map((x) => x.id),
    ['a'],
    'c: b and d are its neighbours',
  );
  for (const a of ARTICLES) assert.ok(!relatedArticles(a).some((r) => r.id === a.id));
});

test('playbook cards: every playbook builds a complete card; unknown ids give null', () => {
  assert.equal(playbookFacts('not-a-genre'), null);
  assert.equal(playbookIds().length, PLAYBOOKS.length);
  for (const p of PLAYBOOKS) {
    const f = playbookFacts(p.id);
    assert.ok(f, p.id);
    assert.equal(f.name, p.name);
    assert.ok(f.tempo.includes(String(p.bpm.min)) && f.tempo.includes(String(p.bpm.max)), `${p.id}: tempo`);
    assert.equal(f.totalBars, p.arrangement.reduce((a, s) => a + s.bars, 0));
    assert.equal(f.sections.length, p.arrangement.length);
    assert.ok(f.drums.length > 0, `${p.id}: no drum parts`);
    assert.ok(f.mix.some((m) => m.value.includes(`${p.targets.lufs} LUFS`)), `${p.id}: loudness target`);
    assert.match(f.length, /^about \d+:\d\d at \d+ BPM$/);
  }
});

test('kinds table: one row per sample kind, counted from factory and pack samples', () => {
  const rows = kindRows([{ kind: 'kick' }, { kind: 'kick' }, { kind: 'riser' }, { kind: 'mystery' }], [{ kind: 'whoosh' }, { kind: 'kick' }]);
  assert.deepEqual(
    rows.map((r) => r.kind),
    [...SAMPLE_KINDS],
  );
  const kick = rows.find((r) => r.kind === 'kick')!;
  assert.deepEqual([kick.factory, kick.packs], [2, 1]);
  assert.equal(rows.find((r) => r.kind === 'whoosh')!.packs, 1);
  assert.ok(rows.every((r) => r.label && r.label !== r.kind), 'every kind has a label');
});

void run('guides');
