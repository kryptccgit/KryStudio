import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { paramSpecFor } from '@shared/schema/params';
import { toNormalized } from '@shared/plugins/types';
import { PPQ, TICKS_PER_STEP as S } from '@shared/schema/time';
import { encodeContainer, decodeContainer } from '../electron/project/container';
import { validateProject } from '../electron/project/migrations';

const root = path.resolve(import.meta.dirname ?? '.', '..');
const NAME = 'Neon Fog';
const OUT = path.join(root, 'resources', 'demos', `${NAME}.kstudio`);
const APP_VERSION = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
const BAR = PPQ * 4;

const host = new DocHost(createDefaultProject(NAME), CATALOG, { strict: true });
const p = () => host.project;
function ex<T = any>(cmd: string, args: unknown): T {
  const r = host.exec(cmd, args, { actor: USER });
  if (!r.ok) throw new Error(`${cmd} failed: ${r.message}`);
  return (r as any).data as T;
}
function norm(ref: string, plain: number): number {
  const spec = paramSpecFor(p(), CATALOG, ref);
  if (!spec) throw new Error(`no ParamSpec for ${ref}`);
  return toNormalized(spec, plain);
}
type N = { tick: number; key: number; dur?: number; vel?: number; slide?: boolean; pan?: number };
const notes = (patternId: string, channelId: string, list: N[]) => ex('notes.add', { patternId, channelId, notes: list });
const hits = (steps: number[], vel = 0.8, key = 60, dur = S): N[] => steps.map((s) => ({ tick: Math.round(s * S), key, vel, dur }));

ex('project.setMeta', {
  name: NAME,
  author: 'Krypt',
  genre: 'Trap',
  notes:
    'Krypt Studio demo. 140 bpm, F minor. Factory kit + stock plugins only. Built by scripts/make-demo.ts through the command layer. ' +
    'Try: solo the 808 insert to hear the sidechain duck, open the Playlist to see the arrangement and automation clips, or ask your AI agent to "render_preview the hook and tell me how the mix sounds".',
});
ex('transport.set', { bpm: 140, swing: 0.08, loop: { enabled: false, start: 0, end: 32 * BAR } });

const [kick, clap, hat, snare, bass, keys] = p().channelOrder;
const ch = (id: string) => p().channels[id];
const sample = (file: string) => ex<{ id: string }>('samples.add', { path: `factory:drums/${file}` }).id;
const openHat = ex<{ id: string }>('channels.add', { type: 'krypt.sampler', name: 'Open Hat', sampleId: sample('hat-open.wav') }).id;
const rim = ex<{ id: string }>('channels.add', { type: 'krypt.sampler', name: 'Rim', sampleId: sample('rim.wav') }).id;
const crash = ex<{ id: string }>('channels.add', { type: 'krypt.sampler', name: 'Crash', sampleId: sample('crash.wav') }).id;
const lead = ex<{ id: string }>('channels.add', {
  type: 'krypt.triosc',
  name: 'Bell Lead',
  params: {
    osc1Shape: 3, osc1Level: 0.55,
    osc2Shape: 0, osc2Coarse: 12, osc2Fine: 0, osc2Level: 0.5,
    osc3Shape: 1, osc3Coarse: 0, osc3Level: 0.3,
    unisonDetune: 0.12, drift: 0.05, gain: -8,
    ampAttack: 2, ampDecay: 380, ampSustain: 0.22, ampRelease: 260,
    cutoff: 4200, reso: 0.12, filterEnvAmount: 0.45, filterEnvDecay: 320,
  },
}).id;

ex('channels.set', { id: hat, name: 'Hat', poly: { cutGroup: 1, cutBy: 1 } });
ex('channels.set', { id: openHat, poly: { cutGroup: 1, cutBy: 1 } });
ex('channels.setGenParams', { id: keys, params: {
  osc1Shape: 2, osc2Shape: 2, osc2Fine: 9, osc3Shape: 1, osc3Coarse: -12, osc3Level: 0.35,
  unisonDetune: 0.28, drift: 0.15, gain: -10,
  ampAttack: 140, ampDecay: 900, ampSustain: 0.75, ampRelease: 700,
  cutoff: 2400, reso: 0.12, filterEnvAmount: 0.15,
} });
ex('channels.set', { id: keys, name: 'Fog Pad' });
ex('channels.setGenParams', { id: bass, params: { decay: 1500, punch: 16, click: 0.12, drive: 0.3, tone: 4500, gain: -4 } });
ex('channels.setGenParams', { id: crash, params: { gain: -4 } });
ex('channels.setGenParams', { id: rim, params: { gain: -6 } });
ex('channels.set', { id: snare, name: 'Snare Roll' });

