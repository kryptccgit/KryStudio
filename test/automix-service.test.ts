import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test, run } from './harness';
import { createDefaultProject } from '@shared/schema/factory';
import type { DocHost } from '@shared/doc/DocHost';
import { USER } from '@shared/doc/DocHost';
import type { Settings } from '@shared/types';
import type { AutoMixIntent, AutoMixOutcome, AutoMixProgress } from '@shared/automix/types';
import { findKryptSlot, gainToDb, type PlanMeasure } from '@shared/automix/plan';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, TOOLS, type ToolCaller } from '../electron/mcp/tools';
import { AutoMixService, setAutomix, peekAutomix, cleanAutoMixRequest } from '../electron/automix';
import type { AiIntentFn } from '../electron/automix/ai';
import type { MeasureFn } from '../electron/automix/measure';
import { mixDoc, PARTS, type PartName } from './automix-fixtures';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-automix-'));

const pw = (dbs: number[]) => 10 * Math.log10(dbs.reduce((s, d) => s + Math.pow(10, d / 10), 0));

interface SimOpts {
  slope?: number;
  noGr?: boolean;
  grScale?: number;
  gate?: (n: number) => Promise<void>;
}

function simulator(o: SimOpts = {}): { fn: MeasureFn; calls: () => number } {
  let n = 0;
  const fn: MeasureFn = async (deps) => {
    const i = n++;
    if (o.gate) await o.gate(i);
    const p = deps.doc.project;
    const inserts: PlanMeasure['inserts'] = {};
    const top: number[] = [];
    for (const id of p.mixer.insertOrder) {
      const ins = p.mixer.inserts[id];
      if (ins.isMaster) continue;
      const base = PARTS[ins.name as PartName] ?? { lufs: -12, peak: -1, crest: 11, rel: {} };
      const lufs = base.lufs + gainToDb(ins.volume);
      const mid = lufs - 3;
      const r = base.rel;
      inserts[id] = { lufs, peakDb: base.peak + gainToDb(ins.volume), crestDb: base.crest, bands: { sub: mid + (r.sub ?? -10), low: mid + (r.low ?? -3), lowMid: mid + (r.lowMid ?? -1), mid, highMid: mid + (r.highMid ?? -4), high: mid + (r.high ?? -10) }, centroidHz: 1500 };
      if (ins.routes[p.mixer.masterId] !== undefined && ins.name !== 'Auto Reverb' && ins.name !== 'Auto Delay') top.push(lufs);
    }
    const m = p.mixer.inserts[p.mixer.masterId];
    const lim = findKryptSlot(m, 'limiter', true);
    const eq = findKryptSlot(m, 'eq', true);
    const gain = lim ? (m.slots[lim].params.inputGain ?? 0) : 0;
    const trim = eq ? (m.slots[eq].params.output ?? 0) : 0;
    const pre = top.length ? pw(top) : -20;
    const lufs = Math.min(-5, pre + trim + (o.slope ?? 0.8) * gain);
    const ceilings = m.slotOrder.filter((s) => m.slots[s].type === 'krypt.limiter' && m.slots[s].enabled).map((s) => m.slots[s].params.ceiling ?? -0.3);
    const tp = ceilings.length ? Math.min(lufs + 9, Math.min(...ceilings)) : lufs + 9;
    const eqp = eq ? m.slots[eq].params : {};
    const tone = { sub: 6 + (eqp.b2Gain ?? 0), low: 6.5 + (eqp.b3Gain ?? 0), lowMid: -1 + (eqp.b4Gain ?? 0), mid: 0, highMid: -3 + (eqp.b5Gain ?? 0), high: -8 + (eqp.b6Gain ?? 0) };
    const gr = lim && !o.noGr ? [{ insertId: m.id, slotId: lim, avgDb: (o.grScale ?? 0.25) * gain, maxDb: 2.4 * (o.grScale ?? 0.25) * gain, active: 0.3 }] : [];
    return { label: 'the song', measure: { master: { lufs, truePeak: tp, peakDb: tp - 0.2, crestDb: tp - lufs + 3, lra: 6, tone, correlation: 0.5 }, inserts, gr } };
  };
  return { fn, calls: () => n };
}

