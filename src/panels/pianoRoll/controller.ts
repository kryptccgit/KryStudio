import type { Note, Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import { TICKS_PER_STEP, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds, type TimeSig } from '@shared/schema/time';
import { CHORD_QUALITIES, SCALES } from '@shared/music/theory';
import type { NoteInput } from '@shared/commands/notes';
import type { CommandDef } from '@shared/commands/types';
import { NOTE_TOOL_COMMANDS } from '@shared/commands/noteTools';
import { GENERATE_ARGS, planGenerate, type GeneratePlan } from '@shared/commands/generate';
import { CATALOG } from '@shared/plugins/catalog';
import { dispatch, dispatchBatch, getProject, useDocStore } from '../../doc/store';
import { onFrame } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { playState } from '../../live/playState';
import { flashHint } from '../../app/hints';
import { toast } from '../../app/notify';
import { Layer, layerDpr, observeSize, px } from '../../editors/layer';
import {
  clamp,
  clampScroll,
  edgeScrollStep,
  keyToY,
  tickToX,
  viewTicks,
  wheelZoomFactor,
  xToTick,
  yToKey,
  zoomAt,
  zoomRowsAt,
  type KeyView,
  type TimeView,
} from '../../editors/viewport';
import { cellStart, snapMoveDelta, snapResizeEnd, snapResizeStart, snapTicks, snapTo } from '../../editors/snap';
import { SpanIndex, hitNote, notesInRect } from '../../editors/spanIndex';
import { paintTimeGrid, paintRuler } from '../../editors/gridPaint';
import { GlowTracker, changedIds } from '../../editors/agentGlow';
import { duplicateShift, getNoteClipboard, makeNoteClipboard, pasteNotes, setNoteClipboard } from '../../editors/clipboard';
import { ScrollbarCtl } from '../../editors/scrollbar';
import { isMod, isTypingTarget, toolForKey } from '../../editors/tools';
import { resolveChannel, useEditorSelection } from '../../editors/selection';
import { C, FONT_SANS, rgba } from '../../editors/theme';
import { LANE_PROPS, PR_TOOLS, usePianoRollView, type LaneProp } from './store';
import { drawNote, forVisibleNotes, laneValueFromY, noteFill, noteRect, paintGlides, paintKeyRows, paintKeyboard, paintLane, type ScaleMask } from './paint';
import { setActivePianoRoll } from './active';
import { registerTabView } from '../../app/tabs/viewState';

export const PR = { keyW: 64, rulerH: 24, sb: 10, split: 5 } as const;
const MIN_PX = 0.004;
const MAX_PX = 3;
const MIN_ROW = 6;
const MAX_ROW = 40;
const EDGE_PX = 5;
const EMPTY_INDEX = new SpanIndex<Note>([], (n) => n.tick, (n) => n.dur);

export interface PianoRollEls {
  root: HTMLElement;
  body: HTMLElement;
  keysHost: HTMLElement;
  keys: HTMLCanvasElement;
  rulerHost: HTMLElement;
  ruler: HTMLCanvasElement;
  gridHost: HTMLElement;
  grid: HTMLCanvasElement;
  content: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  laneHost: HTMLElement;
  lane: HTMLCanvasElement;
  playheads: HTMLElement[];
  splitter: HTMLElement;
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

type PreviewNote = { tick: number; key: number; dur: number; vel: number; color?: number; slide?: boolean };

type Drag =
  | { kind: 'create'; notes: PreviewNote[]; baseTick: number; baseKey: number; downTick: number; offsets: number[]; committing?: boolean }
  | { kind: 'paint'; notes: PreviewNote[]; start: number; len: number; slots: Set<number>; committing?: boolean }
  | {
      kind: 'move';
      ids: string[];
      origins: Map<string, Note>;
      primary: Note;
      downTick: number;
      downKey: number;
      downX: number;
      downY: number;
      minStart: number;
      minKey: number;
      maxKey: number;
      dT: number;
      dK: number;
      copy: boolean;
      moved: boolean;
      committing?: boolean;
    }
  | { kind: 'resize'; edge: 'left' | 'right'; ids: string[]; origins: Map<string, Note>; primary: Note; grab: number; dT: number; committing?: boolean }
  | { kind: 'marquee'; tickA: number; yA: number; base: Set<string> }
  | { kind: 'erase'; ids: Set<string>; lastX: number; lastY: number; committing?: boolean }
  | { kind: 'mute'; ids: Set<string>; value: boolean | null; lastX: number; lastY: number; committing?: boolean }
  | { kind: 'slice'; tickA: number; yA: number; tickB: number; yB: number; committing?: boolean }
  | { kind: 'pan'; x: number; y: number; scrollTick: number; scrollY: number }
  | { kind: 'lane'; values: Map<string, number>; lastX: number; lastV: number; prop: LaneProp; committing?: boolean };

export class PianoRollController {
  private gridL = new Layer();
  private contentL = new Layer();
  private overlayL = new Layer();
  private keysL = new Layer();
  private rulerL = new Layer();
  private laneL = new Layer();
  private els: PianoRollEls | null = null;
  private hbar: ScrollbarCtl | null = null;
  private vbar: ScrollbarCtl | null = null;

  tv: TimeView = { scrollTick: 0, pxPerTick: 0.075 };
  kv: KeyView = { scrollY: 0, rowH: 15 };
  private dpr = 1;

  patternId: string | null = null;
  channelId: string | null = null;
  private notesRec: Record<string, Note> | undefined;
  private index = new SpanIndex<Note>([], (n) => n.tick, (n) => n.dur);
  private ghostCache = new WeakMap<Record<string, Note>, SpanIndex<Note>>();
  private ghosts: Array<{ color: string; index: SpanIndex<Note> }> = [];
  private patLen = 3840;
  private ts: TimeSig = { num: 4, den: 4 };
  private patternClips: Array<{ start: number; length: number; offset: number }> = [];

  readonly selection = new Set<string>();
  private drag: Drag | null = null;
  private ptr: Ptr | null = null;
  private downPt: { x: number; y: number; armed: boolean } | null = null;
  private hover: { tick: number; key: number; noteId: string | null; zone: string } | null = null;
  private lastClickTick: number | null = null;
  private localPlayhead: number | null = null;
  private pressedKeys = new Set<number>();
  private keyboardDown: number | null = null;
  private sounding: number[] = [];
  private glow = new GlowTracker();
  private glowWasActive = false;
  private centeredFor: string | null = null;
  private offs: Array<() => void> = [];
  private preview: { hide: Set<string>; notes: Note[] } | null = null;
  private syllables: SyllableMark[] | null = null;
  private lastManualScroll = 0;

  attach(els: PianoRollEls): () => void {
    this.els = els;
    this.gridL.attach(els.grid);
    this.contentL.attach(els.content);
    this.overlayL.attach(els.overlay);
    this.keysL.attach(els.keys);
    this.rulerL.attach(els.ruler);
    this.laneL.attach(els.lane);
    this.dpr = layerDpr(els.overlay);

    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    this.offs.push(
      observeSize(els.gridHost, (w, h) => {
        this.gridL.resize(w, h);
        this.contentL.resize(w, h);
        this.overlayL.resize(w, h);
        this.clampView();
        this.ensureCentered();
      }),
      observeSize(els.keysHost, (w, h) => this.keysL.resize(w, h)),
      observeSize(els.rulerHost, (w, h) => this.rulerL.resize(w, h)),
      observeSize(els.laneHost, (w, h) => this.laneL.resize(w, h)),
    );

    on(els.overlay, 'pointerdown', (e) => this.onGridDown(e));
    on(els.overlay, 'pointermove', (e) => this.onGridMove(e));
    on(els.overlay, 'pointerup', (e) => this.onGridUp(e));
    on(els.overlay, 'pointercancel', (e) => this.onGridUp(e, true));
    on(els.overlay, 'pointerleave', () => {
      if (!this.drag && this.hover) {
        this.hover = null;
        this.overlayL.dirty = true;
        this.keysL.dirty = true;
      }
    });
    on(els.overlay, 'contextmenu', (e) => e.preventDefault());
    on(els.keys, 'pointerdown', (e) => this.onKeysDown(e));
    on(els.keys, 'pointermove', (e) => this.onKeysMove(e));
    on(els.keys, 'pointerup', () => this.onKeysUp());
    on(els.keys, 'pointercancel', () => this.onKeysUp());
    on(els.keys, 'contextmenu', (e) => e.preventDefault());
    on(els.ruler, 'pointerdown', (e) => this.onRulerDown(e));
    on(els.ruler, 'pointermove', (e) => {
      if (e.buttons & 1) this.onRulerDown(e);
    });
    on(els.lane, 'pointerdown', (e) => this.onLaneDown(e));
    on(els.lane, 'pointermove', (e) => this.onLaneMove(e));
    on(els.lane, 'pointerup', () => this.onLaneUp());
    on(els.lane, 'pointercancel', () => this.onLaneUp());
    on(els.lane, 'contextmenu', (e) => e.preventDefault());
    on(els.splitter, 'pointerdown', (e) => this.onSplitDown(e));
    on(els.body, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(els.root, 'keydown', (e) => this.onKey(e));
    on(els.root, 'pointerdown', () => {
      if (!isTypingTarget(els.root.ownerDocument.activeElement)) els.root.focus({ preventScroll: true });
    });

    this.hbar = new ScrollbarCtl(els.hTrack, els.hThumb, 'x', (p) => {
      this.lastManualScroll = performance.now();
      this.setScrollTick(p);
    });
    this.vbar = new ScrollbarCtl(els.vTrack, els.vThumb, 'y', (p) => this.setScrollY(p));
    setActivePianoRoll(this);

    this.offs.push(
      useDocStore.subscribe((s, prev) => {
        if (s.project !== prev.project) this.refresh(s.lastChange?.actorKind === 'agent' && s.version !== prev.version);
      }),
      useEditorSelection.subscribe((s, prev) => {
        if (s.channelId !== prev.channelId) this.refresh(false);
      }),
      usePianoRollView.subscribe((s, prev) => {
        if (s.scale !== prev.scale || s.scaleRoot !== prev.scaleRoot || s.snap !== prev.snap) {
          this.gridL.dirty = true;
          this.keysL.dirty = true;
        }
        if (s.ghosts !== prev.ghosts || s.velAlpha !== prev.velAlpha) this.contentL.dirty = true;
        if (s.lane !== prev.lane) this.laneL.dirty = true;
        if (s.tool !== prev.tool) this.updateCursor();
      }),
      onFrame((_dt, now) => this.frame(now)),
      registerTabView('pianoRoll', { capture: () => null, restore: () => this.resetForTab() }),
    );
    void els.root.ownerDocument.fonts?.ready.then(() => this.markAll());

    this.refresh(false);
    return () => this.detach();
  }

  private detach(): void {
    setActivePianoRoll(null);
    this.preview = null;
    this.audOff();
    this.stopAudition();
    this.offs.forEach((f) => f());
    this.offs = [];
    this.hbar?.destroy();
    this.vbar?.destroy();
    this.els = null;
  }

  private markAll(): void {
    for (const l of [this.gridL, this.contentL, this.overlayL, this.keysL, this.rulerL, this.laneL]) l.dirty = true;
  }

  private markTime(): void {
    this.gridL.dirty = this.contentL.dirty = this.overlayL.dirty = this.rulerL.dirty = this.laneL.dirty = true;
    this.updateScrollbars();
  }

  private markKeys(): void {
    this.gridL.dirty = this.contentL.dirty = this.overlayL.dirty = this.keysL.dirty = true;
    this.updateScrollbars();
  }

  private refresh(agent: boolean): void {
    const p: Project | null = getProject();
    if (!p) return;
    const pid = p.transport.activePatternId;
    const ch = resolveChannel(p, useEditorSelection.getState().channelId);
    const pat = pid ? p.patterns[pid] : undefined;
    const targetChanged = pid !== this.patternId || ch !== this.channelId;
    const rec = pat && ch ? pat.notes[ch] : undefined;

    if (p.transport.timeSig !== this.ts) {
      this.ts = p.transport.timeSig;
      this.markAll();
    }
    if (targetChanged || rec !== this.notesRec) {
      if (agent && !targetChanged) this.glow.mark(changedIds(this.notesRec, rec), performance.now());
      this.notesRec = rec;
      this.index = new SpanIndex(rec ? Object.values(rec) : [], (n) => n.tick, (n) => n.dur);
      if (targetChanged) {
        this.selection.clear();
        this.preview = null;
        this.patternId = pid;
        this.channelId = ch;
        this.cancelDrag();
      } else {
        for (const id of this.selection) if (!rec?.[id]) this.selection.delete(id);
      }
      this.contentL.dirty = this.overlayL.dirty = this.laneL.dirty = true;
    }

    const ghosts: Array<{ color: string; index: SpanIndex<Note> }> = [];
    if (pat) {
      for (const [chId, r] of Object.entries(pat.notes)) {
        if (chId === ch) continue;
        let idx = this.ghostCache.get(r);
        if (!idx) {
          idx = new SpanIndex(Object.values(r), (n) => n.tick, (n) => n.dur);
          this.ghostCache.set(r, idx);
        }
        ghosts.push({ color: p.channels[chId]?.color ?? C.muted, index: idx });
      }
    }
    if (ghosts.length !== this.ghosts.length || ghosts.some((g, i) => g.index !== this.ghosts[i].index || g.color !== this.ghosts[i].color)) {
      this.ghosts = ghosts;
      this.contentL.dirty = true;
    }

    const len = pat ? patternLength(pat, p.transport.timeSig) : ticksPerBar(p.transport.timeSig);
    if (len !== this.patLen) {
      this.patLen = len;
      this.gridL.dirty = this.rulerL.dirty = true;
    }
    this.patternClips = pid
      ? Object.values(p.playlist.clips)
          .filter((c) => c.kind === 'pattern' && c.patternId === pid && !c.mute)
          .map((c) => ({ start: c.start, length: c.length, offset: c.offset }))
      : [];
    this.updateScrollbars();
    if (targetChanged) this.ensureCentered();
  }

  private resetForTab(): void {
    this.selection.clear();
    this.preview = null;
    this.cancelDrag();
    this.centeredFor = null;
    this.patternId = null;
    this.refresh(false);
  }

  private ensureCentered(): void {
    const key = `${this.patternId}|${this.channelId}`;
    if (this.centeredFor === key || this.gridL.h <= 0) return;
    this.centeredFor = key;
    let lo = 127;
    let hi = 0;
    for (const n of this.index.items) {
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
    }
    const mid = this.index.size ? (lo + hi) / 2 : 66;
    this.setScrollY((127 - mid) * this.kv.rowH - this.gridL.h / 2);
    this.setScrollTick(0);
  }

  private target(): { patternId: string; channelId: string } | null {
    return this.patternId && this.channelId ? { patternId: this.patternId, channelId: this.channelId } : null;
  }

  private note(id: string): Note | undefined {
    return this.notesRec?.[id];
  }

  private snapGrid(): number {
    return snapTicks(usePianoRollView.getState().snap, this.ts);
  }

  private scaleMask(): ScaleMask | null {
    const v = usePianoRollView.getState();
    if (v.scale === 'off') return null;
    const steps = SCALES[v.scale] ?? SCALES.major;
    const inScale = new Array(12).fill(false);
    for (const s of steps) inScale[(v.scaleRoot + s) % 12] = true;
    return { inScale, root: v.scaleRoot };
  }

  private stampKeys(root: number): number[] {
    const q = usePianoRollView.getState().chord;
    const iv = q ? CHORD_QUALITIES[q] : null;
    if (!iv) return [root];
    return iv.map((i) => root + i).filter((k) => k >= 0 && k <= 127);
  }

  private contentTicks(): number {
    const bar = ticksPerBar(this.ts);
    return Math.max(this.patLen, this.index.lastEnd()) + bar * 4;
  }

  setScrollTick(t: number, allowGrow = false): void {
    const w = this.gridL.w || 1;
    const vt = viewTicks(this.tv, w);
    const next = allowGrow ? Math.max(0, t) : clampScroll(t, Math.max(this.contentTicks(), this.tv.scrollTick + vt), vt);
    if (next !== this.tv.scrollTick) {
      this.tv = { ...this.tv, scrollTick: next };
      this.markTime();
    }
  }

  setScrollY(y: number): void {
    const next = clampScroll(y, 128 * this.kv.rowH, this.gridL.h || 1);
    if (next !== this.kv.scrollY) {
      this.kv = { ...this.kv, scrollY: next };
      this.markKeys();
    }
  }

  private clampView(): void {
    this.setScrollY(this.kv.scrollY);
    this.markAll();
    this.updateScrollbars();
  }

  zoomX(anchorX: number, factor: number): void {
    const next = zoomAt(this.tv, anchorX, factor, MIN_PX, MAX_PX);
    if (next.pxPerTick === this.tv.pxPerTick && next.scrollTick === this.tv.scrollTick) return;
    this.tv = next;
    this.markTime();
  }

  private zoomY(anchorY: number, factor: number): void {
    const next = zoomRowsAt(this.kv, anchorY, factor, MIN_ROW, MAX_ROW);
    this.kv = next;
    this.setScrollY(next.scrollY);
    this.markKeys();
  }

  private updateScrollbars(): void {
    const w = this.gridL.w || 1;
    const vt = viewTicks(this.tv, w);
    this.hbar?.update(this.tv.scrollTick, vt, Math.max(this.contentTicks(), this.tv.scrollTick + vt));
    this.vbar?.update(this.kv.scrollY, this.gridL.h || 1, 128 * this.kv.rowH);
  }

  private updateCursor(): void {
    const el = this.els?.overlay;
    if (!el) return;
    const tool = usePianoRollView.getState().tool;
    let c = 'default';
    if (this.drag?.kind === 'pan') c = 'grabbing';
    else if (this.hover?.noteId && (this.hover.zone === 'left' || this.hover.zone === 'right') && (tool === 'draw' || tool === 'paint' || tool === 'select')) c = 'ew-resize';
    else if (this.hover?.noteId && (tool === 'draw' || tool === 'paint' || tool === 'select')) c = 'move';
    else if (tool === 'draw' || tool === 'paint') c = 'crosshair';
    else if (tool === 'delete') c = 'not-allowed';
    else if (tool === 'mute') c = 'pointer';
    else if (tool === 'slice') c = 'col-resize';
    if (el.style.cursor !== c) el.style.cursor = c;
  }

  private audSet(keys: number[], vel = 0.78): void {
    const ch = this.channelId;
    if (!ch) return;
    const next = new Set(keys);
    try {
      for (const k of this.sounding) if (!next.has(k)) window.krypt.engine.audition(ch, k, 0, false);
      for (const k of keys) if (!this.sounding.includes(k)) window.krypt.engine.audition(ch, k, vel, true);
    } catch {
    }
    this.sounding = keys;
    this.pressedKeys = new Set(keys);
    this.keysL.dirty = true;
  }

  private audOff(): void {
    if (this.sounding.length) this.audSet([]);
  }

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.els!.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setPtr(e: PointerEvent | MouseEvent): Ptr {
    const { x, y } = this.local(e);
    this.ptr = { x, y, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    return this.ptr;
  }

  private onGridDown(e: PointerEvent): void {
    if (!this.target() || this.drag) return;
    const p = this.setPtr(e);
    this.downPt = { x: p.x, y: p.y, armed: false };
    const tick = xToTick(this.tv, p.x);
    const key = clamp(yToKey(this.kv, p.y), 0, 127);
    const view = usePianoRollView.getState();
    const tool = view.tool;
    const grid = this.snapGrid();
    this.els!.overlay.setPointerCapture(e.pointerId);

    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, scrollTick: this.tv.scrollTick, scrollY: this.kv.scrollY };
      this.updateCursor();
      return;
    }
    const hit = hitNote(this.index, tick, key, this.tv.pxPerTick, EDGE_PX);
    if (e.button === 2 || (e.button === 0 && tool === 'delete')) {
      this.drag = { kind: 'erase', ids: new Set(hit ? [hit.note.id] : []), lastX: p.x, lastY: p.y };
      this.contentL.dirty = this.laneL.dirty = true;
      return;
    }
    if (e.button === 0 && tool === 'mute') {
      this.drag = { kind: 'mute', ids: new Set(hit ? [hit.note.id] : []), value: hit ? !hit.note.mute : null, lastX: p.x, lastY: p.y };
      this.contentL.dirty = this.overlayL.dirty = true;
      return;
    }
    if (e.button !== 0) return;
    this.lastClickTick = cellStart(tick, grid, p.alt);

    if (tool === 'slice') {
      const t = snapTo(tick, grid);
      const cy = p.y + this.kv.scrollY;
      this.drag = { kind: 'slice', tickA: p.alt ? tick : t, yA: cy, tickB: p.alt ? tick : t, yB: cy };
      this.overlayL.dirty = true;
      return;
    }
    const marqueeMode = tool === 'select' ? !hit || p.ctrl : p.ctrl;
    if (marqueeMode) {
      const additive = p.shift || p.ctrl;
      const base = additive ? new Set(this.selection) : new Set<string>();
      if (!additive) this.selection.clear();
      this.drag = { kind: 'marquee', tickA: tick, yA: p.y + this.kv.scrollY, base };
      this.contentL.dirty = this.overlayL.dirty = this.laneL.dirty = true;
      return;
    }

    if (hit) {
      const n = hit.note;
      if (!this.selection.has(n.id)) {
        if (tool === 'select' && p.shift) this.selection.add(n.id);
        else {
          this.selection.clear();
          if (tool === 'select') this.selection.add(n.id);
        }
        this.contentL.dirty = this.laneL.dirty = true;
      }
      const ids = this.selection.has(n.id) ? [...this.selection] : [n.id];
      const origins = new Map<string, Note>();
      for (const id of ids) {
        const o = this.note(id);
        if (o) origins.set(id, o);
      }
      if (hit.zone === 'left' || hit.zone === 'right') {
        const grab = hit.zone === 'right' ? n.tick + n.dur - tick : n.tick - tick;
        this.drag = { kind: 'resize', edge: hit.zone, ids, origins, primary: n, grab, dT: 0 };
      } else {
        let minStart = Infinity;
        let minKey = 127;
        let maxKey = 0;
        for (const o of origins.values()) {
          minStart = Math.min(minStart, o.tick);
          minKey = Math.min(minKey, o.key);
          maxKey = Math.max(maxKey, o.key);
        }
        this.drag = {
          kind: 'move',
          ids,
          origins,
          primary: n,
          downTick: tick,
          downKey: key,
          downX: p.x,
          downY: p.y,
          minStart,
          minKey,
          maxKey,
          dT: 0,
          dK: 0,
          copy: p.shift && tool !== 'select',
          moved: false,
        };
        this.audSet([n.key], n.vel);
      }
      this.contentL.dirty = this.overlayL.dirty = this.laneL.dirty = true;
      return;
    }

    const start = cellStart(tick, grid, p.alt);
    const len = Math.max(1, view.lastLen);
    const keys = this.stampKeys(key);
    if (this.selection.size) {
      this.selection.clear();
      this.contentL.dirty = this.laneL.dirty = true;
    }
    const look = this.newNoteLook();
    if (tool === 'paint') {
      this.drag = { kind: 'paint', notes: keys.map((k) => ({ tick: start, key: k, dur: len, vel: 0.78, ...look })), start, len, slots: new Set([0]) };
    } else {
      this.drag = {
        kind: 'create',
        notes: keys.map((k) => ({ tick: start, key: k, dur: len, vel: 0.78, ...look })),
        baseTick: start,
        baseKey: key,
        downTick: tick,
        offsets: keys.map((k) => k - key),
      };
    }
    this.audSet(keys);
    this.overlayL.dirty = true;
  }

  private onGridMove(e: PointerEvent): void {
    const p = this.setPtr(e);
    if (this.drag) {
      if (this.drag.kind === 'pan') {
        this.setScrollTick(this.drag.scrollTick - (e.clientX - this.drag.x) / this.tv.pxPerTick);
        this.setScrollY(this.drag.scrollY - (e.clientY - this.drag.y));
        return;
      }
      this.updateDrag();
      return;
    }
    const tick = xToTick(this.tv, p.x);
    const key = clamp(yToKey(this.kv, p.y), 0, 127);
    const hit = this.target() ? hitNote(this.index, tick, key, this.tv.pxPerTick, EDGE_PX) : null;
    const h = { tick, key, noteId: hit?.note.id ?? null, zone: hit?.zone ?? '' };
    const prev = this.hover;
    this.hover = h;
    if (!prev || prev.key !== h.key || prev.noteId !== h.noteId || prev.zone !== h.zone) {
      this.overlayL.dirty = true;
      if (!prev || prev.key !== h.key) this.keysL.dirty = true;
      this.updateCursor();
    }
  }

  private updateDrag(): void {
    const d = this.drag;
    const p = this.ptr;
    if (!d || !p || ('committing' in d && d.committing)) return;
    const tick = xToTick(this.tv, p.x);
    const key = clamp(yToKey(this.kv, p.y), 0, 127);
    const grid = this.snapGrid();
    switch (d.kind) {
      case 'create': {
        const dt = snapMoveDelta(d.baseTick, tick - d.downTick, grid, d.baseTick, p.alt);
        const lo = Math.min(...d.offsets);
        const hi = Math.max(...d.offsets);
        const root = clamp(key, -lo, 127 - hi);
        const changed = root !== d.notes[0].key - d.offsets[0];
        d.notes = d.offsets.map((o, i) => ({ ...d.notes[i], tick: d.baseTick + dt, key: root + o }));
        if (changed) this.audSet(d.notes.map((n) => n.key));
        this.overlayL.dirty = true;
        break;
      }
      case 'paint': {
        const slot = Math.floor((tick - d.start) / d.len);
        const keys = this.stampKeys(key);
        let added = false;
        const lo = Math.min(slot, 0);
        for (let s = lo; s <= Math.max(slot, 0); s++) {
          if (d.slots.has(s) || d.start + s * d.len < 0) continue;
          if (s !== slot && Math.abs(s - slot) > 64) continue;
          d.slots.add(s);
          for (const k of keys) d.notes.push({ tick: d.start + s * d.len, key: k, dur: d.len, vel: 0.78, ...this.newNoteLook() });
          added = true;
        }
        if (added) this.audSet(keys);
        this.overlayL.dirty = true;
        break;
      }
      case 'move': {
        if (!d.moved && (Math.abs(p.x - d.downX) > 3 || Math.abs(p.y - d.downY) > 3)) d.moved = true;
        if (!d.moved) return;
        const dT = snapMoveDelta(d.primary.tick, tick - d.downTick, grid, d.minStart, p.alt);
        const dK = clamp(key - d.downKey, -d.minKey, 127 - d.maxKey);
        if (dK !== d.dK) this.audSet([d.primary.key + dK], d.primary.vel);
        if (dT !== d.dT || dK !== d.dK) {
          d.dT = dT;
          d.dK = dK;
          this.overlayL.dirty = this.laneL.dirty = true;
        }
        break;
      }
      case 'resize': {
        const pr = d.primary;
        let dT: number;
        if (d.edge === 'right') {
          const dur = snapResizeEnd(pr.tick, tick + d.grab, grid, p.alt);
          dT = dur - pr.dur;
        } else {
          const r = snapResizeStart(pr.tick + pr.dur, tick + d.grab, grid, p.alt);
          dT = r.start - pr.tick;
        }
        if (dT !== d.dT) {
          d.dT = dT;
          this.overlayL.dirty = this.laneL.dirty = true;
        }
        break;
      }
      case 'marquee': {
        const yB = p.y + this.kv.scrollY;
        const kA = 127 - Math.floor(d.yA / this.kv.rowH);
        const kB = 127 - Math.floor(yB / this.kv.rowH);
        const hits = notesInRect(this.index, d.tickA, tick, kA, kB);
        this.selection.clear();
        for (const id of d.base) this.selection.add(id);
        for (const n of hits) this.selection.add(n.id);
        this.contentL.dirty = this.overlayL.dirty = this.laneL.dirty = true;
        break;
      }
      case 'erase':
      case 'mute': {
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - d.lastX, p.y - d.lastY) / 4));
        let grew = false;
        for (let i = 1; i <= steps; i++) {
          const x = d.lastX + ((p.x - d.lastX) * i) / steps;
          const y = d.lastY + ((p.y - d.lastY) * i) / steps;
          const h = hitNote(this.index, xToTick(this.tv, x), clamp(yToKey(this.kv, y), 0, 127), this.tv.pxPerTick, 0, d.ids);
          if (h) {
            if (d.kind === 'mute' && d.value === null) d.value = !h.note.mute;
            d.ids.add(h.note.id);
            grew = true;
          }
        }
        d.lastX = p.x;
        d.lastY = p.y;
        if (grew) this.contentL.dirty = this.laneL.dirty = true;
        this.overlayL.dirty = true;
        break;
      }
      case 'slice': {
        d.tickB = p.alt ? tick : snapTo(tick, grid);
        d.yB = p.y + this.kv.scrollY;
        this.overlayL.dirty = true;
        break;
      }
      default:
        break;
    }
  }

  private onGridUp(e: PointerEvent, cancelled = false): void {
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
    this.audOff();
    this.contentL.dirty = this.overlayL.dirty = this.laneL.dirty = true;
    this.updateCursor();
  }

  private async commit(d: Drag): Promise<void> {
    const t = this.target();
    const finish = () => {
      if (this.drag === d) this.drag = null;
      this.contentL.dirty = this.overlayL.dirty = this.laneL.dirty = true;
      this.updateCursor();
    };
    if (!t || d.kind === 'pan' || d.kind === 'marquee' || d.kind === 'lane') {
      this.audOff();
      finish();
      return;
    }
    (d as { committing?: boolean }).committing = true;
    this.audOff();
    switch (d.kind) {
      case 'create':
      case 'paint': {
        const notes: NoteInput[] = d.notes.map((n) => ({
          tick: n.tick,
          key: n.key,
          dur: n.dur,
          vel: n.vel,
          ...(n.color ? { color: n.color } : {}),
          ...(n.slide ? { slide: true } : {}),
        }));
        if (notes.length) await dispatch('notes.add', { ...t, notes });
        break;
      }
      case 'move': {
        if (!d.moved) {
          usePianoRollView.getState().set({ lastLen: d.primary.dur });
          break;
        }
        if (d.dT === 0 && d.dK === 0) break;
        if (d.copy) {
          const notes: NoteInput[] = [...d.origins.values()].map((o) => {
            const { id: _id, ...rest } = o;
            return { ...rest, tick: o.tick + d.dT, key: o.key + d.dK };
          });
          const r = await dispatch<{ ids: string[] }>('notes.add', { ...t, notes });
          if (r.ok && r.data) {
            this.selection.clear();
            for (const id of r.data.ids) this.selection.add(id);
          }
        } else {
          await dispatch('notes.update', { ...t, updates: [...d.origins.values()].map((o) => ({ id: o.id, tick: o.tick + d.dT, key: o.key + d.dK })) });
        }
        break;
      }
      case 'resize': {
        if (d.dT === 0) break;
        const updates = [...d.origins.values()].map((o) => ({ id: o.id, ...this.resized(o, d.edge, d.dT) }));
        const r = await dispatch('notes.update', { ...t, updates });
        if (r.ok) {
          const pr = this.resized(d.primary, d.edge, d.dT);
          usePianoRollView.getState().set({ lastLen: pr.dur });
        }
        break;
      }
      case 'erase': {
        if (d.ids.size) {
          const ids = [...d.ids];
          for (const id of ids) this.selection.delete(id);
          await dispatch('notes.remove', { ...t, ids });
        }
        break;
      }
      case 'mute': {
        if (d.ids.size && d.value !== null) {
          const r = await dispatch('notes.setProps', { ...t, ids: [...d.ids], mute: d.value }, { label: d.value ? 'Mute notes' : 'Unmute notes' });
          if (r.ok) flashHint(`${d.value ? 'Muted' : 'Unmuted'} ${d.ids.size} note${d.ids.size === 1 ? '' : 's'}`, 'ok', 1200);
        }
        break;
      }
      case 'slice': {
        const cuts = this.sliceCuts(d);
        if (cuts.length) {
          await dispatchBatch([
            { cmd: 'notes.update', args: { ...t, updates: cuts.map((c) => ({ id: c.note.id, dur: c.at - c.note.tick })) } },
            {
              cmd: 'notes.add',
              args: {
                ...t,
                notes: cuts.map((c) => {
                  const { id: _id, ...rest } = c.note;
                  return { ...rest, tick: c.at, dur: c.note.tick + c.note.dur - c.at };
                }),
              },
            },
          ], { label: cuts.length > 1 ? `Slice ${cuts.length} notes` : 'Slice note' });
        }
        break;
      }
    }
    finish();
  }

  private resized(o: Note, edge: 'left' | 'right', dT: number): { tick: number; dur: number } {
    if (edge === 'right') return { tick: o.tick, dur: Math.max(1, o.dur + dT) };
    const end = o.tick + o.dur;
    const tick = clamp(o.tick + dT, 0, end - 1);
    return { tick, dur: end - tick };
  }

  private sliceCuts(d: Extract<Drag, { kind: 'slice' }>): Array<{ note: Note; at: number }> {
    const rowH = this.kv.rowH;
    const kA = 127 - Math.floor(d.yA / rowH);
    const kB = 127 - Math.floor(d.yB / rowH);
    const lo = Math.min(kA, kB);
    const hi = Math.max(kA, kB);
    const grid = this.snapGrid();
    const out: Array<{ note: Note; at: number }> = [];
    const t0 = Math.min(d.tickA, d.tickB);
    const t1 = Math.max(d.tickA, d.tickB);
    this.index.query(t0, t1 + 1, (n) => {
      if (n.key < lo || n.key > hi) return;
      let at = d.tickA;
      if (d.yB !== d.yA) {
        const rowCenter = (127 - n.key + 0.5) * rowH;
        const f = clamp((rowCenter - d.yA) / (d.yB - d.yA), 0, 1);
        at = d.tickA + f * (d.tickB - d.tickA);
        at = this.ptr?.alt ? Math.round(at) : snapTo(at, grid);
      }
      at = Math.round(at);
      if (at > n.tick && at < n.tick + n.dur) out.push({ note: n, at });
    });
    return out;
  }

  private keyAtKeys(e: PointerEvent): number {
    const r = this.els!.keys.getBoundingClientRect();
    return clamp(yToKey(this.kv, e.clientY - r.top), 0, 127);
  }

  private onKeysDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.els!.keys.setPointerCapture(e.pointerId);
    const k = this.keyAtKeys(e);
    this.keyboardDown = k;
    const r = this.els!.keys.getBoundingClientRect();
    const vel = clamp(0.35 + ((e.clientX - r.left) / r.width) * 0.65, 0.2, 1);
    this.audSet([k], vel);
  }

  private onKeysMove(e: PointerEvent): void {
    const k = this.keyAtKeys(e);
    if (this.keyboardDown !== null) {
      if (k !== this.keyboardDown) {
        this.keyboardDown = k;
        this.audSet([k]);
      }
    } else if (this.hover?.key !== k) {
      this.hover = { tick: 0, key: k, noteId: null, zone: '' };
      this.keysL.dirty = this.overlayL.dirty = true;
    }
  }

  private onKeysUp(): void {
    this.keyboardDown = null;
    this.audOff();
  }

  private onRulerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.type === 'pointerdown') return;
    const r = this.els!.ruler.getBoundingClientRect();
    const raw = xToTick(this.tv, e.clientX - r.left);
    const tick = Math.max(0, e.altKey ? Math.round(raw) : snapTo(raw, this.snapGrid(), 'floor'));
    this.localPlayhead = tick;
    void window.krypt.engine.locate(tick).catch(() => undefined);
  }

  private laneLocal(e: PointerEvent): { x: number; y: number } {
    const r = this.els!.lane.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onLaneDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.target() || this.drag) return;
    this.els!.lane.setPointerCapture(e.pointerId);
    const { x, y } = this.laneLocal(e);
    const prop = usePianoRollView.getState().lane;
    const v = e.altKey ? LANE_PROPS[prop].def : laneValueFromY(prop, y, this.laneL.h);
    this.drag = { kind: 'lane', values: new Map(), lastX: x, lastV: v, prop };
    this.applyLane(x, v, x, v, true);
  }

  private onLaneMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.kind !== 'lane' || d.committing) return;
    const { x, y } = this.laneLocal(e);
    const v = e.altKey ? LANE_PROPS[d.prop].def : laneValueFromY(d.prop, y, this.laneL.h);
    this.applyLane(d.lastX, d.lastV, x, v, false);
    d.lastX = x;
    d.lastV = v;
  }

  private applyLane(x0: number, v0: number, x1: number, v1: number, click: boolean): void {
    const d = this.drag;
    if (!d || d.kind !== 'lane') return;
    const lo = Math.min(x0, x1) - (click ? 5 : 3);
    const hi = Math.max(x0, x1) + (click ? 5 : 3);
    const onlySel = this.selection.size > 0;
    const s = LANE_PROPS[d.prop];
    this.index.query(xToTick(this.tv, lo), xToTick(this.tv, hi) + 1, (n) => {
      if (onlySel && !this.selection.has(n.id)) return;
      const x = tickToX(this.tv, n.tick);
      if (x < lo || x > hi) return;
      const f = x1 === x0 ? 1 : clamp((x - x0) / (x1 - x0), 0, 1);
      let v = v0 + (v1 - v0) * f;
      v = s.int ? Math.round(v) : Math.round(v * 1000) / 1000;
      d.values.set(n.id, clamp(v, s.min, s.max));
    });
    this.laneL.dirty = true;
    if (d.prop === 'vel') this.contentL.dirty = true;
  }

  private onLaneUp(): void {
    const d = this.drag;
    if (!d || d.kind !== 'lane' || d.committing) return;
    const t = this.target();
    if (!t || d.values.size === 0) {
      this.drag = null;
      this.laneL.dirty = true;
      return;
    }
    d.committing = true;
    const updates = [...d.values].map(([id, v]) => ({ id, [d.prop]: v }));
    void dispatch('notes.update', { ...t, updates }, { label: `Edit ${LANE_PROPS[d.prop].label.toLowerCase()}` }).finally(() => {
      if (this.drag === d) this.drag = null;
      this.laneL.dirty = this.contentL.dirty = true;
    });
  }

  private onSplitDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.els) return;
    const el = this.els.splitter;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = usePianoRollView.getState().laneH;
    const body = this.els.body;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = clamp(startH - (ev.clientY - startY), 36, Math.max(60, body.clientHeight - 140));
      body.style.gridTemplateRows = prRows(h);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      usePianoRollView.getState().set({ laneH: h });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.els) return;
    const r = this.els.gridHost.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;
    e.preventDefault();
    if (e.altKey && !e.shiftKey) {
      this.wheelVelocity(dy, e.ctrlKey || e.metaKey);
      return;
    }
    this.lastManualScroll = performance.now();
    if (e.ctrlKey || e.metaKey) {
      if (e.shiftKey) this.zoomY(y, wheelZoomFactor(dy));
      else this.zoomX(clamp(x, 0, r.width), wheelZoomFactor(dy));
      return;
    }
    if (e.shiftKey) {
      this.setScrollTick(this.tv.scrollTick + (dy || dx) / this.tv.pxPerTick);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) this.setScrollTick(this.tv.scrollTick + dx / this.tv.pxPerTick);
    else this.setScrollY(this.kv.scrollY + dy);
  }

  private wheelVelocity(dy: number, fine: boolean): void {
    const t = this.target();
    if (!t || dy === 0) return;
    const hoverId = this.hover?.noteId;
    const ids = hoverId && !this.selection.has(hoverId) ? [hoverId] : [...this.selection];
    if (!ids.length) return;
    const step = (fine ? 0.01 : 0.04) * (dy < 0 ? 1 : -1);
    const updates = ids
      .map((id) => this.note(id))
      .filter((n): n is Note => !!n)
      .map((n) => ({ id: n.id, vel: Math.round(clamp(n.vel + step, 0, 1) * 1000) / 1000 }));
    void dispatch('notes.update', { ...t, updates }, { coalesceKey: `pr-vel:${t.patternId}:${t.channelId}`, label: 'Change velocity' });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || isTypingTarget(e.target)) return;
    const tool = toolForKey(e, PR_TOOLS);
    if (tool) {
      usePianoRollView.getState().set({ tool });
      this.handled(e);
      return;
    }
    const mod = isMod(e);
    const k = e.key.toLowerCase();
    if (mod && k === 'a') this.selectAll();
    else if (mod && k === 'd') this.deselect();
    else if (mod && k === 'c') this.copy();
    else if (mod && k === 'x') void this.cut();
    else if (mod && k === 'v') void this.paste();
    else if (mod && k === 'b') void this.duplicate();
    else if (mod && k === 'q') void this.quantize();
    else if (mod && e.key === 'ArrowUp') void this.transpose(e.shiftKey ? 12 : 1);
    else if (mod && e.key === 'ArrowDown') void this.transpose(e.shiftKey ? -12 : -1);
    else if (!mod && e.shiftKey && e.key === 'ArrowLeft') void this.nudge(-1);
    else if (!mod && e.shiftKey && e.key === 'ArrowRight') void this.nudge(1);
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

  private scope(): string[] | undefined {
    return this.selection.size ? [...this.selection] : undefined;
  }

  selectAll(): void {
    this.selection.clear();
    for (const n of this.index.items) this.selection.add(n.id);
    this.contentL.dirty = this.laneL.dirty = true;
  }

  deselect(): void {
    if (!this.selection.size) return;
    this.selection.clear();
    this.contentL.dirty = this.laneL.dirty = true;
  }

  async deleteSelected(): Promise<void> {
    const t = this.target();
    if (!t || !this.selection.size) return;
    const ids = [...this.selection];
    this.selection.clear();
    await dispatch('notes.remove', { ...t, ids });
  }

  copy(): number {
    const notes = (this.scope() ?? this.index.items.map((n) => n.id)).map((id) => this.note(id)).filter((n): n is Note => !!n);
    setNoteClipboard(makeNoteClipboard(notes));
    return notes.length;
  }

  async cut(): Promise<void> {
    if (!this.selection.size) return;
    this.copy();
    await this.deleteSelected();
  }

  async paste(): Promise<void> {
    const t = this.target();
    const cb = getNoteClipboard();
    if (!t || !cb) return;
    const at = this.lastClickTick ?? this.playheadTick() ?? 0;
    const r = await dispatch<{ ids: string[] }>('notes.add', { ...t, notes: pasteNotes(cb, at) }, { label: `Paste ${cb.notes.length} notes` });
    if (r.ok && r.data) {
      this.selection.clear();
      for (const id of r.data.ids) this.selection.add(id);
      this.contentL.dirty = this.laneL.dirty = true;
      this.lastClickTick = at + duplicateShift(0, cb.span, this.snapGrid());
    }
  }

  async duplicate(): Promise<void> {
    const t = this.target();
    if (!t) return;
    const notes = (this.scope() ?? this.index.items.map((n) => n.id)).map((id) => this.note(id)).filter((n): n is Note => !!n);
    if (!notes.length) return;
    let t0 = Infinity;
    let t1 = 0;
    for (const n of notes) {
      t0 = Math.min(t0, n.tick);
      t1 = Math.max(t1, n.tick + n.dur);
    }
    const g = this.snapGrid();
    const shift = duplicateShift(t0, t1, g > 1 ? g : ticksPerBeat(this.ts));
    const r = await dispatch<{ ids: string[] }>(
      'notes.add',
      { ...t, notes: notes.map(({ id: _id, ...n }) => ({ ...n, tick: n.tick + shift })) },
      { label: `Duplicate ${notes.length} notes` },
    );
    if (r.ok && r.data) {
      this.selection.clear();
      for (const id of r.data.ids) this.selection.add(id);
      this.contentL.dirty = this.laneL.dirty = true;
    }
  }

  async transpose(semis: number): Promise<void> {
    const t = this.target();
    if (!t || !this.index.size) return;
    await dispatch('notes.transform', { ...t, ids: this.scope(), transpose: semis }, { label: `Transpose ${semis > 0 ? '+' : ''}${semis}` });
    const lead = this.selection.size ? this.note([...this.selection][0]) : undefined;
    if (lead) {
      this.audSet([lead.key], lead.vel);
      setTimeout(() => this.audOff(), 180);
    }
  }

  async nudge(dir: number): Promise<void> {
    const t = this.target();
    if (!t || !this.index.size) return;
    const g = Math.max(1, this.snapGrid());
    await dispatch('notes.transform', { ...t, ids: this.scope(), shift: dir * g }, { label: 'Nudge notes' });
  }

  async quantize(): Promise<void> {
    const t = this.target();
    if (!t || !this.index.size) return;
    const g = this.snapGrid();
    await dispatch('notes.transform', { ...t, ids: this.scope(), quantize: { grid: Math.max(1, g), strength: 1, ends: false } }, { label: 'Quantize' });
  }

  get noteCount(): number {
    return this.index.size;
  }

  getTarget(): { patternId: string; channelId: string } | null {
    return this.target();
  }

  scopeNotes(): Note[] {
    const ids = this.scope();
    return ids ? ids.map((id) => this.note(id)).filter((n): n is Note => !!n) : [...this.index.items];
  }

  get selectionSize(): number {
    return this.selection.size;
  }

  snapGridTicks(): number {
    return this.snapGrid();
  }

  rootDocument(): Document {
    return this.els?.root.ownerDocument ?? document;
  }

  rootRect(): DOMRect | null {
    return this.els?.root.getBoundingClientRect() ?? null;
  }

  focus(): void {
    this.els?.root.focus({ preventScroll: true });
  }

  selectWhere(pred: (n: Note) => boolean): number {
    this.selection.clear();
    for (const n of this.index.items) if (pred(n)) this.selection.add(n.id);
    this.contentL.dirty = this.laneL.dirty = true;
    return this.selection.size;
  }

  async runTool(cmd: string, args: Record<string, unknown>, label?: string): Promise<boolean> {
    const t = this.target();
    if (!t) {
      toast.info('Select a pattern and a channel first');
      return false;
    }
    if (!this.index.size) {
      flashHint('This channel has no notes in this pattern', 'warn');
      this.clearPreview();
      return false;
    }
    const n = this.selection.size || this.index.size;
    const r = await dispatch<{ ids?: string[] }>(cmd, { ...t, ids: this.scope(), ...args }, label ? { label } : undefined);
    this.clearPreview();
    if (r.ok) {
      if (r.data?.ids) {
        this.selection.clear();
        for (const id of r.data.ids) this.selection.add(id);
      }
      this.contentL.dirty = this.laneL.dirty = true;
      if (label) flashHint(`${label} · ${n} note${n === 1 ? '' : 's'}${this.selection.size ? '' : ' (whole channel)'}`, 'ok');
    }
    return r.ok;
  }

  previewTool(cmd: string, args: Record<string, unknown>): string | null {
    const t = this.target();
    const def = NOTE_TOOL_COMMANDS.find((c) => c.id === cmd) as CommandDef | undefined;
    const p = getProject();
    const pat = t ? p?.patterns[t.patternId] : undefined;
    if (!t || !def || !pat) {
      this.clearPreview();
      return 'Select a pattern and a channel first';
    }
    const parsed = def.args.safeParse({ ...t, ids: this.scope(), ...args });
    if (!parsed.success) {
      this.clearPreview();
      return parsed.error.issues[0]?.message ?? 'Invalid settings';
    }
    const orig = pat.notes[t.channelId] ?? {};
    const scratch = structuredClone(orig);
    const draft = { ...p, patterns: { ...p.patterns, [pat.id]: { ...pat, notes: { ...pat.notes, [t.channelId]: scratch } } } } as Project;
    let i = 0;
    try {
      def.run(draft, parsed.data, { catalog: CATALOG, newId: (prefix) => `${prefix}_preview${++i}` });
    } catch (err) {
      this.clearPreview();
      return (err as Error).message;
    }
    const hide = new Set(this.scope() ?? Object.keys(orig));
    const out = Object.values(draft.patterns[pat.id].notes[t.channelId] ?? {});
    this.preview = { hide, notes: out.filter((n) => hide.has(n.id) || !orig[n.id]) };
    this.contentL.dirty = this.overlayL.dirty = true;
    return null;
  }

  showSyllables(marks: SyllableMark[] | null): void {
    if (!marks?.length && !this.syllables) return;
    this.syllables = marks?.length ? marks : null;
    this.overlayL.dirty = true;
  }

  clearPreview(): void {
    if (!this.preview) return;
    this.preview = null;
    this.contentL.dirty = this.overlayL.dirty = true;
  }

  showPlannedNotes(plan: { remove: string[]; notes: Array<Omit<Note, 'id' | 'pan' | 'release' | 'fine' | 'slide' | 'modX' | 'modY'> & Partial<Note>> }): void {
    this.preview = {
      hide: new Set(plan.remove),
      notes: plan.notes.map((n, i) => ({ pan: 0, release: 0.5, fine: 0, slide: false, modX: 0.5, modY: 0.5, ...n, id: `script_preview${i}` })),
    };
    this.contentL.dirty = this.overlayL.dirty = true;
  }

  selectIds(ids: string[]): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.contentL.dirty = this.laneL.dirty = true;
  }

  selectedIds(): string[] | undefined {
    return this.scope();
  }

  planGenerate(args: Record<string, unknown>, allowSame = false): { plan: GeneratePlan } | { error: string } {
    const t = this.target();
    const p = getProject();
    if (!t || !p) return { error: 'Select a pattern and a channel first' };
    const parsed = GENERATE_ARGS.safeParse({ ...t, ids: this.scope(), ...args });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid settings' };
    try {
      return { plan: planGenerate(p, parsed.data, { allowSame }) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  previewGenerate(args: Record<string, unknown>): { plan: GeneratePlan } | { error: string } {
    const r = this.planGenerate(args);
    if ('error' in r) {
      this.clearPreview();
      return r;
    }
    this.preview = { hide: new Set(r.plan.remove), notes: r.plan.notes.map((n, i) => ({ ...n, id: `gen_preview${i}` })) };
    this.contentL.dirty = this.overlayL.dirty = true;
    return r;
  }

  async runGenerate(args: Record<string, unknown>, label: string): Promise<boolean> {
    const t = this.target();
    if (!t) {
      toast.info('Select a pattern and a channel first');
      return false;
    }
    this.stopAudition();
    const r = await dispatch<{ ids: string[]; count: number; key: string; range: { fromBar: number; bars: number }; seed: number }>('notes.generate', { ...t, ids: this.scope(), ...args }, { label });
    this.clearPreview();
    if (r.ok && r.data) {
      this.selection.clear();
      for (const id of r.data.ids) this.selection.add(id);
      this.contentL.dirty = this.laneL.dirty = true;
      const { fromBar, bars } = r.data.range;
      flashHint(`${label} · ${r.data.count} note${r.data.count === 1 ? '' : 's'} · bar${bars === 1 ? ` ${fromBar}` : `s ${fromBar}–${fromBar + bars - 1}`} · ${r.data.key} · seed ${r.data.seed}`, 'ok');
    }
    return r.ok;
  }

  private audTimers: number[] = [];

  auditionNotes(notes: Array<{ tick: number; dur: number; key: number; vel: number }>, from: number, to: number): number {
    this.stopAudition();
    const ch = this.channelId;
    const p = getProject();
    if (!ch || !p) return 0;
    const ms = (t: number): number => ticksToSeconds(Math.max(0, t), p.transport.bpm) * 1000;
    const win = this.els?.root.ownerDocument.defaultView ?? window;
    for (const n of notes) {
      if (n.tick < from || n.tick >= to) continue;
      this.audTimers.push(
        win.setTimeout(() => {
          try {
            window.krypt.engine.audition(ch, n.key, n.vel, true);
          } catch {
          }
        }, ms(n.tick - from)),
        win.setTimeout(() => {
          try {
            window.krypt.engine.audition(ch, n.key, 0, false);
          } catch {
          }
        }, ms(Math.min(n.tick + n.dur, to) - from)),
      );
    }
    return ms(to - from);
  }

  stopAudition(): void {
    if (!this.audTimers.length) return;
    const win = this.els?.root.ownerDocument.defaultView ?? window;
    for (const id of this.audTimers) win.clearTimeout(id);
    this.audTimers = [];
    try {
      window.krypt.engine.auditionOff();
    } catch {
    }
  }

  private newNoteLook(): { color?: number; slide?: boolean } {
    const v = usePianoRollView.getState();
    return { ...(v.noteColor ? { color: v.noteColor } : {}), ...(v.slideMode ? { slide: true } : {}) };
  }

  private playheadTick(): number | null {
    const f = telemetry.frame;
    const len = Math.max(1, this.patLen);
    if (!f) {
      if (!playState.playing()) return this.localPlayhead;
      const p = getProject();
      if (p?.transport.mode === 'pattern') return p.transport.activePatternId === this.patternId ? playState.tick() % len : null;
      return this.songToPattern(playState.tick(), len);
    }
    if (f.mode === 'pattern') {
      if (f.patternId && f.patternId !== this.patternId) return null;
      return telemetry.playheadTick() % len;
    }
    return this.songToPattern(telemetry.playheadTick(), len);
  }

  private songToPattern(song: number, len: number): number | null {
    for (const c of this.patternClips) {
      if (song >= c.start && song < c.start + c.length) return (song - c.start + c.offset) % len;
    }
    return null;
  }

  private followPlayhead(now: number): void {
    if (!usePianoRollView.getState().follow || this.drag || now - this.lastManualScroll < 1500 || !this.patternId) return;
    if (!(telemetry.frame ? telemetry.playing : playState.playing())) return;
    const t = this.playheadTick();
    if (t === null) return;
    const vt = viewTicks(this.tv, this.gridL.w || 1);
    if (t < this.tv.scrollTick || t > this.tv.scrollTick + vt * 0.97) this.setScrollTick(Math.max(0, t - vt * 0.04), true);
  }

  private updatePlayheads(): void {
    const els = this.els;
    if (!els) return;
    const t = this.patternId ? this.playheadTick() : null;
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
      for (const l of [this.gridL, this.contentL, this.overlayL, this.keysL, this.rulerL, this.laneL]) l.resize(l.w, l.h);
    }
    this.autoScroll();
    this.followPlayhead(now);
    const glowing = this.glow.size > 0 && this.glow.active(now);
    if (glowing || this.glowWasActive) this.contentL.dirty = true;
    this.glowWasActive = glowing;

    if (this.gridL.dirty) this.paintGrid();
    if (this.contentL.dirty) this.paintContent(now);
    if (this.overlayL.dirty) this.paintOverlay();
    if (this.keysL.dirty) this.paintKeys();
    if (this.rulerL.dirty) this.paintRulerLayer();
    if (this.laneL.dirty) this.paintLaneLayer();
    this.updatePlayheads();
  }

  private autoScroll(): void {
    const d = this.drag;
    const p = this.ptr;
    const o = this.downPt;
    if (o && !o.armed && Math.hypot((p?.x ?? o.x) - o.x, (p?.y ?? o.y) - o.y) >= 6) o.armed = true;
    if (!o?.armed) return;
    if (!d || !p || d.kind === 'pan' || d.kind === 'lane' || ('committing' in d && d.committing)) return;
    const sx = edgeScrollStep(p.x, 0, this.gridL.w);
    const sy = d.kind === 'paint' ? 0 : edgeScrollStep(p.y, 0, this.gridL.h);
    if (!sx && !sy) return;
    const before = this.tv.scrollTick + this.kv.scrollY;
    if (sx) this.setScrollTick(this.tv.scrollTick + sx / this.tv.pxPerTick, sx > 0);
    if (sy) this.setScrollY(this.kv.scrollY + sy);
    if (this.tv.scrollTick + this.kv.scrollY !== before) this.updateDrag();
  }

  private paintGrid(): void {
    const ctx = this.gridL.begin();
    if (!ctx) return;
    const { w, h, dpr } = this.gridL;
    paintKeyRows(ctx, this.kv, w, h, dpr, this.scaleMask());
    paintTimeGrid(ctx, this.tv, w, h, this.ts, dpr, { snapGrid: this.snapGrid(), shadeAltBars: true, endTick: this.patLen });
  }

  private hiddenIds(): Set<string> | null {
    const d = this.drag;
    if (this.preview && !d) return this.preview.hide;
    if (!d) return null;
    if (d.kind === 'move' && !d.copy && d.moved) return new Set(d.ids);
    if (d.kind === 'resize') return new Set(d.ids);
    if (d.kind === 'erase') return d.ids;
    return null;
  }

  private paintContent(now: number): void {
    const ctx = this.contentL.begin();
    if (!ctx || !this.target()) return;
    const { w, h, dpr } = this.contentL;
    if (usePianoRollView.getState().ghosts) {
      const dense = this.kv.rowH < 8 || this.tv.pxPerTick * TICKS_PER_STEP < 3;
      for (const g of this.ghosts) {
        if (dense) ctx.fillStyle = rgba(g.color, 0.25);
        forVisibleNotes(g.index, this.tv, this.kv, w, h, (n) => {
          const [x, y, nw, nh] = noteRect(n, this.tv, this.kv);
          if (dense) ctx.fillRect(x, y, Math.max(1, nw - 0.5), Math.max(1, nh - 0.5));
          else drawNote(ctx, x, y, nw, nh, n, dpr, { ghostColor: g.color });
        });
      }
    }
    const hidden = this.hiddenIds();
    const laneVel = this.drag?.kind === 'lane' && this.drag.prop === 'vel' ? this.drag.values : null;
    const muteDrag = this.drag?.kind === 'mute' && this.drag.value !== null ? this.drag : null;
    const look = (n: Note): Note => {
      const vel = laneVel?.get(n.id);
      const mute = muteDrag?.ids.has(n.id) ? muteDrag.value! : undefined;
      return vel === undefined && mute === undefined ? n : { ...n, vel: vel ?? n.vel, mute: mute ?? n.mute };
    };
    const velAlpha = usePianoRollView.getState().velAlpha;
    const labels = this.kv.rowH >= 11;
    const chan = this.channelId ? getProject()?.channels[this.channelId] : undefined;
    const porta = chan && chan.poly.mono && chan.poly.glideMs > 0 ? secondsToTicks(chan.poly.glideMs / 1000, getProject().transport.bpm) : null;
    paintGlides(ctx, this.index, this.tv, this.kv, w, porta, hidden);
    if (this.kv.rowH < 8 || this.tv.pxPerTick * TICKS_PER_STEP < 3) {
      let last = '';
      let lastA = 1;
      forVisibleNotes(this.index, this.tv, this.kv, w, h, (n) => {
        if (hidden?.has(n.id)) return;
        const sel = this.selection.has(n.id);
        const { fill, alpha } = noteFill(look(n), velAlpha);
        const col = sel ? '#F5D0FE' : fill;
        const a = sel ? 1 : alpha;
        if (col !== last) {
          ctx.fillStyle = col;
          last = col;
        }
        if (a !== lastA) {
          ctx.globalAlpha = a;
          lastA = a;
        }
        const [x, y, nw, nh] = noteRect(n, this.tv, this.kv);
        ctx.fillRect(x, y, Math.max(1, nw - 0.5), Math.max(1, nh - 0.5));
        const g = this.glow.alpha(n.id, now);
        if (g > 0) {
          ctx.globalAlpha = lastA = 1;
          ctx.fillStyle = rgba(C.glow, g);
          ctx.fillRect(x - 1, y - 1, Math.max(1, nw) + 2, Math.max(1, nh) + 2);
          last = '';
        }
      });
      ctx.globalAlpha = 1;
      return;
    }
    forVisibleNotes(this.index, this.tv, this.kv, w, h, (n) => {
      if (hidden?.has(n.id)) return;
      const [x, y, nw, nh] = noteRect(n, this.tv, this.kv);
      drawNote(ctx, x, y, nw, nh, look(n), dpr, {
        selected: this.selection.has(n.id),
        glow: this.glow.alpha(n.id, now),
        labels,
        velAlpha,
      });
    });
  }

  private paintOverlay(): void {
    const ctx = this.overlayL.begin();
    if (!ctx) return;
    const { w, h, dpr } = this.overlayL;
    const d = this.drag;
    const kv = this.kv;
    const tv = this.tv;
    if (!d && this.hover && this.target()) {
      const y = keyToY(kv, this.hover.key);
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fillRect(0, y, w, kv.rowH);
      const n = this.hover.noteId ? this.note(this.hover.noteId) : undefined;
      if (n) {
        const [x, ny, nw, nh] = noteRect(n, tv, kv);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        if (this.hover.zone === 'right') ctx.fillRect(x + nw - 3, ny + 1, 2, nh - 3);
        else if (this.hover.zone === 'left') ctx.fillRect(x + 1, ny + 1, 2, nh - 3);
      }
    }
    const labels = kv.rowH >= 11;
    const velAlpha = usePianoRollView.getState().velAlpha;
    if (!d && this.syllables) paintSyllables(ctx, this.syllables, tv, kv, w, h);
    if (!d && this.preview) {
      for (const n of this.preview.notes) {
        const [x, y, nw, nh] = noteRect(n, tv, kv);
        if (x > w || x + nw < 0 || y > h || y + nh < 0) continue;
        drawNote(ctx, x, y, nw, nh, n, dpr, { labels, velAlpha, preview: true });
      }
    }
    if (!d) return;
    const preview = (n: PreviewNote, sel: boolean) => {
      const [x, y, nw, nh] = noteRect(n, tv, kv);
      if (x > w || x + nw < 0 || y > h || y + nh < 0) return;
      drawNote(ctx, x, y, nw, nh, n, dpr, { selected: sel, labels, velAlpha });
    };
    switch (d.kind) {
      case 'create':
      case 'paint':
        for (const n of d.notes) preview(n, false);
        break;
      case 'move':
        if (!d.moved) break;
        for (const o of d.origins.values()) preview({ ...o, tick: o.tick + d.dT, key: o.key + d.dK }, d.ids.length > 1 || this.selection.has(o.id));
        this.guide(ctx, tickToX(tv, d.primary.tick + d.dT), h, dpr);
        break;
      case 'resize':
        for (const o of d.origins.values()) preview({ ...o, ...this.resized(o, d.edge, d.dT) }, this.selection.has(o.id));
        {
          const pr = this.resized(d.primary, d.edge, d.dT);
          this.guide(ctx, tickToX(tv, d.edge === 'right' ? pr.tick + pr.dur : pr.tick), h, dpr);
        }
        break;
      case 'marquee': {
        const p = this.ptr;
        if (!p) break;
        const x0 = tickToX(tv, d.tickA);
        const y0 = d.yA - kv.scrollY;
        const rx = Math.min(x0, p.x);
        const ry = Math.min(y0, p.y);
        ctx.fillStyle = C.marquee;
        ctx.fillRect(rx, ry, Math.abs(p.x - x0), Math.abs(p.y - y0));
        ctx.strokeStyle = C.marqueeEdge;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.round(rx * dpr) / dpr + 0.5 / dpr, Math.round(ry * dpr) / dpr + 0.5 / dpr, Math.abs(p.x - x0), Math.abs(p.y - y0));
        ctx.setLineDash([]);
        break;
      }
      case 'erase':
      case 'mute': {
        const p = this.ptr;
        if (p) {
          ctx.strokeStyle = d.kind === 'mute' ? 'rgba(250,204,21,0.75)' : 'rgba(244,63,94,0.7)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'slice': {
        const xa = tickToX(tv, d.tickA);
        const xb = tickToX(tv, d.tickB);
        const ya = d.yA - kv.scrollY;
        const yb = d.yB - kv.scrollY;
        ctx.fillStyle = rgba(C.pink, 0.25);
        ctx.fillRect(Math.round(xb * dpr) / dpr, 0, 1 / dpr, h);
        ctx.strokeStyle = C.pink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xa, ya === yb ? ya - kv.rowH / 2 : ya);
        ctx.lineTo(xb, ya === yb ? yb + kv.rowH / 2 : yb);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        for (const c of this.sliceCuts(d)) {
          const y = keyToY(kv, c.note.key);
          ctx.fillRect(tickToX(tv, c.at) - 1, y, 2, kv.rowH - 1);
        }
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

  private paintKeys(): void {
    const ctx = this.keysL.begin();
    if (!ctx) return;
    paintKeyboard(ctx, this.kv, this.keysL.w, this.keysL.h, this.keysL.dpr, this.pressedKeys, this.scaleMask(), this.hover?.key ?? null);
  }

  private paintRulerLayer(): void {
    const ctx = this.rulerL.begin();
    if (!ctx) return;
    paintRuler(ctx, this.tv, this.rulerL.w, this.rulerL.h, this.ts, this.rulerL.dpr, { endTick: this.patLen });
  }

  private paintLaneLayer(): void {
    const ctx = this.laneL.begin();
    if (!ctx) return;
    const d = this.drag;
    const prop = usePianoRollView.getState().lane;
    const override = d?.kind === 'lane' && d.prop === prop ? d.values : null;
    let moved: Map<string, { tick: number }> | null = null;
    if (d?.kind === 'move' && d.moved && !d.copy) {
      moved = new Map();
      for (const o of d.origins.values()) moved.set(o.id, { tick: o.tick + d.dT });
    } else if (d?.kind === 'resize' && d.edge === 'left') {
      moved = new Map();
      for (const o of d.origins.values()) moved.set(o.id, { tick: this.resized(o, 'left', d.dT).tick });
    }
    const idx = this.target() ? this.index : EMPTY_INDEX;
    paintLane(ctx, this.tv, this.laneL.w, this.laneL.h, this.laneL.dpr, prop, idx, this.selection, override, moved, d?.kind === 'erase' ? d.ids : null);
  }
}

export function prRows(laneH: number): string {
  return `${PR.rulerH}px minmax(0,1fr) ${PR.split}px ${laneH}px ${PR.sb}px`;
}

export interface SyllableMark {
  tick: number;
  key: number;
  dur: number;
  text: string;
  kind: 'start' | 'hold' | 'extra';
}

function paintSyllables(ctx: CanvasRenderingContext2D, marks: readonly SyllableMark[], tv: TimeView, kv: KeyView, w: number, h: number): void {
  ctx.save();
  ctx.font = `600 10px ${FONT_SANS}`;
  ctx.textBaseline = 'middle';
  for (const m of marks) {
    const [x, y, nw] = noteRect(m, tv, kv);
    if (x > w || x + Math.max(nw, 40) < 0 || y > h + 16 || y < -16) continue;
    if (m.kind === 'hold') {
      ctx.strokeStyle = 'rgba(236,72,153,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 2, y - 4);
      ctx.quadraticCurveTo(x + nw / 2, y - 9, x + nw - 2, y - 4);
      ctx.stroke();
      continue;
    }
    const label = m.text || '·';
    const tw = ctx.measureText(label).width;
    const bw = tw + 8;
    const bh = 14;
    const bx = Math.round(x);
    const by = Math.round(y - bh - 2);
    ctx.fillStyle = m.kind === 'extra' ? 'rgba(245,158,11,0.9)' : 'rgba(10,8,20,0.88)';
    ctx.strokeStyle = m.kind === 'extra' ? 'rgba(253,230,138,0.9)' : 'rgba(236,72,153,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx + 0.5, by + 0.5, bw, bh, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = m.kind === 'extra' ? '#1a1206' : '#ffffff';
    ctx.fillText(label, bx + 4.5, by + bh / 2 + 1);
  }
  ctx.restore();
}
