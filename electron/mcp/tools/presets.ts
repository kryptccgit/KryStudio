// Sound tools (owned by sounds-core): find_presets, load_preset, save_preset,
// apply_chain. See research/10-sound-and-craft.md.
//
// Presets are asked for by ROLE + genre + words and resolved with
// shared/sounds/select.ts; loading one is a presets.* doc command (one undo
// step per call). The preset list comes from the sounds service (factory +
// the user's presets) or, when it isn't wired, the shared factory data.

import { z } from 'zod';
import type { MainDeps } from '../types';
import { CHAIN_ROLES, INSTRUMENT_ROLES, type ChainPreset, type ChainRole, type InstrumentPreset, type InstrumentRole, type Preset } from '@shared/sounds/types';
import { GENRE_IDS, genreInfo, resolveGenre, type GenreId } from '@shared/sounds/genres';
import { rankPresets, roleFromName, type SoundQuery } from '@shared/sounds/select';
import { chainFromInsert, presetFromChannel } from '@shared/sounds/capture';
import { defineTool, fail, type RunCtx, type ToolCaller, type ToolResult } from './types';
import { findChannel, findInsert, findPluginRef, looksLikePath, plural, pluginName, safeName } from './util';
import { likeKindText, similarForAgent, similarWarnings } from './similar';
import { classifyUserSample } from './discovery';
import { genreContext, presetPlayable, soundLibrary } from './instruments';
import { missingPack, needsPackText } from '../../packs/gating';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

const ALL_ROLES: readonly string[] = [...INSTRUMENT_ROLES, ...CHAIN_ROLES];

/** 'drumbus' / 'Drum Bus' → 'drumBus'; null when it isn't a role. */
function parseRole(raw: string | undefined): InstrumentRole | ChainRole | null {
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (ALL_ROLES.find((r) => r.toLowerCase() === k) as InstrumentRole | ChainRole | undefined) ?? null;
}

/** The chain role words imply ("club master" → master, "drum bus" → drumBus), or null. */
export function chainRoleFromText(text: string): ChainRole | null {
  const t = text.toLowerCase();
  if (/\bmaster(ing)?\b/.test(t)) return 'master';
  if (/\bdrum ?bus\b|\bdrums? (group|glue)\b/.test(t)) return 'drumBus';
  if (/\b(reverb|verb|hall|plate)\b.*\bsend\b|\bsend\b.*\b(reverb|verb)\b|^\s*(reverb|verb|hall|plate)\s*$/.test(t)) return 'reverbSend';
  if (/\b(delay|echo)\b.*\bsend\b|\bsend\b.*\b(delay|echo)\b|^\s*(delay|echo)\s*$/.test(t)) return 'delaySend';
  if (/\b(vocal|vocals|vox|voice)\b/.test(t)) return 'vocal';
  if (/\b(lofi|lo fi|tape|telephone|bitcrush|crush|vinyl|radio)\b/.test(t)) return 'character';
  if (/\b(riser|sweep|transition|uplifter)\b/.test(t)) return 'transition';
  if (/\b(kick|snare|hat|hats|clap|perc)\b/.test(t)) return 'drums';
  if (/\b(808|bass|sub)\b/.test(t)) return 'bass';
  if (/\blead\b/.test(t)) return 'lead';
  if (/\bpad\b/.test(t)) return 'pad';
  if (/\b(keys|piano)\b/.test(t)) return 'keys';
  if (/\bpluck\b/.test(t)) return 'pluck';
  return null;
}

function genreArg(raw: string | undefined, deps: MainDeps, warnings: string[]): GenreId | null {
  if (raw === undefined) return genreContext(deps);
  if (!raw.trim() || /^(any|none|all)$/i.test(raw.trim())) return null;
  const g = resolveGenre(raw);
  if (!g) warnings.push(`Unknown genre "${safeName(raw, 30)}" (known: ${GENRE_IDS.join(', ')}); ranked without one.`);
  return g;
}

