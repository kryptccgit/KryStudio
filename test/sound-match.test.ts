// Sound matching (research/15 §3.2, match-core): the pure maths (similarity, aggregation, eligibility, why,
// tweaks clamped to the plugin's specs, stem segments), the fingerprint index loader, the pack-sample cache, and
// the match_sounds MCP tool against a fake analyzer + a fake index (report, apply as one undo step, no reference,
// no index, no stems).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG, pluginById } from '@shared/plugins/catalog';
import type { ActionResult } from '@shared/types';
import type { AudioAnalysis, DrumHit, TranscribedNote } from '@shared/analyzer/protocol';
import type { FactoryIndex, SampleKind } from '@shared/sounds/types';
import type { FingerprintEntry, FingerprintIndex, SoundFingerprint } from '@shared/sound-match/types';
import { aggregateFingerprints, compareFingerprints, eligibility, PROFILES, rankMatches, sampleKindsFor, tweaksFor, CHANNEL_TWEAKS } from '@shared/sound-match/match';
import { chordSegments, drumSegments, noteSegments, spread } from '@shared/sound-match/segments';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { FingerprintService, parseFingerprintIndex } from '../electron/sounds/fingerprints';
import type { FingerprintResult } from '../electron/analyzer/service';
import { DEFAULT_SETTINGS } from '../electron/system/settings-store';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-match-'));

// ── Fixture fingerprints ──────────────────────────────────────────────

function fp(o: Partial<SoundFingerprint> & { bands?: Partial<SoundFingerprint['bands']> } = {}): SoundFingerprint {
  const { bands, ...rest } = o;
  return {
    lengthSec: 0.4,
    centroidHz: 1000,
    rolloffHz: 4000,
    flatness: 0.2,
    harmonicity: 0.5,
    f0Hz: null,
    attackMs: 3,
    decayMs: 200,
    sustain: 0.1,
    crestDb: 12,
    width: 0,
    peakDb: -3,
    rmsDb: -16,
    ...rest,
    bands: { sub: -30, low: -10, lowMid: -6, mid: 0, highMid: -6, high: -15, ...(bands ?? {}) },
  };
}
const KICK = fp({ centroidHz: 150, rolloffHz: 400, flatness: 0.05, harmonicity: 0.6, f0Hz: 55, attackMs: 2, decayMs: 250, sustain: 0.05, crestDb: 14, bands: { sub: 0, low: -4, lowMid: -15, mid: -25, highMid: -28, high: -40 } });
const KICK_BRIGHT = fp({ ...KICK, centroidHz: 420, rolloffHz: 2500, f0Hz: 60, bands: { ...KICK.bands, highMid: -12, high: -22 } });
const HAT = fp({ lengthSec: 0.1, centroidHz: 9000, rolloffHz: 14000, flatness: 0.7, harmonicity: 0.05, attackMs: 1, decayMs: 50, sustain: 0, crestDb: 16, width: 0.1, bands: { sub: -60, low: -50, lowMid: -40, mid: -20, highMid: -6, high: 0 } });
const SNARE = fp({ centroidHz: 2500, rolloffHz: 7000, flatness: 0.45, harmonicity: 0.2, decayMs: 160, bands: { sub: -35, low: -12, lowMid: -6, mid: 0, highMid: -4, high: -12 } });
const BASS = fp({ lengthSec: 1.5, centroidHz: 180, rolloffHz: 500, flatness: 0.05, harmonicity: 0.85, f0Hz: 65, attackMs: 5, decayMs: 1200, sustain: 0.8, crestDb: 9, bands: { sub: 0, low: -2, lowMid: -12, mid: -24, highMid: -35, high: -48 } });
const CHORD = fp({ lengthSec: 2, centroidHz: 1400, rolloffHz: 4500, flatness: 0.12, harmonicity: 0.5, attackMs: 20, decayMs: 1300, sustain: 0.75, crestDb: 10, width: 0.6, bands: { sub: -40, low: -12, lowMid: -4, mid: 0, highMid: -8, high: -18 } });

const sample = (p: string, kind: SampleKind, f: SoundFingerprint): FingerprintEntry => ({ source: { kind: 'sample', path: p, sampleKind: kind }, fp: f });
const preset = (id: string, role: Extract<FingerprintEntry['source'], { kind: 'preset' }>['role'], f: SoundFingerprint, note = 60): FingerprintEntry => ({ source: { kind: 'preset', id, role, note }, fp: f });

// ── Similarity ────────────────────────────────────────────────────────

test('similarity: a kick is closer to a kick than to a hat; identical = 1', () => {
  const w = PROFILES.kick;
  const same = compareFingerprints(KICK, KICK, w).similarity;
  const k = compareFingerprints(KICK, KICK_BRIGHT, w).similarity;
  const h = compareFingerprints(KICK, HAT, w).similarity;
  assert.equal(same, 1);
  assert.ok(k > h, `kick ${k} > hat ${h}`);
  assert.ok(h < 0.2, `a hat is far from a kick (${h})`);
});

