// Composition tools: KPN write/read, precise note edits, pattern management,
// deterministic note transforms.

import { z } from 'zod';
import type { MainDeps } from '../types';
import type { Channel, Note, Pattern, Project } from '@shared/schema/project';
import { patternLength } from '@shared/schema/project';
import { PPQ, ticksPerBar } from '@shared/schema/time';
import { inScale, noteName, parseKey, parseNoteName, SCALES } from '@shared/music/theory';
import { formatIssues, midiVelocity, parse, printKpn, KPN_SHORT, type KpnTrack, type PrintTrack } from '@shared/kpn';
import { swungGridLine } from '@shared/commands/noteTools';
import { applyGroove, grooveClassForChannel, GROOVE_IDS } from '@shared/grooves/apply';
import { findSample, sampleUsers } from './sampleRef';
import { defineTool, fail, type RunCtx } from './types';
import { findChannel, findInsert, findPattern, findSlot, fmtPos, norm, parseBarRange, parsePosition, plural, pluginName, safeName, tryFindChannel, tryFindPattern } from './util';
import { chooseInstrument, type InstrumentChoice } from './instruments';
import { isDrumChannel } from './overview';

const zLabel = z.string().max(80).optional().describe('Short description of this change for the user\'s AI-history panel.');

interface NoteLike {
  tick: number;
  dur: number;
  key: number;
  vel: number;
  slide?: boolean;
}

function sig(n: NoteLike): string {
  return `${n.tick}|${n.dur}|${n.key}|${midiVelocity(n.vel)}|${n.slide ? 1 : 0}`;
}

function sameNotes(a: NoteLike[], b: NoteLike[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(sig).sort();
  const y = b.map(sig).sort();
  return x.every((s, i) => s === y[i]);
}

function displayName(trackName: string): string {
  const n = safeName(trackName, 64);
  return /^[a-z]/.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
}

/** Unique KPN track names for channels (ids for duplicate names). */
function trackNames(p: Project, ids: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const id of p.channelOrder) {
    const k = p.channels[id].name.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const id of ids) {
    const name = safeName(p.channels[id].name, 64);
    out.set(id, (counts.get(p.channels[id].name.toLowerCase()) ?? 0) > 1 || !name || /^pattern$/i.test(name) ? id : name);
  }
  return out;
}

function patternBars(p: Project, patId: string): number {
  return Math.max(1, Math.ceil(patternLength(p.patterns[patId], p.transport.timeSig) / ticksPerBar(p.transport.timeSig)));
}

/** Canonical KPN for (some) channels of a pattern. */
export function patternKpn(deps: MainDeps, patId: string, channelIds?: string[], key?: string | null): { text: string; warnings: string[]; notes: number; channels: number } {
  const p = deps.doc.project;
  const pat = p.patterns[patId];
  const ids = channelIds ?? p.channelOrder.filter((id) => Object.keys(pat.notes[id] ?? {}).length > 0);
  const names = trackNames(p, ids);
  const tracks: PrintTrack[] = ids.map((id) => ({
    name: names.get(id)!,
    notes: Object.values(pat.notes[id] ?? {}),
    drum: isDrumChannel(p.channels[id]),
    drumKey: p.channels[id].rootKey,
  }));
  const r = printKpn(tracks, { name: safeName(pat.name, 64), bars: patternBars(p, patId), ts: p.transport.timeSig, key: key ?? null });
  return { text: r.text, warnings: r.warnings, notes: tracks.reduce((s, t) => s + t.notes.length, 0), channels: ids.length };
}

function resolveOrCreatePattern(deps: MainDeps, ctx: RunCtx, want: string | undefined, headerName: string | null): { id: string; created: boolean } {
  const p = deps.doc.project;
  if (want && /^new:/i.test(want)) {
    const name = want.slice(4).trim() || headerName || undefined;
    if (name && p.patternOrder.some((id) => p.patterns[id].name.toLowerCase() === name.toLowerCase())) {
      fail(`A pattern named "${safeName(name)}" already exists. Pass pattern: "${safeName(name)}" to overwrite it, or pick another name.`);
    }
    return { id: ctx.exec<{ id: string }>('patterns.add', { name: name ? safeName(name, 64) : undefined, select: true }).id, created: true };
  }
  if (want) {
    const found = tryFindPattern(p, want);
    if (found) return { id: found.id, created: false };
    if (/^pat_/.test(want)) fail(`No pattern with id ${safeName(want)}. Use list_patterns, or "new:Name" to create one.`);
    return { id: ctx.exec<{ id: string }>('patterns.add', { name: safeName(want, 64), select: true }).id, created: true };
  }
  if (headerName) {
    const found = tryFindPattern(p, headerName);
    if (found) return { id: found.id, created: false };
    return { id: ctx.exec<{ id: string }>('patterns.add', { name: safeName(headerName, 64), select: true }).id, created: true };
  }
  return { id: findPattern(p, undefined).id, created: false };
}

