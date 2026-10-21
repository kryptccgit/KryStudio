// ──────────────────────────────────────────────────────────────────────
// Auto Mix / Auto Master (research/20) through window.krypt.automix
// (electron/automix). Entry points: the Mixer's Auto Mix button, the
// Auto Master button on the master strip, Tools ▸ Auto Mix…, Home ▸ Audio
// Tools ▸ Master a song, and the playlist audio-clip menu ▸ Auto-mix this
// vocal. The prompt is read live (debounced automix.understand). The
// result is ONE history entry: A/B = doc.toggleEntry(entryId), Undo =
// toggle it off. Every outcome ends in visible feedback.
// ──────────────────────────────────────────────────────────────────────

import type { ActionResult } from '@shared/types';
import type { AutoMixIntent, AutoMixMode, AutoMixOutcome } from '@shared/automix/types';
import type { SampleInfo } from '@shared/engine/protocol';
import { AUDIO_EXTENSIONS, AUDIO_FILE_RE } from '@shared/audio/formats';
import { songNameFromPath } from '@shared/automix/reference';
import { droppedPaths } from '../app/fileDrop';
import { toast } from '../app/notify';
import { openExport } from '../app/actions';
import { loadExportPrefs, saveExportPrefs } from '../app/exportRequest';
import { getProject } from '../doc/store';
import { refreshProjectStatus } from '../state/status';
import { onProjectPicked } from '../home/store';
import {
  NOT_AVAILABLE,
  buildMasterFileRequest,
  buildRequest,
  doneToast,
  entryState,
  failureMessage,
  fileLabel,
  fmtLufs,
  formError,
  isCancelMessage,
  isNoFileMessage,
  masterRunBlocker,
  promptWorthUnderstanding,
  referenceClash,
  songBars,
  songSummary,
  usableReference,
  type AutoMixTarget,
  type FormAction,
} from './logic';
import { IDLE_UNDERSTAND, backToForm, getAutoMix, isRunning, updateForm, useAutoMix } from './store';
import { openAutoMixDialog } from './AutoMixDialog';
import { playReference, referenceController, stopReference } from './referencePick';
import { referencePath } from './logic';

const UNDERSTAND_DEBOUNCE_MS = 550;

// ── Opening ───────────────────────────────────────────────────────────

export interface OpenAutoMix {
  mode?: AutoMixMode;
  target?: AutoMixTarget;
  /** Treat these inserts / channels as the vocals (playlist clip menu). */
  vocal?: { inserts: string[]; label: string };
  doc?: Document | null;
}

/** Open the Auto Mix dialog: the form (set up for the entry point), the running job, or a result still waiting for Keep / Undo. */
export function openAutoMix(opts: OpenAutoMix = {}): void {
  const s = getAutoMix();
  const asks = !!(opts.mode || opts.target || opts.vocal);
  if (isRunning(s)) {
    if (asks) toast.warn('Auto Mix is already running: one at a time. Cancel it first to start another.');
  } else if (s.phase === 'done' && s.verdict === 'open' && s.outcome) {
    if (asks) toast.info('Keep or undo this result first, then run Auto Mix again.');
  } else {
    if (s.phase !== 'idle') backToForm();
    const target = opts.target ?? 'project';
    useAutoMix.setState({ target });
    if (target === 'file') updateForm({ type: 'setMode', mode: 'master' });
    else if (opts.vocal) {
      updateForm({ type: 'setVocals', inserts: opts.vocal.inserts, label: opts.vocal.label });
      updateForm({ type: 'setMode', mode: 'vocals' });
    } else if (opts.mode) updateForm({ type: 'setMode', mode: opts.mode });
  }
  void loadPresets();
  // Already open on the same target: it's on screen. A new target (Master a song ↔ the project) re-opens it with its title.
  if (getAutoMix().visible && getAutoMix().target === s.target) return;
  openAutoMixDialog(opts.doc, getAutoMix().target);
}

/** Mixer ▸ master strip ▸ Auto Master. */
export function openAutoMaster(doc?: Document | null): void {
  openAutoMix({ mode: 'master', doc });
}

/** Home ▸ Audio Tools ▸ Master a song: master an audio file in a new project tab. */
export function openMasterSong(doc?: Document | null): void {
  openAutoMix({ target: 'file', doc });
}

