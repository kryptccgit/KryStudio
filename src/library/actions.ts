import type { ActionResult } from '@shared/types';
import type { Collection, LibraryTrack, StyleProfile } from '@shared/library/types';
import { profileText } from '@shared/library/profile';
import { modal, toast, type ToastOpts } from '../app/notify';
import { droppedPaths } from '../app/fileDrop';
import { wm } from '../workspace/WindowManager';
import { getUi } from '../state/ui';
import { dispatch, getProject } from '../doc/store';
import { isCancelMessage, installedStemModels } from '../ears/logic';
import { getAnalyzerState, refreshAnalyzer } from '../panels/modelManager/store';
import { openAnalysisDialog } from '../ears/AnalysisDialog';
import {
  addResultSentence,
  baseName,
  classifyDrop,
  fmtCount,
  plural,
  rescanSentence,
} from './logic';
import {
  applyLibraryState,
  bumpReload,
  getLibraryState,
  profileBasis,
  refreshLibrary,
  selectCollection,
  setBusy,
  setProfileEntry,
  setSelection,
  useLibrary,
  type LibraryView,
} from './store';
import { openCollectionDialog } from './CollectionDialog';
import { openDeepDialog } from './DeepDialog';
import { openFocusDialog } from './FocusDialog';
import { openSimilarDialog } from './SimilarDialog';
import { openOriginalityDialog } from './OriginalityDialog';

async function call<T>(what: string, fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    const api = window.krypt?.library;
    if (!api) return { ok: false, message: 'This build has no reference library bridge. Update Krypt Studio.' };
    return await fn();
  } catch (err) {
    return { ok: false, message: `${what} failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

export function libraryAvailable(): boolean {
  return !!window.krypt?.library;
}

const OPEN_LIBRARY: ToastOpts = { action: { label: 'Open Library', run: () => openLibrary() } };

export function openModelManager(): void {
  wm.open('modelManager');
}

export function openLibrary(opts: { collectionId?: string | null; view?: LibraryView } = {}): void {
  if (opts.collectionId !== undefined) selectCollection(opts.collectionId, opts.view);
  else if (opts.view) useLibrary.setState({ view: opts.view });
  wm.open('library');
}

export function collectionById(id: string | null | undefined): Collection | null {
  if (!id) return null;
  return getLibraryState()?.collections.find((c) => c.id === id) ?? null;
}

export function createCollection(doc?: Document | null, opts: { name?: string; thenAddFolder?: boolean } = {}): Promise<Collection | null> {
  return new Promise((resolve) => {
    openCollectionDialog({
      doc,
      initial: { name: opts.name ?? '', tags: [] },
      title: 'New collection',
      submitLabel: opts.thenAddFolder ? 'Create and add folder…' : 'Create',
      onCancel: () => resolve(null),
      onSubmit: async (name, tags) => {
        const r = await call('Create collection', () => window.krypt.library.createCollection(name, tags));
        if (!r.ok || !r.data) {
          toast.error(r.message || `Couldn't create ${name}`);
          return false;
        }
        await refreshLibrary();
        selectCollection(r.data.id, 'tracks');
        toast.success(`Created ${r.data.name}${opts.thenAddFolder ? '' : '. Add a folder or drop files on it.'}`);
        resolve(r.data);
        if (opts.thenAddFolder) void addFolder(r.data);
        return true;
      },
    });
  });
}

export function editCollection(c: Collection, doc?: Document | null): void {
  openCollectionDialog({
    doc,
    initial: { name: c.name, tags: c.tags },
    title: `Edit ${c.name}`,
    submitLabel: 'Save',
    onSubmit: async (name, tags) => {
      const r = await call('Save collection', () => window.krypt.library.updateCollection(c.id, { name, tags }));
      if (!r.ok) {
        toast.error(r.message || `Couldn't save ${c.name}`);
        return false;
      }
      await refreshLibrary();
      toast.success(name !== c.name ? `Renamed ${c.name} to ${name}` : `Saved ${name}`);
      return true;
    },
  });
}

