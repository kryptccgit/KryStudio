// Wave 8a (research/15 §3.4): the two deterministic one-call builders.
//
//  audio_to_project      any audio file → an editable project (a CONVERSION:
//                        every part transcribed, vocals as audio, stems kept
//                        muted). For the user's own songs, practice, remixes.
//  build_from_reference  the studied reference → a NEW song's whole
//                        instrumental bed in its style (drum programming,
//                        chord progression, bass rhythm, sections, sounds,
//                        mix), an empty matched Lead and the melody SHAPE
//                        for the agent's ORIGINAL top line. Never its melody,
//                        vocal or lyrics (unless mine: true).
//
// Both run electron/audioProject (analyze → separate → transcribe → match →
// build) and land as ONE undo step.

import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Project } from '@shared/schema/project';
import type { AudioProjectProgress } from '@shared/types';
import type { SectionKind, TransitionKind } from '@shared/playbooks/types';
import type { StemName } from '@shared/analyzer/protocol';
import { listPlaybooks, playbookFor } from '@shared/playbooks';
import { genreInText, resolveGenre, type GenreId } from '@shared/sounds/genres';
import { melodyShapeText } from '@shared/transcription';
import { secondsToTicks } from '@shared/schema/time';
import { audioProjectFor, pumps, type Prepared } from '../../audioProject';
import { writeProject, type WritePlan, type Writer } from '../../audioProject/build';
import { fallbackSound, libraryPresets, partRole, soundLine } from '../../audioProject/sounds';
import { defineTool, fail, type RunCtx, type ToolCaller, type ToolDef, type ToolResult } from './types';
import { agentSamplePath, plural, safeName } from './util';
import { describeTemplate, findTemplate } from '@shared/templates';
import { findReference, studyReference } from './reference';
import { addTransition, TRANSITION_KINDS } from './craft';
import { genericPlaybook, resolveChain, transitionLength } from './craftRecipe';
import { applyChain } from './presets';
import { route } from './mix';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zFactor = z.union([z.literal(1), z.literal(0.5), z.literal(2)]);

function progressOf(ctx: RunCtx): ((p: AudioProjectProgress) => void) | undefined {
  return ctx.progress ? (p) => ctx.progress!(p.fraction, p.message) : undefined;
}

/** Run another tool's body inside this call (same group), with its zod defaults. */
async function runTool(def: ToolDef, deps: MainDeps, caller: ToolCaller, args: unknown, ctx: RunCtx): Promise<ToolResult> {
  const parsed = def.input.safeParse(args);
  if (!parsed.success) fail(`${def.name}: ${parsed.error.issues[0]?.message ?? 'invalid arguments'}`);
  return await def.run(deps, caller, parsed.data as never, ctx);
}

const writerOf = (ctx: RunCtx): Writer => ({ exec: <T,>(cmd: string, args: unknown): T => ctx.exec<T>(cmd, args) });

// ── audio_to_project ────────────────────────────────────────────────────

