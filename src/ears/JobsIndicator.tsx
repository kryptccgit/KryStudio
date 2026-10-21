import { useMemo, useRef } from 'react';
import { AudioWaveform, BrainCircuit, Download, Layers, Loader2, MicVocal, Piano, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { openMenuAt, toggleMenuAt } from '../components/Menu';
import { useAnalyzer } from '../panels/modelManager/store';
import { cls } from '../utils/format';
import { ProgressBar } from './ProgressBar';
import { analyzerActivity, fmtFraction, type Activity } from './logic';
import { cancelAnalyzerJob, jobsHint, openModelManager } from './actions';

const KIND_ICON = { analyze: AudioWaveform, separate: Layers, transcribe: Piano, fingerprint: AudioWaveform, tts: MicVocal, sing: MicVocal, syllables: AudioWaveform, extract: Piano, download: Download } as const;

function useActivity(): Activity[] {
  const [jobs, models] = useAnalyzer(useShallow((s) => [s.state?.jobs, s.state?.models] as const));
  return useMemo(() => analyzerActivity({ jobs: jobs ?? [], models: models ?? [] }), [jobs, models]);
}

function JobRow({ a }: { a: Activity }) {
  const Icon = KIND_ICON[a.kind] ?? Loader2;
  const stage = a.stage ? a.stage.charAt(0).toUpperCase() + a.stage.slice(1) : '';
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-white/90" title={a.label}>
          {a.label}
        </span>
        <button
          type="button"
          onClick={() => void cancelAnalyzerJob(a)}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-krypt-muted transition hover:bg-rose-500/15 hover:text-rose-200"
          aria-label={`Cancel ${a.label}`}
          data-hint={a.kind === 'download' ? 'Cancel the download' : 'Cancel this job'}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ProgressBar fraction={a.fraction} className="mt-1.5" />
      <div className="mt-1 flex justify-between font-mono text-[9px] text-krypt-muted">
        <span>{stage}</span>
        <span>{fmtFraction(a.fraction)}</span>
      </div>
    </div>
  );
}

function JobsPopover({ close }: { close: () => void }) {
  const list = useActivity();
  return (
    <div className="w-[320px] max-w-[90vw]">
      <div className="flex items-center justify-between px-3 pb-1 pt-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted/80">Analyzer</span>
        <button
          type="button"
          onClick={() => {
            close();
            openModelManager();
          }}
          className="flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white"
        >
          <BrainCircuit className="h-3 w-3" /> Model Manager
        </button>
      </div>
      {list.length ? (
        <div className="divide-y divide-white/[0.06]">
          {list.map((a) => (
            <JobRow key={a.key} a={a} />
          ))}
        </div>
      ) : (
        <div className="px-3 py-3 text-[11px] text-krypt-muted">Nothing running.</div>
      )}
    </div>
  );
}

export function openJobsPopover(el: Element, toggle = true): void {
  const items = [{ type: 'custom' as const, render: (close: () => void) => <JobsPopover close={close} /> }];
  if (toggle) toggleMenuAt(el, items, { minWidth: 320, align: 'right' });
  else openMenuAt(el, items, { minWidth: 320, align: 'right' });
}

export function JobsIndicator() {
  const list = useActivity();
  const ref = useRef<HTMLButtonElement>(null);
  if (!list.length) return null;
  const first = list[0];
  const more = list.length - 1;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => ref.current && openJobsPopover(ref.current)}
      className={cls('flex h-5 max-w-[46vw] items-center gap-1.5 rounded-md px-1.5 text-white/80 transition hover:bg-white/[0.06] hover:text-white')}
      data-hint={jobsHint(list.length)}
    >
      <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-krypt-purple" />
      <span className="hidden min-w-0 truncate sm:inline">{first.label}</span>
      <span className="w-16 flex-shrink-0">
        <ProgressBar fraction={first.fraction} className="h-1" />
      </span>
      {first.fraction >= 0 && <span className="font-mono">{fmtFraction(first.fraction)}</span>}
      {more > 0 && <span className="flex-shrink-0 rounded-full bg-white/10 px-1.5 font-mono text-[9px]">+{more}</span>}
    </button>
  );
}
