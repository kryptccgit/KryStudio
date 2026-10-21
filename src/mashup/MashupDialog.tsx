import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Ban,
  Blend,
  BrainCircuit,
  Check,
  Circle,
  CircleX,
  FileAudio,
  History,
  Layers,
  LibraryBig,
  Lightbulb,
  ListMusic,
  Loader2,
  MicVocal,
  Music2,
  RefreshCw,
  Repeat2,
  Search,
  ShieldAlert,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { MASHUP_RIGHTS_NOTE, type MashupPlanSummary, type MashupSongReading, type MashupStyle } from '@shared/mashup/types';
import type { LibraryTrack } from '@shared/library/types';
import { Check as CheckBox, Field, NumberBox, Segmented, openDialog } from '../components/Dialog';
import { ProgressBar } from '../ears/ProgressBar';
import { useAnalyzer } from '../panels/modelManager/store';
import { useLibrary } from '../library/store';
import { useDocStore } from '../doc/store';
import { stemModelState } from '../audioProject/logic';
import { cls } from '../utils/format';
import {
  BARS_MAX,
  BARS_MIN,
  STAGES,
  STEMS,
  STEM_LABEL,
  SONG_LABEL,
  barFraction,
  fmtBpm,
  fmtDuration,
  fmtShift,
  keyLabel,
  libraryTrackCount,
  needsStemModel,
  patchChanges,
  percentText,
  planLine,
  ringDash,
  scoreLabel,
  scoreTone,
  songRole,
  stageStates,
  stretchAudible,
  suggestionPatch,
  tempoChips,
  timelineLayout,
  vocalLabel,
  type FormOptions,
  type Song,
  type StageState,
  type TuneChoice,
} from './logic';
import { backToForm, useMashup } from './store';
import {
  applySuggestion,
  buildBlocker,
  cancelBuild,
  editForm,
  onDialogClosed,
  onDialogOpened,
  openModelManager,
  openStudio,
  pickClip,
  pickFile,
  pickLibraryTrack,
  projectSongs,
  runCheck,
  searchLibrary,
  setSlot,
  startBuild,
} from './actions';

