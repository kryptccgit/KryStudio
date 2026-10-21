import type { Note } from '@shared/schema/project';
import { noteName } from '@shared/music/theory';
import { keyToY, tickToX, visibleKeys, xToTick, type KeyView, type TimeView } from '../../editors/viewport';
import { hline, strokeRectCrisp, textWidth } from '../../editors/layer';
import { C, FONT_MONO, lighten, rgba, velocityColor } from '../../editors/theme';
import type { SpanIndex } from '../../editors/spanIndex';
import { LANE_PROPS, type LaneProp } from './store';

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
export const isBlackKey = (key: number): boolean => BLACK[((key % 12) + 12) % 12];

export interface ScaleMask {
  inScale: boolean[];
  root: number;
}

export function paintKeyRows(ctx: CanvasRenderingContext2D, kv: KeyView, w: number, h: number, dpr: number, scale: ScaleMask | null): void {
  ctx.fillStyle = C.gridBg;
  ctx.fillRect(0, 0, w, h);
  const [lo, hi] = visibleKeys(kv, h);
  for (let k = lo; k <= hi; k++) {
    const y = keyToY(kv, k);
    const pc = k % 12;
    ctx.fillStyle = isBlackKey(k) ? C.rowBlack : C.rowWhite;
    ctx.fillRect(0, y, w, kv.rowH);
    if (scale && scale.inScale[pc]) {
      ctx.fillStyle = pc === scale.root ? C.rootRow : C.scaleRow;
      ctx.fillRect(0, y, w, kv.rowH);
    }
    ctx.fillStyle = pc === 0 ? C.octaveLine : C.rowLine;
    hline(ctx, y + kv.rowH - 1 / dpr, 0, w, dpr);
  }
}

export interface NoteStyle {
  selected?: boolean;
  glow?: number;
  ghostColor?: string;
  labels?: boolean;
  dim?: boolean;
  velAlpha?: boolean;
  preview?: boolean;
}

export interface NoteLook {
  key: number;
  vel: number;
  color?: number;
  mute?: boolean;
  slide?: boolean;
}

export const NOTE_FONT = `9px ${FONT_MONO}`;

export const NOTE_COLORS = [
  '#A855F7', '#6366F1', '#EC4899', '#22C55E', '#F59E0B', '#06B6D4', '#EF4444', '#84CC16',
  '#8B5CF6', '#14B8A6', '#F97316', '#3B82F6', '#E879F9', '#FACC15', '#F43F5E', '#94A3B8',
];

export function noteGroupColor(color: number | undefined): string {
  return NOTE_COLORS[color ?? 0] ?? NOTE_COLORS[0];
}

export function noteFill(n: NoteLook, velAlpha: boolean): { fill: string; alpha: number } {
  const v = Math.max(0, Math.min(1, n.vel));
  const fill = velAlpha ? noteGroupColor(n.color) : velocityColor(v);
  let alpha = velAlpha ? 0.28 + 0.72 * v : 1;
  if (n.mute) alpha *= 0.38;
  return { fill, alpha };
}

export function drawNote(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: NoteLook, dpr: number, s: NoteStyle): void {
  const ww = Math.max(2, w - 1);
  const hh = Math.max(2, h - 1);
  if (s.ghostColor) {
    ctx.fillStyle = rgba(s.ghostColor, 0.2);
    ctx.fillRect(x, y, ww, hh);
    ctx.fillStyle = rgba(s.ghostColor, 0.32);
    strokeRectCrisp(ctx, x, y, ww, hh, dpr);
    return;
  }
  const { fill, alpha } = noteFill(n, !!s.velAlpha);
  const group = n.color ? noteGroupColor(n.color) : null;
  const outer = (s.dim ? 0.55 : 1) * (n.mute ? 0.6 : 1);
  ctx.globalAlpha = alpha * (s.dim ? 0.55 : 1);
  ctx.fillStyle = s.selected ? lighten('#F0ABFC', 0.15) : fill;
  ctx.fillRect(x, y, ww, hh);
  ctx.fillStyle = s.selected ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.22)';
  ctx.fillRect(x, y, ww, Math.min(1, hh));
  ctx.globalAlpha = outer;
  ctx.fillStyle = s.selected ? 'rgba(88,28,135,0.7)' : group && !s.velAlpha ? group : 'rgba(255,255,255,0.32)';
  ctx.fillRect(x, y, Math.min(group && !s.velAlpha ? 3 : 2, ww), hh);
  if (s.selected) ctx.fillStyle = '#FFFFFF';
  else if (s.velAlpha) ctx.fillStyle = rgba(fill, 0.9);
  else ctx.fillStyle = 'rgba(0,0,0,0.35)';
  if (n.mute && !s.selected) {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1);
    ctx.setLineDash([]);
  } else strokeRectCrisp(ctx, x, y, ww, hh, dpr);
  let labelX = x + 4;
  if (n.slide && ww >= 6 && hh >= 4) {
    const sw = Math.min(ww - 2, hh + 2);
    ctx.fillStyle = s.selected ? '#3B0764' : 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(x + 1, y + hh - 1);
    ctx.lineTo(x + sw, y + 1);
    ctx.lineTo(x + sw, y + hh - 1);
    ctx.closePath();
    ctx.fill();
    labelX = x + sw + 3;
  }
  if (s.labels && hh >= 9 && ww > 24) {
    const label = noteName(n.key);
    if (textWidth(ctx, NOTE_FONT, label) + (labelX - x) + 2 < ww) {
      ctx.font = NOTE_FONT;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = s.selected ? '#3B0764' : 'rgba(255,255,255,0.88)';
      ctx.fillText(label, labelX, y + hh / 2 + 0.5);
    }
  }
  ctx.globalAlpha = 1;
  if (s.preview) {
    ctx.fillStyle = rgba(C.glow, 0.9);
    strokeRectCrisp(ctx, x - 1, y - 1, ww + 2, hh + 2, dpr, 1);
  }
  if (s.glow && s.glow > 0) {
    ctx.fillStyle = rgba(C.glow, 0.95 * s.glow);
    strokeRectCrisp(ctx, x - 1, y - 1, ww + 2, hh + 2, dpr, 2);
    ctx.fillStyle = rgba(C.glow, 0.3 * s.glow);
    strokeRectCrisp(ctx, x - 3, y - 3, ww + 6, hh + 6, dpr, 2);
  }
}

