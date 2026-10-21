import { useEffect, useRef, useState } from 'react';
import { Bot, Keyboard, Metronome, Pause, Play, Redo2, Square, Undo2 } from 'lucide-react';
import { formatBBT, ticksToSeconds } from '@shared/schema/time';
import { BUILTIN_SPECS } from '@shared/schema/params';
import { dispatch, getProject, useProject } from '../doc/store';
import { onFrame } from '../render/frameLoop';
import { telemetry } from '../live/telemetry';
import { playState } from '../live/playState';
import { ParamKnob, paramMenuItems, useGestureValue } from '../controls/ParamKnob';
import { DragNumber } from '../controls/DragNumber';
import { openMenu, openMenuAt, toggleMenuAt, type MenuItem } from '../components/Menu';
import { runCommand } from '../input/commands';
import { shortcutFor } from '../input/keymap';
import { noteName } from '../input/typingPiano';
import { useEngineStatus, useAgents } from '../state/status';
import { useUi } from '../state/ui';
import { wm } from '../workspace/WindowManager';
import { PatternPicker } from './PatternPicker';
import { TimeSigPicker } from './TimeSigPicker';
import { LearnPill, MidiLed, RecordButton } from './RecordControls';
import { SyncBadge } from './SyncBadge';
import { setMode } from './actions';
import { report, toast } from './notify';
import { cls, fmtTimecode } from '../utils/format';

function Sep() {
  return <div className="mx-1 h-6 w-px bg-white/[0.07]" />;
}

function usePlaying(): boolean {
  const [playing, setPlaying] = useState(playState.playing());
  useEffect(() => {
    const off1 = playState.subscribe(setPlaying);
    const off2 = onFrame(() => playState.poll());
    return () => {
      off1();
      off2();
    };
  }, []);
  return playing;
}

function TransportButtons() {
  const playing = usePlaying();
  const btn = 'flex h-7 w-8 items-center justify-center rounded-md border transition';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => runCommand('transport.togglePlay')}
        data-guide="transport.play"
        className={cls(btn, playing ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200 glow-playing' : 'border-white/10 bg-white/[0.04] text-white hover:border-white/25')}
        data-hint={`${playing ? 'Stop' : 'Play'} (${shortcutFor('transport.togglePlay')})`}
      >
        {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
      </button>
      <button
        type="button"
        onClick={() => runCommand('transport.stop')}
        className={cls(btn, 'border-white/10 bg-white/[0.04] text-white/80 hover:border-white/25 hover:text-white')}
        data-hint="Stop and return to the start"
      >
        <Square className="h-3 w-3 fill-current" />
      </button>
    </div>
  );
}

function ModeToggle() {
  const mode = useProject((p) => p.transport.mode);
  const seg = (m: 'pattern' | 'song', label: string) => (
    <button
      type="button"
      onClick={() => void setMode(m)}
      className={cls(
        'h-full px-2 text-[10px] font-bold uppercase tracking-wider transition',
        mode === m ? (m === 'song' ? 'bg-krypt-purple/25 text-white' : 'bg-white/[0.12] text-white') : 'text-krypt-muted hover:text-white',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-6 overflow-hidden rounded-md border border-white/10 bg-black/40" data-guide="transport.mode" data-hint="Pattern mode loops the active pattern; Song mode plays the Playlist (L)">
      {seg('pattern', 'Pat')}
      {seg('song', 'Song')}
    </div>
  );
}

function Tempo() {
  const bpm = useProject((p) => p.transport.bpm);
  const g = useGestureValue(BUILTIN_SPECS.bpm, bpm, (value) => dispatch('params.set', { ref: 'transport/bpm', value }, { coalesceKey: 'knob:transport/bpm', label: 'Set tempo' }));
  return (
    <div className="flex flex-col items-center leading-none" data-guide="transport.tempo">
      <DragNumber
        value={g.value}
        min={10}
        max={999}
        step={1}
        fineStep={0.01}
        pxPerStep={3}
        defaultValue={140}
        label="Tempo"
        hint="Tempo (BPM)"
        format={(v) => v.toFixed(v % 1 ? 2 : 0)}
        className="h-6 w-[64px] text-[14px] font-semibold"
        onChange={(v) => g.setPlain(v)}
        onEnd={() => void g.end()}
        onContextMenu={(e) => openMenu(e, paramMenuItems('transport/bpm', BUILTIN_SPECS.bpm, g.value, (v) => void g.commitNow(v)))}
      />
      <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.2em] text-krypt-muted">BPM</span>
    </div>
  );
}

function Position() {
  const bbt = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let lastB = '';
    let lastT = '';
    return onFrame(() => {
      const p = getProject();
      if (!p) return;
      const tick = Math.max(0, playState.tick());
      const b = formatBBT(tick, p.transport.timeSig);
      const t = fmtTimecode(ticksToSeconds(tick, p.transport.bpm));
      if (b !== lastB && bbt.current) bbt.current.textContent = lastB = b;
      if (t !== lastT && time.current) time.current.textContent = lastT = t;
    });
  }, []);
  return (
    <div className="flex h-8 min-w-[108px] flex-col items-center justify-center rounded-md border border-white/[0.07] bg-black/50 px-2 leading-none" data-hint="Song position: bar : beat : tick, and time">
      <span ref={bbt} className="font-mono text-[14px] font-semibold tabular-nums text-white">
        1:1:000
      </span>
      <span ref={time} className="mt-0.5 font-mono text-[9px] tabular-nums text-krypt-muted">
        00:00.00
      </span>
    </div>
  );
}

