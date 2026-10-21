// One canvas layer of a layered editor surface (grid / content / overlay ...).
// Backing store = CSS size × devicePixelRatio; painters draw in CSS px.

export class Layer {
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  w = 0;
  h = 0;
  dpr = 1;
  dirty = true;

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.ctx = null;
    this.dirty = true;
  }

  resize(w: number, h: number): void {
    const c = this.canvas;
    if (!c) return;
    this.w = Math.max(0, Math.floor(w));
    this.h = Math.max(0, Math.floor(h));
    // DPR of the window that owns the canvas (dockview popouts can sit on another monitor)
    this.dpr = layerDpr(c);
    const bw = Math.max(1, Math.round(Math.max(1, this.w) * this.dpr));
    const bh = Math.max(1, Math.round(Math.max(1, this.h) * this.dpr));
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    c.style.width = `${Math.max(1, this.w)}px`;
    c.style.height = `${Math.max(1, this.h)}px`;
    this.ctx = c.getContext('2d');
    this.dirty = true;
  }

  /** Clear and return the context if this layer has a size (also clears `dirty`). */
  begin(): CanvasRenderingContext2D | null {
    this.dirty = false;
    const ctx = this.ctx;
    if (!ctx || this.w <= 0 || this.h <= 0) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    return ctx;
  }
}

/** devicePixelRatio of the window a canvas lives in. */
export function layerDpr(c: HTMLCanvasElement | null): number {
  return c?.ownerDocument.defaultView?.devicePixelRatio || window.devicePixelRatio || 1;
}

/** Snap a CSS-px coordinate to the device-pixel grid (for fillRect edges). */
export function px(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/** A 1-device-pixel vertical hairline at x. */
export function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, dpr: number, widthDev = 1): void {
  ctx.fillRect(Math.round(x * dpr) / dpr, y0, widthDev / dpr, y1 - y0);
}

/** A 1-device-pixel horizontal hairline at y. */
export function hline(ctx: CanvasRenderingContext2D, y: number, x0: number, x1: number, dpr: number, widthDev = 1): void {
  ctx.fillRect(x0, Math.round(y * dpr) / dpr, x1 - x0, widthDev / dpr);
}

/** Device-pixel-aligned rectangle outline (inside the rect). */
export function strokeRectCrisp(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dpr: number, lineDev = 1): void {
  const lw = lineDev / dpr;
  const x0 = Math.round(x * dpr) / dpr;
  const y0 = Math.round(y * dpr) / dpr;
  const x1 = Math.round((x + w) * dpr) / dpr;
  const y1 = Math.round((y + h) * dpr) / dpr;
  ctx.fillRect(x0, y0, x1 - x0, lw);
  ctx.fillRect(x0, y1 - lw, x1 - x0, lw);
  ctx.fillRect(x0, y0, lw, y1 - y0);
  ctx.fillRect(x1 - lw, y0, lw, y1 - y0);
}

/** Cached measureText for labels (research/06 §1.5: skip labels that don't fit). */
const widthCache = new Map<string, number>();
export function textWidth(ctx: CanvasRenderingContext2D, font: string, s: string): number {
  const key = `${font}|${s}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(s).width;
    if (widthCache.size > 4000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

/** Observe an element's CSS content size. Returns the disconnect fn. */
export function observeSize(el: HTMLElement, cb: (w: number, h: number) => void): () => void {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const r = e.contentRect;
      cb(r.width, r.height);
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
}
