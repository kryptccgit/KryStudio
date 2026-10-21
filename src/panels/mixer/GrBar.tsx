import { useEffect, useRef } from 'react';
import { slotKey } from '@shared/engine/meters';
import { onFrame, setupCanvas } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { formatGr, grToMeter } from '../../live/slotMeters';

const W = 30;
const H = 6;

export function GrBar({ insertId, slotId }: { insertId: string; slotId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = slotKey(insertId, slotId);
  useEffect(() => {
    let last = -1;
    return onFrame(() => {
      const c = canvas.current;
      if (!c) return;
      const [db, hold] = telemetry.gr(key);
      const px = Math.round(grToMeter(db) * W * 2) / 2;
      const hp = Math.round(grToMeter(hold) * W);
      const sig = px * 1000 + hp;
      if (sig === last) return;
      last = sig;
      const ctx = setupCanvas(c, W, H);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, '#6366F1');
      g.addColorStop(0.5, '#A855F7');
      g.addColorStop(1, '#EC4899');
      ctx.fillStyle = g;
      ctx.fillRect(W - px, 1, px, H - 2);
      if (hp > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(W - hp, 0, 1, H);
      }
      c.title = `Gain reduction ${formatGr(hold)} dB`;
    });
  }, [key]);
  return <canvas ref={canvas} className="block flex-shrink-0 rounded-[2px]" style={{ width: W, height: H }} data-hint="Gain reduction: how far this effect is turning the signal down (full bar = 24 dB)" />;
}
