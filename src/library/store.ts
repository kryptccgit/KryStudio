// Reference library state in the renderer: the LibraryState snapshot from
// main (collections, queue, focus) plus what the Library panel shows
// (collection, tab, filters, sort, selection) and cached style profiles.
// The panel's view state lives here (not in the component) so menus,
// dialogs and the originality report can point the panel at a track.

import { create } from 'zustand';
import type { LibraryState, StyleProfile } from '@shared/library/types';
import { EMPTY_FILTERS, analysedCount, type SortKey, type TrackFilters } from './logic';

export type LibraryView = 'tracks' | 'profile';

export interface ProfileEntry {
  status: 'loading' | 'done' | 'error';
  profile?: StyleProfile;
  message?: string;
  /** Analysed + deep track counts when it was fetched (stale detection). */
  basis: { analysed: number; deep: number };
}

interface LibraryStore {
  state: LibraryState | null;
  /** Collection shown in the panel; null = all tracks. */
  selected: string | null;
  view: LibraryView;
  filters: TrackFilters;
  sort: { key: SortKey; desc: boolean };
  /** Selected track ids in the table. */
  selection: string[];
  /** Shift-click anchor. */
  anchor: string | null;
  /** Bumped to make the track table refetch (after adds / removes). */
  reload: number;
  /** A track to scroll to and select once it shows up ("Show reference"). */
  reveal: string | null;
  profiles: Record<string, ProfileEntry>;
  /** Collection id → action in flight, for button spinners. */
  busy: Record<string, string>;
}

export const useLibrary = create<LibraryStore>(() => ({
  state: null,
  selected: null,
  view: 'tracks',
  filters: EMPTY_FILTERS,
  sort: { key: 'name', desc: false },
  selection: [],
  anchor: null,
  reload: 0,
  reveal: null,
  profiles: {},
  busy: {},
}));

export function getLibraryState(): LibraryState | null {
  return useLibrary.getState().state;
}

function apply(s: LibraryState | null | undefined): void {
  if (!s || !Array.isArray(s.collections)) return;
  useLibrary.setState((st) => {
    // The shown collection was removed (here or by an agent): fall back to "All tracks".
    const selected = st.selected && !s.collections.some((c) => c.id === st.selected) ? null : st.selected;
    return { state: s, selected, ...(selected !== st.selected ? { view: 'tracks' as const, selection: [], anchor: null } : {}) };
  });
}

/** Apply a snapshot we fetched ourselves (after an action), without waiting for onState. */
export function applyLibraryState(s: LibraryState | null | undefined): void {
  apply(s);
}

let installed = false;

/** Boot: fetch the library snapshot and follow every change from main. */
export function installLibrarySync(): void {
  if (installed) return;
  installed = true;
  const api = window.krypt?.library;
  if (!api) return;
  void refreshLibrary();
  api.onState(apply);
}

export async function refreshLibrary(): Promise<void> {
  try {
    apply(await window.krypt.library.state());
  } catch {
    /* main not ready yet: onState delivers it */
  }
}

export function setBusy(id: string, label: string | null): void {
  useLibrary.setState((st) => {
    const busy = { ...st.busy };
    if (label) busy[id] = label;
    else delete busy[id];
    return { busy };
  });
}

export function bumpReload(): void {
  useLibrary.setState((st) => ({ reload: st.reload + 1 }));
}

/** Show a collection (or all tracks) in the panel. Clears the selection; keeps filters. */
export function selectCollection(id: string | null, view?: LibraryView): void {
  useLibrary.setState((st) => ({
    selected: id,
    view: view ?? (id === null ? 'tracks' : st.view),
    selection: id === st.selected ? st.selection : [],
    anchor: id === st.selected ? st.anchor : null,
  }));
}

export function setView(view: LibraryView): void {
  useLibrary.setState({ view });
}

export function setFilters(patch: Partial<TrackFilters>): void {
  useLibrary.setState((st) => ({ filters: { ...st.filters, ...patch } }));
}

export function clearFilters(): void {
  useLibrary.setState({ filters: EMPTY_FILTERS });
}

export function setSort(sort: { key: SortKey; desc: boolean }): void {
  useLibrary.setState({ sort });
}

export function setSelection(ids: string[], anchor?: string | null): void {
  useLibrary.setState((st) => ({ selection: ids, anchor: anchor === undefined ? st.anchor : anchor }));
}

export function setProfileEntry(collectionId: string, entry: ProfileEntry): void {
  useLibrary.setState((st) => ({ profiles: { ...st.profiles, [collectionId]: entry } }));
}

/** Counts a profile is built from, to tell when it went stale. */
export function profileBasis(collectionId: string): { analysed: number; deep: number } {
  const c = getLibraryState()?.collections.find((x) => x.id === collectionId);
  return c ? { analysed: analysedCount(c), deep: c.counts.deep } : { analysed: 0, deep: 0 };
}
