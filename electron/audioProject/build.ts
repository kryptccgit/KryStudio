// ──────────────────────────────────────────────────────────────────────
// Write a transcribed song into the project (research/15 §3.4 step 6):
// tempo / swing / meter, one channel per part with its matched sound (+ the
// matcher's tweaks) on its own named mixer insert, one pattern per section
// (sections that repeat reuse the earlier pattern: `sameAs`), the playlist
// arrangement + markers, the stems as muted tempo-synced audio tracks lined
// up with bar 1, the vocal as an audible audio track, levels and the
// bass → kick sidechain. Everything goes through commands on the Writer the
// caller gives (an agent's call group, or a user group), so the caller
// decides how it lands in history: ONE undo step. Pure over the DocHost
// (no I/O): sample info is gathered before.
// ──────────────────────────────────────────────────────────────────────

import type { Project } from '@shared/schema/project';
import type { PluginCatalog } from '@shared/plugins/types';
import type { StemName } from '@shared/analyzer/protocol';
import type { InstrumentPreset, InstrumentRole } from '@shared/sounds/types';
import type { SongTranscription, TranscribedPart } from '@shared/transcription/types';
import { sectionPatterns } from '@shared/transcription';
import { PPQ, secondsToTicks } from '@shared/schema/time';
import { stemLabel } from '@shared/commands/audio';
import { createDefaultProject } from '@shared/schema/factory';

/** Runs one command (throws an Error with a human message when it fails). */
export interface Writer {
  exec<T = unknown>(cmd: string, args: unknown): T;
}

/** The sound a part gets. */
export interface PartSound {
  load:
    | { kind: 'preset'; preset: InstrumentPreset }
    | { kind: 'sample'; path: string }
    | { kind: 'synth'; params?: Record<string, number> }
    | { kind: 'drumsynth'; voice: number };
  /** "Punchy Kick 2", "factory kick", "Krypt TriOsc". */
  label: string;
  role: InstrumentRole;
  /** 0..1 from the fingerprint matcher; null = chosen by role / genre. */
  similarity: number | null;
  /** Parameter nudges (plugin units; `pitch` = channel semitones, `gainDb` = channel level). */
  tweaks: Record<string, number>;
  why: string[];
}

export interface StemTrack {
  stem: StemName;
  path: string;
  frames?: number;
  sampleRate?: number;
  channels?: number;
  /** Muted (A/B and reuse) or audible (the vocal). */
  mute: boolean;
}

export interface WritePlan {
  t: SongTranscription;
  /** Parts written as channels + notes. */
  parts: TranscribedPart[];
  /** By part name. */
  sounds: Record<string, PartSound>;
  /** Channels without notes (build_from_reference's empty Lead). */
  empty: Array<{ name: string; sound: PartSound }>;
  stems: StemTrack[];
  /** Part names that duck under the Kick. */
  sidechain: string[];
  /** Insert level per part name (dB). */
  levelsDb: Record<string, number>;
  /** A new project: remove the default kit (channels, inserts, the empty pattern) first. */
  clearDefault: boolean;
  /**
   * An existing project (build_from_reference): remove the File ▸ New kit channels that were never used (same name
   * and instrument as the default kit, no notes in any pattern), and their own inserts, so they don't sit next to the
   * new parts. Anything the user set up or played is kept.
   */
  pruneUnusedDefaults?: boolean;
  /** Per part, per section: the stem's loudness vs its loudest section (dB). See Prepared.sectionGainDb. */
  sectionGainDb?: Record<string, number[]>;
  /** Project name (a new project); null keeps it. */
  title: string | null;
  /** Prefix for the stem tracks / channels ("Song" → "Song · Drums"). */
  stemPrefix: string;
  /** Tempo / swing / meter: set them (false keeps the project's). */
  setTransport: boolean;
}

export interface WriteResult {
  channelIds: Record<string, string>;
  insertIds: Record<string, string>;
  patternIds: string[];
  trackId: string;
  stemTracks: string[];
  clips: number;
  markers: number;
  notes: number;
  /** What was skipped and why (plain sentences). */
  notesText: string[];
}

