import { create } from 'zustand';
import {
  ControllerRunner,
  DEFAULT_CONTROLLERS,
  MAX_VIRTUAL_MIDI_BYTES,
  controllerSettings,
  detectPadInput,
  familyName,
  padFamily,
  type ControllerInput,
  type ControllerMap,
  type ControllerOutput,
  type ControllerSettings,
  type PadFamily,
  type PadState,
} from '@shared/live/controllers';
import { runCommand } from './commands';
import { flashHint } from '../app/hints';
import { toast } from '../app/notify';

export interface ConnectedPad {
  index: number;
  id: string;
  family: PadFamily;
  label: string;
}

interface ControllerView {
  settings: ControllerSettings;
  pads: ConnectedPad[];
  activity: Record<string, { bindingId: string; at: number }>;
  transpose: Record<string, number>;
  learning: { source: 'gamepad' | 'keyboard' } | null;
}

export const useControllers = create<ControllerView>(() => ({ settings: DEFAULT_CONTROLLERS, pads: [], activity: {}, transpose: {}, learning: null }));

const runners = new Map<string, ControllerRunner>();
let poll: number | null = null;
let lastPads = new Map<number, PadState>();
let learnResolve: ((i: ControllerInput | null) => void) | null = null;
let learnTimer: number | null = null;
const greeted = new Set<string>();

