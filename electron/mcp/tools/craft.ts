// Craft tools (owned by craft-tools): get_playbook, review_song,
// add_transition. They turn "make an EDM song" into a FINISHED song in one
// prompt: the playbook says how the genre is built (with real sounds
// resolved), add_transition puts risers / fills / sweeps at the section
// boundaries, and review_song is the agent's mandatory self-check before it
// answers. research/10-sound-and-craft.md.
//
// The pure parts live next door: craftRecipe.ts (the playbook → build
// order) and craftReview.ts (the checks).

import fs from 'node:fs';
import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Channel } from '@shared/schema/project';
import type { Playbook } from '@shared/playbooks/types';
import { listPlaybooks, playbookFor } from '@shared/playbooks';
import type { FactoryIndex, FactorySample, Preset, SampleKind } from '@shared/sounds/types';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import { packById } from '@shared/packs/catalog';
import { parsePackPath } from '@shared/packs/types';
import { packPhrase } from '../../packs/gating';
import { rankSamples, roleFromName } from '@shared/sounds/select';
import { genreInfo, type GenreId } from '@shared/sounds/genres';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { toNormalized } from '@shared/plugins/types';
import { PPQ, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from '@shared/schema/time';
import { defineTool, fail, type RunCtx, type ToolDef } from './types';
import { dbToGain, findChannel, findInsert, plural, round, safeName } from './util';
import { buildRecipe, chooseGenre, focusNumbers, genericPlaybook, genreFrom, GENERIC_TARGETS, SOURCE_WORDS, type FocusNumbers, type SoundPicker } from './craftRecipe';
import { bestDrumSample, bestPreset, soundLibrary } from './instruments';
import { collectHeard, reviewSong, type ReviewIssue } from './craftReview';
import { adaptPlaybook } from '@shared/reference';
import { audibleReferenceClips, projectReference, studyReference } from './reference';
import { compareAnalyses, renderAndAnalyse } from './hearing';
import { closenessLines } from './closeness';
import { referenceBalance } from './matchMix';
import { soundCloseness } from './closenessSounds';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

/** Where get_playbook / review_song find playbooks (tests pass a fixture registry). */
export interface PlaybookRegistry {
  playbookFor(genre: string | null | undefined): Playbook | null;
  list(): readonly Playbook[];
}

const DEFAULT_REGISTRY: PlaybookRegistry = { playbookFor, list: listPlaybooks };

/** Presets and the factory sample index, from the same sound library load_preset uses (index null when not installed). */
function soundsOf(deps: MainDeps): { presets: readonly Preset[]; samples: readonly FactorySample[] | null; picker: SoundPicker } {
  let presets: readonly Preset[] = FACTORY_PRESETS;
  let index: FactoryIndex | null = null;
  try {
    const lib = soundLibrary(deps);
    presets = lib.presets;
    index = lib.index;
  } catch (err) {
    deps.log('warn', `Craft tools: couldn't read the sound library, using the factory presets: ${(err as Error)?.message ?? err}`);
  }
  // The same picks write_pattern / load_preset make (playable presets, installed samples, name words refine).
  const picker: SoundPicker = {
    drum: (part, genre) =>
      bestDrumSample(deps, index, part.role, genre, [part.sample, part.name, ...(part.tags ?? [])].filter(Boolean).join(' ')) ??
      // Non-drum roles with a sample kind (a vinyl texture, an 808 one-shot): the best of that kind.
      (part.sample && index ? (rankSamples(index.samples, { kind: part.sample, genre: genre ?? undefined, tags: part.tags }, 1)[0] ?? null) : null),
    preset: (part, genre) => bestPreset(deps, presets, part.role, genre, undefined, [part.name, ...(part.tags ?? [])].join(' ')),
  };
  return { presets, samples: index?.samples ?? null, picker };
}

/** The library style focus: its words (genre fallback) and its numbers (overrides). Never throws. */
async function focusOf(deps: MainDeps, numbers: boolean): Promise<{ text: string; numbers: FocusNumbers | null } | null> {
  const lib = deps.library;
  if (!lib) return null;
  try {
    const f = lib.focus();
    if (!f) return null;
    let n: FocusNumbers | null = null;
    if (numbers) {
      const r = await lib.profileText(f.collectionId, { brief: f.brief });
      if (r.ok && r.data) n = focusNumbers(safeName(f.name, 60), r.data.profile);
    }
    return { text: `${f.name} ${f.brief ?? ''}`, numbers: n };
  } catch (err) {
    deps.log('warn', `Craft tools: couldn't read the style focus: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

function knownList(reg: PlaybookRegistry): string {
  const ids = reg.list().map((p) => p.id);
  return ids.length ? `Playbooks: ${ids.join(', ')}.` : 'No genre playbooks are installed in this build yet.';
}

// ── get_playbook ────────────────────────────────────────────────────────

function getPlaybookTool(reg: PlaybookRegistry) {
  return defineTool({
    name: 'get_playbook',
    title: 'Genre playbook: the full recipe for a finished song',
    kind: 'read',
    description:
      'START HERE for any "make a song / beat" request. Returns how a finished, release-quality track in the genre is built, resolved for THIS project: tempo / key / swing; every part (channel) with its sound already chosen (an instrument preset, or the best factory sample for drums); original KPN starting patterns; the arrangement with absolute start bars; transitions at each section boundary; the mix plan (master, bus and send chains, sidechains, levels); the mistakes to avoid; the targets review_song checks; and a numbered BUILD ORDER of exact tool calls (load_preset, load_sample, write_pattern, arrange, add_transition, apply_chain, sidechain, review_song …). Genre: `genre`, else the project\'s genre, else one named in `brief`, else the library style focus. When a style focus is active, the user\'s own references override tempo, swing, key, progressions, structure and loudness. Read-only. Example: {"genre":"edm","brief":"dark festival track at 128 bpm"}',
    input: z.object({
      genre: z.string().max(40).optional().describe('Genre id or name ("edm", "uk drill", "lofi"). Default: the project genre, the brief, the reference song\'s closest genre, then the library focus.'),
      brief: z.string().max(400).optional().describe("The user's request in their words: a genre, tempo (\"at 140 bpm\") or key (\"in F#m\") in it is used."),
      reference: z.string().max(200).optional().describe('The reference song to follow: default the muted "Reference: …" track study_reference made; "none" ignores it.'),
    }),
    summarize: (a) => safeName(a.genre ?? a.brief ?? 'auto', 40),
    async run(deps, _c, a, ctx) {
      const p = deps.doc.project;
      const focus = await focusOf(deps, true);
      const warnings: string[] = [];
      // The reference song (study_reference): first read with its own best genre, then laid out for the chosen one.
      let ref = await projectReference(deps, a.reference, genreFrom(a.genre), ctx, warnings);
      const choice = chooseGenre({ arg: a.genre, projectGenre: p.meta.genre, brief: a.brief, referenceGenre: ref?.brief.genres[0]?.id ?? null, focusText: focus?.text });
      if (ref && choice.id && ref.brief.genre !== choice.id) ref = await studyReference(deps, ref.track, choice.id, ctx);
      const pb0 = choice.id ? reg.playbookFor(choice.id) : null;
      const adapted = ref ? adaptPlaybook(pb0 ?? genericPlaybook(choice.id), ref.brief) : null;
      const pb = adapted && pb0 ? adapted.playbook : pb0;
      const { presets, samples, picker } = soundsOf(deps);
      const recipe = buildRecipe(adapted ? adapted.playbook : (pb ?? genericPlaybook(choice.id)), {
        genre: choice.id,
        source: choice.source,
        presets,
        samples,
        picker,
        channels: p.channelOrder.map((id) => p.channels[id].name),
        inserts: p.mixer.insertOrder.map((id) => p.mixer.inserts[id].name),
        projectBpm: p.transport.bpm,
        projectSwing: p.transport.swing,
        brief: a.brief,
        focus: focus?.numbers ?? null,
        reference: ref && adapted ? { brief: ref.brief, adapted, track: ref.track.channel.name } : null,
        generic: !pb,
      });
      if (!presets.some((x) => x.kind === 'instrument')) warnings.push('No instrument presets are installed yet: parts without a factory sample get a default instrument; shape them with set_params.');
      if (!samples) warnings.push("The factory sample index isn't installed (resources/factory/index.json): drums use the original kit, and add_transition falls back to snare rolls, fill patterns, filter sweeps, silence and the kit's crash (reversed for a reverse cymbal).");
      const name = choice.id ? genreInfo(choice.id).name : null;
      let message: string;
      if (pb) {
        message = `Playbook for ${pb.name} (${choice.source ? SOURCE_WORDS[choice.source] : 'as asked'}): ${recipe.bpm} bpm in ${recipe.key}, ${recipe.parts.length} parts, ${recipe.sections.length} sections over ${recipe.totalBars} bars${ref ? `, following the reference "${safeName(ref.brief.name, 60)}"${adapted?.arrangement === 'sections' ? ' (its section plan)' : ''}` : focus?.numbers ? `, with your references ("${focus.numbers.name}") overriding the numbers` : ''}. Follow the BUILD ORDER below to the end in one go, then review_song.`;
      } else if (choice.unknown) {
        message = `"${safeName(choice.unknown, 40)}" isn't a genre Krypt Studio knows, so here is a generic finished-song recipe (use your own knowledge of that style inside it). ${knownList(reg)}`;
      } else if (name) {
        message = `No playbook for ${name} yet: here is a generic finished-song recipe; use your own knowledge of ${name}'s tempo, drums, bass and harmony inside it. ${knownList(reg)}`;
      } else {
        message = `No genre given (none in the request, the project or the library focus): here is a generic finished-song recipe. Choose the genre that fits the request and call get_playbook {"genre":"…"} for its playbook. ${knownList(reg)}`;
      }
      const { text, ...data } = recipe;
      return { ok: true, message, changed: [], text, data: { ...data, source: choice.source, known: reg.list().map((x) => x.id) }, warnings: warnings.length ? warnings : undefined };
    },
  });
}

