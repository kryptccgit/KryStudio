import { create } from 'zustand';
import { patternLength } from '@shared/schema/project';
import { dispatch, getProject, withGroup } from '../doc/store';
import { getHome, showHome, showStudio } from '../home/store';
import { getAutoMix } from '../automix/store';
import { openMasterSong } from '../automix/actions';
import { useWorkspace, wm } from '../workspace/WindowManager';
import { playState } from '../live/playState';
import { isDirty, useAgents, useProjectStatus, useSettings } from '../state/status';
import { useChat } from '../panels/agent/chatStore';
import { copyClientSnippet, installClientSnippet, installedClients, loadClientConfigs, clientLabel } from '../panels/agent/connect';
import { useTabs } from '../app/tabs/store';
import { runCommand } from '../input/commands';
import { eventToKeys } from '../input/keymap';
import { modal, report, toast } from '../app/notify';
import { flashHint } from '../app/hints';
import { setMode } from '../app/actions';
import { TOURS, tourById } from './tours';
import {
  EMPTY_MEMORY,
  TOURS_KEY,
  actOf,
  drumRows,
  isStepDone,
  noteFinished,
  noteStarted,
  parseMemory,
  patternClipCount,
  stepsFor,
  type TourMemory,
} from './logic';
import type { AiChoice, TourAction, TourCtx, TourId, TourMaster, TourSnapshot, TourStep } from './types';

export interface TourRun {
  tourId: TourId;
  index: number;
  choice?: AiChoice;
  base: TourSnapshot;
  keys: string[];
  assisted: boolean;
  completing: boolean;
}

interface ToursState {
  run: TourRun | null;
  offer: boolean;
  memory: TourMemory;
}

