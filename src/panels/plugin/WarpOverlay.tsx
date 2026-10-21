// ──────────────────────────────────────────────────────────────────────
// Warp UI for the Audio Clip (Wave 12.2, research/16 §2.2), in the channel's
// plugin window:
//  - WarpOverlay, drawn over the sample waveform: the beat grid the clip
//    plays with (bars brighter, from the warp map, else the Stretch params)
//    and the warp markers as handles labelled bar.beat.
//      drag a handle      → the marker's SOURCE time moves, its beat stays:
//                           you slide the audio under a fixed grid line
//                           (re-pin which hit lands on that beat). The drag
//                           is clamped between the neighbours and commits
//                           once, on release (one undo step).
//      double-click       → a marker on the nearest 16th of the current grid
//                           (timing unchanged until you drag it); Alt = no snap
//      right-click handle → remove it
//  - WarpSection: mode picker (Off / complex / tones / beats / texture /
//    re-pitch), the mode's options, Auto-warp (bars or beats, progress from
//    the analyzer job, a toast with the result) and Clear.
// Every edit is a doc command via dispatch(); failures toast.
// ──────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Eraser, Loader2, WandSparkles } from 'lucide-react';
import { CATALOG } from '@shared/plugins/catalog';
import { audioTickBpm } from '@shared/analyzer/tempo';
import { PPQ, ticksPerBar } from '@shared/schema/time';
import { WARP_MODES, type WarpMarker, type WarpMode } from '@shared/schema/warp';
import { dispatch, getProject, useProject } from '../../doc/store';
import { toast } from '../../app/notify';
import { flashHint } from '../../app/hints';
import { Select } from '../../controls/Toggle';
import { DragNumber } from '../../controls/DragNumber';
import { ProgressBar } from '../../ears/ProgressBar';
import { useAnalyzer } from '../modelManager/store';
import { cls } from '../../utils/format';
import type { WaveGeometry } from './Waveform';
import { beatLabel, clampDragSec, gridLines, snapBeat, warpMapping } from './warpView';

const MODE_LABEL: Record<WarpMode, string> = {
  complex: 'Complex',
  tones: 'Tones',
  beats: 'Beats',
  texture: 'Texture',
  repitch: 'Re-pitch',
};
const MODE_DETAIL: Record<WarpMode, string> = {
  complex: 'Full mixes',
  tones: 'Vocals, bass, leads',
  beats: 'Drums: slices keep their punch',
  texture: 'Pads, noise, ambience',
  repitch: 'Varispeed: pitch follows speed',
};

function useWarp(channelId: string) {
  return useProject((p) => p.channels[channelId]?.generator.warp);
}

/** The mapping + bar length the channel plays with now. */
function useMapping(channelId: string, markers: WarpMarker[]) {
  const ch = useProject((p) => p.channels[channelId]);
  const bpm = useProject((p) => p.transport.bpm);
  const ts = useProject((p) => p.transport.timeSig);
  return useMemo(() => {
    const tick = audioTickBpm(getProject(), CATALOG, ch).bpm;
    return { map: warpMapping(markers, tick), barQ: ticksPerBar(ts) / PPQ };
    // bpm: the tick tempo of an unsynced clip follows the project tempo
  }, [ch, bpm, ts, markers]);
}

// ── Overlay ───────────────────────────────────────────────────────────

/** Minimum spacing between two marker labels (a "12.1" label is ~22 px wide). */
const LABEL_GAP_PX = 26;

