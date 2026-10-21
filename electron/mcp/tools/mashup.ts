// auto_mashup (research/18-auto-mashup.md): two songs → one mashup in ONE
// call and one undo step, the same service as Home ▸ Audio Tools ▸ Auto
// Mashup (electron/mashup). dry_run = the check only (plan, score, reasons,
// suggestions, problems; no edits, no separation).

import { z } from 'zod';
import type { MainDeps } from '../types';
import type { MashupCheck, MashupOutcome, MashupPlanSummary, MashupRequest, MashupSource } from '@shared/mashup/types';
import { MASHUP_RIGHTS_NOTE } from '@shared/mashup/types';
import { toKeyRef } from '@shared/music/keymatch';
import { mashupFor } from '../../mashup';
import { defineTool, fail, type ToolCaller, type ToolResult } from './types';
import { agentSamplePath, looksLikePath, safeName } from './util';
import { findAudioClip } from './ears';

const zSide = z.enum(['a', 'b']).nullable();
const zFactor = z.union([z.literal(1), z.literal(0.5), z.literal(2)]);

/** A path → a file source (File access checked by callTool + agentSamplePath); else an audio clip / channel name. */
function sourceOf(deps: MainDeps, caller: ToolCaller, ref: string, which: string): MashupSource {
  const r = ref.trim();
  if (!r) fail(`${which} is empty: pass a file path or an audio clip / track name.`);
  if (looksLikePath(r)) {
    const { abs, docPath } = agentSamplePath(deps, r, caller);
    return { path: docPath.startsWith('factory:') ? docPath : abs };
  }
  return { clipId: findAudioClip(deps.doc.project, r).id };
}

function planLines(p: MashupPlanSummary, a: string, b: string): string {
  const who = p.style === 'vocalOverBeat' ? `${p.vocalFrom === 'b' ? b : a}'s vocal over ${p.vocalFrom === 'b' ? a : b}'s instrumental` : p.style === 'stemBlend' ? 'a blend of both songs\' stems' : 'the two songs trading sections';
  const shift = (n: string, s: { stretch: number; semitones: number }) => `${n} ×${s.stretch} length, ${s.semitones > 0 ? '+' : s.semitones < 0 ? '−' : ''}${Math.abs(s.semitones)} st`;
  return [
    `Plan: ${who}, ${p.bpm} bpm${p.key ? `, ${p.key}` : ''}, ${p.bars} bars (${shift('A', p.shiftA)}; ${shift('B', p.shiftB)}).`,
    `Sections: ${p.sections.map((s) => `${s.name} @${s.startBar} (${s.bars})`).join(', ')}.`,
  ].join('\n');
}

