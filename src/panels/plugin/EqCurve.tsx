import { useEffect, useMemo, useRef, useState } from 'react';
import { pluginById } from '@shared/plugins/catalog';
import { clampToSpec } from '@shared/plugins/types';
import { slotKey } from '@shared/engine/meters';
import { dispatch, getProject, useProject } from '../../doc/store';
import { useEngineStatus } from '../../state/status';
import { onFrame, setupCanvas } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { SpectrumSmoother } from '../../live/slotMeters';
import { cls } from '../../utils/format';
import {
  EQ_BANDS,
  FREQ_GRID,
  bandResponseDb,
  dbToY,
  eqResponseDb,
  formatHz,
  freqToX,
  logFreqs,
  xToFreq,
  yToDb,
  type EqBand,
  type EqParams,
} from './eqResponse';
import { C, accentGradient, paintSpectrum, useWidth } from './scopeKit';

const HEIGHT = 190;
const RANGE_DB = 24;
const HANDLE_R = 6;
const BAND_COLORS = ['#94a3b8', '#6366F1', '#8b5cf6', '#A855F7', '#c084fc', '#EC4899', '#94a3b8'];

function specOf(id: string) {
  return pluginById('krypt.eq')?.params.find((p) => p.id === id) ?? null;
}

function handleAt(b: EqBand, p: EqParams, w: number): { x: number; y: number } {
  return { x: freqToX(p(b.freq), w), y: dbToY(b.gain ? p(b.gain) : 0, HEIGHT, RANGE_DB) };
}

