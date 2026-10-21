// Pure part of "knobs follow automation" (no store / telemetry imports, so
// node tests can use it). Mirrors the engine's rules (docs/ENGINE_PROTOCOL.md
// §4 "Automation clips"):
//   - muted clips, muted tracks and (when any track is soloed) non-soloed
//     tracks don't drive anything
//   - inside a clip: evaluate the curve at songTick - clip.start + clip.offset
//   - after a clip ends its last value holds (the most recently ended clip)

import type { AutomationPoint, Project } from '@shared/schema/project';
import { evalAutomation, sortPoints } from '@shared/schema/automation';

interface AutoClip {
  start: number;
  end: number;
  offset: number;
  points: AutomationPoint[];
}

let builtFor: Project | null = null;
let byRef = new Map<string, AutoClip[]>();

function index(p: Project): Map<string, AutoClip[]> {
  if (p === builtFor) return byRef;
  const m = new Map<string, AutoClip[]>();
  const tracks = p.playlist.tracks;
  const anySolo = Object.values(tracks).some((t) => t.solo);
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'automation' || !c.automationId || c.mute) continue;
    const t = tracks[c.trackId];
    if (!t || t.mute || (anySolo && !t.solo)) continue;
    const aut = p.automations[c.automationId];
    if (!aut?.target) continue;
    const points = sortPoints(aut.points);
    if (!points.length) continue;
    const list = m.get(aut.target) ?? [];
    list.push({ start: c.start, end: c.start + c.length, offset: c.offset, points });
    m.set(aut.target, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.start - b.start);
  builtFor = p;
  byRef = m;
  return m;
}

/** True if any playing automation clip targets this ParamRef. */
export function isAutomated(p: Project, ref: string): boolean {
  return index(p).has(ref);
}

/** Normalized 0..1 automation value at a song tick, or null before any clip has played. */
export function automationValueAt(p: Project, ref: string, tick: number): number | null {
  const clips = index(p).get(ref);
  if (!clips) return null;
  let held: number | null = null;
  let heldEnd = -Infinity;
  for (const c of clips) {
    if (tick >= c.start && tick < c.end) return evalAutomation(c.points, tick - c.start + c.offset);
    if (c.end <= tick && c.end > heldEnd) {
      heldEnd = c.end;
      held = evalAutomation(c.points, c.end - c.start + c.offset);
    }
  }
  return held;
}
