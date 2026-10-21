import { noteName as theoryNoteName } from '@shared/music/theory';
import { effectiveChannelId, getUi } from '../state/ui';
import { flashHint } from '../app/hints';

const LOWER: Array<[string, number]> = [
  ['KeyZ', 0], ['KeyS', 1], ['KeyX', 2], ['KeyD', 3], ['KeyC', 4], ['KeyV', 5], ['KeyG', 6], ['KeyB', 7],
  ['KeyH', 8], ['KeyN', 9], ['KeyJ', 10], ['KeyM', 11], ['Comma', 12], ['Period', 14], ['Semicolon', 15], ['Slash', 16],
];
const UPPER: Array<[string, number]> = [
  ['KeyQ', 12], ['Digit2', 13], ['KeyW', 14], ['Digit3', 15], ['KeyE', 16], ['KeyR', 17], ['Digit5', 18], ['KeyT', 19],
  ['Digit6', 20], ['KeyY', 21], ['Digit7', 22], ['KeyU', 23], ['KeyI', 24], ['Digit9', 25], ['KeyO', 26], ['Digit0', 27],
  ['KeyP', 28], ['BracketLeft', 29], ['Equal', 30], ['BracketRight', 31],
];

export const PIANO_MAP: ReadonlyMap<string, number> = new Map([...LOWER, ...UPPER]);

export function noteName(key: number): string {
  return theoryNoteName(key);
}

const held = new Map<string, { channelId: string; key: number }>();
const listeners = new Set<() => void>();

export function heldKeys(): number[] {
  return [...held.values()].map((h) => h.key);
}

export function onPianoChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function changed(): void {
  for (const fn of listeners) fn();
}

export function pianoKeyDown(e: KeyboardEvent): boolean {
  const ui = getUi();
  if (!ui.typingPiano || e.ctrlKey || e.altKey || e.metaKey) return false;
  const offset = PIANO_MAP.get(e.code);
  if (offset === undefined) return false;
  e.preventDefault();
  if (e.repeat || held.has(e.code)) return true;
  const channelId = effectiveChannelId();
  if (!channelId) {
    flashHint('Add a channel to play it from the keyboard', 'warn');
    return true;
  }
  const key = Math.max(0, Math.min(127, ui.typingBaseKey + offset));
  const vel = e.shiftKey ? 1 : ui.typingVelocity;
  held.set(e.code, { channelId, key });
  try {
    window.krypt.engine.audition(channelId, key, vel, true);
  } catch {
  }
  flashHint(`Note ${noteName(key)}  ·  vel ${Math.round(vel * 100)}%`, 'info', 900);
  changed();
  return true;
}

export function pianoKeyUp(e: KeyboardEvent): boolean {
  const h = held.get(e.code);
  if (!h) return false;
  held.delete(e.code);
  try {
    window.krypt.engine.audition(h.channelId, h.key, 0, false);
  } catch {
  }
  changed();
  return true;
}

export function pianoAllOff(): void {
  if (held.size === 0) return;
  for (const h of held.values()) {
    try {
      window.krypt.engine.audition(h.channelId, h.key, 0, false);
    } catch {
    }
  }
  held.clear();
  try {
    window.krypt.engine.auditionOff();
  } catch {
  }
  changed();
}
