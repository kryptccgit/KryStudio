// ──────────────────────────────────────────────────────────────────────
// The docked Guides panel (PANELS.guides, right dock): the same article view
// as the Home guides screen, narrow. A grouped picker instead of the
// sidebar, search with snippets, Previous / Next. F1 and Help ▸ Guides open
// it while the Studio is showing (openGuides in src/home/store.ts). It
// remembers the open article and each article's scroll for the session,
// across closing and reopening, floating and docking.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clapperboard, Maximize2 } from 'lucide-react';
import { cls } from '../utils/format';
import { openGuidesScreen } from '../home/store';
import { FOCUS_RING } from '../home/ui';
import { ARTICLES, articleById } from './articles';
import { GuideArticleView, GuideNavProvider, SearchResults, type GuideNav } from './GuideBody';
import { GuidePicker, GuideSearch, useArticleScroll } from './GuidesView';
import { orderedArticles, searchGuides } from './search';
import { panelScroll, savePanelScroll, setPanelArticle, useGuides } from './store';
import { VIDEOS_ARTICLE } from './videos';

const ICON_BTN = cls(
  'inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/75 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-40',
  FOCUS_RING,
);

export function GuidesPanel() {
  const articleId = useGuides((s) => s.panelArticle);
  const article = articleById(articleId) ?? ARTICLES[0];
  const [query, setQuery] = useState('');
  const paneRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const searching = q.length > 0;
  const hits = useMemo(() => searchGuides(q), [q]);
  const ordered = useMemo(() => orderedArticles(), []);
  const index = ordered.findIndex((a) => a.id === article.id);
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;

  const pick = (id: string, heading?: string): void => {
    setQuery('');
    setPanelArticle(id, heading);
  };
  const nav = useMemo<GuideNav>(() => ({ variant: 'panel', open: (id, heading) => pick(id, heading) }), []);

  useArticleScroll('panel', article, paneRef, searching, panelScroll);

  // Remember where each article was scrolled to (read back on return and on remount).
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || searching) return;
    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => savePanelScroll(article.id, pane.scrollTop));
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      pane.removeEventListener('scroll', onScroll);
    };
  }, [article.id, searching]);

  return (
    <GuideNavProvider nav={nav}>
      <div className="flex h-full flex-col bg-krypt-void">
        <div className="flex flex-shrink-0 flex-col gap-2 border-b border-white/10 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <GuideSearch query={query} setQuery={setQuery} onEnter={() => hits[0] && pick(hits[0].article.id)} className="min-w-0 flex-1" />
            <button
              type="button"
              className={cls(ICON_BTN, !searching && article.id === VIDEOS_ARTICLE && 'border-krypt-purple/40 text-purple-200')}
              onClick={() => pick(VIDEOS_ARTICLE)}
              aria-label="Video tutorials"
              data-hint="Video tutorials"
            >
              <Clapperboard className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={ICON_BTN} onClick={() => openGuidesScreen(article.id)} aria-label="Open the guides full screen on Home" data-hint="Read this guide full screen on Home">
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={ICON_BTN} disabled={!prev} onClick={() => prev && pick(prev.id)} aria-label={prev ? `Previous guide: ${prev.title}` : 'No previous guide'} data-hint={prev ? `Previous: ${prev.title}` : undefined}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <GuidePicker value={article.id} onPick={(id) => pick(id)} className="flex-1" />
            <button type="button" className={ICON_BTN} disabled={!next} onClick={() => next && pick(next.id)} aria-label={next ? `Next guide: ${next.title}` : 'No next guide'} data-hint={next ? `Next: ${next.title}` : undefined}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div ref={paneRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto bg-[#0b0b11]/80 outline-none" aria-label={searching ? 'Search results' : article.title}>
          {searching ? <SearchResults query={q} hits={hits} onPick={(id) => pick(id)} compact /> : <GuideArticleView article={article} compact />}
        </div>
      </div>
    </GuideNavProvider>
  );
}
