// The confirm step before a model is installed: licence (with a link), the
// licence notice shown prominently, size and source, and the SHA-256 promise.

import { BrainCircuit, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ModelDef } from '@shared/analyzer/models';
import { DialogForm, openDialog } from '../../components/Dialog';
import { modelBytes, modelSource, stemLabel } from '../../ears/logic';
import { fmtBytes } from '../../utils/format';
import { report } from '../../app/notify';

/** Resolves true when the user accepts. `via`: a download, or files from a folder they pick. */
export function openLicenceConfirm(def: ModelDef, via: 'download' | 'folder', doc?: Document | null): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openDialog({
      key: 'model-licence',
      title: `Install ${def.name}`,
      subtitle: via === 'download' ? 'Read the licence before downloading.' : 'Read the licence, then pick the folder that holds its files.',
      icon: BrainCircuit,
      doc,
      width: 460,
      onClose: () => done(false),
      render: (close) => (
        <DialogForm
          submitLabel={via === 'download' ? 'Accept and download' : 'Accept and choose folder…'}
          onSubmit={() => {
            done(true);
            close();
          }}
          onCancel={close}
          extra="Every file is checked against its SHA-256 before use."
        >
          <LicenceBody def={def} via={via} />
        </DialogForm>
      ),
    });
  });
}

function LicenceBody({ def, via }: { def: ModelDef; via: 'download' | 'folder' }) {
  const size = modelBytes(def);
  const host = modelSource(def);
  return (
    <div className="space-y-3 text-[12px]">
      <p className="leading-snug text-white/85">{def.description}</p>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Licence</div>
          <div className="font-semibold text-white">{def.license.name}</div>
        </div>
        <button
          type="button"
          onClick={() => void window.krypt.app.openExternal(def.license.url).then((r) => report(r))}
          className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-semibold text-white/90 transition hover:border-white/20 hover:bg-white/10"
          data-hint={def.license.url}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Read licence
        </button>
      </div>

      {def.license.notice ? (
        <div className="flex gap-2.5 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
          <div>
            <div className="text-[11px] font-semibold text-amber-200">Before you install</div>
            <div className="mt-0.5 leading-snug text-amber-100/90">{def.license.notice}</div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/[0.07] px-3 py-2 text-emerald-200">
          <ShieldCheck className="h-4 w-4 flex-shrink-0" /> No extra terms beyond the licence.
        </div>
      )}

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px]">
        {def.stems?.length ? (
          <>
            <dt className="text-krypt-muted">Splits into</dt>
            <dd className="text-white/85">{def.stems.map(stemLabel).join(', ')}</dd>
          </>
        ) : null}
        {via === 'download' && (
          <>
            <dt className="text-krypt-muted">Download</dt>
            <dd className="text-white/85">
              {size ? fmtBytes(size) : 'Size unknown'}
              {host ? ` from ${host}` : ''}
            </dd>
          </>
        )}
        {def.speed && (
          <>
            <dt className="text-krypt-muted">Speed</dt>
            <dd className="text-white/85">{def.speed}</dd>
          </>
        )}
        <dt className="text-krypt-muted">Runs</dt>
        <dd className="text-white/85">On this PC only. Your audio never leaves it.</dd>
      </dl>
    </div>
  );
}
