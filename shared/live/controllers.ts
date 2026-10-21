// ──────────────────────────────────────────────────────────────────────
// Controller mapping: gamepads (Xbox, PlayStation, Switch Pro, generic) and
// the computer keyboard / numpad as MIDI controllers
// (docs/ENGINE_PROTOCOL.md §7 "Virtual MIDI inputs").
//
// A ControllerMap turns button presses, stick and trigger moves and key
// presses into MIDI notes and CCs, a transpose, or an app command (play,
// record arm …). The renderer runs the maps (src/input/controllers.ts: the
// Gamepad API + key events) and sends the MIDI to the engine as a virtual
// input named `map.device`. That is the same path as a hardware device, so
// notes play the MIDI target channel and record, and CCs reach controller
// links (MIDI-learn) and the clip-launcher grid.
//
// Pure: types, validation (mergeControllers), names and labels, the
// templates and the ControllerRunner state machine (edges with hysteresis,
// dead zone, toggles, transpose). No I/O, no DOM.
// ──────────────────────────────────────────────────────────────────────

export type ControllerSource = 'gamepad' | 'keyboard';

/** Which part of a stick axis drives the binding: the whole travel, or one direction. */
export type AxisHalf = 'full' | 'plus' | 'minus';

export type ControllerInput =
  /** Gamepad button (W3C standard mapping index; triggers are analog buttons 6 / 7). */
  | { kind: 'button'; index: number }
  /** Gamepad stick axis (0 left X, 1 left Y, 2 right X, 3 right Y; Y is + down). */
  | { kind: 'axis'; index: number; half: AxisHalf }
  /** Computer key by physical position (KeyboardEvent.code). */
  | { kind: 'key'; code: string };

export type CcMode = 'hold' | 'toggle' | 'range';

export type ControllerAction =
  /** Note on while held (velocity 1..127), note off on release. */
  | { kind: 'note'; note: number; velocity: number }
  /** hold: high while held, low on release · toggle: each press flips · range: follows a stick / trigger / key. */
  | { kind: 'cc'; cc: number; mode: CcMode; low: number; high: number }
  /** Shift this map's notes by `semitones` per press (D-pad / shoulder octave buttons). */
  | { kind: 'transpose'; semitones: number }
  /** An app command (src/input/commands.ts ids: transport.togglePlay, transport.toggleRecord …). */
  | { kind: 'command'; command: string };

export interface ControllerBinding {
  id: string;
  input: ControllerInput;
  action: ControllerAction;
}

export interface ControllerMap {
  id: string;
  name: string;
  enabled: boolean;
  source: ControllerSource;
  /** Gamepads: a Gamepad.id substring that picks the pad (null = the first connected pad). */
  gamepad: string | null;
  /** The virtual MIDI input name the engine sees ("Krypt: …"). Set once, so controller links survive a rename. */
  device: string;
  /** 0-based MIDI channel. */
  channel: number;
  /** Stick dead zone 0..0.5. */
  deadzone: number;
  bindings: ControllerBinding[];
}

export interface ControllerSettings {
  /** Master switch for every map. */
  enabled: boolean;
  maps: ControllerMap[];
}

export const DEFAULT_CONTROLLERS: ControllerSettings = { enabled: true, maps: [] };
export const MAX_CONTROLLER_MAPS = 16;
export const MAX_BINDINGS = 64;
export const VIRTUAL_DEVICE_PREFIX = 'Krypt: ';
/** Gamepad levels: a press starts at PRESS and ends below RELEASE (no chatter on analog triggers). */
export const PRESS = 0.5;
export const RELEASE = 0.35;
/** Most MIDI bytes one virtualMidiIn command carries. */
export const MAX_VIRTUAL_MIDI_BYTES = 192;

// ── Names and labels ──────────────────────────────────────────────────

export type PadFamily = 'xbox' | 'playstation' | 'switch' | 'generic';

/** The pad family from a Gamepad.id ("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e …)"). */
export function padFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  if (/054c|dualsense|dualshock|playstation|ps[345] controller/.test(s)) return 'playstation';
  if (/045e|xbox|xinput/.test(s)) return 'xbox';
  if (/057e|pro controller|joy-con|nintendo/.test(s)) return 'switch';
  return 'generic';
}

