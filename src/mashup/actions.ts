// ──────────────────────────────────────────────────────────────────────
// Auto Mashup (research/18): two songs → one mashup project, through
// window.krypt.mashup (electron/mashup). Entry points: Home ▸ Audio Tools
// (the Auto Mashup card), Tools ▸ Auto Mashup…, and the playlist audio-clip
// menu ▸ Mashup with… (song A pre-filled). The form re-checks (debounced)
// whenever a song or an option changes. Every outcome ends in visible
// feedback: the dialog's readout / error, or a toast.
// ──────────────────────────────────────────────────────────────────────

import { tabsAvailable } from '../app/tabs/store';
import type { ActionResult } from '@shared/types';
import type { MashupCheck, MashupOutcome } from '@shared/mashup/types';
import type { LibraryTrack } from '@shared/library/types';
import { AUDIO_EXTENSIONS } from '@shared/audio/formats';
import { confirmDiscard } from '../app/actions';
import { toast } from '../app/notify';
import { getProject } from '../doc/store';
import { refreshProjectStatus } from '../state/status';
import { wm } from '../workspace/WindowManager';
import { onProjectPicked, showStudio } from '../home/store';
import { matchTargets } from '../ears/logic';
import {
  NOT_AVAILABLE,
  buildRequest,
  clipSlot,
  doneToast,
  failureMessage,
  fileSlot,
  formError,
  isCancelMessage,
  requestKey,
  suggestionPatch,
  type FormAction,
  type Song,
  type SongSlot,
} from './logic';
import { IDLE_CHECK, backToForm, getMashup, isBuilding, updateForm, useMashup } from './store';
import { openMashupDialog } from './MashupDialog';

const CHECK_DEBOUNCE_MS = 450;

// ── Opening ───────────────────────────────────────────────────────────

/** Open the Auto Mashup dialog: the form (optionally with song A set), or the running build. */
export function openMashup(opts: { a?: SongSlot; doc?: Document | null } = {}): void {
  const s = getMashup();
  if (opts.a) {
    if (isBuilding(s)) toast.warn('A mashup is being built: one at a time. Cancel it first to start another.');
    else {
      if (s.phase !== 'idle') backToForm();
      setSlot('a', opts.a);
    }
  }
  if (s.visible) return;
  openMashupDialog(opts.doc);
}

/** A slot for an audio clip of the open project (its channel's name). */
export function slotForClip(clipId: string): SongSlot | null {
  let p;
  try {
    p = getProject();
  } catch {
    return null;
  }
  const c = p.playlist.clips[clipId];
  if (!c || c.kind !== 'audio') return null;
  const name = (c.channelId && p.channels[c.channelId]?.name) || 'Audio clip';
  const t = matchTargets(p, '', 64).find((x) => x.clipId === clipId);
  return clipSlot(clipId, name, t?.detail ?? 'Audio clip in this project');
}

/** Playlist audio-clip menu ▸ Mashup with…: song A is that clip, the user picks B. */
export function mashupWithClip(clipId: string, doc?: Document | null): void {
  const slot = slotForClip(clipId);
  if (!slot) {
    toast.error("That clip isn't an audio clip any more: pick the songs in Auto Mashup instead");
    openMashup({ doc });
    return;
  }
  openMashup({ a: slot, doc });
}

/** The project's audio clips that can be a song (the first clip of every audio channel). */
export function projectSongs(): Array<{ clipId: string; label: string; detail: string }> {
  try {
    return matchTargets(getProject(), '', 64);
  } catch {
    return [];
  }
}

// ── The form ──────────────────────────────────────────────────────────

/** Change the form, then re-check (debounced). */
export function editForm(act: FormAction): void {
  if (isBuilding()) {
    toast.warn('The mashup is being built: change it after it finishes, or cancel it');
    return;
  }
  updateForm(act);
  scheduleCheck();
}

export function setSlot(song: Song, slot: SongSlot | null): void {
  editForm({ type: 'setSlot', song, slot });
  useMashup.setState({ picking: null });
}

/** Choose a file for a slot with the system file dialog. */
export async function pickFile(song: Song): Promise<void> {
  let paths: string[] | null = null;
  try {
    paths = await window.krypt.dialog.openFile({ title: `Song ${song.toUpperCase()} for the mashup`, filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }] });
  } catch (err) {
    toast.error(`Couldn't open the file dialog: ${failureMessage(err)}`);
    return;
  }
  if (!paths?.length) return; // closed: the slot stays as it was, which is visible
  setSlot(song, fileSlot(paths[0]));
}

