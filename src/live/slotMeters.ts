import type { SlotScopeData, TelemetryFrame } from '@shared/engine/protocol';

export const GR_RANGE_DB = 24;

export function grToMeter(db: number, range = GR_RANGE_DB): number {
  if (!Number.isFinite(db) || db <= 0 || range <= 0) return 0;
  return Math.min(1, db / range);
}

export function formatGr(db: number): string {
  return db >= 0.05 ? `-${db.toFixed(1)}` : '0.0';
}

export function formatLevel(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-inf' : v.toFixed(digits);
}

interface GrState {
  target: number;
  shown: number;
  hold: number;
  holdAt: number;
  readAt: number;
}

export class GrBallistics {
  private s = new Map<string, GrState>();
  constructor(
    private fallDbPerSec = 40,
    private holdMs = 1500,
  ) {}

  ingest(gr: Record<string, number> | undefined, now: number): void {
    for (const st of this.s.values()) st.target = 0;
    if (!gr) return;
    for (const [key, raw] of Object.entries(gr)) {
      const db = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const st = this.s.get(key) ?? { target: 0, shown: 0, hold: 0, holdAt: 0, readAt: now };
      st.target = db;
      if (db >= st.hold || now - st.holdAt > this.holdMs) {
        st.hold = db;
        st.holdAt = now;
      }
      this.s.set(key, st);
    }
  }

  read(key: string, now: number): [number, number] {
    const st = this.s.get(key);
    if (!st) return [0, 0];
    const dtSec = Math.max(0, Math.min(0.25, (now - st.readAt) / 1000));
    st.readAt = now;
    st.shown = st.target >= st.shown ? st.target : Math.max(st.target, st.shown - this.fallDbPerSec * dtSec);
    if (now - st.holdAt > this.holdMs) {
      st.hold = st.shown;
      st.holdAt = now;
    }
    return [st.shown, Math.max(st.hold, st.shown)];
  }
}

export class SpectrumSmoother {
  shown: Float32Array = new Float32Array(0);
  peak: Float32Array = new Float32Array(0);
  private peakAt: Float64Array = new Float64Array(0);
  constructor(
    private fallDbPerSec = 30,
    private holdMs = 1200,
    private floorDb = -100,
  ) {}

  reset(): void {
    this.shown = new Float32Array(0);
    this.peak = new Float32Array(0);
    this.peakAt = new Float64Array(0);
  }

  push(bins: readonly number[], now: number): void {
    if (this.shown.length !== bins.length) {
      this.shown = new Float32Array(bins.length).fill(this.floorDb);
      this.peak = new Float32Array(bins.length).fill(this.floorDb);
      this.peakAt = new Float64Array(bins.length);
    }
    for (let i = 0; i < bins.length; i++) {
      const v = Number.isFinite(bins[i]) ? Math.max(this.floorDb, bins[i]) : this.floorDb;
      if (v >= this.shown[i]) this.shown[i] = v;
      if (v >= this.peak[i]) {
        this.peak[i] = v;
        this.peakAt[i] = now;
      }
    }
  }

  decay(dtSec: number, now: number): void {
    const d = this.fallDbPerSec * dtSec;
    for (let i = 0; i < this.shown.length; i++) {
      this.shown[i] = Math.max(this.floorDb, this.shown[i] - d);
      if (now - this.peakAt[i] > this.holdMs) this.peak[i] = Math.max(this.shown[i], this.peak[i] - d);
    }
  }
}

export function readSlotScope(frame: TelemetryFrame | null | undefined, key: string): SlotScopeData | null {
  const d = frame?.scopes?.[key];
  if (!d || typeof d !== 'object') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const arr = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : undefined);
  return {
    lufsM: num(d.lufsM),
    lufsS: num(d.lufsS),
    lufsI: num(d.lufsI),
    truePeak: num(d.truePeak),
    correlation: num(d.correlation),
    spectrum: arr(d.spectrum),
    scope: arr(d.scope),
  };
}

export function watchSet(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n > 0)
    .map(([k]) => k)
    .sort();
}
