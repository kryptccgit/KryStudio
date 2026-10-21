// list_packs (read, owned by packs-app): the optional sound packs, their status and the presets they add.
// Agents never download: they tell the user which pack to get in Home ▸ Sounds. research/12-real-instruments.md.

import { z } from 'zod';
import type { MainDeps } from '../types';
import { PACKS } from '@shared/packs/catalog';
import type { PackEntryState, PackStatus } from '@shared/packs/types';
import type { InstrumentPreset, SampleKind } from '@shared/sounds/types';
import type { PackSamplesInfo } from '@shared/types';
import { defineTool, type ToolResult } from './types';
import { plural, safeName } from './util';
import { instrumentPresets, soundLibrary } from './instruments';
import { presetPackId } from '../../packs/gating';
import { fmtSize } from '../../packs/service';

const STATUS_TEXT: Record<PackStatus, string> = {
  installed: 'installed',
  update: 'installed (an update is available)',
  available: 'not downloaded',
  downloading: 'downloading now',
  failed: 'not downloaded (the last download failed)',
};

/** Sample counts by kind from the shared catalog (when the packs service isn't wired). */
function catalogSampleInfo(): PackSamplesInfo {
  const packs = PACKS.filter((p) => p.samples?.length).map((p) => {
    const byKind: Partial<Record<SampleKind, number>> = {};
    for (const x of p.samples!) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
    return { id: p.id, name: p.name, installed: false, count: p.samples!.length, byKind };
  });
  return { packs, samples: [] };
}

