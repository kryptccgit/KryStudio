// Every IPC channel name, in one place. preload.ts and ipc.ts both import
// this (preload bundles it inline; it must stay dependency-free so the
// sandboxed preload only ever requires 'electron').

import { MCP_CHANNELS } from './mcp/types';

/** renderer → main, ipcRenderer.invoke / ipcMain.handle */
export const INVOKE = {
  appVersion: 'app:version',
  appOpenExternal: 'app:openExternal',
  appShowItemInFolder: 'app:showItemInFolder',
  appWindow: 'app:window',
  appIsMaximized: 'app:isMaximized',

  docSnapshot: 'doc:snapshot',
  docExec: 'doc:exec',
  docExecBatch: 'doc:execBatch',
  docBeginGroup: 'doc:beginGroup',
  docEndGroup: 'doc:endGroup',
  docUndo: 'doc:undo',
  docRedo: 'doc:redo',
  docHistory: 'doc:getHistory',
  docToggleEntry: 'doc:toggleEntry',
  docRevertActor: 'doc:revertActor',

  projectStatus: 'project:getStatus',
  projectNew: 'project:new',
  projectTemplates: 'project:templates',
  projectSaveTemplate: 'project:saveTemplate',
  projectNewFromTemplate: 'project:newFromTemplate',
  projectRenameTemplate: 'project:renameTemplate',
  projectDeleteTemplate: 'project:deleteTemplate',
  projectOpen: 'project:open',
  projectSave: 'project:save',
  projectSaveAs: 'project:saveAs',
  projectImportMidi: 'project:importMidi',
  projectExportMidi: 'project:exportMidi',
  // Song info + cover (electron/project/cover.ts; the bytes stay in main)
  projectCover: 'project:cover',
  projectChooseCover: 'project:chooseCover',
  projectSetCoverImage: 'project:setCoverImage',
  projectExportCapabilities: 'project:exportCapabilities',

  engineStatus: 'engine:getStatus',
  engineTelemetryUrl: 'engine:telemetryUrl',
  engineTransport: 'engine:transport',
  engineLocate: 'engine:locate',
  enginePreviewFile: 'engine:previewFile',
  engineStopPreview: 'engine:stopPreview',
  engineListDevices: 'engine:listDevices',
  engineOpenDevice: 'engine:openDevice',
  engineRender: 'engine:render',
  engineSampleInfo: 'engine:sampleInfo',
  enginePeaks: 'engine:peaks',
  engineAnalyzeFile: 'engine:analyzeFile',
  engineRestart: 'engine:restart',

  browserRoots: 'browser:roots',
  browserList: 'browser:list',
  browserAddRoot: 'browser:addRoot',
  browserRemoveRoot: 'browser:removeRoot',

  dialogOpenFile: 'dialog:openFile',
  dialogSaveFile: 'dialog:saveFile',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  mcpStatus: 'mcp:getStatus',
  mcpClientConfigs: 'mcp:clientConfigs',
  mcpInstallClientConfig: 'mcp:installClientConfig',
  mcpSetEnabled: 'mcp:setEnabled',

  agentSetApiKey: 'agent:setApiKey',
  agentSend: 'agent:send',
  agentCancel: 'agent:cancel',
  agentReset: 'agent:reset',

  // Live input / recording (electron/input/liveInput.ts)
  midiInputs: 'midi:inputs',
  midiSetInputEnabled: 'midi:setInputEnabled',
  midiLearn: 'midi:learn',
  midiRemoveMapping: 'midi:removeMapping',
  // MIDI outputs, clock out, sync in (electron/midi/hardware.ts)
  midiOutputs: 'midi:outputs',
  midiSetOutputEnabled: 'midi:setOutputEnabled',
  midiClockSettings: 'midi:clockSettings',
  midiSetClockSettings: 'midi:setClockSettings',
  recordStatus: 'record:getStatus',
  recordSetArmed: 'record:setArmed',
  recordListInputDevices: 'record:listInputDevices',
  /** Recording Studio mic test: open / close the input for its level meter only. */
  recordSetMeter: 'record:setMeter',

  // Third-party VST3 / CLAP plugins (electron/plugins)
  pluginsState: 'plugins:getState',
  pluginsRescan: 'plugins:rescan',
  pluginsAddFolder: 'plugins:addFolder',
  pluginsRemoveFolder: 'plugins:removeFolder',
  pluginsUnblock: 'plugins:unblock',
  pluginsOpenEditor: 'plugins:openEditor',
  pluginsReload: 'plugins:reload',

  // On-device audio ML: analysis, stems, audio → pattern, Model Manager (electron/analyzer)
  analyzerState: 'analyzer:getState',
  analyzerInstallModel: 'analyzer:installModel',
  analyzerCancelInstall: 'analyzer:cancelInstall',
  analyzerImportModel: 'analyzer:importModel',
  analyzerRemoveModel: 'analyzer:removeModel',
  analyzerAnalyze: 'analyzer:analyze',
  analyzerSeparateStems: 'analyzer:separateStems',
  analyzerToPattern: 'analyzer:toPattern',
  analyzerCancelJob: 'analyzer:cancelJob',

  // Vocals & mashups: Krypt Tune on a clip, match key & tempo (electron/vocals; same service as the MCP tools)
  vocalsTune: 'vocals:tune',
  vocalsMatch: 'vocals:match',
  // Warp: auto-warp an audio clip channel to its beat grid (Wave 12.2; electron/warp)
  warpAutoWarp: 'warp:autoWarp',
  // Audio → project (Wave 8a, research/15 §3; electron/audioProject)
  audioProjectOpen: 'audioProject:open',
  audioProjectCancel: 'audioProject:cancel',

  // Reference library: the user's own songs → features, style profiles, focus, originality (electron/library)
  libraryState: 'library:getState',
  libraryCreateCollection: 'library:createCollection',
  libraryUpdateCollection: 'library:updateCollection',
  libraryRemoveCollection: 'library:removeCollection',
  libraryAddFolder: 'library:addFolder',
  libraryAddFiles: 'library:addFiles',
  libraryRemoveTracks: 'library:removeTracks',
  libraryRescan: 'library:rescan',
  librarySetDeep: 'library:setDeep',
  libraryEstimateDeep: 'library:estimateDeep',
  librarySetPaused: 'library:setPaused',
  libraryRetryFailed: 'library:retryFailed',
  libraryQuery: 'library:query',
  libraryTrack: 'library:track',
  libraryProfile: 'library:profile',
  librarySimilar: 'library:similar',
  libraryCheckOriginality: 'library:checkOriginality',
  librarySetFocus: 'library:setFocus',
  libraryAddToProject: 'library:addToProject',
  // Sounds: presets + factory sample index (electron/sounds)
  soundsState: 'sounds:getState',
  soundsGet: 'sounds:get',
  soundsSaveChannel: 'sounds:saveChannel',
  soundsSaveChain: 'sounds:saveChain',
  soundsRenameUser: 'sounds:renameUser',
  soundsDeleteUser: 'sounds:deleteUser',
  soundsRevealUserDir: 'sounds:revealUserDir',
  soundsFactorySamples: 'sounds:factorySamples',
  soundsSuggestSampleFolders: 'sounds:suggestSampleFolders',
  soundsSimilar: 'sounds:similar',
  // Sound packs (electron/packs)
  packsState: 'packs:getState',
  packsInstall: 'packs:install',
  packsCancel: 'packs:cancel',
  packsRemove: 'packs:remove',
  packsReveal: 'packs:reveal',
  packsSamples: 'packs:samples',
  // Clip launcher runtime (Wave 12.2; handlers: launcher-app)
  sessionLaunch: 'session:launch',
  sessionLaunchScene: 'session:launchScene',
  sessionStop: 'session:stop',
  sessionBackToArrangement: 'session:backToArrangement',
  sessionSetRecord: 'session:setRecord',
  sessionRecordState: 'session:recordState',
  sessionGridSettings: 'session:gridSettings',
  sessionSetGridSettings: 'session:setGridSettings',
  // Krypt Voice (handlers: voice-app)
  voiceState: 'voice:getState',
  voiceSpeak: 'voice:speak',
  voiceSing: 'voice:sing',
  voiceCancel: 'voice:cancel',
  voiceSetFishKey: 'voice:setFishKey',
  voiceCloneMine: 'voice:cloneMine',
  voiceRemoveMine: 'voice:removeMine',
  // Auto Mix / Auto Master (handlers: automix-core)
  automixPresets: 'automix:presets',
  automixUnderstand: 'automix:understand',
  automixRun: 'automix:run',
  automixMasterFile: 'automix:masterFile',
  automixCancel: 'automix:cancel',
  automixAnalyzeReference: 'automix:analyzeReference',
  automixPlayReference: 'automix:playReference',
  automixMasterAlbum: 'automix:masterAlbum',
  automixExportAlbum: 'automix:exportAlbum',
  // Project tabs (handlers: tabs-core)
  tabsState: 'tabs:getState',
  tabsNew: 'tabs:new',
  tabsOpen: 'tabs:open',
  tabsSwitch: 'tabs:switch',
  tabsClose: 'tabs:close',
  tabsMove: 'tabs:move',
  tabsReopenClosed: 'tabs:reopenClosed',
  // Auto Mashup (handlers: mashup-core)
  mashupCheck: 'mashup:check',
  mashupBuild: 'mashup:build',
  mashupCancel: 'mashup:cancel',
  // Racks (Wave 12.2; racks-app): slice audio onto a drum rack (analyzer onsets)
  racksSliceToPads: 'racks:sliceToPads',
  // Krypt Script (Wave 12.2b; scripts): sandboxed note devices, run in main only
  scriptsList: 'scripts:list',
  scriptsCheck: 'scripts:check',
  scriptsPreview: 'scripts:preview',
  scriptsApply: 'scripts:apply',
  scriptsSaveToLibrary: 'scripts:saveToLibrary',
  scriptsRemoveFromLibrary: 'scripts:removeFromLibrary',
  scriptsRevealLibrary: 'scripts:revealLibrary',
} as const;

