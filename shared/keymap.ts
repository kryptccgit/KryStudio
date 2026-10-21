// Keyboard-shortcut overrides stored in settings (`Settings.keymap`).
// Pure helpers shared by main (settings-store validation), the browser mock
// and the renderer keymap (src/input/keymap.ts).
//
//   { "pianoRoll.glue": ["Ctrl+J"], "transport.panic": [] }   // [] = unbound

export type KeymapOverrides = Record<string, string[]>;

const MAX_COMMANDS = 512;
const MAX_KEYS_PER_COMMAND = 4;
const COMMAND_ID = /^[A-Za-z][\w.-]{0,79}$/;

const MOD_ALIASES: Record<string, 'Ctrl' | 'Alt' | 'Shift'> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Ctrl',
  meta: 'Ctrl',
  mod: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

/**
 * Canonical form of a key combo: modifiers in the order Ctrl, Alt, Shift (the
 * order eventToKeys produces), single letters upper-case. '' when invalid
 * (no key, two keys, or a bare modifier).
 */
export function normalizeKeys(keys: string): string {
  if (typeof keys !== 'string' || keys.length > 40) return '';
  const parts = keys
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  // "Ctrl++" style (the plus key itself) isn't supported; keep it simple.
  const mods = new Set<string>();
  let key = '';
  for (const p of parts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m) mods.add(m);
    else if (key) return '';
    else key = p.length === 1 ? p.toUpperCase() : p;
  }
  if (!key || !/^[\w\-=[\];',./\\`−]+$/.test(key)) return '';
  return [...(['Ctrl', 'Alt', 'Shift'] as const).filter((m) => mods.has(m)), key].join('+');
}

/** Validate untrusted overrides (settings.json, IPC). Returns undefined when not an object. */
export function sanitizeKeymapOverrides(input: unknown): KeymapOverrides | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: KeymapOverrides = {};
  let n = 0;
  for (const [command, list] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_COMMANDS) break;
    if (!COMMAND_ID.test(command) || !Array.isArray(list)) continue;
    const keys: string[] = [];
    for (const k of list) {
      const norm = typeof k === 'string' ? normalizeKeys(k) : '';
      if (norm && !keys.includes(norm)) keys.push(norm);
      if (keys.length >= MAX_KEYS_PER_COMMAND) break;
    }
    out[command] = keys;
    n++;
  }
  return out;
}
