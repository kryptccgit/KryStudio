// ──────────────────────────────────────────────────────────────────────
// WindowManager — the ONLY code that talks to dockview (research/06 §2.2).
// Panels and menus call `wm.*`; swapping the docking library touches this
// folder only.
//
//   wm.toggle('pianoRoll')                       // F-key semantics
//   wm.open('mixer')                             // show + focus
//   wm.openPlugin({ kind: 'channel', channelId })
//   wm.float(id) / wm.dock(id) / wm.detach(id)   // floating / docked / OS window
//   wm.resetLayout()
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { DockviewApi, IDockviewPanel, SerializedDockview } from 'dockview-react';
import { PANELS, kindOfPanelId, pluginPanelId, type PanelKind, type PluginTarget, type SingletonKind } from './panels';
import { ClosedPanels, dockNeighbour, type ClosedPanel, type ClosedPlacement, type Rect } from './closedPanels';
import { getProject } from '../doc/store';
import { pluginById } from '@shared/plugins/catalog';
import { toast } from '../app/notify';
import { installHintTracking } from '../app/hints';

const LAYOUT_KEY = 'krypt.studio.layout.v1';
const FLOAT_KEY = 'krypt.studio.floatBounds.v1';

interface WorkspaceState {
  open: string[];
  active: string | null;
}

/** Reactive mirror of what's open (View menu checkmarks, toolbar lights). */
export const useWorkspace = create<WorkspaceState>(() => ({ open: [], active: null }));

type Bounds = { x: number; y: number; width: number; height: number };

function loadFloatBounds(): Record<string, Bounds> {
  try {
    return JSON.parse(localStorage.getItem(FLOAT_KEY) ?? '{}') as Record<string, Bounds>;
  } catch {
    return {};
  }
}

const popoutListeners = new Set<(win: Window) => void>();
const revealers = new Set<() => boolean>();

/**
 * Called before a panel is shown (open / toggle / plugin editor). A full-window
 * view layered over the workspace (the Home hub) uses it to step aside; return
 * true when it did, so F-key toggles open the panel instead of closing it.
 */
export function onWorkspaceReveal(fn: () => boolean): () => void {
  revealers.add(fn);
  return () => {
    revealers.delete(fn);
  };
}

function reveal(): boolean {
  let revealed = false;
  for (const fn of revealers) {
    try {
      if (fn()) revealed = true;
    } catch {
      /* never block a panel from opening */
    }
  }
  return revealed;
}

/**
 * Step any full-window layer (Home) aside without opening a panel: the Guides' "Show me" for title-bar and
 * transport elements. True when something stepped aside.
 */
export function revealWorkspace(): boolean {
  return reveal();
}

const popouts = new Set<Window>();

/** Open popout (detached) panel windows: "Show me" looks for its element in these too. */
export function popoutWindows(): Window[] {
  for (const w of popouts) if (w.closed) popouts.delete(w);
  return [...popouts];
}

/** Called for every popout window that opens (keymaps, hint tracking). */
export function onPopoutWindow(fn: (win: Window) => void): () => void {
  popoutListeners.add(fn);
  return () => {
    popoutListeners.delete(fn);
  };
}

export function pluginTitle(t: PluginTarget): string {
  const p = getProject();
  if (t.kind === 'channel') return p.channels[t.channelId]?.name ?? 'Instrument';
  const ins = p.mixer.inserts[t.insertId];
  const slot = ins?.slots[t.slotId];
  const name = slot ? pluginById(slot.type)?.name ?? slot.type : 'Effect';
  return ins ? `${name} · ${ins.name}` : name;
}

/** Does a plugin window's channel / effect still exist in the open project? */
export function pluginTargetAlive(t: PluginTarget): boolean {
  const p = getProject();
  if (!p) return false;
  return t.kind === 'channel' ? !!p.channels[t.channelId] : !!p.mixer.inserts[t.insertId]?.slots[t.slotId];
}

/** What a closed panel is called in hints ("Channel Rack", "Lead Synth"). */
export function closedPanelTitle(rec: Pick<ClosedPanel, 'kind' | 'target'>): string {
  if (rec.kind === 'plugin') return rec.target ? pluginTitle(rec.target) : 'Plugin';
  return PANELS[rec.kind].title;
}

function elementOf(x: unknown): HTMLElement | null {
  return (x as { element?: HTMLElement } | null)?.element ?? null;
}

function rectOf(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
}

