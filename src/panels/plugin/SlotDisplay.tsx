import type { ReactNode } from 'react';
import { hasGrMeter } from '@shared/engine/meters';
import { AnalyzerDisplay } from './AnalyzerDisplay';
import { EqCurve } from './EqCurve';
import { GrMeter } from './GrMeter';
import { GateSteps } from './GateSteps';

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5">
      <h3 className="mb-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h3>
      {children}
    </section>
  );
}

export function SlotDisplay({ insertId, slotId, pluginType }: { insertId: string; slotId: string; pluginType: string }) {
  if (pluginType === 'krypt.eq')
    return (
      <Box title="Response">
        <EqCurve insertId={insertId} slotId={slotId} />
      </Box>
    );
  if (pluginType === 'krypt.analyzer')
    return (
      <Box title="Analyzer">
        <AnalyzerDisplay insertId={insertId} slotId={slotId} />
      </Box>
    );
  if (pluginType === 'krypt.gate')
    return (
      <>
        <Box title="Custom steps">
          <GateSteps insertId={insertId} slotId={slotId} />
        </Box>
        <Box title="Meter">
          <GrMeter insertId={insertId} slotId={slotId} pluginType={pluginType} />
        </Box>
      </>
    );
  if (hasGrMeter(pluginType))
    return (
      <Box title="Meter">
        <GrMeter insertId={insertId} slotId={slotId} pluginType={pluginType} />
      </Box>
    );
  return null;
}
