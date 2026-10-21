// ──────────────────────────────────────────────────────────────────────
// Generated cover art, drawn on a canvas in the renderer (the bundled
// Chakra Petch font is only here): a 1400×1400 picture made from the
// project's own notes (when they play, how high, how hard), with the song
// title and artist. Four looks (waves, grid, orbit, bars); the same project,
// style and seed always draw the same picture, so "Shuffle" just bumps the
// seed. Krypt style: void background, indigo → purple → pink accents, no
// third-party marks.
//
// Main asks for one when an agent calls set_cover {generate}
// (installCoverResponder); the Export dialog draws one directly.
// ──────────────────────────────────────────────────────────────────────

import { COVER_STYLES, type CoverStyle } from '@shared/types';
import { patternLength, songInfo, type Project } from '@shared/schema/project';
import { getProject } from '../doc/store';
import { useProjectStatus } from '../state/status';

export const COVER_SIZE = 1400;

const VOID = '#0A0A0F';
const INDIGO: Rgb = [99, 102, 241];
const PURPLE: Rgb = [168, 85, 247];
const PINK: Rgb = [236, 72, 153];
type Rgb = [number, number, number];

export interface CoverDrawOptions {
  style: CoverStyle;
  seed: number;
  title: string;
  artist: string;
}

/** A note of the song, normalized: t = when (0..1), k = how high (0..1), v = velocity, c = channel index. */
export interface CloudPoint {
  t: number;
  k: number;
  v: number;
  c: number;
}

// ── Deterministic randomness ───────────────────────────────────────────

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function styleForSeed(seed: number): CoverStyle {
  return COVER_STYLES[((Math.floor(seed) % COVER_STYLES.length) + COVER_STYLES.length) % COVER_STYLES.length];
}

// ── The song as points ─────────────────────────────────────────────────

/** The project's notes as a point cloud: the song's arrangement, else its patterns back to back, else a seeded walk. */
export function noteCloud(p: Project, seed: number, max = 1400): CloudPoint[] {
  const ts = p.transport.timeSig;
  const chIndex = new Map(p.channelOrder.map((id, i) => [id, i]));
  const raw: Array<{ tick: number; key: number; vel: number; c: number }> = [];
  const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId && p.patterns[c.patternId] && !c.mute);
  if (clips.length) {
    for (const c of clips) {
      const pat = p.patterns[c.patternId!];
      for (const [chId, notes] of Object.entries(pat.notes)) {
        for (const n of Object.values(notes)) {
          if (n.tick < c.offset || n.tick >= c.offset + c.length) continue;
          raw.push({ tick: c.start + n.tick - c.offset, key: n.key, vel: n.vel, c: chIndex.get(chId) ?? 0 });
        }
      }
    }
  } else {
    let off = 0;
    for (const id of p.patternOrder) {
      const pat = p.patterns[id];
      if (!pat) continue;
      for (const [chId, notes] of Object.entries(pat.notes)) for (const n of Object.values(notes)) raw.push({ tick: off + n.tick, key: n.key, vel: n.vel, c: chIndex.get(chId) ?? 0 });
      off += patternLength(pat, ts);
    }
  }
  if (!raw.length) {
    // An empty project still gets a picture: a seeded melodic walk.
    const rnd = mulberry32(hashString(`walk|${seed}`));
    let key = 60;
    for (let i = 0; i < 160; i++) {
      key = Math.max(36, Math.min(84, key + Math.round((rnd() - 0.5) * 9)));
      raw.push({ tick: i * 240, key, vel: 0.4 + rnd() * 0.6, c: i % 5 });
    }
  }
  raw.sort((a, b) => a.tick - b.tick || a.key - b.key);
  const step = raw.length > max ? raw.length / max : 1;
  const picked = step > 1 ? Array.from({ length: max }, (_, i) => raw[Math.floor(i * step)]) : raw;
  const t0 = picked[0].tick;
  const t1 = Math.max(t0 + 1, picked[picked.length - 1].tick);
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of picked) {
    lo = Math.min(lo, n.key);
    hi = Math.max(hi, n.key);
  }
  const span = Math.max(12, hi - lo);
  const mid = (lo + hi) / 2;
  return picked.map((n) => ({ t: (n.tick - t0) / (t1 - t0), k: Math.max(0, Math.min(1, 0.5 + (n.key - mid) / span)), v: Math.max(0.05, Math.min(1, n.vel)), c: n.c }));
}

