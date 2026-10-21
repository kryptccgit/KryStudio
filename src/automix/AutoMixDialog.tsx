import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  AudioLines,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleX,
  Download,
  FileAudio,
  FolderOpen,
  Gauge,
  Headphones,
  History,
  Layers,
  Loader2,
  MicVocal,
  Play,
  RotateCcw,
  SlidersVertical,
  Sparkles,
  TriangleAlert,
  Type,
  Undo2,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AutoMixMeasure, AutoMixMode, AutoMixPreset } from '@shared/automix/types';
import { hasFiles } from '../app/fileDrop';
import { Check as CheckBox, Field, NumberBox, Segmented, openDialog } from '../components/Dialog';
import { ProgressBar } from '../ears/ProgressBar';
import { useDocStore } from '../doc/store';
import { cls } from '../utils/format';
import {
  EXAMPLE_PROMPTS,
  LUFS_MAX,
  MATCHING_NOTE,
  LUFS_MIN,
  MODES,
  MODE_LABEL,
  STAGES,
  TONE_BANDS,
  SAME_AS_ALBUM_SONG,
  SAME_AS_SONG,
  TP_MAX,
  TP_MIN,
  abNote,
  autoPresetGuess,
  barFraction,
  closenessText,
  effectiveTarget,
  fileLabel,
  fmtLufs,
  fmtNum,
  formError,
  groupChanges,
  intentChips,
  loudnessGap,
  loudnessUse,
  masterRunBlocker,
  masterStepOf,
  masterStepStates,
  masterSteps,
  measureRows,
  modeSetsLoudness,
  modeUsesVocals,
  progressDetail,
  percentText,
  presetById,
  presetHeading,
  referenceAbNote,
  referenceClash,
  resultHeadline,
  resultWhere,
  sourceLabel,
  stageStates,
  targetHint,
  tonePath,
  tonePoints,
  toneRange,
  toneX,
  understoodLine,
  type AutoMixTarget,
  type MasterStep,
  type ReferenceState,
  type Scope,
  type StageState,
} from './logic';
import { backToForm, useAutoMix } from './store';
import {
  autoMixReference,
  cancelRun,
  clearVocals,
  dropSong,
  editForm,
  exportResult,
  keepResult,
  loadPresets,
  onDialogClosed,
  onDialogOpened,
  pickSong,
  playMatchedReference,
  setAB,
  startRun,
  stopMatchedReference,
  undoResult,
} from './actions';
import { songNameFromPath } from '@shared/automix/reference';
import { ResultTransport } from './ResultTransport';
import type { ReferenceController } from './referencePick';

