import path from 'node:path';
import crypto from 'node:crypto';
import { USER, type DocHost } from '@shared/doc/DocHost';
import type { Channel, Clip } from '@shared/schema/project';
import type { AudioAnalysis, TranscriptionResult } from '@shared/analyzer/protocol';
import type { SampleInfo } from '@shared/engine/protocol';
import type { ActionResult, AudioTarget, ImportOutcome, MatchOutcome, TuneOutcome } from '@shared/types';
import { AUDIO_EXTENSIONS } from '@shared/audio/formats';
import { ticksPerBar } from '@shared/schema/time';
import { AUDIOCLIP, matchBpm, syncBpm, type TempoReading } from '@shared/analyzer/tempo';
import {
  fmtSemitones,
  keyLongName,
  keyShift,
  keyShortName,
  semitoneProblem,
  toKeyRef,
  transposeKey,
  tuneKeyFor,
  TUNE_STYLES,
  type KeyRef,
  type TuneKey,
  type TuneStyle,
} from '@shared/music/keymatch';
import { audioClipsOf, channelPitch, followsTempo, keySources, KEY_WEAK, notesKey, parentChannel, patternKey, planTune, rescaleForTempo, songOf, type PatternKey } from '@shared/vocals/plan';
import { removeFile, writeFileAtomic } from '../system/files';
import { statFile } from '../system/download';
import type { Apply, RunOptions } from '../analyzer/service';

export const MAX_IMPORT_BYTES = 60 * 1024 * 1024;
const PATTERN_KEY_MIN = 0.5;
const NOTES_KEY_MIN = 0.6;
const BIG_STRETCH = [0.75, 1.34] as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r2 = (n: number): number => Math.round(n * 100) / 100;
const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

function fail<T = never>(message: string): ActionResult<T> {
  return { ok: false, message };
}

export function cleanName(s: string, max = 64): string {
  const c = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim();
  return c.length > max ? c.slice(0, max).trim() : c;
}

export function importsDirOf(userDataDir: string): string {
  return path.join(userDataDir, 'imports');
}

export function uploadName(name: string): { ext: string; title: string } | { error: string } {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const m = /^(.*)\.([A-Za-z0-9]{2,5})$/.exec(base.trim());
  const ext = m ? m[2].toLowerCase() : '';
  if (!m || !AUDIO_EXTENSIONS.includes(ext)) {
    return { error: `name must be a file name with an audio extension (${AUDIO_EXTENSIONS.filter((e) => !['wave', 'oga', 'aifc', 'm4b', 'adts', '3g2', 'ec3'].includes(e)).join(', ')}), e.g. "vocal.wav"; got "${cleanName(base, 60) || '(empty)'}"` };
  }
  return { ext, title: cleanName(m[1], 64) || 'Imported audio' };
}

export function decodeBase64Audio(data: string, maxBytes = MAX_IMPORT_BYTES): { bytes: Uint8Array } | { error: string } {
  let s = String(data ?? '').trim();
  const url = /^data:[^,]*,/i.exec(s);
  if (url) {
    if (!/;base64,$/i.test(url[0])) return { error: 'data is a data: URL that is not base64-encoded; send the file as base64' };
    s = s.slice(url[0].length);
  }
  s = s.replace(/\s+/g, '');
  if (!s) return { error: 'data is empty: send the audio file as base64' };
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const size = Math.floor((s.length * 3) / 4) - pad;
  if (size > maxBytes) return { error: `The audio is ${mb(size)}; import_audio takes at most ${mb(maxBytes)} per file. Trim it, or send a compressed file (FLAC, MP3 or OGG).` };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) || s.length % 4 === 1) return { error: 'data is not valid base64 (only A-Z a-z 0-9 + / and = padding are allowed)' };
  const buf = Buffer.from(s, /[-_]/.test(s) ? 'base64url' : 'base64');
  if (!buf.length) return { error: 'data decoded to 0 bytes' };
  return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) };
}

