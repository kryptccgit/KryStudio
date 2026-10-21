// Discord presence must never crash the app: closing a discord-rpc client
// whose IPC connection never opened used to leak
//   unhandledRejection: TypeError: Cannot read properties of null (reading 'write')
//   at IPCTransport.send … RPCClient.destroy … startSessionSync
// (destroy() is async; transport.close() writes to a null socket inside its own
// promise). closeRpcClient (electron/system/session-sync.ts) never lets that out.
import assert from 'node:assert/strict';
import RPC from 'discord-rpc';
import { test, run } from './harness';
import { closeRpcClient, type RpcClientLike } from '../electron/system/session-sync';

const leaked: unknown[] = [];
process.on('unhandledRejection', (reason) => leaked.push(reason));
const settle = () => new Promise((r) => setTimeout(r, 60));

test('the bug, reproduced: destroy() of a client that never connected rejects inside discord-rpc', async () => {
  const c = new RPC.Client({ transport: 'ipc' });
  await assert.rejects(c.destroy(), /Cannot read properties of null \(reading 'write'\)/);
});

test('closeRpcClient: a client that never connected closes quietly (no unhandled rejection)', async () => {
  const c = new RPC.Client({ transport: 'ipc' });
  await closeRpcClient(c as unknown as RpcClientLike);
  await closeRpcClient(c as unknown as RpcClientLike, { clear: true });
  await closeRpcClient(null);
  await settle();
  assert.deepEqual(leaked, []);
});

test('closeRpcClient: a connected client whose destroy / clearActivity fail, or never settle, still closes', async () => {
  let destroyed = 0;
  const socket = { destroy: () => void destroyed++ };
  const rejecting: RpcClientLike = {
    transport: { socket },
    clearActivity: () => {
      throw new Error('sync throw');
    },
    destroy: () => Promise.reject(new TypeError("Cannot read properties of null (reading 'write')")),
  };
  await closeRpcClient(rejecting, { clear: true });
  const hanging: RpcClientLike = { transport: { socket }, clearActivity: () => new Promise(() => {}), destroy: () => new Promise(() => {}) };
  const t0 = Date.now();
  const keepAlive = setInterval(() => {}, 1000); // closeRpcClient's timers are unref'd (they never hold the app open)
  await closeRpcClient(hanging, { clear: true, timeoutMs: 40 });
  clearInterval(keepAlive);
  assert.ok(Date.now() - t0 < 1000, 'bounded wait');
  assert.equal(destroyed, 2, 'the socket is destroyed either way');
  await settle();
  assert.deepEqual(leaked, []);
});

await run('discord presence');