export async function removeCollection(c: Collection): Promise<boolean> {
  const focused = getLibraryState()?.focus?.collectionId === c.id;
  const ok = await modal.confirm({
    title: `Remove ${c.name} from the library?`,
    message:
      `Krypt forgets the analysis of its ${plural(c.counts.total, 'track')} and its style profile.\n` +
      `Your audio files stay on disk, untouched: nothing is deleted or moved.` +
      (focused ? `\n\nIt is the AI focus, so the focus is cleared too.` : ''),
    confirmLabel: 'Remove collection',
    destructive: true,
  });
  if (!ok) return false;
  setBusy(c.id, 'Removing');
  const r = await call('Remove collection', () => window.krypt.library.removeCollection(c.id));
  setBusy(c.id, null);
  if (!r.ok) {
    toast.error(r.message || `Couldn't remove ${c.name}`);
    return false;
  }
  if (useLibrary.getState().selected === c.id) selectCollection(null, 'tracks');
  await refreshLibrary();
  toast.success(`Removed ${c.name} from the library. Its files are still on disk.`);
  return true;
}

export async function addFolder(c: Collection, path?: string): Promise<boolean> {
  setBusy(c.id, 'Adding');
  const r = await call('Add folder', () => window.krypt.library.addFolder(c.id, path));
  setBusy(c.id, null);
  if (!r.ok || !r.data) {
    if (!isCancelMessage(r.message)) toast.error(r.message || `Couldn't add the folder to ${c.name}`);
    return false;
  }
  bumpReload();
  await refreshLibrary();
  (r.data.added ? toast.success : toast.info)(addResultSentence(r.data, c.name));
  return r.data.added > 0;
}

export async function addFiles(c: Collection, paths?: string[]): Promise<boolean> {
  setBusy(c.id, 'Adding');
  const r = await call('Add files', () => window.krypt.library.addFiles(c.id, paths));
  setBusy(c.id, null);
  if (!r.ok || !r.data) {
    if (!isCancelMessage(r.message)) toast.error(r.message || `Couldn't add the files to ${c.name}`);
    return false;
  }
  bumpReload();
  await refreshLibrary();
  (r.data.added ? toast.success : toast.info)(addResultSentence(r.data, c.name));
  return r.data.added > 0;
}

export async function addDropped(c: Collection, paths: string[]): Promise<void> {
  const { files, folders, ignored } = classifyDrop(paths);
  if (!files.length && !folders.length) {
    toast.warn(ignored.length ? `Can't add ${ignored.map(baseName).join(', ')}: drop audio files or folders` : 'Nothing to add');
    return;
  }
  setBusy(c.id, 'Adding');
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];
  if (files.length) {
    const r = await call('Add files', () => window.krypt.library.addFiles(c.id, files));
    if (r.ok && r.data) {
      added += r.data.added;
      skipped += r.data.skipped;
    } else errors.push(r.message || 'Couldn’t add the files');
  }
  for (const f of folders) {
    const r = await call('Add folder', () => window.krypt.library.addFolder(c.id, f));
    if (r.ok && r.data) {
      added += r.data.added;
      skipped += r.data.skipped;
    } else errors.push(`${baseName(f)}: ${r.message || 'couldn’t add it'}`);
  }
  setBusy(c.id, null);
  bumpReload();
  await refreshLibrary();
  if (added || skipped) (added ? toast.success : toast.info)(addResultSentence({ added, skipped }, c.name));
  if (errors.length) toast.error(errors.join(' · '));
  if (ignored.length) toast.warn(`Skipped ${ignored.map(baseName).join(', ')}: not audio`);
}

export async function dropOnCollection(c: Collection, dt: DataTransfer): Promise<void> {
  const paths = droppedPaths(dt);
  if (paths.length) await addDropped(c, paths);
}

