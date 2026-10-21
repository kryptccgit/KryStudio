import type { MainDeps } from '../types';
import type { Channel } from '@shared/schema/project';
import type { FingerprintEntry, FingerprintSource } from '@shared/sound-match/types';
import { aggregateFingerprints, compareFingerprints, isDrumTarget, PROFILES, profileFor, rankMatches } from '@shared/sound-match/match';
import type { SampleKind } from '@shared/sounds/types';
import type { RunCtx } from './types';
import type { StudiedReference } from './reference';
import { channelRole, matchTargetFor, partSource, referencePartFingerprints, type MatchableRole, type PartSource } from './match';
import { fingerprintServiceFor, presetLookup } from '../../sounds/fingerprints';
import { safeName } from './util';

const SAMPLE_KIND: Partial<Record<MatchableRole, SampleKind>> = { kick: 'kick', snare: 'snare', clap: 'clap', hat: 'hat', openhat: 'openhat', ride: 'ride', perc: 'perc', tom: 'tom', '808': '808', bass: 'bass-oneshot', stab: 'stab-oneshot' };
const keyOf = (s: PartSource) => (s.kind === 'drums' ? `drums:${s.drumRole}` : s.kind);

function currentSound(deps: MainDeps, ch: Channel, role: MatchableRole, entries: readonly FingerprintEntry[], svc: ReturnType<typeof fingerprintServiceFor>): FingerprintEntry | null {
  const pid = ch.generator.preset?.id;
  if (pid) {
    const e = entries.find((x) => x.source.kind === 'preset' && x.source.id === pid);
    if (e) return e;
  }
  const s = ch.generator.sampleId ? deps.doc.project.samples[ch.generator.sampleId] : undefined;
  if (s) {
    const e = entries.find((x) => x.source.kind === 'sample' && x.source.path === s.path);
    if (e) return e;
    const source: FingerprintSource = { kind: 'sample', path: s.path, sampleKind: SAMPLE_KIND[role] ?? 'perc' };
    const fp = svc.fingerprintOf(source);
    if (fp) return { source, fp };
  }
  return null;
}

export async function soundCloseness(
  deps: MainDeps,
  ref: StudiedReference,
  heardChannels: ReadonlySet<string>,
  ctx: Pick<RunCtx, 'progress' | 'signal'>,
): Promise<{ sounds: Array<{ part: string; similarity: number; fix?: string }> | null; note?: string }> {
  if (!deps.analyzer?.fingerprint) return { sounds: null, note: "this analyzer build can't measure sounds (sound matching needs the Wave 8a analyzer)" };
  const svc = fingerprintServiceFor(deps);
  const idx = svc.index();
  if (!idx.index) return { sounds: null, note: idx.problem ?? 'the sound fingerprint index is missing' };
  const lookup = presetLookup(deps);
  const p = deps.doc.project;
  const plans: Array<{ ch: Channel; role: MatchableRole; src: PartSource }> = [];
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    if (!ch || id === ref.track.channel.id || ch.generator.type === 'krypt.audioclip' || !heardChannels.has(id)) continue;
    const role = channelRole(ch, lookup);
    const src = role ? partSource(role) : null;
    if (role && src) plans.push({ ch, role, src });
  }
  if (!plans.length) return { sounds: null, note: 'no parts with a recognisable role (Kick, Snare, Hat, Bass, Chords, Lead …) play yet' };
  let parts: Awaited<ReturnType<typeof referencePartFingerprints>>['parts'];
  try {
    const seen = new Set<string>();
    const sources = plans.map((x) => x.src).filter((s) => !seen.has(keyOf(s)) && !!seen.add(keyOf(s)));
    parts = (await referencePartFingerprints(deps, ref.track, sources, ctx, 'cached')).parts;
  } catch (e) {
    return { sounds: null, note: `the reference's parts couldn't be measured (${(e as Error)?.message ?? e})` };
  }
  const out: Array<{ part: string; similarity: number; fix?: string }> = [];
  const unknown: string[] = [];
  for (const { ch, role, src } of plans) {
    const meas = parts.get(keyOf(src));
    if (!meas?.fps.length) continue;
    const mine = currentSound(deps, ch, role, idx.index.entries, svc);
    if (!mine) {
      unknown.push(ch.name);
      continue;
    }
    const target = matchTargetFor(role);
    const ranked = rankMatches(meas.fps, [mine], target, { preset: lookup, limit: 1 })[0];
    let similarity = ranked?.similarity;
    if (similarity === undefined) {
      const agg = aggregateFingerprints(meas.fps);
      const drum = isDrumTarget(target);
      similarity = agg ? compareFingerprints(agg, mine.fp, PROFILES[profileFor(target)], { drum, relCentroid: !drum }).similarity * 0.8 : 0;
    }
    out.push({ part: safeName(ch.name, 40), similarity: Math.round(similarity * 100) / 100, fix: `match_sounds ${JSON.stringify({ parts: [role], apply: true })} (${safeName(ch.name, 40)} ${Math.round(similarity * 100)}% like the reference's ${role})` });
  }
  if (!out.length) return { sounds: null, note: unknown.length ? `the current sounds of ${unknown.slice(0, 4).join(', ')} aren't in the fingerprint index (bare synths or user samples)` : "the reference's parts couldn't be measured from its stems" };
  return { sounds: out, ...(unknown.length ? { note: `not compared: ${unknown.slice(0, 4).join(', ')} (no fingerprint for their current sound)` } : {}) };
}
