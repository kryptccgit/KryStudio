// ──────────────────────────────────────────────────────────────────────
// Krypt Studio main process bootstrap.
//
//   single-instance lock ─▶ DocHost (the ONE authoritative document)
//     ─▶ ProjectService (files, autosave, crash recovery)
//     ─▶ EngineSupervisor + bridge (Rust sidecar, NDJSON)
//     ─▶ IPC (ipc.ts) ─▶ frameless main window (app:// when packaged)
//     ─▶ MCP server + built-in agent (electron/mcp, electron/agent), with
//        the File access policy for agent paths (mcp/consent.ts)
//     ─▶ cover art + tagged exports (project/cover.ts, project/export.ts)
//     ─▶ Discord presence (best-effort)
// ──────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, Menu, nativeTheme, dialog, session } from 'electron';
import path from 'node:path';
import { DocHost } from '@shared/doc/DocHost';
import { CATALOG } from '@shared/plugins/catalog';
import { createDefaultProject } from '@shared/schema/factory';
import type { McpStatus, Settings } from '@shared/types';
import type { AgentController, MainDeps, McpController } from './mcp/types';
import { MCP_CHANNELS } from './mcp/types';
import { startMcp } from './mcp/index';
import { consentText, PathConsent, type ConsentChoice, type ConsentRequest } from './mcp/consent';
import { createAgent } from './agent/index';
import { registerIpc, wireBroadcasts, wireWindowEvents, broadcast, sendOpenFile, requestCoverDrawing } from './ipc';
import { createEngine } from './engine';
import type { EngineSupervisor } from './engine/supervisor';
import { ProjectService } from './project/service';
import { TabManager } from './project/tabs';
import { peekAudioProject } from './audioProject';
import { peekMashup } from './mashup';
import { peekAutomix } from './automix';
import { resolveClientContext, isDebug } from './system/context';
import { logger } from './system/logger';
import { getSettings, updateSettings, onSettingsChanged, addRecent } from './system/settings-store';
import { registerAppScheme, serveAppScheme, APP_ORIGIN } from './system/app-protocol';
import { loadWindowState, boundsOptions, trackWindowState } from './system/window-state';
import { demosDir, distDir, factoryDir, findBinary, guideImagesDir, guideVideosDir, iconPath, SHIM_EXE } from './system/paths';
import { fileSize, isFile, readBytes } from './system/files';
import { MAX_SOURCE_IMAGE_BYTES, normalizeCoverImage } from './system/images';
import { tagAudioFile } from './system/tagging';
import { CoverService } from './project/cover';
import { ExportService } from './project/export';
import { isExternalUrl, openExternal } from './system/shell';
import * as dialogs from './system/dialogs';
import { startSessionSync, stopSessionSync, syncRuntimeState } from './system/session-sync';
import { destroyTray, ENGINE_PARK_MS, engineNeeded, installTray, launchedHidden, syncStartWithWindows, trayNotice } from './system/background';
import { denyWebMidi } from './system/permissions';
import { LiveInputController } from './input/liveInput';
import { SessionController } from './session/controller';
import { HardwareController } from './midi/hardware';
import { PluginService } from './plugins';
import { createAnalyzer, type AnalyzerService } from './analyzer';
import { createLibrary, type LibraryService } from './library';
import { VocalsService } from './vocals/service';
import { createVoice } from './voice';
import { SoundsService } from './sounds/service';
import { PacksService } from './packs/service';
import { EVENT } from './channels';

const ctx = resolveClientContext();
const BG = '#0A0A0F';
/** Started by Windows startup (`--hidden`): no window until the tray icon or a second launch opens it. */
const startHidden = launchedHidden();
/** A real quit is under way (tray Quit, File ▸ Exit, shutdown): closing the window no longer hides it. */
let quitting = false;

// Must run before 'ready': the privileged app:// scheme for the packaged renderer.
registerAppScheme();

let mainWindow: BrowserWindow | null = null;
let rendererListening = false;
const queuedOpen: string[] = [];

let doc: DocHost | null = null;
let project: ProjectService | null = null;
let tabs: TabManager | null = null;
let engine: EngineSupervisor | null = null;
let mcp: McpController | null = null;
let agent: AgentController | null = null;
let analyzer: AnalyzerService | null = null;
let library: LibraryService | null = null;
let mcpClients = 0;

