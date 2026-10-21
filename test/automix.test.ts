import assert from 'node:assert/strict';
import { test, run } from './harness';
import { AUTO_MIX_PRESETS, autoPreset, presetById, presetForGenre } from '@shared/automix/presets';
import { clampIntent, lufsInText, parseIntent, presetInText, tuneInText } from '@shared/automix/intent';
import { applyPlan, findKryptSlot, gainToDb, isKryptSlot, meetsTargets, planAutoMix, type ApplyIO, type PlanInput, type PlanMeasure } from '@shared/automix/plan';
import { detectRoles } from '@shared/automix/roles';
import { playbookFor } from '@shared/playbooks';
import { factoryChainPresets } from '@shared/sounds/factory';
import { clampToSpec } from '@shared/plugins/types';
import type { AutoMixIntent, AutoMixMode } from '@shared/automix/types';
import type { DocHost } from '@shared/doc/DocHost';
import { automixCatalog, measure, mixDoc } from './automix-fixtures';

test('presets: the eleven cards, unique ids, numbers inside their genres\' playbook targets', () => {
  assert.equal(AUTO_MIX_PRESETS.length, 11);
  assert.equal(new Set(AUTO_MIX_PRESETS.map((p) => p.id)).size, 11);
  const want: Record<string, number> = { 'streaming-clean': -14, balanced: -11, 'loud-trap': -8, 'club-edm': -8, 'warm-rnb': -11, lofi: -13, 'pop-polish': -9, 'hiphop-punch': -9, 'rock-live': -10, 'podcast-voice': -16, 'phonk-slam': -7 };
  for (const p of AUTO_MIX_PRESETS) {
    assert.equal(p.targetLufs, want[p.id], p.id);
    assert.equal(p.truePeak, -1, `${p.id}: the factory chains' -1 dBTP ceiling`);
    for (const k of ['punch', 'warmth', 'brightness', 'width', 'vocalSpace'] as const) assert.ok(p[k] >= 0 && p[k] <= 1, `${p.id}.${k}`);
    for (const g of p.genres) {
      const pb = playbookFor(g);
      assert.ok(pb, `${p.id}: ${g} has a playbook`);
      assert.ok(Math.abs(pb!.targets.lufs - p.targetLufs) <= 1, `${p.id} ${p.targetLufs} vs ${g} ${pb!.targets.lufs} (review_song: ±1.5 is on target)`);
      for (const [band, range] of Object.entries(pb!.targets.bands ?? {})) {
        const v = p.tone[band as keyof typeof p.tone];
        assert.ok(v >= range![0] && v <= range![1], `${p.id} ${band} ${v} inside ${g} ${range}`);
      }
    }
  }
  const all = AUTO_MIX_PRESETS.flatMap((p) => p.genres);
  assert.equal(new Set(all).size, all.length, 'no genre on two cards');
});

test('presets: lookup by id / name / genre alias, auto pick from the genre then the analysis', () => {
  assert.equal(presetById('Loud Trap / Drill')?.id, 'loud-trap');
  assert.equal(presetById('nope'), null);
  assert.equal(presetForGenre('uk drill')?.id, 'loud-trap');
  assert.equal(presetForGenre('Deep House')?.id, 'club-edm');
  assert.equal(presetForGenre('neo soul')?.id, 'warm-rnb');
  assert.equal(autoPreset('lofi hip hop').preset.id, 'lofi');
  assert.equal(autoPreset('', { lufs: -10, subVsMid: 11, highVsMid: -8 }).preset.id, 'loud-trap');
  assert.equal(autoPreset(null, { lufs: -18, subVsMid: 2, highVsMid: -18 }).preset.id, 'lofi');
  assert.equal(autoPreset(undefined).preset.id, 'balanced');
});

test('intent: the plan\'s example prompt', () => {
  const i = parseIntent('vocals on top, punchy, not harsh, streaming loud');
  assert.equal(i.source, 'keywords');
  assert.equal(i.vocalsForward, 1);
  assert.equal(i.punchier, 1);
  assert.equal(i.lessHarsh, 1);
  assert.equal(i.targetLufs, -14);
  assert.equal(i.louder, undefined, 'streaming sets the target instead');
  assert.match(i.summary, /vocals forward/);
});

