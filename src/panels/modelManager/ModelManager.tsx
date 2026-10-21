// ──────────────────────────────────────────────────────────────────────
// Model Manager: the on-device audio ML models (stems, transcription, beat
// tracking). Each model shows what it does, its size and speed, its licence
// (+ link) and any licence notice, and its state: installed / available /
// downloading (progress + cancel) / verifying / failed / unavailable. The
// header says whether the analyzer runs, on which devices, and where the
// models live.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, type ReactNode } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  Cpu,
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  Gpu,
  Loader2,
  Package,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type { ModelState } from '@shared/types';
import { Badge } from '../../components/common';
import { cls, fmtBytes } from '../../utils/format';
import { groupModels, modelBytes, stemLabel } from '../../ears/logic';
import { ProgressBar } from '../../ears/ProgressBar';
import { analyzerMissingMessage, cancelInstall, importModel, installModel, openLicence, refreshAnalyzer, removeModel, showModelsFolder, useAnalyzer } from './store';

function Group({ title, blurb, children }: { title: string; blurb?: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h2>
        {blurb && <span className="truncate text-[10px] text-krypt-muted/70">{blurb}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function SmallButton({
  onClick,
  disabled,
  children,
  hint,
  tone = 'ghost',
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  hint?: string;
  tone?: 'ghost' | 'primary' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-hint={hint}
      className={cls(
        'flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'primary'
          ? 'border-transparent bg-krypt-gradient text-white shadow-krypt-glow hover:brightness-110 disabled:shadow-none'
          : tone === 'danger'
            ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
            : 'border-white/10 bg-white/[0.04] text-white/90 hover:border-white/20 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

const STATUS_BADGE: Record<ModelState['status'], { tone: 'success' | 'warn' | 'danger' | 'neutral' | 'gradient'; label: string }> = {
  installed: { tone: 'success', label: 'Installed' },
  available: { tone: 'neutral', label: 'Not installed' },
  downloading: { tone: 'gradient', label: 'Downloading' },
  verifying: { tone: 'gradient', label: 'Verifying' },
  failed: { tone: 'danger', label: 'Failed' },
  unavailable: { tone: 'warn', label: 'Unavailable' },
};

function ModelCard({ m, busy, available }: { m: ModelState; busy?: string; available: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const d = m.def;
  const size = modelBytes(d);
  const doc = () => ref.current?.ownerDocument ?? document;
  const badge = STATUS_BADGE[m.status] ?? STATUS_BADGE.available;
  const received = m.progress?.received ?? 0;
  const total = m.progress?.total ?? 0;
  const fraction = m.status === 'downloading' && total > 0 ? received / total : -1;
  const meta = [size ? fmtBytes(size) : d.bundled ? null : 'Size not published yet', d.speed ?? null, d.stems?.length ? d.stems.map(stemLabel).join(' · ') : null].filter(Boolean);

  return (
    <div ref={ref} className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-white">{d.name}</span>
            {d.default && <Badge tone="gradient">Default</Badge>}
            {d.bundled && <Badge>Built in</Badge>}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-white/70">{d.description}</div>
          {meta.length > 0 && <div className="mt-1 text-[10px] text-krypt-muted">{meta.join(' · ')}</div>}
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      {d.license.notice && m.status !== 'installed' && (
        <div className="mt-2 flex gap-2 rounded-lg border border-amber-400/30 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11px] leading-snug text-amber-100/90">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />
          <span>{d.license.notice}</span>
        </div>
      )}

      {m.status === 'downloading' && (
        <div className="mt-2">
          <ProgressBar fraction={fraction} />
          <div className="mt-1 flex justify-between font-mono text-[10px] text-krypt-muted">
            <span>{total > 0 ? `${fmtBytes(received)} of ${fmtBytes(total)}` : `${fmtBytes(received)}`}</span>
            <span>{fraction >= 0 ? `${Math.round(fraction * 100)}%` : ''}</span>
          </div>
        </div>
      )}
      {m.status === 'verifying' && (
        <div className="mt-2">
          <ProgressBar fraction={-1} />
          <div className="mt-1 text-[10px] text-krypt-muted">Checking every file against its SHA-256…</div>
        </div>
      )}
      {(m.status === 'failed' || m.status === 'unavailable') && m.message && (
        <div className={cls('mt-2 flex gap-2 text-[11px] leading-snug', m.status === 'failed' ? 'text-rose-200' : 'text-krypt-muted')}>
          <AlertTriangle className={cls('mt-0.5 h-3.5 w-3.5 flex-shrink-0', m.status === 'failed' ? 'text-rose-300' : 'text-amber-300/80')} />
          <span>{m.message}</span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => void openLicence(d.license.url)}
          className="mr-auto flex items-center gap-1 text-[10px] text-krypt-muted transition hover:text-white"
          data-hint={`Open the licence: ${d.license.url}`}
        >
          <ExternalLink className="h-3 w-3" /> Licence: <span className="font-semibold text-white/80">{d.license.name}</span>
        </button>

        {m.status === 'installed' && (
          <>
            {m.dir && (
              <SmallButton onClick={() => void showModelsFolder(m.dir!)} hint={m.dir}>
                <FolderOpen className="h-3.5 w-3.5" /> Show files
              </SmallButton>
            )}
            {!d.bundled && (
              <SmallButton onClick={() => void removeModel(d)} disabled={!!busy} tone="danger" hint="Delete this model's files">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Remove
              </SmallButton>
            )}
          </>
        )}

        {m.status === 'downloading' && (
          <SmallButton onClick={() => void cancelInstall(d)} hint="Stop the download (nothing is kept)">
            <X className="h-3.5 w-3.5" /> Cancel
          </SmallButton>
        )}

        {(m.status === 'available' || m.status === 'failed' || m.status === 'unavailable') && (
          <>
            <SmallButton
              onClick={() => void importModel(d, doc())}
              disabled={!!busy}
              hint="Install from a folder that already holds this model's files (offline install). Every file is checked."
            >
              <FolderInput className="h-3.5 w-3.5" /> Install from folder…
            </SmallButton>
            {m.status !== 'unavailable' && (
              <SmallButton
                onClick={() => void installModel(d, doc())}
                disabled={!!busy || !available}
                tone="primary"
                hint={available ? 'Download, verify and install (shows the licence first)' : 'The analyzer is missing, so models can’t be installed'}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : m.status === 'failed' ? (
                  <RotateCcw className="h-3.5 w-3.5" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {m.status === 'failed' ? 'Try again' : 'Install'}
                {m.status === 'available' && size ? <span className="font-normal opacity-80">{fmtBytes(size)}</span> : null}
              </SmallButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Chip({ on, icon: Icon, children, hint }: { on: boolean; icon: typeof Cpu; children: ReactNode; hint?: string }) {
  return (
    <span
      data-hint={hint}
      className={cls(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[10px] font-semibold',
        on ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' : 'border-white/10 bg-white/[0.03] text-krypt-muted',
      )}
    >
      <Icon className="h-3 w-3" />
      {children}
    </span>
  );
}

export function ModelManager() {
  const s = useAnalyzer((x) => x.state);
  const busy = useAnalyzer((x) => x.busy);

  // Fresh state whenever the panel opens.
  useEffect(() => {
    void refreshAnalyzer();
  }, []);

  if (!s)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-krypt-muted">
        {window.krypt?.analyzer ? <Loader2 className="h-4 w-4 animate-spin" /> : 'This build has no analyzer bridge, so on-device models are unavailable. Update Krypt Studio.'}
      </div>
    );

  const groups = groupModels(s.models);
  const installedCount = s.models.filter((m) => m.status === 'installed').length;
  const devicesKnown = s.devices.length > 0;
  const gpu = s.devices.includes('directml');

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
            <BrainCircuit className="h-4 w-4 text-krypt-purple" />
            {installedCount} of {s.models.length} model{s.models.length === 1 ? '' : 's'} installed
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-krypt-muted">
            Stems, transcription and beat tracking run on this PC in a separate analyzer process. Nothing is uploaded, and a crash there never stops playback.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip
            on={s.available}
            icon={Package}
            hint={s.available ? (s.running ? `Analyzer running${s.pid ? ` (pid ${s.pid})` : ''}` : 'The analyzer starts on first use') : analyzerMissingMessage()}
          >
            {s.available ? (s.running ? `Analyzer ${s.version ? `v${s.version}` : 'running'}` : 'Analyzer ready') : 'Analyzer missing'}
          </Chip>
          <Chip on={devicesKnown} icon={Cpu} hint={devicesKnown ? 'Runs on the CPU' : 'Devices are detected the first time the analyzer runs'}>
            CPU
          </Chip>
          <Chip
            on={gpu}
            icon={Gpu}
            hint={gpu ? 'DirectML: big models run on your DirectX 12 GPU' : devicesKnown ? 'No DirectX 12 GPU found: big models run on the CPU (slower)' : 'Devices are detected the first time the analyzer runs'}
          >
            {gpu ? 'GPU (DirectML)' : devicesKnown ? 'No GPU' : 'GPU ?'}
          </Chip>
        </div>
      </div>

      {!s.available && <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{analyzerMissingMessage()}</div>}

      {groups.map((g) => (
        <Group key={g.task} title={g.title} blurb={g.blurb}>
          {g.models.map((m) => (
            <ModelCard key={m.def.id} m={m} busy={busy[m.def.id]} available={s.available} />
          ))}
        </Group>
      ))}
      {!groups.length && <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-krypt-muted">No models in the catalog.</div>}

      <Group title="Models folder">
        <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5">
          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-white/85" title={s.modelsDir}>
            {s.modelsDir || 'Not set'}
          </span>
          {s.modelsDir && (
            <SmallButton onClick={() => void showModelsFolder(s.modelsDir)} hint="Open the models folder in Explorer">
              Open
            </SmallButton>
          )}
        </div>
        <div className="text-[10px] leading-snug text-krypt-muted/80">
          Downloads are checked file by file against their SHA-256 before first use. Built-in models ship with the app and can’t be removed.
        </div>
      </Group>
    </div>
  );
}