function rig(o: { sim?: SimOpts; ai?: AiIntentFn | null; vocals?: boolean; tabs?: boolean } = {}) {
  const { doc, ids } = mixDoc({ drumBus: false, vocals: o.vocals });
  let settings = {
    audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
    ui: { scale: 1, showHints: true },
    browserRoots: [],
    recent: [],
    autosaveSec: 60,
    mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'anywhere' },
    agent: { model: 'claude-opus-5-5', hasApiKey: false },
    discordRpc: false,
    library: { fastScan: false, focus: null },
  } as unknown as Settings;
  let newTabs = 0;
  const deps: MainDeps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} as never }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
      render: async () => ({ ok: false, message: 'n/a' }),
      analyzeFile: async () => ({ ok: false, message: 'n/a' }),
      sampleInfo: async (p: string) => ({ ok: true, data: { path: p, frames: 48000 * 180, sampleRate: 48000, channels: 2, durationSec: 180 } }),
      restart: async () => ({ ok: true }),
    } as unknown as MainDeps['engine'],
    project: {
      status: () => ({ path: null, name: 'Mix', dirty: false, lastSavedAt: null, recovered: false }),
      save: async () => ({ ok: true, data: { path: 'x' } }),
      resolveSamplePath: (p: string) => p,
      renderDir: () => path.join(TMP, 'renders'),
      allowedRoots: () => [],
      newProject: () => {
        newTabs++;
        doc.reset(createDefaultProject('Untitled'));
        return { ok: true, message: 'New project tab' };
      },
      opensNewTabs: () => o.tabs !== false,
    },
    getSettings: () => settings,
    updateSettings: (p) => (settings = { ...settings, ...p }),
    broadcast: () => {},
    userDataDir: path.join(TMP, 'userData'),
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  };
  const sim = simulator(o.sim);
  const svc = new AutoMixService({ deps, ai: o.ai === undefined ? null : o.ai, measure: sim.fn });
  setAutomix(doc, svc);
  const progress: AutoMixProgress[] = [];
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'claude-code', name: 'Claude Code' }, session: newSession(), via: 'test' };
  return { doc, ids, deps, svc, sim, progress, onProgress: (p: AutoMixProgress) => progress.push(p), newTabs: () => newTabs, call: (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true }) };
}

const live = (doc: DocHost) => doc.getHistory().filter((h) => !h.undone);
const mixerJson = (doc: DocHost) => JSON.stringify(doc.project.mixer);

test('run (full): ONE history entry, before → after, converged within 3 passes; toggleEntry is the A/B', async () => {
  const r = rig();
  const before = mixerJson(r.doc);
  const h0 = r.doc.getHistory().length;
  const out = await r.svc.run({ mode: 'full', preset: 'pop-polish' }, { actor: USER }, { progress: r.onProgress });
  assert.equal(out.ok, true, out.message);
  const o = out.data as AutoMixOutcome;
  assert.equal(r.doc.getHistory().length, h0 + 1, 'exactly one history entry');
  const entry = r.doc.getHistory()[h0];
  assert.equal(o.entryId, entry.id);
  assert.equal(entry.actorKey, 'user');
  assert.ok(o.passes >= 1 && o.passes <= 3, `passes ${o.passes}`);
  assert.ok(Math.abs(o.after.lufs - -9) <= 0.5, `after ${o.after.lufs} LUFS`);
  assert.ok(o.after.truePeak <= -1 + 0.05, `true peak ${o.after.truePeak}`);
  assert.ok(o.changes.length > 5);
  assert.ok(o.changes.some((c) => /Master ▸ Krypt Limiter/.test(c.target) && /-9 LUFS/.test(c.what)), o.changes.map((c) => c.target).join(', '));
  assert.ok(o.before.vocalVsBeat !== null && o.after.vocalVsBeat !== null);
  assert.match(out.message!, /One undo step/);
  assert.ok(r.progress.some((p) => p.stage === 'measuring') && r.progress[r.progress.length - 1].stage === 'done');
  const after = mixerJson(r.doc);
  assert.equal(r.doc.toggleEntry(o.entryId!, USER).ok, true);
  assert.equal(mixerJson(r.doc), before, 'A: the mix as it was');
  assert.equal(r.doc.toggleEntry(o.entryId!, USER).ok, true);
  assert.equal(mixerJson(r.doc), after, 'B: the auto mix again');
});

test('run: the loudness walk uses the measured slope (secant) and stops when on target', async () => {
  const r = rig();
  const out = await r.svc.run({ mode: 'master', preset: 'phonk-slam' }, { actor: USER });
  assert.equal(out.ok, true, out.message);
  const o = out.data!;
  assert.ok(Math.abs(o.after.lufs - -7) <= 0.5, `${o.after.lufs}`);
  assert.equal(o.passes, 2, 'slope 0.8: pass 1 undershoots, pass 2 lands');
  assert.equal(r.sim.calls(), 3, 'before + one render per pass');
});

