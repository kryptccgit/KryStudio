// ──────────────────────────────────────────────────────────────────────
// IPC contract: EVERY ipcMain handler lives in this file (kryptguidelines
// §4.3), mirrored by preload.ts; channel names come from channels.ts.
// Handlers return ActionResult-style values and never throw across IPC.
// Broadcasts go to BrowserWindow.getAllWindows() (main + popouts).
// ──────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { SYSTEM, USER, type Actor, type DocHost } from '@shared/doc/DocHost';
import { MP3_BITRATES, type ActionResult, type AnalyzerState, type AudioProjectOptions, type AudioTarget, type CoverDrawResult, type ExecOpts, type McpStatus, type Mp3Kbps, type PluginTarget, type RenderOptions, type Settings, type SimilarQuery } from '@shared/types';
import type { DeviceInfo, Peaks } from '@shared/engine/protocol';
import type { AgentController, MainDeps, McpController } from './mcp/types';
import type { EngineSupervisor } from './engine/supervisor';
import type { ProjectService } from './project/service';
import type { TabManager } from './project/tabs';
import type { LiveInputController } from './input/liveInput';
import type { PluginService } from './plugins';
import type { AnalyzerService } from './analyzer';
import type { LibraryService } from './library';
import { userGroupApply, type VocalsService } from './vocals/service';
import type { VoiceService } from './voice/service';
import type { SingRequest, SpeakRequest } from '@shared/voice/types';
import type { LibraryState, TrackQuery } from '@shared/library/types';
import type { CoverService } from './project/cover';
import { extensionFor, type ExportService } from './project/export';
import type { SoundsService } from './sounds/service';
import type { PacksService } from './packs/service';
import { INVOKE, SEND, EVENT } from './channels';
import { addRoot, browserRoots, listInRoots, removeRoot, type BrowserDeps } from './browser';
import * as dialogs from './system/dialogs';
import { openExternal, showItemInFolder } from './system/shell';
import { logger } from './system/logger';
import { audioProjectFor } from './audioProject';
import { cleanMashupRequest, mashupFor } from './mashup';
import { automixFor, cleanAlbumExportRequest, cleanAlbumRequest, cleanAutoMixRequest, cleanMasterFileRequest } from './automix';
import type { MashupRequest, MashupSource } from '@shared/mashup/types';
import { AUDIO_EXTENSIONS, isAudioFile } from '@shared/audio/formats';
import { browserFileAccess, findSimilar, similarDepsFor } from './sounds/similar';
import { classifyUserSample } from './mcp/tools/discovery';
import { cleanSliceOptions, sliceToPads } from './racks/slice';
import type { SessionController } from './session/controller';
import type { HardwareController } from './midi/hardware';
import { launchGridSettings } from '@shared/live/launchGrid';
import { midiOutSettings } from '@shared/live/midiOut';
import { VIRTUAL_DEVICE_PREFIX, isVirtualMidi } from '@shared/live/controllers';
import { autoWarpChannel } from './warp/autoWarp';
import { userApply } from './analyzer/service';
import { WARP_MODES, type WarpMode } from '@shared/schema/warp';
import { cleanRunRequest, ScriptService } from './scripts/service';
import { ensureDir } from './system/files';
import { isAgentProvider } from '@shared/agent/providers';

export interface IpcDeps {
  doc: DocHost;
  engine: EngineSupervisor;
  project: ProjectService;
  browser: BrowserDeps;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  mcp(): McpController | null;
  agent(): AgentController | null;
  shimExePath: string | null;
  /** Open-file paths queued until a renderer subscribes. */
  takeQueuedOpenFiles(): string[];
  /** A real quit (File ▸ Exit): closing the main window only hides it to the tray. */
  quit(): void;
  /** MIDI inputs, record arm, controller links (electron/input/liveInput.ts). */
  liveInput?: LiveInputController;
  /** Third-party VST3 / CLAP plugins (electron/plugins). */
  plugins?: PluginService;
  /** On-device audio ML: analysis, stems, transcription, Model Manager (electron/analyzer). */
  analyzer?: AnalyzerService;
  /** Reference library: collections, analysis queue, profiles, focus, originality (electron/library). */
  library?: LibraryService;
  /** Vocals & mashups: Krypt Tune on a clip, match key & tempo (electron/vocals). */
  vocals?: VocalsService;
  /** The project's cover image (electron/project/cover.ts). */
  covers?: CoverService;
  /** Exports with song info + cover embedded (electron/project/export.ts). */
  exporter?: ExportService;
  /** Presets (factory + user), the factory sample index, sample-folder suggestions (electron/sounds). */
  sounds?: SoundsService;
  /** Sound packs: download / cancel / remove / reveal, from the user's clicks only (electron/packs). */
  packs?: PacksService;
  /** Clip launcher runtime: launch / stop / launch recording / grid controller (electron/session). */
  session?: SessionController;
  /** MIDI outputs, clock out, sync in, grid LEDs (electron/midi/hardware.ts). */
  hardware?: HardwareController;
  /** Krypt Voice: speak, sing my notes, the Fish key, my voice (electron/voice). */
  voice?: VoiceService;
  /** Project tabs (electron/project/tabs.ts): New / Open / the tab strip. */
  tabs?: TabManager;
}

// ── Cover drawing requests (main → the main window → main) ────────────

const COVER_DRAW_TIMEOUT_MS = 30_000;
const coverRequests = new Map<string, { resolve: (r: CoverDrawResult) => void; timer: NodeJS.Timeout; wc: number }>();

/** The main window (not a dockview popout). */
function mainAppWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.getParentWindow() && !w.webContents.isDestroyed()) ?? null;
}

/**
 * Ask the main window to draw a generated cover (canvas, so the Chakra Petch font is there) for an agent's
 * set_cover {generate}. Resolves with the window's answer, or ok:false when there is no window or it doesn't
 * answer within 30 s. Never rejects.
 */
export function requestCoverDrawing(req: { style?: string; seed?: number }): Promise<CoverDrawResult> {
  const win = mainAppWindow();
  if (!win || win.webContents.isLoading()) {
    return Promise.resolve({ ok: false, message: "Krypt Studio's window isn't open (or is still loading), so it can't draw a cover. Pass path (a PNG / JPEG) instead, or try again in a moment." });
  }
  const id = crypto.randomUUID();
  return new Promise<CoverDrawResult>((resolve) => {
    const timer = setTimeout(() => {
      coverRequests.delete(id);
      resolve({ ok: false, message: `Krypt Studio's window didn't draw the cover within ${COVER_DRAW_TIMEOUT_MS / 1000} s.` });
    }, COVER_DRAW_TIMEOUT_MS);
    coverRequests.set(id, { resolve, timer, wc: win.webContents.id });
    sendTo(win.webContents, EVENT.coverRequest, { id, style: req.style, seed: req.seed });
  });
}

/** A renderer's answer, checked field by field (never trust IPC payloads). */
function coverDrawResult(v: unknown): CoverDrawResult {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (o.ok === true && o.bytes instanceof Uint8Array && (o.mime === 'image/png' || o.mime === 'image/jpeg')) {
    return { ok: true, bytes: o.bytes, mime: o.mime, style: typeof o.style === 'string' ? o.style.slice(0, 32) : 'generated', seed: Number.isInteger(o.seed) ? (o.seed as number) : 0 };
  }
  return { ok: false, message: typeof o.message === 'string' && o.message ? o.message.slice(0, 300) : "The window couldn't draw the cover" };
}

// ── Broadcast helpers ─────────────────────────────────────────────────

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try {
      w.webContents.send(channel, payload);
    } catch {
      /* a window mid-teardown */
    }
  }
}

export function sendTo(wc: WebContents, channel: string, payload?: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, payload);
}

/** Forward window maximize state changes to that window's renderer. */
export function wireWindowEvents(win: BrowserWindow): void {
  const send = (): void => {
    if (!win.isDestroyed()) sendTo(win.webContents, EVENT.appMaximizedChanged, win.isMaximized());
  };
  win.on('maximize', send);
  win.on('unmaximize', send);
  win.on('enter-full-screen', send);
  win.on('leave-full-screen', send);
}

export function sendOpenFile(wc: WebContents, filePath: string): void {
  sendTo(wc, EVENT.appOpenFile, filePath);
}

