// ──────────────────────────────────────────────────────────────────────
// Session view (clip launcher, research/16 §2.1): one column per playlist
// track, one row per scene. DOM grid with sticky track headers, a sticky
// scene column on the right and a sticky stop row at the bottom.
//   - edits: dispatch(session.*) via ./actions (one command per gesture)
//   - playback: window.krypt.session via ./actions (failures toast)
//   - live state: ./live (store updates only on launches; progress bars
//     are written imperatively from the frame loop)
// ──────────────────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AudioLines,
  Circle,
  Columns3,
  CornerUpLeft,
  Gauge,
  Grid3x3,
  ListOrdered,
  Palette,
  Pencil,
  Piano,
  Play,
  Plus,
  Repeat,
  Ruler,
  Shuffle,
  Square,
  Timer,
  Trash2,
  Usb,
  Wand2,
  Zap,
} from 'lucide-react';
import type { Id } from '@shared/schema/project';
import { PALETTE } from '@shared/schema/project';
import { LAUNCH_MODES, LAUNCH_QUANTS, type LaunchClip, type LaunchQuant } from '@shared/schema/launcher';
import { AUDIO_FILE_RE } from '@shared/audio/formats';
import { dispatch, getProject, useDocStore } from '../../doc/store';
import { ColorSwatches, closeMenu, openMenu, toggleMenuAt, type MenuItem } from '../../components/Menu';
import { Sep, ToolBar, ToolButton, ToolSelect } from '../../editors/ui';
import { openPanel } from '../../editors/selection';
import { wm } from '../../workspace/WindowManager';
import { modal, toast } from '../../app/notify';
import { cls } from '../../utils/format';
import * as A from './actions';
import * as M from './model';
import { retainLauncherLive, trackProgress, useLauncherLive } from './live';
import { openFollowEditor, openLengthDialog, openSceneTempoDialog } from './dialogs';
import { GridControllerPopover } from './GridControllerPopover';
import './session.css';

const L = M.SESSION_LAYOUT;
const EMPTY: readonly string[] = [];

/** Grid buttons don't take keyboard focus: the arrows / Enter / Delete stay with the grid. */
const keepFocus = (e: React.PointerEvent): void => e.preventDefault();

/** Stable callbacks the memoized cells call (selection, focus, drop highlight). */
interface GridApi {
  select: (col: number, row: number) => void;
  focus: () => void;
}

