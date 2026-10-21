// ──────────────────────────────────────────────────────────────────────
// Guides on Home: a full-screen sidebar of articles (groups collapsible,
// searchable) and a reading pane. Reached from the Home card, the corner
// pill, and Help ▸ Guides / F1 while Home is up (with the Studio showing
// they open the docked panel, ./GuidesPanel.tsx, instead). The article view
// itself is shared with the panel (./GuideBody.tsx). Buttons in an article
// run the same actions as the Home cards; generated blocks (shortcuts,
// plugin tables, genre cards, sound kinds) are built from live data.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, BookOpen, ChevronRight, Clapperboard, PanelRightOpen, Search, X } from 'lucide-react';
import { toast } from '../app/notify';
import { cls } from '../utils/format';
import { goBack, setGuideArticle, useHome } from '../home/store';
import { FOCUS_RING } from '../home/ui';
import { wm } from '../workspace/WindowManager';
import { ARTICLES, GUIDE_GROUPS, articleById, type GuideArticle } from './articles';
import { GuideArticleView, GuideNavProvider, SearchResults, scrollToHeading, type GuideNav } from './GuideBody';
import { orderedArticles, searchGuides } from './search';
import { clearHeading, openGuidesPanel, toggleGroup, useGuides, type GuidesVariant } from './store';
import { iconOf } from './icons';
import { VIDEOS_ARTICLE } from './videos';

export { ICONS } from './icons';

/** Search box shared by both hosts: Esc clears first (the next Esc goes back), Enter opens the top hit. */
export function GuideSearch({ query, setQuery, onEnter, className }: { query: string; setQuery: (q: string) => void; onEnter: () => void; className?: string }) {
  return (
    <label className={cls('relative', className)}>
      <span className="sr-only">Search the guides</span>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-krypt-muted" aria-hidden="true" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          } else if (e.key === 'Enter') onEnter();
        }}
        placeholder="Search guides"
        className="h-8 w-full rounded-xl border border-white/10 bg-black/40 pl-8 pr-7 text-[12.5px] text-white placeholder-krypt-muted/60 outline-none focus:border-krypt-purple/60"
      />
      {query && (
        <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-krypt-muted hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </label>
  );
}

