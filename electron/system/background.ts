// ──────────────────────────────────────────────────────────────────────
// Running in the background: start with Windows (quietly, in the tray),
// close to the tray, and the tray icon itself.
//
//  - The installer writes the startup entry (build/installer.nsh: HKCU Run,
//    value = the product name, `"<exe>" --hidden`); the app keeps it in step
//    with Settings ▸ Start with Windows on every packaged launch, under the
//    same value name, and the uninstaller removes it.
//  - `--hidden` launches with no window, only the tray icon.
//  - The audio engine pauses while the app sits in the tray (an open audio
//    stream keeps Windows from sleeping) and comes back when the window
//    opens or an AI agent connects (engineNeeded, used by main).
// ──────────────────────────────────────────────────────────────────────

import { app, Menu, nativeImage, Tray } from 'electron';
import type { ActionResult } from '@shared/types';

export const HIDDEN_ARG = '--hidden';

/** Launched by the startup entry: no window, just the tray. */
export function launchedHidden(argv: readonly string[] = process.argv): boolean {
  return argv.includes(HIDDEN_ARG);
}

/**
 * Keep the Windows startup entry in step with the setting. Packaged Windows builds only (in dev the exe is
 * electron.exe). Never throws.
 */
export function syncStartWithWindows(enabled: boolean, valueName: string): ActionResult {
  if (!app.isPackaged || process.platform !== 'win32') return { ok: true };
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [HIDDEN_ARG], name: valueName });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Couldn't ${enabled ? 'add Krypt Studio to' : 'remove Krypt Studio from'} Windows startup: ${(err as Error)?.message ?? err}` };
  }
}

/** The audio engine runs while the window is open, an agent is connected, or an export is rendering. */
export function engineNeeded(o: { windowVisible: boolean; agents: number; rendering: boolean }): boolean {
  return o.windowVisible || o.agents > 0 || o.rendering;
}

/** How long the app sits in the tray before the engine pauses (a quick hide / show doesn't restart it). */
export const ENGINE_PARK_MS = 60_000;

export interface TrayHooks {
  productName: string;
  iconPath: string;
  open(): void;
  quit(): void;
}

let tray: Tray | null = null;

/** The tray icon: click opens the window; the menu has Open and Quit. Never throws. */
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

/** A one-off note from the tray icon (Windows notification). */
export function trayNotice(title: string, content: string): void {
  try {
    tray?.displayBalloon({ title, content, iconType: 'info' });
  } catch {
    /* the note is a courtesy */
  }
}

export function destroyTray(): void {
  try {
    tray?.destroy();
  } catch {
    /* already gone */
  }
  tray = null;
}