function Cpu() {
  const bar = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let last = -1;
    let acc = 0;
    return onFrame((dt) => {
      acc += dt;
      if (acc < 0.1) return;
      acc = 0;
      const f = telemetry.frame;
      const cpu = telemetry.connected && f ? Math.round(f.cpu * 100) : -1;
      if (cpu === last) return;
      last = cpu;
      if (bar.current) {
        bar.current.style.width = `${Math.max(0, cpu)}%`;
        bar.current.style.background = cpu > 85 ? '#ef4444' : cpu > 60 ? '#f59e0b' : 'linear-gradient(90deg,#6366F1,#A855F7)';
      }
      if (label.current) label.current.textContent = cpu < 0 ? '--' : `${cpu}%`;
    });
  }, []);
  return (
    <div className="flex w-[54px] flex-col gap-1" data-hint="Audio thread load (CPU). Over 85% risks dropouts: raise the buffer size in Settings.">
      <div className="flex items-baseline justify-between leading-none">
        <span className="text-[8px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">CPU</span>
        <span ref={label} className="font-mono text-[10px] text-white/80">
          --
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]">
        <div ref={bar} className="h-full w-0 rounded-full transition-[width] duration-150" />
      </div>
    </div>
  );
}

const ENGINE_TONE: Record<string, { dot: string; text: string; label: string; explain: string }> = {
  running: { dot: 'bg-emerald-400 shadow-[0_0_6px_rgba(34,197,94,0.8)]', text: 'text-emerald-200', label: 'Engine', explain: 'The audio engine is running and playing through your device.' },
  starting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-200', label: 'Starting', explain: 'The audio engine is starting up.' },
  restarting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-200', label: 'Restarting', explain: 'The engine stopped unexpectedly and is being restarted. Your project is safe: it lives in the app, not the engine.' },
  stopped: { dot: 'bg-white/30', text: 'text-krypt-muted', label: 'Offline', explain: 'No audio engine is running, so nothing will sound. Editing still works.' },
  failed: { dot: 'bg-rose-400 shadow-[0_0_6px_rgba(239,68,68,0.8)]', text: 'text-rose-200', label: 'Engine failed', explain: 'The audio engine could not start. Try restarting it or pick another audio device.' },
};

function EnginePill() {
  const status = useEngineStatus((s) => s.status);
  const ref = useRef<HTMLButtonElement>(null);
  const state = status?.state ?? 'starting';
  const tone = ENGINE_TONE[state] ?? ENGINE_TONE.stopped;
  const items = (): MenuItem[] => {
    const d = status?.device;
    const f = telemetry.frame;
    return [
      {
        type: 'custom',
        render: () => (
          <div className="w-[280px] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={cls('h-2 w-2 rounded-full', tone.dot)} />
              <span className="text-[12px] font-semibold text-white">Audio engine: {state}</span>
              {status?.engineVersion && <span className="ml-auto font-mono text-[9px] text-krypt-muted">v{status.engineVersion}</span>}
            </div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-krypt-muted">{tone.explain}</div>
            {status?.message && <div className="mt-1.5 rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[10px] text-white/70">{status.message}</div>}
            <div className="mt-2 space-y-0.5 text-[10px] text-krypt-muted">
              <div>Device: {d?.open ? `${d.name} (${d.backend})` : 'none open'}</div>
              {d?.open && (
                <div>
                  {d.sampleRate} Hz · {d.bufferFrames} samples · {d.outputLatencyMs.toFixed(1)} ms
                </div>
              )}
              <div>Telemetry: {telemetry.connected ? 'live' : 'not connected'}</div>
              {f && <div>Dropouts (xruns): {f.xruns}</div>}
              {!!status?.restarts && <div>Restarts this session: {status.restarts}</div>}
            </div>
          </div>
        ),
      },
      { type: 'separator' },
      {
        label: 'Restart engine',
        onSelect: () =>
          void window.krypt.engine.restart().then(
            (r) => report(r, 'Restarting the audio engine…'),
            (e: Error) => toast.error(e.message),
          ),
      },
      { label: 'Audio settings…', onSelect: () => wm.open('settings') },
    ];
  };
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => ref.current && toggleMenuAt(ref.current, items, { align: 'right' })}
      className="flex h-6 items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2 text-[10px] font-semibold transition hover:border-white/20"
      data-hint={`Audio engine: ${state}${status?.message ? ` — ${status.message}` : ''}. Click for details.`}
    >
      <span className={cls('h-1.5 w-1.5 rounded-full', tone.dot)} />
      <span className={tone.text}>{tone.label}</span>
    </button>
  );
}

