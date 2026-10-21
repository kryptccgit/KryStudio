// Home ▸ Recording Studio: set up vocal recording in four steps.
//  1. Microphone: the input device and channel (mono for a voice), a mic test with a live level meter and advice
//     (the engine opens the input for its meter only: record.setMeter).
//  2. Hear yourself: input monitoring (headphones!), dry.
//  3. Vocal chain: one undo step (recording.setupVocals) makes a "Vocals" insert with a factory vocal chain and a
//     "Vocals" track, and makes them the recording target: every take plays through the chain and lands on the track.
//  4. Record: count-in, then the Vocal Booth (src/booth) in the Studio: record, listen, redo, tune.
// Settings changes save at once; every action confirms or toasts its failure.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleDot, Headphones, Loader2, Mic, RefreshCw, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import type { DeviceInfo } from '@shared/engine/protocol';
import { audioInputSettings, recordingSettings } from '@shared/live/recording';
import { factoryChainPresets } from '@shared/sounds/factory';
import { dispatch, useProject } from '../../doc/store';
import { updateSettings, useEngineStatus, useSettings } from '../../state/status';
import { useLiveInput } from '../../live/liveInput';
import { telemetry } from '../../live/telemetry';
import { onFrame } from '../../render/frameLoop';
import { Select } from '../../controls/Toggle';
import { report, toast } from '../../app/notify';
import { cls } from '../../utils/format';
import { runHomeAction } from '../actions';
import { goBack, openGuides } from '../store';
import { openBooth } from '../../booth/actions';
import { monitorStatus } from '../../booth/logic';
import { monitorProblem } from '../../app/RecordControls';
import { GlassPanel, HomeButton, IconTile, ScreenFrame, ScreenHeader } from '../ui';

const NO_CHAIN = '';

function Step({ n, icon, title, children, right }: { n: number; icon: typeof Mic; title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <GlassPanel className="mt-4 p-5" label={title}>
      <div className="flex flex-wrap items-start gap-4">
        <IconTile icon={icon} />
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-[15px] font-bold text-white">
            <span className="mr-1.5 text-krypt-gradient">{n}</span>
            {title}
          </h2>
          <div className="mt-2 space-y-2.5 text-[12.5px] leading-relaxed text-krypt-muted">{children}</div>
        </div>
        {right && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{right}</div>}
      </div>
    </GlassPanel>
  );
}

function channelOptions(count: number): Array<{ value: string; label: string }> {
  const n = Math.max(1, Math.min(32, count || 2));
  const out: Array<{ value: string; label: string }> = [];
  for (let c = 0; c < n; c++) out.push({ value: `${c}`, label: `Input ${c + 1} (mono)` });
  for (let c = 0; c + 1 < n; c += 2) out.push({ value: `${c},${c + 1}`, label: `Inputs ${c + 1}+${c + 2} (stereo)` });
  return out;
}

/** What the last few seconds of peaks say about the mic gain. */
function verdict(peakDb: number | null): { text: string; tone: string } {
  if (peakDb === null) return { text: 'Sing or talk at performance volume…', tone: 'text-krypt-muted' };
  if (peakDb > -1) return { text: 'Too hot: it clips. Turn the gain on your interface or mic down.', tone: 'text-rose-300' };
  if (peakDb > -6) return { text: 'A little hot: leave room for the loud parts.', tone: 'text-amber-300' };
  if (peakDb >= -24) return { text: 'Good level.', tone: 'text-emerald-300' };
  if (peakDb >= -40) return { text: 'Quiet: turn the gain up or get closer to the mic.', tone: 'text-amber-300' };
  return { text: 'Almost nothing: check the input device and channel above.', tone: 'text-rose-300' };
}