export const audioToProject = defineTool({
  name: 'audio_to_project',
  title: 'Turn an audio file into an editable project',
  kind: 'write',
  description:
    `Turn a song file (WAV, MP3, M4A, FLAC …) into an editable project in ONE call and one undo step: stems separated (HT-Demucs, when the user installed it), drums / bass / chords / lead transcribed into one pattern per section on the closest matching sounds, the vocal as an audio track, the sections arranged with markers, tempo / key / swing set, the bass sidechained when the song pumps, the stems kept as MUTED audio tracks lined up with bar 1 (keep_stems). This is a CONVERSION of that song (the user's own songs, practice and remix study), not a new song: to make something LIKE a song use study_reference then build_from_reference. into "new" (default) opens it as a NEW project in a new tab (the open project stays open in its tab); into "current" adds the parts to the open project. factor = the tempo reading (0.5 / 1 / 2). parts = which parts become patterns (vocals always stay audio). path: an absolute path; with File access "Ask me" the user is asked first. The first run takes about a minute per song on a CPU (cached after). template (no path) instead starts a NEW, unsaved project from one of the user's own project templates (File ▸ Save as template…), by name or id, in a new tab. Examples: {"path":"C:\\\\Users\\\\me\\\\Music\\\\my song.mp3"} · {"template":"Trap starter"}`,
  input: z.object({
    path: z.string().min(1).max(400).optional().describe('Absolute path of the audio file.'),
    template: z.string().min(1).max(80).optional().describe("Instead of path: start a new project from the user's project template with this name or id."),
    keep_stems: z.boolean().default(true).describe('Keep the separated stems as muted audio tracks under the patterns (A/B, reuse).'),
    factor: zFactor.optional().describe('Tempo reading: 1 = as detected (default), 0.5 = half time, 2 = double time.'),
    parts: z.array(z.enum(['drums', 'bass', 'chords', 'lead'])).min(1).max(4).optional().describe('Which parts become patterns (default: all that were found).'),
    into: z.enum(['new', 'current']).default('new').describe('"new" project (default) or the "current" one.'),
    change_label: zLabel,
  }),
  summarize: (a) => (a.template !== undefined && !a.path ? `template ${safeName(a.template, 40)}` : safeName(a.path?.split(/[\\/]/).pop() ?? a.path ?? '', 40)),
  paths: (a) => (a.template !== undefined ? [] : [{ value: a.path, kind: 'audio' }]),
  // A new project from a template is a reset (no patches): not a "No change".
  readsWhenUnchanged: true,
  async run(deps, caller, a, ctx) {
    if (a.template !== undefined) {
      if (a.path) fail('Pass either path (an audio file to convert) or template (a new project from a template), not both.');
      return await startFromTemplate(deps, caller, a.template);
    }
    if (!a.path) fail("Pass path: the audio file to convert (or template: a new project from one of the user's templates).");
    if (!deps.analyzer) fail("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log).");
    const { abs } = agentSamplePath(deps, a.path, caller);
    if (a.into === 'new') {
      if (deps.project.status().dirty && !deps.project.opensNewTabs?.()) fail("The open project has unsaved changes. Save or close the current project first (or ask me to add it to this one with into: 'current').");
      if (!deps.project.newProject) fail("A new project can't be opened from this session; use into: 'current'.");
      if (caller.session.group) fail(`A new project can't open inside the edit group "${safeName(caller.session.group.label, 60)}": commit_edit first, or use into: 'current'.`);
    }
    const svc = audioProjectFor(deps);
    const r = await svc.convert(abs, { keepStems: a.keep_stems, factor: a.factor, parts: a.parts }, a.into === 'new' ? { kind: 'new', actor: caller.actor } : { kind: 'current', writer: writerOf(ctx) }, { signal: ctx.signal, progress: progressOf(ctx) });
    if (!r.ok || !r.data) fail(r.message ?? 'The conversion failed');
    const o = r.data;
    return {
      ok: true,
      message: r.message ?? 'Converted',
      changed: [],
      text: [`Sounds:\n${o.sounds.map((x) => `  ${x}`).join('\n')}`, o.notes.length ? `Notes:\n${o.notes.map((x) => `- ${x}`).join('\n')}` : '', 'Everything is editable: read_pattern, write_pattern, transform_notes, load_preset. undo_last removes the whole conversion.'].filter(Boolean).join('\n\n'),
      data: o,
    };
  },
});

