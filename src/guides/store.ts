import { create } from 'zustand';
import { wm } from '../workspace/WindowManager';
import { DEFAULT_ARTICLE, articleById, type GuideGroup } from './articles';

export type GuidesVariant = 'page' | 'panel';

interface GuidesState {
  panelArticle: string;
  collapsed: GuideGroup[];
  heading: { view: GuidesVariant; article: string; anchor: string; nonce: number } | null;
}

export const useGuides = create<GuidesState>(() => ({ panelArticle: DEFAULT_ARTICLE, collapsed: [], heading: null }));

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

const scrolls = new Map<string, number>();

export function panelScroll(article: string): number {
  return scrolls.get(article) ?? 0;
}

export function savePanelScroll(article: string, top: number): void {
  scrolls.set(article, top);
}