// ── Helpers ───────────────────────────────────────────────────────────

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** ipcMain.handle with a catch-all: a thrown error becomes {ok:false,message}. */
function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return await fn(e, ...args);
    } catch (err) {
      logger.error(`[ipc] ${channel} failed: ${errText(err)}`);
      return { ok: false, message: errText(err) };
    }
  });
}

function winOf(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

function actorFromKey(key: string): Actor {
  if (key === 'user') return USER;
  if (key === 'system') return SYSTEM;
  const id = key.startsWith('agent:') ? key.slice(6) : key;
  return { kind: 'agent', clientId: id, name: id };
}

function execOptions(opts: ExecOpts | undefined): { actor: Actor; groupId?: string; coalesceKey?: string; label?: string } {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    actor: USER,
    groupId: typeof o.groupId === 'string' ? o.groupId : undefined,
    coalesceKey: typeof o.coalesceKey === 'string' ? o.coalesceKey : undefined,
    label: typeof o.label === 'string' ? o.label : undefined,
  };
}

function fallbackMcpStatus(shimPath: string | null): McpStatus {
  return { enabled: false, pipeName: null, http: { enabled: false, url: null }, clients: [], shimPath };
}

/** A renderer-supplied AudioTarget, checked field by field (never trust IPC payloads). */
function audioTarget(t: unknown): AudioTarget | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  if (typeof o.clipId === 'string' && o.clipId) return { clipId: o.clipId };
  if (typeof o.channelId === 'string' && o.channelId) return { channelId: o.channelId };
  if (typeof o.path === 'string' && o.path) return { path: o.path };
  return null;
}

function fallbackAnalyzerState(): AnalyzerState {
  return { available: false, running: false, pid: null, version: null, devices: [], models: [], jobs: [], modelsDir: '' };
}

function fallbackLibraryState(): LibraryState {
  return {
    collections: [],
    queue: { running: false, paused: false, phase: null, done: 0, total: 0, current: null, etaSec: null, message: 'The reference library is not available in this session (see the log)' },
    focus: null,
    dbPath: '',
  };
}

