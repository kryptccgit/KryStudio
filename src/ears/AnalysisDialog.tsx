import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AudioWaveform, Check, ChevronDown, Drum, Loader2, Music2, Piano, RotateCcw, TriangleAlert } from 'lucide-react';
import type { AudioAnalysis } from '@shared/analyzer/protocol';
import type { AudioTarget } from '@shared/types';
import { openDialog } from '../components/Dialog';
import { openMenuAt } from '../components/Menu';
import { useProject } from '../doc/store';
import { cls } from '../utils/format';
import { useAnalyzer } from '../panels/modelManager/store';
import { ProgressBar } from './ProgressBar';
import {
  TRANSCRIBE_MODES,
  audioClipChannelOf,
  confidenceLevel,
  fmtBpm,
  fmtDuration,
  fmtFraction,
  fmtTime,
  isEstimated,
  keyText,
  sectionBlocks,
  snapBpm,
  syncBpm,
  sparklineArea,
  sparklinePath,
  swingText,
  tempoAlternatives,
  type Confidence,
} from './logic';
import {
  audioClipCanFollowTempo,
  convertToPattern,
  followProjectTempo,
  isFollowingTempo,
  startAnalysis,
  stopFollowingTempo,
  useAnalyses,
  useAsProjectTempo,
  watchAnalysis,
} from './actions';

export function openAnalysisDialog(target: AudioTarget, doc?: Document | null, opts: { force?: boolean } = {}): void {
  const reopen = (): void => openAnalysisDialog(target);
  const key = startAnalysis(target, reopen, opts.force);
  const name = useAnalyses.getState().runs[key]?.name ?? 'audio';
  openDialog({
    key: 'analysis',
    title: 'Tempo & key',
    subtitle: name,
    icon: AudioWaveform,
    doc,
    width: 600,
    render: (close) => <AnalysisView analysisKey={key} target={target} close={close} doc={doc ?? document} />,
  });
}

function Estimated({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      className="rounded-full border border-white/10 px-1.5 py-px text-[8px] font-semibold uppercase tracking-[0.14em] text-krypt-muted/80"
      data-hint="Estimated by an algorithm or model: check it by ear"
    >
      estimated
    </span>
  );
}

const CONF_TONE: Record<Confidence, string> = {
  high: 'text-emerald-300',
  medium: 'text-amber-200',
  low: 'text-rose-300',
};

function ConfidenceMeter({ value, compact }: { value: number; compact?: boolean }) {
  const level = confidenceLevel(value);
  return (
    <span className="flex items-center gap-1.5" data-hint={`Confidence ${Math.round(value * 100)}%`}>
      <span className="flex gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cls('h-2 w-1 rounded-sm', i < (level === 'high' ? 3 : level === 'medium' ? 2 : 1) ? 'bg-krypt-purple' : 'bg-white/10')}
          />
        ))}
      </span>
      <span className={cls('whitespace-nowrap text-[10px]', CONF_TONE[level])}>{compact ? level : `${level} confidence`}</span>
    </span>
  );
}

