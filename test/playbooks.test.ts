import assert from 'node:assert/strict';
import { test, run } from './harness';
import { PLAYBOOKS, listPlaybooks, playbookFor, type Playbook } from '@shared/playbooks';
import type { PlaybookPart, SectionKind, TransitionKind } from '@shared/playbooks/types';
import { GENRES, GENRE_IDS } from '@shared/sounds/genres';
import { CHAIN_ROLES, INSTRUMENT_ROLES, SAMPLE_KINDS, type ChainRole, type InstrumentRole } from '@shared/sounds/types';
import { zChainPreset } from '@shared/sounds/schema';
import { CHAIN_PRESETS } from '@shared/sounds/factory/chains';
import { INSTRUMENT_PRESETS } from '@shared/sounds/factory/instruments';
import { pickPreset, roleFromName } from '@shared/sounds/select';
import { parse, formatIssues } from '@shared/kpn';
import { pluginById } from '@shared/plugins/catalog';
import { clampToSpec, type ParamSpec } from '@shared/plugins/types';
import { GROOVE_IDS } from '@shared/grooves/apply';

const SECTION_KINDS: SectionKind[] = ['intro', 'verse', 'pre', 'hook', 'chorus', 'build', 'drop', 'breakdown', 'bridge', 'break', 'outro'];
const TRANSITIONS: TransitionKind[] = ['riser', 'reverse-cymbal', 'snare-roll', 'drum-fill', 'filter-sweep', 'impact', 'downlifter', 'sub-drop', 'silence', 'crash', 'whoosh', 'tape-stop', 'swell'];
const DRUM_ROLES: InstrumentRole[] = ['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc', 'tom'];
const LOW_ROLES: InstrumentRole[] = ['808', 'sub', 'bass'];
const MUSIC_ROLES: InstrumentRole[] = ['lead', 'pluck', 'pad', 'keys', 'piano', 'bell', 'arp', 'stab', 'chord', 'strings', 'brass', 'vox'];
const BANNED = [/\b909\b/, /\bTR-\d/i, /serum/i, /sylenth/i, /\bnexus\b/i, /auto-?tune/i, /\bOTT\b/, /linn ?drum/i, /splice/i, /fruity/i, /image-line/i, /fl studio/i, /massive/i, /vital\b/i, /\bLFO ?tool\b/i];

const LATENT = new Set(['krypt.drive', 'krypt.clipper', 'krypt.limiter', 'krypt.pitch', 'krypt.heat', 'krypt.grain']);

const pb = (id: string): Playbook => {
  const p = playbookFor(id);
  assert.ok(p, `no playbook for ${id}`);
  return p;
};
const partOf = (p: Playbook, name: string): PlaybookPart | undefined => p.parts.find((x) => x.name.toLowerCase() === name.toLowerCase());
const chainPath = (role: ChainRole) => role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const textOf = (o: unknown): string => JSON.stringify(o);

test('every genre id has exactly one playbook, in GENRE_IDS order', () => {
  assert.equal(PLAYBOOKS.length, GENRE_IDS.length);
  assert.deepEqual(
    PLAYBOOKS.map((p) => p.id),
    [...GENRE_IDS],
  );
  assert.equal(listPlaybooks(), PLAYBOOKS);
  for (const id of GENRE_IDS) assert.equal(pb(id).id, id);
});

test('playbookFor resolves ids, display names and every alias; unknown → null', () => {
  for (const g of GENRES) {
    assert.equal(playbookFor(g.id)?.id, g.id, g.id);
    assert.equal(playbookFor(g.name)?.id, g.id, g.name);
    for (const a of g.aliases) assert.equal(playbookFor(a)?.id, g.id, `alias "${a}"`);
    assert.equal(playbookFor(g.name.toUpperCase())?.id, g.id);
  }
  assert.equal(playbookFor('polka'), null);
  assert.equal(playbookFor(''), null);
  assert.equal(playbookFor(null), null);
  assert.equal(playbookFor(undefined), null);
});