// ── review_song ─────────────────────────────────────────────────────────

/** review_song renders whole songs: 256 bars is 8 minutes at 128 bpm. */
const MAX_REVIEW_BARS = 256;

function issueLine(x: ReviewIssue, i: number): string {
  return `${i + 1}. [${x.severity.toUpperCase()} · ${x.area}${x.bars ? ` · bars ${x.bars}` : ''}] ${x.problem}\n   fix: ${x.fix}`;
}

function reviewTool(reg: PlaybookRegistry) {
  return defineTool({
    name: 'review_song',
    title: 'Review the song (mandatory self-check)',
    kind: 'read',
    description:
      'YOUR MANDATORY SELF-CHECK before you answer. Renders the whole song (or a bar range) through the full mixer and checks it against the genre playbook\'s targets (generic targets without one): integrated loudness, true peak, band balance, stereo correlation, the master chain, missing sidechains; sections (markers, else inferred), length, phrase lengths, energy contrast between sections and the planned energy shape, static loops, section boundaries without a transition, a silent intro, an abrupt end; bare default instruments, flat hat velocities, stiff on-grid drums where the genre swings, out-of-key notes and low clashes. With a studied reference (study_reference) it also scores CLOSENESS to it, 0-100 overall and per dimension (tempo, key, groove, harmony, arrangement, sounds, mix: yours vs the reference, and the fix), and the biggest gaps join the issues. Returns a score 0-100, at most 10 RANKED issues (severity, bars, the concrete fix as a tool call) and what already works. Fix the top issues, then review again (at most 2 fix rounds). Never changes the project. Example: {"genre":"edm"} · {"scope":"33-64"}',
    input: z.object({
      genre: z.string().max(40).optional().describe('Genre whose playbook targets apply. Default: the project genre, then the library focus.'),
      scope: z.string().max(20).optional().describe('"song" (default: up to the last audible clip) or a bar range "33-64".'),
      reference: z.string().max(200).optional().describe('The reference song to grade against: default the muted "Reference: …" track study_reference made; "none" ignores it.'),
    }),
    summarize: (a) => [a.genre && safeName(a.genre, 20), a.scope && a.scope !== 'song' ? `bars ${safeName(a.scope, 12)}` : ''].filter(Boolean).join(' ') || 'song',
    async run(deps, _c, a, ctx) {
      const p = deps.doc.project;
      if (!Object.values(p.playlist.clips).some((c) => c.kind !== 'automation')) fail('Nothing is arranged yet: the Playlist is empty. Write the patterns, arrange them (arrange), then review_song.');
      const scope = (a.scope ?? 'song').trim().toLowerCase() || 'song';
      const whole = scope === 'song';
      if (!whole && !/^\d+(\s*[-–:]\s*\d+)?$/.test(scope)) fail(`scope "${safeName(a.scope, 20)}" must be "song" or a bar range like "33-64".`);
      const focus = await focusOf(deps, false);
      const warnings: string[] = [];
      let ref = await projectReference(deps, a.reference, genreFrom(a.genre), ctx, warnings);
      const choice = chooseGenre({ arg: a.genre, projectGenre: p.meta.genre, referenceGenre: ref?.brief.genres[0]?.id ?? null, focusText: focus?.text });
      if (ref && audibleReferenceClips(p, ref.track.channel)) {
        const n = safeName(ref.track.channel.name, 64);
        fail(`The reference "${n}" isn't muted, so it would play in the review render and be graded as part of your song. Mute it first: set_channel ${JSON.stringify({ channel: n, mute: true })} (the user unmutes it to A/B), then review_song again.`);
      }
      if (ref && choice.id && ref.brief.genre !== choice.id) ref = await studyReference(deps, ref.track, choice.id, ctx);
      const pb0 = choice.id ? reg.playbookFor(choice.id) : null;
      // With a reference the plan it graded against is the reference's (sections, energy shape, loudness, contrast).
      const pb = ref ? adaptPlaybook(pb0 ?? genericPlaybook(choice.id), ref.brief).playbook : pb0;
      const targets = pb?.targets ?? GENERIC_TARGETS;
      ctx.progress?.(-1, 'rendering the song');
      const t0 = Date.now();
      // With a reference, the same single render also writes every insert (stems) for the per-part balance.
      const out = await renderAndAnalyse(deps, whole ? { scope: 'song' } : { scope: 'bars', bars: scope }, { maxBars: MAX_REVIEW_BARS, audibleSong: whole, prefix: 'review', stems: !!ref });
      const renderMs = Date.now() - t0;
      const range = out.plan.range;
      if (!range) fail('review_song reviews the arranged song: switch to song mode content (arrange) first.');
      const { presets, samples } = soundsOf(deps);
      // The render against the reference song: tempo, key, loudness, tonal balance, width, energy shape.
      const keyEst = out.plan.symbolic?.key.estimated ?? null;
      const comparison =
        ref && out.ok && out.raw
          ? compareAnalyses(out.raw, ref.analysis, { bpm: p.transport.bpm, key: keyEst, keySource: keyEst ? 'notes' : null, renderSec: ticksToSeconds(out.plan.lengthTicks, p.transport.bpm) })
          : null;
      const t1 = Date.now();
      const balance = ref && out.ok ? await referenceBalance(deps, ref, out.stems ?? null, out.stemsProblem) : null;
      const sounds = ref ? await soundCloseness(deps, ref, new Set(collectHeard(deps.doc.project, range.start, range.end).channels.keys()), ctx) : null;
      const r = reviewSong({
        project: deps.doc.project,
        catalog: deps.doc.catalog,
        playbook: pb,
        targets,
        range,
        wholeSong: whole,
        analysis: out.ok ? out.raw : null,
        measured: out.measured ? { peakDb: out.measured.peakDb, correlation: out.measured.correlation } : null,
        symbolic: out.plan.symbolic,
        presets,
        samples,
        genre: choice.id,
        pickPreset: (role, words) => bestPreset(deps, presets, role, choice.id, undefined, words),
        reference: ref && comparison ? { name: ref.brief.name, comparison } : null,
        closeness: ref
          ? {
              reference: { brief: ref.brief, analysis: ref.analysis },
              balance: balance?.levels ?? null,
              balanceNote: balance?.note,
              sounds: sounds?.sounds ?? null,
              soundsNote: sounds?.note,
            }
          : null,
      });
      const reviewMs = Date.now() - t1;
      const barT = ticksPerBar(p.transport.timeSig);
      const pbWords = pb0 ? `${pb0.name} playbook` : choice.id ? `generic (no ${genreInfo(choice.id).name} playbook yet)` : 'generic';
      const against = ref
        ? `the reference "${safeName(ref.brief.name, 60)}" (its sections, energy shape, loudness and tonal balance) with ${pbWords} targets`
        : pb
          ? `${pb.name} playbook targets (genre ${choice.source ? SOURCE_WORDS[choice.source] : 'as asked'})`
          : choice.id
            ? `generic targets (no ${genreInfo(choice.id).name} playbook yet)`
            : 'generic targets (no genre: pass genre for its playbook)';
      const m = r.metrics;
      const L: string[] = [];
      L.push(`review_song — ${out.plan.label} against ${against}`);
      L.push(
        `score ${r.score}/100 · ${m.bars} bars${m.lufs !== null ? ` · ${m.lufs} LUFS (target ${targets.lufs})` : ''}${m.truePeakDb !== null ? ` · peak ${m.truePeakDb} dB${out.raw ? 'TP' : 'FS'}` : ''}${m.correlation !== null ? ` · corr ${m.correlation}` : ''}${m.contrastLu !== null ? ` · contrast ${m.contrastLu} LU` : ''}`,
      );
      if (m.bandsVsMid) L.push(`bands vs mids (dB): ${Object.entries(m.bandsVsMid).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(' · ')}`);
      if (r.sections.length) L.push(`sections: ${r.sections.slice(0, 16).map((s) => `${s.name} ${Math.floor(s.start / barT) + 1}-${Math.ceil(s.end / barT)}${typeof s.lufs === 'number' ? ` (${s.lufs} LUFS)` : ''}`).join(' · ')}${r.sections[0]?.source === 'inferred' ? ' (inferred: no markers)' : ''}`);
      if (comparison) {
        const c = comparison;
        const sg = (x: number | null | undefined, u = ' dB') => (x === null || x === undefined ? '?' : `${x > 0 ? '+' : ''}${x}${u}`);
        const g = c.bands.groups;
        L.push(
          `vs the reference: tempo ${c.tempo.project} vs ${c.tempo.reading ?? '?'} bpm · loudness ${c.loudness.project ?? '?'} vs ${c.loudness.reference ?? '?'} LUFS${g ? ` · balance low end ${sg(g['low end'])}, mids ${sg(g.mids)}, highs ${sg(g.highs)}` : ''} · width ${c.width.project ?? '?'} vs ${c.width.reference ?? '?'} · energy shape correlation ${c.energy.correlation ?? '?'}${c.energy.partial ? ' (partial render)' : ''}`,
        );
      } else if (ref && out.ok) L.push(`vs the reference: not compared (${out.raw ? 'no analysis' : 'this engine build returned no render analysis'}).`);
      if (r.closeness) L.push(...closenessLines(r.closeness));
      if (!out.ok) L.push(`MIX CHECKS SKIPPED: the render failed (${out.error}); the arrangement and sound checks below still ran.`);
      L.push('');
      if (r.issues.length) {
        L.push(`ISSUES (${r.total} found${r.total > r.issues.length ? `, top ${r.issues.length} shown` : ''}; fix them in this order):`);
        r.issues.forEach((x, i) => L.push(issueLine(x, i)));
      } else L.push(`ISSUES: none found against ${pb ? 'the playbook targets' : 'the generic targets'}.`);
      L.push('');
      L.push('WHAT WORKS:');
      for (const w of r.works) L.push(`- ${w}`);
      if (r.skipped.length) L.push(`Not checked: ${r.skipped.join('; ')}.`);
      L.push('');
      L.push(r.issues.length ? 'NEXT: apply the fixes (each is a tool call), then review_song again. Stop after 2 fix rounds and report the score; mention anything left.' : 'NEXT: finish (set_song_info, commit_edit) and report the score.');
      const high = r.issues.filter((x) => x.severity === 'high').length;
      return {
        ok: true,
        message: `Review of ${out.plan.label}: ${r.score}/100${r.closeness?.overall != null ? `, closeness to the reference ${r.closeness.overall}/100` : ''}, ${plural(r.total, 'issue')}${high ? ` (${high} high)` : ''}${r.issues[0] ? `. First: ${r.issues[0].problem}` : '. Nothing to fix.'}${out.ok ? '' : ' (Mix checks skipped: the render failed.)'}`,
        changed: [],
        text: L.join('\n'),
        warnings: warnings.length ? warnings : undefined,
        data: { score: r.score, issues: r.issues, total: r.total, works: r.works, sections: r.sections.map((s) => ({ ...s, startBar: Math.floor(s.start / barT) + 1, endBar: Math.ceil(s.end / barT) })), metrics: r.metrics, skipped: r.skipped, playbook: pb?.id ?? null, targets, render: out.file ? { file: out.file, seconds: out.seconds, stems: out.stems?.length ?? 0, ...(out.stemsProblem ? { stemsProblem: out.stemsProblem } : {}) } : null, reference: ref ? { name: ref.brief.name, track: ref.track.channel.name, comparison } : null, closeness: r.closeness ?? null, timings: { renderMs, reviewMs } },
      };
    },
  });
}

