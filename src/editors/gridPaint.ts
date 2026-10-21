import { TICKS_PER_STEP, ticksPerBar, ticksPerBeat, type TimeSig } from '@shared/schema/time';
import { tickToX, xToTick, type TimeView } from './viewport';
import { vline, hline } from './layer';
import { C, FONT_MONO } from './theme';

export interface GridLevels {
  bar: number;
  beat: number;
  step: number;
  barEvery: number;
  unit: number;
}

export function gridLevels(pxPerTick: number, ts: TimeSig): GridLevels {
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const step = Math.min(TICKS_PER_STEP, beat);
  let barEvery = 1;
  while (bar * barEvery * pxPerTick < 12 && barEvery < 4096) barEvery *= 2;
  const unit = step * pxPerTick >= 7 ? step : beat * pxPerTick >= 7 ? beat : bar * barEvery;
  return { bar, beat, step, barEvery, unit };
}

export interface TimeGridOpts {
  snapGrid?: number;
  shadeAltBars?: boolean;
  endTick?: number | null;
}

export function paintTimeGrid(ctx: CanvasRenderingContext2D, v: TimeView, w: number, h: number, ts: TimeSig, dpr: number, opts: TimeGridOpts = {}): void {
  const L = gridLevels(v.pxPerTick, ts);
  const p = v.pxPerTick;
  const tEnd = xToTick(v, w);

  if (opts.shadeAltBars && L.bar * p >= 24) {
    ctx.fillStyle = 'rgba(255,255,255,0.018)';
    for (let b = Math.floor(v.scrollTick / L.bar); b * L.bar <= tEnd; b++) {
      if (b % 2 === 1) ctx.fillRect(tickToX(v, b * L.bar), 0, L.bar * p, h);
    }
  }

  const sg = opts.snapGrid ?? 0;
  if (sg > 1 && sg * p >= 8 && L.step % sg !== 0 && sg % L.step !== 0) {
    ctx.fillStyle = C.lineSnap;
    for (let t = Math.floor(v.scrollTick / sg) * sg; t <= tEnd; t += sg) vline(ctx, tickToX(v, t), 0, h, dpr);
  }

  const bars: number[] = [];
  const beats: number[] = [];
  const steps: number[] = [];
  const barSpan = L.bar * L.barEvery;
  for (let t = Math.floor(v.scrollTick / L.unit) * L.unit; t <= tEnd; t += L.unit) {
    const x = tickToX(v, t);
    if (t % barSpan === 0) bars.push(x);
    else if (t % L.bar === 0) beats.push(x);
    else if (t % L.beat === 0) beats.push(x);
    else steps.push(x);
  }
  ctx.fillStyle = C.lineStep;
  for (const x of steps) vline(ctx, x, 0, h, dpr);
  ctx.fillStyle = C.lineBeat;
  for (const x of beats) vline(ctx, x, 0, h, dpr);
  ctx.fillStyle = C.lineBar;
  for (const x of bars) vline(ctx, x, 0, h, dpr);

  if (opts.endTick != null) {
    const x = tickToX(v, opts.endTick);
    if (x < w) {
      ctx.fillStyle = C.beyondEnd;
      ctx.fillRect(Math.max(0, x), 0, w - Math.max(0, x), h);
      ctx.fillStyle = 'rgba(168,85,247,0.45)';
      if (x >= 0) vline(ctx, x, 0, h, dpr, 2);
    }
  }
}

export interface RulerOpts {
  loop?: { enabled: boolean; start: number; end: number } | null;
  markers?: Array<{ id: string; tick: number; name: string }>;
  endTick?: number | null;
  hoverTick?: number | null;
}

export const RULER_FONT = `10px ${FONT_MONO}`;

export function paintRuler(ctx: CanvasRenderingContext2D, v: TimeView, w: number, h: number, ts: TimeSig, dpr: number, opts: RulerOpts = {}): void {
  const L = gridLevels(v.pxPerTick, ts);
  const p = v.pxPerTick;
  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, w, h);

  if (opts.endTick != null) {
    const x = tickToX(v, opts.endTick);
    if (x < w) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(Math.max(0, x), 0, w, h);
    }
  }

  const loop = opts.loop;
  if (loop && loop.end > loop.start) {
    const x0 = tickToX(v, loop.start);
    const x1 = tickToX(v, loop.end);
    if (x1 > 0 && x0 < w) {
      ctx.fillStyle = loop.enabled ? C.loop : 'rgba(255,255,255,0.05)';
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.fillStyle = loop.enabled ? C.loopEdge : 'rgba(255,255,255,0.25)';
      vline(ctx, x0, 0, h, dpr, 2);
      vline(ctx, x1 - 2 / dpr, 0, h, dpr, 2);
    }
  }

  const tEnd = xToTick(v, w);
  if (L.beat * p >= 6) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (let t = Math.floor(v.scrollTick / L.beat) * L.beat; t <= tEnd; t += L.beat) {
      if (t % L.bar !== 0) vline(ctx, tickToX(v, t), h - 5, h, dpr);
    }
  }
  let labelEvery = L.barEvery;
  while (L.bar * labelEvery * p < 34 && labelEvery < 4096) labelEvery *= 2;
  const barSpan = L.bar * L.barEvery;
  ctx.font = RULER_FONT;
  ctx.textBaseline = 'alphabetic';
  for (let t = Math.floor(v.scrollTick / barSpan) * barSpan; t <= tEnd; t += barSpan) {
    const x = tickToX(v, t);
    const barNo = Math.round(t / L.bar);
    const labelled = barNo % labelEvery === 0;
    ctx.fillStyle = labelled ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.14)';
    vline(ctx, x, labelled ? h * 0.35 : h - 8, h, dpr);
    if (labelled) {
      ctx.fillStyle = barNo % (labelEvery * 4) === 0 ? C.text : C.muted;
      ctx.fillText(String(barNo + 1), x + 4, h - 6);
    }
  }

  for (const m of opts.markers ?? []) {
    const x = tickToX(v, m.tick);
    if (x < -120 || x > w) continue;
    ctx.fillStyle = C.pink;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 7, 0);
    ctx.lineTo(x, 7);
    ctx.closePath();
    ctx.fill();
    vline(ctx, x, 0, h, dpr);
    ctx.fillStyle = 'rgba(236,72,153,0.9)';
    ctx.fillText(m.name, x + 8, 9);
  }

  if (opts.hoverTick != null) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    vline(ctx, tickToX(v, opts.hoverTick), 0, h, dpr);
  }

  ctx.fillStyle = C.hairline;
  hline(ctx, h - 1 / dpr, 0, w, dpr);
}