export function paintGlides(
  ctx: CanvasRenderingContext2D,
  index: SpanIndex<Note>,
  tv: TimeView,
  kv: KeyView,
  w: number,
  portaTicks: number | null,
  hidden: ReadonlySet<string> | null,
): void {
  if (!index.size) return;
  const t0 = xToTick(tv, 0);
  const t1 = xToTick(tv, w);
  let prev: Note | null = null;
  const from = Math.max(0, index.lowerBound(t0 - index.maxLen - 1) - 1);
  ctx.lineWidth = 1.5;
  for (let i = from; i < index.size; i++) {
    const n = index.items[i];
    if (n.tick >= t1) break;
    if (n.mute || hidden?.has(n.id)) continue;
    if (prev && prev.tick < n.tick && prev.key !== n.key) {
      let glide = 0;
      if (n.slide) glide = n.dur;
      else if (portaTicks && prev.tick + prev.dur >= n.tick - 1) glide = Math.min(portaTicks, n.dur);
      if (glide > 0) {
        const x0 = tickToX(tv, n.tick);
        const x1 = Math.max(x0 + 3, tickToX(tv, n.tick + glide));
        if (x1 >= 0 && x0 <= w) {
          const y0 = keyToY(kv, prev.key) + kv.rowH / 2;
          const y1 = keyToY(kv, n.key) + kv.rowH / 2;
          const col = n.slide ? 'rgba(244,114,182,0.9)' : 'rgba(192,132,252,0.75)';
          ctx.strokeStyle = col;
          ctx.setLineDash(n.slide ? [] : [4, 3]);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.bezierCurveTo((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, x1, y1);
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.fillRect(x0 - 1.5, y0 - 1.5, 3, 3);
        }
      }
    }
    if (!prev || n.tick > prev.tick || n.key > prev.key) prev = n;
  }
  ctx.setLineDash([]);
}

export function forVisibleNotes(index: SpanIndex<Note>, tv: TimeView, kv: KeyView, w: number, h: number, fn: (n: Note) => void): void {
  const [lo, hi] = visibleKeys(kv, h);
  index.query(tv.scrollTick, xToTick(tv, w), (n) => {
    if (n.key >= lo && n.key <= hi) fn(n);
  });
}

export function noteRect(n: { tick: number; dur: number; key: number }, tv: TimeView, kv: KeyView): [number, number, number, number] {
  const x = tickToX(tv, n.tick);
  return [x, keyToY(kv, n.key), Math.max(1, n.dur * tv.pxPerTick), kv.rowH];
}

export function paintKeyboard(
  ctx: CanvasRenderingContext2D,
  kv: KeyView,
  w: number,
  h: number,
  dpr: number,
  pressed: ReadonlySet<number>,
  scale: ScaleMask | null,
  hoverKey: number | null,
): void {
  ctx.fillStyle = '#0B0B10';
  ctx.fillRect(0, 0, w, h);
  const [lo, hi] = visibleKeys(kv, h);
  const blackW = Math.round(w * 0.58);
  const fontPx = Math.max(8, Math.min(10, kv.rowH - 3));
  ctx.font = `${fontPx}px ${FONT_MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const sheen = ctx.createLinearGradient(0, 0, w, 0);
  sheen.addColorStop(0, '#9C9CB0');
  sheen.addColorStop(1, '#C9C9D8');
  const glow = ctx.createLinearGradient(0, 0, w, 0);
  glow.addColorStop(0, C.indigo);
  glow.addColorStop(0.5, C.purple);
  glow.addColorStop(1, C.pink);
  for (let k = lo; k <= hi; k++) {
    const y = keyToY(kv, k);
    const pc = k % 12;
    const black = isBlackKey(k);
    ctx.fillStyle = pressed.has(k) && !black ? glow : sheen;
    ctx.fillRect(0, y, w - 1, kv.rowH);
    if (hoverKey === k && !black && !pressed.has(k)) {
      ctx.fillStyle = 'rgba(168,85,247,0.35)';
      ctx.fillRect(0, y, w - 1, kv.rowH);
    }
    if (black) {
      ctx.fillStyle = pressed.has(k) ? glow : hoverKey === k ? '#3B2A55' : '#121219';
      ctx.fillRect(0, y + 1, blackW, kv.rowH - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(blackW - 1, y + 2, 1, kv.rowH - 4);
      ctx.fillStyle = 'rgba(20,20,30,0.45)';
      hline(ctx, y + kv.rowH / 2, blackW, w - 1, dpr);
    }
    if (pc === 0 || pc === 5) {
      ctx.fillStyle = pc === 0 ? 'rgba(20,20,30,0.85)' : 'rgba(20,20,30,0.45)';
      hline(ctx, y + kv.rowH - 1 / dpr, 0, w - 1, dpr);
    }
    if (scale && scale.inScale[pc]) {
      ctx.fillStyle = pc === scale.root ? C.pink : C.purple;
      ctx.fillRect(w - 4, y + 1, 3, kv.rowH - 2);
    }
    const labelled = pc === 0 || (hoverKey === k && kv.rowH >= 10) || (pressed.has(k) && kv.rowH >= 10);
    if (labelled && kv.rowH >= 7) {
      ctx.fillStyle = pressed.has(k) ? '#FFFFFF' : pc === 0 ? (k === 60 ? '#7E22CE' : '#2A2A3A') : '#4C1D95';
      ctx.fillText(noteName(k), w - 7, y + kv.rowH / 2 + 0.5);
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(w - 1, 0, 1, h);
}

export function laneNorm(prop: LaneProp, v: number): number {
  const s = LANE_PROPS[prop];
  return (v - s.min) / (s.max - s.min);
}

export function laneValueFromY(prop: LaneProp, y: number, h: number): number {
  const s = LANE_PROPS[prop];
  const t = Math.max(0, Math.min(1, 1 - (y - 4) / Math.max(1, h - 8)));
  const v = s.min + t * (s.max - s.min);
  return s.int ? Math.round(v) : Math.round(v * 1000) / 1000;
}

export function laneY(prop: LaneProp, v: number, h: number): number {
  return 4 + (1 - laneNorm(prop, v)) * Math.max(1, h - 8);
}

export function paintLane(
  ctx: CanvasRenderingContext2D,
  tv: TimeView,
  w: number,
  h: number,
  dpr: number,
  prop: LaneProp,
  index: SpanIndex<Note>,
  selected: ReadonlySet<string>,
  override: ReadonlyMap<string, number> | null,
  moved: ReadonlyMap<string, { tick: number }> | null,
  hidden: ReadonlySet<string> | null = null,
): void {
  ctx.fillStyle = '#0B0B11';
  ctx.fillRect(0, 0, w, h);
  const s = LANE_PROPS[prop];
  const base = s.centered ? laneY(prop, (s.min + s.max) / 2, h) : h - 4;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  hline(ctx, base, 0, w, dpr);
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    hline(ctx, 4 + f * (h - 8), 0, w, dpr);
  }
  const anySel = selected.size > 0;
  const t0 = xToTick(tv, -8);
  const t1 = xToTick(tv, w + 8);
  if (tv.pxPerTick * 240 < 4) {
    let last = '';
    index.query(t0, t1, (n) => {
      if (hidden?.has(n.id)) return;
      const tick = moved?.get(n.id)?.tick ?? n.tick;
      const sel = selected.has(n.id);
      const col = sel ? '#F0ABFC' : anySel ? 'rgba(161,161,170,0.45)' : prop === 'vel' ? velocityColor(n.vel) : C.purple;
      if (col !== last) {
        ctx.fillStyle = col;
        last = col;
      }
      const y = laneY(prop, override?.get(n.id) ?? (n[prop] as number), h);
      ctx.fillRect(tickToX(tv, tick), Math.min(y, base), 1, Math.max(1, Math.abs(base - y)));
    });
    return;
  }
  for (let pass = 0; pass < 2; pass++) {
    index.query(t0, t1, (n) => {
      const sel = selected.has(n.id);
      if ((pass === 1) !== sel || hidden?.has(n.id)) return;
      const tick = moved?.get(n.id)?.tick ?? n.tick;
      if (tick < t0 || tick > t1) return;
      const x = Math.round(tickToX(tv, tick) * dpr) / dpr;
      const v = override?.get(n.id) ?? (n[prop] as number);
      const y = laneY(prop, v, h);
      const col = sel ? '#F0ABFC' : anySel ? 'rgba(161,161,170,0.45)' : prop === 'vel' ? velocityColor(n.vel) : C.purple;
      ctx.fillStyle = col;
      ctx.fillRect(x, Math.min(y, base), 2, Math.max(1, Math.abs(base - y)));
      ctx.fillRect(x - 2, y - 2, 6, 4);
      if (override?.has(n.id)) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(x - 2, y - 2, 6, 1);
      }
    });
  }
  ctx.font = `9px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillText(s.label.toUpperCase(), 6, 5);
}
