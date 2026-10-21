// ──────────────────────────────────────────────────────────────────────
// App verbs (File / Edit / View / Transport / Pattern) registered as
// commands. Menus, the keymap and the toolbar all call these by id, and
// every one ends in visible feedback.
// ──────────────────────────────────────────────────────────────────────

import { registerCommands, runCommand } from '../input/commands';
import { dispatch, getProject } from '../doc/store';
import { modal, report, toast } from './notify';
import { flashHint } from './hints';
import { transport } from '../live/playState';
import { toggleRecordArm } from '../live/liveInput';
import { openBooth } from '../booth/actions';
import { pianoAllOff } from '../input/typingPiano';
import { getUi, useUi } from '../state/ui';
import { isDirty, refreshProjectStatus, useAgents, useProjectStatus, useRender, type AgentTab } from '../state/status';
import { onPopoutWindow, wm } from '../workspace/WindowManager';
import { VIEW_MENU_ORDER, PANELS, type SingletonKind } from '../workspace/panels';
import type { ActionResult, RenderOptions } from '@shared/types';
import { installKeymapSync } from '../input/keymapSync';
import { openExportDialog } from './ExportDialog';
import { openProjectInfo } from './ProjectInfoDialog';
import { revealShortcuts } from '../panels/settings/KeymapEditor';
import { checkOriginality } from '../library/actions';
import { onProjectPicked, openGuides, toggleHome } from '../home/store';
import { openAudioAsProject } from '../audioProject/actions';
import { openMashup } from '../mashup/actions';
import { openAutoMix, openMasterSong } from '../automix/actions';
import { openMasterAlbum } from '../automix/albumActions';
import { openKryptVoice } from '../voice/VoiceDialog';
import { VIDEOS_ARTICLE } from '../guides/videos';
import { newTab, openInTab, tabsAvailable } from './tabs/store';
import { undoPanelClose } from '../workspace/panelUndo';
import { shortcutFor } from '../input/keymap';

// Dialogs open in the window that has focus (main or a dockview popout).
const popouts = new Set<Window>();
onPopoutWindow((w) => popouts.add(w));
function focusedDoc(): Document {
  for (const w of popouts) {
    if (w.closed) popouts.delete(w);
    else if (w.document.hasFocus()) return w.document;
  }
  return document;
}

const isCancel = (r: ActionResult): boolean => !r.ok && /cancel/i.test(r.message ?? '');

