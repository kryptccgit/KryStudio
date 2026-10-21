import { useState } from 'react';
import { Crosshair, X } from 'lucide-react';
import type { Collection } from '@shared/library/types';
import { DialogForm, Field, openDialog } from '../components/Dialog';
import { analysedCount, fmtCount } from './logic';

interface Spec {
  doc?: Document | null;
  collection: Collection;
  initialBrief: string;
  isCurrent: boolean;
  onSubmit: (brief: string) => Promise<boolean>;
  onClear: () => Promise<boolean>;
}

export const BRIEF_MAX = 280;

export function openFocusDialog(spec: Spec): void {
  openDialog({
    key: 'library-focus',
    title: spec.isCurrent ? 'AI focus' : `Use ${spec.collection.name} as the AI focus?`,
    subtitle: spec.isCurrent ? `Agents compose from ${spec.collection.name}` : 'Agents compose in this collection’s style',
    icon: Crosshair,
    doc: spec.doc,
    width: 460,
    render: (close) => <FocusForm spec={spec} close={close} />,
  });
}

function FocusForm({ spec, close }: { spec: Spec; close: () => void }) {
  const [brief, setBrief] = useState(spec.initialBrief);
  const [busy, setBusy] = useState(false);
  const analysed = analysedCount(spec.collection);
  const submit = async (): Promise<void> => {
    setBusy(true);
    const ok = await spec.onSubmit(brief.slice(0, BRIEF_MAX));
    setBusy(false);
    if (ok) close();
  };
  const clear = async (): Promise<void> => {
    setBusy(true);
    const ok = await spec.onClear();
    setBusy(false);
    if (ok) close();
  };
  return (
    <DialogForm
      onSubmit={() => void submit()}
      onCancel={close}
      submitLabel={spec.isCurrent ? 'Update focus' : 'Set focus'}
      busy={busy}
      extra={
        spec.isCurrent ? (
          <button type="button" onClick={() => void clear()} className="flex items-center gap-1 text-[11px] font-semibold text-rose-200/90 hover:text-rose-100">
            <X className="h-3 w-3" /> Clear focus
          </button>
        ) : undefined
      }
    >
      <div className="text-[11px] leading-snug text-white/75">
        Agents (the built-in chat and MCP clients) read this collection’s style profile: tempo and feel, drum patterns, bass, harmony, structure and mix targets
        {analysed ? ` from ${fmtCount(analysed)} analysed track${analysed === 1 ? '' : 's'}` : ''}. They compose original material from those statistics, never copy a
        song; the originality check flags lines that land too close.
      </div>
      {analysed < 10 && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11px] text-amber-100/90">
          Only {fmtCount(analysed)} track{analysed === 1 ? ' is' : 's are'} analysed so far, so the profile is thin. It fills in as the queue runs.
        </div>
      )}
      <Field label="Brief" hint="Optional. Your own words, added to what agents read." wide>
        <textarea
          data-autofocus
          value={brief}
          maxLength={BRIEF_MAX}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="dark, sparse, lots of space"
          className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
        />
        <div className="mt-0.5 text-right font-mono text-[9px] text-krypt-muted/70">
          {brief.length}/{BRIEF_MAX}
        </div>
      </Field>
    </DialogForm>
  );
}