const SHOW_ALL_KEY = 'krypt.session.showAllTracks';
function readShowAll(): boolean {
  try {
    return localStorage.getItem(SHOW_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

export function SessionView() {
  const [gridOpen, setGridOpen] = useState(false);
  const [showAll, setShowAllState] = useState(readShowAll);
  const setShowAll = useCallback((v: boolean) => {
    setShowAllState(v);
    try {
      localStorage.setItem(SHOW_ALL_KEY, v ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  }, []);
  const closeGrid = useCallback(() => setGridOpen(false), []);
  useEffect(() => retainLauncherLive(), []);
  const hasTracks = useDocStore((s) => (s.project?.playlist.trackOrder.length ?? 0) > 0);
  return (
    <div className="relative flex h-full w-full min-w-0 flex-col bg-krypt-void text-white" onContextMenu={(e) => e.preventDefault()}>
      <SessionToolbar gridOpen={gridOpen} onGrid={() => setGridOpen((v) => !v)} showAll={showAll} onShowAll={setShowAll} />
      {gridOpen && <GridControllerPopover onClose={closeGrid} />}
      {hasTracks ? <SessionGrid showAll={showAll} /> : <NoTracks />}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────

function SessionToolbar({ gridOpen, onGrid, showAll, onShowAll }: { gridOpen: boolean; onGrid: () => void; showAll: boolean; onShowAll: (v: boolean) => void }) {
  const quantize = useDocStore((s) => s.project?.session?.quantize ?? '1bar');
  const anyOverridden = useLauncherLive((s) => s.anyOverridden);
  const engineRec = useLauncherLive((s) => s.recording);
  const [rec, setRec] = useState(false);
  const fromRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    window.krypt.session
      .recordState()
      .then((s) => alive && setRec(s.on))
      .catch(() => {
        /* the button just starts off */
      });
    const off = window.krypt.session.onRecordState((s) => setRec(s.on));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const recording = rec || engineRec;
  const fromMenu = (): MenuItem[] => {
    const hasMarkers = Object.keys(getProject()?.playlist.markers ?? {}).length > 0;
    return [
      { type: 'header', label: 'Scenes from the arrangement' },
      hasMarkers
        ? { label: 'One scene per marker section', icon: ListOrdered, detail: "Each track's clip at the section start becomes its slot", onSelect: () => void A.fromArrangement() }
        : { label: 'Every 8 bars', icon: Ruler, detail: 'No markers: the song is cut into equal sections', onSelect: () => void A.fromArrangement(8) },
      ...(hasMarkers ? [] : [4, 16].map((n) => ({ label: `Every ${n} bars`, icon: Ruler, onSelect: () => void A.fromArrangement(n) }))),
    ];
  };

  return (
    <ToolBar data-guide="session.toolbar">
      <ToolbarPill
        data-guide="session.stopAll"
        icon={Square}
        label="Stop all"
        hint="Stop every track's launch clip at the next quantize boundary"
        onClick={() => void A.stopTrack(null)}
      />
      <ToolbarPill
        data-guide="session.backToArrangement"
        icon={CornerUpLeft}
        label="Back to arrangement"
        hint={anyOverridden ? 'Some tracks ignore the playlist while the launcher plays them: click to hand every track back to the arrangement' : 'Every track follows the arrangement'}
        tone={anyOverridden ? 'amber' : undefined}
        pulse={anyOverridden}
        onClick={() => void A.backToArrangement()}
      />
      <ToolbarPill
        data-guide="session.record"
        icon={Circle}
        label={recording ? 'Recording launches' : 'Record to arrangement'}
        hint="Write what you launch into the playlist (Song mode, transport playing). It lands as one undoable edit when you stop."
        tone={recording ? 'rose' : undefined}
        onClick={() => void A.setLaunchRecord(!recording)}
      />
      <Sep />
      <ToolSelect<LaunchQuant>
        data-guide="session.quantize"
        title="Launch quantize: launches wait for this boundary (clips can override it)"
        icon={Timer}
        value={quantize}
        onChange={(q) => void A.setGlobalQuantize(q)}
        options={M.QUANT_OPTIONS}
      />
      <Sep />
      <ToolButton icon={Plus} label="Add a scene (a row)" onClick={() => void A.addScene()}>
        <span className="pr-0.5 text-[11px]">Scene</span>
      </ToolButton>
      <div ref={fromRef} data-guide="session.fromArrangement" className="shrink-0">
        <ToolButton icon={Wand2} label="Build scenes from the arrangement" onClick={() => fromRef.current && toggleMenuAt(fromRef.current, fromMenu, { minWidth: 240 })}>
          <span className="pr-0.5 text-[11px]">From arrangement</span>
        </ToolButton>
      </div>
      <Sep />
      <ToolButton
        icon={Columns3}
        label={showAll ? 'Showing every playlist track: click to show only the tracks in use' : 'Showing the tracks in use (+ an empty one): click to show every playlist track'}
        active={showAll}
        onClick={() => onShowAll(!showAll)}
      />
      <div data-session-grid-toggle="" data-guide="session.gridController" className="shrink-0">
        <ToolButton icon={Usb} label="Grid controller (MIDI pads launch clips)" active={gridOpen} onClick={onGrid} />
      </div>
      <div className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-white/30">Click a triangle to launch · Enter launches the selection · drag patterns or audio onto slots</div>
    </ToolBar>
  );
}

function ToolbarPill({
  icon: Icon,
  label,
  hint,
  tone,
  pulse,
  'data-guide': guide,
  onClick,
}: {
  icon: typeof Square;
  label: string;
  hint: string;
  tone?: 'amber' | 'rose';
  pulse?: boolean;
  'data-guide'?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-guide={guide}
      data-hint={hint}
      title={hint}
      onClick={onClick}
      onPointerDown={(e) => e.preventDefault()}
      className={cls(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition',
        tone === 'amber'
          ? 'border-amber-400/50 bg-amber-500/15 text-amber-200 shadow-[0_0_10px_rgba(245,158,11,0.35)]'
          : tone === 'rose'
            ? 'border-rose-400/50 bg-rose-500/15 text-rose-200 shadow-[0_0_10px_rgba(244,63,94,0.4)]'
            : 'border-white/10 bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white',
      )}
    >
      <Icon size={13} strokeWidth={2} className={cls(pulse && 'krypt-session-queued', tone === 'rose' && 'fill-current')} />
      {label}
    </button>
  );
}

// ── Empty states ─────────────────────────────────────────────────────

function NoTracks() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-8 text-center">
        <Grid3x3 className="mx-auto h-6 w-6 text-krypt-purple" />
        <div className="mt-2 text-sm font-semibold">No tracks yet</div>
        <div className="mt-1.5 text-xs text-krypt-muted">The Session view has one column per playlist track. Add a track, then drop patterns or audio into its slots.</div>
        <button
          type="button"
          onClick={() => void dispatch('playlist.addTrack', {})}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold transition hover:border-white/20 hover:bg-white/10"
        >
          <Plus className="h-3.5 w-3.5" /> Add a track
        </button>
      </div>
    </div>
  );
}

// ── The grid ─────────────────────────────────────────────────────────

type DropState = { col: number; row: number; effect: 'move' | 'copy'; label: string } | null;

function SessionGrid({ showAll }: { showAll: boolean }) {
  const allTracks = useDocStore((s) => s.project?.playlist.trackOrder ?? EMPTY);
  const sceneOrder = useDocStore((s) => s.project?.session?.sceneOrder ?? EMPTY);
  const clips = useDocStore((s) => s.project?.session?.clips);
  const playlistClips = useDocStore((s) => s.project?.playlist.clips);
  const playlistTracks = useMemo(() => new Set(Object.values(playlistClips ?? {}).map((c) => c.trackId)), [playlistClips]);
  const trackOrder = useMemo(() => M.visibleTracks(allTracks, clips, playlistTracks, showAll), [allTracks, clips, playlistTracks, showAll]);
  const index = useMemo(() => M.slotIndex(clips), [clips]);
  const withClips = useMemo(() => M.tracksWithClips(clips), [clips]);
  const cols = trackOrder.length;
  const rows = sceneOrder.length;

  const [sel, setSel] = useState<M.Cell | null>(null);
  const [drop, setDrop] = useState<DropState>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  const heldKey = useRef<Id | null>(null);

  useEffect(() => {
    setSel((c) => {
      const n = M.clampCell(c, cols, rows);
      return n && c && n.col === c.col && n.row === c.row ? c : n;
    });
  }, [cols, rows]);

  const api = useMemo<GridApi>(
    () => ({
      select: (col, row) => setSel((c) => (c && c.col === col && c.row === row ? c : { col, row })),
      focus: () => scroller.current?.focus({ preventScroll: true }),
    }),
    [],
  );

  const reveal = (cell: M.Cell): void => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-slot="${cell.col}:${cell.row}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const cellAt = (e: React.DragEvent): M.Cell | null => {
    const sc = scroller.current;
    const g = gridEl.current;
    if (!sc || !g) return null;
    const v = sc.getBoundingClientRect();
    const view = { left: v.left, top: v.top, right: v.left + sc.clientWidth, bottom: v.top + sc.clientHeight };
    return M.pointToCell(e.clientX, e.clientY, g.getBoundingClientRect(), view, cols, rows);
  };

  const onDragOver = (e: React.DragEvent): void => {
    const kind = M.dragKind(Array.from(e.dataTransfer.types));
    if (!kind) return;
    e.preventDefault();
    const cell = cellAt(e);
    if (!cell) {
      e.dataTransfer.dropEffect = 'none';
      if (drop) setDrop(null);
      return;
    }
    const effect = M.dropEffectFor(kind, e.ctrlKey || e.metaKey);
    e.dataTransfer.dropEffect = effect;
    const label = kind === 'slot' ? (effect === 'move' ? 'Move here' : 'Copy here') : 'Drop here';
    if (!drop || drop.col !== cell.col || drop.row !== cell.row || drop.label !== label) setDrop({ ...cell, effect, label });
  };

  const onDrop = (e: React.DragEvent): void => {
    const kind = M.dragKind(Array.from(e.dataTransfer.types));
    const cell = cellAt(e);
    setDrop(null);
    if (!kind) return;
    e.preventDefault();
    if (!cell) return;
    const trackId = trackOrder[cell.col];
    const sceneId = sceneOrder[cell.row];
    if (!trackId || !sceneId) return;
    api.select(cell.col, cell.row);
    api.focus();
    const dt = e.dataTransfer;
    if (kind === 'slot') {
      const id = dt.getData(M.LAUNCH_CLIP_MIME);
      const c = id ? getProject()?.session?.clips[id] : undefined;
      if (!c) return void toast.error('That clip no longer exists');
      if (c.trackId === trackId && c.sceneId === sceneId) return;
      void A.moveClip(id, trackId, sceneId, e.ctrlKey || e.metaKey);
      return;
    }
    if (kind === 'pattern') {
      const patternId = dt.getData(M.PATTERN_MIME);
      if (patternId) void A.setClipFromPattern(trackId, sceneId, patternId);
      else toast.error('Nothing to drop: the pattern is missing');
      return;
    }
    if (kind === 'sample') {
      const s = M.parseSamplePayload(dt.getData(M.SAMPLE_MIME));
      if (!s) return void toast.error('Nothing to drop: the sample path is missing');
      void A.setClipFromSample(trackId, sceneId, s.path, s.name);
      return;
    }
    if (kind === 'channel') {
      const channelId = dt.getData(M.CHANNEL_MIME);
      if (channelId) void A.setClipFromChannelDrag(trackId, sceneId, channelId);
      return;
    }
    // Explorer files: Electron resolves the real path; one file per slot.
    const files = [...dt.files].filter((f) => AUDIO_FILE_RE.test(f.name));
    if (!files.length) return void toast.warn('Drop audio files (wav, mp3, flac, ogg, aiff) onto a slot');
    let path = '';
    try {
      path = window.krypt.app.pathForFile(files[0]);
    } catch {
      path = '';
    }
    if (!path) return void toast.error(`Couldn't get the location of "${files[0].name}": drag it from the Browser panel instead`);
    if (files.length > 1) toast.info(`Added "${files[0].name}". A slot holds one clip: drop the others one by one.`);
    void A.setClipFromSample(trackId, sceneId, path, files[0].name);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const t = e.target as HTMLElement;
    // Typing a name, or a focused button handling its own Enter / Space.
    if (t !== e.currentTarget && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'SELECT')) return;
    const p = getProject();
    if (!p) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = M.moveCell(sel, e.key, cols, rows);
      setSel(next);
      if (next) reveal(next);
      return;
    }
    if (e.key === 'Escape') {
      setSel(null);
      return;
    }
    if (!sel) return;
    const trackId = trackOrder[sel.col];
    const sceneId = sceneOrder[sel.row];
    if (!trackId || !sceneId) return;
    const clipId = index.get(M.slotKey(trackId, sceneId));
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (e.shiftKey) return void A.launchScene(sceneId);
      if (!clipId) return void A.stopTrack(trackId);
      const c = p.session?.clips[clipId];
      if (c && M.needsRelease(c.launchMode)) heldKey.current = clipId;
      void A.launchClip(clipId);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && clipId) {
      e.preventDefault();
      void A.removeClip(clipId);
    }
  };

  const onKeyUp = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter' || !heldKey.current) return;
    const id = heldKey.current;
    heldKey.current = null;
    void A.launchClip(id, true);
  };

  const size = M.gridSize(cols, rows);
  /** CSS grid row of the stop buttons (row 2 holds the "no scenes" note when there are none). */
  const footerRow = Math.max(rows, 1) + 2;
  return (
    <div
      ref={scroller}
      tabIndex={0}
      data-guide="session.grid"
      className="relative min-h-0 flex-1 overflow-auto outline-none"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => {
        if (heldKey.current) onKeyUp({ key: 'Enter' } as React.KeyboardEvent);
      }}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!scroller.current?.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={onDrop}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setSel(null);
      }}
    >
      <div
        ref={gridEl}
        className="relative grid"
        style={{
          width: size.w,
          minHeight: '100%',
          gridTemplateColumns: `repeat(${cols}, ${L.colW}px) ${L.sceneW}px`,
          gridTemplateRows: `${L.headerH}px ${rows ? `repeat(${rows}, ${L.rowH}px)` : 'auto'} minmax(${L.footerH}px, 1fr)`,
        }}
      >
        {trackOrder.map((id, col) => (
          <TrackHeader key={id} trackId={id} col={col} />
        ))}
        <ScenesCorner cols={cols} />
        {rows === 0 && <NoScenes cols={cols} />}
        {sceneOrder.map((sceneId, row) => (
          <SceneRow
            key={sceneId}
            sceneId={sceneId}
            row={row}
            trackOrder={trackOrder}
            index={index}
            withClips={withClips}
            selCol={sel && sel.row === row ? sel.col : -1}
            dropCol={drop && drop.row === row ? drop.col : -1}
            dropLabel={drop?.label ?? ''}
            api={api}
          />
        ))}
        {trackOrder.map((id, col) => (
          <TrackStop key={id} trackId={id} col={col} footerRow={footerRow} />
        ))}
        <StopAllCorner cols={cols} footerRow={footerRow} />
      </div>
    </div>
  );
}

