// Visual controls: Knob, Fader, Slider. All take a NORMALIZED value and a
// preformatted display string; the Param* wrappers (ParamKnob.tsx) bind them
// to the document. No React state per frame: only the dragged control renders.

import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useParamDrag } from './useParamDrag';
import { setLiveHint } from '../app/hints';
import { cls } from '../utils/format';

export interface ControlProps {
  /** Normalized 0..1. */
  value: number;
  defaultValue: number;
  /** Formatted display of the current value ("-6.0 dB"). */
  display: string;
  label?: string;
  steps?: number;
  /** Fill from the centre (pan, detune). */
  bipolar?: boolean;
  disabled?: boolean;
  /** Accent color for the value arc/fill (defaults to the Krypt gradient). */
  color?: string;
  hint?: string;
  className?: string;
  onBegin?: () => void;
  onChange: (norm: number) => void;
  onEnd?: () => void;
  onReset?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** Floating value readout shown next to a control while it's being changed. */
export function ValueTooltip({ anchor, text, show }: { anchor: HTMLElement | null; text: string; show: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!show || !anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  }, [show, anchor]);
  if (!show || !anchor || !pos) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[1200] -translate-x-1/2 -translate-y-full rounded-md border border-white/15 bg-black/90 px-1.5 py-0.5 font-mono text-[10px] text-white shadow-krypt-card whitespace-nowrap"
      style={{ left: pos.x, top: pos.y - 4 }}
    >
      {text}
    </div>,
    anchor.ownerDocument.body,
  );
}

function useControl(p: ControlProps, axis: 'x' | 'y', rangePx?: number) {
  const anchor = useRef<HTMLElement | null>(null);
  const drag = useParamDrag({
    value: p.value,
    defaultValue: p.defaultValue,
    steps: p.steps,
    axis,
    rangePx,
    disabled: p.disabled,
    onBegin: p.onBegin,
    onChange: p.onChange,
    onEnd: () => {
      setLiveHint('');
      p.onEnd?.();
    },
    onReset: p.onReset,
    onContextMenu: p.onContextMenu,
  });
  if (drag.active) setLiveHint(`${p.label ?? p.hint ?? 'Value'}: ${p.display}`);
  const setRef = (el: HTMLElement | null): void => {
    anchor.current = el;
    drag.ref(el);
  };
  return { drag, anchor, setRef };
}

// ── Knob ──────────────────────────────────────────────────────────────

