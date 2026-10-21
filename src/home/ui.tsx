import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, Loader2, type LucideIcon } from 'lucide-react';
import { cls } from '../utils/format';
import type { Pill, PillTone } from './logic';

export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/80 focus-visible:ring-offset-2 focus-visible:ring-offset-krypt-void';

const TONE: Record<PillTone, string> = {
  neutral: 'border-white/10 bg-white/[0.04] text-white/70',
  live: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
  accent: 'border-krypt-purple/40 bg-krypt-purple/[0.12] text-purple-200',
  warn: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
  danger: 'border-rose-400/35 bg-rose-500/10 text-rose-300',
};

export function PillBadge({ pill, className }: { pill: Pill | null; className?: string }) {
  if (!pill) return null;
  return (
    <span
      className={cls('inline-flex max-w-full items-center gap-1.5 truncate rounded-full border px-2 py-0.5 text-[10.5px] font-semibold leading-4', TONE[pill.tone], className)}
      title={pill.hint ?? pill.text}
    >
      {pill.tone === 'live' && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />}
      <span className="truncate">{pill.text}</span>
      {pill.dot && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-krypt-pink shadow-[0_0_6px_rgba(236,72,153,0.8)]" aria-label="unsaved changes" />}
    </span>
  );
}

export function IconTile({ icon: Icon, size = 'md', accent = false }: { icon: LucideIcon; size?: 'sm' | 'md'; accent?: boolean }) {
  return (
    <span
      className={cls(
        'flex flex-shrink-0 items-center justify-center rounded-xl border',
        size === 'md' ? 'h-10 w-10' : 'h-8 w-8',
        accent ? 'border-krypt-purple/40 bg-krypt-purple/[0.14] text-purple-200' : 'border-white/10 bg-white/[0.04] text-white/85',
      )}
    >
      <Icon className={size === 'md' ? 'h-[18px] w-[18px]' : 'h-4 w-4'} strokeWidth={1.75} />
    </span>
  );
}

export function GlassPanel({ children, className, as: Tag = 'section', label }: { children: ReactNode; className?: string; as?: 'section' | 'div'; label?: string }) {
  return (
    <Tag aria-label={label} className={cls('rounded-2xl border border-white/10 bg-[#0e0e17]/90 shadow-krypt-card', className)}>
      {children}
    </Tag>
  );
}

type BtnKind = 'primary' | 'ghost' | 'quiet';

export function HomeButton({
  kind = 'ghost',
  icon: Icon,
  children,
  onClick,
  disabled,
  busy,
  title,
  className,
  ariaLabel,
}: {
  kind?: BtnKind;
  icon?: LucideIcon;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-label={ariaLabel}
      className={cls(
        'inline-flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        FOCUS_RING,
        kind === 'primary' && 'bg-krypt-gradient text-white shadow-krypt-glow hover:brightness-110 active:scale-[0.98]',
        kind === 'ghost' && 'border border-white/10 bg-white/[0.05] text-white/90 hover:border-white/20 hover:bg-white/10',
        kind === 'quiet' && 'text-krypt-muted hover:bg-white/5 hover:text-white',
        className,
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}

export function ScreenHeader({ icon, title, subtitle, onBack, backLabel = 'Home', right }: { icon: LucideIcon; title: string; subtitle: string; onBack: () => void; backLabel?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <button
        type="button"
        onClick={onBack}
        className={cls('mt-1 inline-flex h-8 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 text-[12px] font-semibold text-white/80 transition hover:border-white/20 hover:text-white', FOCUS_RING)}
        aria-label={`Back to ${backLabel} (Esc)`}
        title="Back (Esc)"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IconTile icon={icon} accent />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
          <p className="text-[13px] text-krypt-muted">{subtitle}</p>
        </div>
      </div>
      {right}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cls('text-[10.5px] font-semibold uppercase tracking-[0.18em] text-krypt-muted', className)}>{children}</h2>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[10.5px] text-white/80">{children}</kbd>;
}

export function ScreenFrame({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} tabIndex={-1} aria-label={label} className="h-full overflow-y-auto outline-none">
      <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-8 sm:px-8">{children}</div>
    </div>
  );
}