test('rankMatches: kicks over hats (eligibility by kind), dark vs bright ranking, why sentences', () => {
  const cands = [sample('factory:drums/kick-dark.wav', 'kick', KICK), sample('factory:drums/kick-bright.wav', 'kick', KICK_BRIGHT), sample('factory:drums/hat.wav', 'hat', HAT), preset('factory:kick/punchy', 'kick', fp({ ...KICK, decayMs: 600 }))];
  const dark = rankMatches([fp({ ...KICK, centroidHz: 160 })], cands, { kind: 'drum', role: 'kick' });
  assert.equal(dark.length, 3, 'the hat is not eligible for a kick');
  assert.ok(dark.every((m) => m.source.kind === 'preset' || m.source.sampleKind === 'kick'));
  assert.equal((dark[0].source as { path: string }).path, 'factory:drums/kick-dark.wav');
  const bright = rankMatches([fp({ ...KICK_BRIGHT, centroidHz: 400 })], cands, { kind: 'drum', role: 'kick' });
  assert.equal((bright[0].source as { path: string }).path, 'factory:drums/kick-bright.wav');
  // why: the overall match and a plain difference with numbers
  const darkFirst = bright.find((m) => m.source.kind === 'sample' && m.source.path.includes('dark'))!;
  assert.match(darkFirst.why[0], /^\d+% match/);
  assert.ok(darkFirst.why.some((s) => /darker than the reference kick: centroid 150 Hz vs 400 Hz/i.test(s)), darkFirst.why.join(' | '));
  // deterministic: same inputs, same order
  assert.deepEqual(rankMatches([KICK], cands, { kind: 'drum', role: 'kick' }), rankMatches([KICK], [...cands].reverse(), { kind: 'drum', role: 'kick' }));
  // a hat target only sees hats
  const hats = rankMatches([HAT], cands, { kind: 'drum', role: 'hat' });
  assert.deepEqual(hats.map((m) => (m.source as { path: string }).path), ['factory:drums/hat.wav']);
  assert.deepEqual(rankMatches([], cands, { kind: 'drum', role: 'kick' }), [], 'nothing to match');
});

test('eligibility: bass → bass / 808 / sub presets, kits never, families rank a little lower', () => {
  const t = { kind: 'instrument', role: 'bass' } as const;
  assert.equal(eligibility(preset('factory:bass/reese', 'bass', BASS), t), 1);
  assert.ok(eligibility(preset('factory:808/clean', '808', BASS), t) > 0.9 && eligibility(preset('factory:808/clean', '808', BASS), t) < 1);
  assert.equal(eligibility(preset('factory:lead/analog-saw', 'lead', BASS), t), 0);
  assert.equal(eligibility(sample('factory:drums/kick.wav', 'kick', KICK), t), 0);
  assert.equal(eligibility(preset('factory:kick/live-kit', 'kick', KICK), { kind: 'drum', role: 'kick' }), 0, 'a full kit is not one kick');
  assert.equal(eligibility(preset('factory:chord/lofi', 'chord', CHORD), { kind: 'instrument', role: 'keys' }), 1, 'alsoRoles count as the role');
  assert.deepEqual(sampleKindsFor({ kind: 'drum', role: 'snare' }), ['snare', 'clap', 'rim']);
  assert.deepEqual(sampleKindsFor({ kind: 'instrument', role: 'lead' }), []);
  const r = rankMatches([BASS], [preset('factory:bass/reese', 'bass', BASS), preset('factory:808/clean', '808', BASS), preset('factory:lead/analog-saw', 'lead', BASS)], t);
  assert.deepEqual(r.map((m) => (m.source as { id: string }).id), ['factory:bass/reese', 'factory:808/clean']);
  assert.ok(r[1].why[0].includes('related sound type'));
});

// ── Aggregation ───────────────────────────────────────────────────────

test('aggregate: median per feature shrugs off outliers and broken measurements', () => {
  const hits: Array<SoundFingerprint | null> = [];
  for (let i = 0; i < 35; i++) hits.push(fp({ ...KICK, centroidHz: 140 + (i % 7) * 4, decayMs: 240 + (i % 5) * 5, f0Hz: 54 + (i % 3) }));
  for (let i = 0; i < 5; i++) hits.push(fp({ ...HAT, f0Hz: null })); // hats masking a few kicks
  hits.push(fp({ ...KICK, centroidHz: Number.NaN }), null, fp({ ...KICK, rmsDb: -120 }));
  const a = aggregateFingerprints(hits)!;
  assert.ok(a.centroidHz >= 140 && a.centroidHz <= 170, `centroid ${a.centroidHz}`);
  assert.ok(a.decayMs >= 240 && a.decayMs <= 260, `decay ${a.decayMs}`);
  assert.ok(a.f0Hz !== null && a.f0Hz >= 54 && a.f0Hz <= 56, `f0 ${a.f0Hz}`);
  assert.equal(a.bands.sub, 0);
  assert.equal(aggregateFingerprints([]), null);
  assert.equal(aggregateFingerprints([null, fp({ centroidHz: -1 })]), null);
  // mostly unpitched → no f0
  assert.equal(aggregateFingerprints([fp({ f0Hz: 100 }), fp(), fp()])!.f0Hz, null);
  // the matcher uses the aggregate: the kick-dominated hits still pick the kick
  const r = rankMatches(hits, [sample('factory:a.wav', 'kick', KICK), sample('factory:b.wav', 'kick', fp({ ...KICK, centroidHz: 900, decayMs: 40 }))], { kind: 'drum', role: 'kick' });
  assert.equal((r[0].source as { path: string }).path, 'factory:a.wav');
});

