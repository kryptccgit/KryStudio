import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import type { SampleInfo } from '@shared/engine/protocol';
import type { SingArgs, SyllablesArgs, TtsArgs } from '@shared/analyzer/protocol';
import type { ActionResult } from '@shared/types';
import { CONSENT_LINE } from '@shared/voice/types';
import { VoiceService, type VoiceAnalyzer } from '../electron/voice/service';
import { parseWav, silentWav } from '../electron/voice/wav';
import { VocalsService } from '../electron/vocals/service';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';
import type { MainDeps } from '../electron/mcp/types';
import { earsCatalog } from './fake-analyzer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-voice-'));
const GOOD_KEY = 'good-key-0123456789abcdef';

async function sampleInfo(p: string): Promise<ActionResult<SampleInfo>> {
  try {
    const info = parseWav(fs.readFileSync(p));
    if ('error' in info) return { ok: false, message: info.error };
    const frames = Math.round(info.durationSec * info.sampleRate);
    return { ok: true, data: { path: p, frames, sampleRate: info.sampleRate, channels: info.channels, durationSec: info.durationSec } };
  } catch {
    return { ok: false, message: `File not found: ${p}` };
  }
}

interface FishCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(opts: { tts?: number; asr?: string; offline?: boolean } = {}) {
  const calls: FishCall[] = [];
  const res = (status: number, body: string | Uint8Array) => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => {
      const b = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    text: async () => (typeof body === 'string' ? body : Buffer.from(body).toString('latin1')),
  });
  const fn = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, headers: init.headers ?? {}, body: init.body });
    if (opts.offline) throw new Error('getaddrinfo ENOTFOUND api.fish.audio');
    if (init.headers?.Authorization !== `Bearer ${GOOD_KEY}`) return res(401, '{"status":401,"message":"Invalid api key"}');
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/wallet/self/api-credit') return res(200, '{"_id":"w","user_id":"u","credit":"0","has_free_credit":true}');
    if (method === 'GET' && u.pathname === '/model') return res(200, JSON.stringify({ total: 1, items: [{ _id: 'fishnarrator01', title: 'Narrator', type: 'tts', languages: ['en'], tags: ['calm', 'male'] }] }));
    if (method === 'POST' && u.pathname === '/v1/tts') {
      if (opts.tts && opts.tts !== 200) return res(opts.tts, '{"status":402,"message":"Insufficient balance"}');
      const text = String(JSON.parse(String(init.body)).text ?? '');
      return res(200, silentWav(0.4 + text.split(/\s+/).length * 0.3, 44100));
    }
    if (method === 'POST' && u.pathname === '/v1/asr') return res(200, JSON.stringify({ text: opts.asr ?? `${CONSENT_LINE} And this is me talking for a while.`, duration: 20, segments: [] }));
    if (method === 'POST' && u.pathname === '/model') return res(201, JSON.stringify({ _id: 'myclone000001', state: 'trained', type: 'tts', title: 'x' }));
    if (method === 'DELETE' && u.pathname.startsWith('/model/')) return res(200, '');
    return res(404, '{"message":"not found"}');
  };
  return { fn, calls };
}

interface Job {
  cmd: string;
  args: TtsArgs | SingArgs | SyllablesArgs;
}

