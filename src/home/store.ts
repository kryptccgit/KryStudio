import { create } from 'zustand';
import type { Settings } from '@shared/types';
import { setBareKeysBlocked } from '../input/keymap';
import { onWorkspaceReveal } from '../workspace/WindowManager';
import { useProjectStatus } from '../state/status';
import { pathKey, shouldOpenHome, type HomeScreen } from './logic';
import { DEFAULT_ARTICLE, articleById } from '../guides/articles';
import { openGuidesPanel, requestHeading } from '../guides/store';

interface HomeState {
  phase: 'pending' | 'ready';
  open: boolean;
  screen: HomeScreen;
  article: string;
  guidesBack: 'home' | 'studio';
  opens: number;
}

const K = {
  tip: 'krypt.studio.home.tip.v1',
  opened: 'krypt.studio.home.opened.v1',
  guidesSeen: 'krypt.studio.guides.seen.v1',
  welcomeSeen: 'krypt.studio.welcome.v1',
  quickstartDone: 'krypt.studio.home.quickstart.v1',
} as const;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return true;
  }
}

function setFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
  }
}

export const useHome = create<HomeState>(() => ({
  phase: 'pending',
  open: true,
  screen: 'home',
  article: DEFAULT_ARTICLE,
  guidesBack: 'home',
  opens: readJson<number>(K.tip, 0),
}));

export function getHome(): HomeState {
  return useHome.getState();
}

export function homeFlags(): { guidesSeen: boolean; welcomeSeen: boolean } {
  return { guidesSeen: readFlag(K.guidesSeen), welcomeSeen: readFlag(K.welcomeSeen) };
}

export function quickstartDismissed(): boolean {
  return readFlag(K.quickstartDone);
}

export function dismissQuickstart(): void {
  setFlag(K.quickstartDone);
}

export function openedAtMap(): Record<string, number> {
  const m = readJson<Record<string, number>>(K.opened, {});
  return m && typeof m === 'object' ? m : {};
}

export function showHome(screen: HomeScreen = 'home'): void {
  const s = getHome();
  const opening = !s.open || s.phase === 'pending';
  const opens = opening && screen === 'home' ? s.opens + 1 : s.opens;
  if (opens !== s.opens) writeJson(K.tip, opens);
  useHome.setState({ phase: 'ready', open: true, screen, opens, ...(screen === 'guides' ? { guidesBack: 'home' as const } : {}) });
}

export function showStudio(): void {
  const s = getHome();
  if (!s.open && s.phase === 'ready') return;
  useHome.setState({ phase: 'ready', open: false });
}

export function toggleHome(): void {
  const s = getHome();
  if (s.open && s.phase === 'ready') showStudio();
  else showHome('home');
}

export function openGuides(articleId?: string, heading?: string): void {
  const s = getHome();
  setFlag(K.guidesSeen);
  if (s.phase === 'ready' && !s.open && openGuidesPanel(articleId, heading)) return;
  openGuidesScreen(articleId, heading);
}

export function openGuidesScreen(articleId?: string, heading?: string): void {
  const s = getHome();
  const fromStudio = !s.open || s.phase === 'pending';
  const article = articleId && articleById(articleId) ? articleId : s.article;
  setFlag(K.guidesSeen);
  useHome.setState({ phase: 'ready', open: true, screen: 'guides', article, guidesBack: fromStudio ? 'studio' : s.screen === 'guides' ? s.guidesBack : 'home' });
  requestHeading('page', article, heading);
}

export function setGuideArticle(id: string, heading?: string): void {
  if (!articleById(id)) return;
  useHome.setState({ article: id });
  requestHeading('page', id, heading);
}

export function goBack(): void {
  const s = getHome();
  if (!s.open) return;
  if (s.screen === 'home') showStudio();
  else if (s.screen === 'guides' && s.guidesBack === 'studio') showStudio();
  else useHome.setState({ screen: 'home' });
}

let openedWithFile = false;

export function noteOpenFileRequest(): void {
  openedWithFile = true;
  if (getHome().phase === 'ready') showStudio();
}

export function onProjectPicked(): void {
  showStudio();
}

let installed = false;

export function installHome(): void {
  if (installed) return;
  installed = true;

  setBareKeysBlocked(true);
  useHome.subscribe((s, prev) => {
    if (s.open !== prev.open || s.phase !== prev.phase) setBareKeysBlocked(s.open);
  });
  onWorkspaceReveal(() => {
    const s = getHome();
    if (!s.open) return false;
    showStudio();
    return true;
  });

  let lastPath: string | null = null;
  useProjectStatus.subscribe((st) => {
    const p = st.status?.path ?? null;
    if (!p || p === lastPath) return;
    lastPath = p;
    const m = openedAtMap();
    m[pathKey(p)] = Date.now();
    const trimmed = Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 40));
    writeJson(K.opened, trimmed);
  });

  let decided = false;
  const decide = (settings: Settings | null): void => {
    if (decided) return;
    decided = true;
    if (shouldOpenHome({ openToHome: settings?.ui.openToHome, openedWithFile })) showHome('home');
    else showStudio();
  };
  window.krypt.settings.get().then(decide, () => decide(null));
  setTimeout(() => decide(null), 4000);
}
