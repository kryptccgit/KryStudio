// ──────────────────────────────────────────────────────────────────────
// Transport state for the UI (NON-React, read from frameLoop subscribers).
// With the engine running this is just telemetry. When no telemetry flows
// (browser mock, engine down but transport accepted) it simulates the
// playhead from the transport result so the UI still behaves.
//
//   playState.playing()      → boolean
//   playState.tick()         → song tick (song mode) or pattern-loop tick
//   await transport('toggle')
// ──────────────────────────────────────────────────────────────────────

import { telemetry } from './telemetry';
import { getProject } from '../doc/store';
import { PPQ } from '@shared/schema/time';
import { patternLength } from '@shared/schema/project';
import type { ActionResult } from '@shared/types';

let simPlaying = false;
let simStartPerf = 0;
let simFromTick = 0;
const listeners = new Set<(playing: boolean) => void>();
let lastPlaying = false;

function live(): boolean {
  return telemetry.connected && !!telemetry.frame;
}

function simTick(): number {
  if (!simPlaying) return simFromTick;
  const p = getProject();
  const bpm = p?.transport.bpm ?? 140;
  return simFromTick + ((performance.now() - simStartPerf) / 1000) * ((bpm * PPQ) / 60);
}

function notify(): void {
  const now = playState.playing();
  if (now !== lastPlaying) {
    lastPlaying = now;
    for (const fn of listeners) fn(now);
  }
}

export const playState = {
  playing(): boolean {
    return live() ? telemetry.playing : simPlaying;
  },
  /** Raw position in ticks (song position or pattern position, as the engine reports it). */
  tick(): number {
    return live() ? telemetry.playheadTick() : simTick();
  },
  /** Position wrapped to the active pattern (pattern mode), for the step-grid playhead. */
  patternTick(): number | null {
    const p = getProject();
    if (!p || !this.playing()) return null;
    const pat = p.transport.activePatternId ? p.patterns[p.transport.activePatternId] : null;
    if (!pat) return null;
    if (live()) {
      const f = telemetry.frame!;
      if (f.mode !== 'pattern' || (f.patternId && f.patternId !== pat.id)) return null;
    } else if (p.transport.mode !== 'pattern') return null;
    const len = patternLength(pat, p.transport.timeSig);
    return len > 0 ? this.tick() % len : 0;
  },
  /** Subscribe to play/stop flips (cheap; driven by the frame loop + transport calls). */
  subscribe(fn: (playing: boolean) => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Poll for telemetry-driven flips (called by the transport bar's frame subscriber). */
  poll(): void {
    notify();
  },
};

/** Run a transport action with feedback-friendly result handling. */
export async function transport(action: 'play' | 'stop' | 'pause' | 'toggle'): Promise<ActionResult> {
  let r: ActionResult;
  try {
    r = await window.krypt.engine.transport(action);
  } catch (err) {
    r = { ok: false, message: (err as Error)?.message ?? String(err) };
  }
  if (r.ok && !live()) {
    const wasPlaying = simPlaying;
    const reported = (r.data as { playing?: boolean } | undefined)?.playing;
    const next = typeof reported === 'boolean' ? reported : action === 'toggle' ? !wasPlaying : action === 'play';
    if (action === 'stop') {
      simPlaying = false;
      simFromTick = 0;
    } else if (next && !wasPlaying) {
      simPlaying = true;
      simStartPerf = performance.now();
    } else if (!next && wasPlaying) {
      simFromTick = simTick();
      simPlaying = false;
      if (action === 'toggle') simFromTick = 0; // Space = stop & return, like FL
    }
  }
  notify();
  return r;
}

export function locateSim(tick: number): void {
  simFromTick = tick;
  simStartPerf = performance.now();
}
