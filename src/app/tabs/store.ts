import { create } from 'zustand';
import type { ActionResult, ProjectTab, TabsState } from '@shared/types';
import { useDocStore } from '../../doc/store';
import { refreshProjectStatus, useProjectStatus } from '../../state/status';
import { getUi } from '../../state/ui';
import { onProjectPicked } from '../../home/store';
import { modal, report, toast } from '../notify';
import { flashHint } from '../hints';
import { moveTab, newestClosedAt, othersOf, trackClosedTimes } from './logic';
import { captureTabView, forgetTabViews, registerTabView, restoreTabView } from './viewState';

interface TabsStore {
  state: TabsState | null;
  closedAt: Map<string, number>;
}

export const useTabs = create<TabsStore>(() => ({ state: null, closedAt: new Map() }));

export function getTabs(): TabsState | null {
  return useTabs.getState().state;
}

export function activeTab(): ProjectTab | null {
  const s = getTabs();
  return s?.tabs.find((t) => t.id === s.activeId) ?? null;
}

export function lastTabClosedAt(): number | null {
  return getTabs()?.closed.length ? newestClosedAt(useTabs.getState().closedAt) : null;
}

const isMock = (): boolean => !!(window as unknown as { __kryptMockHost?: unknown }).__kryptMockHost;

export function tabsAvailable(): boolean {
  return !isMock() && !!window.krypt?.tabs;
}

async function call<T extends ActionResult<unknown>>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${what}: ${(err as Error)?.message ?? String(err)}` } as T;
  }
}

const isCancel = (r: ActionResult<unknown>): boolean => !r.ok && /cancel/i.test(r.message ?? '');
const titleOf = (id: string): string => getTabs()?.tabs.find((t) => t.id === id)?.title ?? 'the project';

let capturedFor: string | null = null;
let lastResetAt = 0;
let pendingRestore: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

function captureActive(): void {
  const id = getTabs()?.activeId;
  if (!id) return;
  captureTabView(id);
  capturedFor = id;
}

function flushRestore(): void {
  const p = pendingRestore;
  if (!p) return;
  pendingRestore = null;
  clearTimeout(p.timer);
  requestAnimationFrame(() => restoreTabView(p.id));
}

function onActiveChanged(prevId: string, nextId: string): void {
  if (capturedFor !== prevId) captureTabView(prevId);
  capturedFor = null;
  if (pendingRestore) clearTimeout(pendingRestore.timer);
  pendingRestore = { id: nextId, timer: setTimeout(flushRestore, 2500) };
  if (Date.now() - lastResetAt < 1500) flushRestore();
}

function apply(s: TabsState): void {
  if (!s || !Array.isArray(s.tabs)) return;
  const prev = useTabs.getState();
  const closedAt = trackClosedTimes(prev.state ? prev.closedAt : null, s.closed.map((c) => c.id), Date.now());
  const prevActive = prev.state?.activeId ?? null;
  useTabs.setState({ state: s, closedAt });
  if (prevActive && prevActive !== s.activeId) onActiveChanged(prevActive, s.activeId);
  forgetTabViews(new Set([...s.tabs.map((t) => t.id), ...s.closed.map((c) => c.id)]));
}

export async function refreshTabs(): Promise<void> {
  try {
    apply(await window.krypt.tabs.state());
  } catch {
  }
}

let installed = false;

export function installTabsFeed(): void {
  if (installed || !window.krypt?.tabs) return;
  installed = true;
  window.krypt.tabs.onState(apply);
  void refreshTabs();
  useDocStore.subscribe((s, prev) => {
    if (s.project && s.project !== prev.project && s.lastChange === null && s.version !== prev.version) {
      lastResetAt = Date.now();
      if (pendingRestore) flushRestore();
    }
  });
  registerTabView('selection', {
    capture: () => ({ ch: getUi().selectedChannelId, ins: getUi().selectedInsertId }),
    restore: (v) => {
      const p = useDocStore.getState().project;
      if (!p) return;
      const want = (v ?? {}) as { ch?: string | null; ins?: string | null };
      const ui = getUi();
      ui.selectChannel(want.ch && p.channels[want.ch] ? want.ch : (p.channelOrder[0] ?? null));
      ui.selectInsert(want.ins && p.mixer.inserts[want.ins] ? want.ins : null);
    },
  });
}

function afterSwitch(): void {
  void refreshProjectStatus();
  onProjectPicked();
}

export async function newTab(template?: { id: string; name: string }): Promise<boolean> {
  captureActive();
  const r = await call(() => window.krypt.tabs.newTab(template ? { template: template.id } : undefined), 'New tab');
  if (!report(r)) return false;
  flashHint(template ? `New tab from "${template.name}"` : 'New tab', 'ok');
  afterSwitch();
  return true;
}

export async function openInTab(path?: string): Promise<boolean> {
  captureActive();
  const r = await call(() => window.krypt.tabs.open(path), 'Open project');
  if (isCancel(r)) return false;
  if (!report(r)) return false;
  await refreshProjectStatus();
  const id = r.data?.id;
  const name = (id && getTabs()?.tabs.find((t) => t.id === id)?.title) || useProjectStatus.getState().status?.name || path?.split(/[\\/]/).pop() || 'project';
  toast.success(`Opened ${name}`);
  onProjectPicked();
  return true;
}

export async function switchTab(id: string): Promise<boolean> {
  const s = getTabs();
  if (!s) return false;
  if (s.activeId === id) {
    onProjectPicked();
    return true;
  }
  captureActive();
  const r = await call(() => window.krypt.tabs.switchTo(id), 'Switch tab');
  if (!r.ok) {
    capturedFor = null;
    toast.warn(r.message || `Couldn't switch to ${titleOf(id)}`);
    return false;
  }
  flashHint(`Switched to ${titleOf(id)}`, 'ok', 1400);
  afterSwitch();
  return true;
}

