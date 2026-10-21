import path from 'node:path';
import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Channel } from '@shared/schema/project';
import { DEFAULT_CHANNEL_VOLUME } from '@shared/schema/project';
import type { AudioAnalysis, DrumHit, DrumRole, StemName } from '@shared/analyzer/protocol';
import type { InstrumentPreset, InstrumentRole } from '@shared/sounds/types';
import { roleFromName } from '@shared/sounds/select';
import type { FingerprintSource, MatchTarget, SoundFingerprint, SoundMatch } from '@shared/sound-match/types';
import { aggregateFingerprints, isChannelTweak, isDrumTarget, levelDiffDb } from '@shared/sound-match/match';
import { median, usableFingerprint } from '@shared/sound-match/features';
import { chordSegments, drumHighpassHz, drumSegments, noteSegments, type Segment } from '@shared/sound-match/segments';
import { defineTool, fail, type RunCtx, type ToolCaller } from './types';
import { agentSamplePath, plural, safeName } from './util';
import { findReference, type ReferenceTrack } from './reference';
import { fingerprintServiceFor, matchSounds, presetLookup } from '../../sounds/fingerprints';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

export const MATCHABLE_ROLES = [
  'kick',
  'snare',
  'clap',
  'hat',
  'openhat',
  'ride',
  'perc',
  'tom',
  'bass',
  '808',
  'sub',
  'chord',
  'stab',
  'pad',
  'keys',
  'piano',
  'strings',
  'brass',
  'lead',
  'pluck',
  'arp',
  'bell',
] as const satisfies readonly InstrumentRole[];
export type MatchableRole = (typeof MATCHABLE_ROLES)[number];

const DEFAULT_PARTS: MatchableRole[] = ['kick', 'snare', 'hat', 'bass', 'chord', 'lead'];

export type PartSource = { kind: 'drums'; drumRole: DrumRole } | { kind: 'bass' } | { kind: 'chords' } | { kind: 'lead' };

export function partSource(role: InstrumentRole): PartSource | null {
  switch (role) {
    case 'kick':
      return { kind: 'drums', drumRole: 'kick' };
    case 'snare':
    case 'clap':
      return { kind: 'drums', drumRole: 'snare' };
    case 'hat':
      return { kind: 'drums', drumRole: 'hat' };
    case 'openhat':
    case 'ride':
      return { kind: 'drums', drumRole: 'openhat' };
    case 'perc':
    case 'tom':
      return { kind: 'drums', drumRole: 'perc' };
    case 'bass':
    case '808':
    case 'sub':
      return { kind: 'bass' };
    case 'chord':
    case 'stab':
    case 'pad':
    case 'keys':
    case 'piano':
    case 'strings':
    case 'brass':
      return { kind: 'chords' };
    case 'lead':
    case 'pluck':
    case 'arp':
    case 'bell':
      return { kind: 'lead' };
    default:
      return null;
  }
}

export function matchTargetFor(role: InstrumentRole): MatchTarget {
  return role === 'kick' || role === 'snare' || role === 'clap' || role === 'hat' || role === 'openhat' || role === 'perc' ? { kind: 'drum', role } : { kind: 'instrument', role };
}

const sourceKey = (s: PartSource) => (s.kind === 'drums' ? `drums:${s.drumRole}` : s.kind);

function runOpts(ctx: Pick<RunCtx, 'progress' | 'signal'>) {
  return { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'measuring') : undefined, signal: ctx.signal };
}

export interface PartMeasurement {
  fps: SoundFingerprint[];
  from: string;
  problem?: string;
}