// ── add_transition ──────────────────────────────────────────────────────

export const TRANSITION_KINDS = ['riser', 'reverse-cymbal', 'impact', 'downlifter', 'sub-drop', 'sweep-up', 'sweep-down', 'snare-roll', 'drum-fill', 'filter-sweep', 'crash', 'silence', 'whoosh', 'tape-stop', 'swell'] as const;
type Kind = (typeof TRANSITION_KINDS)[number];

/** Audio kinds: which factory sample kind, whether it ENDS at the boundary or STARTS there, its default level. */
const AUDIO_KINDS: Partial<Record<Kind, { sample: SampleKind; align: 'end' | 'start'; gainDb: number }>> = {
  riser: { sample: 'riser', align: 'end', gainDb: -8 },
  'reverse-cymbal': { sample: 'reverse-cymbal', align: 'end', gainDb: -8 },
  'sweep-up': { sample: 'sweep-up', align: 'end', gainDb: -10 },
  'drum-fill': { sample: 'fill', align: 'end', gainDb: -6 },
  impact: { sample: 'impact', align: 'start', gainDb: -6 },
  'sub-drop': { sample: 'sub-drop', align: 'start', gainDb: -6 },
  crash: { sample: 'crash', align: 'start', gainDb: -8 },
  downlifter: { sample: 'downlifter', align: 'start', gainDb: -9 },
  'sweep-down': { sample: 'sweep-down', align: 'start', gainDb: -10 },
  // Wave 7b: a whoosh peaks as it crosses the boundary, a tape stop brings the music to a halt into a break or an
  // ending, a swell (reverse reverb / volume) blooms into the downbeat. All three END on the boundary.
  whoosh: { sample: 'whoosh', align: 'end', gainDb: -10 },
  'tape-stop': { sample: 'tape-stop', align: 'end', gainDb: -8 },
  swell: { sample: 'swell', align: 'end', gainDb: -9 },
};