function Tile({ label, estimated, children, footer, className }: { label: string; estimated?: boolean; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className={cls('min-w-0 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{label}</span>
        <Estimated show={!!estimated} />
      </div>
      <div className="mt-1">{children}</div>
      {footer && <div className="mt-1.5">{footer}</div>}
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="min-w-0" data-hint={hint}>
      <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted">{label}</div>
      <div className={cls('font-mono text-[13px] font-semibold', warn ? 'text-amber-200' : 'text-white')}>{value}</div>
    </div>
  );
}

const db = (v: number, unit: string, signed = false): string => (Number.isFinite(v) ? `${signed && v > 0.05 ? '+' : ''}${v.toFixed(1)} ${unit}` : '–');

function Timeline({ a }: { a: AudioAnalysis }) {
  const blocks = useMemo(() => sectionBlocks(a.sections, a.durationSec), [a]);
  const W = 520;
  const H = 44;
  const curve = a.energy?.lufs ?? [];
  const line = useMemo(() => sparklinePath(curve, W, H), [curve]);
  const area = useMemo(() => sparklineArea(curve, W, H), [curve]);
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover !== null ? blocks[hover] : null;
  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border border-white/[0.07] bg-black/30">
        <div className="absolute inset-0">
          {blocks.map((b, i) => (
            <div key={i} className="absolute inset-y-0" style={{ left: `${b.left}%`, width: `${b.width}%`, background: `${b.color}14`, borderLeft: i ? `1px solid ${b.color}55` : undefined }} />
          ))}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="relative block h-11 w-full">
          <defs>
            <linearGradient id="krypt-energy-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#A855F7" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#A855F7" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="krypt-energy-line" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#6366F1" />
              <stop offset="50%" stopColor="#A855F7" />
              <stop offset="100%" stopColor="#EC4899" />
            </linearGradient>
          </defs>
          {area && <path d={area} fill="url(#krypt-energy-fill)" />}
          {line && <path d={line} fill="none" stroke="url(#krypt-energy-line)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
        {!line && <div className="absolute inset-0 flex items-center justify-center text-[10px] text-krypt-muted">No loudness curve</div>}
      </div>
      {blocks.length > 0 ? (
        <div className="relative mt-1 h-5" onMouseLeave={() => setHover(null)}>
          {blocks.map((b, i) => (
            <div
              key={i}
              onMouseEnter={() => setHover(i)}
              className="absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-[4px] text-[10px] font-bold text-white/95"
              style={{ left: `calc(${b.left}% + 1px)`, width: `calc(${b.width}% - 2px)`, background: `${b.color}${hover === i ? 'cc' : '88'}` }}
              data-hint={`Section ${b.label}: ${fmtTime(b.startSec)} – ${fmtTime(b.endSec)} · ${db(b.lufs, 'LUFS')}`}
            >
              {b.width > 2.5 ? b.label : ''}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-krypt-muted/80">No repeated sections found (short loops usually have none).</div>
      )}
      <div className="mt-1 flex justify-between font-mono text-[9px] text-krypt-muted/70">
        <span>0:00</span>
        <span>{hovered ? `${hovered.label} · ${fmtTime(hovered.startSec)} – ${fmtTime(hovered.endSec)} · ${db(hovered.lufs, 'LUFS')}` : 'Same letter = similar material'}</span>
        <span>{fmtDuration(a.durationSec)}</span>
      </div>
    </div>
  );
}

function StereoBar({ width, correlation }: { width: number; correlation: number }) {
  const w = Math.max(0, Math.min(1, Number.isFinite(width) ? width : 0));
  return (
    <div data-hint={`Stereo width ${Math.round(w * 100)}% · correlation ${Number.isFinite(correlation) ? correlation.toFixed(2) : '?'} (1 = mono, below 0 = phase trouble)`}>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="absolute inset-y-0 rounded-full bg-krypt-gradient" style={{ left: `${50 - w * 50}%`, right: `${50 - w * 50}%` }} />
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-krypt-muted/80">
        <span>Mono</span>
        <span className={cls('font-mono', correlation < 0 ? 'text-rose-300' : 'text-white/80')}>
          {Math.round(w * 100)}% · corr {Number.isFinite(correlation) ? correlation.toFixed(2) : '?'}
        </span>
        <span>Wide</span>
      </div>
    </div>
  );
}

function Running({ startedAt, name }: { startedAt: number; name: string }) {
  const jobs = useAnalyzer((s) => s.state?.jobs);
  const job = useMemo(() => {
    const list = (jobs ?? []).filter((j) => j.kind === 'analyze').sort((a, b) => b.startedAt - a.startedAt);
    return list.find((j) => j.label.includes(name)) ?? list[0] ?? null;
  }, [jobs, name]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <div className="px-4 py-8">
      <div className="mx-auto max-w-[320px] text-center">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-krypt-purple" />
        <div className="mt-2 text-[13px] font-semibold text-white">Listening…</div>
        <div className="mt-0.5 text-[11px] text-krypt-muted">
          {job ? `${job.stage.charAt(0).toUpperCase()}${job.stage.slice(1)}${job.fraction >= 0 ? ` · ${fmtFraction(job.fraction)}` : ''}` : 'Starting the analyzer'}
          {secs >= 2 ? ` · ${secs} s` : ''}
        </div>
        <ProgressBar fraction={job?.fraction ?? -1} className="mt-3" />
        <div className="mt-3 text-[10px] text-krypt-muted/80">You can close this; a toast tells you when it's done.</div>
      </div>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">{children}</div>;
}

function Btn({ onClick, children, primary, disabled, hint, active }: { onClick: (el: HTMLButtonElement) => void; children: ReactNode; primary?: boolean; disabled?: boolean; hint?: string; active?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      data-hint={hint}
      onClick={() => ref.current && onClick(ref.current)}
      className={cls(
        'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
        primary
          ? 'bg-krypt-gradient text-white shadow-krypt-glow hover:brightness-110 disabled:shadow-none'
          : active
            ? 'border border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
            : 'border border-white/10 bg-white/5 text-white/90 hover:border-white/20 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

function AnalysisView({ analysisKey, target, close, doc }: { analysisKey: string; target: AudioTarget; close: () => void; doc: Document }) {
  const run = useAnalyses((s) => s.runs[analysisKey]);
  useEffect(() => watchAnalysis(analysisKey), [analysisKey]);
  const clipChannel = useProject((p) => audioClipChannelOf(p, target));
  const [picked, setPicked] = useState<number | null>(null);
  useProject((p) => (clipChannel ? p.channels[clipChannel]?.generator.params.tempo_sync ?? 0 : 0));
  useProject((p) => (clipChannel ? p.channels[clipChannel]?.generator.params.src_bpm ?? 0 : 0));
  const projectBpm = useProject((p) => p.transport.bpm);

  if (!run || run.status === 'running') return <Running startedAt={run && run.status === 'running' ? run.startedAt : Date.now()} name={run?.name ?? ''} />;

  if (run.status === 'error')
    return (
      <>
        <div className="flex gap-2.5 px-4 py-5">
          <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" />
          <div>
            <div className="text-[13px] font-semibold text-rose-200">Couldn't analyze {run.name}</div>
            <div className="mt-1 text-[12px] leading-snug text-white/80">{run.message}</div>
          </div>
        </div>
        <Footer>
          <Btn onClick={close}>Close</Btn>
          <Btn primary onClick={() => openAnalysisDialog(target, doc, { force: true })}>
            <RotateCcw className="h-3.5 w-3.5" /> Try again
          </Btn>
        </Footer>
      </>
    );

  const a = run.analysis;
  const alts = a.tempo ? tempoAlternatives(a.tempo) : [];
  const bpm = picked ?? a.tempo?.bpm ?? null;
  const followBpm = picked ?? (a.tempo ? syncBpm(a.tempo, projectBpm) : null);
  const canFollow = !!clipChannel && audioClipCanFollowTempo();
  const following = !!clipChannel && followBpm !== null && isFollowingTempo(clipChannel, followBpm);
  const lv = a.levels;
  const sameAsProject = bpm !== null && Math.abs(snapBpm(bpm) - projectBpm) < 0.01;

  return (
    <>
      <div className="space-y-3 px-4 py-3.5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label="Tempo"
            estimated={isEstimated(a, 'tempo')}
            className="col-span-2"
            footer={a.tempo ? <ConfidenceMeter value={a.tempo.confidence} /> : <span className="text-[10px] text-krypt-muted">No steady pulse (ambient, speech or free time)</span>}
          >
            {a.tempo && bpm !== null ? (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-2xl font-bold leading-none text-white">{fmtBpm(bpm)}</span>
                <span className="text-[11px] font-semibold text-krypt-muted">BPM</span>
                {[a.tempo.bpm, ...alts].length > 1 && (
                  <span className="flex flex-wrap items-center gap-1 text-[11px] text-krypt-muted">
                    or
                    {[a.tempo.bpm, ...alts]
                      .filter((b) => fmtBpm(b) !== fmtBpm(bpm))
                      .map((b) => (
                        <button
                          key={b}
                          type="button"
                          onClick={() => setPicked(b)}
                          className="rounded-md border border-white/10 px-1.5 py-px font-mono text-[11px] text-white/80 transition hover:border-krypt-purple/50 hover:text-white"
                          data-hint={`Half / double-time reading. Click to use ${fmtBpm(b)} BPM instead`}
                        >
                          {fmtBpm(b)}
                        </button>
                      ))}
                  </span>
                )}
              </div>
            ) : (
              <span className="font-mono text-2xl font-bold leading-none text-white/40">–</span>
            )}
          </Tile>
          <Tile label="Key" estimated={isEstimated(a, 'key')} footer={a.key ? <ConfidenceMeter value={a.key.confidence} compact /> : null}>
            <span className={cls('text-[15px] font-bold leading-tight', a.key ? 'text-white' : 'text-white/40')}>{a.key ? keyText(a.key) : 'Unclear'}</span>
          </Tile>
          <Tile label="Swing" estimated={isEstimated(a, 'swing')} footer={<span className="text-[10px] text-krypt-muted">{a.beats ? `${a.beats.beatsPerBar} beats per bar` : 'No beat grid'}</span>}>
            <span className="text-[15px] font-bold leading-tight text-white">{swingText(a.swing)}</span>
          </Tile>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Sections and energy</span>
            <Estimated show={isEstimated(a, 'sections')} />
          </div>
          <Timeline a={a} />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr,1fr]">
          <Tile label="Loudness">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Integrated" value={db(lv.lufsIntegrated, 'LUFS')} hint="Integrated loudness (EBU R128) over the whole file" />
              <Stat label="True peak" value={db(lv.truePeakDb, 'dBTP', true)} warn={lv.truePeakDb > -1} hint={lv.truePeakDb > -1 ? 'Above -1 dBTP: may clip after encoding' : 'Highest inter-sample peak'} />
              <Stat label="Range" value={db(lv.loudnessRange, 'LU')} hint="Loudness range (LRA): how much the level moves" />
            </div>
          </Tile>
          <Tile label="Stereo">
            <StereoBar width={a.stereo.width} correlation={a.stereo.correlation} />
          </Tile>
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-krypt-muted">
          <span>{fmtDuration(a.durationSec)}</span>
          <span>{(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0)} kHz</span>
          <span>{a.channels === 1 ? 'Mono' : a.channels === 2 ? 'Stereo' : `${a.channels} channels`}</span>
          {Number.isFinite(a.onsetRate) && <span>{a.onsetRate.toFixed(1)} onsets/s</span>}
          {a.sources?.length > 0 && <span className="truncate" title={a.sources.join(', ')}>By {a.sources.join(', ')}</span>}
        </div>
        {a.estimated?.length > 0 && <div className="text-[10px] text-krypt-muted/80">Estimates can be off by half or double time. Trust your ears.</div>}
      </div>

      <Footer>
        <Btn
          onClick={(el) =>
            openMenuAt(
              el,
              TRANSCRIBE_MODES.map((m) => ({
                label: m.label,
                detail: m.detail,
                icon: m.mode === 'drums' ? Drum : m.mode === 'mono' ? Music2 : Piano,
                onSelect: () => {
                  close();
                  void convertToPattern(target, m.mode);
                },
              })),
              { minWidth: 260 },
            )
          }
          hint="Transcribe this audio into a new pattern"
        >
          <Piano className="h-3.5 w-3.5" /> Convert to pattern <ChevronDown className="h-3 w-3 opacity-70" />
        </Btn>
        {clipChannel && (
          <Btn
            onClick={() => {
              if (following) void stopFollowingTempo(clipChannel);
              else if (followBpm !== null) void followProjectTempo(clipChannel, followBpm);
            }}
            disabled={!canFollow || (followBpm === null && !following)}
            active={following}
            hint={
              !canFollow
                ? "This build's Audio Clip can't time-stretch yet"
                : following
                  ? 'Following the project tempo. Click to play the clip at its recorded speed again'
                  : followBpm !== null
                    ? `Stretch the clip so ${fmtBpm(followBpm)} BPM plays at the project tempo (${fmtBpm(projectBpm)} BPM)`
                    : 'No tempo detected'
            }
          >
            {following && <Check className="h-3.5 w-3.5" />}
            {following ? 'Following project tempo' : 'Follow project tempo'}
          </Btn>
        )}
        <Btn
          primary
          disabled={bpm === null || sameAsProject}
          onClick={() => bpm !== null && void useAsProjectTempo(bpm)}
          hint={bpm === null ? 'No tempo detected' : sameAsProject ? 'The project already runs at this tempo' : `Set the project tempo to ${fmtBpm(snapBpm(bpm))} BPM (undoable)`}
        >
          {sameAsProject ? 'Project tempo matches' : `Use ${bpm !== null ? fmtBpm(snapBpm(bpm)) : ''} as project tempo`}
        </Btn>
      </Footer>
    </>
  );
}