// ── Tweaks ────────────────────────────────────────────────────────────

function assertTweaksValid(pluginId: string, t: Record<string, number>): void {
  const desc = pluginById(pluginId)!;
  for (const [k, v] of Object.entries(t)) {
    if ((CHANNEL_TWEAKS as readonly string[]).includes(k)) continue;
    const spec = desc.params.find((p) => p.id === k);
    assert.ok(spec, `${pluginId} has no param "${k}"`);
    assert.ok(v >= spec!.min && v <= spec!.max, `${k}=${v} outside ${spec!.min}..${spec!.max}`);
  }
}

test('tweaks: only params the plugin has, clamped to the spec; cutoff follows brightness', () => {
  const wt = pluginById('krypt.wavetable')!;
  const darker = tweaksFor(fp({ ...CHORD, centroidHz: 600 }), CHORD, { plugin: wt, params: { cutoff: 4000 }, drum: false });
  assert.ok(darker.cutoff !== undefined && darker.cutoff < 4000, JSON.stringify(darker));
  assertTweaksValid('krypt.wavetable', darker);
  // extreme: 20x brighter is capped at ×4 and the spec max
  const brighter = tweaksFor(fp({ ...CHORD, centroidHz: 28000 }), CHORD, { plugin: wt, params: { cutoff: 9000 }, drum: false });
  assert.ok(brighter.cutoff! <= 20000, `${brighter.cutoff}`);
  assertTweaksValid('krypt.wavetable', brighter);
  // percussive target shorter → ampDecay; sustained → ampRelease
  const pluck = tweaksFor(fp({ ...CHORD, sustain: 0.1, decayMs: 200 }), fp({ ...CHORD, sustain: 0.1, decayMs: 900 }), { plugin: wt, params: {}, drum: false });
  assert.ok(pluck.ampDecay !== undefined && pluck.ampDecay < 600, JSON.stringify(pluck));
  assert.equal(pluck.ampRelease, undefined);
  // attack: only where it reads the envelope (pads / leads), never on basses / drums
  const slow = fp({ ...CHORD, attackMs: 400 });
  assert.ok(tweaksFor(slow, CHORD, { plugin: wt, params: { ampAttack: 3 }, drum: false, attack: true }).ampAttack! > 200);
  assert.equal(tweaksFor(slow, CHORD, { plugin: wt, params: { ampAttack: 3 }, drum: false }).ampAttack, undefined);
  // 808 kick: tune toward f0 (octave errors folded), decay, tone, drive, click — all within spec
  const k808 = pluginById('krypt.kick808')!;
  const t808 = tweaksFor(fp({ ...KICK, f0Hz: 49, decayMs: 600, flatness: 0.3, bands: { ...KICK.bands, highMid: -10 } }), fp({ ...KICK, f0Hz: 110 }), { plugin: k808, params: { tune: 0, decay: 900 }, drum: true });
  assert.ok(t808.tune !== undefined && t808.tune < 0 && t808.tune >= -7, `tune ${t808.tune} (110 → 49 Hz is an octave + 2 st down: folded)`);
  assert.ok(t808.decay! > 900 && t808.drive! > 0.25 && t808.click! > 0.2, JSON.stringify(t808));
  assertTweaksValid('krypt.kick808', t808);
  // a plain sample: channel pitch (no "tune" on the sampler), shortening with ampSustain 0 + ampDecay
  const smp = pluginById('krypt.sampler')!;
  const ts = tweaksFor(fp({ ...KICK, f0Hz: 50, decayMs: 120 }), fp({ ...KICK, f0Hz: 56, decayMs: 500 }), { plugin: smp, params: {}, drum: true });
  assert.ok(ts.pitch !== undefined && ts.pitch < -1.5 && ts.pitch > -2.5, JSON.stringify(ts));
  assert.equal(ts.tune, undefined);
  assert.equal(ts.ampSustain, 0);
  assert.ok(ts.ampDecay! >= 300 && ts.ampDecay! <= 400);
  assertTweaksValid('krypt.sampler', ts);
  // melodic parts never get a pitch tweak; the level match stays within ±6 dB after the offset
  const lead = tweaksFor(fp({ ...CHORD, f0Hz: 440, rmsDb: 0 }), fp({ ...CHORD, f0Hz: 262, rmsDb: -30 }), { plugin: wt, params: {}, drum: false });
  assert.equal(lead.pitch, undefined);
  assert.equal(lead.gainDb, 6);
  const balanced = tweaksFor(fp({ ...CHORD, rmsDb: -10 }), fp({ ...CHORD, rmsDb: -20 }), { plugin: wt, params: {}, drum: false, levelOffsetDb: 9.5 });
  assert.equal(balanced.gainDb, undefined, 'within 1.5 dB after the offset: no level change');
  // no plugin → only channel tweaks
  for (const k of Object.keys(tweaksFor(KICK_BRIGHT, KICK, { plugin: undefined, params: {}, drum: true }))) assert.ok((CHANNEL_TWEAKS as readonly string[]).includes(k), k);
});

