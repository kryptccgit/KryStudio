// ──────────────────────────────────────────────────────────────────────
// Krypt Slicer UI (research/13-roadmap.md §8.5), in the channel's plugin
// window. Slice markers live on the generator (shared/schema/slicer.ts);
// every edit is a slicer.* doc command via dispatch(); failures toast.
//  - SlicerOverlay, drawn over the sample waveform: the slices as regions
//    numbered 1..N with their marker handles.
//      click a slice      → select it and hear it (its key on this channel)
//      drag a handle      → move the marker, clamped between its neighbours,
//                           committed once on release (one undo step)
//      double-click       → a new marker there
//      right-click handle → remove it
//  - SlicerSection: Auto-slice (the analyzer's hits, or a 1/4 / 1/8 / 1/16
//    grid at the loop's tempo), Pattern (replay the loop as sliced), Clear,
//    and the selected slice's pitch / reverse / gain.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Eraser, ListMusic, Loader2, Play, Trash2, WandSparkles } from 'lucide-react';
import { MIN_SLICE_GAP_SEC, SLICER_BASE_KEY, type Slice } from '@shared/schema/slicer';
import type { SliceToPadsOptions } from '@shared/types';
import { dispatch, useProject } from '../../doc/store';
import { toast } from '../../app/notify';
import { flashHint } from '../../app/hints';
import { Select, Toggle } from '../../controls/Toggle';
import { DragNumber } from '../../controls/DragNumber';
import { noteName } from '../../input/typingPiano';
import { cls } from '../../utils/format';
import type { WaveGeometry } from './Waveform';

interface SlicerView {
  /** Selected slice id (null = none). */
  sel: string | null;
  /** The sample's length as the waveform measured it (the pool may not know it). */
  dur: number | null;
  /** The loop's tempo from the last auto-slice (null = use the project tempo). */
  bpm: number | null;
  busy: boolean;
}

const EMPTY: SlicerView = { sel: null, dur: null, bpm: null, busy: false };

/** Per-channel view state shared by the overlay and the section (survives closing the window). */
const useSlicerView = create<Record<string, SlicerView>>(() => ({}));
const viewOf = (channelId: string): SlicerView => useSlicerView.getState()[channelId] ?? EMPTY;
const setView = (channelId: string, patch: Partial<SlicerView>) => useSlicerView.setState((s) => ({ [channelId]: { ...(s[channelId] ?? EMPTY), ...patch } }));

function useSlicer(channelId: string) {
  const slices = useProject((p) => p.channels[channelId]?.generator.slices);
  const baseKey = useProject((p) => Math.round(p.channels[channelId]?.generator.params.baseKey ?? SLICER_BASE_KEY));
  const view = useSlicerView((s) => s[channelId] ?? EMPTY);
  return { slices: slices ?? [], baseKey, view };
}

/** Hear slice `index` (0-based) on its key: a short audition, like tapping the key. */
function audition(channelId: string, key: number): void {
  window.krypt.engine.audition(channelId, key, 0.8, true);
  window.setTimeout(() => window.krypt.engine.audition(channelId, key, 0, false), 250);
}

// ── Overlay ───────────────────────────────────────────────────────────

