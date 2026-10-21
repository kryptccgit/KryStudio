import type { Clip } from '@shared/schema/project';
import { clampFades } from '@shared/commands/fades';
import { tickToX, type TimeView } from '../../editors/viewport';
import { rgba } from '../../editors/theme';

export const FADE_HANDLE_PX = 7;
export const FADE_ZONE_H = 10;
const HANDLE = 5;

export type FadeEdge = 'in' | 'out';

export interface FadeDrag {
  clipId: string;
  which: FadeEdge;
  orig: Clip;
  len: number;
  crossfade: boolean;
  downX: number;
  moved: boolean;
  committing?: boolean;
}

export function fadeHandleXs(c: Clip, tv: TimeView): { inX: number; outX: number } {
  return { inX: tickToX(tv, c.start + (c.fadeIn ?? 0)), outX: tickToX(tv, c.start + c.length - (c.fadeOut ?? 0)) };
}

export function hitFadeHandle(c: Clip, tv: TimeView, clipTop: number, x: number, y: number): FadeEdge | null {
  if (c.kind !== 'audio') return null;
  if (y < clipTop - 2 || y > clipTop + FADE_ZONE_H) return null;
  const x0 = tickToX(tv, c.start);
  const x1 = tickToX(tv, c.start + c.length);
  if (x < x0 - 2 || x > x1 + 2 || x1 - x0 < 2 * FADE_HANDLE_PX) return null;
  const { inX, outX } = fadeHandleXs(c, tv);
  const dIn = Math.abs(x - inX);
  const dOut = Math.abs(x - outX);
  if (dIn > FADE_HANDLE_PX && dOut > FADE_HANDLE_PX) return null;
  return dIn <= dOut ? 'in' : 'out';
}

export function fadeLenAt(c: Clip, which: FadeEdge, tick: number): number {
  const raw = which === 'in' ? tick - c.start : c.start + c.length - tick;
  const f = which === 'in' ? clampFades(c.length, raw, c.fadeOut ?? 0, 'out') : clampFades(c.length, c.fadeIn ?? 0, raw, 'in');
  return which === 'in' ? f.fadeIn : f.fadeOut;
}

export function withFade(c: Clip, which: FadeEdge, len: number): Clip {
  return which === 'in' ? { ...c, fadeIn: len } : { ...c, fadeOut: len };
}

export function fadeLabel(ticks: number, ticksPerBeat: number): string {
  if (ticks <= 0) return 'No fade';
  const beats = ticks / ticksPerBeat;
  const r = Math.round(beats * 100) / 100;
  return `${r} beat${r === 1 ? '' : 's'}`;
}

export interface FadeLines {
  fadeIn: { x0: number; x1: number } | null;
  fadeOut: { x0: number; x1: number } | null;
}

export function fadeLines(c: Clip, tv: TimeView): FadeLines {
  const xs = tickToX(tv, c.start);
  const xe = tickToX(tv, c.start + c.length);
  const fi = c.fadeIn ?? 0;
  const fo = c.fadeOut ?? 0;
  return {
    fadeIn: fi > 0 ? { x0: xs, x1: tickToX(tv, c.start + fi) } : null,
    fadeOut: fo > 0 ? { x0: tickToX(tv, c.start + c.length - fo), x1: xe } : null,
  };
}

export function paintFades(ctx: CanvasRenderingContext2D, c: Clip, tv: TimeView, top: number, h: number, bodyTop: number, bodyH: number, color: string): void {
  if (c.kind !== 'audio' || h < 10) return;
  const L = fadeLines(c, tv);
  const bot = bodyTop + bodyH;
  ctx.save();
  if (L.fadeIn || L.fadeOut) {
    ctx.fillStyle = 'rgba(5,5,10,0.55)';
    ctx.beginPath();
    if (L.fadeIn) {
      ctx.moveTo(L.fadeIn.x0, bodyTop);
      ctx.lineTo(L.fadeIn.x1, bodyTop);
      ctx.lineTo(L.fadeIn.x0, bot);
      ctx.closePath();
    }
    if (L.fadeOut) {
      ctx.moveTo(L.fadeOut.x0, bodyTop);
      ctx.lineTo(L.fadeOut.x1, bodyTop);
      ctx.lineTo(L.fadeOut.x1, bot);
      ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    if (L.fadeIn) {
      ctx.moveTo(L.fadeIn.x0, bot);
      ctx.lineTo(L.fadeIn.x1, bodyTop);
    }
    if (L.fadeOut) {
      ctx.moveTo(L.fadeOut.x0, bodyTop);
      ctx.lineTo(L.fadeOut.x1, bot);
    }
    ctx.stroke();
  }
  const { inX, outX } = fadeHandleXs(c, tv);
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = rgba(color, 1);
  ctx.lineWidth = 1;
  for (const [x, left] of [
    [inX, true],
    [outX, false],
  ] as const) {
    const hx = left ? x : x - HANDLE;
    ctx.fillRect(hx, top, HANDLE, HANDLE);
    ctx.strokeRect(hx + 0.5, top + 0.5, HANDLE - 1, HANDLE - 1);
  }
  ctx.restore();
}