/** Recorded pack samples aren't normalised like the factory's (-1 dBFS): level them by their measured peak. */
const FACTORY_PEAK_DB = -1;

/** The default level of a picked sample: the kind's level, moved by how far a pack sample's peak sits from the factory's. */
export function transitionGainDb(s: Pick<FactorySample, 'path' | 'peakDb'>, gainDb: number): number {
  if (!s.path.startsWith('pack:') || !Number.isFinite(s.peakDb)) return gainDb;
  return gainDb + Math.max(-6, Math.min(12, FACTORY_PEAK_DB - s.peakDb));
}

const LEGACY_CRASH = 'factory:drums/crash.wav';
const AUDIOCLIP = 'krypt.audioclip';

interface Placed {
  at: number;
  what: string;
  clipId?: string;
  automationId?: string;
  startBar: string;
  endBar: string;
}

interface TCtx {
  deps: MainDeps;
  ctx: RunCtx;
  barTicks: number;
  genre: GenreId | null;
  samples: readonly FactorySample[] | null;
  placed: Placed[];
  warnings: string[];
  notes: string[];
}

const pos = (tick: number, barTicks: number): string => {
  const bar = Math.floor(tick / barTicks) + 1;
  const rem = tick - (bar - 1) * barTicks;
  const step = rem / (PPQ / 4) + 1;
  return step === 1 ? `${bar}` : `${bar}.${Number.isInteger(step) ? step : step.toFixed(2)}`;
};

