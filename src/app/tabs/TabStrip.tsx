// ──────────────────────────────────────────────────────────────────────
// The project tab strip in the title bar (research/19-project-tabs.md):
// one tab per open project with its title, a dirty dot, a busy spinner and
// a close ×; middle-click closes, drag reorders, right-click for more; a +
// for a new tab (its chevron / right-click: templates, open, reopen).
// The title bar is an Electron drag region: tabs and buttons are no-drag,
// and the space after them (pr-12 at least) stays draggable.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, Copy, FileMusic, FolderOpen, LayoutTemplate, Loader2, Plus, RotateCcw, Save, X, XSquare } from 'lucide-react';
import type { ProjectTab } from '@shared/types';
import { openMenu, openMenuAt, type MenuItem } from '../../components/Menu';
import { shortcutFor } from '../../input/keymap';
import { useProject } from '../../doc/store';
import { isDirty, useProjectStatus } from '../../state/status';
import { cls } from '../../utils/format';
import { refreshTemplates, useTemplates } from '../templates';
import { describeTemplate } from '@shared/templates';
import { dropIndex, tabHint, tabLayout } from './logic';
import { closeOtherTabs, closeTab, copyTabPath, moveTabTo, newTab, openInTab, reopenClosedTab, revealTab, saveTab, switchTab, useTabs } from './store';

/** Width kept for the + and chevron buttons, and the drag gap after them. */
const PLUS_W = 46;
const DRAG_GAP = 48;

async function plusMenuItems(): Promise<MenuItem[]> {
  await refreshTemplates();
  const templates = useTemplates.getState().list ?? [];
  const closed = useTabs.getState().state?.closed ?? [];
  return [
    { label: 'New tab', icon: Plus, shortcut: shortcutFor('file.new'), onSelect: () => void newTab() },
    { label: 'Open in a new tab…', icon: FolderOpen, shortcut: shortcutFor('file.open'), onSelect: () => void openInTab() },
    { type: 'separator' },
    { type: 'header', label: 'New from template' },
    ...(templates.length
      ? templates.map<MenuItem>((t) => ({ label: t.name, icon: LayoutTemplate, detail: describeTemplate(t), onSelect: () => void newTab({ id: t.id, name: t.name }) }))
      : [{ type: 'header', label: 'No templates yet: File ▸ Save as template…' } as MenuItem]),
    { type: 'separator' },
    {
      label: closed.length ? `Reopen "${closed[0].title}"` : 'Reopen closed tab',
      icon: RotateCcw,
      shortcut: shortcutFor('tabs.reopenClosed'),
      disabled: !closed.length,
      onSelect: () => void reopenClosedTab(),
    },
  ];
}

function tabMenuItems(t: ProjectTab, active: boolean, count: number): MenuItem[] {
  const closed = useTabs.getState().state?.closed ?? [];
  const items: MenuItem[] = [
    { label: 'Close', icon: X, shortcut: active ? shortcutFor('tabs.close') : undefined, onSelect: () => void closeTab(t.id) },
    { label: 'Close others', icon: XSquare, disabled: count < 2, onSelect: () => void closeOtherTabs(t.id) },
    { type: 'separator' },
    { label: 'Save', icon: Save, shortcut: active ? shortcutFor('file.save') : undefined, hint: active ? undefined : 'Switches to this tab, then saves', onSelect: () => void saveTab(t.id) },
  ];
  if (t.path) {
    const path = t.path;
    items.push(
      { label: 'Reveal in Explorer', icon: FolderOpen, detail: path, onSelect: () => void revealTab(path) },
      { label: 'Copy path', icon: Copy, onSelect: () => void copyTabPath(path) },
    );
  }
  items.push(
    { type: 'separator' },
    { label: 'New tab', icon: Plus, shortcut: shortcutFor('file.new'), onSelect: () => void newTab() },
    { label: 'Reopen closed tab', icon: RotateCcw, shortcut: shortcutFor('tabs.reopenClosed'), disabled: !closed.length, onSelect: () => void reopenClosedTab() },
  );
  return items;
}

interface DragState {
  id: string;
  from: number;
  startX: number;
  pointerId: number;
  moved: boolean;
}