test('intent: negations, "too", intensity and complaints', () => {
  assert.equal(parseIntent('less reverb').vocalSpace, -1);
  assert.equal(parseIntent('no reverb on the vocals').vocalSpace, -1);
  assert.equal(parseIntent('more reverb').vocalSpace, 1);
  assert.equal(parseIntent('too bright').brighter, -1);
  assert.equal(parseIntent('too dark').brighter, 1);
  assert.equal(parseIntent('too much bass').bassier, -1);
  assert.equal(parseIntent('a lot more bass').bassier, 2);
  assert.equal(parseIntent('a bit brighter').brighter, 1);
  assert.equal(parseIntent('much louder').louder, 2);
  assert.equal(parseIntent('the vocals are buried').vocalsForward, 1);
  assert.equal(parseIntent('vocals too loud').vocalsForward, -1);
  assert.equal(parseIntent('vocals too loud').louder, undefined, '"loud" about the vocals is not the master');
  assert.equal(parseIntent('sibilant esses').lessHarsh, 1);
  assert.equal(parseIntent('smooth').lessHarsh, 1);
  assert.equal(parseIntent('crushed').cleaner, -1);
  assert.equal(parseIntent('crushed and aggressive').cleaner, -2, 'two words the same way');
  assert.equal(parseIntent('clean, natural').cleaner, 2);
  assert.equal(parseIntent('mono').wider, -1);
  assert.equal(parseIntent('wider').wider, 1);
  assert.equal(parseIntent('muddy').warmer, -1);
  assert.equal(parseIntent('warm tape vibe').warmer, 1);
  assert.equal(parseIntent('vocals too soft').punchier, undefined);
});

test('intent: LUFS numbers and words, genre words → a card, Krypt Tune', () => {
  assert.equal(lufsInText('master it to -9 LUFS'), -9);
  assert.equal(lufsInText('−11.5 lufs please'), -11.5);
  assert.equal(lufsInText('lufs -7'), -7);
  assert.equal(lufsInText('9 LUFS'), -9);
  assert.equal(lufsInText('ready for spotify'), -14);
  assert.equal(lufsInText('podcast'), -16);
  assert.equal(lufsInText('-60 LUFS'), -24, 'clamped');
  assert.equal(lufsInText('make it pop'), null);
  assert.equal(parseIntent('hard uk drill mix').presetId, 'loud-trap');
  assert.equal(parseIntent('club ready').presetId, 'club-edm');
  assert.equal(presetInText('a lofi chill tape'), 'lofi');
  assert.equal(presetInText('podcast voice'), 'podcast-voice');
  assert.equal(presetInText('nothing here'), null);
  assert.equal(tuneInText('tune the vocals'), 'natural');
  assert.equal(tuneInText('hard tune like t-pain'), 'hard');
  assert.equal(tuneInText('no tuning please'), null);
  assert.equal(tuneInText('make it louder'), null);
  assert.equal(parseIntent('').summary, '');
});

test('intent: clampIntent makes any JSON safe', () => {
  const i = clampIntent({ presetId: 'LOFI', targetLufs: -99, louder: 7, brighter: -3.6, warmer: 'x', wider: 0.4, evil: 1, summary: 'a\u0000b'.repeat(200) }, 'ai');
  assert.equal(i.presetId, 'lofi');
  assert.equal(i.targetLufs, -24);
  assert.equal(i.louder, 2);
  assert.equal(i.brighter, -2);
  assert.equal(i.warmer, undefined);
  assert.equal(i.wider, undefined, '0.4 rounds to 0');
  assert.equal((i as unknown as Record<string, unknown>).evil, undefined);
  assert.ok(i.summary.length <= 200 && !i.summary.includes('\u0000'));
  assert.equal(clampIntent({ presetId: 'not-a-card', targetLufs: 0 }, 'ai').presetId, undefined);
  assert.equal(clampIntent(null, 'ai').summary, '');
  assert.equal(clampIntent('junk', 'keywords').source, 'keywords');
});