/** The vocal an audio clip plays: its channel's insert (or the channel itself when it plays straight into the Master). */
export function vocalForClip(clipId: string): { inserts: string[]; label: string } | null {
  let p;
  try {
    p = getProject();
  } catch {
    return null;
  }
  const c = p.playlist.clips[clipId];
  if (!c || c.kind !== 'audio' || !c.channelId) return null;
  const ch = p.channels[c.channelId];
  if (!ch) return null;
  const ins = p.mixer.inserts[ch.insertId];
  if (ins && !ins.isMaster) return { inserts: [ins.id], label: ins.name };
  return { inserts: [ch.id], label: ch.name };
}

/** Playlist audio-clip menu ▸ Auto-mix this vocal: Vocals mode, that clip's insert as the vocal. */
export function autoMixVocalClip(clipId: string, doc?: Document | null): void {
  const v = vocalForClip(clipId);
  if (!v) {
    toast.error("That clip isn't an audio clip any more: Auto Mix will find the vocals by itself");
    openAutoMix({ mode: 'vocals', doc });
    return;
  }
  openAutoMix({ mode: 'vocals', vocal: v, doc });
}

// ── The reference song ────────────────────────────────────────────────

/** The form's reference row (pick / drop / clear); locked while a job runs. Master a song: never the song itself. */
export const autoMixReference = referenceController({
  get: () => getAutoMix().reference,
  set: (reference) => useAutoMix.setState({ reference }),
  locked: () => (isRunning() ? 'Auto Mix is running: change the reference after it finishes, or cancel it' : null),
  guard: (p) => (getAutoMix().target === 'file' ? referenceClash(p, [getAutoMix().song.path]) : null),
});

// ── Master a song, step ①: your song (picking never runs anything) ────

let songSeq = 0;

/** Use this file as the song to master: read its length and format (engine.sampleInfo, no analysis). */
export async function chooseSongFile(path: string): Promise<void> {
  if (isRunning()) {
    toast.warn('Mastering is running: change the song after it finishes, or cancel it');
    return;
  }
  if (!AUDIO_FILE_RE.test(path)) {
    toast.warn(`"${fileLabel(path)}" isn't an audio file: choose a WAV, MP3, M4A, FLAC or other audio file`);
    return;
  }
  const mine = ++songSeq;
  useAutoMix.setState({ song: { status: 'busy', path, summary: null, error: null } });
  let r: ActionResult<SampleInfo>;
  try {
    r = await window.krypt.engine.sampleInfo(path);
  } catch (err) {
    r = { ok: false, message: failureMessage(err, "Couldn't read the song") };
  }
  if (mine !== songSeq) return; // a newer pick won
  if (!r.ok || !r.data) {
    const error = failureMessage(r.message ?? '', "Couldn't read the song");
    useAutoMix.setState({ song: { status: 'failed', path, summary: null, error } });
    toast.error(`"${songNameFromPath(path)}" couldn't be read: ${error}`);
    return;
  }
  useAutoMix.setState({ song: { status: 'ready', path, summary: songSummary(r.data), error: null } });
  const ref = getAutoMix().reference;
  if (referenceClash(ref.path, [path])) toast.warn(`"${songNameFromPath(path)}" is also your reference song: pick a different reference to match, or clear it`);
  else toast.info(`Your song: "${songNameFromPath(path)}". Next, pick a style, then click Master my song.`);
}

/** "Choose your song…" / "Change…": a file dialog. Closing it leaves step ① as it was (visible). */
export async function pickSong(): Promise<void> {
  if (isRunning()) {
    toast.warn('Mastering is running: change the song after it finishes, or cancel it');
    return;
  }
  let paths: string[] | null = null;
  try {
    paths = await window.krypt.dialog.openFile({ title: 'Choose your song to master', filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }] });
  } catch (err) {
    toast.error(`Couldn't open the file dialog: ${failureMessage(err)}`);
    return;
  }
  if (!paths?.length) return;
  await chooseSongFile(paths[0]);
}

