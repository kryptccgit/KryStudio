import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, ChevronRight, Download, FileAudio, FileMusic, Folder, FolderOpen, FolderPlus, Loader2, Music, Package, RefreshCw, ScanSearch, Search, Square, SwatchBook, X } from 'lucide-react';
import type { BrowserEntry, BrowserRoot } from '@shared/types';
import { openMenu, type MenuItem } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { report, toast } from '../../app/notify';
import { importMidi, openProject } from '../../app/actions';
import { addSampleChannel, SAMPLE_MIME } from '../channelRack/rackActions';
import { handleOsDrop, hasFiles } from '../../app/fileDrop';
import { fileEarsItems } from '../../ears/menus';
import { sliceMenuItem } from '../../racks/actions';
import { cls } from '../../utils/format';
import { groupFactorySamples, sampleDetail, sampleMatches } from '../../sounds/logic';
import { presetList, useEnsureSounds, useSounds } from '../../sounds/store';
import { PresetRow, PresetTree, usePresetMatches } from '../../sounds/PresetTree';
import { reloadSounds, revealUserPresets } from '../../sounds/actions';
import { refreshPackSamples, showPackInHome, useEnsurePacks, usePacks } from '../../sounds/packs';
import { packSoundsText } from '../../sounds/packsLogic';
import { closeSimilar, openSimilar, useSimilar } from '../../sounds/similar';
import { SimilarList } from './SimilarList';

type DirState = { status: 'loading' } | { status: 'ok'; entries: BrowserEntry[] } | { status: 'error'; message: string };

const ICONS = { dir: Folder, audio: FileAudio, project: Music, midi: FileMusic, other: FileMusic } as const;

const FACTORY_ROOT_ID = 'factory';

function MatchHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center px-1.5 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-krypt-muted/80">
      {label}
      <span className="ml-auto font-mono font-normal tracking-normal text-krypt-muted/60">{count}</span>
    </div>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  onContextMenu,
  hint,
  icon: Icon,
  count,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  hint: string;
  icon?: typeof Folder;
  count?: number;
}) {
  return (
    <div
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className="flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-krypt-muted hover:bg-white/[0.04] hover:text-white"
      data-hint={hint}
    >
      <ChevronRight className={cls('h-3 w-3 transition-transform', open && 'rotate-90')} />
      {Icon && <Icon className="h-3 w-3 text-krypt-purple/80" />}
      {label}
      {count !== undefined && <span className="ml-auto font-mono text-[9px] font-normal tracking-normal text-krypt-muted/60">{count}</span>}
    </div>
  );
}