/** A Playlist lane named "FX" (or "FX 2" …) free over [start, end): reused, else created under the used lanes. */
function fxLane(t: TCtx, start: number, end: number): string {
  const p = t.deps.doc.project;
  const clips = Object.values(p.playlist.clips);
  const fx = p.playlist.trackOrder.filter((id) => /^fx( \d+)?$/i.test(p.playlist.tracks[id].name.trim()));
  for (const id of fx) if (!clips.some((c) => c.trackId === id && c.start < end && c.start + c.length > start)) return id;
  const used = new Set(clips.map((c) => c.trackId));
  let index = 0;
  p.playlist.trackOrder.forEach((id, i) => {
    if (used.has(id) || fx.includes(id)) index = i + 1;
  });
  return t.ctx.exec<{ id: string }>('playlist.addTrack', { name: fx.length ? `FX ${fx.length + 1}` : 'FX', index }).id;
}

/** Route a new FX audio channel into the shared "FX" insert (created from its own new insert the first time). */
function intoFxInsert(t: TCtx, channelId: string, newInsertId: string): void {
  const p = t.deps.doc.project;
  const existing = p.mixer.insertOrder.find((id) => id !== newInsertId && !p.mixer.inserts[id].isMaster && p.mixer.inserts[id].name.trim().toLowerCase() === 'fx');
  if (existing) {
    t.ctx.exec('channels.set', { id: channelId, insertId: existing });
    if (!Object.values(t.deps.doc.project.channels).some((c) => c.insertId === newInsertId)) t.ctx.exec('mixer.removeInsert', { id: newInsertId });
  } else t.ctx.exec('mixer.setInsert', { id: newInsertId, name: 'FX' });
}

function sameParams(ch: Channel, want: Record<string, number>): boolean {
  const g = ch.generator.params;
  const val = (k: string) => g[k] ?? 0;
  return ['tempo_sync', 'src_bpm', 'reverse'].every((k) => Math.abs(val(k) - (want[k] ?? 0)) < 0.01);
}

/** Place one FX sample so it ends (risers) or starts (impacts) at the boundary; tempo-synced FX span exact bars. */
async function placeAudio(t: TCtx, kind: Kind, s: FactorySample, at: number, opts: { align: 'end' | 'start'; gainDb: number; lengthBars?: number; reverse?: boolean }): Promise<void> {
  const p = t.deps.doc.project;
  const B = (at - 1) * t.barTicks;
  const synced = !!(s.bpm && s.bars);
  const params: Record<string, number> = {};
  let span: number;
  let full: number;
  let how = '';
  if (synced) {
    const natural = s.bars! * 4 * PPQ;
    let want = opts.lengthBars ? Math.round(opts.lengthBars * t.barTicks) : natural;
    let ratio = want / natural;
    if (ratio < 0.5 || ratio > 2) {
      t.warnings.push(`${kind} "${s.name}" is ${s.bars} bars; stretching it to ${opts.lengthBars} bars would sound wrong, so it keeps its own length.`);
      want = natural;
      ratio = 1;
    }
    const src = round(s.bpm! * ratio, 3);
    params.tempo_sync = 1;
    params.src_bpm = src;
    full = Math.max(1, Math.round(secondsToTicks(s.lengthSec, src)));
    span = opts.align === 'end' ? Math.min(full, want) : full;
    how = `tempo-synced from ${s.bpm} bpm${ratio !== 1 ? `, stretched to ${round(want / t.barTicks, 2)} bars` : ''}`;
  } else {
    if (opts.lengthBars) t.notes.push(`"${s.name}" is a one-shot, so length_bars doesn't apply to it`);
    full = Math.max(1, Math.round(secondsToTicks(s.lengthSec, p.transport.bpm)));
    span = full;
  }
  if (opts.reverse) params.reverse = 1;
  let start = opts.align === 'end' ? B - span : B;
  let length = span;
  let offset = 0;
  if (start < 0) {
    offset = -start;
    length -= offset;
    start = 0;
  }
  if (length < PPQ / 8) {
    t.warnings.push(`bar ${at}: no room for a ${kind} before the song starts; skipped.`);
    return;
  }
  const lane = fxLane(t, start, start + length);
  const existing = p.channelOrder.map((id) => p.channels[id]).find((c) => c.generator.type === AUDIOCLIP && c.generator.sampleId && p.samples[c.generator.sampleId]?.path === s.path && sameParams(c, params));
  let clipId: string;
  if (existing) {
    const dup = Object.values(p.playlist.clips).find((c) => c.kind === 'audio' && c.channelId === existing.id && c.start === start && c.length === length && c.offset === offset);
    if (dup) {
      t.notes.push(`bar ${at}: that ${kind} is already there`);
      return;
    }
    clipId = t.ctx.exec<{ id: string }>('playlist.addClip', { kind: 'audio', trackId: lane, start, length, offset, channelId: existing.id }).id;
  } else {
    let info: { frames?: number; sampleRate?: number; channels?: number } = {};
    try {
      const r = await t.deps.engine.sampleInfo(t.deps.project.resolveSamplePath(s.path));
      if (r.ok && r.data && r.data.frames > 0 && r.data.sampleRate > 0) info = { frames: r.data.frames, sampleRate: r.data.sampleRate, channels: r.data.channels };
    } catch {
      /* fall back to the index's length */
    }
    if (!info.frames) info = { frames: Math.max(1, Math.round(s.lengthSec * 48000)), sampleRate: 48000, channels: s.channels };
    const r = t.ctx.exec<{ clipId: string; channelId: string; insertId: string }>('playlist.addAudio', { path: s.path, name: s.name, trackId: lane, start, ...info });
    intoFxInsert(t, r.channelId, r.insertId);
    t.ctx.exec('channels.set', { id: r.channelId, name: safeName(`FX ${opts.reverse ? 'Reverse ' : ''}${s.name}`, 64), volume: Math.min(1.25, dbToGain(transitionGainDb(s, opts.gainDb))) });
    if (Object.keys(params).length) t.ctx.exec('channels.setGenParams', { id: r.channelId, params });
    t.ctx.exec('playlist.updateClips', { updates: [{ id: r.clipId, start, length, offset }] });
    clipId = r.clipId;
  }
  const pack = parsePackPath(s.path);
  const from = pack ? ` from ${packPhrase(safeName(packById(pack.packId)?.name ?? pack.packId, 40))}` : '';
  t.placed.push({ at, what: `${opts.reverse ? 'reversed ' : ''}"${safeName(s.name, 64)}"${from}${how ? ` (${how})` : ''}`, clipId, startBar: pos(start, t.barTicks), endBar: pos(start + length, t.barTicks) });
}

