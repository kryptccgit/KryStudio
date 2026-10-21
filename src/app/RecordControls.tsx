import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Circle, KeyboardMusic, X } from 'lucide-react';
import type { RecordMode } from '@shared/types';
import { audioInputSettings, QUANTIZE_GRIDS, recordingSettings } from '@shared/live/recording';
import { onFrame } from '../render/frameLoop';
import { telemetry } from '../live/telemetry';
import { toggleRecordArm, useLiveInput } from '../live/liveInput';
import { updateSettings, useEngineStatus, useSettings } from '../state/status';
import { toast } from './notify';
import { toggleMenuAt, type MenuItem } from '../components/Menu';
import { wm } from '../workspace/WindowManager';
import { cls } from '../utils/format';
import { closeBooth, openBooth } from '../booth/actions';
import { useBooth } from '../booth/store';

function recordButtonClick(mode: RecordMode): void {
  const armed = useLiveInput.getState().record.armed;
  if (useBooth.getState().open) void closeBooth();
  else if (!armed && mode !== 'midi') void openBooth();
  else void toggleRecordArm();
}

type LiveRec = { rec: 'countIn' | 'recording' | null; beats: number };

function useLiveRec(): LiveRec {
  const [s, set] = useState<LiveRec>({ rec: null, beats: 0 });
  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const f = telemetry.connected ? telemetry.frame : null;
      const rec = f?.rec ?? null;
      const beats = f?.countIn ?? 0;
      const key = `${rec}|${beats}`;
      if (key !== last) {
        last = key;
        set({ rec, beats });
      }
    });
  }, []);
  return s;
}

const MODE_LABEL: Record<RecordMode, string> = { midi: 'MIDI notes', audio: 'Audio', both: 'MIDI + audio' };

export function monitorProblem(monitor: boolean, inputOpen: boolean, inputRate: number | undefined, outputRate: number | undefined): string | null {
  if (!monitor || !inputOpen || !inputRate || !outputRate || Math.abs(inputRate - outputRate) < 1) return null;
  return `Input monitoring is paused: the input runs at ${inputRate} Hz and the output at ${outputRate} Hz. Set both devices to the same rate in Windows sound settings.`;
}

function currentMonitorProblem(): string | null {
  const inp = audioInputSettings(useSettings.getState().settings);
  const input = useLiveInput.getState().record.input;
  return monitorProblem(inp.monitor, !!input?.open, input?.sampleRate, useEngineStatus.getState().status?.device?.sampleRate);
}

function recordMenu(): MenuItem[] {
  const s = useSettings.getState().settings;
  const rec = recordingSettings(s);
  const inp = audioInputSettings(s);
  const setRec = (patch: Partial<typeof rec>, msg: string): void => void updateSettings({ recording: { ...rec, ...patch } }, msg);
  return [
    { type: 'header', label: 'Record' },
    { label: 'Vocal Booth…', hint: 'Record a vocal over your song: listen, redo, tune', onSelect: () => void openBooth() },
    { type: 'separator' },
    ...(['midi', 'audio', 'both'] as RecordMode[]).map((m) => ({
      label: MODE_LABEL[m],
      checked: rec.mode === m,
      hint: m === 'midi' ? 'Notes you play go into the pattern' : m === 'audio' ? 'Records the audio input onto the playlist' : 'Notes and audio at once',
      onSelect: () => setRec({ mode: m }, `Record mode: ${MODE_LABEL[m]}`),
    })),
    { type: 'separator' },
    {
      type: 'submenu',
      label: `Quantize: ${QUANTIZE_GRIDS.find((g) => g.ticks === rec.quantize)?.label ?? `${rec.quantize} ticks`}`,
      items: QUANTIZE_GRIDS.map((g) => ({
        label: g.label,
        checked: rec.quantize === g.ticks,
        onSelect: () => setRec({ quantize: g.ticks }, g.ticks ? `Recorded notes snap to ${g.label}` : 'Recorded notes keep their timing'),
      })),
    },
    {
      type: 'submenu',
      label: `Count-in: ${rec.countInBars ? `${rec.countInBars} bar${rec.countInBars > 1 ? 's' : ''}` : 'off'}`,
      items: ([0, 1, 2] as const).map((n) => ({
        label: n ? `${n} bar${n > 1 ? 's' : ''}` : 'Off',
        checked: rec.countInBars === n,
        onSelect: () => setRec({ countInBars: n }, n ? `Count in ${n} bar${n > 1 ? 's' : ''} before recording` : 'No count-in'),
      })),
    },
    { type: 'separator' },
    {
      label: currentMonitorProblem() ? 'Input monitoring (paused: sample rates differ)' : 'Input monitoring',
      checked: inp.monitor,
      hint: currentMonitorProblem() ?? 'Hear the audio input through the master output',
      onSelect: () => void updateSettings({ audioInput: { ...inp, monitor: !inp.monitor } }, inp.monitor ? 'Input monitoring off' : 'Input monitoring on'),
    },
    { label: 'MIDI and audio input settings…', onSelect: () => wm.open('settings') },
  ];
}

function useMonitorWarning(): void {
  const input = useLiveInput((s) => s.record.input);
  const monitor = useSettings((s) => audioInputSettings(s.settings).monitor);
  const outRate = useEngineStatus((s) => s.status?.device?.sampleRate);
  const problem = monitorProblem(monitor, !!input?.open, input?.sampleRate, outRate);
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (problem && warned.current !== problem) toast.warn(problem);
    warned.current = problem;
  }, [problem]);
}