function shortPlugin(deps: MainDeps, id: string): string {
  return pluginName(deps.doc.catalog, id).replace(/^Krypt /, '');
}

function presetLine(deps: MainDeps, p: Preset): string {
  const what = p.kind === 'instrument' ? `${p.role}, ${shortPlugin(deps, p.plugin)}` : `${p.role} chain, ${plural(p.fx.length, 'effect')}${p.targetLufs !== undefined ? `, ~${p.targetLufs} LUFS` : ''}`;
  const tags = p.tags.length ? ` [${p.tags.slice(0, 6).join(', ')}]` : '';
  const genres = p.genres.length ? ` {${p.genres.slice(0, 4).join(', ')}${p.genres.length > 4 ? ', …' : ''}}` : '';
  const pack = missingPack(deps.packs, p);
  return `${p.id}  ${safeName(p.name, 64)} (${what})${tags}${genres} — ${safeName(p.description, 160)}${pack ? ` — ${needsPackText(pack.name)}` : ''}`;
}

interface Resolved<T extends Preset> {
  preset: T;
  how: 'id' | 'name' | 'search';
  others: T[];
}

/** A preset by id, exact name (case-insensitive) or descriptive words, best-first by role + genre. */
function resolvePreset<T extends Preset>(all: readonly Preset[], kind: T['kind'], query: string, roleHint: InstrumentRole | ChainRole | null, genre: GenreId | null): Resolved<T> | null {
  const pool = all.filter((p): p is T => p.kind === kind);
  const q = query.trim();
  const byId = pool.find((p) => p.id === q) ?? pool.find((p) => p.id.toLowerCase() === q.toLowerCase());
  if (byId) return { preset: byId, how: 'id', others: [] };
  if (/^(factory|user):/i.test(q)) return null; // an id that isn't (or isn't of this kind): never a word search
  const byName = pool.filter((p) => p.name.toLowerCase() === q.toLowerCase());
  if (byName.length) {
    const ranked = rankPresets(byName, { genre: genre ?? undefined }, byName.length);
    return { preset: ranked[0] ?? byName[0], how: 'name', others: ranked.slice(1) };
  }
  const base: SoundQuery = { text: q, kind, genre: genre ?? undefined };
  let ranked: T[] = roleHint ? rankPresets(pool, { ...base, role: roleHint }, 4) : [];
  if (!ranked.length) ranked = rankPresets(pool, base, 4);
  if (!ranked.length) return null;
  return { preset: ranked[0], how: 'search', others: ranked.slice(1) };
}

function noPresetMessage(kind: Preset['kind'], query: string, count: number, note?: string): string {
  const what = kind === 'chain' ? 'effect-chain preset' : 'instrument preset';
  if (!count) return `No ${what}s are installed yet${note ? ` (${note})` : ''}. ${kind === 'chain' ? 'Build the chain with add_effect / set_effect instead.' : 'Use add_channel / set_instrument + set_params instead.'}`;
  return `No ${what} matches "${safeName(query, 60)}". Call find_presets${kind === 'chain' ? ' {"kind":"chain"}' : ''} to see what exists (by role, genre or words).`;
}

// ── find_presets ──────────────────────────────────────────────────────

