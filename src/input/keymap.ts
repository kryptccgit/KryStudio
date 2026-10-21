// ──────────────────────────────────────────────────────────────────────
// FL-default keymap as data + the matcher. Physical keys (F-keys, Space,
// numpad) match by KeyboardEvent.code; letters match by the produced key so
// AZERTY/QWERTZ users get the letters they expect.
// ──────────────────────────────────────────────────────────────────────

import { normalizeKeys, type KeymapOverrides } from '@shared/keymap';

export { normalizeKeys };
export type { KeymapOverrides };

/** Editors that own context-scoped shortcuts (their root carries data-editor="<context>"). */
export type KeyContext = 'pianoRoll' | 'playlist' | 'channelRack';

export interface KeyBinding {
  keys: string;
  command: string;
  /** Fire even while typing in an input (Save). */
  allowInInputs?: boolean;
  /** Repeat while held (undo). */
  repeat?: boolean;
  /** Only while keyboard focus is inside this editor; wins over a global binding of the same keys. */
  context?: KeyContext;
}

export const DEFAULT_KEYMAP: KeyBinding[] = [
  { keys: 'Space', command: 'transport.togglePlay' },
  { keys: 'Ctrl+Space', command: 'transport.pause' },
  { keys: 'L', command: 'transport.toggleMode' },
  { keys: 'Ctrl+M', command: 'transport.toggleMetronome' },
  { keys: 'Ctrl+H', command: 'transport.panic' },
  { keys: 'Ctrl+Z', command: 'edit.undo', repeat: true },
  { keys: 'Ctrl+Y', command: 'edit.redo', repeat: true },
  { keys: 'Ctrl+Shift+Z', command: 'edit.redo', repeat: true },
  { keys: 'Ctrl+S', command: 'file.save', allowInInputs: true },
  { keys: 'Ctrl+Shift+S', command: 'file.saveAs', allowInInputs: true },
  { keys: 'Ctrl+O', command: 'file.open' },
  { keys: 'Ctrl+Shift+O', command: 'file.openAudioProject' },
  { keys: 'Ctrl+N', command: 'file.new' }, // a new project TAB (research/19)
  // Project tabs (research/19; browser conventions, none are FL bindings). Ctrl+T stays the typing piano.
  { keys: 'Ctrl+Tab', command: 'tabs.next', allowInInputs: true },
  { keys: 'Ctrl+Shift+Tab', command: 'tabs.prev', allowInInputs: true },
  { keys: 'Ctrl+1', command: 'tabs.goto1' },
  { keys: 'Ctrl+2', command: 'tabs.goto2' },
  { keys: 'Ctrl+3', command: 'tabs.goto3' },
  { keys: 'Ctrl+4', command: 'tabs.goto4' },
  { keys: 'Ctrl+5', command: 'tabs.goto5' },
  { keys: 'Ctrl+6', command: 'tabs.goto6' },
  { keys: 'Ctrl+7', command: 'tabs.goto7' },
  { keys: 'Ctrl+8', command: 'tabs.goto8' },
  { keys: 'Ctrl+9', command: 'tabs.goto9' },
  { keys: 'Ctrl+W', command: 'tabs.close' },
  { keys: 'Ctrl+Shift+T', command: 'tabs.reopenClosed' },
  { keys: 'Ctrl+R', command: 'file.exportWav' },
  { keys: 'F11', command: 'file.projectInfo' },
  { keys: 'F5', command: 'view.toggle.playlist' },
  { keys: 'F6', command: 'view.toggle.channelRack' },
  { keys: 'F7', command: 'view.toggle.pianoRoll' },
  { keys: 'F9', command: 'view.toggle.mixer' },
  { keys: 'Alt+F8', command: 'view.toggle.browser' },
  // Session view (clip launcher, Wave 12.2): not an FL binding; F3 is free in FL's defaults.
  { keys: 'F3', command: 'view.toggle.session' },
  { keys: 'F4', command: 'pattern.nextEmpty' },
  { keys: 'NumpadAdd', command: 'pattern.next', repeat: true },
  { keys: 'NumpadSubtract', command: 'pattern.prev', repeat: true },
  { keys: 'Ctrl+T', command: 'input.toggleTypingPiano' },
  // Home hub + Guides (not FL bindings: FL has no launcher; F1 is FL's help key).
  { keys: 'Ctrl+Shift+H', command: 'view.home' },
  { keys: 'F1', command: 'help.guides' },
  // Piano roll tools (FL defaults where FL has one). Registered by src/panels/pianoRoll/commands.ts.
  { keys: 'Alt+Q', command: 'pianoRoll.quantize', context: 'pianoRoll' },
  { keys: 'Alt+G', command: 'pianoRoll.generate', context: 'pianoRoll' },
  { keys: 'Ctrl+U', command: 'pianoRoll.quickChop', context: 'pianoRoll' },
  { keys: 'Alt+U', command: 'pianoRoll.chop', context: 'pianoRoll' },
  { keys: 'Ctrl+G', command: 'pianoRoll.glue', context: 'pianoRoll' },
  { keys: 'Ctrl+L', command: 'pianoRoll.legato', context: 'pianoRoll' },
  { keys: 'Alt+S', command: 'pianoRoll.strum', context: 'pianoRoll' },
  { keys: 'Alt+A', command: 'pianoRoll.arpeggiate', context: 'pianoRoll' },
  { keys: 'Alt+R', command: 'pianoRoll.randomize', context: 'pianoRoll' },
  { keys: 'Alt+Y', command: 'pianoRoll.flipH', context: 'pianoRoll' },
  { keys: 'Shift+Alt+Y', command: 'pianoRoll.flipV', context: 'pianoRoll' },
  { keys: 'Alt+K', command: 'pianoRoll.limit', context: 'pianoRoll' },
  { keys: 'Alt+O', command: 'pianoRoll.levels', context: 'pianoRoll' },
  { keys: 'Shift+M', command: 'pianoRoll.toggleMute', context: 'pianoRoll' },
];