export const writePattern = defineTool({
  name: 'write_pattern',
  title: 'Write a pattern (KPN)',
  kind: 'write',
  description: [
    'MAIN WRITE PATH. Write one or many channels of a pattern in KPN (Krypt Pattern Notation). One call can write a whole beat.',
    KPN_SHORT,
    'Channel lines map to channels by name or id (case-insensitive; kick/bd, hat/hh, snare/sd, clap/cp, 808 aliases work). Unknown names create a new channel when create_missing is true, with a finished sound picked from the role the channel name implies and the project genre (a factory drum sample, or an instrument preset with its effects; {inst=synth|wave|fm|sampler|808|drumsynth} picks the plugin; load_preset swaps it later).',
    'Pattern: `pattern` arg (id/name, "new:Name"), else the header name (created if missing), else the active pattern. Header bars= sets the pattern length.',
    'mode "replace" (default) rewrites each channel you list; "merge" adds hits (x/X/o), clears with _, keeps . untouched; "append" writes after the current end.',
    'Errors name the line and bar (e.g. "line 3 (kick), bar 2: has 15/16 steps"); nothing is written when the KPN has errors. Call read_pattern to see the result as canonical KPN.',
    'Example: {"kpn":"pattern \\"Beat\\" bars=1\\nkick: x... ..x. x... ....\\nhat: (x.x.)*4\\nclap: .... x... .... x..."}',
  ].join('\n'),
  input: z.object({
    kpn: z.string().min(1).max(20000).describe('KPN text: optional header `pattern "Name" bars=2 grid=16 key=Am`, then one `channel: body` line per channel.'),
    pattern: z.string().max(80).optional().describe('Target pattern id or name, or "new:Name". Default: the KPN header name, else the active pattern.'),
    mode: z.enum(['replace', 'merge', 'append']).default('replace').describe('replace (default) | merge | append'),
    create_missing: z.boolean().default(true).describe('Create channels for unknown names (default true).'),
    echo: z.boolean().default(false).describe('Also return the stored result as canonical KPN.'),
    change_label: zLabel,
  }),
  summarize: (a) => {
    const name = /pattern\s+"([^"]+)"/.exec(a.kpn)?.[1] ?? a.pattern ?? 'active pattern';
    const lines = a.kpn.split('\n').filter((l) => l.includes(':') && !/^\s*pattern\b/i.test(l) && !/^\s*\/\//.test(l)).length;
    return `"${safeName(name, 40)}" (${plural(lines, 'line')}, ${a.mode})`;
  },
  run(deps, _caller, a, ctx) {
    const p0 = deps.doc.project;
    const ts = p0.transport.timeSig;
    const barTicks = ticksPerBar(ts);
    const parsed = parse(a.kpn, {
      ts,
      drumKey: (name) => {
        const r = tryFindChannel(p0, name);
        return r && 'id' in r ? p0.channels[r.id].rootKey : 60;
      },
    });
    if (!parsed.ok) fail(`KPN has ${plural(parsed.errors.length, 'error')}; nothing was written. Fix and resend:\n${formatIssues(parsed.errors)}`);
    if (parsed.header.tsExplicit && (parsed.header.ts.num !== ts.num || parsed.header.ts.den !== ts.den)) {
      fail(`The project is in ${ts.num}/${ts.den} but the KPN says ts=${parsed.header.ts.num}/${parsed.header.ts.den}. Change the project with set_tempo (time_signature) first, or drop ts=.`);
    }
    if (!parsed.tracks.length) fail('The KPN has no channel lines (write e.g. `kick: x... x... x... x...`).');

    // Map tracks → channels before touching anything.
    const plan: Array<{ track: KpnTrack; channelId?: string; create?: InstrumentChoice }> = [];
    const used = new Map<string, string>();
    const missing: string[] = [];
    for (const t of parsed.tracks) {
      const r = tryFindChannel(p0, t.name);
      if (r && 'ambiguous' in r) fail(`"${safeName(t.name)}" matches several channels: ${r.ambiguous.join(', ')}. Use the channel id as the line name.`);
      if (r && 'id' in r) {
        if (used.has(r.id)) fail(`"${safeName(t.name)}" and "${safeName(used.get(r.id)!)}" both map to channel "${safeName(p0.channels[r.id].name)}"; write it once.`);
        used.set(r.id, t.name);
        plan.push({ track: t, channelId: r.id });
      } else if (a.create_missing) {
        plan.push({ track: t, create: chooseInstrument(deps, t.name, t.opts.inst ?? t.opts.type, t.kind === 'grid') });
      } else missing.push(t.name);
    }
    if (missing.length) {
      fail(`No channel for ${missing.map((m) => `"${safeName(m)}"`).join(', ')}. Channels: ${p0.channelOrder.map((id) => safeName(p0.channels[id].name)).join(', ')}. Resend with create_missing: true to create them.`);
    }

    const { id: patId, created: createdPattern } = resolveOrCreatePattern(deps, ctx, a.pattern, parsed.header.name);
    const created: string[] = [];
    for (const item of plan) {
      if (!item.create) continue;
      const c = item.create;
      if (c.preset) {
        // A finished sound for the name's role + the project genre (instrument, params, sample, FX chain).
        item.channelId = ctx.exec<{ channelId: string }>('presets.addChannel', { preset: c.preset, name: displayName(item.track.name), withFx: true }).channelId;
        created.push(`"${displayName(item.track.name)}" → ${c.label}`);
        continue;
      }
      let sampleId: string | undefined;
      if (c.sample) sampleId = ctx.exec<{ id: string }>('samples.add', { path: c.sample }).id;
      const r = ctx.exec<{ id: string }>('channels.add', { type: c.type, name: displayName(item.track.name), sampleId, params: c.params });
      item.channelId = r.id;
      created.push(`"${displayName(item.track.name)}" → ${c.label}`);
    }

    const pat = () => deps.doc.project.patterns[patId];
    const offset = a.mode === 'append' ? patternLength(pat(), ts) : 0;
    const parts: string[] = [];
    const perChannel: Array<{ channel: string; id: string; notes: number; added: number; removed: number; unchanged?: boolean }> = [];
    let touched = createdPattern || created.length > 0;
    for (const item of plan) {
      const t = item.track;
      const chId = item.channelId!;
      const chName = safeName(deps.doc.project.channels[chId].name);
      const existing = Object.values(pat().notes[chId] ?? {});
      const incoming = t.notes.map((n) => ({ tick: n.tick + offset, key: n.key, dur: n.dur, vel: n.vel, slide: n.slide }));
      if (incoming.length > 10000) fail(`${chName}: ${incoming.length} notes is over the 10000-per-channel limit.`);
      let added = 0;
      let removed = 0;
      if (a.mode === 'replace') {
        if (sameNotes(existing, incoming)) {
          perChannel.push({ channel: chName, id: chId, notes: existing.length, added: 0, removed: 0, unchanged: true });
          parts.push(`${chName} unchanged (${existing.length})`);
          continue;
        }
        ctx.exec('notes.replace', { patternId: patId, channelId: chId, notes: incoming });
        added = incoming.length;
        removed = existing.length;
      } else if (a.mode === 'merge') {
        const removeIds = new Set<string>();
        for (const c of t.clears) for (const e of existing) if (e.tick >= c.tick && e.tick < c.tick + c.dur) removeIds.add(e.id);
        const toAdd: typeof incoming = [];
        for (const n of incoming) {
          const dup = existing.find((e) => e.tick === n.tick && e.key === n.key && !removeIds.has(e.id));
          if (dup) {
            if (sig(dup) === sig(n)) continue;
            removeIds.add(dup.id);
          }
          toAdd.push(n);
        }
        if (removeIds.size) ctx.exec('notes.remove', { patternId: patId, channelId: chId, ids: [...removeIds] });
        if (toAdd.length) ctx.exec('notes.add', { patternId: patId, channelId: chId, notes: toAdd });
        added = toAdd.length;
        removed = removeIds.size;
      } else {
        if (incoming.length) ctx.exec('notes.add', { patternId: patId, channelId: chId, notes: incoming });
        added = incoming.length;
      }
      if (added || removed) touched = true;
      const now = Object.keys(pat().notes[chId] ?? {}).length;
      perChannel.push({ channel: chName, id: chId, notes: now, added, removed });
      parts.push(`${chName} ${now} note${now === 1 ? '' : 's'} (+${added}/−${removed})`);
    }

    // Pattern length from the header (never silently truncating other channels).
    const warnings: string[] = parsed.warnings.map((w) => w.message);
    const curLen = patternLength(pat(), ts);
    let lengthNote = '';
    if (a.mode === 'append') {
      const newLen = offset + parsed.totalTicks;
      if (newLen !== curLen) {
        ctx.exec('patterns.set', { id: patId, length: newLen });
        lengthNote = ` Pattern is now ${newLen / barTicks} bars.`;
        touched = true;
      }
    } else if (parsed.header.bars) {
      const want = parsed.header.bars * barTicks;
      if (want !== pat().length) {
        const writtenIds = new Set(plan.map((x) => x.channelId));
        const blockers = Object.entries(pat().notes)
          .filter(([chId, byId]) => !writtenIds.has(chId) && Object.values(byId).some((n) => n.tick + n.dur > want))
          .map(([chId]) => safeName(deps.doc.project.channels[chId]?.name ?? chId));
        if (want < curLen && (a.mode === 'merge' || blockers.length)) {
          warnings.push(`kept the pattern at ${curLen / barTicks} bars (bars=${parsed.header.bars} would cut ${blockers.length ? blockers.join(', ') : 'existing notes'}); use create_pattern or clear_pattern first to shorten it`);
        } else {
          ctx.exec('patterns.set', { id: patId, length: want });
          lengthNote = ` Pattern length set to ${parsed.header.bars} bar${parsed.header.bars === 1 ? '' : 's'}.`;
          touched = true;
        }
      }
    }
    if (parsed.header.swing !== null) warnings.push(`swing=${parsed.header.swing} in the header is not applied (swing is global): call set_swing`);

    // Musical warnings the model can act on without hearing.
    const key = parsed.header.key ? parseKey(parsed.header.key) : null;
    if (key) {
      const outs: string[] = [];
      for (const item of plan) {
        const ch = deps.doc.project.channels[item.channelId!];
        if (isDrumChannel(ch) || item.track.kind === 'grid') continue;
        for (const n of item.track.notes) if (!inScale(n.key, key)) outs.push(`${safeName(ch.name)} ${noteName(n.key)} @${fmtPos(n.tick + offset, ts)}`);
      }
      if (outs.length) warnings.push(`${plural(outs.length, 'note')} outside ${parsed.header.key}: ${outs.slice(0, 8).join(', ')}${outs.length > 8 ? ', …' : ''}`);
    }
    for (const item of plan) {
      const ch = deps.doc.project.channels[item.channelId!];
      if (ch.generator.type === 'krypt.kick808' && item.track.notes.some((n) => n.key > 64)) warnings.push(`${safeName(ch.name)}: 808 notes above E4 sound thin; 808 basslines usually sit in octaves 1-2`);
      if (item.track.notes.some((n) => n.key < 12 || n.key > 108)) warnings.push(`${safeName(ch.name)}: some notes are outside C0..C8 and may be inaudible`);
    }

    if (!touched) {
      fail(`No change: pattern "${safeName(pat().name)}" already contains exactly these notes (${parts.join(', ')}).`);
    }
    const patName = safeName(pat().name);
    let message = `${createdPattern ? 'Created and wrote' : 'Wrote'} pattern "${patName}" (${patId}, ${a.mode}): ${parts.join(', ')}.${lengthNote}`;
    if (created.length) message += ` Created channel${created.length === 1 ? '' : 's'} ${created.join(', ')}.`;
    let text: string | undefined;
    if (a.echo) text = patternKpn(deps, patId, plan.map((x) => x.channelId!), parsed.header.key).text;
    return { ok: true, message, changed: [], data: { patternId: patId, channels: perChannel, createdPattern }, text, warnings };
  },
});

