// Keeps the live keymap = FL defaults ⊕ the user's overrides from settings
// (Settings → Shortcuts). Installed once at boot (registerAppCommands).

import { useSettings } from '../state/status';
import { DEFAULT_KEYMAP, applyKeymapOverrides, setKeymap } from './keymap';

let installed = false;
let applied: unknown = Symbol('none');

function apply(overrides: Record<string, string[]> | undefined): void {
  if (overrides === applied) return;
  applied = overrides;
  setKeymap(applyKeymapOverrides(DEFAULT_KEYMAP, overrides));
}

export function installKeymapSync(): void {
  if (installed) return;
  installed = true;
  apply(useSettings.getState().settings?.keymap);
  useSettings.subscribe((s) => apply(s.settings?.keymap));
}