function NoScenes({ cols }: { cols: number }) {
  return (
    <div className="flex items-center justify-center border-b border-white/[0.06] px-4 py-6" style={{ gridColumn: `1 / ${cols + 2}`, gridRow: 2 }}>
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-krypt-muted">
        <span>No scenes yet. A scene is a row of clips you launch together.</span>
        <button type="button" onClick={() => void A.addScene()} className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 font-semibold text-white/90 transition hover:border-white/20 hover:bg-white/10">
          <Plus className="h-3 w-3" /> Add a scene
        </button>
        <button type="button" onClick={() => void A.fromArrangement()} className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 font-semibold text-white/90 transition hover:border-white/20 hover:bg-white/10">
          <Wand2 className="h-3 w-3" /> Build from the arrangement
        </button>
      </div>
    </div>
  );
}

// ── Track headers + stop row ─────────────────────────────────────────

const TrackHeader = memo(function TrackHeader({ trackId, col }: { trackId: Id; col: number }) {
  const name = useDocStore((s) => s.project?.playlist.tracks[trackId]?.name ?? '');
  const color = useDocStore((s) => s.project?.playlist.tracks[trackId]?.color ?? M.DEFAULT_TRACK_COLOR);
  const live = useLauncherLive((s) => (s.playing[trackId] ? 'playing' : s.overridden[trackId] ? 'overridden' : ''));
  return (
    <div
      className="sticky top-0 z-20 flex flex-col border-b border-r border-white/10 bg-krypt-panel"
      style={{ gridColumn: col + 1, gridRow: 1 }}
      title={live === 'overridden' ? `${name}: stopped from the launcher, so its arrangement clips stay silent until Back to arrangement` : name}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, [
          { type: 'header', label: name },
          { label: 'Stop this track', icon: Square, onSelect: () => void A.stopTrack(trackId) },
          { label: 'Back to arrangement (all tracks)', icon: CornerUpLeft, onSelect: () => void A.backToArrangement() },
        ]);
      }}
    >
      <div className="h-1 w-full shrink-0" style={{ background: M.trackAccent(color) }} />
      <div className="flex min-h-0 flex-1 items-center gap-1 px-2">
        <span className="font-mono text-[9px] text-white/25">{col + 1}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/85">{name}</span>
        {live === 'playing' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" title="Playing a launch clip" />}
        {live === 'overridden' && <CornerUpLeft className="h-3 w-3 shrink-0 text-amber-300" aria-label="Arrangement off" />}
      </div>
    </div>
  );
});