function fakeAnalyzer(opts: { words?: boolean; modelDir: string | null; hold?: Promise<void> }) {
  const jobs: Job[] = [];
  const a = {
    voiceModel: () => ({ id: 'kokoro-82m', name: 'Kokoro', dir: opts.modelDir }),
    async runVoiceJob(cmd: string, args: TtsArgs | SingArgs | SyllablesArgs, _label: string, run: { signal?: AbortSignal } = {}) {
      jobs.push({ cmd, args });
      if (opts.hold) {
        await Promise.race([opts.hold, new Promise((r) => run.signal?.addEventListener('abort', r, { once: true }))]);
        if (run.signal?.aborted) return { ok: false, cancelled: true, message: 'Cancelled' };
      }
      if (cmd === 'tts') {
        const t = args as TtsArgs;
        const words = t.text.split(/\s+/).filter(Boolean);
        const dur = 0.2 + words.length * 0.4;
        fs.writeFileSync(t.out, silentWav(dur, 24000));
        return { ok: true, data: { path: t.out, durationSec: dur, sampleRate: 24000, phonemes: '', words: opts.words === false ? [] : words.map((w, i) => ({ text: w, startSec: 0.1 + i * 0.4, endSec: 0.45 + i * 0.4 })) } };
      }
      if (cmd === 'syllables') {
        const s = args as SyllablesArgs;
        return { ok: true, data: { syllables: Array.from({ length: s.expected ?? 1 }, (_, i) => ({ startSec: 0.1 + i * 0.2, endSec: 0.25 + i * 0.2, voiced: true })) } };
      }
      const s = args as SingArgs;
      const end = Math.max(...s.segments.map((x) => x.outStartSec + x.durSec));
      fs.writeFileSync(s.out, silentWav(end, 24000));
      return { ok: true, data: { path: s.out, durationSec: end, segments: s.segments.map(() => ({ f0Hz: 180, shiftSt: 1 })) } };
    },
  };
  return { analyzer: a as unknown as VoiceAnalyzer, jobs };
}

let n = 0;
function rig(o: { key?: string | null; words?: boolean; model?: boolean; fetch?: ReturnType<typeof fakeFetch>; hold?: Promise<void>; voicesJson?: unknown } = {}) {
  const root = path.join(TMP, `rig${++n}`);
  const userData = path.join(root, 'userData');
  const modelDir = path.join(root, 'kokoro');
  fs.mkdirSync(modelDir, { recursive: true });
  if (o.voicesJson !== undefined) fs.writeFileSync(path.join(modelDir, 'voices.json'), JSON.stringify(o.voicesJson));
  const recDir = path.join(root, 'recordings');
  fs.mkdirSync(recDir, { recursive: true });
  const doc = new DocHost(createDefaultProject('Voice'), earsCatalog(), { strict: true });
  doc.exec('transport.set', { bpm: 120 }, { actor: USER });
  const logs: string[] = [];
  const log = (_l: string, m: string) => void logs.push(m);
  const { analyzer, jobs } = fakeAnalyzer({ words: o.words, modelDir: o.model === false ? null : modelDir, hold: o.hold });
  const fetch = o.fetch ?? fakeFetch();
  const store = { key: o.key === undefined ? null : o.key };
  const takes = new Set<string>();
  const auditions: string[] = [];
  const progress: string[] = [];
  const vocals = new VocalsService({ doc, userDataDir: userData, analyzer: null, sampleInfo, log });
  const svc = new VoiceService({
    doc,
    userDataDir: userData,
    analyzer,
    vocals,
    sampleInfo,
    fetch: fetch.fn as never,
    secrets: { read: () => store.key, write: (k) => ((store.key = k), { ok: true }) },
    recorder: { isSessionTake: (p) => takes.has(path.resolve(p).toLowerCase()) },
    audition: (p) => void auditions.push(p),
    broadcastProgress: (p) => void progress.push(`${p.stage}:${p.message}`),
    log,
  });
  const keys = doc.project.channelOrder.map((id) => doc.project.channels[id]).find((c) => c.name === 'Keys')!;
  const patId = doc.project.patternOrder[0];
  return { root, userData, recDir, doc, svc, jobs, fetch, store, takes, auditions, progress, logs, keys, patId };
}

const clipsOf = (doc: DocHost) => Object.values(doc.project.playlist.clips).filter((c) => c.kind === 'audio');

test('state: Kokoro voices from the model package, Fish voices only with a key, messages say why', async () => {
  const r = rig({ voicesJson: ['af_heart', { id: 'bm_george', name: 'George' }, 'jf_alpha', 'garbage'] });
  const s = await r.svc.state();
  assert.equal(s.local.installed, true);
  assert.equal(s.local.modelId, 'kokoro-82m');
  assert.deepEqual(s.voices.map((v) => v.id), ['local:af_heart', 'local:bm_george'], 'English Kokoro voices only (Japanese / junk skipped)');
  assert.match(s.voices[1].description, /UK English · male/);
  assert.equal(s.fish.keySet, false);
  assert.match(s.fish.message ?? '', /Fish Audio key.*sent to Fish Audio/);
  assert.equal(r.fetch.calls.length, 0, 'no Fish call without a key');

  const none = rig({ model: false });
  const s2 = await none.svc.state();
  assert.equal(s2.local.installed, false);
  assert.match(s2.local.message ?? '', /Install Kokoro in Model Manager/);
  assert.deepEqual(s2.voices, []);
});

