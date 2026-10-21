// ──────────────────────────────────────────────────────────────────────
// Playlist audio-clip fades (Wave 12.2b): the two handles at an audio
// clip's top corners, dragging them, and the fade lines drawn over the
// waveform. The engine's fades are linear gain ramps (core.rs ClipEnv), so
// the lines are straight: what you see is what plays. Alt-dragging the
// fade-in handle of a clip that touches the previous audio clip makes a
// crossfade instead (playlist.crossfade). Geometry here is pure + tested.
// ──────────────────────────────────────────────────────────────────────

import type { Clip } from '@shared/schema/project';
import { clampFades } from '@shared/commands/fades';
import { tickToX, type TimeView } from '../../editors/viewport';
import { rgba } from '../../editors/theme';

/** Grab radius around a handle, in px. */
export const FADE_HANDLE_PX = 7;
/** How far below the clip's top edge a handle can be grabbed, in px. */
export const FADE_ZONE_H = 10;
/** Drawn handle size, in px. */
const HANDLE = 5;

export type FadeEdge = 'in' | 'out';

export interface FadeDrag {
  clipId: string;
  which: FadeEdge;
  orig: Clip;
  /** The fade length being dragged (ticks). */
  len: number;
  /** Alt held at grab: crossfade with the previous clip instead. */
  crossfade: boolean;
  downX: number;
  moved: boolean;
  committing?: boolean;
}

/** Screen x of the fade-in end and the fade-out start (the handle positions). */
export function fadeHandleXs(c: Clip, tv: TimeView): { inX: number; outX: number } {
  return { inX: tickToX(tv, c.start + (c.fadeIn ?? 0)), outX: tickToX(tv, c.start + c.length - (c.fadeOut ?? 0)) };
}

/** The fade handle under (x, y) for an audio clip whose box starts at `clipTop` (screen px); null when none. */
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

/** The fade length for a handle dragged to song tick `tick`: never negative, never past the other fade. */
export function fadeLenAt(c: Clip, which: FadeEdge, tick: number): number {
  const raw = which === 'in' ? tick - c.start : c.start + c.length - tick;
  const f = which === 'in' ? clampFades(c.length, raw, c.fadeOut ?? 0, 'out') : clampFades(c.length, c.fadeIn ?? 0, raw, 'in');
  return which === 'in' ? f.fadeIn : f.fadeOut;
}

/** The clip as it looks mid-drag. */
export function withFade(c: Clip, which: FadeEdge, len: number): Clip {
  return which === 'in' ? { ...c, fadeIn: len } : { ...c, fadeOut: len };
}

/** "1/2 beat", "2 beats", "1 bar 1 beat"-style readout for the drag label. */
export function fadeLabel(ticks: number, ticksPerBeat: number): string {
  if (ticks <= 0) return 'No fade';
  const beats = ticks / ticksPerBeat;
  const r = Math.round(beats * 100) / 100;
  return `${r} beat${r === 1 ? '' : 's'}`;
}

export interface FadeLines {
  /** Fade-in line from (x0, bottom) up to (x1, top); null when there is no fade-in. */
  fadeIn: { x0: number; x1: number } | null;
  fadeOut: { x0: number; x1: number } | null;
}

/** Where the fade lines run on screen (pure). */
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

/**
 * Draw an audio clip's fades: the silenced triangle shaded, the gain line, and the two corner handles.
 * `top`/`h` = the clip box, `bodyTop`/`bodyH` = the waveform area under the header.
 */
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
  // Corner handles (grab them to fade).
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