async function call<T extends ActionResult>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${what}: ${(err as Error)?.message ?? String(err)}` } as T;
  }
}

const isMock = (): boolean => !!(window as unknown as { __kryptMockHost?: unknown }).__kryptMockHost;

/** Ask before throwing away unsaved work (main handles the window-close prompt itself). */
export async function confirmDiscard(action: string): Promise<boolean> {
  let dirty = false;
  let name = getProject().meta.name;
  try {
    const st = await window.krypt.project.status();
    dirty = st.dirty;
    name = st.name || name;
  } catch {
    dirty = isDirty();
  }
  // The browser mock never tracks dirtiness, so fall back to "edited this session".
  if (!dirty && isMock()) dirty = useProjectStatus.getState().editedSinceStatus;
  if (!dirty) return true;
  return modal.confirm({
    title: 'Unsaved changes — continue?',
    message: `"${name}" has unsaved changes. ${action} and lose them?`,
    confirmLabel: 'Continue without saving',
    destructive: true,
  });
}

// ── File ──────────────────────────────────────────────────────────────

/** Ctrl+N / File ▸ New tab: a new project in a NEW tab (research/19). Resolves true when it's open (Home steps aside). */
export async function newProject(): Promise<boolean> {
  if (tabsAvailable()) return newTab();
  // Browser mock (no main process): replace the one project, as before tabs.
  if (!(await confirmDiscard('Start a new project'))) return false;
  const r = await call(() => window.krypt.project.newProject(), 'New project');
  if (!report(r)) return false;
  flashHint('New project', 'ok');
  void refreshProjectStatus();
  onProjectPicked();
  return true;
}

/**
 * Open a project (a dialog without a path). With tabs it opens in a new tab (main reuses an untouched new
 * project's tab and just activates an already-open file). Resolves true when it opened (Home steps aside).
 */
export async function openProject(path?: string): Promise<boolean> {
  if (tabsAvailable()) return openInTab(path);
  if (!(await confirmDiscard('Open another project'))) return false;
  const r = await call(() => window.krypt.project.open(path), 'Open project');
  if (isCancel(r)) return false;
  if (!report(r)) return false;
  toast.success(`Opened ${useProjectStatus.getState().status?.name ?? path ?? 'project'}`);
  void refreshProjectStatus();
  onProjectPicked();
  return true;
}

export async function saveProject(as = false): Promise<void> {
  const r = await call(() => (as ? window.krypt.project.saveAs() : window.krypt.project.save()), 'Save');
  if (isCancel(r)) return;
  if (report(r)) {
    const path = r.data?.path ?? '';
    toast.success(`Saved ${path.split(/[\\/]/).pop() || 'project'}`);
    void refreshProjectStatus();
  }
}

export async function importMidi(path?: string): Promise<boolean> {
  const r = await call(() => window.krypt.project.importMidi(path), 'Import MIDI');
  if (isCancel(r)) return false;
  if (!report(r)) return false;
  const d = r.data as { patternId?: string; channelIds?: string[] } | undefined;
  if (d?.patternId && getProject().patterns[d.patternId]) await dispatch('patterns.select', { id: d.patternId }, { silent: true });
  const n = d?.channelIds?.length ?? 0;
  const pat = d?.patternId ? getProject().patterns[d.patternId]?.name : null;
  toast.success(r.message || `Imported MIDI${pat ? ` into ${pat}` : ''}${n ? ` · ${n} channel${n === 1 ? '' : 's'}` : ''}`);
  return true;
}

export async function exportMidi(): Promise<void> {
  const pid = getProject().transport.activePatternId ?? undefined;
  const r = await call(() => window.krypt.project.exportMidi(pid), 'Export MIDI');
  if (isCancel(r)) return;
  if (report(r)) toast.success(`Exported MIDI to ${r.data?.path ?? 'file'}`);
}

export async function exportAudio(opts: Partial<RenderOptions> = {}, label = 'Export WAV', extra: { openFolder?: boolean } = {}): Promise<void> {
  if (useRender.getState().active) {
    toast.warn('A render is already running');
    return;
  }
  useRender.setState({ active: true, progress: 0, label });
  const r = await call(() => window.krypt.engine.render({ scope: { kind: 'song' }, format: 'wav24', tailSec: 2, ...opts }), label);
  useRender.setState({ active: false, progress: 0, label: '' });
  if (isCancel(r)) return;
  if (report(r)) {
    const d = r.data;
    const file = d?.path?.split(/[\\/]/).pop() ?? 'file';
    if (opts.stems) {
      const n = d?.stemResults?.length ?? d?.files?.length ?? 0;
      const folder = d?.path ?? '';
      // Show the folder's contents: select the first stem inside it (the folder itself when there is none).
      const reveal = d?.files?.[0] ?? folder;
      const show = (): void => void call(() => window.krypt.app.showItemInFolder(reveal), 'Show in folder').then((x) => report(x));
      toast.success(`Exported ${n ? `${n} stem${n === 1 ? '' : 's'}` : 'stems'} to ${folder.split(/[\\/]/).pop() || 'the chosen folder'}`, reveal ? { action: { label: 'Show in folder', run: show } } : undefined);
      if (extra.openFolder && reveal) {
        const shown = await call(() => window.krypt.app.showItemInFolder(reveal), 'Open folder');
        if (!shown.ok) toast.warn(`Exported, but couldn't open the folder: ${shown.message ?? 'unknown error'}`);
      }
      return;
    }
    toast.success(
      d ? `Exported ${file} · ${d.durationSec.toFixed(1)} s · peak ${d.peakDb.toFixed(1)} dB · ${d.lufsIntegrated.toFixed(1)} LUFS` : `Exported ${file}`,
    );
    // The audio is fine either way; say so when the song info couldn't go in.
    const tagged = d as { tagged?: boolean; tagNote?: string } | undefined;
    if (tagged && tagged.tagged === false && opts.tags !== false) toast.warn(`${file}: the song info and cover couldn't be written (${tagged.tagNote ?? 'unknown reason'}). The audio is fine.`);
    if (extra.openFolder && d?.path) {
      const shown = await call(() => window.krypt.app.showItemInFolder(d.path), 'Open folder');
      if (!shown.ok) toast.warn(`Exported, but couldn't open the folder: ${shown.message ?? 'unknown error'}`);
    }
  }
}

