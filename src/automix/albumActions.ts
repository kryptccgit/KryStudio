import type { ActionResult } from '@shared/types';
import type { AlbumExportOutcome, AlbumOutcome } from '@shared/automix/types';
import { AUDIO_EXTENSIONS } from '@shared/audio/formats';
import { toast } from '../app/notify';
import { droppedPaths } from '../app/fileDrop';
import { getProject } from '../doc/store';
import { refreshProjectStatus } from '../state/status';
import { onProjectPicked } from '../home/store';
import { entryState, failureMessage, isCancelMessage, referenceClash, usableReference } from './logic';
import { addMessage, addSongs, albumFormError, buildAlbumRequest, buildExportRequest, loudestAfter, moveSong, removeSong, type AlbumExportFormat } from './albumLogic';
import { albumBackToForm, albumBusy, getAlbum, updateAlbumForm, useAlbum } from './albumStore';
import { playReference, referenceController, stopReference } from './referencePick';
import { loadPresets } from './actions';
import { locateSim, transport } from '../live/playState';
import { openAlbumDialog } from './AlbumDialog';

export function openMasterAlbum(doc?: Document | null): void {
  void loadPresets();
  if (getAlbum().visible) return;
  openAlbumDialog(doc);
}

const busyWhy = (): string | null => (albumBusy() ? 'The album is being mastered or exported: wait for it, or cancel it' : null);

function add(paths: string[]): void {
  if (busyWhy()) {
    toast.warn(busyWhy()!);
    return;
  }
  const r = addSongs(getAlbum().form.songs, paths);
  updateAlbumForm({ type: 'setSongs', songs: r.songs });
  const extra = addMessage(r);
  if (r.added) toast.info(`Added ${r.added} song${r.added === 1 ? '' : 's'} (${r.songs.length} in the album).${extra ? ` ${extra}` : ''}`);
  else if (extra) toast.warn(`No songs added. ${extra}`);
  const ref = getAlbum().reference.path;
  if (r.added && referenceClash(ref, r.songs, true)) toast.warn('Your reference song is now one of the album songs: pick a different reference to match, or clear it');
}

export async function pickSongs(): Promise<void> {
  let paths: string[] | null = null;
  try {
    paths = await window.krypt.dialog.openFile({ title: 'Master an album: choose your songs (hold Ctrl to pick several)', filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }], multi: true });
  } catch (err) {
    toast.error(`Couldn't open the file dialog: ${failureMessage(err)}`);
    return;
  }
  if (!paths?.length) return;
  add(paths);
}

export function dropSongs(dt: DataTransfer): void {
  const paths = droppedPaths(dt);
  if (paths.length) add(paths);
}

export function removeAlbumSong(index: number): void {
  if (busyWhy()) return void toast.warn(busyWhy()!);
  updateAlbumForm({ type: 'setSongs', songs: removeSong(getAlbum().form.songs, index) });
}

export function moveAlbumSong(from: number, to: number): void {
  if (busyWhy()) return void toast.warn(busyWhy()!);
  updateAlbumForm({ type: 'setSongs', songs: moveSong(getAlbum().form.songs, from, to) });
}

export function clearAlbumSongs(): void {
  if (busyWhy()) return void toast.warn(busyWhy()!);
  updateAlbumForm({ type: 'setSongs', songs: [] });
}

export const albumReference = referenceController({
  get: () => getAlbum().reference,
  set: (reference) => useAlbum.setState({ reference }),
  locked: busyWhy,
  guard: (p) => referenceClash(p, getAlbum().form.songs, true),
});