const pattern = (name: string, bars: number, select = false) => ex<{ id: string }>('patterns.add', { name, length: bars * BAR, select }).id;

const P_CHORDS = pattern('Chords', 4);
const chord = (bar: number, ks: number[], vel = 0.62): N[] => ks.map((key, i) => ({ tick: bar * BAR + i * 18, key, vel: vel - i * 0.02, dur: BAR - S }));
notes(P_CHORDS, keys, [...chord(0, [53, 56, 60, 63, 67]), ...chord(1, [49, 53, 56, 60, 65]), ...chord(2, [51, 55, 58, 62, 65]), ...chord(3, [48, 51, 55, 58, 63])]);

const P_DRUMS_A = pattern('Drums A', 2, true);
notes(P_DRUMS_A, kick, hits([0, 10, 16, 26, 29], 0.95));
notes(P_DRUMS_A, clap, hits([8, 24], 0.85));
notes(P_DRUMS_A, hat, [
  ...hits([0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 28], 0.55),
  ...hits([13, 13.5, 14, 14.5, 15, 15.5], 0.4, 60, S / 2),
  ...hits([29, 30, 31], 0.45),
]);
notes(P_DRUMS_A, openHat, hits([6, 22], 0.5));
notes(P_DRUMS_A, snare, hits([31], 0.35));

const P_DRUMS_B = pattern('Drums B', 2);
notes(P_DRUMS_B, kick, hits([0, 3, 10, 16, 19, 26, 28], 0.95));
notes(P_DRUMS_B, clap, hits([8, 24], 0.9));
notes(P_DRUMS_B, snare, hits([8, 24], 0.55));
notes(P_DRUMS_B, hat, [
  ...hits([0, 2, 4, 6, 8, 10, 16, 18, 20, 22, 24, 26], 0.55),
  ...Array.from({ length: 6 }, (_, i) => ({ tick: 12 * S + i * (PPQ / 6), key: 60, vel: 0.35 + i * 0.05, dur: PPQ / 6 })),
  ...hits([28, 28.5, 29, 29.5, 30, 30.5, 31, 31.5], 0.38, 60, S / 2),
]);
notes(P_DRUMS_B, openHat, hits([14, 30], 0.5));
notes(P_DRUMS_B, rim, hits([5, 13, 21, 27], 0.6));

const P_808 = pattern('808', 4);
notes(P_808, bass, [
  { tick: 0, key: 29, dur: 6 * S, vel: 0.95 },
  { tick: 10 * S, key: 29, dur: 4 * S, vel: 0.9 },
  { tick: 14 * S, key: 32, dur: 2 * S, vel: 0.85, slide: true },
  { tick: 16 * S, key: 37, dur: 6 * S, vel: 0.95 },
  { tick: 26 * S, key: 37, dur: 3 * S, vel: 0.9 },
  { tick: 29 * S, key: 36, dur: 3 * S, vel: 0.85, slide: true },
  { tick: 32 * S, key: 39, dur: 6 * S, vel: 0.95 },
  { tick: 42 * S, key: 39, dur: 4 * S, vel: 0.9 },
  { tick: 46 * S, key: 41, dur: 2 * S, vel: 0.85, slide: true },
  { tick: 48 * S, key: 36, dur: 8 * S, vel: 0.95 },
  { tick: 58 * S, key: 36, dur: 3 * S, vel: 0.9 },
  { tick: 61 * S, key: 39, dur: 3 * S, vel: 0.85, slide: true },
]);

const P_LEAD = pattern('Bell Lead', 4);
const mel: Array<[number, number, number]> = [
  [0, 72, 3], [3, 68, 3], [6, 65, 2], [8, 67, 4], [12, 68, 4],
  [16, 65, 6], [22, 63, 2], [24, 65, 2], [26, 68, 2], [28, 72, 4],
  [32, 70, 3], [35, 67, 3], [38, 63, 2], [40, 65, 4], [44, 67, 4],
  [48, 72, 3], [51, 70, 3], [54, 68, 2], [56, 67, 6],
];
notes(P_LEAD, lead, mel.map(([s, key, d], i) => ({ tick: s * S, key, dur: d * S, vel: i % 5 === 0 ? 0.8 : 0.68 })));