function MicTest() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peakDb, setPeakDb] = useState<number | null>(null);
  const fill = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.record.setMeter(next);
      if (next && !report(r)) return;
      setOn(next);
      setPeakDb(null);
    } catch (err) {
      toast.error(`Couldn't open the microphone: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Close the mic when the screen goes away.
  useEffect(() => () => void window.krypt.record.setMeter(false).catch(() => undefined), []);

  useEffect(() => {
    if (!on) return;
    let level = 0;
    let recent: Array<{ t: number; pk: number }> = [];
    let lastVerdict = 0;
    return onFrame((dt) => {
      const f = telemetry.connected ? telemetry.frame : null;
      const pk = f?.inputPeak ? Math.max(f.inputPeak[0], f.inputPeak[1]) : 0;
      const now = performance.now();
      level = Math.max(pk, level * Math.pow(10, (-24 * dt) / 20));
      recent.push({ t: now, pk });
      recent = recent.filter((x) => now - x.t < 3000);
      const held = recent.reduce((m, x) => Math.max(m, x.pk), 0);
      // dBFS on a -60..0 scale
      const pos = (v: number) => `${Math.max(0, Math.min(100, ((20 * Math.log10(Math.max(v, 1e-6)) + 60) / 60) * 100))}%`;
      if (fill.current) fill.current.style.width = pos(level);
      if (hold.current) hold.current.style.left = pos(held);
      if (now - lastVerdict > 250) {
        lastVerdict = now;
        setPeakDb(held > 1e-5 ? 20 * Math.log10(held) : null);
      }
    });
  }, [on]);

  const v = verdict(on ? peakDb : null);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3">
        <HomeButton kind={on ? 'ghost' : 'primary'} icon={busy ? Loader2 : on ? X : Mic} onClick={() => void toggle(!on)} disabled={busy}>
          {on ? 'Stop the test' : 'Test the mic'}
        </HomeButton>
        <div className="relative h-3 flex-1 overflow-hidden rounded-full border border-white/10 bg-black/40" aria-label="Input level">
          <div className="absolute inset-y-0 left-[60%] w-[30%] bg-emerald-400/10" title="Aim for peaks here (-24 to -6 dBFS)" />
          <div ref={fill} className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-400 via-amber-300 to-rose-500" style={{ width: '0%' }} />
          <div ref={hold} className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: '0%', display: on ? '' : 'none' }} />
        </div>
      </div>
      {on && (
        <div className={cls('text-[12px]', v.tone)}>
          {v.text}
          {peakDb !== null && <span className="ml-2 font-mono text-[10.5px] text-krypt-muted">peak {peakDb.toFixed(1)} dBFS</span>}
        </div>
      )}
    </div>
  );
}

/** Whether your voice really reaches the output while "Hear yourself" is on (engine telemetry monitorPeak). */
function MonitorLine({ monitor }: { monitor: boolean }) {
  const input = useLiveInput((s) => s.record.input);
  const outRate = useEngineStatus((s) => s.status?.device?.sampleRate);
  const [live, setLive] = useState({ mic: 0, mon: 0, running: false });
  useEffect(() => {
    if (!monitor) return;
    let win: Array<{ t: number; mic: number; mon: number }> = [];
    let last = '';
    return onFrame(() => {
      const f = telemetry.connected ? telemetry.frame : null;
      const now = performance.now();
      win.push({ t: now, mic: f?.inputPeak ? Math.max(f.inputPeak[0], f.inputPeak[1]) : 0, mon: f?.monitorPeak ?? 0 });
      win = win.filter((x) => now - x.t < 1500);
      const next = { mic: win.reduce((m, x) => Math.max(m, x.mic), 0), mon: win.reduce((m, x) => Math.max(m, x.mon), 0), running: typeof f?.monitorPeak === 'number' };
      const key = `${next.mic > 0.003}|${next.mon > 1e-4}|${next.running}`;
      if (key !== last) {
        last = key;
        setLive(next);
      }
    });
  }, [monitor]);
  const st = monitorStatus({ monitorOn: monitor, inputOpen: !!input?.open, running: live.running, micPeak: live.mic, monitorPeak: live.mon, rateProblem: monitorProblem(monitor, !!input?.open, input?.sampleRate, outRate) });
  if (!monitor) return null;
  return <p className={cls('font-semibold', st.tone === 'ok' ? 'text-emerald-300' : st.tone === 'warn' ? 'text-amber-300' : 'text-krypt-muted')}>{st.text}</p>;
}

export function RecordingScreen() {
  const settings = useSettings((s) => s.settings);
  const record = useLiveInput((s) => s.record);
  const target = useProject((p) => p.recording);
  const targetInsert = useProject((p) => (p.recording?.insertId ? p.mixer.inserts[p.recording.insertId] : undefined));
  const targetTrack = useProject((p) => (p.recording?.trackId ? p.playlist.tracks[p.recording.trackId] : undefined));
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const chains = useMemo(() => factoryChainPresets().filter((c) => c.role === 'vocal'), []);
  const [chainId, setChainId] = useState<string>(chains[0]?.id ?? NO_CHAIN);
  const [settingUp, setSettingUp] = useState(false);

  const loadDevices = async (): Promise<void> => {
    setDevices(null);
    try {
      const r = await window.krypt.record.listInputDevices();
      if (r.ok) setDevices(r.data ?? []);
      else {
        setDevices([]);
        toast.error(`Couldn't list the audio inputs: ${r.message ?? 'the audio engine is not running'}`);
      }
    } catch (err) {
      setDevices([]);
      toast.error((err as Error).message);
    }
  };
  useEffect(() => {
    void loadDevices();
  }, []);

  if (!settings) return null;
  const inp = audioInputSettings(settings);
  const rec = recordingSettings(settings);
  const dev = devices?.find((d) => d.id === inp.deviceId) ?? devices?.find((d) => d.isDefault) ?? null;
  const chOptions = channelOptions(dev?.channels ?? 2);
  const chValue = chOptions.some((o) => o.value === inp.channels.join(',')) ? inp.channels.join(',') : chOptions[0].value;
  const input = record.input;
  const chain = chains.find((c) => c.id === chainId) ?? null;

  const setupVocals = async (): Promise<void> => {
    setSettingUp(true);
    try {
      const r = await dispatch<{ createdInsert: boolean; createdTrack: boolean }>('recording.setupVocals', { name: 'Vocals', chain });
      if (r.ok && r.data) toast.success(`${r.data.createdInsert ? 'Made a "Vocals" insert' : 'Updated the "Vocals" insert'}${chain ? ` with ${chain.name}` : ''}${r.data.createdTrack ? ' and a "Vocals" track' : ''}: every take plays through it`);
    } finally {
      setSettingUp(false);
    }
  };

  return (
    <ScreenFrame label="Recording Studio">
      <ScreenHeader icon={Mic} title="Recording Studio" subtitle="Set up your mic, hear yourself and record vocal takes." onBack={goBack} />

      <Step n={1} icon={Mic} title="Microphone">
        <div className="flex flex-wrap items-center gap-2">
          <Select<string>
            value={inp.deviceId ?? ''}
            options={[{ value: '', label: 'System default input' }, ...(devices ?? []).map((d) => ({ value: d.id, label: `${d.name}${d.isDefault ? ' (default)' : ''}`, detail: `${d.channels} channel${d.channels === 1 ? '' : 's'}` }))]}
            onChange={(v) => void updateSettings({ audioInput: { ...inp, deviceId: v || null } }, 'Input device changed')}
            hint="Your microphone or audio interface"
            width={250}
          />
          <Select<string>
            value={chValue}
            options={chOptions}
            onChange={(v) => void updateSettings({ audioInput: { ...inp, channels: v.split(',').map(Number) } }, 'Input channel changed')}
            hint="The input your mic is plugged into. A voice is one channel (mono)."
            width={170}
          />
          <button type="button" onClick={() => void loadDevices()} className="flex h-6 w-6 items-center justify-center rounded text-krypt-muted hover:text-white" data-hint="Rescan audio inputs">
            {devices === null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
        {inp.channels.length > 1 && <p className="text-amber-200/80">A voice is mono: pick the one input your mic is on, so the take isn&rsquo;t a half-empty stereo file.</p>}
        <MicTest />
        {input?.open && (
          <p className="font-mono text-[10.5px]">
            {input.name} · {input.sampleRate} Hz{input.latencyMs ? ` · ${input.latencyMs.toFixed(1)} ms input latency` : ''}
          </p>
        )}
      </Step>

      <Step
        n={2}
        icon={Headphones}
        title="Hear yourself"
        right={
          <HomeButton kind={inp.monitor ? 'primary' : 'ghost'} icon={Headphones} onClick={() => void updateSettings({ audioInput: { ...inp, monitor: !inp.monitor } }, inp.monitor ? 'Monitoring off' : 'Monitoring on: use headphones')}>
            {inp.monitor ? 'Monitoring on' : 'Monitoring off'}
          </HomeButton>
        }
      >
        <p>Hear your voice in your headphones while you record, mixed with the beat. Use headphones: through speakers the mic picks the beat up again, and it feeds back.</p>
        <p>You hear the dry mic (the vocal chain applies to the take). If your interface has its own direct monitoring, leave this off.</p>
        <MonitorLine monitor={inp.monitor} />
      </Step>

      <Step
        n={3}
        icon={SlidersHorizontal}
        title="Vocal chain"
        right={
          <HomeButton kind="primary" icon={settingUp ? Loader2 : Sparkles} onClick={() => void setupVocals()} disabled={settingUp}>
            {targetInsert ? 'Update Vocals' : 'Set up Vocals'}
          </HomeButton>
        }
      >
        <p>Makes a &ldquo;Vocals&rdquo; mixer insert with a vocal chain and a &ldquo;Vocals&rdquo; track. Every take plays through the chain and lands on that track, so it sounds finished the moment you stop. Undo removes it all. Skip it and the Vocal Booth sets it up for you with the first chain.</p>
        <div className="flex flex-wrap gap-2">
          {[...chains.map((c) => ({ id: c.id, name: c.name, body: c.description })), { id: NO_CHAIN, name: 'No effects', body: 'A clean insert: add your own effects (or VST3 / CLAP plugins) later.' }].map((c) => (
            <button
              key={c.id || 'none'}
              type="button"
              onClick={() => setChainId(c.id)}
              aria-pressed={chainId === c.id}
              className={cls('w-[200px] rounded-xl border px-3 py-2 text-left transition', chainId === c.id ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-black/20 hover:border-white/20')}
              title={c.body}
            >
              <div className="text-[12px] font-semibold text-white">{c.name}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] text-krypt-muted">{c.body}</div>
            </button>
          ))}
        </div>
        {targetInsert || targetTrack ? (
          <p className="flex flex-wrap items-center gap-2 text-emerald-300/90">
            Takes go to {targetInsert ? `the "${targetInsert.name}" insert (${targetInsert.slotOrder.length} effect${targetInsert.slotOrder.length === 1 ? '' : 's'})` : 'a new insert each'}
            {targetTrack ? ` and the "${targetTrack.name}" track` : ''}.
            <button type="button" className="text-[11px] text-krypt-muted underline-offset-2 hover:text-white hover:underline" onClick={() => void dispatch('recording.setTarget', { insertId: null, trackId: null }).then((r) => r.ok && toast.info('Takes get their own insert and the first free track again'))}>
              Stop routing takes there
            </button>
          </p>
        ) : (
          target === undefined && <p>Not set up yet: each take gets its own insert, with no effects.</p>
        )}
      </Step>

      <Step
        n={4}
        icon={CircleDot}
        title="Record"
        right={
          <HomeButton kind="primary" icon={CircleDot} onClick={() => void openBooth()}>
            Open the Vocal Booth
          </HomeButton>
        }
      >
        <p>
          The <span className="font-semibold text-white/90">Vocal Booth</span> opens over your song: hit <span className="text-white/90">Record</span> (or Space), sing while the beat plays from the playhead, then <span className="text-white/90">Listen</span>, <span className="text-white/90">Redo</span> or <span className="text-white/90">Keep</span> the take, and turn on <span className="text-white/90">Krypt Tune</span> with one click. Every take lands on the Vocals track.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select<number>
            value={rec.countInBars}
            options={[
              { value: 0, label: 'No count-in' },
              { value: 1, label: '1 bar count-in' },
              { value: 2, label: '2 bars count-in' },
            ]}
            onChange={(n) => void updateSettings({ recording: { ...rec, countInBars: (n === 1 || n === 2 ? n : 0) as 0 | 1 | 2 } })}
            hint="Metronome bars before recording starts"
            width={140}
          />
        </div>
        <p>
          Song mode records at the song position. Set a loop region over a verse and every pass becomes a take you can comp in the track&rsquo;s take lanes.{' '}
          <button type="button" className="text-white/80 underline-offset-2 hover:underline" onClick={() => openGuides('takes-comping')}>
            How takes work
          </button>
        </p>
        <p>
          Later, right-click any take ▸ <span className="text-white/80">Tune vocal</span> or{' '}
          <button type="button" className="text-white/80 underline-offset-2 hover:underline" onClick={() => runHomeAction('audioTools')}>
            see the Audio Tools
          </button>
          .
        </p>
      </Step>
    </ScreenFrame>
  );
}
