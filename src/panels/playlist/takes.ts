// Take lanes in the playlist (Wave 12.2b): the swipe-comp gesture and the
// lane painting, kept out of controller.ts (which only forwards pointer
// events, asks for the layout and calls the painters). Each finished swipe
// is ONE takes.select command = one undo step.

import type { Clip, Project } from '@shared/schema/project';
import type { Take, TakeGroup } from '@shared/schema/takes';
import { dispatch } from '../../doc/store';
import { flashHint } from '../../app/hints';
import { tickToX, visibleLanes, xToTick, type TimeView } from '../../editors/viewport';
import { C, rgba } from '../../editors/theme';
import { paintClip } from './paint';
import { useTakeLanes } from './takesStore';
import { buildTrackLanes, compPartsOf, laneTakeAt, laneTakes, swipeRange, takeLaneAt, takeLaneCount, takeLaneH, type TrackLaneLayout } from './takesLayout';

export { buildTrackLanes, type TrackLaneLayout };

export interface TakeLanesHost {
  project(): Project | null;
  lanes(): TrackLaneLayout;
  scrollY(): number;
  tv(): TimeView;
  grid(): number;
  scale(): number;
  /** Repaint content + overlay. */
  invalidate(): void;
}

interface Swipe {
  trackId: string;
  lane: number;
  group: TakeGroup;
  take: Take;
  a: number;
  b: number;
  downX: number;
  moved: boolean;
  alt: boolean;
}

/** The fake clip that draws a whole take in its lane (waveform / notes through paintClip). */
export function takeClip(g: TakeGroup, t: Take): Clip {
  const base = { id: `__take_${t.id}`, trackId: g.trackId, start: t.start, length: Math.max(1, t.end - t.start), offset: Math.max(0, t.start - t.origin), mute: false, color: null };
  return t.source.kind === 'audio'
    ? { ...base, kind: 'audio', channelId: t.source.channelId, gain: 1, fadeIn: 0, fadeOut: 0 }
    : { ...base, kind: 'pattern', patternId: t.source.patternId };
}

export class TakeLanes {
  private swipe: Swipe | null = null;
  private groupsRec: Project['takeGroups'] | null | undefined = null;

  constructor(private readonly h: TakeLanesHost) {}

  /** Subscribe to the expand / collapse state (the controller rebuilds its lanes). */
  subscribe(fn: () => void): () => void {
    return useTakeLanes.subscribe((s, prev) => {
      if (s.open !== prev.open) fn();
    });
  }

  /** The take groups changed since the last call (new groups open their lanes). */
  changed(p: Project): boolean {
    const prev = this.groupsRec;
    if (p.takeGroups === prev) return false;
    this.groupsRec = p.takeGroups;
    if (prev !== null) {
      for (const g of Object.values(p.takeGroups ?? {})) if (!prev?.[g.id] && !useTakeLanes.getState().open[g.trackId]) useTakeLanes.getState().toggle(g.trackId, true);
    }
    return true;
  }

  /** Take-lane pixels under a track's clip row. */
  extra(p: Project, trackId: string, scale: number): number {
    if (!useTakeLanes.getState().open[trackId]) return 0;
    return takeLaneCount(p, trackId) * takeLaneH(scale);
  }

  private hit(y: number): { track: number; lane: number } | null {
    return takeLaneAt(this.h.lanes(), y + this.h.scrollY(), takeLaneH(this.h.scale()));
  }

  /** Pointer down on the grid: true = it was on a take lane and is handled here. */
  down(e: PointerEvent, x: number, y: number): boolean {
    const hit = this.hit(y);
    const p = this.h.project();
    if (!hit || !p || e.button === 1) return false; // middle button: the controller pans
    if (e.button !== 0) return true; // right click on a lane: nothing to erase here
    const trackId = this.h.lanes().ids[hit.track];
    const tick = xToTick(this.h.tv(), x);
    const at = laneTakeAt(p, trackId, hit.lane, tick);
    if (!at) {
      flashHint('Nothing was recorded here in this take');
      return true;
    }
    this.swipe = { trackId, lane: hit.lane, group: at.group, take: at.take, a: tick, b: tick, downX: x, moved: false, alt: e.altKey };
    this.h.invalidate();
    return true;
  }

  /** Pointer move: true = a swipe is running or the pointer is over a take lane (no clip hover). */
  move(x: number, y: number, alt: boolean): boolean {
    const s = this.swipe;
    if (s) {
      s.b = xToTick(this.h.tv(), x);
      s.alt = alt;
      if (Math.abs(x - s.downX) > 3) s.moved = true;
      this.h.invalidate();
      return true;
    }
    return !!this.hit(y);
  }

  get active(): boolean {
    return !!this.swipe;
  }

  cancel(): void {
    this.swipe = null;
    this.h.invalidate();
  }

