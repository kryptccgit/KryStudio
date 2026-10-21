import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '@shared/schema/project';
import { TICKS_PER_STEP } from '@shared/schema/time';
import { getProject } from '../../doc/store';
import { beginGesture, type Gesture } from '../../doc/gesture';
import { setupCanvas } from '../../render/frameLoop';
import { StepButton } from '../../controls/Toggle';
import { flashHint } from '../../app/hints';
import { openInPianoRoll } from './rackActions';

export const CELL_W = 22;
export const ROW_H = 28;
export const ACCENT_VEL = 1;
export const DEFAULT_VEL = 0.78;

export interface StepInfo {
  vel: number;
  pan: number;
  ids: string[];
}

export function analyzeSteps(notes: Record<string, Note> | undefined): { steps: Map<number, StepInfo>; isSteps: boolean; key: number | null } {
  const steps = new Map<number, StepInfo>();
  if (!notes) return { steps, isSteps: true, key: null };
  let key: number | null = null;
  let isSteps = true;
  for (const n of Object.values(notes)) {
    if (n.tick % TICKS_PER_STEP !== 0 || n.dur > TICKS_PER_STEP || (key !== null && n.key !== key)) isSteps = false;
    key ??= n.key;
    const s = n.tick / TICKS_PER_STEP;
    if (Number.isInteger(s)) {
      const cur = steps.get(s);
      if (cur) cur.ids.push(n.id);
      else steps.set(s, { vel: n.vel, pan: n.pan, ids: [n.id] });
    }
  }
  return { steps, isSteps, key };
}

function notesAtStep(channelId: string, patternId: string, step: number): Note[] {
  const notes = getProject().patterns[patternId]?.notes[channelId];
  if (!notes) return [];
  const tick = step * TICKS_PER_STEP;
  return Object.values(notes).filter((n) => n.tick === tick);
}

export const StepGrid = memo(function StepGrid({
  channelId,
  patternId,
  notes,
  steps,
  color,
  stepsPerBeat,
}: {
  channelId: string;
  patternId: string;
  notes: Record<string, Note> | undefined;
  steps: number;
  color: string;
  stepsPerBeat: number;
}) {
  const { steps: on, key } = useMemo(() => analyzeSteps(notes), [notes]);
  const [pending, setPending] = useState<Map<number, boolean>>(() => new Map());
  const g = useRef<{ gesture: Gesture; mode: 'on' | 'off'; visited: Set<number>; last: number; el: HTMLElement } | null>(null);

  useEffect(() => {
    if (!pending.size || g.current) return;
    setPending(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  const stepAt = (clientX: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(steps - 1, Math.floor((clientX - r.left) / CELL_W)));
  };

  const apply = (step: number): void => {
    const cur = g.current;
    if (!cur || cur.visited.has(step)) return;
    cur.visited.add(step);
    const isOn = notesAtStep(channelId, patternId, step).length > 0;
    if (cur.mode === 'on' && !isOn) {
      cur.gesture.exec('notes.toggleStep', { patternId, channelId, step, key: key ?? undefined });
      setPending((m) => new Map(m).set(step, true));
    } else if (cur.mode === 'off' && isOn) {
      cur.gesture.exec('notes.toggleStep', { patternId, channelId, step });
      setPending((m) => new Map(m).set(step, false));
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const el = e.currentTarget;
    const step = stepAt(e.clientX, el);
    const existing = notesAtStep(channelId, patternId, step);
    if (e.button === 0 && e.shiftKey) {
      const gesture = beginGesture('Accent step');
      if (existing.length) {
        const accent = existing.every((n) => n.vel >= 0.95);
        gesture.exec('notes.update', { patternId, channelId, updates: existing.map((n) => ({ id: n.id, vel: accent ? DEFAULT_VEL : ACCENT_VEL })) });
        flashHint(accent ? `Step ${step + 1}: accent off` : `Step ${step + 1}: accent`, 'ok', 1200);
      } else {
        gesture.exec('notes.toggleStep', { patternId, channelId, step, vel: ACCENT_VEL, key: key ?? undefined });
        setPending((m) => new Map(m).set(step, true));
        flashHint(`Step ${step + 1}: accent`, 'ok', 1200);
      }
      void gesture.end();
      return;
    }
    const mode: 'on' | 'off' = e.button === 2 ? 'off' : existing.length ? 'off' : 'on';
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
    }
    g.current = { gesture: beginGesture(mode === 'on' ? 'Paint steps' : 'Erase steps'), mode, visited: new Set(), last: step, el };
    apply(step);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const cur = g.current;
    if (!cur) return;
    const step = stepAt(e.clientX, cur.el);
    if (step === cur.last) return;
    const dir = step > cur.last ? 1 : -1;
    for (let s = cur.last + dir; dir > 0 ? s <= step : s >= step; s += dir) apply(s);
    cur.last = step;
  };

  const finish = (): void => {
    const cur = g.current;
    if (!cur) return;
    g.current = null;
    const n = cur.visited.size;
    void cur.gesture.end().then(() => {
      setPending(new Map());
      if (n > 1) flashHint(`${cur.mode === 'on' ? 'Painted' : 'Erased'} ${n} steps (one undo)`, 'ok', 1400);
    });
  };

  const cells = [];
  for (let i = 0; i < steps; i++) {
    const info = on.get(i);
    const isOn = pending.has(i) ? pending.get(i)! : !!info;
    const shade = Math.floor(i / stepsPerBeat) % 2 === 1;
    cells.push(
      <StepButton key={i} on={isOn} accent={!!info && info.vel >= 0.95} vel={info?.vel ?? DEFAULT_VEL} color={color} shade={shade} width={CELL_W} height={ROW_H - 2} />,
    );
  }

  return (
    <div
      className="flex items-center touch-none cursor-pointer"
      style={{ width: steps * CELL_W }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      data-hint="Steps: click to set, drag to paint, right-click/drag to erase, Shift+click = accent. Each drag is one undo."
    >
      {cells}
    </div>
  );
});

export const MiniRoll = memo(function MiniRoll({
  channelId,
  notes,
  lengthTicks,
  width,
  color,
}: {
  channelId: string;
  notes: Record<string, Note> | undefined;
  lengthTicks: number;
  width: number;
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const h = ROW_H - 4;
    const ctx = setupCanvas(c, width, h);
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.beginPath();
    ctx.roundRect(0, 0, width, h, 4);
    ctx.fill();
    const list = notes ? Object.values(notes) : [];
    if (!list.length) return;
    let lo = 127;
    let hi = 0;
    for (const n of list) {
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
    }
    lo -= 1;
    hi += 1;
    const span = Math.max(6, hi - lo);
    const len = Math.max(lengthTicks, 1);
    ctx.fillStyle = color;
    for (const n of list) {
      const x = (n.tick / len) * width;
      const w = Math.max(2, (n.dur / len) * width - 1);
      const y = 2 + (1 - (n.key - lo) / span) * (h - 6);
      ctx.globalAlpha = 0.45 + 0.55 * n.vel;
      ctx.fillRect(x, y, w, 2.5);
    }
    ctx.globalAlpha = 1;
  }, [notes, lengthTicks, width, color]);
  return (
    <canvas
      ref={ref}
      className="block cursor-pointer rounded"
      style={{ width, height: ROW_H - 4 }}
      onClick={() => openInPianoRoll(channelId)}
      data-hint="Piano-roll notes (not steps). Click to edit them in the Piano Roll."
    />
  );
});
