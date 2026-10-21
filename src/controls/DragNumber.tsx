// FL-style numeric field (tempo, lengths): drag vertically to change,
// Ctrl = fine, wheel steps, double-click to type, Alt-click resets.

import { useEffect, useRef, useState } from 'react';
import { setLiveHint } from '../app/hints';
import { cls } from '../utils/format';

export function DragNumber({
  value,
  min,
  max,
  step = 1,
  fineStep = 0.01,
  pxPerStep = 3,
  defaultValue,
  format,
  label,
  hint,
  className,
  onChange,
  onEnd,
  onContextMenu,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  fineStep?: number;
  pxPerStep?: number;
  defaultValue?: number;
  format?: (v: number) => string;
  label?: string;
  hint?: string;
  className?: string;
  onChange: (v: number) => void;
  onEnd?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const fmt = format ?? ((v: number) => String(v));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const drag = useRef<{ start: number; acc: number; id: number; y: number } | null>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cur = useRef(value);
  cur.current = value;
  const cb = useRef({ onChange, onEnd });
  cb.current = { onChange, onEnd };

  const clamp = (v: number): number => Math.min(max, Math.max(min, Math.round(v / fineStep) * fineStep));

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const s = e.ctrlKey || e.shiftKey ? step / 10 : step;
      cb.current.onChange(clamp(cur.current + dir * s));
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => cb.current.onEnd?.(), 400);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, step, min, max]);

  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const n = Number(text.replace(',', '.'));
            if (Number.isFinite(n)) {
              cb.current.onChange(clamp(n));
              cb.current.onEnd?.();
            }
            setEditing(false);
          } else if (e.key === 'Escape') setEditing(false);
        }}
        className={cls('rounded-md border border-krypt-purple/60 bg-black/60 px-1.5 text-center font-mono text-white outline-none', className)}
      />
    );
  }

  return (
    <div
      ref={elRef}
      role="spinbutton"
      tabIndex={0}
      aria-valuenow={value}
      aria-label={label}
      data-hint={`${hint ?? label ?? ''}: ${fmt(value)}  ·  drag up/down (Ctrl = fine), wheel, double-click to type`}
      className={cls('cursor-ns-resize select-none touch-none rounded-md border border-white/10 bg-black/50 px-1.5 text-center font-mono tabular-nums text-white outline-none hover:border-white/20 focus-visible:border-krypt-purple/60', className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (e.altKey && defaultValue !== undefined) {
          cb.current.onChange(defaultValue);
          cb.current.onEnd?.();
          return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: value, acc: 0, id: e.pointerId, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.acc += d.y - e.clientY;
        d.y = e.clientY;
        const fine = e.ctrlKey || e.shiftKey;
        const v = clamp(d.start + (fine ? d.acc * fineStep : Math.trunc(d.acc / pxPerStep) * step));
        if (v !== cur.current) {
          cb.current.onChange(v);
          setLiveHint(`${label ?? 'Value'}: ${fmt(v)}`);
        }
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        setLiveHint('');
        cb.current.onEnd?.();
      }}
      onDoubleClick={() => {
        setText(String(value));
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          cb.current.onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.ctrlKey ? step / 10 : step)));
          cb.current.onEnd?.();
        } else if (e.key === 'Enter') {
          setText(String(value));
          setEditing(true);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
    >
      {fmt(value)}
    </div>
  );
}