/** Ctrl+R: the export dialog (scope, bit depth, tail, normalize). */
export function openExport(): void {
  openExportDialog((opts, label, extra) => exportAudio(opts, label, extra), focusedDoc());
}

// ── Edit ──────────────────────────────────────────────────────────────

let undoQueue: Promise<void> = Promise.resolve();

/**
 * Ctrl+Z. If the user closed a panel after their last edit in this tab, the panel comes back where it was
 * (src/workspace/panelUndo.ts); otherwise the normal document undo. Key repeats run one after another.
 */
export function undo(): Promise<void> {
  undoQueue = undoQueue.then(undoOnce, undoOnce);
  return undoQueue;
}

async function undoOnce(): Promise<void> {
  const panel = await undoPanelClose().catch(() => ({ result: 'none' as const }));
  if (panel.result === 'reopened') {
    flashHint(`Reopened ${panel.title} · ${shortcutFor('edit.undo') ?? 'Ctrl+Z'}`, 'ok');
    return;
  }
  if (panel.result === 'failed') {
    toast.warn(`Couldn't reopen ${panel.title}. Open it from the View menu.`);
    return;
  }
  const r = await call(() => window.krypt.doc.undo(), 'Undo');
  if (r.ok) flashHint(r.message ?? 'Undone', 'ok');
  else if (/^nothing/i.test(r.message ?? '')) flashHint(r.message ?? 'Nothing to undo', 'warn');
  else toast.error(r.message ?? 'Undo failed');
}

export async function redo(): Promise<void> {
  const r = await call(() => window.krypt.doc.redo(), 'Redo');
  if (r.ok) flashHint(r.message ?? 'Redone', 'ok');
  else if (/^nothing/i.test(r.message ?? '')) flashHint(r.message ?? 'Nothing to redo', 'warn');
  else toast.error(r.message ?? 'Redo failed');
}

// ── Transport ─────────────────────────────────────────────────────────

export async function transportAction(action: 'play' | 'stop' | 'pause' | 'toggle'): Promise<void> {
  const r = await transport(action);
  if (!r.ok) toast.error(r.message ? `Transport: ${r.message}` : 'The audio engine did not respond');
}

export async function setMode(mode: 'pattern' | 'song'): Promise<void> {
  const r = await dispatch('transport.setMode', { mode });
  if (r.ok) flashHint(mode === 'song' ? 'Song mode: plays the Playlist' : 'Pattern mode: loops the active pattern', 'ok');
}

// ── Patterns ──────────────────────────────────────────────────────────

/** Show the agent panel on a given tab. */
function openAgentPanel(tab: AgentTab): void {
  useAgents.setState({ agentTab: tab });
  wm.open('agent');
}

export function stepPattern(dir: 1 | -1): void {
  const p = getProject();
  const order = p.patternOrder;
  if (!order.length) return;
  const i = Math.max(0, order.indexOf(p.transport.activePatternId ?? ''));
  const next = order[Math.max(0, Math.min(order.length - 1, i + dir))];
  if (next === p.transport.activePatternId) {
    flashHint(dir > 0 ? 'Last pattern' : 'First pattern', 'warn', 900);
    return;
  }
  void dispatch('patterns.select', { id: next }).then((r) => r.ok && flashHint(p.patterns[next]?.name ?? '', 'ok', 900));
}

export async function addPattern(): Promise<void> {
  const r = await dispatch<{ id: string }>('patterns.add', {});
  if (r.ok && r.data) flashHint(`Added ${getProject().patterns[r.data.id]?.name ?? 'pattern'}`, 'ok');
}

