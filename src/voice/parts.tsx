// Krypt Voice building blocks shared by the Krypt Voice dialog, Sing my notes, Settings ▸ Voice and Record my voice:
// the Cloud / On your PC badges, the grouped voice picker with its empty states, the compact voice select, notes,
// and the stage list with progress + Cancel.

import type { ReactNode } from 'react';
import { Ban, BrainCircuit, Check, Circle, CircleX, Cloud, Cpu, ExternalLink, KeyRound, Loader2, Mic, UserRound, type LucideIcon } from 'lucide-react';
import type { VoiceInfo, VoiceState } from '@shared/voice/types';
import { ProgressBar } from '../ears/ProgressBar';
import { cls } from '../utils/format';
import { CLOUD_NOTE, GROUP_LABEL, barFraction, groupVoices, percentText, stageStates, stagesFor, type StageState, type VoiceGroup } from './logic';
import type { VoiceJob } from './store';
import { openFishSite, openModelManager, openVoiceSettings } from './actions';

export const btn =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3.5 text-[12px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-40';
export const small =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] font-semibold text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40';
export const primary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-krypt-gradient px-4 text-[12px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none';
export const danger = 'border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20';

export function CloudBadge({ className }: { className?: string }) {
  return (
    <span
      className={cls('inline-flex h-[18px] items-center gap-1 rounded-full border border-sky-400/40 bg-sky-500/15 px-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-sky-200', className)}
      title={CLOUD_NOTE}
    >
      <Cloud size={10} strokeWidth={2.4} /> Cloud
    </span>
  );
}

export function LocalBadge({ className }: { className?: string }) {
  return (
    <span className={cls('inline-flex h-[18px] items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-emerald-200', className)}>
      <Cpu size={10} strokeWidth={2.4} /> On your PC
    </span>
  );
}

export function Note({ icon: Icon, tone, children }: { icon: LucideIcon; tone: 'muted' | 'warn' | 'ok' | 'error' | 'cloud'; children: ReactNode }) {
  return (
    <div
      className={cls(
        'flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-snug',
        tone === 'warn' && 'border-amber-400/25 bg-amber-500/[0.07] text-amber-100/90',
        tone === 'ok' && 'border-emerald-400/20 bg-emerald-500/[0.06] text-emerald-100/90',
        tone === 'error' && 'border-rose-400/30 bg-rose-500/10 text-rose-100',
        tone === 'cloud' && 'border-sky-400/25 bg-sky-500/[0.07] text-sky-100/90',
        tone === 'muted' && 'border-white/[0.07] bg-black/20 text-white/75',
      )}
    >
      <Icon
        size={13}
        className={cls(
          'mt-px flex-shrink-0',
          tone === 'warn' ? 'text-amber-300' : tone === 'ok' ? 'text-emerald-300' : tone === 'error' ? 'text-rose-300' : tone === 'cloud' ? 'text-sky-300' : 'text-krypt-purple',
        )}
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

// ── Empty states ──────────────────────────────────────────────────────

export function NeedModel({ message }: { message?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-[11px] text-white/70">
      <span className="min-w-0 flex-1">{message || 'Local voices need the Kokoro model (free, Apache-2.0). Install it once and they work offline.'}</span>
      <button type="button" className={small} onClick={openModelManager}>
        <BrainCircuit size={12} /> Install in Model Manager
      </button>
    </div>
  );
}

export function NeedKey({ message }: { message?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-[11px] text-white/70">
      <span className="min-w-0 flex-1">{message || 'Cloud voices use your own Fish Audio key. Their developer tier is free for now.'}</span>
      <button type="button" className={small} onClick={() => void openFishSite()}>
        <ExternalLink size={12} /> Get a key at fish.audio
      </button>
      <button type="button" className={small} onClick={openVoiceSettings}>
        <KeyRound size={12} /> Add a free key in Settings ▸ Voice
      </button>
    </div>
  );
}

// ── The grouped voice picker ──────────────────────────────────────────

const GROUP_ICON: Record<VoiceGroup, LucideIcon> = { local: Cpu, cloud: Cloud, mine: UserRound };

function GroupHeader({ group }: { group: VoiceGroup }) {
  const Icon = GROUP_ICON[group];
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-white/[0.06] bg-krypt-panel/95 px-2.5 py-1.5 backdrop-blur">
      <Icon size={12} className={group === 'local' ? 'text-emerald-300' : 'text-sky-300'} />
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/80">{GROUP_LABEL[group]}</span>
      {group === 'local' ? <LocalBadge /> : <CloudBadge />}
      <span className="ml-auto truncate text-[9.5px] text-krypt-muted">{group === 'local' ? 'Kokoro · nothing leaves this PC' : group === 'cloud' ? 'Fish Audio · your text is sent there' : 'Your own voice, on Fish Audio'}</span>
    </div>
  );
}

function VoiceRow({ v, on, onPick, disabled }: { v: VoiceInfo; on: boolean; onPick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      disabled={disabled}
      onClick={onPick}
      className={cls(
        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40',
        on ? 'bg-krypt-purple/20 shadow-[inset_2px_0_0_0_rgba(168,85,247,0.9)]' : 'hover:bg-white/[0.04]',
      )}
    >
      <span className={cls('flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border', on ? 'border-krypt-purple bg-krypt-purple/40' : 'border-white/25')}>
        {on && <Check size={9} strokeWidth={3} className="text-white" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold text-white/90">{v.name}</span>
        <span className="block truncate text-[10px] text-krypt-muted">{v.description || v.language}</span>
      </span>
    </button>
  );
}

export function VoicePicker({ state, value, onChange, onRecord }: { state: VoiceState | null; value: string | null; onChange: (id: string) => void; onRecord?: () => void }) {
  if (!state)
    return (
      <div className="flex h-24 items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/20 text-[11px] text-krypt-muted">
        <Loader2 size={13} className="animate-spin" /> Loading the voices…
      </div>
    );
  const g = groupVoices(state.voices);
  return (
    <div role="listbox" aria-label="Voices" className="max-h-[220px] overflow-y-auto rounded-xl border border-white/10 bg-black/20">
      <GroupHeader group="local" />
      {!state.local.installed ? <NeedModel message={state.local.message} /> : g.local.length ? g.local.map((v) => <VoiceRow key={v.id} v={v} on={v.id === value} onPick={() => onChange(v.id)} disabled={false} />) : <div className="px-2.5 py-2 text-[11px] text-krypt-muted">No local voices listed.</div>}
      <GroupHeader group="cloud" />
      {!state.fish.keySet ? <NeedKey message={state.fish.message} /> : g.cloud.length ? g.cloud.map((v) => <VoiceRow key={v.id} v={v} on={v.id === value} onPick={() => onChange(v.id)} disabled={false} />) : <div className="px-2.5 py-2 text-[11px] text-krypt-muted">No Fish voices listed yet.</div>}
      <GroupHeader group="mine" />
      {g.mine.map((v) => (
        <VoiceRow key={v.id} v={v} on={v.id === value} onPick={() => onChange(v.id)} disabled={!state.fish.keySet} />
      ))}
      {!g.mine.length && (
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-[11px] text-white/70">
          <span className="min-w-0 flex-1">Clone your own voice from a 30-second recording. Only your own voice, recorded live here.</span>
          {onRecord && (
            <button type="button" className={small} onClick={onRecord} disabled={!state.fish.keySet} title={state.fish.keySet ? undefined : 'Add your Fish Audio key first'}>
              <Mic size={12} /> Record my voice…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact voice select (Sing my notes): optgroups Local / Cloud / My voice; unusable groups are disabled with the reason. */
export function VoiceSelect({ state, value, onChange, width = 230 }: { state: VoiceState | null; value: string | null; onChange: (id: string) => void; width?: number }) {
  const g = groupVoices(state?.voices ?? []);
  const groups: Array<{ key: VoiceGroup; label: string; disabled: boolean }> = [
    { key: 'local', label: state?.local.installed ? 'Local · on your PC' : 'Local · install Kokoro first', disabled: !state?.local.installed },
    { key: 'cloud', label: state?.fish.keySet ? 'Cloud · Fish Audio' : 'Cloud · add a Fish key first', disabled: !state?.fish.keySet },
    { key: 'mine', label: 'My voice · Fish Audio', disabled: !state?.fish.keySet },
  ];
  return (
    <select
      value={value ?? ''}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="h-7 cursor-pointer rounded-lg border border-white/10 bg-black/40 px-2 text-[11px] text-white/90 outline-none hover:border-white/20 focus:border-krypt-purple/60"
      style={{ width }}
      aria-label="Voice"
    >
      {!value && <option value="">Pick a voice…</option>}
      {groups.map((gr) =>
        g[gr.key].length ? (
          <optgroup key={gr.key} label={gr.label}>
            {g[gr.key].map((v) => (
              <option key={v.id} value={v.id} disabled={gr.disabled} className="bg-krypt-surface">
                {v.name}
                {v.description ? ` · ${v.description}` : ''}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  );
}

// ── Progress ──────────────────────────────────────────────────────────

const STAGE_ICON: Record<StageState, { icon: LucideIcon; className: string }> = {
  pending: { icon: Circle, className: 'text-white/25' },
  active: { icon: Loader2, className: 'animate-spin text-krypt-purple' },
  done: { icon: Check, className: 'text-emerald-300' },
  failed: { icon: CircleX, className: 'text-rose-300' },
  stopped: { icon: Ban, className: 'text-amber-300' },
};

export function JobProgress({ job, onCancel }: { job: VoiceJob; onCancel: () => void }) {
  const stages = stagesFor(job.kind, job.preview);
  const states = stageStates(stages, job.phase, job.progress?.stage ?? null);
  const fraction = barFraction(job.phase, job.progress);
  const running = job.phase === 'running' || job.phase === 'cancelling';
  const message = job.phase === 'cancelling' ? 'Cancelling…' : (job.progress?.message ?? 'Starting…');
  return (
    <div className="space-y-2.5 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5" aria-live="polite">
      <ol className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Stages">
        {stages.map((s, i) => {
          const { icon: Icon, className } = STAGE_ICON[states[i]];
          return (
            <li key={s.id} className="flex items-center gap-1.5 text-[11px]" aria-current={states[i] === 'active' ? 'step' : undefined}>
              <Icon size={11} strokeWidth={2.4} className={className} />
              <span className={cls(states[i] === 'pending' ? 'text-white/40' : states[i] === 'active' ? 'font-semibold text-white' : 'text-white/75')}>{s.label}</span>
            </li>
          );
        })}
      </ol>
      {running && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-[10.5px]">
              <span className="min-w-0 flex-1 truncate text-white/75" title={message}>
                {message}
              </span>
              <span className="flex-shrink-0 font-mono text-krypt-muted">{percentText(fraction)}</span>
            </div>
            <ProgressBar fraction={fraction} />
          </div>
          <button type="button" className={cls(small, danger)} disabled={job.phase === 'cancelling'} onClick={onCancel}>
            {job.phase === 'cancelling' ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
            {job.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}
    </div>
  );
}