/** The narrow picker: every article, grouped. */
export function GuidePicker({ value, onPick, className }: { value: string; onPick: (id: string) => void; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onPick(e.target.value)}
      aria-label="Choose a guide"
      className={cls('h-8 w-full min-w-0 rounded-xl border border-white/10 bg-[#0e0e17] px-2 text-[12.5px] text-white outline-none focus:border-krypt-purple/60', className)}
    >
      {GUIDE_GROUPS.map((g) => {
        const list = ARTICLES.filter((a) => a.group === g);
        return list.length ? (
          <optgroup key={g} label={g}>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

/**
 * Article changes and heading jumps in a scroll pane: a pending [[guide:id#heading]] scrolls to its heading (a
 * missing one toasts), otherwise the pane goes to `restore(id)` (the top, or the panel's remembered position).
 */
export function useArticleScroll(variant: GuidesVariant, article: GuideArticle, paneRef: RefObject<HTMLDivElement>, searching: boolean, restore: (id: string) => number): void {
  const heading = useGuides((s) => s.heading);
  useEffect(() => {
    if (searching) return;
    const pane = paneRef.current;
    if (!pane) return;
    const h = heading && heading.view === variant && heading.article === article.id ? heading : null;
    if (h) {
      clearHeading(h.nonce);
      if (scrollToHeading(pane, h.anchor)) return;
      toast.warn(`“${article.title}” has no section called “${h.anchor}”. Showing the start of the guide.`);
      pane.scrollTo({ top: 0 });
      return;
    }
    pane.scrollTo({ top: restore(article.id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, heading?.nonce, searching]);
}

const ZERO = (): number => 0;

export function GuidesView() {
  const articleId = useHome((s) => s.article);
  const back = useHome((s) => s.guidesBack);
  const collapsed = useGuides((s) => s.collapsed);
  const article = articleById(articleId) ?? ARTICLES[0];
  const [query, setQuery] = useState('');
  const paneRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const hits = useMemo(() => searchGuides(q), [q]);
  const hitIds = useMemo(() => new Set(hits.map((h) => h.article.id)), [hits]);
  const ordered = useMemo(() => orderedArticles(), []);
  const searching = q.length > 0;

  const pick = (id: string, heading?: string): void => {
    setQuery('');
    setGuideArticle(id, heading);
  };
  const nav = useMemo<GuideNav>(() => ({ variant: 'page', open: (id, heading) => pick(id, heading) }), []);

  useArticleScroll('page', article, paneRef, searching, ZERO);
  useEffect(() => {
    paneRef.current?.focus({ preventScroll: true });
  }, [article.id]);

  const toPanel = (): void => {
    if (!openGuidesPanel(article.id)) toast.error("The Studio isn't ready yet: try again in a moment.");
  };

  return (
    <GuideNavProvider nav={nav}>
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-white/[0.07] bg-krypt-void/85 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={goBack}
            className={cls('inline-flex h-8 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-[12px] font-semibold text-white/80 transition hover:border-white/20 hover:text-white', FOCUS_RING)}
            title="Back (Esc)"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {back === 'studio' ? 'Studio' : 'Home'}
          </button>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-krypt-purple" aria-hidden="true" />
            <span className="text-[15px] font-bold tracking-tight text-white">Guides</span>
          </div>
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            <GuideSearch query={query} setQuery={setQuery} onEnter={() => hits[0] && pick(hits[0].article.id)} className="w-full sm:w-64" />
            <button
              type="button"
              onClick={() => pick(VIDEOS_ARTICLE)}
              aria-current={!searching && article.id === VIDEOS_ARTICLE ? 'page' : undefined}
              title="Video tutorials"
              className={cls(
                'inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-semibold transition hover:border-white/20 hover:text-white',
                !searching && article.id === VIDEOS_ARTICLE ? 'border-krypt-purple/40 bg-krypt-purple/[0.12] text-purple-200' : 'border-white/10 bg-white/[0.04] text-white/80',
                FOCUS_RING,
              )}
            >
              <Clapperboard className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Videos</span>
            </button>
            {wm.ready && (
              <button
                type="button"
                onClick={toPanel}
                title="Open this guide in a panel beside the Studio (F1 there)"
                className={cls('inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-[12px] font-semibold text-white/80 transition hover:border-white/20 hover:text-white', FOCUS_RING)}
              >
                <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Beside the Studio</span>
              </button>
            )}
          </div>
          {/* Narrow windows: a picker instead of the sidebar */}
          <GuidePicker value={article.id} onPick={(id) => pick(id)} className="md:hidden" />
        </div>

        <div className="flex min-h-0 flex-1">
          <nav aria-label="Guides" className="hidden w-64 flex-shrink-0 overflow-y-auto border-r border-white/[0.07] bg-krypt-void/80 px-3 py-4 md:block">
            {GUIDE_GROUPS.map((g) => {
              const list = ordered.filter((a) => a.group === g && (!searching || hitIds.has(a.id)));
              if (!list.length) return null;
              const closed = !searching && collapsed.includes(g);
              return (
                <div key={g} className="mb-3">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g)}
                    aria-expanded={!closed}
                    className={cls('flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted transition hover:text-white', FOCUS_RING)}
                  >
                    <ChevronRight className={cls('h-3 w-3 transition-transform', !closed && 'rotate-90')} aria-hidden="true" />
                    <span className="flex-1">{g}</span>
                    <span className="font-mono text-[10px] tracking-normal text-krypt-muted/70">{list.length}</span>
                  </button>
                  {!closed && (
                    <ul className="mt-0.5 space-y-0.5">
                      {list.map((a) => {
                        const I = iconOf(a.icon);
                        const active = a.id === article.id;
                        return (
                          <li key={a.id}>
                            <button
                              type="button"
                              onClick={() => pick(a.id)}
                              aria-current={active ? 'page' : undefined}
                              className={cls(
                                'relative flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left text-[12.5px] font-medium transition',
                                active ? 'border-white/10 bg-white/10 text-white' : 'border-transparent text-krypt-muted hover:bg-white/5 hover:text-white',
                                FOCUS_RING,
                              )}
                            >
                              {active && <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-r-full bg-krypt-gradient" />}
                              <I className={cls('h-3.5 w-3.5 flex-shrink-0', active && 'text-krypt-purple')} aria-hidden="true" />
                              <span className="truncate">{a.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </nav>

          <div ref={paneRef} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto bg-[#0b0b11]/80 outline-none" aria-label={searching ? 'Search results' : article.title}>
            {searching ? <SearchResults query={q} hits={hits} onPick={(id) => pick(id)} /> : <GuideArticleView article={article} />}
          </div>
        </div>
      </div>
    </GuideNavProvider>
  );
}
