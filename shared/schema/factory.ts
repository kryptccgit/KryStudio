import { newId, ID_PREFIX } from './ids';
import { PPQ, ticksPerBar } from './time';
import {
  SCHEMA_VERSION,
  DEFAULT_CHANNEL_VOLUME,
  paletteColor,
  type Channel,
  type FxSlot,
  type MixerInsert,
  type Pattern,
  type PlaylistTrack,
  type Project,
  type SampleRef,
} from './project';

export function makeInsert(name: string, color: string, masterId: string | null, isMaster = false): MixerInsert {
  return {
    id: newId(ID_PREFIX.insert),
    name,
    color,
    volume: 1,
    pan: 0,
    stereoSep: 0,
    mute: false,
    solo: false,
    phaseInvert: false,
    swapLR: false,
    slots: {},
    slotOrder: [],
    routes: masterId ? { [masterId]: 1 } : {},
    isMaster,
  };
}

export function makeSlot(type: string, mix = 1, params: Record<string, number> = {}): FxSlot {
  return { id: newId(ID_PREFIX.slot), type, enabled: true, mix, params: { ...params }, sidechainFrom: null };
}

export function makeChannel(opts: {
  name: string;
  type: string;
  insertId: string;
  color: string;
  sampleId?: string | null;
  params?: Record<string, number>;
}): Channel {
  return {
    id: newId(ID_PREFIX.channel),
    name: opts.name,
    color: opts.color,
    generator: { type: opts.type, params: { ...(opts.params ?? {}) }, sampleId: opts.sampleId ?? null },
    volume: DEFAULT_CHANNEL_VOLUME,
    pan: 0,
    pitch: 0,
    mute: false,
    insertId: opts.insertId,
    rootKey: 60,
    swing: 1,
    poly: { mono: false, glideMs: 0, cutGroup: 0, cutBy: 0 },
  };
}

export function makePattern(name: string, color: string): Pattern {
  return { id: newId(ID_PREFIX.pattern), name, color, length: null, notes: {} };
}

export function makeTrack(name: string, color = '#3F3F52'): PlaylistTrack {
  return { id: newId(ID_PREFIX.track), name, color, height: 44, mute: false, solo: false };
}

export function makeSample(path: string, name?: string): SampleRef {
  const base = name ?? path.split(/[\\/:]/).pop() ?? 'Sample';
  return { id: newId(ID_PREFIX.sample), name: base.replace(/\.[a-z0-9]+$/i, ''), path };
}

export const FACTORY_KIT = {
  kick: 'factory:drums/kick.wav',
  clap: 'factory:drums/clap.wav',
  hat: 'factory:drums/hat-closed.wav',
  openHat: 'factory:drums/hat-open.wav',
  snare: 'factory:drums/snare.wav',
};

export function createDefaultProject(name = 'Untitled'): Project {
  const master = makeInsert('Master', '#A855F7', null, true);
  const limiter = makeSlot('krypt.limiter', 1, { ceiling: -1 });
  master.slots[limiter.id] = limiter;
  master.slotOrder.push(limiter.id);

  const inserts: Record<string, MixerInsert> = { [master.id]: master };
  const insertOrder = [master.id];
  const samples: Record<string, SampleRef> = {};
  const channels: Record<string, Channel> = {};
  const channelOrder: string[] = [];

  const add = (chName: string, type: string, sample?: string, params?: Record<string, number>, poly?: Partial<Channel['poly']>) => {
    const color = paletteColor(channelOrder.length);
    const ins = makeInsert(chName, color, master.id);
    inserts[ins.id] = ins;
    insertOrder.push(ins.id);
    let sampleId: string | null = null;
    if (sample) {
      const s = makeSample(sample, `${chName}.wav`);
      samples[s.id] = s;
      sampleId = s.id;
    }
    const ch = makeChannel({ name: chName, type, insertId: ins.id, color, sampleId, params });
    if (poly) ch.poly = { ...ch.poly, ...poly };
    channels[ch.id] = ch;
    channelOrder.push(ch.id);
    return ch;
  };

  add('Kick', 'krypt.sampler', FACTORY_KIT.kick);
  add('Clap', 'krypt.sampler', FACTORY_KIT.clap);
  add('Hat', 'krypt.sampler', FACTORY_KIT.hat, undefined, { cutGroup: 1, cutBy: 1 });
  add('Snare', 'krypt.sampler', FACTORY_KIT.snare);
  add('808', 'krypt.kick808', undefined, undefined, { mono: true, glideMs: 60 }).rootKey = 36;
  add('Keys', 'krypt.triosc');

  const pat = makePattern('Pattern 1', paletteColor(0));
  const tracks: Record<string, PlaylistTrack> = {};
  const trackOrder: string[] = [];
  for (let i = 1; i <= 16; i++) {
    const t = makeTrack(`Track ${i}`);
    tracks[t.id] = t;
    trackOrder.push(t.id);
  }

  const ts = { num: 4, den: 4 };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(ID_PREFIX.project),
    meta: { name, author: '', genre: '', notes: '', createdAt: new Date().toISOString() },
    transport: {
      bpm: 140,
      timeSig: ts,
      swing: 0,
      mode: 'pattern',
      activePatternId: pat.id,
      loop: { enabled: false, start: 0, end: ticksPerBar(ts) * 4 },
      metronome: false,
      masterVolume: 1,
    },
    channels,
    channelOrder,
    patterns: { [pat.id]: pat },
    patternOrder: [pat.id],
    playlist: { tracks, trackOrder, clips: {}, markers: {} },
    automations: {},
    mixer: { inserts, insertOrder, masterId: master.id },
    samples,
  };
}

export const FALLBACK_CLIP_LENGTH = PPQ * 4 * 4;

export function fallbackClipLength(ts: { num: number; den: number }): number {
  return ticksPerBar(ts) * 4;
}
