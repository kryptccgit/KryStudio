let lastMs = 0;
let seq = 0;

function randomChars(n: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % 36];
  return out;
}

export function newId(prefix: string): string {
  const now = Date.now();
  if (now === lastMs) seq++;
  else {
    lastMs = now;
    seq = 0;
  }
  return `${prefix}_${now.toString(36)}${seq.toString(36)}${randomChars(5)}`;
}

export const ID_PREFIX = {
  channel: 'ch',
  pattern: 'pat',
  note: 'n',
  clip: 'clip',
  track: 'trk',
  insert: 'ins',
  slot: 'fx',
  sample: 'smp',
  automation: 'aut',
  point: 'pt',
  marker: 'mk',
  project: 'prj',
} as const;
