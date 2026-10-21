// Deep analysis confirm: what it does (stems → transcribed bass / melody
// lines), how long it takes on this PC (estimateDeep: tracks, time,
// device), and that it needs a stem model. Without one, the primary button
// opens the Model Manager instead.

import { useState, type ReactNode } from 'react';
import { BrainCircuit, Cpu, Gpu, Layers, ShieldAlert, Timer } from 'lucide-react';
import type { Collection } from '@shared/library/types';
import { DialogForm, openDialog } from '../components/Dialog';
import { cls } from '../utils/format';
import { fmtCount, fmtLongDuration } from './logic';

interface Spec {
  doc?: Document | null;
  collection: Collection;
  estimate: { tracks: number; seconds: number; device: 'cpu' | 'directml' } | null;
  estimateError: string | null;
  /** Installed stem model name, or null when none is installed. */
  stemModel: string | null;
  onOpenModelManager: () => void;
  /** Resolve true to close. */
  onConfirm: () => Promise<boolean>;
}

export function openDeepDialog(spec: Spec): void {
  openDialog({
    key: 'library-deep',
    title: `Deep-analyse ${spec.collection.name}?`,
    subtitle: 'Separates each track into stems and transcribes the bass and melody lines.',
    icon: Layers,
    doc: spec.doc,
    width: 480,
    render: (close) => <DeepForm spec={spec} close={close} />,
  });
}

function Tile({ icon: Icon, label, value, tone }: { icon: typeof Cpu; label: string; value: ReactNode; tone?: 'warn' }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={cls('mt-0.5 truncate text-[13px] font-semibold', tone === 'warn' ? 'text-amber-200' : 'text-white')}>{value}</div>
    </div>
  );
}

function DeepForm({ spec, close }: { spec: Spec; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const e = spec.estimate;
  const noModel = !spec.stemModel;
  const nothingLeft = !!e && e.tracks === 0;
  const gpu = e?.device === 'directml';
  const submit = async (): Promise<void> => {
    if (noModel) {
      close();
      spec.onOpenModelManager();
      return;
    }
    setBusy(true);
    const ok = await spec.onConfirm();
    setBusy(false);
    if (ok) close();
  };
  return (
    <DialogForm
      onSubmit={() => void submit()}
      onCancel={close}
      submitLabel={noModel ? 'Open Model Manager' : nothingLeft ? 'Turn on' : 'Start deep analysis'}
      busy={busy}
      extra={noModel ? 'Deep analysis stays off until a stem model is installed.' : 'Runs in the background. Pause any time.'}
    >
      <div className="grid grid-cols-3 gap-2">
        <Tile icon={Layers} label="Tracks" value={e ? fmtCount(e.tracks) : '–'} />
        <Tile icon={Timer} label="About" value={e ? (e.tracks ? fmtLongDuration(e.seconds) : 'Nothing left') : 'Unknown'} />
        <Tile icon={gpu ? Gpu : Cpu} label="On" value={e ? (gpu ? 'GPU (DirectML)' : 'CPU') : '–'} tone={e && !gpu ? 'warn' : undefined} />
      </div>
      {spec.estimateError && <div className="text-[11px] text-rose-200">Couldn’t estimate the time: {spec.estimateError}</div>}
      {e && !gpu && e.tracks > 50 && (
        <div className="text-[11px] leading-snug text-amber-100/90">
          No DirectX 12 GPU was found, so stems run on the CPU. That is slow for a big collection: leave it running overnight, or deep-analyse a smaller collection.
        </div>
      )}
      <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-white/75">
        <li>Unlocks the bass and melody statistics in the style profile, and the originality check against these songs.</li>
        <li>Stems are temporary: they are deleted after transcription. Only the notes are kept.</li>
        <li>Light-pass results (tempo, key, drums, chords) stay usable the whole time.</li>
      </ul>
      {noModel ? (
        <div className="flex gap-2 rounded-lg border border-amber-400/30 bg-amber-500/[0.08] px-2.5 py-2 text-[11px] leading-snug text-amber-100/90">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />
          <span>
            Deep analysis needs a stem-separation model and none is installed. Install one in the Model Manager (HT-Demucs is the usual pick), then turn deep
            analysis on again.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[10px] text-krypt-muted">
          <BrainCircuit className="h-3 w-3 text-krypt-purple" /> Stems with {spec.stemModel}
        </div>
      )}
    </DialogForm>
  );
}