export interface VocalsDeps {
  doc: DocHost;
  userDataDir: string;
  analyzer: {
    analyze(target: AudioTarget, opts?: RunOptions): Promise<ActionResult<AudioAnalysis>>;
    transcribe?(target: AudioTarget, mode?: 'mono' | 'drums', opts?: RunOptions): Promise<ActionResult<TranscriptionResult>>;
  } | null;
  sampleInfo(absPath: string): Promise<ActionResult<SampleInfo>>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface ImportOptions {
  start?: number;
  name?: string;
}

export interface MatchOptions {
  to?: 'project' | { clipId: string };
  key?: boolean;
  tempo?: boolean;
  semitones?: number;
  formant?: boolean;
}

export interface TuneOptions {
  style?: TuneStyle;
  key?: string;
  scale?: string;
  amount?: number;
  mix?: number;
}

export type KeySourceKind = TuneOutcome['keySource'];

interface FoundKey {
  key: KeyRef;
  confidence: number | null;
  source: KeySourceKind;
  how: string;
}

export class VocalsService {
  readonly importsDir: string;

  constructor(private readonly deps: VocalsDeps) {
    this.importsDir = importsDirOf(deps.userDataDir);
  }

  private get doc(): DocHost {
    return this.deps.doc;
  }

  private async analyze(target: AudioTarget, what: string, run: RunOptions): Promise<ActionResult<AudioAnalysis>> {
    const a = this.deps.analyzer;
    if (!a) return fail('Audio analysis is not available in this session (the analyzer service did not start; see the log)');
    const r = await a.analyze(target, run);
    if (!r.ok || !r.data) return fail(`Couldn't analyse ${what}: ${r.message ?? 'analysis failed'}`);
    return r;
  }

  async importUpload(bytes: Uint8Array, fileName: string, opts: ImportOptions, apply: Apply): Promise<ActionResult<ImportOutcome>> {
    const n = uploadName(fileName);
    if ('error' in n) return fail(n.error);
    if (!bytes.length) return fail('The audio data is empty');
    if (bytes.length > MAX_IMPORT_BYTES) return fail(`The audio is ${mb(bytes.length)}; import_audio takes at most ${mb(MAX_IMPORT_BYTES)} per file. Trim it, or send a compressed file (FLAC, MP3 or OGG).`);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const abs = path.join(this.importsDir, `${hash}.${n.ext}`);
    if (path.dirname(abs) !== this.importsDir) return fail('Refused: the import path left the imports folder');
    const st = await statFile(abs);
    const deduped = !!st && st.size === bytes.length;
    let created = false;
    if (!deduped) {
      try {
        await writeFileAtomic(abs, bytes);
        created = true;
      } catch (err) {
        return fail(`Couldn't store the audio in ${this.importsDir}: ${errText(err)}`);
      }
    }
    const info = await this.probe(abs, `${n.title}.${n.ext}`);
    if (!info.ok || !info.data) {
      if (created) await removeFile(abs).catch(() => {});
      return fail(info.message ?? 'The audio could not be read');
    }
    return this.place({ docPath: abs, abs, title: cleanName(opts.name ?? '', 64) || n.title, hash }, info.data, opts, apply, { deduped, bytes: bytes.length });
  }

  async importFile(file: { docPath: string; abs: string }, opts: ImportOptions, apply: Apply): Promise<ActionResult<ImportOutcome>> {
    const base = path.basename(file.abs);
    const st = await statFile(file.abs);
    if (!st) return fail(`File not found: ${file.abs}`);
    const info = await this.probe(file.abs, base);
    if (!info.ok || !info.data) return fail(info.message ?? 'The audio could not be read');
    const title = cleanName(opts.name ?? '', 64) || cleanName(base.replace(/\.[a-z0-9]+$/i, ''), 64) || 'Audio';
    return this.place({ docPath: file.docPath, abs: file.abs, title }, info.data, opts, apply, { deduped: false, bytes: st.size });
  }

