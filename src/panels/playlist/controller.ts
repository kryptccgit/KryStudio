import type { AutomationPoint, Clip, Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import { ticksPerBar, type TimeSig } from '@shared/schema/time';
import { evalAutomation } from '@shared/schema/automation';
import { dispatch, dispatchBatch, getProject, useDocStore } from '../../doc/store';
import { onFrame } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { locateSim, playState } from '../../live/playState';
import { toast } from '../../app/notify';
import { MOD_KEY } from '../../utils/format';
import { flashHint } from '../../app/hints';
import { Layer, hline, layerDpr, observeSize, px } from '../../editors/layer';
import {
  clamp,
  clampScroll,
  edgeScrollStep,
  laneAt,
  tickToX,
  viewTicks,
  visibleLanes,
  wheelZoomFactor,
  xToTick,
  zoomAt,
  type TimeView,
} from '../../editors/viewport';
import { cellStart, snapMoveDelta, snapResizeEnd, snapResizeStart, snapTicks, snapTo } from '../../editors/snap';
import { SpanIndex, hitClip, nearestPoint, type EdgeZone } from '../../editors/spanIndex';
import { paintRuler, paintTimeGrid } from '../../editors/gridPaint';
import { GlowTracker, changedIds } from '../../editors/agentGlow';
import { duplicateShift, getClipClipboard, setClipClipboard } from '../../editors/clipboard';
import { ScrollbarCtl } from '../../editors/scrollbar';
import { isMod, isTypingTarget, toolForKey } from '../../editors/tools';
import { openPanel } from '../../editors/selection';
import { C, rgba } from '../../editors/theme';
import { PL_TOOLS, usePlaylistView } from './store';
import { CLIP_HEADER_H, automationPointsXY, paintClip, sortedPoints, type AutoOverride } from './paint';
import { AUDIO_FILE_RE } from '@shared/audio/formats';
import { ticksPerBeat } from '@shared/schema/time';
import { previousTouching, type CrossfadeKind } from '@shared/commands/fades';
import type { Marker } from '@shared/schema/project';
import { openMenu } from '../../components/Menu';
import { fadeLabel, fadeLenAt, hitFadeHandle, withFade, type FadeDrag, type FadeEdge } from './fades';
import { editMarkerInline, hitMarker, markerLabelWidth, markerMenuItems, markersWithDrag, moveMarker, type MarkerDrag } from './markers';
import { followTempoAfterDrop } from './followTempo';
import { TakeLanes, buildTrackLanes, type TrackLaneLayout } from './takes';
import { registerTabView } from '../../app/tabs/viewState';

export const PL = { headerW: 168, rulerH: 26, sb: 10 } as const;
export const SAMPLE_MIME = 'application/x-krypt-sample';
export const PATTERN_MIME = 'application/x-krypt-pattern';
const AUDIO_EXT = AUDIO_FILE_RE;
const MIN_PX = 0.0015;
const MAX_PX = 0.6;
const EDGE_PX = 6;

export interface PlaylistEls {
  root: HTMLElement;
  body: HTMLElement;
  rulerHost: HTMLElement;
  ruler: HTMLCanvasElement;
  gridHost: HTMLElement;
  grid: HTMLCanvasElement;
  content: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  headers: HTMLElement;
  headersInner: HTMLElement;
  playheads: HTMLElement[];
  hTrack: HTMLElement;
  hThumb: HTMLElement;
  vTrack: HTMLElement;
  vThumb: HTMLElement;
}

interface Ptr {
  x: number;
  y: number;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
}

interface ClipHit {
  clip: Clip;
  zone: EdgeZone;
  lane: number;
  header: boolean;
}

type Drag =
  | { kind: 'create'; lane: number; origStart: number; start: number; len: number; downTick: number; patternId: string; committing?: boolean }
  | { kind: 'paint'; lane: number; start: number; len: number; slots: Set<number>; patternId: string; committing?: boolean }
  | {
      kind: 'move';
      ids: string[];
      origins: Map<string, Clip>;
      laneOf: Map<string, number>;
      primary: Clip;
      downTick: number;
      downLane: number;
      downX: number;
      downY: number;
      minStart: number;
      minLane: number;
      maxLane: number;
      dT: number;
      dL: number;
      copy: boolean;
      moved: boolean;
      committing?: boolean;
    }
  | { kind: 'resize'; edge: 'left' | 'right'; ids: string[]; origins: Map<string, Clip>; primary: Clip; grab: number; dT: number; committing?: boolean }
  | { kind: 'marquee'; tickA: number; yA: number; base: Set<string> }
  | { kind: 'erase'; ids: Set<string>; lastX: number; lastY: number; menu?: RightPress; committing?: boolean }
  | { kind: 'mute'; ids: Set<string>; value: boolean | null; lastX: number; lastY: number; committing?: boolean }
  | { kind: 'slice'; tick: number; laneA: number; laneB: number; committing?: boolean }
  | { kind: 'pan'; x: number; y: number; scrollTick: number; scrollY: number }
  | { kind: 'apoint'; clip: Clip; lane: number; autId: string; orig: AutomationPoint; tick: number; value: number; downX: number; downY: number; moved: boolean; committing?: boolean }
  | { kind: 'atension'; clip: Clip; autId: string; point: AutomationPoint; dir: number; downY: number; tension: number; committing?: boolean };

type RightPress = { clientX: number; clientY: number; downX: number; downY: number; clipId: string | null; lane: number };

const RIGHT_DRAG_PX = 4;

type RulerDrag =
  | { kind: 'press'; downX: number; tick: number; anchor: number }
  | { kind: 'loop'; a: number; b: number }
  | { kind: 'edge'; edge: 'start' | 'end'; start: number; end: number };

type PlaylistViewSnap = { scrollTick: number; pxPerTick: number; scrollY: number };

export class PlaylistController {
  private gridL = new Layer();
  private contentL = new Layer();
  private overlayL = new Layer();
  private rulerL = new Layer();
  private els: PlaylistEls | null = null;
  private hbar: ScrollbarCtl | null = null;
  private vbar: ScrollbarCtl | null = null;

  tv: TimeView = { scrollTick: 0, pxPerTick: 0.022 };
  scrollY = 0;
  private dpr = 1;

  private project: Project | null = null;
  private lanes: TrackLaneLayout = buildTrackLanes([], () => 0, () => 0);
  private takes = new TakeLanes({
    project: () => this.project,
    lanes: () => this.lanes,
    scrollY: () => this.scrollY,
    tv: () => this.tv,
    grid: () => this.snapGrid(),
    scale: () => this.laneScale,
    invalidate: () => {
      this.contentL.dirty = this.overlayL.dirty = true;
    },
  });
  private laneScale = 1;
  private tracksRec: Project['playlist']['tracks'] | null = null;
  private trackOrder: string[] | null = null;
  private clipsRec: Record<string, Clip> | null = null;
  private trackIdx = new Map<string, SpanIndex<Clip>>();
  private songEnd = 0;
  private ts: TimeSig = { num: 4, den: 4 };
  private anySolo = false;

  readonly selection = new Set<string>();
  private drag: Drag | null = null;
  private ptr: Ptr | null = null;
  private downPt: { x: number; y: number; armed: boolean } | null = null;
  private hover: { lane: number; tick: number; clipId: string | null; zone: EdgeZone | ''; pointId: string | null } | null = null;
  private rulerDrag: RulerDrag | null = null;
  private fadeDrag: FadeDrag | null = null;
  private fadeHover: FadeEdge | null = null;
  private markerDrag: MarkerDrag | null = null;
  private dropPreview: { lane: number; tick: number; len: number; label: string } | null = null;
  private heightOverride = new Map<string, number>();
  private localPlayhead: number | null = null;
  private lastClickTick: number | null = null;
  private glow = new GlowTracker();
  private glowWasActive = false;
  private offs: Array<() => void> = [];

  private userViewAt = 0;

  onMenu: ((x: number, y: number, clipId: string) => void) | null = null;
  onEmptyMenu: ((x: number, y: number, trackId: string | null, tick: number) => void) | null = null;
  onRulerMenu: ((x: number, y: number, tick: number) => void) | null = null;

  attach(els: PlaylistEls): () => void {
    this.els = els;
    this.gridL.attach(els.grid);
    this.contentL.attach(els.content);
    this.overlayL.attach(els.overlay);
    this.rulerL.attach(els.ruler);
    this.dpr = layerDpr(els.overlay);
    this.laneScale = usePlaylistView.getState().laneScale;

    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    this.offs.push(
      observeSize(els.gridHost, (w, h) => {
        this.gridL.resize(w, h);
        this.contentL.resize(w, h);
        this.overlayL.resize(w, h);
        this.setScrollY(this.scrollY);
        this.updateScrollbars();
      }),
      observeSize(els.rulerHost, (w, h) => this.rulerL.resize(w, h)),
    );

    on(els.overlay, 'pointerdown', (e) => this.onGridDown(e));
    on(els.overlay, 'pointermove', (e) => this.onGridMove(e));
    on(els.overlay, 'pointerup', (e) => this.onGridUp(e));
    on(els.overlay, 'pointercancel', (e) => this.onGridUp(e, true));
    on(els.overlay, 'pointerleave', () => {
      if (!this.drag && this.hover) {
        this.hover = null;
        this.overlayL.dirty = this.contentL.dirty = true;
      }
    });
    on(els.overlay, 'dblclick', (e) => this.onDblClick(e));
    on(els.overlay, 'contextmenu', (e) => e.preventDefault());
    on(els.overlay, 'dragover', (e) => this.onDragOver(e));
    on(els.overlay, 'dragleave', () => {
      this.dropPreview = null;
      this.overlayL.dirty = true;
    });
    on(els.overlay, 'drop', (e) => void this.onDrop(e));
    on(els.ruler, 'pointerdown', (e) => this.onRulerDown(e));
    on(els.ruler, 'pointermove', (e) => this.onRulerMove(e));
    on(els.ruler, 'pointerup', () => this.onRulerUp());
    on(els.ruler, 'pointercancel', () => {
      this.rulerDrag = null;
      this.markerDrag = null;
      this.rulerL.dirty = true;
    });
    on(els.ruler, 'dblclick', (e) => this.onRulerDbl(e));
    on(els.ruler, 'contextmenu', (e) => e.preventDefault());
    on(els.body, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(els.root, 'keydown', (e) => this.onKey(e));
    on(els.root, 'pointerdown', () => {
      if (!isTypingTarget(els.root.ownerDocument.activeElement)) els.root.focus({ preventScroll: true });
    });

    this.hbar = new ScrollbarCtl(els.hTrack, els.hThumb, 'x', (p) => {
      this.noteUserView();
      this.setScrollTick(p);
    });
    this.vbar = new ScrollbarCtl(els.vTrack, els.vThumb, 'y', (p) => this.setScrollY(p));

    this.offs.push(
      useDocStore.subscribe((s, prev) => {
        if (s.project !== prev.project) this.refresh(s.lastChange?.actorKind === 'agent' && s.version !== prev.version, prev.project);
      }),
      usePlaylistView.subscribe((s, prev) => {
        if (s.laneScale !== prev.laneScale) {
          this.laneScale = s.laneScale;
          this.rebuildLanes();
        }
        if (s.snap !== prev.snap) this.gridL.dirty = true;
        if (s.tool !== prev.tool) this.updateCursor();
      }),
      onFrame((_dt, now) => this.frame(now)),
      this.takes.subscribe(() => this.rebuildLanes()),
      registerTabView('playlist', { capture: () => this.viewSnapshot(), restore: (v) => this.restoreView(v as PlaylistViewSnap | undefined) }),
    );
    void els.root.ownerDocument.fonts?.ready.then(() => this.markAll());
    this.refresh(false, null);
    return () => this.detach();
  }

  private detach(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.hbar?.destroy();
    this.vbar?.destroy();
    this.els = null;
  }

  private markAll(): void {
    for (const l of [this.gridL, this.contentL, this.overlayL, this.rulerL]) l.dirty = true;
  }

  private refresh(agent: boolean, prevProject: Project | null): void {
    const p = getProject();
    if (!p) return;
    const prev = this.project;
    this.project = p;
    if (p.playlist.trackOrder !== this.trackOrder || p.playlist.tracks !== this.tracksRec) {
      this.trackOrder = p.playlist.trackOrder;
      this.tracksRec = p.playlist.tracks;
      this.anySolo = Object.values(p.playlist.tracks).some((t) => t.solo);
      this.rebuildLanes();
    }
    if (this.takes.changed(p)) this.rebuildLanes();
    if (p.playlist.clips !== this.clipsRec) {
      if (agent) this.glow.mark(changedIds(this.clipsRec ?? undefined, p.playlist.clips), performance.now());
      this.clipsRec = p.playlist.clips;
      this.rebuildIndex();
      for (const id of this.selection) if (!p.playlist.clips[id]) this.selection.delete(id);
    }
    if (agent && prevProject) {
      const pats = new Set(changedIds(prevProject.patterns, p.patterns));
      const auts = new Set(changedIds(prevProject.automations, p.automations));
      if (pats.size || auts.size) {
        const ids: string[] = [];
        for (const c of Object.values(p.playlist.clips)) {
          if ((c.patternId && pats.has(c.patternId)) || (c.automationId && auts.has(c.automationId))) ids.push(c.id);
        }
        this.glow.mark(ids, performance.now());
      }
    }
    if (p.transport.timeSig !== this.ts) {
      this.ts = p.transport.timeSig;
      this.markAll();
    }
    if (!prev || prev.transport.loop !== p.transport.loop || prev.playlist.markers !== p.playlist.markers) this.rulerL.dirty = true;
    this.contentL.dirty = this.overlayL.dirty = true;
    this.updateScrollbars();
  }

  private rebuildLanes(): void {
    const p = this.project;
    if (!p) return;
    const s = this.laneScale;
    this.lanes = buildTrackLanes(p.playlist.trackOrder, (id) => this.heightOverride.get(id) ?? Math.round((p.playlist.tracks[id]?.height ?? 44) * s), (id) => this.takes.extra(p, id, s));
    this.gridL.dirty = this.contentL.dirty = this.overlayL.dirty = true;
    this.setScrollY(this.scrollY);
    this.updateScrollbars();
  }

  private rebuildIndex(): void {
    const by = new Map<string, Clip[]>();
    let end = 0;
    for (const c of Object.values(this.clipsRec ?? {})) {
      let arr = by.get(c.trackId);
      if (!arr) by.set(c.trackId, (arr = []));
      arr.push(c);
      end = Math.max(end, c.start + c.length);
    }
    this.trackIdx = new Map([...by].map(([k, v]) => [k, new SpanIndex(v, (c) => c.start, (c) => c.length)]));
    this.songEnd = end;
  }

  private snapGrid(): number {
    return snapTicks(usePlaylistView.getState().snap, this.ts);
  }

  private clip(id: string): Clip | undefined {
    return this.clipsRec?.[id];
  }

  private laneOfClip(c: Clip): number {
    return this.lanes.ids.indexOf(c.trackId);
  }

  private contentTicks(): number {
    const bar = ticksPerBar(this.ts);
    return Math.max(this.songEnd + bar * 16, bar * 128);
  }

  viewSnapshot(): PlaylistViewSnap {
    return { scrollTick: this.tv.scrollTick, pxPerTick: this.tv.pxPerTick, scrollY: this.scrollY };
  }

  restoreView(v: PlaylistViewSnap | undefined): void {
    this.selection.clear();
    this.drag = null;
    const px = v && Number.isFinite(v.pxPerTick) ? Math.max(MIN_PX, Math.min(MAX_PX, v.pxPerTick)) : this.tv.pxPerTick;
    this.tv = { scrollTick: 0, pxPerTick: px };
    this.setScrollTick(v && Number.isFinite(v.scrollTick) ? v.scrollTick : 0);
    this.setScrollY(v && Number.isFinite(v.scrollY) ? v.scrollY : 0);
    this.markAll();
    this.updateScrollbars();
  }

  setScrollTick(t: number, allowGrow = false): void {
    const vt = viewTicks(this.tv, this.gridL.w || 1);
    const next = allowGrow ? Math.max(0, t) : clampScroll(t, Math.max(this.contentTicks(), this.tv.scrollTick + vt), vt);
    if (next !== this.tv.scrollTick) {
      this.tv = { ...this.tv, scrollTick: next };
      this.gridL.dirty = this.contentL.dirty = this.overlayL.dirty = this.rulerL.dirty = true;
      this.updateScrollbars();
    }
  }

  setScrollY(y: number): void {
    const next = clampScroll(y, this.lanes.total + 40, this.gridL.h || 1);
    if (next !== this.scrollY) {
      this.scrollY = next;
      this.gridL.dirty = this.contentL.dirty = this.overlayL.dirty = true;
    }
    if (this.els) this.els.headersInner.style.transform = `translate3d(0,${-this.scrollY}px,0)`;
    this.updateScrollbars();
  }

  zoomX(anchorX: number, factor: number): void {
    const next = zoomAt(this.tv, anchorX, factor, MIN_PX, MAX_PX);
    if (next.pxPerTick === this.tv.pxPerTick && next.scrollTick === this.tv.scrollTick) return;
    this.tv = next;
    this.gridL.dirty = this.contentL.dirty = this.overlayL.dirty = this.rulerL.dirty = true;
    this.updateScrollbars();
  }

  private updateScrollbars(): void {
    const vt = viewTicks(this.tv, this.gridL.w || 1);
    this.hbar?.update(this.tv.scrollTick, vt, Math.max(this.contentTicks(), this.tv.scrollTick + vt));
    this.vbar?.update(this.scrollY, this.gridL.h || 1, this.lanes.total + 40);
  }

  private updateCursor(): void {
    const el = this.els?.overlay;
    if (!el) return;
    const tool = usePlaylistView.getState().tool;
    const h = this.hover;
    let c = 'default';
    if (this.drag?.kind === 'pan') c = 'grabbing';
    else if (h?.pointId) c = 'pointer';
    else if (h?.clipId && (h.zone === 'left' || h.zone === 'right') && (tool === 'draw' || tool === 'paint' || tool === 'select')) c = 'ew-resize';
    else if (h?.clipId && (tool === 'draw' || tool === 'paint' || tool === 'select')) c = 'move';
    else if (tool === 'draw' || tool === 'paint') c = 'crosshair';
    else if (tool === 'delete') c = 'not-allowed';
    else if (tool === 'slice') c = 'col-resize';
    else if (tool === 'mute') c = 'pointer';
    if (this.fadeDrag || this.fadeHover) c = 'ew-resize';
    if (el.style.cursor !== c) el.style.cursor = c;
  }

  private laneAtY(y: number): number {
    return laneAt(this.lanes, y + this.scrollY);
  }

  private laneTop(i: number): number {
    return this.lanes.tops[i] - this.scrollY;
  }

  private hitClipAt(x: number, y: number): ClipHit | null {
    const lane = this.laneAtY(y);
    if (lane < 0 || lane >= this.lanes.ids.length) return null;
    const h = hitClip(this.trackIdx.get(this.lanes.ids[lane]), xToTick(this.tv, x), this.tv.pxPerTick, EDGE_PX);
    if (!h) return null;
    const top = this.laneTop(lane);
    const header = this.lanes.heights[lane] - 2 >= 28 && y - top <= CLIP_HEADER_H + 1;
    return { clip: h.clip, zone: h.zone, lane, header };
  }

  private clipBody(lane: number): { top: number; h: number } {
    const hh = this.lanes.heights[lane] - 2;
    const header = hh >= 28 ? CLIP_HEADER_H : 0;
    return { top: this.laneTop(lane) + 1 + header + 1, h: hh - header - 2 };
  }

  private hitAutoPoint(x: number, y: number): { clip: Clip; lane: number; point: AutomationPoint } | null {
    const hit = this.hitClipAt(x, y) ?? this.hitClipAt(x + 4, y) ?? this.hitClipAt(x - 4, y);
    if (!hit || hit.clip.kind !== 'automation' || !this.project) return null;
    const aut = hit.clip.automationId ? this.project.automations[hit.clip.automationId] : undefined;
    if (!aut) return null;
    const body = this.clipBody(hit.lane);
    const pts = automationPointsXY(sortedPoints(aut), hit.clip, this.tv, body.top, body.h);
    const i = nearestPoint(pts, x, y, 7);
    return i >= 0 ? { clip: hit.clip, lane: hit.lane, point: pts[i].p } : null;
  }

  private setPtr(e: PointerEvent | MouseEvent | DragEvent): Ptr {
    const r = this.els!.overlay.getBoundingClientRect();
    this.ptr = { x: e.clientX - r.left, y: e.clientY - r.top, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    return this.ptr;
  }

  private onGridDown(e: PointerEvent): void {
    if (this.drag || !this.project) return;
    const p = this.setPtr(e);
    this.downPt = { x: p.x, y: p.y, armed: false };
    if (this.takes.down(e, p.x, p.y)) {
      this.els!.overlay.setPointerCapture(e.pointerId);
      return;
    }
    const tick = xToTick(this.tv, p.x);
    const lane = this.laneAtY(p.y);
    const tool = usePlaylistView.getState().tool;
    const grid = this.snapGrid();
    this.els!.overlay.setPointerCapture(e.pointerId);

    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, scrollTick: this.tv.scrollTick, scrollY: this.scrollY };
      this.updateCursor();
      return;
    }
    if (e.button === 0 && this.beginFadeDrag(p)) return;
    const ap = tool === 'slice' || tool === 'mute' ? null : this.hitAutoPoint(p.x, p.y);
    const hit = this.hitClipAt(p.x, p.y);

    if (e.button === 2) {
      if (ap) {
        void dispatch('automation.editPoints', { id: ap.clip.automationId, remove: [ap.point.id] }, { label: 'Delete automation point' });
        return;
      }
      this.lastClickTick = p.alt ? Math.round(tick) : snapTo(tick, grid);
      this.drag = { kind: 'erase', ids: new Set(), lastX: p.x, lastY: p.y, menu: { clientX: e.clientX, clientY: e.clientY, downX: p.x, downY: p.y, clipId: hit?.clip.id ?? null, lane } };
      return;
    }
    if (e.button !== 0) return;
    this.lastClickTick = cellStart(tick, grid, p.alt);

    if (tool === 'delete') {
      this.drag = { kind: 'erase', ids: new Set(hit ? [hit.clip.id] : []), lastX: p.x, lastY: p.y };
      this.contentL.dirty = true;
      return;
    }
    if (tool === 'mute') {
      this.drag = { kind: 'mute', ids: new Set(hit ? [hit.clip.id] : []), value: hit ? !hit.clip.mute : null, lastX: p.x, lastY: p.y };
      this.overlayL.dirty = true;
      return;
    }
    if (tool === 'slice') {
      const l = clamp(lane, 0, this.lanes.ids.length - 1);
      this.drag = { kind: 'slice', tick: p.alt ? Math.round(tick) : snapTo(tick, grid), laneA: l, laneB: l };
      this.overlayL.dirty = true;
      return;
    }
    if (ap) {
      this.drag = { kind: 'apoint', clip: ap.clip, lane: ap.lane, autId: ap.clip.automationId!, orig: ap.point, tick: ap.point.tick, value: ap.point.value, downX: p.x, downY: p.y, moved: false };
      this.contentL.dirty = true;
      return;
    }
    if (p.alt && hit?.clip.kind === 'automation' && hit.zone === 'body') {
      const seg = this.segmentAt(hit.clip, tick);
      if (seg) {
        this.drag = { kind: 'atension', clip: hit.clip, autId: hit.clip.automationId!, point: seg.a, dir: seg.b.value >= seg.a.value ? 1 : -1, downY: p.y, tension: seg.a.tension };
        this.contentL.dirty = true;
        return;
      }
    }
    const marqueeMode = tool === 'select' ? !hit || p.ctrl : p.ctrl;
    if (marqueeMode) {
      const additive = p.shift || p.ctrl;
      const base = additive ? new Set(this.selection) : new Set<string>();
      if (!additive) this.selection.clear();
      this.drag = { kind: 'marquee', tickA: tick, yA: p.y + this.scrollY, base };
      this.contentL.dirty = this.overlayL.dirty = true;
      return;
    }
    if (hit) {
      const c = hit.clip;
      if (!this.selection.has(c.id)) {
        if (p.shift && tool === 'select') this.selection.add(c.id);
        else {
          this.selection.clear();
          this.selection.add(c.id);
        }
        this.contentL.dirty = true;
      }
      const ids = [...this.selection];
      const origins = new Map<string, Clip>();
      const laneOf = new Map<string, number>();
      for (const id of ids) {
        const o = this.clip(id);
        if (o) {
          origins.set(id, o);
          laneOf.set(id, this.laneOfClip(o));
        }
      }
      if (hit.zone === 'left' || hit.zone === 'right') {
        const grab = hit.zone === 'right' ? c.start + c.length - tick : c.start - tick;
        this.drag = { kind: 'resize', edge: hit.zone, ids, origins, primary: c, grab, dT: 0 };
      } else {
        let minStart = Infinity;
        let minLane = Infinity;
        let maxLane = 0;
        for (const id of ids) {
          minStart = Math.min(minStart, origins.get(id)?.start ?? Infinity);
          const l = laneOf.get(id) ?? 0;
          minLane = Math.min(minLane, l);
          maxLane = Math.max(maxLane, l);
        }
        this.drag = {
          kind: 'move',
          ids,
          origins,
          laneOf,
          primary: c,
          downTick: tick,
          downLane: hit.lane,
          downX: p.x,
          downY: p.y,
          minStart,
          minLane,
          maxLane,
          dT: 0,
          dL: 0,
          copy: p.shift && tool !== 'select',
          moved: false,
        };
      }
      this.contentL.dirty = this.overlayL.dirty = true;
      return;
    }
    if (lane < 0 || lane >= this.lanes.ids.length) return;
    const patId = this.project.transport.activePatternId;
    const pat = patId ? this.project.patterns[patId] : undefined;
    if (!pat) {
      toast.info('Pick a pattern in the list to paint it on the playlist');
      return;
    }
    if (this.selection.size) {
      this.selection.clear();
      this.contentL.dirty = true;
    }
    const start = cellStart(tick, grid, p.alt);
    const len = patternLength(pat, this.ts);
    if (tool === 'paint') this.drag = { kind: 'paint', lane, start, len, slots: new Set([0]), patternId: pat.id };
    else this.drag = { kind: 'create', lane, origStart: start, start, len, downTick: tick, patternId: pat.id };
    this.overlayL.dirty = true;
  }

  private segmentAt(c: Clip, tick: number): { a: AutomationPoint; b: AutomationPoint } | null {
    const aut = c.automationId ? this.project?.automations[c.automationId] : undefined;
    if (!aut) return null;
    const pts = sortedPoints(aut);
    const rel = tick - c.start + c.offset;
    for (let i = 0; i < pts.length - 1; i++) if (rel >= pts[i].tick && rel < pts[i + 1].tick) return { a: pts[i], b: pts[i + 1] };
    return null;
  }

  private onGridMove(e: PointerEvent): void {
    const p = this.setPtr(e);
    if (!this.drag && !this.fadeDrag && this.takes.move(p.x, p.y, e.altKey)) {
      if (this.hover) {
        this.hover = null;
        this.overlayL.dirty = true;
      }
      return;
    }
    if (this.fadeDrag) {
      this.updateFadeDrag(p);
      return;
    }
    if (this.drag) {
      if (this.drag.kind === 'pan') {
        this.noteUserView();
        this.setScrollTick(this.drag.scrollTick - (e.clientX - this.drag.x) / this.tv.pxPerTick);
        this.setScrollY(this.drag.scrollY - (e.clientY - this.drag.y));
        return;
      }
      this.updateDrag();
      return;
    }
    const tick = xToTick(this.tv, p.x);
    const lane = this.laneAtY(p.y);
    const hit = this.hitClipAt(p.x, p.y);
    const ap = this.hitAutoPoint(p.x, p.y);
    const h = { lane, tick, clipId: hit?.clip.id ?? null, zone: hit?.zone ?? ('' as const), pointId: ap?.point.id ?? null };
    const fh = hit && hit.clip.kind === 'audio' ? hitFadeHandle(hit.clip, this.tv, this.laneTop(hit.lane) + 1, p.x, p.y) : null;
    if (fh !== this.fadeHover) {
      this.fadeHover = fh;
      this.updateCursor();
    }
    const prev = this.hover;
    this.hover = h;
    if (!prev || prev.lane !== h.lane || prev.clipId !== h.clipId || prev.zone !== h.zone || prev.pointId !== h.pointId) {
      this.overlayL.dirty = true;
      if (prev?.pointId !== h.pointId) this.contentL.dirty = true;
      this.updateCursor();
    }
  }

  private updateDrag(): void {
    const d = this.drag;
    const p = this.ptr;
    if (!d || !p || ('committing' in d && d.committing)) return;
    const tick = xToTick(this.tv, p.x);
    const grid = this.snapGrid();
    const nLanes = this.lanes.ids.length;
    switch (d.kind) {
      case 'create': {
        d.start = d.origStart + snapMoveDelta(d.origStart, tick - d.downTick, grid, d.origStart, p.alt);
        d.lane = clamp(this.laneAtY(p.y), 0, nLanes - 1);
        this.overlayL.dirty = true;
        break;
      }
      case 'paint': {
        const slot = Math.floor((tick - d.start) / d.len);
        for (let s = Math.min(slot, 0); s <= Math.max(slot, 0); s++) {
          if (d.start + s * d.len < 0 || Math.abs(s - slot) > 64) continue;
          d.slots.add(s);
        }
        this.overlayL.dirty = true;
        break;
      }
      case 'move': {
        if (!d.moved && (Math.abs(p.x - d.downX) > 3 || Math.abs(p.y - d.downY) > 3)) d.moved = true;
        if (!d.moved) return;
        const dT = snapMoveDelta(d.primary.start, tick - d.downTick, grid, d.minStart, p.alt);
        const lane = this.laneAtY(p.y);
        const dL = clamp(lane - d.downLane, -d.minLane, nLanes - 1 - d.maxLane);
        if (dT !== d.dT || dL !== d.dL) {
          d.dT = dT;
          d.dL = dL;
          this.overlayL.dirty = true;
        }
        break;
      }
      case 'resize': {
        const pr = d.primary;
        const dT =
          d.edge === 'right'
            ? snapResizeEnd(pr.start, tick + d.grab, grid, p.alt) - pr.length
            : snapResizeStart(pr.start + pr.length, tick + d.grab, grid, p.alt).start - pr.start;
        if (dT !== d.dT) {
          d.dT = dT;
          this.overlayL.dirty = true;
        }
        break;
      }
      case 'marquee': {
        const yB = p.y + this.scrollY;
        const y0 = Math.min(d.yA, yB);
        const y1 = Math.max(d.yA, yB);
        const t0 = Math.min(d.tickA, tick);
        const t1 = Math.max(d.tickA, tick);
        this.selection.clear();
        for (const id of d.base) this.selection.add(id);
        const a = clamp(laneAt(this.lanes, y0), 0, nLanes - 1);
        const b = clamp(laneAt(this.lanes, y1), 0, nLanes - 1);
        for (let l = a; l <= b; l++) this.trackIdx.get(this.lanes.ids[l])?.query(t0, t1, (c) => void this.selection.add(c.id));
        this.contentL.dirty = this.overlayL.dirty = true;
        break;
      }
      case 'erase':
      case 'mute': {
        if (d.kind === 'erase' && d.menu) {
          if (Math.hypot(p.x - d.menu.downX, p.y - d.menu.downY) <= RIGHT_DRAG_PX) return;
          d.menu = undefined;
        }
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - d.lastX, p.y - d.lastY) / 4));
        let grew = false;
        for (let i = 1; i <= steps; i++) {
          const h = this.hitClipAt(d.lastX + ((p.x - d.lastX) * i) / steps, d.lastY + ((p.y - d.lastY) * i) / steps);
          if (h && !d.ids.has(h.clip.id)) {
            d.ids.add(h.clip.id);
            if (d.kind === 'mute' && d.value === null) d.value = !h.clip.mute;
            grew = true;
          }
        }
        d.lastX = p.x;
        d.lastY = p.y;
        if (grew) this.contentL.dirty = true;
        this.overlayL.dirty = true;
        break;
      }
      case 'slice':
        d.laneB = clamp(this.laneAtY(p.y), 0, nLanes - 1);
        d.tick = p.alt ? Math.round(tick) : snapTo(tick, grid);
        this.overlayL.dirty = true;
        break;
      case 'apoint': {
        if (!d.moved && (Math.abs(p.x - d.downX) > 2 || Math.abs(p.y - d.downY) > 2)) d.moved = true;
        if (!d.moved) return;
        const rel = tick - d.clip.start + d.clip.offset;
        d.tick = Math.max(0, p.alt ? Math.round(rel) : snapTo(rel, grid));
        const body = this.clipBody(d.lane);
        d.value = Math.round(clamp(1 - (p.y - body.top) / Math.max(1, body.h), 0, 1) * 1000) / 1000;
        this.contentL.dirty = this.overlayL.dirty = true;
        break;
      }
      case 'atension':
        d.tension = Math.round(clamp(d.point.tension - (d.dir * (p.y - d.downY)) / 90, -1, 1) * 100) / 100;
        this.contentL.dirty = true;
        break;
      default:
        break;
    }
  }

  private onGridUp(e: PointerEvent, cancelled = false): void {
    if (this.takes.active) {
      try {
        this.els?.overlay.releasePointerCapture(e.pointerId);
      } catch {
      }
      if (cancelled) this.takes.cancel();
      else this.takes.up();
      return;
    }
    if (this.fadeDrag) {
      void this.endFadeDrag(e, cancelled);
      return;
    }
    const d = this.drag;
    if (!d) return;
    try {
      this.els?.overlay.releasePointerCapture(e.pointerId);
    } catch {
    }
    if (cancelled) {
      this.cancelDrag();
      return;
    }
    this.setPtr(e);
    void this.commit(d);
  }

  private cancelDrag(): void {
    this.drag = null;
    this.contentL.dirty = this.overlayL.dirty = true;
    this.updateCursor();
  }

  private async commit(d: Drag): Promise<void> {
    const finish = () => {
      if (this.drag === d) this.drag = null;
      this.contentL.dirty = this.overlayL.dirty = true;
      this.updateCursor();
    };
    if (d.kind === 'pan' || d.kind === 'marquee') {
      finish();
      return;
    }
    (d as { committing?: boolean }).committing = true;
    const ids = this.lanes.ids;
    switch (d.kind) {
      case 'create':
        await dispatch('playlist.addClip', { kind: 'pattern', trackId: ids[d.lane], start: d.start, patternId: d.patternId });
        break;
      case 'paint': {
        const steps = [...d.slots].sort((a, b) => a - b).map((s) => ({ cmd: 'playlist.addClip', args: { kind: 'pattern', trackId: ids[d.lane], start: d.start + s * d.len, patternId: d.patternId } }));
        await dispatchBatch(steps, { label: `Paint ${steps.length} clip${steps.length === 1 ? '' : 's'}` });
        break;
      }
      case 'move': {
        if (!d.moved) {
          if (d.primary.kind === 'pattern' && d.primary.patternId && d.primary.patternId !== this.project?.transport.activePatternId) {
            await dispatch('patterns.select', { id: d.primary.patternId });
          }
          break;
        }
        if (d.dT === 0 && d.dL === 0) break;
        const lanes = this.lanes.ids;
        if (d.copy) {
          const steps = [...d.origins.values()].map((o) => ({
            cmd: 'playlist.addClip',
            args: {
              kind: o.kind,
              trackId: lanes[(d.laneOf.get(o.id) ?? 0) + d.dL] ?? o.trackId,
              start: o.start + d.dT,
              length: o.length,
              offset: o.offset,
              patternId: o.patternId,
              channelId: o.channelId,
              automationId: o.automationId,
              color: o.color,
            },
          }));
          const r = await dispatchBatch(steps, { label: `Copy ${steps.length} clip${steps.length === 1 ? '' : 's'}` });
          if (r.ok && Array.isArray(r.data)) {
            this.selection.clear();
            for (const x of r.data as Array<{ id: string }>) this.selection.add(x.id);
          }
        } else {
          await dispatch('playlist.updateClips', {
            updates: [...d.origins.values()].map((o) => ({ id: o.id, start: o.start + d.dT, trackId: lanes[(d.laneOf.get(o.id) ?? 0) + d.dL] ?? o.trackId })),
          }, { label: `Move ${d.origins.size} clip${d.origins.size === 1 ? '' : 's'}` });
        }
        break;
      }
      case 'resize':
        if (d.dT !== 0) {
          await dispatch('playlist.updateClips', { updates: [...d.origins.values()].map((o) => ({ id: o.id, ...this.resized(o, d.edge, d.dT) })) }, { label: d.edge === 'right' ? 'Resize clip' : 'Trim clip' });
        }
        break;
      case 'erase':
        if (d.menu) {
          finish();
          this.openRightMenu(d.menu);
          return;
        }
        if (d.ids.size) {
          for (const id of d.ids) this.selection.delete(id);
          await dispatch('playlist.removeClips', { ids: [...d.ids] });
        }
        break;
      case 'mute':
        if (d.ids.size && d.value !== null) {
          await dispatch('playlist.updateClips', { updates: [...d.ids].map((id) => ({ id, mute: d.value! })) }, { label: d.value ? 'Mute clips' : 'Unmute clips' });
        }
        break;
      case 'slice': {
        const steps: Array<{ cmd: string; args: unknown }> = [];
        const a = Math.min(d.laneA, d.laneB);
        const b = Math.max(d.laneA, d.laneB);
        for (let l = a; l <= b; l++) {
          this.trackIdx.get(ids[l])?.query(d.tick, d.tick + 1, (c) => {
            if (d.tick > c.start && d.tick < c.start + c.length) steps.push({ cmd: 'playlist.splitClip', args: { id: c.id, at: Math.round(d.tick) } });
          });
        }
        if (steps.length) await dispatchBatch(steps, { label: steps.length > 1 ? `Split ${steps.length} clips` : 'Split clip' });
        break;
      }
      case 'apoint':
        if (d.moved) await dispatch('automation.editPoints', { id: d.autId, update: [{ id: d.orig.id, tick: d.tick, value: d.value }] }, { label: 'Move automation point' });
        break;
      case 'atension':
        if (d.tension !== d.point.tension) await dispatch('automation.editPoints', { id: d.autId, update: [{ id: d.point.id, tension: d.tension }] }, { label: 'Automation curve' });
        break;
    }
    finish();
  }

  private resized(o: Clip, edge: 'left' | 'right', dT: number): { start: number; length: number; offset: number } {
    if (edge === 'right') return { start: o.start, length: Math.max(1, o.length + dT), offset: o.offset };
    const d = clamp(dT, -Math.min(o.offset, o.start), o.length - 1);
    return { start: o.start + d, length: o.length - d, offset: o.offset + d };
  }

  private onDblClick(e: MouseEvent): void {
    const p = this.setPtr(e);
    const hit = this.hitClipAt(p.x, p.y);
    if (!hit || !this.project) return;
    const c = hit.clip;
    if (c.kind === 'pattern' && c.patternId) {
      void dispatch('patterns.select', { id: c.patternId });
      openPanel('pianoRoll');
    } else if (c.kind === 'automation' && c.automationId && !this.hitAutoPoint(p.x, p.y)) {
      const body = this.clipBody(hit.lane);
      const rel = xToTick(this.tv, p.x) - c.start + c.offset;
      const tick = Math.max(0, e.altKey ? Math.round(rel) : snapTo(rel, this.snapGrid()));
      const value = Math.round(clamp(1 - (p.y - body.top) / Math.max(1, body.h), 0, 1) * 1000) / 1000;
      void dispatch('automation.editPoints', { id: c.automationId, add: [{ tick, value, tension: 0 }] }, { label: 'Add automation point' });
    }
  }

  private dropKind(e: DragEvent): 'sample' | 'pattern' | 'files' | null {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes(SAMPLE_MIME)) return 'sample';
    if (types.includes(PATTERN_MIME)) return 'pattern';
    if (types.includes('Files')) return 'files';
    return null;
  }

  private onDragOver(e: DragEvent): void {
    const kind = this.dropKind(e);
    if (!kind) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const p = this.setPtr(e);
    const lane = clamp(this.laneAtY(p.y), 0, this.lanes.ids.length - 1);
    const tick = cellStart(xToTick(this.tv, p.x), this.snapGrid(), e.altKey);
    const bar = ticksPerBar(this.ts);
    const prev = this.dropPreview;
    if (!prev || prev.lane !== lane || prev.tick !== tick) {
      this.dropPreview = { lane, tick, len: bar, label: kind === 'pattern' ? 'Drop pattern' : kind === 'files' ? 'Drop audio file' : 'Drop audio' };
      this.overlayL.dirty = true;
    }
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const kind = this.dropKind(e);
    const drop = this.dropPreview;
    this.dropPreview = null;
    this.overlayL.dirty = true;
    if (!kind || !drop || !e.dataTransfer) return;
    e.preventDefault();
    const trackId = this.lanes.ids[drop.lane];
    if (!trackId) return;
    if (kind === 'pattern') {
      const patternId = e.dataTransfer.getData(PATTERN_MIME);
      if (patternId) await dispatch('playlist.addClip', { kind: 'pattern', trackId, start: drop.tick, patternId });
      return;
    }
    if (kind === 'files') {
      const files = [...e.dataTransfer.files].filter((f) => AUDIO_EXT.test(f.name));
      if (!files.length) {
        toast.warn('Drop audio files (wav, mp3, flac, ogg, aiff) onto the playlist');
        return;
      }
      let lane = drop.lane;
      for (const f of files) {
        let path = '';
        try {
          path = window.krypt.app.pathForFile(f);
        } catch {
          path = '';
        }
        if (!path) {
          toast.error(`Couldn't get the location of "${f.name}" — drag it from the Browser panel instead`);
          continue;
        }
        await this.placeAudio(path, f.name, this.lanes.ids[Math.min(lane, this.lanes.ids.length - 1)], drop.tick);
        lane++;
      }
      return;
    }
    const raw = e.dataTransfer.getData(SAMPLE_MIME);
    let path = raw;
    let name: string | undefined;
    try {
      const j = JSON.parse(raw) as { path?: string; name?: string };
      if (j && typeof j.path === 'string') {
        path = j.path;
        name = j.name;
      }
    } catch {
    }
    if (!path) {
      toast.error('Nothing to drop: the sample path is missing');
      return;
    }
    await this.placeAudio(path, name, trackId, drop.tick);
  }

  private async placeAudio(path: string, name: string | undefined, trackId: string, start: number): Promise<void> {
    let info: { frames?: number; sampleRate?: number; channels?: number } = {};
    try {
      const r = await window.krypt.engine.sampleInfo(path);
      if (r.ok && r.data) info = { frames: r.data.frames, sampleRate: r.data.sampleRate, channels: r.data.channels };
      else toast.warn(`Couldn't read "${path.split(/[\\/:]/).pop()}" (${r.message ?? 'engine unavailable'}) — placed with a default length`);
    } catch {
      toast.warn('Audio engine unavailable — placed the clip with a default length');
    }
    const added = await dispatch<{ channelId: string }>('playlist.addAudio', { path, name: name?.replace(/\.[a-z0-9]+$/i, ''), trackId, start, ...info });
    if (added.ok && added.data?.channelId) await followTempoAfterDrop(path, name, added.data.channelId);
  }

  private rulerTick(e: PointerEvent | MouseEvent, mode: 'round' | 'floor' = 'round'): number {
    const r = this.els!.ruler.getBoundingClientRect();
    const raw = xToTick(this.tv, e.clientX - r.left);
    return Math.max(0, e.altKey ? Math.round(raw) : snapTo(raw, this.snapGrid(), mode));
  }

  private onRulerDown(e: PointerEvent): void {
    const p = this.project;
    if (!p || !this.els) return;
    const r = this.els.ruler.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (e.button === 2) {
      const mk = this.markerAt(x, y);
      if (mk) {
        this.openMarkerMenu(e, mk);
        return;
      }
      this.onRulerMenu?.(e.clientX, e.clientY, this.rulerTick(e, 'floor'));
      return;
    }
    if (e.button !== 0) return;
    this.els.ruler.setPointerCapture(e.pointerId);
    const grabbed = this.markerAt(x, y);
    if (grabbed) {
      this.markerDrag = { id: grabbed.id, orig: grabbed.tick, tick: grabbed.tick, downX: e.clientX, moved: false };
      return;
    }
    const loop = p.transport.loop;
    if (loop.end > loop.start) {
      const xs = tickToX(this.tv, loop.start);
      const xe = tickToX(this.tv, loop.end);
      if (Math.abs(x - xs) <= 5 || Math.abs(x - xe) <= 5) {
        this.rulerDrag = { kind: 'edge', edge: Math.abs(x - xs) <= Math.abs(x - xe) ? 'start' : 'end', start: loop.start, end: loop.end };
        return;
      }
    }
    this.rulerDrag = { kind: 'press', downX: e.clientX, tick: this.rulerTick(e, 'floor'), anchor: this.rulerTick(e) };
  }

  private onRulerMove(e: PointerEvent): void {
    if (this.markerDrag) {
      this.updateMarkerDrag(e);
      return;
    }
    const d = this.rulerDrag;
    if (!d) {
      const p = this.project;
      if (!p || !this.els) return;
      const r = this.els.ruler.getBoundingClientRect();
      const x = e.clientX - r.left;
      const loop = p.transport.loop;
      const near = loop.end > loop.start && (Math.abs(x - tickToX(this.tv, loop.start)) <= 5 || Math.abs(x - tickToX(this.tv, loop.end)) <= 5);
      const c = near ? 'ew-resize' : this.markerAt(x, e.clientY - r.top) ? 'grab' : 'pointer';
      if (this.els.ruler.style.cursor !== c) this.els.ruler.style.cursor = c;
      return;
    }
    const t = this.rulerTick(e);
    if (d.kind === 'press') {
      if (Math.abs(e.clientX - d.downX) > 4) this.rulerDrag = { kind: 'loop', a: d.anchor, b: t };
    } else if (d.kind === 'loop') d.b = t;
    else if (d.edge === 'start') d.start = t;
    else d.end = t;
    this.rulerL.dirty = true;
  }

  private onRulerUp(): void {
    if (this.markerDrag) {
      this.endMarkerDrag();
      return;
    }
    const d = this.rulerDrag;
    this.rulerDrag = null;
    this.rulerL.dirty = true;
    if (!d) return;
    if (d.kind === 'press') {
      this.localPlayhead = d.tick;
      locateSim(d.tick);
      void window.krypt.engine.locate(d.tick).catch(() => undefined);
      return;
    }
    const [s, en] = d.kind === 'loop' ? [Math.min(d.a, d.b), Math.max(d.a, d.b)] : [Math.min(d.start, d.end), Math.max(d.start, d.end)];
    if (en - s >= 1) void dispatch('transport.set', { loop: { enabled: true, start: s, end: en } }, { label: 'Set loop region' });
  }

  private onRulerDbl(e: MouseEvent): void {
    const p = this.project;
    if (!p) return;
    const rr = this.els?.ruler.getBoundingClientRect();
    const onMarker = rr ? this.markerAt(e.clientX - rr.left, e.clientY - rr.top) : null;
    if (onMarker) {
      this.renameMarkerInline(onMarker);
      return;
    }
    const n = Object.keys(p.playlist.markers).length + 1;
    void dispatch('playlist.addMarker', { tick: this.rulerTick(e as PointerEvent, 'floor'), name: `Marker ${n}` });
  }

  private rulerLoop(): { enabled: boolean; start: number; end: number } | null {
    const d = this.rulerDrag;
    const loop = this.project?.transport.loop ?? null;
    if (d?.kind === 'loop') return { enabled: true, start: Math.min(d.a, d.b), end: Math.max(d.a, d.b) };
    if (d?.kind === 'edge') return { enabled: true, start: Math.min(d.start, d.end), end: Math.max(d.start, d.end) };
    return loop;
  }

  beginTrackResize(trackId: string, e: PointerEvent, handle: HTMLElement): void {
    const p = this.project;
    const t = p?.playlist.tracks[trackId];
    if (!t || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const scale = this.laneScale;
    const startY = e.clientY;
    const startH = Math.round(t.height * scale);
    const row = this.els?.headersInner.querySelector<HTMLElement>(`[data-track-id="${CSS.escape(trackId)}"]`);
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = clamp(startH + ev.clientY - startY, Math.max(16, 16 * scale), 400 * scale);
      this.heightOverride.set(trackId, h);
      if (row) row.style.height = `${h}px`;
      this.rebuildLanes();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      const height = clamp(Math.round(h / scale), 16, 400);
      void dispatch('playlist.setTrack', { id: trackId, height }, { label: 'Resize track' }).finally(() => {
        this.heightOverride.delete(trackId);
        if (row) row.style.height = '';
        this.rebuildLanes();
      });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.els) return;
    const target = e.target as HTMLElement | null;
    if (target && !this.els.body.contains(target)) return;
    const r = this.els.gridHost.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;
    e.preventDefault();
    this.noteUserView();
    if (e.ctrlKey || e.metaKey) {
      if (e.shiftKey) {
        const v = usePlaylistView.getState();
        v.set({ laneScale: clamp(v.laneScale * wheelZoomFactor(dy), 0.5, 3) });
      } else this.zoomX(clamp(e.clientX - r.left, 0, r.width), wheelZoomFactor(dy));
      return;
    }
    if (e.shiftKey) {
      this.setScrollTick(this.tv.scrollTick + (dy || dx) / this.tv.pxPerTick);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) this.setScrollTick(this.tv.scrollTick + dx / this.tv.pxPerTick);
    else this.setScrollY(this.scrollY + dy);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || isTypingTarget(e.target)) return;
    const tool = toolForKey(e, PL_TOOLS);
    if (tool) {
      usePlaylistView.getState().set({ tool });
      this.handled(e);
      return;
    }
    const mod = isMod(e);
    const k = e.key.toLowerCase();
    if (mod && k === 'a') this.selectAll();
    else if (mod && k === 'd') this.deselect();
    else if (mod && k === 'b') void this.duplicate();
    else if (mod && k === 'c') this.copy();
    else if (mod && k === 'x') void this.cut();
    else if (mod && k === 'v') void this.paste();
    else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) void this.deleteSelected();
    else if (e.key === 'Escape') {
      if (this.drag) this.cancelDrag();
      else this.deselect();
    } else return;
    this.handled(e);
  }

  private handled(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
  }

  selectAll(): void {
    this.selection.clear();
    for (const id of Object.keys(this.clipsRec ?? {})) this.selection.add(id);
    this.contentL.dirty = true;
  }

  deselect(): void {
    if (!this.selection.size) return;
    this.selection.clear();
    this.contentL.dirty = true;
  }

  async deleteSelected(): Promise<void> {
    if (!this.selection.size) return;
    const ids = [...this.selection];
    this.selection.clear();
    await dispatch('playlist.removeClips', { ids });
  }

  async duplicate(ids = [...this.selection]): Promise<void> {
    const clips = ids.map((id) => this.clip(id)).filter((c): c is Clip => !!c);
    if (!clips.length) {
      toast.info('Select clips to duplicate');
      return;
    }
    const t0 = Math.min(...clips.map((c) => c.start));
    const t1 = Math.max(...clips.map((c) => c.start + c.length));
    const g = this.snapGrid();
    const shift = duplicateShift(t0, t1, g > 1 ? g : ticksPerBar(this.ts));
    const r = await dispatch<{ ids: string[] }>('playlist.duplicateClips', { ids: clips.map((c) => c.id), shift });
    if (r.ok && r.data) {
      this.selection.clear();
      for (const id of r.data.ids) this.selection.add(id);
      this.contentL.dirty = true;
    }
  }

  copy(): void {
    const clips = [...this.selection].map((id) => this.clip(id)).filter((c): c is Clip => !!c);
    if (!clips.length) {
      toast.info('Select clips to copy');
      return;
    }
    setClipClipboard(clips);
    toast.info(`Copied ${clips.length} clip${clips.length === 1 ? '' : 's'}`);
  }

  async cut(): Promise<void> {
    const clips = [...this.selection].map((id) => this.clip(id)).filter((c): c is Clip => !!c);
    if (!clips.length) {
      toast.info('Select clips to cut');
      return;
    }
    setClipClipboard(clips);
    this.selection.clear();
    const r = await dispatch('playlist.removeClips', { ids: clips.map((c) => c.id) }, { label: `Cut ${clips.length} clip${clips.length === 1 ? '' : 's'}` });
    if (r.ok) toast.info(`Cut ${clips.length} clip${clips.length === 1 ? '' : 's'}: right-click › Paste (or ${MOD_KEY}+V) puts them back`);
  }

  hasClipboard(): boolean {
    return !!getClipClipboard();
  }

  async paste(trackId?: string | null): Promise<void> {
    const cb = getClipClipboard();
    if (!cb) {
      toast.info('Nothing to paste: copy or cut some clips first');
      return;
    }
    const at = this.lastClickTick ?? this.songPlayhead() ?? cb.minStart;
    let clips = cb.clips;
    const to = trackId ? this.lanes.ids.indexOf(trackId) : -1;
    if (to >= 0) {
      const lanes = cb.clips.map((c) => this.lanes.ids.indexOf(c.trackId));
      const known = lanes.filter((l) => l >= 0);
      const top = known.length ? Math.min(...known) : 0;
      clips = cb.clips.map((c, i) => ({ ...c, trackId: this.lanes.ids[clamp(to + (lanes[i] < 0 ? 0 : lanes[i] - top), 0, this.lanes.ids.length - 1)] }));
    }
    const n = clips.length;
    const r = await dispatch<{ ids: string[] }>('playlist.pasteClips', { clips, shift: Math.round(at - cb.minStart) }, { label: `Paste ${n} clip${n === 1 ? '' : 's'}` });
    if (r.ok && r.data) {
      this.selection.clear();
      for (const id of r.data.ids) this.selection.add(id);
      this.contentL.dirty = true;
    }
  }

  async toggleMute(ids = [...this.selection]): Promise<void> {
    const clips = ids.map((id) => this.clip(id)).filter((c): c is Clip => !!c);
    if (!clips.length) return;
    const mute = !clips.every((c) => c.mute);
    await dispatch('playlist.updateClips', { updates: clips.map((c) => ({ id: c.id, mute })) }, { label: mute ? 'Mute clips' : 'Unmute clips' });
  }

  async makeUnique(clipId: string): Promise<void> {
    const r = await dispatch<{ patternId: string }>('playlist.makeUnique', { clipId });
    if (r.ok) toast.success('Clip now has its own pattern copy');
  }

  selectedClips(): Clip[] {
    return [...this.selection]
      .map((id) => this.clip(id))
      .filter((c): c is Clip => !!c)
      .sort((a, b) => a.start - b.start);
  }

  private reselect(ids: string[]): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.contentL.dirty = true;
  }

  async splitByChannel(ids = [...this.selection]): Promise<void> {
    const pats = ids.map((id) => this.clip(id)).filter((c): c is Clip => c?.kind === 'pattern');
    if (!pats.length) {
      toast.info('Select pattern clips to split by channel');
      return;
    }
    const r = await dispatch<{ patternIds: string[]; clipIds: string[] }>('playlist.splitByChannel', { clipIds: pats.map((c) => c.id) });
    if (r.ok && r.data) {
      this.reselect(r.data.clipIds);
      const n = r.data.patternIds.length;
      toast.success(`Split into ${n} channel pattern${n === 1 ? '' : 's'} (one undo)`);
    }
  }

  selectAllOfPattern(clipId: string): void {
    const c = this.clip(clipId);
    if (c?.kind !== 'pattern' || !c.patternId) return;
    const ids = Object.values(this.clipsRec ?? {})
      .filter((o) => o.kind === 'pattern' && o.patternId === c.patternId)
      .map((o) => o.id);
    this.reselect(ids);
    const name = this.project?.patterns[c.patternId]?.name ?? 'this pattern';
    flashHint(`Selected ${ids.length} clip${ids.length === 1 ? '' : 's'} of ${name}`, 'ok');
  }

  async consolidateSelection(): Promise<void> {
    const pats = this.selectedClips().filter((c) => c.kind === 'pattern');
    if (pats.length < 2) {
      toast.info('Select two or more pattern clips to consolidate');
      return;
    }
    const r = await dispatch<{ patternId: string; clipId: string }>('playlist.consolidate', { clipIds: pats.map((c) => c.id) });
    if (r.ok && r.data) {
      this.reselect([r.data.clipId]);
      toast.success(`Consolidated ${pats.length} clips into ${getProject()?.patterns[r.data.patternId]?.name ?? 'a new pattern'}`);
    }
  }

  async cloneSelection(ids = [...this.selection]): Promise<void> {
    const clips = ids.map((id) => this.clip(id)).filter((c): c is Clip => !!c);
    if (!clips.length) {
      toast.info('Select clips to clone');
      return;
    }
    const t0 = Math.min(...clips.map((c) => c.start));
    const t1 = Math.max(...clips.map((c) => c.start + c.length));
    const g = this.snapGrid();
    const shift = duplicateShift(t0, t1, g > 1 ? g : ticksPerBar(this.ts));
    const r = await dispatch<{ ids: string[]; patternIds: string[] }>('playlist.cloneClips', { ids: clips.map((c) => c.id), shift });
    if (r.ok && r.data) {
      this.reselect(r.data.ids);
      const n = r.data.patternIds.length;
      toast.success(`Cloned ${clips.length} clip${clips.length === 1 ? '' : 's'}${n ? ` · ${n} new pattern${n === 1 ? '' : 's'}` : ''}`);
    }
  }

  loopRegion(): { enabled: boolean; start: number; end: number } | null {
    const loop = this.project?.transport.loop;
    return loop && loop.end > loop.start ? loop : null;
  }

  async toggleLoop(): Promise<void> {
    const loop = this.loopRegion();
    if (!loop) {
      toast.info('Drag on the ruler to make a loop region first');
      return;
    }
    const r = await dispatch('transport.set', { loop: { enabled: !loop.enabled } }, { label: loop.enabled ? 'Loop off' : 'Loop on' });
    if (r.ok) flashHint(loop.enabled ? 'Loop off' : 'Loop on', 'ok');
  }

  async insertTime(at: number, length: number): Promise<void> {
    if (length < 1) return;
    const r = await dispatch<{ moved: number; split: number }>('playlist.insertTime', { at: Math.round(at), length: Math.round(length) });
    if (r.ok && r.data) {
      const { moved, split } = r.data;
      flashHint(`Inserted time: ${moved} clip${moved === 1 ? '' : 's'} moved${split ? `, ${split} split` : ''}`, 'ok');
    }
  }

  async deleteTime(start: number, end: number): Promise<void> {
    const r = await dispatch<{ removed: number; trimmed: number; moved: number }>('playlist.deleteTime', { start: Math.round(start), end: Math.round(end) });
    if (r.ok && r.data) {
      const { removed, trimmed, moved } = r.data;
      flashHint(`Deleted time: ${removed} removed, ${trimmed} trimmed, ${moved} moved`, 'ok');
    }
  }

  async addMarker(tick: number): Promise<void> {
    const p = this.project;
    if (!p) return;
    const n = Object.keys(p.playlist.markers).length + 1;
    const r = await dispatch('playlist.addMarker', { tick: Math.max(0, Math.round(tick)), name: `Marker ${n}` });
    if (r.ok) flashHint(`Added Marker ${n}`, 'ok');
  }

  private beginFadeDrag(p: Ptr): boolean {
    const tool = usePlaylistView.getState().tool;
    if (tool !== 'draw' && tool !== 'paint' && tool !== 'select') return false;
    const hit = this.hitClipAt(p.x, p.y) ?? this.hitClipAt(p.x - 4, p.y) ?? this.hitClipAt(p.x + 4, p.y);
    if (!hit || hit.clip.kind !== 'audio') return false;
    const which = hitFadeHandle(hit.clip, this.tv, this.laneTop(hit.lane) + 1, p.x, p.y);
    if (!which) return false;
    const c = hit.clip;
    this.fadeDrag = { clipId: c.id, which, orig: c, len: (which === 'in' ? c.fadeIn : c.fadeOut) ?? 0, crossfade: p.alt && which === 'in' && !!this.project && !!previousTouching(this.project, c), downX: p.x, moved: false };
    this.updateCursor();
    this.contentL.dirty = this.overlayL.dirty = true;
    return true;
  }

  private updateFadeDrag(p: Ptr): void {
    const d = this.fadeDrag;
    if (!d || d.committing) return;
    if (!d.moved && Math.abs(p.x - d.downX) > 2) d.moved = true;
    if (!d.moved) return;
    const tick = xToTick(this.tv, p.x);
    if (d.crossfade) d.len = Math.max(1, Math.round(Math.abs(tick - d.orig.start)));
    else {
      const g = this.snapGrid();
      d.len = fadeLenAt(d.orig, d.which, p.alt || g <= 1 ? tick : snapTo(tick, g));
    }
    this.contentL.dirty = this.overlayL.dirty = true;
  }

  private async endFadeDrag(e: PointerEvent, cancelled: boolean): Promise<void> {
    const d = this.fadeDrag;
    if (!d) return;
    try {
      this.els?.overlay.releasePointerCapture(e.pointerId);
    } catch {
    }
    const finish = () => {
      if (this.fadeDrag === d) this.fadeDrag = null;
      this.contentL.dirty = this.overlayL.dirty = true;
      this.updateCursor();
    };
    if (cancelled || !d.moved || d.committing) {
      finish();
      return;
    }
    d.committing = true;
    if (d.crossfade) await this.crossfadeWithPrevious(d.clipId, d.len);
    else {
      const was = (d.which === 'in' ? d.orig.fadeIn : d.orig.fadeOut) ?? 0;
      if (d.len !== was) {
        const r = await dispatch('playlist.setFades', { updates: [d.which === 'in' ? { id: d.clipId, fadeIn: d.len } : { id: d.clipId, fadeOut: d.len }] }, { label: d.which === 'in' ? 'Fade in' : 'Fade out' });
        if (r.ok) flashHint(`${d.which === 'in' ? 'Fade in' : 'Fade out'}: ${fadeLabel(d.len, ticksPerBeat(this.ts))}`, 'ok');
      }
    }
    finish();
  }

  private fadeShown(c: Clip): Clip {
    const d = this.fadeDrag;
    return d && d.moved && !d.crossfade && d.clipId === c.id ? withFade(c, d.which, d.len) : c;
  }

  private paintFadeDragLabel(ctx: CanvasRenderingContext2D, h: number, dpr: number): void {
    const d = this.fadeDrag;
    const pt = this.ptr;
    if (!d?.moved || !pt) return;
    const text = `${d.crossfade ? 'Crossfade' : d.which === 'in' ? 'Fade in' : 'Fade out'} ${fadeLabel(d.len, ticksPerBeat(this.ts))}`;
    if (d.crossfade) this.guide(ctx, tickToX(this.tv, d.orig.start + d.len), h, dpr);
    ctx.font = `10px ${'"JetBrains Mono", monospace'}`;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, pt.x + 10, pt.y - 6);
  }

  async crossfadeWithPrevious(clipId: string, length?: number): Promise<void> {
    const r = await dispatch<{ kind: CrossfadeKind; length: number }>('playlist.crossfade', { id: clipId, length: length ? Math.max(1, Math.round(length)) : undefined });
    if (r.ok && r.data) flashHint(`Crossfade ${fadeLabel(r.data.length, ticksPerBeat(this.ts))}${r.data.kind === 'dip' ? ': no audio past the cut, so a short dip' : ''}`, 'ok');
  }

  async clearFades(ids: string[]): Promise<void> {
    const clips = ids.map((id) => this.clip(id)).filter((c): c is Clip => c?.kind === 'audio' && !!((c.fadeIn ?? 0) || (c.fadeOut ?? 0)));
    if (!clips.length) {
      toast.info('No fades to remove');
      return;
    }
    const r = await dispatch('playlist.setFades', { updates: clips.map((c) => ({ id: c.id, fadeIn: 0, fadeOut: 0 })) }, { label: 'Remove fades' });
    if (r.ok) flashHint(`Removed fades from ${clips.length} clip${clips.length === 1 ? '' : 's'}`, 'ok');
  }

  private markerAt(x: number, y: number): Marker | null {
    const p = this.project;
    return p ? hitMarker(Object.values(p.playlist.markers), this.tv, x, y, markerLabelWidth) : null;
  }

  private updateMarkerDrag(e: PointerEvent): void {
    const d = this.markerDrag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.downX) > 3) d.moved = true;
    if (!d.moved) return;
    d.tick = this.rulerTick(e);
    if (this.els && this.els.ruler.style.cursor !== 'grabbing') this.els.ruler.style.cursor = 'grabbing';
    this.rulerL.dirty = true;
  }

  private endMarkerDrag(): void {
    const d = this.markerDrag;
    this.markerDrag = null;
    this.rulerL.dirty = true;
    const m = d ? this.project?.playlist.markers[d.id] : undefined;
    if (!d || !m) return;
    if (!d.moved) this.locateTo(m.tick);
    else if (d.tick !== d.orig) void moveMarker(m, d.tick, this.ts);
  }

  private openMarkerMenu(e: PointerEvent, m: Marker): void {
    const p = this.project;
    if (!p) return;
    openMenu(e, markerMenuItems(m, { markers: p.playlist.markers, songEnd: this.songEnd, barTicks: ticksPerBar(this.ts), ts: this.ts, rename: () => this.renameMarkerInline(m), locate: (t) => this.locateTo(t) }));
  }

  private renameMarkerInline(m: Marker): void {
    if (this.els) editMarkerInline(this.els.rulerHost, m, tickToX(this.tv, m.tick));
  }

  locateTo(tick: number): void {
    this.localPlayhead = tick;
    locateSim(tick);
    void window.krypt.engine.locate(tick).catch(() => undefined);
  }

  get timeSig(): TimeSig {
    return this.ts;
  }

  async splitAtCursor(clipId: string): Promise<void> {
    const c = this.clip(clipId);
    const at = this.lastClickTick;
    if (!c || at === null || at <= c.start || at >= c.start + c.length) {
      toast.info('Click inside the clip where it should be split, or use the Slice tool (C)');
      return;
    }
    await dispatch('playlist.splitClip', { id: clipId, at: Math.round(at) });
  }

  openInPianoRoll(clipId: string): void {
    const c = this.clip(clipId);
    if (c?.kind !== 'pattern' || !c.patternId) return;
    void dispatch('patterns.select', { id: c.patternId });
    openPanel('pianoRoll');
  }

  private openRightMenu(m: RightPress): void {
    const c = m.clipId ? this.clip(m.clipId) : undefined;
    if (c) {
      if (!this.selection.has(c.id)) {
        this.selection.clear();
        this.selection.add(c.id);
        this.contentL.dirty = true;
      }
      this.onMenu?.(m.clientX, m.clientY, c.id);
      return;
    }
    const trackId = m.lane >= 0 && m.lane < this.lanes.ids.length ? this.lanes.ids[m.lane] : null;
    this.onEmptyMenu?.(m.clientX, m.clientY, trackId, this.lastClickTick ?? 0);
  }

  async placePattern(trackId: string, tick: number, patternId: string): Promise<void> {
    await dispatch('playlist.addClip', { kind: 'pattern', trackId, start: Math.max(0, Math.round(tick)), patternId });
  }

  clipById(id: string): Clip | undefined {
    return this.clip(id);
  }

  private songPlayhead(): number | null {
    const f = telemetry.frame;
    if (!f) {
      if (playState.playing() && this.project?.transport.mode === 'song') return playState.tick();
      return this.localPlayhead;
    }
    return f.mode === 'song' ? telemetry.playheadTick() : null;
  }

  private noteUserView(): void {
    this.userViewAt = performance.now();
  }

  private followPlayhead(now: number): void {
    if (!usePlaylistView.getState().follow || this.drag || this.rulerDrag || now - this.userViewAt < 2000) return;
    if (!playState.playing()) return;
    const t = this.songPlayhead();
    const w = this.gridL.w;
    if (t === null || w <= 0) return;
    const x = tickToX(this.tv, t);
    if (x >= 0 && x <= w - 16) return;
    this.setScrollTick(Math.max(0, t - viewTicks(this.tv, w) * 0.04), true);
  }

  private updatePlayheads(): void {
    const els = this.els;
    if (!els) return;
    const t = this.songPlayhead();
    const x = t === null ? -1 : tickToX(this.tv, t);
    const visible = t !== null && x >= 0 && x <= this.gridL.w;
    const tx = `translate3d(${px(x, this.dpr)}px,0,0)`;
    for (const el of els.playheads) {
      const disp = visible ? '' : 'none';
      if (el.style.display !== disp) el.style.display = disp;
      if (visible && el.style.transform !== tx) el.style.transform = tx;
    }
  }

  private frame(now: number): void {
    if (!this.els) return;
    const dpr = layerDpr(this.els.overlay);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      for (const l of [this.gridL, this.contentL, this.overlayL, this.rulerL]) l.resize(l.w, l.h);
    }
    this.autoScroll();
    this.followPlayhead(now);
    const glowing = this.glow.size > 0 && this.glow.active(now);
    if (glowing || this.glowWasActive) this.contentL.dirty = true;
    this.glowWasActive = glowing;
    if (this.gridL.dirty) this.paintGrid();
    if (this.contentL.dirty) this.paintContent(now);
    if (this.overlayL.dirty) this.paintOverlay();
    if (this.rulerL.dirty) this.paintRulerLayer();
    this.updatePlayheads();
  }

  invalidateContent(): void {
    this.contentL.dirty = true;
  }

  private autoScroll(): void {
    const d = this.drag;
    const p = this.ptr;
    const o = this.downPt;
    if (o && !o.armed && Math.hypot((p?.x ?? o.x) - o.x, (p?.y ?? o.y) - o.y) >= 6) o.armed = true;
    if (!o?.armed) return;
    if (!d || !p || d.kind === 'pan' || ('committing' in d && d.committing)) return;
    const sx = edgeScrollStep(p.x, 0, this.gridL.w);
    const sy = d.kind === 'paint' || d.kind === 'atension' ? 0 : edgeScrollStep(p.y, 0, this.gridL.h);
    if (!sx && !sy) return;
    const before = this.tv.scrollTick + this.scrollY;
    if (sx) this.setScrollTick(this.tv.scrollTick + sx / this.tv.pxPerTick, sx > 0);
    if (sy) this.setScrollY(this.scrollY + sy);
    if (this.tv.scrollTick + this.scrollY !== before) this.updateDrag();
  }

  private paintGrid(): void {
    const ctx = this.gridL.begin();
    const p = this.project;
    if (!ctx || !p) return;
    const { w, h, dpr } = this.gridL;
    ctx.fillStyle = C.gridBg;
    ctx.fillRect(0, 0, w, h);
    const [a, b] = visibleLanes(this.lanes, this.scrollY, h);
    for (let i = a; i <= b; i++) {
      const t = p.playlist.tracks[this.lanes.ids[i]];
      const y = this.laneTop(i);
      const lh = this.lanes.heights[i];
      ctx.fillStyle = i % 2 ? '#0D0D15' : '#0B0B12';
      ctx.fillRect(0, y, w, lh);
      if (t?.mute || (this.anySolo && !t?.solo)) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, y, w, lh);
      }
      ctx.fillStyle = C.rowLine;
      hline(ctx, y + lh - 1 / dpr, 0, w, dpr);
    }
    const end = this.lanes.total - this.scrollY;
    if (end < h) {
      ctx.fillStyle = C.void;
      ctx.fillRect(0, end, w, h - end);
    }
    paintTimeGrid(ctx, this.tv, w, Math.min(h, end), this.ts, dpr, { snapGrid: this.snapGrid() });
    const loop = p.transport.loop;
    if (loop.enabled && loop.end > loop.start) {
      const x0 = tickToX(this.tv, loop.start);
      const x1 = tickToX(this.tv, loop.end);
      ctx.fillStyle = 'rgba(99,102,241,0.05)';
      ctx.fillRect(x0, 0, x1 - x0, Math.min(h, end));
    }
  }

  private hiddenIds(): Set<string> | null {
    const d = this.drag;
    if (!d) return null;
    if (d.kind === 'move' && d.moved && !d.copy) return new Set(d.ids);
    if (d.kind === 'resize') return new Set(d.ids);
    if (d.kind === 'erase') return d.ids;
    return null;
  }

  private autoOverride(): AutoOverride | null {
    const d = this.drag;
    const p = this.project;
    if (!d || !p) return null;
    if (d.kind === 'apoint' || d.kind === 'atension') {
      const aut = p.automations[d.autId];
      if (!aut) return null;
      const pts = sortedPoints(aut).map((q) => {
        if (d.kind === 'apoint' && q.id === d.orig.id) return { ...q, tick: d.tick, value: d.value };
        if (d.kind === 'atension' && q.id === d.point.id) return { ...q, tension: d.tension };
        return q;
      });
      pts.sort((x, y) => x.tick - y.tick || x.id.localeCompare(y.id));
      return { autId: d.autId, points: pts, activePointId: d.kind === 'apoint' ? d.orig.id : null };
    }
    return null;
  }

  private paintContent(now: number): void {
    const ctx = this.contentL.begin();
    const p = this.project;
    if (!ctx || !p) return;
    const { w, h, dpr } = this.contentL;
    const hidden = this.hiddenIds();
    const auto = this.autoOverride();
    const muteIds = this.drag?.kind === 'mute' ? this.drag : null;
    const t0 = this.tv.scrollTick;
    const t1 = xToTick(this.tv, w);
    const [a, b] = visibleLanes(this.lanes, this.scrollY, h);
    const base = { dpr, ts: p.transport.timeSig, bpm: p.transport.bpm, auto, hoverPointId: this.hover?.pointId ?? null };
    for (let i = a; i <= b; i++) {
      const trackId = this.lanes.ids[i];
      const idx = this.trackIdx.get(trackId);
      if (!idx) continue;
      const t = p.playlist.tracks[trackId];
      const trackMuted = !!t?.mute || (this.anySolo && !t?.solo);
      const y = this.laneTop(i);
      const lh = this.lanes.heights[i];
      idx.query(t0, t1, (c) => {
        if (hidden?.has(c.id)) return;
        const clip = muteIds && muteIds.value !== null && muteIds.ids.has(c.id) ? { ...c, mute: muteIds.value } : c;
        paintClip(ctx, p, this.fadeShown(clip), this.tv, y, lh, w, { ...base, selected: this.selection.has(c.id), glow: this.glow.alpha(c.id, now), trackMuted });
      });
    }
    this.takes.paint(ctx, w, h, dpr);
  }

  private paintOverlay(): void {
    const ctx = this.overlayL.begin();
    const p = this.project;
    if (!ctx || !p) return;
    const { w, h, dpr } = this.overlayL;
    const d = this.drag;
    const ids = this.lanes.ids;
    const base = { dpr, ts: p.transport.timeSig, bpm: p.transport.bpm, glow: 0 };
    this.takes.paintOverlay(ctx);
    const ghostClip = (lane: number, start: number, len: number, patternId: string) => {
      if (lane < 0 || lane >= ids.length) return;
      const c: Clip = { id: '__preview', trackId: ids[lane], kind: 'pattern', start, length: len, offset: 0, mute: false, color: null, patternId };
      paintClip(ctx, p, c, this.tv, this.laneTop(lane), this.lanes.heights[lane], w, { ...base, selected: false, ghost: true });
    };

    if (!d && this.hover && this.hover.lane >= 0 && this.hover.lane < ids.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, this.laneTop(this.hover.lane), w, this.lanes.heights[this.hover.lane]);
      const c = this.hover.clipId ? this.clip(this.hover.clipId) : undefined;
      if (c && (this.hover.zone === 'left' || this.hover.zone === 'right')) {
        const x = tickToX(this.tv, this.hover.zone === 'right' ? c.start + c.length : c.start);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(this.hover.zone === 'right' ? x - 3 : x + 1, this.laneTop(this.hover.lane) + 3, 2, this.lanes.heights[this.hover.lane] - 6);
      }
    }
    if (this.dropPreview) {
      const dp = this.dropPreview;
      const y = this.laneTop(dp.lane);
      const x = tickToX(this.tv, dp.tick);
      ctx.fillStyle = rgba(C.purple, 0.18);
      ctx.fillRect(x, y + 1, dp.len * this.tv.pxPerTick, this.lanes.heights[dp.lane] - 2);
      ctx.fillStyle = C.purple;
      ctx.fillRect(Math.round(x * dpr) / dpr, y, 2, this.lanes.heights[dp.lane]);
      ctx.font = `10px ${'"JetBrains Mono", monospace'}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(dp.label, x + 6, y + this.lanes.heights[dp.lane] / 2);
    }
    this.paintFadeDragLabel(ctx, h, dpr);
    if (!d) return;
    switch (d.kind) {
      case 'create':
        ghostClip(d.lane, d.start, d.len, d.patternId);
        break;
      case 'paint':
        for (const s of d.slots) ghostClip(d.lane, d.start + s * d.len, d.len, d.patternId);
        break;
      case 'move':
        if (!d.moved) break;
        for (const o of d.origins.values()) {
          const lane = (d.laneOf.get(o.id) ?? 0) + d.dL;
          if (lane < 0 || lane >= ids.length) continue;
          paintClip(ctx, p, { ...o, start: o.start + d.dT }, this.tv, this.laneTop(lane), this.lanes.heights[lane], w, { ...base, selected: true });
        }
        this.guide(ctx, tickToX(this.tv, d.primary.start + d.dT), h, dpr);
        break;
      case 'resize':
        for (const o of d.origins.values()) {
          const lane = this.laneOfClip(o);
          if (lane < 0) continue;
          paintClip(ctx, p, { ...o, ...this.resized(o, d.edge, d.dT) }, this.tv, this.laneTop(lane), this.lanes.heights[lane], w, { ...base, selected: true });
        }
        {
          const r = this.resized(d.primary, d.edge, d.dT);
          this.guide(ctx, tickToX(this.tv, d.edge === 'right' ? r.start + r.length : r.start), h, dpr);
        }
        break;
      case 'marquee': {
        const pt = this.ptr;
        if (!pt) break;
        const x0 = tickToX(this.tv, d.tickA);
        const y0 = d.yA - this.scrollY;
        ctx.fillStyle = C.marquee;
        ctx.fillRect(Math.min(x0, pt.x), Math.min(y0, pt.y), Math.abs(pt.x - x0), Math.abs(pt.y - y0));
        ctx.strokeStyle = C.marqueeEdge;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.min(x0, pt.x) + 0.5, Math.min(y0, pt.y) + 0.5, Math.abs(pt.x - x0), Math.abs(pt.y - y0));
        ctx.setLineDash([]);
        break;
      }
      case 'erase':
      case 'mute': {
        const pt = this.ptr;
        if (pt && !(d.kind === 'erase' && d.menu)) {
          ctx.strokeStyle = d.kind === 'erase' ? 'rgba(244,63,94,0.75)' : 'rgba(250,204,21,0.75)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'slice': {
        const x = tickToX(this.tv, d.tick);
        const la = Math.min(d.laneA, d.laneB);
        const lb = Math.max(d.laneA, d.laneB);
        const y0 = this.laneTop(la);
        const y1 = this.laneTop(lb) + this.lanes.heights[lb];
        ctx.fillStyle = rgba(C.pink, 0.2);
        ctx.fillRect(Math.round(x * dpr) / dpr, 0, 1 / dpr, h);
        ctx.fillStyle = C.pink;
        ctx.fillRect(Math.round(x * dpr) / dpr - 1, y0, 2, y1 - y0);
        break;
      }
      case 'apoint': {
        if (!d.moved) break;
        const x = tickToX(this.tv, d.clip.start + d.tick - d.clip.offset);
        const body = this.clipBody(d.lane);
        const y = body.top + (1 - d.value) * body.h;
        ctx.font = `10px ${'"JetBrains Mono", monospace'}`;
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#fff';
        ctx.fillText(`${Math.round(d.value * 100)}%`, x + 7, y - 4);
        break;
      }
      case 'atension': {
        const pt = this.ptr;
        if (!pt) break;
        ctx.font = `10px ${'"JetBrains Mono", monospace'}`;
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#fff';
        ctx.fillText(`tension ${d.tension.toFixed(2)}`, pt.x + 10, pt.y - 6);
        break;
      }
      default:
        break;
    }
  }

  private guide(ctx: CanvasRenderingContext2D, x: number, h: number, dpr: number): void {
    ctx.fillStyle = rgba(C.purple, 0.55);
    ctx.fillRect(Math.round(x * dpr) / dpr, 0, 1 / dpr, h);
  }

  private paintRulerLayer(): void {
    const ctx = this.rulerL.begin();
    const p = this.project;
    if (!ctx || !p) return;
    paintRuler(ctx, this.tv, this.rulerL.w, this.rulerL.h, this.ts, this.rulerL.dpr, {
      loop: this.rulerLoop(),
      markers: markersWithDrag(Object.values(p.playlist.markers), this.markerDrag),
    });
  }

  static valueAt(points: AutomationPoint[], c: Clip, songTick: number): number {
    return evalAutomation(points, songTick - c.start + c.offset);
  }
}
