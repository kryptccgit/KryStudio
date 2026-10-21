import { create } from 'zustand';
import type { LibraryState, StyleProfile } from '@shared/library/types';
import { EMPTY_FILTERS, analysedCount, type SortKey, type TrackFilters } from './logic';

export type LibraryView = 'tracks' | 'profile';

export interface ProfileEntry {
  status: 'loading' | 'done' | 'error';
  profile?: StyleProfile;
  message?: string;
  basis: { analysed: number; deep: number };
}

interface LibraryStore {
  state: LibraryState | null;
  selected: string | null;
  view: LibraryView;
  filters: TrackFilters;
  sort: { key: SortKey; desc: boolean };
  selection: string[];
  anchor: string | null;
  reload: number;
  reveal: string | null;
  profiles: Record<string, ProfileEntry>;
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
    const selected = st.selected && !s.collections.some((c) => c.id === st.selected) ? null : st.selected;
    return { state: s, selected, ...(selected !== st.selected ? { view: 'tracks' as const, selection: [], anchor: null } : {}) };
  });
}

export function applyLibraryState(s: LibraryState | null | undefined): void {
  apply(s);
}

let installed = false;

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

export function profileBasis(collectionId: string): { analysed: number; deep: number } {
  const c = getLibraryState()?.collections.find((x) => x.id === collectionId);
  return c ? { analysed: analysedCount(c), deep: c.counts.deep } : { analysed: 0, deep: 0 };
}
