// get_playbook's recipe (owned by craft-tools): a genre playbook
// (shared/playbooks) turned into a step-by-step build for THIS project:
// the chosen tempo / key / swing, each part with a RESOLVED sound (a preset,
// or for drums the best factory sample), the KPN starting points, the
// arrangement in absolute bars, transitions per boundary, the mix plan with
// resolved chain presets, the mistakes, the targets review_song checks, and
// a numbered BUILD ORDER of exact tool calls. Pure (no I/O): craft.ts feeds
// it the presets, the factory index, the project's channel names and the
// library focus. research/10-sound-and-craft.md.

import type { Playbook, PlaybookPart, PlaybookSection, PlaybookTargets, SectionKind, TransitionKind } from '@shared/playbooks/types';
import type { ChainPreset, ChainRole, FactorySample, InstrumentPreset, Preset, SampleKind } from '@shared/sounds/types';
import { rankPresets, rankSamples } from '@shared/sounds/select';
import { genreInText, genreInfo, resolveGenre, type GenreId } from '@shared/sounds/genres';
import type { StyleProfile } from '@shared/library/types';
import { parseKey } from '@shared/music/theory';
import { GROOVE_IDS } from '@shared/grooves/apply';
import type { AdaptedPlaybook, ReferenceBrief } from '@shared/reference';
import { feelLine, FEEL_ROLES } from '@shared/reference';

// ── Genre ───────────────────────────────────────────────────────────────

export type GenreSource = 'argument' | 'project' | 'brief' | 'reference' | 'focus';

export interface GenreChoice {
  id: GenreId | null;
  source: GenreSource | null;
  /** What was asked for when it isn't a genre Krypt Studio knows ("polka"). */
  unknown: string | null;
}

/** A genre id from a name, an alias or free text ("dark uk drill" → drill). */
export function genreFrom(text: string | null | undefined): GenreId | null {
  if (!text?.trim()) return null;
  return resolveGenre(text) ?? genreInText(text);
}

/** The argument, else the project's genre, else the brief, else the reference song's closest genre, else the library focus (its name and brief). */
export function chooseGenre(input: { arg?: string | null; projectGenre?: string | null; brief?: string | null; referenceGenre?: string | null; focusText?: string | null }): GenreChoice {
  if (input.arg?.trim()) {
    const id = genreFrom(input.arg);
    return id ? { id, source: 'argument', unknown: null } : { id: null, source: 'argument', unknown: input.arg.trim().slice(0, 40) };
  }
  const tries: Array<[GenreSource, string | null | undefined]> = [
    ['project', input.projectGenre],
    ['brief', input.brief],
    ['reference', input.referenceGenre],
    ['focus', input.focusText],
  ];
  for (const [source, text] of tries) {
    const id = genreFrom(text);
    if (id) return { id, source, unknown: null };
  }
  return { id: null, source: null, unknown: null };
}

export const SOURCE_WORDS: Record<GenreSource, string> = {
  argument: 'as asked',
  project: "from the project's genre",
  brief: 'from your brief',
  reference: "the reference song's closest genre",
  focus: 'from the library focus',
};

// ── The user's own references (library style focus) ─────────────────────

/** The numbers of a style focus that override the playbook ("your references say …"). */
export interface FocusNumbers {
  name: string;
  analysed: number;
  bpm: number | null;
  bpmRange: [number, number] | null;
  swingPercent: number | null;
  keys: string[];
  progressions: string[];
  sectionBars: number | null;
  forms: string[];
  lufs: number | null;
}

export function focusNumbers(name: string, p: StyleProfile): FocusNumbers | null {
  if (!p.analysed) return null;
  const f: FocusNumbers = {
    name,
    analysed: p.analysed,
    bpm: p.tempo ? Math.round(p.tempo.bpm.median) : null,
    bpmRange: p.tempo ? [Math.round(p.tempo.bpm.p25), Math.round(p.tempo.bpm.p75)] : null,
    swingPercent: p.swing ? (p.swing.median < 0.1 && p.swing.share < 0.3 ? 0 : Math.round(Math.min(1, p.swing.median) * 100)) : null,
    keys: p.keys?.top.slice(0, 3).map((k) => k.key) ?? [],
    progressions: p.harmony?.progressions.slice(0, 3).map((x) => x.degrees.join(' ')) ?? [],
    sectionBars: p.structure && p.structure.sectionBars.median > 0 ? Math.round(p.structure.sectionBars.median) : null,
    forms: p.structure?.forms.slice(0, 2).map((x) => x.form.join(' ')) ?? [],
    lufs: p.mix && Number.isFinite(p.mix.lufs.median) ? Math.round(p.mix.lufs.median * 10) / 10 : null,
  };
  return f;
}