export async function nextEmptyPattern(): Promise<void> {
  const p = getProject();
  const empty = p.patternOrder.find((id) => Object.keys(p.patterns[id]?.notes ?? {}).length === 0 && id !== p.transport.activePatternId);
  if (empty) {
    await dispatch('patterns.select', { id: empty });
    flashHint(`${p.patterns[empty].name} (empty)`, 'ok');
  } else await addPattern();
}

export async function clonePattern(id = getProject().transport.activePatternId): Promise<void> {
  if (!id) return;
  const r = await dispatch<{ id: string }>('patterns.clone', { id });
  if (r.ok && r.data) flashHint(`Cloned to ${getProject().patterns[r.data.id]?.name ?? 'new pattern'}`, 'ok');
}

export async function renamePattern(id = getProject().transport.activePatternId): Promise<void> {
  if (!id) return;
  const cur = getProject().patterns[id];
  if (!cur) return;
  const name = await modal.prompt({
    title: 'Rename pattern',
    initialValue: cur.name,
    validate: (v) => (v.trim() ? (v.length > 64 ? 'At most 64 characters' : null) : 'Name cannot be empty'),
  });
  if (name && name !== cur.name) await dispatch('patterns.set', { id, name });
}

export async function deletePattern(id: string): Promise<void> {
  const p = getProject();
  const pat = p.patterns[id];
  if (!pat) return;
  const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId === id).length;
  const ok = await modal.confirm({
    title: `Delete ${pat.name}?`,
    message: clips ? `This also removes ${clips} playlist clip${clips === 1 ? '' : 's'} that use it.` : 'Its notes are removed. You can undo this.',
    confirmLabel: 'Delete pattern',
    destructive: true,
  });
  if (ok) {
    const r = await dispatch('patterns.remove', { id });
    if (r.ok) flashHint(`Deleted ${pat.name}`, 'ok');
  }
}

// ── Registration ──────────────────────────────────────────────────────

let registered = false;