/** "140 sounds (foley 60, ambience 40, impact 20 …)": biggest kinds first. */
export function sampleCountText(count: number, byKind: Partial<Record<string, number>>): string {
  const kinds = Object.entries(byKind)
    .filter((e): e is [string, number] => (e[1] ?? 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `${plural(count, 'sound')}${kinds.length ? ` (${kinds.slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ')}${kinds.length > 6 ? ' …' : ''})` : ''}`;
}

/** The catalog as "not downloaded" when the packs service isn't wired (tests, a failed start). */
function catalogEntries(): PackEntryState[] {
  return PACKS.map((p) => ({ id: p.id, name: p.name, description: p.description, author: p.author, licence: p.licence, bytes: p.bytes, ramMb: p.ramMb, contents: p.contents, status: 'available' }));
}

export const listPacks = defineTool({
  name: 'list_packs',
  title: 'List sound packs',
  kind: 'read',
  description:
    'The optional sound packs: real recorded instruments (such as a grand piano, acoustic drums, orchestral and mallet instruments) and recorded sound effects (foley, ambience, impacts, whooshes, retro game sounds …) from CC0 / public-domain libraries, with their status (installed / not downloaded / downloading / update available), download size, RAM, licence, the presets each adds and its sample counts by kind. An installed pack\'s samples are found by find_samples, loaded with load_sample ("pack:<pack>/…") and used by add_transition and get_playbook like factory samples. Only the USER downloads packs (Home ▸ Sounds ▸ Sound packs); you can\'t. Presets that need a missing pack are skipped by the automatic sound picks (write_pattern, add_channel, get_playbook) and load_preset refuses them. When a real instrument would clearly help (an exposed piano in R&B / lo-fi / pop, live drums, strings in a cinematic piece), tell the user which pack to download. Example: {}',
  input: z.object({}),
  run(deps: MainDeps): ToolResult {
    const warnings: string[] = [];
    let packs: PackEntryState[];
    let dir: string | null = null;
    if (deps.packs) {
      const s = deps.packs.state();
      packs = s.packs;
      dir = s.dir;
    } else {
      packs = catalogEntries();
      warnings.push("Krypt Studio's sound-pack service isn't running in this session, so every pack is listed as not downloaded.");
    }
    if (!packs.length) return { ok: true, message: 'This version of Krypt Studio offers no sound packs.', changed: [], warnings, data: { packs: [] } };

    // The presets each pack adds (factory + the user's own presets saved from pack instruments).
    const byPack = new Map<string, InstrumentPreset[]>();
    for (const p of instrumentPresets(soundLibrary(deps).presets)) {
      const id = presetPackId(p);
      if (!id) continue;
      const list = byPack.get(id) ?? [];
      list.push(p);
      byPack.set(id, list);
    }

    // The samples each pack adds (sample packs), by kind.
    let sampleInfo: PackSamplesInfo;
    try {
      sampleInfo = deps.packs?.sampleInfo?.() ?? catalogSampleInfo();
    } catch (err) {
      sampleInfo = catalogSampleInfo();
      warnings.push(`Couldn't read the packs' sample lists (${safeName((err as Error)?.message ?? String(err), 120)}); counts come from the catalog.`);
    }
    const samplesOf = new Map(sampleInfo.packs.map((p) => [p.id, p]));

    const lines: string[] = [];
    const data = packs.map((e) => {
      const presets = byPack.get(e.id) ?? [];
      const smp = samplesOf.get(e.id);
      const sampleText = smp?.count ? ` · ${sampleCountText(smp.count, smp.byKind)}${e.status === 'installed' || e.status === 'update' ? ' in find_samples' : ''}` : '';
      const ready = e.status === 'installed' || e.status === 'update';
      const progress = e.status === 'downloading' && e.progress && e.progress.total > 0 ? ` ${Math.round((e.progress.bytes / e.progress.total) * 100)}%` : '';
      const presetText = presets.length ? `; presets: ${presets.slice(0, 8).map((p) => `${safeName(p.name, 40)} (${p.role}, ${p.id})`).join(', ')}${presets.length > 8 ? `, +${presets.length - 8} more` : ''}` : '';
      lines.push(
        `${e.id}  ${safeName(e.name, 60)}: ${STATUS_TEXT[e.status]}${progress} · ${fmtSize(e.bytes)} download${e.ramMb > 0 ? ` · ~${Math.round(e.ramMb)} MB RAM per instrument` : ''} · ${safeName(e.licence.name, 60)} · adds ${e.contents.map((c) => safeName(c, 60)).join(', ')}${sampleText}${presetText}${e.error ? ` · last error: ${safeName(e.error, 200)}` : ''}`,
      );
      return {
        id: e.id,
        name: safeName(e.name, 60),
        status: e.status,
        installed: ready,
        description: safeName(e.description, 300),
        bytes: e.bytes,
        downloadMb: Math.round(e.bytes / (1024 * 1024)),
        ramMb: e.ramMb > 0 ? e.ramMb : 0,
        contents: e.contents.map((c) => safeName(c, 80)),
        licence: { spdx: e.licence.spdx, name: safeName(e.licence.name, 80), url: e.licence.url, attribution: safeName(e.licence.attribution, 200) },
        author: safeName(e.author, 80),
        presets: presets.map((p) => ({ id: p.id, name: safeName(p.name, 64), role: p.role })),
        samples: { count: smp?.count ?? 0, byKind: { ...(smp?.byKind ?? {}) } },
        ...(e.progress ? { progress: { bytes: e.progress.bytes, total: e.progress.total } } : {}),
        ...(e.error ? { error: safeName(e.error, 300) } : {}),
      };
    });
    const installed = data.filter((d) => d.installed).length;
    const missing = data.filter((d) => !d.installed && d.status !== 'downloading');
    const how = missing.length
      ? ` To add one, the user opens Home ▸ Sounds ▸ Sound packs and clicks Download (${missing.map((m) => m.name).join(', ')}); you can't download packs. Its presets then work with load_preset and the automatic picks, and its samples with find_samples / load_sample / add_transition.`
      : ' Every pack is installed: their presets work with load_preset and the automatic picks, their samples with find_samples / load_sample / add_transition.';
    return {
      ok: true,
      message: `${plural(data.length, 'sound pack')}, ${installed} installed.${how}`,
      changed: [],
      warnings,
      text: lines.join('\n'),
      data: { packs: data, ...(dir ? { dir } : {}) },
    };
  },
});

export const PACK_TOOLS = [listPacks];
