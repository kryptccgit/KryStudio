import { onFrame, setupCanvas } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';

const MIN_DB = -60;
const MAX_DB = 6;

export function dbToMeter(lin: number): number {
  if (lin <= 0) return 0;
  const db = 20 * Math.log10(lin);
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

interface Entry {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  last: string;
  grad: CanvasGradient | null;
  gradH: number;
}

export class MeterBank {
  private entries = new Map<string, Entry>();
  private off: (() => void) | null = null;

  register(insertId: string, canvas: HTMLCanvasElement | null, w: number, h: number): void {
    if (!canvas) {
      this.entries.delete(insertId);
      return;
    }
    const prev = this.entries.get(insertId);
    if (prev && prev.canvas === canvas && prev.w === w && prev.h === h) return;
    this.entries.set(insertId, { canvas, w, h, last: '', grad: null, gradH: 0 });
  }

  start(): () => void {
    this.off = onFrame((dt) => this.draw(dt));
    return () => {
      this.off?.();
      this.off = null;
    };
  }

  private draw(dt: number): void {
    for (const [id, e] of this.entries) {
      const [l, r, hl, hr] = telemetry.meter(id, dt);
      const ml = dbToMeter(l);
      const mr = dbToMeter(r);
      const mhl = dbToMeter(hl);
      const mhr = dbToMeter(hr);
      const key = `${(ml * 200) | 0},${(mr * 200) | 0},${(mhl * 200) | 0},${(mhr * 200) | 0},${hl > 1 || hr > 1 ? 1 : 0}`;
      if (key === e.last) continue;
      e.last = key;
      const ctx = setupCanvas(e.canvas, e.w, e.h);
      if (!e.grad || e.gradH !== e.h) {
        const g = ctx.createLinearGradient(0, e.h, 0, 0);
        const at = (db: number): number => (db - MIN_DB) / (MAX_DB - MIN_DB);
        g.addColorStop(0, '#16a34a');
        g.addColorStop(at(-18), '#22c55e');
        g.addColorStop(at(-6), '#eab308');
        g.addColorStop(at(-1), '#f97316');
        g.addColorStop(at(0), '#ef4444');
        g.addColorStop(1, '#ef4444');
        e.grad = g;
        e.gradH = e.h;
      }
      ctx.clearRect(0, 0, e.w, e.h);
      const bw = Math.max(2, Math.floor((e.w - 1) / 2));
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, bw, e.h);
      ctx.fillRect(bw + 1, 0, bw, e.h);
      ctx.fillStyle = e.grad;
      const hL = ml * e.h;
      const hR = mr * e.h;
      ctx.fillRect(0, e.h - hL, bw, hL);
      ctx.fillRect(bw + 1, e.h - hR, bw, hR);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      if (mhl > 0.01) ctx.fillRect(0, Math.round(e.h - mhl * e.h), bw, 1);
      if (mhr > 0.01) ctx.fillRect(bw + 1, Math.round(e.h - mhr * e.h), bw, 1);
      const zero = Math.round(e.h - ((0 - MIN_DB) / (MAX_DB - MIN_DB)) * e.h);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, zero, e.w, 1);
      if (hl > 1 || hr > 1) {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(0, 0, e.w, 2);
      }
    }
  }
}