test('state: without voices.json the known English Kokoro set is offered (af_heart first)', async () => {
  const r = rig();
  const s = await r.svc.state();
  assert.equal(s.voices[0].id, 'local:af_heart');
  assert.ok(s.voices.length >= 10);
});

test('speak (Local): renders with the analyzer, adds ONE clip on a new track (Follow tempo off), one undo step', async () => {
  const r = rig();
  const before = r.doc.project.playlist.trackOrder.length;
  const out = await r.svc.speak({ text: 'Krypt on the beat', voiceId: 'local:af_heart', speed: 1.2, at: '3' });
  assert.equal(out.ok, true, out.message);
  assert.equal(r.jobs.length, 1);
  const tts = r.jobs[0].args as TtsArgs;
  assert.equal(r.jobs[0].cmd, 'tts');
  assert.equal(tts.voice, 'af_heart');
  assert.equal(tts.speed, 1.2);
  assert.match(tts.out, /voice[\\/]cache[\\/][0-9a-f]+\.tmp-[0-9a-f]+\.wav$/);
  const clips = clipsOf(r.doc);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, 2 * 3840, 'at bar 3');
  assert.equal(r.doc.project.playlist.trackOrder.length, before + 1);
  const ch = r.doc.project.channels[clips[0].channelId!];
  assert.ok(!ch.generator.params.tempo_sync, 'plays at its own speed');
  assert.match(ch.name, /^Voice: Krypt on the beat/);
  assert.equal(out.data!.engine, 'local');
  assert.ok(fs.existsSync(out.data!.path) && out.data!.path.startsWith(path.join(r.userData, 'voice')));
  assert.match(out.message!, /Local, offline.*new track \d+ at bar 3.*Follow tempo off/);
  r.doc.undo(USER);
  assert.equal(clipsOf(r.doc).length, 0, 'one undo removes the clip');
  assert.equal(r.doc.project.playlist.trackOrder.length, before, '… and its track');
});

test('speak: the same text + voice + speed comes from the cache (no second render)', async () => {
  const r = rig();
  const a = await r.svc.speak({ text: 'Hey', voiceId: 'local:af_heart' });
  const b = await r.svc.speak({ text: 'Hey', voiceId: 'local:af_heart' });
  assert.ok(a.ok && b.ok);
  assert.equal(r.jobs.length, 1);
  assert.equal(a.data!.path, b.data!.path);
  assert.match(b.message!, /from the cache/);
  const c = await r.svc.speak({ text: 'Hey', voiceId: 'local:af_heart', speed: 1.5 });
  assert.ok(c.ok);
  assert.equal(r.jobs.length, 2, 'another speed is another render');
});

test('speak: an existing track, bad positions refused before rendering, preview only auditions', async () => {
  const r = rig();
  const t2 = r.doc.project.playlist.trackOrder[1];
  const ok = await r.svc.speak({ text: 'Yo', voiceId: 'local:af_heart', track: '2', at: '2.5' });
  assert.ok(ok.ok, ok.message);
  const clip = clipsOf(r.doc)[0];
  assert.equal(clip.trackId, t2);
  assert.equal(clip.start, 3840 + 4 * 240);
  const bad = await r.svc.speak({ text: 'Yo', voiceId: 'local:af_heart', at: 'bar nine' });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /must be a bar/);
  const noTrack = await r.svc.speak({ text: 'Yo', voiceId: 'local:af_heart', track: 'Vocals' });
  assert.match(noTrack.message!, /No Playlist track "Vocals"/);
  assert.equal(r.jobs.length, 1, 'refused before any render');
  const pv = await r.svc.speak({ text: 'Preview me', voiceId: 'local:af_heart', preview: true });
  assert.ok(pv.ok);
  assert.equal(pv.data!.clipId, undefined);
  assert.equal(clipsOf(r.doc).length, 1, 'preview adds nothing');
  assert.deepEqual(r.auditions, [pv.data!.path]);
});