export function WarpOverlay({ channelId, geom }: { channelId: string; geom: WaveGeometry }) {
  const warp = useWarp(channelId);
  const sampleDur = useProject((p) => {
    const s = p.samples[p.channels[channelId]?.generator.sampleId ?? ''];
    return s?.frames && s.sampleRate ? s.frames / s.sampleRate : null;
  });
  const dur = geom.durationSec ?? sampleDur;
  const [drag, setDrag] = useState<{ id: string; sec: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const stored = warp?.markers;
  const markers = useMemo(() => {
    const ms = stored ?? [];
    return drag ? ms.map((m) => (m.id === drag.id ? { ...m, sec: drag.sec } : m)) : ms;
  }, [stored, drag]);
  const { map, barQ } = useMapping(channelId, markers);
  const lines = useMemo(() => (dur ? gridLines(map, dur, geom.width, barQ) : []), [map, dur, geom.width, barQ]);
  if (!dur) return null;
  const { width, height } = geom;
  const xOf = (sec: number) => (sec / dur) * width;
  const secOfX = (clientX: number) => {
    const r = root.current?.getBoundingClientRect();
    return r ? (Math.max(0, Math.min(r.width, clientX - r.left)) / Math.max(1, r.width)) * dur : 0;
  };

  const add = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-warp-handle]')) return;
    let sec = secOfX(e.clientX);
    let beat = map.beatAt(sec);
    if (!e.altKey) {
      beat = snapBeat(beat);
      sec = map.secAt(beat);
    }
    if (!(sec >= 0 && sec < dur) || !(beat >= 0)) {
      toast.warn('That spot is outside the audio (or before beat 1): double-click inside the waveform, or hold Alt to place a marker without snapping.');
      return;
    }
    void dispatch('audio.addWarpMarker', { channelId, sec, beat }).then(
      (r) => r.ok && flashHint(`Warp marker on ${beatLabel(beat, barQ)}: drag it onto the hit that belongs there`, 'ok'),
    );
  };

  let lastLabelX = -Infinity; // label thinning, see the marker loop
  return (
    <div
      ref={root}
      className="absolute inset-0 select-none"
      onDoubleClick={add}
      data-guide="warp.markers"
      data-hint="Double-click to add a warp marker (Alt: no snap) · drag a marker to move the audio under it · right-click removes"
    >
      <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
        {lines.map((l) => (
          <g key={l.beat}>
            <line x1={l.x} x2={l.x} y1={l.bar ? 0 : height * 0.7} y2={height} stroke={l.bar ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)'} strokeWidth={1} />
            {l.bar && width / Math.max(1, lines.filter((x) => x.bar).length) > 18 && (
              <text x={l.x + 2} y={height - 3} fontSize={8} fill="rgba(255,255,255,0.45)" fontFamily="Chakra Petch, sans-serif">
                {Math.round(l.beat / barQ) + 1}
              </text>
            )}
          </g>
        ))}
      </svg>
      {markers.map((m, i) => {
        const x = xOf(m.sec);
        const active = drag?.id === m.id;
        // Dense maps (a marker every bar on a long file): label a marker only when there is room since the last
        // label; the others show theirs on hover.
        const showLabel = active || i === 0 || x - lastLabelX >= LABEL_GAP_PX;
        if (showLabel) lastLabelX = x;
        return (
          <div
            key={m.id}
            data-warp-handle
            className="group absolute top-0 h-full w-[11px] -translate-x-1/2 cursor-ew-resize"
            style={{ left: x }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ id: m.id, sec: m.sec });
            }}
            onPointerMove={(e) => {
              if (drag?.id !== m.id) return;
              setDrag({ id: m.id, sec: clampDragSec(stored ?? [], i, secOfX(e.clientX), dur) });
            }}
            onPointerUp={() => {
              if (drag?.id !== m.id) return;
              const sec = drag.sec;
              setDrag(null);
              if (Math.abs(sec - m.sec) < 1e-6) return;
              void dispatch('audio.moveWarpMarker', { channelId, markerId: m.id, sec });
            }}
            onPointerCancel={() => setDrag(null)}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void dispatch('audio.removeWarpMarker', { channelId, markerId: m.id }).then((r) => r.ok && flashHint(`Warp marker on ${beatLabel(m.beat, barQ)} removed`, 'ok'));
            }}
            data-hint={`Warp marker: ${beatLabel(m.beat, barQ)} ← ${m.sec.toFixed(3)} s · drag to move the audio under it · right-click removes`}
          >
            <div className={cls('absolute left-1/2 top-0 h-full w-px -translate-x-1/2', active ? 'bg-white' : 'bg-krypt-pink/90 group-hover:bg-white')} />
            <div
              className={cls(
                'absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap rounded-b px-1 font-mono text-[8px] leading-[11px]',
                active ? 'bg-white text-black' : 'bg-krypt-pink/90 text-white group-hover:bg-white group-hover:text-black',
                !showLabel && 'hidden group-hover:block',
              )}
            >
              {active ? `${beatLabel(m.beat, barQ)} · ${drag!.sec.toFixed(3)}s` : beatLabel(m.beat, barQ)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────

/** Auto-warp in flight per channel (survives closing the window). */
const useAutoWarpBusy = create<Record<string, true>>(() => ({}));

async function runAutoWarp(channelId: string, every: 'bar' | 'beat'): Promise<void> {
  if (useAutoWarpBusy.getState()[channelId]) return;
  useAutoWarpBusy.setState({ [channelId]: true });
  try {
    const r = await window.krypt.warp.autoWarp(channelId, { every });
    if (r.ok) {
      toast.success(r.message ?? 'Warped to the grid');
      if (r.data?.warning) toast.warn(r.data.warning);
    } else toast.error(r.message ?? "Couldn't auto-warp this clip");
  } catch (err) {
    toast.error(`Couldn't auto-warp this clip: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    useAutoWarpBusy.setState((s) => {
      const n = { ...s };
      delete n[channelId];
      return n;
    }, true);
  }
}

function Labelled({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1" data-hint={hint}>
      <div className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">{label}</div>
      {children}
    </div>
  );
}

/** A number option edited locally while dragging, committed once. */
function OptionNumber({ label, value, min, max, step, format, onCommit, hint }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onCommit: (v: number) => void; hint: string }) {
  const [live, setLive] = useState<number | null>(null);
  return (
    <Labelled label={label} hint={hint}>
      <DragNumber
        value={live ?? value}
        min={min}
        max={max}
        step={step}
        pxPerStep={2}
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

function AnalyzeProgress({ name }: { name: string }) {
  const jobs = useAnalyzer((s) => s.state?.jobs);
  const job = useMemo(() => {
    const list = (jobs ?? []).filter((j) => j.kind === 'analyze').sort((a, b) => b.startedAt - a.startedAt);
    return list.find((j) => j.label.includes(name)) ?? list[0] ?? null;
  }, [jobs, name]);
  return (
    <div className="mt-2 flex items-center gap-2 text-[10px] text-krypt-muted">
      <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-krypt-purple" />
      <span className="flex-shrink-0">{job ? `Finding the beats · ${job.stage}${job.fraction >= 0 ? ` ${Math.round(job.fraction * 100)}%` : ''}` : 'Finding the beats…'}</span>
      <ProgressBar fraction={job?.fraction ?? -1} className="flex-1" />
    </div>
  );
}

export function WarpSection({ channelId }: { channelId: string }) {
  const warp = useWarp(channelId);
  const name = useProject((p) => p.channels[channelId]?.name ?? '');
  const busy = useAutoWarpBusy((s) => !!s[channelId]);
  const [every, setEvery] = useState<'bar' | 'beat'>('bar');
  const n = warp?.markers.length ?? 0;
  const setOptions = (o: Record<string, unknown>) => void dispatch('audio.setWarpOptions', { channelId, ...o });

  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Warp</h3>
        <div className="flex items-center gap-1">
          <Select<'bar' | 'beat'>
            value={every}
            options={[
              { value: 'bar', label: 'Every bar' },
              { value: 'beat', label: 'Every beat' },
            ]}
            onChange={setEvery}
            hint="Auto-warp: one marker per bar (steady loops) or per beat (live playing that drifts)"
            width={92}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAutoWarp(channelId, every)}
            className="flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] font-semibold text-white/85 hover:border-white/20 disabled:opacity-60"
            data-guide="warp.auto"
            data-hint="Find the beats and pin them to the grid (replaces the markers; one undo step)"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <WandSparkles className="h-3 w-3" />} Auto-warp
          </button>
          <button
            type="button"
            disabled={!n}
            onClick={() => void dispatch<{ removed: number }>('audio.clearWarp', { channelId }).then((r) => r.ok && flashHint(`Removed ${r.data?.removed ?? n} warp markers`, 'ok'))}
            className="flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] font-semibold text-white/85 hover:border-white/20 disabled:opacity-40"
            data-hint="Remove every warp marker (the mode stays; undoable)"
          >
            <Eraser className="h-3 w-3" /> Clear
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
        <div data-guide="warp.mode">
          <Labelled label="Mode">
            <Select<WarpMode | 'off'>
              value={warp?.mode ?? 'off'}
              options={[{ value: 'off' as const, label: 'Off', detail: 'Stretch settings only' }, ...WARP_MODES.map((m) => ({ value: m, label: MODE_LABEL[m], detail: MODE_DETAIL[m] }))]}
              onChange={(m) => {
                if (m === 'off') void dispatch('audio.clearWarp', { channelId, all: true }).then((r) => r.ok && flashHint('Warp off: the clip plays with its Stretch settings', 'ok'));
                else void dispatch('audio.setWarpMode', { channelId, mode: m }).then((r) => r.ok && flashHint(`Warp mode: ${MODE_LABEL[m]} (${MODE_DETAIL[m].toLowerCase()})`, 'ok'));
              }}
              hint="How the audio is stretched between markers"
              width={104}
            />
          </Labelled>
        </div>
        {warp?.mode === 'beats' && (
          <>
            <Labelled label="Slices" hint="Where the audio is cut into slices">
              <Select<'transients' | '1/16' | '1/8' | '1/4'>
                value={warp.beatsSlice ?? 'transients'}
                options={[
                  { value: 'transients', label: 'Transients' },
                  { value: '1/16', label: '1/16' },
                  { value: '1/8', label: '1/8' },
                  { value: '1/4', label: '1/4' },
                ]}
                onChange={(v) => setOptions({ beatsSlice: v })}
                hint="Slice at the hits, or at a fixed grid"
                width={92}
              />
            </Labelled>
            <OptionNumber label="Fade" value={warp.beatsFadeMs ?? 20} min={0} max={200} step={1} format={(v) => `${Math.round(v)} ms`} onCommit={(v) => setOptions({ beatsFadeMs: Math.round(v) })} hint="Fade at the end of each slice" />
          </>
        )}
        {warp?.mode === 'texture' && (
          <>
            <OptionNumber label="Grain" value={warp.grainMs ?? 80} min={10} max={500} step={1} format={(v) => `${Math.round(v)} ms`} onCommit={(v) => setOptions({ grainMs: Math.round(v) })} hint="Grain size" />
            <OptionNumber label="Flux" value={warp.flux ?? 0.2} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => setOptions({ flux: v })} hint="Random grain position" />
          </>
        )}
        <div className="min-w-[160px] flex-1 self-center text-[10px] leading-snug text-krypt-muted">
          {n >= 2
            ? `${n} markers set the timing (they override Follow tempo and Stretch). Drag one to move the audio under it.`
            : n === 1
              ? '1 marker: add another (double-click the waveform on a beat) or Auto-warp to warp.'
              : 'No markers: double-click the waveform on a beat, or Auto-warp.'}
        </div>
      </div>
      {busy && <AnalyzeProgress name={name} />}
    </section>
  );
}
