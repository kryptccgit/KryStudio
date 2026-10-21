// ──────────────────────────────────────────────────────────────────────
// "Ears" verbs behind the clip / channel / browser menus and the analysis
// dialog: detect tempo & key, separate stems, convert audio to a pattern,
// use a detected tempo, make a clip follow the project tempo. Long jobs show
// in the status bar (JobsIndicator); every verb ends in a toast. A cancelled
// job is reported by its Cancel click, not again when the job settles.
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { AudioAnalysis, TranscribeMode } from '@shared/analyzer/protocol';
import type { ActionResult, AudioTarget } from '@shared/types';
import { pluginById } from '@shared/plugins/catalog';
import { dispatch, getProject } from '../doc/store';
import { toast, type ToastOpts } from '../app/notify';
import { flashHint } from '../app/hints';
import { wm } from '../workspace/WindowManager';
import { getUi } from '../state/ui';
import { analyzerMissingMessage, getAnalyzerState, refreshAnalyzer } from '../panels/modelManager/store';
import {
  TRANSCRIBE_MODES,
  analysisSummary,
  fmtBpm,
  installedStemModels,
  isCancelMessage,
  patternSentence,
  plural,
  snapBpm,
  stemsSentence,
  targetKey,
  targetName,
  transcribeModelFor,
} from './logic';

export function openModelManager(): void {
  wm.open('modelManager');
}

const MODEL_MANAGER_ACTION: ToastOpts = { action: { label: 'Open Model Manager', run: openModelManager } };

