// Frameless title bar: logo, menu bar (File / Edit / View / Tools / Help),
// the project tab strip (src/app/tabs, research/19) and the window buttons.

import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Blend,
  Blocks,
  BookOpen,
  Bot,
  BrainCircuit,
  Clapperboard,
  Compass,
  Crosshair,
  Download,
  FileMusic,
  FileText,
  FilePlus,
  FolderOpen,
  Globe,
  History,
  House,
  Info,
  LifeBuoy,
  Rocket,
  RotateCcw,
  Keyboard,
  LayoutTemplate,
  LibraryBig,
  Maximize2,
  MessageCircle,
  Metronome,
  Minimize2,
  Minus,
  OctagonX,
  Plug,
  Redo2,
  Save,
  Settings,
  ShieldCheck,
  Undo2,
  Upload,
  WandSparkles,
  X,
  type LucideIcon,
  MicVocal,
  DiscAlbum,
  Gauge,
} from 'lucide-react';
import { closeMenu, openMenuAt, type MenuItem } from '../components/Menu';
import { getKeymap, prettyKeys, shortcutFor } from '../input/keymap';
import { getAppCommand, runCommand } from '../input/commands';
import { useWorkspace } from '../workspace/WindowManager';
import { PANELS, VIEW_MENU_ORDER } from '../workspace/panels';
import { getProject, useProject } from '../doc/store';
import { getUi } from '../state/ui';
import { isDirty, useProjectStatus, useSettings } from '../state/status';
import { openProject } from './actions';
import { report } from './notify';
import { LINKS } from './links';
import { cls } from '../utils/format';
import { FocusChip } from '../library/FocusChip';
import { useLibrary } from '../library/store';
import { chooseFocus, clearFocus, openLibrary } from '../library/actions';
import { analysedCount, fmtCount } from '../library/logic';
import { openGuides, toggleHome, useHome } from '../home/store';
import { ensureTemplates, newFromTemplate, saveAsTemplate, useTemplates } from './templates';
import { TabStrip } from './tabs/TabStrip';
import { useTabs } from './tabs/store';
import { describeTemplate } from '@shared/templates';
import { startTour } from '../tours/store';
import { openTourPicker } from '../tours/TourOverlay';
import { TOURS, TOUR_ORDER } from '../tours/tours';

const cmd = (id: string, label: string, icon?: LucideIcon, extra: Partial<{ checked: boolean; disabled: boolean; hint: string }> = {}): MenuItem => ({
  label,
  icon,
  shortcut: shortcutFor(id),
  onSelect: () => runCommand(id),
  ...extra,
});

