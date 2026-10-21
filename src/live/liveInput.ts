// ──────────────────────────────────────────────────────────────────────
// Renderer side of live input (MIDI + recording). Installed once at boot:
//   - follows the selected channel → window.krypt.midi.setTarget (the
//     engine plays incoming MIDI on it, research/06 §6.3),
//   - mirrors main's record state, MIDI input list and MIDI-learn state into
//     a small zustand store (low-rate; live LEDs read telemetry instead),
//   - toasts each finished take once.
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { MidiInputInfo } from '@shared/engine/protocol';
import type { MidiLearnState, RecordState } from '@shared/types';
import { effectiveChannelId, useUi } from '../state/ui';
import { useDocStore } from '../doc/store';
import { report, toast } from '../app/notify';

interface LiveInputState {
  record: RecordState;
  midiInputs: MidiInputInfo[] | null;
  learn: MidiLearnState;
}

export const useLiveInput = create<LiveInputState>(() => ({
  record: { armed: false, input: null },
  midiInputs: null,
  learn: { paramRef: null },
}));

let installed = false;
let lastTakeId: number | null = null;
let lastTarget: string | null | undefined;

function syncTarget(): void {
  const id = effectiveChannelId();
  if (id === lastTarget) return;
  lastTarget = id;
  try {
    window.krypt.midi.setTarget(id);
  } catch {
    /* fire-and-forget */
  }
}

function applyRecord(s: RecordState): void {
  useLiveInput.setState({ record: s });
  const t = s.lastTake;
  if (t && t.id !== lastTakeId) {
    lastTakeId = t.id;
    (t.ok ? toast.success : toast.warn)(t.message);
  }
}

export function installLiveInput(): void {
  if (installed) return;
  installed = true;
  const k = window.krypt;
  k.record
    .status()
    .then((s) => {
      // An old take (before a renderer reload) is not toasted again.
      if (lastTakeId === null) lastTakeId = s.lastTake?.id ?? null;
      useLiveInput.setState({ record: s });
    })
    .catch(() => undefined);
  k.record.onStatus(applyRecord);
  k.midi.onInputs((midiInputs) => useLiveInput.setState({ midiInputs }));
  k.midi.onLearn((learn) => useLiveInput.setState({ learn }));
  // MIDI input plays the selected channel (falls back to the first channel).
  syncTarget();
  useUi.subscribe((s, prev) => {
    if (s.selectedChannelId !== prev.selectedChannelId) syncTarget();
  });
  useDocStore.subscribe((s, prev) => {
    if (s.project !== prev.project) syncTarget();
  });
  // The engine (re)started: main re-sends the target itself; refresh ours and the device list.
  const refreshInputs = (): void =>
    void k.midi
      .inputs()
      .then((r) => r.ok && useLiveInput.setState({ midiInputs: r.data ?? [] }))
      .catch(() => undefined);
  k.engine.onStatus((st) => {
    if (st.state === 'running') {
      lastTarget = undefined;
      syncTarget();
      refreshInputs();
    }
  });
  k.engine
    .status()
    .then((st) => st.state === 'running' && refreshInputs())
    .catch(() => undefined);
}

/** Toggle record arm (transport button). */
export async function toggleRecordArm(): Promise<void> {
  const armed = !useLiveInput.getState().record.armed;
  try {
    const r = await window.krypt.record.setArmed(armed);
    if (r.data) useLiveInput.setState({ record: r.data });
    if (report(r) && r.message) {
      if (/no audio input/i.test(r.message)) toast.warn(r.message);
      else toast.info(r.message);
    }
  } catch (err) {
    toast.error((err as Error).message);
  }
}

/** "Link to controller…": wait for the next CC and link it to `paramRef`. */
export async function linkToController(paramRef: string, label: string): Promise<void> {
  toast.info(`Move a knob, fader or pedal on your MIDI controller to link it to ${label}`);
  try {
    const r = await window.krypt.midi.learn(paramRef, label);
    if (r.ok) toast.success(r.message ?? `Linked ${label}`);
    else if (!/cancelled/i.test(r.message ?? '')) toast.warn(r.message ?? `${label} wasn't linked`);
    else toast.info(r.message ?? 'Cancelled');
  } catch (err) {
    toast.error((err as Error).message);
  }
}