test('speak (Local): emotion tags are dropped with a note; other languages go to the Cloud engine; empty text refused', async () => {
  const r = rig();
  const t = await r.svc.speak({ text: '[whisper] come closer', voiceId: 'local:af_heart', preview: true });
  assert.ok(t.ok);
  assert.equal((r.jobs[0].args as TtsArgs).text, 'come closer');
  assert.match(t.message!, /only work with Cloud/);
  const jp = await r.svc.speak({ text: 'こんにちは', voiceId: 'local:af_heart', preview: true });
  assert.match(jp.message!, /speaks English for now.*Cloud/);
  assert.match((await r.svc.speak({ text: '  ', voiceId: 'local:af_heart' })).message!, /Type something/);
  assert.match((await r.svc.speak({ text: 'hi', voiceId: 'local:zz_nobody' })).message!, /has no voice/);
});

test('speak (Cloud): POST /v1/tts with the free model, the key as Bearer, WAV; logged as sent to Fish Audio, never the key', async () => {
  const r = rig({ key: GOOD_KEY });
  const out = await r.svc.speak({ text: '[excited] Krypt Studio!', voiceId: 'fish:fishnarrator01', speed: 1.1 });
  assert.equal(out.ok, true, out.message);
  const tts = r.fetch.calls.find((c) => c.url.endsWith('/v1/tts'))!;
  assert.ok(tts);
  assert.equal(tts.method, 'POST');
  assert.equal(tts.url, 'https://api.fish.audio/v1/tts');
  assert.equal(tts.headers.model, 's2.1-pro-free');
  assert.equal(tts.headers.Authorization, `Bearer ${GOOD_KEY}`);
  const body = JSON.parse(String(tts.body));
  assert.deepEqual({ text: body.text, reference_id: body.reference_id, format: body.format, speed: body.prosody.speed }, { text: '[excited] Krypt Studio!', reference_id: 'fishnarrator01', format: 'wav', speed: 1.1 });
  assert.equal(out.data!.engine, 'fish');
  assert.match(out.message!, /Cloud: your text was sent to Fish Audio/);
  assert.equal(clipsOf(r.doc).length, 1);
  assert.ok(r.logs.some((l) => /sent to Fish Audio \(Cloud\): text to speech/.test(l)));
  assert.ok(!r.logs.some((l) => l.includes(GOOD_KEY)), 'the key is never logged');
  assert.ok(!r.logs.some((l) => l.includes('Krypt Studio!')), 'nor the text');
  const again = await r.svc.speak({ text: '[excited] Krypt Studio!', voiceId: 'fish:fishnarrator01', speed: 1.1, preview: true });
  assert.ok(again.ok);
  assert.equal(r.fetch.calls.filter((c) => c.url.endsWith('/v1/tts')).length, 1, 'cached: Fish is not asked twice');
});