  private async probe(abs: string, label: string): Promise<ActionResult<SampleInfo>> {
    let r: ActionResult<SampleInfo>;
    try {
      r = await this.deps.sampleInfo(abs);
    } catch (err) {
      r = fail(errText(err));
    }
    if (r.ok && r.data && r.data.frames > 0 && r.data.sampleRate > 0) return r;
    const why = (r.message ?? 'no audio frames').split(abs).join(label);
    if (/isn'?t running|not running|is starting|restarting/i.test(why)) return fail(`The audio engine isn't running, so "${label}" can't be checked and placed. Try again once it is running (Settings ▸ Audio shows its state). (${why})`);
    return fail(`"${label}" isn't audio Krypt Studio can decode: ${why}. Send a wav, flac, mp3, ogg, aiff or m4a file.`);
  }

  private place(
    file: { docPath: string; abs: string; title: string; hash?: string },
    info: SampleInfo,
    opts: ImportOptions,
    apply: Apply,
    extra: { deduped: boolean; bytes: number },
  ): ActionResult<ImportOutcome> {
    const p = this.doc.project;
    const start = Math.max(0, Math.round(opts.start ?? 0));
    const used = new Set(Object.values(p.playlist.clips).map((c) => c.trackId));
    let index = 0;
    p.playlist.trackOrder.forEach((t, i) => {
      if (used.has(t)) index = i + 1;
    });
    let t: { id: string };
    let a: { clipId: string; channelId: string; sampleId: string };
    try {
      t = apply<{ id: string }>('playlist.addTrack', { name: file.title, index });
      a = apply<{ clipId: string; channelId: string; sampleId: string }>('playlist.addAudio', {
        path: file.docPath,
        name: file.title,
        trackId: t.id,
        start,
        frames: info.frames,
        sampleRate: info.sampleRate,
        channels: info.channels,
        ...(file.hash ? { hash: file.hash } : {}),
      });
    } catch (err) {
      return fail(`The audio is ready but couldn't be placed on the playlist: ${errText(err)}`);
    }
    const p2 = this.doc.project;
    const durationSec = info.frames / info.sampleRate;
    const track = p2.playlist.trackOrder.indexOf(t.id) + 1;
    const name = p2.channels[a.channelId]?.name ?? file.title;
    return {
      ok: true,
      message: `Imported "${name}" (${r2(durationSec)} s, ${info.sampleRate} Hz, ${info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`}) on new track ${track} at bar ${Math.floor(start / ticksPerBar(p2.transport.timeSig)) + 1}${extra.deduped ? ' (the same audio was imported before: its stored copy was reused)' : ''}.`,
      data: {
        clipId: a.clipId,
        channelId: a.channelId,
        sampleId: a.sampleId,
        trackId: t.id,
        track,
        trackName: p2.playlist.tracks[t.id]?.name ?? file.title,
        name,
        durationSec: r2(durationSec),
        sampleRate: info.sampleRate,
        channels: info.channels,
        path: file.abs,
        deduped: extra.deduped,
        bytes: extra.bytes,
      },
    };
  }

  private async noteKey(target: AudioTarget, run: RunOptions): Promise<PatternKey | null> {
    const a = this.deps.analyzer;
    if (!a?.transcribe) return null;
    const r = await a.transcribe(target, 'mono', run);
    if (!r.ok || !r.data) return null;
    const k = notesKey(r.data.notes.map((n) => ({ key: n.key, durSec: n.durSec })));
    return k && k.confidence >= NOTES_KEY_MIN ? k : null;
  }

  private async clipKey(clip: Clip, ch: Channel, run: RunOptions): Promise<ActionResult<{ key: KeyRef | null; confidence: number; how: string; analysis: AudioAnalysis }>> {
    const p = this.doc.project;
    const parent = parentChannel(p, ch);
    const r = await this.analyze(parent ? { channelId: parent.id } : { clipId: clip.id }, `"${ch.name}"`, run);
    if (!r.ok || !r.data) return fail(r.message ?? 'Analysis failed');
    const pitch = channelPitch(this.doc.catalog, ch);
    const raw = toKeyRef(r.data.key);
    const key = raw ? transposeKey(raw, pitch) : null;
    const conf = r.data.key?.confidence ?? 0;
    const how = key
      ? `"${ch.name}" in ${keyLongName(key)}${pitch ? ` (${keyShortName(raw!)} pitched ${fmtSemitones(pitch)})` : ''}${parent ? `, read from its source mix "${parent.name}"` : ''}, confidence ${r2(conf)}`
      : `"${ch.name}" has no clear key${parent ? ` (its source mix "${parent.name}")` : ''}`;
    return { ok: true, data: { key, confidence: conf, how, analysis: r.data } };
  }

  private async projectKey(channelId: string, song: string | null, run: RunOptions): Promise<FoundKey | null> {
    const p = this.doc.project;
    const pk = patternKey(p);
    if (pk && pk.confidence >= PATTERN_KEY_MIN) return { key: pk.key, confidence: pk.confidence, source: 'patterns', how: `the project's patterns (${pk.notes} pitched notes) in ${keyLongName(pk.key)}, confidence ${r2(pk.confidence)}` };
    const audio = await this.instrumentalKey(new Set([channelId]), song ? new Set([song]) : new Set(), run);
    if (audio) return audio;
    if (pk) return { key: pk.key, confidence: pk.confidence, source: 'patterns', how: `the project's patterns (${pk.notes} pitched notes) in ${keyLongName(pk.key)}, a weak reading (confidence ${r2(pk.confidence)})` };
    return null;
  }