export function BrowserPanel() {
  const [roots, setRoots] = useState<BrowserRoot[] | null>(null);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sec, setSec] = useState<Record<string, boolean>>({ presets: true, sounds: true, packs: true });
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const presetsRef = useRef<HTMLDivElement>(null);
  const soundsRef = useRef<HTMLDivElement>(null);
  useEnsureSounds();
  useEnsurePacks();
  const packInfo = usePacks((s) => s.samples);
  const factorySamples = useSounds((s) => s.samples);
  const reveal = useSounds((s) => s.reveal);
  const similarReq = useSimilar((s) => s.request);
  const hasIndex = !!factorySamples && factorySamples.length > 0;
  const toggleSec = (k: string): void => setSec((o) => ({ ...o, [k]: !o[k] }));

  const loadRoots = useCallback(async () => {
    try {
      const r = await window.krypt.browser.roots();
      setRoots(r);
      setOpen((o) => (Object.keys(o).length ? o : Object.fromEntries(r.slice(0, 1).map((x) => [x.path, true]))));
    } catch (err) {
      setRoots([]);
      toast.error(`Couldn't list browser folders: ${(err as Error).message}`);
    }
  }, []);

  const loadDir = useCallback(async (dir: string, force = false) => {
    if (!force && dirsRef.current[dir]) return;
    setDirs((d) => ({ ...d, [dir]: { status: 'loading' } }));
    try {
      const r = await window.krypt.browser.list(dir);
      if (r.ok && r.data) {
        const entries = [...r.data].sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }));
        setDirs((d) => ({ ...d, [dir]: { status: 'ok', entries } }));
      } else setDirs((d) => ({ ...d, [dir]: { status: 'error', message: r.message ?? 'Unreadable' } }));
    } catch (err) {
      setDirs((d) => ({ ...d, [dir]: { status: 'error', message: (err as Error).message } }));
    }
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const revealSeen = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.nonce === revealSeen.current || Date.now() - reveal.nonce > 5000) return;
    revealSeen.current = reveal.nonce;
    setQuery('');
    setSec((o) => ({ ...o, [reveal.section]: true }));
    const t = setTimeout(() => (reveal.section === 'presets' ? presetsRef : soundsRef).current?.scrollIntoView({ block: 'nearest' }), 60);
    return () => clearTimeout(t);
  }, [reveal]);

  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  useEffect(
    () =>
      window.krypt.settings.onChanged((s) => {
        const have = (rootsRef.current ?? []).filter((r) => !r.builtin).map((r) => r.id).join('|');
        if (have !== s.browserRoots.map((r) => r.id).join('|')) void loadRoots();
      }),
    [loadRoots],
  );

  useEffect(() => {
    for (const [path, isOpen] of Object.entries(open)) if (isOpen) void loadDir(path);
  }, [open, loadDir]);

  useEffect(
    () => () => {
      if (previewing) void window.krypt.engine.stopPreview().catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const stopPreview = async (): Promise<void> => {
    setPreviewing(null);
    try {
      await window.krypt.engine.stopPreview();
    } catch {
    }
  };

  const clickEntry = async (e: BrowserEntry): Promise<void> => {
    setSelected(e.path);
    if (e.kind === 'dir') {
      setOpen((o) => ({ ...o, [e.path]: !o[e.path] }));
      return;
    }
    if (e.kind !== 'audio') return;
    if (previewing === e.path) {
      await stopPreview();
      flashHint('Preview stopped', 'info', 900);
      return;
    }
    setPreviewing(e.path);
    let r;
    try {
      r = await window.krypt.engine.previewFile(e.path);
    } catch (err) {
      r = { ok: false, message: (err as Error).message };
    }
    if (!r.ok) {
      setPreviewing(null);
      toast.error(`Can't preview ${e.name}: ${r.message ?? 'engine unavailable'}`);
    } else flashHint(`Previewing ${e.name} · click again to stop · drag onto the rack to use it`, 'info');
  };

  const dblEntry = (e: BrowserEntry): void => {
    if (e.kind === 'project') void openProject(e.path);
    else if (e.kind === 'midi') void importMidi(e.path);
    else if (e.kind === 'audio') void addSampleChannel(e.path);
  };

  const entryMenu = (ev: React.MouseEvent, e: BrowserEntry): void => {
    ev.preventDefault();
    const items: MenuItem[] = [];
    const bundled = e.path.startsWith('factory:') || e.path.startsWith('pack:');
    if (e.kind === 'audio') {
      items.push(
        { label: previewing === e.path ? 'Stop preview' : 'Preview', onSelect: () => void clickEntry(e) },
        { label: 'Add to Channel Rack', onSelect: () => void addSampleChannel(e.path) },
        { label: 'More like this', icon: ScanSearch, hint: 'The closest sounds in the library by timbre', onSelect: () => openSimilar({ kind: 'sample', path: e.path }, e.name.replace(/\.[a-z0-9]+$/i, '')) },
        ...(bundled ? [] : fileEarsItems(e.path, (ev.target as Node).ownerDocument)),
        ...(e.path.startsWith('pack:') ? [] : [sliceMenuItem({ path: e.path })]),
      );
    }
    if (e.kind === 'project') items.push({ label: 'Open project', onSelect: () => void openProject(e.path) });
    if (e.kind === 'midi') items.push({ label: 'Import MIDI', onSelect: () => void importMidi(e.path) });
    if (e.kind === 'dir') items.push({ label: 'Refresh', onSelect: () => void loadDir(e.path, true) });
    if (!bundled)
      items.push({
        label: 'Show in folder',
        onSelect: () =>
          void window.krypt.app.showItemInFolder(e.path).then(
            (r) => report(r),
            (err: Error) => toast.error(err.message),
          ),
      });
    openMenu(ev, items);
  };

  const addFolder = async (): Promise<void> => {
    try {
      const r = await window.krypt.browser.addRoot();
      if (r.ok && r.data) {
        toast.success(`Added ${r.data.name} to the browser`);
        await loadRoots();
        setOpen((o) => ({ ...o, [r.data!.path]: true }));
      } else if (!/cancel/i.test(r.message ?? '')) report(r);
    } catch (err) {
      toast.error(`Couldn't add a folder: ${(err as Error).message}`);
    }
  };

  const removeRoot = async (root: BrowserRoot): Promise<void> => {
    try {
      const r = await window.krypt.browser.removeRoot(root.id);
      if (report(r, `Removed ${root.name} from the browser`)) await loadRoots();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const q = query.trim().toLowerCase();
  const hiddenRoot = hasIndex ? ((roots ?? []).find((r) => r.id === FACTORY_ROOT_ID)?.path ?? null) : null;
  const visibleRoots = useMemo(() => (roots ? roots.filter((r) => !(hasIndex && r.id === FACTORY_ROOT_ID)) : null), [roots, hasIndex]);
  const sampleGroups = useMemo(() => (hasIndex ? groupFactorySamples(factorySamples ?? []) : []), [hasIndex, factorySamples]);

  const matches = useMemo(() => {
    if (!q) return null;
    const out: BrowserEntry[] = [];
    for (const [dir, st] of Object.entries(dirs)) {
      if (hiddenRoot && dir.toLowerCase().startsWith(hiddenRoot.toLowerCase())) continue;
      if (st.status === 'ok') for (const e of st.entries) if (e.name.toLowerCase().includes(q)) out.push(e);
    }
    const seen = new Set<string>();
    return out.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true))).slice(0, 400);
  }, [q, dirs, hiddenRoot]);
  const presetMatches = usePresetMatches(q);
  const presetTotal = presetList(useSounds((x) => x.state)).length;
  const sampleMatchList = useMemo(() => (q && hasIndex ? (factorySamples ?? []).filter((x) => sampleMatches(x, q)).slice(0, 200) : []), [q, hasIndex, factorySamples]);
  const packGroups = useMemo(
    () =>
      (packInfo?.packs ?? [])
        .filter((p) => p.installed)
        .map((p) => ({ ...p, groups: groupFactorySamples((packInfo?.samples ?? []).filter((x) => x.path.startsWith(`pack:${p.id}/`))) }))
        .filter((p) => p.groups.length > 0),
    [packInfo],
  );
  const packsMissing = useMemo(() => (packInfo?.packs ?? []).filter((p) => !p.installed), [packInfo]);
  const packSampleCount = packInfo?.samples.length ?? 0;
  const packMatchList = useMemo(() => (q && packInfo ? packInfo.samples.filter((x) => sampleMatches(x, q)).slice(0, 200) : []), [q, packInfo]);

  const renderEntry = (e: BrowserEntry, depth: number, detail?: string) => {
    const Icon = e.kind === 'dir' ? (open[e.path] ? FolderOpen : Folder) : ICONS[e.kind];
    const isPrev = previewing === e.path;
    return (
      <div key={e.path}>
        <div
          draggable={e.kind === 'audio'}
          onDragStart={(ev) => {
            ev.dataTransfer.setData(SAMPLE_MIME, e.path);
            ev.dataTransfer.setData('text/plain', e.path);
            ev.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => void clickEntry(e)}
          onDoubleClick={() => dblEntry(e)}
          onContextMenu={(ev) => entryMenu(ev, e)}
          className={cls(
            'group flex h-[22px] cursor-pointer items-center gap-1.5 rounded pr-1.5 text-[11px] transition-colors',
            selected === e.path ? 'bg-white/[0.08] text-white' : 'text-white/80 hover:bg-white/[0.04] hover:text-white',
            e.kind === 'audio' && 'cursor-grab',
          )}
          style={{ paddingLeft: 6 + depth * 12 }}
          data-hint={
            e.kind === 'audio'
              ? `${e.name}${detail ? ` (${detail})` : ''} · click to preview, drag onto the Channel Rack / a sampler / the Playlist, double-click to add`
              : e.kind === 'project'
                ? `${e.name} · double-click to open`
                : e.kind === 'midi'
                  ? `${e.name} · double-click to import`
                  : e.name
          }
        >
          {e.kind === 'dir' ? (
            <ChevronRight className={cls('h-3 w-3 flex-shrink-0 text-krypt-muted transition-transform', open[e.path] && 'rotate-90')} />
          ) : (
            <span className="w-3 flex-shrink-0" />
          )}
          <Icon className={cls('h-3.5 w-3.5 flex-shrink-0', e.kind === 'dir' ? 'text-krypt-purple/80' : isPrev ? 'text-emerald-300' : 'text-krypt-muted')} />
          <span className="truncate">{e.name}</span>
          {detail && !isPrev && <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-krypt-muted/70">{detail}</span>}
          {isPrev && <Square className="ml-auto h-2.5 w-2.5 flex-shrink-0 fill-emerald-300 text-emerald-300" />}
        </div>
        {e.kind === 'dir' && open[e.path] && renderChildren(e.path, depth + 1)}
      </div>
    );
  };

  const renderChildren = (dir: string, depth: number) => {
    const st = dirs[dir];
    if (!st || st.status === 'loading')
      return (
        <div className="flex h-5 items-center gap-1.5 text-[10px] text-krypt-muted" style={{ paddingLeft: 6 + depth * 12 + 15 }}>
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      );
    if (st.status === 'error')
      return (
        <div className="py-0.5 text-[10px] text-rose-300" style={{ paddingLeft: 6 + depth * 12 + 15 }}>
          {st.message}
        </div>
      );
    if (!st.entries.length)
      return (
        <div className="py-0.5 text-[10px] text-krypt-muted/70" style={{ paddingLeft: 6 + depth * 12 + 15 }}>
          Empty
        </div>
      );
    return st.entries.map((e) => renderEntry(e, depth));
  };

  return (
    <div
      className="flex h-full flex-col bg-[#0b0b11]"
      onDragOver={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        void handleOsDrop(e.dataTransfer, async (paths) => {
          for (const p of paths) await addSampleChannel(p);
        });
      }}
    >
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-white/[0.06] p-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-krypt-muted" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (similarReq) closeSimilar();
            }}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search presets, sounds, opened folders"
            className="h-6 w-full rounded-md border border-white/10 bg-black/40 pl-6 pr-6 text-[11px] text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-krypt-muted hover:text-white">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void addFolder()}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 text-krypt-muted hover:border-white/20 hover:text-white"
          data-hint="Add a folder to the browser"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setDirs({});
            void loadRoots();
            void reloadSounds();
            void refreshPackSamples();
            flashHint('Browser refreshed', 'ok', 900);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 text-krypt-muted hover:border-white/20 hover:text-white"
          data-hint="Refresh folders and presets"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {previewing && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-white/[0.06] bg-emerald-500/[0.06] px-2 py-1 text-[10px] text-emerald-200">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          <span className="truncate">Previewing {previewing.split(/[\\/:]/).pop()}</span>
          <button onClick={() => void stopPreview()} className="ml-auto rounded px-1 text-emerald-200 hover:bg-white/10" data-hint="Stop preview">
            Stop
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1">
        {similarReq ? (
          <SimilarList key={similarReq.nonce} request={similarReq} previewing={previewing} selected={selected} onSelect={setSelected} onClickSample={(e) => void clickEntry(e)} />
        ) : matches ? (
          <>
            {presetMatches.length > 0 && (
              <>
                <MatchHeader label="Presets" count={presetMatches.length} />
                {presetMatches.map((p) => (
                  <PresetRow key={p.id} p={p} depth={0} selected={selected === `preset:${p.id}`} onSelect={setSelected} showRole />
                ))}
              </>
            )}
            {sampleMatchList.length > 0 && (
              <>
                <MatchHeader label="Factory sounds" count={sampleMatchList.length} />
                {sampleMatchList.map((x) => renderEntry({ name: x.name, path: x.path, kind: 'audio' }, 0, sampleDetail(x)))}
              </>
            )}
            {packMatchList.length > 0 && (
              <>
                <MatchHeader label="Sound packs" count={packMatchList.length} />
                {packMatchList.map((x) => renderEntry({ name: x.name, path: x.path, kind: 'audio' }, 0, sampleDetail(x)))}
              </>
            )}
            {matches.length > 0 && (
              <>
                <MatchHeader label="Opened folders" count={matches.length} />
                {matches.map((e) => renderEntry(e, 0))}
              </>
            )}
            {!presetMatches.length && !sampleMatchList.length && !packMatchList.length && !matches.length && (
              <div className="p-3 text-[11px] leading-snug text-krypt-muted">No matches. Presets, factory sounds and installed sound packs are searched in full; your folders only once you've opened them.</div>
            )}
          </>
        ) : (
          <>
            <div ref={presetsRef} className="mb-1" data-guide="browser.presets">
              <SectionHeader
                label="Presets"
                icon={SwatchBook}
                count={presetTotal}
                open={!!sec.presets}
                onToggle={() => toggleSec('presets')}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  openMenu(ev, [
                    { type: 'header', label: 'Presets' },
                    { label: 'Reload presets', onSelect: () => void reloadSounds('Presets reloaded') },
                    { label: 'Show your presets folder', onSelect: () => void revealUserPresets() },
                  ]);
                }}
                hint="Ready-made sounds and effect chains. Double-click or drag an instrument preset onto the Channel Rack."
              />
              {sec.presets && <PresetTree depth={1} selected={selected} onSelect={setSelected} />}
            </div>
            {hasIndex && (
              <div ref={soundsRef} className="mb-1" data-guide="browser.factory">
                <SectionHeader
                  label="Factory sounds"
                  icon={AudioLines}
                  count={factorySamples?.length ?? 0}
                  open={!!sec.sounds}
                  onToggle={() => toggleSec('sounds')}
                  hint="Drums, 808s, one-shots, risers, impacts and textures made by Krypt Studio's engine. Free to use in anything."
                />
                {sec.sounds &&
                  sampleGroups.map((g) => {
                    const k = `kind:${g.kind}`;
                    const KindIcon = sec[k] ? FolderOpen : Folder;
                    return (
                      <div key={g.kind}>
                        <div
                          onClick={() => toggleSec(k)}
                          className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded pr-1.5 text-[11px] text-white/80 transition-colors hover:bg-white/[0.04] hover:text-white"
                          style={{ paddingLeft: 18 }}
                          data-hint={`${g.label}: ${g.samples.length} factory sound${g.samples.length === 1 ? '' : 's'}`}
                        >
                          <ChevronRight className={cls('h-3 w-3 flex-shrink-0 text-krypt-muted transition-transform', sec[k] && 'rotate-90')} />
                          <KindIcon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple/80" />
                          <span className="truncate">{g.label}</span>
                          <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-krypt-muted/60">{g.samples.length}</span>
                        </div>
                        {sec[k] && g.samples.map((x) => renderEntry({ name: x.name, path: x.path, kind: 'audio' }, 2, sampleDetail(x)))}
                      </div>
                    );
                  })}
              </div>
            )}
            {(packGroups.length > 0 || packsMissing.length > 0) && (
              <div className="mb-1" data-guide="browser.packs">
                <SectionHeader
                  label="Sound packs"
                  icon={Package}
                  count={packSampleCount}
                  open={!!sec.packs}
                  onToggle={() => toggleSec('packs')}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    openMenu(ev, [
                      { type: 'header', label: 'Sound packs' },
                      { label: 'Reload sound packs', onSelect: () => void refreshPackSamples().then((err) => (err ? toast.error(`Couldn't read the sound packs: ${err}`) : flashHint('Sound packs reloaded', 'ok', 900))) },
                      { label: 'Manage sound packs…', onSelect: () => showPackInHome(packsMissing[0]?.id ?? packGroups[0]?.id ?? '') },
                    ]);
                  }}
                  hint="Recorded sound effects from free CC0 / public-domain sample packs you downloaded in Home ▸ Sounds. Click to preview, drag onto the Channel Rack or the Playlist."
                />
                {sec.packs && (
                  <>
                    {packGroups.map((p) => {
                      const pk = `pack:${p.id}`;
                      const PackIcon = sec[pk] ? FolderOpen : Folder;
                      return (
                        <div key={p.id}>
                          <div
                            onClick={() => toggleSec(pk)}
                            className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded pr-1.5 text-[11px] text-white/80 transition-colors hover:bg-white/[0.04] hover:text-white"
                            style={{ paddingLeft: 18 }}
                            data-hint={`${p.name}: ${p.count} sound${p.count === 1 ? '' : 's'}`}
                          >
                            <ChevronRight className={cls('h-3 w-3 flex-shrink-0 text-krypt-muted transition-transform', sec[pk] && 'rotate-90')} />
                            <PackIcon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple/80" />
                            <span className="truncate">{p.name}</span>
                            <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-krypt-muted/60">{p.count}</span>
                          </div>
                          {sec[pk] &&
                            p.groups.map((g) => {
                              const k = `${pk}:${g.kind}`;
                              const KindIcon = sec[k] ? FolderOpen : Folder;
                              return (
                                <div key={g.kind}>
                                  <div
                                    onClick={() => toggleSec(k)}
                                    className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded pr-1.5 text-[11px] text-white/80 transition-colors hover:bg-white/[0.04] hover:text-white"
                                    style={{ paddingLeft: 30 }}
                                    data-hint={`${g.label}: ${g.samples.length} sound${g.samples.length === 1 ? '' : 's'} from ${p.name}`}
                                  >
                                    <ChevronRight className={cls('h-3 w-3 flex-shrink-0 text-krypt-muted transition-transform', sec[k] && 'rotate-90')} />
                                    <KindIcon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple/60" />
                                    <span className="truncate">{g.label}</span>
                                    <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-krypt-muted/60">{g.samples.length}</span>
                                  </div>
                                  {sec[k] && g.samples.map((x) => renderEntry({ name: x.name, path: x.path, kind: 'audio' }, 3, sampleDetail(x)))}
                                </div>
                              );
                            })}
                        </div>
                      );
                    })}
                    {packsMissing.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => showPackInHome(p.id)}
                        className="group flex h-[22px] cursor-pointer items-center gap-1.5 rounded pr-1.5 text-[11px] text-krypt-muted transition-colors hover:bg-white/[0.04] hover:text-white"
                        style={{ paddingLeft: 18 }}
                        data-hint={`${p.name}: ${packSoundsText(p) ?? 'sounds'}. Not downloaded yet: click to open it in Home ▸ Sounds.`}
                      >
                        <span className="w-3 flex-shrink-0" />
                        <Download className="h-3.5 w-3.5 flex-shrink-0 text-krypt-muted group-hover:text-krypt-purple" />
                        <span className="truncate">{p.name}</span>
                        <span className="ml-auto flex-shrink-0 truncate text-[9.5px] text-krypt-muted/70 group-hover:text-krypt-purple">Download in Home ▸ Sounds</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            {roots === null && (
              <div className="flex items-center gap-2 p-2 text-[11px] text-krypt-muted">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {visibleRoots?.map((root) => (
              <div key={root.id} className="mb-1">
                <div
                  onClick={() => setOpen((o) => ({ ...o, [root.path]: !o[root.path] }))}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    openMenu(ev, [
                      { type: 'header', label: root.name },
                      { label: 'Refresh', onSelect: () => void loadDir(root.path, true) },
                      { label: 'Show in folder', disabled: root.builtin, onSelect: () => void window.krypt.app.showItemInFolder(root.path).then((r) => report(r)) },
                      { type: 'separator' },
                      { label: 'Remove from browser', danger: true, disabled: root.builtin, onSelect: () => void removeRoot(root) },
                    ]);
                  }}
                  className="flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-krypt-muted hover:bg-white/[0.04] hover:text-white"
                  data-hint={`${root.name}${root.builtin ? ' (built in)' : ` · ${root.path}`}`}
                >
                  <ChevronRight className={cls('h-3 w-3 transition-transform', open[root.path] && 'rotate-90')} />
                  {root.name}
                </div>
                {open[root.path] && renderChildren(root.path, 1)}
              </div>
            ))}
            {visibleRoots && visibleRoots.length === 0 && (
              <div className="p-3 text-[11px] text-krypt-muted">
                No folders of your own yet.{' '}
                <button onClick={() => void addFolder()} className="text-krypt-purple hover:underline">
                  Add a folder
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