// ── Single instance + file association ───────────────────────────────

/** .kstudio paths from a process argv (drops the exe, flags and dev args). */
function projectArgs(argv: string[], cwd = process.cwd()): string[] {
  return argv
    .slice(1)
    .filter((a) => a && !a.startsWith('-') && /\.kstudio$/i.test(a))
    .map((a) => path.resolve(cwd, a))
    .filter(isFile);
}

function deliverOpenFiles(paths: string[]): void {
  if (paths.length === 0) return;
  const win = mainWindow;
  if (win && !win.isDestroyed() && rendererListening && !win.webContents.isLoading()) {
    for (const p of paths) sendOpenFile(win.webContents, p);
  } else {
    queuedOpen.push(...paths);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    showMainWindow();
    deliverOpenFiles(projectArgs(argv, cwd)); // queued if the window isn't listening yet
  });
  queuedOpen.push(...projectArgs(process.argv));
  app.whenReady().then(bootstrap).catch((err) => {
    logger.error(`Startup failed: ${(err as Error)?.stack ?? err}`);
    dialog.showErrorBox(ctx.productName, `Krypt Studio couldn't start:\n\n${(err as Error)?.message ?? err}`);
    app.exit(1);
  });
}

// ── Windows ──────────────────────────────────────────────────────────

const devUrl = process.env.VITE_DEV_SERVER_URL;
const rendererOrigin = (): string => (devUrl ? new URL(devUrl).origin : APP_ORIGIN);

function preloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

function securePrefs(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    devTools: !app.isPackaged || isDebug(),
  };
}

/** dockview popouts: our own popout.html on the renderer's origin, nothing else. */
function isPopoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === rendererOrigin() && /\/popout\.html$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function applyZoom(win: BrowserWindow, s: Settings = getSettings()): void {
  if (!win.isDestroyed()) win.webContents.setZoomFactor(Math.max(0.5, Math.min(2, s.ui.scale || 1)));
}

/** Navigation lock + devtools key (dev) for any of our windows. */
function hardenContents(win: BrowserWindow): void {
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || (app.isPackaged && !isDebug())) return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) wc.toggleDevTools();
  });
  wc.on('did-finish-load', () => applyZoom(win));
}

function createMainWindow(): BrowserWindow {
  const st = loadWindowState();
  const win = new BrowserWindow({
    ...boundsOptions(st),
    minWidth: 960,
    minHeight: 600,
    frame: false, // the renderer draws the title bar (-webkit-app-region: drag)
    backgroundColor: BG,
    title: ctx.productName,
    icon: iconPath(),
    show: false,
    webPreferences: securePrefs(),
  });
  if (st.maximized) win.maximize();
  trackWindowState(win);
  wireWindowEvents(win);
  hardenContents(win);

  const reveal = (): void => {
    if (startHidden) return; // stays in the tray until opened
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      win.focus();
    }
  };
  win.once('ready-to-show', reveal);
  const revealTimer = setTimeout(reveal, 5000);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`Main window failed to load ${url}: ${code} ${desc}`);
    reveal();
  });
  win.webContents.on('did-start-loading', () => {
    rendererListening = false; // a reload re-subscribes and re-drains the queue
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPopoutUrl(url)) {
      return {
        action: 'allow',
        // `frame=no` in window.open features is honoured (Electron parses features).
        overrideBrowserWindowOptions: {
          parent: win,
          backgroundColor: BG,
          autoHideMenuBar: true,
          title: ctx.productName,
          icon: iconPath(),
          minWidth: 240,
          minHeight: 160,
          webPreferences: securePrefs(),
        },
      };
    }
    if (isExternalUrl(url)) void openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.setMenuBarVisibility(false);
    hardenContents(child);
    wireWindowEvents(child);
  });

  // Unsaved-changes guard (Alt+F4, taskbar close, and the renderer's close button). With project tabs, unsaved
  // projects are kept for the next launch (userData/session) instead of asking; the question only comes back
  // when they couldn't be written.
  let closeConfirmed = false;
  win.on('close', (e) => {
    // Closing the window keeps Krypt Studio running in the tray; only a real quit goes on to the unsaved check.
    if (!quitting) {
      e.preventDefault();
      hideToTray(win);
      return;
    }
    if (closeConfirmed || !project) return;
    const t = tabs;
    const unsaved = t ? t.state().tabs.some((x) => x.dirty) : project.status().dirty;
    if (!unsaved) return;
    e.preventDefault();
    void (async () => {
      if (t) {
        const kept = await t.saveSession({ active: true });
        if (kept.ok) {
          closeConfirmed = true;
          win.close();
          return;
        }
        logger.error(`Closing: the open tabs couldn't be kept for next time (${kept.message ?? 'unknown error'}); asking instead`);
      }
      const choice = await dialogs.confirmUnsaved(project!.status().name, win);
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const r = await project!.save(win);
        if (!r.ok) {
          if (!/cancelled/i.test(r.message ?? '')) dialog.showErrorBox('Save failed', r.message ?? 'Unknown error');
          return;
        }
      }
      closeConfirmed = true;
      win.close();
    })();
  });
  win.on('show', () => updateEnginePark());
  win.on('hide', () => updateEnginePark());
  win.on('closed', () => {
    clearTimeout(revealTimer);
    if (mainWindow === win) mainWindow = null;
    app.quit(); // closing the main window ends the session (popouts are its children)
  });

  if (devUrl) win.loadURL(devUrl).catch((err) => logger.error(`loadURL failed: ${err}`));
  else win.loadURL(`${APP_ORIGIN}/index.html`).catch((err) => logger.error(`loadURL failed: ${err}`));
  mainWindow = win;
  return win;
}

