// ──────────────────────────────────────────────────────────────────────
// The Home hub: a full-window layer over the Studio (below the title bar).
// "Pick what you are here to do": the Discord and free-tools links, nine
// cards with live status pills, a
// "Continue where you left off" panel, a rotating tip, the Guides and Lite
// mode pills. The Studio underneath stays mounted (and inert while covered).
// An audio file dropped on Home asks what it should become (src/audioProject);
// projects and MIDI files fall through to the window's own drop handling.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  AudioWaveform,
  BookOpen,
  Blocks,
  Bot,
  Disc3,
  Feather,
  FilePlus2,
  FolderOpen,
  Globe,
  LibraryBig,
  Lightbulb,
  MessageCircle,
  Mic,
  Play,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { useProject } from '../doc/store';
import { isDirty, updateSettings, useAgents, useEngineStatus, useProjectStatus, useSettings } from '../state/status';
import { useLibrary } from '../library/store';
import { useAnalyzer } from '../panels/modelManager/store';
import { usePluginManager } from '../panels/pluginManager/store';
import { report } from '../app/notify';
import { openProject } from '../app/actions';
import { AUDIO_EXT, droppedPaths, hasFiles } from '../app/fileDrop';
import { offerDroppedAudio } from '../audioProject/actions';
import { LINKS } from '../app/links';
import { cls } from '../utils/format';
import { GuidesView } from '../guides/GuidesView';
import { DEFAULT_ARTICLE } from '../guides/articles';
import { HomeBackground } from './Background';
import { runHomeAction } from './actions';
import {
  agentsPill,
  audioToolsPill,
  fmtAgo,
  guidesPill,
  isFirstRun,
  libraryPill,
  pluginsPill,
  projectsPill,
  recordingPill,
  settingsPill,
  shapeRecent,
  splitProjectPath,
  studioPill,
  tipAt,
  type HomeActionId,
  type Pill,
} from './logic';
import { goBack, homeFlags, openedAtMap, openGuides, useHome } from './store';
import { FOCUS_RING, GlassPanel, HomeButton, IconTile, PillBadge } from './ui';
import { ProjectsScreen } from './screens/ProjectsScreen';
import { AgentsScreen } from './screens/AgentsScreen';
import { AudioToolsScreen } from './screens/AudioToolsScreen';
import { RecordingScreen } from './screens/RecordingScreen';
import { useLiveInput } from '../live/liveInput';
import { SoundsScreen } from './screens/SoundsScreen';
import { maybeShowWelcome } from './WelcomeDialog';

// ── Studio wrapper: inert while Home covers it ────────────────────────

export function StudioArea({ children }: { children: ReactNode }) {
  const covered = useHome((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (covered) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [covered]);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col" aria-hidden={covered || undefined}>
      {children}
    </div>
  );
}

// ── Live pills ────────────────────────────────────────────────────────

function useStudioPill(): Pill | null {
  const status = useProjectStatus((s) => s.status);
  const dirty = useProjectStatus((s) => isDirty(s));
  const metaName = useProject((p) => p.meta.name);
  return studioPill({ name: status?.name || metaName || 'Untitled', dirty, recovered: status?.recovered });
}

interface CardDef {
  id: HomeActionId;
  icon: LucideIcon;
  title: string;
  body: string;
  pill: Pill | null;
}

function useCards(): CardDef[] {
  const studio = useStudioPill();
  const recent = useSettings((s) => s.settings?.recent ?? null);
  const mcp = useAgents((s) => s.mcp);
  const lib = useLibrary((s) => s.state);
  const analyzer = useAnalyzer((s) => s.state);
  const plugins = usePluginManager((s) => s.state);
  const engine = useEngineStatus((s) => s.status);
  const record = useLiveInput((s) => s.record);
  const vocalsReady = useProject((p) => !!(p.recording?.insertId && p.mixer.inserts[p.recording.insertId]));
  const firstRun = isFirstRun(homeFlags()); // two localStorage reads; the grid remounts after Guides
  return [
    { id: 'studio', icon: Disc3, title: 'Studio', body: 'Make the music: Channel Rack, Piano Roll, Playlist and Mixer.', pill: studio },
    { id: 'projects', icon: FolderOpen, title: 'Projects', body: 'Start something new, open a project, pick up a recent one, try the demo or import MIDI.', pill: projectsPill(recent) },
    { id: 'agents', icon: Bot, title: 'AI Agents', body: 'Connect Claude Code and friends, then just say what you want. Every AI edit can be undone.', pill: agentsPill(mcp) },
    { id: 'library', icon: LibraryBig, title: 'Reference Library', body: 'Teach Krypt your sound from songs you own, so the AI can compose in that style.', pill: libraryPill(lib) },
    { id: 'audioTools', icon: AudioWaveform, title: 'Audio Tools', body: 'Turn a whole song into an editable project, find tempo and key, split stems, tune vocals, match a vocal to a beat, turn audio into notes. All on your PC.', pill: audioToolsPill(analyzer) },
    { id: 'sounds', icon: Blocks, title: 'Sounds & Plugins', body: 'Presets, the factory sounds, downloadable sound packs (real piano, drums, orchestra), sample folders on this PC, stock instruments and your VST3 / CLAP plugins.', pill: pluginsPill(plugins) },
    { id: 'guides', icon: BookOpen, title: 'Guides', body: 'How each part of the app works, in plain words. Start here if it is your first time.', pill: guidesPill(firstRun) },
    { id: 'recording', icon: Mic, title: 'Recording Studio', body: 'Set up your mic, hear yourself and record vocal takes through a ready-made vocal chain.', pill: recordingPill(record.armed, record.input, vocalsReady) },
    { id: 'settings', icon: SettingsIcon, title: 'Settings', body: 'Audio device, MIDI and recording, agents, shortcuts and the interface.', pill: settingsPill(engine) },
  ];
}