function TypingKeys() {
  const on = useUi((s) => s.typingPiano);
  const base = useUi((s) => s.typingBaseKey);
  const shift = useUi((s) => s.shiftTypingOctave);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => runCommand('input.toggleTypingPiano')}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!ref.current) return;
        openMenuAt(ref.current, [
          { type: 'header', label: `Typing keyboard · Z = ${noteName(base)}` },
          { label: 'Octave up', onSelect: () => shift(1) },
          { label: 'Octave down', onSelect: () => shift(-1) },
        ]);
      }}
      onWheel={(e) => shift(e.deltaY < 0 ? 1 : -1)}
      className={cls(
        'flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold transition',
        on ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
      )}
      data-hint={`Typing keyboard to piano (${shortcutFor('input.toggleTypingPiano')}): ${on ? 'on' : 'off'} · Z row from ${noteName(base)}, Q row an octave up · wheel = octave`}
    >
      <Keyboard className="h-3.5 w-3.5" />
      <span className="font-mono">{noteName(base)}</span>
    </button>
  );
}

function AiIndicator() {
  const last = useAgents((s) => s.lastAgentAt);
  const clients = useAgents((s) => s.mcp?.clients.length ?? 0);
  const enabled = useAgents((s) => s.mcp?.enabled ?? true);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!last) return;
    setActive(true);
    const t = setTimeout(() => setActive(false), 2500);
    return () => clearTimeout(t);
  }, [last]);
  return (
    <button
      type="button"
      onClick={() => wm.open('agent')}
      data-guide="transport.agent"
      className={cls(
        'relative flex h-6 items-center gap-1.5 rounded-full border px-2 text-[10px] font-bold uppercase tracking-wider transition',
        active ? 'ai-pulse border-krypt-pink/60 bg-krypt-purple/25 text-white' : enabled ? 'border-white/10 bg-black/40 text-white/80 hover:border-krypt-purple/50' : 'border-rose-400/30 text-rose-300',
      )}
      data-hint={
        !enabled
          ? 'Agents are disabled (kill switch). Click to manage.'
          : active
            ? 'An agent is editing the project right now. Click to watch or revert.'
            : `${clients} agent${clients === 1 ? '' : 's'} connected. Click for the Agents panel.`
      }
    >
      <Bot className={cls('h-3.5 w-3.5', active ? 'text-white' : 'text-krypt-purple')} />
      AI
      {clients > 0 && <span className="rounded-full bg-white/10 px-1 font-mono text-[9px]">{clients}</span>}
    </button>
  );
}

export function TransportBar() {
  const metronome = useProject((p) => p.transport.metronome);
  return (
    <div className="relative z-[5] flex h-11 flex-shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-white/[0.06] bg-krypt-void/70 px-2.5 backdrop-blur-md">
      <TransportButtons />
      <RecordButton />
      <LearnPill />
      <Sep />
      <ModeToggle />
      <PatternPicker />
      <Sep />
      <Tempo />
      <SyncBadge />
      <TimeSigPicker />
      <div className="flex items-center gap-1" data-hint="Global swing (each channel has a swing mix in its settings)">
        <span className="text-[8px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Swing</span>
        <ParamKnob paramRef="transport/swing" size={22} label="Swing" />
      </div>
      <button
        type="button"
        onClick={() => runCommand('transport.toggleMetronome')}
        data-guide="transport.metronome"
        className={cls(
          'flex h-6 w-7 items-center justify-center rounded-md border transition',
          metronome ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
        )}
        data-hint={`Metronome (${shortcutFor('transport.toggleMetronome')}): ${metronome ? 'on' : 'off'}`}
      >
        <Metronome className="h-3.5 w-3.5" />
      </button>
      <Sep />
      <Position />
      <Sep />
      <div className="flex items-center gap-1" data-hint="Master volume">
        <span className="text-[8px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Master</span>
        <ParamKnob paramRef="transport/masterVolume" size={22} label="Master volume" />
      </div>
      <div className="ml-auto flex items-center gap-1.5 pl-2">
        <Cpu />
        <EnginePill />
        <MidiLed />
        <TypingKeys />
        <Sep />
        <button
          type="button"
          onClick={() => runCommand('edit.undo')}
          className="flex h-6 w-7 items-center justify-center rounded-md border border-white/10 text-krypt-muted transition hover:border-white/20 hover:text-white"
          data-hint={`Undo your last edit (${shortcutFor('edit.undo')})`}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => runCommand('edit.redo')}
          className="flex h-6 w-7 items-center justify-center rounded-md border border-white/10 text-krypt-muted transition hover:border-white/20 hover:text-white"
          data-hint={`Redo (${shortcutFor('edit.redo')})`}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <AiIndicator />
      </div>
    </div>
  );
}