/** "at 140 bpm" and "in F#m" / "F#m" from the user's words. */
export function briefNumbers(brief: string | null | undefined): { bpm: number | null; key: string | null } {
  const t = brief ?? '';
  const b = /\b(\d{2,3}(?:\.\d+)?)\s*bpm\b/i.exec(t);
  const bpm = b && Number(b[1]) >= 40 && Number(b[1]) <= 250 ? Math.round(Number(b[1])) : null;
  let key: string | null = null;
  const inKey = /\bin\s+([A-G][#b]?(?:\s?(?:minor|major|min|maj|m))?)(?![A-Za-z#])/.exec(t);
  if (inKey && parseKey(inKey[1])) key = inKey[1].replace(/\s+/g, ' ');
  if (!key) {
    const tok = t.split(/[\s,;]+/).find((w) => /^[A-G][#b]?m$/.test(w) && parseKey(w));
    if (tok) key = tok;
  }
  return { bpm, key };
}

// ── Groove (transform_notes op "groove": real drummers' timing and accents) ─

export interface GroovePlan {
  template: string;
  /** Timing 0..1 of the template's offsets. */
  amount: number;
  /** 0..1: how strongly its accents shape velocities. */
  velocity: number;
  /** Also groove the bass and keys / chords (genres that swing). */
  melodic: boolean;
  /** The playbook's own list of parts to groove (e.g. only the hats in trap), when it gives one. */
  parts?: string[];
  source: 'playbook' | 'genre';
}

/** Per-genre starting points when the playbook names no groove. */
const GENRE_GROOVE: Partial<Record<GenreId, Omit<GroovePlan, 'source'>>> = {
  'boom-bap': { template: 'hiphop', amount: 0.8, velocity: 0.6, melodic: true },
  lofi: { template: 'hiphop', amount: 0.9, velocity: 0.6, melodic: true },
  trap: { template: 'hiphop', amount: 0.3, velocity: 0.5, melodic: false },
  drill: { template: 'hiphop', amount: 0.3, velocity: 0.5, melodic: false },
  phonk: { template: 'hiphop', amount: 0.4, velocity: 0.5, melodic: false },
  rnb: { template: 'soul', amount: 0.7, velocity: 0.5, melodic: true },
  pop: { template: 'pop', amount: 0.4, velocity: 0.4, melodic: false },
  afrobeats: { template: 'afrobeat', amount: 0.7, velocity: 0.6, melodic: true },
  reggaeton: { template: 'latin', amount: 0.4, velocity: 0.5, melodic: false },
  house: { template: 'dance', amount: 0.5, velocity: 0.5, melodic: false },
  'deep-house': { template: 'dance', amount: 0.6, velocity: 0.5, melodic: true },
  'tech-house': { template: 'dance', amount: 0.5, velocity: 0.5, melodic: false },
  techno: { template: 'dance', amount: 0.3, velocity: 0.4, melodic: false },
  edm: { template: 'dance', amount: 0.25, velocity: 0.4, melodic: false },
  'future-bass': { template: 'pop', amount: 0.3, velocity: 0.4, melodic: false },
  dubstep: { template: 'hiphop', amount: 0.25, velocity: 0.4, melodic: false },
  dnb: { template: 'funk', amount: 0.4, velocity: 0.5, melodic: false },
  synthwave: { template: 'pop', amount: 0.3, velocity: 0.4, melodic: false },
};

const unit = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : d);

const DRUM_ROLES = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc', 'tom']);

/**
 * The groove to apply: the playbook's own (its optional `groove` field: {template, amount, velocity, parts}, or
 * just a template id), else the genre's starting point. Only templates that exist are returned.
 */
export function grooveFor(pb: Playbook | null, genre: GenreId | null): GroovePlan | null {
  const raw = pb ? (pb as unknown as { groove?: unknown }).groove : undefined;
  const swings = !!pb && pb.swing >= 15;
  if (typeof raw === 'string' && GROOVE_IDS.includes(raw)) return { template: raw, amount: 0.6, velocity: 0.5, melodic: swings, source: 'playbook' };
  if (raw && typeof raw === 'object') {
    const g = raw as { template?: unknown; amount?: unknown; velocity?: unknown; melodic?: unknown; parts?: unknown };
    if (typeof g.template === 'string' && GROOVE_IDS.includes(g.template)) {
      const parts = Array.isArray(g.parts) ? g.parts.filter((x): x is string => typeof x === 'string' && !!x.trim()) : undefined;
      const melodicPart = !!parts && !!pb && parts.some((n) => {
        const part = pb.parts.find((x) => x.name === n);
        return !!part && !DRUM_ROLES.has(part.role) && !part.sample;
      });
      return {
        template: g.template,
        amount: unit(g.amount, 0.6),
        velocity: unit(g.velocity, 0.5),
        melodic: typeof g.melodic === 'boolean' ? g.melodic : parts?.length ? melodicPart : swings,
        ...(parts?.length ? { parts } : {}),
        source: 'playbook',
      };
    }
  }
  const d = genre ? GENRE_GROOVE[genre] : undefined;
  if (d && GROOVE_IDS.includes(d.template)) return { ...d, melodic: d.melodic || swings, source: 'genre' };
  return null;
}

// ── Sounds ──────────────────────────────────────────────────────────────

export interface ResolvedSound {
  kind: 'sample' | 'preset' | 'none';
  /** Preset id ('factory:lead/…') for presets; the sample path for samples. */
  ref: string | null;
  name: string | null;
  /** Instrument plugin of a preset. */
  plugin?: string;
  /** The preset brings its own insert chain. */
  hasFx?: boolean;
}

/** Older kit paths every install has, by sample kind (the fallback when the factory index is missing). */
const LEGACY_KIT: Partial<Record<SampleKind, string>> = {
  kick: 'factory:drums/kick.wav',
  snare: 'factory:drums/snare.wav',
  clap: 'factory:drums/clap.wav',
  hat: 'factory:drums/hat-closed.wav',
  openhat: 'factory:drums/hat-open.wav',
  crash: 'factory:drums/crash.wav',
  perc: 'factory:drums/perc.wav',
  rim: 'factory:drums/rim.wav',
  tom: 'factory:drums/tom.wav',
  '808': 'factory:drums/808.wav',
};

function instrumentPresets(presets: readonly Preset[]): InstrumentPreset[] {
  return presets.filter((p): p is InstrumentPreset => p.kind === 'instrument');
}

function chainPresets(presets: readonly Preset[]): ChainPreset[] {
  return presets.filter((p): p is ChainPreset => p.kind === 'chain');
}

/** How get_playbook picks sounds in the app: the same helpers load_preset and write_pattern use (instruments.ts). */
export interface SoundPicker {
  /** Best factory drum sample for a part, or null. */
  drum(part: PlaybookPart, genre: GenreId | null): FactorySample | null;
  /** Best playable instrument preset for a part, or null. */
  preset(part: PlaybookPart, genre: GenreId | null): InstrumentPreset | null;
}

/** The pure fallback picker (rankSamples / rankPresets), for callers without the app's sound library. */
export function plainPicker(presets: readonly Preset[], samples: readonly FactorySample[] | null): SoundPicker {
  return {
    drum: (part, genre) => (part.sample && samples?.length ? (rankSamples(samples, { kind: part.sample, genre: genre ?? undefined, tags: part.tags }, 1)[0] ?? null) : null),
    // Without the app's sound library nothing says a sound pack is installed: pack presets (requires) are skipped.
    preset: (part, genre) => rankPresets(instrumentPresets(presets).filter((p) => !p.requires), { role: part.role, kind: 'instrument', genre: genre ?? undefined, tags: part.tags }, 1)[0] ?? null,
  };
}

/** The legacy kit file for a part (every install has it): by its sample kind, else its role (an 808 part → 808.wav). */
function legacyFor(part: Pick<PlaybookPart, 'role' | 'sample'>): string | undefined {
  return (part.sample ? LEGACY_KIT[part.sample] : undefined) ?? LEGACY_KIT[part.role as SampleKind];
}

/** The sound a part gets: drums with a sample kind → the best factory sample; else the best preset for its role; else the legacy kit. */
export function resolvePart(part: PlaybookPart, genre: GenreId | null, pick: SoundPicker): ResolvedSound {
  if (part.sample) {
    const s = pick.drum(part, genre);
    if (s) return { kind: 'sample', ref: s.path, name: s.name };
  }
  const p = pick.preset(part, genre);
  if (p) return { kind: 'preset', ref: p.id, name: p.name, plugin: p.plugin, hasFx: !!p.fx?.length };
  const legacy = legacyFor(part);
  if (legacy) return { kind: 'sample', ref: legacy, name: legacy.split('/').pop()!.replace(/\.wav$/, '') };
  return { kind: 'none', ref: null, name: null };
}

export function resolveChain(role: ChainRole, genre: GenreId | null, presets: readonly Preset[], tags?: string[]): ChainPreset | null {
  return rankPresets(chainPresets(presets), { role, kind: 'chain', genre: genre ?? undefined, tags }, 1)[0] ?? null;
}

// ── Arrangement ─────────────────────────────────────────────────────────

export interface PlacedSection extends PlaybookSection {
  /** 1-based first bar. */
  start: number;
  /** 1-based last bar (inclusive). */
  end: number;
  /** Unique display label (duplicates get a number). */
  name: string;
}

/** Sections laid end to end from bar 1. */
export function placeSections(sections: readonly PlaybookSection[]): PlacedSection[] {
  const out: PlacedSection[] = [];
  const seen = new Map<string, number>();
  let bar = 1;
  for (const s of sections) {
    const bars = Math.max(1, Math.round(s.bars));
    const base = (s.label || s.kind).trim().slice(0, 40) || s.kind;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    out.push({ ...s, bars, start: bar, end: bar + bars - 1, name: n > 1 ? `${base} ${n}` : base });
    bar += bars;
  }
  return out;
}

/** Default length (bars) of a transition kind leading into a section, given the section before it. */
export function transitionLength(kind: TransitionKind | string, prevBars: number): number | undefined {
  switch (kind) {
    case 'riser':
    case 'filter-sweep':
      return Math.max(1, Math.min(8, prevBars));
    case 'snare-roll':
      return Math.max(1, Math.min(4, prevBars));
    case 'drum-fill':
      return 1;
    case 'swell':
      return Math.max(1, Math.min(2, prevBars));
    default:
      return undefined;
  }
}

export interface BoundaryPlan {
  /** 1-based bar the next section starts on. */
  at: number;
  from: string;
  to: string;
  kinds: TransitionKind[];
}

export function boundaries(sections: readonly PlacedSection[]): BoundaryPlan[] {
  const out: BoundaryPlan[] = [];
  for (let i = 1; i < sections.length; i++) out.push({ at: sections[i].start, from: sections[i - 1].name, to: sections[i].name, kinds: [...(sections[i].transitionIn ?? [])] });
  return out;
}

/** add_transition calls for the boundaries, one per kind + length (several bars per call). */
export function transitionCalls(sections: readonly PlacedSection[]): Array<{ kind: string; at_bars: number[]; length_bars?: number }> {
  const byKey = new Map<string, { kind: string; at_bars: number[]; length_bars?: number }>();
  for (let i = 1; i < sections.length; i++) {
    for (const kind of sections[i].transitionIn ?? []) {
      const len = transitionLength(kind, sections[i - 1].bars);
      const key = `${kind}|${len ?? ''}`;
      const call = byKey.get(key) ?? { kind, at_bars: [], ...(len !== undefined ? { length_bars: len } : {}) };
      call.at_bars.push(sections[i].start);
      byKey.set(key, call);
    }
  }
  return [...byKey.values()];
}

// ── Generic recipe (no playbook for the genre yet) ──────────────────────

/** review_song's targets when no playbook applies. */
export const GENERIC_TARGETS: PlaybookTargets = {
  lufs: -10,
  truePeakDb: -1,
  bars: [48, 160],
  bands: { sub: [-10, 9], low: [-3, 12], lowMid: [-9, 5], highMid: [-13, 3], high: [-24, -1] },
  contrastLu: [3, 12],
  minCorrelation: 0.1,
  maxStaticBars: 16,
  minHatVelocitySpread: 5,
};

/** Relative energy of a section kind when no playbook says (review_song's energy-shape check). */
export const KIND_ENERGY: Record<SectionKind, number> = {
  intro: 0.3,
  verse: 0.55,
  pre: 0.65,
  build: 0.7,
  hook: 1,
  chorus: 1,
  drop: 1,
  breakdown: 0.4,
  bridge: 0.45,
  break: 0.4,
  outro: 0.35,
};

/** A plain, genre-neutral song plan for genres without a playbook (wording marks it as generic). */
export function genericPlaybook(genre: GenreId | null): Playbook {
  const name = genre ? genreInfo(genre).name : 'Song';
  return {
    id: genre ?? 'pop',
    name: `${name} (generic recipe)`,
    summary: `No ${genre ? `${name} ` : ''}playbook is installed${genre ? '' : ' for this request'}, so this is a generic, finished-song plan: use your own knowledge of ${genre ? `${name}'s` : 'the genre\'s'} tempo, drum idioms, bass and harmony inside it.`,
    bpm: { min: 70, max: 175, typical: 120 },
    swing: 0,
    keys: { modes: ['minor', 'major'], common: ['Am'], notes: 'pick a key that suits the mood' },
    harmony: { progressions: ['i VI III VII', 'vi IV I V'], rhythm: 'one chord per bar, or two per bar in the hook', voicing: 'close voicings in octave 3-4, bass on the root in octave 1-2' },
    melody: 'a short hook (2-4 bars) you repeat and vary; leave space between phrases',
    parts: [
      { name: 'Kick', role: 'kick', sample: 'kick', writing: "the genre's kick pattern; leave room for the bass", bus: 'Drum Bus' },
      { name: 'Clap', role: 'clap', sample: 'clap', writing: 'backbeat (2 and 4, or 3 in half-time) with a ghost or flam now and then', bus: 'Drum Bus' },
      { name: 'Hat', role: 'hat', sample: 'hat', writing: '8ths or 16ths with velocity accents (never all the same velocity), rolls into phrase ends', bus: 'Drum Bus' },
      { name: 'Bass', role: 'bass', writing: 'roots of the chords locked to the kick, octave 1-2', duckUnder: 'Kick' },
      { name: 'Chords', role: 'chord', writing: 'the progression, voiced in octave 3-4', duckUnder: 'Kick' },
      { name: 'Lead', role: 'lead', writing: 'the hook, from the hook section on' },
      { name: 'Pad', role: 'pad', writing: 'long notes under the intro and the breaks', duckUnder: 'Kick' },
    ],
    patterns: [],
    arrangement: [
      { kind: 'intro', label: 'Intro', bars: 8, energy: 0.3, parts: ['Pad', 'Chords', 'Hat'] },
      { kind: 'verse', label: 'Verse', bars: 16, energy: 0.55, parts: ['Kick', 'Clap', 'Hat', 'Bass', 'Chords'], transitionIn: ['crash'] },
      { kind: 'build', label: 'Build', bars: 8, energy: 0.7, parts: ['Clap', 'Hat', 'Chords', 'Pad'], transitionIn: ['drum-fill'] },
      { kind: 'hook', label: 'Hook', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'Bass', 'Chords', 'Lead'], transitionIn: ['riser', 'impact'] },
      { kind: 'break', label: 'Break', bars: 8, energy: 0.4, parts: ['Pad', 'Chords', 'Lead'], transitionIn: ['downlifter'] },
      { kind: 'build', label: 'Build', bars: 8, energy: 0.7, parts: ['Clap', 'Hat', 'Chords', 'Pad', 'Lead'], transitionIn: ['filter-sweep'] },
      { kind: 'hook', label: 'Hook', bars: 16, energy: 1, parts: ['Kick', 'Clap', 'Hat', 'Bass', 'Chords', 'Lead', 'Pad'], transitionIn: ['riser', 'snare-roll', 'impact'] },
      { kind: 'outro', label: 'Outro', bars: 8, energy: 0.35, parts: ['Pad', 'Chords', 'Hat'], transitionIn: ['crash'] },
    ],
    mix: {
      master: { tags: [] },
      buses: [{ name: 'Drum Bus', chain: 'drumBus' }],
      sends: [{ name: 'Reverb', chain: 'reverbSend', from: [{ part: 'Lead', amount: 0.25 }, { part: 'Pad', amount: 0.3 }, { part: 'Chords', amount: 0.15 }] }],
      levels: 'kick and bass loudest and centred; clap about 2 dB under the kick; chords and pad under the lead; hats tucked in.',
    },
    transitions: 'Something happens at every section change: a fill or snare roll in the bar before, a riser, whoosh, swell or filter sweep into the hook, an impact or crash on its downbeat, a downlifter or tape-stop into the break.',
    mistakes: ['The same 8 bars everywhere: vary every section', 'Every hit at the same velocity', 'No transition into the hook', 'Kick and bass fighting (no sidechain)', 'A quiet, unmastered master'],
    targets: GENERIC_TARGETS,
  };
}

// ── The recipe ──────────────────────────────────────────────────────────

export interface RecipeContext {
  genre: GenreId | null;
  source: GenreSource | null;
  /** Instrument + chain presets (factory and the user's). */
  presets: readonly Preset[];
  /** The factory sample index's samples, or null when it isn't installed. */
  samples: readonly FactorySample[] | null;
  /** How sounds are picked (the app passes the helpers load_preset uses); default: plainPicker over presets / samples. */
  picker?: SoundPicker;
  /** Channel names already in the project (load into them instead of making duplicates). */
  channels: readonly string[];
  /** Mixer insert names already in the project (bus / send inserts to reuse). */
  inserts?: readonly string[];
  projectBpm: number;
  projectSwing: number;
  brief?: string;
  focus?: FocusNumbers | null;
  /**
   * A reference song the build follows (study_reference): the playbook passed in is already adapted to it
   * (adaptPlaybook: tempo, key, swing, sections, targets); this adds its numbers and drum feel to the text.
   */
  reference?: { brief: ReferenceBrief; adapted: AdaptedPlaybook; track: string | null } | null;
  /** True when the playbook is the generic fallback. */
  generic?: boolean;
}

export interface Recipe {
  genre: GenreId | null;
  playbook: string;
  generic: boolean;
  bpm: number;
  key: string;
  swing: number;
  parts: Array<{ name: string; role: string; sound: ResolvedSound; chain: { id: string; name: string } | null; bus?: string; duckUnder?: string }>;
  sections: Array<{ name: string; kind: SectionKind; start: number; end: number; bars: number; energy: number; parts: string[]; transitionIn: TransitionKind[] }>;
  totalBars: number;
  transitions: Array<{ kind: string; at_bars: number[]; length_bars?: number }>;
  master: { id: string; name: string; targetLufs?: number } | null;
  groove: GroovePlan | null;
  targets: PlaybookTargets;
  focus: FocusNumbers | null;
  reference: { name: string; track: string | null; arrangement: AdaptedPlaybook['arrangement'] } | null;
  text: string;
}

const j = (v: unknown): string => JSON.stringify(v);

function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Which octave reading of a reference tempo suits the playbook (half / double time is the same pulse). */
function focusBpm(pb: Playbook, bpm: number): number {
  const cands = [bpm, bpm * 2, bpm / 2].filter((b) => b >= 40 && b <= 250);
  const best = cands.reduce((a, b) => (Math.abs(Math.log2(b / pb.bpm.typical)) < Math.abs(Math.log2(a / pb.bpm.typical)) ? b : a), bpm);
  return Math.round(best);
}

function fmtRange(r: [number, number] | undefined): string {
  return r ? `${r[0] > 0 ? '+' : ''}${r[0]}..${r[1] > 0 ? '+' : ''}${r[1]}` : '';
}

export function targetsLine(t: PlaybookTargets): string {
  const parts = [`${t.lufs} LUFS integrated`, `true peak <= ${t.truePeakDb} dBTP`, `${t.bars[0]}-${t.bars[1]} bars`];
  if (t.contrastLu) parts.push(`section contrast ${t.contrastLu[0]}-${t.contrastLu[1]} LU`);
  if (t.minCorrelation !== undefined) parts.push(`stereo correlation >= ${t.minCorrelation}`);
  if (t.maxStaticBars !== undefined) parts.push(`no identical content for more than ${t.maxStaticBars} bars`);
  if (t.minHatVelocitySpread !== undefined) parts.push(`hat velocity spread >= ${t.minHatVelocitySpread}`);
  if (t.bands) {
    const b = Object.entries(t.bands)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${fmtRange(v as [number, number])}`);
    if (b.length) parts.push(`bands vs mids (dB): ${b.join(', ')}`);
  }
  return parts.join(' · ');
}

/** Turn a playbook into the build for this project. */
export function buildRecipe(pb: Playbook, ctx: RecipeContext): Recipe {
  const genre = ctx.genre;
  const focus = ctx.focus ?? null;
  const ref = ctx.reference ?? null;
  const brief = briefNumbers(ctx.brief);
  const generic = !!ctx.generic;

  // Tempo, key, swing: the user's words win, then the reference song, then their style focus, then the playbook.
  let bpm = pb.bpm.typical;
  let bpmWhy = `playbook typical, range ${pb.bpm.min}-${pb.bpm.max}`;
  if (ref) {
    bpm = ref.adapted.bpm;
    bpmWhy = ref.adapted.bpmWhy;
  } else if (focus?.bpm) {
    bpm = focusBpm(pb, focus.bpm);
    bpmWhy = `your references: median ${focus.bpm}${bpm !== focus.bpm ? `, read at ${bpm} for this genre` : ''}`;
  }
  if (brief.bpm) {
    bpm = brief.bpm;
    bpmWhy = 'your brief';
  }
  if (generic && !brief.bpm && !focus?.bpm && !ref?.brief.detectedBpm) bpmWhy = genre ? `a placeholder: use ${genreInfo(genre).name}'s usual tempo` : 'a placeholder: use the genre\'s usual tempo';
  let key = pb.keys.common[0] ?? 'Am';
  let keyWhy = 'playbook';
  if (ref?.adapted.key) {
    key = ref.adapted.key;
    keyWhy = 'the reference';
  } else if (focus?.keys.length && parseKey(focus.keys[0])) {
    key = focus.keys[0];
    keyWhy = 'your references';
  }
  if (brief.key) {
    key = brief.key;
    keyWhy = 'your brief';
  }
  const swing = ref ? pb.swing : (focus?.swingPercent ?? pb.swing);
  const targets: PlaybookTargets = { ...pb.targets, ...(!ref && focus?.lufs !== null && focus?.lufs !== undefined ? { lufs: Math.max(-16, Math.min(-6, focus.lufs)) } : {}) };

  const have = new Set(ctx.channels.map(nameKey));
  const picker = ctx.picker ?? plainPicker(ctx.presets, ctx.samples);
  const parts = pb.parts.map((part) => {
    const sound = resolvePart(part, genre, picker);
    // the part's tags + its role word pick WHICH drums chain (Kick Punch for the kick, Snare Crack for snare / clap)
    const chainP = part.chain ? resolveChain(part.chain, genre, ctx.presets, [...(part.tags ?? []), part.role]) : null;
    return { part, sound, chain: chainP ? { id: chainP.id, name: chainP.name } : null };
  });
  const sections = placeSections(pb.arrangement);
  const totalBars = sections.length ? sections[sections.length - 1].end : 0;
  const tCalls = transitionCalls(sections);
  const masterP = resolveChain('master', genre, ctx.presets, pb.mix.master.tags);
  const buses = (pb.mix.buses ?? []).map((b) => ({ ...b, preset: resolveChain(b.chain, genre, ctx.presets, b.tags) }));
  const groove = grooveFor(generic ? null : pb, genre);
  const drumParts = pb.parts.filter((x) => DRUM_ROLES.has(x.role) || !!x.sample).map((x) => x.name);
  const melodicParts = pb.parts.filter((x) => ['bass', '808', 'keys', 'piano', 'chord', 'stab', 'pluck'].includes(x.role)).map((x) => x.name);
  const sends = (pb.mix.sends ?? []).map((s) => ({ ...s, preset: resolveChain(s.chain, genre, ctx.presets, s.tags) }));

  const L: string[] = [];
  const genreName = genre ? genreInfo(genre).name : 'Song';
  L.push(`PLAYBOOK — ${pb.name}${genre ? ` (${genre})` : ''}${ctx.source ? `, genre ${SOURCE_WORDS[ctx.source]}` : ''}`);
  L.push(pb.summary);
  L.push('');
  L.push(`Tempo ${bpm} bpm (${bpmWhy}) · key ${key} (${keyWhy}; common: ${pb.keys.common.join(', ') || '—'}; modes: ${pb.keys.modes.join(', ') || '—'}) · swing ${swing}%${pb.grid && pb.grid !== 16 ? ` · hat grid ${pb.grid}` : ''}${pb.halfTime ? ' · half-time feel' : ''}`);
  if (pb.keys.notes) L.push(`Keys: ${pb.keys.notes}`);
  L.push(`Harmony: ${pb.harmony.progressions.join(' | ')} · rhythm: ${pb.harmony.rhythm} · voicing: ${pb.harmony.voicing}`);
  L.push(`Melody: ${pb.melody}`);
  if (groove) {
    L.push(`Groove: transform_notes op "groove", template "${groove.template}" (amount ${groove.amount}, velocity ${groove.velocity}) on ${groove.parts?.length ? groove.parts.join(', ') : `the drums${groove.melodic ? ' and the bass / keys' : ''}`}: real drummers' timing and accents (${groove.source === 'playbook' ? "the playbook's choice" : 'a starting point for the genre'}).`);
  }
  if (ref) L.push('', ...referenceLines(ref));
  if (focus && !ref) {
    const r: string[] = [];
    if (focus.bpm) r.push(`tempo ${focus.bpm} bpm${focus.bpmRange ? ` (middle half ${focus.bpmRange[0]}-${focus.bpmRange[1]})` : ''}`);
    if (focus.swingPercent !== null) r.push(`swing about ${focus.swingPercent}%`);
    if (focus.keys.length) r.push(`keys ${focus.keys.join(', ')}`);
    if (focus.progressions.length) r.push(`progressions ${focus.progressions.map((x) => `"${x}"`).join(', ')}`);
    if (focus.sectionBars) r.push(`sections of about ${focus.sectionBars} bars`);
    if (focus.forms.length) r.push(`form ${focus.forms.map((x) => `"${x}"`).join(' or ')}`);
    if (focus.lufs !== null) r.push(`loudness ${focus.lufs} LUFS`);
    L.push('');
    L.push(`YOUR REFERENCES SAY (style focus "${focus.name}", ${focus.analysed} analysed songs) — these override the playbook: ${r.join('; ') || 'too few analysed songs for numbers yet'}.`);
    L.push('Tempo, key, swing and the loudness target above already use them. Prefer their progressions over the playbook\'s, and scale the arrangement\'s section lengths to their phrase length. Keep every melody ORIGINAL (check_originality before you finish).');
  }

  L.push('');
  L.push('PARTS (Channel Rack order; the sound is resolved for you):');
  parts.forEach(({ part, sound, chain }, i) => {
    const what =
      sound.kind === 'sample'
        ? `sample "${sound.name}" (${sound.ref})`
        : sound.kind === 'preset'
          ? `preset "${sound.name}" (${sound.ref}${sound.plugin ? `, ${sound.plugin}` : ''})`
          : `no factory sound for role ${part.role} yet: name the channel "${part.name}" and shape it with set_params`;
    const extra = [chain ? `insert chain "${chain.name}" (${chain.id})` : part.chain ? `insert chain role ${part.chain} (no preset installed)` : '', part.bus ? `→ ${part.bus}` : '', part.duckUnder ? `ducks under ${part.duckUnder}` : '', part.range ? `notes ${part.range[0]}-${part.range[1]}` : '']
      .filter(Boolean)
      .join(' · ');
    L.push(`${i + 1}. ${part.name} [${part.role}${part.tags?.length ? `: ${part.tags.join(', ')}` : ''}] — ${what}${extra ? ` · ${extra}` : ''}`);
    L.push(`   ${part.writing}`);
  });

  if (pb.patterns.length) {
    L.push('');
    L.push('PATTERNS (original idioms in KPN: starting points, never paste them unchanged into every section):');
    for (const pat of pb.patterns) {
      L.push(`"${pat.name}" — for ${pat.for.join(', ')}${pat.notes ? ` (${pat.notes})` : ''}:`);
      for (const line of pat.kpn.split('\n')) if (line.trim()) L.push(`  ${line}`);
    }
  }

  L.push('');
  L.push(`ARRANGEMENT (${totalBars} bars; bar 1 = song start${targets.bars ? `; target ${targets.bars[0]}-${targets.bars[1]}` : ''}):`);
  for (const s of sections) {
    const use = pb.patterns.filter((x) => x.for.some((f) => f.toLowerCase() === s.kind || f.toLowerCase() === s.label.toLowerCase())).map((x) => `"${x.name}"`);
    L.push(`  ${`${s.start}-${s.end}`.padEnd(8)} ${s.name} (${s.kind}, energy ${s.energy}): ${s.parts.join(', ') || '—'}${s.transitionIn?.length ? ` · in: ${s.transitionIn.join(' + ')}` : ''}${use.length ? ` · start from ${use.join(', ')}` : ''}${s.notes ? ` · ${s.notes}` : ''}`);
  }

  L.push('');
  L.push(`TRANSITIONS: ${pb.transitions}`);
  for (const b of boundaries(sections)) L.push(`  bar ${b.at} (${b.from} → ${b.to}): ${b.kinds.length ? b.kinds.join(' + ') : 'none planned: add at least a fill or a crash'}`);
  L.push('VOCALS (only when the user asks for vocals, a hook, ad-libs or a tag): list_voices, then sing_notes {pattern, channel: the lead, lyrics} sings their words on the hook melody (a guide vocal with Krypt Tune), generate_voice adds ad-libs / a tag. Cloud voices send the text to Fish Audio.');

  L.push('');
  L.push('MIX:');
  L.push(`  master: ${masterP ? `chain "${masterP.name}" (${masterP.id})${masterP.targetLufs !== undefined ? `, tuned to about ${masterP.targetLufs} LUFS` : ''}` : 'no master chain preset installed: Krypt EQ → Krypt Comp → Krypt Limiter (ceiling -1 dB) with add_effect'}`);
  for (const b of buses) {
    const from = pb.parts.filter((x) => x.bus === b.name).map((x) => x.name);
    L.push(`  bus ${b.name}${from.length ? ` ← ${from.join(', ')}` : ''}: ${b.preset ? `chain "${b.preset.name}" (${b.preset.id})` : `chain role ${b.chain} (no preset installed)`}`);
  }
  for (const s of sends) L.push(`  send ${s.name} ← ${s.from.map((f) => `${f.part} ${Math.round(f.amount * 100)}%`).join(', ')}: ${s.preset ? `chain "${s.preset.name}" (${s.preset.id})` : `chain role ${s.chain} (no preset installed)`}`);
  const ducks = pb.parts.filter((x) => x.duckUnder);
  if (ducks.length) L.push(`  sidechain: ${ducks.map((x) => `${x.name} under ${x.duckUnder}`).join(', ')}`);
  L.push(`  levels: ${pb.mix.levels}`);
  if (pb.mix.notes) L.push(`  notes: ${pb.mix.notes}`);

  L.push('');
  L.push(`TARGETS (review_song measures these): ${targetsLine(targets)}`);
  if (pb.mistakes.length) {
    L.push('MISTAKES that make it sound amateur (check each):');
    for (const m of pb.mistakes) L.push(`  - ${m}`);
  }

  // ── Build order ──
  const steps: string[] = [];
  const step = (s: string) => steps.push(s);
  step(`begin_edit ${j({ label: ref ? `Like ${ref.brief.name}`.slice(0, 80) : `${genreName} song` })}`);
  const tempo: string[] = [];
  if (Math.abs(ctx.projectBpm - bpm) > 0.01) tempo.push(`set_tempo ${j({ bpm })}`);
  if (Math.round(ctx.projectSwing * 100) !== swing) tempo.push(`set_swing ${j({ percent: swing })}`);
  if (tempo.length) step(tempo.join(' · '));
  const sounds: string[] = [];
  for (const { part, sound } of parts) {
    const exists = have.has(nameKey(part.name));
    if (sound.kind === 'sample') sounds.push(`load_sample ${j(exists ? { channel: part.name, sample: sound.ref } : { sample: sound.ref, name: part.name })}`);
    else if (sound.kind === 'preset') sounds.push(`load_preset ${j(exists ? { preset: sound.ref, channel: part.name } : { preset: sound.ref, name: part.name })}`);
    else sounds.push(`add_channel ${j({ name: part.name })} (then set_params)`);
  }
  if (sounds.length) step(`Sounds, one call per part:\n     ${sounds.join('\n     ')}`);
  const chains = parts.filter((x) => x.chain && !(x.sound.kind === 'preset' && x.sound.hasFx)).map((x) => `apply_chain ${j({ chain: x.chain!.id, insert: x.part.name })}`);
  if (chains.length) step(`Insert chains: ${chains.join(' · ')}`);
  const patNames = sections.map((s) => s.name);
  const firstOfKind = new Map<string, string>();
  const clones: string[] = [];
  for (const s of sections) {
    const k = `${s.kind}|${[...s.parts].sort().join(',')}`;
    const first = firstOfKind.get(k);
    if (first) clones.push(`"${s.name}" = create_pattern ${j({ name: s.name, clone_from: first })} + write_pattern {"mode":"merge"} with a NEW variation (lead rhythm, hat pattern, a counter-melody or an extra layer)`);
    else firstOfKind.set(k, s.name);
  }
  step(
    `Patterns: one pattern per section (${patNames.map((x) => `"${x}"`).join(', ')}), each with only that section's parts, written with write_pattern (header pattern "<section>" bars=<section bars, max 16> key=${key}). Start from the KPN above, repeat the groove with (…)*n but change something every 4-8 bars (a fill in each phrase's last bar, hat variations, a part in or out) so no 8 bars are identical; velocities vary (accents and ghosts).${clones.length ? `\n     Sections that come back: ${clones.join('; ')}.` : ''}`,
  );
  if (groove) {
    const who = groove.parts ?? [...drumParts, ...(groove.melodic ? melodicParts : [])];
    const op = { op: 'groove', template: groove.template, amount: groove.amount, velocity: groove.velocity };
    step(
      `Groove, after the notes are written: transform_notes ${j({ pattern: sections[0]?.name ?? '<section>', channel: who[0] ?? 'Hat', ops: [op] })}, the same op for ${who.length ? who.join(', ') : 'every drum channel'} in every section pattern${groove.parts?.length ? ' (only these: the rest stays on the grid)' : groove.melodic ? ' (the bass and keys take the same template so they lock to the drums)' : ''}. Real timing and accents instead of machine-gun hits.`,
    );
  } else step('Groove: accents and ghost notes on the drums (or transform_notes op "groove" with a template that fits the style), so no part plays every hit at the same level.');
  if (sections.length) {
    step(`arrange ${j({ placements: sections.map((s) => ({ pattern: s.name, bars: `${s.start}-${s.end}` })) })}`);
    step(`add_marker ${j({ markers: sections.map((s) => ({ at: s.start, name: s.name })) })}`);
  }
  if (tCalls.length) step(`Transitions at every boundary: ${tCalls.map((c) => `add_transition ${j(c)}`).join(' · ')}`);
  const mix: string[] = [];
  const insertNames = new Set((ctx.inserts ?? []).map(nameKey));
  /** A bus / send insert: loaded when it exists, else created with that name by apply_chain "new:<name>". */
  const busChain = (name: string, _role: ChainRole, id: string): string[] =>
    insertNames.has(nameKey(name)) ? [`apply_chain ${j({ chain: id, insert: name })}`] : [`apply_chain ${j({ chain: id, insert: `new:${name}` })}`];
  for (const b of buses) {
    const from = pb.parts.filter((x) => x.bus === b.name).map((x) => x.name);
    if (b.preset) mix.push(...busChain(b.name, b.chain, b.preset.id));
    for (const f of from) mix.push(`route ${j({ from_insert: f, to: b.name })}`);
  }
  for (const s of sends) {
    if (s.preset) mix.push(...busChain(s.name, s.chain, s.preset.id));
    for (const f of s.from) mix.push(`route ${j({ from_insert: f.part, to: s.name, level_db: Math.round(20 * Math.log10(Math.max(0.01, f.amount))), exclusive: false })}`);
  }
  if (masterP) mix.push(`apply_chain ${j({ chain: masterP.id, insert: 'master' })}`);
  for (const d of ducks) mix.push(`sidechain ${j({ source: d.duckUnder, target: d.name })}`);
  if (mix.length) step(`Mix: ${mix.join(' · ')}`);
  step(`Levels: ${pb.mix.levels} (set_channel / set_mixer volume_db)`);
  if (ref) step('check_originality: rewrite any line it flags as close to the reference (change the intervals and the rhythm, not just the key).');
  step(`review_song ${j(genre ? { genre } : {})} → fix its top issues (the fixes are tool calls) → review_song again; at most 2 fix rounds${ref ? '. With the reference it also checks your energy shape, loudness and tonal balance against the song' : ''}`);
  step(`set_song_info ${j({ title: '<your title>', genre: genreName })} · commit_edit`);
  step('Answer in a few lines: what you made (genre, tempo, key, length, sections), the main sound and mix choices, the review score, and 2-3 one-line edits the user could ask for next.');

  L.push('');
  L.push('BUILD ORDER (one prompt = a finished song; never stop to ask the user mid-build):');
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('Racks (optional): a layered sound, a drum kit with choke groups or a parallel effect rack with named macros is one build_rack call; set_macro moves the macros; slice_to_pads chops a loop onto drum pads + a pattern.');

  return {
    genre,
    playbook: pb.name,
    generic,
    bpm,
    key,
    swing,
    parts: parts.map(({ part, sound, chain }) => ({ name: part.name, role: part.role, sound, chain, bus: part.bus, duckUnder: part.duckUnder })),
    sections: sections.map((s) => ({ name: s.name, kind: s.kind, start: s.start, end: s.end, bars: s.bars, energy: s.energy, parts: [...s.parts], transitionIn: [...(s.transitionIn ?? [])] })),
    totalBars,
    transitions: tCalls,
    master: masterP ? { id: masterP.id, name: masterP.name, targetLufs: masterP.targetLufs } : null,
    groove,
    targets,
    focus,
    reference: ref ? { name: ref.brief.name, track: ref.track, arrangement: ref.adapted.arrangement } : null,
    text: L.join('\n'),
  };
}

/** The reference block of the recipe: what the build takes from the song, and what stays original. */
function referenceLines(ref: NonNullable<RecipeContext['reference']>): string[] {
  const b = ref.brief;
  const a = ref.adapted;
  const L: string[] = [];
  const plan =
    a.arrangement === 'sections'
      ? "the ARRANGEMENT below is ITS section plan (bars, energy, where the peaks and breaks land) with this genre's parts in each section"
      : a.arrangement === 'length'
        ? "the arrangement below is the playbook's, scaled to its length (its sections weren't clear)"
        : "the arrangement is the playbook's (the reference's length is unknown)";
  L.push(`REFERENCE SONG "${b.name}"${ref.track ? ` (the muted track "${ref.track}")` : ''}: this recipe follows it. Tempo ${a.bpm} bpm (${a.bpmWhy})${a.key ? `, key ${a.key}` : ''}, swing ${a.swing}%; ${plan}; the targets use its loudness${a.arrangement === 'sections' ? ' and section contrast' : ''}.`);
  if (b.drums) {
    const d = b.drums;
    const words = [d.fourOnFloor ? 'four-on-the-floor kick' : '', d.backbeat === 'two-four' ? 'backbeat on 2 and 4' : d.backbeat === 'three' ? 'half-time snare on 3' : '', d.hats !== 'none' ? `${d.hats} hats` : '', d.rollsPerMin >= 1 ? `${d.rollsPerMin} hat rolls per minute` : ''].filter(Boolean);
    L.push(`Its drum feel (per 16th: 9 = nearly every bar, . = never${d.source === 'mix' ? '; heard in the full mix, so rough' : ''})${words.length ? `: ${words.join(', ')}` : ''}. Shape the playbook's patterns toward it (kick placement, snare spot, hat density); the parts are yours.`);
    for (const role of FEEL_ROLES) if (d.steps[role]) L.push(`  ${role.padEnd(8)} ${feelLine(d.steps[role]!)}`);
  }
  if (b.harmony.loop) L.push(`Its chord loop: ${b.harmony.loopChords ? `${b.harmony.loopChords.join(' ')} (${b.harmony.loop.join(' ')})` : b.harmony.loop.join(' ')} (estimated). Use it or a variation${a.key ? ` in ${a.key}` : ''}; the voicing, rhythm and every melody are yours.`);
  const m = b.mix;
  if (m.bandsVsMid || m.width !== null) {
    const bands = m.bandsVsMid ? `, bands vs mids ${Object.entries(m.bandsVsMid).map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${v}`).join(' ')}` : '';
    L.push(`Its mix: ${m.lufs ?? '?'} LUFS${bands}${m.width !== null ? `, width ${m.width}` : ''}. review_song compares your render with it.`);
  }
  L.push('ORIGINAL ONLY: never copy its melody, lyrics, vocal, hook or a recognisable riff; run check_originality before you finish. Keep the reference track muted (the user unmutes it to A/B).');
  return L;
}