test('roles: names, the drum bus, stem origin and a voice by its sound', () => {
  const { doc, ids } = mixDoc({ drumBus: true });
  const roles = detectRoles(doc.project, doc.catalog);
  assert.equal(roles[ids.Kick].role, 'kick');
  assert.equal(roles[ids.Bass].role, 'bass');
  assert.equal(roles[ids.Snare].role, 'snare');
  assert.equal(roles[ids.Hats].role, 'hats');
  assert.equal(roles[ids.Keys].role, 'keys');
  assert.equal(roles[ids.Lead].role, 'lead');
  assert.ok(roles[ids.Vocals].vocal);
  assert.equal(roles[ids['Drum Bus']].role, 'bus');
  assert.ok(roles[ids['Drum Bus']].drumBus);
  assert.equal(roles[ids.Kick].topLevel, false, 'the kick feeds the bus');
  assert.ok(detectRoles(doc.project, doc.catalog, { vocalInserts: ['Lead'] })[ids.Lead].vocal);
  const ex = <T>(cmd: string, args: unknown): T => doc.exec<T>(cmd, args, { actor: { kind: 'user' } }).data as T;
  const track = doc.project.playlist.trackOrder[0];
  const a = ex<{ insertId: string; channelId: string; sampleId: string }>('playlist.addAudio', { path: 'C:\\x\\Take 3.wav', trackId: track, start: 0 });
  ex('mixer.setInsert', { id: a.insertId, name: 'Take 3' });
  const sound = { [a.insertId]: { bands: { sub: -50, low: -26, lowMid: -22, mid: -20, highMid: -23, high: -31 }, centroidHz: 1800 } };
  const r2 = detectRoles(doc.project, doc.catalog, { sound });
  assert.ok(r2[a.insertId].vocal);
  assert.equal(r2[a.insertId].why, 'sound');
  const bed = ex<{ insertId: string }>('playlist.addAudio', { path: 'C:/x/lemezia 2.wav', trackId: track, start: 0 });
  ex('mixer.setInsert', { id: bed.insertId, name: 'lemezia 2 · Full mix' });
  const r3 = detectRoles(doc.project, doc.catalog, { sound: { ...sound, [bed.insertId]: sound[a.insertId] } });
  assert.equal(r3[bed.insertId].vocal, false);
  assert.equal(r3[bed.insertId].role, 'other');
});

function io(doc: DocHost): ApplyIO {
  return {
    project: () => doc.project,
    catalog: doc.catalog,
    exec: <T>(cmd: string, args: unknown): T => {
      const r = doc.exec<T>(cmd, args, { actor: { kind: 'user' } });
      if (!r.ok) throw new Error(`${cmd}: ${r.message}`);
      return r.data as T;
    },
    chain: (id) => factoryChainPresets().find((c) => c.id === id) ?? null,
  };
}

function input(doc: DocHost, mode: AutoMixMode, m: PlanMeasure, extra: Partial<PlanInput> = {}): PlanInput {
  const preset = extra.preset ?? presetById('pop-polish')!;
  return { mode, preset, intent: null, target: { lufs: preset.targetLufs, truePeak: preset.truePeak }, keepUserFx: true, project: doc.project, catalog: doc.catalog, measure: m, roles: detectRoles(doc.project, doc.catalog), pass: 1, ...extra };
}

const master = (doc: DocHost) => doc.project.mixer.inserts[doc.project.mixer.masterId];
const kslot = (doc: DocHost, insertId: string, kind: Parameters<typeof findKryptSlot>[1]) => {
  const ins = doc.project.mixer.inserts[insertId];
  const id = findKryptSlot(ins, kind, true);
  return id ? ins.slots[id] : undefined;
};

test("plan master: a first pass never lowers the ceiling for the unlimited song's peaks; a later pass corrects our own overshoot", () => {
  const { doc, ids } = mixDoc();
  const loud = measure(ids, { master: { lufs: -10.3, truePeak: -0.06 } });
  applyPlan(planAutoMix(input(doc, 'master', loud, { target: { lufs: -9.6, truePeak: -1 } })), io(doc), { keepUserFx: true });
  assert.equal(kslot(doc, doc.project.mixer.masterId, 'limiter')!.params.ceiling, -1.1, 'first pass: the ceiling sits just under the target');
  const over = measure(ids, { master: { lufs: -9.6, truePeak: -0.7 } });
  applyPlan(planAutoMix(input(doc, 'master', over, { target: { lufs: -9.6, truePeak: -1 }, pass: 2 })), io(doc), { keepUserFx: true });
  assert.equal(kslot(doc, doc.project.mixer.masterId, 'limiter')!.params.ceiling, -1.5);
});

test('plan master + reference width: a near-mono reference only eases a stereo song (≥ 85%), never folds it', () => {
  const { doc, ids } = mixDoc();
  const m = measure(ids, { master: { lufs: -12, width: 0.2, correlation: 0.6 } });
  const plan = planAutoMix(input(doc, 'master', m, { target: { lufs: -10, truePeak: -1 }, widthTarget: 0.02 }));
  const im = plan.ops.find((o) => o.op === 'slot' && o.kind === 'imager');
  assert.ok(im && im.op === 'slot' && im.params.midWidth === 0.85 && im.params.highWidth === 0.85, JSON.stringify(im));
  assert.ok(plan.notes.some((n) => /only eased \(85% at least\)/.test(n)));
});

