import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw, Trash } from 'lucide-react';
import type { DeviceInfo } from '@shared/engine/protocol';
import type { RecordMode } from '@shared/types';
import { audioInputSettings, midiSettings, QUANTIZE_GRIDS, recordingSettings } from '@shared/live/recording';
import { Switch } from '../../components/common';
import { Select } from '../../controls/Toggle';
import { updateSettings, useSettings } from '../../state/status';
import { useLiveInput } from '../../live/liveInput';
import { report, toast } from '../../app/notify';
import { cls } from '../../utils/format';

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h2>
      {description && <p className="mt-0.5 text-[11px] text-krypt-muted/80">{description}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-[12px] font-semibold text-white">{label}</div>
        {hint && <div className="text-[10px] text-krypt-muted">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, hint }: { on: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cls('relative h-4 w-7 rounded-full border transition', on ? 'border-krypt-purple/60 bg-krypt-purple/40' : 'border-white/15 bg-white/[0.06]')}
      data-hint={hint}
    >
      <span className={cls('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', on ? 'left-[14px]' : 'left-0.5 bg-white/60')} />
    </button>
  );
}

const MODES: Array<{ value: RecordMode; label: string }> = [
  { value: 'midi', label: 'MIDI notes' },
  { value: 'audio', label: 'Audio' },
  { value: 'both', label: 'MIDI + audio' },
];

function channelOptions(count: number): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const n = Math.max(1, Math.min(32, count || 2));
  for (let c = 0; c + 1 < n; c += 2) out.push({ value: `${c},${c + 1}`, label: `${c + 1}+${c + 2} (stereo)` });
  for (let c = 0; c < n; c++) out.push({ value: `${c}`, label: `${c + 1} (mono)` });
  return out;
}