const TrackStop = memo(function TrackStop({ trackId, col, footerRow }: { trackId: Id; col: number; footerRow: number }) {
  const state = useLauncherLive((s) => (s.queued[trackId] === 'stop' ? 'stopping' : s.playing[trackId] ? 'playing' : ''));
  return (
    <div className="sticky bottom-0 z-20 flex items-start justify-center border-r border-t border-white/10 bg-krypt-panel pt-1" style={{ gridColumn: col + 1, gridRow: footerRow }}>
      <button
        type="button"
        title={state === 'stopping' ? 'Stopping at the next boundary' : 'Stop this track (quantized)'}
        onPointerDown={keepFocus}
        onClick={() => void A.stopTrack(trackId)}
        className={cls(
          'flex h-5 w-8 items-center justify-center rounded border transition',
          state === 'stopping'
            ? 'krypt-session-queued border-rose-400/50 bg-rose-500/15 text-rose-200'
            : state === 'playing'
              ? 'border-white/20 bg-white/[0.06] text-white/85 hover:border-rose-400/50 hover:text-rose-200'
              : 'border-white/10 bg-transparent text-white/30 hover:border-white/20 hover:text-white/70',
        )}
      >
        <Square className="h-2.5 w-2.5 fill-current" />
      </button>
    </div>
  );
});

