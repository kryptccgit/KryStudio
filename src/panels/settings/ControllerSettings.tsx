// Settings → Controllers: gamepads (Xbox, PlayStation, Switch, generic) and
// the keyboard / numpad as MIDI controllers (shared/live/controllers.ts, run
// by src/input/controllers.ts). Each map is a virtual MIDI input: notes play
// the selected channel and record, CCs link to any knob ("Link to
// controller…"), commands run the transport. Maps are global settings, like
// controller links; every change saves at once and confirms or toasts.

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Gamepad2, Keyboard, Loader2, Plus, Trash2, X } from 'lucide-react';
import {
  CONTROLLER_TEMPLATES,
  MAX_BINDINGS,
  MAX_CONTROLLER_MAPS,
  actionLabel,
  familyName,
  inputLabel,
  mapFromTemplate,
  nextBindingId,
  padFamily,
  type AxisHalf,
  type ControllerAction,
  type ControllerBinding,
  type ControllerMap,
  type ControllerSettings as Settings,
  type PadFamily,
} from '@shared/live/controllers';
import { newId } from '@shared/schema/ids';
import { NumberInput } from '../../components/common';
import { Select } from '../../controls/Toggle';
import { listAppCommands } from '../../input/commands';
import { cancelLearnInput, learnInput, saveControllers, useControllers, type ConnectedPad } from '../../input/controllers';
import { noteName } from '../../input/typingPiano';
import { toast } from '../../app/notify';
import { cls } from '../../utils/format';

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-5" data-guide="settings.controllers">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h2>
      {description && <p className="mt-0.5 text-[11px] text-krypt-muted/80">{description}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function Toggle({ on, onChange, hint }: { on: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cls('relative h-4 w-7 flex-shrink-0 rounded-full border transition', on ? 'border-krypt-purple/60 bg-krypt-purple/40' : 'border-white/15 bg-white/[0.06]')}
      data-hint={hint}
    >
      <span className={cls('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', on ? 'left-[14px]' : 'left-0.5 bg-white/60')} />
    </button>
  );
}

const small = 'flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/85 hover:border-white/20 disabled:opacity-40';

type ActionKind = ControllerAction['kind'];
const ACTION_KINDS: Array<{ value: ActionKind; label: string; detail: string }> = [
  { value: 'note', label: 'Note', detail: 'Plays the selected channel' },
  { value: 'cc', label: 'CC', detail: 'Link it to any knob' },
  { value: 'transpose', label: 'Transpose', detail: "Shifts this map's notes" },
  { value: 'command', label: 'Command', detail: 'Play, record, undo …' },
];

function defaultAction(kind: ActionKind, map: ControllerMap, analog: boolean): ControllerAction {
  switch (kind) {
    case 'note': {
      const used = new Set(map.bindings.flatMap((b) => (b.action.kind === 'note' ? [b.action.note] : [])));
      let n = 36;
      while (used.has(n) && n < 127) n++;
      return { kind: 'note', note: n, velocity: 100 };
    }
    case 'cc':
      return { kind: 'cc', cc: 1, mode: analog ? 'range' : 'hold', low: 0, high: 127 };
    case 'transpose':
      return { kind: 'transpose', semitones: 12 };
    case 'command':
      return { kind: 'command', command: 'transport.togglePlay' };
  }
}

/** The family to label a map's inputs with: its pad if connected, else the first pad, else generic. */
function familyOf(map: ControllerMap, pads: ConnectedPad[]): PadFamily {
  if (map.gamepad) return padFamily(map.gamepad);
  return pads[0]?.family ?? 'generic';
}

