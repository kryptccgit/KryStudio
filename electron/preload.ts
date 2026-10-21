// ──────────────────────────────────────────────────────────────────────
// preload: the ONLY seam between the renderer and main. Implements the
// KryptApi contract (shared/types.ts) over ipcRenderer; every channel has a
// matching handler in electron/ipc.ts (names in channels.ts). Sandboxed:
// this bundle may only require 'electron'. Every subscription returns its
// unsubscribe function (no listener leaks across HMR).
// ──────────────────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { KryptApi } from '@shared/types';
import { EVENT, INVOKE, SEND } from './channels';

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => {
    try {
      cb(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[krypt] listener for ${channel} threw`, err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const krypt: KryptApi = {
  app: {
    version: () => invoke(INVOKE.appVersion),
    openExternal: (url) => invoke(INVOKE.appOpenExternal, url),
    showItemInFolder: (p) => invoke(INVOKE.appShowItemInFolder, p),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    window: (action) => invoke(INVOKE.appWindow, action),
    isMaximized: () => invoke(INVOKE.appIsMaximized),
    onMaximizedChanged: (cb) => sub<boolean>(EVENT.appMaximizedChanged, cb),
    onOpenFile: (cb) => {
      const off = sub<string>(EVENT.appOpenFile, cb);
      // Paths that arrived before anyone listened (launch args) are queued in main.
      ipcRenderer.send(SEND.appOpenFileReady);
      return off;
    },
  },
  doc: {
    snapshot: () => invoke(INVOKE.docSnapshot),
    exec: (cmd, args, opts) => invoke(INVOKE.docExec, cmd, args, opts),
    execBatch: (steps, opts) => invoke(INVOKE.docExecBatch, steps, opts),
    beginGroup: (label) => invoke(INVOKE.docBeginGroup, label),
    endGroup: (groupId) => invoke(INVOKE.docEndGroup, groupId),
    undo: () => invoke(INVOKE.docUndo),
    redo: () => invoke(INVOKE.docRedo),
    history: () => invoke(INVOKE.docHistory),
    toggleEntry: (entryId) => invoke(INVOKE.docToggleEntry, entryId),
    revertActor: (actorKey) => invoke(INVOKE.docRevertActor, actorKey),
    onPatches: (cb) => sub(EVENT.docPatches, cb),
    onReset: (cb) => sub(EVENT.docReset, cb),
    onHistoryChanged: (cb) => sub<void>(EVENT.docHistory, () => cb()),
  },
  project: {
    status: () => invoke(INVOKE.projectStatus),
    newProject: () => invoke(INVOKE.projectNew),
    templates: () => invoke(INVOKE.projectTemplates),
    saveAsTemplate: (name) => invoke(INVOKE.projectSaveTemplate, name),
    newFromTemplate: (id) => invoke(INVOKE.projectNewFromTemplate, id),
    renameTemplate: (id, name) => invoke(INVOKE.projectRenameTemplate, id, name),
    deleteTemplate: (id) => invoke(INVOKE.projectDeleteTemplate, id),
    open: (p) => invoke(INVOKE.projectOpen, p),
    save: () => invoke(INVOKE.projectSave),
    saveAs: () => invoke(INVOKE.projectSaveAs),
    importMidi: (p) => invoke(INVOKE.projectImportMidi, p),
    exportMidi: (patternId) => invoke(INVOKE.projectExportMidi, patternId),
    onStatus: (cb) => sub(EVENT.projectStatus, cb),
    cover: () => invoke(INVOKE.projectCover),
    chooseCover: (p) => invoke(INVOKE.projectChooseCover, p),
    setCoverImage: (bytes, mime, label) => invoke(INVOKE.projectSetCoverImage, bytes, mime, label),
    onCoverRequest: (cb) => sub(EVENT.coverRequest, cb),
    respondCover: (id, result) => ipcRenderer.send(SEND.coverRespond, id, result),
    exportCapabilities: () => invoke(INVOKE.projectExportCapabilities),
  },
  engine: {
    status: () => invoke(INVOKE.engineStatus),
    onStatus: (cb) => sub(EVENT.engineStatus, cb),
    telemetryUrl: () => invoke(INVOKE.engineTelemetryUrl),
    transport: (action) => invoke(INVOKE.engineTransport, action),
    locate: (tick) => invoke(INVOKE.engineLocate, tick),
    audition: (channelId, key, vel, on) => ipcRenderer.send(SEND.engineAudition, { channelId, key, vel, on }),
    auditionOff: () => ipcRenderer.send(SEND.engineAuditionOff),
    previewFile: (p) => invoke(INVOKE.enginePreviewFile, p),
    stopPreview: () => invoke(INVOKE.engineStopPreview),
    listDevices: () => invoke(INVOKE.engineListDevices),
    openDevice: (opts) => invoke(INVOKE.engineOpenDevice, opts),
    render: (opts) => invoke(INVOKE.engineRender, opts),
    onRenderProgress: (cb) => sub<number>(EVENT.engineRenderProgress, cb),
    sampleInfo: (p) => invoke(INVOKE.engineSampleInfo, p),
    peaks: (p, buckets) => invoke(INVOKE.enginePeaks, p, buckets),
    analyzeFile: (p) => invoke(INVOKE.engineAnalyzeFile, p),
    restart: () => invoke(INVOKE.engineRestart),
  },
  browser: {
    roots: () => invoke(INVOKE.browserRoots),
    list: (dir) => invoke(INVOKE.browserList, dir),
    addRoot: () => invoke(INVOKE.browserAddRoot),
    removeRoot: (id) => invoke(INVOKE.browserRemoveRoot, id),
  },
  dialog: {
    openFile: (opts) => invoke(INVOKE.dialogOpenFile, opts),
    saveFile: (opts) => invoke(INVOKE.dialogSaveFile, opts),
  },
  settings: {
    get: () => invoke(INVOKE.settingsGet),
    update: (patch) => invoke(INVOKE.settingsUpdate, patch),
    onChanged: (cb) => sub(EVENT.settingsChanged, cb),
  },
  mcp: {
    status: () => invoke(INVOKE.mcpStatus),
    onStatus: (cb) => sub(EVENT.mcpStatus, cb),
    onActivity: (cb) => sub(EVENT.mcpActivity, cb),
    clientConfigs: () => invoke(INVOKE.mcpClientConfigs),
    installClientConfig: (client) => invoke(INVOKE.mcpInstallClientConfig, client),
    setEnabled: (enabled) => invoke(INVOKE.mcpSetEnabled, enabled),
  },
  agent: {
    setApiKey: (key, provider) => invoke(INVOKE.agentSetApiKey, key, provider),
    send: (message) => invoke(INVOKE.agentSend, message),
    cancel: () => invoke(INVOKE.agentCancel),
    reset: () => invoke(INVOKE.agentReset),
    onEvent: (cb) => sub(EVENT.agentEvent, cb),
  },
  log: {
    onAppend: (cb) => sub(EVENT.logAppend, cb),
  },
  midi: {
    inputs: () => invoke(INVOKE.midiInputs),
    setInputEnabled: (id, enabled) => invoke(INVOKE.midiSetInputEnabled, id, enabled),
    setTarget: (channelId) => ipcRenderer.send(SEND.midiSetTarget, channelId),
    learn: (paramRef, label) => invoke(INVOKE.midiLearn, paramRef, label),
    cancelLearn: () => ipcRenderer.send(SEND.midiCancelLearn),
    virtualIn: (device, bytes) => ipcRenderer.send(SEND.midiVirtualIn, { device, bytes }),
    removeMapping: (id) => invoke(INVOKE.midiRemoveMapping, id),
    onInputs: (cb) => sub(EVENT.midiInputsChanged, cb),
    onLearn: (cb) => sub(EVENT.midiLearnState, cb),
    outputs: () => invoke(INVOKE.midiOutputs),
    setOutputEnabled: (id, enabled) => invoke(INVOKE.midiSetOutputEnabled, id, enabled),
    clockSettings: () => invoke(INVOKE.midiClockSettings),
    setClockSettings: (patch) => invoke(INVOKE.midiSetClockSettings, patch),
    onOutputs: (cb) => sub(EVENT.midiOutputsChanged, cb),
  },
  record: {
    status: () => invoke(INVOKE.recordStatus),
    setArmed: (armed) => invoke(INVOKE.recordSetArmed, armed),
    listInputDevices: () => invoke(INVOKE.recordListInputDevices),
    setMeter: (on) => invoke(INVOKE.recordSetMeter, on),
    onStatus: (cb) => sub(EVENT.recordStatus, cb),
  },
  plugins: {
    state: () => invoke(INVOKE.pluginsState),
    rescan: (opts) => invoke(INVOKE.pluginsRescan, opts),
    addFolder: () => invoke(INVOKE.pluginsAddFolder),
    removeFolder: (p) => invoke(INVOKE.pluginsRemoveFolder, p),
    unblock: (p) => invoke(INVOKE.pluginsUnblock, p),
    openEditor: (target, open) => invoke(INVOKE.pluginsOpenEditor, target, open),
    reload: () => invoke(INVOKE.pluginsReload),
    onState: (cb) => sub(EVENT.pluginsChanged, cb),
  },
  analyzer: {
    state: () => invoke(INVOKE.analyzerState),
    installModel: (id) => invoke(INVOKE.analyzerInstallModel, id),
    cancelInstall: (id) => invoke(INVOKE.analyzerCancelInstall, id),
    importModel: (id) => invoke(INVOKE.analyzerImportModel, id),
    removeModel: (id) => invoke(INVOKE.analyzerRemoveModel, id),
    analyze: (target) => invoke(INVOKE.analyzerAnalyze, target),
    separateStems: (clipId, opts) => invoke(INVOKE.analyzerSeparateStems, clipId, opts),
    toPattern: (target, opts) => invoke(INVOKE.analyzerToPattern, target, opts),
    cancelJob: (jobId) => invoke(INVOKE.analyzerCancelJob, jobId),
    onState: (cb) => sub(EVENT.analyzerState, cb),
  },
  audioProject: {
    open: (path, opts) => invoke(INVOKE.audioProjectOpen, path, opts),
    cancel: () => invoke(INVOKE.audioProjectCancel),
    onProgress: (cb) => sub(EVENT.audioProjectProgress, cb),
  },
  vocals: {
    tune: (target, opts) => invoke(INVOKE.vocalsTune, target, opts),
    match: (clipId, opts) => invoke(INVOKE.vocalsMatch, clipId, opts),
  },
  warp: {
    autoWarp: (channelId, opts) => invoke(INVOKE.warpAutoWarp, channelId, opts),
  },
  library: {
    state: () => invoke(INVOKE.libraryState),
    onState: (cb) => sub(EVENT.libraryState, cb),
    createCollection: (name, tags) => invoke(INVOKE.libraryCreateCollection, name, tags),
    updateCollection: (id, patch) => invoke(INVOKE.libraryUpdateCollection, id, patch),
    removeCollection: (id) => invoke(INVOKE.libraryRemoveCollection, id),
    addFolder: (collectionId, p) => invoke(INVOKE.libraryAddFolder, collectionId, p),
    addFiles: (collectionId, paths) => invoke(INVOKE.libraryAddFiles, collectionId, paths),
    removeTracks: (ids) => invoke(INVOKE.libraryRemoveTracks, ids),
    rescan: (collectionId) => invoke(INVOKE.libraryRescan, collectionId),
    setDeep: (collectionId, deep) => invoke(INVOKE.librarySetDeep, collectionId, deep),
    estimateDeep: (collectionId) => invoke(INVOKE.libraryEstimateDeep, collectionId),
    setPaused: (paused) => invoke(INVOKE.librarySetPaused, paused),
    retryFailed: (collectionId) => invoke(INVOKE.libraryRetryFailed, collectionId),
    query: (q) => invoke(INVOKE.libraryQuery, q),
    track: (id) => invoke(INVOKE.libraryTrack, id),
    profile: (collectionId) => invoke(INVOKE.libraryProfile, collectionId),
    similar: (trackId, opts) => invoke(INVOKE.librarySimilar, trackId, opts),
    checkOriginality: (opts) => invoke(INVOKE.libraryCheckOriginality, opts),
    setFocus: (focus) => invoke(INVOKE.librarySetFocus, focus),
    addToProject: (trackId) => invoke(INVOKE.libraryAddToProject, trackId),
  },
  sounds: {
    state: () => invoke(INVOKE.soundsState),
    onState: (cb) => sub(EVENT.soundsState, cb),
    get: (id) => invoke(INVOKE.soundsGet, id),
    saveChannel: (channelId, meta) => invoke(INVOKE.soundsSaveChannel, channelId, meta),
    saveChain: (insertId, meta) => invoke(INVOKE.soundsSaveChain, insertId, meta),
    renameUser: (id, name) => invoke(INVOKE.soundsRenameUser, id, name),
    deleteUser: (id) => invoke(INVOKE.soundsDeleteUser, id),
    revealUserDir: () => invoke(INVOKE.soundsRevealUserDir),
    factorySamples: () => invoke(INVOKE.soundsFactorySamples),
    suggestSampleFolders: () => invoke(INVOKE.soundsSuggestSampleFolders),
    similar: (source, query) => invoke(INVOKE.soundsSimilar, source, query),
  },
  packs: {
    state: () => invoke(INVOKE.packsState),
    onState: (cb) => sub(EVENT.packsState, cb),
    install: (id) => invoke(INVOKE.packsInstall, id),
    cancel: (id) => invoke(INVOKE.packsCancel, id),
    remove: (id) => invoke(INVOKE.packsRemove, id),
    reveal: (id) => invoke(INVOKE.packsReveal, id),
    samples: () => invoke(INVOKE.packsSamples),
  },
  voice: {
    state: () => invoke(INVOKE.voiceState),
    onState: (cb) => sub(EVENT.voiceState, cb),
    speak: (req) => invoke(INVOKE.voiceSpeak, req),
    sing: (req) => invoke(INVOKE.voiceSing, req),
    cancel: () => invoke(INVOKE.voiceCancel),
    onProgress: (cb) => sub(EVENT.voiceProgress, cb),
    setFishKey: (key) => invoke(INVOKE.voiceSetFishKey, key),
    cloneMyVoice: (opts) => invoke(INVOKE.voiceCloneMine, opts),
    removeMyVoice: (id) => invoke(INVOKE.voiceRemoveMine, id),
  },
  automix: {
    presets: () => invoke(INVOKE.automixPresets),
    understand: (prompt) => invoke(INVOKE.automixUnderstand, prompt),
    run: (req) => invoke(INVOKE.automixRun, req),
    masterFile: (req) => invoke(INVOKE.automixMasterFile, req),
    analyzeReference: (p) => invoke(INVOKE.automixAnalyzeReference, p),
    playReference: (p, matchLufs) => invoke(INVOKE.automixPlayReference, p, matchLufs),
    masterAlbum: (req) => invoke(INVOKE.automixMasterAlbum, req),
    exportAlbum: (req) => invoke(INVOKE.automixExportAlbum, req),
    cancel: () => invoke(INVOKE.automixCancel),
    onProgress: (cb) => sub(EVENT.automixProgress, cb),
  },
  tabs: {
    state: () => invoke(INVOKE.tabsState),
    onState: (cb) => sub(EVENT.tabsState, cb),
    newTab: (opts) => invoke(INVOKE.tabsNew, opts),
    open: (path) => invoke(INVOKE.tabsOpen, path),
    switchTo: (id) => invoke(INVOKE.tabsSwitch, id),
    close: (id, decision) => invoke(INVOKE.tabsClose, id, decision),
    move: (id, toIndex) => invoke(INVOKE.tabsMove, id, toIndex),
    reopenClosed: () => invoke(INVOKE.tabsReopenClosed),
  },
  mashup: {
    check: (req) => invoke(INVOKE.mashupCheck, req),
    build: (req) => invoke(INVOKE.mashupBuild, req),
    cancel: () => invoke(INVOKE.mashupCancel),
    onProgress: (cb) => sub(EVENT.mashupProgress, cb),
  },
  session: {
    launch: (clipId, release) => invoke(INVOKE.sessionLaunch, clipId, release),
    launchScene: (sceneId) => invoke(INVOKE.sessionLaunchScene, sceneId),
    stop: (trackId) => invoke(INVOKE.sessionStop, trackId),
    backToArrangement: () => invoke(INVOKE.sessionBackToArrangement),
    setRecord: (on) => invoke(INVOKE.sessionSetRecord, on),
    recordState: () => invoke(INVOKE.sessionRecordState),
    onRecordState: (cb) => sub(EVENT.sessionRecordState, cb),
    gridSettings: () => invoke(INVOKE.sessionGridSettings),
    setGridSettings: (patch) => invoke(INVOKE.sessionSetGridSettings, patch),
  },
  racks: {
    sliceToPads: (source, opts) => invoke(INVOKE.racksSliceToPads, source, opts),
    onSliceProgress: (cb) => sub(EVENT.racksSliceProgress, cb),
  },
  scripts: {
    list: () => invoke(INVOKE.scriptsList),
    check: (code, opts) => invoke(INVOKE.scriptsCheck, code, opts),
    preview: (req, seeds) => invoke(INVOKE.scriptsPreview, req, seeds),
    apply: (req) => invoke(INVOKE.scriptsApply, req),
    saveToLibrary: (code, name) => invoke(INVOKE.scriptsSaveToLibrary, code, name),
    removeFromLibrary: (id) => invoke(INVOKE.scriptsRemoveFromLibrary, id),
    revealLibrary: () => invoke(INVOKE.scriptsRevealLibrary),
  },
};

contextBridge.exposeInMainWorld('krypt', krypt);
