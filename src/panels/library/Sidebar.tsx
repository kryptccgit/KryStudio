import { useState, type DragEvent } from 'react';
import { Crosshair, FolderPlus, HardDrive, Layers, LibraryBig, Loader2, Plus } from 'lucide-react';
import type { Collection } from '@shared/library/types';
import { openMenu } from '../../components/Menu';
import { hasFiles } from '../../app/fileDrop';
import { cls } from '../../utils/format';
import { analysedCount, collectionProgress, collectionStatusLine, fmtCount, fmtPct, libraryTotals } from '../../library/logic';
import { selectCollection, useLibrary } from '../../library/store';
import { createCollection, dropAsNewCollection, dropOnCollection } from '../../library/actions';
import { collectionMenu } from './menus';

function useDropTarget(onDrop: (dt: DataTransfer) => void) {
  const [hot, setHot] = useState(false);
  return {
    hot,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setHot(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHot(false);
      },
      onDrop: (e: DragEvent) => {
        setHot(false);
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(e.dataTransfer);
      },
    },
  };
}

function CollectionRow({ c, active, focused, busy, doc }: { c: Collection; active: boolean; focused: boolean; busy?: string; doc: Document }) {
  const drop = useDropTarget((dt) => void dropOnCollection(c, dt));
  const progress = collectionProgress(c);
  const done = analysedCount(c);
  const complete = c.counts.total > 0 && done + c.counts.failed + c.counts.missing >= c.counts.total;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectCollection(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') selectCollection(c.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        selectCollection(c.id);
        openMenu(e, collectionMenu(c, doc), { minWidth: 220 });
      }}
      {...drop.handlers}
      data-hint={`${collectionStatusLine(c)}${c.tags.length ? ` · tags: ${c.tags.join(', ')}` : ''} · right-click for actions, drop folders to add`}
      className={cls(
        'relative cursor-pointer rounded-lg px-2 py-1.5 outline-none transition',
        active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
        drop.hot && 'bg-krypt-purple/15 ring-1 ring-krypt-purple/70',
      )}
    >
      {active && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-krypt-gradient" />}
      <div className="flex items-center gap-1.5">
        <span className={cls('min-w-0 flex-1 truncate text-[12px]', active ? 'font-semibold text-white' : 'text-white/85')}>{c.name}</span>
        {focused && <Crosshair className="h-3 w-3 flex-shrink-0 text-krypt-purple" aria-label="AI focus" />}
        {c.deep && <Layers className="h-3 w-3 flex-shrink-0 text-krypt-muted" aria-label="Deep analysis on" />}
        {busy && <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-krypt-muted" />}
        <span className="flex-shrink-0 font-mono text-[10px] text-krypt-muted">{fmtCount(c.counts.total)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        {c.counts.total > 0 && !complete ? (
          <>
            <span className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full bg-krypt-gradient" style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
            <span className="flex-shrink-0 font-mono text-[9px] text-krypt-muted">{fmtPct(progress)}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10px] text-krypt-muted">{c.counts.total ? (c.counts.deep ? `${fmtCount(c.counts.deep)} deep` : 'Analysed') : 'Empty'}</span>
        )}
        {c.counts.failed > 0 && (
          <span className="flex-shrink-0 rounded-full bg-rose-500/15 px-1.5 font-mono text-[9px] text-rose-200" title={`${c.counts.failed} failed`}>
            {fmtCount(c.counts.failed)} failed
          </span>
        )}
        {c.counts.missing > 0 && (
          <span className="flex-shrink-0 rounded-full bg-amber-500/15 px-1.5 font-mono text-[9px] text-amber-200" title={`${c.counts.missing} missing`}>
            {fmtCount(c.counts.missing)} missing
          </span>
        )}
      </div>
    </div>
  );
}

export function Sidebar({ doc }: { doc: Document }) {
  const s = useLibrary((x) => x.state);
  const selected = useLibrary((x) => x.selected);
  const busy = useLibrary((x) => x.busy);
  const drop = useDropTarget((dt) => void dropAsNewCollection(dt));
  if (!s) return null;
  const totals = libraryTotals(s.collections);
  return (
    <aside className="flex w-[214px] flex-shrink-0 flex-col border-r border-white/[0.06] bg-black/20">
      <div className="flex items-center gap-1 px-2.5 pb-1.5 pt-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Collections</span>
        <button
          type="button"
          onClick={() => void createCollection(doc)}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-krypt-muted transition hover:bg-white/10 hover:text-white"
          aria-label="New collection"
          data-hint="New collection"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
        <div
          role="button"
          tabIndex={0}
          onClick={() => selectCollection(null, 'tracks')}
          onKeyDown={(e) => e.key === 'Enter' && selectCollection(null, 'tracks')}
          className={cls('relative flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition', selected === null ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]')}
          data-hint="Every track in every collection"
        >
          {selected === null && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-krypt-gradient" />}
          <LibraryBig className="h-3.5 w-3.5 text-krypt-purple" />
          <span className={cls('flex-1 text-[12px]', selected === null ? 'font-semibold text-white' : 'text-white/85')}>All tracks</span>
          <span className="font-mono text-[10px] text-krypt-muted">{fmtCount(totals.total)}</span>
        </div>
        <div className="mx-2 my-1 h-px bg-white/[0.06]" />
        {s.collections.map((c) => (
          <CollectionRow key={c.id} c={c} active={selected === c.id} focused={s.focus?.collectionId === c.id} busy={busy[c.id]} doc={doc} />
        ))}
        <button
          type="button"
          onClick={() => void createCollection(doc, { thenAddFolder: true })}
          {...drop.handlers}
          className={cls(
            'mt-1.5 flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-2 py-3 text-center transition',
            drop.hot ? 'border-krypt-purple/70 bg-krypt-purple/10' : 'border-white/10 hover:border-white/20 hover:bg-white/[0.03]',
          )}
          data-hint="Click to name a new collection and pick a folder, or drop folders here (the collection takes the first folder's name)"
        >
          <FolderPlus className="h-4 w-4 text-krypt-muted" />
          <span className="text-[10px] leading-snug text-krypt-muted">{drop.hot ? 'Drop to make a collection' : 'New collection from a folder (click or drop)'}</span>
        </button>
      </div>
      <div className="flex items-center gap-1.5 border-t border-white/[0.06] px-2.5 py-1.5 text-[9px] text-krypt-muted/80" title={s.dbPath} data-hint={`Library database: ${s.dbPath}`}>
        <HardDrive className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">Analysis stays on this PC. Files are never moved.</span>
      </div>
    </aside>
  );
}
