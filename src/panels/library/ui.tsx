import { forwardRef, type ReactNode } from 'react';
import { CircleCheck, Clock, FileQuestion, Layers, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { TrackStatus } from '@shared/library/types';
import { cls } from '../../utils/format';
import { statusInfo } from '../../library/logic';

export const C = {
  series: '#A855F7',
  minor: '#6366F1',
  major: '#EC4899',
  heat: '168, 85, 247',
};

export const SmallButton = forwardRef<
  HTMLButtonElement,
  {
    onClick: () => void;
    disabled?: boolean;
    children: ReactNode;
    hint?: string;
    tone?: 'ghost' | 'primary' | 'danger' | 'focus';
    icon?: LucideIcon;
    compact?: boolean;
    spinning?: boolean;
  }
>(function SmallButton({ onClick, disabled, children, hint, tone = 'ghost', icon: Icon, compact, spinning }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-hint={hint}
      aria-label={compact && typeof children === 'string' ? children : undefined}
      title={compact && typeof children === 'string' ? children : undefined}
      className={cls(
        'flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg border text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        compact ? 'w-7 justify-center px-0' : 'px-2.5',
        tone === 'primary'
          ? 'border-transparent bg-krypt-gradient text-white shadow-krypt-glow hover:brightness-110 disabled:shadow-none'
          : tone === 'danger'
            ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
            : tone === 'focus'
              ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white hover:bg-krypt-purple/25'
              : 'border-white/10 bg-white/[0.04] text-white/90 hover:border-white/20 hover:bg-white/10',
      )}
    >
      {Icon && <Icon className={cls('h-3.5 w-3.5 flex-shrink-0', spinning && 'animate-spin')} />}
      {!compact && children}
    </button>
  );
});

export function MiniSwitch({ on, onChange, label, hint, disabled, busy }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled || busy}
      onClick={() => onChange(!on)}
      data-hint={hint}
      className="flex h-7 flex-shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2 text-[11px] font-semibold text-white/85 transition hover:border-white/20 disabled:opacity-50"
    >
      <span className={cls('relative h-4 w-7 rounded-full transition', on ? 'bg-krypt-gradient shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'bg-white/15')}>
        <span className={cls('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all', on ? 'left-[14px]' : 'left-0.5', busy && 'animate-pulse')} />
      </span>
      {label}
    </button>
  );
}

const STATUS_STYLE: Record<TrackStatus, { cls: string; icon: LucideIcon | null }> = {
  pending: { cls: 'text-krypt-muted', icon: Clock },
  light: { cls: 'text-white/70', icon: CircleCheck },
  deep: { cls: 'text-purple-200', icon: Layers },
  failed: { cls: 'text-rose-300', icon: TriangleAlert },
  missing: { cls: 'text-amber-300', icon: FileQuestion },
};

export function StatusPill({ status, error }: { status: TrackStatus; error?: string }) {
  const info = statusInfo(status, error);
  const st = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  const Icon = st.icon;
  return (
    <span className={cls('inline-flex min-w-0 items-center gap-1 text-[10px] font-semibold', st.cls)} title={info.hint} data-hint={info.hint}>
      {Icon && <Icon className="h-3 w-3 flex-shrink-0" />}
      <span className="truncate">{info.label}</span>
    </span>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{children}</h2>
      {right && <div className="ml-auto flex items-center gap-1.5">{right}</div>}
    </div>
  );
}

export function Card({
  title,
  icon: Icon,
  badge,
  right,
  readout,
  children,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  badge?: ReactNode;
  right?: ReactNode;
  readout?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cls('min-w-0 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5', className)}>
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" />}
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80">{title}</h3>
        {badge}
        {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
      </div>
      {readout !== undefined && <div className="mt-0.5 min-h-[14px] truncate text-[10px] text-krypt-muted">{readout}</div>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function Estimated() {
  return (
    <span
      className="rounded-full border border-white/10 px-1.5 py-px text-[8px] font-semibold uppercase tracking-[0.14em] text-krypt-muted/80"
      data-hint="Estimated by algorithms and models from your tracks: check by ear"
    >
      estimated
    </span>
  );
}

export function Stat({ label, value, hint, sub }: { label: string; value: ReactNode; hint?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0" data-hint={hint}>
      <div className="truncate text-[9px] uppercase tracking-[0.14em] text-krypt-muted">{label}</div>
      <div className="truncate font-mono text-[13px] font-semibold text-white">{value}</div>
      {sub && <div className="truncate text-[10px] text-krypt-muted">{sub}</div>}
    </div>
  );
}

export function EmptyNote({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/10 bg-black/20 px-4 py-4 text-center">
      {Icon && <Icon className="h-4 w-4 text-krypt-muted" />}
      <div className="text-[11px] font-semibold text-white/85">{title}</div>
      {children && <div className="max-w-sm text-[10px] leading-snug text-krypt-muted">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