/** A file dropped on step ①. */
export function dropSong(dt: DataTransfer): void {
  const paths = droppedPaths(dt);
  if (!paths.length) return;
  const audio = paths.filter((p) => AUDIO_FILE_RE.test(p));
  if (!audio.length) {
    toast.warn('Drop an audio file (WAV, MP3, FLAC …) to master it');
    return;
  }
  if (audio.length > 1) toast.info(`One song at a time: using "${fileLabel(audio[0])}". For several songs, use Master an album.`);
  void chooseSongFile(audio[0]);
}

/** Unfold step ③ (the reference) or "More options" in Master a song (a guide's Show me). */
export function unfoldMasterPart(part: 'reference' | 'more'): void {
  useAutoMix.setState(part === 'reference' ? { showReference: true } : { showMore: true });
}

/** A/B ▸ Reference: play the reference loudness-matched to the result (the song stops). */
export async function playMatchedReference(): Promise<void> {
  const o = getAutoMix().outcome;
  if (!o?.reference) {
    toast.warn('This run had no reference song');
    return;
  }
  if (await playReference(o.reference.path, o.after.lufs)) useAutoMix.setState({ refPlaying: true });
}

export async function stopMatchedReference(): Promise<void> {
  if (!getAutoMix().refPlaying) return;
  useAutoMix.setState({ refPlaying: false });
  await stopReference();
}

// ── Presets ───────────────────────────────────────────────────────────

export async function loadPresets(force = false): Promise<void> {
  const cur = getAutoMix().presets;
  if (cur.status === 'loading' || (cur.status === 'ready' && !force)) return;
  useAutoMix.setState({ presets: { ...cur, status: 'loading', error: null } });
  try {
    const list = await window.krypt.automix.presets();
    useAutoMix.setState({ presets: { status: 'ready', list: Array.isArray(list) ? list : [], error: null } });
  } catch (err) {
    const error = failureMessage(err, "Couldn't load the presets");
    useAutoMix.setState({ presets: { status: 'failed', list: cur.list, error } });
    toast.error(`Auto Mix presets: ${error}`);
  }
}

// ── The form ──────────────────────────────────────────────────────────

export function editForm(act: FormAction): void {
  if (isRunning()) {
    toast.warn('Auto Mix is running: change the options after it finishes, or cancel it');
    return;
  }
  const before = getAutoMix().form.prompt;
  const form = updateForm(act);
  if (form.prompt !== before) scheduleUnderstand();
}

/** Forget the vocal pick (Auto Mix finds the vocals itself). */
export function clearVocals(): void {
  editForm({ type: 'setVocals', inserts: null, label: null });
}

// ── Understanding the prompt (live) ───────────────────────────────────

let uTimer: ReturnType<typeof setTimeout> | null = null;
let uSeq = 0;

/** Read the prompt once the user stops typing ("Understood as: …"). Nothing in the project changes. */
export function scheduleUnderstand(now = false): void {
  const text = getAutoMix().form.prompt.trim();
  if (uTimer) clearTimeout(uTimer);
  uTimer = null;
  if (!promptWorthUnderstanding(text)) {
    uSeq++; // drop an answer still on its way
    useAutoMix.setState({ understand: { ...IDLE_UNDERSTAND } });
    return;
  }
  const cur = getAutoMix().understand;
  if (cur.text === text && cur.status === 'ready') return;
  useAutoMix.setState({ understand: { ...cur, status: 'busy', text, error: null } });
  uTimer = setTimeout(() => void runUnderstand(text), now ? 0 : UNDERSTAND_DEBOUNCE_MS);
}

async function runUnderstand(text: string): Promise<void> {
  uTimer = null;
  const mine = ++uSeq;
  let r: ActionResult<AutoMixIntent>;
  try {
    r = await window.krypt.automix.understand(text);
  } catch (err) {
    r = { ok: false, message: failureMessage(err, "Couldn't read the prompt") };
  }
  if (mine !== uSeq || getAutoMix().form.prompt.trim() !== text) return; // the prompt changed meanwhile: a newer read is on its way
  if (!r.ok || !r.data) {
    // Shown under the prompt (visible); the run still reads the prompt itself.
    useAutoMix.setState({ understand: { status: 'failed', text, intent: null, error: failureMessage(r.message ?? '', "Couldn't read the prompt") } });
    return;
  }
  useAutoMix.setState({ understand: { status: 'ready', text, intent: r.data, error: null } });
}