const P_BUILD = pattern('Build', 4);
const roll: N[] = [];
const ramp = (t: number) => 0.32 + 0.6 * (t / (4 * BAR));
for (let t = 0; t < BAR; t += PPQ) roll.push({ tick: t, key: 60, vel: ramp(t), dur: S });
for (let t = BAR; t < 2 * BAR; t += PPQ / 2) roll.push({ tick: t, key: 60, vel: ramp(t), dur: S });
for (let t = 2 * BAR; t < 3 * BAR; t += S) roll.push({ tick: t, key: 60, vel: ramp(t), dur: S });
for (let t = 3 * BAR; t < 4 * BAR - S; t += S / 2) roll.push({ tick: t, key: 60 + Math.floor((t - 3 * BAR) / (BAR / 4)), vel: ramp(t), dur: S / 2 });
notes(P_BUILD, snare, roll);
notes(P_BUILD, clap, hits([8, 24, 40, 56], 0.7));

const P_HATS = pattern('Hats', 2);
notes(P_HATS, hat, hits([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 29, 30, 31], 0.42));
notes(P_HATS, rim, hits([12, 28], 0.45));

const P_CRASH = pattern('Crash', 1);
notes(P_CRASH, crash, hits([0], 0.75, 60, 8 * S));

const empty = p().patternOrder.find((id) => Object.keys(p().patterns[id].notes).length === 0 && p().patterns[id].name === 'Pattern 1');
if (empty) ex('patterns.remove', { id: empty });
ex('patterns.select', { id: P_DRUMS_B });

const ins = (chId: string) => ch(chId).insertId;
const master = p().mixer.masterId;
const fx = (insertId: string, type: string, params: Record<string, number> = {}, mix?: number, index?: number) =>
  ex<{ id: string }>('mixer.addSlot', { insertId, type, params, ...(mix !== undefined ? { mix } : {}), ...(index !== undefined ? { index } : {}) }).id;
const setIns = (id: string, v: Record<string, unknown>) => ex('mixer.setInsert', { id, ...v });

const verb = ex<{ id: string }>('mixer.addInsert', { name: 'Reverb Bus' }).id;
fx(verb, 'krypt.reverb', { mode: 1, size: 0.72, decay: 2.6, predelay: 24, damping: 6500, lowCut: 280, width: 1 }, 1);
fx(verb, 'krypt.eq', { b1On: 1, b1Freq: 250, b1Slope: 1, b6Gain: -3 });
setIns(verb, { volume: 0.8 });
const send = (chId: string, level: number) => ex('mixer.setRoute', { from: ins(chId), to: verb, level });

fx(ins(kick), 'krypt.eq', { b1On: 1, b1Freq: 28, b3Freq: 380, b3Gain: -3, b3Q: 1.2, b5Freq: 4500, b5Gain: 2 });
fx(ins(kick), 'krypt.comp', { threshold: -14, ratio: 4, attack: 12, release: 90, knee: 6 });
setIns(ins(kick), { volume: 0.95 });
fx(ins(clap), 'krypt.eq', { b1On: 1, b1Freq: 180, b5Freq: 6000, b5Gain: 1.5 });
send(clap, 0.32);
setIns(ins(clap), { volume: 0.8 });
fx(ins(snare), 'krypt.eq', { b1On: 1, b1Freq: 160 });
send(snare, 0.25);
setIns(ins(snare), { volume: 0.62 });
fx(ins(hat), 'krypt.eq', { b1On: 1, b1Freq: 350, b1Slope: 1 });
setIns(ins(hat), { volume: 0.55, pan: 0.18 });
fx(ins(openHat), 'krypt.eq', { b1On: 1, b1Freq: 400 });
setIns(ins(openHat), { volume: 0.42, pan: -0.22 });
fx(ins(rim), 'krypt.delay', { sync: 1, division: 7, feedback: 0.3, lowCut: 500, highCut: 7000 }, 0.22);
setIns(ins(rim), { volume: 0.5, pan: 0.32 });
fx(ins(crash), 'krypt.eq', { b1On: 1, b1Freq: 450 });
send(crash, 0.2);
setIns(ins(crash), { volume: 0.38 });
fx(ins(bass), 'krypt.eq', { b1On: 1, b1Freq: 25, b1Slope: 2 });
fx(ins(bass), 'krypt.drive', { mode: 1, drive: 7, tone: 6000, output: -3 }, 0.6);
const duck = fx(ins(bass), 'krypt.duck', { mode: 1, depth: 0.55, attack: 1, release: 140, threshold: -30 });
ex('mixer.setSlot', { insertId: ins(bass), slotId: duck, sidechainFrom: ins(kick) });
setIns(ins(bass), { volume: 0.88 });
fx(ins(keys), 'krypt.eq', { b1On: 1, b1Freq: 170, b1Slope: 1, b4Freq: 1400, b4Gain: -2, b6Gain: 1.5 });
fx(ins(keys), 'krypt.comp', { threshold: -20, ratio: 2.5, attack: 25, release: 200 });
fx(ins(keys), 'krypt.duck', { mode: 0, depth: 0.45, rate: 1, curve: 0.55 });
send(keys, 0.35);
setIns(ins(keys), { volume: 0.74, stereoSep: 0.3 });
fx(ins(lead), 'krypt.eq', { b1On: 1, b1Freq: 300, b3Freq: 900, b3Gain: -1.5 });
fx(ins(lead), 'krypt.delay', { sync: 1, division: 7, feedback: 0.38, pingPong: 1, lowCut: 400, highCut: 6500 }, 0.26);
send(lead, 0.28);
setIns(ins(lead), { volume: 0.68 });