export function pickClip(song: Song, clipId: string): void {
  const slot = slotForClip(clipId);
  if (!slot) {
    toast.error("That audio clip isn't in the project any more");
    return;
  }
  setSlot(song, slot);
}

export function pickLibraryTrack(song: Song, t: LibraryTrack): void {
  setSlot(song, fileSlot(t.path, 'library', t.name));
}

/** Search the reference library for the picker (never throws: failures toast and return []). */
export async function searchLibrary(text: string): Promise<LibraryTrack[]> {
  try {
    const r = await window.krypt.library.query({ text: text.trim() || undefined, sort: 'name', limit: 60 });
    if (!r.ok) {
      toast.error(r.message || "Couldn't search the reference library");
      return [];
    }
    return (r.data?.tracks ?? []).filter((t) => t.status !== 'missing');
  } catch (err) {
    toast.error(`Couldn't search the reference library: ${failureMessage(err)}`);
    return [];
  }
}

/** Apply a planner suggestion that maps to an option (the button only shows when it does). */
export function applySuggestion(text: string): void {
  const patch = suggestionPatch(text);
  if (!patch) {
    toast.info('That suggestion has no one-click option: change it by hand');
    return;
  }
  editForm({ type: 'set', patch });
  toast.info(`Applied: ${text.split(':')[0]}. Checking again…`, { durationMs: 3000 });
}

// ── The check ─────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
/** The request key of the check whose answer is on its way (null = none). */
let inFlight: string | null = null;
let lastToasted: string | null = null;

/** Re-check after the user stops changing things (immediately with `now`). */
export function scheduleCheck(now = false): void {
  const req = buildRequest(getMashup().form);
  if (!req) {
    if (timer) clearTimeout(timer);
    timer = null;
    seq++; // drop any answer still on its way
    useMashup.setState({ check: { ...IDLE_CHECK } });
    return;
  }
  const key = requestKey(req);
  const cur = getMashup().check;
  // Same request: its result is here, or its check is really waiting / on its way. (A "checking" status whose
  // answer was dropped as stale must not block a new check, or the dialog stays on "Listening…" forever.)
  if (cur.key === key && (cur.status === 'ready' || (cur.status === 'checking' && (timer !== null || inFlight === key)))) return;
  if (timer) clearTimeout(timer);
  timer = null;
  // Stale result: mark it as "checking" right away so Build waits for the new plan.
  useMashup.setState({ check: { ...cur, status: 'checking', key } });
  timer = setTimeout(() => void runCheck(), now ? 0 : CHECK_DEBOUNCE_MS);
}

/** Check the current form now (also the "Check again" button). */
export async function runCheck(force = false): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const req = buildRequest(getMashup().form);
  if (!req) return;
  const key = requestKey(req);
  const cur = getMashup().check;
  if (!force && cur.key === key && cur.status === 'ready') return;
  const mine = ++seq;
  useMashup.setState({ check: { ...cur, status: 'checking', key } });
  let r: ActionResult<MashupCheck>;
  inFlight = key;
  try {
    r = await window.krypt.mashup.check(req);
  } catch (err) {
    r = { ok: false, message: failureMessage(err) };
  } finally {
    if (mine === seq) inFlight = null;
  }
  if (mine !== seq || requestKey(buildRequest(getMashup().form)) !== key) {
    // The form changed meanwhile. A newer check is normally already scheduled; if none is, start one for the
    // form as it is now (the analysis is cached, so it's quick).
    if (mine === seq && timer === null) scheduleCheck(true);
    return;
  }
  if (!r.ok || !r.data) {
    const error = r.ok ? 'The check finished without a result' : failureMessage(r.message ?? '', "Couldn't read the songs");
    useMashup.setState({ check: { status: 'failed', key, result: null, error } });
    if (lastToasted !== error) toast.error(`Auto Mashup: ${error}`);
    lastToasted = error;
    return;
  }
  lastToasted = null;
  useMashup.setState({ check: { status: 'ready', key, result: r.data, error: null } });
}

// ── Build ─────────────────────────────────────────────────────────────

