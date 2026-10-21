import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRightToLine,
  AudioLines,
  ClipboardPaste,
  BetweenVerticalStart,
  Blend,
  Combine,
  Copy,
  CopyPlus,
  Flag,
  FoldHorizontal,
  Grid3x3,
  Layers,
  ListChecks,
  LocateFixed,
  Magnet,
  MicVocal,
  Paintbrush,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Piano,
  Plus,
  Repeat,
  Scissors,
  ScissorsLineDashed,
  Sparkles,
  SplitSquareVertical,
  Trash2,
  VolumeX,
  WandSparkles,
} from 'lucide-react';
import { formatBBT, ticksPerBar, ticksPerBeat, type TimeSig } from '@shared/schema/time';
import { dispatch, getProject, useDocStore } from '../../doc/store';
import { openPattern, patternMenuItems } from '../../app/patternMenu';
import { wm } from '../../workspace/WindowManager';
import { clipName } from './paint';
import { DialogForm, Field, NumberBox, openDialog } from '../../components/Dialog';
import { flashHint } from '../../app/hints';
import { SNAP_OPTIONS, type SnapId } from '../../editors/snap';
import { TOOLS } from '../../editors/tools';
import { onPeaksReady } from '../../editors/peaks';
import { ContextMenu, ScrollTrack, Sep, ToolBar, ToolButton, ToolSelect, type MenuItem } from '../../editors/ui';
import { openMenu, type MenuItem as AppMenuItem } from '../../components/Menu';
import { clipEarsItems } from '../../ears/menus';
import { sliceMenuItem } from '../../racks/actions';
import { mashupWithClip } from '../../mashup/actions';
import { autoMixVocalClip } from '../../automix/actions';
import { openKryptVoice } from '../../voice/VoiceDialog';
import { barAtTick } from '../../voice/logic';
import { sendPlaylistClipToSession } from '../session/actions';
import { MOD_KEY, cls } from '../../utils/format';
import { PATTERN_MIME, PL, PlaylistController } from './controller';
import { PL_TOOLS, usePlaylistView } from './store';
import { fadeMenuItems } from './fadeMenu';
import { TakeLaneHeaders, TakesToggle } from './TakeLanes';

type Menu = { x: number; y: number; items: MenuItem[] };