export async function referencePartFingerprints(
  deps: MainDeps,
  track: ReferenceTrack,
  sources: readonly PartSource[],
  ctx: Pick<RunCtx, 'progress' | 'signal'>,
  stems: 'cached' | 'run' = 'cached',
): Promise<{ parts: Map<string, PartMeasurement>; stemsNote: string | null; analysis: AudioAnalysis }> {
  const an = deps.analyzer;
  if (!an) fail("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so the reference can't be measured.");
  if (!an.fingerprint) fail("This session's audio analyzer can't measure sounds yet (it predates sound matching): rebuild / update krypt-studio-analyzer.");
  const target = { channelId: track.channel.id };
  const run = runOpts(ctx);
  const a = await an.analyze(target, { ...run, drums: true });
  if (!a.ok || !a.data) fail(`Couldn't analyse the reference "${safeName(track.channel.name, 60)}": ${a.message ?? 'analysis failed'}`);
  const analysis = a.data;
  const dur = analysis.durationSec;

  let stemPaths: Partial<Record<StemName, string>> = {};
  let stemsNote: string | null = null;
  if (an.stemFiles) {
    const s = await an.stemFiles(target, { cachedOnly: stems === 'cached' }, run);
    if (!s.ok) stemsNote = `The reference's stems couldn't be read (${s.message ?? 'separation failed'}).`;
    else if (!s.data) {
      stemsNote = /no stem model/i.test(s.message ?? '')
        ? 'No stem model is installed, so only the drums could be measured (from the full mix, rougher). The user can install HT-Demucs in Model Manager for bass, chords and lead.'
        : "The reference hasn't been separated into stems yet, so only the drums were measured (from the full mix, rougher). Call again with separate: true (about 20 s per minute of audio on a CPU, once; cached).";
    } else for (const [name, f] of Object.entries(s.data.stems)) if (f?.path) stemPaths[name as StemName] = f.path;
  } else stemsNote = "This session's analyzer can't read stems, so only the drums were measured (from the full mix).";

  const parts = new Map<string, PartMeasurement>();
  let drumHits: { hits: DrumHit[]; file: string; from: string } | null = null;
  const measure = async (file: string, segs: Segment[], pitch: boolean, highpassHz: number | null = null): Promise<SoundFingerprint[]> => {
    const r = await an.fingerprint!(file, segs, { pitch, highpassHz }, run);
    if (!r.ok || !r.data) throw new Error(r.message ?? 'measuring failed');
    return (r.data.segments ?? []).filter(usableFingerprint);
  };

  for (const src of sources) {
    const key = sourceKey(src);
    if (parts.has(key)) continue;
    try {
      if (src.kind === 'drums') {
        if (!drumHits) {
          if (stemPaths.drums && an.transcribeFile) {
            const t = await an.transcribeFile(stemPaths.drums, 'drums', { name: `${track.title} (drums)` }, run);
            if (t.ok && t.data && t.data.hits.length) drumHits = { hits: t.data.hits, file: stemPaths.drums, from: 'the drum stem' };
          }
          drumHits ??= { hits: analysis.drumHits ?? [], file: analysis.path, from: 'the full mix' };
        }
        const segs = drumSegments(drumHits.hits, src.drumRole, { max: 40, durationSec: dur });
        if (!segs.length) {
          parts.set(key, { fps: [], from: drumHits.from, problem: `no clear ${src.drumRole} hits in ${drumHits.from}` });
          continue;
        }
        const fps = await measure(drumHits.file, segs, src.drumRole === 'kick' || src.drumRole === 'perc', drumHighpassHz(src.drumRole));
        parts.set(key, { fps, from: `${plural(fps.length, `${src.drumRole} hit`)} from ${drumHits.from}` });
      } else if (src.kind === 'bass') {
        if (!stemPaths.bass) {
          parts.set(key, { fps: [], from: '', problem: 'no bass stem' });
          continue;
        }
        if (!an.transcribeFile) throw new Error("this session's analyzer can't transcribe stems");
        const t = await an.transcribeFile(stemPaths.bass, 'mono', { maxKey: 60, name: `${track.title} (bass)` }, run);
        if (!t.ok || !t.data) throw new Error(t.message ?? 'transcribing the bass stem failed');
        const segs = noteSegments(t.data.notes, { max: 40, minDurSec: 0.12, maxDurSec: 1.5, durationSec: dur });
        if (!segs.length) {
          parts.set(key, { fps: [], from: 'the bass stem', problem: 'no clear bass notes in the bass stem' });
          continue;
        }
        const fps = await measure(stemPaths.bass, segs, true);
        parts.set(key, { fps, from: `${plural(fps.length, 'bass note')} from the bass stem` });
      } else if (src.kind === 'chords') {
        const file = stemPaths.other ?? stemPaths.piano ?? stemPaths.guitar;
        if (!file) {
          parts.set(key, { fps: [], from: '', problem: 'no "other" stem' });
          continue;
        }
        const segs = chordSegments(analysis.chords ?? [], { max: 24, durationSec: dur });
        if (!segs.length) {
          parts.set(key, { fps: [], from: 'the other stem', problem: 'no chord changes were read in the reference' });
          continue;
        }
        const fps = await measure(file, segs, false);
        parts.set(key, { fps, from: `${plural(fps.length, 'chord')} from the ${path.basename(file).replace(/\.[a-z0-9]+$/i, '')} stem` });
      } else {
        const file = stemPaths.other;
        if (!file) {
          parts.set(key, { fps: [], from: '', problem: 'no "other" stem' });
          continue;
        }
        if (!an.transcribeFile) throw new Error("this session's analyzer can't transcribe stems");
        const t = await an.transcribeFile(file, 'mono', { minKey: 52, name: `${track.title} (lead)` }, run);
        if (!t.ok || !t.data) throw new Error(t.message ?? 'transcribing the lead failed');
        const segs = noteSegments(t.data.notes, { max: 40, minDurSec: 0.1, maxDurSec: 1, durationSec: dur });
        if (!segs.length) {
          parts.set(key, { fps: [], from: 'the other stem', problem: 'no clear lead line in the other stem' });
          continue;
        }
        const fps = await measure(file, segs, true);
        parts.set(key, { fps, from: `${plural(fps.length, 'lead note')} from the other stem` });
      }
    } catch (e) {
      if (ctx.signal?.aborted) fail('Cancelled.');
      parts.set(key, { fps: [], from: '', problem: (e as Error)?.message ?? String(e) });
    }
  }
  return { parts, stemsNote, analysis };
}