// ── Run ───────────────────────────────────────────────────────────────

export async function startRun(): Promise<void> {
  if (isRunning()) {
    toast.warn('Auto Mix is already running');
    return;
  }
  const s = getAutoMix();
  const err = s.target === 'file' ? masterRunBlocker(s.song, s.form) : formError(s.form);
  if (err) {
    toast.warn(err);
    return;
  }
  const songPath = s.target === 'file' ? (s.song.path ?? '') : '';
  let bars: number | null = null;
  if (s.target === 'project') {
    try {
      bars = songBars(getProject());
    } catch {
      bars = null;
    }
  }
  useAutoMix.setState({ phase: 'running', progress: null, outcome: null, error: null, ab: 'after', abBusy: false, verdict: 'open', runSong: songPath ? songNameFromPath(songPath) : null });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.automix.onProgress((p) => {
      if (isRunning()) useAutoMix.setState({ progress: p });
    });
  } catch {
    /* no progress feed: the bar stays indeterminate */
  }
  let r: ActionResult<AutoMixOutcome>;
  try {
    r =
      s.target === 'file'
        ? await window.krypt.automix.masterFile(buildMasterFileRequest(s.form, songPath, usableReference(s.reference, [songPath])))
        : await window.krypt.automix.run(buildRequest(s.form, bars, referencePath(s.reference)));
  } catch (e) {
    r = { ok: false, message: failureMessage(e) };
  } finally {
    unsub();
  }
  finish(r);
}

function finish(r: ActionResult<AutoMixOutcome>): void {
  const s = getAutoMix();
  const show = s.visible ? undefined : { action: { label: 'Show', run: () => openAutoMix() } };
  if (!r.ok) {
    if (s.target === 'file' && isNoFileMessage(r.message) && !s.progress) {
      backToForm();
      toast.info(`Nothing was mastered: ${failureMessage(r.message ?? '', 'no song chosen')}`);
      return;
    }
    if (isCancelMessage(r.message)) {
      useAutoMix.setState({ phase: 'cancelled', error: null });
      toast.info(s.target === 'file' ? 'Master a song cancelled' : 'Auto Mix cancelled: your mix was left as it was', show);
      return;
    }
    const message = failureMessage(r.message ?? '');
    useAutoMix.setState({ phase: 'failed', error: message });
    toast.error(`Auto Mix failed: ${message}`, s.visible || message === NOT_AVAILABLE ? undefined : { action: { label: 'Details', run: () => openAutoMix() } });
    return;
  }
  const o = r.data;
  if (!o) {
    useAutoMix.setState({ phase: 'failed', error: 'Auto Mix finished without a result' });
    toast.error('Auto Mix finished without a result');
    return;
  }
  useAutoMix.setState({ phase: 'done', outcome: o, progress: null, ab: 'after', verdict: 'open' });
  void refreshProjectStatus();
  if (s.target === 'file') onProjectPicked(); // Home steps aside: the mastered song is in a new tab behind the result
  const notes = o.notes.length ? ` Good to know: ${o.notes[0]}` : '';
  const what = s.target === 'file' ? `"${s.runSong ?? 'Your song'}" is mastered: ${fmtLufs(o.before.lufs)} → ${fmtLufs(o.after.lufs)}. Next: play it and switch Before / After` : doneToast(o);
  toast.success(`${what}.${notes}`, { ...(show ?? {}), durationMs: 10000 });
}

export async function cancelRun(): Promise<void> {
  if (getAutoMix().phase !== 'running') return;
  useAutoMix.setState({ phase: 'cancelling' });
  try {
    const r = await window.krypt.automix.cancel();
    if (!r.ok) {
      if (getAutoMix().phase === 'cancelling') useAutoMix.setState({ phase: 'running' });
      toast.error(r.message || "Couldn't cancel Auto Mix");
    }
  } catch (err) {
    if (getAutoMix().phase === 'cancelling') useAutoMix.setState({ phase: 'running' });
    toast.error(`Couldn't cancel: ${failureMessage(err)}`);
  }
}

// ── The result: A/B, Keep, Undo, Export ───────────────────────────────