function ScenesCorner({ cols }: { cols: number }) {
  return (
    <div data-guide="session.scenes" className="sticky right-0 top-0 z-30 flex items-center justify-between border-b border-l border-white/10 bg-krypt-panel px-2" style={{ gridColumn: cols + 1, gridRow: 1 }}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">Scenes</span>
      <button type="button" title="Add a scene" onPointerDown={keepFocus} onClick={() => void A.addScene()} className="rounded p-0.5 text-white/50 transition hover:bg-white/5 hover:text-white">
        <Plus size={14} />
      </button>
    </div>
  );
}

function StopAllCorner({ cols, footerRow }: { cols: number; footerRow: number }) {
  return (
    <div className="sticky bottom-0 right-0 z-30 flex items-start border-l border-t border-white/10 bg-krypt-panel px-2 pt-1" style={{ gridColumn: cols + 1, gridRow: footerRow }}>
      <button
        type="button"
        title="Stop every track's launch clip (quantized)"
        onPointerDown={keepFocus}
        onClick={() => void A.stopTrack(null)}
        className="inline-flex h-5 items-center gap-1.5 rounded border border-white/10 px-2 text-[10px] font-semibold text-white/70 transition hover:border-rose-400/50 hover:text-rose-200"
      >
        <Square className="h-2.5 w-2.5 fill-current" /> Stop all
      </button>
    </div>
  );
}

// ── A scene row: slots + the scene cell ──────────────────────────────

const SceneRow = memo(function SceneRow({
  sceneId,
  row,
  trackOrder,
  index,
  withClips,
  selCol,
  dropCol,
  dropLabel,
  api,
}: {
  sceneId: Id;
  row: number;
  trackOrder: readonly Id[];
  index: Map<string, Id>;
  withClips: Set<Id>;
  selCol: number;
  dropCol: number;
  dropLabel: string;
  api: GridApi;
}) {
  return (
    <>
      {trackOrder.map((trackId, col) => {
        const clipId = index.get(M.slotKey(trackId, sceneId));
        const common = { trackId, sceneId, col, row, selected: selCol === col, drop: dropCol === col ? dropLabel : null, api };
        return clipId ? <ClipSlot key={trackId} clipId={clipId} {...common} /> : <EmptySlot key={trackId} showStop={withClips.has(trackId)} {...common} />;
      })}
      <SceneCell sceneId={sceneId} row={row} cols={trackOrder.length} />
    </>
  );
});

interface SlotProps {
  trackId: Id;
  sceneId: Id;
  col: number;
  row: number;
  selected: boolean;
  /** Drop-target label while something is dragged over this slot. */
  drop: string | null;
  api: GridApi;
}

function SlotFrame({ col, row, selected, drop, children, ...rest }: Omit<SlotProps, 'trackId' | 'sceneId' | 'api'> & { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot={`${col}:${row}`}
      className="relative border-b border-r border-white/[0.06] p-[3px]"
      style={{ gridColumn: col + 1, gridRow: row + 2 }}
      {...rest}
    >
      {children}
      {selected && <div className="pointer-events-none absolute inset-[1px] rounded-md ring-1 ring-white/60" />}
      {drop && (
        <div className="pointer-events-none absolute inset-[1px] flex items-center justify-center rounded-md border border-dashed border-krypt-purple bg-krypt-purple/15 text-[9px] font-semibold uppercase tracking-wider text-white/80">
          {drop}
        </div>
      )}
    </div>
  );
}

const EmptySlot = memo(function EmptySlot({ trackId, sceneId, col, row, selected, drop, api, showStop }: SlotProps & { showStop: boolean }) {
  const menu = (e: React.MouseEvent): void => {
    e.preventDefault();
    api.select(col, row);
    openMenu(e, emptySlotMenu(trackId, sceneId));
  };
  return (
    <SlotFrame
      col={col}
      row={row}
      selected={selected}
      drop={drop}
      onPointerDown={() => {
        api.select(col, row);
        api.focus();
      }}
      onContextMenu={menu}
    >
      <div className="group flex h-full w-full items-center justify-center rounded-md bg-white/[0.015] transition hover:bg-white/[0.04]">
        {showStop && (
          <button
            type="button"
            title="Stop this track (quantized)"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={() => void A.stopTrack(trackId)}
            className="flex h-4 w-4 items-center justify-center rounded-[3px] text-white/20 transition hover:bg-white/10 hover:text-white/80"
          >
            <Square className="h-2 w-2 fill-current" />
          </button>
        )}
      </div>
    </SlotFrame>
  );
});