/** How busy the song is over time: `bins` values 0..1, smoothed. */
export function density(points: CloudPoint[], bins: number): number[] {
  const h = new Array<number>(bins).fill(0);
  for (const p of points) h[Math.min(bins - 1, Math.floor(p.t * bins))] += 0.4 + p.v;
  const sm = h.map((_, i) => (h[Math.max(0, i - 1)] + 2 * h[i] + h[Math.min(bins - 1, i + 1)]) / 4);
  const top = Math.max(1e-6, ...sm);
  return sm.map((x) => x / top);
}

// ── Drawing helpers ────────────────────────────────────────────────────

const mix = (a: Rgb, b: Rgb, f: number): Rgb => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
/** The Krypt gradient at 0..1 (indigo → purple → pink), shifted by `hue` (0..1) so seeds lean different ways. */
function grad(f: number, hue = 0): Rgb {
  const x = Math.max(0, Math.min(1, (f + hue) % 1.0001));
  return x < 0.5 ? mix(INDIGO, PURPLE, x * 2) : mix(PURPLE, PINK, (x - 0.5) * 2);
}
const rgba = (c: Rgb, a: number): string => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

function linear(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, hue: number, alpha: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i <= 4; i++) g.addColorStop(i / 4, rgba(grad(i / 4, hue), alpha));
  return g;
}