export const readPattern = defineTool({
  name: 'read_pattern',
  title: 'Read a pattern (canonical KPN)',
  kind: 'read',
  description:
    'Read a pattern back as canonical KPN — exactly the notation write_pattern accepts, so you can edit and resend it. Drum channels print as step grids, pitched channels as note tokens. format "json" returns exact ticks (PPQ 960) and note ids for add_notes/transform_notes work. Default: the active pattern, every channel with notes.',
  input: z.object({
    pattern: z.string().max(80).optional().describe('Pattern id or name (default: active pattern).'),
    channels: z.array(z.string()).max(64).optional().describe('Only these channels (names or ids), including empty ones.'),
    key: z.string().max(16).optional().describe('Key to print in the header (e.g. "F#m"); also picks sharp/flat spelling.'),
    format: z.enum(['kpn', 'json']).default('kpn'),
  }),
  run(deps, _c, a) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ids = a.channels ? a.channels.map((r) => findChannel(p, r).id) : undefined;
    if (a.format === 'json') {
      const chIds = ids ?? p.channelOrder.filter((id) => Object.keys(pat.notes[id] ?? {}).length > 0);
      const channels = chIds.map((id) => ({
        id,
        name: safeName(p.channels[id].name),
        notes: Object.values(pat.notes[id] ?? {})
          .sort((x, y) => x.tick - y.tick || x.key - y.key)
          .map((n) => ({ id: n.id, tick: n.tick, dur: n.dur, key: n.key, note: noteName(n.key), vel: midiVelocity(n.vel), ...(n.slide ? { slide: true } : {}) })),
      }));
      const total = channels.reduce((s, c) => s + c.notes.length, 0);
      return {
        ok: true,
        message: `Pattern "${safeName(pat.name)}" (${pat.id}): ${plural(total, 'note')} on ${plural(channels.length, 'channel')}, ${patternBars(p, pat.id)} bars, PPQ ${PPQ} (a 16th = ${PPQ / 4} ticks).`,
        changed: [],
        data: { patternId: pat.id, name: safeName(pat.name), lengthTicks: patternLength(pat, p.transport.timeSig), channels },
      };
    }
    const r = patternKpn(deps, pat.id, ids, a.key ?? null);
    const msg = `Pattern "${safeName(pat.name)}" (${pat.id}): ${plural(r.notes, 'note')} on ${plural(r.channels, 'channel')}.${r.channels === 0 ? ' It is empty.' : ''}`;
    return { ok: true, message: msg, changed: [], text: r.text, warnings: r.warnings, data: { patternId: pat.id } };
  },
});

