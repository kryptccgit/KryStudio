import { USER, type DocHost } from '@shared/doc/DocHost';
import { MODEL_CATALOG, type ModelDef } from '@shared/analyzer/models';
import type { AudioAnalysis, StemName, TranscribeMode } from '@shared/analyzer/protocol';
import type { Analysis } from '@shared/engine/protocol';
import type { ActionResult, AnalyzerJobInfo, AnalyzerState, AudioTarget, KryptApi, ModelState, StemsOutcome, ToPatternOutcome } from '@shared/types';
import { PPQ } from '@shared/schema/time';
import { pluginById } from '@shared/plugins/catalog';
import type { ParamSpec } from '@shared/plugins/types';

type AnalyzerApi = KryptApi['analyzer'];

const MODELS_DIR = 'C:\\Users\\you\\AppData\\Roaming\\Krypt Studio\\models';
const MB = 1024 * 1024;

const DEMO_MODELS: ModelDef[] = [
  {
    id: 'beat-this-small',
    name: 'Beat This! (small)',
    task: 'beats',
    description: 'Beat and downbeat tracking. Small and fast; Detect tempo & key uses it.',
    license: { name: 'MIT', url: 'https://github.com/CPJKU/beat_this/blob/main/LICENSE' },
    bundled: true,
    files: [{ name: 'beat_this_small.onnx', url: '', sha256: '', bytes: 8 * MB }],
    default: true,
  },
  {
    id: 'mdx-net-demo',
    name: 'MDX-Net light (demo)',
    task: 'stems',
    description: 'A lighter separator for slower PCs: faster, a little less clean.',
    license: { name: 'MIT', url: 'https://example.com/licence' },
    bundled: false,
    files: [{ name: 'mdx_light.onnx', url: 'https://example.com/models/mdx_light.onnx', sha256: 'demo', bytes: 52 * MB }],
    stems: ['drums', 'bass', 'vocals', 'other'],
    speed: '~10 s per minute of audio on CPU',
  },
  {
    id: 'htdemucs-6s-demo',
    name: 'HT-Demucs 6 stems (demo)',
    task: 'stems',
    description: 'Adds guitar and piano stems to the usual four.',
    license: {
      name: 'MIT',
      url: 'https://example.com/licence',
      notice: 'Weights are MIT-licensed, but were trained partly on MUSDB18, whose terms are research-oriented. Their legal status is unsettled.',
    },
    bundled: false,
    files: [{ name: 'htdemucs_6s.onnx', url: 'https://example.com/models/htdemucs_6s.onnx', sha256: 'demo', bytes: 110 * MB }],
    stems: ['drums', 'bass', 'vocals', 'other', 'guitar', 'piano'],
    speed: '~30 s per minute of audio on CPU',
  },
  {
    id: 'roformer-vocals-demo',
    name: 'RoFormer vocals (demo)',
    task: 'stems',
    description: 'Best-in-class vocal / instrumental split.',
    license: { name: 'MIT', url: 'https://example.com/licence' },
    bundled: false,
    files: [],
    stems: ['vocals', 'other'],
    speed: 'Slow on CPU; a DirectX 12 GPU is recommended',
  },
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const baseName = (p: string) => (p.split(/[\\/:]/).pop() ?? p).replace(/\.[a-z0-9]+$/i, '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ONE_SHOT = /kick|snare|clap|hat|rim|perc|tom|crash|808/i;
const KEYS: Array<[string, 'major' | 'minor']> = [
  ['F#', 'minor'],
  ['A', 'minor'],
  ['C', 'minor'],
  ['E', 'major'],
  ['G', 'minor'],
  ['D', 'major'],
];

export function fakeAnalysis(path: string, durationSec: number, sampleRate = 48000): AudioAnalysis {
  const r = rng(hashStr(path));
  const oneShot = ONE_SHOT.test(path) && durationSec < 4;
  const dur = durationSec > 0 ? durationSec : oneShot ? 0.6 : 96;
  const bpm = [140, 128, 92, 174, 120, 150][Math.floor(r() * 6)];
  const [tonic, mode] = KEYS[Math.floor(r() * KEYS.length)];
  const hop = dur > 20 ? 0.5 : 0.05;

  const form = dur > 40 ? ['A', 'B', 'C', 'B', 'C', 'D', 'C', 'A'] : dur > 12 ? ['A', 'B', 'A', 'B'] : [];
  const weights = form.map((l) => (l === 'A' ? 0.6 : l === 'D' ? 0.8 : 1));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const sectionLufs: Record<string, number> = { A: -15, B: -11, C: -8, D: -13 };
  let t = 0;
  const sections = form.map((label, i) => {
    const len = (dur * weights[i]) / wsum;
    const s = { startSec: t, endSec: Math.min(dur, t + len), label, lufs: sectionLufs[label] + (r() - 0.5) };
    t += len;
    return s;
  });

  const n = Math.max(2, Math.round(dur / hop));
  const lufs: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = i * hop;
    if (oneShot) {
      lufs.push(-6 - (at / dur) * 40 + (r() - 0.5));
      continue;
    }
    const sec = sections.find((s) => at >= s.startSec && at < s.endSec);
    const base = sec ? sec.lufs : -10;
    const pulse = Math.sin((at * bpm * Math.PI) / 60) * 1.2;
    lufs.push(base + pulse + (r() - 0.5) * 1.6);
  }

  const beatLen = 60 / bpm;
  const times: number[] = [];
  if (!oneShot) for (let b = 0; b * beatLen < dur; b++) times.push(+(b * beatLen).toFixed(3));
  const levels: Analysis = {
    durationSec: dur,
    peakDb: oneShot ? -0.8 : -0.3,
    truePeakDb: oneShot ? -0.6 : -0.1 + r() * 0.4,
    lufsIntegrated: oneShot ? -11.4 : -8.9 - r() * 3,
    lufsShortTermMax: -6.4,
    loudnessRange: oneShot ? 0 : 4 + r() * 5,
    rmsDb: -10.2,
    crestDb: 9.9,
    bands: { sub: -14, low: -11, lowMid: -16, mid: -18, highMid: -22, high: -27 },
    stereoCorrelation: oneShot ? 1 : 0.35 + r() * 0.4,
    stereoWidth: oneShot ? 0 : 0.35 + r() * 0.45,
    energyCurve: lufs.filter((_, i) => i % Math.max(1, Math.round(1 / hop)) === 0),
    clipping: false,
    estimatedBpm: oneShot ? null : bpm,
    spectralCentroidHz: 2400,
  };
  const tonal = !oneShot || /808/i.test(path);
  return {
    path,
    durationSec: dur,
    sampleRate,
    channels: oneShot ? 1 : 2,
    tempo: oneShot ? null : { bpm: bpm + (r() < 0.3 ? 0.04 : 0), confidence: 0.55 + r() * 0.4, alternatives: [bpm / 2, bpm * 2].filter((b) => b >= 40 && b <= 300) },
    beats: oneShot ? null : { times, downbeats: times.filter((_, i) => i % 4 === 0), beatsPerBar: 4 },
    key: tonal ? { tonic, mode, name: `${tonic}${mode === 'minor' ? 'm' : ''}`, confidence: 0.4 + r() * 0.5 } : null,
    swing: oneShot ? null : r() < 0.4 ? 0 : 0.08 + r() * 0.2,
    sections,
    levels,
    stereo: { width: levels.stereoWidth, correlation: levels.stereoCorrelation },
    energy: { hopSec: hop, lufs },
    onsetRate: oneShot ? 1 : 3 + r() * 5,
    estimated: ['tempo', 'beats', 'key', 'swing', 'sections'],
    sources: ['stratum-dsp (mock)', 'beat-this small (mock)'],
  };
}

export function ensureAudioClipStretchParams(): void {
  const d = pluginById('krypt.audioclip');
  if (!d || d.params.some((p) => p.id === 'tempo_sync')) return;
  const g = 'Stretch & pitch';
  const specs: ParamSpec[] = [
    { id: 'tempo_sync', name: 'Follow tempo', min: 0, max: 1, default: 0, unit: '', scale: 'linear', step: 1, options: ['Off', 'On'], group: g },
    { id: 'src_bpm', name: 'Source tempo', min: 0, max: 999, default: 0, unit: 'bpm', scale: 'linear', group: g },
    { id: 'stretch', name: 'Stretch', min: 0, max: 1, default: 1, unit: '', scale: 'linear', step: 1, options: ['Resample', 'Time-stretch'], group: g },
    { id: 'pitch', name: 'Pitch', min: -24, max: 24, default: 0, unit: 'st', scale: 'linear', group: g },
    { id: 'formant', name: 'Keep formants', min: 0, max: 1, default: 1, unit: '', scale: 'linear', step: 1, options: ['Off', 'On'], group: g },
  ];
  d.params.push(...specs.filter((s) => !d.params.some((p) => p.id === s.id)));
  console.info('[krypt] mock: provisional Audio Clip stretch params added (catalog.gen.json not regenerated yet).');
}

export function createMockAnalyzer(host: DocHost): AnalyzerApi {
  const catalog: ModelDef[] = [...MODEL_CATALOG.map((d) => ({ ...d })), ...DEMO_MODELS.filter((d) => !MODEL_CATALOG.some((c) => c.id === d.id))];
  for (const d of catalog) if (!d.bundled && !d.files.length && d.id === 'htdemucs') d.files = [{ name: 'htdemucs.onnx', url: 'https://example.com/models/htdemucs.onnx', sha256: 'demo', bytes: 84 * MB }];

  const initial: Record<string, Partial<ModelState>> = {
    'htdemucs-6s-demo': { status: 'failed', message: 'SHA-256 mismatch for htdemucs_6s.onnx: the download was damaged. Try again.' },
    'roformer-vocals-demo': { status: 'unavailable', message: 'No download is published for this model yet. If you already have its files, use Install from folder.' },
  };
  const st: AnalyzerState = {
    available: true,
    running: true,
    pid: 4242,
    version: '0.1.0-mock',
    devices: ['cpu', 'directml'],
    models: catalog.map((def) => ({
      def,
      status: def.bundled ? 'installed' : 'available',
      dir: def.bundled ? `C:\\Program Files\\Krypt Studio\\resources\\models\\${def.id}` : undefined,
      ...initial[def.id],
    })),
    jobs: [],
    modelsDir: MODELS_DIR,
  };
  const subs = new Set<(s: AnalyzerState) => void>();
  const snapshot = (): AnalyzerState => ({ ...st, devices: [...st.devices], models: st.models.map((m) => ({ ...m, progress: m.progress ? { ...m.progress } : undefined })), jobs: st.jobs.map((j) => ({ ...j })) });
  const emit = (): void => {
    const s = snapshot();
    subs.forEach((fn) => fn(s));
  };
  const model = (id: string) => st.models.find((m) => m.def.id === id);
  const wake = (): void => {
    if (st.running) return;
    Object.assign(st, { running: true, pid: 4242, version: '0.1.0-mock', devices: ['cpu', 'directml'] });
  };

  let seq = 0;
  const cancelled = new Set<string>();
  function runJob(kind: AnalyzerJobInfo['kind'], label: string, stages: Array<{ stage: string; ms: number; indeterminate?: boolean }>): Promise<boolean> {
    wake();
    const id = `job-${++seq}`;
    const job: AnalyzerJobInfo = { id, kind, label, stage: stages[0].stage, fraction: 0, startedAt: Date.now() };
    st.jobs.push(job);
    emit();
    const total = stages.reduce((a, s) => a + s.ms, 0);
    return new Promise((resolve) => {
      let t = 0;
      const finish = (ok: boolean): void => {
        clearInterval(timer);
        st.jobs = st.jobs.filter((j) => j.id !== id);
        cancelled.delete(id);
        emit();
        resolve(ok);
      };
      const timer = setInterval(() => {
        if (cancelled.has(id)) return finish(false);
        t += 120;
        let acc = 0;
        const cur = stages.find((s) => (acc += s.ms) > t) ?? stages[stages.length - 1];
        job.stage = cur.stage;
        job.fraction = cur.indeterminate ? -1 : Math.min(1, t / total);
        if (t >= total) finish(true);
        else emit();
      }, 120);
    });
  }

  const dlCancel = new Set<string>();
  async function download(id: string, totalMs: number): Promise<ActionResult<AnalyzerState>> {
    const m = model(id)!;
    const total = m.def.files.reduce((a, f) => a + f.bytes, 0) || 60 * MB;
    m.status = 'downloading';
    m.message = undefined;
    m.progress = { received: 0, total };
    emit();
    const steps = Math.max(10, Math.round(totalMs / 150));
    for (let i = 1; i <= steps; i++) {
      await sleep(150);
      if (dlCancel.has(id)) {
        dlCancel.delete(id);
        Object.assign(m, { status: 'available', progress: undefined });
        emit();
        return { ok: false, message: 'Download cancelled', data: snapshot() };
      }
      m.progress = { received: Math.round((total * i) / steps), total };
      emit();
    }
    Object.assign(m, { status: 'verifying', progress: undefined });
    emit();
    await sleep(900);
    if (id === 'htdemucs-6s-demo') {
      Object.assign(m, { status: 'failed', message: 'SHA-256 mismatch for htdemucs_6s.onnx: the download was damaged. Try again.' });
      emit();
      return { ok: false, message: `${m.def.name}: SHA-256 mismatch for htdemucs_6s.onnx. The download was damaged; nothing was installed.`, data: snapshot() };
    }
    Object.assign(m, { status: 'installed', dir: `${MODELS_DIR}\\${id}` });
    emit();
    return { ok: true, message: `${m.def.name} installed`, data: snapshot() };
  }
  if (model('mdx-net-demo')) void download('mdx-net-demo', 45000);

  function resolve(t: AudioTarget): { path: string; name: string; seconds: number; sampleRate: number } | { error: string } {
    const p = host.project;
    if ('path' in t) {
      const oneShot = ONE_SHOT.test(t.path);
      return { path: t.path, name: baseName(t.path), seconds: oneShot ? 0.6 : 96, sampleRate: 48000 };
    }
    const chId = 'clipId' in t ? p.playlist.clips[t.clipId]?.channelId : t.channelId;
    if ('clipId' in t && !p.playlist.clips[t.clipId]) return { error: 'That clip no longer exists' };
    const ch = chId ? p.channels[chId] : null;
    if (!ch) return { error: 'That channel no longer exists' };
    const s = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : null;
    if (!s) return { error: `${ch.name} has no sample to analyze` };
    const sr = s.sampleRate ?? 48000;
    return { path: s.path, name: ch.name, seconds: s.frames ? s.frames / sr : ONE_SHOT.test(s.path) ? 0.6 : 96, sampleRate: sr };
  }

  const analyses = new Map<string, AudioAnalysis>();

  const api: AnalyzerApi = {
    state: async () => snapshot(),

    installModel: async (id) => {
      const m = model(id);
      if (!m) return { ok: false, message: `Unknown model "${id}"` };
      if (m.status === 'installed') return { ok: true, message: `${m.def.name} is already installed`, data: snapshot() };
      if (m.status === 'downloading' || m.status === 'verifying') return { ok: false, message: `${m.def.name} is already downloading` };
      if (m.status === 'unavailable') return { ok: false, message: m.message ?? `${m.def.name} has no published download` };
      return download(id, 6000);
    },

    cancelInstall: async (id) => {
      const m = model(id);
      if (!m || m.status !== 'downloading') return { ok: false, message: `${m?.def.name ?? id} isn't downloading` };
      dlCancel.add(id);
      return { ok: true };
    },

    importModel: async (id) => {
      const m = model(id);
      if (!m) return { ok: false, message: `Unknown model "${id}"` };
      Object.assign(m, { status: 'verifying', message: undefined });
      emit();
      await sleep(800);
      Object.assign(m, { status: 'installed', dir: `${MODELS_DIR}\\${id}` });
      emit();
      return { ok: true, message: `${m.def.name} installed from C:\\Users\\you\\Downloads\\${id}`, data: snapshot() };
    },

    removeModel: async (id) => {
      const m = model(id);
      if (!m) return { ok: false, message: `Unknown model "${id}"` };
      if (m.def.bundled) return { ok: false, message: `${m.def.name} ships with Krypt Studio and can't be removed` };
      Object.assign(m, { status: 'available', dir: undefined, message: undefined });
      emit();
      return { ok: true, data: snapshot() };
    },

    analyze: async (target) => {
      const src = resolve(target);
      if ('error' in src) return { ok: false, message: src.error };
      const cached = analyses.get(src.path);
      if (cached) return { ok: true, data: cached };
      const done = await runJob('analyze', `Analyzing "${src.name}"`, [
        { stage: 'decoding', ms: 450 },
        { stage: 'analyzing', ms: 1100 },
        { stage: 'sections', ms: 500, indeterminate: true },
      ]);
      if (!done) return { ok: false, message: 'Cancelled' };
      if (/fail/i.test(src.path)) return { ok: false, message: `Unsupported or corrupt audio file ${src.path}` };
      const a = fakeAnalysis(src.path, src.seconds, src.sampleRate);
      analyses.set(src.path, a);
      return { ok: true, data: a };
    },

    separateStems: async (clipId, opts) => {
      const p = host.project;
      const clip = p.playlist.clips[clipId];
      if (!clip || clip.kind !== 'audio' || !clip.channelId) return { ok: false, message: 'Pick an audio clip to separate' };
      const m = opts?.model ? model(opts.model) : st.models.find((x) => x.def.task === 'stems' && x.status === 'installed' && x.def.default) ?? st.models.find((x) => x.def.task === 'stems' && x.status === 'installed');
      if (!m || m.def.task !== 'stems') return { ok: false, message: 'Install a stem model (Model Manager)' };
      if (m.status !== 'installed') return { ok: false, message: `${m.def.name} isn't installed. Install it in the Model Manager.` };
      const src = resolve({ clipId });
      if ('error' in src) return { ok: false, message: src.error };
      const t0 = Date.now();
      const done = await runJob('separate', `Separating "${src.name}" (${m.def.name})`, [
        { stage: 'decoding', ms: 600 },
        { stage: 'separating', ms: 5000 },
        { stage: 'writing', ms: 700 },
      ]);
      if (!done) return { ok: false, message: 'Cancelled' };
      const stems = (m.def.stems ?? ['drums', 'bass', 'vocals', 'other']) as StemName[];
      const sample = p.samples[p.channels[clip.channelId].generator.sampleId ?? ''];
      const g = host.beginGroup(USER, `Separate stems of ${src.name}`);
      const trackIds: string[] = [];
      const channelIds: string[] = [];
      try {
        const at = host.project.playlist.trackOrder.indexOf(clip.trackId);
        stems.forEach((stem, i) => {
          const tr = host.exec<{ id: string }>('playlist.addTrack', { name: `${src.name} ${cap(stem)}`, index: at + 1 + i }, { actor: USER, groupId: g });
          if (!tr.ok || !tr.data) throw new Error(tr.message);
          const a = host.exec<{ channelId: string }>(
            'playlist.addAudio',
            {
              path: `${MODELS_DIR.replace(/models$/, 'stems')}\\${hashStr(src.path).toString(16)}-${m.def.id}\\${stem}.wav`,
              name: `${src.name} ${cap(stem)}`,
              trackId: tr.data.id,
              start: clip.start,
              frames: sample?.frames,
              sampleRate: sample?.sampleRate,
              channels: 2,
            },
            { actor: USER, groupId: g },
          );
          if (!a.ok || !a.data) throw new Error(a.message);
          trackIds.push(tr.data.id);
          channelIds.push(a.data.channelId);
        });
      } catch (err) {
        return { ok: false, message: `Couldn't place the stems: ${(err as Error).message}` };
      } finally {
        host.endGroup(g);
      }
      const outcome: StemsOutcome = { trackIds, channelIds, stems, model: m.def.id, device: 'directml', seconds: (Date.now() - t0) / 1000 };
      return { ok: true, data: outcome };
    },

    toPattern: async (target, opts) => {
      const src = resolve(target);
      if ('error' in src) return { ok: false, message: src.error };
      const mode: TranscribeMode = opts.mode;
      if (mode === 'poly' && model('basic-pitch')?.status !== 'installed') return { ok: false, message: 'Basic Pitch model not found (Model Manager)' };
      const done = await runJob('transcribe', `Transcribing "${src.name}" (${mode === 'poly' ? 'melody & chords' : mode === 'mono' ? 'single line' : 'drums'})`, [
        { stage: 'decoding', ms: 350 },
        { stage: 'transcribing', ms: 1600 },
      ]);
      if (!done) return { ok: false, message: 'Cancelled' };
      const g = host.beginGroup(USER, `Convert ${src.name} to a pattern`);
      try {
        const name = opts.name ?? `${src.name} ${mode === 'drums' ? 'drums' : 'notes'}`.slice(0, 64);
        const pat = host.exec<{ id: string }>('patterns.add', { name }, { actor: USER, groupId: g });
        if (!pat.ok || !pat.data) throw new Error(pat.message);
        const patternId = pat.data.id;
        const bar = PPQ * 4;
        const channelIds: string[] = [];
        let notes = 0;
        const addNotes = (channelId: string, list: Array<{ tick: number; key: number; dur?: number; vel?: number }>): void => {
          const r = host.exec('notes.add', { patternId, channelId, notes: list }, { actor: USER, groupId: g });
          if (!r.ok) throw new Error(r.message);
          notes += list.length;
          if (!channelIds.includes(channelId)) channelIds.push(channelId);
        };
        const addChannel = (type: string, chName: string, sampleId?: string): string => {
          const r = host.exec<{ id: string }>('channels.add', { type, name: chName, sampleId }, { actor: USER, groupId: g });
          if (!r.ok || !r.data) throw new Error(r.message);
          return r.data.id;
        };
        if (mode === 'drums') {
          const roles: Array<[string, string, number[]]> = [
            ['Kick', 'kick', [0, 6, 8, 16, 22, 24]],
            ['Snare', 'snare', [4, 12, 20, 28]],
            ['Hat', 'hat-closed', [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]],
          ];
          for (const [chName, file, steps] of roles) {
            const p = host.project;
            let id = p.channelOrder.find((c) => p.channels[c].name === chName);
            if (!id) {
              const s = host.exec<{ id: string }>('samples.add', { path: `factory:drums/${file}.wav` }, { actor: USER, groupId: g });
              if (!s.ok || !s.data) throw new Error(s.message);
              id = addChannel('krypt.sampler', chName, s.data.id);
            }
            addNotes(id, steps.map((st16) => ({ tick: st16 * (PPQ / 4), key: 60, dur: PPQ / 4, vel: chName === 'Hat' ? 0.55 + (st16 % 4 === 0 ? 0.2 : 0) : 0.9 })));
          }
        } else if (mode === 'poly') {
          const ch = addChannel('krypt.triosc', `${src.name} chords`.slice(0, 64));
          const prog = [
            [57, 60, 64],
            [53, 57, 60],
            [48, 52, 55],
            [55, 59, 62],
          ];
          const list: Array<{ tick: number; key: number; dur: number; vel: number }> = [];
          prog.forEach((chord, i) => chord.forEach((k) => list.push({ tick: i * bar, key: k, dur: bar - PPQ / 8, vel: 0.7 })));
          [76, 74, 72, 71, 72, 74, 76, 79].forEach((k, i) => list.push({ tick: i * (bar / 2), key: k, dur: bar / 2 - PPQ / 8, vel: 0.8 }));
          addNotes(ch, list);
        } else {
          const ch = addChannel('krypt.triosc', `${src.name} line`.slice(0, 64));
          const line = [69, 72, 74, 76, 74, 72, 69, 67, 69, 72, 76, 79, 76, 74, 72, 69];
          addNotes(ch, line.map((k, i) => ({ tick: i * (PPQ / 2), key: k, dur: PPQ / 2 - 40, vel: 0.75 + (i % 4 === 0 ? 0.15 : 0) })));
        }
        const out: ToPatternOutcome = { patternId, channelIds, notes };
        return { ok: true, data: out };
      } catch (err) {
        return { ok: false, message: `Couldn't build the pattern: ${(err as Error).message}` };
      } finally {
        host.endGroup(g);
      }
    },

    cancelJob: async (jobId) => {
      if (!st.jobs.some((j) => j.id === jobId)) return { ok: false, message: 'No such job' };
      cancelled.add(jobId);
      return { ok: true };
    },

    onState: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
  return api;
}