/** audio_to_project {template}: File ▸ New from template for agents (Wave 12.2b; electron/project/templates.ts). */
async function startFromTemplate(deps: MainDeps, caller: ToolCaller, ref: string): Promise<ToolResult> {
  if (!deps.project.newFromTemplate || !deps.project.listTemplates) fail("Project templates aren't available in this session.");
  const list = deps.project.listTemplates();
  if (!list.length) fail('The user has no project templates yet (they make one with File ▸ Save as template…).');
  const t = findTemplate(list, ref);
  if (!t) fail(`No template "${safeName(ref, 40)}". The user's templates: ${list.slice(0, 20).map((x) => `"${safeName(x.name, 40)}"`).join(', ')}.`);
  if (deps.project.status().dirty && !deps.project.opensNewTabs?.()) fail('The open project has unsaved changes. Save or close the current project first, then start from the template.');
  if (caller.session.group) fail(`A new project can't open inside the edit group "${safeName(caller.session.group.label, 60)}": commit_edit first.`);
  const r = await deps.project.newFromTemplate(t.id);
  if (!r.ok) fail(r.message ?? 'Starting from the template failed');
  return { ok: true, message: `${r.message ?? `New project from "${safeName(t.name)}"`} (${describeTemplate(t)}). It is a new, unsaved project; get_project shows what it holds.`, changed: [] };
}

// ── build_from_reference ────────────────────────────────────────────────

function genreArg(g: string | undefined): GenreId | null {
  const t = g?.trim();
  if (!t) return null;
  const id = resolveGenre(t) ?? genreInText(t);
  if (!id) fail(`"${safeName(t, 40)}" isn't a genre Krypt Studio has a playbook for. Genres: ${listPlaybooks().map((x) => x.id).join(', ')}.`);
  return id;
}

/** The section kind a transcribed section name implies ("Drop 2" → drop). */
export function kindOfName(name: string): SectionKind | null {
  const n = name.toLowerCase();
  const kinds: Array<[RegExp, SectionKind]> = [
    [/\bintro/, 'intro'],
    [/\bpre/, 'pre'],
    [/\bverse/, 'verse'],
    [/\bbuild/, 'build'],
    [/\bdrop/, 'drop'],
    [/\bhook/, 'hook'],
    [/\bchorus/, 'chorus'],
    [/\bbreakdown/, 'breakdown'],
    [/\bbreak/, 'break'],
    [/\bbridge/, 'bridge'],
    [/\boutro/, 'outro'],
  ];
  return kinds.find(([re]) => re.test(n))?.[1] ?? null;
}

/** add_transition calls for the section boundaries, from the genre playbook's kinds per section kind. */
export function boundaryTransitions(sections: Prepared['t']['sections'], genre: GenreId | null): Array<{ kind: TransitionKind; at_bars: number[]; length_bars?: number }> {
  const pb = (genre ? playbookFor(genre) : null) ?? genericPlaybook(genre);
  const generic = genericPlaybook(genre);
  const byKey = new Map<string, { kind: TransitionKind; at_bars: number[]; length_bars?: number }>();
  for (let i = 1; i < sections.length; i++) {
    const s = sections[i];
    const prev = sections[i - 1];
    const kind = kindOfName(s.name);
    const from = kind ? (pb.arrangement.find((x) => x.kind === kind && x.transitionIn?.length) ?? generic.arrangement.find((x) => x.kind === kind && x.transitionIn?.length)) : undefined;
    // Without a playbook section of that kind: rising energy gets a crash on the downbeat, falling a downlifter.
    const kinds: TransitionKind[] = from?.transitionIn?.length ? [...from.transitionIn] : s.energy >= prev.energy ? ['crash'] : ['downlifter'];
    for (const k of kinds) {
      if (!(TRANSITION_KINDS as readonly string[]).includes(k)) continue;
      const len = transitionLength(k, prev.bars);
      const key = `${k}|${len ?? ''}`;
      const call = byKey.get(key) ?? { kind: k, at_bars: [], ...(len !== undefined ? { length_bars: len } : {}) };
      if (!call.at_bars.includes(s.startBar)) call.at_bars.push(s.startBar);
      byKey.set(key, call);
    }
  }
  return [...byKey.values()].map((c) => ({ ...c, at_bars: c.at_bars.slice(0, 32) }));
}