const btn =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3.5 text-[12px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-40';
const small =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] font-semibold text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40';
const primary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-krypt-gradient px-4 text-[12px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none';

const SONG_TONE: Record<Song | 'both' | 'none', { text: string; chip: string; block: string }> = {
  a: { text: 'text-indigo-300', chip: 'border-krypt-indigo/40 bg-krypt-indigo/15 text-indigo-200', block: 'border-krypt-indigo/50 bg-krypt-indigo/20' },
  b: { text: 'text-pink-300', chip: 'border-krypt-pink/40 bg-krypt-pink/15 text-pink-200', block: 'border-krypt-pink/50 bg-krypt-pink/20' },
  both: { text: 'text-purple-300', chip: 'border-krypt-purple/40 bg-krypt-purple/15 text-purple-200', block: 'border-krypt-purple/50 bg-krypt-purple/20' },
  none: { text: 'text-white/60', chip: 'border-white/10 bg-white/5 text-white/70', block: 'border-white/15 bg-white/[0.06]' },
};

export function openMashupDialog(doc?: Document | null): void {
  openDialog({
    key: 'mashup',
    title: 'Auto Mashup',
    subtitle: 'Two songs become one mashup project on one tempo and key: an editable arrangement, built as one undo step. All on your PC.',
    icon: Blend,
    width: 780,
    doc,
    render: (close) => <MashupView close={close} />,
    onClose: onDialogClosed,
  });
  onDialogOpened();
}

function MashupView({ close }: { close: () => void }) {
  const phase = useMashup((s) => s.phase);
  const picking = useMashup((s) => s.picking);
  if (phase === 'done') return <DoneView close={close} />;
  if (phase !== 'idle') return <ProgressView close={close} />;
  if (picking) return <LibraryPicker song={picking} />;
  return <FormView close={close} />;
}

function Note({ icon: Icon, tone, children }: { icon: LucideIcon; tone: 'muted' | 'warn' | 'ok' | 'error'; children: ReactNode }) {
  return (
    <div
      className={cls(
        'flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-snug',
        tone === 'warn' && 'border-amber-400/25 bg-amber-500/[0.07] text-amber-100/90',
        tone === 'ok' && 'border-emerald-400/20 bg-emerald-500/[0.06] text-emerald-100/90',
        tone === 'error' && 'border-rose-400/30 bg-rose-500/10 text-rose-100',
        tone === 'muted' && 'border-white/[0.07] bg-black/20 text-white/75',
      )}
    >
      <Icon
        size={13}
        className={cls('mt-px flex-shrink-0', tone === 'warn' ? 'text-amber-300' : tone === 'ok' ? 'text-emerald-300' : tone === 'error' ? 'text-rose-300' : 'text-krypt-purple')}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h4 className="flex-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">{children}</h4>
      {right}
    </div>
  );
}

function SongBadge({ song }: { song: Song }) {
  return (
    <span className={cls('flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border font-mono text-[11px] font-bold', SONG_TONE[song].chip)} aria-hidden="true">
      {SONG_LABEL[song]}
    </span>
  );
}

function FormView({ close }: { close: () => void }) {
  const form = useMashup((s) => s.form);
  const check = useMashup((s) => s.check);
  const blocker = buildBlocker();
  const [busy, setBusy] = useState(false);

  const build = async (): Promise<void> => {
    setBusy(true);
    try {
      await startBuild();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-4 px-4 py-3.5">
        <section data-guide="mashup.songs" aria-label="The two songs">
          <SectionTitle>Songs</SectionTitle>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-2">
            <SlotCard song="a" />
            <div className="flex items-center">
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="Swap A and B"
                aria-label="Swap songs A and B"
                disabled={!form.a && !form.b}
                onClick={() => editForm({ type: 'swap' })}
              >
                <ArrowLeftRight size={14} />
              </button>
            </div>
            <SlotCard song="b" />
          </div>
        </section>

        <Compatibility />

        <section data-guide="mashup.style" aria-label="Style">
          <SectionTitle>Style</SectionTitle>
          <StylePicker />
        </section>

        <section data-guide="mashup.options" aria-label="Options" className="space-y-2.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
          <Options />
        </section>

        <PlanPreview
          plan={check.status === 'ready' ? (check.result?.plan ?? null) : null}
          stale={check.status === 'checking' ? (check.result?.plan ?? null) : null}
          names={check.result ? { a: check.result.a.name, b: check.result.b.name } : undefined}
        />
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-krypt-panel px-4 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[10.5px] text-krypt-muted" title={blocker ?? undefined}>
            {blocker
              ? blocker
              : form.newProject
                ? 'Opens in a new project tab. Your current project stays open.'
                : 'Adds the mashup to this project, on new tracks.'}
          </div>
          <button type="button" className={btn} onClick={close}>
            Close
          </button>
          <button type="button" data-guide="mashup.build" className={primary} disabled={!!blocker || busy} onClick={() => void build()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Blend size={13} />}
            {busy ? 'Starting…' : 'Build the mashup'}
          </button>
        </div>
        <p className="mt-1.5 flex items-center justify-end gap-1 text-right text-[9.5px] leading-snug text-krypt-muted/80">
          <ShieldAlert size={10} className="flex-shrink-0" /> {MASHUP_RIGHTS_NOTE}
        </p>
      </div>
    </div>
  );
}

function SlotCard({ song }: { song: Song }) {
  const slot = useMashup((s) => s.form[song]);
  const factor = useMashup((s) => (song === 'a' ? s.form.factorA : s.form.factorB));
  const check = useMashup((s) => s.check);
  const libCount = useLibrary((s) => libraryTrackCount(s.state?.collections));
  useDocStore((s) => s.version);
  const clips = projectSongs();
  const reading: MashupSongReading | null = check.result && (check.status === 'ready' || check.status === 'checking') ? check.result[song] : null;

  return (
    <div className={cls('flex min-w-0 flex-col rounded-xl border bg-black/25 p-3', slot ? 'border-white/10' : 'border-dashed border-white/15')}>
      <div className="flex items-start gap-2">
        <SongBadge song={song} />
        <div className="min-w-0 flex-1">
          {slot ? (
            <>
              <div className="truncate text-[13px] font-semibold text-white" title={slot.name}>
                {slot.name}
              </div>
              <div className="flex items-center gap-1 truncate text-[10px] text-krypt-muted" title={slot.detail}>
                {slot.kind === 'clip' ? <ListMusic size={10} /> : slot.kind === 'library' ? <LibraryBig size={10} /> : <FileAudio size={10} />}
                <span className="truncate">{slot.detail}</span>
              </div>
            </>
          ) : (
            <>
              <div className="text-[12.5px] font-semibold text-white/85">Song {SONG_LABEL[song]}</div>
              <div className="text-[10px] text-krypt-muted">WAV, MP3, M4A, FLAC and other audio</div>
            </>
          )}
        </div>
        {slot && (
          <button
            type="button"
            className="-mr-1 -mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white"
            title={`Remove song ${SONG_LABEL[song]}`}
            aria-label={`Remove song ${SONG_LABEL[song]}`}
            onClick={() => setSlot(song, null)}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {!slot && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" className={small} onClick={() => void pickFile(song)}>
            <FileAudio size={12} /> Choose a file…
          </button>
          {libCount > 0 && (
            <button type="button" className={small} onClick={() => useMashup.setState({ picking: song })}>
              <LibraryBig size={12} /> From your library
            </button>
          )}
          {clips.length > 0 && (
            <select
              aria-label={`Song ${SONG_LABEL[song]} from this project`}
              value=""
              onChange={(e) => e.target.value && pickClip(song, e.target.value)}
              className="h-7 max-w-full cursor-pointer rounded-lg border border-white/10 bg-black/40 px-2 text-[11px] font-semibold text-white/80 outline-none hover:border-white/20 focus:border-krypt-purple/60"
            >
              <option value="" className="bg-krypt-surface">
                From this project…
              </option>
              {clips.map((c) => (
                <option key={c.clipId} value={c.clipId} className="bg-krypt-surface">
                  {c.label} ({c.detail})
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {slot && reading && <Reading song={song} reading={reading} factor={factor} dim={check.status === 'checking'} />}
      {slot && !reading && check.status === 'checking' && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-krypt-muted">
          <Loader2 size={11} className="animate-spin text-krypt-purple" /> Listening…
        </div>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-[46px] flex-shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-krypt-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Reading({ song, reading, factor, dim }: { song: Song; reading: MashupSongReading; factor: 1 | 0.5 | 2; dim: boolean }) {
  const chips = tempoChips(reading, factor);
  const presence = Math.max(0, Math.min(1, reading.vocalPresence || 0));
  return (
    <div className={cls('mt-2.5 space-y-1.5 border-t border-white/[0.06] pt-2.5 transition-opacity', dim && 'opacity-50')}>
      <Fact label="Tempo">
        {chips.length ? (
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Tempo reading of song ${SONG_LABEL[song]}`}>
            {chips.map((c) => (
              <button
                key={c.factor}
                type="button"
                role="radio"
                aria-checked={c.active}
                title={`${c.title}: ${fmtBpm(c.bpm)} BPM`}
                onClick={() => editForm({ type: 'set', patch: song === 'a' ? { factorA: c.factor } : { factorB: c.factor } })}
                className={cls(
                  'h-6 rounded-md px-2 font-mono text-[10.5px] font-semibold transition',
                  c.active ? 'bg-krypt-purple/25 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.6)]' : 'border border-white/10 text-white/60 hover:bg-white/5 hover:text-white',
                )}
              >
                {c.label}
                {c.factor !== 1 && <span className="ml-1 font-sans text-[9px] font-normal text-krypt-muted">{c.factor === 0.5 ? '½' : '×2'}</span>}
              </button>
            ))}
            <span className="self-center text-[9.5px] text-krypt-muted">BPM</span>
          </div>
        ) : (
          <span className="text-[11px] text-white/60">Not clear</span>
        )}
      </Fact>
      <Fact label="Key">
        <span className="font-mono text-[11.5px] text-white/90">{keyLabel(reading)}</span>
        {reading.durationSec > 0 && <span className="ml-2 font-mono text-[10px] text-krypt-muted">{fmtDuration(reading.durationSec)}</span>}
      </Fact>
      <Fact label="Vocal">
        <div className="flex items-center gap-2" title={`${Math.round(presence * 100)} % of the song has a lead vocal`}>
          <div className="h-1.5 w-16 flex-shrink-0 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-krypt-purple/80" style={{ width: `${Math.round(presence * 100)}%` }} />
          </div>
          <span className="truncate text-[10.5px] text-white/75">{vocalLabel(presence)}</span>
        </div>
      </Fact>
      {reading.stems.length > 0 && (
        <Fact label="Stems">
          <span className="text-[10.5px] text-emerald-300/90">{reading.stems.map((s) => STEM_LABEL[s]).join(' · ')}</span>
        </Fact>
      )}
    </div>
  );
}

function LibraryPicker({ song }: { song: Song }) {
  const [text, setText] = useState('');
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void searchLibrary(text).then((r) => {
        if (live) setTracks(r);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text]);

  return (
    <div className="flex flex-col">
      <div className="space-y-2.5 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-white">
          <SongBadge song={song} /> Song {SONG_LABEL[song]} from your reference library
        </div>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2.5 focus-within:border-krypt-purple/60">
          <Search size={13} className="text-krypt-muted" />
          <input
            data-autofocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by name, folder or tag"
            className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-krypt-muted/70"
          />
        </label>
        <div className="max-h-[340px] overflow-y-auto rounded-xl border border-white/[0.06] bg-black/20">
          {tracks === null ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-krypt-muted">
              <Loader2 size={12} className="animate-spin" /> Searching…
            </div>
          ) : tracks.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-krypt-muted">{text ? `Nothing matches "${text}".` : 'Your reference library has no tracks yet.'}</div>
          ) : (
            <ul>
              {tracks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => pickLibraryTrack(song, t)}
                    className="flex w-full items-center gap-2.5 border-b border-white/[0.04] px-3 py-1.5 text-left transition last:border-0 hover:bg-white/[0.05]"
                    title={t.path}
                  >
                    <Music2 size={12} className="flex-shrink-0 text-krypt-purple" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-white/90">{t.name}</span>
                    <span className="flex-shrink-0 font-mono text-[10px] text-krypt-muted">
                      {[t.bpm ? `${fmtBpm(t.bpm)} BPM` : '', t.key ?? '', t.durationSec ? fmtDuration(t.durationSec) : ''].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3">
        <span className="text-[10px] text-krypt-muted">Only songs you own or have the rights to use.</span>
        <button type="button" className={btn} onClick={() => useMashup.setState({ picking: null })}>
          Back
        </button>
      </div>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const id = useId().replace(/:/g, '');
  const r = 25;
  const { dash, gap } = ringDash(score, r);
  const tone = scoreTone(score);
  const stroke = tone === 'good' ? `url(#${id})` : tone === 'ok' ? '#FBBF24' : '#FB7185';
  return (
    <div className="relative h-16 w-16 flex-shrink-0" role="img" aria-label={`Compatibility ${Math.round(score)} out of 100`}>
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="50%" stopColor="#A855F7" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${dash} ${gap}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[17px] font-bold leading-none text-white">{Math.round(score)}</span>
        <span className="text-[8px] uppercase tracking-[0.14em] text-krypt-muted">fit</span>
      </div>
    </div>
  );
}

function Compatibility() {
  const check = useMashup((s) => s.check);
  const form = useMashup((s) => s.form);
  const analyzer = useAnalyzer((s) => s.state);
  const res = check.result;

  let body: ReactNode;
  if (check.status === 'idle') {
    body = (
      <p className="text-[11.5px] leading-snug text-krypt-muted">
        Pick both songs: Krypt reads their tempo, key, sections and vocals on your PC, says how well they fit, and plans the mashup before anything is built.
      </p>
    );
  } else if (check.status === 'failed') {
    body = (
      <Note icon={CircleX} tone="error">
        <div className="font-semibold">Couldn't check these songs</div>
        <div className="mt-0.5 text-rose-100/85">{check.error}</div>
        <button type="button" className={cls(small, 'mt-2')} onClick={() => void runCheck(true)}>
          <RefreshCw size={12} /> Check again
        </button>
      </Note>
    );
  } else if (!res) {
    body = (
      <div className="flex items-center gap-2 text-[11.5px] text-white/80">
        <Loader2 size={14} className="animate-spin text-krypt-purple" />
        Listening to both songs: tempo, key, beats, sections and vocals. The first time takes about 10 seconds a song.
      </div>
    );
  } else {
    const suggestions = res.suggestions.map((s) => ({ text: s, patch: suggestionPatch(s) }));
    body = (
      <div className={cls('space-y-3 transition-opacity', check.status === 'checking' && 'opacity-60')}>
        <div className="flex items-center gap-3.5">
          <ScoreRing score={res.score} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-white">{scoreLabel(res.score)}</div>
            <div className="mt-0.5 font-mono text-[11px] text-white/70">{planLine(res.plan)}</div>
            {check.status === 'checking' && (
              <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-krypt-muted">
                <Loader2 size={11} className="animate-spin text-krypt-purple" /> Checking again with your changes…
              </div>
            )}
          </div>
        </div>
        {res.problems.length > 0 && (
          <div className="space-y-1.5">
            {res.problems.map((p) => (
              <Note key={p} icon={TriangleAlert} tone="error">
                {p}
                {needsStemModel(p) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <button type="button" className={small} onClick={openModelManager}>
                      <BrainCircuit size={12} /> Open Model Manager
                    </button>
                    {form.style !== 'backAndForth' && (
                      <button type="button" className={small} onClick={() => editForm({ type: 'set', patch: { style: 'backAndForth' } })}>
                        <Repeat2 size={12} /> Use Back & forth (no stems needed)
                      </button>
                    )}
                  </div>
                )}
              </Note>
            ))}
          </div>
        )}
        {res.reasons.length > 0 && (
          <ul className="space-y-0.5">
            {res.reasons.map((r) => (
              <li key={r} className="flex items-start gap-2 text-[11.5px] leading-snug text-white/80">
                <Check size={11} className="mt-[3px] flex-shrink-0 text-krypt-purple" />
                <span className="min-w-0">{r}</span>
              </li>
            ))}
          </ul>
        )}
        {suggestions.length > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Could be better</div>
            <ul className="space-y-1">
              {suggestions.map((s) => (
                <li key={s.text} className="flex items-start gap-2 text-[11.5px] leading-snug text-white/85">
                  <Lightbulb size={11} className="mt-[3px] flex-shrink-0 text-amber-300" />
                  <span className="min-w-0 flex-1">{s.text}</span>
                  {patchChanges(form, s.patch) && (
                    <button type="button" className={cls(small, 'h-6 px-2 text-[10.5px]')} onClick={() => applySuggestion(s.text)}>
                      Apply
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const model = stemModelState(analyzer);
  const needsStems = form.style !== 'backAndForth';
  return (
    <section data-guide="mashup.score" aria-label="How well they fit" className="rounded-xl border border-white/[0.07] bg-black/25 px-3 py-3">
      <SectionTitle
        right={
          check.status === 'ready' ? (
            <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-krypt-muted transition hover:text-white" onClick={() => void runCheck(true)}>
              <RefreshCw size={10} /> Check again
            </button>
          ) : null
        }
      >
        How well they fit
      </SectionTitle>
      {body}
      {needsStems && model === 'missing' && !(res?.problems ?? []).some(needsStemModel) && (
        <div className="mt-2">
          <Note icon={TriangleAlert} tone="warn">
            Vocal over beat and Stem blend split the songs with HT-Demucs, which isn't installed (an a cappella or an instrumental works without it).{' '}
            <button type="button" className="font-semibold text-amber-200 underline decoration-amber-300/40 underline-offset-2 hover:text-white" onClick={openModelManager}>
              Install it in the Model Manager
            </button>
          </Note>
        </div>
      )}
    </section>
  );
}

const STYLES: ReadonlyArray<{ id: MashupStyle; icon: LucideIcon; title: string; body: string }> = [
  { id: 'vocalOverBeat', icon: MicVocal, title: 'Vocal over beat', body: "One song's vocal on the other's instrumental: the classic mashup." },
  { id: 'stemBlend', icon: Layers, title: 'Stem blend', body: 'Pick each stem (vocals, drums, bass, other) from either song.' },
  { id: 'backAndForth', icon: Repeat2, title: 'Back & forth', body: 'The two songs trade sections on one tempo and key. No stems needed.' },
];

function StylePicker() {
  const style = useMashup((s) => s.form.style);
  const vocalFrom = useMashup((s) => s.form.vocalFrom);
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Mashup style">
        {STYLES.map((s) => {
          const on = s.id === style;
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => editForm({ type: 'set', patch: { style: s.id } })}
              className={cls(
                'relative flex flex-col items-start gap-1 overflow-hidden rounded-xl border p-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70',
                on ? 'border-krypt-purple/60 bg-krypt-purple/[0.12]' : 'border-white/10 bg-black/25 hover:border-white/20 hover:bg-white/[0.04]',
              )}
            >
              {on && <span className="pointer-events-none absolute inset-x-3 top-0 h-px bg-krypt-gradient" />}
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-white">
                <Icon size={14} className={on ? 'text-purple-200' : 'text-white/70'} /> {s.title}
              </span>
              <span className="text-[10.5px] leading-snug text-krypt-muted">{s.body}</span>
            </button>
          );
        })}
      </div>
      {style === 'vocalOverBeat' && (
        <Field label="Vocal from" hint="Auto picks the direction that fits best: who has a vocal, and the smaller tempo and key change">
          <Segmented<'auto' | Song>
            value={vocalFrom}
            size="sm"
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'a', label: 'Song A' },
              { value: 'b', label: 'Song B' },
            ]}
            onChange={(v) => editForm({ type: 'set', patch: { vocalFrom: v } })}
          />
        </Field>
      )}
      {style === 'stemBlend' && <StemGrid />}
    </div>
  );
}

function StemGrid() {
  const stems = useMashup((s) => s.form.stems);
  const cols: Array<{ pick: Song | null; label: string }> = [
    { pick: 'a', label: 'Song A' },
    { pick: 'b', label: 'Song B' },
    { pick: null, label: 'Off' },
  ];
  return (
    <div data-guide="mashup.stems" className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2" role="group" aria-label="Which song each stem comes from">
      <div className="grid grid-cols-[72px_repeat(3,minmax(0,1fr))] items-center gap-1.5">
        <span />
        {cols.map((c) => (
          <span key={c.label} className={cls('text-center text-[9.5px] font-semibold uppercase tracking-[0.14em]', c.pick ? SONG_TONE[c.pick].text : 'text-krypt-muted')}>
            {c.label}
          </span>
        ))}
        {STEMS.map((stem) => (
          <StemRow key={stem} label={STEM_LABEL[stem]} value={stems[stem]} cols={cols} onPick={(pick) => editForm({ type: 'setStem', stem, pick })} />
        ))}
      </div>
    </div>
  );
}

function StemRow({ label, value, cols, onPick }: { label: string; value: Song | null; cols: Array<{ pick: Song | null; label: string }>; onPick: (p: Song | null) => void }) {
  return (
    <>
      <span className="text-[11.5px] font-semibold text-white/85">{label}</span>
      {cols.map((c) => {
        const on = value === c.pick;
        return (
          <button
            key={c.label}
            type="button"
            aria-pressed={on}
            aria-label={`${label} from ${c.label}`}
            onClick={() => onPick(c.pick)}
            className={cls(
              'h-6 rounded-md border text-[10.5px] font-semibold transition',
              on ? (c.pick ? SONG_TONE[c.pick].chip : 'border-white/20 bg-white/10 text-white/80') : 'border-white/[0.07] text-white/30 hover:bg-white/5 hover:text-white/70',
            )}
          >
            {on ? (c.pick ? SONG_LABEL[c.pick] : '—') : ''}
          </button>
        );
      })}
    </>
  );
}

const ANCHORS: Array<{ value: FormOptions['anchor']; label: string; title: string }> = [
  { value: 'auto', label: 'Auto', title: "The instrumental keeps its key; the tempo meets half way when keeping the beat's would stretch the vocal audibly" },
  { value: 'beat', label: 'Keep the beat', title: 'The instrumental stays untouched; the vocal moves to its tempo and key' },
  { value: 'vocal', label: 'Keep the vocal', title: 'The vocal stays untouched; the instrumental moves' },
  { value: 'middle', label: 'Meet in the middle', title: 'Both move about half way: the smallest change on either' },
];

const TUNES: Array<{ value: TuneChoice; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'No pitch correction' },
  { value: 'natural', label: 'Natural', title: 'Gentle: keeps the singer human' },
  { value: 'pop', label: 'Pop', title: 'Tight, polished radio vocal' },
  { value: 'hard', label: 'Hard', title: 'The robotic trap sound' },
];

function Options() {
  const f = useMashup((s) => s.form);
  const set = (patch: Partial<FormOptions>): void => editForm({ type: 'set', patch });
  const clipInNew = f.newProject && (f.a?.kind === 'clip' || f.b?.kind === 'clip');
  return (
    <>
      <Field label="Anchor" hint="Who keeps their own tempo and key">
        <Segmented value={f.anchor} size="sm" options={ANCHORS} onChange={(v) => set({ anchor: v })} />
      </Field>
      {f.style !== 'backAndForth' && (
        <Field label="Krypt Tune on the vocal" hint="Pitch correction to the mashup's key">
          <Segmented value={f.tune} size="sm" options={TUNES} onChange={(v) => set({ tune: v })} />
        </Field>
      )}
      <Field label="Length" hint={f.bars === null ? "Auto: the instrumental's arranged length, up to 128 bars" : `${BARS_MIN} to ${BARS_MAX} bars`}>
        <div className="flex items-center gap-2">
          <Segmented<'auto' | 'bars'>
            value={f.bars === null ? 'auto' : 'bars'}
            size="sm"
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'bars', label: 'Bars' },
            ]}
            onChange={(v) => set({ bars: v === 'auto' ? null : (f.bars ?? 64) })}
          />
          {f.bars !== null && <NumberBox value={f.bars} min={BARS_MIN} max={BARS_MAX} step={4} suffix="bars" width={52} onChange={(n) => set({ bars: n })} />}
        </div>
      </Field>
      <Field label="Put it in" hint={clipInNew ? 'The project clips are copied into the new project' : undefined}>
        <Segmented<'new' | 'here'>
          value={f.newProject ? 'new' : 'here'}
          size="sm"
          options={[
            { value: 'new', label: 'A new project' },
            { value: 'here', label: 'This project' },
          ]}
          onChange={(v) => set({ newProject: v === 'new' })}
        />
      </Field>
      <CheckBox
        checked={f.transitions}
        onChange={(on) => set({ transitions: on })}
        label="Transitions between sections"
        hint="Risers, impacts and sweeps at each section boundary, so the switches don't sound like hard cuts."
      />
    </>
  );
}

function PlanPreview({ plan, stale, names }: { plan: MashupPlanSummary | null; stale: MashupPlanSummary | null; names?: { a: string; b: string } }) {
  const stems = useMashup((s) => s.form.stems);
  const shown = plan ?? stale;
  const layout = useMemo(() => (shown ? timelineLayout(shown, shown.style === 'stemBlend' ? stems : undefined, names) : null), [shown, stems, names]);
  return (
    <section data-guide="mashup.plan" aria-label="The plan" className="rounded-xl border border-white/[0.07] bg-black/25 px-3 py-3">
      <SectionTitle>The plan</SectionTitle>
      {!shown || !layout ? (
        <p className="text-[11.5px] text-krypt-muted">The arrangement appears here once both songs are checked: each section, what it uses, and how far each song is moved.</p>
      ) : (
        <div className={cls('space-y-2.5 transition-opacity', !plan && 'opacity-50')}>
          <div className="flex flex-wrap gap-1.5">
            {(['a', 'b'] as const).map((song) => {
              const sh = song === 'a' ? shown.shiftA : shown.shiftB;
              const text = fmtShift(sh);
              const loud = stretchAudible(sh.stretch) || Math.abs(sh.semitones) > 3;
              return (
                <span key={song} className={cls('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10.5px]', SONG_TONE[song].chip)} title={loud ? 'A big change: listen for artefacts' : undefined}>
                  <span className="font-mono font-bold">{SONG_LABEL[song]}</span>
                  <span className="text-white/80">{songRole(shown, song, shown.style === 'stemBlend' ? stems : undefined)}</span>
                  <span className="font-mono">{text || 'untouched'}</span>
                  {loud && <TriangleAlert size={10} className="text-amber-300" />}
                </span>
              );
            })}
          </div>
          <div className="relative h-[52px] overflow-hidden rounded-lg border border-white/[0.06] bg-black/30" role="list" aria-label="Sections">
            {layout.blocks.map((b) => (
              <div
                key={b.key}
                role="listitem"
                className={cls('absolute inset-y-1 flex min-w-0 flex-col justify-center overflow-hidden rounded-md border px-1.5', SONG_TONE[b.tone].block)}
                style={{ left: `calc(${b.left * 100}% + 1px)`, width: `calc(${b.width * 100}% - 2px)` }}
                title={`${b.name} · bars ${b.firstBar}–${b.firstBar + b.bars - 1} · ${b.uses}${b.shift ? ` · ${b.shift}` : ''}`}
              >
                <span className="truncate text-[10.5px] font-semibold text-white">{b.name}</span>
                <span className="truncate text-[9.5px] text-white/70">{b.uses}</span>
                {b.shift && <span className="truncate font-mono text-[8.5px] text-white/55">{b.shift}</span>}
              </div>
            ))}
          </div>
          <div className="relative h-3">
            {layout.ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2 font-mono text-[8.5px] text-krypt-muted first:translate-x-0" style={{ left: `${(t / layout.total) * 100}%` }}>
                {t + 1}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const STAGE_ICON: Record<StageState, { icon: LucideIcon; className: string }> = {
  done: { icon: Check, className: 'text-emerald-300' },
  active: { icon: Loader2, className: 'animate-spin text-krypt-purple' },
  failed: { icon: CircleX, className: 'text-rose-300' },
  stopped: { icon: Ban, className: 'text-amber-300' },
  pending: { icon: Circle, className: 'text-white/20' },
};

function ProgressView({ close }: { close: () => void }) {
  const job = useMashup();
  const states = stageStates(job.phase, job.progress?.stage ?? null);
  const fraction = barFraction(job.phase, job.progress);
  const running = job.phase === 'running' || job.phase === 'cancelling';
  const message = job.phase === 'cancelling' ? 'Cancelling…' : (job.progress?.message ?? 'Starting…');
  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-krypt-muted">
          <SongBadge song="a" />
          <span className="max-w-[40%] truncate font-semibold text-white/85">{job.form.a?.name ?? 'Song A'}</span>
          <Blend size={12} className="text-krypt-purple" />
          <SongBadge song="b" />
          <span className="max-w-[40%] truncate font-semibold text-white/85">{job.form.b?.name ?? 'Song B'}</span>
        </div>
        <ol className="space-y-1.5" aria-label="Stages">
          {STAGES.map((s, i) => {
            const st = states[i];
            const { icon: Icon, className } = STAGE_ICON[st];
            return (
              <li key={s.id} className="flex items-center gap-2.5 text-[12px]" aria-current={st === 'active' ? 'step' : undefined}>
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/30">
                  <Icon size={12} strokeWidth={2.4} className={className} />
                </span>
                <span className={cls(st === 'pending' ? 'text-white/40' : st === 'active' ? 'font-semibold text-white' : 'text-white/80')}>{s.label}</span>
              </li>
            );
          })}
        </ol>
        {running && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-white/80" title={message}>
                {message}
              </span>
              <span className="flex-shrink-0 font-mono text-krypt-muted">{percentText(fraction)}</span>
            </div>
            <ProgressBar fraction={fraction} />
          </div>
        )}
        {job.phase === 'failed' && (
          <Note icon={CircleX} tone="error">
            <div className="font-semibold">The mashup couldn't be built</div>
            <div className="mt-0.5 text-rose-100/85">{job.error}</div>
            {job.error && needsStemModel(job.error) && (
              <button type="button" className={cls(small, 'mt-2')} onClick={openModelManager}>
                <BrainCircuit size={12} /> Open Model Manager
              </button>
            )}
          </Note>
        )}
        {job.phase === 'cancelled' && (
          <Note icon={Ban} tone="warn">
            Cancelled. Your project was left as it was.
          </Note>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1 text-[10px] text-krypt-muted">{running ? 'You can close this: it keeps going, and Tools ▸ Auto Mashup shows it again.' : ''}</div>
        {running ? (
          <>
            <button type="button" className={btn} onClick={close}>
              Hide
            </button>
            <button
              type="button"
              className={cls(btn, 'border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20')}
              disabled={job.phase === 'cancelling'}
              onClick={() => void cancelBuild()}
            >
              {job.phase === 'cancelling' ? <Loader2 size={13} className="animate-spin" /> : null}
              {job.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={btn} onClick={close}>
              Close
            </button>
            <button type="button" className={primary} onClick={backToForm}>
              Back to the options
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function DoneView({ close }: { close: () => void }) {
  const o = useMashup((s) => s.outcome);
  const stems = useMashup((s) => s.form.stems);
  if (!o) return null;
  const facts = [
    { label: 'Tempo', value: `${fmtBpm(o.plan.bpm)} BPM` },
    { label: 'Key', value: o.plan.key ?? 'Not clear' },
    { label: 'Length', value: `${o.plan.bars} bars` },
    { label: 'Sections', value: String(o.plan.sections.length) },
    { label: 'Tracks', value: String(o.tracks) },
    { label: 'Fit', value: `${Math.round(o.score)} / 100` },
  ];
  const shifts = (['a', 'b'] as const)
    .map((song) => ({ song, text: fmtShift(song === 'a' ? o.plan.shiftA : o.plan.shiftB), role: songRole(o.plan, song, o.plan.style === 'stemBlend' ? stems : undefined) }))
    .filter((s) => s.text);
  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.35)]">
            <Check size={13} strokeWidth={2.6} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-white" title={o.name}>
              {o.name}
            </div>
            <div className="text-[11px] text-krypt-muted">is built and open in the Studio: an editable arrangement, one step in Edit ▸ History.</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {facts.map((f) => (
            <div key={f.label} className="rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2">
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">{f.label}</div>
              <div className="mt-0.5 truncate font-mono text-[13px] text-white" title={f.value}>
                {f.value}
              </div>
            </div>
          ))}
        </div>
        {shifts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {shifts.map((s) => (
              <span key={s.song} className={cls('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10.5px]', SONG_TONE[s.song].chip)}>
                <span className="font-mono font-bold">{SONG_LABEL[s.song]}</span>
                <span className="text-white/80">{s.role}</span>
                <span className="font-mono">{s.text}</span>
              </span>
            ))}
          </div>
        )}
        {o.notes.length > 0 && (
          <section>
            <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Good to know</h4>
            <ul className="space-y-0.5 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-3 py-2">
              {o.notes.map((n) => (
                <li key={n} className="flex items-start gap-2 text-[11.5px] text-amber-100/90">
                  <TriangleAlert size={11} className="mt-[3px] flex-shrink-0 text-amber-300" />
                  <span className="min-w-0">{n}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Note icon={History} tone="muted">
          Change anything: it's a normal project. Edit ▸ History lists the whole build as one step, so one undo removes it.
        </Note>
        <p className="flex items-start gap-1.5 text-[10px] leading-snug text-krypt-muted">
          <ShieldAlert size={11} className="mt-px flex-shrink-0" /> {o.rightsNote || MASHUP_RIGHTS_NOTE}
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
        <button type="button" className={btn} onClick={backToForm}>
          <Blend size={13} /> Make another
        </button>
        <button
          type="button"
          className={primary}
          data-autofocus
          onClick={() => {
            close();
            openStudio();
          }}
        >
          <ListMusic size={13} /> Open Studio
        </button>
      </div>
    </div>
  );
}