function fileMenu(): MenuItem[] {
  const recent = useSettings.getState().settings?.recent ?? [];
  ensureTemplates();
  const templates = useTemplates.getState().list ?? [];
  const closedTabs = useTabs.getState().state?.closed.length ?? 0;
  return [
    cmd('file.new', 'New tab', FilePlus, { hint: 'A fresh project in a new tab; your other projects stay open' }),
    cmd('file.open', 'Open…', FolderOpen, { hint: 'Opens in a new tab (an already-open project just comes to the front)' }),
    {
      type: 'submenu',
      label: 'Open recent',
      disabled: !recent.length,
      items: recent.length
        ? recent.slice(0, 12).map((p) => ({ label: p.split(/[\\/]/).pop() ?? p, detail: p, onSelect: () => void openProject(p) }))
        : [{ type: 'header', label: 'No recent projects' }],
    },
    {
      type: 'submenu',
      label: 'New from template',
      icon: LayoutTemplate,
      items: templates.length
        ? templates.map((t) => ({ label: t.name, detail: describeTemplate(t), onSelect: () => void newFromTemplate(t) }))
        : [{ type: 'header', label: 'No templates yet: File ▸ Save as template…' }],
    },
    cmd('file.openAudioProject', 'Open audio as project…', AudioLines, { hint: 'Any song becomes an editable project: patterns on matched sounds, vocals as audio' }),
    { type: 'separator' },
    cmd('tabs.close', 'Close tab', X),
    cmd('tabs.reopenClosed', 'Reopen closed tab or panel', RotateCcw, { hint: closedTabs ? undefined : 'Brings back the last tab or window you closed' }),
    { type: 'separator' },
    cmd('file.save', 'Save', Save),
    cmd('file.saveAs', 'Save as…'),
    { label: 'Save as template…', icon: LayoutTemplate, hint: 'Start new projects from this one (Home ▸ Projects, File ▸ New from template)', onSelect: () => void saveAsTemplate() },
    cmd('file.projectInfo', 'Project info…', FileText),
    { type: 'separator' },
    cmd('file.importMidi', 'Import MIDI…', Upload),
    cmd('file.exportWav', 'Export audio…', Download),
    {
      type: 'submenu',
      label: 'Quick export',
      items: [
        cmd('file.quickExportWav', 'Song as WAV (24-bit)…'),
        cmd('file.exportWav16', 'Song as WAV (16-bit)…'),
        cmd('file.exportWav32', 'Song as WAV (32-bit float)…'),
        cmd('file.exportStems', 'Stems into a folder (one WAV per insert)…', undefined, { hint: 'One 24-bit WAV per mixer insert, plus Master, into a new folder' }),
        cmd('file.exportPattern', 'Active pattern loop as WAV…'),
        { type: 'separator' },
        cmd('file.exportMidi', 'Active pattern as MIDI…', FileMusic),
      ],
    },
    { type: 'separator' },
    { label: 'Exit', icon: X, onSelect: () => void window.krypt.app.window('quit') },
  ];
}

function editMenu(): MenuItem[] {
  return [cmd('edit.undo', 'Undo', Undo2, { hint: 'Undoes your last edit, or reopens a window you closed after it' }), cmd('edit.redo', 'Redo', Redo2), { type: 'separator' }, cmd('edit.history', 'History…', History)];
}

function viewMenu(): MenuItem[] {
  const open = useWorkspace.getState().open;
  return [
    cmd('view.home', 'Home', House, { checked: useHome.getState().open }),
    { type: 'separator' },
    ...VIEW_MENU_ORDER.map((k) => cmd(`view.toggle.${k}`, PANELS[k].title, PANELS[k].icon, { checked: open.includes(k) })),
    { type: 'separator' },
    cmd('input.toggleTypingPiano', 'Typing keyboard to piano', Keyboard, { checked: getUi().typingPiano }),
    { type: 'separator' },
    cmd('view.resetLayout', 'Reset layout', LayoutTemplate),
  ];
}

function toolsMenu(): MenuItem[] {
  const p = getProject();
  return [
    cmd('tools.settings', 'Settings…', Settings),
    cmd('tools.connections', 'Agent connections…', Plug),
    cmd('tools.agentChat', 'Agent chat', Bot),
    { type: 'separator' },
    cmd('tools.pluginManager', 'Plugin Manager…', Blocks),
    cmd('tools.modelManager', 'Model Manager…', BrainCircuit),
    cmd('tools.autoMashup', 'Auto Mashup…', Blend, { hint: 'Two songs into one mashup project: vocal over beat, stem blend or back & forth' }),
    cmd('tools.autoMix', 'Auto Mix…', WandSparkles, { hint: 'Mix the vocals, the whole song or the master from a preset or a prompt: measured, one undo step' }),
    cmd('tools.masterSong', 'Master a song…', Gauge, { hint: 'Master a finished audio file in a new tab: a preset, a prompt, or a reference song to match' }),
    cmd('tools.masterAlbum', 'Master an album…', DiscAlbum, { hint: '2 to 20 songs as one record: a chain per song, consistent tone and loudness, Export all' }),
    cmd('tools.kryptVoice', 'Krypt Voice…', MicVocal, { hint: 'Text to a voice clip in your song: local voices on your PC, or Fish Audio cloud voices with your key' }),
    { type: 'separator' },
    cmd('tools.library', 'Reference library…', LibraryBig),
    { type: 'submenu', label: 'AI focus', icon: Crosshair, items: focusMenu() },
    cmd('tools.checkOriginality', 'Check originality…', ShieldCheck, { hint: 'Compare your melodies with the deep-analysed references' }),
    { type: 'separator' },
    cmd('transport.toggleMetronome', 'Metronome', Metronome, { checked: !!p?.transport.metronome }),
    cmd('transport.panic', 'Panic: all notes off', OctagonX),
  ];
}

