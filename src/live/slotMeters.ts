// ──────────────────────────────────────────────────────────────────────
// Pure display logic for the per-slot meters (docs/ENGINE_PROTOCOL.md §15):
// gain-reduction ballistics + scaling, spectrum smoothing with peak hold,
// and reading a watched slot out of a TelemetryFrame. No DOM, no window:
// unit-tested in test/meters.test.ts; src/live/telemetry.ts feeds it.
// ──────────────────────────────────────────────────────────────────────

import type { SlotScopeData, TelemetryFrame } from '@shared/engine/protocol';

/** Full scale of the GR bars (dB). */
export const GR_RANGE_DB = 24;

/** Gain reduction (dB, >= 0) → bar length 0..1 on a dB-linear scale up to `range`. */
export function grToMeter(db: number, range = GR_RANGE_DB): number {
  if (!Number.isFinite(db) || db <= 0 || range <= 0) return 0;
  return Math.min(1, db / range);
}

/** "-4.2" style readout (blank under 0.1 dB). */
export function formatGr(db: number): string {
  return db >= 0.05 ? `-${db.toFixed(1)}` : '0.0';
}

/** LUFS / dBTP / dB readout; null / -inf → '-inf'. */
export function formatLevel(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-inf' : v.toFixed(digits);
}

interface GrState {
  target: number;
  shown: number;
  hold: number;
  holdAt: number;
  /** When `read` last advanced (several views may read the same slot in one frame). */
  readAt: number;
}

/**
 * Gain-reduction ballistics per slot key. `ingest` takes each frame's `gr` map (absent keys = 0 dB);
 * `read` rises instantly, falls at `fallDbPerSec`, and holds the peak for `holdMs`. Time-based, so
 * any number of meters can read the same slot each frame.
 */
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

  /** [shown dB, held peak dB] at `now` (ms). */
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

/**
 * Spectrum display smoothing: each bin rises at once and falls at `fallDbPerSec`; a peak line holds
 * for `holdMs` and then falls at the same rate.
 */
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

  /** New bins (dB) arrived. */
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

  /** Let bins and expired peaks fall (call once per drawn frame). */
  decay(dtSec: number, now: number): void {
    const d = this.fallDbPerSec * dtSec;
    for (let i = 0; i < this.shown.length; i++) {
      this.shown[i] = Math.max(this.floorDb, this.shown[i] - d);
      if (now - this.peakAt[i] > this.holdMs) this.peak[i] = Math.max(this.shown[i], this.peak[i] - d);
    }
  }
}

/** A watched slot's latest data from a frame (null when the frame has none for it). */
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

/** Keys to send in a watch request: every key with a positive count, sorted. */
export function watchSet(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n > 0)
    .map(([k]) => k)
    .sort();
}
