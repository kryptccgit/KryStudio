// ──────────────────────────────────────────────────────────────────────
// Vocal Booth logic (pure; tested in test/booth.test.ts). The booth is the
// one-panel way to record a vocal: it sets up the Vocals track, plays the
// song from the playhead while you sing, and after each take offers
// Listen / Redo / Tune / Record more. The panel is ./VocalBooth.tsx, the
// session (arm, play, stop, find the take) is ./actions.ts.
// ──────────────────────────────────────────────────────────────────────

import { patternLength, type Project } from '@shared/schema/project';
import { ticksPerBar } from '@shared/schema/time';
import { trackIsFree } from '@shared/live/recording';

export type BoothPhase = 'ready' | 'starting' | 'countIn' | 'recording' | 'saving' | 'review';

/** How many bars "Loop my beat" fills. */
export const LOOP_BARS = 16;

/** A recorded take the booth is reviewing. */
export interface BoothTake {
  clipId: string;
  channelId: string;
  /** Timeline position and length, ticks. */
  start: number;
  length: number;
  seconds: number | null;
}

/** Nothing on the Playlist: in Song mode the singer would hear silence. */
export function songIsEmpty(p: Project): boolean {
  return !Object.values(p.playlist.clips).some((c) => c.kind === 'pattern' || c.kind === 'audio');
}

function noteCount(p: Project, patternId: string | null | undefined): number {
  const pat = patternId ? p.patterns[patternId] : undefined;
  if (!pat) return 0;
  return Object.values(pat.notes).reduce((n, byId) => n + Object.keys(byId).length, 0);
}

/** The pattern "Loop my beat" repeats: the active pattern when it has notes, else the first one that does. */
export function beatPattern(p: Project): string | null {
  if (noteCount(p, p.transport.activePatternId) > 0) return p.transport.activePatternId;
  return p.patternOrder.find((id) => noteCount(p, id) > 0) ?? null;
}

/**
 * The doc steps that repeat the beat pattern over the first `bars` bars, on the first track that is free there and
 * isn't the Vocals track (one dispatchBatch = one undo step). null = no pattern with notes, or no free track.
 */
export function loopBeatSteps(p: Project, bars = LOOP_BARS): Array<{ cmd: string; args: unknown }> | null {
  const patternId = beatPattern(p);
  if (!patternId) return null;
  const len = Math.max(1, patternLength(p.patterns[patternId], p.transport.timeSig));
  const end = bars * ticksPerBar(p.transport.timeSig);
  const trackId = p.playlist.trackOrder.find((id) => id !== p.recording?.trackId && trackIsFree(p, id, 0, end));
  if (!trackId) return null;
  const steps: Array<{ cmd: string; args: unknown }> = [];
  for (let start = 0; start < end; start += len) steps.push({ cmd: 'playlist.addClip', args: { kind: 'pattern', trackId, start, patternId, length: Math.min(len, end - start) } });
  return steps;
}

/** "bar 9" for a timeline tick (bars count from 1). */
export function barLabel(p: Project, tick: number): string {
  return `bar ${Math.floor(Math.max(0, tick) / ticksPerBar(p.transport.timeSig)) + 1}`;
}

/** The first bar line at or after `tick`: where "Record more" puts the playhead after a take. */
export function nextBarTick(p: Project, tick: number): number {
  const bar = ticksPerBar(p.transport.timeSig);
  return Math.ceil(Math.max(0, tick) / bar) * bar;
}

/** The booth's own track name for the "Records on …" line. */
export function targetTrackName(p: Project): string {
  const id = p.recording?.trackId;
  return (id && p.playlist.tracks[id]?.name) || 'a free track';
}

export function fmtTakeSeconds(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '';
  return sec < 60 ? `${sec.toFixed(1)} s` : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

/** What blocks recording right now, as a sentence; null = ready. */
export function boothBlocker(o: { engineRunning: boolean; inputOpen: boolean; inputMessage?: string | null }): string | null {
  if (!o.engineRunning) return 'The audio engine isn’t running. Check Settings ▸ Audio, or restart the engine.';
  if (!o.inputOpen) return `Your microphone isn’t open${o.inputMessage ? `: ${o.inputMessage}` : ''}. Pick it in Home ▸ Recording Studio.`;
  return null;
}

/**
 * The "Hear yourself" line, from the last ~1.5 s of telemetry.
 *  - monitorOn: the setting; running: the engine reports monitorPeak (on, and the rates match)
 *  - micPeak / monitorPeak: highest linear peaks over the window
 */
export function monitorStatus(o: { monitorOn: boolean; inputOpen: boolean; running: boolean; micPeak: number; monitorPeak: number; rateProblem: string | null }): { tone: 'off' | 'ok' | 'warn' | 'wait'; text: string } {
  if (!o.monitorOn) return { tone: 'off', text: 'Off: turn it on to hear your voice in your headphones.' };
  if (o.rateProblem) return { tone: 'warn', text: o.rateProblem };
  if (!o.inputOpen) return { tone: 'warn', text: 'On, but the microphone isn’t open.' };
  // An engine without monitorPeak (older build) can't tell: say it's on.
  if (!o.running) return { tone: 'ok', text: 'On: say something to hear yourself.' };
  if (o.monitorPeak > 1e-4) return { tone: 'ok', text: 'On: you’re in your headphones.' };
  if (o.micPeak > 0.003) return { tone: 'warn', text: 'On, but your voice isn’t reaching the output. Restart the engine (Settings ▸ Audio), then try again.' };
  return { tone: 'ok', text: 'On: say something to hear yourself.' };
}
