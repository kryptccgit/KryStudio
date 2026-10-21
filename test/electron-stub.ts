// What `import … from 'electron'` resolves to in unit tests (scripts/run-tests.mjs
// aliases it here). The real package's index.js only works inside Electron, so a
// module that merely imports Electron (e.g. electron/project/service.ts through
// system/dialogs.ts) could not be tested at all. These empty stand-ins let such
// modules load; actually calling into Electron fails loudly (undefined is not a
// function), which a test never does on purpose.

const none = {} as Record<string, never>;

export const app = none;
export const BrowserWindow = none;
export const Menu = none;
export const contextBridge = none;
export const dialog = none;
export const ipcMain = none;
export const ipcRenderer = none;
export const nativeImage = none;
export const nativeTheme = none;
export const net = none;
export const protocol = none;
export const safeStorage = none;
export const screen = none;
export const session = none;
export const shell = none;
export const Tray = none;
export const webUtils = none;

export default none;