export const btn =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3.5 text-[12px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-40';
export const primary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-krypt-gradient px-4 text-[12px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none';

const MODE_ICON: Record<AutoMixMode, LucideIcon> = { vocals: MicVocal, mix: SlidersVertical, master: Gauge, full: Layers };

export function openAutoMixDialog(doc?: Document | null, target: AutoMixTarget = 'project'): void {
  openDialog({
    key: 'automix',
    title: target === 'file' ? 'Master a song' : 'Auto Mix',
    subtitle:
      target === 'file'
        ? 'Three steps: choose your song, pick a style, then click Master my song. It opens in a new tab, and your file is never changed.'
        : 'Pick a preset or describe the sound. Krypt measures your song, sets real knobs, measures again, and shows you before and after. One undo step.',
    icon: WandSparkles,
    width: 780,
    doc,
    render: (close) => <AutoMixView close={close} />,
    onClose: onDialogClosed,
  });
  onDialogOpened();
}

function AutoMixView({ close }: { close: () => void }) {
  const phase = useAutoMix((s) => s.phase);
  if (phase === 'done') return <DoneView close={close} />;
  if (phase !== 'idle') return <ProgressView close={close} />;
  return <FormView close={close} />;
}

export function Note({ icon: Icon, tone, children }: { icon: LucideIcon; tone: 'muted' | 'warn' | 'ok' | 'error'; children: ReactNode }) {
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

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h4 className="flex-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">{children}</h4>
      {right}
    </div>
  );
}

export function GradientDef({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stopColor="#6366F1" />
      <stop offset="50%" stopColor="#A855F7" />
      <stop offset="100%" stopColor="#EC4899" />
    </linearGradient>
  );
}

function ToneSpark({ tone, on }: { tone: AutoMixPreset['tone']; on: boolean }) {
  const id = useId().replace(/:/g, '');
  const w = 76;
  const h = 22;
  const range = Math.max(6, toneRange(tone));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="block flex-shrink-0" aria-hidden="true">
      <defs>
        <GradientDef id={id} />
      </defs>
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="rgba(255,255,255,0.12)" strokeDasharray="2 3" />
      <path d={tonePath(tone, w, h, range, 3)} fill="none" stroke={on ? `url(#${id})` : 'rgba(255,255,255,0.55)'} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export const bigPrimary = cls(primary, 'h-10 rounded-xl px-5 text-[13px]');

function FormView({ close }: { close: () => void }) {
  const target = useAutoMix((s) => s.target);
  return target === 'file' ? <MasterSongForm close={close} /> : <ProjectForm close={close} />;
}

export function StepHead({ n, title, line, right }: { n: number; title: ReactNode; line?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-start gap-2.5">
      <span className="mt-px flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-krypt-purple/50 bg-krypt-purple/15 font-mono text-[11.5px] font-semibold text-purple-100">{n}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-semibold text-white">{title}</h3>
        {line && <p className="mt-0.5 text-[11px] leading-snug text-krypt-muted">{line}</p>}
      </div>
      {right}
    </div>
  );
}

export function Fold({ open, onToggle, head, children }: { open: boolean; onToggle(): void; head: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/15">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70">
        {open ? <ChevronDown size={14} className="flex-shrink-0 text-krypt-muted" /> : <ChevronRight size={14} className="flex-shrink-0 text-krypt-muted" />}
        <div className="min-w-0 flex-1">{head}</div>
      </button>
      {open && <div className="px-3 pb-3 pt-0.5">{children}</div>}
    </div>
  );
}

function MasterSongForm({ close }: { close: () => void }) {
  const form = useAutoMix((s) => s.form);
  const song = useAutoMix((s) => s.song);
  const reference = useAutoMix((s) => s.reference);
  const showReference = useAutoMix((s) => s.showReference);
  const showMore = useAutoMix((s) => s.showMore);
  const blocker = masterRunBlocker(song, form);
  const clash = referenceClash(reference.path, [song.path]);
  const matching = reference.status === 'ready' && !clash;
  const refOpen = showReference || !!reference.path;
  return (
    <div className="flex flex-col">
      <div className="space-y-4 px-4 py-3.5">
        <section data-guide="automix.song" aria-label="Your song">
          <StepHead n={1} title="Your song" line="The finished song you want to master. Choosing it doesn't start anything yet." />
          <SongStep />
        </section>

        <section data-guide="automix.presets" aria-label="Pick a style">
          <StepHead
            n={2}
            title={matching ? presetHeading(reference) : 'Pick a style'}
            line={matching ? MATCHING_NOTE : 'A style sets how loud your song gets and its balance of bass and treble. The number on each card is its loudness in LUFS (closer to 0 is louder). Not sure? Keep Auto.'}
          />
          <PresetGrid />
        </section>

        <section data-guide="automix.reference" aria-label="Sound like a song you love">
          <Fold
            open={refOpen}
            onToggle={() => useAutoMix.setState({ showReference: !refOpen })}
            head={
              <span className="flex items-center gap-2.5">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-white/15 font-mono text-[11.5px] font-semibold text-white/70">3</span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-white/85">Sound like a song you love (optional)</span>
                  <span className="block text-[10.5px] leading-snug text-krypt-muted">A finished song you want yours to sound like. It's only measured, never copied.</span>
                </span>
              </span>
            }
          >
            <ReferenceRow state={reference} ctl={autoMixReference} issue={clash} />
          </Fold>
        </section>

        <Fold
          open={showMore}
          onToggle={() => useAutoMix.setState({ showMore: !showMore })}
          head={
            <span className="block">
              <span className="block text-[12px] font-semibold text-white/75">More options</span>
              <span className="block text-[10.5px] text-krypt-muted">Describe the sound in words, set the loudness yourself. You can skip this.</span>
            </span>
          }
        >
          <div className="space-y-3">
            <section data-guide="automix.prompt" aria-label="Describe the sound">
              <SectionTitle>Describe it (optional)</SectionTitle>
              <PromptBox />
            </section>
            <section data-guide="automix.options" aria-label="Options" className="space-y-2.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
              <Options />
            </section>
          </div>
        </Fold>
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-krypt-panel px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <div className={cls('min-w-0 flex-1 text-[11px] leading-snug', blocker ? 'font-semibold text-amber-200/90' : 'text-krypt-muted')} aria-live="polite">
            {blocker ?? 'Takes a few seconds. One undo step in the new tab.'}
          </div>
          <button type="button" className={btn} onClick={close}>
            Close
          </button>
          <button type="button" data-guide="automix.run" className={bigPrimary} disabled={!!blocker} title={blocker ?? undefined} onClick={() => void startRun()}>
            <WandSparkles size={15} />
            Master my song
          </button>
        </div>
      </div>
    </div>
  );
}

function SongStep() {
  const song = useAutoMix((s) => s.song);
  const [over, setOver] = useState(false);
  const name = song.path ? songNameFromPath(song.path) : '';
  return (
    <div
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        dropSong(e.dataTransfer);
      }}
      className={cls(
        'rounded-xl border transition',
        over ? 'border-krypt-purple/70 bg-krypt-purple/[0.12]' : song.status === 'ready' ? 'border-krypt-purple/40 bg-krypt-purple/[0.07]' : 'border-dashed border-white/15 bg-black/25',
      )}
      aria-live="polite"
    >
      {song.status === 'idle' ? (
        <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
          <button type="button" className={bigPrimary} data-autofocus onClick={() => void pickSong()}>
            <FolderOpen size={15} /> Choose your song…
          </button>
          <div className="text-[11px] text-krypt-muted">or drop the audio file here · WAV, MP3, M4A, FLAC and more</div>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-3.5 py-3">
          <span className={cls('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg', song.status === 'failed' ? 'bg-rose-500/10 text-rose-300' : 'bg-krypt-purple/15 text-purple-200')}>
            {song.status === 'busy' ? <Loader2 size={17} className="animate-spin" /> : song.status === 'failed' ? <CircleX size={17} /> : <FileAudio size={17} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-white" title={song.path ?? undefined}>
              {name}
            </div>
            {song.status === 'busy' && <div className="text-[11px] text-krypt-muted">Reading the file…</div>}
            {song.status === 'ready' && <div className="truncate font-mono text-[11px] text-purple-100/85">{song.summary}</div>}
            {song.status === 'failed' && <div className="text-[11px] leading-snug text-rose-200/90">{song.error}</div>}
          </div>
          {song.status === 'ready' && <Check size={15} className="flex-shrink-0 text-emerald-300" aria-label="Chosen" />}
          <button type="button" className={cls(btn, 'h-8')} disabled={song.status === 'busy'} onClick={() => void pickSong()}>
            {song.status === 'failed' ? 'Choose another…' : 'Change…'}
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectForm({ close }: { close: () => void }) {
  const form = useAutoMix((s) => s.form);
  const blocker = formError(form);
  const runLabel = form.mode === 'vocals' ? 'Mix the vocals' : form.mode === 'master' ? 'Auto Master' : form.mode === 'mix' ? 'Auto Mix' : 'Mix and master';

  return (
    <div className="flex flex-col">
      <div className="space-y-4 px-4 py-3.5">
        <ModeTabs />

        {form.vocalInserts && modeUsesVocals(form.mode) && (
          <div className="flex items-center gap-2 rounded-xl border border-krypt-purple/30 bg-krypt-purple/[0.08] px-3 py-1.5 text-[11.5px] text-white/85">
            <MicVocal size={13} className="flex-shrink-0 text-purple-200" />
            <span className="min-w-0 flex-1 truncate">
              Vocal: <span className="font-semibold text-white">{form.vocalLabel ?? 'the chosen track'}</span>
              <span className="text-krypt-muted"> (from the clip you right-clicked)</span>
            </span>
            <button type="button" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white" onClick={clearVocals}>
              <X size={11} /> Find the vocals myself
            </button>
          </div>
        )}

        {modeSetsLoudness(form.mode) && (
          <section data-guide="automix.reference" aria-label="Sound like a song you love">
            <SectionTitle>Sound like a song you love (optional)</SectionTitle>
            <FormReference />
          </section>
        )}

        <section data-guide="automix.presets" aria-label="Presets">
          <FormPresetHeading />
          <PresetGrid />
        </section>

        <section data-guide="automix.prompt" aria-label="Describe the sound">
          <SectionTitle>Describe it (optional)</SectionTitle>
          <PromptBox />
        </section>

        <section data-guide="automix.options" aria-label="Options" className="space-y-2.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
          <Options />
        </section>
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-krypt-panel px-4 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[10.5px] text-krypt-muted" title={blocker ?? undefined}>
            {blocker ?? 'Renders your song a few times to measure it: about as long as an export. One undo step.'}
          </div>
          <button type="button" className={btn} onClick={close}>
            Close
          </button>
          <button type="button" data-guide="automix.run" className={primary} disabled={!!blocker} onClick={() => void startRun()}>
            <WandSparkles size={13} />
            {runLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormReference() {
  const reference = useAutoMix((s) => s.reference);
  return <ReferenceRow state={reference} ctl={autoMixReference} />;
}

function FormPresetHeading() {
  const reference = useAutoMix((s) => s.reference);
  const mode = useAutoMix((s) => s.form.mode);
  const matching = modeSetsLoudness(mode) && reference.status === 'ready';
  return (
    <>
      <SectionTitle>{matching ? presetHeading(reference) : 'Preset'}</SectionTitle>
      {matching && <p className="-mt-0.5 mb-1.5 px-0.5 text-[11px] leading-snug text-krypt-muted">{MATCHING_NOTE}</p>}
    </>
  );
}

export function ReferenceRow({ state, ctl, disabled, issue }: { state: ReferenceState; ctl: ReferenceController; disabled?: boolean; issue?: string | null }) {
  const [over, setOver] = useState(false);
  const name = state.sound?.name ?? fileLabel(state.path);
  const warnError = state.error === SAME_AS_SONG || state.error === SAME_AS_ALBUM_SONG;
  return (
    <div
      onDragOver={(e) => {
        if (!hasFiles(e) || disabled) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        if (!disabled) ctl.drop(e.dataTransfer);
      }}
      className={cls(
        'flex items-center gap-2.5 rounded-xl border px-3 py-2 transition',
        over ? 'border-krypt-purple/70 bg-krypt-purple/[0.12]' : state.status === 'ready' && !issue ? 'border-krypt-purple/35 bg-krypt-purple/[0.06]' : 'border-dashed border-white/15 bg-black/25',
      )}
    >
      <AudioLines size={15} className={cls('flex-shrink-0', state.status === 'ready' && !issue ? 'text-purple-200' : 'text-white/45')} />
      <div className="min-w-0 flex-1" aria-live="polite">
        {state.status === 'idle' && (
          <>
            <div className="text-[12px] font-semibold text-white/85">A finished song you want yours to sound like</div>
            <div className="text-[10.5px] leading-snug text-krypt-muted">It's only measured, never copied. Drop it here or pick it: Krypt matches its tone, loudness and width.</div>
          </>
        )}
        {state.status === 'busy' && (
          <>
            <div className="truncate text-[12px] font-semibold text-white" title={state.path ?? undefined}>
              {name}
            </div>
            <div className="flex items-center gap-1.5 text-[10.5px] text-krypt-muted">
              <Loader2 size={11} className="animate-spin text-krypt-purple" /> Measuring its loudness and tone…
            </div>
          </>
        )}
        {state.status === 'ready' && state.sound && (
          <>
            <div className="truncate text-[12px] font-semibold text-white" title={state.path ?? undefined}>
              {state.sound.name}
            </div>
            {issue ? <div className="text-[10.5px] font-semibold leading-snug text-amber-200">{issue}</div> : <div className="truncate font-mono text-[10.5px] text-purple-100/85">{state.sound.summary}</div>}
          </>
        )}
        {state.status === 'failed' && (
          <>
            <div className="truncate text-[12px] font-semibold text-white/85" title={state.path ?? undefined}>
              {name}
            </div>
            <div className={cls('text-[10.5px] leading-snug', warnError ? 'font-semibold text-amber-200' : 'text-rose-200/90')}>{state.error}</div>
          </>
        )}
      </div>
      <button type="button" className={cls(btn, 'h-7 px-2.5 text-[11px]')} disabled={disabled} onClick={() => void ctl.pick()}>
        {state.path ? 'Change…' : 'Pick a reference song…'}
      </button>
      {state.path && (
        <button
          type="button"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          disabled={disabled}
          onClick={ctl.clear}
          aria-label="Clear the reference song"
          title="Clear the reference song"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function ModeTabs() {
  const mode = useAutoMix((s) => s.form.mode);
  const body = MODES.find((m) => m.id === mode)?.body ?? '';
  return (
    <section data-guide="automix.modes" aria-label="What to work on">
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-black/40 p-1" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => {
          const on = m.id === mode;
          const Icon = MODE_ICON[m.id];
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => editForm({ type: 'setMode', mode: m.id })}
              className={cls(
                'relative flex h-9 items-center justify-center gap-1.5 overflow-hidden rounded-lg text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70',
                on ? 'bg-krypt-purple/20 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.55)]' : 'text-white/60 hover:bg-white/5 hover:text-white',
              )}
            >
              {on && <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-krypt-gradient" />}
              <Icon size={14} className={on ? 'text-purple-200' : 'text-white/55'} />
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 px-0.5 text-[11px] leading-snug text-krypt-muted">{body}</p>
    </section>
  );
}

function PresetGrid() {
  const presets = useAutoMix((s) => s.presets);
  const picked = useAutoMix((s) => s.form.preset);
  const target = useAutoMix((s) => s.target);
  const genre = useDocStore((s) => (target === 'project' ? (s.project?.meta.genre ?? '') : ''));
  return <PresetCards presets={presets} picked={picked} genre={genre} onPick={(id) => editForm({ type: 'pickPreset', id })} onRetry={() => void loadPresets(true)} />;
}

export function PresetCards({
  presets,
  picked,
  genre,
  onPick,
  onRetry,
}: {
  presets: { status: string; list: AutoMixPreset[]; error: string | null };
  picked: string;
  genre: string;
  onPick(id: string): void;
  onRetry(): void;
}) {
  const guess = autoPresetGuess(presets.list, genre);

  const card = (on: boolean): string =>
    cls(
      'relative flex min-h-[86px] flex-col items-start gap-1 overflow-hidden rounded-xl border p-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70',
      on ? 'border-krypt-purple/60 bg-krypt-purple/[0.12]' : 'border-white/10 bg-black/25 hover:border-white/20 hover:bg-white/[0.04]',
    );

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Preset">
        <button type="button" role="radio" aria-checked={picked === 'auto'} className={card(picked === 'auto')} onClick={() => onPick('auto')}>
          {picked === 'auto' && <span className="pointer-events-none absolute inset-x-3 top-0 h-px bg-krypt-gradient" />}
          <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-white">
            <Sparkles size={13} className={picked === 'auto' ? 'text-purple-200' : 'text-white/70'} /> Auto
          </span>
          <span className="text-[10.5px] leading-snug text-krypt-muted">
            {genre.trim() && guess ? (
              <>
                From your genre ({genre.trim()}): likely <span className="text-white/80">{guess.name}</span>
              </>
            ) : (
              'Picks the best fit from what Krypt hears in the song'
            )}
          </span>
        </button>
        {presets.status === 'loading' && !presets.list.length
          ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="min-h-[86px] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.03]" aria-hidden="true" />)
          : presets.list.map((p) => {
              const on = p.id === picked;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} className={card(on)} title={p.description} onClick={() => onPick(p.id)}>
                  {on && <span className="pointer-events-none absolute inset-x-3 top-0 h-px bg-krypt-gradient" />}
                  <span className="w-full truncate text-[12.5px] font-semibold text-white">{p.name}</span>
                  <span className="font-mono text-[10px] text-krypt-muted">{fmtLufs(p.targetLufs)}</span>
                  <span className="mt-auto flex w-full items-end justify-between gap-1">
                    <ToneSpark tone={p.tone} on={on} />
                  </span>
                </button>
              );
            })}
      </div>
      {presets.status === 'failed' && (
        <Note icon={TriangleAlert} tone="warn">
          The presets didn't load ({presets.error}). Auto still works.{' '}
          <button type="button" className="font-semibold text-amber-200 underline decoration-amber-300/40 underline-offset-2 hover:text-white" onClick={onRetry}>
            Try again
          </button>
        </Note>
      )}
      {(() => {
        const p = presetById(presets.list, picked);
        return p ? <p className="px-0.5 text-[11px] leading-snug text-krypt-muted">{p.description}</p> : null;
      })()}
    </div>
  );
}

function PromptBox() {
  const prompt = useAutoMix((s) => s.form.prompt);
  const useAi = useAutoMix((s) => s.form.useAi);
  const u = useAutoMix((s) => s.understand);
  const presets = useAutoMix((s) => s.presets.list);
  const chips = intentChips(u.intent, presets);
  const fresh = u.status === 'ready' && u.text === prompt.trim();

  return (
    <div className="space-y-1.5">
      <textarea
        data-autofocus
        rows={2}
        value={prompt}
        maxLength={500}
        onChange={(e) => editForm({ type: 'set', patch: { prompt: e.target.value } })}
        placeholder="vocals on top, punchy, not harsh, loud enough for streaming"
        className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[12.5px] leading-snug text-white outline-none transition placeholder:text-krypt-muted/60 focus:border-krypt-purple/60"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-krypt-muted">Try:</span>
        {EXAMPLE_PROMPTS.map((ex) => (
          <button
            key={ex}
            type="button"
            className={cls('h-6 rounded-full border px-2.5 text-[10.5px] transition', prompt.trim() === ex ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.07] hover:text-white')}
            onClick={() => editForm({ type: 'set', patch: { prompt: ex } })}
          >
            {ex}
          </button>
        ))}
      </div>
      <div className="min-h-[22px]" aria-live="polite">
        {u.status === 'busy' && (
          <div className="flex items-center gap-1.5 text-[11px] text-krypt-muted">
            <Loader2 size={11} className="animate-spin text-krypt-purple" /> Reading your prompt…
          </div>
        )}
        {u.status === 'failed' && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-200/80">
            <TriangleAlert size={11} className="text-amber-300" /> Couldn't read it right now ({u.error}). Run reads it again.
          </div>
        )}
        {u.status === 'ready' && u.intent && (
          <div className={cls('space-y-1 transition-opacity', !fresh && 'opacity-50')}>
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-white/85">
              <span
                className={cls(
                  'inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]',
                  u.intent.source === 'ai' ? 'border-krypt-purple/40 bg-krypt-purple/15 text-purple-200' : 'border-white/10 bg-white/5 text-white/60',
                )}
                title={u.intent.source === 'ai' ? 'Read by your connected AI' : "Read by Krypt's built-in keyword reader (no AI connected, or it didn't answer in time)"}
              >
                {u.intent.source === 'ai' ? <Bot size={10} /> : <Type size={10} />}
                {sourceLabel(u.intent.source)}
              </span>
              <span className="min-w-0">{understoodLine(u.intent)}</span>
            </div>
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {chips.map((c) => (
                  <span key={c.key} className="inline-flex h-5 items-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] text-white/80">
                    {c.label}
                    {c.strength > 1 && <span className="ml-0.5 text-krypt-pink">+</span>}
                  </span>
                ))}
              </div>
            )}
            {!useAi && u.intent.source === 'ai' && <div className="text-[10px] text-krypt-muted">AI is off below, so Run reads it with keywords instead.</div>}
          </div>
        )}
        {u.status === 'idle' && <div className="text-[10.5px] text-krypt-muted">Plain words work: louder, warmer, brighter, wider, punchier, vocals up, drier, less harsh, club, streaming, −9 LUFS.</div>}
      </div>
    </div>
  );
}

const SCOPES: Array<{ value: Scope; label: string; title: string }> = [
  { value: 'loudest', label: 'Loudest part', title: 'Krypt measures the loudest 32 bars (the whole song when it is short): faster' },
  { value: 'song', label: 'Whole song', title: 'Measure everything: most accurate, slowest' },
  { value: 'bars', label: 'Bars', title: 'Measure a bar range you choose' },
];

function Options() {
  const f = useAutoMix((s) => s.form);
  const target = useAutoMix((s) => s.target);
  const presets = useAutoMix((s) => s.presets.list);
  const intent = useAutoMix((s) => (s.understand.status === 'ready' ? s.understand.intent : null));
  const reference = useAutoMix((s) => s.reference);
  const songPath = useAutoMix((s) => s.song.path);
  const genre = useDocStore((s) => (target === 'project' ? (s.project?.meta.genre ?? '') : ''));
  const loudMode = target === 'file' || modeSetsLoudness(f.mode);
  const refUsed = loudMode && reference.status === 'ready' && !(target === 'file' && referenceClash(reference.path, [songPath]));
  const t = effectiveTarget(f, presets, intent, genre, refUsed ? reference.sound : null);
  const id = useId();
  const loud = target === 'file' || modeSetsLoudness(f.mode);

  return (
    <>
      {loud ? (
        <>
          <Field label="Target loudness (LUFS)" hint={`${targetHint(t)} · ${loudnessUse(t.lufs)}`}>
            <div className="flex items-center gap-2">
              <input
                id={id}
                type="range"
                min={LUFS_MIN}
                max={LUFS_MAX}
                step={0.5}
                value={t.lufs}
                onChange={(e) => editForm({ type: 'set', patch: { targetLufs: Number(e.target.value) } })}
                className="h-1.5 w-[150px] cursor-pointer accent-krypt-purple"
                aria-label="Target loudness in LUFS"
              />
              <label htmlFor={id} className="w-[76px] text-right font-mono text-[11px] text-white/85">
                {fmtLufs(t.lufs)}
              </label>
              <button
                type="button"
                className={cls('h-6 rounded-md px-1.5 text-[10px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white', f.targetLufs == null && 'invisible')}
                onClick={() => editForm({ type: 'set', patch: { targetLufs: null } })}
                title="Back to the preset's (or the prompt's) target"
              >
                <RotateCcw size={11} />
              </button>
            </div>
          </Field>
          <Field label="Peak limit (no clipping)" hint={`Every peak stays under this, so nothing clips. −1 is safe for streaming: MP3 and AAC add a little peak${t.from === 'reference' && f.truePeak == null ? ' (the default with a reference)' : ''}`}>
            <div className="flex items-center gap-2">
              <NumberBox value={t.truePeak} min={TP_MIN} max={TP_MAX} step={0.1} suffix="dBTP" width={52} onChange={(v) => editForm({ type: 'set', patch: { truePeak: v } })} />
              <button
                type="button"
                className={cls('h-6 rounded-md px-1.5 text-[10px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white', f.truePeak == null && 'invisible')}
                onClick={() => editForm({ type: 'set', patch: { truePeak: null } })}
                title="Back to the preset's peak limit"
              >
                <RotateCcw size={11} />
              </button>
            </div>
          </Field>
        </>
      ) : (
        <div className="text-[11px] leading-snug text-krypt-muted">
          {f.mode === 'vocals'
            ? 'Vocals mode leaves the Master alone: run Master afterwards for the final loudness.'
            : 'Mix mode leaves about 6 dB of headroom on the Master for mastering: run Master (or Mix + Master) for the final loudness.'}
        </div>
      )}
      {target === 'project' && (
        <Field label="Measure" hint={f.scope === 'bars' ? 'Bars, inclusive. Pick a part with everything playing' : SCOPES.find((s) => s.value === f.scope)?.title}>
          <div className="flex items-center gap-2">
            <Segmented<Scope> value={f.scope} size="sm" options={SCOPES} onChange={(scope) => editForm({ type: 'set', patch: { scope } })} />
            {f.scope === 'bars' && (
              <>
                <NumberBox value={f.barsFrom} min={1} max={999} width={40} onChange={(n) => editForm({ type: 'set', patch: { barsFrom: n } })} />
                <span className="text-[10px] text-krypt-muted">to</span>
                <NumberBox value={f.barsTo} min={1} max={999} width={40} onChange={(n) => editForm({ type: 'set', patch: { barsTo: n } })} />
              </>
            )}
          </div>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-0.5">
        <CheckBox
          checked={f.keepUserFx}
          onChange={(keepUserFx) => editForm({ type: 'set', patch: { keepUserFx } })}
          label="Keep my effects"
          hint="Krypt adds and adjusts its own marked slots and never touches yours. Off: it may replace your effects too."
        />
        <CheckBox
          checked={f.useAi}
          onChange={(useAi) => editForm({ type: 'set', patch: { useAi } })}
          label="Let the connected AI read the prompt"
          hint="Off: Krypt's built-in keyword reader. The audio is always measured on your PC."
        />
      </div>
    </>
  );
}

const STAGE_ICON: Record<StageState, { icon: LucideIcon; className: string }> = {
  done: { icon: Check, className: 'text-emerald-300' },
  active: { icon: Loader2, className: 'animate-spin text-krypt-purple' },
  failed: { icon: CircleX, className: 'text-rose-300' },
  stopped: { icon: Ban, className: 'text-amber-300' },
  pending: { icon: Circle, className: 'text-white/20' },
};

export function StepList({ steps, states, detail }: { steps: ReadonlyArray<{ id: string; label: string }>; states: readonly StageState[]; detail?: string }) {
  return (
    <ol className="space-y-1.5" aria-label="Steps">
      {steps.map((s, i) => {
        const st = states[i] ?? 'pending';
        const { icon: SIcon, className } = STAGE_ICON[st];
        return (
          <li key={s.id} className="flex items-center gap-2.5 text-[12.5px]" aria-current={st === 'active' ? 'step' : undefined}>
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/30">
              <SIcon size={12} strokeWidth={2.4} className={className} />
            </span>
            <span className={cls('min-w-0 truncate', st === 'pending' ? 'text-white/40' : st === 'active' ? 'font-semibold text-white' : 'text-white/80')}>{s.label}</span>
            {st === 'active' && detail && <span className="min-w-0 truncate text-[11px] text-krypt-muted">{detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function ProgressView({ close }: { close: () => void }) {
  const job = useAutoMix();
  const file = job.target === 'file';
  const fraction = barFraction(job.phase, job.progress);
  const running = job.phase === 'running' || job.phase === 'cancelling';
  const message = job.phase === 'cancelling' ? 'Cancelling…' : (job.progress?.message ?? 'Starting…');
  const preset = job.form.preset === 'auto' ? 'Auto' : (presetById(job.presets.list, job.form.preset)?.name ?? job.form.preset);
  const refUsed = !!job.reference.path && job.reference.status !== 'failed' && (file ? !referenceClash(job.reference.path, [job.song.path]) : modeSetsLoudness(job.form.mode));
  const song = job.runSong ?? 'your song';
  const steps: ReadonlyArray<{ id: string; label: string }> = file ? masterSteps({ song, prompt: !!job.form.prompt.trim(), reference: refUsed }) : STAGES;
  const current = masterStepOf(job.progress);
  const states = file ? masterStepStates(job.phase, steps as MasterStep[], current) : stageStates(job.phase, job.progress?.stage ?? null);
  const detail = file ? progressDetail(job.progress?.message) || undefined : undefined;
  const Icon = file ? FileAudio : MODE_ICON[job.form.mode];
  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        {file ? (
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-krypt-purple/15 text-purple-200">
              {running ? <Loader2 size={15} className="animate-spin" /> : <FileAudio size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-white">
                {running ? `Mastering "${song}"…` : job.phase === 'failed' ? `Couldn't master "${song}"` : `Stopped mastering "${song}"`}
              </div>
              <div className="truncate text-[11px] text-krypt-muted">
                Style: {preset}
                {refUsed ? ` · sounding like ${job.reference.sound?.name ?? fileLabel(job.reference.path)}` : ''}
                {job.form.prompt.trim() ? ` · “${job.form.prompt.trim()}”` : ''}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-krypt-muted">
            <Icon size={13} className="text-krypt-purple" />
            <span className="font-semibold text-white/85">{`Auto ${MODE_LABEL[job.form.mode]}`}</span>
            <span>·</span>
            <span>{preset}</span>
            {refUsed && <span className="max-w-[40%] truncate text-purple-100/80">matching {job.reference.sound?.name ?? fileLabel(job.reference.path)}</span>}
            {job.form.prompt.trim() && <span className="max-w-[50%] truncate italic text-white/60">“{job.form.prompt.trim()}”</span>}
          </div>
        )}
        <StepList steps={steps} states={states} detail={detail} />
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
            <div className="font-semibold">{file ? "Mastering couldn't finish" : "Auto Mix couldn't finish"}</div>
            <div className="mt-0.5 text-rose-100/85">{job.error}</div>
          </Note>
        )}
        {job.phase === 'cancelled' && (
          <Note icon={Ban} tone="warn">
            Cancelled. {file ? 'Nothing was mastered.' : 'Your mix was left as it was.'}
          </Note>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1 text-[10.5px] text-krypt-muted">
          {running ? (file ? 'Your original file is never changed. You can hide this: it keeps going.' : 'You can close this: it keeps going, and Tools ▸ Auto Mix… shows it again.') : ''}
        </div>
        {running ? (
          <>
            <button type="button" className={btn} onClick={close}>
              Hide
            </button>
            <button
              type="button"
              className={cls(btn, 'border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20')}
              disabled={job.phase === 'cancelling'}
              onClick={() => void cancelRun()}
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
              {file ? 'Back to the steps' : 'Back to the options'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function MeasureTable({ before, after }: { before: AutoMixMeasure; after: AutoMixMeasure }) {
  const rows = measureRows(before, after);
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/30" role="table" aria-label="Before and after">
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_14px_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-2 border-b border-white/[0.06] px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-krypt-muted" role="row">
        <span role="columnheader" />
        <span role="columnheader">Before</span>
        <span />
        <span role="columnheader">After</span>
        <span role="columnheader" className="text-right">
          Change
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_14px_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 last:border-0" role="row" title={r.hint}>
          <span className="truncate text-[11.5px] font-semibold text-white/85" role="rowheader">
            {r.label}
          </span>
          <span className="truncate font-mono text-[11.5px] text-white/60" role="cell">
            {r.before}
          </span>
          <ArrowRight size={11} className="text-white/30" aria-hidden="true" />
          <span className="truncate font-mono text-[12px] font-semibold text-white" role="cell">
            {r.after}
          </span>
          <span className="truncate text-right font-mono text-[10.5px] text-krypt-muted" role="cell">
            {r.delta}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ToneOverlay({ before, after, target, targetLabel = 'Target' }: { before: AutoMixMeasure['tone']; after: AutoMixMeasure['tone']; target: AutoMixMeasure['tone'] | null; targetLabel?: string }) {
  const id = useId().replace(/:/g, '');
  const w = 340;
  const h = 120;
  const pad = 14;
  const range = toneRange(before, after, target);
  const pts = useMemo(() => tonePoints(after, w, h, range, pad), [after, range]);
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-3 text-[10px] text-krypt-muted">
        <span className="flex-1 text-[9.5px] font-semibold uppercase tracking-[0.14em]">Tone</span>
        <span className="flex items-center gap-1">
          <svg width="16" height="4" aria-hidden="true">
            <line x1="0" x2="16" y1="2" y2="2" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" strokeDasharray="3 2" />
          </svg>
          Before
        </span>
        <span className="flex items-center gap-1">
          <span className="h-[3px] w-4 rounded-full bg-krypt-gradient" />
          After
        </span>
        {target && (
          <span className="flex items-center gap-1">
            <svg width="16" height="4" aria-hidden="true">
              <line x1="0" x2="16" y1="2" y2="2" stroke="#EC4899" strokeWidth="1.5" strokeDasharray="1 2.5" strokeLinecap="round" />
            </svg>
            {targetLabel}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${w} ${h + 14}`} className="block h-auto w-full" role="img" aria-label="Tone before and after, relative to the mids">
        <defs>
          <GradientDef id={id} />
        </defs>
        {[-range, -range / 2, 0, range / 2, range].map((db) => {
          const y = h / 2 - (db / range) * (h / 2);
          return (
            <g key={db}>
              <line x1={pad} x2={w - pad} y1={y} y2={y} stroke={db === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)'} />
              {db !== 0 && Math.abs(db) === range && (
                <text x={2} y={y + (db > 0 ? 8 : -2)} fontSize="7" fill="rgba(255,255,255,0.3)" fontFamily="monospace">
                  {fmtNum(db, true, 0)}
                </text>
              )}
            </g>
          );
        })}
        {target && <path d={tonePath(target, w, h, range, pad)} fill="none" stroke="#EC4899" strokeOpacity="0.85" strokeWidth="1.5" strokeDasharray="1 3" strokeLinecap="round" />}
        <path d={tonePath(before, w, h, range, pad)} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" strokeDasharray="4 3" />
        <path d={tonePath(after, w, h, range, pad)} fill="none" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2.2" fill="#A855F7" />
        ))}
        {TONE_BANDS.map((b) => (
          <text key={b.key} x={pad + toneX(b.hz, w - 2 * pad)} y={h + 11} fontSize="8" textAnchor="middle" fill="rgba(255,255,255,0.4)">
            {b.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

function ABSwitch() {
  const o = useAutoMix((s) => s.outcome);
  const ab = useAutoMix((s) => s.ab);
  const busy = useAutoMix((s) => s.abBusy);
  const verdict = useAutoMix((s) => s.verdict);
  const refPlaying = useAutoMix((s) => s.refPlaying);
  if (!o) return null;
  const disabled = !o.entryId || verdict !== 'open' || busy;
  const gap = loudnessGap(o);
  return (
    <section data-guide="automix.ab" aria-label="Compare before and after" className="rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Headphones size={14} className="text-krypt-purple" />
          <span className="text-[12px] font-semibold text-white">Compare</span>
        </div>
        <div className="inline-flex rounded-lg border border-white/10 bg-black/40 p-0.5" role="radiogroup" aria-label="Before or after">
          {(['before', 'after'] as const).map((v) => {
            const on = ab === v && !refPlaying;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => void setAB(v)}
                className={cls(
                  'inline-flex h-7 w-[84px] items-center justify-center gap-1 rounded-md text-[11.5px] font-semibold transition disabled:cursor-not-allowed',
                  on ? (v === 'after' ? 'bg-krypt-purple/25 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.6)]' : 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]') : 'text-white/55 hover:bg-white/5 hover:text-white',
                  disabled && !on && 'opacity-40',
                )}
              >
                {busy && !on ? <Loader2 size={11} className="animate-spin" /> : null}
                {v === 'before' ? 'Before' : 'After'}
              </button>
            );
          })}
          {o.reference && (
            <button
              type="button"
              role="radio"
              aria-checked={refPlaying}
              onClick={() => void playMatchedReference()}
              title="Play the reference from its start, turned to the same loudness as your result"
              className={cls(
                'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2.5 text-[11.5px] font-semibold transition',
                refPlaying ? 'bg-krypt-pink/20 text-white shadow-[inset_0_0_0_1px_rgba(236,72,153,0.6)]' : 'text-white/55 hover:bg-white/5 hover:text-white',
              )}
            >
              <Play size={11} /> Reference
            </button>
          )}
        </div>
        <span className="min-w-0 flex-1 text-[10.5px] text-krypt-muted">
          {!o.entryId ? 'Nothing changed, so there is nothing to compare.' : verdict === 'kept' ? 'Kept.' : verdict === 'undone' ? 'Undone: you are hearing your original mix.' : 'Press Play (or Space) and switch while it plays.'}
        </span>
      </div>
      <div className="mt-2">
        <ResultTransport range={null} refPlaying={refPlaying} onStopReference={stopMatchedReference} />
      </div>
      {o.entryId && <p className="mt-1.5 text-[11px] leading-snug text-white/75">{abNote(gap)}</p>}
      {o.reference && <p className="mt-1 text-[11px] leading-snug text-white/65">{referenceAbNote(o.after.lufs, o.reference.lufs)} Before / After stops it.</p>}
    </section>
  );
}

export function NextStep({ n, title, line, children }: { n: number; title: ReactNode; line?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-krypt-purple/50 bg-krypt-purple/15 font-mono text-[11.5px] font-semibold text-purple-100">{n}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          <div className="text-[12.5px] font-semibold text-white">{title}</div>
          {line && <div className="text-[11px] leading-snug text-krypt-muted">{line}</div>}
        </div>
        {children}
      </div>
    </li>
  );
}

export function Details({ children, summary = 'the numbers before and after, the tone chart, what changed', defaultOpen = false }: { children: ReactNode; summary?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label="Details" className="rounded-xl border border-white/[0.07] bg-black/15">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] font-semibold text-white/75 transition hover:bg-white/[0.03] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70"
      >
        {open ? <ChevronDown size={14} className="flex-shrink-0 text-krypt-muted" /> : <ChevronRight size={14} className="flex-shrink-0 text-krypt-muted" />}
        Details
        <span className="min-w-0 truncate font-normal text-krypt-muted">{summary}</span>
      </button>
      {open && <div className="space-y-3.5 px-3 pb-3 pt-0.5">{children}</div>}
    </section>
  );
}

export function GoodToKnow({ notes }: { notes: readonly string[] }) {
  if (!notes.length) return null;
  return (
    <section aria-label="Good to know">
      <ul className="max-h-[120px] space-y-0.5 overflow-y-auto rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-3 py-2">
        {notes.map((n) => (
          <li key={n} className="flex items-start gap-2 text-[11.5px] leading-snug text-amber-100/90">
            <TriangleAlert size={11} className="mt-[3px] flex-shrink-0 text-amber-300" />
            <span className="min-w-0">
              <span className="font-semibold">Good to know: </span>
              {n}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DoneView({ close }: { close: () => void }) {
  const o = useAutoMix((s) => s.outcome);
  const target = useAutoMix((s) => s.target);
  const verdict = useAutoMix((s) => s.verdict);
  const presets = useAutoMix((s) => s.presets.list);
  const song = useAutoMix((s) => s.runSong);
  if (!o) return null;
  const file = target === 'file';
  const targetTone = o.reference ? o.reference.tone : (o.targetTone ?? presetById(presets, o.preset.id)?.tone ?? null);
  const groups = groupChanges(o.changes);
  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.35)]">
            <Check size={15} strokeWidth={2.6} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-snug text-white">{resultHeadline(o, target, song)}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-krypt-muted">{resultWhere(target, song)}</div>
          </div>
        </div>

        <GoodToKnow notes={o.notes} />

        <section aria-label="What to do next">
          <SectionTitle>What to do next</SectionTitle>
          <ol className="space-y-3">
            <NextStep n={1} title="Listen: press Play, then switch Before / After" line="Switch while it plays to hear what changed.">
              <ABSwitch />
            </NextStep>
            <NextStep
              n={2}
              title="Keep it"
              line={
                verdict === 'kept'
                  ? 'Kept. It is one step in Edit ▸ History if you change your mind.'
                  : verdict === 'undone'
                    ? 'Undone: you are hearing the original again. Edit ▸ History can bring it back.'
                    : 'Like it? Click Keep. Not for you? Undo switches it off.'
              }
            >
              {verdict === 'open' && (
                <div className="flex items-center gap-2">
                  <button type="button" className={primary} data-autofocus onClick={() => void keepResult()}>
                    <Check size={13} /> Keep
                  </button>
                  <button type="button" className={btn} disabled={!o.entryId} onClick={() => void undoResult()}>
                    <Undo2 size={13} /> Undo
                  </button>
                </div>
              )}
            </NextStep>
            <NextStep n={3} title={file ? 'Export it as a file' : 'Export the song'} line="Opens the Export audio window, set up for the whole song: pick WAV or MP3, then a folder.">
              {verdict === 'open' ? (
                <button type="button" className={btn} onClick={() => void exportResult(close)}>
                  <Download size={13} /> Export…
                </button>
              ) : (
                <button type="button" className={verdict === 'kept' ? primary : btn} data-autofocus onClick={() => void exportResult(close)}>
                  <Download size={13} /> Export…
                </button>
              )}
            </NextStep>
          </ol>
        </section>

        <Details>
          <div className="text-[11px] text-krypt-muted">
            {o.reference ? `Sounding like ${o.reference.name} · ` : ''}
            Style: {o.preset.name}
            {o.intent?.summary ? ` · ${o.intent.summary}` : ''}
            {` · ${o.passes} pass${o.passes === 1 ? '' : 'es'}`}
            {o.intent ? ` · your words read by ${o.intent.source === 'ai' ? 'your AI' : 'keywords'}` : ''}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <MeasureTable before={o.before} after={o.after} />
            <ToneOverlay before={o.before.tone} after={o.after.tone} target={targetTone} targetLabel={o.reference ? 'Reference' : 'Target'} />
          </div>

          {o.reference && (
            <Note icon={AudioLines} tone={o.reference.distanceBefore - o.reference.distanceAfter >= 0.1 ? 'ok' : 'warn'}>
              <span className="font-semibold">{closenessText(o.reference, o.before)}.</span> <span className="text-white/60">Reference: {o.reference.summary}</span>
            </Note>
          )}

          <section aria-label="What changed">
            <SectionTitle>What changed</SectionTitle>
            {groups.length === 0 ? (
              <p className="text-[11.5px] text-krypt-muted">Nothing: it already met the target.</p>
            ) : (
              <div className="max-h-[180px] space-y-2 overflow-y-auto rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
                {groups.map((g) => (
                  <div key={g.where}>
                    <div className="text-[11px] font-semibold text-white/90">{g.where}</div>
                    <ul className="mt-0.5 space-y-0.5">
                      {g.items.map((it, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11.5px] leading-snug text-white/75">
                          <Check size={10} className="mt-[4px] flex-shrink-0 text-krypt-purple" />
                          <span className="min-w-0">
                            {it.device && <span className="text-white/90">{it.device}: </span>}
                            {it.what}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Note icon={History} tone="muted">
            Every knob it set is a normal setting you can change. Krypt's slots are marked, so running it again adjusts them instead of stacking new ones. The whole run is one step in Edit ▸ History.
          </Note>
        </Details>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
        {verdict !== 'open' && (
          <button type="button" className={cls(btn, 'mr-auto')} onClick={backToForm}>
            <WandSparkles size={13} /> {file ? 'Master another' : 'Run again'}
          </button>
        )}
        <button type="button" className={btn} onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}
