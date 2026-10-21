// The dockview workspace: panel components, Krypt tabs + header actions,
// the empty-state watermark and the theme. Only this folder imports dockview.

import { Component, Suspense, lazy, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import {
  DockviewReact,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from 'dockview-react';
import { AppWindow, Loader2, Maximize2, Minimize2, PictureInPicture2, SquareDashed, X } from 'lucide-react';
import { wm } from './WindowManager';
import { PANELS, VIEW_MENU_ORDER, kindOfPanelId, type PluginTarget, type SingletonKind } from './panels';
import { useDocStore } from '../doc/store';
import { ChannelRack } from '../panels/channelRack/ChannelRack';
import { Mixer } from '../panels/mixer/Mixer';
import { PluginPanel } from '../panels/plugin/PluginPanel';
import { BrowserPanel } from '../panels/browser/Browser';
import { AgentPanel } from '../panels/agent/AgentPanel';
import { HistoryPanel } from '../panels/history/HistoryPanel';
import { SettingsPanel } from '../panels/settings/SettingsPanel';
import { AboutPanel } from '../panels/about/AboutPanel';
import { PluginManager } from '../panels/pluginManager/PluginManager';
import { ModelManager } from '../panels/modelManager/ModelManager';
import { LibraryPanel } from '../panels/library/LibraryPanel';
import { GuidesPanel } from '../guides/GuidesPanel';
import { SessionView } from '../panels/session/SessionView';
import { cls } from '../utils/format';

// ── Panels owned by another agent: load if present, else a placeholder ─

const pianoRollModules = import.meta.glob('../panels/pianoRoll/PianoRoll.tsx');
const playlistModules = import.meta.glob('../panels/playlist/Playlist.tsx');

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-8 text-center">
        <div className="text-sm font-semibold text-white">{title}</div>
        <div className="mt-2 text-xs text-krypt-muted">{note}</div>
      </div>
    </div>
  );
}

function external(mods: Record<string, () => Promise<unknown>>, exportName: string, title: string): ComponentType {
  const loader = Object.values(mods)[0];
  if (!loader) return () => <Placeholder title={title} note={`The ${title} isn't built yet.`} />;
  return lazy(async () => {
    try {
      const m = (await loader()) as Record<string, ComponentType>;
      const C = m[exportName] ?? m.default;
      if (C) return { default: C };
    } catch (err) {
      console.error(`[workspace] failed to load ${title}`, err);
    }
    return { default: () => <Placeholder title={title} note={`The ${title} failed to load. Check the console.`} /> };
  });
}

const PianoRoll = external(pianoRollModules, 'PianoRoll', 'Piano Roll');
const Playlist = external(playlistModules, 'Playlist', 'Playlist');

// ── Error boundary per panel: one broken window never kills the app ───

class PanelBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.title}] crashed`, error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-rose-400/30 bg-rose-500/5 p-5 text-center">
          <div className="text-sm font-semibold text-rose-200">{this.props.title} hit an error</div>
          <div className="mt-2 break-words font-mono text-[11px] text-krypt-muted">{this.state.error.message}</div>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-4 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10"
          >
            Reload panel
          </button>
        </div>
      </div>
    );
  }
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-krypt-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}

function frame(title: string, render: (p: IDockviewPanelProps) => ReactNode) {
  return function DockPanel(props: IDockviewPanelProps) {
    return (
      <PanelBoundary title={title}>
        <Suspense fallback={<Loading />}>
          {/* data-tour-panel: the tours (src/tours) point at a whole window by it */}
          <div className="h-full w-full overflow-hidden bg-[#0c0c12] text-white" data-tour-panel={props.api.id}>
            {render(props)}
          </div>
        </Suspense>
      </PanelBoundary>
    );
  };
}

const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  browser: frame('Browser', () => <BrowserPanel />),
  channelRack: frame('Channel Rack', () => <ChannelRack />),
  pianoRoll: frame('Piano Roll', () => <PianoRoll />),
  playlist: frame('Playlist', () => <Playlist />),
  mixer: frame('Mixer', () => <Mixer />),
  plugin: frame('Plugin editor', (p) => <PluginPanel target={(p.params as { target: PluginTarget }).target} panelId={p.api.id} />),
  agent: frame('Agents', () => <AgentPanel />),
  history: frame('History', () => <HistoryPanel />),
  guides: frame('Guides', () => <GuidesPanel />),
  settings: frame('Settings', () => <SettingsPanel />),
  about: frame('About', () => <AboutPanel />),
  pluginManager: frame('Plugin Manager', () => <PluginManager />),
  modelManager: frame('Model Manager', () => <ModelManager />),
  library: frame('Library', () => <LibraryPanel />),
  session: frame('Session', () => <SessionView />),
};

// ── Tabs + header actions ─────────────────────────────────────────────

function KryptTab(props: IDockviewPanelHeaderProps) {
  const [title, setTitle] = useState(props.api.title ?? '');
  useEffect(() => {
    const d = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);
  const kind = kindOfPanelId(props.api.id);
  const def = kind ? PANELS[kind] : null;
  const Icon = def?.icon;
  return (
    <div
      className="krypt-tab"
      data-tour-tab={props.api.id}
      data-hint={def ? `${def.title}${def.shortcut ? ` (${def.shortcut})` : ''} · ${def.description}. Drag to dock, right-click for options.` : title}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          wm.close(props.api.id);
        }
      }}
    >
      {Icon && <Icon className="krypt-tab-icon" />}
      <span className="max-w-[180px] truncate">{title}</span>
      <span
        role="button"
        aria-label="Close"
        className="krypt-tab-close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          wm.close(props.api.id);
        }}
      >
        <X className="h-3 w-3" />
      </span>
    </div>
  );
}

function HeaderButton({ hint, onClick, children }: { hint: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-hint={hint}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-krypt-muted transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function HeaderActions(props: IDockviewHeaderActionsProps) {
  const [loc, setLoc] = useState(props.group.api.location.type);
  const [maxed, setMaxed] = useState(() => props.group.api.isMaximized());
  useEffect(() => {
    const a = props.group.api.onDidLocationChange((e) => setLoc(e.location.type));
    const b = props.containerApi.onDidMaximizedGroupChange(() => setMaxed(props.group.api.isMaximized()));
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [props.group, props.containerApi]);
  const id = props.activePanel?.id;
  if (!id) return null;
  return (
    <div className="flex h-full items-center gap-0.5 px-1.5">
      {loc === 'grid' && (
        <HeaderButton hint="Float this window over the workspace" onClick={() => wm.float(id)}>
          <SquareDashed className="h-3 w-3" />
        </HeaderButton>
      )}
      {loc === 'floating' && (
        <HeaderButton hint="Dock this window into the workspace" onClick={() => wm.dock(id)}>
          <AppWindow className="h-3 w-3" />
        </HeaderButton>
      )}
      {loc !== 'popout' && (
        <HeaderButton hint="Detach into its own OS window (multi-monitor)" onClick={() => void wm.detach(id)}>
          <PictureInPicture2 className="h-3 w-3" />
        </HeaderButton>
      )}
      {loc === 'grid' && (
        <HeaderButton hint={maxed ? 'Restore' : 'Maximize'} onClick={() => wm.toggleMaximize(id)}>
          {maxed ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </HeaderButton>
      )}
      <HeaderButton hint="Close (Esc-friendly: F-keys reopen it)" onClick={() => wm.close(id)}>
        <X className="h-3.5 w-3.5" />
      </HeaderButton>
    </div>
  );
}

function Watermark(_props: IWatermarkPanelProps) {
  const shown: SingletonKind[] = VIEW_MENU_ORDER.slice(0, 5);
  return (
    <div className="flex h-full w-full items-center justify-center bg-krypt-void">
      <div className="text-center">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-krypt-muted">Workspace is empty</div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {shown.map((k) => {
            const d = PANELS[k];
            const Icon = d.icon;
            return (
              <button
                key={k}
                onClick={() => wm.open(k)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 transition hover:border-white/20 hover:bg-white/10"
              >
                <Icon className="h-3.5 w-3.5 text-krypt-purple" />
                {d.title}
                {d.shortcut && <kbd className="rounded border border-white/10 bg-black/40 px-1 font-mono text-[9px] text-krypt-muted">{d.shortcut}</kbd>}
              </button>
            );
          })}
        </div>
        <button onClick={() => wm.resetLayout()} className="mt-4 text-[11px] text-krypt-muted underline-offset-2 hover:text-white hover:underline">
          Restore the default layout
        </button>
      </div>
    </div>
  );
}

const kryptTheme: DockviewTheme = {
  name: 'krypt',
  className: 'dockview-theme-krypt',
  colorScheme: 'dark',
  gap: 0,
  dndTabIndicator: 'line',
};

export function Workspace({ className }: { className?: string }) {
  // Keep plugin windows in sync with the document (deleted channel → close, rename → retitle).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = useDocStore.subscribe((s, prev) => {
      const a = s.project;
      const b = prev.project;
      if (!a || !b) return;
      if (a.channels === b.channels && a.mixer === b.mixer) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => wm.pruneStale(), 50);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
      // Don't detach the dockview API here: StrictMode re-runs effects without
      // re-firing onReady, and the API outlives this effect anyway.
      wm.save();
    };
  }, []);

  return (
    <DockviewReact
      className={cls('h-full w-full', className)}
      components={components}
      defaultTabComponent={KryptTab}
      rightHeaderActionsComponent={HeaderActions}
      watermarkComponent={Watermark}
      theme={kryptTheme}
      floatingGroupDragHandle="tabbar"
      floatingGroupBounds="boundedWithinViewport"
      popoutUrl="/popout.html"
      onReady={(e) => wm.attach(e.api)}
    />
  );
}
