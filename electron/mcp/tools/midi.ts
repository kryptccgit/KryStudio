import { z } from 'zod';
import type { MidiInputInfo, MidiOutputInfo } from '@shared/engine/protocol';
import type { MidiOutSettings } from '@shared/types';
import { defineTool, fail, ok } from './types';
import { safeName } from './util';
import { CONTROLLER_TEMPLATES, MAX_CONTROLLER_MAPS, controllerSettings, mapFromTemplate, type ControllerSettings } from '@shared/live/controllers';
import { newId } from '@shared/schema/ids';

function describeControllers(c: ControllerSettings): string {
  const maps = c.maps.length
    ? c.maps.map((m) => `"${safeName(m.name, 40)}" (${m.source}, ${m.enabled ? 'on' : 'off'}, input "${safeName(m.device, 50)}", ${m.bindings.length} bindings)`).join('; ')
    : 'none';
  return `Controller maps (${c.enabled ? 'on' : 'all off'}): ${maps}. Templates for add_controller: ${CONTROLLER_TEMPLATES.map((t) => t.id).join(', ')}.`;
}

function findTemplate(ref: string): { id: string; source: 'gamepad' | 'keyboard' } {
  const r = ref.trim().toLowerCase();
  if (r === 'gamepad' || r === 'keyboard') return { id: `empty-${r}`, source: r };
  const t = CONTROLLER_TEMPLATES.find((x) => x.id === r || x.name.toLowerCase() === r) ?? CONTROLLER_TEMPLATES.find((x) => x.name.toLowerCase().includes(r));
  if (!t) fail(`No controller template "${safeName(ref, 40)}". Templates: ${CONTROLLER_TEMPLATES.map((x) => `${x.id} (${x.name})`).join(', ')}, or "gamepad" / "keyboard" for an empty map.`);
  return { id: t.id, source: t.source };
}

function findPort<T extends { id: string; name: string }>(list: readonly T[], ref: string, what: string): string {
  const r = ref.trim();
  const exact = list.find((p) => p.id === r);
  if (exact) return exact.id;
  const lower = r.toLowerCase();
  const named = list.filter((p) => p.name.toLowerCase() === lower || p.id.toLowerCase() === lower);
  if (named.length === 1) return named[0].id;
  const part = list.filter((p) => p.id.toLowerCase().includes(lower));
  if (part.length === 1) return part[0].id;
  const names = list.map((p) => `"${safeName(p.id, 40)}"`).join(', ') || 'none connected';
  fail(`${part.length > 1 ? 'Several' : 'No'} MIDI ${what}s match "${safeName(r, 40)}" (${what}s: ${names})`);
}

function describe(ins: MidiInputInfo[], outs: MidiOutputInfo[], s: MidiOutSettings): string {
  const inLine = ins.length ? ins.map((i) => `${safeName(i.id, 40)} (${i.open ? 'open' : i.enabled ? `not open${i.error ? `: ${safeName(i.error, 60)}` : ''}` : 'off'}${s.syncInput === i.id ? ', sync source' : ''})`).join('; ') : 'none';
  const outLine = outs.length
    ? outs.map((o) => `${safeName(o.id, 40)} (${o.open ? 'open' : o.enabled ? `not open${o.error ? `: ${safeName(o.error, 60)}` : ''}` : 'off'}${s.clockPorts.includes(o.id) ? ', clock' : ''})`).join('; ')
    : 'none';
  const clock = s.clockPorts.length ? `clock out to ${s.clockPorts.join(', ')}${s.clockOffsetMs ? ` (offset ${s.clockOffsetMs} ms)` : ''}` : 'clock out off';
  const sync = s.syncInput ? `following the clock of ${s.syncInput}${s.syncWritesTempo ? ' (its tempo is written into the project on stop)' : ''}` : 'internal clock';
  return `MIDI inputs: ${inLine}.\nMIDI outputs: ${outLine}.\n${clock}; ${sync}.`;
}