test('plan master: a louder target raises the limiter input; the limiter is last at the ceiling', () => {
  const gains: number[] = [];
  for (const lufs of [-12, -9]) {
    const { doc, ids } = mixDoc();
    const m = measure(ids, { master: { lufs: -14 } });
    const plan = planAutoMix(input(doc, 'master', m, { target: { lufs, truePeak: -1 } }));
    applyPlan(plan, io(doc), { keepUserFx: true });
    const lim = kslot(doc, doc.project.mixer.masterId, 'limiter')!;
    gains.push(lim.params.inputGain);
    assert.equal(master(doc).slotOrder[master(doc).slotOrder.length - 1], master(doc).slotOrder.find((s) => isKryptSlot(master(doc).slots[s], 'limiter')), 'Krypt limiter last');
    assert.ok(lim.params.ceiling <= -1 && lim.params.truePeak === 1);
  }
  assert.ok(gains[1] > gains[0] + 2.5, `-9 LUFS drives harder than -12: ${gains}`);
  assert.equal(gains[1], 5, '-14 → -9 needs +5 dB');
});

test('plan master: harsh high mids get a cut, a dull top a lift; tone moves are capped', () => {
  const { doc, ids } = mixDoc();
  const preset = presetById('pop-polish')!;
  const m = measure(ids, { master: { tone: { ...preset.tone, highMid: preset.tone.highMid + 6, high: preset.tone.high - 12 } } });
  applyPlan(planAutoMix(input(doc, 'master', m, { preset })), io(doc), { keepUserFx: true });
  const eq = kslot(doc, doc.project.mixer.masterId, 'eq')!;
  assert.ok(eq.params.b5Gain < -2, `3.5 kHz cut: ${eq.params.b5Gain}`);
  assert.equal(eq.params.b6Gain, 4, 'the top lift is capped at +4 dB');
  assert.equal(eq.params.b3Gain, 0, 'bands on the curve stay flat');
});

test('plan mix: a harsh lead gets a 3.5 kHz cut, a muddy pad a 300 Hz cut, hats a high-pass', () => {
  const { doc, ids } = mixDoc();
  const m = measure(ids, { inserts: { Lead: { rel: { highMid: 4 } }, Keys: { rel: { lowMid: 6 } } } });
  applyPlan(planAutoMix(input(doc, 'mix', m)), io(doc), { keepUserFx: true });
  assert.ok(kslot(doc, ids.Lead, 'eq')!.params.b5Gain < -1, 'lead harshness cut');
  assert.ok(kslot(doc, ids.Keys, 'eq')!.params.b3Gain < -1, 'keys mud cut');
  assert.equal(kslot(doc, ids.Hats, 'eq')!.params.b1Freq, 300);
  assert.equal(kslot(doc, ids.Kick, 'eq'), undefined, 'no EQ on a kick that needs none');
  assert.ok(kslot(doc, ids.Kick, 'comp') && kslot(doc, ids.Bass, 'comp') && kslot(doc, ids.Snare, 'comp'), 'drums and bass compressed');
});

test('plan vocals: buried vocals are raised against the beat, a loud one is lowered', () => {
  for (const [vl, dir] of [[-30, 1], [-4, -1]] as const) {
    const { doc, ids } = mixDoc();
    const before = gainToDb(doc.project.mixer.inserts[ids.Vocals].volume);
    const m = measure(ids, { inserts: { Vocals: { lufs: vl } } });
    const plan = planAutoMix(input(doc, 'vocals', m));
    assert.ok(plan.vocalVsBeat !== null && plan.vocalTarget !== null);
    applyPlan(plan, io(doc), { keepUserFx: true });
    const after = gainToDb(doc.project.mixer.inserts[ids.Vocals].volume);
    assert.ok(dir > 0 ? after > before + 3 : after < before - 3, `vocal ${vl}: ${before} → ${after}`);
    assert.ok(kslot(doc, ids.Vocals, 'eq') && kslot(doc, ids.Vocals, 'deesser') && kslot(doc, ids.Vocals, 'comp'));
    const rev = doc.project.mixer.insertOrder.find((i) => doc.project.mixer.inserts[i].name === 'Auto Reverb');
    assert.ok(rev && doc.project.mixer.inserts[ids.Vocals].routes[rev] > 0, 'reverb send');
    assert.ok((kslot(doc, ids.Keys, 'eq')?.params.b4Gain ?? 0) < 0 || (kslot(doc, ids.Lead, 'eq')?.params.b4Gain ?? 0) < 0, 'a dip in the busiest bed part');
  }
});

