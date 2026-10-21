// Ranking presets and samples for a request ("a dark pluck for future bass").
// Shared by the MCP tools, the default-instrument choice for channels agents
// create by name, get_playbook's palette and the renderer's preset browser.
// Pure + deterministic: same inputs, same order.

import { resolveGenre, sameFamily, type GenreId } from './genres';
import type { ChainRole, FactorySample, InstrumentRole, Preset, SampleKind } from './types';

export interface SoundQuery {
  /** Free words matched against name, description, tags, role, plugin ("dark supersaw"). */
  text?: string;
  role?: InstrumentRole | ChainRole;
  kind?: Preset['kind'];
  /** Genre id or any alias ("big room"). */
  genre?: string;
  tags?: string[];
  plugin?: string;
  source?: 'factory' | 'user';
}

export interface SampleQuery {
  text?: string;
  kind?: SampleKind;
  genre?: string;
  tags?: string[];
  /** Only tempo-synced FX / loops of exactly this many bars (closest when none match exactly). */
  bars?: number;
}

const words = (s: string | undefined) => (s ?? '').toLowerCase().split(/[^a-z0-9#]+/).filter((w) => w.length > 1);

function genreScore(want: GenreId | null, have: readonly GenreId[]): number {
  if (!want) return 0;
  if (have.includes(want)) return 20;
  if (have.some((g) => sameFamily(g, want))) return 8;
  return have.length === 0 ? 4 : -4;
}

function textScore(q: string[], hay: string): number {
  if (!q.length) return 0;
  let s = 0;
  for (const w of q) if (hay.includes(w)) s += 5;
  return s;
}

/** Score one preset (higher = better); -Infinity = excluded by a hard filter. */
export function scorePreset(p: Preset, q: SoundQuery): number {
  if (q.kind && p.kind !== q.kind) return -Infinity;
  if (q.plugin && (p.kind !== 'instrument' || p.plugin !== q.plugin)) return -Infinity;
  const source = p.id.startsWith('user:') ? 'user' : 'factory';
  if (q.source && source !== q.source) return -Infinity;
  let s = 0;
  if (q.role) {
    if (p.role === q.role) s += 50;
    else if (p.kind === 'instrument' && p.alsoRoles?.includes(q.role as InstrumentRole)) s += 30;
    else return -Infinity;
  }
  const genre = resolveGenre(q.genre);
  s += genreScore(genre, p.genres);
  // The designer's go-to sound for this role in this genre beats an equally tagged one (ties used to fall to id order).
  if (genre && p.kind === 'instrument' && p.defaultFor?.includes(genre) && (!q.role || p.role === q.role)) s += 15;
  for (const t of q.tags ?? []) if (p.tags.includes(t.toLowerCase())) s += 6;
  const hay = `${p.name} ${p.description} ${p.tags.join(' ')} ${p.role} ${p.kind === 'instrument' ? `${p.plugin} ${(p.alsoRoles ?? []).join(' ')}` : 'chain'}`.toLowerCase();
  const tw = words(q.text);
  const ts = textScore(tw, hay);
  if (tw.length && ts === 0 && !q.role) return -Infinity;
  s += ts;
  // User presets first among equals: they are the user's own taste.
  if (source === 'user') s += 1;
  // Racks (Wave 12.2) are bigger, multi-part sounds: picked by role only when nothing plainer fits, or when asked for.
  if (isRackPreset(p) && !tw.includes('rack') && !q.plugin) s -= 12;
  // A recorded instrument from an installed sound pack beats its synth stand-in (callers gate out uninstalled packs).
  if (p.kind === 'instrument' && p.requires) s += 2;
  return s;
}

/** A preset that is (or holds) a rack: an instrument / drum rack, or a chain with an effect rack. */
export function isRackPreset(p: Preset): boolean {
  return p.kind === 'instrument' ? !!p.rack || p.plugin === 'krypt.rack' || p.plugin === 'krypt.drumrack' : p.fx.some((f) => !!f.rack || f.type === 'krypt.fxrack');
}

/** Presets best-first. */
export function rankPresets<T extends Preset>(presets: readonly T[], q: SoundQuery, limit = 30): T[] {
  return presets
    .map((p) => ({ p, s: scorePreset(p, q) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id))
    .slice(0, limit)
    .map((x) => x.p);
}

/** The single best preset for a role (+ genre / tags), or null. */
export function pickPreset<T extends Preset>(presets: readonly T[], role: InstrumentRole | ChainRole, genre?: string | null, tags?: string[]): T | null {
  return rankPresets(presets, { role, genre: genre ?? undefined, tags }, 1)[0] ?? null;
}

export function scoreSample(x: FactorySample, q: SampleQuery): number {
  if (q.kind && x.kind !== q.kind) return -Infinity;
  let s = q.kind ? 50 : 0;
  s += genreScore(resolveGenre(q.genre), x.genres);
  for (const t of q.tags ?? []) if (x.tags.includes(t.toLowerCase())) s += 6;
  if (q.bars !== undefined) {
    if (x.bars === undefined) return -Infinity;
    s -= Math.abs(x.bars - q.bars) * 10;
  }
  const tw = words(q.text);
  const ts = textScore(tw, `${x.name} ${x.kind} ${x.tags.join(' ')} ${x.path}`.toLowerCase());
  if (tw.length && ts === 0 && !q.kind) return -Infinity;
  return s + ts;
}

/** Factory samples best-first. */
export function rankSamples(samples: readonly FactorySample[], q: SampleQuery, limit = 30): FactorySample[] {
  return samples
    .map((x) => ({ x, s: scoreSample(x, q) }))
    .filter((r) => r.s > -Infinity)
    .sort((a, b) => b.s - a.s || a.x.path.localeCompare(b.x.path))
    .slice(0, limit)
    .map((r) => r.x);
}

/**
 * The role a channel NAME implies ("Supersaw Lead" → lead, "808" → 808, "Chords" → chord), or null. Used when an
 * agent creates a channel by name without choosing a sound.
 */
export function roleFromName(name: string): InstrumentRole | null {
  const n = name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  const has = (re: RegExp) => re.test(n);
  if (has(/\b808s?\b|\bsub ?808\b/)) return '808';
  if (has(/\b(open ?hat|oh|ohh|open)\b/)) return 'openhat';
  if (has(/\b(hat|hats|hh|hihat|hi hat|chh)\b/)) return 'hat';
  if (has(/\b(kick|bd|kik)\b/)) return 'kick';
  if (has(/\b(snare|sd|snr|rimshot)\b/)) return 'snare';
  if (has(/\b(clap|claps|cp|snap)\b/)) return 'clap';
  if (has(/\bride\b/)) return 'ride';
  if (has(/\b(crash|cymbal)\b/)) return 'crash';
  if (has(/\b(tom|toms|conga|bongo)\b/)) return 'tom';
  if (has(/\b(perc|shaker|tamb|tambourine|rim|cowbell|clave|woodblock)\b/)) return 'perc';
  if (has(/\b(sub|subbass)\b/)) return 'sub';
  if (has(/\b(bass|reese|wobble|growl)\b/)) return 'bass';
  if (has(/\b(pluck|plucks)\b/)) return 'pluck';
  if (has(/\b(arp|arps|arpeggio)\b/)) return 'arp';
  if (has(/\b(pad|pads|atmos|atmosphere|ambient|drone|swell)\b/)) return 'pad';
  if (has(/\b(piano|grand)\b/)) return 'piano';
  if (has(/\b(keys|rhodes|epiano|ep|organ|wurli)\b/)) return 'keys';
  if (has(/\b(bell|bells|glock|celesta|music box|mallet|marimba|kalimba)\b/)) return 'bell';
  if (has(/\b(stab|stabs)\b/)) return 'stab';
  if (has(/\b(chord|chords|supersaw chords|harmony)\b/)) return 'chord';
  if (has(/\b(string|strings|violin|cello|orchestra)\b/)) return 'strings';
  if (has(/\b(brass|horn|horns|trumpet)\b/)) return 'brass';
  if (has(/\b(vox|vocal|choir|voice)\b/)) return 'vox';
  if (has(/\b(riser|fx|sweep|impact|uplifter|downlifter)\b/)) return 'fx';
  if (has(/\b(texture|vinyl|noise|crackle)\b/)) return 'texture';
  if (has(/\b(lead|melody|hook|saw|supersaw|synth)\b/)) return 'lead';
  return null;
}
