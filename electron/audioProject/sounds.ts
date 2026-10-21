import fs from 'node:fs';
import type { MainDeps } from '../mcp/types';
import type { GenreId } from '@shared/sounds/genres';
import type { InstrumentPreset, InstrumentRole, Preset } from '@shared/sounds/types';
import type { MatchTarget, SoundFingerprint, SoundMatch } from '@shared/sound-match/types';
import type { TranscribedPart } from '@shared/transcription/types';
import { roleFromName } from '@shared/sounds/select';
import { DRUM_ROLES } from '../analyzer/convert';
import { bestDrumSample, bestPreset, presetPlayable, soundLibrary, SYNTH_PRESETS } from '../mcp/tools/instruments';
import type { PartSound } from './build';

export type SoundMatcher = (fps: SoundFingerprint[], target: MatchTarget) => Promise<{ ok: true; matches: SoundMatch[] } | { ok: false; problem: string }>;

export function partRole(part: Pick<TranscribedPart, 'kind' | 'name' | 'drumRole'>): InstrumentRole {
  if (part.kind === 'drum') return (part.drumRole ?? roleFromName(part.name) ?? 'perc') as InstrumentRole;
  const named = roleFromName(part.name);
  if (part.kind === 'bass') return named === '808' || named === 'sub' ? named : 'bass';
  if (part.kind === 'lead') return named && ['lead', 'pluck', 'bell', 'arp', 'vox'].includes(named) ? named : 'lead';
  return named && ['pad', 'keys', 'piano', 'chord', 'strings', 'stab', 'pluck'].includes(named) ? named : 'chord';
}

export function matchTarget(part: Pick<TranscribedPart, 'kind' | 'name' | 'drumRole'>): MatchTarget {
  const role = partRole(part);
  if (part.kind === 'drum') {
    const r = role === 'clap' ? 'clap' : role === 'kick' || role === 'snare' || role === 'hat' || role === 'openhat' ? role : 'perc';
    return { kind: 'drum', role: r };
  }
  return { kind: 'instrument', role };
}

export function fallbackSound(deps: MainDeps, presets: readonly Preset[], part: Pick<TranscribedPart, 'kind' | 'name' | 'drumRole'>, genre: GenreId | null): PartSound {
  const role = partRole(part);
  if (part.kind === 'drum') {
    const lib = safeLibrary(deps);
    const s = bestDrumSample(deps, lib.index, role, genre, part.name);
    if (s) return { load: { kind: 'sample', path: s.path }, label: s.name, role, similarity: null, tweaks: {}, why: [`picked for ${role}${genre ? ` in ${genre}` : ''} (no sound fingerprints to compare)`] };
    const d = DRUM_ROLES.find((x) => x.role === (role === 'clap' ? 'snare' : role)) ?? DRUM_ROLES.find((x) => x.role === 'perc')!;
    if (sampleExists(deps, d.sample)) return { load: { kind: 'sample', path: d.sample }, label: `factory ${d.name.toLowerCase()}`, role, similarity: null, tweaks: {}, why: ['the factory kit (no sample index installed)'] };
    return { load: { kind: 'drumsynth', voice: d.voice }, label: `DrumSynth ${d.name.toLowerCase()}`, role, similarity: null, tweaks: {}, why: ['a DrumSynth voice (the factory kit is missing)'] };
  }
  const p = bestPreset(deps, presets, role, genre, undefined, part.name) ?? (role === 'chord' ? bestPreset(deps, presets, 'keys', genre) : null);
  if (p) return { load: { kind: 'preset', preset: p }, label: p.name, role, similarity: null, tweaks: {}, why: [`preset for ${role}${genre ? ` in ${genre}` : ''} (no sound fingerprints to compare)`] };
  const synth = SYNTH_PRESETS.find((s) => s.match.test(`${role} ${part.name}`.toLowerCase()));
  return { load: { kind: 'synth', params: synth?.params }, label: synth?.label ?? 'TriOsc', role, similarity: null, tweaks: {}, why: ['a TriOsc patch (no presets installed)'] };
}

function safeLibrary(deps: MainDeps): ReturnType<typeof soundLibrary> {
  try {
    return soundLibrary(deps);
  } catch {
    return { presets: [], index: null };
  }
}

function sampleExists(deps: MainDeps, p: string): boolean {
  try {
    return fs.existsSync(deps.project.resolveSamplePath(p));
  } catch {
    return false;
  }
}

export function soundFromMatch(deps: MainDeps, presets: readonly Preset[], m: SoundMatch, role: InstrumentRole): PartSound | null {
  const src = m.source;
  if (src.kind === 'preset') {
    const p = presets.find((x): x is InstrumentPreset => x.kind === 'instrument' && x.id === src.id);
    if (!p || !presetPlayable(deps, p)) return null;
    return { load: { kind: 'preset', preset: p }, label: p.name, role, similarity: m.similarity, tweaks: { ...m.tweaks }, why: m.why };
  }
  if (!sampleExists(deps, src.path)) return null;
  const label = src.path.split(/[\\/:]/).pop()?.replace(/\.[a-z0-9]+$/i, '') ?? src.path;
  return { load: { kind: 'sample', path: src.path }, label, role, similarity: m.similarity, tweaks: { ...m.tweaks }, why: m.why };
}

export function bestMatch(deps: MainDeps, presets: readonly Preset[], matches: readonly SoundMatch[], role: InstrumentRole): PartSound | null {
  for (const m of [...matches].sort((a, b) => b.similarity - a.similarity)) {
    const s = soundFromMatch(deps, presets, m, role);
    if (s) return s;
  }
  return null;
}

export function soundLine(name: string, s: PartSound): string {
  return `${name} → ${s.label} (${s.similarity !== null ? `similarity ${Math.round(s.similarity * 100) / 100}` : 'picked by role'})`;
}

export function libraryPresets(deps: MainDeps): readonly Preset[] {
  return safeLibrary(deps).presets;
}