export function TabStrip() {
  const state = useTabs((s) => s.state);
  const recovered = useProjectStatus((s) => !!s.status?.recovered);
  const liveDirty = useProjectStatus((s) => isDirty(s));
  const statusName = useProjectStatus((s) => s.status?.name);
  const metaName = useProject((p) => p.meta.name);
  const regionRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  const drag = useRef<DragState | null>(null);
  const [dragView, setDragView] = useState<{ id: string; dx: number; to: number } | null>(null);

  // Before the first tabs state (or without main), show the one open project as a single tab.
  const tabs: ProjectTab[] = state?.tabs.length ? state.tabs : [{ id: '__current', title: statusName || metaName || 'Untitled', path: null, dirty: liveDirty }];
  const activeId = state?.tabs.length ? state.activeId : '__current';
  const real = !!state?.tabs.length;

  useLayoutEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const measure = (): void => setAvail(Math.max(0, el.clientWidth - PLUS_W - DRAG_GAP - 8));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { width, scroll } = tabLayout(tabs.length, avail);

  // Keep the active tab in view when it changes (or the strip starts scrolling).
  useEffect(() => {
    const sc = scrollerRef.current;
    const el = sc?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, scroll, tabs.length]);

  const mids = (): number[] => {
    const sc = scrollerRef.current;
    if (!sc) return [];
    return [...sc.querySelectorAll<HTMLElement>('[data-tab-id]')].map((el) => {
      const r = el.getBoundingClientRect();
      // Undo the drag transform so the math works on the resting layout.
      const shift = Number(el.dataset.shift ?? 0);
      return r.left - shift + r.width / 2;
    });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, t: ProjectTab, i: number): void => {
    if (e.button !== 0) return;
    drag.current = { id: t.id, from: i, startX: e.clientX, pointerId: e.pointerId, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 5) return;
    if (!d.moved && tabs.length < 2) return;
    d.moved = true;
    setDragView({ id: d.id, dx, to: dropIndex(mids(), e.clientX, d.from) });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled = false): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    const view = dragView;
    setDragView(null);
    if (cancelled) return;
    if (!d.moved) {
      if (real) void switchTab(d.id);
      return;
    }
    if (real && view && view.to !== d.from) void moveTabTo(d.id, view.to);
  };

  /** Where a non-dragged tab slides to make room for the dragged one. */
  const shiftOf = (i: number, id: string): number => {
    if (!dragView) return 0;
    if (id === dragView.id) return dragView.dx;
    const from = tabs.findIndex((t) => t.id === dragView.id);
    const to = dragView.to;
    if (from < to && i > from && i <= to) return -width;
    if (from > to && i >= to && i < from) return width;
    return 0;
  };

  const closeKey = shortcutFor('tabs.close');

  return (
    <div ref={regionRef} className="flex h-full min-w-0 flex-1 items-end pl-3 pr-12" data-guide="titlebar.tabs">
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="Open projects"
        className="app-no-drag flex h-full min-w-0 items-end overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none' }}
        onWheel={(e) => {
          const sc = scrollerRef.current;
          if (sc && sc.scrollWidth > sc.clientWidth) sc.scrollLeft += e.deltaY || e.deltaX;
        }}
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const dirty = t.dirty || (active && liveDirty);
          const shift = shiftOf(i, t.id);
          const dragging = dragView?.id === t.id;
          const hint = tabHint({ ...t, dirty }, active, closeKey);
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              data-tab-id={t.id}
              data-shift={shift}
              title={t.busy ? `${t.title}: ${t.busy}` : t.path ?? t.title}
              data-hint={hint}
              style={{ width, transform: shift ? `translateX(${shift}px)` : undefined }}
              className={cls(
                'group relative flex h-[26px] flex-shrink-0 cursor-default select-none items-center gap-1.5 rounded-t-md border border-b-0 pl-2 pr-1 text-[11.5px] outline-none focus-visible:ring-1 focus-visible:ring-krypt-purple/60',
                active ? 'border-white/10 bg-white/[0.07] text-white' : 'border-transparent text-white/55 hover:bg-white/[0.04] hover:text-white/90',
                dragging ? 'z-10 bg-white/10 shadow-krypt-card' : 'transition-[transform,background-color,color] duration-150',
              )}
              onPointerDown={(e) => onPointerDown(e, t, i)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => endDrag(e)}
              onPointerCancel={(e) => endDrag(e, true)}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault(); // no autoscroll cursor
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && real) {
                  e.preventDefault();
                  void closeTab(t.id);
                }
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && real) {
                  e.preventDefault();
                  void switchTab(t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (real) openMenu(e, tabMenuItems(t, active, tabs.length), { minWidth: 210 });
              }}
            >
              {active && <span className="pointer-events-none absolute inset-x-2 top-0 h-[2px] rounded-full bg-krypt-gradient" />}
              {t.busy ? (
                <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-krypt-purple" aria-label={t.busy} />
              ) : (
                <FileMusic className={cls('h-3 w-3 flex-shrink-0', active ? 'text-krypt-purple' : 'opacity-50')} />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
              {active && recovered && (
                <span className="flex-shrink-0 rounded-full border border-amber-400/40 bg-amber-500/10 px-1 text-[8.5px] font-semibold uppercase tracking-wider text-amber-300" title="Restored from a crash journal">
                  Rec
                </span>
              )}
              <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center">
                {dirty && (
                  <span
                    className={cls('h-1.5 w-1.5 rounded-full bg-krypt-pink shadow-[0_0_6px_rgba(236,72,153,0.8)]', real && 'group-hover:hidden')}
                    aria-label="Unsaved changes"
                  />
                )}
                {real && (
                  <button
                    type="button"
                    aria-label={`Close ${t.title}`}
                    tabIndex={-1}
                    className={cls(
                      'absolute inset-0 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white',
                      dirty ? 'hidden group-hover:flex' : active ? 'flex' : 'hidden group-hover:flex',
                    )}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(t.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div ref={plusRef} className="app-no-drag mb-[3px] ml-1 flex flex-shrink-0 items-center">
        <button
          type="button"
          data-guide="titlebar.newTab"
          aria-label="New tab"
          title={`New tab${shortcutFor('file.new') ? ` (${shortcutFor('file.new')})` : ''}`}
          data-hint={`New tab: a fresh project${shortcutFor('file.new') ? ` (${shortcutFor('file.new')})` : ''}. Right-click or the arrow for templates`}
          onClick={() => void newTab()}
          onContextMenu={(e) => {
            e.preventDefault();
            void plusMenuItems().then((items) => openMenu(e.nativeEvent, items, { minWidth: 230 }));
          }}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-krypt-purple/60"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="New tab options"
          title="New from template, open, reopen"
          data-hint="New from a template, open a project in a new tab, or reopen a closed tab"
          onClick={() => {
            const el = plusRef.current;
            if (el) void plusMenuItems().then((items) => openMenuAt(el, items, { minWidth: 230 }));
          }}
          className="flex h-[22px] w-4 items-center justify-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-krypt-purple/60"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
