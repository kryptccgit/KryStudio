// Factory instrument presets (shared/sounds/factory/instruments): every preset
// must load cleanly through presets.applyToChannel, i.e. pass the zod schema,
// name a stock instrument, and carry only catalog params already clamped to
// their spec (in range, on step), with an FX chain of stock effects. Plus the
// coverage the playbooks rely on: every role and every genre has sounds.
// The SOUND of each preset is checked by scripts/audition-presets.mjs (engine
// renders); this file checks the data.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import raw from '../shared/plugins/catalog.gen.json';
import type { PluginCatalog, PluginDescriptor } from '@shared/plugins/types';
import { clampToSpec } from '@shared/plugins/types';
import { INSTRUMENT_PRESETS } from '@shared/sounds/factory/instruments';
import { GENRE_DEFAULTS } from '@shared/sounds/factory/instruments/defaults';
import { zInstrumentPreset } from '@shared/sounds/schema';
import { INSTRUMENT_ROLES, LEGACY_FACTORY_PATHS, type InstrumentRole } from '@shared/sounds/types';
import { GENRE_IDS, sameFamily, type GenreId } from '@shared/sounds/genres';
import { pickPreset } from '@shared/sounds/select';
import { MAX_FX_SLOTS } from '@shared/schema/project';

const CATALOG = raw as PluginCatalog;
const byId = new Map<string, PluginDescriptor>(CATALOG.plugins.map((p) => [p.id, p]));
const P = INSTRUMENT_PRESETS;

/** Check a param set against a plugin's specs; returns human-readable problems. */
function paramProblems(where: string, plugin: PluginDescriptor, params: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const spec = plugin.params.find((s) => s.id === k);
    if (!spec) {
      out.push(`${where}: ${plugin.id} has no param "${k}"`);
      continue;
    }
    if (!Number.isFinite(v)) out.push(`${where}: ${k} = ${v} is not finite`);
    else if (clampToSpec(spec, v) !== v) out.push(`${where}: ${k} = ${v} is off-spec (clamps to ${clampToSpec(spec, v)}; range ${spec.min}..${spec.max}${spec.step ? ` step ${spec.step}` : ''})`);
  }
  return out;
}

test('there are about 160+ factory instrument presets', () => {
  assert.ok(P.length >= 150, `only ${P.length} presets`);
});

test('every preset passes zInstrumentPreset', () => {
  for (const p of P) {
    const r = zInstrumentPreset.safeParse(p);
    assert.ok(r.success, `${p.id}: ${r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
});

test('ids are unique, look like factory:<role>/<slug> and match the role', () => {
  const seen = new Set<string>();
  for (const p of P) {
    assert.ok(!seen.has(p.id), `duplicate id ${p.id}`);
    seen.add(p.id);
    const m = /^factory:([a-z0-9]+)\/([a-z0-9][a-z0-9-]*)$/.exec(p.id);
    assert.ok(m, `bad id ${p.id}`);
    assert.equal(m[1], p.role, `${p.id}: id role "${m[1]}" ≠ role "${p.role}"`);
  }
});

test('names are unique within their role', () => {
  const seen = new Map<string, string>();
  for (const p of P) {
    const key = `${p.role}:${p.name.toLowerCase()}`;
    assert.ok(!seen.has(key), `"${p.name}" is used twice in role ${p.role} (${seen.get(key)}, ${p.id})`);
    seen.set(key, p.id);
  }
});

test('roles, alsoRoles and genres are valid', () => {
  for (const p of P) {
    assert.ok((INSTRUMENT_ROLES as readonly string[]).includes(p.role), `${p.id}: role ${p.role}`);
    for (const r of p.alsoRoles ?? []) {
      assert.ok((INSTRUMENT_ROLES as readonly string[]).includes(r), `${p.id}: alsoRole ${r}`);
      assert.notEqual(r, p.role, `${p.id}: alsoRoles repeats its own role`);
    }
    for (const g of p.genres) assert.ok((GENRE_IDS as readonly string[]).includes(g), `${p.id}: genre ${g}`);
    assert.equal(new Set(p.genres).size, p.genres.length, `${p.id}: duplicate genre`);
    assert.ok(p.tags.length >= 2, `${p.id}: needs descriptive tags`);
    assert.ok(p.tags.every((t) => t === t.toLowerCase()), `${p.id}: tags are lower-case`);
    assert.ok(p.description.length >= 40 && /[.!]$/.test(p.description), `${p.id}: description should be one full sentence`);
  }
});

test('every plugin is a stock instrument and every param is on-spec', () => {
  const problems: string[] = [];
  for (const p of P) {
    const plugin = byId.get(p.plugin);
    assert.ok(plugin, `${p.id}: unknown plugin ${p.plugin}`);
    assert.equal(plugin.kind, 'instrument', `${p.id}: ${p.plugin} is not an instrument`);
    assert.ok(p.plugin !== 'krypt.audioclip', `${p.id}: audio clip channels are not presets`);
    assert.equal(typeof p.params.gain, 'number', `${p.id}: every preset states its gain (it is gain-staged)`);
    problems.push(...paramProblems(p.id, plugin, p.params));
  }
  assert.deepEqual(problems, []);
});

test('FX chains use stock effects with on-spec params, no limiters, within the slot limit', () => {
  const problems: string[] = [];
  for (const p of P) {
    const fx = p.fx ?? [];
    assert.ok(fx.length <= MAX_FX_SLOTS, `${p.id}: ${fx.length} effects > ${MAX_FX_SLOTS} slots`);
    fx.forEach((f, i) => {
      const plugin = byId.get(f.type);
      assert.ok(plugin, `${p.id} fx ${i}: unknown effect ${f.type}`);
      assert.equal(plugin.kind, 'effect', `${p.id} fx ${i}: ${f.type} is not an effect`);
      assert.notEqual(f.type, 'krypt.limiter', `${p.id}: no limiters in instrument chains (that is the master's job)`);
      if (f.mix !== undefined) assert.ok(f.mix >= 0 && f.mix <= 1, `${p.id} fx ${i}: mix ${f.mix}`);
      problems.push(...paramProblems(`${p.id} fx ${i}`, plugin, f.params));
    });
  }
  assert.deepEqual(problems, []);
});