export async function startAlbum(): Promise<void> {
  if (albumBusy()) {
    toast.warn('The album is already being mastered');
    return;
  }
  const s = getAlbum();
  const err = albumFormError(s.form);
  if (err) {
    toast.warn(err);
    return;
  }
  useAlbum.setState({ phase: 'running', progress: null, outcome: null, error: null, ab: 'after', abBusy: false, verdict: 'open', exported: null });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.automix.onProgress((p) => {
      if (getAlbum().phase === 'running' || getAlbum().phase === 'cancelling') useAlbum.setState({ progress: p });
    });
  } catch {
  }
  let r: ActionResult<AlbumOutcome>;
  try {
    r = await window.krypt.automix.masterAlbum(buildAlbumRequest(s.form, usableReference(s.reference, s.form.songs)));
  } catch (e) {
    r = { ok: false, message: failureMessage(e) };
  } finally {
    unsub();
  }
  const show = getAlbum().visible ? undefined : { action: { label: 'Show', run: () => openMasterAlbum() } };
  if (!r.ok || !r.data) {
    if (isCancelMessage(r.message)) {
      useAlbum.setState({ phase: 'cancelled', error: r.message ?? null });
      toast.info(r.message || 'Album mastering cancelled', show);
      return;
    }
    const message = failureMessage(r.message ?? '', 'Album mastering finished without a result');
    useAlbum.setState({ phase: 'failed', error: message });
    toast.error(`Master an album failed: ${message}`, show);
    return;
  }
  useAlbum.setState({ phase: 'done', outcome: r.data, progress: null, ab: 'after', verdict: 'open' });
  void refreshProjectStatus();
  onProjectPicked();
  toast.success(r.message || 'Album mastered', { ...(show ?? {}), durationMs: 10000 });
}

export async function cancelAlbum(): Promise<void> {
  const s = getAlbum();
  if (s.phase !== 'running' && s.exporting !== 'running') return;
  if (s.phase === 'running') useAlbum.setState({ phase: 'cancelling' });
  else useAlbum.setState({ exporting: 'cancelling' });
  try {
    const r = await window.krypt.automix.cancel();
    if (!r.ok) {
      if (getAlbum().phase === 'cancelling') useAlbum.setState({ phase: 'running' });
      if (getAlbum().exporting === 'cancelling') useAlbum.setState({ exporting: 'running' });
      toast.error(r.message || "Couldn't cancel");
    }
  } catch (err) {
    toast.error(`Couldn't cancel: ${failureMessage(err)}`);
  }
}

export async function stopAlbumReference(): Promise<void> {
  await stopRef();
}

async function stopRef(): Promise<void> {
  if (!getAlbum().refPlaying) return;
  useAlbum.setState({ refPlaying: false });
  await stopReference();
}

export async function setAlbumAB(want: 'after' | 'before'): Promise<boolean> {
  await stopRef();
  const s = getAlbum();
  const o = s.outcome;
  if (!o) return false;
  if (!o.entryId) {
    toast.warn('Nothing was mastered, so there is no Before to compare with');
    return false;
  }
  if (s.abBusy) return false;
  useAlbum.setState({ abBusy: true });
  try {
    const st = entryState(await window.krypt.doc.history(), o.entryId);
    if (st === 'missing') {
      toast.error(`The album's mastering isn't in this tab's history: switch to the "${o.name}" tab`);
      return false;
    }
    if ((want === 'after') !== (st === 'live')) {
      const r = await window.krypt.doc.toggleEntry(o.entryId);
      if (!r.ok) {
        toast.error(r.message || "Couldn't switch the album's mastering");
        return false;
      }
    }
    useAlbum.setState({ ab: want });
    return true;
  } catch (err) {
    toast.error(`Couldn't switch Before / After: ${failureMessage(err)}`);
    return false;
  } finally {
    useAlbum.setState({ abBusy: false });
  }
}

export async function playAlbumSong(index: number): Promise<void> {
  await stopRef();
  const o = getAlbum().outcome;
  const song = o?.songs[index];
  if (!o || !song) return;
  let here = false;
  try {
    here = Object.values(getProject().playlist.clips).some((c) => c.kind === 'audio' && c.start === song.startTick);
  } catch {
    here = false;
  }
  if (!here) {
    toast.warn(`"${song.name}" isn't in the open tab: switch to the "${o.name}" tab first`);
    return;
  }
  useAlbum.setState({ selected: index });
  try {
    await transport('pause');
    const l = await window.krypt.engine.locate(song.startTick);
    if (!l.ok) throw new Error(l.message || 'locate failed');
    locateSim(song.startTick);
    const r = await transport('play');
    if (!r.ok) throw new Error(r.message || 'play failed');
  } catch (err) {
    toast.error(`Couldn't play "${song.name}": ${failureMessage(err)}`);
  }
}

