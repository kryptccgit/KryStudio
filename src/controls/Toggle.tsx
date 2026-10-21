// Discrete controls: Toggle (LED button / pill), Select (dropdown with
// wheel stepping), StepButton (presentational step-sequencer cell).

import { useRef, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { toggleMenuAt, type MenuItem } from '../components/Menu';
import { cls } from '../utils/format';

export function Toggle({
  on,
  onChange,
  label,
  hint,
  tone = 'accent',
  variant = 'pill',
  disabled,
  className,
  children,
  onContextMenu,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  hint?: string;
  tone?: 'accent' | 'green' | 'amber' | 'rose';
  variant?: 'pill' | 'led' | 'button';
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const onCls: Record<string, string> = {
    accent: 'border-krypt-purple/60 bg-krypt-purple/20 text-white shadow-[0_0_10px_rgba(168,85,247,0.35)]',
    green: 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_8px_rgba(34,197,94,0.35)]',
    amber: 'border-amber-400/50 bg-amber-500/15 text-amber-200 shadow-[0_0_8px_rgba(245,158,11,0.35)]',
    rose: 'border-rose-400/50 bg-rose-500/15 text-rose-200 shadow-[0_0_8px_rgba(239,68,68,0.35)]',
  };
  const ledCls: Record<string, string> = {
    accent: 'bg-krypt-purple shadow-[0_0_6px_rgba(168,85,247,0.9)]',
    green: 'bg-emerald-400 shadow-[0_0_6px_rgba(34,197,94,0.9)]',
    amber: 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.9)]',
    rose: 'bg-rose-400 shadow-[0_0_6px_rgba(239,68,68,0.9)]',
  };
  if (variant === 'led') {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-pressed={on}
        aria-label={label}
        data-hint={hint ?? label}
        onClick={() => onChange(!on)}
        onContextMenu={onContextMenu}
        className={cls('group inline-flex items-center justify-center h-4 w-4 rounded-full disabled:opacity-40', className)}
      >
        <span className={cls('h-2 w-2 rounded-full transition', on ? ledCls[tone] : 'bg-white/15 group-hover:bg-white/30')} />
      </button>
    );
  }
  if (variant === 'button') {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-pressed={on}
        data-hint={hint ?? label}
        onClick={() => onChange(!on)}
        onContextMenu={onContextMenu}
        className={cls(
          'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 h-5 text-[10px] font-semibold uppercase tracking-wider transition disabled:opacity-40',
          on ? onCls[tone] : 'border-white/10 bg-white/[0.03] text-krypt-muted hover:text-white hover:border-white/20',
          className,
        )}
      >
        {children ?? label}
      </button>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-hint={hint ?? label}
      onClick={() => onChange(!on)}
      onContextMenu={onContextMenu}
      className={cls('inline-flex items-center gap-1.5 select-none disabled:opacity-40', className)}
    >
      <span className={cls('relative h-3.5 w-6 rounded-full transition', on ? 'bg-krypt-gradient shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'bg-white/10')}>
        <span className={cls('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', on ? 'left-[12px]' : 'left-0.5')} />
      </span>
      {label && <span className="text-[10px] text-white/80">{label}</span>}
    </button>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  hint,
  className,
  width,
  disabled,
  renderValue,
}: {
  value: T;
  options: Array<{ value: T; label: string; detail?: string; swatch?: string }>;
  onChange: (v: T) => void;
  hint?: string;
  className?: string;
  width?: number;
  disabled?: boolean;
  renderValue?: (label: string) => ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const idx = options.findIndex((o) => o.value === value);
  const cur = options[idx];
  const open = (): void => {
    if (!ref.current || disabled) return;
    const items: MenuItem[] = options.map((o) => ({
      label: o.label,
      detail: o.detail,
      swatch: o.swatch,
      checked: o.value === value,
      onSelect: () => onChange(o.value),
    }));
    toggleMenuAt(ref.current, items, { minWidth: width });
  };
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      data-hint={hint ? `${hint}: ${cur?.label ?? ''}  ·  click to choose, wheel to step` : undefined}
      onClick={open}
      onWheel={(e) => {
        if (disabled || !options.length) return;
        const dir = e.deltaY > 0 ? 1 : -1;
        const next = options[Math.max(0, Math.min(options.length - 1, (idx < 0 ? 0 : idx) + dir))];
        if (next && next.value !== value) onChange(next.value);
      }}
      className={cls(
        'inline-flex items-center justify-between gap-1 rounded-md border border-white/10 bg-black/40 px-1.5 h-5 text-[10px] text-white/90 hover:border-white/20 transition disabled:opacity-40',
        className,
      )}
      style={{ width }}
    >
      <span className="flex items-center gap-1 truncate">
        {cur?.swatch && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: cur.swatch }} />}
        <span className="truncate">{renderValue ? renderValue(cur?.label ?? '—') : cur?.label ?? '—'}</span>
      </span>
      <ChevronDown className="h-3 w-3 flex-shrink-0 text-krypt-muted" />
    </button>
  );
}

/** One step-sequencer cell (purely presentational; the rack row owns the pointer logic). */
export function StepButton({
  on,
  accent,
  vel,
  color,
  shade,
  width,
  height,
}: {
  on: boolean;
  accent?: boolean;
  vel?: number;
  color: string;
  /** Alternate beat-group shading (FL-style 4-step blocks). */
  shade: boolean;
  width: number;
  height: number;
}) {
  return (
    <div className="flex-shrink-0 p-[1.5px]" style={{ width, height }}>
      <div
        className={cls('h-full w-full rounded-[3px] border transition-[background-color,box-shadow] duration-75', on ? 'border-white/25' : shade ? 'border-white/[0.06] bg-white/[0.075]' : 'border-white/[0.05] bg-white/[0.035]')}
        style={
          on
            ? {
                background: color,
                opacity: 0.55 + 0.45 * (vel ?? 0.78),
                boxShadow: accent ? `0 0 8px ${color}, inset 0 2px 0 rgba(255,255,255,0.85)` : `0 0 6px ${color}66`,
              }
            : undefined
        }
      />
    </div>
  );
}
