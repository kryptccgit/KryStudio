// ──────────────────────────────────────────────────────────────────────
// Krypt Analyzer window: spectrum (log, smoothed, peak hold), oscilloscope
// and loudness (LUFS momentary / short-term / integrated, true peak,
// correlation) of the slot's signal. The engine streams it while this
// window is open (a watched slot, docs/ENGINE_PROTOCOL.md §15). The
// plugin's `view` param picks the big display.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { slotKey } from '@shared/engine/meters';
import { dispatch, useProject } from '../../doc/store';
import { onFrame, setupCanvas } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { SpectrumSmoother, formatLevel } from '../../live/slotMeters';
import { flashHint } from '../../app/hints';
import { toast } from '../../app/notify';
import { cls } from '../../utils/format';
import { FREQ_GRID, formatHz, freqToX } from './eqResponse';
import { C, accentGradient, paintSpectrum, useWidth } from './scopeKit';

const VIEWS = ['Spectrum', 'Scope', 'Loudness'] as const;
const HEIGHT = 180;
const SPEC_FLOOR = -96;
const SPEC_TOP = 6;
/** Momentary loudness history (≈ 8 s at ~30 snapshots/s). */
const HISTORY = 240;
const LUFS_FLOOR = -60;

export function AnalyzerDisplay({ insertId, slotId }: { insertId: string; slotId: string }) {
  const key = slotKey(insertId, slotId);
  const view = Math.round(useProject((p) => p.mixer.inserts[insertId]?.slots[slotId]?.params.view) ?? 0);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useWidth(wrap);
  const [readout, setReadout] = useState({ m: '-inf', s: '-inf', i: '-inf', tp: '-inf', corr: null as number | null, live: false });

  useEffect(() => telemetry.watchSlot(key), [key]);

  useEffect(() => {
    const smoother = new SpectrumSmoother(24, 1500, SPEC_FLOOR);
    const history: number[] = [];
    let lastSpec: number[] | undefined;
    let lastScope: number[] | undefined;
    let lastText = '';
    let lastSeen = 0;
    return onFrame((dt, now) => {
      const c = canvas.current;
      if (!c) return;
      const d = telemetry.scope(key);
      if (d) lastSeen = now;
      if (d?.spectrum && d.spectrum !== lastSpec) {
        lastSpec = d.spectrum;
        smoother.push(d.spectrum, now);
        history.push(d.lufsM ?? LUFS_FLOOR);
        if (history.length > HISTORY) history.shift();
      }
      if (d?.scope) lastScope = d.scope;
      smoother.decay(dt, now);
      // numbers (React state only when the text changes)
      const live = now - lastSeen < 500;
      const next = { m: formatLevel(d?.lufsM), s: formatLevel(d?.lufsS), i: formatLevel(d?.lufsI), tp: formatLevel(d?.truePeak), corr: d?.correlation ?? null, live };
      const text = JSON.stringify(next);
      if (text !== lastText) {
        lastText = text;
        setReadout(next);
      }
      const w = width;
      const ctx = setupCanvas(c, w, HEIGHT);
      ctx.clearRect(0, 0, w, HEIGHT);
      ctx.font = '9px "Chakra Petch", sans-serif';
      ctx.textBaseline = 'top';
      if (view === 1) drawScope(ctx, w, lastScope);
      else if (view === 2) drawHistory(ctx, w, history);
      else {
        for (const f of FREQ_GRID) {
          const x = Math.round(freqToX(f, w)) + 0.5;
          ctx.fillStyle = C.grid;
          ctx.fillRect(x, 0, 1, HEIGHT);
          ctx.fillStyle = C.text;
          if (f > 20 && f < 20000) ctx.fillText(formatHz(f), x + 2, HEIGHT - 11);
        }
        for (let db = 0; db >= -84; db -= 12) {
          const y = Math.round(HEIGHT - ((db - SPEC_FLOOR) / (SPEC_TOP - SPEC_FLOOR)) * HEIGHT) + 0.5;
          ctx.fillStyle = db === 0 ? C.gridStrong : C.grid;
          ctx.fillRect(0, y, w, 1);
          ctx.fillStyle = C.text;
          ctx.fillText(`${db}`, 2, y + 1);
        }
        const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
        g.addColorStop(0, 'rgba(236,72,153,0.55)');
        g.addColorStop(0.5, 'rgba(168,85,247,0.35)');
        g.addColorStop(1, 'rgba(99,102,241,0.08)');
        paintSpectrum(ctx, smoother.shown, smoother.peak, { w, h: HEIGHT, floorDb: SPEC_FLOOR, topDb: SPEC_TOP }, g, 'rgba(255,255,255,0.55)');
      }
    });
  }, [key, width, view]);

  const setView = (v: number): void => {
    void dispatch('mixer.setSlotParams', { insertId, slotId, params: { view: v } }, { label: `Analyzer: ${VIEWS[v]}` });
  };

  const reset = (): void => {
    if (telemetry.resetSlot(key)) flashHint('Loudness measurement restarted', 'ok');
    else toast.warn('The audio engine is not connected, so there is nothing to reset.');
  };

  const corr = readout.corr;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        {VIEWS.map((v, i) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(i)}
            className={cls(
              'h-5 rounded-md border px-2 text-[10px] font-semibold transition',
              view === i ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/[0.03] text-white/60 hover:text-white',
            )}
            data-hint={`Show the ${v.toLowerCase()} display`}
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          onClick={reset}
          className="ml-auto flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 text-[10px] text-white/70 hover:text-white"
          data-hint="Restart the integrated loudness and true-peak measurement (it also restarts whenever playback starts)"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
      </div>
      <div ref={wrap} className="relative w-full overflow-hidden rounded-lg border border-white/[0.07] bg-black/40" style={{ height: HEIGHT }}>
        <canvas ref={canvas} className="block" style={{ width, height: HEIGHT }} />
        {!readout.live && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-krypt-muted">
            {telemetry.connected ? 'Waiting for audio… (play something through this insert)' : 'The audio engine is not connected'}
          </div>
        )}
      </div>
      <div className="grid grid-cols-5 gap-1">
        <Readout label="Momentary" value={readout.m} unit="LUFS" />
        <Readout label="Short-term" value={readout.s} unit="LUFS" />
        <Readout label="Integrated" value={readout.i} unit="LUFS" accent />
        <Readout label="True peak" value={readout.tp} unit="dBTP" warn={readout.tp !== '-inf' && Number(readout.tp) > -1} />
        <div className="flex flex-col justify-between rounded-md border border-white/[0.07] bg-black/30 px-1.5 py-1" data-hint="Stereo correlation: +1 = mono, 0 = wide / unrelated, below 0 = out of phase (cancels in mono)">
          <span className="text-[8px] uppercase tracking-wider text-krypt-muted">Correlation</span>
          <div className="relative mt-1 h-1.5 rounded-full bg-white/[0.06]">
            <div className="absolute left-1/2 top-0 h-1.5 w-px bg-white/25" />
            {corr !== null && (
              <div
                className={cls('absolute top-[-2px] h-[10px] w-[3px] rounded-sm', corr < 0 ? 'bg-rose-400' : 'bg-krypt-purple')}
                style={{ left: `calc(${((corr + 1) / 2) * 100}% - 1.5px)` }}
              />
            )}
          </div>
          <span className={cls('font-mono text-[10px]', corr !== null && corr < 0 ? 'text-rose-300' : 'text-white/85')}>{corr === null ? '—' : corr.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

function Readout({ label, value, unit, accent, warn }: { label: string; value: string; unit: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={cls('flex flex-col rounded-md border bg-black/30 px-1.5 py-1', accent ? 'border-krypt-purple/30' : 'border-white/[0.07]')}>
      <span className="text-[8px] uppercase tracking-wider text-krypt-muted">{label}</span>
      <span className={cls('font-mono text-[13px] font-semibold leading-tight', warn ? 'text-amber-300' : 'text-white/90')}>{value}</span>
      <span className="text-[8px] text-krypt-muted">{unit}</span>
    </div>
  );
}

function drawScope(ctx: CanvasRenderingContext2D, w: number, pts: number[] | undefined): void {
  const mid = HEIGHT / 2;
  for (const v of [-0.5, 0, 0.5]) {
    ctx.fillStyle = v === 0 ? C.gridStrong : C.grid;
    ctx.fillRect(0, Math.round(mid - v * (mid - 4)) + 0.5, w, 1);
  }
  if (!pts?.length) return;
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = (i / (pts.length - 1)) * w;
    const y = mid - Math.max(-1.1, Math.min(1.1, v)) * (mid - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = accentGradient(ctx, w);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHistory(ctx: CanvasRenderingContext2D, w: number, hist: number[]): void {
  const y = (lufs: number): number => HEIGHT - ((Math.max(LUFS_FLOOR, Math.min(0, lufs)) - LUFS_FLOOR) / -LUFS_FLOOR) * HEIGHT;
  for (const l of [-6, -14, -23, -36, -48]) {
    const yy = Math.round(y(l)) + 0.5;
    ctx.fillStyle = l === -14 ? 'rgba(168,85,247,0.35)' : C.grid;
    ctx.fillRect(0, yy, w, 1);
    ctx.fillStyle = C.text;
    ctx.fillText(`${l} LUFS${l === -14 ? ' (streaming)' : ''}`, 2, yy + 1);
  }
  if (hist.length < 2) return;
  ctx.beginPath();
  hist.forEach((v, i) => {
    const x = w - (hist.length - 1 - i) * (w / (HISTORY - 1));
    if (i === 0) ctx.moveTo(x, y(v));
    else ctx.lineTo(x, y(v));
  });
  ctx.strokeStyle = accentGradient(ctx, w);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