/** find_presets {like}: the closest instrument presets by timbre (same role family first; `role` picks another). */
async function likePresets(deps: MainDeps, caller: ToolCaller, a: { like: string; role?: string; limit: number; text?: string; genre?: string; tags?: string[]; kind?: string; plugin?: string }, ctx?: RunCtx): Promise<ToolResult> {
  let role: InstrumentRole | undefined;
  if (a.role !== undefined) {
    const r = parseRole(a.role);
    if (!r || !(INSTRUMENT_ROLES as readonly string[]).includes(r)) fail(`"${safeName(a.role, 24)}" isn't an instrument role (${INSTRUMENT_ROLES.join(', ')}); like finds instrument presets.`);
    role = r as InstrumentRole;
  }
  if (a.kind === 'chain') fail('like finds instrument presets (effect chains have no sound of their own to compare).');
  const r = await similarForAgent(deps, caller, ctx, a.like, { scope: role ? 'any' : 'same', want: 'presets', limit: role ? 100 : a.limit }, classifyUserSample);
  const items = r.items.filter((i): i is Extract<typeof i, { type: 'preset' }> => i.type === 'preset').filter((i) => !role || i.role === role).slice(0, a.limit);
  const warnings = similarWarnings(r).filter((w) => !/pack sound/.test(w));
  if (a.text || a.genre !== undefined || a.tags?.length || a.plugin) warnings.push('text, genre, tags and plugin are ignored with like (the closest sounds come first).');
  const name = safeName(r.source.name, 60);
  if (!items.length) return { ok: true, message: `No instrument presets${role ? ` with role ${role}` : ''} sound like "${name}"${likeKindText(r)}.${role ? '' : ' Pass role to search another role.'}`, changed: [], warnings, data: { like: r.source, presets: [] } };
  return {
    ok: true,
    message: `${plural(items.length, 'preset')} like "${name}"${likeKindText(r)}, closest first. Load one with load_preset {"preset":"<id>"}.`,
    changed: [],
    warnings,
    text: items.map((i) => `${i.id}  ${safeName(i.name, 64)} (${i.role}, ${shortPlugin(deps, i.plugin)}) · ${i.percent}% · ${i.why}`).join('\n'),
    data: { like: { ...r.source, name }, presets: items.map((i) => ({ id: i.id, kind: 'instrument', name: safeName(i.name, 64), role: i.role, plugin: i.plugin, source: i.origin, similarity: i.percent, why: i.why })) },
  };
}