const mEq = fx(master, 'krypt.eq', { b1On: 1, b1Freq: 22, b6Freq: 11000, b6Gain: 1 }, undefined, 0);
const mComp = fx(master, 'krypt.comp', { threshold: -12, ratio: 2, attack: 30, release: 160, knee: 8, autoMakeup: 0 }, undefined, 1);
const mFilter = fx(master, 'krypt.filter', { type: 2, cutoff: 20, reso: 0.25 }, undefined, 2);
const mClip = fx(master, 'krypt.clipper', { drive: 2, ceiling: -0.6, softness: 0.6, oversample: 1 }, undefined, 3);
const limiter = p().mixer.inserts[master].slotOrder.find((id) => p().mixer.inserts[master].slots[id].type === 'krypt.limiter')!;
ex('mixer.setSlotParams', { insertId: master, slotId: limiter, params: { inputGain: 7.5, ceiling: -1, release: 80, truePeak: 1 } });
void mEq;
void mComp;
void mClip;

const tracks = p().playlist.trackOrder;
const trackNames = ['Drums', '808', 'Pad', 'Lead', 'Hats / FX', 'Crash', 'Pad filter', 'Master FX'];
trackNames.forEach((name, i) => ex('playlist.setTrack', { id: tracks[i], name }));
const [T_DRUMS, T_808, T_PAD, T_LEAD, T_HATS, T_CRASH, T_AUT1, T_AUT2] = tracks;
const place = (trackId: string, patternId: string, fromBar: number, toBar: number, every: number) => {
  for (let b = fromBar; b < toBar; b += every) ex('playlist.addClip', { kind: 'pattern', trackId, start: b * BAR, patternId });
};
place(T_PAD, P_CHORDS, 0, 4, 4);
place(T_HATS, P_HATS, 2, 4, 2);
place(T_PAD, P_CHORDS, 4, 12, 4);
place(T_DRUMS, P_DRUMS_A, 4, 12, 2);
place(T_808, P_808, 4, 12, 4);
place(T_CRASH, P_CRASH, 4, 5, 1);
place(T_PAD, P_CHORDS, 12, 16, 4);
place(T_DRUMS, P_BUILD, 12, 16, 4);
place(T_HATS, P_HATS, 12, 16, 2);
place(T_PAD, P_CHORDS, 16, 28, 4);
place(T_DRUMS, P_DRUMS_B, 16, 28, 2);
place(T_808, P_808, 16, 28, 4);
place(T_LEAD, P_LEAD, 16, 28, 4);
place(T_CRASH, P_CRASH, 16, 17, 1);
place(T_CRASH, P_CRASH, 24, 25, 1);
place(T_PAD, P_CHORDS, 28, 32, 4);
place(T_HATS, P_HATS, 28, 32, 2);
place(T_LEAD, P_LEAD, 28, 32, 4);

for (const [bar, name] of [[0, 'Intro'], [4, 'Verse'], [12, 'Build'], [16, 'Hook'], [28, 'Outro']] as const) ex('playlist.addMarker', { tick: bar * BAR, name });

