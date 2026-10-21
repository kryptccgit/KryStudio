import type { Automation, AutomationPoint, Clip, Note, Pattern, Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import { PPQ, ticksToSeconds, type TimeSig } from '@shared/schema/time';
import { beatToSec } from '@shared/schema/warp';
import { evalAutomation, sortPoints } from '@shared/schema/automation';
import { tickToX, xToTick, type TimeView } from '../../editors/viewport';
import { strokeRectCrisp, textWidth } from '../../editors/layer';
import { getPeaks, peakRange } from '../../editors/peaks';
import { C, FONT_MONO, rgba } from '../../editors/theme';
import { paintFades } from './fades';

export const CLIP_HEADER_H = 13;
export const CLIP_FONT = `10px ${FONT_MONO}`;

export function clipColor(p: Project, c: Clip): string {
  if (c.color) return c.color;
  if (c.kind === 'pattern') return (c.patternId && p.patterns[c.patternId]?.color) || C.purple;
  if (c.kind === 'audio') return (c.channelId && p.channels[c.channelId]?.color) || C.pink;
  return (c.automationId && p.automations[c.automationId]?.color) || C.indigo;
}

export function clipName(p: Project, c: Clip): string {
  if (c.kind === 'pattern') return (c.patternId && p.patterns[c.patternId]?.name) || 'Pattern';
  if (c.kind === 'audio') {
    const ch = c.channelId ? p.channels[c.channelId] : undefined;
    const s = ch?.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
    return s?.name ?? ch?.name ?? 'Audio';
  }
  return (c.automationId && p.automations[c.automationId]?.name) || 'Automation';
}

export function samplePathForClip(p: Project, c: Clip): string | null {
  const ch = c.channelId ? p.channels[c.channelId] : undefined;
  const sid = ch?.generator.sampleId;
  return sid ? p.samples[sid]?.path ?? null : null;
}

const lenCache = new WeakMap<Pattern, { ts: TimeSig; len: number }>();
export function cachedPatternLength(pat: Pattern, ts: TimeSig): number {
  const c = lenCache.get(pat);
  if (c && c.ts === ts) return c.len;
  const len = patternLength(pat, ts);
  lenCache.set(pat, { ts, len });
  return len;
}

interface PatNotes {
  notes: Note[];
  lo: number;
  hi: number;
}
const patNotesCache = new WeakMap<Pattern, PatNotes>();

function patternNotes(pat: Pattern): PatNotes {
  let v = patNotesCache.get(pat);
  if (!v) {
    const notes: Note[] = [];
    let lo = 127;
    let hi = 0;
    for (const byId of Object.values(pat.notes)) {
      for (const n of Object.values(byId)) {
        notes.push(n);
        if (n.key < lo) lo = n.key;
        if (n.key > hi) hi = n.key;
      }
    }
    notes.sort((a, b) => a.tick - b.tick);
    v = { notes, lo, hi };
    patNotesCache.set(pat, v);
  }
  return v;
}

type PreviewCanvas = HTMLCanvasElement;
const previewCache = new WeakMap<Pattern, Map<string, PreviewCanvas>>();
const MAX_PREVIEW_DEV_PX = 8192;

function drawPatternNotes(ctx: CanvasRenderingContext2D, pn: PatNotes, len: number, t0: number, t1: number, x0: number, px: number, h: number, color: string): void {
  if (!pn.notes.length) return;
  const span = Math.max(12, pn.hi - pn.lo + 3);
  const rowH = Math.max(1, Math.min(4, h / span));
  const top = (h - rowH * (pn.hi - pn.lo + 1)) / 2;
  ctx.fillStyle = color;
  for (const n of pn.notes) {
    if (n.tick >= t1 || n.tick >= len) break;
    const end = Math.min(n.tick + n.dur, len);
    if (end <= t0) continue;
    const a = Math.max(n.tick, t0);
    const x = x0 + (a - t0) * px;
    const w = Math.max(1, (Math.min(end, t1) - a) * px - 0.5);
    const y = top + (pn.hi - n.key) * rowH;
    ctx.fillRect(x, y, w, Math.max(1, rowH - (rowH > 2 ? 0.5 : 0)));
  }
}

function patternPreview(pat: Pattern, ts: TimeSig, px: number, h: number, dpr: number, color: string): PreviewCanvas | null {
  const len = cachedPatternLength(pat, ts);
  const wDev = Math.ceil(len * px * dpr);
  const hDev = Math.ceil(h * dpr);
  if (wDev > MAX_PREVIEW_DEV_PX || wDev < 1 || hDev < 1) return null;
  const key = `${px}|${h}|${dpr}|${color}|${len}`;
  let m = previewCache.get(pat);
  const hit = m?.get(key);
  if (hit) return hit;
  if (!m) {
    m = new Map();
    previewCache.set(pat, m);
  }
  if (m.size > 6) m.clear();
  const c = document.createElement('canvas');
  c.width = wDev;
  c.height = hDev;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPatternNotes(ctx, patternNotes(pat), len, 0, len, 0, px, h, color);
  m.set(key, c);
  return c;
}

const sortedCache = new WeakMap<Automation, AutomationPoint[]>();
export function sortedPoints(a: Automation): AutomationPoint[] {
  let v = sortedCache.get(a);
  if (!v) {
    v = sortPoints(a.points);
    sortedCache.set(a, v);
  }
  return v;
}

export interface AutoOverride {
  autId: string;
  points: AutomationPoint[];
  activePointId?: string | null;
}

export interface ClipPaintOpts {
  selected: boolean;
  glow: number;
  dpr: number;
  ts: TimeSig;
  bpm: number;
  auto?: AutoOverride | null;
  hoverPointId?: string | null;
  ghost?: boolean;
  trackMuted?: boolean;
  label?: string;
}

export function paintClip(ctx: CanvasRenderingContext2D, p: Project, c: Clip, tv: TimeView, y: number, h: number, viewW: number, o: ClipPaintOpts): void {
  const x = tickToX(tv, c.start);
  const w = c.length * tv.pxPerTick;
  const color = clipColor(p, c);
  const muted = c.mute || !!o.trackMuted;
  const top = y + 1;
  const hh = h - 2;
  if (hh < 3) return;
  const vx0 = Math.max(x, -2);
  const vx1 = Math.min(x + w, viewW + 2);
  if (vx1 <= vx0) return;

  ctx.globalAlpha = o.ghost ? 0.55 : muted ? 0.4 : 1;
  ctx.fillStyle = rgba(color, o.selected ? 0.3 : 0.16);
  ctx.fillRect(vx0, top, vx1 - vx0, hh);
  const header = hh >= 28 ? CLIP_HEADER_H : 0;
  if (header) {
    ctx.fillStyle = rgba(color, o.selected ? 0.85 : 0.55);
    ctx.fillRect(vx0, top, vx1 - vx0, header);
  }
  const cTop = top + header + 1;
  const cH = hh - header - 2;

  if (cH > 2) {
    if (c.kind === 'pattern') paintPatternBody(ctx, p, c, tv, cTop, cH, vx0, vx1, color, o);
    else if (c.kind === 'audio') paintAudioBody(ctx, p, c, tv, cTop, cH, vx0, vx1, color, o);
    else paintAutomationBody(ctx, p, c, tv, cTop, cH, vx0, vx1, color, o);
  }
  if (c.kind === 'audio' && !o.ghost) paintFades(ctx, c, tv, top, hh, cTop, Math.max(0, cH), color);

  const name = (o.label ?? clipName(p, c)) + (muted && c.mute ? ' (muted)' : '');
  const labelX = Math.max(x, 0) + 4;
  const room = x + w - labelX - 3;
  if (room > 14) {
    ctx.font = CLIP_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = header ? 'rgba(255,255,255,0.95)' : rgba(color, 1);
    const ly = header ? top + header / 2 + 0.5 : top + 7;
    if (textWidth(ctx, CLIP_FONT, name) <= room) ctx.fillText(name, labelX, ly);
    else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(labelX, top, room, Math.max(header, 12));
      ctx.clip();
      ctx.fillText(name, labelX, ly);
      ctx.restore();
    }
  }

  ctx.fillStyle = o.selected ? '#FFFFFF' : rgba(color, 0.85);
  strokeRectCrisp(ctx, x, top, w, hh, o.dpr);
  ctx.globalAlpha = 1;
  if (o.glow > 0) {
    ctx.fillStyle = rgba(C.glow, 0.95 * o.glow);
    strokeRectCrisp(ctx, x - 1, top - 1, w + 2, hh + 2, o.dpr, 2);
    ctx.fillStyle = rgba(C.glow, 0.3 * o.glow);
    strokeRectCrisp(ctx, x - 3, top - 3, w + 6, hh + 6, o.dpr, 2);
  }
}

