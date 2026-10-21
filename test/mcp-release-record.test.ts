// MCP gaps closed in the release / file / recording tools: setup_recording (the Recording Studio's document side,
// never the mic), export_audio stems, export_midi, import_midi, save_project, set_cover clear and the project info
// in set_song_info, plus the services they use (ExportService.exportStemsNew / writeNewFile, ProjectService.saveNew).
// The new tools run through a local runner that mirrors callTool (input parse, path consent, one agent group).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import type { RenderRequest } from '@shared/engine/protocol';
import type { Settings } from '@shared/types';
import { patternToSmf } from '@shared/midi/convert';
import { readSmf, writeSmf } from '@shared/midi/smf';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import { ToolFailure, type RunCtx, type ToolDef } from '../electron/mcp/tools/types';
import { ensurePathAccess } from '../electron/mcp/consent';
import { setupRecording } from '../electron/mcp/tools/recording';
import { exportMidi, importMidi, saveProject } from '../electron/mcp/tools/release';
import { ExportService } from '../electron/project/export';
import { ProjectService } from '../electron/project/service';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-release-record-'));
const ROOT = path.join(TMP, 'browser');
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

const SETTINGS = {
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'browser' },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
  recording: { mode: 'audio', quantize: 0, countInBars: 1 },
  audioInput: { deviceId: 'mic-1', channels: [0], monitor: false },
} as unknown as Settings;

