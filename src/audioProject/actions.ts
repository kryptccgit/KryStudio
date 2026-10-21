// ──────────────────────────────────────────────────────────────────────
// Audio → Project (research/15 §3.6): any WAV / MP3 / M4A / FLAC → a NEW,
// editable project, through window.krypt.audioProject (electron/audioProject).
// Entry points: File ▸ Open audio as project… (Ctrl+Shift+O), Home ▸ Audio
// Tools, Home ▸ Projects, and an audio file dropped on Home. Every outcome
// ends in visible feedback: the dialog's summary / error, or a toast.
// ──────────────────────────────────────────────────────────────────────

import { tabsAvailable } from '../app/tabs/store';
import type { ActionResult, AudioProjectOptions, AudioProjectOutcome } from '@shared/types';
import { confirmDiscard } from '../app/actions';
import { toast } from '../app/notify';
import { refreshProjectStatus, useAgents } from '../state/status';
import { wm } from '../workspace/WindowManager';
import { onProjectPicked } from '../home/store';
import { addSampleChannel } from '../panels/channelRack/rackActions';
import { NOT_AVAILABLE, chatReferencePrompt, claudeCodeReferencePrompt, doneToast, failureMessage, fileName, isCancelMessage } from './logic';
import { getJob, isBusy, resetJob, useAudioProject } from './store';
import { openAudioProjectDialog, openDropChoiceDialog } from './AudioProjectDialog';

/** Open the Audio → Project dialog: the options for `path` (none = main asks for a file), or the running job. */
export function openAudioAsProject(path?: string, doc?: Document | null): void {
  const j = getJob();
  if (j.visible) return; // already on screen
  if (!isBusy(j)) {
    resetJob();
    useAudioProject.setState({ path: path ?? null });
  } else if (path && path !== j.path) toast.warn(`Still converting ${j.path ? fileName(j.path) : 'a song'}: one at a time. Cancel it first to convert ${fileName(path)}.`);
  openAudioProjectDialog(doc);
}

/** Start the conversion with the dialog's options (the result opens in a new project tab). */
export async function startConversion(opts: AudioProjectOptions): Promise<void> {
  if (isBusy()) {
    toast.warn('A conversion is already running');
    return;
  }
  // With project tabs the result opens in a new tab, so nothing is lost; the browser mock still asks.
  if (!tabsAvailable() && !(await confirmDiscard('Open audio as a new project'))) return; // stays on the options
  const path = getJob().path;
  useAudioProject.setState({ phase: 'running', opts, progress: null, outcome: null, error: null });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.audioProject.onProgress((p) => {
      if (isBusy()) useAudioProject.setState({ progress: p });
    });
  } catch {
    /* no progress feed: the bar stays indeterminate */
  }
  let r: ActionResult<AudioProjectOutcome>;
  try {
    r = await window.krypt.audioProject.open(path ?? undefined, opts);
  } catch (err) {
    r = { ok: false, message: failureMessage(err) };
  } finally {
    unsub();
  }
  finish(r);
}

function finish(r: ActionResult<AudioProjectOutcome>): void {
  const j = getJob();
  if (!r.ok) {
    if (isCancelMessage(r.message)) {
      // Main's file dialog was closed before anything started: back to the options.
      if (j.phase !== 'cancelling' && !j.progress && !j.path) {
        useAudioProject.setState({ phase: 'idle' });
        if (!j.visible) toast.info('No file chosen: nothing was converted');
        return;
      }
      useAudioProject.setState({ phase: 'cancelled', error: null });
      if (!j.visible) toast.info('Audio → Project cancelled: your project was left as it was');
      return;
    }
    const message = failureMessage(r.message ?? '');
    useAudioProject.setState({ phase: 'failed', error: message });
    // The dialog shows the reason; a toast too when it's hidden, or when this build can't convert at all.
    if (!j.visible || message === NOT_AVAILABLE) toast.error(message, j.visible ? undefined : { action: { label: 'Details', run: () => openAudioAsProject() } });
    return;
  }
  const o = r.data;
  if (!o) {
    useAudioProject.setState({ phase: 'failed', error: 'The converter finished without a result' });
    toast.error('Audio → Project finished without a result');
    return;
  }
  useAudioProject.setState({ phase: 'done', outcome: o, progress: null });
  void refreshProjectStatus();
  onProjectPicked(); // Home steps aside: the new project is in the Studio behind the summary
  if (!j.visible) toast.success(doneToast(o), { action: { label: 'Summary', run: () => openAudioAsProject() } });
}

export async function cancelConversion(): Promise<void> {
  if (getJob().phase !== 'running') return;
  useAudioProject.setState({ phase: 'cancelling' });
  try {
    const r = await window.krypt.audioProject.cancel();
    if (!r.ok) {
      if (getJob().phase === 'cancelling') useAudioProject.setState({ phase: 'running' });
      toast.error(r.message || "Couldn't cancel the conversion");
    }
  } catch (err) {
    if (getJob().phase === 'cancelling') useAudioProject.setState({ phase: 'running' });
    toast.error(`Couldn't cancel: ${failureMessage(err)}`);
  }
}

/** The dialog was closed: a running job carries on (and says so); a finished one is cleared. */
export function onDialogClosed(): void {
  const j = getJob();
  useAudioProject.setState({ visible: false });
  if (isBusy(j)) {
    toast.info(`Still converting ${j.path ? fileName(j.path) : 'the song'} in the background`, { action: { label: 'Show', run: () => openAudioAsProject() } });
    return;
  }
  if (j.phase !== 'idle') resetJob();
}

// ── An audio file dropped on Home ─────────────────────────────────────

/** Home drop: offer "Open as project" / "Use as a reference for the AI" / "Add as a sample". */
export function offerDroppedAudio(paths: string[], doc?: Document | null): void {
  const [first] = paths;
  if (!first) return;
  if (paths.length > 1) toast.info(`One song at a time: using ${fileName(first)}`);
  openDropChoiceDialog(first, doc);
}

export async function addDroppedAsSample(path: string): Promise<void> {
  const id = await addSampleChannel(path);
  if (id) toast.success(`Added ${fileName(path)} to the Channel Rack`);
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The built-in agent chat, with "Make a song like "<path>"" on the clipboard to paste. */
export async function referenceInAgentChat(path: string): Promise<void> {
  const text = chatReferencePrompt(path);
  const copied = await copy(text);
  useAgents.setState({ agentTab: 'chat' });
  wm.open('agent');
  if (copied) toast.success('Copied the request: paste it into the agent chat (Ctrl+V), add what you want, then send', { durationMs: 9000 });
  else toast.warn(`Couldn't use the clipboard. Type this into the agent chat: ${text}`, { durationMs: 12000 });
}

/** Claude Code's `like` prompt with the path filled in, on the clipboard. */
export async function copyClaudeCodePrompt(path: string): Promise<void> {
  const text = claudeCodeReferencePrompt(path);
  if (await copy(text)) toast.success('Copied: paste it into Claude Code, finish the sentence ("make it edm"), then press Enter', { durationMs: 9000 });
  else toast.warn(`Couldn't use the clipboard. In Claude Code, type: ${text}`, { durationMs: 12000 });
}

/** Open the Model Manager (HT-Demucs) from the dialog. */
export function openModelManager(): void {
  wm.open('modelManager');
}

/** Show the Playlist (the stems tracks, the arrangement). */
export function showPlaylist(): void {
  wm.open('playlist');
}

