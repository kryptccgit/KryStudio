// The result views' own transport (Auto Mix / Master a song / Master an album): the dialog's backdrop covers the
// app's transport bar and its shortcuts, so the A/B needs a Play / Pause, a position readout and a seek bar right
// next to it. `range` limits it to one song of an album (play from its start, pause at its end); without it the
// whole song plays. While mounted, Space toggles playback (it never presses the focused Keep button); while the
// reference plays (the engine's preview voice), Play / Space stops the reference first.

import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { ticksToSeconds } from '@shared/schema/time';
import { onFrame } from '../render/frameLoop';
import { locateSim, playState, transport } from '../live/playState';
import { getProject, useDocStore } from '../doc/store';
import { toast } from '../app/notify';
import { cls } from '../utils/format';
import { failureMessage } from './logic';

/** "3:07". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function songEnd(): number {
  try {
    const clips = Object.values(getProject().playlist.clips);
    return clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
  } catch {
    return 0;
  }
}

async function locate(tick: number): Promise<boolean> {
  try {
    const r = await window.krypt.engine.locate(Math.max(0, Math.round(tick)));
    locateSim(tick);
    if (!r.ok) toast.error(`Couldn't move the playhead: ${r.message ?? 'the engine refused'}`);
    return r.ok;
  } catch (err) {
    toast.error(`Couldn't move the playhead: ${failureMessage(err)}`);
    return false;
  }
}

export interface ResultTransportProps {
  /** One song of an album (song ticks); null = the whole song. */
  range: { start: number; end: number; name?: string } | null;
  refPlaying: boolean;
  onStopReference(): void | Promise<void>;
}

export function ResultTransport({ range, refPlaying, onStopReference }: ResultTransportProps) {
  const bpm = useDocStore((s) => s.project?.transport.bpm ?? 120);
  const [playing, setPlaying] = useState(() => playState.playing());
  const [tick, setTick] = useState(() => playState.tick());
  const start = range?.start ?? 0;
  const end = Math.max(start + 1, range?.end ?? songEnd());

  // Poll the playhead ~10× a second (telemetry is non-React; never re-render at 60 Hz).
  useEffect(() => {
    let last = 0;
    let stopping = false;
    return onFrame(() => {
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      const p = playState.playing();
      const t = playState.tick();
      setPlaying(p);
      setTick(t);
      // An album song pauses at its own end (not into the next song).
      if (range && p && t > range.end + 1 && !stopping) {
        stopping = true;
        void transport('pause').finally(() => (stopping = false));
      }
    });
  }, [range]);

  const toggle = async (): Promise<void> => {
    if (refPlaying) {
      await onStopReference(); // Play / Space while the reference plays = stop it
      return;
    }
    if (playState.playing()) {
      const r = await transport('pause');
      if (!r.ok) toast.error(`Couldn't pause: ${r.message ?? 'the engine refused'}`);
      return;
    }
    const t = playState.tick();
    if (t < start || t >= end - 1) await locate(start);
    const r = await transport('play');
    if (!r.ok) toast.error(`Couldn't play: ${r.message ?? 'the engine refused'}. Switch to this project's tab if another one is open.`);
  };

  // Space toggles playback while the result is on screen (and never "presses" the focused button).
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
      return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type);
    };
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void toggle();
    };
    const up = (e: KeyboardEvent): void => {
      if ((e.code === 'Space' || e.key === ' ') && !typing(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    return () => {
      document.removeEventListener('keydown', down, true);
      document.removeEventListener('keyup', up, true);
    };
  });

  const pos = Math.max(start, Math.min(end, tick));
  const at = ticksToSeconds(pos - start, bpm);
  const total = ticksToSeconds(end - start, bpm);
  const on = playing || refPlaying;
  return (
    <div className="flex items-center gap-2.5" data-guide="automix.transport">
      <button
        type="button"
        onClick={() => void toggle()}
        className={cls(
          'inline-flex h-7 w-[74px] flex-shrink-0 items-center justify-center gap-1 rounded-md text-[11.5px] font-semibold transition',
          on ? 'bg-krypt-purple/25 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.6)]' : 'border border-white/10 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white',
        )}
        title={refPlaying ? 'Stop the reference (Space)' : playing ? 'Pause (Space)' : `Play${range?.name ? ` "${range.name}"` : ''} (Space)`}
      >
        {on ? <Pause size={12} /> : <Play size={12} />}
        {on ? (refPlaying ? 'Stop' : 'Pause') : 'Play'}
      </button>
      <input
        type="range"
        min={start}
        max={end}
        step={Math.max(1, Math.round((end - start) / 400))}
        value={pos}
        onChange={(e) => void locate(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-krypt-purple"
        aria-label="Position"
        disabled={refPlaying}
      />
      <span className="w-[78px] flex-shrink-0 text-right font-mono text-[10.5px] text-krypt-muted">
        {fmtClock(at)} / {fmtClock(total)}
      </span>
    </div>
  );
}