export function ControllerSettings() {
  const settings = useControllers((s) => s.settings);
  const pads = useControllers((s) => s.pads);
  const [open, setOpen] = useState<string | null>(null);
  const save = (next: Settings, ok?: string) => saveControllers(next, ok);
  const setMap = (id: string, patch: Partial<ControllerMap>, ok?: string) => void save({ ...settings, maps: settings.maps.map((m) => (m.id === id ? { ...m, ...patch } : m)) }, ok);

  const add = (templateId: string) => {
    if (settings.maps.length >= MAX_CONTROLLER_MAPS) {
      toast.warn(`You have the most controller maps (${MAX_CONTROLLER_MAPS}); remove one first`);
      return;
    }
    const source = templateId === 'empty-keyboard' ? 'keyboard' : 'gamepad';
    const map = mapFromTemplate(templateId, { id: newId('ctl'), source, taken: settings.maps });
    void save({ ...settings, maps: [...settings.maps, map] }, `Added "${map.name}"${map.source === 'gamepad' && !pads.length ? ': press a button on your pad to wake it up' : ''}`).then((ok) => ok && setOpen(map.id));
  };

  return (
    <Group
      title="Controllers"
      description="Play pads, notes and knobs from an Xbox, PlayStation or Switch controller, or from your keyboard and numpad. Each map is a MIDI input inside Krypt Studio: its notes play the selected channel and record, and its CCs link to any knob with Link to controller…"
    >
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
        <Toggle on={settings.enabled} onChange={(enabled) => void save({ ...settings, enabled }, enabled ? 'Controller maps on' : 'Controller maps off')} hint="Turn every controller map on or off" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-white">Controller maps</div>
          <div className="truncate text-[10px] text-krypt-muted">
            {pads.length ? `Connected: ${pads.map((p) => p.label).join(', ')}` : 'No gamepad yet. Plug one in (USB or Bluetooth) and press any button on it.'}
          </div>
        </div>
        <Select<string>
          value=""
          options={[
            { value: '', label: 'Add a map…' },
            ...CONTROLLER_TEMPLATES.map((t) => ({ value: t.id, label: t.name, detail: t.description })),
            { value: 'empty-gamepad', label: 'Empty gamepad map', detail: 'Bind buttons yourself' },
            { value: 'empty-keyboard', label: 'Empty keyboard map', detail: 'Bind keys yourself' },
          ]}
          onChange={(v) => v && add(v)}
          hint="Start from a ready-made layout (drum pads, slice player, scale player, keyboard / numpad pads) or an empty map"
          width={150}
        />
      </div>

      {settings.maps.map((m) => (
        <MapCard key={m.id} map={m} pads={pads} open={open === m.id} onToggleOpen={() => setOpen(open === m.id ? null : m.id)} setMap={setMap} remove={() => void save({ ...settings, maps: settings.maps.filter((x) => x.id !== m.id) }, `Removed "${m.name}"`)} />
      ))}
    </Group>
  );
}