test('tempo, swing, grid, keys and prose fields are sane', () => {
  for (const p of PLAYBOOKS) {
    const at = `${p.id}:`;
    assert.ok(p.name && p.summary.length > 120, `${at} name + a real summary`);
    assert.ok(p.bpm.min >= 50 && p.bpm.max <= 200 && p.bpm.min <= p.bpm.typical && p.bpm.typical <= p.bpm.max, `${at} bpm ${JSON.stringify(p.bpm)}`);
    assert.ok(p.swing >= 0 && p.swing <= 100, `${at} swing`);
    if (p.grid !== undefined) assert.ok([16, 24, 32].includes(p.grid), `${at} grid ${p.grid}`);
    assert.ok(p.keys.modes.length >= 1 && p.keys.common.length >= 3, `${at} keys`);
    for (const k of p.keys.common) assert.ok(parse(`pattern "k" bars=1 key=${k}\nx: x...x...x...x...`).ok, `${at} key ${k} must be a key the KPN parser reads`);
    assert.ok(p.harmony.progressions.length >= 2 && p.harmony.rhythm && p.harmony.voicing, `${at} harmony`);
    assert.ok(p.melody.length > 60, `${at} melody guidance`);
    assert.ok(p.transitions.length > 60, `${at} transitions guidance`);
    assert.ok(p.mistakes.length >= 6, `${at} at least 6 mistakes`);
    assert.ok(p.mix.levels.length > 40, `${at} level plan`);
  }
});

test('parts: unique KPN-safe names, valid roles / sample kinds / ranges / chains / buses / ducking', () => {
  for (const p of PLAYBOOKS) {
    const names = new Set<string>();
    const buses = new Set((p.mix.buses ?? []).map((b) => b.name));
    assert.ok(p.parts.length >= 6 && p.parts.length <= 16, `${p.id}: 6-16 parts (${p.parts.length})`);
    for (const part of p.parts) {
      const at = `${p.id}/${part.name}`;
      assert.match(part.name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/, `${at}: channel names are single words so KPN needs no quotes`);
      assert.ok(!names.has(part.name.toLowerCase()), `${at}: duplicate part name`);
      names.add(part.name.toLowerCase());
      assert.ok(INSTRUMENT_ROLES.includes(part.role), `${at}: role ${part.role}`);
      if (part.sample) assert.ok((SAMPLE_KINDS as readonly string[]).includes(part.sample), `${at}: sample kind ${part.sample}`);
      if (DRUM_ROLES.includes(part.role)) assert.ok(part.sample, `${at}: drum parts name a factory sample kind`);
      if (part.range) assert.ok(part.range[0] >= 0 && part.range[1] <= 127 && part.range[0] < part.range[1], `${at}: range`);
      if (part.chain) assert.ok(CHAIN_ROLES.includes(part.chain), `${at}: chain role ${part.chain}`);
      if (part.bus) assert.ok(buses.has(part.bus), `${at}: bus "${part.bus}" is not in mix.buses`);
      if (part.duckUnder) {
        assert.ok(partOf(p, part.duckUnder), `${at}: ducks under unknown part ${part.duckUnder}`);
        assert.notEqual(part.duckUnder.toLowerCase(), part.name.toLowerCase(), `${at}: ducks under itself`);
      }
      assert.ok(part.writing.length > 40, `${at}: writing guidance`);
      const implied = roleFromName(part.name);
      assert.ok(implied === null || implied === part.role, `${at}: the name implies role ${implied} but the part is ${part.role} (an agent writing KPN first would get the wrong default sound)`);
    }
    assert.ok(p.parts.some((x) => x.role === 'kick'), `${p.id}: has a kick`);
    assert.ok(p.parts.some((x) => LOW_ROLES.includes(x.role)), `${p.id}: has a low-end part`);
    assert.ok(p.parts.some((x) => MUSIC_ROLES.includes(x.role)), `${p.id}: has a music part`);
  }
});

