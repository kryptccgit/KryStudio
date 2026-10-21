// ──────────────────────────────────────────────────────────────────────
// Live launcher state for the Session view, from TelemetryFrame.launcher.
// Telemetry arrives ~60×/s; the discrete part (playing / queued /
// overridden / recording) goes into a tiny zustand store only when it
// CHANGES (liveSignature), so slots re-render on launches, not per frame.
// Loop progress never touches React: slots register their progress bar and
// one frame-loop subscriber writes the widths (like the mixer's MeterBank).
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { LauncherTelemetry } from '@shared/engine/protocol';
import { telemetry } from '../../live/telemetry';
import { onFrame } from '../../render/frameLoop';
import { clipProgress, liveSignature } from './model';

export interface LauncherLive {
  playing: Record<string, string>;
  queued: Record<string, string>;
  overridden: Record<string, true>;
  anyOverridden: boolean;
  /** Engine-reported launch recording (the toolbar button also follows session.onRecordState). */
  recording: boolean;
}

const EMPTY: LauncherLive = { playing: {}, queued: {}, overridden: {}, anyOverridden: false, recording: false };

export const useLauncherLive = create<LauncherLive>(() => EMPTY);

let lastSig = '';

function ingest(l: LauncherTelemetry | undefined | null): void {
  const sig = liveSignature(l);
  if (sig === lastSig) return;
  lastSig = sig;
  if (!l) {
    useLauncherLive.setState(EMPTY, true);
    return;
  }
  const overridden: Record<string, true> = {};
  for (const t of l.overridden) overridden[t] = true;
  useLauncherLive.setState({ playing: { ...l.playing }, queued: { ...l.queued }, overridden, anyOverridden: l.overridden.length > 0, recording: !!l.recording }, true);
}

// ── Progress bars (imperative) ───────────────────────────────────────

const bars = new Map<HTMLElement, string>();
let users = 0;
let offTelemetry: (() => void) | null = null;
let offFrame: (() => void) | null = null;
const lastWidth = new WeakMap<HTMLElement, number>();

function drawProgress(): void {
  const l = telemetry.connected ? telemetry.frame?.launcher : undefined;
  for (const [el, clipId] of bars) {
    const p = clipProgress(clipId, l);
    const w = p === null ? -1 : Math.round(p * 1000);
    if (lastWidth.get(el) === w) continue;
    lastWidth.set(el, w);
    if (w < 0) el.style.opacity = '0';
    else {
      el.style.opacity = '1';
      el.style.transform = `scaleX(${w / 1000})`;
    }
  }
}

/** Register a slot's progress element (transform-origin left; scaled 0..1). Returns the unregister function. */
export function trackProgress(el: HTMLElement, clipId: string): () => void {
  bars.set(el, clipId);
  lastWidth.delete(el);
  return () => {
    bars.delete(el);
  };
}

/** Start following telemetry while at least one Session view is mounted (ref-counted). */
export function retainLauncherLive(): () => void {
  users++;
  if (users === 1) {
    lastSig = '\u0000';
    ingest(telemetry.connected ? telemetry.frame?.launcher : undefined);
    offTelemetry = telemetry.subscribe((f) => ingest(f.launcher));
    // A dropped connection sends no frame: clear stale "playing" lights from the frame loop too.
    offFrame = onFrame(() => {
      if (!telemetry.connected && lastSig !== '') ingest(undefined);
      drawProgress();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    if (users === 0) {
      offTelemetry?.();
      offFrame?.();
      offTelemetry = null;
      offFrame = null;
    }
  };
}