const AUDIOCLIP = 'krypt.audioclip';
const DUCK = 'krypt.duck';

function hasPlugin(cat: PluginCatalog, id: string): boolean {
  return cat.plugins.some((p) => p.id === id);
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** A free, unique name ("Intro", "Intro (2)") among `taken` (lower-cased); adds it. */
function uniqueName(name: string, taken: Set<string>): string {
  const base = name.trim().slice(0, 56) || 'Part';
  let n = base;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base} (${i})`;
  taken.add(n.toLowerCase());
  return n.slice(0, 64);
}

/** The default project kit (File ▸ New): every channel, every insert but the master, every empty pattern. */
function clearDefaultKit(w: Writer, p: Project): void {
  if (p.channelOrder.length) w.exec('channels.remove', { ids: [...p.channelOrder] });
  for (const id of p.mixer.insertOrder) if (!p.mixer.inserts[id].isMaster) w.exec('mixer.removeInsert', { id });
}

/** Channels of the File ▸ New kit that are still untouched: same name + instrument, no notes, no clips. */
function unusedDefaultKit(p: Project): { channels: string[]; inserts: string[] } {
  const kit = createDefaultProject();
  const kitKeys = new Set(Object.values(kit.channels).map((c) => `${c.name.toLowerCase()}|${c.generator.type}`));
  const played = new Set<string>();
  for (const pat of Object.values(p.patterns)) for (const [chId, notes] of Object.entries(pat.notes)) if (Object.keys(notes).length) played.add(chId);
  for (const clip of Object.values(p.playlist.clips)) if (clip.channelId) played.add(clip.channelId);
  const channels = p.channelOrder.filter((id) => {
    const c = p.channels[id];
    return kitKeys.has(`${c.name.toLowerCase()}|${c.generator.type}`) && !played.has(id);
  });
  const gone = new Set(channels);
  const usedInserts = new Set(p.channelOrder.filter((id) => !gone.has(id)).map((id) => p.channels[id].insertId));
  const routedTo = new Set(Object.values(p.mixer.inserts).flatMap((ins) => Object.keys(ins.routes ?? {})));
  const inserts = [...new Set(channels.map((id) => p.channels[id].insertId))].filter((id) => {
    const ins = p.mixer.inserts[id];
    return !!ins && !ins.isMaster && !usedInserts.has(id) && !routedTo.has(id) && ins.name.toLowerCase() === (p.channels[channels.find((c) => p.channels[c].insertId === id)!].name.toLowerCase());
  });
  return { channels, inserts };
}

/** Empty patterns of the default project (removed once the song's own patterns exist: a project keeps at least one). */
function emptyPatterns(p: Project): string[] {
  return p.patternOrder.filter((id) => Object.values(p.patterns[id].notes).every((n) => Object.keys(n).length === 0));
}

/** Create (or, when one with the name exists, reload) the channel of a part. Returns the channel + insert ids. */
function channelFor(w: Writer, doc: () => Project, cat: PluginCatalog, name: string, sound: PartSound, mono: boolean, reuse: boolean, notes: string[]): { channelId: string; insertId: string } {
  const p = doc();
  const existing = reuse ? p.channelOrder.map((id) => p.channels[id]).find((c) => c.name.toLowerCase() === name.toLowerCase() && c.generator.type !== AUDIOCLIP) : undefined;
  let channelId: string;
  const load = sound.load;
  if (load.kind === 'preset') {
    if (existing) channelId = w.exec<{ channelId: string }>('presets.applyToChannel', { channelId: existing.id, preset: load.preset, withFx: true }).channelId;
    else channelId = w.exec<{ channelId: string }>('presets.addChannel', { preset: load.preset, name, withFx: true }).channelId;
  } else if (load.kind === 'sample') {
    const sampleId = w.exec<{ id: string }>('samples.add', { path: load.path }).id;
    if (existing) {
      if (existing.generator.type !== 'krypt.sampler') w.exec('channels.setGenerator', { id: existing.id, type: 'krypt.sampler' });
      w.exec('channels.setSample', { id: existing.id, sampleId });
      channelId = existing.id;
    } else channelId = w.exec<{ id: string }>('channels.add', { type: 'krypt.sampler', name, sampleId }).id;
  } else {
    const type = load.kind === 'drumsynth' ? 'krypt.drumsynth' : 'krypt.triosc';
    const params = load.kind === 'drumsynth' ? { voice: load.voice } : (load.params ?? {});
    if (existing) {
      w.exec('channels.setGenerator', { id: existing.id, type, params });
      channelId = existing.id;
    } else channelId = w.exec<{ id: string }>('channels.add', { type, name, params }).id;
  }
  // Tweaks: plugin params the instrument has (clamped by the command), channel pitch, level.
  const ch = doc().channels[channelId];
  const desc = cat.plugins.find((x) => x.id === ch.generator.type);
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(sound.tweaks)) {
    if (!Number.isFinite(v) || k === 'pitch' || k === 'gainDb') continue;
    if (desc?.params.some((s) => s.id === k)) params[k] = v;
  }
  if (Object.keys(params).length) w.exec('channels.setGenParams', { id: channelId, params });
  const set: Record<string, unknown> = {};
  if (Number.isFinite(sound.tweaks.pitch) && sound.tweaks.pitch !== 0) set.pitch = Math.max(-24, Math.min(24, Math.round(sound.tweaks.pitch)));
  if (Number.isFinite(sound.tweaks.gainDb) && sound.tweaks.gainDb !== 0) set.volume = Math.max(0, Math.min(1.25, ch.volume * dbToGain(Math.max(-12, Math.min(6, sound.tweaks.gainDb)))));
  if (mono) set.poly = { mono: true };
  if (Object.keys(set).length) w.exec('channels.set', { id: channelId, ...set });
  if (Object.keys(sound.tweaks).some((k) => k !== 'pitch' && k !== 'gainDb' && !(k in params))) notes.push(`Some sound tweaks for "${name}" don't exist on its instrument and were skipped.`);
  return { channelId, insertId: doc().channels[channelId].insertId };
}

