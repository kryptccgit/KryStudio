// ──────────────────────────────────────────────────────────────────────
// Tour logic without a screen (test/tours.test.ts): which steps a tour has
// for a choice, the Kick / Clap rows of a project, what to say when a
// step's target isn't on screen, where the instruction card goes, and the
// "offer the first tour once" decision with its localStorage memory.
// ──────────────────────────────────────────────────────────────────────

import type { Project } from '@shared/schema/project';
import { TICKS_PER_STEP } from '@shared/schema/time';
import { PANELS, type SingletonKind } from '../workspace/panels';
import { GUIDE_ANCHORS } from '../guides/anchors';
import type { Tour, TourAction, TourCtx, TourId, TourRecovery, TourRow, TourSnapshot, TourStep } from './types';

// ── Steps ─────────────────────────────────────────────────────────────

export function textOf(t: string | ((c: TourCtx) => string), c: TourCtx): string {
  return typeof t === 'function' ? t(c) : t;
}

/** The steps a tour has for this choice (tour 4 only shows the chosen path). */
export function stepsFor(tour: Tour, c: TourCtx): TourStep[] {
  return tour.steps.filter((s) => !s.when || s.when(c));
}

/** The step's "Do it for me" action, when it has one. */
export function actOf(step: TourStep, c: TourCtx): TourAction | null {
  if (!step.act) return null;
  return typeof step.act === 'function' ? step.act(c) : step.act;
}

/** Does the step advance by itself right now? Read and choose steps never do. */
export function isStepDone(step: TourStep, s: TourSnapshot, base: TourSnapshot, c: TourCtx): boolean {
  if (!step.done) return false;
  try {
    return step.done(s, base, c);
  } catch {
    return false;
  }
}

/** Index after a move, clamped to the steps. null = past the end (the tour is finished). */
export function moveIndex(index: number, delta: 1 | -1, count: number): number | null {
  const next = index + delta;
  if (next >= count) return null;
  return Math.max(0, next);
}

// ── Project → rows ────────────────────────────────────────────────────

function countSteps(notes: Record<string, { tick: number }> | undefined): number {
  if (!notes) return 0;
  const on = new Set<number>();
  for (const n of Object.values(notes)) if (n.tick % TICKS_PER_STEP === 0) on.add(n.tick / TICKS_PER_STEP);
  return on.size;
}

/** The Kick row (named like "kick", else the first channel) and the Clap row (clap, else snare, else the next channel). */
export function drumRows(p: Project | null | undefined): { kick: TourRow | null; clap: TourRow | null } {
  if (!p) return { kick: null, clap: null };
  const pat = p.transport.activePatternId ? p.patterns[p.transport.activePatternId] : undefined;
  const chans = p.channelOrder.map((id) => p.channels[id]).filter(Boolean);
  const row = (id: string | undefined): TourRow | null => {
    const ch = id ? p.channels[id] : undefined;
    return ch ? { id: ch.id, name: ch.name, steps: countSteps(pat?.notes[ch.id]) } : null;
  };
  const kickId = (chans.find((c) => /kick|bd\b/i.test(c.name)) ?? chans[0])?.id;
  const clapId = (chans.find((c) => c.id !== kickId && /clap/i.test(c.name)) ?? chans.find((c) => c.id !== kickId && /snare/i.test(c.name)) ?? chans.find((c) => c.id !== kickId))?.id;
  return { kick: row(kickId), clap: row(clapId) };
}

export function patternClipCount(p: Project | null | undefined): number {
  if (!p) return 0;
  return Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern').length;
}

// ── Recovery: the target isn't on screen ──────────────────────────────

/** ok = found and visible; covered = something (Home, a window) is on top of it; missing = not rendered; elsewhere = in a detached window. */
export type AnchorState = 'ok' | 'missing' | 'covered' | 'elsewhere';

export function panelTitle(kind: SingletonKind): string {
  return PANELS[kind]?.title ?? kind;
}

/** "press F6" for panels with a key, else the View menu. */
export function howToOpen(kind: SingletonKind): string {
  const key = PANELS[kind]?.shortcut;
  if (kind === 'agent') return 'click the AI button at the top';
  return key ? `press [[${key}]]` : `open it from the **View** menu`;
}

/** The panel a step's target lives in (its own, or its guide anchor's). */
export function anchorPanel(step: TourStep): SingletonKind | undefined {
  const a = step.anchor;
  if (!a) return undefined;
  if (a.panel) return a.panel;
  const g = a.guide ? (GUIDE_ANCHORS[a.guide] as { panel?: SingletonKind }) : undefined;
  return g?.panel;
}

/**
 * What the card says (and the button it offers) when the step's target can't be seen. null = nothing to fix.
 * Order: Home covering the Studio → the step's own advice → its panel is closed → a detached window → reset the layout.
 */