test('rankMatches: every tweak of every candidate exists on its preset plugin and is in range', () => {
  const ids = ['factory:bass/reese', 'factory:bass/organ', 'factory:bass/synthwave', 'factory:808/clean', 'factory:bass/log-drum'];
  const cands = ids.map((id, i) => preset(id, id.includes('808') ? '808' : 'bass', fp({ ...BASS, centroidHz: 120 + i * 90, decayMs: 300 + i * 400, sustain: 0.2 + i * 0.15, attackMs: 1 + i * 20 }), 36));
  const r = rankMatches([fp({ ...BASS, centroidHz: 900, decayMs: 4000, attackMs: 80 })], cands, { kind: 'instrument', role: 'bass' }, { limit: 10 });
  assert.equal(r.length, ids.length);
  const plugins: Record<string, string> = { 'factory:bass/reese': 'krypt.wavetable', 'factory:bass/organ': 'krypt.fm', 'factory:bass/synthwave': 'krypt.triosc', 'factory:808/clean': 'krypt.kick808', 'factory:bass/log-drum': 'krypt.kick808' };
  for (const m of r) assertTweaksValid(plugins[(m.source as { id: string }).id], m.tweaks);
  assert.ok(r.some((m) => Object.keys(m.tweaks).length > 0));
});

// ── Segments ──────────────────────────────────────────────────────────

test('segments: drum hits cut before the next hit, masked hits skipped, louder ones spread over the song', () => {
  const hits: DrumHit[] = [
    { timeSec: 0, role: 'kick', vel: 1 },
    { timeSec: 0.25, role: 'hat', vel: 0.5 },
    { timeSec: 0.5, role: 'snare', vel: 0.9 },
    { timeSec: 0.51, role: 'kick', vel: 0.8 }, // lands with the snare: masked
    { timeSec: 1, role: 'kick', vel: 0.7 },
  ];
  const k = drumSegments(hits, 'kick');
  assert.deepEqual(k, [
    { startSec: 0, endSec: 0.4 },
    { startSec: 0.995, endSec: 1.4 },
  ]);
  const h = drumSegments(hits, 'hat');
  assert.deepEqual(h, [{ startSec: 0.245, endSec: 0.37 }]);
  const s = drumSegments(hits, 'snare', { durationSec: 0.7 });
  assert.equal(s.length, 0, 'the snare lands with a kick (masked)');
  const many: DrumHit[] = Array.from({ length: 200 }, (_, i) => ({ timeSec: i, role: 'kick', vel: i % 2 ? 0.2 : 0.9 }));
  const picked = drumSegments(many, 'kick', { max: 40 });
  assert.equal(picked.length, 40);
  assert.ok(picked.every((x) => Math.round(x.startSec + 0.005) % 2 === 0), 'the louder half');
  assert.ok(picked[0].startSec < 5 && picked[39].startSec > 190, 'spread over the song');
  const notes: TranscribedNote[] = [
    { startSec: 1, durSec: 0.05, key: 36, vel: 1 },
    { startSec: 2, durSec: 3, key: 36, vel: 0.8 },
  ];
  assert.deepEqual(noteSegments(notes), [{ startSec: 2, endSec: 3.5 }]);
  assert.deepEqual(chordSegments([{ startSec: 0, endSec: 0.3, root: 0, quality: 'min', confidence: 1 }, { startSec: 4, endSec: 8, root: 3, quality: 'maj', confidence: 0.6 }]), [{ startSec: 4, endSec: 6 }]);
  assert.deepEqual(spread([1, 2, 3, 4, 5], 3), [1, 3, 5]);
});

// ── Index loader ──────────────────────────────────────────────────────

const INDEX: FingerprintIndex = {
  version: 1,
  generator: 'test',
  entries: [
    sample('factory:drums/kick.wav', 'kick', KICK),
    sample('factory:drums/kick-2.wav', 'kick', KICK_BRIGHT),
    sample('factory:drums/snare.wav', 'snare', SNARE),
    sample('factory:drums/clap.wav', 'clap', fp({ ...SNARE, centroidHz: 1800, flatness: 0.6 })),
    sample('factory:drums/hat-closed.wav', 'hat', HAT),
    preset('factory:bass/reese', 'bass', fp({ ...BASS, flatness: 0.3, centroidHz: 400 }), 36),
    preset('factory:bass/organ', 'bass', BASS, 36),
    preset('factory:808/clean', '808', fp({ ...BASS, centroidHz: 110 }), 36),
    preset('factory:chord/lofi', 'chord', CHORD),
    preset('factory:chord/supersaw', 'chord', fp({ ...CHORD, centroidHz: 3500, width: 0.95 })),
    preset('factory:lead/analog-saw', 'lead', fp({ ...CHORD, centroidHz: 2500, sustain: 0.9, harmonicity: 0.8, width: 0.2 })),
  ],
};

