import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  AudioWaveform,
  Copy,
  FilterX,
  FolderOpen,
  FolderPlus,
  ListPlus,
  Loader2,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { Collection, LibraryTrack, TrackQuery } from '@shared/library/types';
import { openMenu, type MenuItem } from '../../components/Menu';
import { hasFiles } from '../../app/fileDrop';
import { cls } from '../../utils/format';
import {
  PAGE_SIZE,
  buildQuery,
  filtersActive,
  fmtBpmCell,
  fmtCount,
  fmtKeyShort,
  fmtLufs,
  fmtTrackLength,
  keyFilterOptions,
  nextSort,
  pagesFor,
  plural,
  queryKey,
  rangeSelect,
  statusFilterOptions,
  visibleRange,
  type SortKey,
} from '../../library/logic';
import { clearFilters, setFilters, setSelection, setSort, useLibrary } from '../../library/store';
import {
  addFiles,
  addFolder,
  addTrackToProject,
  analyseTrack,
  copyTrackPath,
  dropOnCollection,
  findSimilar,
  removeTracks,
  rescanCollection,
  retryFailed,
  showTrackInFolder,
} from '../../library/actions';
import { EmptyNote, SmallButton, StatusPill } from './ui';

const ROW_H = 28;
const REFRESH_MS = 1500;

interface PageStore {
  key: string;
  gen: number;
  total: number | null;
  pages: Map<number, LibraryTrack[]>;
  inflight: Set<string>;
  error: string | null;
}

