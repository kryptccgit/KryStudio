// ──────────────────────────────────────────────────────────────────────
// What Home cards, Home screens and Guides buttons do. One implementation
// per HomeActionId (a full Record, so typecheck fails on a missing one).
// Panel actions go through wm.*, whose reveal hook steps Home aside so
// the panel is visible; dialogs (export, originality) open over Home.
// Every action ends in visible feedback: a view change, a dialog or a toast.
// ──────────────────────────────────────────────────────────────────────

import type { SingletonKind } from '../workspace/panels';
import { wm } from '../workspace/WindowManager';
import { importMidi, newProject, openExport, openProject } from '../app/actions';
import { runCommand } from '../input/commands';
import { toast } from '../app/notify';
import { openLibrary } from '../library/actions';
import { openGuides, showHome, showStudio } from './store';
import type { HomeActionId } from './logic';
import { openPresetsInBrowser } from '../sounds/actions';
import { openAudioAsProject } from '../audioProject/actions';
import { openMashup } from '../mashup/actions';
import { openAutoMix, openMasterSong } from '../automix/actions';
import { openMasterAlbum } from '../automix/albumActions';
import { openKryptVoice } from '../voice/VoiceDialog';
import { startTour } from '../tours/store';
import { openTourPicker } from '../tours/TourOverlay';
import { openBooth } from '../booth/actions';

/** Absolute path of the first bundled demo project, via the read-only "Demo projects" browser root. */
export async function findDemo(): Promise<string | null> {
  const roots = await window.krypt.browser.roots();
  const demos = roots.find((r) => r.id === 'demos');
  if (!demos) return null;
  const r = await window.krypt.browser.list(demos.path);
  if (!r.ok || !r.data) return null;
  return r.data.find((e) => e.kind === 'project' || /\.kstudio$/i.test(e.name))?.path ?? null;
}

export async function openDemo(): Promise<boolean> {
  try {
    const demo = await findDemo();
    if (!demo) {
      toast.error("The demo project isn't installed. Reinstall Krypt Studio, or run `npm run make-demo` in a dev checkout.");
      return false;
    }
    return await openProject(demo); // success → Studio (onProjectPicked)
  } catch (err) {
    toast.error(`Couldn't open the demo: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

const panel = (kind: SingletonKind) => (): void => wm.open(kind);

export const HOME_ACTIONS: Record<HomeActionId, { label: string; run: () => unknown }> = {
  studio: { label: 'Go to the Studio', run: showStudio },
  projects: { label: 'Projects', run: () => showHome('projects') },
  newProject: { label: 'New project', run: () => newProject() },
  openProject: { label: 'Open a project…', run: () => openProject() },
  openDemo: { label: 'Open the demo', run: openDemo },
  importMidi: {
    label: 'Import MIDI…',
    run: async () => {
      if (await importMidi()) showStudio();
    },
  },
  audioProject: { label: 'Open audio as project', run: () => openAudioAsProject() },
  autoMashup: { label: 'Auto Mashup', run: () => openMashup() },
  autoMix: { label: 'Auto Mix', run: () => openAutoMix() },
  masterSong: { label: 'Master a song', run: () => openMasterSong() },
  masterAlbum: { label: 'Master an album', run: () => openMasterAlbum() },
  kryptVoice: { label: 'Krypt Voice', run: () => openKryptVoice() },
  agents: { label: 'AI Agents', run: () => showHome('agents') },
  agentPanel: { label: 'Agent chat', run: panel('agent') },
  history: { label: 'History', run: panel('history') },
  library: { label: 'Reference Library', run: () => openLibrary() },
  checkOriginality: { label: 'Check originality', run: () => runCommand('tools.checkOriginality') },
  audioTools: { label: 'Audio Tools', run: () => showHome('audio') },
  modelManager: { label: 'Model Manager', run: panel('modelManager') },
  sounds: { label: 'Sounds & Plugins', run: () => showHome('sounds') },
  presets: { label: 'Presets', run: openPresetsInBrowser },
  browser: { label: 'Browser', run: panel('browser') },
  pluginManager: { label: 'Plugin Manager', run: panel('pluginManager') },
  export: { label: 'Export audio', run: openExport },
  recording: { label: 'Recording Studio', run: () => showHome('recording') },
  booth: { label: 'Vocal Booth', run: () => void openBooth() },
  settings: { label: 'Settings', run: panel('settings') },
  shortcuts: { label: 'Keyboard shortcuts', run: () => runCommand('tools.shortcuts') },
  channelRack: { label: 'Channel Rack', run: panel('channelRack') },
  pianoRoll: { label: 'Piano Roll', run: panel('pianoRoll') },
  playlist: { label: 'Playlist', run: panel('playlist') },
  mixer: { label: 'Mixer', run: panel('mixer') },
  guides: { label: 'Guides', run: () => openGuides() },
  session: { label: 'Session view', run: panel('session') },
  tours: { label: 'Tours', run: () => openTourPicker() },
  tourFirstBeat: { label: 'Tour: your first beat', run: () => startTour('first-beat') },
  tourWindows: { label: 'Tour: windows and shortcuts', run: () => startTour('windows') },
  tourSong: { label: 'Tour: make a song from your beat', run: () => startTour('song') },
  tourAi: { label: 'Tour: set up AI', run: () => startTour('ai') },
  tourMaster: { label: 'Tour: master a song', run: () => startTour('master') },
};

/** Run a Home / Guides action by id; failures toast (never silent). */
export function runHomeAction(id: HomeActionId): void {
  const a = HOME_ACTIONS[id];
  if (!a) {
    toast.error(`Unknown action "${id}"`);
    return;
  }
  try {
    const r = a.run();
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      (r as Promise<unknown>).catch((err) => toast.error(`${a.label} failed: ${(err as Error)?.message ?? String(err)}`));
    }
  } catch (err) {
    toast.error(`${a.label} failed: ${(err as Error)?.message ?? String(err)}`);
  }
}