const DPAD = ['D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'];
const BUTTONS: Record<PadFamily, string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'Left stick press', 'Right stick press', ...DPAD, 'Xbox'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', ...DPAD, 'PS', 'Touchpad'],
  switch: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', 'Minus', 'Plus', 'Left stick press', 'Right stick press', ...DPAD, 'Home', 'Capture'],
  generic: ['Bottom button', 'Right button', 'Left button', 'Top button', 'Left shoulder', 'Right shoulder', 'Left trigger', 'Right trigger', 'Select', 'Start', 'Left stick press', 'Right stick press', ...DPAD, 'Home'],
};
const AXES = ['Left stick', 'Left stick', 'Right stick', 'Right stick'];

export function familyName(f: PadFamily): string {
  return f === 'xbox' ? 'Xbox' : f === 'playstation' ? 'PlayStation' : f === 'switch' ? 'Switch' : 'Gamepad';
}

/** "Q", "1", "Num 7", "Space" for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const num: Record<string, string> = { Add: '+', Subtract: '−', Multiply: '×', Divide: '÷', Decimal: '.', Enter: 'Enter' };
  if (code.startsWith('Numpad')) return `Num ${num[code.slice(6)] ?? code.slice(6)}`;
  const named: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' };
  return named[code] ?? code.replace(/^Arrow/, '').replace(/(Left|Right)$/, ' $1');
}

/** "Cross", "Right stick up", "Num 7" — what the user pressed, in their pad's words. */
export function inputLabel(input: ControllerInput, family: PadFamily = 'generic'): string {
  if (input.kind === 'key') return keyLabel(input.code);
  if (input.kind === 'button') return BUTTONS[family][input.index] ?? `Button ${input.index + 1}`;
  const stick = AXES[input.index] ?? `Axis ${input.index + 1}`;
  const y = input.index % 2 === 1;
  if (input.half === 'full') return `${stick} ${y ? 'up / down' : 'left / right'}`;
  return `${stick} ${input.half === 'plus' ? (y ? 'down' : 'right') : y ? 'up' : 'left'}`;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (n: number): string => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

export function actionLabel(a: ControllerAction): string {
  switch (a.kind) {
    case 'note':
      return `Note ${noteLabel(a.note)}`;
    case 'cc':
      return `CC ${a.cc} ${a.mode === 'range' ? '' : a.mode === 'toggle' ? '(toggle)' : '(hold)'}`.trim();
    case 'transpose':
      return `Transpose ${a.semitones > 0 ? '+' : ''}${a.semitones}`;
    case 'command':
      return a.command;
  }
}

// ── Validation ────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
const COMMAND_RE = /^[a-zA-Z]+\.[a-zA-Z0-9]+$/;
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function cleanInput(v: unknown, source: ControllerSource): ControllerInput | null {
  const o = obj(v);
  if (source === 'keyboard') return o.kind === 'key' && typeof o.code === 'string' && CODE_RE.test(o.code) ? { kind: 'key', code: o.code } : null;
  if (o.kind === 'button') return { kind: 'button', index: int(o.index, 0, 31, 0) };
  if (o.kind === 'axis') return { kind: 'axis', index: int(o.index, 0, 7, 0), half: o.half === 'plus' || o.half === 'minus' ? o.half : 'full' };
  return null;
}

function cleanAction(v: unknown): ControllerAction | null {
  const o = obj(v);
  switch (o.kind) {
    case 'note':
      return { kind: 'note', note: int(o.note, 0, 127, 60), velocity: int(o.velocity, 1, 127, 100) };
    case 'cc':
      return { kind: 'cc', cc: int(o.cc, 0, 119, 1), mode: o.mode === 'toggle' || o.mode === 'range' ? o.mode : 'hold', low: int(o.low, 0, 127, 0), high: int(o.high, 0, 127, 127) };
    case 'transpose': {
      const s = int(o.semitones, -24, 24, 12);
      return s ? { kind: 'transpose', semitones: s } : null;
    }
    case 'command':
      return typeof o.command === 'string' && COMMAND_RE.test(o.command) && o.command.length <= 64 ? { kind: 'command', command: o.command } : null;
  }
  return null;
}

/** "Krypt: <name>", unique among `taken`. */
export function uniqueDevice(name: string, taken: ReadonlySet<string>): string {
  const base = `${VIRTUAL_DEVICE_PREFIX}${name.trim().slice(0, 48) || 'Controller'}`;
  let d = base;
  for (let i = 2; taken.has(d); i++) d = `${base} ${i}`;
  return d;
}

function cleanMap(v: unknown, takenDevices: Set<string>, takenIds: Set<string>): ControllerMap | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID_RE.test(o.id) || takenIds.has(o.id)) return null;
  const source: ControllerSource = o.source === 'keyboard' ? 'keyboard' : 'gamepad';
  const name = (typeof o.name === 'string' ? o.name.trim().slice(0, 48) : '') || (source === 'keyboard' ? 'Keyboard pads' : 'Gamepad');
  const bindings: ControllerBinding[] = [];
  const bindingIds = new Set<string>();
  for (const b of (Array.isArray(o.bindings) ? o.bindings : []).slice(0, MAX_BINDINGS)) {
    const bo = obj(b);
    const input = cleanInput(bo.input, source);
    const action = cleanAction(bo.action);
    if (!input || !action || typeof bo.id !== 'string' || !ID_RE.test(bo.id) || bindingIds.has(bo.id)) continue;
    bindingIds.add(bo.id);
    bindings.push({ id: bo.id, input, action });
  }
  const dev = typeof o.device === 'string' && o.device.startsWith(VIRTUAL_DEVICE_PREFIX) && o.device.length <= 64 && !takenDevices.has(o.device) ? o.device : uniqueDevice(name, takenDevices);
  takenDevices.add(dev);
  takenIds.add(o.id);
  return {
    id: o.id,
    name,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    source,
    gamepad: source === 'gamepad' && typeof o.gamepad === 'string' && o.gamepad.trim() ? o.gamepad.trim().slice(0, 120) : null,
    device: dev,
    channel: int(o.channel, 0, 15, 0),
    deadzone: typeof o.deadzone === 'number' && Number.isFinite(o.deadzone) ? Math.max(0, Math.min(0.5, o.deadzone)) : 0.15,
    bindings,
  };
}