test('speak (Cloud): only official voices or your own; no key / no credit / offline are sentences', async () => {
  const r = rig({ key: GOOD_KEY });
  const community = await r.svc.speak({ text: 'hi', voiceId: 'fish:someCelebrity99' });
  assert.equal(community.ok, false);
  assert.match(community.message!, /official voices and your own voice.*no community voices/);
  const noKey = rig();
  assert.match((await noKey.svc.speak({ text: 'hi', voiceId: 'fish:fishnarrator01' })).message!, /add your own Fish key in Settings ▸ Voice/);
  const broke = rig({ key: GOOD_KEY, fetch: fakeFetch({ tts: 402 }) });
  const b = await broke.svc.speak({ text: 'hi', voiceId: 'fish:fishnarrator01' });
  assert.equal(b.ok, false);
  assert.match(b.message!, /no credit left.*free developer tier/);
  assert.equal(clipsOf(broke.doc).length, 0);
  const off = rig({ key: GOOD_KEY, fetch: fakeFetch({ offline: true }) });
  const o = await off.svc.speak({ text: 'hi', voiceId: 'fish:fishnarrator01' });
  assert.match(o.message!, /Couldn't load Fish Audio's voices: Couldn't reach Fish Audio .*internet connection/);
  const revoked = rig({ key: 'revoked-key-0123456789' });
  const rv = await revoked.svc.speak({ text: 'hi', voiceId: 'fish:fishnarrator01' });
  assert.equal(rv.ok, false);
  assert.match(rv.message!, /didn't accept your API key/);
});

test('speak (Cloud): a revoked key gives the human 401 sentence at render time', async () => {
  const r = rig({ key: GOOD_KEY });
  await r.svc.state();
  await r.svc.refreshFishVoices(true);
  r.store.key = 'revoked-key-0123456789';
  const out = await r.svc.speak({ text: 'hi there', voiceId: 'fish:fishnarrator01' });
  assert.equal(out.ok, false);
  assert.match(out.message!, /didn't accept your API key.*Settings ▸ Voice/);
});

test('setFishKey: verified with a request that spends nothing; bad keys and offline are sentences and nothing is saved', async () => {
  const r = rig();
  const bad = await r.svc.setFishKey('wrong-key-0123456789abc');
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /didn't accept your API key/);
  assert.equal(r.store.key, null);
  assert.match((await r.svc.setFishKey('short')).message!, /doesn't look like a Fish Audio API key/);
  const off = rig({ fetch: fakeFetch({ offline: true }) });
  const o = await off.svc.setFishKey(GOOD_KEY);
  assert.match(o.message!, /Couldn't reach Fish Audio/);
  assert.equal(off.store.key, null);
  const good = await r.svc.setFishKey(`  ${GOOD_KEY}  `);
  assert.equal(good.ok, true, good.message);
  assert.equal(r.store.key, GOOD_KEY);
  assert.match(good.message!, /encrypted.*free developer tier.*sent to Fish Audio/);
  assert.ok(r.fetch.calls.some((c) => c.url.includes('/wallet/self/api-credit')));
  const s = await r.svc.state();
  assert.equal(s.fish.keySet, true);
  assert.ok(s.voices.some((v) => v.id === 'fish:fishnarrator01' && /Cloud \(Fish Audio\)/.test(v.description)));
  assert.ok(r.fetch.calls.some((c) => c.url.includes('/model?licensed=true')), 'official (licensed) voices only');
  const removed = await r.svc.setFishKey(null);
  assert.ok(removed.ok);
  assert.equal(r.store.key, null);
  assert.ok(!(await r.svc.state()).voices.some((v) => v.engine === 'fish'));
});

function melody(r: ReturnType<typeof rig>, notes: Array<[number, number, number]>) {
  r.doc.exec('notes.add', { patternId: r.patId, channelId: r.keys.id, notes: notes.map(([tick, dur, key]) => ({ tick, dur, key })) }, { actor: USER });
}

test('sing: the segments sent to `sing` match the notes (tempo, pitch, octave), placed under the pattern, one undo step', async () => {
  const r = rig();
  melody(r, [[0, 960, 60], [960, 960, 62], [1920, 480, 64], [2400, 1440, 65]]);
  const t = r.doc.project.playlist.trackOrder[0];
  r.doc.exec('playlist.addClip', { kind: 'pattern', trackId: t, start: 2 * 3840, patternId: r.patId }, { actor: USER });
  const out = await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: 'Hel-lo my love', voiceId: 'local:af_heart', octave: -1, tune: 'off' });
  assert.equal(out.ok, true, out.message);
  const sing = r.jobs.find((j) => j.cmd === 'sing')!.args as SingArgs;
  assert.deepEqual(sing.segments.map((s) => [s.outStartSec, s.durSec, s.midi]), [[0, 0.5, 48], [0.5, 0.5, 50], [1, 0.25, 52], [1.25, 0.75, 53]]);
  for (let i = 1; i < sing.segments.length; i++) assert.ok(sing.segments[i].srcStartSec >= sing.segments[i - 1].srcEndSec - 1e-6, 'source spans in order');
  assert.equal(sing.vibrato, 0.2);
  assert.equal(sing.glideMs, 40);
  assert.ok(!r.jobs.some((j) => j.cmd === 'syllables'), 'Kokoro word timings, no syllable finder');
  assert.deepEqual(out.data!.mapping, [
    { syllable: 'Hel', noteTick: 0, key: 60 },
    { syllable: 'lo', noteTick: 960, key: 62 },
    { syllable: 'my', noteTick: 1920, key: 64 },
    { syllable: 'love', noteTick: 2400, key: 65 },
  ]);
  const clips = clipsOf(r.doc);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, 2 * 3840, 'at the pattern clip, first note');
  assert.match(out.message!, /4 syllables on 4 notes.*-1 octave.*word timings.*under the first "Pattern 1" clip/);
  r.doc.undo(USER);
  assert.equal(clipsOf(r.doc).length, 0);
});

test('sing: several lines → one joined source; the syllable finder when there are no word timings; extra notes held', async () => {
  const r = rig({ words: false });
  melody(r, [[0, 480, 67], [480, 480, 69], [960, 480, 71], [1440, 480, 72], [1920, 960, 74]]);
  const out = await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: 'oh yeah\nmy love', voiceId: 'local:af_heart', tune: 'off' });
  assert.equal(out.ok, true, out.message);
  const syl = r.jobs.filter((j) => j.cmd === 'syllables');
  assert.equal(syl.length, 2, 'once per line');
  assert.deepEqual(syl.map((j) => (j.args as SyllablesArgs).expected), [2, 2]);
  const sing = r.jobs.find((j) => j.cmd === 'sing')!.args as SingArgs;
  assert.match(path.basename(sing.path), /^src-[0-9a-f]+\.wav$/);
  const src = parseWav(fs.readFileSync(sing.path));
  assert.ok(!('error' in src));
  assert.equal(Math.round((src as { durationSec: number }).durationSec * 100) / 100, Math.round((1.0 + 0.25 + 1.0) * 100) / 100, 'two 1 s lines + a 0.25 s gap');
  assert.ok(sing.segments[2].srcStartSec >= 1.25, 'line 2 syllables sit after the gap');
  assert.equal(sing.segments.length, 5);
  assert.equal(out.data!.mapping[4].syllable, '_', 'the extra note holds "love"');
  assert.match(out.message!, /1 more note than syllables/);
  assert.match(out.message!, /isn't on the Playlist/);
  assert.equal(clipsOf(r.doc)[0].start, 0);
});

test('sing: Krypt Tune (hard) in the song key from the patterns; preview adds nothing; empty lanes and lyrics refused', async () => {
  const r = rig();
  melody(r, [[0, 480, 60], [480, 480, 62], [960, 480, 64], [1440, 480, 65], [1920, 480, 67], [2400, 480, 69], [2880, 480, 71], [3360, 480, 72]]);
  const pv = await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: 'do re mi fa so la ti do', voiceId: 'local:af_heart', preview: true });
  assert.ok(pv.ok, pv.message);
  assert.equal(clipsOf(r.doc).length, 0);
  assert.equal(r.auditions.length, 1);
  const out = await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: 'do re mi fa so la ti do', voiceId: 'local:af_heart' });
  assert.ok(out.ok, out.message);
  assert.equal(r.jobs.filter((j) => j.cmd === 'sing').length, 1, 'the sung result was cached from the preview');
  const ch = r.doc.project.channels[out.data!.channelId!];
  const ins = r.doc.project.mixer.inserts[ch.insertId];
  assert.ok(ins.slotOrder.some((s) => ins.slots[s].type === 'krypt.pitch'), 'Krypt Tune on the sung clip');
  assert.match(out.message!, /Krypt Tune/);
  assert.doesNotMatch(out.message!, /Auto-?Tune/i);
  r.doc.undo(USER);
  assert.equal(clipsOf(r.doc).length, 0, 'clip + Krypt Tune: one undo step');
  const drums = r.doc.project.channelOrder.find((id) => r.doc.project.channels[id].name === 'Kick')!;
  assert.match((await r.svc.sing({ patternId: r.patId, channelId: drums, lyrics: 'hey', voiceId: 'local:af_heart' })).message!, /has no notes to sing/);
  assert.match((await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: ' ', voiceId: 'local:af_heart' })).message!, /Type the lyrics/);
  assert.match((await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: 'la', voiceId: 'local:af_heart', bars: '9-1' })).message!, /ascending/);
});