export function Playlist() {
  const [ctl] = useState(() => new PlaylistController());
  const r = {
    root: useRef<HTMLDivElement>(null),
    body: useRef<HTMLDivElement>(null),
    rulerHost: useRef<HTMLDivElement>(null),
    ruler: useRef<HTMLCanvasElement>(null),
    gridHost: useRef<HTMLDivElement>(null),
    grid: useRef<HTMLCanvasElement>(null),
    content: useRef<HTMLCanvasElement>(null),
    overlay: useRef<HTMLCanvasElement>(null),
    headers: useRef<HTMLDivElement>(null),
    headersInner: useRef<HTMLDivElement>(null),
    ph1: useRef<HTMLDivElement>(null),
    ph2: useRef<HTMLDivElement>(null),
    hTrack: useRef<HTMLDivElement>(null),
    hThumb: useRef<HTMLDivElement>(null),
    vTrack: useRef<HTMLDivElement>(null),
    vThumb: useRef<HTMLDivElement>(null),
  };
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const req = <T,>(x: { current: T | null }) => x.current as T;
    const off = ctl.attach({
      root: req(r.root),
      body: req(r.body),
      rulerHost: req(r.rulerHost),
      ruler: req(r.ruler),
      gridHost: req(r.gridHost),
      grid: req(r.grid),
      content: req(r.content),
      overlay: req(r.overlay),
      headers: req(r.headers),
      headersInner: req(r.headersInner),
      playheads: [req(r.ph1), req(r.ph2)],
      hTrack: req(r.hTrack),
      hThumb: req(r.hThumb),
      vTrack: req(r.vTrack),
      vThumb: req(r.vThumb),
    });
    const offPeaks = onPeaksReady(() => ctl.invalidateContent());
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__kryptPlaylist = ctl;
    ctl.onMenu = (x, y, clipId) => {
      const doc = r.root.current?.ownerDocument ?? document;
      openMenu({ x, y, doc }, clipMenu(ctl, clipId, doc));
    };
    ctl.onEmptyMenu = (x, y, trackId, tick) => {
      const doc = r.root.current?.ownerDocument ?? document;
      openMenu({ x, y, doc }, emptyMenu(ctl, trackId, tick, doc));
    };
    ctl.onRulerMenu = (x, y, tick) => setMenu({ x, y, items: rulerMenu(ctl, tick, r.root.current?.ownerDocument ?? document) });
    return () => {
      off();
      offPeaks();
      ctl.onMenu = null;
      ctl.onEmptyMenu = null;
      ctl.onRulerMenu = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl]);

  const pickerOpen = usePlaylistView((s) => s.pickerOpen);

  return (
    <div
      ref={r.root}
      data-editor-root=""
      data-editor="playlist"
      tabIndex={0}
      className="flex h-full w-full min-w-0 flex-col bg-krypt-void text-white outline-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <PlaylistToolbar ctl={ctl} />
      <div className="flex min-h-0 flex-1">
        {pickerOpen && <PatternList />}
        <div
          ref={r.body}
          className="relative grid min-h-0 min-w-0 flex-1 select-none"
          style={{ gridTemplateColumns: `${PL.headerW}px minmax(0,1fr) ${PL.sb}px`, gridTemplateRows: `${PL.rulerH}px minmax(0,1fr) ${PL.sb}px` }}
        >
          <div className="flex items-center justify-between border-b border-r border-white/10 bg-krypt-panel px-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">Tracks</span>
            <button
              type="button"
              title="Add track"
              onClick={() => void dispatch('playlist.addTrack', {})}
              className="rounded p-0.5 text-white/50 transition hover:bg-white/5 hover:text-white"
            >
              <Plus size={14} />
            </button>
          </div>
          <div ref={r.rulerHost} data-guide="playlist.markers" className="relative overflow-hidden" title="Click: set position · drag: loop region · double-click: add a marker · drag a marker to move it, double-click it to rename · right-click: menu">
            <canvas ref={r.ruler} className="absolute left-0 top-0" />
            <div ref={r.ph1} className="pointer-events-none absolute left-0 top-0 h-full" style={{ display: 'none' }}>
              <div className="absolute -left-[5px] bottom-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-krypt-pink" />
            </div>
          </div>
          <div className="border-b border-white/10 bg-krypt-panel" />

          <div ref={r.headers} data-guide="playlist.tracks" className="relative overflow-hidden border-r border-white/10 bg-krypt-panel">
            <div ref={r.headersInner} className="absolute left-0 right-0 top-0 will-change-transform">
              <TrackHeaders ctl={ctl} onMenu={setMenu} />
            </div>
          </div>
          <div ref={r.gridHost} data-guide="playlist.grid" className="relative overflow-hidden">
            <canvas ref={r.grid} className="absolute left-0 top-0" />
            <canvas ref={r.content} className="absolute left-0 top-0" />
            <canvas ref={r.overlay} className="absolute left-0 top-0" style={{ touchAction: 'none' }} />
            <div ref={r.ph2} className="pointer-events-none absolute left-0 top-0 h-full w-px bg-krypt-pink shadow-[0_0_8px_rgba(236,72,153,0.8)]" style={{ display: 'none' }} />
          </div>
          <ScrollTrack axis="y" trackRef={r.vTrack} thumbRef={r.vThumb} />

          <div className="border-r border-t border-white/10 bg-krypt-panel" />
          <ScrollTrack axis="x" trackRef={r.hTrack} thumbRef={r.hThumb} />
          <div className="border-t border-white/10 bg-krypt-panel" />
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

function clipMenu(ctl: PlaylistController, clipId: string, doc: Document): AppMenuItem[] {
  const c = ctl.clipById(clipId);
  const project = getProject();
  if (!c) return [];
  const sel = ctl.selectedClips();
  const n = Math.max(1, sel.length);
  const many = n > 1 ? ` ${n} clips` : '';
  const patSel = sel.filter((x) => x.kind === 'pattern');
  const items: AppMenuItem[] = [{ type: 'header', label: n > 1 ? `${n} clips selected` : clipName(project, c) }];

  if (c.kind === 'pattern' && c.patternId) {
    const pid = c.patternId;
    items.push(
      { label: 'Open in Piano Roll', icon: Piano, shortcut: 'F7', hint: 'Edit the notes (or double-click the clip)', onSelect: () => openPattern(pid, 'pianoRoll') },
      { label: 'Open in Channel Rack', icon: Grid3x3, shortcut: 'F6', hint: 'Edit the steps', onSelect: () => openPattern(pid, 'channelRack') },
    );
  } else if (c.kind === 'audio' && c.channelId) {
    const chId = c.channelId;
    items.push({ label: 'Open audio editor', icon: AudioLines, hint: 'Waveform, warp, pitch and slicing for this clip', onSelect: () => wm.openPlugin({ kind: 'channel', channelId: chId }) });
  }

  items.push(
    { type: 'separator' },
    { label: `Cut${many}`, icon: ScissorsLineDashed, shortcut: `${MOD_KEY}+X`, onSelect: () => void ctl.cut() },
    { label: `Copy${many}`, icon: Copy, shortcut: `${MOD_KEY}+C`, onSelect: () => ctl.copy() },
    { label: 'Paste', icon: ClipboardPaste, shortcut: `${MOD_KEY}+V`, disabled: !ctl.hasClipboard(), hint: 'At the spot you right-clicked', onSelect: () => void ctl.paste(c.trackId) },
    { label: `Duplicate${many}`, icon: CopyPlus, shortcut: `${MOD_KEY}+B`, hint: 'Right after itself', onSelect: () => void ctl.duplicate() },
    { label: 'Clone (make unique)', icon: CopyPlus, hint: 'Duplicate, with each copy getting its own pattern', onSelect: () => void ctl.cloneSelection() },
    { label: `Delete${many}`, icon: Trash2, shortcut: 'Del', danger: true, onSelect: () => void ctl.deleteSelected() },
    { type: 'separator' },
    { label: c.mute ? `Unmute${many}` : `Mute${many}`, icon: VolumeX, onSelect: () => void ctl.toggleMute() },
    { label: 'Split here', icon: Scissors, hint: 'Cut the clip in two where you right-clicked', onSelect: () => void ctl.splitAtCursor(clipId) },
  );

  if (c.kind === 'pattern' && c.patternId) {
    items.push(
      { label: 'Make unique', icon: Sparkles, hint: 'Give this clip its own copy of the pattern, so edits only change it', onSelect: () => void ctl.makeUnique(clipId) },
      {
        label: patSel.length > 1 ? `Split ${patSel.length} clips by channel` : 'Split by channel',
        icon: SplitSquareVertical,
        hint: 'One pattern per instrument, on separate tracks',
        onSelect: () => void ctl.splitByChannel(patSel.length ? patSel.map((x) => x.id) : [clipId]),
      },
      { label: 'Select all clips of this pattern', icon: ListChecks, onSelect: () => ctl.selectAllOfPattern(clipId) },
      { type: 'submenu', label: 'Pattern', icon: Layers, swatch: project.patterns[c.patternId]?.color, items: patternMenuItems(c.patternId, { doc, open: false }) },
    );
  }
  if (patSel.length > 1) items.push({ label: `Consolidate ${patSel.length} clips`, icon: Combine, hint: 'Merge them into one pattern', onSelect: () => void ctl.consolidateSelection() });
  if (c.kind === 'audio')
    items.push(
      { type: 'separator' },
      ...clipEarsItems(clipId, doc),
      { label: 'Mashup with…', icon: Blend, hint: 'Auto Mashup with this clip as song A: pick song B next', onSelect: () => mashupWithClip(clipId, doc) },
      { label: 'Auto-mix this vocal…', icon: WandSparkles, hint: 'Auto Mix in Vocals mode with this clip as the vocal: EQ, de-ess, compression, level and space', onSelect: () => autoMixVocalClip(clipId, doc) },
      sliceMenuItem({ clipId }),
      { type: 'separator' },
      ...fadeMenuItems(ctl, c),
    );
  if (c.kind !== 'automation') items.push({ type: 'separator' }, { label: 'Send to Session view', icon: Grid3x3, hint: "Put it in this track's first empty launcher slot", onSelect: () => void sendPlaylistClipToSession(clipId) });
  return items;
}

function emptyMenu(ctl: PlaylistController, trackId: string | null, tick: number, doc: Document): AppMenuItem[] {
  const p = getProject();
  const ts = p.transport.timeSig;
  const brushId = p.transport.activePatternId;
  const brush = brushId ? p.patterns[brushId] : undefined;
  const items: AppMenuItem[] = [{ type: 'header', label: `${trackId ? (p.playlist.tracks[trackId]?.name ?? 'Track') : 'Playlist'} · bar ${barAtTick(tick, ts)}` }];
  if (trackId) {
    if (brush)
      items.push({ label: `Place ${brush.name} here`, icon: Paintbrush, swatch: brush.color, hint: 'Or just left-click: the selected pattern is your brush', onSelect: () => void ctl.placePattern(trackId, tick, brush.id) });
    items.push({
      label: 'New pattern here',
      icon: Plus,
      hint: 'An empty pattern on this spot, opened in the Piano Roll',
      onSelect: () =>
        void dispatch<{ id: string }>('patterns.add', {}).then(async (r) => {
          if (!r.ok || !r.data) return;
          await ctl.placePattern(trackId, tick, r.data.id);
          openPattern(r.data.id, 'pianoRoll');
        }),
    });
  }
  items.push(
    { label: 'Paste here', icon: ClipboardPaste, shortcut: `${MOD_KEY}+V`, disabled: !ctl.hasClipboard(), onSelect: () => void ctl.paste(trackId) },
    { type: 'separator' },
    { label: `Add a voice here… (bar ${barAtTick(tick, ts)})`, icon: MicVocal, onSelect: () => openKryptVoice({ at: barAtTick(tick, ts), trackId: trackId ?? undefined, doc }) },
    { label: 'Select all clips', icon: ListChecks, shortcut: `${MOD_KEY}+A`, onSelect: () => ctl.selectAll() },
  );
  if (!trackId) items.push({ label: 'Add a track', icon: Plus, onSelect: () => void dispatch('playlist.addTrack', {}) });
  return items;
}

function rulerMenu(ctl: PlaylistController, tick: number, doc: Document): MenuItem[] {
  const loop = ctl.loopRegion();
  const ts = ctl.timeSig;
  const at = formatBBT(tick, ts);
  return [
    { label: loop?.enabled ? 'Loop off' : 'Loop on', icon: Repeat, disabled: !loop, onClick: () => void ctl.toggleLoop() },
    { label: `Insert time at ${at}…`, icon: BetweenVerticalStart, onClick: () => openInsertTime(ctl, tick, loop ? loop.end - loop.start : ticksPerBar(ts), doc) },
    {
      label: 'Insert loop length at loop start',
      icon: ArrowRightToLine,
      disabled: !loop,
      onClick: () => loop && void ctl.insertTime(loop.start, loop.end - loop.start),
    },
    { label: 'Delete loop region time', icon: FoldHorizontal, danger: true, disabled: !loop, onClick: () => loop && void ctl.deleteTime(loop.start, loop.end) },
    { label: `Add marker at ${at}`, icon: Flag, onClick: () => void ctl.addMarker(tick) },
    { label: `Add a voice here… (bar ${barAtTick(tick, ts)})`, icon: MicVocal, onClick: () => openKryptVoice({ at: barAtTick(tick, ts), doc }) },
  ];
}

function openInsertTime(ctl: PlaylistController, at: number, defaultTicks: number, doc: Document): void {
  openDialog({
    title: 'Insert time',
    subtitle: `At ${formatBBT(at, ctl.timeSig)}. Clips after it move right; clips across it are split.`,
    icon: BetweenVerticalStart,
    doc,
    width: 380,
    render: (close) => <InsertTimeForm ts={ctl.timeSig} defaultTicks={defaultTicks} onCancel={close} onApply={(len) => (close(), void ctl.insertTime(at, len))} />,
  });
}

function InsertTimeForm({ ts, defaultTicks, onApply, onCancel }: { ts: TimeSig; defaultTicks: number; onApply: (ticks: number) => void; onCancel: () => void }) {
  const tpBar = ticksPerBar(ts);
  const tpBeat = ticksPerBeat(ts);
  const [bars, setBars] = useState(() => Math.floor(defaultTicks / tpBar));
  const [beats, setBeats] = useState(() => Math.round((defaultTicks % tpBar) / tpBeat));
  const total = bars * tpBar + beats * tpBeat;
  return (
    <DialogForm onSubmit={() => onApply(total)} onCancel={onCancel} submitLabel="Insert" submitDisabled={total < 1} extra={total < 1 ? 'Nothing to insert' : `${bars} bar${bars === 1 ? '' : 's'} ${beats} beat${beats === 1 ? '' : 's'}`}>
      <Field label="Bars">
        <NumberBox value={bars} min={0} max={999} onChange={setBars} />
      </Field>
      <Field label="Beats" hint={`${ts.num} beats per bar`}>
        <NumberBox value={beats} min={0} max={ts.num * 4} onChange={setBeats} />
      </Field>
    </DialogForm>
  );
}

function TrackHeaders({ ctl, onMenu }: { ctl: PlaylistController; onMenu: (m: Menu) => void }) {
  const order = useDocStore((s) => s.project?.playlist.trackOrder);
  const scale = usePlaylistView((s) => s.laneScale);
  if (!order) return null;
  return (
    <>
      {order.map((id, i) => (
        <Fragment key={id}>
          <TrackRow id={id} index={i} scale={scale} ctl={ctl} onMenu={onMenu} />
          <TakeLaneHeaders trackId={id} scale={scale} onMenu={onMenu} />
        </Fragment>
      ))}
    </>
  );
}

const TrackRow = memo(function TrackRow({ id, index, scale, ctl, onMenu }: { id: string; index: number; scale: number; ctl: PlaylistController; onMenu: (m: Menu) => void }) {
  const t = useDocStore((s) => s.project?.playlist.tracks[id]);
  const anySolo = useDocStore((s) => (s.project ? Object.values(s.project.playlist.tracks).some((x) => x.solo) : false));
  const [editing, setEditing] = useState(false);
  if (!t) return null;
  const h = Math.round(t.height * scale);
  const compact = h < 30;
  const silent = t.mute || (anySolo && !t.solo);
  const rename = (name: string) => {
    setEditing(false);
    const v = name.trim();
    if (v && v !== t.name) void dispatch('playlist.setTrack', { id, name: v.slice(0, 64) });
  };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const doc = (e.currentTarget as HTMLElement).ownerDocument;
    onMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename', icon: Pencil, onClick: () => setEditing(true) },
        { label: 'Insert track above', icon: Plus, onClick: () => void dispatch('playlist.addTrack', { index }) },
        { label: 'Insert track below', icon: Plus, onClick: () => void dispatch('playlist.addTrack', { index: index + 1 }) },
        { label: 'Add a voice here…', icon: MicVocal, onClick: () => openKryptVoice({ trackId: id, doc }) },
        { label: 'Delete track', icon: Trash2, danger: true, onClick: () => void dispatch('playlist.removeTrack', { id }) },
      ],
    });
  };
  return (
    <div
      data-track-id={id}
      className={cls('group relative flex items-stretch border-b border-white/[0.06] transition-colors', silent ? 'bg-black/30' : 'hover:bg-white/[0.02]')}
      style={{ height: h }}
      onContextMenu={menu}
    >
      <div className="w-1 shrink-0" style={{ background: t.color === '#3F3F52' ? 'rgba(168,85,247,0.25)' : t.color }} />
      <div className={cls('flex min-w-0 flex-1 gap-1 px-1.5', compact ? 'items-center' : 'items-start pt-1')}>
        <span className="w-5 shrink-0 pt-px font-mono text-[9px] text-white/25">{index + 1}</span>
        {editing ? (
          <input
            autoFocus
            defaultValue={t.name}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(e.currentTarget.value);
              if (e.key === 'Escape') setEditing(false);
              e.stopPropagation();
            }}
            className="min-w-0 flex-1 rounded border border-krypt-purple/60 bg-krypt-void px-1 text-[11px] text-white outline-none"
          />
        ) : (
          <span onDoubleClick={() => setEditing(true)} title="Double-click to rename" className={cls('min-w-0 flex-1 truncate text-[11px]', silent ? 'text-white/35' : 'text-white/80')}>
            {t.name}
          </span>
        )}
        <div className="flex shrink-0 gap-0.5">
          <TakesToggle trackId={id} />
          <HeaderToggle on={t.mute} label="M" title={t.mute ? 'Unmute track' : 'Mute track'} tone="amber" onClick={() => void dispatch('playlist.setTrack', { id, mute: !t.mute })} />
          <HeaderToggle on={t.solo} label="S" title={t.solo ? 'Unsolo track' : 'Solo track'} tone="purple" onClick={() => void dispatch('playlist.setTrack', { id, solo: !t.solo })} />
        </div>
      </div>
      <div
        title="Drag to resize the track"
        className="absolute -bottom-[3px] left-0 right-0 z-10 h-[7px] cursor-row-resize opacity-0 transition group-hover:opacity-100 hover:bg-krypt-purple/40"
        onPointerDown={(e) => ctl.beginTrackResize(id, e.nativeEvent, e.currentTarget)}
      />
    </div>
  );
});

