import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cls } from '../utils/format';

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-8 pt-7 pb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-krypt-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="flex-1 overflow-auto px-8 pb-8">{children}</div>
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      {(title || actions) && (
        <div className="flex items-end justify-between gap-2 mb-3">
          <div>
            {title && (
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h2>
            )}
            {description && <p className="text-xs text-krypt-muted/80 mt-1">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({
  className,
  children,
  hoverable,
  padded = true,
}: {
  className?: string;
  children: ReactNode;
  hoverable?: boolean;
  padded?: boolean;
}) {
  return (
    <div
      className={cls(
        'rounded-2xl border border-white/10 bg-krypt-panel/80 backdrop-blur-sm shadow-krypt-card',
        padded && 'p-5',
        hoverable && 'transition hover:border-white/20 hover:shadow-krypt-glow',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
  className,
  type = 'button',
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-krypt-glow bg-krypt-gradient transition',
        'hover:brightness-110 active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:brightness-75',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  onClick,
  disabled,
  children,
  className,
  destructive,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition',
        destructive
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
          : 'border-white/10 bg-white/5 text-white/90 hover:bg-white/10 hover:border-white/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  onClick,
  title,
  children,
  active,
  destructive,
  disabled,
}: {
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  active?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cls(
        'h-9 w-9 rounded-lg border flex items-center justify-center transition',
        active
          ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white shadow-krypt-glow'
          : destructive
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100'
            : 'border-white/10 bg-white/5 text-krypt-muted hover:bg-white/10 hover:text-white hover:border-white/20',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cls(
        'flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-black/20 px-4 py-3 cursor-pointer transition',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5 hover:border-white/20',
      )}
    >
      <div>
        <div className="text-sm font-semibold text-white">{label}</div>
        {description && <div className="text-xs text-krypt-muted mt-1">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
        className={cls(
          'relative h-6 w-11 rounded-full transition flex-shrink-0 mt-0.5',
          checked ? 'bg-krypt-gradient shadow-[0_0_10px_rgba(168,85,247,0.5)]' : 'bg-white/10',
        )}
      >
        <span
          className={cls(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  className,
  mono,
  onEnter,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  mono?: boolean;
  onEnter?: () => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) onEnter();
      }}
      placeholder={placeholder}
      className={cls(
        'w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60',
        mono && 'font-mono',
        className,
      )}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
}) {
  const fmt = (v: number): string => (Number.isFinite(v) ? String(v) : '');
  const [text, setText] = useState<string>(() => fmt(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);

  const commit = (): void => {
    focused.current = false;
    const raw = text.trim();
    let n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      setText(fmt(value));
      return;
    }
    if (typeof min === 'number') n = Math.max(min, n);
    if (typeof max === 'number') n = Math.min(max, n);
    setText(fmt(n));
    onChange(n);
  };

  return (
    <div className={cls('inline-flex items-center rounded-lg border border-white/10 bg-black/40 overflow-hidden', className)}>
      <input
        type="number"
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={commit}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return;
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        min={min}
        max={max}
        step={step}
        className="w-24 bg-transparent px-3 py-2 text-sm text-white outline-none"
      />
      {suffix && <div className="px-2 text-xs uppercase text-krypt-muted">{suffix}</div>}
    </div>
  );
}

export function Empty({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 rounded-2xl border border-dashed border-white/10 bg-black/20">
      <div className="text-base font-semibold text-white">{title}</div>
      {message && <div className="text-sm text-krypt-muted mt-2 max-w-md">{message}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'gradient';
}) {
  const styles: Record<string, string> = {
    neutral: 'border-white/10 bg-white/5 text-krypt-muted',
    success: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
    warn: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
    danger: 'border-rose-400/30 bg-rose-500/10 text-rose-300',
    gradient: 'border-purple-400/40 bg-krypt-purple/10 text-purple-200',
  };
  return (
    <span
      className={cls(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}