/** Tools ▸ AI focus: pick the collection agents compose from, or clear it. */
function focusMenu(): MenuItem[] {
  const s = useLibrary.getState().state;
  const cols = s?.collections ?? [];
  const items: MenuItem[] = [{ type: 'header', label: cols.length ? 'Compose in the style of' : 'No collections yet' }];
  for (const c of cols) {
    const n = analysedCount(c);
    items.push({
      label: c.name,
      checked: s?.focus?.collectionId === c.id,
      detail: n ? `${fmtCount(n)} analysed` : 'Nothing analysed yet',
      onSelect: () => chooseFocus(c, document),
    });
  }
  items.push(
    { type: 'separator' },
    { label: 'Clear focus', icon: X, disabled: !s?.focus, onSelect: () => void clearFocus() },
    { label: 'Open Library…', icon: LibraryBig, onSelect: () => openLibrary() },
  );
  return items;
}

function helpMenu(): MenuItem[] {
  const ext = (url: string) => () => void window.krypt.app.openExternal(url).then((r) => report(r));
  return [
    cmd('help.guides', 'Guides', BookOpen),
    cmd('help.videos', 'Video tutorials', Clapperboard),
    {
      type: 'submenu',
      label: 'Tours',
      icon: Compass,
      items: [
        { type: 'header', label: 'Step by step, on the real buttons' },
        ...TOUR_ORDER.map((id): MenuItem => ({ label: TOURS[id].title, detail: `~${TOURS[id].minutes} min`, onSelect: () => startTour(id) })),
        { type: 'separator' },
        { label: 'All tours…', icon: Compass, onSelect: () => openTourPicker() },
      ],
    },
    { label: 'Getting started', icon: Rocket, onSelect: () => openGuides('getting-started') },
    { label: 'Troubleshooting', icon: LifeBuoy, onSelect: () => openGuides('troubleshooting') },
    { type: 'separator' },
    {
      type: 'submenu',
      label: 'Keyboard shortcuts',
      icon: Keyboard,
      items: [
        { label: 'All shortcuts (guide)', icon: BookOpen, onSelect: () => openGuides('shortcuts') },
        cmd('tools.shortcuts', 'Customize shortcuts…', Settings),
        { type: 'separator' },
        ...getKeymap()
          .filter((b) => !b.context && !/^tabs\.goto[2-8]$/.test(b.command)) // Ctrl+1 … Ctrl+8: one row is enough
          .map((b) => ({ label: getAppCommand(b.command)?.label ?? b.command, shortcut: prettyKeys(b.keys), onSelect: () => runCommand(b.command) })),
        { type: 'separator' },
        { type: 'header', label: 'Piano roll / Playlist tool keys: see Customize shortcuts' },
        { type: 'header', label: 'Typing keyboard: Z…M and Q…P rows play notes' },
        { type: 'header', label: 'Knobs: drag, Ctrl = fine, double-click resets' },
      ] as MenuItem[],
    },
    { type: 'separator' },
    { label: 'krypt.cc', icon: Globe, onSelect: ext(LINKS.site) },
    { label: 'Discord', icon: MessageCircle, onSelect: ext(LINKS.discord) },
    { type: 'separator' },
    cmd('help.about', 'About Krypt Studio', Info),
  ];
}

/** `guide`: the Guides' "Show me" anchor (src/guides/anchors.ts), set as data-guide on the menu button. */
const MENUS: Array<{ id: string; label: string; guide?: string; items: () => MenuItem[] }> = [
  { id: 'file', label: 'File', guide: 'titlebar.file', items: fileMenu },
  { id: 'edit', label: 'Edit', items: editMenu },
  { id: 'view', label: 'View', guide: 'titlebar.view', items: viewMenu },
  { id: 'tools', label: 'Tools', guide: 'titlebar.tools', items: toolsMenu },
  { id: 'help', label: 'Help', guide: 'titlebar.help', items: helpMenu },
];