export function controllerSettings(s: { controllers?: ControllerSettings } | null | undefined): ControllerSettings {
  const c = s?.controllers;
  return { enabled: c?.enabled ?? DEFAULT_CONTROLLERS.enabled, maps: (c?.maps ?? []).map((m) => ({ ...m, bindings: m.bindings.map((b) => ({ ...b })) })) };
}

/** Validate an untrusted partial (settings.json / a renderer patch) over a base. `maps`, when given, replaces the list. */
export function mergeControllers(base: ControllerSettings | undefined, input: unknown): ControllerSettings {
  const b = controllerSettings({ controllers: base });
  if (input === undefined) return b;
  const o = obj(input);
  let maps = b.maps;
  if (Array.isArray(o.maps)) {
    const devices = new Set<string>();
    const ids = new Set<string>();
    maps = o.maps
      .slice(0, MAX_CONTROLLER_MAPS)
      .map((m) => cleanMap(m, devices, ids))
      .filter((m): m is ControllerMap => !!m);
  }
  return { enabled: typeof o.enabled === 'boolean' ? o.enabled : b.enabled, maps };
}

// ── Templates ─────────────────────────────────────────────────────────

/** Standard-mapping button indices. */
export const PAD = { south: 0, east: 1, west: 2, north: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15 } as const;

type Spec = Array<[ControllerInput, ControllerAction]>;
const btn = (index: number): ControllerInput => ({ kind: 'button', index });
const axis = (index: number, half: AxisHalf): ControllerInput => ({ kind: 'axis', index, half });
const key = (code: string): ControllerInput => ({ kind: 'key', code });
const note = (n: number): ControllerAction => ({ kind: 'note', note: n, velocity: 100 });
const range = (cc: number): ControllerAction => ({ kind: 'cc', cc, mode: 'range', low: 0, high: 127 });
const cmd = (command: string): ControllerAction => ({ kind: 'command', command });
const shift = (semitones: number): ControllerAction => ({ kind: 'transpose', semitones });

/** Pads in playing order: face, shoulders, triggers, D-pad, stick presses. */
const PAD_ORDER = [PAD.south, PAD.east, PAD.west, PAD.north, PAD.l1, PAD.r1, PAD.l2, PAD.r2, PAD.down, PAD.left, PAD.up, PAD.right, PAD.l3, PAD.r3];

/** Sticks: left up = mod wheel (CC 1), right stick = filter cutoff (CC 74, left / right) and resonance (CC 71, up). */
const STICKS: Spec = [
  [axis(1, 'minus'), range(1)],
  [axis(2, 'full'), range(74)],
  [axis(3, 'minus'), range(71)],
];