test('arrangement: known parts, 4-bar phrases, bar total within targets, real energy contrast', () => {
  for (const p of PLAYBOOKS) {
    const at = `${p.id}:`;
    assert.ok(p.arrangement.length >= 5, `${at} at least 5 sections`);
    const used = new Set<string>();
    let total = 0;
    for (const s of p.arrangement) {
      const where = `${at} ${s.label}`;
      assert.ok(SECTION_KINDS.includes(s.kind), `${where}: kind ${s.kind}`);
      assert.ok(Number.isInteger(s.bars) && s.bars >= 4 && s.bars % 4 === 0, `${where}: bars ${s.bars} must be whole 4-bar phrases`);
      assert.ok(s.energy >= 0 && s.energy <= 1, `${where}: energy ${s.energy}`);
      assert.ok(s.parts.length >= 1, `${where}: plays something`);
      for (const name of s.parts) {
        assert.ok(partOf(p, name), `${where}: part "${name}" is not in parts`);
        used.add(name.toLowerCase());
      }
      assert.equal(new Set(s.parts.map((x) => x.toLowerCase())).size, s.parts.length, `${where}: duplicate part`);
      for (const t of s.transitionIn ?? []) assert.ok(TRANSITIONS.includes(t), `${where}: transition ${t}`);
      total += s.bars;
    }
    assert.equal(new Set(p.arrangement.map((s) => s.label)).size, p.arrangement.length, `${at} section labels are unique`);
    assert.ok(total >= p.targets.bars[0] && total <= p.targets.bars[1], `${at} arrangement is ${total} bars, targets ${p.targets.bars.join('-')}`);
    for (const part of p.parts) assert.ok(used.has(part.name.toLowerCase()), `${at} part ${part.name} never plays`);
    const energies = p.arrangement.map((s) => s.energy);
    const peak = Math.max(...energies);
    assert.ok(peak >= 0.85, `${at} the peak section reaches 0.85+`);
    assert.ok(peak - Math.min(...energies) >= 0.4, `${at} energy contrast of at least 0.4`);
    assert.ok(p.arrangement[0].energy < peak, `${at} it does not open at full energy`);
    assert.ok(p.arrangement[p.arrangement.length - 1].energy < peak, `${at} it does not end at full energy`);
    const minutes = (total * 4 * 60) / p.bpm.typical / 60;
    assert.ok(minutes >= 1.5 && minutes <= 8, `${at} ${minutes.toFixed(1)} min at ${p.bpm.typical} bpm`);
  }
});