function emptySlotMenu(trackId: Id, sceneId: Id): MenuItem[] {
  const p = getProject();
  const pats: MenuItem[] = p.patternOrder.map((id) => ({
    label: p.patterns[id]?.name ?? id,
    swatch: p.patterns[id]?.color,
    onSelect: () => void A.setClipFromPattern(trackId, sceneId, id),
  }));
  const audio: MenuItem[] = p.channelOrder
    .filter((id) => p.channels[id]?.generator.type === 'krypt.audioclip')
    .map((id) => ({ label: p.channels[id].name, swatch: p.channels[id].color, onSelect: () => void A.setClipFromChannel(trackId, sceneId, id) }));
  return [
    { type: 'submenu', label: 'Add pattern', icon: Piano, items: pats.length ? pats : [{ label: 'No patterns yet', disabled: true, onSelect: () => {} }], disabled: !pats.length },
    {
      type: 'submenu',
      label: 'Add audio clip',
      icon: AudioLines,
      items: audio.length ? audio : [{ label: 'No audio clips yet', disabled: true, onSelect: () => {} }],
      disabled: !audio.length,
    },
    { type: 'separator' },
    { label: 'Stop this track', icon: Square, onSelect: () => void A.stopTrack(trackId) },
    { label: 'Launch this scene', icon: Play, shortcut: 'Shift+Enter', onSelect: () => void A.launchScene(sceneId) },
  ];
}

const ClipSlot = memo(function ClipSlot({ clipId, trackId, sceneId, col, row, selected, drop, api }: SlotProps & { clipId: Id }) {
  const clip = useDocStore((s) => s.project?.session?.clips[clipId]);
  const label = useDocStore((s) => {
    const p = s.project;
    const c = p?.session?.clips[clipId];
    return p && c ? M.clipLabel(c, p) : '';
  });
  const color = useDocStore((s) => {
    const p = s.project;
    const c = p?.session?.clips[clipId];
    return p && c ? M.clipColor(c, p) : M.FALLBACK_CLIP_COLOR;
  });
  const status = useLauncherLive((s) => M.slotStatus(clipId, trackId, s));
  const progRef = useRef<HTMLDivElement>(null);
  const held = useRef(false);

  useEffect(() => {
    const el = progRef.current;
    return el ? trackProgress(el, clipId) : undefined;
  }, [clipId]);

  if (!clip) return null;
  const playing = status === 'playing';
  const queued = status === 'queued';
  const badges: string[] = [];
  if (clip.launchMode !== 'trigger') badges.push(M.LAUNCH_MODE_LABELS[clip.launchMode].label);
  if (clip.quantize) badges.push(`Q ${M.QUANT_LABELS[clip.quantize]}`);
  const tip = [
    label,
    `${clip.kind === 'pattern' ? 'Pattern' : 'Audio'} · ${M.formatBars(M.ticksToBars(clip.length, tsOf()))}${clip.loop ? ', looping' : ', plays once'}`,
    `${M.LAUNCH_MODE_LABELS[clip.launchMode].label}: ${M.LAUNCH_MODE_LABELS[clip.launchMode].hint}`,
    M.followActive(clip.follow) ? `Follow: ${M.followSummary(clip.follow)}` : '',
    'Double-click to edit · right-click for options · drag to move (Ctrl copies)',
  ]
    .filter(Boolean)
    .join('\n');

  const release = (): void => {
    if (!held.current) return;
    held.current = false;
    void A.launchClip(clipId, true);
  };

  return (
    <SlotFrame
      col={col}
      row={row}
      selected={selected}
      drop={drop}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(M.LAUNCH_CLIP_MIME, clipId);
        // The playlist takes a pattern clip dragged out of the launcher, too.
        if (clip.kind === 'pattern' && clip.patternId) e.dataTransfer.setData(M.PATTERN_MIME, clip.patternId);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onPointerDown={() => {
        api.select(col, row);
        api.focus();
      }}
      onDoubleClick={() => openClipSource(clip)}
      onContextMenu={(e) => {
        e.preventDefault();
        api.select(col, row);
        openMenu(e, clipMenu(clip, label, status, sceneId, e.currentTarget.ownerDocument), { minWidth: 220 });
      }}
    >
      <div
        title={tip}
        className={cls(
          'relative flex h-full w-full items-center gap-1 overflow-hidden rounded-md border pr-1.5 transition',
          playing ? 'border-emerald-400/70 shadow-[0_0_10px_rgba(52,211,153,0.35)]' : queued ? 'krypt-session-queued border-white/50' : 'border-white/10 hover:border-white/25',
        )}
        style={{ background: M.withAlpha(color, playing ? 0.38 : 0.2) }}
      >
        <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
        <button
          type="button"
          title={M.needsRelease(clip.launchMode) ? 'Hold to play' : playing && clip.launchMode === 'toggle' ? 'Stop' : 'Launch'}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            if (e.button !== 0) return;
            api.select(col, row);
            api.focus();
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* capture is best effort */
            }
            held.current = M.needsRelease(clip.launchMode);
            void A.launchClip(clipId);
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cls(
            'ml-[5px] flex h-5 w-5 shrink-0 items-center justify-center rounded transition',
            playing ? 'text-emerald-300' : 'text-white/60 hover:bg-white/10 hover:text-white',
          )}
        >
          <Play className={cls('h-3 w-3', (playing || queued) && 'fill-current')} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/90">{label}</span>
        {M.followActive(clip.follow) && <Shuffle className="h-2.5 w-2.5 shrink-0 text-white/50" aria-label="Follow action" />}
        {!clip.loop && <span className="shrink-0 font-mono text-[8px] text-white/50">1×</span>}
        {badges.length > 0 && <span className="shrink-0 font-mono text-[8px] uppercase text-white/45">{badges[0].slice(0, 1)}</span>}
        <div ref={progRef} className="krypt-session-progress absolute bottom-0 left-0 h-[2px] w-full bg-emerald-400" />
      </div>
    </SlotFrame>
  );
});