function gamepadPads(base: number): Spec {
  return [...PAD_ORDER.map((b, i): [ControllerInput, ControllerAction] => [btn(b), note(base + i)]), [btn(PAD.start), cmd('transport.togglePlay')], [btn(PAD.select), cmd('transport.toggleRecord')], ...STICKS];
}

function scalePlayer(): Spec {
  // C minor pentatonic from C4: D-pad = the lower four, face buttons = the upper four; shoulders shift an octave.
  const notes = [60, 63, 65, 67, 70, 72, 75, 77];
  const order = [PAD.down, PAD.left, PAD.up, PAD.right, PAD.south, PAD.west, PAD.north, PAD.east];
  return [
    ...order.map((b, i): [ControllerInput, ControllerAction] => [btn(b), note(notes[i])]),
    [btn(PAD.l1), shift(-12)],
    [btn(PAD.r1), shift(12)],
    [btn(PAD.l2), range(1)],
    [btn(PAD.r2), range(11)],
    [btn(PAD.start), cmd('transport.togglePlay')],
    [btn(PAD.select), cmd('transport.toggleRecord')],
    [axis(2, 'full'), range(74)],
    [axis(3, 'minus'), range(71)],
  ];
}

function keyboardPads(base: number): Spec {
  // MPC layout: pad 1 bottom left. Z X C V = pads 1-4, A S D F = 5-8, Q W E R = 9-12, 1 2 3 4 = 13-16.
  const rows = [['KeyZ', 'KeyX', 'KeyC', 'KeyV'], ['KeyA', 'KeyS', 'KeyD', 'KeyF'], ['KeyQ', 'KeyW', 'KeyE', 'KeyR'], ['Digit1', 'Digit2', 'Digit3', 'Digit4']];
  return rows.flat().map((c, i): [ControllerInput, ControllerAction] => [key(c), note(base + i)]);
}

function numpadPads(base: number): Spec {
  const codes = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'Numpad0', 'NumpadDecimal', 'NumpadEnter', 'NumpadDivide', 'NumpadMultiply'];
  return [...codes.map((c, i): [ControllerInput, ControllerAction] => [key(c), note(base + i)]), [key('NumpadSubtract'), shift(-12)], [key('NumpadAdd'), shift(12)]];
}

export interface ControllerTemplate {
  id: string;
  name: string;
  description: string;
  source: ControllerSource;
  spec: () => Spec;
}

export const CONTROLLER_TEMPLATES: ControllerTemplate[] = [
  { id: 'gamepad-drums', name: 'Gamepad drum pads', source: 'gamepad', description: 'Face buttons, shoulders, triggers, D-pad and stick presses play 14 pads from C2 (a drum rack). Start plays, Select arms recording, sticks send CC 1 / 74 / 71.', spec: () => gamepadPads(36) },
  { id: 'gamepad-slices', name: 'Gamepad slice player', source: 'gamepad', description: 'The same 14 pads from C4: the Slicer\'s slices 1-14. Start plays, Select arms recording, sticks send CC 1 / 74 / 71.', spec: () => gamepadPads(60) },
  { id: 'gamepad-scale', name: 'Gamepad scale player', source: 'gamepad', description: 'D-pad and face buttons play C minor pentatonic over two octaves from C4; shoulders shift an octave, triggers send CC 1 / 11, the right stick CC 74 / 71.', spec: scalePlayer },
  { id: 'keyboard-pads', name: 'Keyboard 4×4 pads', source: 'keyboard', description: 'Z X C V / A S D F / Q W E R / 1 2 3 4 play 16 pads from C2, pad 1 at bottom left like an MPC. These keys play pads instead of the typing piano while the map is on.', spec: () => keyboardPads(36) },
  { id: 'numpad-pads', name: 'Numpad pads', source: 'keyboard', description: 'Numpad 1-9 (bottom row first), 0, . , Enter, ÷ and × play 14 pads from C2; − and + shift an octave.', spec: () => numpadPads(36) },
];

