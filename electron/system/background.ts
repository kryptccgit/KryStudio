import { app, Menu, nativeImage, Tray } from 'electron';
import type { ActionResult } from '@shared/types';

export const HIDDEN_ARG = '--hidden';

export function launchedHidden(argv: readonly string[] = process.argv): boolean {
  return argv.includes(HIDDEN_ARG);
}

export function syncStartWithWindows(enabled: boolean, valueName: string): ActionResult {
  if (!app.isPackaged || process.platform !== 'win32') return { ok: true };
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [HIDDEN_ARG], name: valueName });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Couldn't ${enabled ? 'add Krypt Studio to' : 'remove Krypt Studio from'} Windows startup: ${(err as Error)?.message ?? err}` };
  }
}

export function engineNeeded(o: { windowVisible: boolean; agents: number; rendering: boolean }): boolean {
  return o.windowVisible || o.agents > 0 || o.rendering;
}

export const ENGINE_PARK_MS = 60_000;

export interface TrayHooks {
  productName: string;
  iconPath: string;
  open(): void;
  quit(): void;
}

let tray: Tray | null = null;

export function installTray(h: TrayHooks): void {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(h.iconPath);
    tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
    tray.setToolTip(h.productName);
    tray.on('click', () => h.open());
    tray.on('double-click', () => h.open());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${h.productName}`, click: () => h.open() },
        { type: 'separator' },
        { label: `v${app.getVersion()}`, enabled: false },
        { label: 'Quit', click: () => h.quit() },
      ]),
    );
  } catch {
    tray = null;
  }
}

export function trayNotice(title: string, content: string): void {
  try {
    tray?.displayBalloon({ title, content, iconType: 'info' });
  } catch {
  }
}

export function destroyTray(): void {
  try {
    tray?.destroy();
  } catch {
  }
  tray = null;
}
