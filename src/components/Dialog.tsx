// ──────────────────────────────────────────────────────────────────────
// Tool dialogs (Quantize, Strum, Arpeggiate, Export, Project info...).
// Store-driven so canvas controllers and menus can open them, and portalled
// into the document that asked, so they work in dockview popouts too.
//
//   openDialog({ title: 'Quantize', doc: el.ownerDocument, render: (close) => <Form onDone={close} /> });
//
// Inside a dialog the global keymap and the typing-keyboard piano are
// suspended (installInput skips targets under [data-krypt-dialog]).
// Escape closes; forms submit on Enter through <DialogForm>.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X, type LucideIcon } from 'lucide-react';
import { cls } from '../utils/format';

interface DialogSpec {
  id: number;
  /** Opening a dialog with the same key replaces the open one (e.g. one piano-roll tool at a time). */
  key?: string;
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  doc: Document;
  width?: number;
  /**
   * Place the dialog beside this rect (client coords) over an undimmed
   * backdrop, so a live preview drawn inside the rect stays visible (tool
   * dialogs). Omitted = centred over a dimmed backdrop.
   */
  near?: { left: number; top: number; right: number; bottom: number };
  render: (close: () => void) => ReactNode;
  onClose?: () => void;
}

const useDialogs = create<{ stack: DialogSpec[] }>(() => ({ stack: [] }));
let seq = 0;

/** Open a dialog; returns a function that closes it. */
export function openDialog(spec: Omit<DialogSpec, 'id' | 'doc'> & { doc?: Document | null }): () => void {
  const id = ++seq;
  const doc = spec.doc ?? document;
  if (spec.key) for (const d of useDialogs.getState().stack) if (d.key === spec.key) closeDialog(d.id);
  useDialogs.setState((s) => ({ stack: [...s.stack, { ...spec, id, doc }] }));
  return () => closeDialog(id);
}

export function closeDialog(id?: number): void {
  const { stack } = useDialogs.getState();
  const d = id === undefined ? stack[stack.length - 1] : stack.find((x) => x.id === id);
  if (!d) return;
  useDialogs.setState({ stack: stack.filter((x) => x !== d) });
  d.onClose?.();
}

export function isDialogOpen(): boolean {
  return useDialogs.getState().stack.length > 0;
}