function paintPatternBody(ctx: CanvasRenderingContext2D, p: Project, c: Clip, tv: TimeView, top: number, h: number, vx0: number, vx1: number, color: string, o: ClipPaintOpts): void {
  const pat = c.patternId ? p.patterns[c.patternId] : undefined;
  if (!pat) return;
  const len = cachedPatternLength(pat, o.ts);
  const px = tv.pxPerTick;
  const noteColor = rgba(color, 0.95);
  const cv = patternPreview(pat, o.ts, px, h, o.dpr, noteColor);
  const pn = cv ? null : patternNotes(pat);
  let T = Math.max(c.start, xToTick(tv, vx0));
  const end = Math.min(c.start + c.length, xToTick(tv, vx1));
  let guard = 0;
  while (T < end && guard++ < 10000) {
    const src = (((T - c.start + c.offset) % len) + len) % len;
    const seg = Math.min(len - src, end - T);
    const x = tickToX(tv, T);
    if (src === 0 && T > c.start) {
      ctx.fillStyle = rgba(color, 0.35);
      ctx.fillRect(Math.round(x * o.dpr) / o.dpr, top, 1 / o.dpr, h);
    }
    if (cv) {
      const sx = src * px * o.dpr;
      const sw = Math.min(cv.width - sx, seg * px * o.dpr);
      if (sw > 0.5) ctx.drawImage(cv, sx, 0, sw, cv.height, x, top, sw / o.dpr, h);
    } else if (pn) {
      ctx.save();
      ctx.translate(0, top);
      drawPatternNotes(ctx, pn, len, src, src + seg, x, px, h, noteColor);
      ctx.restore();
    }
    T += seg;
  }
}

