import { useEffect, useState, type ReactNode } from 'react';
import { CircleCheck, Layers, Loader2, LocateFixed, Piano, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { OriginalityReport } from '@shared/library/types';
import { openDialog } from '../components/Dialog';
import { getProject } from '../doc/store';
import { cls } from '../utils/format';
import { fmtCount, fmtPct, fmtRefTime, plural } from './logic';
import { openLibrary, openPatternFromMatch, revealTrack } from './actions';

export const DISCLAIMER =
  'A production aid, not legal advice. Matching depends on transcription, so it can miss things, and a clean result never certifies a song as original.';

export function openOriginalityDialog(opts: { patternId?: string; doc?: Document | null } = {}): void {
  const pat = opts.patternId ? getProject().patterns[opts.patternId] : null;
  openDialog({
    key: 'library-originality',
    title: 'Originality check',
    subtitle: pat ? `Pattern “${pat.name}” against your deep-analysed references` : 'Every melodic line in the project against your deep-analysed references',
    icon: ShieldCheck,
    doc: opts.doc,
    width: 640,
    render: (close) => <ReportView patternId={opts.patternId} close={close} />,
  });
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; report: OriginalityReport };

function ReportView({ patternId, close }: { patternId?: string; close: () => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const r = await window.krypt.library.checkOriginality(patternId ? { patternId } : undefined);
        if (!alive) return;
        if (r.ok && r.data) setLoad({ status: 'done', report: r.data });
        else setLoad({ status: 'error', message: r.message || "Couldn't run the originality check" });
      } catch (err) {
        if (alive) setLoad({ status: 'error', message: (err as Error)?.message ?? String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [patternId, nonce]);

  return (
    <div className="flex flex-col">
      <div className="min-h-[180px] px-4 py-3">
        {load.status === 'loading' && (
          <div className="flex h-[170px] flex-col items-center justify-center gap-2 text-[11px] text-krypt-muted">
            <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
            Comparing melodies with the transcribed references…
          </div>
        )}
        {load.status === 'error' && (
          <div className="flex h-[170px] flex-col items-center justify-center gap-2 text-center text-[12px] text-rose-200">
            <TriangleAlert className="h-5 w-5 text-rose-300" />
            {load.message}
          </div>
        )}
        {load.status === 'done' && <Report report={load.report} close={close} />}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
        <span className="min-w-0 flex-1 text-[10px] leading-snug text-krypt-muted">{DISCLAIMER}</span>
        <button
          type="button"
          disabled={load.status === 'loading'}
          onClick={() => setNonce((n) => n + 1)}
          className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 text-[11px] font-semibold text-white/85 hover:bg-white/10 disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" /> Check again
        </button>
        <button type="button" onClick={close} className="h-7 flex-shrink-0 rounded-lg bg-krypt-gradient px-3.5 text-[11px] font-semibold text-white shadow-krypt-glow hover:brightness-110">
          Done
        </button>
      </div>
    </div>
  );
}

function Report({ report: r, close }: { report: OriginalityReport; close: () => void }) {
  if (r.references === 0)
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-6 text-center">
        <Layers className="h-6 w-6 text-krypt-purple" />
        <div className="text-[13px] font-semibold text-white">Run deep analysis on a collection to enable this</div>
        <div className="max-w-md text-[11px] leading-snug text-krypt-muted">
          The check compares your melodies with lines transcribed from your reference songs. Only deep-analysed tracks have those lines, and none do yet. Turn on
          Deep analysis for a collection in the Library (it needs a stem model).
        </div>
        <button
          type="button"
          onClick={() => {
            close();
            openLibrary();
          }}
          className="mt-1 h-7 rounded-lg border border-white/10 bg-white/5 px-3 text-[11px] font-semibold text-white/90 hover:bg-white/10"
        >
          Open Library
        </button>
      </div>
    );

  const clean = r.matches.length === 0;
  return (
    <div className="space-y-3">
      <div
        className={cls(
          'flex gap-2.5 rounded-xl border px-3 py-2.5',
          clean ? 'border-emerald-400/25 bg-emerald-500/[0.06]' : 'border-amber-400/30 bg-amber-500/[0.07]',
        )}
      >
        {clean ? <CircleCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" /> : <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />}
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-white">
            {clean ? 'No close matches' : `${plural(r.matches.length, 'close match', 'close matches')} found`}
          </div>
          <div className="mt-0.5 text-[10px] text-krypt-muted">
            {plural(r.checkedLines, 'line')} checked against {plural(r.references, 'deep-analysed reference')}
          </div>
          {r.summary && <div className="mt-1.5 whitespace-pre-line text-[11px] leading-snug text-white/80">{r.summary}</div>}
        </div>
      </div>

      {r.checkedLines === 0 && (
        <div className="text-center text-[11px] text-krypt-muted">No melodic lines to check: add notes to a pitched channel first.</div>
      )}

      {!clean && (
        <div className="overflow-hidden rounded-xl border border-white/[0.07]">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_54px_64px_auto] gap-2 border-b border-white/[0.06] bg-black/30 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">
            <span>Your line</span>
            <span>Reference</span>
            <span className="text-right">Notes</span>
            <span className="text-right">Similar</span>
            <span />
          </div>
          <div className="max-h-[44vh] divide-y divide-white/[0.05] overflow-y-auto">
            {r.matches.map((m, i) => (
              <div key={`${m.patternId}-${m.trackId}-${m.atBar}-${i}`} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_54px_64px_auto] items-center gap-2 px-2.5 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-[11px] text-white/90" title={m.line}>
                    {m.line}
                  </div>
                  <div className="font-mono text-[10px] text-krypt-muted">bar {fmtCount(m.atBar)}</div>
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[11px] text-white/90" title={m.trackName}>
                    {m.trackName}
                  </div>
                  <div className="truncate font-mono text-[10px] text-krypt-muted">
                    {m.stem} · at {fmtRefTime(m.refAtSec)}
                  </div>
                </div>
                <div className="text-right font-mono text-[12px] font-semibold text-white">{m.notes}</div>
                <div className="text-right" data-hint="Rhythm and pitch agreement over the matched notes">
                  <div className={cls('font-mono text-[12px] font-semibold', m.similarity >= 0.9 ? 'text-rose-200' : m.similarity >= 0.75 ? 'text-amber-200' : 'text-white')}>
                    {fmtPct(m.similarity)}
                  </div>
                  <div className="ml-auto mt-0.5 h-1 w-12 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-krypt-purple" style={{ width: `${Math.round(Math.max(0, Math.min(1, m.similarity)) * 100)}%` }} />
                  </div>
                </div>
                <div className="flex flex-col items-stretch gap-0.5">
                  <SmallAction
                    hint="Make the pattern active and open it in the Piano Roll"
                    onClick={() => {
                      close();
                      void openPatternFromMatch(m.patternId, m.channelId);
                    }}
                  >
                    <Piano className="h-3 w-3" /> Open pattern
                  </SmallAction>
                  <SmallAction
                    hint="Show the reference track in the Library"
                    onClick={() => {
                      close();
                      void revealTrack(m.trackId, m.trackName);
                    }}
                  >
                    <LocateFixed className="h-3 w-3" /> Show reference
                  </SmallAction>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {!clean && (
        <div className="text-[10px] leading-snug text-krypt-muted">
          A match is a run of notes with the same intervals and rhythm (in any key). Change a few pitches or the rhythm of the flagged bars, then check again.
          Drums and chord progressions are genre conventions and are never flagged.
        </div>
      )}
    </div>
  );
}

function SmallAction({ hint, onClick, children }: { hint: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      data-hint={hint}
      className="flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[10px] font-semibold text-white/75 transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