/** Render once at the app root (next to MenuHost). */
export function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  const top = stack[stack.length - 1] ?? null;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ id: number; left: number; top: number } | null>(null);

  // "near" placement: right of the rect if it fits, else left of it, else inside its right edge
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!top?.near || !card) return;
    const win = top.doc.defaultView ?? window;
    const n = top.near;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left = n.right + 12;
    if (left + w > win.innerWidth - 8) left = n.left - 12 - w >= 8 ? n.left - 12 - w : Math.max(8, Math.min(n.right - w - 12, win.innerWidth - w - 8));
    const y = Math.max(8, Math.min(n.top + 40, win.innerHeight - h - 8));
    setPos({ id: top.id, left, top: y });
  }, [top]);

  useEffect(() => {
    if (!top) return;
    const doc = top.doc;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialog(top.id);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // Enter applies from any field (sliders and checkboxes have no implicit form submit)
        const t = e.target as HTMLElement | null;
        const card = cardRef.current;
        if (!card || !t || !card.contains(t) || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT') return;
        const form = card.querySelector('form');
        if (!form) return;
        e.preventDefault();
        e.stopPropagation();
        form.requestSubmit();
      }
    };
    doc.addEventListener('keydown', onKey, true);
    // focus the first field (or the card) so Enter / Escape reach the dialog
    const t = setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      const first = card.querySelector<HTMLElement>('[data-autofocus]') ?? card.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button[type=submit]');
      (first ?? card).focus({ preventScroll: true });
    }, 20);
    return () => {
      clearTimeout(t);
      doc.removeEventListener('keydown', onKey, true);
    };
  }, [top]);

  if (!top) return null;
  const Icon = top.icon;
  const near = !!top.near;
  const placed = near && pos?.id === top.id ? pos : null;
  return createPortal(
    <div
      data-krypt-dialog=""
      className={cls(
        'fixed inset-0 z-[1080] animate-fade-in font-sans text-white',
        near ? 'bg-black/[0.08]' : 'flex items-center justify-center bg-black/60 backdrop-blur-[2px]',
      )}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeDialog(top.id);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        key={top.id}
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={top.title}
        className={cls(
          'max-h-[calc(100%-32px)] overflow-y-auto rounded-2xl border border-white/10 bg-krypt-panel shadow-krypt-card outline-none animate-pop-in',
          near && 'absolute ring-1 ring-krypt-purple/30',
        )}
        style={{
          width: Math.min(top.width ?? 420, (top.doc.defaultView?.innerWidth ?? 800) - 24),
          ...(near ? { left: placed?.left ?? 0, top: placed?.top ?? 0, visibility: placed ? 'visible' : 'hidden' } : {}),
        }}
      >
        <div className="flex items-start gap-2.5 border-b border-white/[0.06] px-4 pb-3 pt-3.5">
          {Icon && (
            <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-krypt-purple/15 text-krypt-purple shadow-[inset_0_0_0_1px_rgba(168,85,247,0.35)]">
              <Icon size={15} strokeWidth={1.9} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold leading-tight text-white">{top.title}</h3>
            {top.subtitle && <p className="mt-0.5 text-[11px] text-krypt-muted">{top.subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => closeDialog(top.id)}
            className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
        {top.render(() => closeDialog(top.id))}
      </div>
    </div>,
    top.doc.body,
  );
}

// ── Form building blocks ──────────────────────────────────────────────

/** Body + footer of a dialog; Enter submits, the primary button is the submit. */
export function DialogForm({
  children,
  onSubmit,
  onCancel,
  submitLabel = 'Apply',
  submitDisabled,
  busy,
  extra,
}: {
  children: ReactNode;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  busy?: boolean;
  /** Left side of the footer (e.g. a "Preview" note or a reset link). */
  extra?: ReactNode;
}) {
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!submitDisabled && !busy) onSubmit();
  };
  return (
    <form onSubmit={submit} className="flex flex-col">
      <div className="space-y-3 px-4 py-3.5">{children}</div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1 text-[10px] text-krypt-muted">{extra}</div>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-lg border border-white/10 bg-white/5 px-3.5 text-[12px] font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitDisabled || busy}
          className="h-8 rounded-lg bg-krypt-gradient px-4 text-[12px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
        >
          {busy ? 'Working…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A labelled row: label (+hint) on the left, control on the right. */
export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cls('flex gap-3', wide ? 'flex-col items-stretch gap-1.5' : 'items-center justify-between')}>
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-white/90">{label}</div>
        {hint && <div className="text-[10px] leading-snug text-krypt-muted">{hint}</div>}
      </div>
      <div className={cls('flex-shrink-0', wide && 'w-full')}>{children}</div>
    </div>
  );
}

/** Slider + numeric readout. `format` renders the value; the slider works in `step` units. */
export function RangeField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  width = 150,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  width?: number;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-1.5 cursor-pointer accent-krypt-purple"
          style={{ width }}
        />
        <label htmlFor={id} className="w-[64px] text-right font-mono text-[11px] text-white/80">
          {format ? format(value) : String(value)}
        </label>
      </div>
    </Field>
  );
}

/** Segmented control (2–6 options). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T;
  options: Array<{ value: T; label: string; title?: string; icon?: LucideIcon }>;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-black/40 p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={String(o.value)}
            type="button"
            title={o.title}
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cls(
              'inline-flex items-center gap-1 rounded-md font-semibold transition',
              size === 'sm' ? 'h-6 px-2 text-[10px]' : 'h-7 px-2.5 text-[11px]',
              on ? 'bg-krypt-purple/25 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.6)]' : 'text-white/55 hover:bg-white/5 hover:text-white',
            )}
          >
            {Icon && <Icon size={12} strokeWidth={2} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Compact checkbox with a label. */
export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12px] text-white/85">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-krypt-purple" />
      <span className="min-w-0">
        <span className="font-semibold">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-krypt-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Native select styled for dialogs. */
export function DialogSelect<T extends string | number>({
  value,
  options,
  onChange,
  width = 150,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  width?: number;
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        const hit = options.find((o) => String(o.value) === raw);
        if (hit) onChange(hit.value);
      }}
      className="h-7 cursor-pointer rounded-lg border border-white/10 bg-black/40 px-2 font-mono text-[11px] text-white/90 outline-none hover:border-white/20 focus:border-krypt-purple/60"
      style={{ width }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} className="bg-krypt-surface">
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Small numeric input for dialogs (commits on blur / Enter, clamps). */
export function NumberBox({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  width = 72,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  width?: number;
}) {
  return (
    <div className="inline-flex h-7 items-center overflow-hidden rounded-lg border border-white/10 bg-black/40 focus-within:border-krypt-purple/60">
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="h-full bg-transparent px-2 font-mono text-[11px] text-white outline-none"
        style={{ width }}
      />
      {suffix && <span className="pr-2 text-[10px] uppercase text-krypt-muted">{suffix}</span>}
    </div>
  );
}
