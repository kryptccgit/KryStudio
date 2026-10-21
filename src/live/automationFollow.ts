import { useEffect, useState } from 'react';
import { getProject, useDocStore } from '../doc/store';
import { onFrame } from '../render/frameLoop';
import { telemetry } from './telemetry';
import { playState } from './playState';
import { automationValueAt, isAutomated } from './automationEval';

export { automationValueAt, isAutomated };

export function liveParamNorm(ref: string): number | null {
  const f = telemetry.frame;
  const fromEngine = f?.params?.[ref];
  if (typeof fromEngine === 'number' && Number.isFinite(fromEngine)) return fromEngine;
  const p = getProject();
  if (!p) return null;
  const songPlaying = f ? telemetry.playing && f.mode === 'song' : playState.playing() && p.transport.mode === 'song';
  if (!songPlaying) return null;
  return automationValueAt(p, ref, playState.tick());
}

export function useLiveParam(ref: string): { automated: boolean; norm: number | null } {
  const automated = useDocStore((s) => (s.project ? isAutomated(s.project, ref) : false));
  const [norm, setNorm] = useState<number | null>(null);
  useEffect(() => {
    if (!automated) return;
    let last: number | null = null;
    const off = onFrame(() => {
      const v = liveParamNorm(ref);
      const q = v === null ? null : Math.round(v * 500) / 500;
      if (q !== last) {
        last = q;
        setNorm(q);
      }
    });
    return () => {
      off();
      setNorm(null);
    };
  }, [ref, automated]);
  return { automated, norm };
}
