// Custom steps editor for Krypt Gate/Time slots (shared/plugins/gateSteps.ts):
// per step a time mode chip (click = next mode, right-click = previous,
// Alt+click = Play) and a level bar (drag across bars to paint levels), plus
// step length, step count and the factory step presets. Every edit switches
// the slot to the "Custom steps" pattern in the same command.

import { useEffect, useRef } from 'react';
import { Footprints } from 'lucide-react';
import { PPQ } from '@shared/schema/time';
import {
  GATE_CUSTOM_PATTERN,
  GATE_MAX_STEPS,
  GATE_STEP_CODES,
  GATE_STEP_DIVS,
  GATE_STEP_MODES,
  GATE_STEP_PRESETS,
  gateStepParams,
  gateStepPresetParams,
  printGateSteps,
  readGateSteps,
  type GateSteps as Steps,
} from '@shared/plugins/gateSteps';
import { dispatch, useProject } from '../../doc/store';
import { Select } from '../../controls/Toggle';
import { flashHint } from '../../app/hints';
import { onFrame } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { cls } from '../../utils/format';

/** Step length of each GATE_STEP_DIVS entry, in beats. */
const DIV_BEATS = [0.125, 0.25, 0.5, 1];
const BAR_H = 54;

/** Chip colours per mode (Play is neutral; the rest use the accent family). */
const MODE_TONE = [
  'bg-white/[0.05] text-white/60',
  'bg-krypt-indigo/35 text-white',
  'bg-krypt-indigo/50 text-white',
  'bg-krypt-indigo/70 text-white',
  'bg-krypt-purple/40 text-white',
  'bg-krypt-purple/60 text-white',
  'bg-krypt-pink/45 text-white',
  'bg-krypt-pink/65 text-white',
  'bg-amber-500/45 text-white',
];

let dragSeq = 0;