export const findPresets = defineTool({
  name: 'find_presets',
  title: 'Find presets',
  kind: 'read',
  description:
    'Search the instrument presets (finished sounds: synth / 808 / sampler with their effect chain) and effect-chain presets (master, drum bus, sends, inserts), factory and user. Ask by ROLE (kick, snare, hat, 808, sub, bass, lead, pluck, pad, keys, piano, bell, arp, stab, chord, strings, brass, vox, fx, texture; chains: master, drumBus, drums, bass, lead, pad, keys, pluck, vocal, reverbSend, delaySend, character, transition) + genre + words. genre defaults to the project genre (or the library focus). Then load_preset / apply_chain with the id. Example: {"role":"lead","text":"wide supersaw"}. More like this: like = a preset id or a sample path (factory:… / pack:… / an audio file) → the closest factory instrument presets by timbre (similarity %, one-line difference), the same role family first; add role for another role. Example: {"like":"factory:808/boom"}',
  input: z.object({
    text: z.string().max(120).optional().describe('Words to match: "dark pluck", "wide supersaw", "club master".'),
    role: z.string().max(24).optional().describe('An instrument role or chain role (see the description).'),
    genre: z.string().max(40).optional().describe('Genre id or alias ("big room", "uk drill"). Default: the project genre or the library focus; "any" = no genre.'),
    tags: z.array(z.string().max(32)).max(8).optional().describe('Descriptive tags: dark, bright, warm, wide, punchy, lofi, …'),
    kind: z.enum(['instrument', 'chain']).optional(),
    plugin: z.string().max(80).optional().describe('Only presets for this instrument (wavetable / krypt.wavetable, fm, triosc, 808, sampler, drumsynth).'),
    limit: z.number().int().min(1).max(60).default(15),
    like: z.string().min(1).max(1024).optional().describe('Find presets that sound like this: an instrument preset id or a sample path (factory:… / pack:… / an audio file) → the closest instrument presets by timbre.'),
  }),
  paths: (a) => (a.like && looksLikePath(a.like) ? [{ value: a.like, kind: 'audio' as const }] : []),
  run(deps, caller, a, ctx) {
    if (a.like) return likePresets(deps, caller, { ...a, like: a.like }, ctx);
    const warnings: string[] = [];
    const lib = soundLibrary(deps);
    let role: InstrumentRole | ChainRole | undefined;
    if (a.role !== undefined) {
      const r = parseRole(a.role);
      if (!r) fail(`"${safeName(a.role, 24)}" isn't a role. Instrument roles: ${INSTRUMENT_ROLES.join(', ')}. Chain roles: ${CHAIN_ROLES.join(', ')}.`);
      role = r;
    }
    const plugin = a.plugin ? findPluginRef(deps.doc.catalog, a.plugin, 'instrument').id : undefined;
    const genre = genreArg(a.genre, deps, warnings);
    // A role that is both an instrument and a chain role ('bass', 'lead' …) means the instrument unless kind says chain.
    const kind = a.kind ?? (role && !(INSTRUMENT_ROLES as readonly string[]).includes(role) ? 'chain' : role || plugin ? 'instrument' : undefined);
    const q: SoundQuery = { text: a.text, role, genre: genre ?? undefined, tags: a.tags, kind, plugin };
    const hits = rankPresets(lib.presets, q, a.limit);
    const total = lib.presets.length;
    const genreNote = genre ? ` Ranked for ${genreInfo(genre).name}${a.genre === undefined ? ' (the project genre)' : ''}.` : '';
    if (lib.note) warnings.push(lib.note);
    if (!hits.length) {
      const msg = total
        ? `No presets match${a.text ? ` "${safeName(a.text, 60)}"` : ''}${role ? ` with role ${role}` : ''}${plugin ? ` on ${shortPlugin(deps, plugin)}` : ''}. ${total} presets exist; try fewer words, another role, or genre "any".`
        : `No presets are installed yet. Build sounds with add_channel + set_params instead.`;
      return { ok: true, message: msg, changed: [], warnings, data: { presets: [] } };
    }
    const needPack = hits.filter((p) => missingPack(deps.packs, p)).length;
    const packNote = needPack ? ` ${plural(needPack, 'preset')} marked "needs the … pack" only play once the user downloads that pack in Home ▸ Sounds (you can't download packs; list_packs shows them): load another one, or tell the user which pack would help.` : '';
    return {
      ok: true,
      message: `${plural(hits.length, 'preset')}${hits.length >= a.limit ? ` (best ${a.limit} of ${total})` : ''}.${genreNote} Load one with load_preset {"preset":"<id>"} (instruments) or apply_chain {"chain":"<id>","insert":"…"} (chains).${packNote}`,
      changed: [],
      warnings,
      text: hits.map((p) => presetLine(deps, p)).join('\n'),
      data: {
        presets: hits.map((p) => ({
          id: p.id,
          kind: p.kind,
          name: safeName(p.name, 64),
          role: p.role,
          plugin: p.kind === 'instrument' ? p.plugin : undefined,
          tags: p.tags,
          genres: p.genres,
          description: safeName(p.description, 300),
          source: p.id.startsWith('user:') ? 'user' : 'factory',
          // The sound pack it needs that isn't installed ({id, name}); absent when it plays as is.
          needsPack: missingPack(deps.packs, p) ?? undefined,
        })),
      },
    };
  },
});

// ── load_preset ───────────────────────────────────────────────────────