/** renderer → main, fire-and-forget (ipcRenderer.send / ipcMain.on) */
export const SEND = {
  engineAudition: 'engine:audition',
  engineAuditionOff: 'engine:auditionOff',
  /** The renderer subscribed to app:openFile; flush queued paths to it. */
  appOpenFileReady: 'app:openFileReady',
  midiSetTarget: 'midi:setTarget',
  midiCancelLearn: 'midi:cancelLearn',
  /** Gamepad / keyboard-pad MIDI → the engine's virtual input ({device, bytes}). */
  midiVirtualIn: 'midi:virtualIn',
  /** The window's answer to EVENT.coverRequest: (id, CoverDrawResult). */
  coverRespond: 'cover:respond',
} as const;

/** main → renderer broadcasts (webContents.send) */
export const EVENT = {
  appMaximizedChanged: 'app:maximizedChanged',
  appOpenFile: 'app:openFile',
  docPatches: 'doc:patches',
  docReset: 'doc:reset',
  docHistory: 'doc:history',
  projectStatus: 'project:status',
  engineStatus: 'engine:status',
  engineRenderProgress: 'engine:renderProgress',
  settingsChanged: 'settings:changed',
  logAppend: 'log:append',
  mcpStatus: MCP_CHANNELS.status,
  mcpActivity: MCP_CHANNELS.activity,
  agentEvent: MCP_CHANNELS.agentEvent,
  midiInputsChanged: 'midi:inputsChanged',
  midiLearnState: 'midi:learnState',
  midiOutputsChanged: 'midi:outputsChanged',
  recordStatus: 'record:status',
  pluginsChanged: 'plugins:changed',
  analyzerState: 'analyzer:state',
  audioProjectProgress: 'audioProject:progress',
  libraryState: 'library:state',
  soundsState: 'sounds:state',
  packsState: 'packs:state',
  sessionRecordState: 'session:recordState',
  mashupProgress: 'mashup:progress',
  automixProgress: 'automix:progress',
  voiceState: 'voice:state',
  voiceProgress: 'voice:progress',
  tabsState: 'tabs:state',
  /** Main asks the main window to draw a generated cover (set_cover {generate}). */
  coverRequest: 'cover:request',
  /** racks.sliceToPads progress (SliceProgress). */
  racksSliceProgress: 'racks:sliceProgress',
} as const;