function storageOk(): boolean {
  try {
    const k = `${TOURS_KEY}.probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function loadMemory(): TourMemory {
  try {
    return parseMemory(localStorage.getItem(TOURS_KEY));
  } catch {
    return { ...EMPTY_MEMORY };
  }
}

function saveMemory(m: TourMemory): void {
  useTours.setState({ memory: m });
  try {
    localStorage.setItem(TOURS_KEY, JSON.stringify(m));
  } catch {
  }
}

export const useTours = create<ToursState>(() => ({ run: null, offer: false, memory: loadMemory() }));

export function tourStorageOk(): boolean {
  return storageOk();
}

export function markOffered(): void {
  saveMemory({ ...useTours.getState().memory, offered: true });
}

function visiblePanels(open: string[]): string[] {
  if (!wm.ready) return [];
  return open.filter((id) => {
    try {
      return wm.isVisible(id);
    } catch {
      return false;
    }
  });
}

function exportDialogOpen(): boolean {
  try {
    return !!document.querySelector('[data-krypt-dialog] [role="dialog"][aria-label="Export audio"]');
  } catch {
    return false;
  }
}

function masterState(): TourMaster {
  try {
    const a = getAutoMix();
    const file = a.target === 'file';
    const phase: TourMaster['phase'] = !file
      ? 'idle'
      : a.phase === 'running' || a.phase === 'cancelling'
        ? 'running'
        : a.phase === 'done' || a.phase === 'failed' || a.phase === 'cancelled'
          ? a.phase
          : 'idle';
    return { open: file && a.visible, songPicked: file && a.song.status === 'ready', phase, ab: a.ab, verdict: a.verdict };
  } catch {
    return { open: false, songPicked: false, phase: 'idle', ab: 'after', verdict: 'open' };
  }
}

export function takeSnapshot(extra: { keys?: string[]; assisted?: boolean } = {}): TourSnapshot {
  const p = getProject();
  const home = getHome();
  const open = useWorkspace.getState().open.filter((id) => !id.startsWith('plugin:'));
  const status = useProjectStatus.getState();
  const mcp = useAgents.getState().mcp;
  const rows = drumRows(p);
  return {
    homeOpen: home.open || home.phase === 'pending',
    homeScreen: home.screen,
    open,
    visible: visiblePanels(open),
    playing: playState.playing(),
    mode: p?.transport.mode ?? 'pattern',
    bpm: p?.transport.bpm ?? 0,
    projectId: p?.id ?? '',
    tabCount: useTabs.getState().state?.tabs.length ?? 1,
    kick: rows.kick,
    clap: rows.clap,
    patternClips: patternClipCount(p),
    dirty: isDirty(status),
    savedPath: status.status?.path ?? null,
    exportOpen: exportDialogOpen(),
    master: masterState(),
    agentTab: useAgents.getState().agentTab,
    mcpClientIds: mcp?.clients.map((c) => c.clientId) ?? [],
    mcpClientNames: mcp?.clients.map((c) => c.name) ?? [],
    installedClients: installedClients(),
    hasApiKey: !!useSettings.getState().settings?.agent.hasApiKey,
    chatSent: useChat.getState().items.filter((i) => i.role === 'user').length,
    keys: extra.keys ?? [],
    assisted: extra.assisted ?? false,
  };
}

export function ctxOf(run: TourRun | null): TourCtx {
  return run?.choice ? { choice: run.choice } : {};
}

export function currentSteps(run: TourRun | null = useTours.getState().run): TourStep[] {
  if (!run) return [];
  const tour = TOURS[run.tourId];
  return tour ? stepsFor(tour, ctxOf(run)) : [];
}

export function currentStep(run: TourRun | null = useTours.getState().run): TourStep | null {
  return currentSteps(run)[run?.index ?? 0] ?? null;
}

function enter(run: Omit<TourRun, 'base' | 'keys' | 'assisted' | 'completing'>): void {
  const next: TourRun = { ...run, base: takeSnapshot(), keys: [], assisted: false, completing: false };
  useTours.setState({ run: next, offer: false });
  const step = currentStep(next);
  if (step?.onEnter) void perform(step.onEnter, ctxOf(next));
}

export function startTour(id: string): void {
  const tour = tourById(id);
  if (!tour) {
    toast.error(`There is no tour called "${id}".`);
    return;
  }
  installKeyWatch();
  const prev = useTours.getState().run;
  let memory = useTours.getState().memory;
  if (prev && prev.index >= currentSteps(prev).length - 1) memory = noteFinished(memory, prev.tourId);
  saveMemory(noteStarted(memory, tour.id));
  if (tour.id !== 'first-beat') showStudio();
  enter({ tourId: tour.id, index: 0 });
}

export function nextStep(): void {
  const run = useTours.getState().run;
  if (!run) return;
  const steps = currentSteps(run);
  if (run.index + 1 >= steps.length) {
    finishTour();
    return;
  }
  enter({ tourId: run.tourId, index: run.index + 1, choice: run.choice });
}

export function prevStep(): void {
  const run = useTours.getState().run;
  if (!run || run.index === 0) return;
  const index = run.index - 1;
  const steps = currentSteps(run);
  const choice = steps[index]?.do === 'choose' ? undefined : run.choice;
  enter({ tourId: run.tourId, index, choice });
}

export function chooseAi(choice: AiChoice): void {
  const run = useTours.getState().run;
  if (!run) return;
  enter({ tourId: run.tourId, index: run.index + 1, choice });
}

export function finishTour(): void {
  const run = useTours.getState().run;
  if (!run) return;
  saveMemory(noteFinished(useTours.getState().memory, run.tourId));
  useTours.setState({ run: null });
  toast.success(`Tour finished: ${TOURS[run.tourId].title}. More tours in Help ▸ Tours.`);
}

export function closeTour(): void {
  if (!useTours.getState().run) return;
  useTours.setState({ run: null });
  toast.info('Tour closed. Start it again any time from Help ▸ Tours.');
}

let confirming = false;

export async function requestCloseTour(): Promise<void> {
  const run = useTours.getState().run;
  if (!run || confirming) return;
  const steps = currentSteps(run);
  const mid = run.index > 0 && run.index < steps.length - 1;
  if (!mid) return closeTour();
  confirming = true;
  try {
    const ok = await modal.confirm({
      title: 'Stop the tour?',
      message: `You're on step ${run.index + 1} of ${steps.length}. You can start it again any time from Help ▸ Tours.`,
      confirmLabel: 'Stop the tour',
      cancelLabel: 'Keep going',
    });
    if (ok) closeTour();
  } finally {
    confirming = false;
  }
}

export function checkStep(): void {
  const run = useTours.getState().run;
  if (!run || run.completing) return;
  const step = currentStep(run);
  if (!step) return;
  const snap = takeSnapshot({ keys: run.keys, assisted: run.assisted });
  if (!isStepDone(step, snap, run.base, ctxOf(run))) return;
  useTours.setState({ run: { ...run, completing: true } });
  const at = run;
  setTimeout(() => {
    const now = useTours.getState().run;
    if (now && now.tourId === at.tourId && now.index === at.index && now.completing) nextStep();
  }, 700);
}

export async function doItForMe(): Promise<void> {
  const run = useTours.getState().run;
  const step = currentStep(run);
  if (!run || !step) return;
  const action = actOf(step, ctxOf(run));
  if (!action) return;
  useTours.setState({ run: { ...run, assisted: true } });
  await perform(action, ctxOf(run));
}

let keyWatch = false;

function installKeyWatch(): void {
  if (keyWatch) return;
  keyWatch = true;
  window.addEventListener(
    'keydown',
    (e) => {
      const run = useTours.getState().run;
      if (!run || e.repeat) return;
      const keys = eventToKeys(e);
      if (!keys || run.keys.includes(keys)) return;
      useTours.setState({ run: { ...run, keys: [...run.keys, keys].slice(-16) } });
    },
    true,
  );
}