function useTrackPages(base: TrackQuery, soft: string) {
  const key = queryKey(base);
  const baseRef = useRef(base);
  baseRef.current = base;
  const s = useRef<PageStore>({ key: '', gen: 0, total: null, pages: new Map(), inflight: new Set(), error: null });
  const wanted = useRef<number[]>([0]);
  const [, force] = useReducer((x: number) => x + 1, 0);

  const fetchPage = useCallback((page: number) => {
    const st = s.current;
    const gen = st.gen;
    const id = `${gen}:${page}`;
    if (st.inflight.has(id)) return;
    st.inflight.add(id);
    void (async () => {
      let r: Awaited<ReturnType<typeof window.krypt.library.query>>;
      try {
        r = await window.krypt.library.query({ ...baseRef.current, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
      } catch (err) {
        r = { ok: false, message: (err as Error)?.message ?? String(err) };
      }
      st.inflight.delete(id);
      if (s.current.gen !== gen) return;
      if (r.ok && r.data) {
        st.total = r.data.total;
        st.pages.set(page, r.data.tracks);
        st.error = null;
      } else st.error = r.message || "Couldn't load the tracks";
      force();
    })();
  }, []);

  if (s.current.key !== key) {
    s.current = { key, gen: s.current.gen + 1, total: null, pages: new Map(), inflight: new Set(), error: null };
    wanted.current = [0];
  }

  useEffect(() => {
    fetchPage(0);
  }, [key, fetchPage]);

  const last = useRef(0);
  const firstSoft = useRef(true);
  useEffect(() => {
    if (firstSoft.current) {
      firstSoft.current = false;
      return;
    }
    const run = (): void => {
      last.current = Date.now();
      const st = s.current;
      st.gen++;
      const keep = new Set(wanted.current.length ? wanted.current : [0]);
      for (const p of [...st.pages.keys()]) if (!keep.has(p)) st.pages.delete(p);
      for (const p of keep) fetchPage(p);
    };
    const wait = Math.max(0, last.current + REFRESH_MS - Date.now());
    const t = setTimeout(run, wait);
    return () => clearTimeout(t);
  }, [soft, fetchPage]);

  const ensure = useCallback(
    (pages: number[]) => {
      wanted.current = pages;
      for (const p of pages) if (!s.current.pages.has(p)) fetchPage(p);
    },
    [fetchPage],
  );

  const retry = useCallback(() => {
    s.current.error = null;
    s.current.gen++;
    for (const p of wanted.current.length ? wanted.current : [0]) fetchPage(p);
    force();
  }, [fetchPage]);

  const st = s.current;
  const rowAt = (i: number): LibraryTrack | undefined => st.pages.get(Math.floor(i / PAGE_SIZE))?.[i % PAGE_SIZE];
  return { total: st.total, error: st.error, rowAt, ensure, retry, pages: st.pages };
}

type ColId = 'name' | 'bpm' | 'key' | 'duration' | 'lufs' | 'status';

const COLS: Record<ColId, { label: string; width: string; sort?: SortKey; align?: 'right'; hint: string }> = {
  name: { label: 'Name', width: 'minmax(0,1fr)', sort: 'name', hint: 'File name (sort A–Z)' },
  bpm: { label: 'BPM', width: '52px', sort: 'bpm', align: 'right', hint: 'Detected tempo (estimated)' },
  key: { label: 'Key', width: '62px', sort: 'key', hint: 'Detected key (estimated)' },
  duration: { label: 'Length', width: '56px', sort: 'duration', align: 'right', hint: 'Track length' },
  lufs: { label: 'LUFS', width: '52px', sort: 'lufs', align: 'right', hint: 'Integrated loudness' },
  status: { label: 'Status', width: '84px', hint: 'Analysis status (filter it above)' },
};

function columnsFor(width: number): ColId[] {
  if (width >= 600) return ['name', 'bpm', 'key', 'duration', 'lufs', 'status'];
  if (width >= 470) return ['name', 'bpm', 'key', 'duration', 'status'];
  return ['name', 'bpm', 'key', 'status'];
}

function FilterBar({ total, narrow }: { total: number | null; narrow: boolean }) {
  const filters = useLibrary((s) => s.filters);
  const [text, setText] = useState(filters.text);
  useEffect(() => setText(filters.text), [filters.text]);
  useEffect(() => {
    if (text === filters.text) return;
    const t = setTimeout(() => setFilters({ text }), 220);
    return () => clearTimeout(t);
  }, [text, filters.text]);
  const keyOpts = useMemo(keyFilterOptions, []);
  const statusOpts = useMemo(statusFilterOptions, []);
  const active = filtersActive(filters) || text.trim() !== '';
  const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const select = 'h-7 cursor-pointer rounded-lg border border-white/10 bg-black/40 px-1.5 text-[11px] text-white/90 outline-none hover:border-white/20 focus:border-krypt-purple/60';
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 px-2.5 pb-2">
      <div className={cls('flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2 focus-within:border-krypt-purple/60', narrow ? 'min-w-[140px] flex-1' : 'w-[220px]')}>
        <Search className="h-3.5 w-3.5 flex-shrink-0 text-krypt-muted" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text) {
              e.stopPropagation();
              setText('');
            }
          }}
          placeholder="Search name, path, tags"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-white placeholder-krypt-muted/60 outline-none"
          aria-label="Search tracks"
        />
      </div>
      <div className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-black/40 px-1.5 text-[11px] focus-within:border-krypt-purple/60" data-hint="BPM range (either end can be blank)">
        <span className="text-krypt-muted">BPM</span>
        <input
          type="number"
          min={20}
          max={400}
          value={filters.bpmMin ?? ''}
          onChange={(e) => setFilters({ bpmMin: num(e.target.value) })}
          placeholder="min"
          className="w-11 bg-transparent text-center font-mono text-white placeholder-krypt-muted/50 outline-none"
          aria-label="Minimum BPM"
        />
        <span className="text-krypt-muted">–</span>
        <input
          type="number"
          min={20}
          max={400}
          value={filters.bpmMax ?? ''}
          onChange={(e) => setFilters({ bpmMax: num(e.target.value) })}
          placeholder="max"
          className="w-11 bg-transparent text-center font-mono text-white placeholder-krypt-muted/50 outline-none"
          aria-label="Maximum BPM"
        />
      </div>
      <select value={filters.key} onChange={(e) => setFilters({ key: e.target.value })} className={select} aria-label="Key filter">
        {keyOpts.map((o) => (
          <option key={o.value} value={o.value} className="bg-krypt-surface">
            {o.label}
          </option>
        ))}
      </select>
      <select value={filters.status} onChange={(e) => setFilters({ status: e.target.value as typeof filters.status })} className={select} aria-label="Status filter">
        {statusOpts.map((o) => (
          <option key={o.value} value={o.value} className="bg-krypt-surface">
            {o.label}
          </option>
        ))}
      </select>
      {active && (
        <button
          type="button"
          onClick={() => {
            setText('');
            clearFilters();
          }}
          className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11px] text-krypt-muted hover:bg-white/5 hover:text-white"
          data-hint="Clear every filter"
        >
          <FilterX className="h-3.5 w-3.5" /> Clear
        </button>
      )}
      <span className="ml-auto font-mono text-[10px] text-krypt-muted">{total === null ? '…' : `${fmtCount(total)} ${total === 1 ? 'track' : 'tracks'}`}</span>
    </div>
  );
}