function paintAudioBody(ctx: CanvasRenderingContext2D, p: Project, c: Clip, tv: TimeView, top: number, h: number, vx0: number, vx1: number, color: string, o: ClipPaintOpts): void {
  const path = samplePathForClip(p, c);
  const peaks = path ? getPeaks(path) : null;
  const mid = top + h / 2;
  if (!peaks) {
    ctx.fillStyle = rgba(color, 0.25);
    ctx.fillRect(vx0, mid, vx1 - vx0, 1);
    return;
  }
  const amp = (h / 2 - 1) * Math.min(2, c.gain ?? 1);
  const x0 = Math.max(Math.floor(vx0), Math.floor(tickToX(tv, c.start)));
  const x1 = Math.min(Math.ceil(vx1), Math.ceil(tickToX(tv, c.start + c.length)));
  const warp = c.channelId ? p.channels[c.channelId]?.generator.warp : undefined;
  const wm = warp && warp.markers.length >= 2 ? warp.markers : null;
  const srcSec = (t: number): number => (wm ? (beatToSec(wm, t / PPQ) ?? 0) : ticksToSeconds(t, o.bpm));
  ctx.beginPath();
  for (let x = x0; x < x1; x++) {
    const t0 = xToTick(tv, x) - c.start + c.offset;
    const t1 = xToTick(tv, x + 1) - c.start + c.offset;
    const r = peakRange(peaks, srcSec(t0), srcSec(t1));
    if (!r) continue;
    const yTop = Math.max(top, mid - r[1] * amp);
    const yBot = Math.min(top + h, mid - r[0] * amp);
    ctx.rect(x, yTop, 1, Math.max(1, yBot - yTop));
  }
  ctx.fillStyle = rgba(color, 0.9);
  ctx.fill();
  if (warp?.markers.length) paintWarpTicks(ctx, c, tv, top, h, x0, x1, warp.markers);
}