function showMainWindow(): BrowserWindow | null {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  for (const w of BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed() && w.getParentWindow() === win && hiddenPopouts.has(w.id)) w.show();
  hiddenPopouts.clear();
  return win;
}

// ── Background: the tray and the paused engine (electron/system/background.ts) ──

const hiddenPopouts = new Set<number>();

/** Close to the tray: playback stops, the windows hide, the first time a note says where it went. */
function hideToTray(win: BrowserWindow): void {
  if (engine?.isPlaying()) void engine.request({ cmd: 'transport', action: 'stop' });
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== win && !w.isDestroyed() && w.getParentWindow() === win && w.isVisible()) {
      hiddenPopouts.add(w.id);
      w.hide();
    }
  }
  win.hide();
  if (!getSettings().ui.trayNoticeShown) {
    trayNotice(`${ctx.productName} is still running`, 'It’s in the tray, by the clock. Click the icon to open it, or right-click ▸ Quit to close it.');
    updateSettings({ ui: { ...getSettings().ui, trayNoticeShown: true } });
  }
}

/** A real quit from the tray menu, File ▸ Exit or a second "quit" request. */
function quitApp(): void {
  quitting = true;
  app.quit();
}

let enginePaused = false;
let parkTimer: NodeJS.Timeout | null = null;

/** Pause the audio engine while nothing needs it (an open audio stream keeps Windows awake); resume when something does. */
function updateEnginePark(): void {
  if (!engine || quitting) return;
  const win = mainWindow;
  const needed = engineNeeded({ windowVisible: !!win && !win.isDestroyed() && win.isVisible(), agents: mcpClients, rendering: engine.isRendering() });
  if (needed) {
    if (parkTimer) clearTimeout(parkTimer);
    parkTimer = null;
    if (enginePaused) {
      enginePaused = false;
      logger.info('Audio engine resuming');
      engine.start();
    }
    return;
  }
  if (enginePaused || parkTimer) return;
  parkTimer = setTimeout(() => {
    parkTimer = null;
    const w = mainWindow;
    if (!engine || quitting || engineNeeded({ windowVisible: !!w && !w.isDestroyed() && w.isVisible(), agents: mcpClients, rendering: engine.isRendering() })) return;
    enginePaused = true;
    logger.info('Audio engine paused while Krypt Studio is in the tray');
    void engine.stop();
  }, ENGINE_PARK_MS);
  parkTimer.unref?.();
}

// ── Presence + window title (fed by the same runtime context) ────────

