// ──────────────────────────────────────────────────────────────────────
// FL-feel gesture hook for every continuous control (research/06 §3.1).
//
//   drag            vertical (up = more), ~250 px for the full range
//   Ctrl / Shift    fine (×0.1) while dragging or wheeling
//   double-click,
//   Alt-click,
//   middle-click    reset to default
//   wheel           1% per notch (Ctrl 0.1%); stepped params move one step
//   arrows / PgUp   keyboard steps; Home/End = min/max; Delete = reset
//
// Works on normalized 0..1 values. The caller maps to plain units.
// In Electron the cursor is pointer-locked during drags (no screen-edge
// stalls); in a plain browser it falls back to pointer capture.
// ──────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ParamDragOptions {
  /** Current normalized value. */
  value: number;
  /** Normalized default (reset target). */
  defaultValue: number;
  /** Discrete positions (enums / stepped params). */
  steps?: number;
  axis?: 'x' | 'y';
  /** Pixels for the full range. */
  rangePx?: number;
  disabled?: boolean;
  onBegin?: () => void;
  onChange: (norm: number) => void;
  onEnd?: () => void;
  onReset?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const isElectron = (): boolean => typeof window !== 'undefined' && !(window as unknown as { __kryptMockHost?: unknown }).__kryptMockHost;

export function quantize(n: number, steps?: number): number {
  if (!steps || steps < 2) return clamp01(n);
  return Math.round(clamp01(n) * (steps - 1)) / (steps - 1);
}

export function useParamDrag(opts: ParamDragOptions) {
  const o = useRef(opts);
  o.current = opts;
  const [dragging, setDragging] = useState(false);
  const state = useRef({ active: false, accum: 0, last: 0, pointerId: -1, locked: false, lockPending: false, x: 0, y: 0 });
  const elRef = useRef<HTMLElement | null>(null);
  const wheelEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wheeling, setWheeling] = useState(false);

  const emit = (n: number): void => {
    const q = quantize(n, o.current.steps);
    if (q !== state.current.last) {
      state.current.last = q;
      o.current.onChange(q);
    }
  };

  const reset = (): void => {
    if (o.current.disabled) return;
    if (o.current.onReset) o.current.onReset();
    else {
      o.current.onBegin?.();
      o.current.onChange(o.current.defaultValue);
      o.current.onEnd?.();
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (o.current.disabled) return;
    if (e.button === 1) {
      e.preventDefault();
      reset();
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey) {
      e.preventDefault();
      reset();
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    state.current = { active: true, accum: o.current.value, last: o.current.value, pointerId: e.pointerId, locked: false, lockPending: false, x: e.clientX, y: e.clientY };
    if (isElectron() && typeof el.requestPointerLock === 'function') {
      try {
        const p = (el.requestPointerLock as (o?: unknown) => Promise<void> | void)({ unadjustedMovement: true });
        if (p && typeof (p as Promise<void>).then === 'function') {
          state.current.lockPending = true;
          (p as Promise<void>).then(
            () => {
              state.current.locked = true;
              state.current.lockPending = false;
            },
            () => {
              state.current.lockPending = false; // denied — capture fallback already active
            },
          );
        }
      } catch {
        /* ignore */
      }
    }
    setDragging(true);
    o.current.onBegin?.();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const s = state.current;
    if (!s.active) return;
    const axis = o.current.axis ?? 'y';
    // Pointer-locked: the cursor is frozen, so only movement deltas exist.
    // Otherwise use client deltas (movementX/Y is unreliable across DPI / synthetic input).
    const locked = s.locked && !!e.currentTarget.ownerDocument.pointerLockElement;
    const dx = locked ? e.movementX : e.clientX - s.x;
    const dy = locked ? e.movementY : e.clientY - s.y;
    s.x = e.clientX;
    s.y = e.clientY;
    const delta = axis === 'y' ? -dy : dx;
    if (!delta) return;
    const fine = e.ctrlKey || e.shiftKey ? 0.1 : 1;
    const range = o.current.rangePx ?? 250;
    s.accum = clamp01(s.accum + (delta / range) * fine);
    emit(s.accum);
  };

  const finish = (e: React.PointerEvent<HTMLElement>): void => {
    const s = state.current;
    if (!s.active) return;
    s.active = false;
    try {
      e.currentTarget.releasePointerCapture(s.pointerId);
    } catch {
      /* ignore */
    }
    const doc = e.currentTarget.ownerDocument;
    if (doc.pointerLockElement) doc.exitPointerLock();
    setDragging(false);
    o.current.onEnd?.();
  };

  const onDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    reset();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (o.current.disabled) return;
    const steps = o.current.steps;
    const unit = steps && steps > 1 ? 1 / (steps - 1) : e.shiftKey || e.ctrlKey ? 0.001 : 0.01;
    let next: number | null = null;
    const v = o.current.value;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = v + unit;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = v - unit;
        break;
      case 'PageUp':
        next = v + (steps ? unit : 0.1);
        break;
      case 'PageDown':
        next = v - (steps ? unit : 0.1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        e.stopPropagation();
        reset();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    o.current.onBegin?.();
    state.current.last = -1;
    emit(next);
    o.current.onEnd?.();
  };

  // Wheel needs a non-passive native listener (React's is passive).
  const ref = useCallback((el: HTMLElement | null) => {
    const prev = elRef.current;
    if (prev) prev.removeEventListener('wheel', onWheelNative as EventListener);
    elRef.current = el;
    if (el) el.addEventListener('wheel', onWheelNative as EventListener, { passive: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onWheelNative(e: WheelEvent): void {
    if (o.current.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (!dir) return;
    const steps = o.current.steps;
    const unit = steps && steps > 1 ? 1 / (steps - 1) : e.ctrlKey || e.shiftKey ? 0.001 : 0.01;
    if (!wheelEnd.current) {
      o.current.onBegin?.();
      setWheeling(true);
    } else clearTimeout(wheelEnd.current);
    state.current.last = -1;
    emit(o.current.value + dir * unit);
    wheelEnd.current = setTimeout(() => {
      wheelEnd.current = null;
      setWheeling(false);
      o.current.onEnd?.();
    }, 450);
  }

  useEffect(
    () => () => {
      if (wheelEnd.current) clearTimeout(wheelEnd.current);
    },
    [],
  );

  return {
    ref,
    dragging,
    active: dragging || wheeling,
    reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      // Acquiring pointer lock releases capture: that must not end the drag.
      onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => {
        if (state.current.locked || state.current.lockPending) return;
        finish(e);
      },
      onDoubleClick,
      onKeyDown,
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        o.current.onContextMenu?.(e);
      },
    },
  };
}
