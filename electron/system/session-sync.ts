import RPC from 'discord-rpc';
import { resolveClientContext, isDebug } from './context';
import { logger } from './logger';

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
      if (client !== fresh) return;
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

export interface RpcClientLike {
  transport?: { socket?: { destroy?(): void } | null } | null;
  clearActivity?(): Promise<unknown>;
  destroy(): Promise<unknown>;
}

const CLOSE_TIMEOUT_MS = 2000;

export async function closeRpcClient(c: RpcClientLike | null | undefined, opts: { clear?: boolean; timeoutMs?: number } = {}): Promise<void> {
  if (!c) return;
  let socket: { destroy?(): void } | null | undefined;
  try {
    socket = c.transport?.socket;
  } catch {
    socket = null;
  }
  if (!socket) return;
  const wait = opts.timeoutMs ?? CLOSE_TIMEOUT_MS;
  if (opts.clear && typeof c.clearActivity === 'function') await Promise.race([settle(() => c.clearActivity!()), delay(wait)]);
  await Promise.race([settle(() => c.destroy()), delay(wait)]);
  try {
    socket.destroy?.();
  } catch {
  }
}

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
