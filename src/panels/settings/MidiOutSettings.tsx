import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { MidiOutputInfo } from '@shared/engine/protocol';
import type { MidiOutSettings as MidiOut } from '@shared/types';
import { launchGridSettings } from '@shared/live/launchGrid';
import { resolveLedOutput } from '@shared/live/gridLeds';
import { MAX_CLOCK_OFFSET_MS, midiOutSettings } from '@shared/live/midiOut';
import { NumberInput, Switch } from '../../components/common';
import { Select } from '../../controls/Toggle';
import { useSettings } from '../../state/status';
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
      <div className="flex flex-shrink-0 items-center gap-2">{children}</div>
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

export function MidiOutSettings() {
  const settings = useSettings((s) => s.settings);
  const inputs = useLiveInput((s) => s.midiInputs);
  const [outputs, setOutputs] = useState<MidiOutputInfo[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const rescan = async (): Promise<void> => {
    setScanning(true);
    try {
      const r = await window.krypt.midi.outputs();
      if (r.ok) setOutputs(r.data ?? []);
      else {
        setOutputs([]);
        toast.error(`Couldn't list MIDI outputs: ${r.message ?? 'engine unavailable'}`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void rescan();
    return window.krypt.midi.onOutputs((list) => setOutputs(list));
  }, []);

  if (!settings) return null;
  const m = midiOutSettings(settings);
  const ledPort = outputs ? resolveLedOutput(launchGridSettings(settings), outputs) : null;

  const setClock = async (patch: Partial<Omit<MidiOut, 'outputs'>>): Promise<void> => {
    try {
      const r = await window.krypt.midi.setClockSettings(patch);
      report(r, r.message);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    try {
      const r = await window.krypt.midi.setOutputEnabled(id, enabled);
      if (r.data) setOutputs(r.data);
      report(r, r.message);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const status = (o: MidiOutputInfo): ReactNode => {
    const roles = [m.clockPorts.includes(o.id) && 'clock', ledPort === o.id && 'grid LEDs'].filter(Boolean).join(' + ');
    if (o.open) return <span className="text-emerald-300">Open{roles ? ` · ${roles}` : ''}</span>;
    if (o.enabled) return <span className="text-amber-300">{o.error ?? 'Opening…'}</span>;
    return 'Off';
  };

  const syncOptions = [{ value: '', label: 'Internal (this project)' }, ...(inputs ?? []).map((i) => ({ value: i.id, label: i.name }))];
  if (m.syncInput && !syncOptions.some((o) => o.value === m.syncInput)) syncOptions.push({ value: m.syncInput, label: `${m.syncInput} (not connected)` });

  return (
    <>
      <Group title="MIDI output" description="Ports Krypt Studio sends to: MIDI clock and grid-controller LEDs. Clock and LED ports open by themselves; on Windows 10 a port can only be used by one app at a time.">
        {outputs === null ? (
          <div className="flex items-center gap-2 px-1 text-[11px] text-krypt-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Looking for MIDI outputs…
          </div>
        ) : outputs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-3 py-2 text-[11px] text-krypt-muted">No MIDI outputs found. Plug one in: it shows up within 2 seconds.</div>
        ) : (
          outputs.map((o) => (
            <Row key={o.id} label={o.name} hint={status(o)}>
              <Toggle on={!!m.outputs[o.id]} onChange={(v) => void setEnabled(o.id, v)} hint={m.outputs[o.id] ? 'Close this output' : 'Open this output'} />
            </Row>
          ))
        )}
        <div className="flex items-center justify-between px-1">
          <button type="button" onClick={() => void rescan()} className="flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white" data-hint="Rescan MIDI outputs">
            {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Rescan
          </button>
        </div>
      </Group>

      <Group title="MIDI clock" description="Send clock so drum machines, synths and sequencers follow the song (24 per beat, Start / Stop / Continue, song position when you jump). Or follow another device's clock.">
        {(outputs ?? []).map((o) => (
          <Row key={o.id} label={`Send clock to ${o.name}`} hint={m.clockPorts.includes(o.id) ? (o.open ? 'Sending while the transport plays' : o.error ?? 'Not open') : undefined}>
            <Toggle
              on={m.clockPorts.includes(o.id)}
              onChange={(v) => void setClock({ clockPorts: v ? [...m.clockPorts, o.id] : m.clockPorts.filter((p) => p !== o.id) })}
              hint={m.clockPorts.includes(o.id) ? 'Stop sending clock here' : 'Send MIDI clock here'}
            />
          </Row>
        ))}
        <Row label="Clock offset" hint="Already lined up with what you hear. Negative = earlier, for a device that runs late.">
          <NumberInput value={m.clockOffsetMs} min={-MAX_CLOCK_OFFSET_MS} max={MAX_CLOCK_OFFSET_MS} step={0.5} suffix="ms" onChange={(clockOffsetMs) => void setClock({ clockOffsetMs })} />
        </Row>
        <Row label="Sync to" hint={m.syncInput ? 'The other device starts, stops and sets the tempo. SYNC shows in the transport bar.' : 'Krypt Studio is the clock'}>
          <Select<string> value={m.syncInput ?? ''} options={syncOptions} onChange={(v) => void setClock({ syncInput: v || null })} width={200} />
        </Row>
        <Switch
          checked={m.syncWritesTempo}
          onChange={(syncWritesTempo) => void setClock({ syncWritesTempo })}
          label="Write the external tempo into the project when it stops"
          description="One undo step. While synced, the project tempo stays as it is."
        />
      </Group>
    </>
  );
}
