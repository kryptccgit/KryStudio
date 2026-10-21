// The Keyboard shortcuts guide is generated from the live keymap
// (src/input/keymap.ts: FL defaults ⊕ the user's overrides), never typed
// by hand. Pure: tested in test/home.test.ts.

import { CONTEXT_LABELS, prettyKeys, type KeyBinding, type KeyContext } from '../input/keymap';

export interface ShortcutRow {
  command: string;
  label: string;
  /** Display combos, e.g. ["Ctrl+Y", "Ctrl+Shift+Z"]. */
  keys: string[];
}

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const GLOBAL_SECTIONS: Array<{ title: string; match: (command: string) => boolean }> = [
  { title: 'Playback', match: (c) => c.startsWith('transport.') },
  { title: 'Files', match: (c) => c.startsWith('file.') },
  { title: 'Project tabs', match: (c) => c.startsWith('tabs.') },
  { title: 'Editing', match: (c) => c.startsWith('edit.') },
  { title: 'Windows and views', match: (c) => c.startsWith('view.') || c.startsWith('help.') || c.startsWith('tools.') },
  { title: 'Patterns', match: (c) => c.startsWith('pattern.') },
];

/** Readable fallback when a command has no registered label ("pianoRoll.quickChop" → "Quick chop"). */
export function fallbackLabel(command: string): string {
  const last = command.split('.').pop() ?? command;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Group bindings into sections: global ones by area (Playback, Files…),
 * then one section per editor context. A command bound to several combos
 * is one row. Unbound commands (overridden to []) simply don't appear.
 */
export function buildShortcutSections(bindings: readonly KeyBinding[], labelFor: (command: string) => string | undefined): ShortcutSection[] {
  const rowsBy = new Map<string, ShortcutRow>();
  const order: string[] = [];
  const keyOf = (b: KeyBinding): string => `${b.context ?? ''}|${b.command}`;
  for (const b of bindings) {
    const k = keyOf(b);
    const pretty = prettyKeys(b.keys);
    const row = rowsBy.get(k);
    if (row) {
      if (!row.keys.includes(pretty)) row.keys.push(pretty);
      continue;
    }
    rowsBy.set(k, { command: b.command, label: labelFor(b.command) ?? fallbackLabel(b.command), keys: [pretty] });
    order.push(k);
  }
  const sections: ShortcutSection[] = [];
  const globals = order.filter((k) => k.startsWith('|')).map((k) => rowsBy.get(k)!);
  const used = new Set<ShortcutRow>();
  for (const s of GLOBAL_SECTIONS) {
    const rows = globals.filter((r) => !used.has(r) && s.match(r.command));
    rows.forEach((r) => used.add(r));
    if (rows.length) sections.push({ title: s.title, rows });
  }
  const rest = globals.filter((r) => !used.has(r));
  if (rest.length) sections.push({ title: 'Other', rows: rest });
  const contexts = [...new Set(order.filter((k) => !k.startsWith('|')).map((k) => k.split('|')[0] as KeyContext))];
  for (const ctx of contexts) {
    const rows = order.filter((k) => k.startsWith(`${ctx}|`)).map((k) => rowsBy.get(k)!);
    if (rows.length) sections.push({ title: `${CONTEXT_LABELS[ctx] ?? ctx} (while it has focus)`, rows });
  }
  return sections;
}
