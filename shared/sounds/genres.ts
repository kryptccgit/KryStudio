// The genres Krypt Studio knows by name: preset tags, factory sample tags,
// playbooks (shared/playbooks) and the beat prompt all use these ids. Pure TS.

export interface GenreInfo {
  id: GenreId;
  name: string;
  /** Other names users type ("big room", "uk drill" …), normalised with genreKey(). */
  aliases: string[];
  /** Broad family, used when a genre has no exact match (a preset tagged 'house' suits 'tech-house'). */
  family: 'hip-hop' | 'house' | 'bass' | 'pop' | 'retro' | 'world';
}

export const GENRE_IDS = [
  'trap',
  'drill',
  'boom-bap',
  'lofi',
  'phonk',
  'rnb',
  'pop',
  'afrobeats',
  'reggaeton',
  'house',
  'deep-house',
  'tech-house',
  'techno',
  'edm',
  'future-bass',
  'dubstep',
  'dnb',
  'synthwave',
] as const;

export type GenreId = (typeof GENRE_IDS)[number];

export const GENRES: readonly GenreInfo[] = [
  { id: 'trap', name: 'Trap', aliases: ['trap beat', 'rage', 'plugg', 'atl'], family: 'hip-hop' },
  { id: 'drill', name: 'Drill', aliases: ['uk drill', 'ny drill', 'brooklyn drill', 'chicago drill'], family: 'hip-hop' },
  { id: 'boom-bap', name: 'Boom bap', aliases: ['boombap', 'hip hop', 'hiphop', '90s hip hop', 'old school'], family: 'hip-hop' },
  { id: 'lofi', name: 'Lo-fi', aliases: ['lofi hip hop', 'lo fi', 'chillhop', 'study beats', 'jazzhop'], family: 'hip-hop' },
  { id: 'phonk', name: 'Phonk', aliases: ['drift phonk', 'memphis', 'brazilian phonk'], family: 'hip-hop' },
  { id: 'rnb', name: 'R&B', aliases: ['r&b', 'r and b', 'rnb', 'neo soul', 'soul'], family: 'pop' },
  { id: 'pop', name: 'Pop', aliases: ['dance pop', 'radio pop', 'electropop'], family: 'pop' },
  { id: 'afrobeats', name: 'Afrobeats', aliases: ['afrobeat', 'afro', 'amapiano', 'afropop', 'afro house'], family: 'world' },
  { id: 'reggaeton', name: 'Reggaeton', aliases: ['dembow', 'latin', 'perreo', 'urbano'], family: 'world' },
  { id: 'house', name: 'House', aliases: ['classic house', 'dance', 'disco house', 'french house'], family: 'house' },
  { id: 'deep-house', name: 'Deep house', aliases: ['deephouse', 'deep', 'tropical house'], family: 'house' },
  { id: 'tech-house', name: 'Tech house', aliases: ['techhouse', 'minimal', 'minimal house'], family: 'house' },
  { id: 'techno', name: 'Techno', aliases: ['melodic techno', 'peak time', 'hard techno', 'industrial techno'], family: 'house' },
  { id: 'edm', name: 'EDM', aliases: ['big room', 'bigroom', 'festival', 'progressive house', 'electro house', 'mainstage', 'edm drop'], family: 'house' },
  { id: 'future-bass', name: 'Future bass', aliases: ['futurebass', 'kawaii', 'melodic bass'], family: 'bass' },
  { id: 'dubstep', name: 'Dubstep', aliases: ['brostep', 'riddim', 'bass music', 'melodic dubstep'], family: 'bass' },
  { id: 'dnb', name: 'Drum & bass', aliases: ['drum and bass', 'drum n bass', 'dnb', 'jungle', 'liquid', 'neurofunk'], family: 'bass' },
  { id: 'synthwave', name: 'Synthwave', aliases: ['retrowave', 'outrun', '80s', 'darksynth', 'vaporwave'], family: 'retro' },
];

/** "Big Room!" → "bigroom": compare user text with ids and aliases. */
export function genreKey(s: string): string {
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

const BY_KEY = new Map<string, GenreId>();
for (const g of GENRES) {
  BY_KEY.set(genreKey(g.id), g.id);
  BY_KEY.set(genreKey(g.name), g.id);
  for (const a of g.aliases) BY_KEY.set(genreKey(a), g.id);
}

/** A genre id for a name or alias, or null. */
export function resolveGenre(name: string | null | undefined): GenreId | null {
  if (!name) return null;
  return BY_KEY.get(genreKey(name)) ?? null;
}

/** The first genre named anywhere in free text ("make a dark uk drill beat" → 'drill'); longest alias wins. */
export function genreInText(text: string): GenreId | null {
  const t = ` ${text.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')} `;
  let best: { id: GenreId; len: number } | null = null;
  for (const g of GENRES) {
    for (const name of [g.id.replace(/-/g, ' '), g.name.toLowerCase().replace(/&/g, 'and'), ...g.aliases]) {
      const n = ` ${name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
      if (n.trim() && t.includes(n) && (!best || n.length > best.len)) best = { id: g.id, len: n.length };
    }
  }
  return best?.id ?? null;
}

export function genreInfo(id: GenreId): GenreInfo {
  return GENRES.find((g) => g.id === id)!;
}

/** Same family, for "close enough" matches (tech-house ↔ house). */
export function sameFamily(a: GenreId, b: GenreId): boolean {
  return genreInfo(a).family === genreInfo(b).family;
}
