// ──────────────────────────────────────────────────────────────────────
// Meters and scopes (docs/ENGINE_PROTOCOL.md §15): which stock effects
// report gain reduction, the "insertId/slotId" key the engine uses, and
// the frequency grid of a watched slot's spectrum. Pure; used by the
// renderer (GR bars, Krypt EQ / Analyzer windows) and MCP (render_preview).
// ──────────────────────────────────────────────────────────────────────

/** Stock effects with a gain-reduction meter → the meter's short label. */
export const GR_PLUGINS: Readonly<Record<string, string>> = {
  'krypt.comp': 'GR',
  'krypt.glue': 'GR',
  'krypt.deesser': 'GR',
  'krypt.limiter': 'GR',
  'krypt.squash': 'GR',
  'krypt.duck': 'Duck',
  'krypt.gate': 'Gate',
  'krypt.clipper': 'Clip',
};

export function hasGrMeter(pluginType: string): boolean {
  return Object.prototype.hasOwnProperty.call(GR_PLUGINS, pluginType);
}

/** The engine's key for an FX slot in `TelemetryFrame.gr` / `.scopes` and watch requests. */
export function slotKey(insertId: string, slotId: string): string {
  return `${insertId}/${slotId}`;
}

/** Slots the engine computes scopes for at once (all windows together). */
export const MAX_WATCHED_SLOTS = 4;

/** `SlotScopeData.spectrum`: SCOPE_BINS log-spaced bins from SCOPE_MIN_HZ to SCOPE_MAX_HZ. */
export const SCOPE_BINS = 96;
export const SCOPE_MIN_HZ = 20;
export const SCOPE_MAX_HZ = 20000;

/** Geometric centre frequency of spectrum bin `i`. */
export function scopeBinHz(i: number, bins = SCOPE_BINS): number {
  const r = SCOPE_MAX_HZ / SCOPE_MIN_HZ;
  return SCOPE_MIN_HZ * Math.pow(r, (i + 0.5) / bins);
}