class WindowManager {
  private api: DockviewApi | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private floatBounds: Record<string, Bounds> = loadFloatBounds();
  private cascade = 0;
  /** Panels the user closed, newest last (Ctrl+Z / Ctrl+Shift+T reopen them where they were). */
  readonly closed = new ClosedPanels();

  get ready(): boolean {
    return !!this.api;
  }

  /** Called once by <Workspace/> when dockview is ready. */
  attach(api: DockviewApi): void {
    this.api = api;
    const sync = (): void => {
      useWorkspace.setState({ open: api.panels.map((p) => p.id), active: api.activePanel?.id ?? null });
    };
    api.onDidAddPanel((p) => {
      this.closed.drop(p.id); // opened again some other way (F-key, menu): nothing to reopen
      sync();
    });
    api.onDidRemovePanel(sync);
    api.onDidActivePanelChange(sync);
    api.onDidLayoutChange(() => {
      sync();
      this.scheduleSave();
    });
    api.onDidAddPopoutGroup((pg) => {
      try {
        popouts.add(pg.window);
        installHintTracking(pg.window.document);
        for (const fn of popoutListeners) fn(pg.window);
      } catch {
        /* window may already be closing */
      }
    });
    api.onDidOpenPopoutWindowFail((f) => {
      toast.error(`Couldn't open a separate window (${f.reason}). The panel stays in the workspace.`);
    });
    if (!this.restore()) this.buildDefault();
    sync();
  }

  detachApi(): void {
    this.api = null;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  save(): void {
    if (!this.api) return;
    try {
      const json = this.api.toJSON();
      // Popout OS windows can't be reopened without a user gesture: restore them as floating windows.
      if (json.popoutGroups?.length) {
        json.floatingGroups = [
          ...(json.floatingGroups ?? []),
          ...json.popoutGroups.map((pg, i) => ({
            data: pg.data,
            grid: pg.grid,
            position: { left: 80 + i * 24, top: 60 + i * 24, width: pg.position?.width ?? 600, height: pg.position?.height ?? 400 },
          })),
        ];
        delete json.popoutGroups;
      }
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(json));
    } catch {
      /* storage full / serialization edge — the layout just won't persist */
    }
  }