test('run: converging stops within 3 passes and says where it ended', async () => {
  const r = rig({ sim: { slope: 0.05, noGr: true } });
  const out = await r.svc.run({ mode: 'master', preset: 'club-edm', targetLufs: -6 }, { actor: USER });
  assert.equal(out.ok, true, out.message);
  const o = out.data!;
  assert.equal(o.passes, 3);
  assert.ok(r.sim.calls() <= 4, `renders ${r.sim.calls()}`);
  assert.ok(o.notes.some((n) => /Loudness ended at/.test(n)), o.notes.join(' | '));
  assert.equal(o.entryId !== null && r.doc.getHistory().filter((h) => h.id === o.entryId).length, 1, 'still one entry');
  const g = rig({ sim: { slope: 0.05, grScale: 0.6 } });
  const capped = await g.svc.run({ mode: 'master', preset: 'club-edm', targetLufs: -6 }, { actor: USER });
  assert.ok(capped.data!.passes <= 3);
  assert.ok(capped.data!.notes.some((n) => /^Loudness capped at/.test(n)), capped.data!.notes.join(' | '));
});

test('cancel while measuring: nothing changes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let entered!: () => void;
  const inside = new Promise<void>((res) => (entered = res));
  const r = rig({ sim: { gate: async (n) => { if (n === 0) { entered(); await gate; } } } });
  const before = mixerJson(r.doc);
  const h0 = r.doc.getHistory().length;
  const job = r.svc.run({ mode: 'full' }, { actor: USER });
  await inside;
  assert.equal(peekAutomix(r.doc)?.busy, 'Auto Mix + Master', 'the tab guard sees the job');
  assert.equal(r.svc.cancel().ok, true);
  release();
  const out = await job;
  assert.equal(out.ok, false);
  assert.match(out.message!, /^Cancelled: nothing was changed/);
  assert.equal(mixerJson(r.doc), before);
  assert.equal(r.doc.getHistory().length, h0);
  assert.equal(r.svc.busy, null);
  assert.equal(r.svc.cancel().ok, false, 'nothing to cancel any more');
});

test('cancel while refining (after the first pass was written): rolled back, nothing changes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let entered!: () => void;
  const inside = new Promise<void>((res) => (entered = res));
  const r = rig({ sim: { gate: async (n) => { if (n === 1) { entered(); await gate; } } } });
  const before = mixerJson(r.doc);
  const live0 = live(r.doc).length;
  const job = r.svc.run({ mode: 'full', preset: 'loud-trap' }, { actor: USER });
  await inside;
  assert.notEqual(mixerJson(r.doc), before, 'pass 1 was written');
  r.svc.cancel();
  release();
  const out = await job;
  assert.equal(out.ok, false);
  assert.match(out.message!, /^Cancelled: nothing was changed/);
  assert.equal(mixerJson(r.doc), before, 'rolled back');
  assert.equal(live(r.doc).length, live0);
});

test('vocal mode without vocals: a clear note, no change, no crash', async () => {
  const r = rig({ vocals: false });
  const h0 = r.doc.getHistory().length;
  const out = await r.svc.run({ mode: 'vocals' }, { actor: USER });
  assert.equal(out.ok, true);
  assert.match(out.message!, /^No change: no vocals were found/);
  assert.ok(out.data!.notes.some((n) => /No vocals found: vocal mode did nothing/.test(n)));
  assert.equal(out.data!.entryId, null);
  assert.equal(r.doc.getHistory().length, h0);
});

test('vocal mode: the vocal chain, level and sends as one entry; a second run adjusts instead of stacking', async () => {
  const r = rig();
  const out = await r.svc.run({ mode: 'vocals', prompt: 'vocals on top, less harsh' }, { actor: USER });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.data!.intent?.source, 'keywords');
  assert.equal(out.data!.intent?.vocalsForward, 1);
  const v = r.doc.project.mixer.inserts[r.ids.Vocals];
  assert.deepEqual(v.slotOrder.map((s) => v.slots[s].type), ['krypt.eq', 'krypt.deesser', 'krypt.comp']);
  const slots = () => Object.values(r.doc.project.mixer.inserts).reduce((n, i) => n + i.slotOrder.length, 0);
  const n1 = slots();
  const inserts = r.doc.project.mixer.insertOrder.length;
  const again = await r.svc.run({ mode: 'vocals', prompt: 'vocals on top, less harsh' }, { actor: USER });
  assert.equal(again.ok, true, again.message);
  assert.equal(slots(), n1, 'no stacked slots');
  assert.equal(r.doc.project.mixer.insertOrder.length, inserts, 'the same send returns');
});

