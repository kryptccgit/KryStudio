// Library panel header: the shown collection (name, tags, counts, actions,
// the deep-analysis switch), the global analysis queue (progress, current
// file, ETA, pause / resume), notices that need the user (failures, missing
// files, deep analysis without a stem model, the fast-scan tip, a missing
// analyzer), and the Tracks / Style profile tabs.

import { useRef, type ReactNode } from 'react';
import {
  BarChart3,
  ChevronDown,
  Crosshair,
  Ellipsis,
  FilePlus,
  FolderPlus,
  Info,
  LibraryBig,
  ListMusic,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  TriangleAlert,
  BrainCircuit,
} from 'lucide-react';
import type { Collection } from '@shared/library/types';
import { openMenuAt, type MenuItem } from '../../components/Menu';
import { cls } from '../../utils/format';
import { ProgressBar } from '../../ears/ProgressBar';
import { installedStemModels } from '../../ears/logic';
import { useAnalyzer, analyzerMissingMessage } from '../modelManager/store';
import {
  baseName,
  collectionStatusLine,
  fmtCount,
  fmtEta,
  libraryTotals,
  plural,
  queueActive,
  queueFraction,
  queueHeadline,
} from '../../library/logic';
import { setFilters, setView, useLibrary } from '../../library/store';
import { addFiles, addFolder, chooseFocus, createCollection, openModelManager, rescanCollection, retryFailed, setDeep, setQueuePaused } from '../../library/actions';
import { MiniSwitch, SmallButton } from './ui';
import { collectionMenu, collectionPickerMenu } from './menus';

