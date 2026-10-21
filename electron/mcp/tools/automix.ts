// auto_mix (research/20 §9, research/23): Auto Mix / Auto Master in ONE call and one undo step, the same service
// as the Mixer's Auto Mix panel (electron/automix). dry_run = measure + plan only (nothing is edited).
// reference = a song file to match (tone, loudness, width; only measured). files = master audio FILES in a new
// project tab instead of the open project: one file = Master a song, 2-20 = an album (one chain per song).

import { z } from 'zod';
import type { AlbumOutcome, AutoMixOutcome, AutoMixRequest } from '@shared/automix/types';
import { AUTO_MIX_PRESETS, presetById } from '@shared/automix/presets';
import { ALBUM_MAX_SONGS } from '@shared/automix/album';
import { closenessLine, isLimitedSource } from '@shared/automix/reference';
import { automixFor } from '../../automix';
import { defineTool, fail, type ToolResult } from './types';
import { agentSamplePath, safeName } from './util';

const sgn = (x: number | null): string => (x === null ? '?' : `${x > 0 ? '+' : ''}${x}`);
const tone = (t: AutoMixOutcome['before']['tone']) => `sub ${sgn(t.sub)} low ${sgn(t.low)} lowMid ${sgn(t.lowMid)} highMid ${sgn(t.highMid)} high ${sgn(t.high)}`;

function outcomeText(o: AutoMixOutcome, dry: boolean): string {
  const b = o.before;
  const a = o.after;
  const L: string[] = [];
  L.push(`auto_mix — ${o.mode}, preset ${o.preset.name}${o.intent ? `; understood (${o.intent.source}): ${safeName(o.intent.summary, 160)}` : ''}`);
  if (o.reference) L.push(`reference "${safeName(o.reference.name, 80)}": ${o.reference.lufs} LUFS, width ${o.reference.width}, bands vs mids ${tone(o.reference.tone)}${dry ? '' : ` · ${closenessLine(o.reference.distanceBefore, o.reference.distanceAfter, 'the reference', { limitedSource: isLimitedSource(o.before) })}`}`);
  if (dry) L.push(`now: ${b.lufs} LUFS, true peak ${b.truePeak} dBTP, LRA ${b.lra}, correlation ${b.correlation}${b.vocalVsBeat !== null ? `, vocal ${sgn(b.vocalVsBeat)} dB vs the beat` : ''}; bands vs mids ${tone(b.tone)}`);
  else {
    L.push(`loudness ${b.lufs} → ${a.lufs} LUFS · true peak ${b.truePeak} → ${a.truePeak} dBTP · LRA ${b.lra} → ${a.lra} · correlation ${b.correlation} → ${a.correlation}${b.vocalVsBeat !== null || a.vocalVsBeat !== null ? ` · vocal vs beat ${sgn(b.vocalVsBeat)} → ${sgn(a.vocalVsBeat)} dB` : ''}`);
    L.push(`bands vs mids: ${tone(b.tone)} → ${tone(a.tone)}`);
  }
  if (o.changes.length) L.push(`${dry ? 'Would change' : 'Changed'} (${o.changes.length}):\n${o.changes.map((c) => `- ${safeName(c.target, 80)}: ${c.what}`).join('\n')}`);
  if (o.notes.length) L.push(`Notes:\n${o.notes.map((n) => `- ${n}`).join('\n')}`);
  if (!dry && o.passes) L.push(`${o.passes} render pass${o.passes === 1 ? '' : 'es'}. Undo: one step (undo_last). Fine-tune by hand afterwards (set_effect on the Auto Mix slots, set_mixer), then review_song.`);
  return L.join('\n');
}

