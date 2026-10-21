import type { SlotScopeData, TelemetryFrame, TelemetryWatch } from '@shared/engine/protocol';
import { PPQ } from '@shared/schema/time';
import { GrBallistics, readSlotScope, watchSet } from './slotMeters';

type Listener = (f: TelemetryFrame) => void;

let ws: WebSocket | null = null;
let last: TelemetryFrame | null = null;
let lastAt = 0;
let connected = false;
const listeners = new Set<Listener>();
const meterState = new Map<string, { l: number; r: number; holdL: number; holdR: number; holdAt: number }>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
const grState = new GrBallistics();
const watchCounts = new Map<string, number>();

function sendWatch(reset?: string[]): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const msg: TelemetryWatch = { t: 'watch', slots: watchSet(watchCounts), ...(reset?.length ? { reset } : {}) };
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function scheduleReconnect(): void {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectTelemetry();
  }, 1000);
}

export async function connectTelemetry(): Promise<void> {
  stopped = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let url: string | null = null;
  try {
    url = await window.krypt.engine.telemetryUrl();
  } catch {
    url = null;
  }
  if (!url) {
    scheduleReconnect();
    return;
  }
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    connected = true;
    sendWatch();
  };
  sock.onmessage = (ev) => {
    try {
      const f = JSON.parse(String(ev.data)) as TelemetryFrame;
      if (f.t !== 'frame') return;
      last = f;
      lastAt = performance.now();
      ingestMeters(f);
      grState.ingest(f.gr, lastAt);
      for (const fn of listeners) fn(f);
    } catch {
    }
  };
  sock.onclose = () => {
    connected = false;
    if (ws === sock) ws = null;
    scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

export function disconnectTelemetry(): void {
  stopped = true;
  ws?.close();
  ws = null;
}

function ingestMeters(f: TelemetryFrame): void {
  const now = performance.now();
  for (const [id, [l, r]] of Object.entries(f.meters)) {
    const m = meterState.get(id) ?? { l: 0, r: 0, holdL: 0, holdR: 0, holdAt: 0 };
    m.l = Math.max(l, m.l);
    m.r = Math.max(r, m.r);
    if (l >= m.holdL || r >= m.holdR || now - m.holdAt > 1500) {
      m.holdL = Math.max(l, now - m.holdAt > 1500 ? 0 : m.holdL);
      m.holdR = Math.max(r, now - m.holdAt > 1500 ? 0 : m.holdR);
      m.holdAt = now;
    }
    meterState.set(id, m);
  }
}

export const telemetry = {
  get connected(): boolean {
    return connected;
  },
  get frame(): TelemetryFrame | null {
    return last;
  },
  get playing(): boolean {
    return !!last?.playing;
  },
  playheadTick(): number {
    if (!last) return 0;
    if (!last.playing) return last.tick;
    const dtSec = Math.min(0.25, (performance.now() - lastAt) / 1000);
    return last.tick + (dtSec * last.bpm * PPQ) / 60;
  },
  meter(insertId: string, dtSec: number): [number, number, number, number] {
    const m = meterState.get(insertId);
    if (!m) return [0, 0, 0, 0];
    const out: [number, number, number, number] = [m.l, m.r, m.holdL, m.holdR];
    const decay = Math.pow(10, (-24 * dtSec) / 20);
    m.l *= decay;
    m.r *= decay;
    return out;
  },
  gr(slotKey: string): [number, number] {
    return grState.read(slotKey, performance.now());
  },
  scope(slotKey: string): SlotScopeData | null {
    return readSlotScope(last, slotKey);
  },
  watchSlot(slotKey: string): () => void {
    watchCounts.set(slotKey, (watchCounts.get(slotKey) ?? 0) + 1);
    sendWatch();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (watchCounts.get(slotKey) ?? 1) - 1;
      if (n > 0) watchCounts.set(slotKey, n);
      else watchCounts.delete(slotKey);
      sendWatch();
    };
  },
  resetSlot(slotKey: string): boolean {
    return sendWatch([slotKey]);
  },
  channelActivity(channelId: string): number {
    return last?.channels[channelId] ?? 0;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
