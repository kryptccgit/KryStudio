// Sample waveform from engine.peaks (cached per path). Degrades to a flat
// line + a note when the engine is unavailable. `overlay` draws on top in
// source-time coordinates (x = sec / durationSec × width): the Audio Clip's
// warp markers and beat grid (./WarpOverlay.tsx).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { setupCanvas } from '../../render/frameLoop';

interface WavePeaks {
  data: number[];
  /** Source length (frames / sampleRate), null when the engine didn't say. */
  durationSec: number | null;
}

/** What an overlay needs to place things on the waveform. */
export interface WaveGeometry {
  width: number;
  height: number;
  durationSec: number | null;
}

const cache = new Map<string, WavePeaks>();
const inflight = new Map<string, Promise<WavePeaks | string>>();

async function loadPeaks(path: string): Promise<WavePeaks | string> {
  const hit = cache.get(path);
  if (hit) return hit;
  const running = inflight.get(path);
  if (running) return running;
  const p = (async () => {
    try {
      const r = await window.krypt.engine.peaks(path, 512);
      if (r.ok && r.data && r.data.data.length) {
        const wp: WavePeaks = { data: r.data.data, durationSec: r.data.frames > 0 && r.data.sampleRate > 0 ? r.data.frames / r.data.sampleRate : null };
        cache.set(path, wp);
        return wp;
      }
      return r.message || 'Waveform unavailable';
    } catch (err) {
      return (err as Error)?.message || 'Waveform unavailable';
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

export function Waveform({
  path,
  color,
  height = 72,
  overlay,
}: {
  path: string | null;
  color: string;
  height?: number;
  /** Drawn over the waveform once the peaks are loaded. */
  overlay?: (g: WaveGeometry) => ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(300);
  const [wave, setWave] = useState<WavePeaks | null>(null);
  const peaks = wave?.data ?? null;
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(80, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setWave(null);
    setError(null);
    if (!path) return;
    void loadPeaks(path).then((r) => {
      if (!alive) return;
      if (typeof r === 'string') setError(r);
      else setWave(r);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = setupCanvas(c, width, height);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, mid, width, 1);
    if (!peaks) return;
    const buckets = peaks.length / 2;
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, color);
    grad.addColorStop(0.5, '#ffffff');
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.9;
    for (let x = 0; x < width; x++) {
      const b0 = Math.floor((x / width) * buckets);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / width) * buckets));
      let lo = 1;
      let hi = -1;
      for (let b = b0; b < b1 && b < buckets; b++) {
        lo = Math.min(lo, peaks[b * 2]);
        hi = Math.max(hi, peaks[b * 2 + 1]);
      }
      if (hi < lo) continue;
      const y0 = mid - hi * (mid - 2);
      const y1 = mid - lo * (mid - 2);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    ctx.globalAlpha = 1;
  }, [peaks, width, height, color]);

  return (
    <div ref={wrap} className="relative w-full overflow-hidden rounded-lg border border-white/[0.07] bg-black/40" style={{ height }}>
      <canvas ref={canvas} className="block" style={{ width, height }} />
      {overlay && wave && overlay({ width, height, durationSec: wave.durationSec })}
      {path && !peaks && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-krypt-muted">
          {error ? `Waveform unavailable: ${error}` : 'Loading waveform…'}
        </div>
      )}
      {!path && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-krypt-muted">No sample loaded · drop one here</div>}
    </div>
  );
}