  private async instrumentalKey(excludeChannels: Set<string>, excludeSongs: Set<string>, run: RunOptions): Promise<FoundKey | null> {
    if (!this.deps.analyzer) return null;
    const p = this.doc.project;
    let best: FoundKey | null = null;
    for (const s of keySources(p, this.doc.catalog, excludeChannels, excludeSongs).slice(0, 3)) {
      const r = await this.deps.analyzer.analyze({ channelId: s.analyseChannelId }, run);
      if (!r.ok || !r.data?.key) continue;
      const raw = toKeyRef(r.data.key);
      if (!raw) continue;
      const key = transposeKey(raw, s.pitch);
      const conf = r.data.key.confidence;
      const via = s.analyseChannelId !== s.channel.id ? `, read from its source mix "${p.channels[s.analyseChannelId]?.name ?? '?'}"` : '';
      const found: FoundKey = { key, confidence: conf, source: 'instrumental', how: `"${s.channel.name}" in ${keyLongName(key)}${s.pitch ? ` (${keyShortName(raw)} pitched ${fmtSemitones(s.pitch)})` : ''}${via}, confidence ${r2(conf)}` };
      if (conf >= KEY_WEAK) return found;
      if (!best || conf > (best.confidence ?? 0)) best = found;
    }
    return best;
  }