export function channelRole(ch: Channel, lookup: (id: string) => InstrumentPreset | undefined): MatchableRole | null {
  const pid = ch.generator.preset?.id;
  const role = (pid ? lookup(pid)?.role : undefined) ?? roleFromName(ch.name);
  return role && (MATCHABLE_ROLES as readonly string[]).includes(role) ? (role as MatchableRole) : null;
}

const TITLE: Partial<Record<MatchableRole, string>> = { openhat: 'Open Hat', '808': '808', chord: 'Chords', keys: 'Keys', strings: 'Strings', brass: 'Brass' };
const titleOf = (r: MatchableRole) => TITLE[r] ?? `${r.charAt(0).toUpperCase()}${r.slice(1)}`;

interface PartPlan {
  role: MatchableRole;
  channels: Channel[];
}

function sourceName(deps: MainDeps, s: FingerprintSource, lookup: (id: string) => InstrumentPreset | undefined): string {
  if (s.kind === 'preset') return lookup(s.id)?.name ?? s.id;
  const hit = deps.sounds?.factoryIndex()?.samples.find((x) => x.path === s.path);
  return hit?.name ?? s.path.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '');
}

function sourceRef(s: FingerprintSource): string {
  return s.kind === 'preset' ? s.id : s.path;
}

function tweakText(t: Record<string, number>): string {
  const parts = Object.entries(t).map(([k, v]) => (k === 'gainDb' ? `level ${v > 0 ? '+' : ''}${v} dB` : k === 'pitch' ? `pitch ${v > 0 ? '+' : ''}${v} st` : `${k} ${v}`));
  return parts.length ? parts.join(', ') : 'none needed';
}

async function loadOnto(deps: MainDeps, caller: ToolCaller, ctx: RunCtx, plan: { channel: Channel | null; role: MatchableRole }, m: SoundMatch, lookup: (id: string) => InstrumentPreset | undefined): Promise<string> {
  const drum = isDrumTarget(matchTargetFor(plan.role));
  let channelId: string;
  let baseVolume = DEFAULT_CHANNEL_VOLUME;
  if (m.source.kind === 'preset') {
    const preset = lookup(m.source.id);
    if (!preset) fail(`Preset ${m.source.id} is no longer available.`);
    if (plan.channel) channelId = ctx.exec<{ channelId: string }>('presets.applyToChannel', { channelId: plan.channel.id, preset, withFx: true }).channelId;
    else channelId = ctx.exec<{ channelId: string }>('presets.addChannel', { preset, name: titleOf(plan.role), withFx: true }).channelId;
    if (preset.channel?.volumeDb !== undefined) baseVolume = 10 ** (preset.channel.volumeDb / 20);
  } else {
    const { docPath, abs } = agentSamplePath(deps, m.source.path, caller);
    let info: { frames?: number; sampleRate?: number; channels?: number } = {};
    const si = abs ? await deps.engine.sampleInfo(abs) : null;
    if (si?.ok && si.data) info = { frames: si.data.frames, sampleRate: si.data.sampleRate, channels: si.data.channels };
    const sampleId = ctx.exec<{ id: string }>('samples.add', { path: docPath, ...info }).id;
    if (plan.channel) {
      channelId = plan.channel.id;
      ctx.exec('channels.setGenerator', { id: channelId, type: 'krypt.sampler' });
      ctx.exec('channels.setSample', { id: channelId, sampleId });
    } else channelId = ctx.exec<{ id: string }>('channels.add', { type: 'krypt.sampler', name: titleOf(plan.role), sampleId }).id;
  }
  const params = Object.fromEntries(Object.entries(m.tweaks).filter(([k]) => !isChannelTweak(k)));
  if (Object.keys(params).length) ctx.exec('channels.setGenParams', { id: channelId, params });
  const set: Record<string, unknown> = {};
  if (drum) set.pitch = Math.max(-24, Math.min(24, m.tweaks.pitch ?? 0));
  if (m.tweaks.gainDb !== undefined) set.volume = Math.max(0, Math.min(1.25, Math.round(baseVolume * 10 ** (m.tweaks.gainDb / 20) * 1000) / 1000));
  if (Object.keys(set).length) ctx.exec('channels.set', { id: channelId, ...set });
  return channelId;
}

