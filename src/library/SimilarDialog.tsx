import { useEffect, useState, type ReactNode } from 'react';
import { AudioWaveform, Loader2, ListPlus, LocateFixed, Radar, RotateCcw } from 'lucide-react';
import type { LibraryTrack } from '@shared/library/types';
import { openDialog, Segmented } from '../components/Dialog';
import { cls } from '../utils/format';
import { fmtBpmCell, fmtKeyShort, fmtPct } from './logic';
import { useLibrary } from './store';
import { addTrackToProject, analyseTrack, revealTrack } from './actions';

export function openSimilarDialog(track: LibraryTrack, doc?: Document | null): void {
  openDialog({
    key: 'library-similar',
    title: 'Similar tracks',
    subtitle: `Sounds most like ${track.name}`,
    icon: Radar,
    doc,
    width: 560,
    render: (close) => <SimilarView track={track} close={close} doc={doc ?? document} />,
  });
}

type Scope = 'collection' | 'library';
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; items: Array<{ track: LibraryTrack; score: number }> };

function SimilarView({ track, close, doc }: { track: LibraryTrack; close: () => void; doc: Document }) {
  const [scope, setScope] = useState<Scope>('collection');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const collections = useLibrary((s) => s.state?.collections ?? []);
  const nameOf = (id: string): string => collections.find((c) => c.id === id)?.name ?? '';

  useEffect(() => {
    let alive = true;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const r = await window.krypt.library.similar(track.id, { collectionId: scope === 'collection' ? track.collectionId : undefined, limit: 20 });
        if (!alive) return;
        if (r.ok && r.data) setLoad({ status: 'done', items: r.data.filter((x) => x.track.id !== track.id) });
        else setLoad({ status: 'error', message: r.message || "Couldn't compare the tracks" });
      } catch (err) {
        if (alive) setLoad({ status: 'error', message: (err as Error)?.message ?? String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [track.id, track.collectionId, scope, nonce]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-4 pt-3">
        <Segmented<Scope>
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'collection', label: nameOf(track.collectionId) || 'This collection' },
            { value: 'library', label: 'Whole library' },
          ]}
        />
        <span className="ml-auto text-[10px] text-krypt-muted">Tempo, key, drums, loudness and width compared</span>
      </div>
      <div className="min-h-[160px] px-2 py-2">
        {load.status === 'loading' && (
          <div className="flex h-[150px] items-center justify-center gap-2 text-[11px] text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin text-krypt-purple" /> Comparing…
          </div>
        )}
        {load.status === 'error' && (
          <div className="flex h-[150px] flex-col items-center justify-center gap-2 text-center text-[11px] text-rose-200">
            {load.message}
            <button type="button" onClick={() => setNonce((n) => n + 1)} className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-white/80 hover:bg-white/10">
              <RotateCcw className="h-3 w-3" /> Try again
            </button>
          </div>
        )}
        {load.status === 'done' && !load.items.length && (
          <div className="flex h-[150px] items-center justify-center px-6 text-center text-[11px] text-krypt-muted">
            Nothing to compare yet: no other analysed tracks {scope === 'collection' ? 'in this collection' : 'in the library'}.
          </div>
        )}
        {load.status === 'done' && load.items.length > 0 && (
          <div className="max-h-[52vh] overflow-y-auto">
            {load.items.map(({ track: t, score }) => (
              <div key={t.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]" onDoubleClick={() => analyseTrack(t, doc)}>
                <div className="w-[92px] flex-shrink-0" data-hint={`${fmtPct(score)} similar`}>
                  <div className="font-mono text-[11px] font-semibold text-white">{fmtPct(score)}</div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-krypt-purple" style={{ width: `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%` }} />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-white/90" title={t.path}>
                    {t.name}
                  </div>
                  <div className="truncate font-mono text-[10px] text-krypt-muted">
                    {fmtBpmCell(t.bpm)} BPM · {fmtKeyShort(t.key)}
                    {scope === 'library' && nameOf(t.collectionId) ? ` · ${nameOf(t.collectionId)}` : ''}
                  </div>
                </div>
                <div className={cls('flex flex-shrink-0 gap-0.5 opacity-60 transition group-hover:opacity-100')}>
                  <RowButton hint="Detect tempo & key (full analysis)" onClick={() => analyseTrack(t, doc)}>
                    <AudioWaveform className="h-3.5 w-3.5" />
                  </RowButton>
                  <RowButton hint="Add to project as an audio clip" onClick={() => void addTrackToProject(t)}>
                    <ListPlus className="h-3.5 w-3.5" />
                  </RowButton>
                  <RowButton
                    hint="Show in the Library"
                    onClick={() => {
                      close();
                      void revealTrack(t.id, t.name);
                    }}
                  >
                    <LocateFixed className="h-3.5 w-3.5" />
                  </RowButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2.5 text-[10px] text-krypt-muted">
        <span>Similar in sound and feel, not a copy check. For that, use Check originality.</span>
        <button type="button" onClick={close} className="h-7 rounded-lg border border-white/10 bg-white/5 px-3 text-[11px] font-semibold text-white/85 hover:bg-white/10">
          Close
        </button>
      </div>
    </div>
  );
}

function RowButton({ hint, onClick, children }: { hint: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hint}
      data-hint={hint}
      title={hint}
      className="flex h-6 w-6 items-center justify-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
