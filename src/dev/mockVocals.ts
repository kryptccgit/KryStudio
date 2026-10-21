import { USER, type DocHost } from '@shared/doc/DocHost';
import type { ActionResult, AudioTarget, KryptApi, MatchOutcome, TuneOutcome } from '@shared/types';

type AnalyzerApiLike = Pick<KryptApi['analyzer'], 'analyze'>;
import { keyShift, keyShortName, toKeyRef, transposeKey, tuneKeyFor, type KeyRef } from '@shared/music/keymatch';
import { matchBpm } from '@shared/analyzer/tempo';
import { channelPitch, keySources, patternKey, planTune, songOf } from '@shared/vocals/plan';

const fail = <T>(message: string): ActionResult<T> => ({ ok: false, message });

export function createMockVocals(host: DocHost, analyzer: AnalyzerApiLike): KryptApi['vocals'] {
  function applyAll(label: string, steps: Array<{ cmd: string; args: unknown }>): ActionResult<unknown[]> {
    const r = host.execBatch(steps, { actor: USER, label });
    return r.ok ? { ok: true, data: (r.data as unknown[]) ?? [] } : fail(r.message ?? 'Edit failed');
  }

  async function keyOf(target: AudioTarget): Promise<{ key: KeyRef; confidence: number } | null> {
    const r = await analyzer.analyze(target);
    const key = r.ok && r.data?.key ? toKeyRef(r.data.key) : null;
    return key ? { key, confidence: r.data!.key!.confidence } : null;
  }

  return {
    async tune(target, opts) {
      const p = host.project;
      const chId = 'clipId' in target ? p.playlist.clips[target.clipId]?.channelId : 'channelId' in target ? target.channelId : undefined;
      const ch = chId ? p.channels[chId] : undefined;
      if (!ch) return fail('Pick an audio clip or a channel to tune');
      let key: KeyRef | null = null;
      let source: TuneOutcome['keySource'] = 'vocal';
      let confidence: number | null = null;
      if (opts.key) source = 'given';
      else {
        const own = await keyOf(target);
        if (own && own.confidence >= 0.45) {
          key = transposeKey(own.key, channelPitch(host.catalog, ch));
          confidence = own.confidence;
        } else {
          const other = keySources(p, host.catalog, new Set([ch.id]))[0];
          const k = other ? await keyOf({ channelId: other.analyseChannelId }) : null;
          const pk = patternKey(p);
          if (k) {
            key = transposeKey(k.key, other!.pitch);
            confidence = k.confidence;
            source = 'instrumental';
          } else if (pk) {
            key = pk.key;
            confidence = pk.confidence;
            source = 'patterns';
          } else if (own) key = own.key;
        }
        if (!key) return fail(`Couldn't tell which key to tune "${ch.name}" to. Pass a key.`);
      }
      let plan;
      let tk;
      try {
        tk = tuneKeyFor(opts.key ?? key!, opts.scale);
        plan = planTune(p, ch.insertId, tk, opts.style);
      } catch (err) {
        return fail((err as Error).message);
      }
      const before = host.version;
      const r = applyAll(`Tune "${ch.name}" (${opts.style})`, plan.steps);
      if (!r.ok) return fail(r.message ?? 'Tuning failed');
      const slotId = plan.slotId ?? (r.data?.[0] as { id?: string } | undefined)?.id ?? '';
      const data: TuneOutcome = { insertId: ch.insertId, slotId, created: !plan.slotId, key: tk.label, root: tk.root, scale: tk.scale, style: opts.style, keySource: source, confidence: confidence === null ? null : Math.round(confidence * 100) / 100, changed: host.version !== before };
      return { ok: true, message: `Tuned "${ch.name}" (mock): ${tk.label}.`, data };
    },

    async match(clipId, opts) {
      const p = host.project;
      const clip = p.playlist.clips[clipId];
      const ch = clip?.channelId ? p.channels[clip.channelId] : undefined;
      if (!clip || !ch || ch.generator.type !== 'krypt.audioclip') return fail('Pick an audio clip to match');
      const to = opts?.to ?? 'project';
      const src = await analyzer.analyze({ clipId });
      if (!src.ok || !src.data) return fail(src.message ?? 'Analysis failed');
      const from = toKeyRef(src.data.key);
      let target: KeyRef | null = null;
      if (to !== 'project') {
        const tc = p.playlist.clips[to.clipId];
        const tch = tc?.channelId ? p.channels[tc.channelId] : undefined;
        const k = tch ? await keyOf({ clipId: to.clipId }) : null;
        target = k && tch ? transposeKey(k.key, channelPitch(host.catalog, tch)) : null;
      } else {
        const pk = patternKey(p);
        const other = keySources(p, host.catalog, new Set([ch.id]), new Set([songOf(p, ch) ?? '']))[0];
        const k = other ? await keyOf({ channelId: other.analyseChannelId }) : null;
        target = pk && pk.confidence >= 0.5 ? pk.key : k ? transposeKey(k.key, other!.pitch) : pk?.key ?? null;
      }
      const params: Record<string, number> = {};
      let semis: number | null = null;
      if (opts?.key !== false && from && target) {
        semis = keyShift(from, target).semitones;
        params.pitch = semis;
        if (semis) params.formant = 1;
      }
      const read = opts?.tempo !== false && src.data.tempo ? matchBpm(src.data.tempo, p.transport.bpm) : null;
      if (read) Object.assign(params, { tempo_sync: 1, src_bpm: read.bpm });
      if (!Object.keys(params).length) return fail(`Couldn't read a key or a tempo to match "${ch.name}" with`);
      const before = host.version;
      const r = applyAll(`Match "${ch.name}"`, [{ cmd: 'channels.setGenParams', args: { id: ch.id, params } }]);
      if (!r.ok) return fail(r.message ?? 'Match failed');
      const data: MatchOutcome = {
        channelId: ch.id,
        semitones: semis,
        fromKey: from ? keyShortName(from) : null,
        toKey: target ? keyShortName(target) : null,
        resultKey: from && semis !== null ? keyShortName(transposeKey(from, semis)) : null,
        sourceBpm: read?.bpm ?? null,
        reading: read?.reading ?? null,
        followsBpm: read ? p.transport.bpm : null,
        ratio: read ? Math.round(read.ratio * 100) / 100 : null,
        projectBpm: host.project.transport.bpm,
        projectTempoChanged: false,
        changed: host.version !== before,
      };
      return { ok: true, message: `Matched "${ch.name}" (mock).`, data };
    },
  };
}