/** A new map from a template (or empty when `templateId` is unknown / 'empty-…'). */
export function mapFromTemplate(templateId: string, opts: { id: string; source?: ControllerSource; name?: string; gamepad?: string | null; taken: Iterable<ControllerMap> }): ControllerMap {
  const t = CONTROLLER_TEMPLATES.find((x) => x.id === templateId);
  const source = t?.source ?? opts.source ?? 'gamepad';
  const name = (opts.name?.trim() || t?.name || (source === 'keyboard' ? 'Keyboard map' : 'Gamepad map')).slice(0, 48);
  const taken = new Set([...opts.taken].map((m) => m.device));
  return {
    id: opts.id,
    name,
    enabled: true,
    source,
    gamepad: source === 'gamepad' ? (opts.gamepad ?? null) : null,
    device: uniqueDevice(name, taken),
    channel: 0,
    deadzone: 0.15,
    bindings: (t?.spec() ?? []).map(([input, action], i) => ({ id: `b${i + 1}`, input, action })),
  };
}

/** A binding id not yet used in `map`. */
export function nextBindingId(map: ControllerMap): string {
  const used = new Set(map.bindings.map((b) => b.id));
  let i = map.bindings.length + 1;
  while (used.has(`b${i}`)) i++;
  return `b${i}`;
}

// ── Runner ────────────────────────────────────────────────────────────

/** One gamepad poll: button values 0..1 (triggers analog) and axes -1..1. */
export interface PadState {
  buttons: readonly number[];
  axes: readonly number[];
}

export type ControllerOutput =
  | { kind: 'midi'; bytes: number[]; bindingId: string }
  | { kind: 'command'; command: string; bindingId: string }
  | { kind: 'transpose'; total: number; bindingId: string };

/** An axis value with the dead zone removed and the rest rescaled to -1..1. */
export function applyDeadzone(v: number, dead: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= dead) return 0;
  return Math.sign(v) * Math.min(1, (a - dead) / Math.max(1e-6, 1 - dead));
}

/**
 * What a gamepad input reads (0..1) in `s`. `forRange`: a full-travel axis reads 0..1 with the rest at 0.5 (a CC
 * that follows the stick); for presses a full axis reads its deflection either way.
 */
export function inputLevel(input: ControllerInput, s: PadState, deadzone: number, forRange: boolean): number {
  if (input.kind === 'button') {
    const v = s.buttons[input.index] ?? 0;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }
  if (input.kind !== 'axis') return 0;
  const a = applyDeadzone(s.axes[input.index] ?? 0, deadzone);
  if (input.half === 'plus') return Math.max(0, a);
  if (input.half === 'minus') return Math.max(0, -a);
  return forRange ? (a + 1) / 2 : Math.abs(a);
}

/** The first input that moved from rest in `prev` to pressed in `cur` (MIDI-learn for pads). */
export function detectPadInput(prev: PadState, cur: PadState, deadzone = 0.15): ControllerInput | null {
  for (let i = 0; i < cur.buttons.length; i++) if ((cur.buttons[i] ?? 0) >= PRESS && (prev.buttons[i] ?? 0) < RELEASE) return { kind: 'button', index: i };
  for (let i = 0; i < cur.axes.length; i++) {
    const a = applyDeadzone(cur.axes[i] ?? 0, deadzone);
    const p = applyDeadzone(prev.axes[i] ?? 0, deadzone);
    if (Math.abs(a) >= 0.6 && Math.abs(p) < 0.3) return { kind: 'axis', index: i, half: a > 0 ? 'plus' : 'minus' };
  }
  return null;
}

/** Runs one map: inputs in, MIDI / commands out. Holds the state (held notes, toggles, last CC values, transpose). */
export class ControllerRunner {
  private map: ControllerMap;
  private pressed = new Map<string, boolean>();
  /** binding id → the note it sounded (transpose can change before the release). */
  private notes = new Map<string, number>();
  private ccLast = new Map<string, number>();
  private toggles = new Map<string, boolean>();
  private transposeBy = 0;

  constructor(map: ControllerMap) {
    this.map = map;
  }

  get current(): ControllerMap {
    return this.map;
  }

  get transpose(): number {
    return this.transposeBy;
  }

  /** Swap in an edited map. Bindings that changed or went away are released first (their outputs are returned). */
  setMap(map: ControllerMap): ControllerOutput[] {
    const out: ControllerOutput[] = [];
    const next = new Map(map.bindings.map((b) => [b.id, JSON.stringify(b)]));
    const sameChannel = map.channel === this.map.channel;
    for (const b of this.map.bindings) {
      if (sameChannel && next.get(b.id) === JSON.stringify(b)) continue;
      this.release(b, out);
      this.pressed.delete(b.id);
      this.ccLast.delete(b.id);
      this.toggles.delete(b.id);
    }
    this.map = map;
    return out;
  }