function HeaderToggle({ on, label, title, tone, onClick }: { on: boolean; label: string; title: string; tone: 'amber' | 'purple'; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cls(
        'h-4 w-4 rounded-[3px] font-mono text-[9px] font-semibold leading-none transition',
        on
          ? tone === 'amber'
            ? 'bg-amber-400/80 text-black'
            : 'bg-krypt-purple text-white shadow-[0_0_8px_rgba(168,85,247,0.6)]'
          : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/80',
      )}
    >
      {label}
    </button>
  );
}

function PatternList() {
  const key = useDocStore((s) =>
    s.project ? s.project.patternOrder.map((id) => `${id}\u0001${s.project!.patterns[id]?.name ?? ''}\u0001${s.project!.patterns[id]?.color ?? ''}`).join('\u0002') : '',
  );
  const active = useDocStore((s) => s.project?.transport.activePatternId ?? null);
  const pats = key ? key.split('\u0002').map((x) => x.split('\u0001')) : [];
  return (
    <div className="flex w-[150px] shrink-0 flex-col border-r border-white/10 bg-krypt-panel">
      <div className="flex h-[26px] shrink-0 items-center justify-between border-b border-white/10 px-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">Patterns</span>
        <button type="button" title="New pattern" onClick={() => void dispatch('patterns.add', {})} className="rounded p-0.5 text-white/50 transition hover:bg-white/5 hover:text-white">
          <Plus size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {pats.map(([id, name, color]) => (
          <button
            key={id}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PATTERN_MIME, id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => void dispatch('patterns.select', { id })}
            onDoubleClick={() => openPattern(id, 'pianoRoll')}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, patternMenuItems(id, { doc: e.currentTarget.ownerDocument, brush: true }), { minWidth: 220 });
            }}
            title="Click: paint with this pattern · double-click: open in Piano Roll · right-click: more · drag onto the playlist"
            className={cls(
              'relative mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition',
              id === active ? 'bg-krypt-purple/15 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.5)]' : 'text-white/65 hover:bg-white/5 hover:text-white',
            )}
          >
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: color }} />
            <span className="truncate">{name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlaylistToolbar({ ctl }: { ctl: PlaylistController }) {
  const v = usePlaylistView();
  const brush = useDocStore((s) => {
    const id = s.project?.transport.activePatternId;
    const p = id ? s.project!.patterns[id] : undefined;
    return p ? `${p.name}\u0001${p.color}` : '';
  });
  const [bName, bColor] = brush ? brush.split('\u0001') : ['None', '#555'];
  return (
    <ToolBar>
      <ToolButton icon={v.pickerOpen ? PanelLeftClose : PanelLeftOpen} label={v.pickerOpen ? 'Hide pattern list' : 'Show pattern list'} onClick={() => v.set({ pickerOpen: !v.pickerOpen })} />
      <Sep />
      {PL_TOOLS.map((t) => (
        <ToolButton key={t} icon={TOOLS[t].icon} label={TOOLS[t].label} shortcut={TOOLS[t].key} active={v.tool === t} onClick={() => v.set({ tool: t })} />
      ))}
      <Sep />
      <ToolSelect<SnapId> title="Snap (hold Alt to bypass)" icon={Magnet} value={v.snap} onChange={(snap) => v.set({ snap })} options={SNAP_OPTIONS.map((o) => ({ value: o.id, label: o.label }))} />
      <ToolButton icon={Copy} label="Duplicate selected clips" shortcut={`${MOD_KEY}+B`} onClick={() => void ctl.duplicate()} />
      <ToolButton icon={VolumeX} label="Mute / unmute selected clips" onClick={() => void ctl.toggleMute()} />
      <ToolButton
        icon={LocateFixed}
        label={v.follow ? 'Follow playhead: on (the view pages along while the song plays)' : 'Follow playhead: off'}
        active={v.follow}
        onClick={() => {
          v.set({ follow: !v.follow });
          flashHint(v.follow ? 'Follow playhead off' : 'Follow playhead on: the view pages along while the song plays', 'ok');
        }}
      />
      <Sep />
      <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-krypt-void px-2 py-1" title="Brush: Draw and Paint place this pattern">
        <Layers size={13} className="text-white/45" />
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: bColor }} />
        <span className="max-w-[140px] truncate font-mono text-[11px] text-white/85">{bName}</span>
      </div>
      <div className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-white/30">{`${MOD_KEY}+wheel zoom · Shift+wheel scroll`}</div>
    </ToolBar>
  );
}