function checkText(c: MashupCheck): string {
  return [
    planLines(c.plan, `A ("${safeName(c.a.name, 40)}")`, `B ("${safeName(c.b.name, 40)}")`),
    `Fit: ${c.score}/100.\n${c.reasons.map((x) => `- ${x}`).join('\n')}`,
    c.suggestions.length ? `Suggestions:\n${c.suggestions.map((x) => `- ${x}`).join('\n')}` : '',
    c.problems.length ? `Problems (build refuses until fixed):\n${c.problems.map((x) => `- ${x}`).join('\n')}` : '',
    MASHUP_RIGHTS_NOTE,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function outcomeText(o: MashupOutcome): string {
  return [
    planLines(o.plan, 'A', 'B'),
    o.notes.length ? `Notes:\n${o.notes.map((x) => `- ${x}`).join('\n')}` : '',
    'Refine by hand: tune_vocal (another style), match_clip / stretch_clip, add_clip / remove_clips per section, set_mixer, add_transition, review_song. undo_last removes the whole mashup.',
    o.rightsNote,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const autoMashup = defineTool({
  name: 'auto_mashup',
  title: 'Make a mashup of two songs',
  kind: 'write',
  description:
    'USE THIS FIRST for a mashup: ONE call builds a mashup of two songs as one undo step, the same as Home ▸ Audio Tools ▸ Auto Mashup. a / b = an absolute audio file path (File access applies: with "Ask me" the user is asked first) or an audio clip / track name in the project. style: vocalOverBeat (default: the vocal of one on the drums + bass + other of the other; vocal_from "auto" picks the better way round), stemBlend (stems: which song gives each of vocals / drums / bass / other, null = leave out), backAndForth (the two songs trade 8 / 16-bar sections on one grid; no stem model needed). It reads both songs (tempo with half / double readings, key, sections, energy), separates the stems it needs (HT-Demucs, only when the user installed it: otherwise it refuses and says so), picks the shared tempo (least stretch; with no anchor, both meet half way when keeping the beat tempo would stretch the vocal audibly) and key (measured on the stems: the notes of the vocal stem against those of the bass + other stems, shifted to fit best; key labels only when the stems were not read), matches levels (every song at the same loudness), maps the vocal\'s hook onto the bed\'s highest-energy sections on 4 / 8-bar phrases with an instrumental intro, break and outro, warps every track to the grid (tones for vocals, beats for drums), adds the vocal chain (light EQ + compression for a finished vocal, Krypt Tune only when tune is set, reverb / delay sends), ducks the bed under the vocal, a master chain, markers and transitions at the boundaries. new_project true (default) opens the mashup in a NEW project tab (the open project stays as it is); false adds it on new tracks. dry_run true = only the check: the plan, a 0..100 fit score with reasons, suggestions and blocking problems, nothing edited. Then refine by hand. Example: {"a":"C:\\\\Music\\\\vocal song.mp3","b":"C:\\\\Music\\\\beat song.wav"} · {"a":"Song A","b":"Song B","style":"backAndForth","dry_run":true}',
  input: z.object({
    a: z.string().min(1).max(400).describe('Song A: an absolute audio file path, or an audio clip / track name in the project.'),
    b: z.string().min(1).max(400).describe('Song B: same as a.'),
    style: z.enum(['vocalOverBeat', 'stemBlend', 'backAndForth']).default('vocalOverBeat'),
    vocal_from: z.enum(['a', 'b', 'auto']).default('auto').describe('vocalOverBeat: which song gives the vocal.'),
    stems: z.object({ vocals: zSide, drums: zSide, bass: zSide, other: zSide }).optional().describe('stemBlend: the song each stem comes from ("a" / "b"), null = leave it out.'),
    anchor: z.enum(['beat', 'vocal', 'middle']).optional().describe('Who keeps its tempo and key: beat (the instrumental), vocal, or middle (both move about half way). Omitted: the beat keeps its key, and the tempo meets half way when the beat tempo would stretch the vocal audibly.'),
    bpm: z.number().min(40).max(300).optional().describe('Force the mashup tempo.'),
    key: z.string().max(32).optional().describe('Force the mashup key, e.g. "F#m".'),
    factor_a: zFactor.optional().describe('Tempo reading of A: 1 as detected, 0.5 half time, 2 double time (default: the one that stretches least).'),
    factor_b: zFactor.optional(),
    tune: z.enum(['off', 'natural', 'pop', 'hard']).optional().describe('Krypt Tune on the vocal (default off: a finished vocal is already in tune and the shift puts it in the key; tuning to a scale can bend the singer runs).'),
    bars: z.number().int().min(8).max(512).optional().describe('Target length in bars (default: the instrumental, at most 128).'),
    new_project: z.boolean().default(true),
    transitions: z.boolean().default(true).describe('Transitions at the section boundaries.'),
    dry_run: z.boolean().default(false).describe('Only check: plan, score, reasons, suggestions; nothing is edited or separated.'),
    change_label: z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel."),
  }),
  summarize: (a) => `${safeName(a.a.split(/[\\/]/).pop() ?? a.a, 30)} × ${safeName(a.b.split(/[\\/]/).pop() ?? a.b, 30)}${a.dry_run ? ' (check)' : ''}`,
  paths: (a) => [a.a, a.b].filter((x) => looksLikePath(x)).map((value) => ({ value, kind: 'audio' as const })),
  // dry_run edits nothing, and a new project is a reset (no patches of this call's own): never a "No change".
  readsWhenUnchanged: true,
  async run(deps, caller, a, ctx): Promise<ToolResult> {
    if (!deps.analyzer) fail("Audio analysis isn't available in this session (the analyzer didn't start; see the Krypt Studio log), so the songs can't be read.");
    if (a.key?.trim() && !toKeyRef(a.key.trim())) fail(`"${safeName(a.key, 32)}" isn't a major or minor key (e.g. "F#m", "Eb", "A minor").`);
    const req: MashupRequest = {
      a: sourceOf(deps, caller, a.a, 'a'),
      b: sourceOf(deps, caller, a.b, 'b'),
      style: a.style,
      vocalFrom: a.vocal_from,
      ...(a.stems ? { stems: a.stems } : {}),
      ...(a.anchor ? { anchor: a.anchor } : {}),
      ...(a.bpm ? { bpm: a.bpm } : {}),
      ...(a.key?.trim() ? { key: a.key.trim() } : {}),
      ...(a.factor_a ? { factorA: a.factor_a } : {}),
      ...(a.factor_b ? { factorB: a.factor_b } : {}),
      ...(a.tune ? { tune: a.tune } : {}),
      ...(a.bars ? { bars: a.bars } : {}),
      newProject: a.new_project,
      transitions: a.transitions,
    };
    const svc = mashupFor(deps);
    const run = { signal: ctx.signal, progress: ctx.progress ? (p: { fraction: number; message: string }) => ctx.progress!(p.fraction, p.message) : undefined };
    if (a.dry_run) {
      const r = await svc.check(req, run);
      if (!r.ok || !r.data) fail(r.message ?? 'The check failed');
      return { ok: true, message: `Checked, nothing changed: ${r.message}`, changed: [], text: checkText(r.data), data: r.data };
    }
    if (a.new_project) {
      if (deps.project.status().dirty && !deps.project.opensNewTabs?.()) fail('The open project has unsaved changes. Save or close it first, or pass new_project: false to add the mashup to this project.');
      if (!deps.project.newProject) fail("A new project can't be opened from this session; pass new_project: false.");
      if (caller.session.group) fail(`A new project can't open inside the edit group "${safeName(caller.session.group.label, 60)}": commit_edit first, or pass new_project: false.`);
    }
    const r = await svc.build(req, a.new_project ? { kind: 'new', actor: caller.actor } : { kind: 'current', actor: caller.actor, ctx }, run);
    if (!r.ok || !r.data) fail(r.message ?? 'The mashup failed');
    return { ok: true, message: r.message ?? 'Mashup built', changed: [], text: outcomeText(r.data), data: r.data };
  },
});

export const MASHUP_TOOLS = [autoMashup];
