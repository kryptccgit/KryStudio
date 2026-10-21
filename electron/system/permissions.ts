// Web MIDI stays OFF in every renderer (research/06 §6.3, research/07 §2.3).
// The engine owns MIDI devices: on Windows 10 WinMM ports are single-client,
// so a renderer calling navigator.requestMIDIAccess() would grab the ports
// and the engine could no longer open them. Electron grants permissions by
// default, so deny `midi` / `midiSysex` in BOTH the request and the check
// handler (Electron's docs say both are needed). Other permissions keep
// Electron's default behaviour (allowed).

import type { Session } from 'electron';

const DENIED = new Set(['midi', 'midiSysex']);

export function isDeniedPermission(permission: string): boolean {
  return DENIED.has(permission);
}

export function denyWebMidi(session: Session): void {
  session.setPermissionRequestHandler((_wc, permission, callback) => callback(!isDeniedPermission(permission)));
  session.setPermissionCheckHandler((_wc, permission) => !isDeniedPermission(permission));
}
