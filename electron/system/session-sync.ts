import RPC from 'discord-rpc';
import { resolveClientContext, isDebug } from './context';
import { logger } from './logger';

/**
 * Discord Rich Presence (kryptguidelines §8), best-effort and never
 * blocking: Discord may not be running, which is not an error. Always on.
 * The text is "Using Krypt Studio" over a live line ("Editing MySong",
 * "Playing MySong · AI agent") and
 * pushes are throttled (Discord rate-limits activity updates ~5 per 20 s).
 * Identity comes from the coupled runtime context; a tampered context means
 * we simply never connect (degraded, not crashing). Never throws.
 */

const ctx = resolveClientContext();

let client: RPC.Client | null = null;
let connected = false;
let wanted = false;
let connecting = false;
let startedAt = Date.now();
let current = { details: 'Starting up', state: 'Making music' };
let lastPushed = '';
let lastPushAt = 0;
let pushTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;

const MIN_INTERVAL_MS = 4000;
const RETRY_MS = 60_000;

export async function startSessionSync(): Promise<void> {
  if (!ctx.intact && !isDebug()) return;
  wanted = true;
  if (connected || connecting) return;
  connecting = true;
  let c: RPC.Client | null = null;
  try {
    const fresh = new RPC.Client({ transport: 'ipc' });
    c = fresh;
    client = fresh;
    fresh.on('ready', () => {
      if (client !== fresh) return; // a client stopSessionSync already dropped
      connected = true;
      lastPushed = '';
      schedulePush();
    });
    fresh.on('disconnected', () => {
      if (client !== fresh) return;
      connected = false;
      client = null;
      void closeRpcClient(fresh as unknown as RpcClientLike);
      scheduleRetry();
    });
    await fresh.login({ clientId: ctx.clientId });
  } catch (err) {
    logger.debug(`[session] presence unavailable: ${(err as Error)?.message ?? err}`);
    if (client === c) {
      connected = false;
      client = null;
    }
    void closeRpcClient(c as unknown as RpcClientLike | null);
    scheduleRetry();
  } finally {
    connecting = false;
  }
}

function scheduleRetry(): void {
  if (!wanted || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (wanted && !connected) void startSessionSync();
  }, RETRY_MS);
}

export function stopSessionSync(): void {
  wanted = false;
  if (pushTimer) clearTimeout(pushTimer);
  if (retryTimer) clearTimeout(retryTimer);
  pushTimer = retryTimer = null;
  const c = client;
  client = null;
  connected = false;
  void closeRpcClient(c as unknown as RpcClientLike | null, { clear: true });
}

/** The parts of discord-rpc's client that closing touches (its IPC transport keeps `socket` null until connected). */
export interface RpcClientLike {
  transport?: { socket?: { destroy?(): void } | null } | null;
  clearActivity?(): Promise<unknown>;
  destroy(): Promise<unknown>;
}

const CLOSE_TIMEOUT_MS = 2000;

/**
 * Close a presence client without ever leaking a rejection. discord-rpc's destroy() is async and calls
 * transport.close(), whose Promise executor writes to `this.socket`. When the connection never opened (Discord
 * isn't running) the socket is null, the write throws INSIDE that promise, and the rejection escaped as
 * `unhandledRejection: TypeError: Cannot read properties of null (reading 'write') at IPCTransport.send`.
 * A client that never connected has nothing to close. Otherwise destroy() is awaited, bounded (its close promise
 * waits for a 'close' event that may never come), and every failure is swallowed. Never throws, never rejects.
 */
export async function closeRpcClient(c: RpcClientLike | null | undefined, opts: { clear?: boolean; timeoutMs?: number } = {}): Promise<void> {
  if (!c) return;
  let socket: { destroy?(): void } | null | undefined;
  try {
    socket = c.transport?.socket;
  } catch {
    socket = null;
  }
  if (!socket) return; // never connected: destroy() would only throw inside its own promise
  const wait = opts.timeoutMs ?? CLOSE_TIMEOUT_MS;
  if (opts.clear && typeof c.clearActivity === 'function') await Promise.race([settle(() => c.clearActivity!()), delay(wait)]);
  await Promise.race([settle(() => c.destroy()), delay(wait)]);
  try {
    socket.destroy?.();
  } catch {
    /* already gone */
  }
}

/** Run fn and resolve when its promise settles, whatever happens (sync throws and rejections included). */
function settle(fn: () => Promise<unknown>): Promise<void> {
  try {
    return Promise.resolve(fn()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?(): void }).unref?.();
  });
}

/** Update the live text; pushed when connected, throttled. */
export function syncRuntimeState(details: string, state: string): void {
  current = { details: details.slice(0, 120), state: state.slice(0, 120) };
  schedulePush();
}

function schedulePush(): void {
  if (pushTimer) return;
  const wait = Math.max(0, lastPushAt + MIN_INTERVAL_MS - Date.now());
  pushTimer = setTimeout(() => {
    pushTimer = null;
    push();
  }, wait);
}

function push(): void {
  if (!connected || !client || !wanted) return;
  const key = `${current.details}|${current.state}`;
  if (key === lastPushed) return;
  lastPushed = key;
  lastPushAt = Date.now();
  client
    .setActivity({
      details: current.details,
      state: current.state,
      largeImageKey: 'krypt',
      largeImageText: ctx.productName,
      startTimestamp: startedAt,
      instance: false,
      buttons: [
        { label: 'Free Tools', url: ctx.toolsUrl },
        { label: 'Krypt.cc', url: ctx.discordUrl },
      ],
    })
    .catch(() => {
      lastPushed = '';
    });
}

export function resetSessionClock(): void {
  startedAt = Date.now();
}