const CODE_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  NumpadAdd: 'NumpadAdd',
  NumpadSubtract: 'NumpadSubtract',
};

/** Normalize an event to a binding string like "Ctrl+Shift+S" / "F5" / "Space". */
export function eventToKeys(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  let name: string;
  if (CODE_NAMES[e.code]) name = CODE_NAMES[e.code];
  else if (/^F\d{1,2}$/.test(e.code)) name = e.code;
  else if (e.key.length === 1 && /[a-z]/i.test(e.key)) name = e.key.toUpperCase();
  else if (/^Digit\d$/.test(e.code)) name = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) name = e.code;
  else if (/^Arrow/.test(e.code)) name = e.code;
  else name = e.key.length === 1 ? e.key.toUpperCase() : e.code;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, name].join('+');
}

/** Display label for a binding ("Ctrl+Shift+S", "Num +"). */
export function prettyKeys(keys: string): string {
  return keys.replace('NumpadAdd', 'Num +').replace('NumpadSubtract', 'Num −');
}

// ── Overrides (Settings → Shortcuts) ──────────────────────────────────

export const KEY_CONTEXTS: KeyContext[] = ['pianoRoll', 'playlist', 'channelRack'];
export const CONTEXT_LABELS: Record<KeyContext, string> = { pianoRoll: 'Piano roll', playlist: 'Playlist', channelRack: 'Channel Rack' };

/** Scope of a command's shortcuts: its default binding's context, else inferred from the id prefix ("pianoRoll.glue"). */
export function contextForCommand(command: string, defaults: KeyBinding[] = DEFAULT_KEYMAP): KeyContext | undefined {
  const d = defaults.find((b) => b.command === command);
  if (d) return d.context;
  const prefix = command.split('.')[0];
  return KEY_CONTEXTS.find((c) => c === prefix);
}

/**
 * defaults ⊕ user overrides. A command listed in `overrides` loses ALL its
 * default bindings and gets exactly the listed combos ([] = unbound); its
 * context / repeat / allowInInputs flags come from its default binding.
 * Every resulting `keys` is canonical (normalizeKeys).
 */
export function applyKeymapOverrides(defaults: KeyBinding[], overrides?: KeymapOverrides | null): KeyBinding[] {
  const ov = overrides ?? {};
  const has = (c: string): boolean => Object.prototype.hasOwnProperty.call(ov, c) && Array.isArray(ov[c]);
  const out: KeyBinding[] = [];
  for (const b of defaults) {
    if (has(b.command)) continue;
    const keys = normalizeKeys(b.keys);
    if (keys) out.push({ ...b, keys });
  }
  for (const command of Object.keys(ov)) {
    if (!has(command)) continue;
    const tmpl = defaults.find((b) => b.command === command);
    const context = tmpl ? tmpl.context : contextForCommand(command, defaults);
    for (const raw of ov[command]) {
      const keys = normalizeKeys(raw);
      if (!keys || out.some((b) => b.command === command && b.keys === keys)) continue;
      const b: KeyBinding = { keys, command };
      if (context) b.context = context;
      if (tmpl?.repeat) b.repeat = true;
      if (tmpl?.allowInInputs) b.allowInInputs = true;
      out.push(b);
    }
  }
  return out;
}