  /** Pointer up: commit the swipe. true = handled. */
  up(): boolean {
    const s = this.swipe;
    if (!s) return false;
    this.swipe = null;
    this.h.invalidate();
    if (!s.moved) {
      flashHint('Drag across a take to use it there · click a take name to use the whole take');
      return true;
    }
    const r = swipeRange(s.a, s.b, this.h.grid(), s.alt);
    void dispatch<{ changed: boolean }>('takes.select', { groupId: s.group.id, takeId: s.take.id, start: r.start, end: r.end }, { label: `Comp ${s.take.name}` }).then((res) => {
      if (res.ok && res.data && !res.data.changed) flashHint(`${s.take.name} already plays there`);
    });
    return true;
  }

  // ── Painting ─────────────────────────────────────────────────────────

  /** Content layer: every visible take lane (after the clips). */
  paint(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
    const p = this.h.project();
    if (!p?.takeGroups) return;
    const l = this.h.lanes();
    const tv = this.h.tv();
    const sy = this.h.scrollY();
    const lh = takeLaneH(this.h.scale());
    const [a, b] = visibleLanes(l, sy, h);
    const base = { dpr, ts: p.transport.timeSig, bpm: p.transport.bpm, glow: 0 };
    for (let i = a; i <= b; i++) {
      if (!l.extra[i]) continue;
      const trackId = l.ids[i];
      const top0 = l.tops[i] + l.heights[i] - sy;
      const n = Math.round(l.extra[i] / lh);
      for (let k = 0; k < n; k++) {
        const y = top0 + k * lh;
        if (y > h || y + lh < 0) continue;
        ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.22)';
        ctx.fillRect(0, y, w, lh);
        ctx.fillStyle = C.rowLine;
        ctx.fillRect(0, Math.round((y + lh) * dpr) / dpr - 1 / dpr, w, 1 / dpr);
        for (const { group, take } of laneTakes(p, trackId, k)) {
          const clip = takeClip(group, take);
          // The whole take, dimmed …
          paintClip(ctx, p, clip, tv, y, lh, w, { ...base, selected: false, ghost: true, label: take.name });
          // … and at full strength where the comp uses it, with an accent bar on top.
          for (const part of compPartsOf(group, take.id)) {
            const x0 = tickToX(tv, part.start);
            const x1 = tickToX(tv, part.end);
            if (x1 < 0 || x0 > w) continue;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0, y, x1 - x0, lh);
            ctx.clip();
            paintClip(ctx, p, clip, tv, y, lh, w, { ...base, selected: true, label: take.name });
            ctx.restore();
            ctx.fillStyle = rgba(C.pink, 0.9);
            ctx.fillRect(Math.max(0, x0), y + 1, Math.min(w, x1) - Math.max(0, x0), 2);
          }
        }
      }
    }
  }

  /** Overlay layer: the swipe preview. */
  paintOverlay(ctx: CanvasRenderingContext2D): void {
    const s = this.swipe;
    if (!s || !s.moved) return;
    const l = this.h.lanes();
    const i = l.ids.indexOf(s.trackId);
    if (i < 0) return;
    const lh = takeLaneH(this.h.scale());
    const tv = this.h.tv();
    const r = swipeRange(s.a, s.b, this.h.grid(), s.alt);
    const start = Math.max(r.start, s.take.start, s.group.start);
    const end = Math.min(r.end, s.take.end, s.group.end);
    if (!(end > start)) return;
    const y = l.tops[i] + l.heights[i] + s.lane * lh - this.h.scrollY();
    const x0 = tickToX(tv, start);
    const x1 = tickToX(tv, end);
    ctx.fillStyle = rgba(C.pink, 0.22);
    ctx.fillRect(x0, y + 1, x1 - x0, lh - 2);
    ctx.fillStyle = rgba(C.pink, 0.95);
    ctx.fillRect(x0, y + 1, 1.5, lh - 2);
    ctx.fillRect(x1 - 1.5, y + 1, 1.5, lh - 2);
    // The same range on the comp row above.
    ctx.fillStyle = rgba(C.pink, 0.12);
    ctx.fillRect(x0, l.tops[i] - this.h.scrollY(), x1 - x0, l.heights[i]);
  }
}

/** Header-column data for one track's lanes (TakeLaneHeaders). */
export function laneHeaderInfo(p: Project, trackId: string): Array<{ label: string; inComp: boolean; takes: Array<{ groupId: string; takeId: string; pass: number }> }> {
  const n = takeLaneCount(p, trackId);
  const out: Array<{ label: string; inComp: boolean; takes: Array<{ groupId: string; takeId: string; pass: number }> }> = [];
  for (let k = 0; k < n; k++) {
    const xs = laneTakes(p, trackId, k);
    out.push({
      label: xs[0]?.take.name ?? `Take ${k + 1}`,
      inComp: xs.some(({ group, take }) => group.comp.some((s) => s.takeId === take.id)),
      takes: xs.map(({ group, take }) => ({ groupId: group.id, takeId: take.id, pass: take.pass })),
    });
  }
  return out;
}

