// ──────────────────────────────────────────────────────────────────────
// Runtime client context (lightweight anti-rebrand, kryptguidelines §9).
//
// The strings a rebrander wants to strip (product name, Discord application
// id, official URLs) are not stored as clean literals: they're XOR+base64
// encoded and rebuilt at runtime. The SAME resolved context feeds the window
// title, the startup log line, the presence module and the external-link
// guard, so ripping it out degrades the app instead of cleanly deleting one
// file.
//
// [PROTECTION] Soft integrity (§9.4): the decoded identity must match a
// sealed fingerprint, and the host app name (package.json productName) must
// match the embedded product name. On a mismatch nothing crashes and nothing
// says "tamper": the context comes back degraded (generic name, no presence,
// no official links) and every music feature keeps working.
// Friction, not war. KRYPT_STUDIO_DEBUG=1 disables all of it (always intact).
// ──────────────────────────────────────────────────────────────────────

const K = 0x5a;

function dec(b64: string): string {
  try {
    const raw = Buffer.from(b64, 'base64');
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ K;
    return out.toString('utf8');
  } catch {
    return '';
  }
}

const P = {
  n: 'ESgjKi56CS4vPjM1',
  c: 'a25jb2loaWNrYmhpbm5oaW5qbA==',
  s: 'Mi4uKilgdXUxKCMqLnQ5OQ==',
  t: 'Mi4uKilgdXUxKCMqLnQ5OXUuNTU2KQ==',
  d: 'Mi4uKilgdXU+Myk5NSg+dD09dTcvIBwRCGxvbRw=',
  h: 'Mi4uKilgdXUxKCMqLnQ5OXUuNTU2KXUpLi8+MzU=',
};

// [PROTECTION] Layout revision: the FNV-1a seal of the decoded payloads above
// (joined with "|"). Doubles as the provenance watermark (§9.6). Re-seal when
// a payload legitimately changes: fingerprint(Object.values(P).map(dec).join('|')).
const LAYOUT_REV = [0xe85c, 0xaddb] as const;

export interface ClientContext {
  productName: string;
  clientId: string;
  siteUrl: string;
  toolsUrl: string;
  discordUrl: string;
  homeUrl: string;
  /** False when the identity was tampered with: callers run degraded. */
  intact: boolean;
  /** Harmless build watermark derived from the product name (§9.6). */
  mark: number;
}

let cached: ClientContext | null = null;

export function isDebug(): boolean {
  return process.env.KRYPT_STUDIO_DEBUG === '1';
}

function fingerprint(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * The host's app name (package.json productName), or null outside Electron
 * (unit tests import this module under plain Node, where there is no app).
 */
function hostLabel(): string | null {
  try {
    if (!process.versions.electron) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const n = app?.getName?.();
    return typeof n === 'string' && n ? n : null;
  } catch {
    return null;
  }
}

/** Resolve the decoded runtime context (memoized). */
export function resolveClientContext(): ClientContext {
  if (cached) return cached;
  const v = { n: dec(P.n), c: dec(P.c), s: dec(P.s), t: dec(P.t), d: dec(P.d), h: dec(P.h) };
  const seal = ((LAYOUT_REV[0] << 16) | LAYOUT_REV[1]) >>> 0;
  const sealed = fingerprint([v.n, v.c, v.s, v.t, v.d, v.h].join('|')) === seal && /^[0-9]{17,20}$/.test(v.c);
  const host = hostLabel();
  const coupled = host === null || host === v.n;
  const intact = isDebug() || (sealed && coupled);
  const mark = fingerprint(v.n) % 9973;
  cached = intact
    ? { productName: v.n || 'Studio', clientId: v.c, siteUrl: v.s, toolsUrl: v.t, discordUrl: v.d, homeUrl: v.h, intact: true, mark }
    : { productName: 'Studio', clientId: '', siteUrl: '', toolsUrl: '', discordUrl: '', homeUrl: '', intact: false, mark };
  return cached;
}

/**
 * True if `url` points at an official Krypt destination (site or community
 * invite). Used to drop official links in a degraded (rebranded) build.
 */
export function isOfficialDestination(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const own = [dec(P.s), dec(P.d)].map((u) => {
      try {
        return new URL(u).hostname.toLowerCase();
      } catch {
        return '';
      }
    });
    return own.some((h) => h && (host === h || host.endsWith(`.${h}`)));
  } catch {
    return false;
  }
}
