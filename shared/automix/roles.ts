// ──────────────────────────────────────────────────────────────────────
// Auto Mix: what each mixer insert is (research/20 §3). Pure.
//
// Roles come from names (the insert's and its channels'), instruments,
// stem origins and, as a last resort, the insert's measured spectrum.
// Vocals: names ("Vocals", "Lead Vox", "· Vocals"), a stem sample whose
// origin is the vocal stem, the request's own list, or an audio channel
// whose analysis looks like a voice.
// ──────────────────────────────────────────────────────────────────────

import type { Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';

export type MixRole = 'kick' | 'snare' | 'hats' | 'perc' | 'bass' | 'keys' | 'lead' | 'vocal' | 'fx' | 'bus' | 'send' | 'other';
export const BANDS = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'] as const;
export type Band = (typeof BANDS)[number];
export type Bands = Record<Band, number>;

export interface InsertInfo {
  id: string;
  name: string;
  role: MixRole;
  vocal: boolean;
  /** How the role was found ("name", "instrument", "stem origin", "sound", "request"). */
  why: string;
  /** Channels feeding it. */
  channels: string[];
  /** Routes straight into the master. */
  topLevel: boolean;
  /** A bus fed by drum inserts / named "Drum Bus". */
  drumBus: boolean;
}

export interface SpectrumHint {
  bands: Bands | null;
  centroidHz?: number | null;
}

/** The names Auto Mix gives the send returns it creates (a re-run finds them by name). */
export const AUTO_SENDS = { reverb: 'Auto Reverb', delay: 'Auto Delay' } as const;

/** A whole song / instrumental bed ("lemezia 2 · Full mix", "Instrumental", "Beat"): never a vocal, never a drum. */
const BED_RE = /(full ?mix|instrumental|inst|beat|mixdown|karaoke|no vocals?|backing track)/i;

const RE: Array<[MixRole, RegExp]> = [
  ['vocal', /(vocal|\bvox\b|voice|acapella|a cappella|ad-?libs?|\bad lib|\brap\b|\bbgv|backing v|singer|lyrics|\bchant|\bhook vox)/i],
  ['kick', /(kick|\bkik\b|\bbd\b|bass ?drum)/i],
  ['snare', /(snare|clap|\bsd\b|\brim\b|rimshot|snap)/i],
  ['hats', /(hat|\bhh\b|hihat|cymbal|\bride\b|crash|shaker|tamb)/i],
  ['perc', /(perc|conga|bongo|\btoms?\b|cowbell|clave|woodblock|triangle|timbale)/i],
  ['bass', /(808|bass|\bsub\b|reese)/i],
  ['lead', /(lead|melody|\bhook\b|flute|\bsax|horn|trumpet|whistle|bell|pluck|\barp\b|arpeggio)/i],
  ['keys', /(keys?\b|piano|rhodes|organ|\bpad|chord|string|choir|e-?piano|\bep\b|guitar|\bgtr|synth|stab|mallet|marimba|vibes)/i],
  ['fx', /(\bfx\b|riser|sweep|impact|noise|uplift|downlift|whoosh|transition|vinyl|crackle|atmo|foley)/i],
];

function roleFromText(text: string): MixRole | null {
  for (const [role, re] of RE) if (re.test(text)) return role;
  return null;
}

const DRUMSYNTH_ROLE: Array<[RegExp, MixRole]> = [
  [/kick/i, 'kick'],
  [/snare|clap|rim/i, 'snare'],
  [/hat|cymbal|crash|ride/i, 'hats'],
];

/** The role a measured spectrum suggests (bands relative to their mids). */
export function roleFromSound(h: SpectrumHint | null | undefined): { role: MixRole; vocal: boolean } | null {
  const b = h?.bands;
  if (!b || !Number.isFinite(b.mid)) return null;
  const rel = (k: Band) => b[k] - b.mid;
  if (rel('sub') > 4 && rel('low') > 4) return { role: 'bass', vocal: false };
  if (rel('high') > 0 && rel('low') < -6) return { role: 'hats', vocal: false };
  const c = h?.centroidHz ?? null;
  if (c !== null && c >= 700 && c <= 4000 && rel('sub') < -10 && rel('low') < 0) return { role: 'vocal', vocal: true };
  return null;
}

export interface RoleOptions {
  /** Inserts (ids or names) the request says are vocals. */
  vocalInserts?: string[];
  /** Measured spectrum per insert (stem render), for the fallback. */
  sound?: Record<string, SpectrumHint | undefined>;
}

/** Every non-master insert's role. */
export function detectRoles(p: Project, catalog: PluginCatalog, opts: RoleOptions = {}): Record<string, InsertInfo> {
  const out: Record<string, InsertInfo> = {};
  const masterId = p.mixer.masterId;
  const feeders = new Map<string, string[]>();
  for (const id of p.mixer.insertOrder) {
    for (const to of Object.keys(p.mixer.inserts[id]?.routes ?? {})) {
      if (!feeders.has(to)) feeders.set(to, []);
      feeders.get(to)!.push(id);
    }
  }
  const asked = new Set((opts.vocalInserts ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  for (const id of p.mixer.insertOrder) {
    const ins = p.mixer.inserts[id];
    if (!ins || ins.isMaster) continue;
    const channels = p.channelOrder.filter((c) => p.channels[c]?.insertId === id);
    const fedBy = feeders.get(id) ?? [];
    let role: MixRole | null = null;
    let why = '';
    let vocal = false;
    if (asked.has(id.toLowerCase()) || asked.has(ins.name.trim().toLowerCase())) {
      role = 'vocal';
      vocal = true;
      why = 'request';
    }
    const autoSend = ins.name === AUTO_SENDS.reverb || ins.name === AUTO_SENDS.delay;
    const wetOnly = ins.slotOrder.length > 0 && ins.slotOrder.every((s) => ['krypt.reverb', 'krypt.delay', 'krypt.tapeecho', 'krypt.eq', 'krypt.grain'].includes(ins.slots[s]?.type ?? '')) && ins.slotOrder.some((s) => ['krypt.reverb', 'krypt.delay', 'krypt.tapeecho'].includes(ins.slots[s]?.type ?? ''));
    if (!role && (autoSend || (!channels.length && fedBy.length && (wetOnly || /(reverb|verb|delay|echo|send|return)/i.test(ins.name))))) {
      role = 'send';
      why = 'send return';
    }
    if (!role && !channels.length && fedBy.length) {
      role = 'bus';
      why = 'bus';
    }
    if (!role) {
      // Stem origin: a vocal stem sample on a channel of this insert.
      for (const c of channels) {
        const ch = p.channels[c];
        const s = ch.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
        if (s?.origin?.kind === 'stem' && s.origin.stem === 'vocals') {
          role = 'vocal';
          vocal = true;
          why = 'stem origin';
          break;
        }
      }
    }
    if (!role && BED_RE.test(`${ins.name} ${channels.map((c) => p.channels[c].name).join(' ')}`)) {
      role = 'other';
      why = 'name (full mix / instrumental)';
    }
    if (!role) {
      const fromName = roleFromText(ins.name) ?? roleFromText(channels.map((c) => p.channels[c].name).join(' '));
      if (fromName) {
        role = fromName;
        vocal = fromName === 'vocal';
        why = 'name';
      }
    }
    if (!role) {
      for (const c of channels) {
        const g = p.channels[c].generator;
        if (g.type === 'krypt.kick808') {
          role = 'kick';
          why = 'instrument';
          break;
        }
        if (g.type === 'krypt.drumsynth') {
          const spec = catalog.plugins.find((x) => x.id === g.type)?.params.find((x) => x.id === 'voice');
          const label = spec?.options?.[Math.round(g.params.voice ?? spec.default)] ?? '';
          const hit = DRUMSYNTH_ROLE.find(([re]) => re.test(label));
          role = hit ? hit[1] : 'perc';
          why = 'instrument';
          break;
        }
      }
    }
    if (!role) {
      const audio = channels.length > 0 && channels.every((c) => p.channels[c].generator.type === 'krypt.audioclip');
      const s = roleFromSound(opts.sound?.[id]);
      if (s && (!s.vocal || audio)) {
        role = s.role;
        vocal = s.vocal;
        why = 'sound';
      }
    }
    const isBus = role === 'bus';
    const drumBus = isBus && (/drum|beat|perc/i.test(ins.name) || (fedBy.length > 0 && fedBy.every((f) => ['kick', 'snare', 'hats', 'perc'].includes(out[f]?.role ?? roleFromText(p.mixer.inserts[f]?.name ?? '') ?? ''))));
    out[id] = { id, name: ins.name, role: role ?? 'other', vocal, why: why || 'unknown', channels, topLevel: ins.routes[masterId] !== undefined, drumBus };
  }
  // A bus fed only by vocals is a vocal bus (its level counts as the vocal, but its chain is left alone).
  return out;
}

/** The ids of the vocal inserts. */
export function vocalIds(roles: Record<string, InsertInfo>): string[] {
  return Object.values(roles)
    .filter((r) => r.vocal)
    .map((r) => r.id);
}