export function registerAppCommands(): void {
  if (registered) return;
  registered = true;
  installKeymapSync();
  registerCommands([
    { id: 'file.new', label: 'New tab', run: newProject },
    { id: 'file.open', label: 'Open project', run: () => openProject() },
    { id: 'file.save', label: 'Save', run: () => saveProject(false) },
    { id: 'file.saveAs', label: 'Save as', run: () => saveProject(true) },
    { id: 'file.importMidi', label: 'Import MIDI', run: () => importMidi() },
    { id: 'file.exportMidi', label: 'Export MIDI', run: exportMidi },
    { id: 'file.exportWav', label: 'Export audio…', run: openExport },
    { id: 'file.quickExportWav', label: 'Export WAV (24-bit, quick)', run: () => exportAudio({ format: 'wav24' }, 'Export WAV') },
    { id: 'file.projectInfo', label: 'Project info', run: () => openProjectInfo(focusedDoc()) },
    { id: 'file.exportStems', label: 'Export stems', run: () => exportAudio({ format: 'wav24', stems: true }, 'Export stems') },
    { id: 'file.openAudioProject', label: 'Open audio as project', run: () => openAudioAsProject(undefined, focusedDoc()) },
    { id: 'file.exportWav16', label: 'Export WAV (16-bit)', run: () => exportAudio({ format: 'wav16' }, 'Export WAV') },
    { id: 'file.exportWav32', label: 'Export WAV (32-bit float)', run: () => exportAudio({ format: 'wav32f' }, 'Export WAV') },
    {
      id: 'file.exportPattern',
      label: 'Export pattern loop',
      run: () => exportAudio({ format: 'wav24', scope: { kind: 'pattern', patternId: getProject().transport.activePatternId ?? undefined }, tailSec: 0 }, 'Export pattern'),
    },
    { id: 'edit.undo', label: 'Undo', run: undo },
    { id: 'edit.redo', label: 'Redo', run: redo },
    { id: 'edit.history', label: 'History', run: () => wm.open('history') },
    { id: 'transport.togglePlay', label: 'Play / stop', run: () => transportAction('toggle') },
    { id: 'transport.play', label: 'Play', run: () => transportAction('play') },
    { id: 'transport.pause', label: 'Pause', run: () => transportAction('pause') },
    { id: 'transport.stop', label: 'Stop', run: () => transportAction('stop') },
    { id: 'transport.toggleRecord', label: 'Record arm', run: toggleRecordArm },
    { id: 'record.booth', label: 'Vocal Booth: record a vocal', run: () => openBooth() },
    { id: 'transport.toggleMode', label: 'Pattern / song mode', run: () => setMode(getProject().transport.mode === 'song' ? 'pattern' : 'song') },
    {
      id: 'transport.toggleMetronome',
      label: 'Metronome',
      run: async () => {
        const on = !getProject().transport.metronome;
        const r = await dispatch('transport.set', { metronome: on });
        if (r.ok) flashHint(on ? 'Metronome on' : 'Metronome off', 'ok');
      },
    },
    {
      id: 'transport.panic',
      label: 'Panic (all notes off)',
      run: () => {
        pianoAllOff();
        try {
          window.krypt.engine.auditionOff();
        } catch {
          /* ignore */
        }
        flashHint('All notes off', 'ok');
      },
    },
    { id: 'pattern.next', label: 'Next pattern', run: () => stepPattern(1) },
    { id: 'pattern.prev', label: 'Previous pattern', run: () => stepPattern(-1) },
    { id: 'pattern.nextEmpty', label: 'Next empty pattern', run: nextEmptyPattern },
    { id: 'pattern.add', label: 'New pattern', run: addPattern },
    { id: 'pattern.clone', label: 'Clone pattern', run: () => clonePattern() },
    { id: 'pattern.rename', label: 'Rename pattern', run: () => renamePattern() },
    {
      id: 'input.toggleTypingPiano',
      label: 'Typing keyboard to piano',
      run: () => {
        const on = !getUi().typingPiano;
        if (!on) pianoAllOff();
        useUi.getState().setTypingPiano(on);
        flashHint(on ? 'Typing keyboard plays the selected channel (Z and Q rows)' : 'Typing keyboard to piano: off', 'ok');
      },
    },
    { id: 'view.resetLayout', label: 'Reset layout', run: () => wm.resetLayout() },
    { id: 'tools.settings', label: 'Settings', run: () => wm.open('settings') },
    {
      id: 'tools.shortcuts',
      label: 'Keyboard shortcuts',
      run: () => {
        wm.open('settings');
        revealShortcuts();
      },
    },
    { id: 'tools.connections', label: 'Agent connections', run: () => openAgentPanel('connect') },
    { id: 'tools.agentChat', label: 'Agent chat', run: () => openAgentPanel('chat') },
    { id: 'tools.pluginManager', label: 'Plugin Manager', run: () => wm.open('pluginManager') },
    { id: 'tools.modelManager', label: 'Model Manager', run: () => wm.open('modelManager') },
    { id: 'tools.library', label: 'Reference library', run: () => wm.open('library') },
    { id: 'tools.checkOriginality', label: 'Check originality', run: () => checkOriginality({ doc: focusedDoc() }) },
    { id: 'tools.autoMashup', label: 'Auto Mashup', run: () => openMashup({ doc: focusedDoc() }) },
    { id: 'tools.autoMix', label: 'Auto Mix', run: () => openAutoMix({ doc: focusedDoc() }) },
    { id: 'tools.masterSong', label: 'Master a song', run: () => openMasterSong(focusedDoc()) },
    { id: 'tools.masterAlbum', label: 'Master an album', run: () => openMasterAlbum(focusedDoc()) },
    { id: 'tools.kryptVoice', label: 'Krypt Voice', run: () => openKryptVoice({ doc: focusedDoc() }) },
    { id: 'help.about', label: 'About', run: () => wm.open('about') },
    { id: 'view.home', label: 'Home', run: toggleHome },
    { id: 'help.guides', label: 'Guides', run: () => openGuides() },
    { id: 'help.videos', label: 'Video tutorials', run: () => openGuides(VIDEOS_ARTICLE) },
    ...VIEW_MENU_ORDER.map((k: SingletonKind) => ({ id: `view.toggle.${k}`, label: `Toggle ${PANELS[k].title}`, run: () => wm.toggle(k) })),
  ]);
}

export { runCommand };