test('plan vocals: without the de-esser in the catalog, a narrow 7 kHz dip instead', () => {
  const cat = automixCatalog();
  cat.plugins = cat.plugins.filter((p) => p.id !== 'krypt.deesser');
  const { doc, ids } = mixDoc({ catalog: cat });
  applyPlan(planAutoMix(input(doc, 'vocals', measure(ids))), io(doc), { keepUserFx: true });
  const eq = kslot(doc, ids.Vocals, 'eq')!;
  assert.equal(eq.params.b5Freq, 7000);
  assert.ok(eq.params.b5Gain < 0);
});

test('plan mix: kick and bass lows collide → the bass ducks under the kick (sidechain), not when apart', () => {
  const { doc, ids } = mixDoc();
  applyPlan(planAutoMix(input(doc, 'mix', measure(ids))), io(doc), { keepUserFx: true });
  const bass = doc.project.mixer.inserts[ids.Bass];
  const duck = bass.slots[bass.slotOrder[0]];
  assert.ok(isKryptSlot(duck, 'duck'), 'a Krypt duck first on the bass');
  assert.equal(duck.sidechainFrom, ids.Kick);
  assert.equal(duck.params.mode, 1);
  const far = mixDoc();
  applyPlan(planAutoMix(input(far.doc, 'mix', measure(far.ids, { inserts: { Bass: { lufs: -40 } } }))), io(far.doc), { keepUserFx: true });
  assert.equal(kslot(far.doc, far.ids.Bass, 'duck'), undefined);
});

test('plan: a re-run adjusts the Krypt slots instead of stacking new ones; on target it changes nothing', () => {
  const { doc, ids } = mixDoc({ drumBus: true });
  const count = () => Object.values(doc.project.mixer.inserts).reduce((n, i) => n + i.slotOrder.length, 0);
  const m1 = measure(ids, { master: { lufs: -14 } });
  applyPlan(planAutoMix(input(doc, 'full', m1)), io(doc), { keepUserFx: true });
  const n1 = count();
  const inserts1 = doc.project.mixer.insertOrder.length;
  const lim = () => kslot(doc, doc.project.mixer.masterId, 'limiter')!.params.inputGain;
  const g1 = lim();
  const m2 = measure(ids, { master: { lufs: -11, tone: { sub: 3.5, low: 6.5, lowMid: -1.5, mid: 0, highMid: 2, high: -7.5 } } });
  const r2 = applyPlan(planAutoMix(input(doc, 'full', m2, { pass: 2 })), io(doc), { keepUserFx: true });
  assert.equal(count(), n1, 'no new slots');
  assert.equal(doc.project.mixer.insertOrder.length, inserts1, 'no new send inserts');
  assert.ok(r2.edits > 0);
  assert.ok(lim() > g1, 'the same limiter is driven harder toward -9 from -11');
  const onTarget = measure(ids, { master: { lufs: -9, truePeak: -1.2, tone: { sub: 3.5, low: 6.5, lowMid: -1.5, mid: 0, highMid: -5, high: -7.5 } } });
  onTarget.inserts = m2.inserts;
  const plan3 = planAutoMix(input(doc, 'master', onTarget, { pass: 3 }));
  const r3 = applyPlan(plan3, io(doc), { keepUserFx: true });
  assert.equal(r3.edits, 0, `nothing changes on target (${[...r3.changes.values()].map((c) => `${c.target}: ${c.what}`).join('; ')})`);
  assert.ok(plan3.converged);
});

test('plan: keepUserFx never touches the user\'s slots; without it the user\'s limiter is adopted', () => {
  const { doc, ids } = mixDoc();
  const m0 = master(doc);
  const userLim = m0.slotOrder[0];
  const userParams = structuredClone(m0.slots[userLim]);
  applyPlan(planAutoMix(input(doc, 'full', measure(ids))), io(doc), { keepUserFx: true });
  const m1 = master(doc);
  assert.deepEqual(m1.slots[userLim], userParams, 'the user limiter is exactly as it was');
  assert.ok(m1.slotOrder.filter((s) => m1.slots[s].type === 'krypt.limiter').length === 2, 'Krypt adds its own limiter after it');
  const b = mixDoc();
  const ul = master(b.doc).slotOrder[0];
  applyPlan(planAutoMix(input(b.doc, 'master', measure(b.ids), { keepUserFx: false })), io(b.doc), { keepUserFx: false });
  const mb = master(b.doc);
  assert.equal(mb.slotOrder.filter((s) => mb.slots[s].type === 'krypt.limiter').length, 1, 'no second limiter');
  assert.equal(mb.slots[ul].params.inputGain, 5);
});