test('masterFile: a new tab with the audio, mastered; import and mastering are separate entries', async () => {
  const r = rig();
  const file = path.join(TMP, 'My Song.wav');
  const out = await r.svc.masterFile({ path: file, preset: 'streaming-clean' }, USER);
  assert.equal(out.ok, true, out.message);
  assert.equal(r.newTabs(), 1, 'a new project tab');
  const p = r.doc.project;
  assert.equal(p.meta.name, 'My Song');
  const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'audio');
  assert.ok(clip && p.samples[p.channels[clip.channelId!].generator.sampleId!].path === file);
  assert.equal(p.channelOrder.length, 1, 'only the song');
  assert.equal(out.data!.mode, 'master');
  assert.ok(out.data!.entryId);
  assert.equal(live(r.doc).length, 2, 'the import, then the mastering');
  assert.ok(Math.abs(out.data!.after.lufs - -14) <= 0.5, `${out.data!.after.lufs}`);
  assert.match(out.message!, /new project tab/);
  assert.match((await r.svc.masterFile({ path: 'relative.wav' }, USER)).message!, /isn't an audio file/);
  assert.match((await r.svc.masterFile({ path: path.join(TMP, 'notes.txt') }, USER)).message!, /isn't an audio file/);
});

test('understand: the AI when it answers (merged with an explicit LUFS), keywords when it is off or fails', async () => {
  const ai: AiIntentFn = async () => ({ summary: 'brighter, wider', source: 'ai', brighter: 1, wider: 1 }) as AutoMixIntent;
  const a = await rig({ ai }).svc.understand('make it sparkle at -10 LUFS');
  assert.equal(a.data!.source, 'ai');
  assert.equal(a.data!.brighter, 1);
  assert.equal(a.data!.targetLufs, -10);
  const k = await rig({ ai }).svc.understand('make it sparkle', { useAi: 'never' });
  assert.equal(k.data!.source, 'keywords');
  const f = await rig({ ai: async () => null }).svc.understand('punchy');
  assert.equal(f.data!.source, 'keywords');
  assert.equal(f.data!.punchier, 1);
  const boom = await rig({ ai: async () => { throw new Error('offline'); } }).svc.understand('punchy');
  assert.equal(boom.data!.source, 'keywords');
  assert.equal((await rig().svc.understand('  ')).ok, false);
});

test('requests from IPC are checked field by field', () => {
  assert.equal(typeof cleanAutoMixRequest({ mode: 'nope' }), 'string');
  assert.equal(typeof cleanAutoMixRequest({ mode: 'mix', targetLufs: 5 }), 'string');
  const ok = cleanAutoMixRequest({ mode: 'mix', prompt: '  ', bars: '' });
  assert.ok(typeof ok === 'object' && ok.prompt === undefined && ok.bars === undefined);
});

test('auto_mix (MCP): dry_run edits nothing; a run is one agent history entry with before / after', async () => {
  assert.ok(TOOLS.some((t) => t.name === 'auto_mix'));
  const r = rig();
  const before = mixerJson(r.doc);
  const dry = await r.call('auto_mix', { mode: 'master', preset: 'pop-polish', dry_run: true });
  assert.equal(dry.ok, true, dry.message);
  assert.match(dry.message, /^Planned, nothing changed/);
  assert.match(dry.text ?? '', /Would change/);
  assert.equal(mixerJson(r.doc), before);
  const res = await r.call('auto_mix', { mode: 'full', prompt: 'punchy, -9 LUFS' });
  assert.equal(res.ok, true, res.message);
  assert.match(res.text ?? '', /loudness .* → .* LUFS/);
  assert.match(res.text ?? '', /Changed \(\d+\)/);
  const agent = r.doc.getHistory().filter((h) => h.actorKey === 'agent:claude-code' && !h.undone);
  assert.equal(agent.length, 1, 'one undo step for the agent');
  const bad = await r.call('auto_mix', { mode: 'full', preset: 'polka' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /No preset "polka"/);
});

run('automix-service');