  async match(clipId: string, opts: MatchOptions, apply: Apply, run: RunOptions = {}): Promise<ActionResult<MatchOutcome>> {
    const p0 = this.doc.project;
    const catalog = this.doc.catalog;
    const clip = p0.playlist.clips[String(clipId)];
    if (!clip) return fail('That clip no longer exists');
    if (clip.kind !== 'audio' || !clip.channelId) return fail(`That is a ${clip.kind} clip; only audio clips can be matched`);
    const ch = p0.channels[clip.channelId];
    if (!ch) return fail("The clip's audio channel no longer exists");
    if (ch.generator.type !== AUDIOCLIP) return fail(`"${ch.name}" isn't an audio clip channel`);
    const ac = catalog.plugins.find((x) => x.id === AUDIOCLIP);
    const missing = ['pitch', 'formant', 'tempo_sync', 'src_bpm'].filter((id) => !ac?.params.some((s) => s.id === id));
    if (missing.length) return fail(`This build's Audio Clip has no ${missing.join(' / ')} parameter: the time-stretch engine update isn't built. Update or rebuild Krypt Studio (npm run engine:build).`);
    if (opts.semitones !== undefined) {
      const why = semitoneProblem(opts.semitones);
      if (why) return fail(why);
    }
    const wantKey = opts.key !== false || opts.semitones !== undefined;
    const wantTempo = opts.tempo !== false;
    if (!wantKey && !wantTempo) return fail('Nothing to match: key and tempo are both off');

    let target: { clip: Clip; ch: Channel } | null = null;
    if (opts.to && opts.to !== 'project') {
      const tc = p0.playlist.clips[opts.to.clipId];
      if (!tc) return fail('The clip to match to no longer exists');
      if (tc.kind !== 'audio' || !tc.channelId || !p0.channels[tc.channelId]) return fail('Match to an audio clip (or to the project)');
      if (tc.channelId === ch.id) return fail(`"${ch.name}" can't be matched to itself`);
      target = { clip: tc, ch: p0.channels[tc.channelId] };
    }
    const toLabel = target ? `"${target.ch.name}"` : 'the project';
    const warnings: string[] = [];
    const notes: string[] = [];

    const srcParent = parentChannel(p0, ch);
    const srcWhat = srcParent ? `"${ch.name}" (its source mix "${srcParent.name}")` : `"${ch.name}"`;
    let srcA: AudioAnalysis | null = null;
    if ((wantKey && opts.semitones === undefined) || wantTempo) {
      const r = await this.analyze(srcParent ? { channelId: srcParent.id } : { clipId: clip.id }, srcWhat, run);
      if (!r.ok || !r.data) return fail(r.message ?? 'Analysis failed');
      srcA = r.data;
    }
    let tgt: { key: KeyRef | null; confidence: number; how: string; analysis: AudioAnalysis } | null = null;
    if (target && ((wantKey && opts.semitones === undefined) || (wantTempo && !followsTempo(catalog, target.ch)))) {
      const r = await this.clipKey(target.clip, target.ch, run);
      if (!r.ok || !r.data) return fail(r.message ?? 'Analysis failed');
      tgt = r.data;
    }

    let semis: number | null = null;
    let fromKey: KeyRef | null = null;
    let srcConf = 0;
    let srcHow = '';
    let toKey: KeyRef | null = null;
    let keyText = '';
    if (opts.semitones !== undefined) {
      semis = opts.semitones;
      fromKey = toKeyRef(srcA?.key ?? null);
      keyText = `pitched ${fmtSemitones(semis)} (as asked${fromKey && Number.isInteger(semis) ? `: ${keyLongName(fromKey)} → ${keyLongName(transposeKey(fromKey, semis))}` : ''})`;
    } else if (wantKey) {
      const chroma = toKeyRef(srcA?.key ?? null);
      const chromaConf = srcA?.key?.confidence ?? 0;
      fromKey = chroma;
      srcConf = chromaConf;
      srcHow = chroma ? `${srcWhat} in ${keyLongName(chroma)} (confidence ${r2(chromaConf)})` : '';
      if (!chroma || chromaConf < KEY_WEAK) {
        const nk = await this.noteKey({ clipId: clip.id }, run);
        if (nk) {
          fromKey = nk.key;
          srcConf = nk.confidence;
          srcHow = `"${ch.name}" in ${keyLongName(nk.key)}, read from its ${nk.notes} transcribed notes (confidence ${r2(nk.confidence)}; ${chroma ? `the audio's own key reading, ${keyLongName(chroma)} at ${r2(chromaConf)}, was weak` : 'the audio itself gave no clear key'})`;
        }
      }
      let found: FoundKey | null = null;
      if (target) found = tgt?.key ? { key: tgt.key, confidence: tgt.confidence, source: 'instrumental', how: tgt.how } : null;
      else found = await this.projectKey(ch.id, songOf(p0, ch), run);
      if (!fromKey) warnings.push(`Key left alone: ${srcWhat} has no clear key. Pass semitones to move it by hand.`);
      else if (!found) warnings.push(`Key left alone: ${target ? `${toLabel} has no clear key` : "couldn't tell the project's key (no pitched patterns and no other audio with a clear key)"}. Pass semitones, or match to a clip.`);
      else {
        toKey = found.key;
        const s = keyShift(fromKey, toKey);
        semis = s.semitones;
        if (s.relation === 'same') keyText = `stays in ${keyLongName(fromKey)}, already the key of ${toLabel}`;
        else if (s.relation === 'relative') keyText = `stays in ${keyLongName(fromKey)}: ${toLabel} is in ${keyLongName(toKey)}, its relative ${fromKey.minor ? 'major' : 'minor'} (the same notes), so it needs 0 st`;
        else keyText = `moved ${fmtSemitones(semis)} (${keyLongName(fromKey)} → ${keyLongName(s.result)}${s.result.minor !== toKey.minor ? `, the relative ${s.result.minor ? 'minor' : 'major'} of ${keyLongName(toKey)}` : ''}) to match ${toLabel}`;
        notes.push(`Keys: ${srcHow}; target: ${found.how}.`);
        if (srcConf < KEY_WEAK || (found.confidence ?? 1) < KEY_WEAK) warnings.push('One of the key readings is weak: listen, and pass semitones if the move sounds wrong.');
      }
    }

    const P = p0.transport.bpm;
    let follows = P;
    let adopt: number | null = null;
    let read: TempoReading | null = null;
    let tempoText = '';
    if (wantTempo) {
      if (!srcA?.tempo) warnings.push(`Tempo left alone: no steady tempo was detected in ${srcWhat}. Use stretch_clip with source_bpm if you know it.`);
      else {
        if (target && !followsTempo(catalog, target.ch)) {
          const tt = tgt?.analysis.tempo ?? null;
          if (!tt) warnings.push(`${toLabel} has no steady tempo, so "${ch.name}" follows the project tempo (${P} bpm) instead.`);
          else {
            const t = syncBpm(tt, P);
            if (Math.abs(t / P - 1) > 0.02) {
              adopt = t;
              follows = t;
            }
          }
        }
        read = matchBpm(srcA.tempo, follows);
        const how = read.reading === 'as detected' ? `${read.bpm} bpm as detected` : `detected ${read.detected} bpm, read as ${read.bpm} (${read.reading})`;
        tempoText = `follows ${adopt ? '' : "the project's "}${follows} bpm (${how}; plays ×${r2(read.ratio)})`;
        if (read.ratio < BIG_STRETCH[0] || read.ratio > BIG_STRETCH[1]) warnings.push(`That is a big stretch (×${r2(read.ratio)}): expect artefacts. A tempo closer to ${read.bpm} bpm (set_tempo) would sound cleaner.`);
      }
    }
    if (semis === null && !read) return fail(`Couldn't match "${ch.name}": ${warnings.join(' ')}`);

    const before = this.doc.version;
    try {
      if (adopt && target) {
        apply('channels.setGenParams', { id: target.ch.id, params: { tempo_sync: 1, src_bpm: adopt } });
        const keep = rescaleForTempo(this.doc.project, this.doc.catalog, P, adopt, new Set([target.ch.id]));
        if (keep) apply(keep.cmd, keep.args);
        apply('transport.set', { bpm: adopt });
      }
      const params: Record<string, number> = {};
      if (semis !== null) {
        params.pitch = semis;
        if (semis !== 0) params.formant = opts.formant === false ? 0 : 1;
      }
      if (read) {
        params.tempo_sync = 1;
        params.src_bpm = read.bpm;
      }
      if (Object.keys(params).length) apply('channels.setGenParams', { id: ch.id, params });
    } catch (err) {
      return fail(`Couldn't apply the match: ${errText(err)}`);
    }
    const changed = this.doc.version !== before;
    const p = this.doc.project;
    const parts = [keyText, tempoText].filter(Boolean);
    const nowClip = audioClipsOf(p, ch.id).find((c) => c.id === clip.id);
    let message = `"${ch.name}": ${parts.join('; ')}.`;
    if (adopt && target) message += ` Project tempo set to ${adopt} bpm from ${toLabel}, which now follows it unstretched${P !== adopt ? ` (was ${P} bpm)` : ''}.`;
    if (!changed) {
      const now: string[] = [];
      if (semis !== null) now.push(`pitch ${fmtSemitones(semis)}${fromKey && Number.isInteger(semis) ? ` (${keyLongName(fromKey)} → ${keyLongName(transposeKey(fromKey, semis))})` : ''}`);
      if (read) now.push(`following ${follows} bpm from ${read.bpm} bpm`);
      message = `"${ch.name}" already matches ${toLabel}${now.length ? `: ${now.join(', ')}` : ''}; nothing changed.`;
    }
    if (changed && nowClip && nowClip.length !== clip.length) message += ` Its clip was rescaled so the same audio stays visible.`;
    if (notes.length) message += ` ${notes.join(' ')}`;
    if (warnings.length) message += ` ${warnings.join(' ')}`;
    return {
      ok: true,
      message,
      data: {
        channelId: ch.id,
        semitones: semis,
        fromKey: fromKey ? keyShortName(fromKey) : null,
        toKey: toKey ? keyShortName(toKey) : null,
        resultKey: fromKey && semis !== null && Number.isInteger(semis) ? keyShortName(transposeKey(fromKey, semis)) : null,
        sourceBpm: read?.bpm ?? null,
        reading: read?.reading ?? null,
        followsBpm: read ? follows : null,
        ratio: read ? r2(read.ratio) : null,
        projectBpm: p.transport.bpm,
        projectTempoChanged: p.transport.bpm !== P,
        changed,
      },
    };
  }