export function GateSteps({ insertId, slotId }: { insertId: string; slotId: string }) {
  const params = useProject((p) => p.mixer.inserts[insertId]?.slots[slotId]?.params);
  const steps = readGateSteps(params ?? {});
  const custom = Math.round(params?.pattern ?? 0) === GATE_CUSTOM_PATTERN;
  const always = Math.round(params?.trigger ?? 0) === 0;
  const cells = useRef<Array<HTMLDivElement | null>>([]);
  const bars = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; levels: number[] } | null>(null);

  const write = (next: Steps, key?: string) =>
    dispatch('mixer.setSlotParams', { insertId, slotId, params: gateStepParams(next) }, key ? { coalesceKey: key, label: 'Paint step levels' } : { label: 'Edit gate steps' });

  const setMode = (i: number, dir: 1 | -1 | 0) => {
    const n = GATE_STEP_MODES.length;
    const mode = dir === 0 ? 0 : (steps.steps[i].mode + dir + n) % n;
    const next = { ...steps, steps: steps.steps.map((s, k) => (k === i ? { ...s, mode } : s)) };
    void write(next).then((r) => r.ok && !custom && flashHint('Gate/Time switched to Custom steps', 'ok'));
  };

  // Paint levels: one undo entry per drag.
  const paint = (e: React.PointerEvent) => {
    const el = bars.current;
    const d = drag.current;
    if (!el || !d) return;
    const r = el.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * steps.steps.length);
    if (i < 0 || i >= steps.steps.length) return;
    const level = Math.round(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) * 20) / 20;
    if (d.levels[i] === level) return;
    d.levels[i] = level;
    void write({ ...steps, steps: steps.steps.map((s, k) => ({ ...s, level: d.levels[k] })) }, d.key);
  };

  // Playhead: light the step under the transport (Trigger Always only; Active param restarts are engine-side).
  useEffect(() => {
    if (!custom || !always) return;
    let lastIdx = -2;
    return onFrame(() => {
      const len = DIV_BEATS[steps.div] ?? 0.25;
      const idx = telemetry.playing ? Math.floor(((telemetry.playheadTick() / PPQ) % (len * steps.steps.length)) / len) : -1;
      if (idx === lastIdx) return;
      lastIdx = idx;
      cells.current.forEach((c, k) => c?.classList.toggle('ring-1', k === idx));
    });
  }, [custom, always, steps.div, steps.steps.length]);

  if (!params) return null;
  const count = steps.steps.length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select<string>
          value=""
          options={[{ value: '', label: 'Load steps…' }, ...GATE_STEP_PRESETS.map((p) => ({ value: p.id, label: p.name, detail: p.description }))]}
          onChange={(id) => {
            const p = GATE_STEP_PRESETS.find((x) => x.id === id);
            if (p) void dispatch('mixer.setSlotParams', { insertId, slotId, params: gateStepPresetParams(p) }, { label: `Gate steps: ${p.name}` }).then((r) => r.ok && flashHint(`Gate/Time: ${p.name}`, 'ok'));
          }}
          hint="Load a step pattern (switches to Custom steps; undoable)"
          width={128}
        />
        <Select<number>
          value={steps.div}
          options={GATE_STEP_DIVS.map((d, i) => ({ value: i, label: `${d} steps` }))}
          onChange={(div) => void write({ ...steps, div })}
          hint="Length of one step"
          width={84}
        />
        <Select<number>
          value={count}
          options={Array.from({ length: GATE_MAX_STEPS }, (_, i) => ({ value: i + 1, label: `${i + 1} step${i ? 's' : ''}` }))}
          onChange={(n) =>
            void write({ ...steps, steps: Array.from({ length: n }, (_, i) => steps.steps[i] ?? { mode: 0, level: 1 }) })
          }
          hint="How many steps before the pattern repeats"
          width={78}
        />
        {!custom && (
          <button
            type="button"
            onClick={() => void write(steps).then((r) => r.ok && flashHint('Gate/Time now plays the custom steps', 'ok'))}
            className="flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/85 hover:border-white/20"
            data-hint="Play these steps instead of the built-in pattern"
          >
            <Footprints className="h-3 w-3" /> Use steps
          </button>
        )}
      </div>

      <div className={cls('space-y-1', !custom && 'opacity-50')}>
        <div
          ref={bars}
          className="grid cursor-ns-resize touch-none gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, height: BAR_H }}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { key: `gate-steps:${insertId}/${slotId}:${++dragSeq}`, levels: steps.steps.map((s) => s.level) };
            paint(e);
          }}
          onPointerMove={(e) => drag.current && paint(e)}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          data-hint="Step levels: drag up and down, or across several steps to paint (one undo per drag)"
        >
          {steps.steps.map((s, i) => (
            <div key={i} className={cls('relative overflow-hidden rounded-sm bg-black/40', i % 4 === 0 && 'border-l border-white/20')}>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-krypt-indigo via-krypt-purple to-krypt-pink opacity-80" style={{ height: `${s.level * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
          {steps.steps.map((s, i) => (
            <div
              key={i}
              ref={(el) => {
                cells.current[i] = el;
              }}
              role="button"
              tabIndex={0}
              onClick={(e) => setMode(i, e.altKey ? 0 : 1)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMode(i, -1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setMode(i, 1);
                }
              }}
              className={cls('flex h-6 select-none items-center justify-center rounded-sm font-mono text-[9px] font-semibold ring-white/80', MODE_TONE[s.mode])}
              data-hint={`Step ${i + 1}: ${GATE_STEP_MODES[s.mode]} at ${Math.round(s.level * 100)}%. Click: next mode · right-click: previous · Alt+click: Play`}
            >
              {GATE_STEP_CODES[s.mode]}
            </div>
          ))}
        </div>
        <div className="truncate font-mono text-[9px] text-krypt-muted" data-hint="The same steps as text (what agents write)">
          {printGateSteps(steps)}
        </div>
      </div>
    </div>
  );
}