test('index: parseFingerprintIndex validates entries, skips bad / duplicate ones, rejects a bad file', () => {
  const raw = JSON.parse(JSON.stringify(INDEX));
  raw.entries.push({ source: { kind: 'sample', path: 'C:\\evil.wav', sampleKind: 'kick' }, fp: KICK }, { source: { kind: 'preset', id: 'x', role: 'nope', note: 60 }, fp: KICK }, { source: { kind: 'sample', path: 'factory:drums/kick.wav', sampleKind: 'kick' }, fp: KICK }, { source: { kind: 'sample', path: 'factory:z.wav', sampleKind: 'kick' }, fp: { ...KICK, centroidHz: 'loud' } }, 42);
  const r = parseFingerprintIndex(raw);
  assert.equal(r.index!.entries.length, INDEX.entries.length);
  assert.equal(r.skipped, 5);
  assert.equal(parseFingerprintIndex({ version: 2, generator: 'x', entries: [] }).index, null);
  assert.ok(parseFingerprintIndex(null).error);
});

function svcFor(dir: string, opts: { fingerprint?: (abs: string) => Promise<ActionResult<FingerprintResult>>; packSamples?: () => Array<{ path: string; kind: 'kick' | 'snare' | 'hat' }> } = {}) {
  return new FingerprintService({
    indexFile: path.join(dir, 'factory', 'fingerprints.json'),
    userDataDir: path.join(dir, 'userData'),
    fingerprint: opts.fingerprint,
    packSamples: opts.packSamples ?? (() => []),
    resolveSamplePath: (p) => (p.startsWith('pack:') ? path.join(dir, 'packs', ...p.slice(5).split('/')) : path.join(dir, 'factory', ...p.replace(/^factory:/, '').split('/'))),
    log: () => {},
  });
}

test('index: FingerprintService is tolerant — missing file, broken file, then the real one (re-read on change)', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'idx-'));
  const svc = svcFor(dir);
  const miss = svc.index();
  assert.equal(miss.index, null);
  assert.match(miss.problem!, /npm run fingerprints/);
  fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'factory', 'fingerprints.json'), '{ not json');
  assert.equal(svc.index().index, null);
  assert.match(svc.index().problem!, /couldn't read/);
  fs.writeFileSync(path.join(dir, 'factory', 'fingerprints.json'), JSON.stringify(INDEX));
  assert.equal(svc.index().index!.entries.length, INDEX.entries.length);
});

test('pack cache: pack samples measured lazily once, cached atomically, re-measured when changed, misses not retried', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'packs-'));
  fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'factory', 'fingerprints.json'), JSON.stringify(INDEX));
  const files = ['kicks/a.wav', 'kicks/b.wav', 'kicks/broken.wav', 'hats/h.wav'];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, 'packs', 'drums', f)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packs', 'drums', f), 'RIFF');
  }
  const calls: string[] = [];
  const fingerprint = async (abs: string): Promise<ActionResult<FingerprintResult>> => {
    calls.push(path.basename(abs));
    if (abs.includes('broken')) return { ok: false, message: 'Unsupported or corrupt audio file' };
    return { ok: true, data: { segments: [], whole: abs.includes('b.wav') ? KICK_BRIGHT : fp({ ...KICK, centroidHz: 300 }) } };
  };
  const packSamples = () => [
    { path: 'pack:drums/kicks/a.wav', kind: 'kick' as const },
    { path: 'pack:drums/kicks/b.wav', kind: 'kick' as const },
    { path: 'pack:drums/kicks/broken.wav', kind: 'kick' as const },
    { path: 'pack:drums/hats/h.wav', kind: 'hat' as const },
    { path: 'pack:drums/kicks/gone.wav', kind: 'kick' as const },
  ];
  const svc = svcFor(dir, { fingerprint, packSamples });
  const first = await svc.packEntries(['kick'], { max: 2 });
  assert.equal(first.measured, 2);
  assert.equal(first.pending, 1, 'one left for the next call (the missing file is ignored)');
  const second = await svc.packEntries(['kick']);
  assert.equal(second.measured, 1);
  assert.equal(second.entries.length, 2, 'the broken one has no fingerprint');
  assert.deepEqual(calls, ['a.wav', 'b.wav', 'broken.wav'], 'hats were not asked for');
  const cacheFile = path.join(dir, 'userData', 'analysis', 'fingerprints-packs.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.entries.length, 3);
  assert.ok(!fs.readdirSync(path.dirname(cacheFile)).some((f) => f.endsWith('.tmp')), 'atomic write left no temp file');
  // a new service (app restart) reads the cache: nothing measured again, the miss isn't retried
  const svc2 = svcFor(dir, { fingerprint, packSamples });
  const again = await svc2.packEntries(['kick']);
  assert.equal(again.measured, 0);
  assert.equal(again.entries.length, 2);
  assert.equal(calls.length, 3);
  // a changed file is measured again
  fs.writeFileSync(path.join(dir, 'packs', 'drums', 'kicks', 'a.wav'), 'RIFF changed');
  const changed = await svc2.packEntries(['kick']);
  assert.equal(changed.measured, 1);
  assert.equal(calls[calls.length - 1], 'a.wav');
  // match(): pack samples join the factory candidates; no analyzer → factory only, with a note
  const m = await svc2.match([KICK_BRIGHT], { kind: 'drum', role: 'kick' }, { limit: 5 });
  assert.ok(m.ok && m.data!.some((x) => x.source.kind === 'sample' && x.source.path === 'pack:drums/kicks/b.wav'));
  // no analyzer in the session: factory candidates only, with a note about the unmeasured pack samples
  const noAnalyzer = svcFor(dir, { packSamples: () => [...packSamples(), { path: 'pack:drums/hats/h.wav', kind: 'hat' as const }] });
  fs.writeFileSync(path.join(dir, 'packs', 'drums', 'kicks', 'b.wav'), 'RIFF changed too');
  const fac = await noAnalyzer.match([KICK_BRIGHT], { kind: 'drum', role: 'kick' }, { limit: 5 });
  assert.ok(fac.ok && fac.data!.length > 0);
  assert.ok(fac.notes?.some((n) => /no audio analyzer/.test(n)), JSON.stringify(fac.notes));
});

