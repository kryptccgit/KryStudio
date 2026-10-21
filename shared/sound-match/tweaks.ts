import { clampToSpec, type ParamSpec, type PluginDescriptor } from '../plugins/types';
import { semitones } from './features';
import type { SoundFingerprint } from './types';

export const CHANNEL_TWEAKS = ['pitch', 'gainDb'] as const;
export type ChannelTweak = (typeof CHANNEL_TWEAKS)[number];

export function isChannelTweak(key: string): key is ChannelTweak {
  return (CHANNEL_TWEAKS as readonly string[]).includes(key);
}

export interface TweakContext {
  plugin: PluginDescriptor | undefined;
  params: Record<string, number>;
  drum: boolean;
  levelOffsetDb?: number;
  attack?: boolean;
  minCutoffHz?: number;
}

export function levelDiffDb(target: SoundFingerprint, cand: SoundFingerprint, drum: boolean): number {
  return drum ? target.peakDb - cand.peakDb : target.rmsDb - cand.rmsDb;
}

function tidy(spec: ParamSpec, v: number): number {
  let x: number;
  switch (spec.unit) {
    case 'Hz':
      x = v >= 1000 ? Math.round(v / 10) * 10 : Math.round(v);
      break;
    case 'ms':
      x = v >= 20 ? Math.round(v) : Math.round(v * 10) / 10;
      break;
    case 'st':
    case 'dB':
      x = Math.round(v * 10) / 10;
      break;
    default:
      x = Math.round(v * 100) / 100;
  }
  return clampToSpec(spec, x);
}

function moved(spec: ParamSpec, from: number, to: number): boolean {
  if (to === from) return false;
  const range = spec.max - spec.min;
  if (spec.scale === 'log' && from > 0 && to > 0) return Math.abs(Math.log2(to / from)) >= 0.1;
  return Math.abs(to - from) >= Math.max(range * 0.02, spec.step ?? 0);
}

export function tweaksFor(target: SoundFingerprint, cand: SoundFingerprint, ctx: TweakContext): Record<string, number> {
  const out: Record<string, number> = {};
  const plugin = ctx.plugin;
  const spec = (id: string): ParamSpec | undefined => plugin?.params.find((p) => p.id === id);
  const cur = (s: ParamSpec): number => {
    const v = ctx.params[s.id];
    return typeof v === 'number' && Number.isFinite(v) ? clampToSpec(s, v) : s.default;
  };
  const set = (id: string, f: (now: number, s: ParamSpec) => number | null): void => {
    const s = spec(id);
    if (!s || s.options) return;
    const now = cur(s);
    const want = f(now, s);
    if (want === null || !Number.isFinite(want)) return;
    const v = tidy(s, want);
    if (moved(s, now, v)) out[id] = v;
  };
  const pid = plugin?.id ?? '';
  const isSampler = pid === 'krypt.sampler';
  const isMulti = pid === 'krypt.multisampler';
  const is808 = pid === 'krypt.kick808';
  const isDrumSynth = pid === 'krypt.drumsynth';
  const isSynth = !isSampler && !isMulti && !is808 && !isDrumSynth;

  let ratio = target.centroidHz / cand.centroidHz;
  if (!ctx.drum && target.f0Hz && cand.f0Hz) ratio = Math.sqrt(ratio * (target.centroidHz / target.f0Hz / (cand.centroidHz / cand.f0Hz)));
  if (Number.isFinite(ratio) && Math.abs(Math.log2(ratio)) >= 0.25) {
    const k = Math.min(4, Math.max(0.25, ratio ** 1.5));
    if (isSynth) set('cutoff', (now, s) => (ratio > 1 && now >= s.max * 0.9 ? null : now * k));
    else if (is808) set('tone', (now) => now * k);
    else if (isDrumSynth) set('tone', (now) => now + 0.35 * Math.log2(ratio));
    else if (target.rolloffHz < cand.rolloffHz * 0.8) {
      const darker = (now: number) => Math.min(now, Math.max(target.rolloffHz * 1.25, ctx.minCutoffHz ?? 200));
      if (isSampler) set('cutoff', darker);
      if (isMulti) set('tone', darker);
    }
  }

  const rD = (target.decayMs + 10) / (cand.decayMs + 10);
  if (Number.isFinite(rD) && Math.abs(Math.log2(rD)) >= 0.4) {
    const percussive = target.sustain < 0.35;
    if (is808 || isDrumSynth) set('decay', (now) => now * rD);
    else if (isSampler) {
      const sus = spec('ampSustain');
      const susNow = sus ? cur(sus) : 1;
      if (rD < 1 && susNow > 0.5) {
        set('ampSustain', () => 0);
        set('ampDecay', () => Math.max(target.decayMs * 3, 20));
      } else if (susNow <= 0.5) set('ampDecay', (now) => now * rD);
    } else if (isMulti) {
      if (!percussive) set('release', (now) => now * rD);
    } else if (pid === 'krypt.fm') {
      if (percussive) for (let op = 1; op <= 4; op++) set(`op${op}Decay`, (now) => now * rD);
      else for (let op = 1; op <= 4; op++) set(`op${op}Release`, (now) => now * rD);
    } else if (percussive) set('ampDecay', (now) => now * rD);
    else set('ampRelease', (now) => now * rD);
  }

  if (ctx.attack) {
    const id = isMulti ? 'attack' : 'ampAttack';
    if (target.attackMs >= 30 && cand.attackMs < target.attackMs / 2) set(id, (now) => Math.max(now, now + (target.attackMs - cand.attackMs) * 0.8));
    else if (target.attackMs < cand.attackMs / 2) set(id, (now, s) => (now > Math.max(target.attackMs * 2, 10) ? Math.max(s.min, target.attackMs) : null));
  }

  if (is808 || isDrumSynth) {
    const dF = target.flatness - cand.flatness;
    if (Math.abs(dF) >= 0.05) set('drive', (now) => now + dF * 1.5);
    const dH = target.bands.highMid - cand.bands.highMid;
    if (Math.abs(dH) >= 4) set(is808 ? 'click' : 'snap', (now) => now + dH / 30);
  }

  if (ctx.drum && target.f0Hz && cand.f0Hz) {
    let st = semitones(cand.f0Hz, target.f0Hz);
    while (st > 7) st -= 12;
    while (st < -7) st += 12;
    if (Math.abs(st) >= 0.5) {
      if (is808 || isDrumSynth || isMulti) set('tune', (now) => now + st);
      else if (isSampler) out.pitch = Math.round(st * 10) / 10;
    }
  }

  const level = levelDiffDb(target, cand, ctx.drum) - (ctx.levelOffsetDb ?? 0);
  if (Number.isFinite(level) && Math.abs(level) >= 1.5) out.gainDb = Math.round(Math.max(-6, Math.min(6, level)) * 2) / 2;

  return out;
}