export interface KeyConflict {
  binding: KeyBinding;
  /**
   * 'same-scope': the combo already does something else in the same scope (hard conflict).
   * 'shadows': the new contextual binding hides a global one inside its editor.
   * 'shadowed': the new global binding is hidden inside an editor that binds the same combo.
   */
  kind: 'same-scope' | 'shadows' | 'shadowed';
}

/** What binding `keys` to `command` (in `context`) would collide with in `map`. */
export function findKeyConflicts(map: KeyBinding[], keys: string, command: string, context?: KeyContext | null): KeyConflict[] {
  const k = normalizeKeys(keys);
  if (!k) return [];
  const out: KeyConflict[] = [];
  for (const b of map) {
    if (b.keys !== k || b.command === command) continue;
    if ((b.context ?? null) === (context ?? null)) out.push({ binding: b, kind: 'same-scope' });
    else if (context && !b.context) out.push({ binding: b, kind: 'shadows' });
    else if (!context && b.context) out.push({ binding: b, kind: 'shadowed' });
  }
  return out;
}

/** Current combos of a command in a keymap. */
export function keysForCommand(map: KeyBinding[], command: string): string[] {
  return map.filter((b) => b.command === command).map((b) => b.keys);
}

/**
 * The overrides after binding `command` to exactly `keys` (null = unbind) and,
 * when `replace` is set, removing that combo from every same-scope conflicting
 * command. An override equal to the defaults is dropped (back to "default").
 */
export function rebindOverrides(
  defaults: KeyBinding[],
  overrides: KeymapOverrides | null | undefined,
  command: string,
  keys: string | null,
  replace = false,
): KeymapOverrides {
  const next: KeymapOverrides = { ...(overrides ?? {}) };
  const map = applyKeymapOverrides(defaults, next);
  const k = keys ? normalizeKeys(keys) : '';
  if (k && replace) {
    for (const c of findKeyConflicts(map, k, command, contextForCommand(command, defaults))) {
      if (c.kind !== 'same-scope') continue;
      next[c.binding.command] = keysForCommand(map, c.binding.command).filter((x) => x !== k);
    }
  }
  next[command] = k ? [k] : [];
  // drop overrides that equal the defaults
  for (const c of Object.keys(next)) {
    const def = keysForCommand(applyKeymapOverrides(defaults, null), c);
    const cur = next[c];
    if (cur.length === def.length && cur.every((x, i) => x === def[i])) delete next[c];
  }
  return next;
}

let keymap = applyKeymapOverrides(DEFAULT_KEYMAP, null);
let byKeys = indexKeymap(keymap);

function indexKeymap(list: KeyBinding[]): Map<string, KeyBinding[]> {
  const m = new Map<string, KeyBinding[]>();
  for (const b of list) {
    const k = normalizeKeys(b.keys);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return m;
}

export function setKeymap(next: KeyBinding[]): void {
  keymap = next;
  byKeys = indexKeymap(next);
}

/** The active keymap (defaults + user overrides). */
export function getKeymap(): KeyBinding[] {
  return keymap;
}

/** Binding for a key combo: the focused editor's contextual binding first, then the global one. */
export function bindingFor(keys: string, context?: string | null): KeyBinding | undefined {
  const list = byKeys.get(keys) ?? byKeys.get(normalizeKeys(keys));
  if (!list) return undefined;
  return (context ? list.find((b) => b.context === context) : undefined) ?? list.find((b) => !b.context);
}

let suspended = 0;
/** Pause the global keymap (e.g. while the Shortcuts editor captures a key combo). Calls nest. */
export function setKeymapSuspended(on: boolean): void {
  suspended = Math.max(0, suspended + (on ? 1 : -1));
}

export function isKeymapSuspended(): boolean {
  return suspended > 0;
}

let bareBlocked = false;
/**
 * While a full-window view (the Home hub) covers the main window, bare keys
 * belong to it: Space / Enter activate its buttons, letters don't play the
 * typing piano. Shortcuts with Ctrl / Alt and the F-keys keep working.
 */
export function setBareKeysBlocked(on: boolean): void {
  bareBlocked = on;
}

export function areBareKeysBlocked(): boolean {
  return bareBlocked;
}

/** A combo without Ctrl / Alt that isn't an F-key: "Space", "L", "Shift+M", "NumpadAdd". */
export function isBareCombo(keys: string): boolean {
  const parts = keys.split('+');
  if (parts.includes('Ctrl') || parts.includes('Alt')) return false;
  return !/^F\d{1,2}$/.test(parts[parts.length - 1] ?? '');
}

/** First shortcut bound to a command (for menus and hints). */
export function shortcutFor(command: string): string | undefined {
  const b = keymap.find((k) => k.command === command);
  return b ? prettyKeys(b.keys) : undefined;
}
