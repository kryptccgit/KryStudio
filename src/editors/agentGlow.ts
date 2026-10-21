// "Agent is editing" signature: entities an AI agent just changed glow with
// a purple outline that fades out. Detection is a cheap reference diff of the
// records the editor shows, run only when lastChange.actorKind === 'agent'.

export const GLOW_MS = 1600;

/** Ids added or replaced (new object reference) between two immutable records. */
export function changedIds<T>(prev: Record<string, T> | undefined, next: Record<string, T> | undefined): string[] {
  if (!next || prev === next) return [];
  const out: string[] = [];
  for (const id in next) if (!prev || prev[id] !== next[id]) out.push(id);
  return out;
}

export class GlowTracker {
  private until = new Map<string, number>();

  mark(ids: Iterable<string>, now: number, ms = GLOW_MS): void {
    for (const id of ids) this.until.set(id, now + ms);
  }

  /** 1 → 0 over the glow's lifetime; 0 if not glowing. */
  alpha(id: string, now: number, ms = GLOW_MS): number {
    const u = this.until.get(id);
    if (u === undefined) return 0;
    const left = u - now;
    return left > 0 ? Math.min(1, left / ms) : 0;
  }

  /** True while anything still glows (prunes finished entries). */
  active(now: number): boolean {
    for (const [id, u] of this.until) if (u <= now) this.until.delete(id);
    return this.until.size > 0;
  }

  get size(): number {
    return this.until.size;
  }
}