export function RecordButton() {
  useMonitorWarning();
  const armed = useLiveInput((s) => s.record.armed);
  const mode = useSettings((s) => recordingSettings(s.settings).mode);
  const live = useLiveRec();
  const menuRef = useRef<HTMLButtonElement>(null);
  const recording = live.rec === 'recording';
  const counting = live.rec === 'countIn';
  return (
    <div className="flex items-center">
      <button
        type="button"
        data-guide="transport.record"
        onClick={() => recordButtonClick(mode)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (menuRef.current) toggleMenuAt(menuRef.current, recordMenu, { minWidth: 220 });
        }}
        className={cls(
          'relative flex h-7 w-8 items-center justify-center rounded-l-md border transition',
          armed ? 'border-rose-400/60 bg-rose-500/15 text-rose-300 glow-recording' : 'border-white/10 bg-white/[0.04] text-white/70 hover:border-white/25 hover:text-white',
        )}
        data-hint={
          counting
            ? `Counting in: ${live.beats} beat${live.beats === 1 ? '' : 's'} to go`
            : recording
              ? `Recording (${MODE_LABEL[mode]}). Stop the transport or click to stop recording.`
              : armed
                ? `Record armed (${MODE_LABEL[mode]}). Press Play to record; click to disarm.`
                : mode === 'midi'
                  ? `Arm recording (${MODE_LABEL[mode]}), then press Play. Right-click for options.`
                  : 'Record a vocal: opens the Vocal Booth. Right-click for options.'
        }
      >
        <Circle className={cls('h-3.5 w-3.5', armed && 'fill-current', recording && 'animate-pulse')} />
        {counting && live.beats > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-0.5 font-mono text-[9px] font-bold text-white">
            {live.beats}
          </span>
        )}
      </button>
      <button
        ref={menuRef}
        type="button"
        onClick={() => menuRef.current && toggleMenuAt(menuRef.current, recordMenu, { minWidth: 220 })}
        className={cls(
          'flex h-7 w-4 items-center justify-center rounded-r-md border border-l-0 transition',
          armed ? 'border-rose-400/60 bg-rose-500/10 text-rose-300' : 'border-white/10 bg-white/[0.04] text-krypt-muted hover:text-white',
        )}
        data-hint="Record options: MIDI / audio, quantize, count-in, input monitoring"
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </div>
  );
}

export function LearnPill() {
  const learn = useLiveInput((s) => s.learn);
  if (!learn.paramRef) return null;
  return (
    <div className="flex h-6 items-center gap-1 rounded-full border border-krypt-purple/50 bg-krypt-purple/15 pl-2 pr-1 text-[10px] font-semibold text-white" data-hint="Move a knob, fader or pedal on your MIDI controller to link it">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-krypt-pink" />
      <span className="max-w-[160px] truncate">Move a control → {learn.label ?? learn.paramRef}</span>
      <button type="button" onClick={() => window.krypt.midi.cancelLearn()} className="flex h-4 w-4 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white" data-hint="Cancel">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function MidiLed() {
  const dot = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const inputs = useLiveInput((s) => s.midiInputs);
  const open = (inputs ?? []).filter((d) => d.open);
  const failed = (inputs ?? []).filter((d) => d.enabled && !d.open);
  useEffect(() => {
    let lastCount = -1;
    let litUntil = 0;
    let lit = false;
    let level = 0;
    return onFrame((dt) => {
      const f = telemetry.connected ? telemetry.frame : null;
      const now = performance.now();
      const c = f?.midiIn ?? 0;
      if (lastCount >= 0 && c !== lastCount) litUntil = now + 120;
      lastCount = c;
      const on = now < litUntil;
      if (on !== lit && dot.current) {
        lit = on;
        dot.current.style.background = on ? '#EC4899' : '';
        dot.current.style.boxShadow = on ? '0 0 6px rgba(236,72,153,0.9)' : '';
      }
      const pk = f?.inputPeak ? Math.max(f.inputPeak[0], f.inputPeak[1]) : -1;
      level = pk < 0 ? 0 : Math.max(pk, level * Math.pow(10, (-24 * dt) / 20));
      if (meter.current) meter.current.style.display = pk < 0 ? 'none' : '';
      if (fill.current) fill.current.style.height = `${Math.min(100, Math.sqrt(level) * 100)}%`;
    });
  }, []);
  const hint = !inputs
    ? 'MIDI input activity'
    : open.length
      ? `MIDI input: ${open.map((d) => d.name).join(', ')} → the selected channel.${failed.length ? ` Couldn't open: ${failed.map((d) => d.name).join(', ')}.` : ''} Click for MIDI settings.`
      : failed.length
        ? `MIDI: couldn't open ${failed.map((d) => d.name).join(', ')} (another app may be using it). Click for MIDI settings.`
        : 'No MIDI input device connected. Click for MIDI settings.';
  return (
    <button type="button" onClick={() => wm.open('settings')} className="flex h-6 items-center gap-1 rounded-md px-1 text-krypt-muted transition hover:text-white" data-hint={hint}>
      <KeyboardMusic className={cls('h-3.5 w-3.5', failed.length > 0 && open.length === 0 && 'text-amber-300')} />
      <span ref={dot} className={cls('h-1.5 w-1.5 rounded-full transition-colors duration-75', open.length ? 'bg-white/25' : 'bg-white/10')} />
      <span ref={meter} className="relative h-3.5 w-1 overflow-hidden rounded-full bg-white/10" style={{ display: 'none' }}>
        <span ref={fill} className="absolute bottom-0 left-0 w-full rounded-full bg-gradient-to-t from-emerald-400 via-amber-300 to-rose-500" style={{ height: '0%' }} />
      </span>
    </button>
  );
}