const zNoteIn = z.object({
  key: z.union([z.number().int().min(0).max(127), z.string().max(6)]).describe('MIDI number or note name ("C4" = 60).'),
  at: z.union([z.string(), z.number()]).optional().describe('"bar.step" in 16th steps, 1-based ("2.5" = bar 2, 5th 16th). Default "1".'),
  tick: z.number().int().min(0).optional().describe('Exact start in ticks (PPQ 960) instead of `at`.'),
  len: z.number().positive().optional().describe('Length in 16th steps (default 1).'),
  dur: z.number().int().min(1).optional().describe('Exact length in ticks instead of `len`.'),
  vel: z.number().int().min(1).max(127).optional().describe('Velocity 1..127 (default 100).'),
  slide: z.boolean().optional(),
});

export const addNotes = defineTool({
  name: 'add_notes',
  title: 'Add notes (precise)',
  kind: 'write',
  description:
    'Add individual notes to one channel of a pattern with exact positions — the precise fallback when KPN is awkward (off-grid timing, a few fixes). Positions are "bar.step" (16th steps, 1-based) or exact ticks (PPQ 960). Example: {"channel":"Keys","notes":[{"key":"C4","at":"1.1","len":4},{"key":67,"tick":1920,"dur":480,"vel":90}]}',
  input: z.object({
    pattern: z.string().max(80).optional().describe('Pattern id or name (default: active).'),
    channel: z.string().describe('Channel name or id.'),
    notes: z.array(zNoteIn).min(1).max(2000),
    change_label: zLabel,
  }),
  summarize: (a) => `${plural(a.notes.length, 'note')} → ${safeName(a.channel, 30)}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const ts = p.transport.timeSig;
    const notes = a.notes.map((n, i) => {
      const key = typeof n.key === 'number' ? n.key : parseNoteName(n.key);
      if (key === null) fail(`notes[${i}].key "${safeName(String(n.key), 10)}" isn't a note name like C4 or a MIDI number`);
      const tick = n.tick ?? parsePosition(n.at ?? '1', ts);
      const dur = n.dur ?? Math.max(1, Math.round((n.len ?? 1) * (PPQ / 4)));
      return { tick, key, dur, vel: (n.vel ?? 100) / 127, slide: n.slide ?? false };
    });
    const r = ctx.exec<{ ids: string[] }>('notes.add', { patternId: pat.id, channelId: ch.id, notes });
    const total = Object.keys(deps.doc.project.patterns[pat.id].notes[ch.id] ?? {}).length;
    return { ok: true, message: `Added ${plural(r.ids.length, 'note')} to ${safeName(ch.name)} in "${safeName(pat.name)}" (now ${total}).`, changed: [], data: { ids: r.ids } };
  },
});