export const loadPreset = defineTool({
  name: 'load_preset',
  title: 'Load an instrument preset',
  kind: 'write',
  description:
    'Load an instrument preset: onto an existing channel (replaces its instrument, params, sample and, with_fx, the effects on its own mixer insert; notes stay) or as a NEW channel (omit channel). preset = an id from find_presets, a preset name, or words ("dark pluck", "wide supersaw lead") resolved by role + the project genre. One undo step. Example: {"preset":"dark pluck","channel":"Chords"} or {"preset":"factory:808/…","name":"808"}',
  input: z.object({
    preset: z.string().min(1).max(120).describe('Preset id, exact name, or descriptive words.'),
    channel: z.string().max(80).optional().describe('Existing channel (name or id). Omit to add a new channel with its own mixer insert.'),
    name: z.string().min(1).max(64).optional().describe('Name for the new channel (default: the preset name), or a new name for `channel`.'),
    with_fx: z.boolean().default(true).describe("Also load the preset's effect chain onto the channel's own insert (a channel on the master / a shared insert gets its own insert first)."),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.preset, 40)}${a.channel ? ` → ${safeName(a.channel, 30)}` : ''}`,
  run(deps, _c, a, ctx): ToolResult {
    const p0 = deps.doc.project;
    const lib = soundLibrary(deps);
    const ch = a.channel ? findChannel(p0, a.channel) : null;
    const hint = (roleFromName(a.preset) ?? (ch ? roleFromName(ch.name) : null) ?? (a.name ? roleFromName(a.name) : null)) as InstrumentRole | null;
    const genre = genreContext(deps);
    let r = resolvePreset<InstrumentPreset>(lib.presets, 'instrument', a.preset, hint, genre);
    if (!r) {
      const chain = resolvePreset<ChainPreset>(lib.presets, 'chain', a.preset, null, genre);
      if (chain && chain.how !== 'search') fail(`"${safeName(chain.preset.name)}" is an effect-chain preset; load it with apply_chain {"chain":"${chain.preset.id}","insert":"…"}.`);
      fail(noPresetMessage('instrument', a.preset, lib.presets.filter((p) => p.kind === 'instrument').length, lib.note));
    }
    const warnings: string[] = [];
    // A preset whose sound pack isn't installed can't play: named → refused; a word search falls back to one that plays.
    const pack = missingPack(deps.packs, r.preset);
    if (pack) {
      const why = `${safeName(r.preset.name)} (${r.preset.id}) ${needsPackText(pack.name)}`;
      if (r.how !== 'search') fail(`${why}. You can't download packs: ask the user to download it, or load another preset (find_presets).`);
      const alt = resolvePreset<InstrumentPreset>(lib.presets.filter((p) => !missingPack(deps.packs, p)), 'instrument', a.preset, hint, genre);
      if (!alt) fail(`The only match, ${why}. Ask the user to download it, or load another preset (find_presets).`);
      warnings.push(`The best match, ${why}; loaded ${safeName(alt.preset.name)} instead. Tell the user if the real instrument would help.`);
      r = alt;
    }
    const preset = r.preset;
    if (lib.note && r.how === 'search') warnings.push(lib.note);
    if (preset.sample && !presetPlayable(deps, preset)) warnings.push(`The sample ${safeName(preset.sample, 120)} isn't installed, so the channel stays silent until the factory kit is generated (or the file is back).`);
    const pluginLabel = shortPlugin(deps, preset.plugin);
    let channelId: string;
    let insertId: string;
    let split = '';
    if (ch) {
      const res = ctx.exec<{ channelId: string; insertId: string; splitFrom?: string }>('presets.applyToChannel', { channelId: ch.id, preset, withFx: a.with_fx });
      channelId = res.channelId;
      insertId = res.insertId;
      if (a.name && a.name.trim() && safeName(a.name, 64) !== ch.name) ctx.exec('channels.set', { id: ch.id, name: safeName(a.name, 64) });
      if (res.splitFrom) {
        const from = deps.doc.project.mixer.inserts[res.splitFrom];
        split = ` The channel shared ${from?.isMaster ? 'the master' : `insert "${safeName(from?.name)}"`}, so it got its own insert "${safeName(deps.doc.project.mixer.inserts[insertId]?.name)}" (${insertId})${from && !from.isMaster ? ` feeding "${safeName(from.name)}"` : ''}.`;
      }
    } else {
      const res = ctx.exec<{ channelId: string; insertId: string }>('presets.addChannel', { preset, name: a.name ? safeName(a.name, 64) : undefined, withFx: a.with_fx });
      channelId = res.channelId;
      insertId = res.insertId;
    }
    const p = deps.doc.project;
    const chNow = p.channels[channelId];
    const ins = p.mixer.inserts[insertId];
    const fxCount = a.with_fx && preset.fx?.length ? preset.fx.length : 0;
    const fxText = fxCount ? ` with its ${plural(fxCount, 'effect')} (${preset.fx!.map((f) => shortPlugin(deps, f.type)).join(' → ')}) on insert "${safeName(ins?.name)}" (${insertId})` : ` → ${ins?.isMaster ? 'Master' : `insert "${safeName(ins?.name)}" (${insertId})`}`;
    const found = r.how === 'search' ? ` Best match for "${safeName(a.preset, 60)}"${r.others.length ? `; others: ${r.others.map((o) => `${safeName(o.name)} (${o.id})`).join(', ')}` : ''}.` : '';
    return {
      ok: true,
      message: `${ch ? 'Loaded' : 'Added'} "${safeName(chNow?.name)}" (${channelId}) → preset ${safeName(preset.name)} (${preset.id}; ${preset.role}, ${pluginLabel})${fxText}.${split}${found}`,
      changed: [],
      warnings,
      data: { channelId, insertId, preset: preset.id },
    };
  },
});

