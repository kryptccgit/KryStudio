import { normalizeKeys, type KeymapOverrides } from '@shared/keymap';

export { normalizeKeys };
export type { KeymapOverrides };

export type KeyContext = 'pianoRoll' | 'playlist' | 'channelRack';

export interface KeyBinding {
  keys: string;
  command: string;
  allowInInputs?: boolean;
  repeat?: boolean;
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
  { keys: 'Ctrl+N', command: 'file.new' },
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
  { keys: 'F3', command: 'view.toggle.session' },
  { keys: 'F4', command: 'pattern.nextEmpty' },
  { keys: 'NumpadAdd', command: 'pattern.next', repeat: true },
  { keys: 'NumpadSubtract', command: 'pattern.prev', repeat: true },
  { keys: 'Ctrl+T', command: 'input.toggleTypingPiano' },
  { keys: 'Ctrl+Shift+H', command: 'view.home' },
  { keys: 'F1', command: 'help.guides' },
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

export function prettyKeys(keys: string): string {
  return keys.replace('NumpadAdd', 'Num +').replace('NumpadSubtract', 'Num −');
}

export const KEY_CONTEXTS: KeyContext[] = ['pianoRoll', 'playlist', 'channelRack'];
export const CONTEXT_LABELS: Record<KeyContext, string> = { pianoRoll: 'Piano roll', playlist: 'Playlist', channelRack: 'Channel Rack' };

export function contextForCommand(command: string, defaults: KeyBinding[] = DEFAULT_KEYMAP): KeyContext | undefined {
  const d = defaults.find((b) => b.command === command);
  if (d) return d.context;
  const prefix = command.split('.')[0];
  return KEY_CONTEXTS.find((c) => c === prefix);
}

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
  kind: 'same-scope' | 'shadows' | 'shadowed';
}

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

export function keysForCommand(map: KeyBinding[], command: string): string[] {
  return map.filter((b) => b.command === command).map((b) => b.keys);
}

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

export function getKeymap(): KeyBinding[] {
  return keymap;
}

export function bindingFor(keys: string, context?: string | null): KeyBinding | undefined {
  const list = byKeys.get(keys) ?? byKeys.get(normalizeKeys(keys));
  if (!list) return undefined;
  return (context ? list.find((b) => b.context === context) : undefined) ?? list.find((b) => !b.context);
}

let suspended = 0;
export function setKeymapSuspended(on: boolean): void {
  suspended = Math.max(0, suspended + (on ? 1 : -1));
}

export function isKeymapSuspended(): boolean {
  return suspended > 0;
}

let bareBlocked = false;
export function setBareKeysBlocked(on: boolean): void {
  bareBlocked = on;
}

export function areBareKeysBlocked(): boolean {
  return bareBlocked;
}

export function isBareCombo(keys: string): boolean {
  const parts = keys.split('+');
  if (parts.includes('Ctrl') || parts.includes('Alt')) return false;
  return !/^F\d{1,2}$/.test(parts[parts.length - 1] ?? '');
}

export function shortcutFor(command: string): string | undefined {
  const b = keymap.find((k) => k.command === command);
  return b ? prettyKeys(b.keys) : undefined;
}
