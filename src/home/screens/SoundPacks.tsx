// Home ▸ Sounds ▸ Sound packs: one card per optional pack (real recorded
// instruments from CC0 / public-domain libraries) with what it adds, its
// download size and RAM, its licence and credit (shown BEFORE the download,
// with a link), Download / Cancel / Update / Remove, progress and errors.
// Nothing downloads until the user clicks; agents only read this state.

import { useEffect, useRef } from 'react';
import { AlertTriangle, AudioLines, Download, ExternalLink, FolderOpen, HardDriveDownload, MemoryStick, Package, RefreshCw, Scale, Trash2, X } from 'lucide-react';
import type { PackEntryState } from '@shared/packs/types';
import { cls } from '../../utils/format';
import { ProgressBar } from '../../ears/ProgressBar';
import { GlassPanel, HomeButton, IconTile, PillBadge } from '../ui';
import { cancelPackDownload, installPack, openPackLink, removePack, revealPack, useEnsurePacks, usePacks } from '../../sounds/packs';
import { packActions, packMb, packPill, packProgress, packSoundsText, packsSummary, type PackAction } from '../../sounds/packsLogic';

function ActionButton({ e, action, busy, first }: { e: PackEntryState; action: PackAction; busy?: 'install' | 'remove'; first: boolean }) {
  switch (action) {
    case 'download':
    case 'retry':
      return (
        <HomeButton kind="primary" icon={Download} onClick={() => void installPack(e.id)} busy={busy === 'install'}>
          {action === 'retry' ? 'Try again' : `Download · ${packMb(e.bytes)}`}
        </HomeButton>
      );
    case 'update':
      return (
        <HomeButton kind="primary" icon={RefreshCw} onClick={() => void installPack(e.id)} busy={busy === 'install'} title="Download the new version (unchanged files are reused)">
          Update
        </HomeButton>
      );
    case 'cancel':
      return (
        <HomeButton kind="ghost" icon={X} onClick={() => void cancelPackDownload(e.id)}>
          Cancel
        </HomeButton>
      );
    case 'reveal':
      return (
        <HomeButton kind={first ? 'ghost' : 'quiet'} icon={FolderOpen} onClick={() => void revealPack(e.id)}>
          Show folder
        </HomeButton>
      );
    case 'remove':
      return (
        <HomeButton kind="quiet" icon={Trash2} onClick={() => void removePack(e.id)} busy={busy === 'remove'} title={`Delete ${e.name} from this PC (${packMb(e.bytes)})`}>
          Remove
        </HomeButton>
      );
  }
}