function command(id: string): void {
  if (!runCommand(id)) toast.error(`Couldn't run "${id}" right now.`);
}

async function setSteps(row: 'kick' | 'clap', steps: number[]): Promise<void> {
  const p = getProject();
  const r = drumRows(p)[row];
  const patternId = p.transport.activePatternId;
  if (!r || !patternId || !p.patterns[patternId]) {
    toast.error('There is no pattern or drum row to fill. Start a new project (Ctrl+N) first.');
    return;
  }
  const notes = p.patterns[patternId].notes[r.id] ?? {};
  const lit = new Set(Object.values(notes).map((n) => n.tick));
  const todo = steps.filter((s) => !lit.has(s * 240));
  if (!todo.length) {
    flashHint(`${r.name}: already set`, 'ok');
    return;
  }
  await withGroup(`Tour: ${r.name} steps`, async (groupId) => {
    for (const step of todo) {
      const res = await dispatch('notes.toggleStep', { patternId, channelId: r.id, step }, { groupId });
      if (!res.ok) return;
    }
  });
  flashHint(`${r.name}: boxes ${todo.map((s) => s + 1).join(', ')} lit`, 'ok');
}

async function changeTempo(): Promise<void> {
  const bpm = getProject().transport.bpm;
  const target = Math.round(bpm) === 120 ? 130 : 120;
  const r = await dispatch('transport.set', { bpm: target });
  if (r.ok) flashHint(`Tempo ${target} BPM`, 'ok');
}

async function placeClips(count: number): Promise<void> {
  const p = getProject();
  const patternId = p.transport.activePatternId;
  const pat = patternId ? p.patterns[patternId] : undefined;
  const trackId = p.playlist.trackOrder[0];
  if (!pat || !patternId) {
    toast.error('There is no pattern to place. Make a beat first (tour "Start here: your first beat").');
    return;
  }
  if (!trackId) {
    toast.error('The Playlist has no tracks. Click + next to "Tracks" to add one.');
    return;
  }
  const len = patternLength(pat, p.transport.timeSig);
  let start = Math.max(0, ...Object.values(p.playlist.clips).filter((c) => c.trackId === trackId).map((c) => c.start + c.length));
  await withGroup('Tour: place the beat', async (groupId) => {
    for (let i = 0; i < count; i++) {
      const r = await dispatch('playlist.addClip', { kind: 'pattern', trackId, start, patternId }, { groupId });
      if (!r.ok) return;
      start += len;
    }
  });
  flashHint(`Placed ${pat.name} ${count} times`, 'ok');
}

async function installChosen(c: TourCtx): Promise<void> {
  if (!c.choice || c.choice === 'api-key') return;
  const configs = await loadClientConfigs();
  const cfg = configs.find((x) => x.client === c.choice);
  if (!cfg) {
    toast.error(`${clientLabel(c.choice)} can't be set up from here in this build. See Guides ▸ AI agents.`);
    return;
  }
  if (!cfg.installable) {
    if (await copyClientSnippet(cfg)) toast.info(`Paste it into ${clientLabel(c.choice)}'s MCP settings, then restart it.`);
    return;
  }
  await installClientSnippet(cfg);
}

export async function perform(a: TourAction, c: TourCtx = ctxOf(useTours.getState().run)): Promise<void> {
  try {
    switch (a.kind) {
      case 'command':
        return command(a.id);
      case 'open':
        if (!wm.ready) {
          toast.warn('The Studio is still starting. Try again in a moment.');
          return;
        }
        return wm.open(a.panel);
      case 'close':
        return wm.close(a.panel);
      case 'leaveHome':
        return showStudio();
      case 'resetLayout':
        return command('view.resetLayout');
      case 'agentTab':
        return command(a.tab === 'chat' ? 'tools.agentChat' : 'tools.connections');
      case 'steps':
        return await setSteps(a.row, a.steps);
      case 'tempo':
        return await changeTempo();
      case 'mode':
        return await setMode(a.mode);
      case 'clips':
        return await placeClips(a.count);
      case 'installClient':
        return await installChosen(c);
      case 'external': {
        const r = await window.krypt.app.openExternal(a.url);
        report(r, `Opened ${a.url.replace(/^https?:\/\//, '').replace(/\/$/, '')} in your browser`);
        return;
      }
      case 'showHome':
        return showHome(a.screen ?? 'home');
      case 'masterSong':
        return openMasterSong();
    }
  } catch (err) {
    toast.error(`That didn't work: ${(err as Error)?.message ?? String(err)}`);
  }
}