export const matchSoundsTool = defineTool({
  name: 'match_sounds',
  title: 'Match sounds to the reference',
  kind: 'write',
  readsWhenUnchanged: true,
  description:
    'Pick sounds by what the REFERENCE SOUNDS LIKE, not by genre name. Measures each part of the studied reference ("Reference: …" track from study_reference) from its stems: kick / snare / hat hits on the drum stem, bass notes on the bass stem, chord spans and lead notes on the other stem. Then it ranks the factory presets, factory samples and installed pack samples by timbre (brightness, noise, pitch, attack, decay, sustain, band balance, punch, width) and returns the best 3 per part with a match %, plain reasons ("darker than the reference kick: centroid 180 Hz vs 260 Hz") and tweaks in the plugin\'s own units (cutoff, decay, tune / channel pitch, drive, level). Parts = the project\'s channels mapped by role (preset role, else name: Kick, Snare, Hat, 808, Bass, Chords, Pad, Lead …); with no such channels, or with parts, those roles. apply: true loads the best match onto every channel of each part (the same commands as load_preset / load_sample; a requested part without a channel gets a new one) and applies its tweaks, all as ONE undo step. Without stems only the drums can be measured (from the mix): separate: true separates the reference first (installed stem model only; about 20 s per minute on a CPU, cached). Needs study_reference first. Example: {"apply":true} or {"parts":["kick","bass"]}',
  input: z.object({
    reference: z.string().min(1).max(200).optional().describe('The reference clip id or channel name. Default: the "Reference: …" track.'),
    parts: z.array(z.enum(MATCHABLE_ROLES)).min(1).max(12).optional().describe('Roles to match (default: the roles of the project\'s channels, else kick, snare, hat, bass, chord, lead).'),
    apply: z.boolean().default(false).describe('Load the best match + its tweaks onto the channels (one undo step).'),
    separate: z.boolean().default(false).describe('Separate the reference into stems first when they aren\'t cached (installed stem model only).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.parts?.length ? a.parts.join(', ') : 'all parts'}${a.apply ? ' (apply)' : ''}`,
  async run(deps, caller, a, ctx) {
    const p0 = deps.doc.project;
    const track = findReference(p0, a.reference);
    if (!track) fail('No reference in this project: call study_reference {"file":"…"} with the song first (it puts it on a muted "Reference: …" track), then match_sounds.');
    const svc = fingerprintServiceFor(deps);
    const idx = svc.index();
    if (!idx.index) fail(idx.problem ?? 'Sound matching is unavailable.');
    const lookup = presetLookup(deps);

    const channels = p0.channelOrder
      .map((id) => p0.channels[id])
      .filter((c): c is Channel => !!c && c.id !== track.channel.id && c.generator.type !== 'krypt.audioclip');
    const byRole = new Map<MatchableRole, Channel[]>();
    for (const c of channels) {
      const r = channelRole(c, lookup);
      if (r) byRole.set(r, [...(byRole.get(r) ?? []), c]);
    }
    const roles: MatchableRole[] = a.parts?.length ? [...new Set(a.parts)] : byRole.size ? [...byRole.keys()] : DEFAULT_PARTS;
    const plans: PartPlan[] = roles.map((role) => ({ role, channels: byRole.get(role) ?? [] }));

    const sources = plans.map((pl) => partSource(pl.role)).filter((s): s is PartSource => !!s);
    const { parts, stemsNote } = await referencePartFingerprints(deps, track, sources, ctx, a.separate ? 'run' : 'cached');
    const warnings: string[] = [];
    if (stemsNote) warnings.push(stemsNote);

    const run = runOpts(ctx);
    const results = new Map<MatchableRole, { matches: SoundMatch[]; measured: PartMeasurement; notes: string[] } | { problem: string }>();
    const raw: number[] = [];
    for (const pl of plans) {
      const src = partSource(pl.role)!;
      const meas = parts.get(sourceKey(src));
      if (!meas || !meas.fps.length) {
        results.set(pl.role, { problem: meas?.problem ?? 'nothing measured' });
        continue;
      }
      const r = await matchSounds(deps, meas.fps, matchTargetFor(pl.role), { limit: 3, preset: lookup, run });
      if (!r.ok || !r.data) {
        results.set(pl.role, { problem: r.message ?? 'matching failed' });
        continue;
      }
      results.set(pl.role, { matches: r.data, measured: meas, notes: r.notes ?? [] });
      const best = r.data[0];
      const agg = aggregateFingerprints(meas.fps);
      const fp = best ? svc.fingerprintOf(best.source) : null;
      if (agg && fp) raw.push(levelDiffDb(agg, fp, isDrumTarget(matchTargetFor(pl.role))));
    }
    const offset = raw.length >= 2 ? median(raw) : raw[0] ?? 0;
    if (Number.isFinite(offset) && Math.abs(offset) >= 0.5) {
      for (const pl of plans) {
        const cur = results.get(pl.role);
        if (!cur || 'problem' in cur) continue;
        const r = await matchSounds(deps, cur.measured.fps, matchTargetFor(pl.role), { limit: 3, preset: lookup, run, levelOffsetDb: offset, includePacks: true, maxNewPackSamples: 0 });
        if (r.ok && r.data) cur.matches = r.data;
      }
    }

    const lines: string[] = [];
    const data: Array<Record<string, unknown>> = [];
    const applied: string[] = [];
    const notes = new Set<string>();
    for (const pl of plans) {
      const res = results.get(pl.role)!;
      const chText = pl.channels.length ? ` → ${pl.channels.map((c) => `"${safeName(c.name, 40)}"`).join(', ')}` : '';
      if ('problem' in res) {
        lines.push(`${titleOf(pl.role).toUpperCase()}${chText}: not matched (${res.problem}).`);
        data.push({ part: pl.role, channels: pl.channels.map((c) => c.id), problem: res.problem, matches: [] });
        continue;
      }
      res.notes.forEach((n) => notes.add(n));
      lines.push(`${titleOf(pl.role).toUpperCase()}${chText} (${res.measured.from}):`);
      if (!res.matches.length) lines.push('  no eligible sound in the library.');
      res.matches.forEach((m, i) => {
        lines.push(`  ${i + 1}. ${safeName(sourceName(deps, m.source, lookup), 60)} (${m.source.kind} ${sourceRef(m.source)}), ${Math.round(m.similarity * 100)}%`);
        lines.push(`     ${m.why.join(' ')}`);
        lines.push(`     tweaks: ${tweakText(m.tweaks)}`);
      });
      data.push({ part: pl.role, channels: pl.channels.map((c) => c.id), measured: res.measured.from, matches: res.matches.map((m) => ({ ...m, name: sourceName(deps, m.source, lookup) })) });

      const best = res.matches[0];
      if (a.apply && best) {
        const targets: Array<Channel | null> = pl.channels.length ? pl.channels : a.parts?.length ? [null] : [];
        for (const ch of targets) {
          const id = await loadOnto(deps, caller, ctx, { channel: ch, role: pl.role }, best, lookup);
          applied.push(`${safeName(deps.doc.project.channels[id]?.name ?? titleOf(pl.role), 40)} ← ${safeName(sourceName(deps, best.source, lookup), 50)}`);
        }
      }
    }
    for (const n of notes) warnings.push(n);
    const matched = data.filter((d) => (d.matches as unknown[]).length).length;
    const head = a.apply
      ? applied.length
        ? `Matched ${plural(matched, 'part')} of "${safeName(track.title, 60)}" and loaded ${plural(applied.length, 'sound')} with their tweaks (one undo step): ${applied.join('; ')}.`
        : `Matched ${plural(matched, 'part')} of "${safeName(track.title, 60)}" but loaded nothing: no channel plays those parts (add channels named Kick, Bass … or pass parts to create them).`
      : `Matched ${plural(matched, 'part')} of "${safeName(track.title, 60)}" by sound (best 3 each). Load one with load_preset / load_sample and set_params with its tweaks, or call again with apply: true.`;
    if (!matched) fail(`Couldn't match any part of "${safeName(track.title, 60)}": ${lines.join(' ')}${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
    return { ok: true, message: head, changed: [], text: lines.join('\n'), warnings: warnings.length ? warnings : undefined, data: { reference: track.channel.id, levelOffsetDb: Math.round(offset * 10) / 10, parts: data } };
  },
});

export const MATCH_TOOLS = [matchSoundsTool];
