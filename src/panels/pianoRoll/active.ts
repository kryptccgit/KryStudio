// The piano roll that keyboard commands and menus act on (the panel is a
// singleton, but it can be re-mounted or popped out). Kept tiny so the app
// command registry can import it without pulling in the editor.

import type { PianoRollController } from './controller';

let active: PianoRollController | null = null;

export function setActivePianoRoll(c: PianoRollController | null): void {
  active = c;
}

export function getActivePianoRoll(): PianoRollController | null {
  return active;
}
