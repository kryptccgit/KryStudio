import type { GenreId } from '../../genres';
import type { InstrumentPreset } from '../../types';
import { GENRE_DEFAULTS } from './defaults';
import { LEAD_PRESETS } from './leads';
import { PLUCK_PRESETS } from './plucks';
import { PAD_PRESETS } from './pads';
import { KEYS_PRESETS } from './keys';
import { BELL_PRESETS } from './bells';
import { ARP_PRESETS } from './arps';
import { STAB_PRESETS, CHORD_PRESETS } from './chords';
import { STRINGS_PRESETS, BRASS_PRESETS, VOX_PRESETS } from './orchestral';
import { BASS_PRESETS, SUB_PRESETS } from './bass';
import { EIGHT08_PRESETS } from './eights';
import { DRUM_PRESETS } from './drums';
import { FX_PRESETS, TEXTURE_PRESETS } from './fx';
import { PACK_PRESETS } from './packs';
import { TRIOSC_LFO_PRESETS } from './trioscLfo';

const ALL: InstrumentPreset[] = [
  ...LEAD_PRESETS,
  ...PLUCK_PRESETS,
  ...PAD_PRESETS,
  ...KEYS_PRESETS,
  ...BELL_PRESETS,
  ...ARP_PRESETS,
  ...STAB_PRESETS,
  ...CHORD_PRESETS,
  ...STRINGS_PRESETS,
  ...BRASS_PRESETS,
  ...VOX_PRESETS,
  ...BASS_PRESETS,
  ...SUB_PRESETS,
  ...EIGHT08_PRESETS,
  ...DRUM_PRESETS,
  ...FX_PRESETS,
  ...TEXTURE_PRESETS,
  ...TRIOSC_LFO_PRESETS,
  ...PACK_PRESETS,
];

function defaultsById(): Map<string, GenreId[]> {
  const out = new Map<string, GenreId[]>();
  for (const [genre, roles] of Object.entries(GENRE_DEFAULTS) as [GenreId, Record<string, string>][]) {
    for (const [role, slug] of Object.entries(roles)) {
      const id = `factory:${role}/${slug}`;
      out.set(id, [...(out.get(id) ?? []), genre]);
    }
  }
  return out;
}

const DEFAULTS = defaultsById();

export const INSTRUMENT_PRESETS: readonly InstrumentPreset[] = ALL.map((p) => {
  const d = DEFAULTS.get(p.id);
  return d ? { ...p, defaultFor: d } : p;
});
