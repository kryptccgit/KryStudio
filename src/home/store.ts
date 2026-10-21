// ──────────────────────────────────────────────────────────────────────
// Home hub navigation state: is the Home layer up, which screen it shows
// (the card grid, a sub-screen or Guides), and the launch decision.
//
//   showHome()            showHome('projects')     showStudio()
//   toggleHome()          openGuides('mixer')      goBack()
//
// openGuides() opens the docked Guides panel when the Studio is showing and
// the Home guides screen when Home is up.
//
// The workspace stays mounted underneath, so switching is instant and the
// engine, transport and panels keep running. Any panel being opened
// (F-keys, menus, toast buttons) steps Home aside (wm reveal hook), and so
// does a project being opened or created (onProjectPicked).
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { Settings } from '@shared/types';
import { setBareKeysBlocked } from '../input/keymap';
import { onWorkspaceReveal } from '../workspace/WindowManager';
import { useProjectStatus } from '../state/status';
import { pathKey, shouldOpenHome, type HomeScreen } from './logic';
import { DEFAULT_ARTICLE, articleById } from '../guides/articles';
import { openGuidesPanel, requestHeading } from '../guides/store';

interface HomeState {
  /** 'pending' until the launch decision (settings + queued launch files) is made. */
  phase: 'pending' | 'ready';
  open: boolean;
  screen: HomeScreen;
  /** Guides article shown in the Guides screen. */
  article: string;
  /** Where Back / Esc goes from Guides: Home when opened from Home, else the Studio. */
  guidesBack: 'home' | 'studio';
  /** Bumped on every Home open: picks the rotating tip. */
  opens: number;
}

// ── Per-machine conveniences (localStorage; the app works without them) ─

const K = {
  tip: 'krypt.studio.home.tip.v1',
  opened: 'krypt.studio.home.opened.v1',
  guidesSeen: 'krypt.studio.guides.seen.v1',
  welcomeSeen: 'krypt.studio.welcome.v1', // the retired first-run card: set = a returning user
  quickstartDone: 'krypt.studio.home.quickstart.v1', // the quickstart video card was watched or dismissed
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
    /* best effort: a locked-down profile just loses the convenience */
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return true; // no storage: don't nag forever
  }
}

function setFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* best effort */
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

/** First-run flags for the Guides pill. */
export function homeFlags(): { guidesSeen: boolean; welcomeSeen: boolean } {
  return { guidesSeen: readFlag(K.guidesSeen), welcomeSeen: readFlag(K.welcomeSeen) };
}

/** The Home quickstart video card: watched to the end or dismissed on this PC. */
export function quickstartDismissed(): boolean {
  return readFlag(K.quickstartDone);
}

export function dismissQuickstart(): void {
  setFlag(K.quickstartDone);
}

/** When each project was last opened on this PC (lower-cased path → ms). */
export function openedAtMap(): Record<string, number> {
  const m = readJson<Record<string, number>>(K.opened, {});
  return m && typeof m === 'object' ? m : {};
}

// ── Navigation ────────────────────────────────────────────────────────

/** Show the Home layer (the card grid, or one of its screens). */
export function showHome(screen: HomeScreen = 'home'): void {
  const s = getHome();
  const opening = !s.open || s.phase === 'pending';
  const opens = opening && screen === 'home' ? s.opens + 1 : s.opens;
  if (opens !== s.opens) writeJson(K.tip, opens);
  useHome.setState({ phase: 'ready', open: true, screen, opens, ...(screen === 'guides' ? { guidesBack: 'home' as const } : {}) });
}

/** Back to the Studio (the workspace). */
export function showStudio(): void {
  const s = getHome();
  if (!s.open && s.phase === 'ready') return;
  useHome.setState({ phase: 'ready', open: false });
}

/** Title-bar button / Ctrl+Shift+H. */
export function toggleHome(): void {
  const s = getHome();
  if (s.open && s.phase === 'ready') showStudio();
  else showHome('home');
}

/**
 * Help ▸ Guides / F1 / the Guides card / guide links. With the Studio showing, the docked Guides panel opens beside
 * the work; with Home up (or before the launch decision), the Home guides screen. `heading` scrolls to one of the
 * article's ## headings (anchorOf).
 */
export function openGuides(articleId?: string, heading?: string): void {
  const s = getHome();
  setFlag(K.guidesSeen);
  if (s.phase === 'ready' && !s.open && openGuidesPanel(articleId, heading)) return;
  openGuidesScreen(articleId, heading);
}

/** The full-screen Home guides screen. From the Studio, Back returns to the Studio. */
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

/** Back / Esc: a sub-screen goes to the grid, the grid goes to the Studio. */
export function goBack(): void {
  const s = getHome();
  if (!s.open) return;
  if (s.screen === 'home') showStudio();
  else if (s.screen === 'guides' && s.guidesBack === 'studio') showStudio();
  else useHome.setState({ screen: 'home' });
}

// ── Hooks from the rest of the app ────────────────────────────────────

let openedWithFile = false;

/** A file arrived from Explorer / a second instance / a drop: the user wants the Studio. */
export function noteOpenFileRequest(): void {
  openedWithFile = true;
  if (getHome().phase === 'ready') showStudio();
}

/** A project was opened or created (any route: File menu, Home, Ctrl+O, drop). */
export function onProjectPicked(): void {
  showStudio();
}

// ── Boot ──────────────────────────────────────────────────────────────

let installed = false;

/**
 * Call once at boot, AFTER window.krypt.app.onOpenFile is subscribed: main
 * flushes queued launch files when that subscription arrives, before it
 * answers any later IPC call, so the settings fetch below doubles as a
 * barrier. Launch files reach noteOpenFileRequest() first, and the decision
 * sees them.
 */
export function installHome(): void {
  if (installed) return;
  installed = true;

  // Bare keys belong to Home while it covers the window; the reveal hook steps it aside for panels.
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

  // "Last opened" for the recent list: stamp a project when its path becomes the open one.
  let lastPath: string | null = null;
  useProjectStatus.subscribe((st) => {
    const p = st.status?.path ?? null;
    if (!p || p === lastPath) return;
    lastPath = p;
    const m = openedAtMap();
    m[pathKey(p)] = Date.now();
    // keep the map small: the 40 newest entries
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
  setTimeout(() => decide(null), 4000); // main never answered: don't leave a blank layer up
}