// ── match_sounds (fake analyzer + fake index) ─────────────────────────

const FACTORY = path.join(TMP, 'factory');
const resolve = (p: string) => (p.startsWith('factory:') ? path.join(FACTORY, ...p.slice(8).split('/')) : p);
fs.mkdirSync(path.join(FACTORY, 'drums'), { recursive: true });
for (const f of ['kick.wav', 'kick-2.wav', 'snare.wav', 'clap.wav', 'hat-closed.wav', 'hat-open.wav', '808.wav']) fs.writeFileSync(path.join(FACTORY, 'drums', f), 'RIFF');
fs.writeFileSync(path.join(FACTORY, 'fingerprints.json'), JSON.stringify(INDEX));
const SONG = path.join(TMP, 'song.wav');
const STEMS = { drums: path.join(TMP, 'stems', 'drums.wav'), bass: path.join(TMP, 'stems', 'bass.wav'), other: path.join(TMP, 'stems', 'other.wav'), vocals: path.join(TMP, 'stems', 'vocals.wav') };
fs.mkdirSync(path.join(TMP, 'stems'), { recursive: true });
for (const f of [SONG, ...Object.values(STEMS)]) fs.writeFileSync(f, 'RIFF');

const KICK_TIMES = [0, 2, 4, 6, 8, 10];
const SNARE_TIMES = [1, 3, 5, 7, 9];
const HAT_TIMES = [0.5, 1.5, 2.5, 3.5];
const HITS: DrumHit[] = [...KICK_TIMES.map((t) => ({ timeSec: t, role: 'kick' as const, vel: 0.9 })), ...SNARE_TIMES.map((t) => ({ timeSec: t, role: 'snare' as const, vel: 0.8 })), ...HAT_TIMES.map((t) => ({ timeSec: t, role: 'hat' as const, vel: 0.5 }))];
const ANALYSIS = {
  path: SONG,
  durationSec: 12,
  sampleRate: 44100,
  channels: 2,
  tempo: { bpm: 120, confidence: 0.9, alternatives: [] },
  beats: null,
  key: { tonic: 'C', mode: 'minor', name: 'Cm', confidence: 0.8 },
  swing: null,
  sections: [],
  levels: {} as AudioAnalysis['levels'],
  stereo: { width: 0.3, correlation: 0.6 },
  energy: { hopSec: 0.5, lufs: [] },
  onsetRate: 4,
  chords: [
    { startSec: 0, endSec: 4, root: 0, quality: 'min', confidence: 0.8 },
    { startSec: 4, endSec: 8, root: 8, quality: 'maj', confidence: 0.7 },
  ],
  drumHits: HITS,
  estimated: [],
  sources: [],
} as AudioAnalysis;

/** The reference sounds: a BRIGHT kick (kick-2 wins), a gritty, bright bass (reese wins), lofi-like chords. */
function fakeFingerprint(file: string, segs: Array<{ startSec: number; endSec: number }>): SoundFingerprint[] {
  return segs.map((s) => {
    const t = Math.round((s.startSec + 0.005) * 100) / 100;
    if (file === STEMS.drums || file === SONG) {
      if (KICK_TIMES.includes(t)) return fp({ ...KICK_BRIGHT, centroidHz: 400 + (t % 3) * 5 });
      if (SNARE_TIMES.includes(t)) return SNARE;
      return HAT;
    }
    if (file === STEMS.bass) return fp({ ...BASS, flatness: 0.32, centroidHz: 390 });
    return CHORD;
  });
}