  /** A gamepad poll. */
  frame(s: PadState): ControllerOutput[] {
    const out: ControllerOutput[] = [];
    for (const b of this.map.bindings) {
      if (b.input.kind === 'key') continue;
      const range = b.action.kind === 'cc' && b.action.mode === 'range';
      this.drive(b, inputLevel(b.input, s, this.map.deadzone, range), out);
    }
    return out;
  }

  /** A key went down / up. null = the map doesn't use that key (let the app have it). */
  key(code: string, down: boolean): ControllerOutput[] | null {
    const hits = this.map.bindings.filter((b) => b.input.kind === 'key' && b.input.code === code);
    if (!hits.length) return null;
    const out: ControllerOutput[] = [];
    for (const b of hits) this.drive(b, down ? 1 : 0, out);
    return out;
  }

  /** Let go of everything (window blur, pad unplugged, map turned off): note-offs and held CCs back to low. */
  releaseAll(): ControllerOutput[] {
    const out: ControllerOutput[] = [];
    for (const b of this.map.bindings) {
      this.release(b, out);
      this.pressed.set(b.id, false);
    }
    return out;
  }

  private status(kind: number): number {
    return kind | (this.map.channel & 15);
  }

  private release(b: ControllerBinding, out: ControllerOutput[]): void {
    const n = this.notes.get(b.id);
    if (n !== undefined) {
      out.push({ kind: 'midi', bytes: [this.status(0x80), n, 0], bindingId: b.id });
      this.notes.delete(b.id);
    }
    if (b.action.kind === 'cc' && b.action.mode === 'hold' && this.pressed.get(b.id)) out.push({ kind: 'midi', bytes: [this.status(0xb0), b.action.cc, b.action.low], bindingId: b.id });
  }

  private drive(b: ControllerBinding, level: number, out: ControllerOutput[]): void {
    const a = b.action;
    if (a.kind === 'cc' && a.mode === 'range') {
      const v = Math.round(a.low + (a.high - a.low) * Math.max(0, Math.min(1, level)));
      const last = this.ccLast.get(b.id);
      this.ccLast.set(b.id, v);
      // The first reading only sets the baseline: connecting a pad never sends a burst of CCs.
      if (last !== undefined && last !== v) out.push({ kind: 'midi', bytes: [this.status(0xb0), a.cc, v], bindingId: b.id });
      return;
    }
    const was = this.pressed.get(b.id) ?? false;
    const is = was ? level > RELEASE : level >= PRESS;
    if (is === was) return;
    if (!is) {
      this.release(b, out); // reads `pressed` (a held CC goes back to low)
      this.pressed.set(b.id, false);
      return;
    }
    this.pressed.set(b.id, true);
    switch (a.kind) {
      case 'note': {
        const n = Math.max(0, Math.min(127, a.note + this.transposeBy));
        this.notes.set(b.id, n);
        out.push({ kind: 'midi', bytes: [this.status(0x90), n, a.velocity], bindingId: b.id });
        break;
      }
      case 'cc': {
        let v = a.high;
        if (a.mode === 'toggle') {
          const on = !(this.toggles.get(b.id) ?? false);
          this.toggles.set(b.id, on);
          v = on ? a.high : a.low;
        }
        out.push({ kind: 'midi', bytes: [this.status(0xb0), a.cc, v], bindingId: b.id });
        break;
      }
      case 'transpose':
        this.transposeBy = Math.max(-48, Math.min(48, this.transposeBy + a.semitones));
        out.push({ kind: 'transpose', total: this.transposeBy, bindingId: b.id });
        break;
      case 'command':
        out.push({ kind: 'command', command: a.command, bindingId: b.id });
        break;
    }
  }
}

/** Is this a byte list the engine's virtual input should accept: whole note / CC messages only? */
export function isVirtualMidi(bytes: readonly number[]): boolean {
  if (!bytes.length || bytes.length > MAX_VIRTUAL_MIDI_BYTES || bytes.length % 3 !== 0) return false;
  for (let i = 0; i < bytes.length; i += 3) {
    const [s, d1, d2] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    if (!Number.isInteger(s) || s < 0x80 || s > 0xbf || !Number.isInteger(d1) || d1 < 0 || d1 > 127 || !Number.isInteger(d2) || d2 < 0 || d2 > 127) return false;
  }
  return true;
}