test('patterns: every KPN example parses cleanly, uses the playbook part names and stays in range', () => {
  for (const p of PLAYBOOKS) {
    const at = `${p.id}:`;
    assert.ok(p.patterns.length >= 4, `${at} at least 4 patterns`);
    assert.equal(new Set(p.patterns.map((x) => x.name)).size, p.patterns.length, `${at} pattern names are unique`);
    const sectionWords = new Set([...p.arrangement.map((s) => s.kind), ...p.arrangement.map((s) => s.label.toLowerCase())]);
    let drumPatterns = 0;
    let lowPatterns = 0;
    let musicPatterns = 0;
    for (const pat of p.patterns) {
      const where = `${at} pattern "${pat.name}"`;
      assert.ok(pat.for.length >= 1, `${where}: names the sections it suits`);
      for (const f of pat.for) assert.ok(sectionWords.has(f.toLowerCase()), `${where}: "${f}" is not a section kind or label in the arrangement`);
      assert.match(pat.kpn, /^pattern "[^"]+" bars=\d+/, `${where}: starts with a pattern header with bars=`);
      const r = parse(pat.kpn, { requireHeader: true });
      assert.ok(r.ok, `${where}:\n${formatIssues(r.errors)}`);
      assert.deepEqual(
        r.warnings.map((w) => w.message),
        [],
        `${where}: KPN warnings`,
      );
      let drums = false;
      for (const t of r.tracks) {
        const part = partOf(p, t.name);
        assert.ok(part, `${where}: channel "${t.name}" is not a part of the playbook`);
        assert.ok(t.notes.length > 0, `${where}: ${t.name} has no notes`);
        if (DRUM_ROLES.includes(part.role) && t.kind === 'grid') drums = true;
        if (DRUM_ROLES.includes(part.role) && part.role !== 'tom' && part.role !== 'perc') {
          assert.equal(t.kind, 'grid', `${where}: drum part ${t.name} is written as a step grid`);
        } else if (!DRUM_ROLES.includes(part.role) && part.role !== 'fx' && part.role !== 'texture') {
          assert.equal(t.kind, 'melodic', `${where}: ${t.name} is written with note tokens`);
          if (LOW_ROLES.includes(part.role)) lowPatterns++;
          if (MUSIC_ROLES.includes(part.role)) musicPatterns++;
        }
        if (part.range && t.kind === 'melodic') {
          const [lo, hi] = part.range;
          for (const n of t.notes) assert.ok(n.key >= lo && n.key <= hi, `${where}: ${t.name} note ${n.key} is outside its range ${lo}-${hi}`);
        }
      }
      if (drums) drumPatterns++;
    }
    assert.ok(drumPatterns >= 2, `${at} a main drum pattern and a variation or fill`);
    assert.ok(lowPatterns >= 1, `${at} a bassline example`);
    assert.ok(musicPatterns >= 1, `${at} a chord or melody example`);
  }
});

test('mix plan: buses, sends and levels reference real parts with sane amounts', () => {
  for (const p of PLAYBOOKS) {
    const at = `${p.id}:`;
    const busNames = (p.mix.buses ?? []).map((b) => b.name);
    assert.equal(new Set(busNames).size, busNames.length, `${at} unique bus names`);
    for (const b of p.mix.buses ?? []) assert.ok(CHAIN_ROLES.includes(b.chain), `${at} bus ${b.name} chain ${b.chain}`);
    assert.ok((p.mix.sends ?? []).length >= 1, `${at} at least one send effect`);
    for (const s of p.mix.sends ?? []) {
      assert.ok(s.chain === 'reverbSend' || s.chain === 'delaySend', `${at} send ${s.name} is a reverb or delay return`);
      assert.ok(s.from.length >= 1, `${at} send ${s.name} is fed`);
      for (const f of s.from) {
        assert.ok(partOf(p, f.part), `${at} send ${s.name} from unknown part ${f.part}`);
        assert.ok(f.amount > 0 && f.amount <= 0.6, `${at} send ${s.name} from ${f.part}: amount ${f.amount}`);
        const role = partOf(p, f.part)!.role;
        assert.ok(!LOW_ROLES.includes(role) && role !== 'kick', `${at} never send ${f.part} (${role}) to a ${s.chain}`);
      }
    }
    for (const part of p.parts) if (part.duckUnder) assert.ok(!LOW_ROLES.includes(partOf(p, part.duckUnder)!.role), `${at} ${part.name} ducks under a drum, not under the bass`);
  }
});

