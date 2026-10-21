// ──────────────────────────────────────────────────────────────────────
// Sound matching, parameter nudges (research/15 §3.2): given the target
// (the reference part) and a candidate's fingerprint, the params that move
// the candidate toward the target, in the plugin's own units, clamped to
// its ParamSpec. Only params the candidate's plugin HAS (catalog) are
// proposed, plus two channel-level keys (CHANNEL_TWEAKS):
//
//   pitch   channel pitch in semitones (samples on the sampler, drums only)
//   gainDb  channel level change in dB (level match, ±6 dB)
//
// Pure + deterministic.
// ──────────────────────────────────────────────────────────────────────

import { clampToSpec, type ParamSpec, type PluginDescriptor } from '../plugins/types';
import { semitones } from './features';
import type { SoundFingerprint } from './types';

/** Tweak keys that are channel settings, not plugin params. */
export const CHANNEL_TWEAKS = ['pitch', 'gainDb'] as const;
export type ChannelTweak = (typeof CHANNEL_TWEAKS)[number];

export function isChannelTweak(key: string): key is ChannelTweak {
  return (CHANNEL_TWEAKS as readonly string[]).includes(key);
}

export interface TweakContext {
  /** The candidate's instrument (krypt.sampler for plain samples). Undefined = no plugin tweaks. */
  plugin: PluginDescriptor | undefined;
  /** The candidate's own params (the preset's), missing ones are the plugin defaults. */
  params: Record<string, number>;
  /** Drum part: pitch toward the reference's f0 (melodic parts take their pitch from the notes). */
  drum: boolean;
  /** Offset subtracted from the raw level difference (e.g. the median over all parts, so only balance matters). */
  levelOffsetDb?: number;
  /** Envelope-attack tweaks make sense (chords, pads, leads). */
  attack?: boolean;
  /**
   * Lowest cutoff a darkening tweak may set (Hz): a hat or snare filtered to a few hundred Hz is no longer that
   * drum, whatever a bleed-polluted measurement says. Default 200.
   */
  minCutoffHz?: number;
}

/** Raw level difference target − candidate (dB): peaks for drums (one-shots), RMS for tonal parts. */
export function levelDiffDb(target: SoundFingerprint, cand: SoundFingerprint, drum: boolean): number {
  return drum ? target.peakDb - cand.peakDb : target.rmsDb - cand.rmsDb;
}

/** Round to a sensible resolution for the spec's unit, then clamp (incl. step). */
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

/** Relative change big enough to be worth proposing. */
function moved(spec: ParamSpec, from: number, to: number): boolean {
  if (to === from) return false;
  const range = spec.max - spec.min;
  if (spec.scale === 'log' && from > 0 && to > 0) return Math.abs(Math.log2(to / from)) >= 0.1;
  return Math.abs(to - from) >= Math.max(range * 0.02, spec.step ?? 0);
}

/**
 * The tweaks that bring `cand` closer to `target`. Rules:
 *  - brightness: `cutoff` (synths) scaled by the centroid ratio^1.5 (max ×/÷4); samplers / multisampler `tone` only
 *    darken (a filter can't add top end), toward the target's rolloff; 808 `tone` (Hz) / drum synth `tone` (0..1).
 *  - length: `decay` (808, drum synth) scaled by the decay ratio; synth `ampDecay` (percussive targets) or
 *    `ampRelease` (sustained ones); FM operator decays; a sample is shortened with ampSustain 0 + ampDecay.
 *  - attack (ctx.attack: chords / pads / leads): `ampAttack` / `attack` toward the target's attack.
 *  - grit: `drive` (808, drum synth) toward the flatness; 808 `click` / drum synth `snap` toward the highMid band.
 *  - pitch (drums only): `tune` (808, drum synth, multisampler) or the channel `pitch` (sampler), octave errors folded.
 *  - level: `gainDb` from the peak (drums) or RMS (tonal) difference, minus levelOffsetDb, within ±6 dB.
 */
export function tweaksFor(target: SoundFingerprint, cand: SoundFingerprint, ctx: TweakContext): Record<string, number> {
  const out: Record<string, number> = {};
  const plugin = ctx.plugin;
  const spec = (id: string): ParamSpec | undefined => plugin?.params.find((p) => p.id === id);
  const cur = (s: ParamSpec): number => {
    const v = ctx.params[s.id];
    return typeof v === 'number' && Number.isFinite(v) ? clampToSpec(s, v) : s.default;
  };
  /** Propose param `id` = f(current); skipped when the plugin lacks it or the change is negligible. */
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

  // ── Brightness ──
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

  // ── Length ──
  const rD = (target.decayMs + 10) / (cand.decayMs + 10);
  if (Number.isFinite(rD) && Math.abs(Math.log2(rD)) >= 0.4) {
    const percussive = target.sustain < 0.35;
    if (is808 || isDrumSynth) set('decay', (now) => now * rD);
    else if (isSampler) {
      const sus = spec('ampSustain');
      const susNow = sus ? cur(sus) : 1;
      if (rD < 1 && susNow > 0.5) {
        // The envelope covers 60 dB in ampDecay, so the -20 dB point lands at about a third of it.
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

  // ── Attack ── (pads / chords / leads only: on basses and drums the peak time reads beating or the transient,
  // not the envelope). Slower: the candidate is clearly faster than the target; faster: its own attack param is
  // what makes it slow.
  if (ctx.attack) {
    const id = isMulti ? 'attack' : 'ampAttack';
    if (target.attackMs >= 30 && cand.attackMs < target.attackMs / 2) set(id, (now) => Math.max(now, now + (target.attackMs - cand.attackMs) * 0.8));
    else if (target.attackMs < cand.attackMs / 2) set(id, (now, s) => (now > Math.max(target.attackMs * 2, 10) ? Math.max(s.min, target.attackMs) : null));
  }

  // ── Grit / click ──
  if (is808 || isDrumSynth) {
    const dF = target.flatness - cand.flatness;
    if (Math.abs(dF) >= 0.05) set('drive', (now) => now + dF * 1.5);
    const dH = target.bands.highMid - cand.bands.highMid;
    if (Math.abs(dH) >= 4) set(is808 ? 'click' : 'snap', (now) => now + dH / 30);
  }

  // ── Pitch (drums) ──
  if (ctx.drum && target.f0Hz && cand.f0Hz) {
    let st = semitones(cand.f0Hz, target.f0Hz);
    // A pitch tracker's octave errors are common on drums: fold big moves to the nearest octave.
    while (st > 7) st -= 12;
    while (st < -7) st += 12;
    if (Math.abs(st) >= 0.5) {
      if (is808 || isDrumSynth || isMulti) set('tune', (now) => now + st);
      else if (isSampler) out.pitch = Math.round(st * 10) / 10;
    }
  }

  // ── Level ──
  const level = levelDiffDb(target, cand, ctx.drum) - (ctx.levelOffsetDb ?? 0);
  if (Number.isFinite(level) && Math.abs(level) >= 1.5) out.gainDb = Math.round(Math.max(-6, Math.min(6, level)) * 2) / 2;

  return out;
}
