import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { cls } from '../utils/format';

export type MenuItem =
  | {
      type?: 'item';
      label: string;
      icon?: LucideIcon;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      hint?: string;
      swatch?: string;
      detail?: string;
      onSelect: () => void;
    }
  | { type: 'separator' }
  | { type: 'header'; label: string }
  | { type: 'submenu'; label: string; icon?: LucideIcon; items: MenuItem[]; disabled?: boolean; swatch?: string }
  | { type: 'custom'; render: (close: () => void) => ReactNode };

interface OpenMenu {
  id: number;
  x: number;
  y: number;
  anchor?: { top: number; bottom: number; left: number; right: number };
  items: MenuItem[];
  doc: Document;
  anchorEl?: Element | null;
  minWidth?: number;
  onClose?: () => void;
}

interface MenuStore {
  menu: OpenMenu | null;
}

const useMenuStore = create<MenuStore>(() => ({ menu: null }));
let seq = 0;

export function closeMenu(): void {
  const m = useMenuStore.getState().menu;
  if (!m) return;
  useMenuStore.setState({ menu: null });
  m.onClose?.();
}

export function isMenuOpenFor(el: Element | null): boolean {
  const m = useMenuStore.getState().menu;
  return !!m && !!el && m.anchorEl === el;
}

export function openMenu(
  at: { clientX: number; clientY: number; target?: EventTarget | null } | { x: number; y: number; doc?: Document },
  items: MenuItem[],
  opts: { minWidth?: number; onClose?: () => void } = {},
): void {
  closeMenu();
  let x: number;
  let y: number;
  let doc: Document = document;
  if ('clientX' in at) {
    x = at.clientX;
    y = at.clientY;
    const t = at.target as Node | null | undefined;
    if (t && t.ownerDocument) doc = t.ownerDocument;
  } else {
    x = at.x;
    y = at.y;
    if (at.doc) doc = at.doc;
  }
  useMenuStore.setState({ menu: { id: ++seq, x, y, items, doc, minWidth: opts.minWidth, onClose: opts.onClose } });
}

export function openMenuAt(el: Element, items: MenuItem[], opts: { minWidth?: number; onClose?: () => void; align?: 'left' | 'right' } = {}): void {
  closeMenu();
  const r = el.getBoundingClientRect();
  useMenuStore.setState({
    menu: {
      id: ++seq,
      x: opts.align === 'right' ? r.right : r.left,
      y: r.bottom + 2,
      anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      items,
      doc: el.ownerDocument,
      anchorEl: el,
      minWidth: opts.minWidth ?? Math.max(160, r.width),
      onClose: opts.onClose,
    },
  });
}

export function toggleMenuAt(el: Element, items: MenuItem[] | (() => MenuItem[]), opts?: Parameters<typeof openMenuAt>[2]): void {
  if (isMenuOpenFor(el)) {
    closeMenu();
    return;
  }
  openMenuAt(el, typeof items === 'function' ? items() : items, opts);
}

function isActionable(it: MenuItem): boolean {
  return (it.type === undefined || it.type === 'item' || it.type === 'submenu') && !(it as { disabled?: boolean }).disabled;
}