test('numeric targets for review_song are sane', () => {
  for (const p of PLAYBOOKS) {
    const t = p.targets;
    const at = `${p.id}:`;
    assert.ok(t.lufs >= -16 && t.lufs <= -6, `${at} lufs ${t.lufs}`);
    assert.ok(t.truePeakDb <= -0.5 && t.truePeakDb >= -3, `${at} true peak ${t.truePeakDb}`);
    assert.ok(Number.isInteger(t.bars[0]) && Number.isInteger(t.bars[1]) && t.bars[0] >= 32 && t.bars[0] < t.bars[1] && t.bars[1] <= 320, `${at} bars ${t.bars}`);
    for (const [band, r] of Object.entries(t.bands ?? {})) assert.ok(r[0] < r[1] && r[0] >= -40 && r[1] <= 24, `${at} band ${band} ${r}`);
    assert.ok(t.bands && Object.keys(t.bands).length >= 4, `${at} checks at least 4 bands`);
    assert.ok(t.contrastLu && t.contrastLu[0] >= 2 && t.contrastLu[0] < t.contrastLu[1] && t.contrastLu[1] <= 24, `${at} contrast ${t.contrastLu}`);
    assert.ok(t.minCorrelation !== undefined && t.minCorrelation >= 0 && t.minCorrelation <= 0.8, `${at} min correlation`);
    assert.ok(t.maxStaticBars !== undefined && t.maxStaticBars >= 4 && t.maxStaticBars <= 32, `${at} max static bars`);
    assert.ok(t.minHatVelocitySpread !== undefined && t.minHatVelocitySpread >= 0 && t.minHatVelocitySpread <= 25, `${at} hat velocity spread`);
  }
});

test('groove recommendation: a known template, sane amounts, real parts, drums first', () => {
  for (const p of PLAYBOOKS) {
    const g = p.groove;
    assert.ok(g, `${p.id}: recommends a groove template`);
    assert.ok(GROOVE_IDS.includes(g.template), `${p.id}: groove template "${g.template}" is not one of ${GROOVE_IDS.join(', ')}`);
    assert.ok(g.amount > 0 && g.amount <= 1 && g.velocity >= 0 && g.velocity <= 1, `${p.id}: groove amounts`);
    assert.ok(g.parts.length >= 1, `${p.id}: groove parts`);
    for (const name of g.parts) assert.ok(partOf(p, name), `${p.id}: groove part ${name} is not in parts`);
    assert.ok(DRUM_ROLES.includes(partOf(p, g.parts[0])!.role), `${p.id}: the groove starts with a drum part`);
    assert.ok(p.parts.some((x) => x.writing.includes(`groove "${g.template}"`)),`${p.id}: a part's writing tells the agent to apply groove "${g.template}"`);
  }
});

test('no product names, trademarks or FL trade dress in playbooks and chain presets', () => {
  for (const p of PLAYBOOKS) for (const re of BANNED) assert.ok(!re.test(textOf(p)), `${p.id} mentions ${re}`);
  for (const c of CHAIN_PRESETS) for (const re of BANNED) assert.ok(!re.test(textOf(c)), `${c.id} mentions ${re}`);
});

test('chain presets: schema-valid, unique ids under factory:chain/<role>/, every role covered', () => {
  assert.ok(CHAIN_PRESETS.length >= 30, `about 30+ chain presets (${CHAIN_PRESETS.length})`);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const c of CHAIN_PRESETS) {
    const r = zChainPreset.safeParse(c);
    assert.ok(r.success, `${c.id}: ${r.success ? '' : r.error.message}`);
    assert.ok(c.id.startsWith(`factory:chain/${chainPath(c.role)}/`), `${c.id}: id path matches role ${c.role}`);
    assert.ok(!ids.has(c.id), `${c.id}: duplicate id`);
    ids.add(c.id);
    assert.ok(!names.has(`${c.role}/${c.name}`), `${c.id}: duplicate name within ${c.role}`);
    names.add(`${c.role}/${c.name}`);
    assert.ok(c.description.length > 40 && c.tags.length >= 2, `${c.id}: description + tags`);
  }
  for (const role of CHAIN_ROLES) assert.ok(CHAIN_PRESETS.some((c) => c.role === role), `no chain preset for role ${role}`);
});