test('plan: convergence maths — the secant slope, the crest guard and the true-peak ceiling', () => {
  const { doc, ids } = mixDoc();
  applyPlan(planAutoMix(input(doc, 'master', measure(ids, { master: { lufs: -14 } }))), io(doc), { keepUserFx: true });
  const limId = master(doc).slotOrder.find((s) => isKryptSlot(master(doc).slots[s], 'limiter'))!;
  const p2 = planAutoMix(input(doc, 'master', measure(ids, { master: { lufs: -11.5 } }), { pass: 2, loudHistory: [{ drive: 0, lufs: -14 }, { drive: 5, lufs: -11.5 }] }));
  assert.equal(p2.drive, 10, `drive ${p2.drive}`);
  const p3 = planAutoMix(input(doc, 'master', measure(ids, { master: { lufs: -11 }, gr: [{ insertId: doc.project.mixer.masterId, slotId: limId, avgDb: 4.2, maxDb: 9, active: 0.9 }] }), { pass: 2 }));
  assert.ok(p3.notes.some((n) => /^Loudness capped at -11 LUFS/.test(n)), p3.notes.join(' | '));
  assert.ok(p3.drive !== null && p3.drive <= 5, 'not pushed further');
  assert.ok(p3.converged, 'capped and peak-safe: stop refining');
  const p4 = planAutoMix(input(doc, 'master', measure(ids, { master: { lufs: -9, truePeak: -0.4 } }), { pass: 2 }));
  const limOp = p4.ops.find((o) => o.op === 'slot' && o.kind === 'limiter') as Extract<(typeof p4.ops)[number], { op: 'slot' }>;
  assert.ok(limOp.params.ceiling <= -1.6, `ceiling ${limOp.params.ceiling}`);
  const base = { mode: 'master' as const, target: { lufs: -9, truePeak: -1 }, roles: {}, preset: presetById('pop-polish')!, intent: null };
  assert.ok(meetsTargets({ ...base, measure: measure(ids, { master: { lufs: -9.4, truePeak: -1.1 } }) }).ok);
  assert.ok(!meetsTargets({ ...base, measure: measure(ids, { master: { lufs: -9.6, truePeak: -1.1 } }) }).ok);
  assert.ok(!meetsTargets({ ...base, measure: measure(ids, { master: { lufs: -9, truePeak: -0.8 } }) }).ok);
});

test('plan: every param it writes is inside its spec (no clamping surprises) and slots carry their mark', () => {
  const { doc, ids } = mixDoc({ drumBus: true });
  const intent: AutoMixIntent = { summary: '', source: 'keywords', warmer: 2, cleaner: -2, brighter: 2, wider: 2, lessHarsh: 2, vocalsForward: 2 };
  const plan = planAutoMix(input(doc, 'full', measure(ids), { intent, preset: presetById('phonk-slam')!, tune: { style: 'natural', key: { root: 9, scale: 2, name: 'A minor' } } }));
  for (const op of plan.ops) {
    if (op.op !== 'slot') continue;
    const desc = doc.catalog.plugins.find((p) => p.id === `krypt.${op.kind === 'duck' ? 'duck' : op.kind}`)!;
    for (const [k, v] of Object.entries(op.params)) {
      const spec = desc.params.find((s) => s.id === k);
      assert.ok(spec, `${op.kind}.${k} exists`);
      assert.ok(Math.abs(clampToSpec(spec!, v) - v) < 1e-9, `${op.kind}.${k} = ${v} is inside its spec`);
    }
  }
  applyPlan(plan, io(doc), { keepUserFx: true });
  const v = doc.project.mixer.inserts[ids.Vocals];
  assert.equal(v.slots[v.slotOrder[0]].type, 'krypt.pitch', 'Krypt Tune first when asked');
  assert.ok(kslot(doc, doc.project.mixer.masterId, 'heat') && kslot(doc, doc.project.mixer.masterId, 'clipper'), 'aggressive + warm: heat and clipper');
});

run('automix');
