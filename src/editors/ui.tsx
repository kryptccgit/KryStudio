import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cls } from '../utils/format';

export function ToolBar({ children, className, 'data-guide': guide }: { children: ReactNode; className?: string; 'data-guide'?: string }) {
  return (
    <div
      data-guide={guide}
      className={cls(
        'flex items-center gap-1 h-9 shrink-0 px-2 border-b border-white/10 bg-krypt-panel text-[11px] text-white/80 select-none overflow-x-auto overflow-y-hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Sep() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-white/10" />;
}

export function ToolButton({
  icon: Icon,
  label,
  shortcut,
  active,
  onClick,
  disabled,
  children,
  'data-guide': guide,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children?: ReactNode;
  'data-guide'?: string;
}) {
  return (
    <button
      type="button"
      data-guide={guide}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={(e) => e.preventDefault()}
      className={cls(
        'relative inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 transition',
        children ? 'min-w-7' : 'w-7',
        active
          ? 'bg-krypt-purple/20 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.55)]'
          : 'text-white/60 hover:text-white hover:bg-white/5',
        'disabled:opacity-35 disabled:pointer-events-none',
      )}
    >
      <Icon size={15} strokeWidth={1.8} />
      {children}
      {active && <span className="absolute bottom-0 left-1.5 right-1.5 h-px bg-krypt-gradient" />}
    </button>
  );
}

export function ToolSelect<T extends string>({
  value,
  onChange,
  options,
  title,
  icon: Icon,
  className,
  'data-guide': guide,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  title: string;
  icon?: LucideIcon;
  className?: string;
  'data-guide'?: string;
}) {
  return (
    <label className={cls('inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/10 bg-krypt-void pl-1.5 pr-0.5 hover:border-white/20', className)} title={title} data-guide={guide}>
      {Icon && <Icon size={13} strokeWidth={1.8} className="text-white/50" />}
      <select
        value={value}
        onChange={(e) => {
          onChange(e.target.value as T);
          (e.target.closest('[data-editor-root]') as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="h-full cursor-pointer bg-transparent pr-1 font-mono text-[11px] text-white/85 outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-krypt-surface text-white">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const doc = el?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('blur', onClose);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.right > win.innerWidth) el.style.left = `${Math.max(4, win.innerWidth - r.width - 4)}px`;
      if (r.bottom > win.innerHeight) el.style.top = `${Math.max(4, win.innerHeight - r.height - 4)}px`;
    }
    return () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: x, top: y }}
      className="fixed z-[1000] min-w-[180px] animate-pop-in rounded-lg border border-white/10 bg-krypt-surface/95 p-1 text-xs text-white/90 shadow-krypt-card backdrop-blur"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onClick();
          }}
          className={cls(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition',
            it.danger ? 'text-rose-200 hover:bg-rose-500/15' : 'hover:bg-krypt-purple/15',
            'disabled:opacity-40 disabled:pointer-events-none',
          )}
        >
          {it.icon ? <it.icon size={13} strokeWidth={1.8} className="text-white/55" /> : <span className="w-[13px]" />}
          <span className="flex-1">{it.label}</span>
          {it.shortcut && <span className="font-mono text-[10px] text-white/35">{it.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}

export function ScrollTrack({ axis, trackRef, thumbRef }: { axis: 'x' | 'y'; trackRef: RefObject<HTMLDivElement>; thumbRef: RefObject<HTMLDivElement> }) {
  return (
    <div ref={trackRef} className={axis === 'y' ? 'relative border-l border-white/10 bg-krypt-panel' : 'relative border-t border-white/10 bg-krypt-panel'}>
      <div
        ref={thumbRef}
        className={
          (axis === 'y' ? 'absolute left-[2px] right-[2px] top-0 ' : 'absolute bottom-[2px] left-0 top-[2px] ') +
          'rounded-full bg-white/15 transition-colors hover:bg-krypt-purple/70 data-[active]:bg-krypt-purple'
        }
      />
    </div>
  );
}