/**
 * The best sample of a kind from the library (factory + installed sound packs; closest to `bars` for tempo-synced
 * FX), or null. Ranking ties go to the factory sound; a pack sound wins when it fits the genre / length better.
 */
function pickSample(t: TCtx, kind: SampleKind, bars?: number): FactorySample | null {
  const installed = (s: FactorySample) => {
    try {
      return fs.existsSync(t.deps.project.resolveSamplePath(s.path));
    } catch {
      return false;
    }
  };
  const pool = t.samples?.filter((s) => s.kind === kind && installed(s)) ?? [];
  if (!pool.length) return null;
  const q = { kind, genre: t.genre ?? undefined };
  return (bars !== undefined ? rankSamples(pool, { ...q, bars }, 1)[0] : undefined) ?? rankSamples(pool, q, 1)[0] ?? null;
}

/** The original kit's crash (every install has it), measured by the engine when it can. */
async function legacyCrash(t: TCtx): Promise<FactorySample> {
  let lengthSec = 2.5;
  try {
    const r = await t.deps.engine.sampleInfo(t.deps.project.resolveSamplePath(LEGACY_CRASH));
    if (r.ok && r.data && r.data.frames > 0 && r.data.sampleRate > 0) lengthSec = r.data.frames / r.data.sampleRate;
  } catch {
    /* default length */
  }
  return { path: LEGACY_CRASH, name: 'Crash', kind: 'crash', tags: [], genres: [], lengthSec, channels: 2, peakDb: -1 };
}

/** The snare (else clap) channel for rolls and fills: `target`, else found by name, else a new sampler "Snare". */
function snareChannel(t: TCtx, target?: string): Channel {
  const p = t.deps.doc.project;
  if (target) return findChannel(p, target);
  for (const role of ['snare', 'clap']) {
    const id = p.channelOrder.find((c) => roleFromName(p.channels[c].name) === role && p.channels[c].generator.type !== AUDIOCLIP);
    if (id) return p.channels[id];
  }
  const best = t.samples ? rankSamples(t.samples, { kind: 'snare', genre: t.genre ?? undefined }, 1)[0] : undefined;
  const sampleId = t.ctx.exec<{ id: string }>('samples.add', { path: best?.path ?? 'factory:drums/snare.wav' }).id;
  const id = t.ctx.exec<{ id: string }>('channels.add', { type: 'krypt.sampler', name: 'Snare', sampleId }).id;
  t.notes.push('created a "Snare" channel for it');
  return t.deps.doc.project.channels[id];
}

type NoteIn = { tick: number; key: number; dur: number; vel: number };

/** 8ths → 16ths → 32nds over `bars`, velocity ramping up into the downbeat. */
export function snareRollNotes(bars: number, barTicks: number, key: number): NoteIn[] {
  const total = bars * barTicks;
  const out: NoteIn[] = [];
  const segs: Array<[number, number, number]> = [
    [0, total / 2, PPQ / 2],
    [total / 2, (total * 3) / 4, PPQ / 4],
    [(total * 3) / 4, total, PPQ / 8],
  ];
  for (const [a, b, step] of segs) for (let tk = a; tk < b; tk += step) out.push({ tick: Math.round(tk), key, dur: step, vel: round(0.35 + (0.65 * tk) / total, 3) });
  return out;
}

/** A short snare fill: 16ths over the last half of the bar(s), crescendo. */
export function drumFillNotes(bars: number, barTicks: number, key: number): NoteIn[] {
  const total = bars * barTicks;
  const out: NoteIn[] = [];
  const from = total - Math.min(total, barTicks) / 2;
  for (let tk = from; tk < total; tk += PPQ / 4) out.push({ tick: Math.round(tk), key, dur: PPQ / 4, vel: round(0.5 + (0.5 * (tk - from)) / (total - from), 3) });
  return out;
}

function noteSig(notes: Array<{ tick: number; key: number; vel: number }>): string {
  return notes
    .map((n) => `${n.tick}|${n.key}|${Math.round(n.vel * 127)}`)
    .sort()
    .join(';');
}

/** The roll / fill pattern: an identical one is reused, else a new one ("Snare Roll", "Snare Roll 2" …). */
function ensurePattern(t: TCtx, base: string, ch: Channel, notes: NoteIn[], length: number): { id: string; name: string } {
  const p = t.deps.doc.project;
  const want = noteSig(notes);
  const same = p.patternOrder
    .map((id) => p.patterns[id])
    .find((x) => (x.name === base || new RegExp(`^${base} \\d+$`).test(x.name)) && x.length === length && Object.keys(x.notes).length === 1 && noteSig(Object.values(x.notes[ch.id] ?? {})) === want);
  if (same) return { id: same.id, name: same.name };
  let name = base;
  for (let k = 2; p.patternOrder.some((id) => p.patterns[id].name === name); k++) name = `${base} ${k}`;
  const id = t.ctx.exec<{ id: string }>('patterns.add', { name, select: false, length }).id;
  t.ctx.exec('notes.add', { patternId: id, channelId: ch.id, notes });
  return { id, name };
}