function albumText(o: AlbumOutcome): string {
  const L: string[] = [];
  L.push(`album "${safeName(o.name, 80)}" — preset ${o.preset.name}, target ${o.targetLufs} LUFS (${o.keepDynamics ? "keeping the album's dynamics" : 'every song on target'}), ceiling ${o.truePeak} dBTP${o.intent ? `; understood (${o.intent.source}): ${safeName(o.intent.summary, 160)}` : ''}`);
  if (o.reference) L.push(`reference "${safeName(o.reference.name, 80)}": ${closenessLine(o.reference.distanceBefore, o.reference.distanceAfter)} (album average)`);
  o.songs.forEach((s, i) => {
    L.push(`${i + 1}. "${safeName(s.name, 60)}" bars ${s.bars}: ${s.before.lufs} → ${s.after.lufs} LUFS (aim ${s.targetLufs}), true peak ${s.before.truePeak} → ${s.after.truePeak} dBTP, ${s.changes.length} change${s.changes.length === 1 ? '' : 's'}${s.notes.length ? `; ${s.notes.join(' ')}` : ''}`);
  });
  if (o.notes.length) L.push(`Notes:\n${o.notes.map((n) => `- ${n}`).join('\n')}`);
  L.push(`${o.passes} render pass${o.passes === 1 ? '' : 'es'}. Each song has its own chain on its insert (set_effect to fine-tune); the Master holds only a safety limiter. Undo: one step (undo_last) removes the mastering. To export, the user clicks Export all in the album dialog (or export_audio per bar range).`);
  return L.join('\n');
}