/** Insert levels (dB, relative to the drums) from the reference stems' loudness: a starting point match_mix refines. */
function stemLevels(prep: Prepared): Record<string, number> {
  const st = prep.stems?.stems;
  const rms = (n: StemName) => (st?.[n] && Number.isFinite(st[n]!.rmsDb) ? st[n]!.rmsDb : null);
  const drums = rms('drums');
  if (drums === null) return {};
  const out: Record<string, number> = {};
  const clamp = (x: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, x)) * 10) / 10;
  for (const p of prep.parts) {
    if (p.kind === 'bass' && rms('bass') !== null) out[p.name] = clamp(rms('bass')! - drums, -9, 3);
    else if ((p.kind === 'chords' || p.kind === 'lead') && rms('other') !== null) out[p.name] = clamp(rms('other')! - drums, -12, 0);
  }
  return out;
}

/** Sections the agent's melody belongs in: the peak sections (the most energetic third), in order. */
function melodySections(prep: Prepared): string[] {
  const s = prep.t.sections;
  if (!s.length) return [];
  const sorted = [...s.map((x) => x.energy)].sort((a, b) => b - a);
  const cut = sorted[Math.max(0, Math.floor(sorted.length / 3) - 1)] ?? 1;
  return s.filter((x) => x.energy >= Math.min(cut, 0.75)).map((x) => x.name);
}