const padCut = `channel/${keys}/gen/cutoff`;
ex('automation.create', {
  target: padCut,
  name: 'Pad filter open',
  trackId: T_AUT1,
  start: 0,
  length: 4 * BAR,
  points: [
    { tick: 0, value: norm(padCut, 450), tension: 0 },
    { tick: 4 * BAR, value: norm(padCut, 2400), tension: 0.35 },
  ],
});
const riser = `insert/${master}/slot/${mFilter}/cutoff`;
ex('automation.create', {
  target: riser,
  name: 'Build riser',
  trackId: T_AUT2,
  start: 12 * BAR,
  length: 4 * BAR,
  points: [
    { tick: 0, value: norm(riser, 20), tension: 0 },
    { tick: 4 * BAR - S, value: norm(riser, 700), tension: 0.5 },
    { tick: 4 * BAR, value: norm(riser, 20), tension: 0 },
  ],
});
const mVol = `insert/${master}/volume`;
ex('automation.create', {
  target: mVol,
  name: 'Outro fade',
  trackId: T_AUT2,
  start: 30 * BAR,
  length: 2 * BAR,
  points: [
    { tick: 0, value: norm(mVol, 1), tension: 0 },
    { tick: 2 * BAR, value: 0, tension: -0.3 },
  ],
});

ex('transport.setMode', { mode: 'song' });

const project = validateProject(JSON.parse(JSON.stringify(p())));
const bytes = encodeContainer(project, APP_VERSION);
const back = decodeContainer(bytes);
validateProject(back.project, back.meta?.schemaVersion);
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(`${OUT}.tmp`, bytes);
renameSync(`${OUT}.tmp`, OUT);
const clips = Object.values(project.playlist.clips);
console.log(
  `wrote ${path.relative(root, OUT)} (${(bytes.length / 1024).toFixed(1)} KB): ${project.channelOrder.length} channels, ${project.patternOrder.length} patterns, ` +
    `${clips.filter((c) => c.kind === 'pattern').length} pattern clips, ${Object.keys(project.automations).length} automations, ` +
    `${project.mixer.insertOrder.length} inserts, ${Object.keys(project.playlist.markers).length} markers`,
);

if (process.argv.includes('--render')) {
  const exe = `krypt-studio-engine${process.platform === 'win32' ? '.exe' : ''}`;
  const candidates = [path.join(root, 'engine', 'target', 'release', exe), path.join(root, 'resources', 'bin', exe)]
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const engine = candidates[0];
  if (!engine) throw new Error('krypt-studio-engine.exe not found: run `npm run engine:build` first');
  const work = path.join(root, 'test', '.out');
  mkdirSync(work, { recursive: true });
  const json = path.join(work, 'demo.project.json');
  const wav = path.join(work, 'demo.render.wav');
  writeFileSync(json, JSON.stringify(project));
  const r = spawnSync(engine, ['--render', json, '--out', wav, '--format', 'wav24', '--analyze', '--tail', '2', '--factory-dir', path.join(root, 'resources', 'factory')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`render failed (${r.status}): ${r.stderr}`);
  const res = JSON.parse(r.stdout.trim().split('\n').pop()!);
  const a = res.analysis ?? {};
  const f = (x: unknown, d = 1) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  console.log(`rendered ${path.relative(root, wav)} with ${path.relative(root, engine)}`);
  console.log(
    `  duration ${f(a.durationSec ?? res.durationSec)} s · integrated ${f(a.lufsIntegrated ?? res.lufsIntegrated)} LUFS · short-term max ${f(a.lufsShortTermMax)} LUFS · ` +
      `true peak ${f(a.truePeakDb)} dBTP · sample peak ${f(a.peakDb ?? res.peakDb)} dBFS · LRA ${f(a.loudnessRange)} LU · crest ${f(a.crestDb)} dB · clipping ${a.clipping}`,
  );
  if (a.bands) console.log(`  bands dB: ${Object.entries(a.bands).map(([k, v]) => `${k} ${f(v)}`).join(' · ')} · centroid ${f(a.spectralCentroidHz, 0)} Hz · corr ${f(a.stereoCorrelation, 2)} · bpm est ${a.estimatedBpm ?? '?'}`);
  if (Array.isArray(a.energyCurve)) console.log(`  energy (LUFS/s): ${a.energyCurve.map((v: number) => Math.round(v)).join(' ')}`);
  const lufs = a.lufsIntegrated ?? res.lufsIntegrated;
  const ok = lufs >= -10.5 && lufs <= -7.5 && !a.clipping && (a.truePeakDb ?? res.peakDb) <= -0.5;
  console.log(ok ? '✔ mix check passed (about -10..-8 LUFS, no clipping)' : '⚠ mix check: outside the -10..-8 LUFS / no-clip target; adjust the master limiter inputGain');
  if (!ok) process.exitCode = 1;
}
