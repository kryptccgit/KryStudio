// ──────────────────────────────────────────────────────────────────────
// "Ears" (Wave 3A) renderer logic with no React and no window access, so
// it is unit-tested in test/ears.test.ts: labels for analysis values, the
// section timeline, the energy sparkline, model grouping for the Model
// Manager, the status-bar job list, and which audio a menu acts on.
// ──────────────────────────────────────────────────────────────────────

import type { Project } from '@shared/schema/project';
import type { AudioAnalysis, StemName, TranscribeMode } from '@shared/analyzer/protocol';
import type { ModelDef, ModelTask } from '@shared/analyzer/models';
import type { AnalyzerJobInfo, AnalyzerState, AudioTarget, MatchOutcome, ModelState, TuneOutcome } from '@shared/types';
import { fmtSemitones, TUNE_STYLES } from '@shared/music/keymatch';

// ── Analysis values ───────────────────────────────────────────────────

/** 140 → "140", 127.94 → "127.9" (whole numbers stay whole). */
export function fmtBpm(bpm: number): string {
  if (!Number.isFinite(bpm)) return '?';
  return Math.abs(bpm - Math.round(bpm)) < 0.05 ? String(Math.round(bpm)) : bpm.toFixed(1);
}

// Near-whole tempos snap to whole BPM; syncing picks the half/double reading nearest the project tempo.
export { snapBpm, syncBpm } from '@shared/analyzer/tempo';