export const clearPattern = defineTool({
  name: 'clear_pattern',
  title: 'Clear pattern notes',
  kind: 'destructive',
  description: 'Delete every note in a pattern, or only the listed channels. The pattern itself stays (use delete_objects to remove it). Undo with undo_last.',
  input: z.object({
    pattern: z.string().max(80).optional().describe('Pattern id or name (default: active).'),
    channels: z.array(z.string()).max(64).optional().describe('Only these channels (default: all).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.pattern ?? 'active', 30)}${a.channels ? ` (${a.channels.length} ch)` : ''}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    let removed = 0;
    if (a.channels) {
      for (const ref of a.channels) {
        const ch = findChannel(p, ref);
        const n = Object.keys(pat.notes[ch.id] ?? {}).length;
        if (n) {
          ctx.exec('notes.clear', { patternId: pat.id, channelId: ch.id });
          removed += n;
        }
      }
    } else {
      removed = Object.values(pat.notes).reduce((s, b) => s + Object.keys(b).length, 0);
      if (removed) ctx.exec('notes.clear', { patternId: pat.id });
    }
    if (!removed) fail(`No change: "${safeName(pat.name)}" had no notes ${a.channels ? 'on those channels' : ''} to clear.`);
    return { ok: true, message: `Cleared ${plural(removed, 'note')} from "${safeName(pat.name)}" (${pat.id}).`, changed: [] };
  },
});

export const createPattern = defineTool({
  name: 'create_pattern',
  title: 'Create a pattern',
  kind: 'write',
  description: 'Create a new empty pattern (or a copy of one with clone_from) and make it active unless select is false. bars fixes its length. Returns the id. Tip: write_pattern with pattern:"new:Name" creates and fills in one call.',
  input: z.object({
    name: z.string().min(1).max(64),
    bars: z.number().int().min(1).max(256).optional(),
    clone_from: z.string().max(80).optional().describe('Copy this pattern (id or name) instead of starting empty.'),
    select: z.boolean().default(true),
    change_label: zLabel,
  }),
  summarize: (a) => `"${safeName(a.name, 40)}"`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const bar = ticksPerBar(p.transport.timeSig);
    let id: string;
    if (a.clone_from) {
      const src = findPattern(p, a.clone_from);
      id = ctx.exec<{ id: string }>('patterns.clone', { id: src.id, name: safeName(a.name, 64), select: a.select }).id;
      if (a.bars) ctx.exec('patterns.set', { id, length: a.bars * bar });
    } else {
      id = ctx.exec<{ id: string }>('patterns.add', { name: safeName(a.name, 64), select: a.select, length: a.bars ? a.bars * bar : null }).id;
    }
    const bars = patternBars(deps.doc.project, id);
    return { ok: true, message: `Created pattern "${safeName(a.name)}" (${id}, ${bars} bar${bars === 1 ? '' : 's'})${a.clone_from ? ' as a copy' : ''}${a.select ? ', now active' : ''}.`, changed: [], data: { id } };
  },
});

export const selectPattern = defineTool({
  name: 'select_pattern',
  title: 'Select the active pattern',
  kind: 'write',
  description: 'Make a pattern the active one: it is what plays in pattern mode and what the Channel Rack and Piano Roll show.',
  input: z.object({ pattern: z.string().max(80) }),
  summarize: (a) => safeName(a.pattern, 40),
  run(deps, _c, a, ctx) {
    const pat = findPattern(deps.doc.project, a.pattern);
    if (deps.doc.project.transport.activePatternId === pat.id) fail(`No change: "${safeName(pat.name)}" is already the active pattern.`);
    ctx.exec('patterns.select', { id: pat.id });
    return { ok: true, message: `"${safeName(pat.name)}" (${pat.id}) is now the active pattern.`, changed: [] };
  },
});

// ── transform_notes ─────────────────────────────────────────────────────

const zOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('transpose'), semitones: z.number().int().min(-48).max(48).optional(), degrees: z.number().int().min(-21).max(21).optional(), key: z.string().max(16).optional().describe('Key for degree transposition, e.g. "Am".') }),
  z.object({ op: z.literal('shift'), steps: z.number().min(-1024).max(1024).describe('16th steps; negative = earlier.') }),
  z.object({ op: z.literal('velocity'), set: z.number().int().min(1).max(127).optional(), scale: z.number().min(0).max(4).optional(), ramp: z.tuple([z.number().int().min(1).max(127), z.number().int().min(1).max(127)]).optional() }),
  z.object({ op: z.literal('quantize'), grid: z.number().int().min(1).max(192).default(16).describe('Steps per bar (16 = 16ths, 12/24 triplets).'), strength: z.number().min(0).max(1).default(1), ends: z.boolean().default(false), swing: z.number().min(0).max(1).default(0).describe('0..1: delays every 2nd grid line by up to half a cell.') }),
  z.object({ op: z.literal('humanize'), timing_ms: z.number().min(0).max(60).default(8), velocity: z.number().int().min(0).max(40).default(8), seed: z.number().int().optional() }),
  z.object({ op: z.literal('length'), steps: z.number().positive().max(1024).optional().describe('Set every note to this many 16th steps.'), scale: z.number().min(0.05).max(16).optional() }),
  z.object({ op: z.literal('legato'), gap_ticks: z.number().int().min(0).max(960).default(0) }),
  z.object({ op: z.literal('reverse') }),
  z.object({ op: z.literal('invert'), axis: z.union([z.string(), z.number()]).optional().describe('Pivot note (default: first note).') }),
  z.object({ op: z.literal('strum'), ms: z.number().min(1).max(200).default(25), direction: z.enum(['up', 'down']).default('up') }),
  z.object({ op: z.literal('chop'), steps: z.number().int().min(1).max(64).describe('Split notes into repeated notes this many 16th steps long.') }),
  z.object({
    op: z.literal('groove'),
    template: z.enum(GROOVE_IDS as [string, ...string[]]).describe('Groove template: the timing and accents of real drummers in that style (Groove MIDI Dataset, CC BY 4.0).'),
    amount: z.number().min(0).max(1).default(1).describe('Timing: 0..1 of the template\'s per-16th offsets (1 = as measured).'),
    velocity: z.number().min(0).max(1).default(0.5).describe('0..1: how strongly the template\'s accents shape velocities.'),
    instrument: z.enum(['kick', 'snare', 'hihat', 'other']).optional().describe('Which drum\'s statistics to use. Default: from the channel name (Kick, Snare/Clap, Hat/Ride; anything else = other).'),
  }),
]);

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const zNoteSelect = z.object({ bars: z.string().optional().describe('"1-4"'), pitch: z.string().optional().describe('"C3-C5"') });

