import type { Session } from 'electron';

const DENIED = new Set(['midi', 'midiSysex']);

export function isDeniedPermission(permission: string): boolean {
  return DENIED.has(permission);
}

export function denyWebMidi(session: Session): void {
  session.setPermissionRequestHandler((_wc, permission, callback) => callback(!isDeniedPermission(permission)));
  session.setPermissionCheckHandler((_wc, permission) => !isDeniedPermission(permission));
}
