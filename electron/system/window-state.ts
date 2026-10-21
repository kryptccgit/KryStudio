// Main-window bounds persistence (userData/window-state.json). Restored
// bounds are validated against the CURRENT displays: a monitor may be gone,
// and negative coordinates are valid (monitors left of/above the primary).

import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import path from 'node:path';
import { readTextSync, writeFileAtomicSync } from './files';

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

const UNPLACED = -1;
const DEFAULT: WindowState = { x: UNPLACED, y: UNPLACED, width: 1440, height: 900, maximized: false };

function file(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function visibleOnSomeDisplay(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return ix >= 120 && iy >= 80;
  });
}

export function loadWindowState(): WindowState {
  try {
    const raw = readTextSync(file());
    const s = raw ? (JSON.parse(raw) as Partial<WindowState>) : {};
    const st: WindowState = {
      x: Number.isFinite(s.x) ? Number(s.x) : UNPLACED,
      y: Number.isFinite(s.y) ? Number(s.y) : UNPLACED,
      width: Math.max(960, Number.isFinite(s.width) ? Number(s.width) : DEFAULT.width),
      height: Math.max(600, Number.isFinite(s.height) ? Number(s.height) : DEFAULT.height),
      maximized: s.maximized === true,
    };
    const placed = !(st.x === UNPLACED && st.y === UNPLACED);
    if (placed && !visibleOnSomeDisplay({ x: st.x, y: st.y, width: st.width, height: st.height })) {
      return { ...st, x: UNPLACED, y: UNPLACED };
    }
    // Clamp oversized windows to the primary work area.
    const wa = screen.getPrimaryDisplay().workAreaSize;
    st.width = Math.min(st.width, Math.max(960, wa.width));
    st.height = Math.min(st.height, Math.max(600, wa.height));
    return st;
  } catch {
    return { ...DEFAULT };
  }
}

/** Options to spread into the BrowserWindow constructor. */
export function boundsOptions(s: WindowState): { x?: number; y?: number; width: number; height: number } {
  return s.x === UNPLACED && s.y === UNPLACED ? { width: s.width, height: s.height } : { x: s.x, y: s.y, width: s.width, height: s.height };
}

/** Track a window and persist its bounds (debounced, and on close). */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (win.isDestroyed()) return;
    try {
      const maximized = win.isMaximized();
      const b = maximized || win.isMinimized() ? win.getNormalBounds() : win.getBounds();
      writeFileAtomicSync(file(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized }));
    } catch {
      /* best effort */
    }
  };
  const debounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 600);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', debounced);
  win.on('unmaximize', debounced);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