export function SlicerOverlay({ channelId, geom }: { channelId: string; geom: WaveGeometry }) {
  const { slices, baseKey, view } = useSlicer(channelId);
  const [drag, setDrag] = useState<{ id: string; sec: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dur = geom.durationSec;
  useEffect(() => {
    if (dur && viewOf(channelId).dur !== dur) setView(channelId, { dur });
  }, [channelId, dur]);
  if (!dur) return null;
  const { width, height } = geom;
  const shown: Slice[] = drag ? slices.map((s) => (s.id === drag.id ? { ...s, sec: drag.sec } : s)) : slices;
  const regions = shown.length ? shown : [{ id: '', sec: 0 }];
  const xOf = (sec: number) => (sec / dur) * width;
  const secOfX = (clientX: number) => {
    const r = root.current?.getBoundingClientRect();
    return r ? (Math.max(0, Math.min(r.width, clientX - r.left)) / Math.max(1, r.width)) * dur : 0;
  };
  const clamp = (i: number, sec: number) => {
    const lo = i > 0 ? slices[i - 1].sec + MIN_SLICE_GAP_SEC : 0;
    const hi = i < slices.length - 1 ? slices[i + 1].sec - MIN_SLICE_GAP_SEC : dur - MIN_SLICE_GAP_SEC;
    return Math.max(lo, Math.min(hi, sec));
  };

  return (
    <div
      ref={root}
      className="absolute inset-0 select-none"
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-slice-handle]')) return;
        const sec = secOfX(e.clientX);
        void dispatch<{ sliceId: string; index: number }>('slicer.addSlice', { channelId, sec }).then((r) => {
          if (!r.ok || !r.data) return;
          setView(channelId, { sel: r.data.sliceId });
          flashHint(`Slice ${r.data.index + 1} on ${noteName(baseKey + r.data.index)}: drag its marker onto the hit`, 'ok');
        });
      }}
      data-hint="Click a slice to hear it · double-click to add a marker · drag a marker to move it · right-click a marker to remove it"
    >
      {regions.map((s, i) => {
        const x0 = xOf(s.sec);
        const x1 = xOf(regions[i + 1]?.sec ?? dur);
        const selected = !!s.id && view.sel === s.id;
        return (
          <div
            key={s.id || 'whole'}
            className={cls('absolute top-0 h-full cursor-pointer transition-colors', selected ? 'bg-krypt-purple/25' : i % 2 ? 'bg-white/[0.03] hover:bg-white/[0.08]' : 'hover:bg-white/[0.08]')}
            style={{ left: x0, width: Math.max(1, x1 - x0) }}
            onClick={() => {
              if (s.id) setView(channelId, { sel: s.id });
              audition(channelId, baseKey + i);
            }}
            data-hint={`Slice ${i + 1} · ${noteName(baseKey + i)}${s.reverse ? ' · reversed' : ''}${s.pitch ? ` · ${s.pitch > 0 ? '+' : ''}${s.pitch} st` : ''} · click to hear it`}
          >
            {x1 - x0 > 14 && (
              <span className={cls('pointer-events-none absolute bottom-0.5 left-1 font-mono text-[8px]', selected ? 'text-white' : 'text-white/45')}>
                {i + 1}
                {s.reverse ? '◂' : ''}
              </span>
            )}
          </div>
        );
      })}
      {shown.map((s, i) => {
        const active = drag?.id === s.id;
        return (
          <div
            key={s.id}
            data-slice-handle
            className="group absolute top-0 h-full w-[11px] -translate-x-1/2 cursor-ew-resize"
            style={{ left: xOf(s.sec) }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ id: s.id, sec: s.sec });
              setView(channelId, { sel: s.id });
            }}
            onPointerMove={(e) => drag?.id === s.id && setDrag({ id: s.id, sec: clamp(i, secOfX(e.clientX)) })}
            onPointerUp={() => {
              if (drag?.id !== s.id) return;
              const sec = drag.sec;
              setDrag(null);
              if (Math.abs(sec - slices[i].sec) < 1e-6) return;
              void dispatch('slicer.moveSlice', { channelId, sliceId: s.id, sec });
            }}
            onPointerCancel={() => setDrag(null)}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void dispatch('slicer.removeSlice', { channelId, sliceId: s.id }).then((r) => r.ok && flashHint(`Slice ${i + 1} marker removed`, 'ok'));
            }}
            data-hint={`Slice ${i + 1} marker at ${s.sec.toFixed(3)} s · drag to move · right-click removes`}
          >
            <div className={cls('absolute left-1/2 top-0 h-full w-px -translate-x-1/2', active ? 'bg-white' : 'bg-krypt-pink/90 group-hover:bg-white')} />
            <div className={cls('absolute left-1/2 top-0 h-[6px] w-[7px] -translate-x-1/2 rounded-b-sm', active ? 'bg-white' : 'bg-krypt-pink group-hover:bg-white')} />
          </div>
        );
      })}
      {!slices.length && width > 160 && (
        <div className="pointer-events-none absolute right-1.5 top-1 text-[9px] text-white/50" style={{ maxWidth: height * 4 }}>
          One slice: auto-slice below, or double-click to add markers
        </div>
      )}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────

