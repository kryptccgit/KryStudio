import type { PianoRollController } from './controller';

let active: PianoRollController | null = null;

export function setActivePianoRoll(c: PianoRollController | null): void {
  active = c;
}

export function getActivePianoRoll(): PianoRollController | null {
  return active;
}
