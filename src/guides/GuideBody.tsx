import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Clapperboard, CornerDownRight, Lightbulb, Loader2, MousePointerClick, Play, TriangleAlert } from 'lucide-react';
import { VIDEO_CREDIT, fmtVideoDuration, videoUrls, type GuideVideo, type ReadyGuideVideo } from '@shared/guides/videos';
import { CATALOG, isExternalPluginId } from '@shared/plugins/catalog';
import { getAppCommand } from '../input/commands';
import { getKeymap } from '../input/keymap';
import { TOOLS } from '../editors/tools';
import { useSettings } from '../state/status';
import { toast } from '../app/notify';
import { cls } from '../utils/format';
import { runHomeAction } from '../home/actions';
import { isHomeActionId } from '../home/logic';
import { FOCUS_RING, HomeButton, Kbd } from '../home/ui';
import { useEnsureSounds, useSounds } from '../sounds/store';
import { useEnsurePacks, usePacks } from '../sounds/packs';
import { PLUGIN_NOTES, articleById, type GuideArticle } from './articles';
import { type GuideBlock, type Inline } from './markup';
import { buildShortcutSections } from './shortcuts';
import { blocksOf, orderedArticles, relatedArticles, type SearchHit } from './search';
import { showGuideAnchor } from './show';
import { iconOf } from './icons';
import { VideoPlayer } from './VideoPlayer';
import { GuideImage } from './GuideImage';
import { videoBlockView, videoIndex } from './videos';
import type { GuidesVariant } from './store';

export interface GuideNav {
  variant: GuidesVariant;
  open(id: string, heading?: string): void;
}

const NavContext = createContext<GuideNav>({ variant: 'page', open: () => undefined });