function PackCard({ e, busy, highlight, sounds }: { e: PackEntryState; busy?: 'install' | 'remove'; highlight: number | null; sounds: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const installed = e.status === 'installed' || e.status === 'update';
  const pill = packPill(e);
  const progress = packProgress(e);
  const actions = packActions(e);

  // "Download pack" from a preset: bring this card into view and flash its border.
  useEffect(() => {
    if (highlight === null) return;
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
    const off = setTimeout(() => usePacks.setState((s) => (s.highlight?.nonce === highlight ? { highlight: null } : s)), 2800);
    return () => {
      clearTimeout(t);
      clearTimeout(off);
    };
  }, [highlight]);

  return (
    <div
      ref={ref}
      className={cls(
        'flex flex-col rounded-xl border bg-white/[0.02] p-3.5 transition-[border-color,box-shadow] duration-500',
        highlight !== null ? 'border-krypt-purple/70 shadow-krypt-glow' : 'border-white/[0.08]',
      )}
      aria-label={`${e.name} sound pack`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13.5px] font-bold text-white">{e.name}</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-krypt-muted">{e.description}</p>
        </div>
        <PillBadge pill={pill} />
      </div>

      {e.contents.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1" aria-label="What it adds">
          {e.contents.map((c) => (
            <li key={c} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/85">
              {c}
            </li>
          ))}
        </ul>
      )}

      {sounds && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-white/85" title={installed ? 'In the Browser under Sound packs, and for agents in find_samples' : 'After the download: in the Browser under Sound packs, and for agents'}>
          <AudioLines className="h-3 w-3 flex-shrink-0 text-krypt-purple/80" aria-hidden="true" />
          <span>
            {sounds}
            {installed ? <span className="text-krypt-muted"> · in the Browser under Sound packs</span> : null}
          </span>
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-krypt-muted">
        <span className="inline-flex items-center gap-1" title="Download size">
          <HardDriveDownload className="h-3 w-3" aria-hidden="true" /> {packMb(e.bytes)} download
        </span>
        {e.ramMb > 0 && (
          <span className="inline-flex items-center gap-1" title="Memory one of its instruments uses when loaded">
            <MemoryStick className="h-3 w-3" aria-hidden="true" /> ~{Math.round(e.ramMb)} MB RAM per instrument
          </span>
        )}
      </div>

      {/* Licence + credit, always visible (before the download too). */}
      <div className="mt-2.5 rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2 text-[11px] leading-snug">
        <div className="flex items-center gap-1.5 text-white/85">
          <Scale className="h-3 w-3 flex-shrink-0 text-krypt-purple/80" aria-hidden="true" />
          <span className="font-semibold">{e.licence.name}</span>
          <button
            type="button"
            onClick={() => void openPackLink(e.licence.url)}
            className="ml-auto inline-flex flex-shrink-0 items-center gap-0.5 rounded text-[10.5px] text-krypt-purple outline-none hover:underline focus-visible:ring-1 focus-visible:ring-krypt-purple/70"
            title={e.licence.url}
          >
            Licence <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1 text-krypt-muted">
          Recorded by {e.author}. {e.licence.attribution}
        </div>
      </div>

      {progress && (
        <div className="mt-2.5" aria-live="polite">
          <ProgressBar fraction={progress.fraction} />
          <div className="mt-1 flex justify-between font-mono text-[10px] text-krypt-muted">
            <span>{progress.text}</span>
            <span>{progress.fraction >= 0 ? `${Math.round(progress.fraction * 100)}%` : ''}</span>
          </div>
        </div>
      )}

      {e.error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-rose-300" role="alert">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span>{e.error}</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {actions.map((a, i) => (
          <ActionButton key={a} e={e} action={a} busy={busy} first={i === 0} />
        ))}
      </div>
    </div>
  );
}

export function SoundPacksSection() {
  useEnsurePacks();
  const state = usePacks((s) => s.state);
  const error = usePacks((s) => s.error);
  const busy = usePacks((s) => s.busy);
  const highlight = usePacks((s) => s.highlight);
  const samples = usePacks((s) => s.samples);
  const summary = packsSummary(state);
  const packs = state?.packs ?? [];

  return (
    <GlassPanel className="mt-4 p-5" label="Sound packs">
      <div className="flex items-start gap-3">
        <IconTile icon={Package} accent />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-white">Sound packs</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-krypt-muted">
            Real recorded instruments (piano, acoustic drums, orchestra, mallets), played by the Krypt Multisampler, and recorded sound effects (foley, ambience, impacts, retro game sounds) for the Browser and transitions, from free CC0 and public-domain libraries. Optional downloads: each file is checked against its SHA-256 before it’s installed. Agents use installed packs but never download them.
          </p>
        </div>
        {summary && <PillBadge pill={summary} className="mt-0.5" />}
      </div>

      <div className="mt-4">
        {!state && !error && <p className="text-[12px] text-krypt-muted">Checking the sound packs…</p>}
        {error && !state && <p className="text-[12px] text-rose-300">Couldn’t read the sound packs: {error}</p>}
        {state && !packs.length && <p className="text-[12px] leading-relaxed text-krypt-muted">No sound packs are offered in this version of Krypt Studio yet.</p>}
        {packs.length > 0 && (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {packs.map((e) => (
              <PackCard key={e.id} e={e} busy={busy[e.id]} highlight={highlight?.id === e.id ? highlight.nonce : null} sounds={packSoundsText(samples?.packs.find((x) => x.id === e.id))} />
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