function placePattern(t: TCtx, kind: Kind, base: string, ats: number[], bars: number, target: string | undefined, make: (bars: number, barTicks: number, key: number) => NoteIn[]): void {
  const ch = snareChannel(t, target);
  const length = bars * t.barTicks;
  const pat = ensurePattern(t, base, ch, make(bars, t.barTicks, ch.rootKey), length);
  for (const at of ats) {
    const start = (at - 1) * t.barTicks - length;
    if (start < 0) {
      t.warnings.push(`bar ${at}: a ${bars}-bar ${kind} needs ${bars} bars before it; skipped.`);
      continue;
    }
    const p = t.deps.doc.project;
    if (Object.values(p.playlist.clips).some((c) => c.kind === 'pattern' && c.patternId === pat.id && c.start === start)) {
      t.notes.push(`bar ${at}: "${pat.name}" is already there`);
      continue;
    }
    const lane = fxLane(t, start, start + length);
    const clipId = t.ctx.exec<{ id: string }>('playlist.addClip', { kind: 'pattern', trackId: lane, start, length, patternId: pat.id }).id;
    t.placed.push({ at, what: `pattern "${pat.name}" on ${ch.name}`, clipId, startBar: pos(start, t.barTicks), endBar: pos(start + length, t.barTicks) });
  }
}

function filterSweep(t: TCtx, ats: number[], lengthBars: number, target: string | undefined): void {
  const p = t.deps.doc.project;
  const ins = findInsert(p, target ?? 'master');
  let slotId = ins.slotOrder.find((s) => ins.slots[s].type === 'krypt.filter' && [2, 3].includes(Math.round(ins.slots[s].params.type ?? 1)));
  if (!slotId) {
    slotId = t.ctx.exec<{ id: string }>('mixer.addSlot', { insertId: ins.id, type: 'krypt.filter', index: 0, params: { type: 3, cutoff: 20, reso: 0.15 } }).id;
    t.notes.push(`added a Krypt Filter (HP 24, open at 20 Hz) first on ${ins.isMaster ? 'the Master' : `"${safeName(ins.name)}"`}`);
  }
  const ref = `insert/${ins.id}/slot/${slotId}/cutoff`;
  const spec = paramSpecFor(t.deps.doc.project, t.deps.doc.catalog, ref);
  if (!spec) fail(`Couldn't automate the filter cutoff (${ref}).`);
  const base = getParamValue(t.deps.doc.project, t.deps.doc.catalog, ref) ?? 20;
  const peak = base < 200 ? 600 : Math.min(8000, base * 4);
  for (const at of ats) {
    const B = (at - 1) * t.barTicks;
    const len = Math.min(B, Math.round(lengthBars * t.barTicks));
    if (len < PPQ) {
      t.warnings.push(`bar ${at}: no room for a filter sweep before it; skipped.`);
      continue;
    }
    const start = B - len;
    const points = [
      { tick: 0, value: toNormalized(spec, base), tension: -0.5 },
      { tick: len - 1, value: toNormalized(spec, peak), tension: 0 },
      { tick: len, value: toNormalized(spec, base), tension: 0 },
    ];
    const lane = fxLane(t, start, B);
    const r = t.ctx.exec<{ automationId: string; clipId: string }>('automation.create', { target: ref, name: `Filter sweep into bar ${at}`, points, trackId: lane, start, length: len });
    t.placed.push({ at, what: `high-pass sweep ${Math.round(base)} Hz → ${peak} Hz, back to ${Math.round(base)} Hz on the downbeat (${ins.isMaster ? 'Master' : safeName(ins.name)})`, clipId: r.clipId, automationId: r.automationId, startBar: pos(start, t.barTicks), endBar: pos(B, t.barTicks) });
  }
}

function silence(t: TCtx, ats: number[], lengthBars: number | undefined): void {
  const p = t.deps.doc.project;
  const ts = p.transport.timeSig;
  const master = p.mixer.inserts[p.mixer.masterId];
  const ref = `insert/${master.id}/volume`;
  const spec = paramSpecFor(p, t.deps.doc.catalog, ref);
  if (!spec) fail("Couldn't automate the master volume.");
  const len = lengthBars !== undefined ? Math.max(PPQ / 4, Math.min(2 * t.barTicks, Math.round(lengthBars * t.barTicks))) : ticksPerBeat(ts);
  const v = toNormalized(spec, master.volume);
  const fade = Math.min(24, Math.floor(len / 4));
  for (const at of ats) {
    const B = (at - 1) * t.barTicks;
    const start = B - len;
    if (start < 0) {
      t.warnings.push(`bar ${at}: no room for a silence before it; skipped.`);
      continue;
    }
    const points = [
      { tick: 0, value: v, tension: 0 },
      { tick: fade, value: 0, tension: 0 },
      { tick: len - 1, value: 0, tension: 0 },
      { tick: len, value: v, tension: 0 },
    ];
    const lane = fxLane(t, start, B);
    const r = t.ctx.exec<{ automationId: string; clipId: string }>('automation.create', { target: ref, name: `Silence before bar ${at}`, points, trackId: lane, start, length: len });
    t.placed.push({ at, what: `master volume dips to silence for ${len === ticksPerBeat(ts) ? 'the last beat' : `${round(len / t.barTicks, 2)} bars`} and comes back on the downbeat`, clipId: r.clipId, automationId: r.automationId, startBar: pos(start, t.barTicks), endBar: pos(B, t.barTicks) });
  }
}

const noKit = (t: TCtx, kind: string, sample: string): string =>
  `No ${kind} sample: ${t.samples ? `neither the factory kit nor an installed sound pack has "${sample}" samples` : "the factory sample kit isn't installed (resources/factory/index.json is missing or unreadable)"}.`;