type SliceMode = 'onsets' | 'grid1' | 'grid8' | 'grid16';
const SLICE_MODES: Array<{ value: SliceMode; label: string; detail: string }> = [
  { value: 'onsets', label: 'At hits', detail: 'The analyzer finds the drum hits' },
  { value: 'grid1', label: 'Every 1/4', detail: 'One slice per beat' },
  { value: 'grid8', label: 'Every 1/8', detail: 'Two slices per beat' },
  { value: 'grid16', label: 'Every 1/16', detail: 'Four slices per beat' },
];
const DIVISION: Record<Exclude<SliceMode, 'onsets'>, number> = { grid1: 1, grid8: 0.5, grid16: 0.25 };

async function autoSlice(channelId: string, mode: SliceMode, maxSlices: number): Promise<void> {
  if (viewOf(channelId).busy) return;
  setView(channelId, { busy: true });
  const opts: SliceToPadsOptions = { to: 'slicer', channelId, pattern: false, maxSlices, ...(mode === 'onsets' ? { mode: 'onsets' } : { mode: 'grid', division: DIVISION[mode] }) };
  try {
    const r = await window.krypt.racks.sliceToPads({ channelId }, opts);
    if (r.ok) {
      setView(channelId, { sel: null, bpm: r.data?.bpm ?? null, ...(r.data?.lengthSec ? { dur: r.data.lengthSec } : {}) });
      toast.success(r.message ?? 'Sliced');
    } else toast.error(r.message ?? "Couldn't slice this sample");
  } catch (err) {
    toast.error(`Couldn't slice this sample: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    setView(channelId, { busy: false });
  }
}

const btn = 'flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/85 hover:border-white/20 disabled:opacity-40';

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">{label}</div>
      {children}
    </div>
  );
}

/** A number edited locally while dragging, committed once on release. */
function LiveNumber({ label, value, min, max, step, format, hint, onCommit }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; hint: string; onCommit: (v: number) => void }) {
  const [live, setLive] = useState<number | null>(null);
  return (
    <Labelled label={label}>
      <DragNumber
        value={live ?? value}
        min={min}
        max={max}
        step={step}
        pxPerStep={3}
        label={label}
        hint={hint}
        format={format}
        className="h-6 w-[64px] text-[12px] font-semibold"
        onChange={(v) => setLive(v)}
        onEnd={() => {
          if (live !== null && live !== value) onCommit(live);
          setLive(null);
        }}
      />
    </Labelled>
  );
}

export function SlicerSection({ channelId }: { channelId: string }) {
  const { slices, baseKey, view } = useSlicer(channelId);
  const name = useProject((p) => p.channels[channelId]?.name ?? '');
  const [mode, setMode] = useState<SliceMode>('onsets');
  const [max, setMax] = useState(16);
  const selIndex = slices.findIndex((s) => s.id === view.sel);
  const sel = selIndex >= 0 ? slices[selIndex] : null;
  const count = Math.max(1, slices.length);
  const setSlice = (patch: { pitch?: number; reverse?: boolean; gain?: number }) => sel && void dispatch('slicer.setSlice', { channelId, sliceId: sel.id, ...patch });

  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5" data-guide="slicer.section">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Slices</h3>
        <span className="font-mono text-[9px] text-krypt-muted">
          {count} slice{count === 1 ? '' : 's'} · {noteName(baseKey)}
          {count > 1 ? `–${noteName(baseKey + count - 1)}` : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select<SliceMode> value={mode} options={SLICE_MODES} onChange={setMode} hint="Where to cut" width={100} />
        <Select<number> value={max} options={[8, 16, 32, 64].map((n) => ({ value: n, label: `${n} max` }))} onChange={setMax} hint="Most slices (at hits: the strongest)" width={70} />
        <button type="button" className={btn} disabled={view.busy} onClick={() => void autoSlice(channelId, mode, max)} data-hint="Replace the markers with new ones (undoable)">
          {view.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <WandSparkles className="h-3 w-3" />} Auto-slice
        </button>
        <button
          type="button"
          className={btn}
          onClick={() =>
            void dispatch<{ patternId: string }>('slicer.makePattern', { channelId, bpm: view.bpm ?? undefined, lengthSec: view.dur ?? undefined }).then(
              (r) => r.ok && flashHint(`Added a pattern replaying "${name}"${view.bpm ? ` at ${view.bpm} BPM` : ''}: rearrange its notes to flip the loop`, 'ok'),
            )
          }
          data-hint="Add a pattern that replays the loop as sliced, one note per slice (at the loop's detected tempo after an auto-slice)"
        >
          <ListMusic className="h-3 w-3" /> Pattern
        </button>
        <button
          type="button"
          className={btn}
          disabled={!slices.length}
          onClick={() => void dispatch('slicer.clear', { channelId }).then((r) => r.ok && (setView(channelId, { sel: null }), flashHint('Markers cleared: the whole sample is one slice', 'ok')))}
          data-hint="Remove every marker (undoable)"
        >
          <Eraser className="h-3 w-3" /> Clear
        </button>
      </div>

      {sel ? (
        <div className="mt-2.5 flex flex-wrap items-end gap-x-3 gap-y-2 border-t border-white/[0.06] pt-2.5">
          <div className="flex flex-col gap-0.5 pb-0.5">
            <span className="text-[11px] font-semibold text-white/90">
              Slice {selIndex + 1} · {noteName(baseKey + selIndex)}
            </span>
            <span className="font-mono text-[9px] text-krypt-muted">at {sel.sec.toFixed(3)} s</span>
          </div>
          <LiveNumber label="Pitch" value={sel.pitch ?? 0} min={-24} max={24} step={1} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)} st`} hint="Slice pitch in semitones (drag; double-click resets)" onCommit={(v) => setSlice({ pitch: Math.round(v) })} />
          <LiveNumber label="Gain" value={sel.gain ?? 1} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} hint="Slice level (100% = as recorded)" onCommit={(v) => setSlice({ gain: v })} />
          <Labelled label="Reverse">
            <Toggle variant="button" on={!!sel.reverse} onChange={(reverse) => setSlice({ reverse })} hint="Play this slice backwards" className="w-12 justify-center">
              {sel.reverse ? 'On' : 'Off'}
            </Toggle>
          </Labelled>
          <button type="button" className={btn} onClick={() => audition(channelId, baseKey + selIndex)} data-hint="Hear this slice">
            <Play className="h-3 w-3" /> Play
          </button>
          <button
            type="button"
            className={cls(btn, 'hover:text-rose-300')}
            onClick={() => void dispatch('slicer.removeSlice', { channelId, sliceId: sel.id }).then((r) => r.ok && (setView(channelId, { sel: null }), flashHint(`Slice ${selIndex + 1} marker removed`, 'ok')))}
            data-hint="Remove this marker: the slice before it plays on to the next one"
          >
            <Trash2 className="h-3 w-3" /> Remove
          </button>
        </div>
      ) : (
        <div className="mt-2 text-[10px] text-krypt-muted/80">
          Slice N plays on {noteName(baseKey)} + N − 1 at its recorded pitch, so the loop follows any tempo. Click a slice on the waveform to hear and edit it.
        </div>
      )}
    </section>
  );
}
