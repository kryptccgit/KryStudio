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

export function slotKey(insertId: string, slotId: string): string {
  return `${insertId}/${slotId}`;
}

export const MAX_WATCHED_SLOTS = 4;

export const SCOPE_BINS = 96;
export const SCOPE_MIN_HZ = 20;
export const SCOPE_MAX_HZ = 20000;

export function scopeBinHz(i: number, bins = SCOPE_BINS): number {
  const r = SCOPE_MAX_HZ / SCOPE_MIN_HZ;
  return SCOPE_MIN_HZ * Math.pow(r, (i + 0.5) / bins);
}