function HubCard({ card }: { card: CardDef }) {
  const { icon, title, body, pill } = card;
  return (
    <button
      type="button"
      onClick={() => runHomeAction(card.id)}
      data-guide={card.id === 'audioTools' ? 'home.audioTools' : undefined}
      aria-label={`${title}. ${body}${pill ? ` Status: ${pill.text}${pill.dot ? ', unsaved changes' : ''}.` : ''}`}
      className={cls(
        'group relative flex min-h-[150px] flex-col items-start overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-[#14141f]/95 to-[#0b0b12]/95 p-5 text-left shadow-krypt-card',
        'transition duration-200 ease-out hover:-translate-y-0.5 hover:border-white/20 hover:shadow-[0_12px_36px_rgba(0,0,0,0.55),0_0_24px_rgba(168,85,247,0.16)]',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        FOCUS_RING,
      )}
    >
      <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-krypt-gradient opacity-0 transition-opacity duration-200 group-hover:opacity-70 group-focus-visible:opacity-70" />
      <span className="flex w-full items-start justify-between gap-3">
        <IconTile icon={icon} />
        <span className="flex min-w-0 justify-end pt-1">
          <PillBadge pill={pill} />
        </span>
      </span>
      <span className="mt-4 text-[16px] font-bold tracking-tight text-white">{title}</span>
      <span className="mt-1 text-[12.5px] leading-relaxed text-krypt-muted group-hover:text-white/75">{body}</span>
    </button>
  );
}

// ── Continue where you left off ───────────────────────────────────────