function MenuBar() {
  const [openId, setOpenId] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const show = (id: string): void => {
    const el = refs.current[id];
    const m = MENUS.find((x) => x.id === id);
    if (!el || !m) return;
    setOpenId(id);
    openMenuAt(el, m.items(), { minWidth: 220, onClose: () => setOpenId((cur) => (cur === id ? null : cur)) });
  };
  return (
    <div className="app-no-drag flex items-center">
      {MENUS.map((m) => (
        <button
          key={m.id}
          ref={(el) => (refs.current[m.id] = el)}
          type="button"
          data-guide={m.guide}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (openId === m.id) closeMenu();
            else show(m.id);
          }}
          onMouseEnter={() => {
            if (openId && openId !== m.id) show(m.id);
          }}
          className={cls(
            'h-7 rounded-md px-2.5 text-[12px] font-medium transition',
            openId === m.id ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** Title-bar Home button: the hub ⇄ the Studio. */
function HomeButton() {
  const open = useHome((s) => s.open && s.phase === 'ready');
  const keys = shortcutFor('view.home');
  const label = open ? 'Back to the Studio' : 'Home';
  return (
    <button
      type="button"
      onClick={toggleHome}
      aria-label={label}
      aria-pressed={open}
      data-guide="titlebar.home"
      title={`${label}${keys ? ` (${keys})` : ''}`}
      data-hint={open ? `Back to the Studio${keys ? ` (${keys} or Esc)` : ' (Esc)'}` : `Home: projects, AI agents, audio tools, guides${keys ? ` (${keys})` : ''}`}
      className={cls(
        'app-no-drag mr-1 flex h-6 w-7 items-center justify-center rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70',
        open ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]' : 'text-white/70 hover:bg-white/5 hover:text-white',
      )}
    >
      <House className={cls('h-3.5 w-3.5', open && 'text-krypt-purple')} />
    </button>
  );
}

function WindowButtons() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    window.krypt.app
      .isMaximized()
      .then(setMax)
      .catch(() => undefined);
    return window.krypt.app.onMaximizedChanged(setMax);
  }, []);
  const btn = 'flex h-8 w-11 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white';
  return (
    <div className="app-no-drag flex h-full items-stretch">
      <button className={btn} onClick={() => void window.krypt.app.window('minimize')} aria-label="Minimize">
        <Minus className="h-4 w-4" />
      </button>
      <button className={btn} onClick={() => void window.krypt.app.window('maximize')} aria-label={max ? 'Restore' : 'Maximize'}>
        {max ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>
      <button className={cls(btn, 'hover:bg-rose-600 hover:text-white')} onClick={() => void window.krypt.app.window('close')} aria-label="Close">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function TitleBar() {
  const status = useProjectStatus((s) => s.status);
  const dirty = useProjectStatus((s) => isDirty(s));
  const metaName = useProject((p) => p.meta.name);
  const name = status?.name || metaName || 'Untitled';

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${name} — Krypt Studio`;
  }, [name, dirty]);

  return (
    <div className="app-drag relative z-10 flex h-8 flex-shrink-0 select-none items-center border-b border-white/[0.06] bg-krypt-void/80 backdrop-blur-md">
      <div className="flex items-center gap-2 pl-2.5 pr-2">
        <img
          src="./krypt.png"
          alt=""
          className="h-5 w-5 drop-shadow-[0_0_6px_rgba(168,85,247,0.55)]"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
        <span className="text-[12px] font-bold tracking-tight">
          <span className="text-krypt-gradient">Krypt</span> <span className="text-white">Studio</span>
        </span>
      </div>
      <HomeButton />
      <MenuBar />
      <TabStrip />
      <div className="flex h-full flex-shrink-0 items-center gap-2">
        <FocusChip />
        <WindowButtons />
      </div>
    </div>
  );
}