  private restore(): boolean {
    if (!this.api) return false;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(LAYOUT_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return false;
    try {
      const json = JSON.parse(raw) as SerializedDockview;
      this.api.fromJSON(json);
      this.pruneStale();
      return this.api.panels.length > 0;
    } catch (err) {
      console.warn('[workspace] saved layout could not be restored, using the default', err);
      try {
        this.api.clear();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /** Close plugin windows whose channel / effect no longer exists. */
  pruneStale(): void {
    if (!this.api) return;
    const p = getProject();
    if (!p) return;
    for (const panel of [...this.api.panels]) {
      if (!panel.id.startsWith('plugin:')) continue;
      const t = (panel.params as { target?: PluginTarget } | undefined)?.target;
      const alive = t
        ? t.kind === 'channel'
          ? !!p.channels[t.channelId]
          : !!p.mixer.inserts[t.insertId]?.slots[t.slotId]
        : false;
      if (!alive) panel.api.close();
      else {
        const title = pluginTitle(t!);
        if (panel.title !== title) panel.api.setTitle(title);
      }
    }
  }

  buildDefault(): void {
    const api = this.api;
    if (!api) return;
    api.clear();
    this.add('playlist');
    this.add('browser');
    this.add('mixer');
    this.add('channelRack');
    this.focus('channelRack');
  }

  resetLayout(): void {
    try {
      localStorage.removeItem(LAYOUT_KEY);
    } catch {
      /* ignore */
    }
    this.buildDefault();
    toast.success('Workspace layout reset');
  }

  // ── Queries ─────────────────────────────────────────────────────────

  get(id: string): IDockviewPanel | undefined {
    return this.api?.getPanel(id);
  }

  isOpen(id: string): boolean {
    return !!this.get(id);
  }

  /** Visible = open and the active tab of its group. */
  isVisible(id: string): boolean {
    const p = this.get(id);
    return !!p && p.api.isVisible;
  }

  // ── Opening / closing ───────────────────────────────────────────────

  private add(kind: SingletonKind, params?: Record<string, unknown>): IDockviewPanel | undefined {
    const api = this.api;
    if (!api) return undefined;
    const def = PANELS[kind];
    const base = { id: kind, component: kind, title: def.title, params };
    const place = def.place;
    const gridRef = (): IDockviewPanel | undefined =>
      api.panels.find((p) => (p.id === 'playlist' || p.id === 'pianoRoll') && p.api.location.type === 'grid') ??
      api.panels.find((p) => p.api.location.type === 'grid');
    try {
      switch (place.mode) {
        case 'center': {
          const ref = gridRef();
          return ref
            ? api.addPanel({ ...base, position: { referencePanel: ref, direction: ref.id === 'browser' ? 'right' : 'within' } })
            : api.addPanel(base);
        }
        case 'left': {
          const ref = gridRef();
          return api.addPanel({ ...base, position: ref ? { referencePanel: ref, direction: 'left' } : { direction: 'left' }, initialWidth: place.width });
        }
        case 'right': {
          // Right-docked tools (Agents, History) share one tab group instead of stacking columns.
          const sibling = api.panels.find((p) => p.id !== kind && PANELS[p.id as SingletonKind]?.place.mode === 'right' && p.api.location.type === 'grid');
          return sibling
            ? api.addPanel({ ...base, position: { referencePanel: sibling, direction: 'within' } })
            : api.addPanel({ ...base, position: { direction: 'right' }, initialWidth: place.width });
        }
        case 'bottom': {
          const ref = api.panels.find((p) => p.id === 'playlist' && p.api.location.type === 'grid');
          return api.addPanel({
            ...base,
            position: ref ? { referencePanel: ref, direction: 'below' } : { direction: 'below' },
            initialHeight: place.height,
          });
        }
        case 'floating':
          return api.addPanel({ ...base, floating: this.floatingBox(kind, place.width, place.height, place.x, place.y) });
      }
    } catch (err) {
      toast.error(`Couldn't open ${def.title}: ${(err as Error).message}`);
      return undefined;
    }
  }

  private floatingBox(key: string, width: number, height: number, x?: number, y?: number) {
    const saved = this.floatBounds[key];
    const W = this.api?.width ?? 1200;
    const H = this.api?.height ?? 700;
    const w = Math.min(saved?.width ?? width, Math.max(240, W - 16));
    const h = Math.min(saved?.height ?? height, Math.max(160, H - 16));
    let left = saved?.x ?? x ?? Math.max(8, (W - w) / 2);
    let top = saved?.y ?? y ?? Math.max(8, (H - h) / 3);
    left = Math.max(0, Math.min(left, W - 120));
    top = Math.max(0, Math.min(top, H - 60));
    return { x: left, y: top, width: w, height: h };
  }

  /** Remember a floating window's bounds before it closes (reopen in place). */
  private rememberBounds(panel: IDockviewPanel, key: string): void {
    if (!this.api || panel.api.location.type !== 'floating') return;
    try {
      const el = (panel.group as unknown as { element?: HTMLElement }).element;
      const host = el?.closest('.dv-resize-container') as HTMLElement | null;
      const root = el?.closest('.dv-dockview') as HTMLElement | null;
      if (!host || !root) return;
      const r = host.getBoundingClientRect();
      const o = root.getBoundingClientRect();
      this.floatBounds[key] = { x: Math.round(r.left - o.left), y: Math.round(r.top - o.top), width: Math.round(r.width), height: Math.round(r.height) };
      localStorage.setItem(FLOAT_KEY, JSON.stringify(this.floatBounds));
    } catch {
      /* best effort */
    }
  }

  focus(id: string): void {
    const p = this.get(id);
    if (!p) return;
    p.api.setActive();
  }

  open(kind: SingletonKind, params?: Record<string, unknown>): void {
    reveal();
    const existing = this.get(kind);
    if (existing) {
      if (params) existing.api.updateParameters(params);
      existing.api.setActive();
      return;
    }
    this.add(kind, params);
  }

  /** A user close (tab ×, header ×, middle-click, F-key toggle): remembered so Ctrl+Z / Ctrl+Shift+T can reopen it. */
  close(id: string): void {
    const p = this.get(id);
    if (!p) return;
    const rec = this.describeClosing(p);
    this.rememberBounds(p, id.startsWith('plugin:') ? 'plugin' : id);
    p.api.close();
    if (rec && !this.get(id)) this.closed.push(rec);
  }

  /** Where a panel sits right now, for reopening it in the same place. */
  private describeClosing(p: IDockviewPanel): ClosedPanel | null {
    const api = this.api;
    const kind = kindOfPanelId(p.id);
    if (!api || !kind) return null;
    const target = kind === 'plugin' ? (p.params as { target?: PluginTarget } | undefined)?.target : undefined;
    if (kind === 'plugin' && !target) return null;
    let placement: ClosedPlacement;
    try {
      const loc = p.api.location.type;
      if (loc === 'floating') placement = { mode: 'floating', bounds: this.measureFloating(p) };
      else if (loc === 'popout') placement = { mode: 'floating', bounds: null };
      else {
        const group = p.group;
        const mates = group.panels.filter((x) => x.id !== p.id);
        if (mates.length) {
          // Shared a tab group: come back as a tab next to the same neighbour, at the same index.
          const i = group.panels.findIndex((x) => x.id === p.id);
          const ref = group.panels[i + 1] ?? group.panels[i - 1] ?? mates[0];
          placement = { mode: 'docked', neighbour: ref.id, direction: 'within', size: i };
        } else {
          const self = rectOf(elementOf(group));
          const others = api.groups
            .filter((g) => g !== group && g.api.location.type === 'grid' && g.panels.length)
            .map((g) => ({ id: (g.activePanel ?? g.panels[0]).id, rect: rectOf(elementOf(g)) }))
            .filter((o): o is { id: string; rect: Rect } => !!o.rect);
          const n = self ? dockNeighbour(self, others) : null;
          placement = n ? { mode: 'docked', neighbour: n.id, direction: n.direction, size: n.size } : { mode: 'docked', neighbour: null, direction: 'within' };
        }
      }
    } catch {
      placement = { mode: 'docked', neighbour: null, direction: 'within' };
    }
    return { id: p.id, kind, target, placement, at: Date.now() };
  }

  private measureFloating(panel: IDockviewPanel): Bounds | null {
    const el = elementOf(panel.group);
    const host = el?.closest('.dv-resize-container') as HTMLElement | null;
    const root = el?.closest('.dv-dockview') as HTMLElement | null;
    if (!host || !root) return null;
    const r = host.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    return { x: Math.round(r.left - o.left), y: Math.round(r.top - o.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  /**
   * Newest user-closed panel that can come back now. A plugin window whose channel is gone is skipped but kept:
   * undoing the delete brings the channel back, and then its window can come back too.
   */
  lastClosed(): ClosedPanel | null {
    return this.closed.newestWhere((r) => r.kind !== 'plugin' || (!!r.target && pluginTargetAlive(r.target)));
  }

  /** After a tab switch: forget plugin windows whose channel / effect isn't in the new project. */
  pruneClosedPlugins(): void {
    this.closed.prune((r) => r.kind === 'plugin' && (!r.target || !pluginTargetAlive(r.target)));
  }

  /**
   * Reopen the newest user-closed panel where it was: back in its tab group, docked beside its old neighbour,
   * or floating at its old bounds; the default spot when that place is gone. Returns what came back, or null.
   */
  reopenLastClosed(): ClosedPanel | null {
    const rec = this.lastClosed();
    const api = this.api;
    if (!rec || !api) return null;
    this.closed.drop(rec.id);
    reveal();
    if (api.getPanel(rec.id)) {
      this.focus(rec.id);
      return rec;
    }
    const base =
      rec.kind === 'plugin'
        ? { id: rec.id, component: 'plugin', title: pluginTitle(rec.target!), params: { target: rec.target } }
        : { id: rec.kind, component: rec.kind, title: PANELS[rec.kind].title };
    const fallback = (): void => {
      if (rec.kind === 'plugin') this.openPlugin(rec.target!);
      else this.add(rec.kind as SingletonKind);
    };
    try {
      const pl = rec.placement;
      if (pl.mode === 'floating') {
        if (pl.bounds) api.addPanel({ ...base, floating: this.clampBox(pl.bounds) });
        else fallback();
      } else {
        const ref = pl.neighbour ? api.getPanel(pl.neighbour) : undefined;
        if (!ref) fallback();
        else if (pl.direction === 'within') api.addPanel({ ...base, position: { referencePanel: ref, direction: 'within', index: pl.size } });
        else {
          const sizing = pl.size ? (pl.direction === 'left' || pl.direction === 'right' ? { initialWidth: pl.size } : { initialHeight: pl.size }) : {};
          api.addPanel({ ...base, position: { referencePanel: ref, direction: pl.direction }, ...sizing });
        }
      }
    } catch (err) {
      try {
        fallback();
      } catch {
        toast.error(`Couldn't reopen ${closedPanelTitle(rec)}: ${(err as Error).message}`);
        return null;
      }
    }
    if (!api.getPanel(rec.id)) return null;
    this.focus(rec.id);
    return rec;
  }

  /** Keep remembered floating bounds on screen (the window may have shrunk since). */
  private clampBox(b: Bounds): Bounds {
    const W = this.api?.width ?? 1200;
    const H = this.api?.height ?? 700;
    const width = Math.min(b.width, Math.max(240, W - 16));
    const height = Math.min(b.height, Math.max(160, H - 16));
    const x = Math.max(0, Math.min(b.x, W - 120));
    const y = Math.max(0, Math.min(b.y, H - 60));
    return { x, y, width, height };
  }

  /** FL F-key semantics: hidden/closed → show + focus; visible → close. */
  toggle(kind: SingletonKind): void {
    const revealed = reveal(); // coming back from Home: show it, never close it
    const p = this.get(kind);
    if (!p) {
      this.add(kind);
      return;
    }
    if (p.api.isVisible && !revealed) this.close(kind);
    else p.api.setActive(); // hidden behind another tab: bring it forward
  }

  openPlugin(target: PluginTarget): void {
    reveal();
    const api = this.api;
    if (!api) return;
    const id = pluginPanelId(target);
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const def = PANELS.plugin.place as { width: number; height: number };
    const saved = this.floatBounds.plugin;
    const off = (this.cascade++ % 6) * 26;
    const w = saved?.width ?? def.width;
    // Default: the right side of the workspace, clear of the Channel Rack's channel buttons.
    const x0 = saved?.x ?? Math.max(300, (api.width || 1200) - w - 60);
    const box = this.floatingBox('__plugin', w, saved?.height ?? def.height, x0 - off, (saved?.y ?? 40) + off);
    try {
      api.addPanel({ id, component: 'plugin', title: pluginTitle(target), params: { target }, floating: box });
    } catch (err) {
      toast.error(`Couldn't open the plugin editor: ${(err as Error).message}`);
    }
  }

  /** Toggle a channel's plugin editor (FL: clicking the channel button). */
  togglePlugin(target: PluginTarget): void {
    const id = pluginPanelId(target);
    if (this.isOpen(id)) this.close(id);
    else this.openPlugin(target);
  }

  closePluginsWhere(pred: (t: PluginTarget) => boolean): void {
    if (!this.api) return;
    for (const p of [...this.api.panels]) {
      const t = (p.params as { target?: PluginTarget } | undefined)?.target;
      if (p.id.startsWith('plugin:') && t && pred(t)) p.api.close();
    }
  }

  // ── Window modes ────────────────────────────────────────────────────

  float(id: string): void {
    const api = this.api;
    const p = this.get(id);
    if (!api || !p) return;
    if (p.api.location.type === 'floating') return;
    const kind = (id.startsWith('plugin:') ? 'plugin' : id) as PanelKind;
    const place = PANELS[kind]?.place;
    const w = place && 'width' in place ? place.width : 640;
    const h = place && 'height' in place ? place.height : 420;
    api.addFloatingGroup(p, this.floatingBox(id, Math.max(w, 420), Math.max(h, 300)));
  }

  dock(id: string): void {
    const api = this.api;
    const p = this.get(id);
    if (!api || !p) return;
    const target =
      api.groups.find((g) => g.api.location.type === 'grid' && g.panels.some((x) => x.id === 'playlist')) ??
      api.groups.find((g) => g.api.location.type === 'grid' && g !== p.group);
    if (target) p.api.moveTo({ group: target, position: 'center' });
    else p.group.api.moveTo({ position: 'center' });
  }

  async detach(id: string): Promise<void> {
    const api = this.api;
    const p = this.get(id);
    if (!api || !p) return;
    try {
      const ok = await api.addPopoutGroup(p);
      if (!ok) toast.error("Couldn't open a separate window. The panel stays in the workspace.");
    } catch (err) {
      toast.error(`Couldn't open a separate window: ${(err as Error).message}`);
    }
  }

  toggleMaximize(id: string): void {
    const p = this.get(id);
    if (!p || p.api.location.type !== 'grid') return;
    if (p.api.isMaximized()) p.api.exitMaximized();
    else p.api.maximize();
  }
}

export const wm = new WindowManager();