/** The other plausible readings (half / double time), without the main one or duplicates. Max 2. */
export function tempoAlternatives(tempo: NonNullable<AudioAnalysis['tempo']>): number[] {
  const seen = new Set<string>([fmtBpm(tempo.bpm)]);
  const out: number[] = [];
  for (const b of tempo.alternatives ?? []) {
    if (!Number.isFinite(b) || b < 10 || b > 999) continue;
    const k = fmtBpm(b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
    if (out.length === 2) break;
  }
  return out;
}

/** "140 BPM (or 70)" — one line for toasts and menus. */
export function tempoText(tempo: AudioAnalysis['tempo']): string {
  if (!tempo) return 'No steady tempo';
  const alts = tempoAlternatives(tempo);
  return `${fmtBpm(tempo.bpm)} BPM${alts.length ? ` (or ${alts.map(fmtBpm).join(' / ')})` : ''}`;
}

/** 'F#m' / tonic + mode → "F# minor". */
export function keyText(key: AudioAnalysis['key']): string {
  if (!key) return 'No clear key';
  return `${key.tonic} ${key.mode}`;
}

/** 16th swing on the transport scale → "Straight" / "18%". */
export function swingText(swing: number | null): string {
  if (swing === null || !Number.isFinite(swing)) return 'Unknown';
  if (swing < 0.04) return 'Straight';
  return `${Math.round(Math.min(1, swing) * 100)}%`;
}

export type Confidence = 'high' | 'medium' | 'low';

export function confidenceLevel(c: number): Confidence {
  return c >= 0.75 ? 'high' : c >= 0.45 ? 'medium' : 'low';
}

/** Is this field an estimate (heuristic or ML) rather than a measurement? */
export function isEstimated(a: Pick<AudioAnalysis, 'estimated'>, field: string): boolean {
  return Array.isArray(a.estimated) && a.estimated.includes(field);
}

/** Seconds → "3:07" / "42.5 s". */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Seconds → "1:05.2" for section boundaries. */
export function fmtTime(sec: number): string {
  const t = Math.max(0, sec);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** One-line summary for a toast: "140 BPM (or 70) · F# minor". */
export function analysisSummary(a: AudioAnalysis): string {
  return [tempoText(a.tempo), a.key ? keyText(a.key) : null].filter(Boolean).join(' · ');
}

// ── Sections timeline ─────────────────────────────────────────────────

const SECTION_COLORS = ['#6366F1', '#A855F7', '#EC4899', '#06B6D4', '#F59E0B', '#22C55E', '#F97316', '#3B82F6'];

/** Same label = same color (A indigo, B purple, C pink, ...). */
export function sectionColor(label: string): string {
  const c = (label || 'A').toUpperCase().charCodeAt(0) - 65;
  const i = Number.isFinite(c) && c >= 0 ? c : Math.abs(hash(label));
  return SECTION_COLORS[i % SECTION_COLORS.length];
}

export interface SectionBlock {
  label: string;
  color: string;
  /** Percent of the timeline width. */
  left: number;
  width: number;
  startSec: number;
  endSec: number;
  lufs: number;
}

/** Lay sections out on a 0..100% timeline (clamped, zero-length ones dropped). */
export function sectionBlocks(sections: AudioAnalysis['sections'], durationSec: number): SectionBlock[] {
  const dur = durationSec > 0 ? durationSec : Math.max(0, ...sections.map((s) => s.endSec));
  if (!(dur > 0)) return [];
  const out: SectionBlock[] = [];
  for (const s of sections) {
    const a = Math.max(0, Math.min(dur, s.startSec));
    const b = Math.max(a, Math.min(dur, s.endSec));
    if (b - a <= 0) continue;
    out.push({ label: s.label, color: sectionColor(s.label), left: (100 * a) / dur, width: (100 * (b - a)) / dur, startSec: a, endSec: b, lufs: s.lufs });
  }
  return out;
}

// ── Energy sparkline ──────────────────────────────────────────────────

/**
 * SVG path for a loudness curve in a w×h box. Silence (and anything under
 * `floor` LUFS) sits on the baseline; the loudest point touches the top.
 * Returns '' when there is nothing to draw.
 */
export function sparklinePath(values: number[], w: number, h: number, floor = -45): string {
  const v = values.map((x) => (Number.isFinite(x) ? Math.max(floor, x) : floor));
  if (v.length < 2 || w <= 0 || h <= 0) return '';
  const max = Math.max(...v);
  const min = Math.min(floor, ...v);
  const span = max - min || 1;
  const pad = 1;
  const pts = v.map((x, i) => {
    const px = (i / (v.length - 1)) * w;
    const py = pad + (1 - (x - min) / span) * (h - 2 * pad);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
  return `M${pts.join(' L')}`;
}

/** The same curve closed along the bottom edge (for a soft fill under the line). */
export function sparklineArea(values: number[], w: number, h: number, floor = -45): string {
  const line = sparklinePath(values, w, h, floor);
  return line ? `${line} L${w.toFixed(1)},${h} L0,${h} Z` : '';
}

// ── Models (Model Manager) ────────────────────────────────────────────

export const TASK_ORDER: ModelTask[] = ['stems', 'transcribe', 'beats', 'tts'];

export const TASK_TITLE: Record<ModelTask, string> = {
  stems: 'Stems',
  transcribe: 'Transcription',
  beats: 'Beats',
  tts: 'Voice',
};

export const TASK_BLURB: Record<ModelTask, string> = {
  stems: 'Split a mix into drums, bass, vocals and the rest',
  transcribe: 'Turn audio into notes (Convert to pattern)',
  beats: 'Find beats and downbeats for tempo detection',
  tts: 'Text to speech and "Sing my notes" for Krypt Voice',
};

/** Models grouped by task in display order; within a group: default first, then by name. */
export function groupModels(models: ModelState[]): Array<{ task: ModelTask; title: string; blurb: string; models: ModelState[] }> {
  const out: Array<{ task: ModelTask; title: string; blurb: string; models: ModelState[] }> = [];
  const tasks = [...TASK_ORDER, ...[...new Set(models.map((m) => m.def.task))].filter((t) => !TASK_ORDER.includes(t))];
  for (const task of tasks) {
    const list = models
      .filter((m) => m.def.task === task)
      .sort((a, b) => Number(!!b.def.default) - Number(!!a.def.default) || a.def.name.localeCompare(b.def.name));
    if (list.length) out.push({ task, title: TASK_TITLE[task] ?? task, blurb: TASK_BLURB[task] ?? '', models: list });
  }
  return out;
}

/** Total download size in bytes (0 when the catalog doesn't know yet). */
export function modelBytes(def: ModelDef): number {
  return def.files.reduce((n, f) => n + (Number.isFinite(f.bytes) ? f.bytes : 0), 0);
}

/** Host the files come from ("github.com"), or null for bundled / unknown. */
export function modelSource(def: ModelDef): string | null {
  for (const f of def.files) {
    if (!f.url) continue;
    try {
      return new URL(f.url).host;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const STEM_LABEL: Record<StemName, string> = { drums: 'Drums', bass: 'Bass', vocals: 'Vocals', other: 'Other', guitar: 'Guitar', piano: 'Piano' };

export function stemLabel(s: StemName | string): string {
  return STEM_LABEL[s as StemName] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

/** Installed stem-separation models, default first. */
export function installedStemModels(state: AnalyzerState | null): ModelDef[] {
  if (!state) return [];
  return state.models
    .filter((m) => m.def.task === 'stems' && m.status === 'installed')
    .map((m) => m.def)
    .sort((a, b) => Number(!!b.default) - Number(!!a.default) || a.name.localeCompare(b.name));
}

/** The model a transcription mode needs ('basic-pitch' for poly); null = pure DSP. */
export function transcribeModelFor(state: AnalyzerState | null, mode: TranscribeMode): ModelState | null {
  if (mode !== 'poly' || !state) return null;
  const list = state.models.filter((m) => m.def.task === 'transcribe');
  return list.find((m) => m.def.default) ?? list[0] ?? null;
}

// ── Jobs (status bar) ─────────────────────────────────────────────────

export interface Activity {
  /** Job id, or 'dl:<modelId>' for a model download. */
  key: string;
  kind: AnalyzerJobInfo['kind'] | 'download';
  label: string;
  stage: string;
  /** 0..1, or -1 when indeterminate. */
  fraction: number;
  startedAt: number;
  jobId?: string;
  modelId?: string;
}

/** Everything the analyzer is busy with: jobs (oldest first), then model downloads. */
export function analyzerActivity(state: Pick<AnalyzerState, 'jobs' | 'models'> | null): Activity[] {
  if (!state) return [];
  const jobs: Activity[] = [...(state.jobs ?? [])]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((j) => ({ key: j.id, kind: j.kind, label: j.label, stage: j.stage, fraction: j.fraction, startedAt: j.startedAt, jobId: j.id }));
  const downloads: Activity[] = (state.models ?? [])
    .filter((m) => m.status === 'downloading' || m.status === 'verifying')
    .map((m) => {
      const total = m.progress?.total ?? 0;
      const fraction = m.status === 'verifying' ? -1 : total > 0 ? Math.max(0, Math.min(1, (m.progress?.received ?? 0) / total)) : -1;
      return {
        key: `dl:${m.def.id}`,
        kind: 'download' as const,
        label: `${m.status === 'verifying' ? 'Verifying' : 'Downloading'} ${m.def.name}`,
        stage: m.status === 'verifying' ? 'verifying' : 'downloading',
        fraction,
        startedAt: 0,
        modelId: m.def.id,
      };
    });
  return [...jobs, ...downloads];
}

export function fmtFraction(f: number): string {
  return f >= 0 ? `${Math.round(Math.min(1, f) * 100)}%` : '';
}

// ── What a menu acts on ───────────────────────────────────────────────

/** Display name of what a target points at ("Loop 1", "kick.wav"). */
export function targetName(p: Project | null, t: AudioTarget): string {
  if ('path' in t) return t.path.split(/[\\/:]/).pop() || t.path;
  if (!p) return 'audio';
  if ('clipId' in t) {
    const c = p.playlist.clips[t.clipId];
    const ch = c?.channelId ? p.channels[c.channelId] : null;
    return ch?.name ?? 'audio clip';
  }
  return p.channels[t.channelId]?.name ?? 'channel';
}

/** The audio file behind a target (absolute; null for factory content or a missing sample). */
export function targetPath(p: Project | null, t: AudioTarget): string | null {
  if ('path' in t) return t.path;
  if (!p) return null;
  const chId = 'clipId' in t ? p.playlist.clips[t.clipId]?.channelId : t.channelId;
  const sid = chId ? p.channels[chId]?.generator.sampleId : null;
  const path = sid ? p.samples[sid]?.path : null;
  return path && !path.startsWith('factory:') ? path : null;
}

/** The mode that fits a separated stem ('drums' → Drums, 'bass' / 'vocals' → Single line, anything else → chords), or null for other audio. */
export function stemMode(p: Project | null, t: AudioTarget): TranscribeMode | null {
  if (!p || 'path' in t) return null;
  const chId = 'clipId' in t ? p.playlist.clips[t.clipId]?.channelId : t.channelId;
  const sid = chId ? p.channels[chId]?.generator.sampleId : null;
  const stem = sid ? p.samples[sid]?.origin?.stem?.toLowerCase() : undefined;
  if (!stem) return null;
  return stem === 'drums' ? 'drums' : stem === 'bass' || stem === 'vocals' ? 'mono' : 'poly';
}

/** The audio-clip channel behind a target (for "Follow project tempo"), or null. */
export function audioClipChannelOf(p: Project | null, t: AudioTarget): string | null {
  if (!p || 'path' in t) return null;
  const id = 'clipId' in t ? p.playlist.clips[t.clipId]?.channelId : t.channelId;
  const ch = id ? p.channels[id] : null;
  return ch && ch.generator.type === 'krypt.audioclip' ? ch.id : null;
}

/** First playlist clip (by start) that plays an audio-clip channel. */
export function firstClipOfChannel(p: Project | null, channelId: string): string | null {
  if (!p) return null;
  let best: { id: string; start: number } | null = null;
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind === 'audio' && c.channelId === channelId && (!best || c.start < best.start)) best = { id: c.id, start: c.start };
  }
  return best?.id ?? null;
}

/** Does this channel have audio the analyzer can read (a sample-based generator with a sample)? */
export function channelHasAudio(p: Project | null, channelId: string): boolean {
  const ch = p?.channels[channelId];
  return !!ch && (ch.generator.type === 'krypt.audioclip' || ch.generator.type === 'krypt.sampler') && !!ch.generator.sampleId;
}

/** Stable key for caching an analysis of a target in this session. */
export function targetKey(p: Project | null, t: AudioTarget): string {
  if ('path' in t) return `path:${t.path}`;
  const chId = 'clipId' in t ? p?.playlist.clips[t.clipId]?.channelId : t.channelId;
  const sampleId = chId ? p?.channels[chId]?.generator.sampleId : null;
  const sample = sampleId ? p?.samples[sampleId] : null;
  return sample ? `path:${sample.path}` : 'clipId' in t ? `clip:${t.clipId}` : `channel:${t.channelId}`;
}

export const TRANSCRIBE_MODES: Array<{ mode: TranscribeMode; label: string; detail: string }> = [
  { mode: 'poly', label: 'Melody & chords', detail: 'One instrument playing chords (piano, keys, guitar), played by a synth' },
  { mode: 'mono', label: 'Single line', detail: 'One note at a time (bass, 808, vocal, lead), played by its own sound' },
  { mode: 'drums', label: 'Drums', detail: 'Kick, snare and hats on their own channels, played by its own sound' },
];

// ── Outcome sentences ─────────────────────────────────────────────────

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** "4 stems added under 'Loop 1'". */
export function stemsSentence(stems: number, sourceName: string): string {
  return `${plural(stems, 'stem')} added under '${sourceName}'`;
}

/** "Pattern 'Loop 1 notes' created: 42 notes on 3 channels". */
export function patternSentence(patternName: string, notes: number, channels: number): string {
  return `Pattern '${patternName}' created: ${plural(notes, 'note')}${channels > 1 ? ` on ${plural(channels, 'channel')}` : ''}`;
}

// ── Vocals: auto-tune and match (clip menu) ───────────────────────────

/** Other audio to match a clip to: one entry per audio-clip channel (its first clip), never the clip's own channel. */
export function matchTargets(p: Project | null, clipId: string, max = 12): Array<{ clipId: string; label: string; detail: string }> {
  if (!p) return [];
  const own = p.playlist.clips[clipId]?.channelId;
  const first = new Map<string, { id: string; start: number; trackId: string }>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'audio' || !c.channelId || c.channelId === own) continue;
    const cur = first.get(c.channelId);
    if (!cur || c.start < cur.start) first.set(c.channelId, { id: c.id, start: c.start, trackId: c.trackId });
  }
  const bar = Math.round((960 * 4 * p.transport.timeSig.num) / p.transport.timeSig.den);
  return p.channelOrder
    .filter((id) => first.has(id))
    .slice(0, max)
    .map((id) => {
      const c = first.get(id)!;
      const track = p.playlist.trackOrder.indexOf(c.trackId) + 1;
      return { clipId: c.id, label: p.channels[id].name, detail: `Track ${track} · bar ${Math.floor(c.start / bar) + 1}` };
    });
}

const KEY_SOURCE: Record<TuneOutcome['keySource'], string> = { given: 'the key you chose', vocal: 'the vocal', instrumental: 'the instrumental', patterns: 'your patterns' };

/** "Vocal: Krypt Tune added · G minor, Hard · key from the vocal". */
export function tuneSentence(name: string, d: TuneOutcome): string {
  const style = TUNE_STYLES[d.style]?.label ?? d.style;
  if (!d.changed) return `${name} already has Krypt Tune on ${d.key}, ${style}`;
  return `${name}: Krypt Tune ${d.created ? 'added first in its chain' : 'updated'} · ${d.key}, ${style} · key from ${KEY_SOURCE[d.keySource] ?? d.keySource}`;
}

/** "Vocal moved −2 st (Am → Gm) and follows 96 BPM". */
export function matchSentence(name: string, d: MatchOutcome, toName: string): string {
  if (!d.changed) return `${name} already matches ${toName}`;
  const parts: string[] = [];
  if (d.semitones !== null) {
    if (d.semitones === 0) parts.push(d.fromKey ? `stays in ${d.fromKey} (already fits ${toName})` : 'keeps its pitch');
    else parts.push(`moved ${fmtSemitones(d.semitones)}${d.fromKey && d.resultKey ? ` (${d.fromKey} → ${d.resultKey})` : ''}`);
  }
  if (d.followsBpm !== null) parts.push(`follows ${fmtBpm(d.followsBpm)} BPM${d.reading && d.reading !== 'as detected' && d.sourceBpm ? ` (read as ${fmtBpm(d.sourceBpm)}, ${d.reading})` : ''}`);
  return `${name} ${parts.join(' and ') || 'matched'}${d.projectTempoChanged ? ` · project tempo now ${fmtBpm(d.projectBpm)} BPM` : ''}`;
}

/** Sentences of a vocals message that ask the user to check something (not the informational "Key from …"). */
const CAUTION = /^(The key reading is weak|One of the key readings is weak|That is a big stretch|Key left alone|Tempo left alone|Insert .+ also carries|The insert has \d+ Krypt Tune)|has no steady tempo, so|has the same notes as/;

/** The cautionary sentences of a vocals message (weak key readings, big stretches, parts left alone) for a warning toast. */
export function cautionsIn(message: string | undefined): string[] {
  return (message ?? '')
    .split(/(?<=\.)\s+/)
    .filter((s) => CAUTION.test(s))
    .slice(0, 2);
}

/** Messages main / the analyzer use for a cancelled job or download. */
export function isCancelMessage(message: string | undefined): boolean {
  return /cancel/i.test(message ?? '');
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