/** A playlist lane for the patterns: an empty default track renamed, else a new one. */
function songTrack(w: Writer, doc: () => Project, name: string): string {
  const p = doc();
  const used = new Set(Object.values(p.playlist.clips).map((c) => c.trackId));
  const free = p.playlist.trackOrder.find((t) => !used.has(t) && /^Track \d+$/.test(p.playlist.tracks[t]?.name ?? ''));
  if (free) {
    w.exec('playlist.setTrack', { id: free, name });
    return free;
  }
  return w.exec<{ id: string }>('playlist.addTrack', { name }).id;
}

/**
 * Write the plan. Throws on the first failing command (the caller rolls its group back). `doc` returns the CURRENT
 * project (after each command).
 */
export function writeProject(w: Writer, doc: () => Project, cat: PluginCatalog, plan: WritePlan): WriteResult {
  const t = plan.t;
  const notesText: string[] = [];
  const emptyDefault = plan.clearDefault ? emptyPatterns(doc()) : [];
  if (plan.clearDefault) clearDefaultKit(w, doc());
  else if (plan.pruneUnusedDefaults) {
    const unused = unusedDefaultKit(doc());
    if (unused.channels.length) {
      w.exec('channels.remove', { ids: unused.channels });
      for (const id of unused.inserts) w.exec('mixer.removeInsert', { id });
      notesText.push(`Removed the unused File ▸ New kit channels (${unused.channels.length}) so only the new parts remain.`);
    }
  }
  if (plan.title) w.exec('project.setMeta', { name: plan.title.slice(0, 128) });
  const beatsPerBar = Math.max(1, Math.min(16, Math.round(t.beatsPerBar || 4)));
  if (plan.setTransport) {
    w.exec('transport.set', { bpm: Math.max(10, Math.min(999, t.bpm)), swing: Math.max(0, Math.min(1, (t.swingPercent ?? 0) / 100)), timeSig: { num: beatsPerBar, den: 4 } });
  }
  const barTicks = PPQ * beatsPerBar;

  // Channels (Channel Rack order = the parts' order), each on its own insert named after it.
  const channelIds: Record<string, string> = {};
  const insertIds: Record<string, string> = {};
  const all = [...plan.parts.map((part) => ({ name: part.name, sound: plan.sounds[part.name], mono: part.kind === 'bass' || part.kind === 'lead' })), ...plan.empty.map((e) => ({ name: e.name, sound: e.sound, mono: e.sound.role === 'lead' || e.sound.role === 'bass' }))];
  for (const c of all) {
    if (!c.sound) throw new Error(`No sound was chosen for "${c.name}"`);
    const r = channelFor(w, doc, cat, c.name, c.sound, c.mono, !plan.clearDefault, notesText);
    channelIds[c.name] = r.channelId;
    insertIds[c.name] = r.insertId;
  }
  for (const [part, db] of Object.entries(plan.levelsDb)) {
    const ins = insertIds[part];
    if (ins && Number.isFinite(db) && Math.abs(db) >= 0.5) w.exec('mixer.setInsert', { id: ins, volume: Math.max(0, Math.min(2, dbToGain(Math.max(-24, Math.min(6, db))))) });
  }

  // One pattern per section; a section that repeats an earlier one (sameAs) plays that pattern (transcribe-core's slices).
  const takenPatterns = new Set(Object.values(doc().patterns).map((x) => x.name.toLowerCase()));
  const written = new Set(plan.parts.map((p) => p.name));
  const patternOf: string[] = [];
  const patternIds: string[] = [];
  let notes = 0;
  const gains = plan.sectionGainDb ?? {};
  /** A part's level in a section (dB vs its loudest), 0 when unknown. */
  const gainOf = (part: string, index: number): number => {
    const g = gains[part]?.[index];
    return typeof g === 'number' && Number.isFinite(g) ? g : 0;
  };
  /** Parts whose stem is nearly silent in a section are left out of it. */
  const SILENT_DB = -20;
  let dropped = 0;
  for (const sp of sectionPatterns(t)) {
    if (sp.patternOf !== sp.index && patternOf[sp.patternOf]) {
      // A repeat plays the earlier pattern, unless the parts' levels differ (a quiet reprise gets its own copy).
      const same = sp.parts.every((part) => Math.abs(gainOf(part.name, sp.index) - gainOf(part.name, sp.patternOf)) <= 4);
      if (same) {
        patternOf.push(patternOf[sp.patternOf]);
        continue;
      }
    }
    const id = w.exec<{ id: string }>('patterns.add', { name: uniqueName(sp.name, takenPatterns), select: sp.index === 0, length: sp.lengthTicks }).id;
    for (const part of sp.parts) {
      if (!written.has(part.name) || !channelIds[part.name]) continue;
      const g = gainOf(part.name, sp.index);
      if (g <= SILENT_DB) {
        if (part.notes.length) dropped++;
        continue;
      }
      const scale = Math.pow(10, g / 20);
      const list = part.notes.map((n) => ({ tick: Math.max(0, Math.round(n.tick)), key: Math.max(0, Math.min(127, Math.round(n.key))), dur: Math.max(1, Math.round(n.dur)), vel: Math.max(0.05, Math.min(1, n.vel * Math.max(0.15, scale))) }));
      for (let k = 0; k < list.length; k += 5000) w.exec('notes.add', { patternId: id, channelId: channelIds[part.name], notes: list.slice(k, k + 5000) });
      notes += list.length;
    }
    patternOf.push(id);
    patternIds.push(id);
  }

  if (patternIds.length) for (const id of emptyDefault) w.exec('patterns.remove', { id });
  if (dropped) notesText.push(`Followed the reference's dynamics: ${dropped} part${dropped === 1 ? '' : 's'} left out of sections where its stem is nearly silent, and velocities scaled to each section's level.`);

  // Arrangement on one lane, markers at every section start, song mode.
  const trackId = songTrack(w, doc, 'Song');
  let clips = 0;
  t.sections.forEach((s, i) => {
    const patternId = patternOf[i];
    if (!patternId) return;
    w.exec('playlist.addClip', { kind: 'pattern', trackId, start: (s.startBar - 1) * barTicks, length: s.bars * barTicks, patternId });
    clips++;
  });
  let markers = 0;
  for (const s of t.sections) {
    w.exec('playlist.addMarker', { tick: (s.startBar - 1) * barTicks, name: s.name.slice(0, 64) });
    markers++;
  }
  if (t.sections.length) w.exec('transport.setMode', { mode: 'song' });

  // Stems: audio-clip channels synced to the song's tempo, bar 1 = the source's first downbeat.
  const stemTracks: string[] = [];
  if (plan.stems.length) {
    if (!hasPlugin(cat, AUDIOCLIP)) notesText.push("This build's Audio Clip instrument is missing, so the stems weren't placed.");
    else {
      const syncable = ['tempo_sync', 'src_bpm'].every((id) => cat.plugins.find((x) => x.id === AUDIOCLIP)?.params.some((s) => s.id === id));
      if (!syncable) notesText.push("This build's Audio Clip can't follow the tempo yet, so the stems play at their own speed (they line up at the song's tempo only).");
      const bpm = doc().transport.bpm;
      for (const s of plan.stems) {
        const label = `${plan.stemPrefix} · ${stemLabel(s.stem)}`.slice(0, 64);
        const tr = w.exec<{ id: string }>('playlist.addTrack', { name: label }).id;
        const r = w.exec<{ clipId: string; channelId: string; insertId: string }>('playlist.addAudio', { path: s.path, name: label, trackId: tr, start: 0, frames: s.frames, sampleRate: s.sampleRate, channels: s.channels });
        w.exec('channels.set', { id: r.channelId, name: label });
        w.exec('mixer.setInsert', { id: r.insertId, name: label });
        if (syncable) w.exec('channels.setGenParams', { id: r.channelId, params: { tempo_sync: 1, src_bpm: t.bpm } });
        // Synced: the audio's own seconds map to ticks at the song's tempo; unsynced it plays at its speed under the project tempo.
        const tickBpm = syncable ? t.bpm : bpm;
        const total = s.frames && s.sampleRate ? Math.round(secondsToTicks(s.frames / s.sampleRate, tickBpm)) : null;
        const offset = Math.max(0, Math.round(secondsToTicks(t.firstDownbeatSec, tickBpm)));
        if (total !== null && total > offset) w.exec('playlist.updateClips', { updates: [{ id: r.clipId, offset, length: total - offset }] });
        if (s.mute) w.exec('playlist.setTrack', { id: tr, mute: true });
        stemTracks.push(tr);
      }
    }
  }

  // The bass (and what else pumps) ducks under the kick.
  const kickIns = insertIds['Kick'] ?? Object.entries(insertIds).find(([n]) => /kick/i.test(n))?.[1];
  if (plan.sidechain.length) {
    if (!kickIns) notesText.push('No kick channel to sidechain to.');
    else if (!hasPlugin(cat, DUCK)) notesText.push("This build has no Krypt Duck, so the sidechain wasn't added.");
    else
      for (const name of plan.sidechain) {
        const ins = insertIds[name];
        if (!ins || ins === kickIns) continue;
        const slot = w.exec<{ id: string }>('mixer.addSlot', { insertId: ins, type: DUCK, params: { mode: 1, depth: 0.6, release: 160 }, index: 0 }).id;
        w.exec('mixer.setSlot', { insertId: ins, slotId: slot, sidechainFrom: kickIns, enabled: true });
      }
  }
  return { channelIds, insertIds, patternIds, trackId, stemTracks, clips, markers, notes, notesText };
}