export const buildFromReference = defineTool({
  name: 'build_from_reference',
  title: 'Build a song from the studied reference',
  kind: 'write',
  description:
    'USE THIS FIRST after study_reference (before get_playbook, write_pattern or set_tempo): ONE call builds the whole instrumental bed of a NEW song in the reference\'s style, as one undo step: its tempo, key and swing; its drum programming per section (transcribed from the drum stem); its chord progression (fresh voicings); a bass with its RHYTHM on the chord roots / fifths; a pad when it has one; its sections as patterns arranged with markers; transitions at every boundary (the genre playbook\'s kinds); the closest matching sounds; drum bus, sends and master chain from the genre playbook; the bass sidechained to the kick; starting levels from the reference stems\' loudness. It also adds an EMPTY "Lead" channel with a matched sound and returns the reference melody\'s SHAPE (range, rhythm, phrase length): you write an ORIGINAL melody with that shape, then check_originality, match_mix, review_song. It never writes the reference\'s melody, vocal or lyrics (mine: true = the user says it is their own song: the exact bass and lead are kept). Uses the "Reference: …" track study_reference made. genre = the genre the user asked for (default: the reference\'s). Example: {} · {"genre":"house"}',
  input: z.object({
    genre: z.string().max(40).optional().describe('The genre the user wants (default: the reference\'s closest genre).'),
    mine: z.boolean().default(false).describe('The user says the reference is their OWN song: keep its exact bass and lead.'),
    factor: zFactor.optional().describe('Tempo reading of the reference: 1, 0.5 or 2 (default: the one study_reference chose for the genre).'),
    parts: z.array(z.enum(['drums', 'bass', 'chords'])).min(1).max(3).optional().describe('Which parts to build (default all).'),
    keep_reference: z.boolean().default(true).describe('Keep the reference track (muted, lined up with bar 1 for A/B). false removes it.'),
    change_label: zLabel,
  }),
  summarize: (a) => (a.genre ? safeName(a.genre, 30) : 'reference'),
  async run(deps, caller, a, ctx) {
    if (!deps.analyzer) fail("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so the reference can't be read.");
    const p0 = deps.doc.project;
    const track = findReference(p0);
    if (!track) fail('No studied reference in this project. Call study_reference {"file":"<the song the user gave>"} first; build_from_reference builds from it.');
    const sample = track.channel.generator.sampleId ? p0.samples[track.channel.generator.sampleId] : undefined;
    if (!sample) fail(`The reference "${safeName(track.channel.name, 60)}" has no audio.`);
    const abs = deps.project.resolveSamplePath(sample.path);
    const asked = genreArg(a.genre);
    const studied = await studyReference(deps, track, asked, ctx, 'cached');
    const brief = studied.brief;
    const genre = asked ?? brief.genre;
    const factor = a.factor ?? (brief.factor === 0.5 || brief.factor === 2 ? brief.factor : 1);
    const svc = audioProjectFor(deps);
    const title = safeName(track.title, 60);

    const r = await svc.exclusive(title, ctx.signal, async (signal) => {
      const prep = await svc.prepare({ channelId: track.channel.id }, abs, title, { mode: 'style', mine: a.mine, factor, parts: a.parts, keepStems: false, genre, leadChannel: true }, { signal, progress: progressOf(ctx) });
      return { ok: true, data: prep };
    }).catch((e) => ({ ok: false as const, message: (e as Error)?.message ?? String(e), data: undefined }));
    if (!r.ok || !r.data) fail(r.message ?? 'Reading the reference failed');
    const prep = r.data;
    if (prep.parts.some((x) => x.kind === 'lead') && !a.mine) fail('Internal guard: a lead line would have been copied from the reference; nothing was written.');

    const pb = (genre ? playbookFor(genre) : null) ?? genericPlaybook(genre);
    const presets = libraryPresets(deps);
    const leadWritten = prep.parts.some((x) => x.kind === 'lead');
    const leadName = 'Lead';
    const duckRoles = new Set(pb.parts.filter((x) => x.duckUnder && /kick/i.test(x.duckUnder)).map((x) => x.role as string));
    const sidechain = prep.parts
      .filter((x) => (x.kind === 'bass' && (pumps(prep.t) || ['bass', '808', 'sub'].some((r) => duckRoles.has(r)))) || (x.kind === 'chords' && ['pad', 'chord', 'keys'].some((r) => duckRoles.has(r))))
      .map((x) => x.name);
    const plan: WritePlan = {
      t: prep.t,
      parts: prep.parts,
      sounds: prep.sounds,
      empty: leadWritten ? [] : [{ name: leadName, sound: prep.lead ?? fallbackSound(deps, presets, { kind: 'lead', name: leadName }, genre) }],
      // Never the reference's audio in a new song.
      stems: [],
      sidechain,
      levelsDb: stemLevels(prep),
      sectionGainDb: prep.sectionGainDb,
      clearDefault: false,
      pruneUnusedDefaults: true,
      title: null,
      stemPrefix: title,
      setTransport: true,
    };
    const res = writeProject(writerOf(ctx), () => deps.doc.project, deps.doc.catalog, plan);
    const notes = [...prep.notes, ...res.notesText];

    // Transitions at every boundary (add_transition's own logic, inside this call's group).
    const transitions: string[] = [];
    for (const call of boundaryTransitions(prep.t.sections, genre)) {
      try {
        const tr = await runTool(addTransition, deps, caller, call, ctx);
        transitions.push(`${call.kind} at bar${call.at_bars.length === 1 ? '' : 's'} ${call.at_bars.join(', ')}`);
        for (const w of tr.warnings ?? []) notes.push(w);
      } catch (e) {
        notes.push(`No ${call.kind} at bars ${call.at_bars.join(', ')}: ${(e as Error)?.message ?? e}`);
      }
    }

    // Buses, sends and the master chain from the genre playbook.
    const mix: string[] = [];
    const tryTool = async (def: ToolDef, args: Record<string, unknown>, what: string): Promise<ToolResult | null> => {
      try {
        return await runTool(def, deps, caller, args, ctx);
      } catch (e) {
        notes.push(`${what} skipped: ${(e as Error)?.message ?? e}`);
        return null;
      }
    };
    const insertOfPart = (name: string) => res.insertIds[name];
    const ourRoles = (roles: string[]) => [...prep.parts.map((x) => ({ name: x.name, role: partRole(x) as string, drum: x.kind === 'drum' })), ...plan.empty.map((e) => ({ name: e.name, role: e.sound.role as string, drum: false }))].filter((x) => roles.includes(x.role) || (roles.includes('*drums') && x.drum));
    for (const b of pb.mix.buses ?? []) {
      const preset = resolveChain(b.chain, genre, presets, b.tags);
      if (!preset) continue;
      const feeds = ourRoles(b.chain === 'drumBus' ? ['*drums'] : pb.parts.filter((x) => x.bus === b.name).map((x) => x.role));
      if (!feeds.length) continue;
      const made = await tryTool(applyChain, { chain: preset.id, insert: `new:${b.name}` }, `The ${b.name}`);
      const busId = (made?.data as { insertId?: string } | undefined)?.insertId;
      if (!busId) continue;
      for (const f of feeds) if (insertOfPart(f.name)) await tryTool(route, { from_insert: insertOfPart(f.name), to: busId }, `Routing ${f.name} to ${b.name}`);
      mix.push(`${b.name} (${preset.name}) ← ${feeds.map((f) => f.name).join(', ')}`);
    }
    for (const s of pb.mix.sends ?? []) {
      const preset = resolveChain(s.chain, genre, presets, s.tags);
      if (!preset) continue;
      const feeds = s.from.flatMap((f) => {
        const role = pb.parts.find((x) => x.name === f.part)?.role;
        return role ? ourRoles([role]).map((o) => ({ ...o, amount: f.amount })) : [];
      });
      if (!feeds.length) continue;
      const made = await tryTool(applyChain, { chain: preset.id, insert: `new:${s.name}` }, `The ${s.name} send`);
      const sendId = (made?.data as { insertId?: string } | undefined)?.insertId;
      if (!sendId) continue;
      for (const f of feeds) if (insertOfPart(f.name)) await tryTool(route, { from_insert: insertOfPart(f.name), to: sendId, level_db: Math.round(20 * Math.log10(Math.max(0.01, f.amount))), exclusive: false }, `Sending ${f.name} to ${s.name}`);
      mix.push(`${s.name} send (${preset.name}) ← ${[...new Set(feeds.map((f) => f.name))].join(', ')}`);
    }
    const master = resolveChain('master', genre, presets, pb.mix.master.tags);
    if (master && (await tryTool(applyChain, { chain: master.id, insert: 'master' }, 'The master chain'))) mix.push(`master (${master.name})`);

    // The reference: lined up with bar 1 and following the tempo (A/B), or removed.
    const refNote = alignReference(deps, ctx, track.channel.id, prep, a.keep_reference);
    if (refNote) notes.push(refNote);

    const shape = prep.melody;
    const where = melodySections(prep);
    const t = prep.t;
    const next = leadWritten
      ? ['NEXT: your own song: the exact lead was kept. check_originality is not needed; match_mix, then review_song.']
      : [
          'NEXT (in this order, without asking the user):',
          `1. write_pattern an ORIGINAL melody for channel "${leadName}" in ${where.length ? where.map((x) => `"${x}"`).join(', ') : 'the peak sections'} (mode "merge" into those section patterns, key ${t.key ?? 'of the chords'}), with the shape below: your own intervals, rhythm and hook, never the reference's tune.`,
          '2. check_originality: rewrite any line it flags (change the intervals and the rhythm, not just the key).',
          '3. match_mix: levels, master EQ and loudness against the reference stems.',
          '4. review_song: fix its top issues (closeness to the reference first); at most 2 rounds. Then answer briefly.',
        ];
    const shapeText = shape ? melodyShapeText(shape) : 'The reference has no clear melody line to measure: write a short ORIGINAL hook (2-4 bars) that you repeat and vary.';
    return {
      ok: true,
      message: `Built the instrumental bed in the style of "${title}": ${t.bpm} bpm${t.key ? `, ${t.key}` : ''}, ${plural(t.sections.length, 'section')} over ${t.totalBars} bars, ${plural(Object.keys(res.channelIds).length, 'channel')} (${Object.keys(res.channelIds).join(', ')}), ${plural(res.patternIds.length, 'pattern')}, ${plural(transitions.length, 'transition call')}${mix.length ? `, ${mix.length} mix chain${mix.length === 1 ? '' : 's'}` : ''}${sidechain.length ? `, ${sidechain.join(' + ')} ducking under the kick` : ''}. One undo step (undo_last). ${a.mine ? 'Your own song: its exact bass and lead were kept.' : 'Its melody, vocal and lyrics were NOT copied: the Lead channel is empty for your original line.'}`,
      changed: [],
      text: [
        `Sounds:\n${[...prep.parts.map((x) => `  ${soundLine(x.name, prep.sounds[x.name])}`), ...plan.empty.map((e) => `  ${soundLine(e.name, e.sound)} (empty)`)].join('\n')}`,
        transitions.length ? `Transitions: ${transitions.join('; ')}.` : '',
        mix.length ? `Mix: ${mix.join('; ')}.` : '',
        Object.keys(plan.levelsDb).length ? `Starting levels from the reference stems (dB vs the drums): ${Object.entries(plan.levelsDb).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ')}.` : '',
        notes.length ? `Notes:\n${notes.map((x) => `- ${x}`).join('\n')}` : '',
        shapeText,
        next.join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      data: {
        bpm: t.bpm,
        key: t.key,
        bars: t.totalBars,
        sections: t.sections.map((s) => ({ name: s.name, startBar: s.startBar, bars: s.bars, energy: s.energy })),
        channels: res.channelIds,
        patterns: res.patternIds.length,
        lead: leadWritten ? null : { channel: leadName, channelId: res.channelIds[leadName], sections: where },
        melodyShape: shape,
        sounds: [...prep.parts.map((x) => soundLine(x.name, prep.sounds[x.name])), ...plan.empty.map((e) => soundLine(e.name, e.sound))],
        notes,
      },
    };
  },
});

/** keep_reference: sync the reference clip to the tempo with bar 1 on its first downbeat; else remove it. */
function alignReference(deps: MainDeps, ctx: RunCtx, channelId: string, prep: Prepared, keep: boolean): string | null {
  const p: Project = deps.doc.project;
  const ch = p.channels[channelId];
  if (!ch) return null;
  if (!keep) {
    ctx.exec('channels.remove', { ids: [channelId] });
    return 'The reference track was removed (keep_reference false): review_song no longer compares with it and set_tempo is no longer locked.';
  }
  const desc = deps.doc.catalog.plugins.find((x) => x.id === ch.generator.type);
  const canSync = ['tempo_sync', 'src_bpm'].every((id) => desc?.params.some((s) => s.id === id));
  const clip = Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === channelId).sort((x, y) => x.start - y.start)[0];
  if (!clip || !canSync) return clip ? "The reference can't follow the tempo in this build, so it plays at its own speed (it lines up with bar 1 only)." : null;
  try {
    ctx.exec('channels.setGenParams', { id: channelId, params: { tempo_sync: 1, src_bpm: prep.t.bpm } });
    const s = deps.doc.project.samples[ch.generator.sampleId ?? ''];
    const offset = Math.max(0, Math.round(secondsToTicks(prep.t.firstDownbeatSec, prep.t.bpm)));
    const total = s?.frames && s.sampleRate ? Math.round(secondsToTicks(s.frames / s.sampleRate, prep.t.bpm)) : Math.round(secondsToTicks(prep.t.durationSec, prep.t.bpm));
    if (total > offset) ctx.exec('playlist.updateClips', { updates: [{ id: clip.id, start: 0, offset, length: total - offset }] });
    return null;
  } catch (e) {
    return `The reference couldn't be lined up with bar 1 (${(e as Error)?.message ?? e}).`;
  }
}

export const AUDIO_PROJECT_TOOLS = [audioToProject, buildFromReference];