export function TrackTable({ collection, width, doc }: { collection: Collection | null; width: number; doc: Document }) {
  const filters = useLibrary((s) => s.filters);
  const sort = useLibrary((s) => s.sort);
  const reload = useLibrary((s) => s.reload);
  const selection = useLibrary((s) => s.selection);
  const reveal = useLibrary((s) => s.reveal);
  const collections = useLibrary((s) => s.state?.collections);
  const signature = useLibrary((s) => {
    const cs = s.state?.collections ?? [];
    const list = collection ? cs.filter((c) => c.id === collection.id) : cs;
    return list.map((c) => `${c.id}:${c.counts.total}/${c.counts.pending}/${c.counts.light}/${c.counts.deep}/${c.counts.failed}/${c.counts.missing}`).join('|');
  });
  const collectionId = collection?.id ?? null;

  const base = useMemo(() => buildQuery(collectionId, filters, sort, 0, PAGE_SIZE), [collectionId, filters, sort]);
  const data = useTrackPages(base, `${reload}|${signature}`);
  const total = data.total;

  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const bindScroller = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setScrollEl(el);
  }, []);
  const [view, setView] = useState({ top: 0, height: 400 });
  const [dropHot, setDropHot] = useState(false);

  const key = queryKey(base);
  const resetScroll = useRef(false);
  useLayoutEffect(() => {
    resetScroll.current = true;
    if (scroller.current) {
      scroller.current.scrollTop = 0;
      resetScroll.current = false;
    }
    setView((v) => ({ ...v, top: 0 }));
  }, [key]);

  useLayoutEffect(() => {
    const el = scrollEl;
    if (!el) return;
    if (resetScroll.current) {
      el.scrollTop = 0;
      resetScroll.current = false;
    }
    const measure = (): void => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollEl]);

  const { first, last } = visibleRange(view.top, view.height, ROW_H, total ?? 0, 10);
  const pageList = pagesFor(first, Math.max(first + 1, last));
  const pagesKey = pageList.join(',');
  useEffect(() => {
    data.ensure(pagesKey ? pagesKey.split(',').map(Number) : [0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesKey, key]);

  useEffect(() => {
    if (!reveal || total === null) return;
    for (const [page, rows] of data.pages) {
      const i = rows.findIndex((t) => t.id === reveal);
      if (i >= 0) {
        const idx = page * PAGE_SIZE + i;
        const el = scroller.current;
        if (el) el.scrollTop = Math.max(0, idx * ROW_H - el.clientHeight / 2 + ROW_H);
        useLibrary.setState({ reveal: null });
        return;
      }
    }
    if (data.pages.has(0)) useLibrary.setState({ reveal: null });
  });

  const cols = columnsFor(width);
  const grid = cols.map((c) => COLS[c].width).join(' ');
  const selected = useMemo(() => new Set(selection), [selection]);
  const colName = useCallback((id: string) => collections?.find((c) => c.id === id)?.name ?? '', [collections]);

  const loadedOrder = (): Array<string | undefined> => {
    const out: Array<string | undefined> = [];
    if (total === null) return out;
    for (const [page, rows] of [...data.pages.entries()].sort((a, b) => a[0] - b[0])) rows.forEach((t, i) => (out[page * PAGE_SIZE + i] = t.id));
    return out;
  };
  const loadedTracks = (ids: string[]): LibraryTrack[] => {
    const want = new Set(ids);
    const out: LibraryTrack[] = [];
    for (const rows of data.pages.values()) for (const t of rows) if (want.has(t.id)) out.push(t);
    return out;
  };

  const onRowClick = (e: MouseEvent, t: LibraryTrack): void => {
    const st = useLibrary.getState();
    if (e.shiftKey) setSelection(rangeSelect(loadedOrder(), st.anchor, t.id), st.anchor ?? t.id);
    else if (e.ctrlKey || e.metaKey) setSelection(selected.has(t.id) ? st.selection.filter((x) => x !== t.id) : [...st.selection, t.id], t.id);
    else setSelection([t.id], t.id);
  };

  const onContext = (e: MouseEvent, t: LibraryTrack): void => {
    e.preventDefault();
    let ids = useLibrary.getState().selection;
    if (!ids.includes(t.id)) {
      ids = [t.id];
      setSelection(ids, t.id);
    }
    const many = ids.length > 1 ? loadedTracks(ids) : [t];
    const c = collections?.find((x) => x.id === t.collectionId) ?? null;
    const items: MenuItem[] = [];
    if (many.length > 1) items.push({ type: 'header', label: `${fmtCount(many.length)} tracks selected` });
    items.push(
      { label: 'Detect tempo & key', icon: AudioWaveform, hint: 'Tempo, key, swing, sections and loudness (double-click)', disabled: t.status === 'missing', detail: t.status === 'missing' ? 'The file is missing' : undefined, onSelect: () => analyseTrack(t, doc) },
      { label: 'Add to project', icon: ListPlus, hint: 'As an audio clip on a new Playlist track', disabled: t.status === 'missing', onSelect: () => void addTrackToProject(t) },
      {
        label: 'Find similar',
        icon: Radar,
        hint: 'Tracks that sound most like this one',
        disabled: t.status !== 'light' && t.status !== 'deep',
        detail: t.status !== 'light' && t.status !== 'deep' ? 'Needs the light pass first' : undefined,
        onSelect: () => findSimilar(t, doc),
      },
      { type: 'separator' },
      { label: 'Show in folder', icon: FolderOpen, onSelect: () => void showTrackInFolder(t) },
      { label: 'Copy path', icon: Copy, onSelect: () => void copyTrackPath(t) },
    );
    if (t.status === 'failed' && c) items.push({ label: `Retry failed tracks in ${c.name}`, icon: RotateCcw, onSelect: () => void retryFailed(c) });
    if (t.status === 'missing' && c) items.push({ label: `Rescan ${c.name}`, icon: RefreshCw, onSelect: () => void rescanCollection(c) });
    items.push(
      { type: 'separator' },
      {
        label: many.length > 1 ? `Remove ${fmtCount(many.length)} tracks from library…` : 'Remove from library…',
        icon: Trash2,
        danger: true,
        hint: 'Forgets the analysis; the files stay on disk',
        onSelect: () => void removeTracks(many),
      },
    );
    openMenu(e, items, { minWidth: 230 });
  };

  const onDragOver = (e: DragEvent): void => {
    if (!collection || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropHot(true);
  };
  const onDrop = (e: DragEvent): void => {
    setDropHot(false);
    if (!collection || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void dropOnCollection(collection, e.dataTransfer);
  };

  const narrow = width < 520;
  const rows: JSX.Element[] = [];
  for (let i = first; i < last; i++) {
    const t = data.rowAt(i);
    if (!t) {
      rows.push(
        <div key={`ph-${i}`} className="absolute inset-x-0 flex items-center px-2.5" style={{ top: i * ROW_H, height: ROW_H }}>
          <div className="h-2 w-1/3 rounded-full bg-white/[0.04]" />
        </div>,
      );
      continue;
    }
    const sel = selected.has(t.id);
    const muted = t.status === 'missing';
    rows.push(
      <div
        key={t.id}
        role="row"
        aria-selected={sel}
        onClick={(e) => onRowClick(e, t)}
        onDoubleClick={() => analyseTrack(t, doc)}
        onContextMenu={(e) => onContext(e, t)}
        className={cls(
          'absolute inset-x-0 grid cursor-default items-center gap-2 border-b border-white/[0.03] px-2.5 text-[11px]',
          sel ? 'bg-krypt-purple/[0.16] shadow-[inset_2px_0_0_#A855F7]' : i % 2 ? 'bg-white/[0.012] hover:bg-white/[0.04]' : 'hover:bg-white/[0.04]',
        )}
        style={{ top: i * ROW_H, height: ROW_H, gridTemplateColumns: grid }}
      >
        {cols.map((c) => {
          switch (c) {
            case 'name':
              return (
                <div key={c} className={cls('min-w-0 truncate', muted ? 'text-white/45 line-through decoration-white/20' : 'text-white/90')} title={t.path}>
                  {t.name}
                  {!collection && colName(t.collectionId) && <span className="ml-1.5 text-[10px] text-krypt-muted">{colName(t.collectionId)}</span>}
                </div>
              );
            case 'bpm':
              return (
                <div key={c} className="text-right font-mono text-white/85" title={t.bpmConfidence !== undefined ? `Confidence ${Math.round(t.bpmConfidence * 100)}%` : undefined}>
                  {fmtBpmCell(t.bpm)}
                </div>
              );
            case 'key':
              return (
                <div key={c} className="truncate font-mono text-white/85" title={t.keyConfidence !== undefined ? `Confidence ${Math.round(t.keyConfidence * 100)}%` : undefined}>
                  {fmtKeyShort(t.key)}
                </div>
              );
            case 'duration':
              return (
                <div key={c} className="text-right font-mono text-white/70">
                  {fmtTrackLength(t.durationSec)}
                </div>
              );
            case 'lufs':
              return (
                <div key={c} className="text-right font-mono text-white/70">
                  {fmtLufs(t.lufs)}
                </div>
              );
            case 'status':
              return (
                <div key={c} className="min-w-0 pl-1">
                  <StatusPill status={t.status} error={t.error} />
                </div>
              );
            default:
              return null;
          }
        })}
      </div>,
    );
  }

  const header = (
    <div
      className="grid flex-shrink-0 items-center gap-2 border-y border-white/[0.06] bg-black/30 px-2.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-krypt-muted"
      style={{ gridTemplateColumns: grid, height: 26, paddingRight: 18 }}
      role="row"
    >
      {cols.map((c) => {
        const def = COLS[c];
        const on = def.sort && sort.key === def.sort;
        const Arrow = sort.desc ? ArrowDown : ArrowUp;
        return def.sort ? (
          <button
            key={c}
            type="button"
            onClick={() => setSort(nextSort(sort, def.sort!))}
            data-hint={`${def.hint} · click to sort`}
            className={cls('flex min-w-0 items-center gap-0.5 uppercase tracking-[0.14em] hover:text-white', def.align === 'right' && 'justify-end', on && 'text-white')}
          >
            <span className="truncate">{def.label}</span>
            {on && <Arrow className="h-3 w-3 flex-shrink-0 text-krypt-purple" />}
          </button>
        ) : (
          <span key={c} className="truncate pl-1" data-hint={def.hint}>
            {def.label}
          </span>
        );
      })}
    </div>
  );

  let body: JSX.Element;
  if (data.error && total === null)
    body = (
      <div key="error" className="flex flex-1 items-center justify-center p-6">
        <EmptyNote icon={TriangleAlert} title="Couldn’t load the tracks" action={<SmallButton icon={RotateCcw} onClick={data.retry}>Try again</SmallButton>}>
          {data.error}
        </EmptyNote>
      </div>
    );
  else if (total === null)
    body = (
      <div key="loading" className="flex flex-1 items-center justify-center gap-2 text-[11px] text-krypt-muted">
        <Loader2 className="h-4 w-4 animate-spin text-krypt-purple" /> Loading tracks…
      </div>
    );
  else if (total === 0)
    body = (
      <div key="empty" className="flex flex-1 items-center justify-center p-6">
        {filtersActive(filters) ? (
          <EmptyNote icon={FilterX} title="No tracks match these filters" action={<SmallButton icon={FilterX} onClick={clearFilters}>Clear filters</SmallButton>} />
        ) : collection ? (
          <EmptyNote
            icon={FolderPlus}
            title={`${collection.name} is empty`}
            action={
              <div className="flex gap-1.5">
                <SmallButton icon={FolderPlus} tone="primary" onClick={() => void addFolder(collection)}>
                  Add folder…
                </SmallButton>
                <SmallButton onClick={() => void addFiles(collection)}>Add files…</SmallButton>
              </div>
            }
          >
            Add a folder of songs you own (subfolders included) or drop folders and audio files here. Krypt reads them in place: nothing is copied or uploaded.
          </EmptyNote>
        ) : (
          <EmptyNote icon={FolderPlus} title="No tracks yet">
            Create a collection and add a folder to it.
          </EmptyNote>
        )}
      </div>
    );
  else
    body = (
      <div key="rows" ref={bindScroller} className="relative min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} role="rowgroup">
        <div className="relative" style={{ height: total * ROW_H }}>
          {rows}
        </div>
      </div>
    );

  return (
    <div
      className={cls('relative flex min-h-0 flex-1 flex-col', dropHot && 'after:pointer-events-none after:absolute after:inset-1 after:rounded-xl after:border-2 after:border-dashed after:border-krypt-purple/70 after:bg-krypt-purple/[0.06]')}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHot(false);
      }}
      onDrop={onDrop}
      role="table"
      aria-label="Library tracks"
    >
      <FilterBar total={total} narrow={narrow} />
      {header}
      {body}
      {dropHot && collection && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
          <span className="rounded-full bg-black/80 px-3 py-1 text-[11px] font-semibold text-white">Drop to add to {collection.name}</span>
        </div>
      )}
      {selection.length > 1 && (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-white/[0.06] px-2.5 py-1 text-[10px] text-krypt-muted">
          {plural(selection.length, 'track')} selected · right-click for actions
          <button type="button" className="ml-auto hover:text-white" onClick={() => setSelection([], null)}>
            Clear selection
          </button>
        </div>
      )}
    </div>
  );
}
