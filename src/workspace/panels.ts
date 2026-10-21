import { Blocks, BookOpen, Bot, BrainCircuit, FolderTree, Grid3x3, History, Info, LayoutGrid, LibraryBig, ListMusic, Piano, Plug, Settings, SlidersVertical, type LucideIcon } from 'lucide-react';

export type SingletonKind = 'browser' | 'channelRack' | 'pianoRoll' | 'playlist' | 'mixer' | 'agent' | 'history' | 'settings' | 'about' | 'pluginManager' | 'modelManager' | 'library' | 'guides' | 'session';
export type PanelKind = SingletonKind | 'plugin';

export type Placement =
  | { mode: 'left'; width: number }
  | { mode: 'right'; width: number }
  | { mode: 'bottom'; height: number }
  | { mode: 'center' }
  | { mode: 'floating'; width: number; height: number; x?: number; y?: number };

export interface PanelDef {
  kind: PanelKind;
  title: string;
  icon: LucideIcon;
  shortcut?: string;
  description: string;
  place: Placement;
}

export const PANELS: Record<PanelKind, PanelDef> = {
  browser: { kind: 'browser', title: 'Browser', icon: FolderTree, shortcut: 'Alt+F8', description: 'Samples, projects and MIDI files', place: { mode: 'left', width: 240 } },
  playlist: { kind: 'playlist', title: 'Playlist', icon: ListMusic, shortcut: 'F5', description: 'Arrange patterns, audio and automation', place: { mode: 'center' } },
  channelRack: {
    kind: 'channelRack',
    title: 'Channel Rack',
    icon: LayoutGrid,
    shortcut: 'F6',
    description: 'Instruments and the step sequencer',
    place: { mode: 'floating', width: 800, height: 330, x: 270, y: 40 },
  },
  pianoRoll: {
    kind: 'pianoRoll',
    title: 'Piano Roll',
    icon: Piano,
    shortcut: 'F7',
    description: 'Edit the notes of the selected channel',
    place: { mode: 'floating', width: 940, height: 460, x: 120, y: 80 },
  },
  mixer: { kind: 'mixer', title: 'Mixer', icon: SlidersVertical, shortcut: 'F9', description: 'Inserts, routing and effects', place: { mode: 'bottom', height: 330 } },
  agent: { kind: 'agent', title: 'Agents', icon: Bot, description: 'MCP connections, activity and the built-in chat', place: { mode: 'right', width: 380 } },
  guides: { kind: 'guides', title: 'Guides', icon: BookOpen, shortcut: 'F1', description: 'How-tos for the app and for making music, beside your work', place: { mode: 'right', width: 440 } },
  history: { kind: 'history', title: 'History', icon: History, description: 'Every edit by you and by agents, revertable', place: { mode: 'right', width: 380 } },
  settings: { kind: 'settings', title: 'Settings', icon: Settings, description: 'Audio, autosave, agents, Discord', place: { mode: 'floating', width: 560, height: 560 } },
  about: { kind: 'about', title: 'About', icon: Info, description: 'Krypt Studio', place: { mode: 'floating', width: 480, height: 520 } },
  pluginManager: {
    kind: 'pluginManager',
    title: 'Plugin Manager',
    icon: Blocks,
    description: 'Installed VST3 / CLAP plugins, folders, rescans and the blocklist',
    place: { mode: 'floating', width: 720, height: 600 },
  },
  modelManager: {
    kind: 'modelManager',
    title: 'Model Manager',
    icon: BrainCircuit,
    description: 'On-device audio models for stems, transcription and beat tracking',
    place: { mode: 'floating', width: 640, height: 620 },
  },
  library: {
    kind: 'library',
    title: 'Library',
    icon: LibraryBig,
    description: 'Your reference songs: analysis, style profiles and the AI focus',
    place: { mode: 'floating', width: 1000, height: 640 },
  },
  session: {
    kind: 'session',
    title: 'Session',
    icon: Grid3x3,
    shortcut: 'F3',
    description: 'Clip launcher: launch patterns and audio live, scene by scene',
    place: { mode: 'center' },
  },
  plugin: { kind: 'plugin', title: 'Plugin', icon: Plug, description: 'Plugin editor', place: { mode: 'floating', width: 560, height: 440 } },
};

export const VIEW_MENU_ORDER: SingletonKind[] = ['playlist', 'channelRack', 'pianoRoll', 'mixer', 'browser', 'session', 'agent', 'history', 'guides', 'pluginManager', 'modelManager', 'library'];

export type PluginTarget = { kind: 'channel'; channelId: string } | { kind: 'slot'; insertId: string; slotId: string };

export function pluginPanelId(t: PluginTarget): string {
  return t.kind === 'channel' ? `plugin:ch:${t.channelId}` : `plugin:fx:${t.insertId}:${t.slotId}`;
}

export function kindOfPanelId(id: string): PanelKind | null {
  if (id.startsWith('plugin:')) return 'plugin';
  return (id in PANELS ? id : null) as PanelKind | null;
}
