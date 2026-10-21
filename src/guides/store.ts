// ──────────────────────────────────────────────────────────────────────
// Guides UI state for this session: the article open in the docked Guides
// panel (the Home guides screen keeps its own in src/home/store.ts), where
// each article was scrolled to in the panel, which sidebar groups are
// collapsed, and pending "jump to this heading" requests from
// [[guide:id#heading]] links. In memory only: a new session starts fresh.
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { wm } from '../workspace/WindowManager';
import { DEFAULT_ARTICLE, articleById, type GuideGroup } from './articles';

export type GuidesVariant = 'page' | 'panel';

interface GuidesState {
  /** Article shown in the Guides panel. */
  panelArticle: string;
  /** Collapsed sidebar groups (Home guides screen). */
  collapsed: GuideGroup[];
  /** A heading to scroll to once the view shows that article. */
  heading: { view: GuidesVariant; article: string; anchor: string; nonce: number } | null;
}

export const useGuides = create<GuidesState>(() => ({ panelArticle: DEFAULT_ARTICLE, collapsed: [], heading: null }));

/** Ask a view to scroll to a ## heading of an article once it shows it. */
export function requestHeading(view: GuidesVariant, article: string, anchor: string | undefined): void {
  useGuides.setState({ heading: anchor ? { view, article, anchor, nonce: Date.now() } : null });
}

export function clearHeading(nonce: number): void {
  if (useGuides.getState().heading?.nonce === nonce) useGuides.setState({ heading: null });
}

export function setPanelArticle(id: string, heading?: string): void {
  if (!articleById(id)) return;
  useGuides.setState({ panelArticle: id });
  requestHeading('panel', id, heading);
}

/**
 * Open (or bring forward) the docked Guides panel, optionally on an article. False when the workspace isn't ready
 * (the caller falls back to the Home guides screen).
 */
export function openGuidesPanel(articleId?: string, heading?: string): boolean {
  if (!wm.ready) return false;
  if (articleId && articleById(articleId)) setPanelArticle(articleId, heading);
  wm.open('guides');
  return true;
}

export function toggleGroup(g: GuideGroup): void {
  const c = useGuides.getState().collapsed;
  useGuides.setState({ collapsed: c.includes(g) ? c.filter((x) => x !== g) : [...c, g] });
}

// Panel scroll per article (no re-render needed, so not in the store).
const scrolls = new Map<string, number>();

export function panelScroll(article: string): number {
  return scrolls.get(article) ?? 0;
}

export function savePanelScroll(article: string, top: number): void {
  scrolls.set(article, top);
}