export async function playAlbumReference(): Promise<void> {
  const o = getAlbum().outcome;
  if (!o?.reference) return void toast.warn('This album had no reference song');
  if (await playReference(o.reference.path, loudestAfter(o))) useAlbum.setState({ refPlaying: true });
}

export async function keepAlbum(): Promise<void> {
  await stopRef();
  const s = getAlbum();
  if (!s.outcome) return;
  if (s.ab === 'before' && s.outcome.entryId && !(await setAlbumAB('after'))) return;
  useAlbum.setState({ verdict: 'kept' });
  toast.success('Kept. The mastering is one step in Edit ▸ History of the album tab, so you can still undo it later.');
}

export async function undoAlbum(): Promise<void> {
  const s = getAlbum();
  if (!s.outcome) return;
  if (!s.outcome.entryId) {
    useAlbum.setState({ verdict: 'undone' });
    toast.info('Nothing to undo: nothing was mastered');
    return;
  }
  if (!(await setAlbumAB('before'))) return;
  useAlbum.setState({ verdict: 'undone' });
  toast.info('Undone: the songs are back as they were. Edit ▸ History can bring the mastering back.');
}

export function setExportFormat(format: AlbumExportFormat): void {
  useAlbum.setState({ exportFormat: format });
}

export async function exportAlbum(): Promise<void> {
  await stopRef();
  const s = getAlbum();
  const o = s.outcome;
  if (!o) return;
  if (albumBusy()) return void toast.warn('Wait for the album to finish first');
  if (s.verdict === 'undone') toast.warn('You undid the mastering: this exports the songs as they were');
  else if (s.ab === 'before' && o.entryId) {
    if (!(await setAlbumAB('after'))) return;
  }
  if (s.verdict === 'open') useAlbum.setState({ verdict: 'kept' });
  useAlbum.setState({ exporting: 'running', exportProgress: null, exported: null });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.automix.onProgress((p) => {
      if (getAlbum().exporting !== 'idle') useAlbum.setState({ exportProgress: p });
    });
  } catch {
  }
  let r: ActionResult<AlbumExportOutcome>;
  try {
    r = await window.krypt.automix.exportAlbum(buildExportRequest(o, s.exportFormat));
  } catch (e) {
    r = { ok: false, message: failureMessage(e) };
  } finally {
    unsub();
  }
  useAlbum.setState({ exporting: 'idle', exportProgress: null, exported: r.data ?? null });
  if (r.ok) toast.success(r.message || 'Exported', { durationMs: 10000 });
  else if (/no folder was chosen/i.test(r.message ?? '')) toast.info('Export all: no folder chosen, nothing was written');
  else if (isCancelMessage(r.message)) toast.info(r.message || 'Export cancelled');
  else toast.error(r.message || 'Export all failed');
}

export function onAlbumDialogOpened(): void {
  useAlbum.setState({ visible: true });
}

export function onAlbumDialogClosed(): void {
  const s = getAlbum();
  useAlbum.setState({ visible: false });
  void stopRef();
  if (albumBusy(s)) {
    toast.info(s.exporting !== 'idle' ? 'Export all keeps going in the background' : 'The album keeps mastering in the background', { action: { label: 'Show', run: () => openMasterAlbum() } });
    return;
  }
  if (s.phase === 'done' && s.outcome && s.verdict === 'open') {
    if (s.ab === 'before' && s.outcome.entryId) {
      void setAlbumAB('after').then((ok) => {
        if (ok) toast.info('Album mastering kept: you closed on Before, so it was switched back on.');
      });
    } else if (s.outcome.entryId) toast.info('Album mastering kept: one step in Edit ▸ History if you change your mind.');
    useAlbum.setState({ verdict: 'kept' });
  }
  if (s.phase === 'failed' || s.phase === 'cancelled') albumBackToForm();
}
