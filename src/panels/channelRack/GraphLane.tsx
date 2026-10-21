import { useMemo, useRef, useState } from 'react';
import type { Note } from '@shared/schema/project';
import { beginGesture, type Gesture } from '../../doc/gesture';
import { setLiveHint, flashHint } from '../../app/hints';
import { analyzeSteps, CELL_W } from './StepRow';
import type { GraphLane as Lane } from '../../state/ui';

const LANE_H = 64;

export function GraphLane({
  lane,
  channelId,
  patternId,
  notes,
  steps,
  color,
  stepsPerBeat,
}: {
  lane: Exclude<Lane, 'off'>;
  channelId: string;
  patternId: string;
  notes: Record<string, Note> | undefined;
  steps: number;
  color: string;
  stepsPerBeat: number;
}) {
  const { steps: on } = useMemo(() => analyzeSteps(notes), [notes]);
  const [local, setLocal] = useState<Map<number, number>>(() => new Map());
  const g = useRef<{ gesture: Gesture; el: HTMLElement; last: number } | null>(null);

  const valueAt = (clientY: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    const t = 1 - (clientY - r.top) / r.height;
    const v = Math.max(0, Math.min(1, t));
    return lane === 'vel' ? v : v * 2 - 1;
  };

  const write = (step: number, v: number): void => {
    const cur = g.current;
    const info = on.get(step);
    if (!cur || !info) return;
    const value = Math.round(v * 100) / 100;
    setLocal((m) => new Map(m).set(step, value));
    cur.gesture.exec('notes.update', { patternId, channelId, updates: info.ids.map((id) => (lane === 'vel' ? { id, vel: value } : { id, pan: value })) });
    setLiveHint(lane === 'vel' ? `Step ${step + 1} velocity: ${Math.round(value * 100)}%` : `Step ${step + 1} pan: ${value === 0 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`}`);
  };

  const stepAt = (clientX: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(steps - 1, Math.floor((clientX - r.left) / CELL_W)));
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
    }
    const step = stepAt(e.clientX, el);
    g.current = { gesture: beginGesture(lane === 'vel' ? 'Edit step velocities' : 'Edit step pans'), el, last: step };
    const v = e.altKey ? (lane === 'vel' ? 0.78 : 0) : valueAt(e.clientY, el);
    write(step, v);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const cur = g.current;
    if (!cur) return;
    const step = stepAt(e.clientX, cur.el);
    const v = valueAt(e.clientY, cur.el);
    if (step !== cur.last) {
      const dir = step > cur.last ? 1 : -1;
      for (let s = cur.last + dir; dir > 0 ? s <= step : s >= step; s += dir) write(s, v);
      cur.last = step;
    } else write(step, v);
  };

  const finish = (): void => {
    const cur = g.current;
    if (!cur) return;
    g.current = null;
    setLiveHint('');
    void cur.gesture.end().then(() => {
      setLocal(new Map());
      flashHint(lane === 'vel' ? 'Velocities set (one undo)' : 'Pans set (one undo)', 'ok', 1200);
    });
  };

  const bars = [];
  for (let i = 0; i < steps; i++) {
    const info = on.get(i);
    const shade = Math.floor(i / stepsPerBeat) % 2 === 1;
    const v = local.get(i) ?? (info ? (lane === 'vel' ? info.vel : info.pan) : null);
    let bar = null;
    if (v !== null && info) {
      if (lane === 'vel') {
        bar = <div className="absolute bottom-0 left-[3px] right-[3px] rounded-t-sm" style={{ height: `${v * 100}%`, background: color, opacity: 0.85 }} />;
      } else {
        const common = { height: `${Math.max(Math.abs(v) * 50, 2)}%`, background: color, opacity: 0.85 };
        bar = <div className="absolute left-[3px] right-[3px] rounded-sm" style={v >= 0 ? { ...common, bottom: '50%' } : { ...common, top: '50%' }} />;
      }
    }
    bars.push(
      <div key={i} className={shade ? 'relative h-full bg-white/[0.035]' : 'relative h-full'} style={{ width: CELL_W }}>
        {bar}
      </div>,
    );
  }

  return (
    <div
      className="relative flex touch-none cursor-crosshair border-y border-white/[0.06] bg-black/30"
      style={{ width: steps * CELL_W, height: LANE_H }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      data-hint={lane === 'vel' ? 'Velocity lane: drag across steps to draw. Alt+click resets a step.' : 'Pan lane: drag up = right, down = left. Alt+click centers.'}
    >
      {lane === 'pan' && <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px bg-white/15" />}
      {bars}
    </div>
  );
}

export const GRAPH_LANE_H = LANE_H;