export async function dropAsNewCollection(dt: DataTransfer): Promise<void> {
  const paths = droppedPaths(dt);
  if (!paths.length) return;
  const { files, folders } = classifyDrop(paths);
  if (!files.length && !folders.length) {
    toast.warn('Drop folders or audio files to make a collection');
    return;
  }
  const name = folders.length ? baseName(folders[0]) : 'New collection';
  const r = await call('Create collection', () => window.krypt.library.createCollection(name, []));
  if (!r.ok || !r.data) {
    toast.error(r.message || `Couldn't create ${name}`);
    return;
  }
  await refreshLibrary();
  selectCollection(r.data.id, 'tracks');
  toast.success(`Created ${r.data.name}`);
  await addDropped(r.data, paths);
}

export async function rescanCollection(c: Collection): Promise<void> {
  if (!c.folders.length) {
    toast.info(`${c.name} has no folders to rescan. Tracks added as files are checked when the queue reaches them.`);
    return;
  }
  setBusy(c.id, 'Rescanning');
  const r = await call('Rescan', () => window.krypt.library.rescan(c.id));
  setBusy(c.id, null);
  if (!r.ok || !r.data) {
    toast.error(r.message || `Couldn't rescan ${c.name}`);
    return;
  }
  bumpReload();
  await refreshLibrary();
  toast.success(rescanSentence(r.data, c.name));
}

export async function setQueuePaused(paused: boolean): Promise<void> {
  const r = await call(paused ? 'Pause' : 'Resume', () => window.krypt.library.setPaused(paused));
  if (!r.ok) {
    toast.error(r.message || `Couldn't ${paused ? 'pause' : 'resume'} the analysis queue`);
    return;
  }
  await refreshLibrary();
  toast.info(paused ? 'Library analysis paused. It stays paused across restarts until you resume.' : 'Library analysis resumed');
}

export async function retryFailed(c?: Collection | null): Promise<void> {
  const r = await call('Retry', () => window.krypt.library.retryFailed(c?.id));
  if (!r.ok || !r.data) {
    toast.error(r.message || "Couldn't re-queue the failed tracks");
    return;
  }
  bumpReload();
  await refreshLibrary();
  if (r.data.queued) toast.success(`Re-queued ${plural(r.data.queued, 'failed track')}${c ? ` in ${c.name}` : ''}`);
  else toast.info('No failed tracks to retry');
}

export async function setDeep(c: Collection, on: boolean, doc?: Document | null): Promise<void> {
  if (!on) {
    setBusy(c.id, 'Deep');
    const r = await call('Deep analysis', () => window.krypt.library.setDeep(c.id, false));
    setBusy(c.id, null);
    if (!r.ok) {
      toast.error(r.message || `Couldn't turn deep analysis off for ${c.name}`);
      return;
    }
    await refreshLibrary();
    toast.info(`Deep analysis off for ${c.name}. Tracks already done keep their transcribed lines.`);
    return;
  }
  if (!getAnalyzerState()) await refreshAnalyzer();
  const models = installedStemModels(getAnalyzerState());
  setBusy(c.id, 'Estimating');
  const est = await call('Estimate', () => window.krypt.library.estimateDeep(c.id));
  setBusy(c.id, null);
  openDeepDialog({
    doc,
    collection: c,
    estimate: est.ok && est.data ? est.data : null,
    estimateError: est.ok ? null : est.message || "Couldn't estimate the time",
    stemModel: models[0]?.name ?? null,
    onOpenModelManager: openModelManager,
    onConfirm: async () => {
      setBusy(c.id, 'Deep');
      const r = await call('Deep analysis', () => window.krypt.library.setDeep(c.id, true));
      setBusy(c.id, null);
      if (!r.ok) {
        toast.error(r.message || `Couldn't start deep analysis of ${c.name}`, /model/i.test(r.message ?? '') ? { action: { label: 'Open Model Manager', run: openModelManager } } : undefined);
        return false;
      }
      bumpReload();
      await refreshLibrary();
      const n = r.data?.queued ?? 0;
      toast.success(n ? `Deep analysis queued for ${plural(n, 'track')} in ${c.name}` : `Deep analysis on for ${c.name}. Every track is already done.`);
      return true;
    },
  });
}