export function recoveryFor(step: TourStep, state: AnchorState, s: TourSnapshot, c: TourCtx): TourRecovery | null {
  if (state === 'ok' || !step.anchor) return null;
  if (s.homeOpen && !step.anchor.chrome) {
    return { message: 'The Home screen is covering the Studio.', label: 'Go to the Studio', action: { kind: 'leaveHome' } };
  }
  if (step.recover) {
    const r = typeof step.recover === 'function' ? step.recover(s, c) : step.recover;
    if (r) return r;
  }
  const panel = anchorPanel(step);
  if (panel && !s.visible.includes(panel)) {
    const title = panelTitle(panel);
    return { message: `The ${title} is closed. To open it, ${howToOpen(panel)}.`, label: `Open the ${title}`, action: { kind: 'open', panel } };
  }
  if (state === 'elsewhere') {
    return {
      message: "It's in a separate window right now. Look for that window, or reset the layout to bring everything back here.",
      label: 'Reset the layout',
      action: { kind: 'resetLayout' },
    };
  }
  if (state === 'covered' && panel) {
    const title = panelTitle(panel);
    return { message: `Something is on top of the ${title}.`, label: `Bring the ${title} to the front`, action: { kind: 'open', panel } };
  }
  return {
    message: "I can't find it on screen. Resetting the layout puts every window back where it started.",
    label: 'Reset the layout',
    action: { kind: 'resetLayout' },
  };
}

// ── Card placement ────────────────────────────────────────────────────

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Side = 'below' | 'above' | 'right' | 'left' | 'over';

/**
 * Where the instruction card goes: below the target, else above, right, left; when nothing fits (a huge target,
 * a tiny window) it sits over the target's bottom edge. Always inside the window with a margin.
 */
export function placeCard(target: Rect, card: { width: number; height: number }, view: { width: number; height: number }, gap = 18, margin = 12): { left: number; top: number; side: Side } {
  const clampX = (x: number): number => Math.max(margin, Math.min(x, view.width - card.width - margin));
  const clampY = (y: number): number => Math.max(margin, Math.min(y, view.height - card.height - margin));
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  if (bottom + gap + card.height + margin <= view.height) return { left: clampX(cx - card.width / 2), top: bottom + gap, side: 'below' };
  if (target.top - gap - card.height - margin >= 0) return { left: clampX(cx - card.width / 2), top: target.top - gap - card.height, side: 'above' };
  if (right + gap + card.width + margin <= view.width) return { left: right + gap, top: clampY(cy - card.height / 2), side: 'right' };
  if (target.left - gap - card.width - margin >= 0) return { left: target.left - gap - card.width, top: clampY(cy - card.height / 2), side: 'left' };
  return { left: clampX(cx - card.width / 2), top: clampY(bottom - card.height - margin), side: 'over' };
}

// ── Memory: offer the first tour once ─────────────────────────────────

export const TOURS_KEY = 'krypt.studio.tours.v1';

export interface TourMemory {
  /** The first-launch offer was shown (it never comes back). */
  offered: boolean;
  /** Tours started at least once, and tours finished. */
  started: TourId[];
  finished: TourId[];
  /** The Home "New here? Take the tour" card was dismissed. */
  cardHidden: boolean;
}

export const EMPTY_MEMORY: TourMemory = { offered: false, started: [], finished: [], cardHidden: false };

const TOUR_IDS: readonly TourId[] = ['first-beat', 'windows', 'song', 'ai', 'master'];
const ids = (v: unknown): TourId[] => (Array.isArray(v) ? v.filter((x): x is TourId => TOUR_IDS.includes(x as TourId)) : []);

/** Parse the stored JSON; anything odd becomes the empty memory. */
export function parseMemory(raw: string | null): TourMemory {
  if (!raw) return { ...EMPTY_MEMORY };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof TourMemory, unknown>>;
    if (!v || typeof v !== 'object') return { ...EMPTY_MEMORY };
    return { offered: v.offered === true, started: ids(v.started), finished: ids(v.finished), cardHidden: v.cardHidden === true };
  } catch {
    return { ...EMPTY_MEMORY };
  }
}

/**
 * Offer tour 1 at launch? Once per PC: never again after it was offered, never to someone who already started a
 * tour, never over a running tour, and never when storage doesn't work (we couldn't remember the answer, and
 * offering on every launch would nag).
 */
export function shouldOfferFirstTour(m: TourMemory, o: { storageOk: boolean; active: boolean }): boolean {
  return o.storageOk && !o.active && !m.offered && m.started.length === 0;
}

/** The Home "New here? Take the tour" card: until dismissed or tour 1 is finished. */
export function tourCardVisible(m: TourMemory): boolean {
  return !m.cardHidden && !m.finished.includes('first-beat');
}

export function noteStarted(m: TourMemory, id: TourId): TourMemory {
  return m.started.includes(id) ? m : { ...m, started: [...m.started, id] };
}

export function noteFinished(m: TourMemory, id: TourId): TourMemory {
  return m.finished.includes(id) ? m : { ...m, finished: [...m.finished, id] };
}
