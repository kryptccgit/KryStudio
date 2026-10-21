// ──────────────────────────────────────────────────────────────────────
// Controller maps at run time (shared/live/controllers.ts): gamepads through
// the Gamepad API (Xbox / XInput, DualSense, Switch Pro, generic HID pads)
// and the computer keyboard / numpad through key events. Each enabled map
// has a ControllerRunner; its MIDI goes to the engine as the virtual input
// `map.device` (window.krypt.midi.virtualIn), so notes play the selected
// channel and record, and CCs can be linked to any knob (MIDI-learn).
// App commands (play, record arm …) run here.
//
// Pads are polled every 8 ms while a gamepad map is on (Chromium samples
// pads at about that rate). Hiding the app or unplugging a pad releases its
// held notes; a window blur releases the keyboard maps' keys (their key-ups
// never arrive).
// ──────────────────────────────────────────────────────────────────────

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
  /** "Xbox controller", "PlayStation controller" … */
  label: string;
}

interface ControllerView {
  settings: ControllerSettings;
  pads: ConnectedPad[];
  /** Last binding that fired per map (live highlight in Settings). */
  activity: Record<string, { bindingId: string; at: number }>;
  /** Current transpose per map. */
  transpose: Record<string, number>;
  /** A "press something" capture in progress. */
  learning: { source: 'gamepad' | 'keyboard' } | null;
}

export const useControllers = create<ControllerView>(() => ({ settings: DEFAULT_CONTROLLERS, pads: [], activity: {}, transpose: {}, learning: null }));

const runners = new Map<string, ControllerRunner>();
let poll: number | null = null;
let lastPads = new Map<number, PadState>();
let learnResolve: ((i: ControllerInput | null) => void) | null = null;
let learnTimer: number | null = null;
const greeted = new Set<string>();

// ── Settings ──────────────────────────────────────────────────────────

/** Save a change to the controller maps (validated by main; the change comes back through onChanged). */
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

// ── Output ────────────────────────────────────────────────────────────

function emit(map: ControllerMap, outs: ControllerOutput[]): void {
  if (!outs.length) return;
  let bytes: number[] = [];
  const flush = () => {
    if (!bytes.length) return;
    try {
      window.krypt.midi.virtualIn(map.device, bytes);
    } catch {
      /* fire-and-forget: the engine may be restarting */
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

/** Release every held note of every map (window blur, panic). */
export function controllersAllOff(): void {
  for (const r of runners.values()) emit(r.current, r.releaseAll());
}

// ── Gamepads ──────────────────────────────────────────────────────────

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

/** The pad a map listens to: its `gamepad` id match, else the first connected pad. */
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
    // Whatever the unplugged pad was holding stops now.
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

// ── Keyboard ──────────────────────────────────────────────────────────

const heldKeys = new Set<string>();

/** A keydown for the keyboard maps. True = consumed (the typing piano and shortcuts don't see it). */
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

/** A window lost focus: its key-ups won't arrive, so the keyboard maps let go. */
export function controllersBlur(): void {
  heldKeys.clear();
  for (const r of runners.values()) if (r.current.source === 'keyboard') emit(r.current, r.releaseAll());
}

// ── Learn ─────────────────────────────────────────────────────────────

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

/** Wait for the next button / stick move (gamepad) or key (keyboard; Escape cancels). Null = cancelled or timed out. */
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

// ── Install ───────────────────────────────────────────────────────────

let installed = false;

/** Main window, once: settings feed, pad hot-plug, polling. Keyboard hooks live in installInput (every window). */
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