function MapCard({
  map,
  pads,
  open,
  onToggleOpen,
  setMap,
  remove,
}: {
  map: ControllerMap;
  pads: ConnectedPad[];
  open: boolean;
  onToggleOpen: () => void;
  setMap: (id: string, patch: Partial<ControllerMap>, ok?: string) => void;
  remove: () => void;
}) {
  const [name, setName] = useState(map.name);
  const transpose = useControllers((s) => s.transpose[map.id] ?? 0);
  const family = familyOf(map, pads);
  const Icon = map.source === 'keyboard' ? Keyboard : Gamepad2;
  const padOptions = useMemo(() => {
    const opts = [{ value: '', label: 'First connected pad' }, ...pads.map((p) => ({ value: p.id, label: p.label, detail: p.id }))];
    if (map.gamepad && !pads.some((p) => p.id === map.gamepad)) opts.push({ value: map.gamepad, label: `${familyName(padFamily(map.gamepad))} controller (not connected)`, detail: map.gamepad });
    return opts;
  }, [pads, map]);

  return (
    <div className="rounded-xl border border-white/10 bg-black/20">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={onToggleOpen} className="text-krypt-muted hover:text-white" data-hint={open ? 'Hide the bindings' : 'Show and edit the bindings'}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <Toggle on={map.enabled} onChange={(enabled) => setMap(map.id, { enabled }, `"${map.name}" ${enabled ? 'on' : 'off'}`)} hint="Turn this map on or off" />
        <Icon className="h-3.5 w-3.5 text-krypt-muted" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== map.name && setMap(map.id, { name: name.trim().slice(0, 48) }, 'Renamed')}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-[12px] font-semibold text-white hover:border-white/10 focus:border-krypt-purple/50 focus:outline-none"
          data-hint="Rename this map"
        />
        {transpose !== 0 && <span className="font-mono text-[9px] text-krypt-muted">transpose {transpose > 0 ? '+' : ''}{transpose}</span>}
        <span className="font-mono text-[9px] text-krypt-muted" data-hint="The MIDI input name links and the launcher grid see">
          {map.device}
        </span>
        <button type="button" onClick={remove} className="text-krypt-muted hover:text-rose-300" data-hint="Remove this map">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-white/[0.06] px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-krypt-muted">
            {map.source === 'gamepad' && (
              <>
                <span>Pad</span>
                <Select<string> value={map.gamepad ?? ''} options={padOptions} onChange={(v) => setMap(map.id, { gamepad: v || null }, v ? 'This map now follows that pad' : 'This map follows the first connected pad')} hint="Which controller this map listens to" width={170} />
                <span>Dead zone</span>
                <NumberInput value={Math.round(map.deadzone * 100)} min={0} max={50} suffix="%" onChange={(v) => setMap(map.id, { deadzone: v / 100 })} className="w-16" />
              </>
            )}
            <span>MIDI channel</span>
            <Select<number> value={map.channel} options={Array.from({ length: 16 }, (_, i) => ({ value: i, label: String(i + 1) }))} onChange={(channel) => setMap(map.id, { channel })} hint="MIDI channel of this map's notes and CCs (controller links remember it)" width={56} />
          </div>
          {map.source === 'keyboard' && <div className="text-[10px] text-amber-200/80">While this map is on, its keys play it instead of the typing piano and single-key shortcuts (Ctrl / Alt combos still work).</div>}
          <Bindings map={map} family={family} setBindings={(bindings, ok) => setMap(map.id, { bindings }, ok)} />
        </div>
      )}
    </div>
  );
}

