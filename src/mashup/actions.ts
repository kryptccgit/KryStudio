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

export function mashupWithClip(clipId: string, doc?: Document | null): void {
  const slot = slotForClip(clipId);
  if (!slot) {
    toast.error("That clip isn't an audio clip any more: pick the songs in Auto Mashup instead");
    openMashup({ doc });
    return;
  }
  openMashup({ a: slot, doc });
}

export function projectSongs(): Array<{ clipId: string; label: string; detail: string }> {
  try {
    return matchTargets(getProject(), '', 64);
  } catch {
    return [];
  }
}

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

export async function pickFile(song: Song): Promise<void> {
  let paths: string[] | null = null;
  try {
    paths = await window.krypt.dialog.openFile({ title: `Song ${song.toUpperCase()} for the mashup`, filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }] });
  } catch (err) {
    toast.error(`Couldn't open the file dialog: ${failureMessage(err)}`);
    return;
  }
  if (!paths?.length) return;
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

export function applySuggestion(text: string): void {
  const patch = suggestionPatch(text);
  if (!patch) {
    toast.info('That suggestion has no one-click option: change it by hand');
    return;
  }
  editForm({ type: 'set', patch });
  toast.info(`Applied: ${text.split(':')[0]}. Checking again…`, { durationMs: 3000 });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
let inFlight: string | null = null;
let lastToasted: string | null = null;

export function scheduleCheck(now = false): void {
  const req = buildRequest(getMashup().form);
  if (!req) {
    if (timer) clearTimeout(timer);
    timer = null;
    seq++;
    useMashup.setState({ check: { ...IDLE_CHECK } });
    return;
  }
  const key = requestKey(req);
  const cur = getMashup().check;
  if (cur.key === key && (cur.status === 'ready' || (cur.status === 'checking' && (timer !== null || inFlight === key)))) return;
  if (timer) clearTimeout(timer);
  timer = null;
  useMashup.setState({ check: { ...cur, status: 'checking', key } });
  timer = setTimeout(() => void runCheck(), now ? 0 : CHECK_DEBOUNCE_MS);
}

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
  if (req.newProject !== false && !tabsAvailable() && !(await confirmDiscard('Make the mashup as a new project'))) return;
  useMashup.setState({ phase: 'running', request: req, progress: null, outcome: null, error: null });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.mashup.onProgress((p) => {
      if (isBuilding()) useMashup.setState({ progress: p });
    });
  } catch {
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
  if (s.request?.newProject !== false) onProjectPicked();
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

export function onDialogClosed(): void {
  const s = getMashup();
  useMashup.setState({ visible: false, picking: null });
  if (timer) clearTimeout(timer);
  timer = null;
  if (s.check.status === 'checking') useMashup.setState({ check: { ...s.check, status: 'idle', key: null } });
  if (isBuilding(s)) {
    toast.info('Still building the mashup in the background', { action: { label: 'Show', run: () => openMashup() } });
    return;
  }
  if (s.phase !== 'idle') backToForm();
}

export function onDialogOpened(): void {
  useMashup.setState({ visible: true });
  if (!isBuilding()) scheduleCheck(true);
}

export function openStudio(): void {
  showStudio();
  wm.open('playlist');
}

export function openModelManager(): void {
  wm.open('modelManager');
}