test('sing (Cloud): each line spoken by Fish, syllables found locally, then sung', async () => {
  const r = rig({ key: GOOD_KEY });
  melody(r, [[0, 960, 60], [960, 960, 62]]);
  const out = await r.svc.sing({ patternId: r.patId, channelId: r.keys.id, lyrics: 'hel-lo', voiceId: 'fish:fishnarrator01', tune: 'off' });
  assert.equal(out.ok, true, out.message);
  assert.equal(r.fetch.calls.filter((c) => c.url.endsWith('/v1/tts')).length, 1);
  assert.ok(r.jobs.some((j) => j.cmd === 'syllables'));
  assert.equal((r.jobs.find((j) => j.cmd === 'sing')!.args as SingArgs).segments.length, 2);
  assert.match(out.message!, /your lyrics were sent to Fish Audio/);
});

test('busy guard: a rendering job blocks a tab switch and a second job; cancel stops it; previews do not guard', async () => {
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const r = rig({ hold });
  assert.equal(r.svc.busy(), null);
  const p = r.svc.speak({ text: 'long one', voiceId: 'local:af_heart' });
  await new Promise((res) => setTimeout(res, 20));
  assert.match(r.svc.busy() ?? '', /Speak "long one"/);
  const second = await r.svc.speak({ text: 'other', voiceId: 'local:af_heart' });
  assert.match(second.message!, /busy with "Speak "long one""/);
  assert.match(r.svc.cancel().message!, /Cancelling/);
  const res = await p;
  assert.equal(res.ok, false);
  assert.match(res.message!, /cancelled/);
  assert.equal(r.svc.busy(), null);
  assert.equal(clipsOf(r.doc).length, 0);
  assert.equal(r.svc.cancel().ok, false, 'nothing to cancel');
  const pv = r.svc.speak({ text: 'peek', voiceId: 'local:af_heart', preview: true });
  await new Promise((res2) => setTimeout(res2, 20));
  assert.equal(r.svc.busy(), null, 'a preview never edits the project: no tab guard');
  release();
  assert.ok((await pv).ok);
});

