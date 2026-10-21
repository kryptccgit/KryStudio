// Home ▸ Projects: new / open / from an audio file / the demo / import MIDI, and every recent
// project with Open and Show in folder. Opening anything goes straight to
// the Studio (onProjectPicked).

import { useMemo, useState } from 'react';
import { AudioLines, FileMusic, FilePlus2, FolderOpen, FolderSearch, Play, type LucideIcon } from 'lucide-react';
import { useProjectStatus, useSettings } from '../../state/status';
import { openProject } from '../../app/actions';
import { report, toast } from '../../app/notify';
import { shortcutFor } from '../../input/keymap';
import { cls } from '../../utils/format';
import { runHomeAction } from '../actions';
import { fmtAgo, shapeRecent, type HomeActionId } from '../logic';
import { goBack, openedAtMap } from '../store';
import { Eyebrow, FOCUS_RING, GlassPanel, HomeButton, IconTile, Kbd, ScreenFrame, ScreenHeader } from '../ui';
import { MAX_RECENT_SHOWN } from './shared';
import { TemplatesPanel } from './TemplatesPanel';

function ActionTile({ id, icon, title, body, keys }: { id: HomeActionId; icon: LucideIcon; title: string; body: string; keys?: string }) {
  return (
    <button
      type="button"
      onClick={() => runHomeAction(id)}
      className={cls(
        'group flex items-start gap-3 rounded-2xl border border-white/10 bg-[#0e0e17]/90 p-4 text-left shadow-krypt-card transition hover:border-white/20 hover:bg-[#131320]/95',
        FOCUS_RING,
      )}
    >
      <IconTile icon={icon} size="sm" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold text-white">
          {title}
          {keys && <Kbd>{keys}</Kbd>}
        </span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-krypt-muted">{body}</span>
      </span>
    </button>
  );
}

export function ProjectsScreen() {
  const recent = useSettings((s) => s.settings?.recent ?? null);
  const current = useProjectStatus((s) => s.status?.path ?? null);
  const openedAt = useMemo(() => openedAtMap(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const list = shapeRecent(recent, { limit: MAX_RECENT_SHOWN, openedAt });
  const now = Date.now();

  const open = async (path: string): Promise<void> => {
    setBusy(path);
    try {
      await openProject(path);
    } finally {
      setBusy(null);
    }
  };
  const reveal = async (path: string): Promise<void> => {
    try {
      report(await window.krypt.app.showItemInFolder(path));
    } catch (err) {
      toast.error(`Couldn't show the folder: ${(err as Error)?.message ?? err}`);
    }
  };

  return (
    <ScreenFrame label="Projects">
      <ScreenHeader icon={FolderOpen} title="Projects" subtitle="Start something new, open a project, or pick up where you left off." onBack={goBack} />

      <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ActionTile id="newProject" icon={FilePlus2} title="New project" body="The default kit: drums, an 808 and a synth, ready to go." keys={shortcutFor('file.new')} />
        <ActionTile id="openProject" icon={FolderOpen} title="Open…" body="Pick a .kstudio file anywhere on your PC." keys={shortcutFor('file.open')} />
        <ActionTile
          id="audioProject"
          icon={AudioLines}
          title="From an audio file"
          body="Turn a song into an editable project: drums, bass, chords and lead as patterns, vocals as audio."
          keys={shortcutFor('file.openAudioProject')}
        />
        <ActionTile id="openDemo" icon={Play} title="Open the demo" body="Neon Fog: a full beat made with the factory kit and stock plugins." />
        <ActionTile id="importMidi" icon={FileMusic} title="Import MIDI…" body="Bring a .mid file into the open project as a pattern." />
      </div>

      <TemplatesPanel />

      <GlassPanel className="mt-6 p-5" label="Recent projects">
        <Eyebrow>Recent projects</Eyebrow>
        {list.length === 0 ? (
          <p className="mt-3 text-[13px] text-krypt-muted">
            Nothing yet. Save a project with <Kbd>{shortcutFor('file.save') ?? 'Ctrl+S'}</Kbd> and it shows up here.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-white/[0.06]">
            {list.map((r) => {
              const isOpen = !!current && current.toLowerCase() === r.path.toLowerCase();
              return (
                <li key={r.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-semibold text-white">{r.name}</span>
                      {isOpen && <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 text-[10px] font-semibold text-emerald-300">Open now</span>}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-krypt-muted" title={r.path}>
                      {r.folder}
                    </div>
                  </div>
                  <span className="w-28 flex-shrink-0 text-right text-[11px] text-krypt-muted">{r.lastOpened ? `Opened ${fmtAgo(r.lastOpened, now)}` : ''}</span>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <HomeButton kind="quiet" icon={FolderSearch} onClick={() => void reveal(r.path)} ariaLabel={`Show ${r.name} in its folder`} title="Show in folder">
                      <span className="sr-only">Show in folder</span>
                    </HomeButton>
                    <HomeButton kind="ghost" onClick={() => (isOpen ? runHomeAction('studio') : void open(r.path))} busy={busy === r.path} ariaLabel={isOpen ? `Back to ${r.name}` : `Open ${r.name}`}>
                      {isOpen ? 'Back to it' : 'Open'}
                    </HomeButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </GlassPanel>

      <p className="mt-4 text-center text-[12px] text-krypt-muted">
        Projects are <span className="font-mono text-white/75">.kstudio</span> files. Double-click one in Explorer, or drop it on this window, to open it here. Drop a song on Home to turn it into one.
      </p>
    </ScreenFrame>
  );
}