function tsOf() {
  return getProject()?.transport.timeSig ?? { num: 4, den: 4 };
}

function openClipSource(c: LaunchClip): void {
  if (c.kind === 'pattern' && c.patternId) {
    void dispatch('patterns.select', { id: c.patternId }).then((r) => r.ok && openPanel('pianoRoll'));
  } else if (c.kind === 'audio' && c.channelId) {
    wm.openPlugin({ kind: 'channel', channelId: c.channelId });
  } else toast.error("This clip's source is missing");
}

function clipMenu(c: LaunchClip, label: string, status: M.SlotStatus, sceneId: Id, doc: Document): MenuItem[] {
  const p = getProject();
  const ts = tsOf();
  const globalQ = p.session?.quantize ?? '1bar';
  const bars = M.ticksToBars(c.length, ts);
  return [
    { type: 'header', label },
    status === 'playing'
      ? { label: 'Stop track', icon: Square, onSelect: () => void A.stopTrack(c.trackId) }
      : { label: 'Launch', icon: Play, shortcut: 'Enter', onSelect: () => void A.launchClip(c.id) },
    { label: 'Launch scene', icon: Play, shortcut: 'Shift+Enter', onSelect: () => void A.launchScene(sceneId) },
    c.kind === 'pattern'
      ? { label: 'Open in Piano Roll', icon: Piano, onSelect: () => openClipSource(c) }
      : { label: 'Open audio clip settings', icon: AudioLines, onSelect: () => openClipSource(c) },
    { type: 'separator' },
    {
      label: 'Rename…',
      icon: Pencil,
      onSelect: () =>
        void modal
          .prompt({ title: 'Rename clip', message: 'Leave it empty to use the pattern or audio name.', initialValue: c.name ?? label, validate: (v) => (v.length > 64 ? 'At most 64 characters' : null) })
          .then((v) => {
            if (v === null) return;
            const name = v.trim();
            void A.updateClip(c.id, { name: name ? name : null }, 'Rename clip');
          }),
    },
    {
      type: 'submenu',
      label: 'Color',
      icon: Palette,
      swatch: c.color ?? undefined,
      items: [
        {
          type: 'custom',
          render: () => (
            <ColorSwatches
              colors={PALETTE}
              current={c.color ?? undefined}
              onPick={(color) => {
                closeMenu();
                void A.updateClip(c.id, { color }, 'Clip color');
              }}
            />
          ),
        },
        { label: 'Use the source color', disabled: !c.color, onSelect: () => void A.updateClip(c.id, { color: null }, 'Clip color') },
      ],
    },
    {
      type: 'submenu',
      label: `Launch mode: ${M.LAUNCH_MODE_LABELS[c.launchMode].label}`,
      icon: Zap,
      items: LAUNCH_MODES.map((m) => ({
        label: M.LAUNCH_MODE_LABELS[m].label,
        detail: M.LAUNCH_MODE_LABELS[m].hint,
        checked: m === c.launchMode,
        onSelect: () => void A.updateClip(c.id, { launchMode: m }, 'Launch mode'),
      })),
    },
    {
      type: 'submenu',
      label: `Quantize: ${c.quantize ? M.QUANT_LABELS[c.quantize] : 'Global'}`,
      icon: Timer,
      items: [
        { label: `Global (${M.QUANT_LABELS[globalQ]})`, checked: !c.quantize, onSelect: () => void A.updateClip(c.id, { quantize: null }, 'Clip quantize') },
        { type: 'separator' },
        ...LAUNCH_QUANTS.map((q) => ({ label: M.QUANT_LABELS[q], checked: c.quantize === q, onSelect: () => void A.updateClip(c.id, { quantize: q }, 'Clip quantize') })),
      ],
    },
    {
      label: c.loop ? 'Loop: on' : 'Loop: off (plays once)',
      icon: Repeat,
      checked: c.loop,
      onSelect: () => void A.updateClip(c.id, { loop: !c.loop }, c.loop ? 'Loop off' : 'Loop on'),
    },
    {
      type: 'submenu',
      label: `Length: ${M.formatBars(Math.round(bars * 100) / 100)}`,
      icon: Ruler,
      items: [
        ...M.LENGTH_PRESETS_BARS.map((b) => ({
          label: M.formatBars(b),
          checked: Math.abs(bars - b) < 1e-6,
          onSelect: () => void A.updateClip(c.id, { length: M.barsToTicks(b, ts) }, 'Clip length'),
        })),
        { type: 'separator' },
        { label: 'Custom…', icon: Ruler, onSelect: () => openLengthDialog(c, label, ts, doc) },
      ],
    },
    { label: 'Follow action…', icon: Shuffle, detail: M.followSummary(c.follow), onSelect: () => openFollowEditor(c, label, ts, doc) },
    { type: 'separator' },
    { label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, onSelect: () => void A.removeClip(c.id) },
  ];
}