export function chooseFocus(c: Collection, doc?: Document | null): void {
  const cur = getLibraryState()?.focus;
  openFocusDialog({
    doc,
    collection: c,
    initialBrief: cur?.collectionId === c.id ? cur.brief : '',
    isCurrent: cur?.collectionId === c.id,
    onSubmit: (brief) => setFocus(c, brief),
    onClear: () => clearFocus(),
  });
}

export async function setFocus(c: Collection, brief: string): Promise<boolean> {
  const r = await call('Set focus', () => window.krypt.library.setFocus({ collectionId: c.id, brief: brief.trim() }));
  if (!r.ok) {
    toast.error(r.message || `Couldn't set the AI focus to ${c.name}`);
    return false;
  }
  await refreshLibrary();
  const thin = c.counts.light + c.counts.deep < 10;
  toast.success(
    `AI focus: ${c.name}. Agents now compose from its style profile${brief.trim() ? ' and your brief' : ''}.`,
    thin ? { action: { label: 'Open profile', run: () => openLibrary({ collectionId: c.id, view: 'profile' }) } } : undefined,
  );
  if (thin) toast.warn(`${c.name} has few analysed tracks, so its profile is thin. It fills in as the queue runs.`);
  return true;
}

export async function clearFocus(): Promise<boolean> {
  const cur = getLibraryState()?.focus;
  const r = await call('Clear focus', () => window.krypt.library.setFocus(null));
  if (!r.ok) {
    toast.error(r.message || "Couldn't clear the AI focus");
    return false;
  }
  await refreshLibrary();
  toast.info(cur ? `AI focus cleared. Agents no longer lean on ${cur.name}.` : 'AI focus cleared');
  return true;
}

export function analyseTrack(t: LibraryTrack, doc?: Document | null): void {
  if (t.status === 'missing') {
    toast.warn(`${t.name} is missing on disk, so it can't be analysed. Rescan the collection when it's back.`);
    return;
  }
  openAnalysisDialog({ path: t.path }, doc);
}

export async function addTrackToProject(t: LibraryTrack): Promise<boolean> {
  if (t.status === 'missing') {
    toast.warn(`${t.name} is missing on disk, so it can't be added to the project`);
    return false;
  }
  const r = await call('Add to project', () => window.krypt.library.addToProject(t.id));
  if (!r.ok || !r.data) {
    toast.error(r.message || `Couldn't add ${t.name} to the project`);
    return false;
  }
  const channelId = r.data.channelId;
  toast.success(`Added ${t.name} to the Playlist as an audio clip`, {
    action: {
      label: 'Show Playlist',
      run: () => {
        if (channelId && getProject().channels[channelId]) getUi().selectChannel(channelId);
        wm.open('playlist');
      },
    },
  });
  return true;
}

export function findSimilar(t: LibraryTrack, doc?: Document | null): void {
  if (t.status === 'pending' || t.status === 'failed' || t.status === 'missing') {
    toast.warn(`${t.name} isn't analysed yet, so there is nothing to compare. It needs at least the light pass.`);
    return;
  }
  openSimilarDialog(t, doc);
}

