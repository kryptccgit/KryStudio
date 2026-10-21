import { useLayoutEffect, useState, type RefObject } from 'react';
import { scopeBinHz } from '@shared/engine/meters';
import { freqToX } from './eqResponse';

export const C = {
  indigo: '#6366F1',
  purple: '#A855F7',
  pink: '#EC4899',
  grid: 'rgba(255,255,255,0.06)',
  gridStrong: 'rgba(255,255,255,0.14)',
  text: 'rgba(161,161,170,0.85)',
  amber: '#f59e0b',
};

export function useWidth(ref: RefObject<HTMLElement | null>, initial = 320): number {
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => setW(Math.max(80, Math.floor(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function accentGradient(ctx: CanvasRenderingContext2D, width: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, width, 0);
  g.addColorStop(0, C.indigo);
  g.addColorStop(0.5, C.purple);
  g.addColorStop(1, C.pink);
  return g;
}

export function paintSpectrum(
  ctx: CanvasRenderingContext2D,
  bins: ArrayLike<number>,
  peak: ArrayLike<number> | null,
  box: { w: number; h: number; floorDb: number; topDb: number },
  fill: string | CanvasGradient,
  line: string,
): void {
  const n = bins.length;
  if (!n) return;
  const y = (db: number): number => box.h - ((Math.max(box.floorDb, Math.min(box.topDb, db)) - box.floorDb) / (box.topDb - box.floorDb)) * box.h;
  ctx.beginPath();
  ctx.moveTo(0, box.h);
  for (let i = 0; i < n; i++) ctx.lineTo(freqToX(scopeBinHz(i, n), box.w), y(bins[i]));
  ctx.lineTo(box.w, box.h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (peak && peak.length === n) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = freqToX(scopeBinHz(i, n), box.w);
      if (i === 0) ctx.moveTo(px, y(peak[i]));
      else ctx.lineTo(px, y(peak[i]));
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