// ── Scene cell (sticky right column) ─────────────────────────────────

const SceneCell = memo(function SceneCell({ sceneId, row, cols }: { sceneId: Id; row: number; cols: number }) {
  const scene = useDocStore((s) => s.project?.session?.scenes[sceneId]);
  const count = useDocStore((s) => s.project?.session?.sceneOrder.length ?? 0);
  const [editing, setEditing] = useState(false);
  if (!scene) return null;
  const rename = (v: string): void => {
    setEditing(false);
    const name = v.trim().slice(0, 64);
    if (name && name !== scene.name) void A.setScene(sceneId, { name });
  };
  const menu = (e: React.MouseEvent): void => {
    e.preventDefault();
    const doc = e.currentTarget.ownerDocument;
    openMenu(
      e,
      [
        { type: 'header', label: scene.name },
        { label: 'Launch scene', icon: Play, onSelect: () => void A.launchScene(sceneId) },
        { label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) },
        {
          type: 'submenu',
          label: 'Color',
          icon: Palette,
          swatch: scene.color ?? undefined,
          items: [
            {
              type: 'custom',
              render: () => (
                <ColorSwatches
                  colors={PALETTE}
                  current={scene.color ?? undefined}
                  onPick={(color) => {
                    closeMenu();
                    void A.setScene(sceneId, { color });
                  }}
                />
              ),
            },
            { label: 'No color', disabled: !scene.color, onSelect: () => void A.setScene(sceneId, { color: null }) },
          ],
        },
        { label: scene.tempo ? `Tempo: ${scene.tempo} BPM…` : 'Set tempo on launch…', icon: Gauge, onSelect: () => openSceneTempoDialog(scene, getProject().transport.bpm, doc) },
        { type: 'separator' },
        { label: 'Insert scene above', icon: Plus, onSelect: () => void A.addScene(row) },
        { label: 'Insert scene below', icon: Plus, onSelect: () => void A.addScene(row + 1) },
        { label: 'Move up', disabled: row === 0, onSelect: () => void A.moveScene(sceneId, row - 1) },
        { label: 'Move down', disabled: row >= count - 1, onSelect: () => void A.moveScene(sceneId, row + 1) },
        { type: 'separator' },
        { label: 'Delete scene', icon: Trash2, danger: true, hint: 'Removes the scene and its clips (undoable)', onSelect: () => void A.removeScene(sceneId) },
      ],
      { minWidth: 210 },
    );
  };
  return (
    <div
      className="sticky right-0 z-10 flex items-center gap-1 border-b border-l border-white/10 bg-krypt-panel pr-1.5"
      style={{ gridColumn: cols + 1, gridRow: row + 2 }}
      onContextMenu={menu}
    >
      <div className="h-full w-[3px] shrink-0" style={{ background: scene.color ?? 'transparent' }} />
      <button
        type="button"
        title="Launch this scene: every track plays its clip in this row (tracks without one stop)"
        onPointerDown={keepFocus}
        onClick={() => void A.launchScene(sceneId)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 text-white/70 transition hover:border-krypt-purple/60 hover:bg-krypt-purple/15 hover:text-white"
      >
        <Play className="h-3 w-3" />
      </button>
      {editing ? (
        <input
          autoFocus
          defaultValue={scene.name}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename(e.currentTarget.value);
            if (e.key === 'Escape') setEditing(false);
            e.stopPropagation();
          }}
          className="min-w-0 flex-1 rounded border border-krypt-purple/60 bg-krypt-void px-1 text-[11px] text-white outline-none"
        />
      ) : (
        <span onDoubleClick={() => setEditing(true)} title="Double-click to rename" className="min-w-0 flex-1 cursor-default truncate text-[11px] text-white/80">
          {scene.name}
        </span>
      )}
      {!editing && (
        <button
          type="button"
          title={scene.tempo ? `Launching sets ${scene.tempo} BPM (click to change)` : 'Set a tempo for this scene'}
          onPointerDown={keepFocus}
          onClick={(e) => openSceneTempoDialog(scene, getProject().transport.bpm, e.currentTarget.ownerDocument)}
          className={cls(
            'shrink-0 rounded px-1 font-mono text-[9px] transition',
            scene.tempo ? 'border border-krypt-purple/40 bg-krypt-purple/15 text-white/85 hover:border-krypt-purple/70' : 'text-white/20 hover:bg-white/5 hover:text-white/60',
          )}
        >
          {scene.tempo ? `${Math.round(scene.tempo * 10) / 10}` : 'BPM'}
        </button>
      )}
    </div>
  );
});
