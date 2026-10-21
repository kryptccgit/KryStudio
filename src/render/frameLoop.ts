type FrameFn = (dtSec: number, now: number) => void;

const subs = new Set<FrameFn>();
let running = false;
let lastNow = 0;

function tick(now: number): void {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 1 / 60;
  lastNow = now;
  for (const fn of subs) {
    try {
      fn(dt, now);
    } catch (err) {
      console.error('[frameLoop]', err);
    }
  }
  if (subs.size) requestAnimationFrame(tick);
  else {
    running = false;
    lastNow = 0;
  }
}

export function onFrame(fn: FrameFn): () => void {
  subs.add(fn);
  if (!running) {
    running = true;
    requestAnimationFrame(tick);
  }
  return () => {
    subs.delete(fn);
  };
}

export function setupCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