export function EqCurve({ insertId, slotId }: { insertId: string; slotId: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useWidth(wrap);
  const docParams = useProject((p) => p.mixer.inserts[insertId]?.slots[slotId]?.params);
  const sr = useEngineStatus((s) => s.status?.device?.sampleRate) || 48000;
  const key = slotKey(insertId, slotId);
  const local = useRef<Record<string, number>>({});
  const [, bump] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const drag = useRef<{ band: EqBand; pending: Record<string, number> | null; raf: number } | null>(null);
  const dirty = useRef(true);

  const get: EqParams = useMemo(() => {
    return (id: string) => local.current[id] ?? docParams?.[id] ?? specOf(id)?.default ?? 0;
  }, [docParams]);

  const getRef = useRef(get);
  getRef.current = get;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    dirty.current = true;
  });

  useEffect(() => telemetry.watchSlot(key), [key]);

  useEffect(() => {
    const smoother = new SpectrumSmoother(36, 900);
    let lastSpec: number[] | undefined;
    const freqs = logFreqs(240);
    return onFrame((dt, now) => {
      const c = canvas.current;
      if (!c) return;
      const sc = telemetry.scope(key);
      const spec = sc?.spectrum;
      if (spec && spec !== lastSpec) {
        lastSpec = spec;
        smoother.push(spec, now);
        dirty.current = true;
      }
      if (smoother.shown.length) {
        smoother.decay(dt, now);
        dirty.current = true;
      }
      if (!dirty.current) return;
      dirty.current = false;
      const w = width;
      const get = getRef.current;
      const active = activeRef.current;
      const ctx = setupCanvas(c, w, HEIGHT);
      ctx.clearRect(0, 0, w, HEIGHT);
      if (smoother.shown.length) {
        const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
        g.addColorStop(0, 'rgba(168,85,247,0.30)');
        g.addColorStop(1, 'rgba(99,102,241,0.04)');
        paintSpectrum(ctx, smoother.shown, smoother.peak, { w, h: HEIGHT, floorDb: -90, topDb: 0 }, g, 'rgba(236,72,153,0.35)');
      }
      ctx.font = '9px "Chakra Petch", sans-serif';
      ctx.textBaseline = 'top';
      for (const f of FREQ_GRID) {
        const x = Math.round(freqToX(f, w)) + 0.5;
        ctx.fillStyle = C.grid;
        ctx.fillRect(x, 0, 1, HEIGHT);
        ctx.fillStyle = C.text;
        if (f > 20 && f < 20000) ctx.fillText(formatHz(f), x + 2, HEIGHT - 11);
      }
      for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
        const y = Math.round(dbToY(db, HEIGHT, RANGE_DB)) + 0.5;
        ctx.fillStyle = db === 0 ? C.gridStrong : C.grid;
        ctx.fillRect(0, y, w, 1);
        ctx.fillStyle = C.text;
        ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 2, y + 1);
      }
      if (active !== null) {
        const b = EQ_BANDS[active];
        ctx.beginPath();
        freqs.forEach((f, i) => {
          const y = dbToY(bandResponseDb(b, get, f, sr), HEIGHT, RANGE_DB);
          if (i === 0) ctx.moveTo(freqToX(f, w), y);
          else ctx.lineTo(freqToX(f, w), y);
        });
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const resp = eqResponseDb(get, freqs, sr);
      ctx.beginPath();
      resp.forEach((db, i) => {
        const x = freqToX(freqs[i], w);
        const y = dbToY(db, HEIGHT, RANGE_DB);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = accentGradient(ctx, w);
      ctx.lineWidth = 2;
      ctx.stroke();
      EQ_BANDS.forEach((b, i) => {
        const { x, y } = handleAt(b, get, w);
        const on = get(b.on) >= 0.5;
        ctx.beginPath();
        ctx.arc(x, y, i === active ? HANDLE_R + 1.5 : HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = on ? BAND_COLORS[i] : 'rgba(10,10,15,0.85)';
        ctx.globalAlpha = on ? 0.95 : 0.8;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = on ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = on ? '#0A0A0F' : 'rgba(255,255,255,0.5)';
        ctx.font = 'bold 8px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b.n), x, y + 0.5);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      });
    });
  }, [key, width, sr]);

  const hit = (ev: { clientX: number; clientY: number }): number | null => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r) return null;
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    let best: number | null = null;
    let bestD = (HANDLE_R + 6) ** 2;
    EQ_BANDS.forEach((b, i) => {
      const h = handleAt(b, get, width);
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const commit = (params: Record<string, number>, what: string): void => {
    void dispatch('mixer.setSlotParams', { insertId, slotId, params }, { coalesceKey: `eq:${insertId}/${slotId}/${what}`, label: 'Shape EQ' });
  };

  const clampParam = (id: string, v: number): number => {
    const s = specOf(id);
    return s ? clampToSpec(s, v) : v;
  };

  const flush = (): void => {
    const d = drag.current;
    if (!d) return;
    d.raf = 0;
    if (d.pending) {
      commit(d.pending, `b${d.band.n}`);
      d.pending = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const i = hit(e);
    setActive(i);
    if (i === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { band: EQ_BANDS[i], pending: null, raf: 0 };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    if (!d) return;
    const r = e.currentTarget.getBoundingClientRect();
    const b = d.band;
    const patch: Record<string, number> = { [b.freq]: clampParam(b.freq, xToFreq(e.clientX - r.left, width)) };
    if (b.gain) patch[b.gain] = clampParam(b.gain, Math.round(yToDb(e.clientY - r.top, HEIGHT, RANGE_DB) * 10) / 10);
    if (get(b.on) < 0.5) patch[b.on] = 1;
    Object.assign(local.current, patch);
    d.pending = { ...(d.pending ?? {}), ...patch };
    if (!d.raf) d.raf = requestAnimationFrame(flush);
    bump((n) => n + 1);
  };

  const onPointerUp = (): void => {
    const d = drag.current;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    flush();
    drag.current = null;
    setTimeout(() => {
      local.current = {};
      bump((n) => n + 1);
    }, 250);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const i = hit(e) ?? active;
    if (i === null) return;
    const b = EQ_BANDS[i];
    if (!b.q) return;
    const q = clampParam(b.q, get(b.q) * Math.pow(1.12, -Math.sign(e.deltaY)));
    setActive(i);
    commit({ [b.q]: Math.round(q * 1000) / 1000 }, `q${b.n}`);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const i = hit(e);
    if (i === null) return;
    const b = EQ_BANDS[i];
    const on = get(b.on) >= 0.5;
    void dispatch('mixer.setSlotParams', { insertId, slotId, params: { [b.on]: on ? 0 : 1 } }, { label: `${b.label} ${on ? 'off' : 'on'}` });
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const block = (e: WheelEvent): void => {
      if (hit(e) !== null || active !== null) e.preventDefault();
    };
    c.addEventListener('wheel', block, { passive: false });
    return () => c.removeEventListener('wheel', block);
  });

  const a = active !== null ? EQ_BANDS[active] : null;
  const exists = !!getProject().mixer.inserts[insertId]?.slots[slotId];
  return (
    <div className="space-y-1">
      <div ref={wrap} className="relative w-full overflow-hidden rounded-lg border border-white/[0.07] bg-black/40" style={{ height: HEIGHT }}>
        <canvas
          ref={canvas}
          className={cls('block touch-none', exists ? 'cursor-crosshair' : 'pointer-events-none')}
          style={{ width, height: HEIGHT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
          data-hint="Drag a numbered handle: frequency and gain · mouse wheel on a handle: Q (width) · double-click: band on/off. The shaded area is this insert's live spectrum after the EQ."
        />
      </div>
      <div className="flex h-4 items-center gap-2 px-0.5 font-mono text-[10px] text-krypt-muted">
        {a ? (
          <>
            <span className="font-sans font-semibold text-white/85">{a.label}</span>
            <span>{formatHz(get(a.freq))} Hz</span>
            {a.gain && <span>{`${get(a.gain) > 0 ? '+' : ''}${get(a.gain).toFixed(1)} dB`}</span>}
            {a.q && <span>Q {get(a.q).toFixed(2)}</span>}
            {a.slope && <span>{['12', '24', '48'][Math.round(get(a.slope))] ?? '24'} dB/oct</span>}
            <span className={get(a.on) >= 0.5 ? 'text-emerald-300/80' : 'text-white/35'}>{get(a.on) >= 0.5 ? 'on' : 'off'}</span>
          </>
        ) : (
          <span>Click a handle to inspect a band · wheel = Q · double-click = on/off</span>
        )}
      </div>
    </div>
  );
}