function Bindings({ map, family, setBindings }: { map: ControllerMap; family: PadFamily; setBindings: (b: ControllerBinding[], ok?: string) => void }) {
  const activity = useControllers((s) => s.activity[map.id]);
  const learning = useControllers((s) => s.learning);
  const [learnFor, setLearnFor] = useState<string | 'new' | null>(null);
  const commands = useMemo(() => listAppCommands().sort((a, b) => a.label.localeCompare(b.label)), []);
  const put = (id: string, patch: Partial<ControllerBinding>, ok?: string) => setBindings(map.bindings.map((b) => (b.id === id ? { ...b, ...patch } : b)), ok);

  const learn = async (target: string | 'new') => {
    setLearnFor(target);
    const input = await learnInput(map.source);
    setLearnFor(null);
    if (!input) return;
    const label = inputLabel(input, family);
    const clash = map.bindings.find((b) => b.id !== target && JSON.stringify(b.input) === JSON.stringify(input));
    if (clash) toast.info(`${label} is also bound to ${actionLabel(clash.action)}: both will fire`);
    if (target === 'new') {
      if (map.bindings.length >= MAX_BINDINGS) {
        toast.warn(`A map holds at most ${MAX_BINDINGS} bindings`);
        return;
      }
      const analog = input.kind === 'axis' || (input.kind === 'button' && (input.index === 6 || input.index === 7));
      const b: ControllerBinding = { id: nextBindingId(map), input, action: defaultAction(analog && input.kind === 'axis' ? 'cc' : 'note', map, analog) };
      setBindings([...map.bindings, b], `${label} → ${actionLabel(b.action)}`);
    } else put(target, { input }, `Now on ${label}`);
  };

  const recent = activity && performance.now() - activity.at < 400 ? activity.bindingId : null;
  return (
    <div className="space-y-1">
      {map.bindings.length === 0 && <div className="text-[10px] text-krypt-muted">No bindings yet. Add one and press the {map.source === 'keyboard' ? 'key' : 'button or stick'} it should use.</div>}
      {map.bindings.map((b) => (
        <div key={b.id} className={cls('flex flex-wrap items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors', recent === b.id ? 'bg-krypt-purple/20' : 'hover:bg-white/[0.03]')}>
          <button
            type="button"
            onClick={() => (learnFor === b.id ? cancelLearnInput() : void learn(b.id))}
            className={cls(small, 'w-[132px] justify-between', learnFor === b.id && 'border-krypt-pink/60 text-krypt-pink')}
            data-hint="Click, then press the button, stick or key this binding should use"
          >
            <span className="truncate">{learnFor === b.id ? 'Press it now…' : inputLabel(b.input, family)}</span>
            {learnFor === b.id && <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />}
          </button>
          {b.input.kind === 'axis' && (
            <Select<AxisHalf>
              value={b.input.half}
              options={(['minus', 'plus', 'full'] as AxisHalf[]).map((half) => ({ value: half, label: inputLabel({ kind: 'axis', index: (b.input as { index: number }).index, half }, family).replace(/^(Left|Right) stick /, '') }))}
              onChange={(half) => put(b.id, { input: { kind: 'axis', index: (b.input as { index: number }).index, half } })}
              hint="Which way the stick drives it (both ways = a CC that rests in the middle)"
              width={92}
            />
          )}
          <Select<ActionKind> value={b.action.kind} options={ACTION_KINDS} onChange={(k) => k !== b.action.kind && put(b.id, { action: defaultAction(k, map, b.input.kind === 'axis') })} hint="What it does" width={88} />
          <ActionFields action={b.action} commands={commands} onChange={(action) => put(b.id, { action })} />
          <button type="button" onClick={() => setBindings(map.bindings.filter((x) => x.id !== b.id), 'Binding removed')} className="ml-auto text-krypt-muted hover:text-rose-300" data-hint="Remove this binding">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => (learnFor === 'new' ? cancelLearnInput() : void learn('new'))} className={cls(small, learnFor === 'new' && 'border-krypt-pink/60 text-krypt-pink')} data-hint="Add a binding: press the button, stick or key after clicking">
        {learnFor === 'new' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        {learnFor === 'new' ? (learning?.source === 'keyboard' ? 'Press a key… (Esc cancels)' : 'Press a button or move a stick…') : 'Add binding'}
      </button>
    </div>
  );
}

function ActionFields({ action, commands, onChange }: { action: ControllerAction; commands: Array<{ id: string; label: string }>; onChange: (a: ControllerAction) => void }) {
  const num = 'w-14';
  switch (action.kind) {
    case 'note':
      return (
        <>
          <Select<number> value={action.note} options={Array.from({ length: 128 }, (_, n) => ({ value: n, label: noteName(n), detail: String(n) }))} onChange={(note) => onChange({ ...action, note })} hint="The note it plays" width={70} />
          <span className="text-[9px] text-krypt-muted">vel</span>
          <NumberInput value={action.velocity} min={1} max={127} onChange={(velocity) => onChange({ ...action, velocity: Math.round(velocity) })} className={num} />
        </>
      );
    case 'cc':
      return (
        <>
          <span className="text-[9px] text-krypt-muted">CC</span>
          <NumberInput value={action.cc} min={0} max={119} onChange={(cc) => onChange({ ...action, cc: Math.round(cc) })} className={num} />
          <Select<'hold' | 'toggle' | 'range'>
            value={action.mode}
            options={[
              { value: 'range', label: 'Follow', detail: 'Tracks the stick / trigger' },
              { value: 'hold', label: 'Hold', detail: 'High while held' },
              { value: 'toggle', label: 'Toggle', detail: 'Each press flips' },
            ]}
            onChange={(mode) => onChange({ ...action, mode })}
            hint="How the CC moves"
            width={72}
          />
        </>
      );
    case 'transpose':
      return (
        <Select<number>
          value={action.semitones}
          options={[-12, -7, -5, -1, 1, 5, 7, 12].map((s) => ({ value: s, label: `${s > 0 ? '+' : ''}${s} st` }))}
          onChange={(semitones) => onChange({ kind: 'transpose', semitones })}
          hint="Each press shifts this map's notes"
          width={72}
        />
      );
    case 'command':
      return <Select<string> value={action.command} options={commands.map((c) => ({ value: c.id, label: c.label }))} onChange={(command) => onChange({ kind: 'command', command })} hint="The app command it runs" width={170} />;
  }
}
