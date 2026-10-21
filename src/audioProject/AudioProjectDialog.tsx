import { useEffect, useState, type ReactNode } from 'react';
import {
  AudioLines,
  Ban,
  Bot,
  BrainCircuit,
  Check,
  Circle,
  CircleX,
  ClipboardCopy,
  FileAudio,
  History,
  ListMusic,
  Loader2,
  Music2,
  ShieldAlert,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Check as CheckBox, DialogForm, Field, Segmented, openDialog } from '../components/Dialog';
import { useAnalyzer } from '../panels/modelManager/store';
import { useSettings } from '../state/status';
import { ProgressBar } from '../ears/ProgressBar';
import { cls } from '../utils/format';
import {
  ALL_PARTS,
  FACTOR_OPTIONS,
  OWNERSHIP_NOTE,
  PART_LABEL,
  STAGES,
  STEMS_NOTE,
  barFraction,
  buildOptions,
  claudeCodeReferencePrompt,
  fileName,
  optionsError,
  percentText,
  stageStates,
  stemModelState,
  summaryFacts,
  type AudioPart,
  type StageState,
  type TempoFactor,
} from './logic';
import { markOwnershipNoteShown, ownershipNoteDue, useAudioProject } from './store';
import {
  addDroppedAsSample,
  cancelConversion,
  copyClaudeCodePrompt,
  onDialogClosed,
  openAudioAsProject,
  openModelManager,
  referenceInAgentChat,
  showPlaylist,
  startConversion,
} from './actions';

