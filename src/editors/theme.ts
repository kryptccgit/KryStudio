export const C = {
  void: '#0A0A0F',
  panel: '#11111A',
  surface: '#141419',
  gridBg: '#0C0C13',
  rowWhite: '#0E0E16',
  rowBlack: '#09090D',
  indigo: '#6366F1',
  purple: '#A855F7',
  pink: '#EC4899',
  muted: '#A1A1AA',
  text: '#E4E4E7',
  glow: '#C084FC',
  hairline: 'rgba(255,255,255,0.10)',
  lineStep: 'rgba(255,255,255,0.035)',
  lineBeat: 'rgba(255,255,255,0.075)',
  lineBar: 'rgba(255,255,255,0.16)',
  lineSnap: 'rgba(168,85,247,0.07)',
  rowLine: 'rgba(255,255,255,0.03)',
  octaveLine: 'rgba(255,255,255,0.09)',
  scaleRow: 'rgba(168,85,247,0.075)',
  rootRow: 'rgba(236,72,153,0.12)',
  beyondEnd: 'rgba(0,0,0,0.38)',
  marquee: 'rgba(168,85,247,0.12)',
  marqueeEdge: 'rgba(192,132,252,0.85)',
  playhead: '#EC4899',
  loop: 'rgba(99,102,241,0.22)',
  loopEdge: '#818CF8',
};

export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';
export const FONT_SANS = '"Chakra Petch", Inter, system-ui, sans-serif';

type RGB = [number, number, number];

const rgbCache = new Map<string, RGB>();
export function hexToRgb(hex: string): RGB {
  let v = rgbCache.get(hex);
  if (v) return v;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  v = Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [168, 85, 247];
  rgbCache.set(hex, v);
  return v;
}

const rgbaCache = new Map<string, string>();
export function rgba(hex: string, a: number): string {
  const q = Math.round(Math.max(0, Math.min(1, a)) * 100);
  const key = `${hex}|${q}`;
  let s = rgbaCache.get(key);
  if (!s) {
    const [r, g, b] = hexToRgb(hex);
    s = `rgba(${r},${g},${b},${q / 100})`;
    rgbaCache.set(key, s);
  }
  return s;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const STOPS: RGB[] = [hexToRgb('#4F46E5'), hexToRgb(C.purple), hexToRgb(C.pink)];
const velCache: string[] = [];
export function velocityColor(vel: number): string {
  const i = Math.round(Math.max(0, Math.min(1, vel)) * 63);
  let s = velCache[i];
  if (!s) {
    const t = i / 63;
    const [a, b, u] = t < 0.5 ? [STOPS[0], STOPS[1], t * 2] : [STOPS[1], STOPS[2], (t - 0.5) * 2];
    const k = 0.62 + 0.38 * t;
    s = `rgb(${Math.round(lerp(a[0], b[0], u) * k)},${Math.round(lerp(a[1], b[1], u) * k)},${Math.round(lerp(a[2], b[2], u) * k)})`;
    velCache[i] = s;
  }
  return s;
}

export function lighten(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.round(lerp(r, 255, t))},${Math.round(lerp(g, 255, t))},${Math.round(lerp(b, 255, t))})`;
}
