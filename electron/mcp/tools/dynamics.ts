// Measured gain reduction for agents (docs/ENGINE_PROTOCOL.md §15): the
// engine averages every dynamics slot's GR over an offline render
// (RenderResult.gainReduction); render_preview prints it so an agent can
// tell a compressor that never engages from one that squashes the mix.

import type { Project } from '@shared/schema/project';
import type { SlotGainReduction } from '@shared/engine/protocol';
import type { PluginCatalog } from '@shared/plugins/types';
import { hasGrMeter } from '@shared/engine/meters';
import { pluginName, round, safeName } from './util';

export interface DynamicsSlot {
  insert: string;
  effect: string;
  slot: number;
  /** Mean GR over the render, dB. */
  avgDb: number;
  maxDb: number;
  /** % of the render spent reducing by more than 1 dB. */
  activePct: number;
}

/**
 * Every enabled dynamics slot in the project with its measured GR (0 when it never reduced), in mixer order.
 * `gr` absent (an older engine) → null: nothing to report.
 */
export function dynamicsReport(p: Project, catalog: PluginCatalog, gr: SlotGainReduction[] | undefined): DynamicsSlot[] | null {
  if (!gr) return null;
  const out: DynamicsSlot[] = [];
  for (const iid of p.mixer.insertOrder) {
    const ins = p.mixer.inserts[iid];
    if (!ins) continue;
    ins.slotOrder.forEach((sid, i) => {
      const slot = ins.slots[sid];
      if (!slot || !slot.enabled || !hasGrMeter(slot.type)) return;
      const m = gr.find((g) => g.insertId === iid && g.slotId === sid);
      out.push({
        insert: ins.isMaster ? 'Master' : ins.name,
        effect: pluginName(catalog, slot.type),
        slot: i + 1,
        avgDb: round(m?.avgDb ?? 0, 1),
        maxDb: round(m?.maxDb ?? 0, 1),
        activePct: Math.round((m?.active ?? 0) * 100),
      });
    });
  }
  return out;
}

/** One text line for render_preview ('' when there are no dynamics slots). */
export function dynamicsLine(rows: DynamicsSlot[] | null): string {
  if (!rows?.length) return '';
  const parts = rows.map((r) =>
    r.maxDb < 0.1
      ? `${safeName(r.insert, 24)} ▸ ${r.effect} (slot ${r.slot}) never reduced`
      : `${safeName(r.insert, 24)} ▸ ${r.effect} (slot ${r.slot}) GR avg ${r.avgDb} / max ${r.maxDb} dB, >1 dB ${r.activePct}% of the time`,
  );
  return `dynamics  ${parts.join(' · ')}`;
}