export async function saveControllers(next: ControllerSettings, ok?: string): Promise<boolean> {
  try {
    const s = await window.krypt.settings.update({ controllers: next });
    apply(controllerSettings(s));
    if (ok) flashHint(ok, 'ok');
    return true;
  } catch (err) {
    toast.error(`Couldn't save the controller maps: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

function apply(next: ControllerSettings): void {
  const live = new Set<string>();
  for (const m of next.enabled ? next.maps.filter((x) => x.enabled) : []) {
    live.add(m.id);
    const r = runners.get(m.id);
    if (r) emit(m, r.setMap(m));
    else runners.set(m.id, new ControllerRunner(m));
  }
  for (const [id, r] of runners) {
    if (live.has(id)) continue;
    emit(r.current, r.releaseAll());
    runners.delete(id);
  }
  useControllers.setState({ settings: next });
  syncPolling();
}

function emit(map: ControllerMap, outs: ControllerOutput[]): void {
  if (!outs.length) return;
  let bytes: number[] = [];
  const flush = () => {
    if (!bytes.length) return;
    try {
      window.krypt.midi.virtualIn(map.device, bytes);
    } catch {
    }
    bytes = [];
  };
  let fired: string | null = null;
  for (const o of outs) {
    fired = o.bindingId;
    if (o.kind === 'midi') {
      if (bytes.length + o.bytes.length > MAX_VIRTUAL_MIDI_BYTES) flush();
      bytes.push(...o.bytes);
    } else if (o.kind === 'command') runCommand(o.command);
    else {
      useControllers.setState((s) => ({ transpose: { ...s.transpose, [map.id]: o.total } }));
      flashHint(`${map.name}: transpose ${o.total > 0 ? '+' : ''}${o.total}`, 'info', 1200);
    }
  }
  flush();
  if (fired) useControllers.setState((s) => ({ activity: { ...s.activity, [map.id]: { bindingId: fired!, at: performance.now() } } }));
}

export function controllersAllOff(): void {
  for (const r of runners.values()) emit(r.current, r.releaseAll());
}

function readPads(): Gamepad[] {
  try {
    return (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
  } catch {
    return [];
  }
}

function describe(g: Gamepad): ConnectedPad {
  const family = padFamily(g.id);
  return { index: g.index, id: g.id, family, label: `${familyName(family)} controller` };
}

function padFor(map: ControllerMap, pads: Gamepad[]): Gamepad | undefined {
  if (!pads.length) return undefined;
  if (!map.gamepad) return pads[0];
  const want = map.gamepad.toLowerCase();
  return pads.find((g) => g.id.toLowerCase().includes(want));
}

function wantsPolling(): boolean {
  if (useControllers.getState().learning?.source === 'gamepad') return true;
  return [...runners.values()].some((r) => r.current.source === 'gamepad') && useControllers.getState().pads.length > 0;
}

function syncPolling(): void {
  const want = wantsPolling();
  if (want && poll === null) poll = window.setInterval(tick, 8);
  else if (!want && poll !== null) {
    window.clearInterval(poll);
    poll = null;
  }
}

function tick(): void {
  const pads = readPads();
  const states = new Map<number, PadState>(pads.map((g) => [g.index, { buttons: g.buttons.map((b) => b.value), axes: [...g.axes] }]));
  const learning = useControllers.getState().learning;
  if (learning?.source === 'gamepad' && learnResolve) {
    for (const [i, cur] of states) {
      const hit = detectPadInput(lastPads.get(i) ?? { buttons: [], axes: [] }, cur);
      if (hit) {
        finishLearn(hit);
        break;
      }
    }
  } else {
    for (const r of runners.values()) {
      if (r.current.source !== 'gamepad') continue;
      const g = padFor(r.current, pads);
      const s = g && states.get(g.index);
      if (s) emit(r.current, r.frame(s));
    }
  }
  lastPads = states;
}

function refreshPads(e?: GamepadEvent): void {
  const pads = readPads().map(describe);
  useControllers.setState({ pads });
  if (e?.type === 'gamepaddisconnected') {
    for (const r of runners.values()) if (r.current.source === 'gamepad') emit(r.current, r.releaseAll());
    toast.info(`${describe(e.gamepad).label} disconnected`);
  }
  if (e?.type === 'gamepadconnected' && !greeted.has(e.gamepad.id)) {
    greeted.add(e.gamepad.id);
    const p = describe(e.gamepad);
    const maps = useControllers.getState().settings.maps.filter((m) => m.source === 'gamepad' && m.enabled && padFor(m, [e.gamepad]));
    if (maps.length) toast.success(`${p.label} connected: ${maps.map((m) => m.name).join(', ')} ready`);
    else toast.info(`${p.label} connected. Map it to pads, notes or knobs in Settings ▸ Controllers.`);
  }
  syncPolling();
}

const heldKeys = new Set<string>();

export function controllerKeyDown(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (useControllers.getState().learning?.source === 'keyboard' && learnResolve) {
    finishLearn(e.code === 'Escape' ? null : { kind: 'key', code: e.code });
    return true;
  }
  let used = false;
  for (const r of runners.values()) {
    if (r.current.source !== 'keyboard') continue;
    if (e.repeat || heldKeys.has(e.code)) {
      if (r.current.bindings.some((b) => b.input.kind === 'key' && b.input.code === e.code)) used = true;
      continue;
    }
    const outs = r.key(e.code, true);
    if (outs) {
      used = true;
      emit(r.current, outs);
    }
  }
  if (used) heldKeys.add(e.code);
  return used;
}

export function controllerKeyUp(e: KeyboardEvent): boolean {
  if (!heldKeys.delete(e.code)) return false;
  for (const r of runners.values()) {
    if (r.current.source !== 'keyboard') continue;
    const outs = r.key(e.code, false);
    if (outs) emit(r.current, outs);
  }
  return true;
}

export function controllersBlur(): void {
  heldKeys.clear();
  for (const r of runners.values()) if (r.current.source === 'keyboard') emit(r.current, r.releaseAll());
}

function finishLearn(i: ControllerInput | null): void {
  const done = learnResolve;
  learnResolve = null;
  if (learnTimer !== null) window.clearTimeout(learnTimer);
  learnTimer = null;
  useControllers.setState({ learning: null });
  lastPads = new Map();
  syncPolling();
  done?.(i);
}

export function learnInput(source: 'gamepad' | 'keyboard', timeoutMs = 15_000): Promise<ControllerInput | null> {
  if (learnResolve) finishLearn(null);
  controllersAllOff();
  return new Promise((resolve) => {
    learnResolve = resolve;
    lastPads = new Map(readPads().map((g) => [g.index, { buttons: g.buttons.map((b) => b.value), axes: [...g.axes] }]));
    useControllers.setState({ learning: { source } });
    learnTimer = window.setTimeout(() => finishLearn(null), timeoutMs);
    syncPolling();
  });
}

export function cancelLearnInput(): void {
  if (learnResolve) finishLearn(null);
}

let installed = false;

export function installControllers(): void {
  if (installed) return;
  installed = true;
  void window.krypt.settings
    .get()
    .then((s) => apply(controllerSettings(s)))
    .catch(() => undefined);
  window.krypt.settings.onChanged((s) => apply(controllerSettings(s)));
  window.addEventListener('gamepadconnected', (e) => refreshPads(e as GamepadEvent));
  window.addEventListener('gamepaddisconnected', (e) => refreshPads(e as GamepadEvent));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controllersAllOff();
  });
  refreshPads();
}