/** One channel's notes in a pattern, narrowed by an optional bars / pitch selection. */
export function selectNotes(p: Project, pat: Pattern, ch: Channel, select?: z.infer<typeof zNoteSelect>): Note[] {
  const ts = p.transport.timeSig;
  let sel = Object.values(pat.notes[ch.id] ?? {}) as Note[];
  if (select?.bars) {
    const r = parseBarRange(select.bars, ts);
    sel = sel.filter((n) => n.tick >= r.start && n.tick < r.end);
  }
  if (select?.pitch) {
    const m = /^\s*([A-Ga-g][#b]?-?\d+|\d+)\s*-\s*([A-Ga-g][#b]?-?\d+|\d+)\s*$/.exec(select.pitch);
    if (!m) fail('select.pitch must look like "C3-C5"');
    const lo = /^\d+$/.test(m[1]) ? Number(m[1]) : parseNoteName(m[1]);
    const hi = /^\d+$/.test(m[2]) ? Number(m[2]) : parseNoteName(m[2]);
    if (lo === null || hi === null) fail('select.pitch has an invalid note name');
    sel = sel.filter((n) => n.key >= lo && n.key <= hi);
  }
  if (!sel.length) fail(`No change: ${safeName(ch.name)} has no notes${select ? ' in that selection' : ''} in "${safeName(pat.name)}".`);
  return sel;
}

interface WNote {
  id: string | null;
  tick: number;
  dur: number;
  key: number;
  vel: number;
  slide: boolean;
}

export const transformNotes = defineTool({
  name: 'transform_notes',
  title: 'Transform notes',
  kind: 'write',
  description:
    'Deterministic piano-roll operators on one channel of a pattern (all notes, or a selection by bars / pitch range), applied in order as ONE undo step. ops: transpose {semitones | degrees + key}, shift {steps}, velocity {set | scale | ramp:[from,to]}, quantize {grid, strength, ends, swing}, humanize {timing_ms, velocity}, length {steps | scale}, legato, reverse, invert {axis}, strum {ms}, chop {steps}, groove {template, amount, velocity, instrument} = the timing and accents of real drummers per 16th step (templates: ' +
    GROOVE_IDS.join(', ') +
    '; use it on drum channels, and the same template on bass/keys to lock them to the drums; instrument comes from the channel name). For arpeggios, glue, scale snap, key limits, pan/mod/fine shaping and mute/colour/slide flags use shape_notes. Example: {"channel":"Keys","select":{"bars":"1-2"},"ops":[{"op":"transpose","degrees":2,"key":"Am"},{"op":"humanize","timing_ms":6}]}',
  input: z.object({
    pattern: z.string().max(80).optional(),
    channel: z.string(),
    select: zNoteSelect.optional(),
    ops: z.array(zOp).min(1).max(16),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel, 30)}: ${a.ops.map((o) => o.op).join(', ')}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const bar = ticksPerBar(p.transport.timeSig);
    const sel = selectNotes(p, pat, ch, a.select);

    let work: WNote[] = sel.map((n) => ({ id: n.id, tick: n.tick, dur: n.dur, key: n.key, vel: n.vel, slide: n.slide })).sort((x, y) => x.tick - y.tick || x.key - y.key);
    const removedIds = new Set<string>();
    const msPerTick = 60000 / p.transport.bpm / PPQ;
    for (const op of a.ops) {
      switch (op.op) {
        case 'transpose': {
          if (op.degrees) {
            const k = parseKey(op.key ?? '');
            if (!k) fail('transpose by degrees needs key (e.g. "Am")');
            const steps = SCALES[k.scale] ?? SCALES.major;
            const scaleNotes: number[] = [];
            for (let m = 0; m < 128; m++) if (steps.includes((((m - k.root) % 12) + 12) % 12)) scaleNotes.push(m);
            work = work.map((n) => {
              let idx = scaleNotes.findIndex((s) => s > n.key) - 1;
              if (idx < 0) idx = n.key >= scaleNotes[scaleNotes.length - 1] ? scaleNotes.length - 1 : 0;
              const off = n.key - scaleNotes[idx];
              const target = scaleNotes[Math.max(0, Math.min(scaleNotes.length - 1, idx + op.degrees!))];
              return { ...n, key: Math.max(0, Math.min(127, target + off)) };
            });
          }
          if (op.semitones) work = work.map((n) => ({ ...n, key: Math.max(0, Math.min(127, n.key + op.semitones!)) }));
          if (!op.degrees && !op.semitones) fail('transpose needs semitones or degrees');
          break;
        }
        case 'shift':
          work = work.map((n) => ({ ...n, tick: Math.max(0, Math.round(n.tick + op.steps * (PPQ / 4))) }));
          break;
        case 'velocity': {
          if (op.set !== undefined) work = work.map((n) => ({ ...n, vel: op.set! / 127 }));
          if (op.scale !== undefined) work = work.map((n) => ({ ...n, vel: Math.min(1, Math.max(1 / 127, n.vel * op.scale!)) }));
          if (op.ramp) {
            const t0 = work[0].tick;
            const t1 = work[work.length - 1].tick;
            work = work.map((n) => ({ ...n, vel: (op.ramp![0] + ((op.ramp![1] - op.ramp![0]) * (t1 > t0 ? (n.tick - t0) / (t1 - t0) : 0))) / 127 }));
          }
          break;
        }
        case 'quantize': {
          const g = bar / op.grid;
          if (!Number.isInteger(g)) fail(`quantize grid ${op.grid} doesn't divide the bar evenly`);
          const snap = (t: number) => (op.swing > 0 ? swungGridLine(t, g, op.swing) : Math.round(t / g) * g);
          work = work.map((n) => {
            const q = snap(n.tick);
            const end = n.tick + n.dur;
            const tick = Math.max(0, Math.round(n.tick + (q - n.tick) * op.strength));
            let dur = Math.max(1, end - tick);
            if (op.ends) {
              const qe = Math.max(tick + g, snap(end));
              dur = Math.max(1, Math.round(end + (qe - end) * op.strength) - tick);
            }
            return { ...n, tick, dur };
          });
          break;
        }
        case 'humanize': {
          const rnd = mulberry(op.seed ?? 0x6b727970);
          const tTicks = op.timing_ms / msPerTick;
          work = work.map((n) => ({
            ...n,
            tick: Math.max(0, Math.round(n.tick + (rnd() * 2 - 1) * tTicks)),
            vel: Math.min(1, Math.max(1 / 127, n.vel + ((rnd() * 2 - 1) * op.velocity) / 127)),
          }));
          break;
        }
        case 'length':
          if (op.steps !== undefined) work = work.map((n) => ({ ...n, dur: Math.max(1, Math.round(op.steps! * (PPQ / 4))) }));
          if (op.scale !== undefined) work = work.map((n) => ({ ...n, dur: Math.max(1, Math.round(n.dur * op.scale!)) }));
          if (op.steps === undefined && op.scale === undefined) fail('length needs steps or scale');
          break;
        case 'legato': {
          const starts = [...new Set(work.map((n) => n.tick))].sort((x, y) => x - y);
          work = work.map((n) => {
            const next = starts.find((s) => s > n.tick);
            return next === undefined ? n : { ...n, dur: Math.max(1, next - n.tick - op.gap_ticks) };
          });
          break;
        }
        case 'reverse': {
          const t0 = Math.min(...work.map((n) => n.tick));
          const t1 = Math.max(...work.map((n) => n.tick + n.dur));
          work = work.map((n) => ({ ...n, tick: t0 + (t1 - (n.tick + n.dur)) }));
          break;
        }
        case 'invert': {
          const axis = op.axis === undefined ? work[0].key : typeof op.axis === 'number' ? op.axis : parseNoteName(op.axis);
          if (axis === null) fail('invert axis must be a note name or MIDI number');
          work = work.map((n) => ({ ...n, key: Math.max(0, Math.min(127, 2 * axis - n.key)) }));
          break;
        }
        case 'strum': {
          const off = Math.round(op.ms / msPerTick);
          const byTick = new Map<number, WNote[]>();
          for (const n of work) byTick.set(n.tick, [...(byTick.get(n.tick) ?? []), n]);
          const out: WNote[] = [];
          for (const group of byTick.values()) {
            const sorted = [...group].sort((x, y) => (op.direction === 'up' ? x.key - y.key : y.key - x.key));
            sorted.forEach((n, i) => out.push({ ...n, tick: n.tick + i * off, dur: Math.max(1, n.dur - i * off) }));
          }
          work = out;
          break;
        }
        case 'chop': {
          const piece = op.steps * (PPQ / 4);
          const out: WNote[] = [];
          for (const n of work) {
            if (n.dur <= piece) {
              out.push(n);
              continue;
            }
            if (n.id) removedIds.add(n.id);
            for (let t = n.tick; t < n.tick + n.dur; t += piece) out.push({ ...n, id: null, tick: t, dur: Math.min(piece, n.tick + n.dur - t) });
          }
          work = out;
          break;
        }
        case 'groove': {
          const ts = p.transport.timeSig;
          work = applyGroove(work, {
            template: op.template,
            amount: op.amount,
            velocity: op.velocity,
            ppq: PPQ,
            class: op.instrument ?? grooveClassForChannel(ch.name),
            length: patternLength(pat, ts),
            stepsPerBar: Math.round(bar / (PPQ / 4)),
          });
          break;
        }
      }
    }

    const byId = new Map(sel.map((n) => [n.id, n]));
    const updates: Array<Record<string, unknown>> = [];
    const adds: Array<{ tick: number; key: number; dur: number; vel: number; slide: boolean }> = [];
    for (const n of work) {
      if (n.id && !removedIds.has(n.id)) {
        const o = byId.get(n.id)!;
        const u: Record<string, unknown> = { id: n.id };
        if (o.tick !== n.tick) u.tick = n.tick;
        if (o.dur !== n.dur) u.dur = n.dur;
        if (o.key !== n.key) u.key = n.key;
        if (Math.abs(o.vel - n.vel) > 1e-9) u.vel = Math.min(1, Math.max(0, n.vel));
        if (Object.keys(u).length > 1) updates.push(u);
      } else if (!n.id) adds.push({ tick: n.tick, key: n.key, dur: n.dur, vel: Math.min(1, Math.max(0, n.vel)), slide: n.slide });
    }
    const steps: Array<{ cmd: string; args: unknown }> = [];
    if (removedIds.size) steps.push({ cmd: 'notes.remove', args: { patternId: pat.id, channelId: ch.id, ids: [...removedIds] } });
    if (updates.length) steps.push({ cmd: 'notes.update', args: { patternId: pat.id, channelId: ch.id, updates } });
    if (adds.length) steps.push({ cmd: 'notes.add', args: { patternId: pat.id, channelId: ch.id, notes: adds } });
    if (!steps.length) fail(`No change: the ops left all ${plural(sel.length, 'note')} of ${safeName(ch.name)} exactly as they were.`);
    ctx.execBatch(steps);
    return {
      ok: true,
      message: `Transformed ${plural(sel.length, 'note')} of ${safeName(ch.name)} in "${safeName(pat.name)}" (${a.ops.map((o) => (o.op === 'groove' ? `groove ${o.template}` : o.op)).join(' → ')}): ${updates.length} edited, ${adds.length} added, ${removedIds.size} removed.`,
      changed: [],
    };
  },
});

// ── delete_objects ──────────────────────────────────────────────────────

export const deleteObjects = defineTool({
  name: 'delete_objects',
  title: 'Delete channels, patterns, effects…',
  kind: 'destructive',
  description:
    'Delete project objects by name or id: channels (and their notes everywhere), patterns (and their playlist clips), effects ({insert, effect}), mixer inserts, automation clips, markers, samples (from the sample pool: id, name, file name or path, or "unused" for every sample nothing plays; one still in use is refused with who uses it), scripts (project Krypt Scripts by name or id; the notes they wrote stay). Everything is undoable with undo_last. Use remove_clips for playlist clips.',
  input: z.object({
    channels: z.array(z.string()).max(64).optional(),
    patterns: z.array(z.string()).max(64).optional(),
    effects: z.array(z.object({ insert: z.union([z.string(), z.number()]), effect: z.union([z.string(), z.number()]) })).max(64).optional(),
    inserts: z.array(z.union([z.string(), z.number()])).max(64).optional(),
    automations: z.array(z.string()).max(64).optional(),
    markers: z.array(z.string()).max(64).optional(),
    samples: z.array(z.string().max(400)).max(256).optional().describe('Sample pool entries (id, name, file name or path), or ["unused"].'),
    scripts: z.array(z.string().max(80)).max(64).optional().describe('Project scripts (name or id).'),
    change_label: zLabel,
  }),
  summarize: (a) => {
    const n = (a.channels?.length ?? 0) + (a.patterns?.length ?? 0) + (a.effects?.length ?? 0) + (a.inserts?.length ?? 0) + (a.automations?.length ?? 0) + (a.markers?.length ?? 0) + (a.samples?.length ?? 0) + (a.scripts?.length ?? 0);
    return plural(n, 'object');
  },
  run(deps, _c, a, ctx) {
    const done: string[] = [];
    const p = () => deps.doc.project;
    const catalog = deps.doc.catalog;
    for (const ref of a.effects ?? []) {
      const ins = findInsert(p(), ref.insert);
      const slot = findSlot(ins, ref.effect, catalog);
      ctx.exec('mixer.removeSlot', { insertId: ins.id, slotId: slot });
      done.push(`effect ${pluginName(catalog, ins.slots[slot].type)} on ${safeName(ins.name)}`);
    }
    for (const ref of a.automations ?? []) {
      const aut = p().automations[ref] ?? Object.values(p().automations).find((x) => norm(x.name) === norm(ref));
      if (!aut) fail(`No automation "${safeName(ref)}"`);
      ctx.exec('automation.remove', { id: aut.id });
      done.push(`automation "${safeName(aut.name)}"`);
    }
    for (const ref of a.markers ?? []) {
      const m = p().playlist.markers[ref] ?? Object.values(p().playlist.markers).find((x) => norm(x.name) === norm(ref));
      if (!m) fail(`No marker "${safeName(ref)}"`);
      ctx.exec('playlist.removeMarker', { id: m.id });
      done.push(`marker "${safeName(m.name)}"`);
    }
    if (a.channels?.length) {
      const ids = a.channels.map((r) => findChannel(p(), r).id);
      const names = ids.map((id) => safeName(p().channels[id].name));
      ctx.exec('channels.remove', { ids: [...new Set(ids)] });
      done.push(`channel${ids.length === 1 ? '' : 's'} ${names.join(', ')}`);
    }
    for (const ref of a.patterns ?? []) {
      const pat = findPattern(p(), ref);
      ctx.exec('patterns.remove', { id: pat.id });
      done.push(`pattern "${safeName(pat.name)}"`);
    }
    for (const ref of a.inserts ?? []) {
      const ins = findInsert(p(), ref);
      ctx.exec('mixer.removeInsert', { id: ins.id });
      done.push(`insert "${safeName(ins.name)}"`);
    }
    for (const ref of a.scripts ?? []) {
      const list = Object.values(p().scripts ?? {});
      const s = p().scripts?.[ref] ?? list.find((x) => norm(x.name) === norm(ref));
      if (!s) fail(`No project script "${safeName(ref)}"${list.length ? ` (scripts: ${list.map((x) => `"${safeName(x.name)}"`).join(', ')})` : ' (this project keeps none)'}`);
      ctx.exec('scripts.remove', { id: s.id });
      done.push(`script "${safeName(s.name)}"`);
    }
    // Samples last: deleting a channel above frees its sample.
    if (a.samples?.length) {
      const unused = a.samples.some((r) => norm(r) === 'unused');
      const ids = new Set<string>();
      if (unused) for (const s of Object.values(p().samples)) if (!sampleUsers(p(), s.id).length) ids.add(s.id);
      for (const ref of a.samples) {
        if (norm(ref) === 'unused') continue;
        const s = findSample(p(), ref);
        const users = sampleUsers(p(), s.id);
        if (users.length) fail(`Sample "${safeName(s.name)}" is still used by ${users.join(', ')}: load another sample there or delete those channels first.`);
        ids.add(s.id);
      }
      if (unused && !ids.size && a.samples.every((r) => norm(r) === 'unused')) fail('No change: every sample in the pool is in use.');
      const names = [...ids].map((id) => safeName(p().samples[id].name));
      for (const id of ids) ctx.exec('samples.remove', { id });
      if (ids.size) done.push(ids.size === 1 ? `sample "${names[0]}"` : `${ids.size} samples (${names.slice(0, 8).join(', ')}${ids.size > 8 ? ', …' : ''})`);
    }
    if (!done.length) fail('Nothing to delete: pass channels, patterns, effects, inserts, automations, markers, samples or scripts.');
    return { ok: true, message: `Deleted ${done.join('; ')}.`, changed: [] };
  },
});

export const COMPOSE_TOOLS = [writePattern, readPattern, addNotes, transformNotes, clearPattern, createPattern, selectPattern, deleteObjects];