// ── save_preset ───────────────────────────────────────────────────────

export const savePreset = defineTool({
  name: 'save_preset',
  title: 'Save a preset',
  // Writes a user preset file; the project only gets the channel's preset label (no undo step of its own).
  kind: 'transport',
  description:
    "Save a sound you designed as a USER preset (it shows in the user's preset browser and in find_presets): a channel's instrument + params + sample + its own insert's effects, or a mixer insert's effect chain (insert: \"master\", a bus …). Only params that differ from the defaults are stored; a saved channel is then labelled with the new preset. Example: {\"channel\":\"Lead\",\"name\":\"Glass Lead\",\"tags\":[\"bright\",\"wide\"],\"genres\":[\"future-bass\"],\"description\":\"Shimmery detuned lead for drops.\"}",
  input: z.object({
    channel: z.string().max(80).optional().describe('Save this channel as an instrument preset.'),
    insert: z.union([z.string().max(80), z.number().int().min(0)]).optional().describe('Or save this mixer insert as an effect-chain preset ("master", name, id, index, or a channel name).'),
    name: z.string().min(1).max(64),
    role: z.string().max(24).optional().describe('Instrument role (lead, pluck, 808 …) or chain role (master, drumBus, reverbSend …). Default: guessed from the name.'),
    tags: z.array(z.string().max(32)).max(12).optional(),
    genres: z.array(z.string().max(40)).max(6).optional().describe('Genre ids or aliases it suits.'),
    description: z.string().max(300).optional().describe('One sentence: what it sounds like and when to use it.'),
  }),
  summarize: (a) => `"${safeName(a.name, 40)}" from ${safeName(a.channel ?? String(a.insert ?? '?'), 30)}`,
  run(deps, caller, a, ctx): ToolResult {
    if ((a.channel === undefined) === (a.insert === undefined)) fail('Pass exactly one of channel (an instrument preset) or insert (an effect-chain preset).');
    if (!deps.sounds) fail("Saving presets needs Krypt Studio's sounds service, which isn't running in this session.");
    const genres: GenreId[] = [];
    for (const g of a.genres ?? []) {
      const id = resolveGenre(g);
      if (!id) fail(`Unknown genre "${safeName(g, 30)}". Known: ${GENRE_IDS.join(', ')}.`);
      if (!genres.includes(id)) genres.push(id);
    }
    const role = a.role !== undefined ? parseRole(a.role) : null;
    if (a.role !== undefined && !role) fail(`"${safeName(a.role, 24)}" isn't a role. Instrument roles: ${INSTRUMENT_ROLES.join(', ')}. Chain roles: ${CHAIN_ROLES.join(', ')}.`);
    const meta = { name: safeName(a.name, 64), tags: a.tags, genres, description: a.description ? safeName(a.description, 300) : undefined, author: safeName(caller.actor.name, 64) || undefined };
    const p = deps.doc.project;
    let preset: InstrumentPreset | ChainPreset;
    let channelId: string | null = null;
    try {
      if (a.channel !== undefined) {
        const ch = findChannel(p, a.channel);
        channelId = ch.id;
        if (role && !(INSTRUMENT_ROLES as readonly string[]).includes(role)) fail(`"${role}" is a chain role; a channel preset needs an instrument role (${INSTRUMENT_ROLES.join(', ')}).`);
        preset = presetFromChannel(p, deps.doc.catalog, ch.id, { ...meta, role: (role as InstrumentRole | null) ?? undefined });
      } else {
        const ins = findInsert(p, a.insert!);
        if (role && !(CHAIN_ROLES as readonly string[]).includes(role)) fail(`"${role}" isn't a chain role (${CHAIN_ROLES.join(', ')}).`);
        preset = chainFromInsert(p, deps.doc.catalog, ins.id, { ...meta, role: (role as ChainRole | null) ?? undefined });
      }
    } catch (e) {
      if ((e as Error).name === 'ToolFailure') throw e;
      fail((e as Error).message);
    }
    const r = deps.sounds.saveUser(preset);
    if (!r.ok || !r.data) fail(r.message ?? `Couldn't save "${meta.name}".`);
    const s = r.data;
    // The channel now plays that preset: label it (as this agent, inside the call's group; not an undo step).
    if (channelId) ctx.tryExec('presets.markChannel', { channelId, preset: { id: s.id, name: s.name } });
    const detail =
      preset.kind === 'instrument'
        ? `${preset.role}, ${shortPlugin(deps, preset.plugin)}, ${plural(Object.keys(preset.params).length, 'changed param')}${preset.sample ? `, sample ${safeName(preset.sample.split(/[\\/:]/).pop(), 60)}` : ''}${preset.fx?.length ? `, ${plural(preset.fx.length, 'effect')}` : ''}`
        : `${preset.role} chain: ${preset.fx.map((f) => shortPlugin(deps, f.type)).join(' → ')}`;
    const how = preset.kind === 'instrument' ? `load_preset {"preset":"${s.id}"}` : `apply_chain {"chain":"${s.id}","insert":"…"}`;
    return { ok: true, message: `Saved user preset "${safeName(s.name)}" (${s.id}; ${detail}). ${how} loads it.`, changed: [], data: s };
  },
});