function MenuList({
  items,
  close,
  autoFocus,
  onLeft,
  minWidth,
}: {
  items: MenuItem[];
  close: () => void;
  autoFocus?: boolean;
  onLeft?: () => void;
  minWidth?: number;
}) {
  const [active, setActive] = useState<number>(-1);
  const [subOpen, setSubOpen] = useState<number>(-1);
  const ref = useRef<HTMLDivElement>(null);
  const rows = useRef<Array<HTMLDivElement | null>>([]);
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
    return () => {
      if (subTimer.current) clearTimeout(subTimer.current);
    };
  }, [autoFocus]);

  const move = (dir: 1 | -1): void => {
    if (!items.some(isActionable)) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (isActionable(items[i])) break;
    }
    setActive(i);
  };

  const activate = (i: number): void => {
    const it = items[i];
    if (!it || !isActionable(it)) return;
    if (it.type === 'submenu') {
      setSubOpen(i);
      return;
    }
    if (it.type === undefined || it.type === 'item') {
      close();
      setTimeout(() => it.onSelect(), 0);
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        e.stopPropagation();
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(active);
        } else if (e.key === 'ArrowRight') {
          if (items[active]?.type === 'submenu') setSubOpen(active);
        } else if (e.key === 'ArrowLeft') {
          onLeft?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
      className="py-1 outline-none max-h-[70vh] overflow-y-auto overflow-x-visible"
      style={{ minWidth, maxWidth: Math.max(minWidth ?? 0, 360) }}
    >
      {items.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="my-1 h-px bg-white/10" />;
        if (it.type === 'header')
          return (
            <div key={i} className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted/70">
              {it.label}
            </div>
          );
        if (it.type === 'custom') return <div key={i}>{it.render(close)}</div>;
        const Icon = it.icon;
        const isSub = it.type === 'submenu';
        const disabled = !!it.disabled;
        const danger = !isSub && (it as { danger?: boolean }).danger;
        return (
          <div
            key={i}
            ref={(el) => (rows.current[i] = el)}
            className="relative"
            onMouseEnter={() => {
              setActive(i);
              if (subTimer.current) clearTimeout(subTimer.current);
              subTimer.current = setTimeout(() => setSubOpen(isSub ? i : -1), isSub ? 80 : 160);
            }}
          >
            <button
              type="button"
              disabled={disabled}
              data-hint={!isSub ? it.hint : undefined}
              onClick={() => activate(i)}
              className={cls(
                'w-full flex items-center gap-2 px-3 py-[5px] text-left text-[12px] leading-tight transition-colors',
                disabled ? 'text-white/25 cursor-default' : danger ? 'text-rose-300' : 'text-white/90',
                active === i && !disabled && (danger ? 'bg-rose-500/15' : 'bg-white/[0.07]'),
              )}
            >
              <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
                {!isSub && it.checked ? (
                  <Check className="h-3.5 w-3.5 text-krypt-purple" />
                ) : it.swatch ? (
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: it.swatch }} />
                ) : Icon ? (
                  <Icon className={cls('h-3.5 w-3.5', danger ? 'text-rose-300' : 'text-krypt-muted')} />
                ) : null}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block truncate">{it.label}</span>
                {!isSub && it.detail && <span className="block truncate text-[10px] text-krypt-muted/80 mt-0.5">{it.detail}</span>}
              </span>
              {!isSub && it.shortcut && <span className="ml-4 font-mono text-[10px] text-krypt-muted/70">{it.shortcut}</span>}
              {isSub && <ChevronRight className="h-3.5 w-3.5 text-krypt-muted" />}
            </button>
            {isSub && subOpen === i && !disabled && (
              <SubMenu items={it.items} close={close} onLeft={() => setSubOpen(-1)} anchor={rows.current[i]} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubMenu({ items, close, onLeft, anchor }: { items: MenuItem[]; close: () => void; onLeft: () => void; anchor: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({ left: 0, top: 0, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const win = el.ownerDocument.defaultView ?? window;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = a.right + 4;
    if (left + r.width > win.innerWidth - 4) left = Math.max(4, a.left - r.width - 4);
    let top = a.top - 4;
    if (top + r.height > win.innerHeight - 4) top = Math.max(4, win.innerHeight - 4 - r.height);
    setPos({ left, top, ready: true });
  }, [anchor]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      data-krypt-menu=""
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[1060] rounded-lg border border-white/10 bg-[#101018]/95 backdrop-blur-md shadow-krypt-card animate-fade-in font-sans text-white select-none"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
    >
      <MenuList items={items} close={close} onLeft={onLeft} minWidth={170} autoFocus />
    </div>,
    anchor.ownerDocument.body,
  );
}

export function MenuHost() {
  const menu = useMenuStore((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; ready: boolean }>({ x: 0, y: 0, ready: false });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const win = menu.doc.defaultView ?? window;
    const r = ref.current.getBoundingClientRect();
    let x = menu.x;
    let y = menu.y;
    if (menu.anchor && y + r.height > win.innerHeight - 4) y = Math.max(4, menu.anchor.top - r.height - 2);
    if (x + r.width > win.innerWidth - 4) x = Math.max(4, win.innerWidth - r.width - 4);
    if (y + r.height > win.innerHeight - 4) y = Math.max(4, win.innerHeight - r.height - 4);
    setPos({ x, y, ready: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const doc = menu.doc;
    const win = doc.defaultView ?? window;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as Element).closest?.('[data-krypt-menu]')) return;
      if (menu.anchorEl && menu.anchorEl.contains(t)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu();
    };
    const onBlur = (): void => closeMenu();
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('blur', onBlur);
    win.addEventListener('resize', onBlur);
    return () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('blur', onBlur);
      win.removeEventListener('resize', onBlur);
    };
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      key={menu.id}
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[1050] rounded-lg border border-white/10 bg-[#101018]/95 backdrop-blur-md shadow-krypt-card animate-fade-in font-sans text-white select-none"
      style={{ left: pos.ready ? pos.x : menu.x, top: pos.ready ? pos.y : menu.y, visibility: pos.ready ? 'visible' : 'hidden' }}
    >
      <MenuList items={menu.items} close={closeMenu} autoFocus minWidth={menu.minWidth ?? 180} />
    </div>,
    menu.doc.body,
  );
}

export function ColorSwatches({ colors, current, onPick }: { colors: string[]; current?: string; onPick: (c: string) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1.5 px-3 py-2">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className={cls(
            'h-5 w-5 rounded-md border transition hover:scale-110',
            current?.toLowerCase() === c.toLowerCase() ? 'border-white shadow-[0_0_8px_rgba(255,255,255,0.4)]' : 'border-white/10',
          )}
          style={{ background: c }}
          title={c}
        />
      ))}
    </div>
  );
}
