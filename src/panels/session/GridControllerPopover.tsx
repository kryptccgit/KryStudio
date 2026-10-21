// The grid-controller settings popover (Session toolbar): a MIDI pad grid
// (Launchpad-style, APC mini-style or any 8×8 note layout) launches clips and
// scenes. Settings live in main (window.krypt.session.gridSettings). The pads
// light up (Wave 12.2b): main sends the LED map to the output paired with the
// grid's input by name (shared/live/gridLeds.ts), or the one picked here.

import { useEffect, useRef, useState } from 'react';
import { Info, RefreshCw, Usb, X } from 'lucide-react';
import type { MidiInputInfo, MidiOutputInfo } from '@shared/engine/protocol';
import { pairLedOutput } from '@shared/live/gridLeds';
import type { LaunchGridSettings } from '@shared/types';
import { DialogSelect, NumberBox } from '../../components/Dialog';
import { Toggle } from '../../controls/Toggle';
import { report, toast } from '../../app/notify';
import { GRID_LAYOUT_LABELS, MIDI_CHANNEL_OPTIONS, clampNote, gridWindowLabel } from './model';

const LAYOUTS: Array<LaunchGridSettings['layout']> = ['launchpad', 'apc-mini', 'generic'];

export function GridControllerPopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState<LaunchGridSettings | null>(null);
  const [inputs, setInputs] = useState<MidiInputInfo[] | null>(null);
  const [outputs, setOutputs] = useState<MidiOutputInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const loadInputs = async (): Promise<void> => {
    try {
      const r = await window.krypt.midi.inputs();
      if (r.ok && r.data) setInputs(r.data);
      else {
        setInputs([]);
        report(r);
      }
    } catch (err) {
      setInputs([]);
      toast.error(`Couldn't list MIDI inputs: ${(err as Error)?.message ?? String(err)}`);
    }
  };

  useEffect(() => {
    let alive = true;
    window.krypt.session
      .gridSettings()
      .then((g) => alive && setS(g))
      .catch((err) => {
        toast.error(`Couldn't load the grid controller settings: ${(err as Error)?.message ?? String(err)}`);
        onClose();
      });
    void loadInputs();
    window.krypt.midi
      .outputs()
      .then((r) => alive && r.ok && setOutputs(r.data ?? []))
      .catch(() => undefined); // the LED picker then offers Automatic / Off only
    const off = window.krypt.midi.onOutputs((list) => alive && setOutputs(list));
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on outside pointerdown / Escape (in the window that owns the popover: works in popouts).
  useEffect(() => {
    const el = ref.current;
    const doc = el?.ownerDocument ?? document;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null;
      if (el && t && !el.contains(t) && !t.closest?.('[data-session-grid-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    return () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const patch = async (p: Partial<LaunchGridSettings>): Promise<void> => {
    if (!s) return;
    setS({ ...s, ...p }); // optimistic; the reply (or a failure) settles it
    setBusy(true);
    try {
      const r = await window.krypt.session.setGridSettings(p);
      if (r.ok) {
        if (r.data) setS(r.data);
      } else {
        report(r);
        setS(s); // back to what main has
      }
    } catch (err) {
      setS(s);
      toast.error(`Couldn't save the grid controller settings: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const devices = [{ value: '', label: 'Any enabled MIDI input' }, ...(inputs ?? []).map((i) => ({ value: i.id, label: `${i.name}${i.enabled ? '' : ' (disabled)'}` }))];
  if (s?.device && !devices.some((d) => d.value === s.device)) devices.push({ value: s.device, label: `${s.device} (not connected)` });
  // LEDs: '' = automatic (paired by name), '-' = off, else an output id.
  const paired = s ? pairLedOutput(s.device, s.layout, outputs) : null;
  const leds = [
    { value: '', label: paired ? `Automatic (${paired})` : 'Automatic (no match yet)' },
    { value: '-', label: 'Off' },
    ...outputs.map((o) => ({ value: o.id, label: o.name })),
  ];
  const ledValue = s?.ledOutput === null ? '-' : s?.ledOutput ?? '';
  if (ledValue && ledValue !== '-' && !leds.some((l) => l.value === ledValue)) leds.push({ value: ledValue, label: `${ledValue} (not connected)` });

  return (
    <div
      ref={ref}
      data-krypt-dialog=""
      className="absolute right-2 top-10 z-50 w-[320px] animate-pop-in rounded-xl border border-white/10 bg-[#101018]/95 text-white shadow-krypt-card backdrop-blur-md"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <Usb className="h-4 w-4 text-krypt-purple" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">Grid controller</div>
          <div className="text-[10px] text-krypt-muted">Launch clips and scenes from a MIDI pad grid</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-krypt-muted transition hover:bg-white/10 hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {!s ? (
        <div className="px-3 py-6 text-center text-[11px] text-krypt-muted">Loading…</div>
      ) : (
        <div className="space-y-2.5 px-3 py-3 text-[11px]">
          <Row label="Enabled">
            <Toggle on={s.enabled} onChange={(v) => void patch({ enabled: v })} disabled={busy} label={s.enabled ? 'On' : 'Off'} hint="Listen to the grid controller" />
          </Row>
          <Row label="Device">
            <div className="flex items-center gap-1">
              <DialogSelect<string> value={s.device ?? ''} onChange={(v) => void patch({ device: v || null })} options={devices} width={170} />
              <button
                type="button"
                title="Rescan MIDI inputs"
                onClick={() => void loadInputs()}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-krypt-muted transition hover:border-white/20 hover:text-white"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
          </Row>
          <Row label="Channel">
            <DialogSelect<number> value={s.channel ?? -1} onChange={(v) => void patch({ channel: v < 0 ? null : v })} options={MIDI_CHANNEL_OPTIONS} width={100} />
          </Row>
          <Row label="Layout">
            <DialogSelect<LaunchGridSettings['layout']> value={s.layout} onChange={(layout) => void patch({ layout })} options={LAYOUTS.map((l) => ({ value: l, label: GRID_LAYOUT_LABELS[l].label }))} width={200} />
          </Row>
          <div className="-mt-1 text-[10px] leading-snug text-krypt-muted">{GRID_LAYOUT_LABELS[s.layout].hint}</div>
          {s.layout === 'generic' && (
            <Row label="Base note">
              <NumberBox value={s.baseNote} min={0} max={127} onChange={(v) => void patch({ baseNote: clampNote(v) })} width={56} />
            </Row>
          )}
          <Row label="First track">
            <NumberBox value={s.trackOffset + 1} min={1} max={512} onChange={(v) => void patch({ trackOffset: Math.max(0, Math.round(v) - 1) })} width={56} />
          </Row>
          <Row label="First scene">
            <NumberBox value={s.sceneOffset + 1} min={1} max={128} onChange={(v) => void patch({ sceneOffset: Math.max(0, Math.round(v) - 1) })} width={56} />
          </Row>
          <div className="font-mono text-[10px] text-white/45">{gridWindowLabel(s)}</div>
          <Row label="LEDs">
            <DialogSelect<string> value={ledValue} onChange={(v) => void patch({ ledOutput: v === '-' ? null : v })} options={leds} width={200} />
          </Row>
          <div className="flex gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[10px] leading-snug text-krypt-muted">
            <Info className="mt-px h-3 w-3 shrink-0 text-krypt-purple" />
            <span>
              The pads light up: clips in their colour, queued clips flash, playing clips pulse. A Launchpad X, Mini MK3 or Pro MK3 is switched to programmer mode for you. Notes from the grid are used for launching only and don't play the selected channel.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-semibold text-white/80">{label}</span>
      {children}
    </div>
  );
}