// ── apply_chain ───────────────────────────────────────────────────────

const NEW_INSERT_NAME: Partial<Record<ChainRole, string>> = { drumBus: 'Drum Bus', reverbSend: 'Reverb', delaySend: 'Delay' };

export const applyChain = defineTool({
  name: 'apply_chain',
  title: 'Load an effect chain',
  kind: 'write',
  description:
    'Load an effect-chain preset onto a mixer insert: a genre master chain on "master" (tone, glue, clipper, limiter at a loudness target), a drum bus, a reverb / delay send, a channel insert, a lo-fi character chain … chain = an id from find_presets, a name, or words ("club master", "drum bus glue"). insert = "master", an insert name / id / index, a channel name (its insert), or "new:<Name>" for a new insert with that name ("new:Music Bus"; bare "new" names bus / send chains after their role: Drum Bus, Reverb, Delay). mode replace (default) swaps the insert\'s effects; append adds after them. Example: {"chain":"club master","insert":"master"}',
  input: z.object({
    chain: z.string().min(1).max(120),
    insert: z.union([z.string().max(80), z.number().int().min(0)]),
    mode: z.enum(['replace', 'append']).default('replace'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.chain, 40)} → ${safeName(String(a.insert), 30)}`,
  run(deps, _c, a, ctx): ToolResult {
    const lib = soundLibrary(deps);
    const genre = genreContext(deps);
    const r = resolvePreset<ChainPreset>(lib.presets, 'chain', a.chain, chainRoleFromText(a.chain), genre);
    if (!r) {
      const inst = resolvePreset<InstrumentPreset>(lib.presets, 'instrument', a.chain, null, genre);
      if (inst && inst.how !== 'search') fail(`"${safeName(inst.preset.name)}" is an instrument preset; load it with load_preset {"preset":"${inst.preset.id}"}.`);
      fail(noPresetMessage('chain', a.chain, lib.presets.filter((p) => p.kind === 'chain').length, lib.note));
    }
    const preset = r.preset;
    const warnings: string[] = [];
    if (lib.note && r.how === 'search') warnings.push(lib.note);
    const p0 = deps.doc.project;
    let insertId: string;
    let created = '';
    const fresh = typeof a.insert === 'string' ? /^new(?::\s*(.+))?$/i.exec(a.insert.trim()) : null;
    if (fresh) {
      // "new:Music Bus" names the new insert; bare "new" names bus / send chains after their role.
      const name = fresh[1]?.trim().slice(0, 64) || NEW_INSERT_NAME[preset.role];
      if (!name) fail(`insert "new" is for bus and send chains (drumBus, reverbSend, delaySend); "${safeName(preset.name)}" is a ${preset.role} chain. Name the new insert ("new:Music Bus") or the insert to load it on.`);
      const taken = new Set(p0.mixer.insertOrder.map((id) => p0.mixer.inserts[id].name.toLowerCase()));
      let label = name;
      for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${name} ${n}`;
      insertId = ctx.exec<{ id: string }>('mixer.addInsert', { name: label }).id;
      created = ` Created insert "${label}" (${insertId}).`;
      if (preset.role === 'reverbSend' || preset.role === 'delaySend') created += ` Nothing feeds it yet: send inserts to it with route {"from_insert":"Lead","to":"${label}","level_db":-12,"exclusive":false}.`;
      else if (preset.role !== 'drumBus') created += ` Nothing feeds it yet: route inserts into it with route {"from_insert":"Chords","to":"${label}"}.`;
      else created += ` Nothing feeds it yet: route the drum inserts into it with route {"from_insert":"Kick","to":"${label}"}.`;
    } else {
      insertId = findInsert(p0, a.insert).id;
    }
    const ins0 = deps.doc.project.mixer.inserts[insertId];
    if (preset.role === 'master' && !ins0.isMaster) warnings.push(`"${safeName(preset.name)}" is a master chain (it ends in a limiter); on "${safeName(ins0.name)}" it may squash that part.`);
    if (ins0.isMaster && preset.role !== 'master') warnings.push(`"${safeName(preset.name)}" is a ${preset.role} chain, not a master chain; on the master it processes the whole mix.`);
    const before = ins0.slotOrder.length;
    ctx.exec('presets.applyChain', { insertId, preset, mode: a.mode });
    const ins = deps.doc.project.mixer.inserts[insertId];
    const chainText = ins.slotOrder.map((sid) => shortPlugin(deps, ins.slots[sid].type)).join(' → ');
    const where = ins.isMaster ? 'Master' : `"${safeName(ins.name)}" (${insertId})`;
    const replaced = a.mode === 'replace' && before ? ` (replaced ${plural(before, 'effect')})` : '';
    const lufs = preset.targetLufs !== undefined ? ` Tuned for about ${preset.targetLufs} LUFS integrated on a full mix; check with render_preview.` : '';
    const found = r.how === 'search' ? ` Best match for "${safeName(a.chain, 60)}"${r.others.length ? `; others: ${r.others.map((o) => `${safeName(o.name)} (${o.id})`).join(', ')}` : ''}.` : '';
    return {
      ok: true,
      message: `Loaded chain ${safeName(preset.name)} (${preset.id}) on ${where}${replaced}: ${chainText || 'no effects'}.${created}${lufs}${found}`,
      changed: [],
      warnings,
      data: { insertId, chain: preset.id },
    };
  },
});

export const PRESET_TOOLS = [findPresets, loadPreset, savePreset, applyChain];