export function GuideNavProvider({ nav, children }: { nav: GuideNav; children: ReactNode }) {
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

function runLink(id: string): void {
  if (isHomeActionId(id)) runHomeAction(id);
  else toast.error(`This guide links to something that doesn't exist ("${id}")`);
}

function openArticle(nav: GuideNav, id: string, heading?: string): void {
  if (articleById(id)) nav.open(id, heading);
  else toast.error(`This guide links to an article that doesn't exist ("${id}")`);
}

const LINK = 'rounded font-semibold underline underline-offset-2 hover:text-white';

function Runs({ runs }: { runs: Inline[] }) {
  const nav = useContext(NavContext);
  return (
    <>
      {runs.map((r, i) => {
        switch (r.t) {
          case 'b':
            return (
              <strong key={i} className="font-semibold text-white">
                {r.v}
              </strong>
            );
          case 'code':
            return (
              <code key={i} className="rounded bg-black/45 px-1 py-px font-mono text-[0.88em] text-white/90">
                {r.v}
              </code>
            );
          case 'kbd':
            return <Kbd key={i}>{r.v}</Kbd>;
          case 'action':
            return (
              <button key={i} type="button" onClick={() => runLink(r.id)} className={cls(LINK, 'text-purple-300 decoration-purple-400/40', FOCUS_RING)}>
                {r.label}
              </button>
            );
          case 'show':
            return (
              <button
                key={i}
                type="button"
                onClick={() => void showGuideAnchor(r.anchor)}
                title="Show me where this is"
                className={cls(LINK, 'inline-flex items-baseline gap-1 text-pink-200 decoration-pink-400/40', FOCUS_RING)}
              >
                <MousePointerClick className="h-3 w-3 flex-shrink-0 self-center" aria-hidden="true" />
                {r.label}
              </button>
            );
          case 'guide': {
            const target = articleById(r.id);
            return (
              <button
                key={i}
                type="button"
                onClick={() => openArticle(nav, r.id, r.heading)}
                title={target ? `Guide: ${target.title}` : undefined}
                className={cls(LINK, target ? 'text-indigo-300 decoration-indigo-400/40' : 'text-rose-300 decoration-rose-400/40', FOCUS_RING)}
              >
                {r.label || target?.title || r.id}
              </button>
            );
          }
          default:
            return <Fragment key={i}>{r.v}</Fragment>;
        }
      })}
    </>
  );
}

function Table({ head, rows, numeric = [] }: { head: ReactNode[]; rows: ReactNode[][]; numeric?: number[] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <thead className="bg-white/[0.04]">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={cls('whitespace-nowrap px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-krypt-muted', numeric.includes(i) && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/[0.06] align-top">
              {r.map((c, j) => (
                <td key={j} className={cls('px-3 py-2 leading-relaxed', j === 0 ? 'font-medium text-white/90' : 'text-white/75', numeric.includes(j) && 'text-right font-mono tabular-nums')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShortcutsBlock() {
  const keymapOverrides = useSettings((s) => s.settings?.keymap);
  const sections = useMemo(
    () => buildShortcutSections(getKeymap(), (c) => getAppCommand(c)?.label),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keymapOverrides],
  );
  const keys = (list: string[]): ReactNode =>
    list.map((k, i) => (
      <Fragment key={k}>
        {i > 0 && <span className="px-1 text-krypt-muted">or</span>}
        <Kbd>{k}</Kbd>
      </Fragment>
    ));
  return (
    <>
      {sections.map((s) => (
        <section key={s.title} aria-label={s.title}>
          <h3 className="mt-6 text-[14px] font-semibold text-white">{s.title}</h3>
          <Table head={['Command', 'Keys']} rows={s.rows.map((r) => [r.label, keys(r.keys)])} />
        </section>
      ))}
      <h3 className="mt-6 text-[14px] font-semibold text-white">Piano Roll and Playlist tools</h3>
      <Table head={['Tool', 'Key']} rows={Object.values(TOOLS).map((t) => [t.label, <Kbd key={t.key}>{t.key}</Kbd>])} />
      <p className="text-[12.5px] leading-relaxed text-white/70">Tool keys work while the typing keyboard is off.</p>
    </>
  );
}

function catalogLine(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return (m ? m[1] : s).slice(0, 160);
}

function CatalogBlock({ kind }: { kind: 'effect' | 'instrument' }) {
  const list = CATALOG.plugins.filter((p) => p.kind === kind && !isExternalPluginId(p.id));
  return <Table head={['Name', 'Kind', 'What it does']} rows={list.map((p) => [p.name, p.category, PLUGIN_NOTES[p.id] ?? catalogLine(p.description)])} />;
}

type Facts = typeof import('./facts');
let factsPromise: Promise<Facts> | null = null;

function useFacts(): { facts: Facts | null; error: string | null } {
  const [state, setState] = useState<{ facts: Facts | null; error: string | null }>({ facts: null, error: null });
  useEffect(() => {
    let live = true;
    factsPromise ??= import('./facts');
    factsPromise.then(
      (facts) => live && setState({ facts, error: null }),
      (err: unknown) => {
        factsPromise = null;
        if (live) setState({ facts: null, error: (err as Error)?.message ?? String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function Pending({ what }: { what: string }) {
  return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[12.5px] text-krypt-muted">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading {what}…
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="mt-4 flex gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-3.5 py-3 text-[13px] leading-relaxed text-amber-100/90">
      <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-[10.5px] font-semibold uppercase tracking-[0.12em] text-krypt-muted">{label}</dt>
      <dd className="min-w-0 text-[12.5px] leading-relaxed text-white/85">{children}</dd>
    </>
  );
}

function PlaybookCard({ id }: { id: string }) {
  const { facts, error } = useFacts();
  if (error) return <Problem>Couldn't load the genre data ({error}).</Problem>;
  if (!facts) return <Pending what="the genre card" />;
  const f = facts.playbookFacts(id);
  if (!f) return <Problem>Unknown genre "{id}": this card has no playbook to show.</Problem>;
  const maxBars = Math.max(...f.sections.map((s) => s.bars), 1);
  return (
    <section aria-label={`${f.name} at a glance`} className="relative mt-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="h-px w-full bg-krypt-gradient opacity-70" aria-hidden="true" />
      <div className="px-4 pb-4 pt-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-bold tracking-tight text-white">{f.name} at a glance</h3>
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-krypt-muted">From the playbook the AI builds with</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/70">{f.summary}</p>

        <dl className="mt-3 grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1.5">
          <Fact label="Tempo">{f.tempo}</Fact>
          <Fact label="Swing">{f.swing}</Fact>
          <Fact label="Drum grid">{f.grid}</Fact>
          <Fact label="Modes">{f.modes}</Fact>
          <Fact label="Keys">{f.keys}</Fact>
          {f.keyNotes && <Fact label="Key tip">{f.keyNotes}</Fact>}
          <Fact label="Chords">
            <span className="flex flex-wrap gap-1">
              {f.progressions.map((p) => (
                <code key={p} className="rounded bg-black/45 px-1.5 py-px font-mono text-[11.5px] text-white/90">
                  {p}
                </code>
              ))}
            </span>
          </Fact>
          {f.groove && <Fact label="Groove">{f.groove}</Fact>}
        </dl>

        {f.drums.length > 0 && (
          <>
            <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Drums</h4>
            <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-white/80">
              {f.drums.map((d) => (
                <li key={d.name}>
                  <span className="font-semibold text-white">{d.name}:</span> {d.writing}
                </li>
              ))}
            </ul>
            {f.parts.length > 0 && <p className="mt-1.5 text-[12px] text-krypt-muted">Other parts: {f.parts.join(', ')}.</p>}
          </>
        )}

        <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">
          Structure <span className="normal-case tracking-normal text-white/60">· {f.totalBars} bars, {f.length}</span>
        </h4>
        <div className="mt-2 flex h-7 w-full items-end gap-[2px]" aria-hidden="true">
          {f.sections.map((s, i) => (
            <div
              key={i}
              title={`${s.label}: ${s.bars} bars`}
              className="rounded-sm bg-krypt-purple"
              style={{ flexGrow: s.bars, flexBasis: 0, height: `${Math.round(30 + s.energy * 70)}%`, opacity: 0.25 + s.energy * 0.6 }}
            />
          ))}
        </div>
        <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-white/75">
          {f.sections.map((s, i) => (
            <li key={i}>
              {s.label} <span className="font-mono text-[11px] text-krypt-muted">{s.bars}</span>
            </li>
          ))}
        </ol>
        <p className="sr-only">Section lengths in bars; the bar heights show each section's energy, the longest is {maxBars} bars.</p>

        <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Mix targets</h4>
        <dl className="mt-1.5 grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1.5">
          {f.mix.map((m) => (
            <Fact key={m.label} label={m.label}>
              {m.value}
            </Fact>
          ))}
        </dl>

        {f.mistakes.length > 0 && (
          <>
            <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Common mistakes</h4>
            <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-white/75">
              {f.mistakes.map((m) => (
                <li key={m} className="relative pl-4 before:absolute before:left-0 before:top-[0.7em] before:h-1 before:w-1 before:rounded-full before:bg-krypt-pink/80">
                  {m}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function KindsBlock() {
  useEnsureSounds();
  useEnsurePacks();
  const samples = useSounds((s) => s.samples);
  const samplesError = useSounds((s) => s.samplesError);
  const packInfo = usePacks((s) => s.samples);
  const packError = usePacks((s) => s.samplesError);
  const { facts, error } = useFacts();
  if (error) return <Problem>Couldn't load the sound kinds ({error}).</Problem>;
  if (!facts || samples === null) return <Pending what="the sound library" />;
  const rows = facts.kindRows(samples, packInfo?.samples ?? []);
  const factoryTotal = rows.reduce((a, r) => a + r.factory, 0);
  const packTotal = rows.reduce((a, r) => a + r.packs, 0);
  const notInstalled = (packInfo?.packs ?? []).filter((p) => !p.installed);
  const notInstalledCount = notInstalled.reduce((a, p) => a + p.count, 0);
  const n = (v: number): string => (v ? String(v) : '–');
  return (
    <>
      <Table head={['Kind', 'Factory', 'Sound packs']} numeric={[1, 2]} rows={rows.map((r) => [r.label, n(r.factory), n(r.packs)])} />
      {samplesError && <Problem>Couldn't read the factory library ({samplesError}).</Problem>}
      {!samplesError && factoryTotal === 0 && <Problem>The factory sound library isn't installed on this PC, so there's nothing to count. Reinstalling Krypt Studio puts it back.</Problem>}
      {packError && <Problem>Couldn't read the installed sound packs ({packError}).</Problem>}
      <p className="text-[12.5px] leading-relaxed text-white/70">
        {factoryTotal} factory sound{factoryTotal === 1 ? '' : 's'}
        {packInfo ? ` and ${packTotal} from installed sound packs` : ''} on this PC.
        {notInstalled.length > 0 && ` ${notInstalled.length} more pack${notInstalled.length === 1 ? '' : 's'} (${notInstalledCount} sounds) can be downloaded from Home ▸ Sounds.`}
      </p>
    </>
  );
}

function VideoBlock({ id }: { id: string }) {
  const view = videoBlockView(id);
  if (view.kind === 'unknown') return <Problem>This guide points to a video that doesn't exist ("{id}").</Problem>;
  if (view.kind === 'hidden') return null;
  return <VideoPlayer video={view.video} />;
}

function VideoCard({ v, active, onPick }: { v: ReadyGuideVideo; active: boolean; onPick: () => void }) {
  const [posterFailed, setPosterFailed] = useState(false);
  const duration = fmtVideoDuration(v.durationSec);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active || undefined}
      aria-label={`Play “${v.title}” (${duration}). ${v.description}`}
      className={cls(
        'group flex w-full flex-col overflow-hidden rounded-xl border text-left transition hover:border-white/20 hover:bg-white/[0.05]',
        active ? 'border-krypt-purple/40 bg-krypt-purple/[0.07]' : 'border-white/[0.08] bg-white/[0.02]',
        FOCUS_RING,
      )}
    >
      <span className="relative block aspect-video w-full overflow-hidden bg-black">
        {posterFailed ? (
          <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-krypt-purple/20 to-black text-white/40">
            <Clapperboard className="h-6 w-6" aria-hidden="true" />
          </span>
        ) : (
          <img
            src={videoUrls(v.id).poster}
            alt=""
            draggable={false}
            onError={() => setPosterFailed(true)}
            className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02] motion-reduce:transition-none"
          />
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition group-hover:bg-krypt-gradient group-hover:opacity-100">
            <Play className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden="true" />
          </span>
        </span>
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-px font-mono text-[10.5px] text-white/90">{duration}</span>
      </span>
      <span className="block px-2.5 py-2">
        <span className="block truncate text-[12.5px] font-semibold text-white">{v.title}</span>
        <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-krypt-muted">{v.description}</span>
      </span>
    </button>
  );
}

function SoonCard({ v }: { v: GuideVideo }) {
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-xl border border-dashed border-white/[0.08] bg-white/[0.015]" aria-label={`${v.title}: coming soon`}>
      <span className="relative flex aspect-video w-full items-center justify-center bg-gradient-to-br from-white/[0.04] to-transparent text-white/25">
        <Clapperboard className="h-6 w-6" aria-hidden="true" />
        <span className="absolute bottom-1.5 right-1.5 rounded border border-white/10 bg-black/60 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.12em] text-krypt-muted">Coming soon</span>
      </span>
      <span className="block px-2.5 py-2">
        <span className="block truncate text-[12.5px] font-semibold text-white/60">{v.title}</span>
        <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-krypt-muted/80">{v.description}</span>
      </span>
    </div>
  );
}

function VideosBlock() {
  const nav = useContext(NavContext);
  const { ready, soon } = useMemo(() => videoIndex(), []);
  const [picked, setPicked] = useState<string | null>(null);
  const current = ready.find((v) => v.id === picked) ?? ready[0] ?? null;
  const topRef = useRef<HTMLDivElement>(null);
  const narrow = nav.variant === 'panel';
  const pick = (id: string): void => {
    setPicked(id);
    topRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const target = current ? articleById(current.article) : undefined;
  return (
    <section aria-label="Video tutorials">
      <div ref={topRef} className="scroll-mt-4">
        {current ? (
          <VideoPlayer
            video={current}
            autoPlay={picked === current.id}
            extra={
              target && (
                <button
                  type="button"
                  onClick={() => openArticle(nav, target.id)}
                  title={`Guide: ${target.title}`}
                  className={cls('inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold text-indigo-300 transition hover:bg-white/5 hover:text-white', FOCUS_RING)}
                >
                  <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> Read the guide
                </button>
              )
            }
          />
        ) : (
          <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] text-white/75">
            <Clapperboard className="h-4 w-4 flex-shrink-0 text-krypt-purple" aria-hidden="true" /> The tutorial videos are on their way: they show up here with an update.
          </div>
        )}
      </div>
      {ready.length > 0 && (
        <>
          <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Watch</h3>
          <ul className={cls('mt-2 grid gap-2.5', narrow ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
            {ready.map((v) => (
              <li key={v.id}>
                <VideoCard v={v} active={v.id === current?.id} onPick={() => pick(v.id)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {soon.length > 0 && (
        <>
          <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Coming soon</h3>
          <ul className={cls('mt-2 grid gap-2.5', narrow ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4')}>
            {soon.map((v) => (
              <li key={v.id}>
                <SoonCard v={v} />
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-6 border-t border-white/[0.07] pt-3 text-[11.5px] text-krypt-muted">{VIDEO_CREDIT}</p>
    </section>
  );
}

function ButtonRow({ items }: { items: Array<Extract<Inline, { t: 'action' | 'show' }>> }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {items.map((a, i) =>
        a.t === 'show' ? (
          <HomeButton key={`s:${a.anchor}:${i}`} kind="ghost" icon={MousePointerClick} onClick={() => void showGuideAnchor(a.anchor)} title="Show me where this is">
            {a.label}
          </HomeButton>
        ) : (
          <HomeButton key={`a:${a.id}:${i}`} kind={i === 0 ? 'primary' : 'ghost'} icon={ArrowRight} onClick={() => runLink(a.id)}>
            {a.label}
          </HomeButton>
        ),
      )}
    </div>
  );
}

function Block({ b }: { b: GuideBlock }) {
  switch (b.type) {
    case 'h2':
      return (
        <h2 data-heading={b.anchor} className="mt-8 scroll-mt-4 text-[17px] font-bold tracking-tight text-white">
          <Runs runs={b.text} />
        </h2>
      );
    case 'h3':
      return (
        <h3 className="mt-5 text-[14px] font-semibold text-white">
          <Runs runs={b.text} />
        </h3>
      );
    case 'p':
      return (
        <p className="mt-3 text-[13.5px] leading-[1.7] text-white/80">
          <Runs runs={b.text} />
        </p>
      );
    case 'ul':
      return (
        <ul className="mt-3 space-y-1.5 text-[13.5px] leading-[1.65] text-white/80">
          {b.items.map((it, i) => (
            <li key={i} className="relative pl-4 before:absolute before:left-0 before:top-[0.7em] before:h-1 before:w-1 before:rounded-full before:bg-krypt-purple/80">
              <Runs runs={it} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="mt-3 space-y-2 text-[13.5px] leading-[1.65] text-white/80">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-[0.15em] flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-krypt-purple/40 bg-krypt-purple/10 font-mono text-[10.5px] font-semibold text-purple-200">{(b.start ?? 1) + i}</span>
              <span className="min-w-0">
                <Runs runs={it} />
              </span>
            </li>
          ))}
        </ol>
      );
    case 'table':
      return <Table head={b.head.map((h, i) => <Runs key={i} runs={h} />)} rows={b.rows.map((r) => r.map((c, i) => <Runs key={i} runs={c} />))} />;
    case 'tip':
    case 'warn': {
      const warn = b.type === 'warn';
      const Icon = warn ? TriangleAlert : Lightbulb;
      return (
        <div className={cls('mt-4 flex gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed', warn ? 'border-amber-400/25 bg-amber-500/[0.07] text-amber-100/90' : 'border-krypt-purple/25 bg-krypt-purple/[0.07] text-white/85')}>
          <Icon className={cls('mt-0.5 h-4 w-4 flex-shrink-0', warn ? 'text-amber-300' : 'text-krypt-purple')} aria-hidden="true" />
          <span>
            <Runs runs={b.text} />
          </span>
        </div>
      );
    }
    case 'actions':
      return <ButtonRow items={b.items.map((a) => ({ t: 'action' as const, id: a.id, label: a.label }))} />;
    case 'buttons':
      return <ButtonRow items={b.items} />;
    case 'shortcuts':
      return <ShortcutsBlock />;
    case 'catalog':
      return <CatalogBlock kind={b.kind} />;
    case 'playbook':
      return <PlaybookCard id={b.id} />;
    case 'kinds':
      return <KindsBlock />;
    case 'video':
      return <VideoBlock id={b.id} />;
    case 'videos':
      return <VideosBlock />;
    case 'image':
      return <GuideImage file={b.file} caption={b.caption} />;
    default:
      return null;
  }
}

function NavCard({ a, label, align }: { a: GuideArticle; label: string; align: 'left' | 'right' }) {
  const nav = useContext(NavContext);
  return (
    <button
      type="button"
      onClick={() => nav.open(a.id)}
      className={cls('rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 transition hover:border-white/20', align === 'right' ? 'text-right' : 'text-left', FOCUS_RING)}
    >
      <span className="block text-[10.5px] uppercase tracking-[0.14em] text-krypt-muted">{label}</span>
      <span className="text-[13px] font-semibold text-white">{a.title}</span>
    </button>
  );
}

export function GuideArticleView({ article, compact = false }: { article: GuideArticle; compact?: boolean }) {
  const nav = useContext(NavContext);
  const ordered = useMemo(() => orderedArticles(), []);
  const index = ordered.findIndex((a) => a.id === article.id);
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
  const related = useMemo(() => relatedArticles(article), [article]);
  const Icon = iconOf(article.icon);
  return (
    <article className={cls('mx-auto w-full max-w-[760px] pb-28', compact ? 'px-4 pt-5' : 'px-4 pt-7 sm:px-8')}>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{article.group}</div>
      <div className="mt-2 flex items-center gap-3">
        <span className={cls('flex flex-shrink-0 items-center justify-center rounded-xl border border-krypt-purple/40 bg-krypt-purple/[0.14] text-purple-200', compact ? 'h-8 w-8' : 'h-10 w-10')}>
          <Icon className={compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h1 className={cls('font-bold tracking-tight text-white', compact ? 'text-xl' : 'text-2xl')}>{article.title}</h1>
      </div>
      <p className="mt-2 text-[14px] text-krypt-muted">{article.summary}</p>
      <div className="mt-2">
        {blocksOf(article).map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>

      {related.length > 0 && (
        <nav aria-label="Related guides" className="mt-10">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Related</h2>
          <ul className={cls('mt-2 grid gap-1.5', !compact && 'sm:grid-cols-2')}>
            {related.map((r) => {
              const I = iconOf(r.icon);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => nav.open(r.id)}
                    className={cls('flex w-full items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left transition hover:border-white/20 hover:bg-white/[0.05]', FOCUS_RING)}
                  >
                    <I className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-semibold text-white">{r.title}</span>
                      <span className="block truncate text-[11.5px] text-krypt-muted">{r.summary}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      <div className={cls('mt-8 grid grid-cols-1 gap-2 border-t border-white/[0.07] pt-5', !compact && 'sm:grid-cols-2')}>
        {prev ? <NavCard a={prev} label="Previous" align="left" /> : <span />}
        {next && <NavCard a={next} label="Next" align="right" />}
      </div>
    </article>
  );
}

export function SearchResults({ query, hits, onPick, compact = false }: { query: string; hits: SearchHit[]; onPick: (id: string) => void; compact?: boolean }) {
  return (
    <div className={cls('mx-auto w-full max-w-[760px] pb-16', compact ? 'px-3 pt-3' : 'px-4 pt-6 sm:px-8')}>
      <div className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-krypt-muted" role="status">
        {hits.length ? `${hits.length} guide${hits.length === 1 ? '' : 's'} mention “${query}”` : `No guide mentions “${query}”.`}
      </div>
      <ul className="mt-2 space-y-1.5">
        {hits.map((h, i) => {
          const I = iconOf(h.article.icon);
          return (
            <li key={h.article.id}>
              <button
                type="button"
                onClick={() => onPick(h.article.id)}
                className={cls(
                  'flex w-full gap-3 rounded-xl border px-3 py-2.5 text-left transition hover:border-white/20 hover:bg-white/[0.05]',
                  i === 0 ? 'border-krypt-purple/30 bg-krypt-purple/[0.06]' : 'border-white/[0.07] bg-white/[0.02]',
                  FOCUS_RING,
                )}
              >
                <I className="mt-0.5 h-4 w-4 flex-shrink-0 text-krypt-purple" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold text-white">{h.article.title}</span>
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-[0.12em] text-krypt-muted">{h.article.group}</span>
                  </span>
                  {h.snippet ? (
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-white/65">
                      {h.snippet.before}
                      <mark className="rounded bg-krypt-purple/25 px-0.5 text-white">{h.snippet.match}</mark>
                      {h.snippet.after}
                    </span>
                  ) : (
                    <span className="mt-0.5 block truncate text-[12px] text-white/55">{h.article.summary}</span>
                  )}
                </span>
                {i === 0 && <CornerDownRight className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-krypt-muted" aria-label="Enter opens this one" />}
              </button>
            </li>
          );
        })}
      </ul>
      {!hits.length && (
        <p className="mt-3 flex items-center gap-2 px-1 text-[12.5px] text-white/60">
          <BookOpen className="h-3.5 w-3.5 text-krypt-muted" aria-hidden="true" /> Try a shorter word, or browse the list.
        </p>
      )}
    </div>
  );
}

export function scrollToHeading(pane: HTMLElement | null, anchor: string): boolean {
  if (!pane) return false;
  const el = Array.from(pane.querySelectorAll<HTMLElement>('[data-heading]')).find((h) => h.dataset.heading === anchor);
  if (!el) return false;
  el.scrollIntoView({ block: 'start' });
  return true;
}