/** Renderer-supplied AudioProjectOptions, checked field by field. */
function audioProjectOptions(v: unknown): AudioProjectOptions {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const out: AudioProjectOptions = {};
  if (typeof o.keepStems === 'boolean') out.keepStems = o.keepStems;
  if (o.factor === 1 || o.factor === 0.5 || o.factor === 2) out.factor = o.factor;
  if (Array.isArray(o.parts)) {
    const parts = o.parts.filter((x): x is 'drums' | 'bass' | 'chords' | 'lead' => x === 'drums' || x === 'bass' || x === 'chords' || x === 'lead');
    if (parts.length) out.parts = [...new Set(parts)];
  }
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

const NOT_READY: ActionResult = { ok: false, message: 'The AI agent server is still starting (or failed to start; see the log).' };

// ── Registration ──────────────────────────────────────────────────────

export function registerIpc(d: IpcDeps): void {
  const { doc, engine, project } = d;

  // ───── App / window ─────────────────────────────────────────────────
  handle(INVOKE.appVersion, () => app.getVersion());
  handle(INVOKE.appOpenExternal, (_e, url: string) => openExternal(String(url ?? '')));
  handle(INVOKE.appShowItemInFolder, (_e, p: string) => showItemInFolder(String(p ?? '')));
  handle(INVOKE.appWindow, (e, action: 'minimize' | 'maximize' | 'close' | 'quit') => {
    if (action === 'quit') return void d.quit();
    const w = winOf(e);
    if (!w) return;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') {
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
    } else if (action === 'close') w.close();
  });
  handle(INVOKE.appIsMaximized, (e) => winOf(e)?.isMaximized() ?? false);
  ipcMain.removeAllListeners(SEND.appOpenFileReady);
  ipcMain.on(SEND.appOpenFileReady, (e) => {
    for (const p of d.takeQueuedOpenFiles()) sendOpenFile(e.sender, p);
  });

  // ───── Document (actor = user) ──────────────────────────────────────
  handle(INVOKE.docSnapshot, () => ({ version: doc.version, project: doc.project }));
  handle(INVOKE.docExec, (_e, cmd: string, args: unknown, opts?: ExecOpts) => {
    try {
      return doc.exec(String(cmd), args, execOptions(opts));
    } catch (err) {
      return { ok: false, message: errText(err), version: doc.version };
    }
  });
  handle(INVOKE.docExecBatch, (_e, steps: Array<{ cmd: string; args: unknown }>, opts?: ExecOpts) => {
    if (!Array.isArray(steps)) return { ok: false, message: 'execBatch needs an array of steps', version: doc.version };
    try {
      return doc.execBatch(steps, execOptions(opts));
    } catch (err) {
      return { ok: false, message: errText(err), version: doc.version };
    }
  });
  handle(INVOKE.docBeginGroup, (_e, label: string) => doc.beginGroup(USER, String(label ?? 'Edit')));
  handle(INVOKE.docEndGroup, (_e, groupId: string) => {
    doc.endGroup(String(groupId));
  });
  handle(INVOKE.docUndo, () => doc.undo(USER));
  handle(INVOKE.docRedo, () => doc.redo(USER));
  handle(INVOKE.docHistory, () => doc.getHistory());
  handle(INVOKE.docToggleEntry, (_e, entryId: string) => doc.toggleEntry(String(entryId), USER));
  handle(INVOKE.docRevertActor, (_e, key: string) => doc.revertActor(actorFromKey(String(key)), USER));

  // ───── Project files ────────────────────────────────────────────────
  handle(INVOKE.projectStatus, () => project.status());
  // Project tabs (electron/project/tabs.ts): New = a new tab, Open = a new tab (or the untouched new tab, or the
  // file's open tab), both refused with a message while the active tab is busy.
  const tabs = d.tabs;
  handle(INVOKE.projectNew, () => (tabs ? tabs.newTab() : project.newProject()));
  // User templates (Wave 12.2b): userData/templates, atomic writes (electron/project/templates.ts)
  handle(INVOKE.projectTemplates, () => ({ ok: true, data: project.listTemplates() }));
  handle(INVOKE.projectSaveTemplate, (_e, name: string) => project.saveAsTemplate(String(name ?? '')));
  handle(INVOKE.projectNewFromTemplate, (_e, id: string) => (tabs ? tabs.newTab({ template: String(id ?? '') }) : project.newFromTemplate(String(id ?? ''))));
  handle(INVOKE.projectRenameTemplate, (_e, id: string, name: string) => project.renameTemplate(String(id ?? ''), String(name ?? '')));
  handle(INVOKE.projectDeleteTemplate, (_e, id: string) => project.deleteTemplate(String(id ?? '')));
  handle(INVOKE.projectOpen, (e, p?: string) => project.open(typeof p === 'string' && p ? p : undefined, winOf(e)));
  // ───── Project tabs (window.krypt.tabs; handlers: tabs-core) ─────────
  const NO_TABS: ActionResult = { ok: false, message: 'Project tabs are not available in this session' };
  handle(INVOKE.tabsState, () => tabs?.state() ?? { tabs: [], activeId: '', closed: [] });
  handle(INVOKE.tabsNew, (_e, opts?: unknown) => {
    const o = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
    return tabs ? tabs.newTab({ template: typeof o.template === 'string' ? o.template : undefined }) : NO_TABS;
  });
  handle(INVOKE.tabsOpen, (e, p?: unknown) => (tabs ? tabs.open(typeof p === 'string' && p ? p : undefined, winOf(e)) : NO_TABS));
  handle(INVOKE.tabsSwitch, (_e, id: unknown) => (tabs ? tabs.switchTo(str(id)) : NO_TABS));
  handle(INVOKE.tabsClose, (e, id: unknown, decision?: unknown) => (tabs ? tabs.close(str(id), decision === 'save' || decision === 'discard' ? decision : undefined, winOf(e)) : NO_TABS));
  handle(INVOKE.tabsMove, (_e, id: unknown, toIndex: unknown) => (tabs ? tabs.move(str(id), Number(toIndex)) : NO_TABS));
  handle(INVOKE.tabsReopenClosed, () => (tabs ? tabs.reopenClosed() : NO_TABS));
  handle(INVOKE.projectSave, (e) => project.save(winOf(e)));
  handle(INVOKE.projectSaveAs, (e) => project.saveAs(winOf(e)));
  handle(INVOKE.projectImportMidi, (e, p?: string) => project.importMidi(typeof p === 'string' && p ? p : undefined, winOf(e)));
  handle(INVOKE.projectExportMidi, (e, patternId?: string) => project.exportMidi(typeof patternId === 'string' && patternId ? patternId : undefined, winOf(e)));

  // ───── Song info + cover (the bytes stay in main; the doc gets a CoverRef through project.setCover) ─
  const covers = d.covers;
  const NO_COVERS: ActionResult = { ok: false, message: 'Cover art is not available in this session (see the log)' };
  /** Store an outcome as the cover: one user undo step. */
  const applyCover = (ref: unknown, label: string, message: string): ActionResult => {
    const r = doc.exec('project.setCover', ref, { actor: USER, label });
    return r.ok ? { ok: true, message, data: ref } : { ok: false, message: r.message ?? 'Setting the cover failed' };
  };
  handle(INVOKE.projectCover, () => ({ ok: true, data: covers?.preview() ?? null }));
  handle(INVOKE.projectChooseCover, async (e, p?: string) => {
    if (!covers) return NO_COVERS;
    let file = typeof p === 'string' && p ? p : null;
    if (!file) {
      const picked = await dialogs.openFiles({ title: 'Choose a cover image', filters: [{ name: 'PNG or JPEG image', extensions: ['png', 'jpg', 'jpeg'] }], defaultPath: app.getPath('pictures'), win: winOf(e) });
      if (!picked?.length) return { ok: false, message: 'Cover choice cancelled' };
      file = picked[0];
    }
    try {
      const out = await covers.fromFile(file);
      return applyCover(out.ref, 'Set cover art', out.message);
    } catch (err) {
      return { ok: false, message: errText(err) };
    }
  });
  handle(INVOKE.projectSetCoverImage, (_e, bytes: unknown, mime: unknown, label?: unknown) => {
    if (!covers) return NO_COVERS;
    if (!(bytes instanceof Uint8Array) || (mime !== 'image/png' && mime !== 'image/jpeg')) return { ok: false, message: 'Expected PNG or JPEG image bytes' };
    try {
      const out = covers.fromBytes(bytes, 'The generated cover');
      return applyCover(out.ref, typeof label === 'string' && label ? label.slice(0, 80) : 'Generate cover art', out.message);
    } catch (err) {
      return { ok: false, message: errText(err) };
    }
  });
  handle(INVOKE.projectExportCapabilities, () => ({ agentFolder: d.exporter?.agentFolder().dir ?? '' }));
  ipcMain.removeAllListeners(SEND.coverRespond);
  ipcMain.on(SEND.coverRespond, (e, id: unknown, result: unknown) => {
    const pending = typeof id === 'string' ? coverRequests.get(id) : undefined;
    if (!pending || pending.wc !== e.sender.id) return; // only the window that was asked, only once
    coverRequests.delete(id as string);
    clearTimeout(pending.timer);
    pending.resolve(coverDrawResult(result));
  });

  // ───── Engine ───────────────────────────────────────────────────────
  const resolve = (p: string): string => project.resolveSamplePath(String(p ?? ''));
  handle(INVOKE.engineStatus, () => engine.status());
  handle(INVOKE.engineTelemetryUrl, () => engine.telemetryUrl());
  handle(INVOKE.engineTransport, (_e, action: 'play' | 'stop' | 'pause' | 'toggle') => engine.request({ cmd: 'transport', action }));
  handle(INVOKE.engineLocate, (_e, tick: number) => engine.request({ cmd: 'locate', tick: Math.max(0, Number(tick) || 0) }));
  handle(INVOKE.enginePreviewFile, (_e, p: string) => engine.request({ cmd: 'previewFile', path: resolve(p) }, 15_000));
  handle(INVOKE.engineStopPreview, () => engine.request({ cmd: 'stopPreview' }));
  handle(INVOKE.engineListDevices, () => engine.request<DeviceInfo[]>({ cmd: 'listDevices' }, 15_000));
  handle(INVOKE.engineOpenDevice, async (_e, opts: { deviceId?: string | null; bufferFrames?: number; sampleRate?: number }) => {
    const cur = d.getSettings().audio;
    const o = opts && typeof opts === 'object' ? opts : {};
    const next = {
      deviceId: 'deviceId' in o ? (o.deviceId ?? null) : cur.deviceId,
      bufferFrames: typeof o.bufferFrames === 'number' ? o.bufferFrames : cur.bufferFrames,
      sampleRate: typeof o.sampleRate === 'number' ? o.sampleRate : cur.sampleRate,
    };
    const r = await engine.openDevice(next);
    if (r.ok) {
      d.updateSettings({ audio: next });
      const st = r.data;
      return { ...r, message: st?.message ?? (st?.name ? `Audio output: ${st.name} (${st.sampleRate} Hz, ${st.bufferFrames} frames)` : 'Audio device opened') };
    }
    return r;
  });
  handle(INVOKE.engineRender, async (e, opts: RenderOptions) => {
    if (!opts || typeof opts !== 'object' || !opts.scope) return { ok: false, message: 'Missing render options' };
    const format = opts.format === 'wav16' || opts.format === 'wav24' || opts.format === 'wav32f' || opts.format === 'mp3' ? opts.format : null;
    if (!format) return { ok: false, message: 'Choose WAV (16 / 24 / 32-bit float) or MP3' };
    const exporter = d.exporter;
    if (!exporter) return { ok: false, message: 'Exporting is not available in this session (see the log)' };
    // Stems (research/15 §3.1): one offline pass, one file per mixer insert ("NN <insert>") plus "Master", written by
    // the engine into a NEW "<song> stems" folder inside the folder the user picks, so nothing is ever overwritten.
    // No song info is written into stems, and they are never normalized one by one (that would undo the mix balance).
    if (opts.stems) {
      let base = typeof opts.path === 'string' && opts.path ? opts.path : null;
      if (!base) {
        base = await dialogs.pickDirectory({ title: 'Export stems into a folder', defaultPath: project.defaultDir(), win: winOf(e) });
        if (!base) return { ok: false, message: 'Export cancelled' };
      }
      const fs = await import('node:fs');
      const stemDir = `${exporter.defaultName()} stems`;
      let dir = path.join(base, stemDir);
      for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, `${stemDir} ${n}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, message: `Couldn't create the stems folder ${dir}: ${(err as Error)?.message ?? err}` };
      }
      const stemKbps = MP3_BITRATES.includes(Number(opts.mp3Kbps) as Mp3Kbps) ? (Number(opts.mp3Kbps) as Mp3Kbps) : 320;
      broadcast(EVENT.engineRenderProgress, 0);
      const r = await engine.render({
        path: dir,
        scope: opts.scope,
        format,
        ...(format === 'mp3' ? { mp3Kbps: stemKbps } : {}),
        sampleRate: opts.sampleRate,
        tailSec: opts.tailSec,
        loops: typeof opts.loops === 'number' && Number.isFinite(opts.loops) ? Math.max(1, Math.min(256, Math.round(opts.loops))) : undefined,
        stems: true,
        analyze: false,
      });
      if (!r.ok || !r.data) {
        try {
          fs.rmdirSync(dir); // only when the render left it empty
        } catch {
          /* it has files in it: keep them */
        }
        return { ok: false, message: r.message ?? 'The stem render failed' };
      }
      broadcast(EVENT.engineRenderProgress, 1);
      const count = r.data.stemResults?.length ?? r.data.files.length;
      return { ok: true, data: { ...r.data, path: dir }, message: `Exported ${count} stem${count === 1 ? '' : 's'} to ${path.basename(dir)}` };
    }
    const ext = extensionFor(format);
    let out = typeof opts.path === 'string' && opts.path ? opts.path : null;
    if (!out) {
      out = await dialogs.saveFile({
        title: 'Export audio',
        defaultPath: path.join(project.defaultDir(), `${exporter.defaultName()}.${ext}`),
        filters: [ext === 'mp3' ? { name: 'MP3 audio', extensions: ['mp3'] } : { name: 'WAV audio', extensions: ['wav'] }],
        win: winOf(e),
      });
      if (!out) return { ok: false, message: 'Export cancelled' };
    }
    if (!new RegExp(`\\.${ext}$`, 'i').test(out)) out += `.${ext}`;
    // An unknown bitrate falls back to 320 (the engine refuses anything off its list with a sentence anyway).
    const kbps = MP3_BITRATES.includes(Number(opts.mp3Kbps) as Mp3Kbps) ? (Number(opts.mp3Kbps) as Mp3Kbps) : 320;
    broadcast(EVENT.engineRenderProgress, 0);
    const r = await exporter.render(out, {
      scope: opts.scope,
      format,
      mp3Kbps: format === 'mp3' ? kbps : undefined,
      sampleRate: opts.sampleRate,
      tailSec: opts.tailSec,
      loops: opts.loops,
      normalize: opts.normalize,
      tags: opts.tags !== false,
    });
    if (!r.ok || !r.data) return r;
    broadcast(EVENT.engineRenderProgress, 1);
    const note = r.data.tagged ? '' : opts.tags === false ? '' : ` (song info not written: ${r.data.tagNote ?? 'unknown reason'})`;
    return { ...r, message: `Exported ${path.basename(r.data.path || out)}${note}` };
  });
  handle(INVOKE.engineSampleInfo, (_e, p: string) => engine.sampleInfo(resolve(p)));
  handle(INVOKE.enginePeaks, (_e, p: string, buckets: number) =>
    engine.request<Peaks>({ cmd: 'peaks', path: resolve(p), buckets: Math.max(1, Math.min(65536, Math.round(Number(buckets) || 512))) }, 30_000),
  );
  handle(INVOKE.engineAnalyzeFile, (_e, p: string) => engine.analyzeFile(resolve(p)));
  handle(INVOKE.engineRestart, () => engine.restart());

  ipcMain.removeAllListeners(SEND.engineAudition);
  ipcMain.on(SEND.engineAudition, (_e, m: { channelId: string; key: number; vel: number; on: boolean }) => {
    if (!m || typeof m.channelId !== 'string') return;
    void engine.request({ cmd: 'audition', channelId: m.channelId, key: m.key | 0, vel: Number(m.vel) || 0, on: !!m.on }, 2000);
  });
  ipcMain.removeAllListeners(SEND.engineAuditionOff);
  ipcMain.on(SEND.engineAuditionOff, () => {
    void engine.request({ cmd: 'auditionOff' }, 2000);
  });

  // ───── Browser ──────────────────────────────────────────────────────
  handle(INVOKE.browserRoots, () => browserRoots(d.browser));
  handle(INVOKE.browserList, (_e, dir: string) => listInRoots(d.browser, String(dir ?? '')));
  handle(INVOKE.browserAddRoot, (e) => addRoot(d.browser, winOf(e)));
  handle(INVOKE.browserRemoveRoot, (_e, id: string) => removeRoot(d.browser, String(id ?? '')));

  // ───── Dialogs ──────────────────────────────────────────────────────
  handle(INVOKE.dialogOpenFile, (e, o: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multi?: boolean }) =>
    dialogs.openFiles({ ...(o ?? {}), defaultPath: project.defaultDir(), win: winOf(e) }),
  );
  handle(INVOKE.dialogSaveFile, (e, o: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const opts = o ?? {};
    const def = opts.defaultPath && !path.isAbsolute(opts.defaultPath) ? path.join(project.defaultDir(), opts.defaultPath) : opts.defaultPath;
    return dialogs.saveFile({ ...opts, defaultPath: def, win: winOf(e) });
  });

  // ───── Settings ─────────────────────────────────────────────────────
  handle(INVOKE.settingsGet, () => d.getSettings());
  handle(INVOKE.settingsUpdate, (_e, patch: Partial<Settings>) => {
    const p = patch && typeof patch === 'object' ? { ...patch } : {};
    // agent.hasApiKey is owned by the agent backend (setApiKey), not the renderer.
    if (p.agent) p.agent = { ...p.agent, hasApiKey: d.getSettings().agent.hasApiKey, keys: d.getSettings().agent.keys };
    return d.updateSettings(p);
  });

  // ───── MCP / agents (controllers from electron/mcp, electron/agent) ─
  handle(INVOKE.mcpStatus, () => d.mcp()?.status() ?? fallbackMcpStatus(d.shimExePath));
  handle(INVOKE.mcpClientConfigs, () => d.mcp()?.clientConfigs() ?? []);
  handle(INVOKE.mcpInstallClientConfig, (_e, client: string) => d.mcp()?.installClientConfig(String(client)) ?? NOT_READY);
  handle(INVOKE.mcpSetEnabled, async (_e, enabled: boolean) => {
    const m = d.mcp();
    if (!m) return NOT_READY;
    const r = await m.setEnabled(!!enabled);
    if (r.ok) d.updateSettings({ mcp: { ...d.getSettings().mcp, enabled: !!enabled } });
    return r;
  });
  handle(INVOKE.agentSetApiKey, (_e, key: string | null, provider?: unknown) => d.agent()?.setApiKey(typeof key === 'string' && key ? key : null, isAgentProvider(provider) ? provider : undefined) ?? NOT_READY);
  handle(INVOKE.agentSend, (_e, message: string) => d.agent()?.send(String(message ?? '')) ?? NOT_READY);
  handle(INVOKE.agentCancel, async () => {
    await d.agent()?.cancel();
  });
  handle(INVOKE.agentReset, async () => {
    await d.agent()?.reset();
  });

  // ───── Live input / recording (electron/input/liveInput.ts) ─────────
  const live = d.liveInput;
  const NO_LIVE: ActionResult = { ok: false, message: 'Live input is not available yet' };
  handle(INVOKE.midiInputs, () => live?.inputs() ?? NO_LIVE);
  handle(INVOKE.midiSetInputEnabled, (_e, id: string, enabled: boolean) => live?.setInputEnabled(String(id ?? ''), !!enabled) ?? NO_LIVE);
  handle(INVOKE.midiLearn, (_e, paramRef: string, label?: string) =>
    live?.learn(String(paramRef ?? ''), typeof label === 'string' ? label : undefined) ?? NO_LIVE,
  );
  handle(INVOKE.midiRemoveMapping, (_e, id: string) => live?.removeMapping(String(id ?? '')) ?? NO_LIVE);
  handle(INVOKE.recordStatus, () => live?.status() ?? { armed: false, input: null });
  handle(INVOKE.recordSetArmed, (_e, armed: boolean) => live?.setArmed(!!armed) ?? NO_LIVE);
  handle(INVOKE.recordListInputDevices, () => live?.listInputDevices() ?? NO_LIVE);
  handle(INVOKE.recordSetMeter, (_e, on: boolean) => live?.setMeter(!!on) ?? NO_LIVE);
  // MIDI outputs, clock out, sync in (electron/midi/hardware.ts).
  const hw = d.hardware;
  const NO_HW: ActionResult = { ok: false, message: 'MIDI outputs are not available yet' };
  handle(INVOKE.midiOutputs, () => hw?.listOutputs() ?? NO_HW);
  handle(INVOKE.midiSetOutputEnabled, (_e, id: string, enabled: boolean) => hw?.setOutputEnabled(String(id ?? ''), !!enabled) ?? NO_HW);
  handle(INVOKE.midiClockSettings, () => hw?.clockSettings() ?? midiOutSettings(d.getSettings()));
  handle(INVOKE.midiSetClockSettings, (_e, patch: unknown) => hw?.setClockSettings(patch) ?? NO_HW);
  ipcMain.removeAllListeners(SEND.midiSetTarget);
  ipcMain.on(SEND.midiSetTarget, (_e, channelId: string | null) => live?.setTarget(typeof channelId === 'string' ? channelId : null));
  ipcMain.removeAllListeners(SEND.midiCancelLearn);
  ipcMain.on(SEND.midiCancelLearn, () => live?.cancelLearn());
  // Gamepads / keyboard pads (shared/live/controllers.ts): the renderer runs the maps, the engine plays the MIDI.
  ipcMain.removeAllListeners(SEND.midiVirtualIn);
  ipcMain.on(SEND.midiVirtualIn, (_e, m: { device?: unknown; bytes?: unknown }) => {
    const device = typeof m?.device === 'string' ? m.device : '';
    const bytes = Array.isArray(m?.bytes) ? (m.bytes as number[]) : [];
    if (!device.startsWith(VIRTUAL_DEVICE_PREFIX) || device.length > 64 || !isVirtualMidi(bytes)) return;
    void engine.request({ cmd: 'virtualMidiIn', device, bytes }, 2000).then((r) => {
      if (!r.ok && engine.status().state === 'running') logger.warn(`Controller MIDI was refused: ${r.message ?? 'unknown error'}`);
    });
  });

  // ───── Third-party plugins (VST3 / CLAP; electron/plugins) ──────────
  const plugins = d.plugins;
  const NO_PLUGINS: ActionResult = { ok: false, message: 'Plugin hosting is not available' };
  handle(INVOKE.pluginsState, () => plugins?.currentState() ?? null);
  handle(INVOKE.pluginsRescan, (_e, opts?: { full?: boolean }) => plugins?.rescan({ full: !!(opts && typeof opts === 'object' && opts.full) }) ?? NO_PLUGINS);
  handle(INVOKE.pluginsAddFolder, () => plugins?.addFolder() ?? NO_PLUGINS);
  handle(INVOKE.pluginsRemoveFolder, (_e, p: string) => plugins?.removeFolder(String(p ?? '')) ?? NO_PLUGINS);
  handle(INVOKE.pluginsUnblock, (_e, p?: string) => plugins?.unblock(typeof p === 'string' && p ? p : undefined) ?? NO_PLUGINS);
  handle(INVOKE.pluginsOpenEditor, (_e, target: PluginTarget, open?: boolean) => {
    const t = target && typeof target === 'object' ? target : null;
    if (!t) return { ok: false, message: 'Missing plugin target' };
    const tt: PluginTarget | null =
      'channelId' in t && typeof t.channelId === 'string'
        ? { channelId: t.channelId }
        : 'insertId' in t && typeof t.insertId === 'string' && typeof t.slotId === 'string'
          ? { insertId: t.insertId, slotId: t.slotId }
          : null;
    if (!tt) return { ok: false, message: 'Invalid plugin target' };
    return plugins?.openEditor(tt, open !== false) ?? NO_PLUGINS;
  });
  handle(INVOKE.pluginsReload, () => plugins?.reload() ?? NO_PLUGINS);

  // ───── On-device audio ML (electron/analyzer; actor = user) ─────────
  // Model downloads start ONLY here (the UI); MCP tools never download.
  const ears = d.analyzer;
  const NO_EARS: ActionResult = { ok: false, message: 'Audio analysis is not available in this session (see the log)' };
  const BAD_TARGET: ActionResult = { ok: false, message: 'Pick an audio clip, a channel with a sample, or an audio file' };
  handle(INVOKE.analyzerState, () => ears?.state() ?? fallbackAnalyzerState());
  handle(INVOKE.analyzerInstallModel, (_e, id: string) => ears?.installModel(String(id ?? '')) ?? NO_EARS);
  handle(INVOKE.analyzerCancelInstall, (_e, id: string) => ears?.cancelInstall(String(id ?? '')) ?? NO_EARS);
  handle(INVOKE.analyzerImportModel, (_e, id: string) => ears?.importModel(String(id ?? '')) ?? NO_EARS);
  handle(INVOKE.analyzerRemoveModel, (_e, id: string) => ears?.removeModel(String(id ?? '')) ?? NO_EARS);
  handle(INVOKE.analyzerAnalyze, (_e, target: unknown) => {
    const t = audioTarget(target);
    if (!t) return BAD_TARGET;
    return ears?.analyze(t) ?? NO_EARS;
  });
  handle(INVOKE.analyzerSeparateStems, (_e, clipId: string, opts?: { model?: string }) => {
    if (typeof clipId !== 'string' || !clipId) return { ok: false, message: 'Pick an audio clip to separate' };
    const model = opts && typeof opts === 'object' && typeof opts.model === 'string' && opts.model ? opts.model : undefined;
    return ears?.separateStems(clipId, { model }) ?? NO_EARS;
  });
  handle(INVOKE.analyzerToPattern, (_e, target: unknown, opts?: { mode?: string; name?: string }) => {
    const t = audioTarget(target);
    if (!t) return BAD_TARGET;
    const o = opts && typeof opts === 'object' ? opts : {};
    const mode = o.mode === 'poly' || o.mode === 'mono' || o.mode === 'drums' ? o.mode : null;
    if (!mode) return { ok: false, message: 'Choose what to transcribe: notes (poly), a melody (mono) or drums' };
    return ears?.toPattern(t, { mode, name: typeof o.name === 'string' ? o.name.slice(0, 64) : undefined }) ?? NO_EARS;
  });
  handle(INVOKE.analyzerCancelJob, (_e, jobId: string) => ears?.cancelJob(String(jobId ?? '')) ?? NO_EARS);

  // ───── Warp (Wave 12.2; electron/warp): beat-track an audio clip channel, then ONE audio.autoWarp (actor = user) ─
  handle(INVOKE.warpAutoWarp, (_e, channelId: unknown, opts?: unknown) => {
    if (typeof channelId !== 'string' || !channelId) return { ok: false, message: 'Pick an audio clip channel to warp' };
    const o = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
    const every = o.every === 'beat' || o.every === 'bar' ? o.every : undefined;
    const hint = o.hint === 'drums' || o.hint === 'mono' || o.hint === 'mix' ? o.hint : undefined;
    const mode = typeof o.mode === 'string' && (WARP_MODES as readonly string[]).includes(o.mode) ? (o.mode as WarpMode) : undefined;
    return autoWarpChannel({ doc, analyzer: ears }, channelId, { every, hint, mode }, userApply(doc));
  });

  // ───── Audio → project (electron/audioProject; actor = user, always a NEW project) ─
  // With project tabs the result opens in a NEW tab (ProjectService.newProject → tabs); stages 1-4 never touch the
  // document and the build is one undo step. (Without tabs the renderer asks "save changes?" first, like File ▸ New,
  // and the new project replaces the open one at the end.) Progress goes to every window.
  let apDeps: MainDeps | null = null;
  /** MainDeps for main-side services the UI shares with agents (audio → project, "More like this"). */
  const ipcMainDeps = (): MainDeps =>
    (apDeps ??= {
      doc,
      engine,
      project,
      getSettings: d.getSettings,
      updateSettings: d.updateSettings,
      broadcast,
      userDataDir: app.getPath('userData'),
      appExePath: process.execPath,
      shimExePath: d.shimExePath,
      log: (level, m) => logger.log(level, m),
      analyzer: ears,
      vocals: d.vocals,
      library: d.library,
      sounds: d.sounds,
      packs: d.packs,
      voice: d.voice,
    });
  const audioProject = () => (ears ? audioProjectFor(ipcMainDeps()) : null);
  handle(INVOKE.audioProjectOpen, async (e, p?: unknown, opts?: unknown) => {
    const svc = audioProject();
    if (!svc) return NO_EARS;
    let file = typeof p === 'string' && p ? p : null;
    if (!file) {
      const picked = await dialogs.openFiles({ title: 'Open audio as a project', filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }], defaultPath: project.defaultDir(), win: winOf(e) });
      if (!picked?.length) return { ok: false, message: 'Open audio cancelled' };
      file = picked[0];
    }
    if (!path.isAbsolute(file) || !isAudioFile(file)) return { ok: false, message: `"${path.basename(file)}" isn't an audio file Krypt Studio can read (${AUDIO_EXTENSIONS.join(', ')})` };
    return svc.convert(file, audioProjectOptions(opts), { kind: 'new', actor: USER }, { progress: (pr) => broadcast(EVENT.audioProjectProgress, pr) });
  });
  handle(INVOKE.audioProjectCancel, () => audioProject()?.cancel() ?? NO_EARS);

  // ───── Auto Mashup (electron/mashup; actor = user) ─────────────────────
  // check reads both songs and plans (no edits); build runs the whole pipeline and lands as ONE undo step (a new
  // project by default: the renderer asks "save changes?" first, like File ▸ New). A `{ path: '' }` song opens a file
  // dialog here; the picked path comes back in MashupCheck.a/b.path for the build. Paths from the renderer are the
  // user's own picks (drag & drop, the dialog), like File ▸ Open audio as project. Progress goes to every window.
  const mashup = () => (ears ? mashupFor(ipcMainDeps()) : null);
  const mashupRequest = async (e: IpcMainInvokeEvent, raw: unknown): Promise<MashupRequest | ActionResult> => {
    const req = cleanMashupRequest(raw);
    if (typeof req === 'string') return { ok: false, message: req };
    for (const side of ['a', 'b'] as const) {
      const src: MashupSource = req[side];
      if (!('path' in src) || src.path.trim()) continue;
      const picked = await dialogs.openFiles({ title: `Auto Mashup: pick song ${side.toUpperCase()}`, filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }], defaultPath: project.defaultDir(), win: winOf(e) });
      if (!picked?.length) return { ok: false, message: `Auto Mashup cancelled: no song ${side.toUpperCase()} was picked` };
      req[side] = { path: picked[0] };
    }
    return req;
  };
  const mashupProgress = { progress: (pr: unknown) => broadcast(EVENT.mashupProgress, pr) };
  handle(INVOKE.mashupCheck, async (e, raw: unknown) => {
    const svc = mashup();
    if (!svc) return NO_EARS;
    const req = await mashupRequest(e, raw);
    if ('ok' in req) return req;
    return svc.check(req, mashupProgress);
  });
  handle(INVOKE.mashupBuild, async (e, raw: unknown) => {
    const svc = mashup();
    if (!svc) return NO_EARS;
    const req = await mashupRequest(e, raw);
    if ('ok' in req) return req;
    return svc.build(req, req.newProject === false ? { kind: 'current', actor: USER } : { kind: 'new', actor: USER }, mashupProgress);
  });
  handle(INVOKE.mashupCancel, () => mashup()?.cancel() ?? NO_EARS);

  // ───── Auto Mix / Auto Master (electron/automix; actor = user) ─────────
  // run renders and measures the song, sets Krypt-owned slots, re-renders up to 3 passes and lands as ONE history
  // entry (A/B = doc.toggleEntry(entryId)). masterFile opens the audio in a NEW project tab and masters it; a
  // `path: ''` opens a file dialog here. understand reads a prompt (the AI when a key is set up, else keywords).
  const automix = () => automixFor(ipcMainDeps());
  const automixProgress = { progress: (pr: unknown) => broadcast(EVENT.automixProgress, pr) };
  handle(INVOKE.automixPresets, () => automix().presets());
  handle(INVOKE.automixUnderstand, (_e, prompt: unknown) => automix().understand(typeof prompt === 'string' ? prompt : ''));
  handle(INVOKE.automixRun, (_e, raw: unknown) => {
    const req = cleanAutoMixRequest(raw);
    if (typeof req === 'string') return { ok: false, message: req };
    return automix().run(req, { actor: USER }, automixProgress);
  });
  handle(INVOKE.automixMasterFile, async (e, raw: unknown) => {
    const req = cleanMasterFileRequest(raw);
    if (typeof req === 'string') return { ok: false, message: req };
    if (!req.path.trim()) {
      const picked = await dialogs.openFiles({ title: 'Master a song: pick the audio file', filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }], defaultPath: project.defaultDir(), win: winOf(e) });
      if (!picked?.length) return { ok: false, message: 'Master a song cancelled: no file was picked' };
      req.path = picked[0];
    }
    return automix().masterFile(req, USER, automixProgress);
  });
  handle(INVOKE.automixCancel, () => automix().cancel());
  // Reference matching + album mastering (research/23). Paths are the user's own picks (the dialog, drag & drop).
  const userAudioPath = (p: unknown): string | null => (typeof p === 'string' && p.trim() && path.isAbsolute(p.trim()) && isAudioFile(p.trim()) ? p.trim() : null);
  handle(INVOKE.automixAnalyzeReference, (_e, p: unknown) => {
    const file = userAudioPath(p);
    if (!file) return { ok: false, message: `Pick an audio file as the reference (${AUDIO_EXTENSIONS.join(', ')})` };
    return automix().analyzeReference(file);
  });
  handle(INVOKE.automixPlayReference, (_e, p: unknown, matchLufs: unknown) => {
    const file = userAudioPath(p);
    if (!file) return { ok: false, message: 'There is no reference song to play' };
    return automix().playReference(file, typeof matchLufs === 'number' && Number.isFinite(matchLufs) ? matchLufs : null);
  });
  handle(INVOKE.automixMasterAlbum, (_e, raw: unknown) => {
    const req = cleanAlbumRequest(raw);
    if (typeof req === 'string') return { ok: false, message: req };
    return automix().masterAlbum(req, USER, automixProgress);
  });
  handle(INVOKE.automixExportAlbum, async (e, raw: unknown) => {
    const req = cleanAlbumExportRequest(raw);
    if (typeof req === 'string') return { ok: false, message: req };
    if (!req.folder.trim()) {
      const picked = await dialogs.pickDirectory({ title: 'Export all: choose a folder for the mastered songs', defaultPath: project.defaultDir(), win: winOf(e) });
      if (!picked) return { ok: false, message: 'Export cancelled: no folder was chosen' };
      req.folder = picked;
    }
    const r = await automix().exportAlbum(req, automixProgress);
    if (r.data?.files.length) showItemInFolder(r.data.files[0]);
    return r;
  });

  // ───── Vocals & mashups (electron/vocals; actor = user, one undo step per call) ─
  // The same service as the tune_vocal / match_clip MCP tools.
  const vocals = d.vocals;
  const NO_VOCALS: ActionResult = { ok: false, message: 'The vocal tools are not available in this session (see the log)' };
  handle(INVOKE.vocalsTune, async (_e, target: unknown, opts?: { style?: unknown; key?: unknown; scale?: unknown }) => {
    if (!vocals) return NO_VOCALS;
    const t = audioTarget(target);
    if (!t || 'path' in t) return { ok: false, message: 'Pick an audio clip or a channel to tune' };
    const o = opts && typeof opts === 'object' ? opts : {};
    const style = o.style === 'natural' || o.style === 'pop' || o.style === 'hard' ? o.style : null;
    if (!style) return { ok: false, message: 'Choose how hard to tune: Natural, Pop or Hard' };
    const p = doc.project;
    const chId = 'clipId' in t ? p.playlist.clips[t.clipId]?.channelId : t.channelId;
    const name = (chId && p.channels[chId]?.name) || 'vocal';
    const g = userGroupApply(doc, `Tune vocal "${name}" (${style[0].toUpperCase()}${style.slice(1)})`);
    let r: ActionResult = { ok: false, message: 'Tuning failed' };
    try {
      r = await vocals.tune(t, { style, key: typeof o.key === 'string' && o.key.trim() ? o.key.slice(0, 32) : undefined, scale: typeof o.scale === 'string' && o.scale.trim() ? o.scale.slice(0, 32) : undefined }, g.apply);
    } finally {
      g.finish(r.ok);
    }
    return r;
  });
  handle(INVOKE.vocalsMatch, async (_e, clipId: unknown, opts?: { to?: unknown; key?: unknown; tempo?: unknown }) => {
    if (!vocals) return NO_VOCALS;
    if (typeof clipId !== 'string' || !clipId) return { ok: false, message: 'Pick an audio clip to match' };
    const o = opts && typeof opts === 'object' ? opts : {};
    const toRaw = o.to as { clipId?: unknown } | string | undefined;
    const to = toRaw && typeof toRaw === 'object' && typeof toRaw.clipId === 'string' && toRaw.clipId ? { clipId: toRaw.clipId } : ('project' as const);
    const p = doc.project;
    const chId = p.playlist.clips[clipId]?.channelId;
    const name = (chId && p.channels[chId]?.name) || 'clip';
    const g = userGroupApply(doc, `Match "${name}" to ${to === 'project' ? 'the project' : 'a clip'}`);
    let r: ActionResult = { ok: false, message: 'Match failed' };
    try {
      r = await vocals.match(clipId, { to, key: o.key !== false, tempo: o.tempo !== false }, g.apply);
    } finally {
      g.finish(r.ok);
    }
    return r;
  });

  // ───── Krypt Voice (electron/voice; actor = user, one undo step per call) ─
  // speak / sing render (Local: the analyzer; Cloud: Fish Audio with the user's key) and add ONE clip each; preview
  // only plays it. The Fish key and "my voice" exist only here (agents never set keys or clone). Progress goes to
  // every window.
  const voice = d.voice;
  const NO_VOICE: ActionResult = { ok: false, message: 'Krypt Voice is not available in this session (see the log)' };
  const tuneOf = (v: unknown): SpeakRequest['tune'] => (v === 'off' || v === 'natural' || v === 'pop' || v === 'hard' ? v : undefined);
  const numOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  handle(INVOKE.voiceState, async () => (voice ? voice.state() : { local: { installed: false, modelId: null, message: NO_VOICE.message }, fish: { keySet: false, message: NO_VOICE.message }, voices: [] }));
  handle(INVOKE.voiceSpeak, (_e, raw: unknown) => {
    if (!voice) return NO_VOICE;
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const req: SpeakRequest = { text: str(o.text).slice(0, 4000), voiceId: str(o.voiceId).slice(0, 120), speed: numOf(o.speed), at: str(o.at).slice(0, 16) || undefined, track: str(o.track).slice(0, 120) || undefined, preview: o.preview === true, tune: tuneOf(o.tune) };
    return voice.speak(req);
  });
  handle(INVOKE.voiceSing, (_e, raw: unknown) => {
    if (!voice) return NO_VOICE;
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const req: SingRequest = {
      patternId: str(o.patternId).slice(0, 80),
      channelId: str(o.channelId).slice(0, 80),
      bars: str(o.bars).slice(0, 16) || undefined,
      lyrics: str(o.lyrics).slice(0, 8000),
      voiceId: str(o.voiceId).slice(0, 120),
      tune: tuneOf(o.tune),
      vibrato: numOf(o.vibrato),
      glideMs: numOf(o.glideMs),
      octave: numOf(o.octave),
      preview: o.preview === true,
    };
    return voice.sing(req);
  });
  handle(INVOKE.voiceCancel, () => voice?.cancel() ?? NO_VOICE);
  handle(INVOKE.voiceSetFishKey, (_e, key: unknown) => (voice ? voice.setFishKey(typeof key === 'string' ? key.slice(0, 512) : null) : NO_VOICE));
  handle(INVOKE.voiceCloneMine, (_e, raw: unknown) => {
    if (!voice) return NO_VOICE;
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (o.consent !== true) return { ok: false, message: 'Cloning needs your consent: confirm that this is your own voice first.' };
    return voice.cloneMyVoice({ recordingPath: str(o.recordingPath).slice(0, 1024), name: str(o.name).slice(0, 80), consent: true });
  });
  handle(INVOKE.voiceRemoveMine, (_e, id: unknown) => (voice ? voice.removeMyVoice(str(id).slice(0, 80)) : NO_VOICE));

  // ───── Reference library (electron/library; records only, never deletes user files) ─
  // Deep analysis (stems) starts here (the UI) or from library_deep, which agents may call only when a stem model is
  // already installed; nothing here or there downloads a model.
  const lib = d.library;
  const NO_LIB: ActionResult = { ok: false, message: 'The reference library is not available in this session (see the log)' };
  handle(INVOKE.libraryState, () => lib?.state() ?? fallbackLibraryState());
  handle(INVOKE.libraryCreateCollection, (_e, name: string, tags?: string[]) => lib?.createCollection(str(name), strList(tags)) ?? NO_LIB);
  handle(INVOKE.libraryUpdateCollection, (_e, id: string, patch?: { name?: unknown; tags?: unknown }) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    return lib?.updateCollection(str(id), { name: typeof p.name === 'string' ? p.name : undefined, tags: strList(p.tags) }) ?? NO_LIB;
  });
  handle(INVOKE.libraryRemoveCollection, (_e, id: string) => lib?.removeCollection(str(id)) ?? NO_LIB);
  handle(INVOKE.libraryAddFolder, (_e, collectionId: string, p?: string) => lib?.addFolder(str(collectionId), typeof p === 'string' && p ? p : undefined) ?? NO_LIB);
  handle(INVOKE.libraryAddFiles, (_e, collectionId: string, paths?: string[]) => lib?.addFiles(str(collectionId), strList(paths)) ?? NO_LIB);
  handle(INVOKE.libraryRemoveTracks, (_e, ids: string[]) => lib?.removeTracks(strList(ids) ?? []) ?? NO_LIB);
  handle(INVOKE.libraryRescan, (_e, collectionId: string) => lib?.rescan(str(collectionId)) ?? NO_LIB);
  handle(INVOKE.librarySetDeep, (_e, collectionId: string, deep: boolean) => lib?.setDeep(str(collectionId), deep === true) ?? NO_LIB);
  handle(INVOKE.libraryEstimateDeep, (_e, collectionId: string) => lib?.estimateDeep(str(collectionId)) ?? NO_LIB);
  handle(INVOKE.librarySetPaused, (_e, paused: boolean) => lib?.setPaused(paused === true) ?? NO_LIB);
  handle(INVOKE.libraryRetryFailed, (_e, collectionId?: string) => lib?.retryFailed(typeof collectionId === 'string' && collectionId ? collectionId : undefined) ?? NO_LIB);
  handle(INVOKE.libraryQuery, (_e, q: TrackQuery) => lib?.query(q && typeof q === 'object' ? q : {}) ?? NO_LIB);
  handle(INVOKE.libraryTrack, (_e, id: string) => lib?.track(str(id)) ?? NO_LIB);
  handle(INVOKE.libraryProfile, (_e, collectionId: string) => lib?.profile(str(collectionId)) ?? NO_LIB);
  handle(INVOKE.librarySimilar, (_e, trackId: string, opts?: { collectionId?: unknown; limit?: unknown }) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    return lib?.similar(str(trackId), { collectionId: typeof o.collectionId === 'string' && o.collectionId ? o.collectionId : undefined, limit: typeof o.limit === 'number' ? o.limit : undefined }) ?? NO_LIB;
  });
  handle(INVOKE.libraryCheckOriginality, (_e, opts?: { patternId?: unknown }) => {
    const pid = opts && typeof opts === 'object' && typeof opts.patternId === 'string' && opts.patternId ? opts.patternId : undefined;
    return lib?.checkOriginality(pid ? { patternId: pid } : {}) ?? NO_LIB;
  });
  handle(INVOKE.librarySetFocus, (_e, focus: { collectionId?: unknown; brief?: unknown } | null) => {
    if (!lib) return NO_LIB;
    if (!focus || typeof focus !== 'object') return lib.setFocus(null);
    return lib.setFocus({ collectionId: str(focus.collectionId), brief: typeof focus.brief === 'string' ? focus.brief : undefined });
  });
  handle(INVOKE.libraryAddToProject, (_e, trackId: string) => lib?.addToProject(str(trackId)) ?? NO_LIB);

  // ───── Sounds: presets + factory sample index (electron/sounds) ─────
  // Loading a preset is a doc command (presets.*) the renderer dispatches itself; these only read / store presets.
  const sounds = d.sounds;
  const NO_SOUNDS: ActionResult = { ok: false, message: 'Presets are not available in this session (see the log)' };
  handle(INVOKE.soundsState, () => sounds?.state() ?? { presets: [], factoryCount: 0, userCount: 0, userDir: '' });
  handle(INVOKE.soundsGet, (_e, id: string) => sounds?.get(str(id)) ?? NO_SOUNDS);
  handle(INVOKE.soundsSaveChannel, (_e, channelId: string, meta: unknown) => sounds?.saveChannel(str(channelId), meta) ?? NO_SOUNDS);
  handle(INVOKE.soundsSaveChain, (_e, insertId: string, meta: unknown) => sounds?.saveChain(str(insertId), meta) ?? NO_SOUNDS);
  handle(INVOKE.soundsRenameUser, (_e, id: string, name: string) => sounds?.renameUser(str(id), str(name)) ?? NO_SOUNDS);
  handle(INVOKE.soundsDeleteUser, (_e, id: string) => sounds?.deleteUser(str(id)) ?? NO_SOUNDS);
  handle(INVOKE.soundsRevealUserDir, () => {
    if (!sounds) return NO_SOUNDS;
    const dir = sounds.ensureUserDir();
    const r = showItemInFolder(dir);
    return r.ok ? { ok: true, message: 'Opened your presets folder' } : { ok: false, message: `Couldn't open your presets folder: ${r.message ?? dir}` };
  });
  handle(INVOKE.soundsFactorySamples, () => sounds?.factorySamples() ?? []);
  handle(INVOKE.soundsSuggestSampleFolders, async () => {
    if (!sounds) return [];
    try {
      return await sounds.suggestSampleFolders();
    } catch (err) {
      logger.warn(`[sounds] sample-folder scan failed: ${errText(err)}`);
      return [];
    }
  });

  // "More like this" (electron/sounds/similar.ts): the user's own files only from the Browser folders (the same rule
  // as browser.list). One search at a time: the Browser asks again while pack samples are still being measured.
  let similarQueue: Promise<unknown> = Promise.resolve();
  const similarUserFile = browserFileAccess(() => browserRoots(d.browser).map((r) => r.path));
  handle(INVOKE.soundsSimilar, (_e, source: unknown, query: unknown) => {
    const s = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
    const src =
      s.kind === 'preset' && typeof s.id === 'string' && s.id && s.id.length <= 200
        ? ({ kind: 'preset', id: s.id } as const)
        : s.kind === 'sample' && typeof s.path === 'string' && s.path && s.path.length <= 1024
          ? ({ kind: 'sample', path: s.path } as const)
          : null;
    if (!src) return { ok: false, message: 'Pick a sound or an instrument preset to find more like it' };
    const q = query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
    const opts: SimilarQuery = {
      scope: q.scope === 'any' ? 'any' : 'same',
      want: q.want === 'samples' || q.want === 'presets' ? q.want : 'all',
      limit: typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : undefined,
    };
    const run = similarQueue.then(() => findSimilar(similarDepsFor(ipcMainDeps(), similarUserFile, classifyUserSample), src, opts));
    similarQueue = run.catch(() => undefined);
    return run;
  });

  // ───── Sound packs (electron/packs): the user's clicks are the ONLY way a pack downloads ─────
  const packs = d.packs;
  const NO_PACKS: ActionResult = { ok: false, message: 'Sound packs are not available in this session (see the log)' };
  handle(INVOKE.packsState, () => packs?.state() ?? { packs: [], dir: path.join(app.getPath('userData'), 'packs') });
  handle(INVOKE.packsInstall, (_e, id: string) => packs?.install(str(id)) ?? NO_PACKS);
  handle(INVOKE.packsCancel, (_e, id: string) => packs?.cancel(str(id)) ?? NO_PACKS);
  handle(INVOKE.packsRemove, (_e, id: string) => packs?.remove(str(id)) ?? NO_PACKS);
  handle(INVOKE.packsReveal, (_e, id: string) => {
    if (!packs) return NO_PACKS;
    const name = packs.packName(str(id));
    if (!name) return { ok: false, message: 'That sound pack is no longer offered.' };
    const dir = packs.packDir(str(id));
    if (!dir) return { ok: false, message: `${name} isn't installed yet: download it first.` };
    const r = showItemInFolder(dir);
    return r.ok ? { ok: true, message: `Opened the ${name} folder` } : { ok: false, message: `Couldn't open the ${name} folder: ${r.message ?? dir}` };
  });
  handle(INVOKE.packsSamples, () => packs?.sampleInfo() ?? { packs: [], samples: [] });

  // ───── Racks (Wave 12.2; racks-app): slice audio onto a drum rack, ONE undo step as the user ─────
  // Editing racks is doc commands (rack.*); only slicing needs main (the analyzer finds the hits).
  handle(INVOKE.racksSliceToPads, async (_e, source: unknown, opts?: unknown) => {
    const t = audioTarget(source);
    if (!t) return { ok: false, message: 'Pick a sample, an audio clip or a channel with a sample to slice' };
    const progress = (stage: string, fraction: number) => broadcast(EVENT.racksSliceProgress, { stage, fraction });
    const r = await sliceToPads(
      {
        doc,
        analyze: d.analyzer ? (target, o) => d.analyzer!.analyze(target, o) : undefined,
        sampleInfo: (abs) => engine.sampleInfo(abs),
        resolveSamplePath: (p) => project.resolveSamplePath(p),
      },
      t,
      cleanSliceOptions(opts),
      <T,>(cmd: string, args: unknown): T => {
        const x = doc.exec<T>(cmd, args, { actor: USER });
        if (!x.ok) throw new Error(x.message ?? `${cmd} failed`);
        return x.data as T;
      },
      { onProgress: progress },
    );
    progress(r.ok ? 'done' : 'failed', 1);
    return r;
  });

  // ───── Clip launcher runtime (electron/session; grid edits are session.* doc commands) ─
  const ses = d.session;
  const NO_SESSION: ActionResult = { ok: false, message: 'The clip launcher is not available in this session' };
  handle(INVOKE.sessionLaunch, (_e, clipId: string, release?: boolean) => ses?.launch(str(clipId), release === true) ?? NO_SESSION);
  handle(INVOKE.sessionLaunchScene, (_e, sceneId: string) => ses?.launchScene(str(sceneId)) ?? NO_SESSION);
  handle(INVOKE.sessionStop, (_e, trackId: string | null) => ses?.stop(typeof trackId === 'string' && trackId ? trackId : null) ?? NO_SESSION);
  handle(INVOKE.sessionBackToArrangement, () => ses?.backToArrangement() ?? NO_SESSION);
  handle(INVOKE.sessionSetRecord, (_e, on: boolean) => ses?.setRecord(on === true) ?? NO_SESSION);
  handle(INVOKE.sessionRecordState, () => ses?.recordState() ?? { on: false });
  handle(INVOKE.sessionGridSettings, () => ses?.gridSettings() ?? launchGridSettings(d.getSettings()));
  handle(INVOKE.sessionSetGridSettings, (_e, patch: unknown) => ses?.setGridSettings(patch) ?? NO_SESSION);

  // ───── Krypt Script (Wave 12.2b; scripts): the sandbox runs here, never in a renderer ─────
  // Saving into the project is the doc command scripts.save; applying is ONE notes.applyScript as the user.
  const scripts = new ScriptService({ userDataDir: app.getPath('userData'), project: () => doc.project });
  const BAD_RUN: ActionResult = { ok: false, message: 'Pick a script, a pattern and a channel first' };
  handle(INVOKE.scriptsList, () => scripts.catalog());
  handle(INVOKE.scriptsCheck, (_e, code: unknown, opts?: unknown) => scripts.check(str(code), { trial: !!(opts && typeof opts === 'object' && (opts as { trial?: unknown }).trial === true) }));
  handle(INVOKE.scriptsPreview, async (_e, req: unknown, seeds: unknown) => {
    const r = cleanRunRequest(req);
    if (!r) return [BAD_RUN];
    const list = Array.isArray(seeds) ? seeds.filter((s): s is number => Number.isInteger(s) && s >= 0 && s <= 0xffffffff).slice(0, 8) : [];
    return scripts.previews(r, list.length ? list : [r.seed]);
  });
  handle(INVOKE.scriptsApply, async (_e, req: unknown) => {
    const r = cleanRunRequest(req);
    if (!r) return BAD_RUN;
    return scripts.apply(r, userApply(doc));
  });
  handle(INVOKE.scriptsSaveToLibrary, (_e, code: unknown, name?: unknown) => scripts.saveToLibrary(str(code), typeof name === 'string' ? name : undefined));
  handle(INVOKE.scriptsRemoveFromLibrary, (_e, id: unknown) => scripts.removeFromLibrary(str(id)));
  handle(INVOKE.scriptsRevealLibrary, () => {
    const dir = ensureDir(scripts.libraryDir);
    const r = showItemInFolder(dir);
    return r.ok ? { ok: true, message: 'Opened your script library folder' } : { ok: false, message: `Couldn't open ${dir}: ${r.message ?? 'unknown error'}` };
  });
}

/**
 * Fan main-side state out to every renderer window: document changes,
 * engine + project status, render progress, settings and log lines.
 */
export function wireBroadcasts(d: Pick<IpcDeps, 'doc' | 'engine' | 'project'> & { onSettingsChanged(fn: (s: Settings) => void): () => void }): void {
  d.doc.subscribe((c) => {
    if (c.kind === 'reset') broadcast(EVENT.docReset, { version: c.version, project: c.project });
    else broadcast(EVENT.docPatches, { version: c.version, kind: c.kind, actor: c.actor, label: c.label, patches: c.patches });
    broadcast(EVENT.docHistory);
  });
  d.engine.onStatus((s) => broadcast(EVENT.engineStatus, s));
  d.engine.onEvent((ev) => {
    if (ev.event === 'renderProgress') broadcast(EVENT.engineRenderProgress, Math.max(0, Math.min(1, Number(ev.progress) || 0)));
  });
  d.project.onStatus((s) => broadcast(EVENT.projectStatus, s));
  d.onSettingsChanged((s) => broadcast(EVENT.settingsChanged, s));
  logger.subscribe((entry) => broadcast(EVENT.logAppend, entry));
}