export const addTransition = defineTool({
  name: 'add_transition',
  title: 'Add transitions at section boundaries',
  kind: 'write',
  description:
    'Puts transition material at section boundaries so sections don\'t just switch. at_bars = the 1-based bars where the NEXT section starts (several at once). Kinds: riser, reverse-cymbal, sweep-up, whoosh, swell (FX audio that ENDS exactly on the boundary: risers / whooshes / swells into drops and hooks); tape-stop (the music slowing to a halt, ending on the boundary: into a break or at the end); impact, sub-drop, crash, downlifter, sweep-down (audio that STARTS on the downbeat: impacts on downbeats); snare-roll (a "Snare Roll" pattern, 8ths → 16ths → 32nds with a velocity ramp, in the bars before); drum-fill (fill audio, else a snare fill pattern); filter-sweep (a high-pass Krypt Filter on `target` or the master, swept up across length_bars and reset on the downbeat); silence (the master drops out for the last beat). Tempo-synced FX span exactly length_bars (default: the sample\'s own length). Samples come from the factory kit and any installed sound pack (pack sounds are levelled by their measured peak). FX audio goes on an "FX" Playlist lane through one "FX" mixer insert. One call = one undo step. Example: {"at_bars":[17,49],"kind":"riser","length_bars":8}',
  input: z.object({
    at_bars: z.array(z.number().int().min(1).max(4096)).min(1).max(32).describe('Bars where the next section starts (1-based).'),
    kind: z.enum(TRANSITION_KINDS),
    length_bars: z.number().positive().max(32).optional().describe('riser / sweep-up / reverse-cymbal / whoosh / swell: bars to span (tempo-synced samples); snare-roll: 1-8 (default 2); filter-sweep: default 4; drum-fill: default 1; silence: fraction of a bar (default one beat).'),
    target: z.string().max(80).optional().describe('filter-sweep: the insert to filter (default master). snare-roll / drum-fill: the snare or clap channel (default: found by name).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.kind} @ ${a.at_bars.slice(0, 6).join(', ')}${a.at_bars.length > 6 ? '…' : ''}`,
  async run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const ats = [...new Set(a.at_bars)].sort((x, y) => x - y);
    const { samples } = soundsOf(deps);
    const t: TCtx = { deps, ctx, barTicks: ticksPerBar(p.transport.timeSig), genre: genreFrom(p.meta.genre), samples, placed: [], warnings: [], notes: [] };
    const kind = a.kind as Kind;
    const fallbacks: string[] = [];
    switch (kind) {
      case 'snare-roll':
        placePattern(t, kind, 'Snare Roll', ats, Math.max(1, Math.min(8, Math.round(a.length_bars ?? 2))), a.target, snareRollNotes);
        break;
      case 'filter-sweep':
        filterSweep(t, ats, a.length_bars ?? 4, a.target);
        break;
      case 'silence':
        silence(t, ats, a.length_bars);
        break;
      default: {
        const spec = AUDIO_KINDS[kind]!;
        const s = pickSample(t, spec.sample, spec.align === 'end' ? a.length_bars : undefined);
        let alt: FactorySample | null = null;
        if (s) {
          for (const at of ats) await placeAudio(t, kind, s, at, { align: spec.align, gainDb: spec.gainDb, lengthBars: a.length_bars });
          break;
        }
        // Fallbacks without the sample.
        if (kind === 'drum-fill') {
          fallbacks.push(`${noKit(t, kind, spec.sample)} Wrote a snare fill pattern instead.`);
          placePattern(t, kind, 'Drum Fill', ats, Math.max(1, Math.min(4, Math.round(a.length_bars ?? 1))), a.target, drumFillNotes);
        } else if (kind === 'whoosh' && (alt = pickSample(t, 'sweep-up', a.length_bars))) {
          fallbacks.push(`${noKit(t, kind, spec.sample)} Used an up-sweep ("${safeName(alt.name, 64)}") instead.`);
          for (const at of ats) await placeAudio(t, kind, alt, at, { align: 'end', gainDb: AUDIO_KINDS['sweep-up']!.gainDb, lengthBars: a.length_bars });
        } else if (kind === 'swell' && (alt = pickSample(t, 'reverse-cymbal', a.length_bars))) {
          fallbacks.push(`${noKit(t, kind, spec.sample)} Used a reverse cymbal ("${safeName(alt.name, 64)}") instead.`);
          for (const at of ats) await placeAudio(t, kind, alt, at, { align: 'end', gainDb: AUDIO_KINDS['reverse-cymbal']!.gainDb, lengthBars: a.length_bars });
        } else if (kind === 'riser' || kind === 'sweep-up' || kind === 'whoosh') {
          fallbacks.push(`${noKit(t, kind, spec.sample)} Used a filter sweep instead${kind === 'whoosh' ? '' : ' (add a snare-roll on top for more lift)'}.`);
          filterSweep(t, ats, a.length_bars ?? (kind === 'whoosh' ? 1 : 4), a.target);
        } else if (kind === 'tape-stop') {
          fallbacks.push(`${noKit(t, kind, spec.sample)} Dropped the master out for the last beat instead (a silence).`);
          silence(t, ats, undefined);
        } else if (kind === 'reverse-cymbal' || kind === 'swell' || kind === 'crash' || kind === 'impact') {
          const crash = pickSample(t, 'crash') ?? (await legacyCrash(t));
          const reversed = kind === 'reverse-cymbal' || kind === 'swell';
          if (kind !== 'crash') fallbacks.push(`${noKit(t, kind, spec.sample)} Used ${reversed ? 'a reversed' : 'a'} crash ("${crash.name}") instead.`);
          for (const at of ats) await placeAudio(t, kind, crash, at, { align: reversed ? 'end' : 'start', gainDb: spec.gainDb, reverse: reversed });
        } else {
          fail(`${noKit(t, kind, spec.sample)} Nothing was added. Use add_transition with kind "crash", "filter-sweep" or "snare-roll" instead.`);
        }
      }
    }
    if (!t.placed.length) {
      const why = [...t.warnings, ...t.notes].join(' ');
      fail(`No change: no ${kind} was placed${why ? ` (${why})` : ''}.`);
    }
    const bars = t.placed.map((x) => x.at);
    const detail = t.placed.map((x) => `bar ${x.at}: ${x.what}, ${x.startBar} → ${x.endBar}`).join('; ');
    const extra = [...fallbacks, ...t.notes.map((n) => `(${n})`)].join(' ');
    return {
      ok: true,
      message: `Added ${kind} at ${plural(bars.length, 'boundary', 'boundaries')} (bar${bars.length === 1 ? '' : 's'} ${bars.join(', ')}): ${detail}.${extra ? ` ${extra}` : ''}`,
      changed: [],
      warnings: t.warnings.length ? t.warnings : undefined,
      data: { kind, placed: t.placed },
    };
  },
});

/** The craft tools over a playbook registry (tests pass a fixture one). */
export function craftTools(reg: PlaybookRegistry = DEFAULT_REGISTRY): ToolDef[] {
  return [getPlaybookTool(reg), reviewTool(reg), addTransition] as ToolDef[];
}

export const CRAFT_TOOLS: ToolDef[] = craftTools();