export function CollectionHeader({ collection, width, doc, sidebar }: { collection: Collection | null; width: number; doc: Document; sidebar: boolean }) {
  const s = useLibrary((x) => x.state);
  const busy = useLibrary((x) => (collection ? x.busy[collection.id] : undefined));
  const pickerRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Without the sidebar the title doubles as the collection picker.
  const narrow = !sidebar;
  const compact = width < 700;
  const tight = width < 520;
  if (!s) return null;
  const isFocus = !!collection && s.focus?.collectionId === collection.id;
  const totals = libraryTotals(s.collections);

  const title = collection ? collection.name : 'All tracks';
  const sub = collection ? collectionStatusLine(collection) : `${plural(totals.total, 'track')} in ${plural(s.collections.length, 'collection')}`;

  const moreAll = (): MenuItem[] => [
    { label: 'New collection…', icon: Plus, onSelect: () => void createCollection(doc) },
    { label: totals.failed ? `Retry ${plural(totals.failed, 'failed track')}` : 'No failed tracks', icon: RotateCcw, disabled: !totals.failed, onSelect: () => void retryFailed(null) },
  ];

  return (
    <div className="flex-shrink-0 px-2.5 pt-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {narrow ? (
            <button
              ref={pickerRef}
              type="button"
              onClick={() => pickerRef.current && openMenuAt(pickerRef.current, collectionPickerMenu(doc), { minWidth: 240 })}
              className="flex max-w-full items-center gap-1 rounded-md text-[14px] font-semibold text-white hover:text-purple-100"
              data-hint="Switch collection"
            >
              {!collection && <LibraryBig className="h-4 w-4 flex-shrink-0 text-krypt-purple" />}
              <span className="truncate">{title}</span>
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-krypt-muted" />
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-[14px] font-semibold text-white">{title}</h2>
              {isFocus && (
                <span className="flex flex-shrink-0 items-center gap-1 rounded-full border border-krypt-purple/40 bg-krypt-purple/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-purple-100">
                  <Crosshair className="h-2.5 w-2.5" /> AI focus
                </span>
              )}
              {collection?.tags.map((t) => (
                <span key={t} className="hidden flex-shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] text-white/70 md:inline">
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="mt-0.5 truncate text-[10px] text-krypt-muted">{sub}</div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {collection ? (
            <>
              <SmallButton icon={FolderPlus} compact={compact} disabled={!!busy} onClick={() => void addFolder(collection)} hint="Add a folder (subfolders included) and queue it for analysis">
                Add folder…
              </SmallButton>
              <SmallButton icon={FilePlus} compact onClick={() => void addFiles(collection)} hint="Add audio files">
                Add files…
              </SmallButton>
              <SmallButton icon={Crosshair} compact={compact} tone={isFocus ? 'focus' : 'ghost'} onClick={() => chooseFocus(collection, doc)} hint={isFocus ? 'This is the AI focus: edit the brief or clear it' : 'Agents compose from this collection’s style profile'}>
                {isFocus ? 'AI focus' : 'Use as AI focus'}
              </SmallButton>
              {!tight && (
                <MiniSwitch
                  on={collection.deep}
                  busy={busy === 'Deep' || busy === 'Estimating'}
                  onChange={(on) => void setDeep(collection, on, doc)}
                  label="Deep"
                  hint={
                    collection.deep
                      ? 'Deep analysis is on: stems + transcribed bass and melody lines (click to turn off)'
                      : 'Deep analysis: separate stems and transcribe bass / melody lines. Unlocks bass statistics and the originality check. Needs a stem model.'
                  }
                />
              )}
            </>
          ) : (
            <SmallButton icon={Plus} compact={compact} onClick={() => void createCollection(doc)} hint="New collection">
              New collection…
            </SmallButton>
          )}
          <SmallButton
            ref={moreRef}
            icon={Ellipsis}
            compact
            onClick={() => {
              if (!moreRef.current) return;
              const items = collection
                ? [
                    ...(tight
                      ? ([
                          {
                            label: collection.deep ? 'Turn deep analysis off' : 'Turn deep analysis on…',
                            icon: BrainCircuit,
                            onSelect: () => void setDeep(collection, !collection.deep, doc),
                          },
                          { type: 'separator' },
                        ] as MenuItem[])
                      : []),
                    ...collectionMenu(collection, doc),
                  ]
                : moreAll();
              openMenuAt(moreRef.current, items, { minWidth: 230, align: 'right' });
            }}
            hint="More actions"
          >
            More
          </SmallButton>
        </div>
      </div>
      <QueueStrip />
      <Notices collection={collection} totals={totals} />
      <Tabs collection={collection} hints={width >= 560} />
    </div>
  );
}

function QueueStrip() {
  const q = useLibrary((x) => x.state?.queue ?? null);
  if (!q || !queueActive(q)) return null;
  const eta = q.paused ? '' : fmtEta(q.etaSec);
  return (
    <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        {q.paused ? <Pause className="h-3.5 w-3.5 flex-shrink-0 text-amber-300" /> : <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-krypt-purple" />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="flex-shrink-0 text-[11px] font-semibold text-white">{queueHeadline(q)}</span>
            {q.current && !q.paused && (
              <span className="min-w-0 truncate font-mono text-[10px] text-krypt-muted" title={q.current}>
                {baseName(q.current)}
              </span>
            )}
          </div>
        </div>
        {eta && <span className="hidden flex-shrink-0 text-[10px] text-krypt-muted sm:inline">{eta}</span>}
        <button
          type="button"
          onClick={() => void setQueuePaused(!q.paused)}
          className="flex h-6 flex-shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/90 hover:border-white/20 hover:bg-white/10"
          data-hint={q.paused ? 'Resume analysing' : 'Pause the analysis queue (stays paused across restarts)'}
        >
          {q.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {q.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <ProgressBar fraction={queueFraction(q)} className="mt-1.5 h-1" />
    </div>
  );
}

/** A compact notice pill: short text + actions; the full explanation is its hint / tooltip. */
function Notice({ tone, icon: Icon, text, hint, actions }: { tone: 'danger' | 'warn' | 'info'; icon: typeof Info; text: ReactNode; hint: string; actions?: ReactNode }) {
  return (
    <div
      title={hint}
      data-hint={hint}
      className={cls(
        'flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-2.5 text-[10px] leading-snug',
        tone === 'danger' ? 'border-rose-400/25 bg-rose-500/[0.08] text-rose-100' : tone === 'warn' ? 'border-amber-400/25 bg-amber-500/[0.08] text-amber-50' : 'border-white/[0.08] bg-white/[0.03] text-white/80',
      )}
    >
      <Icon className={cls('h-3 w-3 flex-shrink-0', tone === 'danger' ? 'text-rose-300' : tone === 'warn' ? 'text-amber-300' : 'text-krypt-purple')} />
      <span className="min-w-0 truncate">{text}</span>
      {actions && <span className="flex flex-shrink-0 items-center gap-1.5 border-l border-white/10 pl-1.5">{actions}</span>}
    </div>
  );
}

function LinkButton({ onClick, children, hint }: { onClick: () => void; children: ReactNode; hint?: string }) {
  return (
    <button type="button" onClick={onClick} data-hint={hint} className="text-[10px] font-semibold text-white underline-offset-2 hover:underline">
      {children}
    </button>
  );
}

function Notices({ collection, totals }: { collection: Collection | null; totals: Collection['counts'] }) {
  const analyzer = useAnalyzer((x) => x.state);
  const q = useLibrary((x) => x.state?.queue ?? null);
  const counts = collection ? collection.counts : totals;
  const stemModels = installedStemModels(analyzer);
  const pills: ReactNode[] = [];
  const analyzerMissing = !!analyzer && !analyzer.available;
  if (counts.failed)
    pills.push(
      <Notice
        key="failed"
        tone="danger"
        icon={TriangleAlert}
        text={`${fmtCount(counts.failed)} failed`}
        hint={`${plural(counts.failed, 'track')} couldn’t be analysed (unreadable or unsupported files). Hover a row’s status for the reason.`}
        actions={
          <>
            <LinkButton onClick={() => setFilters({ status: 'failed' })} hint="Filter the table to the failed tracks">
              Show
            </LinkButton>
            <LinkButton onClick={() => void retryFailed(collection)} hint="Queue the failed tracks again">
              Retry
            </LinkButton>
          </>
        }
      />,
    );
  if (counts.missing)
    pills.push(
      <Notice
        key="missing"
        tone="warn"
        icon={TriangleAlert}
        text={`${fmtCount(counts.missing)} missing on disk`}
        hint={`${plural(counts.missing, 'file')} ${counts.missing === 1 ? 'is' : 'are'} missing or changed on disk since analysis. They are re-queued when they’re back (Rescan).`}
        actions={
          <>
            <LinkButton onClick={() => setFilters({ status: 'missing' })} hint="Filter the table to the missing files">
              Show
            </LinkButton>
            {collection && collection.folders.length > 0 && (
              <LinkButton onClick={() => void rescanCollection(collection)} hint="Rescan this collection's folders">
                Rescan
              </LinkButton>
            )}
          </>
        }
      />,
    );
  if (collection?.deep && analyzer && !stemModels.length)
    pills.push(
      <Notice
        key="nomodel"
        tone="warn"
        icon={BrainCircuit}
        text="Deep analysis needs a stem model"
        hint="Deep analysis is on, but no stem-separation model is installed, so tracks only get the light pass for now. Install one in the Model Manager (HT-Demucs is the usual pick)."
        actions={<LinkButton onClick={openModelManager}>Model Manager</LinkButton>}
      />,
    );
  if (collection?.deep && collection.counts.pending > 200 && q?.running && !q.paused)
    pills.push(
      <Notice
        key="fast"
        tone="info"
        icon={Info}
        text={`Deep pass on ${fmtCount(collection.counts.pending)} queued tracks is slow`}
        hint="For a fast scan, turn deep analysis off: tempo, key, drums and chords finish first for every track. Turn deep on again later for bass and melody."
        actions={
          <LinkButton onClick={() => void setDeep(collection, false)} hint="Turn deep analysis off for now (fast scan)">
            Fast scan
          </LinkButton>
        }
      />,
    );
  if (!analyzerMissing && !pills.length) return null;
  return (
    <>
      {analyzerMissing && (
        <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[11px] leading-snug text-amber-50">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />
          <span>{analyzerMissingMessage()} The library can’t analyse tracks until it’s back.</span>
        </div>
      )}
      {pills.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{pills}</div>}
    </>
  );
}

function Tabs({ collection, hints }: { collection: Collection | null; hints: boolean }) {
  const view = useLibrary((x) => x.view);
  const tabs = [
    { id: 'tracks' as const, label: 'Tracks', icon: ListMusic, disabled: false },
    { id: 'profile' as const, label: 'Style profile', icon: BarChart3, disabled: !collection },
  ];
  return (
    <div className="mt-2 flex gap-0.5 border-b border-white/[0.06]">
      {tabs.map((t) => {
        const Icon = t.icon;
        const on = (collection ? view : 'tracks') === t.id;
        return (
          <button
            key={t.id}
            type="button"
            disabled={t.disabled}
            onClick={() => setView(t.id)}
            data-hint={t.disabled ? 'Pick a collection to see its style profile' : undefined}
            className={cls(
              'relative flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
              on ? 'text-white' : 'text-krypt-muted hover:text-white',
            )}
          >
            <Icon className={cls('h-3 w-3', on && 'text-krypt-purple')} />
            {t.label}
            {on && <span className="absolute inset-x-1 bottom-0 h-[2px] rounded-t bg-krypt-gradient" />}
          </button>
        );
      })}
      {hints && view === 'profile' && collection && <span className="ml-auto self-center pb-1 text-[10px] text-krypt-muted">What the AI leans on</span>}
      {hints && (view === 'tracks' || !collection) && (
        <span className="ml-auto self-center pb-1 text-[10px] text-krypt-muted/80">
          Double-click a track for tempo & key
        </span>
      )}
    </div>
  );
}