export async function closeTab(id: string): Promise<boolean> {
  const title = titleOf(id);
  const wasActive = getTabs()?.activeId === id;
  if (wasActive) captureActive();
  const r = await call(() => window.krypt.tabs.close(id), 'Close tab');
  if (r.ok) {
    flashHint(`Closed ${title}`, 'ok', 1600);
    if (wasActive) void refreshProjectStatus();
    return true;
  }
  if (!r.data?.needsDecision) {
    capturedFor = null;
    toast.warn(r.message || `Couldn't close ${title}`);
    return false;
  }
  const choice = await modal.choose({
    title: `Save changes to "${title}"?`,
    message: 'Your changes are lost if you close it without saving.',
    choices: [
      { id: 'discard', label: "Don't save", tone: 'danger' },
      { id: 'save', label: 'Save', tone: 'primary' },
    ],
    cancelLabel: 'Cancel',
  });
  if (choice !== 'save' && choice !== 'discard') {
    capturedFor = null;
    return false;
  }
  const r2 = await call(() => window.krypt.tabs.close(id, choice), 'Close tab');
  if (isCancel(r2)) return false;
  if (!report(r2)) return false;
  if (choice === 'save') toast.success(`Saved and closed ${title}`);
  else flashHint(`Closed ${title} without saving`, 'ok', 1800);
  if (wasActive) void refreshProjectStatus();
  return true;
}

export async function closeOtherTabs(keepId: string): Promise<void> {
  const s = getTabs();
  if (!s) return;
  if (s.activeId !== keepId && !(await switchTab(keepId))) return;
  const ids = othersOf(s.tabs, keepId);
  let closed = 0;
  for (const id of ids) {
    if (!(await closeTab(id))) break;
    closed++;
  }
  if (closed > 1) flashHint(`Closed ${closed} tabs`, 'ok');
}

export async function moveTabTo(id: string, toIndex: number): Promise<void> {
  const s = getTabs();
  if (!s) return;
  useTabs.setState({ state: { ...s, tabs: moveTab(s.tabs, id, toIndex) } });
  const r = await call(() => window.krypt.tabs.move(id, toIndex), 'Move tab');
  if (!r.ok) {
    toast.error(r.message || "Couldn't move the tab");
    await refreshTabs();
  }
}

export async function reopenClosedTab(): Promise<boolean> {
  const closed = getTabs()?.closed ?? [];
  if (!closed.length) {
    flashHint('No closed tabs to reopen', 'warn');
    return false;
  }
  captureActive();
  const r = await call(() => window.krypt.tabs.reopenClosed(), 'Reopen tab');
  if (!report(r)) {
    capturedFor = null;
    return false;
  }
  flashHint(`Reopened ${closed[0].title}`, 'ok');
  afterSwitch();
  return true;
}

export async function saveTab(id: string): Promise<void> {
  if (getTabs()?.activeId !== id && !(await switchTab(id))) return;
  const r = await call(() => window.krypt.project.save(), 'Save');
  if (isCancel(r)) return;
  if (report(r)) {
    toast.success(`Saved ${r.data?.path?.split(/[\\/]/).pop() || titleOf(id)}`);
    void refreshProjectStatus();
  }
}

export async function revealTab(path: string): Promise<void> {
  const r = await call(() => window.krypt.app.showItemInFolder(path), 'Reveal in Explorer');
  report(r);
}

export async function copyTabPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    flashHint('Path copied', 'ok');
  } catch (err) {
    toast.error(`Couldn't copy the path: ${(err as Error)?.message ?? String(err)}`);
  }
}
