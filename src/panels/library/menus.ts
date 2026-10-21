import { BarChart3, Crosshair, FilePlus, FolderOpen, FolderPlus, LibraryBig, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import type { Collection } from '@shared/library/types';
import type { MenuItem } from '../../components/Menu';
import { analysedCount, fmtCount, plural } from '../../library/logic';
import { getLibraryState, selectCollection, useLibrary } from '../../library/store';
import {
  addFiles,
  addFolder,
  chooseFocus,
  clearFocus,
  createCollection,
  editCollection,
  removeCollection,
  rescanCollection,
  retryFailed,
  showTrackInFolder,
} from '../../library/actions';

export function collectionMenu(c: Collection, doc: Document): MenuItem[] {
  const focus = getLibraryState()?.focus;
  const isFocus = focus?.collectionId === c.id;
  const items: MenuItem[] = [
    { type: 'header', label: c.name },
    { label: 'Add folder…', icon: FolderPlus, hint: 'Every audio file in it and its subfolders', onSelect: () => void addFolder(c) },
    { label: 'Add files…', icon: FilePlus, onSelect: () => void addFiles(c) },
    { label: 'Rescan folders', icon: RefreshCw, hint: 'Queue new files, re-analyse changed ones, mark deleted ones missing', disabled: !c.folders.length, onSelect: () => void rescanCollection(c) },
  ];
  if (c.counts.failed) items.push({ label: `Retry ${plural(c.counts.failed, 'failed track')}`, icon: RotateCcw, onSelect: () => void retryFailed(c) });
  if (c.folders.length)
    items.push({
      type: 'submenu',
      label: 'Show folder',
      icon: FolderOpen,
      items: c.folders.map((f) => ({ label: f.split(/[\\/]/).pop() || f, detail: f, onSelect: () => void showTrackInFolder({ path: f, name: f }) })),
    });
  items.push(
    { type: 'separator' },
    { label: 'Style profile', icon: BarChart3, onSelect: () => selectCollection(c.id, 'profile') },
    isFocus
      ? { label: 'Edit AI focus brief…', icon: Crosshair, onSelect: () => chooseFocus(c, doc) }
      : { label: 'Use as AI focus…', icon: Crosshair, hint: 'Agents compose from this collection’s style profile', onSelect: () => chooseFocus(c, doc) },
  );
  if (isFocus) items.push({ label: 'Clear AI focus', icon: X, onSelect: () => void clearFocus() });
  items.push(
    { type: 'separator' },
    { label: 'Rename & tags…', icon: Pencil, onSelect: () => editCollection(c, doc) },
    { label: 'Remove collection…', icon: Trash2, danger: true, hint: 'Forgets the records; your files stay on disk', onSelect: () => void removeCollection(c) },
  );
  return items;
}

export function collectionPickerMenu(doc: Document): MenuItem[] {
  const s = getLibraryState();
  const cols = s?.collections ?? [];
  const selected = useLibrary.getState().selected;
  const items: MenuItem[] = [
    {
      label: 'All tracks',
      icon: LibraryBig,
      checked: selected === null,
      detail: plural(cols.reduce((a, c) => a + c.counts.total, 0), 'track'),
      onSelect: () => selectCollection(null, 'tracks'),
    },
    { type: 'separator' },
  ];
  for (const c of cols)
    items.push({
      label: c.name,
      icon: s?.focus?.collectionId === c.id ? Crosshair : undefined,
      checked: selected === c.id,
      detail: `${fmtCount(c.counts.total)} tracks · ${fmtCount(analysedCount(c))} analysed`,
      onSelect: () => selectCollection(c.id),
    });
  items.push({ type: 'separator' }, { label: 'New collection…', icon: Plus, onSelect: () => void createCollection(doc) });
  return items;
}