let n = 0;
function rig(over: Partial<MainDeps> = {}, status: { path: string | null; dirty: boolean } = { path: null, dirty: true }) {
  const root = path.join(TMP, `rig${++n}`);
  fs.mkdirSync(root, { recursive: true });
  const doc = new DocHost(createDefaultProject('Release'), CATALOG, { strict: true });
  const saved: string[] = [];
  const deps: MainDeps = {
    doc,
    engine: {} as MainDeps['engine'],
    project: {
      status: () => ({ path: status.path, name: status.path ? path.basename(status.path, '.kstudio') : 'Release', dirty: status.dirty, lastSavedAt: null, recovered: false }),
      save: async () => {
        saved.push('save');
        return { ok: true, data: { path: status.path! } };
      },
      saveNew: async (name: string) => {
        saved.push(`new:${name}`);
        return { ok: true, data: { path: path.join(root, `${name}.kstudio`) } };
      },
      resolveSamplePath: (p) => p,
      renderDir: () => root,
      allowedRoots: () => [ROOT],
    },
    getSettings: () => SETTINGS,
    updateSettings: () => SETTINGS,
    broadcast: () => {},
    userDataDir: root,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
    ...over,
  };
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'rr', name: 'RR Agent' }, session: newSession(), via: 'test' };
  /** A tool through the same steps as callTool: input parse, path consent, one agent group. */
  const runDef = async (def: ToolDef, raw: unknown = {}): Promise<{ ok: boolean; message: string; data?: unknown }> => {
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'bad input' };
    const args = parsed.data as never;
    try {
      for (const p of def.paths?.(args) ?? []) if (typeof p.value === 'string' && p.value.trim()) await ensurePathAccess(deps, caller, def.name, p.value, p.kind);
      const group = deps.doc.beginGroup(caller.actor, def.name);
      try {
        const ctx: RunCtx = {
          groupId: group,
          exec: <T,>(cmd: string, a: unknown): T => {
            const r = deps.doc.exec<T>(cmd, a, { actor: caller.actor, groupId: group });
            if (!r.ok) throw new ToolFailure(r.message ?? `${cmd} failed`);
            return r.data as T;
          },
          execBatch: () => [],
          tryExec: (cmd, a) => deps.doc.exec(cmd, a, { actor: caller.actor, groupId: group }),
        };
        const r = await def.run(deps, caller, args, ctx);
        return { ok: r.ok, message: r.message, data: r.data };
      } finally {
        deps.doc.endGroup(group);
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { doc, deps, runDef, call, saved, root };
}

// ── setup_recording ──────────────────────────────────────────────────

test('setup_recording: reports the setup read-only, sets up vocals with a chain, retargets, never touches the mic', async () => {
  let armed = false;
  const { doc, runDef } = rig({ recorder: { status: () => ({ armed, input: null }) } });
  const v = doc.version;
  const st = await runDef(setupRecording);
  assert.equal(st.ok, true, st.message);
  assert.match(st.message, /Takes play through: a new insert per take; land on: the first free track\./);
  assert.match(st.message, /Record mode audio, count-in 1 bar; input device set \(mono\); not armed\./);
  assert.match(st.message, /Only the user arms and records/);
  assert.equal(doc.version, v, 'status changes nothing');

  const r = await runDef(setupRecording, { vocals: 'Lead Vox', chain: 'pop vocal' });
  assert.equal(r.ok, true, r.message);
  const p = doc.project;
  const ins = p.mixer.inserts[p.recording!.insertId!];
  assert.equal(ins.name, 'Lead Vox');
  assert.ok(ins.slotOrder.length > 0, 'the vocal chain is on the insert');
  assert.equal(p.playlist.tracks[p.recording!.trackId!].name, 'Lead Vox');
  assert.match(r.message, /New insert \+ new track "Lead Vox" with the ".+" chain set as the recording target/);
  assert.equal(doc.getHistory().filter((h) => h.actorKey === 'agent:rr').length, 1, 'one undo step');

  // A second run reuses (and renames) them; "none" loads no chain and keeps the effects.
  const again = await runDef(setupRecording, { vocals: 'Vocals', chain: 'none' });
  assert.equal(again.ok, true, again.message);
  assert.equal(doc.project.mixer.inserts[ins.id].name, 'Vocals');
  assert.equal(doc.project.mixer.inserts[ins.id].slotOrder.length, ins.slotOrder.length);
  assert.match(again.message, /Renamed insert \+ renamed track "Vocals" \(its effects unchanged\)/);

  // Retarget by name / clear; the master is refused; arguments that don't go together are refused.
  assert.equal((await runDef(setupRecording, { insert: null, track: null })).ok, true);
  assert.equal(doc.project.recording, undefined);
  assert.match((await runDef(setupRecording, { insert: 'Master' })).message, /master/i);
  assert.match((await runDef(setupRecording, { chain: 'pop vocal' })).message, /chain goes with vocals/);
  assert.match((await runDef(setupRecording, { vocals: 'V', track: 1 })).message, /not both/);
  armed = true;
  assert.match((await runDef(setupRecording)).message, /; armed\./);
  assert.match(setupRecording.description, /You CAN'T arm, record, pick the microphone or turn monitoring on/);
});

// ── set_song_info (project info) / set_cover clear ───────────────────

test('set_song_info writes the project name, author and notes too; set_cover clear removes the cover', async () => {
  const { doc, call } = rig();
  const r = await call('set_song_info', { title: 'Night Drive', project_name: 'ND v2', author: 'Krypt', notes: 'hook at bar 17' });
  assert.equal(r.ok, true, r.message);
  const m = doc.project.meta;
  assert.deepEqual([m.title, m.name, m.author, m.notes], ['Night Drive', 'ND v2', 'Krypt', 'hook at bar 17']);
  assert.match(r.message, /Project info: name "ND v2", author "Krypt", notes \(14 characters\)/);
  assert.equal(doc.getHistory().filter((h) => h.actorKey === 'agent:rr').length, 1, 'info + meta in one undo step');
  assert.equal((await call('set_song_info', {})).ok, false);

  const none = await call('set_cover', { clear: true });
  assert.equal(none.ok, false);
  assert.match(none.message, /No change: the project has no cover art/);
  doc.exec('project.setCover', { file: 'cover-0123456789abcdef.png', mime: 'image/png', width: 64, height: 64 }, { actor: { kind: 'user' } as never });
  const cl = await call('set_cover', { clear: true });
  assert.equal(cl.ok, true, cl.message);
  assert.equal(doc.project.meta.cover, undefined);
  assert.match((await call('set_cover', { clear: true, generate: true })).message, /only one of them/);
});

// ── export_audio stems (tool + ExportService) ────────────────────────

test('export_audio stems: a NEW "<name> stems" folder each time, one file per insert + Master, never normalized', async () => {
  const music = path.join(TMP, 'music');
  const jobs: RenderRequest[] = [];
  const doc = new DocHost(createDefaultProject('Stems'), CATALOG, { strict: true });
  const exporter = new ExportService({
    doc,
    engine: {
      render: async (job) => {
        jobs.push(job);
        const files = ['01 Drums.wav', 'Master.wav'].map((f) => path.join(job.path, f));
        for (const f of files) fs.writeFileSync(f, 'RIFF');
        return { ok: true, data: { path: job.path, files, durationSec: 8, peakDb: -1, lufsIntegrated: -14, stemResults: [{ insertId: 'a', name: 'Drums', path: files[0] }, { insertId: 'm', name: 'Master', path: files[1] }] } };
      },
    },
    project: { status: () => ({ path: null, name: 'Stems', dirty: false, lastSavedAt: null, recovered: false }), coverImage: () => null },
    getSettings: () => SETTINGS,
    musicDir: music,
    tag: async () => ({ ok: true, message: '' }),
    log: () => {},
  });
  const { call } = rig({ doc, exporter });
  doc.exec('playlist.addClip', { kind: 'pattern', trackId: doc.project.playlist.trackOrder[0], start: 0, patternId: doc.project.patternOrder[0] }, { actor: { kind: 'user' } as never });
  const a = await call('export_audio', { stems: true, name: 'Demo' });
  assert.equal(a.ok, true, a.message);
  const dir = path.join(music, 'Krypt Studio', 'Demo stems');
  assert.equal((a.data as { dir: string }).dir, dir);
  assert.match(a.message, /Exported 2 stems of the song to .*Demo stems: Drums, Master/);
  assert.deepEqual([jobs[0].stems, jobs[0].analyze, jobs[0].normalize], [true, false, undefined]);
  const b = await call('export_audio', { stems: true, name: 'Demo' });
  assert.equal((b.data as { dir: string }).dir, `${dir} 2`, 'never into an existing folder');
  assert.match((await call('export_audio', { stems: true, normalize: true })).message, /never normalized/);
  // A failed render leaves no empty folder behind.
  const failing = new ExportService({ ...(exporter as unknown as { deps: object }).deps, engine: { render: async () => ({ ok: false, message: 'engine down' }) } } as never);
  const f = await failing.exportStemsNew({ scope: { kind: 'song' }, format: 'wav24', name: 'Broken' });
  assert.equal(f.ok, false);
  assert.equal(fs.existsSync(path.join(music, 'Krypt Studio', 'Broken stems')), false);
});

// ── export_midi / import_midi ────────────────────────────────────────

test('export_midi writes a NEW .mid that reads back; import_midi makes a pattern from a .mid, same file rules as audio', async () => {
  const music = path.join(TMP, 'music-midi');
  const { doc, runDef } = rig();
  const exporter = new ExportService({
    doc,
    engine: { render: async () => ({ ok: false, message: 'n/a' }) },
    project: { status: () => ({ path: null, name: 'M', dirty: false, lastSavedAt: null, recovered: false }), coverImage: () => null },
    getSettings: () => SETTINGS,
    musicDir: music,
    tag: async () => ({ ok: true, message: '' }),
    log: () => {},
  });
  const deps = { exporter };
  const r2 = rig(deps);
  const p = r2.doc.project;
  const chId = p.channelOrder.find((id) => p.channels[id].generator.type !== 'krypt.audioclip')!;
  const patId = p.patternOrder[0];
  r2.doc.exec('notes.add', { patternId: patId, channelId: chId, notes: [{ tick: 0, key: 60, dur: 480 }, { tick: 960, key: 64, dur: 480 }] }, { actor: { kind: 'user' } as never });
  const e = await r2.runDef(exportMidi, { name: 'Hook' });
  assert.equal(e.ok, true, e.message);
  const out = (e.data as { path: string }).path;
  assert.equal(out, path.join(music, 'Krypt Studio', 'Hook.mid'));
  const smf = readSmf(new Uint8Array(fs.readFileSync(out)));
  assert.ok(smf.tracks.length >= 1);
  assert.equal(((await r2.runDef(exportMidi, { name: 'Hook' })).data as { path: string }).path, path.join(music, 'Krypt Studio', 'Hook (2).mid'), 'never overwrites');
  r2.doc.exec('patterns.add', { name: 'Empty' }, { actor: { kind: 'user' } as never });
  assert.match((await r2.runDef(exportMidi, { pattern: 'Empty' })).message, /has no notes to export/);

  // import: the exported file, from the Browser folder.
  const mid = path.join(ROOT, 'hook.mid');
  fs.writeFileSync(mid, writeSmf(patternToSmf(r2.doc.project, patId)));
  const before = doc.project.patternOrder.length;
  const im = await runDef(importMidi, { path: mid });
  assert.equal(im.ok, true, im.message);
  assert.equal(doc.project.patternOrder.length, before + 1);
  const pat = doc.project.patterns[(im.data as { patternId: string }).patternId];
  assert.equal(pat.name, 'hook');
  assert.equal(doc.project.transport.activePatternId, pat.id);
  const keys = Object.values(pat.notes).flatMap((byId) => Object.values(byId).map((x) => [x.tick, x.key]));
  assert.deepEqual(keys.sort((a, b) => a[0] - b[0]), [[0, 60], [960, 64]]);
  assert.match(im.message, /Imported 1 track \(2 notes\) into pattern "hook"/);
  assert.equal(doc.getHistory().filter((h) => h.actorKey === 'agent:rr').length, 1, 'one undo step');
  // Outside the Browser folders in 'browser' mode, and not a MIDI file: refused before anything changes.
  fs.writeFileSync(path.join(OUTSIDE, 'x.mid'), fs.readFileSync(mid));
  const v = doc.version;
  assert.equal((await runDef(importMidi, { path: path.join(OUTSIDE, 'x.mid') })).ok, false);
  assert.match((await runDef(importMidi, { path: path.join(ROOT, 'hook.wav') })).message, /not a MIDI file/);
  assert.equal(doc.version, v);
});

// ── save_project (tool + ProjectService.saveNew) ─────────────────────

test('save_project: saves a saved project to its file, refuses a never-saved one without a name, else a NEW file', async () => {
  const saved = rig({}, { path: path.join(TMP, 'Song.kstudio'), dirty: true });
  const r = await saved.runDef(saveProject);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(saved.saved, ['save']);
  const clean = rig({}, { path: path.join(TMP, 'Song.kstudio'), dirty: false });
  assert.match((await clean.runDef(saveProject)).message, /No change: "Song" is already saved/);
  const fresh = rig();
  const no = await fresh.runDef(saveProject);
  assert.equal(no.ok, false);
  assert.match(no.message, /has never been saved: pass name/);
  assert.equal((await fresh.runDef(saveProject, { name: 'First Song' })).ok, true);
  assert.deepEqual(fresh.saved, ['new:First Song']);

  // The real service: a NEW file in the default folder, "(2)" when the name is taken; a saved project refuses.
  const root = path.join(TMP, 'svc');
  fs.mkdirSync(root, { recursive: true });
  const doc = new DocHost(createDefaultProject('Svc'), CATALOG);
  const svc = new ProjectService({ doc, appVersion: 'test', userDataDir: path.join(root, 'userData'), factoryDir: path.join(root, 'factory'), documentsDir: root, getSettings: () => ({ recent: [], autosaveSec: 0, browserRoots: [] }) as unknown as Settings, addRecent: () => {}, log: () => {} });
  fs.writeFileSync(path.join(root, 'Tune.kstudio'), 'someone else');
  const s1 = await svc.saveNew('Tune');
  assert.equal(s1.ok, true, s1.message);
  assert.equal(s1.data!.path, path.join(root, 'Tune (2).kstudio'));
  assert.equal(fs.readFileSync(path.join(root, 'Tune.kstudio'), 'utf8'), 'someone else', 'the other file is untouched');
  assert.equal(svc.status().path, s1.data!.path);
  assert.match((await svc.saveNew('Again')).message ?? '', /already saved as Tune \(2\)\.kstudio/);
});

await run('mcp release + recording');
fs.rmSync(TMP, { recursive: true, force: true });