function refreshSession(): void {
  if (!project) return;
  const s = project.status();
  // The active project tab ("Untitled 2", a song title …); the window title and Discord follow it.
  const name = tabs?.activeTitle() ?? s.name;
  const playing = engine?.isPlaying() ?? false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${name}${s.dirty ? ' *' : ''} - ${ctx.productName}`);
  // The shared Krypt Discord app doesn't name the tool: the first line does ("Using Krypt Studio", kryptguidelines §8).
  syncRuntimeState(`Using ${ctx.productName}`, `${playing ? 'Playing' : 'Editing'} ${name}${mcpClients > 0 ? ` · AI agent${mcpClients > 1 ? `s (${mcpClients})` : ''}` : ''}`);
}

/** MainDeps.broadcast: fan out to renderers, and watch MCP client counts for presence. */
function broadcastFromModules(channel: string, payload: unknown): void {
  broadcast(channel, payload);
  if (channel === MCP_CHANNELS.status) {
    const n = Array.isArray((payload as McpStatus | undefined)?.clients) ? (payload as McpStatus).clients.length : 0;
    if (n !== mcpClients) {
      mcpClients = n;
      refreshSession();
      updateEnginePark();
    }
  }
}

// ── File access for agents (electron/mcp/consent.ts) ─────────────────

/**
 * Dev-only e2e hook, ignored in packaged builds: KRYPT_TEST_CONSENT=file|folder|deny[@ms] shows the real
 * dialog, then closes it after ms (default 1500) with that answer; KRYPT_TEST_CONSENT=none leaves it unanswered.
 * KRYPT_CONSENT_TIMEOUT_MS shortens the 120 s answer window.
 */
function consentTestHook(): { answer: ConsentChoice | null; afterMs: number } | null {
  if (app.isPackaged) return null;
  const m = /^(file|folder|deny|none)(?:@(\d+))?$/.exec(process.env.KRYPT_TEST_CONSENT ?? '');
  return m ? { answer: m[1] === 'none' ? null : (m[1] as ConsentChoice), afterMs: Number(m[2] ?? 1500) } : null;
}

function consentTimeoutMs(): number | undefined {
  const n = app.isPackaged ? NaN : Number(process.env.KRYPT_CONSENT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

/** Krypt Studio's own permission dialog (used when the agent's client can't ask through MCP elicitation). */
async function askFileAccessInApp(req: ConsentRequest, signal: AbortSignal): Promise<ConsentChoice | null> {
  const t = consentText(req);
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const hook = consentTestHook();
  let hooked: ConsentChoice | null = null;
  const timer = hook?.answer
    ? setTimeout(() => {
        hooked = hook.answer;
        logger.warn(`File access dialog answered "${hook.answer}" by the KRYPT_TEST_CONSENT dev hook`);
        ac.abort();
      }, hook.afterMs)
    : undefined;
  try {
    const deny = t.choices.length - 1;
    const i = await dialogs.askPermission({ title: t.title, message: t.message, detail: t.detail, buttons: t.choices.map((c) => c.label), defaultId: deny, cancelId: deny, signal: ac.signal, win: mainWindow });
    if (hooked) return hooked;
    if (signal.aborted || i === null) return null; // timed out (the consent gate reports it) or couldn't be shown
    return t.choices[i]?.value ?? 'deny';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  nativeTheme.themeSource = 'dark';
  // macOS routes Cmd+C / V / X / A / Q through the app menu: without one, text fields can't copy or paste.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'cc.krypt.studio' : process.execPath);
  serveAppScheme(distDir(), guideVideosDir(), guideImagesDir());
  denyWebMidi(session.defaultSession); // the engine owns MIDI devices (WinMM is single-client)
  logger.info(`${ctx.productName} ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'dev'}, mark ${ctx.mark})`);

  const userDataDir = app.getPath('userData');
  const fDir = factoryDir();
  const packsDir = path.join(userDataDir, 'packs');

  doc = new DocHost(createDefaultProject('Untitled'), CATALOG, { strict: !app.isPackaged });
  // Third-party VST3/CLAP plugins: registers the scan cache into CATALOG before any project loads.
  const plugins = new PluginService({
    doc,
    userDataDir,
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
    ownerHwnd: () => {
      const w = mainWindow;
      if (!w || w.isDestroyed()) return null;
      const b = w.getNativeWindowHandle();
      return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
    },
    broadcast: (s) => broadcast(EVENT.pluginsChanged, s),
    pickFolder: () => dialogs.pickDirectory({ title: 'Add a VST3 / CLAP plugin folder', win: mainWindow }),
  });
  project = new ProjectService({
    doc,
    appVersion: app.getVersion(),
    userDataDir,
    factoryDir: fDir,
    packsDir,
    documentsDir: app.getPath('documents'),
    getSettings,
    addRecent,
    log: (level, m) => logger.log(level, m),
    beforeSave: () => plugins.beforeSave(),
    templateDirs: [demosDir(), fDir],
  });
  const proj = project;
  const created = createEngine({
    doc,
    audioSettings: () => getSettings().audio,
    resolveSamplePath: (p) => proj.resolveSamplePath(p),
    packsDir,
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
    beforeLoad: async () => {
      await plugins.syncEngine();
    },
  });
  engine = created.engine;
  plugins.attachEngine(engine);
  const shimExePath = findBinary(SHIM_EXE);

  // MIDI inputs, record arm, controller links, recorded takes → document.
  const liveInput = new LiveInputController({
    doc,
    engine,
    getSettings,
    updateSettings,
    onSettingsChanged,
    recordDir: () => {
      const p = proj.status().path;
      return path.join(p ? path.dirname(p) : userDataDir, 'recordings');
    },
    projectName: () => proj.status().name,
    broadcast: (channel, payload) => broadcast(channel, payload),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });
  liveInput.start();

  // Clip launcher runtime: launch / stop, launch recording → playlist, grid controller note map.
  const launcher = new SessionController({
    doc,
    engine,
    getSettings,
    updateSettings,
    onSettingsChanged,
    broadcast: (channel, payload) => broadcast(channel, payload),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });
  launcher.start();

  // MIDI outputs, clock out, sync in, grid-controller LEDs (Wave 12.2b).
  const hardware = new HardwareController({
    doc,
    engine,
    getSettings,
    updateSettings,
    onSettingsChanged,
    broadcast: (channel, payload) => broadcast(channel, payload),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });
  hardware.start();

  // On-device audio ML (krypt-studio-analyzer.exe, spawned on first use) + Model Manager.
  const eng = engine;
  analyzer = createAnalyzer({
    doc,
    userDataDir,
    resolveSamplePath: (p) => proj.resolveSamplePath(p),
    sampleInfo: (p) => eng.sampleInfo(p),
    broadcast: (s) => broadcast(EVENT.analyzerState, s),
    pickFolder: (title) => dialogs.pickDirectory({ title, win: mainWindow }),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });
  const analyzerReady = analyzer.init().catch((err) => logger.error(`Model Manager start-up failed: ${(err as Error)?.message ?? err}`));

  // Reference library (the user's own songs → features, style profiles, focus); shares the analyzer and starts once
  // its models are verified. Queued analysis resumes a few seconds later.
  const lib = createLibrary({
    doc,
    userDataDir,
    analyzer,
    getSettings,
    updateSettings,
    sampleInfo: (p) => eng.sampleInfo(p),
    pickFolder: (title) => dialogs.pickDirectory({ title, win: mainWindow }),
    pickFiles: (title, extensions) => dialogs.openFiles({ title, multi: true, filters: [{ name: 'Audio', extensions: [...extensions] }], win: mainWindow }),
    broadcast: (s) => broadcast(EVENT.libraryState, s),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });
  library = lib;
  void analyzerReady.then(() => lib.start());

  // Vocals & mashups (import audio, match key & tempo, Krypt Tune): MCP tools and the clip menu share it.
  const vocals = new VocalsService({
    doc,
    userDataDir,
    analyzer,
    sampleInfo: (p) => eng.sampleInfo(p),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });

  // Krypt Voice (research/21): speech + "Sing my notes" (Local: Kokoro in the analyzer; Cloud: Fish Audio with the
  // user's own key, stored with safeStorage). "My voice" only from this session's recorder takes.
  const voice = createVoice({
    doc,
    userDataDir,
    analyzer,
    vocals,
    sampleInfo: (p) => eng.sampleInfo(p),
    recorder: liveInput,
    audition: (p) => eng.request({ cmd: 'previewFile', path: p }),
    broadcastState: (s) => broadcast(EVENT.voiceState, s),
    broadcastProgress: (pr) => broadcast(EVENT.voiceProgress, pr),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
  });
  void voice.init().catch((err) => logger.warn(`Krypt Voice start-up cleanup failed: ${(err as Error)?.message ?? err}`));

  // Cover art (bytes kept with the project, drawn by the main window on an agent's request) + tagged exports.
  const covers = new CoverService({
    project: proj,
    normalize: (bytes) => normalizeCoverImage(bytes),
    fileSize,
    readFile: readBytes,
    draw: (req) => requestCoverDrawing(req),
    maxSourceBytes: MAX_SOURCE_IMAGE_BYTES,
  });
  const exporter = new ExportService({
    doc,
    engine,
    project: proj,
    getSettings,
    musicDir: app.getPath('music'),
    tag: tagAudioFile,
    log: (level, m) => logger.log(level, m),
  });

  // Presets (factory + userData/presets) and the factory sample index: the preset UI and the MCP sound tools.
  const sounds = new SoundsService({
    doc,
    userDataDir,
    factoryDir: fDir,
    getSettings,
    broadcast: (s) => broadcast(EVENT.soundsState, s),
    log: (level, m) => logger.log(level, m),
    // Installed sample packs join the sample index (find_samples, load_sample, the playbook picks, add_transition).
    packSamples: () => packs.samples(),
    profileDirs: () => (['documents', 'music', 'desktop', 'downloads'] as const).map((k) => {
      try {
        return app.getPath(k);
      } catch {
        return '';
      }
    }),
  });

  // Sound packs (userData/packs): downloaded only when the user clicks Download (IPC); agents read the status.
  const bridge = created.bridge;
  const packs = new PacksService({
    dir: packsDir,
    broadcast: (s) => broadcast(EVENT.packsState, s),
    log: (level, m) => (level === 'debug' ? logger.debug(m) : logger.log(level, m)),
    // The engine got the pack's paths before the files existed: reload so channels using the pack play now.
    onInstalled: (id) => {
      const d = doc!;
      const uses = Object.values(d.project.samples).some((s) => s.path.startsWith(`pack:${id}/`));
      if (uses && eng.isAlive()) void bridge.load().then((r) => !r.ok && logger.warn(`Reloading the project after installing a sound pack failed: ${r.message ?? 'unknown error'}`));
    },
  });
  void packs.refresh();

  // Project tabs (research/19-project-tabs.md): several projects open, one in the DocHost; switching away is refused
  // while the active one is busy. New / Open / Audio → Project / Auto Mashup open tabs through the project service.
  const tabManager = new TabManager({
    doc,
    project: proj,
    sessionDir: path.join(userDataDir, 'session'),
    appVersion: app.getVersion(),
    stopTransport: () => {
      if (eng.isPlaying()) void eng.request({ cmd: 'transport', action: 'stop' });
    },
    broadcast: (s) => {
      broadcast(EVENT.tabsState, s);
      refreshSession();
    },
    log: (level, m) => logger.log(level, m),
    beforeSwitch: () => plugins.beforeSave(),
    guards: [
      ({ title }) => (agent?.isBusy?.() ? { busy: 'Krypt Agent is working', message: `The Krypt Agent is working on "${title}": wait for it or press Stop in the Agents panel.` } : null),
      ({ title }) =>
        liveInput.isRecordingTake() || (eng.isPlaying() && (liveInput.status().armed || launcher.isRecording()))
          ? { busy: 'Recording', message: `Recording is running in "${title}": stop it first, then switch projects.` }
          : null,
      ({ title }) => {
        const job = peekAudioProject(doc!)?.busy;
        return job ? { busy: 'Building from audio…', message: `Audio → Project is building "${job}" in "${title}": wait for it or cancel it.` } : null;
      },
      ({ title }) => {
        const job = peekMashup(doc!)?.busy;
        return job ? { busy: 'Building the mashup…', message: `Auto Mashup is building "${job}" in "${title}": wait for it or cancel it.` } : null;
      },
      ({ title }) => {
        const job = peekAutomix(doc!)?.busy;
        return job ? { busy: 'Auto Mix is working…', message: `${job} is measuring and mixing "${title}": wait for it or cancel it.` } : null;
      },
      ({ title }) => (eng.isRendering() ? { busy: 'Rendering…', message: `"${title}" is being rendered: wait for the export to finish.` } : null),
      ({ title }) => {
        const job = voice.busy();
        return job ? { busy: 'Krypt Voice…', message: `Krypt Voice is working on "${job}" for "${title}": wait for it or press Cancel.` } : null;
      },
    ],
  });
  tabs = tabManager;

  registerIpc({
    doc,
    engine,
    project,
    tabs: tabManager,
    covers,
    exporter,
    sounds,
    packs,
    browser: { factoryDir: fDir, demosDir: demosDir(), getSettings, updateSettings },
    getSettings,
    updateSettings,
    mcp: () => mcp,
    agent: () => agent,
    shimExePath,
    takeQueuedOpenFiles: () => {
      rendererListening = true;
      return queuedOpen.splice(0);
    },
    quit: quitApp,
    liveInput,
    session: launcher,
    hardware,
    plugins,
    analyzer,
    vocals,
    voice,
    library: lib,
  });
  wireBroadcasts({ doc, engine, project, onSettingsChanged: (fn) => onSettingsChanged((s) => fn(s)) });

  onSettingsChanged((s, prev) => {
    if ((s.ui.startWithWindows !== false) !== (prev.ui.startWithWindows !== false)) {
      const r = syncStartWithWindows(s.ui.startWithWindows !== false, ctx.productName);
      if (!r.ok) logger.warn(r.message ?? 'Windows startup entry not updated');
    }
    if (s.autosaveSec !== prev.autosaveSec) proj.rescheduleAutosave();
    if (s.ui.scale !== prev.ui.scale) for (const w of BrowserWindow.getAllWindows()) applyZoom(w, s);
    // The focus can also change through settings.update: keep LibraryState.focus in step.
    if (JSON.stringify(s.library?.focus ?? null) !== JSON.stringify(prev.library?.focus ?? null)) lib.notify();
  });

  let lastEngineState = '';
  engine.onStatus((s) => {
    const key = `${s.state}|${s.message ?? ''}`;
    if (key === lastEngineState) return;
    lastEngineState = key;
    const line = `Audio engine ${s.state}${s.message ? `: ${s.message}` : ''}${s.state === 'running' && s.device?.name ? ` (${s.device.name}, ${s.device.sampleRate} Hz)` : ''}`;
    if (s.state === 'failed') logger.error(line);
    else if (s.state === 'running' || s.state === 'stopped') logger.info(line);
    else logger.debug(line);
  });

  await project.boot((crashed) => tabManager.restore(crashed));
  // A hidden start (Windows startup) leaves the engine paused until the window opens or an agent connects.
  if (startHidden) {
    enginePaused = true;
    logger.info('Started in the tray (Windows startup); the audio engine starts when it is needed');
  } else engine.start();
  createMainWindow();
  installTray({ productName: ctx.productName, iconPath: iconPath(), open: () => void showMainWindow(), quit: quitApp });
  {
    const r = syncStartWithWindows(getSettings().ui.startWithWindows !== false, ctx.productName);
    if (!r.ok) logger.warn(r.message ?? 'Windows startup entry not updated');
  }
  // Incremental plugin rescan (changed/new files only) once the UI is up.
  setTimeout(() => void plugins.rescan({ quiet: true }), 3000).unref();

  project.onStatus(() => refreshSession());
  engine.onPlaying(() => refreshSession());
  // Discord presence is always on (kryptguidelines §8); best effort, retried while Discord is closed.
  void startSessionSync();
  refreshSession();

  // Agents asking for files outside the Browser folders: the client asks (MCP elicitation) or this dialog does.
  const consent = new PathConsent({
    getSettings,
    updateSettings,
    log: (level, m) => logger.log(level, m),
    broadcast: broadcastFromModules,
    dialog: { where: 'Krypt Studio', ask: askFileAccessInApp },
    timeoutMs: consentTimeoutMs(),
  });

  // MCP server + built-in agent: never block the UI on them.
  const deps: MainDeps = {
    doc,
    engine,
    project,
    tabs: tabManager,
    getSettings,
    updateSettings,
    broadcast: broadcastFromModules,
    userDataDir,
    appExePath: process.execPath,
    shimExePath,
    log: (level, m) => logger.log(level, m),
    plugins,
    analyzer,
    library: lib,
    vocals,
    voice,
    consent,
    covers,
    exporter,
    sounds,
    packs,
    session: launcher,
    hardware,
    recorder: liveInput,
  };
  try {
    mcp = await Promise.resolve(startMcp(deps));
  } catch (err) {
    logger.error(`MCP server failed to start: ${(err as Error)?.message ?? err}`);
  }
  try {
    agent = await Promise.resolve(createAgent(deps));
  } catch (err) {
    logger.error(`Agent panel backend failed to start: ${(err as Error)?.message ?? err}`);
  }
  if (mcp) {
    try {
      broadcastFromModules(MCP_CHANNELS.status, mcp.status());
    } catch {
      /* status is best-effort */
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────

let shutdownDone = false;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  stopSessionSync();
  destroyTray();
  if (parkTimer) clearTimeout(parkTimer);
  const steps: Array<Promise<unknown>> = [];
  // Quitting goes on regardless; a step that fails is logged so it can be found later.
  const failed = (what: string) => (err: unknown) => logger.warn(`Shutdown: ${what} failed to stop: ${(err as Error)?.message ?? err}`);
  if (mcp) steps.push(Promise.resolve().then(() => mcp!.stop()).catch(failed('MCP server')));
  if (engine) steps.push(engine.stop().catch(failed('audio engine')));
  // The library cancels its analyzer jobs and deletes its temporary stems before the analyzer goes.
  const lib = library;
  const ears = analyzer;
  if (lib || ears) steps.push((lib ? lib.stop().catch(failed('library')) : Promise.resolve()).then(() => ears?.stop()).catch(failed('analyzer')));
  const timedOut = await Promise.race([Promise.all(steps).then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 4000))]);
  if (timedOut) logger.warn('Shutdown: services took more than 4 s to stop; quitting anyway');
  // Project tabs keep every open project for the next launch, then crash recovery ends (kept if that failed).
  if (tabs) await tabs.shutdown().catch((err) => logger.error(`Shutdown: keeping the open tabs failed: ${(err as Error)?.message ?? err}`));
  else await project?.shutdown(true);
  logger.info('Clean shutdown');
}

app.on('before-quit', () => {
  quitting = true; // closing the windows now really closes them
});

app.on('window-all-closed', () => app.quit());

// macOS: clicking the Dock icon brings the window back from the tray / menu bar.
app.on('activate', () => {
  if (app.isReady()) showMainWindow();
});

app.on('will-quit', (e) => {
  if (shutdownDone) return;
  e.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown()
    .catch((err) => logger.error(`Shutdown failed: ${(err as Error)?.stack ?? err}`))
    .finally(() => {
      shutdownDone = true;
      app.quit();
    });
});

// Crash diagnostics: log instead of dying silently (no telemetry; the log is the record).
process.on('uncaughtException', (err) => logger.error(`uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (reason) => logger.error(`unhandledRejection: ${(reason as Error)?.stack ?? String(reason)}`));

const rendererCrashes: number[] = [];
app.on('render-process-gone', (_e, wc, details) => {
  logger.error(`Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
  if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed() || wc !== mainWindow.webContents) return;
  const now = Date.now();
  while (rendererCrashes.length && now - rendererCrashes[0] > 60_000) rendererCrashes.shift();
  rendererCrashes.push(now);
  // The document lives in main, so a reload loses nothing.
  if (rendererCrashes.length <= 3) setTimeout(() => mainWindow?.webContents.reload(), 300);
});
app.on('child-process-gone', (_e, details) => {
  if (details.reason !== 'clean-exit') logger.warn(`Child process gone: ${details.type}${details.name ? `/${details.name}` : ''} ${details.reason}`);
});