const btn =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3.5 text-[12px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-40';
const primary = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-krypt-gradient px-4 text-[12px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none';

export function openAudioProjectDialog(doc?: Document | null): void {
  openDialog({
    key: 'audioProject',
    title: 'Open audio as project',
    subtitle: 'Any song becomes an editable project: drums, bass, chords and lead as patterns, vocals as audio. All on your PC.',
    icon: AudioLines,
    width: 560,
    doc,
    render: (close) => <AudioProjectView close={close} />,
    onClose: onDialogClosed,
  });
  useAudioProject.setState({ visible: true });
}

function AudioProjectView({ close }: { close: () => void }) {
  const phase = useAudioProject((s) => s.phase);
  if (phase === 'idle') return <OptionsForm close={close} />;
  if (phase === 'done') return <SummaryView close={close} />;
  return <ProgressView close={close} />;
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

function OptionsForm({ close }: { close: () => void }) {
  const path = useAudioProject((s) => s.path);
  const last = useAudioProject((s) => s.opts);
  const analyzer = useAnalyzer((s) => s.state);
  const [keepStems, setKeepStems] = useState(last?.keepStems ?? true);
  const [factor, setFactor] = useState<TempoFactor>(last?.factor ?? 1);
  const [parts, setParts] = useState<AudioPart[]>(last?.parts ? [...last.parts] : [...ALL_PARTS]);
  const [ownership] = useState(ownershipNoteDue);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ownership) markOwnershipNoteShown();
  }, [ownership]);

  const model = stemModelState(analyzer);
  const error = optionsError(parts);
  const toggle = (p: AudioPart, on: boolean): void => setParts((cur) => (on ? ALL_PARTS.filter((x) => x === p || cur.includes(x)) : cur.filter((x) => x !== p)));

  const submit = async (): Promise<void> => {
    if (error) return;
    setBusy(true);
    try {
      await startConversion(buildOptions({ keepStems, factor, parts }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogForm
      onSubmit={() => void submit()}
      onCancel={close}
      submitLabel={path ? 'Convert' : 'Choose a file…'}
      submitDisabled={!!error}
      busy={busy}
      extra={error ? <span className="text-rose-300">{error}</span> : 'Opens in a new project tab. Your current project stays open.'}
    >
      <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2.5">
        <FileAudio size={16} className="flex-shrink-0 text-krypt-purple" />
        {path ? (
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold text-white" title={path}>
              {fileName(path)}
            </div>
            <div className="truncate font-mono text-[9.5px] text-krypt-muted" title={path}>
              {path}
            </div>
          </div>
        ) : (
          <div className="text-[11.5px] text-white/80">You pick the song next: WAV, MP3, M4A, FLAC and other audio files.</div>
        )}
      </div>

      <Field label="Turn into patterns" hint="Vocals always stay audio, on a track of their own" wide>
        <div className="grid grid-cols-4 gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
          {ALL_PARTS.map((p) => (
            <CheckBox key={p} checked={parts.includes(p)} onChange={(on) => toggle(p, on)} label={PART_LABEL[p]} />
          ))}
        </div>
      </Field>

      <Field label="Tempo reading" hint="If the result feels twice too fast or too slow, convert again with another reading">
        <Segmented<TempoFactor> value={factor} options={FACTOR_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} onChange={setFactor} size="sm" />
      </Field>

      <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
        <CheckBox checked={keepStems} onChange={setKeepStems} label="Keep the stems" hint="On muted audio tracks under the patterns, lined up: unmute one to compare with what was written." />
      </div>

      {model === 'installed' && (
        <Note icon={BrainCircuit} tone="ok">
          HT-Demucs is installed: every part is read from its own stem.
        </Note>
      )}
      {model === 'missing' && (
        <Note icon={TriangleAlert} tone="warn">
          HT-Demucs isn't installed, so drums, bass and chords are read from the full mix: rougher, and there are no stems to keep.{' '}
          <button
            type="button"
            className="font-semibold text-amber-200 underline decoration-amber-300/40 underline-offset-2 hover:text-white"
            onClick={() => {
              close();
              openModelManager();
            }}
          >
            Install it in the Model Manager
          </button>
        </Note>
      )}

      {ownership && (
        <Note icon={ShieldAlert} tone="muted">
          {OWNERSHIP_NOTE}
        </Note>
      )}
    </DialogForm>
  );
}

const STAGE_ICON: Record<StageState, { icon: LucideIcon; className: string }> = {
  done: { icon: Check, className: 'text-emerald-300' },
  active: { icon: Loader2, className: 'animate-spin text-krypt-purple' },
  failed: { icon: CircleX, className: 'text-rose-300' },
  stopped: { icon: Ban, className: 'text-amber-300' },
  pending: { icon: Circle, className: 'text-white/20' },
};

function StageList({ states }: { states: StageState[] }) {
  return (
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
  );
}

function ProgressView({ close }: { close: () => void }) {
  const job = useAudioProject();
  const states = stageStates(job.phase, job.progress?.stage ?? null);
  const fraction = barFraction(job.phase, job.progress);
  const running = job.phase === 'running' || job.phase === 'cancelling';
  const message =
    job.phase === 'cancelling'
      ? 'Cancelling…'
      : (job.progress?.message ?? (job.path ? `Starting on ${fileName(job.path)}…` : 'Choose the song in the file window…'));

  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        {job.path && (
          <div className="flex items-center gap-2 text-[11.5px] text-krypt-muted">
            <FileAudio size={13} className="text-krypt-purple" />
            <span className="truncate font-semibold text-white/85" title={job.path}>
              {fileName(job.path)}
            </span>
          </div>
        )}
        <StageList states={states} />
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
            <div className="font-semibold">The conversion failed</div>
            <div className="mt-0.5 text-rose-100/85">{job.error}</div>
          </Note>
        )}
        {job.phase === 'cancelled' && (
          <Note icon={Ban} tone="warn">
            Cancelled. Your project was left as it was.
          </Note>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1 text-[10px] text-krypt-muted">{running ? 'You can close this: it keeps going, and File ▸ Open audio as project shows it again.' : ''}</div>
        {running ? (
          <>
            <button type="button" className={btn} onClick={close}>
              Hide
            </button>
            <button
              type="button"
              className={cls(btn, 'border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20')}
              disabled={job.phase === 'cancelling'}
              onClick={() => void cancelConversion()}
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
            <button type="button" className={primary} onClick={() => useAudioProject.setState({ phase: 'idle', progress: null, error: null })}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryView({ close }: { close: () => void }) {
  const o = useAudioProject((s) => s.outcome);
  if (!o) return null;
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
            <div className="text-[11px] text-krypt-muted">is now an editable project, open in the Studio.</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {summaryFacts(o).map((f) => (
            <div key={f.label} className="rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2">
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">{f.label}</div>
              <div className="mt-0.5 truncate font-mono text-[13px] text-white" title={f.value}>
                {f.value}
              </div>
            </div>
          ))}
        </div>

        {o.sounds.length > 0 && (
          <section>
            <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Matched sounds</h4>
            <ul className="space-y-0.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
              {o.sounds.map((s) => (
                <li key={s} className="flex items-start gap-2 text-[11.5px] text-white/85">
                  <Music2 size={11} className="mt-[3px] flex-shrink-0 text-krypt-purple" />
                  <span className="min-w-0">{s}</span>
                </li>
              ))}
            </ul>
          </section>
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

        {o.stemsKept && (
          <Note icon={ListMusic} tone="muted">
            {STEMS_NOTE}
          </Note>
        )}
        <Note icon={History} tone="muted">
          Change anything: it's a normal project. Save it with Ctrl+S; Edit ▸ History lists the whole build.
        </Note>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
        <button
          type="button"
          className={btn}
          onClick={() => {
            close();
            showPlaylist();
          }}
        >
          <ListMusic size={13} /> Show the Playlist
        </button>
        <button type="button" className={primary} onClick={close} data-autofocus>
          Done
        </button>
      </div>
    </div>
  );
}

export function openDropChoiceDialog(path: string, doc?: Document | null): void {
  openDialog({
    key: 'audioDrop',
    title: 'What should this song become?',
    subtitle: fileName(path),
    icon: FileAudio,
    width: 520,
    doc,
    render: (close) => <DropChoice path={path} close={close} />,
  });
}

function Choice({ icon: Icon, title, body, onClick, autoFocus }: { icon: LucideIcon; title: string; body: string; onClick: () => void; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-autofocus={autoFocus ? '' : undefined}
      className="group flex w-full items-start gap-3 rounded-xl border border-white/10 bg-black/25 p-3 text-left transition hover:border-white/20 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70"
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-krypt-purple/15 text-krypt-purple shadow-[inset_0_0_0_1px_rgba(168,85,247,0.35)]">
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-white">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-krypt-muted group-hover:text-white/75">{body}</span>
      </span>
    </button>
  );
}

function DropChoice({ path, close }: { path: string; close: () => void }) {
  const [view, setView] = useState<'choose' | 'reference'>('choose');
  if (view === 'reference') return <ReferenceChoice path={path} close={close} onBack={() => setView('choose')} />;
  return (
    <div className="space-y-2 px-4 py-3.5">
      <Choice
        icon={AudioLines}
        title="Open as project"
        body="Turn it into an editable project: drums, bass, chords and lead as patterns on matched sounds, vocals as audio."
        autoFocus
        onClick={() => {
          close();
          openAudioAsProject(path);
        }}
      />
      <Choice
        icon={Bot}
        title="Use as a reference for the AI"
        body="An agent studies it and builds an ORIGINAL song with its tempo, groove, chords and sound, never its melody or lyrics."
        onClick={() => setView('reference')}
      />
      <Choice
        icon={Music2}
        title="Add as a sample"
        body="A new sampler channel in the Channel Rack of the open project."
        onClick={() => {
          close();
          void addDroppedAsSample(path);
        }}
      />
    </div>
  );
}

function ReferenceChoice({ path, close, onBack }: { path: string; close: () => void; onBack: () => void }) {
  const hasKey = useSettings((s) => !!s.settings?.agent.hasApiKey);
  return (
    <div className="flex flex-col">
      <div className="space-y-3 px-4 py-3.5">
        <section className="rounded-xl border border-white/[0.07] bg-black/25 p-3">
          <div className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
            <Bot size={14} className="text-krypt-purple" /> The built-in agent chat
          </div>
          <p className="mt-1 text-[11px] leading-snug text-krypt-muted">
            Opens the chat and copies the request ("Make a song like" plus this file). Paste it with Ctrl+V, add what you want ("as drum and bass"), then send.
            {hasKey ? '' : ' The chat needs your own API key (Anthropic, OpenAI or OpenRouter): the panel shows where to add it.'}
          </p>
          <button
            type="button"
            className={cls(primary, 'mt-2')}
            onClick={() => {
              close();
              void referenceInAgentChat(path);
            }}
          >
            <Bot size={13} /> Open the agent chat
          </button>
        </section>
        <section className="rounded-xl border border-white/[0.07] bg-black/25 p-3">
          <div className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
            <SquareTerminal size={14} className="text-krypt-purple" /> Claude Code
          </div>
          <p className="mt-1 text-[11px] leading-snug text-krypt-muted">Its ready-made prompt, with this file filled in. Finish the sentence, then press Enter.</p>
          <code className="mt-2 block truncate rounded-lg border border-white/[0.07] bg-black/40 px-2 py-1.5 font-mono text-[10.5px] text-white/85" title={claudeCodeReferencePrompt(path)}>
            {claudeCodeReferencePrompt(path)}…
          </code>
          <button type="button" className={cls(btn, 'mt-2')} onClick={() => void copyClaudeCodePrompt(path)}>
            <ClipboardCopy size={13} /> Copy
          </button>
        </section>
        <p className="text-[10px] leading-snug text-krypt-muted">The agent follows its tempo, groove, chords, structure and sound, writes its own melody, and checks it for originality.</p>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3">
        <button type="button" className={btn} onClick={onBack}>
          Back
        </button>
        <button type="button" className={btn} onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}