export const autoMix = defineTool({
  name: 'auto_mix',
  title: 'Auto mix / master the song (or audio files, or an album)',
  kind: 'write',
  description:
    'USE THIS FIRST to mix or master in one go (the same as the Mixer\'s Auto Mix): renders the song, measures it (loudness, true peak, bands, a file per insert, gain reduction), sets real knob values on its own marked Krypt slots (a re-run adjusts them, never stacks; your other effects are left alone), re-renders until it hits the target (≤ 3 passes: ±0.5 LU, true peak never over the ceiling, a crest guard caps loudness and says so) and reports before → after + every change, as ONE undo step. mode: vocals (EQ, Krypt De-Esser, compression, level vs the beat, reverb / delay sends, a dip in the busiest bed part), mix (every insert: gain staging, high-pass / mud / harshness EQ, drum + bass compression, drum-bus glue, the bass ducking under the kick when their lows collide, plus the vocals), master (tone EQ toward the preset curve, glue, warmth, mono lows < 120 Hz, clipper for loud cards, true-peak limiter last), full (mix then master). preset: ' +
    AUTO_MIX_PRESETS.map((p) => `${p.id} (${p.targetLufs})`).join(', ') +
    ` or auto (the project genre). prompt: plain words ("vocals on top, punchy, not harsh, -9 LUFS"); "tune" in it adds Krypt Tune. target_lufs / true_peak override the preset. bars: measure only these bars (default the whole song, or its fullest 32 bars for long songs). dry_run: measure and plan only. reference: an audio file path to match ("make it sound like this song"): master / full aim at its tone curve, its loudness (clamped to -20..-6 LUFS; the crest guard still wins) and its width, with a -1 dBTP ceiling unless true_peak is set; it is only measured, never copied. files: master audio FILES instead of the open project, in a NEW project tab (mode is ignored, always mastering): 1 file = master that song; 2-${ALBUM_MAX_SONGS} files = an ALBUM (each song on its own track + insert with its own chain, tone made consistent across the songs, keep_dynamics keeps quieter songs up to 4 LU under the loudest). Example: {"mode":"full","preset":"auto"} · {"mode":"vocals","prompt":"vocals forward, less harsh, more reverb"} · {"mode":"master","reference":"C:\\\\Music\\\\ref.wav"} · {"files":["C:\\\\Music\\\\a.wav","C:\\\\Music\\\\b.mp3"],"preset":"streaming-clean"}`,
  input: z.object({
    mode: z.enum(['vocals', 'mix', 'master', 'full']).default('full'),
    preset: z.string().max(64).optional().describe('A preset id (see the description) or "auto".'),
    prompt: z.string().max(1000).optional().describe('What you want, in plain words.'),
    target_lufs: z.number().min(-30).max(-4).optional(),
    true_peak: z.number().min(-6).max(0).optional(),
    bars: z.string().max(32).optional().describe('Bar range to measure, e.g. "33-64".'),
    vocal_inserts: z.array(z.string().max(120)).max(16).optional().describe('Inserts that are vocals (default: detected from names, stems and sound).'),
    keep_user_fx: z.boolean().default(true).describe('false: adjust an existing slot of the same type instead of adding Krypt\'s own (e.g. your master limiter).'),
    reference: z.string().max(400).optional().describe('Absolute path of a reference song to match (master / full, and files).'),
    files: z.array(z.string().min(1).max(400)).min(1).max(ALBUM_MAX_SONGS).optional().describe('Absolute paths of audio files to master in a new project tab: 1 = a song, 2+ = an album (in this order).'),
    keep_dynamics: z.boolean().default(true).describe("Album: keep the songs' loudness differences (≤ 4 LU under the loudest); false = every song on target."),
    dry_run: z.boolean().default(false),
    change_label: z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel."),
  }),
  summarize: (a) => (a.files?.length ? `${a.files.length === 1 ? 'master a file' : `album of ${a.files.length}`}${a.preset ? ` ${safeName(a.preset, 20)}` : ''}` : `${a.mode ?? 'full'}${a.preset ? ` ${safeName(a.preset, 20)}` : ''}${a.reference ? ' + reference' : ''}${a.dry_run ? ' (plan)' : ''}`),
  paths: (a) => [...(a.reference ? [{ value: a.reference, kind: 'audio' as const }] : []), ...(a.files ?? []).map((f) => ({ value: f, kind: 'audio' as const }))],
  // dry_run edits nothing; a run that changes nothing fails with "No change:" itself.
  readsWhenUnchanged: true,
  async run(deps, caller, a, ctx): Promise<ToolResult> {
    if (a.preset && a.preset !== 'auto' && !presetById(a.preset)) fail(`No preset "${safeName(a.preset, 40)}". Presets: ${AUTO_MIX_PRESETS.map((p) => p.id).join(', ')}, or auto.`);
    const reference = a.reference?.trim() ? agentSamplePath(deps, a.reference, caller).abs : undefined;
    const run = { signal: ctx.signal, progress: ctx.progress ? (p: { fraction: number; message: string }) => ctx.progress!(p.fraction, p.message) : undefined };
    const svc = automixFor(deps);
    if (a.files?.length) {
      if (a.dry_run) fail('dry_run works on the open project only: drop files, or run without dry_run.');
      if (caller.session.group) fail(`Mastering files opens a new project tab, which can't happen inside the edit group "${safeName(caller.session.group.label, 60)}": commit_edit first.`);
      const files = a.files.map((f) => agentSamplePath(deps, f, caller).abs);
      const common = {
        ...(a.preset ? { preset: a.preset } : {}),
        ...(a.prompt?.trim() ? { prompt: a.prompt.trim() } : {}),
        ...(a.target_lufs !== undefined ? { targetLufs: a.target_lufs } : {}),
        ...(a.true_peak !== undefined ? { truePeak: a.true_peak } : {}),
        ...(reference ? { reference } : {}),
      };
      if (files.length === 1) {
        const r = await svc.masterFile({ path: files[0], ...common, useAi: 'never' }, caller.actor, run);
        if (!r.ok || !r.data) fail(r.message ?? 'Mastering the file failed');
        return { ok: true, message: r.message ?? 'Mastered', changed: [], text: outcomeText(r.data, false), data: r.data };
      }
      const r = await svc.masterAlbum({ paths: files, ...common, keepDynamics: a.keep_dynamics, useAi: 'never' }, caller.actor, run);
      if (!r.ok || !r.data) fail(r.message ?? 'Mastering the album failed');
      return { ok: true, message: r.message ?? 'Album mastered', changed: [], text: albumText(r.data), data: r.data };
    }
    const req: AutoMixRequest = {
      mode: a.mode,
      ...(a.preset ? { preset: a.preset } : {}),
      ...(a.prompt?.trim() ? { prompt: a.prompt.trim() } : {}),
      ...(a.target_lufs !== undefined ? { targetLufs: a.target_lufs } : {}),
      ...(a.true_peak !== undefined ? { truePeak: a.true_peak } : {}),
      ...(a.bars?.trim() ? { bars: a.bars.trim() } : {}),
      ...(a.vocal_inserts?.length ? { vocalInserts: a.vocal_inserts } : {}),
      ...(reference ? { reference } : {}),
      keepUserFx: a.keep_user_fx,
      // The calling agent already understands the user; never spend the built-in agent's key on its prompt.
      useAi: 'never',
    };
    const r = await svc.run(req, { actor: caller.actor, ctx }, run, { dryRun: a.dry_run });
    if (!r.ok || !r.data) fail(r.message ?? 'Auto Mix failed');
    if (!a.dry_run && !r.data.entryId && !r.data.changes.length) fail(`${r.message?.startsWith('No change') ? '' : 'No change: '}${r.message ?? 'nothing was modified'}`);
    return { ok: true, message: r.message ?? 'Auto Mix done', changed: [], text: outcomeText(r.data, a.dry_run), data: r.data };
  },
});

export const AUTOMIX_TOOLS = [autoMix];