export function LiveInputSettings() {
  const settings = useSettings((s) => s.settings);
  const inputs = useLiveInput((s) => s.midiInputs);
  const record = useLiveInput((s) => s.record);
  const [scanning, setScanning] = useState(false);
  const [audioDevices, setAudioDevices] = useState<DeviceInfo[] | null>(null);

  const rescanMidi = async (): Promise<void> => {
    setScanning(true);
    try {
      const r = await window.krypt.midi.inputs();
      if (r.ok) useLiveInput.setState({ midiInputs: r.data ?? [] });
      else toast.error(`Couldn't list MIDI inputs: ${r.message ?? 'engine unavailable'}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const loadAudioInputs = async (): Promise<void> => {
    setAudioDevices(null);
    try {
      const r = await window.krypt.record.listInputDevices();
      if (r.ok) setAudioDevices(r.data ?? []);
      else {
        setAudioDevices([]);
        toast.error(`Couldn't list audio inputs: ${r.message ?? 'engine unavailable'}`);
      }
    } catch (err) {
      setAudioDevices([]);
      toast.error((err as Error).message);
    }
  };

  useEffect(() => {
    void rescanMidi();
    void loadAudioInputs();
  }, []);

  if (!settings) return null;
  const midi = midiSettings(settings);
  const rec = recordingSettings(settings);
  const inp = audioInputSettings(settings);
  const dev = audioDevices?.find((d) => d.id === inp.deviceId) ?? audioDevices?.find((d) => d.isDefault) ?? null;
  const input = record.input;
  const chOptions = channelOptions(dev?.channels ?? 2);
  const chValue = chOptions.some((o) => o.value === inp.channels.join(',')) ? inp.channels.join(',') : chOptions[0].value;

  const setInputEnabled = async (id: string, enabled: boolean): Promise<void> => {
    try {
      const r = await window.krypt.midi.setInputEnabled(id, enabled);
      if (r.data) useLiveInput.setState({ midiInputs: r.data });
      report(r, r.message);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <Group title="MIDI input" description="Incoming notes play the selected channel (Channel Rack / Piano Roll). The engine owns the devices: on Windows 10 a device can only be used by one app at a time.">
        {inputs === null ? (
          <div className="flex items-center gap-2 px-1 text-[11px] text-krypt-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Looking for MIDI devices…
          </div>
        ) : inputs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-3 py-2 text-[11px] text-krypt-muted">No MIDI input devices found. Plug one in: it shows up within 2 seconds.</div>
        ) : (
          inputs.map((d) => (
            <Row
              key={d.id}
              label={d.name}
              hint={
                d.open ? (
                  <span className="text-emerald-300">Open</span>
                ) : d.enabled ? (
                  <span className="text-amber-300">{d.error ?? 'Opening…'}</span>
                ) : (
                  'Disabled'
                )
              }
            >
              <Toggle on={d.enabled} onChange={(v) => void setInputEnabled(d.id, v)} hint={d.enabled ? 'Disable this device' : 'Enable this device'} />
            </Row>
          ))
        )}
        <div className="flex items-center justify-between px-1">
          <button type="button" onClick={() => void rescanMidi()} className="flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white" data-hint="Rescan MIDI devices">
            {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Rescan
          </button>
        </div>
        <Switch
          checked={midi.autoEnable}
          onChange={(autoEnable) => void updateSettings({ midi: { ...midi, autoEnable } }, autoEnable ? 'New MIDI devices are enabled automatically' : 'New MIDI devices start disabled')}
          label="Enable new devices automatically"
          description="Turn off if another app needs some of your MIDI devices."
        />
      </Group>

      <Group title="Recording" description="Arm the record button in the transport bar, then press Play. Pattern mode records into the looping pattern (overdub); Song mode records at the song position.">
        <Row label="Record">
          <Select<RecordMode> value={rec.mode} options={MODES} onChange={(mode) => void updateSettings({ recording: { ...rec, mode } }, `Record mode: ${MODES.find((m) => m.value === mode)?.label}`)} width={140} />
        </Row>
        <Row label="Quantize notes" hint="Snap recorded note starts to a grid">
          <Select<number>
            value={rec.quantize}
            options={QUANTIZE_GRIDS.map((g) => ({ value: g.ticks, label: g.label }))}
            onChange={(quantize) => void updateSettings({ recording: { ...rec, quantize } })}
            width={100}
          />
        </Row>
        <Row label="Count-in" hint="Metronome bars before recording starts">
          <Select<number>
            value={rec.countInBars}
            options={[
              { value: 0, label: 'Off' },
              { value: 1, label: '1 bar' },
              { value: 2, label: '2 bars' },
            ]}
            onChange={(n) => void updateSettings({ recording: { ...rec, countInBars: (n === 1 || n === 2 ? n : 0) as 0 | 1 | 2 } })}
            width={100}
          />
        </Row>
      </Group>

      <Group title="Audio input" description="Used when the record mode includes audio. Takes are saved next to the project in a Recordings folder and placed on the playlist.">
        <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-krypt-muted">
          {input?.open
            ? `${input.name} · ${input.sampleRate} Hz · channel${input.channels.length > 1 ? 's' : ''} ${input.channels.map((c) => c + 1).join('+')}${input.latencyMs ? ` · ${input.latencyMs.toFixed(1)} ms input latency` : ''}`
            : input?.message ?? (record.armed && rec.mode !== 'midi' ? 'No audio input is open' : 'Opens when you arm audio recording or turn monitoring on')}
        </div>
        <Row label="Input device">
          <div className="flex items-center gap-1">
            <Select<string>
              value={inp.deviceId ?? ''}
              options={[{ value: '', label: 'System default' }, ...(audioDevices ?? []).map((d) => ({ value: d.id, label: `${d.name}${d.isDefault ? ' (default)' : ''}`, detail: `${d.channels} ch` }))]}
              onChange={(v) => void updateSettings({ audioInput: { ...inp, deviceId: v || null } }, 'Audio input updated')}
              width={210}
            />
            <button type="button" onClick={() => void loadAudioInputs()} className="flex h-5 w-5 items-center justify-center rounded text-krypt-muted hover:text-white" data-hint="Rescan audio inputs">
              {audioDevices === null ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </button>
          </div>
        </Row>
        <Row label="Channels" hint="Two channels record a stereo take, one a mono take">
          <Select<string>
            value={chValue}
            options={chOptions}
            onChange={(v) => void updateSettings({ audioInput: { ...inp, channels: v.split(',').map(Number) } })}
            width={140}
          />
        </Row>
        <Switch
          checked={inp.monitor}
          onChange={(monitor) => void updateSettings({ audioInput: { ...inp, monitor } }, monitor ? 'Input monitoring on' : 'Input monitoring off')}
          label="Input monitoring"
          description="Hear the input through the master output. Use headphones to avoid feedback."
        />
      </Group>

      <Group title="Controller links" description="Right-click any knob → Link to controller…, then move a knob or fader on your MIDI controller.">
        {midi.mappings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-3 py-2 text-[11px] text-krypt-muted">No controller links yet.</div>
        ) : (
          midi.mappings.map((m) => (
            <Row key={m.id} label={m.label ?? m.paramRef} hint={<span className="font-mono">{`CC ${m.cc} · ch ${m.channel + 1} · ${m.device ?? 'any device'} → ${m.paramRef}`}</span>}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const r = await window.krypt.midi.removeMapping(m.id);
                    report(r, r.message);
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md text-krypt-muted hover:bg-white/[0.06] hover:text-rose-300"
                data-hint="Remove this link"
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </Row>
          ))
        )}
      </Group>
    </>
  );
}