  private async tuneKey(ch: Channel, clip: Clip | null, run: RunOptions): Promise<ActionResult<FoundKey> & { warnings?: string[] }> {
    const p = this.doc.project;
    const pitch = channelPitch(this.doc.catalog, ch);
    const target: AudioTarget = clip ? { clipId: clip.id } : { channelId: ch.id };
    const shifted = (raw: KeyRef): string => (pitch ? ` (${keyShortName(raw)} pitched ${fmtSemitones(pitch)})` : '');
    let weak: FoundKey | null = null;
    let why = 'the vocal has no sample to analyse';
    if (ch.generator.sampleId) {
      if (!this.deps.analyzer) why = 'audio analysis is not available in this session';
      else {
        const r = await this.deps.analyzer.analyze(target, run);
        if (!r.ok || !r.data) why = `the vocal couldn't be analysed (${r.message ?? 'analysis failed'})`;
        else {
          const raw = toKeyRef(r.data.key);
          if (!raw) why = 'the vocal has no clear key';
          else {
            const key = transposeKey(raw, pitch);
            const conf = r.data.key!.confidence;
            const found: FoundKey = { key, confidence: conf, source: 'vocal', how: `the vocal's own analysis: ${keyLongName(key)}${shifted(raw)}, confidence ${r2(conf)}` };
            if (conf >= KEY_WEAK) return { ok: true, data: found };
            weak = found;
            why = `the vocal's own key reading is weak (${keyLongName(key)}, confidence ${r2(conf)})`;
          }
        }
      }
    }
    const inst = await this.instrumentalKey(new Set([ch.id]), new Set(), run);
    if (inst && (inst.confidence ?? 0) >= KEY_WEAK) return { ok: true, data: { ...inst, how: `${inst.how} (the instrumental), because ${why}` } };
    const pk = patternKey(p);
    const fromPatterns = (note: string): FoundKey => ({ key: pk!.key, confidence: pk!.confidence, source: 'patterns', how: `the project's patterns (${pk!.notes} pitched notes): ${keyLongName(pk!.key)}, confidence ${r2(pk!.confidence)}${note}, because ${why}` });
    if (pk && pk.confidence >= PATTERN_KEY_MIN) return { ok: true, data: fromPatterns('') };
    if (ch.generator.sampleId && this.deps.analyzer) {
      const nk = await this.noteKey(target, run);
      if (nk) {
        const key = transposeKey(nk.key, pitch);
        return { ok: true, data: { key, confidence: nk.confidence, source: 'vocal', how: `the vocal's ${nk.notes} transcribed notes: ${keyLongName(key)}${shifted(nk.key)}, confidence ${r2(nk.confidence)}, because ${why} and nothing else in the project has a clear key` } };
      }
    }
    const warn = 'The key reading is weak: listen, and pass a key (e.g. "F#m") if notes snap to the wrong pitches.';
    if (pk) return { ok: true, data: fromPatterns(', a weak reading'), warnings: [warn] };
    if (weak) return { ok: true, data: { ...weak, how: `${weak.how}, a weak reading (nothing else in the project has a clearer key)` }, warnings: [warn] };
    if (inst) return { ok: true, data: { ...inst, how: `${inst.how}, a weak reading, because ${why}` }, warnings: [warn] };
    return fail(`Couldn't tell which key to tune "${ch.name}" to: ${why}, and nothing else in the project has a clear key. Pass a key, e.g. "F#m" or "A minor".`);
  }