test('chain presets: stock effects only, every param valid and already clamped to its spec', () => {
  for (const c of CHAIN_PRESETS) {
    for (const f of c.fx) {
      const d = pluginById(f.type);
      if (!d || d.kind !== 'effect' || !f.type.startsWith('krypt.')) assert.fail(`${c.id}: ${f.type} is not a stock effect`);
      assert.notEqual(f.type, 'krypt.pitch', `${c.id}: pitch correction stays a separate tool`);
      assert.notEqual(f.type, 'krypt.analyzer', `${c.id}: analyzers are not part of a sound`);
      for (const [k, v] of Object.entries(f.params)) {
        const spec: ParamSpec | undefined = d.params.find((s) => s.id === k);
        if (!spec) assert.fail(`${c.id}: ${f.type} has no param "${k}"`);
        assert.equal(clampToSpec(spec, v), v, `${c.id}: ${f.type}.${k} = ${v} is outside ${spec.min}..${spec.max} or off its step`);
      }
      if (f.mix !== undefined) assert.ok(f.mix >= 0 && f.mix <= 1, `${c.id}: ${f.type} mix`);
      if (LATENT.has(f.type)) assert.ok(f.mix === undefined || f.mix === 1, `${c.id}: ${f.type} has latency and must run at slot mix 1`);
    }
  }
});

test('chain presets: masters end in a true-peak limiter at or under -1 dBTP; sends are 100% wet', () => {
  for (const c of CHAIN_PRESETS) {
    if (c.role === 'master') {
      assert.ok(c.targetLufs !== undefined && c.targetLufs >= -16 && c.targetLufs <= -6, `${c.id}: targetLufs`);
      const last = c.fx[c.fx.length - 1];
      assert.equal(last.type, 'krypt.limiter', `${c.id}: the limiter is last`);
      assert.ok(last.params.ceiling <= -1 && last.params.truePeak === 1, `${c.id}: ceiling <= -1 dBTP with true peak on`);
    } else assert.equal(c.targetLufs, undefined, `${c.id}: only masters carry a loudness target`);
    if (c.role === 'reverbSend' || c.role === 'delaySend') {
      const returns = c.role === 'reverbSend' ? ['krypt.reverb', 'krypt.grain'] : ['krypt.delay', 'krypt.tapeecho'];
      const wet = c.fx.find((f) => returns.includes(f.type));
      assert.ok(wet && wet.mix === 1, `${c.id}: the return effect runs 100% wet`);
      assert.ok(c.fx.some((f) => f.type === 'krypt.eq'), `${c.id}: an EQ keeps the return out of the low mids`);
    }
  }
});

test('every chain role a playbook asks for resolves to a chain preset; masters match the loudness target', () => {
  for (const p of PLAYBOOKS) {
    const asks: Array<{ role: ChainRole; tags?: string[]; what: string }> = [{ role: 'master', tags: p.mix.master.tags, what: 'master' }];
    for (const b of p.mix.buses ?? []) asks.push({ role: b.chain, tags: b.tags, what: `bus ${b.name}` });
    for (const s of p.mix.sends ?? []) asks.push({ role: s.chain, tags: s.tags, what: `send ${s.name}` });
    for (const part of p.parts) if (part.chain) asks.push({ role: part.chain, tags: part.tags, what: `part ${part.name}` });
    for (const a of asks) assert.ok(pickPreset(CHAIN_PRESETS, a.role, p.id, a.tags), `${p.id}: ${a.what} (${a.role}) has no chain preset`);
    const master = pickPreset(CHAIN_PRESETS, 'master', p.id, p.mix.master.tags)!;
    assert.ok(Math.abs(master.targetLufs! - p.targets.lufs) <= 1.5, `${p.id}: the master pick ${master.id} targets ${master.targetLufs} LUFS, the playbook ${p.targets.lufs}`);
    assert.ok(master.genres.includes(p.id), `${p.id}: the master pick ${master.id} is made for this genre`);
  }
});

test('every part resolves to an instrument preset or a factory sample kind (once presets exist)', () => {
  if (INSTRUMENT_PRESETS.length === 0) return;
  for (const p of PLAYBOOKS)
    for (const part of p.parts) {
      if (part.sample) continue;
      assert.ok(pickPreset(INSTRUMENT_PRESETS, part.role, p.id, part.tags), `${p.id}/${part.name}: no instrument preset for role ${part.role}`);
    }
});

await run('playbooks');