test('every chain starts its low end with a low cut (sensible for the role)', () => {
  const LOW_END = new Set<InstrumentRole>(['bass', 'sub', '808', 'kick']);
  for (const p of P) {
    const eqs = (p.fx ?? []).filter((f) => f.type === 'krypt.eq' && f.params.b1On === 1);
    assert.ok(eqs.length, `${p.id}: no EQ low cut in the chain`);
    const cut = Math.max(...eqs.map((f) => f.params.b1Freq));
    const deep = (p.range?.[0] ?? 127) < 36; // drones and impacts written below C2
    if (LOW_END.has(p.role) || p.alsoRoles?.includes('808')) assert.ok(cut >= 20 && cut <= 60, `${p.id}: low-end low cut at ${cut} Hz`);
    else if (!deep) assert.ok(cut >= 50, `${p.id}: low cut at ${cut} Hz is too low for a ${p.role}`);
  }
});

test('808, sub and mono bass presets are mono; 808s glide', () => {
  for (const p of P.filter((x) => x.role === '808')) {
    assert.equal(p.channel?.mono, true, `${p.id}: 808s are mono`);
    assert.ok((p.channel?.glideMs ?? 0) > 0, `${p.id}: 808s glide`);
    assert.equal(p.plugin, 'krypt.kick808', `${p.id}: 808s use Krypt 808`);
  }
  for (const p of P.filter((x) => x.role === 'sub' || x.role === 'bass')) assert.equal(p.channel?.mono, true, `${p.id}: bass/sub channels are mono`);
});

test('ranges are valid MIDI spans (low ≤ high)', () => {
  for (const p of P) {
    assert.ok(p.range, `${p.id}: range missing`);
    const [lo, hi] = p.range;
    assert.ok(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi <= 127 && lo <= hi, `${p.id}: range ${lo}..${hi}`);
  }
});

test('sampler presets only use the legacy factory samples, pack presets their own pack; other instruments carry no sample', () => {
  const legacy = new Set<string>(LEGACY_FACTORY_PATHS);
  for (const p of P) {
    const plugin = byId.get(p.plugin)!;
    if (plugin.usesSample) {
      assert.ok(p.sample, `${p.id}: ${p.plugin} needs a sample`);
      if (p.requires) assert.ok(p.sample.startsWith(`pack:${p.requires}/`), `${p.id}: sample ${p.sample} isn't in its pack ${p.requires}`);
      else assert.ok(legacy.has(p.sample), `${p.id}: sample ${p.sample} is not a legacy factory path`);
    } else {
      assert.equal(p.sample, undefined, `${p.id}: ${p.plugin} does not use a sample`);
    }
  }
});

