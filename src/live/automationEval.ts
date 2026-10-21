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

export function isAutomated(p: Project, ref: string): boolean {
  return index(p).has(ref);
}

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