function ContinuePanel() {
  const status = useProjectStatus((s) => s.status);
  const dirty = useProjectStatus((s) => isDirty(s));
  const metaName = useProject((p) => p.meta.name);
  const recent = useSettings((s) => s.settings?.recent ?? null);
  const opens = useHome((s) => s.opens);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openedAt = useMemo(() => openedAtMap(), [opens, status?.path]);
  const now = Date.now();

  const path = status?.path ?? null;
  const name = status?.name || metaName || 'Untitled';
  // An untouched blank project isn't "where you left off": the last recent project is.
  const blank = !path && !dirty && !status?.recovered;
  const list = shapeRecent(recent, { currentPath: path, limit: blank ? 6 : 5, openedAt });
  const resume = blank ? list[0] ?? null : null;
  const others = blank ? list.slice(1) : list;

  let main: ReactNode;
  if (resume) {
    main = (
      <CurrentRow
        icon={Disc3}
        title={resume.name}
        detail={[resume.folder, resume.lastOpened ? `opened ${fmtAgo(resume.lastOpened, now)}` : null].filter(Boolean).join(' · ')}
        action={
          <>
            <HomeButton kind="quiet" onClick={() => runHomeAction('studio')} title="Go to the Studio with the empty project that is open now">
              Start blank
            </HomeButton>
            <HomeButton kind="primary" icon={FolderOpen} onClick={() => void openRecent(resume.path)}>
              Open
            </HomeButton>
          </>
        }
      />
    );
  } else if (blank) {
    main = (
      <CurrentRow
        icon={Disc3}
        title="Nothing here yet"
        detail="Start a new project, or open the demo to hear what the stock sounds can do."
        action={
          <>
            <HomeButton kind="ghost" icon={Play} onClick={() => runHomeAction('openDemo')}>
              Open the demo
            </HomeButton>
            <HomeButton kind="primary" icon={FilePlus2} onClick={() => runHomeAction('studio')}>
              Start in the Studio
            </HomeButton>
          </>
        }
      />
    );
  } else {
    const where = path ? splitProjectPath(path).folder : null;
    const state = status?.recovered
      ? 'Recovered from your last session · not saved yet'
      : dirty
        ? 'Unsaved changes'
        : status?.lastSavedAt
          ? `Saved ${fmtAgo(status.lastSavedAt, now)}`
          : path
            ? 'Saved'
            : 'Not saved yet';
    main = (
      <CurrentRow
        icon={Disc3}
        title={name}
        dot={dirty}
        detail={[where, state].filter(Boolean).join(' · ')}
        warn={!!status?.recovered}
        action={
          <HomeButton kind="primary" onClick={() => runHomeAction('studio')}>
            Back to the Studio
          </HomeButton>
        }
      />
    );
  }

  return (
    <GlassPanel className="mt-6 p-5" label="Continue where you left off">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Continue where you left off</h2>
        <button type="button" onClick={() => runHomeAction('projects')} className={cls('rounded-md px-1.5 text-[11.5px] font-semibold text-krypt-muted transition hover:text-white', FOCUS_RING)}>
          All projects
        </button>
      </div>
      {main}
      {others.length > 0 && (
        <ul className="mt-3 divide-y divide-white/[0.06] border-t border-white/[0.06]" aria-label="Recent projects">
          {others.map((r) => (
            <li key={r.path} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-white/90">{r.name}</div>
                <div className="truncate font-mono text-[10.5px] text-krypt-muted" title={r.path}>
                  {r.folder}
                </div>
              </div>
              {r.lastOpened && <span className="hidden flex-shrink-0 text-[11px] text-krypt-muted sm:inline">{fmtAgo(r.lastOpened, now)}</span>}
              <HomeButton kind="ghost" onClick={() => void openRecent(r.path)} ariaLabel={`Open ${r.name}`}>
                Open
              </HomeButton>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}

async function openRecent(path: string): Promise<void> {
  await openProject(path); // success → the Studio (onProjectPicked); failures toast
}

function CurrentRow({ icon, title, detail, action, dot, warn }: { icon: LucideIcon; title: string; detail: string; action: ReactNode; dot?: boolean; warn?: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <IconTile icon={icon} accent />
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-bold text-white">{title}</span>
          {dot && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-krypt-pink shadow-[0_0_6px_rgba(236,72,153,0.8)]" title="Unsaved changes" />}
        </div>
        <div className={cls('truncate text-[12px]', warn ? 'text-amber-300' : 'text-krypt-muted')} title={detail}>
          {detail}
        </div>
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{action}</div>
    </div>
  );
}

// ── The card grid ─────────────────────────────────────────────────────

function HubScreen() {
  const cards = useCards();
  const opens = useHome((s) => s.opens);
  const tip = tipAt(Math.max(0, opens - 1));
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    maybeShowWelcome(); // first install only: the overview video, the Discord and the free-tools links
  }, []);
  const ext = (url: string) => () => void window.krypt.app.openExternal(url).then((r) => report(r));
  return (
    <div ref={rootRef} tabIndex={-1} className="h-full overflow-y-auto outline-none">
      <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-10 sm:px-8 sm:pt-12">
        <header className="text-center">
          <h1 className="text-[34px] font-bold leading-tight tracking-tight sm:text-4xl">
            <span className="text-krypt-gradient">Krypt</span> <span className="text-white">Studio</span>
          </h1>
          <p className="mt-1.5 text-[14px] text-krypt-muted">Pick what you are here to do.</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={ext(LINKS.discord)}
              title="The Krypt Discord: help, feedback and what's new"
              className={cls('inline-flex h-11 items-center gap-2 rounded-xl bg-[#5865F2] px-5 text-[14px] font-semibold text-white shadow-[0_8px_28px_rgba(88,101,242,0.35)] transition hover:brightness-110 active:scale-[0.98]', FOCUS_RING)}
            >
              <MessageCircle className="h-4 w-4" /> Join the Discord
            </button>
            <button
              type="button"
              onClick={ext(LINKS.tools)}
              title="More free Krypt tools at krypt.cc/tools"
              className={cls('inline-flex h-11 items-center gap-2 rounded-xl bg-krypt-gradient px-5 text-[14px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 active:scale-[0.98]', FOCUS_RING)}
            >
              <Globe className="h-4 w-4" /> More free tools
            </button>
          </div>
        </header>

        <nav aria-label="Home" className="mt-9 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <HubCard key={c.id} card={c} />
          ))}
        </nav>

        <ContinuePanel />

        {tip && (
          <p className="mx-auto mt-5 flex max-w-[760px] items-start justify-center gap-2 text-center text-[12.5px] text-krypt-muted">
            <Lightbulb className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" aria-hidden="true" />
            <span>
              <span className="font-semibold text-white/80">Tip:</span> {tip}
            </span>
          </p>
        )}

        <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-krypt-muted/80">
          <span>Free & open source · no ads, no telemetry</span>
          <button type="button" onClick={ext(LINKS.site)} className={cls('inline-flex items-center gap-1 rounded hover:text-white', FOCUS_RING)}>
            <Globe className="h-3 w-3" /> krypt.cc
          </button>
          <button type="button" onClick={ext(LINKS.discord)} className={cls('inline-flex items-center gap-1 rounded hover:text-white', FOCUS_RING)}>
            <MessageCircle className="h-3 w-3" /> Discord
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Corner pills ──────────────────────────────────────────────────────

function CornerPills({ showGuides }: { showGuides: boolean }) {
  const lite = useSettings((s) => s.settings?.ui.homeLite ?? false);
  const settings = useSettings((s) => s.settings);
  const toggleLite = (): void => {
    if (!settings) return;
    void updateSettings({ ui: { ...settings.ui, homeLite: !lite } }, !lite ? 'Lite mode on: a still background' : 'Lite mode off');
  };
  const pill = cls(
    'pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-[#0e0e17]/90 px-3 text-[11.5px] font-semibold text-white/80 shadow-krypt-card transition hover:border-white/20 hover:text-white',
    FOCUS_RING,
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-3">
      {showGuides ? (
        <button type="button" className={pill} onClick={() => openGuides(DEFAULT_ARTICLE)} title="Guides: how everything works, step by step (F1)">
          <BookOpen className="h-3.5 w-3.5" /> Guides
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        className={cls(pill, lite && 'border-krypt-purple/40 text-purple-200')}
        onClick={toggleLite}
        disabled={!settings}
        aria-pressed={lite}
        title={lite ? 'Lite mode is on: a still background. Click to bring the motion back.' : 'Laggy? Lite mode keeps the Home background still.'}
      >
        <Feather className="h-3.5 w-3.5" />
        {lite ? 'Lite mode on' : 'Laggy? Lite mode'}
      </button>
    </div>
  );
}

// ── The layer ─────────────────────────────────────────────────────────

export function HomeLayer() {
  const phase = useHome((s) => s.phase);
  const open = useHome((s) => s.open);
  const screen = useHome((s) => s.screen);
  const lite = useSettings((s) => s.settings?.ui.homeLite ?? false);
  const restoreRef = useRef<Element | null>(null);

  // Remember what had focus in the Studio; give it back when Home closes.
  useEffect(() => {
    if (open && phase === 'ready') {
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest('[data-krypt-home]')) restoreRef.current = a;
      return;
    }
    if (!open) {
      const el = restoreRef.current as HTMLElement | null;
      restoreRef.current = null;
      if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true });
    }
  }, [open, phase]);

  // Esc: one level back (a screen → the grid → the Studio). Dialogs, menus and modals keep their own Esc.
  useEffect(() => {
    if (!open || phase !== 'ready') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return;
      if (document.querySelector('[data-krypt-menu], [data-krypt-dialog], [data-krypt-modal]')) return;
      e.preventDefault();
      goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase]);

  if (!open) return null;
  if (phase === 'pending') return <div className="absolute inset-0 z-30 bg-krypt-void" aria-hidden="true" />;

  return (
    <section
      data-krypt-home=""
      aria-label="Krypt Studio Home"
      className="absolute inset-0 z-30 overflow-hidden bg-krypt-void font-sans text-white animate-fade-in"
      onDrop={(e) => {
        // Audio only: a song dropped on Home → "Open as project" / "Use as a reference for the AI" / "Add as a sample".
        if (!hasFiles(e) || e.defaultPrevented) return;
        const names = Array.from(e.dataTransfer.files).map((f) => f.name);
        if (!names.some((n) => AUDIO_EXT.test(n)) || names.some((n) => /\.(kstudio|midi?)$/i.test(n))) return; // the Shell opens / imports those
        e.preventDefault();
        const audio = droppedPaths(e.dataTransfer).filter((p) => AUDIO_EXT.test(p));
        if (audio.length) offerDroppedAudio(audio);
      }}
    >
      {/* Guides are for reading: a still background there (and no GPU work). */}
      <HomeBackground lite={lite || screen === 'guides'} />
      <div className="relative h-full">
        {screen === 'home' && <HubScreen />}
        {screen === 'projects' && <ProjectsScreen />}
        {screen === 'agents' && <AgentsScreen />}
        {screen === 'audio' && <AudioToolsScreen />}
        {screen === 'sounds' && <SoundsScreen />}
        {screen === 'recording' && <RecordingScreen />}
        {screen === 'guides' && <GuidesView />}
      </div>
      <CornerPills showGuides={screen !== 'guides'} />
    </section>
  );
}
