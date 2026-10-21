import { useEffect, useState } from 'react';
import { onFrame } from '../render/frameLoop';
import { telemetry } from '../live/telemetry';
import { wm } from '../workspace/WindowManager';
import { cls } from '../utils/format';

type SyncLook = { on: boolean; bpm: number | null; running: boolean; locked: boolean };

export function syncLabel(s: SyncLook): { text: string; hint: string } {
  const bpm = s.bpm !== null ? s.bpm.toFixed(1) : '…';
  if (s.bpm === null) return { text: 'SYNC', hint: 'Following an external MIDI clock: waiting for it (start the clock on the other device)' };
  if (s.running) return { text: `SYNC ${bpm}`, hint: `Playing to the external MIDI clock at ${bpm} bpm${s.locked ? '' : ' (settling)'}. The project tempo is unchanged until the clock stops.` };
  return { text: `SYNC ${bpm}`, hint: `External MIDI clock at ${bpm} bpm: press Play (or Continue) on the other device to start` };
}

export function SyncBadge() {
  const [s, set] = useState<SyncLook>({ on: false, bpm: null, running: false, locked: false });
  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const f = telemetry.connected ? telemetry.frame : null;
      const y = f?.sync;
      const next: SyncLook = y ? { on: true, bpm: y.bpm === null ? null : Math.round(y.bpm * 10) / 10, running: y.running, locked: y.locked } : { on: false, bpm: null, running: false, locked: false };
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        set(next);
      }
    });
  }, []);
  if (!s.on) return null;
  const { text, hint } = syncLabel(s);
  return (
    <button
      type="button"
      onClick={() => wm.open('settings')}
      data-hint={hint}
      className={cls(
        'flex h-6 items-center rounded-md border px-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] tabular-nums transition',
        s.running ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
      )}
    >
      {text}
    </button>
  );
}