function backdrop(ctx: CanvasRenderingContext2D, rnd: () => number, hue: number): void {
  const S = COVER_SIZE;
  ctx.fillStyle = VOID;
  ctx.fillRect(0, 0, S, S);
  // Two soft colour blooms from the palette.
  for (let i = 0; i < 2; i++) {
    const x = S * (0.2 + rnd() * 0.6);
    const y = S * (0.15 + rnd() * 0.45);
    const r = S * (0.45 + rnd() * 0.25);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(grad(i ? 0.85 : 0.15, hue), 0.22));
    g.addColorStop(1, rgba(grad(0.5, hue), 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
}

function grain(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  const S = COVER_SIZE;
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let i = 0; i < 4200; i++) ctx.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
}

// ── The four looks ─────────────────────────────────────────────────────

function drawWaves(ctx: CanvasRenderingContext2D, pts: CloudPoint[], rnd: () => number, hue: number): void {
  const S = COVER_SIZE;
  const dens = density(pts, 96);
  const lines = 28;
  const waves = Array.from({ length: 3 }, () => ({ f: 1 + rnd() * 3.5, ph: rnd() * Math.PI * 2, a: 0.4 + rnd() * 0.6 }));
  for (let l = 0; l < lines; l++) {
    const y0 = S * 0.12 + (l / (lines - 1)) * S * 0.62;
    const centre = 1 - Math.abs(l / (lines - 1) - 0.5) * 2;
    ctx.beginPath();
    for (let x = -10; x <= S + 10; x += 6) {
      const u = Math.max(0, Math.min(1, x / S));
      const d = dens[Math.min(dens.length - 1, Math.floor(u * dens.length))];
      let y = 0;
      for (const w of waves) y += Math.sin(u * Math.PI * 2 * w.f + w.ph + l * 0.22) * w.a;
      y = y0 + y * (18 + 110 * d * centre) * (0.35 + 0.65 * centre);
      if (x === -10) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = linear(ctx, 0, 0, S, 0, hue + l * 0.004, 0.18 + 0.72 * centre * centre);
    ctx.lineWidth = 1.5 + 2.5 * centre;
    ctx.shadowColor = rgba(grad(0.6, hue), 0.8);
    ctx.shadowBlur = centre > 0.8 ? 24 : 0;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  // The notes themselves as sparks along the brightest line.
  for (const p of pts) {
    if (rnd() > 0.5) continue;
    const x = p.t * S;
    const y = S * 0.43 + (0.5 - p.k) * S * 0.38 + ((p.c % 5) - 2) * 9;
    ctx.fillStyle = rgba(grad(p.k, hue), 0.25 + 0.6 * p.v);
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + 4 * p.v, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, pts: CloudPoint[], rnd: () => number, hue: number): void {
  const S = COVER_SIZE;
  // Fewer, bigger cells for a sparse song; a fine grid for a busy one.
  const cols = Math.max(16, Math.min(40, Math.round(Math.sqrt(pts.length) * 2.6)));
  const rows = 20;
  ctx.save();
  ctx.translate(S / 2, S * 0.4);
  ctx.rotate((-8 + rnd() * 4) * (Math.PI / 180));
  const W = S * 1.15;
  const H = S * 0.74;
  const cw = W / cols;
  const rh = H / rows;
  ctx.translate(-W / 2, -H / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let c = 0; c <= cols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cw, 0);
    ctx.lineTo(c * cw, H);
    ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * rh);
    ctx.lineTo(W, r * rh);
    ctx.stroke();
  }
  // Faint ghost cells give the grid texture between the notes.
  for (let i = 0; i < cols * rows * 0.07; i++) {
    const c = Math.floor(rnd() * cols);
    const r = Math.floor(rnd() * rows);
    ctx.fillStyle = rgba(grad(1 - r / rows, hue), 0.05 + rnd() * 0.07);
    ctx.beginPath();
    ctx.roundRect(c * cw + 2, r * rh + 2, cw - 4, rh - 4, 4);
    ctx.fill();
  }
  // Notes: pitch picks the row (kept off the edges), channels that share a pitch (drums) sit on neighbouring rows.
  const cells = new Map<string, number>();
  for (const p of pts) {
    const r = Math.min(rows - 3, 2 + Math.floor((1 - p.k) * (rows - 7)) + (p.c % 3));
    const key = `${Math.min(cols - 1, Math.floor(p.t * cols))}:${r}`;
    cells.set(key, Math.max(cells.get(key) ?? 0, p.v));
  }
  for (const [key, v] of cells) {
    const [c, r] = key.split(':').map(Number);
    const len = 1 + Math.floor(rnd() * (v > 0.7 ? 3 : 2));
    const x = c * cw + 2;
    const y = r * rh + 2;
    const w = Math.min(cols - c, len) * cw - 4;
    const h = rh - 4;
    ctx.fillStyle = rgba(grad(1 - r / rows, hue), 0.3 + 0.65 * v);
    ctx.shadowColor = rgba(grad(1 - r / rows, hue), 0.9);
    ctx.shadowBlur = v > 0.75 ? 18 : 0;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
  }
  ctx.restore();
  ctx.shadowBlur = 0;
}

function drawOrbit(ctx: CanvasRenderingContext2D, pts: CloudPoint[], rnd: () => number, hue: number): void {
  const S = COVER_SIZE;
  const cx = S * 0.5;
  const cy = S * 0.42;
  const rings = 8;
  const r0 = S * 0.07;
  const r1 = S * 0.46;
  const rot = rnd() * Math.PI * 2;
  for (let i = 0; i < rings; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${(0.04 + 0.03 * (i % 2)).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r0 + ((r1 - r0) * i) / (rings - 1), 0, Math.PI * 2);
    ctx.stroke();
  }
  const pos = (p: CloudPoint): [number, number, number] => {
    const ring = Math.round(p.k * (rings - 1));
    const r = r0 + ((r1 - r0) * ring) / (rings - 1);
    const a = rot + p.t * Math.PI * 2 * (1.5 + (p.c % 3) * 0.25);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, ring];
  };
  // Arcs between consecutive notes of a channel.
  const last = new Map<number, CloudPoint>();
  for (const p of pts) {
    const prev = last.get(p.c);
    last.set(p.c, p);
    if (!prev) continue;
    const [x0, y0] = pos(prev);
    const [x1, y1] = pos(p);
    ctx.strokeStyle = rgba(grad((p.k + prev.k) / 2, hue), 0.08 + 0.22 * p.v);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx + (x0 + x1 - 2 * cx) * 0.15, cy + (y0 + y1 - 2 * cy) * 0.15, x1, y1);
    ctx.stroke();
  }
  for (const p of pts) {
    const [x, y] = pos(p);
    ctx.fillStyle = rgba(grad(p.k, hue), 0.35 + 0.6 * p.v);
    ctx.shadowColor = rgba(grad(p.k, hue), 1);
    ctx.shadowBlur = p.v > 0.8 ? 16 : 0;
    ctx.beginPath();
    ctx.arc(x, y, 2 + 6 * p.v, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  // A glowing core.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r0 * 1.4);
  g.addColorStop(0, rgba(grad(0.5, hue), 0.9));
  g.addColorStop(1, rgba(grad(0.5, hue), 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r0 * 1.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawBars(ctx: CanvasRenderingContext2D, pts: CloudPoint[], rnd: () => number, hue: number): void {
  const S = COVER_SIZE;
  const n = 64;
  const dens = density(pts, n);
  const reach = new Array<number>(n).fill(0);
  for (const p of pts) {
    const i = Math.min(n - 1, Math.floor(p.t * n));
    reach[i] = Math.max(reach[i], p.k);
  }
  const mid = S * 0.42;
  const gap = 6;
  const bw = (S - 160) / n - gap;
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, 0.08 + dens[i] * 0.7 + reach[i] * 0.3) * (0.85 + rnd() * 0.15);
    const h = v * S * 0.3;
    const x = 80 + i * (bw + gap);
    const g = ctx.createLinearGradient(0, mid - h, 0, mid + h);
    g.addColorStop(0, rgba(grad(0.95, hue), 0.95));
    g.addColorStop(0.5, rgba(grad(0.5, hue), 0.85));
    g.addColorStop(1, rgba(grad(0.05, hue), 0.95));
    ctx.fillStyle = g;
    ctx.shadowColor = rgba(grad(i / n, hue), 0.8);
    ctx.shadowBlur = v > 0.75 ? 20 : 0;
    ctx.beginPath();
    ctx.roundRect(x, mid - h, bw, h * 2, bw / 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  // Centre line.
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(60, mid - 1, S - 120, 2);
}

// ── Title + artist ─────────────────────────────────────────────────────

const FONT = '"Chakra Petch", "Segoe UI", sans-serif';

/** Split a title into at most `maxLines` lines that fit `width` at the current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= width) cur = next;
    else {
      if (!cur) return null; // one word wider than the line
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) return null;
    }
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

function drawText(ctx: CanvasRenderingContext2D, title: string, artist: string, hue: number): void {
  const S = COVER_SIZE;
  const left = 96;
  const width = S - left * 2;
  // A scrim keeps the text readable over any art.
  const scrim = ctx.createLinearGradient(0, S * 0.58, 0, S);
  scrim.addColorStop(0, 'rgba(10,10,15,0)');
  scrim.addColorStop(0.55, 'rgba(10,10,15,0.82)');
  scrim.addColorStop(1, 'rgba(10,10,15,0.96)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, S * 0.58, S, S * 0.42);

  const t = title.trim() || 'Untitled';
  let size = 150;
  let lines: string[] | null = null;
  for (; size >= 56; size -= 6) {
    ctx.font = `700 ${size}px ${FONT}`;
    lines = wrap(ctx, t, width, 2);
    if (lines) break;
  }
  if (!lines) {
    // Still too long: one line, ellipsized.
    ctx.font = `700 ${size}px ${FONT}`;
    let s = t;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
    lines = [`${s.trimEnd()}…`];
  }
  const lineH = size * 1.02;
  const artistSize = Math.max(34, Math.min(56, Math.round(size * 0.38)));
  const bottom = S - 104;
  const artistY = bottom;
  const titleLast = artist ? artistY - artistSize - 30 : bottom;
  const titleTop = titleLast - (lines.length - 1) * lineH;

  // Accent bar above the title.
  ctx.fillStyle = linear(ctx, left, 0, left + 220, 0, hue, 1);
  ctx.fillRect(left, titleTop - size * 0.82 - 34, 220, 8);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.font = `700 ${size}px ${FONT}`;
  lines.forEach((ln, i) => ctx.fillText(ln, left, titleTop + i * lineH));
  if (artist) {
    ctx.font = `500 ${artistSize}px ${FONT}`;
    ctx.fillStyle = 'rgba(228,228,240,0.82)';
    let a = artist.trim();
    while (a.length > 1 && ctx.measureText(a).width > width) a = a.slice(0, -1);
    ctx.fillText(a === artist.trim() ? a : `${a.trimEnd()}…`, left, artistY);
  }
  ctx.shadowBlur = 0;
}

// ── Public API ─────────────────────────────────────────────────────────

/** Draw a cover onto a COVER_SIZE² canvas context. Deterministic for (project notes, style, seed, text). */
export function drawCover(ctx: CanvasRenderingContext2D, p: Project, o: CoverDrawOptions): void {
  const rnd = mulberry32(hashString(`${p.id}|${o.style}|${o.seed}`));
  const hue = rnd() * 0.35;
  const pts = noteCloud(p, o.seed);
  ctx.save();
  backdrop(ctx, rnd, hue);
  if (o.style === 'waves') drawWaves(ctx, pts, rnd, hue);
  else if (o.style === 'grid') drawGrid(ctx, pts, rnd, hue);
  else if (o.style === 'orbit') drawOrbit(ctx, pts, rnd, hue);
  else drawBars(ctx, pts, rnd, hue);
  grain(ctx, rnd);
  drawText(ctx, o.title, o.artist, hue);
  ctx.restore();
}

async function fontsReady(): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`700 120px ${FONT}`, 'Aa'), document.fonts.load(`500 48px ${FONT}`, 'Aa')]);
  } catch {
    /* a fallback font still draws a usable cover */
  }
}