export const midiSetup = defineTool({
  name: 'midi_setup',
  title: 'MIDI ports, clock and sync',
  kind: 'transport',
  description:
    'MIDI hardware for the user. No arguments: list MIDI inputs and outputs and the clock settings. enable_output / disable_output: an output (id or name). clock_out: outputs that get MIDI clock (24 PPQ + Start/Stop/Continue/Song Position, so drum machines and synths follow the song), [] = off; clock_offset_ms (-100..100, + = later). sync_input: an input whose clock drives the transport (its tempo, Start/Stop), or "internal". sync_writes_tempo: write the external tempo into the project when it stops. Grid-controller LEDs follow the clip launcher on their own. Controllers: the gamepads (Xbox, PlayStation, Switch) and keyboard / numpad pads become MIDI inputs through controller maps; add_controller adds one from a template (gamepad-drums = 14 pads from C2 for a drum rack, gamepad-slices = the Slicer from C4, gamepad-scale, keyboard-pads, numpad-pads) and remove_controller removes one. The user fine-tunes them in Settings ▸ Controllers.',
  input: z.object({
    enable_output: z.string().min(1).optional(),
    disable_output: z.string().min(1).optional(),
    clock_out: z.array(z.string().min(1)).max(16).optional(),
    clock_offset_ms: z.number().min(-100).max(100).optional(),
    sync_input: z.string().min(1).optional(),
    sync_writes_tempo: z.boolean().optional(),
    add_controller: z.string().min(1).max(60).optional().describe('Add a controller map from a template id or name (gamepad-drums, gamepad-slices, gamepad-scale, keyboard-pads, numpad-pads), or "gamepad" / "keyboard" for an empty one.'),
    controller_name: z.string().min(1).max(48).optional().describe("add_controller: the new map's name."),
    remove_controller: z.string().min(1).max(64).optional().describe('Remove a controller map by name or input name.'),
  }),
  summarize: (a) =>
    [a.enable_output && `enable ${safeName(a.enable_output, 30)}`, a.disable_output && `disable ${safeName(a.disable_output, 30)}`, a.clock_out && (a.clock_out.length ? 'clock out' : 'clock off'), a.sync_input && `sync ${safeName(a.sync_input, 30)}`]
      .filter(Boolean)
      .join(', ') || (a.add_controller ? `add ${safeName(a.add_controller, 30)}` : a.remove_controller ? `remove ${safeName(a.remove_controller, 30)}` : 'list'),
  async run(deps, _c, a) {
    const done: string[] = [];
    let ctl = controllerSettings(deps.getSettings());
    if (a.remove_controller) {
      const r = a.remove_controller.trim().toLowerCase();
      const hit = ctl.maps.find((m) => m.name.toLowerCase() === r || m.device.toLowerCase() === r) ?? fail(`No controller map "${safeName(a.remove_controller, 40)}". ${describeControllers(ctl)}`);
      ctl = controllerSettings(deps.updateSettings({ controllers: { ...ctl, maps: ctl.maps.filter((m) => m.id !== hit.id) } }));
      done.push(`Removed the controller map "${safeName(hit.name, 40)}"`);
    }
    if (a.add_controller) {
      if (ctl.maps.length >= MAX_CONTROLLER_MAPS) fail(`The user has the most controller maps (${MAX_CONTROLLER_MAPS}); remove one first.`);
      const t = findTemplate(a.add_controller);
      const map = mapFromTemplate(t.id, { id: newId('ctl'), source: t.source, name: a.controller_name ? safeName(a.controller_name, 48) : undefined, taken: ctl.maps });
      ctl = controllerSettings(deps.updateSettings({ controllers: { ...ctl, enabled: true, maps: [...ctl.maps, map] } }));
      done.push(`Added the controller map "${safeName(map.name, 40)}" (${map.bindings.length} bindings, MIDI input "${map.device}"; the user edits it in Settings ▸ Controllers${map.source === 'gamepad' ? ' and wakes the pad with any button' : ''})`);
    }
    const portsAsked = a.enable_output || a.disable_output || a.clock_out || a.clock_offset_ms !== undefined || a.sync_input || a.sync_writes_tempo !== undefined;
    if (!deps.hardware && !portsAsked && done.length) return ok([...done, describeControllers(ctl)].join('.\n'), { controllers: ctl });
    const hw = deps.hardware ?? fail(`MIDI hardware is not available in this session. ${describeControllers(ctl)}`);
    const needOutputs = a.enable_output || a.disable_output || (a.clock_out && a.clock_out.length);
    let outs: MidiOutputInfo[] = [];
    if (needOutputs) {
      const r = await hw.listOutputs();
      if (!r.ok) fail(r.message ?? "Couldn't list the MIDI outputs");
      outs = r.data ?? [];
    }
    for (const [ref, on] of [
      [a.enable_output, true],
      [a.disable_output, false],
    ] as const) {
      if (!ref) continue;
      const r = await hw.setOutputEnabled(findPort(outs, ref, 'output'), on);
      if (!r.ok) fail(r.message ?? "Couldn't change that output");
      done.push(r.message ?? '');
    }
    const patch: Partial<MidiOutSettings> = {};
    if (a.clock_out) patch.clockPorts = a.clock_out.map((p) => findPort(outs, p, 'output'));
    if (a.clock_offset_ms !== undefined) patch.clockOffsetMs = a.clock_offset_ms;
    if (a.sync_input !== undefined) {
      if (/^(internal|none|off)$/i.test(a.sync_input.trim())) patch.syncInput = null;
      else {
        const ins = await hw.listInputs();
        if (!ins.ok) fail(ins.message ?? "Couldn't list the MIDI inputs");
        patch.syncInput = findPort(ins.data ?? [], a.sync_input, 'input');
      }
    }
    if (a.sync_writes_tempo !== undefined) patch.syncWritesTempo = a.sync_writes_tempo;
    if (Object.keys(patch).length) {
      const r = await hw.setClockSettings(patch);
      if (!r.ok) fail(r.message ?? "Couldn't change the MIDI clock settings");
      done.push(r.message ?? '');
    }
    const ins = await hw.listInputs();
    const outsNow = await hw.listOutputs();
    const s = hw.clockSettings();
    const text = `${describe(ins.ok ? ins.data ?? [] : [], outsNow.ok ? outsNow.data ?? [] : [], s)}\n${describeControllers(ctl)}`;
    const head = done.filter(Boolean).join('. ');
    return ok(head ? `${head}.\n${text}` : text, { inputs: ins.data ?? [], outputs: outsNow.data ?? [], clock: s, controllers: ctl });
  },
});

export const MIDI_TOOLS = [midiSetup];