function take(r: ReturnType<typeof rig>, name: string, secs: number, register = true): string {
  const p = path.join(r.recDir, name);
  fs.writeFileSync(p, silentWav(secs, 24000));
  if (register) r.takes.add(path.resolve(p).toLowerCase());
  return p;
}

test('cloneMyVoice: consent required, recorder takes from this session only, length checked, key needed', async () => {
  const r = rig({ key: GOOD_KEY });
  const rec = take(r, 'Voice take 1.wav', 20);
  assert.match((await r.svc.cloneMyVoice({ recordingPath: rec, name: 'Me', consent: false as unknown as true })).message!, /needs your consent/);
  const upload = take(r, 'celebrity.wav', 20, false);
  assert.match((await r.svc.cloneMyVoice({ recordingPath: upload, name: 'Me', consent: true })).message!, /Only a recording made with Krypt Studio's recorder in this session/);
  assert.match((await r.svc.cloneMyVoice({ recordingPath: 'relative.wav', name: 'Me', consent: true })).message!, /Record your voice/);
  const shortTake = take(r, 'short.wav', 3);
  assert.match((await r.svc.cloneMyVoice({ recordingPath: shortTake, name: 'Me', consent: true })).message!, /at least 10 s/);
  const old = take(r, 'old.wav', 20);
  const t = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(old, t, t);
  assert.match((await r.svc.cloneMyVoice({ recordingPath: old, name: 'Me', consent: true })).message!, /too old/);
  const noKey = rig();
  const rec2 = take(noKey, 'Voice take 2.wav', 20);
  assert.match((await noKey.svc.cloneMyVoice({ recordingPath: rec2, name: 'Me', consent: true })).message!, /add your own Fish key/);
  assert.ok(!r.fetch.calls.some((c) => c.method === 'POST' && new URL(c.url).pathname === '/model'), 'nothing was cloned');
});

test('cloneMyVoice: the recording must start with the consent line; then a PRIVATE Fish voice, listed as mine; removeMyVoice deletes it there and here', async () => {
  const wrong = rig({ key: GOOD_KEY, fetch: fakeFetch({ asr: 'Yo this is a famous rapper talking' }) });
  const w = await wrong.svc.cloneMyVoice({ recordingPath: take(wrong, 'take.wav', 20), name: 'Me', consent: true });
  assert.equal(w.ok, false);
  assert.match(w.message!, /doesn't start with the consent line/);
  assert.ok(!wrong.fetch.calls.some((c) => c.method === 'POST' && new URL(c.url).pathname === '/model'));

  const r = rig({ key: GOOD_KEY });
  const out = await r.svc.cloneMyVoice({ recordingPath: take(r, 'take.wav', 20), name: 'My Voice', consent: true });
  assert.equal(out.ok, true, out.message);
  const create = r.fetch.calls.find((c) => c.method === 'POST' && new URL(c.url).pathname === '/model')!;
  const form = create.body as FormData;
  assert.equal(form.get('visibility'), 'private');
  assert.equal(form.get('type'), 'tts');
  assert.equal(form.get('train_mode'), 'fast');
  assert.ok(form.get('voices') instanceof Blob);
  assert.equal(out.data!.mine, true);
  assert.match(out.data!.id, /^mine:/);
  const s = await r.svc.state();
  assert.ok(s.voices.some((v) => v.id === out.data!.id && v.mine));
  assert.ok(r.logs.some((l) => /sent to Fish Audio.*create a private voice model/.test(l)));
  const sp = await r.svc.speak({ text: 'this is me', voiceId: out.data!.id, preview: true });
  assert.ok(sp.ok, sp.message);
  assert.equal(JSON.parse(String(r.fetch.calls.find((c) => c.url.endsWith('/v1/tts'))!.body)).reference_id, 'myclone000001');
  const rm = await r.svc.removeMyVoice(out.data!.id);
  assert.equal(rm.ok, true, rm.message);
  assert.ok(r.fetch.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/model/myclone000001')));
  assert.ok(!(await r.svc.state()).voices.some((v) => v.mine));
  assert.equal((await r.svc.removeMyVoice(out.data!.id)).ok, false, 'already gone');
});

test('MCP: list_voices / generate_voice / sing_notes run as the agent (one undo group each), human results', async () => {
  const r = rig();
  melody(r, [[0, 960, 60], [960, 960, 62]]);
  const deps = { doc: r.doc, broadcast: () => {}, log: () => {}, voice: r.svc } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'vox', name: 'Vox Agent' }, session: newSession(), via: 'test' };
  const lv = await callTool(deps, caller, 'list_voices', {}, { quiet: true });
  assert.equal(lv.ok, true, lv.message);
  assert.match(lv.text ?? '', /local:af_heart/);
  const gv = await callTool(deps, caller, 'generate_voice', { text: 'Krypt!', at: 5 }, { quiet: true });
  assert.equal(gv.ok, true, gv.message);
  assert.ok(gv.changed.length > 0);
  assert.equal(clipsOf(r.doc)[0].start, 4 * 3840);
  const sn = await callTool(deps, caller, 'sing_notes', { pattern: 'Pattern 1', channel: 'Keys', lyrics: 'oh yeah', tune: 'off' }, { quiet: true });
  assert.equal(sn.ok, true, sn.message);
  assert.match(sn.text ?? '', /oh → 60 @ 0/);
  assert.equal(clipsOf(r.doc).length, 2);
  const agentEntries = r.doc.getHistory().filter((h) => h.actorKey !== 'user' && h.actorName === 'Vox Agent' && !h.undone);
  assert.equal(agentEntries.length, 2, 'one history entry per call');
  const bad = await callTool(deps, caller, 'sing_notes', { pattern: 'Pattern 1', channel: 'Kick', lyrics: 'hey' }, { quiet: true });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /no notes to sing/);
});

void run('voice-service');