/** Put the project on Before (the Auto Mix step off) or After (on). Checks the real history first, so it never inverts. */
export async function setAB(want: 'after' | 'before'): Promise<boolean> {
  await stopMatchedReference();
  const s = getAutoMix();
  const o = s.outcome;
  if (!o) return false;
  if (!o.entryId) {
    toast.warn('This run changed nothing, so there is no Before to compare with');
    return false;
  }
  if (s.abBusy) return false;
  useAutoMix.setState({ abBusy: true });
  try {
    const st = entryState(await window.krypt.doc.history(), o.entryId);
    if (st === 'missing') {
      toast.error("The Auto Mix step isn't in this project's history any more (another project tab is open, or the history was cleared)");
      return false;
    }
    if ((want === 'after') !== (st === 'live')) {
      const r = await window.krypt.doc.toggleEntry(o.entryId);
      if (!r.ok) {
        toast.error(r.message || "Couldn't switch the Auto Mix step");
        return false;
      }
    }
    useAutoMix.setState({ ab: want });
    return true;
  } catch (err) {
    toast.error(`Couldn't switch Before / After: ${failureMessage(err)}`);
    return false;
  } finally {
    useAutoMix.setState({ abBusy: false });
  }
}

export async function toggleAB(): Promise<void> {
  await setAB(getAutoMix().ab === 'after' ? 'before' : 'after');
}

export async function keepResult(): Promise<void> {
  await stopMatchedReference();
  const s = getAutoMix();
  if (!s.outcome) return;
  if (s.ab === 'before' && s.outcome.entryId && !(await setAB('after'))) return;
  useAutoMix.setState({ verdict: 'kept' });
  toast.success('Kept. The whole Auto Mix is one step in Edit ▸ History, so you can still undo it later.');
}

export async function undoResult(): Promise<void> {
  const s = getAutoMix();
  if (!s.outcome) return;
  if (!s.outcome.entryId) {
    useAutoMix.setState({ verdict: 'undone' });
    toast.info('Nothing to undo: this run changed nothing');
    return;
  }
  if (!(await setAB('before'))) return;
  useAutoMix.setState({ verdict: 'undone' });
  toast.info('Undone: your mix is back as it was. Edit ▸ History can bring the Auto Mix back.');
}

/** Export… after a run: After is applied, the dialog's song scope without stems or normalize (that would undo the ceiling). */
export async function exportResult(close: () => void): Promise<void> {
  await stopMatchedReference();
  const s = getAutoMix();
  if (s.outcome && s.verdict === 'open') {
    if (s.ab === 'before' && s.outcome.entryId && !(await setAB('after'))) return;
    useAutoMix.setState({ verdict: 'kept' });
  } else if (s.verdict === 'undone') {
    toast.warn('You undid the Auto Mix: this exports your original mix');
  }
  const prefs = loadExportPrefs();
  saveExportPrefs({ ...prefs, scope: 'song', stems: false, normalize: false });
  close();
  openExport();
}

// ── The dialog's life ─────────────────────────────────────────────────

export function onDialogOpened(): void {
  useAutoMix.setState({ visible: true });
  void loadPresets();
  if (!isRunning() && getAutoMix().phase === 'idle') scheduleUnderstand(true);
}

/** Closed: a running job carries on (and says so); an undecided result counts as kept (and says so). */
export function onDialogClosed(): void {
  const s = getAutoMix();
  useAutoMix.setState({ visible: false });
  void stopMatchedReference();
  if (uTimer) clearTimeout(uTimer);
  uTimer = null;
  if (s.understand.status === 'busy') useAutoMix.setState({ understand: { ...s.understand, status: 'idle', text: '' } }); // read again on open
  if (isRunning(s)) {
    toast.info('Auto Mix keeps going in the background', { action: { label: 'Show', run: () => openAutoMix() } });
    return;
  }
  if (s.phase === 'done' && s.outcome && s.verdict === 'open') {
    if (s.ab === 'before' && s.outcome.entryId) {
      void setAB('after').then((ok) => {
        if (ok) toast.info('Auto Mix kept: you closed on Before, so it was switched back on. Undo it from Edit ▸ History.');
      });
    } else if (s.outcome.entryId) toast.info('Auto Mix kept: one step in Edit ▸ History if you change your mind.');
  }
  if (s.phase !== 'idle') backToForm();
}