function makeDeps(opts: { stems?: boolean; index?: boolean; fingerprint?: boolean } = {}) {
  const doc = new DocHost(createDefaultProject('Match'), CATALOG, { strict: true });
  const sid = doc.exec<{ id: string }>('samples.add', { path: SONG, frames: 529200, sampleRate: 44100, channels: 2 }, { actor: USER }).data!.id;
  const ch = doc.exec<{ id: string }>('channels.add', { type: 'krypt.audioclip', name: 'Reference: Song', sampleId: sid }, { actor: USER }).data!.id;
  const calls: string[] = [];
  const analyzer: NonNullable<MainDeps['analyzer']> = {
    async analyze() {
      calls.push('analyze');
      return { ok: true, data: ANALYSIS };
    },
    async separateStems() {
      return { ok: false, message: 'n/a' };
    },
    async toPattern() {
      return { ok: false, message: 'n/a' };
    },
    listModels: () => [],
    async drumStemHits() {
      return { ok: true, data: null };
    },
    async stemFiles(_t, o) {
      calls.push(`stems:${o?.cachedOnly ? 'cached' : 'run'}`);
      if (opts.stems === false) return { ok: true, data: null, message: 'The stems are not cached yet' };
      return { ok: true, data: { stems: Object.fromEntries(Object.entries(STEMS).map(([k, v]) => [k, { path: v, peakDb: -1, rmsDb: -14 }])), model: 'htdemucs', modelName: 'HT-Demucs', device: 'cpu', cached: true, seconds: 0 } };
    },
    async transcribeFile(file, mode) {
      calls.push(`transcribe:${path.basename(file)}:${mode}`);
      if (mode === 'drums') return { ok: true, data: { mode, notes: [], hits: HITS, source: 'onsets' } };
      return { ok: true, data: { mode, hits: [], source: 'pyin', notes: [0, 1, 2, 3, 4, 5].map((i) => ({ startSec: i * 2, durSec: 1, key: file === STEMS.bass ? 36 : 72, vel: 0.8 })) } };
    },
    ...(opts.fingerprint === false
      ? {}
      : {
          async fingerprint(file: string, segs?: Array<{ startSec: number; endSec: number }>): Promise<ActionResult<FingerprintResult>> {
            calls.push(`fp:${path.basename(file)}:${segs?.length ?? 0}`);
            return { ok: true, data: { segments: fakeFingerprint(file, segs ?? []) } };
          },
        }),
  };
  const factoryIndex: FactoryIndex = {
    version: 1,
    generator: 'test',
    samples: [
      { path: 'factory:drums/kick.wav', name: 'Kick', kind: 'kick', tags: [], genres: [], lengthSec: 0.4, channels: 1, peakDb: -1 },
      { path: 'factory:drums/kick-2.wav', name: 'Punchy Kick 2', kind: 'kick', tags: [], genres: [], lengthSec: 0.4, channels: 1, peakDb: -1 },
    ],
  };
  const deps: MainDeps = {
    doc,
    engine: {
      async request() {
        return { ok: true, data: {} as never };
      },
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      async render() {
        return { ok: false, message: 'n/a' };
      },
      async analyzeFile() {
        return { ok: false, message: 'n/a' };
      },
      async sampleInfo(p) {
        return { ok: true, data: { path: p, frames: 19200, sampleRate: 48000, channels: 1, durationSec: 0.4 } };
      },
      async restart() {
        return { ok: true };
      },
    },
    project: {
      status: () => ({ path: null, name: 'Match', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p) => (opts.index === false && p === 'factory:fingerprints.json' ? path.join(TMP, 'nowhere', 'fingerprints.json') : resolve(p)),
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [TMP],
    },
    getSettings: () => DEFAULT_SETTINGS,
    updateSettings: () => DEFAULT_SETTINGS,
    broadcast: () => {},
    userDataDir: path.join(TMP, 'userData-tool'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    analyzer,
    sounds: { presets: () => [], preset: () => undefined, factoryIndex: () => factoryIndex, saveUser: () => ({ ok: false, message: 'n/a' }), deleteUser: () => ({ ok: false, message: 'n/a' }) },
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'match-test', name: 'Match Test' }, session: newSession(), via: 'test' };
  const call = (args: unknown = {}) => callTool(deps, caller, 'match_sounds', args, { quiet: true });
  return { deps, doc, call, calls, refId: ch };
}

const chByName = (doc: DocHost, name: string) => Object.values(doc.project.channels).find((c) => c.name === name)!;

test('match_sounds: maps the channels by role, measures the stems, best 3 per part with why + tweaks; changes nothing', async () => {
  const { doc, call, calls } = makeDeps();
  const before = JSON.stringify(doc.project);
  const r = await call({});
  assert.equal(r.ok, true, r.message);
  if (process.env.SHOW_MATCH) console.log([r.message, r.text, ...(r.warnings ?? [])].join(String.fromCharCode(10)));
  assert.equal(JSON.stringify(doc.project), before, 'no change without apply');
  const parts = (r.data as { parts: Array<{ part: string; matches: Array<{ source: { path?: string; id?: string }; why: string[]; tweaks: Record<string, number> }> }> }).parts;
  assert.deepEqual(parts.map((p) => p.part).sort(), ['808', 'clap', 'hat', 'keys', 'kick', 'snare']);
  const kick = parts.find((p) => p.part === 'kick')!;
  assert.equal(kick.matches[0].source.path, 'factory:drums/kick-2.wav', 'the brighter kick matches the bright reference kick');
  assert.ok(kick.matches.length <= 3);
  assert.ok(kick.matches[0].why[0].match(/^\d+% match/));
  const bass = parts.find((p) => p.part === '808')!;
  assert.equal(bass.matches[0].source.id, 'factory:bass/reese', 'the gritty bright bass → reese');
  assert.equal(parts.find((p) => p.part === 'keys')!.matches[0].source.id, 'factory:chord/lofi');
  assert.match(r.text!, /KICK → "Kick" \(\d+ kick hits from the drum stem\)/);
  assert.match(r.text!, /tweaks: /);
  assert.ok(calls.includes('stems:cached'), 'never starts a separation by default');
  assert.ok(calls.some((c) => c.startsWith('fp:drums.wav:')) && calls.some((c) => c.startsWith('fp:bass.wav:')) && calls.some((c) => c.startsWith('fp:other.wav:2')));
  assert.deepEqual(doc.getHistory().filter((h) => !h.undone && h.actorKey.startsWith('agent:')), []);
});

test('match_sounds apply: loads the best sounds + tweaks onto the channels as ONE undo step; undo restores', async () => {
  const { doc, call } = makeDeps();
  const before = JSON.stringify(doc.project);
  const r = await call({ apply: true });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /loaded \d+ sounds with their tweaks \(one undo step\)/);
  const p = doc.project;
  const kick = chByName(doc, 'Kick');
  assert.equal(p.samples[kick.generator.sampleId!].path, 'factory:drums/kick-2.wav');
  assert.equal(kick.generator.type, 'krypt.sampler');
  const bass = chByName(doc, '808');
  assert.equal(bass.generator.preset?.id, 'factory:bass/reese');
  assert.equal(chByName(doc, 'Keys').generator.preset?.id, 'factory:chord/lofi');
  assert.ok(r.changed.length > 0);
  const entries = doc.getHistory().filter((h) => !h.undone && h.actorKey.startsWith('agent:'));
  assert.equal(new Set(entries.map((h) => h.groupId)).size, 1, 'one undo group');
  const back = doc.toggleEntry(entries[entries.length - 1].id, { kind: 'agent', clientId: 'match-test', name: 'Match Test' });
  assert.ok(back.ok, back.message);
  assert.equal(JSON.stringify(doc.project), before, 'undo removes it all');
});