async function call<T>(what: string, fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${what} failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** False (with a toast) when the analyzer binary is missing. */
async function analyzerReady(): Promise<boolean> {
  if (!getAnalyzerState()) await refreshAnalyzer();
  const s = getAnalyzerState();
  if (s && !s.available) {
    toast.error(analyzerMissingMessage(), MODEL_MANAGER_ACTION);
    return false;
  }
  return true;
}

// ── Detect tempo & key (analysis runs, shared with the dialog) ────────

export type AnalysisRun =
  | { status: 'running'; name: string; target: AudioTarget; startedAt: number }
  | { status: 'done'; name: string; target: AudioTarget; analysis: AudioAnalysis }
  | { status: 'error'; name: string; target: AudioTarget; message: string };

/** Analyses of this session by target key (the dialog reads them; main caches per sample hash too). */
export const useAnalyses = create<{ runs: Record<string, AnalysisRun> }>(() => ({ runs: {} }));

/** How many analysis dialogs show each key (a finished run toasts only when nobody is looking). */
const viewers = new Map<string, number>();

export function watchAnalysis(key: string): () => void {
  viewers.set(key, (viewers.get(key) ?? 0) + 1);
  return () => viewers.set(key, Math.max(0, (viewers.get(key) ?? 1) - 1));
}

function setRun(key: string, run: AnalysisRun): void {
  useAnalyses.setState((s) => ({ runs: { ...s.runs, [key]: run } }));
}

/**
 * Start (or reuse) the analysis of a target. Returns its key. `onShow`
 * reopens the dialog from the "finished" toast when the dialog was closed.
 */
export function startAnalysis(target: AudioTarget, onShow?: () => void, force = false): string {
  const p = getProject();
  const key = targetKey(p, target);
  const cur = useAnalyses.getState().runs[key];
  if (cur && !force && (cur.status === 'running' || cur.status === 'done')) return key;
  const name = targetName(p, target);
  setRun(key, { status: 'running', name, target, startedAt: Date.now() });
  void (async () => {
    if (!(await analyzerReady())) {
      setRun(key, { status: 'error', name, target, message: analyzerMissingMessage() });
      return;
    }
    const r = await call('Analysis', () => window.krypt.analyzer.analyze(target));
    const watched = (viewers.get(key) ?? 0) > 0;
    if (r.ok && r.data) {
      setRun(key, { status: 'done', name, target, analysis: r.data });
      if (!watched) toast.success(`${name}: ${analysisSummary(r.data)}`, onShow ? { action: { label: 'Show analysis', run: onShow } } : undefined);
    } else {
      const message = r.message || "Couldn't analyze the audio";
      setRun(key, { status: 'error', name, target, message });
      if (!watched && !isCancelMessage(message)) toast.error(`${name}: ${message}`);
    }
  })();
  return key;
}

// ── Tempo ─────────────────────────────────────────────────────────────

export async function useAsProjectTempo(bpm: number): Promise<boolean> {
  const v = snapBpm(bpm);
  if (!(v >= 10 && v <= 999)) {
    toast.warn(`${fmtBpm(bpm)} BPM is outside the project tempo range (10–999)`);
    return false;
  }
  const r = await dispatch('transport.set', { bpm: v }, { label: `Tempo ${fmtBpm(v)} (detected)` });
  if (r.ok) toast.success(`Project tempo set to ${fmtBpm(v)} BPM`);
  return r.ok;
}

/** Does this build's Audio Clip support tempo sync (src_bpm + tempo_sync)? */
export function audioClipCanFollowTempo(): boolean {
  const d = pluginById('krypt.audioclip');
  return !!d && d.params.some((p) => p.id === 'tempo_sync') && d.params.some((p) => p.id === 'src_bpm');
}

/** Is this audio-clip channel already following the project tempo from `bpm`? */
export function isFollowingTempo(channelId: string, bpm?: number): boolean {
  const g = getProject().channels[channelId]?.generator;
  if (!g || Math.round(g.params.tempo_sync ?? 0) !== 1) return false;
  return bpm === undefined || Math.abs((g.params.src_bpm ?? 0) - snapBpm(bpm)) < 0.01;
}

/** Make an audio clip follow the project tempo: source tempo = the detected one, tempo sync on. */
export async function followProjectTempo(channelId: string, bpm: number): Promise<boolean> {
  const ch = getProject().channels[channelId];
  if (!ch) return false;
  if (ch.generator.type !== 'krypt.audioclip') {
    toast.warn(`${ch.name} isn't an audio clip. Only playlist audio clips can follow the project tempo.`);
    return false;
  }
  if (!audioClipCanFollowTempo()) {
    toast.warn("This build's audio engine can't time-stretch clips yet (Audio Clip has no tempo sync).");
    return false;
  }
  const src = snapBpm(bpm);
  const r = await dispatch('channels.setGenParams', { id: channelId, params: { src_bpm: src, tempo_sync: 1 } }, { label: `${ch.name} follows the project tempo` });
  if (r.ok) {
    const proj = getProject().transport.bpm;
    toast.success(
      Math.abs(proj - src) < 0.01
        ? `${ch.name} now follows the project tempo (recorded at ${fmtBpm(src)} BPM)`
        : `${ch.name} now follows the project tempo: ${fmtBpm(src)} → ${fmtBpm(proj)} BPM`,
    );
  }
  return r.ok;
}

export async function stopFollowingTempo(channelId: string): Promise<boolean> {
  const ch = getProject().channels[channelId];
  if (!ch) return false;
  const r = await dispatch('channels.setGenParams', { id: channelId, params: { tempo_sync: 0 } }, { label: `${ch.name} plays at its own tempo` });
  if (r.ok) toast.success(`${ch.name} plays at its recorded tempo again`);
  return r.ok;
}

// ── Separate stems ────────────────────────────────────────────────────

export async function separateStems(clipId: string, modelId?: string): Promise<boolean> {
  if (!(await analyzerReady())) return false;
  const p = getProject();
  const clip = p.playlist.clips[clipId];
  if (!clip || clip.kind !== 'audio') {
    toast.warn('Pick an audio clip in the Playlist to separate');
    return false;
  }
  const models = installedStemModels(getAnalyzerState());
  if (!models.length) {
    toast.warn('Separating stems needs a stem model. Install one in the Model Manager (HT-Demucs is the usual pick).', MODEL_MANAGER_ACTION);
    return false;
  }
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const name = targetName(p, { clipId });
  flashHint(`Separating ${name} with ${model.name}… progress is in the status bar`, 'info', 4000);
  const r = await call('Separate stems', () => window.krypt.analyzer.separateStems(clipId, { model: model.id }));
  if (!r.ok || !r.data) {
    if (!isCancelMessage(r.message)) toast.error(r.message || `Couldn't separate ${name}`, /model/i.test(r.message ?? '') ? MODEL_MANAGER_ACTION : undefined);
    return false;
  }
  const d = r.data;
  const secs = Number.isFinite(d.seconds) ? ` in ${Math.max(1, Math.round(d.seconds))} s` : '';
  toast.success(`${stemsSentence(d.stems.length, name)} · ${model.name} on the ${d.device === 'directml' ? 'GPU' : 'CPU'}${secs}`);
  return true;
}

// ── Convert to pattern ────────────────────────────────────────────────

export function modeLabel(mode: TranscribeMode): string {
  return TRANSCRIBE_MODES.find((m) => m.mode === mode)?.label ?? mode;
}

export async function convertToPattern(target: AudioTarget, mode: TranscribeMode): Promise<boolean> {
  if (!(await analyzerReady())) return false;
  const needs = transcribeModelFor(getAnalyzerState(), mode);
  if (needs && needs.status !== 'installed') {
    toast.warn(`${modeLabel(mode)} needs the ${needs.def.name} model. Install it in the Model Manager.`, MODEL_MANAGER_ACTION);
    return false;
  }
  const name = targetName(getProject(), target);
  flashHint(`Converting ${name} to a pattern (${modeLabel(mode).toLowerCase()})… progress is in the status bar`, 'info', 4000);
  const r = await call('Convert to pattern', () => window.krypt.analyzer.toPattern(target, { mode }));
  if (!r.ok || !r.data) {
    if (!isCancelMessage(r.message)) toast.error(r.message || `Couldn't convert ${name} to a pattern`);
    return false;
  }
  const d = r.data;
  if (getProject().patterns[d.patternId]) await dispatch('patterns.select', { id: d.patternId }, { silent: true });
  const pat = getProject().patterns[d.patternId]?.name ?? 'new pattern';
  if (d.notes === 0) {
    toast.warn(`No ${mode === 'drums' ? 'drum hits' : 'notes'} found in ${name}. Pattern '${pat}' is empty: try another mode, or a cleaner stem.`);
    return true;
  }
  const first = d.channelIds[0];
  toast.success(
    patternSentence(pat, d.notes, d.channelIds.length),
    first && mode !== 'drums'
      ? {
          action: {
            label: 'Open in Piano Roll',
            run: () => {
              getUi().selectChannel(first);
              wm.open('pianoRoll');
            },
          },
        }
      : { action: { label: 'Show Channel Rack', run: () => wm.open('channelRack') } },
  );
  return true;
}

// ── Jobs ──────────────────────────────────────────────────────────────

export async function cancelAnalyzerJob(a: { jobId?: string; modelId?: string; label: string }): Promise<void> {
  const r = a.jobId
    ? await call('Cancel', () => window.krypt.analyzer.cancelJob(a.jobId!))
    : a.modelId
      ? await call('Cancel', () => window.krypt.analyzer.cancelInstall(a.modelId!))
      : { ok: false, message: 'Nothing to cancel' };
  if (r.ok) toast.info(`Cancelled: ${a.label}`);
  else toast.error(r.message || `Couldn't cancel ${a.label}`);
}

/** Short "what's running" sentence for hints: "2 analyzer jobs running". */
export function jobsHint(n: number): string {
  return n ? `${plural(n, 'analyzer job')} running · click for details` : 'No analyzer jobs';
}