export async function showTrackInFolder(t: Pick<LibraryTrack, 'path' | 'name'>): Promise<void> {
  try {
    const r = await window.krypt.app.showItemInFolder(t.path);
    if (!r.ok) toast.error(r.message || `Couldn't show ${t.name} in Explorer (is the file still there?)`);
  } catch (err) {
    toast.error(`Show in folder failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

export async function copyTrackPath(t: Pick<LibraryTrack, 'path'>): Promise<void> {
  try {
    await navigator.clipboard.writeText(t.path);
    toast.success('Path copied');
  } catch {
    toast.error('The clipboard is not available');
  }
}

export async function removeTracks(tracks: Array<Pick<LibraryTrack, 'id' | 'name'>>): Promise<boolean> {
  if (!tracks.length) return false;
  const one = tracks.length === 1;
  const ok = await modal.confirm({
    title: one ? `Remove ${tracks[0].name} from the library?` : `Remove ${fmtCount(tracks.length)} tracks from the library?`,
    message: `Krypt forgets ${one ? 'its' : 'their'} analysis. The audio ${one ? 'file stays' : 'files stay'} on disk, untouched.\nA rescan of the collection's folders adds ${one ? 'it' : 'them'} back.`,
    confirmLabel: one ? 'Remove track' : `Remove ${fmtCount(tracks.length)} tracks`,
    destructive: true,
  });
  if (!ok) return false;
  const r = await call('Remove tracks', () => window.krypt.library.removeTracks(tracks.map((t) => t.id)));
  if (!r.ok) {
    toast.error(r.message || "Couldn't remove the tracks");
    return false;
  }
  setSelection([], null);
  bumpReload();
  await refreshLibrary();
  toast.success(one ? `Removed ${tracks[0].name} from the library (the file is still on disk)` : `Removed ${fmtCount(tracks.length)} tracks from the library (files are still on disk)`);
  return true;
}

export async function revealTrack(trackId: string, fallbackName?: string): Promise<void> {
  const r = await call('Show reference', () => window.krypt.library.track(trackId));
  if (!r.ok || !r.data) {
    toast.error(r.message || `${fallbackName ?? 'That reference'} is no longer in the library`);
    return;
  }
  const t = r.data;
  useLibrary.setState((st) => ({
    selected: t.collectionId,
    view: 'tracks',
    filters: { ...st.filters, text: t.name, bpmMin: null, bpmMax: null, key: '', status: '' },
    selection: [t.id],
    anchor: t.id,
    reveal: t.id,
  }));
  wm.open('library');
}

export async function loadProfile(collectionId: string): Promise<StyleProfile | null> {
  const basis = profileBasis(collectionId);
  const prev = useLibrary.getState().profiles[collectionId];
  setProfileEntry(collectionId, { status: 'loading', profile: prev?.profile, basis });
  const r = await call('Style profile', () => window.krypt.library.profile(collectionId));
  if (!r.ok || !r.data) {
    setProfileEntry(collectionId, { status: 'error', profile: prev?.profile, message: r.message || "Couldn't build the style profile", basis });
    return null;
  }
  setProfileEntry(collectionId, { status: 'done', profile: r.data, basis });
  return r.data;
}

export async function copyProfileText(p: StyleProfile): Promise<void> {
  const focus = getLibraryState()?.focus;
  let text: string;
  try {
    text = profileText(p, { brief: focus?.collectionId === p.collectionId ? focus.brief : undefined });
  } catch (err) {
    toast.error(`Couldn't write the profile as text: ${(err as Error)?.message ?? String(err)}`);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${p.name} profile copied as text (what agents read)`);
  } catch {
    toast.error('The clipboard is not available');
  }
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('The clipboard is not available');
  }
}

export function checkOriginality(opts: { patternId?: string; doc?: Document | null } = {}): void {
  if (!libraryAvailable()) {
    toast.error('This build has no reference library, so the originality check is unavailable. Update Krypt Studio.');
    return;
  }
  if (opts.patternId && !getProject().patterns[opts.patternId]) {
    toast.warn('That pattern no longer exists');
    return;
  }
  openOriginalityDialog({ patternId: opts.patternId, doc: opts.doc });
}

export async function openPatternFromMatch(patternId: string, channelId: string): Promise<void> {
  const p = getProject();
  if (!p.patterns[patternId]) {
    toast.warn('That pattern no longer exists');
    return;
  }
  await dispatch('patterns.select', { id: patternId }, { silent: true });
  if (channelId && p.channels[channelId]) getUi().selectChannel(channelId);
  wm.open('pianoRoll');
  toast.info(`Showing ${p.patterns[patternId].name}${channelId && p.channels[channelId] ? ` · ${p.channels[channelId].name}` : ''} in the Piano Roll`);
}

export { OPEN_LIBRARY, applyLibraryState };