const A0 = -135;
const A1 = 135;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (Math.abs(to - from) < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function Knob(p: ControlProps & { size?: number; showLabel?: boolean; showValue?: boolean }) {
  const size = p.size ?? 32;
  const gid = useId().replace(/:/g, '');
  const { drag, anchor, setRef } = useControl(p, 'y');
  const v = Math.min(1, Math.max(0, p.value));
  const angle = A0 + v * (A1 - A0);
  const startAngle = p.bipolar ? 0 : A0;
  const tiny = size < 24;
  const stroke = tiny ? 4.5 : 3.2;
  const r = 15;
  const [px, py] = polar(20, 20, tiny ? 6 : 9.5, angle);
  const fill = p.color ?? `url(#kg${gid})`;
  return (
    <div className={cls('inline-flex flex-col items-center select-none', p.className)}>
      {p.showLabel && p.label && (
        <div className="mb-0.5 max-w-[64px] truncate text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">{p.label}</div>
      )}
      <div
        ref={setRef}
        role="slider"
        tabIndex={p.disabled ? -1 : 0}
        aria-label={p.label}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={v}
        aria-valuetext={p.display}
        data-hint={`${p.hint ?? p.label ?? ''}${p.label || p.hint ? ': ' : ''}${p.display}  ·  drag, Ctrl = fine, double-click = reset, right-click = more`}
        {...drag.handlers}
        className={cls(
          'relative rounded-full outline-none touch-none',
          p.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-ns-resize',
          'focus-visible:ring-1 focus-visible:ring-krypt-purple/70',
        )}
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 40 40" width={size} height={size} className="block overflow-visible">
          <defs>
            <linearGradient id={`kg${gid}`} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#6366F1" />
              <stop offset="55%" stopColor="#A855F7" />
              <stop offset="100%" stopColor="#EC4899" />
            </linearGradient>
          </defs>
          <path d={arc(20, 20, r, A0, A1)} stroke="rgba(255,255,255,0.09)" strokeWidth={stroke} fill="none" strokeLinecap="round" />
          <path d={arc(20, 20, r, Math.min(startAngle, angle), Math.max(startAngle, angle))} stroke={fill} strokeWidth={stroke} fill="none" strokeLinecap="round" />
          {!tiny && <circle cx="20" cy="20" r="11" fill="#15151E" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />}
          {tiny && <circle cx="20" cy="20" r="8.5" fill="#15151E" />}
          <line x1="20" y1="20" x2={px} y2={py} stroke="white" strokeWidth={tiny ? 3 : 2} strokeLinecap="round" opacity={p.disabled ? 0.4 : 0.92} />
        </svg>
        <ValueTooltip anchor={anchor.current} text={p.display} show={drag.active} />
      </div>
      {p.showValue && <div className="mt-0.5 max-w-[72px] truncate font-mono text-[9px] text-white/70 tabular-nums">{p.display}</div>}
    </div>
  );
}

// ── Fader (vertical) ──────────────────────────────────────────────────

export function Fader(p: ControlProps & { height?: number; width?: number; marks?: number[] }) {
  const h = p.height ?? 120;
  const w = p.width ?? 22;
  const { drag, anchor, setRef } = useControl(p, 'y', h - 10);
  const v = Math.min(1, Math.max(0, p.value));
  const thumbH = 10;
  const travel = h - thumbH;
  const y = (1 - v) * travel;
  return (
    <div
      ref={setRef}
      role="slider"
      tabIndex={p.disabled ? -1 : 0}
      aria-label={p.label}
      aria-valuetext={p.display}
      data-hint={`${p.hint ?? p.label ?? 'Fader'}: ${p.display}  ·  drag, Ctrl = fine, double-click = reset`}
      {...drag.handlers}
      className={cls('relative select-none outline-none touch-none cursor-ns-resize focus-visible:ring-1 focus-visible:ring-krypt-purple/70 rounded', p.className)}
      style={{ width: w, height: h }}
    >
      <div className="absolute left-1/2 top-[5px] bottom-[5px] w-[3px] -translate-x-1/2 rounded-full bg-black/60 border border-white/[0.06]" />
      <div
        className="absolute left-1/2 bottom-[5px] w-[3px] -translate-x-1/2 rounded-full"
        style={{ height: Math.max(0, travel - y), background: p.color ?? 'linear-gradient(0deg,#6366F1,#A855F7 60%,#EC4899)' }}
      />
      {(p.marks ?? []).map((m) => (
        <div key={m} className="absolute left-0 right-0 h-px bg-white/20" style={{ top: (1 - m) * travel + thumbH / 2 }} />
      ))}
      <div
        className={cls(
          'absolute left-0 right-0 rounded-[3px] border bg-[#1c1c26] shadow-[0_2px_6px_rgba(0,0,0,0.6)]',
          drag.active ? 'border-krypt-purple/70' : 'border-white/25',
        )}
        style={{ top: y, height: thumbH } as CSSProperties}
      >
        <div className="absolute left-1 right-1 top-1/2 h-px -translate-y-1/2 bg-white/80" />
      </div>
      <ValueTooltip anchor={anchor.current} text={p.display} show={drag.active} />
    </div>
  );
}

// ── Slider (horizontal) ───────────────────────────────────────────────

export function Slider(p: ControlProps & { width?: number; height?: number }) {
  const w = p.width ?? 80;
  const h = p.height ?? 14;
  const { drag, anchor, setRef } = useControl(p, 'x', Math.max(80, w * 1.5));
  const v = Math.min(1, Math.max(0, p.value));
  const from = p.bipolar ? Math.min(0.5, v) : 0;
  const to = p.bipolar ? Math.max(0.5, v) : v;
  return (
    <div
      ref={setRef}
      role="slider"
      tabIndex={p.disabled ? -1 : 0}
      aria-label={p.label}
      aria-valuetext={p.display}
      data-hint={`${p.hint ?? p.label ?? 'Slider'}: ${p.display}  ·  drag, Ctrl = fine, double-click = reset`}
      {...drag.handlers}
      className={cls(
        'relative select-none outline-none touch-none cursor-ew-resize rounded-sm bg-black/50 border border-white/[0.07] overflow-hidden focus-visible:ring-1 focus-visible:ring-krypt-purple/70',
        p.className,
      )}
      style={{ width: w, height: h }}
    >
      <div
        className="absolute top-0 bottom-0"
        style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%`, background: p.color ?? 'linear-gradient(90deg,#6366F1,#A855F7,#EC4899)', opacity: 0.85 }}
      />
      <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: `calc(${v * 100}% - 0.5px)` }} />
      <ValueTooltip anchor={anchor.current} text={p.display} show={drag.active} />
    </div>
  );
}
