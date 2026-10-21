import { useEffect, useRef } from 'react';
import { GR_PLUGINS, slotKey } from '@shared/engine/meters';
import { onFrame, setupCanvas } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { GR_RANGE_DB, formatGr, grToMeter } from '../../live/slotMeters';
import { C, accentGradient, useWidth } from './scopeKit';

const H = 14;

export function GrMeter({ insertId, slotId, pluginType }: { insertId: string; slotId: string; pluginType: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const width = useWidth(wrap, 240);
  const key = slotKey(insertId, slotId);
  const label = pluginType === 'krypt.clipper' ? 'Over ceiling' : `Gain reduction${GR_PLUGINS[pluginType] === 'Duck' ? ' (duck)' : ''}`;

  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const c = canvas.current;
      if (!c) return;
      const [db, hold] = telemetry.gr(key);
      const sig = `${db.toFixed(2)}|${hold.toFixed(1)}|${width}`;
      if (sig === last) return;
      last = sig;
      const ctx = setupCanvas(c, width, H);
      ctx.clearRect(0, 0, width, H);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, width, H);
      for (let t = 3; t < GR_RANGE_DB; t += 3) {
        const x = Math.round(width - grToMeter(t) * width) + 0.5;
        ctx.fillStyle = t % 6 === 0 ? C.gridStrong : C.grid;
        ctx.fillRect(x, 0, 1, H);
      }
      const len = grToMeter(db) * width;
      ctx.fillStyle = accentGradient(ctx, width);
      ctx.fillRect(width - len, 2, len, H - 4);
      if (hold > 0.05) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(Math.round(width - grToMeter(hold) * width), 0, 1, H);
      }
      if (text.current) text.current.textContent = `${formatGr(hold)} dB`;
    });
  }, [key, width]);

  return (
    <div className="flex items-center gap-2" data-hint={`${label}: how many dB this effect is turning the signal down right now (white line = peak of the last 1.5 s; full bar = ${GR_RANGE_DB} dB)`}>
      <span className="w-[86px] flex-shrink-0 text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">{label}</span>
      <div ref={wrap} className="min-w-0 flex-1 overflow-hidden rounded-sm border border-white/[0.07]">
        <canvas ref={canvas} className="block" style={{ width, height: H }} />
      </div>
      <span ref={text} className="w-[54px] flex-shrink-0 text-right font-mono text-[10px] text-white/85">
        0.0 dB
      </span>
    </div>
  );
}