  async tune(target: AudioTarget, opts: TuneOptions, apply: Apply, run: RunOptions = {}): Promise<ActionResult<TuneOutcome>> {
    const p0 = this.doc.project;
    let clip: Clip | null = null;
    let ch: Channel | null = null;
    if ('clipId' in target) {
      clip = p0.playlist.clips[target.clipId] ?? null;
      if (!clip) return fail('That clip no longer exists');
      if (clip.kind !== 'audio' || !clip.channelId) return fail(`That is a ${clip.kind} clip: Krypt Tune works on audio clips (or a channel)`);
      ch = p0.channels[clip.channelId] ?? null;
    } else if ('channelId' in target) ch = p0.channels[target.channelId] ?? null;
    else return fail('Pick an audio clip or a channel to tune');
    if (!ch) return fail('That channel no longer exists');
    const style: TuneStyle = opts.style ?? 'pop';
    if (!TUNE_STYLES[style]) return fail(`Unknown style "${style}": use natural, pop or hard`);
    if (!this.doc.catalog.plugins.some((x) => x.id === 'krypt.pitch')) return fail("This build has no Krypt Tune effect (krypt.pitch). Update or rebuild Krypt Studio's engine.");
    const ins0 = p0.mixer.inserts[ch.insertId];
    if (!ins0) return fail(`"${ch.name}" has no mixer insert`);
    if (ins0.isMaster) return fail(`"${ch.name}" plays straight into the Master: route it to its own mixer insert first (route tool, or the Channel Rack's insert number), so the correction only touches the vocal`);

    let tk: TuneKey;
    let found: FoundKey;
    const warnings: string[] = [];
    try {
      if (opts.key?.trim()) {
        tk = tuneKeyFor(opts.key.trim(), opts.scale);
        found = { key: { pc: tk.root, minor: tk.scale === 2 }, confidence: null, source: 'given', how: 'the key you gave' };
      } else {
        const k = await this.tuneKey(ch, clip, run);
        if (!k.ok || !k.data) return fail(k.message ?? 'No key');
        found = k.data;
        warnings.push(...(k.warnings ?? []));
        tk = tuneKeyFor(found.key, opts.scale);
      }
    } catch (err) {
      return fail(errText(err));
    }
    if (tk.note) warnings.push(`${tk.note}.`);

    const p = this.doc.project;
    let plan: ReturnType<typeof planTune>;
    try {
      plan = planTune(p, ch.insertId, tk, style, { amount: opts.amount, mix: opts.mix });
    } catch (err) {
      return fail(errText(err));
    }
    const sharers = p.channelOrder.filter((id) => id !== ch!.id && p.channels[id]?.insertId === ch!.insertId).map((id) => `"${p.channels[id].name}"`);
    if (sharers.length) warnings.push(`Insert "${p.mixer.inserts[ch.insertId].name}" also carries ${sharers.join(', ')}: the correction applies to them too.`);
    if (plan.extra) warnings.push(`The insert has ${plan.extra + 1} Krypt Tune effects; the first one was updated.`);

    const before = this.doc.version;
    let slotId = plan.slotId;
    try {
      for (const s of plan.steps) {
        const out = apply<{ id?: string }>(s.cmd, s.args);
        if (s.cmd === 'mixer.addSlot' && out?.id) slotId = out.id;
      }
    } catch (err) {
      return fail(`Couldn't set up Krypt Tune: ${errText(err)}`);
    }
    const changed = this.doc.version !== before;
    const after = this.doc.project.mixer.inserts[ch.insertId];
    const preset = TUNE_STYLES[style];
    const names = (types: string[]): string => types.map((t) => this.doc.catalog.plugins.find((x) => x.id === t)?.name.replace(/^Krypt /, '') ?? t).join(' → ');
    const pos = slotId ? after.slotOrder.indexOf(slotId) + 1 : plan.index + 1;
    const where = plan.slotId
      ? `updated the Krypt Tune already in slot ${pos} of "${after.name}"${plan.enable ? ' and switched it back on' : ''}`
      : `added Krypt Tune to "${after.name}" in slot 1${plan.after.length ? `, before ${names(plan.after)}` : ''}`;
    const settings = `${tk.label}, ${preset.label} (retune ${preset.speed} ms, humanize ${Math.round(preset.humanize * 100)}%${plan.params.amount !== 1 ? `, amount ${Math.round(plan.params.amount * 100)}%` : ''})`;
    let message = changed
      ? `Tuned "${ch.name}": ${where}: ${settings}. Key from ${found.how}.`
      : `"${ch.name}" is already tuned that way: ${settings}.`;
    if (warnings.length) message += ` ${warnings.join(' ')}`;
    return {
      ok: true,
      message,
      data: { insertId: ch.insertId, slotId: slotId ?? '', created: !plan.slotId, key: tk.label, root: tk.root, scale: tk.scale, style, keySource: found.source, confidence: found.confidence === null ? null : r2(found.confidence), changed },
    };
  }
}

export function userGroupApply(doc: DocHost, label: string): { apply: Apply; finish(ok: boolean): void } {
  const groupId = doc.beginGroup(USER, label);
  return {
    apply: <T>(cmd: string, args: unknown): T => {
      const r = doc.exec<T>(cmd, args, { actor: USER, groupId });
      if (!r.ok) throw new Error(r.message ?? `${cmd} failed`);
      return r.data as T;
    },
    finish(ok: boolean) {
      doc.endGroup(groupId);
      if (ok) return;
      const entry = doc.getHistory().find((h) => h.groupId === groupId && !h.undone);
      if (entry) doc.toggleEntry(entry.id, USER);
    },
  };
}

