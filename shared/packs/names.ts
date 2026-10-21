// Pack display names without the download manifests (shared/packs/catalog.ts is
// ~600 KB of file lists the renderer never needs). test/packs-catalog.test.ts
// keeps this in step with the catalog.

export const PACK_NAMES: Readonly<Record<string, string>> = {
  'grand-piano': 'Grand Piano',
  'live-drums': 'Live Drum Kit',
  'upright-piano': 'Upright Piano',
  'keys-mallets': 'Keys & Mallets',
  orchestral: 'Orchestral Essentials',
  'perc-extras': 'Percussion Extras',
  'hits-whooshes': 'Hits & Whooshes',
  'foley-field': 'Foley & Field Recordings',
  'retro-game': 'Retro Game FX',
};