test('match_sounds parts: a requested part without a channel gets a new one on apply', async () => {
  const { doc, call } = makeDeps();
  const r = await call({ parts: ['bass'], apply: true });
  assert.equal(r.ok, true, r.message);
  const bass = chByName(doc, 'Bass');
  assert.ok(bass, 'new Bass channel');
  assert.equal(bass.generator.preset?.id, 'factory:bass/reese');
  assert.equal(chByName(doc, '808').generator.preset, undefined, 'the 808 channel was not asked for');
});

test('match_sounds: no reference / no index / no fingerprint cmd → plain failures; no stems → drums from the mix', async () => {
  {
    const { doc, call, refId } = makeDeps();
    doc.exec('channels.set', { id: refId, name: 'Song' }, { actor: USER });
    const r = await call({});
    assert.equal(r.ok, false);
    assert.match(r.message, /study_reference/);
  }
  {
    const { call } = makeDeps({ index: false });
    const r = await call({});
    assert.equal(r.ok, false);
    assert.match(r.message, /npm run fingerprints/);
  }
  {
    const { call } = makeDeps({ fingerprint: false });
    const r = await call({});
    assert.equal(r.ok, false);
    assert.match(r.message, /can't measure sounds/);
  }
  {
    const { call, calls } = makeDeps({ stems: false });
    const r = await call({});
    assert.equal(r.ok, true, r.message);
    const parts = (r.data as { parts: Array<{ part: string; problem?: string; matches: unknown[] }> }).parts;
    assert.ok(parts.find((p) => p.part === 'kick')!.matches.length > 0, 'drums from the mix');
    assert.match(parts.find((p) => p.part === '808')!.problem!, /no bass stem/);
    assert.ok(r.warnings?.some((w) => /separate: true/.test(w)));
    assert.ok(calls.some((c) => c.startsWith('fp:song.wav:')));
    assert.match(r.text!, /from the full mix/);
  }
  {
    const { call, calls } = makeDeps();
    await call({ separate: true, parts: ['kick'] });
    assert.ok(calls.includes('stems:run'));
  }
});

await run('sound match');
fs.rmSync(TMP, { recursive: true, force: true });