/** The song info the cover shows: the export title (or project name) and artist (or author). */
export function coverText(p: Project = getProject()): { title: string; artist: string } {
  const info = songInfo(p.meta, useProjectStatus.getState().status?.name);
  return { title: info.title, artist: info.artist };
}

/** Draw and encode a cover (JPEG, quality 0.92). */
export async function renderCover(p: Project, o: CoverDrawOptions): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' }> {
  await fontsReady();
  const canvas = document.createElement('canvas');
  canvas.width = COVER_SIZE;
  canvas.height = COVER_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("This window can't draw (no 2D canvas)");
  drawCover(ctx, p, o);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error("Couldn't encode the cover image");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
}

let responderInstalled = false;

/** Answer main's set_cover {generate} requests (once, at app start). */
export function installCoverResponder(): void {
  if (responderInstalled) return;
  responderInstalled = true;
  window.krypt.project.onCoverRequest((req) => {
    void (async () => {
      try {
        const seed = Number.isInteger(req.seed) ? (req.seed as number) : 1;
        const style = (COVER_STYLES as readonly string[]).includes(req.style ?? '') ? (req.style as CoverStyle) : styleForSeed(seed);
        const p = getProject();
        const out = await renderCover(p, { style, seed, ...coverText(p) });
        window.krypt.project.respondCover(req.id, { ok: true, bytes: out.bytes, mime: out.mime, style, seed });
      } catch (err) {
        window.krypt.project.respondCover(req.id, { ok: false, message: `Couldn't draw the cover: ${(err as Error)?.message ?? err}` });
      }
    })();
  });
}