function paintWarpTicks(ctx: CanvasRenderingContext2D, c: Clip, tv: TimeView, top: number, h: number, x0: number, x1: number, markers: Array<{ beat: number }>): void {
  const tick = Math.min(4, Math.max(2, h / 6));
  ctx.fillStyle = rgba(C.glow, 0.85);
  let last = -Infinity;
  for (const m of markers) {
    const x = Math.round(tickToX(tv, c.start + m.beat * PPQ - c.offset));
    if (x < x0 || x >= x1) continue;
    if (x - last < 3) continue;
    last = x;
    ctx.fillRect(x, top, 1, tick);
    ctx.fillRect(x, top + h - tick, 1, tick);
  }
}

export function automationPointsXY(
  points: AutomationPoint[],
  c: Clip,
  tv: TimeView,
  top: number,
  h: number,
): Array<{ id: string; x: number; y: number; p: AutomationPoint }> {
  const out: Array<{ id: string; x: number; y: number; p: AutomationPoint }> = [];
  for (const pt of points) {
    if (pt.tick < c.offset || pt.tick > c.offset + c.length) continue;
    out.push({ id: pt.id, x: tickToX(tv, c.start + pt.tick - c.offset), y: top + (1 - pt.value) * h, p: pt });
  }
  return out;
}

function paintAutomationBody(ctx: CanvasRenderingContext2D, p: Project, c: Clip, tv: TimeView, top: number, h: number, vx0: number, vx1: number, color: string, o: ClipPaintOpts): void {
  const aut = c.automationId ? p.automations[c.automationId] : undefined;
  if (!aut) return;
  const pts = o.auto && o.auto.autId === aut.id ? o.auto.points : sortedPoints(aut);
  if (!pts.length) return;
  const x0 = Math.max(vx0, tickToX(tv, c.start));
  const x1 = Math.min(vx1, tickToX(tv, c.start + c.length));
  const yOf = (v: number) => top + (1 - v) * h;
  ctx.beginPath();
  let first = true;
  for (let x = x0; ; x += 2) {
    const xx = Math.min(x, x1);
    const rel = xToTick(tv, xx) - c.start + c.offset;
    const y = yOf(evalAutomation(pts, rel));
    if (first) {
      ctx.moveTo(xx, y);
      first = false;
    } else ctx.lineTo(xx, y);
    if (xx >= x1) break;
  }
  ctx.strokeStyle = rgba(color, 1);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(x1, top + h);
  ctx.lineTo(x0, top + h);
  ctx.closePath();
  ctx.fillStyle = rgba(color, 0.14);
  ctx.fill();
  if (c.length * tv.pxPerTick < 24) return;
  for (const q of automationPointsXY(pts, c, tv, top, h)) {
    if (q.x < x0 - 4 || q.x > x1 + 4) continue;
    const active = q.id === o.auto?.activePointId || q.id === o.hoverPointId;
    ctx.beginPath();
    ctx.arc(q.x, q.y, active ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#FFFFFF' : C.void;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = active ? C.pink : rgba(color, 1);
    ctx.stroke();
  }
}