/** Why Build is disabled, or null. */
export function buildBlocker(): string | null {
  const s = getMashup();
  const err = formError(s.form);
  if (err) return err;
  if (s.check.status === 'checking' || s.check.status === 'idle') return 'Checking the songs…';
  if (s.check.status === 'failed') return s.check.error ?? "The songs couldn't be read";
  if (s.check.result?.problems.length) return s.check.result.problems[0];
  return null;
}

export async function startBuild(): Promise<void> {
  if (isBuilding()) {
    toast.warn('A mashup is already being built');
    return;
  }
  const blocker = buildBlocker();
  const req = buildRequest(getMashup().form);
  if (blocker || !req) {
    toast.warn(blocker ?? 'Pick two songs first');
    return;
  }
  // A new-project mashup opens in a new tab, so nothing is lost; the browser mock still asks.
  if (req.newProject !== false && !tabsAvailable() && !(await confirmDiscard('Make the mashup as a new project'))) return; // stays on the form
  useMashup.setState({ phase: 'running', request: req, progress: null, outcome: null, error: null });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.mashup.onProgress((p) => {
      if (isBuilding()) useMashup.setState({ progress: p });
    });
  } catch {
    /* no progress feed: the bar stays indeterminate */
  }
  let r: ActionResult<MashupOutcome>;
  try {
    r = await window.krypt.mashup.build(req);
  } catch (err) {
    r = { ok: false, message: failureMessage(err) };
  } finally {
    unsub();
  }
  finish(r);
}

function finish(r: ActionResult<MashupOutcome>): void {
  const s = getMashup();
  if (!r.ok) {
    if (isCancelMessage(r.message)) {
      useMashup.setState({ phase: 'cancelled', error: null });
      toast.info('Auto Mashup cancelled: your project was left as it was', s.visible ? undefined : { action: { label: 'Show', run: () => openMashup() } });
      return;
    }
    const message = failureMessage(r.message ?? '');
    useMashup.setState({ phase: 'failed', error: message });
    toast.error(`Auto Mashup failed: ${message}`, s.visible || message === NOT_AVAILABLE ? undefined : { action: { label: 'Details', run: () => openMashup() } });
    return;
  }
  const o = r.data;
  if (!o) {
    useMashup.setState({ phase: 'failed', error: 'The builder finished without a result' });
    toast.error('Auto Mashup finished without a result');
    return;
  }
  useMashup.setState({ phase: 'done', outcome: o, progress: null });
  void refreshProjectStatus();
  if (s.request?.newProject !== false) onProjectPicked(); // Home steps aside: the mashup is in the Studio behind the summary
  const notes = o.notes.length ? ` Good to know: ${o.notes.slice(0, 2).join(' ')}` : '';
  toast.success(`${doneToast(o)}.${notes}`, { action: { label: 'Open Studio', run: openStudio }, durationMs: 12000 });
}

export async function cancelBuild(): Promise<void> {
  if (getMashup().phase !== 'running') return;
  useMashup.setState({ phase: 'cancelling' });
  try {
    const r = await window.krypt.mashup.cancel();
    if (!r.ok) {
      if (getMashup().phase === 'cancelling') useMashup.setState({ phase: 'running' });
      toast.error(r.message || "Couldn't cancel the mashup");
    }
  } catch (err) {
    if (getMashup().phase === 'cancelling') useMashup.setState({ phase: 'running' });
    toast.error(`Couldn't cancel: ${failureMessage(err)}`);
  }
}

/** The dialog was closed: a running build carries on (and says so); a finished one goes back to the form. */
export function onDialogClosed(): void {
  const s = getMashup();
  useMashup.setState({ visible: false, picking: null });
  if (timer) clearTimeout(timer);
  timer = null;
  if (s.check.status === 'checking') useMashup.setState({ check: { ...s.check, status: 'idle', key: null } }); // re-checked on open
  if (isBuilding(s)) {
    toast.info('Still building the mashup in the background', { action: { label: 'Show', run: () => openMashup() } });
    return;
  }
  if (s.phase !== 'idle') backToForm();
}

/** Called when the dialog opens: check the form if it has two songs and no fresh result. */
export function onDialogOpened(): void {
  useMashup.setState({ visible: true });
  if (!isBuilding()) scheduleCheck(true);
}

// ── Elsewhere ─────────────────────────────────────────────────────────

export function openStudio(): void {
  showStudio();
  wm.open('playlist');
}

export function openModelManager(): void {
  wm.open('modelManager');
}