test('names and descriptions avoid product, trademark and brand names', () => {
  const BANNED = /\b(serum|sylenth|nexus|massive|spire|omnisphere|kontakt|vital|surge|dx-?7|juno|jupiter|prophet|moog|minimoog|rhodes|wurli(tzer)?|hammond|leslie|clavinet|mellotron|solina|ott|909|808 ?state|tr-?\d+|tb-?303|roland|korg|yamaha|fruity|image-?line|splice|auto-?tune|linndrum|steinway)\b/i;
  for (const p of P) {
    for (const text of [p.name, p.description, ...p.tags]) assert.ok(!BANNED.test(text), `${p.id}: "${text}" names a product or brand`);
  }
});

test('every role has presets (≥ 4 for the core melodic and low-end roles)', () => {
  const CORE = new Set<InstrumentRole>(['lead', 'pluck', 'pad', 'keys', 'bass', '808', 'chord']);
  const count = new Map<InstrumentRole, number>();
  for (const p of P) count.set(p.role, (count.get(p.role) ?? 0) + 1);
  for (const r of INSTRUMENT_ROLES) {
    const n = count.get(r) ?? 0;
    const min = CORE.has(r) ? 4 : 2;
    assert.ok(n >= min, `role ${r} has ${n} preset(s), needs ≥ ${min}`);
  }
});

test('every genre has at least 12 presets that suit it, across several roles', () => {
  for (const g of GENRE_IDS) {
    const fits = P.filter((p) => p.genres.includes(g));
    assert.ok(fits.length >= 12, `genre ${g} has ${fits.length} preset(s), needs ≥ 12`);
    const roles = new Set(fits.map((p) => p.role));
    assert.ok(roles.size >= 6, `genre ${g} spans only ${roles.size} roles`);
  }
});

test('a genre-fitting sound resolves for the roles every beat needs', () => {
  // the playbooks ask select.ts for ROLE + genre: the pick must suit the genre (or at least its family)
  const NEEDS: InstrumentRole[] = ['lead', 'pad', 'chord', 'bass', 'kick', 'snare', 'hat'];
  for (const g of GENRE_IDS) {
    for (const role of NEEDS) {
      const p = pickPreset(P, role, g);
      assert.ok(p, `no ${role} preset for ${g}`);
      const fits = p.genres.length === 0 || p.genres.some((x: GenreId) => x === g || sameFamily(x, g));
      assert.ok(fits, `${role} for ${g} resolved to ${p.id} (${p.genres.join(', ')})`);
    }
  }
});

test('the defaults table names existing presets of the right role', () => {
  const ids = new Set(P.map((p) => p.id));
  for (const [genre, roles] of Object.entries(GENRE_DEFAULTS)) {
    assert.ok((GENRE_IDS as readonly string[]).includes(genre), `defaults for unknown genre ${genre}`);
    for (const [role, slug] of Object.entries(roles)) assert.ok(ids.has(`factory:${role}/${slug}`), `${genre} ${role} default factory:${role}/${slug} does not exist`);
  }
});

// Synth presets and sound-pack presets each get at most one default per (role, genre): a pack's default takes over
// only once that pack is installed (uninstalled pack presets are gated out before ranking).
test('defaultFor: only genres the preset suits, at most one preset per (role, genre) among synths and among packs', () => {
  const claimed = new Map<string, string>();
  for (const p of P) {
    for (const g of p.defaultFor ?? []) {
      assert.ok(p.genres.includes(g), `${p.id} is the ${g} default but does not list ${g} in its genres`);
      const key = `${p.requires ? 'pack' : 'synth'}:${p.role}:${g}`;
      assert.ok(!claimed.has(key), `two ${p.role} defaults for ${g}: ${claimed.get(key)} and ${p.id}`);
      claimed.set(key, p.id);
    }
  }
});

test('every genre has a default lead, pluck, pad-or-chord and low end (bass, 808 or sub)', () => {
  for (const g of GENRE_IDS) {
    const has = (role: InstrumentRole) => P.some((p) => !p.requires && p.role === role && p.defaultFor?.includes(g));
    assert.ok(has('lead'), `${g}: no default lead`);
    assert.ok(has('pluck'), `${g}: no default pluck`);
    assert.ok(has('pad') || has('chord'), `${g}: no default pad or chord`);
    assert.ok(has('bass') || has('808') || has('sub'), `${g}: no default bass, 808 or sub`);
  }
});

test('pickPreset returns the genre default for its role: the synth one without packs, the pack one once installed', () => {
  const synths = P.filter((p) => !p.requires);
  for (const p of P) {
    for (const g of p.defaultFor ?? []) {
      const pick = pickPreset(p.requires ? P : synths, p.role, g);
      assert.equal(pick?.id, p.id, `${p.role} for ${g} picked ${pick?.id}, expected the default ${p.id}`);
    }
  }
});

run('presets-factory');
